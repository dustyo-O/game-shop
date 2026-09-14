/**
 * **"This order has events waiting to be applied to it, and it can still
 * move."** One fact, announced by the status read that already established it,
 * and listened to from *outside* this module.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SECOND NOTIFIER AND NOT A SECOND CALL TO THE FIRST ONE
 * ---------------------------------------------------------------------------
 * `./order-created-notifier.service.ts` is the same shape, and reusing it was
 * the first thing tried. It does not fit, for a reason that is the whole point
 * of this trigger rather than a matter of taste:
 *
 *   - **The facts are different, and so are their audiences.**
 *     `OrderCreatedNotifier` says *an order now exists* — true exactly once per
 *     order, and true whether or not anything is pending. This says *there is
 *     pending work for an order that can still move* — a different claim, and
 *     one that is false on almost every poll.
 *   - **Its listener drains unconditionally, and must go on doing so.**
 *     {@link OrderCreationDrain} exists precisely to look for an event that may
 *     not be there (`../payments/order-creation-drain.ts`). Publishing every
 *     status poll through it would run that unconditional drain **once a second
 *     per open order page** — a `BEGIN` / `SELECT … FOR UPDATE SKIP LOCKED` /
 *     `COMMIT` per viewer per second, holding this instance's single pooled
 *     connection each time. Avoiding exactly that is what this trigger's gate is
 *     for, so routing through the ungated listener would defeat the design by
 *     construction.
 *   - **The log lines have to stay apart.** `architecture.md` §4 lists four
 *     processing triggers so that no one of them is load-bearing; if triggers 2
 *     and 3 wrote the same line, "which trigger settled this order?" would stop
 *     being answerable from the log.
 *
 * So: two facts, two publishers, two subscribers, two names in the log. The
 * duplication between this file and its sibling is four lines of class body,
 * and the project's own stance on that is already written down in
 * `./orders.service.ts` (`toCurrency`): *the duplication is deliberate rather
 * than overlooked; whoever writes the third copy has earned the refactor.*
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PUBLISHER KNOWS, AND WHY IT KNOWS IT WITHOUT A SECOND QUERY
 * ---------------------------------------------------------------------------
 * {@link OrderViewService.findOrder} is the polled statement, and it now selects
 * one more expression: a `CASE` over an `EXISTS` against
 * `payment_events_unprocessed_order_idx`. So "is there pending work here?" is
 * answered inside the round trip the poll was making anyway, and this notifier
 * fires only when the answer is yes — never speculatively.
 *
 * That the predicate names a table belonging to `payments` is a real cost and
 * is argued where it is paid, on `findOrder` itself. What this file is careful
 * *not* to do is turn that into a dependency: the payload is an order id and
 * nothing else, and this module still has no idea what a subscriber does with
 * it.
 *
 * ###########################################################################
 * # NOTHING HERE IS A GUARANTEE, AND NOTHING MAY EVER BE BUILT ON IT AS ONE.
 * ###########################################################################
 *
 * The same standing rule as its sibling, and it holds here for the same reason.
 * This is an in-process array of callbacks: one serverless instance's memory,
 * empty in every other instance, gone when the process is. `architecture.md` §3
 * forbids that shape for a *correctness* mechanism — and permits it here
 * because **losing a notification costs latency and never a key.** The pending
 * row stays in `payment_events` with `processed_at` NULL whether or not anybody
 * listened, and the admin sweep (trigger 4) is behind it.
 */
import { Injectable, Logger } from "@nestjs/common";

/**
 * What a listener is handed: the id of an order that, **as of the read that
 * published this**, was still in flight and had at least one unprocessed
 * `payment_events` row naming it.
 *
 * "As of" is the honest tense and the reason nothing downstream may treat this
 * as an instruction. Between the read and the listener running, another worker
 * may have claimed and settled that event, or the order may have finished
 * moving. A drain that finds nothing is therefore an ordinary outcome here, not
 * a contradiction — which is exactly how `../payments/order-status-poll-drain.ts`
 * reports it.
 *
 * ### The return type is `void`, and that is the load-bearing part
 *
 * The same reasoning as `OrderCreatedListener` and as
 * `ContinuationScheduler.schedule`: a listener that could hand back a promise is
 * a listener {@link OrderPendingEventsNotifier.notify} could be made to `await`,
 * and one `await` is all it would take to put a supplier round trip on the
 * response path of the endpoint the shopper's page calls **once a second**.
 * There is nothing to await, so it cannot be reintroduced by accident.
 */
export type OrderPendingEventsListener = (orderId: string) => void;

/** One registration, kept with its name so a failure can be attributed. */
interface OrderPendingEventsSubscription {
  readonly name: string;
  readonly listener: OrderPendingEventsListener;
}

@Injectable()
export class OrderPendingEventsNotifier {
  private readonly logger = new Logger(OrderPendingEventsNotifier.name);

  private readonly subscriptions: OrderPendingEventsSubscription[] = [];

  /**
   * Register interest in orders that have unapplied events waiting for them.
   *
   * Called from a subscriber's `onModuleInit`, which Nest runs during
   * `app.listen()` — before the first request is served, so no poll can happen
   * between the container being built and the listener being attached.
   *
   * `name` is not decoration: it is what a failed listener is called in the log
   * line below, and what a reader greps for to find the subscriber from here.
   */
  subscribe(name: string, listener: OrderPendingEventsListener): void {
    this.subscriptions.push({ name, listener });

    this.logger.log({
      msg: "order pending events notifier: listener registered",
      listener: name,
      listeners: this.subscriptions.length,
    });
  }

  /**
   * Announce one order's pending work to every listener — **synchronously, and
   * never throwing.**
   *
   * Both properties are for the benefit of the caller,
   * {@link OrderViewService.findOrder}, which is on the response path of the
   * endpoint `apps/web` polls once a second per open order page:
   *
   *   - **Synchronous and `void`.** There is no promise for the poll to wait on,
   *     so a listener cannot slow the `200` down however slow its own work is —
   *     and today's listener schedules a drain that reaches a supplier over
   *     HTTP. What it costs the response is the loop below: one array iteration
   *     and one function call per listener.
   *   - **Never throws.** A listener is a bystander to the order it is told
   *     about. Turning a bystander's failure into a `500` would break the page
   *     of a shopper whose order is perfectly fine — and break it *repeatedly*,
   *     because the page would ask again a second later. So a throw is caught,
   *     logged with the order it concerned, and the next listener still runs.
   */
  notify(orderId: string): void {
    for (const { name, listener } of this.subscriptions) {
      try {
        listener(orderId);
      } catch (error: unknown) {
        this.logger.error({
          msg: "order pending events notifier: a listener threw; the order read is unaffected",
          listener: name,
          order_id: orderId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    }
  }
}
