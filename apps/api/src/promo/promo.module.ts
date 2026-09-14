/**
 * `promo` — the shop's promo codes: the redemption transaction and the one
 * route that reaches it (spec 005, technical-considerations §2.2–2.3).
 *
 * One route, `POST /api/orders/:orderId/promo`, and one provider,
 * {@link PromoRedemptionService}, whose single method is the transaction the
 * whole phase is about: lock the order, decide every refusal, take one use of
 * the limit with a conditional `UPDATE`, write the ledger row, reprice, commit.
 * `./promo-discount.ts` and `./promo-code.ts` are pure functions beside it and
 * need no provider.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN MODULE AND NOT A CONTROLLER INSIDE `orders`
 * ---------------------------------------------------------------------------
 * The route is mounted under `/api/orders`, and the obvious home for it is
 * `OrdersModule`. It is not there, for the reason that module's header gives
 * for the shape of its export list: `OrdersModule` promises that nothing
 * outside it can write an order without a source-state guard inside the
 * statement, and the way it keeps that promise is by exporting exactly two
 * guarded writers, the lock they run under, and one reader. A redemption is a
 * consumer of that promise, not a part of it — it writes two tables of its
 * own and touches `orders` only through {@link OrderRepricingService}, the
 * exported guarded writer. Putting it inside `orders` would give it the
 * unexported `orders` table by proximity; putting it here means the type
 * system, not discipline, is what keeps `set({ amountMinor })` to one method
 * in one directory.
 *
 * ###########################################################################
 * # A MODULE THAT EXPORTS NOTHING, ON PURPOSE.
 * ###########################################################################
 *
 * {@link PromoRedemptionService} is provided here and goes no further. There is
 * one way to spend a use of a code — over HTTP, through the controller beside
 * it, under the order lock — and no other module has a reason to inject the
 * transaction and run it under a different lock discipline or none. The
 * reviewer's counter reset (Slice 3, `admin/`) will be a separate statement
 * behind the admin guard and will not import this module either: it zeroes a
 * column, it does not redeem.
 *
 * ---------------------------------------------------------------------------
 * THE TWO IMPORTS, AND WHAT THEY DO TO THE MODULE DISTANCES
 * ---------------------------------------------------------------------------
 * `DatabaseModule` is here because this module touches storage, and the
 * convention in this codebase is that a module which touches storage says so
 * in its own `imports` (`../database/database.module.ts`): the transaction
 * opens on `DATABASE_CLIENT`.
 *
 * `OrdersModule` gives it three of that module's six exports —
 * {@link OrderLockService} for step 1, {@link OrderRepricingService} for step
 * 7, and {@link OrderViewService} for the controller's read *after* `COMMIT`
 * (`../orders/order-view.service.ts` says why that reader takes no `tx` and
 * must never be called inside the transaction). `OrderTransitionService` and
 * the two notifiers are exported to this module as well and deliberately
 * unused: a promo changes what an order costs, never what state it is in.
 *
 * Neither import moves anything, and the check is the one
 * `../admin/admin.module.ts` makes for its edges, against the table it
 * measured. Nest destroys modules in ascending distance from the root, and
 * `SchedulingModule` (distance 2) must be destroyed before `DatabaseModule`
 * (distance 3) or its shutdown drain runs against a closed pool
 * (`../scheduling/tracked-continuation-scheduler.ts`, `onModuleDestroy`).
 * Nest's `TopologyTree` re-parents an already-seen module only when it is
 * re-encountered from a **strictly deeper** importer. This module is imported
 * by `AppModule`, so it sits at 2, and its two edges each offer distance 3:
 *
 *   - `DatabaseModule` is already at 3 (reached from `CatalogModule`,
 *     `OrdersModule`, `PaymentsModule`, `AdminModule`, both supplier modules
 *     — all at 2). 3 is not strictly deeper than 3, so it does not move.
 *   - `OrdersModule` is at **4** on the measured table, not 2: it was
 *     re-parented long ago by `IssuanceModule` (at 3, reached from
 *     `PaymentsModule`), which imports it. An edge from 2 offers it 3, which
 *     is shallower than where it already is, so it does not move, and neither
 *     does anything behind it (`ConfigModule` at 4, `DatabaseModule` at 3).
 *
 * `SchedulingModule` therefore stays at 2 with `DatabaseModule` behind it at
 * 3, and the destroy order the drain depends on is untouched. This is
 * reasoned against `admin.module.ts`'s measured table with the same rule it
 * applied, not re-measured; the shape that *would* break it — importing
 * `DatabaseModule` from somewhere deeper than 3 — is not one this module has.
 *
 * ### And it introduces no cycle
 *
 * Both edges point away from here and nothing points back: nothing is
 * exported, and this module is imported only by `AppModule`. `orders` has no
 * reason to know a promo exists — its view will read the ledger table through
 * the shared schema (task 3), which is a file import from `@game-shop/db`,
 * not a module edge.
 */
import { Module } from "@nestjs/common";

import { DatabaseModule } from "../database/database.module.js";
import { OrdersModule } from "../orders/orders.module.js";
import { PromoRedemptionService } from "./promo-redemption.service.js";
import { PromoController } from "./promo.controller.js";

@Module({
  imports: [DatabaseModule, OrdersModule],
  controllers: [PromoController],
  // Provided, deliberately not exported — see the header.
  providers: [PromoRedemptionService],
})
export class PromoModule {}
