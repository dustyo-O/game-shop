/**
 * The shapes either side of `POST /api/webhooks/payment`
 * (technical-considerations §2.3).
 *
 * The *request* shape is not here — it is `PaymentWebhookPayload` in
 * `@game-shop/contracts`, because the payment provider owns it and `apps/web`,
 * `apps/api` and the race scripts all have to agree on it letter for letter.
 * What lives here is the pair of shapes this endpoint owns: the row it writes to
 * the inbox, and the body it acknowledges with.
 */
import type { MinorUnits } from "@game-shop/contracts";

/**
 * One `payment_events` row, ready to be written — the output of the endpoint's
 * parsing step.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS WIDER THAN `PaymentWebhookPayload`
 * ---------------------------------------------------------------------------
 * `status` and `currency` are plain `string` here, where the contract narrows
 * them to `PaymentEventStatus` and `Currency`. That is deliberate, and it is the
 * receive → persist → acknowledge → process pattern showing through
 * (`architecture.md` §4).
 *
 * The only question this endpoint may ask of a body is **"can I write it to the
 * inbox?"** — not "did the provider send something I recognise?". An event
 * naming a status we have never heard of, or a currency the shop cannot price,
 * is still evidence of something that happened to a real charge; rejecting it at
 * the door destroys that evidence and — because a payment provider retries on
 * `5xx` — asks for it again, forever. So it is stored verbatim and then ignored
 * by the transition rules, which is exactly what `payment_events.status` having
 * **no CHECK constraint** is for (`packages/db/src/schema/shop.ts`).
 *
 * The narrowing does happen, one step later and one layer down:
 * `isPaymentEventStatus` runs when the stored event is *applied* to its order
 * (technical-considerations §2.5 step 2), where "I do not recognise this" has a
 * safe answer — leave the order alone — instead of a destructive one.
 *
 * Field names are camelCase because these are column values, not wire fields.
 * The wire's snake_case belongs to `PaymentWebhookPayload`; the mapping between
 * the two is this endpoint's job and happens in exactly one place
 * (`parsePaymentWebhookPayload`).
 */
export interface StorablePaymentEvent {
  /**
   * `payment_events.event_id`, the PRIMARY KEY — and therefore the one field
   * whose absence makes a body unstorable. Winning the insert on this value is
   * what "first sight" means (I2).
   */
  readonly eventId: string;

  /**
   * `payment_events.order_id`. **May name an order that does not exist.** The
   * column carries no foreign key on purpose, so "webhook before order" is a
   * normal path (`architecture.md` §4, "Out-of-order tolerance").
   */
  readonly orderId: string;

  /** `payment_events.status`, verbatim. `paid` or `failed` — or anything else; see above. */
  readonly status: string;

  /**
   * `payment_events.amount_minor` — **kopecks**, converted from the wire's whole
   * roubles by `majorToMinor`. The provider's `amount: 500` is `50000` here.
   *
   * A claim to be reconciled, never an authority: the order's amount was
   * computed server-side from the catalogue at creation time and is what the
   * shop settles against (`packages/contracts/src/money.ts`).
   */
  readonly amountMinor: MinorUnits;

  /** `payment_events.currency`, verbatim. */
  readonly currency: string;

  /**
   * `payment_events.payload` — the body **exactly as it arrived**, not the five
   * fields above re-serialised.
   *
   * `unknown` because the database guarantees valid JSON, not a shape. Keeping
   * the original is what lets a disputed delivery be audited against what the
   * provider actually sent, including fields this phase does not read (the
   * contract's `created_at`) and fields it has never heard of.
   */
  readonly payload: unknown;
}

/**
 * What the inbox did with the event, as reported to the caller.
 *
 * The provider ignores this body — it reads the status code and nothing else,
 * and both values below are sent with `200`. It exists for humans and for the
 * race scripts, which assert that twenty concurrent copies of one `event_id`
 * produce exactly one `stored`.
 */
export const PaymentWebhookAckOutcome = {
  /** First sight: this call won the insert and the row is now in the inbox. */
  Stored: "stored",
  /** A redelivery of an event already in the inbox. Nothing was written. */
  Duplicate: "duplicate",
} as const;

export type PaymentWebhookAckOutcome =
  (typeof PaymentWebhookAckOutcome)[keyof typeof PaymentWebhookAckOutcome];

/**
 * Narrow an unvalidated value to a {@link PaymentWebhookAckOutcome}.
 *
 * Needed because this acknowledgement is **read back over HTTP**, not only
 * written: the payment simulator delivers its events to this endpoint the way a
 * real provider would (`./payment-simulator.service.ts`), so what it receives is
 * `JSON.parse` output and nothing about the type it was serialised from
 * survives the trip. The same stance `parsePaymentWebhookPayload` takes about
 * the request body, applied to the response — a wire type describes what the
 * other end promised, never evidence that a particular payload conformed.
 */
export function isPaymentWebhookAckOutcome(value: unknown): value is PaymentWebhookAckOutcome {
  return value === PaymentWebhookAckOutcome.Stored || value === PaymentWebhookAckOutcome.Duplicate;
}

/**
 * The `200` body.
 *
 * Deliberately tiny. A webhook response is not a place to publish state: the
 * provider is not a client of this shop, the order may not even exist yet, and
 * anything richer would be a second view of an order to keep in step with
 * `GET /api/orders/:id` for the benefit of a reader that discards it.
 */
export interface PaymentWebhookAck {
  /** Echoed back so a log line on the provider's side can be matched to ours. */
  readonly event_id: string;

  /** {@link PaymentWebhookAckOutcome} — `stored` on first sight, `duplicate` on a redelivery. */
  readonly outcome: PaymentWebhookAckOutcome;
}
