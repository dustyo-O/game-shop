# Phase 2 · Slice 6 — Checks a reviewer can run

> The assignment asks for a reproducible way to check the shop under races — «как воспроизвести проверку гонок». This slice is that artefact: `pnpm race`, a runner and five checks in `scripts/race/`. Functional spec §2.6 makes it an acceptance criterion rather than a nicety.
>
> There are two honest headlines, both produced by the RED validation and both in §4. **One deliberate weakening produced no failure at all** — the check that names the atomic supplier key claim among the mechanisms it defends passed 8 of 8 against a build where that claim had been gutted. And **widening the guard the headline check exists to defend still handed the shopper exactly one key.**
>
> Neither result is what anybody expected before running it. Together they are the real finding of this slice: **RED validation does not only tell you that a check can fail. It tells you which invariant each check actually guards** — which turns out not to be the one written at the top of the file.

---

## 1. One command, five checks, four processes

```sh
pnpm race
```

That builds `@game-shop/db`, `@game-shop/contracts` and `apps/api`, starts **four real `apps/api` processes** on ports 4201–4204, waits until each has served a real `GET /api/health`, runs every check in `scripts/race/` against all four, and stops all four afterwards — on success, on failure, on a thrown configuration error, and on Ctrl-C.

| Command | What it does |
| --- | --- |
| `pnpm race` | Every check, against 4 freshly built local instances. |
| `pnpm race webhooks same-event` | Only the named checks. |
| `pnpm race --list` | The checks that exist. Runs nothing, needs nothing running. |
| `RACE_BASE_URLS=https://game-shop.vercel.app pnpm race` | The deployed target. Builds nothing, spawns nothing, stops nothing. |
| `RACE_BASE_URLS=… node scripts/race/webhooks.ts` | One check, by hand, exactly as the runner invokes it. |

The five checks, and the invariant each one names:

| Check | Shape | Names |
| --- | --- | --- |
| `harness` | Asserts nothing about the shop | That the *next* check's result will mean anything |
| `create-order` | 20 concurrent Buy attempts, **one** `Idempotency-Key` | I1 — `orders.client_request_id` UNIQUE |
| `same-event` | **One** `event_id`, delivered 20 times at once | I2 — `payment_events.event_id` PRIMARY KEY |
| `webhooks` | **50 distinct** `event_id`s, one order | I4 — the guarded `paid → delivering` claim |
| `before-order` | A `paid` report for an order that does not exist yet | Out-of-order tolerance: no FK on `payment_events.order_id` |

Three structural decisions in the runner are worth naming, because each one has an obvious alternative that would have been worse.

**Checks are discovered from the filesystem, not from a registry.** Any top-level `.ts` file in `scripts/race/` is a check; `support/` is never scanned. The alternative — a list of checks in the runner — is four chances to forget, because four different agents wrote the four checks.

**Each check runs as its own child process with inherited stdio, not as an in-process import.** Two reasons. A check has to stay runnable on its own against a deployed shop (`RACE_BASE_URLS=… node scripts/race/webhooks.ts`), and running it here exactly as a reviewer would run it by hand is what keeps that true. And a check that crashes the runtime then fails *that check*, rather than killing the run and leaking four API processes onto the reviewer's machine.

**Checks run one at a time, never concurrently.** They share one 50-key `supplier_keys` pool and one seeded baseline, so overlapping them would make one check's cleanup another check's flake. Concurrency inside a check is the point; concurrency between checks is only noise.

---

## 2. Why a race check pointed at one instance measures the connection pool, not the constraint

This is the first half of the assigned question, and it is the reason this slice needed a harness at all rather than a `for` loop.

`packages/db/src/client.ts`:

```ts
export const MAX_CONNECTIONS_PER_INSTANCE = 1;
```

That is architecture §2's connection policy, and it is the production shape: on Vercel, fifty concurrent webhook invocations are fifty processes, and a pool of `max: 10` in each would ask Neon for five hundred connections. So each process holds exactly one.

The consequence for a race check is total. Inside one process, a transaction holds that single connection for the whole of `BEGIN … COMMIT`, so a second concurrent request **queues in Node, before a byte of it reaches Postgres.** `FOR UPDATE SKIP LOCKED` never skips, because nothing else holds a row lock at the moment the subquery looks. The database never sees two statements in flight, so no database-level mechanism is ever exercised.

Which means a shop with **no locking at all** passes. This is measured, not argued — `architecture.md` §7, with the supplier key claim weakened to an unlocked `SELECT`-then-`UPDATE` and twenty distinct request ids:

| Harness | Codes handed out | Distinct | Errors |
| --- | --- | --- | --- |
| 1 process, pool `max: 1` | 20 | **20** | 0 |
| 4 processes, pool `max: 1` each | 20 | **9** | 0 |

The same broken code is flawless against one process and hands **eleven customers a key somebody else also holds** against four — silently, with nothing raised or logged in either case. And the count varies between runs (9, then 12, of 20), which is itself the signature of a genuine race: a stable number would mean something is serialising.

Two alternatives were available and both are rejected in `architecture.md` §7.

**Raise the pool size for tests.** This is the tempting one, because it is one line and it makes a single instance interleave. It is also the one that proves a different system correct: `max: 1` *is* the configuration under test. A check that changes the shape of the thing it is checking is not evidence about the deployed shop.

**Fire fifty requests at one `pnpm dev` server and call it a race.** This is what most projects ship, and it is the specific failure this slice exists to prevent — not because it is lazy, but because it is *convincing*. It produces a green transcript, real HTTP traffic, real database rows, and a completely false statement about the system. Architecture §7's phrasing is the one to keep: a race check that cannot fail is worse than no race check, because it grows more convincing every time it passes.

So `RACE_BASE_URLS` is a **list**, `pnpm race` spawns separate OS processes, and each check spreads its requests with `targets.at(i)` — deterministic round-robin, so request `i` always goes to instance `i % instanceCount` and a failing run and its re-run send the same request to the same instance.

A single URL is *accepted* rather than rejected, because it is exactly right against a deployed target where the platform supplies the separate instances and we get no say in how many. But `announce()` prints a warning when there is only one, rather than letting a green transcript imply something it did not prove:

```
  WARNING: 1 instance. This run CANNOT prove a race against a local target.
  packages/db pins the pool to max: 1, so concurrent requests to one process
  serialise in Node before Postgres sees them, and a shop with no locking at
  all passes (architecture.md §7: 20 distinct keys across 1 process, 9 across 4).
```

`RACE_BASE_URLS` is also validated at parse time rather than at first `fetch`, and one of those rules is directly this argument. A **duplicate origin is rejected**: round-robin across one origin twice is round-robin across it once, so a duplicate would make `instanceCount` a lie — the run reports four instances and races two. Since the entire value of this harness is that the instance count is honest, a duplicate is a typo, not a preference.

(The other parse-time rules are cheaper but earn their place: a missing scheme is rejected because `new URL("localhost:4201")` **succeeds**, with protocol `localhost:` and an empty hostname, and would otherwise surface hundreds of lines later as an unexplained `fetch failed` that reads exactly like the shop being down — `architecture.md` §8 records that exact trap. A path is rejected because entries are origins and `http://host/api` silently produces `/api/api/orders`.)

---

## 3. The harness checks its own premise before any check runs

Rejecting a duplicate origin catches the *typo* version of the illusion. It cannot catch the interesting version, and that is what `race:harness` is for.

`http://localhost:4301` and `http://127.0.0.1:4301` are two different origins. They pass every parse rule. They are also, very often, **one process**. Pointed at that pair:

```
  PASS  http://localhost:4301 serves /api/health — HTTP 200, status="ok"
  PASS  http://127.0.0.1:4301 serves /api/health — HTTP 200, status="ok"
  FAIL  targets hold separate database connections — 1 distinct backend pid(s) as 'game-shop', need >= 2
```

Both targets are healthy. Both would answer every request the other four checks make. Every assertion in `race:webhooks` would pass, and the run would prove nothing whatsoever. That is the illusion, caught before a single check executes — and note *what* is passing and what is failing: **"serving" and "separate" are exactly the two things this check refuses to conflate.**

The mechanism is a count of distinct Postgres backends:

```sql
select pid from pg_stat_activity
where application_name = 'game-shop' and pid <> pg_backend_pid();
```

Three details make that query mean what it says.

- **`application_name = 'game-shop'`** is what every `apps/api` instance connects with (`packages/db/src/client.ts`, `DEFAULT_APPLICATION_NAME`). The check itself connects as `game-shop-test-race-harness`, and excludes `pg_backend_pid()` besides, so it can never count itself into a pass.
- **The `GET /api/products` assertion runs first, and is load-bearing twice over.** `/api/health` answers `200` with no database at all, because `apps/api` builds its pool lazily — so liveness alone would happily start a run against four instances that cannot serve a single order. The catalogue is the cheapest read that genuinely goes to Postgres. It is also what *opens* each instance's one connection, which is what the pid count then sees.
- **One query after the requests, not sampling during them.** `idleTimeoutMillis` is 10s, so all four connections are still logged in by the time the count runs. A firmer count than trying to catch four backends mid-flight.

The assertion is `distinct >= targets.instanceCount`, deliberately not `==`: a stray `pnpm dev` API against the same database is also a `game-shop` connection, and the check says so in its own output rather than failing on it.

`harness.ts` runs first when it exists, for the obvious reason — if the harness is broken, every other failure is noise.

---

## 4. RED validation, and what each check's result actually proves

Functional spec §2.6:

> Given a check has passed, when the mechanism it defends is deliberately weakened, then that check reports a failure — so a passing check is evidence rather than decoration.

Each row below was produced by weakening **exactly one** mechanism in production source, running the full four-instance harness, then restoring the file and confirming it byte-identical with `shasum -a 256`.

### 4.1 The four weakenings that produced failures

| Check | Weakening | What the check reported |
| --- | --- | --- |
| `harness` | No source change — two origins that are secretly one process | `FAIL  targets hold separate database connections — 1 distinct backend pid(s) as 'game-shop', need >= 2`, with both `/api/health` assertions still green |
| `create-order` | `orders.service.ts` — deleted `.onConflictDoNothing({ target: orders.clientRequestId })` | `500` ×19 of 20, with `constraint: 'orders_client_request_id_key'` and `routine: '_bt_check_unique'` in the instance log. The `INFO` line moved from `201: 1, 200: 19` to `201: 1, 200: 0` |
| `same-event` | `payment-events.service.ts` — deleted `.onConflictDoNothing({ target: paymentEvents.eventId })` | `500` ×19, **and** the outcome assertion: `stored=1, duplicate=0, unrecognised=19` |
| `webhooks` | `order-transitions.ts` — `beginIssuance.from` widened `[Paid]` → `[Paid, Delivering]` | Cleanup failed on `deliveries_order_id_orders_id_fk`, because **50** workers logged `claimed the order for issuance` against **1** with the guard intact. Reproduced 3 times of 3 |
| `before-order` | `payment-event-processor.service.ts` — `applyPaid`'s `OrderNotFound` branch made to settle the event instead of leaving it pending | `Error: order ord_race_beforeorder_… did not settle within 15000ms (status=created)` — the early report was discarded, so neither drain ever found it |

Two of those deserve a note.

**`same-event` failed in two independent ways at once**, and that is the shape to want. The `500`s say the *acknowledgement* broke — nineteen of twenty redeliveries got an error, which is precisely how a payment provider's retry storm starts. The `stored=1, duplicate=0, unrecognised=19` says the *classification* broke — without `ON CONFLICT`, "first sight" and "already seen" stop being distinguishable, because winning or losing that insert **is** the duplicate detection. A check that only counted rows would have missed half of it.

**`before-order`'s weakening is an absence, which cannot be deleted.** The mechanism is that `payment_events.order_id` carries *no* foreign key. Weakening it means adding one, which is a migration rather than a source edit. The drain side was weakened instead — make the `OrderNotFound` branch settle the event — which removes the same guarantee for the same scenario at a tenth of the blast radius. Worth saying out loud, because "weaken the mechanism" is not always a one-line edit and pretending otherwise is how this exercise gets skipped.

### 4.2 Making sure the weakening reached the running processes

This is the step that decides whether the whole exercise is real, and it is easy to skip.

`pnpm race` spawns processes that run `dist/main.js`. A weakened source file that was not rebuilt **is not the code under test** — the run would be green, the transcript would look like a completed RED validation, and it would be a lie. `RACE_SKIP_BUILD` exists for fast iteration and is documented as *wrong* for this purpose, in the README, in the runner's header and in the runner's own output when it is set.

So every weakening above was confirmed in the built artefact, not just in source. For the key-claim weakening in §4.3, that meant watching `skipLocked` go `1 → 0 → 1` in `apps/api/dist/suppliers/supplier-key-claim.service.js`. A stale `dist/` is the single way this exercise produces a convincing false result, and it is the first thing to rule out.

### 4.3 The weakening that produced nothing, and why that is the finding

`race:webhooks` named the **atomic supplier key claim** among the mechanisms it defends. So the claim was reduced to a `SELECT`-then-`UPDATE` — `FOR UPDATE SKIP LOCKED` dropped, the subquery awaited as a statement of its own — and the check was run against a build confirmed weakened.

`race:webhooks` **passed. 8 assertions of 8.**

That is a real null result, not a stale build, and the reason is exact. `race:webhooks` fires fifty reports at **one** order. I4 admits exactly one worker to issuance. So the key claim is *called once* in the entire check. There is no concurrency there for the weakening to expose.

Meanwhile the weakening is catastrophic — which the Vitest concurrency suite shows against that same build, because it pays many orders in parallel and therefore does call the claim concurrently, with distinct `request_id`s:

```
FAIL  test/concurrency/key-claim-race.test.ts > pays 20 orders in parallel across 4 processes
AssertionError: N distinct keys — no code handed to two orders: expected 10 to be 20

FAIL  test/concurrency/key-claim-race.test.ts > pays 55 orders in parallel — more than the 50-key pool holds
AssertionError: exactly one order settles per available key: expected 55 to be 50
```

Ten of twenty shoppers held a key somebody else also held. Fifty-five orders were delivered from a fifty-key pool.

So the check that defends the atomic claim is `apps/api/test/concurrency/key-claim-race.test.ts`, and `race:webhooks` defends I4 — which is what its header already claims and all it should ever be credited with. The README now says exactly that.

The thing to notice is that **nothing except running it would have told us.** Reading `race:webhooks` top to bottom, it fires fifty concurrent webhooks at a shop and asserts one key comes out; the key claim is unmistakably on the path it exercises. It is on the path, and it is called once.

### 4.4 What widening the guard actually proved

The `webhooks` row in §4.1 is stranger than it looks, and this is the second finding.

Widening `beginIssuance.from` from `[Paid]` to `[Paid, Delivering]` removes the guard's exclusivity entirely. All fifty workers claim the order. All fifty walk to the supplier. And the shopper **still received exactly one key**, with all eight named assertions passing.

Because the deterministic `request_id` — `req_{order_id}_{provider}_{attempt}` — means all fifty workers ask the supplier the *same question*. I5's `request_id → code` ledger answers with the *same code*. I3's `deliveries.order_id` UNIQUE binds it once.

**I5 and I3 are what make the key count one. I4's guard's job is stopping forty-nine workers from reaching the supplier at all** — and that is measurable: `1` versus `50` lines of `claimed the order for issuance` in the instance logs.

`race:webhooks` did report the failure, three runs of three. But it reported it through its **cleanup** failing — fifty stragglers were still writing `deliveries` rows after the check had finished, so `cleanupTestOrders` hit `deliveries_order_id_orders_id_fk` — rather than through any assertion it makes. That is a genuine limitation of the check, and it is written down in the README rather than filed off. A check whose RED signal arrives through a foreign key violation in its teardown is a check that got lucky.

### 4.5 The lesson worth carrying out of this slice

Both findings point the same way, and neither was visible before running the exercise.

**RED validation is not a formality that confirms a check can go red.** It is the only way to find out which invariant a check actually guards. `race:webhooks` looked like it guarded the key claim and does not. It looked like it guarded the guard by assertion and only catches that through teardown. The guard looked like the thing that makes the key count one and is not.

Every one of those was an assumption a careful reader would have made from the source. All three were wrong, and the measurement is what said so.

---

## 5. The third outcome a check can have

The runner started with two exit codes — `0` passed, `1` failed. The deployed-target run exposed why that is not enough.

`before-order` needs `ALLOW_CLIENT_SUPPLIED_ORDER_ID` on every targeted instance. `pnpm race` sets it for the instances it spawns. **A deployed shop serving real shoppers should refuse it**, which is the correct default and the whole reason the flag fails closed. So the check was reporting a correct system's correct refusal as `FAIL`.

Both binary answers are lies there:

- **`FAIL`** reports a correct system as broken. Worse than the noise: a reviewer who sees red on a system that is fine learns to distrust the other four checks.
- **`PASS`** counts an unrun check as evidence. That is exactly the decoration §2.6 exists to forbid.

So exit code `3`: the runner prints `SKIP`, names the check in the summary line, and subtracts it from **both sides of the ratio**.

```ts
const attempted = ran - skipped.length;
```

Leaving a skip in the denominator would print `4/5 passed` — a reviewer's eye lands on the missing one and reads it as a failure. Taking it out of the numerator only would be the false pass the exit code exists to prevent. It reads `4/4 passed …, 1 skipped (before-order)`, never `4/5`.

This is not a new rule, it is an existing one raised a level. `support/race-database.ts` already applies it to a *single assertion* with no `DATABASE_URL`: report the skipped assertion **by name**, and never count it as a pass. A check that quietly drops "exactly one delivery row" and still prints `PASS` is worse than one that fails, for the same reason as §2's single-instance run — it is a false statement about the system that gets more convincing every time it runs.

Verified in both modes:

```
A. 4 instances, flag on:   race: 5/5 passed against 4 instance(s).
B. 1 external URL, off:    race: 4/4 passed against 1 instance(s), 1 skipped (before-order).  EXIT=0
```

### The bug in the first implementation of the skip

Worth telling, because it broke the exact property the skip was introduced to protect.

The first version called `process.exit(3)` at the point the refusal was detected — inside the `try`. `process.exit()` terminates immediately and **skips the `finally`**. So the early `payment_events` row this check had just written was left on disk, and the next run of `pnpm race` would start against a dirty database.

That is §2.6's fourth criterion — *"the reviewer runs the checks twice in a row … with no manual tidying up in between"* — broken by the code added to honour §2.6's third. The fix is to set a flag, fall out of the `try`, let cleanup run, and set `process.exitCode = 3` at the end:

```ts
// NOT process.exit() here: that terminates immediately and skips the
// `finally` below, leaving the early payment_events row on disk — which
// would break the "run it twice with no tidying" criterion the skip is
// supposed to protect. Flag it, fall out of the try, let cleanup run.
skipped = true;
```

`process.exitCode` sets the value and lets the process end normally. `process.exit()` is a control-flow instruction that happens to look like a return value.

---

## 6. `before-order`: determinism bought with an affordance, and the trade said out loud

`before-order` is the one check that could not simply be written, and the decision behind it is the one a reviewer is most likely to challenge.

**The rejected alternative: drive it as a genuine, unstaged race.** Deliver enough concurrent webhooks and order-creates that "the report arrives first" sometimes happens by luck. This is more authentic, and it was tried — Slice 3's verifier won that race on the **first of three attempts.**

Achievable, and exactly what §2.6 rules out: *"the reviewer runs the checks twice in a row … then it behaves the same as the first."* A check that passes two runs in three is not a check a reviewer can run. It would also be the one non-deterministic script among four deterministic ones, which invites distrust of the other four — the same cost as the `FAIL`-on-skip in §5.

**What was built instead:** `ALLOW_CLIENT_SUPPLIED_ORDER_ID`, letting `POST /api/orders` accept an explicit `id` so the script can pre-choose the order id it delivers a webhook against, before that order exists anywhere. The guard rails on it are the argument for why this is acceptable rather than a hole:

- Off by default and **fails closed** when unset (`apps/api/src/config/client-supplied-order-id.ts`).
- Set **only** for instances `pnpm race` spawns for itself. Never for `pnpm dev:stack`, never in a deployment. `startApiInstance` defaults it to `false`, and the Vitest concurrency suite — the other caller — leaves it unset.
- Recorded in `architecture.md` §9 as a known trade-off, and documented in the check's own header rather than smuggled in.
- When the target refuses it, the check reports `SKIP`, not `FAIL` — §5.

Two more decisions inside the check are load-bearing.

**The webhook and the order-create go to *different instances*.** `targets.at(0)` stores the early event; `targets.at(1)` creates the order. If applying the event worked only because both requests landed on the same process, that would be in-process state doing the work — a `Map` the webhook populated and the create handler happened to read — rather than the database being the single source of truth every instance shares. Two OS processes, two pools of `max: 1`, meeting only in Postgres. This is §2's general argument, in its specific form for out-of-order delivery.

**Which trigger settles the event is reported and never asserted.** Two continuations can apply a pending event once its order exists: the order-creation drain (trigger 2) and the status-poll drain (trigger 3). Both race the same `FOR UPDATE SKIP LOCKED` claim, and Slice 3 found — by accident — that trigger 2 can legitimately miss, stepping over a row another worker already holds. Asserting "trigger 2 did it" would fail this check against a correct system. So it prints an `INFO` guess and asserts only the outcome.

What the runs actually show is the nicer half of that: across runs, `before-order` consistently reports the **status-poll drain (trigger 3)** settling the event. The legitimate "trigger 2 can miss" case that Slice 3 stumbled into once is now something a reviewer reproduces on demand.

And "without taking any further action" is literal in this check. After `POST /api/orders` returns, the script does exactly one thing: `GET /api/orders/:id` in a poll loop — which is what a shopper's own open tab does, and is itself trigger 3's gate. No admin sweep, no redelivery, no drain invoked directly.

---

## 7. What else was verified

- **`pnpm race` twice consecutively, no tidying in between:** 5/5 both times, exit `0` both times. That is §2.6's fourth criterion, and it is `cleanupTestOrders` in every check's `finally` that earns it — including `payment_events` deleted by `order_id` regardless of `processed_at`, so `race:webhooks`' forty-nine still-pending losing events go with everything else.
- **Database at the seeded baseline after every run:** `12 products, 50 unclaimed, 0 orders, 0 events, 0 deliveries`.
- **`create-order` also asserts the negative complement:** a *fresh* `Idempotency-Key` still creates a *new* order, with a different id. Without it, a check that only ever proves "concurrent things converge" would pass against an implementation that collapses every purchase of one SKU into a single order regardless of intent — over-merging by SKU rather than by intent. Functional spec §2.1's fifth criterion, and it costs one extra request.
- **Both halves of every claim are asserted — HTTP responses *and* direct database queries.** Architecture §7's reason is that the two disagree in *both* directions: Phase 1 saw a mis-classified driver error return `500` to nineteen of twenty callers while the database stayed perfectly correct, and a broken delivered-key gate return a self-consistent `null` to every read while the key sat committed in `deliveries`. Response-only calls the first a failure; database-only calls the second a pass.

---

## 8. Where this sits in the assignment

`context/product/product-definition.md` §1.4 lists five adversarial scenarios and calls them the definition of success. This slice settles functional spec **§2.6**, and turns scenarios **1, 2 and 3** from claims in a document into things a reviewer executes.

| # | Scenario | Status after this slice |
| --- | --- | --- |
| 1 | 50 parallel `paid` webhooks → one issuance fact, one key | Settled, and now **runnable**: `pnpm race webhooks`, at the assignment's stated number, across four processes |
| 2 | A repeated webhook with the same `event_id` changes nothing | Settled, and now runnable: `pnpm race same-event` |
| 3 | A webhook before its order, or out of order | Settled, and now runnable: `pnpm race before-order` |
| 4 | Empty pool leaves the order recoverable; after restock, exactly one key | Half-won. The out-of-stock path exists; the admin restock-and-reissue half is Phase 3, and there is no check here for it |
| 5 | A promo code with limit N under parallel requests | Phase 5. Not started |

`create-order` is not one of the five — it defends I1, which underlies all of them, and it is §2.1's own criterion.

**Two things that are documented but not done**, recorded here rather than left for a reviewer to find:

- **There is no root `README.md` yet.** `architecture.md` §7 says the mapping from acceptance scenario to named runnable check "lives in the README", and calls that mapping the deliverable. `scripts/race/README.md` documents the harness thoroughly, but the top-level file the architecture points at is Phase 6 work.
- **There are no per-check npm aliases.** `package.json` has `"race"` only, so the invocation is `pnpm race webhooks`. Both `scripts/race/README.md`'s "Adding a check" step 5 and `architecture.md` §7 name scripts as `race:webhooks`, `race:same-event`, `race:create-order` (and `webhook:before-order`, which is `before-order` here). The check names exist; the aliases do not.

---

## Interview questions this answers

**"You fire fifty concurrent webhooks and one key comes out. How do you know that proves anything?"**
On its own it does not, and that is the single most important thing in this slice. `packages/db` pins the connection pool to `max: 1` per process, deliberately, because that is the serverless shape — fifty concurrent invocations with `max: 10` would ask Neon for five hundred connections. Inside one process a transaction holds that one connection for the whole of `BEGIN … COMMIT`, so a second concurrent request queues in Node before a byte of it reaches Postgres. `FOR UPDATE SKIP LOCKED` never skips, because nothing else holds a row lock when the subquery looks. So a shop with no locking at all passes a single-instance run. We measured it: the key claim weakened to an unlocked `SELECT`-then-`UPDATE` handed out twenty distinct keys against one process and nine against four, with zero errors reported in both. A race check pointed at one instance measures the connection pool, not the constraint.

**"So why not just raise the pool size in the test?"**
Because `max: 1` is the configuration under test. A check that changes the shape of the thing it is checking proves some other system correct. The fix is more processes, not a bigger pool: `pnpm race` starts four real `apps/api` processes on separate ports, each with its own pool, and the checks round-robin across them. Against a deployed target we accept a single URL, because there the platform supplies the separate instances and we get no say in how many.

**"How do you know the four processes you started are really four processes?"**
`race:harness` counts distinct Postgres backends: `select pid from pg_stat_activity where application_name = 'game-shop' and pid <> pg_backend_pid()`. It runs `GET /api/products` against each target first — not just `/api/health`, because health answers `200` with no database at all since the pool is lazy — and the catalogue read is both the proof the instance can reach Postgres and the thing that opens its one connection. Pointed at `http://localhost:4301,http://127.0.0.1:4301`, which are two origins and one process, both health assertions still pass and the pid count fails with `1 distinct backend pid(s) as 'game-shop', need >= 2`. Serving and separate are the two things it refuses to conflate. The check connects under a different `application_name` and excludes its own pid, so it cannot count itself into a pass.

**"Did every check actually fail when you broke the thing it defends?"**
Four of five, cleanly. Deleting `ON CONFLICT (client_request_id)` gave nineteen `500`s out of twenty with `_bt_check_unique` in the log. Deleting `ON CONFLICT (event_id)` gave nineteen `500`s *and* `stored=1, duplicate=0, unrecognised=19` — two independent failures, because winning or losing that insert is the duplicate detection. Making the early-event branch settle instead of defer produced `did not settle within 15000ms (status=created)`. And every weakening was confirmed in `apps/api/dist/` before and after, because the spawned processes run `dist/main.js` and a stale build is the one way this exercise produces a convincing lie.

**"And the fifth?"**
The fifth is the interesting one. `race:webhooks` claimed to defend the atomic supplier key claim as well as I4. I dropped `FOR UPDATE SKIP LOCKED` from the claim and `race:webhooks` passed, eight assertions of eight, against a build I had confirmed weakened. Not a stale build — a real null result. The reason is exact: `race:webhooks` fires fifty reports at *one* order, and I4 admits exactly one worker to issuance, so the key claim is called once in the whole check. There is no concurrency there for the weakening to expose. The weakening is meanwhile catastrophic — the Vitest suite, which pays many orders in parallel, reported `expected 10 to be 20` distinct keys and fifty-five orders delivered from a fifty-key pool. So the check that guards the atomic claim is `key-claim-race.test.ts`, and `race:webhooks` guards I4. Nothing except running the exercise would have told me that.

**"What is the general lesson from that?"**
RED validation is not a formality that confirms a check can go red. It is the only way to find out which invariant a check actually guards. I had three assumptions a careful reader would have made from the source, and all three were wrong. `race:webhooks` did not guard the key claim. The guard is not what makes the key count one — widening `beginIssuance.from` so all fifty workers claimed the order still delivered exactly one key, because the deterministic `request_id` means all fifty ask the supplier the same question, I5's ledger returns the same code, and I3's `deliveries.order_id` UNIQUE binds it once. The guard's actual job is stopping forty-nine workers from reaching the supplier at all, which is `1` versus `50` lines of "claimed the order for issuance". And `race:webhooks` only caught that breach through its cleanup hitting a foreign key violation, not through any assertion it makes — a real limitation, written into the README rather than filed off.

**"Your `before-order` check stages the race rather than racing. Isn't that cheating?"**
It is a trade and I would name it before being asked. The authentic version is to fire enough concurrent webhooks and creates that "before" happens by luck; Slice 3's verifier won that race on the first of three attempts. §2.6 requires two consecutive runs to behave the same, so a check that passes two runs in three is not a check a reviewer can run — and it would be the one non-deterministic script among five, which invites distrust of the other four. So I built `ALLOW_CLIENT_SUPPLIED_ORDER_ID`: off by default, fails closed when unset, set only for the instances `pnpm race` spawns, never for `pnpm dev:stack` and never in a deployment, and recorded in `architecture.md` §9 as a known trade-off. What is *not* staged is the mechanism — the webhook goes to instance 0 and the order-create to instance 1, so nothing in-process can be doing the work, and which of the two drains settles the event is reported and never asserted, because both outcomes are correct.

**"You have a check that reports neither pass nor fail. Why?"**
`before-order` needs that flag on every targeted instance, and a deployed shop serving real shoppers should refuse it — that refusal is the flag working. Both binary answers are lies there. `FAIL` reports a correct system as broken, and a reviewer who sees red on a healthy system learns to distrust the other four checks. `PASS` counts an unrun check as evidence, which is the decoration §2.6 exists to forbid. So exit `3`: printed as `SKIP`, named in the summary, and subtracted from *both* sides of the ratio — `4/4 passed, 1 skipped`, never `4/5`, because a reviewer's eye lands on the missing one and reads it as a failure. It is the same rule the database helper already applied to a single assertion with no `DATABASE_URL`, raised to a whole check.

**"Anything you got wrong in this slice?"**
The first implementation of that skip called `process.exit(3)` inside the `try`. That terminates immediately and skips the `finally`, so the early `payment_events` row stayed on disk — breaking §2.6's "run it twice with no tidying" criterion, which is the exact property the skip existed to protect. It sets a flag, falls out of the `try`, lets `cleanupTestOrders` run, and sets `process.exitCode = 3` at the end. `exitCode` sets a value; `exit()` is control flow wearing a value's clothes.

**"What can a reviewer actually run, and what does it still not cover?"**
`pnpm race` covers scenarios 1, 2 and 3 of the assignment's five — fifty parallel webhooks at the stated number, the same `event_id` redelivered, and a report arriving before its order — plus I1's double-click, across four real processes, twice in a row with no tidying, and pointable at a deployed URL without being rewritten. Scenario 4 is half-won: the out-of-stock path exists, the admin restock-and-reissue half is Phase 3, and there is no check for it here. Scenario 5, the promo limit, is Phase 5 and not started. Two documented gaps too: there is no root `README.md` yet, although `architecture.md` §7 says the scenario-to-check mapping lives there, and `package.json` has only the `race` script, so the per-check `race:webhooks` aliases named in the README and the architecture do not exist — the invocation is `pnpm race webhooks`.

---

## Source files

- `scripts/race/README.md` — the harness, the RED table, and the interface for someone adding a check
- `scripts/race/run-checks.ts` — discovery, spawn, teardown, the summary ratio, and `EXIT_CHECK_SKIPPED`
- `scripts/race/harness.ts` — the check that checks the harness; the worked example for the shape
- `scripts/race/support/race-targets.ts` — `RACE_BASE_URLS` parsing, round-robin, and the single-instance warning
- `scripts/race/support/race-database.ts` — the skip-by-name rule for database assertions
- `scripts/race/create-order.ts` — I1, plus the fresh-key negative complement
- `scripts/race/same-event.ts` — I2, one `event_id` delivered twenty times
- `scripts/race/webhooks.ts` — I4, fifty distinct reports of one payment
- `scripts/race/before-order.ts` — out-of-order tolerance, the affordance, and the skip
- `apps/api/test/concurrency/key-claim-race.test.ts` — the check that actually guards the atomic key claim (§4.3)
- `apps/api/test/concurrency/support/api-instance.ts` — the one way API processes are started, shared with the Vitest suite
- `packages/db/src/client.ts` — `MAX_CONNECTIONS_PER_INSTANCE = 1`, and why it must not be raised
- `context/product/architecture.md` §3, §3.1, §7, §9 — the invariants, their SQL, the multi-process rule, and the order-id affordance
- `context/spec/002-single-issuance-under-races/functional-spec.md` §2.6 — the five acceptance criteria this slice settles
- `docs/walkthrough/phase-2-slice-5-one-worker-per-order.md` — I4's two halves, and the earlier RED validation that came back green

**On evidence:** what I re-ran while writing this document is source inspection only, no servers started. I confirmed the working tree is in its restored state after the RED exercise: `onConflictDoNothing` appears exactly once in `orders.service.ts` and once in `payment-events.service.ts`, and once in each of their compiled `dist/` counterparts; `beginIssuance: { to: OrderStatus.Delivering, from: [OrderStatus.Paid] }` in both `src/orders/order-transitions.ts` and `dist/orders/order-transitions.js`; `skipLocked` present in `dist/suppliers/supplier-key-claim.service.js`; `for("update")` present in `dist/orders/order-lock.service.js`; and `applyPaid`'s `OrderNotFound` branch logging and returning `DeferredOrderMissing` with no `markProcessed` call. I also verified `MAX_CONNECTIONS_PER_INSTANCE = 1` and `DEFAULT_APPLICATION_NAME = "game-shop"` in `packages/db/src/client.ts`, that no root `README.md` exists, and that `package.json` contains `"race"` and no per-check aliases.

Everything else is reported by other agents in this slice and quoted rather than paraphrased: the four-instance and two-origin harness runs, all five RED outcomes and their failure text, the `1` versus `50` "claimed the order for issuance" log counts, the 8/8 null result against the weakened key claim and the two `key-claim-race.test.ts` assertion errors that caught it, the `dist/` before-and-after inspections and the `shasum -a 256` restorations, the two consecutive `pnpm race` runs, the two-mode skip verification, and the seeded-baseline counts. The `20 distinct / 9 distinct` pool measurement is older still — it comes from Phase 1 and is recorded in `architecture.md` §7.
