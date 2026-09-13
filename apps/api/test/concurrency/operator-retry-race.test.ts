// @layer: integration
// @spec: 003-failure-and-recovery
// @regression
/**
 * The executable proof of functional spec §2.5, *"an operator can push a stuck
 * order through, and pressing twice changes nothing"* — slice 5's own
 * verification task in `context/spec/003-failure-and-recovery/tasks.md`.
 *
 * ---------------------------------------------------------------------------
 * THIS MUST NOT BE A DOUBLE-CLICK TEST
 * ---------------------------------------------------------------------------
 * `technical-considerations.md` §9.4 states the reason in as many words: *"a
 * verification that clicks Retry twice in one browser and finds one key proves
 * only that the button was disabled; it cannot fail against a broken server,
 * therefore it cannot pass either."* Every race in this file fires concurrent
 * `POST /api/admin/orders/:orderId/retry` requests from **separate, real OS
 * processes** against the same Postgres, exactly as `./key-claim-race.test.ts`
 * and `./supplier-refusal-and-recovery.test.ts` do, and for the identical
 * reason: `packages/db/src/client.ts` gives every process a connection pool of
 * `max: 1`, so two claims inside one process can never both be open inside
 * Postgres at the same instant — see `./support/api-instance.ts`'s header for
 * the measured 20-callers/9-distinct-keys defect that a single-process
 * "concurrency" check would not have caught.
 *
 * ---------------------------------------------------------------------------
 * R2 — WHY EVERY TEST HERE ASSERTS STOCK ACCOUNTING, NOT JUST THE DELIVERY
 * ---------------------------------------------------------------------------
 * `deliveries.order_id` UNIQUE (I3) keeps the *shopper* to one key even when
 * the ladder's rules are broken, so "the shopper got exactly one key" is not
 * evidence the retry behaved. Every test below also asserts
 * `count(*) FROM supplier_keys WHERE claimed_by_request_id IS NOT NULL`
 * against `count(*) FROM deliveries`, scoped to this order's own request ids —
 * the assertion `technical-considerations.md` R2 names as the one that can
 * actually fail.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STRANDED-ORDER RACE STAGES ITS OWN FIXTURE WITH RAW SQL
 * ---------------------------------------------------------------------------
 * A `delivering` order with an outstanding `unknown` attempt whose ledger
 * already holds a code is the shape a worker leaves behind when it dies
 * *after* the supplier committed a claim but *before* the shop recorded the
 * answer — precisely `technical-considerations.md` §2.3's "stranded order".
 * There is no HTTP path that manufactures that shape on demand (it is a
 * platform failure, not a request), so this file stages it directly against
 * Postgres — the same posture `./order-lock-race.test.ts` takes with
 * `insertPendingPaidEvent`, and for the same reason: it is what lets the test
 * *choose*, rather than hope for, the exact race it is proving safe.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO RACES, NOT ONE
 * ---------------------------------------------------------------------------
 * `resumeIssuance`'s guard (`delivering → delivering`) **excludes nobody** —
 * `technical-considerations.md` §2.3 says so in as many words, and states that
 * what actually excludes a second resumer is the row lock *plus* the fact that
 * every concurrent resumer necessarily computes the same `probe` of the same
 * outstanding id. `retryIssuance`'s guard (`out_of_stock, delivery_failed →
 * delivering`), by contrast, **does** exclude: only one caller can observe the
 * order in a retryable status before the winner's claim moves it to
 * `delivering`. Both are exercised here, because they are different
 * mechanisms defending the same promise, and `technical-considerations.md`
 * §8's own race table predicts what the *loser* of the second race does next:
 * *"loser re-reads and takes resumeIssuance, which the ladder answers with a
 * probe."* That is not a `409` — it is `resumeIssuance` catching exactly the
 * caller `retryIssuance`'s guard excluded, which is why this file treats
 * "409, or a 200 that lands on the same outstanding id" as the honest set of
 * outcomes for that race, and asserts the database rather than guessing which
 * HTTP status the loser gets.
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
  observeDistinctBackendPidsDuring,
  readBaselineCounts,
} from "./support/db.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
/** `apps/api` — two levels up from `test/concurrency`. */
const API_ROOT = resolve(TEST_DIR, "..", "..");
/** The repository root — where `pnpm run build:packages` resolves from. */
const REPO_ROOT = resolve(API_ROOT, "..", "..");

/**
 * Four real processes — the number this slice's own task names ("verify
 * across four processes"), and the same number `./key-claim-race.test.ts` and
 * `./supplier-refusal-and-recovery.test.ts` use. Ports clear of every other
 * concurrency suite's range (4101, 4401, 4501, 4701).
 */
const PROCESS_COUNT = 4;
const BASE_PORT = 4801;

/** The full pool size — `packages/db/src/fixtures/supplier-key-pool.ts`. */
const KEY_POOL_SIZE = 50;

function delay(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

/**
 * `req_{order_id}_{provider}_{attempt}` — reproduced from
 * `apps/api/src/issuance/issuance-request-id.ts` (`deriveIssuanceRequestId`),
 * transcribed rather than imported for the reason every sibling suite gives:
 * a bug that changed the derivation in the application and in a shared test
 * helper together would still pass.
 */
function requestIdFor(orderId: string, provider: "a" | "b", attempt: number): string {
  return `req_${orderId}_${provider}_${String(attempt)}`;
}

interface AttemptRow {
  readonly request_id: string;
  readonly order_id: string;
  readonly provider: string;
  readonly attempt: number;
  readonly status: string;
  readonly last_error: string | null;
  readonly probe_count: number;
}

interface RetryResponse {
  readonly status: number;
  readonly body: Record<string, unknown> | undefined;
}

describe("functional spec §2.5 — an operator can push a stuck order through, and pressing twice changes nothing", () => {
  let instances: RunningInstance[] = [];
  let assertionClient: DatabaseClient;
  let pollerClient: DatabaseClient;
  let adminToken: string;
  let cursor = 0;

  /** Round-robins setup calls across all four processes — see the sibling suites' identical reasoning. */
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

  async function payOrder(orderId: string): Promise<SimulatedPaymentAck> {
    const response = await fetch(`${nextInstance().baseUrl}/api/payments/${orderId}/simulate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "success" }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`POST /api/payments/${orderId}/simulate -> ${String(response.status)}: ${text}`);
    }
    return JSON.parse(text) as SimulatedPaymentAck;
  }

  async function fetchOrderView(orderId: string): Promise<OrderView> {
    const response = await fetch(`${nextInstance().baseUrl}/api/orders/${orderId}`);
    if (!response.ok) throw new Error(`GET /api/orders/${orderId} -> ${String(response.status)}`);
    return (await response.json()) as OrderView;
  }

  /** `PUT /internal/suppliers/:provider/behaviour` — full five-field body, per the `PUT` replaces contract. */
  async function armBehaviour(
    provider: "a" | "b",
    settings: { readonly fail_next?: number },
  ): Promise<void> {
    const body = {
      failure_rate: 0,
      hang_rate: 0,
      hang_ms: 0,
      fail_next: settings.fail_next ?? 0,
      hang_next: 0,
    };
    const response = await fetch(`${nextInstance().baseUrl}/internal/suppliers/${provider}/behaviour`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`PUT /internal/suppliers/${provider}/behaviour -> ${String(response.status)}: ${text}`);
    }
  }

  /** `{}` — the documented reset to the seeded all-zero baseline (`hang_before_claim` included). */
  async function resetBehaviour(provider: "a" | "b"): Promise<void> {
    const response = await fetch(`${nextInstance().baseUrl}/internal/suppliers/${provider}/behaviour`, {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`PUT /internal/suppliers/${provider}/behaviour (reset) -> ${String(response.status)}: ${text}`);
    }
  }

  const SETTLE_POLL_INTERVAL_MS = 25;
  const SETTLE_TIMEOUT_MS = 15_000;

  async function waitUntilSettled(orderId: string): Promise<OrderView> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    for (;;) {
      const view = await fetchOrderView(orderId);
      if (
        view.status === "delivered" ||
        view.status === "out_of_stock" ||
        view.status === "delivery_failed" ||
        view.status === "payment_failed"
      ) {
        return view;
      }
      if (Date.now() > deadline) {
        throw new Error(`order ${orderId} did not settle within ${String(SETTLE_TIMEOUT_MS)}ms (status=${view.status})`);
      }
      await delay(SETTLE_POLL_INTERVAL_MS);
    }
  }

  /** `POST /api/admin/orders/:orderId/retry` against a specific instance — never round-robined for the races, so the caller controls which of the four processes each concurrent request hits. */
  async function retryOn(instance: RunningInstance, orderId: string): Promise<RetryResponse> {
    const response = await fetch(`${instance.baseUrl}/api/admin/orders/${orderId}/retry`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
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

  async function readAttempts(orderId: string): Promise<AttemptRow[]> {
    const { rows } = await assertionClient.pool.query<AttemptRow>(
      `select request_id, order_id, provider, attempt, status, last_error, probe_count
         from issuance_attempts where order_id = $1 order by attempt asc`,
      [orderId],
    );
    return rows;
  }

  async function countDeliveries(orderId: string): Promise<number> {
    const { rows } = await assertionClient.pool.query<{ n: number }>(
      `select count(*)::int as n from deliveries where order_id = $1`,
      [orderId],
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * R2, scoped to one order's own request ids and its own delivery row rather
   * than compared globally — this file's own tests run sequentially in one
   * process (`fileParallelism: false`, `apps/api/vitest.config.ts`) but a
   * global comparison would still have to account for every earlier test's
   * own baseline-restoring cleanup, so scoping to one order is the assertion
   * that is unambiguous on its own.
   */
  async function readScopedStockAccounting(
    orderId: string,
    requestIds: readonly string[],
  ): Promise<{ claimedKeys: number; deliveries: number }> {
    const claimed = await assertionClient.pool.query<{ n: number }>(
      `select count(*)::int as n from supplier_keys where claimed_by_request_id = any($1::text[])`,
      [requestIds],
    );
    return { claimedKeys: claimed.rows[0]?.n ?? 0, deliveries: await countDeliveries(orderId) };
  }

  async function countUnclaimedKeys(): Promise<number> {
    const { rows } = await assertionClient.pool.query<{ n: number }>(
      `select count(*)::int as n from supplier_keys where claimed_by_request_id is null`,
    );
    return rows[0]?.n ?? 0;
  }

  /** The out-of-stock scenario's sentinel — see `supplier-refusal-and-recovery.test.ts`'s header for why draining directly, rather than buying out fifty keys, is the right shape for this. */
  const DRAIN_SENTINEL = "test_sentinel_drain_003_slice5";

  async function drainKeyPool(): Promise<number> {
    const { rowCount } = await assertionClient.pool.query(
      `update supplier_keys
          set claimed_by_request_id = $1 || '_' || id::text, claimed_at = now()
        where claimed_by_request_id is null`,
      [DRAIN_SENTINEL],
    );
    return rowCount ?? 0;
  }

  async function restoreDrainedKeyPool(): Promise<void> {
    await assertionClient.pool.query(
      `update supplier_keys set claimed_by_request_id = null, claimed_at = null
         where claimed_by_request_id like $1`,
      [`${DRAIN_SENTINEL}_%`],
    );
  }

  /**
   * Stage the shape a worker that died leaves behind
   * (`technical-considerations.md` §2.3): the order sits in `delivering`, one
   * `issuance_attempts` row says `unknown` with `probe_count = 1`, and the
   * supplier's own ledger (`supplier_requests` + `supplier_keys`) already holds
   * a real, claimed key against that exact `request_id` — a key genuinely cut,
   * whose answer the shop never recorded.
   *
   * Raw SQL, not a claimed-then-abandoned HTTP call: there is no request that
   * manufactures this shape (it is what a platform kill mid-ladder leaves, R5),
   * so this is staged the same way `./order-lock-race.test.ts`'s
   * `insertPendingPaidEvent` stages its own otherwise-unreachable shape.
   */
  async function stageStrandedDeliveringOrder(orderId: string): Promise<{ requestId: string; code: string }> {
    const requestId = requestIdFor(orderId, "a", 1);

    await assertionClient.pool.query(
      `update orders set status = 'delivering', updated_at = now() where id = $1`,
      [orderId],
    );

    const claimed = await assertionClient.pool.query<{ code: string }>(
      `update supplier_keys
          set claimed_by_request_id = $1, claimed_at = now()
        where code = (
          select code from supplier_keys
           where claimed_by_request_id is null
           order by id
             for update skip locked
           limit 1
        )
        returning code`,
      [requestId],
    );
    const code = claimed.rows[0]?.code;
    if (code === undefined) {
      throw new Error("stageStrandedDeliveringOrder: no unclaimed key available to stage the fixture with");
    }

    await assertionClient.pool.query(
      `insert into supplier_requests (request_id, provider, code) values ($1, 'a', $2)`,
      [requestId, code],
    );

    await assertionClient.pool.query(
      `insert into issuance_attempts (request_id, order_id, provider, attempt, status, probe_count)
       values ($1, $2, 'a', 1, 'unknown', 1)`,
      [requestId, orderId],
    );

    return { requestId, code };
  }

  interface UndeliveredReport {
    readonly orders: readonly { readonly order_id: string }[];
  }

  async function fetchUndeliveredOrderIds(): Promise<Set<string>> {
    const response = await fetch(`${nextInstance().baseUrl}/api/admin/orders/undelivered`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    if (!response.ok) throw new Error(`GET /api/admin/orders/undelivered -> ${String(response.status)}`);
    const report = (await response.json()) as UndeliveredReport;
    return new Set(report.orders.map((order) => order.order_id));
  }

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
      throw new Error(
        "ADMIN_TOKEN is not set (or shorter than 16 chars), and this suite drives the retry " +
          "endpoint and supplier behaviour through their guarded control surfaces. See .env.example.",
      );
    }
    adminToken = token;

    assertionClient = createTestDatabaseClient("assert-retry-race");
    pollerClient = createTestDatabaseClient("poll-retry-race");
    assertBaseline(await readBaselineCounts(assertionClient), "before");

    console.log("operator-retry-race: building @game-shop/db, @game-shop/contracts and @game-shop/api...");
    execFileSync("pnpm", ["run", "build:packages"], { cwd: REPO_ROOT, stdio: "inherit" });
    execFileSync("pnpm", ["--filter", "@game-shop/api", "run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });

    instances = await Promise.all(
      Array.from({ length: PROCESS_COUNT }, async (_, index) =>
        startApiInstance({ apiRoot: API_ROOT, port: BASE_PORT + index, databaseUrl }),
      ),
    );
    console.log(
      `operator-retry-race: ${String(instances.length)} apps/api processes healthy on ports ` +
        `${instances.map((instance) => String(instance.port)).join(", ")} ` +
        `(pids ${instances.map((instance) => String(instance.pid)).join(", ")})`,
    );
  }, 120_000);

  afterAll(async () => {
    await stopAllApiInstances(instances);

    if (assertionClient !== undefined) {
      // Belt and braces beyond each test's own `finally` — see
      // `supplier-refusal-and-recovery.test.ts`'s identical afterAll for why
      // this runs over direct SQL after the instances are already stopped.
      await assertionClient.pool.query(
        `update supplier_behaviour
           set failure_rate = 0, hang_rate = 0, hang_ms = 0, fail_next = 0, hang_next = 0,
               hang_before_claim = false, updated_at = now()`,
      );

      assertBaseline(await readBaselineCounts(assertionClient), "after");
      await assertionClient.close();
    }
    if (pollerClient !== undefined) await pollerClient.close();
  }, 60_000);

  it(
    "restock after an empty pool, then retry: exactly one key, a THIRD attempt row (a/3, never a reused a/1 — R7), " +
      "the order leaves the recovery list, and every further retry is refused (409) and changes nothing",
    async () => {
      expect(await countUnclaimedKeys(), "precondition: the pool is full before draining it").toBe(KEY_POOL_SIZE);
      const drained = await drainKeyPool();
      expect(drained).toBe(KEY_POOL_SIZE);

      const order = await createOrder();
      const orderIds = [order.id];

      try {
        const ack = await payOrder(order.id);
        expect(ack.webhook_outcome).toBe("stored");

        const stuck = await waitUntilSettled(order.id);
        expect(stuck.status, "an empty pool settles out_of_stock, the operator's starting point").toBe(
          "out_of_stock",
        );

        const attemptsBeforeRetry = await readAttempts(order.id);
        expect(attemptsBeforeRetry, "the empty-pool walk leaves two refusals on file").toHaveLength(2);

        expect((await fetchUndeliveredOrderIds()).has(order.id), "a stuck order is on the recovery list").toBe(
          true,
        );

        // ---------------------------------------------------------------
        // THE RESTOCK. §2.5 criterion 2: stock replenished, operator retries.
        // ---------------------------------------------------------------
        await restoreDrainedKeyPool();
        expect(await countUnclaimedKeys(), "restocked to the full pool").toBe(KEY_POOL_SIZE);

        const retried = await retryOn(nextInstance(), order.id);
        expect(retried.status, `POST .../retry -> ${JSON.stringify(retried.body)}`).toBe(200);
        expect(retried.body?.["outcome"]).toBe("delivered");
        expect(retried.body?.["delivered"]).toBe(true);

        const finished = await waitUntilSettled(order.id);
        expect(finished.status).toBe("delivered");

        // §2.5 criterion 1: the order leaves the recovery list.
        expect(
          (await fetchUndeliveredOrderIds()).has(order.id),
          "a delivered order must no longer appear in the recovery list",
        ).toBe(false);

        // ---------------------------------------------------------------
        // R7 — the retry mints attempt 3, never reusing attempt 1.
        // ---------------------------------------------------------------
        const attemptsAfterRetry = await readAttempts(order.id);
        expect(attemptsAfterRetry, "a/1 and b/2's original refusals, plus one new row").toHaveLength(3);

        const [first, second, third] = attemptsAfterRetry;
        expect(first?.provider).toBe("a");
        expect(first?.attempt).toBe(1);
        expect(first?.status).toBe("failed");
        expect(first?.last_error).toBe("out_of_stock");

        expect(second?.provider).toBe("b");
        expect(second?.attempt).toBe(2);
        expect(second?.status).toBe("failed");

        expect(third?.provider, "R7: the retry re-asks the FIRST supplier in the ladder").toBe("a");
        expect(third?.attempt, "R7: attempt 3, numbered per order across both providers — never a second attempt 1").toBe(
          3,
        );
        expect(third?.status).toBe("ok");
        expect(third?.request_id).toBe(requestIdFor(order.id, "a", 3));
        expect(
          third?.request_id,
          "the request id must never collide with the original, settled a/1",
        ).not.toBe(requestIdFor(order.id, "a", 1));

        // §2.5 criterion 2: exactly one key, exactly one delivery.
        expect(await countDeliveries(order.id), "exactly one delivery").toBe(1);
        const requestIds = [
          requestIdFor(order.id, "a", 1),
          requestIdFor(order.id, "b", 2),
          requestIdFor(order.id, "a", 3),
        ];
        const accounting = await readScopedStockAccounting(order.id, requestIds);
        expect(accounting.claimedKeys, "R2: exactly one key claimed by this order's own request ids").toBe(1);
        expect(accounting.claimedKeys, "R2: claimed keys equal deliveries on this settled outcome").toBe(
          accounting.deliveries,
        );

        // ---------------------------------------------------------------
        // §2.5 criterion 3 and 6: pressing retry repeatedly on a non-stuck
        // order is refused every time and changes nothing — not a double-
        // click test (this is three SEPARATE HTTP requests, each fully
        // resolved before the next is sent, against an order this suite has
        // already independently confirmed reached `delivered`).
        // ---------------------------------------------------------------
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const refused = await retryOn(nextInstance(), order.id);
          expect(refused.status, `retry #${String(attempt + 1)} on a delivered order must be refused`).toBe(409);
        }

        expect(await readAttempts(order.id), "repeated refusals write nothing new").toHaveLength(3);
        expect(await countDeliveries(order.id), "repeated refusals mint no second delivery").toBe(1);
        const accountingAfterRepeats = await readScopedStockAccounting(order.id, requestIds);
        expect(accountingAfterRepeats.claimedKeys, "repeated refusals claim no second key").toBe(1);
      } finally {
        await cleanupTestOrders(assertionClient, orderIds);
        await restoreDrainedKeyPool();
      }

      expect(await countUnclaimedKeys(), "the pool is back to full after cleanup").toBe(KEY_POOL_SIZE);
    },
    30_000,
  );

  it(
    "two concurrent retries on a STRANDED delivering order (resumeIssuance): exactly one delivery, " +
      "one claimed key, claimed keys == deliveries, and no second request id anywhere",
    async () => {
      const order = await createOrder();
      const orderIds = [order.id];

      try {
        const staged = await stageStrandedDeliveringOrder(order.id);

        const unclaimedBefore = await countUnclaimedKeys();

        // ---------------------------------------------------------------
        // THE RACE. Two processes, one Promise.all — never sequential.
        // resumeIssuance's guard excludes nobody (technical-considerations.md
        // §2.3): what has to exclude the second caller is the row lock plus
        // both resumers computing the identical `probe` of `staged.requestId`.
        // ---------------------------------------------------------------
        const startedAt = Date.now();
        const { result: responses, witness } = await observeDistinctBackendPidsDuring(
          pollerClient,
          "game-shop",
          async () => Promise.all([retryOn(instanceAt(0), order.id), retryOn(instanceAt(1), order.id)]),
        );
        const elapsedMs = Date.now() - startedAt;

        console.log(
          `operator-retry-race (stranded delivering, two resumers): raced in ${String(elapsedMs)}ms; ` +
            `responses=[${responses.map((r) => String(r.status)).join(", ")}]; ` +
            `distinct Postgres backend pids observed mid-flight: [${witness.distinctPids.join(", ")}] ` +
            `(${String(witness.samples)} pg_stat_activity samples)`,
        );

        for (const response of responses) {
          expect(response.status, `each concurrent retry must be answered honestly: ${JSON.stringify(response.body)}`).not.toBe(
            500,
          );
          expect([200, 409]).toContain(response.status);
        }

        const finished = await waitUntilSettled(order.id);
        expect(finished.status, "the stranded order must resolve to delivered via the pre-staged code").toBe(
          "delivered",
        );

        // -----------------------------------------------------------------
        // THE INVARIANT THIS RACE EXISTS TO PROVE: no second request id was
        // ever minted. Both resumers, however they interleaved, could only
        // ever compute a probe of `staged.requestId` — never a fresh ask.
        // -----------------------------------------------------------------
        const attempts = await readAttempts(order.id);
        expect(attempts, "no second attempt row was ever created — the outstanding one is the only one").toHaveLength(
          1,
        );
        expect(attempts[0]?.request_id).toBe(staged.requestId);
        expect(attempts[0]?.provider).toBe("a");
        expect(attempts[0]?.attempt).toBe(1);
        expect(attempts[0]?.status, "the outstanding attempt is finally resolved to ok").toBe("ok");
        expect(
          attempts[0]?.probe_count,
          "both resumers probed the same row — probe_count moved 1 -> 2 -> 3",
        ).toBe(3);

        const { rows: ledgerRows } = await assertionClient.pool.query<{ request_id: string }>(
          `select request_id from supplier_requests where request_id like $1`,
          [`req_${order.id}_%`],
        );
        expect(
          ledgerRows.map((row) => row.request_id),
          "no second request id ever reached the supplier's ledger",
        ).toEqual([staged.requestId]);

        expect(await countDeliveries(order.id), "exactly one delivery").toBe(1);

        const requestIds = [staged.requestId];
        const accounting = await readScopedStockAccounting(order.id, requestIds);
        expect(accounting.claimedKeys, "no NEW key left the pool beyond the one this test staged").toBe(1);
        expect(accounting.claimedKeys, "R2: claimed keys equal deliveries").toBe(accounting.deliveries);

        const unclaimedAfter = await countUnclaimedKeys();
        expect(
          unclaimedAfter,
          "the unclaimed pool did not move at all — the code came from the pre-staged claim, not a new one",
        ).toBe(unclaimedBefore);
      } finally {
        await cleanupTestOrders(assertionClient, orderIds);
      }
    },
    30_000,
  );

  it(
    "two concurrent retries on a delivery_failed order (retryIssuance): one delivery, one NEW attempt row " +
      "(never two), claimed keys == deliveries — both may honestly report 'delivered'",
    async () => {
      await armBehaviour("a", { fail_next: 1 });
      await armBehaviour("b", { fail_next: 1 });

      const order = await createOrder();
      const orderIds = [order.id];

      try {
        const ack = await payOrder(order.id);
        expect(ack.webhook_outcome).toBe("stored");

        const stuck = await waitUntilSettled(order.id);
        expect(stuck.status, "both suppliers definitely refusing settles delivery_failed").toBe("delivery_failed");

        const attemptsBefore = await readAttempts(order.id);
        expect(attemptsBefore).toHaveLength(2);

        // ---------------------------------------------------------------
        // THE RACE. retryIssuance's guard DOES exclude: only the winner can
        // observe the order in {out_of_stock, delivery_failed}. Whichever
        // request loses that race is either a clean 409 (genuinely too late —
        // the winner had already finished) or a 200 that lands on
        // resumeIssuance + probe of the SAME new attempt the winner reserved
        // (technical-considerations.md §8's own race table: "loser re-reads
        // and takes resumeIssuance, which the ladder answers with a probe").
        //
        // MEASURED: both responses came back `200 delivered` in every run of
        // this suite. That is not a double-issue — it is
        // `IssuanceService.finishOrder`'s `NotInSourceState` branch (spec 002's
        // machinery, unchanged) returning `result.observed.status` rather than
        // `undefined`: a loser whose own `completeDelivery` transition matches
        // zero rows still reads the order's CURRENT status, finds it already
        // `delivered`, and `reportDelivery` treats "the order is now delivered"
        // as delivered — honestly, since the shopper genuinely does hold the
        // code this call itself fetched (the same code, off the same ledger
        // row). Reporting anything else to the second operator would be the
        // lie: the retry did obtain the right key, it simply was not the one
        // that got to write it down. A fixed HTTP status for the loser is
        // therefore not asserted — the database invariants below are.
        // ---------------------------------------------------------------
        const startedAt = Date.now();
        const { result: responses, witness } = await observeDistinctBackendPidsDuring(
          pollerClient,
          "game-shop",
          async () => Promise.all([retryOn(instanceAt(2), order.id), retryOn(instanceAt(3), order.id)]),
        );
        const elapsedMs = Date.now() - startedAt;

        console.log(
          `operator-retry-race (delivery_failed, two retries): raced in ${String(elapsedMs)}ms; ` +
            `responses=[${responses.map((r) => `${String(r.status)}:${String(r.body?.["outcome"])}`).join(", ")}]; ` +
            `distinct Postgres backend pids observed mid-flight: [${witness.distinctPids.join(", ")}] ` +
            `(${String(witness.samples)} pg_stat_activity samples)`,
        );

        for (const response of responses) {
          expect(response.status, `each concurrent retry must be answered honestly: ${JSON.stringify(response.body)}`).not.toBe(
            500,
          );
          expect([200, 409]).toContain(response.status);
        }
        expect(
          responses.some((response) => response.status === 200),
          "at least one of the two concurrent retries must have actually run",
        ).toBe(true);

        const finished = await waitUntilSettled(order.id);
        expect(finished.status, "the order must reach delivered — the pool was never armed to fail").toBe(
          "delivered",
        );

        // THE INVARIANT: exactly one NEW attempt row, never two — whichever
        // process lost the retryIssuance race never reserved a second one.
        const attemptsAfter = await readAttempts(order.id);
        expect(
          attemptsAfter,
          "a/1, b/2 (both pre-existing refusals) plus exactly ONE new row — never a rogue fourth",
        ).toHaveLength(3);
        const newest = attemptsAfter[2];
        expect(newest?.provider).toBe("a");
        expect(newest?.attempt, "R7: attempt 3, never a reused attempt 1").toBe(3);
        expect(newest?.status).toBe("ok");
        expect(newest?.request_id).toBe(requestIdFor(order.id, "a", 3));

        expect(await countDeliveries(order.id), "exactly one delivery, however the race interleaved").toBe(1);

        const requestIds = [
          requestIdFor(order.id, "a", 1),
          requestIdFor(order.id, "b", 2),
          requestIdFor(order.id, "a", 3),
        ];
        const accounting = await readScopedStockAccounting(order.id, requestIds);
        expect(accounting.claimedKeys, "exactly one key claimed for this order, not two").toBe(1);
        expect(accounting.claimedKeys, "R2: claimed keys equal deliveries").toBe(accounting.deliveries);
      } finally {
        await resetBehaviour("a");
        await resetBehaviour("b");
        await cleanupTestOrders(assertionClient, orderIds);
      }

      expect(await countUnclaimedKeys(), "pool returns to full after cleanup").toBe(KEY_POOL_SIZE);
    },
    30_000,
  );

  it("a stuck order with no key available: the retry reports it plainly and the order stays in the list", async () => {
    expect(await countUnclaimedKeys(), "precondition: the pool is full before draining it").toBe(KEY_POOL_SIZE);
    const drained = await drainKeyPool();
    expect(drained).toBe(KEY_POOL_SIZE);

    const order = await createOrder();
    const orderIds = [order.id];

    try {
      const ack = await payOrder(order.id);
      expect(ack.webhook_outcome).toBe("stored");

      const stuck = await waitUntilSettled(order.id);
      expect(stuck.status).toBe("out_of_stock");

      // §2.5 criterion 5: retried with STILL no key available.
      const retried = await retryOn(nextInstance(), order.id);
      expect(retried.status, `still-empty retry -> ${JSON.stringify(retried.body)}`).toBe(200);
      expect(retried.body?.["outcome"]).toBe("still_out_of_stock");
      expect(retried.body?.["delivered"]).toBe(false);
      expect(
        typeof retried.body?.["detail"] === "string" && (retried.body["detail"] as string).length > 0,
        "the operator must be told WHY, in words, not just refused",
      ).toBe(true);

      const afterRetry = await fetchOrderView(order.id);
      expect(afterRetry.status, "still stuck, not delivered, not silently dropped").toBe("out_of_stock");
      expect(
        (await fetchUndeliveredOrderIds()).has(order.id),
        "a retry that ran but found nothing to deliver leaves the order in the recovery list",
      ).toBe(true);

      expect(await countDeliveries(order.id), "no delivery when the pool never had anything to give").toBe(0);
    } finally {
      await cleanupTestOrders(assertionClient, orderIds);
      await restoreDrainedKeyPool();
    }

    expect(await countUnclaimedKeys(), "the pool is back to full after cleanup").toBe(KEY_POOL_SIZE);
  });

  it(
    "an operator retry whose own probes exhaust (settleNeverEstablished): back to delivery_failed, the attempt " +
      "stays `unknown` with `last_error` NULL, and R2's amended bound holds — at most one unaccounted key",
    async () => {
      const order = await createOrder();
      const orderIds = [order.id];

      try {
        // Stage the shape a retry that itself never gets an answer leaves
        // behind: two ordinary refusals already on file, and a THIRD attempt
        // whose probe budget is already spent — direct SQL, for the same
        // reason `stageStrandedDeliveringOrder` above is staged directly:
        // there is no HTTP path that manufactures "an outstanding attempt
        // with its budget already exhausted" on demand.
        await assertionClient.pool.query(
          `update orders set status = 'delivery_failed', updated_at = now() where id = $1`,
          [order.id],
        );
        await assertionClient.pool.query(
          `insert into issuance_attempts (request_id, order_id, provider, attempt, status, last_error, probe_count)
           values ($1, $2, 'a', 1, 'failed', 'out_of_stock', 1)`,
          [requestIdFor(order.id, "a", 1), order.id],
        );
        await assertionClient.pool.query(
          `insert into issuance_attempts (request_id, order_id, provider, attempt, status, last_error, probe_count)
           values ($1, $2, 'b', 2, 'failed', 'out_of_stock', 1)`,
          [requestIdFor(order.id, "b", 2), order.id],
        );
        const staleRequestId = requestIdFor(order.id, "a", 3);
        await assertionClient.pool.query(
          `insert into issuance_attempts (request_id, order_id, provider, attempt, status, probe_count)
           values ($1, $2, 'a', 3, 'unknown', 3)`,
          [staleRequestId, order.id],
        );

        // The honest meaning of `unknown`: a key MAY genuinely have been cut
        // by the supplier for this exact id, with the shop never learning the
        // code. Staged directly, exactly as the stranded-order fixture above.
        const claimed = await assertionClient.pool.query<{ code: string }>(
          `update supplier_keys
              set claimed_by_request_id = $1, claimed_at = now()
            where code = (
              select code from supplier_keys
               where claimed_by_request_id is null
               order by id
                 for update skip locked
               limit 1
            )
            returning code`,
          [staleRequestId],
        );
        expect(claimed.rowCount, "precondition: a key was available to stage the fixture with").toBe(1);
        await assertionClient.pool.query(
          `insert into supplier_requests (request_id, provider, code) values ($1, 'a', $2)`,
          [staleRequestId, claimed.rows[0]?.code],
        );

        // ---------------------------------------------------------------
        // THE RETRY. Reads the ledger under the lock, finds a/3 outstanding
        // with its probe budget already spent, and MUST settle as
        // never-established rather than asking a new supplier — the same
        // guard as always (branches 2/3 outrank branch 6), now exercised from
        // the operator's `Fresh` entry rather than a `Continuing` one.
        // ---------------------------------------------------------------
        const retried = await retryOn(nextInstance(), order.id);
        expect(retried.status, `retry -> ${JSON.stringify(retried.body)}`).toBe(200);
        expect(
          retried.body?.["outcome"],
          "never-established is reported as unresolved, never as a definite failure",
        ).toBe("unresolved");
        expect(retried.body?.["outstanding_request_id"]).toBe(staleRequestId);
        expect(retried.body?.["delivered"]).toBe(false);

        const finished = await fetchOrderView(order.id);
        expect(finished.status, "settleNeverEstablished lands back on delivery_failed").toBe("delivery_failed");

        const attempts = await readAttempts(order.id);
        expect(attempts).toHaveLength(3);
        const outstanding = attempts.find((row) => row.request_id === staleRequestId);
        expect(
          outstanding?.status,
          "settleNeverEstablished writes NOTHING to issuance_attempts — the row still reads unknown",
        ).toBe("unknown");
        expect(
          outstanding?.last_error,
          "the honest meaning of unknown: no error recorded, because nobody knows",
        ).toBeNull();
        expect(outstanding?.probe_count).toBe(3);

        // R2, AS AMENDED for a never-established outcome. No delivery exists
        // — nothing was ever bound — but a key genuinely left the pool under
        // this exact request id. "claimed == delivered" does NOT hold here,
        // and that is the correct, bounded exception R2 states rather than a
        // fault: at most one key unaccounted for, one per outstanding attempt.
        expect(await countDeliveries(order.id), "no delivery — the outcome was never established").toBe(0);
        const accounting = await readScopedStockAccounting(order.id, [
          requestIdFor(order.id, "a", 1),
          requestIdFor(order.id, "b", 2),
          staleRequestId,
        ]);
        expect(accounting.claimedKeys, "exactly the one staged key — never zero, never two").toBe(1);
        expect(
          accounting.claimedKeys - accounting.deliveries,
          "R2's bounded case: at most one unaccounted key, and here it is exactly one — one outstanding attempt",
        ).toBe(1);
      } finally {
        await cleanupTestOrders(assertionClient, orderIds);
      }

      expect(await countUnclaimedKeys(), "the pool is back to full after cleanup").toBe(KEY_POOL_SIZE);
    },
    30_000,
  );
});
