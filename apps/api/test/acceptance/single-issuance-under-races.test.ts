// @layer: integration
// @spec: 002-single-issuance-under-races
/**
 * The feature-level acceptance suite for
 * `context/spec/002-single-issuance-under-races/functional-spec.md` — every
 * acceptance criterion in §2.1 through §2.4 and §2.8 that is testable without
 * a browser or a multi-process harness, verified against the whole assembled
 * feature (Slices 1-7) rather than against any one slice. This is Slice 8's
 * own task, mirroring `./purchase-and-key-delivery.test.ts`'s role for spec
 * 001: the seven implementation slices are done and each was verified on its
 * own; this file proves the seams between them hold for a shopper walking the
 * whole path, and for a payment provider that repeats itself.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE, AND WHERE IT ACTUALLY LIVES
 * ---------------------------------------------------------------------------
 *   - **§2.1's first criterion — a genuine double-click.** technical-
 *     considerations §3's risk table is explicit: an idempotency key minted
 *     inside the click handler passes every scripted test while a real
 *     double-click still buys two copies, because two clicks mint two keys.
 *     No request this file can send distinguishes "one key sent twice" from
 *     "two keys sent once" — both are two identical-looking HTTP calls from
 *     here. That criterion was verified the only way it can be: a real
 *     browser, a real double-click, the database read afterwards (Slice 1
 *     verification, `tasks.md`). The test below for this criterion proves the
 *     *server-side* half of the mechanism (the UNIQUE index converges
 *     concurrent requests that already share one key) and says so in its own
 *     comment, rather than implying browser-equivalent coverage it does not
 *     have.
 *   - **§2.2's second criterion — fifty simultaneous reports.** Needs
 *     genuinely overlapping Postgres connections, which one process's `max: 1`
 *     pool cannot produce (`architecture.md` §7). Covered in
 *     `../concurrency/fifty-webhooks-one-order.test.ts`, which reuses this
 *     suite's own harness across four real processes.
 *   - **§2.5's first criterion — the page showing an intermediate state.**
 *     `docs/walkthrough/phase-2.md`'s "What is not finished" section records
 *     this as resting on a timing window nothing in the source structurally
 *     defends: the 25-65 ms mark between "answered" and "delivered" is not
 *     something a polling test can reliably land inside without either
 *     flaking on a slow CI box or asserting nothing at all. It was verified
 *     the way §2.4's spec-001 counterpart was — a real browser, nine paid
 *     orders, an intermediate label observed 9 times out of 9 (Slice 4
 *     verification). What this file asserts instead is the structural
 *     precondition that *makes* it possible: §2.4's test below proves the
 *     webhook acknowledges before the order settles, which is the entire
 *     reason there is a window for a poll to land in at all.
 *   - **§2.6, the adversarial checks themselves.** Already exist, already
 *     verified (Slice 6) — `pnpm race`, `scripts/race/`, and this same
 *     `../concurrency/support/` harness. Rebuilding them here would test the
 *     same mechanism a second time under a different name. Confirmed present
 *     in the coverage table this task reports rather than re-proven.
 *   - **§2.7, the walkthrough.** `docs/walkthrough/phase-2.md` is a document,
 *     not runtime behaviour — same reasoning `./purchase-and-key-delivery.
 *     test.ts`'s header gives for §2.7 of spec 001.
 *   - **§2.4's third criterion — a `5xx` when the shop genuinely could not
 *     record a report.** The one path that produces it is the webhook insert
 *     itself throwing (`payment-events.service.ts`'s `catch`, "the one case
 *     that is allowed to fail") — reachable only by a real database failure.
 *     Nothing in Phase 2's source exposes a way to inject one without editing
 *     production code, which this role does not do. Named as a gap in this
 *     task's report rather than faked with a test that always passes.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE INSTANCE, WITH THE TEST AFFORDANCE TURNED ON
 * ---------------------------------------------------------------------------
 * Same reasoning as `./purchase-and-key-delivery.test.ts`'s header: nothing
 * below needs two requests to genuinely overlap inside Postgres — every
 * criterion here is about what one shopper (or one payment provider) sees on
 * one path, not about proving a claim is race-safe under fan-out. That proof
 * lives in `../concurrency/` and in `pnpm race`.
 *
 * `ALLOW_CLIENT_SUPPLIED_ORDER_ID` is turned on for this one instance, which
 * `../concurrency/support/api-instance.ts` already supports as an explicit
 * opt-in (`allowClientSuppliedOrderId`). §2.3's out-of-order scenario needs a
 * caller who can name an order id *before* the order exists — precisely the
 * test affordance `architecture.md` §9 records and `scripts/race/before-
 * order.ts` already uses, for the identical reason. No other test in this
 * file sends a body's `id` field, so turning the flag on changes nothing for
 * them. The genuine cross-process proof that this mechanism is not one
 * process's memory is `pnpm race before-order`; this suite proves the
 * mechanism is functionally correct at the acceptance layer.
 *
 * ---------------------------------------------------------------------------
 * ASSERTIONS QUERY THE DATABASE DIRECTLY
 * ---------------------------------------------------------------------------
 * Per `context/product/architecture.md` §7 and `./purchase-and-key-delivery.
 * test.ts`'s own precedent (the `DrizzleQueryError` defect that returned
 * `500` to nineteen of twenty callers while the database stayed correct, and
 * the delivered-key gate defect that returned a consistent `null` while the
 * key sat committed): every test below that produces a stored event, a
 * delivered order or an unchanged one reads the relevant row back with raw
 * SQL on `db.pool`, quoted in a comment beside the call.
 *
 * ---------------------------------------------------------------------------
 * RED VALIDATION
 * ---------------------------------------------------------------------------
 * The implementation this file tests already exists (Slices 1-7), so, as
 * `../concurrency/key-claim-race.test.ts`'s header puts it for the same
 * situation: "RED" here means a temporary, targeted inversion of what a test
 * asserts — never a change to production source — run to see the test fail
 * for the stated reason, then reverted. That process, the exact inversions
 * made and the exact failure output are reported in this task's report rather
 * than kept in this file.
 *
 * Run it: `pnpm test` from the repository root (this file has no dedicated
 * `pnpm test:*` alias of its own, unlike spec 001's suite — see this task's
 * report for why one was not added).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OrderStatus } from "@game-shop/contracts";
import type { DatabaseClient } from "@game-shop/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CreatedOrder, ExistingOrder, OrderView } from "../../src/orders/orders.types.js";
import type { PaymentWebhookAck } from "../../src/payments/payment-webhook.types.js";
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
 * Clear of `../concurrency/key-claim-race.test.ts` (4101-4104), `./purchase-
 * and-key-delivery.test.ts` (4201), `../concurrency/order-lock-race.test.ts`
 * (4401-4402), `../concurrency/fifty-webhooks-one-order.test.ts` (4501-4504),
 * `pnpm race`'s default range (4201-4204, `.env.example`), `API_PORT` (3000)
 * and `WEB_PORT` (5173).
 */
const PORT = 4301;

function delay(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

interface RawResponse {
  readonly status: number;
  readonly body: unknown;
  readonly elapsedMs: number;
}

async function postJson(baseUrl: string, path: string, body: unknown, headers?: Record<string, string>): Promise<RawResponse> {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const elapsedMs = Date.now() - startedAt;
  return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as unknown), elapsedMs };
}

async function getJson(baseUrl: string, path: string): Promise<RawResponse> {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  const elapsedMs = Date.now() - startedAt;
  return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as unknown), elapsedMs };
}

interface CreateOrderOptions {
  readonly idempotencyKey?: string;
  /** Requires the instance to be started with `allowClientSuppliedOrderId: true`. */
  readonly id?: string;
}

async function createOrder(baseUrl: string, sku: string, options: CreateOrderOptions = {}): Promise<RawResponse> {
  const headers = options.idempotencyKey === undefined ? undefined : { "Idempotency-Key": options.idempotencyKey };
  const body: Record<string, unknown> = { sku };
  if (options.id !== undefined) body["id"] = options.id;
  return postJson(baseUrl, "/api/orders", body, headers);
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
  eventId?: string,
): Promise<SimulatedPaymentAck> {
  const body: Record<string, unknown> = { outcome };
  if (eventId !== undefined) body["event_id"] = eventId;
  const { status, body: responseBody } = await postJson(baseUrl, `/api/payments/${encodeURIComponent(orderId)}/simulate`, body);
  if (status !== 200) {
    throw new Error(
      `POST /api/payments/${orderId}/simulate ${JSON.stringify(body)} -> ${String(status)}: ${JSON.stringify(responseBody)}`,
    );
  }
  return responseBody as SimulatedPaymentAck;
}

interface RawWebhookEvent {
  readonly eventId: string;
  readonly orderId: string;
  readonly status: string;
  readonly amount?: number;
  readonly currency?: string;
}

/**
 * `POST /api/webhooks/payment`, bypassing the payment simulator — the same
 * direct route `../concurrency/order-lock-race.test.ts` and
 * `scripts/race/before-order.ts` use, needed here because the simulator
 * cannot address an order that does not exist yet (§2.3), and cannot send a
 * status it does not recognise (§2.4 criterion 2's proxy below).
 */
async function postRawWebhookEvent(baseUrl: string, event: RawWebhookEvent): Promise<RawResponse & { body: PaymentWebhookAck | unknown }> {
  return postJson(baseUrl, "/api/webhooks/payment", {
    event_id: event.eventId,
    order_id: event.orderId,
    status: event.status,
    amount: event.amount ?? 5,
    currency: event.currency ?? "RUB",
    created_at: new Date().toISOString(),
  });
}

const SETTLE_POLL_INTERVAL_MS = 25;
const SETTLE_TIMEOUT_MS = 10_000;

/**
 * Poll `GET /api/orders/:id` until the order leaves the in-flight states —
 * the exact mechanism `apps/web/src/pages/order/model/poll.ts` uses, run here
 * directly rather than through a browser. This is also processing trigger 3:
 * every call this makes is itself an opportunistic drain of that order's
 * pending events (`OrdersService.findOrder`), which is why §2.3's test below
 * needs no admin sweep to settle.
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

describe("functional spec 002-single-issuance-under-races — feature acceptance", () => {
  let instance: RunningInstance;
  let db: DatabaseClient;

  beforeAll(async () => {
    const databaseUrl = process.env["DATABASE_URL"];
    if (databaseUrl === undefined || databaseUrl === "") {
      throw new Error(
        "DATABASE_URL is not set. Run this suite through `pnpm test` from the " +
          "repository root, which loads the local environment first (scripts/with-env.ts).",
      );
    }

    db = createTestDatabaseClient("acceptance-002-assert");
    assertBaseline(await readBaselineCounts(db), "before");

    // Rebuilding from current source is what makes RED validation meaningful
    // — see ../concurrency/support/api-instance.ts's header.
    console.log("single-issuance-under-races: building @game-shop/db, @game-shop/contracts and @game-shop/api...");
    execFileSync("pnpm", ["run", "build:packages"], { cwd: REPO_ROOT, stdio: "inherit" });
    execFileSync("pnpm", ["--filter", "@game-shop/api", "run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });

    instance = await startApiInstance({
      apiRoot: API_ROOT,
      port: PORT,
      databaseUrl,
      // See this file's header, "WHY ONE INSTANCE, WITH THE TEST AFFORDANCE
      // TURNED ON" — needed only by §2.3's out-of-order test below.
      allowClientSuppliedOrderId: true,
    });
    console.log(`single-issuance-under-races: apps/api healthy on port ${String(instance.port)} (pid ${String(instance.pid)})`);
  }, 120_000);

  afterAll(async () => {
    await stopAllApiInstances([instance]);

    if (db !== undefined) {
      assertBaseline(await readBaselineCounts(db), "after");
      await db.close();
    }
  }, 60_000);

  describe("§2.1 — buying once, however many times I click", () => {
    it(
      "several concurrent purchase attempts sharing one Idempotency-Key converge on a single order " +
        "(§2.1 criteria 1 & 3, server-side proxy — see this file's header for the double-click limitation)",
      async () => {
        const orderIds: string[] = [];
        try {
          const sharedKey = `test-002-shared-${randomUUID()}`;
          const ATTEMPTS = 8;

          const results = await Promise.all(
            Array.from({ length: ATTEMPTS }, async () => createOrder(instance.baseUrl, PURCHASABLE_SKU, { idempotencyKey: sharedKey })),
          );

          for (const result of results) {
            expect([200, 201], `POST /api/orders with the shared key -> ${String(result.status)}`).toContain(result.status);
          }

          const ids = new Set(results.map((result) => (result.body as { id?: string }).id));
          expect(ids.size, `distinct order ids across ${String(ATTEMPTS)} concurrent attempts sharing one key`).toBe(1);
          const [wonId] = ids;
          if (wonId !== undefined) orderIds.push(wonId);

          const createdCount = results.filter((result) => result.status === 201).length;
          expect(createdCount, "exactly one of the concurrent attempts created the order (201); the rest found it (200)").toBe(1);

          //   select id from orders where client_request_id = $1;
          const dbRows = await db.pool.query<{ id: string }>(`select id from orders where client_request_id = $1`, [sharedKey]);
          expect(dbRows.rowCount, "exactly one orders row for this Idempotency-Key").toBe(1);
          expect(dbRows.rows[0]?.id, "the database agrees on which order won").toBe(wonId);
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );

    it("a repeat of an already-used Idempotency-Key is answered with the SAME order, 200 not 201 (§2.1 criteria 2 & 4)", async () => {
      const orderIds: string[] = [];
      try {
        const key = `test-002-retry-${randomUUID()}`;

        const first = await createOrder(instance.baseUrl, PURCHASABLE_SKU, { idempotencyKey: key });
        expect(first.status, "first use of a fresh key: 201").toBe(201);
        const created = first.body as CreatedOrder;
        orderIds.push(created.id);

        // §2.1 criterion 4's "click appears to fail, click again" is the same
        // mechanism observed a second time: the client cannot distinguish "my
        // first request never reached the shop" from "it reached the shop and
        // the response was lost", so both are simulated identically here — a
        // second call with the identical key.
        const retry = await createOrder(instance.baseUrl, PURCHASABLE_SKU, { idempotencyKey: key });
        expect(retry.status, "repeat of a used key: 200, not 201 — nothing was created this time").toBe(200);
        const existing = retry.body as ExistingOrder;
        expect(existing.id, "the repeat is shown the SAME order").toBe(created.id);

        //   select count(*)::int from orders where client_request_id = $1;
        const dbCount = await db.pool.query<{ n: number }>(`select count(*)::int as n from orders where client_request_id = $1`, [key]);
        expect(dbCount.rows[0]?.n, "still exactly one orders row for this key").toBe(1);
      } finally {
        await cleanupTestOrders(db, orderIds);
      }
    });

    it(
      "the repeated-attempt response carries the identical field set as the original — no 'duplicate' " +
        "or 'retried' notice, so the page reads exactly as if the first click had worked (§2.1 criterion 6)",
      async () => {
        const orderIds: string[] = [];
        try {
          const key = `test-002-silent-${randomUUID()}`;

          const first = await createOrder(instance.baseUrl, PURCHASABLE_SKU, { idempotencyKey: key });
          const created = first.body as CreatedOrder;
          orderIds.push(created.id);

          const retry = await createOrder(instance.baseUrl, PURCHASABLE_SKU, { idempotencyKey: key });
          const existing = retry.body as ExistingOrder;

          const firstKeys = Object.keys(created).sort();
          const retryKeys = Object.keys(existing).sort();
          expect(retryKeys, "the 200 body has exactly the same fields as the 201 body").toEqual(firstKeys);

          // No field anywhere on the repeat's body names the repetition.
          for (const suspiciousField of ["duplicate", "retried", "already_created", "repeat", "notice"]) {
            expect(Object.keys(existing), `no "${suspiciousField}" field on the repeated response`).not.toContain(
              suspiciousField,
            );
          }

          // Every field but `status` reads identically — same item, same price,
          // same currency, same id — exactly as it would have on a first success.
          expect(existing.id).toBe(created.id);
          expect(existing.sku).toBe(created.sku);
          expect(existing.amount_minor).toBe(created.amount_minor);
          expect(existing.currency).toBe(created.currency);
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );

    it(
      "buying the same item again with a FRESH intent creates a separate second order with its own key " +
        "— repeats do not merge every purchase of one SKU forever (§2.1 criterion 5, the negative complement; " +
        "also covered by `pnpm race create-order` scenario 2, §2.6)",
      async () => {
        const orderIds: string[] = [];
        try {
          const firstKey = `test-002-fresh-a-${randomUUID()}`;
          const secondKey = `test-002-fresh-b-${randomUUID()}`;

          const first = (await createOrder(instance.baseUrl, PURCHASABLE_SKU, { idempotencyKey: firstKey })).body as CreatedOrder;
          orderIds.push(first.id);
          const second = (await createOrder(instance.baseUrl, PURCHASABLE_SKU, { idempotencyKey: secondKey })).body as CreatedOrder;
          orderIds.push(second.id);

          expect(second.id, "a fresh intent for the same SKU is a DIFFERENT order").not.toBe(first.id);

          await payOrder(instance.baseUrl, first.id, "success");
          await payOrder(instance.baseUrl, second.id, "success");
          const firstSettled = await waitUntilSettled(instance.baseUrl, first.id);
          const secondSettled = await waitUntilSettled(instance.baseUrl, second.id);
          expect(firstSettled.status).toBe(OrderStatus.Delivered);
          expect(secondSettled.status).toBe(OrderStatus.Delivered);
          if (firstSettled.status !== OrderStatus.Delivered || secondSettled.status !== OrderStatus.Delivered) return;

          expect(secondSettled.code, "two separate purchases end up with two DIFFERENT keys").not.toBe(firstSettled.code);

          //   select count(*)::int from deliveries where order_id = ANY($1::text[]);
          const dbDeliveries = await db.pool.query<{ n: number }>(
            `select count(*)::int as n from deliveries where order_id = ANY($1::text[])`,
            [orderIds],
          );
          expect(dbDeliveries.rows[0]?.n, "two distinct delivery rows, not one shared between the two orders").toBe(2);
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );
  });

  describe("§2.2 — receiving exactly one key, however many times my payment is reported", () => {
    it(
      "a payment already delivered, reported again with the SAME event_id, leaves the order and its key " +
        "unchanged (§2.2 criterion 1)",
      async () => {
        const orderIds: string[] = [];
        try {
          const created = (await createOrder(instance.baseUrl, PURCHASABLE_SKU)).body as CreatedOrder;
          orderIds.push(created.id);

          const firstAck = await payOrder(instance.baseUrl, created.id, "success");
          const settled = await waitUntilSettled(instance.baseUrl, created.id);
          expect(settled.status).toBe(OrderStatus.Delivered);
          if (settled.status !== OrderStatus.Delivered) return;

          const redeliveryAck = await payOrder(instance.baseUrl, created.id, "success", firstAck.event_id);
          expect(redeliveryAck.webhook_outcome, "the redelivery is recognised as a duplicate, not a fresh event").toBe(
            "duplicate",
          );

          await delay(200); // headroom for any (incorrect) re-processing to have happened
          const after = await getOrder(instance.baseUrl, created.id);
          expect(after.status, "still delivered — unchanged by the redelivery").toBe(OrderStatus.Delivered);
          if (after.status !== OrderStatus.Delivered) return;
          expect(after.code, "the shopper still holds exactly the same key").toBe(settled.code);

          //   select count(*)::int from payment_events where order_id = $1;
          const dbEvents = await db.pool.query<{ n: number }>(`select count(*)::int as n from payment_events where order_id = $1`, [
            created.id,
          ]);
          expect(dbEvents.rows[0]?.n, "one event_id row, not two — the redelivery wrote nothing new").toBe(1);

          //   select count(*)::int from deliveries where order_id = $1;
          const dbDeliveries = await db.pool.query<{ n: number }>(`select count(*)::int as n from deliveries where order_id = $1`, [
            created.id,
          ]);
          expect(dbDeliveries.rows[0]?.n, "still exactly one delivery row").toBe(1);
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );

    it(
      "while a payment is being reported and processed, every read of the order returns a real answer — " +
        "never an error, and never two different keys (§2.2 criterion 3)",
      async () => {
        const orderIds: string[] = [];
        try {
          const created = (await createOrder(instance.baseUrl, PURCHASABLE_SKU)).body as CreatedOrder;
          orderIds.push(created.id);

          const READS = 12;
          const [, ...reads] = await Promise.all([
            payOrder(instance.baseUrl, created.id, "success"),
            ...Array.from({ length: READS }, async () => getOrder(instance.baseUrl, created.id)),
          ]);

          // Every read succeeded (getOrder throws on a non-200) and returned one
          // of the lifecycle's real statuses.
          const codesSeen = new Set(reads.filter((view) => view.status === OrderStatus.Delivered).map((view) => view.code));
          expect(codesSeen.size, `codes seen across ${String(READS)} concurrent reads while the order settled`).toBeLessThanOrEqual(1);

          const settled = await waitUntilSettled(instance.baseUrl, created.id);
          expect(settled.status).toBe(OrderStatus.Delivered);
          if (settled.status !== OrderStatus.Delivered) return;

          if (codesSeen.size === 1) {
            const [seenCode] = codesSeen;
            expect(seenCode, "any code glimpsed mid-flight matches the final one").toBe(settled.code);
          }
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );
  });

  describe("§2.3 — my purchase completes even when news arrives out of order", () => {
    it(
      "a payment reported before its order is recorded is applied once the order is created, with no " +
        "further shopper action, and the report is not discarded in the meantime (§2.3 criteria 1 & 2)",
      async () => {
        const orderId = `ord_test_002_beforeorder_${randomUUID()}`;
        const eventId = `evt_test_002_beforeorder_${orderId}`;
        const orderIds = [orderId];

        try {
          // Step 1 — the report arrives first. No order named `orderId` exists
          // anywhere yet.
          const webhookResult = await postRawWebhookEvent(instance.baseUrl, { eventId, orderId, status: "paid" });
          expect(webhookResult.status, "the early report is accepted (2xx), never a 5xx").toBeLessThan(300);
          expect((webhookResult.body as PaymentWebhookAck).outcome, "stored as first sight, not discarded").toBe(
            "stored",
          );

          //   select order_id, processed_at from payment_events where event_id = $1;
          const pendingRow = await db.pool.query<{ order_id: string; processed_at: Date | null }>(
            `select order_id, processed_at from payment_events where event_id = $1`,
            [eventId],
          );
          expect(pendingRow.rowCount, "the report is on record — one payment_events row").toBe(1);
          expect(pendingRow.rows[0]?.order_id, "it names the order it is about, which does not exist yet").toBe(orderId);
          expect(pendingRow.rows[0]?.processed_at, "left pending, not silently applied to nothing").toBeNull();

          const beforeCreate = await getJson(instance.baseUrl, `/api/orders/${encodeURIComponent(orderId)}`);
          expect(beforeCreate.status, "the order genuinely does not exist yet").toBe(404);

          // Step 2 — the order is recorded, with the SAME id the early report
          // named (the test affordance this instance was started with — see
          // this file's header).
          const createResult = await createOrder(instance.baseUrl, PURCHASABLE_SKU, { id: orderId });
          expect(createResult.status, "creating the pre-chosen order id").toBe(201);
          expect((createResult.body as CreatedOrder).id).toBe(orderId);

          // Step 3 — "without taking any further action" beyond watching the
          // order page, which is exactly what waitUntilSettled's poll is.
          const settled = await waitUntilSettled(instance.baseUrl, orderId);
          expect(settled.status, "the payment was applied and the order settled to delivered on its own").toBe(
            OrderStatus.Delivered,
          );
          if (settled.status !== OrderStatus.Delivered) return;
          expect(settled.code, "the shopper received their key with no further action").toBeTruthy();

          //   select order_id, code from deliveries where order_id = $1;
          const dbDelivery = await db.pool.query<{ code: string }>(`select code from deliveries where order_id = $1`, [orderId]);
          expect(dbDelivery.rowCount, "exactly one delivery row").toBe(1);
          expect(dbDelivery.rows[0]?.code).toBe(settled.code);

          //   select processed_at from payment_events where event_id = $1;
          const settledEvent = await db.pool.query<{ processed_at: Date | null }>(
            `select processed_at from payment_events where event_id = $1`,
            [eventId],
          );
          expect(settledEvent.rows[0]?.processed_at, "the once-pending report is now settled").not.toBeNull();
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );

    it(
      "a payment reported for an order that never appears stays on record rather than being discarded " +
        "(§2.3 criterion 3)",
      async () => {
        const orderId = `ord_test_002_neverappears_${randomUUID()}`;
        const eventId = `evt_test_002_neverappears_${orderId}`;
        const orderIds = [orderId]; // never actually created — cleanup still targets this id

        try {
          const webhookResult = await postRawWebhookEvent(instance.baseUrl, { eventId, orderId, status: "paid" });
          expect(webhookResult.status, "still accepted, even though this order will never exist").toBeLessThan(300);
          expect((webhookResult.body as PaymentWebhookAck).outcome).toBe("stored");

          // Give any (incorrect) sweep-driven discard a moment to have happened.
          await delay(200);

          //   select order_id, processed_at from payment_events where event_id = $1;
          const row = await db.pool.query<{ order_id: string; processed_at: Date | null }>(
            `select order_id, processed_at from payment_events where event_id = $1`,
            [eventId],
          );
          expect(row.rowCount, "the report is still on record — nothing purges an orphaned event").toBe(1);
          expect(row.rows[0]?.order_id).toBe(orderId);
          expect(row.rows[0]?.processed_at, "still pending: there is no order for it to be applied to").toBeNull();
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );
  });

  describe("§2.4 — the shop takes responsibility the moment it is told", () => {
    it(
      "the webhook acknowledges promptly, and the order settles afterward as separate, later work " +
        "(§2.4 criterion 1 — see this file's header for why a tight millisecond bound is not asserted)",
      async () => {
        const orderIds: string[] = [];
        try {
          const created = (await createOrder(instance.baseUrl, PURCHASABLE_SKU)).body as CreatedOrder;
          orderIds.push(created.id);

          const eventId = `evt_test_002_prompt_${created.id}`;
          const ackResult = await postRawWebhookEvent(instance.baseUrl, { eventId, orderId: created.id, status: "paid" });

          // A generous bound, deliberately: `architecture.md` §7 and this task's
          // brief both warn against a tight millisecond assertion that flakes
          // under CPU load. What this bound catches is a webhook that blocks on
          // the network-bound part of issuance (a supplier round trip) before
          // answering at all — the docs/walkthrough/phase-2-slice-2-answer-then-
          // work.md §1 measurement (72 ms, against a supplier deliberately made
          // to hang) is the authoritative, tighter proof this Vitest layer
          // cannot reproduce without a chaos-injection affordance Phase 2's
          // source does not expose.
          const ACK_BOUND_MS = 1_500;
          expect(ackResult.elapsedMs, `webhook response took ${String(ackResult.elapsedMs)}ms`).toBeLessThan(ACK_BOUND_MS);
          expect((ackResult.body as PaymentWebhookAck).outcome, "the report was accepted for processing").toBe("stored");

          // The settle is separate, later work: it is observed only by polling
          // afterward, never assumed from the ack itself.
          const settled = await waitUntilSettled(instance.baseUrl, created.id);
          expect(settled.status, "the order completes as separate work after the prompt acknowledgement").toBe(
            OrderStatus.Delivered,
          );

          //   select processed_at from payment_events where event_id = $1;
          const dbEvent = await db.pool.query<{ processed_at: Date | null }>(
            `select processed_at from payment_events where event_id = $1`,
            [eventId],
          );
          expect(dbEvent.rows[0]?.processed_at, "the event is durably settled by the time the order is delivered").not.toBeNull();
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );

    it(
      "an event the shop cannot act on further is still accepted with 2xx, never a 5xx that would ask " +
        "the payment service to redeliver it (§2.4 criterion 2, proxy — see this file's header for the " +
        "genuine-processing-failure limitation)",
      async () => {
        const orderIds: string[] = [];
        try {
          const created = (await createOrder(instance.baseUrl, PURCHASABLE_SKU)).body as CreatedOrder;
          orderIds.push(created.id);

          // A status this shop has no lifecycle move for — storable (every NOT
          // NULL column is satisfiable) but not actionable
          // (`PaymentEventProcessor.processStoredEvent`'s `UnknownStatus`
          // outcome). The nearest reachable proxy, in Phase 2, for "something
          // goes wrong while completing that order": the shop accepted the
          // report and could not advance the order with it, and still never
          // asks for a retry.
          const eventId = `evt_test_002_unknownstatus_${created.id}`;
          const result = await postRawWebhookEvent(instance.baseUrl, { eventId, orderId: created.id, status: "refunded" });
          expect(result.status, "an unrecognised status is still a 2xx, not a 5xx asking for redelivery").toBeLessThan(300);
          expect((result.body as PaymentWebhookAck).outcome).toBe("stored");

          // Give the (unawaited) continuation a moment to settle the event.
          await delay(300);

          //   select status, processed_at from payment_events where event_id = $1;
          const dbEvent = await db.pool.query<{ status: string; processed_at: Date | null }>(
            `select status, processed_at from payment_events where event_id = $1`,
            [eventId],
          );
          expect(dbEvent.rowCount, "the unrecognised report is stored verbatim, not rejected").toBe(1);
          expect(dbEvent.rows[0]?.status, "stored exactly as sent, for reconciliation").toBe("refunded");
          expect(dbEvent.rows[0]?.processed_at, "settled — no future drain will learn more about it than this one did").not.toBeNull();

          //   select status from orders where id = $1;
          const dbOrder = await db.pool.query<{ status: string }>(`select status from orders where id = $1`, [created.id]);
          expect(dbOrder.rows[0]?.status, "the order itself is unaffected by a status it has no move for").toBe(
            OrderStatus.Created,
          );
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );

    it("a malformed webhook body — unwritable to the inbox — is rejected outright with 400, not retried (negative)", async () => {
      const malformedBodies: readonly unknown[] = [
        {},
        { event_id: "", order_id: "ord_x", status: "paid", amount: 5, currency: "RUB" },
        { event_id: "evt_x", order_id: "ord_x", status: "paid", amount: "not-a-number", currency: "RUB" },
        { event_id: "evt_x", order_id: "ord_x", status: "paid", amount: Number.NaN, currency: "RUB" },
      ];
      for (const body of malformedBodies) {
        const { status } = await postJson(instance.baseUrl, "/api/webhooks/payment", body);
        expect(status, `POST /api/webhooks/payment ${JSON.stringify(body)}`).toBe(400);
      }

      //   select count(*)::int from payment_events where event_id = ANY($1::text[]);
      const dbCount = await db.pool.query<{ n: number }>(`select count(*)::int as n from payment_events where event_id = ANY($1::text[])`, [
        ["evt_x", ""],
      ]);
      expect(dbCount.rows[0]?.n, "none of the malformed bodies produced a stored event").toBe(0);
    });
  });
});
