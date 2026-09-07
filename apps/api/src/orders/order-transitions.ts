/**
 * The lifecycle as data: every legal transition, each naming the states it is
 * allowed to leave from.
 *
 * This table is the whole of invariant I9 (`context/product/architecture.md`
 * §3): *final states are terminal*. Not because a comment says so — because
 * `delivered` and `payment_failed` appear in no `from` list here, and the guard
 * built from that list is a `WHERE` clause Postgres evaluates
 * (`./order-transition.service.ts`). A late webhook that asks for
 * `delivered → delivering` matches zero rows and changes nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY A TABLE RATHER THAN A METHOD PER TRANSITION
 * ---------------------------------------------------------------------------
 * Five `markPaid()` / `beginIssuance()` methods would each carry their own
 * `WHERE status = ...`, and the set of legal moves would then only exist as the
 * union of five function bodies — unreadable as a whole and unenforceable as a
 * set. As data it can be read in ten lines, and the compiler can make
 * assertions about it: see `_NoTransitionLeavesATerminalState` below, which
 * fails the build if anyone ever gives a terminal state an exit.
 *
 * Phase 3 (`delivery_failed`, plus retrying `out_of_stock` and `delivery_failed`
 * back into `delivering`) is therefore new entries here and nothing else — no
 * new SQL, no new service method. That is the point of the shape.
 */
import { OrderStatus, type TerminalOrderStatus } from "@game-shop/contracts";

/**
 * One transition: the state it moves an order **to**, and the complete list of
 * states it may move an order **from**.
 *
 * `from` is a list rather than a single state because a transition can be
 * legitimately reachable from several places — Phase 3's manual retry re-enters
 * `delivering` from both `out_of_stock` and `delivery_failed`. It is never the
 * *absence* of a guard: an empty or all-inclusive `from` would be an
 * unguarded UPDATE, which is exactly what this module exists to prevent.
 */
export interface OrderTransitionRule {
  /** The status the order is moved to. Bound as `$2` in the guarded UPDATE. */
  readonly to: OrderStatus;
  /** Permitted source states. Bound as `$3` — the `ANY(...)` list. */
  readonly from: readonly OrderStatus[];
}

/**
 * The five transitions of the Phase 1 lifecycle, keyed by what the caller is
 * doing rather than by the state it lands in — `beginIssuance` says why the
 * call is being made, `delivering` only says where it ends up.
 *
 * Each maps onto a numbered step of the delivery path
 * (`context/spec/001-purchase-and-key-delivery/technical-considerations.md`
 * §2.5), which is the checklist this table has to satisfy in full:
 *
 * | Transition          | Move                        | Called from                    |
 * | ------------------- | --------------------------- | ------------------------------ |
 * | `markPaid`          | `created → paid`            | webhook, `status: "paid"` (§2.5.2)   |
 * | `markPaymentFailed` | `created → payment_failed`  | webhook, `status: "failed"` (§2.5.2) |
 * | `beginIssuance`     | `paid → delivering`         | claiming the order (§2.5.3)    |
 * | `completeDelivery`  | `delivering → delivered`    | after the delivery row (§2.5.6)|
 * | `markOutOfStock`    | `delivering → out_of_stock` | empty supplier pool (§2.5.6)   |
 *
 * Two things to notice about what is *not* here:
 *
 *   - **No `paid → delivered`.** Delivery is only ever finished by the worker
 *     that claimed the order into `delivering`, so the claim cannot be skipped.
 *   - **Nothing leaves `delivered`, `payment_failed` or `out_of_stock`.** The
 *     first two are terminal forever (I9). `out_of_stock` is terminal *for
 *     Phase 1* and becomes recoverable in Phase 3 — which is one line added
 *     below, and is why `recoverableOrderStatuses` is kept separate from
 *     `terminalOrderStatuses` in `@game-shop/contracts`.
 *
 * `as const satisfies` rather than a type annotation: `satisfies` checks the
 * shape, and `as const` keeps the literal `from` tuples that
 * {@link PermittedSourceStatus} — and therefore the terminality proof — needs.
 */
export const orderTransitions = {
  /** §2.5 step 2 — the provider reported `paid`. */
  markPaid: { to: OrderStatus.Paid, from: [OrderStatus.Created] },

  /** §2.5 step 2 — the provider reported `failed`. Terminal on arrival. */
  markPaymentFailed: { to: OrderStatus.PaymentFailed, from: [OrderStatus.Created] },

  /**
   * §2.5 step 3 — claim a paid order for issuance.
   *
   * In Phase 1 this guard is the *only* thing keeping fifty webhooks from
   * starting fifty issuances: exactly one of them moves `paid → delivering`,
   * the other forty-nine match zero rows and stop. Phase 2 adds the row lock
   * (I4) in front of it; the guard stays, because the lock serialises the
   * workers while the guard is what makes the transition itself idempotent.
   */
  beginIssuance: { to: OrderStatus.Delivering, from: [OrderStatus.Paid] },

  /** §2.5 step 6 — a key is bound in `deliveries`. Terminal. */
  completeDelivery: { to: OrderStatus.Delivered, from: [OrderStatus.Delivering] },

  /** §2.5 step 6 — the supplier's pool was empty. Settled, and recoverable in Phase 3. */
  markOutOfStock: { to: OrderStatus.OutOfStock, from: [OrderStatus.Delivering] },
} as const satisfies Readonly<Record<string, OrderTransitionRule>>;

/**
 * The name of a transition — the only thing a caller may ask for.
 *
 * Callers name a member of the table; they never hand the service a `to`/`from`
 * pair of their own. That is what makes this file *the* list of legal moves
 * rather than a suggested one, and it is why a transition cannot be invented at
 * a call site under deadline pressure.
 */
export type OrderTransitionName = keyof typeof orderTransitions;

/** Every status that any transition in the table may leave from. */
type PermittedSourceStatus = (typeof orderTransitions)[OrderTransitionName]["from"][number];

/**
 * Compile-time proof of I9: **no transition leaves a terminal state.**
 *
 * `Extract<PermittedSourceStatus, TerminalOrderStatus>` is the set of terminal
 * states that appear in some `from` list. The alias below requires that set to
 * be `never`; add `OrderStatus.Delivered` to any `from` above and this stops
 * compiling with "Type 'delivered' does not satisfy the constraint 'never'",
 * pointing at the line that would have made a completed order resurrectable.
 *
 * Type-level only — it emits nothing. It is a second line of defence, not the
 * enforcement: the enforcement is the guarded UPDATE, which is what holds
 * against a *concurrent* caller as well as against a mistaken one. The set of
 * terminal states is imported from `@game-shop/contracts` rather than restated,
 * so this proof and the status page's "finished" badge cannot disagree.
 */
type AssertNoTerminalSource<TTerminalSource extends never> = TTerminalSource;
type _NoTransitionLeavesATerminalState = AssertNoTerminalSource<
  Extract<PermittedSourceStatus, TerminalOrderStatus>
>;
