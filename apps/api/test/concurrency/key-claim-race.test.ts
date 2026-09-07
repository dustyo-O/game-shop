// @layer: integration
// @spec: 001-purchase-and-key-delivery
// @regression
/**
 * The executable proof of functional spec §2.5, *"a key is never given away
 * twice"* — `context/product/architecture.md` §7 and
 * `context/spec/001-purchase-and-key-delivery/technical-considerations.md` §4,
 * "Concurrency test (Vitest)":
 *
 *   N orders paid in parallel produce N distinct keys, exactly N claimed rows
 *   in supplier_keys, and exactly N rows in deliveries.
 *
 * Run it: `pnpm test:concurrency` from the repository root. It loads the local
 * environment (`scripts/with-env.ts`), then this suite's own `beforeAll`
 * rebuilds `@game-shop/db`, `@game-shop/contracts` and `@game-shop/api` from
 * current source, boots four separate `node dist/main.js` processes against
 * the real local Postgres (`pnpm db:up` first, if it is not already running),
 * fires the parallel purchases, asserts directly against the database, and
 * cleans up every row it wrote so it can be run again immediately — see the
 * completion requirement that this test runs twice in a row with no manual
 * reset.
 *
 * ---------------------------------------------------------------------------
 * WHY FOUR PROCESSES, NOT `Promise.all` INSIDE ONE
 * ---------------------------------------------------------------------------
 * The full argument, and the measurement backing it, is in
 * `./support/api-instance.ts`'s header and in
 * `docs/walkthrough/slice-4-supplier-idempotency.md` §9: a single `apps/api`
 * process holds a connection pool of exactly one (`packages/db/src/client.ts`),
 * so two claim transactions inside one process can never both be open inside
 * Postgres at the same instant — they queue at the connection pool, in Node,
 * before Postgres ever sees a second statement. That walkthrough measured a
 * claim with its locking removed handing out **twenty distinct keys to twenty
 * callers in one process** — a clean pass against a broken implementation —
 * and **nine distinct keys** once the same twenty calls were spread across
 * four processes. This suite spawns four real OS processes against the same
 * Postgres for exactly that reason: it is the only way to make N claims
 * genuinely overlap inside Postgres rather than merely inside one process's
 * event loop.
 *
 * ---------------------------------------------------------------------------
 * RED VALIDATION — HOW THIS TEST WAS PROVEN TO FAIL BEFORE IT PASSED
 * ---------------------------------------------------------------------------
 * `apps/api/src/suppliers/supplier-key-claim.service.ts`'s `claimAndRecord`
 * was temporarily rewritten from the shipped single
 * `UPDATE ... WHERE code = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)` to a
 * separate, unlocked `SELECT` followed by an `UPDATE` inside the same
 * transaction — the exact weakening
 * `docs/walkthrough/slice-4-supplier-idempotency.md` §3 and §9 measured by
 * hand. Run against this suite's four-process harness, that produced fewer
 * distinct codes than orders paid and this suite's `expect` calls failed with
 * the real assertion messages below (quoted verbatim, not paraphrased, in the
 * task report that accompanies this file). The source was then restored
 * exactly and the suite passed again. This file does not automate that
 * toggle — RED validation is a one-time proof that the harness can fail, not
 * a permanent code path — but the comment stays so the experiment can be
 * repeated by hand:
 *
 *   Failure quoted from the actual run (N = 20, 4 processes):
 *     AssertionError: N distinct keys — no code handed to two orders
 *       expected 12 to be 20
 *
 *   Passing run, same harness, restored source:
 *     ✓ pays 20 orders in parallel across 4 processes: N distinct keys,
 *       N claimed supplier_keys rows, N deliveries rows, zero errors
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { DatabaseClient } from "@game-shop/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CreatedOrder, OrderView } from "../../src/orders/orders.types.js";
import type { SimulatedPaymentAck } from "../../src/payments/payment-simulator.types.js";
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
  deriveTestRequestId,
  observeDistinctBackendPidsDuring,
  readBaselineCounts,
} from "./support/db.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
/** `apps/api` — two levels up from `test/concurrency`. */
const API_ROOT = resolve(TEST_DIR, "..", "..");
/** The repository root — where `pnpm run build:packages` and the workspace filters resolve from. */
const REPO_ROOT = resolve(API_ROOT, "..", "..");

/**
 * Four processes, matching the number
 * `docs/walkthrough/slice-4-supplier-idempotency.md` §9 and
 * `docs/walkthrough/slice-5-issuance.md` §8 both used to demonstrate the same
 * property by hand. Ports chosen clear of `API_PORT` (3000, `.env.example`)
 * and `WEB_PORT` (5173) so this suite never collides with a `pnpm dev`
 * already running locally.
 */
const PROCESS_COUNT = 4;
const BASE_PORT = 4101;

/**
 * N for the positive case. Twenty — the same size the project's own manual
 * proofs used (slice-4 §9, slice-5 §8) — is large enough that four processes
 * racing on `supplier_keys` is a genuine contest (that exact size is what
 * exposed the 20-callers/9-distinct-keys defect in slice-4 §9), comfortably
 * inside the 50-key pool so plenty of headroom remains for the boundary case
 * below, and small enough that the whole suite runs in well under a second of
 * actual request time.
 */
const PARALLEL_ORDER_COUNT = 20;

/** The full pool size — `packages/db/src/fixtures/supplier-key-pool.ts`. */
const KEY_POOL_SIZE = 50;

/**
 * M for the boundary case: five more than the pool holds, so the outcome is
 * arithmetically forced rather than merely probable — exactly 50 orders must
 * be delivered and exactly 5 must land on `out_of_stock`, however the 55
 * requests happen to interleave across four processes. This is functional
 * spec §2.5's *second* criterion — "every key already given out" — proven
 * under genuine concurrency instead of the sequential drain Slice 6 verified
 * by hand, and it is this suite's negative/boundary counterpart to the
 * positive case above: the pool running out is the one input this claim is
 * specifically built to refuse safely rather than to satisfy.
 */
const OVER_POOL_ORDER_COUNT = KEY_POOL_SIZE + 5;

function delay(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

function pickInstance(instances: readonly RunningInstance[], index: number): RunningInstance {
  const instance = instances[index % instances.length];
  if (instance === undefined) throw new Error("pickInstance: no instances available");
  return instance;
}

async function createOrder(baseUrl: string): Promise<CreatedOrder> {
  const response = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku: PURCHASABLE_SKU }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${baseUrl}/api/orders -> ${String(response.status)}: ${text}`);
  }
  return JSON.parse(text) as CreatedOrder;
}

interface PaySummary {
  readonly orderId: string;
  readonly status: number;
  readonly ok: boolean;
  readonly webhookOutcome: string | undefined;
}

async function payOrder(baseUrl: string, orderId: string): Promise<PaySummary> {
  const response = await fetch(`${baseUrl}/api/payments/${orderId}/simulate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ outcome: "success" }),
  });
  const text = await response.text();
  if (!response.ok) {
    return { orderId, status: response.status, ok: false, webhookOutcome: undefined };
  }
  const ack = JSON.parse(text) as SimulatedPaymentAck;
  return { orderId, status: response.status, ok: true, webhookOutcome: ack.webhook_outcome };
}

async function fetchOrderView(baseUrl: string, orderId: string): Promise<OrderView> {
  const response = await fetch(`${baseUrl}/api/orders/${orderId}`);
  if (!response.ok) {
    throw new Error(`GET ${baseUrl}/api/orders/${orderId} -> ${String(response.status)}`);
  }
  return (await response.json()) as OrderView;
}

const SETTLE_POLL_INTERVAL_MS = 25;
const SETTLE_TIMEOUT_MS = 10_000;

/**
 * Wait for one order to leave the in-flight states.
 *
 * In this phase the webhook applies its event inline
 * (`docs/walkthrough/slice-5-issuance.md` §9 measured under 20ms, no injected
 * delay), so in practice `payOrder`'s response has already been preceded by
 * the order settling. This poll is a safety margin against scheduling jitter
 * under load — four processes and up to 55 concurrent requests — not
 * something the architecture depends on.
 */
async function waitUntilSettled(baseUrl: string, orderId: string): Promise<OrderView> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const view = await fetchOrderView(baseUrl, orderId);
    if (view.status === "delivered" || view.status === "out_of_stock" || view.status === "payment_failed") {
      return view;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `order ${orderId} did not settle within ${String(SETTLE_TIMEOUT_MS)}ms (status=${view.status})`,
      );
    }
    await delay(SETTLE_POLL_INTERVAL_MS);
  }
}

describe("functional spec §2.5 — a key is never given away twice", () => {
  let instances: RunningInstance[] = [];
  let assertionClient: DatabaseClient;
  let pollerClient: DatabaseClient;

  beforeAll(async () => {
    const databaseUrl = process.env["DATABASE_URL"];
    if (databaseUrl === undefined || databaseUrl === "") {
      throw new Error(
        "DATABASE_URL is not set. Run this suite through `pnpm test:concurrency` " +
          "from the repository root, which loads the local environment first " +
          "(scripts/with-env.ts).",
      );
    }

    assertionClient = createTestDatabaseClient("assert");
    pollerClient = createTestDatabaseClient("poll");

    assertBaseline(await readBaselineCounts(assertionClient), "before");

    // Build @game-shop/db, @game-shop/contracts and @game-shop/api from
    // current source. This is what makes RED validation meaningful: a source
    // edit to supplier-key-claim.service.ts only reaches the processes
    // started below if dist/ is rebuilt from it — see ./support/api-instance.ts.
    console.log("key-claim-race: building @game-shop/db, @game-shop/contracts and @game-shop/api...");
    execFileSync("pnpm", ["run", "build:packages"], { cwd: REPO_ROOT, stdio: "inherit" });
    execFileSync("pnpm", ["--filter", "@game-shop/api", "run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });

    instances = await Promise.all(
      Array.from({ length: PROCESS_COUNT }, async (_, index) =>
        startApiInstance({ apiRoot: API_ROOT, port: BASE_PORT + index, databaseUrl }),
      ),
    );
    console.log(
      `key-claim-race: ${String(instances.length)} apps/api processes healthy on ports ` +
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
    `pays ${String(PARALLEL_ORDER_COUNT)} orders in parallel across ${String(PROCESS_COUNT)} processes: ` +
      "N distinct keys, N claimed supplier_keys rows, N deliveries rows, zero errors",
    async () => {
      const orderIds: string[] = [];

      try {
        const orders = await Promise.all(
          Array.from({ length: PARALLEL_ORDER_COUNT }, async (_, index) =>
            createOrder(pickInstance(instances, index).baseUrl),
          ),
        );
        orderIds.push(...orders.map((order) => order.id));
        // Sanity check on the harness itself: N distinct orders exist to race with.
        expect(new Set(orderIds).size).toBe(PARALLEL_ORDER_COUNT);

        const startedAt = Date.now();
        const { result: payResults, witness } = await observeDistinctBackendPidsDuring(
          pollerClient,
          "game-shop", // apps/api's own default application_name — packages/db/src/client.ts
          async () =>
            Promise.all(
              orderIds.map(async (orderId, index) => payOrder(pickInstance(instances, index).baseUrl, orderId)),
            ),
        );
        const elapsedMs = Date.now() - startedAt;

        console.log(
          `key-claim-race: ${String(PARALLEL_ORDER_COUNT)} parallel payments in ${String(elapsedMs)}ms; ` +
            `distinct Postgres backend pids observed mid-flight: [${witness.distinctPids.join(", ")}] ` +
            `(${String(witness.samples)} pg_stat_activity samples taken during the window)`,
        );

        // HTTP-level check: every payment was accepted and stored as a new
        // event, with no application error escaping to a caller. This alone
        // is not the proof — architecture.md §7 is explicit that a response
        // can look correct while the state beneath it is wrong (the
        // DrizzleQueryError defect in
        // docs/walkthrough/slice-4-supplier-idempotency.md §6 is the
        // precedent: nineteen 500s while the database stayed correct) — so
        // every claim below this point is re-derived from Postgres directly.
        for (const result of payResults) {
          expect(
            result.ok,
            `POST .../payments/${result.orderId}/simulate returned ${String(result.status)}`,
          ).toBe(true);
          expect(result.webhookOutcome, `order ${result.orderId}'s payment event was not freshly stored`).toBe(
            "stored",
          );
        }

        const settled = await Promise.all(
          orderIds.map(async (orderId, index) => waitUntilSettled(pickInstance(instances, index).baseUrl, orderId)),
        );
        for (const view of settled) {
          expect(view.status, `order ${view.id} settled as "${view.status}", not "delivered"`).toBe("delivered");
        }

        // ---------------------------------------------------------------
        // Everything from here queries Postgres directly — not the API.
        // ---------------------------------------------------------------
        const requestIds = orderIds.map(deriveTestRequestId);

        //   select order_id, code from deliveries where order_id = ANY($1::text[]);
        const deliveredRows = await assertionClient.pool.query<{ order_id: string; code: string }>(
          `select order_id, code from deliveries where order_id = ANY($1::text[])`,
          [orderIds],
        );
        expect(deliveredRows.rowCount, "exactly N rows in deliveries").toBe(PARALLEL_ORDER_COUNT);

        const distinctCodes = new Set(deliveredRows.rows.map((row) => row.code));
        expect(distinctCodes.size, "N distinct keys — no code handed to two orders").toBe(PARALLEL_ORDER_COUNT);

        const distinctOrders = new Set(deliveredRows.rows.map((row) => row.order_id));
        expect(distinctOrders.size, "each order received at most one delivery row (I3)").toBe(PARALLEL_ORDER_COUNT);

        //   select count(*)::int from supplier_keys where claimed_by_request_id = ANY($1::text[]);
        const claimedKeys = await assertionClient.pool.query<{ n: number }>(
          `select count(*)::int as n from supplier_keys where claimed_by_request_id = ANY($1::text[])`,
          [requestIds],
        );
        expect(claimedKeys.rows[0]?.n, "exactly N claimed rows in supplier_keys").toBe(PARALLEL_ORDER_COUNT);

        //   select count(distinct code)::int from supplier_keys where claimed_by_request_id = ANY($1::text[]);
        const distinctClaimedCodes = await assertionClient.pool.query<{ n: number }>(
          `select count(distinct code)::int as n from supplier_keys where claimed_by_request_id = ANY($1::text[])`,
          [requestIds],
        );
        expect(distinctClaimedCodes.rows[0]?.n, "the N claimed rows hold N distinct codes").toBe(
          PARALLEL_ORDER_COUNT,
        );

        // A soft check, not a hard requirement of the invariant: direct
        // evidence (beyond "the test passed") that the harness held more than
        // one live Postgres backend connection at once while the payments
        // were in flight — see ./support/db.ts for why this is a sample, not
        // a certificate, and RED validation (this file's header) is the
        // stronger proof of genuine cross-process concurrency.
        expect(
          witness.distinctPids.length,
          `only ${String(witness.distinctPids.length)} distinct backend pid(s) observed live during the ` +
            `parallel window — see the RED validation section of this file's header for the authoritative proof`,
        ).toBeGreaterThanOrEqual(2);
      } finally {
        await cleanupTestOrders(assertionClient, orderIds);
      }
    },
  );

  it(
    `pays ${String(OVER_POOL_ORDER_COUNT)} orders in parallel — more than the ${String(KEY_POOL_SIZE)}-key pool holds: ` +
      "no code is ever claimed twice even at exhaustion, and the shop keeps answering (§2.5's second criterion)",
    async () => {
      const orderIds: string[] = [];

      try {
        const orders = await Promise.all(
          Array.from({ length: OVER_POOL_ORDER_COUNT }, async (_, index) =>
            createOrder(pickInstance(instances, index).baseUrl),
          ),
        );
        orderIds.push(...orders.map((order) => order.id));

        const payResults = await Promise.all(
          orderIds.map(async (orderId, index) => payOrder(pickInstance(instances, index).baseUrl, orderId)),
        );

        // Functional spec §2.5's second criterion, under real concurrency
        // rather than the sequential drain Slice 6 verified by hand: every
        // request still gets an honest HTTP answer — no 500, no dropped
        // connection — whether it wins a key or not.
        for (const result of payResults) {
          expect(
            result.ok,
            `POST .../payments/${result.orderId}/simulate returned ${String(result.status)} ` +
              "instead of an ordinary 200 — the shop must keep working normally at pool exhaustion",
          ).toBe(true);
          expect(result.webhookOutcome, `order ${result.orderId}'s payment event was not freshly stored`).toBe(
            "stored",
          );
        }

        const settled = await Promise.all(
          orderIds.map(async (orderId, index) => waitUntilSettled(pickInstance(instances, index).baseUrl, orderId)),
        );
        const byStatus = new Map<string, number>();
        for (const view of settled) {
          byStatus.set(view.status, (byStatus.get(view.status) ?? 0) + 1);
        }
        console.log(`key-claim-race: over-pool run settled as ${JSON.stringify(Object.fromEntries(byStatus))}`);

        expect(byStatus.get("delivered"), "exactly one order settles per available key").toBe(KEY_POOL_SIZE);
        expect(
          byStatus.get("out_of_stock"),
          "the orders the pool could not cover land on out_of_stock, not an error, not a crash",
        ).toBe(OVER_POOL_ORDER_COUNT - KEY_POOL_SIZE);

        // ---------------------------------------------------------------
        // Database assertions — the invariant under contention at the tail.
        // ---------------------------------------------------------------
        const requestIds = orderIds.map(deriveTestRequestId);

        const deliveredRows = await assertionClient.pool.query<{ code: string }>(
          `select code from deliveries where order_id = ANY($1::text[])`,
          [orderIds],
        );
        expect(deliveredRows.rowCount, "exactly the pool's worth of deliveries, no more").toBe(KEY_POOL_SIZE);

        const distinctCodes = new Set(deliveredRows.rows.map((row) => row.code));
        expect(
          distinctCodes.size,
          "every delivered code is distinct — no double-issue even as requests race for the last keys",
        ).toBe(KEY_POOL_SIZE);

        const claimedKeys = await assertionClient.pool.query<{ n: number }>(
          `select count(*)::int as n from supplier_keys where claimed_by_request_id = ANY($1::text[])`,
          [requestIds],
        );
        expect(claimedKeys.rows[0]?.n, "exactly the whole pool was claimed — not more than 50 keys exist").toBe(
          KEY_POOL_SIZE,
        );

        const remainingUnclaimed = await assertionClient.pool.query<{ n: number }>(
          `select count(*)::int as n from supplier_keys where claimed_by_request_id is null`,
        );
        expect(remainingUnclaimed.rows[0]?.n, "the pool is fully — and only — drained by this run").toBe(0);
      } finally {
        await cleanupTestOrders(assertionClient, orderIds);
      }
    },
  );
});
