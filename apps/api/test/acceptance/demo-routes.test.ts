// @layer: integration
// @spec: 006-live-shop-and-the-written-answer
/**
 * The Slice 3 acceptance suite for
 * `context/spec/006-live-shop-and-the-written-answer/functional-spec.md` §2.3
 * (technical-considerations §2.4) — **`POST /api/admin/demo/reset`** and
 * **`POST /internal/suppliers/keys/{drain,restock}`**, driven the way
 * `./promo-codes.test.ts` drives spec 005's endpoint: one real `dist/main.js`
 * process (`../concurrency/support/api-instance.ts`), single-instance
 * integration layer (`architecture.md` §7 — nothing here needs overlapping
 * requests), assertions that read Postgres directly rather than trust the
 * response alone.
 *
 * ---------------------------------------------------------------------------
 * WHY TWO INSTANCES, NEVER AT THE SAME TIME, BOTH ON 5402
 * ---------------------------------------------------------------------------
 * `tasks.md`'s standing requirement fixes this file to port **5402** alone.
 * Every functional criterion (drain/restock, the reset transaction, body
 * validation, a missing or wrong bearer token) needs `ADMIN_TOKEN`
 * *configured* — a `401` for "wrong" is only informative when the surface is
 * actually on. The one exception is the guard's third answer, `503` for
 * *unconfigured*, which by definition needs a process that never saw
 * `ADMIN_TOKEN` at all. `startApiInstance` (`../concurrency/support/
 * api-instance.ts`) builds its child's environment as `{ ...process.env, … }`
 * and never sets `ADMIN_TOKEN` itself, so deleting it from this process's own
 * `process.env` for the instant of the `spawn()` call — then restoring it
 * immediately after, since the spread already copied the environment by
 * then — produces a genuinely unconfigured child with no edit to that file.
 * So: a "configured instance" describe block spawns first, runs every 401 and
 * every functional test, and stops its instance in its own `afterAll`; a
 * second "ADMIN_TOKEN unset" describe block then spawns its own instance on
 * the same port 5402 and asserts `503` on all three routes. Vitest's ordering
 * guarantee for nested `describe`s (the same one `./vercel-entry.test.ts`'s
 * header relies on) is what keeps the port from ever being held twice.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FUNCTIONAL TESTS RUN IN THIS ORDER, ON ONE SHARED DATABASE
 * ---------------------------------------------------------------------------
 * Unlike `./promo-codes.test.ts`'s orders, `supplier_keys` is one 50-row pool
 * shared by every test in this file, and the reset test's own assertions
 * ("removed equals exactly what this test created") only mean anything if the
 * database is genuinely at the seeded baseline the moment that test starts.
 * So every test before it restocks whatever it drained and cleans whatever
 * orders it created, in its own `finally`, and the reset test is written
 * **last** on purpose — not a Vitest guarantee, a plain fact about the file
 * `describe`/`it` bodies run in the order they are declared when nothing here
 * asks for `concurrent`. The guard-table tests run first and touch no state
 * at all (`AdminTokenGuard.canActivate` returns before the controller's body
 * ever runs).
 *
 * The reset test is also the one test in this file that does **not** call
 * `cleanupTestOrders` — it is testing the one production route that is
 * allowed to delete every order itself, so calling the harness's cleanup
 * afterwards would be asserting the reset by looking at a database the
 * harness had already fixed up. Its own last statement is `assertBaseline`,
 * read directly off Postgres, matching this file's brief.
 *
 * ---------------------------------------------------------------------------
 * ASSERTIONS QUERY THE DATABASE DIRECTLY
 * ---------------------------------------------------------------------------
 * `architecture.md` §7's rule, the same one `./promo-codes.test.ts` follows:
 * `keysUnclaimed`, the `req\_%` claim count and the six-table
 * `readRemovableRowCounts()` below are all raw SQL on `db.pool`, quoted
 * beside each call, so a `removed` object that looked right in the response
 * is checked against what Postgres itself now holds, not against another
 * read of the same JSON.
 *
 * ---------------------------------------------------------------------------
 * RED VALIDATION
 * ---------------------------------------------------------------------------
 * The implementation this file tests already exists (Slice 3's first three
 * tasks), so — as `./promo-codes.test.ts`'s header puts it for the same
 * situation — "RED" here means a temporary, targeted inversion of what a test
 * asserts, run to see it fail for the stated reason, then reverted
 * byte-identical. **No production source under `src/` was touched** — every
 * inversion below lives entirely inside this file's own assertions, which is
 * also why (a) is phrased "by inversion": the actual weakening this line
 * guards against — `restock`'s `WHERE` widened from `LIKE 'drain\_…'` to
 * `IS NOT NULL` (R15, `supplier-key-pool.service.ts`'s own header) — is a
 * change to `src/`, out of this task's scope; inverting the assertion's
 * expected value instead proves the same thing from this side: the test
 * would go red the moment that claim stopped holding, whichever side changed.
 * Three inversions, applied and run one at a time:
 *
 *   (a) "the real claim (req_...) is untouched by drain+restock" — inverted
 *       to `.toBe(0)` (this is the R15 guard: if `restock`'s `WHERE` were
 *       ever widened to `IS NOT NULL`, this is the line that goes red):
 *         AssertionError: the real claim (req_...) is untouched by drain+restock — R15's whole guarantee: expected 1 to be +0 // Object.is equality
 *   (b) "a second call on an already-reset shop changes nothing" — inverted
 *       to `.toBe(true)`:
 *         AssertionError: a second call on an already-reset shop changes nothing: expected false to be true // Object.is equality
 *   (c) "removed equals exactly what this test created" — `removableBefore`
 *       spread with `orders` reduced by one before the `.toEqual`, so the
 *       object asserted is one order short of what the transaction actually
 *       removed:
 *         AssertionError: removed equals exactly what this test created — a rowCount from the transaction itself, not a recomputed guess: expected { orders: 2, deliveries: 1, …(4) } to deeply equal { orders: 1, deliveries: 1, …(4) }
 *
 *         - Expected
 *         + Received
 *
 *           {
 *             "deliveries": 1,
 *             "issuance_attempts": 1,
 *         -   "orders": 1,
 *         +   "orders": 2,
 *             "payment_events": 1,
 *             "promo_redemptions": 1,
 *             "supplier_requests": 1,
 *           }
 *
 * Each ran in isolation (the other two assertions at their original,
 * correct values), one `vitest run` per inversion, and every other test in
 * the file passed on all three runs — 12 of 13, 12 of 13, 12 of 13 — with
 * `assertBaseline` holding both before and after each (the failing test's
 * own assertion throws only after the transaction under test has already
 * run for real, so the database is genuinely back at the seed regardless of
 * which line the test itself then fails on). Command and results are quoted
 * in full in the completion report; all three failed for exactly the stated
 * reason and nothing else, then were reverted and re-run GREEN.
 *
 * Run it: `node scripts/with-env.ts pnpm --filter @game-shop/api exec vitest
 * run test/acceptance/demo-routes.test.ts` from the repository root — the env
 * wrapper supplies `DATABASE_URL` and `ADMIN_TOKEN` from `.env.example`/`.env`,
 * exactly as `./vercel-entry.test.ts` is run.
 */
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { OrderStatus, isSettledOrderStatus } from "@game-shop/contracts";
import type { DatabaseClient } from "@game-shop/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DemoBaseline, DemoResetRemoved, DemoResetReport } from "../../src/demo/demo.types.js";
import type { CreatedOrder, OrderView } from "../../src/orders/orders.types.js";
import type { SimulatedPaymentAck } from "../../src/payments/payment-simulator.types.js";
import type {
  SupplierKeyPoolDrainResponse,
  SupplierKeyPoolRestockResponse,
} from "../../src/suppliers/supplier-key-pool.types.js";
import { type RunningInstance, startApiInstance, stopApiInstance } from "../concurrency/support/api-instance.js";
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
 * Fixed by `tasks.md`'s standing requirement: "Ports 5401
 * (`vercel-entry.test.ts`) and 5402 (`demo-routes.test.ts`), listed in
 * `scripts/race/README.md`'s row; nothing else may bind them." One port for
 * the whole file, held by at most one process at a time — see this file's
 * header, "WHY TWO INSTANCES, NEVER AT THE SAME TIME".
 */
const PORT = 5402;

const SETTLE_POLL_INTERVAL_MS = 25;
/** Matches `./promo-codes.test.ts`'s own bound for the same reason: the ladder's worst case is 12s. */
const SETTLE_TIMEOUT_MS = 20_000;

/** The seeded shop's whole-database snapshot — `DemoBaseline`'s twelve fields, as `demo-reset.service.ts`'s `readBaseline` reads them on a freshly-seeded database. */
const SEEDED_BASELINE: DemoBaseline = {
  products: 12,
  keys_total: 50,
  keys_unclaimed: 50,
  orders: 0,
  payment_events: 0,
  deliveries: 0,
  issuance_attempts: 0,
  supplier_requests: 0,
  promo_codes: 4,
  promo_used_count: 0,
  promo_redemptions: 0,
  supplier_behaviour_baseline: 2,
};

/** The three demo affordances the guard table exercises — every route this file drives that sits behind `AdminTokenGuard`. */
const GUARDED_ROUTES: readonly { readonly label: string; readonly path: string }[] = [
  { label: "POST /api/admin/demo/reset", path: "/api/admin/demo/reset" },
  { label: "POST /internal/suppliers/keys/drain", path: "/internal/suppliers/keys/drain" },
  { label: "POST /internal/suppliers/keys/restock", path: "/internal/suppliers/keys/restock" },
];

function delay(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

interface RawResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

async function request(baseUrl: string, path: string, init: RequestInit): Promise<RawResponse> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
}

function bearer(token: string | undefined): Record<string, string> {
  return token === undefined ? {} : { authorization: `Bearer ${token}` };
}

/** No body at all — the shape a bare `curl -X POST` sends, and the one the guard table and a bodyless `POST /api/admin/demo/reset` both need. */
async function postNoBody(baseUrl: string, path: string, token: string | undefined): Promise<RawResponse> {
  return request(baseUrl, path, { method: "POST", headers: bearer(token) });
}

async function postJsonAuthed(baseUrl: string, path: string, token: string, body: unknown): Promise<RawResponse> {
  return request(baseUrl, path, {
    method: "POST",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify(body),
  });
}

async function putJsonAuthed(baseUrl: string, path: string, token: string, body: unknown): Promise<RawResponse> {
  return request(baseUrl, path, {
    method: "PUT",
    headers: { "content-type": "application/json", ...bearer(token) },
    body: JSON.stringify(body),
  });
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<RawResponse> {
  return request(baseUrl, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function getJson(baseUrl: string, path: string): Promise<RawResponse> {
  return request(baseUrl, path, { method: "GET" });
}

async function createOrder(baseUrl: string): Promise<CreatedOrder> {
  const response = await postJson(baseUrl, "/api/orders", { sku: PURCHASABLE_SKU });
  if (response.status !== 201) {
    throw new Error(`POST /api/orders -> ${String(response.status)}: ${JSON.stringify(response.body)}`);
  }
  return response.body as CreatedOrder;
}

async function payOrder(baseUrl: string, orderId: string): Promise<SimulatedPaymentAck> {
  const response = await postJson(baseUrl, `/api/payments/${encodeURIComponent(orderId)}/simulate`, { outcome: "success" });
  if (response.status !== 200) {
    throw new Error(`POST /api/payments/${orderId}/simulate -> ${String(response.status)}: ${JSON.stringify(response.body)}`);
  }
  return response.body as SimulatedPaymentAck;
}

async function getOrder(baseUrl: string, orderId: string): Promise<OrderView> {
  const response = await getJson(baseUrl, `/api/orders/${encodeURIComponent(orderId)}`);
  if (response.status !== 200) {
    throw new Error(`GET /api/orders/${orderId} -> ${String(response.status)}: ${JSON.stringify(response.body)}`);
  }
  return response.body as OrderView;
}

/** `POST /api/orders/:orderId/promo` — raw, so a 4xx body is inspectable rather than thrown. */
async function applyPromo(baseUrl: string, orderId: string, body: unknown): Promise<RawResponse> {
  return postJson(baseUrl, `/api/orders/${encodeURIComponent(orderId)}/promo`, body);
}

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

/** `POST /internal/suppliers/keys/drain` `{ token? }` → `{ token, claimed }`. */
async function drainKeys(baseUrl: string, adminToken: string, runToken?: string): Promise<RawResponse> {
  return postJsonAuthed(baseUrl, "/internal/suppliers/keys/drain", adminToken, runToken === undefined ? {} : { token: runToken });
}

/** `POST /internal/suppliers/keys/restock` `{ token? }` → `{ released }`. */
async function restockKeys(baseUrl: string, adminToken: string, runToken?: string): Promise<RawResponse> {
  return postJsonAuthed(baseUrl, "/internal/suppliers/keys/restock", adminToken, runToken === undefined ? {} : { token: runToken });
}

/** `POST /api/admin/demo/reset` — no body — → `{ removed, reset, changed, now }`. */
async function resetDemo(baseUrl: string, adminToken: string): Promise<RawResponse> {
  return postNoBody(baseUrl, "/api/admin/demo/reset", adminToken);
}

/** `PUT /internal/suppliers/:provider/behaviour` — arms a scenario knob. */
async function armBehaviour(
  baseUrl: string,
  adminToken: string,
  provider: "a" | "b",
  settings: Record<string, unknown>,
): Promise<RawResponse> {
  return putJsonAuthed(baseUrl, `/internal/suppliers/${provider}/behaviour`, adminToken, settings);
}

describe("functional spec 006-live-shop-and-the-written-answer — the demo affordances (port 5402)", () => {
  let db: DatabaseClient;
  let databaseUrl: string;
  let adminToken: string;

  /**
   * `supplier_keys` currently unclaimed — the same predicate
   * `readBaselineCounts.keysUnclaimed` and `demo-reset.service.ts`'s
   * `readBaseline` both read.
   *
   *   select count(*)::int as n from supplier_keys where claimed_by_request_id is null;
   */
  async function countUnclaimedKeys(): Promise<number> {
    const { rows } = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from supplier_keys where claimed_by_request_id is null`,
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * `supplier_keys` rows a real production claim holds — `req_…`, never
   * `drain_…` (`../issuance/issuance-request-id.ts`; the escape is the same
   * one `supplier-key-pool.service.ts`'s `restock` uses, R15).
   *
   *   select count(*)::int as n from supplier_keys where claimed_by_request_id like 'req\_%';
   */
  async function countRealClaims(): Promise<number> {
    const { rows } = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from supplier_keys where claimed_by_request_id like 'req\\_%'`,
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * `used_count`/`max_uses` for one promo code, by its normalised (stored)
   * form — the same read `./promo-codes.test.ts`'s `readPromoCounter` makes.
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
   * The six tables `demo-reset.service.ts`'s `removed` object reports on,
   * read directly and independently of the endpoint under test — so "equal
   * to what the test created" is checked against Postgres itself, not
   * against another read of the same response.
   *
   *   select
   *     (select count(*) from orders)::int              as orders,
   *     (select count(*) from deliveries)::int           as deliveries,
   *     (select count(*) from issuance_attempts)::int    as issuance_attempts,
   *     (select count(*) from promo_redemptions)::int    as promo_redemptions,
   *     (select count(*) from payment_events)::int       as payment_events,
   *     (select count(*) from supplier_requests)::int    as supplier_requests;
   */
  async function readRemovableRowCounts(): Promise<DemoResetRemoved> {
    const { rows } = await db.pool.query<{
      orders: number;
      deliveries: number;
      issuance_attempts: number;
      promo_redemptions: number;
      payment_events: number;
      supplier_requests: number;
    }>(`
      select
        (select count(*) from orders)::int              as orders,
        (select count(*) from deliveries)::int           as deliveries,
        (select count(*) from issuance_attempts)::int    as issuance_attempts,
        (select count(*) from promo_redemptions)::int    as promo_redemptions,
        (select count(*) from payment_events)::int       as payment_events,
        (select count(*) from supplier_requests)::int    as supplier_requests
    `);
    const row = rows[0];
    if (row === undefined) throw new Error("readRemovableRowCounts: query returned no row");
    return {
      orders: row.orders,
      deliveries: row.deliveries,
      issuance_attempts: row.issuance_attempts,
      promo_redemptions: row.promo_redemptions,
      payment_events: row.payment_events,
      supplier_requests: row.supplier_requests,
    };
  }

  beforeAll(async () => {
    const configuredDatabaseUrl = process.env["DATABASE_URL"];
    if (configuredDatabaseUrl === undefined || configuredDatabaseUrl === "") {
      throw new Error(
        "DATABASE_URL is not set. Run this suite through `node scripts/with-env.ts pnpm --filter " +
          "@game-shop/api exec vitest run test/acceptance/demo-routes.test.ts` from the repository root, " +
          "which loads the local environment first.",
      );
    }
    const configuredAdminToken = process.env["ADMIN_TOKEN"];
    if (configuredAdminToken === undefined || configuredAdminToken === "") {
      throw new Error(
        "ADMIN_TOKEN is not set — this suite needs the admin surface CONFIGURED (401 for a missing/wrong " +
          "token) for every test but the unconfigured-instance describe, which unsets it for its own child " +
          "only. Run through scripts/with-env.ts, as above.",
      );
    }
    databaseUrl = configuredDatabaseUrl;
    adminToken = configuredAdminToken;

    db = createTestDatabaseClient("acceptance-006-demo-routes");
    assertBaseline(await readBaselineCounts(db), "before");

    // Rebuilding from current source is what makes RED validation meaningful
    // — see ../concurrency/support/api-instance.ts's header.
    console.log("demo-routes: building @game-shop/db, @game-shop/contracts and @game-shop/api...");
    execFileSync("pnpm", ["run", "build:packages"], { cwd: REPO_ROOT, stdio: "inherit" });
    execFileSync("pnpm", ["--filter", "@game-shop/api", "run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  }, 120_000);

  afterAll(async () => {
    if (db !== undefined) {
      assertBaseline(await readBaselineCounts(db), "after");
      await db.close();
    }
  }, 60_000);

  // =========================================================================
  describe("a configured instance (ADMIN_TOKEN set)", () => {
    let instance: RunningInstance;

    beforeAll(async () => {
      instance = await startApiInstance({ apiRoot: API_ROOT, port: PORT, databaseUrl });
    }, 60_000);

    afterAll(async () => {
      if (instance !== undefined) await stopApiInstance(instance);
    }, 15_000);

    // =======================================================================
    describe("guard table — all three demo/internal routes require the admin bearer token", () => {
      for (const route of GUARDED_ROUTES) {
        it(`${route.label} without a token -> 401 with WWW-Authenticate: Bearer (negative: no credentials)`, async () => {
          const response = await postNoBody(instance.baseUrl, route.path, undefined);
          expect(response.status, `${route.path} without a token -> ${String(response.status)}`).toBe(401);
          expect(
            response.headers.get("www-authenticate"),
            "RFC 9110 §11.6.1 makes this header a MUST on a 401",
          ).toBe("Bearer");
        });
      }

      for (const route of GUARDED_ROUTES) {
        it(`${route.label} with a wrong token -> 401 (negative: bad credentials)`, async () => {
          const response = await postNoBody(instance.baseUrl, route.path, "wrong-token-definitely-not-the-real-one");
          expect(response.status, `${route.path} with a wrong token -> ${String(response.status)}`).toBe(401);
          expect(response.headers.get("www-authenticate")).toBe("Bearer");
        });
      }
    });

    // =======================================================================
    it(
      "drain claims the whole unclaimed pool under a caller-supplied token; a purchase against the drained " +
        "pool settles out_of_stock; restock releases exactly what drain claimed",
      async () => {
        const runToken = `acc-${randomUUID()}`;
        let orderId: string | undefined;
        try {
          const before = await countUnclaimedKeys();
          expect(before, "precondition: the pool is at its full baseline before this test drains it").toBe(50);

          const drainResponse = await drainKeys(instance.baseUrl, adminToken, runToken);
          expect(drainResponse.status, `drain { token } -> ${String(drainResponse.status)}`).toBe(200);
          const drainBody = drainResponse.body as SupplierKeyPoolDrainResponse;
          expect(drainBody.token, "the drain echoes this run's own token").toBe(runToken);
          expect(drainBody.claimed, "claimed equals the unclaimed count read before it").toBe(before);

          expect(await countUnclaimedKeys(), "the pool now reads empty").toBe(0);

          const order = await createOrder(instance.baseUrl);
          orderId = order.id;
          await payOrder(instance.baseUrl, order.id);
          const settled = await waitUntilSettled(instance.baseUrl, order.id);
          expect(settled.status, "a purchase against a drained pool settles out_of_stock").toBe(OrderStatus.OutOfStock);

          const restockResponse = await restockKeys(instance.baseUrl, adminToken, runToken);
          expect(restockResponse.status, `restock { token } -> ${String(restockResponse.status)}`).toBe(200);
          const restockBody = restockResponse.body as SupplierKeyPoolRestockResponse;
          expect(restockBody.released, "restock releases exactly what this run's drain claimed").toBe(drainBody.claimed);

          expect(await countUnclaimedKeys(), "the pool is back to its size before the drain").toBe(before);
        } finally {
          // Idempotent safety net: a 0 release if the assertions above
          // already restocked (the route's own "0 is never an error"
          // contract), so this test leaves the pool whole even if an
          // assertion above threw.
          await restockKeys(instance.baseUrl, adminToken, runToken);
          if (orderId !== undefined) await cleanupTestOrders(db, [orderId]);
        }
      },
    );

    // =======================================================================
    it(
      "restock never touches a real claim: a delivered order's key survives drain and restock, by token or " +
        "as a token-less sweep (R15)",
      async () => {
        const runToken = `acc-${randomUUID()}`;
        let orderId: string | undefined;
        try {
          const order = await createOrder(instance.baseUrl);
          orderId = order.id;
          await payOrder(instance.baseUrl, order.id);
          const settled = await waitUntilSettled(instance.baseUrl, order.id);
          expect(settled.status, "precondition: the order actually delivered a key").toBe(OrderStatus.Delivered);
          expect(await countRealClaims(), "precondition: exactly the one real claim this test just made").toBe(1);

          const drainResponse = await drainKeys(instance.baseUrl, adminToken, runToken);
          expect(drainResponse.status).toBe(200);
          const drainBody = drainResponse.body as SupplierKeyPoolDrainResponse;
          expect(drainBody.claimed, "drain takes every OTHER key — the pool minus the one real claim").toBe(49);

          const restockResponse = await restockKeys(instance.baseUrl, adminToken, runToken);
          expect(restockResponse.status).toBe(200);
          const restockBody = restockResponse.body as SupplierKeyPoolRestockResponse;
          expect(restockBody.released, "restock releases exactly what this token's drain claimed").toBe(49);

          // CAN FAIL: inverted to `.toBe(0)` and re-run — see this file's
          // header, RED VALIDATION item (a):
          //   AssertionError: the real claim (req_...) is untouched by drain+restock — R15's whole guarantee: expected 1 to be 0
          expect(
            await countRealClaims(),
            "the real claim (req_...) is untouched by drain+restock — R15's whole guarantee",
          ).toBe(1);

          const sweepResponse = await restockKeys(instance.baseUrl, adminToken, undefined);
          expect(sweepResponse.status).toBe(200);
          const sweepBody = sweepResponse.body as SupplierKeyPoolRestockResponse;
          expect(sweepBody.released, "a token-less sweep after both sentinels are already clear finds nothing").toBe(0);
          expect(await countRealClaims(), "still untouched after the token-less sweep").toBe(1);
        } finally {
          await restockKeys(instance.baseUrl, adminToken, runToken);
          await restockKeys(instance.baseUrl, adminToken, undefined);
          if (orderId !== undefined) await cleanupTestOrders(db, [orderId]);
        }
      },
    );

    // =======================================================================
    it(
      "drain/restock body validation: '_' or '%' in a token is refused 400, an unknown field is refused 400 " +
        "naming it, and no body at all is legal and mints a token (negative: malformed and unknown-field bodies)",
      async () => {
        const underscoreResponse = await drainKeys(instance.baseUrl, adminToken, "a_b");
        expect(underscoreResponse.status, `{ token: "a_b" } -> ${String(underscoreResponse.status)}`).toBe(400);

        const percentResponse = await drainKeys(instance.baseUrl, adminToken, "a%b");
        expect(percentResponse.status, `{ token: "a%b" } -> ${String(percentResponse.status)}`).toBe(400);

        const unknownFieldResponse = await postJsonAuthed(instance.baseUrl, "/internal/suppliers/keys/drain", adminToken, {
          tokne: "x",
        });
        expect(unknownFieldResponse.status, `{ tokne: "x" } -> ${String(unknownFieldResponse.status)}`).toBe(400);
        const unknownBody = unknownFieldResponse.body as { readonly message?: string };
        expect(unknownBody.message, "the 400 names the unknown field").toContain("tokne");

        let minted: string | undefined;
        try {
          const noBodyResponse = await postNoBody(instance.baseUrl, "/internal/suppliers/keys/drain", adminToken);
          expect(noBodyResponse.status, "drain with no body at all is legal — the server mints a token").toBe(200);
          const noBodyBody = noBodyResponse.body as SupplierKeyPoolDrainResponse;
          expect(noBodyBody.token, "a minted token still matches the route's own shape").toMatch(/^[A-Za-z0-9-]{1,64}$/);
          minted = noBodyBody.token;
        } finally {
          if (minted !== undefined) await restockKeys(instance.baseUrl, adminToken, minted);
        }
      },
    );

    // =======================================================================
    // Written last on purpose — see this file's header, "WHY THE FUNCTIONAL
    // TESTS RUN IN THIS ORDER". By the time this test starts, every test
    // above has restocked and cleaned up after itself, so the database holds
    // exactly the baseline this test's own two orders are added onto.
    it(
      "reset removes exactly what this test created, resets the promo counter/claim/behaviour knob, and a " +
        "second reset is a true no-op with an identical baseline",
      async () => {
        // Order A: paid all the way to `delivered` — a real claim, one
        // delivery, one issuance attempt, one supplier_requests row, one
        // payment_events row.
        const orderA = await createOrder(instance.baseUrl);
        await payOrder(instance.baseUrl, orderA.id);
        const settledA = await waitUntilSettled(instance.baseUrl, orderA.id);
        expect(settledA.status, "precondition: order A actually delivered").toBe(OrderStatus.Delivered);

        // Order B: LIMIT3 applied, left in `created` — one promo_redemptions
        // row, the counter moved to 1, no payment/delivery rows.
        const orderB = await createOrder(instance.baseUrl);
        const promoResponse = await applyPromo(instance.baseUrl, orderB.id, { code: "LIMIT3" });
        expect(promoResponse.status, "precondition: LIMIT3 applied to order B").toBe(200);
        const promoCounter = await readPromoCounter("LIMIT3");
        expect(promoCounter?.usedCount, "precondition: LIMIT3's counter moved by exactly this one use").toBe(1);

        // Armed last, so it never touches order A's already-settled flow.
        const armResponse = await armBehaviour(instance.baseUrl, adminToken, "a", { fail_next: 1 });
        expect(armResponse.status, "precondition: provider a's behaviour armed").toBe(200);

        const removableBefore = await readRemovableRowCounts();
        expect(removableBefore, "precondition: the database holds exactly what this test created").toEqual({
          orders: 2,
          deliveries: 1,
          issuance_attempts: 1,
          promo_redemptions: 1,
          payment_events: 1,
          supplier_requests: 1,
        });
        expect(await countRealClaims(), "precondition: order A's real claim is the only claimed key").toBe(1);

        const firstReset = await resetDemo(instance.baseUrl, adminToken);
        expect(firstReset.status, `first POST /api/admin/demo/reset -> ${String(firstReset.status)}`).toBe(200);
        const firstReport = firstReset.body as DemoResetReport;

        // CAN FAIL: `removableBefore` spread with `orders` reduced by one and
        // re-run — see this file's header, RED VALIDATION item (c):
        //   AssertionError: removed equals exactly what this test created — a rowCount from the transaction itself, not a recomputed guess
        expect(
          firstReport.removed,
          "removed equals exactly what this test created — a rowCount from the transaction itself, not a recomputed guess",
        ).toEqual(removableBefore);

        expect(firstReport.reset.promo_codes, "LIMIT3's counter was the only one non-zero").toBe(1);
        expect(firstReport.reset.supplier_keys, "order A's real claim was the only key held").toBe(1);
        expect(firstReport.reset.supplier_behaviour, "provider a's armed row was the only one changed").toBe(1);
        expect(firstReport.changed, "something moved on the first call").toBe(true);
        expect(firstReport.now, "the baseline the transaction's own last statement read").toEqual(SEEDED_BASELINE);

        const secondReset = await resetDemo(instance.baseUrl, adminToken);
        expect(secondReset.status, `second POST /api/admin/demo/reset -> ${String(secondReset.status)}`).toBe(200);
        const secondReport = secondReset.body as DemoResetReport;
        expect(secondReport.removed, "a re-run on an already-reset shop removes nothing").toEqual({
          orders: 0,
          deliveries: 0,
          issuance_attempts: 0,
          promo_redemptions: 0,
          payment_events: 0,
          supplier_requests: 0,
        });
        expect(secondReport.reset, "and resets nothing").toEqual({ promo_codes: 0, supplier_keys: 0, supplier_behaviour: 0 });

        // CAN FAIL: inverted to `.toBe(true)` and re-run — see this file's
        // header, RED VALIDATION item (b):
        //   AssertionError: a second call on an already-reset shop changes nothing: expected false to be true
        expect(secondReport.changed, "a second call on an already-reset shop changes nothing").toBe(false);
        expect(secondReport.now, "the baseline reads identically on both calls").toEqual(firstReport.now);

        // This test deletes everything it created itself, through the route
        // under test — verified directly against Postgres rather than by
        // `cleanupTestOrders` (see this file's header).
        assertBaseline(await readBaselineCounts(db), "after");
      },
    );
  });

  // =========================================================================
  describe("an instance with ADMIN_TOKEN unset (the guard's third answer)", () => {
    let instance: RunningInstance;

    beforeAll(async () => {
      // Delete-and-restore around the synchronous `spawn()` inside
      // `startApiInstance` — see this file's header, "WHY TWO INSTANCES".
      // `startApiInstance` copies `process.env` into the child's environment
      // the instant it calls `spawn()`, so the child never sees the key for
      // the brief window it is absent here, and every other test in this
      // process (before or after) sees it restored.
      const savedAdminToken = process.env["ADMIN_TOKEN"];
      delete process.env["ADMIN_TOKEN"];
      try {
        instance = await startApiInstance({ apiRoot: API_ROOT, port: PORT, databaseUrl });
      } finally {
        if (savedAdminToken !== undefined) process.env["ADMIN_TOKEN"] = savedAdminToken;
      }
    }, 60_000);

    afterAll(async () => {
      if (instance !== undefined) await stopApiInstance(instance);
    }, 15_000);

    for (const route of GUARDED_ROUTES) {
      it(`${route.label} answers 503 when ADMIN_TOKEN is not configured on this deployment`, async () => {
        const response = await postNoBody(instance.baseUrl, route.path, undefined);
        expect(response.status, `${route.path} on an unconfigured instance -> ${String(response.status)}`).toBe(503);
        const body = response.body as { readonly message?: string };
        expect(body.message, "the 503 names the disabled surface").toContain("ADMIN_TOKEN");
      });
    }
  });
});
