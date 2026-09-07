/**
 * The shapes either side of `POST /api/payments/:orderId/simulate`
 * (technical-considerations §2.3).
 *
 * The *event* this endpoint emits is not described here — that is
 * `PaymentWebhookPayload` in `@game-shop/contracts`, because the payment
 * provider owns it and the simulator's whole job is to produce it letter for
 * letter. What lives here is the pair of shapes the simulator itself owns: the
 * instruction a caller sends it, and what it reports back.
 *
 * Field names are snake_case because they are wire fields, matching §2.3 and
 * every other endpoint in this API.
 */
import type { Currency, MajorUnits, PaymentEventStatus } from "@game-shop/contracts";

import type { PaymentWebhookAckOutcome } from "./payment-webhook.types.js";

/**
 * Which outcome the caller wants the provider to report.
 *
 * **Deliberately the shopper's vocabulary, not the provider's.** The button on
 * the order page says «Оплатить успешно» / «Оплата не прошла», and the request
 * body says `success` / `failure`; the *event* then says `paid` / `failed`,
 * which is the provider's word, and the *order* ends up `paid` /
 * `payment_failed`, which is the shop's. Three vocabularies for one journey is
 * not an accident — `packages/contracts/src/payment-webhook.ts` keeps the last
 * two apart on purpose, and collapsing the first into them would make the
 * simulator look like the provider rather than like something instructing it.
 */
export const SimulatedPaymentOutcome = {
  /** Emit `status: "paid"`. */
  Success: "success",
  /** Emit `status: "failed"`. */
  Failure: "failure",
} as const;

export type SimulatedPaymentOutcome =
  (typeof SimulatedPaymentOutcome)[keyof typeof SimulatedPaymentOutcome];

/**
 * The request body.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT IN IT: AN AMOUNT
 * ---------------------------------------------------------------------------
 * There is no `amount`, no `currency` and no `discount` field, for the reason
 * `CreateOrderRequest` gives at its own door: the server computes what is owed.
 * The simulator reads `orders.amount_minor` — the value the catalogue wrote into
 * the row at creation time — and converts it to the wire's whole roubles itself.
 * A caller cannot state the amount because there is no field through which to
 * state one, which is a stronger guarantee than validating one away.
 *
 * ---------------------------------------------------------------------------
 * WHY `event_id` IS AN OPTIONAL FIELD RATHER THAN A SEPARATE ENDPOINT
 * ---------------------------------------------------------------------------
 * Two behaviours are needed and they must not be confusable:
 *
 *   - **A new payment** — the default, and by far the common case. Omitting
 *     `event_id` mints a fresh one (`./payment-event-id.ts`), so the *only* way
 *     to produce a duplicate is to ask for one. A simulator that reused an id by
 *     default would silently exercise the redelivery path instead of the first
 *     -sight path, and every "exactly one `stored`" assertion would pass for the
 *     wrong reason.
 *   - **A deliberate redelivery** — Phase 2's `race:same-event` script fires N
 *     concurrent copies of *one* `event_id` and asserts that exactly one is
 *     `stored` (`architecture.md` §7). That is a real provider behaviour, not a
 *     test hack: a provider that does not hear a `200` sends the same event
 *     again, byte for byte.
 *
 * An optional field rather than the alternatives, each of which was worse:
 *
 *   - **A second endpoint** (`/replay`) would duplicate the amount lookup and
 *     the delivery, and the two would drift the moment one of them was fixed.
 *   - **A `?replay=true` query parameter** still has to carry the id, so it is
 *     the same field wearing a different hat.
 *   - **Letting the race script call the webhook directly** would work — it is
 *     ordinary HTTP — but then the script would have to build the payload
 *     itself, which means a second place that knows the roubles-vs-kopecks
 *     conversion. The whole point of this endpoint is that there is one.
 *
 * The field is named `event_id`, exactly as the wire field it lands in, so a
 * script that has read one payload can replay it by copying a name rather than
 * translating one.
 */
export interface SimulatePaymentRequest {
  /** {@link SimulatedPaymentOutcome} — `success` or `failure`. Required. */
  readonly outcome: SimulatedPaymentOutcome;

  /**
   * Pin the event's identity instead of minting a fresh one — a **deliberate**
   * redelivery of an event this caller has already sent.
   *
   * Absent is the normal case and means "a new payment". Present means "send
   * this exact event again", and the second delivery is expected to come back
   * `duplicate` with nothing changed: that is invariant I2 working, not an
   * error.
   */
  readonly event_id?: string;
}

/**
 * The `200` body — what the simulator sent, and what the webhook did with it.
 *
 * ---------------------------------------------------------------------------
 * WHY IT REPORTS THE EVENT AND NOT THE ORDER
 * ---------------------------------------------------------------------------
 * The obvious alternative is to answer with the order's new state, which the UI
 * would seem to want. It is the wrong shape twice over:
 *
 *   - **It would be a second view of an order to keep in step with
 *     `GET /api/orders/:id`**, which is the endpoint the page already polls once
 *     a second (technical-considerations §2.6) and which owns that shape.
 *   - **It would be a lie as soon as processing moves off the acknowledgement
 *     path.** Today the webhook applies the event inline, so the order really
 *     has moved by the time this response is written; from Phase 2 it will not
 *     have (`architecture.md` §4). A response that reports the order's state
 *     would then be reporting a state that is about to change, and the page
 *     would render it as settled.
 *
 * So this says only what is true at both ends of that change: *this event was
 * minted and the webhook has it*. The page's next move is the one it makes
 * anyway — poll `GET /api/orders/:id` until it settles.
 */
export interface SimulatedPaymentAck {
  /**
   * The event's identity — freshly minted, or the one the caller pinned.
   *
   * Worth reading back even when the caller supplied it: this is the value a
   * `payment_events` row can be found by, and quoting it is what makes a race
   * script's output correlate with the API's log lines.
   */
  readonly event_id: string;

  /** The order the event was about, echoed from the route. */
  readonly order_id: string;

  /**
   * The provider's verdict that was put on the wire — `paid` for
   * `outcome: "success"`, `failed` for `outcome: "failure"`.
   *
   * The provider's vocabulary, not the shop's: the order this drives ends up
   * `paid` or **`payment_failed`** (`packages/contracts/src/payment-webhook.ts`).
   */
  readonly status: PaymentEventStatus;

  /**
   * **Whole roubles — the wire scale.** `1290` here is the order's
   * `amount_minor: 129000`.
   *
   * Echoed at the scale it was sent at, not at the scale it is stored at, so
   * that a reader comparing this response against the `payment_events` row sees
   * the factor of 100 rather than being shielded from it
   * (`packages/contracts/src/money.ts`).
   */
  readonly amount: MajorUnits;

  /** ISO 4217, read from the order. `RUB` throughout the supplied catalogue. */
  readonly currency: Currency;

  /**
   * What the webhook answered: `stored` on first sight, `duplicate` when this
   * `event_id` was already in the inbox.
   *
   * **This is the field a race script asserts on.** Twenty concurrent copies of
   * one pinned `event_id` must produce exactly one `stored` and nineteen
   * `duplicate`s — the shop-side proof of invariant I2, read straight off the
   * responses. It is the webhook's own word, passed through unchanged rather
   * than re-derived here, because the only authority on which insert won is the
   * process that ran it.
   */
  readonly webhook_outcome: PaymentWebhookAckOutcome;
}
