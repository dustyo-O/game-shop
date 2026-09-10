/**
 * `admin` — the operator's surface, behind one shared bearer token
 * (`architecture.md` §6).
 *
 * One route today: `POST /api/admin/payment-events/sweep`, which is
 * `architecture.md` §4's fourth processing trigger. Phase 3 adds the
 * paid-but-undelivered list and its manual retry, both of which want the same
 * guard in front of them, which is the reason this is a module rather than one
 * more controller filed under `payments`.
 *
 * ---------------------------------------------------------------------------
 * THE IMPORT GRAPH IS THE DOCUMENTATION, AND IT SAYS TWO THINGS
 * ---------------------------------------------------------------------------
 * `ConfigModule` gives this module `ADMIN_TOKEN_CONFIG` — a value already
 * proven usable while the container was built, so {@link AdminTokenGuard} has
 * no checking left to do at request time.
 *
 * `PaymentsModule` gives it `PaymentEventDrainService`, that module's only
 * export, deliberately so: the three triggers that live outside `payments`
 * inject the service that owns the claim rather than writing a second
 * `FOR UPDATE SKIP LOCKED` of their own. This module writes no SQL at all.
 *
 * There is no `DatabaseModule` line here, and that absence is the point — this
 * module touches storage only through the drain, and the convention in this
 * codebase is that a module which touches storage says so in its own `imports`
 * (`../database/database.module.ts`).
 *
 * ###########################################################################
 * # WHAT THESE TWO IMPORTS DO TO THE MODULE DISTANCES — CHECKED, NOT ASSUMED.
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
 * `AdminModule` is imported by `AppModule`, so it sits at 2. Its two imports
 * are both already at 2, and 2 is not strictly deeper than 2 — so neither
 * moves, `SchedulingModule` is untouched at 2, and the destroy order is exactly
 * what it was before this module existed.
 *
 * That is also why this module does **not** import `SchedulingModule`, quite
 * apart from not needing it: the sweep does its work before answering
 * (`./payment-event-sweep.controller.ts`), so there is nothing to schedule.
 *
 * ### And it introduces no cycle
 *
 * Both edges point away from this module and nothing points back at it: nothing
 * exports from here, and `admin` is imported only by `AppModule`. `payments`
 * has no reason to know an admin surface exists.
 */
import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { PaymentsModule } from "../payments/payments.module.js";
import { AdminTokenGuard } from "./admin-token.guard.js";
import { PaymentEventSweepController } from "./payment-event-sweep.controller.js";

@Module({
  imports: [ConfigModule, PaymentsModule],
  controllers: [PaymentEventSweepController],
  // The guard is a provider, not only a decorator argument: `@UseGuards` with a
  // class reference asks the module's injector for an instance, and
  // `AdminTokenGuard` has a constructor dependency (`ADMIN_TOKEN_CONFIG`) that
  // only resolves if it is registered here.
  providers: [AdminTokenGuard],
})
export class AdminModule {}
