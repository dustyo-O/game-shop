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
 * HOW THE POOL IS EMPTIED AND REFILLED — TWO DEMO AFFORDANCES ON THE
 * SUPPLIER'S SIDE, AND ALWAYS THOSE
 * ---------------------------------------------------------------------------
 * `POST /internal/suppliers/keys/drain` `{ token }` → `{ token, claimed }`
 * and `POST /internal/suppliers/keys/restock` `{ token }` → `{ released }`
 * (`apps/api/src/suppliers/supplier-key-pool.controller.ts`, spec 006
 * technical-considerations §2.4). They sit beside the behaviour route, in
 * its module, behind its guard, because `supplier_keys` is the supplier's
 * inventory and no shop module may touch it: the shop learns the pool is
 * empty by being told `out_of_stock` across HTTP, never by looking. `drain`
 * claims every unclaimed key under `drain_<token>_<id>` in one statement;
 * `restock` releases exactly the rows carrying that token's sentinel and
 * can never touch a real `req_…` claim (R15 — the `LIKE 'drain\_…'` with
 * its literal-underscore escape, quoted in the service).
 *
 * Until Phase 6 this file drained and restocked over direct SQL, copying the
 * Vitest suite's fixture, because no such route existed. It exists now, and
 * this check uses it **with or without a database of its own**, rather than
 * SQL locally and HTTP only when `DATABASE_URL` is absent. The reason is the
 * README's RED table: a path exercised only against the live shop is a path
 * no local RED run ever sees. If drain, restock or the sentinel's shape
 * broke, a check that fell back to SQL locally would keep passing here and
 * fail only in front of the reviewer, with nothing in the tree to point at.
 * One path, exercised by every run, is the only shape under which "this
 * check passed locally" says anything about the deployed run.
 *
 * The token is this run's own — `race-recover-oos-<uuid>`, hyphens and never
 * underscores (the route's `^[A-Za-z0-9-]{1,64}$`: `_` is a `LIKE` wildcard
 * inside the restock pattern and is refused, not escaped) — so two runs in a
 * row, or one interrupted run followed by a fresh one, can never collide on
 * a sentinel prefix, and the `finally` below can always put back exactly
 * what this run took. It restocks by token whenever the drain answered
 * `200`, on success and on failure alike, so a half-run never leaves the
 * shop empty; a second restock with the same token releases `0`, which the
 * route says is never an error.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE DATABASE STILL ADDS, AND WHAT SKIPS WITHOUT IT
 * ---------------------------------------------------------------------------
 * The whole spine is now HTTP: drain answers `claimed > 0` (a `0` is the
 * pool already empty — a FAIL with that reason, never a silent pass), the
 * order settles `out_of_stock` and later `delivered` as `GET /api/orders/:id`
 * reports it, the restock answers `released === claimed`, the retry answers
 * `delivered: true`, a second retry answers `409`. Against a deployed shop
 * with no `DATABASE_URL`, every one of those is a real PASS or FAIL.
 *
 * What `GET /api/orders/:id` cannot show is *how* the order got there, and
 * that is what the ladder's rules are about: exactly two attempt rows at the
 * first settle point (a/1, b/2 — R12's one wasted fall-through), each
 * `failed` with `last_error = out_of_stock`, zero deliveries and zero keys
 * claimed for this order, no `supplier_requests` row for either refusal;
 * then, after the retry, exactly THREE attempt rows (a/3 minted, never a/1
 * reused — R7), `a/3` `ok`, one delivery, one key claimed under `a/3`, one
 * `supplier_requests` row for it, and still three rows after the refused
 * second retry. Those, plus the whole-pool reads that pair `claimed` and
 * `released` with the count the tables actually show, need the same
 * database the target uses. Without `DATABASE_URL` each is reported as
 * `SKIP <name> — needs DATABASE_URL`, one line per assertion, and never
 * counted as a pass (`support/race-database.ts`'s rule).
 *
 * ---------------------------------------------------------------------------
 * WHY THE ASSERTIONS ARE SCOPED TO THIS ORDER'S OWN REQUEST IDS, NOT GLOBAL
 * ---------------------------------------------------------------------------
 * Draining the pool claims every unclaimed key under a sentinel, with no
 * corresponding delivery — deliberately. A global `claimed keys ==
 * deliveries` comparison would therefore fail for the whole of the drained
 * window, for a reason that has nothing to do with the ladder. So this check
 * compares **this order's own** claimed-key count against **this order's
 * own** delivery count, at each of the two settle points ("before and after"
 * in technical-considerations §12's table) — `0 == 0` at `out_of_stock`,
 * `1 == 1` at `delivered` — and separately confirms the whole pool (not just
 * this order's slice of it) returns to its starting size once the drain is
 * reversed.
 *
 * ---------------------------------------------------------------------------
 * WITHOUT A DATABASE THE ORDER STAYS ON THE TARGET
 * ---------------------------------------------------------------------------
 * `cleanupTestOrders` is the harness's, over SQL, and runs only when a
 * database is reachable. Otherwise this check says so in one INFO line and
 * leaves the order where it is — `pnpm demo:reset` (or the runner's
 * `RACE_DEMO_RESET=1`) is the deployed shop's cleanup, and a check that
 * called the whole-shop reset for its own one order would sweep a leaking
 * application's residue into "removed" and call it tidy.
 */
import { randomUUID } from "node:crypto";

import {
  createOrder,
  deriveIssuanceRequestId,
  describeMissingAdminAffordance,
  isMissingAdminAffordance,
  newEventId,
  postDemoDrainKeys,
  postDemoRestock,
  postOperatorRetry,
  postPaidWebhook,
  putSupplierBehaviour,
  readAdminToken,
  waitUntilSettled,
} from "./support/recovery-scenario.ts";
import { cleanupTestOrders, openRaceDatabase, PURCHASABLE_SKU, type RaceDatabaseClient } from "./support/race-database.ts";
import { resolveRaceTargets } from "./support/race-targets.ts";

const CHECK_NAME = "race:recover-out-of-stock";

const targets = resolveRaceTargets();
targets.announce(CHECK_NAME);

const failures: string[] = [];

function record(ok: boolean, label: string, detail: string): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

/**
 * One database-side assertion: a label and the read that decides it. Kept as
 * data rather than inline `if (db !== undefined)` blocks so that the SKIP
 * printed without a database carries **the same label** the PASS/FAIL would
 * — the name is written once, and the transcript without `DATABASE_URL`
 * lists exactly the assertions the one with it would have made.
 */
interface DatabaseAssertion {
  readonly label: string;
  readonly read: (db: RaceDatabaseClient) => Promise<{ readonly ok: boolean; readonly detail: string }>;
}

async function assertViaDatabase(db: RaceDatabaseClient | undefined, assertions: readonly DatabaseAssertion[]): Promise<void> {
  for (const assertion of assertions) {
    if (db === undefined) {
      console.log(`  SKIP  ${assertion.label} — needs DATABASE_URL`);
      continue;
    }
    const { ok, detail } = await assertion.read(db);
    record(ok, assertion.label, detail);
  }
}

async function countUnclaimedKeys(db: RaceDatabaseClient): Promise<number> {
  const { rows } = await db.pool.query<{ n: number }>(`select count(*)::int as n from supplier_keys where claimed_by_request_id is null`);
  return rows[0]?.n ?? -1;
}

async function countRows(db: RaceDatabaseClient, sqlText: string, params: readonly unknown[]): Promise<number> {
  const { rows } = await db.pool.query<{ n: number }>(sqlText, [...params]);
  return rows[0]?.n ?? -1;
}

interface AttemptRow {
  readonly request_id: string;
  readonly provider: string;
  readonly attempt: number;
  readonly status: string;
  readonly last_error: string | null;
}

async function readAttempts(db: RaceDatabaseClient, orderId: string): Promise<readonly AttemptRow[]> {
  const { rows } = await db.pool.query<AttemptRow>(
    `select request_id, provider, attempt, status, last_error from issuance_attempts where order_id = $1 order by attempt asc`,
    [orderId],
  );
  return rows;
}

function readNumber(body: Record<string, unknown> | undefined, field: string): number | undefined {
  const value = body?.[field];
  return typeof value === "number" ? value : undefined;
}

console.log(
  `${CHECK_NAME} — proves: an empty pool settles out_of_stock with exactly two wasted refusals ` +
    "(R12), never a lost order; restocking plus an operator retry reuses the identical claim, " +
    "lock and ladder the automatic path takes (no admin-only path into issuance); the retry " +
    "mints a THIRD attempt row rather than reusing a settled one (R7); and stock accounting " +
    "holds at each settle point — technical-considerations §12, §2.3, §11 R7/R12. The pool is " +
    "emptied and refilled through POST /internal/suppliers/keys/{drain,restock}, always.",
);

/**
 * This run's token for the drain and its restock. Hyphens only — the route's
 * token shape refuses `_` (a `LIKE` wildcard inside the restock pattern) —
 * and unique per run, so a sentinel prefix can never be shared with another
 * run's.
 */
const RUN_TOKEN = `race-recover-oos-${randomUUID()}`;

const adminToken = readAdminToken();
if (adminToken === undefined) {
  console.log(
    `  SKIP  ${CHECK_NAME} needs ADMIN_TOKEN to drain and restock the pool and to call the retry ` +
      "endpoint, and this process has none. `pnpm race` sets it from the local .env for the " +
      "instances it spawns and for itself; a deployed target must be given the same value out of band.",
  );
  process.exitCode = 3;
} else {
  let orderId: string | undefined;
  /** Set the moment `drain` answers `200`; the `finally` restocks by it, on success and failure alike. */
  let drainedToken: string | undefined;
  const db = openRaceDatabase("recover-out-of-stock");

  if (db === undefined) {
    console.log(
      `  INFO  no DATABASE_URL — the HTTP spine below (drain, out_of_stock, restock, retry, delivered) is ` +
        "asserted for real; each database-side assertion is reported as SKIP by name and never counted as a pass.",
    );
  }

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
      // DRAIN — through the supplier's own route, from one instance; the
      // purchase that meets the empty pool lands on another. The sentinel
      // lives in Postgres, which is the only reason that works.
      // ---------------------------------------------------------------
      const unclaimedBefore = db === undefined ? undefined : await countUnclaimedKeys(db);

      const drain = await postDemoDrainKeys(targets.at(0), adminToken, RUN_TOKEN);
      if (isMissingAdminAffordance(drain)) {
        console.log(`  SKIP  ${CHECK_NAME} — ${describeMissingAdminAffordance(drain)}`);
        process.exitCode = 3;
      } else {
        if (drain.status === 200) drainedToken = RUN_TOKEN;
        record(drain.status === 200, "POST /internal/suppliers/keys/drain { token } answers 200", `status=${String(drain.status)}, body=${drain.text}`);
        record(drain.body?.["token"] === RUN_TOKEN, "the drain echoes this run's own token", `token=${String(drain.body?.["token"])}`);
        const claimed = readNumber(drain.body, "claimed") ?? -1;
        record(
          claimed > 0,
          "the drain claimed at least one key — the pool was not already empty when this run started",
          claimed === 0
            ? "claimed=0: the pool was already empty, so this run cannot show that draining is what empties it (a stale drain from an interrupted run? `POST …/restock {}` sweeps every sentinel)"
            : `claimed=${String(claimed)}`,
        );

        await assertViaDatabase(db, [
          {
            label: "the drain took the whole unclaimed pool — claimed equals the unclaimed count read before it",
            read: async () => ({ ok: unclaimedBefore === claimed, detail: `unclaimed before=${String(unclaimedBefore)}, claimed=${String(claimed)}` }),
          },
          {
            label: "the pool reads empty before paying",
            read: async (client) => {
              const n = await countUnclaimedKeys(client);
              return { ok: n === 0, detail: `${String(n)} unclaimed` };
            },
          },
        ]);

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

        await assertViaDatabase(db, [
          {
            label: "exactly two attempt rows against the drained pool (a/1, b/2 — R12's one wasted fall-through)",
            read: async (client) => {
              const attempts = await readAttempts(client, order.id);
              return { ok: attempts.length === 2, detail: `found ${String(attempts.length)} row(s)` };
            },
          },
          {
            label: "a/1 reads failed with last_error out_of_stock",
            read: async (client) => {
              const a1 = (await readAttempts(client, order.id)).find((row) => row.request_id === requestIdA1);
              return { ok: a1?.status === "failed" && a1.last_error === "out_of_stock", detail: JSON.stringify(a1) };
            },
          },
          {
            label: "b/2 reads failed with last_error out_of_stock — the wasted fall-through R12 predicts, not a second bug",
            read: async (client) => {
              const b2 = (await readAttempts(client, order.id)).find((row) => row.request_id === requestIdB2);
              return { ok: b2?.status === "failed" && b2.last_error === "out_of_stock", detail: JSON.stringify(b2) };
            },
          },
          {
            label: "zero deliveries for the order while out of stock",
            read: async (client) => {
              const n = await countRows(client, `select count(*)::int as n from deliveries where order_id = $1`, [order.id]);
              return { ok: n === 0, detail: `${String(n)} row(s)` };
            },
          },
          {
            label:
              "stock accounting holds at the FIRST settle point — this order's claimed keys (0) == this order's deliveries (0); a refusal claims nothing",
            read: async (client) => {
              const n = await countRows(client, `select count(*)::int as n from supplier_keys where claimed_by_request_id = any($1::text[])`, [
                [requestIdA1, requestIdB2],
              ]);
              return { ok: n === 0, detail: `claimed=${String(n)}, deliveries=0` };
            },
          },
          {
            label: "no supplier_requests rows for either refusal — an out_of_stock answer writes no ledger entry",
            read: async (client) => {
              const n = await countRows(client, `select count(*)::int as n from supplier_requests where request_id = any($1::text[])`, [
                [requestIdA1, requestIdB2],
              ]);
              return { ok: n === 0, detail: `${String(n)} row(s)` };
            },
          },
        ]);

        // ---------------------------------------------------------------
        // RESTOCK — the same route family, by this run's token, from a
        // third instance. Exactly what the drain claimed comes back; a real
        // claim never can (R15).
        // ---------------------------------------------------------------
        const restock = await postDemoRestock(targets.at(1), adminToken, RUN_TOKEN);
        record(restock.status === 200, "POST /internal/suppliers/keys/restock { token } answers 200", `status=${String(restock.status)}, body=${restock.text}`);
        const released = readNumber(restock.body, "released") ?? -1;
        record(
          released === claimed,
          "the restock released exactly the keys this run's drain claimed (released == claimed)",
          `released=${String(released)}, claimed=${String(claimed)}`,
        );

        await assertViaDatabase(db, [
          {
            label: "the pool is restocked to its full starting size",
            read: async (client) => {
              const n = await countUnclaimedKeys(client);
              return { ok: n === unclaimedBefore, detail: `${String(n)} of ${String(unclaimedBefore)}` };
            },
          },
        ]);

        // ---------------------------------------------------------------
        // RETRY. The operator's endpoint — the identical claim, lock and
        // ladder the automatic path uses.
        // ---------------------------------------------------------------
        const retryResult = await postOperatorRetry(targets.at(2), adminToken, order.id);
        record(retryResult.status === 200, "POST .../retry answers 200", `status=${String(retryResult.status)}, body=${retryResult.text}`);
        record(
          retryResult.body?.["outcome"] === "delivered" && retryResult.body?.["delivered"] === true,
          "the retry report says delivered: true",
          JSON.stringify(retryResult.body),
        );

        const settledDelivered = await waitUntilSettled(targets.at(3), order.id);
        record(settledDelivered.status === "delivered", "the order settles delivered after the retry", `status=${settledDelivered.status}`);

        await assertViaDatabase(db, [
          {
            label: "exactly THREE attempt rows after the retry (a/1, b/2, a/3) — the retry minted a new one rather than reusing a/1 (R7)",
            read: async (client) => {
              const attempts = await readAttempts(client, order.id);
              return { ok: attempts.length === 3, detail: `found ${String(attempts.length)} row(s)` };
            },
          },
          {
            label: "a/3 reads ok, provider a, attempt 3 — never a reused a/1 or b/2",
            read: async (client) => {
              const a3 = (await readAttempts(client, order.id)).find((row) => row.request_id === requestIdA3);
              return { ok: a3?.status === "ok" && a3.provider === "a" && a3.attempt === 3, detail: JSON.stringify(a3) };
            },
          },
          {
            label: "exactly one deliveries row for the order after the retry",
            read: async (client) => {
              const n = await countRows(client, `select count(*)::int as n from deliveries where order_id = $1`, [order.id]);
              return { ok: n === 1, detail: `${String(n)} row(s)` };
            },
          },
          {
            label: "stock accounting holds at the SECOND settle point — this order's claimed keys (1, all under a/3) == this order's deliveries (1)",
            read: async (client) => {
              const claimedForOrder = await countRows(
                client,
                `select count(*)::int as n from supplier_keys where claimed_by_request_id = any($1::text[])`,
                [[requestIdA1, requestIdB2, requestIdA3]],
              );
              const deliveries = await countRows(client, `select count(*)::int as n from deliveries where order_id = $1`, [order.id]);
              return { ok: claimedForOrder === 1 && deliveries === 1, detail: `claimed=${String(claimedForOrder)}, deliveries=${String(deliveries)}` };
            },
          },
          {
            label: "exactly one supplier_requests row for a/3, against provider a",
            read: async (client) => {
              const { rows } = await client.pool.query<{ n: number; provider: string | null }>(
                `select count(*)::int as n, min(provider) as provider from supplier_requests where request_id = $1`,
                [requestIdA3],
              );
              return { ok: rows[0]?.n === 1 && rows[0].provider === "a", detail: JSON.stringify(rows[0]) };
            },
          },
        ]);

        // A second retry on an already-delivered order must refuse — zero
        // rows from every guarded UPDATE, not a fourth attempt.
        const secondRetry = await postOperatorRetry(targets.at(3), adminToken, order.id);
        record(
          secondRetry.status === 409,
          "a further retry on the now-delivered order answers 409 (not stuck) rather than doing anything",
          `status=${String(secondRetry.status)}`,
        );

        await assertViaDatabase(db, [
          {
            label: "still exactly three attempt rows — the refused retry changed nothing",
            read: async (client) => {
              const n = await countRows(client, `select count(*)::int as n from issuance_attempts where order_id = $1`, [order.id]);
              return { ok: n === 3, detail: `${String(n)} row(s)` };
            },
          },
        ]);
      }
    }
  } finally {
    // Belt and braces, over the same route: put back whatever this run's
    // drain took, whether or not the deliberate restock above ran. A second
    // restock with the same token releases 0 — never an error — and the
    // count is printed so a reader can see the pool was left whole.
    if (drainedToken !== undefined) {
      const sweep = await postDemoRestock(targets.at(0), adminToken, drainedToken);
      console.log(
        `  INFO  finally: POST /internal/suppliers/keys/restock { token } — status=${String(sweep.status)}, released=${String(
          readNumber(sweep.body, "released"),
        )} (0 when the deliberate restock already ran)`,
      );
      if (sweep.status !== 200) failures.push(`finally: restock by token answered ${String(sweep.status)}: ${sweep.text}`);
    }

    if (db !== undefined) {
      await db.pool.query(
        `update supplier_behaviour
           set failure_rate = 0, hang_rate = 0, hang_ms = 0, fail_next = 0, hang_next = 0,
               hang_before_claim = false, updated_at = now()`,
      );
      if (orderId !== undefined) await cleanupTestOrders(db, [orderId]);
      await db.close();
    } else if (orderId !== undefined) {
      console.log(
        `  INFO  order ${orderId} stays on the target — no DATABASE_URL, so the harness's cleanup cannot run; ` +
          "`pnpm demo:reset` (or the runner's RACE_DEMO_RESET=1) is the deployed shop's cleanup.",
      );
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
