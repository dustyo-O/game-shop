/**
 * The body `POST /api/admin/orders/:orderId/retry` answers `200` with — **what
 * came of pushing one stuck order back through issuance** (spec 003 functional
 * spec §2.5, technical-considerations §8).
 *
 * Filed beside `./undelivered-orders.types.ts` and for its reasons: the
 * contracts package holds the shapes **two sides must agree on letter for
 * letter** — the payment webhook payload, the supplier `/issue` contract, the
 * lifecycle enum — and this one has a single producer and a single consumer
 * that mirrors rather than imports it, because `apps/web` is not a dependent of
 * `apps/api` and must not become one.
 *
 * ###########################################################################
 * # THE WIRE SHAPE IS FIXED BY A CONSUMER THAT ALREADY EXISTS. THIS FILE
 * # FOLLOWS IT; IT DOES NOT PROPOSE IT.
 * ###########################################################################
 *
 * The retry button was built before this endpoint and parses strictly, field by
 * field, throwing `RetryReportError` naming the exact path of anything it does
 * not recognise
 * (`apps/web/src/features/retry-order-delivery/api/retry-order-api.ts`). Every
 * name below is checked against that parser rather than against taste:
 * `snake_case` on the wire, the four outcome words exactly as it spells them,
 * and `delivered` as a **boolean** — see the note on it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE, AND CANNOT BE ADDED BY ACCIDENT
 * ---------------------------------------------------------------------------
 * **There is no field for a key**, under any name. §8: *the report carries no
 * delivered key, ever.* The operator needs to know *that* the order was
 * delivered; they have no business reading the code the shopper bought. The
 * runner's own result does carry one ({@link IssuanceResult} narrows to a
 * `code` on the delivered branch), so unlike the list endpoint the exclusion
 * here is a decision made in `./order-retry.service.ts` at every mapping — and
 * these types are the second place that keeps it, with nowhere to put a key
 * even if that mapping one day forgot.
 */
import type { OrderStatus } from "@game-shop/contracts";

/**
 * The four things a retry that **ran** can have concluded.
 *
 * A closed set of exactly the four words the consumer's `RetryOutcome` knows. A
 * fifth would reach the operator's screen as a parse failure naming the field,
 * which is the right failure — but it is still a failure, so this set changes
 * only in step with `apps/web/src/features/retry-order-delivery/model`.
 *
 * **None of them is the `409`.** That is not an outcome of a retry, it is the
 * absence of one: zero rows from every guarded UPDATE, so nothing ran and there
 * is no body at all. The pair a hurried implementation collapses is
 * {@link OrderRetryOutcome.StillOutOfStock} and that `409`, and §8 defends the
 * distinction explicitly — *"it is stuck, the retry ran correctly, and it is
 * still stuck"* against *"you were looking at a stale list"*.
 */
export const OrderRetryOutcome = {
  /** A key was issued and bound. The order leaves the operator's list. */
  Delivered: "delivered",

  /**
   * The retry ran correctly **and the order is still stuck**: every supplier was
   * asked and every one of them has an empty shelf. §2.5's fifth criterion — the
   * operator is told why, and the order stays in the list.
   */
  StillOutOfStock: "still_out_of_stock",

  /**
   * Every supplier was asked and at least one refused for a reason that is not
   * an empty pool. Settled, still recoverable, still listed.
   */
  DeliveryFailed: "delivery_failed",

  /**
   * **The shop cannot say.** Either a supplier never answered and the outcome
   * was never established ({@link IssuanceOutcome.NeverEstablished} — and then
   * `outstanding_request_id` is set and is the field that matters), or the walk
   * concluded nothing because the order stopped being this call's to move.
   *
   * Deliberately *not* reported as a failure. A request whose outcome nobody
   * knows may have cut a key, and telling an operator "failed" teaches them to
   * press again against a supplier that already answered — the precise habit
   * this phase exists to break.
   */
  Unresolved: "unresolved",
} as const;

export type OrderRetryOutcome = (typeof OrderRetryOutcome)[keyof typeof OrderRetryOutcome];

/** The `200` body. `snake_case`, like every other body this API sends. */
export interface OrderRetryReport {
  readonly outcome: OrderRetryOutcome;

  /** The order that was retried, echoed because a screen may have three in flight. */
  readonly order_id: string;

  /**
   * Where the order stands **after** the walk, read from `orders` once the
   * ladder came to rest — not the status the claim wrote on the way in, and not
   * a status inferred from the outcome.
   *
   * Advisory, like every read-back in this codebase: another process may move
   * the order between the walk and this `SELECT`. The operator's list is the
   * authority, which is why the consumer re-fetches it whatever this says.
   */
  readonly status: OrderStatus;

  /** The supplier that was asked, when one was. `null` when none was reached. */
  readonly provider: string | null;

  /** The id the request was made under, when one was made. */
  readonly request_id: string | null;

  /**
   * **The request whose outcome is still unknown**, or `null`.
   *
   * Set only on {@link OrderRetryOutcome.Unresolved} arising from silence. It is
   * the one thing that can still find out what happened — by being asked again,
   * under the same id — and it is the same field §8 surfaces in the recovery
   * list for the same reason.
   */
  readonly outstanding_request_id: string | null;

  /**
   * English, operator-facing, rendered by the screen as given (A10). Never a
   * key, never a stack trace, never `null` dressed up as "failed" — the
   * one-character bug §9.3 names.
   */
  readonly detail: string | null;

  /**
   * The success flag, and the **only** thing a delivered retry publishes about
   * the key. A boolean because §8 forbids the code itself: the operator learns
   * that the order is finished, and the shopper learns the key.
   */
  readonly delivered: boolean;
}
