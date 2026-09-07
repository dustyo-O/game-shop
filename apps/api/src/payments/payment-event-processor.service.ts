/**
 * Applying a stored event to its order, and settling it — technical-considerations
 * §2.5 **step 2** ("apply the event to the order") and **step 7** ("mark the
 * event processed").
 *
 * ---------------------------------------------------------------------------
 * THE INBOX IS PERSIST-THEN-PROCESS. THIS IS THE "THEN-PROCESS".
 * ---------------------------------------------------------------------------
 * {@link PaymentEventsService} writes the row and stops, deliberately
 * (`architecture.md` §4). It hands over a `payment_events` row with
 * `processed_at` NULL, which is both "pending work" and the queue itself
 * (`packages/db/src/schema/shop.ts`, `payment_events_unprocessed_order_idx`).
 * This file is what takes such a row and decides what it means for the order —
 * then either settles it (`processed_at = now()`) or deliberately leaves it in
 * the queue.
 *
 * Three services, three jobs, and none of them writes a status:
 *
 *   | Service                     | Owns                                        |
 *   | --------------------------- | ------------------------------------------- |
 *   | `PaymentEventsService`      | the INSERT into the inbox (I2)              |
 *   | `PaymentEventProcessor`     | *this* — what the event means, and settling it |
 *   | `OrderTransitionService`    | the guarded UPDATE on `orders` (I9)          |
 *
 * ---------------------------------------------------------------------------
 * THE THREE ANSWERS, AND WHY "NOTHING HAPPENED" IS TWO OF THEM
 * ---------------------------------------------------------------------------
 * The transition helper returns three outcomes and this file maps each to a
 * decision about the *event*, which is the only decision it actually makes:
 *
 *   - **`transitioned`** — this call moved the order. For a `failed` event that
 *     is the end of it, so the event settles. For a `paid` event it is the
 *     front of the chain, so the next statement is attempted (see below).
 *   - **`not_in_source_state`** — the guard matched zero rows. Somebody else
 *     already advanced the order, or a late event arrived for a finished one.
 *     **This is a no-op, not an error.** A `failed` event settles here — it can
 *     never apply, since nothing returns an order to `created`. A `paid` event
 *     settles only if the *order* has stopped moving; while the order is still
 *     in flight the row stays in the queue. Settling something that can never
 *     apply again matters: leaving it pending would put a permanent occupant in
 *     the queue that every future drain re-examines and never clears.
 *   - **`order_not_found`** — there is no such order *yet*.
 *     `payment_events.order_id` carries no foreign key precisely so this is a
 *     normal path (`architecture.md` §4, "Out-of-order tolerance"), so the event
 *     is left **pending**: `processed_at` stays NULL and the Phase 2 drain
 *     applies it once the order exists. Settling it here would silently discard
 *     a real payment result.
 *
 * The difference between the last two is the whole reason
 * {@link OrderTransitionService} keeps them apart rather than returning a
 * boolean: one means "done, nothing to do", the other means "come back later",
 * and they are indistinguishable from a row count.
 *
 * ---------------------------------------------------------------------------
 * A `failed` EVENT IS ONE MOVE; A `paid` EVENT IS A CHAIN
 * ---------------------------------------------------------------------------
 * That asymmetry is what decides when each of them is settled, and it is the
 * reason the `paid` branch has two "deferred" outcomes where the `failed`
 * branch has none.
 *
 * `status: "failed"` owns exactly one transition — `created → payment_failed`
 * (§2.5 step 2). Once that has been *attempted* there is nothing left of the
 * event, so it settles either way: applied, or a no-op the guard refused.
 *
 * `status: "paid"` owns §2.5 steps 2 **through 6**: `created → paid`, then the
 * claim `paid → delivering`, then the supplier call, the `deliveries` row, and
 * the finishing status. This file does the first two. Winning the second is the
 * **claim** — exactly one caller per order may go on to issuance — and it is
 * where issuance plugs in ({@link PaymentEventProcessor.claimForIssuance},
 * "THE ISSUANCE SEAM").
 *
 * ---------------------------------------------------------------------------
 * SO WHEN IS A `paid` EVENT SETTLED? WHEN THE ORDER HAS STOPPED MOVING.
 * ---------------------------------------------------------------------------
 * One question, asked of the order rather than of this call:
 *
 *   - **Order in a settled state** (`delivered`, `payment_failed`,
 *     `out_of_stock` — `settledOrderStatuses` in `@game-shop/contracts`) →
 *     **settle**. Nothing this event could still do remains, and nothing ever
 *     will: no transition in the table leads back to `created` or to `paid`, so
 *     a later attempt cannot know more than this one did.
 *   - **Order still in flight** (`created`, `paid`, `delivering`) → **leave
 *     pending**, whether this caller won the claim or lost it. The winner is
 *     holding work it has not finished. The loser cannot verify that anybody
 *     else still is: `observed` is advisory, and an order sitting in
 *     `delivering` is equally consistent with "a worker is mid-supplier-call"
 *     and "the worker that claimed it died between two statements".
 *   - **No such order** → leave pending, exactly as for a `failed` event.
 *
 * Settling on the claim itself — the tempting shortcut, since the claim *is*
 * this file's last write — would drop the event out of the queue while the
 * order it names is paid and undelivered. That is the one direction the Slice 3
 * walkthrough §4 rules out: *the record of "not yet done" must outlive the
 * doing.* A false "not done" costs a repeated no-op; a false "done" costs the
 * work, permanently.
 *
 * The invariant this buys is worth stating on its own: **an unfinished paid
 * order always has at least one pending event pointing at it.** No drain has to
 * work out which of N racing events "owns" the order in order to be sure the
 * outstanding work is still findable.
 *
 * The price, stated rather than discovered: N `paid` events for one order leave
 * N pending rows until that order settles, and each drain pass re-runs two
 * guarded UPDATEs per row that match nothing. That is the cheap direction of
 * the trade, and it is the one taken on purpose.
 *
 * ---------------------------------------------------------------------------
 * ORDER OF THE TWO WRITES: APPLY FIRST, SETTLE SECOND. NEVER THE REVERSE.
 * ---------------------------------------------------------------------------
 * They are two statements, not one transaction, and the ordering is what makes
 * that safe:
 *
 *   - Crash *after* the transition and *before* the settle → the order is
 *     `payment_failed` and the event is still pending. A later drain re-applies
 *     it, the status guard matches zero rows, and it settles. Correct, because
 *     applying an event twice is a no-op by construction (I9).
 *   - Crash the other way round → the event reads "processed" and the order
 *     never moved. Nothing will ever look at it again. That is a lost payment
 *     result, and it is the only ordering that can produce one.
 *
 * So this file does not need a transaction to be correct; it needs the writes in
 * this order. Phase 2 adds one anyway, for a different reason: the drain claims
 * the event with `SELECT … FOR UPDATE SKIP LOCKED` and the claim, the apply and
 * the settle then belong to one unit of work — at which point the transition
 * goes through {@link OrderTransitionService.transitionWithin} on the drain's
 * `tx` handle instead of {@link OrderTransitionService.transition}.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";

import { PaymentEventStatus, isPaymentEventStatus, isSettledOrderStatus } from "@game-shop/contracts";
import { paymentEvents, type DatabaseClient, type Order, type PaymentEvent } from "@game-shop/db";

import { DATABASE_CLIENT } from "../database/database.module.js";
import { IssuanceOutcome, IssuanceService } from "../issuance/issuance.service.js";
import { OrderTransitionOutcome, OrderTransitionService } from "../orders/order-transition.service.js";

/**
 * What this event turned out to mean. Named values rather than a boolean or a
 * `void`, matching {@link OrderTransitionService} and {@link PaymentEventsService}:
 * the caller's `switch` reads as news and the compiler has something to be
 * exhaustive about.
 *
 * The split that matters is not "did the order move?" — it is **"is this event
 * settled, or still in the queue?"**, because that is what the Phase 2 drain
 * needs to know. The first three below are settled; the last three are pending
 * on purpose.
 *
 * None of them is an error. Every one of them is a `200`.
 */
export const ProcessPaymentEventOutcome = {
  /** The order moved `created → payment_failed`. Event settled. */
  Applied: "applied",

  /**
   * The status guard matched zero rows **and the order has stopped moving by
   * itself** — `delivered`, `payment_failed` or `out_of_stock`. Event settled:
   * it was considered, correctly changed nothing, and can never change anything
   * later, because no transition leads back to `created` or to `paid`.
   */
  NoOp: "no_op",

  /**
   * The event names a status this shop has no lifecycle move for. Stored
   * verbatim for reconciliation and settled, because no future drain will know
   * any more about it than this one did — leaving it pending would poison the
   * queue forever.
   */
  UnknownStatus: "unknown_status",

  /**
   * No order with that id **yet**. Left pending (`processed_at` NULL) for a
   * later drain — `architecture.md` §4, "Out-of-order tolerance".
   */
  DeferredOrderMissing: "deferred_order_missing",

  /**
   * **This caller won `paid → delivering` and issuance finished the order.** A
   * key is bound in `deliveries` and the order is `delivered`. Event settled:
   * the order has stopped moving, and `delivered` is terminal.
   */
  Delivered: "delivered",

  /**
   * This caller won the claim, the supplier answered with a definite refusal,
   * and the order is `out_of_stock`. No key was issued and none is bound. Event
   * settled — the order has stopped moving, and re-applying this event could
   * never do anything but the same thing again.
   *
   * Not an error, and not a `5xx`: "paid, and there is nothing to hand over" is
   * a state this system understands (`../issuance/issuance.service.ts`).
   */
  OutOfStock: "out_of_stock",

  /**
   * **This caller won `paid → delivering` and issuance did not reach a
   * finishing status.** In practice: the supplier gave no usable answer, so the
   * attempt row says `unknown`, the order rests in `delivering`, and a key may
   * or may not exist for the outstanding `request_id`.
   *
   * Left **pending** on purpose, and this is the case the rule was written for:
   * the work this event owns (§2.5 steps 4-6) is not finished. Settling it here
   * would take the only queue entry pointing at a paid, undelivered order out of
   * the queue — and this order genuinely needs somebody to come back to it.
   * Phase 3's retry is that somebody.
   */
  IssuanceClaimed: "issuance_claimed",

  /**
   * The guard matched zero rows and the order is still **in flight** (`paid` or
   * `delivering`): another caller claimed it, or one claimed it and died
   * part-way through the chain. This call owns no work and can never win the
   * claim now — but the order has not finished, so the row stays **pending** as
   * the inbox's record that something is still outstanding for it. It settles
   * on whichever drain runs after the order reaches a settled state.
   */
  DeferredOrderInFlight: "deferred_order_in_flight",
} as const;

export type ProcessPaymentEventOutcome =
  (typeof ProcessPaymentEventOutcome)[keyof typeof ProcessPaymentEventOutcome];

export interface ProcessPaymentEventResult {
  readonly outcome: ProcessPaymentEventOutcome;
  /**
   * Whether `processed_at` is now set — i.e. whether the event has left the
   * queue. Derived from the outcome rather than reported independently, so the
   * two cannot disagree; it exists because "settled?" is the single question a
   * drain asks and reading it off six outcome names at every call site is how
   * one of them eventually gets classified wrong.
   */
  readonly settled: boolean;
}

/**
 * The derivation itself: outcome → is the event out of the queue.
 *
 * One table rather than a `settled:` literal at each `return`, because the two
 * halves of a result written by hand can disagree, and the half that is wrong
 * is invisible — a `settled: true` on a pending row reads perfectly and loses a
 * payment result. `satisfies Record<ProcessPaymentEventOutcome, boolean>` makes
 * the table total: adding an outcome without classifying it here stops the
 * build rather than defaulting it to one answer or the other.
 */
const outcomeSettlesTheEvent = {
  [ProcessPaymentEventOutcome.Applied]: true,
  [ProcessPaymentEventOutcome.NoOp]: true,
  [ProcessPaymentEventOutcome.UnknownStatus]: true,
  [ProcessPaymentEventOutcome.Delivered]: true,
  [ProcessPaymentEventOutcome.OutOfStock]: true,
  [ProcessPaymentEventOutcome.DeferredOrderMissing]: false,
  [ProcessPaymentEventOutcome.IssuanceClaimed]: false,
  [ProcessPaymentEventOutcome.DeferredOrderInFlight]: false,
} as const satisfies Record<ProcessPaymentEventOutcome, boolean>;

/** Pair an outcome with its settled flag. The only way a result is constructed here. */
function eventResult(outcome: ProcessPaymentEventOutcome): ProcessPaymentEventResult {
  return { outcome, settled: outcomeSettlesTheEvent[outcome] };
}

/** Exhaustiveness guard: the compiler routes here only if a status went unhandled. */
function assertNever(value: never): never {
  throw new Error(`payments: unhandled payment event status ${JSON.stringify(value)}`);
}

@Injectable()
export class PaymentEventProcessor {
  private readonly logger = new Logger(PaymentEventProcessor.name);

  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    private readonly transitions: OrderTransitionService,
    private readonly issuance: IssuanceService,
  ) {}

  /**
   * Apply one stored event to its order and settle it.
   *
   * The argument is a `PaymentEvent` **row**, not a request body: this only ever
   * runs on something already durable in the inbox. That is what makes throwing
   * from here survivable — the event is not lost, it is merely still pending —
   * and it is why the caller must be the one that won the insert (I2), never a
   * redelivery.
   *
   * ### The two branches, and why one of them is two statements
   *
   * `failed` is a single guarded UPDATE ({@link applyFailed}). `paid` is the
   * front of §2.5's chain and runs two ({@link applyPaid}): `created → paid`,
   * then the claim `paid → delivering`. Neither branch opens a transaction, and
   * the `paid` branch must not — the seam that follows the claim is an HTTP
   * call to a supplier, and with `max: 1` a transaction held across it stalls
   * every other statement from this instance (`packages/db/src/client.ts`).
   *
   * The two statements need no transaction to be correct, for the same reason
   * the apply/settle pair does not: each is idempotent under its own guard, and
   * the event stays pending until the order stops moving. A process that dies
   * between them leaves the order in `paid` with its event still in the queue,
   * and the next drain wins `beginIssuance` and carries on.
   */
  async processStoredEvent(event: PaymentEvent): Promise<ProcessPaymentEventResult> {
    if (!isPaymentEventStatus(event.status)) {
      // Not a `400` and not a throw: the body was storable, it is stored, and
      // the provider cannot fix a status we do not recognise by sending it
      // again. `payment_events.status` carries no CHECK constraint for exactly
      // this reason (`packages/db/src/schema/shop.ts`), and `payload` keeps the
      // original bytes for whoever reconciles it.
      this.logger.warn({
        msg: "payment event: unrecognised status; nothing to apply",
        event_id: event.eventId,
        order_id: event.orderId,
        status: event.status,
      });

      await this.markProcessed(event);

      return eventResult(ProcessPaymentEventOutcome.UnknownStatus);
    }

    switch (event.status) {
      case PaymentEventStatus.Failed:
        return this.applyFailed(event);

      case PaymentEventStatus.Paid:
        return this.applyPaid(event);

      default:
        return assertNever(event.status);
    }
  }

  /**
   * §2.5 step 2 for `status: "failed"` — `created → payment_failed`.
   *
   * The move goes through {@link OrderTransitionService}, which is the single
   * place `orders.status` is written and the only place the source-state guard
   * lives (I9). A hand-written `UPDATE orders SET status = 'payment_failed'`
   * here would be a second one, and the second one is always the one that
   * forgets the `WHERE status = …`.
   */
  private async applyFailed(event: PaymentEvent): Promise<ProcessPaymentEventResult> {
    const result = await this.transitions.transition(event.orderId, "markPaymentFailed");

    switch (result.outcome) {
      case OrderTransitionOutcome.Transitioned:
        this.logger.log({
          msg: "payment event: applied, order moved to payment_failed",
          event_id: event.eventId,
          order_id: event.orderId,
          status: result.order.status,
        });

        await this.markProcessed(event);

        return eventResult(ProcessPaymentEventOutcome.Applied);

      case OrderTransitionOutcome.NotInSourceState:
        // ##################################################################
        // # ZERO ROWS IS A NO-OP, NOT AN ERROR — AND THE EVENT IS STILL DONE.
        // ##################################################################
        //
        // The order was already `payment_failed` (a second event saying the
        // same thing), or has moved on into the paid chain, or is terminal.
        // `markPaymentFailed` may only leave `created` and nothing returns an
        // order to `created`, so this event will never apply — which is what
        // makes settling it right. Nothing to do, which is
        // the *correct* result rather than a failure to achieve one, so this
        // must not throw: an exception here becomes a `500`, and a `500` is how
        // you ask a payment provider to send the event again
        // (`docs/walkthrough/slice-2-order-lifecycle.md` §4).
        //
        // `observed` is advisory — under READ COMMITTED the row may have moved
        // again since the UPDATE — which is why it is logged and not branched
        // on. The load-bearing fact is the outcome: this call did not make the
        // transition, and that stays true forever.
        this.logger.log({
          msg: "payment event: no-op, order was not in a state this transition may leave from",
          event_id: event.eventId,
          order_id: event.orderId,
          observed_status: result.observed.status,
        });

        await this.markProcessed(event);

        return eventResult(ProcessPaymentEventOutcome.NoOp);

      case OrderTransitionOutcome.OrderNotFound:
        // The webhook overtook its own order. Leave `processed_at` NULL and say
        // nothing else: the row is the handover to the drain, and the partial
        // index on (order_id) WHERE processed_at IS NULL is the access path that
        // finds it the moment the order appears.
        this.logger.log({
          msg: "payment event: order does not exist yet; left pending for a later drain",
          event_id: event.eventId,
          order_id: event.orderId,
        });

        return eventResult(ProcessPaymentEventOutcome.DeferredOrderMissing);

      default:
        return assertNever(result);
    }
  }

  /**
   * §2.5 steps 2 and 3 for `status: "paid"` — `created → paid`, then the claim
   * `paid → delivering`.
   *
   * Two guarded UPDATEs through {@link OrderTransitionService}, in that order,
   * with no transaction around them and no read between them. The emitted SQL
   * is one statement per step (verified under `log_statement = 'all'`; per the
   * project's raw-SQL rule, `architecture.md` §2):
   *
   *   -- step 2, `markPaid`
   *   update "orders" set "status" = $1, "updated_at" = now()
   *   where ("orders"."id" = $2 and "orders"."status" = ANY($3))
   *   returning "id", "client_request_id", "sku", "amount_minor", "currency",
   *             "status", "created_at", "updated_at";
   *   -- $1 = 'paid', $3 = '{created}'
   *   -- 1 row  => THIS call moved the order to `paid`.
   *   -- 0 rows => the order was not `created`. Not an error: another event
   *   --           already applied a payment result, or the order is finished.
   *
   * and then, unconditionally, step 3 in {@link claimForIssuance}.
   *
   * ### Why the claim is attempted even when `markPaid` matched nothing
   *
   * Because "somebody else moved it to `paid`" and "somebody else moved it to
   * `paid` **and then died**" look identical from here, and only one of them
   * has an owner. `beginIssuance` is the question that tells them apart, and it
   * is answered by Postgres against the row rather than by this process against
   * a stale read: if the order is `paid` this call takes the claim and the
   * order is rescued; if it is anything else the guard matches zero rows and
   * costs one statement.
   *
   * Branching on `markPaid`'s `observed` status instead would be a
   * check-then-act — a decision taken on a value that may already be false —
   * which is exactly what `architecture.md` §3's governing principle forbids.
   * `observed` is logged and never branched on.
   *
   * The one outcome that does short-circuit is `order_not_found`: there is no
   * row for the second statement to match, and the event is the deferred-order
   * case the missing foreign key on `payment_events.order_id` exists to allow.
   */
  private async applyPaid(event: PaymentEvent): Promise<ProcessPaymentEventResult> {
    const paid = await this.transitions.transition(event.orderId, "markPaid");

    switch (paid.outcome) {
      case OrderTransitionOutcome.Transitioned:
        this.logger.log({
          msg: "payment event: applied, order moved to paid",
          event_id: event.eventId,
          order_id: event.orderId,
          status: paid.order.status,
        });
        break;

      case OrderTransitionOutcome.NotInSourceState:
        // Zero rows on step 2. The order was not `created`: another paid event
        // won this move a moment ago, or the order failed, or it is already
        // through to `delivering`/`delivered`. All ordinary traffic, none of it
        // an error — and none of it a reason to skip the claim below, which is
        // the only statement that can tell an owned order from an abandoned
        // one.
        this.logger.log({
          msg: "payment event: order was not in `created`; another path already applied a payment result",
          event_id: event.eventId,
          order_id: event.orderId,
          observed_status: paid.observed.status,
        });
        break;

      case OrderTransitionOutcome.OrderNotFound:
        // The webhook overtook its own order. Left pending for a later drain,
        // exactly as in {@link applyFailed} — `architecture.md` §4,
        // "Out-of-order tolerance".
        this.logger.log({
          msg: "payment event: order does not exist yet; left pending for a later drain",
          event_id: event.eventId,
          order_id: event.orderId,
        });

        return eventResult(ProcessPaymentEventOutcome.DeferredOrderMissing);

      default:
        return assertNever(paid);
    }

    return this.claimForIssuance(event);
  }

  /**
   * §2.5 step 3 — **the claim**. `paid → delivering`, and the winner of it is
   * the one caller that may go on to issuance.
   *
   * Emitted SQL (verified under `log_statement = 'all'`):
   *
   *   update "orders" set "status" = $1, "updated_at" = now()
   *   where ("orders"."id" = $2 and "orders"."status" = ANY($3))
   *   returning "id", "client_request_id", "sku", "amount_minor", "currency",
   *             "status", "created_at", "updated_at";
   *   -- $1 = 'delivering', $3 = '{paid}'
   *   -- 1 row  => THIS call claimed the order. Exactly one caller ever sees
   *   --           this per `paid → delivering`, across every process, because
   *   --           the row can only leave `paid` once.
   *   -- 0 rows => somebody else already claimed it, or the order never reached
   *   --           `paid`, or it is finished. This caller stops.
   *
   * ### What the guard alone protects, and what the row lock will add
   *
   * The guard is the whole of the *mutual exclusion* on the status: fifty
   * concurrent webhooks issue fifty of these UPDATEs, Postgres serialises them
   * on the row's write lock, the first finds `status = 'paid'` and the other
   * forty-nine find `'delivering'` and match nothing. One claim, chosen inside
   * the database, with no application-level check anywhere near it. That is
   * enough for I4's headline promise — *only one worker advances an order* —
   * and it is enough for the whole of this file, whose last write is the claim
   * itself.
   *
   * What it does **not** protect is the work *after* the claim, because the
   * guard's exclusivity ends when its statement commits. The moment issuance
   * spans several statements — read the order, call the supplier, write
   * `issuance_attempts`, insert `deliveries`, finish — a second worker (a
   * Phase 3 retry, an admin re-issue) can interleave with the first, since it
   * is no longer trying to leave `paid` and so is no longer excluded by this
   * guard. `SELECT … FOR UPDATE` on the order row (I4, `architecture.md` §3.1)
   * is what covers that span: the lock serialises the *workers* for as long as
   * the transaction lives, while the guard makes the *transition* idempotent.
   * Different jobs, which is why Phase 2 adds the lock and keeps the guard.
   *
   * Two guarantees that are already the database's and stay untouched by the
   * missing lock: `deliveries.order_id` UNIQUE (I3) means a second worker
   * cannot bind a second key even if it gets that far, and the supplier's
   * `request_id → code` ledger (I5) means a repeat of the same attempt returns
   * the same code rather than issuing another.
   */
  private async claimForIssuance(event: PaymentEvent): Promise<ProcessPaymentEventResult> {
    const claim = await this.transitions.transition(event.orderId, "beginIssuance");

    switch (claim.outcome) {
      case OrderTransitionOutcome.Transitioned:
        this.logger.log({
          msg: "payment event: claimed the order for issuance",
          event_id: event.eventId,
          order_id: event.orderId,
          status: claim.order.status,
        });

        // ##################################################################
        // # THE ISSUANCE SEAM — §2.5 steps 4-6 RUN HERE.
        // ##################################################################
        //
        // This caller, and only this caller, holds the claim on `order_id`, so
        // this is the one place issuance may be entered from. The work itself
        // belongs to `IssuanceModule` (`../issuance/issuance.service.ts`) and is
        // one call: derive the deterministic `request_id`, record the attempt as
        // `unknown` **before** the supplier is called, call
        // `POST {SUPPLIER_A_URL}/issue` over real HTTP with no transaction open,
        // then in one short transaction resolve the attempt, bind the key with
        // `INSERT INTO deliveries ... ON CONFLICT (order_id) DO NOTHING` (I3) and
        // move the order to its finishing status.
        //
        // Both constraints this seam was written with are honoured there and
        // documented at the statements that honour them: no transaction spans
        // the HTTP call (`max: 1` per instance), and the event is not settled
        // before the finishing status — which is why `markProcessed` is called
        // *below*, on the outcome, and never inside the issuance service.
        //
        // It does not throw for anything the supplier does. An empty pool is a
        // definite refusal and becomes `out_of_stock`; silence is an unknown
        // outcome and becomes nothing at all.
        const issued = await this.issuance.issueForClaimedOrder(claim.order);

        switch (issued.outcome) {
          case IssuanceOutcome.Delivered:
            this.logger.log({
              msg: "payment event: issuance delivered a key; the order is finished",
              event_id: event.eventId,
              order_id: event.orderId,
              request_id: issued.requestId,
            });

            // Settled here and not one statement earlier. Between the claim and
            // this line the order was paid and undelivered, and this row was the
            // queue's only record of it.
            await this.markProcessed(event);

            return eventResult(ProcessPaymentEventOutcome.Delivered);

          case IssuanceOutcome.OutOfStock:
            this.logger.warn({
              msg: "payment event: the supplier had nothing to issue; the order is out_of_stock",
              event_id: event.eventId,
              order_id: event.orderId,
              request_id: issued.requestId,
              reason: issued.reason,
            });

            // Also a finishing status, so also settled. `out_of_stock` is
            // terminal for Phase 1; Phase 3 makes it recoverable through the
            // admin retry, which re-enters `delivering` under its own claim
            // rather than by re-applying this event.
            await this.markProcessed(event);

            return eventResult(ProcessPaymentEventOutcome.OutOfStock);

          case IssuanceOutcome.Unresolved:
            // #############################################################
            // # NOT SETTLED. THE ORDER IS PAID, UNDELIVERED, AND STILL OURS.
            // #############################################################
            //
            // No finishing status was reached — the supplier gave no usable
            // answer, so the attempt row says `unknown` and a key may or may not
            // exist for that `request_id`. The event stays in the queue because
            // it is the record that this order still owes somebody something,
            // and Phase 3's retry is what will act on it.
            //
            // Not an exception: a `500` here would ask the payment provider to
            // redeliver an event whose duplicate is deliberately not processed
            // (`./payment-webhook.controller.ts`), which buys a retry storm and
            // no issuance.
            this.logger.error({
              msg: "payment event: issuance reached no finishing status; order rests in delivering and the event stays pending",
              event_id: event.eventId,
              order_id: event.orderId,
              request_id: issued.requestId,
              detail: issued.detail,
            });

            return eventResult(ProcessPaymentEventOutcome.IssuanceClaimed);

          default:
            return assertNever(issued);
        }

      case OrderTransitionOutcome.NotInSourceState:
        // #################################################################
        // # ZERO ROWS IS A NO-OP, NOT AN ERROR — AND HERE IT IS THE COMMON
        // # CASE, NOT THE EXCEPTION.
        // #################################################################
        //
        // Every concurrent copy of a payment for this order but one arrives
        // here. It must not throw: an exception becomes a `500`, and a `500`
        // is how you ask a payment provider to send the event again.
        //
        // Whether the *event* is finished with is a different question from
        // whether this *call* did anything, and it is asked of the order's
        // state — see {@link settleOrDeferPaidEvent}.
        return this.settleOrDeferPaidEvent(event, claim.observed);

      case OrderTransitionOutcome.OrderNotFound:
        // The order existed for step 2 and does not exist now. Nothing in this
        // system deletes orders, so this is all but unreachable — and it is
        // still handled rather than folded into the case above, because the
        // union makes the distinction and collapsing it would mean settling an
        // event whose order might yet appear.
        this.logger.log({
          msg: "payment event: order not found when claiming for issuance; left pending for a later drain",
          event_id: event.eventId,
          order_id: event.orderId,
        });

        return eventResult(ProcessPaymentEventOutcome.DeferredOrderMissing);

      default:
        return assertNever(claim);
    }
  }

  /**
   * The settle decision for a `paid` event that claimed nothing: **has the
   * order stopped moving?**
   *
   *   - `delivered`, `payment_failed`, `out_of_stock` → settle. This event can
   *     produce no further work and never will: nothing returns an order to
   *     `created` or to `paid`, so no later attempt can know more than this one
   *     did. Leaving it pending would put a permanent occupant in the queue
   *     that every future drain re-examines and never clears.
   *   - `created`, `paid`, `delivering` → leave pending. The order is unfinished
   *     and this row is a record that says so. Whether some other worker is
   *     mid-chain right now cannot be established from here — `observed` is
   *     advisory, read after the UPDATE and possibly already stale — and the
   *     asymmetry of the mistake settles the argument: a needless pending row
   *     costs a repeated no-op, while a needless settle costs the payment
   *     result permanently.
   *
   * `isSettledOrderStatus` comes from `@game-shop/contracts` rather than a
   * local list of three strings, so Phase 3's `delivery_failed` is classified
   * once, in the package that defines the lifecycle, instead of being missed
   * here.
   *
   * This is the only place `observed` influences anything, and note what it
   * influences: the fate of the *event*, never the fate of the order. No
   * transition is skipped or taken because of it.
   */
  private async settleOrDeferPaidEvent(
    event: PaymentEvent,
    observed: Order,
  ): Promise<ProcessPaymentEventResult> {
    if (isSettledOrderStatus(observed.status)) {
      this.logger.log({
        msg: "payment event: no-op, the order has already stopped moving",
        event_id: event.eventId,
        order_id: event.orderId,
        observed_status: observed.status,
      });

      await this.markProcessed(event);

      return eventResult(ProcessPaymentEventOutcome.NoOp);
    }

    this.logger.log({
      msg: "payment event: no-op, this call did not claim the order; left pending until the order settles",
      event_id: event.eventId,
      order_id: event.orderId,
      observed_status: observed.status,
    });

    return eventResult(ProcessPaymentEventOutcome.DeferredOrderInFlight);
  }

  /**
   * §2.5 step 7 — take the event out of the queue.
   *
   * Emitted SQL (verified against `.toSQL()`; per the project's raw-SQL rule,
   * `architecture.md` §2, "Documentation convention"):
   *
   *   update "payment_events" set "processed_at" = now()
   *   where ("payment_events"."event_id" = $1
   *          and "payment_events"."processed_at" is null)
   *   returning "event_id", "processed_at";
   *   -- 1 row  => THIS call settled the event; it is out of the queue.
   *   -- 0 rows => it was already settled (or, once the drain exists, another
   *   --           worker settled it first). Nothing to do, and not an error.
   *
   * Three details that are load-bearing:
   *
   *   - **`AND processed_at IS NULL`.** The same shape as the status guard on
   *     `orders`, for the same reason: it makes the write idempotent, so a
   *     re-drained event cannot overwrite the timestamp that records when it was
   *     *first* settled. Without it, replaying the inbox would quietly rewrite
   *     the history it exists to preserve.
   *   - **`now()` in SQL, not `new Date()` in Node.** The clock that stamps the
   *     row is the database's — the one `received_at` and every other process is
   *     compared against. A serverless instance's clock is not.
   *   - **The zero-row path does not read the row back.** Unlike
   *     {@link OrderTransitionService}, "nothing happened" has exactly one cause
   *     here (already settled) and no caller would act differently, so there is
   *     nothing to disambiguate.
   *
   * This does not filter on `order_id`. The event id is the PRIMARY KEY and
   * therefore already names exactly one row; adding a second predicate would
   * imply the row could be found some other way.
   */
  private async markProcessed(event: PaymentEvent): Promise<void> {
    const [settled] = await this.database.db
      .update(paymentEvents)
      .set({ processedAt: sql`now()` })
      .where(and(eq(paymentEvents.eventId, event.eventId), isNull(paymentEvents.processedAt)))
      .returning({
        eventId: paymentEvents.eventId,
        processedAt: paymentEvents.processedAt,
      });

    if (settled === undefined) {
      this.logger.log({
        msg: "payment event: already settled by someone else; nothing written",
        event_id: event.eventId,
        order_id: event.orderId,
      });

      return;
    }

    this.logger.log({
      msg: "payment event: processed",
      event_id: settled.eventId,
      order_id: event.orderId,
      processed_at: settled.processedAt?.toISOString(),
    });
  }
}
