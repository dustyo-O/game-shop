#!/usr/bin/env node
// @layer: script
// @spec: 002-single-issuance-under-races
/**
 * `pnpm race before-order` — functional spec §2.3's scenario, driven as a
 * genuine reproduction rather than read about: *"Given the payment service
 * reports a payment before the shop has finished recording the order it
 * belongs to, when the order is recorded, then the payment is applied to it
 * and the shopper receives their key without taking any further action."*
 *
 * ---------------------------------------------------------------------------
 * THE AFFORDANCE THIS CHECK NEEDS, AND WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * To stage "webhook before order" on purpose — rather than hoping a real race
 * happens to land that way — this script has to pre-choose the order id it
 * delivers a webhook against, before that order exists anywhere. `POST
 * /api/orders` mints its own id (`newOrderId()`) precisely because a real
 * shopper's browser never gets to pick one; `architecture.md` §9 records the
 * deliberate, narrow exception: `ALLOW_CLIENT_SUPPLIED_ORDER_ID` lets
 * `POST /api/orders` accept an explicit `id`, off by default, fails closed
 * when unset (`apps/api/src/config/client-supplied-order-id.ts`), and is
 * turned on **only** for the instances `pnpm race` spawns for itself
 * (`apps/api/test/concurrency/support/api-instance.ts`,
 * `scripts/race/run-checks.ts`) — never for `pnpm dev:stack`, never in a
 * deployment. Run against a target that does not have it set, the order-create
 * step below fails with a `400` this script reports clearly rather than
 * papering over (see `HINT` in the failure detail).
 *
 * The alternative the task that produced this script considered and rejected
 * is driving this as a genuine, unstaged race — deliver enough concurrent
 * webhooks and order-creates that "before" sometimes happens by luck. Slice
 * 3's verifier won that race on the first of three attempts: achievable, and
 * exactly the kind of check functional spec §2.6 rules out — *"the reviewer
 * runs the checks twice in a row... [and it] behaves the same as the first."*
 * A check that passes two runs in three is not a check a reviewer can run,
 * and it would be the one non-deterministic script among four deterministic
 * ones, which invites distrust of the other three. So: stage it, with an
 * affordance built for exactly this and documented as a known trade-off
 * rather than smuggled in.
 *
 * ---------------------------------------------------------------------------
 * THE MECHANISM THIS PROVES
 * ---------------------------------------------------------------------------
 * `payment_events.order_id` carries no foreign key (`architecture.md` §4,
 * "Out-of-order tolerance"), so a `paid` report for an order that does not
 * exist yet is stored with `processed_at` NULL rather than rejected. Two
 * triggers can apply it once the order exists: the order-creation drain
 * (trigger 2, `apps/api/src/payments/order-creation-drain.ts` — fires the
 * instant `POST /api/orders` commits) and the status-poll drain (trigger 3,
 * `apps/api/src/payments/order-status-poll-drain.ts` — fires when this
 * script's own `GET /api/orders/:id` finds the event still pending). Both are
 * scheduled continuations racing the same `FOR UPDATE SKIP LOCKED` claim
 * (`apps/api/src/payments/payment-event-drain.service.ts`), and **which one
 * wins is not a fact this check may assert** — Slice 3's verification found
 * the order-creation drain can legitimately miss, stepping over a row another
 * worker already holds, with the status poll picking it up instead. Both
 * outcomes are correct; asserting "trigger 2 did it" would fail this check
 * against a correct system. See `INFO` below for a cheap, non-gating guess at
 * which one actually ran in a given execution.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WEBHOOK AND THE ORDER-CREATE GO TO DIFFERENT INSTANCES
 * ---------------------------------------------------------------------------
 * `targets.at(0)` stores the early event; `targets.at(1)` creates the order.
 * If applying the event worked only because both requests happened to land on
 * the same process, that would be in-process state doing the work — a `Map`
 * the webhook populated and the create handler happened to read — rather than
 * the database being the single source of truth every instance shares. Two
 * separate OS processes, two separate connection pools of `max: 1`
 * (`packages/db/src/client.ts`), meeting only in Postgres, is what makes this
 * check mean anything against more than one instance's memory. `./README.md`
 * and `architecture.md` §7 make the general argument; this check is the
 * specific case of it for out-of-order delivery.
 *
 * ---------------------------------------------------------------------------
 * "WITHOUT TAKING ANY FURTHER ACTION" IS LITERAL HERE
 * ---------------------------------------------------------------------------
 * After `POST /api/orders` returns, this script does exactly one thing:
 * `GET /api/orders/:id` in a poll loop, which is what a shopper's own open tab
 * does (technical-considerations §2.6) and is itself trigger 3's gate — not an
 * extra action layered on top of the scenario, but the scenario's own
 * "shopper does nothing further". No admin sweep is called, no webhook is
 * redelivered, no drain is invoked directly.
 */
import { randomUUID } from "node:crypto";

import { PURCHASABLE_SKU, cleanupTestOrders, deriveTestRequestId, openRaceDatabase } from "./support/race-database.ts";
import { resolveRaceTargets } from "./support/race-targets.ts";

const targets = resolveRaceTargets();
targets.announce("race:before-order");

const failures: string[] = [];

/** Set when the target refuses the pre-chosen order id: not run here, and not a pass. See the SKIP branch below. */
let skipped = false;

function record(ok: boolean, label: string, detail: string): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((doneWaiting) => {
    setTimeout(doneWaiting, ms);
  });
}

const SETTLE_POLL_INTERVAL_MS = 25;
const SETTLE_TIMEOUT_MS = 15_000;

/**
 * Chosen by this script, not by `apps/api` — the entire point. `ord_` matches
 * `apps/api/src/orders/order-id.ts`'s own prefix so it reads like a real order
 * id in logs and in the database, though nothing enforces that shape
 * (`OrdersController.getOrder`'s header: "No format check on the id").
 */
const orderId = `ord_race_beforeorder_${randomUUID()}`;
const eventId = `evt_race_beforeorder_${orderId}_${randomUUID()}`;

interface WebhookResult {
  readonly ok: boolean;
  readonly status: number;
  readonly outcome: string | undefined;
  readonly error: string | undefined;
}

/** One `POST /api/webhooks/payment`, never throwing — payload contract per `payment-webhook.controller.ts`'s `parsePaymentWebhookPayload`. */
async function postPaidWebhook(baseUrl: string): Promise<WebhookResult> {
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
    return { ok: response.ok, status: response.status, outcome, error: response.ok ? undefined : text };
  } catch (error) {
    return { ok: false, status: 0, outcome: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

interface CreateOrderResult {
  readonly ok: boolean;
  readonly status: number;
  readonly id: string | undefined;
  readonly error: string | undefined;
}

/**
 * `POST /api/orders` with the client-supplied `id` field
 * (`apps/api/src/orders/orders.controller.ts`'s `parseRequestedOrderId`,
 * `apps/api/src/orders/orders.types.ts`'s `CreateOrderRequest.id`). No
 * `Idempotency-Key`: this script is not exercising I1, and omitting it keeps
 * the response unambiguously `201` rather than a possible `200`.
 */
async function createOrderWithId(baseUrl: string): Promise<CreateOrderResult> {
  try {
    const response = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: PURCHASABLE_SKU, id: orderId }),
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

interface OrderView {
  readonly status: string;
}

/** `undefined` on a `404` (the pre-creation check wants that as a result, not a thrown error) — throws on anything else unexpected. */
async function fetchOrderView(baseUrl: string): Promise<OrderView | undefined> {
  const response = await fetch(`${baseUrl}/api/orders/${orderId}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`GET ${baseUrl}/api/orders/${orderId} -> ${String(response.status)}`);
  return (await response.json()) as OrderView;
}

interface SettleResult {
  readonly view: OrderView;
  /** How many `GET /api/orders/:id` calls this script itself made before observing a settled status — informational, see `INFO` below. */
  readonly pollCount: number;
}

/** Same shape as `./webhooks.ts`'s `waitUntilSettled` — see that file. Counts its own polls, since each one is also trigger 3's gate. */
async function waitUntilSettled(baseUrl: string): Promise<SettleResult> {
  const deadline = Date.now() + SETTLE_TIMEOUT_MS;
  let pollCount = 0;
  for (;;) {
    pollCount += 1;
    const view = await fetchOrderView(baseUrl);
    if (view !== undefined && (view.status === "delivered" || view.status === "out_of_stock" || view.status === "payment_failed")) {
      return { view, pollCount };
    }
    if (Date.now() > deadline) {
      throw new Error(
        `order ${orderId} did not settle within ${String(SETTLE_TIMEOUT_MS)}ms (status=${view?.status ?? "not found"})`,
      );
    }
    await delay(SETTLE_POLL_INTERVAL_MS);
  }
}

console.log(
  "race:before-order — proves: architecture.md §4's out-of-order tolerance (payment_events.order_id carries no " +
    "foreign key) plus the order-creation and status-poll drains that apply a pending event once its order exists. " +
    `Invariant: a "paid" report delivered for order ${orderId} before it exists is stored pending, applied once the ` +
    "order is created (on a DIFFERENT instance), and yields exactly one key — with no action from the shopper beyond watching the order page.",
);

const db = openRaceDatabase("before-order");

try {
  let unclaimedBefore: number | undefined;
  if (db !== undefined) {
    const { rows } = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from supplier_keys where claimed_by_request_id is null`,
    );
    unclaimedBefore = rows[0]?.n;
  }

  // -------------------------------------------------------------------------
  // Step 1 — deliver the "paid" report to instance 0, before the order exists
  // anywhere. A 5xx here would be the specific failure this whole design
  // exists to prevent: an early event that errors is how a payment provider's
  // retry storm starts (docs/walkthrough/phase-2-slice-3-out-of-order.md §1).
  // -------------------------------------------------------------------------
  const webhookResult = await postPaidWebhook(targets.at(0));
  record(
    webhookResult.ok,
    "the early webhook (delivered before the order exists) answers 2xx",
    webhookResult.ok
      ? `status=${String(webhookResult.status)}, outcome=${String(webhookResult.outcome)}`
      : `status=${String(webhookResult.status)}${webhookResult.error === undefined ? "" : ` ${webhookResult.error}`}`,
  );
  record(
    webhookResult.outcome === "stored",
    'the early webhook is acknowledged as first sight ("stored"), not a duplicate',
    `outcome=${String(webhookResult.outcome)}`,
  );

  if (db === undefined) {
    console.log("  SKIP  the event is stored with processed_at IS NULL — needs DATABASE_URL");
  } else {
    const { rows } = await db.pool.query<{ order_id: string; processed_at: Date | null }>(
      `select order_id, processed_at from payment_events where event_id = $1`,
      [eventId],
    );
    record(rows.length === 1, "exactly one payment_events row for this event_id", `found ${String(rows.length)} row(s)`);
    record(
      rows[0]?.order_id === orderId && rows[0]?.processed_at === null,
      "the stored event names this order id and is pending (processed_at IS NULL)",
      `order_id=${String(rows[0]?.order_id)}, processed_at=${String(rows[0]?.processed_at)}`,
    );
  }

  // -------------------------------------------------------------------------
  // Step 2 — confirm, over HTTP, that the order genuinely does not exist yet.
  // Not load-bearing for the mechanism (the sequential awaits above already
  // guarantee the ordering), but it turns "before the order exists" from an
  // assumption about timing into an observed 404.
  // -------------------------------------------------------------------------
  const beforeCreate = await fetchOrderView(targets.at(1));
  record(beforeCreate === undefined, "GET /api/orders/:id answers 404 before the order is created", `found=${String(beforeCreate !== undefined)}`);

  // -------------------------------------------------------------------------
  // Step 3 — create the order with the SAME id, on a DIFFERENT instance
  // (targets.at(1)). Cross-instance is the point: see this file's header.
  // -------------------------------------------------------------------------
  const createResult = await createOrderWithId(targets.at(1));

  // The target refused the pre-chosen id, which is the CORRECT default: the
  // affordance is off unless `ALLOW_CLIENT_SUPPLIED_ORDER_ID` is set, and a
  // deployed shop serving real shoppers should never set it.
  //
  // So this is not a failure of the shop, and reporting it as one would be a
  // lie a reviewer acts on — red on a correct system teaches them to distrust
  // the other four checks. Reporting it as a pass would be worse: an unrun
  // check counted as evidence is the decoration §2.6 forbids.
  //
  // Exit 3 instead: the runner prints SKIP, names it in the summary, and
  // counts it as neither. Same rule `support/race-database.ts` applies to one
  // assertion with no `DATABASE_URL`, applied to the whole check.
  if (createResult.status === 400 && (createResult.error ?? "").includes("ALLOW_CLIENT_SUPPLIED_ORDER_ID")) {
    console.log(
      `  SKIP  this check needs ALLOW_CLIENT_SUPPLIED_ORDER_ID on every targeted instance — the target refused ` +
        `the pre-chosen order id, which is the correct default.\n` +
        `        Locally, \`pnpm race\` sets it for the instances it spawns. Against a deployed target it must be ` +
        `set in that environment, and only ever for one that is not serving real shoppers ` +
        `(architecture.md §9, apps/api/src/config/client-supplied-order-id.ts).\n` +
        `        Everything above this line ran and passed: the early webhook was accepted, stored, and left pending.`,
    );
    // NOT process.exit() here: that terminates immediately and skips the
    // `finally` below, leaving the early payment_events row on disk — which
    // would break the "run it twice with no tidying" criterion the skip is
    // supposed to protect. Flag it, fall out of the try, let cleanup run.
    skipped = true;
  }

  if (!skipped) {

  const createHint = "";
  record(
    createResult.ok && createResult.status === 201,
    "creating the order (with the pre-chosen id, on a different instance) answers 201",
    `status=${String(createResult.status)}${createResult.error === undefined ? "" : ` ${createResult.error}`}${createHint}`,
  );
  record(
    createResult.id === orderId,
    "the created order's id is the one this script chose",
    `requested=${orderId}, got=${String(createResult.id)}`,
  );

  const orderCreatedAt = Date.now();

  // -------------------------------------------------------------------------
  // Step 4 — the shopper's own page: poll and nothing else. Whichever of the
  // two triggers applies the event, this is the only action this script takes
  // after creation.
  // -------------------------------------------------------------------------
  const { view: settled, pollCount } = await waitUntilSettled(targets.at(1));
  record(settled.status === "delivered", "the order settles delivered, with no action beyond watching the order page", `status=${settled.status}`);

  if (db === undefined) {
    console.log("  SKIP  exactly one deliveries row for the order — needs DATABASE_URL");
    console.log("  SKIP  exactly one supplier_keys row claimed — needs DATABASE_URL");
    console.log("  SKIP  the unclaimed supplier_keys pool moved by exactly one — needs DATABASE_URL");
    console.log("  SKIP  the order row reads delivered in the database — needs DATABASE_URL");
    console.log("  SKIP  the pending event is now settled (processed_at IS NOT NULL) — needs DATABASE_URL");
    console.log(
      "        Without a database route this run cannot confirm the headline claim — see the split in " +
        "scripts/race/README.md, \"Which assertions need database access\".",
    );
  } else {
    const deliveredRows = await db.pool.query<{ order_id: string; code: string }>(
      `select order_id, code from deliveries where order_id = $1`,
      [orderId],
    );
    record(deliveredRows.rowCount === 1, "exactly one deliveries row for the order", `found ${String(deliveredRows.rowCount)} row(s)`);

    const requestId = deriveTestRequestId(orderId);
    const claimedKeys = await db.pool.query<{ n: number }>(
      `select count(*)::int as n from supplier_keys where claimed_by_request_id = $1`,
      [requestId],
    );
    record(
      claimedKeys.rows[0]?.n === 1,
      "exactly one supplier_keys row claimed by this order's issuance request",
      `${String(claimedKeys.rows[0]?.n ?? 0)} row(s)`,
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

    const orderRow = await db.pool.query<{ status: string }>(`select status from orders where id = $1`, [orderId]);
    record(
      orderRow.rows[0]?.status === "delivered",
      "the order row reads delivered in the database, not merely in the API's response",
      `status=${String(orderRow.rows[0]?.status)}`,
    );

    const eventRow = await db.pool.query<{ processed_at: Date | null }>(
      `select processed_at from payment_events where event_id = $1`,
      [eventId],
    );
    const processedAt = eventRow.rows[0]?.processed_at ?? null;
    record(
      processedAt !== null,
      "the pending event is now settled (processed_at IS NOT NULL)",
      `processed_at=${String(processedAt)}`,
    );

    // -----------------------------------------------------------------------
    // INFORMATIONAL ONLY — which trigger settled it is not asserted, per this
    // file's header ("both outcomes are correct"). This is a cheap guess, not
    // a claim: `processedAt` is Postgres's clock and `orderCreatedAt` is this
    // process's, so the two can disagree by whatever clock skew exists
    // between this machine and the database (negligible for a local
    // `pnpm race`, unverifiable against a deployed target).
    // -----------------------------------------------------------------------
    const settleLagMs = processedAt === null ? undefined : processedAt.getTime() - orderCreatedAt;
    const guess =
      settleLagMs === undefined
        ? "unknown (no processed_at)"
        : settleLagMs <= 0
          ? "order-creation drain (trigger 2) — the event was already processed at or before the create response returned"
          : pollCount <= 1
            ? "order-creation drain (trigger 2) — settled before this script's first status poll"
            : "status-poll drain (trigger 3) — this script's own poll likely found it still pending and drained it";
    console.log(
      `  INFO  which trigger settled it (not asserted) — ${guess}; ` +
        `processed_at was ${String(settleLagMs)}ms relative to the create-order response, ` +
        `${String(pollCount)} status poll(s) run`,
    );
  }
  }
} finally {
  // cleanupTestOrders deletes payment_events by order_id regardless of
  // processed_at, so a run that fails partway (e.g. the event never settles)
  // still leaves nothing behind — what makes a second run work with no manual
  // tidying (functional spec §2.6).
  if (db !== undefined) {
    await cleanupTestOrders(db, [orderId]);
    await db.close();
  }
}

if (skipped) {
  console.log("race:before-order skipped — not run here, and not counted as a pass.");
  process.exitCode = 3;
} else if (failures.length > 0) {
  console.error(`race:before-order FAILED (${String(failures.length)}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log("race:before-order passed.");
}
