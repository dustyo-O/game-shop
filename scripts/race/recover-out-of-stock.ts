#!/usr/bin/env node
// @layer: script
// @spec: 003-failure-and-recovery
/**
 * `pnpm race recover-out-of-stock` — functional spec §2.7's third named check:
 * *"an order recovered after stock was replenished"* (technical-considerations
 * §12, §2.3's scenario driven for real).
 *
 * ---------------------------------------------------------------------------
 * THE MECHANISM THIS PROVES
 * ---------------------------------------------------------------------------
 * With the fifty-key pool empty, a paid order asks A, which refuses
 * `out_of_stock` having claimed nothing; the ladder's `fallThrough` rung asks
 * B with a new request id, which refuses the same way for the same reason
 * (technical-considerations §11 R12 — "both suppliers draw one pool, so an
 * empty pool costs one wasted fall-through call", not a bug). The order
 * settles `out_of_stock` with exactly two attempt rows and zero keys claimed.
 * Stock is then replenished and an operator presses retry
 * (`POST /api/admin/orders/:orderId/retry`) — the **identical** claim, lock
 * and ladder the automatic path uses (`order-retry.service.ts`'s header:
 * "there is no admin-only path into issuance"). The retry's opening turn is
 * `Fresh`, which resolves to `askFirst` again rather than re-settling the
 * order without asking anyone (technical-considerations §1.1's amendment),
 * and the attempt number is `max(attempt) + 1` **across every provider**
 * (R7) — `a/3`, never a reused `a/1`. The pool now holds keys, so it
 * succeeds: the order reaches `delivered`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CHECK RESTOCKS OVER DIRECT SQL, NOT AN HTTP ENDPOINT
 * ---------------------------------------------------------------------------
 * `technical-considerations.md` §7 describes restocking as
 * `POST /internal/suppliers/keys`, on the supplier's own side of the boundary,
 * inserting new rows rather than un-claiming existing ones. **That endpoint
 * does not exist anywhere in `apps/api/src`** — verified by enumerating every
 * `@Controller`/`@Post`/`@Put` in the tree; no task in
 * `context/spec/003-failure-and-recovery/tasks.md` (slices 1–6, all complete)
 * ever added it, and no test drives it. This is a real gap between the design
 * note and what was built, and it is out of scope for this task to close: a
 * check may only add check files and npm aliases, never production code.
 *
 * What restocking a *drained* pool actually needs — new unclaimed rows in
 * `supplier_keys` — is already how the existing Vitest concurrency suite does
 * it, directly over SQL, un-claiming the exact rows this same check claimed a
 * moment earlier to drain the pool in the first place
 * (`apps/api/test/concurrency/operator-retry-race.test.ts`'s `drainKeyPool` /
 * `restoreDrainedKeyPool`, and the schema's own note that "restoring
 * `claimed_by_request_id = NULL` is a thing only a test may do",
 * `packages/db/src/schema/supplier.ts`). This check reproduces that exact,
 * already-sanctioned technique rather than inventing a new one. If
 * `POST /internal/suppliers/keys` is ever built, this check's `drain`/
 * `restock` pair is the one place to point at the endpoint instead.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ASSERTIONS ARE SCOPED TO THIS ORDER'S OWN REQUEST IDS, NOT GLOBAL
 * ---------------------------------------------------------------------------
 * Draining the pool claims every unclaimed key under a sentinel
 * `claimed_by_request_id`, with no corresponding delivery — deliberately, and
 * exactly like the Vitest suite's own fixture. A global `claimed keys ==
 * deliveries` comparison would therefore fail for the whole of the drained
 * window, for a reason that has nothing to do with the ladder. So this check
 * compares **this order's own** claimed-key count against **this order's
 * own** delivery count, at each of the two settle points ("before and after"
 * in technical-considerations §12's table) — `0 == 0` at `out_of_stock`,
 * `1 == 1` at `delivered` — and separately confirms the whole pool (not just
 * this order's slice of it) returns to its starting size once the drain is
 * reversed.
 */
import { randomUUID } from "node:crypto";

import {
  createOrder,
  deriveIssuanceRequestId,
  describeMissingAdminAffordance,
  isMissingAdminAffordance,
  newEventId,
  postOperatorRetry,
  postPaidWebhook,
  putSupplierBehaviour,
  readAdminToken,
  waitUntilSettled,
} from "./support/recovery-scenario.ts";
import { cleanupTestOrders, openRaceDatabase, PURCHASABLE_SKU } from "./support/race-database.ts";
import { resolveRaceTargets } from "./support/race-targets.ts";

const CHECK_NAME = "race:recover-out-of-stock";

const targets = resolveRaceTargets();
targets.announce(CHECK_NAME);

const failures: string[] = [];

function record(ok: boolean, label: string, detail: string): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

console.log(
  `${CHECK_NAME} — proves: an empty pool settles out_of_stock with exactly two wasted refusals ` +
    "(R12), never a lost order; restocking plus an operator retry reuses the identical claim, " +
    "lock and ladder the automatic path takes (no admin-only path into issuance); the retry " +
    "mints a THIRD attempt row rather than reusing a settled one (R7); and stock accounting " +
    "holds at each settle point — technical-considerations §12, §2.3, §11 R7/R12.",
);

/** Unique per run, so two runs of this check in a row (or one interrupted run followed by a fresh one) can never collide on the same sentinel prefix. */
const DRAIN_SENTINEL = `race_recover_oos_${randomUUID()}`;

const adminToken = readAdminToken();
if (adminToken === undefined) {
  console.log(
    `  SKIP  ${CHECK_NAME} needs ADMIN_TOKEN to call the retry endpoint and this process has ` +
      "none. `pnpm race` sets it from the local .env for the instances it spawns and for " +
      "itself; a deployed target must be given the same value out of band.",
  );
  process.exitCode = 3;
} else {
  let orderId: string | undefined;
  const db = openRaceDatabase("recover-out-of-stock");

  if (db === undefined) {
    // Every assertion this check makes needs the database — draining and
    // restocking the pool are themselves direct-SQL operations, and the
    // scoped stock-accounting assertions are the whole point. There is no
    // honest HTTP-only half to fall back to, unlike `webhooks.ts` or
    // `before-order.ts`.
    console.log(
      `  SKIP  ${CHECK_NAME} needs DATABASE_URL — draining and restocking the supplier_keys ` +
        "pool, and every assertion this check makes, go through the database directly.",
    );
    process.exitCode = 3;
  } else {
    try {
      const resetA = await putSupplierBehaviour(targets.at(0), adminToken, "a");
      if (isMissingAdminAffordance(resetA)) {
        console.log(`  SKIP  ${CHECK_NAME} — ${describeMissingAdminAffordance(resetA)}`);
        process.exitCode = 3;
      } else {
        record(resetA.ok, "provider a reset to the seeded baseline before this run", `status=${String(resetA.status)}`);
        const resetB = await putSupplierBehaviour(targets.at(1), adminToken, "b");
        record(resetB.ok, "provider b reset to the seeded baseline before this run", `status=${String(resetB.status)}`);

        // ---------------------------------------------------------------
        // DRAIN. Direct SQL, deliberately — see this file's header. Every
        // currently-unclaimed key is claimed under this run's own sentinel,
        // so `restock` below can find and reverse exactly these rows and
        // nothing another concurrent writer touched (moot under `pnpm race`,
        // which runs checks one at a time, but cheap to make true anyway).
        // ---------------------------------------------------------------
        const poolBefore = await db.pool.query<{ n: number }>(
          `select count(*)::int as n from supplier_keys where claimed_by_request_id is null`,
        );
        const poolSize = poolBefore.rows[0]?.n ?? 0;
        record(poolSize > 0, "precondition: the pool holds at least one unclaimed key before draining it", `${String(poolSize)} unclaimed`);

        const drained = await db.pool.query(
          `update supplier_keys
              set claimed_by_request_id = $1 || '_' || id::text, claimed_at = now()
            where claimed_by_request_id is null`,
          [DRAIN_SENTINEL],
        );
        const drainedCount = drained.rowCount ?? 0;
        record(drainedCount === poolSize, "the whole unclaimed pool was drained under this run's own sentinel", `drained ${String(drainedCount)} of ${String(poolSize)}`);

        const poolAfterDrain = await db.pool.query<{ n: number }>(
          `select count(*)::int as n from supplier_keys where claimed_by_request_id is null`,
        );
        record((poolAfterDrain.rows[0]?.n ?? -1) === 0, "the pool reads empty before paying", `${String(poolAfterDrain.rows[0]?.n)} unclaimed`);

        // ---------------------------------------------------------------
        // Pay into the empty pool. Both suppliers refuse; the order settles
        // out_of_stock; the ladder does this inside one invocation.
        // ---------------------------------------------------------------
        const order = await createOrder(targets.at(2), PURCHASABLE_SKU);
        orderId = order.id;
        console.log(`  order ${order.id} created against a drained pool on one instance; paying it on another`);

        const eventId = newEventId(order.id, "recoveroos");
        const webhookResult = await postPaidWebhook(targets.at(3), eventId, order.id);
        record(webhookResult.ok, "the paid webhook answers 2xx", `status=${String(webhookResult.status)}`);
        record(
          webhookResult.outcome === "stored",
          'the paid webhook is acknowledged as first sight ("stored")',
          `outcome=${String(webhookResult.outcome)}`,
        );

        const settledEmpty = await waitUntilSettled(targets.at(0), order.id);
        record(settledEmpty.status === "out_of_stock", "the order settles out_of_stock against the drained pool", `status=${settledEmpty.status}`);

        const requestIdA1 = deriveIssuanceRequestId(order.id, "a", 1);
        const requestIdB2 = deriveIssuanceRequestId(order.id, "b", 2);
        const requestIdA3 = deriveIssuanceRequestId(order.id, "a", 3);

        const attemptsEmpty = await db.pool.query<{
          request_id: string;
          provider: string;
          attempt: number;
          status: string;
          last_error: string | null;
        }>(`select request_id, provider, attempt, status, last_error from issuance_attempts where order_id = $1 order by attempt asc`, [
          order.id,
        ]);
        record(attemptsEmpty.rowCount === 2, "exactly two attempt rows against the drained pool (a/1, b/2 — R12's one wasted fall-through)", `found ${String(attemptsEmpty.rowCount)} row(s)`);

        const a1 = attemptsEmpty.rows.find((row) => row.request_id === requestIdA1);
        record(
          a1?.status === "failed" && a1.last_error === "out_of_stock",
          "a/1 reads failed with last_error out_of_stock",
          `${JSON.stringify(a1)}`,
        );
        const b2 = attemptsEmpty.rows.find((row) => row.request_id === requestIdB2);
        record(
          b2?.status === "failed" && b2.last_error === "out_of_stock",
          "b/2 reads failed with last_error out_of_stock — the wasted fall-through R12 predicts, not a second bug",
          `${JSON.stringify(b2)}`,
        );

        const deliveriesEmpty = await db.pool.query<{ n: number }>(`select count(*)::int as n from deliveries where order_id = $1`, [
          order.id,
        ]);
        record((deliveriesEmpty.rows[0]?.n ?? -1) === 0, "zero deliveries for the order while out of stock", `${String(deliveriesEmpty.rows[0]?.n)} row(s)`);

        const claimedForOrderEmpty = await db.pool.query<{ n: number }>(
          `select count(*)::int as n from supplier_keys where claimed_by_request_id = any($1::text[])`,
          [[requestIdA1, requestIdB2]],
        );
        record(
          (claimedForOrderEmpty.rows[0]?.n ?? -1) === 0,
          "stock accounting holds at the FIRST settle point — this order's claimed keys (0) == this order's deliveries (0); a refusal claims nothing",
          `claimed=${String(claimedForOrderEmpty.rows[0]?.n)}, deliveries=0`,
        );

        const requestsForOrderEmpty = await db.pool.query<{ n: number }>(
          `select count(*)::int as n from supplier_requests where request_id = any($1::text[])`,
          [[requestIdA1, requestIdB2]],
        );
        record(
          (requestsForOrderEmpty.rows[0]?.n ?? -1) === 0,
          "no supplier_requests rows for either refusal — an out_of_stock answer writes no ledger entry",
          `${String(requestsForOrderEmpty.rows[0]?.n)} row(s)`,
        );

        // ---------------------------------------------------------------
        // RESTOCK. Reverse exactly the rows this run's own drain claimed —
        // see this file's header for why this is direct SQL rather than the
        // documented-but-unbuilt HTTP endpoint.
        // ---------------------------------------------------------------
        await db.pool.query(`update supplier_keys set claimed_by_request_id = null, claimed_at = null where claimed_by_request_id like $1`, [
          `${DRAIN_SENTINEL}_%`,
        ]);
        const poolAfterRestock = await db.pool.query<{ n: number }>(
          `select count(*)::int as n from supplier_keys where claimed_by_request_id is null`,
        );
        record((poolAfterRestock.rows[0]?.n ?? -1) === poolSize, "the pool is restocked to its full starting size", `${String(poolAfterRestock.rows[0]?.n)} of ${String(poolSize)}`);

        // ---------------------------------------------------------------
        // RETRY. The operator's endpoint — the identical claim, lock and
        // ladder the automatic path uses.
        // ---------------------------------------------------------------
        const retryResult = await postOperatorRetry(targets.at(1), adminToken, order.id);
        record(retryResult.status === 200, "POST .../retry answers 200", `status=${String(retryResult.status)}, body=${retryResult.text}`);
        record(
          retryResult.body?.["outcome"] === "delivered" && retryResult.body?.["delivered"] === true,
          "the retry report says delivered: true",
          JSON.stringify(retryResult.body),
        );

        const settledDelivered = await waitUntilSettled(targets.at(2), order.id);
        record(settledDelivered.status === "delivered", "the order settles delivered after the retry", `status=${settledDelivered.status}`);

        const attemptsAfterRetry = await db.pool.query<{
          request_id: string;
          provider: string;
          attempt: number;
          status: string;
        }>(`select request_id, provider, attempt, status from issuance_attempts where order_id = $1 order by attempt asc`, [order.id]);
        record(
          attemptsAfterRetry.rowCount === 3,
          "exactly THREE attempt rows after the retry (a/1, b/2, a/3) — the retry minted a new one rather than reusing a/1 (R7)",
          `found ${String(attemptsAfterRetry.rowCount)} row(s)`,
        );

        const a3 = attemptsAfterRetry.rows.find((row) => row.request_id === requestIdA3);
        record(
          a3?.status === "ok" && a3.provider === "a" && a3.attempt === 3,
          "a/3 reads ok, provider a, attempt 3 — never a reused a/1 or b/2",
          `${JSON.stringify(a3)}`,
        );

        const deliveriesAfterRetry = await db.pool.query<{ n: number }>(
          `select count(*)::int as n from deliveries where order_id = $1`,
          [order.id],
        );
        record((deliveriesAfterRetry.rows[0]?.n ?? -1) === 1, "exactly one deliveries row for the order after the retry", `${String(deliveriesAfterRetry.rows[0]?.n)} row(s)`);

        const claimedForOrderAfterRetry = await db.pool.query<{ n: number }>(
          `select count(*)::int as n from supplier_keys where claimed_by_request_id = any($1::text[])`,
          [[requestIdA1, requestIdB2, requestIdA3]],
        );
        record(
          (claimedForOrderAfterRetry.rows[0]?.n ?? -1) === 1,
          "stock accounting holds at the SECOND settle point — this order's claimed keys (1, all under a/3) == this order's deliveries (1)",
          `claimed=${String(claimedForOrderAfterRetry.rows[0]?.n)}, deliveries=${String(deliveriesAfterRetry.rows[0]?.n)}`,
        );

        const requestsA3 = await db.pool.query<{ n: number; provider: string }>(
          `select count(*)::int as n, min(provider) as provider from supplier_requests where request_id = $1`,
          [requestIdA3],
        );
        record(
          (requestsA3.rows[0]?.n ?? -1) === 1 && requestsA3.rows[0]?.provider === "a",
          "exactly one supplier_requests row for a/3, against provider a",
          `${JSON.stringify(requestsA3.rows[0])}`,
        );

        // A second retry on an already-delivered order must refuse — zero
        // rows from every guarded UPDATE, not a fourth attempt.
        const secondRetry = await postOperatorRetry(targets.at(3), adminToken, order.id);
        record(
          secondRetry.status === 409,
          "a further retry on the now-delivered order answers 409 (not stuck) rather than doing anything",
          `status=${String(secondRetry.status)}`,
        );
        const attemptsAfterSecondRetry = await db.pool.query<{ n: number }>(
          `select count(*)::int as n from issuance_attempts where order_id = $1`,
          [order.id],
        );
        record(
          (attemptsAfterSecondRetry.rows[0]?.n ?? -1) === 3,
          "still exactly three attempt rows — the refused retry changed nothing",
          `${String(attemptsAfterSecondRetry.rows[0]?.n)} row(s)`,
        );
      }
    } finally {
      // Belt and braces: reverse this run's own drain sentinel even if
      // something above threw before the deliberate restock step ran, so a
      // failed run still leaves the pool at full size for the next one.
      await db.pool.query(`update supplier_keys set claimed_by_request_id = null, claimed_at = null where claimed_by_request_id like $1`, [
        `${DRAIN_SENTINEL}_%`,
      ]);
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
