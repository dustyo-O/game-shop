#!/usr/bin/env node
// @layer: script
// @spec: 002-single-issuance-under-races
/**
 * `pnpm race same-event` — functional spec §2.2's first criterion: "a
 * shopper's payment has been reported once and their key delivered, when the
 * payment service reports that same payment again, then the order is
 * unchanged and the shopper still holds exactly one key."
 *
 * ---------------------------------------------------------------------------
 * THE MECHANISM THIS PROVES, AND HOW IT DIFFERS FROM `./webhooks.ts`
 * ---------------------------------------------------------------------------
 * This is deliberately the *opposite* shape of `./webhooks.ts`: that check
 * fires fifty **distinct** `event_id`s at one order — many different reports
 * of one payment, defending I4 (only one worker may advance the order). This
 * check fires **one** `event_id`, delivered many times concurrently — one
 * report of one payment, redelivered — defending I2:
 * `payment_events.event_id` PRIMARY KEY plus `INSERT ... ON CONFLICT
 * (event_id) DO NOTHING` (`architecture.md` §3.1,
 * `apps/api/src/payments/payment-events.service.ts` `recordEvent`).
 *
 * A real provider redelivers the *same* `event_id` when it never sees our
 * `200` — a dropped response, a slow network — which is a different failure
 * shape from "the shopper's client double-submitted" (`./create-order.ts`) or
 * "the provider is telling us about the payment several times because that is
 * how it guarantees delivery" (`./webhooks.ts`'s fifty distinct events). This
 * check is what stands in for that specific shape: exactly one of the
 * concurrent copies wins the insert ("first sight"); every other one reads
 * `ON CONFLICT ... DO NOTHING`'s zero rows and is acknowledged as a duplicate
 * — `payment-webhook.controller.ts`: "A redelivery processes nothing, on
 * purpose... the *drain* is what picks it up, not a second copy of the same
 * webhook." So only ever one continuation actually applies this event; the
 * concurrency here is entirely about whether the *storage* step is race-safe,
 * not about a fan-in on the order's claim.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEEDS SEPARATE PROCESSES TO MEAN ANYTHING
 * ---------------------------------------------------------------------------
 * Same argument as `./README.md` and `architecture.md` §7 make for every check
 * here: a single instance's pool of `max: 1` gives a broken implementation
 * nowhere to interleave, so proving I2 under load needs genuinely separate
 * connections. `targets.announce()` prints the single-instance warning; the
 * check still runs, since one URL is correct against a deployed target.
 */
import { randomUUID } from "node:crypto";

import { PURCHASABLE_SKU, cleanupTestOrders, deriveTestRequestId, openRaceDatabase } from "./support/race-database.ts";
import { describeFetchError } from "./support/fetch-failure.ts";
import { collectInstanceIds, describeInstanceIds, readInstanceId, resolveRaceTargets } from "./support/race-targets.ts";

const targets = resolveRaceTargets();
targets.announce("race:same-event");

const failures: string[] = [];

function record(ok: boolean, label: string, detail: string): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((doneWaiting) => {
    setTimeout(doneWaiting, ms);
  });
}

/**
 * How many concurrent copies of the *same* `event_id` are delivered. Twenty —
 * the same scale `apps/api/test/concurrency/key-claim-race.test.ts` uses for
 * a comparable claim — is large enough that four processes racing on one
 * `INSERT ... ON CONFLICT (event_id)` is a genuine contest, deliberately a
 * different number from `./webhooks.ts`'s fifty so a reader scanning the
 * summary line can tell the two checks apart at a glance.
 */
const REDELIVERY_COUNT = 20;

const SETTLE_POLL_INTERVAL_MS = 25;
const SETTLE_TIMEOUT_MS = 15_000;

interface CreatedOrder {
  readonly id: string;
}

async function createOrder(baseUrl: string, sku: string): Promise<CreatedOrder> {
  const response = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sku }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${baseUrl}/api/orders -> ${String(response.status)}: ${text}`);
  const body = JSON.parse(text) as { id?: unknown };
  if (typeof body.id !== "string") throw new Error(`POST ${baseUrl}/api/orders returned no order id: ${text}`);
  return { id: body.id };
}

interface WebhookResult {
  readonly ok: boolean;
  readonly status: number;
  readonly outcome: string | undefined;
  readonly error: string | undefined;
  /** The answering process's `x-instance-id` — `collectInstanceIds` counts the distinct ones after the batch. */
  readonly instanceId: string | undefined;
}

/** Same payload contract as `./webhooks.ts` — `parsePaymentWebhookPayload` in `payment-webhook.controller.ts`. */
async function postPaidWebhook(baseUrl: string, eventId: string, orderId: string): Promise<WebhookResult> {
  try {
    const response = await fetch(`${baseUrl}/api/webhooks/payment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: eventId,
        order_id: orderId,
        status: "paid",
        amount: 5,
        currency: "RUB",
        created_at: new Date().toISOString(),
      }),
    });
    const text = await response.text();
    let outcome: string | undefined;
    try {
      const body = JSON.parse(text) as { outcome?: unknown };
      outcome = typeof body.outcome === "string" ? body.outcome : undefined;
    } catch {
      outcome = undefined;
    }
    return {
      ok: response.ok,
      status: response.status,
      outcome,
      error: response.ok ? undefined : text,
      instanceId: readInstanceId(response),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      outcome: undefined,
      error: describeFetchError(error),
      instanceId: undefined,
    };
  }
}

interface OrderView {
  readonly status: string;
}

async function fetchOrderView(baseUrl: string, orderId: string): Promise<OrderView> {
  const response = await fetch(`${baseUrl}/api/orders/${orderId}`);
  if (!response.ok) throw new Error(`GET ${baseUrl}/api/orders/${orderId} -> ${String(response.status)}`);
  return (await response.json()) as OrderView;
}

/** Same shape as `apps/api/test/concurrency/key-claim-race.test.ts`'s `waitUntilSettled` — the work here is asynchronous, so this check must poll rather than assert immediately. */
async function waitUntilSettled(baseUrl: string, orderId: string): Promise<OrderView> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  for (;;) {
    const view = await fetchOrderView(baseUrl, orderId);
    if (view.status === "delivered" || view.status === "out_of_stock" || view.status === "payment_failed") {
      return view;
    }
    if (Date.now() > deadline) {
      throw new Error(`order ${orderId} did not settle within ${String(SETTLE_TIMEOUT_MS)}ms (status=${view.status})`);
    }
    await delay(SETTLE_POLL_INTERVAL_MS);
  }
}

console.log(
  `race:same-event — proves: I2, payment_events.event_id PRIMARY KEY + INSERT ... ON CONFLICT (event_id) DO ` +
    `NOTHING (architecture.md §3.1). Distinct from race:webhooks: that check fires many DIFFERENT reports of ` +
    `one payment; this one fires ONE report delivered ${String(REDELIVERY_COUNT)} times concurrently — the ` +
    "shape a provider's at-least-once retry produces when it never hears our 200 back. Invariant: redelivery " +
    "is a no-op, never a second issuance.",
);

const order = await createOrder(targets.at(0), PURCHASABLE_SKU);
const eventId = `evt_race_same_event_${order.id}_${randomUUID()}`;
console.log(`  order ${order.id} created; delivering event ${eventId} ${String(REDELIVERY_COUNT)} times concurrently`);

const orderIds = [order.id];
const db = openRaceDatabase("same-event");

try {
  let unclaimedBefore: number | undefined;
  if (db !== undefined) {
    const { rows } = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from supplier_keys where claimed_by_request_id is null`,
    );
    unclaimedBefore = rows[0]?.n;
  }

  const results = await Promise.all(
    Array.from({ length: REDELIVERY_COUNT }, (_, i) => postPaidWebhook(targets.at(i), eventId, order.id)),
  );

  // Who answered — the HTTP witness of "separate processes" for THIS batch
  // (spec 006 §2.5). Informational: the harness decides on it.
  console.log(`  ${describeInstanceIds(collectInstanceIds(results))}`);

  const allOk = results.every((result) => result.ok);
  record(
    allOk,
    `all ${String(REDELIVERY_COUNT)} concurrent redeliveries answered 2xx`,
    allOk
      ? "every response 2xx"
      : results
          .filter((result) => !result.ok)
          .map((result) => `${String(result.status)}${result.error === undefined ? "" : ` ${result.error}`}`)
          .join("; "),
  );

  const storedCount = results.filter((result) => result.outcome === "stored").length;
  const duplicateCount = results.filter((result) => result.outcome === "duplicate").length;
  record(
    storedCount === 1 && duplicateCount === REDELIVERY_COUNT - 1,
    "exactly one of the concurrent copies was stored as first sight; every other one was acknowledged as a duplicate",
    `stored=${String(storedCount)}, duplicate=${String(duplicateCount)}, ` +
      `unrecognised=${String(REDELIVERY_COUNT - storedCount - duplicateCount)}`,
  );

  const settled = await waitUntilSettled(targets.at(0), order.id);
  record(settled.status === "delivered", "the order settles delivered", `status=${settled.status}`);

  if (db === undefined) {
    console.log("  SKIP  exactly one payment_events row for this event_id — needs DATABASE_URL");
    console.log("  SKIP  exactly one deliveries row for the order — needs DATABASE_URL");
    console.log("  SKIP  exactly one supplier_keys row claimed — needs DATABASE_URL");
    console.log("  SKIP  unclaimed supplier_keys pool moved by exactly one — needs DATABASE_URL");
    console.log("  SKIP  the order row reads delivered in the database — needs DATABASE_URL");
    console.log(
      "        Without a database route this run cannot confirm storage was race-safe — see the split in " +
        "scripts/race/README.md, \"Which assertions need database access\".",
    );
  } else {
    const eventRows = await db.pool.query<{ event_id: string }>(
      `select event_id from payment_events where event_id = $1`,
      [eventId],
    );
    record(eventRows.rowCount === 1, "exactly one payment_events row exists for this event_id", `found ${String(eventRows.rowCount)} row(s)`);

    const deliveredRows = await db.pool.query<{ order_id: string; code: string }>(
      `select order_id, code from deliveries where order_id = $1`,
      [order.id],
    );
    record(
      deliveredRows.rowCount === 1,
      "exactly one deliveries row for the order — unchanged by the redelivery",
      `found ${String(deliveredRows.rowCount)} row(s)`,
    );

    const requestId = deriveTestRequestId(order.id);
    const claimedKeys = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from supplier_keys where claimed_by_request_id = $1`,
      [requestId],
    );
    record(
      claimedKeys.rows[0]?.n === 1,
      "exactly one supplier_keys row claimed by this order's issuance request",
      `${String(claimedKeys.rows[0]?.n ?? 0)} row(s) — twenty redeliveries must not claim twenty keys`,
    );

    const unclaimedAfterRows = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from supplier_keys where claimed_by_request_id is null`,
    );
    const unclaimedAfter = unclaimedAfterRows.rows[0]?.n;
    record(
      unclaimedBefore !== undefined && unclaimedAfter !== undefined && unclaimedBefore - unclaimedAfter === 1,
      "the unclaimed supplier_keys pool moved by exactly one, not by REDELIVERY_COUNT",
      `${String(unclaimedBefore)} -> ${String(unclaimedAfter)}`,
    );

    const orderRow = await db.pool.query<{ status: string }>(`select status from orders where id = $1`, [order.id]);
    record(
      orderRow.rows[0]?.status === "delivered",
      "the order row reads delivered in the database, not merely in the API's response",
      `status=${String(orderRow.rows[0]?.status)}`,
    );
  }
} finally {
  // cleanupTestOrders is what makes a second run of this check work with no
  // manual tidying (functional spec §2.6's last criterion).
  if (db !== undefined) {
    await cleanupTestOrders(db, orderIds);
    await db.close();
  }
}

if (failures.length > 0) {
  console.error(`race:same-event FAILED (${String(failures.length)}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log("race:same-event passed.");
}
