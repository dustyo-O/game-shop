# Phase 5 · Slice 2 — The shop decides the price

> A code can now be applied. `POST /api/orders/:orderId/promo` with `{ "code": " limit3 " }` on a 1 290 ₽ order answers `200` with the order repriced to `96750` kopecks, the ledger row written, `LIMIT3`'s counter one higher — and when the shopper pays, the payment simulator reads the same column it has always read and the webhook arrives carrying `96750`. The payment path did not change by a line; the price it charges did. What exists after this slice is the one transaction the whole phase is about, the endpoint that reaches it, the order view carrying the applied code, and the proof — by hand, against a running shop — that the discounted amount goes all the way to `payment_events`.
>
> Three things carry the slice, and each one is an ordering rather than a mechanism. **Every refusal is decided before either write.** The transaction runs its five steps that can say no — the order lock, the status, the ledger row, the code lookup, the conditional `UPDATE` — ahead of the two statements that only write, so an expected refusal is a value the transaction *returns* after committing nothing, and the only `throw` left is an invariant that cannot fail while the lock is held. **The view is read after `COMMIT`.** The pool is `max: 1` per instance; a transaction holds that one connection for its whole body; a pooled read from inside it waits for itself, forever, until a ten-second timeout that names the pool and not the cause. **The price is the shop's.** The request carries one string; every number is computed from the code's row and from `orders.amount_minor` read under the order lock, written once to that column while the order is still `created`, with the list price and the discount kept on the ledger beside it.
>
> Reading the delivered work found five stale sentences, none in the transaction itself: a header in the repricing service that says the webhook's verdict compares amounts (it does not — R6 says so, and so does the webhook controller), a paragraph in the payment simulator that still counts `OrdersModule`'s export list at one (it is six), a "three statements long" in the view service (the transaction runs six), a risk row that points at an architecture entry that has not been written, and a step count in the transaction's own header that calls the conditional `UPDATE` "the first write" three lines after saying only two statements write. All five are listed at the end with the correction; none was edited, because another agent was running the API from the tree while this was written.

---

## 1. What actually shipped

| # | Change | Where | Size |
| --- | --- | --- | --- |
| 1 | The redemption transaction: eight steps in the technical spec's order, six SQL statements, every emitted statement quoted beside its Drizzle call, one typed invariant error and no other throw | `apps/api/src/promo/promo-redemption.service.ts` | One class, one method; the header argues the ordering, the isolation level, the lock order and the no-read rule |
| 2 | The endpoint: `POST /api/orders/:orderId/promo`, body `{ code }`, `@HttpCode(200)`, the view read after `COMMIT`, a `switch` with `assertNever`, one log line per request | `apps/api/src/promo/promo.controller.ts` | One handler; `400` for a body that is not `{ code: string }` or is empty after trimming, `404` in Nest's envelope, `{ reason }` with `409`/`422` for the four refusals |
| 3 | The shapes: `ApplyPromoRequest`, the seven-member `PromoRedemptionOutcome` union, `PromoRefusalReason`, and `promoRefusal(reason)` building status and body together | `apps/api/src/promo/promo.types.ts` | One `switch`; the return type admits `409` and `422` and nothing in the `5xx` family |
| 4 | The module: imports `DatabaseModule` and `OrdersModule`, exports nothing, registered in `AppModule` with the module-distance note | `apps/api/src/promo/promo.module.ts`, `apps/api/src/app.module.ts` | Two imports, one controller, one provider |
| 5 | The reprice: `OrderRepricingService.applyDiscount(tx, orderId, amountToPayMinor)` — the one write to `orders.amount_minor` after creation, status-guarded, `Transaction`-only — exported from `OrdersModule` | `apps/api/src/orders/order-repricing.service.ts`, `apps/api/src/orders/orders.module.ts` | One statement; the module's export list grows from four to six |
| 6 | The reader: `findOrder` moved out of `OrdersService` into `OrderViewService`, on the pooled handle, no `tx` parameter, exported; two `LEFT JOIN`s and three columns added for the promo | `apps/api/src/orders/order-view.service.ts` | One class with one method; `OrdersService` stays unexported |
| 7 | The view: `OrderViewCore.promo: { code, discount_minor, list_amount_minor } \| null`, always present; the `amount_minor` comment rewritten from "never recomputed" to "the amount to pay" | `apps/api/src/orders/orders.types.ts` | One interface, one field, one comment |
| 8 | Confirmed by reading, not changing: `PaymentSimulatorService.readOrderCharge` selects `orders.amount_minor` and nothing else, so the discounted amount reaches the webhook with no payment-path change | `apps/api/src/payments/payment-simulator.service.ts` | Zero lines |

Change 1 is the one to read first, and its header before its body. The order of the six statements is the design: the technical spec's §2.2 fixes it as a table, the service's header says why each row is where it is, and every inline comment quotes the statement Postgres runs and what zero rows from it means. The rest of this document is that table read aloud.

**Where this sits in the assignment.** `product-definition.md` §1.4's five adversarial scenarios, in the table Phase 3's first walkthrough drew:

| # | Scenario | Status after this slice |
| --- | --- | --- |
| 1–3 | Fifty parallel `paid` webhooks; a repeated `event_id`; a webhook before its order | Settled in Phases 1–2. Untouched. |
| 4 | Empty pool → recoverable → after restock, exactly one key | Settled in Phase 3. Untouched. |
| 5 | A promo code with limit N under parallel requests is applied at most N times | **The mechanism runs; the proof is not run.** I7's conditional `UPDATE` is now executed by a real request, I8's `INSERT` is written under the order lock, and the server's price reaches the webhook. The four-process measurement that turns the argument into a number is Slice 3. |

The brief's sentence about the codes has two halves — *the limit must hold even under parallel requests, and the server computes the discount* — and this slice is the second half entire and the server side of the first. What it is not is the proof: a sequential smoke test against one process says nothing about a race, and this document does not claim otherwise.

---

## 2. The words this document uses

- **The transaction** — `PromoRedemptionService.apply(orderId, rawCode)`: one `BEGIN … COMMIT` on one connection, eight numbered steps, six of them SQL statements. Steps 1–5 can refuse; steps 5–7 write; step 5 is both, and when it refuses it writes nothing.
- **A refusal** — one of the five answers that are not a success: `order_not_found`, `not_awaiting_payment`, `another_code_applied`, `unknown_code`, `exhausted`. Every one is a *value* the transaction returns, after committing a transaction that wrote nothing. The controller turns the value into a status. The seventh member of the union, `already_applied`, is a success that also wrote nothing — the same code was already on the order — and answers `200` with the identical body.
- **An invariant violation** — the one thing the transaction throws: a statement that cannot match zero rows while the order lock is held matched zero rows. `PromoRedemptionInvariantError`, a `ROLLBACK`, a `500`, and a stack trace, because it means the lock discipline was broken somewhere and that is a bug, not a busy shop.
- **A sentinel throw** — the idiom this codebase does not use: throwing an exception on purpose, inside a transaction, in order to make the wrapper roll back, then catching it by type somewhere above and translating it into an ordinary answer. The alternative shape for this transaction, and §4.1 is about what it costs.
- **Under the lock** — between step 1's `SELECT … FOR UPDATE` on the order row and `COMMIT`. Everything read under the lock stays true until `COMMIT`, because every other writer of that order — the payment processor, the issuance worker, the operator's retry, another redemption — takes the same lock first and waits.
- **The pooled handle** — `database.db`, the Drizzle handle that borrows a connection from the pool per statement. The transaction's `tx` handle is the other thing: one connection, checked out for the whole body. With `max: 1` there is exactly one connection per instance, so while `tx` holds it the pooled handle has nothing to borrow.
- **The amount to pay** — `orders.amount_minor`, in kopecks. Written by exactly two statements in the codebase: the `INSERT … SELECT` that creates the order from `products.price_minor`, and `applyDiscount`. When a code is applied it becomes the discounted figure; the catalogue figure moves to the ledger as `list_amount_minor`.
- **The ledger row** — `promo_redemptions` for this order: which code, `list_amount_minor`, `discount_minor`. Keyed `PRIMARY KEY (order_id)` — one code per order — and never deleted by the application, so the view carries the promo in every later state.

---

## 3. One request, eight steps

The smoke test run against `pnpm dev` earlier today, with the statements it caused. An order is created at `129000` kopecks — 1 290 ₽, which in the seeded catalogue is `KEY-CS2-PRIME` — and the page sends `{ "code": " limit3 " }`, spaces and lower case included.

**Before the transaction.** The controller's parser reads `code` and nothing else from the body, checks it is a string, and asks `normalisePromoCode` one question: is it empty after trimming? It is not, so the string is handed to the service *as sent*. The service normalises it once — trim, then upper-case — to `LIMIT3`, and that one string is the SQL parameter at step 4, the comparison at step 3, and the `promo_code` on the log line. An input that was empty after trimming would have been a `400` here and would never have opened a transaction; the service throws a plain error if one reaches it by another route, because that is a caller bug, not a code to look up.

**Step 1 — lock the order row.** `OrderLockService.lockOrder(tx, orderId)`:

```sql
select "id", "client_request_id", "sku", "amount_minor", "currency",
       "status", "created_at", "updated_at"
from "orders" where "orders"."id" = $1 for update;
-- 1 row  => this transaction owns the order row until COMMIT. Every other
--           redemption, payment or issuance worker that reaches this statement
--           for the same id waits here.
-- 0 rows => no such order; nothing is locked => `order_not_found` => 404
```

One row: `status = 'created'`, `amount_minor = 129000`, `currency = 'RUB'`. From here to `COMMIT`, nothing else can change this order.

**Step 2 — the status, in memory.** `order.status !== 'created'` → `not_awaiting_payment` → `409`. It is `created`, so on. This is a check-then-act, and it is sound *only* because of step 1: the value was read under a lock that is held until the transaction's last write, and every transition that could move it takes the same lock first. Step 7's `WHERE status = 'created'` is the second, independent stop for a caller who did not.

**Step 3 — this order's existing redemption, before the code lookup.**

```sql
select "promo_codes"."id", "promo_codes"."code"
from "promo_redemptions"
inner join "promo_codes" on "promo_codes"."id" = "promo_redemptions"."promo_id"
where "promo_redemptions"."order_id" = $1;
-- 1 row whose code = the normalised input => `already_applied` => 200, nothing written
-- 1 row with a different code            => `another_code_applied` => 409
-- 0 rows => no code on this order yet; go on
```

Zero rows: a fresh order. The statement is here, before the code is looked up, for a reason that matters under load: a retry, a double-click, a reload that resubmits — all of them are answered from *this order's* ledger row, under *this order's* lock, and never touch the `promo_codes` row that twenty other shoppers are queueing on. `order_id` is the table's primary key, so the join cannot return two rows and there is no `LIMIT` promising one.

**Step 4 — the code's definition, with no lock.**

```sql
select "id", "code", "kind", "value", "currency", "max_uses"
from "promo_codes" where "promo_codes"."code" = $1;
-- $1 the NORMALISED code, which is the stored form:
--    CHECK (code = upper(btrim(code))) guarantees the other side of the equality.
-- 1 row  => the definition. `used_count` is deliberately not selected.
-- 0 rows => `unknown_code` => 422. Decided before anything is written.
```

One row: `kind = 'percent'`, `value = 25`, `max_uses = 3`. No `FOR UPDATE`, on purpose: twenty shoppers reading one definition must not queue behind each other; step 5 is what serialises them, and it serialises only the increment. The column that is *not* in the list is the point of the list — `used_count` is read by no statement but the one that writes it, so nothing in memory can ever be tempted to compare against a count it read a moment ago. The currency check lives in the narrowing that follows: an `amount` code whose currency is not the order's is refused as `unknown_code` too, so the arithmetic can never subtract dollars from roubles when the shop stops being all-`RUB`. A `percent` code has no currency and needs none.

**The arithmetic, in memory.** `computeDiscount(129000, { kind: 'percent', value: 25 })` → `Math.round(129000 × 25 / 100) = 32250`, to pay `129000 − 32250 = 96750`. Both inputs came from rows read inside this transaction — the amount from step 1, the definition from step 4. The request body is not an input; there is no parameter it could be.

**Step 5 — I7, the counter. The last refusal and the first write.**

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

One row, `used_count = 1`. Three things in the statement are load-bearing, and Slice 3's proof is about all of them. The comparison is column-to-column, evaluated by Postgres against the row it is about to write at the instant it holds that row's lock. The increment is `used_count + 1` in SQL, relative to the committed value whatever it is by the time this statement runs — not `$read + 1` from a value Node read earlier, which is the race. And it returns one column, so one row and zero rows are told apart without reading anything else back. Twenty of these against one row queue on the row's lock; each re-evaluates the `WHERE` against the row as the previous transaction committed it; the fourth sees `3`, matches nothing, and returns nothing. That is the phase's keystone and it belongs to Slice 3's document; here it is enough that the statement exists and runs.

**Step 6 — I8, the ledger row.**

```sql
insert into "promo_redemptions"
  ("order_id", "promo_id", "list_amount_minor", "discount_minor", "created_at")
values ($1, $2, $3, $4, default)
on conflict ("order_id") do nothing
returning "order_id";
-- $3 the list amount read under the lock at step 1, $4 the APPLIED discount.
-- 1 row  => the use is recorded; reprice the order and commit.
-- 0 rows => IMPOSSIBLE UNDER THE ORDER LOCK. Thrown, so the step-5
--           increment is ROLLED BACK — the one rollback path — and the API
--           answers 500.
```

One row. `list_amount_minor = 129000`, `discount_minor = 32250`. The conflict target is named — `(order_id)` — so the clause forgives exactly one constraint and no other: the two foreign keys and `promo_redemptions_discount_range` still raise as the errors they are rather than being read as "already redeemed".

**Step 7 — the reprice.** `OrderRepricingService.applyDiscount(tx, orderId, 96750)`:

```sql
update "orders"
set "amount_minor" = $1, "updated_at" = now()
where ("orders"."id" = $2 and "orders"."status" = $3)
returning "id";
-- $1 the amount to pay from `computeDiscount`, $3 the literal 'created'.
-- 1 row  => repriced. 0 rows => impossible under the lock; thrown => ROLLBACK
--           of steps 5 and 6 => 500.
```

One row. `orders.amount_minor` is now `96750`. The service reports zero rows rather than throwing, because it cannot know whether its caller held the lock; this caller did, so here zero rows is an invariant violation and the transaction throws.

**Step 8 — return `{ outcome: "applied", promoId, usedCount: 1, maxUses: 3 }`.** Nothing is re-read. `COMMIT`.

**After the transaction.** The controller calls `OrderViewService.findOrder(orderId)` on the pooled handle — the connection the transaction held is free again — and the view comes back as one `SELECT` with four `LEFT JOIN`s: `amount_minor: 96750`, `promo: { code: "LIMIT3", discount_minor: 32250, list_amount_minor: 129000 }`, `status: "created"`, `code: null`. That is the `200` body, and it is the committed view: every other process can see the same row. The log line says `promo: applied — one use taken (I7), the ledger row written (I8), the order repriced` with `order_id`, `promo_code: LIMIT3`, `promo_id`, `outcome: applied`, `used_count: 1`, `max_uses: 3`, `amount_minor: 96750`, `status_code: 200`, `duration_ms`.

**Then the shopper pays.** `PaymentSimulatorService.readOrderCharge` runs `select "amount_minor", "currency" from "orders" where "id" = $1` — two columns, no join, no status — and builds the webhook with `amount: minorToMajor(96750)`, which is `967.5` on the wire because the provider's contract is in roubles. The webhook controller converts it back with `majorToMinor` and the inbox row lands with `payment_events.amount_minor = 96750`. The smoke test read that value back from the table. Nothing on the payment path knows a promo exists; it charges what `orders.amount_minor` says, and that column now says the discounted figure. The order goes `paid → delivering → delivered`, and `GET /api/orders/:id` on the delivered order still carries `promo` — the ledger row is never deleted, and the view's promo columns are not gated on status the way the key is.

The same request a second time — `{ "code": "LIMIT3" }` on the same order — locks the row, reads `created`, finds the ledger row at step 3 with `code = LIMIT3`, and returns `already_applied`: `200`, the identical body, nothing written, the hot row untouched. A different code on that order stops at the same step with `another_code_applied` → `409`. `{ "code": "nope" }` on a fresh order reaches step 4, finds nothing, `unknown_code` → `422`. And the same code on the paid order stops at step 2: `not_awaiting_payment` → `409`.

---

## 4. The three decisions the task names

Each in the same shape: what was built, the more obvious alternative, and what goes wrong without the decision.

### 4.1 Every refusal is decided before either write

**What.** The order of the eight steps. The five that can say no — lock, status (in memory, under the lock), ledger row, code lookup, the conditional `UPDATE` — run before the two statements that only write. When any of the five says no, the method `return`s a member of the `PromoRedemptionOutcome` union, the wrapper issues `COMMIT`, and the commit is of a transaction that changed nothing. The controller's `switch` on the union, with `assertNever` in its `default`, is the only place an outcome becomes an HTTP status, and `promoRefusal(reason)` builds the body and the status together so they cannot disagree. Step 5 sits at the hinge: it is the last thing that can refuse and the first thing that writes, and the two are the same fact — a statement that matched zero rows wrote nothing, so a refusal from it is still a refusal that committed empty.

The one `throw` that remains is `PromoRedemptionInvariantError`, from steps 6 and 7, when a statement that cannot match zero rows under the order lock matched zero rows. Both are impossible on the path that exists. Step 3 read the ledger under the lock and found nothing, and every other writer of this order's ledger row must first take the same lock at its own step 1 — so no row can appear between step 3 and step 6. Step 2 read `created` under the lock, and every status transition goes through `OrderTransitionService`, which takes the same lock — so the status cannot move between step 2 and step 7. If either statement returns zero rows anyway, something wrote to the order without the lock. That is worth a `500`, a `ROLLBACK` that undoes the step-5 increment, and a stack trace with the ids in it, because it is a bug and not a busy shop. The error is typed so the controller can log `order_id`, `promo_code`, `promo_id` and `step` beside the `500` before rethrowing it unchanged.

**The obvious alternative.** Increment first. Take the use with the conditional `UPDATE` as the opening statement — it is the contended one, so settle it early — then lock the order, check the status, check the ledger. When a later check fails, throw a sentinel exception (`class PromoRefused extends Error { reason }`) so the transaction wrapper rolls the increment back, and catch it in the controller to answer `409`. The technical spec records that the two specialists who reviewed the transaction disagreed on exactly this — whether the increment should come before the two writes or last before `COMMIT` — and that both orderings are correct.

**What goes wrong with the alternative.** Nothing about the limit; that is why the spec calls both correct. What the sentinel costs is everything around the limit, and the costs are concrete.

*The control flow goes through `catch`.* Today the controller has one `switch` over a seven-member union, and the compiler refuses to build if a member is unhandled. A refusal that is thrown is untyped — TypeScript's `catch` binds `unknown` — so the `switch` becomes an `instanceof` chain, `assertNever` has nothing to check, and a new refusal added to the service is a new `500` in the controller until somebody remembers the second file. The service also stops being callable from a race script or a test without an HTTP layer's opinions attached, because its refusals are now exceptions that something must catch.

*The transaction wrapper's own error handling is in the way.* `database.transaction(work)` is documented in one line: `ROLLBACK; -- work threw; the error is rethrown`. The wrapper cannot tell a sentinel from a driver error — both are a rejected promise — so every expected refusal takes the same path as a lost connection: `ROLLBACK`, rethrow, and whatever the wrapper's callers do with errors. A refusal that is ordinary traffic is now travelling through code written for failures.

*An aborted transaction on a `max: 1` pool.* Every refusal becomes a real `ROLLBACK` rather than an empty `COMMIT` — one more round trip on the instance's only connection, with the order row lock held until it completes and, in the increment-first shape, the `promo_codes` row lock as well. That row is the one twenty shoppers queue on; the sentinel shape holds it for the status check and the ledger read *and then undoes the write*, for every shopper who turns out to have a paid order or a code already applied. There is a sharper version of the same cost: a sentinel caught *inside* the transaction body, to "handle" it and carry on, would be running statements on a connection whose transaction may already be in Postgres's aborted state if the throw came from Postgres rather than from the code — `25P02 current transaction is aborted` on every statement until `ROLLBACK` — and the two kinds of throw are not distinguishable by shape.

*Log noise indistinguishable from real failures.* A thrown refusal arrives in the log as an error with a stack trace, in the same shape as a genuine one. The controller today logs the four refusals at `log` level, with a comment saying why: an exhausted code under twenty simultaneous shoppers is the limit *holding*, which is the point of the phase, and a log that paints it red seventeen times per race run is a log nobody reads. With a sentinel, the level is `error` unless something downgrades it by type — which is another `instanceof` somewhere else.

*Nest's exception filter would have to unpack it.* If the sentinel is a domain error, Nest's default filter renders it as a `500` — so a custom `@Catch(PromoRefused)` filter has to map it to `409`/`422`, and the mapping from outcome to status leaves the one `switch` where the exhaustiveness guard lives. If instead the sentinel *is* an `HttpException`, so the default filter renders it directly, then an HTTP type is being thrown from inside a database transaction — the service has acquired HTTP opinions, the controller cannot log `status_code` and `duration_ms` for the refusal without catching and rethrowing anyway, and the whole reason for the split between service and controller is gone.

None of these costs is fatal, which is why the spec is even-handed about the two orderings. Together they are the reason the codebase has never thrown to roll back anywhere — the transition helper, the key claim, the inbox drain all report zero rows as an outcome — and the reason this transaction was written in the shape that keeps that true.

### 4.2 The view is read after `COMMIT`

**What.** The handler is two calls in a fixed order. `apply` runs the transaction to `COMMIT` and returns an outcome — never the order. Then, for `applied` and `already_applied`, `OrderViewService.findOrder(orderId)` reads the view on the pooled handle. The body the shopper receives is the committed row, which every other process can also see. `findOrder` takes no `tx` parameter, and there is no `findOrderWithin(tx, …)`; `lockOrder` and `applyDiscount` take *only* a `tx`. The two signatures point opposite ways on purpose: the wrong composition — a pooled read inside the transaction — does not have an API to be written with.

**The obvious alternative.** Return the order from the transaction. Step 8 has the row it locked and the amounts it computed; it could build the view there, or call `findOrder` before `COMMIT` so the response is assembled in one place. Either saves a round trip and reads naturally.

**What goes wrong with the alternative.** The second form is a self-deadlock, and it is worth saying slowly. `packages/db/src/client.ts` sets the pool to `max: 1` per instance — the serverless shape, and the reason architecture §7's twenty-versus-nine measurement exists. A transaction checks that one connection out for its entire body. `findOrder` runs on `this.database.db`, the pooled handle, which asks the pool for a connection per statement. Called from inside `apply`'s transaction, it asks for a connection while the transaction is holding the only one — and the transaction is `await`ing `findOrder`, so it will not release the connection until `findOrder` returns, and `findOrder` cannot return until the connection is released. Nothing can ever return. `pg` gives up after `CONNECTION_TIMEOUT_MS`, which is ten seconds, with a timeout error that names the pool rather than the cause, and the order row lock has been held for those ten seconds with every payment worker and every other redemption for that order queued behind it.

It was not discovered in this slice. `client.ts`'s `transaction()` doc names it, `OrderTransitionService.transition` documents the same trap, and `payment-event-drain.service.ts` explains twice why a drain cannot start from inside a transaction — all from Phase 2. The technical spec carried it forward as risk R3 before this slice's code existed, and the tasks made "reads the view **after** COMMIT" part of the endpoint's definition. The code avoids it by construction rather than by care: the comment lives in three places — the `THE VIEW IS READ **AFTER COMMIT** — R3` header of `promo.controller.ts`, with a boxed inline note at the `findOrder` call saying it "would self-deadlock one line earlier"; the `NO READ INSIDE THE TRANSACTION — R3` section of `promo-redemption.service.ts`'s header; and the `THIS READS AFTER COMMIT, ON THE POOLED HANDLE, BY DESIGN` header of `order-view.service.ts`, which also says why no `findOrderWithin` should be added for convenience.

The first form of the alternative — building the view in step 8 from the rows in hand — would not deadlock, and it was still not done, for two reasons that are smaller but real. The view is one statement with four `LEFT JOIN`s and a `CASE` that keeps an undelivered order's key from ever leaving Postgres; a second copy of that shape assembled from a locked row and two computed numbers is a second thing to keep in step with the first. And the transaction stays short: six statements, no view read, no network I/O, the order lock and the instance's one connection held for microseconds rather than for a round trip more.

### 4.3 The price is the shop's

**What.** The request body is `{ code }`. `parseApplyPromoRequest` reads the `code` key and no other; an extra field is ignored, not rejected — `{ "code": "LIMIT3", "discount_minor": 100000 }` applies `LIMIT3` at the server's price, and a rejection would suggest the extra field had been meaningful enough to argue with. The amount comes from `orders.amount_minor` as `lockOrder` returned it at step 1; the definition comes from the `promo_codes` row at step 4; `computeDiscount` takes those two and nothing else; `applyDiscount` takes a `MinorUnits`, the branded kopeck type, so an unbranded number from a body cannot reach it without an explicit conversion at the call site — and the only call site is the transaction. On the wire coming back, `promo` carries `code`, `discount_minor` and `list_amount_minor` and no `kind`, no `value`, no percentage: the page is handed the applied kopecks and nothing it could recompute a price from.

`orders.amount_minor` is the amount to pay. It is written by exactly two statements in the codebase, and the grep that proves it is in the repricing service's header: the `INSERT … SELECT` that creates the order, copying `products.price_minor` column-to-column inside Postgres so no TypeScript variable ever holds a price, and `applyDiscount`, at most once more, under the order lock, while `status = 'created'`, from `computeDiscount`'s output. The catalogue figure does not vanish when the code is applied — it moves to the ledger as `list_amount_minor`, beside `discount_minor`, and the three satisfy `list_amount_minor = amount_minor + discount_minor` on every row, including the one where an `amount` code larger than the price leaves the shopper paying `0` and the recorded discount is the whole list price rather than the code's face value. `promo_redemptions_discount_range` refuses any row for which the identity would not hold. That is what "the record of what was paid does not change after the fact" means as a property of columns: the admin's undelivered list reads `amount_minor` and shows what was paid; the delivered order's view reads the ledger and shows what it was before.

**The obvious alternative.** Let the page do the arithmetic. It already formats the price; it could apply the percent, show the new total, and send `{ code, amount }` — or simply `{ amount }` — for the server to record. Or a softer version: the server computes the discount but trusts the client's `list_amount` as the base, "since the page just read it from the API anyway".

**What goes wrong with the alternative.** The functional spec's §1 says it in one sentence: a shop that lets the page say what the discounted price is will sell a 3 490 ₽ key for 1 ₽ to anyone who edits a number. Every field a client sends is a field a client can send differently, and the page is not the only client — `curl` is. The softer version fails the same way one step later: a base amount that arrived in the request is a number the server did not read under the lock, so a stale tab, a race with a catalogue change, or a hand-edited request sets the base and the "server-computed" discount is computed from a figure the shopper chose. The only base the server can trust is the one in the row it has locked. That is why the arithmetic has no parameter a request could reach, why the branded type makes the crossing from wire to kopecks an explicit act in exactly two places, and why the payment path — which never saw a promo — charges the right amount: it reads the column the server wrote.

---

## 5. What is proven so far, and by what

This slice's acceptance file (`apps/api/test/acceptance/promo-codes.test.ts`, port 5301) and its verify task are the two tasks after this one and had not run when this was written. What exists is the smoke test against `pnpm dev` and what can be checked from the tree without touching the database.

**The smoke test, by hand.** An order for `129000` kopecks; `{ "code": " limit3 " }` → `200`, the view with `amount_minor = 96750` and `promo.code = "LIMIT3"` — the trim and upper-case happened once, in the service, and the stored form came back; the payment simulator; `payment_events.amount_minor = 96750` read from the table. The four numbers are the unit file's: `129000 → 96750` for a 25 % code is the third of the four seeded examples Slice 1 pinned, and the discount is `32250` by the same arithmetic. One instance, one shopper, sequential — a proof that the statements do what their comments say, and no proof of anything about a race.

**From the tree.** `pnpm --filter @game-shop/api run typecheck` is clean. The transaction body issues six statements against `tx` — `lockOrder`, the ledger read, the code lookup, the I7 `UPDATE`, the I8 `INSERT`, `applyDiscount` — and contains two `throw new PromoRedemptionInvariantError` and no other throw. `findOrder` has two callers, `OrdersController` and `PromoController`, and the promo one is inside the `switch` that runs after `apply` has returned. The Drizzle call `.set({ amountMinor: … })` occurs once in `apps/api/src`, in `order-repricing.service.ts`; the two other mentions of it are comments saying so. The controller reads `code` from the body and destructures nothing else.

**What Slice 3 will add**, and this document does not pre-empt: twenty simultaneous `LIMIT3` across four processes → exactly `3 × 200`, `17 × 409 exhausted`, zero `5xx`; the RED with the guard weakened both ways, including the shape where the `CHECK` masks a broken guard; `pnpm race promo` twice back to back.

---

## 6. Findings

Five sentences that the code has moved past, all in comments or in the spec, none in `src/promo`. Reported with file and line; not edited, because another agent was running the API from the tree.

### 6.1 The repricing header says the webhook compares amounts

`apps/api/src/orders/order-repricing.service.ts:16–18`: *"Nothing on the payment or issuance path writes the column: the webhook's verdict compares against it, the admin list reads it, the payment simulator sends it."* The webhook does not compare the event's amount to the order's — `payment-webhook.controller.ts` says so outright (*"The amount is not compared to the order's. That is settlement … it belongs to processing"*), the processor has no comparison either, and R6's whole premise is that "the processor never compares amounts". The correction: *"the payment processor never compares against it (R6), the admin list reads it, the payment simulator sends it."* The sentence matters because a reader who believes the comparison exists would think the apply-vs-pay window is closed. It is not.

### 6.2 The simulator still counts the export list at one

`apps/api/src/payments/payment-simulator.service.ts:374–376`: *"Reusing it would also mean exporting `OrdersService` from `OrdersModule`, whose export list is one item long on purpose — `OrderTransitionService`, the only way any module may write `orders.status`."* The list is six items long as of this slice, and `OrderViewService` — the very method the paragraph declines to reuse — is one of them. The reason not to reuse it is still good (two columns and no join, and nothing that branches on status), but the sentence about the export list is false. The correction: drop the export-list clause and keep the shape argument.

### 6.3 "Three statements long"

`apps/api/src/orders/order-view.service.ts:43–44`: *"the transaction stays three statements long with no read inside it"*. The redemption transaction issues six: three that read and can refuse, three that write. The correction: *"six statements long — three reads that can refuse, three writes — with no view read inside it"*.

### 6.4 R6 points at an architecture entry that does not exist yet

`technical-considerations.md` §3, row R6: *"Recorded as a known trade-off in architecture §9."* §9 has five entries and none is the apply-vs-pay window. Slice 3's task adds the admin reset to §9 beside `ALLOW_CLIENT_SUPPLIED_ORDER_ID`; R6's line should land there in the same edit, or the row should say "to be recorded".

### 6.5 "Two of them write"

`apps/api/src/promo/promo-redemption.service.ts:13`: *"Eight steps. Five of them can refuse; two of them write."* Three lines later step 5 is labelled *"the last refusal, and the first write"*. Both are true of the design — the technical spec counts the same way, "before either write" meaning steps 6 and 7 — but a reader adding it up gets three writers. The correction: *"Five of them can refuse; three of them write; step 5 is both."*

---

## 7. What a reviewer might challenge

- **`PRIMARY KEY (order_id)`, not the architecture's `UNIQUE (promo_id, order_id)`.** The original admitted two *different* codes on one order — a second discount on an already-discounted price. One code per order is the functional spec's rule; the stronger key implies the weaker, so every guarantee I8 was written for still holds; `architecture.md` carries the amendment inline. Slice 1's document has the negative proof.
- **A use is spent at apply time, not at payment.** Functional spec §2.4: an abandoned order does not return a use. The alternative — reserve on apply, consume on payment, release on expiry — needs a reservation state, a sweeper, and a second transaction on the hot row; the brief asked for a limit that holds, not a limit that is fair. A shopper who applies `ONCEONLY` and walks away has used it.
- **R6 — the apply-vs-pay window is documented, not closed.** The simulator reads `orders.amount_minor` without a lock and then delivers the webhook. A code applied to a `created` order in the milliseconds between that read and `markPaid` is applied at a list-price payment, and the processor never compares amounts. The status guard closes every ordering except that one; the window is one simulated-provider round trip. The honest fix — compare `payment_events.amount_minor` to `orders.amount_minor` under the lock in the processor and route a mismatch to `payment_failed` — changes the payment path and the fifty-webhook race's staged amounts, and the functional spec's own §3 puts it out of scope. It should be said before a reviewer finds it.
- **Increment before the two writes, not last before `COMMIT`.** Both are correct; §4.1 is the argument for the shape chosen, and the cost it admits is holding the hot row for two more small statements.
- **`422` for an unknown code, not `404`.** `404` is a statement about the request target, and `/api/orders/{id}/promo` is a route that exists on an order that exists. `422` is the same sense `POST /api/orders` already uses for a SKU the shop does not sell. `410 Gone` for exhausted was rejected for the reason `promo.types.ts` gives: it says the target resource is gone, which is false.
- **`200` for the same code twice.** Idempotency the page relies on — a double-click, a retry after a lost response — decided under the order lock from the ledger row, with the hot `promo_codes` row never touched. A `409` here would make a retry look like a conflict.
- **The currency check is unreachable today.** All orders are `RUB`. It is there so the arithmetic can never subtract dollars from roubles when that stops being true, and refusing as `unknown_code` is the shopper's-eye truth: the code does not exist for this order.

---

## 8. Interview questions this answers

**"Walk me through what happens when I send a code."**
One transaction, six statements, in an order that is the design. Lock the order row with `FOR UPDATE` — from here to `COMMIT` nothing else can touch it. Check the status in memory, which is sound only because of the lock. Read this order's ledger row: the same code again is `200` with nothing written, a different code is `409`. Look the code up with no lock. Compute the discount from the locked row's amount and the code's definition. Then `UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1 AND used_count < max_uses RETURNING used_count` — one row means this transaction has a use, zero means exhausted and nothing was written. Insert the ledger row with `ON CONFLICT (order_id) DO NOTHING`; write the amount to pay with `WHERE status = 'created'`; commit; read the view back after commit. On a 1 290 ₽ order with `LIMIT3` that is `96750` kopecks, and the webhook carries `96750` when the shopper pays.

**"Why is every refusal decided before anything is written? Wouldn't it be simpler to take the use first and roll back if the order turns out to be paid?"**
It would be equally correct for the limit, and the spec says so. What it costs is everything around the limit. A refusal would have to be a thrown sentinel so the wrapper rolls back, which turns the controller's exhaustive `switch` into an `instanceof` chain the compiler cannot check; every expected refusal becomes a `ROLLBACK` round trip on a `max: 1` pool with the order lock — and in that shape the hot promo row's lock — held until it completes; a refused shopper shows up in the log as an error with a stack trace, indistinguishable from a real one, when an exhausted code under a race is the system working; and Nest's filter either has to unpack a domain error or the service has to throw HTTP types from inside a transaction. This codebase has never thrown to roll back anywhere. Ordering the statements so that everything that can refuse runs first means a refusal is a value, the commit is empty, and the only throw left is a broken invariant that deserves a `500`.

**"Then what does still throw?"**
Two statements: the ledger `INSERT` and the reprice `UPDATE` returning zero rows. Both are impossible while this transaction holds the order lock — the ledger was read under the same lock at step 3 and found empty, the status was read under it at step 2 and was `created`, and every other writer of either takes the same lock first. Zero rows there means something wrote without the lock, which is a bug, so it is a typed error with the ids on it, a rollback of the counter increment, and a `500` with a stack trace. Not a refusal; a defect report.

**"Why doesn't the transaction return the order? You have the row right there."**
Because the pool is `max: 1` per instance and the view reader runs on the pooled handle. Calling it inside the transaction asks the pool for a connection while the transaction is holding the only one, and the transaction is waiting on that call — nothing can ever return. `pg` gives up after ten seconds with an error that names the pool, and the order row lock has been held the whole time. So the handler is `apply` to `COMMIT`, *then* `findOrder`; the reader takes no `tx` and the lock and the reprice take only a `tx`, so the wrong composition has no API. The bonus is that the body the shopper gets is the committed row, which every other process also sees.

**"How do you know I can't change the price from the browser?"**
The body is `{ code }` and the parser reads that key and no other; send `discount_minor: 100000` beside it and it is ignored. The amount is `orders.amount_minor` as read under the lock, the definition is the `promo_codes` row, `computeDiscount` takes those two and has no parameter a request could reach, and the reprice takes the branded kopeck type so an unbranded number from a body cannot get there without an explicit conversion the transaction is the only caller of. `amount_minor` is written by two statements in the whole codebase — creation, copying `products.price_minor` inside Postgres, and this one, under the lock, while `created` — and a grep in the repricing header proves it. The page gets back the applied kopecks and the list price, and no percentage it could multiply. And the payment path never heard of a promo: it reads the column and charges what it says.

**"What does `list_amount_minor` exist for, if `amount_minor` is the price?"**
So the record of what was paid does not change after the fact — as a property of columns, not of arithmetic. When the code is applied the catalogue figure moves to the ledger beside the applied discount, and `list = amount + discount` holds on every row, including a 0 ₽ order where the discount recorded is the whole list price rather than the code's face value; a `CHECK` refuses a row where it would not. The delivered order's view shows both a month later without asking the catalogue, which may have changed.

**"Where is the race proof?"**
Slice 3. This slice ran the statements with one shopper against one process and read the numbers back; that proves the statements do what their comments say and nothing about parallelism — a `max: 1` pool serialises inside one instance, so a sequential pass cannot fail on a race by construction. The four-process run on 5201–5204, its RED with the guard weakened both ways, and `pnpm race promo` are the next slice and its document.

---

## 9. What is not finished

- **The acceptance file and the verify task.** `apps/api/test/acceptance/promo-codes.test.ts` on 5301 — the four amounts, `nope` → `422`, ` limit3 ` → `LIMIT3`, twice → `200` and one row, a different code → `409`, empty → `400`, a paid order → `409`, `payment_events.amount_minor` after the simulator, the delivered view still carrying `promo` — has not been written, and `pnpm test` has not been run with it. The evidence in §5 is a smoke test and the tree.
- **The race is not run.** The four-process proof and `pnpm race promo` are Slice 3. Until then the claim that step 5 admits exactly `max_uses` transactions across four processes is an argument, quoted from the header, with no measurement behind it.
- **R6 is open by decision.** The apply-vs-pay window stays; §7 says what closing it would cost and why it is out of this phase's scope.
- **The reset endpoint.** `POST /api/admin/promo-codes/reset` is Slice 3's, for the deployed shop.
- **Five stale sentences**, §6, awaiting the fix the parent schedules.
- **The shopper's page is Slice 4's, and it is ahead of this document.** `apps/web/src/features/apply-promo/` and `applyPromo` in the order entity are already in the tree — Slice 4's first two tasks are done — but its e2e, its screenshots and its own walkthrough are not, and nothing here claims anything about what the page shows.

---

## 10. The two sentences

The standing requirement asks that each slice's question be answerable unaided, in two sentences, before any code is opened. For this slice — refusals before writes, and the server-owned price:

> Every statement that can say no — the order lock, the status, the ledger row, the code lookup, and `UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1 AND used_count < max_uses RETURNING used_count` — runs before the two statements that only write, so a refusal is a value the transaction returns after committing nothing, and the one throw left is an invariant that cannot fail while the order lock is held. The request contributes one string, `code`; every number is computed from that code's row and from `orders.amount_minor` read under the lock, written once to that column while the order is still `created` with the list price and the discount recorded beside it on the ledger — so nothing the page sends is ever a number, and the payment path charges the column without knowing a promo exists.

---

## Source files

- `apps/api/src/promo/promo-redemption.service.ts` — the transaction; the header's four arguments (refusals before writes and R4, `READ COMMITTED` and why step 5 admits exactly `max_uses`, lock order and no `SKIP LOCKED`, no read inside and R3); every emitted statement inline; `PromoRedemptionInvariantError`
- `apps/api/src/promo/promo.controller.ts` — the view after `COMMIT`; `200` for both successes; the refusal table; the parser reading `code` alone; the `switch` with `assertNever`; the log line
- `apps/api/src/promo/promo.types.ts` — `ApplyPromoRequest` ("a code, and nothing else"); the outcome union in statement order; `promoRefusal` and the digits
- `apps/api/src/promo/promo.module.ts` — why its own module; exports nothing; the module-distance reasoning
- `apps/api/src/orders/order-repricing.service.ts` — the one write to `amount_minor` after creation; the guard under the lock; `Transaction`-only; the grep
- `apps/api/src/orders/order-view.service.ts` — the reader on the pooled handle, no `tx`, no `findOrderWithin`; the two promo joins, 1:0..1; the emitted `SELECT`
- `apps/api/src/orders/orders.module.ts` — the export list as the promise; why `OrdersService` stays home
- `apps/api/src/orders/orders.types.ts` — `AppliedPromoView` and the identity; `amount_minor` as the amount to pay
- `apps/api/src/payments/payment-simulator.service.ts` — `readOrderCharge`, two columns, no status; the kopeck-to-rouble crossing
- `apps/api/src/payments/payment-webhook.controller.ts` — "the amount is not compared to the order's"
- `packages/db/src/client.ts` — `max: 1`, `CONNECTION_TIMEOUT_MS`, `transaction()`'s contract and the self-deadlock note
- `apps/api/src/orders/order-lock.service.ts` — the `FOR UPDATE` statement and its three rules
- `apps/api/src/promo/promo-discount.ts`, `promo-code.ts` — the arithmetic and the normalisation, Slice 1's
- `packages/db/src/fixtures/promo-codes.ts` — the brief's sentence, verbatim
- `context/product/architecture.md` §3, §3.1 (I7, I8), §7, §9
- `context/spec/005-promo-codes-with-enforced-limits/functional-spec.md` §1, §2.3, §2.4, §2.6
- `context/spec/005-promo-codes-with-enforced-limits/technical-considerations.md` §1 (decisions 1 and 2), §2.2, §2.3, R3, R4, R6, R9

**On evidence:** what I ran fresh while writing this document, against the tree as it stands, with no server started, no database touched, and no source, test, config or spec file modified. `pnpm --filter @game-shop/api run typecheck` — `tsc --noEmit`, clean. `grep` over `promo-redemption.service.ts` for statements issued against `tx` — six: lines 269, 318, 360, 426, 468, 508 (`lockOrder`, the ledger read, the code lookup, the I7 `UPDATE`, the I8 `INSERT`, `applyDiscount`); for `throw new` — two `PromoRedemptionInvariantError` at 475 and 511, plus the `assertNever` and the empty-code guard outside the transaction. `grep -rn "findOrder("` over `apps/api/src` — the definition and two callers, `orders.controller.ts:474` and `promo.controller.ts:247`. `grep` for `set({ amountMinor` — one call, `order-repricing.service.ts:184`, and two comments naming it (`order-repricing.service.ts:93`, `promo.module.ts:25`). `grep` over `payment-event-processor.service.ts` for `amount` and `compare` — the column in a `RETURNING` list and a sentence about clocks; no comparison. `orders.module.ts` `exports` — six entries. The five stale sentences at the lines §6 cites.

The smoke test — `129000`, ` limit3 ` → `LIMIT3`, `amount_minor = 96750`, paid, `payment_events.amount_minor = 96750` — was run against `pnpm dev` earlier today and is quoted, not re-run: the database was in use by another agent's work while this was written. `pnpm test` was not run for the same reason, and the acceptance file it would include does not exist yet.
