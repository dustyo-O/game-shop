/**
 * **The single entry point into issuance** (spec 003 technical-considerations
 * §0, §2.5).
 *
 * Claim the order under the lock, walk the ladder to a resting state, settle it.
 * Both callers arrive here — the automatic path behind the payment event, and
 * (slice 5) the operator's retry — so there is exactly one implementation of the
 * claim, the lock and the rung sequence.
 *
 *   > **There is no admin-only path into issuance.** That is the design's
 *   > load-bearing simplification: §2.5's guarantees are the guarantees Phase 2
 *   > already proved, because it is literally the same code.
 *
 * ---------------------------------------------------------------------------
 * THREE TRANSACTIONS, AND NOT ONE OF THEM SPANS A SUPPLIER CALL
 * ---------------------------------------------------------------------------
 * §6's shape, implemented statement for statement:
 *
 *     TX A   BEGIN; lock; read the ledger; claim; reserve the attempt; COMMIT;
 *     ————   POST {SUPPLIER_a_URL}/issue        ← no transaction, no lock held
 *     TX A′  BEGIN; lock; resolve attempt n; read the ledger; reserve n+1 or
 *            settle; COMMIT;                                (definite refusal only)
 *     TX A″  BEGIN; lock; read the ledger; count a probe or settle; COMMIT;
 *                                                           (NO ANSWER only —
 *            and it writes NOTHING about the attempt, which is the whole phase)
 *     ————   POST {SUPPLIER_a_URL}/issue        ← the SAME id, to the SAME supplier
 *     TX B   BEGIN; lock; resolve; bind; finish; COMMIT;    (`./issuance.service.ts`)
 *
 * `packages/db/src/client.ts` sets `max: 1` per instance, which makes the
 * connection a mutex: a transaction held across `POST /issue` stalls *every
 * other statement this process wants to run* — catalogue, order creation,
 * webhook intake, every status poll — for up to `SUPPLIER_TIMEOUT_MS`. The
 * retry gets no exception; it gets Phase 2's bracket with one extra statement in
 * the first transaction.
 *
 * ---------------------------------------------------------------------------
 * THE NEW STATEMENT, AND WHY THE LOCK STOPS BEING DEFENCE IN DEPTH
 * ---------------------------------------------------------------------------
 * Transaction A widens from two statements to three, and the new one is the
 * ledger read {@link IssuanceHistory.readWithin} performs. That read is a
 * **read-then-act with nothing else protecting it**: the ladder is a function of
 * a *set* of rows, and no single guarded statement can evaluate it, so unlike
 * every other decision in this codebase it cannot be handed to Postgres.
 *
 * Phase 2 was honest that the lock was not, by itself, what kept the shopper to
 * one key — I3, I5 and I6 did that, and measurably kept doing it with the lock
 * removed. That stops being true here. Two workers on *different* snapshots
 * compute *different* rungs, ask two suppliers two different questions, and two
 * keys leave the pool; the ledger cannot help, because it is keyed on
 * `request_id` and these are two of them. `deliveries_order_id_key` still keeps
 * the *shopper* to one key, so the shop looks correct from outside — what breaks
 * is **stock accounting**, and that is the only assertion that can catch it (R2).
 *
 * The type system carries half of that: `readWithin` takes a `Transaction` and
 * has no pooled overload, so "move the query up for clarity" does not compile
 * (R4). This file carries the other half by never computing a rung anywhere
 * except inside {@link IssuanceRunnerService.actOnStep}'s two callers, both of
 * which hold the lock.
 *
 * ---------------------------------------------------------------------------
 * ONE INVOCATION WALKS THE WHOLE LADDER (A2)
 * ---------------------------------------------------------------------------
 * The ladder runs to a resting state inside one call rather than one rung per
 * call with a scheduler re-entering. One claim = one worker = one ladder walk
 * keeps the exclusion story identical to Phase 2's.
 *
 * The cost is a term in the invocation budget, and it is a platform limit
 * nothing in code can enforce (R5):
 *
 *     SUPPLIER_MAX_PROBES_PER_REQUEST × SUPPLIER_TIMEOUT_MS × |supplierLadder|
 *         +  overhead   <   function execution ceiling
 *
 * When the ceiling wins anyway the failure is survivable by construction:
 * attempts say `unknown`, the order sits in `delivering`, the payment event is
 * still pending, and the order appears in the recovery list. The product is
 * computed and logged by this service's constructor, which is the one place
 * holding all three factors — the two configured numbers and the ladder's own
 * length.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";

import { OrderStatus } from "@game-shop/contracts";
import type { DatabaseClient, Order, Transaction } from "@game-shop/db";

import {
  SUPPLIER_PROBE_BUDGET_CONFIG,
  type SupplierProbeBudgetConfig,
} from "../config/supplier-config.js";
import { DATABASE_CLIENT } from "../database/database.module.js";
import { OrderLockService } from "../orders/order-lock.service.js";
import {
  OrderTransitionOutcome,
  OrderTransitionService,
  type OrderTransitionResult,
} from "../orders/order-transition.service.js";
import type { OrderTransitionName } from "../orders/order-transitions.js";
import { IssuanceHistory, ReserveAttemptOutcome, type ReserveAttemptResult } from "./issuance-history.js";
import {
  IssuanceRound,
  IssuanceRung,
  isAskStep,
  nextIssuanceStep,
  supplierLadder,
  type IssuanceRefusal,
  type IssuanceStep,
  type RestStep,
  type SettleNeverEstablishedStep,
  type SettleRefusedStep,
  type SettleRefusedTransition,
} from "./issuance-ladder.js";
import { IssuanceService, SupplierAskOutcome } from "./issuance.service.js";

/**
 * Who is asking for the order to be driven.
 *
 * It decides **one** thing: which lifecycle transitions this caller is allowed
 * to claim the order with (§2.5's decision table). It decides nothing about the
 * ladder, the supplier, the ids or the settlement — those are the same code for
 * everybody, which is the whole point of there being one entry point.
 */
export const IssuanceEntry = {
  /**
   * The payment event path: a webhook's own continuation, order creation, the
   * shopper's status poll, or the admin sweep. May only claim a `paid` order.
   */
  Automatic: "automatic",

  /**
   * **The operator's retry** — one person pressing a button on
   * `/admin/recovery` (§2.5, §8), and the only other way into issuance there
   * is.
   *
   * It is an *entry*, not a path. It reaches this same service, the same claim
   * under the same row lock, the same ladder and the same settlement; **there
   * is no admin-only code path into issuance**, which is why §2.5's guarantees
   * are the guarantees Phase 2 and slice 3 already proved. All this member
   * changes is the row below it — which transitions the caller may claim with —
   * because an operator pushes orders the automatic path has *finished* with
   * (`out_of_stock`, `delivery_failed`) or has *abandoned* mid-flight
   * (`delivering`, §2.3), and `beginIssuance` matches none of those.
   */
  Operator: "operator",
} as const;

export type IssuanceEntry = (typeof IssuanceEntry)[keyof typeof IssuanceEntry];

/**
 * §2.5's entry decision table, as data.
 *
 * | Observed under the lock | Transition | `$3` | Outcome |
 * | --- | --- | --- | --- |
 * | `paid` | `beginIssuance` | `{paid}` | ladder from `askFirst` |
 * | `out_of_stock` / `delivery_failed` | `retryIssuance` | `{out_of_stock,delivery_failed}` | ladder recomputes |
 * | `delivering` | `resumeIssuance` | `{delivering}` | ladder probes the outstanding id |
 * | `delivered` / `created` / `payment_failed` | none | — | refused, `409` |
 *
 * All four rows exist now. The first is {@link IssuanceEntry.Automatic}'s, the
 * middle two are {@link IssuanceEntry.Operator}'s, and the fourth is not a row
 * of code at all: an order in one of those three statuses matches neither
 * operator transition, both guarded UPDATEs return zero rows, and the endpoint
 * turns that into `409`.
 *
 * **Named here, never decided by an `if` on the row the lock returned.** §2.5's
 * last criterion is that the refusals are *"decided by zero rows from a guarded
 * UPDATE"*. A `switch (locked.status)` would decide the same thing one statement
 * earlier, from a value that is true at read time rather than at write time,
 * which is the check-then-act `architecture.md` §3's governing principle exists
 * to forbid. So the entry names a transition and the transition's own `from`
 * list does the refusing.
 *
 * The value is an **ordered list, tried until one returns a row**, which is how
 * the operator reaches `retryIssuance` for a settled order and `resumeIssuance`
 * for a stranded one *without anybody reading a status first*. The two lists are
 * disjoint in their `from` sets (`../orders/order-transitions.ts`), so at most
 * one of them can ever match and the order they are tried in changes nothing
 * about which one wins — only how many statements are spent finding out.
 *
 * `satisfies Record<IssuanceEntry, …>` keeps the table total: adding an entry
 * without saying what it may claim with stops the build.
 */
const entryTransitions = {
  [IssuanceEntry.Automatic]: ["beginIssuance"],
  [IssuanceEntry.Operator]: ["retryIssuance", "resumeIssuance"],
} as const satisfies Record<IssuanceEntry, readonly OrderTransitionName[]>;

/**
 * Whether this entry's **opening** rung may start a new round of asking
 * (`./issuance-ladder.ts`, {@link IssuanceRound}).
 *
 * The one fact the attempt rows cannot carry, so the entry point carries it —
 * and it is a table beside the transitions rather than a `?:` at the call site,
 * for the same reason: adding an entry without saying what it means stops the
 * build.
 *
 * `Automatic` is `Continuing` and must stay that way. Its claim requires `paid`,
 * so an order it can claim has no attempt rows at all and the branch this feeds
 * is unreachable from it — but if that ever changed, a payment event that opened
 * a fresh round on a settled order would re-ask both suppliers every time it was
 * redelivered.
 *
 * **Only the opening turn gets it.** Every recomputation inside the walk
 * ({@link IssuanceRunnerService.ladderTurnWithin}) takes the ladder's default,
 * which is how one retry asks one more round and not an unbounded number of
 * them.
 */
const entryRounds = {
  [IssuanceEntry.Automatic]: IssuanceRound.Continuing,
  [IssuanceEntry.Operator]: IssuanceRound.Fresh,
} as const satisfies Record<IssuanceEntry, IssuanceRound>;

/**
 * How the issuance ended — the four ways an order can leave the ladder.
 *
 * The split that matters to the caller is not "did it work?" — it is **"has the
 * order stopped moving?"**, because that is what decides whether the payment
 * event settles. The first three have; the fourth has not.
 *
 * `DeliveryFailed` is the member slice 2 adds, and it closes a real gap rather
 * than filling in a table. Until now `transitionForReason` had two arms while
 * the reporting had one, so a `supplier_rejected` refusal moved the order to
 * `delivery_failed` correctly and was then reported as `Unresolved` — leaving
 * the payment event pending for an order that had finished moving. Conservative
 * rather than wrong, and now simply right.
 */
export const IssuanceOutcome = {
  /** A code is bound in `deliveries` and the order is `delivered`. Terminal. */
  Delivered: "delivered",

  /**
   * **Every** supplier in the ladder answered, and every one of them said the
   * shelf is empty. The order is `out_of_stock`: settled, and recoverable by an
   * operator retry after a restock. No delivery row exists.
   */
  OutOfStock: "out_of_stock",

  /**
   * Every supplier definitely refused and at least one of them refused for a
   * reason that is **not** an empty pool. The order is `delivery_failed`:
   * settled, recoverable, and — the point of it being a separate status — it
   * reads differently to the shopper than "wait, stock is coming" does
   * (functional spec 003 §2.3).
   */
  DeliveryFailed: "delivery_failed",

  /**
   * **The shop asked the same question as often as its budget allows and never
   * got an answer.** The order is `delivery_failed`: settled, recoverable, and
   * reported as a *delivery* failure to the shopper — but the attempt row still
   * says `unknown` with `last_error` NULL, because on the supplier's side
   * nothing failed and nobody knows whether a key was issued.
   *
   * A separate member from {@link IssuanceOutcome.DeliveryFailed} for exactly
   * that reason. Both land the order in the same status, and collapsing them
   * would report *"we never found out"* as *"every supplier refused"* on the one
   * screen and the one log line where a person reads that record — the
   * one-character mistake §9.3 names (`reason ?? "failed"`), made at the layer
   * above instead.
   */
  NeverEstablished: "never_established",

  /**
   * **No finishing status was reached.** In practice: the order stopped being
   * this worker's to move part-way through the ladder — somebody else finished
   * it, or a guarded write matched zero rows — so it rests where it is and the
   * caller must leave the payment event pending.
   *
   * Silence from a supplier no longer arrives here: it is probed, and then
   * settled as {@link IssuanceOutcome.NeverEstablished}. What remains are the
   * genuinely unfinished cases, which is what the payment event's queue entry is
   * for.
   */
  Unresolved: "unresolved",
} as const;

export type IssuanceOutcome = (typeof IssuanceOutcome)[keyof typeof IssuanceOutcome];

/**
 * The result of walking one order's ladder to a resting state.
 *
 * A discriminated union, so `result.code` does not type-check until the caller
 * has narrowed to {@link IssuanceOutcome.Delivered}. `requestId` is on every
 * branch because it is the correlation id for this whole path and the caller
 * logs it whatever happened.
 */
export type IssuanceResult =
  | {
      readonly outcome: typeof IssuanceOutcome.Delivered;
      readonly requestId: string;
      /**
       * Which supplier issued it. Taken off the rung that asked rather than
       * parsed back out of `requestId` — the id is *derived* from the provider
       * and the attempt and is never read in the other direction
       * (`./issuance-request-id.ts`).
       */
      readonly provider: string;
      /** The key now bound to this order in `deliveries`. */
      readonly code: string;
    }
  | {
      readonly outcome: typeof IssuanceOutcome.OutOfStock | typeof IssuanceOutcome.DeliveryFailed;
      readonly requestId: string;
      /**
       * Every definite refusal on file, oldest first — the whole reason the
       * order settled where it did. A single reason would hide a mix, and a mix
       * is exactly what routes an order to `delivery_failed` rather than to
       * `out_of_stock` (§2.4).
       */
      readonly refusals: readonly IssuanceRefusal[];
    }
  | {
      readonly outcome: typeof IssuanceOutcome.NeverEstablished;
      /**
       * The id nobody knows the answer to. **The most important field in this
       * union**: it is the only thing that can still find out, by being asked
       * again, and §8 surfaces it to the operator as `outstanding_request_id`.
       */
      readonly requestId: string;
      /** Which supplier is holding the unanswered question. */
      readonly provider: string;
      /** How many times it was asked — `SUPPLIER_MAX_PROBES_PER_REQUEST` on the ordinary path. */
      readonly probeCount: number;
    }
  | {
      readonly outcome: typeof IssuanceOutcome.Unresolved;
      readonly requestId: string;
      /** Why nothing was concluded. For the log line; never branched on. */
      readonly detail: string;
    };

/** Whether the runner got as far as owning the order at all. */
export const IssuanceRunOutcome = {
  /** **This call claimed the order** and walked the ladder. See `result`. */
  Ran: "ran",

  /**
   * The guarded claim matched zero rows: somebody else owns this order, or it
   * has already stopped moving. This call did nothing and can never win the
   * claim now. Slice 5's `409` is this outcome.
   */
  NotClaimable: "not_claimable",

  /**
   * No order with that id. Distinct from {@link IssuanceRunOutcome.NotClaimable}
   * on purpose: `payment_events.order_id` carries no foreign key, so an event
   * can legitimately name an order that does not exist *yet*, and that caller
   * must leave its event pending rather than settle it.
   */
  OrderNotFound: "order_not_found",
} as const;

export type IssuanceRunOutcome = (typeof IssuanceRunOutcome)[keyof typeof IssuanceRunOutcome];

export type IssuanceRunResult =
  | {
      readonly outcome: typeof IssuanceRunOutcome.Ran;
      readonly entry: IssuanceEntry;
      /** The order row as the winning claim returned it — proof this call owns it. */
      readonly claimed: Order;
      /** What the order read the instant the claim's lock was granted. Advisory. */
      readonly lockedStatus: OrderStatus | undefined;
      readonly result: IssuanceResult;
    }
  | {
      readonly outcome: typeof IssuanceRunOutcome.NotClaimable;
      readonly entry: IssuanceEntry;
      /** The row as the follow-up read saw it, inside the claim's transaction. Advisory. */
      readonly observed: Order;
      readonly lockedStatus: OrderStatus | undefined;
    }
  | {
      readonly outcome: typeof IssuanceRunOutcome.OrderNotFound;
      readonly entry: IssuanceEntry;
      readonly orderId: string;
    };

/** What the transaction did about the rung it computed. At most one is set. */
interface ActedOnStep {
  /** Set when the rung reserves a **new** attempt row: did the guarded insert match? */
  readonly reserved: ReserveAttemptResult | undefined;
  /**
   * Set when the rung is a `probe`: the attempt row's `probe_count` after the
   * increment. Advisory — it is logged, never branched on, because the decision
   * it would feed was already taken by the ladder from the value *before* this
   * write.
   */
  readonly probed: number | undefined;
  /** Set when the rung settles the order: did the guarded UPDATE match? */
  readonly settled: OrderTransitionResult | undefined;
}

/** One pass through a ladder transaction: the rung it computed and what it did about it. */
interface LadderTurn extends ActedOnStep {
  readonly step: IssuanceStep;
  readonly lockedStatus: OrderStatus | undefined;
}

/** Transaction A's turn, which also carries the claim it attempted. */
interface OpeningTurn extends LadderTurn {
  readonly claim: OrderTransitionResult;
  /**
   * Which transition of the entry's list actually matched a row, or `undefined`
   * when none did. For the log line only — the load-bearing fact is `claim`.
   */
  readonly claimedWith: OrderTransitionName | undefined;
}

/** Exhaustiveness guard: the compiler routes here only if a case went unhandled. */
function assertNever(value: never): never {
  throw new Error(`issuance runner: unhandled value ${JSON.stringify(value)}`);
}

/**
 * §2.4's two settled statuses, from the transition the ladder chose.
 *
 * A table rather than a string comparison, with `assertNever` underneath: slice
 * 5's transitions and any later settled status have to be classified here rather
 * than defaulting to one of these two.
 */
function outcomeForSettleTransition(
  transition: SettleRefusedTransition,
): typeof IssuanceOutcome.OutOfStock | typeof IssuanceOutcome.DeliveryFailed {
  switch (transition) {
    case "markOutOfStock":
      return IssuanceOutcome.OutOfStock;

    case "markDeliveryFailed":
      return IssuanceOutcome.DeliveryFailed;

    default:
      return assertNever(transition);
  }
}

@Injectable()
export class IssuanceRunnerService {
  private readonly logger = new Logger(IssuanceRunnerService.name);

  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(SUPPLIER_PROBE_BUDGET_CONFIG) private readonly budget: SupplierProbeBudgetConfig,
    private readonly history: IssuanceHistory,
    private readonly issuance: IssuanceService,
    private readonly transitions: OrderTransitionService,
    private readonly orderLock: OrderLockService,
  ) {
    // ####################################################################
    // # THE INVOCATION BUDGET — R5, AND THE ONE LIMIT NOTHING CAN ENFORCE.
    // ####################################################################
    //
    //     SUPPLIER_MAX_PROBES_PER_REQUEST × SUPPLIER_TIMEOUT_MS × |supplierLadder|
    //         +  overhead   <   function execution ceiling
    //
    // With the defaults that is 3 × 2000 × 2 = 12 s, which **exceeds Vercel's
    // Hobby ceiling**. This constructor cannot refuse to boot over it and must
    // not try: the ceiling is the platform's, it is not in the environment, and
    // a number hardcoded here to check against would be a guess that fails a
    // boot over a limit that no longer applies (`../config/supplier-config.ts`
    // makes the same argument for `SUPPLIER_TIMEOUT_MS`).
    //
    // So the number is *logged* instead, with every factor beside it, because
    // the failure it predicts is the one that leaves no trace: the function is
    // killed mid-ladder with no exception and no log line, and the only sign is
    // an order resting in `delivering` that looks exactly like a slow supplier.
    // Whoever sizes a deployment reads this line, lowers `SUPPLIER_TIMEOUT_MS`
    // or the probe count, and reads it again.
    //
    // Survivable by construction when the ceiling wins anyway: attempts say
    // `unknown`, the order sits in `delivering`, the payment event stays
    // pending, and the order appears in the recovery list.
    const worstCaseMs =
      this.budget.maxProbesPerRequest * this.budget.timeoutMs * supplierLadder.length;

    this.logger.log({
      msg: "issuance budget: worst-case supplier time for one ladder walk, excluding overhead",
      worst_case_ms: worstCaseMs,
      max_probes_per_request: this.budget.maxProbesPerRequest,
      timeout_ms: this.budget.timeoutMs,
      providers: supplierLadder.length,
      formula: "SUPPLIER_MAX_PROBES_PER_REQUEST × SUPPLIER_TIMEOUT_MS × |supplierLadder|",
      caveat:
        "must stay under the platform's function execution ceiling, which nothing in this " +
        "process can read or enforce (spec 003 R5)",
    });
  }

  /**
   * Claim one order and walk its ladder to a resting state.
   *
   * Takes an **id**, not a row, and that is the difference between this and the
   * service it replaced. Phase 2's `issueForClaimedOrder(order)` took the row
   * the caller's own claim had returned, which made "you must have claimed it"
   * a rule the caller kept. Now the claim happens *here*, in the same
   * transaction as the ledger read, because §6's transaction A is one unit:
   * lock, read the ladder's inputs, claim. Split across two callers there is a
   * window between the read and the claim, and a window is all the race needs.
   *
   * Never throws for anything a supplier does. Only a genuine defect on our side
   * propagates, and it propagates with every attempt row already saying
   * `unknown`.
   */
  async runForOrder(orderId: string, entry: IssuanceEntry): Promise<IssuanceRunResult> {
    const claimWith = entryTransitions[entry];

    // TRANSACTION A. Four statements, no network I/O and no branch that waits on
    // anything, so the queue behind the lock waits microseconds rather than a
    // supplier timeout.
    const opening = await this.claimAndOpenLadder(orderId, claimWith, entryRounds[entry]);
    const claim = opening.claim;

    if (claim.outcome === OrderTransitionOutcome.OrderNotFound) {
      this.logger.log({
        msg: "issuance runner: no such order; nothing claimed and nothing locked",
        order_id: orderId,
        entry,
      });

      return { outcome: IssuanceRunOutcome.OrderNotFound, entry, orderId };
    }

    if (claim.outcome === OrderTransitionOutcome.NotInSourceState) {
      // ZERO ROWS IS A NO-OP, NOT AN ERROR — and on the automatic path it is the
      // common case, not the exception: every concurrent copy of a payment for
      // this order but one arrives here.
      this.logger.log({
        msg: "issuance runner: the guarded claim matched zero rows; this call does not own the order",
        order_id: orderId,
        entry,
        // The whole list, because none of them matched: on the operator path
        // this line is the `409`'s only explanation, and "retryIssuance matched
        // zero rows" would leave a reader wondering whether `resumeIssuance` was
        // ever tried.
        transitions: [...claimWith],
        locked_status: opening.lockedStatus,
        observed_status: claim.observed.status,
      });

      return {
        outcome: IssuanceRunOutcome.NotClaimable,
        entry,
        observed: claim.observed,
        lockedStatus: opening.lockedStatus,
      };
    }

    const order = claim.order;

    this.logger.log({
      msg: "issuance runner: claimed the order under the order row lock; walking the ladder",
      order_id: order.id,
      entry,
      transition: opening.claimedWith,
      // What this worker saw the instant it got the lock, before its own UPDATE.
      // `paid` on the winner's line; `delivering` or `delivered` on a loser's,
      // which is the whole story of the race in one field.
      locked_status: opening.lockedStatus,
      status: order.status,
      first_rung: opening.step.rung,
      // `architecture.md` §8: order_id, event_id and request_id on every line in
      // this path. The id is present whenever the first rung asks a supplier,
      // which is the only case where one exists yet — the ladder derives it, it
      // is never read back.
      request_id: isAskStep(opening.step) ? opening.step.requestId : undefined,
      reserved: opening.reserved?.outcome,
    });

    return {
      outcome: IssuanceRunOutcome.Ran,
      entry,
      claimed: order,
      lockedStatus: opening.lockedStatus,
      result: await this.walk(order, opening),
    };
  }

  /**
   * Walk the ladder from the rung transaction A computed, one supplier call per
   * pass, until a rung rests or settles.
   *
   * **Bounded by construction, with the bound written as the loop's own
   * condition rather than as a counter checked inside it.** Every pass either
   * returns, or strictly spends something that cannot be replenished:
   *
   *   - a **definite refusal** reduces the number of untried suppliers, so
   *     `fallThrough` runs out after `|supplierLadder|` of them and the pass
   *     after that is `settleRefused`;
   *   - a **silence** increments `probe_count` on the row it just asked, so
   *     `probe` runs out after `SUPPLIER_MAX_PROBES_PER_REQUEST` asks of that id
   *     and the pass after that is `settleNeverEstablished`.
   *
   * The two multiply, which is why {@link
   * IssuanceRunnerService.maxSupplierCallsPerWalk} is a product and not a sum —
   * and why it is the same product the budget logged at boot is built from. A
   * loop that could exceed it would exceed the function's execution ceiling with
   * no exception and no log line (R5).
   *
   * **Both spends are committed before the next pass reads them**, in the
   * transaction that computed the rung. A pass that recomputed from its own
   * in-memory idea of the ledger could probe for ever; each pass re-reads the
   * rows under the lock instead.
   */
  private async walk(order: Order, opening: LadderTurn): Promise<IssuanceResult> {
    let turn = opening;

    for (let rung = 0; rung <= this.maxSupplierCallsPerWalk(); rung += 1) {
      const step = turn.step;

      switch (step.rung) {
        case IssuanceRung.AskFirst:
        case IssuanceRung.Probe:
        case IssuanceRung.FallThrough: {
          // The attempt row could not be reserved because the order is no longer
          // `delivering` — somebody else finished it while this worker was
          // talking to the previous supplier. Stop: asking another supplier now
          // would obtain a second key for an order that has stopped moving.
          if (turn.reserved?.outcome === ReserveAttemptOutcome.OrderNotDelivering) {
            this.logger.warn({
              msg: "issuance runner: the order left delivering before this rung could be reserved; stopping",
              order_id: order.id,
              request_id: step.requestId,
              provider: step.provider,
              attempt: step.attempt,
              rung: step.rung,
              observed_status: turn.reserved.observedStatus,
            });

            return {
              outcome: IssuanceOutcome.Unresolved,
              requestId: step.requestId,
              detail: `the order left delivering (${String(turn.reserved.observedStatus)}) before ${step.rung} could be reserved`,
            };
          }

          // ############################################################
          // # THE SUPPLIER CALL. NO TRANSACTION IS OPEN, NO LOCK IS HELD.
          // ############################################################
          const ask = await this.issuance.askSupplier(order, step);

          switch (ask.outcome) {
            case SupplierAskOutcome.Issued:
              if (ask.finished !== OrderStatus.Delivered) {
                // A key is bound but the finishing transition matched zero rows.
                // Reported rather than claimed as a delivery: the payment event
                // stays pending, which is the outcome that can still be
                // recovered from.
                return {
                  outcome: IssuanceOutcome.Unresolved,
                  requestId: ask.requestId,
                  detail: `a key is bound to ${order.id} but the order did not reach delivered`,
                };
              }

              return {
                outcome: IssuanceOutcome.Delivered,
                requestId: ask.requestId,
                provider: step.provider,
                code: ask.code,
              };

            case SupplierAskOutcome.NoAnswer:
              // ########################################################
              // # THE HARD RULE. THIS IS WHERE A FALL-THROUGH DOES NOT HAPPEN.
              // ########################################################
              //
              // The outcome was never established, so a key may already exist
              // for `ask.requestId`. The next rung is recomputed from the
              // ledger, and the only two it can be are `probe` — THIS supplier,
              // THIS id, again — and `settleNeverEstablished`. Nothing here may
              // ask a different supplier, and nothing here needs to remember
              // which id to re-ask: it is derived from the row.
              //
              // **Nothing is written to `issuance_attempts` on the way through**
              // (see {@link IssuanceRunnerService.recordSilenceAndAdvance}),
              // which is the difference between this branch and the refusal
              // branch below it. The row already says `unknown` with
              // `last_error` NULL and that is still exactly true.
              turn = await this.recordSilenceAndAdvance(order, ask.requestId, ask.detail);
              continue;

            case SupplierAskOutcome.Refused:
              // TRANSACTION A′. Record the refusal and recompute the rung from
              // the ledger, under the lock, in one unit.
              turn = await this.recordRefusalAndAdvance(order, ask.requestId, ask.reason);
              continue;

            default:
              return assertNever(ask);
          }
        }

        case IssuanceRung.SettleRefused:
          return this.reportSettled(order, step, turn.settled);

        case IssuanceRung.SettleNeverEstablished:
          return this.reportNeverEstablished(order, step, turn.settled);

        case IssuanceRung.Rest:
          return this.reportRest(order, step);

        default:
          return assertNever(step);
      }
    }

    // Unreachable while the loop bound above holds. Reported rather than thrown:
    // an order that has run out of rungs has not necessarily gone wrong, and a
    // `500` on a webhook asks a payment provider to redeliver.
    this.logger.error({
      msg: "issuance runner: the ladder did not reach a resting state within its bound",
      order_id: order.id,
      rungs: this.maxSupplierCallsPerWalk() + 1,
    });

    return {
      outcome: IssuanceOutcome.Unresolved,
      requestId: isAskStep(turn.step) ? turn.step.requestId : order.id,
      detail: "the ladder did not reach a resting state",
    };
  }

  /**
   * `settleRefused` — **every supplier in the ladder definitely refused**, the
   * order has been moved by the same transaction that computed the rung, and no
   * delivery row exists or ever will for these attempts.
   *
   * Which of the two settled statuses it reached was decided by §2.4's table in
   * `./issuance-ladder.ts` and applied as a guarded UPDATE; this method only
   * reports it.
   */
  private reportSettled(
    order: Order,
    step: SettleRefusedStep,
    settled: OrderTransitionResult | undefined,
  ): IssuanceResult {
    if (settled?.outcome !== OrderTransitionOutcome.Transitioned) {
      // The guarded settle matched zero rows. It cannot happen while this
      // worker holds the claim and the lock, so reaching it means the order was
      // not `delivering` when the rung was acted on. Reported, never assumed
      // away — and the event stays pending, which keeps the order findable.
      this.logger.error({
        msg: "issuance runner: every supplier refused but the settling transition matched zero rows",
        order_id: order.id,
        request_id: step.lastRequestId,
        transition: step.transition,
        refusals: step.refusals,
        observed_status:
          settled?.outcome === OrderTransitionOutcome.NotInSourceState
            ? settled.observed.status
            : undefined,
      });

      return {
        outcome: IssuanceOutcome.Unresolved,
        requestId: step.lastRequestId,
        detail: `every supplier refused but ${step.transition} matched zero rows`,
      };
    }

    this.logger.warn({
      msg: "issuance runner: every supplier definitely refused; the order is settled with no key bound",
      order_id: order.id,
      request_id: step.lastRequestId,
      transition: step.transition,
      status: settled.order.status,
      refusals: step.refusals,
    });

    return {
      outcome: outcomeForSettleTransition(step.transition),
      requestId: step.lastRequestId,
      refusals: step.refusals,
    };
  }

  /**
   * `settleNeverEstablished` — **the budget is spent, nobody answered, and the
   * shop stops asking.**
   *
   * The order was moved to `delivery_failed` by the same transaction that
   * computed the rung, and **no write was made to `issuance_attempts`**. That
   * omission is the phase's whole subject, so it is worth saying plainly where
   * the code is: the row says `unknown` with `last_error` NULL and
   * `probe_count` at its ceiling, and that *is* the record functional spec
   * §2.2's fourth criterion asks for. Writing `failed` there would be a claim
   * nobody can support — and a licence for a later fall-through to ask a second
   * supplier for a second key.
   *
   * `error`, not `warn`, and a level above {@link
   * IssuanceRunnerService.reportSettled}'s: every supplier refusing is the
   * system working, while a request whose outcome nobody knows is a key that may
   * have left the pool with no delivery against it — the one condition that
   * breaks stock accounting and the one the recovery list exists to surface.
   */
  private reportNeverEstablished(
    order: Order,
    step: SettleNeverEstablishedStep,
    settled: OrderTransitionResult | undefined,
  ): IssuanceResult {
    if (settled?.outcome !== OrderTransitionOutcome.Transitioned) {
      // The guarded settle matched zero rows: the order was not `delivering`
      // when the rung was acted on, so somebody else has moved it. Reported, and
      // the event stays pending — which keeps the order findable, exactly as it
      // would be if this worker had never run.
      this.logger.error({
        msg: "issuance runner: the outcome was never established but the settling transition matched zero rows",
        order_id: order.id,
        request_id: step.outstandingRequestId,
        provider: step.provider,
        attempt: step.attempt,
        probe_count: step.probeCount,
        transition: step.transition,
        observed_status:
          settled?.outcome === OrderTransitionOutcome.NotInSourceState
            ? settled.observed.status
            : undefined,
      });

      return {
        outcome: IssuanceOutcome.Unresolved,
        requestId: step.outstandingRequestId,
        detail: `the outcome of ${step.outstandingRequestId} was never established but ${step.transition} matched zero rows`,
      };
    }

    this.logger.error({
      msg:
        "issuance runner: the outcome was never established after every probe; the order is delivery_failed " +
        "and the attempt row is left saying unknown, which is the record",
      order_id: order.id,
      request_id: step.outstandingRequestId,
      provider: step.provider,
      attempt: step.attempt,
      probe_count: step.probeCount,
      max_probes_per_request: this.budget.maxProbesPerRequest,
      transition: step.transition,
      status: settled.order.status,
      // Spelled out because this is the line somebody reads at 3am and the
      // wrong reading of it — "the supplier failed" — is the bug this phase
      // exists to prevent.
      detail:
        "a key MAY exist for this request_id; only another call with the same id can say, " +
        "and an operator retry makes exactly that call",
    });

    return {
      outcome: IssuanceOutcome.NeverEstablished,
      requestId: step.outstandingRequestId,
      provider: step.provider,
      probeCount: step.probeCount,
    };
  }

  /**
   * `rest` — **the ladder has nothing to offer and the order stays exactly where
   * it is.** Nothing is written, which is the point.
   *
   * One case reaches here now that `probe` and `settleNeverEstablished` exist: a
   * code is already bound for this order and the finishing status did not commit
   * with it. Asking any supplier again would be asking for a second key for an
   * order that has one.
   *
   * Logged at `error` level: a paid order that holds a code and does not read
   * `delivered` is the exact condition the recovery list exists to surface.
   */
  private reportRest(order: Order, step: RestStep): IssuanceResult {
    this.logger.error({
      msg: "issuance runner: a code already exists for this order; there is nothing to ask for",
      order_id: order.id,
      rest_reason: step.reason,
      status: OrderStatus.Delivering,
    });

    return {
      outcome: IssuanceOutcome.Unresolved,
      requestId: order.id,
      detail: step.reason,
    };
  }

  /**
   * **Transaction A** — §6, and the one place a rung is computed for an order
   * nobody has claimed yet.
   *
   *     BEGIN;
   *       (1) SELECT … FROM "orders" WHERE "id" = $1 FOR UPDATE
   *       (2) SELECT … FROM "issuance_attempts" WHERE "order_id" = $1
   *           ORDER BY "attempt" DESC
   *       (3) UPDATE "orders" SET "status" = $1, "updated_at" = now()
   *           WHERE ("id" = $2 AND "status" = ANY($3)) RETURNING …
   *       (4) INSERT INTO "issuance_attempts" … SELECT … FROM "orders"
   *           WHERE ("id" = $6 AND "status" = 'delivering')
   *           ON CONFLICT ("request_id") DO NOTHING RETURNING …
   *     COMMIT;
   *
   * The statements are emitted by, in order,
   * {@link OrderLockService.lockOrder}, {@link IssuanceHistory.readWithin},
   * {@link OrderTransitionService.transitionWithin} and
   * {@link IssuanceHistory.reserveWithin}; each is annotated at the method that
   * emits it, so this comment names them rather than restating them.
   *
   * **(1) is first, always.** It is the serialisation point, and (2) is the
   * read-then-act that needs it. **(4) runs only if (3) returned a row** — a
   * worker holding zero rows owns nothing and must not reserve an attempt, let
   * alone ask a supplier.
   *
   * `transitionWithin`, never `transition`: the latter asks the pool for a
   * connection of its own, and with `max: 1` the one it would wait for is the
   * one this transaction is holding — a self-deadlock that ends at
   * `CONNECTION_TIMEOUT_MS` with an error that looks nothing like its cause.
   */
  private async claimAndOpenLadder(
    orderId: string,
    claimWith: readonly OrderTransitionName[],
    round: IssuanceRound,
  ): Promise<OpeningTurn> {
    return this.database.transaction(async (tx) => {
      // (1) THE LOCK.
      const locked = await this.orderLock.lockOrder(tx, orderId);

      // (2) THE LADDER'S INPUT — read inside the lock. See this file's header.
      const attempts = await this.history.readWithin(tx, orderId);
      // The one place a fresh round can be opened. Read *before* the claim, so
      // the rows it sees are the ones the order settled with — and the round is
      // the caller's entry, never a status anybody read (see `entryRounds`).
      const step = nextIssuanceStep(orderId, attempts, this.budget.maxProbesPerRequest, round);

      // (3) THE CLAIM. Nothing above branched on the locked row; the statements
      // below are the decision, evaluated by Postgres against the row.
      const { claim, claimedWith } = await this.claimWithFirstMatching(tx, orderId, claimWith);

      if (claim.outcome !== OrderTransitionOutcome.Transitioned) {
        return {
          claim,
          claimedWith,
          step,
          lockedStatus: locked?.status,
          reserved: undefined,
          probed: undefined,
          settled: undefined,
        };
      }

      // (4)
      return {
        claim,
        claimedWith,
        step,
        lockedStatus: locked?.status,
        ...(await this.actOnStep(tx, orderId, step)),
      };
    });
  }

  /**
   * Statement (3) of transaction A, for an entry whose {@link entryTransitions}
   * row names more than one transition: **run them in order until one returns a
   * row, and stop.**
   *
   * ###########################################################################
   * # THIS IS THE ENTIRE DIFFERENCE BETWEEN THE OPERATOR AND THE AUTOMATIC
   * # PATH, AND IT IS STILL NOT AN `if` ON A STATUS ANYBODY READ.
   * ###########################################################################
   *
   * The obvious implementation is one statement shorter:
   *
   *     switch (locked.status) {                     // <-- DO NOT
   *       case "out_of_stock": ... "retryIssuance";
   *       case "delivering":   ... "resumeIssuance";
   *       default: return refused;
   *     }
   *
   * and it is the check-then-act this whole project argues against. The value it
   * branches on was true when the `SELECT` ran; the transition is written a
   * statement later. Under this lock the window is currently empty — which is
   * exactly what makes the mistake survive review and then survive the day the
   * lock moves.
   *
   * Here nothing reads a status to decide anything. Each candidate is a guarded
   * UPDATE whose own `WHERE … status = ANY($3)` is evaluated by Postgres against
   * the row as it stands at that instant, and the decision is which of them
   * returned a row. §2.5's refusals are *zero rows from every candidate*, and
   * the `409` upstairs is that and nothing else.
   *
   * The cost of the loop is one extra `SELECT` per non-matching candidate — the
   * follow-up read `OrderTransitionService` issues to tell
   * `not_in_source_state` from `order_not_found`. At most one extra on the
   * operator path, inside a transaction that holds the lock for microseconds,
   * and `order_not_found` short-circuits because every later candidate would ask
   * the same question of the same missing row.
   */
  private async claimWithFirstMatching(
    tx: Transaction,
    orderId: string,
    claimWith: readonly OrderTransitionName[],
  ): Promise<{ claim: OrderTransitionResult; claimedWith: OrderTransitionName | undefined }> {
    let claim: OrderTransitionResult | undefined;

    for (const transition of claimWith) {
      claim = await this.transitions.transitionWithin(tx, orderId, transition);

      if (claim.outcome === OrderTransitionOutcome.Transitioned) {
        return { claim, claimedWith: transition };
      }

      if (claim.outcome === OrderTransitionOutcome.OrderNotFound) break;
    }

    if (claim === undefined) {
      // Unreachable: `entryTransitions` is `as const` and every entry names at
      // least one transition. Thrown rather than papered over with a
      // `not_in_source_state` nobody wrote, because an empty list would mean an
      // entry that can never claim anything — every retry answering `409` with
      // no log line able to say why.
      throw new Error(`issuance runner: no transition was named to claim order ${orderId} with`);
    }

    return { claim, claimedWith: undefined };
  }

  /**
   * **Transaction A′** — §6, reached only after a **definite** refusal, with the
   * order already `delivering` and this worker holding the claim.
   *
   *     BEGIN;
   *       (1) SELECT … FROM "orders" WHERE "id" = $1 FOR UPDATE
   *       (2) UPDATE "issuance_attempts" SET "status" = 'failed', "last_error" = $2
   *           WHERE "request_id" = $3
   *       (3) SELECT … FROM "issuance_attempts" WHERE "order_id" = $1
   *           ORDER BY "attempt" DESC
   *       (4) reserve attempt n+1, or settle the order
   *     COMMIT;
   *
   * **The resolve and the recomputation are one unit, and that is the reason
   * this is a transaction rather than two statements.** The rung that follows a
   * refusal is a function of the ledger *including* that refusal. Committing the
   * `failed` write separately would leave a window in which the ledger says the
   * attempt failed and no worker owns the next rung — and a second worker
   * arriving in that window (slice 5's resume) would compute the same
   * `fallThrough` from the same rows and ask the same supplier a second time.
   *
   * There is **no order transition to guard with here**: the order is
   * `delivering` before this transaction and `delivering` after it, all the way
   * across the ladder walk. So the guard moves into the reservation's
   * `INSERT … SELECT`, whose `WHERE o."status" = 'delivering'` is what refuses
   * to reserve a rung for an order somebody else has finished
   * ({@link IssuanceHistory.reserveWithin}).
   */
  private async recordRefusalAndAdvance(
    order: Order,
    requestId: string,
    reason: string,
  ): Promise<LadderTurn> {
    const turn = await this.database.transaction(async (tx) => {
      // (1) THE LOCK, first — a definite refusal is still an outcome being
      // written, so it is serialised exactly like a success.
      const locked = await this.orderLock.lockOrder(tx, order.id);

      // (2) Resolve attempt n. `failed`, never `unknown`: the supplier answered.
      await this.history.resolveRefusedWithin(tx, requestId, reason);

      // (3) + (4) Re-read the ladder's input, now including the refusal just
      // written, and act on the rung it produces.
      return this.ladderTurnWithin(tx, order.id, locked?.status);
    });

    this.logger.log({
      msg: "issuance runner: recorded a definite refusal and recomputed the rung from the ledger",
      order_id: order.id,
      request_id: requestId,
      reason,
      next_rung: turn.step.rung,
      next_request_id: isAskStep(turn.step) ? turn.step.requestId : undefined,
      reserved: turn.reserved?.outcome,
      locked_status: turn.lockedStatus,
    });

    return turn;
  }

  /**
   * **Transaction A″ — the silence transaction, and the one that writes nothing
   * about the attempt.**
   *
   *     BEGIN;
   *       (1) SELECT … FROM "orders" WHERE "id" = $1 FOR UPDATE
   *       -- DELIBERATELY NO WRITE TO issuance_attempts. The row already says
   *       -- status = 'unknown' with last_error NULL, and it is still exactly
   *       -- true: we asked and we do not know. There is nothing to correct.
   *       (2) SELECT … FROM "issuance_attempts" WHERE "order_id" = $1
   *           ORDER BY "attempt" DESC
   *       (3) count one probe, or settle the order
   *     COMMIT;
   *
   * Compare it statement for statement with {@link
   * IssuanceRunnerService.recordRefusalAndAdvance}: the *only* difference is the
   * `UPDATE … SET status = 'failed'` that is missing here. That missing
   * statement is the phase in one line. A timeout is **unknown**, never
   * **failed**, and the difference is not a log level — it decides whether a
   * different supplier may be asked a different question while a key may already
   * be sitting in this one's ledger.
   *
   * Why a transaction at all, when nothing is written about the attempt: the
   * rung that follows must be computed from rows read **under the order row
   * lock** (R4, and `./issuance-history.ts`'s header). Two workers reading
   * different snapshots compute different rungs, and one of them can be a
   * fall-through. `probe`'s own increment is then written inside the same
   * transaction, so the count that bounds the loop is committed before the next
   * pass reads it.
   *
   * §6 describes the re-probe as *"a bare HTTP call with the same `request_id` —
   * no transaction at all"*, and that remains true of the **call**: this
   * transaction opens and commits before a byte reaches the supplier, exactly as
   * transaction A does.
   */
  private async recordSilenceAndAdvance(
    order: Order,
    requestId: string,
    detail: string,
  ): Promise<LadderTurn> {
    const turn = await this.database.transaction(async (tx) => {
      // (1) THE LOCK, first — this transaction takes a decision from a set of
      // rows, which is the one decision in this codebase Postgres cannot take
      // inside a guarded statement.
      const locked = await this.orderLock.lockOrder(tx, order.id);

      return this.ladderTurnWithin(tx, order.id, locked?.status);
    });

    this.logger.warn({
      msg: "issuance runner: no answer; the attempt row is left untouched and the rung recomputed from the ledger",
      order_id: order.id,
      request_id: requestId,
      detail,
      next_rung: turn.step.rung,
      // On a `probe` this is the SAME id as `request_id` above, and a reviewer
      // reading two identical values on one line is reading the mechanism.
      next_request_id: isAskStep(turn.step) ? turn.step.requestId : undefined,
      probe_count: turn.probed,
      max_probes_per_request: this.budget.maxProbesPerRequest,
      locked_status: turn.lockedStatus,
    });

    return turn;
  }

  /**
   * Read the ledger inside the caller's transaction, compute the rung, act on
   * it — the three steps both ladder transactions end with.
   *
   * Shared so that "the rung is computed from rows read under the lock and acted
   * on before the lock is released" is one piece of code rather than a property
   * two call sites happen to preserve. The caller has already taken the lock;
   * this function does not, which is why it takes `lockedStatus` as a value
   * rather than a handle to take one with.
   */
  private async ladderTurnWithin(
    tx: Transaction,
    orderId: string,
    lockedStatus: OrderStatus | undefined,
  ): Promise<LadderTurn> {
    const attempts = await this.history.readWithin(tx, orderId);
    const step = nextIssuanceStep(orderId, attempts, this.budget.maxProbesPerRequest);

    return { step, lockedStatus, ...(await this.actOnStep(tx, orderId, step)) };
  }

  /**
   * The ladder walk's loop bound: **every supplier, asked its full budget.**
   *
   *     |supplierLadder| × SUPPLIER_MAX_PROBES_PER_REQUEST
   *
   * A product, because the two spends are independent: each supplier can be
   * asked up to its probe budget before a definite refusal moves the walk on to
   * the next one. It is the same product the boot-time budget line reports, one
   * factor lighter — that one multiplies by `SUPPLIER_TIMEOUT_MS` to get a
   * duration, this one counts calls.
   *
   * Computed rather than stored so that a re-read of the configuration could
   * never leave the loop bound behind it, and so the two numbers cannot drift
   * apart in two fields.
   */
  private maxSupplierCallsPerWalk(): number {
    return supplierLadder.length * this.budget.maxProbesPerRequest;
  }

  /**
   * Do what the rung says, **inside the caller's transaction and under its
   * lock** — the only place in this file that acts on a computed rung.
   *
   * Both ladder transactions end here, which is what makes "the rung was
   * computed and acted on without releasing the lock" a property of the code
   * rather than of two call sites happening to agree. It is also why there is no
   * third caller: a rung computed anywhere else would have to be carried out of
   * a transaction to be used, and by then it is a snapshot rather than a
   * decision.
   *
   *   - **`probe`** increments `probe_count` and **nothing else** ({@link
   *     IssuanceHistory.countProbeWithin}). Tested for *before* `isAskStep`,
   *     because a probe and a first ask are the same kind of call and not the
   *     same kind of record: one counts an ask against a row that exists, the
   *     other creates the row. Sending a probe through `reserveWithin` would hit
   *     `ON CONFLICT DO NOTHING`, count nothing, and loop until the bound.
   *   - **An ask rung** (`askFirst`, `fallThrough`) reserves the attempt row
   *     before the call ({@link IssuanceHistory.reserveWithin}), guarded on the
   *     order still being `delivering`.
   *   - **`settleRefused`** moves the order with the transition §2.4 chose —
   *     `markOutOfStock` or `markDeliveryFailed`, both guarded on `delivering`.
   *   - **`settleNeverEstablished`** moves the order to `delivery_failed` and
   *     writes **nothing** to `issuance_attempts`. Deliberately: the row already
   *     says `unknown` with `last_error` NULL and `probe_count` at its ceiling,
   *     and that *is* the record §2.2's fourth criterion asks for. Writing
   *     `failed` there is the exact bug this phase exists to prevent, and there
   *     is nothing truthful to write instead.
   *   - **`rest`** writes nothing either — a code already exists for this order.
   */
  private async actOnStep(
    tx: Transaction,
    orderId: string,
    step: IssuanceStep,
  ): Promise<ActedOnStep> {
    if (step.rung === IssuanceRung.Probe) {
      return {
        reserved: undefined,
        probed: await this.history.countProbeWithin(tx, orderId, step),
        settled: undefined,
      };
    }

    if (isAskStep(step)) {
      return {
        reserved: await this.history.reserveWithin(tx, orderId, step),
        probed: undefined,
        settled: undefined,
      };
    }

    if (
      step.rung === IssuanceRung.SettleRefused ||
      step.rung === IssuanceRung.SettleNeverEstablished
    ) {
      return {
        reserved: undefined,
        probed: undefined,
        settled: await this.transitions.transitionWithin(tx, orderId, step.transition),
      };
    }

    return { reserved: undefined, probed: undefined, settled: undefined };
  }
}
