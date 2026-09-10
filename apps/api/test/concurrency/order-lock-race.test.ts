// @layer: integration
// @spec: 002-single-issuance-under-races
// @regression
/**
 * The executable proof of Slice 5's acceptance criterion — `tasks.md`:
 *
 *   "drive a continuation and a drain at the same order simultaneously across
 *    more than one process and confirm exactly one delivery row, one key
 *    claimed, and no double issuance. A single instance would serialise at
 *    its connection pool and prove nothing."
 *
 * This is deliberately a *different* shape of race from
 * `./key-claim-race.test.ts`. That suite fires N *identical* triggers (N
 * webhooks) at N *distinct* orders — it proves the supplier-key claim is safe
 * under fan-out. This file fires two *different kinds* of trigger — the
 * webhook's own scheduled continuation, and a drain (the admin sweep, or the
 * order-status-poll drain) — at the *same* order, in two separate OS
 * processes, and asserts against `architecture.md` §3's I4: the order row
 * lock plus the status-guarded UPDATE.
 *
 * ---------------------------------------------------------------------------
 * HOW THE CONTENTION IS FORCED
 * ---------------------------------------------------------------------------
 * One order, two `paid` payment events for it (a realistic shape — a payment
 * provider redelivering a notification with a fresh `event_id` is ordinary
 * traffic, and `architecture.md` §4 is explicit that an unfinished paid order
 * always has at least one pending event pointing at it, so more than one is
 * not a contradiction):
 *
 *   - **event 1** is delivered through `POST {instanceA}/api/webhooks/payment`.
 *     Instance A stores it and — per `payment-webhook.controller.ts` — schedules
 *     its own continuation, which calls `processStoredEvent` on the row it just
 *     inserted, with no claim step in between. This is processing trigger 1.
 *   - **event 2** is inserted directly into `payment_events` with `processed_at`
 *     NULL, modelling a pending row nobody's continuation is currently working
 *     — exactly the shape triggers 2/3/4 exist to find (a continuation lost to
 *     a `SIGTERM`, an event that outran its own webhook's continuation, etc.).
 *     It is picked up by instance B's **drain** — the admin sweep
 *     (`POST /api/admin/payment-events/sweep`, trigger 4) in the first `it`,
 *     and the order-status-poll drain (`GET /api/orders/:id`, trigger 3) in the
 *     second.
 *
 * Both triggers are fired through one `Promise.all`, never sequentially: the
 * continuation begins executing synchronously up to its first `await` the
 * moment `schedule()` is called — see `../scheduling/continuation-scheduler.ts`
 * and `tracked-continuation-scheduler.ts`'s `schedule()`, "Start it, then track
 * it" — so a caller that waited for the webhook's `200` before firing the
 * second trigger would very often find the continuation already finished.
 * Firing both requests at once is what gives them a real chance to be two
 * live Postgres backends racing `claimForIssuance`'s `SELECT … FOR UPDATE` on
 * the *same* order row at the *same* instant, which is `PaymentEventProcessor`
 * §2.5 step 3 and I4's first half (`../orders/order-lock.service.ts`).
 *
 * Both `applyPaid` calls attempt the claim regardless of whether their own
 * `markPaid` won (`payment-event-processor.service.ts`, "Why the claim is
 * attempted even when markPaid matched nothing"), so this is genuine
 * contention on `claimForIssuance`'s transaction A from two processes, not a
 * race that only one worker ever reaches.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE-SIDED ASSERTIONS ARE NOT ENOUGH — pg_stat_activity AS A WITNESS
 * ---------------------------------------------------------------------------
 * As `./support/db.ts`'s `observeDistinctBackendPidsDuring` says of its own
 * use in `key-claim-race.test.ts`: a passing assertion count alone does not
 * distinguish "two processes genuinely raced in Postgres" from "one process
 * happened to run twice, sequentially, and produced the same numbers". This
 * file samples `pg_stat_activity` during the race window as supporting
 * evidence, and treats RED validation (see the task report that accompanies
 * this file, and this codebase's own established precedent in
 * `./key-claim-race.test.ts`'s header) as the authoritative proof.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LOSING EVENT MAY NEED AN EXTRA SWEEP TO SETTLE
 * ---------------------------------------------------------------------------
 * The loser's own `claimForIssuance` almost always finds the order already
 * `delivering` (the winner's supplier round trip has not finished yet) rather
 * than `delivered`, so `settleOrDeferPaidEvent` classifies it
 * `deferred_order_in_flight` and leaves it pending on purpose
 * (`payment-event-processor.service.ts`) — that is the invariant *"an
 * unfinished paid order always has at least one pending event pointing at
 * it"* doing exactly its job. `settleFully` below calls the admin sweep a
 * bounded number of times after the order has settled, which is what finds
 * that leftover row, observes the order is now `delivered`, and settles it as
 * a `no_op` — precisely the backstop `architecture.md` §4 describes the sweep
 * as being.
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
 * Two processes — the minimum the acceptance criterion asks for ("more than
 * one process"), and no more: this suite needs exactly one worker in each of
 * two roles (the continuation, the drain), not fan-out. Ports chosen clear of
 * `key-claim-race.test.ts`'s 4101-4104 range so the two suites never collide
 * if run back to back, and clear of `API_PORT` (3000) and `WEB_PORT` (5173).
 */
const BASE_PORT = 4401;

const SETTLE_POLL_INTERVAL_MS = 25;
const SETTLE_TIMEOUT_MS = 10_000;

/** How many extra admin sweeps to try before giving up on settling the loser's leftover pending row. */
const MAX_SETTLE_SWEEPS = 5;

function delay(ms: number): Promise<void> {
  return new Promise((doneWaiting) => {
    setTimeout(doneWaiting, ms);
  });
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

interface WebhookAck {
  readonly event_id: string;
  readonly outcome: string;
}

/** Trigger 1 — deliver a `paid` event through the real webhook endpoint. */
async function postPaidWebhookEvent(baseUrl: string, eventId: string, orderId: string): Promise<WebhookAck> {
  const response = await fetch(`${baseUrl}/api/webhooks/payment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      event_id: eventId,
      order_id: orderId,
      status: "paid",
      amount: 5,
      currency: "RUB",
    }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${baseUrl}/api/webhooks/payment -> ${String(response.status)}: ${text}`);
  }
  return JSON.parse(text) as WebhookAck;
}

/**
 * Insert a second `paid` event directly into the inbox, `processed_at` NULL —
 * modelling a pending row that arrived by some means other than "the webhook
 * that stored it is still holding it in its own continuation right now",
 * which is precisely the shape triggers 2/3/4 exist to pick up. Bypassing the
 * webhook for this one is deliberate: it is what lets the test choose, rather
 * than hope, which process's *drain* claims it.
 */
async function insertPendingPaidEvent(client: DatabaseClient, eventId: string, orderId: string): Promise<void> {
  const payload = { event_id: eventId, order_id: orderId, status: "paid", amount: 5, currency: "RUB" };

  //   insert into payment_events (event_id, order_id, status, amount_minor, currency, payload, received_at)
  //   values ($1, $2, 'paid', 500, 'RUB', $3::jsonb, now());
  await client.pool.query(
    `insert into payment_events (event_id, order_id, status, amount_minor, currency, payload, received_at)
     values ($1, $2, 'paid', 500, 'RUB', $3::jsonb, now())`,
    [eventId, orderId, JSON.stringify(payload)],
  );
}

interface SweepReport {
  readonly claimed: number;
  readonly settled: number;
  readonly left_pending: number;
  readonly passes: number;
  readonly stopped_by: string;
  readonly more_pending: boolean;
  readonly duration_ms: number;
}

/** Trigger 4 — the admin sweep, behind the shared bearer token. */
async function adminSweep(baseUrl: string, token: string): Promise<SweepReport> {
  const response = await fetch(`${baseUrl}/api/admin/payment-events/sweep`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${baseUrl}/api/admin/payment-events/sweep -> ${String(response.status)}: ${text}`);
  }
  return JSON.parse(text) as SweepReport;
}

async function fetchOrderView(baseUrl: string, orderId: string): Promise<OrderView> {
  const response = await fetch(`${baseUrl}/api/orders/${orderId}`);
  if (!response.ok) {
    throw new Error(`GET ${baseUrl}/api/orders/${orderId} -> ${String(response.status)}`);
  }
  return (await response.json()) as OrderView;
}

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

async function countUnclaimedKeys(client: DatabaseClient): Promise<number> {
  //   select count(*)::int from supplier_keys where claimed_by_request_id is null;
  const { rows } = await client.pool.query<{ n: number }>(
    `select count(*)::int as n from supplier_keys where claimed_by_request_id is null`,
  );
  return rows[0]?.n ?? 0;
}

async function countPendingEventsForOrder(client: DatabaseClient, orderId: string): Promise<number> {
  //   select count(*)::int from payment_events where order_id = $1 and processed_at is null;
  const { rows } = await client.pool.query<{ n: number }>(
    `select count(*)::int as n from payment_events where order_id = $1 and processed_at is null`,
    [orderId],
  );
  return rows[0]?.n ?? 0;
}

/**
 * The backstop: call the admin sweep until this order has nothing left
 * pending, or give up after {@link MAX_SETTLE_SWEEPS} tries. See the file
 * header, "Why the losing event may need an extra sweep to settle".
 */
async function settleFully(
  sweepBaseUrl: string,
  adminToken: string,
  orderId: string,
  client: DatabaseClient,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_SETTLE_SWEEPS; attempt += 1) {
    if ((await countPendingEventsForOrder(client, orderId)) === 0) return;
    await adminSweep(sweepBaseUrl, adminToken);
  }
}

function instanceAt(instances: readonly RunningInstance[], index: number): RunningInstance {
  const instance = instances[index];
  if (instance === undefined) throw new Error(`instanceAt(${String(index)}): no such instance`);
  return instance;
}

describe("architecture.md §3 I4 — only one worker advances an order (the order row lock)", () => {
  let instances: RunningInstance[] = [];
  let assertionClient: DatabaseClient;
  let pollerClient: DatabaseClient;
  let adminToken: string;

  beforeAll(async () => {
    const databaseUrl = process.env["DATABASE_URL"];
    if (databaseUrl === undefined || databaseUrl === "") {
      throw new Error(
        "DATABASE_URL is not set. Run this suite through `pnpm --filter @game-shop/api exec vitest run " +
          "test/concurrency/order-lock-race.test.ts` from the repository root via scripts/with-env.ts.",
      );
    }

    const token = process.env["ADMIN_TOKEN"];
    if (token === undefined || token.length < 16) {
      throw new Error(
        "ADMIN_TOKEN is not set (or shorter than 16 chars), and this suite drives the admin sweep " +
          "directly. See .env.example.",
      );
    }
    adminToken = token;

    assertionClient = createTestDatabaseClient("assert");
    pollerClient = createTestDatabaseClient("poll");

    assertBaseline(await readBaselineCounts(assertionClient), "before");

    // Rebuild from current source, exactly as key-claim-race.test.ts does —
    // this is what makes a RED edit to order-lock.service.ts reach the
    // processes spawned below. See ./support/api-instance.ts.
    console.log("order-lock-race: building @game-shop/db, @game-shop/contracts and @game-shop/api...");
    execFileSync("pnpm", ["run", "build:packages"], { cwd: REPO_ROOT, stdio: "inherit" });
    execFileSync("pnpm", ["--filter", "@game-shop/api", "run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });

    instances = await Promise.all(
      Array.from({ length: 2 }, async (_, index) =>
        startApiInstance({ apiRoot: API_ROOT, port: BASE_PORT + index, databaseUrl }),
      ),
    );
    console.log(
      `order-lock-race: ${String(instances.length)} apps/api processes healthy on ports ` +
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
    "a webhook continuation (process A) and the admin sweep (process B) contend for the same order: " +
      "exactly one delivery, one claimed key, no double issuance",
    async () => {
      const instanceA = instanceAt(instances, 0);
      const instanceB = instanceAt(instances, 1);
      const orderIds: string[] = [];

      try {
        const order = await createOrder(instanceA.baseUrl);
        orderIds.push(order.id);

        const continuationEventId = `evt_test_${order.id}_continuation`;
        const drainEventId = `evt_test_${order.id}_drain`;

        // event 2: pending, waiting for a drain to find it.
        await insertPendingPaidEvent(assertionClient, drainEventId, order.id);

        const unclaimedBefore = await countUnclaimedKeys(assertionClient);

        // ---------------------------------------------------------------
        // THE RACE. Both requests fired at once, to two different processes.
        // ---------------------------------------------------------------
        const startedAt = Date.now();
        const { witness } = await observeDistinctBackendPidsDuring(pollerClient, "game-shop", async () =>
          Promise.all([
            // Process A: the webhook's own scheduled continuation (trigger 1).
            postPaidWebhookEvent(instanceA.baseUrl, continuationEventId, order.id),
            // Process B: the admin sweep (trigger 4), draining the pending row above.
            adminSweep(instanceB.baseUrl, adminToken),
          ]),
        );
        const elapsedMs = Date.now() - startedAt;

        console.log(
          `order-lock-race (continuation vs sweep): raced in ${String(elapsedMs)}ms; ` +
            `distinct Postgres backend pids observed mid-flight: [${witness.distinctPids.join(", ")}] ` +
            `(${String(witness.samples)} pg_stat_activity samples taken during the window)`,
        );

        const settled = await waitUntilSettled(instanceA.baseUrl, order.id);
        expect(settled.status, `order ${order.id} settled as "${settled.status}", not "delivered"`).toBe(
          "delivered",
        );

        // The loser's event may still be pending (deferred_order_in_flight) —
        // see the file header. One more backstop pass settles it.
        await settleFully(instanceB.baseUrl, adminToken, order.id, assertionClient);

        // ---------------------------------------------------------------
        // Everything from here queries Postgres directly, never the API.
        // ---------------------------------------------------------------
        const requestId = deriveTestRequestId(order.id);

        //   select order_id, code from deliveries where order_id = $1;
        const deliveredRows = await assertionClient.pool.query<{ order_id: string; code: string }>(
          `select order_id, code from deliveries where order_id = $1`,
          [order.id],
        );
        expect(deliveredRows.rowCount, "exactly one delivery row for this order").toBe(1);

        //   select status from issuance_attempts where order_id = $1;
        const attemptRows = await assertionClient.pool.query<{ status: string }>(
          `select status from issuance_attempts where order_id = $1`,
          [order.id],
        );
        expect(attemptRows.rowCount, "exactly one issuance_attempts row for this order").toBe(1);
        expect(attemptRows.rows[0]?.status, "the one attempt resolved to ok").toBe("ok");

        //   select request_id from supplier_requests where request_id = $1;
        const supplierRequestRows = await assertionClient.pool.query<{ request_id: string }>(
          `select request_id from supplier_requests where request_id = $1`,
          [requestId],
        );
        expect(supplierRequestRows.rowCount, "exactly one supplier_requests row — one supplier call, not two").toBe(
          1,
        );

        //   select count(*)::int from supplier_keys where claimed_by_request_id = $1;
        const claimedKeys = await assertionClient.pool.query<{ n: number }>(
          `select count(*)::int as n from supplier_keys where claimed_by_request_id = $1`,
          [requestId],
        );
        expect(claimedKeys.rows[0]?.n, "exactly one supplier_keys row claimed by this request").toBe(1);

        const unclaimedAfter = await countUnclaimedKeys(assertionClient);
        expect(unclaimedBefore - unclaimedAfter, "the unclaimed pool moved by exactly one key").toBe(1);

        //   select status from orders where id = $1;
        const orderRow = await assertionClient.pool.query<{ status: string }>(
          `select status from orders where id = $1`,
          [order.id],
        );
        expect(orderRow.rows[0]?.status, "the order finished delivered").toBe("delivered");

        const pendingLeft = await countPendingEventsForOrder(assertionClient, order.id);
        expect(pendingLeft, "no payment_events left pending for this order once things settle").toBe(0);
      } finally {
        await cleanupTestOrders(assertionClient, orderIds);
      }
    },
    30_000,
  );

  it(
    "a webhook continuation (process A) and the order-status-poll drain (process B) contend for the same order: " +
      "exactly one delivery, one claimed key, no double issuance",
    async () => {
      const instanceA = instanceAt(instances, 0);
      const instanceB = instanceAt(instances, 1);
      const orderIds: string[] = [];

      try {
        const order = await createOrder(instanceA.baseUrl);
        orderIds.push(order.id);

        const continuationEventId = `evt_test_${order.id}_continuation`;
        const drainEventId = `evt_test_${order.id}_drain`;

        // event 2: pending, so GET .../orders/:id's own EXISTS gate
        // (OrdersService.findOrder) sees it and schedules a drain.
        await insertPendingPaidEvent(assertionClient, drainEventId, order.id);

        const unclaimedBefore = await countUnclaimedKeys(assertionClient);

        // ---------------------------------------------------------------
        // THE RACE. Both requests fired at once, to two different processes.
        // ---------------------------------------------------------------
        const startedAt = Date.now();
        const { witness } = await observeDistinctBackendPidsDuring(pollerClient, "game-shop", async () =>
          Promise.all([
            // Process A: the webhook's own scheduled continuation (trigger 1).
            postPaidWebhookEvent(instanceA.baseUrl, continuationEventId, order.id),
            // Process B: the shopper's own status poll (trigger 3) — the read
            // itself just needs to happen; the drain it schedules is fired and
            // forgotten by the controller, never awaited by this request.
            fetchOrderView(instanceB.baseUrl, order.id),
          ]),
        );
        const elapsedMs = Date.now() - startedAt;

        console.log(
          `order-lock-race (continuation vs status-poll drain): raced in ${String(elapsedMs)}ms; ` +
            `distinct Postgres backend pids observed mid-flight: [${witness.distinctPids.join(", ")}] ` +
            `(${String(witness.samples)} pg_stat_activity samples taken during the window)`,
        );

        const settled = await waitUntilSettled(instanceA.baseUrl, order.id);
        expect(settled.status, `order ${order.id} settled as "${settled.status}", not "delivered"`).toBe(
          "delivered",
        );

        // The status poll's own drain never loops or retries (it is one pass,
        // fired off the response path) — the backstop here is the admin sweep,
        // exactly as architecture.md §4 describes it.
        await settleFully(instanceB.baseUrl, adminToken, order.id, assertionClient);

        // ---------------------------------------------------------------
        // Everything from here queries Postgres directly, never the API.
        // ---------------------------------------------------------------
        const requestId = deriveTestRequestId(order.id);

        const deliveredRows = await assertionClient.pool.query<{ order_id: string; code: string }>(
          `select order_id, code from deliveries where order_id = $1`,
          [order.id],
        );
        expect(deliveredRows.rowCount, "exactly one delivery row for this order").toBe(1);

        const attemptRows = await assertionClient.pool.query<{ status: string }>(
          `select status from issuance_attempts where order_id = $1`,
          [order.id],
        );
        expect(attemptRows.rowCount, "exactly one issuance_attempts row for this order").toBe(1);
        expect(attemptRows.rows[0]?.status, "the one attempt resolved to ok").toBe("ok");

        const supplierRequestRows = await assertionClient.pool.query<{ request_id: string }>(
          `select request_id from supplier_requests where request_id = $1`,
          [requestId],
        );
        expect(supplierRequestRows.rowCount, "exactly one supplier_requests row — one supplier call, not two").toBe(
          1,
        );

        const claimedKeys = await assertionClient.pool.query<{ n: number }>(
          `select count(*)::int as n from supplier_keys where claimed_by_request_id = $1`,
          [requestId],
        );
        expect(claimedKeys.rows[0]?.n, "exactly one supplier_keys row claimed by this request").toBe(1);

        const unclaimedAfter = await countUnclaimedKeys(assertionClient);
        expect(unclaimedBefore - unclaimedAfter, "the unclaimed pool moved by exactly one key").toBe(1);

        const orderRow = await assertionClient.pool.query<{ status: string }>(
          `select status from orders where id = $1`,
          [order.id],
        );
        expect(orderRow.rows[0]?.status, "the order finished delivered").toBe("delivered");

        const pendingLeft = await countPendingEventsForOrder(assertionClient, order.id);
        expect(pendingLeft, "no payment_events left pending for this order once things settle").toBe(0);
      } finally {
        await cleanupTestOrders(assertionClient, orderIds);
      }
    },
    30_000,
  );
});
