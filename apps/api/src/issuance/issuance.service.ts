/**
 * **One ask, of one supplier, for one already-reserved attempt.**
 *
 * This file used to be the whole of issuance: derive the id, record the
 * attempt, call supplier A, and settle the order whatever came back. Phase 3
 * splits that in two, because "what did this supplier say?" and "what should
 * the shop do about it?" are different questions and only the second one needs
 * to see the ledger:
 *
 *   - **{@link IssuanceRunnerService}** owns the policy — the claim under the
 *     lock, the ladder walk, the attempt reservation and every order
 *     transition. It is the single entry point for both the automatic path and
 *     the operator's retry.
 *   - **This service owns the boundary** — the HTTP call, the classification of
 *     what came back, and, on success only, the one short transaction that
 *     binds the key and finishes the order.
 *
 * The split is what makes the retry policy testable without a supplier: the
 * ladder is a pure function of rows (`./issuance-ladder.ts`) precisely because
 * nothing in it has to reach this file.
 *
 * ---------------------------------------------------------------------------
 * THE ORDERING IS THE DESIGN. THERE ARE THREE STEPS AND THEY MAY NOT BE SWAPPED.
 * ---------------------------------------------------------------------------
 *
 *     1. WRITE   reserve the attempt as `unknown`   ← THE RUNNER, in TX A / A′
 *     2. CALL    POST {SUPPLIER_x_URL}/issue        ← here, no transaction
 *     3. WRITE   resolve + bind + finish            ← here, TX B: lock, then write
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
 * **Step 1 moved into the runner's transaction, and that is a strengthening.**
 * Phase 1 wrote the row here, outside any transaction, and argued — correctly —
 * that opening a transaction *just* for it would take a lock that was released
 * before the next line of TypeScript ran. Phase 3 does not open a transaction
 * for it: it writes the row inside a transaction that is **already** holding the
 * order row lock for the ladder's sake, and guards the write on the order still
 * being `delivering` (spec 003 §6, transaction A′). The row is still written
 * before the call, which is the property that mattered.
 *
 * ---------------------------------------------------------------------------
 * THIS SERVICE NEVER MOVES AN ORDER EXCEPT TO `delivered`
 * ---------------------------------------------------------------------------
 * A definite refusal used to be settled here, straight to `out_of_stock`. It
 * cannot be any more, and the reason is the whole of slice 2: after supplier A
 * refuses, the order must stay `delivering` so that supplier B can be asked
 * under the same claim. Settling it and re-claiming would need a transition
 * that does not exist yet, and would show the shopper an `out_of_stock` flicker
 * for an order that is about to be delivered.
 *
 * So a refusal returns {@link SupplierAskOutcome.Refused} and **writes
 * nothing**. The runner's transaction A′ records `failed` against the attempt
 * and then — under the lock, from the ledger it just wrote — decides whether
 * there is another supplier to ask or the order is settled.
 *
 * ---------------------------------------------------------------------------
 * WHY NO TRANSACTION SPANS THE CALL
 * ---------------------------------------------------------------------------
 * `packages/db/src/client.ts` sets `max: 1` per instance, and Drizzle checks the
 * single connection out for the whole of `transaction()`. A transaction held
 * across an HTTP round trip therefore stalls every other statement this instance
 * wants to run, for as long as the supplier takes — up to
 * `SUPPLIER_TIMEOUT_MS`. The constraint is stated four times in the codebase
 * (the client, {@link OrderTransitionService}, {@link OrderLockService}, and
 * {@link IssuanceRunnerService}) because it is the one that is easiest to
 * violate by accident and hardest to diagnose afterwards: the symptom is
 * unrelated requests timing out.
 *
 * It is also the reason the lock is taken **twice**, in two transactions, rather
 * than once across the call. Two acquisitions of a short lock cost two round
 * trips; one acquisition held across the supplier call would cost the instance.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";

import {
  OrderStatus,
  type SupplierIssueErrorReason,
  type SupplierIssueRequest,
} from "@game-shop/contracts";
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
import type { IssuanceAsk } from "./issuance-ladder.js";
import { IssuanceProvider } from "./issuance-request-id.js";
import { SUPPLIER_A_CLIENT, SUPPLIER_B_CLIENT, SupplierClient } from "./supplier.client.js";
import { SupplierDefiniteFailure, SupplierUnknownOutcome } from "./supplier-issue.errors.js";

/**
 * How one supplier call ended — **three answers, and the split between the last
 * two is the assignment's central trap.**
 *
 * Named values in the shape every other outcome type here uses, so the caller's
 * `switch` reads as news and the compiler has something to be exhaustive about.
 * None of them is an error and none of them throws: an empty pool is an ordinary
 * business outcome and a silent supplier is an ordinary network one.
 */
export const SupplierAskOutcome = {
  /**
   * **The supplier returned a code, and transaction B committed.** The key is
   * bound in `deliveries` and the order was moved with `completeDelivery`.
   */
  Issued: "issued",

  /**
   * **The supplier answered, and the answer was no.** We know no key was
   * issued: the answer arrived from a claim transaction that committed having
   * written nothing. Nothing has been written on our side either — the runner's
   * transaction A′ records `failed` and decides what happens next, because that
   * decision needs the ledger and the lock, and this service has neither.
   */
  Refused: "refused",

  /**
   * **There is no answer, and there may or may not be a key.** A timeout, a
   * dead socket, a body that did not parse. Nothing is written, because the
   * attempt row already says `unknown` and that is still the truth. The only
   * safe next move is to ask **this** supplier **this same** `request_id`
   * again; falling through to another supplier from here is how one order gets
   * charged for two keys (`architecture.md` §4, "The hard rule").
   */
  NoAnswer: "no_answer",
} as const;

export type SupplierAskOutcome = (typeof SupplierAskOutcome)[keyof typeof SupplierAskOutcome];

/**
 * The result of one supplier call.
 *
 * A discriminated union, so `result.code` does not type-check until the caller
 * has narrowed to {@link SupplierAskOutcome.Issued}, and `result.reason` does
 * not type-check on the branch where no supplier said anything. `requestId` and
 * `provider` are on every branch because they are the correlation ids for this
 * whole path and the caller logs them whatever happened.
 */
export type SupplierAskResult =
  | {
      readonly outcome: typeof SupplierAskOutcome.Issued;
      readonly requestId: string;
      readonly provider: IssuanceProvider;
      /** The key now bound to this order in `deliveries`. */
      readonly code: string;
      /** Whether *this* call bound it, or found one already bound (I3). */
      readonly bound: boolean;
      /**
       * The status the order ended transaction B in. `delivered` on every
       * ordinary run; anything else means the finishing transition matched zero
       * rows, and the caller must report that rather than claiming a delivery.
       */
      readonly finished: OrderStatus | undefined;
    }
  | {
      readonly outcome: typeof SupplierAskOutcome.Refused;
      readonly requestId: string;
      readonly provider: IssuanceProvider;
      /** The supplier's own word, to be written to `issuance_attempts.last_error`. */
      readonly reason: SupplierIssueErrorReason;
    }
  | {
      readonly outcome: typeof SupplierAskOutcome.NoAnswer;
      readonly requestId: string;
      readonly provider: IssuanceProvider;
      /** Which flavour of silence. For the log line; never branched on. */
      readonly detail: string;
    };

/** Exhaustiveness guard: the compiler routes here only if a case went unhandled. */
function assertNever(value: never): never {
  throw new Error(`issuance: unhandled value ${JSON.stringify(value)}`);
}

@Injectable()
export class IssuanceService {
  private readonly logger = new Logger(IssuanceService.name);

  /**
   * One client per supplier, keyed by the provider tag the ladder chose.
   *
   * `satisfies Record<IssuanceProvider, SupplierClient>` is a tripwire, not
   * decoration: adding a third member to {@link IssuanceProvider} — which is
   * also the fall-through order the ladder walks — stops the build here, at the
   * one place that would otherwise have to fail at runtime with "cannot read
   * property issue of undefined", on a paid order, at the first fall-through.
   */
  private readonly suppliers: Readonly<Record<IssuanceProvider, SupplierClient>>;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(SUPPLIER_A_CLIENT) supplierA: SupplierClient,
    @Inject(SUPPLIER_B_CLIENT) supplierB: SupplierClient,
    private readonly transitions: OrderTransitionService,
    private readonly orderLock: OrderLockService,
  ) {
    this.suppliers = {
      [IssuanceProvider.A]: supplierA,
      [IssuanceProvider.B]: supplierB,
    } satisfies Record<IssuanceProvider, SupplierClient>;
  }

  /**
   * Ask one supplier for one key, for an attempt the caller has **already
   * reserved**.
   *
   * The first argument is the `orders` row the caller claimed, not an id:
   * holding the row is proof the caller won the claim, and it carries the `sku`
   * the supplier is asked for without a second read. The second is the ladder's
   * chosen rung — provider, attempt number and the id derived from them. This
   * service never chooses any of the three, which is what keeps "which supplier
   * next" a decision made from the recorded ledger rather than from a field on
   * a class.
   *
   * Never throws for anything the supplier does. A definite refusal becomes
   * {@link SupplierAskOutcome.Refused}, silence becomes
   * {@link SupplierAskOutcome.NoAnswer}, and both are `200`s to the payment
   * provider. Only a genuine defect on our side — the database being
   * unreachable, a bug in this file — propagates, and it propagates *after* the
   * attempt row already says `unknown`.
   */
  async askSupplier(order: Order, ask: IssuanceAsk): Promise<SupplierAskResult> {
    const request: SupplierIssueRequest = {
      request_id: ask.requestId,
      sku: order.sku,
      order_id: order.id,
    };

    // ---------------------------------------------------------------- STEP 2
    // Outside every transaction. See the file header.
    let code: string;
    try {
      code = await this.suppliers[ask.provider].issue(request);
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
        return this.reportRefusal(order, ask, error);
      }

      if (error instanceof SupplierUnknownOutcome) {
        return this.reportNoAnswer(order, ask, error);
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
    return this.bindDelivery(order, ask, code);
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
   * mid-write. Phase 3's operator retry and its resume path are two more workers
   * that arrive here, which is why the lock was built in Phase 2 rather than
   * being added for them now.
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
   *   -- $3 is the provider THE LADDER CHOSE, not a field on this class. After a
   *   --    fall-through the shopper's key came from `b`, and `deliveries.provider`
   *   --    has to say so or the ledger and the delivery disagree about who
   *   --    issued it.
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
   *   -- 0 rows => the order was not `delivering`. Reported rather than
   *   --           swallowed — see {@link finishOrder}.
   */
  private async bindDelivery(
    order: Order,
    ask: IssuanceAsk,
    code: string,
  ): Promise<SupplierAskResult> {
    const { delivery, bound, finished, lockedStatus } = await this.database.transaction(async (tx) => {
      // (0) — THE LOCK. First statement in the transaction, always. Nothing
      // branches on the row that comes back; it is here so the log line can say
      // what state this worker found the order in when it took the lock.
      const locked = await this.orderLock.lockOrder(tx, order.id);

      // (a)
      await tx
        .update(issuanceAttempts)
        .set({ status: IssuanceAttemptStatus.Ok, code })
        .where(eq(issuanceAttempts.requestId, ask.requestId));

      // (b) — I3.
      const [inserted] = await tx
        .insert(deliveries)
        .values({ orderId: order.id, code, provider: ask.provider, requestId: ask.requestId })
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
      const outcome = await this.finishOrder(tx, order, ask, "completeDelivery");

      return {
        delivery: existing,
        bound: inserted !== undefined,
        finished: outcome,
        lockedStatus: locked?.status,
      };
    });

    return this.reportDelivery(order, ask, code, delivery, bound, finished, lockedStatus);
  }

  /**
   * The log line and the result for the success path, built after the
   * transaction has committed — never before. Until `COMMIT` returns, nothing
   * written above is a fact, and a line claiming a delivery from inside the
   * transaction would be a claim that a rollback could silently falsify.
   */
  private reportDelivery(
    order: Order,
    ask: IssuanceAsk,
    code: string,
    delivery: Delivery | undefined,
    bound: boolean,
    finished: OrderStatus | undefined,
    lockedStatus: OrderStatus | undefined,
  ): SupplierAskResult {
    this.logger.log({
      msg:
        finished !== OrderStatus.Delivered
          ? "issuance: a key is bound but the order did not reach delivered"
          : bound
            ? "issuance: key bound and order delivered"
            : "issuance: order already had a delivery; the existing key stands (I3)",
      order_id: order.id,
      request_id: ask.requestId,
      provider: ask.provider,
      attempt: ask.attempt,
      status: finished,
      bound_by_this_call: bound,
      // What the order read the instant transaction B's lock was granted.
      // `delivering` on every ordinary run; anything else means a second worker
      // reached the outcome first, which is exactly what the lock exists to make
      // visible rather than invisible.
      locked_status: lockedStatus,
    });

    return {
      outcome: SupplierAskOutcome.Issued,
      requestId: ask.requestId,
      provider: ask.provider,
      // The bound row's code, not the one just fetched. They are the same value
      // on every reachable path; naming the row makes it impossible for them not
      // to be, and the shopper's key is by definition the one in `deliveries`.
      code: delivery?.code ?? code,
      bound,
      finished,
    };
  }

  /**
   * **A definite refusal, reported and not written.**
   *
   * "Paid, and this supplier has nothing to hand over" is a state this system
   * understands, not an exception. Throwing here would produce a `500` on a
   * webhook, which is how a payment provider is asked to redeliver an event that
   * would fail identically every time; and the shopper's order page would show
   * an error instead of an honest state (functional spec, Slice 6).
   *
   * **No database write happens on this path, and that is the change slice 2
   * makes.** Phase 1 recorded `failed` and settled the order to `out_of_stock`
   * in one transaction, because there was nothing else the shop could do. Now
   * there is: the runner's transaction A′ records `failed` *and re-reads the
   * ledger under the order row lock*, so the decision that follows the refusal
   * is taken from the rows rather than from this call's local knowledge. Writing
   * `failed` here as well would be the same fact written twice, in two
   * transactions, with a window in between where the ledger says the attempt
   * failed and nobody owns the next rung.
   *
   * No `deliveries` row is written either, and that absence is what makes the
   * refusal recoverable: nothing was claimed, the supplier's ledger has no entry
   * for this `request_id` (`../suppliers/supplier-key-claim.service.ts`), and a
   * later attempt against a restocked pool issues normally.
   */
  private reportRefusal(
    order: Order,
    ask: IssuanceAsk,
    failure: SupplierDefiniteFailure,
  ): SupplierAskResult {
    this.logger.warn({
      msg: "issuance: DEFINITE failure — the supplier answered and the answer was no; nothing issued",
      order_id: order.id,
      request_id: failure.requestId,
      provider: ask.provider,
      attempt: ask.attempt,
      reason: failure.reason,
      attempt_status: failure.attemptStatus,
    });

    return {
      outcome: SupplierAskOutcome.Refused,
      requestId: failure.requestId,
      provider: ask.provider,
      reason: failure.reason,
    };
  }

  /**
   * **Write nothing, conclude nothing, and stop.**
   *
   * There is deliberately no database write here at all. The attempt row already
   * says `unknown`, which is still the truth; the order stays `delivering`,
   * which is still the truth; and the payment event stays pending, which is what
   * keeps the order findable. Writing anything would mean claiming to know
   * something we do not.
   *
   * In particular this does **not** move the order to a settled status, and the
   * runner does not fall through on it. A key may exist for this `request_id`,
   * and the only way to find out is to ask this same supplier again with the
   * same id — which is slice 3's `probe` rung, and why it must not fall through
   * to another supplier first (`architecture.md` §4, "The hard rule").
   *
   * Logged at `error` level, unlike the client's own `warn`: from the client's
   * point of view a silent supplier is one failed call, but from here it is a
   * paid order left undelivered with a request outstanding — the exact condition
   * the recovery list exists to surface, and the one worth finding in a log
   * search.
   */
  private reportNoAnswer(
    order: Order,
    ask: IssuanceAsk,
    unknown: SupplierUnknownOutcome,
  ): SupplierAskResult {
    this.logger.error({
      msg: "issuance: UNKNOWN outcome — the request is outstanding; the same id must be re-asked, never another supplier",
      order_id: order.id,
      request_id: unknown.requestId,
      provider: ask.provider,
      attempt: ask.attempt,
      attempt_status: unknown.attemptStatus,
      detail: unknown.detail,
      status: OrderStatus.Delivering,
    });

    return {
      outcome: SupplierAskOutcome.NoAnswer,
      requestId: unknown.requestId,
      provider: ask.provider,
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
   * Zero rows means another worker moved the order out of `delivering` between
   * this worker's claim and its answer. Reported at `error` level rather than
   * assumed away, because an unreachable state that has been reached is exactly
   * the thing that must not be silent — and Phase 3's operator retry and resume
   * put two more workers on this path.
   *
   * The transaction is **not** rolled back on that path. The `deliveries` row
   * records a key the supplier really did issue against this `request_id`, and
   * discarding it would leave the supplier's ledger holding a code bound to
   * nothing on our side. Keeping the row and reporting the observed status
   * leaves the payment event pending, which is the outcome that can still be
   * recovered from.
   */
  private async finishOrder(
    tx: Transaction,
    order: Order,
    ask: IssuanceAsk,
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
          request_id: ask.requestId,
          provider: ask.provider,
          transition,
          observed_status: result.observed.status,
        });

        return result.observed.status;

      case OrderTransitionOutcome.OrderNotFound:
        this.logger.error({
          msg: "issuance: the order vanished between the claim and the finishing transition",
          order_id: order.id,
          request_id: ask.requestId,
          provider: ask.provider,
          transition,
        });

        return undefined;

      default:
        return assertNever(result);
    }
  }
}
