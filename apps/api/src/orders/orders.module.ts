/**
 * `orders` — "Create orders; read order state; **own the status transition
 * helper that every other module calls**" (technical-considerations §2.4).
 *
 * All three exist now. {@link OrdersService} creates orders behind
 * `POST /api/orders` and reads them back behind `GET /api/orders/:id` — the
 * endpoint the status page polls; {@link OrderTransitionService} is the single
 * place any status changes, and it is what `payments` and `issuance` will
 * import.
 *
 * The export list is the point: {@link OrderTransitionService} leaves this
 * module, and nothing else does. A module that wants to advance an order
 * imports `OrdersModule` and gets exactly one way to do it — there is no
 * exported repository, no injectable `orders` table, nothing that would let a
 * status be written without a source-state guard. {@link OrdersService} stays
 * unexported for the same reason: creating an order is something the HTTP
 * endpoint does, not a favour other modules ask for.
 */
import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { OrderTransitionService } from "./order-transition.service.js";
import { OrdersController } from "./orders.controller.js";
import { OrdersService } from "./orders.service.js";

@Module({
  imports: [DatabaseModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrderTransitionService],
  exports: [OrderTransitionService],
})
export class OrdersModule {}
