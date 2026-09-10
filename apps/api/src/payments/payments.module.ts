/**
 * `payments` — "The simulator endpoint, and the webhook receiver that writes to
 * `payment_events`" (technical-considerations §2.4).
 *
 * Both halves exist now. {@link PaymentWebhookController} receives the provider's
 * event at `POST /api/webhooks/payment`, {@link PaymentEventsService} makes it
 * durable (§2.5 step 1), and {@link PaymentEventProcessor} applies it to its
 * order and settles it (§2.5 steps 2 and 7). {@link PaymentSimulatorController}
 * is the provider itself, at `POST /api/payments/:orderId/simulate`.
 *
 * ---------------------------------------------------------------------------
 * THE TWO CONTROLLERS DO NOT KNOW ABOUT EACH OTHER
 * ---------------------------------------------------------------------------
 * They sit in one module because they are one subject, not because either calls
 * the other. {@link PaymentSimulatorService} reaches the webhook **over HTTP**,
 * through the URL in `PAYMENT_WEBHOOK_URL`, exactly as the supplier client will
 * reach the supplier stub that is also hosted here (`architecture.md` §6). So
 * there is no provider wiring between them to get wrong: the simulator has a
 * `fetch` and an address, and could be pointed at a different deployment
 * tomorrow without a line changing.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE NOW IMPORTS `OrdersModule`
 * ---------------------------------------------------------------------------
 * Applying an event means changing an order's status, and `OrdersModule` exports
 * exactly one thing: {@link OrderTransitionService}. There is no exported
 * repository and no injectable `orders` table, so importing it buys this module
 * the *only* way to move an order — a guarded UPDATE that names the states it
 * may leave from (I9). That is the point of the narrow export list: `payments`
 * physically cannot write `orders.status` any other way.
 *
 * ---------------------------------------------------------------------------
 * ONE EXPORT, AND IT IS THE DRAIN
 * ---------------------------------------------------------------------------
 * {@link PaymentEventDrainService} is the only thing this module offers anyone
 * else, because three of `architecture.md` §4's four processing triggers live
 * outside it: a drain when an order is created, a drain on the order status
 * poll, and the admin sweep. Each injects a service that owns the claim rather
 * than writing a second `FOR UPDATE SKIP LOCKED` of its own.
 *
 * ---------------------------------------------------------------------------
 * TWO OF THOSE THREE ARE PROVIDERS *HERE*, NOT IMPORTS *THERE*
 * ---------------------------------------------------------------------------
 * {@link OrderCreationDrain} is trigger 2 — the drain that runs when an order
 * is created, which is what makes a payment reported before its order still
 * deliver (functional spec §2.3). It sits in this module rather than in
 * `orders` because the import that would put it there is a cycle: this module
 * already imports `OrdersModule`, so an `OrdersModule → PaymentsModule` edge
 * closes the loop and `forwardRef()` would tolerate that cycle rather than
 * remove it.
 *
 * So the direction is inverted rather than reversed. `OrdersModule` publishes
 * `OrderCreatedNotifier` — news, not an ability — and this provider subscribes
 * to it in `onModuleInit`. Nothing injects {@link OrderCreationDrain}; Nest
 * instantiates it anyway, as it does every default-scoped provider, which is
 * the same property that makes `ConfigModule`'s environment check a boot-time
 * check. Not a controller and not exported: it is wiring between two things
 * this module can already see.
 *
 * {@link OrderStatusPollDrain} is trigger 3 — the drain that runs when a
 * shopper's own page reads their order — and it is here for the same reason and
 * on the same wiring, subscribing to `OrderPendingEventsNotifier`. The one way
 * it differs is that it is **gated**: `GET /api/orders/:id` is polled once a
 * second per open order page, so the read itself decides whether there is
 * anything to drain and the notifier fires only when there is. That argument,
 * with the measurement behind it, is at the top of
 * `./order-status-poll-drain.ts`.
 *
 * The import graph gained no edge for either of them, which is worth stating
 * plainly because of the rule below — `SchedulingModule` is still imported here
 * and only here among this module's dependents, and its distance from the root
 * is untouched.
 *
 * {@link PaymentEventsService} and {@link PaymentEventProcessor} stay unexported.
 * The inbox writer is not a favour other modules ask for — it is what one HTTP
 * endpoint does — and exporting it would invite a second writer to
 * `payment_events` before there is any reason for one, when I2 is a guarantee
 * about a single statement being the only way in. The processor stays in for a
 * narrower reason: it takes a row that has already been *claimed*, and a caller
 * that could reach it without going through the drain would be processing rows
 * nobody claimed.
 *
 * ---------------------------------------------------------------------------
 * AND WHY IT NOW IMPORTS `IssuanceModule`
 * ---------------------------------------------------------------------------
 * The same reasoning, one step further along §2.5. `OrdersModule` gives this
 * module the transitions of steps 2 and 3; `IssuanceModule` gives it steps 4-6
 * as a single call ({@link IssuanceService.issueForClaimedOrder}) made at the
 * point where {@link PaymentEventProcessor} has just won `paid → delivering`.
 *
 * It exports {@link IssuanceService} and nothing else — in particular not
 * {@link SupplierAClient}, so there is no wiring by which this module could
 * reach a supplier without an attempt row being written first
 * (`../issuance/issuance.module.ts`).
 *
 * ---------------------------------------------------------------------------
 * AND WHY `SchedulingModule` IS IMPORTED **HERE** AND NOWHERE DEEPER
 * ---------------------------------------------------------------------------
 * {@link PaymentWebhookController} no longer awaits the processing it starts:
 * it persists the event, schedules the work through `CONTINUATION_SCHEDULER`,
 * and answers `200` (technical-considerations §2.2). This import is what puts
 * that token in scope.
 *
 * ###########################################################################
 * # THIS LINE BELONGS IN A MODULE `AppModule` IMPORTS DIRECTLY. NOT DEEPER.
 * ###########################################################################
 *
 * Nest destroys modules in ascending distance from the root, so the shutdown
 * drain that waits for in-flight continuations only does any good if
 * `SchedulingModule` is destroyed *before* `DatabaseModule` closes the pool.
 * Measured on this graph:
 *
 *     AppModule=1  SchedulingModule=2  PaymentsModule=2  DatabaseModule=3
 *
 * `SchedulingModule` is pinned at 2 by `AppModule` importing it directly, and
 * Nest's `TopologyTree` re-parents an already-seen module only when it is
 * re-encountered from a *strictly deeper* parent. This module is itself at 2,
 * so importing from here leaves it at 2 and the destroy order intact.
 *
 * The same line in `IssuanceModule` — distance 3, because only this module
 * imports it — would re-parent `SchedulingModule` to 4, behind `DatabaseModule`,
 * and every continuation still mid-query at shutdown would fail against a
 * drained pool. See `../scheduling/tracked-continuation-scheduler.ts`,
 * `onModuleDestroy`, for the rule and the numbers.
 *
 * `DatabaseModule` is imported here rather than being global, as `catalog` and
 * `orders` do: one line per module, and in exchange the import graph shows
 * which modules touch storage.
 */
import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { IssuanceModule } from "../issuance/issuance.module.js";
import { OrdersModule } from "../orders/orders.module.js";
import { SchedulingModule } from "../scheduling/scheduling.module.js";
import { OrderCreationDrain } from "./order-creation-drain.js";
import { OrderStatusPollDrain } from "./order-status-poll-drain.js";
import { PaymentEventDrainService } from "./payment-event-drain.service.js";
import { PaymentEventProcessor } from "./payment-event-processor.service.js";
import { PaymentEventsService } from "./payment-events.service.js";
import { PaymentSimulatorController } from "./payment-simulator.controller.js";
import { PaymentSimulatorService } from "./payment-simulator.service.js";
import { PaymentWebhookController } from "./payment-webhook.controller.js";

@Module({
  imports: [DatabaseModule, SchedulingModule, OrdersModule, IssuanceModule],
  controllers: [PaymentWebhookController, PaymentSimulatorController],
  providers: [
    PaymentEventsService,
    PaymentEventProcessor,
    PaymentEventDrainService,
    PaymentSimulatorService,
    OrderCreationDrain,
    OrderStatusPollDrain,
  ],
  exports: [PaymentEventDrainService],
})
export class PaymentsModule {}
