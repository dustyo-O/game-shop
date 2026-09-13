/**
 * The operator's half of `GET /api/admin/orders/undelivered` — the one endpoint
 * the recovery screen reads (spec 003 technical-considerations §8).
 *
 * ---------------------------------------------------------------------------
 * THE TOKEN IS A PARAMETER. THIS FILE NEVER GOES LOOKING FOR ONE.
 * ---------------------------------------------------------------------------
 * `fetchUndeliveredOrders` takes the bearer token and puts it on the wire, and
 * that is the whole of its involvement with it. Where the token is kept, when it
 * is forgotten and what an operator has to type to supply one belong to
 * `features/present-admin-token`, one layer up. The same division `createOrder`
 * has with `Idempotency-Key`, and for a stronger reason: an entity that read a
 * credential out of storage for itself would make every caller of every future
 * admin request inherit that choice silently.
 *
 * ---------------------------------------------------------------------------
 * THE TWO REFUSALS ARE TWO CLASSES, BECAUSE THEY ARE TWO SITUATIONS
 * ---------------------------------------------------------------------------
 * `admin-token.guard.ts` answers exactly three ways, and this file mirrors the
 * two that are not "come in", one-for-one:
 *
 *   | The guard says                        | This file throws              |
 *   | ------------------------------------- | ----------------------------- |
 *   | `401` — no token, or the wrong one     | {@link AdminUnauthorizedError} |
 *   | `503` — `ADMIN_TOKEN` is not configured| {@link AdminSurfaceDisabledError} |
 *
 * They are separate classes rather than one error carrying a status, because
 * the page does opposite things with them and the compiler should be what keeps
 * them apart. A `401` means *the token is wrong* — offer the form again, and
 * throw away the stored value. A `503` means *this deployment has no admin
 * surface at all* — show **no form**, because pasting a better token cannot
 * help and inviting an operator to try teaches them to doubt their own
 * credentials during an incident.
 *
 * ---------------------------------------------------------------------------
 * THE THIRD PARSER IN THIS APP, AND WHY ITS HELPERS STILL LIVE HERE
 * ---------------------------------------------------------------------------
 * `entities/order/api/order-api.ts` predicted this moment: *"a third parser is
 * the moment to lift them into `shared/`; two is not."* The trigger has fired
 * and the decision, made deliberately rather than by omission, is still no —
 * for a reason the prediction could not see from where it stood:
 *
 * The three parsers overlap on precisely two functions, `asRecord` and
 * `readString`, about twelve lines. Everything else here is new — nullable
 * strings, a boolean, a nested array of records with their own field set — and
 * would stay in this file either way. And the twelve shared lines are not
 * actually identical: each throws its **own** error class with its own message
 * prefix, which is what makes a bad payload say `undelivered_order.sku:` rather
 * than `field: expected a string`. A shared version therefore takes an error
 * factory at every call site, so the saving is twelve lines of body in exchange
 * for a parameter threaded through forty. That is a worse file, not a smaller
 * one. The rule to lift is re-armed at the point where two slices need the
 * *same* reader with the *same* error, which is still not the case.
 */
import { Currency, isOrderStatus, minorUnits } from "@game-shop/contracts";

import { getJson, HttpError } from "../../../shared/api/http.js";
import type {
  IssuanceAttemptRecord,
  UndeliveredOrder,
  UndeliveredOrdersReport,
} from "../model/undelivered-order.js";

const undeliveredEndpoint = "/api/admin/orders/undelivered";

const unauthorizedStatus = 401;
const serviceUnavailableStatus = 503;

/** The response did not have the shape `GET /api/admin/orders/undelivered` promises. */
export class UndeliveredOrdersResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UndeliveredOrdersResponseError";
  }
}

/**
 * The guard answered `401`: no bearer token was presented, or the one presented
 * did not match.
 *
 * The guard deliberately does **not** say which of the two it was — the
 * distinction lives in the API's own logs and is withheld from the response, so
 * an unauthenticated caller is not told that the header they guessed at least
 * parsed. This class carries no more than the guard gave.
 */
export class AdminUnauthorizedError extends Error {
  constructor() {
    super("the admin bearer token was missing or wrong");
    this.name = "AdminUnauthorizedError";
  }
}

/**
 * The guard answered `503`: `ADMIN_TOKEN` is not configured on this deployment,
 * so the admin surface is switched off.
 *
 * Not a failure of the caller and not fixable by one. The remedy is a deploy
 * with the variable set, which is why the guard sends no `Retry-After` and why
 * the page shows no form.
 */
export class AdminSurfaceDisabledError extends Error {
  constructor() {
    super("the admin surface is disabled because ADMIN_TOKEN is not configured on this deployment");
    this.name = "AdminSurfaceDisabledError";
  }
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UndeliveredOrdersResponseError(`${context}: expected an object, got ${typeof value}`);
  }

  // Safe after the check above: an object with unknown-valued keys is the
  // weakest true statement about it, and every field below is still narrowed.
  return value as Record<string, unknown>;
}

function readString(row: Record<string, unknown>, context: string, field: string): string {
  const value = row[field];

  if (typeof value !== "string") {
    throw new UndeliveredOrdersResponseError(
      `${context}.${field}: expected a string, got ${typeof value}`,
    );
  }

  return value;
}

/**
 * A field the API is allowed to send as `null`. Absent and `null` are folded
 * together: both mean the shop does not know, and every caller of this renders
 * the same thing for both.
 */
function readNullableString(
  row: Record<string, unknown>,
  context: string,
  field: string,
): string | null {
  const value = row[field];

  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new UndeliveredOrdersResponseError(
      `${context}.${field}: expected a string or null, got ${typeof value}`,
    );
  }

  return value;
}

/**
 * The finiteness check is not ceremony: `JSON.parse` cannot produce `NaN`, but
 * it happily produces `null`, and `minorUnits(null as never)` would sail through
 * to `formatPrice` and render «null ₽» in the amount column.
 */
function readNumber(row: Record<string, unknown>, context: string, field: string): number {
  const value = row[field];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new UndeliveredOrdersResponseError(
      `${context}.${field}: expected a finite number, got ${typeof value}`,
    );
  }

  return value;
}

function readNullableNumber(
  row: Record<string, unknown>,
  context: string,
  field: string,
): number | null {
  const value = row[field];

  if (value === null || value === undefined) {
    return null;
  }

  return readNumber(row, context, field);
}

function readBoolean(row: Record<string, unknown>, context: string, field: string): boolean {
  const value = row[field];

  if (typeof value !== "boolean") {
    throw new UndeliveredOrdersResponseError(
      `${context}.${field}: expected a boolean, got ${typeof value}`,
    );
  }

  return value;
}

function readCurrency(row: Record<string, unknown>, context: string): Currency {
  const value = readString(row, context, "currency");

  if (value !== Currency.Rub) {
    throw new UndeliveredOrdersResponseError(`${context}.currency: unsupported currency "${value}"`);
  }

  return value;
}

/**
 * `isOrderStatus` comes from `@game-shop/contracts`, so the check is against the
 * same seven strings the `orders_status_check` CHECK constraint holds. An eighth
 * status reaching this screen is a shop that has outgrown this bundle, and it is
 * caught here — where it becomes one legible sentence — rather than rendering a
 * row whose status cell is blank and whose retry affordance is decided by a
 * `false` nobody meant.
 */
function readStatus(row: Record<string, unknown>, context: string): UndeliveredOrder["status"] {
  const value = row["status"];

  if (!isOrderStatus(value)) {
    throw new UndeliveredOrdersResponseError(
      `${context}.status: unknown status ${JSON.stringify(value)}`,
    );
  }

  return value;
}

/**
 * One attempt row.
 *
 * **`status` is not narrowed to the three words the ladder writes today**, on
 * purpose — see `../model/undelivered-order.ts`. The column carries no CHECK
 * constraint, so a fourth value is a change the retry policy is allowed to make,
 * and a parser that rejected it would take down the operator's only screen at
 * exactly the moment the policy got more interesting.
 */
function toAttempt(value: unknown, context: string): IssuanceAttemptRecord {
  const row = asRecord(value, context);

  return {
    provider: readString(row, context, "provider"),
    attempt: readNumber(row, context, "attempt"),
    status: readString(row, context, "status"),
    probeCount: readNullableNumber(row, context, "probe_count"),
    lastError: readNullableString(row, context, "last_error"),
  };
}

/**
 * The attempt history, or an empty list.
 *
 * The one place this parser is deliberately lenient about a **missing** field:
 * §8 fixes the order's own field names and says only *"the attempt list"* about
 * this one, so an absent array is read as *no history was carried* rather than
 * as a broken body. A value that is present and is not an array is still
 * refused — leniency about silence, never about a contradiction.
 */
function readAttempts(
  row: Record<string, unknown>,
  context: string,
): readonly IssuanceAttemptRecord[] {
  const value = row["attempts"];

  if (value === null || value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new UndeliveredOrdersResponseError(
      `${context}.attempts: expected an array, got ${typeof value}`,
    );
  }

  return value.map((entry, index) => toAttempt(entry, `${context}.attempts[${String(index)}]`));
}

function toUndeliveredOrder(value: unknown, context: string): UndeliveredOrder {
  const row = asRecord(value, context);

  return {
    orderId: readString(row, context, "order_id"),
    sku: readString(row, context, "sku"),
    productName: readNullableString(row, context, "product_name"),
    amountMinor: minorUnits(readNumber(row, context, "amount_minor")),
    currency: readCurrency(row, context),
    status: readStatus(row, context),
    createdAt: readString(row, context, "created_at"),
    paidAt: readNullableString(row, context, "paid_at"),
    retryable: readBoolean(row, context, "retryable"),
    outstandingRequestId: readNullableString(row, context, "outstanding_request_id"),
    lastError: readNullableString(row, context, "last_error"),
    attempts: readAttempts(row, context),
  };
}

function toReport(value: unknown): UndeliveredOrdersReport {
  const body = asRecord(value, "report");
  const orders = body["orders"];

  if (!Array.isArray(orders)) {
    throw new UndeliveredOrdersResponseError(
      `report.orders: expected an array, got ${typeof orders}`,
    );
  }

  return {
    count: readNumber(body, "report", "count"),
    truncated: readBoolean(body, "report", "truncated"),
    message: readString(body, "report", "message"),
    orders: orders.map((entry, index) => toUndeliveredOrder(entry, `report.orders[${String(index)}]`)),
  };
}

/**
 * Every order paid and holding no key, as the operator's screen shows it.
 *
 * Rejects with {@link AdminUnauthorizedError} on the guard's `401`, with
 * {@link AdminSurfaceDisabledError} on its `503`, and with whatever went wrong
 * otherwise — {@link UndeliveredOrdersResponseError} for a body that is not a
 * report, `HttpError` for any other refusal, a `TypeError` from `fetch` when the
 * API cannot be reached at all.
 *
 * **The token travels in a header and nowhere else.** Never in the path, never
 * in a query string: a URL is written into browser history, sent onward in
 * `Referer`, and recorded verbatim in every access log between here and the
 * server, and a shared credential that has been through all three is a
 * credential that has to be rotated.
 *
 * The report carries **no delivered key, ever** — the API gates that in SQL, and
 * {@link UndeliveredOrder} has nowhere to put one, so a server that one day
 * forgot could still not put a shopper's key on an operator's screen.
 */
export async function fetchUndeliveredOrders(
  token: string,
  signal?: AbortSignal,
): Promise<UndeliveredOrdersReport> {
  try {
    return toReport(
      await getJson(undeliveredEndpoint, {
        signal,
        headers: { Authorization: `Bearer ${token}` },
      }),
    );
  } catch (error: unknown) {
    if (error instanceof HttpError && error.status === unauthorizedStatus) {
      throw new AdminUnauthorizedError();
    }

    if (error instanceof HttpError && error.status === serviceUnavailableStatus) {
      throw new AdminSurfaceDisabledError();
    }

    throw error;
  }
}
