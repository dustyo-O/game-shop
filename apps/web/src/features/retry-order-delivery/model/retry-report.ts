/**
 * What `POST /api/admin/orders/:orderId/retry` says came of the retry.
 *
 * The shape is pinned by `technical-considerations.md` §8 and is parsed at the
 * boundary rather than asserted — see `../api/retry-order-api.ts`. It lives in
 * this slice rather than in `@game-shop/contracts` for the same reason
 * `entities/undelivered-order/model` holds the list's shape: the admin wire
 * formats are read by exactly one consumer, and a shared package that carried
 * them would make every change to an operator screen a change to a published
 * package the API also depends on.
 *
 * ---------------------------------------------------------------------------
 * `delivered` IS A BOOLEAN, AND THE KEY IS NEVER HERE
 * ---------------------------------------------------------------------------
 * §8: *the report carries no delivered key, ever*. The operator has no business
 * reading a shopper's key, so the success signal is the flag and the order
 * leaving the list — not a code on screen. Nothing in this slice renders a key
 * because nothing in this slice is ever given one.
 */
import type { OrderStatus } from "@game-shop/contracts";

/**
 * The four things a retry that *ran* can have concluded.
 *
 * A closed set with an `as const` object rather than an `enum`: it emits no
 * runtime class, and {@link isRetryOutcome} below turns it into the guard the
 * parser needs. An unrecognised value is a parse failure the operator is told
 * about by name, not a silent fall-through to "something went wrong".
 */
export const RetryOutcome = {
  /** A key was issued. The order leaves the list. */
  Delivered: "delivered",

  /**
   * The retry ran correctly **and the order is still stuck** — the supplier has
   * nothing to hand over. This is the outcome §2.5's fifth criterion is about,
   * and it is emphatically not a `409`: see `../api/retry-order-api.ts`.
   */
  StillOutOfStock: "still_out_of_stock",

  /** The supplier was asked and refused. Stays in the list, retryable. */
  DeliveryFailed: "delivery_failed",

  /**
   * The supplier was asked and never answered, so the shop still does not know
   * whether a key exists. Stays in the list; retrying asks about the *same*
   * outstanding request rather than starting a new one.
   */
  Unresolved: "unresolved",
} as const;

export type RetryOutcome = (typeof RetryOutcome)[keyof typeof RetryOutcome];

/** Widened to `string[]` so `.includes` accepts the `unknown` under test. */
const retryOutcomes: readonly string[] = Object.values(RetryOutcome);

/** Narrows an unparsed wire value to {@link RetryOutcome}. */
export function isRetryOutcome(value: unknown): value is RetryOutcome {
  return typeof value === "string" && retryOutcomes.includes(value);
}

/** The `200` body, in this app's camel case. */
export interface RetryOrderReport {
  readonly outcome: RetryOutcome;

  readonly orderId: string;

  /** Where the order stands **after** the walk, not before it. */
  readonly status: OrderStatus;

  /** The supplier that was asked, when one was. */
  readonly provider: string | null;

  /** The id the request was made under, when one was made. */
  readonly requestId: string | null;

  /** The request whose outcome is still unknown — what `unresolved` is about. */
  readonly outstandingRequestId: string | null;

  /** English, operator-facing, straight from the API. Rendered as given. */
  readonly detail: string | null;

  /** The success flag. Never a key — see the header. */
  readonly delivered: boolean;
}
