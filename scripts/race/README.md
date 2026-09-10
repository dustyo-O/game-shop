# `scripts/race/` — the adversarial checks and the harness they run on

The reproducible race check the assignment asks for, and functional spec §2.6's
acceptance criterion. One command:

```sh
pnpm race
```

That starts four real `apps/api` processes on ports 4201–4204, waits until each
one is genuinely serving, runs every check in this directory against all four,
and stops all four afterwards — on success, on failure, and on Ctrl-C.

| Command | What it does |
| --- | --- |
| `pnpm race` | Every check, against 4 freshly built local instances. |
| `pnpm race webhooks same-event` | Only the named checks. |
| `pnpm race --list` | The checks that exist. Runs nothing, needs nothing running. |
| `RACE_BASE_URLS=https://game-shop.vercel.app pnpm race` | The deployed target. Builds nothing, spawns nothing, stops nothing. |
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
| `harness` | No source change — pointed at two origins that are secretly one process: `RACE_BASE_URLS=http://localhost:4301,http://127.0.0.1:4301` | `FAIL  targets hold separate database connections — 1 distinct backend pid(s) as 'game-shop', need >= 2`. Both `/api/health` and `/api/products` assertions still passed — "serving" and "separate" are exactly the two things this check refuses to conflate. |
| `create-order` | `orders.service.ts` — deleted `.onConflictDoNothing({ target: orders.clientRequestId })` | `FAIL  all 20 concurrent Buy attempts answered 2xx — 500 {"statusCode":500,…}` ×19, with `constraint: 'orders_client_request_id_key'`, `routine: '_bt_check_unique'` in the instance log. The `INFO` line moved from `201: 1, 200: 19` to `201: 1, 200: 0`. |
| `same-event` | `payment-events.service.ts` — deleted `.onConflictDoNothing({ target: paymentEvents.eventId })` | `FAIL  all 20 concurrent redeliveries answered 2xx — 500 …` ×19, and `FAIL  exactly one of the concurrent copies was stored as first sight … — stored=1, duplicate=0, unrecognised=19`. |
| `webhooks` | `order-transitions.ts` — `beginIssuance.from` widened from `[Paid]` to `[Paid, Delivering]`, removing the guard's exclusivity | `FAIL  webhooks  exited 1` on `error: update or delete on table "orders" violates foreign key constraint "deliveries_order_id_orders_id_fk"` during cleanup, because **50** workers logged `claimed the order for issuance` (against **1** with the guard intact) and the stragglers were still writing after the check had finished. Reproduced three times. |
| `before-order` | `payment-event-processor.service.ts` — added `await this.markProcessed(event);` to `applyPaid`'s `OrderNotFound` branch, so `deferred_order_missing` settles the early event instead of leaving it pending | `Error: order ord_race_beforeorder_… did not settle within 15000ms (status=created)`. The event was discarded, so neither drain ever found it and the order never left `created`. |

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

**Needs `DATABASE_URL` pointing at the same database the target uses:**

- `deliveries` row count for an order — the headline assertion
- `supplier_keys` claimed count
- `payment_events` row count for one `event_id`, and `processed_at`
- `orders` row count for one `client_request_id`
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
4. `DATABASE_URL` is set and has accepted a `select 1`.

Run on its own against a deployed target, only (1) still holds — this module
validates on every call. (2) is the platform's job, (3) is irrelevant, and (4)
may simply be false.

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

---

## Knobs

All optional, all with working defaults.

| Variable | Default | Meaning |
| --- | --- | --- |
| `RACE_BASE_URLS` | unset | Set → external mode: use these targets, build and spawn nothing. Unset → local mode. |
| `RACE_INSTANCES` | `4` | Local instances to start — the number `architecture.md` §7's measurement used. |
| `RACE_BASE_PORT` | `4201` | First port. Clear of `pnpm dev` (3000, 5173) and the Vitest concurrency suite (4101–4104). |
| `RACE_SKIP_BUILD` | unset | Skip the rebuild. Faster to iterate, and **wrong for RED validation** — the spawned processes run `dist/`. |
| `RACE_CHECK_TIMEOUT_MS` | `180000` | Per check. A hung check is killed and reported as a failure rather than hanging the run. |
| `RACE_VERBOSE` | unset | Stream each instance's stdout too, not just its stderr. |

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
  listening on 4201 for the reviewer to find later.
