#!/usr/bin/env node
// @layer: script
// @spec: 003-failure-and-recovery
/**
 * `pnpm race recover-timeout` — functional spec §2.7's second named check:
 * *"a supplier that goes quiet"* (technical-considerations §12, §2.2's
 * scenario — the assignment's central trap, staged for real).
 *
 * ---------------------------------------------------------------------------
 * THE MECHANISM THIS PROVES
 * ---------------------------------------------------------------------------
 * Supplier A is made to hang **after** its key claim commits
 * (`hang_before_claim: false`, the default, and the one this check states
 * explicitly rather than relying on a default it does not control) for longer
 * than `SUPPLIER_TIMEOUT_MS`. The shop's own `AbortSignal.timeout` severs its
 * socket first, records the attempt `unknown` (never `failed` — the
 * assignment's central distinction, `apps/api/src/issuance/issuance-attempt-status.ts`),
 * and — inside the **same** invocation, because "one invocation walks the
 * whole ladder to a resting state" (technical-considerations §1.4) —
 * immediately recomputes the ladder. The newest attempt is `unknown` and
 * probes are not exhausted, so the rung is `probe`: the **same** supplier,
 * the **same** derived request id, asked again. A's ledger already holds a
 * code for that id (the claim committed before the hang started), so the
 * re-probe answers instantly and the walk rests `ok`. One request id, one
 * row, `probe_count` 2 — not two rows, and never a second key.
 *
 * ---------------------------------------------------------------------------
 * WHY B MUST NEVER BE ASKED, AND HOW THIS CHECK KNOWS
 * ---------------------------------------------------------------------------
 * The hard rule the whole phase turns on: *never fall through while any
 * attempt for this order is `unknown`* (technical-considerations §2.2). A
 * timeout is not a refusal, so falling through to B here would be how one
 * order gets charged for two keys the moment both suppliers happen to answer.
 * This check asserts it the only way that means anything against a live
 * system: **no `issuance_attempts` row for provider `b` exists for this
 * order at all** — not a status on B's row, because there must be no row.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ARMS ONLY `hang_next`, NEVER `fail_next` ON THE SAME CALL
 * ---------------------------------------------------------------------------
 * `fail_next` is read before `hang_next` (`SupplierBehaviourService.shouldRefuse`
 * runs first). Arming both on one `PUT` would refuse the very call this check
 * needs to hang — spending the refusal and leaving the hang armed for
 * whatever calls A next, which would not be this order at all. `behaviourBody`
 * always sends `fail_next: 0` alongside `hang_next: 1`, so the two mechanisms
 * can never collide inside this check.
 *
 * ---------------------------------------------------------------------------
 * R2, APPLIED HERE RATHER THAN QUOTED
 * ---------------------------------------------------------------------------
 * Phase 2's RED validation came back green with `FOR UPDATE` removed, because
 * `deliveries.order_id` UNIQUE still kept the shopper to one key. The same
 * masking applies to a broken `unknown` guard: the shopper would still see one
 * key while the shop quietly asked a second supplier for it. So this check's
 * load-bearing assertion is stock accounting — `claimed keys == deliveries` —
 * read before and after, never the shopper's key count alone.
 */
import {
  createOrder,
  deriveIssuanceRequestId,
  describeMissingAdminAffordance,
  isMissingAdminAffordance,
  newEventId,
  postPaidWebhook,
  putSupplierBehaviour,
  readAdminToken,
  waitUntilSettled,
} from "./support/recovery-scenario.ts";
import { cleanupTestOrders, openRaceDatabase, PURCHASABLE_SKU } from "./support/race-database.ts";
import { resolveRaceTargets } from "./support/race-targets.ts";

const CHECK_NAME = "race:recover-timeout";

/**
 * The supplier deadline the TARGET enforces, and where this check learned it.
 *
 * The hang armed below must outlast that deadline or the check stages the
 * *other* scenario — slow-but-successful, no timeout, nothing exercised — and
 * passes vacuously (spec 006 R8: a `hang_ms` derived from the local `2000`
 * against a live target running `5000` never times out). Locally the runner
 * hands the checks the same `SUPPLIER_TIMEOUT_MS` it hands the instances, so
 * the environment was a fair source; against a live target this process's
 * environment says nothing about the target's. So: the target's own
 * `GET /api/health` (`supplier_timeout_ms` — the value its issuance client
 * actually waits, `apps/api/src/health.controller.ts`) is preferred, the
 * environment is the fallback, and the line printed names which one was used.
 */
interface SupplierTimeout {
  readonly ms: number;
  readonly source: string;
}

/** `supplier_timeout_ms` from the first target's `/api/health`, or `undefined` when it does not publish one (an older build, or not this API). */
async function readTargetSupplierTimeoutMs(baseUrl: string): Promise<number | undefined> {
  try {
    const response = await fetch(`${baseUrl}/api/health`);
    if (!response.ok) return undefined;
    const body = (await response.json()) as { supplier_timeout_ms?: unknown };
    const value = body.supplier_timeout_ms;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** `apps/api/src/config/supplier-config.ts`'s own default when the environment has nothing usable. */
const DEFAULT_SUPPLIER_TIMEOUT_MS = 2000;

async function resolveSupplierTimeout(baseUrl: string): Promise<SupplierTimeout> {
  const fromTarget = await readTargetSupplierTimeoutMs(baseUrl);
  if (fromTarget !== undefined) return { ms: fromTarget, source: "from target /api/health" };

  const raw = process.env["SUPPLIER_TIMEOUT_MS"];
  const parsed = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    return { ms: parsed, source: "from SUPPLIER_TIMEOUT_MS env — target did not report one" };
  }
  return {
    ms: DEFAULT_SUPPLIER_TIMEOUT_MS,
    source: "the 2000 default — target did not report one and SUPPLIER_TIMEOUT_MS is unset",
  };
}

const targets = resolveRaceTargets();
targets.announce(CHECK_NAME);

const failures: string[] = [];

function record(ok: boolean, label: string, detail: string): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

console.log(
  `${CHECK_NAME} — proves: a hang placed AFTER the key claim commits produces an 'unknown' ` +
    "attempt, never 'failed'; the ladder re-probes the SAME supplier under the SAME request id " +
    "inside one invocation (technical-considerations §1.4); B is never asked; and stock " +
    "accounting holds — technical-considerations §12, §2.2, §7.1, §11 R1/R2.",
);

const supplierTimeout = await resolveSupplierTimeout(targets.at(0));
const supplierTimeoutMs = supplierTimeout.ms;
console.log(`  supplier timeout ${String(supplierTimeoutMs)} ms (${supplierTimeout.source})`);
// Comfortably past the target's SUPPLIER_TIMEOUT_MS (R1's corrected
// inequality: SUPPLIER_TIMEOUT_MS < hang_ms < ceiling) and comfortably short
// in absolute terms — there is no platform ceiling to respect locally, only
// this check's own patience. Against a live target running 5000 this lands at
// 6500, inside Vercel's 60 s function ceiling with room for the re-probe.
const hangMs = supplierTimeoutMs + 1_500;
const settleTimeoutMs = Math.max(15_000, hangMs + 10_000);

const adminToken = readAdminToken();
if (adminToken === undefined) {
  console.log(
    `  SKIP  ${CHECK_NAME} needs ADMIN_TOKEN to arm the supplier's behaviour and this process ` +
      "has none. `pnpm race` sets it from the local .env for the instances it spawns and for " +
      "itself; a deployed target must be given the same value out of band.",
  );
  process.exitCode = 3;
} else {
  let orderId: string | undefined;
  const db = openRaceDatabase("recover-timeout");

  try {
    const resetA = await putSupplierBehaviour(targets.at(0), adminToken, "a");
    if (isMissingAdminAffordance(resetA)) {
      console.log(`  SKIP  ${CHECK_NAME} — ${describeMissingAdminAffordance(resetA)}`);
      process.exitCode = 3;
    } else {
      record(resetA.ok, "provider a reset to the seeded baseline before arming", `status=${String(resetA.status)}`);
      const resetB = await putSupplierBehaviour(targets.at(1), adminToken, "b");
      record(resetB.ok, "provider b reset to the seeded baseline before arming", `status=${String(resetB.status)}`);

      let stockBefore: { claimed: number; deliveries: number } | undefined;
      if (db !== undefined) {
        const stock = await db.pool.query<{ claimed: number; deliveries: number }>(
          `select
             (select count(*) from supplier_keys where claimed_by_request_id is not null)::int as claimed,
             (select count(*) from deliveries)::int as deliveries`,
        );
        stockBefore = { claimed: stock.rows[0]?.claimed ?? -1, deliveries: stock.rows[0]?.deliveries ?? -1 };
        record(
          stockBefore.claimed === stockBefore.deliveries,
          "stock accounting holds before this run (claimed keys == deliveries, R2)",
          `claimed=${String(stockBefore.claimed)}, deliveries=${String(stockBefore.deliveries)}`,
        );
      } else {
        console.log("  SKIP  stock accounting before this run — needs DATABASE_URL");
      }

      // -----------------------------------------------------------------------
      // Arm A's ONE-SHOT hang, explicit on every field that decides the
      // scenario: `hang_next: 1` (the counter), `hang_ms` past the shop's own
      // deadline (the duration — R1), `hang_before_claim: false` stated rather
      // than left to the default (the placement — this file's header; §7.1's
      // "the trap"), and `fail_next: 0` so the refusal path cannot fire first.
      // -----------------------------------------------------------------------
      const armed = await putSupplierBehaviour(targets.at(2), adminToken, "a", {
        hangNext: 1,
        hangMs,
        hangBeforeClaim: false,
      });
      record(armed.ok, `arming A's one-shot hang (hang_next: 1, hang_ms: ${String(hangMs)}) answers 200`, `status=${String(armed.status)}`);
      record(
        armed.body?.["hang_next"] === 1 &&
          armed.body?.["hang_ms"] === hangMs &&
          armed.body?.["hang_before_claim"] === false &&
          armed.body?.["fail_next"] === 0,
        "the stored row echoes the exact hang armed, placed AFTER the claim, with no refusal armed alongside it",
        JSON.stringify(armed.body),
      );

      const order = await createOrder(targets.at(3), PURCHASABLE_SKU);
      orderId = order.id;
      console.log(
        `  order ${order.id} created on a fresh instance; paying it on another — the walk will hang ` +
          `${String(hangMs)}ms, past the target's supplier timeout of ${String(supplierTimeoutMs)}ms, before it resolves`,
      );

      const eventId = newEventId(order.id, "recovertimeout");
      const webhookResult = await postPaidWebhook(targets.at(0), eventId, order.id);
      record(webhookResult.ok, "the paid webhook answers 2xx immediately (the hang is scheduled work, not this request)", `status=${String(webhookResult.status)}`);
      record(
        webhookResult.outcome === "stored",
        'the paid webhook is acknowledged as first sight ("stored")',
        `outcome=${String(webhookResult.outcome)}`,
      );

      const settled = await waitUntilSettled(targets.at(1), order.id, settleTimeoutMs);
      record(
        settled.status === "delivered",
        "the order settles delivered — the re-probe found A's own ledger already held a code",
        `status=${settled.status}`,
      );

      const requestIdA1 = deriveIssuanceRequestId(order.id, "a", 1);

      if (db === undefined) {
        console.log("  SKIP  every database assertion below — needs DATABASE_URL");
      } else {
        const attempts = await db.pool.query<{
          request_id: string;
          provider: string;
          attempt: number;
          status: string;
          probe_count: number;
          last_error: string | null;
        }>(`select request_id, provider, attempt, status, probe_count, last_error from issuance_attempts where order_id = $1`, [
          order.id,
        ]);
        record(attempts.rowCount === 1, "exactly ONE attempt row for the order — the re-probe updated a/1, never inserted a second row", `found ${String(attempts.rowCount)} row(s)`);

        const attemptA1 = attempts.rows.find((row) => row.request_id === requestIdA1);
        record(
          attemptA1?.status === "ok" && attemptA1.probe_count === 2 && attemptA1.last_error === null,
          "a/1 reads status=ok, probe_count=2, last_error NULL — asked, timed out once, re-probed, resolved",
          `${JSON.stringify(attemptA1)}`,
        );

        const providerBRows = await db.pool.query<{ n: number }>(
          `select count(*)::int as n from issuance_attempts where order_id = $1 and provider = 'b'`,
          [order.id],
        );
        record(
          (providerBRows.rows[0]?.n ?? -1) === 0,
          "no issuance_attempts row for provider b — the hard rule held, B was never asked",
          `${String(providerBRows.rows[0]?.n)} row(s)`,
        );

        const supplierRequestRows = await db.pool.query<{ n: number; provider: string }>(
          `select count(*)::int as n, min(provider) as provider from supplier_requests where request_id = $1`,
          [requestIdA1],
        );
        record(
          (supplierRequestRows.rows[0]?.n ?? -1) === 1 && supplierRequestRows.rows[0]?.provider === "a",
          "exactly one supplier_requests row for a/1, against provider a — one code on file, asked for twice",
          `${JSON.stringify(supplierRequestRows.rows[0])}`,
        );

        const claimedForA1 = await db.pool.query<{ n: number }>(
          `select count(*)::int as n from supplier_keys where claimed_by_request_id = $1`,
          [requestIdA1],
        );
        record(
          (claimedForA1.rows[0]?.n ?? -1) === 1,
          "exactly one supplier_keys row claimed by a/1's request id — the re-probe claimed no second key",
          `${String(claimedForA1.rows[0]?.n)} row(s)`,
        );

        const deliveredRows = await db.pool.query<{ n: number }>(`select count(*)::int as n from deliveries where order_id = $1`, [
          order.id,
        ]);
        record((deliveredRows.rows[0]?.n ?? -1) === 1, "exactly one deliveries row for the order", `${String(deliveredRows.rows[0]?.n)} row(s)`);

        const stockAfterRows = await db.pool.query<{ claimed: number; deliveries: number }>(
          `select
             (select count(*) from supplier_keys where claimed_by_request_id is not null)::int as claimed,
             (select count(*) from deliveries)::int as deliveries`,
        );
        const stockAfter = { claimed: stockAfterRows.rows[0]?.claimed ?? -1, deliveries: stockAfterRows.rows[0]?.deliveries ?? -1 };
        record(
          stockAfter.claimed === stockAfter.deliveries,
          "stock accounting holds after this run (claimed keys == deliveries, R2) — the assertion that would fail if the unknown guard were broken",
          `claimed=${String(stockAfter.claimed)}, deliveries=${String(stockAfter.deliveries)}`,
        );
        if (stockBefore !== undefined) {
          record(
            stockAfter.claimed - stockBefore.claimed === 1 && stockAfter.deliveries - stockBefore.deliveries === 1,
            "exactly one more key claimed and exactly one more delivery than before this run",
            `claimed +${String(stockAfter.claimed - stockBefore.claimed)}, deliveries +${String(
              stockAfter.deliveries - stockBefore.deliveries,
            )}`,
          );
        }
      }
    }
  } finally {
    if (db !== undefined) {
      await db.pool.query(
        `update supplier_behaviour
           set failure_rate = 0, hang_rate = 0, hang_ms = 0, fail_next = 0, hang_next = 0,
               hang_before_claim = false, updated_at = now()`,
      );
      if (orderId !== undefined) await cleanupTestOrders(db, [orderId]);
      await db.close();
    }
  }
}

if (failures.length > 0) {
  console.error(`${CHECK_NAME} FAILED (${String(failures.length)}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else if (process.exitCode !== 3) {
  console.log(`${CHECK_NAME} passed.`);
}
