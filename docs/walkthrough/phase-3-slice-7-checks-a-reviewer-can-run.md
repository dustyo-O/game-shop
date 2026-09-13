# Phase 3 · Slice 7 — Checks a reviewer can run

> Phase 2's slice 6 built the harness and put the first five checks on it. This slice puts the recovery promises on the same harness: `pnpm race` runs **eight** checks now, three of them new — a supplier that refuses, a supplier that goes quiet, and an order recovered after the shelf was restocked. Functional spec §2.7 names exactly those three and makes their existence an acceptance criterion.
>
> The headline is the same shape as Phase 2's, and sharper. Every one of the three new checks went red when its mechanism was weakened — no null result this time. But under **every** weakening, **every assertion phrased about the shopper stayed green**: the order settled `delivered`, there was exactly one `deliveries` row, the shopper got one key. What caught a broken ladder was attempt rows, request ids and stock accounting, never the shopper's experience. Phase 2 learned that RED validation tells you which invariant a check actually guards. This slice has three more data points, and they all point at the same place.
>
> Four of the assignment's five adversarial scenarios are now settled **and runnable by name**. The fifth is Phase 5.

---

## 1. One command, eight checks, four processes

```sh
pnpm race
```

Unchanged in shape from Phase 2: build `@game-shop/db`, `@game-shop/contracts` and `apps/api`, start **four real `apps/api` processes** on ports 4601–4604, wait until each has served a real `GET /api/health`, run every check in `scripts/race/` against all four, stop all four afterwards. What changed is what is in the directory.

| Check | Shape | Names |
| --- | --- | --- |
| `harness` | Asserts nothing about the shop | That the *next* check's result will mean anything |
| `create-order` | 20 concurrent Buy attempts, **one** `Idempotency-Key` | I1 — `orders.client_request_id` UNIQUE |
| `same-event` | **One** `event_id`, delivered 20 times at once | I2 — `payment_events.event_id` PRIMARY KEY |
| `webhooks` | **50 distinct** `event_id`s, one order | I4 — the guarded `paid → delivering` claim |
| `before-order` | A `paid` report for an order that does not exist yet | Out-of-order tolerance: no FK on `payment_events.order_id` |
| **`recover-refusal`** | A refuses its next call; one `paid` webhook | The `fallThrough` rung: a definite refusal moves to B under a **new** request id |
| **`recover-timeout`** | A hangs **after** its key claim commits, past `SUPPLIER_TIMEOUT_MS` | The outstanding guard: an `unknown` attempt is re-probed on the **same** supplier under the **same** id, and B is never asked |
| **`recover-out-of-stock`** | Pool drained, order paid, pool restocked, operator presses Retry | The `Fresh` round: a retry asks again at `max(attempt) + 1`, and the same ladder serves a person and a payment event |

Per-check aliases exist now, which closes one of the two gaps Phase 2's slice 6 wrote down: `pnpm race:recover-refusal`, `pnpm race:recover-timeout`, `pnpm race:recover-out-of-stock`, and the four Phase 2 names alongside them. `pnpm race recover-refusal` still works; the alias is the name `architecture.md` §7 promised.

The reported runs:

```
pnpm race, twice in a row, no tidying between:   8/8 passed against 4 instance(s).   both times
one external base URL:                            7/7 passed against 1 instance(s), 1 skipped.
```

The second line is §2.7's first criterion read strictly — *"alongside the existing ones"* means on the same runner, subject to the same skip rule, pointable at the same deployed URL. §5 covers what the skip means.

The structural decisions from Phase 2 carry over unchanged and are not re-argued here: filesystem discovery rather than a registry, one child process per check, checks strictly one at a time. The three new checks were discovered by dropping files in the directory; nothing in `run-checks.ts` changed for them.

---

## 2. What each check stages, and the alternative each one rejects

All three share a shape. Reset both suppliers to the seeded baseline. Arm exactly one thing on exactly one supplier. Create one order on one instance, pay it with one `paid` webhook on another, read it back on a third. Then read the database.

**The requests deliberately land on different instances.** Resetting, arming, creating, paying and reading each go to a different `targets.at(i)`. Supplier behaviour lives in a Postgres table (`supplier_behaviour`, assumption A6), not in a process, precisely so that arming it from one instance is visible to the other three. A check that sent every request to `targets.at(0)` would pass against an in-process `Map` too, and would therefore prove nothing about the thing A6 exists to guarantee.

### `recover-refusal`

Supplier A is armed with `fail_next: 1`. The one `paid` webhook walks the ladder inside one invocation: `askFirst` reaches A, A answers `422 supplier_rejected` having claimed nothing; the ladder's `fallThrough` rung reaches B under `req_{order}_b_2` — attempt **2**, not a retry of attempt 1 — and B issues.

What the check reads afterwards, and why each read is there:

- **Exactly two `issuance_attempts` rows**, `a/1 failed supplier_rejected` and `b/2 ok`. A refusal is *definite*, so it is recorded `failed`, never `unknown` — that word choice is what permits the fall-through at all.
- **No `supplier_requests` row for `a/1`, exactly one for `b/2`, against provider `b`.** A refusal writes no ledger entry; a success writes one under its own id.
- **Exactly one `supplier_keys` row claimed by `b/2`'s id.** The pool moved by one, despite two supplier calls.
- **Stock accounting** — `count(*) FROM supplier_keys WHERE claimed_by_request_id IS NOT NULL` equals `count(*) FROM deliveries` — read **before** the check starts and **after** the order settles, asserting the equality at both times and that each side moved by exactly one. Phrased as a delta rather than assuming a pristine `0 == 0`, so it holds regardless of what else the database contains.

**Rejected: `failure_rate` instead of `fail_next`.** A rate is a coin toss. §2.7's fifth criterion — *"the reviewer runs the checks twice in a row … it behaves the same as the first"* — is untrue by construction under a coin toss (technical-considerations §11, R8), and the intermittent red that eventually follows reads as a correctness defect in the shop, which is the most expensive wrong answer this directory can produce. The one-shot counter is consumed by an atomic `UPDATE … WHERE fail_next > 0`, so "refuse exactly the next call" is a fact about one specific call, and two runs of it are the same run twice. The rates exist for a person exploring by hand and nothing under `scripts/race/` passes one.

### `recover-timeout`

Supplier A is armed with `hang_next: 1`, `hang_ms` set to `SUPPLIER_TIMEOUT_MS + 1500`, and `hang_before_claim: false` stated explicitly rather than left to its default. The stub claims a key, commits it to its ledger under `req_{order}_a_1`, *then* waits. The shop's `AbortSignal.timeout` severs its own socket at 2 s — the abort does not reach the stub, which is still waiting — and the attempt is recorded `unknown`. Inside the same invocation the ladder recomputes: the newest attempt is `unknown`, probes are not exhausted, so the rung is `probe` — the **same** supplier, the **same** derived id. A's ledger already holds a code for that id, so the re-probe answers instantly and the walk rests `ok`.

What the check reads, and the one read that matters most:

- **Exactly one attempt row**, `a/1`, with `status = ok`, `probe_count = 2`, `last_error NULL` — asked, timed out once, re-probed, resolved. The re-probe *updated* a row; it did not insert one.
- **Zero `issuance_attempts` rows for provider `b`.** This is the hard rule of the whole phase — *never fall through while any attempt is `unknown`* — asserted the only way that means anything against a live system: not a status on B's row, because there must be no row.
- **One `supplier_requests` row for `a/1`, one key claimed by `a/1`, one delivery.** One code on file, asked for twice.
- **Stock accounting**, before and after, with the `+1 / +1` delta. This is the load-bearing one, and §4 is about why.

**Rejected: `hang_before_claim: true`, or a hang shorter than the timeout.** Both stage the *other* scenario — "a slow supplier is not a failed one" — which is worth demonstrating but is not §2.2. A hang before the claim that outlasts the timeout is a request that genuinely has no answer behind it; a hang after the claim that is shorter than the timeout never times out. Only "after the claim, longer than the deadline" produces a key genuinely issued and a client that cannot know it. The check states all three fields — placement, duration, and `fail_next: 0` — rather than trusting any default it does not control, and asserts the stored row echoes them back before it pays anything.

**What the check costs.** `recover-timeout` runs in about 2.4 s, because the shop genuinely waits `SUPPLIER_TIMEOUT_MS` before giving up on the first call. That number is the check being honest about what it stages. A faster version would need a shorter timeout on the spawned instances, which would make them a different shop from the one deployed — Phase 2's argument against raising the pool size for tests, in its Phase 3 form.

### `recover-out-of-stock`

The pool is drained: every unclaimed key claimed under a per-run sentinel id. One order is paid into the empty pool. A refuses `409 out_of_stock`; the ladder falls through to B under `b/2`, which refuses the same way for the same reason — both suppliers draw one pool, so an empty pool costs one wasted fall-through call (R12). The order settles `out_of_stock` with two `failed` rows and zero keys. Then the pool is restocked and `POST /api/admin/orders/:orderId/retry` is called. The retry's opening turn is a `Fresh` round, so "every supplier has refused" reads as *history* rather than a verdict, and the ladder answers `askFirst` at `max(attempt) + 1` — `a/3`, never a reused `a/1`. The pool has keys now; A issues; the order reaches `delivered`. A second Retry answers `409` and changes nothing.

Two things in this check are load-bearing.

**Stock accounting is scoped to this order's own request ids, not global.** Draining the pool claims fifty keys with no deliveries behind them — deliberately, and exactly like the Vitest suite's `drainKeyPool` fixture. A global `claimed == deliveries` would be false for the whole drained window, for a reason that has nothing to do with the ladder. So the check compares *this order's* claimed keys against *this order's* deliveries at each of the two settle points: `0 == 0` at `out_of_stock`, `1 == 1` at `delivered` — and separately confirms the whole pool returns to its starting size once the drain is reversed. Slice 3's walkthrough §4 recorded the general form of this correction; here it is applied.

**Restocking is direct SQL, and that is a documented gap, not a shortcut.** Technical-considerations §7 specified `POST /internal/suppliers/keys` for exactly this. It was never built — no task scheduled it, no test drives it, and `grep` over `apps/api/src` finds no route. A check may add check files and npm aliases and never production code, so the check restocks the way the schema explicitly reserves for tests: reversing the exact rows its own sentinel claimed a moment earlier. Every assertion §12 lists is exercised; what does not exist is the wire affordance. The check's header names the one place to point at the endpoint if it is ever built, and the spec records the gap. §6 has the rest.

**Rejected: an HTTP-only half.** `webhooks` and `before-order` can honestly run against a target with no `DATABASE_URL` and report a subset. This check cannot — draining and restocking *are* database operations, and the scoped accounting is the whole point. So with no `DATABASE_URL` it exits `3` and says why, rather than printing a `PASS` over a handful of status codes.

---

## 3. Two things a check author must know, and why they live in `recovery-scenario.ts`

Three checks, three authors, one supplier control surface. `scripts/race/support/recovery-scenario.ts` exists because the control surface has three ways to arm a supplier that *look* right and prove nothing, and three copies of the arming code are three chances to rediscover each of them.

**`PUT /internal/suppliers/:provider/behaviour` replaces the whole row.** An omitted field resets to zero. `{"hang_next": 1}` alone leaves `hang_ms` at `0` — a hang of no length, which never times out, so the "timeout" check passes having staged a normal successful call. `behaviourBody()` is the whole fix: it always sends all six fields, baseline-defaulted, with only the caller's overrides changed. There is no code path in the three checks that sends a partial body — `grep` for a hand-built `fail_next`/`hang_next` JSON literal in `scripts/race/recover-*.ts` finds none.

**`fail_next` is read before `hang_next`.** `shouldRefuse` runs first in both stubs, and an armed refusal short-circuits before any hang. Arm both on one `PUT` and call one is refused, spending `fail_next`, while `hang_next` stays armed for whatever calls A *next* — some later check's order, which then times out for no reason its author can see. `behaviourBody` sends `fail_next: 0` alongside every `hang_next: 1`, so inside these three checks the two mechanisms cannot collide.

**The after-claim hold is unconditional across outcomes.** A supplier that is slow to answer is slow whatever the answer is, so with `hang_next` armed an *empty* pool hangs before its `409` in exactly the same way. That is the honest simulation, and it is the one scenario where a timeout genuinely has **no** key behind it — the opposite of the trap. A check that armed a hang and paid into a drained pool would stage that scenario while believing it had staged §2.2. None of the three does; the one that drains the pool never arms a hang.

None of these is a bug. Each is a way a green transcript can be produced by a check that exercised nothing — which is the specific failure Phase 2's slice 6 named as worse than no check at all. The helper's header states all three, so the fourth author reads them instead of finding them.

The helper also carries the affordance logic every check needs: `readAdminToken()`, and `isMissingAdminAffordance()` which recognises `401` (token does not match) and `503` (`ADMIN_TOKEN` not configured on the target) as "this target has correctly refused me", to be reported as `SKIP` and exit `3`, never as `FAIL`. `describeMissingAdminAffordance()` says which of the two it was, in words, so a reviewer looking at a skip knows what to set.

One thing the helper deliberately does *not* do: import from `apps/api/src`. `deriveIssuanceRequestId` is transcribed — `req_{order_id}_{provider}_{attempt}` — for the reason the Vitest suite's own `deriveTestRequestId` gives: a bug that changed the derivation in the application and in a shared helper would go uncaught. There is also a mechanical reason: `scripts/` has no path into `apps/api/src` at all.

---

## 4. RED validation, and what each check's result actually proves

Functional spec §2.7's third criterion is Phase 2's §2.6 verbatim: *"Given a check has passed, when the mechanism it defends is deliberately weakened, then that check reports a failure."*

All three mechanisms live in one file, `apps/api/src/issuance/issuance-ladder.ts`. Each row was produced by weakening exactly one branch of it, rebuilding, running the four-instance harness, then restoring the file and confirming it at `a5715427c387d7d27c9ac9d58a089dd1d68c80c6c9a762211e83972192b86a24` — the same hash before and after every weakening (weakened: `69610ae4…`, `e89e49e0…`, `67e74502…`). Each run was confirmed against `dist/issuance/issuance-ladder.js` before the result was read, for the reason Phase 2 §4.2 gives: the spawned processes run `dist/main.js`, and a stale build is the one way this exercise produces a convincing lie.

### 4.1 The table

| Check | Weakening | Failed | **Stayed green** |
| --- | --- | --- | --- |
| `recover-refusal` | The `fallThrough` rung's `requestId` read off the newest failed row (`req_{order}_a_1`) instead of `deriveIssuanceRequestId(orderId, untried, max(attempt) + 1)` | **6 of 18.** `exactly two attempt rows for the order — found 1 row(s)`; `a/1 reads failed with last_error supplier_rejected — {…,"status":"ok","last_error":"supplier_rejected"}`; `b/2 reads ok — undefined`; `no supplier_requests row for a/1 — 1 row(s)`; `exactly one supplier_requests row for b/2, against provider b — {"n":0,"provider":null}`; `exactly one supplier_keys row claimed by b/2's request id — 0 row(s)` | **`the order settles delivered`, `exactly one deliveries row`, `stock accounting holds after this run`, `exactly one more key claimed and exactly one more delivery`, `the unclaimed pool moved by exactly one`** |
| `recover-timeout` | `isDefinitelySettled` widened to admit `unknown`, so the outstanding guard (branches 2 and 3) never fires and `fallThrough` runs past a timed-out attempt | **5 of 16.** `stock accounting holds after this run (claimed keys == deliveries, R2) — claimed=2, deliveries=1`; `exactly one more key claimed and exactly one more delivery — claimed +2, deliveries +1`; `no issuance_attempts row for provider b — 1 row(s)`; `exactly ONE attempt row for the order — found 2 row(s)`; `a/1 reads status=ok, probe_count=2 — {…,"status":"unknown","probe_count":1,"last_error":null}` | **`the order settles delivered`, `exactly one deliveries row`, `exactly one supplier_keys row claimed by a/1's request id`** |
| `recover-out-of-stock` | The `IssuanceRound.Fresh` branch deleted — the pre-slice-5 ladder, where an operator's opening turn recomputes `settleRefused` from the two refusals on file | **9 of 25.** `POST …/retry` answered `200 {"outcome":"still_out_of_stock",…,"detail":"every supplier was asked and has nothing to issue (a: out_of_stock; b: out_of_stock)","delivered":false}` against a pool just restocked to 50; `exactly THREE attempt rows after the retry — found 2 row(s)`; `a/3 reads ok, provider a, attempt 3 — undefined`; `the order settles delivered after the retry — status=out_of_stock`; `a further retry on the now-delivered order answers 409 — status=200` | **every assertion up to and including the restock — fifteen of them — plus the retry's own `200`** |

### 4.2 The "stayed green" column is the point

Read the table by its last column. Under every weakening, the order settled `delivered` (or, for the out-of-stock row, the automatic path was flawless). Under every weakening, there was exactly one `deliveries` row. A check that stopped at "the shopper got one key" — the natural thing to write, and the thing §2.1's fourth criterion literally says — would have passed all three.

**The refusal row is the sharpest statement of it in the phase.** Under the weakening, B was asked A's question. The runner's `reserveWithin` tried to insert an `issuance_attempts` row for `b/2` carrying `req_…_a_1`; `issuance_attempts.request_id` is UNIQUE, `ON CONFLICT (request_id) DO NOTHING` swallowed the insert, and the follow-up read saw the order still `delivering` and reported *already reserved — carry on*. B issued under A's id. The success was recorded by request id, so it landed on **A's row**: `status: "ok"` with `last_error: "supplier_rejected"` still on it — a refusal that succeeded. The ledger filed one key for one delivery, stock accounting balanced to the unit, and the pool moved by exactly one.

Nothing in the database distinguishes "the same id, asked again" from "a different question sent under a stolen id". `UNIQUE (request_id)` is satisfied either way. I5's ledger is keyed by `request_id` alone and cannot tell a re-probe from a fall-through wearing a re-probe's clothes. The id derivation — `max(attempt) + 1` across **all** of the order's attempts, R7 — is the *whole* mechanism, and the only thing that can see it broken is a check that reads attempt rows and request ids rather than stopping at `delivered`. That is why `recover-refusal` has ten database assertions after the settle and the shopper-facing one is the least informative of them.

**The timeout row is R2, measured on the shipped check rather than quoted.** Slice 3 predicted that breaking the `unknown` guard would still hand the shopper one key, because `deliveries.order_id` UNIQUE binds whichever code arrives; slice 3's own RED confirmed it on the Vitest suite. This slice repeats the same weakening against the runnable check and gets the same shape. A cut a key for `a/1` — still `unknown`, `probe_count` 1, because the guard that would have re-probed it never fired. B cut a second for `b/2`. I3 bound B's. Every assertion phrased about the shopper passed, including `exactly one supplier_keys row claimed by a/1`, which is *true*: A's key is claimed, sitting in the pool with no delivery behind it. `claimed=2, deliveries=1` is the only place that key shows up. That is the loss §2.2's fifth criterion exists to forbid, and the shopper cannot see it from any page.

**The out-of-stock row is a regression test for a bug this phase found.** Slice 5's walkthrough §4 records what the retry endpoint's implementer measured on the first retry attempt: `200 still_out_of_stock` with no new attempt row, against a pool with keys in it — the ladder had re-settled the order without asking anyone, because "both suppliers refused" is the same set of rows whether written a millisecond ago mid-walk or a week ago by a walk that went home. `IssuanceRound.Fresh` was the fix. Deleting it restores *exactly* that state, and the check's RED output is that bug's signature word for word: `"every supplier was asked and has nothing to issue"` reported against fifty unclaimed keys, with no supplier called. If the check could not catch that, it could not catch the bug it exists to prevent recurring. Note also what the two settle points bought: fifteen green assertions up to the restock say the *automatic* walk into an empty pool was untouched by the weakening, which localises the break to "after a person presses Retry" without anyone reading a diff.

### 4.3 The lesson, now with three more data points

Phase 2 §4.5 stated the general lesson: RED validation is the only way to find out which invariant a check actually guards. This slice's three results agree with each other and with Phase 2:

- **The shopper-facing assertions guard nothing about the ladder.** They are correct and they should stay — §2.1 asks for them in words — but they are satisfied by I3 alone under every weakening tried.
- **The assertions that catch a broken ladder are about rows, ids and counts.** Attempt row count. The provider and attempt on each row. Which request id has a ledger entry. Claimed keys against deliveries. The out-of-stock check's `409` on a second retry, which is zero rows from a guarded `UPDATE`.
- **All three weakenings hit one file and one pure function.** That is not an accident of the exercise; it is why the ladder is a pure function of recorded state in the first place. A rule that is a predicate over rows can be exercised by handing it rows — slice 3's exhaustion test does that with 1,788,098 histories — and it can be *broken* by editing one branch, which is what makes the RED both precise and reproducible.

---

## 5. Skipping honestly against a deployed target

The three new checks introduce a second reason a check can be unable to run here, beside `before-order`'s flag: they need `ADMIN_TOKEN`, to arm the supplier and to press Retry.

`pnpm race` handles it without any new plumbing. `scripts/with-env.ts` loads `.env.example` and `.env` into the runner's own environment, and `api-instance.ts` spreads `process.env` into every spawned instance, so the runner and its four instances hold the same token by construction. A deployed target holds whatever its operator configured, which the runner cannot know.

So the rule from Phase 2 §5 applies unchanged. If the target answers `503`, `ADMIN_TOKEN` is not configured there and the whole admin surface is disabled — the correct default for a deployment. If it answers `401`, the token this process holds does not match. Either is a correct system correctly refusing an affordance, and both binary answers lie: `FAIL` teaches a reviewer to distrust the other seven checks, `PASS` counts an unrun check as evidence. Exit `3`, printed as `SKIP`, subtracted from both sides of the ratio. And the skip is set as `process.exitCode`, never `process.exit()`, so every `finally` — the supplier reset over SQL, `cleanupTestOrders`, the out-of-stock check's drain reversal — still runs. Phase 2's bug in the first implementation of the skip is not repeated.

Against one external base URL the reported summary was `7/7 passed …, 1 skipped`. Two things are worth reading off that line. Seven checks ran and passed against a single instance — which, as §2 of Phase 2's slice 6 argues at length, proves the connection pool rather than the constraint for the race-shaped ones, and the runner says so in its banner. And exactly one check skipped rather than three or four. The report I have carries the ratio, not the name; the mechanics leave one reading. If the token had not reached the target, all three recovery checks would have skipped and the line would read `5/5 … 3 skipped`. One skip with seven passes means the recovery checks *ran*, and the skip is `before-order`'s — the flag a shop not spawned by `pnpm race` correctly refuses, exactly as in Phase 2. That is the honest outcome §2.7 wants: a check that could run, did.

---

## 6. Honest gaps

- **`POST /internal/suppliers/keys` was specified and never built.** Technical-considerations §7 describes it; no task in slices 1–6 scheduled it; nothing in the functional spec requires a wire-level restock. `recover-out-of-stock` restocks over direct SQL — un-claiming the exact rows its own sentinel claimed, which is the technique `packages/db/src/schema/supplier.ts` reserves for tests and the Vitest suite's `restoreDrainedKeyPool` already uses. Every §12 assertion is exercised; the wire affordance does not exist. Recorded in the spec's §7 with the check's header naming the one place to point at the endpoint if it is built.
- **The README's port range was stale from Phase 2.** It said `4201–4204` while `RACE_BASE_PORT` had moved to `4601` when the Phase 2 acceptance suite turned out to bind `4201`. The README's own knob table already had the right number and the reason; the opening paragraph did not. Fixed this slice — `4601–4604` now, and the stale range appears nowhere in the file.
- **`recover-timeout` costs about 2.4 s.** One real `SUPPLIER_TIMEOUT_MS` wait. It could be made faster only by making the spawned instances a different shop.
- **`recover-out-of-stock` has no HTTP-only half.** Against a target with no reachable `DATABASE_URL` it skips entirely rather than reporting a subset. That is by design (§2), but it means this check contributes nothing against a deployed shop whose database the reviewer cannot reach.

---

## 7. Where this sits in the assignment

`context/product/product-definition.md` §1.4 lists five adversarial scenarios and calls them the definition of success. This slice settles functional spec **§2.7**, all five criteria, and turns scenario **4** from a thing slice 5 proved into a thing a reviewer executes by name.

| # | Scenario | Status | Runnable as |
| --- | --- | --- | --- |
| 1 | 50 parallel `paid` webhooks → one issuance fact, one key | Settled (Phases 1–2) | `pnpm race webhooks` |
| 2 | A repeated webhook with the same `event_id` changes nothing | Settled (Phase 1) | `pnpm race same-event` |
| 3 | A webhook before its order, or out of order | Settled (Phase 2) | `pnpm race before-order` |
| 4 | Empty pool → recoverable → after restock, exactly one key | **Settled this phase** — slices 1, 3, 4 and 5 built it, this slice makes it runnable | `pnpm race recover-out-of-stock` |
| 5 | A promo code with limit N under parallel requests | Phase 5. Not started | — |

**Four of five settled and runnable by name.** `create-order` remains outside the five — it defends I1, which underlies all of them. The other two recovery checks cover functional spec §2.1 (`recover-refusal`) and §2.2 (`recover-timeout`), which are requirements of this phase rather than numbered scenarios of the assignment; §2.2 is the phase's central trap and the one an interviewer is most likely to reach for.

Of Phase 2 slice 6's two documented gaps, one is closed here (the per-check aliases) and one is not: **there is still no root `README.md`**, although `architecture.md` §7 says the scenario-to-check mapping lives there. That is Phase 6 work, and the table above is the mapping it will carry.

---

## Interview questions this answers

**"Your recovery checks pass. How do you know they would catch a broken retry policy?"**
Because each was run against a build with its mechanism deliberately removed, and each went red — 6 of 18, 5 of 16, 9 of 25 assertions — with `issuance-ladder.ts` confirmed at the same hash before and after every weakening, and the weakening confirmed in `dist/` before the result was read. More usefully, I know *which* assertions went red. Under every weakening, "the order settles delivered" and "exactly one deliveries row" stayed green. What failed was attempt row counts, request ids and stock accounting. So the checks would catch a broken ladder, and the reason they would is that they read rows rather than stopping at the shopper's key.

**"Walk me through the refusal one going red."**
The fall-through rung is supposed to ask the backup under a *new* id, `req_{order}_b_2`, derived as `max(attempt) + 1` across all the order's attempts. I made it reuse the failed attempt's id instead. B was then asked A's question. The runner tried to insert an attempt row for `b/2` carrying `req_…_a_1`; `request_id` is UNIQUE, `ON CONFLICT DO NOTHING` swallowed it, and the follow-up read said "already reserved, carry on" — which is exactly what it says for a legitimate re-probe. B issued. The success was recorded by request id, so it landed on A's row: `status: ok`, `last_error: supplier_rejected` — a refusal that succeeded. One key, one delivery, stock accounting balanced. Nothing in the database distinguishes "same id, re-asked" from "different question under a stolen id"; `UNIQUE (request_id)` is satisfied either way. The id derivation is the entire mechanism, and only a check that reads attempt rows can see it broken.

**"And the timeout one?"**
The guard says: while any attempt for this order is `unknown`, re-probe that same supplier under that same id, and never fall through. I widened `isDefinitelySettled` to treat `unknown` as settled, so the guard never fired and the ladder fell through to B past a timed-out attempt. A had already cut a key for `a/1` and committed it before the hang started — that is what "after the claim" means. B cut a second for `b/2`. `deliveries.order_id` UNIQUE bound B's, so the shopper got exactly one key and every shopper-facing assertion passed. `claimed=2, deliveries=1` was the only place A's key showed up. That is R2 from the plan — assert stock accounting, not the shopper's key count — measured on the shipped check rather than quoted. And the check's other assertion for the hard rule is "zero attempt rows for provider `b`", not a status on B's row, because there must be no row.

**"Why does the out-of-stock check matter more than the other two, in your view?"**
Because its RED reproduces a bug this phase actually shipped and found. Slice 2's ladder read "every supplier has refused" as a verdict, which is right mid-walk and wrong at the opening of an operator's retry — the rows are the same, the meaning is opposite. The retry endpoint's implementer measured it on the first attempt: `200 still_out_of_stock`, no new attempt row, against a pool with keys. The fix was one input the rows cannot carry, `IssuanceRound.Fresh`, passed by the operator's opening turn and read by exactly one branch at the bottom of the ladder. Deleting that branch restores the bug precisely, and the check's output is the bug's own words: "every supplier was asked and has nothing to issue" against fifty unclaimed keys, nobody asked. If the check could not catch that, it could not catch the thing it exists to prevent.

**"You had three people write three checks against the same supplier control endpoint. What went wrong?"**
Nothing, because the three ways it goes wrong were put in one shared helper before it could. `PUT …/behaviour` replaces the whole row, so `{"hang_next": 1}` alone is a zero-length hang that never times out — `behaviourBody()` always sends all six fields. `fail_next` is read before `hang_next`, so arming both refuses call one and leaves the hang armed for whoever calls next — the helper sends `fail_next: 0` with every `hang_next: 1`. And the after-claim hold is unconditional, so a hang against an empty pool times out before its `409` with no key behind it — the opposite of the trap — so the check that drains the pool never arms a hang. Each is a way a check looks right and proves nothing, and a green transcript from a check that exercised nothing is the failure the whole harness exists to prevent.

**"Why one-shot counters and never a failure rate?"**
The functional spec requires two consecutive runs to behave the same with no tidying between. A rate is a coin toss, and two runs of a coin toss are two different bets — the intermittent red that eventually follows reads as a correctness defect in the shop, which is the most expensive wrong answer a check can give. `fail_next: 1` is consumed by an atomic `UPDATE … WHERE fail_next > 0`, so "refuse exactly the next call" is a statement about one specific call, and four instances cannot both spend it. The rates exist for a person exploring by hand; no automated check passes one.

**"The out-of-stock check restocks by writing SQL. Isn't that reaching around the system?"**
Yes, and it is written down rather than filed off. The plan specified `POST /internal/suppliers/keys` and no task ever built it — I found that writing the check, and a check may not add production code. What restocking a drained pool needs is unclaimed rows in `supplier_keys`, and un-claiming rows is a thing the schema explicitly reserves for tests; the Vitest suite already does exactly this. So the check reverses the exact rows its own sentinel claimed, every assertion §12 lists is exercised, the gap is recorded in the spec, and the check's header names the one place to point at the endpoint if it is ever built. The alternative — quietly building the endpoint inside a task scoped to checks — would have been a production change nobody reviewed.

**"Against a deployed shop, which of these can a reviewer actually run?"**
All of them, against a single URL, and each one either runs honestly or says why it cannot. The reported single-URL run was seven of seven passed, one skipped. The recovery checks need `ADMIN_TOKEN`; a target that answers `503` has the admin surface disabled, which is the correct deployment default, and one that answers `401` has a different token — both are a correct system refusing an affordance, reported as `SKIP` and exit `3`, subtracted from both sides of the ratio. The out-of-stock check also needs the database, because draining and restocking are database operations, and it skips entirely rather than printing a pass over three status codes. What a single-URL run does *not* prove is a race, and the banner says so.

**"What is still not done?"**
The restock endpoint, as above. There is still no root `README.md`, although the architecture says the scenario-to-check mapping lives there — the table in this document is that mapping, waiting for Phase 6. Scenario 5, the promo limit, is Phase 5 and has no check because it has no code. And the README's port range was stale from Phase 2 until this slice — a small thing, but a reviewer who read `4201–4204` and found instances on `4601` would have had reason to wonder what else was stale.

---

## Source files

- `scripts/race/README.md` — the eight checks, the RED table with three new rows, "What the three recovery REDs did not break", and the supplier control surface for a check author
- `scripts/race/support/recovery-scenario.ts` — the shared lifecycle helpers, `behaviourBody`, the affordance-skip logic, and the three gotchas in its header
- `scripts/race/recover-refusal.ts` — `fail_next: 1`, the fall-through under a new id, and the before/after stock accounting delta
- `scripts/race/recover-timeout.ts` — the after-claim hang, the re-probe under the same id, "no row for provider `b`", and R2 applied
- `scripts/race/recover-out-of-stock.ts` — drain, pay, restock, retry; the two scoped settle points; the direct-SQL restock and its header
- `scripts/race/run-checks.ts` — unchanged for this slice; discovery found the three new files
- `package.json` — the seven `race:*` aliases
- `apps/api/src/issuance/issuance-ladder.ts` — every weakened mechanism: branch 5's `max(attempt) + 1`, `isDefinitelySettled` behind branches 2 and 3, and the `Fresh` arm of branch 6
- `apps/api/src/issuance/issuance-history.ts` — `reserveWithin`, whose `ON CONFLICT (request_id) DO NOTHING` is what swallowed the stolen id in the refusal RED
- `apps/api/src/suppliers/a/supplier-a.controller.ts` — refusal before hang, hang after claim, the unconditional hold
- `apps/api/src/suppliers/supplier-behaviour.controller.ts` — `PUT` replaces, `{}` is the reset
- `apps/api/test/concurrency/operator-retry-race.test.ts` — `drainKeyPool` / `restoreDrainedKeyPool`, the sanctioned technique the out-of-stock check reproduces
- `context/spec/003-failure-and-recovery/functional-spec.md` §2.1, §2.2, §2.3, §2.7 — the requirements each check drives, and the five criteria this slice settles
- `context/spec/003-failure-and-recovery/technical-considerations.md` §7, §7.1, §11 (R1, R2, R7, R8, R12), §12 — the control surface, the corrected inequality, the risks each check was written against, and the three-row table the checks implement
- `context/product/product-definition.md` §1.4 — the five scenarios
- `docs/walkthrough/phase-2-slice-6-checks-a-reviewer-can-run.md` — the harness this slice extends, and the null result this slice's three REDs are the counterpart to
- `docs/walkthrough/phase-3-slice-3-silence-is-not-failure.md` §4 — the original R2 measurement and the "settled outcomes only" correction
- `docs/walkthrough/phase-3-slice-5-pressing-retry-twice.md` §4 — the bug the out-of-stock RED reproduces

**On evidence:** what I ran fresh while writing this document, against the tree as it stands, with no server started and no source file modified: `pnpm race --list`, which printed eight checks — `harness`, `before-order`, `create-order`, `recover-out-of-stock`, `recover-refusal`, `recover-timeout`, `same-event`, `webhooks`; `pnpm typecheck:scripts`, exit `0`; `shasum -a 256` on `apps/api/src/issuance/issuance-ladder.ts`, which is at `a5715427c387d7d27c9ac9d58a089dd1d68c80c6c9a762211e83972192b86a24` — the restored hash the README records; `grep -c fresh` on `apps/api/dist/issuance/issuance-ladder.js`, four occurrences, so the built artefact carries the `Fresh` branch; `grep -rn "suppliers/keys" apps/api/src`, zero matches; the seven `race:*` aliases in `package.json`; `4601–4604` in the README's opening paragraph and `4201–4204` nowhere in it; and a count of `record(` sites in the three checks — 18, 16 and 25 — matching the denominators in §4.1. I read `reserveWithin`'s SQL, the ladder's six branches, the `Fresh` arm's placement below the guard, and the unconditional `hold(AfterClaim)` in supplier A's controller rather than taking the comments' word for them.

Everything else is reported by other agents in this slice and quoted rather than paraphrased: the two consecutive `8/8` runs, the single-URL `7/7 … 1 skipped` line (the identity of the skipped check is my inference from the skip mechanics in §5, not part of the report), all three RED outcomes with their failure text and their green assertions, the three weakened hashes, the `dist/` confirmations, the `~2.4 s` duration of `recover-timeout`, and the seeded-baseline state between runs. The `20 distinct / 9 distinct` pool measurement quoted from Phase 2 is older still and lives in `architecture.md` §7.
