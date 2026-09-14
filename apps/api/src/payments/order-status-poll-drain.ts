/**
 * **Processing trigger 3** — *"the order status poll opportunistically drains
 * that order's pending events"* (`architecture.md` §4; technical-considerations
 * §2.2, "Drain for one order | on the status poll").
 *
 * The shopper's own page is the thing that nudges their own order forward. If
 * the webhook's continuation was lost — a `SIGTERM` between the `200` and the
 * work, a frozen serverless instance, a `waitUntil` that never ran — and order
 * creation's drain (trigger 2) had nothing to find because the event arrived
 * afterwards, then the next thing to happen to that order is a shopper looking
 * at it. This is what makes looking at it enough.
 *
 * It lives in `payments` for exactly the reason trigger 2 does, and the argument
 * is written out in full in `./order-creation-drain.ts`: `PaymentsModule`
 * already imports `OrdersModule`, so the import that would put this in `orders`
 * is a cycle. The arrow is inverted instead — `orders` publishes a fact, this
 * module subscribes — and the module graph gains no edge, which is also what
 * keeps `SchedulingModule` pinned at distance 2
 * (`../scheduling/tracked-continuation-scheduler.ts`, `onModuleDestroy`).
 *
 * ###########################################################################
 * # THIS ENDPOINT IS POLLED ONCE A SECOND, PER OPEN ORDER PAGE. THAT IS WHAT
 * # MAKES THIS TRIGGER DIFFERENT FROM THE OTHER THREE.
 * ###########################################################################
 *
 * Order creation happens once per order. The webhook's continuation happens
 * once per event. The admin sweep happens when an operator asks. This one
 * happens **continuously, for every shopper watching an order**, so a cost that
 * is a rounding error on the other three is a standing load here.
 *
 * ### What the obvious implementation costs, measured
 *
 * The obvious implementation is the one trigger 2 uses: subscribe to the read
 * and call `drainOrder` every time. A drain that finds nothing is not one
 * statement — `PaymentEventDrainService.claimNextPendingEvent` runs inside a
 * transaction, so it is three round trips, and each one is measured here
 * (`log_statement = 'all'`, `log_min_duration_statement = 0`) against the local
 * database:
 *
 *   LOG:  statement: begin
 *   LOG:  duration: 0.050 ms
 *   LOG:  duration: 0.039 ms  bind <unnamed>: select "event_id", … from "payment_events"
 *                             where ("payment_events"."processed_at" is null
 *                                    and "payment_events"."order_id" = $1)
 *                             order by "payment_events"."received_at"
 *                             limit $2 for update skip locked
 *   LOG:  statement: commit
 *   LOG:  duration: 0.062 ms
 *
 * The query time is not the problem; the *connection* is. `packages/db`'s pool
 * is `max: 1` per instance, so those three round trips hold the only connection
 * this instance has, once a second, for every page anyone has open — competing
 * with the reads and the guarded UPDATEs that actually move orders. And an
 * order sits in `created` for as long as the shopper takes to decide to pay,
 * which is unbounded: the page polls the whole time, and the queue is empty the
 * whole time.
 *
 * ### So the trigger is gated, and the gate costs nothing
 *
 * `OrderViewService.findOrder` — the statement the poll was already running —
 * carries one extra selected expression: a `CASE` over an `EXISTS` against the
 * partial index `payment_events_unprocessed_order_idx`, evaluated only for an
 * order that is still in flight. It publishes through
 * {@link OrderPendingEventsNotifier} only when that comes back true, so:
 *
 *   | Poll                                  | Extra round trips |
 *   | ------------------------------------- | ----------------- |
 *   | in flight, nothing pending (the norm) | **0**             |
 *   | settled (bookmark or reload)          | **0**, and no index probe at all |
 *   | in flight, something pending          | 3 — the claim, once, off the response path |
 *
 * The gate is in the database's own answer rather than in this process, which
 * is why it is allowed to be an optimisation at all: it is not a lock, nothing
 * is skipped on the strength of what this instance remembers, and a false
 * negative is impossible in the direction that matters — a row this poll did
 * not see is a row the *next* poll a second later does see, and the admin sweep
 * is behind both.
 *
 * ### A settled order does not drain, and that is a decision
 *
 * `delivered`, `payment_failed` and `out_of_stock` are the states an order
 * stops moving in (`settledOrderStatuses`), and no transition in
 * `../orders/order-transitions.ts` leads back out of them. A pending event
 * naming such an order can therefore only ever be a no-op — which is exactly
 * what `PaymentEventProcessor` concludes, settling it as `no_op`. That is
 * housekeeping, not the shopper's business, and it belongs to the admin sweep
 * (trigger 4), which exists to clear whatever the targeted triggers left.
 *
 * The page stops polling on the *terminal* states and slows to one read every
 * five seconds on the *recoverable* ones (Phase 3 slice 6 — so an operator's
 * retry reaches a page someone left open), so this costs almost nothing
 * either way — but "almost" is the wrong thing to build on: a bookmarked link
 * or a reload still reads a settled order, and a crawler or a monitor could
 * read one in a loop forever. Making the answer *never* rather than *rarely*
 * means the shape of the load does not depend on how the page happens to be
 * written.
 *
 * ###########################################################################
 * # THE DRAIN IS SCHEDULED, NEVER AWAITED. A POLL MUST NOT WAIT FOR A SUPPLIER.
 * ###########################################################################
 *
 * A drain that finds a pending `paid` event runs the whole of
 * `PaymentEventProcessor.processStoredEvent`: `created → paid`,
 * `paid → delivering`, and then `POST {SUPPLIER_A_URL}/issue` over real HTTP.
 * `await`ing that here would make the status poll take as long as a supplier
 * round trip — on the one endpoint that runs in a loop, so the page would fall
 * behind by a whole supplier timeout per beat and the "watch my order progress"
 * promise (functional spec §2.5) would be answered by a page that stalls.
 *
 * So the work goes through `CONTINUATION_SCHEDULER`, exactly as
 * {@link PaymentWebhookController}'s continuation and trigger 2's do, and for
 * the same three reasons (`../scheduling/continuation-scheduler.ts`): a
 * `SIGTERM` mid-flight is waited for and, if it cannot be, *named* in the log; a
 * rejection is caught rather than terminating the process; and there is no
 * promise handed back for a caller to re-serialise the work with. What the poll
 * pays is `schedule()` itself — one closure allocated, one entry added to a
 * `Set`.
 *
 * ### And it cannot be inside a transaction, either
 *
 * `PaymentEventDrainService.runPass` spells out the trap: the pool is `max: 1`
 * per instance and a drain opens transactions of its own, so a caller holding
 * the connection would wait `CONNECTION_TIMEOUT_MS` for a connection it is
 * itself holding. Two independent things make that unreachable here.
 * `OrderViewService.findOrder` opens no transaction — it is one `SELECT` — and
 * this drain starts from a scheduled continuation after that statement has
 * resolved, not from inside the call.
 *
 * ### Several viewers of the same order do not multiply the work
 *
 * They multiply the *claims*, and the claim is where that is already handled:
 * `SELECT … FOR UPDATE SKIP LOCKED` hands one row to one worker and steps the
 * others over it, and every write the processor makes afterwards is adjudicated
 * by Postgres against the row itself — the guarded UPDATEs (I9), the UNIQUE on
 * `deliveries.order_id` (I3), the supplier's `request_id → code` ledger (I5).
 * Ten pages open on one order is ten drains that between them issue one key.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { OrderPendingEventsNotifier } from "../orders/order-pending-events-notifier.service.js";
import {
  CONTINUATION_SCHEDULER,
  type ContinuationScheduler,
} from "../scheduling/continuation-scheduler.js";
import { PaymentEventDrainService } from "./payment-event-drain.service.js";

/**
 * What this work is called in a log line, in both places it can appear: the
 * subscription registered below, and `guardContinuation`'s success and failure
 * lines. One constant so a log search finds every stage of the same job — and a
 * *different* constant from trigger 2's, so the two triggers stay tellable
 * apart in the log.
 */
const CONTINUATION_NAME = "order status poll drain";

@Injectable()
export class OrderStatusPollDrain implements OnModuleInit {
  private readonly logger = new Logger(OrderStatusPollDrain.name);

  constructor(
    private readonly pendingEvents: OrderPendingEventsNotifier,
    private readonly drain: PaymentEventDrainService,
    // By symbol, because the scheduler is an interface and which implementation
    // arrives is an environment decision (`../scheduling/scheduling.module.ts`).
    //
    // The token is in scope because `PaymentsModule` already imports
    // `SchedulingModule` — a line that did not have to move for this trigger,
    // any more than it did for trigger 2. That matters beyond convenience:
    // `SchedulingModule` may only be imported from a module `AppModule` imports
    // directly, or Nest re-parents it deeper than `DatabaseModule` and its
    // shutdown drain starts running against a closed pool. `PaymentsModule` is
    // at distance 2 and this trigger needed no new import anywhere, so that
    // measurement is untouched.
    @Inject(CONTINUATION_SCHEDULER)
    private readonly continuations: ContinuationScheduler,
  ) {}

  /**
   * Attach the listener.
   *
   * `onModuleInit` rather than the constructor: Nest runs every init hook
   * during `app.listen()`, before the HTTP server accepts anything, so there is
   * no window in which an order could be polled with nobody listening. Nest
   * instantiates this provider whether or not anything injects it — nothing
   * does — which is the same property `ConfigModule` relies on to make its
   * environment check a boot-time check (`../app.module.ts`).
   */
  onModuleInit(): void {
    this.pendingEvents.subscribe(CONTINUATION_NAME, (orderId: string) => {
      this.scheduleDrain(orderId);
    });
  }

  /**
   * Hand one order's queue to the scheduler and return immediately.
   *
   * Returns `void` because `OrderPendingEventsListener` does
   * (`../orders/order-pending-events-notifier.service.ts`), and that is what
   * keeps this work off the polled endpoint's response path — see the header.
   *
   * The result is *reported*, never acted on. Every outcome the pass can end in
   * is ordinary here:
   *
   *   - something claimed and settled — the case this trigger exists for, and
   *     worth a line naming the order.
   *   - `queue_empty` with nothing claimed — **not a contradiction**, even
   *     though the read that published this had just seen a pending row. Two
   *     ordinary things produce it: another worker claimed that row in between
   *     (`SKIP LOCKED` steps over it), or the webhook's own continuation
   *     settled it. Both mean "not my work", so it is a `debug` line rather
   *     than a warning.
   *   - `processing_failed`, or a pass limit — the events involved are still
   *     pending by construction, and the *next poll a second later* is the
   *     retry, with the admin sweep behind it (`architecture.md` §4). Retrying
   *     here would be a second, unbounded policy competing with those — and on
   *     this trigger of all four, one that a page could run forever.
   */
  private scheduleDrain(orderId: string): void {
    this.continuations.schedule(
      async () => {
        const result = await this.drain.drainOrder(orderId);

        if (result.claimed === 0) {
          this.logger.debug({
            msg: "order status poll drain: the pending event was already taken by another worker",
            order_id: orderId,
            stopped_by: result.stoppedBy,
          });

          return;
        }

        this.logger.log({
          msg: "order status poll drain: applied events the shopper's own page found waiting",
          order_id: orderId,
          claimed: result.claimed,
          settled: result.settled,
          stopped_by: result.stoppedBy,
        });
      },
      { name: CONTINUATION_NAME, orderId },
    );
  }
}
