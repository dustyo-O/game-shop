// @layer: integration
// @spec: 003-failure-and-recovery
/**
 * The feature-level acceptance suite for
 * `context/spec/003-failure-and-recovery/functional-spec.md` — every
 * acceptance criterion in §2.1 through §2.9 that is testable **at the
 * single-instance integration layer** (`architecture.md` §7: "test/acceptance
 * … run against one API process, since nothing there needs overlapping
 * requests"), verified against the whole assembled feature (Slices 1-8)
 * rather than against any one slice. This is Slice 9's own task, mirroring
 * `./single-issuance-under-races.test.ts`'s role for spec 002: the eight
 * implementation slices are done and each was verified on its own; this file
 * proves the seams between them hold — specifically the shopper- and
 * operator-visible **wire shape** those per-slice verifications did not
 * pin down, because they were proving concurrency, not the HTTP contract.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE, AND WHERE IT ACTUALLY LIVES
 * ---------------------------------------------------------------------------
 *   - **§2.1 criteria 1 & 4, §2.2 criteria 1, 2, 3 & 5 — the ladder's
 *     behaviour under genuine concurrency, and R2's stock-accounting
 *     invariant.** `tasks.md`'s standing requirement is explicit: "a
 *     `max: 1` pool serialises everything inside one instance, so a
 *     single-instance check passes against a broken implementation." Proving
 *     these needs real overlapping Postgres connections, which one process
 *     cannot produce (`architecture.md` §7, and `../concurrency/support/
 *     api-instance.ts`'s header — the measured 20-callers/9-distinct-keys
 *     defect a single-process run does not see at all). Covered across four
 *     real processes in `../concurrency/supplier-refusal-and-recovery.
 *     test.ts` (§2.1) and `../concurrency/operator-retry-race.test.ts`
 *     (§2.5, which shares the same ladder and the same R2 assertion). The
 *     hard rule itself — "never fall through while any attempt is `unknown`"
 *     — is exhaustively proven at the unit layer in
 *     `../unit/issuance-ladder.test.ts` (1,788,098 histories) and its own
 *     RED validation (a weakened guard, mutation-tested) rather than
 *     re-proven here as one more end-to-end example of the same fact.
 *   - **§2.6, the shopper watches recovery happen.** Every one of its three
 *     criteria is a fact about what a *browser*, left open and polling, goes
 *     on to render — "continues to show … processing", "changes … without
 *     the shopper reloading", "the key appears without them taking any
 *     action". No HTTP assertion from this file can distinguish a page that
 *     kept its poll running from one that silently stopped; both look
 *     identical to a script driving `fetch` directly, only different to a
 *     `setInterval` inside `apps/web`. `docs/walkthrough/phase-3.md` records
 *     that this criterion "fails by definition rather than by bug" if the
 *     polling change is skipped — exactly the class of fact a browser has to
 *     witness. Verified in slice 6's browser check (`tasks.md`), which also
 *     RED-validated by restoring the old `isSettledOrderStatus` stop
 *     condition and confirming the check fails. What this file *can* and
 *     does prove is the structural precondition that makes the browser
 *     behaviour possible at all: that the server-side status genuinely
 *     changes under an operator's retry with no shopper action of any kind
 *     (§2.5's tests below), which is the fact `apps/web`'s poll has to
 *     observe for §2.6 to hold.
 *   - **§2.7, the reviewer's checks.** `recover:refusal`, `recover:timeout`
 *     and `recover:out-of-stock` (`scripts/race/`) are the checks §2.7
 *     describes, not application behaviour under test — the same distinction
 *     `./single-issuance-under-races.test.ts`'s header draws for spec 002
 *     §2.6. Rebuilding them here would exercise the identical mechanism a
 *     second time under a different name. Already built, RED-validated and
 *     run-twice-in-a-row-verified in slice 7 (`tasks.md`).
 *   - **§2.8, the walkthrough.** `docs/walkthrough/phase-3.md` is a document,
 *     not runtime behaviour — same reasoning `./purchase-and-key-delivery.
 *     test.ts`'s header gives for §2.7 of spec 001.
 *   - **§2.9 criterion 1, the actual Russian text.** Checked as *text*, not
 *     as an HTTP response — a `GET` from this file sees `status: "out_of_
 *     stock"`, never the sentence `apps/web` renders for it. Covered in
 *     `../unit/order-status-russian-labels.test.ts`, extended for this spec
 *     rather than duplicated (its own header explains why). §2.9 criterion
 *     2 ("the operator's text may be in either language") imposes no
 *     constraint to test — nothing can fail it.
 *   - **§2.3 criterion 1 — that the shopper is told "plainly".** Whether a
 *     sentence reads as plain is a fact about rendered prose, not about the
 *     wire. Verified by a human reading the rendered page in slice 1's
 *     browser check (`tasks.md`, screenshots under `docs/screenshots/`).
 *     What this file proves is the structural precondition — that the two
 *     distinct statuses genuinely reach the wire (criterion 2, below) — and
 *     the Russian-text suite proves the sentence exists, is Russian, and
 *     differs between the two statuses.
 *
 * Full row-by-row disposition of all 40 criteria is in
 * `docs/walkthrough/phase-3-slice-9-acceptance.md` §4, not repeated here.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE INSTANCE, AND WHY NO HANG IS EVER INJECTED HERE
 * ---------------------------------------------------------------------------
 * Same reasoning as `./single-issuance-under-races.test.ts`'s header: nothing
 * below needs two requests to genuinely overlap inside Postgres. Every
 * criterion here is about what one shopper or one operator sees on one path.
 *
 * This file also never arms `hang_next` — every "outcome never established"
 * scenario is **staged directly against Postgres** instead, in the exact
 * shape `../concurrency/operator-retry-race.test.ts`'s
 * `stageStrandedDeliveringOrder` and its `settleNeverEstablished` test stage
 * theirs (see `../../context/spec/003-failure-and-recovery/technical-
 * considerations.md` §1.3: "nothing is written to `issuance_attempts`" on
 * that path — the row a real hang would leave behind is exactly the row this
 * file writes by hand). Two reasons: first, the *mechanism* that produces an
 * `unknown` attempt — the timeout ladder itself — is already exhaustively
 * proven elsewhere (see above), so re-deriving it here through a real
 * `SUPPLIER_TIMEOUT_MS`-bounded wait would only spend the 20s
 * `SETTLE_TIMEOUT_MS` budget re-establishing a fact this file does not need
 * to re-establish; second, this file's own subject is the **wire
 * representation** of that state once it exists, which is exactly as true of
 * a hand-staged row as of a genuinely timed-out one — `GET /api/admin/orders/
 * undelivered` cannot tell the difference, because it reads the same table
 * either way.
 *
 * ---------------------------------------------------------------------------
 * ASSERTIONS QUERY THE DATABASE DIRECTLY, AND STAGING WRITES RAW SQL
 * ---------------------------------------------------------------------------
 * Per `context/product/architecture.md` §7 and `./single-issuance-under-
 * races.test.ts`'s own precedent: every test that produces or depends on a
 * database fact reads or writes it with raw SQL on `db.pool`, quoted beside
 * the call. This file uses no Drizzle query builder at all — the emitted SQL
 * *is* the literal string in the source, so there is nothing to re-derive
 * from `.toSQL()` the way `architecture.md` §3.1 requires of the application
 * code.
 *
 * ---------------------------------------------------------------------------
 * RED VALIDATION
 * ---------------------------------------------------------------------------
 * The implementation this file tests already exists (Slices 1-8), so — as
 * `../concurrency/key-claim-race.test.ts`'s header puts it for the same
 * situation, and as this task's own brief requires — "RED" here means a
 * temporary, targeted inversion of what a test asserts, run to see the test
 * fail for the stated reason, then reverted byte-identical. **No production
 * source is touched by this file's RED validation**, unlike slices 3, 6 and
 * 7's own verifications, which is the brief's explicit instruction for this
 * task. Every test below states, in a comment immediately before its
 * decisive assertion, how it CAN fail without touching `src/` — either an
 * inversion actually run (`docs/walkthrough/phase-3-slice-9-acceptance.md`
 * §6 quotes the failure line of every one), or a scenario named as one the
 * shop genuinely does not satisfy.
 *
 * Run it: `pnpm test` from the repository root (this file has no dedicated
 * `pnpm test:*` alias of its own, matching `./single-issuance-under-
 * races.test.ts`).
 */
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { OrderStatus, isRecoverableOrderStatus, isSettledOrderStatus } from "@game-shop/contracts";
import type { DatabaseClient } from "@game-shop/db";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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
 * Clear of every other suite's range: `key-claim-race` (4101-4104),
 * `purchase-and-key-delivery` (4201), `single-issuance-under-races` (4301),
 * `order-lock-race` (4401-4402), `fifty-webhooks-one-order` (4501-4504),
 * `pnpm race`'s default (4601-4604, `scripts/race/run-checks.ts`),
 * `supplier-refusal-and-recovery` (4701-4704), `operator-retry-race`
 * (4801-4804), `API_PORT` (3000) and `WEB_PORT` (5173).
 */
const PORT = 4901;

/** The full supplier key pool — `packages/db/src/fixtures/supplier-key-pool.ts`. */
const KEY_POOL_SIZE = 50;

function delay(ms: number): Promise<void> {
  return new Promise((done) => {
    setTimeout(done, ms);
  });
}

interface RawResponse {
  readonly status: number;
  readonly body: unknown;
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<RawResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
}

async function putJson(
  baseUrl: string,
  path: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<RawResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
}

async function getRaw(baseUrl: string, path: string, headers?: Record<string, string>): Promise<RawResponse> {
  const response = await fetch(`${baseUrl}${path}`, { headers });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
}

async function createOrder(baseUrl: string, sku: string = PURCHASABLE_SKU): Promise<CreatedOrder> {
  const response = await postJson(baseUrl, "/api/orders", { sku });
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

/**
 * Poll `GET /api/orders/:id` until the order leaves the in-flight states.
 * `isSettledOrderStatus`, never a hand-rolled list — see `../concurrency/
 * key-claim-race.test.ts`'s own stance on this, and this task's brief:
 * "reuse both" `SETTLE_TIMEOUT_MS` and `isSettledOrderStatus`.
 *
 * `SETTLE_TIMEOUT_MS = 20_000`, not 10_000: the ladder's own worst case is
 * 12s (`worst_case_ms` in the boot log — `probes × timeout × providers`),
 * and this bound must clear it with headroom even though nothing in this
 * file ever arms a hang that would approach it.
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

/**
 * `req_{order_id}_{provider}_{attempt}` — reproduced from `../../src/
 * issuance/issuance-request-id.ts` (`deriveIssuanceRequestId`), transcribed
 * rather than imported for `../concurrency/support/db.ts`'s own reason: a
 * test that imports the derivation it is meant to catch a mistake in cannot
 * catch that mistake.
 */
function requestIdFor(orderId: string, provider: "a" | "b", attempt: number): string {
  return `req_${orderId}_${provider}_${String(attempt)}`;
}

interface UndeliveredOrderAttemptWire {
  readonly provider: string;
  readonly attempt: number;
  readonly status: string;
  readonly probe_count: number;
  readonly last_error: string | null;
}

interface UndeliveredOrderWire {
  readonly order_id: string;
  readonly sku: string;
  readonly product_name: string | null;
  readonly amount_minor: number;
  readonly currency: string;
  readonly status: string;
  readonly created_at: string;
  readonly paid_at: string | null;
  readonly retryable: boolean;
  readonly outstanding_request_id: string | null;
  readonly last_error: string | null;
  readonly attempts: readonly UndeliveredOrderAttemptWire[];
}

interface UndeliveredReportWire {
  readonly count: number;
  readonly truncated: boolean;
  readonly message: string;
  readonly orders: readonly UndeliveredOrderWire[];
}

interface RetryReportWire {
  readonly outcome: string;
  readonly order_id: string;
  readonly status: string;
  readonly provider: string | null;
  readonly request_id: string | null;
  readonly outstanding_request_id: string | null;
  readonly detail: string | null;
  readonly delivered: boolean;
}

describe("functional spec 003-failure-and-recovery — feature acceptance", () => {
  let instance: RunningInstance;
  let db: DatabaseClient;
  let adminToken: string;

  /** `Authorization: Bearer {adminToken}` — every guarded call in this file builds it the same way. */
  function authHeader(): Record<string, string> {
    return { authorization: `Bearer ${adminToken}` };
  }

  async function getUndelivered(headers: Record<string, string> = authHeader()): Promise<RawResponse> {
    return getRaw(instance.baseUrl, "/api/admin/orders/undelivered", headers);
  }

  async function retryOrder(orderId: string, headers: Record<string, string> = authHeader()): Promise<RawResponse> {
    return postJson(instance.baseUrl, `/api/admin/orders/${encodeURIComponent(orderId)}/retry`, undefined, headers);
  }

  /**
   * `PUT /internal/suppliers/:provider/behaviour` with a one-shot refusal
   * armed. `PUT` replaces, it does not merge (technical-considerations §7) —
   * every field this suite cares about is stated explicitly rather than
   * relying on the seeded baseline for the ones left out.
   */
  async function armRefusal(provider: "a" | "b"): Promise<void> {
    const response = await putJson(
      instance.baseUrl,
      `/internal/suppliers/${provider}/behaviour`,
      { failure_rate: 0, hang_rate: 0, hang_ms: 0, fail_next: 1, hang_next: 0 },
      authHeader(),
    );
    if (response.status !== 200) {
      throw new Error(`PUT .../${provider}/behaviour -> ${String(response.status)}: ${JSON.stringify(response.body)}`);
    }
  }

  /**
   * Reset one provider's behaviour to the seeded baseline — `PUT {}`, the
   * documented reset (technical-considerations §7). Also done directly
   * against the database in `afterEach` below (the house rule this task's
   * brief states explicitly), so this is the belt to that suspenders: the
   * endpoint round-trip additionally proves `PUT {}` really does restore
   * zero, which the direct-SQL reset alone would not exercise.
   */
  async function resetBehaviourViaEndpoint(provider: "a" | "b"): Promise<void> {
    await putJson(instance.baseUrl, `/internal/suppliers/${provider}/behaviour`, {}, authHeader());
  }

  const DRAIN_SENTINEL = "test_sentinel_drain_003_acceptance";

  /**
   * Claim every unclaimed key under a value derived from {@link DRAIN_SENTINEL}
   * — the same technique `../concurrency/supplier-refusal-and-recovery.
   * test.ts` and `../concurrency/operator-retry-race.test.ts` use, and for the
   * same reason: `claimed_by_request_id` is UNIQUE (I6), so fifty rows cannot
   * share one literal value.
   *
   *   update supplier_keys
   *      set claimed_by_request_id = $1 || '_' || id::text, claimed_at = now()
   *    where claimed_by_request_id is null;
   */
  async function drainKeyPool(): Promise<number> {
    const { rowCount } = await db.pool.query(
      `update supplier_keys
          set claimed_by_request_id = $1 || '_' || id::text, claimed_at = now()
        where claimed_by_request_id is null`,
      [DRAIN_SENTINEL],
    );
    return rowCount ?? 0;
  }

  /**
   *   update supplier_keys set claimed_by_request_id = null, claimed_at = null
   *    where claimed_by_request_id like $1;
   *
   * The only lawful "unclaim" in this codebase — `packages/db/src/schema/
   * supplier.ts` — and it is a test restoring the fixture it borrowed, not a
   * production code path.
   */
  async function restoreDrainedKeyPool(): Promise<void> {
    await db.pool.query(
      `update supplier_keys set claimed_by_request_id = null, claimed_at = null
         where claimed_by_request_id like $1`,
      [`${DRAIN_SENTINEL}_%`],
    );
  }

  async function countUnclaimedKeys(): Promise<number> {
    const { rows } = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from supplier_keys where claimed_by_request_id is null`,
    );
    return rows[0]?.n ?? 0;
  }

  /**
   * Stage the wire-shape fact §2.2 criterion 4 and §2.4 criterion 4 are about
   * — an order whose outcome was **never established** — without waiting on
   * a real timeout. See this file's header, "WHY ONE INSTANCE, AND WHY NO
   * HANG IS EVER INJECTED HERE": this is exactly the row
   * `settleNeverEstablished` leaves behind (technical-considerations §1.3 —
   * "nothing is written to `issuance_attempts`"; the row already there from
   * the `probe` rung's own `ON CONFLICT DO UPDATE` still reads `unknown`
   * with `last_error` NULL), written directly rather than produced by a
   * 6-second wait. The order is left in `delivery_failed`, matching
   * `settleNeverEstablished`'s own destination.
   *
   * A real, claimed key is bound under the staged request id — the honest
   * meaning of `unknown`: a key MAY genuinely exist, and only re-probing
   * that exact id can say. Mirrors `../concurrency/operator-retry-race.
   * test.ts`'s own staging for the identical shape.
   */
  async function stageNeverEstablishedOrder(orderId: string, probeCount: number): Promise<string> {
    const requestId = requestIdFor(orderId, "a", 1);

    // update orders set status = 'delivery_failed', updated_at = now() where id = $1;
    await db.pool.query(`update orders set status = 'delivery_failed', updated_at = now() where id = $1`, [orderId]);

    // insert into issuance_attempts (request_id, order_id, provider, attempt, status, probe_count)
    // values ($1, $2, 'a', 1, 'unknown', $3);
    // -- status = 'unknown', last_error left NULL (the column's own default) —
    // -- the honest meaning of "never established": no error recorded, because
    // -- nobody knows.
    await db.pool.query(
      `insert into issuance_attempts (request_id, order_id, provider, attempt, status, probe_count)
       values ($1, $2, 'a', 1, 'unknown', $3)`,
      [requestId, orderId, probeCount],
    );

    // A key genuinely claimed under this exact request id — the supplier's
    // side of the story a re-probe alone could still recover.
    const claimed = await db.pool.query<{ code: string }>(
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
    if (code === undefined) throw new Error("stageNeverEstablishedOrder: no unclaimed key available to stage with");

    // insert into supplier_requests (request_id, provider, code) values ($1, 'a', $2);
    await db.pool.query(`insert into supplier_requests (request_id, provider, code) values ($1, 'a', $2)`, [
      requestId,
      code,
    ]);

    return requestId;
  }

  /** Every `paid` event on file for one order — proof the payment was not discarded (§2.3 criterion 4). */
  async function countPaidEvents(orderId: string): Promise<number> {
    // select count(*)::int as n from payment_events where order_id = $1 and status = 'paid';
    const { rows } = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from payment_events where order_id = $1 and status = 'paid'`,
      [orderId],
    );
    return rows[0]?.n ?? 0;
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
        "ADMIN_TOKEN is not set (or shorter than 16 chars), and this suite drives the recovery " +
          "endpoints and supplier behaviour through their guarded control surfaces. See .env.example.",
      );
    }
    adminToken = token;

    db = createTestDatabaseClient("acceptance-003-assert");
    assertBaseline(await readBaselineCounts(db), "before");

    // Rebuilding from current source is what makes RED validation meaningful
    // — see ../concurrency/support/api-instance.ts's header.
    console.log("failure-and-recovery: building @game-shop/db, @game-shop/contracts and @game-shop/api...");
    execFileSync("pnpm", ["run", "build:packages"], { cwd: REPO_ROOT, stdio: "inherit" });
    execFileSync("pnpm", ["--filter", "@game-shop/api", "run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });

    instance = await startApiInstance({ apiRoot: API_ROOT, port: PORT, databaseUrl });
    console.log(`failure-and-recovery: apps/api healthy on port ${String(instance.port)} (pid ${String(instance.pid)})`);
  }, 120_000);

  /**
   * Cleanup: reset `supplier_behaviour` counters to zero for BOTH providers,
   * unconditionally, after every single test — a leaked `fail_next` from one
   * test breaks the next one's baseline, and this suite's own §2.4 "nothing
   * stuck" test (which must see a clean shop) runs immediately after
   * whichever test happened to run before it in watch mode or a future
   * re-ordering.
   *
   *   update supplier_behaviour set fail_next = 0, hang_next = 0, hang_before_claim = false
   *    where provider = $1;
   */
  afterEach(async () => {
    if (db === undefined) return;
    for (const provider of ["a", "b"]) {
      await db.pool.query(
        `update supplier_behaviour set fail_next = 0, hang_next = 0, hang_before_claim = false where provider = $1`,
        [provider],
      );
    }
  });

  afterAll(async () => {
    if (instance !== undefined) await stopAllApiInstances([instance]);

    if (db !== undefined) {
      assertBaseline(await readBaselineCounts(db), "after");
      await db.close();
    }
  }, 60_000);

  // =========================================================================
  // §2.4 — nothing stuck: this MUST run before any other describe block in
  // this file creates an order, since it depends on the freshly-asserted
  // baseline (0 orders) from beforeAll. See this file's header discipline.
  // =========================================================================
  describe("§2.4 — a person can find every purchase that was paid for but never delivered", () => {
    it(
      "nothing is stuck: 200 with an explicit EMPTY array and a plain-English message, never a blank " +
        "screen with no explanation (§2.4 criterion 5)",
      async () => {
        const response = await getUndelivered();
        expect(response.status, `GET /api/admin/orders/undelivered -> ${String(response.status)}`).toBe(200);
        const report = response.body as UndeliveredReportWire;

        expect(report.count, "nothing paid-and-undelivered exists at this point in the suite").toBe(0);
        expect(Array.isArray(report.orders), "`orders` is an explicit array, not omitted or null").toBe(true);
        expect(report.orders).toHaveLength(0);
        expect(report.truncated).toBe(false);
        // CAN FAIL: `message` genuinely could be an empty string if a future
        // edit removed the human-readable sentence and left only the array —
        // `.toBeGreaterThan(0)` inverted to `.toBe(0)` and re-run:
        //   AssertionError: message: "Nothing to recover: every paid order is
        //   holding a key.": expected 54 to be +0
        expect(typeof report.message).toBe("string");
        expect(report.message.length, `message: ${JSON.stringify(report.message)}`).toBeGreaterThan(0);
      },
    );

    it(
      "a freshly paid order is visible in the recovery list IMMEDIATELY — no waiting period elapses " +
        "before it appears, whatever stage of settling it is currently in (§2.4 criteria 1 & 2)",
      async () => {
        const drained = await drainKeyPool();
        expect(drained, "precondition: the whole pool was claimed under the sentinel").toBe(KEY_POOL_SIZE);
        const orderIds: string[] = [];

        try {
          const order = await createOrder(instance.baseUrl);
          orderIds.push(order.id);
          await payOrder(instance.baseUrl, order.id);

          // No delay of any kind here — the list is asked in the very next
          // line after payment is reported. §2.4 criterion 2 forbids a grace
          // period, and the pool is drained so this order can never reach
          // `delivered` and leave the in-flight/recoverable set entirely.
          const response = await getUndelivered();
          expect(response.status).toBe(200);
          const report = response.body as UndeliveredReportWire;
          const ids = new Set(report.orders.map((row) => row.order_id));

          // `paid_at` is asserted HERE and not on the SQL-staged rows below,
          // because this is the one order in the file that was paid through
          // the live webhook path and so has a `paid` event for the LATERAL
          // join to find. The shape matters, not just non-null: slice 4 found
          // `sql<Date>` returning the raw `'2026-09-11 13:49:00.12+00'`
          // string (fixed with `.mapWith()`), which is a value a `not.toBeNull`
          // would have accepted. Only a `Date` serialises to `…T…Z`.
          const listed = report.orders.find((row) => row.order_id === order.id);
          expect(listed?.paid_at, "paid_at is the payment event's received_at, serialised as ISO 8601").toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
          );

          // CAN FAIL: if the recovery list applied any age-based filter (the
          // "obvious cleanup" technical-considerations §4 explicitly rules
          // out), an order this fresh would be missing. `.toBe(true)`
          // inverted to `.toBe(false)` and re-run:
          //   AssertionError: order ord_… must appear immediately; list:
          //   ["ord_…"]: expected true to be false
          expect(ids.has(order.id), `order ${order.id} must appear immediately; list: ${JSON.stringify([...ids])}`).toBe(
            true,
          );

          await waitUntilSettled(instance.baseUrl, order.id);
        } finally {
          await cleanupTestOrders(db, orderIds);
          await restoreDrainedKeyPool();
        }

        expect(await countUnclaimedKeys(), "the pool is back to full after cleanup").toBe(KEY_POOL_SIZE);
      },
    );

    it("a delivered order is NOT in the recovery list (§2.4 criterion 3, the negative complement of membership)", async () => {
      const orderIds: string[] = [];
      try {
        const order = await createOrder(instance.baseUrl);
        orderIds.push(order.id);
        await payOrder(instance.baseUrl, order.id);
        const settled = await waitUntilSettled(instance.baseUrl, order.id);
        expect(settled.status).toBe(OrderStatus.Delivered);

        const response = await getUndelivered();
        const report = response.body as UndeliveredReportWire;
        const ids = new Set(report.orders.map((row) => row.order_id));

        // CAN FAIL: this is the DIRECT negative check of the ordinary,
        // un-stuck path — a query that forgot the `NOT EXISTS (SELECT 1 FROM
        // deliveries …)` predicate would list every order ever delivered.
        // `.toBe(false)` inverted to `.toBe(true)` and re-run:
        //   AssertionError: a delivered order must not be listed; list: []:
        //   expected false to be true
        expect(ids.has(order.id), `a delivered order must not be listed; list: ${JSON.stringify([...ids])}`).toBe(
          false,
        );
      } finally {
        await cleanupTestOrders(db, orderIds);
      }
    });

    it(
      "a listed row carries what was bought, when it was paid, and what went wrong — and 'never " +
        "established' is shown as such, not folded into a definite failure (§2.4 criterion 4)",
      async () => {
        const orderIds: string[] = [];
        try {
          const order = await createOrder(instance.baseUrl);
          orderIds.push(order.id);
          const view = await getOrder(instance.baseUrl, order.id); // for product_name, independently of the list

          const probeCount = 3;
          const requestId = await stageNeverEstablishedOrder(order.id, probeCount);

          const response = await getUndelivered();
          const report = response.body as UndeliveredReportWire;
          const row = report.orders.find((candidate) => candidate.order_id === order.id);
          if (row === undefined) throw new Error(`order ${order.id} not present in the recovery list`);

          // "What was bought."
          expect(row.sku).toBe(order.sku);
          expect(row.product_name).toBe(view.product_name);
          expect(row.amount_minor).toBe(order.amount_minor);
          expect(row.currency).toBe(order.currency);

          // "When it was paid for." No payment_events row was written by
          // this staging (deliberately — see the note on §2.3 criterion 4
          // below, which tests payment retention through the real payment
          // path instead), so paid_at is honestly null here rather than
          // fabricated.
          expect(row.paid_at).toBeNull();

          // "What went wrong" — and the fact §2.2 criterion 4 is really
          // about: this MUST read `unknown`, never `failed`.
          expect(row.status).toBe(OrderStatus.DeliveryFailed);
          expect(row.outstanding_request_id).toBe(requestId);
          expect(row.last_error, "top-level last_error mirrors the unknown attempt: no error was ever recorded").toBeNull();
          expect(row.attempts).toHaveLength(1);
          const attempt = row.attempts[0];
          if (attempt === undefined) throw new Error("expected exactly one attempt entry");
          // CAN FAIL — the exact bug technical-considerations §9.3 names
          // (`reason ?? "failed"`): inverted to `.toBe("failed")` and
          // re-run; see this task's report for the quoted failure.
          expect(attempt.status, "the newest attempt must read 'unknown', never 'failed'").toBe("unknown");
          expect(attempt.last_error).toBeNull();
          expect(attempt.probe_count).toBe(probeCount);
          expect(attempt.provider).toBe("a");
          expect(attempt.attempt).toBe(1);
          expect(row.retryable, "delivery_failed is recoverable, so this row is retryable").toBe(true);
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );

    it(
      "a missing or a wrong operator token is refused with 401 on both guarded routes — the list, and " +
        "the retry (§2.4 criterion 6; the third answer, 503 when ADMIN_TOKEN is unconfigured, is a unit " +
        "test in ../unit/admin-token-guard.test.ts — see that file for why)",
      async () => {
        const noToken = await getUndelivered({});
        expect(noToken.status, "no Authorization header at all").toBe(401);

        const wrongToken = await getUndelivered({ authorization: "Bearer not-the-real-token-at-all" });
        expect(wrongToken.status, "a well-formed but wrong bearer token").toBe(401);

        const malformedScheme = await getUndelivered({ authorization: `Basic ${adminToken}` });
        expect(malformedScheme.status, "the right token under the wrong scheme (negative — malformed)").toBe(401);

        // The same guard protects the retry route too — one class, one
        // decision, both endpoints (technical-considerations §8).
        const retryNoToken = await retryOrder(`ord_test_003_doesnotmatter_${randomUUID()}`, {});
        expect(retryNoToken.status, "the retry route is behind the identical guard").toBe(401);
      },
    );

    it(
      "negative — PUT /internal/suppliers/:provider/behaviour for a provider that does not exist is " +
        "refused with 404, never silently accepted",
      async () => {
        const response = await putJson(instance.baseUrl, "/internal/suppliers/zzz/behaviour", {}, authHeader());
        expect(response.status).toBe(404);
      },
    );
  });

  // =========================================================================
  describe("§2.1 — a supplier that refuses is replaced by the backup (wire shape)", () => {
    it(
      "the order page reads IDENTICALLY whichever supplier fulfilled it — the same field set, no field " +
        "naming which supplier was used, whether the main supplier or the backup delivered (§2.1 " +
        "criterion 2; the fall-through mechanics themselves are verified across four processes in " +
        "../concurrency/supplier-refusal-and-recovery.test.ts)",
      async () => {
        const orderIds: string[] = [];
        try {
          const viaMain = await createOrder(instance.baseUrl);
          orderIds.push(viaMain.id);
          await payOrder(instance.baseUrl, viaMain.id);
          const mainSettled = await waitUntilSettled(instance.baseUrl, viaMain.id);
          expect(mainSettled.status).toBe(OrderStatus.Delivered);

          await armRefusal("a");
          const viaBackup = await createOrder(instance.baseUrl);
          orderIds.push(viaBackup.id);
          await payOrder(instance.baseUrl, viaBackup.id);
          const backupSettled = await waitUntilSettled(instance.baseUrl, viaBackup.id);
          expect(backupSettled.status).toBe(OrderStatus.Delivered);
          // Sanity: this order really did fall through to B, or the test
          // proves nothing about "whichever supplier" — confirmed against
          // the ledger, not inferred from the response.
          const attemptRows = await db.pool.query<{ provider: string }>(
            `select provider from issuance_attempts where order_id = $1 order by attempt asc`,
            [viaBackup.id],
          );
          expect(attemptRows.rows.map((r) => r.provider), "precondition: this order was actually fulfilled by B").toEqual([
            "a",
            "b",
          ]);

          const mainKeys = Object.keys(mainSettled).sort();
          const backupKeys = Object.keys(backupSettled).sort();
          expect(backupKeys, "identical field set regardless of which supplier answered").toEqual(mainKeys);

          // CAN FAIL: the shop genuinely never sends this field — inverted
          // to `.toContain` and re-run; see this task's report for the
          // quoted failure.
          for (const forbidden of ["provider", "supplier", "supplier_a", "supplier_b", "vendor", "source"]) {
            expect(mainKeys, `no "${forbidden}" field on a normal order`).not.toContain(forbidden);
            expect(backupKeys, `no "${forbidden}" field on a fallen-through order`).not.toContain(forbidden);
          }
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );

    it(
      "when both suppliers definitely refuse, the order settles into an ACTIONABLE status rather than " +
        "appearing to still be in progress — wire-level; the attempt-row mechanics (two rows, no key " +
        "claimed) are verified in ../concurrency/supplier-refusal-and-recovery.test.ts (§2.1 criterion 3)",
      async () => {
        const orderIds: string[] = [];
        try {
          await armRefusal("a");
          await armRefusal("b");

          const order = await createOrder(instance.baseUrl);
          orderIds.push(order.id);
          await payOrder(instance.baseUrl, order.id);
          const settled = await waitUntilSettled(instance.baseUrl, order.id);

          expect(settled.status, "not left reading 'delivering' forever").not.toBe(OrderStatus.Delivering);
          expect(settled.status, "not silently paid-and-stuck either").not.toBe(OrderStatus.Paid);
          expect(settled.status).toBe(OrderStatus.DeliveryFailed);
          expect(settled.code).toBeNull();

          // A person CAN act on it: it shows up as retryable in the recovery list.
          const report = (await getUndelivered()).body as UndeliveredReportWire;
          const row = report.orders.find((candidate) => candidate.order_id === order.id);
          expect(row?.retryable, "an actionable state means an operator can retry it").toBe(true);
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );
  });

  // =========================================================================
  describe("§2.2 — silence from a supplier never costs the shop a second key (wire shape)", () => {
    it(
      "a request whose outcome was never established is reported to the operator as UNRESOLVED, never " +
        "as a definite failure (§2.2 criterion 4, via GET /api/admin/orders/undelivered — see the §2.4 " +
        "criterion 4 test above for the full row-shape assertion; this test is the narrow, single-fact " +
        "restatement of §2.2's own criterion)",
      async () => {
        const orderIds: string[] = [];
        try {
          const order = await createOrder(instance.baseUrl);
          orderIds.push(order.id);
          const requestId = await stageNeverEstablishedOrder(order.id, 3);

          const report = (await getUndelivered()).body as UndeliveredReportWire;
          const row = report.orders.find((candidate) => candidate.order_id === order.id);
          if (row === undefined) throw new Error(`order ${order.id} not present in the recovery list`);

          expect(row.outstanding_request_id).toBe(requestId);
          expect(row.attempts[0]?.status).not.toBe("failed");
          expect(row.attempts[0]?.status).toBe("unknown");
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );
  });

  // =========================================================================
  describe("§2.3 — an order that could not be delivered is recoverable, not broken", () => {
    it(
      "out_of_stock and delivery_failed reach the wire as DISTINCT statuses — a shopper's client can " +
        "tell the two apart (§2.3 criterion 2; the Russian text itself, and that the two sentences " +
        "differ, is checked in ../unit/order-status-russian-labels.test.ts)",
      async () => {
        const orderIds: string[] = [];
        try {
          const drained = await drainKeyPool();
          expect(drained).toBe(KEY_POOL_SIZE);
          const outOfStockOrder = await createOrder(instance.baseUrl);
          orderIds.push(outOfStockOrder.id);
          await payOrder(instance.baseUrl, outOfStockOrder.id);
          const outOfStockSettled = await waitUntilSettled(instance.baseUrl, outOfStockOrder.id);
          await restoreDrainedKeyPool();

          await armRefusal("a");
          await armRefusal("b");
          const deliveryFailedOrder = await createOrder(instance.baseUrl);
          orderIds.push(deliveryFailedOrder.id);
          await payOrder(instance.baseUrl, deliveryFailedOrder.id);
          const deliveryFailedSettled = await waitUntilSettled(instance.baseUrl, deliveryFailedOrder.id);

          expect(outOfStockSettled.status).toBe(OrderStatus.OutOfStock);
          expect(deliveryFailedSettled.status).toBe(OrderStatus.DeliveryFailed);
          expect(outOfStockSettled.status, "the two reasons are distinguishable statuses").not.toBe(
            deliveryFailedSettled.status,
          );
          expect(isRecoverableOrderStatus(outOfStockSettled.status)).toBe(true);
          expect(isRecoverableOrderStatus(deliveryFailedSettled.status)).toBe(true);
        } finally {
          await cleanupTestOrders(db, orderIds);
          await restoreDrainedKeyPool();
        }
      },
    );

    it(
      "reloading (repeating the GET) shows the SAME status and the same fields — never an error, never " +
        "an empty page (§2.3 criterion 3)",
      async () => {
        const orderIds: string[] = [];
        try {
          await armRefusal("a");
          await armRefusal("b");
          const order = await createOrder(instance.baseUrl);
          orderIds.push(order.id);
          await payOrder(instance.baseUrl, order.id);
          await waitUntilSettled(instance.baseUrl, order.id);

          const firstRead = await getOrder(instance.baseUrl, order.id);
          await delay(50); // a little separation, simulating "returns to the page later"
          const secondRead = await getOrder(instance.baseUrl, order.id);

          expect(secondRead.status).toBe(firstRead.status);
          expect(secondRead).toEqual(firstRead);
        } finally {
          await cleanupTestOrders(db, orderIds);
        }
      },
    );

    it("the payment stays recorded against the order rather than being discarded (§2.3 criterion 4)", async () => {
      const orderIds: string[] = [];
      try {
        await armRefusal("a");
        await armRefusal("b");
        const order = await createOrder(instance.baseUrl);
        orderIds.push(order.id);
        await payOrder(instance.baseUrl, order.id);
        const settled = await waitUntilSettled(instance.baseUrl, order.id);
        expect(settled.status).toBe(OrderStatus.DeliveryFailed);

        // CAN FAIL: a bug that discarded a payment_events row on a failed
        // delivery (rather than merely not delivering a key) would read 0
        // here — `.toBe(1)` inverted to `.toBe(0)` and re-run:
        //   AssertionError: the 'paid' event is still on record after delivery
        //   failed: expected 1 to be +0
        expect(await countPaidEvents(order.id), "the 'paid' event is still on record after delivery failed").toBe(1);
      } finally {
        await cleanupTestOrders(db, orderIds);
      }
    });
  });

  // =========================================================================
  describe(
    "§2.5 — an operator can push a stuck order through, and pressing twice changes nothing (wire " +
      "outcomes; the concurrency guarantees themselves — restock-then-retry, two operators racing, " +
      "probes-exhaust-under-retry — are verified across four processes in ../concurrency/operator-retry-race.test.ts)",
    () => {
      it(
        "still no key available: the retry answers 200 with the HONEST outcome and a reason, and the " +
          "order remains in the recovery list (§2.5 criterion 5)",
        async () => {
          const orderIds: string[] = [];
          try {
            const drained = await drainKeyPool();
            expect(drained).toBe(KEY_POOL_SIZE);

            const order = await createOrder(instance.baseUrl);
            orderIds.push(order.id);
            await payOrder(instance.baseUrl, order.id);
            const settled = await waitUntilSettled(instance.baseUrl, order.id);
            expect(settled.status).toBe(OrderStatus.OutOfStock);

            const retried = await retryOrder(order.id);
            expect(retried.status, `retry -> ${JSON.stringify(retried.body)}`).toBe(200);
            const report = retried.body as RetryReportWire;
            expect(report.outcome).toBe("still_out_of_stock");
            expect(report.delivered).toBe(false);
            expect(typeof report.detail).toBe("string");
            expect(report.detail?.length ?? 0, "the operator is told WHY, in words").toBeGreaterThan(0);

            const list = (await getUndelivered()).body as UndeliveredReportWire;
            const ids = new Set(list.orders.map((row) => row.order_id));
            expect(ids.has(order.id), "the order remains in the list after a retry that found nothing").toBe(true);
          } finally {
            await cleanupTestOrders(db, orderIds);
            await restoreDrainedKeyPool();
          }
        },
      );

      it(
        "an order that is NOT stuck (already delivered) refuses the retry with 409 and changes nothing " +
          "(§2.5 criterion 6)",
        async () => {
          const orderIds: string[] = [];
          try {
            const order = await createOrder(instance.baseUrl);
            orderIds.push(order.id);
            await payOrder(instance.baseUrl, order.id);
            const settled = await waitUntilSettled(instance.baseUrl, order.id);
            expect(settled.status).toBe(OrderStatus.Delivered);
            if (settled.status !== OrderStatus.Delivered) return;
            const originalCode = settled.code;

            const retried = await retryOrder(order.id);
            // CAN FAIL: a retry endpoint with no status guard would happily
            // re-run issuance on an already-delivered order — inverted to
            // `.toBe(200)` and re-run; see this task's report for the
            // quoted failure.
            expect(retried.status, `retry on a delivered order -> ${JSON.stringify(retried.body)}`).toBe(409);

            const after = await getOrder(instance.baseUrl, order.id);
            expect(after.status, "unchanged").toBe(OrderStatus.Delivered);
            if (after.status !== OrderStatus.Delivered) return;
            expect(after.code, "the shopper's key is unchanged — no re-delivery happened").toBe(originalCode);

            // select count(*)::int as n from deliveries where order_id = $1;
            const dbDeliveries = await db.pool.query<{ n: number }>(
              `select count(*)::int as n from deliveries where order_id = $1`,
              [order.id],
            );
            expect(dbDeliveries.rows[0]?.n, "still exactly one delivery row — the refusal wrote nothing").toBe(1);
          } finally {
            await cleanupTestOrders(db, orderIds);
          }
        },
      );

      it(
        "negative — an order that was never even paid (still `created`) also refuses a retry with 409, " +
          "distinctly from a genuinely stuck order",
        async () => {
          const order = await createOrder(instance.baseUrl);
          const orderIds = [order.id];
          try {
            const retried = await retryOrder(order.id);
            expect(retried.status, `retry on an unpaid order -> ${JSON.stringify(retried.body)}`).toBe(409);
          } finally {
            await cleanupTestOrders(db, orderIds);
          }
        },
      );

      it("negative — retrying an order id that does not exist at all is refused with 404, distinctly from 409", async () => {
        const nonexistentId = `ord_test_003_missing_${randomUUID()}`;
        const retried = await retryOrder(nonexistentId);
        expect(retried.status).toBe(404);
      });
    },
  );
});
