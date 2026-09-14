/**
 * The order reprice — **the one write to `orders.amount_minor` after
 * creation**, and this module's one status-guarded amount write exported for
 * `PromoModule` (spec 005, technical-considerations §2.2 step 7 and §2.3).
 *
 * `orders.amount_minor` is written by exactly two statements, both in this
 * module and nowhere else in the codebase:
 *
 *   1. **at creation**, by `OrdersService.createOrder`'s `INSERT ... SELECT`,
 *      which copies `products.price_minor` column-to-column inside Postgres so
 *      that no TypeScript variable ever holds a price (that file's header); and
 *   2. **at most once more, here** — a promo code lowers it to the amount to
 *      pay, inside the redemption transaction, under the order row lock, while
 *      the order is still `created`.
 *
 * Nothing on the payment or issuance path writes the column: the payment
 * processor never compares against it (spec 005 tech R6 — settlement belongs
 * to processing, and the window that leaves is documented, not closed), the
 * admin list reads it, the payment simulator sends it. So the assignment's standing rule — *the server computes what is
 * owed* — remains a property of two statements in one directory, and the check
 * that proves it is one grep:
 *
 *     grep -rn "amountMinor\|amount_minor" apps/api/src | grep -i "set\|update"
 *
 * ---------------------------------------------------------------------------
 * WHY THE STATUS GUARD IS THERE WHEN THE CALLER ALREADY HOLDS THE LOCK
 * ---------------------------------------------------------------------------
 * `PromoRedemptionService` reaches this as step 7 of a transaction that opened
 * with `OrderLockService.lockOrder(tx, orderId)` and checked `status ===
 * 'created'` in memory at step 2. Under that lock the status cannot have moved
 * since the check, so `WHERE status = 'created'` can never fail on the path
 * that exists today — the tech spec says so outright: *"0 rows impossible
 * under the lock → throw → 500"*.
 *
 * It is there anyway, for the reason `./order-lock.service.ts` gives for I4
 * being two mechanisms rather than one. The lock and the guard are **two
 * independent stops** on the same hazard — the price changing on an order
 * that is already being paid — and each is what remains when the other is
 * missing:
 *
 *   - **The lock serialises the workers.** It is what makes the step-2 check
 *     trustworthy, and it is what a *correct* caller relies on.
 *   - **The guard decides against the committed row.** It is what protects
 *     the column from a caller that forgets the lock — a future "quick"
 *     reprice endpoint, an operator tool, a test helper — and from one that
 *     takes the lock but read the status before taking it. A predicate in the
 *     statement is evaluated by Postgres against the row as it is at that
 *     instant, which is the only version of it anybody can trust
 *     (`architecture.md` §3, the governing principle: *never a check-then-act
 *     in application code*).
 *
 * That is also why zero rows is **reported, not thrown**, from here: this
 * service cannot know whether its caller held the lock. The caller that does —
 * the promo transaction — treats `not_in_source_state` as an invariant
 * violation and throws, rolling back the counter increment and the ledger row
 * with it (§2.2 step 7's one rollback path). A caller that did not hold the
 * lock would be looking at the ordinary "somebody paid first" refusal, which
 * is not a `500`. Same division of labour as `./order-transition.service.ts`:
 * the statement reports which kind of nothing happened; the caller decides
 * what that means.
 *
 * What the guard does **not** do is make a reprice safe *without* the lock.
 * The amount to pay was computed from `order.amount_minor` as read under the
 * lock; a caller that skipped the lock could compute it from a stale read and
 * this statement would write it, because the predicate guards the status, not
 * the arithmetic. The tech spec's ordering — lock, then the in-memory status
 * check, then `computeDiscount`, then this — is the design, and this guard is
 * its backstop, not its replacement.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SIGNATURE DEMANDS A `Transaction`, AND CANNOT TAKE THE POOL
 * ---------------------------------------------------------------------------
 * The same argument `./order-lock.service.ts` makes, seen from the write side.
 * A reprice is never a unit of work on its own: the amount changes *because* a
 * `promo_codes` counter went up and a `promo_redemptions` row went in during
 * the same transaction, and a reprice committed without them — or they without
 * it — is an order whose price disagrees with its own redemption record. So
 * there is no `Database` overload and no standalone method, where
 * `OrderTransitionService` has `transition` beside `transitionWithin`: the
 * only way to call this is with the `tx` handle of an open transaction, which
 * is also the only place the order row lock can be held. Reading and writing
 * the amount outside the order lock does not compile.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LEAVES THE MODULE AT ALL
 * ---------------------------------------------------------------------------
 * `./orders.module.ts`'s header promises that nothing outside this module can
 * write an order without a source-state guard, and until spec 005 that was a
 * promise about `status`. A promo code is the first feature that has to write
 * a *different* column of `orders` from another module, so the promise now
 * has to cover the amount — and it is kept the same way: `PromoModule` imports
 * `OrdersModule` and receives exactly one way to change a price, and that way
 * carries the guard inside its statement. There is still no exported
 * repository, no injectable `orders` table, and no `set({ amountMinor })`
 * anywhere but the method below.
 */
import { Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";

import { OrderStatus, type MinorUnits } from "@game-shop/contracts";
import { orders, type Transaction } from "@game-shop/db";

/**
 * Which of the two things happened. Named values rather than a boolean, in the
 * shape `OrderTransitionOutcome` uses, so the caller's `switch` reads as news
 * and the compiler has something to be exhaustive about.
 */
export const OrderRepricingOutcome = {
  /** **This call changed the amount.** The order was `created` and is still `created`, one kopeck-count lighter. */
  Repriced: "repriced",
  /**
   * The order exists but was not `created`, or does not exist — the guard
   * matched nothing and nothing was written. Under the order lock this is an
   * invariant violation the caller must throw on; without it, it is the
   * ordinary "already being paid" refusal. See the header.
   */
  NotInSourceState: "not_in_source_state",
} as const;

export type OrderRepricingOutcome =
  (typeof OrderRepricingOutcome)[keyof typeof OrderRepricingOutcome];

/**
 * The result of asking for a reprice. A discriminated union on `outcome` and
 * nothing else — the caller already holds the order row it locked, and the
 * amount it asked for, so there is nothing to hand back but the verdict.
 */
export type OrderRepricingResult =
  | { readonly outcome: typeof OrderRepricingOutcome.Repriced }
  | { readonly outcome: typeof OrderRepricingOutcome.NotInSourceState };

@Injectable()
export class OrderRepricingService {
  /**
   * Set `orderId`'s amount to pay to `amountToPayMinor` — **inside the
   * caller's transaction**, and only while the order is still `created`.
   *
   * Emitted SQL (copied from `.toSQL()`; per the project's raw-SQL rule,
   * `architecture.md` §2, "Documentation convention"):
   *
   *   update "orders"
   *   set "amount_minor" = $1, "updated_at" = now()
   *   where ("orders"."id" = $2 and "orders"."status" = $3)
   *   returning "id";
   *   -- $1 the amount to pay, in kopecks, computed by `computeDiscount` from
   *   --    the amount read under the lock — never from anything the client
   *   --    sent; $2 the order id; $3 the literal 'created'.
   *   -- 1 row  => THIS call repriced the order. It was `created` at the instant
   *   --           Postgres evaluated the predicate, and under the caller's lock
   *   --           it still is.
   *   -- 0 rows => the order is not `created` (or does not exist). Nothing was
   *   --           written. Under the lock this cannot happen; see the header
   *   --           for why the guard is there regardless, and why this is
   *   --           reported rather than thrown.
   *
   * Three details that are load-bearing, the same three as the transition
   * helper's guarded UPDATE:
   *
   *   - **The status is in the `WHERE`, not in an `if`.** The caller checked it
   *     in memory at §2.2 step 2, under the lock, and that check is sound; this
   *     predicate is the second, independent stop, evaluated by Postgres
   *     against the committed row.
   *   - **`updated_at = now()` in SQL, not `new Date()` in Node.** The clock
   *     that stamps the row is the database's, the same one every other
   *     process is compared against; a serverless instance's is not.
   *   - **`RETURNING "id"` rather than a row count.** The one column is enough
   *     to tell one row from zero, and the caller already holds the whole row
   *     it locked — reading it back here would be a second copy of a row it
   *     has, in the one transaction that must stay short (`max: 1`,
   *     `packages/db/src/client.ts`).
   *
   * `amountToPayMinor` is typed as {@link MinorUnits}, the branded kopeck
   * type, so a rouble figure or an unbranded number from a request body cannot
   * reach this parameter without an explicit `minorUnits(...)` at the call
   * site — and the only call site is the promo transaction, whose figure comes
   * out of `computeDiscount`.
   */
  async applyDiscount(
    tx: Transaction,
    orderId: string,
    amountToPayMinor: MinorUnits,
  ): Promise<OrderRepricingResult> {
    const [updated] = await tx
      .update(orders)
      .set({ amountMinor: amountToPayMinor, updatedAt: sql`now()` })
      .where(and(eq(orders.id, orderId), eq(orders.status, OrderStatus.Created)))
      .returning({ id: orders.id });

    if (updated === undefined) {
      return { outcome: OrderRepricingOutcome.NotInSourceState };
    }

    return { outcome: OrderRepricingOutcome.Repriced };
  }
}
