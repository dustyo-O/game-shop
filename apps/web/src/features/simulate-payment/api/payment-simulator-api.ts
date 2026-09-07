/**
 * The storefront's half of `POST /api/payments/:orderId/simulate` — the one
 * request behind «Оплатить успешно» and «Оплата не прошла»
 * (technical-considerations §2.3, functional spec §2.3).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS REQUEST DOES NOT LIVE IN `entities/order/api`
 * ---------------------------------------------------------------------------
 * `entities/order/api/order-api.ts` states the rule this file is measured
 * against: *"an entity's `api` segment holds the requests that read and write
 * that entity; a feature holds what a shopper's click does with them."*
 *
 * This request does not write an order. It mints a **payment event** and hands
 * it to the webhook, and the API is explicit that its `200` reports the event
 * rather than the order — `SimulatedPaymentAck` in
 * `apps/api/src/payments/payment-simulator.types.ts` refuses to answer with the
 * order's new state precisely because from Phase 2 the order will not have moved
 * by the time the response is written. The order changes, or does not, as a
 * consequence the shop decides one hop away.
 *
 * So the honest home for it is either an `entities/payment-event` slice or the
 * feature that is its only caller. A whole entity slice for a single POST whose
 * response body this app throws away would be ceremony with no payoff, and the
 * project prefers light ceremony. It goes here, next to the behaviour.
 *
 * ---------------------------------------------------------------------------
 * WHY THE `200` BODY IS DISCARDED
 * ---------------------------------------------------------------------------
 * The acknowledgement carries `event_id`, `order_id`, `status`, `amount`,
 * `currency` and `webhook_outcome`. Every one of those is useful — to a race
 * script, which is the other caller of this endpoint. To a shopper's page, none
 * of it is: the page's next move is to re-read `GET /api/orders/:id`, which owns
 * the shape it renders. Parsing a body no line of code reads would give the
 * storefront a second view of a payment to keep in step with the first, which is
 * the argument `createOrder` already makes about the `201` body it ignores.
 *
 * What matters to the caller is the difference between *the shop has the event*
 * and *it does not*, and that is the difference between resolving and rejecting.
 */
import { OrderNotFoundError } from "../../../entities/order/index.js";
import { HttpError, postJson } from "../../../shared/api/http.js";

/**
 * Which outcome the shopper asked the simulated provider to report.
 *
 * **Mirrored, not imported.** The API's `SimulatedPaymentOutcome` lives in
 * `apps/api`, and `apps/web` is not a dependent of `apps/api` and must not
 * become one — the same reasoning `entities/order/model/order.ts` gives for
 * mirroring `OrderView`. It is not in `@game-shop/contracts` either, and should
 * not be: that package holds what the *payment provider* owns, and these two
 * strings are the vocabulary of the thing instructing the simulator. The two
 * copies agree because they name the same two wire values, and the `400` the API
 * answers a typo with is where that agreement is checked at run time.
 *
 * Note the deliberate mismatch with the words either side of it: the button says
 * «Оплатить успешно», the wire says `success`, the *event* says `paid`, and the
 * *order* ends up `paid`. Three vocabularies for one journey, kept apart on
 * purpose (`apps/api/src/payments/payment-simulator.types.ts`).
 */
export const PaymentOutcome = {
  Success: "success",
  Failure: "failure",
} as const;

export type PaymentOutcome = (typeof PaymentOutcome)[keyof typeof PaymentOutcome];

const notFoundStatus = 404;
const badGatewayStatus = 502;

/**
 * The API answered `502`: the event was minted but could not be handed to the
 * webhook.
 *
 * A **separate class** for the reason `OrderNotFoundError` and
 * `ProductNotPurchasableError` are separate classes — it is the one failure
 * whose Russian sentence differs in what it tells the shopper to do. A `502` is
 * never the shop's verdict on a payment: nothing was decided, the order has not
 * moved, and pressing the control again is safe. It is safe *because* a retry
 * that pins no `event_id` is a new event, and one that pins the old id is
 * absorbed as a duplicate by `payment_events.event_id`'s primary key (I2) — not
 * because anything in this file makes it so.
 */
export class PaymentNotDeliveredError extends Error {
  constructor(readonly orderId: string) {
    super(`payment event for order "${orderId}" could not be delivered to the webhook`);
    this.name = "PaymentNotDeliveredError";
  }
}

/**
 * Ask the simulated provider to report `outcome` for this order.
 *
 * Resolves when the shop has the event. It does **not** resolve to the order's
 * new state, and the caller must not infer one: for `failure` the order really
 * has moved to `payment_failed` by now, and for `success` it has not moved at
 * all — the `paid` event is banked in the inbox unprocessed until issuance lands
 * (`apps/api/src/payments/payment-event-processor.service.ts`, "Why `paid` is
 * stored and then left alone"). The only way to know where an order is, is to
 * ask the endpoint that owns that question.
 *
 * Rejects with {@link OrderNotFoundError} on a `404`, with
 * {@link PaymentNotDeliveredError} on a `502`, and with whatever went wrong
 * otherwise — `HttpError` for any other refusal, a `TypeError` from `fetch` when
 * the API cannot be reached at all. `OrderNotFoundError` is the entity's class
 * rather than a second one minted here, because *there is no order with this id*
 * is one fact whichever endpoint reports it, and one class is what lets the page
 * and the controls branch on it without translating between two.
 *
 * The id is encoded on the way into the URL: it came out of the address bar, and
 * an address bar holds whatever a shopper pasted into it.
 */
export async function simulatePayment(orderId: string, outcome: PaymentOutcome): Promise<void> {
  try {
    await postJson(`/api/payments/${encodeURIComponent(orderId)}/simulate`, { outcome });
  } catch (error: unknown) {
    if (error instanceof HttpError && error.status === notFoundStatus) {
      throw new OrderNotFoundError(orderId);
    }

    if (error instanceof HttpError && error.status === badGatewayStatus) {
      throw new PaymentNotDeliveredError(orderId);
    }

    throw error;
  }
}
