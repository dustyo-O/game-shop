// @layer: integration
// @spec: 005-promo-codes-with-enforced-limits
/**
 * The Slice 2 acceptance suite for
 * `context/spec/005-promo-codes-with-enforced-limits/functional-spec.md` —
 * the redemption transaction (technical-considerations §2.2), the endpoint
 * and its refusal contract (§2.3), and the order view's `promo` field,
 * verified at the **single-instance integration layer**
 * (`architecture.md` §7: acceptance runs against one API process, since
 * nothing here needs overlapping requests) against the assembled feature
 * (Slice 2's own three implementation tasks). This is Slice 2's task 4,
 * mirroring `./failure-and-recovery.test.ts`'s role for spec 003: the
 * transaction, the controller and the view exist; this file proves the seam
 * between them holds for a shopper applying a code, and for a payment
 * provider reading the price it produced.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE, AND WHERE IT ACTUALLY LIVES
 * ---------------------------------------------------------------------------
 *   - **The limit under genuine parallelism (functional spec §2.4, the fifth
 *     adversarial scenario).** `tasks.md`'s standing requirement is explicit:
 *     a `max: 1` pool serialises everything inside one instance, so twenty
 *     simultaneous callers from this file would queue in Node before Postgres
 *     ever saw a second I7 statement — a queue test wearing a race test's
 *     clothes. That proof needs real overlapping connections across four
 *     processes and is Slice 3's own file, `../concurrency/
 *     promo-limit-race.test.ts` (ports 5201-5204), plus `pnpm race promo`.
 *     `exhausted` (409) is consequently **not exercised here at all** — this
 *     file's budget is deliberately kept under every code's `max_uses` so
 *     that a slow CI box or a re-run never trips it by accident (see "THE
 *     BUDGET", below); the refusal shape itself is Slice 3's to prove.
 *   - **The shopper's page — the form, the repaint, the Russian text.**
 *     Slice 4's job (`apps/web/e2e/promo.spec.ts`), and none of it is an HTTP
 *     fact this file's `fetch` calls could see.
 *   - **The walkthrough's keystone — why read-then-increment races and a
 *     conditional UPDATE does not.** A prose explanation, not runtime
 *     behaviour; Slice 3's own task, alongside the race proof it explains.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE INSTANCE
 * ---------------------------------------------------------------------------
 * Same reasoning as `./failure-and-recovery.test.ts`'s header: every
 * criterion here is about what one shopper, applying one code to one order,
 * sees — the four codes' arithmetic, case-and-space matching, idempotency on
 * a repeat, the refusal shapes, and the discounted amount surviving payment
 * and delivery. None of it needs two requests to genuinely overlap inside
 * Postgres.
 *
 * ---------------------------------------------------------------------------
 * THE BUDGET — WHY NO TEST BELOW CAN ACCIDENTALLY HIT `exhausted`
 * ---------------------------------------------------------------------------
 * `LIMIT3` allows 3 uses, `ONCEONLY` allows 1. Every test below that spends a
 * use does so on its own, fresh order(s), inside its own `try`, and returns
 * the use in its own `finally` via `cleanupTestOrders` — the decrementing CTE
 * in `../concurrency/support/db.ts` hands back exactly the redemptions that
 * test deleted before the next `it()` runs (this suite's `fileParallelism:
 * false` config means tests never overlap). So the question is only ever
 * "how many uses does the busiest single test spend before its own cleanup
 * runs", and the answer is one: every test that touches `LIMIT3` or
 * `ONCEONLY` applies it to exactly one order once (a same-order repeat costs
 * nothing further — that is the idempotency criterion). `exhausted` is
 * therefore unreachable here by construction, not by luck.
 *
 * ---------------------------------------------------------------------------
 * ASSERTIONS QUERY THE DATABASE DIRECTLY
 * ---------------------------------------------------------------------------
 * Per `context/product/architecture.md` §7 and this task's brief ("Assert the
 * ledger, not only the response"): every criterion about a use being spent
 * reads `promo_redemptions` and `promo_codes.used_count` with raw SQL on
 * `db.pool`, quoted beside the call — an HTTP response can look right while
 * the counter and the ledger disagree, which is exactly the drift
 * `assertBaseline("after")` exists to catch.
 *
 * ---------------------------------------------------------------------------
 * RED VALIDATION
 * ---------------------------------------------------------------------------
 * The implementation this file tests already exists (Slice 2's first three
 * tasks), so — as `./failure-and-recovery.test.ts`'s header puts it for the
 * same situation — "RED" here means a temporary, targeted inversion of what a
 * test asserts, run to see the test fail for the stated reason, then reverted
 * byte-identical. **No production source under `src/` was touched.** Nine
 * inversions, one per `it()` below (the decisive assertion each test's own
 * criterion turns on), applied together and run in one `vitest run` — all
 * nine failed, for exactly the reasons named below and nothing else — then
 * reverted byte-identical (confirmed afterward by grepping the file for the
 * inversion markers: none remained). Command and result:
 *
 *   node scripts/with-env.ts pnpm --filter @game-shop/api exec vitest run \
 *     test/acceptance/promo-codes.test.ts
 *   → Test Files  1 failed (1)  /  Tests  9 failed (9)  /  Duration  6.95s
 *
 * The nine `AssertionError` lines, quoted verbatim from that run:
 *
 *   1. "the four codes … `promo` set" — LIMIT3's `amount_minor` asserted
 *      against the list price instead of the discounted one:
 *        AssertionError: LIMIT3: the amount to pay: expected 96750 to be 129000 // Object.is equality
 *   2. "`nope` → 422 `unknown_code`" — asserted `200` instead of `422`:
 *        AssertionError: POST .../promo { code: "nope" } -> 422: expected 422 to be 200 // Object.is equality
 *   3. "` limit3 ` matched, stored upper-case" — asserted the unnormalised
 *      input as the stored code:
 *        AssertionError: the stored code is the normalised (trim + upper-case) form: expected 'LIMIT3' to be ' limit3 ' // Object.is equality
 *   4. "the same code twice … one ledger row" — asserted two rows instead of
 *      one:
 *        AssertionError: exactly one ledger row, not two: expected 1 to be 2 // Object.is equality
 *   5. "a different code … 409 `another_code_applied`" — asserted `200`
 *      instead of `409`:
 *        AssertionError: POST .../promo { code: "GG500" } on an order carrying LIMIT3 -> 409: expected 409 to be 200 // Object.is equality
 *   6. "a malformed body … 400" — asserted `200` instead of `400` for
 *      `{ code: "" }`:
 *        AssertionError: POST .../promo {"code":""} -> 400: expected 400 to be 200 // Object.is equality
 *   7. "no such order → 404" — asserted `200` instead of `404`:
 *        AssertionError: POST .../promo on a nonexistent order -> 404: expected 404 to be 200 // Object.is equality
 *   8. "an order past `created` → 409 `not_awaiting_payment`" — asserted
 *      `200` instead of `409`:
 *        AssertionError: POST .../promo on a delivered order -> 409: expected 409 to be 200 // Object.is equality
 *   9. "`payment_events.amount_minor` equals the discounted amount" —
 *      asserted the list price instead of the discounted one:
 *        AssertionError: payment_events.amount_minor equals the discounted amount, not the list price: expected 96750 to be 129000 // Object.is equality
 *
 * Every test's own `finally` still ran despite the thrown assertion
 * (`try/finally` runs `finally` on an exception), so `assertBaseline("after")`
 * in this file's own `afterAll` passed on the RED run too — independently
 * re-confirmed by a raw SQL read straight after (`products=12, keys_total=50,
 * keys_unclaimed=50, orders=0, payment_events=0, deliveries=0, promo_codes=4,
 * promo_used_count=0, promo_redemptions=0`), and port 5301 was free again the
 * moment the run ended. Reverted, the same command is GREEN: 9 passed, 0
 * failed, 7.43s, no other output. Slice 6's coverage pass later added a
 * tenth test (§2.4 criterion 6 — an abandoned order's use still counts),
 * RED by inversion beside the assertion itself (`expected 1 to be 0`) and
 * GREEN at 10 passed.
 *
 * Run it: `node scripts/with-env.ts pnpm --filter @game-shop/api exec vitest
 * run test/acceptance/promo-codes.test.ts` — the repository's env wrapper
 * (`scripts/with-env.ts`) supplies `DATABASE_URL`; this file, unlike
 * `./failure-and-recovery.test.ts`, drives no admin-guarded route and needs
 * no `ADMIN_TOKEN`.
 */
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { OrderStatus, isSettledOrderStatus } from "@game-shop/contracts";
import type { DatabaseClient } from "@game-shop/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CreatedOrder, OrderView } from "../../src/orders/orders.types.js";
import type { SimulatedPaymentAck } from "../../src/payments/payment-simulator.types.js";
import {
  type RunningInstance,
  startApiInstance,
  stopAllApiInstances,
} from "../concurrency/support/api-instance.js";
import {
  PURCHASABLE_SKU,
  assertBaseline,
  cleanupTestOrders,
  createTestDatabaseClient,
  readBaselineCounts,
} from "../concurrency/support/db.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
/** `apps/api` — two levels up from `test/acceptance`. */
const API_ROOT = resolve(TEST_DIR, "..", "..");
/** The repository root — where `pnpm run build:packages` resolves from. */
const REPO_ROOT = resolve(API_ROOT, "..", "..");

/**
 * Fixed by `tasks.md`'s standing requirement: "Ports are 5201-5204 (the race
 * test) and 5301 (acceptance), listed in `scripts/race/README.md`'s row;
 * nothing else may bind them." Not chosen from a free range the way the
 * spec 001-003 acceptance files pick their own 4xxx ports — this one is
 * spec 005's dedicated, single acceptance port.
 */
const PORT = 5301;

/** `KEY-CS2-PRIME`'s catalogue price — `packages/db/src/fixtures/catalog.ts` (`priceRub: 1290`) — in kopecks. */
const LIST_AMOUNT_MINOR = 129_000;

function delay(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

interface RawResponse {
  readonly status: number;
  readonly body: unknown;
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<RawResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
}

async function getRaw(baseUrl: string, path: string): Promise<RawResponse> {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
}

async function createOrder(baseUrl: string): Promise<CreatedOrder> {
  const response = await postJson(baseUrl, "/api/orders", { sku: PURCHASABLE_SKU });
  if (response.status !== 201) {
    throw new Error(`POST /api/orders -> ${String(response.status)}: ${JSON.stringify(response.body)}`);
  }
  return response.body as CreatedOrder;
}

async function payOrder(baseUrl: string, orderId: string): Promise<SimulatedPaymentAck> {
  const response = await postJson(baseUrl, `/api/payments/${encodeURIComponent(orderId)}/simulate`, {
    outcome: "success",
  });
  if (response.status !== 200) {
    throw new Error(
      `POST /api/payments/${orderId}/simulate -> ${String(response.status)}: ${JSON.stringify(response.body)}`,
    );
  }
  return response.body as SimulatedPaymentAck;
}

async function getOrder(baseUrl: string, orderId: string): Promise<OrderView> {
  const response = await getRaw(baseUrl, `/api/orders/${encodeURIComponent(orderId)}`);
  if (response.status !== 200) {
    throw new Error(`GET /api/orders/${orderId} -> ${String(response.status)}: ${JSON.stringify(response.body)}`);
  }
  return response.body as OrderView;
}

/** `POST /api/orders/:orderId/promo` — the endpoint under test. Raw, so a 4xx/400 body is inspectable rather than thrown. */
async function applyPromo(baseUrl: string, orderId: string, body: unknown): Promise<RawResponse> {
  return postJson(baseUrl, `/api/orders/${encodeURIComponent(orderId)}/promo`, body);
}

/**
 * Poll `GET /api/orders/:id` until the order leaves the in-flight states —
 * `isSettledOrderStatus`, never a hand-rolled list, matching
 * `./failure-and-recovery.test.ts`'s own stance.
 *
 * `SETTLE_TIMEOUT_MS = 20_000`, matching that file's bound for the same
 * reason: the ladder's own worst case is 12s, and every order this suite
 * pays goes through the same issuance path a promo's discount does not
 * touch.
 */
const SETTLE_POLL_INTERVAL_MS = 25;
const SETTLE_TIMEOUT_MS = 20_000;

async function waitUntilSettled(baseUrl: string, orderId: string): Promise<OrderView> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const view = await getOrder(baseUrl, orderId);
    if (isSettledOrderStatus(view.status)) return view;
    if (Date.now() > deadline) {
      throw new Error(`order ${orderId} did not settle within ${String(SETTLE_TIMEOUT_MS)}ms (status=${view.status})`);
    }
    await delay(SETTLE_POLL_INTERVAL_MS);
  }
}

describe("functional spec 005-promo-codes-with-enforced-limits — acceptance (single instance, port 5301)", () => {
  let instance: RunningInstance;
  let db: DatabaseClient;

  /**
   * The ledger's row count for one order — I8's table, read directly.
   *
   *   select count(*)::int as n from promo_redemptions where order_id = $1;
   */
  async function countPromoRedemptions(orderId: string): Promise<number> {
    const { rows } = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from promo_redemptions where order_id = $1`,
      [orderId],
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * One order's ledger row — the two stored amounts I8 recorded.
   *
   *   select list_amount_minor, discount_minor from promo_redemptions where order_id = $1;
   */
  async function readPromoRedemptionRow(
    orderId: string,
  ): Promise<{ listAmountMinor: number; discountMinor: number } | undefined> {
    const { rows } = await db.pool.query<{ list_amount_minor: number; discount_minor: number }>(
      `select list_amount_minor, discount_minor from promo_redemptions where order_id = $1`,
      [orderId],
    );
    const row = rows[0];
    return row === undefined
      ? undefined
      : { listAmountMinor: row.list_amount_minor, discountMinor: row.discount_minor };
  }

  /**
   * I7's counter for one code, by its stored (normalised) form.
   *
   *   select used_count, max_uses from promo_codes where code = $1;
   */
  async function readPromoCounter(code: string): Promise<{ usedCount: number; maxUses: number } | undefined> {
    const { rows } = await db.pool.query<{ used_count: number; max_uses: number }>(
      `select used_count, max_uses from promo_codes where code = $1`,
      [code],
    );
    const row = rows[0];
    return row === undefined ? undefined : { usedCount: row.used_count, maxUses: row.max_uses };
  }

  /**
   * The `paid` webhook event this order was actually charged for — read off
   * `payment_events` directly, not re-derived from `orders`, so criterion 3
   * of technical-considerations §2.3 ("the payment is for the discounted
   * amount") is checked against what the simulator's webhook call carried,
   * not against the same column the assertion would otherwise be circular
   * against.
   *
   *   select amount_minor from payment_events where order_id = $1 and status = 'paid';
   */
  async function readPaidEventAmount(orderId: string): Promise<number | undefined> {
    const { rows } = await db.pool.query<{ amount_minor: number }>(
      `select amount_minor from payment_events where order_id = $1 and status = 'paid'`,
      [orderId],
    );
    return rows[0]?.amount_minor;
  }

  beforeAll(async () => {
    const databaseUrl = process.env["DATABASE_URL"];
    if (databaseUrl === undefined || databaseUrl === "") {
      throw new Error(
        "DATABASE_URL is not set. Run this suite through `node scripts/with-env.ts pnpm --filter " +
          "@game-shop/api exec vitest run test/acceptance/promo-codes.test.ts` from the repository root, " +
          "which loads the local environment first.",
      );
    }

    db = createTestDatabaseClient("acceptance-005-assert");
    assertBaseline(await readBaselineCounts(db), "before");

    // Rebuilding from current source is what makes RED validation meaningful
    // — see ../concurrency/support/api-instance.ts's header.
    console.log("promo-codes: building @game-shop/db, @game-shop/contracts and @game-shop/api...");
    execFileSync("pnpm", ["run", "build:packages"], { cwd: REPO_ROOT, stdio: "inherit" });
    execFileSync("pnpm", ["--filter", "@game-shop/api", "run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });

    instance = await startApiInstance({ apiRoot: API_ROOT, port: PORT, databaseUrl });
    console.log(`promo-codes: apps/api healthy on port ${String(instance.port)} (pid ${String(instance.pid)})`);
  }, 120_000);

  afterAll(async () => {
    if (instance !== undefined) await stopAllApiInstances([instance]);

    if (db !== undefined) {
      assertBaseline(await readBaselineCounts(db), "after");
      await db.close();
    }
  }, 60_000);

  // =========================================================================
  describe("§2.1 — the four supplied codes, priced by the shop", () => {
    it(
      "each of the four codes discounts a 1 290 ₽ order to the brief's own figure, with `promo` set and " +
        "`list_amount_minor` at the catalogue price, and the counter and ledger both move by exactly one " +
        "use (§2.1 criteria 1-4, §2.3 criterion 1)",
      async () => {
        const orderIds: string[] = [];
        // WELCOME10 10% / GG500 500₽ / LIMIT3 25% / ONCEONLY 50%, off 129 000 —
        // technical-considerations §2.1's worked table.
        const cases = [
          { code: "WELCOME10", amountMinor: 116_100, discountMinor: 12_900 },
          { code: "GG500", amountMinor: 79_000, discountMinor: 50_000 },
          { code: "LIMIT3", amountMinor: 96_750, discountMinor: 32_250 },
          { code: "ONCEONLY", amountMinor: 64_500, discountMinor: 64_500 },
        ] as const;

        try {
          for (const testCase of cases) {
            const before = await readPromoCounter(testCase.code);
            if (before === undefined) throw new Error(`${testCase.code} missing from promo_codes`);

            const order = await createOrder(instance.baseUrl);
            orderIds.push(order.id);
            expect(order.amount_minor, "precondition: the catalogue price is 1 290 ₽").toBe(LIST_AMOUNT_MINOR);

            const response = await applyPromo(instance.baseUrl, order.id, { code: testCase.code });
            expect(
              response.status,
              `POST .../promo { code: "${testCase.code}" } -> ${String(response.status)}: ${JSON.stringify(response.body)}`,
            ).toBe(200);
            const view = response.body as OrderView;

            // CAN FAIL: inverted to `.toBe(LIST_AMOUNT_MINOR)` and re-run for
            // LIMIT3 — see this file's header, RED item 1:
            //   AssertionError: LIMIT3: the amount to pay: expected 129000 to be 96750
            expect(view.amount_minor, `${testCase.code}: the amount to pay`).toBe(testCase.amountMinor);
            expect(view.promo, `${testCase.code}: promo is set`).not.toBeNull();
            expect(view.promo?.code).toBe(testCase.code);
            expect(view.promo?.discount_minor, `${testCase.code}: discount_minor`).toBe(testCase.discountMinor);
            expect(
              view.promo?.list_amount_minor,
              `${testCase.code}: list_amount_minor is the catalogue price, always`,
            ).toBe(LIST_AMOUNT_MINOR);

            // The ledger — I8's row — not only the response.
            const ledgerRow = await readPromoRedemptionRow(order.id);
            if (ledgerRow === undefined) throw new Error(`no promo_redemptions row for order ${order.id}`);
            expect(ledgerRow.listAmountMinor, `${testCase.code}: ledger's list_amount_minor`).toBe(LIST_AMOUNT_MINOR);
            expect(ledgerRow.discountMinor, `${testCase.code}: ledger's discount_minor`).toBe(testCase.discountMinor);

            // The counter — I7's row — moved by exactly this one use.
            const after = await readPromoCounter(testCase.code);
            expect(after?.usedCount, `${testCase.code}: the counter moved by exactly one use`).toBe(
              before.usedCount + 1,
            );
          }
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );

    it(
      "a code that is not one of the four on file is refused 422 `unknown_code`, and the order's " +
        "`amount_minor` does not change (§2.1 criterion 6)",
      async () => {
        const orderIds: string[] = [];
        try {
          const order = await createOrder(instance.baseUrl);
          orderIds.push(order.id);

          const response = await applyPromo(instance.baseUrl, order.id, { code: "nope" });
          // CAN FAIL: inverted to `.toBe(200)` and re-run — RED item 2:
          //   AssertionError: expected 422 to be 200 // Object.is equality
          expect(response.status, `POST .../promo { code: "nope" } -> ${String(response.status)}`).toBe(422);
          expect(response.body).toEqual({ reason: "unknown_code" });

          const after = await getOrder(instance.baseUrl, order.id);
          expect(after.amount_minor, "the amount to pay is untouched by a refused code").toBe(LIST_AMOUNT_MINOR);
          expect(after.promo, "no promo was recorded").toBeNull();
          expect(await countPromoRedemptions(order.id), "nothing written to the ledger").toBe(0);
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );
  });

  // =========================================================================
  describe("§2.1/§2.2 — matching a code, and applying it once", () => {
    it(
      "a code with surrounding spaces and lower case is matched, and the applied code is stored in its " +
        "normalised (trim + upper-case) form (§2.1 criterion 5)",
      async () => {
        const orderIds: string[] = [];
        try {
          const order = await createOrder(instance.baseUrl);
          orderIds.push(order.id);

          const response = await applyPromo(instance.baseUrl, order.id, { code: " limit3 " });
          expect(response.status, `POST .../promo { code: " limit3 " } -> ${String(response.status)}`).toBe(200);
          const view = response.body as OrderView;

          // CAN FAIL: inverted to `.toBe(" limit3 ")` (the unnormalised input)
          // and re-run — RED item 3:
          //   AssertionError: the stored code is the normalised (trim + upper-case) form: expected 'LIMIT3' to be ' limit3 '
          expect(view.promo?.code, "the stored code is the normalised (trim + upper-case) form").toBe("LIMIT3");
          expect(view.amount_minor).toBe(96_750);

          const ledgerRow = await readPromoRedemptionRow(order.id);
          expect(ledgerRow?.discountMinor).toBe(32_250);
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );

    it(
      "the same code applied twice to the same order is idempotent: an identical `200` body, one ledger " +
        "row, and the counter moved once, not twice (§2.4 criterion 5)",
      async () => {
        const orderIds: string[] = [];
        try {
          const before = await readPromoCounter("LIMIT3");
          if (before === undefined) throw new Error("LIMIT3 missing from promo_codes");

          const order = await createOrder(instance.baseUrl);
          orderIds.push(order.id);

          const first = await applyPromo(instance.baseUrl, order.id, { code: "LIMIT3" });
          expect(first.status, `first application -> ${String(first.status)}`).toBe(200);

          // Different casing on the repeat — still the same code once normalised.
          const second = await applyPromo(instance.baseUrl, order.id, { code: "limit3" });
          expect(second.status, "the repeat is 200, not a refusal").toBe(200);
          expect(second.body, "the repeat's body is identical to the first application's").toEqual(first.body);

          // CAN FAIL: inverted to `.toBe(2)` and re-run — RED item 4:
          //   AssertionError: exactly one ledger row, not two: expected 1 to be 2
          expect(await countPromoRedemptions(order.id), "exactly one ledger row, not two").toBe(1);

          const after = await readPromoCounter("LIMIT3");
          expect(after?.usedCount, "the counter moved by exactly one use, not two").toBe(before.usedCount + 1);
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );

    it(
      "a different code on an order that already carries one is refused 409 `another_code_applied`, and " +
        "the original code, amount and ledger are untouched — and the second code's own counter is never " +
        "even reached (§2.2 criterion 3)",
      async () => {
        const orderIds: string[] = [];
        try {
          const order = await createOrder(instance.baseUrl);
          orderIds.push(order.id);

          const applied = await applyPromo(instance.baseUrl, order.id, { code: "LIMIT3" });
          expect(applied.status).toBe(200);

          const before = await readPromoCounter("GG500");
          if (before === undefined) throw new Error("GG500 missing from promo_codes");

          const refused = await applyPromo(instance.baseUrl, order.id, { code: "GG500" });
          // CAN FAIL: inverted to `.toBe(200)` and re-run — RED item 5:
          //   AssertionError: expected 409 to be 200 // Object.is equality
          expect(refused.status, `POST .../promo { code: "GG500" } on an order carrying LIMIT3 -> ${String(refused.status)}`).toBe(409);
          expect(refused.body).toEqual({ reason: "another_code_applied" });

          // GG500's own counter is untouched: technical-considerations §2.2
          // statement 3 reads the existing redemption BEFORE the code lookup
          // (statement 4), so a refusal here never touches GG500's row at all.
          const after = await readPromoCounter("GG500");
          expect(after?.usedCount, "GG500's counter never moved — its row was never reached").toBe(
            before.usedCount,
          );

          const view = await getOrder(instance.baseUrl, order.id);
          expect(view.promo?.code, "still LIMIT3 — the only code on the order").toBe("LIMIT3");
          expect(view.amount_minor, "still the LIMIT3 price").toBe(96_750);
          expect(await countPromoRedemptions(order.id), "still exactly one ledger row").toBe(1);
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );
  });

  // =========================================================================
  describe("malformed requests, and an order that does not exist", () => {
    it(
      "a body that is not `{ code: string }`, or is empty after trim, is refused 400 — decided before " +
        "any order is even looked up",
      async () => {
        const orderIds: string[] = [];
        try {
          const order = await createOrder(instance.baseUrl);
          orderIds.push(order.id);

          const malformedBodies: readonly unknown[] = [
            {},
            { code: "" },
            { code: "   " },
            { code: 123 },
            { code: null },
            { code: true },
            { code: ["LIMIT3"] },
            { notCode: "LIMIT3" },
          ];

          for (const body of malformedBodies) {
            const response = await applyPromo(instance.baseUrl, order.id, body);
            // CAN FAIL: inverted to `.toBe(200)` for `{ code: "" }` and
            // re-run — RED item 6:
            //   AssertionError: POST .../promo {"code":""} -> 400: expected 400 to be 200
            expect(response.status, `POST .../promo ${JSON.stringify(body)} -> ${String(response.status)}`).toBe(400);
          }

          // Body validation runs before the order is even locked
          // (`parseApplyPromoRequest` in `promo.controller.ts` runs before
          // `PromoRedemptionService.apply`): a malformed body against an
          // order id that does not exist still answers 400, never 404.
          const nonexistentId = `ord_test_005_missing_${randomUUID()}`;
          const responseForMissingOrder = await applyPromo(instance.baseUrl, nonexistentId, { code: "" });
          expect(responseForMissingOrder.status, "a malformed body is refused before the order lookup").toBe(400);

          const after = await getOrder(instance.baseUrl, order.id);
          expect(after.promo, "nothing was applied by any of the malformed bodies").toBeNull();
          expect(after.amount_minor).toBe(LIST_AMOUNT_MINOR);
          expect(await countPromoRedemptions(order.id)).toBe(0);
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );

    it("no such order is refused 404, distinctly from every other refusal", async () => {
      const nonexistentId = `ord_test_005_missing_${randomUUID()}`;
      const response = await applyPromo(instance.baseUrl, nonexistentId, { code: "LIMIT3" });
      // CAN FAIL: inverted to `.toBe(200)` and re-run — RED item 7:
      //   AssertionError: expected 404 to be 200 // Object.is equality
      expect(response.status, `POST .../promo on a nonexistent order -> ${String(response.status)}`).toBe(404);
    });
  });

  // =========================================================================
  describe("§2.3 — the shop's price reaches payment and survives delivery", () => {
    it(
      "an order that has left `created` refuses promo application with 409 `not_awaiting_payment`, and " +
        "changes nothing — including the code's own counter, which the refusal never reaches",
      async () => {
        const orderIds: string[] = [];
        try {
          const order = await createOrder(instance.baseUrl);
          orderIds.push(order.id);
          await payOrder(instance.baseUrl, order.id);
          const settled = await waitUntilSettled(instance.baseUrl, order.id);
          expect(settled.status).toBe(OrderStatus.Delivered);

          const before = await readPromoCounter("LIMIT3");
          if (before === undefined) throw new Error("LIMIT3 missing from promo_codes");

          const refused = await applyPromo(instance.baseUrl, order.id, { code: "LIMIT3" });
          // CAN FAIL: inverted to `.toBe(200)` and re-run — RED item 8:
          //   AssertionError: expected 409 to be 200 // Object.is equality
          expect(refused.status, `POST .../promo on a delivered order -> ${String(refused.status)}`).toBe(409);
          expect(refused.body).toEqual({ reason: "not_awaiting_payment" });

          const after = await getOrder(instance.baseUrl, order.id);
          expect(after.amount_minor, "the amount does not change").toBe(LIST_AMOUNT_MINOR);
          expect(after.promo, "no promo recorded").toBeNull();
          if (after.status !== OrderStatus.Delivered) throw new Error("expected the order to stay delivered");
          expect(after.code, "the key is unaffected").toBe(settled.code);

          // The refusal is decided in memory at the status check (statement
          // 2), before the code lookup (statement 4) — LIMIT3's own counter
          // is never reached.
          const afterCounter = await readPromoCounter("LIMIT3");
          expect(
            afterCounter?.usedCount,
            "the counter never moved — decided at the status check, before the code lookup",
          ).toBe(before.usedCount);
          expect(await countPromoRedemptions(order.id), "nothing written").toBe(0);
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );

    it(
      "the discounted amount is what the simulator actually pays, and the promo survives payment and " +
        "delivery unchanged on a later, independent GET (§2.3 criteria 3-4)",
      async () => {
        const orderIds: string[] = [];
        try {
          const order = await createOrder(instance.baseUrl);
          orderIds.push(order.id);

          const applied = await applyPromo(instance.baseUrl, order.id, { code: "LIMIT3" });
          expect(applied.status).toBe(200);
          const appliedView = applied.body as OrderView;
          expect(appliedView.amount_minor).toBe(96_750);

          await payOrder(instance.baseUrl, order.id);
          const settled = await waitUntilSettled(instance.baseUrl, order.id);
          expect(settled.status).toBe(OrderStatus.Delivered);

          // The discounted amount is what the simulator's webhook actually
          // charged — read off payment_events directly, not re-derived.
          const paidAmount = await readPaidEventAmount(order.id);
          // CAN FAIL: inverted to `.toBe(LIST_AMOUNT_MINOR)` and re-run —
          // RED item 9:
          //   AssertionError: payment_events.amount_minor equals the discounted amount, not the list price: expected 96750 to be 129000
          expect(
            paidAmount,
            "payment_events.amount_minor equals the discounted amount, not the list price",
          ).toBe(96_750);

          expect(settled.promo, "the delivered view still carries the promo").not.toBeNull();
          expect(settled.promo?.code).toBe("LIMIT3");
          expect(settled.promo?.discount_minor).toBe(32_250);
          expect(settled.promo?.list_amount_minor).toBe(LIST_AMOUNT_MINOR);
          expect(settled.amount_minor, "the paid, delivered order still shows the discounted amount").toBe(96_750);

          // "The record of what was paid does not change after the fact" —
          // a second, independent GET reads the identical view.
          const reread = await getOrder(instance.baseUrl, order.id);
          expect(reread).toEqual(settled);
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );
  });

  // =========================================================================
  // Added by Slice 6 (feature-level coverage pass): functional spec §2.4's
  // sixth criterion — "Given a code was applied to an order that was then
  // never paid, when the count is read, then that order's use still counts
  // — an abandoned order does not return a use." Every test above that reads
  // the counter after applying a code does so on an order that is still
  // `created` at that point, which already demonstrates the mechanism, but
  // none of them is framed around "abandonment" or reads the counter after
  // the order has been left untouched for a beat, in its own words the way
  // this criterion states them. Out of scope §3 confirms there is no
  // production code path that would ever give a use back — "returning a use
  // when an order is abandoned" is explicitly listed as deliberately not
  // part of this phase — so this test is really pinning an absence: nothing
  // decrements `used_count` or removes a `promo_redemptions` row for an order
  // that sits in `created` and goes nowhere.
  //
  // `GG500` (max_uses 20) is used rather than `LIMIT3`/`ONCEONLY`, per this
  // file's own "THE BUDGET" header note: every test that spends a tight
  // code's use returns it in its own `finally`, and this test's whole point
  // is to read the counter *before* that return happens, so it should not
  // also be the test that first touches a scarce code.
  describe("§2.4 criterion 6 — a code applied to an order that is then never paid still counts as a use", () => {
    it(
      "an abandoned order — a code applied, the order left in `created`, never paid — still counts against " +
        "the limit when the counter and the ledger are read; nothing returns the use",
      async () => {
        const orderIds: string[] = [];
        try {
          const before = await readPromoCounter("GG500");
          if (before === undefined) throw new Error("GG500 missing from promo_codes");

          const order = await createOrder(instance.baseUrl);
          orderIds.push(order.id);

          const applied = await applyPromo(instance.baseUrl, order.id, { code: "GG500" });
          expect(applied.status).toBe(200);

          // The order is deliberately left exactly here: no payment attempt
          // follows. "Abandoned" in the criterion's own sense is a shopper
          // who applied a code and never came back — precondition checked so
          // a future change to this suite's ordering cannot accidentally pay
          // it first and call the result the same test.
          const abandoned = await getOrder(instance.baseUrl, order.id);
          expect(
            abandoned.status,
            "precondition: the order is genuinely abandoned — still awaiting payment, not settled",
          ).toBe(OrderStatus.Created);

          // CAN FAIL: inverted to `.toBe(before.usedCount)` — asserting the
          // use was returned by abandonment — and re-run:
          //   AssertionError: an abandoned order's use still counts, exactly as it did the moment it was applied: expected 1 to be 0
          const after = await readPromoCounter("GG500");
          expect(
            after?.usedCount,
            "an abandoned order's use still counts, exactly as it did the moment it was applied",
          ).toBe(before.usedCount + 1);

          // The ledger row is not removed by abandonment either — I8's row
          // is the record of the use, and nothing in this path deletes it.
          expect(
            await countPromoRedemptions(order.id),
            "the ledger row for an abandoned order's redemption is still there when read",
          ).toBe(1);
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );
  });
});
