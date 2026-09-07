/**
 * `suppliers/a` — "The supplier A stub, with its own tables and its own
 * idempotency ledger" (technical-considerations §2.4).
 *
 * ---------------------------------------------------------------------------
 * A MODULE THAT EXPORTS NOTHING, ON PURPOSE
 * ---------------------------------------------------------------------------
 * {@link SupplierKeyClaimService} is provided here and goes no further. The
 * issuance module arriving in Slice 5 must reach supplier A the way the
 * assignment describes — `POST {SUPPLIER_A_URL}/issue`, over real HTTP,
 * parsing an untrusted response (architecture.md §6).
 *
 * Exporting the service would make the in-process shortcut *available*, and a
 * shortcut that is available is a shortcut that eventually gets taken — at which
 * point the shop shares a transaction and a connection with the thing it is
 * supposed to distrust, and every later demonstration becomes theatre: the
 * timeout that cannot happen, the retry that cannot be observed, the fallback
 * that has nothing to fall back from. An empty `exports` is the cheapest way to
 * make the boundary real rather than intended.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MODULE IS UNDER `a/` AND THE SERVICE IS NOT
 * ---------------------------------------------------------------------------
 * There is one key pool and one ledger. `supplier_keys` has no provider column
 * and `supplier_requests` is keyed on `request_id` alone, so Phase 3's supplier
 * B draws from exactly that inventory through exactly that service — which is
 * why it sits at `suppliers/supplier-key-claim.service.ts`, one level up, and
 * says so in its header.
 *
 * What is specific to A is what lives here: an endpoint, and the failure and
 * timeout behaviour injected in front of it. `suppliers/b` will be this file
 * again with a different path and different rates, over the same service.
 *
 * `DatabaseModule` is imported here rather than being global, as `catalog`,
 * `orders` and `payments` do: one line per module, and in exchange the import
 * graph shows which modules touch storage.
 */
import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../database/database.module.js";
import { SupplierKeyClaimService } from "../supplier-key-claim.service.js";
import { SupplierAController } from "./supplier-a.controller.js";

@Module({
  imports: [DatabaseModule],
  controllers: [SupplierAController],
  providers: [SupplierKeyClaimService],
})
export class SupplierAModule {}
