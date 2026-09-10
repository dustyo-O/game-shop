#!/usr/bin/env node
// @layer: script
// @spec: 002-single-issuance-under-races
/**
 * `pnpm race create-order` — functional spec §2.1 and §2.6's first named
 * situation: many simultaneous Buy attempts that share one purchase intent.
 *
 * ---------------------------------------------------------------------------
 * THE MECHANISM THIS PROVES
 * ---------------------------------------------------------------------------
 * `orders.client_request_id` UNIQUE, plus `INSERT ... ON CONFLICT
 * (client_request_id) DO NOTHING`, then a follow-up read of the winner on the
 * zero-row path (`architecture.md` §3.1 I1, `apps/api/src/orders/orders.service.ts`
 * `OrdersService.createOrder`). Nothing in that code asks "have I seen this key
 * before?" — that would be check-then-act, and the window between the read and
 * the write is exactly the double-click this mechanism exists to survive. The
 * unique index is the one place every concurrent attempt meets, so it decides
 * the winner and the application code only reads the verdict.
 *
 * The header carrying the shopper's intent is `Idempotency-Key`
 * (`apps/api/src/orders/orders.controller.ts`), stored verbatim as
 * `client_request_id`. `201` means "this call created it"; `200` means "this
 * call found it" — both bodies are the same five fields, so a client (or this
 * script) reads `id` off either without branching first.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEEDS SEPARATE PROCESSES TO MEAN ANYTHING
 * ---------------------------------------------------------------------------
 * Same argument as every other check in this directory (`./README.md`,
 * `architecture.md` §7): `packages/db/src/client.ts` pins the pool to `max: 1`
 * per instance, and a broken claim can pass a single-instance run purely by
 * having nowhere to interleave. `targets.announce()` below prints the warning
 * when only one instance is configured; this check still runs, because a
 * single URL is the correct shape against a deployed target where the platform
 * supplies the separate instances.
 *
 * ---------------------------------------------------------------------------
 * TWO SCENARIOS, ONE FILE
 * ---------------------------------------------------------------------------
 * 1. N concurrent Buy attempts carrying the *same* key → one order. This is
 *    the assigned scenario and the bulk of what is asserted below.
 * 2. A *fresh* key still creates a *new* order. Functional spec §2.1's fifth
 *    criterion — "a shopper who wants another item gets a separate second
 *    order" — is the failure mode a mechanism that over-merges would produce
 *    (e.g. keying on SKU instead of on the header), and it costs nothing extra
 *    to check here since the harness, the order and the cleanup are already in
 *    place. Left out, a check that only ever proves "things converge" could
 *    pass against code that collapses every purchase of one SKU into a single
 *    order regardless of intent.
 */
import { randomUUID } from "node:crypto";

import { PURCHASABLE_SKU, cleanupTestOrders, openRaceDatabase } from "./support/race-database.ts";
import { resolveRaceTargets } from "./support/race-targets.ts";

const targets = resolveRaceTargets();
targets.announce("race:create-order");

const failures: string[] = [];

function record(ok: boolean, label: string, detail: string): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

/**
 * How many simultaneous Buy attempts share one `Idempotency-Key`. Twenty
 * matches the scale `apps/api/test/concurrency/key-claim-race.test.ts` uses
 * for the same class of claim — large enough that four processes racing on
 * one unique-index insert is a genuine contest, small enough that the whole
 * check runs in well under a second.
 */
const CONCURRENT_ATTEMPTS = 20;

interface OrderAttemptResult {
  readonly ok: boolean;
  readonly status: number;
  readonly id: string | undefined;
  readonly error: string | undefined;
}

/** One `POST /api/orders`, never throwing — a network failure is a result, not an exception, so 20 of these can run under one `Promise.all`. */
async function postCreateOrder(
  baseUrl: string,
  sku: string,
  idempotencyKey: string,
): Promise<OrderAttemptResult> {
  try {
    const response = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ sku }),
    });
    const text = await response.text();
    let id: string | undefined;
    try {
      const body = JSON.parse(text) as { id?: unknown };
      id = typeof body.id === "string" ? body.id : undefined;
    } catch {
      id = undefined;
    }
    return { ok: response.ok, status: response.status, id, error: response.ok ? undefined : text };
  } catch (error) {
    return { ok: false, status: 0, id: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

console.log(
  `race:create-order — proves: I1, orders.client_request_id UNIQUE + INSERT ... ON CONFLICT DO NOTHING ` +
    `(architecture.md §3.1). Invariant: ${String(CONCURRENT_ATTEMPTS)} concurrent Buy attempts carrying one ` +
    "Idempotency-Key produce ONE order, not one per click.",
);

// ---------------------------------------------------------------------------
// Scenario 1 — the assigned scenario: one key, many simultaneous attempts.
// ---------------------------------------------------------------------------
const sharedKey = `race-create-order-${randomUUID()}`;

const sameKeyResults = await Promise.all(
  Array.from({ length: CONCURRENT_ATTEMPTS }, (_, i) => postCreateOrder(targets.at(i), PURCHASABLE_SKU, sharedKey)),
);

const allOk = sameKeyResults.every((result) => result.ok);
record(
  allOk,
  `all ${String(CONCURRENT_ATTEMPTS)} concurrent Buy attempts answered 2xx`,
  allOk
    ? "every response 2xx"
    : sameKeyResults
        .filter((result) => !result.ok)
        .map((result) => `${String(result.status)}${result.error === undefined ? "" : ` ${result.error}`}`)
        .join("; "),
);

const distinctIds = new Set(
  sameKeyResults.map((result) => result.id).filter((id): id is string => id !== undefined),
);
record(
  distinctIds.size === 1,
  `all ${String(CONCURRENT_ATTEMPTS)} responses name the same order id`,
  distinctIds.size === 0
    ? "no response returned an id at all"
    : `${String(distinctIds.size)} distinct id(s) seen: ${[...distinctIds].join(", ")}`,
);

const wonOrderId = distinctIds.size === 1 ? [...distinctIds][0] : undefined;

// Informational, not a pass/fail assertion in its own right: documents the
// 201-vs-200 split (technical-considerations §2.1) that every response above
// was already required to be 2xx regardless of which side of it landed.
const createdCount = sameKeyResults.filter((result) => result.status === 201).length;
const foundCount = sameKeyResults.filter((result) => result.status === 200).length;
console.log(
  `  INFO  response codes — 201 (this call created it): ${String(createdCount)}, ` +
    `200 (this call found it): ${String(foundCount)}, of ${String(CONCURRENT_ATTEMPTS)}`,
);

const orderIds: string[] = wonOrderId === undefined ? [] : [wonOrderId];
const db = openRaceDatabase("create-order");

try {
  if (db === undefined) {
    console.log("  SKIP  exactly one orders row for that client_request_id — needs DATABASE_URL");
    console.log(
      "        Without a database route this run cannot confirm the database agrees with the responses — " +
        "see the split in scripts/race/README.md, \"Which assertions need database access\".",
    );
  } else {
    const { rows } = await db.pool.query<{ id: string }>(
      `select id from orders where client_request_id = $1`,
      [sharedKey],
    );
    record(rows.length === 1, "exactly one orders row for that client_request_id", `found ${String(rows.length)} row(s)`);

    const dbOrderId = rows[0]?.id;
    record(
      wonOrderId !== undefined && dbOrderId === wonOrderId,
      "the order id every response agreed on is the row the database actually holds",
      `responses said ${String(wonOrderId)}, database holds ${String(dbOrderId)}`,
    );
  }

  // -------------------------------------------------------------------------
  // Scenario 2 — the negative complement: a fresh key is a new order.
  // -------------------------------------------------------------------------
  const freshKey = `race-create-order-${randomUUID()}`;
  const fresh = await postCreateOrder(targets.at(0), PURCHASABLE_SKU, freshKey);
  record(
    fresh.ok && fresh.status === 201,
    "a fresh Idempotency-Key still creates a NEW order (201, not a merge into the shared one)",
    `status=${String(fresh.status)}${fresh.error === undefined ? "" : ` ${fresh.error}`}`,
  );
  record(
    fresh.id !== undefined && fresh.id !== wonOrderId,
    "the fresh-key order is a different id from the shared-key order",
    `fresh=${String(fresh.id)}, shared=${String(wonOrderId)}`,
  );
  if (fresh.id !== undefined) orderIds.push(fresh.id);
} finally {
  // cleanupTestOrders is what makes a second run of this check work with no
  // manual tidying — functional spec §2.6's last criterion. Neither scenario
  // above pays for anything, so this only ever deletes `orders` rows; no
  // supplier_keys claim to restore.
  if (db !== undefined) {
    await cleanupTestOrders(db, orderIds);
    await db.close();
  }
}

if (failures.length > 0) {
  console.error(`race:create-order FAILED (${String(failures.length)}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log("race:create-order passed.");
}
