// @layer: integration
// @spec: 003-failure-and-recovery
// @regression
/**
 * The executable proof of functional spec §2.1, *"a supplier that refuses is
 * replaced by the backup"* — slice 2's own verification task in
 * `context/spec/003-failure-and-recovery/tasks.md`.
 *
 * ---------------------------------------------------------------------------
 * THIS IS A RE-RUN. THE FIRST RUN FOUND A REAL PLANNING BUG.
 * ---------------------------------------------------------------------------
 * The first attempt at this task reported `STATUS: BLOCKED`: slice 2's own task
 * list wrote the control endpoint (`PUT /internal/suppliers/:provider/behaviour`)
 * and the `fail_next` counter in one task, and deferred "wire the refusal into
 * the stubs" to slice 3 in the plan as originally drafted. `fail_next` therefore
 * round-tripped through the endpoint and **nothing read it** — no code path in
 * either stub called `SupplierBehaviourService.shouldRefuse`, so a supplier
 * could never be made to refuse and §2.1's headline scenario (main supplier
 * refuses, backup delivers) was not exercisable at all. That is the RED this
 * suite's own history already produced, by a route this file does not need to
 * repeat: a real gap, found by trying to verify the thing, not by weakening
 * working code.
 *
 * A follow-up task ("Wire refusal injection into both stub controllers…") was
 * added mid-slice specifically because that report surfaced the hole, and
 * `../../src/suppliers/a/supplier-a.controller.ts` /
 * `../../src/suppliers/b/supplier-b.controller.ts` now call
 * `this.behaviour.shouldRefuse(...)` before the key claim, in both stubs. This
 * suite is the independent re-verification that the wiring is real: it does not
 * trust the implementer's own report, it rebuilds from source and drives four
 * separate `apps/api` processes exactly as `./key-claim-race.test.ts` does.
 *
 * ---------------------------------------------------------------------------
 * WHY FOUR PROCESSES, NOT `Promise.all` INSIDE ONE
 * ---------------------------------------------------------------------------
 * See `./support/api-instance.ts`'s header and `./key-claim-race.test.ts`'s: a
 * single process's `max: 1` connection pool queues concurrent work in Node
 * before Postgres ever sees it, which is beside the point here anyway — this
 * suite's point is different and just as real. `supplier_behaviour` is a
 * database row precisely *because* `pnpm race` and a real deployment both run
 * several processes, and "an in-process rate reaches none of the others"
 * (`../../src/suppliers/supplier-behaviour.service.ts`). A single-process check
 * would prove nothing about that property. Every HTTP call this suite makes —
 * arming a supplier, creating the order, paying it, reading the result — is
 * round-robined across four independently-started `dist/main.js` processes
 * (`nextInstance()` below), so a passing run is evidence that the behaviour row
 * this suite writes through instance 1 is actually read by instance 3's stub.
 *
 * ---------------------------------------------------------------------------
 * R2 — WHY EVERY TEST HERE ASSERTS STOCK ACCOUNTING, NOT JUST THE DELIVERY
 * ---------------------------------------------------------------------------
 * `technical-considerations.md` §11, R2, restated because it is this phase's
 * one recurring trap: `deliveries.order_id` UNIQUE keeps the *shopper* to one
 * key even when the ladder's rules are broken, so "the shopper got exactly one
 * key" is not evidence the ladder behaved. The assertion that can actually fail
 * is `count(*) FROM supplier_keys WHERE claimed_by_request_id IS NOT NULL`
 * against `count(*) FROM deliveries` — every key the supplier's ledger says left
 * the pool must correspond to a delivery, no more and no fewer. Every test below
 * checks this in addition to, never instead of, the delivery/attempt-row shape.
 *
 * ---------------------------------------------------------------------------
 * `PUT` REPLACES, IT DOES NOT MERGE
 * ---------------------------------------------------------------------------
 * `supplier-behaviour.controller.ts`'s header states the contract: an omitted
 * field resets to the seeded baseline. Every `armBehaviour(...)` call below
 * therefore sends the full five-field body, even when only `fail_next` is the
 * point of the test — a body of `{ fail_next: 1 }` alone would leave `hang_ms`
 * at its baseline `0`, which happens to be harmless here, but the full body is
 * what makes each test's intent unambiguous and immune to a baseline changing
 * under it later. `resetBehaviour(...)` sends `{}`, the documented reset button.
 *
 * ---------------------------------------------------------------------------
 * WHY THE OUT-OF-STOCK CASE DRAINS THE POOL DIRECTLY, RATHER THAN BUYING 50 KEYS
 * ---------------------------------------------------------------------------
 * `packages/db/src/schema/supplier.ts` states the rule for production code:
 * "there is no 'unclaim'". `./support/db.ts`'s `cleanupTestOrders` already
 * breaks that rule deliberately, in the same file's own words, for the same
 * reason this suite does: "restoring `claimed_by_request_id = NULL` is a thing
 * only a test may do." Buying out fifty real keys to reach an empty pool would
 * work, but it says nothing this suite needs that draining the pool directly
 * does not, and it would leave forty-nine unrelated delivery rows for this
 * suite's own cleanup to unwind. `drainKeyPool`/`restoreKeyPool` below claim and
 * release the whole pool under one recognisable sentinel value instead.
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
  readBaselineCounts,
} from "./support/db.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
/** `apps/api` — two levels up from `test/concurrency`. */
const API_ROOT = resolve(TEST_DIR, "..", "..");
/** The repository root — where `pnpm run build:packages` resolves from. */
const REPO_ROOT = resolve(API_ROOT, "..", "..");

/** Four real processes — see this file's header. Ports clear of every other concurrency suite's range. */
const PROCESS_COUNT = 4;
const BASE_PORT = 4601;

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
 * exactly as `./support/db.ts`'s `deriveTestRequestId` does for attempt 1 on
 * provider `a`, and extended here to the fall-through id this suite also needs.
 * Kept as an independent transcription rather than imported, for the same
 * reason `db.ts` gives: a bug that changed the derivation in the application and
 * in a shared helper together would still pass.
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
}

describe("functional spec §2.1 — a supplier that refuses is replaced by the backup", () => {
  let instances: RunningInstance[] = [];
  let assertionClient: DatabaseClient;
  let adminToken: string;
  let cursor = 0;

  /**
   * Round-robins every HTTP call this suite makes across the four spawned
   * processes — see this file's header, "WHY FOUR PROCESSES". A single test
   * typically only creates one order, so without this every call in it would
   * land on `instances[0]` and the suite would prove nothing about the
   * database being what actually carries `supplier_behaviour` between
   * processes.
   */
  function nextInstance(): RunningInstance {
    const instance = instances[cursor % instances.length];
    cursor += 1;
    if (instance === undefined) throw new Error("nextInstance: no instances available");
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

  const SETTLE_POLL_INTERVAL_MS = 25;
  const SETTLE_TIMEOUT_MS = 15_000;

  /**
   * Wait for one order to leave the in-flight states, including the two
   * recoverable ones this phase adds — unlike `./key-claim-race.test.ts`'s
   * `waitUntilSettled`, which predates `delivery_failed` and does not know
   * about it.
   */
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

  /**
   * `PUT /internal/suppliers/:provider/behaviour` with the full five-field
   * body — see this file's header, "PUT REPLACES, IT DOES NOT MERGE".
   */
  async function armBehaviour(
    provider: "a" | "b",
    settings: {
      readonly failure_rate?: number;
      readonly hang_rate?: number;
      readonly hang_ms?: number;
      readonly fail_next?: number;
      readonly hang_next?: number;
    },
  ): Promise<void> {
    const body = {
      failure_rate: settings.failure_rate ?? 0,
      hang_rate: settings.hang_rate ?? 0,
      hang_ms: settings.hang_ms ?? 0,
      fail_next: settings.fail_next ?? 0,
      hang_next: settings.hang_next ?? 0,
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

  /** `{}` — the documented reset to the seeded all-zero baseline. */
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

  async function readAttempts(orderId: string): Promise<AttemptRow[]> {
    const { rows } = await assertionClient.pool.query<AttemptRow>(
      `select request_id, order_id, provider, attempt, status, last_error
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

  async function countSupplierRequests(requestIds: readonly string[]): Promise<number> {
    const { rows } = await assertionClient.pool.query<{ n: number }>(
      `select count(*)::int as n from supplier_requests where request_id = any($1::text[])`,
      [requestIds],
    );
    return rows[0]?.n ?? 0;
  }

  interface StockAccounting {
    readonly claimedKeys: number;
    readonly deliveries: number;
  }

  /**
   * `count(*) FROM supplier_keys WHERE claimed_by_request_id IS NOT NULL` next
   * to `count(*) FROM deliveries` — the R2 assertion, global rather than
   * scoped to one order's request ids. Valid as a global comparison *because*
   * this suite's own `beforeAll` has already proven the database starts at the
   * seeded baseline (zero of both) and `fileParallelism: false`
   * (`apps/api/vitest.config.ts`) means no other suite is writing to the same
   * database while this one runs.
   */
  async function readStockAccounting(): Promise<StockAccounting> {
    const { rows } = await assertionClient.pool.query<{ claimed_keys: number; deliveries: number }>(
      `select
         (select count(*) from supplier_keys where claimed_by_request_id is not null)::int as claimed_keys,
         (select count(*) from deliveries)::int as deliveries`,
    );
    const row = rows[0];
    if (row === undefined) throw new Error("readStockAccounting: query returned no row");
    return { claimedKeys: row.claimed_keys, deliveries: row.deliveries };
  }

  async function countUnclaimedKeys(): Promise<number> {
    const { rows } = await assertionClient.pool.query<{ n: number }>(
      `select count(*)::int as n from supplier_keys where claimed_by_request_id is null`,
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * The out-of-stock case's sentinel value — see this file's header, "WHY THE
   * OUT-OF-STOCK CASE DRAINS THE POOL DIRECTLY". Not a `req_…` string on
   * purpose: `cleanupTestOrders`'s `req_{order}_%` pattern must not match it,
   * so the two cleanup mechanisms stay visibly separate and neither can mask
   * the other leaving a key behind.
   */
  const DRAIN_SENTINEL = "test_sentinel_drain_003_slice2";

  /**
   * Claim every currently-unclaimed key under a value derived from
   * {@link DRAIN_SENTINEL}. Returns how many were claimed.
   *
   * `claimed_by_request_id` is UNIQUE (I6), so fifty rows cannot share one
   * literal value — each gets `{DRAIN_SENTINEL}_{id}`, distinct per row and
   * still matched as a group by the `LIKE` pattern
   * {@link restoreDrainedKeyPool} uses to release them, in the same style
   * `cleanupTestOrders` (`./support/db.ts`) uses for its own request-id
   * patterns.
   */
  async function drainKeyPool(): Promise<number> {
    const { rowCount } = await assertionClient.pool.query(
      `update supplier_keys
          set claimed_by_request_id = $1 || '_' || id::text, claimed_at = now()
        where claimed_by_request_id is null`,
      [DRAIN_SENTINEL],
    );
    return rowCount ?? 0;
  }

  /** Release every key this suite drained. The only lawful "unclaim" in this codebase — see the header. */
  async function restoreDrainedKeyPool(): Promise<void> {
    await assertionClient.pool.query(
      `update supplier_keys set claimed_by_request_id = null, claimed_at = null
         where claimed_by_request_id like $1`,
      [`${DRAIN_SENTINEL}_%`],
    );
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
        "ADMIN_TOKEN is not set (or shorter than 16 chars), and this suite arms " +
          "supplier behaviour through the guarded control endpoint. See .env.example.",
      );
    }
    adminToken = token;

    assertionClient = createTestDatabaseClient("assert-refusal");
    assertBaseline(await readBaselineCounts(assertionClient), "before");

    console.log("supplier-refusal-and-recovery: building @game-shop/db, @game-shop/contracts and @game-shop/api...");
    execFileSync("pnpm", ["run", "build:packages"], { cwd: REPO_ROOT, stdio: "inherit" });
    execFileSync("pnpm", ["--filter", "@game-shop/api", "run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });

    instances = await Promise.all(
      Array.from({ length: PROCESS_COUNT }, async (_, index) =>
        startApiInstance({ apiRoot: API_ROOT, port: BASE_PORT + index, databaseUrl }),
      ),
    );
    console.log(
      `supplier-refusal-and-recovery: ${String(instances.length)} apps/api processes healthy on ports ` +
        `${instances.map((instance) => String(instance.port)).join(", ")} ` +
        `(pids ${instances.map((instance) => String(instance.pid)).join(", ")})`,
    );
  }, 120_000);

  afterAll(async () => {
    await stopAllApiInstances(instances);

    // Belt and braces beyond each test's own `finally`: no test may exit
    // leaving a supplier armed, because "a left-armed supplier makes every
    // later slice fail confusingly." Reset happens over plain HTTP against the
    // instances above, so it must run BEFORE they are stopped — reordered here
    // deliberately relative to the other suites' afterAll, which stop first.
    //
    // (Instances are already stopped above in this suite's own ordering choice
    // — restore behaviour via direct SQL instead, which needs no running
    // process and is exactly what the seed itself would write.)
    if (assertionClient !== undefined) {
      await assertionClient.pool.query(
        `update supplier_behaviour
           set failure_rate = 0, hang_rate = 0, hang_ms = 0, fail_next = 0, hang_next = 0,
               hang_before_claim = false, updated_at = now()`,
      );

      assertBaseline(await readBaselineCounts(assertionClient), "after");
      await assertionClient.close();
    }
  }, 60_000);

  it("ordinary path, nothing armed: delivered via A, a single attempt row", async () => {
    const order = await createOrder();
    const orderIds = [order.id];

    try {
      const ack = await payOrder(order.id);
      expect(ack.webhook_outcome, "payment event was freshly stored").toBe("stored");

      const settled = await waitUntilSettled(order.id);
      expect(settled.status, "an unarmed purchase must deliver via the main supplier").toBe("delivered");

      const attempts = await readAttempts(order.id);
      expect(attempts, "exactly one attempt row when nothing refuses").toHaveLength(1);
      expect(attempts[0]?.provider).toBe("a");
      expect(attempts[0]?.attempt).toBe(1);
      expect(attempts[0]?.status).toBe("ok");
      expect(attempts[0]?.request_id).toBe(requestIdFor(order.id, "a", 1));

      expect(await countDeliveries(order.id), "exactly one delivery").toBe(1);

      const accounting = await readStockAccounting();
      expect(accounting.claimedKeys, "claimed keys equal deliveries (R2)").toBe(accounting.deliveries);
      expect(accounting.deliveries).toBe(1);
    } finally {
      await cleanupTestOrders(assertionClient, orderIds);
    }

    expect(await countUnclaimedKeys(), "pool restored to full after cleanup").toBe(KEY_POOL_SIZE);
  });

  it(
    "headline: A's fail_next=1 -> B delivers. Two attempt rows, one delivery, " +
      "one supplier_requests row against B, and the pool comes back to 50/50 afterwards",
    async () => {
      await armBehaviour("a", { fail_next: 1 });

      const order = await createOrder();
      const orderIds = [order.id];

      try {
        const ack = await payOrder(order.id);
        expect(ack.webhook_outcome, "payment event was freshly stored").toBe("stored");

        const settled = await waitUntilSettled(order.id);
        // §2.1 criterion 1 and criterion 2: the shopper's own view reads exactly
        // as an ordinary delivery — "delivered", full stop, no trace of which
        // supplier answered.
        expect(settled.status, "a refused main supplier must still deliver via the backup").toBe("delivered");

        const attempts = await readAttempts(order.id);
        expect(attempts, "exactly two attempt rows: the refusal and the fall-through").toHaveLength(2);

        const [first, second] = attempts;
        expect(first?.provider).toBe("a");
        expect(first?.attempt).toBe(1);
        expect(first?.status).toBe("failed");
        expect(first?.last_error, "the injected refusal's own reason, distinct from out_of_stock").toBe(
          "supplier_rejected",
        );
        expect(first?.request_id).toBe(requestIdFor(order.id, "a", 1));

        // §2.1 criterion 4, half of it: the fall-through is a NEW request id —
        // per-order numbering, never a second "attempt 1".
        expect(second?.provider).toBe("b");
        expect(second?.attempt, "the fall-through is attempt 2, never a second attempt 1").toBe(2);
        expect(second?.status).toBe("ok");
        const requestIdB2 = requestIdFor(order.id, "b", 2);
        expect(second?.request_id).toBe(requestIdB2);
        expect(second?.request_id).not.toBe(requestIdFor(order.id, "b", 1));

        // §2.1 criterion 4: one delivery, one key — the shopper is charged once
        // and receives exactly one key regardless of which supplier answered.
        expect(await countDeliveries(order.id), "exactly one delivery").toBe(1);

        // A's refusal is answered BEFORE the key claim and before
        // SupplierKeyClaimService.issue ever runs, so A never touches the
        // ledger. Only B's successful call does — "one supplier_requests row
        // recorded against b".
        const requestIdA1 = requestIdFor(order.id, "a", 1);
        expect(
          await countSupplierRequests([requestIdA1]),
          "the refused call never reached the ledger at all",
        ).toBe(0);
        expect(await countSupplierRequests([requestIdB2]), "exactly one ledger row, against B").toBe(1);

        const { rows: ledgerRows } = await assertionClient.pool.query<{ provider: string }>(
          `select provider from supplier_requests where request_id = $1`,
          [requestIdB2],
        );
        expect(ledgerRows[0]?.provider, "the ledger row is recorded against b, not a").toBe("b");

        // R2 — the assertion that actually catches this phase's bugs.
        const accounting = await readStockAccounting();
        expect(accounting.claimedKeys, "claimed keys equal deliveries").toBe(accounting.deliveries);
        expect(accounting.claimedKeys).toBe(1);
      } finally {
        await resetBehaviour("a");
        await cleanupTestOrders(assertionClient, orderIds);
      }

      // The specific regression this re-run was asked to confirm: this order
      // fell through to B, and `cleanupTestOrders` used to derive only
      // `req_{order}_a_1`, leaving `req_{order}_b_2`'s claimed key behind. If
      // the fix has really landed, the pool is back to full.
      expect(
        await countUnclaimedKeys(),
        "cleanupTestOrders must release the fall-through's key too, not just attempt 1's",
      ).toBe(KEY_POOL_SIZE);
    },
  );

  it("both suppliers refuse: the order reaches delivery_failed, not out_of_stock, and no key is claimed", async () => {
    await armBehaviour("a", { fail_next: 1 });
    await armBehaviour("b", { fail_next: 1 });

    const order = await createOrder();
    const orderIds = [order.id];

    try {
      const ack = await payOrder(order.id);
      expect(ack.webhook_outcome).toBe("stored");

      const settled = await waitUntilSettled(order.id);
      // §2.1 criterion 3: a state a person can act on, not out_of_stock (which
      // would falsely promise "wait for a restock") and not stuck in
      // "delivering" forever.
      expect(settled.status, "both suppliers refusing settles delivery_failed").toBe("delivery_failed");

      const attempts = await readAttempts(order.id);
      expect(attempts, "one attempt per supplier, both definite refusals").toHaveLength(2);
      expect(attempts[0]?.provider).toBe("a");
      expect(attempts[0]?.attempt).toBe(1);
      expect(attempts[0]?.status).toBe("failed");
      expect(attempts[0]?.last_error).toBe("supplier_rejected");
      expect(attempts[1]?.provider).toBe("b");
      expect(attempts[1]?.attempt).toBe(2);
      expect(attempts[1]?.status).toBe("failed");
      expect(attempts[1]?.last_error).toBe("supplier_rejected");

      expect(await countDeliveries(order.id), "no delivery when both refuse").toBe(0);

      const requestIds = [requestIdFor(order.id, "a", 1), requestIdFor(order.id, "b", 2)];
      expect(await countSupplierRequests(requestIds), "an injected refusal never reaches the ledger").toBe(0);

      const accounting = await readStockAccounting();
      expect(accounting.claimedKeys, "no key left the pool").toBe(0);
      expect(accounting.deliveries).toBe(0);
    } finally {
      await resetBehaviour("a");
      await resetBehaviour("b");
      await cleanupTestOrders(assertionClient, orderIds);
    }

    expect(await countUnclaimedKeys(), "pool untouched by a run where nothing was ever claimed").toBe(KEY_POOL_SIZE);
  });

  it(
    "the empty-pool path still gives two attempt rows (a/1, b/2, both out_of_stock) and settles " +
      "out_of_stock rather than delivery_failed",
    async () => {
      expect(await countUnclaimedKeys(), "precondition: the pool is full before draining it").toBe(KEY_POOL_SIZE);
      const drained = await drainKeyPool();
      expect(drained, "the whole pool was claimed under the sentinel").toBe(KEY_POOL_SIZE);
      expect(await countUnclaimedKeys()).toBe(0);

      const order = await createOrder();
      const orderIds = [order.id];

      try {
        const ack = await payOrder(order.id);
        expect(ack.webhook_outcome).toBe("stored");

        const settled = await waitUntilSettled(order.id);
        // §2.3's second criterion, restated by R12: a genuinely empty shelf
        // must read differently from a supplier fault, so this must NOT be
        // delivery_failed even though the shape (two failed attempts) looks
        // like the previous test's.
        expect(settled.status, "a genuinely empty pool is out_of_stock, not delivery_failed").toBe("out_of_stock");

        const attempts = await readAttempts(order.id);
        expect(attempts, "A refused (empty shelf), then B was asked and refused the same way (R12)").toHaveLength(2);
        expect(attempts[0]?.provider).toBe("a");
        expect(attempts[0]?.attempt).toBe(1);
        expect(attempts[0]?.status).toBe("failed");
        expect(attempts[0]?.last_error, "the reason stays distinguishable from an injected refusal").toBe(
          "out_of_stock",
        );
        expect(attempts[0]?.request_id).toBe(requestIdFor(order.id, "a", 1));

        expect(attempts[1]?.provider).toBe("b");
        expect(attempts[1]?.attempt, "per-order numbering: attempt 2, never a second attempt 1").toBe(2);
        expect(attempts[1]?.status).toBe("failed");
        expect(attempts[1]?.last_error).toBe("out_of_stock");
        expect(attempts[1]?.request_id).toBe(requestIdFor(order.id, "b", 2));
        expect(attempts[1]?.request_id).not.toBe(requestIdFor(order.id, "b", 1));

        expect(await countDeliveries(order.id), "no delivery on an empty pool").toBe(0);

        const requestIds = [requestIdFor(order.id, "a", 1), requestIdFor(order.id, "b", 2)];
        expect(
          await countSupplierRequests(requestIds),
          "an out_of_stock claim commits having written nothing to the ledger",
        ).toBe(0);

        // The global R2 comparison (claimed keys == deliveries) is not the
        // right shape here: the fifty sentinel-drained keys are themselves
        // "claimed" by this suite's own harness, not by a shopper, so a plain
        // equality against zero deliveries would fail for a reason that has
        // nothing to do with the ladder. What R2 actually guards against — a
        // key silently leaving the pool for an order the ladder settled
        // out_of_stock — shows up here as "did the claimed-key count move at
        // all beyond the sentinel drain": it must not, because nothing was
        // ever claimed for this order.
        const accounting = await readStockAccounting();
        expect(accounting.claimedKeys, "no key claimed beyond the sentinel drain — this order claimed none").toBe(
          drained,
        );
        expect(accounting.deliveries).toBe(0);
      } finally {
        await cleanupTestOrders(assertionClient, orderIds);
        await restoreDrainedKeyPool();
      }

      expect(await countUnclaimedKeys(), "restoring the drained pool returns it to 50/50").toBe(KEY_POOL_SIZE);
    },
  );
});
