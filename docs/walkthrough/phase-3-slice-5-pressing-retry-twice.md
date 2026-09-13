# Phase 3 · Slice 5 — Pressing retry twice

> The operator's button, and the last of the phase's three keystones: **how a purchase is recovered long after it went wrong.** A person opens the recovery list, presses Retry on an order that failed while the shelf was empty, and the shopper gets exactly one key — whether the button was pressed once, five times in a row, or at the same instant from two machines.
>
> Three things carry this slice. **There is no admin-only path into issuance.** The retry is one call into the identical claim-under-lock and ladder the payment event takes, so every guarantee §2.5 asks for is a guarantee Phase 2 and slice 3 already proved, on this same code — and the `409` is zero rows from a guarded `UPDATE`, never an `if`. **A transition whose guard excludes nobody, shipped anyway.** `delivering → delivering` returns a row to both callers; what actually keeps two resumers to one key is the order row lock and the fact that both of them necessarily compute the same probe of the same outstanding id — and that is named as fragile rather than assumed safe. **And the ladder could not serve a retry**, which was found by measuring, fixed with one input the attempt rows genuinely cannot carry, and then proved by growing slice 3's exhaustion from 894,049 histories to 1,788,098 — because the old proof had silently stopped covering the whole input space.

---

## 1. What actually shipped

| # | Change | Where |
|---|---|---|
| 1 | `retryIssuance` (`out_of_stock, delivery_failed → delivering`) and `resumeIssuance` (`delivering → delivering`) — two rows in the transition table, **no new SQL and no new service method** | `apps/api/src/orders/order-transitions.ts`; `order-transition.service.ts` untouched |
| 2 | `IssuanceEntry` (`Automatic` / `Operator`), the `entryTransitions` and `entryRounds` tables, and `claimWithFirstMatching` — `runForOrder(orderId, entry)` is now the one way in | `apps/api/src/issuance/issuance-runner.service.ts` |
| 3 | `IssuanceRound` (`Continuing` / `Fresh`) and the `Fresh` arm of the ladder's last branch | `apps/api/src/issuance/issuance-ladder.ts` |
| 4 | `POST /api/admin/orders/:orderId/retry` — `200` with a report, `409` not stuck, `404` no such order; `IssuanceModule` added to `AdminModule`'s imports | `apps/api/src/admin/order-recovery.controller.ts`, `order-retry.service.ts`, `order-retry.types.ts`, `admin.module.ts` |
| 5 | The Retry button — per-row busy state, every outcome re-fetches the list, an unanswered retry is *unknown* | `apps/web/src/features/retry-order-delivery/`, `apps/web/src/pages/admin-recovery/` |
| 6 | Four-process races on the retry, and the round-axis exhaustion with its mutant | `apps/api/test/concurrency/operator-retry-race.test.ts`, `apps/api/test/unit/issuance-ladder.test.ts` |

Notice what change 1 says about the design: the operator's entire retry, at the lifecycle level, is two entries in a data table. The statement that applies them has not changed once across the phase. `IssuanceModule` exports `IssuanceRunnerService` and nothing else, so a second implementation — a lock taken in the admin module, a supplier called from it, a status written by it — cannot be assembled from that module's injector even by someone trying.

---

## 2. Keystone one — there is no admin-only path into issuance

### The whole retry is one line

```ts
await this.runner.runForOrder(orderId, IssuanceEntry.Operator)
```

That is `OrderRetryService.retry` with the reporting stripped away, and it is the same call the payment event's continuation, the shopper's status poll and the admin sweep make with `IssuanceEntry.Automatic`. The same transaction A — lock, read the ledger, claim, reserve — the same walk, the same transaction B, the same settlement. `IssuanceEntry` decides exactly one thing: **which lifecycle transitions this caller may claim the order with.** It decides nothing about the ladder, the supplier, the ids or the settlement, because those are the same code for everybody.

The rejected alternative is the one every deadline reaches for: a parallel retry implementation in the admin module, with its own lock and its own idempotency check. It would be a second thing to get right and the first thing to drift. Every guarantee §2.5 asks for — *pressing twice changes nothing*, *two operators get one key*, *a retry racing the automatic drain is safe* — is already a property of the order row lock (I4), the status-guarded `UPDATE` (I9), the supplier's ledger keyed on `request_id` (I5), the key claimed under `FOR UPDATE SKIP LOCKED` (I6) and `deliveries.order_id UNIQUE` (I3). Phase 2 and slice 3 proved every one of them on this code. Reusing the code reuses the proofs. Anything clever in the admin module would be a new mechanism needing new proof.

### `409` is zero rows from a guarded `UPDATE`, not an `if` on a status read

The operator's entry names two transitions, tried in order until one returns a row:

```sql
update "orders" set "status" = $1, "updated_at" = now()
where ("orders"."id" = $2 and "orders"."status" = ANY($3))
returning …;
-- retryIssuance:   $1 = 'delivering', $3 = '{out_of_stock,delivery_failed}'
-- resumeIssuance:  $1 = 'delivering', $3 = '{delivering}'   -- only if the first matched zero rows
```

Nothing on this path reads `orders.status` and decides whether to run. Each candidate is the same guarded statement the whole lifecycle uses, its `WHERE … status = ANY($3)` evaluated by Postgres against the row as it stands at that instant, and the decision is which of them returned a row. `409` is what *both matching zero rows* is called on the wire, and it is the only way to produce one.

The obvious implementation is one statement shorter — `switch (locked.status)` on the row the lock returned — and it is the check-then-act this whole project argues against. The value it branches on was true when the `SELECT` ran; the transition is written a statement later. Under this lock the window is currently empty, which is exactly what makes the mistake survive review and then survive the day the lock moves.

Applied twice each, inside one rolled-back transaction against the running database, this is what the three cases look like. `retryIssuance` on an `out_of_stock` order:

```
--- retryIssuance, first call            --- retryIssuance, second call, same row
 id                     | status          id | status
------------------------+------------    ----+--------
 walkthrough_s5_settled | delivering     (0 rows)
```

And on a `delivered` order, both candidates:

```
--- retryIssuance on a delivered order   --- resumeIssuance on a delivered order
 id | status                              id | status
----+--------                            ----+--------
(0 rows)                                 (0 rows)
```

Two zero-row results, no branch, and the endpoint calls it `409`. Reported from the four-process run: with `locked_status: 'payment_failed'`, every guarded claim matched zero rows, the answer was `409`, `orders.updated_at` was unchanged and zero attempt rows were written. Nothing ran — not "nothing was reported to have run".

### `200` and `409` are different news, and the difference has to reach the operator

This is the pair a hurried implementation collapses into one red message:

- **`409`** — *this order is not stuck.* Zero rows; nothing ran; the operator was looking at a list a few seconds old and somebody else — another operator, or the automatic drain — got there first. That is the system working, and the controller logs it at `log`, not `warn`.
- **`200` with `outcome: "still_out_of_stock"`** — *it is stuck, the retry ran correctly, and it is still stuck.* Every supplier was asked and every shelf was empty. This is §2.5's fifth criterion in full: the operator is told why, and the order stays in the list.

One says "you were looking at a stale list"; the other says "the shop is out of stock". Only the second is worth pressing again after a restock. Reported from the race suite: on a still-empty pool the retry answered `200 still_out_of_stock` with `delivered: false`, the order still read `out_of_stock`, no delivery row existed, and the order was still in the recovery list afterwards.

### R11 — automatic scheduled retrying is a deliberate omission

The obvious "improvement" to this endpoint is a timer: a cron entry, a `setInterval` in the admin page, a queue worker that re-walks the whole recovery list every thirty seconds. **It is not an oversight that none of those exists.**

A timer aimed at a failing supplier is how a small outage becomes a large one. Every stuck order retries on the same beat; each retry claims a key under `SKIP LOCKED`, calls a supplier that is already struggling, and — when that supplier answers by not answering — leaves another attempt row saying `unknown`, which the next tick probes again. One supplier's bad minute becomes a stampede against it, and the orders that were merely stuck become orders whose outcome nobody knows. Functional spec §3 puts it out of scope in as many words.

So the affordance is absent from top to bottom, on purpose: `POST` with **no body** (nothing to parameterise, nothing to sweep), one order id in the path (no "retry all"), no `Retry-After`, no `202` with a job id to poll, and a screen whose refresh is manual. A person decides that this order, now, is worth another call — and a person watching a supplier fall over stops pressing.

---

## 3. Keystone two — what `resumeIssuance` rests on now that its guard excludes nobody

### Demonstrated rather than described

Every other transition in this codebase is verified by the second call returning zero rows. This one has to demonstrate the opposite, because that is the truth about it. `delivering → delivering`, applied twice to the same `delivering` order, in the same rolled-back transaction as the cases above:

```
--- resumeIssuance, first call           --- resumeIssuance, second call, same row
 id                      | status         id                      | status
-------------------------+------------   -------------------------+------------
 walkthrough_s5_stranded | delivering    walkthrough_s5_stranded | delivering
```

**Both calls returned a row.** The guard matches every time, so it excludes nobody, so it cannot be the thing that keeps two retries apart. The statement is still not a no-op — it sets `updated_at = now()` and returns the row, which is how a resumed order is distinguishable from a stranded one and what gives the runner a `Transitioned` outcome to walk the ladder on — but as a guard it is empty.

### Why it exists at all — two plans reached opposite conclusions

The backend plan wanted the transition, so that an order stranded in `delivering` can be recovered. The data-layer plan argued the opposite, and its objection is exactly the measurement above: a guard that excludes nobody needs a mechanism this phase does not have, so a stranded order should be listed but not retryable.

Both halves are true, and the hole the first one names is real. If a worker dies mid-issuance — the platform kills the function mid-ladder (R5), the process is redeployed — the payment event stays pending, but every drain trigger claims with `beginIssuance`, whose `from` is `[paid]` and never matches `delivering`. **Without this row nothing in the system can move that order again**: not the sweep, not the shopper's poll, not the operator. Refusing the transition leaves a permanently unrecoverable state in the phase whose entire subject is recovery.

So it ships — operator-only, with its exclusion *stated* rather than assumed. The rejected alternative (A3) was a staleness threshold: resume only a `delivering` order older than N seconds. That is a knob whose correct value nobody can know, and functional spec §3 says nothing is hidden from the operator on a timer.

### What actually excludes the second caller — and neither of them is the guard

1. **The order row lock** (I4). Both resumers take `SELECT … FOR UPDATE` on the order as the first statement of transaction A, so the two claims are serialised: one reads the ledger, decides and commits before the other reads anything at all.

2. **The rung they both necessarily compute.** Under the lock they read `issuance_attempts` sequentially, and a stranded order's outstanding attempt is `unknown`, which the ladder answers with `probe`. **A probe writes no new attempt row** — its one write is the narrow `ON CONFLICT ("request_id") DO UPDATE SET "probe_count" = "probe_count" + 1` that slice 3 argued for — so the second reader sees the *identical* ledger and computes the *identical* rung: same provider, same attempt number, and therefore the same `request_id`, recomputed rather than remembered. The supplier's ledger (I5) answers the second ask with the code it already issued, so one key leaves the pool for two calls.

Read that second point again, because it is the whole of the safety argument and it is not in the transition table. Two workers computing the same rung from the same rows send the same id, and the ledger answers both identically — that is Phase 2's deterministic-id property, and it is what the guard has been quietly borrowing. I5 answers both resumers with the code it already cut; the guard contributed nothing.

### Proven under real contention

Two resumers from two different OS processes, one `Promise.all`, on an order staged in exactly the shape a dead worker leaves behind: `delivering`, with an `a/1` attempt reading `unknown` at `probe_count = 1`, and the supplier's ledger already holding a code under `req_{order}_a_1`. Reported from the four-process run:

```
one attempt row throughout: a/1, finally ok
probe_count 1 -> 2 -> 3
one supplier_requests row — the staged one; no second request id anywhere
one delivery
unclaimed pool count: unchanged before and after
```

`probe_count` is the fingerprint. It moved twice because *both* resumers got through the guard — as they must, since it excludes nobody — and both landed on `probe` of the same id. A `probe_count` of 2 would mean the second resumer never ran; a second row in `supplier_requests` would mean the second resumer asked a different question. The pool count not moving is the strongest line: the code both resumers delivered came from the pre-staged claim, and neither of them cut a new key.

### And it is fragile, which is why it is its own row — R3

Point 2 holds **only while every concurrent resumer lands on `probe`.** If a future change lets two resumers reach `fallThrough` from *different* snapshots — a rung that writes a row a probe did not, a ledger read moved out from under the lock (R4), a fall-through permitted while an attempt is still `unknown` — then two suppliers are asked two different questions, neither ledger can answer the other, and two keys leave the pool. `deliveries_order_id_key` still keeps the shopper to one, so the shop looks correct from outside. What breaks is stock accounting, and `count(*) FROM supplier_keys WHERE claimed_by_request_id IS NOT NULL` against `count(*) FROM deliveries` is the only assertion that can see it.

That is exactly why `resumeIssuance` is a separate row rather than `delivering` added to `retryIssuance`'s `from` list. Widened in there it would read as one more legal move, and the reasoning above would live only in a spec file. As its own entry it is where a reviewer looks, and its `from` list says in one line that its guard is not what protects it.

---

## 4. Keystone three — the ladder could not serve a retry, and the proof had to grow

### The failure, measured

Slice 2's ladder read "an untried supplier" in branch 5 as *a provider with no attempt row for this order*. That is correct for the automatic path, which walks A then B and stops. A retry arrives at an order where both already have rows — `a/1 failed, b/2 failed` — so branch 5 found nobody untried and the ladder fell to branch 6, `settleRefused`, and **re-settled the order without asking anyone.**

Measured on the first retry attempt: `200 still_out_of_stock` with `request_id: …_b_2` and no new attempt row. The endpoint reported a retry that had run correctly, and no supplier had been called. That fails §2.5's first criterion outright — a stuck order with a key available did not deliver — and it contradicts §1.2's own last row, which had said since the plan was written that an operator retry after both refused asks `a` at attempt `3` under `req_ord_x_a_3`.

The reason it read as correct is the same shape as slice 3's inequality. `a` refused and `b` refused is the *same set of rows* whether it was written a millisecond ago by the walk still running, or a week ago by a walk that settled the order and went home. And the two need opposite answers: mid-walk, every supplier having refused means there is nobody left to ask; at the opening of a retry, those rows are *history*, not a verdict — the whole reason a person pressed the button is that something has changed since.

### The fix — one input the attempt rows genuinely cannot carry

```ts
export const IssuanceRound = {
  Continuing: "continuing",   // the default: every rung after the first of a walk
  Fresh: "fresh",             // the opening turn of an operator entry, and nothing else
} as const;
```

The runner carries it as a table beside the transitions, total over the entries so an entry added without saying what it means stops the build:

```ts
const entryRounds = {
  [IssuanceEntry.Automatic]: IssuanceRound.Continuing,
  [IssuanceEntry.Operator]: IssuanceRound.Fresh,
} as const satisfies Record<IssuanceEntry, IssuanceRound>;
```

**Only the opening turn gets it.** Every recomputation inside the walk takes the default, which is how one retry buys one more round and not an unbounded number of them. `Automatic` is `Continuing` and must stay that way: its claim requires `paid`, so an order it can claim has no attempt rows at all and the branch is unreachable from it — but if that ever changed, a payment event that opened a fresh round on a settled order would re-ask both suppliers every time it was redelivered.

And the branch it feeds is the **last** one. Under `Fresh`, "every supplier refused" becomes `askFirst` at `max(attempt) + 1` instead of `settleRefused`; under `Continuing` nothing changes. **The `Fresh` arm sits below the outstanding guard.** An order with an `unknown` attempt still probes and still settles rather than asking anybody new, because branches 2 and 3 return before branch 6 is reached. "The operator asked for it" is not a reason to obtain a second key for a request whose outcome nobody knows.

The rejected alternative was to synthesise the rung in the runner — detect the operator entry, see both providers refused, and hand the walk an `askFirst` step the ladder never computed. That is the second path into issuance the design exists to prevent, one level down: a rung the exhaustion test never sees, decided by code that is not the pure function.

### The proof had to grow

Slice 3 exhausted 894,049 ladder histories — every ordered tuple of length 0 to 3 over a 96-row alphabet — and found zero violations of the hard rule. Every one of those calls passed three arguments, which is `round = Continuing` by default. **The test never once evaluated `Fresh`.** It still exhausted the attempt-history space, but the ladder's input space had grown by an axis, and "the `Fresh` branch sits below the guard" was true by reading the source, not by exercising it. The technical considerations recorded that gap in as many words: proven for `Continuing`, argued structurally for `Fresh`.

So the alphabet was extended with the round axis. The same 96 rows, the same 0-to-3-length histories, each evaluated under both rounds, checking two properties. Re-run while writing this document:

```
issuance ladder round-axis exhaustion —
  checked=1788098 (2 × 894049)
  reachedProbeFresh=260368
  reachedNeverEstablishedFresh=520736
  reachedSettleRefusedContinuing=6272
  convertedToAskFirstUnderFresh=6272
```

**Property 1 — the hard rule under either round.** An unsettled history never reaches `fallThrough` and reaches only `probe` or `settleNeverEstablished`, with `Fresh` set on every one of them. Zero counterexamples across all 1,788,098. And the two `Fresh` counts are worth reading beside slice 3's: 260,368 histories reach `probe` and 520,736 reach `settleNeverEstablished` — **exactly the numbers the `Continuing` run produced.** `Fresh` changed nothing above branch 6, which is what "cannot reorder the guard" means when it is checked rather than read.

**Property 2 — `Fresh`'s own job.** On every history where `Continuing` reaches `settleRefused`, `Fresh` must instead reach `askFirst` at `max(attempt) + 1`. **6,272 of 6,272.** That is §1.2's last row proven over every fully-refused history the alphabet can build, rather than the one hand-picked example.

Not vacuous, on both counts: the test asserts every counter is non-zero, and asserts the total is exactly `2 × (1 + 96 + 96² + 96³)`, so a refactor that silently shrinks the space — or silently stops evaluating one round, which is the mistake this block exists to close — cannot pass by checking less.

### And the mutant

The one mistake §1.1 names is moving the `Fresh` branch above the outstanding guard. The RED for it is a mutant reimplementation in the test file — identical decision, one change, spelled out at the point it differs — rather than an edit-and-restore of the production file, because the agent writing the test may not touch the source even transiently. Run against every pair the alphabet can build:

```
issuance ladder mutant RED — checked=9216 pairs, mutantViolations=1024
apps/api/src/issuance/issuance-ladder.ts sha256 = a5715427c387d7d27c9ac9d58a089dd1d68c80c6c9a762211e83972192b86a24 (unmodified throughout this suite)
```

**1,024 violations against 0** for the shipped ladder on those same histories — and the test asserts the second half too: on every history the mutant violates, the real `nextIssuanceStep` still returns `probe` or `settleNeverEstablished`. The first counterexample is the whole story in one row: `[a/1 failed, b/1 unknown]` — every provider has been tried, none issued, and the mutant answers a `Fresh` retry with `askFirst` at a new attempt number while `b/1` is still outstanding. A brand-new question to a supplier while another supplier may already hold a key. The sha256 is reported rather than diffed because the suite makes exactly one filesystem read of the source and never a write; "restored byte-identical" is true by construction.

**That mutant is not an abstract weakening — it is the live shape of the delivery-failed race in §5.** A second operator retry arriving after the winner's claim reads `[a/1 failed, b/2 failed, a/3 unknown]` with `round = Fresh`. The shipped ladder probes `a/3`. The mutant would mint `a/4` and ask A a second question while `a/3` is outstanding — two keys leave the pool, `deliveries_order_id_key` keeps the shopper to one, and stock accounting is the only assertion that moves. That is R3's "a fall-through permitted while an attempt is still `unknown`", and the 1,024 is what it costs.

### R7 held

The retry after both refused minted `a/3` — `req_{order}_a_3`, provider `a`, attempt `3`, numbered per order across both providers — and never `a/1`. Reusing attempt 1 would recompute `req_{order}_a_1`, collide on `issuance_attempts_request_id_key`, be swallowed as a re-probe of a settled request, and leave the order permanently unable to be issued. `max(attempt) + 1` across all the order's attempts is the rule, and `UNIQUE (order_id, attempt)` turns the same mistake made elsewhere into a `23505` rather than a silent reuse. The four-process run asserts a *third* attempt row with exactly that id.

---

## 5. A subtlety that reads as a bug

Two concurrent retries on a `delivery_failed` order, from two processes, **both returned `200 delivered`** — not one `200` and one `409`. That is correct, and a test asserting "one must `409`" would fail against a correct system. It is the same shape as slice 3's stock-accounting correction, where asserting the equality everywhere failed against the honest meaning of `unknown`.

Walk the loser through. Its transaction A runs after the winner's has committed, so it reads `[a/1 failed, b/2 failed, a/3 unknown]` under the lock and computes `probe` of `a/3` — the guard, not `Fresh`. Its `retryIssuance` matches zero rows because the order is now `delivering`; its `resumeIssuance` matches one. It increments `a/3`'s `probe_count`, commits, and asks A under `req_{order}_a_3` — byte-identical to the winner's question. A's ledger answers with the code it already cut for the winner (or, if both asks arrive before either claim commits, `supplier_requests_pkey` decides and the loser re-reads the winner's code — §8's fourth race row). The loser now holds the right key. Its transaction B inserts into `deliveries` — `ON CONFLICT DO NOTHING`, no-op — and its `completeDelivery` matches zero rows because the winner already moved the order to `delivered`. That zero-row result is not thrown away: `finishOrder` returns the status the follow-up read observed, which is `delivered`, and the walk reports `Delivered`.

Reporting success to the second operator is honest. The shopper *does* hold a key; it is the key this call itself fetched, off the same ledger row; the retry obtained the right code and simply was not the one that got to write it down. Telling that operator "failed" would be the lie, and it would teach them to press again.

The database is unambiguous whichever status the loser gets: three attempt rows (`a/1`, `b/2`, and exactly one new `a/3`, never a rogue fourth), one delivery, one claimed key, claimed keys equal to deliveries. The race suite asserts those and accepts `[200, 409]` for the responses, requiring only that at least one is `200` and none is `500`. If the loser's transaction A had instead run after the winner's B, the order would already read `delivered`, both candidates would match zero rows, and the answer would be a clean `409` — also honest, also the same database.

---

## 6. The client's half

**The disabled button is a courtesy, not the protection.** §2.5's fourth criterion is two operators on two machines, and no client state is shared between them. The guarantee is the order row lock, the guarded `UPDATE`, `deliveries.order_id UNIQUE` and the supplier ledger; remove the `disabled` line and no guarantee changes. That is also why the check must not be a click test: a verification that clicks Retry twice in one browser and finds one key proves only that the button was disabled — it cannot fail against a broken server, therefore it cannot pass either. §2.5's third and fourth criteria are exercised as concurrent `POST`s from separate processes, asserted against the database.

**Busy state is per order id, never global.** Two stuck orders can be retried at once; disabling the table would serialise the operator behind the slowest supplier call.

**Every outcome re-fetches the whole list.** The endpoint is the authority and the button's opinion is discarded. A consequence: notices live in a node the page re-inserts, not in the row, because the re-fetch destroys the row — including the delivered one, which leaves the list entirely and would take its own good news with it.

**An unanswered retry reads as *unknown*, not as failure.** `fetch` rejecting, and any `5xx`, both produce *"the retry request did not come back. It may or may not have run — refresh to see."* This is the phase's own thesis pointed at the operator, who is in exactly the position the shop is in when a supplier goes quiet: the claim-under-lock, the supplier call and the `deliveries` insert all happen before any byte of the response is written, so a lost answer may well have delivered a key. Reporting "retry failed" would teach the operator to press again against a supplier that already answered — the precise habit this phase exists to break. A `409`, by contrast, is a request that was understood, refused, and demonstrably did no work, and the notice says so in those words: *nothing was retried … the row you pressed was already out of date.*

**Refresh is manual.** §2.4's "without waiting for any period" is a statement about the server not hiding orders behind a grace period, not a request for auto-refresh — and an admin tab left open on a second monitor, polling every second, would be the one page in the shop holding the `max: 1` connection for nobody's benefit.

---

## 7. Where this sits in the assignment

This slice settles **functional spec §2.5** — *an operator can push a stuck order through, and pressing twice changes nothing* — and all six of its criteria:

| Criterion | Settled by |
|---|---|
| A stuck order and a key available: the shopper gets it and the order leaves the list | `retryIssuance` into the same walk; `Fresh` turning `settleRefused` into `askFirst` at `a/3` |
| Out of keys, restocked, retried: exactly one key | the same claim, ledger and constraints the automatic path uses — one delivery, one claimed key, claimed keys equal to deliveries |
| Several presses in quick succession: one key, one left the stock | `retryIssuance` matching one row then zero; every later press `409` with nothing written |
| Two operators at the same moment: one key | the order row lock serialising the claims, and both computing the same rung of the same id |
| Still no key available: told why, and the order stays in the list | `200 still_out_of_stock`, distinct from `409`, and the re-fetched list |
| Not stuck: refused rather than re-delivered | zero rows from every guarded `UPDATE`, never an `if` |

Against `product-definition.md` §1.4's five adversarial scenarios, this is the first one Phase 3 closes outright:

| # | Scenario | Status after this slice |
|---|---|---|
| 1 | 50 parallel `paid` webhooks → one issuance fact, one key | Settled in Phase 1, strengthened in Phase 2. Not extended here. |
| 2 | A repeated webhook with the same `event_id` changes nothing | Settled since Phase 1 by the `event_id` PRIMARY KEY. Untouched. |
| 3 | A webhook before its order, or out of order | Settled in Phase 2 slice 3. Untouched. |
| 4 | Empty pool → recoverable state → after restock, exactly one key | **Closed.** Slice 1 made the state recoverable, slice 4 made it findable, slice 3 built the mechanism, and this slice is the retry: empty pool, `out_of_stock`, restock, one press, `a/3` issued, one delivery, one claimed key, the order gone from the list. |
| 5 | A promo code with limit N under parallel requests | Phase 5. Not started. |

The honest summary: the fourth scenario is the assignment's own sentence — *"after restocking, re-issuance yields exactly one key"* — and the answer to it is that re-issuance is not a new thing. It is the same issuance, entered by a person instead of a payment event, and everything that made the first issuance yield exactly one key makes the second one do the same.

---

## Interview questions this answers

**"Where is the admin retry implemented?"**
It is not, in the sense the question means. `OrderRetryService.retry` is one call — `runner.runForOrder(orderId, IssuanceEntry.Operator)` — into the identical claim-under-lock and ladder walk the payment event takes. The entry decides exactly one thing: which transitions this caller may claim the order with. `Automatic` gets `beginIssuance`, `paid → delivering`; `Operator` gets `retryIssuance`, from `out_of_stock` or `delivery_failed`, and then `resumeIssuance`, from `delivering`. Everything after the claim is the same code for both. That is why §2.5's guarantees are free: pressing twice, two operators, a retry racing the drain — none of those is defended by anything in the admin module, because the order row lock, the guarded `UPDATE`, the supplier ledger, `SKIP LOCKED` and `deliveries.order_id UNIQUE` already defend them, and Phase 2 and slice 3 proved every one on this code. A parallel implementation with its own idempotency would be a second thing to get right and the first to drift. `IssuanceModule` exports the runner and nothing else, so a second one cannot even be assembled from that module's injector.

**"How does the endpoint decide to answer `409`?"**
It does not decide; Postgres does, and the endpoint names the result. The operator's two transitions are tried in order, each a guarded `UPDATE … WHERE id = $2 AND status = ANY($3)`, and `409` is what both matching zero rows is called on the wire. Nothing reads `orders.status` and branches. The obvious version — `switch (locked.status)` on the row the lock returned — is one statement shorter and is the check-then-act this project exists to forbid: the value was true when the `SELECT` ran, the transition is written a statement later, and under the current lock the window happens to be empty, which is exactly why the mistake would survive review. I ran the three cases against the live database: `retryIssuance` on an `out_of_stock` order returns one row then zero; on a `delivered` order both candidates return zero. That second result is the `409`, and it is a fact about a write that did not happen, not a guess about the list.

**"What's the difference between a `409` and a `200 still_out_of_stock`? Both mean the order is still stuck."**
No — only one of them means that, and collapsing them is the mistake. `409` means *this order is not stuck*: zero rows, nothing ran, the operator's list was a few seconds old and somebody else got there first. `200 still_out_of_stock` means *it is stuck, the retry ran correctly, and it is still stuck*: a supplier was asked and had nothing. One says "stale list", the other says "out of stock", and only the second is worth pressing again after a restock. §2.5's fifth criterion requires the operator to be told why and the order to remain in the list, and the measurement is that it did: `delivered: false`, the order still `out_of_stock`, no delivery row, and still listed. The client renders them as two different sentences for the same reason.

**"Why not retry automatically on a timer? It seems strictly better than making a person press a button."**
Because a timer against a failing supplier turns one bad minute into a stampede. Every stuck order retries on the same beat, each retry claims a key under `SKIP LOCKED` and calls a supplier that is already struggling, and when that supplier answers by not answering, each retry leaves another `unknown` attempt for the next tick to probe. The merely-stuck orders become orders whose outcome nobody knows. The spec puts it out of scope in as many words, and R11 names it as the obvious "improvement" that must not be added without the phase that thinks it through. So the affordance is absent by construction: `POST` with no body, one id in the path, no "retry all", no `202` with a job to poll, and a manual refresh. A person watching a supplier fall over stops pressing; a timer does not.

**"`delivering → delivering` matches every time. What stops two operators from double-issuing a stranded order?"**
Not the guard — I applied it twice to the same row and both calls returned a row, which is the opposite of every other transition in the codebase. Two things stop them, and neither is in the transition table. First, the order row lock: both resumers take `SELECT … FOR UPDATE` as the first statement of transaction A, so one reads the ledger, decides and commits before the other reads anything. Second, the rung they both necessarily compute: a stranded order's outstanding attempt is `unknown`, the ladder answers `probe`, and a probe writes no new attempt row — its only write is `probe_count + 1` — so the second reader sees the identical ledger and computes the identical rung, the same provider, the same attempt, the same `request_id` recomputed rather than remembered. The supplier's ledger answers the second ask with the code it already issued. Under contention from two processes: one attempt row throughout, `probe_count` 1 → 2 → 3, one ledger row, no second request id anywhere, one delivery, and the unclaimed pool count unchanged before and after — the code both resumers delivered came from the pre-staged claim.

**"Then why ship a transition whose guard does nothing?"**
Because refusing it leaves a permanently unrecoverable state in the phase whose subject is recovery. Two plans disagreed: the backend plan wanted it so a worker that died mid-ladder — the platform killing the function, a redeploy — leaves an order somebody can recover; the data-layer plan objected that a guard which excludes nobody cannot be the mechanism. Both are right. The hole is that every drain trigger claims with `beginIssuance`, whose `from` is `[paid]`, which never matches `delivering` — so without this row nothing in the system can ever move a stranded order again: not the sweep, not the poll, not the operator. It ships operator-only, with its exclusion stated rather than assumed, and the rejected alternative was a staleness threshold, a knob whose correct value nobody can know.

**"What would break it?"**
Anything that lets two resumers reach `fallThrough` from different snapshots — a rung that writes a row a probe did not, the ledger read moved out from under the lock, a fall-through permitted while an attempt is `unknown`. Then two suppliers get two different questions, neither ledger can answer the other, and two keys leave the pool. The shopper still gets one, because `deliveries.order_id` is UNIQUE, so the shop looks correct from outside; what breaks is stock accounting. That is R3, it is why `resumeIssuance` is its own row with its own comment rather than a third state in `retryIssuance`'s `from` list, and it is why the race test asserts claimed keys against deliveries rather than the shopper's key count. The mutant in the unit suite — `Fresh` above the guard — is the same failure at the ladder level, and I can show it costs 1,024 violations.

**"The retry didn't work the first time. What went wrong?"**
The ladder could not serve it. Branch 5 read "untried" as *no attempt row for this provider*, which is correct for the automatic path — it walks A then B and stops — but a retry arrives at an order where both providers already have rows, so branch 5 found nobody untried and the ladder fell to `settleRefused` and re-settled the order without calling anyone. Measured: `200 still_out_of_stock` with `request_id: …_b_2` and no new attempt row. That fails §2.5's first criterion and contradicted the plan's own table, which had said since the start that a retry after both refused asks `a` at attempt 3. The interesting part is *why* it read as correct: `a` refused and `b` refused is the same set of rows whether it was written a millisecond ago by a walk still running or a week ago by one that settled and went home, and the two need opposite answers. The rows cannot carry that fact. So the caller does.

**"Why a `round` argument and not a column on the attempt row? Or a special case in the runner?"**
A column cannot hold it, because the fact is not about the rows — it is about *who is asking*, and the same rows are read by both. So `IssuanceRound` is the entry point's fact: `Continuing` by default for every rung inside a walk, `Fresh` only on an operator entry's opening turn, carried in a table `satisfies Record<IssuanceEntry, IssuanceRound>` so an entry added without saying what it means stops the build. It is read by exactly one branch, the last one, which under `Fresh` turns "every supplier refused" into `askFirst` at `max(attempt) + 1`. One retry buys one round because only the opening turn gets it. The alternative was synthesising the rung in the runner — detect the operator, see both refused, hand the walk an `askFirst` the ladder never computed — and that is the second path into issuance the design forbids, one level down: a rung the exhaustion never sees, decided outside the pure function.

**"Slice 3 exhausted 894,049 histories. Doesn't that already cover this?"**
It did not, and saying so plainly is the point. Every one of those calls passed three arguments, which is `round = Continuing` by default, so the test never once evaluated `Fresh`. The input space had grown by an axis and the proof had not; "the `Fresh` branch sits below the guard" was true by reading the source. The technical considerations recorded exactly that — proven for `Continuing`, argued structurally for `Fresh` — and this slice's verification closed it by extending the alphabet with the round axis: the same 96 rows and the same histories, each evaluated under both rounds. 1,788,098 checks, zero violations of the hard rule under either round, and the `Fresh` counts for `probe` and `settleNeverEstablished` — 260,368 and 520,736 — are identical to the `Continuing` counts, which is what "changes nothing above branch 6" looks like when it is measured. And `Fresh` does its own job on every history where it should: 6,272 of 6,272 `settleRefused` histories convert to `askFirst`. The total is asserted as exactly `2 × (1 + 96 + 96² + 96³)`, so a refactor that quietly stops evaluating one round cannot pass by checking less.

**"How do you know the extended test can fail?"**
A mutant with the `Fresh` check moved above the outstanding guard — the one reordering §1.1 forbids — produces 1,024 violations across the 9,216 two-row histories, and on every one of those the shipped ladder still returns `probe` or `settleNeverEstablished`. The first counterexample is `[a/1 failed, b/1 unknown]`: every provider tried, none issued, and the mutant answers a retry with a brand-new `askFirst` while `b/1` is still outstanding. That is not abstract: it is exactly what a second operator's retry would do in the live delivery-failed race if `Fresh` outranked the guard — read `[a/1 failed, b/2 failed, a/3 unknown]` and mint `a/4` instead of probing `a/3`. The mutant is a reimplementation in the test file rather than an edit of the source, because the agent writing it may not touch production code even transiently; the suite reports the source's sha256 from its single read rather than a before/after diff, which is the honest form of "restored byte-identical" when nothing was changed.

**"Two concurrent retries both came back `200 delivered`. Isn't that a double issue?"**
No, and a test that asserted one of them must `409` would fail against a correct system. The loser's transaction A ran after the winner's, read `a/3 unknown` under the lock, and computed a probe of the same id — the guard, not `Fresh`. Its `retryIssuance` matched zero rows, its `resumeIssuance` matched one, and it asked A the byte-identical question, which A's ledger answered with the code it had already cut for the winner. So the loser was holding the right key. Its `deliveries` insert was an `ON CONFLICT DO NOTHING` no-op, its `delivering → delivered` matched zero rows, and the follow-up read observed `delivered` — which the walk reports as delivered, honestly, because the shopper does hold the key this call fetched. Telling that operator "failed" would be the lie, and it would teach them to press again. The database is unambiguous: three attempt rows, exactly one new, one delivery, one claimed key. The suite asserts those and accepts either status for the loser.

**"Why is the disabled button not the protection?"**
Because §2.5's fourth criterion is two operators on two machines, and no client state is shared between them. The lock, the guarded `UPDATE`, the UNIQUE on `deliveries.order_id` and the supplier ledger are the protection; remove the `disabled` line and no guarantee changes. Which is also why the verification is not a click test: clicking Retry twice in one browser and finding one key proves only that the button was disabled — it cannot fail against a broken server, therefore it cannot pass either. The races are concurrent `POST`s from separate OS processes, asserted against the database.

**"An operator presses Retry and gets a `504`. What do they see?"**
*"The retry request did not come back. It may or may not have run — refresh to see."* Not "failed". The claim, the supplier call and the `deliveries` insert all happen before any byte of the response is written, so a lost answer may well have delivered a key, and an operator told "failed" presses again against a supplier that already answered — the exact habit this phase exists to break. That is the phase's thesis applied to the operator, who is in the position the shop is in when a supplier goes quiet. A `409` is the opposite case: understood, refused, demonstrably did nothing, and the notice says so. Every outcome re-fetches the list, because the endpoint is the authority and the list is the truth.

**"What does this slice settle in the assignment, honestly?"**
Functional spec §2.5, all six criteria, and the fourth adversarial scenario outright — the first one Phase 3 closes. Empty pool, `out_of_stock`, restock, one press, `a/3` issued, one delivery, one claimed key, the order gone from the list. Scenarios 1 to 3 were Phases 1 and 2; scenario 5 is Phase 5. The sentence I would give a reviewer is that "re-issuance yields exactly one key" is true because re-issuance is not a new thing: it is the same issuance entered by a person instead of a payment event, and everything that made the first one yield one key makes the second one do the same.

---

## Source files

- `apps/api/src/admin/order-retry.service.ts` — the one-line retry, why the file is deliberately almost empty, what the `409` is and is not, and the advisory read-back
- `apps/api/src/admin/order-recovery.controller.ts` — the route, `@HttpCode(200)`, `409` as zero rows rather than an `if`, and R11 as a deliberate omission
- `apps/api/src/admin/order-retry.types.ts` — the four outcome words, why none of them is the `409`, and why there is nowhere to put a key
- `apps/api/src/admin/admin.module.ts` — `IssuanceModule` as the slice's one new edge, and the module-distance argument re-checked
- `apps/api/src/orders/order-transitions.ts` — `retryIssuance` and `resumeIssuance`, the two plans, what actually excludes the second caller, and R3
- `apps/api/src/issuance/issuance-runner.service.ts` — `IssuanceEntry`, `entryTransitions`, `entryRounds`, `claimWithFirstMatching` and the `switch` it refuses to be, and transaction A with the round read before the claim
- `apps/api/src/issuance/issuance-ladder.ts` — `IssuanceRound`, the one fact the rows cannot carry, and the `Fresh` arm below the guard
- `apps/api/src/issuance/issuance.service.ts` — `finishOrder` returning the observed status on zero rows, which is why the loser reports honestly
- `apps/api/src/issuance/issuance-history.ts` — `countProbeWithin`'s narrow `ON CONFLICT DO UPDATE`, the write that lets two resumers see one ledger
- `apps/web/src/features/retry-order-delivery/api/retry-order-api.ts` — the classification of everything that can come back, and what counts as "the answer did not come back"
- `apps/web/src/features/retry-order-delivery/ui/retry-controls.ts` — per-row busy state, the notice for each outcome, and the `409` sentence
- `apps/api/test/concurrency/operator-retry-race.test.ts` — why two races and not one, why it must not be a double-click test, the staged stranded order, and the `[200, 409]` acceptance
- `apps/api/test/unit/issuance-ladder.test.ts` — the round-axis exhaustion, the mutant reimplementation, and the sha256
- `context/product/architecture.md` §3 (I3, I4, I5, I6, I9)
- `context/spec/003-failure-and-recovery/technical-considerations.md` §1.1 (the amendment), §1.2, §2.2, §2.3, §2.5, §6, §8, §9.4, §11 (R3, R7, R11)
- `context/spec/003-failure-and-recovery/functional-spec.md` §2.5, §3
- `docs/walkthrough/phase-3-slice-3-silence-is-not-failure.md` — the probe rung, the deterministic id, and the stock-accounting assertion this slice's races rest on
- `docs/walkthrough/phase-3-slice-4-finding-the-stuck-orders.md` — the list the button sits on, and why it includes the stranded `delivering` order this slice's `resumeIssuance` exists for

**On evidence:** the following were run fresh while writing this document, against the tree and the local Postgres container as they stand. `pnpm -r run typecheck` across all four workspace projects — `packages/contracts`, `packages/db`, `apps/api`, `apps/web` — all Done. `vitest run test/unit/` in `apps/api`: **2 files, 26 tests passed** in 728 ms. The exhaustion counts in §4 are from my own run of `issuance-ladder.test.ts` with the verbose reporter: `checked=1788098 (2 × 894049)`, `reachedProbeFresh=260368`, `reachedNeverEstablishedFresh=520736`, `reachedSettleRefusedContinuing=6272`, `convertedToAskFirstUnderFresh=6272`; the mutant's `checked=9216 pairs, mutantViolations=1024` with its first counterexample `[a/1 failed, b/1 unknown] → askFirst`; and the ladder source's sha256 `a5715427…86a24` as the suite reported it. The transition demonstrations in §2 and §3 are my own, through `psql` against the running container: two throwaway orders inserted inside one transaction, `resumeIssuance`'s statement applied twice to a `delivering` order and returning a row both times, `retryIssuance`'s applied twice to an `out_of_stock` order and returning one row then zero, then both applied to a `delivered` order and returning zero each — all rolled back, with a final count confirming zero rows left behind, and the database at its baseline of 0 orders, 0 attempts, 0 deliveries, 50 keys, 0 claimed. I also read `claimWithFirstMatching`, `entryRounds`, transaction A's ordering of the ladder computation before the claim, the `Fresh` arm's position below the outstanding guard, and `finishOrder`'s `NotInSourceState` return directly, rather than taking the comments' word for them.

Everything else is reported by other agents in this slice and is **not** re-verified here: the four-process runs and every line quoted from them — the stranded-order race with `probe_count` 1 → 2 → 3 and the unchanged pool count, the delivery-failed race with both responses `200 delivered` and exactly one new `a/3` row, the `locked_status: 'payment_failed'` refusal with `updated_at` unchanged and zero attempt rows, the still-empty-pool retry answering `still_out_of_stock` with the order remaining listed, the repeated-press `409`s writing nothing, and the restock-and-retry run itself; the original `still_out_of_stock` with `request_id: …_b_2` measurement that exposed the ladder's gap; the 25–65 ms issuance timing behind A8; and the browser verification of the button's states and the screenshots under `docs/screenshots/`. No source file was modified by this task, no server was started, and the one temporary SQL script lives in the session scratchpad rather than the repository.
