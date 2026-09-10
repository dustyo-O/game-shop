/**
 * **Processing trigger 2** — *"order creation drains any events already waiting
 * for that order id"* (`architecture.md` §4; technical-considerations §2.2,
 * "Drain for one order | on order creation").
 *
 * This is the trigger that completes the assignment's third adversarial
 * scenario, and functional spec §2.3's first criterion word for word: *"Given
 * the payment service reports a payment before the shop has finished recording
 * the order it belongs to, when the order is recorded, then the payment is
 * applied to it and the shopper receives their key without taking any further
 * action."*
 *
 * Phase 1 already made the early webhook a *normal* path rather than an error:
 * `payment_events.order_id` carries no foreign key, so the event is stored with
 * `processed_at` NULL instead of raising (`docs/walkthrough/slice-1-data-model.md`
 * §4). What Phase 1 had no answer for was the last three words — *without
 * taking any further action*. The row sat in the queue with nothing coming back
 * for it. This file is what comes back, at the first moment the row can be
 * applied: the instant its order exists.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TRIGGER LIVES IN `payments` AND NOT IN `orders`
 * ---------------------------------------------------------------------------
 * Because the import that would put it there is a cycle: `PaymentsModule`
 * already imports `OrdersModule` for `OrderTransitionService`, so an
 * `OrdersModule → PaymentsModule` edge closes the loop, and `forwardRef()` on
 * both sides tolerates a cycle rather than removing one.
 *
 * The inversion is in `../orders/order-created-notifier.service.ts`: `orders`
 * announces a fact about its own domain, and this class — which is in the
 * module that already depends on `orders` — subscribes to it. The module graph
 * gains no edge at all; `OrdersModule`'s export list gains one entry.
 *
 * It also puts the code where the knowledge is. "A pending payment event may
 * exist for this order id" is a statement about the inbox, and the inbox is
 * this module's.
 *
 * ###########################################################################
 * # THE DRAIN IS SCHEDULED, NEVER AWAITED. `POST /api/orders` MUST NOT WAIT
 * # FOR A SUPPLIER.
 * ###########################################################################
 *
 * A drain that finds a pending `paid` event runs the whole of
 * {@link PaymentEventProcessor.processStoredEvent}: `created → paid`,
 * `paid → delivering`, and then `POST {SUPPLIER_A_URL}/issue` over real HTTP.
 * `await`ing that here would make order creation take as long as a supplier
 * round trip — reintroducing, on the creation endpoint, exactly the problem
 * Slice 2 removed from the webhook (technical-considerations §2.2: *"the
 * webhook persists the event, answers `200`, and schedules processing. It no
 * longer awaits the work"*). The shopper would sit on a spinner watching a
 * request that has already done everything it needed to do.
 *
 * So the work goes through `CONTINUATION_SCHEDULER`, exactly as
 * {@link PaymentWebhookController}'s continuation does, and for the same three
 * reasons (`../scheduling/continuation-scheduler.ts`): a `SIGTERM` mid-flight
 * is waited for and, if it cannot be, *named* in the log; a rejection is caught
 * rather than terminating the process; and there is no promise handed back for
 * a caller to re-serialise the work with. What order creation pays is the cost
 * of `schedule()` itself — one closure allocated and one entry added to a
 * `Set` — measured in microseconds, on a path that has already committed.
 *
 * ### And it cannot be inside the creation transaction, either
 *
 * {@link PaymentEventDrainService.runPass} spells out the trap: the pool is
 * `max: 1` per instance, and a drain opens transactions of its own, so a caller
 * that already holds the connection would wait `CONNECTION_TIMEOUT_MS` for a
 * connection it is itself holding and then fail with an error naming a timeout
 * rather than its cause. Two independent things make that unreachable here:
 * `OrdersService.createOrder` opens no transaction at all (it is one
 * `INSERT ... SELECT` and, at most, one follow-up `SELECT`), and this drain
 * starts after that statement has resolved — from a scheduled continuation, not
 * from inside the call. It is also the only order that makes sense: an event
 * cannot be applied to an order other connections cannot see yet.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS COSTS ON THE ORDINARY ORDER, WHICH IS ALL BUT ONE OF THEM
 * ---------------------------------------------------------------------------
 * A newly created order almost never has a pending event — the shopper has not
 * paid yet. So the common case is one claim that returns zero rows:
 *
 *   begin
 *   select … from "payment_events"
 *   where ("payment_events"."processed_at" is null
 *          and "payment_events"."order_id" = $1)
 *   order by "payment_events"."received_at"
 *   limit $2 for update skip locked;
 *   commit
 *   -- 0 rows => nothing was waiting for this order. `queue_empty`, not an error.
 *
 * That is an index probe into
 * `payment_events_unprocessed_order_idx (order_id) WHERE processed_at IS NULL`,
 * a partial index that holds only unprocessed rows and is therefore a handful
 * of entries however large the table grows (`packages/db/src/schema/shop.ts`).
 * It touches no order, no delivery and no supplier, and it happens after the
 * `201` has been sent.
 *
 * The one shared resource it does take is this instance's single pooled
 * connection, for the length of that round trip — which is why the pass is not
 * looped or widened here. `drainOrder` is the targeted form of the claim on
 * purpose: this order's queue, not everybody's. Draining everybody's is the
 * admin sweep's job, and it has its own endpoint for exactly that reason.
 */
import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { OrderCreatedNotifier } from "../orders/order-created-notifier.service.js";
import {
  CONTINUATION_SCHEDULER,
  type ContinuationScheduler,
} from "../scheduling/continuation-scheduler.js";
import { PaymentEventDrainService } from "./payment-event-drain.service.js";

/**
 * What this work is called in a log line, in both places it can appear: the
 * subscription registered below, and `guardContinuation`'s success and failure
 * lines. One constant so a log search finds every stage of the same job.
 */
const CONTINUATION_NAME = "order creation drain";

@Injectable()
export class OrderCreationDrain implements OnModuleInit {
  private readonly logger = new Logger(OrderCreationDrain.name);

  constructor(
    private readonly orderCreated: OrderCreatedNotifier,
    private readonly drain: PaymentEventDrainService,
    // By symbol, because the scheduler is an interface and which implementation
    // arrives is an environment decision (`../scheduling/scheduling.module.ts`).
    //
    // The token is in scope because `PaymentsModule` imports `SchedulingModule`
    // — a line that already existed and did not have to move. That matters
    // beyond convenience: `SchedulingModule` may only be imported from a module
    // `AppModule` imports directly, or Nest re-parents it deeper than
    // `DatabaseModule` and its shutdown drain starts running against a closed
    // pool. `PaymentsModule` is at distance 2 and this trigger needed no new
    // import anywhere, so that measurement is untouched
    // (`../scheduling/tracked-continuation-scheduler.ts`, `onModuleDestroy`).
    @Inject(CONTINUATION_SCHEDULER)
    private readonly continuations: ContinuationScheduler,
  ) {}

  /**
   * Attach the listener.
   *
   * `onModuleInit` rather than the constructor: Nest runs every init hook
   * during `app.listen()`, before the HTTP server accepts anything, so there is
   * no window in which an order could be created with nobody listening. Nest
   * instantiates this provider whether or not anything injects it — nothing
   * does — which is the same property `ConfigModule` relies on to make its
   * environment check a boot-time check (`../app.module.ts`).
   */
  onModuleInit(): void {
    this.orderCreated.subscribe(CONTINUATION_NAME, (orderId: string) => {
      this.scheduleDrain(orderId);
    });
  }

  /**
   * Hand one order's queue to the scheduler and return immediately.
   *
   * Returns `void` because `OrderCreatedListener` does
   * (`../orders/order-created-notifier.service.ts`), and that is what keeps this
   * work off `POST /api/orders`' response path — see the header.
   *
   * The result is *reported*, never acted on. Every outcome the pass can end in
   * is ordinary here:
   *
   *   - `queue_empty` with nothing claimed — the common case, and the reason
   *     this logs at `debug`: an order that had no pending events is not news.
   *   - something claimed and settled — the scenario this trigger exists for,
   *     and worth a line naming the order.
   *   - `processing_failed`, or a pass limit — the events involved are still
   *     pending by construction, and the status poll and the admin sweep are
   *     the retry (`architecture.md` §4). Retrying here would be a second,
   *     unbounded policy competing with those two.
   */
  private scheduleDrain(orderId: string): void {
    this.continuations.schedule(
      async () => {
        const result = await this.drain.drainOrder(orderId);

        if (result.claimed === 0) {
          this.logger.debug({
            msg: "order creation drain: nothing was waiting for this order",
            order_id: orderId,
            stopped_by: result.stoppedBy,
          });

          return;
        }

        this.logger.log({
          msg: "order creation drain: applied events that arrived before this order existed",
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
