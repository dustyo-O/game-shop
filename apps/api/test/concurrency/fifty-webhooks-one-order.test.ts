// @layer: integration
// @spec: 002-single-issuance-under-races
// @regression
/**
 * The permanent-suite proof of functional spec §2.2's second acceptance
 * criterion — the assignment's headline scenario:
 *
 *   "Given the payment service reports one shopper's payment fifty times at
 *    the same moment, when the shop has finished, then the shopper has been
 *    given exactly one key and exactly one key has left the shop's stock."
 *
 * `scripts/race/webhooks.ts` (`pnpm race webhooks`) already drives this exact
 * scenario, at this exact scale, and is what functional spec §2.6 names as
 * the reviewer's own reproducible check — Slice 6 verified it, including its
 * RED validation. This file is a different, complementary thing: the same
 * scenario, expressed as a permanent Vitest regression test that `pnpm test`
 * runs on every invocation without a reviewer having to remember to run
 * `pnpm race` separately. Neither replaces the other — `architecture.md` §7
 * describes the race scripts and this suite as siblings that both exist.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A DIFFERENT SHAPE OF RACE FROM THE OTHER TWO CONCURRENCY SUITES
 * ---------------------------------------------------------------------------
 * `./key-claim-race.test.ts` fires N *distinct* triggers (N webhooks) at N
 * *distinct* orders — one order each — to prove the supplier-key claim is
 * safe under fan-out across many customers. `./order-lock-race.test.ts` fires
 * exactly *two* triggers of two *different kinds* (a continuation and a
 * drain) at *one* order, to prove I4's row lock excludes a second worker.
 *
 * This file fires **fifty** triggers of the *same* kind — fifty distinct
 * `paid` webhook events, each a fresh `event_id` — at **one** order. It is
 * the shape §2.2's second criterion literally describes: not fifty different
 * shoppers, one shopper's payment reported fifty times. Every one of those
 * fifty events independently wins its own `INSERT ... ON CONFLICT (event_id)
 * DO NOTHING` (I2 — they are fifty *different* event ids, so all fifty are
 * genuinely "first sight" and all fifty schedule their own continuation), and
 * then all fifty race `claimForIssuance`'s `paid → delivering` guarded UPDATE
 * under the order row lock (I4) for the *same* order. Exactly one may win it;
 * the other forty-nine must become clean no-ops, and the whole point of
 * spreading this across genuinely separate processes is that a broken guard
 * or a broken claim has somewhere to go wrong that a single process's `max:
 * 1` pool would hide — `architecture.md` §7's own measurement (20 distinct
 * keys in one process, 9 distinct across four, with the exact same weakened
 * code) is the general case this test is the specific instance of.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LOSING FORTY-NINE EVENTS MAY NEED AN EXTRA SWEEP TO SETTLE
 * ---------------------------------------------------------------------------
 * Identical reasoning to `./order-lock-race.test.ts`'s header, "WHY THE
 * LOSING EVENT MAY NEED AN EXTRA SWEEP TO SETTLE": a loser's own
 * `claimForIssuance` will very often find the order already `delivering`
 * (the winner's supplier round trip has not finished yet) rather than
 * `delivered`, so `settleOrDeferPaidEvent` classifies it
 * `deferred_order_in_flight` and leaves it pending on purpose — the
 * invariant "an unfinished paid order always has at least one pending event
 * pointing at it" doing its job for all forty-nine losers at once. This file
 * reuses `./order-lock-race.test.ts`'s pattern: call the admin sweep a
 * bounded number of times after the order has settled, which is what finds
 * those leftover rows, observes the order is now `delivered`, and settles
 * each as a `no_op`.
 *
 * ---------------------------------------------------------------------------
 * REUSING THE HARNESS RATHER THAN BUILDING A SECOND ONE
 * ---------------------------------------------------------------------------
 * `./support/api-instance.ts` and `./support/db.ts` — the same harness every
 * other concurrency suite and `scripts/race/` itself use
 * (`architecture.md` §7, technical-considerations §2.4's assumption A6).
 *
 * ---------------------------------------------------------------------------
 * ASSERTIONS QUERY THE DATABASE DIRECTLY
 * ---------------------------------------------------------------------------
 * Per `architecture.md` §7 — one delivery row, one claimed key, not merely
 * fifty `2xx` responses.
 *
 * ---------------------------------------------------------------------------
 * RED VALIDATION
 * ---------------------------------------------------------------------------
 * See this task's report for the inversions made to confirm this file can
 * fail, and their exact output. No production source was edited to produce
 * them — that method (temporarily weakening `apps/api/src`) is Slice 6 task
 * 6's already-completed territory, reassigned there to an implementation-
 * capable agent for the stated reason; this file's RED validation instead
 * inverts what the test itself asserts, per this task's brief.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
 * Four processes — the same count `./key-claim-race.test.ts` uses, for the
 * same reason: enough that fifty events racing across them is a genuine
 * contest for Postgres to serialise, not merely for one process's event loop
 * to take turns on. Ports clear of `./key-claim-race.test.ts` (4101-4104),
 * `./order-lock-race.test.ts` (4401-4402), `../acceptance/single-issuance-
 * under-races.test.ts` (4301), `pnpm race`'s default range (4201-4204), and
 * `API_PORT` (3000) / `WEB_PORT` (5173).
 */
const PROCESS_COUNT = 4;
const BASE_PORT = 4501;

/** The assignment's own stated number — functional spec §2.2 criterion 2, verbatim. */
const REPORT_COUNT = 50;

/** How many extra admin sweeps to try before giving up on settling the losers' leftover pending rows. */
const MAX_SETTLE_SWEEPS = 8;

function delay(ms: number): Promise<void> {
  return new Promise((doneWaiting) => {
    setTimeout(doneWaiting, ms);
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
  if (!response.ok) throw new Error(`POST ${baseUrl}/api/orders -> ${String(response.status)}: ${text}`);
  return JSON.parse(text) as CreatedOrder;
}

interface WebhookResult {
  readonly ok: boolean;
  readonly status: number;
  readonly outcome: string | undefined;
}

/** One `POST /api/webhooks/payment` for a fresh, distinct `event_id` naming the SAME order — never throws, so fifty can run under one `Promise.all`. */
async function postPaidWebhookEvent(baseUrl: string, eventId: string, orderId: string): Promise<WebhookResult> {
  const response = await fetch(`${baseUrl}/api/webhooks/payment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event_id: eventId, order_id: orderId, status: "paid", amount: 5, currency: "RUB" }),
  });
  const text = await response.text();
  let outcome: string | undefined;
  try {
    outcome = (JSON.parse(text) as { outcome?: unknown }).outcome as string | undefined;
  } catch {
    outcome = undefined;
  }
  return { ok: response.ok, status: response.status, outcome };
}

interface SweepReport {
  readonly left_pending: number;
}

async function adminSweep(baseUrl: string, token: string): Promise<SweepReport> {
  const response = await fetch(`${baseUrl}/api/admin/payment-events/sweep`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${baseUrl}/api/admin/payment-events/sweep -> ${String(response.status)}: ${text}`);
  return JSON.parse(text) as SweepReport;
}

async function fetchOrderView(baseUrl: string, orderId: string): Promise<OrderView> {
  const response = await fetch(`${baseUrl}/api/orders/${orderId}`);
  if (!response.ok) throw new Error(`GET ${baseUrl}/api/orders/${orderId} -> ${String(response.status)}`);
  return (await response.json()) as OrderView;
}

const SETTLE_POLL_INTERVAL_MS = 25;
const SETTLE_TIMEOUT_MS = 15_000;

async function waitUntilSettled(baseUrl: string, orderId: string): Promise<OrderView> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const view = await fetchOrderView(baseUrl, orderId);
    if (view.status === "delivered" || view.status === "out_of_stock" || view.status === "payment_failed") {
      return view;
    }
    if (Date.now() > deadline) {
      throw new Error(`order ${orderId} did not settle within ${String(SETTLE_TIMEOUT_MS)}ms (status=${view.status})`);
    }
    await delay(SETTLE_POLL_INTERVAL_MS);
  }
}

async function countPendingEventsForOrder(client: DatabaseClient, orderId: string): Promise<number> {
  //   select count(*)::int from payment_events where order_id = $1 and processed_at is null;
  const { rows } = await client.pool.query<{ n: number }>(
    `select count(*)::int as n from payment_events where order_id = $1 and processed_at is null`,
    [orderId],
  );
  return rows[0]?.n ?? 0;
}

/** Call the admin sweep until this order has nothing left pending, or give up after {@link MAX_SETTLE_SWEEPS} tries. See the file header. */
async function settleFully(sweepBaseUrl: string, adminToken: string, orderId: string, client: DatabaseClient): Promise<void> {
  for (let attempt = 0; attempt < MAX_SETTLE_SWEEPS; attempt += 1) {
    if ((await countPendingEventsForOrder(client, orderId)) === 0) return;
    await adminSweep(sweepBaseUrl, adminToken);
  }
}

describe("functional spec §2.2 criterion 2 — fifty simultaneous reports of one payment yield exactly one key", () => {
  let instances: RunningInstance[] = [];
  let assertionClient: DatabaseClient;
  let pollerClient: DatabaseClient;
  let adminToken: string;

  beforeAll(async () => {
    const databaseUrl = process.env["DATABASE_URL"];
    if (databaseUrl === undefined || databaseUrl === "") {
      throw new Error(
        "DATABASE_URL is not set. Run this suite through `pnpm test` from the " +
          "repository root, which loads the local environment first (scripts/with-env.ts).",
      );
    }

    const token = process.env["ADMIN_TOKEN"];
    if (token === undefined || token.length < 16) {
      throw new Error("ADMIN_TOKEN is not set (or shorter than 16 chars), and this suite drives the admin sweep directly. See .env.example.");
    }
    adminToken = token;

    assertionClient = createTestDatabaseClient("assert-fifty");
    pollerClient = createTestDatabaseClient("poll-fifty");

    assertBaseline(await readBaselineCounts(assertionClient), "before");

    console.log("fifty-webhooks-one-order: building @game-shop/db, @game-shop/contracts and @game-shop/api...");
    execFileSync("pnpm", ["run", "build:packages"], { cwd: REPO_ROOT, stdio: "inherit" });
    execFileSync("pnpm", ["--filter", "@game-shop/api", "run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });

    instances = await Promise.all(
      Array.from({ length: PROCESS_COUNT }, async (_, index) => startApiInstance({ apiRoot: API_ROOT, port: BASE_PORT + index, databaseUrl })),
    );
    console.log(
      `fifty-webhooks-one-order: ${String(instances.length)} apps/api processes healthy on ports ` +
        `${instances.map((instance) => String(instance.port)).join(", ")} (pids ${instances.map((instance) => String(instance.pid)).join(", ")})`,
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
    `fires ${String(REPORT_COUNT)} distinct paid reports at ONE order across ${String(PROCESS_COUNT)} processes: ` +
      "exactly one delivery, one claimed key, the order delivered, and every response 2xx",
    async () => {
      const order = await createOrder(pickInstance(instances, 0).baseUrl);
      const orderIds = [order.id];

      try {
        const eventIds = Array.from({ length: REPORT_COUNT }, () => `evt_test_002_fifty_${order.id}_${randomUUID()}`);

        const startedAt = Date.now();
        const { result: results, witness } = await observeDistinctBackendPidsDuring(pollerClient, "game-shop", async () =>
          Promise.all(eventIds.map(async (eventId, index) => postPaidWebhookEvent(pickInstance(instances, index).baseUrl, eventId, order.id))),
        );
        const elapsedMs = Date.now() - startedAt;

        console.log(
          `fifty-webhooks-one-order: ${String(REPORT_COUNT)} parallel reports in ${String(elapsedMs)}ms; ` +
            `distinct Postgres backend pids observed mid-flight: [${witness.distinctPids.join(", ")}] ` +
            `(${String(witness.samples)} pg_stat_activity samples taken during the window)`,
        );

        // HTTP-level: every one of the fifty reports was accepted and stored as
        // a fresh event — not the proof itself (architecture.md §7 is explicit
        // that a response can look correct while the database disagrees), so
        // everything below this point is re-derived from Postgres directly.
        for (const result of results) {
          expect(result.ok, `a webhook report returned ${String(result.status)}, not 2xx`).toBe(true);
          expect(result.outcome, "each of the fifty distinct event_ids was first sight, not a duplicate").toBe("stored");
        }

        const settled = await waitUntilSettled(pickInstance(instances, 0).baseUrl, order.id);
        expect(settled.status, `order ${order.id} settled as "${settled.status}", not "delivered"`).toBe("delivered");

        // Losers of the forty-nine-to-one issuance claim may still read
        // deferred_order_in_flight — see the file header. Bounded extra sweeps
        // settle them.
        await settleFully(pickInstance(instances, 0).baseUrl, adminToken, order.id, assertionClient);

        // ---------------------------------------------------------------
        // Everything from here queries Postgres directly, never the API.
        // ---------------------------------------------------------------
        const requestId = deriveTestRequestId(order.id);

        //   select count(*)::int from payment_events where order_id = $1;
        const eventRows = await assertionClient.pool.query<{ n: number }>(
          `select count(*)::int as n from payment_events where order_id = $1`,
          [order.id],
        );
        expect(eventRows.rows[0]?.n, `all ${String(REPORT_COUNT)} distinct reports were durably stored`).toBe(REPORT_COUNT);

        //   select order_id, code from deliveries where order_id = $1;
        const deliveredRows = await assertionClient.pool.query<{ order_id: string; code: string }>(
          `select order_id, code from deliveries where order_id = $1`,
          [order.id],
        );
        expect(deliveredRows.rowCount, "exactly one delivery row for this order, not one per report").toBe(1);

        //   select status from issuance_attempts where order_id = $1;
        const attemptRows = await assertionClient.pool.query<{ status: string }>(
          `select status from issuance_attempts where order_id = $1`,
          [order.id],
        );
        expect(attemptRows.rowCount, "exactly one issuance_attempts row — the supplier was called once, not fifty times").toBe(1);
        expect(attemptRows.rows[0]?.status).toBe("ok");

        //   select count(*)::int from supplier_keys where claimed_by_request_id = $1;
        const claimedKeys = await assertionClient.pool.query<{ n: number }>(
          `select count(*)::int as n from supplier_keys where claimed_by_request_id = $1`,
          [requestId],
        );
        expect(claimedKeys.rows[0]?.n, "exactly one supplier_keys row claimed — one key left the shop's stock, not fifty").toBe(1);

        //   select status from orders where id = $1;
        const orderRow = await assertionClient.pool.query<{ status: string }>(`select status from orders where id = $1`, [order.id]);
        expect(orderRow.rows[0]?.status, "the order finished delivered").toBe("delivered");

        const pendingLeft = await countPendingEventsForOrder(assertionClient, order.id);
        expect(pendingLeft, "no payment_events left pending for this order once things settle").toBe(0);

        // A soft, supporting signal that the fifty reports genuinely raced
        // across more than one live Postgres connection — see
        // ./support/db.ts and ./key-claim-race.test.ts's header for why this
        // is a sample rather than the authoritative proof (that is RED
        // validation, reported in this task's report).
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
