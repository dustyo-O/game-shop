// @layer: integration
// @spec: 001-purchase-and-key-delivery
/**
 * The feature-level acceptance suite for
 * `context/spec/001-purchase-and-key-delivery/functional-spec.md` — every
 * acceptance criterion in §2.1 through §2.6 and §2.8, verified against the
 * whole assembled feature rather than against any one slice. This is Slice
 * 9's own task: the eight implementation slices are done and each was
 * verified on its own; this file is what proves the seams between them hold
 * when a shopper walks the entire path — browse, buy, pay, receive, find
 * again — without anyone stepping in to help.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 *   - **§2.5, "a key is never given away twice".** Already has its own
 *     dedicated proof, `../concurrency/key-claim-race.test.ts`: N orders paid
 *     in parallel across four real OS processes, and the boundary case of
 *     paying more than the pool holds. Re-testing the same invariant here
 *     would exercise the identical code path a second time while proving
 *     nothing new, so this file does not touch it. It is simply confirmed
 *     present in the coverage table this task reports.
 *   - **§2.7, the walkthrough.** `docs/walkthrough/phase-1.md` is a document,
 *     not runtime behaviour — there is no HTTP request or database row that
 *     "being a good explanation" could be asserted against. A test that
 *     checked the file merely exists, or merely contains certain headings,
 *     would not verify what §2.7 actually asks for (that the *prose* teaches
 *     the three keystones) and would be theatre pretending to be coverage.
 *     This phase's task report states how §2.7 was verified instead: by
 *     reading it.
 *   - **A browser-driven (Playwright) layer.** `apps/web` has no test runner
 *     configured, and every acceptance criterion that is *visible only in the
 *     DOM* — the «Купить» button appearing exactly where `purchasable` is
 *     true, the «Оплатить успешно» / «Оплата не прошла» pair, the Russian
 *     wording of every static label — is a direct, unconditional rendering of
 *     a fact this file already asserts at the API/database boundary, or of a
 *     literal string constant with no branch to test (verified by reading
 *     `apps/web/src/entities/product/ui/product-card.ts`,
 *     `apps/web/src/features/simulate-payment/ui/payment-controls.ts`,
 *     `apps/web/src/entities/order/ui/order-details.ts`,
 *     `apps/web/src/entities/order/lib/order-status-label.ts` and the two
 *     page shells). Standing up a Playwright project — a new devDependency,
 *     a config file, a browser download — to re-observe facts already proven
 *     server-side is exactly the "heavy infrastructure the assignment does
 *     not need" this task was warned against. The one thing a browser test
 *     would add — proof that the poll genuinely avoids a page reload — is a
 *     property of `apps/web/src/pages/order/model/poll.ts` calling
 *     `fetch` on a timer, which this file exercises directly by reading the
 *     same polled endpoint twice with nothing in between but the payment
 *     call, exactly as that code does.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE RUNNING INSTANCE, NOT FOUR
 * ---------------------------------------------------------------------------
 * `../concurrency/support/api-instance.ts` spawns real child processes
 * because Phase 1's connection pool of one per process
 * (`packages/db/src/client.ts`) makes N *genuinely overlapping* claims
 * impossible inside a single process — see that file's header. Nothing here
 * needs two requests to overlap; every acceptance criterion in §2.1-§2.6 and
 * §2.8 is about what one shopper sees on one path. So this suite reuses the
 * same harness (`startApiInstance` / `stopAllApiInstances`) but asks for a
 * single instance — the concurrency proof stays the only place spawning four
 * processes earns its cost.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CATALOGUE IS TRANSCRIBED HERE RATHER THAN IMPORTED
 * ---------------------------------------------------------------------------
 * `EXPECTED_CATALOG` below is copied from
 * `packages/db/src/fixtures/catalog.ts` by hand, not imported from it — the
 * same reasoning `../concurrency/support/db.ts` gives for not importing
 * `deriveIssuanceRequestId`: a bug that changes the fixture and an import of
 * it in the same edit is exactly the class of bug §2.8 exists to catch, and
 * an import cannot catch what it shares a source with.
 *
 * ---------------------------------------------------------------------------
 * ASSERTIONS QUERY THE DATABASE DIRECTLY
 * ---------------------------------------------------------------------------
 * Per `context/product/architecture.md` §7 and the precedent it names: the
 * `DrizzleQueryError` defect (`docs/walkthrough/slice-4-supplier-idempotency.md`
 * §6) had the database staying correct while the API answered nineteen `500`s
 * — a response-only test would have called that a failure for the wrong
 * reason, and a database-only test would have missed the defect entirely.
 * Every test below that produces a delivered order or a rejected one reads
 * the relevant row back with a raw SQL query on `db.pool`, quoted in a
 * comment beside the call, and compares it against what the API said.
 *
 * ---------------------------------------------------------------------------
 * RED VALIDATION
 * ---------------------------------------------------------------------------
 * The implementation this file tests already exists (Slices 1-8), so "RED"
 * here means the same thing it means in `../concurrency/key-claim-race.test.ts`:
 * a temporary, targeted weakening of the specific production code a test
 * defends, run to see the test fail for the stated reason, then restored
 * exactly. That process, the exact edits made, and the exact failure output
 * are reported in this task's report rather than kept in this file — a
 * permanent toggle for re-breaking working code has no place shipping beside
 * it. This file is the artifact that stayed; the breakage was transient.
 *
 * Run it: `pnpm test:acceptance` from the repository root.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OrderStatus } from "@game-shop/contracts";
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
/** The repository root — where `pnpm run build:packages` and the workspace filters resolve from. */
const REPO_ROOT = resolve(API_ROOT, "..", "..");

/**
 * Clear of the concurrency suite's range (4101-4104) and of `API_PORT`
 * (3000, `.env.example`) and `WEB_PORT` (5173), so this suite never collides
 * with either running locally.
 */
const PORT = 4201;

/**
 * The twelve catalogue items, transcribed independently — see the header,
 * "WHY THE CATALOGUE IS TRANSCRIBED HERE RATHER THAN IMPORTED". Order,
 * spelling and prices are the assignment's own
 * (`packages/db/src/fixtures/catalog.ts`).
 */
const EXPECTED_CATALOG = [
  { sku: "STEAM-TOPUP-500", name: "Пополнение Steam 500 ₽", priceRub: 500, purchasable: false },
  { sku: "STEAM-TOPUP-1000", name: "Пополнение Steam 1000 ₽", priceRub: 1000, purchasable: false },
  { sku: "STEAM-TOPUP-2500", name: "Пополнение Steam 2500 ₽", priceRub: 2500, purchasable: false },
  { sku: "KEY-CS2-PRIME", name: "CS2 Prime Status ключ", priceRub: 1290, purchasable: true },
  { sku: "KEY-GTA5", name: "GTA V ключ активации", priceRub: 1990, purchasable: true },
  { sku: "KEY-EFT", name: "Escape from Tarkov ключ", priceRub: 3490, purchasable: true },
  { sku: "SUB-DISCORD-1M", name: "Discord Nitro 1 месяц", priceRub: 399, purchasable: false },
  { sku: "SUB-YT-3M", name: "YouTube Premium 3 месяца", priceRub: 1490, purchasable: false },
  { sku: "SUB-SPOTIFY-1M", name: "Spotify Premium 1 месяц", priceRub: 299, purchasable: false },
  { sku: "GIFT-PSN-1000", name: "PlayStation Store карта 1000 ₽", priceRub: 1000, purchasable: false },
  { sku: "GIFT-XBOX-1500", name: "Xbox Gift Card 1500 ₽", priceRub: 1500, purchasable: false },
  { sku: "GIFT-ROBLOX-800", name: "Roblox 800 Robux", priceRub: 890, purchasable: false },
] as const;

const CATALOG_SIZE = EXPECTED_CATALOG.length;
const MINOR_UNITS_PER_ROUBLE = 100;

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

async function getJson(baseUrl: string, path: string): Promise<RawResponse> {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
}

async function createOrder(baseUrl: string, sku: string): Promise<CreatedOrder> {
  const { status, body } = await postJson(baseUrl, "/api/orders", { sku });
  if (status !== 201) {
    throw new Error(`POST /api/orders {sku:"${sku}"} -> ${String(status)}: ${JSON.stringify(body)}`);
  }
  return body as CreatedOrder;
}

async function getOrder(baseUrl: string, orderId: string): Promise<OrderView> {
  const { status, body } = await getJson(baseUrl, `/api/orders/${encodeURIComponent(orderId)}`);
  if (status !== 200) {
    throw new Error(`GET /api/orders/${orderId} -> ${String(status)}: ${JSON.stringify(body)}`);
  }
  return body as OrderView;
}

async function payOrder(
  baseUrl: string,
  orderId: string,
  outcome: "success" | "failure",
): Promise<SimulatedPaymentAck> {
  const { status, body } = await postJson(baseUrl, `/api/payments/${encodeURIComponent(orderId)}/simulate`, {
    outcome,
  });
  if (status !== 200) {
    throw new Error(
      `POST /api/payments/${orderId}/simulate {outcome:"${outcome}"} -> ${String(status)}: ${JSON.stringify(body)}`,
    );
  }
  return body as SimulatedPaymentAck;
}

const SETTLE_POLL_INTERVAL_MS = 25;
const SETTLE_TIMEOUT_MS = 5_000;

/**
 * Poll `GET /api/orders/:id` until the order leaves the in-flight states —
 * the exact mechanism `apps/web/src/pages/order/model/poll.ts` uses, run
 * here directly rather than through a browser.
 */
async function waitUntilSettled(baseUrl: string, orderId: string): Promise<OrderView> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const view = await getOrder(baseUrl, orderId);
    if (
      view.status === OrderStatus.Delivered ||
      view.status === OrderStatus.PaymentFailed ||
      view.status === OrderStatus.OutOfStock
    ) {
      return view;
    }
    if (Date.now() > deadline) {
      throw new Error(`order ${orderId} did not settle within ${String(SETTLE_TIMEOUT_MS)}ms (status=${view.status})`);
    }
    await delay(SETTLE_POLL_INTERVAL_MS);
  }
}

describe("functional spec 001-purchase-and-key-delivery — feature acceptance", () => {
  let instance: RunningInstance;
  let db: DatabaseClient;

  beforeAll(async () => {
    const databaseUrl = process.env["DATABASE_URL"];
    if (databaseUrl === undefined || databaseUrl === "") {
      throw new Error(
        "DATABASE_URL is not set. Run this suite through `pnpm test:acceptance` " +
          "from the repository root, which loads the local environment first " +
          "(scripts/with-env.ts).",
      );
    }

    db = createTestDatabaseClient("acceptance-assert");
    assertBaseline(await readBaselineCounts(db), "before");

    // Rebuilding from current source is what makes RED validation meaningful
    // — see ../concurrency/support/api-instance.ts's header.
    console.log("purchase-and-key-delivery: building @game-shop/db, @game-shop/contracts and @game-shop/api...");
    execFileSync("pnpm", ["run", "build:packages"], { cwd: REPO_ROOT, stdio: "inherit" });
    execFileSync("pnpm", ["--filter", "@game-shop/api", "run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });

    instance = await startApiInstance({ apiRoot: API_ROOT, port: PORT, databaseUrl });
    console.log(`purchase-and-key-delivery: apps/api healthy on port ${String(instance.port)} (pid ${String(instance.pid)})`);
  }, 120_000);

  afterAll(async () => {
    await stopAllApiInstances([instance]);

    if (db !== undefined) {
      assertBaseline(await readBaselineCounts(db), "after");
      await db.close();
    }
  }, 60_000);

  describe("§2.1 — seeing what is for sale", () => {
    it(
      "GET /api/products lists exactly the twelve seeded items, matching the database and the " +
        "catalogue's own Russian names and prices verbatim (§2.1 AC1/AC2, §2.8 AC2)",
      async () => {
        const { status, body } = await getJson(instance.baseUrl, "/api/products");
        expect(status).toBe(200);
        const products = body as readonly Record<string, unknown>[];
        expect(products.length, "GET /api/products item count").toBe(CATALOG_SIZE);

        //   select sku, name, price_minor, currency, purchasable from products order by id;
        const dbRows = await db.pool.query<{
          sku: string;
          name: string;
          price_minor: number;
          currency: string;
          purchasable: boolean;
        }>(`select sku, name, price_minor, currency, purchasable from products order by id`);
        expect(dbRows.rowCount, "products table row count").toBe(CATALOG_SIZE);

        EXPECTED_CATALOG.forEach((expected, index) => {
          const apiItem = products[index];
          const dbRow = dbRows.rows[index];
          expect(apiItem, `API item ${String(index)} exists`).toBeDefined();
          expect(dbRow, `DB row ${String(index)} exists`).toBeDefined();
          if (apiItem === undefined || dbRow === undefined) return;

          expect(apiItem["sku"], `item ${String(index)} sku`).toBe(expected.sku);
          expect(apiItem["name"], `item ${String(index)} name, verbatim (§2.8 AC2)`).toBe(expected.name);
          expect(apiItem["price_minor"], `item ${String(index)} price in kopecks`).toBe(
            expected.priceRub * MINOR_UNITS_PER_ROUBLE,
          );
          expect(apiItem["currency"], `item ${String(index)} currency`).toBe("RUB");
          expect(apiItem["purchasable"], `item ${String(index)} purchasable flag`).toBe(expected.purchasable);

          // The API compared to the database directly, not only both to the
          // fixture — architecture.md §7.
          expect(apiItem["sku"], `item ${String(index)}: API sku matches DB row`).toBe(dbRow.sku);
          expect(apiItem["name"], `item ${String(index)}: API name matches DB row`).toBe(dbRow.name);
          expect(apiItem["price_minor"], `item ${String(index)}: API price matches DB row`).toBe(dbRow.price_minor);
          expect(apiItem["purchasable"], `item ${String(index)}: API purchasable matches DB row`).toBe(
            dbRow.purchasable,
          );
        });
      },
    );

    it("exactly the three key-type products are purchasable — the other nine are display-only (§2.1 AC3)", async () => {
      const { body } = await getJson(instance.baseUrl, "/api/products");
      const products = body as readonly { sku: string; purchasable: boolean }[];

      const purchasableSkus = products
        .filter((product) => product.purchasable)
        .map((product) => product.sku)
        .sort();
      const expectedPurchasable = EXPECTED_CATALOG.filter((product) => product.purchasable)
        .map((product) => product.sku)
        .sort();

      expect(purchasableSkus, "the purchasable set — the buy control's gate").toEqual(expectedPurchasable);
      expect(purchasableSkus.length).toBe(3);

      //   select count(*)::int from products where purchasable = true;
      const dbCount = await db.pool.query<{ n: number }>(
        `select count(*)::int as n from products where purchasable = true`,
      );
      expect(dbCount.rows[0]?.n, "database agrees: exactly three purchasable products").toBe(3);
    });
  });

  describe("§2.2 — starting a purchase", () => {
    it(
      "buying the purchasable product creates an order carrying exactly what the order page needs: " +
        "the item's name, the amount to pay, and an awaiting-payment status (§2.2 AC1/AC2)",
      async () => {
        const orderIds: string[] = [];
        try {
          const created = await createOrder(instance.baseUrl, PURCHASABLE_SKU);
          orderIds.push(created.id);

          expect(created.sku).toBe(PURCHASABLE_SKU);
          expect(created.status, "a newly created order is awaiting payment").toBe(OrderStatus.Created);
          expect(created.currency).toBe("RUB");

          const catalogueEntry = EXPECTED_CATALOG.find((product) => product.sku === PURCHASABLE_SKU);
          if (catalogueEntry === undefined) {
            throw new Error("test setup: PURCHASABLE_SKU is not in EXPECTED_CATALOG");
          }
          expect(created.amount_minor, "the amount to pay, priced from the catalogue").toBe(
            catalogueEntry.priceRub * MINOR_UNITS_PER_ROUBLE,
          );

          //   select sku, amount_minor, currency, status from orders where id = $1;
          const dbRow = await db.pool.query<{
            sku: string;
            amount_minor: number;
            currency: string;
            status: string;
          }>(`select sku, amount_minor, currency, status from orders where id = $1`, [created.id]);
          expect(dbRow.rowCount, "exactly one order row").toBe(1);
          expect(dbRow.rows[0]?.sku, "API sku matches DB row").toBe(created.sku);
          expect(dbRow.rows[0]?.amount_minor, "API amount matches DB row").toBe(created.amount_minor);
          expect(dbRow.rows[0]?.status, "DB status matches the API's `created`").toBe(OrderStatus.Created);

          // §2.2 AC1: the id this returned is exactly what an order page is
          // built from — GET /api/orders/:id must answer for it.
          const view = await getOrder(instance.baseUrl, created.id);
          expect(view.product_name, "the item's name, on the order page (§2.2 AC2)").toBe(catalogueEntry.name);
          expect(view.amount_minor).toBe(created.amount_minor);
          expect(view.status).toBe(OrderStatus.Created);
          expect(view.code).toBeNull();
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );

    it(
      "an order cannot be created for a sku the shop will not sell — neither an unknown one " +
        "nor one that is merely on display (negative, §2.2/§2.1 AC3)",
      async () => {
        const unknownSku = "SKU-DOES-NOT-EXIST-ABC123";
        const displayOnlySku = "STEAM-TOPUP-500"; // type "topup" — purchasable:false in the seeded catalogue

        for (const sku of [unknownSku, displayOnlySku]) {
          const { status, body } = await postJson(instance.baseUrl, "/api/orders", { sku });
          expect(status, `POST /api/orders {sku:"${sku}"}`).toBe(422);
          expect((body as Record<string, unknown>)["statusCode"]).toBe(422);
        }

        //   select count(*)::int from orders where sku = ANY($1::text[]);
        const dbCount = await db.pool.query<{ n: number }>(
          `select count(*)::int as n from orders where sku = ANY($1::text[])`,
          [[unknownSku, displayOnlySku]],
        );
        expect(dbCount.rows[0]?.n, "neither rejected sku produced an order row").toBe(0);
      },
    );

    it("a malformed create-order body is rejected outright, and nothing is created (negative)", async () => {
      const before = await db.pool.query<{ n: number }>(`select count(*)::int as n from orders`);

      const malformedBodies: readonly unknown[] = [{}, { sku: "" }, { sku: 123 }, { notSku: "KEY-CS2-PRIME" }];
      for (const body of malformedBodies) {
        const { status } = await postJson(instance.baseUrl, "/api/orders", body);
        expect(status, `POST /api/orders ${JSON.stringify(body)}`).toBe(400);
      }

      //   select count(*)::int from orders;
      const after = await db.pool.query<{ n: number }>(`select count(*)::int as n from orders`);
      expect(after.rows[0]?.n, "orders table row count is unchanged").toBe(before.rows[0]?.n);
    });
  });

  describe("§2.3 — paying for an order", () => {
    it("choosing the successful payment control moves the order out of awaiting-payment immediately (§2.3 AC1)", async () => {
      const orderIds: string[] = [];
      try {
        const created = await createOrder(instance.baseUrl, PURCHASABLE_SKU);
        orderIds.push(created.id);

        await payOrder(instance.baseUrl, created.id, "success");

        // In this phase the whole webhook chain runs inline, inside the
        // payment call itself (technical-considerations §2.5; Change Log,
        // 2026-09-07): by the time payOrder's response lands the order has
        // already moved off `created`. That is the always-true, non-flaky
        // proxy for "shows that the order is being processed" this suite
        // asserts — the specific intermediate states (`paid`, `delivering`)
        // are real but, per the Change Log, not reliably observable by a
        // poller in this version, and this test does not pretend otherwise.
        const view = await getOrder(instance.baseUrl, created.id);
        expect(view.status, "the order left `created` after a successful payment").not.toBe(OrderStatus.Created);
      } finally {
        await cleanupTestOrders(db, orderIds);
      }
    });

    it("choosing the failing payment control settles the order as failed, with no key ever bound (§2.3 AC2)", async () => {
      const orderIds: string[] = [];
      try {
        const created = await createOrder(instance.baseUrl, PURCHASABLE_SKU);
        orderIds.push(created.id);

        await payOrder(instance.baseUrl, created.id, "failure");
        const settled = await waitUntilSettled(instance.baseUrl, created.id);
        expect(settled.status).toBe(OrderStatus.PaymentFailed);
        expect(settled.code, "no key is shown on a failed payment").toBeNull();

        //   select status from orders where id = $1;
        const dbOrder = await db.pool.query<{ status: string }>(`select status from orders where id = $1`, [
          created.id,
        ]);
        expect(dbOrder.rows[0]?.status).toBe(OrderStatus.PaymentFailed);

        //   select count(*)::int from deliveries where order_id = $1;
        const dbDeliveries = await db.pool.query<{ n: number }>(
          `select count(*)::int as n from deliveries where order_id = $1`,
          [created.id],
        );
        expect(dbDeliveries.rows[0]?.n, "no delivery row exists for a failed order").toBe(0);
      } finally {
        await cleanupTestOrders(db, orderIds);
      }
    });

    it(
      "once payment has failed, a further payment attempt changes nothing — the controls the page " +
        "would have offered again could not have worked, and neither does calling the endpoint directly " +
        "(§2.3 AC3, negative)",
      async () => {
        const orderIds: string[] = [];
        try {
          const created = await createOrder(instance.baseUrl, PURCHASABLE_SKU);
          orderIds.push(created.id);
          await payOrder(instance.baseUrl, created.id, "failure");
          const failed = await waitUntilSettled(instance.baseUrl, created.id);
          expect(failed.status).toBe(OrderStatus.PaymentFailed);

          // The order page renders no pay controls once failed
          // (features/simulate-payment/ui/payment-controls.ts — a rendering
          // courtesy, documented there as such and not the guarantee). What
          // actually holds the line is invariant I9: `markPaid`'s guard names
          // only `created` as a permitted source state. This calls the same
          // endpoint the hidden button would have called, directly, to prove
          // the guarantee rather than the picture of it.
          const ack = await payOrder(instance.baseUrl, created.id, "success");
          expect(ack.webhook_outcome, "the second call is a fresh event (a new event_id), not a replay").toBe(
            "stored",
          );

          await delay(200); // headroom for any (incorrect) processing to have happened
          const after = await getOrder(instance.baseUrl, created.id);
          expect(after.status, "still payment_failed — I9 refused the second attempt").toBe(
            OrderStatus.PaymentFailed,
          );
          expect(after.code).toBeNull();

          //   select count(*)::int from deliveries where order_id = $1;
          const dbDeliveries = await db.pool.query<{ n: number }>(
            `select count(*)::int as n from deliveries where order_id = $1`,
            [created.id],
          );
          expect(dbDeliveries.rows[0]?.n, "the second payment issued no key").toBe(0);

          //   select count(*)::int from issuance_attempts where order_id = $1;
          const dbAttempts = await db.pool.query<{ n: number }>(
            `select count(*)::int as n from issuance_attempts where order_id = $1`,
            [created.id],
          );
          expect(dbAttempts.rows[0]?.n, "issuance was never entered for this order").toBe(0);
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );

    it("a malformed payment-simulation body is rejected outright (negative)", async () => {
      const fakeOrderId = "ord_does-not-matter-for-this-check";
      const malformedBodies: readonly unknown[] = [{}, { outcome: "maybe" }, { outcome: "" }, { outcome: 1 }];
      for (const body of malformedBodies) {
        const { status } = await postJson(instance.baseUrl, `/api/payments/${fakeOrderId}/simulate`, body);
        expect(status, `POST /api/payments/.../simulate ${JSON.stringify(body)}`).toBe(400);
      }
    });
  });

  describe("§2.4 — receiving the key", () => {
    it(
      "a paid order reaches delivered with a key bound in the database automatically, with nothing " +
        "beyond the one payment call — and reading the same polled endpoint again is what shows the " +
        "change (§2.4 AC1/AC2)",
      async () => {
        const orderIds: string[] = [];
        try {
          const created = await createOrder(instance.baseUrl, PURCHASABLE_SKU);
          orderIds.push(created.id);

          const firstRead = await getOrder(instance.baseUrl, created.id);
          expect(firstRead.status, "before payment: awaiting payment").toBe(OrderStatus.Created);

          await payOrder(instance.baseUrl, created.id, "success");

          // No further action beyond the one call above. Reading the very
          // same endpoint again — no new order, no reload of anything but a
          // GET — is the mechanism apps/web/src/pages/order/model/poll.ts
          // uses; this is that mechanism, exercised directly.
          const settled = await waitUntilSettled(instance.baseUrl, created.id);
          expect(settled.status, "settles to delivered with nobody doing anything further").toBe(
            OrderStatus.Delivered,
          );
          if (settled.status !== OrderStatus.Delivered) return;
          expect(settled.code, "a key is present").toBeTruthy();

          //   select order_id, code from deliveries where order_id = $1;
          const dbDelivery = await db.pool.query<{ order_id: string; code: string }>(
            `select order_id, code from deliveries where order_id = $1`,
            [created.id],
          );
          expect(dbDelivery.rowCount, "exactly one delivery row").toBe(1);
          expect(dbDelivery.rows[0]?.code, "the API's key is the database's key").toBe(settled.code);

          //   select status from orders where id = $1;
          const dbOrder = await db.pool.query<{ status: string }>(`select status from orders where id = $1`, [
            created.id,
          ]);
          expect(dbOrder.rows[0]?.status).toBe(OrderStatus.Delivered);
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );

    it(
      "the same delivered order, read again immediately and read again after a delay, shows the " +
        "identical key both times (§2.4 AC3/AC4)",
      async () => {
        const orderIds: string[] = [];
        try {
          const created = await createOrder(instance.baseUrl, PURCHASABLE_SKU);
          orderIds.push(created.id);
          await payOrder(instance.baseUrl, created.id, "success");
          const first = await waitUntilSettled(instance.baseUrl, created.id);
          expect(first.status).toBe(OrderStatus.Delivered);
          if (first.status !== OrderStatus.Delivered) return;

          // "Reload" — an independent second read of the same address.
          const reload = await getOrder(instance.baseUrl, created.id);
          expect(reload.status).toBe(OrderStatus.Delivered);
          if (reload.status !== OrderStatus.Delivered) return;
          expect(reload.code, "reload: the same key (§2.4 AC3)").toBe(first.code);

          // "Much later" — delivered is terminal (invariant I9;
          // order-transitions.ts's compile-time proof that no transition may
          // leave a terminal state), so nothing in this system can move the
          // order again. Nothing about that guarantee is time-bound, so an
          // immediate read is already dispositive; the delay below is a
          // deliberate, if modest, gesture at the literal wording of §2.4's
          // last criterion rather than something the assertion depends on.
          await delay(500);
          const later = await getOrder(instance.baseUrl, created.id);
          expect(later.status).toBe(OrderStatus.Delivered);
          if (later.status !== OrderStatus.Delivered) return;
          expect(later.code, "much later: still the same key (§2.4 AC4)").toBe(first.code);

          //   select code from deliveries where order_id = $1;
          const dbDelivery = await db.pool.query<{ code: string }>(
            `select code from deliveries where order_id = $1`,
            [created.id],
          );
          expect(dbDelivery.rows[0]?.code, "the database agrees with every read").toBe(first.code);
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );
  });

  // §2.5 — "a key is never given away twice" — proven in
  // ../concurrency/key-claim-race.test.ts (both its `it` blocks) and
  // deliberately not re-tested here. See this file's header.

  describe("§2.6 — finding an order again", () => {
    it("an order id that does not exist returns a clear not-found response instead of a blank or broken page (§2.6 AC2, negative)", async () => {
      const { status, body } = await getJson(
        instance.baseUrl,
        "/api/orders/ord_does-not-exist-01ARZ3NDEKTSV4RRFFQ69G5FAV",
      );
      expect(status).toBe(404);
      const record = body as Record<string, unknown>;
      expect(record["statusCode"], "a real error body, not a blank one").toBe(404);
      expect(typeof record["message"], "a real message, not a blank body").toBe("string");
    });

    it(
      "an order id that is syntactically odd — unicode, path-like segments, excessive length — still " +
        "yields a clean not-found rather than an error (§2.6 AC2, boundary)",
      async () => {
        const weirdIds = [
          "ord_нет такого заказа",
          "ord_../../etc/passwd",
          `ord_${"x".repeat(500)}`,
          "ord_%00null",
        ];
        for (const id of weirdIds) {
          const { status, body } = await getJson(instance.baseUrl, `/api/orders/${encodeURIComponent(id)}`);
          expect(status, `GET /api/orders/${id}`).toBe(404);
          expect((body as Record<string, unknown>)["statusCode"]).toBe(404);
        }
      },
    );
  });

  // §2.6 AC1 ("current state, and the key once delivered") is exercised by
  // the §2.2 test above for a not-yet-paid order and by the §2.4 tests above
  // for a delivered one — GET /api/orders/:id is the one endpoint both read,
  // so a separate "found again" test would repeat those calls verbatim.

  // §2.7 — the walkthrough (`docs/walkthrough/phase-1.md`) is a document, not
  // runtime behaviour. See this file's header for how it was verified.

  // §2.8 AC1 (every shopper-facing string is Russian) is a fact about static
  // string literals in apps/web with no branch to exercise — verified by
  // source review, listed in this file's header. §2.8 AC2 (names match the
  // catalogue verbatim) is exercised by the §2.1 catalogue test above.
});
