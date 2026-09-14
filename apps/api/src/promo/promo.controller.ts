/**
 * `POST /api/orders/:orderId/promo` — apply a promo code to an order that is
 * awaiting payment (spec 005 functional spec §2.2–2.5, technical-considerations
 * §2.3).
 *
 * Paired with `./promo-redemption.service.ts` the way
 * `../admin/order-recovery.controller.ts` is paired with its services: the
 * controller owns the route, the body parser, the status codes and the log
 * line, and issues no SQL of its own. The transaction, its ordering argument
 * and the emitted statements live in the service.
 *
 * ---------------------------------------------------------------------------
 * THE VIEW IS READ **AFTER COMMIT** — R3
 * ---------------------------------------------------------------------------
 * The handler is two calls: `apply`, which runs the transaction to `COMMIT`
 * and returns an outcome, and then `findOrder`, which reads the order back on
 * the pooled handle. The order of those two is not a convenience. `packages/db`
 * pins the pool to `max: 1` per instance and a transaction holds that one
 * connection for its whole body, so a read of the view *inside* `apply` would
 * wait for a connection the transaction itself is holding — a self-deadlock
 * that ends at `CONNECTION_TIMEOUT_MS` (ten seconds) with an error that names
 * the pool rather than the cause. `OrderViewService.findOrder` takes no `tx`
 * by design, which is what makes the mistake fail to compile rather than fail
 * in production; this controller is where the two halves meet in the right
 * order.
 *
 * Two consequences, both intended: the body the shopper receives is the
 * **committed** view, which every other process can also see; and the
 * transaction stays short, with the order row lock held for its statements
 * and not for a round trip more.
 *
 * ---------------------------------------------------------------------------
 * `200` FOR BOTH SUCCESSES, AND THE SAME BODY `GET /api/orders/:id` SENDS
 * ---------------------------------------------------------------------------
 * `@HttpCode(200)` rather than `@Post`'s default `201`: nothing is created at a
 * new URL. The answer is the order that already existed, repriced, and the
 * same code applied to the same order a second time answers `200` with the
 * *identical* body — `already_applied` writes nothing and reads the same row.
 * That is the idempotency the page relies on (a double-click, a retry after a
 * lost response) and it is decided under the order lock in the service, not
 * here.
 *
 * The success body is the bare {@link OrderView}: one shape for "here is your
 * order", whichever endpoint said it, and `apps/web` already parses it.
 *
 * ---------------------------------------------------------------------------
 * REFUSALS ARE `{ reason }`; `400` AND `404` ARE NEST'S DEFAULT
 * ---------------------------------------------------------------------------
 * | Case                                   | Status | Body                       |
 * | -------------------------------------- | ------ | -------------------------- |
 * | applied                                | `200`  | `OrderView`                |
 * | same code on the same order again      | `200`  | the identical `OrderView`  |
 * | body not `{ code: string }`, or empty  | `400`  | Nest default               |
 * | no such order                          | `404`  | Nest default               |
 * | not one of the codes on file           | `422`  | `{ "reason": "unknown_code" }` |
 * | counter at `max_uses`                  | `409`  | `{ "reason": "exhausted" }` |
 * | order not `created`                    | `409`  | `{ "reason": "not_awaiting_payment" }` |
 * | a different code already on the order  | `409`  | `{ "reason": "another_code_applied" }` |
 * | invariant violated under the lock      | `500`  | Nest default; rolled back  |
 *
 * `./promo.types.ts` argues the digits and the field name. The `400` and the
 * `404` keep Nest's envelope because both are the same news `POST /api/orders`
 * and `GET /api/orders/:id` already send in that envelope — a body the
 * server could not read, and a target that does not exist — and neither is
 * about the code.
 */
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";

import { FindOrderOutcome, OrderViewService } from "../orders/order-view.service.js";
import type { OrderView } from "../orders/orders.types.js";
import { normalisePromoCode } from "./promo-code.js";
import {
  PromoRedemptionInvariantError,
  PromoRedemptionService,
} from "./promo-redemption.service.js";
import {
  PromoRedemptionOutcome,
  promoRefusal,
  type ApplyPromoRequest,
  type PromoRedemptionResult,
} from "./promo.types.js";

/** `null`-safe object test — `typeof null` is `"object"`, and a body may be `null`. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the request body — `{ code: string }`, and **only** `code` is read.
 *
 * Three refusals, all `400`, all before the transaction opens:
 *
 *   - not a JSON object with a `code` field;
 *   - `code` not a string;
 *   - `code` **empty after trimming** — `normalisePromoCode` returns `null`
 *     and the request named no code at all. §2.2: *"empty after trim is a
 *     `400`, not a lookup"*; `unknown_code` (`422`) would be the wrong
 *     sentence for a code that was never given.
 *
 * `code` is returned **as sent**, not normalised: the service owns the
 * normalisation and does it once, so there is exactly one place the stored
 * form is produced (`./promo-code.ts`). The call here is the emptiness test
 * and nothing else.
 *
 * Extra fields are ignored, not rejected — `OrdersController`'s stance, stated
 * on {@link ApplyPromoRequest}. Hand-written rather than `class-validator` +
 * `ValidationPipe`, as every parser in this API is: one required string, and
 * `packages/contracts` stays free of validation frameworks.
 */
function parseApplyPromoRequest(body: unknown): ApplyPromoRequest {
  if (!isJsonObject(body) || !("code" in body)) {
    throw new BadRequestException('expected a JSON body of the form { "code": string }');
  }

  const { code } = body;

  if (typeof code !== "string") {
    throw new BadRequestException('"code" must be a string');
  }

  if (normalisePromoCode(code) === null) {
    throw new BadRequestException('"code" must not be empty');
  }

  return { code };
}

/** Exhaustiveness guard: the compiler routes here only if an outcome went unhandled. */
function assertNever(value: never): never {
  throw new Error(`promo controller: unhandled value ${JSON.stringify(value)}`);
}

/**
 * The `promo_id` for the log line — the members that reached a `promo_codes`
 * row carry one; the others were decided before the code was looked up and
 * log `null` rather than a guess.
 */
function promoIdOf(result: PromoRedemptionResult): number | null {
  return "promoId" in result ? result.promoId : null;
}

@Controller("api/orders")
export class PromoController {
  private readonly logger = new Logger(PromoController.name);

  constructor(
    private readonly redemptions: PromoRedemptionService,
    /**
     * The read behind the `200` body — `OrdersModule`'s exported reader, on
     * the pooled handle, called only after `apply` has returned. See the
     * file header for why the order of the two calls is load-bearing.
     */
    private readonly views: OrderViewService,
  ) {}

  /**
   * Apply `{ code }` to `orderId`, and answer with the order as it now stands.
   *
   * ###########################################################################
   * # EVERY REFUSAL HERE IS A VALUE THE TRANSACTION RETURNED. NONE IS AN `if`
   * # ON A STATUS THIS METHOD READ.
   * ###########################################################################
   *
   * The handler reads nothing before calling `apply`. `409 exhausted` is zero
   * rows from `UPDATE promo_codes … WHERE used_count < max_uses`, evaluated by
   * Postgres against the committed row; `409 not_awaiting_payment` is the
   * status read under the order lock; `409 another_code_applied` and
   * `200 already_applied` are the ledger row read under that same lock. A
   * `switch (order.status)` here, one statement earlier, would answer from a
   * value that was true when it was read rather than when it was written —
   * the check-then-act `architecture.md` §3's governing principle forbids.
   *
   * The one thing this method does read is the view, and it reads it *after*
   * the transaction has committed (the file header).
   *
   * ### The `500` path
   *
   * {@link PromoRedemptionInvariantError} is the service's one throw: a
   * statement that cannot match zero rows under the lock matched zero rows.
   * It is caught here for one purpose — to log the ids beside the `500` —
   * and rethrown unchanged, so Nest answers its default `500` and the
   * transaction's `ROLLBACK` has already undone the counter increment. Any
   * other error passes straight through; this handler has no opinion about
   * errors it did not expect.
   *
   * ### The log line
   *
   * One per request, whatever the outcome (§2.3, "Logging"): `order_id`,
   * `promo_code` (normalised), `promo_id`, `outcome`, `status_code`,
   * `duration_ms`. `log` for the two successes and for the four refusals —
   * a refusal is ordinary traffic, and an exhausted code under a race is the
   * system working — `warn` for the `404`, `error` for the `500`.
   */
  @Post(":orderId/promo")
  // **`200`, not Nest's `@Post` default of `201`.** Nothing is created at a
  // new URL: the answer is the order that already existed, repriced, and the
  // same code a second time is the identical body. See the file header.
  @HttpCode(HttpStatus.OK)
  async applyPromo(@Param("orderId") orderId: string, @Body() body: unknown): Promise<OrderView> {
    const startedAt = Date.now();
    const { code } = parseApplyPromoRequest(body);

    let result: PromoRedemptionResult;

    try {
      // ####################################################################
      // # THE TRANSACTION. Returns after COMMIT (or throws after ROLLBACK).
      // ####################################################################
      result = await this.redemptions.apply(orderId, code);
    } catch (error: unknown) {
      if (error instanceof PromoRedemptionInvariantError) {
        this.logger.error({
          msg: "promo: invariant violated under the order lock; the transaction was rolled back",
          order_id: error.orderId,
          promo_code: error.code,
          promo_id: error.promoId,
          step: error.step,
          outcome: "invariant_violated",
          status_code: HttpStatus.INTERNAL_SERVER_ERROR,
          duration_ms: Date.now() - startedAt,
          detail: error.message,
        });
      }

      throw error;
    }

    switch (result.outcome) {
      case PromoRedemptionOutcome.Applied:
      case PromoRedemptionOutcome.AlreadyApplied: {
        // ##################################################################
        // # AFTER COMMIT. `apply` has returned, so the transaction — and the
        // # instance's one connection — has been released. This read runs
        // # on the pooled handle and would self-deadlock one line earlier.
        // ##################################################################
        const found = await this.views.findOrder(orderId);

        if (found.outcome === FindOrderOutcome.NotFound) {
          // The order was locked and repriced a moment ago, and nothing in
          // this system deletes an order. There is no honest body to send in
          // its place, so this is a `500` with the id in it.
          throw new Error(
            `promo: order ${orderId} was locked and repriced under its lock and then could not be read back`,
          );
        }

        this.logger.log({
          msg:
            result.outcome === PromoRedemptionOutcome.Applied
              ? "promo: applied — one use taken (I7), the ledger row written (I8), the order repriced"
              : "promo: already applied — the same code was on the order; nothing written",
          order_id: result.orderId,
          promo_code: result.code,
          promo_id: result.promoId,
          outcome: result.outcome,
          ...(result.outcome === PromoRedemptionOutcome.Applied
            ? { used_count: result.usedCount, max_uses: result.maxUses }
            : {}),
          amount_minor: found.order.amount_minor,
          status_code: HttpStatus.OK,
          duration_ms: Date.now() - startedAt,
        });

        return found.order;
      }

      case PromoRedemptionOutcome.OrderNotFound:
        this.logger.warn({
          msg: "promo refused: no such order",
          order_id: result.orderId,
          promo_code: result.code,
          promo_id: null,
          outcome: result.outcome,
          status_code: HttpStatus.NOT_FOUND,
          duration_ms: Date.now() - startedAt,
        });

        throw new NotFoundException(`no order with id "${result.orderId}"`);

      case PromoRedemptionOutcome.NotAwaitingPayment:
      case PromoRedemptionOutcome.UnknownCode:
      case PromoRedemptionOutcome.AnotherCodeApplied:
      case PromoRedemptionOutcome.Exhausted: {
        // Status and body from one function, so the number logged below and
        // the number on the wire are the same value (`./promo.types.ts`).
        const refusal = promoRefusal(result.outcome);

        // `log`, not `warn`: every one of these is ordinary traffic. An
        // exhausted code under twenty simultaneous shoppers is the limit
        // holding, which is the point of the phase.
        this.logger.log({
          msg: "promo refused: the transaction decided against it before either write; nothing written",
          order_id: result.orderId,
          promo_code: result.code,
          promo_id: promoIdOf(result),
          outcome: result.outcome,
          ...(result.outcome === PromoRedemptionOutcome.NotAwaitingPayment
            ? { observed_status: result.observedStatus }
            : {}),
          ...(result.outcome === PromoRedemptionOutcome.AnotherCodeApplied
            ? { applied_promo_code: result.appliedCode, applied_promo_id: result.appliedPromoId }
            : {}),
          ...(result.outcome === PromoRedemptionOutcome.Exhausted ? { max_uses: result.maxUses } : {}),
          status_code: refusal.status,
          duration_ms: Date.now() - startedAt,
        });

        // The body is passed as an object, which Nest serialises verbatim —
        // `{ reason }` and nothing else. A string would be wrapped in the
        // default envelope and put the reason under `message`.
        throw new HttpException(refusal.body, refusal.status);
      }

      default:
        return assertNever(result);
    }
  }
}
