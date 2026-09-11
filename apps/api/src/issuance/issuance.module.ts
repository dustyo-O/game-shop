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
 *   - **`OrdersModule`** — exports the two halves of invariant I4 and nothing
 *     else that touches an order. {@link OrderTransitionService} is the *only*
 *     way to move one: a status-guarded UPDATE naming the states it may leave
 *     from (I9). {@link OrderLockService} is the `SELECT … FOR UPDATE` that
 *     serialises workers across the several statements of §2.5 steps 5-6
 *     (`architecture.md` §3.1). There is still no exported repository and no
 *     injectable `orders` table, so `issuance` physically cannot write
 *     `orders.status` any other way — the lock widens what this module can
 *     *serialise*, never what it can write.
 *   - **`DatabaseModule`** — `issuance_attempts` and `deliveries` are this
 *     module's own tables to write.
 *
 * **What is deliberately absent: `SupplierAModule` and `SupplierBModule`.** The
 * suppliers are reached over HTTP through `SUPPLIER_A_URL` and `SUPPLIER_B_URL`,
 * never through this container (`architecture.md` §6). They export nothing, so
 * the wiring does not exist to be added by accident — and if someone made it
 * exist, this file is where the mistake would be visible.
 *
 * **{@link IssuanceRunnerService} is the only export, and that is the point.**
 * `payments` needs the whole of §2.5 steps 3-6 as one call at the seam it left,
 * and the runner is the single entry point that performs the claim, the ladder
 * walk and the settlement (spec 003 §0). Exporting {@link IssuanceService}
 * alongside it would publish a way to call a supplier *without* the claim, the
 * lock or the ladder — which is precisely the ordering this module exists to
 * guarantee — and exporting {@link IssuanceHistory} would publish the ladder's
 * inputs to a caller with no reason to hold the lock while it read them (R4).
 * Slice 5's operator retry calls the same exported runner rather than a second
 * path of its own.
 *
 * ---------------------------------------------------------------------------
 * ONE CLIENT CLASS, ONE PROVIDER PER SUPPLIER
 * ---------------------------------------------------------------------------
 * {@link SupplierClient} takes its provider tag and its endpoint config as
 * constructor arguments, so it is registered under a named token
 * (`SUPPLIER_A_CLIENT`, `SUPPLIER_B_CLIENT`) rather than under its own class.
 * Adding supplier B was one more line of exactly A's shape, which is what the
 * generalisation was for: the second supplier changed no statement, no
 * transaction and no invariant. What decides whether B is *reached* lives
 * entirely in `./issuance-ladder.ts`, and `ConfigModule` is what proves
 * `SUPPLIER_B_URL` is a real `http(s)` address at boot rather than at the first
 * fall-through, on a paid order (R9).
 */
import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { OrdersModule } from "../orders/orders.module.js";
import { IssuanceHistory } from "./issuance-history.js";
import { IssuanceRunnerService } from "./issuance-runner.service.js";
import { IssuanceService } from "./issuance.service.js";
import { supplierAClientProvider, supplierBClientProvider } from "./supplier.client.js";

@Module({
  imports: [ConfigModule, DatabaseModule, OrdersModule],
  providers: [
    IssuanceRunnerService,
    IssuanceService,
    IssuanceHistory,
    supplierAClientProvider,
    supplierBClientProvider,
  ],
  exports: [IssuanceRunnerService],
})
export class IssuanceModule {}
