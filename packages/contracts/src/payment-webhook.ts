/**
 * The payment provider's webhook — `POST /api/webhooks/payment`.
 *
 * **This shape is a fixed input.** It is transcribed from the assignment and may
 * not be renamed, camelCased or extended (technical-considerations §3, "System
 * Dependencies": *the supplied catalog, key pool and webhook contract are fixed
 * inputs and must be used verbatim*). The snake_case field names below are the
 * provider's, not ours; our own storage names differ and that mapping is the
 * receiver's job, not this file's.
 *
 * The body the assignment specifies, verbatim:
 *
 *     {
 *       "event_id":   "evt_a1b2c3",
 *       "order_id":   "ord_00123",
 *       "status":     "paid",
 *       "amount":     500,
 *       "currency":   "RUB",
 *       "created_at": "2025-01-01T12:00:00Z"
 *     }
 *
 * A payload that arrives over HTTP has been parsed, not verified. These types
 * describe what the provider promises to send; they are the *output* of the
 * endpoint's parsing step, never an assertion that an incoming `req.body`
 * already conforms. There is no validation here on purpose — a package
 * `apps/web` bundles into a browser must not carry a validation framework.
 */
import type { Currency, MajorUnits } from "./money.js";

/**
 * The provider's verdict on a payment.
 *
 * Note the asymmetry with `OrderStatus`: `failed` here becomes
 * `payment_failed` on the order. The provider's vocabulary and the shop's
 * lifecycle are separate on purpose — a webhook reports what happened to a
 * charge, and the shop decides what that means for an order
 * (technical-considerations §2.5 step 2).
 */
export const PaymentEventStatus = {
  Paid: "paid",
  Failed: "failed",
} as const;

export type PaymentEventStatus = (typeof PaymentEventStatus)[keyof typeof PaymentEventStatus];

/**
 * Narrow an unvalidated value to a {@link PaymentEventStatus}.
 *
 * Returning `false` is **not** a reason to answer the webhook with a `5xx`. The
 * provider retries on `5xx` (architecture §4), so an unrecognised status must
 * still be persisted to `payment_events` — whose `status` column deliberately
 * carries no CHECK constraint for exactly this reason — and then ignored by the
 * transition rules. Persist, acknowledge `200`, do nothing.
 */
export function isPaymentEventStatus(value: unknown): value is PaymentEventStatus {
  return value === PaymentEventStatus.Paid || value === PaymentEventStatus.Failed;
}

/** The webhook body, exactly as the payment provider sends it. */
export interface PaymentWebhookPayload {
  /**
   * The provider's identifier for this event, unique per event. A redelivery of
   * the same event carries the same `event_id`.
   *
   * It is the deduplication key and is stored as the PRIMARY KEY of
   * `payment_events` — there is no surrogate id, because a second identity would
   * let one event exist twice (invariant I2):
   *
   *   INSERT INTO payment_events (event_id, order_id, status, amount_minor, currency, payload)
   *   VALUES ($1, $2, $3, $4, $5, $6)
   *   ON CONFLICT (event_id) DO NOTHING
   *   RETURNING *;
   *   -- 1 row  => first sight of this event; process it.
   *   -- 0 rows => redelivery; acknowledge 200 and stop.
   */
  readonly event_id: string;

  /**
   * The order this event is about, as `orders.id` (`ord_` + ULID).
   *
   * May name an order that does not exist yet. `payment_events.order_id` carries
   * no foreign key precisely so that "webhook arrives before its order" is a
   * normal path rather than a `500` that triggers redelivery (architecture §4,
   * "Out-of-order tolerance").
   */
  readonly order_id: string;

  /** `paid` or `failed`. */
  readonly status: PaymentEventStatus;

  /**
   * ####################################################################
   * # WHOLE ROUBLES — **NOT** MINOR UNITS. `500` HERE IS `50000` THERE. #
   * ####################################################################
   *
   * The assignment's example reads `"amount": 500` and means five hundred
   * roubles; `orders.amount_minor` for that same order holds `50000`.
   *
   * Typed as {@link MajorUnits} so the compiler refuses the comparison this
   * mismatch invites. To check a payment against its order, convert first:
   *
   *     import { majorToMinor } from "@game-shop/contracts";
   *     majorToMinor(payload.amount) === order.amountMinor
   *
   * See the header of `./money.ts` for the full reasoning.
   *
   * This value is also **the payment provider's claim, not an authority**. The
   * order's amount was computed server-side from stored catalogue data at
   * creation time and is what the shop settles against; this field is something
   * to reconcile, never something to trust into the order.
   */
  readonly amount: MajorUnits;

  /** ISO 4217 code. `RUB` throughout the supplied catalogue. */
  readonly currency: Currency;

  /** ISO 8601 instant, e.g. `2025-01-01T12:00:00Z`. The provider's clock, not ours. */
  readonly created_at: string;
}
