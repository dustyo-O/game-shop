/**
 * `POST /api/webhooks/payment` — the payment provider's event arrives here
 * (technical-considerations §2.3 and §2.5 step 1).
 *
 * ---------------------------------------------------------------------------
 * THE FIRST THING THIS ENDPOINT DOES IS MAKE THE EVENT DURABLE
 * ---------------------------------------------------------------------------
 * receive → persist → acknowledge → process (`architecture.md` §4). This
 * controller parses the body far enough to write a row, hands it to
 * {@link PaymentEventsService}, and — **only once the row is committed** —
 * hands the stored row to {@link PaymentEventProcessor}, which applies it to its
 * order and settles it.
 *
 * The ordering is the pattern, and it is not negotiable: nothing is decided
 * before the row exists, so a crash between the two steps loses no event.
 *
 * ### The fourth step is scheduled, not awaited
 *
 * `architecture.md` §4 lists four processing triggers — a continuation after
 * the response is sent, a drain on order creation, a drain on the status poll,
 * and an admin sweep — layered so that no single one is load-bearing. This
 * endpoint owns the first: it hands the committed row to the
 * {@link ContinuationScheduler} and returns, so the `200` reaches the provider
 * while the issuance is still running. That is functional spec §2.4's first
 * criterion in one sentence — the shop "confirms receipt promptly and completes
 * the order as separate work rather than making the payment service wait for
 * it" — and technical-considerations §2.2's "the webhook persists the event,
 * answers `200`, and schedules processing. It no longer awaits the work."
 *
 * **This call site moved and nothing else did.** `PaymentEventProcessor` is
 * written against a stored row rather than a request body precisely so that it
 * does not care who calls it: this continuation today, a
 * `FOR UPDATE SKIP LOCKED` drain tomorrow.
 *
 * ### What the continuation is *not*
 *
 * It is not a guarantee, and nothing here is written as though it were. A
 * `SIGTERM` can abandon it (bounded and logged —
 * `../scheduling/tracked-continuation-scheduler.ts`), and the deployment
 * implementation promises no more than best effort. The cost of losing one is
 * latency and never a key: the row is still in `payment_events` with
 * `processed_at` NULL, which is not an error state but the queue, and the other
 * three triggers find exactly that row.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE STATUS CODE MEANS TO A PAYMENT PROVIDER
 * ---------------------------------------------------------------------------
 * A provider retries on `5xx`. That is the whole reason this shape exists, and
 * it makes the status code an instruction rather than a report:
 *
 *   - **`5xx` = "send it again."** Reserved for exactly one situation: we could
 *     not write the event to the inbox. Nothing else in this file can produce
 *     one, and the one path that can (a database failure inside
 *     `recordEvent`) is left to propagate on purpose.
 *   - **`200` = "we have it; stop."** First sight, redelivery, an event for an
 *     order that does not exist yet, an event naming a status we do not
 *     recognise, **and a failure while processing an event we have already
 *     stored** — every one of those was handled correctly or is beyond the
 *     provider's power to fix, and neither may ask for a retry. Turning a
 *     duplicate we correctly ignored into a `500` is how you ask for the
 *     duplicate again (`docs/walkthrough/slice-2-order-lifecycle.md` §4).
 *
 *     The last of those used to be a decision this file made, in a `try/catch`
 *     around the inline processing. It is now **structural**: the processing
 *     runs after the response has been sent, so there is no longer a status
 *     code for it to influence even in principle. The reasoning did not move —
 *     it lives in `guardContinuation`, which swallows and logs at `error` with
 *     the same two correlation ids and the same argument
 *     (`../scheduling/continuation-scheduler.ts`). Two layers doing that job
 *     would mean two log lines for one failure and a reader guessing which one
 *     owns the rule, so this file no longer has one.
 *   - **`400` = "sending it again will not help."** A body that cannot become a
 *     row — see {@link parsePaymentWebhookPayload}. Not a `5xx`, because the
 *     identical bytes would fail identically on every retry; a client error is
 *     the honest answer and it stops the loop instead of starting one.
 *
 * `/api` is on the controller, as `OrdersController` and `CatalogController`
 * carry it; there is deliberately no `setGlobalPrefix("api")` because the
 * supplier A stub answers outside it at `POST /internal/suppliers/a/issue`.
 */
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
} from "@nestjs/common";

import { majorToMinor, majorUnits } from "@game-shop/contracts";

import {
  CONTINUATION_SCHEDULER,
  type ContinuationScheduler,
} from "../scheduling/continuation-scheduler.js";
import { PaymentEventProcessor } from "./payment-event-processor.service.js";
import { PaymentEventsService, RecordPaymentEventOutcome } from "./payment-events.service.js";
import {
  PaymentWebhookAckOutcome,
  type PaymentWebhookAck,
  type StorablePaymentEvent,
} from "./payment-webhook.types.js";

/**
 * The bounds of a Postgres `integer`, which is what `payment_events.amount_minor`
 * is. Named here because they are the reason the amount check exists at all —
 * see {@link parsePaymentWebhookPayload}.
 */
const MIN_INT4 = -2_147_483_648;
const MAX_INT4 = 2_147_483_647;

/** `null`-safe object test — `typeof null` is `"object"`, and a body may be `null`. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A field that has to become a NOT NULL `text` column. Empty is as absent as missing. */
function readNonEmptyString(body: Record<string, unknown>, field: string): string {
  const value = body[field];

  if (typeof value !== "string" || value === "") {
    throw new BadRequestException(`"${field}" must be a non-empty string`);
  }

  return value;
}

/**
 * Parse the body far enough to write a `payment_events` row — **and no
 * further**.
 *
 * ---------------------------------------------------------------------------
 * THE ONLY QUESTION ASKED HERE IS "CAN THIS BE STORED?"
 * ---------------------------------------------------------------------------
 * Not "is this a well-formed payment event?", and certainly not "do I agree with
 * it?". The five checks below are each traceable to a NOT NULL column that has
 * to hold a value, and there is not one check that is not:
 *
 *   | Check                          | The column it exists for            |
 *   | ------------------------------ | ----------------------------------- |
 *   | `event_id` non-empty string    | `event_id` — the PRIMARY KEY        |
 *   | `order_id` non-empty string    | `order_id` NOT NULL                 |
 *   | `status` non-empty string      | `status` NOT NULL                   |
 *   | `currency` non-empty string    | `currency` NOT NULL                 |
 *   | `amount` a number in int4      | `amount_minor` NOT NULL, `integer`  |
 *
 * Everything a stricter validator would also check is deliberately *not*
 * checked, because the answer to each is "store it and let the processing step
 * decide":
 *
 *   - **`status` is not narrowed to `paid` | `failed`.** An unrecognised status
 *     is persisted verbatim and then ignored by the transition rules —
 *     `payment_events.status` carries no CHECK constraint for exactly this
 *     reason, and `isPaymentEventStatus` runs one step later, where "I do not
 *     recognise this" has a safe answer instead of a destructive one
 *     (`packages/contracts/src/payment-webhook.ts`).
 *   - **`currency` is not narrowed to `RUB`.** Same argument. An event in the
 *     wrong currency is a reconciliation problem, and reconciliation needs the
 *     event.
 *   - **`order_id` is not checked against `orders`.** It must not be: the
 *     column has no foreign key so that an event arriving before its order is a
 *     normal path, stored with `processed_at` NULL and drained later
 *     (`architecture.md` §4, "Out-of-order tolerance"). A lookup here would
 *     re-introduce, in application code, the rejection the schema deliberately
 *     omits — and it would be a read before the insert besides.
 *   - **`created_at` is not required.** No column holds it; it rides along in
 *     `payload`. A body missing it is still a storable event, and inventing a
 *     rule the inbox does not need is how a webhook endpoint starts rejecting
 *     traffic it could have kept.
 *   - **The amount is not compared to the order's.** That is settlement, it
 *     needs a row from `orders`, and it belongs to processing. The provider's
 *     figure is a claim to reconcile, never an authority
 *     (`packages/contracts/src/money.ts`).
 *
 * ### Why the amount is range-checked when nothing else is
 *
 * This is not validation sneaking back in — it is the storability rule applied
 * honestly. `amount_minor` is a Postgres `integer`, so `NaN`, `Infinity` or
 * `999_999_999_999` would make the INSERT itself raise, and an INSERT that
 * raises is a `500`, and a `500` asks a provider to send the same unstorable
 * body again on a backoff schedule. Answering `400` immediately is both truthful
 * and the only answer that ends the loop. Negative amounts *are* accepted: the
 * column has no CHECK (unlike `orders.amount_minor`), a refund-shaped event is
 * evidence worth keeping, and it is processing's business what it means.
 *
 * Hand-written rather than `class-validator` + a `ValidationPipe`, as
 * `OrdersController` is: `packages/contracts` is deliberately free of validation
 * frameworks because `apps/web` bundles it into a browser, and a decorator stack
 * here would describe a *shape* when what this function actually enforces is a
 * *storage* rule.
 *
 * A body that is not JSON at all never reaches this function — Express's JSON
 * parser rejects it first, and Nest turns that into a `400` too, which is the
 * same answer for the same reason.
 */
function parsePaymentWebhookPayload(body: unknown): StorablePaymentEvent {
  if (!isJsonObject(body)) {
    throw new BadRequestException("expected a JSON object body per the payment webhook contract");
  }

  const eventId = readNonEmptyString(body, "event_id");
  const orderId = readNonEmptyString(body, "order_id");
  const status = readNonEmptyString(body, "status");
  const currency = readNonEmptyString(body, "currency");

  const amount = body["amount"];

  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    throw new BadRequestException('"amount" must be a finite number of whole roubles');
  }

  // ####################################################################
  // # THE WIRE IS ROUBLES; THE COLUMN IS KOPECKS. 500 HERE IS 50000 THERE.
  // ####################################################################
  //
  // Converted through the branded helper rather than by an inline `* 100`, so
  // the crossing is greppable and the compiler is the thing that knows which
  // scale this number is on (`packages/contracts/src/money.ts`). `majorUnits`
  // is the assertion that the parsed JSON number is on the wire's scale;
  // `majorToMinor` is the crossing itself.
  const amountMinor = majorToMinor(majorUnits(amount));

  if (amountMinor < MIN_INT4 || amountMinor > MAX_INT4) {
    throw new BadRequestException('"amount" is outside the range this shop can record');
  }

  return {
    eventId,
    orderId,
    status,
    amountMinor,
    currency,
    // The body as it arrived, not the five fields above put back together.
    payload: body,
  };
}

/** Exhaustiveness guard: the compiler routes here only if an outcome went unhandled. */
function assertNever(value: never): never {
  throw new Error(`payments: unhandled service outcome ${JSON.stringify(value)}`);
}

@Controller("api/webhooks/payment")
export class PaymentWebhookController {
  constructor(
    private readonly paymentEvents: PaymentEventsService,
    private readonly processor: PaymentEventProcessor,
    // Injected by symbol because the scheduler is an interface, not a class —
    // there is no constructor to name, and which implementation arrives is an
    // environment decision made in `../scheduling/scheduling.module.ts`. This
    // controller cannot tell the two apart and must not try to.
    //
    // There is deliberately no `logger` field any more: the only thing this
    // class used to log was a failure inside the processing it awaited, and
    // that logging now belongs to `guardContinuation`.
    @Inject(CONTINUATION_SCHEDULER)
    private readonly continuations: ContinuationScheduler,
  ) {}

  /**
   * Store the event, schedule the work, and acknowledge — in that order.
   *
   * **`200`, not Nest's default `201` for `@Post`.** Technical-considerations
   * §2.3 specifies `200`, and it is the right code on its own terms: the
   * provider is not creating a resource it will go on to address — it is
   * delivering a notification, and `200` is the answer that says "received,
   * we're done here".
   *
   * Both service outcomes land on that same `200`, which is the point of the
   * whole design and the one sentence worth remembering from it: **a duplicate
   * we correctly ignored is a success.** The two differ only in the body, and
   * only for the benefit of a human or a race script reading the response.
   *
   * The two `await`s that remain are the two the provider is genuinely owed:
   * parsing the body, and committing the row. Everything after the commit is
   * scheduled, so the only work that can delay this response is work whose
   * failure the provider could actually do something about — which is exactly
   * the set of failures the status-code rule in this file's header hands back
   * as a `5xx`.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  async receiveEvent(@Body() body: unknown): Promise<PaymentWebhookAck> {
    const event = parsePaymentWebhookPayload(body);

    const result = await this.paymentEvents.recordEvent(event);

    switch (result.outcome) {
      case RecordPaymentEventOutcome.Stored:
        // The row is committed. Exactly one caller per `event_id` ever reaches
        // this line (I2), and it is the one that owns applying the event.
        //
        // ################################################################
        // # NO `await`. THE `return` BELOW RACES THE WORK, AND WINS.
        // ################################################################
        //
        // A thunk rather than a started promise, because a promise handed over
        // already running can reject in the window before the scheduler
        // attaches its `catch` — and an unhandled rejection terminates the
        // process in Node 22. `schedule` returns `void` for a matching reason:
        // there is nothing to `await`, so the inline processing this replaces
        // cannot come back by accident.
        //
        // `processStoredEvent` resolves to a `ProcessPaymentEventResult`, which
        // nobody is left to read — the response has gone. `.then(() =>
        // undefined)` discards it to meet `() => Promise<void>`; the outcome is
        // already on the processor's own log lines.
        this.continuations.schedule(
          () => this.processor.processStoredEvent(result.event).then(() => undefined),
          {
            name: "payment webhook continuation",
            orderId: result.event.orderId,
            eventId: result.event.eventId,
          },
        );

        return { event_id: result.event.eventId, outcome: PaymentWebhookAckOutcome.Stored };

      case RecordPaymentEventOutcome.AlreadySeen:
        // A redelivery processes nothing, on purpose. Either the first-sight
        // call already applied the event, or it did not and the row is still
        // pending — in which case the *drain* is what picks it up, not a second
        // copy of the same webhook. Processing here instead would mean every
        // retry re-entered the apply path, which is the re-run of issuance that
        // I2 exists to prevent.
        return { event_id: result.eventId, outcome: PaymentWebhookAckOutcome.Duplicate };

      default:
        return assertNever(result);
    }
  }
}
