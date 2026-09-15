/**
 * `demo` — the one module allowed to empty the shop.
 *
 * One route: `POST /api/admin/demo/reset` (`./demo-reset.controller.ts`), spec
 * 006 functional spec §2.3's whole-shop reset, behind the same bearer token as
 * `../admin/`. It is a demo affordance in the register that
 * `../admin/promo-codes-reset.controller.ts` opened, and it is filed here
 * rather than there for a reason that is about *writes*, not routes.
 *
 * ###########################################################################
 * # WHY THIS IS NOT `AdminModule`
 * ###########################################################################
 *
 * `../admin/admin.module.ts`'s header is an argument about what that module
 * cannot do, and the argument is load-bearing: it *"still cannot write
 * `orders.status` by any route"* — the only transition it causes goes through
 * `IssuanceModule`'s exported runner — and it uses `DATABASE_CLIENT` for
 * *"one `SELECT` (the recovery list) and — since spec 005 — one `UPDATE`, the
 * promo reset, which writes `promo_codes.used_count` and nothing else"*. Nor,
 * it says, can it write the promo ledger. Every sentence of that header was
 * written so a reviewer can read the operator's surface and know its blast
 * radius is one column.
 *
 * A reset that deletes six tables and clears every key claim is the thing
 * that argument excludes. Putting it in `admin/` would not extend the
 * header; it would falsify it, and the header's own convention for a
 * sentence that stops being true is to remove it *"rather than left to
 * quietly stop being true"*. The alternative is a second module whose header
 * says the opposite thing honestly: **this module can write every shop
 * table and both supplier tables, and that is the whole of what it is for.**
 * `AdminModule` keeps its argument; `DemoModule` carries the licence; and a
 * reviewer who wants to know what the admin token can destroy reads this
 * file, which is short.
 *
 * `POST /api/admin/promo-codes/reset` stays where it is — a check's per-run
 * precondition, one column — and the demo reset is the operator's whole-shop
 * action. Same token, same path prefix, different module, because the prefix
 * says who may call it and the module says what it may touch.
 *
 * ---------------------------------------------------------------------------
 * THE SEED-SIBLING LICENCE: WHY THIS MODULE MAY WRITE BOTH SIDES OF THE
 * SUPPLIER BOUNDARY
 * ---------------------------------------------------------------------------
 * `packages/db/src/schema/supplier.ts` draws a line the rest of `src/` never
 * crosses: shop modules do not import the supplier tables, and the supplier
 * stubs (`../suppliers/`) do not import the shop's. The shop is supposed to
 * distrust its suppliers, and it can only do that if it reaches them over
 * HTTP and never over a shared table. `packages/db/src/seed.ts` is the one
 * file that writes both, and it says why that is not a breach: *"It is the
 * loader, not a participant: it runs before the system starts and never
 * during a request."*
 *
 * This module is the seed's sibling in exactly that sense. It restores the
 * state the seed created — the same fifty keys unclaimed, the same two
 * behaviour rows at rest, the same four codes at `0` — and it does so as an
 * operator's action on the whole shop, never on behalf of a request the shop
 * is serving. It knows nothing a shop module must not know: it cannot read a
 * supplier's behaviour to decide anything, it cannot claim a key, it cannot
 * answer an issuance. It puts the fixture back. That is the licence, and it
 * is the same one the harness's `cleanupTestOrders` uses to release the
 * claims a test made — scoped there to the test's own request ids, scoped
 * here to the transaction that deletes every delivery (`./demo-reset.service.ts`).
 *
 * Nothing about that licence leaks: this module exports nothing, so no shop
 * module can inject {@link DemoResetService} and acquire a route into the
 * supplier's tables by proximity. The boundary the seed honours is the one
 * this module honours — both sides written, by nobody the shop can call.
 *
 * ---------------------------------------------------------------------------
 * THE TWO IMPORTS, THE GUARD AS A PROVIDER
 * ---------------------------------------------------------------------------
 * `ConfigModule` is here for `ADMIN_TOKEN_CONFIG`, which {@link AdminTokenGuard}
 * takes in its constructor. The guard is listed as a provider below for the
 * reason `AdminModule` and `SupplierBehaviourModule` list it: `@UseGuards`
 * with a class reference asks *this* module's injector for an instance, and
 * it does not resolve unless the class is registered here. Importing the
 * class from `../admin/` is a file import, not a module edge — `AdminModule`
 * neither knows nor cares that a third module registers the same guard.
 *
 * `DatabaseModule` is here because this module touches storage, and the
 * convention in this codebase is that a module which touches storage says so
 * in its own `imports` (`../database/database.module.ts`). It touches more of
 * it than any other module, which is the point of the header above.
 *
 * It does **not** import `SchedulingModule`: the reset does its work before
 * answering, inside one transaction, and has nothing to schedule. Nor
 * `OrdersModule`, `PaymentsModule` or `IssuanceModule`: the reset never
 * transitions an order, it deletes them, and the only thing it needs from the
 * container is the connection.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE TWO IMPORTS DO TO THE MODULE DISTANCES — READ OUT AFTER BOOT
 * ---------------------------------------------------------------------------
 * Nest destroys modules in ascending distance from the root, and
 * `SchedulingModule` (2) must be destroyed before `DatabaseModule` (3) or its
 * shutdown drain runs against a closed pool
 * (`../scheduling/tracked-continuation-scheduler.ts`, `onModuleDestroy`).
 * Nest's `TopologyTree` re-parents an already-seen module only when it is
 * re-encountered from a **strictly deeper** importer. This module is imported
 * by `AppModule`, so it sits at 2, and its two edges each offer distance 3:
 * `ConfigModule` is at 4 (re-parented long ago by `IssuanceModule`; 3 is not
 * deeper than 4, and the tree keeps the deeper link), `DatabaseModule` is at
 * 3 (3 is not strictly deeper than 3). Neither moves.
 *
 * **Measured, not only reasoned about.** `createApp()` from the compiled
 * `dist/` was booted with this module registered, `app.init()` run, and
 * every module's `distance` read out of `app.get(ModulesContainer)`
 * (`@nestjs/core` 11.2.3 installed), sorted by distance:
 *
 *     AppModule                  1
 *     AdminModule                2      SchedulingModule           2
 *     CatalogModule              2      SupplierAModule            2
 *     DemoModule                 2      SupplierBModule            2
 *     PaymentsModule             2      SupplierBehaviourModule    2
 *     PromoModule                2
 *     DatabaseModule             3      IssuanceModule             3
 *     ConfigModule               4      OrdersModule               4
 *
 * `SchedulingModule` 2 < `DatabaseModule` 3, with `DemoModule` in the graph,
 * so the shutdown drain still runs before the pool closes. The table is
 * `admin.module.ts`'s with two rows added since it was measured —
 * `PromoModule` (spec 005) and this module — and every other number
 * unchanged.
 *
 * ### And it introduces no cycle
 *
 * Both edges point away from here and nothing points back: nothing is
 * exported, and `demo` is imported only by `AppModule`.
 */
import { Module } from "@nestjs/common";

import { AdminTokenGuard } from "../admin/admin-token.guard.js";
import { ConfigModule } from "../config/config.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { DemoResetController } from "./demo-reset.controller.js";
import { DemoResetService } from "./demo-reset.service.js";

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [DemoResetController],
  // The guard is a provider, not only a decorator argument (header).
  // `DemoResetService` is a provider and deliberately **not** an export: it
  // exists to be served by the controller beside it, and exporting it would
  // give the shop a path to a write that only the operator may make — the
  // one thing this module must not become.
  providers: [DemoResetService, AdminTokenGuard],
})
export class DemoModule {}
