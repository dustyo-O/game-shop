# Phase 2 · Slice 5 — Only one worker advances an order

> Completes invariant I4 (`architecture.md` §3): the status-guarded UPDATE has been here since Phase 1; this slice adds the `SELECT … FOR UPDATE` that sits in front of it.
>
> The honest headline is that **the RED validation came back green.** Removing the lock changed no observable outcome, ten times running. That result is in §3, it is not softened, and the case for keeping the lock is made after it rather than instead of it.

---

## 1. Two mechanisms with one name, and neither one is the other

`architecture.md` §3 states I4 as a conjunction, and it is easy to read past the "plus":

> `SELECT … FOR UPDATE` on the order row, **plus** status-guarded updates (`WHERE status = 'paid'`)

Phase 1 shipped the second half. `OrderTransitionService` has emitted guarded UPDATEs since the lifecycle existed. This slice adds the first half, in `apps/api/src/orders/order-lock.service.ts`, and the whole of the assigned question is why those are two jobs and not one job written twice.

| | What it excludes | How long the exclusion lasts |
|---|---|---|
| **The guarded UPDATE** — `WHERE id = $1 AND status = 'paid'` | An *illegal transition*. The row can only leave `paid` once, so exactly one caller gets one row back and everyone else gets zero. | Exactly its own statement. The instant it commits, the guard has no further opinion about anybody. |
| **`SELECT … FOR UPDATE`** | Another *worker*. For as long as this transaction lives, no other transaction may read-for-update or write this order row. | Until `COMMIT` or `ROLLBACK` — so it can cover a decision that spans more than one statement. |

Said the other way round, which is the sentence to have ready:

**The guard makes a *transition* idempotent. The lock makes a *worker* exclusive.** A transition being idempotent means running it twice is the same as running it once. A worker being exclusive means nobody else is inside the same span of statements at the same time. Those are different properties and neither implies the other.

The failure each one leaves open, concretely:

- **Guard alone.** Fifty webhooks issue fifty `paid → delivering` UPDATEs. Postgres serialises them, one wins, forty-nine match zero rows. Correct — for that one statement. But issuance is *five statements and a network call* long: record the attempt, call the supplier, resolve the attempt, bind the delivery, finish the order. Nothing about the guard says the winner is alone for the rest of that.
- **Lock alone.** It serialises the workers but has no opinion about which move is legal. Two workers that take it *in turn* would both write `delivering` and both walk to the supplier, each perfectly serialised with respect to the other, each burning a key. The guard is what makes the second one's turn a no-op.

So the lock serialises the workers; the guard decides. Both, or neither is enough.

There is a third thing the lock is deliberately *not*, and it is worth saying out loud because under a lock it would finally be safe: **nothing in this codebase branches on the row the lock returns.** `lockOrder` hands back the whole `Order`, and the only thing done with it is put `locked_status` on a log line. The decision stays the guarded UPDATE, evaluated by Postgres against the row. Under `FOR UPDATE` a check-then-act would genuinely be correct, and the codebase still does not write one — because the moment there is one, its correctness depends on a reviewer noticing the lock three lines above it.

---

## 2. Why the lock cannot simply wrap the whole span

The obvious shape is one transaction: lock the order, call the supplier, write the result, commit. It is the shape a reviewer will ask about, and it is the one design this codebase cannot have.

`packages/db/src/client.ts`:

```
max: 1 per instance
```

That is architecture §2's connection policy, chosen so fifty concurrent serverless invocations cannot exhaust Postgres's connection limit. Drizzle checks that single connection out for the whole of `transaction()`. So the pool is not a resource with headroom — **it is a mutex**, and a transaction held across an HTTP round trip blocks *every other database statement in that process*: the catalogue, order creation, webhook intake, every status poll. `SUPPLIER_TIMEOUT_MS` is 2000ms. A slow supplier would stop being a slow supplier and become a total instance outage, and the symptom would be unrelated requests timing out.

So the shape is two short transactions bracketing the call:

```
TX A   BEGIN; SELECT … FOR UPDATE; UPDATE … WHERE status = ANY('{paid}'); COMMIT;
————   POST {SUPPLIER_A_URL}/issue        ← no transaction, no lock held
TX B   BEGIN; SELECT … FOR UPDATE; …resolve, bind, finish…; COMMIT;
```

And the question that shape raises answers itself once asked: **if no lock is held during the supplier call, what stops a second worker calling the supplier?**

**The `delivering` claim does** — and it is a fact in the database rather than a lock. TX A's guarded UPDATE returns one row to exactly one worker and zero rows to every other, a worker holding zero rows does not call the supplier, and it cannot get one row later, because nothing in the system returns an order to `paid`. The claim outlives the transaction that took it, which is precisely what a row lock cannot do.

This is the trade being made, stated plainly: **exclusion during the network call is bought with a durable state change, not with a lock.** The lock's job is narrower — make the *claim decision* and the *outcome write* each atomic against another worker. Those are microseconds of Postgres apiece, with no network I/O in either.

The full picture from the log, captured under `log_statement = 'all'`. The supplier's own transaction sits entirely between A's `commit` and B's `begin`:

```
-- TX A (claimForIssuance)
begin
select … from "orders" where "orders"."id" = $1 for update
update "orders" set "status" = $1, "updated_at" = now()
  where ("orders"."id" = $2 and "orders"."status" = ANY($3)) returning …
                                    -- $1 = 'delivering', $3 = '{paid}'
commit

-- the supplier, over HTTP, in its own process and its own transaction
begin
update supplier_keys … for update skip locked
insert into supplier_requests …
commit

-- TX B (bindDelivery)
begin
select … from "orders" where "orders"."id" = $1 for update
update "issuance_attempts" set "status" = $1, "code" = $2 where …   -- 'ok'
insert into "deliveries" (…) values (…) on conflict ("order_id") do nothing returning …
update "orders" set "status" = $1 … = ANY($3) returning …           -- 'delivered', '{delivering}'
commit
```

Note what TX A used to be: **a bare guarded UPDATE with no `BEGIN` at all.** One autocommit statement. Adding the lock is what gave it a transaction.

### The signature that makes the useless version uncompilable

There is a way to write this lock that reads as protection and is not:

```ts
await database.select().from(orders).where(eq(orders.id, id)).for("update");  // on the pool
```

Taken on the pooled handle, the lock is acquired inside the implicit transaction of its own statement and released before the next line of TypeScript runs. It is held for nanoseconds. That is worse than no lock, because a reader sees `for update` and stops asking.

So:

```ts
async lockOrder(tx: Transaction, orderId: string): Promise<Order | undefined>
```

`Transaction`, never `Database`. No overload, no optional handle. The mistake is not discouraged by a comment — it does not compile. (`OrderTransitionService` keeps the same split for the same reason: `transition` for the pool, `transitionWithin` for a caller's `tx`. Calling the pool version from inside a transaction would ask `max: 1` for a second connection and wait on the one the caller is holding — a self-deadlock that surfaces at `CONNECTION_TIMEOUT_MS` looking nothing like its cause.)

---

## 3. The RED validation came back green, and that is the honest headline

This is the part to lead with in an interview.

The verifier removed `.for("update")` from `lockOrder`, rebuilt so the child processes really ran the weakened code, and ran the multi-process race test **five times — ten executions.** The check stayed green every time. Every assertion held with the lock gone. The file was then restored and re-verified byte-identical; `shasum -a 256` on the working tree in this session still reads `05fb569117baab091cda113e49ac4d88dd77a8f5ce16af332922917ea7d0333f`, with exactly one `for("update")` in the file.

The reason is the single best technical fact in this slice, and it is not "the test was weak":

**Two concurrent `UPDATE`s on the same row already serialise on that row's write lock, whether or not anybody took an explicit `SELECT … FOR UPDATE` first.** The second UPDATE reaches the row, finds it locked by the first's uncommitted write, and blocks. When the first commits, the second re-reads the newly committed version under READ COMMITTED and **re-evaluates its `WHERE` clause against it** — now `status = 'delivering'`, which does not match `'{paid}'` — and reports zero rows.

So `UPDATE orders SET status='delivering' WHERE id=$1 AND status='paid'` is *already atomic by itself*. The explicit lock moves the wait one statement earlier. It does not change who wins.

And that is what makes the whole path single-entry today: only one worker wins the claim, so **only one worker ever reaches transaction B** — and transaction B, being a multi-statement read-and-write, is the only place a missing lock could show up as a real double write. Behind that sit two more independent backstops:

| Backstop | What it catches |
|---|---|
| The guarded `paid → delivering` UPDATE | A second worker reaching the supplier at all |
| `deriveIssuanceRequestId` is deterministic (`FIRST_ISSUANCE_ATTEMPT` is always `1` in Phase 1) | Two workers that somehow both called: both send `req_{order}_a_1` |
| The supplier's `request_id → code` ledger (I5), and `deliveries.order_id` UNIQUE (I3) | The same id answered with the same code; a second delivery row refused |

So, plainly: **today the lock is defence in depth, not a load-bearing mechanism. It changes no currently-observable outcome.**

### The case for adding it anyway

Not "the architecture document said so". Two reasons, and a concession.

**1. Phase 3 is what makes it load-bearing.** Two things change at once there. The retry path stops deriving the request id from the order alone — `attempt` is incremented, and the increment comes from *reading `issuance_attempts` first*, so the id becomes a function of state that has to be read before it can be computed. And more than one worker legitimately reaches transaction B for one order: an admin re-issue racing a timeout retry is a normal operation, not a bug. At that point the guarded UPDATE stops guaranteeing "only one `bindDelivery` ever runs", the deterministic-id backstop is gone, and *"read the attempt row, classify `unknown` versus `failed`, choose re-probe or fall-through"* is exactly the multi-statement read-then-act that only a row lock can protect. The lock becomes the mechanism.

**2. The right time to add a lock is before the code that needs it.** Then that code lands on an already-serialised path. Retrofitting locks into a working system is where deadlocks come from: you add them one call site at a time, under pressure, and the ordering argument (§4) has to be reconstructed after the fact against code that was written assuming no lock existed.

**The concession.** *"You added a lock that does nothing"* is a fair challenge and it should be conceded rather than argued around. The answer is the two points above plus a measured one: on the current path it costs nothing (§4's convoy is TX A, two statements, no network). What it is not, is decoration justified by a document.

---

## 4. The four decisions inside `FOR UPDATE`

### `FOR UPDATE`, not `FOR NO KEY UPDATE` — measured, not asserted

`orders` has exactly two referencing tables, and both are written by issuance:

```
deliveries.order_id         REFERENCES orders(id)
issuance_attempts.order_id  REFERENCES orders(id)
```

An INSERT into either makes Postgres take `FOR KEY SHARE` on the parent row to prove it still exists. `FOR KEY SHARE` conflicts with `FOR UPDATE` and does **not** conflict with `FOR NO KEY UPDATE`. That is the entire difference between the two strengths, and it is measurable. A holder sleeps 3s; a second session inserts a `deliveries` row for that order:

```
holder holds 'FOR UPDATE'         -> concurrent INSERT INTO deliveries  2082.625 ms
holder holds 'FOR NO KEY UPDATE'  -> concurrent INSERT INTO deliveries     5.610 ms
```

The textbook advice is *"you are only changing `status`, not a key column — take the weaker lock and let foreign-key checks through."* That advice is right in general and wrong in this schema, for a specific reason: **the rows those FK checks are for are the exact rows being serialised.** The extra blocking is not collateral damage on some unrelated hot path; it is a second, independent layer of precisely the exclusion being bought. If a future code path inserts a `deliveries` row without taking the lock first, `FOR UPDATE` still makes it queue behind the worker that did. `FOR NO KEY UPDATE` would wave it through.

And nothing that matters is blocked, which is checkable rather than hopeful:

- `payment_events.order_id` carries **no** foreign key, deliberately (slice-3 §1), so webhook intake takes no lock on `orders` at all.
- The shopper's status poll is a plain `SELECT`, and under READ COMMITTED a plain reader never waits on a row lock.
- Order creation inserts a new row and touches nobody else's.

The honest cost, stated rather than discovered: `recordAttempt`'s INSERT into `issuance_attempts` runs **outside any transaction** and takes no lock, so its FK check can wait on a worker holding this lock in TX B. That wait is bounded by TX B — three statements, no network I/O — and it cannot deadlock, because the waiter holds no other lock while it waits.

### `FOR UPDATE`, not `SKIP LOCKED` — the opposite choice from the queue

`SKIP LOCKED` is used twice in this codebase and is right both times: the inbox drain, and the supplier's key claim. Both ask *"give me a unit of work nobody else has."* Any row will do; a locked row means somebody is already on it; stepping over it is how N workers fan out across N rows instead of queueing on one.

The order row asks a different question. It is not *a* unit of work, it is *the* order this worker was handed, and **there is no other row it could take instead.** Skipping would return zero rows, and zero rows here is actively harmful:

- It is indistinguishable from *"no such order"* — and those two must stay distinguishable, because `payment_events.order_id` has no FK and an event for an order that does not exist yet is a normal path that must be left pending rather than settled.
- It throws away the answer the loser needs. A worker that waits, gets the lock, and re-reads to find `delivering` or `delivered` knows the order is owned or finished and can settle its event honestly. A worker that skipped knows nothing, and would have to leave a settleable event in the queue forever.

The obvious objection is the project's own earlier measurement — twenty contending key claims convoyed at **959ms** under plain `FOR UPDATE` against **54ms** under `SKIP LOCKED`. It does not transfer, and the reason is **what this lock does not span**: the queue behind it waits for TX A, which is two statements and no network — not for the supplier call, which happens with no lock held. Twenty webhooks for one order serialise through a few hundred microseconds of Postgres and then nineteen of them discover, correctly and cheaply, that there is nothing for them to do.

**That convoy is not a cost to avoid. It is the serialisation being bought.**

`NOWAIT` is rejected for a related reason: it turns contention into an error, and contention here is the ordinary case rather than the exceptional one.

### Lock ordering — why this cannot deadlock

A deadlock needs two transactions each holding a lock the other wants. The property that rules it out is stronger and simpler than an ordering convention: **no transaction in this codebase ever waits on a second row lock while holding one it acquired in another table.**

- The inbox drain takes `payment_events … FOR UPDATE SKIP LOCKED` and **commits before it processes anything**, so an event lock is never held at the same time as an order lock.
- The supplier's key claim runs in its own transaction, in another process, reached over HTTP — at a moment when the calling worker is deliberately holding **nothing**, because the call sits between A and B.
- TX A locks one order row and writes that same row. One row, one table.
- TX B locks the order row, then writes its FK children — whose `FOR KEY SHARE` on that same row is already held by this transaction, and a transaction never conflicts with itself.

So the only ordering that exists anywhere is **parent row, then its FK children, taken by a transaction that already holds the parent.** Every contending transaction follows it. Nothing locks two orders; nothing locks an order and a supplier key. There is no cycle to form.

### The loser's path, which must be a clean no-op

Waits, acquires, re-reads, gets `not_in_source_state` from the guarded UPDATE, falls to `settleOrDeferPaidEvent`. **No write, no throw** — an exception here becomes a `500`, and a `500` is how you ask a payment provider to send the event again.

This is also where the lock earns something today even though it changes no outcome: it makes the race *readable*. `lockOrder` returns the whole row rather than `SELECT 1`, so every worker logs `locked_status` — what the order was the instant it got in. From the twenty-way race:

```
   1 paid          <- the single claim winner
  13 delivering    <- waited, got the lock, order already claimed. No-op.
   7 delivered     <- waited, got the lock, order finished. No-op, event settled.
```

Twenty lines, one field, and the whole shape of the race is in it — including the split between losers that arrived mid-issuance and losers that arrived after it finished, which is exactly the split that decides whether their event gets settled or left pending.

---

## 5. A correction to the record

Something asserted in an earlier project document is wrong, and saying so is worth more than quietly fixing it.

**The claim:** during Slice 3 it was written that multiple workers could currently reach the supplier and burn pool keys, citing `docs/walkthrough/slice-1-data-model.md` §5's *"twenty keys claimed"* measurement as evidence.

**Why it is wrong for today's issuance path:** all four processing triggers funnel through the one guarded `paid → delivering`, and nothing returns an order to `paid`. Even if two workers somehow both got through, `deriveIssuanceRequestId` is deterministic per attempt, so both would send `req_{order}_a_1`, the supplier's ledger (I5) would collapse them to one code, and the loser's rollback would un-claim the key it took.

**What Slice 1 §5 actually measured:** a different arm — twenty *distinct* request ids and **no claim step at all**. It is a correct and useful measurement of what happens without the claim guard. It does not describe the shipped issuance path, and citing it as though it did would be caught by any reviewer who opened the file.

This has been corrected in the Slice 3 walkthrough and in `docs/walkthrough/interview-notes.md`. It is recorded here too so the record is consistent across all three. The correction is itself the point worth telling: catching it required going and checking the measurement rather than repeating a sentence that sounded right.

---

## 6. What the verification actually showed

Two tests, deliberately different shapes.

**The existing fan-out race** — twenty concurrent webhooks, twenty distinct `event_id`s, one order, four separate API processes (ports 3000-3003, each with its own `max: 1` pool):

```
 events | deliveries | attempts | supplier_reqs | keys_claimed | final_status
     20 |          1 |        1 |             1 |            1 | delivered
```

**The new test, `order-lock-race.test.ts`** — a different question. Rather than N identical triggers, it puts **two different kinds of trigger** on one order across two processes: process A takes a `paid` event through the real webhook (which schedules its own continuation), process B runs a drain against a second pending event for the same order. Both fire in one `Promise.all`, never sequentially — the continuation begins executing synchronously up to its first `await` the moment `schedule()` is called, so a caller that waited for the webhook's `200` would usually find it already finished.

`pg_stat_activity`, sampled during the race window, consistently showed **two distinct Postgres backend pids live at once** — which is the thing an assertion count alone cannot establish, since "two processes genuinely raced" and "one process ran twice, sequentially" produce identical numbers.

Result: 1 delivery, 1 attempt, 1 supplier request, 1 key claimed, the unclaimed pool moved 50 → 49, order `delivered`, 0 events left pending.

**And the test found something its own header does not describe.** Instance A's continuation processes the row it just inserted **directly**, with no `SKIP LOCKED` claim on it — so instance B's sweep was free to grab and process that event *too*. B reported `claimed: 2`. Both of B's attempts landed as `deferred_order_in_flight`. That is a strictly stronger race than the one the test was written to stage, and the invariants held through it.

Suite: `pnpm --filter @game-shop/api run test` — **17/17 across 3 files.** Typecheck clean.

---

## 7. Where this sits in the assignment

Be accurate about this, because overstating it is easy and checkable.

`context/product/product-definition.md` §1.4 lists five adversarial scenarios. This slice **strengthens the mechanism behind #1** — 50 parallel `paid` webhooks → one issuance fact, one key consumed — and **settles no scenario that was not already settled.** §3 is why: the guarded UPDATE was already producing that outcome on its own.

Its role is twofold and neither part is a scenario:

1. **Complete invariant I4 as `architecture.md` §3 specifies it.** I4 is stated as a conjunction; half of a conjunction is not the invariant.
2. **Prepare the ground for Phase 3.** That is where the shop's issuance path stops being single-entry — the timeout retry re-probing supplier A with the same id, the fall-through to supplier B with a new one, and the admin re-issue, all of which can legitimately have two workers at one order.

| # | Scenario | Status after this slice |
|---|---|---|
| 1 | 50 parallel `paid` webhooks → one issuance fact, one key | Already settled; the mechanism now has its second layer. Proven across four processes, and across two processes with two different trigger kinds. |
| 2 | A repeated webhook with the same `event_id` changes nothing | Settled since Phase 1 by the `event_id` PRIMARY KEY. Unchanged here. |
| 3 | A webhook before its order, or out of order | Settled in Slice 3. Unchanged here. |
| 4 | Empty pool leaves the order recoverable; after restock, exactly one key | Half-won, unchanged here. The admin retry is Phase 3 — and is one of the two workers this lock was added for. |
| 5 | A promo code with limit N under parallel requests | Phase 5. Not started. |

---

## Interview questions this answers

**"You have a status-guarded UPDATE and a row lock doing the same job. Isn't one of them redundant?"**
They exclude different things. The guard excludes an illegal *transition* and its exclusivity lasts exactly one statement — the instant it commits it has no further opinion about anybody. The lock excludes another *worker* and lasts until COMMIT, so it can cover a decision spanning several statements. With only the guard, the winner of `paid → delivering` is alone for one statement and then shares a five-statement issuance with whoever else shows up. With only the lock, two workers that take it in turn both write `delivering` and both call the supplier, perfectly serialised, each burning a key. The lock serialises the workers; the guard decides.

**"Why not hold the lock across the supplier call? That would be simpler and obviously correct."**
Because the pool is `max: 1` per instance, which makes the connection a mutex rather than a resource with headroom. A transaction held across an HTTP round trip blocks every other database statement in that process — catalogue, order creation, webhook intake, every status poll — for up to `SUPPLIER_TIMEOUT_MS`, which is 2000ms. A slow supplier would become a total instance outage with unrelated requests timing out. So: two short transactions bracketing the call. And the exclusion for the call itself is not a lock at all — it is the `delivering` claim, a durable state change that outlives the transaction that made it. A worker that got zero rows from the guard does not call the supplier, and it cannot get one row later, because nothing returns an order to `paid`.

**"Did you prove the lock is necessary?"**
No, and that is the honest answer. I removed `.for("update")`, rebuilt so the child processes ran the weakened code, and ran the multi-process race five times — ten executions. Green every time. The reason is that two concurrent UPDATEs on one row already serialise on that row's write lock: the second blocks, and when it unblocks it re-evaluates its WHERE clause against the newly committed row under READ COMMITTED and matches zero rows. So `WHERE status = 'paid'` is already atomic by itself, only one worker ever reaches transaction B, and behind that sit the deterministic request id and the supplier's ledger. Today the lock is defence in depth, not a load-bearing mechanism.

**"Then it's dead code. Why is it in the diff?"**
It is a fair challenge and I'd concede the framing before answering it. Two reasons. Phase 3 makes it load-bearing: the retry path derives the request id from state it has to read first rather than from the order alone, and an admin re-issue racing a retry puts two legitimate workers into transaction B — at which point "read the attempt, classify unknown versus failed, choose re-probe or fall-through" is a multi-statement read-then-act that only a row lock protects. And the right time to add a lock is *before* the code that needs it, so that code lands on an already-serialised path. Retrofitting locks into a working system, one call site at a time, is where deadlocks come from. The measured fact that makes both arguments affordable is that it costs nothing on the current path.

**"Why `FOR UPDATE` rather than `FOR NO KEY UPDATE`? You're only changing `status`."**
That is the right default and it is wrong in this schema. `FOR KEY SHARE` — taken by the FK check on every child insert — conflicts with `FOR UPDATE` and not with `FOR NO KEY UPDATE`; measured at 2082ms versus 5.6ms for a concurrent `INSERT INTO deliveries`. The usual reasoning is that the extra blocking is collateral damage on unrelated writers. Here it isn't: the only two tables referencing `orders` are `deliveries` and `issuance_attempts`, which are the two writes issuance makes — so the blocking is a second independent layer of exactly the exclusion I'm buying. If a future path inserts a delivery without taking the lock, `FOR UPDATE` makes it queue; the weaker lock waves it through. Nothing else is affected: `payment_events` has no FK to `orders`, and the status poll is a plain SELECT, which never waits on a row lock.

**"You use `SKIP LOCKED` for the inbox and the key pool. Why not here?"**
Because those ask "give me a unit of work nobody else has", and any row will do. The order row is not *a* unit of work, it is *the* order this worker was handed — there is no other row to take. Skipping returns zero rows, which is indistinguishable from "this order does not exist yet", and that is a normal path here because `payment_events.order_id` has no FK. It would also throw away the answer the loser needs: a worker that waits, gets the lock and finds `delivered` can settle its event; a worker that skipped knows nothing and leaves a settleable event pending forever. The 959ms-vs-54ms convoy measurement from the key pool doesn't transfer, because of what this lock does *not* span — the queue waits for transaction A, two statements and no network, not for the supplier call. That convoy is the serialisation being bought, not a cost to avoid.

**"Can this deadlock?"**
No, and the argument is stronger than an ordering convention: no transaction here ever waits on a second row lock while holding one from another table. The drain commits its `payment_events` lock before it processes anything. The key claim happens over HTTP, in another process, at the one moment the worker deliberately holds nothing — between the two transactions. Transaction A locks one row in one table. Transaction B locks the order and then writes its FK children, whose `FOR KEY SHARE` on that same row is already held by the same transaction, and a transaction never conflicts with itself. The only ordering anywhere is parent, then children, taken by a transaction that already holds the parent. No cycle can form.

**"You turned a one-statement autocommit UPDATE into a four-round-trip transaction on a `max: 1` pool. Isn't that the occupancy problem you argued against elsewhere?"**
Same units, different frequency, and that's the whole answer. The gated status poll matters because it runs once a second per open page, unbounded in viewers and in seconds watched — occupancy there scales with something outside the shop's control. Transaction A runs once per payment event, which is bounded by actual payments, and it holds the connection for two statements with no network I/O. The measurement that would change my mind is the one from the poll gate: connection-time per unit of load. Nobody watches a payment webhook for an hour.

**"How did you test this, and how do you know two processes really raced?"**
Two shapes. The existing fan-out test fires twenty webhooks with twenty distinct `event_id`s at one order across four API processes, each with its own `max: 1` pool — twenty events, one delivery, one attempt, one supplier request, one key. The new one is a different question: two *different kinds* of trigger — a webhook's own scheduled continuation and a drain — at the same order, in two processes, fired in one `Promise.all`. And I don't rely on the assertion counts to establish concurrency, because "two processes raced" and "one process ran twice sequentially" produce identical numbers; `pg_stat_activity` sampled during the race window showed two distinct backend pids live at once. It also produced a race stronger than the one I wrote: instance A's continuation processes its row directly without taking a `SKIP LOCKED` claim, so instance B's sweep grabbed that event too — `claimed: 2`, both landing as `deferred_order_in_flight`, invariants intact.

---

## Source files

- `apps/api/src/orders/order-lock.service.ts` — the lock, and the argument for every choice in it
- `apps/api/src/orders/order-transition.service.ts` — I4's other half, `transition` vs `transitionWithin`
- `apps/api/src/payments/payment-event-processor.service.ts` — transaction A (`claimForIssuance`), and the loser's path (`settleOrDeferPaidEvent`)
- `apps/api/src/issuance/issuance.service.ts` — transaction B, both outcome paths (`bindDelivery`, `applyDefiniteFailure`)
- `apps/api/src/issuance/issuance-request-id.ts` — why `attempt` is in the id, and what Phase 3 changes
- `apps/api/test/concurrency/order-lock-race.test.ts` — the two-trigger, two-process contention test
- `apps/api/test/concurrency/key-claim-race.test.ts` — the fan-out race
- `apps/api/test/concurrency/support/db.ts` — `observeDistinctBackendPidsDuring`
- `packages/db/src/client.ts` — the `max: 1` rationale
- `context/product/architecture.md` §3, §3.1 — I4 and its exact SQL
- `docs/walkthrough/phase-2-slice-3-out-of-order.md` §8 — the corrected claim
- `docs/walkthrough/interview-notes.md` — the corrected claim

**On evidence:** the only check re-run while writing this document was `shasum -a 256` on `order-lock.service.ts`, which confirms the working tree matches the hash the verifier reported after restoring the file (`05fb5691…f0333f`) and that `for("update")` appears exactly once. Everything else is reported by other agents in this slice: the `log_statement = 'all'` capture of both transactions, the `FOR UPDATE` / `FOR NO KEY UPDATE` timing pair, the twenty-way `locked_status` histogram, the four-process and two-process race results including the `pg_stat_activity` pid sampling, the five-times-ten RED executions, and the 17/17 suite run. The 959ms/54ms convoy figure is older still — it comes from the supplier key-claim work in Phase 1, and is cited here as a number that does *not* apply.
