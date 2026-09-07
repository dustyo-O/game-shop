/**
 * `POST /api/payments/:orderId/simulate` — the payment provider, on demand
 * (technical-considerations §2.3, functional spec §2.3).
 *
 * ---------------------------------------------------------------------------
 * THE SAME ENDPOINT SERVES THE SHOPPER AND THE RACE SCRIPTS
 * ---------------------------------------------------------------------------
 * Payment is simulated in this product — *"the shopper chooses the outcome
 * rather than entering card details"* (functional spec §2.3) — so the order
 * page's «Оплатить успешно» and «Оплата не прошла» controls both land here. So
 * does every Phase 2 race script, which is why §2.3 calls this *"the same
 * mechanism the Phase 2 race scripts drive"*.
 *
 * That shared use is what makes the endpoint's shape matter more than a test
 * affordance's usually would. Two consequences run through it:
 *
 *   - **Every call mints a new `event_id` unless one is pinned.** A simulator
 *     that reused an id would exercise the duplicate path while looking like it
 *     exercised the first, and the scripts asserting "exactly one `stored`"
 *     would pass without proving anything (`./payment-simulator.types.ts`).
 *   - **The event reaches the webhook over HTTP**, so a script driving this
 *     endpoint is driving the same boundary a real provider would
 *     (`./payment-simulator.service.ts`).
 *
 * The controller itself does what the others do and nothing more: turn an
 * unvalidated JSON body into an instruction, and turn a service result into an
 * HTTP status. `/api` is on the controller, as every other controller carries
 * it; there is deliberately no `setGlobalPrefix("api")` because the supplier A
 * stub answers outside it.
 */
import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";

import {
  PaymentSimulatorService,
  PaymentWebhookDeliveryError,
  SimulatePaymentOutcome,
  type SimulatePaymentResult,
} from "./payment-simulator.service.js";
import {
  SimulatedPaymentOutcome,
  type SimulatedPaymentAck,
  type SimulatePaymentRequest,
} from "./payment-simulator.types.js";

/** `null`-safe object test — `typeof null` is `"object"`, and a body may be `null`. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrow an unvalidated value to a {@link SimulatedPaymentOutcome}. */
function isSimulatedPaymentOutcome(value: unknown): value is SimulatedPaymentOutcome {
  return value === SimulatedPaymentOutcome.Success || value === SimulatedPaymentOutcome.Failure;
}

/**
 * Parse the request body — `{ outcome, event_id? }`.
 *
 * ---------------------------------------------------------------------------
 * `outcome` IS NARROWED HERE, UNLIKE THE WEBHOOK'S `status`
 * ---------------------------------------------------------------------------
 * `parsePaymentWebhookPayload` deliberately stores a status it does not
 * recognise rather than rejecting it, because the sender is a real payment
 * provider reporting something that happened to real money and destroying that
 * evidence is worse than not understanding it.
 *
 * Nothing of the kind is true here. The sender is our own order page or a
 * script; `{ "outcome": "succes" }` is a typo, no money has moved, and there is
 * nothing to preserve. Rejecting it with a `400` is both the honest answer and
 * the one that surfaces the typo immediately instead of emitting an event whose
 * status the shop will silently ignore two hops later.
 *
 * Hand-written rather than `class-validator` + a `ValidationPipe`, as
 * `OrdersController` and the webhook are: two fields, one required, and
 * `packages/contracts` stays free of validation frameworks because `apps/web`
 * bundles it into a browser.
 */
function parseSimulatePaymentRequest(body: unknown): SimulatePaymentRequest {
  if (!isJsonObject(body)) {
    throw new BadRequestException(
      'expected a JSON body of the form { "outcome": "success" | "failure" }',
    );
  }

  const { outcome } = body;

  if (!isSimulatedPaymentOutcome(outcome)) {
    throw new BadRequestException('"outcome" must be "success" or "failure"');
  }

  const eventId = body["event_id"];

  // Absent is the normal case: the simulator mints a fresh id, which is what
  // makes a duplicate something a caller has to ask for rather than something
  // that happens by accident. Present must be usable as a primary key — an
  // empty string is as absent as missing, and silently treating it as "mint one"
  // would turn a broken replay into a new payment.
  if (eventId !== undefined && (typeof eventId !== "string" || eventId === "")) {
    throw new BadRequestException(
      '"event_id", when given, must be a non-empty string naming the event to redeliver',
    );
  }

  return eventId === undefined ? { outcome } : { outcome, event_id: eventId };
}

/** Exhaustiveness guard: the compiler routes here only if an outcome went unhandled. */
function assertNever(value: never): never {
  throw new Error(`payments: unhandled simulator outcome ${JSON.stringify(value)}`);
}

@Controller("api/payments")
export class PaymentSimulatorController {
  constructor(private readonly simulator: PaymentSimulatorService) {}

  /**
   * Emit a payment event for this order and deliver it to the webhook.
   *
   * **`200`, not Nest's default `201` for `@Post`.** Nothing addressable is
   * created *by this request*: the resource that comes into existence is a
   * `payment_events` row, created by the webhook one hop away, and there is no
   * URL at which a client could go and fetch it. `200` with the acknowledgement
   * is the honest answer — and it is the same code the webhook itself returns,
   * for the same reason.
   *
   * ### The three failures, and why each has the code it has
   *
   *   - **`400`** — the body is not an instruction this endpoint can carry out.
   *     See {@link parseSimulatePaymentRequest}.
   *   - **`404`** — no order with that id. `/api/payments/{orderId}/simulate`
   *     names a specific order, so an id that identifies nothing is exactly what
   *     `404` means, and it matches `GET /api/orders/:id`. Note that the webhook
   *     one hop away deliberately *accepts* events for orders that do not exist;
   *     {@link PaymentSimulatorService.simulate} explains at length why the two
   *     answers differ, and it comes down to this endpoint having to price the
   *     event from a row that is not there.
   *   - **`502`** — the event could not be delivered. A gateway code because
   *     that is precisely the role this endpoint is playing: it took the
   *     caller's instruction and failed to get an answer from the service
   *     downstream of it. The body distinguishes a definite refusal from an
   *     unknown outcome, because the two are different facts
   *     (`architecture.md` §8).
   *
   * A `502` is never the *shop's* verdict on a payment. It means the simulated
   * provider could not hand the event over, so the order has not moved and the
   * caller may try again — which is safe precisely because a retry that pins no
   * `event_id` is a new event, and one that pins the old one is absorbed as a
   * duplicate (I2).
   */
  @Post(":orderId/simulate")
  @HttpCode(HttpStatus.OK)
  async simulate(
    @Param("orderId") orderId: string,
    @Body() body: unknown,
  ): Promise<SimulatedPaymentAck> {
    const request = parseSimulatePaymentRequest(body);

    let result: SimulatePaymentResult;

    try {
      result = await this.simulator.simulate(orderId, request);
    } catch (error: unknown) {
      if (error instanceof PaymentWebhookDeliveryError) {
        // Already logged with both correlation ids where it was raised. The
        // failure kind is on the wire because "we know it was refused" and "we
        // do not know whether it landed" call for different next moves.
        throw new BadGatewayException(
          `could not deliver payment event ${error.eventId} to the webhook (${error.failure}): ${error.message}`,
        );
      }

      throw error;
    }

    switch (result.outcome) {
      case SimulatePaymentOutcome.Delivered:
        return result.ack;

      case SimulatePaymentOutcome.OrderNotFound:
        throw new NotFoundException(`no order with id "${result.orderId}"`);

      default:
        return assertNever(result);
    }
  }
}
