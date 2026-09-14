/**
 * `admin` — the operator's surface, behind one shared bearer token
 * (`architecture.md` §6).
 *
 * Four routes:
 *
 *   - `POST /api/admin/payment-events/sweep` — `architecture.md` §4's fourth
 *     processing trigger, the backstop for everything the other three missed;
 *   - `GET /api/admin/orders/undelivered` — spec 003 §2.4's list of every order
 *     that was paid for and is holding no key;
 *   - `POST /api/admin/orders/:orderId/retry` — spec 003 §2.5's manual retry of
 *     one of them;
 *   - `POST /api/admin/promo-codes/reset` — spec 005 §2.3's demo affordance:
 *     zero every promo counter and leave the ledger, so `pnpm race promo` can
 *     run twice against a deployed shop whose database the check cannot reach.
 *     The one route here that is a knob for a check rather than an operator's
 *     tool, and the one that is never called locally
 *     (`./promo-codes-reset.controller.ts`).
 *
 * They want the same guard in front of them, which is the reason this is a
 * module rather than one more controller filed under `payments`.
 *
 * ---------------------------------------------------------------------------
 * THE IMPORT GRAPH IS THE DOCUMENTATION, AND IT SAYS THREE THINGS
 * ---------------------------------------------------------------------------
 * `ConfigModule` gives this module `ADMIN_TOKEN_CONFIG` — a value already
 * proven usable while the container was built, so {@link AdminTokenGuard} has
 * no checking left to do at request time.
 *
 * `PaymentsModule` gives it `PaymentEventDrainService`, that module's only
 * export, deliberately so: the three triggers that live outside `payments`
 * inject the service that owns the claim rather than writing a second
 * `FOR UPDATE SKIP LOCKED` of their own.
 *
 * `IssuanceModule` is the line slice 5 adds, and it is the most important
 * import in the file: it supplies {@link IssuanceRunnerService}, that module's
 * only export, which is the **identical** claim-under-lock and ladder walk the
 * automatic path uses. The operator's retry calls it and adds nothing — no
 * second lock, no second claim, no supplier client. `IssuanceModule` exports
 * neither `IssuanceService` nor `IssuanceHistory`, so an admin-only path into
 * issuance cannot be assembled from this injector even deliberately.
 *
 * `DatabaseModule` was added by slice 4, and it is added rather than
 * worked around. The convention in this codebase is that a module which touches
 * storage says so in its own `imports` (`../database/database.module.ts`), and
 * as of {@link UndeliveredOrdersService} this one does. The previous version of
 * this comment said *"this module writes no SQL at all"*; that sentence has been
 * removed rather than left to quietly stop being true.
 *
 * ### Why the report is not a service exported by `OrdersModule`
 *
 * Technical-considerations §8 anticipated `OrdersModule` and `IssuanceModule`
 * appearing in this list. `IssuanceModule` now does, for the reason above.
 * **`OrdersModule` deliberately does not**: this module still has no way to
 * write `orders.status`, because the only transition it causes is the one the
 * runner makes on the other side of that export. The list query is a different
 * matter again, and it is filed here for two reasons:
 *
 *   - **No domain module owns the question.** It reads `orders`, `products`,
 *     `payment_events`, `issuance_attempts` and `deliveries` — four modules'
 *     tables — and it is not a fact about any one of those domains. It is a fact
 *     about the shop's unfinished business, which is what an operator's surface
 *     is for.
 *   - **`OrdersModule`'s export list is an argument**, and it is a short one on
 *     purpose: a module that wants to advance an order gets exactly one way to
 *     do it, with no exported repository and nothing that would let a status be
 *     written without a source-state guard. Adding a reader of
 *     `issuance_attempts` to that list would blunt the argument for a query that
 *     has no reason to be in it.
 *
 * What this module gains is `DATABASE_CLIENT`, a handle it uses for one
 * `SELECT` (the recovery list) and — since spec 005 — one `UPDATE`, the promo
 * reset, which writes `promo_codes.used_count` and nothing else. The previous
 * version of this sentence called it *"a **read** handle"*; that word has been
 * removed rather than left to quietly stop being true. It still cannot write
 * `orders.status` by any route: that goes through `OrderTransitionService`,
 * which this module does not import and will not. Nor can it write the promo
 * ledger: `promo_redemptions` is written under the order lock by
 * `PromoRedemptionService` alone, and the reset's whole argument is that it
 * leaves that table untouched.
 *
 * ###########################################################################
 * # WHAT THESE FOUR IMPORTS DO TO THE MODULE DISTANCES — RE-CHECKED FOR THE
 * # NEW EDGE, NOT ASSUMED TO BE UNCHANGED.
 * ###########################################################################
 *
 * Nest destroys modules in ascending distance from the root, and
 * `SchedulingModule` must be destroyed before `DatabaseModule` or its shutdown
 * drain runs against a closed pool (`../scheduling/tracked-continuation-scheduler.ts`,
 * `onModuleDestroy`). Nest's `TopologyTree` re-parents an already-seen module
 * only when it is re-encountered from a **strictly deeper** importer. On this
 * graph:
 *
 *     AppModule=1   ConfigModule=2   SchedulingModule=2   PaymentsModule=2
 *     AdminModule=2 (imported by AppModule)               DatabaseModule=3
 *
 * `AdminModule` is imported by `AppModule`, so it sits at 2.
 *
 *   - `ConfigModule` and `PaymentsModule` are already at 2, and 2 is not
 *     strictly deeper than 2 — neither moves.
 *   - **`IssuanceModule` is slice 5's new edge.** It is already at 3, reached
 *     from `PaymentsModule` at 2. This module is also at 2, so the edge
 *     `AdminModule → IssuanceModule` offers it distance 3 again — not strictly
 *     deeper, so it does not move, and neither does anything behind it
 *     (`OrdersModule` at 4, `ConfigModule` at 4, `DatabaseModule` at 3).
 *   - **`DatabaseModule` is slice 4's edge, and it is the one worth checking**,
 *     because it is the module `SchedulingModule` must outlive. It is already at
 *     3, reached from `CatalogModule`, `OrdersModule` and `PaymentsModule` — all
 *     at 2. This module is also at 2, so the edge `AdminModule → DatabaseModule`
 *     offers it distance 3 again. **3 is not strictly deeper than 3, so it does
 *     not move**, and `SchedulingModule` stays at 2 with `DatabaseModule` behind
 *     it at 3. Destroy order unchanged.
 *
 * **Measured, not only reasoned about.** `NestFactory.create(AppModule)` was
 * booted with and without these edges and every module's `distance` read out of
 * the container. The table is the same one slice 4 measured, with
 * `AdminModule → IssuanceModule` added since:
 *
 *     AppModule                  1
 *     AdminModule                2      SchedulingModule           2
 *     CatalogModule              2      SupplierAModule            2
 *     PaymentsModule             2      SupplierBModule            2
 *     SupplierBehaviourModule    2
 *     DatabaseModule             3      IssuanceModule             3
 *     ConfigModule               4      OrdersModule               4
 *
 * `SchedulingModule` 2 < `DatabaseModule` 3, with and without the edges, so the
 * shutdown drain still runs before the pool closes. (The two at 4 are
 * pre-existing re-parenting by `IssuanceModule` at 3 and are unaffected either
 * way — this module importing `IssuanceModule` from 2 offers it 3, which it
 * already has, so nothing behind it is re-parented either.)
 *
 * The one thing that *would* break it is importing `DatabaseModule` from
 * somewhere deeper than it currently sits — which is the shape to watch for, not
 * this particular line.
 *
 * That is also why this module does **not** import `SchedulingModule`, quite
 * apart from not needing it: the sweep does its work before answering
 * (`./payment-event-sweep.controller.ts`), the report is a single `SELECT`,
 * and the promo reset is a single `UPDATE`. None of them has anything to
 * schedule.
 *
 * ### And it introduces no cycle
 *
 * Every edge points away from this module and nothing points back at it:
 * nothing exports from here, and `admin` is imported only by `AppModule`.
 * `payments` has no reason to know an admin surface exists, and `database`
 * certainly does not.
 */
import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { IssuanceModule } from "../issuance/issuance.module.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { AdminTokenGuard } from "./admin-token.guard.js";
import { OrderRecoveryController } from "./order-recovery.controller.js";
import { OrderRetryService } from "./order-retry.service.js";
import { PaymentEventSweepController } from "./payment-event-sweep.controller.js";
import { PromoCodesResetController } from "./promo-codes-reset.controller.js";
import { PromoCodesResetService } from "./promo-codes-reset.service.js";
import { UndeliveredOrdersService } from "./undelivered-orders.service.js";

@Module({
  imports: [ConfigModule, PaymentsModule, DatabaseModule, IssuanceModule],
  controllers: [PaymentEventSweepController, OrderRecoveryController, PromoCodesResetController],
  // The guard is a provider, not only a decorator argument: `@UseGuards` with a
  // class reference asks the module's injector for an instance, and
  // `AdminTokenGuard` has a constructor dependency (`ADMIN_TOKEN_CONFIG`) that
  // only resolves if it is registered here.
  //
  // `UndeliveredOrdersService`, `OrderRetryService` and `PromoCodesResetService`
  // are providers and deliberately **not** exports: each exists to be served by
  // the controller beside it, and nothing outside this module has a reason to
  // run any of them. Exporting the retry would publish a second name for
  // `runForOrder`; exporting the reset would give the shop a path to a write
  // that only a check may make. Either is the one thing this module must not
  // become.
  providers: [AdminTokenGuard, UndeliveredOrdersService, OrderRetryService, PromoCodesResetService],
})
export class AdminModule {}
