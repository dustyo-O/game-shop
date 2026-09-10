#!/usr/bin/env node
// @layer: script
// @spec: 002-single-issuance-under-races
/**
 * `pnpm race webhooks` — the assignment's headline scenario, at its stated
 * number: functional spec §2.2's second criterion, "the payment service
 * reports one shopper's payment fifty times at the same moment... the shopper
 * has been given exactly one key and exactly one key has left the shop's
 * stock."
 *
 * ---------------------------------------------------------------------------
 * THE MECHANISM THIS PROVES
 * ---------------------------------------------------------------------------
 * Fifty **distinct** reports of one payment — fifty different `event_id`s, all
 * naming the same `order_id`, all `status: "paid"` — which is what a
 * provider's at-least-once delivery produces (`context/spec/002-…/functional-
 * spec.md` §1: "Payment services report the same payment several times on
 * purpose"). Because every `event_id` is new, I2's `payment_events.event_id`
 * PRIMARY KEY does not collapse them — all fifty are genuinely stored and all
 * fifty schedule a continuation (contrast `./same-event.ts`, which is the
 * opposite shape: one `event_id`, delivered many times).
 *
 * What stops fifty issuances is I4 — `SELECT ... FOR UPDATE` on the order row
 * plus the status-guarded `paid → delivering` UPDATE
 * (`architecture.md` §3.1, `apps/api/src/payments/payment-event-processor.service.ts`
 * `claimForIssuance`). Every one of the fifty continuations attempts the claim;
 * Postgres serialises them on the row's write lock; exactly one guarded UPDATE
 * matches, and every other one re-evaluates against `delivering` (or later,
 * `delivered`) and matches nothing — a no-op, not an error, and never a `5xx`
 * (`payment-webhook.controller.ts`'s header: "a duplicate we correctly ignored
 * is a success").
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY RESPONSE MUST BE 2xx — NOT JUST THE DATABASE OUTCOME
 * ---------------------------------------------------------------------------
 * A payment provider retries on `5xx`. Forty-nine "losing" continuations that
 * each correctly do nothing must still have answered their own webhook POST
 * with `200` at storage time — the acknowledgement is `receive → persist →
 * acknowledge → process` (`architecture.md` §4), so it happens **before** any
 * of the fifty continuations even starts racing for the claim. A `5xx` here
 * would be how the shop asks the provider to redeliver a report it already
 * has, which is a correctness failure in its own right and not merely noise.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS POLLS RATHER THAN ASSERTING IMMEDIATELY
 * ---------------------------------------------------------------------------
 * The webhook answers `200` and schedules the work as a continuation
 * (`payment-webhook.controller.ts`: "NO await. THE return below races the
 * work, and wins."). By the time all fifty `fetch` calls below resolve, the
 * winning continuation may not even have started. `waitUntilSettled` is the
 * same poll `apps/api/test/concurrency/key-claim-race.test.ts` and
 * `order-lock-race.test.ts` use for the same reason — see those files.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEEDS SEPARATE PROCESSES TO MEAN ANYTHING
 * ---------------------------------------------------------------------------
 * `./README.md` and `architecture.md` §7: a single instance's pool of `max: 1`
 * serialises every claim transaction before Postgres ever sees a second one in
 * flight, so a broken claim (no lock, no guard) hands out one key per instance
 * regardless. `targets.announce()` prints the warning when only one instance is
 * configured; the check still runs, since a single URL is correct against a
 * deployed target.
 */
import { randomUUID } from "node:crypto";

import { PURCHASABLE_SKU, cleanupTestOrders, deriveTestRequestId, openRaceDatabase } from "./support/race-database.ts";
import { resolveRaceTargets } from "./support/race-targets.ts";

const targets = resolveRaceTargets();
targets.announce("race:webhooks");

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

/** The assignment's stated number — functional spec §2.2, §2.6's second acceptance scenario. */
const EVENT_COUNT = 50;

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
  readonly eventId: string;
  readonly ok: boolean;
  readonly status: number;
  readonly outcome: string | undefined;
  readonly error: string | undefined;
}

/**
 * One `POST /api/webhooks/payment`, never throwing — the payload contract is
 * `apps/api/src/payments/payment-webhook.controller.ts`'s
 * `parsePaymentWebhookPayload`: `event_id`, `order_id`, `status`, `amount`
 * (whole roubles, not kopecks), `currency`.
 */
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
    return { eventId, ok: response.ok, status: response.status, outcome, error: response.ok ? undefined : text };
  } catch (error) {
    return {
      eventId,
      ok: false,
      status: 0,
      outcome: undefined,
      error: error instanceof Error ? error.message : String(error),
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

/** Same shape as `apps/api/test/concurrency/key-claim-race.test.ts`'s `waitUntilSettled` — see that file. */
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
  `race:webhooks — proves: I4, SELECT ... FOR UPDATE on the order row plus the status-guarded paid -> ` +
    `delivering UPDATE (architecture.md §3.1). Invariant: ${String(EVENT_COUNT)} DISTINCT simultaneous reports ` +
    "of one payment still leave exactly one key claimed.",
);

const order = await createOrder(targets.at(0), PURCHASABLE_SKU);
console.log(`  order ${order.id} created; delivering ${String(EVENT_COUNT)} distinct "paid" reports for it at once`);

const orderIds = [order.id];
const db = openRaceDatabase("webhooks");

try {
  let unclaimedBefore: number | undefined;
  if (db !== undefined) {
    const { rows } = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from supplier_keys where claimed_by_request_id is null`,
    );
    unclaimedBefore = rows[0]?.n;
  }

  const eventIds = Array.from(
    { length: EVENT_COUNT },
    (_, i) => `evt_race_webhooks_${order.id}_${String(i)}_${randomUUID()}`,
  );
  // Harness sanity: fifty genuinely distinct event ids were actually minted,
  // so the assertions below are testing fan-in from fifty reports and not an
  // accidental collision in this script's own id generation.
  record(
    new Set(eventIds).size === EVENT_COUNT,
    `${String(EVENT_COUNT)} distinct event_ids minted for this run`,
    `${String(new Set(eventIds).size)} distinct of ${String(EVENT_COUNT)}`,
  );

  const results = await Promise.all(
    eventIds.map((eventId, i) => postPaidWebhook(targets.at(i), eventId, order.id)),
  );

  const allOk = results.every((result) => result.ok);
  record(
    allOk,
    `every one of the ${String(EVENT_COUNT)} webhook responses is 2xx`,
    allOk
      ? "every response 2xx"
      : results
          .filter((result) => !result.ok)
          .map((result) => `${result.eventId}: ${String(result.status)}${result.error === undefined ? "" : ` ${result.error}`}`)
          .join("; "),
  );

  const storedCount = results.filter((result) => result.outcome === "stored").length;
  record(
    storedCount === EVENT_COUNT,
    `all ${String(EVENT_COUNT)} reports were acknowledged as first sight ("stored")`,
    `${String(storedCount)} of ${String(EVENT_COUNT)} — I2 must not treat a distinct event_id as a duplicate`,
  );

  const settled = await waitUntilSettled(targets.at(0), order.id);
  record(settled.status === "delivered", "the order settles delivered", `status=${settled.status}`);

  if (db === undefined) {
    console.log("  SKIP  exactly one deliveries row for the order — needs DATABASE_URL");
    console.log("  SKIP  exactly one supplier_keys row claimed — needs DATABASE_URL");
    console.log("  SKIP  unclaimed supplier_keys pool moved by exactly one — needs DATABASE_URL");
    console.log("  SKIP  the order row reads delivered in the database — needs DATABASE_URL");
    console.log(
      "        Without a database route this run cannot confirm the headline claim — see the split in " +
        "scripts/race/README.md, \"Which assertions need database access\".",
    );
  } else {
    const deliveredRows = await db.pool.query<{ order_id: string; code: string }>(
      `select order_id, code from deliveries where order_id = $1`,
      [order.id],
    );
    record(deliveredRows.rowCount === 1, "exactly one deliveries row for the order", `found ${String(deliveredRows.rowCount)} row(s)`);

    const requestId = deriveTestRequestId(order.id);
    const claimedKeys = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from supplier_keys where claimed_by_request_id = $1`,
      [requestId],
    );
    record(
      claimedKeys.rows[0]?.n === 1,
      "exactly one supplier_keys row claimed by this order's issuance request",
      `${String(claimedKeys.rows[0]?.n ?? 0)} row(s) — fifty reports must not claim fifty keys`,
    );

    const unclaimedAfterRows = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from supplier_keys where claimed_by_request_id is null`,
    );
    const unclaimedAfter = unclaimedAfterRows.rows[0]?.n;
    record(
      unclaimedBefore !== undefined && unclaimedAfter !== undefined && unclaimedBefore - unclaimedAfter === 1,
      "the unclaimed supplier_keys pool moved by exactly one",
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
  // cleanupTestOrders deletes payment_events by order_id regardless of
  // processed_at, so any of the forty-nine losing events still pending
  // (`deferred_order_in_flight` — payment-event-processor.service.ts) is
  // removed along with everything else this run wrote. This is what makes a
  // second run work with no manual tidying (functional spec §2.6).
  if (db !== undefined) {
    await cleanupTestOrders(db, orderIds);
    await db.close();
  }
}

if (failures.length > 0) {
  console.error(`race:webhooks FAILED (${String(failures.length)}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log("race:webhooks passed.");
}
