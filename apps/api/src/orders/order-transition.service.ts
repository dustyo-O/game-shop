/**
 * The status transition helper — **the single place an order's status changes**
 * (technical-considerations §2.4).
 *
 * Every module that advances an order calls this one: `payments` applies the
 * webhook's verdict, `issuance` claims the order and finishes it. None of them
 * writes `orders.status` itself, and nothing else in the codebase may either.
 * That is not tidiness — a second UPDATE somewhere would be a second place where
 * the source-state guard could be forgotten, and the guard is invariant I9.
 *
 * ---------------------------------------------------------------------------
 * ZERO ROWS IS A NORMAL OUTCOME, NOT AN ERROR
 * ---------------------------------------------------------------------------
 * The mechanism is one statement (`architecture.md` §3.1, I9):
 *
 *   UPDATE orders SET status = $2, updated_at = now()
 *   WHERE id = $1 AND status = ANY($3)  -- permitted source states only
 *   RETURNING *;
 *   -- 0 rows => the order was not in a state this transition may leave from.
 *
 * Zero rows means "somebody else already advanced this order, or a late event
 * arrived for a finished one". Both are ordinary traffic in a system whose
 * webhooks are redelivered and whose workers run in parallel processes, so
 * neither may throw: an exception here would turn a correctly-ignored duplicate
 * into a `5xx`, and a `5xx` is precisely how you ask a payment provider to send
 * the duplicate again.
 *
 * So the outcome is in the return type instead, as a discriminated union
 * ({@link OrderTransitionResult}) whose branches carry the order under
 * *different property names*: `order` when this call made the transition,
 * `observed` when it did not. `result.order` therefore does not type-check
 * until the caller has narrowed on `result.outcome` — the distinction cannot be
 * skipped by accident, only refused on purpose.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 *   - **No `SELECT ... FOR UPDATE`.** The row lock is the *other* half of
 *     invariant I4 and it lives in `./order-lock.service.ts`, taken by the
 *     caller that owns the transaction. The lock serialises workers; this guard
 *     makes the transition idempotent. They are different jobs, and a lock taken
 *     here would be held for exactly the duration of one statement — which is no
 *     lock at all, since {@link OrderTransitionService.transition} opens no
 *     transaction and {@link OrderTransitionService.transitionWithin} is handed
 *     one whose boundaries it does not control.
 *
 *     So the pairing is a call-site pairing, and it reads the way §3.1 writes
 *     it (`architecture.md`, I4):
 *
 *         await database.transaction(async (tx) => {
 *           await lock.lockOrder(tx, orderId);                    // FOR UPDATE
 *           return transitions.transitionWithin(tx, orderId, "beginIssuance");
 *         });                                                     // guard
 *
 *   - **No read-then-write.** Nothing reads the status and then decides. The
 *     `WHERE` clause is the decision, evaluated by Postgres against the row as
 *     it is at that instant, which is the only version of it anyone can trust.
 *   - **No transaction of its own.** See {@link OrderTransitionService.transition}
 *     and {@link OrderTransitionService.transitionWithin}.
 */
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";

import type { OrderStatus } from "@game-shop/contracts";
import { orders, type Database, type DatabaseClient, type Order, type Transaction } from "@game-shop/db";

import { DATABASE_CLIENT } from "../database/database.module.js";
import { orderTransitions, type OrderTransitionName } from "./order-transitions.js";

/**
 * Which of the three things happened. Named values rather than a boolean,
 * because "I did not make the transition" has two causes a caller must be able
 * to tell apart — see {@link OrderTransitionResult}.
 */
export const OrderTransitionOutcome = {
  /** **This call made the transition.** At most one caller ever sees this per move. */
  Transitioned: "transitioned",
  /** The order exists, but its status was not one this transition may leave from. */
  NotInSourceState: "not_in_source_state",
  /** No row with that id. */
  OrderNotFound: "order_not_found",
} as const;

export type OrderTransitionOutcome =
  (typeof OrderTransitionOutcome)[keyof typeof OrderTransitionOutcome];

/**
 * The result of asking for a transition.
 *
 * A discriminated union on `outcome`, so a caller handles the cases with a
 * `switch` and the compiler tells them when Phase 3 adds one. Read the three
 * branches as three different pieces of news:
 *
 *   - **`transitioned`** — *you* moved it. The `order` field is the row after
 *     the move. Only this branch has an `order`, which is what makes "did I
 *     actually do it?" impossible to skip: reaching for `result.order` on an
 *     unnarrowed result is a compile error, not a silent `undefined`.
 *
 *   - **`not_in_source_state`** — somebody else already advanced this order, or
 *     a late event arrived for a finished one, or the order has not reached the
 *     source state yet (an out-of-order event). All three are no-ops for the
 *     caller: *do nothing*. `observed` carries the row as it stood a moment
 *     later, so the caller can log why it stopped ("order already `delivered`")
 *     and branch on it if it wants to.
 *
 *     `observed` is **advisory**. Under `READ COMMITTED` another process may
 *     move the order again between the UPDATE and the read-back, so it is the
 *     right thing to put in a log line and the wrong thing to make a second
 *     decision on. The load-bearing fact is the outcome itself: *this call did
 *     not make the transition*, and that is true forever.
 *
 *   - **`order_not_found`** — there is no such order. Distinct from
 *     `not_in_source_state` on purpose: `payment_events.order_id` carries no
 *     foreign key (`architecture.md` §4, "Out-of-order tolerance"), so an event
 *     can legitimately name an order that does not exist *yet*. That caller
 *     must leave the event pending and drain it later; collapsing the two
 *     outcomes would either lose the event or force every caller to re-query to
 *     find out which one it had.
 */
export type OrderTransitionResult =
  | {
      readonly outcome: typeof OrderTransitionOutcome.Transitioned;
      /** The row after the move, as `RETURNING *` produced it. */
      readonly order: Order;
    }
  | {
      readonly outcome: typeof OrderTransitionOutcome.NotInSourceState;
      /** The row as the follow-up read saw it. Advisory — for logs and branching, not proof. */
      readonly observed: Order;
    }
  | {
      readonly outcome: typeof OrderTransitionOutcome.OrderNotFound;
      readonly orderId: string;
    };

/**
 * A handle that can run the guarded UPDATE: either the pooled client or one
 * bound to a caller's open transaction. Structurally the same query API — the
 * transaction handle is just a `PgDatabase` whose statements land between a
 * `BEGIN` and a `COMMIT`.
 */
type OrderStatusWriter = Database | Transaction;

@Injectable()
export class OrderTransitionService {
  constructor(@Inject(DATABASE_CLIENT) private readonly database: DatabaseClient) {}

  /**
   * Attempt `transition` on `orderId`, standalone — one statement, its own
   * implicit transaction.
   *
   * Use this when the status change is the *whole* unit of work: applying a
   * webhook's verdict, claiming an order for issuance. When it has to commit
   * together with other writes — the delivery row and the finishing status in
   * §2.5 steps 5-6 — use {@link transitionWithin}.
   *
   * ### Never call this from inside an open transaction
   *
   * It would not merely be a separate unit of work — it would hang. The pool
   * holds exactly one connection per instance (`packages/db/src/client.ts`,
   * "WHY `max: 1`"), a transaction checks that connection out for its whole
   * body, and this method asks the pool for a connection of its own. The one it
   * is waiting for is held by the transaction that is waiting for it: a
   * self-deadlock that ends after `CONNECTION_TIMEOUT_MS` with a timeout error
   * that looks nothing like its cause. Passing the `tx` handle to
   * {@link transitionWithin} is the fix, and the reason these are two methods
   * rather than one with an optional argument — the wrong one cannot be reached
   * by forgetting an argument.
   */
  async transition(orderId: string, transition: OrderTransitionName): Promise<OrderTransitionResult> {
    return this.runGuardedUpdate(this.database.db, orderId, transition);
  }

  /**
   * Attempt `transition` on `orderId` **inside the caller's transaction**, so
   * the status change commits or rolls back with everything else in it.
   *
   * This is what §2.5's delivery path needs: the `deliveries` insert and the
   * move to `delivered` are one fact about the world, and an order that is
   * `delivered` with no key — or holds a key while still reading `delivering` —
   * is a support ticket either way. Pass the `tx` handle Drizzle gives the
   * transaction callback:
   *
   *     await database.transaction(async (tx) => {
   *       const delivery = await tx.insert(deliveries)...;
   *       const result = await transitions.transitionWithin(tx, orderId, "completeDelivery");
   *       ...
   *     });
   *
   * Two rules the caller carries, both from `packages/db/src/client.ts`:
   *
   *   - **Keep the transaction short, and never `await` a supplier HTTP call
   *     inside it.** With `max: 1` that stalls every other statement from this
   *     instance until it commits. Call the supplier first, then open the
   *     transaction to record the result.
   *   - **A rollback un-does the status change too.** That is the point of
   *     being here, and it means the caller must not treat a `transitioned`
   *     result as final until its transaction has committed.
   */
  async transitionWithin(
    tx: Transaction,
    orderId: string,
    transition: OrderTransitionName,
  ): Promise<OrderTransitionResult> {
    return this.runGuardedUpdate(tx, orderId, transition);
  }

  /**
   * The guarded UPDATE itself — I9, `architecture.md` §3.1.
   *
   * Emitted SQL (verified against `.toSQL()`; per the project's raw-SQL rule,
   * `architecture.md` §2, "Documentation convention"):
   *
   *   update "orders"
   *   set "status" = $1, "updated_at" = now()
   *   where ("orders"."id" = $2 and "orders"."status" = ANY($3))
   *   returning "id", "client_request_id", "sku", "amount_minor", "currency",
   *             "status", "created_at", "updated_at";
   *   -- $3 is the transition's permitted source states, one array parameter.
   *   -- 1 row  => THIS call made the transition; nobody else can also have made it.
   *   -- 0 rows => the order was not in a permitted source state. The caller does
   *   --           nothing. A late webhook cannot resurrect a completed order,
   *   --           and forty-nine concurrent claims of the same order lose here.
   *
   * Three details that are load-bearing:
   *
   *   - **`= ANY($3)`, not `IN ($3, $4, ...)`.** One bind parameter whatever the
   *     length of the `from` list, so the statement text — and the plan — is the
   *     same for a transition with one source state and one with three. It is
   *     also, letter for letter, the statement §3.1 specifies.
   *   - **`updated_at = now()` in SQL, not `new Date()` in Node.** The clock
   *     that stamps the row is the database's, the same one every other process
   *     is compared against; a serverless instance's clock is not.
   *   - **`RETURNING *` rather than a row count.** The winner gets the row it
   *     produced, in the same round trip, without a read that could see someone
   *     else's later write.
   *
   * The follow-up `SELECT` runs **only** on the zero-row path, and only to say
   * *which* kind of nothing happened (`not_in_source_state` vs
   * `order_not_found`). It is issued on the same handle, so inside a caller's
   * transaction it is part of that transaction and sees its uncommitted writes:
   *
   *   select "id", "client_request_id", "sku", "amount_minor", "currency",
   *          "status", "created_at", "updated_at"
   *   from "orders" where "orders"."id" = $1;
   *   -- 0 rows => no such order. Not an error either: an event may name an
   *   --           order that has not been created yet (no FK on
   *   --           payment_events.order_id).
   *
   * Folding it into the UPDATE with a CTE would save a round trip and cost the
   * thing that makes this auditable — the statement in §3.1 would no longer be
   * the statement that runs. The extra read happens only when the update did
   * nothing, which is the path with no work to do anyway.
   */
  private async runGuardedUpdate(
    handle: OrderStatusWriter,
    orderId: string,
    transition: OrderTransitionName,
  ): Promise<OrderTransitionResult> {
    const rule = orderTransitions[transition];

    // `sql.param` binds the whole list as ONE parameter, which is what `ANY`
    // needs. Interpolating the array directly (`ANY(${sources})`) would make
    // Drizzle expand it into `(a, b)` — a row constructor, not an array — and
    // Postgres would reject it.
    const permittedSourceStates: OrderStatus[] = [...rule.from];

    const [updated] = await handle
      .update(orders)
      .set({ status: rule.to, updatedAt: sql`now()` })
      .where(
        and(eq(orders.id, orderId), sql`${orders.status} = ANY(${sql.param(permittedSourceStates)})`),
      )
      .returning();

    if (updated !== undefined) {
      return { outcome: OrderTransitionOutcome.Transitioned, order: updated };
    }

    const [observed] = await handle.select().from(orders).where(eq(orders.id, orderId));

    if (observed === undefined) {
      return { outcome: OrderTransitionOutcome.OrderNotFound, orderId };
    }

    return { outcome: OrderTransitionOutcome.NotInSourceState, observed };
  }
}
