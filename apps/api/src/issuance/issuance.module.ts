/**
 * `issuance` — "Drive a paid order to `delivered`: call the supplier, record the
 * attempt, bind the delivery" (technical-considerations §2.4).
 *
 * Three imports, and each one is a boundary rather than a convenience:
 *
 *   - **`ConfigModule`** — supplies `SUPPLIER_A_CONFIG`, the address and the
 *     deadline, both validated at boot. This is the first module to inject it,
 *     and the `imports` line is the documentation
 *     (`../config/config.module.ts`, "WHY THIS IS NOT `@Global()`"): which
 *     modules talk to a supplier is exactly the question the shop/supplier
 *     boundary exists to keep answerable.
 *   - **`OrdersModule`** — exports exactly one thing, {@link OrderTransitionService},
 *     so importing it buys this module the *only* way to move an order: a
 *     status-guarded UPDATE naming the states it may leave from (I9). There is
 *     no exported repository and no injectable `orders` table, so `issuance`
 *     physically cannot write `orders.status` any other way.
 *   - **`DatabaseModule`** — `issuance_attempts` and `deliveries` are this
 *     module's own tables to write.
 *
 * **What is deliberately absent: `SupplierAModule`.** The supplier is reached
 * over HTTP through `SUPPLIER_A_URL`, never through this container
 * (`architecture.md` §6). It exports nothing, so the wiring does not exist to be
 * added by accident — and if someone made it exist, this file is where the
 * mistake would be visible.
 *
 * {@link IssuanceService} is exported and {@link SupplierAClient} is not.
 * `payments` needs the whole of §2.5 steps 4-6 as one call at the seam it left;
 * a module that could reach the supplier client directly could call a supplier
 * without recording an attempt first, which is the one ordering this slice
 * exists to guarantee.
 */
import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { OrdersModule } from "../orders/orders.module.js";
import { IssuanceService } from "./issuance.service.js";
import { SupplierAClient } from "./supplier-a.client.js";

@Module({
  imports: [ConfigModule, DatabaseModule, OrdersModule],
  providers: [IssuanceService, SupplierAClient],
  exports: [IssuanceService],
})
export class IssuanceModule {}
