/**
 * `orders` — "Create orders; read order state; **own the status transition
 * helper that every other module calls**" (technical-considerations §2.4).
 *
 * All three exist now. {@link OrdersService} creates orders behind
 * `POST /api/orders`; {@link OrderViewService} reads them back behind
 * `GET /api/orders/:id` — the endpoint the status page polls;
 * {@link OrderTransitionService} is the single place any status changes, and
 * it is what `payments` and `issuance` import.
 *
 * The export list is the point. Two kinds of thing leave this module — the
 * two *guarded writers* and their lock, and one *reader* — and the shape of
 * the list is the promise: a module that imports `OrdersModule` gets exactly
 * one way to advance an order ({@link OrderTransitionService}), exactly one
 * way to change what it costs ({@link OrderRepricingService}), and the lock
 * both are meant to be called under ({@link OrderLockService}). There is no
 * exported repository, no injectable `orders` table, nothing that would let a
 * status — or, since spec 005, an amount — be written without a source-state
 * guard inside the statement. The announcements at the end of the list hand
 * out nothing an importer could *do* to an order at all.
 *
 * {@link OrdersService} stays unexported, and the reader was split out of it
 * rather than the whole class exported, for one reason: creating an order is
 * something the HTTP endpoint does, not a favour other modules ask for. The
 * class also carries the client-supplied-id affordance (`requestedOrderId`,
 * behind `ALLOW_CLIENT_SUPPLIED_ORDER_ID`, `architecture.md` §9), which is a
 * test seam and must not become reachable from `PromoModule` or anything
 * after it. Exporting `OrdersService` to give `PromoModule` a read would have
 * exported a create to get it. So `findOrder` moved into
 * {@link OrderViewService} — a class with one method, on the pooled handle,
 * and that class is what leaves. Its file says why it takes no `tx`: the
 * promo controller reads the view *after* `COMMIT`, because a pooled read
 * inside the redemption transaction self-deadlocks on `max: 1`.
 *
 * ---------------------------------------------------------------------------
 * `OrderRepricingService` IS A SECOND GUARDED WRITER, EXPORTED ON THE SAME TERMS
 * ---------------------------------------------------------------------------
 * Spec 005 is the first feature that writes a column of `orders` other than
 * `status` from another module: a promo code lowers `amount_minor` to the
 * amount to pay. The promise above — no write without a source-state guard —
 * was written about status; it now covers the amount, and it is kept the same
 * way. {@link OrderRepricingService.applyDiscount} is one statement,
 * `UPDATE orders SET amount_minor = $1 … WHERE id = $2 AND status = 'created'
 * RETURNING id`, and it takes a `Transaction` only — so it can only run where
 * the order lock can be held, and its guard is the second, independent stop
 * that remains if a future caller forgets that lock. Its file argues both.
 * `amount_minor` is written at creation and by that method, nowhere else; a
 * grep for `set`/`update` against the column proves it.
 *
 * ---------------------------------------------------------------------------
 * `OrderLockService` LEAVES WITH THE WRITERS BECAUSE I4 IS TWO MECHANISMS
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
 * `orders.status` still changes in exactly one place, and `orders.amount_minor`
 * in exactly one other.
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
 * to publish. `notify` is called by {@link OrdersService} (an order exists) and
 * {@link OrderViewService} (a poll found pending work) and by nothing else,
 * because both facts are only true when this module says they are.
 */
import { Module } from "@nestjs/common";

import { ConfigModule } from "../config/config.module.js";
import { DatabaseModule } from "../database/database.module.js";
import { OrderCreatedNotifier } from "./order-created-notifier.service.js";
import { OrderLockService } from "./order-lock.service.js";
import { OrderPendingEventsNotifier } from "./order-pending-events-notifier.service.js";
import { OrderRepricingService } from "./order-repricing.service.js";
import { OrderTransitionService } from "./order-transition.service.js";
import { OrderViewService } from "./order-view.service.js";
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
    OrderViewService,
    OrderTransitionService,
    OrderRepricingService,
    OrderLockService,
    OrderCreatedNotifier,
    OrderPendingEventsNotifier,
  ],
  // Two guarded writers, the lock they run under, one reader, two
  // announcements. `OrdersService` is deliberately absent — see the header.
  exports: [
    OrderTransitionService,
    OrderRepricingService,
    OrderLockService,
    OrderViewService,
    OrderCreatedNotifier,
    OrderPendingEventsNotifier,
  ],
})
export class OrdersModule {}
