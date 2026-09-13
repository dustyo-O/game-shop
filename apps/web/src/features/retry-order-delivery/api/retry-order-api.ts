/**
 * The one call this feature makes, and — more importantly — the classification
 * of everything that can come back from it.
 *
 * ---------------------------------------------------------------------------
 * `409` AND `200 still_out_of_stock` ARE DIFFERENT NEWS
 * ---------------------------------------------------------------------------
 * They are the pair a hurried implementation collapses into one red message,
 * and §8 defends the distinction explicitly:
 *
 *   - **`409`** — *this order is not stuck*. The guarded UPDATE matched zero
 *     rows, so **nothing ran**. The operator pressed Retry on an order that had
 *     already moved on (somebody else's retry, or the automatic drain).
 *   - **`200` with `outcome: "still_out_of_stock"`** — *it is stuck, the retry
 *     ran correctly, and it is still stuck*. A supplier was asked and had
 *     nothing. §2.5's fifth criterion requires the operator to be told exactly
 *     this, and the order to stay in the list.
 *
 * One says "you were looking at a stale list"; the other says "the shop is out
 * of stock". Only one of them is worth pressing again after a restock, so they
 * get two error/report paths here and two sentences on screen.
 *
 * ---------------------------------------------------------------------------
 * WHAT COUNTS AS "THE ANSWER DID NOT COME BACK"
 * ---------------------------------------------------------------------------
 * This is Phase 3's own thesis pointed at the client. A request that was sent
 * and not answered **may well have delivered a key**: the claim-under-lock, the
 * supplier call and the `deliveries` insert all happen before any byte of the
 * response is written. So {@link RetryUnansweredError} is thrown for every
 * failure where the shop cannot know whether the work happened —
 *
 *   - `fetch` rejecting (`TypeError`): connection refused, DNS, the tab going
 *     offline mid-flight. The bytes may or may not have arrived.
 *   - any `5xx`: a proxy timing out at `504` is the textbook lost answer, and a
 *     `500` from an exception thrown *after* the guarded UPDATE committed is the
 *     same story with a shorter wire.
 *
 * — and the wording it produces refuses to call any of them a failure. The
 * alternative, reporting "retry failed", teaches the operator to press again
 * against a supplier that already answered, which is the precise habit this
 * phase exists to break.
 *
 * A `4xx` other than the three named ones is the opposite case: the request was
 * understood, rejected, and demonstrably did no work, so it is
 * {@link RetryRefusedError} and says so plainly.
 */
import { isOrderStatus } from "@game-shop/contracts";

import {
  AdminSurfaceDisabledError,
  AdminUnauthorizedError,
} from "../../../entities/undelivered-order/index.js";
import { HttpError, postJson } from "../../../shared/api/http.js";
import { isRetryOutcome, type RetryOrderReport } from "../model/retry-report.js";

const unauthorizedStatus = 401;
const conflictStatus = 409;
const serviceUnavailableStatus = 503;
const lowestServerErrorStatus = 500;

/**
 * `409` — the order was not eligible for a retry at all. **Nothing ran.**
 *
 * Carries the id because the notice names the row, and the operator may have
 * three retries concluding into one list.
 */
export class OrderNotStuckError extends Error {
  constructor(readonly orderId: string) {
    super(`order "${orderId}" is not stuck, so there was nothing to retry`);
    this.name = "OrderNotStuckError";
  }
}

/** The retry was sent and the shop does not know what became of it. See the header. */
export class RetryUnansweredError extends Error {
  constructor(readonly orderId: string) {
    super(`the retry of order "${orderId}" was sent and no answer came back`);
    this.name = "RetryUnansweredError";
  }
}

/**
 * The API answered `200` and the body could not be read as a report.
 *
 * Deliberately **not** an unanswered retry: a `200` means the walk finished, so
 * the work certainly happened. What is missing is only the account of it, and
 * the refreshed list will say where the order actually stands.
 */
export class RetryReportError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "RetryReportError";
  }
}

/** A `4xx` that is none of the three named ones: understood, refused, did nothing. */
export class RetryRefusedError extends Error {
  constructor(
    readonly orderId: string,
    readonly status: number,
  ) {
    super(`the API refused the retry of order "${orderId}" with ${String(status)}`);
    this.name = "RetryRefusedError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RetryReportError(`report: expected an object, got ${typeof value}`);
  }

  return value as Record<string, unknown>;
}

function readString(row: Record<string, unknown>, field: string): string {
  const value = row[field];

  if (typeof value !== "string") {
    throw new RetryReportError(`report.${field}: expected a string, got ${typeof value}`);
  }

  return value;
}

function readNullableString(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];

  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new RetryReportError(`report.${field}: expected a string or null, got ${typeof value}`);
  }

  return value;
}

function readBoolean(row: Record<string, unknown>, field: string): boolean {
  const value = row[field];

  if (typeof value !== "boolean") {
    throw new RetryReportError(`report.${field}: expected a boolean, got ${typeof value}`);
  }

  return value;
}

/**
 * Parse the `200` body.
 *
 * Same stance as `entities/undelivered-order/api`: `getJson`/`postJson` hand
 * back `unknown`, and the slice that knows what the endpoint promised does the
 * narrowing. A `report as RetryOrderReport` here would be a type assertion
 * wearing a nicer hat — it would turn a renamed field into `undefined` reaching
 * the screen as the word "undefined", instead of a sentence naming the field.
 */
function toReport(value: unknown): RetryOrderReport {
  const row = asRecord(value);
  const outcome = row["outcome"];

  if (!isRetryOutcome(outcome)) {
    throw new RetryReportError(`report.outcome: unknown outcome ${JSON.stringify(outcome)}`);
  }

  const status = row["status"];

  if (!isOrderStatus(status)) {
    throw new RetryReportError(`report.status: unknown status ${JSON.stringify(status)}`);
  }

  return {
    outcome,
    orderId: readString(row, "order_id"),
    status,
    provider: readNullableString(row, "provider"),
    requestId: readNullableString(row, "request_id"),
    outstandingRequestId: readNullableString(row, "outstanding_request_id"),
    detail: readNullableString(row, "detail"),
    delivered: readBoolean(row, "delivered"),
  };
}

/**
 * Ask the shop to walk one stuck order through issuance again.
 *
 * The token is a parameter rather than something this module reads for itself,
 * matching `fetchUndeliveredOrders`: where the operator's credential is kept is
 * `features/present-admin-token`'s business, and a transport that went looking
 * for it would be holding an opinion about who the caller is.
 *
 * `{}` rather than a body with content: §8's endpoint takes none — the order id
 * is in the path — and an empty JSON object is what a JSON transport sends when
 * it has nothing to say.
 *
 * There is **no `Idempotency-Key` and no client-side de-duplication cache**, and
 * that is not an omission. Pressing this twice is safe because of the order row
 * lock, the guarded UPDATE, `deliveries.order_id UNIQUE` and the supplier's
 * ledger (§8's race table) — mechanisms that also hold for two operators on two
 * machines, which no header minted in this tab could.
 */
export async function retryOrderDelivery(orderId: string, token: string): Promise<RetryOrderReport> {
  let body: unknown;

  try {
    body = await postJson(
      `/api/admin/orders/${encodeURIComponent(orderId)}/retry`,
      {},
      { Authorization: `Bearer ${token}` },
    );
  } catch (error: unknown) {
    if (error instanceof HttpError) {
      if (error.status === unauthorizedStatus) {
        throw new AdminUnauthorizedError();
      }

      if (error.status === serviceUnavailableStatus) {
        throw new AdminSurfaceDisabledError();
      }

      if (error.status === conflictStatus) {
        throw new OrderNotStuckError(orderId);
      }

      if (error.status >= lowestServerErrorStatus) {
        throw new RetryUnansweredError(orderId);
      }

      throw new RetryRefusedError(orderId, error.status);
    }

    // A `SyntaxError` comes from `response.json()`, which only runs on a 2xx:
    // the retry *ran*, and only the account of it is unreadable.
    if (error instanceof SyntaxError) {
      throw new RetryReportError(`report: the API answered 200 with a body that is not JSON`);
    }

    // Everything else is `fetch` rejecting — the request left, and nothing came
    // back to say whether it was carried out.
    throw new RetryUnansweredError(orderId);
  }

  return toReport(body);
}
