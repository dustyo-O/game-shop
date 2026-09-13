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
 * A `markPaid()` / `beginIssuance()` method per transition would each carry its
 * own `WHERE status = ...`, and the set of legal moves would then only exist as
 * the union of those function bodies — unreadable as a whole and unenforceable
 * as a set. As data it can be read in ten lines, and the compiler can make
 * assertions about it: see `_NoTransitionLeavesATerminalState` below, which
 * fails the build if anyone ever gives a terminal state an exit.
 *
 * Phase 3 is that prediction being cashed, three times over.
 * `markDeliveryFailed` was its first arc and `retryIssuance` / `resumeIssuance`
 * are its last: each is one row added to this table, with no new SQL and no new
 * service method — `./order-transition.service.ts` has not changed once across
 * the phase, and neither has the statement it emits. The operator's retry
 * (spec 003 §2.5) is, in its entirety, two entries in the object below.
 */
import { OrderStatus, type TerminalOrderStatus } from "@game-shop/contracts";

/**
 * One transition: the state it moves an order **to**, and the complete list of
 * states it may move an order **from**.
 *
 * `from` is a list rather than a single state because a transition can be
 * legitimately reachable from several places — {@link orderTransitions.retryIssuance}
 * re-enters `delivering` from both `out_of_stock` and `delivery_failed`. It is
 * never the *absence* of a guard: an empty or all-inclusive `from` would be an
 * unguarded UPDATE, which is exactly what this module exists to prevent.
 */
export interface OrderTransitionRule {
  /** The status the order is moved to. Bound as `$2` in the guarded UPDATE. */
  readonly to: OrderStatus;
  /** Permitted source states. Bound as `$3` — the `ANY(...)` list. */
  readonly from: readonly OrderStatus[];
}

/**
 * Every legal transition, keyed by what the caller is doing rather than by the
 * state it lands in — `beginIssuance` says why the call is being made,
 * `delivering` only says where it ends up.
 *
 * The first five map onto a numbered step of Phase 1's delivery path
 * (`context/spec/001-purchase-and-key-delivery/technical-considerations.md`
 * §2.5), which is the checklist this table has to satisfy in full; the last
 * three are Phase 3's
 * (`context/spec/003-failure-and-recovery/technical-considerations.md` §2.2,
 * §2.5):
 *
 * | Transition           | Move                                         | Called from                          |
 * | -------------------- | -------------------------------------------- | ------------------------------------ |
 * | `markPaid`           | `created → paid`                             | webhook, `status: "paid"` (§2.5.2)   |
 * | `markPaymentFailed`  | `created → payment_failed`                   | webhook, `status: "failed"` (§2.5.2) |
 * | `beginIssuance`      | `paid → delivering`                          | claiming the order (§2.5.3)          |
 * | `completeDelivery`   | `delivering → delivered`                     | after the delivery row (§2.5.6)      |
 * | `markOutOfStock`     | `delivering → out_of_stock`                  | empty supplier pool (§2.5.6)         |
 * | `markDeliveryFailed` | `delivering → delivery_failed`               | no key obtained (003 §1.3)           |
 * | `retryIssuance`      | `out_of_stock, delivery_failed → delivering` | the operator's retry (003 §2.5)      |
 * | `resumeIssuance`     | `delivering → delivering`                    | the operator's retry of a **stranded** order (003 §2.3) |
 *
 * The last three are an entry-point decision table as much as a lifecycle: §2.5
 * pairs each status the retry can observe under the lock with the one
 * transition that may claim it, and everything else — `created`, `paid`,
 * `delivered`, `payment_failed` — is refused by matching zero rows rather than
 * by a branch.
 *
 * Two things to notice about what is *not* here:
 *
 *   - **No `paid → delivered`.** Delivery is only ever finished by the worker
 *     that claimed the order into `delivering`, so the claim cannot be skipped.
 *   - **Nothing leaves `delivered` or `payment_failed`.** Those two are
 *     terminal forever (I9) and appear in no `from` list. `out_of_stock` and
 *     `delivery_failed` now *do* appear — in `retryIssuance`'s — and that
 *     difference is exactly the one slice 1 made when it classified them as
 *     `recoverableOrderStatuses` rather than `terminalOrderStatuses` in
 *     `@game-shop/contracts`. The classification was made before the exit
 *     existed and proven against this very rule; adding the exit needed no
 *     change to the proof, which is what keeping the two sets separate bought.
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

  /**
   * §2.5 step 6 — the supplier's pool was empty. Settled, and recoverable:
   * {@link orderTransitions.retryIssuance} below is the way back out, which is
   * what "recoverable in Phase 3" meant when slice 1 wrote it here.
   */
  markOutOfStock: { to: OrderStatus.OutOfStock, from: [OrderStatus.Delivering] },

  /**
   * Spec 003 §2.4 — **no key was obtained.** Either a supplier definitely
   * refused for a reason that is not an empty pool, or the outcome was never
   * established at all (003 technical-considerations §1.3, §2.4).
   *
   * `from: [delivering]` and nothing else, for the reason `completeDelivery`
   * reads the same way: only the worker that claimed the order may settle it.
   * A `paid` order nobody has claimed cannot be written off, and a `delivered`
   * one cannot be un-delivered by a late failure report — the latter is I9,
   * enforced here by `delivered` being absent from every `from` list rather
   * than by anyone remembering to check.
   *
   * The row records the **shop's** side of it — "we did not hand over a key".
   * It says nothing about the supplier: an attempt that timed out stays
   * `unknown` in `issuance_attempts`, with `last_error` NULL, because that is
   * still the only truthful thing to say about it. Two different facts, two
   * tables, and writing `failed` into the second is the exact bug Phase 3
   * exists to prevent (003 technical-considerations §1.3).
   *
   * Settled, not terminal: `delivery_failed` is deliberately absent from
   * `terminalOrderStatuses`, and the exit that absence was holding room for is
   * {@link orderTransitions.retryIssuance}, immediately below. This row is the
   * arrival; that one is the way back.
   */
  markDeliveryFailed: { to: OrderStatus.DeliveryFailed, from: [OrderStatus.Delivering] },

  /**
   * Spec 003 §2.5 — **an operator pushes a settled order that holds no key back
   * into issuance.** The restock arrived, or the supplier that was refusing is
   * answering again.
   *
   * Two source states, because an order that is paid and undelivered gets there
   * by two different routes (§2.4: an empty shelf everywhere, or anything else)
   * and can be pushed out of either. That is the list doing its job, not the
   * guard being relaxed — the four statuses left out are the point of it:
   *
   *   - `created` and `paid` are absent, so a retry cannot skip `beginIssuance`
   *     and claim an order the automatic path has not finished with;
   *   - `delivering` is absent, so a retry cannot barge in on a worker that is
   *     mid-ladder (that case is {@link orderTransitions.resumeIssuance}'s, and
   *     it is deliberately a *different* row with a different story);
   *   - `delivered` and `payment_failed` are absent because they are terminal —
   *     I9, and the compile-time proof at the foot of this file.
   *
   * **Pressing retry twice changes nothing, and no code was written to make
   * that true.** Two calls issue the same guarded UPDATE with the same `$3`:
   * the first moves the order out of `out_of_stock`, the second finds it in
   * `delivering` — which is not in this list — and matches zero rows. Same
   * clause, same idempotence `beginIssuance` has had since Phase 1; no
   * de-duplication cache, no in-process guard, nothing for a caller to
   * remember. §2.5's `409` *is* those zero rows.
   */
  retryIssuance: {
    to: OrderStatus.Delivering,
    from: [OrderStatus.OutOfStock, OrderStatus.DeliveryFailed],
  },

  /**
   * Spec 003 §2.3 — **an order stranded in `delivering` by a worker that died,
   * handed back to a live one.**
   *
   * The only row in this table whose guard excludes nobody, and the phase's
   * most delicate decision. Read this one before changing anything near it.
   *
   * ---------------------------------------------------------------------------
   * WHY IT EXISTS AT ALL — TWO PLANS REACHED OPPOSITE CONCLUSIONS
   * ---------------------------------------------------------------------------
   * The backend plan wanted it, so that an order stranded in `delivering` can be
   * recovered. The data-layer plan argued the opposite, and its objection is
   * correct as stated: `delivering → delivering` **returns one row to both
   * callers and therefore excludes nobody**, so it cannot be the thing that
   * keeps two retries apart.
   *
   * **Both halves are true, and the hole the first one names is real.** If a
   * worker dies mid-issuance — the platform kills the function mid-ladder (R5),
   * the process is redeployed — the payment event stays pending, but every
   * drain trigger claims with `beginIssuance`, whose `from` is `[paid]` and
   * never matches `delivering`. Without this row **nothing in the system can
   * move that order again**: not the sweep, not the shopper's poll, not the
   * operator. Refusing the transition leaves a permanently unrecoverable state
   * in the phase whose entire subject is recovery, so it ships — operator-only,
   * with its exclusion *stated* rather than assumed.
   *
   * ---------------------------------------------------------------------------
   * WHAT ACTUALLY EXCLUDES THE SECOND CALLER — NEITHER OF THEM IS THIS GUARD
   * ---------------------------------------------------------------------------
   *   1. **The order row lock** (`./order-lock.service.ts`, I4). Both resumers
   *      take `SELECT … FOR UPDATE` on the order as the first statement of
   *      transaction A, so the two claims are serialised: one reads the ledger,
   *      decides and commits before the other reads anything at all.
   *
   *   2. **The rung they both necessarily compute.** Under the lock they read
   *      `issuance_attempts` sequentially, and a stranded order's outstanding
   *      attempt is `unknown`, which the ladder answers with `probe`. **A probe
   *      writes no new attempt row** — it increments `probe_count` and nothing
   *      else — so the second reader sees the *identical* ledger and computes
   *      the *identical* rung: the same provider, the same attempt number, and
   *      therefore the same `request_id`, recomputed rather than remembered
   *      (`../issuance/issuance-request-id.ts`). The supplier's ledger (I5)
   *      answers the second ask with the code it already issued, so one key
   *      leaves the pool for two calls.
   *
   * ---------------------------------------------------------------------------
   * WHY THAT IS ALSO EXACTLY WHAT MAKES IT FRAGILE — RISK R3
   * ---------------------------------------------------------------------------
   * Point 2 holds **only while every concurrent resumer lands on `probe`.** If
   * a future change lets two resumers reach `fallThrough` from *different*
   * snapshots — a ladder rung that writes a row a probe did not, a ledger read
   * moved out from under the lock (R4), a fall-through permitted while an
   * attempt is still `unknown` — then two suppliers are asked two **different**
   * questions, neither ledger can answer the other, and **two keys leave the
   * pool**. `deliveries_order_id_key` still keeps the shopper to one, so the
   * shop looks correct from outside; what breaks is stock accounting, and
   * `count(*) FROM supplier_keys WHERE claimed_by_request_id IS NOT NULL`
   * against `count(*) FROM deliveries` is the only assertion that can see it
   * (R2).
   *
   * **This is a separate row rather than two more states in
   * {@link orderTransitions.retryIssuance}'s `from` list for precisely that
   * reason.** Widened in there it would read as one more legal move and the
   * reasoning above would live only in a spec file; as its own entry it is
   * where a reviewer looks, and its `from` list says in one line that its guard
   * is not what protects it. Rejected alternative (A3): resuming only a
   * `delivering` order older than N seconds — a knob whose correct value nobody
   * can know, and spec 003 §3 says nothing is hidden from the operator on a
   * timer.
   *
   * The statement is not a no-op even though the status is unchanged: it still
   * sets `updated_at = now()` and returns the row, which is how a resumed order
   * is distinguishable from a stranded one, and it is what gives the runner a
   * `Transitioned` outcome to walk the ladder on.
   */
  resumeIssuance: { to: OrderStatus.Delivering, from: [OrderStatus.Delivering] },
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
 * Still `never` with Phase 3's two re-entering arcs in the table, and that is
 * the certificate worth having: `retryIssuance` is the first transition in this
 * codebase that moves an order *backwards* into `delivering`, and this alias is
 * what says it did not smuggle a resurrection in with it. It compiles because
 * `out_of_stock` and `delivery_failed` are in `recoverableOrderStatuses`, not
 * in `terminalOrderStatuses` — a classification slice 1 made and proved against
 * this exact rule one slice before the rule had anything to catch.
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
