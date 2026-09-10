/**
 * **"An order now exists."** One fact, announced by the only place that can
 * know it first-hand, and listened to from *outside* this module.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS: THE IMPORT THAT WOULD HAVE BEEN A CYCLE
 * ---------------------------------------------------------------------------
 * `architecture.md` §4's second processing trigger is *"order creation drains
 * any events already waiting for that order id"*. The obvious way to build it
 * is to inject `PaymentEventDrainService` into {@link OrdersService} and call
 * it — and that import cannot be written:
 *
 *     PaymentsModule ──imports──▶ OrdersModule      (already true: applying an
 *                                                    event moves an order, and
 *                                                    `OrderTransitionService`
 *                                                    is the only way to do it)
 *     OrdersModule   ──imports──▶ PaymentsModule    (what the trigger wants)
 *
 * That is a cycle, and Nest's answer to a cycle — `forwardRef()` on both
 * sides — is a way of *tolerating* one, not of not having one. The design
 * question underneath it is the part worth getting right: **`orders` has no
 * business knowing that a payment inbox exists.** Creating an order is complete
 * on its own terms the moment the row is committed; that some other module
 * keeps a queue keyed on `order_id` is that module's affair.
 *
 * So the arrow is not added. It is *inverted*. This module states a fact about
 * its own domain, and the module that cares subscribes to it — which it can do
 * without a single new import, because `payments` already depends on `orders`
 * and not the other way round. The listener is
 * `../payments/order-creation-drain.ts`, and it is the only one today.
 *
 * ###########################################################################
 * # NOTHING HERE IS A GUARANTEE, AND NOTHING MAY EVER BE BUILT ON IT AS ONE.
 * ###########################################################################
 *
 * This is an in-process array of callbacks. It lives in one serverless
 * instance's memory, it is empty in every other instance, and it is gone the
 * moment the process is. That is exactly the shape the project's governing rule
 * forbids for a *correctness* mechanism — "every guarantee is enforced by the
 * database, never by a check-then-act in application code and never by an
 * in-process lock" (`architecture.md` §3) — and it is fine here for one reason,
 * which has to stay true of anything added to this file: **losing a
 * notification costs latency and never a key.**
 *
 * The event the listener goes looking for is a row in `payment_events` with
 * `processed_at` NULL. It stays there, in the partial index, whether or not
 * anybody was listening — and `architecture.md` §4 lists four processing
 * triggers precisely so that no single one is load-bearing. Drop this one and
 * the shopper's key arrives on their next status poll instead of a few
 * milliseconds after creation. Nothing is lost; something is late.
 *
 * ---------------------------------------------------------------------------
 * A NOTIFIER, DELIBERATELY NOT AN EVENT BUS
 * ---------------------------------------------------------------------------
 * One event, one payload, one file that publishes it, and subscribers named at
 * registration. No topic strings, no wildcard subscriptions, no ordering
 * promises, no `@nestjs/event-emitter` dependency. The whole value of the
 * inversion is that the graph stays readable — a general bus would replace one
 * unwritable import with an unanswerable question ("who reacts to this?"), and
 * that is a worse trade than the import would have been.
 */
import { Injectable, Logger } from "@nestjs/common";

/**
 * What a listener is handed: the id of an order that **is committed** and
 * visible to every other connection.
 *
 * ### The return type is `void`, and that is the load-bearing part
 *
 * The same reasoning as `ContinuationScheduler.schedule`
 * (`../scheduling/continuation-scheduler.ts`): a listener that could hand back
 * a promise is a listener {@link OrderCreatedNotifier.notify} could be made to
 * `await`, and one `await` is all it would take to put a supplier round trip
 * back on `POST /api/orders`' response path — the very thing Slice 2 removed
 * from the webhook. There is nothing to await, so it cannot be reintroduced by
 * accident.
 *
 * A listener that wants to do slow work therefore has exactly one honest option:
 * schedule it (see `../payments/order-creation-drain.ts`).
 */
export type OrderCreatedListener = (orderId: string) => void;

/** One registration, kept with its name so a failure can be attributed. */
interface OrderCreatedSubscription {
  readonly name: string;
  readonly listener: OrderCreatedListener;
}

@Injectable()
export class OrderCreatedNotifier {
  private readonly logger = new Logger(OrderCreatedNotifier.name);

  private readonly subscriptions: OrderCreatedSubscription[] = [];

  /**
   * Register interest in orders coming into existence.
   *
   * Called from a subscriber's `onModuleInit`, which Nest runs during
   * `app.listen()` — before the first request is served, so no order can be
   * created between the container being built and the listener being attached.
   *
   * `name` is not decoration: it is what a failed listener is called in the log
   * line below, and what a reader greps for to find the subscriber from here.
   */
  subscribe(name: string, listener: OrderCreatedListener): void {
    this.subscriptions.push({ name, listener });

    this.logger.log({
      msg: "order created notifier: listener registered",
      listener: name,
      listeners: this.subscriptions.length,
    });
  }

  /**
   * Announce a committed order to every listener — **synchronously, and never
   * throwing.**
   *
   * Both properties are for the benefit of the caller,
   * {@link OrdersService.createOrder}, which is on the request path of
   * `POST /api/orders`:
   *
   *   - **Synchronous and `void`.** There is no promise for creation to wait on,
   *     so a listener cannot slow the `201` down however slow its own work is.
   *     What it costs the response is the loop below: one array iteration and
   *     one function call per listener.
   *   - **Never throws.** A listener is a bystander to the order it is told
   *     about. Turning a bystander's failure into a `500` would fail a purchase
   *     that has already succeeded and been written down — the response would
   *     say the order does not exist while the row says it does, which is the
   *     worst answer available. So a throw is caught, logged with the order it
   *     concerned, and the next listener still runs.
   */
  notify(orderId: string): void {
    for (const { name, listener } of this.subscriptions) {
      try {
        listener(orderId);
      } catch (error: unknown) {
        this.logger.error({
          msg: "order created notifier: a listener threw; the order itself is unaffected",
          listener: name,
          order_id: orderId,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      }
    }
  }
}
