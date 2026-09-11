# Phase 3 · Slice 1 — A failure you can see

> Four small changes, no new mechanism: a migration that widens one CHECK, one member added to `OrderStatus`, one row added to the transition table, and the Russian words a shopper reads. The service layer did not change; neither did the SQL it emits.
>
> The interest is in two places. **One classification decision** — `delivery_failed` is *recoverable*, not *terminal* — which was **proven against code that did not exist yet** rather than argued. And **four tripwires that fired on their own**, one of which nobody had planned, and one of which caught something no type can catch.

---

## 1. What actually shipped

| # | Change | Size |
|---|---|---|
| 1 | `0001_delivery_failed_status` — `orders_status_check` learns a seventh value | Two DDL statements |
| 2 | `OrderStatus.DeliveryFailed` in `packages/contracts`, classified into `recoverableOrderStatuses` | One member, one list entry |
| 3 | `markDeliveryFailed` (`delivering → delivery_failed`) in `order-transitions.ts` | **One data row** |
| 4 | The Russian label, plus `order-recovery-explanation.ts` rendered as a notice | Two strings, one small module |

Change 3 is the one to notice for what it *is not*. The transition table is data, and Phase 1's walkthrough predicted that the next lifecycle arc would be one row in it. This is that prediction being cashed: `order-transition.service.ts` did not change, the statement it emits did not change, and no new service method exists. Adding a lifecycle state cost one line of table.

The migration is worth a paragraph and no more. Postgres has no *widen a CHECK* verb, so the widening is a `DROP CONSTRAINT` and an `ADD CONSTRAINT` in the one transaction Drizzle's migrator wraps every pending file in. The ADD scans every row to validate, and this is the safe direction of that scan — the new list is a strict superset of the old one, so no existing row can fail it. Measured on a 20 000-order fixture inside a rolled-back transaction:

```
drop  orders_status_check ..... 1.853 ms
add   orders_status_check ..... 4.525 ms
lock taken ................... ACCESS EXCLUSIVE
table rewrite ................ NONE (one validating scan)
```

The *no rewrite* claim is checkable rather than asserted, and it is the reason the numbers are milliseconds: `pg_class.relfilenode` for `orders` read `16419` before the migration and `16419` after. A rewrite would have given the table a new file. It still reads `16419` in the running database today.

Two alternatives were considered and rejected in writing, in the migration file itself:

- **A Postgres `enum` instead of `text` + CHECK.** `ALTER TYPE … ADD VALUE` cannot use the label it just added inside the transaction that added it, so an enum would forbid widening the lifecycle and writing the new value in one migration — and would forbid a backfill under the widening. This is the migration that decision was made *for*, back in `0000_init`.
- **The `NOT VALID` / `VALIDATE CONSTRAINT` two-step.** Measured too — 1.5 ms plus 3.0 ms. It exists to keep a long validating scan off the write path. 4.5 ms on the largest table this shop will ever have does not buy two statements and a window in which the constraint exists but is unenforced.

(The migration file's own header records **3.6 ms** for the same widening from an earlier run. Same measurement, different execution; the conclusion — a validating scan on 20 000 rows is single-digit milliseconds, so neither the enum nor the two-step is worth its complexity — does not move either way.)

---

## 2. Keystone one — recoverable, not terminal, proven rather than argued

### Terminal is a set with teeth

It is easy to read `terminalOrderStatuses` as documentation. It is not. It is the set that invariant I9's guarded UPDATE draws its **permitted source states** from:

```sql
UPDATE orders SET status = $2, updated_at = now()
WHERE id = $1 AND status = ANY($3)   -- permitted source states only
RETURNING *;
-- 0 rows => the order was not in a state this transition may leave from.
```

A status that is terminal appears in no transition's `from` list, and `_NoTransitionLeavesATerminalState` fails the build if anyone puts one there. So **an order that is terminal cannot legally be left, by any path, automatic or manual.**

That makes the classification a load-bearing decision rather than a naming preference. Slice 5's operator retry is this row of spec 003's transition table:

| Transition | to | from |
|---|---|---|
| `retryIssuance` | `delivering` | `[out_of_stock, delivery_failed]` |

If `delivery_failed` were terminal, that row would not compile. Not *would be discouraged* — would not compile, because the terminality proof forbids it. And spec 003 §2.5 — *"An operator can push a stuck order through, and pressing twice changes nothing"* — could not be built at all. The whole subject of Phase 3 would be illegal by construction.

### The proof was run before the code that depends on it existed

That claim was not left as an assertion, and this is the part worth telling in an interview.

The implementing agent built a throwaway file replicating slice 5's *future* `retryIssuance` rule — `delivering` from `[out_of_stock, delivery_failed]` — added it to a copy of the transition table, and typechecked it under both classifications of `delivery_failed`:

- **Classified recoverable:** exit 0. `Extract<PermittedSourceStatus, TerminalOrderStatus>` stays `never`; the retry is a legal arc.
- **Classified terminal:** the build stops.

```
error TS2344: Type '"delivery_failed"' does not satisfy the constraint 'never'.
```

That is "illegal by construction" made literal, run against a rule that had not been written yet. The throwaway file was deleted; nothing of it is in the diff. What it bought is that the classification in slice 1 is known to be the one slice 5 needs, four slices before slice 5 can say so.

### The distinction to hold, in the contracts file's own terms

The wording matters because *"settled"* and *"terminal"* sound like synonyms and are not:

> **Terminal means no transition is ever legal. Recoverable means nothing moves it by itself — a person does.**

To a passive observer they are indistinguishable: an order sitting in `out_of_stock` and an order sitting in `payment_failed` both just sit there, and the status page stops polling both. The difference is entirely about what the guarded UPDATE will accept. Which is why the contracts package keeps three sets rather than two:

| Set | Answers | Used by |
|---|---|---|
| `terminalOrderStatuses` | *May any transition run at all?* (I9) | the transition table's proof, the guard lists |
| `recoverableOrderStatuses` | *Is a person expected to act?* | the recovery notice, slice 4's admin list |
| `settledOrderStatuses` | *Will this move on its own?* | the page's stop-polling condition |

`settledOrderStatuses` is derived — `[...terminal, ...recoverable]` — which is why the poll needed no edit at all. Adding one member to `recoverableOrderStatuses` was the entire change; the stop condition picked it up for free. Had the page restated the strings, this slice would have shipped a page that polls a dead order forever.

`out_of_stock` already meant exactly this, and had since Phase 1. `delivery_failed` is the same kind of thing however final it sounds.

### The quieter fact a reviewer will press on

**`orders.status = 'delivery_failed'` is a statement about the shop, not about the supplier.** It means *"we did not hand over a key."*

The statement about the supplier lives in a different table. An attempt that timed out stays `issuance_attempts.status = 'unknown'` with `last_error` NULL, because that is still the only truthful thing to say about it — the shop asked, and never learned the answer. Writing `failed` into that row is the exact bug Phase 3 exists to prevent: a timeout treated as a definite failure is what sends a second supplier a second question and puts two keys into one order.

So the two facts coexist without contradiction, and they have to:

| Fact | Where it lives | For a timed-out attempt |
|---|---|---|
| The shopper has no key | `orders.status` | `delivery_failed` |
| We never learned what the supplier did | `issuance_attempts.status` | `unknown`, `last_error` NULL |

Two different facts, two tables. The order being written off does not resolve the attempt, and slice 5's retry reads the attempt — not the order status — to decide whether to re-probe the same `request_id` or fall through to a backup.

---

## 3. Keystone two — four tripwires, four different questions

Adding one member to `OrderStatus` broke the build in **three** places. Two were expected. The third was in no plan.

| Tripwire | Where it broke | What it forced |
|---|---|---|
| `_EveryOrderStatusIsClassified` | `packages/contracts` | Classify the new status into exactly one list — §2's decision, made deliberately rather than by default |
| `Readonly<Record<OrderStatus, string>>` | `apps/web`'s label map | The Russian copy written **now**, not hurriedly at the end of the phase |
| **Undocumented:** 8 errors in `apps/api` | `orders.service.ts`, `issuance.service.ts`, `payment-event-processor.service.ts` | The database's status union being one member ahead of the wire contract |

The first is the classification proof: `Exclude<OrderStatus, InFlightOrderStatus | SettledOrderStatus>` must be `never`. Without it an unclassified status reads as in-flight to `isSettledOrderStatus`, and the page polls it forever.

The second is a total record with no `default` branch to hide in. A `switch` with `default: return "Неизвестный статус"` would have compiled, shipped, and put an apology on a shopper's screen.

### The third one, and how it was handled

The 8 `apps/api` errors come from the seam between two lists that describe the same column. `packages/db`'s schema declares `status: text("status", { enum: orderStatuses })`, so the column's TypeScript type is the seven-member union from the database side. `@game-shop/contracts` has its own six-member union for the wire. Widen the first without the second and the DB type stops being assignable to the wire type in every place `apps/api` carries a row's status outward.

That is not a defect — **it is the ordering the migration plan requires**, showing up as a compiler error. The migration must land before the code that writes the new value, so there is necessarily a moment when the column admits a status the wire contract has never heard of, and the compiler names every place that moment is visible.

The way it was established is the part worth telling. Rather than assert the 8 errors were harmless, the agent:

1. added the contracts member as a temporary probe;
2. watched all 8 errors clear, confirming they were the seam and nothing else;
3. confirmed the only error then remaining was the label-map tripwire — the expected one;
4. reverted the probe **byte-identical**, hash matched, and watched the 8 return.

The claim *"these errors are the expected consequence of the ordering"* is a claim about causation, and step 2 is what turns it from plausible into checked.

### The fourth tripwire is a runtime one, and it catches what a type cannot

`apps/api/test/unit/order-status-russian-labels.test.ts` reads the label file **as text** — it does not import it — and counts `[OrderStatus.X]: "…"` entries against the contracts' `orderStatuses` list, then checks each captured string for a character in the Cyrillic block. Adding the seventh status made it fail:

```
found 6 labelled entries: expected 6 to be 7
```

The reason it reads text rather than importing is deliberate and is stated in the file: `apps/web` is a separate Vite application, not a package `apps/api` depends on, and — the stronger reason — *a test that imports the very code it is meant to catch a mistake in cannot catch that mistake.* A total `Record<OrderStatus, string>` already proves an entry exists. Only reading the literal proves the entry is **in Russian**.

Both tripwires fired before a line of label was written. That is RED validation for a translated string, and it cost nothing but the order the work was done in.

### The general point, made once

**These are not four safety nets. They are four different questions.**

| | Question | Only this one can answer it |
|---|---|---|
| `_EveryOrderStatusIsClassified` | Is the status classified? | A record can be total and still classify nothing |
| `Record<OrderStatus, string>` | Does it have a label? | Classification says nothing about copy |
| The text-reading unit test | Is the label in **Russian**? | No type distinguishes `"Не удалось выдать ключ"` from `"Delivery failed"` |
| The DB/contract union seam | Do the column and the wire agree? | The other three all live on one side of it |

A single mechanism answering all four would answer none of them well. The one that generalises least — the regex over a file's text — is the one that catches the failure a reviewer would actually notice on screen.

---

## 4. What the verification added

Independent confirmation of the render, plus three checks the implementer's own run could not cover.

- **No English leaked.** A regex scan for ASCII letter runs over the **rendered** `body.innerText` — not the source. Only `GTA` (a brand name in the catalogue) and order-id fragments matched. Checking the record is not the same as checking the screen: a label can be correct in the file and still arrive beside a hard-coded English string somebody left in the page.
- **`payment_failed` shows no recovery notice at all.** This is the negative case, and it is the one that proves the notice is keyed on `RecoverableOrderStatus` rather than on *"anything that isn't delivered"*. `payment_failed` is settled and **not** recoverable; a notice there would promise a shopper the shop is working on an order it will never touch.
- **The ordinary path still reaches `delivered` with its key.** This slice changed `showOrder`'s composition, and every order state flows through it. A regression there would have been in the happy path, not the failure path.

---

## 5. The honest limitation

**Nothing in `apps/api` can produce `delivery_failed` yet.**

`markDeliveryFailed` has no caller. A grep over `apps/api/src` finds the row that defines it and comments anticipating it, and nothing else:

```
apps/api/src/orders/order-transitions.ts:22   * Phase 3 is that prediction being cashed. `markDeliveryFailed` below is the
apps/api/src/orders/order-transitions.ts:65   * | `markDeliveryFailed` | `delivering → delivery_failed` | …
apps/api/src/orders/order-transitions.ts:130  markDeliveryFailed: { to: OrderStatus.DeliveryFailed, from: [OrderStatus.Delivering] },
```

So the two recoverable states were reached by different means, and only one of them honestly. `out_of_stock` was driven through the genuine issuance path — a real empty pool, a real supplier answer. `delivery_failed` was reached by SQL fixture: the row was written directly and the page was asked to render it.

That is the difference between **"the state renders"** and **"the shop can get there"**, and only the first is true today. Slices 2 and 3 build the ladder — the timeout classifier, the probe, the fall-through — that reaches it. Saying this plainly is cheaper than having a reviewer discover it.

---

## 6. Where this sits in the assignment

`context/product/product-definition.md` §1.4's five adversarial scenarios. This slice settles **none of them**, and it would be easy and wrong to claim otherwise.

| # | Scenario | Status after this slice |
|---|---|---|
| 1 | 50 parallel `paid` webhooks → one issuance fact, one key | Settled in Phase 1, strengthened in Phase 2. Untouched here. |
| 2 | A repeated webhook with the same `event_id` changes nothing | Settled since Phase 1 by the `event_id` PRIMARY KEY. Untouched. |
| 3 | A webhook before its order, or out of order | Settled in Phase 2 slice 3. Untouched. |
| 4 | Empty pool → recoverable → after restock, exactly one key | **Precondition laid, not settled.** The remaining half is slices 4–5. |
| 5 | A promo code with limit N under parallel requests | Phase 5. Not started. |

Its role in scenario 4 is precise and worth stating as precisely as this: scenario 4 needs a recoverable state to exist *and* a retry that consumes exactly one key from it. This slice is the first half of the first half — it makes the second failure state exist, renders it, and classifies it so that the retry will be legal when it is written. The retry itself, and the "exactly one key" proof under two concurrent operators, is slices 4–5.

---

## Interview questions this answers

**"`delivery_failed` sounds final. Why isn't it terminal?"**
Because *terminal* in this codebase is not a mood, it is the set that invariant I9's guarded `UPDATE … WHERE status = ANY($3)` draws its permitted source states from, and `_NoTransitionLeavesATerminalState` fails the build if a terminal status appears in any transition's `from` list. So classifying `delivery_failed` as terminal would make the operator retry — `retryIssuance`, `delivering` from `[out_of_stock, delivery_failed]` — refuse to compile, and spec 003 §2.4/§2.5 could not be built at all. The right split is: terminal means no transition is ever legal; recoverable means nothing moves it by itself, a person does. `out_of_stock` already meant exactly that. To a passive observer the two look identical, which is why `settledOrderStatuses` exists as the union and is what the page's stop-polling condition reads.

**"That's an argument. Did you check it?"**
Yes, and before the code that depends on it existed. I built a throwaway file replicating slice 5's future `retryIssuance` rule and typechecked it under both classifications. Recoverable: exit 0, `Extract<PermittedSourceStatus, TerminalOrderStatus>` stays `never`. Terminal: `error TS2344: Type '"delivery_failed"' does not satisfy the constraint 'never'.` The file was deleted; nothing of it is in the diff. What it bought is that slice 1's classification is known to be the one slice 5 needs, four slices before slice 5 exists to say so.

**"If the order says `delivery_failed`, doesn't that mean the supplier failed?"**
No, and keeping those apart is most of Phase 3. `orders.status` is the shop's statement about itself — "we did not hand over a key". The supplier's side lives in `issuance_attempts.status`, and an attempt that timed out stays `unknown` with `last_error` NULL, because that is still the only truthful thing to say about it: we asked and never learned the answer. Two facts, two tables. Writing `failed` into the attempt row is the exact bug the phase exists to prevent — a timeout treated as a definite failure is what sends a second supplier a second question and puts two keys into one order. Slice 5's retry reads the attempt, not the order status, to decide between re-probing the same `request_id` and falling through.

**"Adding a status is a one-line change. What stopped you getting it wrong?"**
Four things fired without being asked, and they are four different questions rather than four safety nets. `_EveryOrderStatusIsClassified` broke until the status was classified — a record can be total and still classify nothing. The `Readonly<Record<OrderStatus, string>>` label map broke until the Russian was written — there is no `default` branch to hide an apology in. A unit test that reads the label file *as text* and checks the Cyrillic block broke with `found 6 labelled entries: expected 6 to be 7` — a type proves an entry exists, only that proves it is in Russian. And eight `apps/api` errors nobody had planned for.

**"Eight unplanned compile errors sounds like a design problem."**
It is the migration ordering showing up as a compiler error, which is where I would rather have it. `packages/db` declares the column as `text("status", { enum: orderStatuses })`, so the column's type is the database's seven-member union; `@game-shop/contracts` holds the six-member wire union. The migration has to land before any code writes the new value, so there is necessarily a moment when the column admits a status the wire has never heard of — and the compiler names every place that is visible. I didn't assert the errors were harmless: I added the contracts member as a temporary probe, watched all eight clear, confirmed the only remaining error was the expected label-map one, reverted byte-identical with the hash matched, and watched the eight come back.

**"Why is a regex over a source file a test? That's brittle."**
It is, and that is the trade being made deliberately. The alternative was importing `order-status-label.ts` into the API's test suite, which means either wiring a separate Vite app into this package's module resolution for one string table, or trusting a relative path through two bundlers' rules. The stronger reason is the one the file states: a test that imports the code it is meant to catch a mistake in cannot catch that mistake. And the specific thing it catches has no type-level equivalent — nothing in TypeScript distinguishes `"Не удалось выдать ключ"` from `"Delivery failed"`. Both tripwires fired before a word of label was written, which is RED validation for a translated string bought entirely by ordering the work.

**"Why a CHECK constraint and not a Postgres enum? An enum is the obvious modelling choice."**
This migration is the reason that decision went the other way in `0000_init`. `ALTER TYPE … ADD VALUE` cannot use the label it just added inside the transaction that added it, so an enum forbids widening the lifecycle and writing the new value in one migration, and forbids a backfill under the widening. A CHECK is ordinary DDL: drop and re-add inside the migrator's transaction, usable by the next statement. Measured on a 20 000-row fixture: 1.853 ms plus 4.525 ms, ACCESS EXCLUSIVE, no rewrite — `pg_class.relfilenode` for `orders` read 16419 before and 16419 after. I also measured the `NOT VALID` / `VALIDATE CONSTRAINT` two-step at 1.5 ms plus 3.0 ms and rejected it: it buys you a short validating scan, and 4.5 ms on the largest table this shop will ever have does not justify two statements and a window where the constraint exists but is unenforced.

**"Can I see a `delivery_failed` order the shop produced itself?"**
Not yet, and I would rather say so than let it be discovered. `markDeliveryFailed` has no caller — grep over `apps/api/src` finds the table row and comments anticipating it, nothing more. `out_of_stock` was driven through the real issuance path with a real empty pool; `delivery_failed` was reached by writing the row with SQL and asking the page to render it. So "the state renders" is proven and "the shop can get there" is not. The ladder that reaches it — timeout classification, probe, fall-through — is slices 2 and 3.

**"So what did this slice actually settle?"**
None of the five adversarial scenarios, and it would be easy to overclaim here. It is a precondition for scenario 4: the empty pool leaving an order recoverable and, after restock, exactly one key. Scenario 4 needs the recoverable state to exist and a retry that consumes exactly one key from it. This makes the second failure state exist, renders it in Russian, and classifies it so the retry will be legal when it is written in slice 5. The retry, and the two-concurrent-operators proof, is slices 4–5.

---

## Source files

- `packages/db/drizzle/0001_delivery_failed_status.sql` — the widening, its measurements, and both rejected alternatives
- `packages/db/src/schema/shop.ts` — `orderStatuses` and the `text` + CHECK column the third tripwire fires on
- `packages/contracts/src/order-status.ts` — the three sets, the derivation of `settledOrderStatuses`, and `_EveryOrderStatusIsClassified`
- `apps/api/src/orders/order-transitions.ts` — `markDeliveryFailed` as one data row, and `_NoTransitionLeavesATerminalState`
- `apps/web/src/entities/order/lib/order-status-label.ts` — the total record with no `default`
- `apps/web/src/entities/order/lib/order-recovery-explanation.ts` — why it is keyed over `RecoverableOrderStatus` and not `OrderStatus`
- `apps/web/src/entities/order/ui/order-recovery-notice.ts` — `role="status"`, and the narrowing that makes the lookup legal
- `apps/api/test/unit/order-status-russian-labels.test.ts` — the text-reading tripwire
- `context/product/architecture.md` §3 — I9 and its exact SQL
- `context/spec/003-failure-and-recovery/technical-considerations.md` §2.2, §2.4, §2.5 — the `retryIssuance` rule this classification was proven against
- `context/product/product-definition.md` §1.4 — the five adversarial scenarios

**On evidence:** five checks were re-run while writing this document. `pnpm -r run typecheck` across all four workspace projects — `packages/contracts`, `packages/db`, `apps/api`, `apps/web` — all Done, which is the current tree satisfying every compile-time tripwire described above. The label unit test under `vitest run`: **3 passed**. `grep -rn "markDeliveryFailed" apps/api/src` returning only the three lines quoted in §5, which is the honest limitation confirmed rather than repeated. And two queries against the already-running local Postgres: `pg_get_constraintdef` on `orders_status_check`, which returns the seven-value list including `'delivery_failed'`, and `pg_class.relfilenode` for `orders`, which reads `16419` — the same number the implementer recorded on both sides of the migration.

Everything else is reported by other agents in this slice and is not re-verified here: the 1.853 ms / 4.525 ms and 1.5 ms / 3.0 ms migration timings on the 20 000-row fixture, the before/after relfilenode pair, the `TS2344` output from the throwaway `retryIssuance` file, the eight-error probe-and-revert with its matching hash, the `found 6 labelled entries: expected 6 to be 7` failure, and the browser verification — the `innerText` ASCII scan, the `payment_failed` negative case, and the `delivered` regression pass.
