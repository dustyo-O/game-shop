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
 * Nothing is exported from here. The inbox writer and the processor are not
 * favours other modules ask for — they are what one HTTP endpoint does — and the
 * Phase 2 drain will own its own claiming query with its own
 * `FOR UPDATE SKIP LOCKED`. Exporting {@link PaymentEventsService} would invite
 * a second writer to `payment_events` before there is any reason for one, and I2
 * is a guarantee about a single statement being the only way in.
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
 * `DatabaseModule` is imported here rather than being global, as `catalog` and
 * `orders` do: one line per module, and in exchange the import graph shows
 * which modules touch storage.
 */
import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { IssuanceModule } from "../issuance/issuance.module.js";
import { OrdersModule } from "../orders/orders.module.js";
import { PaymentEventProcessor } from "./payment-event-processor.service.js";
import { PaymentEventsService } from "./payment-events.service.js";
import { PaymentSimulatorController } from "./payment-simulator.controller.js";
import { PaymentSimulatorService } from "./payment-simulator.service.js";
import { PaymentWebhookController } from "./payment-webhook.controller.js";

@Module({
  imports: [DatabaseModule, OrdersModule, IssuanceModule],
  controllers: [PaymentWebhookController, PaymentSimulatorController],
  providers: [PaymentEventsService, PaymentEventProcessor, PaymentSimulatorService],
})
export class PaymentsModule {}
