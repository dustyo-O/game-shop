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
 * module, and — apart from the lock beside it and the announcements below —
 * nothing else does. A module that wants to advance an order imports
 * `OrdersModule` and gets exactly one way to do it: there is no exported
 * repository, no injectable `orders` table, nothing that would let a status be
 * written without a source-state guard. {@link OrdersService} stays unexported
 * for the same reason: creating an order is something the HTTP endpoint does,
 * not a favour other modules ask for.
 *
 * ---------------------------------------------------------------------------
 * `OrderLockService` IS THE SECOND EXPORT BECAUSE I4 IS TWO MECHANISMS
 * ---------------------------------------------------------------------------
 * `architecture.md` §3 spells invariant I4 as "`SELECT … FOR UPDATE` on the
 * order row, **plus** status-guarded updates". {@link OrderTransitionService}
 * has always been the second half; {@link OrderLockService} is the first, and
 * it leaves this module for the same reason the transition helper does — the
 * two halves are used together, at the same call sites, and a module that has
 * one and not the other would be holding half an invariant.
 *
 * It grants **exclusion, not mutation**. Its one method takes a `Transaction`
 * and returns the row; there is no overload that accepts the pooled handle,
 * because a row lock taken outside a transaction is released before the next
 * statement runs and would read as protection while providing none. So the
 * export widens what an importer can *serialise*, never what it can *write*:
 * `orders.status` still changes in exactly one place.
 *
 * ---------------------------------------------------------------------------
 * THE OTHER TWO EXPORTS ARE ANNOUNCEMENTS, NOT ABILITIES
 * ---------------------------------------------------------------------------
 * {@link OrderCreatedNotifier} is the one addition, and it hands a subscriber
 * nothing it could *do* to an order — only the news that one now exists. It is
 * exported so that `architecture.md` §4's second processing trigger ("order
 * creation drains any events already waiting for that order id") can be built
 * without the import that would carry it: `PaymentsModule` already imports this
 * module for the transition helper, so an `OrdersModule → PaymentsModule` edge
 * would be a cycle, and `forwardRef()` tolerates a cycle rather than removing
 * one.
 *
 * The arrow is therefore inverted instead of added. This module publishes a
 * fact about its own domain and knows nothing about who listens; the listener
 * lives in the module that already depends on this one
 * (`../payments/order-creation-drain.ts`). No module's `imports` array changed
 * to make that work — which is also what keeps `SchedulingModule` pinned at
 * distance 2, where its shutdown drain still runs before `DatabaseModule`
 * closes the pool (`../scheduling/tracked-continuation-scheduler.ts`).
 *
 * {@link OrderPendingEventsNotifier} is the same shape for §4's *third*
 * trigger ("the order status poll opportunistically drains that order's pending
 * events") and is exported for the same reason — the listener,
 * `../payments/order-status-poll-drain.ts`, must live in the module that
 * already depends on this one. Again no `imports` array changed, so
 * `SchedulingModule` stays at distance 2.
 *
 * Two near-identical notifiers rather than one shared bus, and rather than
 * routing both facts through the first: they are different claims with
 * different truth conditions, and trigger 2's listener drains
 * *unconditionally*, so publishing status polls through it would run a claim
 * query once a second per open order page — the exact load trigger 3 is gated
 * to avoid. Each file argues its own case at the top.
 *
 * Note what is *not* exported alongside them: there is no way for a subscriber
 * to publish. `notify` is called by {@link OrdersService} and by nothing else,
 * because both facts are only true when this module says they are.
 */
import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { OrderCreatedNotifier } from "./order-created-notifier.service.js";
import { OrderLockService } from "./order-lock.service.js";
import { OrderPendingEventsNotifier } from "./order-pending-events-notifier.service.js";
import { OrderTransitionService } from "./order-transition.service.js";
import { OrdersController } from "./orders.controller.js";
import { OrdersService } from "./orders.service.js";

@Module({
  // `ConfigModule` gives `OrdersController` `CLIENT_SUPPLIED_ORDER_ID_CONFIG` —
  // a value already validated at boot, per `../config/config.module.ts`'s own
  // header on why this import exists rather than a raw `process.env` read here.
  imports: [DatabaseModule, ConfigModule],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrderTransitionService,
    OrderLockService,
    OrderCreatedNotifier,
    OrderPendingEventsNotifier,
  ],
  exports: [
    OrderTransitionService,
    OrderLockService,
    OrderCreatedNotifier,
    OrderPendingEventsNotifier,
  ],
})
export class OrdersModule {}
