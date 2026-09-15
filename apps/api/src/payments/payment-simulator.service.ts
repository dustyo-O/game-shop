/**
 * The payment provider, simulated — technical-considerations §2.3 (*"stand in
 * for the payment provider ... constructs a contract-shaped event and delivers
 * it to the webhook endpoint"*) and `architecture.md` §6.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS PRETENDING TO BE, AND WHY THE PRETENCE IS LOAD-BEARING
 * ---------------------------------------------------------------------------
 * There is no real acquiring in this system and the assignment says there will
 * not be. So *something* has to play the part of the payment provider, and the
 * only question is how convincingly. This class answers it in three places, and
 * each one is a decision rather than a detail:
 *
 *   1. **It emits the supplied contract, not a convenient subset.** Every field
 *      of `PaymentWebhookPayload` is populated, including `created_at`, which
 *      nothing in the shop reads — because the payload is the thing under test
 *      and a payload that is missing what the real one carries tests a smaller
 *      system than the one being shipped.
 *   2. **It reaches the webhook over HTTP.** See the section below; this is the
 *      decision the whole slice turns on.
 *   3. **It knows the amount without being told.** A real provider was told the
 *      charge amount when the charge was created; here that fact lives in
 *      `orders.amount_minor`, so the simulator reads it. Nothing a caller sends
 *      can influence it, because there is no field for it to arrive in
 *      (`./payment-simulator.types.ts`).
 *
 * ---------------------------------------------------------------------------
 * IT CALLS ITS OWN API OVER THE NETWORK, ON PURPOSE
 * ---------------------------------------------------------------------------
 * `PaymentWebhookController` is a class in this same process, and injecting it
 * here would work, be faster, and be a mistake — the same mistake the project
 * refuses to make with the supplier stub, for the same reason
 * (`architecture.md` §6: *"reached over real HTTP so that latency, timeouts and
 * failures are genuine rather than simulated in-process"*).
 *
 * What an in-process call would quietly stop testing:
 *
 *   - **Serialisation.** A direct call hands the controller a live object with a
 *     branded `MajorUnits` amount and whatever prototype it had. The wire hands
 *     it `JSON.parse` output, which is where `parsePaymentWebhookPayload` earns
 *     its keep. An event that only ever travels as an object is never once
 *     parsed the way the provider's will be.
 *   - **The acknowledgement.** `200` vs `400` vs `5xx` is the entire vocabulary
 *     the shop uses to speak to a payment provider (`architecture.md` §4). A
 *     method call returns a value; only a request returns a status code, and only
 *     a status code can be got wrong in the way that matters.
 *   - **The process boundary Phase 2 depends on.** In production `apps/api` is a
 *     serverless function, so the simulator and the webhook it drives are two
 *     invocations with separate memory (`architecture.md` §5). A race script that
 *     drives this endpoint is only evidence about *concurrency* if the two sides
 *     are genuinely separate; an in-process call would collapse them into one
 *     stack and prove nothing about the deployed system.
 *
 * The cost is one loopback request per simulated payment and a URL in
 * configuration. Both are cheap, and the second is honest: the URL is where the
 * provider would be pointed at us, which is exactly what it names.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";

import {
  PaymentEventStatus,
  isCurrency,
  minorToMajor,
  minorUnits,
  type Currency,
  type MinorUnits,
  type PaymentWebhookPayload,
} from "@game-shop/contracts";
import { orders, type DatabaseClient } from "@game-shop/db";

import { readUrl } from "../config/env.js";
import { DATABASE_CLIENT } from "../database/database.module.js";
import { newPaymentEventId } from "./payment-event-id.js";
import {
  SimulatedPaymentOutcome,
  type SimulatedPaymentAck,
  type SimulatePaymentRequest,
} from "./payment-simulator.types.js";
import {
  isPaymentWebhookAckOutcome,
  type PaymentWebhookAckOutcome,
} from "./payment-webhook.types.js";

/**
 * The environment variable naming where the provider delivers. Documented in
 * `.env.example` beside `SUPPLIER_A_URL`, which exists for the same reason.
 */
const PAYMENT_WEBHOOK_URL = "PAYMENT_WEBHOOK_URL";

/**
 * How long {@link PaymentSimulatorService.deliver} waits for the webhook to
 * answer before reporting *no answer*.
 *
 * On Vercel the webhook is not "the same process one hop away" — it is a
 * second invocation of the same function, and possibly a cold one: Lambda
 * init + Nest `init()` + first connect (+ a Neon resume) ≈ 1.5–2.5 s
 * (technical-considerations §2.7, R1 of the Phase 6 spec). So the self-call
 * needs a bound that is comfortably above a cold boot, and 10 s is generous
 * on purpose: the supplier's `/issue` budget is 5 s per probe because a slow
 * supplier must be read as `unknown` promptly, whereas nothing here retries
 * and the only cost of waiting longer is the caller's patience. What the
 * bound must never be is absent — without one, a cold inner invocation that
 * never answers holds the outer one open to the platform's `maxDuration`
 * ceiling, and a hung simulation becomes a 60 s wait that ends in the
 * platform's own error rather than this class's honest "unknown".
 */
const WEBHOOK_SELF_CALL_TIMEOUT_MS = 10_000;

/**
 * Which of the two things happened. Named outcomes rather than
 * `SimulatedPaymentAck | null`, matching {@link OrdersService},
 * {@link PaymentEventsService} and {@link OrderTransitionService}: the
 * controller's `switch` reads as news and the compiler has something to be
 * exhaustive about.
 */
export const SimulatePaymentOutcome = {
  /** The event was built, delivered and acknowledged. */
  Delivered: "delivered",
  /**
   * No order with that id — so there is no amount to charge and no event to
   * build. See {@link PaymentSimulatorService.simulate} for why this is *not*
   * treated the way the webhook treats an unknown order.
   */
  OrderNotFound: "order_not_found",
} as const;

export type SimulatePaymentOutcome =
  (typeof SimulatePaymentOutcome)[keyof typeof SimulatePaymentOutcome];

export type SimulatePaymentResult =
  | {
      readonly outcome: typeof SimulatePaymentOutcome.Delivered;
      readonly ack: SimulatedPaymentAck;
    }
  | {
      readonly outcome: typeof SimulatePaymentOutcome.OrderNotFound;
      /** Echoed back so the caller can name it without re-reading the route parameter. */
      readonly orderId: string;
    };

/**
 * Why a delivery did not complete — and **the distinction is the point**, not
 * the message.
 *
 * `architecture.md` §8 requires typed domain errors that separate *definite
 * failure* from *unknown outcome*, because in the issuance path that separation
 * is what drives the retry policy. The same separation is true here and is worth
 * stating even though the simulator has no retry policy to drive: a rejection
 * and a silence are different facts about the world, and a report that blurs
 * them is a report that has to be re-derived from logs later.
 */
export const WebhookDeliveryFailure = {
  /**
   * **Definite.** The webhook answered, and the answer was not `2xx`. The event
   * was not stored — or was stored and then refused, which the endpoint does not
   * do (`./payment-webhook.controller.ts`). Sending it again changes nothing.
   */
  Rejected: "rejected",
  /**
   * **Unknown.** There was no answer at all: connection refused, the socket
   * died, the body was not JSON, or {@link WEBHOOK_SELF_CALL_TIMEOUT_MS}
   * expired first. The event may or may not have reached the inbox, and the
   * honest report says so rather than picking the comfortable half.
   */
  Unreachable: "unreachable",
} as const;

export type WebhookDeliveryFailure =
  (typeof WebhookDeliveryFailure)[keyof typeof WebhookDeliveryFailure];

/**
 * A delivery that did not produce an acknowledgement.
 *
 * Thrown rather than returned as a third outcome, because it is not a thing that
 * happens to a *simulation* — it is the simulator's own plumbing being broken,
 * in the same class as the database being unreachable. The controller turns it
 * into a `502`; nothing else catches it.
 */
export class PaymentWebhookDeliveryError extends Error {
  constructor(
    message: string,
    readonly failure: WebhookDeliveryFailure,
    readonly eventId: string,
    readonly orderId: string,
  ) {
    super(message);
    this.name = "PaymentWebhookDeliveryError";
  }
}

/** Exhaustiveness guard: the compiler routes here only if an outcome went unhandled. */
function assertNever(value: never): never {
  throw new Error(`payments: unhandled simulated outcome ${JSON.stringify(value)}`);
}

/**
 * The caller's word → the provider's word.
 *
 * A `switch` with an exhaustiveness guard rather than a ternary, so that adding
 * a third simulated outcome (Phase 3's timeout injection is the obvious
 * candidate) is a compile error here instead of a silent fall-through to
 * `failed`.
 */
function toEventStatus(outcome: SimulatedPaymentOutcome): PaymentEventStatus {
  switch (outcome) {
    case SimulatedPaymentOutcome.Success:
      return PaymentEventStatus.Paid;

    case SimulatedPaymentOutcome.Failure:
      return PaymentEventStatus.Failed;

    default:
      return assertNever(outcome);
  }
}

/**
 * Read the webhook's address out of the environment, once, at construction.
 *
 * Fails the bootstrap rather than the request. The simulator is not an optional
 * extra — it is the only way anything gets paid in this system — so an API that
 * came up without knowing where to deliver would be an API that looks healthy
 * and cannot take money. `main.ts` reads `API_PORT` with a default because a
 * wrong port is immediately obvious; a missing webhook URL is not, and there is
 * no default that would be right in both development and deployment.
 *
 * The parsing itself now lives in `../config/env.js`, shared with
 * `SUPPLIER_A_URL`, which is configured for the same reason and was about to
 * grow a near-identical copy of this function. Two consequences worth naming:
 * the message shape is now identical whichever variable is wrong, and this
 * variable inherited the scheme check it did not have before — a
 * `mailto:` address parses as a `URL` and cannot be POSTed to.
 *
 * Still read here in the constructor rather than behind a token in
 * `ConfigModule`: a default-scoped provider's constructor runs at the same
 * point in the bootstrap that a provider factory does, so moving it would buy
 * no earlier failure and would separate the value from the prose above that
 * explains it.
 */
function readWebhookUrl(): URL {
  return readUrl(
    PAYMENT_WEBHOOK_URL,
    "the payment simulator has nowhere to deliver events",
  );
}

@Injectable()
export class PaymentSimulatorService {
  private readonly logger = new Logger(PaymentSimulatorService.name);

  /** Where the provider delivers. Resolved once; see {@link readWebhookUrl}. */
  private readonly webhookUrl: URL;

  constructor(@Inject(DATABASE_CLIENT) private readonly database: DatabaseClient) {
    this.webhookUrl = readWebhookUrl();
  }

  /**
   * Emit one payment event for `orderId` and deliver it to the webhook.
   *
   * ---------------------------------------------------------------------------
   * AN UNKNOWN ORDER IS A `404` HERE, EVEN THOUGH THE WEBHOOK ACCEPTS ONE
   * ---------------------------------------------------------------------------
   * The two endpoints answer differently about the same missing order, and the
   * asymmetry is deliberate rather than an inconsistency to be tidied away:
   *
   *   - **The webhook must accept it.** `payment_events.order_id` carries no
   *     foreign key precisely so that an event arriving before its order is a
   *     normal path, stored pending and drained later (`architecture.md` §4,
   *     "Out-of-order tolerance"). A real provider knows an order id we gave it
   *     and has every right to report on it before our own write is visible;
   *     rejecting that would be rejecting the truth about a charge.
   *   - **The simulator cannot.** It is not a provider that was told an amount —
   *     it is a piece of the shop that *derives* the amount from
   *     `orders.amount_minor`. With no order row there is no amount, no
   *     currency, and therefore no contract-shaped event to build. The failure
   *     is not "too early", it is "unpriceable", and there is no later moment at
   *     which this call would have succeeded.
   *
   * Inventing an amount to fill the gap is the one thing that must not happen:
   * it would put a number on the wire that no catalogue row backs, which is the
   * exact shape of the client-supplied-amount bug the whole pricing path is
   * built to prevent.
   *
   * The "webhook before order" scenario is therefore staged by calling
   * `POST /api/webhooks/payment` directly — it is ordinary HTTP and
   * `architecture.md` §7 lists it as its own script — not by asking the
   * simulator to pretend it can price something that does not exist.
   *
   * ### No check on the order's status
   *
   * A `payment_failed` order can be simulated again, and so can a `delivered`
   * one. That is not an oversight: a real provider is not asking permission, and
   * the shop's defence against a late or repeated event is the status-guarded
   * transition that refuses it (invariant I9,
   * `OrderTransitionService`) — never a check here. An `if (order.status !==
   * "created")` in this method would be a check-then-act with a window between
   * the read and the delivery, and it would move a guarantee out of the database
   * and into application code, which is the one thing `architecture.md` §3's
   * governing principle forbids.
   *
   * Functional spec §2.3 does ask that a shopper whose payment has already
   * failed *sees no controls offering to pay again* — that is the order page
   * declining to offer the button, which is the next task, and it is a
   * presentation rule rather than a guarantee. The guarantee is that pressing it
   * anyway changes nothing.
   */
  async simulate(orderId: string, request: SimulatePaymentRequest): Promise<SimulatePaymentResult> {
    const charge = await this.readOrderCharge(orderId);

    if (charge === undefined) {
      this.logger.warn({
        msg: "payment simulator: no such order; nothing to charge",
        order_id: orderId,
      });

      return { outcome: SimulatePaymentOutcome.OrderNotFound, orderId };
    }

    // Absent `event_id` means "a new payment"; present means "send this exact
    // event again". The default is the fresh id, so a duplicate can only ever be
    // asked for — see `./payment-simulator.types.ts` for why that is the way
    // round it has to be.
    const eventId = request.event_id ?? newPaymentEventId();

    const payload: PaymentWebhookPayload = {
      event_id: eventId,
      order_id: orderId,
      status: toEventStatus(request.outcome),
      // ####################################################################
      // # THE COLUMN IS KOPECKS; THE WIRE IS ROUBLES. 129000 HERE IS 1290 THERE.
      // ####################################################################
      //
      // Through the branded helper rather than an inline `/ 100`, so the
      // crossing is greppable and the compiler knows which scale this number is
      // on (`packages/contracts/src/money.ts`). This is the mirror image of the
      // conversion `parsePaymentWebhookPayload` performs on the way back in, and
      // the round trip is what makes the pair auditable.
      amount: minorToMajor(charge.amountMinor),
      currency: charge.currency,
      // The *provider's* clock, which here is this process's. Not `now()` from
      // Postgres: `created_at` is the emitter's claim about when it saw the
      // charge settle, and the emitter is this class. The shop stamps its own
      // record of when it *received* the event, in `payment_events.received_at`,
      // from the database's clock — two timestamps, two authorities, and the
      // gap between them is the delivery latency a real integration cares about.
      created_at: new Date().toISOString(),
    };

    const webhookOutcome = await this.deliver(payload);

    this.logger.log({
      msg: "payment simulator: event delivered to the webhook",
      event_id: payload.event_id,
      order_id: payload.order_id,
      status: payload.status,
      amount: payload.amount,
      replayed: request.event_id !== undefined,
      webhook_outcome: webhookOutcome,
    });

    return {
      outcome: SimulatePaymentOutcome.Delivered,
      ack: {
        event_id: payload.event_id,
        order_id: payload.order_id,
        status: payload.status,
        amount: payload.amount,
        currency: payload.currency,
        webhook_outcome: webhookOutcome,
      },
    };
  }

  /**
   * What this order is owed, as the catalogue priced it — **the only source of
   * the amount that goes on the wire**.
   *
   * Emitted SQL (copied from `.toSQL()`; per the project's raw-SQL rule,
   * `architecture.md` §2, "Documentation convention"):
   *
   *   select "amount_minor", "currency" from "orders" where "orders"."id" = $1;
   *   -- $1 the order id from the URL.
   *   -- 1 row  => the amount to charge, exactly as `POST /api/orders` wrote it
   *   --           from `products.price_minor` (kopecks).
   *   -- 0 rows => no such order => 404. There is no amount to invent.
   *
   * Two columns and no join. This is deliberately **not**
   * `OrderViewService.findOrder`, even though that method would answer the
   * question: it joins `products` and `deliveries` to build the status page's
   * view, and the simulator needs neither a product name nor a key. Two
   * columns are not worth a two-table join on the payment path — and keeping
   * this read here, beside the send, is what lets one grep prove the simulator
   * sends exactly `orders.amount_minor` and nothing it computed itself.
   *
   * `status` is deliberately not selected. Nothing here branches on it — see the
   * "No check on the order's status" note on {@link simulate} — and selecting a
   * value in order to not use it is how a check-then-act gets written by the
   * next person to touch the file.
   */
  private async readOrderCharge(
    orderId: string,
  ): Promise<{ amountMinor: MinorUnits; currency: Currency } | undefined> {
    const [row] = await this.database.db
      .select({ amountMinor: orders.amountMinor, currency: orders.currency })
      .from(orders)
      .where(eq(orders.id, orderId));

    if (row === undefined) return undefined;

    if (!isCurrency(row.currency)) {
      // A currency the shop cannot scale (`MINOR_UNITS_PER_MAJOR` is only true
      // for an exponent-2 currency), so `minorToMajor` would put a wrong number
      // on the wire. Unreachable with the supplied catalogue, which is entirely
      // RUB, and a `500` rather than a silent conversion if it ever is not.
      throw new Error(`payments: order ${orderId} has unsupported currency "${row.currency}"`);
    }

    return {
      // Brands the raw integer column as kopecks — the one place an
      // `orders.amount_minor` value becomes a typed amount on this path
      // (`packages/contracts/src/money.ts`).
      amountMinor: minorUnits(row.amountMinor),
      currency: row.currency,
    };
  }

  /**
   * POST the event to the webhook and read its acknowledgement.
   *
   * This is the boundary the file header argues for, and it is an ordinary
   * `fetch`: JSON in, status code out. Nothing about it knows that the other end
   * happens to be the same process today and a different function instance in
   * production.
   *
   * ### What each answer means
   *
   *   - **`2xx`** — the event is in the inbox. The body says `stored` or
   *     `duplicate` and that word is passed through untouched: the only
   *     authority on which insert won is the process that ran it (I2).
   *   - **non-`2xx`** — a definite refusal. `400` means the payload could not
   *     become a row, which for an event this class built means *this class*
   *     built it wrong; that is a bug in the simulator, and it is reported as one
   *     rather than retried.
   *   - **no answer** — unknown, whether the connection failed or the webhook
   *     simply had not answered within {@link WEBHOOK_SELF_CALL_TIMEOUT_MS}.
   *     The event may have been stored, and the report says exactly that
   *     ({@link WebhookDeliveryFailure}).
   *
   * ### No retry, deliberately
   *
   * A real provider retries on `5xx`, and this stub does not. Adding one here
   * would be simulating the provider's *recovery* behaviour, which is not what
   * the endpoint exists to exercise — the shop-side behaviour under redelivery
   * is exercised far more sharply by pinning `event_id` and firing N concurrent
   * copies, which is what the Phase 2 race scripts do. A silent retry would also
   * make the response ambiguous: a `duplicate` could then mean either "you asked
   * twice" or "we asked twice", and that distinction is the whole value of the
   * field.
   */
  private async deliver(payload: PaymentWebhookPayload): Promise<PaymentWebhookAckOutcome> {
    let response: Response;

    try {
      response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
        // Bounded because on Vercel the other end is a second invocation of
        // this same function, possibly cold (≈1.5–2.5 s); without a bound a
        // cold inner invocation could hold this one open to the platform
        // ceiling. See the constant for why 10 s and not the supplier's 5 s.
        signal: AbortSignal.timeout(WEBHOOK_SELF_CALL_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      // The bound expiring is the same fact as a dead socket — *no answer* —
      // so it maps to the same outcome, not a new one. `fetch` rejects with
      // the signal's reason: a `DOMException` named `TimeoutError` when
      // `AbortSignal.timeout` fired, `AbortError` for any other abort. Named
      // in the detail so the log line says "no answer within 10000 ms" rather
      // than "could not reach", which would read as a refused connection.
      const isAborted =
        error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

      throw this.deliveryFailed(
        payload,
        WebhookDeliveryFailure.Unreachable,
        isAborted
          ? `no answer from ${this.webhookUrl.href} within ${String(WEBHOOK_SELF_CALL_TIMEOUT_MS)} ms`
          : `could not reach ${this.webhookUrl.href}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      // Read the body for the log line, not to act on: a non-2xx answer is
      // definite whatever it says.
      const detail = await response.text().catch(() => "<unreadable body>");

      throw this.deliveryFailed(
        payload,
        WebhookDeliveryFailure.Rejected,
        `webhook answered ${String(response.status)}: ${detail}`,
      );
    }

    const body: unknown = await response.json().catch(() => undefined);

    // The response crossed HTTP, so it has been parsed, not verified — the same
    // stance `parsePaymentWebhookPayload` takes about the request. A `200` whose
    // body is not an ack is not a delivery this class can report on, and
    // guessing `stored` would be inventing the one fact the caller asked for.
    if (
      typeof body !== "object" ||
      body === null ||
      !("outcome" in body) ||
      !isPaymentWebhookAckOutcome(body.outcome)
    ) {
      throw this.deliveryFailed(
        payload,
        WebhookDeliveryFailure.Unreachable,
        "webhook answered 2xx with a body that is not an acknowledgement",
      );
    }

    return body.outcome;
  }

  /**
   * Log the failed delivery with both correlation ids and build the error to
   * throw. One place, so a delivery failure can never be raised without the log
   * line that makes it findable (`architecture.md` §8).
   */
  private deliveryFailed(
    payload: PaymentWebhookPayload,
    failure: WebhookDeliveryFailure,
    detail: string,
  ): PaymentWebhookDeliveryError {
    this.logger.error({
      msg: "payment simulator: could not deliver the event to the webhook",
      event_id: payload.event_id,
      order_id: payload.order_id,
      failure,
      detail,
    });

    return new PaymentWebhookDeliveryError(detail, failure, payload.event_id, payload.order_id);
  }
}
