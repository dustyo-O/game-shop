# `scripts/race/` — the adversarial checks and the harness they run on

The reproducible race check the assignment asks for, and functional spec §2.6's
acceptance criterion. One command:

```sh
pnpm race
```

That starts four real `apps/api` processes on ports 4601–4604, waits until each
one is genuinely serving, runs every check in this directory against all four,
and stops all four afterwards — on success, on failure, and on Ctrl-C.

| Command | What it does |
| --- | --- |
| `pnpm race` | Every check, against 4 freshly built local instances. |
| `pnpm race webhooks same-event` | Only the named checks. |
| `pnpm race promo` (alias `pnpm race:promo`) | Spec 005's check: twenty simultaneous `LIMIT3` and ten `ONCEONLY` applications across the four instances — exactly 3 and exactly 1 apply, the rest `409 exhausted`, none `5xx`. Locally it hands back the uses it spent through the database; against a deployed target with no `DATABASE_URL` it resets the counters through `POST /api/admin/promo-codes/reset` afterwards and says so. |
| `pnpm race --list` | The checks that exist. Runs nothing, needs nothing running. |
| `RACE_BASE_URLS=https://game-shop.vercel.app ADMIN_TOKEN=<the demo token> pnpm race` | **The reviewer's command.** The deployed target: builds nothing, spawns nothing, stops nothing, sees no database — every database-side assertion is SKIP by name, the HTTP spine is asserted for real. See "External mode". |
| `RACE_BASE_URLS=… ADMIN_TOKEN=… RACE_DEMO_RESET=1 pnpm race` | The same, ending with `POST /api/admin/demo/reset` on the first target so the transcript ends at baseline. The README's recorded run uses it. |
| `RACE_BASE_URLS=… ADMIN_TOKEN=… RACE_DATABASE_URL=<the target's database> pnpm race` | **The author's full run.** The target's own database forwarded to the checks as `DATABASE_URL`: no SKIPs, every check cleans up after itself. |
| `RACE_BASE_URLS=… node scripts/race/webhooks.ts` | One check, by hand, exactly as the runner invokes it. |

Exit code: `0` all passed, `1` a check failed, `2` the command or the
configuration was wrong.

---

## Why the harness starts *four* processes

`packages/db/src/client.ts` pins the connection pool to `max: 1` per process.
That is deliberate and must not change — it is the serverless shape, and
`architecture.md` §2 explains why fifty concurrent invocations with a larger
pool would exhaust Neon's connection limit.

The consequence for these checks is the whole reason this harness exists.
Inside one process a transaction holds that single connection for the whole of
`BEGIN … COMMIT`, so a second concurrent request **queues in Node, before a
byte reaches Postgres**. `FOR UPDATE SKIP LOCKED` never skips, because nothing
else holds a row lock when the subquery looks. Measured in this project with
the key claim weakened to an unlocked `SELECT`-then-`UPDATE`
(`architecture.md` §7):

| Harness | Codes handed out | Distinct | Errors |
| --- | --- | --- | --- |
| 1 process, pool `max: 1` | 20 | **20** | 0 |
| 4 processes, pool `max: 1` each | 20 | **9** | 0 |

The same broken code is flawless against one process and hands eleven customers
a key somebody else also holds against four — silently, in both cases.

**A race check pointed at a single local instance measures the connection pool,
not the constraint.** It passes against a shop with no locking at all. That is
why `RACE_BASE_URLS` is a list, why `pnpm race` spawns separate OS processes,
and why `race:harness` exists to confirm the targets really are separate before
anything else runs.

---

## External mode — the runner against a target it did not start

`RACE_BASE_URLS` set means somebody else owns the instances: the deployed shop,
or a stack already running locally. The runner then builds nothing, spawns
nothing and stops nothing — and, since spec 006, it also takes care that what
the checks *see* is the target and not the laptop. Phase 6's sentence is what
this mode exists to earn: *passing the race checks on Vercel, where every
request is its own process, is evidence that the guarantees live in Postgres
and not in memory.*

**The two commands.**

```sh
# The reviewer: no database in hand. HTTP assertions real, database-side ones SKIP by name.
RACE_BASE_URLS=https://<the alias> ADMIN_TOKEN=<the demo token> RACE_DEMO_RESET=1 pnpm race

# The author: the target's own database forwarded. No SKIPs; every check cleans up.
RACE_BASE_URLS=https://<the alias> ADMIN_TOKEN=<the demo token> RACE_DATABASE_URL=$NEON_DIRECT_URL pnpm race
```

**The mode line.** The first thing an external run prints names the targets and
answers the one question that decides what the transcript means:

```
race: external target(s) https://… — database: none (assertions SKIP by name)
race: external target(s) https://… — database: RACE_DATABASE_URL forwarded
```

**Environment hygiene (R7).** `scripts/with-env.ts` merges `.env.example` into
the runner's environment, so without care an external run would hand every
check `DATABASE_URL=…localhost:5433…` — the *local* database — while the target
writes to its own. The database half of every check would then fail on
`ECONNREFUSED` or, worse, assert against a database the target never touched.
External mode therefore builds the checks' environment **without
`DATABASE_URL`**, and puts one back only from `RACE_DATABASE_URL`. Local mode is
untouched: its children get the runner's own environment plus the two markers,
exactly as before.

`ADMIN_TOKEN` is forwarded as-is — the recover checks arm the supplier with it —
and when it is still `.env.example`'s default the runner says so once
(`race: ADMIN_TOKEN is the local default — export the target's token or the
admin-guarded checks will answer 401`), because the alternative is three checks
SKIPping on a `401` with no line explaining why.

**Warm-up.** Before the first check: `GET /api/products` on the first target
until it answers `200`, six attempts five seconds apart, each printed
(`race: warm-up — GET …/api/products → 200 in 53ms (attempt 1 of 6)`). The
catalogue and not `/api/health`, because health builds its pool lazily and
answers `200` with no database at all — it proves nothing about a Neon branch
resuming from autosuspend, and a cold first check would otherwise fail on
timing rather than on an assertion. A target that never answers ends the run
there with exit `2`.

**One banner, not nine lines.** With no database the runner prints, once:

```
race: ┌─ no DATABASE_URL for this run ──────────────────────────────────────────
race: │ every database-side assertion below is reported as SKIP by name — never counted as a pass;
race: │ orders these checks create stay on the target. Run `pnpm demo:reset` when the run ends,
race: │ or set RACE_DEMO_RESET=1 to have this runner call POST /api/admin/demo/reset after the last check.
race: └──────────────────────────────────────────────────────────────────────────
```

Each check then names its own skipped assertions where they would have run
(the rule in "Which assertions need database access" below); in the smoke run
against four hand-started local instances that is 39 `SKIP` lines across the
nine checks, and `9/9 passed` — the ratio counts only what ran.

**`RACE_DEMO_RESET=1`.** External mode only. After the last check and before
the summary the runner calls `POST /api/admin/demo/reset` on the first target
with `ADMIN_TOKEN` and prints what came back:

```
race: RACE_DEMO_RESET — POST https://…/api/admin/demo/reset
race:   removed  orders 38 · deliveries 6 · issuance_attempts 9 · promo_redemptions 4 · payment_events 55 · supplier_requests 6
race:   reset    promo_codes 0 · supplier_keys 6 · supplier_behaviour 1
race:   now      products 12 · keys_total 50 · keys_unclaimed 50 · orders 0 · …
```

A refused reset (`401`, `503`) is printed with the reason and the run exits
`2`: a transcript that was asked to end at baseline and did not must not exit
`0`. In local mode the variable is ignored with one line — local checks clean
up their own rows through `cleanupTestOrders` and the harness asserts the
baseline; a reset in their place would sweep a leaking application's residue
into `removed` and call it a pass. The runner's reset function throws if it is
ever reached in local mode, so that stays true by construction.

**`recover-timeout` reads the target's timeout (R8).** The trap check arms a
hang that must *outlast* the target's `SUPPLIER_TIMEOUT_MS`; against a live
target running `5000` a hang derived from the local `2000` would land on the
slow-but-successful side and the check would pass having exercised nothing. It
now prefers `supplier_timeout_ms` from the first target's `GET /api/health` and
prints which source it used:

```
supplier timeout 2000 ms (from target /api/health)
supplier timeout 2000 ms (from SUPPLIER_TIMEOUT_MS env — target did not report one)
```

### The instance-id witness — what the harness can prove over HTTP

Every response the API sends carries `x-instance-id`, one random UUID per
process (`apps/api/src/instance-identity.ts`). Locally the harness proves
"separate processes" from the database's side — one backend pid per instance
in `pg_stat_activity` — and a reviewer pointed at the live shop holds no
database, so the process has to say who it is over HTTP instead.

`race:harness` fires N = max(8, 2 × targets) concurrent `GET /api/health`,
spread round-robin, and asserts two things: every answer's header equals its
own body's `instance_id`, and — externally — **at least two distinct ids were
seen**. Exactly one is a `FAIL` with the reason spelled out:

```
FAIL  the 8 concurrent health answers came from at least two distinct instances — all 8 answers came from one instance — re-run, or check that Fluid Compute is off
```

Locally the same count is an `INFO` line: one id per port is a tautology when
the runner started those processes itself, and the pid count decides. The
runner sets `RACE_MODE` (`local` | `external`) for its children so the harness
can tell which reading applies; run by hand it assumes the external one.
`webhooks`, `same-event` and `promo` print the same count for their own batch
— `INFO  answers came from 4 distinct instance(s) — 50 answer(s)` — so a
reader can see whether the fifty reports were spread across processes.

**What the number does not prove, and the harness prints with it:** a distinct
id proves a distinct process, *not* that those processes overlapped in time —
two ids across eight answers are consistent with one instance recycled between
the first and the last. It rules out the one reading that would make a live run
worthless (every answer from one process, one `max: 1` pool), and no more. K = 1
on a given run means that run was not cross-process evidence, whatever the
checks after it say; the root README records the K of the author's run rather
than assuming it.

---

## RED validation — every check, deliberately broken

Functional spec §2.6: *"Given a check has passed, when the mechanism it defends
is deliberately weakened, then that check reports a failure — so a passing check
is evidence rather than decoration."*

Each row was produced by weakening **exactly one** mechanism in production
source, running `pnpm race <check>` against the full four-instance harness, then
restoring the file and confirming it byte-identical with `shasum -a 256`.
Nothing here is left in the tree. `pnpm race` rebuilds by default and the
spawned processes run `dist/main.js`, so every run below was also checked
against the built artefact — a stale `dist/` is the one way this exercise
produces a convincing lie, and it is the first thing to rule out.

| Check | Weakening | What the check reported |
| --- | --- | --- |
| `harness` | No source change — pointed at two origins that are secretly one process: `RACE_BASE_URLS=http://localhost:4301,http://127.0.0.1:4301` | `FAIL  targets hold separate database connections — 1 distinct backend pid(s) as 'game-shop', need >= 2`. Both `/api/health` and `/api/products` assertions still passed — "serving" and "separate" are exactly the two things this check refuses to conflate. **Phase 6, the HTTP witness:** external mode pointed at one hand-started instance (`RACE_BASE_URLS=http://127.0.0.1:4601 ADMIN_TOKEN=… pnpm race harness`, no database) — `PASS  x-instance-id header equals the body's instance_id on all 8 concurrent health answers — 8 of 8 agree`, then `FAIL  the 8 concurrent health answers came from at least two distinct instances — all 8 answers came from one instance — re-run, or check that Fluid Compute is off`; `race: 0/1 passed against 1 instance(s).`, exit `1`. The same four instances listed as four targets: `PASS … — 4 distinct instance id(s) across 4 target(s)`. |
| `create-order` | `orders.service.ts` — deleted `.onConflictDoNothing({ target: orders.clientRequestId })` | `FAIL  all 20 concurrent Buy attempts answered 2xx — 500 {"statusCode":500,…}` ×19, with `constraint: 'orders_client_request_id_key'`, `routine: '_bt_check_unique'` in the instance log. The `INFO` line moved from `201: 1, 200: 19` to `201: 1, 200: 0`. |
| `same-event` | `payment-events.service.ts` — deleted `.onConflictDoNothing({ target: paymentEvents.eventId })` | `FAIL  all 20 concurrent redeliveries answered 2xx — 500 …` ×19, and `FAIL  exactly one of the concurrent copies was stored as first sight … — stored=1, duplicate=0, unrecognised=19`. |
| `webhooks` | `order-transitions.ts` — `beginIssuance.from` widened from `[Paid]` to `[Paid, Delivering]`, removing the guard's exclusivity | `FAIL  webhooks  exited 1` on `error: update or delete on table "orders" violates foreign key constraint "deliveries_order_id_orders_id_fk"` during cleanup, because **50** workers logged `claimed the order for issuance` (against **1** with the guard intact) and the stragglers were still writing after the check had finished. Reproduced three times. |
| `before-order` | `payment-event-processor.service.ts` — added `await this.markProcessed(event);` to `applyPaid`'s `OrderNotFound` branch, so `deferred_order_missing` settles the early event instead of leaving it pending | `Error: order ord_race_beforeorder_… did not settle within 15000ms (status=created)`. The event was discarded, so neither drain ever found it and the order never left `created`. |
| `recover-refusal` | `issuance/issuance-ladder.ts` — the `fallThrough` rung's `requestId` read off the newest failed row (`req_{order}_a_1`) instead of `deriveIssuanceRequestId(orderId, untried, max(attempt)+1)`: a re-probe of a settled request wearing a fall-through's clothes, the exact shape the file's header names | 6 of 18 assertions. `FAIL  exactly two attempt rows for the order — found 1 row(s)`; `FAIL  a/1 reads failed with last_error supplier_rejected … — {…,"status":"ok","last_error":"supplier_rejected"}`; `FAIL  b/2 reads ok — the fall-through's own new request id … — undefined`; `FAIL  no supplier_requests row for a/1 … — 1 row(s)`; `FAIL  exactly one supplier_requests row for b/2, against provider b — {"n":0,"provider":null}`; `FAIL  exactly one supplier_keys row claimed by b/2's request id — 0 row(s)`. B was asked A's question: `reserveWithin`'s `ON CONFLICT (request_id) DO NOTHING` swallowed the insert, B's success was written over A's row, and the record now says a refusal succeeded. |
| `recover-timeout` | `issuance/issuance-ladder.ts` — `isDefinitelySettled` widened to admit `unknown`, so the outstanding guard (branches 2 and 3) never fires and `fallThrough` runs past a timed-out attempt. Slice 3's own RED, repeated against the shipped check | 5 of 16 assertions, and they are R2's: `FAIL  stock accounting holds after this run (claimed keys == deliveries, R2) … — claimed=2, deliveries=1`; `FAIL  exactly one more key claimed and exactly one more delivery than before this run — claimed +2, deliveries +1`; `FAIL  no issuance_attempts row for provider b — the hard rule held, B was never asked — 1 row(s)`; `FAIL  exactly ONE attempt row for the order … — found 2 row(s)`; `FAIL  a/1 reads status=ok, probe_count=2 … — {…,"status":"unknown","probe_count":1,"last_error":null}`. **Still `PASS`:** `the order settles delivered`, `exactly one deliveries row for the order`, `exactly one supplier_keys row claimed by a/1's request id`. |
| `recover-out-of-stock` | `issuance/issuance-ladder.ts` — the `IssuanceRound.Fresh` branch deleted, i.e. the pre-slice-5 ladder: an operator's opening turn recomputes `settleRefused` from the two refusals already on file. Re-run in Phase 6 after the check switched its drain and restock from direct SQL to `POST /internal/suppliers/keys/{drain,restock}` (the supplier's demo affordances, used on every run, with or without `DATABASE_URL`): same cut, rebuilt `dist/`, four instances, the local database present so no assertion SKIPped | 9 of 29 assertions, every one of them after the restock. `POST …/retry` answered `200 {"outcome":"still_out_of_stock",…,"detail":"every supplier was asked and has nothing to issue (a: out_of_stock; b: out_of_stock)","delivered":false}` against a pool the check had just restocked to 50 — nobody was asked. `FAIL  the retry report says delivered: true — {…"delivered":false}`; `FAIL  the order settles delivered after the retry — status=out_of_stock`; `FAIL  exactly THREE attempt rows after the retry (a/1, b/2, a/3) … — found 2 row(s)`; `FAIL  a/3 reads ok, provider a, attempt 3 … — undefined`; `FAIL  exactly one deliveries row for the order after the retry — 0 row(s)`; `FAIL  stock accounting holds at the SECOND settle point … — claimed=0, deliveries=0`; `FAIL  exactly one supplier_requests row for a/3, against provider a — {"n":0,"provider":null}`; `FAIL  a further retry on the now-delivered order answers 409 … — status=200`; `FAIL  still exactly three attempt rows … — 2 row(s)`. The twenty assertions up to and including the restock all passed — among them `PASS  POST /internal/suppliers/keys/drain { token } answers 200 — … "claimed":50`, `PASS  the pool reads empty before paying — 0 unclaimed`, `PASS  POST /internal/suppliers/keys/restock { token } answers 200 — … {"released":50}`, `PASS  the restock released exactly the keys this run's drain claimed (released == claimed) — released=50, claimed=50`: the automatic path and the staging around it are untouched by this weakening, which is what the two settle points are for. The check's `finally` then restocked by token once more (`released=0`) and the baseline held after. |
| `promo` | `promo/promo-redemption.service.ts` — the I7 statement (`UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1 AND used_count < max_uses`) replaced by a read-then-increment, in the two shapes spec 005's tech spec §4 predicts: (a) `SET used_count = $computed` from a prior `SELECT`; (b) `SET used_count = used_count + 1` with the `WHERE used_count < max_uses` dropped | **(a)** `INFO  response shape — 200: 9, 409 exhausted: 11` for `LIMIT3` and `200: 3, 409 exhausted: 7` for `ONCEONLY`. `FAIL  exactly 3 × 200 — the cap's worth, no more — 9 × 200`; `FAIL  exactly 17 × 409 exhausted — every other shopper told no, in words — 11 × 409 exhausted`; `FAIL  exactly 3 promo_redemptions row(s) among this run's 20 orders, all for LIMIT3 — the ledger half of I8 — 9 row(s)`, and the `ONCEONLY` trio the same way (`3 × 200`, `7 × 409 exhausted`, `3 row(s)`). **Still `PASS`:** `used_count = 3 for LIMIT3 — the counter half of I7 — used_count = 3` and `used_count = 1 for ONCEONLY` — the counter under-reports the ledger, which *is* the race; `zero 5xx` also still passed, since every write was `$read + 1` with `$read ≤ 2`. Nine rather than twenty: each process's `max: 1` pool caps the overlap at four transactions, so each wave of four reads one committed value and writes the same `read + 1` — the counter moves once per wave, the ledger once per winner. Then the check crashed in its own `finally`: `error: new row for relation "promo_codes" violates check constraint "promo_codes_used_count_range"` with `detail: 'Failing row contains (3, LIMIT3, percent, 25, null, 3, -6).'` at `cleanupTestOrders (…/support/db.ts:296:3)` — the decrement-by-what-it-deleted (9) taken from a counter of 3; `FAIL  promo  exited 1 (1838ms)`, `race: 0/1 passed`. Cleaned by hand with a counter reset, the one time that is honest. **(b)** `INFO  response shape — 200: 3, 500: 17` and `200: 1, 500: 9`. `PASS  exactly 3 × 200`; `FAIL  exactly 17 × 409 exhausted — every other shopper told no, in words — 0 × 409 exhausted`; `FAIL  zero 5xx — a guard weakened to an unconditional increment trips the CHECK as 500s while the counter still reads the cap (R2) — 17 × 5xx: 500 {"statusCode":500,"message":"Internal server error"}; …`; the same pair for `ONCEONLY` (`0 × 409 exhausted`, `9 × 5xx`). **Still `PASS`:** `used_count = 3 for LIMIT3`, `exactly 3 promo_redemptions row(s)`, `the ledger's order_id set equals the 200s'`, `the 3 winners carry amount_minor 96750 and the other 17 still carry 129000`, and the `ONCEONLY` equivalents — every database-side assertion, which is R2 exactly. In the instance log, 26 times (17 + 9): `ERROR [ExceptionsHandler] DrizzleQueryError: Failed query: update "promo_codes" set "used_count" = "promo_codes"."used_count" + 1 where "promo_codes"."id" = $1 returning "used_count"` / `cause: error: new row for relation "promo_codes" violates check constraint "promo_codes_used_count_range"` / `code: '23514'`, `detail: 'Failing row contains (3, LIMIT3, percent, 25, null, 3, 4).'`, `constraint: 'promo_codes_used_count_range'`, `routine: 'ExecConstraints'`. `race:promo FAILED (4)`; `FAIL  promo  exited 1 (1487ms)`. Its own cleanup ran clean — counter and ledger agreed at 3 — and the baseline was intact after. Also recorded, in the test file's header rather than here: with `lockOrder`'s `FOR UPDATE` removed this check stays `passed` — it races distinct orders only; the same-order case is `promo-limit-race.test.ts`'s third test. |

The mechanism weakened for `before-order` is an *absence* — `payment_events.order_id`
carries no foreign key — and adding one is a migration rather than a source edit.
The drain side was weakened instead, which removes the same guarantee for the same
scenario at a tenth of the blast radius.

### The one weakening that produced no failure, and why that is the finding

`race:webhooks` also names the **atomic supplier key claim** as a mechanism it
defends. Reducing that claim to a `SELECT`-then-`UPDATE` — dropping
`FOR UPDATE SKIP LOCKED` and awaiting the subquery as a statement of its own —
left `race:webhooks` **passing, 8 of 8 assertions**, against a build confirmed
weakened (`skipLocked`: 1 occurrence → 0 in
`apps/api/dist/suppliers/supplier-key-claim.service.js`).

A real null result, not a stale build, and the reason is exact: `race:webhooks`
fires fifty reports at **one** order, and I4 admits exactly one worker to
issuance — so the key claim is *called once* in this check. There is no
concurrency there for the weakening to expose.

The weakening is meanwhile catastrophic, which the Vitest concurrency suite shows
against that same build, because it pays many orders in parallel and therefore
does call the claim concurrently, with distinct `request_id`s:

```
FAIL  test/concurrency/key-claim-race.test.ts > pays 20 orders in parallel across 4 processes
AssertionError: N distinct keys — no code handed to two orders: expected 10 to be 20

FAIL  test/concurrency/key-claim-race.test.ts > pays 55 orders in parallel — more than the 50-key pool holds
AssertionError: exactly one order settles per available key: expected 55 to be 50
```

Ten of twenty shoppers held a key somebody else also held, and fifty-five orders
were delivered from a fifty-key pool. So the check that defends the atomic claim
is `apps/api/test/concurrency/key-claim-race.test.ts`; `race:webhooks` defends
I4, which is what its header already claims and all it should be credited with.

### What widening the guard actually proved

It did not produce a second key. The shopper still received exactly one, because
the deterministic `request_id` (`req_{order_id}_{provider}_{attempt}`) means all
fifty workers ask the supplier the *same* question, I5's `request_id → code`
ledger answers with the *same* code, and I3's `deliveries.order_id` UNIQUE binds
it once. The guard's job is not to make the key count one — I5 and I3 do that.
Its job is to stop forty-nine workers reaching the supplier at all, and `1`
versus `50` in the `claimed the order for issuance` log is that job, measured.

### What the three recovery REDs did not break

All three Phase 3 weakenings were made to one file,
`apps/api/src/issuance/issuance-ladder.ts`, and it was restored to
`a5715427c387d7d27c9ac9d58a089dd1d68c80c6c9a762211e83972192b86a24` after each
(weakened: `69610ae4…`, `e89e49e0…`, `67e74502…`). Each run was confirmed
against `dist/issuance/issuance-ladder.js` before the result was read. None of
the three came back null. What is worth reading is the assertions that stayed
green while the mechanism was gone.

**`recover-refusal`: the shopper got a key and stock accounting held.** The
supplier's ledger (I5) is keyed by `request_id` alone, so when the fall-through
asked B under A's id, B issued, the ledger filed it under `req_…_a_1`, and one
key left the pool for one delivery — arithmetic that cannot tell the difference.
What can is the attempt row, which now reads `status: "ok"` with
`last_error: "supplier_rejected"` still on it: a refusal that succeeded. Nothing
in the database can tell "the same id, asked again" from "a different question
sent under a stolen id" — `UNIQUE (request_id)` is satisfied either way. The id
derivation is the only thing standing between a fall-through and a re-probe of
a refusal, which is why this check reads the attempt rows rather than stopping
at `delivered`.

**`recover-timeout`: the order delivered, with one delivery row — and the pool
was short a key.** R2, measured on the shipped check rather than quoted: A had
cut a key for `a/1` (an attempt still `unknown`, `probe_count` 1), B cut a
second for `b/2`, and `deliveries.order_id` UNIQUE bound B's. Every assertion
phrased about the shopper passed. `claimed=2, deliveries=1` is the only place
the first key shows up, and the walkthrough for slice 3 §4 explains why that
equality is asserted only on settled outcomes.

**`recover-out-of-stock`: everything up to the restock passed.** The
weakening removes the operator's fresh round and nothing else, so the automatic
walk into an empty pool — two refusals, `out_of_stock`, zero keys — was
exactly right, and so was the staging around it: the drain and the restock are
HTTP calls to the supplier's own routes on every run (`claimed=50`,
`released=50`, the same numbers the table showed), which is what lets this row
be produced locally for a path the reviewer will exercise against the live
shop. The break is confined to what happens after a person presses retry, and
the retry's own report says so in words: *"every supplier was asked"* against a
pool that had just been refilled, with no supplier call made.

---

## The interface, for someone writing a check

Two modules, both in `scripts/race/support/`. Read their headers — they carry
the detail; this is the map.

### Targets — `support/race-targets.ts`

```ts
import { resolveRaceTargets } from "./support/race-targets.ts";

const targets = resolveRaceTargets();   // reads and validates RACE_BASE_URLS
targets.announce("race:webhooks");      // the banner; call it first, once

const responses = await Promise.all(
  Array.from({ length: 50 }, (_, i) =>
    fetch(`${targets.at(i)}/api/webhooks/payment`, { method: "POST", ... })),
);
```

| Member | What it gives you |
| --- | --- |
| `targets.at(i)` | Deterministic round-robin: request `i` always goes to instance `i % instanceCount`. **Prefer this** for a fixed-size batch — a failing run and its re-run send the same request to the same instance. |
| `targets.next()` | Stateful round-robin, for loops with no index to hand. |
| `targets.instanceCount` | How many separate base URLs there are. `1` is legal — see below. |
| `targets.baseUrls` | The whole list, normalised. |
| `targets.announce(name)` | Prints the banner, plus the single-instance warning when it applies. |
| `readInstanceId(response)` | The `x-instance-id` header of one response, or `undefined`. Read it inside the helper that consumes the body and keep it on the result. |
| `collectInstanceIds(responses)` | Distinct ids across a batch — from `Response`s, or from result objects carrying an `instanceId`. Returns `{ distinct, answers, unlabelled }`. |
| `describeInstanceIds(witness)` | The one `INFO  answers came from K distinct instance(s) — N answer(s)` line to print after a concurrent batch; flags K = 1 in the line itself. |
| `RACE_MODE_ENV` | `"RACE_MODE"` — set by the runner (`local` \| `external`), read by the harness. Not for checks to set. |

Every base URL is an **origin with no trailing slash**, so you always write
`` `${base}/api/orders` `` and never think about it. `parseRaceBaseUrls(raw)` is
exported separately for anything that needs to validate a list it assembled
itself.

`RACE_BASE_URLS` is validated at parse time and fails loudly:

- a missing scheme — `new URL("localhost:4201")` **succeeds**, with protocol
  `localhost:` and an empty hostname, and would otherwise surface much later as
  an unexplained `fetch failed` (`architecture.md` §8 records this exact trap);
- a path, query or fragment — entries are origins, and `http://host/api` would
  silently produce `/api/api/orders`;
- a duplicate — round-robin across one origin twice is round-robin across it
  once, so a duplicate makes `instanceCount` a lie;
- an empty list.

Whitespace around entries is trimmed, so `a, b , c,` is fine.

### `instanceCount === 1` is accepted, and is a weaker check

One URL is **correct** against a deployed target: Vercel supplies the separate
instances and we get no say in how many. Locally it proves nothing, for the
reason above. `announce()` says so out loud rather than letting a green
transcript imply something it did not prove. Checks do not need to add their own
warning; if a check wants to refuse a single instance, it can read
`targets.instanceCount` and decide for itself.

### Database — `support/race-database.ts`

```ts
import { openRaceDatabase, cleanupTestOrders } from "./support/race-database.ts";

const db = openRaceDatabase("webhooks");    // undefined when DATABASE_URL is unset
try {
  if (db === undefined) {
    console.log("  SKIPPED (no DATABASE_URL): deliveries row count, supplier_keys claimed");
  } else {
    const { rows } = await db.pool.query(
      "select count(*)::int as n from deliveries where order_id = $1", [orderId]);
    ...
  }
} finally {
  await db?.close();
}
```

It re-exports the Vitest concurrency suite's database helpers unchanged —
`readBaselineCounts`, `assertBaseline`, `cleanupTestOrders`,
`deriveTestRequestId`, `PURCHASABLE_SKU`,
`observeDistinctBackendPidsDuring` — so a check and
`apps/api/test/concurrency/` talk to Postgres through exactly one module. Read
`apps/api/test/concurrency/support/db.ts` before using them.

`requireRaceDatabase(role, assertions)` is the variant for a check with no
meaningful HTTP-only half: it throws, naming the assertions that were lost,
instead of returning `undefined`.

### Which assertions need database access

This is the split that decides what a check can honestly claim against a
deployed shop.

**HTTP only — works against any target, no `DATABASE_URL`:**

- every response's status code — "all fifty answered 2xx"
- the order's status read back from `GET /api/orders/:id`
- the delivered key as the shopper sees it
- all N responses naming the same order id (§2.1's idempotent create)
- the supplier's demo affordances and what they answer —
  `POST /internal/suppliers/keys/drain { token }` → `claimed > 0`,
  `POST …/restock { token }` → `released == claimed` — and the walk they
  stage, `out_of_stock` → retry → `delivered` (`recover-out-of-stock`, which
  drains and restocks through those routes on every run, with or without a
  database; the routes are the supplier's, so a shop that could not stage the
  scenario is a FAIL there, not a SKIP)
- the promo counters' reset, `POST /api/admin/promo-codes/reset` — `promo`
  calls it *only* when it has no database to hand back its uses through, and
  says so (the ledger keeps its rows; counter and ledger disagree afterwards by
  design)
- the `x-instance-id` header on every answer — `collectInstanceIds` above; the
  harness's PASS/FAIL externally, an INFO line in every check that fires a batch
- **not** a check's to call: `POST /api/admin/demo/reset`. The runner calls it
  once, after the last check, under `RACE_DEMO_RESET=1` in external mode; a
  check that reset the whole demo in place of its own cleanup would hide what
  it leaked (`support/recovery-scenario.ts`, `postDemoReset`)

**Needs `DATABASE_URL` pointing at the same database the target uses:**

- `deliveries` row count for an order — the headline assertion
- `supplier_keys` claimed count
- `issuance_attempts` rows for an order — how many, which request ids, which
  `status`/`last_error` (the recover checks' `a/1`, `b/2`, `a/3`: R7's "a
  third row, never a reused first" is only visible here)
- `supplier_requests` rows for a request id — a refusal writes none, a
  success exactly one
- the whole-pool reads that pair a drain's `claimed` and a restock's
  `released` with what the table actually shows (`recover-out-of-stock`:
  "the pool reads empty before paying", "restocked to its full starting
  size")
- `payment_events` row count for one `event_id`, and `processed_at`
- `orders` row count for one `client_request_id`
- `promo_codes.used_count` and the `promo_redemptions` rows for a run's orders
  — the counter and the ledger halves of I7/I8 (`promo`)
- the seeded-baseline check before and after a run
- `cleanupTestOrders`, which is what makes a second run work with no manual
  tidying

Both halves are asserted, because they disagree in *both* directions
(`architecture.md` §7): Phase 1 saw a mis-classified driver error return `500`
to nineteen of twenty callers while the database stayed perfectly correct, and a
broken delivered-key gate return a self-consistent `null` to every read while
the key sat committed in `deliveries`.

**The rule when there is no database route: report the skipped assertions by
name, and never count them as a pass.** A check that quietly drops "exactly one
delivery row" and still prints PASS is worse than one that fails — it is a false
statement about the system that gets more convincing every time it runs.

One caveat nothing here can check: that `DATABASE_URL` points at the database
the *target* is using. Locally the runner passes both to the same place. Against
a deployed target it is the operator's claim, and a mismatch shows up as a check
finding zero rows for an order the API just returned.

### What is guaranteed when your check starts

Under `pnpm race`, by the time your first line executes:

1. `RACE_BASE_URLS` is set and already validated — `resolveRaceTargets()` will
   not throw on a configuration problem the runner could have caught first.
2. Every listed instance has answered `GET /api/health` with `200`. Not "has
   been spawned" — **has served a real HTTP request**. Do not poll for
   readiness.
3. `@game-shop/db`, `@game-shop/contracts` and `apps/api` have been rebuilt from
   current source, so a deliberately weakened mechanism is genuinely the code
   running. This is what makes RED validation meaningful: the spawned processes
   run `dist/main.js`, so an un-rebuilt edit would not reach them.
4. `DATABASE_URL` is set and has accepted a `select 1` — **in local mode.** In
   external mode it is set only when `RACE_DATABASE_URL` was given, and is
   otherwise deliberately absent (see "External mode"); `openRaceDatabase`
   returns `undefined` and your database half SKIPs by name.
5. `RACE_MODE` is `local` or `external`, so a check that must read the two
   differently (the harness) can.

Run on its own against a deployed target, only (1) still holds — this module
validates on every call. (2) is the platform's job, (3) is irrelevant, (4) may
simply be false, and (5) is unset.

---

## Adding a check

Drop a file at `scripts/race/<name>.ts`. It is picked up automatically; there is
no registry to update, deliberately, because four different authors add the four
checks and a shared list is four chances to forget one.

1. Top-level `.ts` files in `scripts/race/` are checks. Helpers go in
   `scripts/race/support/`, which is never scanned.
2. Read targets from `RACE_BASE_URLS` via `support/race-targets.ts`. Never
   hard-code a host or a port.
3. Exit `0` on pass, `1` on fail, `3` when the check **could not run here**.
   Nothing else is inspected — not stdout, not a report file.

   Exit `3` is for an affordance the target does not grant, not for a shop that
   is wrong. `before-order` is the case that forced it: it needs
   `ALLOW_CLIENT_SUPPLIED_ORDER_ID` on every targeted instance, which `pnpm
   race` sets for the instances it spawns and a deployed shop serving real
   shoppers should refuse. Both binary answers lie there — `FAIL` reports a
   correct system as broken and teaches a reviewer to distrust the other
   checks, and `PASS` counts an unrun check as evidence, which is the
   decoration §2.6 exists to forbid. A skipped check is printed as `SKIP`,
   named in the summary line, and subtracted from **both** sides of the ratio
   (`4/4 passed …, 1 skipped (before-order)`, never `4/5`). It is the same rule
   `support/race-database.ts` applies to a single assertion with no
   `DATABASE_URL`, raised to the level of a whole check. Skip only when the
   check genuinely cannot run — never to make a red run green.
4. Clean up what you wrote (`cleanupTestOrders`), so `pnpm race` twice in a row
   works with no manual tidying. §2.6 makes that a criterion.
5. `<name>` becomes the check's name in the runner and should match the npm
   alias you add, e.g. `scripts/race/webhooks.ts` ←→ `pnpm race:webhooks`:

   ```json
   "race:webhooks": "node scripts/with-env.ts node scripts/race/run-checks.ts webhooks"
   ```

`harness.ts` runs first when present; everything else runs in filename order.
Checks run one at a time, never concurrently: they share one 50-key
`supplier_keys` pool and one seeded baseline, so overlapping them would make one
check's cleanup another check's flake.

`harness.ts` is the worked example — read it top to bottom for the shape.

### Making a supplier misbehave — `PUT /internal/suppliers/:provider/behaviour`

A check that needs a refusal or a silence causes it through the supplier's own
control endpoint, behind the same `ADMIN_TOKEN` the sweep is behind:

```
PUT /internal/suppliers/a/behaviour
Authorization: Bearer $ADMIN_TOKEN
{ "fail_next": 1 }                            -- refuse exactly the next call
{ "hang_next": 1, "hang_ms": 5000 }           -- THE TIMEOUT TRAP (see below)
{ "hang_next": 1, "hang_ms": 500,
  "hang_before_claim": true }                 -- slow, but successful
{}                                            -- restore the seeded baseline
```

**Every knob is live.** `fail_next` / `failure_rate` are read by both stubs
before the key claim, so an armed refusal answers `422 supplier_rejected` and
provably claims nothing (`apps/api/src/suppliers/supplier-behaviour.service.ts`,
`shouldRefuse`). `hang_next` / `hang_rate` are read the same way, but the *wait*
they decide on is held on the side of the key claim that `hang_before_claim`
names (`apps/api/src/suppliers/supplier-hang.ts`).

##########################################################################
# WHERE THE HANG SITS DECIDES WHICH SCENARIO YOU STAGED. THEY ARE TWO
# DIFFERENT CHECKS, NOT TWO SETTINGS OF ONE.
##########################################################################

| Want | Body | Why |
|---|---|---|
| **The timeout trap** — a key genuinely issued and a client that cannot know it | `{ "hang_next": 1, "hang_ms": 5000 }` | The supplier claims the key, commits it to its ledger, *then* waits. With `hang_ms` past `SUPPLIER_TIMEOUT_MS` (2000 by default) the shop's `AbortSignal.timeout` severs **its own socket** — it does not stop the stub — so the attempt is recorded `unknown`, never `failed`, while a code sits on file for that `request_id`. A re-probe with the same id gets that same code back. |
| **Slow but successful** — a slow supplier is not a failed one | `{ "hang_next": 1, "hang_ms": 500, "hang_before_claim": true }` | The wait happens before anything is claimed, and being shorter than the shop's deadline it produces no timeout at all: the call simply completes late. |

`hang_before_claim` defaults to `false`, i.e. **after the claim**, because that
is the scenario this phase exists to demonstrate and the one an armed
`hang_next` almost certainly means. The other placement must be asked for by
name. Pair each placement with the matching duration or you have staged
neither: a long hang *before* the claim is a request that genuinely has no
answer, and a short hang *after* it never times out.

It is a boolean rather than a `hang_at` enum because there are exactly two
places a hang may go — the claim and its ledger write are one transaction — and
the only third value anyone would reach for is *inside* it, which would hold the
instance's single pooled connection for `hang_ms` and stall every other request
in that process.

It is a **replacement, not a patch**: an omitted field is reset to zero, so the
body you send fully determines the supplier's behaviour and `{}` is the reset.
The state lives in the `supplier_behaviour` table rather than in a process, so
one `PUT` reaches all four spawned instances — an in-process rate would reach
one, and the other three would keep succeeding while your check passed having
exercised nothing.

##########################################################################
# USE `fail_next` / `hang_next` AND RATES OF EXACTLY 0 OR 1. NEVER A
# FRACTIONAL RATE.
##########################################################################

`failure_rate` and `hang_rate` are there for a person exploring by hand. In a
check they make §2.6's *"twice in a row, no tidying in between"* untrue **by
construction** — not flaky because of a bug, but unreproducible because a coin
is being tossed. The intermittent red that follows reads to a reviewer as a
correctness defect in the shop, which is the most expensive kind of wrong
answer this directory can produce (spec 003 technical-considerations §11, R8).

The one-shot counters are what make that criterion achievable: *"refuse exactly
the next call"* is a statement about one specific call, and two runs of it are
identical. They are consumed by an atomic conditional `UPDATE … WHERE
fail_next > 0`, so the four instances cannot both spend the one you armed.

Restore the baseline in your cleanup, beside `cleanupTestOrders` — a check that
leaves a knob turned up is a check that breaks the next one.

---

## Knobs

All optional, all with working defaults.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RACE_BASE_URLS` | unset | Set → external mode: use these targets, build and spawn nothing. Unset → local mode. |
| `RACE_INSTANCES` | `4` | Local instances to start — the number `architecture.md` §7's measurement used. |
| `RACE_BASE_PORT` | `4601` | First port. Clear of `pnpm dev` (3000, 5173) and every port the Vitest suites bind (4101–4104, 4201, 4301, 4401–4402, 4501–4504, 4701–4704, 4801–4804, 4901, 5201–5204 — `test/concurrency/promo-limit-race.test.ts` — 5301 — `test/acceptance/promo-codes.test.ts` — 5401 — `test/acceptance/vercel-entry.test.ts` — and 5402 — `test/acceptance/demo-routes.test.ts`) and 5101–5102 (the web e2e). Moved from 4201 in Phase 2 when it turned out to collide with `test/acceptance/purchase-and-key-delivery.test.ts`, which binds that exact port — and this list lagged again in Phase 3, when `test/concurrency/supplier-refusal-and-recovery.test.ts` bound 4601–4604 for two slices before the acceptance slice noticed; that suite moved to 4701. |
| `RACE_SKIP_BUILD` | unset | Skip the rebuild. Faster to iterate, and **wrong for RED validation** — the spawned processes run `dist/`. |
| `RACE_CHECK_TIMEOUT_MS` | `180000` | Per check. A hung check is killed and reported as a failure rather than hanging the run. |
| `RACE_VERBOSE` | unset | Stream each instance's stdout too, not just its stderr. |
| `RACE_DATABASE_URL` | unset | **External mode only.** The target's own database, forwarded to the checks as `DATABASE_URL` — the author's full run. Without it external mode strips `DATABASE_URL` from the checks' environment so nothing asserts against the local database (R7). |
| `RACE_DEMO_RESET` | unset | **External mode only;** ignored with one line locally. Non-empty → `POST /api/admin/demo/reset` on the first target after the last check, counts printed. A refused reset exits `2`. |
| `RACE_MODE` | — | **Not a knob.** Set by the runner for the checks it spawns — `local` or `external` — and read by the harness to decide whether a distinct-instance count is a PASS/FAIL or an INFO line. Unset when a check is run by hand (the external reading applies). |

Do not put `RACE_BASE_URLS` in `.env` or `.env.example`: `scripts/with-env.ts`
would then export it on every run, and `pnpm race` would permanently stop
spawning local instances and silently start expecting somebody else's.

---

## Relationship to `apps/api/test/concurrency/`

There is one mechanism for starting API processes, and it lives in
`apps/api/test/concurrency/support/api-instance.ts`. The Vitest concurrency
suite and this runner both use it. Two options were added to it for the CLI case
and are unused by Vitest:

- `onOutput` — stream a live instance's stdout/stderr, so an instance that dies
  at request forty is visible rather than showing up as four identical
  `fetch failed` lines.
- `onSpawn` — register a child for teardown *before* the health poll. Vitest
  cannot need it (`afterAll` runs only after `beforeAll` returns), but a signal
  to the runner during startup would otherwise leave a booting `apps/api`
  listening on 4601 for the reviewer to find later.
