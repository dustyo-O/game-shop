/**
 * The order lifecycle: `created → paid → delivering → delivered`, with branches
 * to `payment_failed`, `out_of_stock` and `delivery_failed` (architecture §3,
 * technical considerations §2.2; spec 003 technical-considerations §2).
 *
 * This is the wire-level definition — the one `apps/web` reads out of
 * `GET /api/orders/:id`, and the one the race scripts assert against. The
 * database has its own copy of the same list in `packages/db/src/schema/shop.ts`
 * (`orderStatuses`, feeding the `orders_status_check` CHECK constraint), because
 * a CHECK constraint needs the values *in SQL* and Postgres cannot import
 * TypeScript. The two are kept identical by hand and the CHECK is what makes a
 * drift fail loudly: a status this file invents and the database has never heard
 * of is rejected on write, not discovered by a shopper.
 *
 * `delivery_failed` arrived with Phase 3 and is here now. Migration
 * `0001_delivery_failed_status` widened the CHECK constraint in the same commit
 * as the code that can reach it, so neither layer accepts a status the other has
 * never heard of. It is classified as **recoverable, not terminal** — see
 * {@link recoverableOrderStatuses} for why that is the load-bearing choice.
 *
 * An `as const` object rather than a TypeScript `enum` — see the "what this
 * package is not" note in `./index.ts` for the full reasoning. The short version:
 * no runtime class is emitted, it tree-shakes out of the browser bundle, and it
 * compares equal to the plain strings that come back out of `orders.status`,
 * which the schema stores as `text`.
 */

export const OrderStatus = {
  /** Created, awaiting payment. The only state `POST /api/orders` produces. */
  Created: "created",
  /** The provider reported `paid`. Money taken, key not yet handed over. */
  Paid: "paid",
  /** A worker has claimed this order and is calling the supplier. */
  Delivering: "delivering",
  /** A key is bound to the order in `deliveries`. Terminal. */
  Delivered: "delivered",
  /** The provider reported `failed`. Terminal. */
  PaymentFailed: "payment_failed",
  /** The supplier's key pool was empty. Recoverable — see below. */
  OutOfStock: "out_of_stock",
  /**
   * The shop could not obtain a key: every supplier definitely refused, or the
   * outcome was never established. Recoverable — see below.
   */
  DeliveryFailed: "delivery_failed",
} as const;

export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

/**
 * Every status, in lifecycle order.
 *
 * Must match the `orders_status_check` CHECK constraint exactly — same members,
 * no extras, nothing missing.
 */
export const orderStatuses = [
  OrderStatus.Created,
  OrderStatus.Paid,
  OrderStatus.Delivering,
  OrderStatus.Delivered,
  OrderStatus.PaymentFailed,
  OrderStatus.OutOfStock,
  OrderStatus.DeliveryFailed,
] as const;

/**
 * `created`, `paid`, `delivering` — the order is still moving on its own.
 *
 * The complement of {@link settledOrderStatuses}. An order here will change
 * state without anyone asking it to, which is why the status page keeps polling.
 */
export const inFlightOrderStatuses = [
  OrderStatus.Created,
  OrderStatus.Paid,
  OrderStatus.Delivering,
] as const;

export type InFlightOrderStatus = (typeof inFlightOrderStatuses)[number];

/**
 * **Terminal.** `delivered` and `payment_failed` accept no further transitions —
 * ever, by any path, automatic or manual.
 *
 * `delivery_failed` is deliberately **not** in this set, however final it may
 * sound — see {@link recoverableOrderStatuses}.
 *
 * This is invariant I9 (architecture §3). The transition helper enforces it by
 * naming permitted source states on every update:
 *
 *   UPDATE orders SET status = $2, updated_at = now()
 *   WHERE id = $1 AND status = ANY($3)  -- permitted source states only
 *   RETURNING *;
 *   -- 0 rows => the order was not in a state this transition may leave from;
 *   --           the caller does nothing. A late webhook cannot resurrect a
 *   --           completed order.
 *
 * Listing them here is not the enforcement — the guarded UPDATE is. This is the
 * single place both the transition helper and the frontend read the set from, so
 * the two cannot disagree about what "finished" means.
 */
export const terminalOrderStatuses = [
  OrderStatus.Delivered,
  OrderStatus.PaymentFailed,
] as const;

export type TerminalOrderStatus = (typeof terminalOrderStatuses)[number];

/**
 * **Settled, but nothing moves it on its own — a person does.** `out_of_stock`
 * is where a paid order lands when the supplier's pool was empty;
 * `delivery_failed` is where it lands when the shop could not obtain a key at
 * all (spec 003 technical-considerations §2.4).
 *
 * The distinction from {@link terminalOrderStatuses} is the whole reason this
 * set is separate rather than folded in with the other two:
 *
 *   - **Nothing here moves by itself.** It behaves exactly like a terminal state
 *     to a passive observer, and the status page renders it as an ordinary
 *     outcome (technical-considerations §2.5 step 6).
 *   - **An operator moves it.** The recovery surface lists these orders and
 *     retries them through the same idempotent issuance path the automatic flow
 *     uses, re-entering `delivering` (architecture §4, "Recovery"; spec 003
 *     §2.5, and the `retryIssuance` rule in its technical-considerations §2.2).
 *
 * So it is *settled* but not *terminal*, and code must not treat the two as
 * interchangeable. Anything that means "no further transitions are legal"
 * (I9, the transition helper's guard lists) uses {@link terminalOrderStatuses};
 * anything that means "nothing more will happen on its own" (the poll's stop
 * condition, the admin panel's inbox) uses {@link settledOrderStatuses}.
 *
 * **Why `delivery_failed` is here and not above.** Terminal is the set the
 * guarded `UPDATE ... WHERE status = ANY($3)` draws its permitted source states
 * from, and nothing may leave it. Classifying `delivery_failed` as terminal
 * would make the operator retry illegal by construction — it would match zero
 * rows for ever, and spec 003 §2.4/§2.5 could not be built at all.
 */
export const recoverableOrderStatuses = [
  OrderStatus.OutOfStock,
  OrderStatus.DeliveryFailed,
] as const;

export type RecoverableOrderStatus = (typeof recoverableOrderStatuses)[number];

/**
 * Terminal ∪ recoverable — the states in which an order stops moving by itself.
 *
 * **This is the frontend's polling stop condition.** The order page polls
 * `GET /api/orders/:id` once a second while the order is in-flight and stops on
 * `delivered`, `payment_failed`, `out_of_stock` or `delivery_failed`
 * (technical-considerations §2.6). Deriving that set here rather than restating
 * the strings in the page is what stopped `delivery_failed` from producing a
 * page that polls a dead order forever: adding it to
 * {@link recoverableOrderStatuses} above was the whole edit — this list, and the
 * poll that reads it, needed no change at all.
 */
export const settledOrderStatuses = [
  ...terminalOrderStatuses,
  ...recoverableOrderStatuses,
] as const;

export type SettledOrderStatus = (typeof settledOrderStatuses)[number];

/**
 * Compile-time proof that every member of {@link OrderStatus} is classified as
 * either in-flight or settled — no status is in both, none is in neither.
 *
 * Type-level only: it emits nothing and costs nothing at run time, and it has
 * already been paid for once. Adding `delivery_failed` to {@link OrderStatus}
 * stopped this alias compiling — *Type `"delivery_failed"` does not satisfy the
 * constraint `never`* — until the new status was classified into one of the
 * lists above, which is the point. Without it, an unclassified status silently
 * reads as "in-flight" to {@link isSettledOrderStatus} and the status page polls
 * it forever.
 */
type AssertNoUnclassifiedStatus<TUnclassified extends never> = TUnclassified;
type _EveryOrderStatusIsClassified = AssertNoUnclassifiedStatus<
  Exclude<OrderStatus, InFlightOrderStatus | SettledOrderStatus>
>;

/** Narrow an unvalidated value — a JSON body, a `text` column — to an {@link OrderStatus}. */
export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && (orderStatuses as readonly string[]).includes(value);
}

/**
 * `delivered` or `payment_failed` — no further transitions are legal from here.
 *
 * Use this for the I9 question ("may this transition run at all?"), not for
 * "should the page stop polling?" — see {@link recoverableOrderStatuses}.
 */
export function isTerminalOrderStatus(status: OrderStatus): status is TerminalOrderStatus {
  return (terminalOrderStatuses as readonly OrderStatus[]).includes(status);
}

/** `out_of_stock` or `delivery_failed` — settled, and retryable by an operator. */
export function isRecoverableOrderStatus(status: OrderStatus): status is RecoverableOrderStatus {
  return (recoverableOrderStatuses as readonly OrderStatus[]).includes(status);
}

/**
 * `delivered`, `payment_failed`, `out_of_stock` or `delivery_failed` — the order
 * will not move on its own. **The status page's stop-polling condition.**
 */
export function isSettledOrderStatus(status: OrderStatus): status is SettledOrderStatus {
  return (settledOrderStatuses as readonly OrderStatus[]).includes(status);
}

/** `created`, `paid` or `delivering` — the order is still moving; keep polling. */
export function isInFlightOrderStatus(status: OrderStatus): status is InFlightOrderStatus {
  return !isSettledOrderStatus(status);
}
