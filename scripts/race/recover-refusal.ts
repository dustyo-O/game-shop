#!/usr/bin/env node
// @layer: script
// @spec: 003-failure-and-recovery
/**
 * `pnpm race recover-refusal` — functional spec §2.7's first named check:
 * *"a supplier that refuses"* (technical-considerations §12, §2.1's own
 * scenario driven for real rather than read about).
 *
 * ---------------------------------------------------------------------------
 * THE MECHANISM THIS PROVES
 * ---------------------------------------------------------------------------
 * Supplier A is made to refuse its very next call, on demand, through its own
 * control surface (`PUT /internal/suppliers/a/behaviour`,
 * `apps/api/src/suppliers/supplier-behaviour.controller.ts`) — **without
 * changing the shop itself**, which is functional spec §2.7's fourth
 * criterion in as many words. A single "paid" webhook then walks the ladder:
 * `askFirst` reaches A, which answers `422 supplier_rejected` having claimed
 * no key; the ladder's `fallThrough` rung reaches B with a **new** request id
 * (`req_{order}_b_2`, not a retry of A's); B is untouched and issues normally.
 * One call is a refusal, the other a success, and the shopper still gets
 * exactly one key.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DATABASE ASSERTIONS MATTER MORE THAN THE HTTP ONES HERE
 * ---------------------------------------------------------------------------
 * `deliveries.order_id` UNIQUE (I3) keeps the shopper to one key even when a
 * retry rule is broken (technical-considerations §11 R2) — so "the shopper
 * got one key" is not evidence the ladder behaved correctly. What can actually
 * fail is stock accounting: `count(*) FROM supplier_keys WHERE
 * claimed_by_request_id IS NOT NULL` against `count(*) FROM deliveries`. This
 * check reads that pair **before** it starts and **after** the order settles,
 * asserting the equality holds at both times and that each moved by exactly
 * one — which is true regardless of whatever else the database happens to
 * hold, rather than assuming a pristine baseline of zero and zero.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE `fail_next` ONE-SHOT, AND NEVER `failure_rate`
 * ---------------------------------------------------------------------------
 * §2.7's fifth criterion is "run the checks twice in a row... the second run
 * behaves the same as the first". A `failure_rate` is a coin toss; two runs
 * of a coin toss are not the same run twice, they are two different bets, and
 * the intermittent red that eventually follows reads as a correctness defect
 * in the shop rather than what it is (technical-considerations §11 R8). The
 * one-shot `fail_next` is spent by an atomic conditional UPDATE
 * (`WHERE fail_next > 0`), so "refuse exactly the next call" is a fact about
 * one specific call and every run of this check asks for the identical thing.
 *
 * ---------------------------------------------------------------------------
 * ROUND-ROBIN ACROSS INSTANCES, DELIBERATELY
 * ---------------------------------------------------------------------------
 * `supplier_behaviour` lives in Postgres, not in a process
 * (`apps/api/src/suppliers/supplier-behaviour.service.ts`, A6), specifically so
 * that arming it from one `apps/api` instance is visible to every other one.
 * This check spends every HTTP call on a **different** `targets.at(i)` —
 * resetting, arming, creating the order, paying it and reading it back all
 * land on different instances under `pnpm race` — which is what actually
 * exercises that claim rather than assuming it.
 */
import { cleanupTestOrders, openRaceDatabase, PURCHASABLE_SKU } from "./support/race-database.ts";
import {
  behaviourBody,
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
import { resolveRaceTargets } from "./support/race-targets.ts";

const CHECK_NAME = "race:recover-refusal";

const targets = resolveRaceTargets();
targets.announce(CHECK_NAME);

const failures: string[] = [];

function record(ok: boolean, label: string, detail: string): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

console.log(
  `${CHECK_NAME} — proves: a definite refusal from supplier A falls through to B with a new ` +
    "request id (the ladder's fallThrough rung), the shopper still gets exactly one key, and " +
    "stock accounting (claimed keys == deliveries) holds throughout — technical-considerations " +
    "§12, functional spec §2.1 and §2.7.",
);

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
  const db = openRaceDatabase("recover-refusal");

  try {
    // -----------------------------------------------------------------------
    // Step 0 — reset both providers to the seeded baseline before arming
    // anything. Defensive: `pnpm race` runs checks one at a time and every
    // check restores the baseline in its own `finally`, but a check that
    // assumed that rather than enforcing it would fail confusingly the one
    // time a prior run was interrupted (`README.md`'s "Reset both behaviour
    // rows to zero", generalised to "before" as well as "after").
    // -----------------------------------------------------------------------
    const resetA = await putSupplierBehaviour(targets.at(0), adminToken, "a");
    if (isMissingAdminAffordance(resetA)) {
      console.log(`  SKIP  ${CHECK_NAME} — ${describeMissingAdminAffordance(resetA)}`);
      process.exitCode = 3;
    } else {
      record(resetA.ok, "provider a reset to the seeded baseline before arming", `status=${String(resetA.status)}`);
      const resetB = await putSupplierBehaviour(targets.at(1), adminToken, "b");
      record(resetB.ok, "provider b reset to the seeded baseline before arming", `status=${String(resetB.status)}`);

      let unclaimedBefore: number | undefined;
      let stockBefore: { claimed: number; deliveries: number } | undefined;
      if (db !== undefined) {
        const { rows } = await db.pool.query<{ n: number }>(
          `select count(*)::int as n from supplier_keys where claimed_by_request_id is null`,
        );
        unclaimedBefore = rows[0]?.n;
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
      // Step 1 — arm A's ONE-SHOT refusal. `fail_next: 1` and every other field
      // explicit at its baseline (`behaviourBody`'s whole reason to exist).
      // -----------------------------------------------------------------------
      const armed = await putSupplierBehaviour(targets.at(2), adminToken, "a", { failNext: 1 });
      record(armed.ok, "arming A's one-shot refusal (fail_next: 1) answers 200", `status=${String(armed.status)}`);
      record(
        armed.body?.["fail_next"] === 1 && armed.body?.["hang_next"] === 0,
        "the stored row echoes fail_next: 1 with every other field at baseline",
        JSON.stringify(armed.body),
      );

      // -------------------------------------------------------------------
      // Step 2 — one order, one "paid" webhook. The ladder does the rest
      // inside this one continuation (§1.4, "one invocation walks the whole
      // ladder to a resting state").
      // -------------------------------------------------------------------
      const order = await createOrder(targets.at(3), PURCHASABLE_SKU);
      orderId = order.id;
      console.log(`  order ${order.id} created on a fresh instance; paying it on another`);

      const eventId = newEventId(order.id, "recoverrefusal");
      const webhookResult = await postPaidWebhook(targets.at(0), eventId, order.id);
      record(webhookResult.ok, "the paid webhook answers 2xx", `status=${String(webhookResult.status)}`);
      record(
        webhookResult.outcome === "stored",
        'the paid webhook is acknowledged as first sight ("stored")',
        `outcome=${String(webhookResult.outcome)}`,
      );

      const settled = await waitUntilSettled(targets.at(1), order.id);
      record(settled.status === "delivered", "the order settles delivered despite A's refusal", `status=${settled.status}`);

      const requestIdA1 = deriveIssuanceRequestId(order.id, "a", 1);
      const requestIdB2 = deriveIssuanceRequestId(order.id, "b", 2);

      if (db === undefined) {
        console.log("  SKIP  every database assertion below — needs DATABASE_URL");
      } else {
        const attempts = await db.pool.query<{
          request_id: string;
          provider: string;
          attempt: number;
          status: string;
          last_error: string | null;
        }>(`select request_id, provider, attempt, status, last_error from issuance_attempts where order_id = $1 order by attempt asc`, [
          order.id,
        ]);
        record(attempts.rowCount === 2, "exactly two attempt rows for the order", `found ${String(attempts.rowCount)} row(s)`);

        const attemptA1 = attempts.rows.find((row) => row.request_id === requestIdA1);
        record(
          attemptA1?.status === "failed" && attemptA1.last_error === "supplier_rejected",
          "a/1 reads failed with last_error supplier_rejected — a definite refusal, never confused with unknown",
          `${JSON.stringify(attemptA1)}`,
        );

        const attemptB2 = attempts.rows.find((row) => row.request_id === requestIdB2);
        record(
          attemptB2?.status === "ok" && attemptB2.attempt === 2,
          "b/2 reads ok — the fall-through's own new request id, not a re-probe of a/1",
          `${JSON.stringify(attemptB2)}`,
        );

        const deliveredRows = await db.pool.query<{ code: string }>(`select code from deliveries where order_id = $1`, [order.id]);
        record(deliveredRows.rowCount === 1, "exactly one deliveries row for the order", `found ${String(deliveredRows.rowCount)} row(s)`);

        const requestsA1 = await db.pool.query<{ n: number }>(`select count(*)::int as n from supplier_requests where request_id = $1`, [
          requestIdA1,
        ]);
        record(
          (requestsA1.rows[0]?.n ?? -1) === 0,
          "no supplier_requests row for a/1 — a refusal claims no key and writes no ledger entry",
          `${String(requestsA1.rows[0]?.n)} row(s)`,
        );

        const requestsB2 = await db.pool.query<{ n: number; provider: string }>(
          `select count(*)::int as n, min(provider) as provider from supplier_requests where request_id = $1`,
          [requestIdB2],
        );
        record(
          (requestsB2.rows[0]?.n ?? -1) === 1 && requestsB2.rows[0]?.provider === "b",
          "exactly one supplier_requests row for b/2, against provider b",
          `${JSON.stringify(requestsB2.rows[0])}`,
        );

        const claimedForB2 = await db.pool.query<{ n: number }>(
          `select count(*)::int as n from supplier_keys where claimed_by_request_id = $1`,
          [requestIdB2],
        );
        record(
          (claimedForB2.rows[0]?.n ?? -1) === 1,
          "exactly one supplier_keys row claimed by b/2's request id",
          `${String(claimedForB2.rows[0]?.n)} row(s)`,
        );

        const unclaimedAfterRows = await db.pool.query<{ n: number }>(
          `select count(*)::int as n from supplier_keys where claimed_by_request_id is null`,
        );
        const unclaimedAfter = unclaimedAfterRows.rows[0]?.n;
        record(
          unclaimedBefore !== undefined && unclaimedAfter !== undefined && unclaimedBefore - unclaimedAfter === 1,
          "the unclaimed supplier_keys pool moved by exactly one, despite two supplier calls",
          `${String(unclaimedBefore)} -> ${String(unclaimedAfter)}`,
        );

        const stockAfterRows = await db.pool.query<{ claimed: number; deliveries: number }>(
          `select
             (select count(*) from supplier_keys where claimed_by_request_id is not null)::int as claimed,
             (select count(*) from deliveries)::int as deliveries`,
        );
        const stockAfter = { claimed: stockAfterRows.rows[0]?.claimed ?? -1, deliveries: stockAfterRows.rows[0]?.deliveries ?? -1 };
        record(
          stockAfter.claimed === stockAfter.deliveries,
          "stock accounting holds after this run (claimed keys == deliveries, R2)",
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
    // Belt and braces beyond the HTTP resets above, over direct SQL — the same
    // posture `apps/api/test/concurrency/operator-retry-race.test.ts`'s
    // `afterAll` takes, and for the same reason: this must succeed even if the
    // admin surface itself is what broke mid-check.
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
