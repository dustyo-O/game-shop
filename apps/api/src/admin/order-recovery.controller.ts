/**
 * The operator's two routes (spec 003 functional spec §2.4 and §2.5,
 * technical-considerations §8):
 *
 *   - `GET  /api/admin/orders/undelivered` — **every order that was paid for and
 *     is holding no key**;
 *   - `POST /api/admin/orders/:orderId/retry` — **push one of them back through
 *     issuance**, and say what came of it.
 *
 * Paired with `./undelivered-orders.service.ts` and `./order-retry.service.ts`
 * the way `./payment-event-sweep.controller.ts` is paired with
 * `PaymentEventDrainService`: the controller owns the routes, the guard, the
 * status codes and the log lines, and issues no SQL of its own. The list's
 * statement, its three silent traps and the literals-versus-`= ANY($1)`
 * argument live in the first service; the retry's one call into issuance and
 * the reason there is nothing else in it live in the second.
 *
 * ---------------------------------------------------------------------------
 * WHY `GET` HERE, WHEN THE SWEEP BESIDE IT ARGUES FOR `POST`
 * ---------------------------------------------------------------------------
 * The sweep is `POST` because it moves orders, calls suppliers and binds keys,
 * and a `GET` that issued a key would be reachable by a crawler, a prefetch, a
 * link preview or a browser restoring a tab. **The retry below is `POST` for
 * exactly that reason** — it does all three of those things — with
 * `@HttpCode(200)` because nothing is created: the answer is a report about an
 * order that already existed, at no new URL.
 *
 * This one changes nothing. It is a read, it is safe and idempotent in RFC 9110's
 * sense, and every one of those accidental callers doing it twice costs the shop
 * two `SELECT`s. `GET` is the honest verb, and it is also what makes the screen
 * refreshable by the browser's own reload.
 *
 * ---------------------------------------------------------------------------
 * THE GUARD IS THE WHOLE OF §2.4'S LAST CRITERION, UNCHANGED
 * ---------------------------------------------------------------------------
 * {@link AdminTokenGuard} answers three ways and this endpoint adds nothing to
 * them: `503` when `ADMIN_TOKEN` is not configured (the admin surface is off on
 * this deployment, and pasting a better token cannot help), `401` when the
 * bearer token is missing **or** wrong — deliberately indistinguishable in the
 * response, distinguished only in our own logs — and otherwise the handler runs.
 *
 * The operator's page mirrors exactly that split and does opposite things with
 * the two, which is why the guard needed no change for this slice.
 *
 * **There is no client-side route guard**, on purpose: `/admin/recovery` renders
 * for anybody, and every byte of data on it comes from behind this guard. A
 * check the browser makes is a check the browser can be told to skip.
 *
 * ---------------------------------------------------------------------------
 * AND THE REPORT CARRIES NO SHOPPER'S KEY
 * ---------------------------------------------------------------------------
 * Not in this response, not in the log line below, not anywhere. The statement
 * never selects one and the wire types have nowhere to put one
 * (`./undelivered-orders.types.ts`). An operator needs to know *that* an order
 * is undelivered; they have no business reading the code the shopper bought.
 */
import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";

import { AdminTokenGuard } from "./admin-token.guard.js";
import { OrderRetryResultOutcome, OrderRetryService } from "./order-retry.service.js";
import type { OrderRetryReport } from "./order-retry.types.js";
import { UndeliveredOrdersService } from "./undelivered-orders.service.js";
import type { UndeliveredOrdersReport } from "./undelivered-orders.types.js";

/** Exhaustiveness guard: the compiler routes here only if a case went unhandled. */
function assertNever(value: never): never {
  throw new Error(`order recovery controller: unhandled value ${JSON.stringify(value)}`);
}

@Controller("api/admin/orders")
// On the controller rather than the handler, for `PaymentEventSweepController`'s
// reason: every route this class grows — slice 5's retry is the next one — is
// behind the token, and a guard that has to be remembered per method is a guard
// that will eventually be forgotten on one.
@UseGuards(AdminTokenGuard)
export class OrderRecoveryController {
  private readonly logger = new Logger(OrderRecoveryController.name);

  constructor(
    private readonly undelivered: UndeliveredOrdersService,
    private readonly retries: OrderRetryService,
  ) {}

  /**
   * Every paid order holding no key, oldest payment first, bounded at 200.
   *
   * `200` with an empty list and a `message` saying so is the **correct** answer
   * when there is nothing to recover — not a `404`, and not a bare `[]`. Zero
   * rows here is a complete answer rather than a signal that something went
   * wrong or that somebody else got there first, which makes it the one
   * zero-row case in this project that needs saying out loud.
   */
  @Get("undelivered")
  async listUndelivered(): Promise<UndeliveredOrdersReport> {
    const startedAt = Date.now();
    const report = await this.undelivered.listUndelivered();

    // Always logged, and at `log`: an operator asked a question during what is
    // probably an incident, and the answer is news whatever it is — including
    // "nothing is outstanding", which is the answer they most need timestamped.
    //
    // No `order_id` and no `request_id` on this line, and that is not an
    // exception to `architecture.md` §8: this request concerns no single order.
    // The ids that matter are in the response body, one per row, and the lines
    // that carry them are issuance's own — which is what a reader follows from
    // this summary into a specific order.
    //
    // Counts only. Never the rows: a list of 200 order ids in the log on every
    // refresh is not a record, it is a way to make the surrounding lines
    // unfindable.
    this.logger.log({
      msg: "admin undelivered-orders report served",
      count: report.count,
      truncated: report.truncated,
      duration_ms: Date.now() - startedAt,
    });

    return report;
  }

  /**
   * **Push one stuck order back through issuance**, and report what came of it
   * (§2.5, §8).
   *
   * `200` with a {@link OrderRetryReport} when the retry ran — *whatever* it
   * concluded, including `still_out_of_stock`. `409` when this order is not
   * stuck. `404` when there is no such order.
   *
   * The handler is four lines because the endpoint is four lines: the claim, the
   * lock, the ladder and the settlement are `IssuanceRunnerService`'s, unchanged
   * and unwrapped — **there is no admin-only code path into issuance**
   * (`./order-retry.service.ts`).
   *
   * ###########################################################################
   * # `409` IS ZERO ROWS FROM A GUARDED UPDATE. IT IS NOT AN `if`.
   * ###########################################################################
   *
   * Nothing on this path reads `orders.status` and decides whether to run. The
   * operator's entry names two transitions — `retryIssuance`
   * (`out_of_stock, delivery_failed → delivering`) and then `resumeIssuance`
   * (`delivering → delivering`) — and each is a status-guarded UPDATE whose
   * `WHERE … status = ANY($3)` Postgres evaluates against the row as it stands
   * at that instant. `409` is what *both of them matching zero rows* is called
   * on the wire, and it is the only way to produce one.
   *
   * A `switch (status)` one statement earlier would answer the same question
   * from a value that was true when it was read rather than when it was written
   * — the check-then-act `architecture.md` §3's governing principle exists to
   * forbid, and the exact bug this endpoint would otherwise be a fresh instance
   * of.
   *
   * **`409` and `200 still_out_of_stock` are different news** and the pair must
   * survive to the screen: one says *you were looking at a stale list, nothing
   * ran*; the other says *the retry ran correctly and the shop is still out of
   * stock* — §2.5's fifth criterion, where the operator is told why and the
   * order stays in the list.
   *
   * ###########################################################################
   * # AUTOMATIC SCHEDULED RETRYING IS A DELIBERATE OMISSION (R11).
   * ###########################################################################
   *
   * The obvious "improvement" to this endpoint is a timer — a cron entry, a
   * `setInterval` in the admin page, a queue worker that re-walks everything in
   * the recovery list every thirty seconds. **It is not an oversight that none
   * of those exists, and it must not be added without the phase that thinks it
   * through.**
   *
   * A timer aimed at a failing supplier is how a small outage becomes a large
   * one. Every stuck order retries on the same beat; each retry claims a key
   * under `FOR UPDATE SKIP LOCKED`, calls a supplier that is already
   * struggling, and — when the supplier answers by *not* answering — leaves
   * another attempt row saying `unknown`, which the next tick will probe again.
   * The shop converts one supplier's bad minute into a stampede against it, and
   * the orders that were merely stuck become orders whose outcome nobody knows.
   * Spec 003 §3 puts it out of scope in as many words, and §2.4's *"without
   * waiting for any period"* is a statement about the server never hiding an
   * order behind a grace period — not a request for the shop to press the button
   * on the operator's behalf.
   *
   * So the affordance is deliberately absent from top to bottom: **`POST` with
   * no body** (nothing to parameterise, nothing to sweep), one order id in the
   * path (no "retry all"), no `Retry-After`, no `202` with a job id to poll, and
   * a screen whose refresh is manual. A person decides that this order, now, is
   * worth another call — and a person watching a supplier fall over stops
   * pressing.
   */
  @Post(":orderId/retry")
  // **`200`, not Nest's `@Post` default of `201`.** Nothing is created: no new
  // resource, no new URL, no `Location` to send. The report describes work done
  // to an order that already existed.
  @HttpCode(HttpStatus.OK)
  async retry(@Param("orderId") orderId: string): Promise<OrderRetryReport> {
    const startedAt = Date.now();
    const result = await this.retries.retry(orderId);

    switch (result.outcome) {
      case OrderRetryResultOutcome.Ran: {
        const report = result.report;

        // `architecture.md` §8: `order_id` and `request_id` on every line in the
        // issuance path. `event_id` has no meaning here and is absent rather
        // than null — this call is not behind a payment event; a person pressed
        // a button.
        this.logger.log({
          msg: "admin retry: the order was claimed and the ladder walked",
          order_id: orderId,
          request_id: report.request_id,
          outstanding_request_id: report.outstanding_request_id,
          entry: "operator",
          outcome: report.outcome,
          provider: report.provider,
          status: report.status,
          delivered: report.delivered,
          duration_ms: Date.now() - startedAt,
        });

        return report;
      }

      case OrderRetryResultOutcome.NotStuck:
        // `log`, not `warn`: this is ordinary traffic. The operator's list was a
        // few seconds old and somebody else — another operator, or the automatic
        // drain — got there first, which is the system working.
        this.logger.log({
          msg: "admin retry refused: every guarded claim matched zero rows, so this order is not stuck",
          order_id: orderId,
          entry: "operator",
          observed_status: result.observedStatus,
          status_code: 409,
          duration_ms: Date.now() - startedAt,
        });

        throw new ConflictException(
          `order "${orderId}" is not stuck (it reads "${result.observedStatus}"), so there was nothing to retry`,
        );

      case OrderRetryResultOutcome.OrderNotFound:
        this.logger.warn({
          msg: "admin retry refused: no such order",
          order_id: orderId,
          entry: "operator",
          status_code: 404,
          duration_ms: Date.now() - startedAt,
        });

        throw new NotFoundException(`there is no order with id "${orderId}"`);

      default:
        return assertNever(result);
    }
  }
}
