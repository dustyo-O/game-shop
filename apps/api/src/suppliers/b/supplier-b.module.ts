/**
 * `suppliers/b` — the backup supplier stub (technical-considerations §7, *"two
 * stubs, both calling the one `SupplierKeyClaimService`"*).
 *
 * ---------------------------------------------------------------------------
 * A MODULE THAT EXPORTS NOTHING, ON PURPOSE — THE SAME PURPOSE
 * ---------------------------------------------------------------------------
 * `../a/supplier-a.module.ts` gives the argument in full and it is unchanged
 * here: an exported {@link SupplierKeyClaimService} would make the in-process
 * shortcut *available*, and a shortcut that is available is a shortcut that
 * eventually gets taken. The empty `exports` is what makes the shop/supplier
 * boundary real rather than intended, and it matters more for B than for A —
 * B is the supplier the fall-through reaches after a failure, which is exactly
 * the moment somebody is tempted to "just call it directly and be sure".
 *
 * ---------------------------------------------------------------------------
 * THE SERVICE IS LISTED AGAIN, AND IT IS STILL ONE POOL
 * ---------------------------------------------------------------------------
 * {@link SupplierKeyClaimService} appears in this module's `providers` as well
 * as in A's. That gives each module its own *instance* — Nest scopes a provider
 * to the module that declares it — and changes nothing about the guarantees,
 * because **the state is in Postgres, not in the instance.** There is no
 * in-process cache, no in-memory pool and no field holding a claimed key: I5 is
 * `supplier_requests_pkey` and I6 is `supplier_keys_claimed_by_request_id_key`,
 * and two objects issuing statements against one database are exactly as
 * excluded as one object would be. That is the same reason the behaviour table
 * exists rather than a process-memory rate (A6): `pnpm race` runs four
 * processes, so anything that only held between two objects in one process was
 * never protection to begin with.
 *
 * Declaring it here rather than importing A's module is what keeps the two stubs
 * independent — `suppliers/b` must not depend on `suppliers/a` any more than two
 * real suppliers depend on each other.
 *
 * `DatabaseModule` is imported here rather than being global, as every other
 * module that touches storage does: one line per module, and in exchange the
 * import graph shows which modules touch storage.
 */
import { Module } from "@nestjs/common";

import { DatabaseModule } from "../../database/database.module.js";
import { SupplierBehaviourService } from "../supplier-behaviour.service.js";
import { SupplierKeyClaimService } from "../supplier-key-claim.service.js";
import { SupplierBController } from "./supplier-b.controller.js";

@Module({
  imports: [DatabaseModule],
  controllers: [SupplierBController],
  // The same two services A's module lists, declared here rather than imported
  // from it — `suppliers/b` must not depend on `suppliers/a` any more than two
  // real suppliers depend on each other. Two instances, one `supplier_behaviour`
  // table, and the row is what decides anything.
  providers: [SupplierKeyClaimService, SupplierBehaviourService],
})
export class SupplierBModule {}
