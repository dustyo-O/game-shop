# Phase 5 · Slice 3 — The limit holds under parallelism

> The fifth adversarial scenario is now a number rather than an argument. Twenty shoppers on twenty orders send `LIMIT3` at the same instant to four separate API processes, each with a connection pool of one, and exactly three are told yes, seventeen are told `409 { "reason": "exhausted" }`, nobody sees a `500`, the counter reads `3`, and the three ledger rows name exactly the three orders that answered `200`. Ten of `ONCEONLY` → one. Four presses of the same code on one order → four identical `200`s and one use spent. What exists after this slice is that proof as a Vitest file on ports 5201–5204, its header carrying three deliberate breakages with their output verbatim; a reviewer's copy, `pnpm race promo`, that prints the same assertions by name and cleans up after itself; and one admin endpoint that lets the copy run twice against a deployed shop whose database it cannot reach.
>
> Three things carry the slice, and the first is the whole phase. **A read-then-increment is a race, and one conditional `UPDATE` replaces it.** Two shoppers read `2`, both decide `2 < 3`, both write `3`: two uses recorded, the counter moved once. No code between the read and the write can close that, because the value Node is checking is a fact about the past by the time it is checked. `UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1 AND used_count < max_uses RETURNING used_count` reads and writes in one statement, behind the row's own lock, with the `WHERE` re-evaluated against the row as the previous transaction left it — so the fourth in the queue matches nothing and writes nothing. **The proof needs four processes.** Inside one process the pool of one serialises every transaction in Node, and the broken guard passes with exactly `3`; across four, the same broken guard admitted nine and eleven. **The assertion is the shape of the refusals, not the counter.** Weaken the guard the other way — drop the `WHERE` — and the fourth increment does not write `4`: it trips `CHECK (used_count <= max_uses)`, aborts, and answers `500` while the counter still reads `3` and the ledger holds three rows. Every database-side fact a counter-only test could read was correct; seventeen shoppers saw "Internal server error".
>
> Reading the delivered work found one thing the technical spec predicted in kind and not in degree (Shape A produced nine and eleven successes, not twenty — the pools cap each wave at four), one thing it did not predict at all (the harness's decrement-cleanup took nine from a counter of three, tripped the same CHECK from below, and its throw in `finally` replaced the assertion it was cleaning up after), one half-prediction that did not happen (with the order lock removed the counter did not overshoot, because the ledger's `ON CONFLICT` and the invariant throw rolled each loser's increment back), and one gap that is named rather than closed (`pnpm race promo` cannot see a missing order lock; the Vitest file's third test is the only guard). Nothing in `src/`, `test/` or `scripts/` was edited for this document — a verify agent was running the suites against the tree while it was written.

---

## 1. What actually shipped

| # | Change | Where | Size |
| --- | --- | --- | --- |
| 1 | The four-process race: three tests on ports 5201–5204 — `LIMIT3` ×20 on twenty orders, `ONCEONLY` ×10 on ten, one order with the same code ×4 — each inside `observeDistinctBackendPidsDuring`, each asserting the response shape before the database, each cleaning up in `finally`, the baseline asserted before and after. The header records three RED shapes with their output verbatim | `apps/api/test/concurrency/promo-limit-race.test.ts` | 737 lines, of which the first 284 are the header; `3 passed` in 9.40 s green |
| 2 | The reviewer's copy: `pnpm race promo` — the same two scenarios, the same assertion set printed as `PASS`/`FAIL` lines by name, `cleanupTestOrders` in `finally`, a `SKIP` convention when the database is out of reach, and a fallback to the admin reset for a deployed target | `scripts/race/promo.ts`; `race:promo` in the root `package.json`; the command table, the RED table and the port row of `scripts/race/README.md` | 601 lines; the ninth check `pnpm race` discovers by filename |
| 3 | The demo affordance: `POST /api/admin/promo-codes/reset` behind `AdminTokenGuard` — `UPDATE promo_codes SET used_count = 0`, the four codes returned with their counters, `200`, no body, logged at `warn` | `apps/api/src/admin/promo-codes-reset.controller.ts`, `promo-codes-reset.service.ts`, `promo-codes-reset.types.ts`; `admin.module.ts` ("three routes" → "four") | One statement, no `WHERE`, no transaction; the controller's header is the argument for why local runs never call it |
| 4 | `architecture.md` §9 gains two trade-offs beside `ALLOW_CLIENT_SUPPLIED_ORDER_ID`: the reset (counter zeroed, ledger kept, the two disagree by design) and R6's apply-vs-pay window (documented, not closed) | `context/product/architecture.md` | Two bullets, each marked _Added in Phase 5_ |

Change 1 is the one to read first, and its header before its tests — the RED section in particular, because the three breakages are the evidence for every claim in this document. The tests themselves are the shape every sibling concurrency suite has: build, spawn four `dist/main.js` processes, wait on `/api/health`, create the orders round-robin, fire the requests in one `Promise.all` while a second connection samples `pg_stat_activity` for distinct backend pids, assert, clean up, assert the baseline.

**Where this sits in the assignment.** `product-definition.md` §1.4's five adversarial scenarios, in the table Phase 3's first walkthrough drew:

| # | Scenario | Status after this slice |
| --- | --- | --- |
| 1–3 | Fifty parallel `paid` webhooks; a repeated `event_id`; a webhook before its order | Settled in Phases 1–2. Untouched. |
| 4 | Empty pool → recoverable → after restock, exactly one key | Settled in Phase 3. Untouched. |
| 5 | A promo code with limit N under parallel requests is applied at most N times | **Settled, and runnable by name.** `pnpm race promo` locally or against a URL; `pnpm test:concurrency` for the Vitest proof with its RED. Proven against the two tightest seeded codes, `LIMIT3` and `ONCEONLY`, across four processes. |

All five scenarios now map to a named, runnable check — the coverage target architecture §7 set in Phase 1. And this one is the second, independent instance of the argument Phase 2 made for the first four: the guarantee lives in one SQL statement the database evaluates under a lock, not in anything a process remembers, which is why four processes that share nothing agree on the count. Phase 2's statement picked a free row (`FOR UPDATE SKIP LOCKED` inside `UPDATE supplier_keys … RETURNING`); this phase's tests-and-writes one row (`WHERE used_count < max_uses`). Same principle, different shape — §4.4 sets them side by side.

---

## 2. The words this document uses

- **Read-then-increment** — the shape being argued against: `SELECT used_count` into a variable, compare it to the limit in application code, then `UPDATE … SET used_count = <that variable> + 1`. Also called check-then-act, or a TOCTOU (time-of-check to time-of-use) window. Two round trips with a decision between them.
- **Conditional update** — the shape that replaces it: one `UPDATE` whose `WHERE` carries the condition and whose `SET` is relative to the row, so the database decides and writes in one step. I7 in `architecture.md` §3.
- **The row lock, and the queue** — when a transaction updates a row, Postgres locks that row until the transaction ends; every other transaction that reaches the same row with an `UPDATE` waits, in arrival order, for that lock. The wait is on the one row — other rows of the same table are untouched, no table lock is taken, and nothing in Node is involved. "Queues on the row" in this document means exactly that wait.
- **`READ COMMITTED`** — Postgres's default isolation level, and this project's by design. Each statement sees data committed before the statement began. It matters here because of what happens when an `UPDATE` finds its row changed underneath it, which is the next entry.
- **Re-evaluation** — under `READ COMMITTED`, an `UPDATE` that waited for another transaction's lock does not proceed on the stale version of the row it first found. When the lock is released it fetches the row as the other transaction committed it, re-checks the `WHERE` clause against that version, and either updates it or skips it. Postgres has a name for the machinery, given once in §4.2; this document otherwise says "re-evaluates the `WHERE` against the row as the previous transaction committed it".
- **A wave** — in the four-process harness, the up-to-four transactions that can be inside Postgres at the same instant, one per process, because each process's pool holds one connection. The word is needed to explain why the broken guard admitted nine and not twenty.
- **The shape of the refusals** — the histogram of HTTP statuses a race produces: exactly N × `200`, the rest × `409 { "reason": "exhausted" }`, nothing else. The assertion R2 says must come first; §5.2 is why.
- **Mechanism vs backstop** — Slice 1's pair. The mechanism is the conditional `UPDATE`; the backstop is `CHECK (used_count >= 0 AND used_count <= max_uses)`, `promo_codes_used_count_range`, which refuses a row the mechanism should never have produced. A backstop can hold with the mechanism gone, which is the whole of R2.
- **The counter and the ledger** — `promo_codes.used_count` and `promo_redemptions`. In production they agree at every commit; the harness asserts the agreement and never enforces it by copying one into the other.
- **The harness** — `apps/api/test/concurrency/support/`: `api-instance.ts` spawns real API processes; `db.ts` holds the baseline, the cleanup CTE and the pid witness. `scripts/race/support/` is its sibling for the checks that take a base URL.
- **RED** — a deliberate breakage of the one mechanism a test defends, run to see the test fail, then restored byte-identical. Architecture §7: a race test that cannot fail is a false statement about the system. Three REDs here — Shape A, Shape B and the lock RED — recorded verbatim in the test's header.
- **The reviewer's copy** — `scripts/race/promo.ts`, run as `pnpm race promo`. The same proof, written to be pointed at any base URL and to print what it found.
- **The admin reset** — `POST /api/admin/promo-codes/reset`. Zeroes every counter, leaves the ledger. For the deployed shop only.

---

## 3. Why a read-then-increment is a race

Take the obvious implementation, the one every first draft writes. `LIMIT3` has `max_uses = 3`. A shopper applies it, and the code does what the sentence "used at most three times" seems to ask for:

```sql
SELECT used_count FROM promo_codes WHERE code = 'LIMIT3';   -- returns 2
-- in TypeScript: if (usedCount >= maxUses) return exhausted;  // 2 < 3, go on
UPDATE promo_codes SET used_count = 3 WHERE code = 'LIMIT3'; -- $read + 1
INSERT INTO promo_redemptions …;
```

Now two shoppers, A and B, at the same instant, with the counter at `2`. A's `SELECT` returns `2`. B's `SELECT` returns `2` — nothing has changed yet, and a `SELECT` takes no lock that would make B wait for A. A's TypeScript compares `2 < 3` and goes on. B's TypeScript compares `2 < 3` and goes on. A writes `used_count = 3`. B writes `used_count = 3`. Both insert a ledger row. The code was applied twice — two uses recorded, two orders discounted — and the counter moved once, from `2` to `3`. The limit read "used three times"; the ledger says four.

Generalise it. With N transactions reading at the same moment, all N read the same committed value, all N pass the same comparison, all N write the same `read + 1`. The counter advances by one per *moment*, the ledger by one per *transaction*. Nothing about N = 2 was special: the harness in §6 measured N = 4 per moment, because that is how many transactions four processes can hold inside Postgres at once, and the counter ended at `3` with nine and eleven rows behind it.

**Which statement pair has the window, and why nothing between them closes it.** The window is between the `SELECT` returning and the `UPDATE` arriving — two round trips to the database with a decision made in between, in a process that is one of several. During that gap the database is free to commit any number of other transactions' writes to the same row, and the number sitting in Node's variable is a fact about the past. A check in TypeScript checks a value that is already stale — necessarily, since the check runs after the read has returned and before the write is sent. Adding a second check does not help (it checks the same stale number). A lock in Node does not help (a second process has its own Node, its own memory, its own lock — the API runs as serverless functions where two requests are two processes). A retry loop does not help (it retries the same read-then-write). Making the gap shorter does not help (it is a race, not a timeout; the harness closed it to 204 ms across twenty requests and still got nine). What closes it is one of two things: make the database decide the value at the moment it writes, or hold a lock from the read to the write so that no one else can read in between. Both put the decision in Postgres. The first does it in one statement, and that is I7.

---

## 4. How one conditional `UPDATE` replaces it

### 4.1 The statement

`architecture.md` §3.1 writes I7 as:

```sql
UPDATE promo_codes
SET used_count = used_count + 1
WHERE id = $1 AND used_count < max_uses
RETURNING *;
-- 0 rows => exhausted; reject the redemption
```

and the transaction's step 5 issues it as Drizzle emits it, with one column returned rather than `*`:

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

The check and the write are one statement. There is no `SELECT` before it that returns the count to Node; there is no TypeScript comparison; there is no variable holding a number that could go stale. The database evaluates `used_count < max_uses` against the row at the instant it is about to write that row, and either writes it or does not.

### 4.2 The queue, and what each transaction sees when its turn comes

Twenty of these arrive at one row. The first to reach it takes the row's lock — an `UPDATE` always does — and holds it until its transaction commits. The other nineteen queue *on that row*: not on the table (a shopper applying `WELCOME10` is not waiting behind `LIMIT3`'s queue), and not in Node (four processes share no memory; the queue is inside Postgres, where the row is).

When the first commits, `used_count` is `1`. The second transaction in the queue now obtains the lock. Here is the step that makes the statement correct rather than merely tidy. Under `READ COMMITTED`, the second `UPDATE` began with a snapshot in which `used_count` was still `0` — but Postgres does not write on that stale version. Having waited for the row's lock, it fetches the row **as the previous transaction committed it**, re-evaluates the `WHERE` clause — `used_count < max_uses` — against that version, and only if it still matches does it apply `used_count + 1` to it. Postgres's name for this is EvalPlanQual; in plain words: the `WHERE` is re-checked against the newest committed row, not the one the statement first saw. So the second sees `1 < 3`, writes `2`, commits. The third sees `2 < 3`, writes `3`, commits. The fourth obtains the lock, re-evaluates `3 < 3`, matches zero rows, updates nothing, and `RETURNING` hands back nothing. The fifth through twentieth do the same. Three winners, seventeen refusals, whatever order the twenty happened to reach the row in — the technical spec's §2.2 says exactly this, and the service header repeats it.

There is no window because there is nothing between the check and the write for another transaction to slip into. The read of `used_count` and the write of `used_count + 1` are one operation on one row under one lock. That is the sentence the roadmap asked the author to be able to say, and §11 says it in two.

### 4.3 The three details the statement is built from

**`used_count + 1` in SQL, not `$read + 1` from Node.** The increment is relative to whatever the committed value is at the moment the statement runs — after the queue, after the re-evaluation. A computed absolute value (`SET used_count = 3`) is relative to a value read earlier, and "earlier" is the window. Shape A in §6 is precisely this substitution, and it is the RED the technical spec's R1 predicted: more than three winners.

**`RETURNING "used_count"` tells one row from zero.** Without it the statement would succeed silently whether it updated one row or none, and the code would need a row count — or a second read — to know whether this transaction holds a use. With it, `use === undefined` is the exhausted branch, decided from the statement's own result, and the returned count goes on the log line as the use this transaction took.

**Step 4 deliberately does not select `used_count`.** The definition read that precedes step 5 selects `id, code, kind, value, currency, max_uses` and stops. The counter is read by no statement but the one that writes it. That is not tidiness: the moment a TypeScript variable holds the count, someone can compare against it, and Shape A began by adding `used_count` to that very column list. Leaving it out is how the code cannot be drifted into the race by a well-meaning edit.

### 4.4 The same argument, a second time

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

Set beside I7, the two statements do different things with the same principle. I6 *picks a free row*: the subquery locks one unclaimed key and skips any row another transaction already holds, so twenty claimants take twenty different keys without waiting for each other. I7 *tests-and-writes one row*: every redemption of `LIMIT3` wants the same row, so they must queue on it, and `SKIP LOCKED` would be exactly wrong — a transaction that skipped the locked row would tell a shopper "exhausted" one commit before the count was known. What they share is what makes both correct across processes: the decision (is this key free? is this count below the limit?) and the write (claim it; increment it) are one statement, evaluated by Postgres under a row lock, and `RETURNING` reports which way it went. Neither reads a value into a process and acts on it later. Phase 2's RED — the claim reduced to a `SELECT`-then-`UPDATE` — produced nine distinct keys of twenty in architecture §7's table and `expected 10 to be 20` on the README's later run; this phase's Shape A produced nine and eleven successes for a limit of three. Same broken shape, same signature — a count that varies between runs — two different tables.

The same-order test in this file exercises the older invariant too. Four presses on one order race I4's `SELECT … FOR UPDATE` on the order row first; the first through the lock takes the use and writes the ledger row, and the other three find that row at step 3 and answer `already_applied` with the identical view. That is a lock across a read and a write — the second of §3's two closings — and it is the right tool there because the transaction has five statements to run under it, not one.

---

## 5. The three decisions the task names

Each in the same shape: what was built, the more obvious alternative, and what goes wrong without the decision.

### 5.1 The proof runs across four processes

**What.** `PROCESS_COUNT = 4`, `BASE_PORT = 5201`. `beforeAll` builds `@game-shop/db`, `@game-shop/contracts` and `@game-shop/api`, then spawns four `dist/main.js` processes on 5201–5204 with the same environment and waits on each one's `/api/health`. Orders are created round-robin; the twenty redemptions are sent round-robin, one `Promise.all`; the same-order test sends one request to each of the four instances by index. A second connection polls `pg_stat_activity` throughout and the test asserts it saw at least two distinct backend pids — a soft witness that the requests overlapped, beside the RED, which is the hard one. The measured pids on the RED runs: `[9204, 9205, 9206, 9207]`, `[9885, 9886, 9887, 9888]`, `[10098, 10099, 10100, 10101]` — four distinct on every wave.

**The obvious alternative.** One process. Start `apps/api` once on one port, fire twenty concurrent `fetch`es at it, assert three `200`s. It is faster to write, faster to run, and it passes.

**What goes wrong with the alternative.** It passes against the broken guard too. `packages/db/src/client.ts` pins the pool to `max: 1` per instance — the serverless shape, not a test setting — so inside one process a transaction holds the only connection from `BEGIN` to `COMMIT`, and the second concurrent redemption waits *in Node* for a connection before a byte reaches Postgres. Every transaction runs alone. A read-then-increment in that setting reads the newest committed value every time — `0`, then `1`, then `2`, then `3` and refused — and produces exactly three, because the pool serialised it. Architecture §7 measured this in Phase 2 with the key claim weakened to an unlocked `SELECT`-then-`UPDATE`: **20** distinct keys against one process, **9** against four. The broken code is flawless in one process. A single-instance race test measures the connection pool, not the constraint.

Four processes are four pools, so four transactions can be inside Postgres at the same instant — and that is the number that turns the argument into a measurement. Shape A's result under four processes was 9 × `200` and 11 × `200` on two runs for a limit of three; under one process it would have been 3, and the test would have been green with the mechanism gone. Raising the pool size in tests is not the fix either: `max: 1` is what production runs, and a test that changes the configuration under test proves some other system correct.

### 5.2 The assertions are the shape of the refusals plus the ledger — the counter only in addition

**What.** The first assertion in each of the twenty-order tests is on every response: `[200, 409]` must contain its status, then `responses.filter(status >= 500)` must be empty — the inline comment calls it *the load-bearing assertion (R2)*. Then exactly `LIMIT3_MAX_USES` `200`s and exactly `20 − 3` `409`s; each `200` body carries `promo: { code: "LIMIT3", discount_minor: 32250, list_amount_minor: 129000 }` and `amount_minor: 96750` on the order it was asked for; each `409` body is `{ reason: "exhausted" }`. Only then the database: `used_count = 3`; the set of ledger `order_id`s equals the set of winners' `order_id`s — equal, not merely equal in size; the three winners carry `96750` and the seventeen losers still carry `129000`. The reviewer's copy prints the same set as named lines: `exactly 3 × 200 — the cap's worth, no more`, `exactly 17 × 409 exhausted — every other shopper told no, in words`, `zero 5xx — a guard weakened to an unconditional increment trips the CHECK as 500s while the counter still reads the cap (R2)`, `no other status at all`, then `used_count = 3 for LIMIT3 — the counter half of I7`, `exactly 3 promo_redemptions row(s) among this run's 20 orders, all for LIMIT3 — the ledger half of I8`, `the ledger's order_id set equals the 200s'`, `the 3 winners carry amount_minor 96750 and the other 17 still carry 129000`.

**The obvious alternative.** Assert the invariant as stated. "A promo is used at most N times" is a sentence about the counter: read `used_count` after the race, expect `3`. Perhaps count the ledger rows too. That is what the invariant says, and it is what a first draft asserts.

**What goes wrong with the alternative.** Shape B. Keep `used_count + 1` in SQL and drop the `WHERE used_count < max_uses` — the guard is gone, the increment is unconditional. Three transactions increment `0 → 1 → 2 → 3`. The fourth obtains the row lock, computes `3 + 1`, and Postgres refuses the row before it is written: `promo_codes_used_count_range`, SQLSTATE `23514`, `Failing row contains (3, LIMIT3, percent, 25, null, 3, 4)` — the row it tried to write, column by column: `id 3`, `LIMIT3`, `percent`, `25`, no currency, `max_uses 3`, `used_count 4`. The transaction aborts; the error reaches Nest's default handler; the shopper gets `500 { "statusCode": 500, "message": "Internal server error" }`. The counter reads `3`. The ledger holds three rows for the three winners — the fourth never reached step 6. The three winners carry `96750`, the seventeen losers `129000`. The ledger's `order_id` set equals the winners'. Every database-side assertion is green, and the test header says so in the recorded run: **3 × 200, 17 × 500, 0 × 409**, `used_count = 3`, three rows, the baseline intact afterwards because counter and ledger agreed. A counter-only test — or a counter-and-ledger test — passes with the mechanism gone, in front of seventeen shoppers watching a request explode. The backstop was doing the guard's job by accident.

So the shape comes first: exactly N × `200`, the rest × `409 exhausted`, **zero 5xx**, and no other status. Under Shape B the first red line was `every response must be 200 or 409, never anything else: got 500 … expected [ 200, 409 ] to include 500`, and the reviewer's copy printed `FAIL  zero 5xx … — 17 × 5xx`. The counter is asserted after, as corroboration — and the CHECK keeps its place, because its lower bound is what turned §7.2 into an error rather than a negative number. It is Phase 2's lesson, where a UNIQUE index once masked a broken lock, wearing a CHECK constraint.

### 5.3 The reviewer's copy hands back what it spent — by decrement locally, by reset on a deployed shop

**What.** `scripts/race/promo.ts` opens a database through `openRaceDatabase("promo")` if `DATABASE_URL` is set. With one: before each scenario it records `LIMIT3 starts at used_count = 0 — nothing left spent by an earlier run`; after each, the database half above; in `finally`, `cleanupTestOrders` — the same helper the Vitest suites use, whose CTE deletes this run's redemption rows and decrements each code by exactly that count in one statement:

```sql
with gone as (
  delete from promo_redemptions where order_id = any($1::text[]) returning promo_id
), per_promo as (
  select promo_id, count(*)::int as n from gone group by promo_id
)
update promo_codes p set used_count = p.used_count - per_promo.n
from per_promo where p.id = per_promo.promo_id
```

Without a database — a deployed target, a base URL and nothing else — the database assertions print as `SKIP … needs DATABASE_URL`, and in `finally` the check reads `ADMIN_TOKEN` and calls `POST /api/admin/promo-codes/reset` on the first target, records `the admin reset answered 200 with every used_count at 0`, and prints `INFO  counters reset through the admin endpoint; the ledger keeps the rows — a database was not reachable to clean up`. With no token either, it prints a `SKIP` that says the counters stay spent and the next run will report `409 exhausted` for every attempt, with the two ways to fix it. The code comment on the branch says it is unreachable under `pnpm race`, which always has a database — and the verify task greps a local run's output for the `INFO` sentence to confirm it never appears.

The endpoint itself is `UPDATE promo_codes SET used_count = 0` — every row, no `WHERE`, no transaction, `200` with the four codes and their zeroed counters, logged at `warn` because it is the one write in the shop that makes the counter and the ledger disagree.

**The obvious alternative.** Three. Have the reset delete the ledger too, so counter and ledger agree at zero. Or have the local cleanup zero the counters instead of decrementing — the same statement, simpler. Or have no reset at all, and tell the reviewer a deployed shop is a one-run shop.

**What goes wrong with the alternative.** Deleting the ledger erases what paid orders paid. `orders.amount_minor` stays discounted after delivery; the code, the list price and the discount a delivered order shows as «было …» exist only in `promo_redemptions`. Delete it and an order that paid 967,50 ₽ for a 1 290 ₽ item reads `promo: null` — a discount with no code beside it, on the shopper's page and in the shop's own books. The counter is state; the ledger is history. Reset the one, never the other, and accept that after a reset the counter means "uses since the last reset" while the ledger keeps the truth. That is the trade `architecture.md` §9 now records, and the endpoint's header makes it in the same words.

Zeroing locally is Slice 1's argument: a cleanup that makes the baseline true is a test that cannot fail. The decrement subtracts exactly what the run deleted, so any drift the shop introduced survives to the after-run baseline and fails it. §7.2 is that rule doing something nobody planned. A local run that called the reset instead would pass its own counter assertion and fail the next suite's baseline on the ledger — `sum(used_count) = 0` with `promo_redemptions > 0` — which is the harness noticing exactly what the reset does.

No reset at all leaves a reviewer with a URL and no `psql` stuck at one run: the first spends `LIMIT3`'s three and `ONCEONLY`'s one, the second is twenty `409`s and proves nothing. Phase 6 points these scripts at the deployed shop as the strongest form of the claim; a check that can run there once is half a check. The reset is a knob in the `supplier_behaviour` family — `PUT /internal/suppliers/:provider/behaviour` arms a scenario, this arms a re-run — behind the admin token because it changes what the shop does next, and the shop itself never calls it.

---

## 6. What the tests prove, and how each was shown able to fail

Three tests, three REDs, all recorded verbatim in the file's header from runs across four `dist/main.js` processes on 5201–5204 on 2026-09-14. The procedure per shape: copy the source file aside, edit, rebuild `apps/api`, run this suite in the foreground, run `pnpm race promo` once on its own ports (4601–4604), clean any debris, restore, `cmp`, rebuild. Between shapes and at the end, `src/` was proven byte-identical, the suite was green again (`3 passed`, 9.40 s) and `pnpm race promo` passed (3 × 200 / 17 × 409; 1 × 200 / 9 × 409) with the baseline at orders 0 / `sum(used_count)` 0 / `promo_redemptions` 0 / 50 keys.

**Green.** `LIMIT3` ×20: 3 × `200` with the promo view and `96750`, 17 × `409 { reason: "exhausted" }`, `used_count = 3`, three ledger rows naming the three winners, seventeen orders still at `129000`, four pids. `ONCEONLY` ×10: 1 and 9, `64500` on the winner. One order ×4: four `200`s with byte-identical bodies, `used_count` moved by one, one ledger row, `96750`.

### Shape A — read-then-increment with a computed value

The edit: select `used_count` at step 4; after `computeDiscount`, `if (promo.usedCount >= promo.maxUses) return { outcome: Exhausted, … }` in TypeScript; replace step 5 with `.set({ usedCount: promo.usedCount + 1 }).where(eq(promoCodes.id, promo.id))` — no `lt(...)`, no re-evaluation. §3's race, written into the service. Predicted (R1, §4): more than three `200`s and more than three ledger rows, the counter under-reporting; the technical spec's table says "all twenty write `1`, twenty rows, twenty `200`s".

Run 1:

```
LIMIT3 x20:   raced in 204ms; statuses=[200, 200, 200, 200, 409, 200,
              200, 200, 409, 200, 200, 409, 409, 409, 409, 409, 409,
              409, 409, 409]  →  9 × 200, 11 × 409; used_count = 3,
              NINE promo_redemptions rows (pids [9204, 9205, 9206, 9207])
ONCEONLY x10: raced in 112ms; statuses=[200, 200, 200, 200, 409, 409,
              409, 409, 409, 409]  →  4 × 200, 6 × 409; used_count = 1,
              FOUR rows
```

Run 2, with the cleanup's throw caught temporarily so the assertions could surface (§7.2):

```
LIMIT3 x20:   raced in 1114ms; … →  11 × 200, 9 × 409
  AssertionError: exactly three 200s — the limit, not a race artefact: expected [ … ] to have a length of 3 but got 11
ONCEONLY x10: raced in 503ms; … →  4 × 200, 6 × 409
  AssertionError: exactly one 200: expected [ … ] to have a length of 1 but got 4
afterAll: orders = 30, sum(used_count) = 4, promo_redemptions = 15.
```

Nine and eleven, not twenty: the prediction held in kind and not in degree, and §7.1 has the arithmetic. The `zero 5xx` assertion stayed green under this shape — nothing reached the CHECK's upper bound, because every write was `$read + 1` with `$read ≤ 2`. The reviewer's copy under Shape A: `INFO  response shape — 200: 9, 409 exhausted: 11`; `FAIL  exactly 3 × 200 … — 9 × 200`; `FAIL  exactly 17 × 409 exhausted … — 11 × 409 exhausted`; `PASS  used_count = 3 for LIMIT3`; `FAIL  exactly 3 promo_redemptions row(s) … — 9 row(s)`; the `ONCEONLY` trio the same way (`3 × 200`, `7 × 409 exhausted`, `3 row(s)`, `PASS used_count = 1`) — and then it crashed in its own `finally`, which is §7.2.

### Shape B — unconditional increment, the `WHERE` dropped

The edit: keep `usedCount: sql\`${promoCodes.usedCount} + 1\``, drop `lt(...)` — `.where(eq(promoCodes.id, promo.id))` only. Predicted (R2, §4): 3 × `200`, 17 × `500`, `used_count = 3`, three rows, the counter-only assertions green, only `zero 5xx` and `17 × 409` red.

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

Exactly as predicted, in both harnesses. The one-order test stayed green — one increment never reaches the cap — and `afterAll`'s baseline held: counter and ledger agreed at 3, so the cleanup worked and the shape left no debris. That is R2's whole point, stated by the run: every database-side fact a counter-only test could read was correct, and only the shoppers' responses were wrong. The Postgres error behind each `500`, 26 times in the instances' stderr — 17 + 9, one per `500`:

```
ERROR [ExceptionsHandler] DrizzleQueryError: Failed query: update "promo_codes" set "used_count" = "promo_codes"."used_count" + 1 where "promo_codes"."id" = $1 returning "used_count"
  cause: error: new row for relation "promo_codes" violates check constraint "promo_codes_used_count_range"
  severity: 'ERROR', code: '23514',
  detail: 'Failing row contains (3, LIMIT3, percent, 25, null, 3, 4).',
  constraint: 'promo_codes_used_count_range', routine: 'ExecConstraints'
```

The reviewer's copy: `race:promo FAILED (4)` — `INFO  response shape — 200: 3, 500: 17`; `PASS  exactly 3 × 200`; `FAIL  exactly 17 × 409 exhausted … — 0 × 409 exhausted`; `FAIL  zero 5xx … — 17 × 5xx: 500 {"statusCode":500,"message":"Internal server error"}; …`; `PASS  used_count = 3 for LIMIT3`; `PASS  exactly 3 promo_redemptions row(s)`; `PASS  the ledger's order_id set equals the 200s'`; the `ONCEONLY` pair (`0 × 409 exhausted`, `9 × 5xx`); `FAIL  promo  exited 1 (1487ms)`. Four failures, every one of them a response-shape line; every database line green.

One number in that block is not explained anywhere: the `LIMIT3` race took 8 553 ms under Shape B against 204 ms under Shape A and a few hundred green. Seventeen aborted transactions with Nest logging a stack trace for each is the obvious suspect; it was not investigated, and this document does not guess.

### The lock RED — `lockOrder` without `FOR UPDATE`

The edit, in `order-lock.service.ts`: drop `.for("update")` so step 1 is an ordinary `SELECT`. Predicted (§4): for the same-order case, more than one transaction passes step 3 believing no redemption exists, the second's `INSERT … ON CONFLICT (order_id) DO NOTHING RETURNING order_id` returns zero rows, and the invariant throw at step 6 answers `500` — "and/or `used_count` above `1`".

```
one order, LIMIT3 x4: raced in 230ms; statuses=[500, 500, 500, 200];
              pids [10098, 10099, 10100, 10101]
  AssertionError: every one of the four must be answered honestly, none a 5xx: {"statusCode":500,"message":"Internal server error"}: expected 500 to be 200
Tests  1 failed | 2 passed (3)   Duration  8.60s
```

What happened, step by step. All four read the order without a lock, all four see `created`, all four find no ledger row at step 3, all four reach step 5 and queue on the `promo_codes` row. The first increments `0 → 1`, inserts the ledger row, reprices, commits. The second obtains the promo row lock, re-evaluates `1 < 3`, increments to `2` — then its `INSERT … ON CONFLICT (order_id) DO NOTHING` finds the first's committed row and returns zero rows, which the service treats as what it is: a row appeared under a lock this transaction believed it held. `PromoRedemptionInvariantError` at `ledger_insert`, `ROLLBACK`, the increment undone, `500`. The third and fourth the same. From the instances' stderr, reproduced by hand (5201 → `200`, 5202/5203/5204 → `500`):

```
ERROR [PromoController] { msg: 'promo: invariant violated under the order lock; the transaction was rolled back', step: 'ledger_insert', outcome: 'invariant_violated', status_code: 500, detail: 'promo: invariant violated under the order lock at ledger_insert — a promo_redemptions row for order ord_01M2GKW2J13HEP55RBDF3B15E1 appeared while this transaction held its lock and had read none; the order lock discipline was broken somewhere' }
ERROR [ExceptionsHandler] PromoRedemptionInvariantError: …    (×3, one per loser)
```

`used_count` read `1` afterwards, one ledger row, `amount_minor = 96750`. The "and/or `used_count` above `1`" half of the prediction did not happen — §7.3 says why. The twenty-order tests were unchanged and green: they race distinct orders, so the order lock is not what serialises them; I7's own row lock on `promo_codes` is. And `pnpm race promo` under this RED printed `race:promo passed.` (200: 3 / 409 exhausted: 17; 200: 1 / 409 exhausted: 9) — it has no same-order scenario and cannot see a missing order lock. §7.4 is about that.

---

## 7. Findings

### 7.1 Nine, not twenty — the wave arithmetic

The technical spec predicted that Shape A would let all twenty through. It let nine through on one run and eleven on the next, and the reason is the same `max: 1` pool that makes one process useless as a harness. Four processes, four connections, at most four transactions inside Postgres at once — call that a wave. Every member of a wave reads the same committed counter and writes the same `read + 1`. Wave one reads `0`, four winners, counter `1`. Wave two reads `1`, four winners, counter `2`. Wave three reads `2`, four winners, counter `3`. Wave four reads `3` and refuses. The counter advances by one per wave; the ledger grows by one per winner; the most the shape can admit is twelve, and the measured nine and eleven are waves that were not perfectly aligned — some transactions in a wave already saw the previous commit. `ONCEONLY` is the cleaner case: only the first wave can win, so the winner count is the wave size, and it was `4 × 200` on both runs — the number of processes, exactly.

Against one process there is one transaction per wave, each reads the newest value, and the count is exactly three. The race is invisible; the harness serialised what the code did not. That is R1 stated as arithmetic, and it is why the four-process number is the proof and the one-process number is nothing.

### 7.2 The cleanup tripped the CHECK from below, and its throw replaced the assertion

Unpredicted. Under Shape A the `LIMIT3` scenario left nine ledger rows and a counter of `3`. The `finally` cleanup ran the CTE of §5.3: delete the nine rows, group, `used_count = 3 − 9`. The row it tried to write was `(3, LIMIT3, percent, 25, null, 3, -6)`, and `promo_codes_used_count_range`'s lower bound — `used_count >= 0` — refused it. The CTE is one statement, so the delete rolled back with the decrement; the orders delete after it never ran. Vitest reported, for both twenty-order tests:

```
error: new row for relation "promo_codes" violates check constraint "promo_codes_used_count_range"
 ❯ cleanupTestOrders test/concurrency/support/db.ts:296:3
```

the third test failed its precondition — `LIMIT3 unused before this test: expected 3 to be +0` — and `afterAll` reported `orders = 30, expected 0`, `promo_codes sum(used_count) = 4, expected 0`, `promo_redemptions = 13, expected 0`: the twenty and ten orders, `3 + 1` on the counters, `9 + 4` on the ledger. The reviewer's copy crashed the same way, `Failing row contains (3, LIMIT3, percent, 25, null, 3, -6)` at `db.ts:296:3`, `FAIL  promo  exited 1 (1838ms)`, `race: 0/1 passed against 4 instance(s)`.

Two things to take from it. First, the decrement-not-recompute rule is a second drift detector, and it fired from the side nobody was watching. Slice 1's argument was that a recompute would *hide* a counter that outran its ledger; here the ledger outran the counter, and the decrement made it impossible to miss — a recompute would have written `0` and reported a clean baseline on a run that had just admitted nine. The CHECK's lower bound, which Slice 1 added for an over-decrementing cleanup, is exactly what turned the drift into an error rather than a `−6`. Debris was cleaned by hand with the harness's statements plus `UPDATE promo_codes SET used_count = 0` — the admin reset's shape, the one time it is honest, because counter and ledger had been *made* to disagree.

Second, a design note. In JavaScript, a `throw` from a `finally` block replaces whatever was already propagating out of the `try`. The scenario's own assertion — `expected … to have a length of 3 but got 9` — had fired; the cleanup's CHECK violation overwrote it, and Vitest showed only the cleanup's. A reader who meets this shape should know what to do: the `console.log` line printed *before* the assertions — `statuses=[…]` — carries the response shape and survives; `afterAll`'s baseline report is separate and survives; and if the assertion text itself is needed, do what run 2 did — catch the cleanup's throw temporarily, in the test file only, and restore. The test body was left as is. A cleanup that swallowed its own error would hide the drift it exists to expose, and the one line above it is the diagnostic; the trade is recorded here rather than fixed.

### 7.3 The counter did not overshoot with the order lock gone — the second stop

The lock RED's prediction had two halves: `500`s from the invariant throw, "and/or `used_count` above `1`". Only the first happened. Each loser did increment the counter — the second saw `1 < 3` and wrote `2` — but its `INSERT` at step 6 returned zero rows, the service threw, and `ROLLBACK` undid the step-5 increment along with everything else. The counter was held at `1` by the rollback, not by the lock. What the prediction underrated is that I8's `ON CONFLICT (order_id)` plus the refusal to treat zero rows there as an outcome is a *second* stop that stays standing when the first — the order lock — is removed: the technical spec calls it "the one rollback path, and it means the lock discipline was broken", and that is exactly what it did. Three shoppers saw `500`, which is the honest answer to a broken invariant — a bug, not a busy shop — and the ledger, the counter and the price were all correct afterwards.

### 7.4 The reviewer's copy cannot see a missing order lock

`pnpm race promo` stayed `passed` under the lock RED. It races distinct orders — twenty and ten — and never sends two requests for one order, so the order lock is never contended and its absence is invisible. The Vitest file's third test is the only guard for the same-order case, and it is the only thing that went red.

This is acceptable, for the reason `scripts/race/README.md` already gave once in Phase 2: `race:webhooks` stayed passing with the key claim reduced to a `SELECT`-then-`UPDATE`, because it fires fifty webhooks at one order and the claim is called once; `key-claim-race.test.ts` is what defends the claim, and a check should be credited with what it defends. `pnpm race promo` is named for adversarial scenario 5 — a limit under parallel requests from many shoppers — and that is what it proves. The double-click criterion (functional spec §2.4, "the shopper presses «Применить» twice quickly … the code is applied once") is a different race, on I4 rather than I7, and it is guarded by a test that `pnpm test:concurrency` and `pnpm test` run — both reviewer commands. What would change it: Phase 6 points `pnpm race` at the deployed shop as the proof that the guarantees are not process-local. If the double-click criterion is to be part of *that* proof, `promo.ts` needs a third scenario — one order, one `POST` per instance, four `200`s with identical bodies, one ledger row, counter `+1` — and the README's RED row should then record the lock RED against it. It is cheap to add and it is not added here, because the slice's task did not ask for it and this document does not pretend it did.

---

## 8. What a reviewer might challenge

- **`SERIALIZABLE` instead.** Run the read-then-increment under `SERIALIZABLE` and let Postgres abort the transactions whose reads were invalidated; retry on `40001`. It works, and the architecture rejected it in Phase 1 for a reason that is sharper here than anywhere: the guarantee moves out of the statement and into a retry loop the reader cannot see. Under load, seventeen of twenty transactions abort and retry — some of them several times — for a result the conditional `UPDATE` reaches with zero aborts, and the phase exists to demonstrate a mechanism, not to hide one. `READ COMMITTED` plus a statement that is correct on its own is the visible choice.
- **An advisory lock.** `pg_advisory_xact_lock(promo_id)` before the read, then read-then-increment safely under it. It works, and it is the second of §3's two closings — a lock across the read and the write. It costs one more round trip, it puts the lock in a place the schema does not show, and it makes the read-then-increment *look* safe to the next person, who will drop the lock call. The conditional `UPDATE` cannot be made unsafe by deleting a line around it; only by editing the statement.
- **`SELECT … FOR UPDATE` on the promo row, then an update.** Lock the row, read the count, compare, write. Correct — it is what the order lock does for the order row — and it is two statements and one more round trip on a `max: 1` pool with the hot row held for the duration. The single statement does the same work in one trip with the lock held for microseconds, and its correctness is legible in the SQL rather than in the discipline of always taking the lock first. Where a transaction has several statements to run under a lock, as the order path does, `FOR UPDATE` is right; where it has one, the conditional update is.
- **A counter table at all — why not `COUNT(*)` the ledger under a lock?** Slice 1's answer: a count is the result of a scan, not a thing with a lock. To make it safe something must be locked — a `promo_codes` row, which is the counter brought back under another name; or the table, which serialises every code behind every other; or `SERIALIZABLE`, above. The counter is the cheapest row to queue on.
- **Redis, or any in-memory counter.** `INCR` is atomic, and it is atomic in a different process from the one that holds the ledger, the order and the price. The redemption's write and the counter's increment stop being one transaction; a crash between them is drift by construction, and the harness's whole design is that drift must be impossible in production and visible in tests. The database already has a row that can be incremented atomically under the same commit as the ledger row.
- **The admin reset is a hole.** It is behind the admin token, it zeroes a counter and nothing else, the shop never calls it, local runs never call it, and its existence is the price of a race check that can run twice against a URL — the same price every one of the eight other checks already pays with `ALLOW_CLIENT_SUPPLIED_ORDER_ID` and the supplier behaviour knob. After it the counter and the ledger disagree, on purpose, and §9 of the architecture says so before a reviewer finds it.
- **Only one process count was measured.** Four. The 20-vs-9 table in architecture §7 is the only comparison against one; this slice did not run Shape A against one process to record the `3`. The claim that it would be `3` is arithmetic from the `max: 1` pool, not a fresh measurement, and this document says so.
- **`pnpm race promo` does not guard the order lock.** §7.4. Named, with what would change it.

---

## 9. Interview questions this answers

**"Why is a read-then-increment a race? It's three lines and it checks the limit."**
Because the check and the write are two round trips with a decision in between, and the number the decision uses is stale by the time the write is sent. Two shoppers with the counter at `2`: both read `2`, both pass `2 < 3` in TypeScript, both write `3`. Two uses recorded, counter moved once. With N processes reading at the same moment, all N pass and all N write the same value — the counter advances once per moment, the ledger once per transaction. No code between the read and the write closes it: a second check reads the same stale number, a Node lock is one process's lock, and the API runs as separate processes. We measured it: the broken shape let nine and eleven through for a limit of three.

**"So what replaces it?"**
One statement: `UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1 AND used_count < max_uses RETURNING used_count`. The check is in the `WHERE`, the write is relative to the row, nothing is read into a variable. Twenty of these queue on the row's lock; when each obtains it, Postgres — under `READ COMMITTED` — re-evaluates the `WHERE` against the row as the previous transaction committed it, not as it was first seen. The fourth sees `3 < 3`, matches zero rows, returns nothing, and that is the `409`. There is no window because there is nothing between the check and the write.

**"Why did you need four API processes to prove it? Twenty concurrent requests to one server is concurrency."**
Not with a pool of one. Each API process has `max: 1`, so a transaction holds the only connection from `BEGIN` to `COMMIT` and the next request waits in Node before Postgres sees it. Every transaction runs alone; a read-then-increment reads the newest value every time and gets exactly three. Phase 2 measured it: a weakened key claim produced 20 distinct keys against one process and 9 against four. This phase's Shape A produced nine and eleven successes against four; against one it would be three, and the test would be green with the guard gone. Four processes are four connections, so four transactions can overlap inside Postgres — that is the smallest harness that can see the race.

**"Your CHECK constraint already says `used_count <= max_uses`. Isn't that the limit?"**
It is the backstop, and it hid a broken guard from a counter-only test. Drop the `WHERE` from the update: three increments succeed, the fourth computes `4`, the CHECK refuses the row — `23514`, `Failing row contains (3, LIMIT3, percent, 25, null, 3, 4)` — the transaction aborts and the shopper gets `500`. Counter `3`, three ledger rows, three orders repriced: every database fact correct, seventeen shoppers watching a request explode. So the assertion is the shape of the responses — exactly three `200`, seventeen `409 exhausted`, zero `5xx` — and only then the counter. Under that RED the first red line was `expected [ 200, 409 ] to include 500`.

**"Nine and not twenty — why?"**
Waves. Four processes, four connections, four transactions in Postgres at once. Each wave reads one committed value and every member writes `read + 1`, so the counter moves once per wave and the ledger once per winner: twelve at most across three waves, nine and eleven measured. `ONCEONLY` shows it cleanly — only the first wave can win, and it was four both times, the number of processes. The spec predicted twenty; it was right in kind and wrong in degree, for the same reason one process shows zero.

**"What did the cleanup have to do with any of this?"**
The harness hands back exactly what a run spent — delete this run's ledger rows, subtract that many from the counter — and never recomputes, so drift survives to the baseline. Under Shape A that rule subtracted nine from a counter of three and the CHECK's lower bound refused `−6`. Nobody predicted it; it is the decrement rule catching the race from the other side. It also taught us that a throw in `finally` replaces the assertion error, so the diagnostic for that shape is the `statuses=[…]` line printed before the assertions.

**"What happens if the order lock is missing?"**
For twenty distinct orders, nothing — I7's row lock serialises them, not the order lock. For four presses on one order: all four pass the "no redemption yet" read, all four queue on the promo row, the first wins, and each of the other three increments, then hits `ON CONFLICT (order_id) DO NOTHING` returning zero rows, which the transaction treats as a broken invariant: throw, rollback, `500`. Counter `1`, one row — held by the rollback, not the lock. Three shoppers saw a `500`, which is the honest answer to a bug. `pnpm race promo` cannot see this because it never sends two requests for one order; the Vitest third test is the guard, in the commands a reviewer runs.

**"How does a reviewer run it, and can they run it twice?"**
`pnpm race promo`. Twenty `LIMIT3` and ten `ONCEONLY` across four instances; it prints `exactly 3 × 200`, `exactly 17 × 409 exhausted`, `zero 5xx`, then the counter, the ledger's `order_id` set against the `200`s', and the prices; exit code 1 on any failure. Locally it cleans up through the same CTE the suites use, so the second run starts from zero. Against a deployed URL with no database it calls `POST /api/admin/promo-codes/reset` with the admin token and prints that it did. The reset zeroes the counters and leaves the ledger — deleting the ledger would erase what paid orders paid — so after it the two disagree on purpose. Local runs never reach that branch; the verify task greps the output for its sentence.

**"Why is this the second instance of the Phase 2 argument?"**
Phase 2's key claim is `UPDATE supplier_keys … WHERE code = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING code`; this phase's is `UPDATE promo_codes … WHERE used_count < max_uses RETURNING used_count`. One picks a free row and skips locked ones so twenty claimants take twenty keys; the other tests-and-writes one row so twenty shoppers queue on it. Different shape, same principle: the decision and the write are one statement Postgres evaluates under a row lock, nothing is read into a process and acted on later, and that is why four processes that share nothing agree. Both REDs have the same signature — nine, then ten, of twenty there; nine and eleven for three here.

---

## 10. What is not finished

- **The verify task.** `pnpm test:concurrency` with the new file, `pnpm race promo` twice back to back with the counts quoted, `pnpm race` for all nine checks, `pnpm test` after with the baseline held, and the grep of a local run's output for the reset's `INFO` sentence — the task after this one, unchecked in `tasks.md` and running while this was written. The evidence in §6 is the RED session's: three restores, each followed by a green suite and a passing `pnpm race promo` from a baseline the previous run had left at zero, which is the repeatability claim made three times rather than twice.
- **`pnpm race promo` has no same-order scenario.** §7.4 — named, with what would add it.
- **The one-process `3` is arithmetic, not a measurement.** §8's last bullet but one.
- **Shape B's 8 553 ms** is recorded and not explained.
- **The walkthrough of the phase** — `docs/walkthrough/phase-5.md`, Slice 5 — is where the two sentences below meet the price argument, the transaction's ordering and the shopper's page in one document, with every RED line quoted. This document is its Slice 3 source.
- **R6 stays open by decision.** The apply-vs-pay window is now in `architecture.md` §9 as this slice's task asked; closing it is out of the phase's scope.

---

## 11. The two sentences

The roadmap's question — *why a read-then-increment is a race, and how a single conditional update replaces it* — answered unaided, before any code is opened:

> A read-then-increment is a race because the count is read in one round trip and written in another, and any check made in between is made against a number that is already stale — two shoppers both read `2`, both pass `2 < 3`, both write `3`, and the ledger records two uses while the counter moved once; no code in the process can close that gap, because the gap is between the process and the database. `UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1 AND used_count < max_uses RETURNING used_count` replaces it because the check and the write are one statement: every transaction queues on the row's lock, and when its turn comes Postgres re-evaluates the `WHERE` against the row as the previous transaction committed it, so the fourth sees `3 < 3`, matches nothing, writes nothing, and `RETURNING` says so — the limit holds across any number of processes because the only thing deciding it is the row.

---

## Source files

- `apps/api/test/concurrency/promo-limit-race.test.ts` — the three tests; the header's five arguments (four processes, R1/R2 and the shape, refusals before writes, `READ COMMITTED` and step 5, the same-order race) and the RED section with Shape A, Shape B and the lock RED verbatim
- `apps/api/test/concurrency/support/db.ts` — `assertBaseline`, the cleanup CTE (line 296) and the "a test that cannot fail" sentence; `observeDistinctBackendPidsDuring`
- `apps/api/test/concurrency/support/api-instance.ts` — four real processes, `/api/health`, `SIGTERM`
- `scripts/race/promo.ts` — the header's five sections (the mechanism, R1, R2, decrement not recompute, R15); the `record` labels; the `finally` with the decrement and the reset fallback; the `INFO` sentence the verify task greps for
- `scripts/race/README.md` — "Why the harness starts *four* processes" and the 20-vs-9 table; the `promo` row of the RED table; "The one weakening that produced no failure"; the port row
- `apps/api/src/promo/promo-redemption.service.ts` — the header's `READ COMMITTED` argument and lock order; step 4's column list without `used_count`; step 5 with the three load-bearing details; step 6's zero-rows-is-a-broken-lock
- `apps/api/src/orders/order-lock.service.ts` — the `FOR UPDATE` the lock RED removed
- `apps/api/src/admin/promo-codes-reset.controller.ts`, `promo-codes-reset.service.ts`, `promo-codes-reset.types.ts` — the demo affordance; counter zeroed, ledger kept; why not `DELETE FROM promo_redemptions`; why local checks never call it; one statement, no `WHERE`
- `packages/db/src/schema/promo.ts` — `promo_codes_used_count_range` (both bounds) and the column order the failing rows are printed in
- `packages/db/src/client.ts` — `max: 1`
- `context/product/architecture.md` §3 (I4, I6, I7, I8), §3.1, §7, §9
- `context/product/roadmap.md` — Phase 5's concept sentence
- `context/spec/005-promo-codes-with-enforced-limits/functional-spec.md` §2.4, §2.5, §2.6
- `context/spec/005-promo-codes-with-enforced-limits/technical-considerations.md` §2.2 (the `READ COMMITTED` paragraph), §2.3 (the reset), §2.5, §4, R1, R2, R4, R5, R13–R15
- `docs/walkthrough/slice-7-proving-the-race.md` — Phase 2's `expected 9 to be 20`; `scripts/race/README.md`'s later run of the same RED, `expected 10 to be 20`

**On evidence:** what I ran fresh while writing this document, against the tree as it stands, with no server started, no database touched, and no source, test, script, config or spec file modified. `pnpm --filter @game-shop/api run typecheck` — `tsc --noEmit`, clean. `grep -c "^  it("` over the race test — 3; `grep -n "for update\|\.for(\"update\")"` over `order-lock.service.ts` — the statement the lock RED removed is present. `grep -n "lt(promoCodes.usedCount, promoCodes.maxUses)"` over the redemption service — one occurrence, step 5; `grep -n "usedCount" ` over step 4's `.select({…})` — absent. `grep -rn "counters reset through the admin endpoint"` — one occurrence, `scripts/race/promo.ts`, in the branch guarded by `db === undefined`. `ls scripts/race/*.ts` minus the runner — nine checks, `promo.ts` among them; `grep -n "race:promo" package.json` — present. Column order of `promo_codes` in `packages/db/src/schema/promo.ts` — `id, code, kind, value, currency, max_uses, used_count`, which is the order the two failing rows print in.

Everything else is quoted from the test file's header and the README's RED row rather than re-run: every status list, count, pid, duration, error text and line reference in §6 and §7 is from those two files, transcribed. The line numbers inside the quoted Vitest output (`:390`, `:401`, `:446`, `:493`, `:529`, `:540`, `:571`) are the file's at the time of the runs; the header that records them has since moved the same assertions further down. `pnpm test:concurrency`, `pnpm race promo` and `pnpm test` were not run for this document: all three bind ports and write to the shared database, and the verify task for this slice was running against it.
