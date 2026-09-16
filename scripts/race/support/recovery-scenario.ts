// @layer: script
// @spec: 003-failure-and-recovery
/**
 * Shared machinery for the three Phase 3 recovery checks — `../recover-refusal.ts`,
 * `../recover-timeout.ts`, `../recover-out-of-stock.ts` — every one of which stages
 * a single order through a single "paid" webhook and then arms or reads the
 * simulated supplier's own control surface. Factored out because all three need
 * byte-identical copies of it, and three copies is three chances for one of them
 * to arm a supplier subtly differently from the other two.
 *
 * In `support/`, per `../README.md`'s rule: helpers live here and are never
 * scanned as checks themselves.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE EVERY CALLER OF `putSupplierBehaviour` MUST NOT BREAK
 * ---------------------------------------------------------------------------
 * `PUT /internal/suppliers/:provider/behaviour` **replaces the whole row**. An
 * omitted field resets to zero — `supplier-behaviour.controller.ts`'s own words,
 * "an omitted field resets to the seeded zero, so `{}` is the reset button".
 * `{"hang_next": 1}` alone leaves `hang_ms` at `0`, which is a hang of no
 * length at all.
 *
 * `behaviourBody` exists so that mistake cannot be made here: it always returns
 * all six fields, baseline-defaulted, with only the caller's overrides changed.
 * There is no code path in these three checks that sends a partial body.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY AUTOMATED CHECK USES ONLY `fail_next` / `hang_next` AND 0 OR 1
 * ---------------------------------------------------------------------------
 * `failure_rate` and `hang_rate` exist for a reviewer exploring by hand. A
 * fractional rate makes functional spec §2.7's fifth criterion — "the reviewer
 * runs the checks twice in a row... it behaves the same as the first" — untrue
 * by construction (technical-considerations §11 R8): a coin toss cannot be
 * guaranteed to land the same way twice. `behaviourBody` accepts a rate purely
 * because the type is shared with the endpoint's own contract; nothing in
 * `../recover-refusal.ts`, `../recover-timeout.ts` or `../recover-out-of-stock.ts`
 * ever passes one.
 */
import { randomUUID } from "node:crypto";
import { describeFetchError } from "./fetch-failure.ts";

// ---------------------------------------------------------------------------
// Order lifecycle — the same shape `../before-order.ts` and `../webhooks.ts`
// use, reproduced here rather than imported from either: those two files are
// checks, not support modules, and a check must stay runnable and readable on
// its own (`../README.md`, "Adding a check").
// ---------------------------------------------------------------------------

export interface CreatedOrder {
  readonly id: string;
}

/** `POST /api/orders` — no `Idempotency-Key`; these checks exercise recovery, not I1. */
export async function createOrder(baseUrl: string, sku: string): Promise<CreatedOrder> {
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

export interface WebhookResult {
  readonly ok: boolean;
  readonly status: number;
  readonly outcome: string | undefined;
  readonly error: string | undefined;
}

/** One `POST /api/webhooks/payment` — payload contract per `payment-webhook.controller.ts`'s `parsePaymentWebhookPayload`. */
export async function postPaidWebhook(baseUrl: string, eventId: string, orderId: string): Promise<WebhookResult> {
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
      const parsed = JSON.parse(text) as { outcome?: unknown };
      outcome = typeof parsed.outcome === "string" ? parsed.outcome : undefined;
    } catch {
      outcome = undefined;
    }
    return { ok: response.ok, status: response.status, outcome, error: response.ok ? undefined : text };
  } catch (error) {
    return { ok: false, status: 0, outcome: undefined, error: describeFetchError(error) };
  }
}

export interface OrderView {
  readonly status: string;
}

export async function fetchOrderView(baseUrl: string, orderId: string): Promise<OrderView> {
  const response = await fetch(`${baseUrl}/api/orders/${orderId}`);
  if (!response.ok) throw new Error(`GET ${baseUrl}/api/orders/${orderId} -> ${String(response.status)}`);
  return (await response.json()) as OrderView;
}

const DEFAULT_SETTLE_TIMEOUT_MS = 15_000;
const SETTLE_POLL_INTERVAL_MS = 25;

/** Same shape as `../webhooks.ts`'s `waitUntilSettled` — a settled order is one of the four resting statuses, never guessed at, always read back. */
export async function waitUntilSettled(
  baseUrl: string,
  orderId: string,
  timeoutMs: number = DEFAULT_SETTLE_TIMEOUT_MS,
): Promise<OrderView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await fetchOrderView(baseUrl, orderId);
    if (
      view.status === "delivered" ||
      view.status === "out_of_stock" ||
      view.status === "delivery_failed" ||
      view.status === "payment_failed"
    ) {
      return view;
    }
    if (Date.now() > deadline) {
      throw new Error(`order ${orderId} did not settle within ${String(timeoutMs)}ms (status=${view.status})`);
    }
    await delay(SETTLE_POLL_INTERVAL_MS);
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((doneWaiting) => {
    setTimeout(doneWaiting, ms);
  });
}

export function newEventId(orderId: string, label: string): string {
  return `evt_race_${label}_${orderId}_${randomUUID()}`;
}

/**
 * `req_{order_id}_{provider}_{attempt}` — transcribed from
 * `apps/api/src/issuance/issuance-request-id.ts`'s `deriveIssuanceRequestId`,
 * not imported, for the reason `apps/api/test/concurrency/support/db.ts`'s own
 * `deriveTestRequestId` gives: a bug that changed the derivation in the
 * application and in a shared helper would go uncaught, and in this case there
 * is a second, purely mechanical reason — `scripts/` has no path into
 * `apps/api/src` at all (only into its `test/concurrency/support`, which
 * `../race-database.ts` already reaches for the database helpers).
 */
export function deriveIssuanceRequestId(orderId: string, provider: string, attempt: number): string {
  return `req_${orderId}_${provider}_${String(attempt)}`;
}

// ---------------------------------------------------------------------------
// The supplier's control surface — `PUT /internal/suppliers/:provider/behaviour`
// and `POST /internal/suppliers/keys/{drain,restock}` — the operator's
// `POST /api/admin/orders/:orderId/retry`, and the demo's
// `POST /api/admin/demo/reset`, all behind the same `ADMIN_TOKEN`.
// ---------------------------------------------------------------------------

/** `undefined` when unset or empty — a check reads this once and either proceeds or SKIPs; see `../README.md`'s "Adding a check", exit code 3. */
export function readAdminToken(): string | undefined {
  const token = process.env["ADMIN_TOKEN"];
  return token === undefined || token === "" ? undefined : token;
}

export interface BehaviourOverrides {
  readonly failureRate?: number;
  readonly hangRate?: number;
  readonly hangMs?: number;
  readonly failNext?: number;
  readonly hangNext?: number;
  readonly hangBeforeClaim?: boolean;
}

/**
 * All six fields, always — the seeded baseline (0 / false) with only the
 * caller's overrides changed. See this file's header: the endpoint replaces
 * the whole row, so a body built any other way is how a check ends up arming
 * `hang_next` with `hang_ms` still at zero.
 */
export function behaviourBody(overrides: BehaviourOverrides = {}): Record<string, number | boolean> {
  return {
    failure_rate: overrides.failureRate ?? 0,
    hang_rate: overrides.hangRate ?? 0,
    hang_ms: overrides.hangMs ?? 0,
    fail_next: overrides.failNext ?? 0,
    hang_next: overrides.hangNext ?? 0,
    hang_before_claim: overrides.hangBeforeClaim ?? false,
  };
}

export interface AdminApiResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: Record<string, unknown> | undefined;
  readonly text: string;
}

async function parseAdminApiResponse(response: Response): Promise<AdminApiResult> {
  const text = await response.text();
  let body: Record<string, unknown> | undefined;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = undefined;
  }
  return { ok: response.ok, status: response.status, body, text };
}

/**
 * `PUT /internal/suppliers/:provider/behaviour`. Never throws on a non-2xx —
 * `401` and `503` are answers a check must be able to read and turn into a
 * SKIP (`../README.md`'s "Adding a check", exit code 3), not a crash.
 */
export async function putSupplierBehaviour(
  baseUrl: string,
  adminToken: string,
  provider: string,
  overrides: BehaviourOverrides = {},
): Promise<AdminApiResult> {
  const response = await fetch(`${baseUrl}/internal/suppliers/${provider}/behaviour`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(behaviourBody(overrides)),
  });
  return parseAdminApiResponse(response);
}

/** `POST /api/admin/orders/:orderId/retry` — no body, per `order-recovery.controller.ts`'s header (R11: no affordance that invites automation). */
export async function postOperatorRetry(baseUrl: string, adminToken: string, orderId: string): Promise<AdminApiResult> {
  const response = await fetch(`${baseUrl}/api/admin/orders/${orderId}/retry`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  return parseAdminApiResponse(response);
}

// ---------------------------------------------------------------------------
// The demo affordances (spec 006, technical-considerations §2.4). Three
// routes, one shape: `POST`, `200`, a count of rows changed, `0` never an
// error, `401`/`503` answers to read rather than crashes — the same
// `AdminApiResult` every other admin call here returns, so a check turns a
// missing affordance into the same SKIP by the same helper.
// ---------------------------------------------------------------------------

/**
 * `POST /internal/suppliers/keys/drain` `{ token? }` → `{ token, claimed }`
 * (`apps/api/src/suppliers/supplier-key-pool.controller.ts`). Claims every
 * unclaimed key under `drain_<token>_<id>` so the next purchase meets an
 * empty pool; `claimed: 0` means the pool was already empty.
 *
 * A caller that names the token must keep to the route's shape —
 * `^[A-Za-z0-9-]{1,64}$`, hyphens and never underscores, because `_` is a
 * `LIKE` wildcard inside the restock pattern and the route refuses it with a
 * `400` rather than escaping it. `race-<check>-<uuid>` is the shape the
 * checks use. Without a token the route mints a UUID and echoes it.
 */
export async function postDemoDrainKeys(baseUrl: string, adminToken: string, token?: string): Promise<AdminApiResult> {
  const response = await fetch(`${baseUrl}/internal/suppliers/keys/drain`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(token === undefined ? {} : { token }),
  });
  return parseAdminApiResponse(response);
}

/**
 * `POST /internal/suppliers/keys/restock` `{ token? }` → `{ released }`.
 * Releases the sentinel claims one drain made (by token) or every drain's
 * (no token); never a real `req_…` claim (R15 — the route's own header).
 * Idempotent: a second restock with the same token releases `0`, which is
 * what lets a check's `finally` restock without first asking whether the
 * deliberate restock already ran.
 */
export async function postDemoRestock(baseUrl: string, adminToken: string, token?: string): Promise<AdminApiResult> {
  const response = await fetch(`${baseUrl}/internal/suppliers/keys/restock`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(token === undefined ? {} : { token }),
  });
  return parseAdminApiResponse(response);
}

/**
 * `POST /api/admin/demo/reset` — no body — → `{ removed, reset, changed, now }`
 * (`apps/api/src/demo/demo-reset.controller.ts`): every order gone, every
 * counter, claim and behaviour knob back to the seed, in one transaction.
 *
 * Not for a check's own cleanup. Locally every check tidies **its own** rows
 * through `cleanupTestOrders` and the harness asserts the baseline after; a
 * reset in their place would sweep a leaking application's residue into
 * `removed` and call it a pass (`scripts/demo-reset.ts`'s header). This is
 * here for the runner's external mode (`RACE_DEMO_RESET=1`) and for the
 * operator between sessions.
 */
export async function postDemoReset(baseUrl: string, adminToken: string): Promise<AdminApiResult> {
  const response = await fetch(`${baseUrl}/api/admin/demo/reset`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  return parseAdminApiResponse(response);
}

/**
 * `true` when `result` is the shape of a target that has correctly refused this
 * check the affordance it needs (`503` unconfigured, `401` a token that does
 * not match) rather than a shop that is broken. The caller's job is to print a
 * SKIP naming which of the two it was and exit `3` — never `1` — per
 * `../README.md`'s "Adding a check" and technical-considerations §11 (the
 * `before-order` precedent for `ALLOW_CLIENT_SUPPLIED_ORDER_ID`).
 */
export function isMissingAdminAffordance(result: AdminApiResult): boolean {
  return result.status === 401 || result.status === 503;
}

export function describeMissingAdminAffordance(result: AdminApiResult): string {
  if (result.status === 503) {
    return (
      "the target answered 503 — ADMIN_TOKEN is not configured there, so the whole admin " +
      "surface (this endpoint included) is disabled. That is the correct default for a " +
      "deployment; `pnpm race` configures it for the instances it spawns."
    );
  }
  return (
    "the target answered 401 — the token this process holds does not match the one the " +
    "target is configured with (or no ADMIN_TOKEN reached this process at all). Set " +
    "ADMIN_TOKEN to the same value the target uses, or run through `pnpm race`, which does " +
    "this for its own instances."
  );
}
