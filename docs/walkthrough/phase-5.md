# Phase 5 — a limit that holds under parallel requests, and a price only the shop decides

> The phase-level walkthrough required by functional spec 005 §2.6. It makes the argument **once**; the four
> Phase 5 slice walkthroughs beside it hold the evidence, and every claim names the one that proves it.
> Nothing here needs the source code to follow.
>
> Four phases proved that the shop sells one key per payment however the world misbehaves. Phase 5 is the
> assignment's bonus stage — a mechanic that has nothing to do with keys, built from scratch — and it is a
> second, independent instance of the same argument: the guarantee lives in one SQL statement the database
> evaluates under a row lock, not in anything a process remembers. The brief supplied four codes and one
> sentence. The sentence has two halves, and each half is a trap a typical shop falls into: a shop that checks
> "used fewer than three times?" and *then* records a use lets ten simultaneous shoppers all pass the check;
> a shop that lets the page say what the discounted price is sells a 3 490 ₽ key for 1 ₽ to anyone who edits
> a number. This document is about how both were avoided and — more to the point for the reviewer's chair —
> how each avoidance was *shown able to fail*.
>
> The phase's own contribution to the argument is a finding rather than a mechanism: **a counter with a
> `CHECK` on it hides a broken guard from any test that reads the counter.** The counter is `used_count`,
> one integer per code; the `CHECK` is a rule the database enforces on every row it writes (here, that
> `used_count` never exceeds the code's limit); the guard is the condition inside the one statement that
> increments it. Weaken that statement to an unconditional increment and twenty parallel shoppers still
> leave `used_count = 3`, three ledger rows (the ledger is the table with one row per order that spent a
> use) and three repriced orders — every database fact correct — while seventeen of them were answered
> `500`, the server-error status, instead of the `409 exhausted` refusal they were owed. That is why every
> proof of the limit in this phase asserts the *shape* of the responses first (exactly N × `200`, the rest ×
> `409 exhausted`, **zero `5xx`**) and the counter only in addition, and why the section that records the
> REDs — the deliberate breakages that show each proof able to fail (§6) — is longer than the section that
> states the mechanism (§3). Every word this document leans on is collected in §2 before it is used in
> earnest.

---

## 0. The assignment's words

The brief's promo stage is one sentence and four rows, transcribed verbatim in
`packages/db/src/fixtures/promo-codes.ts` — "a fixed input, diffable against the brief", in exactly the sense
the catalogue is:

> «Промокоды для этапа 4 (fullstack). Лимит должен соблюдаться даже под параллельными запросами. Скидку
> считает сервер.»
>
> ```
> { "code": "WELCOME10", "type": "percent", "value": 10,  "max_uses": 100 }
> { "code": "GG500",     "type": "amount",  "value": 500, "currency": "RUB", "max_uses": 20 }
> { "code": "LIMIT3",    "type": "percent", "value": 25,  "max_uses": 3 }
> { "code": "ONCEONLY",  "type": "percent", "value": 50,  "max_uses": 1 }
> ```

In English: *the limit must hold even under parallel requests; the server computes the discount.* The two
halves are the phase's two keystones, §3 and §4. `context/product/product-definition.md` §1.4 lists the five
adversarial scenarios that define success, and the fifth is this phase's, in its own words: *"A promo code
with limit N under parallel requests is applied at most N times (stage 4)."* Its §2.1 restates the second
half as a rule — *"The server computes the discount; client-supplied amounts are never trusted."* The
roadmap's line for the phase is the one this document exists to answer: *"Concepts to walk away able to
explain: why a read-then-increment is a race, and how a single conditional update replaces it."* And its
framing note is why this is a *second* instance rather than a new subject — *"a second, independent
demonstration that the concurrency reasoning generalises beyond the issuance path."*

The functional spec turns the sentence into seven requirements and 31 acceptance criteria. The four that
matter most for this document are §2.4 (*"A limit that holds"* — six criteria, one of them the same shopper
pressing «Применить» twice), §2.5 (*"Checking the promise rather than trusting it"* — the reviewer's own
check, runnable twice with no tidying in between, and shown to fail when the mechanism is weakened), §2.3
(*"The shop decides the price"*) and §2.6 (this walkthrough: the race and its replacement in plain
language; how the price stays the shop's and what goes wrong in a shop where it does not; every entry
readable without the source).

| The brief fixes | The phase decided |
|---|---|
| The four codes, their kinds, values and limits — stored as printed, `GG500`'s 500 ₽ becoming 50 000 kopecks in one expression of the seed | One code per order, keyed `PRIMARY KEY (order_id)` — stronger than the architecture's original `(promo_id, order_id)` (§10) |
| The limit holds across every shopper and every order, under parallel requests | A use is spent when the code is *applied*, and an abandoned order does not return it (§10) |
| The server computes the discount | `orders.amount_minor` is the amount to pay, in kopecks; the list price and the discount are recorded on the ledger row (§2), so "the record of what was paid" is a property of columns (§4) |
| — | Percent discounts round half up to the nearest kopeck; a fixed sum larger than the price clamps to 0 ₽ and records the whole list price as the discount (§4) |
| — | An expected refusal is a value the transaction returns after committing nothing; the only throw is a broken invariant (§5) |
| — | The proof runs across four API processes (§3.4 says why one is not enough), asserts the shape of the responses before the counter, and the reviewer's copy hands back what it spent (§6, §7) |

---

## 1. What shipped

Six slices; four carried code. Sizes and suite counts are as each slice's walkthrough reported them at its
close; today's whole-suite figures are in §9.

| Slice | What | Where | Size, and the suites when it closed |
|---|---|---|---|
| 1 — The codes and the counter | Two tables — `promo_codes` (the definitions and one integer of state) and `promo_redemptions` (the ledger) — eight named CHECKs, `PRIMARY KEY (order_id)`, two real foreign keys; migration `0006`, hand-annotated; the fixture; the seed's third `ON CONFLICT` shape (definition rewritten, `used_count` never named); the arithmetic and the normalisation as pure functions; both test harnesses' baseline and cleanup; `architecture.md` amended to `(order_id)` | `packages/db/src/schema/promo.ts`, `drizzle/0006_promo_codes.sql`, `fixtures/promo-codes.ts`, `seed.ts`; `apps/api/src/promo/promo-discount.ts`, `promo-code.ts`; `apps/api/test/unit/promo-discount.test.ts`; `apps/api/test/concurrency/support/db.ts` and `apps/web/e2e/support/db.ts` | **13 unit cases**, RED twice; seven negative schema proofs inside rolled-back transactions; then, in R13's order (the browser tests, then the race checks, then `pnpm test` — §9), e2e **58 in 49.9 s** and `pnpm test` **12 files / 103 tests** (API) + **5 / 56** (web), baseline **4 / 0 / 0** after (four codes, no uses, no ledger rows — §2) |
| 2 — The shop decides the price | The transaction — eight steps, six statements, two invariant throws and no other (§5); `POST /api/orders/:orderId/promo`; the seven possible outcomes (one success, one success that wrote nothing, five refusals — §2) and the `{ reason }` body; `OrderRepricingService` (the one write to `amount_minor` after creation); `findOrder` moved into an exported `OrderViewService`; `promo` on the order view; the acceptance file | `apps/api/src/promo/*`, `apps/api/src/orders/order-repricing.service.ts`, `order-view.service.ts`, `orders.types.ts`; `apps/api/test/acceptance/promo-codes.test.ts` on **5301** | **9 acceptance tests**: RED **9 failed in 6.95 s**, green **9 passed in 7.43 s**; the smoke test by hand — `129000` → ` limit3 ` → `96750`, paid, `payment_events.amount_minor = 96750` |
| 3 — The limit holds under parallelism | The four-process race (three tests) with three REDs recorded verbatim in its header; the reviewer's copy; the admin reset; `architecture.md` §9's two new trade-offs | `apps/api/test/concurrency/promo-limit-race.test.ts` on **5201–5204**, `scripts/race/promo.ts` (`pnpm race promo`, **4601–4604**), `apps/api/src/admin/promo-codes-reset.{controller,service,types}.ts`, `scripts/race/README.md` | **`3 passed` in 9.40 s**; Shape A, Shape B and the lock RED; `pnpm race promo` **3 × 200 / 17 × 409, 1 × 200 / 9 × 409**, the ninth check `pnpm race` discovers |
| 4 — The shopper enters a code | `HttpError.body`; the entity's `promo`, `readPromo`, `applyPromo` and three typed refusals; the «Промокод» row and the `(было …)` span; `features/apply-promo/`; the repaint memo's `promoCode` (§2, §8); six CSS rules on the order page's sheet; two unit files; the browser spec | `apps/web/src/shared/api/http.ts`, `entities/order/*`, `features/apply-promo/*`, `pages/order/ui/order-page.ts`, `app/styles.css`; `apps/api/test/unit/order-status-russian-labels.test.ts`; `apps/web/e2e/promo.spec.ts` on **5101 / 5102** | **13 web unit cases**; **5 new Russian-label cases** (13 in the file); e2e **`6 passed (10.5s)`**, six REDs, **`6 passed (8.9s)`** after the last revert; one screenshot from the smoke test and three from the verify |
| 5 — The walkthrough | This document | `docs/walkthrough/phase-5.md` | — |
| 6 — Acceptance | *Not started while this was written.* The 31-row coverage table, `@spec`/`@regression` per the convention, and the three-suite run in R13's order | — | — |

Two facts about the shape that are easy to miss in the table. **The payment path did not change by a line.**
`PaymentSimulatorService.readOrderCharge` selects `orders.amount_minor` and `currency` and nothing else, so the
discounted amount reaches the webhook — the payment provider's report of a payment, which the simulator
stands in for (§2) — because the column it always read now holds a smaller number — confirmed by reading,
not editing (`phase-5-slice-2-the-shop-decides-the-price.md` §1, change 8). The issuance ladder,
the recovery screen and the storefront are equally untouched; the storefront's «Ввести промокод» is still the
inert control Phase 4 left it. And **the two harness files moved together** — `apps/api/test/concurrency/support/db.ts`
and its duplicate `apps/web/e2e/support/db.ts` gained the same three baseline rows and the same cleanup
statement, byte-for-byte the same executed string (R13; Slice 1 §3.3).

---

## 2. The words this document uses

Phase 3's glossary (`phase-3.md`) covers *guarded UPDATE*, *row lock*, *RED validation* and *zero rows*;
Phase 4's covers *the seed*, *write-first / mutation / inversion RED*, *the drive*, *the verifier*, *the
harness* and *route interception*. Those are used here without re-introduction. Two of Phase 3's words mean
something else in this document and are defined afresh below: its *ledger* is the supplier's
`request_id → code` table and its *pool* is the fifty supplier keys; here *the ledger* is
`promo_redemptions` and *the pool* is the database connection pool. This phase's vocabulary is a database's,
collected in five groups.

**The names.**

- **I-numbers** — I1 to I9 are the invariants table in `architecture.md` §3: one line each for a thing that
  must never happen and the one statement that prevents it. Four appear here. **I4** — only one worker
  advances an order (`SELECT … FOR UPDATE` on the order row, which every transaction that touches an order
  takes first). **I6** — a key is sold at most once (the conditional key claim, §3.5). **I7** — a code is
  used at most N times (the conditional `UPDATE` this document is about). **I8** — one redemption per order
  (`PRIMARY KEY (order_id)` on the ledger and an `INSERT … ON CONFLICT DO NOTHING`, written only under I4's
  lock).
- **R-numbers and assumptions** — R1 to R15 are the risk register in `technical-considerations.md` §3;
  assumptions 1 to 10 are its §5. R1 and R2 are the two predicted shapes of a broken guard (§6); R6 is the
  apply-vs-pay window (§10); R13 is the rule that the suites run in a fixed order so that each later run's
  baseline proves the earlier one cleaned up (§9).
- **Steps 1 to 8** — the numbered statements of the redemption transaction, tabled in §5. Step 1 is the
  order lock; step 5 is I7; step 6 is I8.
- **Shape A, Shape B, the lock RED** — the three deliberate breakages of §6, each run across four processes
  and quoted. Shape A replaces the conditional `UPDATE` with a read-then-increment; Shape B keeps the
  increment relative to the row but drops its condition; the lock RED removes `FOR UPDATE` from step 1.

**The two shapes.**

- **Read-then-increment** — the shape argued against: `SELECT used_count` into a variable, compare it to the
  limit in application code, then `UPDATE … SET used_count = <that variable> + 1`. Also called check-then-act
  or a TOCTOU (time-of-check to time-of-use) window. Two round trips with a decision between them.
- **Conditional update** — the shape that replaces it: one `UPDATE` whose `WHERE` carries the condition and
  whose `SET` is relative to the row, so the database decides and writes in one step. I7, above.
- **The row lock, and the queue** — when a transaction updates a row, Postgres locks that row until the
  transaction ends; every other transaction that reaches the same row with an `UPDATE` waits, in arrival
  order, for that lock. The wait is on the one row — other rows are untouched, no table lock is taken, and
  nothing in Node is involved.
- **`READ COMMITTED`** — Postgres's default isolation level (the rule for how much of other transactions'
  work a transaction is allowed to see) and this project's by design. Each statement sees data committed
  before it began. What matters here is what an `UPDATE` does when it finds its row changed underneath it,
  which is the next entry.
- **Re-evaluation** — under `READ COMMITTED`, an `UPDATE` that waited for another transaction's lock does not
  proceed on the stale version of the row it first found. When the lock is released it fetches the row as
  the other transaction committed it, re-checks the `WHERE` against that version, and updates it or skips
  it. Postgres's name for the machinery is EvalPlanQual; this document otherwise says "re-evaluates the
  `WHERE` against the row as the previous transaction committed it".
- **A wave** — in the four-process harness, the up-to-four transactions that can be inside Postgres at the
  same instant, one per process, because each process's connection pool holds one connection (*the pooled
  handle*, below). Needed to explain why the broken guard admitted nine and not twenty (§3.4).

**The storage.**

- **The counter** — `promo_codes.used_count`, one integer per code. The thing I7 guards and the row every
  redemption of that code queues on. Written by exactly one statement in production.
- **The ledger** — `promo_redemptions`, one row per order that spent a use: which code, at what list price,
  for how much off. The thing I8 keys on. In production the counter equals `count(*)` of the ledger grouped
  by code at every commit; the two are *asserted* to agree, never made to agree by copying one into the other.
- **Definition vs state** — every column of `promo_codes` except `used_count` is definition (the brief wrote
  it; a re-seed may rewrite it); `used_count` is state (the shop wrote it; a re-seed must not touch it).
- **Mechanism vs backstop** — the mechanism is the statement that makes a guarantee hold under concurrency;
  the backstop is the constraint that refuses a row the mechanism should never have produced —
  `CHECK (used_count >= 0 AND used_count <= max_uses)`, named `promo_codes_used_count_range`. A backstop can
  hold with the mechanism gone, which is the whole of §6.
- **Drift** — the counter and the ledger disagreeing. In production it means a rollback failed or a write
  bypassed the transaction; the harness must *see* it, not repair it.
- **The baseline** — the seeded state every suite asserts before it runs and again after its own cleanup:
  12 products, 50 unclaimed keys, 0 orders, 0 payment events, 0 deliveries and — since this phase — 4 codes,
  `sum(used_count) = 0`, 0 ledger rows. A suite that finds the baseline false at its start is reporting the
  previous run's leak, which is the point of asserting it (§9).
- **Minor units** — kopecks. `1290 ₽` is `129000`; `GG500` is stored as `50000`. No money anywhere is a
  float, and `MinorUnits` is a *branded* type on both sides of the wire — a number the compiler refuses to
  accept where a plain number is offered, so a value from a request body cannot be passed as kopecks without
  a deliberate conversion at the call site.

**The transaction.**

- **Under the lock** — between step 1's `SELECT … FOR UPDATE` on the order row and `COMMIT`. Everything read
  under the lock stays true until `COMMIT`, because every other writer of that order — the payment processor,
  the issuance worker, the operator's retry, another redemption — takes the same lock first and waits.
- **The wrapper** — `database.transaction(fn)` in `packages/db/src/client.ts`: takes the process's one
  connection, issues `BEGIN`, runs the body, and issues `COMMIT` when the body returns — whatever it returns
  — or `ROLLBACK` when it throws. Returning a refusal and throwing on an invariant are the two ways out of it.
- **A refusal** — one of the five answers that are not a success: `order_not_found`, `not_awaiting_payment`,
  `another_code_applied`, `unknown_code`, `exhausted`. Each is a *value* the transaction returns after
  committing nothing. `already_applied` is a sixth outcome — a success that wrote nothing — and `applied`
  the seventh; the controller's `switch` (§5) names every one of the seven.
- **An invariant violation** — the one thing the transaction throws: a statement that cannot match zero rows
  while the order lock is held matched zero rows. A `ROLLBACK`, a `500`, a stack trace — a bug, not a busy shop.
- **A sentinel throw** — the idiom this codebase does not use: throwing on purpose inside a transaction so
  the wrapper rolls back, then catching by type above and translating into an ordinary answer.
- **The pooled handle, and `max: 1`** — the connection pool is one connection per API process (the serverless
  shape). A transaction holds that connection for its whole body; a pooled read issued from inside it waits
  for a connection the transaction will not release until the read returns. §5's last paragraph.
- **The shape of the refusals** — the histogram of HTTP statuses a race produces: exactly N × `200`, the
  rest × `409 { "reason": "exhausted" }`, nothing else.

**The page and the checks.**

- **The order view** — the JSON `GET /api/orders/:id` answers; since this phase it carries `promo`, which is
  `null` or `{ code, discount_minor, list_amount_minor }`. `POST …/promo` answers with the same shape.
- **The poll** — the order page's reading loop: while the order is in flight it reads `GET /api/orders/:id`
  once a second, each read chained off the end of the previous one rather than run on a timer, and hands
  every answer to the page's one writer. `refreshNow()` asks it for a read now — or, if one is already in
  flight, the instant that one lands.
- **The memo** — the order page's record of the last order it painted: `{ status, code, promoCode }`. A read
  whose three fields match the memo is not painted, so a half-typed code survives the once-a-second poll.
- **The simulator and the webhook** — the shop has no real payment provider; `PaymentSimulatorService` plays
  one. When the shopper presses «Оплатить успешно» it reads the order's `amount_minor`, then calls the shop
  back the way a provider would — with the **webhook**, a signed report of the payment — which the shop
  records in `payment_events` (Phase 2's inbox) before acting on it. Nothing in this phase touched that
  path, which is §4's last paragraph.
- **One writer** — `showOrder` is the only function that replaces the page's content region with an order in
  hand; the form, the payment controls and the recovery notice hand it elements and never place them.
- **The reviewer's copy** — `scripts/race/promo.ts`, run as `pnpm race promo`: the race proof written to be
  pointed at any base URL and to print what it found.
- **The admin reset** — `POST /api/admin/promo-codes/reset`: zeroes every counter, leaves the ledger. For the
  deployed shop only.
- **The harness, and its witnesses** — Phase 4's word, used here for the four-process Vitest file and the
  reviewer's copy alike: the code that starts the API instances, creates the orders, fires the requests and
  reads the database afterwards. Its **pids** are Postgres backend process ids — one server process per open
  connection — sampled from `pg_stat_activity` (Postgres's table of live connections) while the requests are
  in flight: four distinct pids in one sample means four connections were open at the same instant.
- **The CTE** — the harness's cleanup statement (§7): one statement written as a chain of named sub-results
  (`WITH gone AS (…), per_promo AS (…) UPDATE …` — a *common table expression*), so that deleting a run's
  ledger rows and decrementing its counters cannot be interrupted between the two.
- **`23514`, `ExecConstraints`** — Postgres's error code and internal routine name for a `CHECK` violation;
  both appear in every `500` of §6.2, and the same constraint refuses the cleanup's `−6` in §6.1.

Russian strings that appear below: «Применить» ("apply"), «Промокод» ("promo code"), «Сумма» ("amount"),
«было …» ("was …"), «скидка» ("discount"), «Ожидает оплаты» ("awaiting payment"), «Ключ выдан» ("key
issued"), and the three sentences the form can show — «Такого промокода нет» ("no such promo code"),
«Промокод больше не действует» ("the promo code is no longer valid"), and «Не удалось применить промокод.
Проверьте соединение и попробуйте ещё раз.» ("could not apply the promo code; check the connection and try
again").

---

## 3. The keystone: a read-then-increment is a race, and one conditional `UPDATE` replaces it

### 3.1 In plain language, first

The roadmap's question, answered before any code is opened, in two sentences that need no term from §2:

> A read-then-increment is a race because the count is read in one round trip and checked and written in
> another, so the check is made against a number that may already be stale — two shoppers both read `2`,
> both pass `2 < 3`, both write `3`, and two uses are recorded while the counter moved once. One conditional
> update replaces it because the check and the write are one statement that the database itself evaluates,
> one transaction at a time under the row's lock, against the row as the previous transaction left it — so
> the fourth in line sees `3 < 3`, changes nothing, and the limit holds across any number of processes.

In SQL the second sentence is one statement — `UPDATE promo_codes SET used_count = used_count + 1 WHERE
id = $1 AND used_count < max_uses RETURNING used_count` — and `RETURNING` is how the caller learns which way
it went: one row back means this transaction took a use, no row back means the code is spent. "One
transaction at a time under the row's lock" is the queue of §2, and "against the row as the previous
transaction left it" is `READ COMMITTED`'s re-evaluation; both are named there and slowed down in §3.3.
Everything else in this section is those two sentences slowed down.

### 3.2 Why the read-then-increment races

Take the obvious implementation, the one every first draft writes. `LIMIT3` has `max_uses = 3`, and the code
does what "used at most three times" seems to ask for:

```sql
SELECT used_count FROM promo_codes WHERE code = 'LIMIT3';   -- returns 2
-- in TypeScript: if (usedCount >= maxUses) return exhausted;  // 2 < 3, go on
UPDATE promo_codes SET used_count = 3 WHERE code = 'LIMIT3'; -- $read + 1
INSERT INTO promo_redemptions …;
```

Two shoppers, A and B, at the same instant, with the counter at `2`. A's `SELECT` returns `2`. B's `SELECT`
returns `2` — nothing has changed yet, and a `SELECT` takes no lock that would make B wait for A. A compares
`2 < 3` and goes on; B compares `2 < 3` and goes on. A writes `used_count = 3`; B writes `used_count = 3`.
Both insert a ledger row. The code was applied twice, the counter moved once. Generalised: with N transactions
reading at the same moment, all N read the same committed value, all N pass, all N write the same `read + 1`
— the counter advances by one per *moment*, the ledger by one per *transaction*.

The window is between the `SELECT` returning and the `UPDATE` arriving — two round trips with a decision
made in between, in a process that is one of several. Nothing between them closes it. A second check in
TypeScript checks the same stale number. A lock in Node is one process's lock, and the API runs as serverless
functions where two requests are two processes. A retry loop retries the same read-then-write. Making the gap
shorter does not help — it is a race, not a timeout; the harness's whole twenty-request race took 204 ms and
still admitted nine (§3.4). What closes it is one of two things, and both put the decision in
Postgres: make the database decide the value at the moment it writes, or hold a lock from the read to the
write so that no one else can read in between. The first does it in one statement, and that is I7.

### 3.3 The statement, the queue, and what each transaction sees when its turn comes

`architecture.md` §3.1 writes I7 as the canonical statement — *"One statement: no read-then-write, so there
is no window to race in"*:

```sql
UPDATE promo_codes
SET used_count = used_count + 1
WHERE id = $1 AND used_count < max_uses
RETURNING *;
-- 0 rows => exhausted; reject the redemption
```

(`$1` is the slot the code's `id` is bound into when the statement runs) and the transaction's step 5 (§5)
issues it as the ORM emits it — the ORM is Drizzle, the library that writes the SQL for the service, and the
statement it emits is quoted in a comment beside every call — with one column returned rather than `*`:

```sql
update "promo_codes"
set "used_count" = "promo_codes"."used_count" + 1
where ("promo_codes"."id" = $1
       and "promo_codes"."used_count" < "promo_codes"."max_uses")
returning "used_count";
-- 1 row  => THIS transaction holds one of the N uses
-- 0 rows => EXHAUSTED. Nothing has been written; the transaction commits
--           empty and the shopper is told the code is spent (409)
```

The check and the write are one statement. There is no `SELECT` before it that returns the count to Node, no
TypeScript comparison, no variable holding a number that could go stale.

Twenty of these arrive at one row. The first to reach it takes the row's lock — an `UPDATE` always does —
and holds it until its transaction commits. The other nineteen queue *on that row*: not on the table (a
shopper applying `WELCOME10` is not waiting behind `LIMIT3`'s queue), and not in Node (four processes share
no memory; the queue is inside Postgres, where the row is). When the first commits, `used_count` is `1`. The
second obtains the lock. Here is the step that makes the statement correct rather than merely tidy. Under
`READ COMMITTED`, the second `UPDATE` began with a snapshot in which `used_count` was still `0` — but Postgres
does not write on that stale version. Having waited for the lock, it fetches the row **as the previous
transaction committed it**, re-evaluates `used_count < max_uses` against that version, and only if it still
matches applies `used_count + 1` to it. So the second sees `1 < 3` and writes `2`; the third sees `2 < 3`
and writes `3`; the fourth obtains the lock, re-evaluates `3 < 3`, matches zero rows, updates nothing, and
`RETURNING` hands back nothing. The fifth through twentieth do the same. Three winners, seventeen refusals,
in whatever order the twenty happened to reach the row.

Three details of the statement are load-bearing, and each RED in §6 leans on one. **`used_count + 1` in
SQL, not `$read + 1` from Node** — the increment is relative to whatever the committed value is at the
moment the statement runs, after the queue and the re-evaluation; a computed absolute value is relative to a
value read earlier, and "earlier" is the window (Shape A, §6.1). **`RETURNING "used_count"` tells one row from
zero** — without it the statement succeeds silently either way and the code needs a second read to know
whether it holds a use; with it, an empty result *is* the exhausted branch (Shape B is what happens when the
`WHERE` that produces that empty result is removed). **The definition read at step 4 does not select
`used_count`** — the counter is read by no statement but the one that writes it, so nothing in memory can be
tempted to compare against a count it read a moment ago; Shape A began by adding `used_count` to that very
column list.

### 3.4 Why the proof needs four processes — the measurement

**One process cannot show the race.** `packages/db/src/client.ts` pins the pool to `max: 1` per API process
— the serverless shape, not a test setting. Inside one process a transaction holds the only connection from
`BEGIN` to `COMMIT`, so a second concurrent redemption waits *in Node* for a connection before a byte reaches
Postgres. Every transaction runs alone. A read-then-increment in that setting would read the newest committed
value every time — `0`, then `1`, then `2`, then `3` and refused — and would produce exactly three, because
the pool serialised what the code did not. That "would" is arithmetic from the pool, not a run this phase
made (§10's last row); the measurement is Phase 2's, for the keys: Architecture §7 ran the key claim
weakened to an unlocked `SELECT`-then-`UPDATE` and saw **20** distinct keys against one process, **9**
against four. The broken code is flawless in one process; a single-instance race test measures the
connection pool, not the constraint. Raising the pool size in tests is not the fix either — a test that changes the configuration
under test proves some other system correct.

**So the harness starts four.** `promo-limit-race.test.ts` builds the packages, spawns four `dist/main.js`
processes on 5201–5204, waits on each one's `/api/health`, creates twenty orders round-robin, fires twenty
`POST …/promo { code: "LIMIT3" }` in one `Promise.all` (all twenty sent before any answer is awaited), and
throughout samples `pg_stat_activity` — Postgres's table of live connections — from a second connection for
distinct backend pids, the server process ids behind those connections: a soft witness that the requests
overlapped, beside the RED, which is the hard one. On the three RED runs the witness saw **`[9204, 9205, 9206, 9207]`**,
**`[9885, 9886, 9887, 9888]`** and **`[10098, 10099, 10100, 10101]`** — four distinct on every wave.

**Nine of twenty, and the wave arithmetic.** With the guard replaced by a read-then-increment (Shape A, §6.1)
the four-process harness admitted **9 × `200`** on one run and **11 × `200`** on the next, for a limit of three.
The technical spec had predicted twenty. The reason it was nine is the same `max: 1` pool that makes one
process useless as a harness: four processes, four connections, at most four transactions inside Postgres at
once — a wave. Every member of a wave reads the same committed counter and writes the same `read + 1`. Wave
one reads `0`, four winners, counter `1`. Wave two reads `1`, four winners, counter `2`. Wave three reads
`2`, four winners, counter `3`. Wave four reads `3` and refuses. The counter advances by one per wave; the
ledger grows by one per winner; the most the shape can admit is twelve, and nine and eleven are waves that
were not perfectly aligned — some transactions in a wave already saw the previous commit. `ONCEONLY` is the
cleaner case: only the first wave can win, so the winner count is the wave size, and it was **4 × `200`** on
both runs — the number of processes, exactly. Against one process there would be one transaction per wave,
each reading the newest value, and the count would be exactly three: the race invisible. That is R1 stated
as arithmetic, and it is why the four-process number is the proof and the one-process number is nothing.

### 3.5 The same argument, a second time

Phase 2's key claim, I6, is the first instance of this argument in the codebase:

```sql
UPDATE supplier_keys
SET claimed_by_request_id = $1, claimed_at = now()
WHERE code = (
  SELECT code FROM supplier_keys
  WHERE claimed_by_request_id IS NULL
  ORDER BY id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING code;
-- 0 rows => pool exhausted => out_of_stock
```

Set beside I7, the two do different things with the same principle. I6 *picks a free row*: the subquery locks
one unclaimed key and skips any row another transaction already holds, so twenty claimants take twenty
different keys without waiting for each other. I7 *tests-and-writes one row*: every redemption of `LIMIT3`
wants the same row, so they must queue on it, and `SKIP LOCKED` would be exactly wrong — a transaction that
skipped the locked row would tell a shopper "exhausted" one commit before the count was known. What they
share is what makes both correct across processes: the decision and the write are one statement, evaluated by
Postgres under a row lock, and `RETURNING` reports which way it went. Neither reads a value into a process and
acts on it later. Both REDs have the same signature — a count that varies between runs: nine, then ten, of
twenty for the keys; nine and eleven for a limit of three here.

*Depth: `phase-5-slice-3-the-limit-holds-under-parallelism.md` §3, §4 (the statement, the queue, the three
details, I6 beside I7), §5.1 (four processes), §7.1 (the wave arithmetic); `architecture.md` §3.1, §7.*

---

## 4. The second keystone: the price is the shop's

**In plain language, first.** The shop keeps the price its own decision by accepting exactly one thing from
the shopper — the code, as text — and working out the amount to pay inside the same locked transaction from
two numbers it reads from its own tables, the order's stored price and the code's stored definition; the
page is then handed the result in kopecks and displays it, with no arithmetic of its own. A shop that does
not — that lets the page send a total, or a discount, or even the "original" price it just displayed — has
handed the price to whoever holds the request, and a request is text anyone can edit: a 3 490 ₽ key goes for
1 ₽ to the first shopper who opens the browser's developer tools and changes a number, the shop charges what
it was told, and nothing in its logs tells that shopper from an honest one. The rest of this section is the
first sentence slowed down, statement by statement, and then the second with each of its failure modes named.

**`{ code }` is the only input.** The request body to `POST /api/orders/:orderId/promo` is one string. The
controller's parser reads the `code` key and no other; an extra field is ignored, not rejected —
`{ "code": "LIMIT3", "discount_minor": 100000 }` applies `LIMIT3` at the server's price. Empty after trimming
is a `400` before any transaction opens. The string is normalised once in the service — trim, then
upper-case — and that one form is the SQL parameter at step 4, the comparison at step 3 and the `promo_code`
on the log line; the schema's `CHECK (code = upper(btrim(code)))` guarantees the stored side of the equality.

**The amount is computed under the lock from stored data only.** Step 1 locks the order row and returns its
`amount_minor` — `129000` for a `KEY-CS2-PRIME` order (the 1 290 ₽ catalogue item every test in this phase
buys). Step 4 reads the code's definition — `kind`, `value`,
`currency`, `max_uses` — with no lock. `computeDiscount(129000, { kind: 'percent', value: 25 })` is
`Math.round(129000 × 25 / 100) = 32250`, to pay `96750`. Both inputs came from rows read inside this
transaction; the request body is not an input and there is no parameter it could be. The arithmetic is a pure
function with the brief's four worked examples pinned in its unit file — on a 1 290 ₽ order, `WELCOME10` →
1 161 ₽, `GG500` → 790 ₽, `LIMIT3` → 967,50 ₽, `ONCEONLY` → 645 ₽ (`116100 / 79000 / 96750 / 64500`) — and
two cases the seeded amounts cannot tell apart: 25 % of 9 999 kopecks → 2 500 (half up, not truncation) and a
fixed sum larger than the price → 0 ₽ with the clamped discount recorded. It multiplies first and divides
last, so the product is an exact integer and an exact half reaches `Math.round` as an exact `.5`.

**Written once, while `created`.** `orders.amount_minor` is the amount to pay, and it is written by exactly
two statements in the codebase: the `INSERT … SELECT` that creates the order, copying `products.price_minor`
column-to-column inside Postgres so no TypeScript variable ever holds a price, and step 7 —
`OrderRepricingService.applyDiscount`:

```sql
update "orders"
set "amount_minor" = $1, "updated_at" = now()
where ("orders"."id" = $2 and "orders"."status" = $3)
returning "id";
-- $1 the amount to pay from `computeDiscount`, $3 the literal 'created'.
```

— at most once more, under the order lock, from `computeDiscount`'s output, taking the branded kopeck type
so an unbranded number from a body cannot reach it without an explicit conversion at a call site the
transaction is the only one of.

**The list price and the discount live on the ledger.** The catalogue figure does not vanish when the code
is applied; it moves to `promo_redemptions.list_amount_minor` beside `discount_minor`, and
`list_amount_minor = amount_minor + discount_minor` holds on every row — including the 0 ₽ row, where the
discount recorded is the whole list price rather than the code's face value; `CHECK (0 <= discount_minor AND
discount_minor <= list_amount_minor)` refuses any row for which the identity would not hold. That is what
"the record of what was paid does not change after the fact" (functional spec §2.3) means as a property of
columns: the operator's undelivered list reads `amount_minor` and shows what was paid; a delivered order's
view reads the ledger and shows what it was before, a month later, without asking a catalogue that may have
changed. On the wire, `promo` carries `code`, `discount_minor` and `list_amount_minor` and **no `kind`, no
`value`, no percentage** — the page is handed the applied kopecks and nothing it could recompute a price from.

**The page has no arithmetic.** «967,50 ₽» is `formatPrice(order.amountMinor)`; «322,50 ₽» is
`formatPrice(order.promo.discountMinor)`; «1290 ₽» is `formatPrice(order.promo.listAmountMinor)`.
`formatPrice` divides kopecks by 100 and spells a Russian comma — arithmetic of *units*, not of *price*, the
same function the catalogue has used since Phase 1. A `grep` across the three files that render or submit an
amount for any amount field beside `+`, `−`, `×` or `/` finds nothing; `discount_minor` is on the wire as its
own field precisely so the page never derives it as `list − amount`. So the number on screen is the number in
`orders.amount_minor`, which is the number the payment simulator reads when the shopper pays, and there is
one calculator in the system.

**What goes wrong in a shop that does not do this.** The functional spec's §1 puts it in one line: *a shop
that lets the page say what the discounted price is will sell a 3 490 ₽ key for 1 ₽ to anyone who edits a
number.* Every field a client sends is a field a client can send differently, and the page is not the only
client — `curl`, a command-line tool that sends whatever request one types, is. The softer version — the
server computes the discount but trusts the client's `amount`
as the base, "since the page just read it from the API" — fails one step later: a base that arrived in the
request is a number the server did not read under the lock, so a stale tab or a hand-edited body chooses
the base and the "server-computed" discount is computed from a figure the shopper picked. Two calculators
also drift on the first input that separates them: the server rounds integer kopecks half up; a page working
in roubles from a float will not always; a fixed sum larger than the price needs the server's clamp
reproduced in a second language or the page shows a negative amount. And an optimistic paint — showing the
discount before the shop has answered — lies for the length of a refusal: under the race §6 proves,
seventeen of twenty shoppers would watch a discount appear and vanish. The shop's answer is the only answer,
so the page waits for it.

**Measured, end to end, by hand today.** An order at `129000`; `LIMIT3` → `amount_minor 96750`,
`promo { code LIMIT3, discount_minor 32250, list_amount_minor 129000 }`; the simulator built its webhook with
`amount 967.5` (the provider's contract is in roubles; the webhook controller converts it back and the inbox
row lands as `payment_events.amount_minor = 96750`); the order went to `delivered` with the key and the promo
still on the view; a second `LIMIT3` on the delivered order → `409 {"reason":"not_awaiting_payment"}`;
`FIFTH` on a fresh order → `422 {"reason":"unknown_code"}`. The acceptance file asserts the same chain from
the inside — its ninth test reads `payment_events.amount_minor` from the table and its RED is
`expected 96750 to be 129000` (Appendix A).

*Depth: `phase-5-slice-2-the-shop-decides-the-price.md` §3 (the eight steps with their statements), §4.3;
`phase-5-slice-4-the-shopper-enters-a-code.md` §4.1; `phase-5-slice-1-the-codes-and-the-counter.md` §4 (the
arithmetic's thirteen cases and why multiply-first).*

---

## 5. The transaction's ordering

`PromoRedemptionService.apply(orderId, rawCode)` is one `BEGIN … COMMIT` on one connection, eight numbered
steps, six of them SQL statements. The order of statements *is* the design (technical-considerations §2.2
fixes it as a table): every statement that can say no runs before either statement that only writes.

| # | Statement | Zero rows → |
|---|---|---|
| 1 | `select … from "orders" where "orders"."id" = $1 for update` — the order lock | `order_not_found` → **404** |
| 2 | *(in memory)* `status !== 'created'` — sound only because of step 1 | `not_awaiting_payment` → **409** |
| 3 | `select "promo_codes"."id", "promo_codes"."code" from "promo_redemptions" inner join "promo_codes" on … where "promo_redemptions"."order_id" = $1` — this order's existing redemption, under the order lock, **before** the code lookup | a row with the same code → `already_applied` → **200**, nothing written; a different code → `another_code_applied` → **409** |
| 4 | `select "id", "code", "kind", "value", "currency", "max_uses" from "promo_codes" where "promo_codes"."code" = $1` — no `FOR UPDATE`; **`used_count` deliberately not selected** | `unknown_code` → **422** (a currency mismatch on an `amount` code is refused the same way) |
| — | *(in memory)* `computeDiscount(order.amount_minor, promo)` | — |
| 5 | **I7** — the conditional `UPDATE` of §3.3 | `exhausted` → **409**. Nothing written; the transaction commits empty |
| 6 | **I8** — `insert into "promo_redemptions" (…) values ($1, $2, $3, $4, default) on conflict ("order_id") do nothing returning "order_id"` | **impossible under the lock → throw → ROLLBACK undoes step 5 → 500** |
| 7 | `applyDiscount` — the `update "orders" … where … "status" = $3 returning "id"` of §4 | **impossible under the lock → throw → ROLLBACK of 5 and 6 → 500** |
| 8 | return `{ outcome: "applied", … }` — **no re-read inside the transaction** | — |

**Refusals before writes, and an expected refusal commits empty.** Five steps can say no — the lock, the
status, the ledger row, the code lookup, the conditional `UPDATE` — and they run ahead of the two statements
that only write. When any of the five says no, the method *returns* a member of the outcome union, the
wrapper issues `COMMIT`, and the commit is of a transaction that changed nothing. Step 5 sits at the hinge:
it is the last thing that can refuse and the first thing that writes, and the two are the same fact — a
statement that matched zero rows wrote nothing. The controller's `switch` over the seven-member union, with
`assertNever` in its `default`, is the only place an outcome becomes a status, and `promoRefusal(reason)`
builds body and status together so they cannot disagree. Step 3 sits before step 4 for a reason that matters
under load: a retry, a double-click, a reload that resubmits are all answered from *this order's* ledger row
under *this order's* lock, and never touch the `promo_codes` row twenty other shoppers are queueing on.

**The obvious alternative, and what it costs.** Increment first — take the contended use as the opening
statement, then lock the order and check the rest; when a later check fails, throw a sentinel so the wrapper
rolls the increment back, and catch it in the controller. The technical spec records that two reviewers
disagreed on exactly this and that both orderings are correct for the limit. What the sentinel costs is
everything around the limit: the controller's exhaustive `switch` becomes an `instanceof` chain the compiler
cannot check, so a new refusal in the service is a new `500` in the controller until somebody remembers the
second file; every expected refusal becomes a real `ROLLBACK` round trip on a `max: 1` pool with the order
lock — and, in that shape, the hot promo row's lock — held until it completes; a refused shopper shows up in
the log as an error with a stack trace, indistinguishable from a real one, when an exhausted code under
twenty simultaneous shoppers is the limit *holding*; and Nest's exception filter (NestJS is the API
framework; its filter is what turns an uncaught throw into a `500`) either has to unpack a domain error or
the service has to throw HTTP types from inside a database transaction. This codebase has never thrown to
roll back anywhere — the transition helper, the key claim and the inbox drain all report zero rows as an
outcome — and the transaction was written in the shape that keeps that true.

**The two invariant throws.** Steps 6 and 7 are the only statements that throw, and both are impossible on
the path that exists. Step 3 read the ledger under the lock and found nothing, and every other writer of this
order's ledger row must first take the same lock at its own step 1 — so no row can appear between step 3 and
step 6. Step 2 read `created` under the lock, and every status transition goes through the transition
service, which takes the same lock — so the status cannot move between step 2 and step 7. If either statement
returns zero rows anyway, something wrote to the order without the lock. That is worth a `500`, a `ROLLBACK`
that undoes the step-5 increment, and a stack trace with `order_id`, `promo_code`, `promo_id` and `step` on
it — the typed `PromoRedemptionInvariantError` — because it is a bug and not a busy shop. The `ON CONFLICT`
target is named, `(order_id)`, so the clause forgives exactly one constraint: the two foreign keys and the
discount-range CHECK still raise as the errors they are. §6.3 is what this looks like when the lock is
actually removed — and it is the second stop that stayed standing.

**The view is read after `COMMIT`, on a `max: 1` pool.** The handler is two calls in a fixed order: `apply`
runs the transaction to `COMMIT` and returns an outcome, never the order; then, for `applied` and
`already_applied`, `OrderViewService.findOrder(orderId)` reads the view on the pooled handle — one `SELECT`
with four `LEFT JOIN`s, two of them new (`promo_redemptions` on `order_id`, `promo_codes` on `promo_id`;
1:0..1 because `order_id` is the primary key, so no row multiplication). The body the shopper receives is the
committed row, which every other process can also see. The wrong composition — a pooled read inside the
transaction — is a self-deadlock worth saying slowly: the transaction has checked the instance's only
connection out for its whole body; `findOrder` asks the pool for a connection; the pool has none until the
transaction releases its own; the transaction is `await`ing `findOrder` and will not release until it returns.
Nothing can ever return. The driver gives up after `CONNECTION_TIMEOUT_MS` — ten seconds — with an error that
names the pool rather than the cause, and the order row lock has been held for those ten seconds with every
payment worker and every other redemption for that order queued behind it. It was not discovered here:
`client.ts`'s `transaction()` doc, `OrderTransitionService` and the inbox drain all name it from Phase 2, and
the tech spec carried it as R3 before the code existed. The code avoids it by construction rather than by
care: `findOrder` takes no `tx` and there is no `findOrderWithin(tx, …)`; `lockOrder` and `applyDiscount`
take *only* a `tx`. The two signatures point opposite ways so the wrong composition has no API to be written
with.

*Depth: `phase-5-slice-2-the-shop-decides-the-price.md` §3 (each step with its emitted statement), §4.1 (the
sentinel's five costs), §4.2 (the self-deadlock and the three places its comment lives).*

---

## 6. The CHECK masks the guard — the three REDs

Three deliberate breakages of the mechanism, each run across four `dist/main.js` processes on 5201–5204 on
14 September 2026, each recorded verbatim in `promo-limit-race.test.ts`'s header, each followed by a
byte-identical restore proven with `cmp` (a byte-for-byte file comparison against a copy taken before the
edit), a green suite (**`3 passed`, 9.40 s**) and a passing `pnpm race promo` from a zeroed baseline. Every line quoted below is from that header; Appendix A holds the
full set in one place. The procedure per shape: copy the source file aside, edit, rebuild, run the suite in
the foreground, run `pnpm race promo` once on its own ports (4601–4604), clean any debris, restore, `cmp`,
rebuild.

**What the green run looks like, for contrast.** `LIMIT3` ×20: 3 × `200` with `promo { code: "LIMIT3",
discount_minor: 32250, list_amount_minor: 129000 }` and `amount_minor: 96750` on the order each was asked for,
17 × `409 { "reason": "exhausted" }`, no other status; `used_count = 3`; the set of ledger `order_id`s equals
the set of winners' `order_id`s — equal, not merely equal in size; the three winners carry `96750` and the
seventeen losers still carry `129000`; more than one backend pid. `ONCEONLY` ×10: 1 and 9, `64500` on the
winner. One order, `LIMIT3` ×4 simultaneously: four `200`s with byte-identical bodies, one ledger row, the
counter moved by one.

### 6.1 Shape A — read-then-increment with a computed value

**The edit.** Select `used_count` at step 4; after `computeDiscount`, `if (promo.usedCount >= promo.maxUses)
return { outcome: Exhausted, … }` in TypeScript; replace step 5 with `.set({ usedCount: promo.usedCount + 1 })
.where(eq(promoCodes.id, promo.id))` — no `lt(...)`, no re-evaluation. §3.2's race, written into the service.
**Predicted** (R1): more than three `200`s and more than three ledger rows, the counter under-reporting; the
tech spec's table said "all twenty write `1`, twenty rows, twenty `200`s".

**Run 1**, verbatim:

```
LIMIT3 x20:   raced in 204ms; statuses=[200, 200, 200, 200, 409, 200,
              200, 200, 409, 200, 200, 409, 409, 409, 409, 409, 409,
              409, 409, 409]  →  9 × 200, 11 × 409; used_count = 3,
              NINE promo_redemptions rows (pids [9204, 9205, 9206, 9207])
ONCEONLY x10: raced in 112ms; statuses=[200, 200, 200, 200, 409, 409,
              409, 409, 409, 409]  →  4 × 200, 6 × 409; used_count = 1,
              FOUR rows
```

Nine, not twenty — §3.4's wave arithmetic. And on this run the scenario's own assertion was **masked** by
the cleanup, which is the `−6` finding: the `finally` cleanup runs the harness's cleanup statement (the CTE
of §7), which deletes this run's ledger rows and decrements each code by exactly that count — nine, against
a counter of three. The row
it tried to write was `(3, LIMIT3, percent, 25, null, 3, -6)`, and `promo_codes_used_count_range`'s *lower*
bound refused it. In JavaScript a `throw` from `finally` replaces whatever was already propagating out of the
`try`, so Vitest reported, for both twenty-order tests:

```
error: new row for relation "promo_codes" violates check constraint "promo_codes_used_count_range"
 ❯ cleanupTestOrders test/concurrency/support/db.ts:296:3
```

the third test failed its precondition — `AssertionError: precondition: LIMIT3 unused before this test:
expected 3 to be +0 // Object.is equality` — and `afterAll` reported `orders = 30, expected 0`,
`promo_codes sum(used_count) = 4, expected 0`, `promo_redemptions = 13, expected 0`: the twenty and ten
orders, `3 + 1` on the counters, `9 + 4` on the ledger. Two things to take from it. The decrement-not-recompute
rule (§7) is a second drift detector, and it fired from the side nobody was watching: Slice 1's argument was
that a recompute would *hide* a counter that outran its ledger; here the ledger outran the counter, and the
decrement made it impossible to miss — a recompute would have written `0` and reported a clean baseline on a
run that had just admitted nine. And the CHECK's lower bound, added in Slice 1 for an over-decrementing
cleanup, is exactly what turned the drift into an error rather than a `−6`. Debris was cleaned by hand with
the harness's statements plus `UPDATE promo_codes SET used_count = 0` — the admin reset's shape, the one time
it is honest, because counter and ledger had been *made* to disagree.

**Run 2**, with the cleanup's throw caught temporarily in the test file only so the assertions could surface:

```
LIMIT3 x20:   raced in 1114ms; … →  11 × 200, 9 × 409
  AssertionError: exactly three 200s — the limit, not a race artefact: expected [ … ] to have a length of 3 but got 11
ONCEONLY x10: raced in 503ms; … →  4 × 200, 6 × 409
  AssertionError: exactly one 200: expected [ … ] to have a length of 1 but got 4
afterAll: orders = 30, sum(used_count) = 4, promo_redemptions = 15.
```

The `zero 5xx` assertion stayed green under this shape — nothing ever reached the CHECK's upper bound, because
every write was `$read + 1` with `$read ≤ 2`. The reviewer's copy under Shape A printed
`INFO  response shape — 200: 9, 409 exhausted: 11`, then `FAIL  exactly 3 × 200 — the cap's worth, no more — 9 × 200`,
`FAIL  exactly 17 × 409 exhausted — every other shopper told no, in words — 11 × 409 exhausted`,
**`PASS  used_count = 3 for LIMIT3 — the counter half of I7 — used_count = 3`**,
`FAIL  exactly 3 promo_redemptions row(s) among this run's 20 orders, all for LIMIT3 — the ledger half of I8 — 9 row(s)`,
the `ONCEONLY` trio the same way (`3 × 200`, `7 × 409 exhausted`, `3 row(s)`, `PASS used_count = 1`) — and
then crashed in its own `finally` with `detail: 'Failing row contains (3, LIMIT3, percent, 25, null, 3, -6).'`,
`FAIL  promo                    exited 1 (1838ms)`, `race: 0/1 passed against 4 instance(s).` The counter
line *passed* under a guard that admitted nine: the counter under-reports the ledger, which *is* the race.

### 6.2 Shape B — the unconditional increment, and the finding

**The edit.** Keep `usedCount: sql\`${promoCodes.usedCount} + 1\``, drop the `lt(...)` predicate —
`.where(eq(promoCodes.id, promo.id))` only. The increment is still relative; the guard is gone.
**Predicted** (R2): 3 × `200`, 17 × `500`, `used_count = 3`, three rows; the counter-only assertions green;
only `zero 5xx` and `17 × 409` red.

**Result — exactly as predicted, in both harnesses:**

```
LIMIT3 x20:   raced in 8553ms; statuses=[500, 200, 200, 500, 500, 500,
              500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500,
              500, 500, 200]  →  3 × 200, 17 × 500, 0 × 409
              (pids [9885, 9886, 9887, 9888])
ONCEONLY x10: raced in 365ms; statuses=[200, 500, 500, 500, 500, 500,
              500, 500, 500, 500]  →  1 × 200, 9 × 500, 0 × 409
The first red line in both tests:
  AssertionError: every response must be 200 or 409, never anything else: got 500 {"statusCode":500,"message":"Internal server error"}: expected [ 200, 409 ] to include 500
Tests  2 failed | 1 passed (3)   Duration  15.64s
```

What happened, step by step. Three transactions increment `0 → 1 → 2 → 3`. The fourth obtains the row lock,
computes `3 + 1`, and Postgres refuses the row before it is written — the backstop. The Postgres error behind
each `500`, from the instances' stderr, **26 times** — 17 + 9, one per `500`:

```
ERROR [ExceptionsHandler] DrizzleQueryError: Failed query: update "promo_codes" set "used_count" = "promo_codes"."used_count" + 1 where "promo_codes"."id" = $1 returning "used_count"
  cause: error: new row for relation "promo_codes" violates check constraint "promo_codes_used_count_range"
  severity: 'ERROR', code: '23514',
  detail: 'Failing row contains (3, LIMIT3, percent, 25, null, 3, 4).',
  constraint: 'promo_codes_used_count_range', routine: 'ExecConstraints'
```

`Failing row contains (3, LIMIT3, percent, 25, null, 3, 4)` is the row it tried to write, column by column in
the table's order: `id 3`, `LIMIT3`, `percent`, `25`, no currency, `max_uses 3`, `used_count 4`; `23514` is
Postgres's error code for a `CHECK` violation and `ExecConstraints` the routine that raised it. The
transaction aborts; the error reaches Nest's default handler; the shopper gets
`500 { "statusCode": 500, "message": "Internal server error" }`. The counter reads `3`. The ledger holds three
rows for the three winners — the fourth never reached step 6. The three winners carry `96750`, the seventeen
losers `129000`. The ledger's `order_id` set equals the winners'. The one-order test stayed green (one
increment never reaches the cap), and `afterAll`'s baseline **held**: counter and ledger agreed at 3, so the
cleanup worked and this shape left no debris. **Every database-side fact a counter-only test could read was
correct, and only the shoppers' responses were wrong.** The reviewer's copy said the same in its own words —
`race:promo FAILED (4)`: `INFO  response shape — 200: 3, 500: 17`; `PASS  exactly 3 × 200`;
`FAIL  exactly 17 × 409 exhausted — every other shopper told no, in words — 0 × 409 exhausted`;
`FAIL  zero 5xx — a guard weakened to an unconditional increment trips the CHECK as 500s while the counter still reads the cap (R2) — 17 × 5xx: 500 {"statusCode":500,"message":"Internal server error"}; …`;
**`PASS  used_count = 3 for LIMIT3`**; **`PASS  exactly 3 promo_redemptions row(s)`**;
**`PASS  the ledger's order_id set equals the 200s'`**; the `ONCEONLY` pair (`0 × 409 exhausted`, `9 × 5xx`);
`FAIL  promo                    exited 1 (1487ms)`. Four failures, every one a response-shape line; every
database line green.

That is the finding the phase adds to the argument, and it is Phase 2's lesson — a UNIQUE index once masked
a broken lock — wearing a CHECK constraint. So the assertion order in every proof of the limit is: every
response is `200` or `409` (*"the load-bearing assertion (R2)"*, the inline comment says); exactly N × `200`;
exactly the rest × `409 exhausted`; **zero `5xx`**; and only then the counter and the ledger, as
corroboration. The CHECK keeps its place — it holds when TypeScript is bypassed, and its lower bound is what
made §6.1's `−6` an error rather than a negative count — but it is the backstop, not the mechanism, and a
proof that reads only the backstop's column proves nothing about the mechanism. One number in that block is
not explained anywhere: the `LIMIT3` race took 8 553 ms under Shape B against 204 ms under Shape A.
Seventeen aborted transactions with a stack trace logged for each is the obvious suspect; it was not
investigated, and this document does not guess.

### 6.3 The lock RED — `lockOrder` without `FOR UPDATE`

**The edit.** In `order-lock.service.ts`, drop `.for("update")` so step 1 is an ordinary `SELECT`.
**Predicted**: for the same-order case, more than one transaction passes step 3 believing no redemption
exists, the second's `INSERT … ON CONFLICT (order_id) DO NOTHING RETURNING order_id` returns zero rows, and
the invariant throw at step 6 answers `500` — "and/or `used_count` above `1`".

```
one order, LIMIT3 x4: raced in 230ms; statuses=[500, 500, 500, 200];
              pids [10098, 10099, 10100, 10101]
  AssertionError: every one of the four must be answered honestly, none a 5xx: {"statusCode":500,"message":"Internal server error"}: expected 500 to be 200
Tests  1 failed | 2 passed (3)   Duration  8.60s
```

All four read the order without a lock, all four see `created`, all four find no ledger row at step 3, all
four reach step 5 and queue on the `promo_codes` row. The first increments `0 → 1`, inserts, reprices,
commits. The second obtains the promo row lock, re-evaluates `1 < 3`, increments to `2` — then its `INSERT`
finds the first's committed row and returns zero rows, which the service treats as what it is: a row appeared
under a lock this transaction believed it held. `PromoRedemptionInvariantError` at `ledger_insert`,
`ROLLBACK`, the increment undone, `500`. The third and fourth the same. Which of the two predicted outcomes
it was is from a reproduction by hand straight after the suite, against the same four instances — one order,
four concurrent `POST`s: 5201 → `200`, 5202–5204 → `500` — and from their stderr:

```
ERROR [PromoController] { msg: 'promo: invariant violated under the order lock; the transaction was rolled back', step: 'ledger_insert', outcome: 'invariant_violated', status_code: 500, detail: 'promo: invariant violated under the order lock at ledger_insert — a promo_redemptions row for order ord_01M2GKW2J13HEP55RBDF3B15E1 appeared while this transaction held its lock and had read none; the order lock discipline was broken somewhere' }
```

`used_count` read **1** afterwards, not more — the "and/or `used_count` above `1`" half of the prediction did
not happen. Each loser did increment the counter; its step-6 throw rolled that increment back with everything
else. The counter was held by the rollback, not by the lock. What the prediction underrated is that I8's
`ON CONFLICT (order_id)` plus the refusal to treat zero rows there as an outcome is a *second* stop that stays
standing when the first is removed — the technical spec calls it "the one rollback path, and it means the lock
discipline was broken", and that is exactly what it did. Three shoppers saw `500`, which is the honest answer
to a broken invariant; the ledger, the counter and the price were all correct afterwards. The twenty-order
tests were unchanged and green: they race distinct orders, so the order lock is not what serialises them —
I7's own row lock is. And **`pnpm race promo` under this RED printed `race:promo passed.`** (200: 3 / 409
exhausted: 17; 200: 1 / 409 exhausted: 9) — it has no same-order scenario and cannot see a missing order lock.
§11 carries that gap.

*Depth: `phase-5-slice-3-the-limit-holds-under-parallelism.md` §5.2 (why the shape comes first), §6 (all
three shapes with their output), §7.1–§7.4 (the four findings); `promo-limit-race.test.ts`'s header;
`scripts/race/README.md`'s `promo` row.*

---

## 7. The reviewer's check, and running it twice

**`pnpm race promo`.** `pnpm race` runs every script in `scripts/race/` against four API instances it
starts; Phases 2 and 3 wrote eight, and this is the ninth, discovered by filename and written in
`create-order.ts`'s shape (the first of the eight): twenty orders created round-robin across four instances, twenty simultaneous `POST …/promo { code: "LIMIT3" }`
in one `Promise.all`, then ten orders and ten of `ONCEONLY`; the same assertion set as the Vitest file,
printed as named `PASS`/`FAIL` lines — `exactly 3 × 200 — the cap's worth, no more`, `exactly 17 × 409
exhausted — every other shopper told no, in words`, `zero 5xx — …`, `no other status at all`, then
`used_count = 3 for LIMIT3 — the counter half of I7`, `exactly 3 promo_redemptions row(s) … — the ledger half
of I8`, `the ledger's order_id set equals the 200s'`, `the 3 winners carry amount_minor 96750 and the other 17
still carry 129000`; exit code 1 on any failure. The database half runs through `openRaceDatabase` when
`DATABASE_URL` is set and prints `SKIP … needs DATABASE_URL` when it is not. Its RED is Shape A and Shape B
above, recorded in `scripts/race/README.md`'s RED table beside the eight checks Phases 2 and 3 wrote. Run
twice back to back today: **3 × 200 / 17 × 409 and 1 × 200 / 9 × 409, both passed**, and `pnpm race` for all
nine checks **9/9**.

**Repeatability locally: the decrement.** Functional spec §2.5's last criterion is that the second run
behaves the same as the first with no manual tidying. Locally that is the harness's cleanup, in `finally`,
after each scenario — one statement placed before the `orders` delete because `promo_redemptions.order_id` is
a real foreign key:

```sql
with gone as (
  delete from promo_redemptions where order_id = any($1::text[]) returning promo_id
), per_promo as (
  select promo_id, count(*)::int as n from gone group by promo_id
)
update promo_codes p set used_count = p.used_count - per_promo.n
from per_promo where p.id = per_promo.promo_id
-- 0 rows updated => none of these orders had a code applied; not an error
```

Delete this run's ledger rows, returning which code each named; group; subtract from each code exactly the
number removed. One statement, so there is no instant at which the ledger has shrunk and the counter has not.
The obvious alternative — recompute `used_count` from `count(*)` of the ledger, or simply zero it — was
rejected for the reason the harness's comment gives: *a cleanup that makes the baseline true is not a cleanup;
it is a test that cannot fail.* If the application drifted during a run — counter 3, ledger 2, which is what a
broken rollback looks like — a recompute writes 2, the delete brings it to 0, and `assertBaseline("after")`
passes on a bug it just erased; the decrement subtracts the two rows the test removed, leaves 1, and the
assertion fails with `sum(used_count) = 1, expected 0`, pointing at a counter that outran its ledger. Proven
live in Slice 1 on rows written by SQL — counter 3 against a ledger of 2 → CTE → 1 / 0 where a recompute
would have written 0 — and then, unplanned, in §6.1 from the other side. The baseline reads the counter with
`coalesce(sum(used_count), 0)` (a `sum()` over an empty table is `NULL`, and whether `NULL` slips past a zero
check depends only on how the check is spelled) and reports counter and ledger as two lines, so a drift is
visible as *which one* moved. Today's proof that the chain holds is R13's order: `pnpm test:e2e` (64), then
`pnpm race promo` twice, then `pnpm test` (**14 files / 120 tests** API, **6 / 69** web) green — each later
run's baseline being the evidence the earlier one cleaned up.

**Repeatability on a deployed shop: the admin reset.** Phase 6 points these scripts at the deployed URL as the
strongest form of the claim — serverless instances share neither kernel nor clock — and a race script takes a
base URL and nothing else; it cannot reach that shop's database. Without a reset, a deployed shop is a one-run
shop: the first run spends `LIMIT3`'s three and `ONCEONLY`'s one, the second is twenty `409`s and proves
nothing. So `POST /api/admin/promo-codes/reset`, behind the admin bearer token, runs
`UPDATE promo_codes SET used_count = 0` — every row, no `WHERE`, no transaction — returns the four codes with
their zeroed counters, and is logged at `warn` because it is the one write in the shop that makes the
counter and the ledger disagree. It **leaves the ledger alone, and that is deliberate**: `orders.amount_minor`
stays discounted after delivery; the code, the list price and the discount a delivered order shows as
«было …» exist only in `promo_redemptions`. Delete the ledger and an order that paid 967,50 ₽ for a 1 290 ₽
item reads `promo: null` — a discount with no code beside it, on the shopper's page and in the shop's books.
The counter is state; the ledger is history. Reset the one, never the other, and accept that after a reset
the counter means "uses since the last reset" while the ledger keeps the truth — the trade `architecture.md`
§9 now records beside `ALLOW_CLIENT_SUPPLIED_ORDER_ID`, in the `supplier_behaviour` family of demo
affordances. The check reaches for it only when it has no database: in `finally` it reads `ADMIN_TOKEN`, calls
the endpoint on the first target, and prints `INFO  counters reset through the admin endpoint; the ledger
keeps the rows — a database was not reachable to clean up`. With no token either, it prints a `SKIP` saying the
counters stay spent and the next run will report `409 exhausted` for every attempt. **Local runs never reach
that branch** — `pnpm race` always has a database, the code comment on the branch says it is unreachable
there, and today's verify grepped both local runs' output for the `INFO` sentence and found nothing. A local
run that called the reset instead would pass its own counter assertion and fail the next suite's baseline on
the ledger — `sum(used_count) = 0` with `promo_redemptions > 0` — which is the harness noticing exactly what
the reset does.

*Depth: `phase-5-slice-3-the-limit-holds-under-parallelism.md` §5.3, §7.2;
`phase-5-slice-1-the-codes-and-the-counter.md` §3.2 (the seed never writes `used_count` either), §3.3;
`architecture.md` §9; `scripts/race/README.md`'s command table, RED table and port row.*

---

## 8. The shopper's page

**The form.** On an order that is waiting for payment, above the two payment buttons: a real
`<form data-promo-form>` with one `<input type="text" name="code" aria-label="Промокод" placeholder="Промокод"
autocomplete="off" autocapitalize="characters" spellcheck="false">` and one `type="submit"` button
«Применить». Rendered only for `status === "created" && order.promo === null`; `null` otherwise — once
applied, the entity's «Промокод» row *is* "shown in its place" (functional spec §2.2 crit 3). A real `<form>`
on a codebase whose storefront has none, because Phase 4's rule is about *decorative* controls: a form whose
only listener cancels is a control pretending to be wired. This one is wired — the `submit` handler is where
the work happens and `preventDefault()` is a line inside it — and the `<form>` is what gives Enter its
meaning without re-implementing implicit submission by hand; the payment buttons are `type="button"` siblings,
never children, so Enter cannot reach them. **No `required`** on the input: the browser's validation bubble is
in the browser's language, and spec 001 §2.8 says every text a shopper reads is Russian; the handler trims
and returns early on empty instead, silently, which is exactly the spec's *"the field simply stays as it is"*.
During the request the button is `disabled` (a disabled button dispatches no click, so a second Enter sends
nothing) and the input is `readOnly`, not `disabled` — disabling a focused element drops focus to `body`, and
a refusal's sentence should land under a field the shopper is still in. What the page sends is
`{"code":"limit3"}` — trimmed, not upper-cased; the normalisation is the shop's, and the code the shop stores
comes back on the order.

**The row.** The order's `<dl>` becomes Товар · Сумма · **Промокод** · Статус · Ключ · Номер заказа: «Сумма»
`967,50 ₽` followed by `<span class="order-details__list-amount">(было 1290 ₽)</span>`, then
`<dt>Промокод</dt><dd data-promo-code="LIMIT3" data-discount-minor="32250">LIMIT3 — скидка 322,50 ₽</dd>`. The
row is gated on `order.promo !== null` and **never on status**, so it survives `paid → delivered` — the
delivered order shows «Ключ выдан», the key, and the promo row beneath the discounted amount, which is §2.3's
fourth criterion in a picture (the screenshots at the end of this section).

**The three sentences, and the fourth outcome with none.** All in one `text` table at the top of the feature,
beside the placeholder and «Применить»:

| The shop answered | The shopper reads | Why |
|---|---|---|
| `422 unknown_code` | «Такого промокода нет» | The shopper can act — check the spelling. The field stays editable with their text in it. |
| `409 exhausted` | «Промокод больше не действует» | The code exists and this order could take it; its uses are spent. The fifth scenario's refusal with a face on it. |
| `404` | «Заказ не найден. Проверьте адрес страницы.» | The page's own sentence for the same situation. |
| `409 not_awaiting_payment`, `409 another_code_applied` | *nothing* — the form asks the poll to re-read | The order moved under this tab; a sentence about the code answers the wrong question. |
| no answer, a `500`, a `200` that is not an order | «Не удалось применить промокод. Проверьте соединение и попробуйте ещё раз.» | The one case where a retry is right. |

`HttpError` gained a `body` for this, read once through a `readBody` that **never throws** — a non-JSON body,
Nest's default envelope, an aborted stream all become `null` and the error still carries its status. R11 is
why that matters beyond the promo: every failed read of the order page's poll passes through the same
function, and one exception leaking from it would skip the `instanceof HttpError` in four consumer files at
once — a non-JSON `404` would turn «Заказ не найден» into «Не удалось загрузить заказ». A `409` is
classified as a promo refusal *before* its reason is read, so a `409` whose body was lost in transit can never
fall through to the generic sentence that invites a retry of something the server has already refused.

**The poll is the one writer.** On success the form has the repriced order in hand — `applyPromo` returns it,
and parsing it is how the form knows the `200` meant what it said — and *discards it*. It calls
`onOrderMayHaveChanged()`, which is the poll's `refreshNow()`, and leaves itself busy. The page already has a
loop reading the order once a second, and the content region has one writer: `showOrder`, fed by that loop.
A second writer means two snapshots racing for the same region — a poll read that left the browser before the
transaction committed lands after the form's paint with `promo: null`, and either the form reaches into the
page's memo or a later read repaints a row that is already there. `refreshNow` has the property that makes the
one-writer rule cheap: if a read is in flight it is *remembered* and run the instant that read lands, never
concurrently. So the stale read lands, the memo suppresses it; the refresh reads the committed view; one
`replaceChildren` paints the row, the new amount, and no form — **exactly one repaint, whichever read carries
the news first.** The form is removed by that repaint, not by itself; left busy and then discarded, the field
cannot be reused by accident to send a second code to an order that already has one.

**The `promoCode` memo.** The page's memo was `{ status, code }` for four phases, and it was correct: nothing
else on an order changed after creation. A code applied to a `created` order moves neither. Forget to add
`promoCode`, and the failure is the one in this slice that produces no evidence of itself: the `POST`
succeeds, the refresh reads the promo back, the memo compares `created === created` and `null === null` and
returns early. The form stays disabled — it was left busy on purpose, waiting for a repaint that now never
comes. The amount stays at the list price. No row. A second Enter does nothing. The shopper who applied a code
sees *nothing happen*, with no error anywhere, until something *else* moves the status — they pay, and the row
appears beside «Оплачен» a minute after it was earned — or they reload, at which point `mountApp` builds the
page from nothing with the memo at `null` and everything is right. So a manual check that reloads between
"apply" and "look" proves nothing, every API test stays green, and the webhook carried `96750` throughout.
The only test that can see it asks for the row *by name* without reloading, and that is T1 — the first of
the six browser tests tabled next.

**The six browser tests and their REDs** — `apps/web/e2e/promo.spec.ts`, `@regression`, real clock, every
test buying through the storefront so the orders fixture captures the id and hands the use back. GREEN first
(`6 passed (10.5s)`), each inversion applied against a `cp`-taken copy, run, quoted, restored and `cmp`'d,
then GREEN again (`6 passed (8.9s)`):

| Test | Claims | Inversion | RED, verbatim from the header |
|---|---|---|---|
| T1 | Enter applies `LIMIT3`: the form precedes the payment controls; row `LIMIT3 — скидка 322,50 ₽`; «Сумма» `967,50 ₽ (было 1290 ₽)`; the form gone; the URL unchanged **and** a `window` marker set before submit still present (R10) | `promoCode` dropped from `RenderedOrder`, from the object literal and from the comparison in `showOrder` | `Expected: "LIMIT3 — скидка 322,50 ₽"` / `Error: element(s) not found` — `toHaveText` on `promoRowSelector`, 10 000 ms |
| T2 | `nope` → «Такого промокода нет»; amount unchanged; the value kept, the field editable | `PromoCodeUnknownError` mapped to `text.exhausted` in `messageFor` | `Expected: "Такого промокода нет"` / `Received: "Промокод больше не действует"` |
| T3 | An empty or whitespace-only submit sends zero `POST …/promo` | the `if (code === "") return;` guard removed from `send()` | `expected zero POST …/promo requests, saw 2: …` / `- Array []` / `+ Array [ "http://localhost:5101/api/orders/ord_…/promo", "http://localhost:5101/api/orders/ord_…/promo" ]` |
| T4 | A reload shows the same row and amounts, and no form | **see below** — the status gate *passed* T4; the inversion that failed it suppresses the row on a page's *first* paint only | `Expected: "LIMIT3 — скидка 322,50 ₽"` / `Error: element(s) not found` — 5 000 ms, immediately after `page.reload()` |
| T5 | Paying delivers «Ключ выдан» with the row and the discounted amount still shown | `renderPromoRow` gated on `order.status !== OrderStatus.Created` in addition to `order.promo` | `Expected: "LIMIT3 — скидка 322,50 ₽"` / `Error: element(s) not found` — 5 000 ms, after the status reached `delivered`; **T4 stayed green in the same run** |
| T6 | `ONCEONLY` applies to one order; a second reads «Промокод больше не действует» | `PromoCodeExhaustedError` mapped to `text.unknown` — T2's mirror | `Expected: "Промокод больше не действует"` / `Received: "Такого промокода нет"` |

**The T4 first-paint finding.** The tech spec's table named an inversion for T5 — gate the row on
`status === "created"` — and none for T4. The natural first try for T4 is T5's, and it fails T5 and *passes*
T4. T5's order moves `created → delivered`, so the poll repaints it and a status-gated row vanishes. T4's
order never leaves `created`: it is applied, the page is reloaded, and the first paint of the new document
builds the row from a `created` order carrying a promo — a status gate on `created` admits it. So the status
gate is not an inversion of what T4 claims. What T4 claims is that the applied state survives a *cold read* —
the page built from nothing, the memo starting at `null` — as opposed to T1's poll-driven repaint of a page
that was already open. The inversion that isolates that is a temporary branch in `showOrder` rendering
`{ ...order, promo: null }` on a page's very first paint and nothing else; only T4 failed, the other five
stayed green in the same run. It sharpens what the memo protects: T1 guards its *later* comparisons, T4 its
*first* one, and neither test can stand in for the other. The tech spec's §4 row now carries it.

**Screenshots.** From the Slice 4 smoke test: `docs/screenshots/005-slice4-task2-promo-applied.png` — order
`ord_01M2GFX0M02G4QCVW4AAJR3S0Q`, «Сумма 967,50 ₽ (было 1290 ₽)», «Промокод LIMIT3 — скидка 322,50 ₽»,
«Ожидает оплаты», the two payment buttons with no field above them. From Slice 4's verify, which landed while
this was written (21:25–21:26) — all three opened and read: `005-promo-codes-with-enforced-limits-applied.png`
and `-delivered-with-promo.png` are one order, `ord_01M2GP1T3GSJTH9F3WP3YZEBSN`; the first shows «967,50 ₽
(было 1290 ₽)», «LIMIT3 — скидка 322,50 ₽», «Ожидает оплаты», «Оплатить успешно» and «Оплата не прошла» and
no field; the second shows the same three lines with «Ключ выдан» and «Ключ LFXC-TNCS-BPCD» — the same key
Phase 4's buy-through screenshot shows, because the claim takes the first unclaimed key by `id` and every
harness cleanup hands it back. `-exhausted.png` is a third order, `ord_01M2GP4WR2MV53E09QZ3EZ6M12`, at
«Сумма 1290 ₽» unchanged and «Ожидает оплаты», the field still holding `ONCEONLY` with the focus ring on it
(`readOnly` kept the focus; the request has ended and the field is editable again), «Применить» beside it,
the red «Промокод больше не действует» beneath, and the two payment buttons below that — `409 exhausted` from a
chair, on the order after `ONCEONLY`'s one use was spent. The same verify read the browser console: **zero
JavaScript errors, and one browser-logged network line** — `Failed to load resource: … 409 (Conflict)` —
which is Chrome's own record of that intentional `ONCEONLY` refusal, written by the browser for every non-2xx
response it fetches, not a line any application code logged. Its other verdict, that the storefront's «Ввести
промокод» is still inert with `inert-controls.spec.ts` unchanged and green, held too, with the suite counts
§9 quotes (64 e2e; 14 / 120 API and 6 / 69 web after).

*Depth: `phase-5-slice-4-the-shopper-enters-a-code.md` §3 (one code from the field to the row, step by
step), §3.1–§3.3 (`required`, the `<form>`, `readOnly`), §4.2 (the one writer), §4.3 (the memo), §5
(`HttpError.body` and the four classes), §6 (the T4 finding).*

---

## 9. What every suite proves, and where

`pnpm test` runs the API suites and then the web unit suite; `pnpm test:e2e` is separate because it needs a
browser and starts servers; `pnpm race` is the reviewer's set. Today's counts are from the verify runs this
document quotes; the per-file counts were re-read from the tree while writing (`grep -c` for `it(` / `test(`).

| Layer | File(s), ports | Count | Can prove | Cannot prove | RED |
|---|---|---|---|---|---|
| **API unit** — Vitest, no database | `apps/api/test/unit/promo-discount.test.ts` | **13** | The four seeded amounts on 1 290 ₽; the clamp; 25 % of 9 999 → 2 500 and 10 % of 5 → 1; trim + upper-case; empty rejected | Anything about a row, a lock or a request | Write-first (`Cannot find module '../../src/promo/promo-code.js'`), then the mutant `discount = 0` → **8 failed**, the five normalisation and kind cases green under it |
| **API acceptance** — one instance | `apps/api/test/acceptance/promo-codes.test.ts`, **5301** | **9** | The four amounts with `promo` set and `list_amount_minor = 129000`; `nope` → 422; ` limit3 ` stored as `LIMIT3`; the same code twice → 200 and one row; a different code → 409; `{ code: "" }` → 400; no such order → 404; a delivered order → 409; `payment_events.amount_minor = 96750` after the simulator; the delivered view still carrying `promo` | The limit under parallelism — `exhausted` is **not exercised here at all**; the budget keeps every test under every code's `max_uses` by construction | Nine inversions in one run, **9 failed in 6.95 s**; reverted, **9 passed in 7.43 s**; the baseline held through the RED run |
| **API concurrency** — four processes | `apps/api/test/concurrency/promo-limit-race.test.ts`, **5201–5204** | **3** | `LIMIT3` ×20 → 3 / 17 / zero 5xx, the ledger's `order_id` set equal to the winners', the prices, more than one pid; `ONCEONLY` ×10 → 1; one order ×4 → four identical `200`s, one row, counter +1 | That the one-process count would be 3 (arithmetic, not measured this phase) | Shape A, Shape B, the lock RED — §6, Appendix A |
| **The reviewer's copy** | `scripts/race/promo.ts`, `pnpm race promo`, **4601–4604** | 2 scenarios | The same assertion set as the race test, printed line by line by name, against any base URL; runnable twice | A missing order lock — it never sends two requests for one order | Shape A and Shape B, in `README.md`'s RED table; `passed` under the lock RED |
| **Web unit** — Vitest, `fetch` stubbed | `apps/web/src/entities/order/api/order-api.test.ts` | **13** | `readPromo`'s null / absent / valid / malformed cases; `applyPromo`'s status-to-class mapping including a `409` with an HTML body | Anything painted | Write-first: before `readPromo` existed the two null cases failed on `toBe(null)` against `undefined` |
| **e2e** — Playwright, one Chromium, `workers: 1`, `retries: 0` | `apps/web/e2e/promo.spec.ts`, **5101 / 5102** | **6** | The form, the row, the reload, the delivery with the row, the two refusal sentences, the empty submit, the `window` marker | The counter's arithmetic under load — `used_count` is never read here | Six inversions, one per test — §8 |
| **Russian** — reads the source | `apps/api/test/unit/order-status-russian-labels.test.ts`, third `describe` | **5** new (13 in the file) | The six `text` entries, all Cyrillic, the three refusals distinct, `notFound` identical to the page's, and **no `required`** on the input | — | — |

**The whole set, today.** `pnpm test` — **14 files / 120 tests** (API) and **6 files / 69 tests** (web),
green twice. `pnpm test:e2e` — **64** (58 + 6); the full run once failed on `buy-through.spec.ts`'s 15-second
delivery wait under a machine load average of 14–30 (runnable processes; the figure `uptime` prints) — the
simulated supplier timed out, and the fixture's teardown
then raced the server's still-running continuation, which claimed a key after the order had been deleted;
cleaned by hand; a harness ordering gap, not a product bug, and §11 carries it. `pnpm race` — **9/9**.
`pnpm race promo` twice — passed, passed, the admin reset never called. And one flake outside this phase:
`key-claim-race.test.ts` (spec 002) failed **5/7** when batched under a load of 12–16 and passed alone and at
a load of about 9 — the same supplier-timeout mechanism; the non-promo source changes in the tree were
verified comment-only.

**R13 — the chain that makes the set trustworthy.** The API suites assert `orders = 0`, `unclaimed = 50` and,
since this phase, `promo_codes = 4`, `coalesce(sum(used_count), 0) = 0`, `promo_redemptions = 0` *before* they
run. The e2e buys real orders and spends real uses — T1, T4 and T5 each apply `LIMIT3`, T6 applies `ONCEONLY`
twice — and hands every one back in its fixture's teardown through the same CTE as §7, duplicated in
`apps/web/e2e/support/db.ts`. The proof is the order of runs: e2e, then race, then `pnpm test`; a leaked
redemption or counter fails the API suites' precondition rather than passing silently. That is what lets four
suites share one seeded Postgres with `workers: 1` and no reset between them, and why "run two of any suite"
would find `ONCEONLY` spent by run one without it.

*Depth: `technical-considerations.md` §4; `architecture.md` §7; each file's header.*

---

## 10. Assumptions a reviewer might challenge

The ten in `technical-considerations.md` §5 and the alternatives the slice walkthroughs argued against. Each
with its one-sentence defence and what flipping it would take.

| # | Assumption | The defence | To flip it |
|---|---|---|---|
| 1 | **`PRIMARY KEY (order_id)`** on the ledger, not the architecture's `UNIQUE (promo_id, order_id)` | The original admitted a row the functional spec forbids: two *different* codes on one order — a second discount on an already-discounted price. One code per order means the key is `(order_id)` alone; the stronger key implies the weaker (a table with at most one row per `order_id` has at most one per `(promo_id, order_id)`), so every guarantee I8 was written for still holds; `architecture.md` carries the amendment inline in three places, and the negative proof was the row the old key would have accepted — `promo_redemptions_pkey` | A composite key and a rule for stacking discounts the brief does not define |
| 2 | **A use is spent at apply time**, never returned | Functional spec §2.4's last criterion: an abandoned order does not return a use. The alternative — reserve on apply, consume on payment, release on expiry — needs a reservation state, a sweeper and a second transaction on the hot row; the brief asked for a limit that holds, not a limit that is fair | A `reserved_until` column, a sweeper, and the fifty-webhook race's staged amounts revisited |
| 3 | **The admin reset** exists, zeroes the counter and leaves the ledger | It is behind the admin token, the shop never calls it, local runs never call it (grepped today), and its existence is the price of a race check that can run twice against a URL — the same price the eight other checks pay with `ALLOW_CLIENT_SUPPLIED_ORDER_ID` and the supplier behaviour knob. Deleting the ledger would erase what paid orders paid. After it the two disagree on purpose, and `architecture.md` §9 says so before a reviewer finds it (§7) | Remove it and accept that the deployed shop is a one-run shop |
| 4 | **R6 — the apply-vs-pay window is documented, not closed** | The simulator reads `orders.amount_minor` without a lock and then delivers the webhook; a code applied to a `created` order in the milliseconds between that read and `markPaid` is applied to a list-price payment, and the processor never compares amounts — a Phase 1 decision ("settlement belongs to processing"). The status guard closes every other ordering; the window is one simulated-provider round trip. The honest fix is named: compare `payment_events.amount_minor` to `orders.amount_minor` under the order lock in the processor and route a mismatch to `payment_failed` — it changes the payment path and the fifty-webhook race's staged amounts, and the functional spec's own §3 puts it out of this phase | The comparison in the processor, one new `payment_failed` reason, and the Phase 2 race's staged amounts |
| 5 | **Increment before the two writes**, not last before `COMMIT` | Both are correct for the limit; §5's five costs of the sentinel are the argument for the shape chosen, at the admitted price of holding the hot row for two more small statements | Move step 5 after step 7 and throw a sentinel for the refusals |
| 6 | **`422` for an unknown code, `409` for exhausted, `{ reason }` not `{ error }`** | `422` is the sense `POST /api/orders` already uses for a SKU the shop does not sell; `409` follows `out_of_stock` (the state is the counter; the conflict is that it is full); `410 Gone` would say the target resource is gone, which is false — the order exists and another code is applicable; `error` is already Nest's field for the reason *phrase* | Three literals in `promo.types.ts` and the web's mapping |
| 7 | **`200` for the same code twice**, decided from the ledger under the order lock | Idempotency the page relies on — a double-click, a retry after a lost response — with the hot `promo_codes` row never touched; a `409` would make a retry look like a conflict | Return `409` from step 3's same-code branch |
| 8 | **Half-up rounding** to the nearest kopeck | What a price tag says and a shopper reproduces on paper; the brief is silent (R8); the unit file pins the cases that tell the modes apart | `Math.floor`, and two unit cases |
| 9 | **The page has no arithmetic and no optimistic paint** | §4 and §8: two calculators drift; the clamp would need reproducing; seventeen of twenty shoppers would see a discount appear and vanish; the wire carries no `kind` or `value` to compute from | Put the definition on the wire — the first step toward a page that sends a number |
| 10 | **The four alternatives to the conditional `UPDATE`**, in one paragraph | *`SERIALIZABLE`* works and the architecture rejected it in Phase 1 for a reason sharper here than anywhere: the guarantee moves out of the statement into a retry loop the reader cannot see, and under this load seventeen of twenty transactions would abort and retry for a result the conditional `UPDATE` reaches with zero aborts. *An advisory lock* (`pg_advisory_xact_lock(promo_id)`) around a read-then-increment works, costs a round trip, hides the lock from the schema, and makes the read-then-increment *look* safe to the next person, who will drop the lock call — the conditional `UPDATE` cannot be made unsafe by deleting a line around it, only by editing the statement. *`COUNT(*)` over the ledger* is the result of a scan, not a thing with a lock; making it safe means locking something — a `promo_codes` row, which is the counter under another name; the table, which serialises every code behind every other; or `SERIALIZABLE`, above. *Redis `INCR`* is atomic in a different process from the one that holds the ledger, the order and the price; the increment and the ledger row stop being one transaction, and a crash between them is drift by construction. The database already has a row that can be incremented atomically under the same commit as the ledger row | Each is a page of code and a new failure mode; none is one line |
| + | **`pnpm race promo` has no same-order scenario** | It is named for adversarial scenario 5 — a limit under parallel requests from many shoppers — and that is what it proves; the double-click criterion is a different race, on I4 rather than I7, guarded by the Vitest third test in the commands a reviewer runs (§6.3) | A third scenario in `promo.ts` — one order, one `POST` per instance, four `200`s with identical bodies, one row, counter +1 — and the README's RED row recording the lock RED against it; cheap, and not added because the task did not ask |
| + | **Only one process count was measured** — four | The 20-vs-9 table in architecture §7 is the only comparison against one; this phase did not run Shape A against one process to record the `3`; the claim that it would be 3 is arithmetic from the `max: 1` pool | One more RED run with `PROCESS_COUNT = 1` |

---

## 11. What is not finished

- **R6 is open by decision.** The apply-vs-pay window — assumption 4 above — is in `architecture.md` §9 as a
  known trade-off; closing it is out of the phase's scope. Slice 6's coverage table is expected to carry it as
  a "not covered anywhere by name" row, and should say so rather than fake it.
- **The lock gap in the reviewer's copy.** `pnpm race promo` stayed `passed` with `FOR UPDATE` removed from
  the order lock (§6.3); only the Vitest third test guards the same-order case. Named, with what would add it.
- **The e2e-cleanup-vs-continuation race.** Once today, under a machine load of 14–30, the simulated supplier
  timed out inside `buy-through.spec.ts`'s 15-second delivery wait; the fixture's teardown then deleted the
  order while the server's continuation was still running, and the continuation claimed a key after the
  order was gone. Cleaned by hand. A harness ordering gap — the teardown does not wait for a settled state
  before it deletes — not a product bug; the API suites were green after.
- **The `key-claim-race` load flake.** Spec 002's race failed 5/7 when batched under a load of 12–16 and
  passed alone and at a load of about 9 — the same supplier-timeout mechanism. Nothing in this phase touched
  its path; the non-promo source changes in the tree were verified comment-only.
- **Slice 4's verify finished while this was written, and passed.** Its three screenshots landed at
  21:25–21:26 and are described in §8, and its task was ticked in `tasks.md` by 21:33. The suite counts it
  produced are the ones §9 quotes (64 e2e; 14 / 120 API and 6 / 69 web after); `inert-controls.spec.ts` was
  unchanged and green; and its console read zero JavaScript errors and one browser-logged network line —
  Chrome's own `Failed to load resource: … 409 (Conflict)` for the intentional `ONCEONLY` refusal, not a line
  from application code (§8). Nothing about it is outstanding.
- **The tree has moved since this document's evidence window.** Between 21:36 and 21:38 — after the window
  §12 names — `apps/api/test/acceptance/promo-codes.test.ts` gained a tenth `it(` (an abandoned order's use
  still counts) and `apps/web/e2e/promo.spec.ts` a **T7** (a delivered order that never carried a code shows
  no field): Slice 6 beginning. Every count in §1, §9 and §12 is the window's — 9 and 6 — and every RED
  quoted is unchanged in the headers; Slice 6's report will carry the new totals and their runs. This
  document does not quote a run it did not see.
- **The Slice 6 acceptance pass is still to come.** The 31-row coverage table, `@spec` on every new file,
  `@regression` per the convention, the three-suite run in R13's order with every count and duration, and
  `phase-5-slice-6-acceptance.md`. The counts in §9 are this document's evidence window, not Slice 6's report.
- **Shape B's 8 553 ms** is recorded and not explained (§6.2).
- **The one-process `3` is arithmetic, not a measurement** (§10's last row).
- **The harness lift.** `apps/web/e2e/support/db.ts` still duplicates the API harness's statements — now
  seven — and still names the `@game-shop/db/testing` subpath as the follow-up; both files also still carry
  their original `@spec` tags (`001` and `004`) while holding spec 005's statement.
- **The operator's token form keeps `required`.** Phase 3's, not this phase's; the shopper's field refuses it
  for the Russian rule, and spec 001 §2.8's last line extends that rule to the operator's view. An
  inconsistency worth a line in whichever phase next opens that file.
- **The small items each slice reported, as they stand in the tree today.** *Closed since* — re-checked by
  `grep` while writing: Slice 1's "spec residue" (tech spec §2.3, R5 and R15 once said the local cleanup
  "recomputes from the ledger"; all three now say it decrements); Slice 2's five stale sentences (the
  repricing header's "the webhook's verdict compares", the simulator's "export list is one item long", the
  view service's "three statements long", the transaction header's "two of them write", and R6's pointer at an
  architecture entry that did not exist — §9 now has it); Slice 4's two ("fixed at creation" in the page's memo
  comment now reads "and the amount moves only when the promo does"; the R10 reload URL now reads
  `/order/ord_x?code=…` in the form, the e2e and the spec); the T4 finding is in the tech spec's §4 row; and
  `architecture.md` §7's browser-test rows now carry this phase's counts beside Phase 4's (6 files / 69 web
  unit tests; ten spec files / 64 e2e) — amended at 21:35, the minute this document first closed.
  *Still open* — `tasks.md`'s Slice 3 task 1 still carries the Shape A prediction as "twenty `200`s, twenty
  rows" where the measurement was nine and eleven; `tasks.md`'s Slice 1 task 3 and tech spec §4 describe the
  unit RED as "the four examples fail" where the run recorded eight.
- **The Phase 4 manual check is still outstanding.** `phase-4.md` §6's placeholder — the one-minute real-Chrome
  back/forward-cache verdict that covers the banner's restart and Купить's re-enable after Back — is still
  unfilled, and nothing in this phase changes that.
- **Nothing from Phase 5 is committed beyond `4b5c18f`.** HEAD is `4b5c18f` ("Spec 005: promo codes with
  enforced limits (Phase 5)"); `git status` showed 57 changed paths at 21:25, 23 of them untracked, including
  the whole of `apps/api/src/promo/`, the admin reset, the race test, the acceptance file, the e2e spec, the
  four slice walkthroughs and this document.
- **Out of scope by design:** entering a code anywhere but the order page; removing or replacing an applied
  code; returning a use on abandonment; expiry dates, per-shopper limits, minimum amounts, combining codes;
  creating or editing codes; a discount on the storefront's shown prices; public deployment and the root
  `README.md` (Phase 6).

---

## 12. Where the evidence lives

| Slice | Walkthrough | Read it for | Specs |
|---|---|---|---|
| 1 — The codes and the counter | `phase-5-slice-1-the-codes-and-the-counter.md` | Two columns that must agree and only one is the mechanism; the seed's third `ON CONFLICT` shape; the cleanup that decrements; the seven negative schema proofs and the 1 472 ms block; the migrator that splits on a substring; `serial` vs `bigint`; `sum(used_count) = 2, expected 0` | `test/unit/promo-discount.test.ts` (13), both `support/db.ts` |
| 2 — The shop decides the price | `phase-5-slice-2-the-shop-decides-the-price.md` | The eight steps with every emitted statement; the sentinel's five costs; the `max: 1` self-deadlock and the three places its comment lives; the branded kopeck; the smoke test to `payment_events` | `test/acceptance/promo-codes.test.ts` (9, port 5301) |
| 3 — The limit holds under parallelism | `phase-5-slice-3-the-limit-holds-under-parallelism.md` | The race and its replacement, slowly; I6 beside I7; four processes and the waves; the shape before the counter; Shape A, Shape B and the lock RED with their output; the `−6`; the second stop; the reviewer's copy and the reset | `test/concurrency/promo-limit-race.test.ts` (3, ports 5201–5204), `scripts/race/promo.ts` |
| 4 — The shopper enters a code | `phase-5-slice-4-the-shopper-enters-a-code.md` | One code from the field to the row; `required`, the `<form>`, `readOnly`; the one writer; the memo; `HttpError.body` and R11; the T4 finding; the operator's `required` | `entities/order/api/order-api.test.ts` (13), `order-status-russian-labels.test.ts` (+5), `e2e/promo.spec.ts` (6, ports 5101 / 5102) |

Requirements: `context/spec/005-promo-codes-with-enforced-limits/functional-spec.md` (§1, §2.1–§2.7, §3)
and `technical-considerations.md` (§1's four decisions, §2.1–§2.5, §3 R1–R15, §4, §5). The assignment's
words: `packages/db/src/fixtures/promo-codes.ts`; `context/product/product-definition.md` §1.4, §2.1; the
phase's line in `context/product/roadmap.md`. The invariants: `context/product/architecture.md` §3 (I4, I6,
I7, I8), §3.1, §7, §9. The first instance of the argument: `phase-2.md`, `slice-7-proving-the-race.md`.

**On evidence:** what was run fresh while writing this document, against the tree as it stood between 21:25
and 21:33 on 14 September 2026 — with Slice 4's verify driving a browser against `src/` and the database in
the same window, and ticking its task in `tasks.md` before this document closed — with no server started, no
port bound, no database touched, and no file outside `docs/walkthrough/phase-5.md` modified. `pnpm --filter @game-shop/api run typecheck` — `tsc --noEmit`, exit 0.
`grep -c` for `it(` / `test(` — `promo-limit-race.test.ts` 3, `promo-codes.test.ts` 9,
`promo-discount.test.ts` 13, `order-api.test.ts` 13, `order-status-russian-labels.test.ts` 13,
`promo.spec.ts` 6 (`T1`–`T6` by name) — the same `grep` at 21:40, during the §2.6 review, read 10 and 7 for
the two files Slice 6 had by then touched (§11). `find` — 14 test files under `apps/api/test`, 6 under
`apps/web/src`, 10 spec files under `apps/web/e2e`. `grep -n "lt(promoCodes.usedCount, promoCodes.maxUses)"` over the
redemption service — one occurrence, step 5; `grep -n 'for("update")'` over `order-lock.service.ts` — present,
the statement the lock RED removed. `grep -n "counters reset through the admin endpoint"` — one occurrence,
`scripts/race/promo.ts`. `grep -n "race:promo"` over `package.json` — present. The four stale sentences of
Slice 2 and the two of Slice 4 grepped for by their text — absent from the tree; the R10 URL reads `?code=…`
in all five places; the tech spec's `recompute` mentions all say "never". `ls docs/screenshots/005-*` —
four files: the smoke test's and all three verify names; the three verify files opened and read, their
contents as §8 describes. `git rev-parse --short HEAD` — `4b5c18f`; `git status --short` — 57 paths, 23
untracked.

Everything else is quoted from the four slice walkthroughs, the four test headers, the README's `promo` row
and today's agent reports, never re-run: every RED line in §6, §8 and Appendix A; every suite count and
duration in §1 and §9; the pids; the 20-vs-9 table; the seven negative proofs; the `curl` walk in §4; the
`pnpm race promo` counts; the e2e and `key-claim-race` flakes and the loads they occurred under.
`pnpm test`, `pnpm test:e2e`, `pnpm race` and `pnpm race promo` were not run for this document: all four bind
ports or write to the shared database while Slice 4's verify is working in the same tree.

---

## Appendix A — every RED line, quoted

Every deliberate breakage across the four files, with the failing line verbatim from the file's own header (or
the README's row), so a reviewer can find each in one place. Line references inside quoted Vitest output are
the files' line numbers at run time; the headers have grown since.

### A.1 `apps/api/test/acceptance/promo-codes.test.ts` — nine inversions, one run

```
node scripts/with-env.ts pnpm --filter @game-shop/api exec vitest run test/acceptance/promo-codes.test.ts
→ Test Files  1 failed (1)  /  Tests  9 failed (9)  /  Duration  6.95s
```

1. `AssertionError: LIMIT3: the amount to pay: expected 96750 to be 129000 // Object.is equality`
2. `AssertionError: POST .../promo { code: "nope" } -> 422: expected 422 to be 200 // Object.is equality`
3. `AssertionError: the stored code is the normalised (trim + upper-case) form: expected 'LIMIT3' to be ' limit3 ' // Object.is equality`
4. `AssertionError: exactly one ledger row, not two: expected 1 to be 2 // Object.is equality`
5. `AssertionError: POST .../promo { code: "GG500" } on an order carrying LIMIT3 -> 409: expected 409 to be 200 // Object.is equality`
6. `AssertionError: POST .../promo {"code":""} -> 400: expected 400 to be 200 // Object.is equality`
7. `AssertionError: POST .../promo on a nonexistent order -> 404: expected 404 to be 200 // Object.is equality`
8. `AssertionError: POST .../promo on a delivered order -> 409: expected 409 to be 200 // Object.is equality`
9. `AssertionError: payment_events.amount_minor equals the discounted amount, not the list price: expected 96750 to be 129000 // Object.is equality`

Reverted: `9 passed, 0 failed, 7.43s`. The baseline held through the RED run (`products=12, keys_total=50,
keys_unclaimed=50, orders=0, payment_events=0, deliveries=0, promo_codes=4, promo_used_count=0,
promo_redemptions=0` by a raw read straight after).

### A.2 `apps/api/test/concurrency/promo-limit-race.test.ts` — three shapes

**Shape A, run 1** (statuses in request order):

```
LIMIT3 x20:   raced in 204ms; statuses=[200, 200, 200, 200, 409, 200, 200, 200, 409, 200, 200, 409, 409, 409, 409, 409, 409, 409, 409, 409]  →  9 × 200, 11 × 409; used_count = 3, NINE promo_redemptions rows (pids [9204, 9205, 9206, 9207])
ONCEONLY x10: raced in 112ms; statuses=[200, 200, 200, 200, 409, 409, 409, 409, 409, 409]  →  4 × 200, 6 × 409; used_count = 1, FOUR rows
error: new row for relation "promo_codes" violates check constraint "promo_codes_used_count_range"
 ❯ cleanupTestOrders test/concurrency/support/db.ts:296:3
 ❯ test/concurrency/promo-limit-race.test.ts:446:9        (and :529:9)
AssertionError: precondition: LIMIT3 unused before this test: expected 3 to be +0 // Object.is equality
- Expected  0     + Received  3                           (:540:80)
Error: database is not at the seeded baseline after this suite's own cleanup:
  - orders = 30, expected 0
  - promo_codes sum(used_count) = 4, expected 0
  - promo_redemptions = 13, expected 0
```

**Shape A, run 2** (the cleanup's throw caught temporarily, in the test file only):

```
LIMIT3 x20:   raced in 1114ms; statuses=[200, 200, 200, 200, 200, 200, 200, 200, 409, 200, 409, 409, 200, 409, 409, 409, 409, 409, 409, 200]  →  11 × 200, 9 × 409
  AssertionError: exactly three 200s — the limit, not a race artefact: expected [ { order: { …(5) }, …(1) }, …(10) ] to have a length of 3 but got 11
  - Expected  3     + Received  11                        (:401:80)
ONCEONLY x10: raced in 503ms; statuses=[200, 200, 200, 200, 409, 409, 409, 409, 409, 409]  →  4 × 200, 6 × 409
  AssertionError: exactly one 200: expected [ { order: { …(5) }, …(1) }, …(3) ] to have a length of 1 but got 4
  - Expected  1     + Received  4                         (:493:44)
afterAll: orders = 30, sum(used_count) = 4, promo_redemptions = 15.
```

**Shape B:**

```
LIMIT3 x20:   raced in 8553ms; statuses=[500, 200, 200, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 200]  →  3 × 200, 17 × 500, 0 × 409 (pids [9885, 9886, 9887, 9888])
ONCEONLY x10: raced in 365ms; statuses=[200, 500, 500, 500, 500, 500, 500, 500, 500, 500]  →  1 × 200, 9 × 500, 0 × 409
AssertionError: every response must be 200 or 409, never anything else: got 500 {"statusCode":500,"message":"Internal server error"}: expected [ 200, 409 ] to include 500      (:390:13 and :482:13)
Tests  2 failed | 1 passed (3)   Duration  15.64s
ERROR [ExceptionsHandler] DrizzleQueryError: Failed query: update "promo_codes" set "used_count" = "promo_codes"."used_count" + 1 where "promo_codes"."id" = $1 returning "used_count"
  cause: error: new row for relation "promo_codes" violates check constraint "promo_codes_used_count_range"
  severity: 'ERROR', code: '23514',
  detail: 'Failing row contains (3, LIMIT3, percent, 25, null, 3, 4).',
  constraint: 'promo_codes_used_count_range', routine: 'ExecConstraints'
```

**The lock RED:**

```
one order, LIMIT3 x4: raced in 230ms; statuses=[500, 500, 500, 200]; pids [10098, 10099, 10100, 10101]
  AssertionError: every one of the four must be answered honestly, none a 5xx: {"statusCode":500,"message":"Internal server error"}: expected 500 to be 200 // Object.is equality
  - Expected  200   + Received  500                       (:571:13)
Tests  1 failed | 2 passed (3)   Duration  8.60s
ERROR [PromoController] { msg: 'promo: invariant violated under the order lock; the transaction was rolled back', step: 'ledger_insert', outcome: 'invariant_violated', status_code: 500, detail: 'promo: invariant violated under the order lock at ledger_insert — a promo_redemptions row for order ord_01M2GKW2J13HEP55RBDF3B15E1 appeared while this transaction held its lock and had read none; the order lock discipline was broken somewhere' }
ERROR [ExceptionsHandler] PromoRedemptionInvariantError: promo: invariant violated under the order lock at ledger_insert — …    (×3, one per loser)
```

Between shapes and at the end: `src/` byte-identical by `cmp`; `3 passed`, 9.40 s; `pnpm race promo` passed
(3 × 200 / 17 × 409; 1 × 200 / 9 × 409); baseline orders 0 / `sum(used_count)` 0 / `promo_redemptions` 0 /
50 keys.

### A.3 `scripts/race/README.md`'s `promo` row — `pnpm race promo` under the same shapes

**(a) Shape A:**

```
INFO  response shape — 200: 9, 409 exhausted: 11
FAIL  exactly 3 × 200 — the cap's worth, no more — 9 × 200
FAIL  exactly 17 × 409 exhausted — every other shopper told no, in words — 11 × 409 exhausted
PASS  used_count = 3 for LIMIT3 — the counter half of I7 — used_count = 3
FAIL  exactly 3 promo_redemptions row(s) among this run's 20 orders, all for LIMIT3 — the ledger half of I8 — 9 row(s)
INFO  response shape — 200: 3, 409 exhausted: 7
FAIL  exactly 1 × 200 — the cap's worth, no more — 3 × 200
FAIL  exactly 9 × 409 exhausted — every other shopper told no, in words — 7 × 409 exhausted
PASS  used_count = 1 for ONCEONLY — the counter half of I7 — used_count = 1
FAIL  exactly 1 promo_redemptions row(s) among this run's 10 orders, all for ONCEONLY — the ledger half of I8 — 3 row(s)
error: new row for relation "promo_codes" violates check constraint "promo_codes_used_count_range"
  detail: 'Failing row contains (3, LIMIT3, percent, 25, null, 3, -6).'
  at async cleanupTestOrders (…/apps/api/test/concurrency/support/db.ts:296:3)
FAIL  promo                    exited 1 (1838ms)
race: 0/1 passed against 4 instance(s).
```

**(b) Shape B** — `race:promo FAILED (4)`:

```
INFO  response shape — 200: 3, 500: 17
PASS  exactly 3 × 200 — the cap's worth, no more — 3 × 200
FAIL  exactly 17 × 409 exhausted — every other shopper told no, in words — 0 × 409 exhausted
FAIL  zero 5xx — a guard weakened to an unconditional increment trips the CHECK as 500s while the counter still reads the cap (R2) — 17 × 5xx: 500 {"statusCode":500,"message":"Internal server error"}; 500 {"statusCode":500,"message":"Internal server error"}; 500 {"statusCode":500,"message":"Internal server error"}; …
PASS  used_count = 3 for LIMIT3 — the counter half of I7 — used_count = 3
PASS  exactly 3 promo_redemptions row(s) among this run's 20 orders, all for LIMIT3 — the ledger half of I8 — 3 row(s)
PASS  the ledger's order_id set equals the 200s' — the responses and the database name the same winners — …
INFO  response shape — 200: 1, 500: 9
FAIL  exactly 9 × 409 exhausted — every other shopper told no, in words — 0 × 409 exhausted
FAIL  zero 5xx — … (R2) — 9 × 5xx: 500 {"statusCode":500,"message":"Internal server error"}; …
PASS  used_count = 1 for ONCEONLY — the counter half of I7 — used_count = 1
PASS  exactly 1 promo_redemptions row(s) among this run's 10 orders, all for ONCEONLY — the ledger half of I8 — 1 row(s)
FAIL  promo                    exited 1 (1487ms)
race: 0/1 passed against 4 instance(s).
```

**Under the lock RED:** `race:promo passed.` (200: 3 / 409 exhausted: 17; 200: 1 / 409 exhausted: 9) — the
check races distinct orders only and cannot see a missing order lock.

### A.4 `apps/web/e2e/promo.spec.ts` — six inversions, one at a time

GREEN first: `6 passed (10.5s)`. Then:

- **T1** — `promoCode` dropped from `RenderedOrder`, the object literal and the comparison in `showOrder`:
  `Expected: "LIMIT3 — скидка 322,50 ₽"` / `Error: element(s) not found` (`toHaveText` on `promoRowSelector`, 10000ms timeout).
- **T2** — `PromoCodeUnknownError` mapped to `text.exhausted`:
  `Expected: "Такого промокода нет"` / `Received: "Промокод больше не действует"`.
- **T3** — the `if (code === "") return;` guard removed from `send()`:
  `expected zero POST …/promo requests, saw 2: …` / `- Array []` / `+ Array [ "http://localhost:5101/api/orders/ord_…/promo", "http://localhost:5101/api/orders/ord_…/promo" ]`.
- **T4** — the promo row suppressed on a page's very first paint only (`isFirstPaintRedTemp = rendered === null` in `showOrder`; the status gate first tried *passed* T4):
  `Expected: "LIMIT3 — скидка 322,50 ₽"` / `Error: element(s) not found` (`toHaveText` on `promoRowSelector`, 5000ms timeout, immediately after `await page.reload();`). Only T4 failed; T1/T2/T3/T5/T6 stayed green in the same run.
- **T5** — `renderPromoRow` gated on `order.status !== OrderStatus.Created` in addition to `order.promo`:
  `Expected: "LIMIT3 — скидка 322,50 ₽"` / `Error: element(s) not found` (`toHaveText` on `promoRowSelector`, 5000ms timeout, after the status reached `delivered`); T4 stayed green in the same run.
- **T6** — `PromoCodeExhaustedError` mapped to `text.unknown`:
  `Expected: "Промокод больше не действует"` / `Received: "Такого промокода нет"`.

Every edit reverted and `cmp`'d against its pre-edit copy; GREEN again: `6 passed (8.9s)`.

### A.5 The two unit files — recorded in the slice walkthroughs, not in the files' headers

- `apps/api/test/unit/promo-discount.test.ts` (Slice 1 §4, quoting the task agent's run): write-first,
  `Cannot find module '../../src/promo/promo-code.js'`; then the mutant `discount = 0` — **8 failed**: the four
  seeded examples (`116100 → 129000`, `79000 → 129000`, `96750 → 129000`, `64500 → 129000`), the clamp
  (`30000 → 0`), R8's case (`2500 → 0`) and the two remaining rounding cases, while the five normalisation and
  kind cases stayed green.
- `apps/web/src/entities/order/api/order-api.test.ts` (its own header, as a description rather than a quoted
  line): before `readPromo` existed, `toOrder` did not set the field and the two null cases failed on
  `toBe(null)` against `undefined`.
