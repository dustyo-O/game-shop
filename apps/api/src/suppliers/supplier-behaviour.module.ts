/**
 * `suppliers` — the simulated supplier's control surface, one level above the
 * per-supplier stubs.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN MODULE AND NOT PART OF `SupplierAModule`
 * ---------------------------------------------------------------------------
 * The route is `PUT /internal/suppliers/:provider/behaviour` — one endpoint for
 * every supplier, addressed by a path parameter. `SupplierAModule` is A's stub:
 * its controller is mounted at `internal/suppliers/a` and knows it is A without
 * being told (`./a/supplier-a.controller.ts` states the provider itself rather
 * than reading it out of a body). A shared route has no business inside it, and
 * duplicating the route per supplier would give the reviewer two endpoints that
 * must not drift.
 *
 * Same reason {@link SupplierKeyClaimService} and
 * {@link SupplierBehaviourService} live in this directory rather than under
 * `a/`: there is one key pool, one ledger and one behaviour table, and both
 * stubs reach all three through the same classes.
 *
 * ###########################################################################
 * # A MODULE THAT EXPORTS NOTHING, ON PURPOSE — THE SAME RULE `a/` FOLLOWS.
 * ###########################################################################
 *
 * {@link SupplierBehaviourService} is provided here and goes no further. The
 * shop must not be able to inject it, because the shop is supposed to discover
 * that a supplier is refusing or silent by *being refused or kept waiting* over
 * HTTP. A shop module that could read the behaviour table would know in
 * advance, and every Phase 3 demonstration — the timeout that is not a failure,
 * the re-probe that gets the same code back, the fall-through to B — would be
 * theatre. An empty `exports` is the cheapest way to make that boundary real
 * rather than intended.
 *
 * The stubs get the service the same way they get the claim service: by listing
 * it in their own `providers`. Two instances of a stateless class over one
 * `DATABASE_CLIENT` is not a cost worth an export.
 *
 * ---------------------------------------------------------------------------
 * THE TWO IMPORTS, AND WHAT THEY DO TO THE MODULE DISTANCES
 * ---------------------------------------------------------------------------
 * `ConfigModule` is here for `ADMIN_TOKEN_CONFIG`, which
 * {@link AdminTokenGuard} takes in its constructor. The guard is listed as a
 * provider below for the same reason `AdminModule` lists it: `@UseGuards` with
 * a class reference asks *this* module's injector for an instance, and it does
 * not resolve unless the class is registered here.
 *
 * `DatabaseModule` is here because this module touches storage, and the
 * convention in this codebase is that a module which touches storage says so in
 * its own `imports` (`../database/database.module.ts`).
 *
 * Neither import moves anything. Nest re-parents an already-seen module only
 * when it is re-encountered from a **strictly deeper** importer. This module is
 * imported by `AppModule`, so it sits at distance 2; `ConfigModule` is already
 * at 2 and does not move, and `DatabaseModule` is reached at 3, which is where
 * `PaymentsModule` already put it. `SchedulingModule` therefore stays at 2 and
 * the shutdown order the drain depends on is untouched
 * (`../scheduling/tracked-continuation-scheduler.ts`, `onModuleDestroy`;
 * `../admin/admin.module.ts` makes the same argument at length).
 *
 * ### And it introduces no cycle
 *
 * Both edges point away from here and nothing points back: nothing is exported,
 * and this module is imported only by `AppModule`. Importing
 * {@link AdminTokenGuard} from `../admin/` is a file import, not a module edge
 * — `AdminModule` neither knows nor cares that a second module registers the
 * same guard class.
 */
import { Module } from "@nestjs/common";

import { AdminTokenGuard } from "../admin/admin-token.guard.js";
import { ConfigModule } from "../config/config.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { SupplierBehaviourController } from "./supplier-behaviour.controller.js";
import { SupplierBehaviourService } from "./supplier-behaviour.service.js";
import { SupplierKeyPoolController } from "./supplier-key-pool.controller.js";
import { SupplierKeyPoolService } from "./supplier-key-pool.service.js";

@Module({
  imports: [ConfigModule, DatabaseModule],
  // Two controllers since Phase 6 (spec 006 technical-considerations §2.4):
  // the behaviour route, and the key-pool demo affordances
  // (`POST /internal/suppliers/keys/{drain,restock}`) that stage the empty-pool
  // scenario. Same module because they are the same kind of thing — the
  // supplier's control surface, on the supplier's side of the boundary, behind
  // the same guard — and the argument in this file's header covers both: the
  // shop must never be able to inject either service.
  controllers: [SupplierBehaviourController, SupplierKeyPoolController],
  providers: [SupplierBehaviourService, SupplierKeyPoolService, AdminTokenGuard],
})
export class SupplierBehaviourModule {}
