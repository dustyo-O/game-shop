// @layer: integration
// @spec: 005-promo-codes-with-enforced-limits
// @regression
/**
 * The executable proof of functional spec §2.4–§2.5, *"a code capped at N is
 * applied at most N times, counted across every shopper and every order, and
 * a reviewer can run the shop's own check for the promise instead of taking
 * its word for it"* — Slice 3's own keystone task in
 * `context/spec/005-promo-codes-with-enforced-limits/tasks.md`: adversarial
 * scenario 5.
 *
 * Run it with:
 *
 *   pnpm --filter @game-shop/api exec vitest run test/concurrency/promo-limit-race.test.ts
 *
 * from the repository root via `scripts/with-env.ts` (`pnpm test:concurrency`
 * runs every file in this directory the same way; `apps/api/package.json`'s
 * `test:concurrency` script is `vitest run test/concurrency/`) — matching
 * `./order-lock-race.test.ts`'s own header for the identical reason: this
 * suite needs `DATABASE_URL`, which only the env loader supplies.
 *
 * ---------------------------------------------------------------------------
 * THIS MUST NOT BE A DOUBLE-CLICK TEST — WHY FOUR REAL PROCESSES
 * ---------------------------------------------------------------------------
 * `packages/db/src/client.ts` gives every `apps/api` process a connection pool
 * of `max: 1`. Inside one process, `PromoRedemptionService.apply`'s
 * `database.transaction()` checks that single connection out for the whole
 * transaction, so a second concurrent redemption in the same process cannot
 * even start until the first one finishes — it queues in Node, before
 * Postgres ever sees a second statement. `architecture.md` §7 measured exactly
 * this shape for the supplier's key claim: twenty concurrent callers against
 * one process produced twenty distinct keys even with the locking removed,
 * and the same claim weakened the same way produced nine distinct keys once
 * the calls were spread across four processes. A Vitest test that fires N
 * concurrent HTTP calls at **one** running `apps/api` process is a queue test
 * wearing a race test's clothes, and it would pass against a broken I7 guard.
 * `./support/api-instance.ts` spawns four separate OS processes, each with its
 * own pool of one, so N redemptions genuinely overlap inside Postgres.
 *
 * ---------------------------------------------------------------------------
 * R1/R2 — WHY THIS FILE ASSERTS THE *SHAPE* OF THE REFUSALS, NOT THE COUNTER
 * ---------------------------------------------------------------------------
 * `promo_codes` carries `CHECK (used_count <= max_uses)` at rest. A guard
 * weakened into an unconditional `used_count = used_count + 1` does not let a
 * fourth increment through as `used_count = 4` — it makes the fourth
 * transaction's `UPDATE` violate the CHECK, which aborts that transaction and
 * answers the shopper `500`, while `used_count` still reads exactly `3`. A
 * test that asserts only `used_count = 3` and "three ledger rows" would stay
 * green against that broken guard — the CHECK would be doing the guard's job
 * by accident, in front of a shopper watching a request explode. So every
 * `it()` below asserts on the **HTTP response shape** first — exactly N ×
 * `200`, the rest × `409 { reason: "exhausted" }`, and **zero 5xx** — and only
 * then on the counter and the ledger, which are corroborating evidence, never
 * the whole of the proof. See the RED VALIDATION section below: Shape B is
 * this exact failure mode, staged and recorded.
 *
 * ---------------------------------------------------------------------------
 * REFUSALS BEFORE WRITES — WHY A `200` AND A `409` CAN SHARE ONE ASSERTION SET
 * ---------------------------------------------------------------------------
 * `PromoRedemptionService.apply` (`../../src/promo/promo-redemption.service.ts`)
 * decides every refusal — the order lock, the status, the existing
 * redemption, the code lookup, the I7 increment — before either write; an
 * expected refusal (`exhausted` included) commits an **empty** transaction.
 * There is no sentinel throw anywhere in this path (the file's own header
 * argues why): a `409 exhausted` is not a rollback of a half-done increment,
 * it is zero rows ever written, which is what makes "exactly 3 × 200 and
 * exactly 17 × 409, zero 5xx" a statement about the whole system rather than
 * a statement that happens to be compatible with several different bugs.
 *
 * ---------------------------------------------------------------------------
 * WHY STEP 5 (I7) ADMITS EXACTLY `max_uses` TRANSACTIONS UNDER `READ COMMITTED`
 * ---------------------------------------------------------------------------
 * Every `UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1 AND
 * used_count < max_uses` queues on that row's lock; when each in turn obtains
 * it, Postgres re-evaluates `used_count < max_uses` against the row *as the
 * previous transaction committed it*, not as it was first read — reading and
 * writing are one statement, so there is no window between them. That is the
 * walkthrough's keystone (functional spec §2.6): a read-then-increment has the
 * window; a conditional update does not. Twenty shoppers in four processes
 * therefore see exactly three winners for `LIMIT3`, never a fourth and never
 * fewer than three, whatever order the twenty requests happen to arrive in.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ONE-ORDER, SAME-CODE-×4 CASE IS A DIFFERENT RACE FROM THE OTHER TWO
 * ---------------------------------------------------------------------------
 * `LIMIT3` ×20 and `ONCEONLY` ×10 race twenty (ten) *different* orders for a
 * scarce resource guarded by I7 (the counter). Four requests for the *same*
 * order racing each other exercise I4 first — `OrderLockService.lockOrder`'s
 * `SELECT … FOR UPDATE` — and step 3 of the transaction (the existing-
 * redemption read under that lock): the first caller through the lock takes
 * the I7 use and writes the I8 ledger row; the other three, whichever order
 * they queue in, each find that row already there and answer `already_applied`
 * with the identical committed view — never a second increment. `used_count`
 * therefore moves by exactly **one**, not four, which is functional spec
 * §2.4's own criterion: *"the shopper presses «Применить» twice quickly …
 * the code is applied once."*
 *
 * ===========================================================================
 * RED VALIDATION — recorded by the Slice 3 RED run
 * ===========================================================================
 * Run on 2026-09-14 across four `dist/main.js` processes on 5201–5204 (four
 * distinct Postgres backend pids observed on every wave). Procedure per shape:
 * `cp` the source file to a scratchpad, edit, rebuild `apps/api`, run this
 * suite in the foreground, run `pnpm race promo` once (4601–4604), clean any
 * debris, restore from the copy, `cmp`, rebuild. Every quoted line below is
 * verbatim from those runs (the `file:line:col` references in the quoted
 * stack lines are the file's line numbers at run time — the header has
 * grown since, so the assertions now sit lower; find them by their message);
 * the predictions are kept beside the results so
 * the two can be compared. Between shapes, and at the end, `src/` was proven
 * byte-identical with `cmp`, this suite was GREEN again (3 passed, 9.40 s) and
 * `pnpm race promo` passed (3 × 200 / 17 × 409; 1 × 200 / 9 × 409) with the
 * baseline at orders 0 / sum(used_count) 0 / promo_redemptions 0 / 50 keys.
 * The three shapes, and what `technical-considerations.md` §3 (R1, R2) and §4
 * predict for each:
 *
 * --- Shape A — read-then-increment with a computed value ---------------
 * In `promo-redemption.service.ts` step 4, select `used_count` too; after
 * `computeDiscount`, add `if (promo.usedCount >= promo.maxUses) return {
 * outcome: PromoRedemptionOutcome.Exhausted, … }` in TypeScript; replace the
 * I7 statement with `.set({ usedCount: promo.usedCount + 1 }).where(eq(
 * promoCodes.id, promo.id))` — no `lt(...)` predicate, no re-evaluation
 * against the committed row. Predicted (tech spec R1, §4): more than three
 * `200`s and more than three ledger rows, the counter under-reporting how many
 * transactions actually squeezed through the TOCTOU window between the
 * in-memory read and the write (anywhere from 4 to 20, depending on
 * interleaving). The `exactly 3 × 200` and the ledger-order_id-set assertions
 * go red.
 *   Result — run 1 (statuses in request order, one line per scenario):
 *     LIMIT3 x20:   raced in 204ms; statuses=[200, 200, 200, 200, 409, 200,
 *                   200, 200, 409, 200, 200, 409, 409, 409, 409, 409, 409,
 *                   409, 409, 409]  →  9 × 200, 11 × 409; used_count = 3,
 *                   NINE promo_redemptions rows (pids [9204, 9205, 9206, 9207])
 *     ONCEONLY x10: raced in 112ms; statuses=[200, 200, 200, 200, 409, 409,
 *                   409, 409, 409, 409]  →  4 × 200, 6 × 409; used_count = 1,
 *                   FOUR rows
 *   Nine, not twenty: each process's `max: 1` pool caps the overlap at four
 *   transactions, so each wave of up to four reads the same committed
 *   counter and every member writes that value + 1 — the counter advances
 *   by one per WAVE while the ledger grows by one per WINNER, and after
 *   three waves the in-memory check reads 3 and refuses the rest.
 *   On this run the scenario's own assertion was MASKED: the `finally`
 *   cleanup (`cleanupTestOrders`, support/db.ts:296) decrements each code by
 *   the rows it deleted — 9 against a counter of 3 — and tripped the same
 *   CHECK from the other side (`used_count >= 0`); a throw in `finally`
 *   replaces the assertion error, so Vitest reported, for both tests:
 *     error: new row for relation "promo_codes" violates check constraint "promo_codes_used_count_range"
 *      ❯ cleanupTestOrders test/concurrency/support/db.ts:296:3
 *      ❯ test/concurrency/promo-limit-race.test.ts:446:9        (and :529:9)
 *   the third test then failed its precondition:
 *     AssertionError: precondition: LIMIT3 unused before this test: expected 3 to be +0 // Object.is equality
 *     - Expected  0     + Received  3                           (:540:80)
 *   and `afterAll` reported, separately from the scenarios' own failures:
 *     Error: database is not at the seeded baseline after this suite's own cleanup:
 *       - orders = 30, expected 0
 *       - promo_codes sum(used_count) = 4, expected 0
 *       - promo_redemptions = 13, expected 0
 *   Run 2 (same mutation; the cleanup's throw caught temporarily, in this
 *   file only, to let the assertions surface — restored byte-identical and
 *   `cmp`'d before the header was written):
 *     LIMIT3 x20:   raced in 1114ms; statuses=[200, 200, 200, 200, 200, 200,
 *                   200, 200, 409, 200, 409, 409, 200, 409, 409, 409, 409,
 *                   409, 409, 200]  →  11 × 200, 9 × 409
 *       AssertionError: exactly three 200s — the limit, not a race artefact: expected [ { order: { …(5) }, …(1) }, …(10) ] to have a length of 3 but got 11
 *       - Expected  3     + Received  11                        (:401:80)
 *     ONCEONLY x10: raced in 503ms; statuses=[200, 200, 200, 200, 409, 409,
 *                   409, 409, 409, 409]  →  4 × 200, 6 × 409
 *       AssertionError: exactly one 200: expected [ { order: { …(5) }, …(1) }, …(3) ] to have a length of 1 but got 4
 *       - Expected  1     + Received  4                         (:493:44)
 *     afterAll: orders = 30, sum(used_count) = 4, promo_redemptions = 15.
 *   So the prediction held in kind (more than three `200`s, the ledger
 *   longer than the counter says) and not in degree (9 and 11, not 20 —
 *   the waves above). The `zero 5xx` assertion stayed green: nothing ever
 *   reached the CHECK's upper bound, because every write was `$read + 1`
 *   with `$read ≤ 2`. Debris was cleaned by hand — the harness CTE cannot
 *   (3 − 9 < 0) — with `cleanupTestOrders`' statements plus `UPDATE
 *   promo_codes SET used_count = 0`, i.e. the admin reset's shape, the one
 *   time it is honest: the counter and ledger had been made to disagree.
 *   `pnpm race promo` under Shape A:
 *     INFO  response shape — 200: 9, 409 exhausted: 11
 *     FAIL  exactly 3 × 200 — the cap's worth, no more — 9 × 200
 *     FAIL  exactly 17 × 409 exhausted — every other shopper told no, in words — 11 × 409 exhausted
 *     PASS  used_count = 3 for LIMIT3 — the counter half of I7 — used_count = 3
 *     FAIL  exactly 3 promo_redemptions row(s) among this run's 20 orders, all for LIMIT3 — the ledger half of I8 — 9 row(s)
 *     INFO  response shape — 200: 3, 409 exhausted: 7
 *     FAIL  exactly 1 × 200 — the cap's worth, no more — 3 × 200
 *     FAIL  exactly 9 × 409 exhausted — every other shopper told no, in words — 7 × 409 exhausted
 *     PASS  used_count = 1 for ONCEONLY — the counter half of I7 — used_count = 1
 *     FAIL  exactly 1 promo_redemptions row(s) among this run's 10 orders, all for ONCEONLY — the ledger half of I8 — 3 row(s)
 *   then its own `finally` cleanup crashed the process before the summary:
 *     error: new row for relation "promo_codes" violates check constraint "promo_codes_used_count_range"
 *       detail: 'Failing row contains (3, LIMIT3, percent, 25, null, 3, -6).'
 *       at async cleanupTestOrders (…/apps/api/test/concurrency/support/db.ts:296:3)
 *     FAIL  promo                    exited 1 (1838ms)
 *     race: 0/1 passed against 4 instance(s).
 *
 * --- Shape B — unconditional increment, `lt(...)` dropped from SQL ------
 * Keep `usedCount: sql`${promoCodes.usedCount} + 1`` but drop the `lt(...)`
 * predicate: `.where(eq(promoCodes.id, promo.id))` only. Predicted (tech spec
 * R2, §4): 3 × `200`, 17 × **`500`** — `promo_codes_used_count_range`
 * (`CHECK (used_count <= max_uses)`) aborts the fourth transaction's `UPDATE`
 * rather than letting `used_count` reach 4, and `used_count` still reads `3`
 * with three ledger rows. The counter-only assertions (`used_count = 3`,
 * `promo_redemptions` has 3 rows) stay GREEN — this is R2's finding, the CHECK
 * masking a broken guard from a test that only reads the counter. Only the
 * `zero 5xx` and `exactly 17 × 409 exhausted` assertions go red.
 *   Result — exactly as predicted, in both harnesses:
 *     LIMIT3 x20:   raced in 8553ms; statuses=[500, 200, 200, 500, 500, 500,
 *                   500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500,
 *                   500, 500, 200]  →  3 × 200, 17 × 500, 0 × 409
 *                   (pids [9885, 9886, 9887, 9888])
 *     ONCEONLY x10: raced in 365ms; statuses=[200, 500, 500, 500, 500, 500,
 *                   500, 500, 500, 500]  →  1 × 200, 9 × 500, 0 × 409
 *     The first red line in both tests (:390:13 and :482:13):
 *       AssertionError: every response must be 200 or 409, never anything else: got 500 {"statusCode":500,"message":"Internal server error"}: expected [ 200, 409 ] to include 500
 *     Tests  2 failed | 1 passed (3)   Duration  15.64s
 *   The one-order ×4 test stayed GREEN (one increment never reaches the
 *   cap), and `afterAll`'s baseline HELD: with counter = ledger = 3 the
 *   cleanup CTE works, so this shape leaves no debris — which is R2's whole
 *   point: every database-side fact a counter-only test could read was
 *   correct, and only the shoppers' responses were wrong.
 *   The Postgres error behind each `500`, from the instances' stderr as
 *   `pnpm race promo` streams it (this harness quotes stderr only when an
 *   instance fails its health check), 26 times — one per `500`:
 *     ERROR [ExceptionsHandler] DrizzleQueryError: Failed query: update "promo_codes" set "used_count" = "promo_codes"."used_count" + 1 where "promo_codes"."id" = $1 returning "used_count"
 *       cause: error: new row for relation "promo_codes" violates check constraint "promo_codes_used_count_range"
 *       severity: 'ERROR', code: '23514',
 *       detail: 'Failing row contains (3, LIMIT3, percent, 25, null, 3, 4).',
 *       constraint: 'promo_codes_used_count_range', routine: 'ExecConstraints'
 *   `pnpm race promo` under Shape B — `race:promo FAILED (4)`:
 *     INFO  response shape — 200: 3, 500: 17
 *     PASS  exactly 3 × 200 — the cap's worth, no more — 3 × 200
 *     FAIL  exactly 17 × 409 exhausted — every other shopper told no, in words — 0 × 409 exhausted
 *     FAIL  zero 5xx — a guard weakened to an unconditional increment trips the CHECK as 500s while the counter still reads the cap (R2) — 17 × 5xx: 500 {"statusCode":500,"message":"Internal server error"}; 500 {"statusCode":500,"message":"Internal server error"}; 500 {"statusCode":500,"message":"Internal server error"}; …
 *     PASS  used_count = 3 for LIMIT3 — the counter half of I7 — used_count = 3
 *     PASS  exactly 3 promo_redemptions row(s) among this run's 20 orders, all for LIMIT3 — the ledger half of I8 — 3 row(s)
 *     PASS  the ledger's order_id set equals the 200s' — the responses and the database name the same winners — …
 *     INFO  response shape — 200: 1, 500: 9
 *     FAIL  exactly 9 × 409 exhausted — every other shopper told no, in words — 0 × 409 exhausted
 *     FAIL  zero 5xx — … (R2) — 9 × 5xx: 500 {"statusCode":500,"message":"Internal server error"}; …
 *     PASS  used_count = 1 for ONCEONLY — the counter half of I7 — used_count = 1
 *     PASS  exactly 1 promo_redemptions row(s) among this run's 10 orders, all for ONCEONLY — the ledger half of I8 — 1 row(s)
 *     FAIL  promo                    exited 1 (1487ms)
 *     race: 0/1 passed against 4 instance(s).
 *
 * --- Lock RED — `OrderLockService.lockOrder` as a plain `SELECT` --------
 * In `../../src/orders/order-lock.service.ts`, drop `.for("update")` from
 * `lockOrder`'s statement so it is an ordinary, non-locking `SELECT`. Run the
 * one-order, same-code-×4 test only. Predicted (tech spec §4): more than one
 * of the four transactions passes step 3 (the existing-redemption read)
 * believing no redemption exists yet, so more than one reaches the I7
 * increment and the I8 insert; the second (and any further) `INSERT INTO
 * promo_redemptions … ON CONFLICT (order_id) DO NOTHING RETURNING order_id`
 * returns zero rows for a caller that did NOT read an existing row at step 3,
 * which this codebase's `PromoRedemptionInvariantError` throw (step 6) treats
 * as a broken lock discipline — 500. Possible outcomes: a `500` from that
 * throw, and/or `used_count` above `1` (more than one increment went through
 * before the conflict was detected).
 *   Result — the whole file was run; only the same-order test broke:
 *     one order, LIMIT3 x4: raced in 230ms; statuses=[500, 500, 500, 200];
 *                   pids [10098, 10099, 10100, 10101]
 *       AssertionError: every one of the four must be answered honestly, none a 5xx: {"statusCode":500,"message":"Internal server error"}: expected 500 to be 200 // Object.is equality
 *       - Expected  200   + Received  500                       (:571:13)
 *     Tests  1 failed | 2 passed (3)   Duration  8.60s
 *   LIMIT3 ×20 and ONCEONLY ×10 were UNCHANGED (green): they race distinct
 *   orders, so the order lock is not what serialises them — I7's own row
 *   lock on `promo_codes` is. `afterAll`'s baseline held.
 *   Which of the two predicted outcomes it was, reproduced by hand against
 *   four `dist/main.js` instances on 5201–5204 (one order, four concurrent
 *   POSTs: 5201 → 200, 5202/5203/5204 → 500), from the instances' stderr:
 *     ERROR [PromoController] { msg: 'promo: invariant violated under the order lock; the transaction was rolled back', step: 'ledger_insert', outcome: 'invariant_violated', status_code: 500, detail: 'promo: invariant violated under the order lock at ledger_insert — a promo_redemptions row for order ord_01M2GKW2J13HEP55RBDF3B15E1 appeared while this transaction held its lock and had read none; the order lock discipline was broken somewhere' }
 *     ERROR [ExceptionsHandler] PromoRedemptionInvariantError: promo: invariant violated under the order lock at ledger_insert — …    (×3, one per loser)
 *   `used_count` read 1 afterwards, NOT more: each loser's step-5 increment
 *   was rolled back by the step-6 throw, so the counter was held by the
 *   invariant's ROLLBACK, not by the lock — the "and/or `used_count` above
 *   `1`" half of the prediction did not happen, because I8's `ON CONFLICT
 *   (order_id)` is the second stop that remains when the first is removed.
 *   One ledger row; `amount_minor = 96750`.
 *   `pnpm race promo` under the lock RED: `race:promo passed.` (200: 3 /
 *   409 exhausted: 17; 200: 1 / 409 exhausted: 9). The reviewer's check
 *   races distinct orders only and cannot see a missing order lock; this
 *   file's third test is the only guard for it.
 *
 * `scripts/race/README.md`'s `promo` row carries the same `pnpm race promo`
 * output for Shape A and Shape B, in that table's own register.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { DatabaseClient } from "@game-shop/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CreatedOrder, OrderView } from "../../src/orders/orders.types.js";
import {
  type RunningInstance,
  startApiInstance,
  stopAllApiInstances,
} from "./support/api-instance.js";
import {
  PURCHASABLE_SKU,
  assertBaseline,
  cleanupTestOrders,
  createTestDatabaseClient,
  observeDistinctBackendPidsDuring,
  readBaselineCounts,
} from "./support/db.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
/** `apps/api` — two levels up from `test/concurrency`. */
const API_ROOT = resolve(TEST_DIR, "..", "..");
/** The repository root — where `pnpm run build:packages` resolves from. */
const REPO_ROOT = resolve(API_ROOT, "..", "..");

/**
 * Four real processes — the number this slice's own task names ("proven
 * across four processes"), matching every sibling concurrency suite. Ports
 * 5201–5204, clear of every other suite's range (see `scripts/race/README.md`'s
 * port note, which already lists this exact range for this exact file).
 */
const PROCESS_COUNT = 4;
const BASE_PORT = 5201;

/** 1 290 ₽ — `KEY-CS2-PRIME`, `packages/db/src/fixtures/catalog.ts`. Every order this suite creates prices here. */
const LIST_AMOUNT_MINOR = 129_000;

/** `LIMIT3` — 25 % off, max 3 uses. `packages/db/src/fixtures/promo-codes.ts`. */
const LIMIT3_MAX_USES = 3;
/** `Math.round((129000 × 25) / 100)` — `promo-discount.ts`; pinned again in `promo-discount.test.ts`. */
const LIMIT3_DISCOUNT_MINOR = 32_250;
const LIMIT3_AMOUNT_TO_PAY_MINOR = LIST_AMOUNT_MINOR - LIMIT3_DISCOUNT_MINOR;

/** `ONCEONLY` — 50 % off, max 1 use. */
const ONCEONLY_MAX_USES = 1;
const ONCEONLY_DISCOUNT_MINOR = 64_500;
const ONCEONLY_AMOUNT_TO_PAY_MINOR = LIST_AMOUNT_MINOR - ONCEONLY_DISCOUNT_MINOR;

/** The wire shape of a successful application's `promo` field — `AppliedPromoView`, `../../src/orders/orders.types.ts`. */
function expectedPromoView(code: string, discountMinor: number): { code: string; discount_minor: number; list_amount_minor: number } {
  return { code, discount_minor: discountMinor, list_amount_minor: LIST_AMOUNT_MINOR };
}

interface PromoApplyResponse {
  readonly status: number;
  readonly body: Record<string, unknown> | undefined;
}

interface PromoCodeState {
  readonly id: number;
  readonly usedCount: number;
  readonly maxUses: number;
}

describe("functional spec §2.4–§2.5 — a limit that holds under parallelism, proven across four processes", () => {
  let instances: RunningInstance[] = [];
  let assertionClient: DatabaseClient;
  let pollerClient: DatabaseClient;
  let cursor = 0;

  /** Round-robins order creation and redemption calls across all four instances — the sibling suites' identical reasoning. */
  function nextInstance(): RunningInstance {
    const instance = instances[cursor % instances.length];
    cursor += 1;
    if (instance === undefined) throw new Error("nextInstance: no instances available");
    return instance;
  }

  function instanceAt(index: number): RunningInstance {
    const instance = instances[index];
    if (instance === undefined) throw new Error(`instanceAt(${String(index)}): no such instance`);
    return instance;
  }

  async function createOrder(): Promise<CreatedOrder> {
    const response = await fetch(`${nextInstance().baseUrl}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: PURCHASABLE_SKU }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`POST /api/orders -> ${String(response.status)}: ${text}`);
    return JSON.parse(text) as CreatedOrder;
  }

  /** `POST {instance}/api/orders/:orderId/promo { code }` — never round-robined for the redemption itself; the caller chooses the instance so the race is genuinely spread. */
  async function applyPromoOn(instance: RunningInstance, orderId: string, code: string): Promise<PromoApplyResponse> {
    const response = await fetch(`${instance.baseUrl}/api/orders/${orderId}/promo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const text = await response.text();
    let body: Record<string, unknown> | undefined;
    try {
      body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  }

  /**
   *   select id, used_count, max_uses from promo_codes where code = $1;
   *   -- $1 the normalised code — LIMIT3 / ONCEONLY, already stored upper-case.
   *   -- 1 row  => the code's live id, counter and limit.
   *   -- 0 rows => the seed did not run; this suite's own precondition failed.
   */
  async function readPromoCodeState(code: string): Promise<PromoCodeState> {
    const { rows } = await assertionClient.pool.query<{ id: number; used_count: number; max_uses: number }>(
      `select id, used_count, max_uses from promo_codes where code = $1`,
      [code],
    );
    const row = rows[0];
    if (row === undefined) throw new Error(`readPromoCodeState: no promo_codes row for code ${code}`);
    return { id: row.id, usedCount: row.used_count, maxUses: row.max_uses };
  }

  /**
   *   select order_id from promo_redemptions where promo_id = $1;
   *   -- $1 the promo's id from readPromoCodeState.
   *   -- N rows => the LEDGER half of I7/I8 — one row per order this promo
   *   --           was ever applied to; production code never deletes one.
   */
  async function readRedemptionOrderIds(promoId: number): Promise<string[]> {
    const { rows } = await assertionClient.pool.query<{ order_id: string }>(
      `select order_id from promo_redemptions where promo_id = $1`,
      [promoId],
    );
    return rows.map((row) => row.order_id);
  }

  /**
   *   select id, amount_minor from orders where id = any($1::text[]);
   *   -- $1 the order ids this test created.
   *   -- N rows => amount_minor as it stands now — the list price if
   *   --           untouched, the repriced (discounted) amount if a
   *   --           redemption applied (OrderRepricingService, step 7).
   */
  async function readOrderAmounts(orderIds: readonly string[]): Promise<Map<string, number>> {
    const { rows } = await assertionClient.pool.query<{ id: string; amount_minor: number }>(
      `select id, amount_minor from orders where id = any($1::text[])`,
      [orderIds],
    );
    return new Map(rows.map((row) => [row.id, row.amount_minor]));
  }

  beforeAll(async () => {
    const databaseUrl = process.env["DATABASE_URL"];
    if (databaseUrl === undefined || databaseUrl === "") {
      throw new Error(
        "DATABASE_URL is not set. Run this suite through `pnpm --filter @game-shop/api exec vitest run " +
          "test/concurrency/promo-limit-race.test.ts` from the repository root via scripts/with-env.ts.",
      );
    }

    assertionClient = createTestDatabaseClient("assert-promo-limit-race");
    pollerClient = createTestDatabaseClient("poll-promo-limit-race");
    assertBaseline(await readBaselineCounts(assertionClient), "before");

    console.log("promo-limit-race: building @game-shop/db, @game-shop/contracts and @game-shop/api...");
    execFileSync("pnpm", ["run", "build:packages"], { cwd: REPO_ROOT, stdio: "inherit" });
    execFileSync("pnpm", ["--filter", "@game-shop/api", "run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });

    instances = await Promise.all(
      Array.from({ length: PROCESS_COUNT }, async (_, index) =>
        startApiInstance({ apiRoot: API_ROOT, port: BASE_PORT + index, databaseUrl }),
      ),
    );
    console.log(
      `promo-limit-race: ${String(instances.length)} apps/api processes healthy on ports ` +
        `${instances.map((instance) => String(instance.port)).join(", ")} ` +
        `(pids ${instances.map((instance) => String(instance.pid)).join(", ")})`,
    );
  }, 120_000);

  afterAll(async () => {
    await stopAllApiInstances(instances);

    if (assertionClient !== undefined) {
      assertBaseline(await readBaselineCounts(assertionClient), "after");
      await assertionClient.close();
    }
    if (pollerClient !== undefined) await pollerClient.close();
  }, 60_000);

  it(
    "LIMIT3 × 20 simultaneous applications on twenty orders: exactly 3 × 200 applied, exactly 17 × 409 exhausted, " +
      "zero 5xx, used_count = 3, and the ledger's order_id set equals the three winners' exactly",
    async () => {
      const before = await readPromoCodeState("LIMIT3");
      expect(before.usedCount, "precondition: LIMIT3 unused before this test").toBe(0);

      const orders = await Promise.all(Array.from({ length: 20 }, () => createOrder()));
      const orderIds = orders.map((order) => order.id);

      try {
        const startedAt = Date.now();
        const { result: responses, witness } = await observeDistinctBackendPidsDuring(
          pollerClient,
          "game-shop",
          async () => Promise.all(orders.map((order) => applyPromoOn(nextInstance(), order.id, "LIMIT3"))),
        );
        const elapsedMs = Date.now() - startedAt;

        console.log(
          `promo-limit-race (LIMIT3 x20): raced in ${String(elapsedMs)}ms; ` +
            `statuses=[${responses.map((response) => String(response.status)).join(", ")}]; ` +
            `distinct Postgres backend pids observed mid-flight: [${witness.distinctPids.join(", ")}] ` +
            `(${String(witness.samples)} pg_stat_activity samples)`,
        );

        // ---------------------------------------------------------------
        // THE LOAD-BEARING ASSERTION (R2): the response SHAPE, not the
        // counter. See the file header — a weakened guard whose fourth
        // increment trips the CHECK leaves used_count = 3 and three ledger
        // rows while answering 500s instead of 409s, and a counter-only
        // test would not see it.
        // ---------------------------------------------------------------
        for (const response of responses) {
          expect(
            [200, 409],
            `every response must be 200 or 409, never anything else: got ${String(response.status)} ${JSON.stringify(response.body)}`,
          ).toContain(response.status);
        }
        expect(
          responses.filter((response) => response.status >= 500),
          "zero 5xx — the assertion a counter-only test cannot make",
        ).toHaveLength(0);

        const paired = orders.map((order, index) => ({ order, response: responses[index] }));
        const applied = paired.filter((pair) => pair.response?.status === 200);
        const refused = paired.filter((pair) => pair.response?.status === 409);

        expect(applied, "exactly three 200s — the limit, not a race artefact").toHaveLength(LIMIT3_MAX_USES);
        expect(refused, "exactly seventeen 409s").toHaveLength(20 - LIMIT3_MAX_USES);

        for (const pair of applied) {
          expect(pair.response?.body?.["id"], "the view belongs to the order that won").toBe(pair.order.id);
          expect(pair.response?.body?.["promo"]).toEqual(expectedPromoView("LIMIT3", LIMIT3_DISCOUNT_MINOR));
          expect(pair.response?.body?.["amount_minor"]).toBe(LIMIT3_AMOUNT_TO_PAY_MINOR);
        }
        for (const pair of refused) {
          expect(pair.response?.body).toEqual({ reason: "exhausted" });
        }

        const after = await readPromoCodeState("LIMIT3");
        expect(after.usedCount, "the counter holds exactly the limit").toBe(LIMIT3_MAX_USES);

        const winnerOrderIds = new Set(applied.map((pair) => pair.order.id));
        expect(winnerOrderIds.size, "three distinct winning orders").toBe(LIMIT3_MAX_USES);

        const ledgerOrderIds = await readRedemptionOrderIds(before.id);
        expect(
          new Set(ledgerOrderIds),
          "the ledger's order_id set equals the three 200s' orders — exactly, not merely in count",
        ).toEqual(winnerOrderIds);

        const amounts = await readOrderAmounts(orderIds);
        for (const orderId of orderIds) {
          const amount = amounts.get(orderId);
          if (winnerOrderIds.has(orderId)) {
            expect(amount, `winner ${orderId} carries the discounted amount`).toBe(LIMIT3_AMOUNT_TO_PAY_MINOR);
          } else {
            expect(amount, `loser ${orderId} still carries the list amount`).toBe(LIST_AMOUNT_MINOR);
          }
        }

        // A soft check beyond "the test passed": direct evidence the harness
        // held more than one live Postgres backend connection at once while
        // the twenty POSTs were in flight — see support/db.ts and this
        // file's RED VALIDATION section for the authoritative proof of
        // genuine cross-process concurrency (`key-claim-race.test.ts`'s
        // identical pattern).
        expect(
          witness.distinctPids.length,
          `only ${String(witness.distinctPids.length)} distinct backend pid(s) observed live during the window`,
        ).toBeGreaterThanOrEqual(2);
      } finally {
        await cleanupTestOrders(assertionClient, orderIds);
      }
    },
    30_000,
  );

  it(
    "ONCEONLY × 10 simultaneous applications on ten orders: exactly 1 × 200 applied, exactly 9 × 409 exhausted, " +
      "zero 5xx, used_count = 1, and the ledger holds exactly the winner",
    async () => {
      const before = await readPromoCodeState("ONCEONLY");
      expect(before.usedCount, "precondition: ONCEONLY unused before this test").toBe(0);

      const orders = await Promise.all(Array.from({ length: 10 }, () => createOrder()));
      const orderIds = orders.map((order) => order.id);

      try {
        const startedAt = Date.now();
        const { result: responses, witness } = await observeDistinctBackendPidsDuring(
          pollerClient,
          "game-shop",
          async () => Promise.all(orders.map((order) => applyPromoOn(nextInstance(), order.id, "ONCEONLY"))),
        );
        const elapsedMs = Date.now() - startedAt;

        console.log(
          `promo-limit-race (ONCEONLY x10): raced in ${String(elapsedMs)}ms; ` +
            `statuses=[${responses.map((response) => String(response.status)).join(", ")}]; ` +
            `distinct Postgres backend pids observed mid-flight: [${witness.distinctPids.join(", ")}] ` +
            `(${String(witness.samples)} pg_stat_activity samples)`,
        );

        for (const response of responses) {
          expect(
            [200, 409],
            `every response must be 200 or 409, never anything else: got ${String(response.status)} ${JSON.stringify(response.body)}`,
          ).toContain(response.status);
        }
        expect(
          responses.filter((response) => response.status >= 500),
          "zero 5xx",
        ).toHaveLength(0);

        const paired = orders.map((order, index) => ({ order, response: responses[index] }));
        const applied = paired.filter((pair) => pair.response?.status === 200);
        const refused = paired.filter((pair) => pair.response?.status === 409);

        expect(applied, "exactly one 200").toHaveLength(ONCEONLY_MAX_USES);
        expect(refused, "exactly nine 409s").toHaveLength(10 - ONCEONLY_MAX_USES);

        for (const pair of applied) {
          expect(pair.response?.body?.["id"]).toBe(pair.order.id);
          expect(pair.response?.body?.["promo"]).toEqual(expectedPromoView("ONCEONLY", ONCEONLY_DISCOUNT_MINOR));
          expect(pair.response?.body?.["amount_minor"]).toBe(ONCEONLY_AMOUNT_TO_PAY_MINOR);
        }
        for (const pair of refused) {
          expect(pair.response?.body).toEqual({ reason: "exhausted" });
        }

        const after = await readPromoCodeState("ONCEONLY");
        expect(after.usedCount, "the counter holds exactly the limit").toBe(ONCEONLY_MAX_USES);

        const winnerOrderIds = new Set(applied.map((pair) => pair.order.id));
        expect(winnerOrderIds.size).toBe(ONCEONLY_MAX_USES);

        const ledgerOrderIds = await readRedemptionOrderIds(before.id);
        expect(new Set(ledgerOrderIds), "the ledger holds exactly the one winner").toEqual(winnerOrderIds);

        const amounts = await readOrderAmounts(orderIds);
        for (const orderId of orderIds) {
          const amount = amounts.get(orderId);
          if (winnerOrderIds.has(orderId)) {
            expect(amount).toBe(ONCEONLY_AMOUNT_TO_PAY_MINOR);
          } else {
            expect(amount).toBe(LIST_AMOUNT_MINOR);
          }
        }

        expect(
          witness.distinctPids.length,
          `only ${String(witness.distinctPids.length)} distinct backend pid(s) observed live during the window`,
        ).toBeGreaterThanOrEqual(2);
      } finally {
        await cleanupTestOrders(assertionClient, orderIds);
      }
    },
    30_000,
  );

  it(
    "one order, LIMIT3 applied 4 times simultaneously (one request per instance): four 200s with identical bodies, " +
      "exactly one ledger row, used_count moves by exactly one — not four",
    async () => {
      const before = await readPromoCodeState("LIMIT3");
      expect(before.usedCount, "precondition: LIMIT3 unused before this test").toBe(0);

      const order = await createOrder();
      const orderIds = [order.id];

      try {
        const startedAt = Date.now();
        const { result: responses, witness } = await observeDistinctBackendPidsDuring(
          pollerClient,
          "game-shop",
          async () =>
            Promise.all([
              applyPromoOn(instanceAt(0), order.id, "LIMIT3"),
              applyPromoOn(instanceAt(1), order.id, "LIMIT3"),
              applyPromoOn(instanceAt(2), order.id, "LIMIT3"),
              applyPromoOn(instanceAt(3), order.id, "LIMIT3"),
            ]),
        );
        const elapsedMs = Date.now() - startedAt;

        console.log(
          `promo-limit-race (one order, LIMIT3 x4): raced in ${String(elapsedMs)}ms; ` +
            `statuses=[${responses.map((response) => String(response.status)).join(", ")}]; ` +
            `distinct Postgres backend pids observed mid-flight: [${witness.distinctPids.join(", ")}] ` +
            `(${String(witness.samples)} pg_stat_activity samples)`,
        );

        for (const response of responses) {
          expect(
            response.status,
            `every one of the four must be answered honestly, none a 5xx: ${JSON.stringify(response.body)}`,
          ).toBe(200);
        }

        // Idempotent re-application (functional spec §2.4's double-click
        // criterion): the first caller through the order lock applies the
        // code; the other three find the redemption row already there
        // (statement 3, AlreadyApplied) and are handed the SAME committed
        // view — never a second discount computed, never a second increment.
        const [first, ...rest] = responses;
        for (const response of rest) {
          expect(response.body, "all four bodies are byte-for-byte the same committed view").toEqual(first?.body);
        }
        expect(first?.body?.["id"]).toBe(order.id);
        expect(first?.body?.["promo"]).toEqual(expectedPromoView("LIMIT3", LIMIT3_DISCOUNT_MINOR));
        expect(first?.body?.["amount_minor"]).toBe(LIMIT3_AMOUNT_TO_PAY_MINOR);

        const after = await readPromoCodeState("LIMIT3");
        expect(after.usedCount, "one use taken — a press-twice-quickly must not cost two").toBe(1);

        const ledgerOrderIds = await readRedemptionOrderIds(before.id);
        expect(ledgerOrderIds, "exactly one ledger row, for this order").toEqual([order.id]);

        const amounts = await readOrderAmounts(orderIds);
        expect(amounts.get(order.id)).toBe(LIMIT3_AMOUNT_TO_PAY_MINOR);

        expect(
          witness.distinctPids.length,
          `only ${String(witness.distinctPids.length)} distinct backend pid(s) observed live during the window`,
        ).toBeGreaterThanOrEqual(2);
      } finally {
        await cleanupTestOrders(assertionClient, orderIds);
      }
    },
    30_000,
  );
});
