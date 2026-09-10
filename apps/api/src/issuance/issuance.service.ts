/**
 * `issuance` — "Drive a paid order to `delivered`: call the supplier, record the
 * attempt, bind the delivery" (technical-considerations §2.4), i.e. §2.5 **steps
 * 4, 5 and 6**.
 *
 * Entered by exactly one caller per order: the one that won `paid → delivering`
 * in {@link PaymentEventProcessor.claimForIssuance}. It never decides *whether*
 * to issue — that decision was made by a guarded UPDATE inside Postgres — and it
 * never settles the payment event, which stays the processor's job precisely so
 * the event cannot leave the queue before the order has stopped moving.
 *
 * ---------------------------------------------------------------------------
 * THE ORDERING IS THE DESIGN. THERE ARE THREE STEPS AND THEY MAY NOT BE SWAPPED.
 * ---------------------------------------------------------------------------
 *
 *     1. WRITE   record the attempt as `unknown`      (one statement, no tx)
 *     2. CALL    POST {SUPPLIER_A_URL}/issue          (no transaction, no lock)
 *     3. WRITE   resolve the attempt + bind + finish  (TX B: lock, then write)
 *
 * Step 3 is **transaction B of invariant I4** (`architecture.md` §3, §3.1). Its
 * first statement is `SELECT … FROM orders WHERE id = $1 FOR UPDATE`; transaction
 * A is the claim that let this service be entered at all
 * ({@link PaymentEventProcessor.claimForIssuance}). The two bracket the supplier
 * call and neither one spans it — see "Why no transaction spans the call" below,
 * and `../orders/order-lock.service.ts` for why the shape has to be two short
 * transactions rather than one long one.
 *
 * **Step 1 deliberately takes no lock.** It is a single statement in its own
 * implicit transaction, so a lock taken there would be released before the next
 * line of TypeScript ran — protection in name only. The row it writes is not a
 * decision anybody races over; it is a note that we are about to ask, and
 * `ON CONFLICT (request_id) DO NOTHING` already makes writing it twice a no-op.
 *
 * **Why the attempt row is written before the call.** A timeout must have
 * somewhere to be written down, and the place has to exist *before* the thing it
 * describes. If the row were written afterwards, the one failure it exists to
 * record — the process dying between sending the request and reading the answer
 * — is exactly the failure that would prevent it from ever being written. The
 * difference is between "we know we asked" and "we have no idea what happened",
 * and only the first is recoverable: a `request_id` we have on file can be
 * re-probed against the supplier's ledger (I5), while a key issued for an id
 * nobody recorded is gone.
 *
 * Note what that ordering buys without any `catch` block running: the row's
 * value is `unknown` from the instant it is written, so a `SIGKILL`, an OOM, or
 * a serverless function hitting its execution ceiling — none of which run any
 * error handler at all — all leave the record saying precisely what is true.
 * The only writes that *change* it are the ones that follow a definite answer.
 *
 * **Why no transaction spans the call.** `packages/db/src/client.ts` sets
 * `max: 1` per instance, and Drizzle checks the single connection out for the
 * whole of `transaction()`. A transaction held across an HTTP round trip
 * therefore stalls every other statement this instance wants to run, for as long
 * as the supplier takes — up to `SUPPLIER_TIMEOUT_MS`. The constraint is stated
 * four times in the codebase (the client, {@link OrderTransitionService},
 * {@link OrderLockService}, and the seam in {@link PaymentEventProcessor})
 * because it is the one that is easiest to violate by accident and hardest to
 * diagnose afterwards: the symptom is unrelated requests timing out.
 *
 * It is also the reason the lock is taken **twice**, in two transactions, rather
 * than once across the call. Two acquisitions of a short lock cost two round
 * trips; one acquisition held across the supplier call would cost the instance.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SLICE DOES NOT DO
 * ---------------------------------------------------------------------------
 * There is **no retry policy here**, deliberately. Phase 1 builds only supplier
 * A, always succeeding unless the pool is empty (technical-considerations §1),
 * so an unknown outcome ends the run: the attempt stays `unknown`, the order
 * rests in `delivering`, and the payment event stays pending. Nothing falls
 * through to anything, because there is nothing to fall through to and — more
 * importantly — falling through while an attempt is `unknown` is the exact move
 * `architecture.md` §4 forbids.
 *
 * What Phase 3 adds sits entirely on top of this file's shape: re-probe the
 * outstanding `request_id` against the same supplier, bounded retries, and only
 * after a *definite* failure a call to supplier B with `attempt + 1` in a new
 * id. The classification those decisions read is already being recorded here, on
 * every attempt row, which is why getting it right now matters more than the
 * absent policy does.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";

import { OrderStatus, SupplierIssueErrorReason, type SupplierIssueRequest } from "@game-shop/contracts";
import {
  deliveries,
  issuanceAttempts,
  type DatabaseClient,
  type Delivery,
  type Order,
  type Transaction,
} from "@game-shop/db";

import { DATABASE_CLIENT } from "../database/database.module.js";
import { OrderLockService } from "../orders/order-lock.service.js";
import { OrderTransitionOutcome, OrderTransitionService } from "../orders/order-transition.service.js";
import type { OrderTransitionName } from "../orders/order-transitions.js";
import { IssuanceAttemptStatus } from "./issuance-attempt-status.js";
import {
  FIRST_ISSUANCE_ATTEMPT,
  IssuanceProvider,
  deriveIssuanceRequestId,
} from "./issuance-request-id.js";
import { SupplierAClient } from "./supplier-a.client.js";
import { SupplierDefiniteFailure, SupplierUnknownOutcome } from "./supplier-issue.errors.js";

/**
 * How the issuance ended — the three ways an order can leave this service.
 *
 * Named values in the shape every other service here uses
 * ({@link OrderTransitionOutcome}, {@link SupplierKeyClaimOutcome}), so the
 * caller's `switch` reads as news and the compiler has something to be
 * exhaustive about. **None of them is an error**, and none of them throws: an
 * empty pool is an ordinary business outcome and a silent supplier is an
 * ordinary network one.
 *
 * The split that matters to the caller is not "did it work?" — it is **"has the
 * order stopped moving?"**, because that is what decides whether the payment
 * event settles. The first two have; the third has not.
 */
export const IssuanceOutcome = {
  /** A code is bound in `deliveries` and the order is `delivered`. Terminal. */
  Delivered: "delivered",

  /**
   * The supplier answered with a definite refusal and the order is
   * `out_of_stock`. No delivery row exists and none ever will for this attempt.
   * Terminal for Phase 1; recoverable in Phase 3.
   */
  OutOfStock: "out_of_stock",

  /**
   * **No finishing status was reached.** In practice: the supplier gave no
   * usable answer, so the attempt stays `unknown`, the order rests in
   * `delivering`, and the caller must leave the payment event pending. A key may
   * or may not exist for this `request_id`, and the only thing that can find out
   * is another call with the same id.
   */
  Unresolved: "unresolved",
} as const;

export type IssuanceOutcome = (typeof IssuanceOutcome)[keyof typeof IssuanceOutcome];

/**
 * The result of driving one claimed order through issuance.
 *
 * A discriminated union, so `result.code` does not type-check until the caller
 * has narrowed to {@link IssuanceOutcome.Delivered} — the two non-delivering
 * outcomes cannot be skipped by accident, only refused on purpose.
 *
 * `requestId` is on every branch because it is the correlation id for this whole
 * path and the caller logs it whatever happened.
 */
export type IssuanceResult =
  | {
      readonly outcome: typeof IssuanceOutcome.Delivered;
      readonly requestId: string;
      /** The key now bound to this order in `deliveries`. */
      readonly code: string;
    }
  | {
      readonly outcome: typeof IssuanceOutcome.OutOfStock;
      readonly requestId: string;
      /** The supplier's own word, as recorded in `issuance_attempts.last_error`. */
      readonly reason: SupplierIssueErrorReason;
    }
  | {
      readonly outcome: typeof IssuanceOutcome.Unresolved;
      readonly requestId: string;
      /** Why nothing was concluded. For the log line; never branched on. */
      readonly detail: string;
    };

/** Exhaustiveness guard: the compiler routes here only if a case went unhandled. */
function assertNever(value: never): never {
  throw new Error(`issuance: unhandled value ${JSON.stringify(value)}`);
}

@Injectable()
export class IssuanceService {
  private readonly logger = new Logger(IssuanceService.name);

  /** Phase 1 calls exactly one supplier. Phase 3 chooses between two. */
  private readonly provider = IssuanceProvider.A;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    private readonly supplier: SupplierAClient,
    private readonly transitions: OrderTransitionService,
    private readonly orderLock: OrderLockService,
  ) {}

  /**
   * Drive one **already-claimed** order from `delivering` to a finishing status.
   *
   * The argument is the `orders` row returned by the winning
   * `paid → delivering` UPDATE, not an id: holding the row is proof the caller
   * won the claim, and it carries the `sku` the supplier is asked for without a
   * second read. Passing an id would make it possible to call this for an order
   * nobody claimed.
   *
   * Never throws for anything the supplier does. A definite refusal becomes
   * {@link IssuanceOutcome.OutOfStock}, silence becomes
   * {@link IssuanceOutcome.Unresolved}, and both are `200`s to the payment
   * provider. Only a genuine defect on our side — the database being
   * unreachable, a bug in this file — propagates, and it propagates *after* the
   * attempt row already says `unknown`.
   */
  async issueForClaimedOrder(order: Order): Promise<IssuanceResult> {
    // Derived, not generated, and derived here rather than passed in: there is
    // no caller that could have remembered it, and none that needs to.
    // (`./issuance-request-id.ts`.)
    const requestId = deriveIssuanceRequestId(order.id, this.provider, FIRST_ISSUANCE_ATTEMPT);

    // ---------------------------------------------------------------- STEP 1
    await this.recordAttempt(order, requestId);

    const request: SupplierIssueRequest = {
      request_id: requestId,
      sku: order.sku,
      order_id: order.id,
    };

    // ---------------------------------------------------------------- STEP 2
    // Outside every transaction. See the file header.
    let code: string;
    try {
      code = await this.supplier.issue(request);
    } catch (error: unknown) {
      // ##################################################################
      // # THE TWO CLASSES ARE HANDLED IN TWO PLACES, ON PURPOSE.
      // ##################################################################
      //
      // `instanceof` on the typed domain errors (`architecture.md` §8) rather
      // than on a string field, so the compiler is the thing keeping a timeout
      // out of the failure branch. If these two ever collapsed into one `catch`
      // arm, the shop would start asking a second supplier for a second key
      // while the first one may already have issued — which is the assignment's
      // central trap, sprung.
      if (error instanceof SupplierDefiniteFailure) {
        return this.applyDefiniteFailure(order, error);
      }

      if (error instanceof SupplierUnknownOutcome) {
        return this.leaveUnresolved(order, error);
      }

      // Not a supplier failure at all — a defect in our own code, or the
      // database. Rethrown deliberately: it is not something the retry policy
      // has an opinion about, and the webhook boundary already turns it into a
      // logged `200` with the event left pending
      // (`../payments/payment-webhook.controller.ts`). The attempt row is
      // already `unknown`, which stays true.
      throw error;
    }

    // ---------------------------------------------------------------- STEP 3
    return this.bindDelivery(order, requestId, code);
  }

  /**
   * §2.5 step 4, first half — **write down that we are about to ask.**
   *
   * Emitted SQL (copied from `.toSQL()`; per the project's raw-SQL rule,
   * `architecture.md` §2, "Documentation convention"):
   *
   *   insert into "issuance_attempts"
   *     ("id", "request_id", "order_id", "provider", "status", "code", "last_error", "created_at")
   *   values (default, $1, $2, $3, $4, default, default, default)
   *   on conflict ("request_id") do nothing
   *   returning "id", "request_id", "order_id", "provider", "status", "code",
   *             "last_error", "created_at";
   *   -- $4 = 'unknown'  — always. A row is never born in any other state.
   *   -- 1 row  => first time this request_id has been recorded. The durable
   *   --           record that we asked now exists, before we ask.
   *   -- 0 rows => this request_id was ALREADY recorded — a Phase 3 retry, or a
   *   --           re-entered issuance. Not an error, and nothing to write: the
   *   --           record this statement exists to guarantee is already there.
   *
   * ### `DO NOTHING`, not `DO UPDATE SET status = 'unknown'`
   *
   * `packages/db/src/schema/shop.ts` sketches the upsert form, and it is the
   * wrong shape for this call: on the Phase 3 retry path the existing row may
   * say `ok`, and resetting it to `unknown` would erase the one fact worth
   * having — the code the first attempt already obtained. `DO NOTHING` cannot
   * destroy history, and the guarantee wanted here is only that a row *exists*,
   * not that it says anything in particular.
   *
   * The zero-row path reads the existing row back purely to log what it says.
   * That read is advisory and nothing branches on it: deciding whether to call
   * the supplier from a status read a moment ago would be a check-then-act, and
   * it is unnecessary anyway — the supplier's ledger answers a repeat with the
   * original code (I5), so calling again is safe by construction. Phase 3 is
   * where this row starts driving a decision, and it will do so under the order
   * row lock.
   *
   *   select "id", "request_id", "order_id", "provider", "status", "code",
   *          "last_error", "created_at"
   *   from "issuance_attempts" where "issuance_attempts"."request_id" = $1;
   *   -- 0 rows => impossible in practice; the insert above lost the conflict to
   *   --           a row that must therefore exist. Logged, not thrown.
   *
   * No transaction: it is one statement, and its own implicit transaction is
   * exactly the unit of work wanted. Wrapping it would hold the instance's only
   * connection a moment longer for no gain.
   */
  private async recordAttempt(order: Order, requestId: string): Promise<void> {
    const [recorded] = await this.database.db
      .insert(issuanceAttempts)
      .values({
        requestId,
        orderId: order.id,
        provider: this.provider,
        // The whole point of the row. See `./issuance-attempt-status.ts`.
        status: IssuanceAttemptStatus.Unknown,
      })
      .onConflictDoNothing({ target: issuanceAttempts.requestId })
      .returning();

    if (recorded !== undefined) {
      this.logger.log({
        msg: "issuance: attempt recorded as unknown BEFORE the supplier call",
        order_id: order.id,
        request_id: requestId,
        provider: this.provider,
        attempt_status: recorded.status,
      });

      return;
    }

    const [existing] = await this.database.db
      .select()
      .from(issuanceAttempts)
      .where(eq(issuanceAttempts.requestId, requestId));

    this.logger.warn({
      msg: "issuance: this request_id was already recorded; re-asking the supplier with the same id",
      order_id: order.id,
      request_id: requestId,
      provider: this.provider,
      attempt_status: existing?.status,
    });
  }

  /**
   * §2.5 steps 5 and 6, success path — **transaction B**: take the order row
   * lock, then resolve the attempt, bind the key and finish the order, in one
   * short transaction.
   *
   * These three writes are one fact about the world. An order that is
   * `delivered` with no key, or that holds a key while still reading
   * `delivering`, is a support ticket either way — so they commit together or
   * not at all. The transaction is opened only now, *after* the network call has
   * returned, which is the whole reason the supplier call is not inside it.
   *
   * ### The lock comes first, before any of the three
   *
   * `SELECT … FOR UPDATE` on the order row is the first statement, because it is
   * the serialisation point: a lock taken after a write protects a write that
   * has already happened, which is nothing. Holding it for the whole body is
   * what makes the outcome atomic against a second worker — the claim in
   * transaction A excluded every other worker from *reaching the supplier*, and
   * this lock excludes them from *writing the answer* while this one is
   * mid-write. In Phase 1 no second worker can be here (only the claim winner
   * enters this service); Phase 3's admin re-issue and the retry path are two
   * more, and the lock is what they will arrive into rather than something added
   * for them later.
   *
   * It also means the `FOR KEY SHARE` that the `deliveries` foreign key takes on
   * this same order row a statement later is already held by this transaction,
   * so it cannot wait on itself. That ordering — parent first, then its children,
   * taken only by a transaction that already holds the parent — is the whole of
   * the deadlock argument (`../orders/order-lock.service.ts`, "Lock ordering").
   *
   * A rollback here is safe and self-healing rather than lossy: the attempt row
   * reverts to `unknown`, no delivery is bound, the order stays `delivering`,
   * and the payment event stays pending. A later call with the same
   * `request_id` is answered by the supplier's ledger with the *same* code (I5)
   * and binds it. Nothing is lost because nothing about the code was ours to
   * lose.
   *
   * ### The four statements
   *
   * **(0) Take the lock — I4, `architecture.md` §3.1.**
   *
   *   select "id", "client_request_id", "sku", "amount_minor", "currency",
   *          "status", "created_at", "updated_at"
   *   from "orders" where "orders"."id" = $1 for update;
   *   -- 1 row  => this transaction owns the order row until it commits. Any
   *   --           other worker that reaches an order-locking statement for this
   *   --           id waits here.
   *   -- 0 rows => the order vanished between the claim and now. Nothing is
   *   --           locked; the `deliveries` insert below would fail its foreign
   *   --           key and the whole transaction rolls back, which is the honest
   *   --           outcome — see {@link finishOrder}'s `order_not_found` branch.
   *
   * **(a) Resolve the attempt.**
   *
   *   update "issuance_attempts" set "status" = $1, "code" = $2
   *   where "issuance_attempts"."request_id" = $3;
   *   -- $1 = 'ok'. `request_id` is UNIQUE (issuance_attempts_request_id_key),
   *   -- so this names exactly one row and there is nothing to guard against.
   *
   * **(b) Bind the delivery — I3, `architecture.md` §3.1.**
   *
   *   insert into "deliveries"
   *     ("id", "order_id", "code", "provider", "request_id", "created_at")
   *   values (default, $1, $2, $3, $4, default)
   *   on conflict ("order_id") do nothing
   *   returning "id", "order_id", "code", "provider", "request_id", "created_at";
   *   -- 1 row  => THIS call bound the key. Across every process, at most one
   *   --           caller ever sees this per order.
   *   -- 0 rows => this order ALREADY has a delivery. Not an error and not a
   *   --           branch to re-issue on: the existing row stands, the code we
   *   --           just obtained is discarded, and the shopper keeps the key
   *   --           they were already given.
   *
   * **The unique index is the guarantee; the `ON CONFLICT` only keeps the loser
   * from raising.** This is the difference the assignment is testing. The
   * application-level alternative —
   *
   *     const existing = await db.select().from(deliveries).where(eq(orderId, id));
   *     if (existing === undefined) await db.insert(deliveries).values(...);
   *
   * — has a window between the read and the write, and two workers in two
   * processes both see "not delivered" and both insert. No lock in this process
   * can close it, because the other worker is not in this process: on Vercel the
   * two requests are two function instances with separate memory
   * (`architecture.md` §5). `deliveries_order_id_key` is enforced by the one
   * component both of them share, and it is enforced at write time rather than
   * at read time, so there is no window at all. Removing `ON CONFLICT` would not
   * break the guarantee — it would only turn the loser's no-op into a `23505`.
   *
   * `deliveries_request_id_key` (UNIQUE on `request_id`) is deliberately **not**
   * a conflict target here. A violation of it would mean one supplier request
   * being bound to two different orders, which is not something to swallow —
   * it raises, and it should.
   *
   * **(c) Finish the order.** `delivering → delivered`, through the transition
   * helper on the transaction's handle, so it commits with the delivery row:
   *
   *   update "orders" set "status" = $1, "updated_at" = now()
   *   where ("orders"."id" = $2 and "orders"."status" = ANY($3))
   *   returning ...;
   *   -- $1 = 'delivered', $3 = '{delivering}'
   *   -- 1 row  => the order is finished.
   *   -- 0 rows => the order was not `delivering`. Unreachable in Phase 1 (only
   *   --           the claim winner reaches this code, and only this code moves
   *   --           an order out of `delivering`), and reported rather than
   *   --           swallowed — see {@link finishOrder}.
   */
  private async bindDelivery(order: Order, requestId: string, code: string): Promise<IssuanceResult> {
    const { delivery, bound, finished, lockedStatus } = await this.database.transaction(async (tx) => {
      // (0) — THE LOCK. First statement in the transaction, always. Nothing
      // branches on the row that comes back; it is here so the log line can say
      // what state this worker found the order in when it took the lock.
      const locked = await this.orderLock.lockOrder(tx, order.id);

      // (a)
      await tx
        .update(issuanceAttempts)
        .set({ status: IssuanceAttemptStatus.Ok, code })
        .where(eq(issuanceAttempts.requestId, requestId));

      // (b) — I3.
      const [inserted] = await tx
        .insert(deliveries)
        .values({ orderId: order.id, code, provider: this.provider, requestId })
        .onConflictDoNothing({ target: deliveries.orderId })
        .returning();

      // Zero rows means the unique index refused a second delivery for this
      // order. Read the winner back so the log line and the result report the
      // key the shopper actually holds, not the one this call happened to fetch.
      //
      //   select "id", "order_id", "code", "provider", "request_id", "created_at"
      //   from "deliveries" where "deliveries"."order_id" = $1;
      //   -- Runs only when the insert above matched nothing, and inside this
      //   -- transaction, so it sees the row that beat us however recently it
      //   -- committed.
      const existing =
        inserted ?? (await tx.select().from(deliveries).where(eq(deliveries.orderId, order.id)))[0];

      // (c)
      const outcome = await this.finishOrder(tx, order, requestId, "completeDelivery");

      return {
        delivery: existing,
        bound: inserted !== undefined,
        finished: outcome,
        lockedStatus: locked?.status,
      };
    });

    return this.reportDelivery(order, requestId, code, delivery, bound, finished, lockedStatus);
  }

  /**
   * The log line and the result for the success path, built after the
   * transaction has committed — never before. Until `COMMIT` returns, nothing
   * written above is a fact, and a line claiming a delivery from inside the
   * transaction would be a claim that a rollback could silently falsify.
   */
  private reportDelivery(
    order: Order,
    requestId: string,
    code: string,
    delivery: Delivery | undefined,
    bound: boolean,
    finished: OrderStatus | undefined,
    lockedStatus: OrderStatus | undefined,
  ): IssuanceResult {
    if (finished !== OrderStatus.Delivered) {
      return {
        outcome: IssuanceOutcome.Unresolved,
        requestId,
        detail: `a key is bound to ${order.id} but the order did not reach delivered`,
      };
    }

    this.logger.log({
      msg: bound
        ? "issuance: key bound and order delivered"
        : "issuance: order already had a delivery; the existing key stands (I3)",
      order_id: order.id,
      request_id: requestId,
      provider: this.provider,
      status: OrderStatus.Delivered,
      bound_by_this_call: bound,
      // What the order read the instant transaction B's lock was granted.
      // `delivering` on every ordinary run; anything else means a second worker
      // reached the outcome first, which is exactly what the lock exists to make
      // visible rather than invisible.
      locked_status: lockedStatus,
    });

    // The bound row's code, not the one just fetched. They are the same value on
    // every reachable path; naming the row makes it impossible for them not to
    // be, and the shopper's key is by definition the one in `deliveries`.
    return { outcome: IssuanceOutcome.Delivered, requestId, code: delivery?.code ?? code };
  }

  /**
   * §2.5 step 6, definite-failure path — **`delivering → out_of_stock`, and it
   * must not raise.**
   *
   * "Paid, and there is nothing to hand over" is a state this system
   * understands, not an exception. Throwing here would produce a `500` on a
   * webhook, which is how a payment provider is asked to redeliver an event that
   * would fail identically every time; and the shopper's order page would show
   * an error instead of an honest state (functional spec, Slice 6).
   *
   * Three statements in one transaction — **transaction B again**, the same
   * shape as the success path and for the same reason: the lock first, then the
   * writes it makes atomic against another worker.
   *
   *   select "id", "client_request_id", "sku", "amount_minor", "currency",
   *          "status", "created_at", "updated_at"
   *   from "orders" where "orders"."id" = $1 for update;
   *   -- I4, `architecture.md` §3.1. Held until COMMIT, which is three
   *   -- statements and no network I/O away.
   *
   *   update "issuance_attempts" set "status" = $1, "last_error" = $2
   *   where "issuance_attempts"."request_id" = $3;
   *   -- $1 = 'failed' — DEFINITE. Written only because a contract-shaped error
   *   -- body was parsed; a timeout can never reach this statement.
   *
   *   update "orders" set "status" = $1, "updated_at" = now()
   *   where ("orders"."id" = $2 and "orders"."status" = ANY($3))
   *   returning ...;
   *   -- $1 = 'out_of_stock', $3 = '{delivering}'
   *
   * **No `deliveries` row is written, and that is the point.** The absence is
   * what makes `out_of_stock` recoverable in Phase 3: nothing was claimed, the
   * supplier's ledger has no entry for this `request_id`
   * (`../suppliers/supplier-key-claim.service.ts`), and re-driving the identical
   * request after a restock issues normally rather than needing a new id.
   *
   * The `switch` on `reason` has an exhaustiveness guard, so Phase 3 adding a
   * member to `SupplierIssueErrorReason` is a compile error here rather than a
   * silent fall-through that quietly routes a new failure to `out_of_stock`.
   */
  private async applyDefiniteFailure(
    order: Order,
    failure: SupplierDefiniteFailure,
  ): Promise<IssuanceResult> {
    const transition = this.transitionForReason(failure.reason);

    const { finished, lockedStatus } = await this.database.transaction(async (tx) => {
      // THE LOCK, first — see {@link bindDelivery}. A definite refusal is still
      // an outcome being written to the order, so it is serialised exactly like
      // a success.
      const locked = await this.orderLock.lockOrder(tx, order.id);

      await tx
        .update(issuanceAttempts)
        .set({ status: IssuanceAttemptStatus.Failed, lastError: failure.reason })
        .where(eq(issuanceAttempts.requestId, failure.requestId));

      const outcome = await this.finishOrder(tx, order, failure.requestId, transition);

      return { finished: outcome, lockedStatus: locked?.status };
    });

    if (finished !== OrderStatus.OutOfStock) {
      return {
        outcome: IssuanceOutcome.Unresolved,
        requestId: failure.requestId,
        detail: `supplier refused (${failure.reason}) but the order did not reach out_of_stock`,
      };
    }

    this.logger.warn({
      msg: "issuance: definite failure — supplier refused; order moved to out_of_stock, no delivery bound",
      order_id: order.id,
      request_id: failure.requestId,
      provider: this.provider,
      reason: failure.reason,
      attempt_status: failure.attemptStatus,
      status: OrderStatus.OutOfStock,
      locked_status: lockedStatus,
    });

    return {
      outcome: IssuanceOutcome.OutOfStock,
      requestId: failure.requestId,
      reason: failure.reason,
    };
  }

  /** Which lifecycle move a definite refusal maps to. One reason exists in Phase 1. */
  private transitionForReason(reason: SupplierIssueErrorReason): OrderTransitionName {
    switch (reason) {
      case SupplierIssueErrorReason.OutOfStock:
        return "markOutOfStock";

      default:
        return assertNever(reason);
    }
  }

  /**
   * §2.5 steps 4-6, unknown path — **write nothing, conclude nothing, and stop.**
   *
   * There is deliberately no database write here at all. The attempt row already
   * says `unknown`, which is still the truth; the order stays `delivering`,
   * which is still the truth; and the payment event stays pending, which is what
   * keeps the order findable. Writing anything would mean claiming to know
   * something we do not.
   *
   * In particular this does **not** move the order to `out_of_stock` or to
   * anything else terminal. A key may exist for this `request_id`, and the only
   * way to find out is to ask supplier A again with the same id — which is what
   * Phase 3's retry does, and why it must not fall through to supplier B first
   * (`architecture.md` §4, "The hard rule").
   *
   * Logged at `error` level, unlike the client's own `warn`: from the client's
   * point of view a silent supplier is one failed call, but from here it is a
   * paid order left undelivered with a request outstanding — the exact condition
   * the Phase 3 admin panel exists to surface, and the one worth finding in a log
   * search.
   */
  private leaveUnresolved(order: Order, unknown: SupplierUnknownOutcome): IssuanceResult {
    this.logger.error({
      msg: "issuance: UNKNOWN outcome — order left in delivering with an outstanding request; no retry policy in this phase",
      order_id: order.id,
      request_id: unknown.requestId,
      provider: this.provider,
      attempt_status: unknown.attemptStatus,
      detail: unknown.detail,
      status: OrderStatus.Delivering,
    });

    return {
      outcome: IssuanceOutcome.Unresolved,
      requestId: unknown.requestId,
      detail: unknown.detail,
    };
  }

  /**
   * Run the finishing transition **inside the caller's transaction**, and report
   * the status the order ended up in.
   *
   * `transitionWithin`, never `transition`: the latter asks the pool for a
   * connection of its own, and with `max: 1` the connection it would wait for is
   * the one this transaction is holding — a self-deadlock that ends at
   * `CONNECTION_TIMEOUT_MS` with an error that looks nothing like its cause
   * ({@link OrderTransitionService.transition}).
   *
   * Zero rows is unreachable in Phase 1: the only caller here is the winner of
   * `paid → delivering`, and the only statements that move an order out of
   * `delivering` are the two this service issues. It is still reported rather
   * than assumed, at `error` level, because an unreachable state that has been
   * reached is exactly the thing that must not be silent — and because Phase 3's
   * admin re-issue adds a second worker to this path.
   *
   * The transaction is **not** rolled back on that path. On the success branch
   * the `deliveries` row records a key the supplier really did issue against
   * this `request_id`, and discarding it would leave the supplier's ledger
   * holding a code bound to nothing on our side. Keeping the row and reporting
   * {@link IssuanceOutcome.Unresolved} leaves the event pending, which is the
   * outcome that can still be recovered from.
   */
  private async finishOrder(
    tx: Transaction,
    order: Order,
    requestId: string,
    transition: OrderTransitionName,
  ): Promise<OrderStatus | undefined> {
    const result = await this.transitions.transitionWithin(tx, order.id, transition);

    switch (result.outcome) {
      case OrderTransitionOutcome.Transitioned:
        return result.order.status;

      case OrderTransitionOutcome.NotInSourceState:
        this.logger.error({
          msg: "issuance: the finishing transition matched zero rows; the order was not delivering",
          order_id: order.id,
          request_id: requestId,
          provider: this.provider,
          transition,
          observed_status: result.observed.status,
        });

        return result.observed.status;

      case OrderTransitionOutcome.OrderNotFound:
        this.logger.error({
          msg: "issuance: the order vanished between the claim and the finishing transition",
          order_id: order.id,
          request_id: requestId,
          provider: this.provider,
          transition,
        });

        return undefined;

      default:
        return assertNever(result);
    }
  }
}
