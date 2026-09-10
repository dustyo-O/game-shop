/**
 * The drain — **taking pending work out of the inbox without two workers taking
 * the same row** (`architecture.md` §4, "Work queue"; technical-considerations
 * §2.2, "The claim").
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * `PaymentEventsService` writes a row and stops. `PaymentEventProcessor` takes a
 * stored row and applies it. Neither of them *finds* work — and Phase 1 left
 * work to be found on purpose: an event whose order did not exist yet, and every
 * losing copy of a contested `paid` event, are both deliberately left with
 * `processed_at` NULL, because *"the record of 'not yet done' must outlive the
 * doing"* (`docs/walkthrough/slice-3-webhook-inbox.md` §4). This file is what
 * comes back for them.
 *
 * Three services, three jobs, and this one owns exactly one statement:
 *
 *   | Service                   | Owns                                          |
 *   | ------------------------- | --------------------------------------------- |
 *   | `PaymentEventsService`    | the INSERT into the inbox (I2)                |
 *   | `PaymentEventDrainService`| *this* — **claiming** a pending row            |
 *   | `PaymentEventProcessor`   | what the event means, and settling it         |
 *
 * The drain deliberately writes nothing to `payment_events`. It does not settle,
 * it does not touch `processed_at`, it does not decide what an event means.
 * Apply-then-settle and the `AND processed_at IS NULL` guard already live in
 * {@link PaymentEventProcessor} and stay there; a second settle here would be a
 * second place the ordering could be got wrong, and the wrong order is the only
 * one that can lose a payment result.
 *
 * ---------------------------------------------------------------------------
 * TWO SHAPES, ONE STATEMENT
 * ---------------------------------------------------------------------------
 * `architecture.md` §4 lists four processing triggers so that no single one is
 * load-bearing. Three of the four are this file, and they differ by one
 * predicate:
 *
 *   | Trigger                          | Call                         |
 *   | -------------------------------- | ---------------------------- |
 *   | drain on order creation          | {@link drainOrder}(orderId)  |
 *   | drain on the order status poll   | {@link drainOrder}(orderId)  |
 *   | admin sweep                      | {@link drainPending}()       |
 *
 * (The fourth, the webhook's own continuation, does not come through here: it
 * already holds the row it just inserted and hands it straight to the
 * processor.)
 *
 * Both methods run the same claim with the same locking clause; `drainOrder`
 * adds `AND order_id = $1`, which is exactly the column the partial index
 * `payment_events_unprocessed_order_idx (order_id) WHERE processed_at IS NULL`
 * is keyed on. Nothing else differs, which is the point — one claim to audit,
 * not two.
 *
 * ###########################################################################
 * # WHAT THE CLAIM TRANSACTION HOLDS, AND FOR HOW LONG. READ THIS BEFORE
 * # "TIDYING" THE TRANSACTION BOUNDARY OUTWARDS.
 * ###########################################################################
 *
 * The transaction opened by {@link claimNextPendingEvent} contains **one
 * statement** — the `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1` — and commits
 * immediately. It holds one row lock on one `payment_events` row, plus this
 * instance's only pooled connection, for the duration of that single SELECT.
 * It is committed *before* {@link PaymentEventProcessor.processStoredEvent} is
 * called, and therefore before any supplier HTTP call.
 *
 * The obvious alternative — hold the claim open across the processing, so the
 * row stays locked until the work is done — is forbidden here twice over, and
 * the second reason is not a policy but a hang:
 *
 *   1. **`max: 1`.** Drizzle checks the instance's single connection out for the
 *      whole of `transaction()` (`packages/db/src/client.ts`). `processStoredEvent`
 *      reaches issuance, which does `POST {SUPPLIER_A_URL}/issue` over real
 *      HTTP. A transaction held across that stalls *every other statement this
 *      instance wants to run* for up to `SUPPLIER_TIMEOUT_MS` — the symptom
 *      being unrelated requests timing out, which is the hardest failure in this
 *      codebase to trace back to its cause.
 *   2. **It would self-deadlock immediately.** `processStoredEvent` runs its
 *      transitions through `OrderTransitionService.transition`, which asks the
 *      *pool* for a connection. The only connection is the one the enclosing
 *      transaction is holding, so the first guarded UPDATE would wait
 *      `CONNECTION_TIMEOUT_MS` for a connection its own caller owns and then
 *      fail with a timeout that looks nothing like its cause. The processor is
 *      written against the pooled client on purpose; passing it a `tx` handle is
 *      not a small change, it is a different processor.
 *
 * ### So what does `SKIP LOCKED` actually buy, if the lock dies at COMMIT?
 *
 * It buys **dispatch exclusion**, and that is all it was ever asked for: two
 * drains that reach for the queue at the same instant never take the same row.
 * One takes the head of the queue, the other steps over it onto the next pending
 * row — it does not block, and it does not fail. That is what lets several
 * workers drain one inbox concurrently instead of serialising on its oldest
 * entry.
 *
 * What it does **not** buy is durable ownership of an event for the length of
 * the work. The lock is gone at COMMIT, so a second worker starting a moment
 * later can pick up an event whose processing is still in flight.
 *
 * **That is safe, and it is safe for the same reason the whole inbox design is.**
 * Nothing about correctness rests on the claim. Every write the processor makes
 * is adjudicated by Postgres against the row itself:
 *
 *   - `markPaid` / `beginIssuance` are status-guarded UPDATEs — the second
 *     worker matches zero rows and does nothing (I9, and I4's headline: *only
 *     one worker advances an order*).
 *   - `deliveries.order_id` is UNIQUE, so a second worker cannot bind a second
 *     key even if it got that far (I3).
 *   - the supplier's `request_id → code` ledger returns the original code rather
 *     than issuing another (I5).
 *   - the settle carries `AND processed_at IS NULL`, so a re-drained event
 *     cannot rewrite when it was *first* settled.
 *
 * A worker that re-picks an in-flight event therefore runs a handful of
 * statements that match nothing and returns a no-op. That is the cheap direction
 * of the trade — the same one the processor takes when it leaves N pending rows
 * for one order — and it is the direction that cannot lose a payment result. The
 * expensive direction, a claim that holds a lock across a network call, buys
 * tidier bookkeeping and stalls the instance.
 *
 * ---------------------------------------------------------------------------
 * A PASS DOES NOT RE-CLAIM WHAT IT HAS ALREADY LOOKED AT
 * ---------------------------------------------------------------------------
 * Re-running the bare claim in a loop does not terminate, and the reason is a
 * feature of the processor rather than a bug: a `paid` event whose order is
 * still in flight, and an event whose order does not exist yet, are both left
 * **pending on purpose**. `ORDER BY received_at` would hand back the same
 * unsettleable row on every iteration, so the loop would spin on the oldest one
 * and never reach the newer events behind it — which for the admin sweep means
 * one permanently-pending row hides the entire rest of the queue.
 *
 * So each claim after the first excludes the event ids this pass has already
 * been handed: `AND event_id <> ALL($n)`, one array parameter. Read it as loop
 * control and **never** as exclusion. It lives in this process, it is discarded
 * when the pass ends, and no guarantee depends on it: a row this pass stepped
 * over is picked up by the next trigger, which is the whole reason there are
 * four of them.
 *
 * ### Why not a `(received_at, event_id) > (…)` cursor, which is the obvious shape
 *
 * It was written that way first and it silently did not work, for a reason
 * worth recording because it is invisible in review and in a single-threaded
 * test. `received_at` is `timestamptz`, which Postgres stores to **microsecond**
 * precision; node-postgres parses it into a JavaScript `Date`, which holds
 * **milliseconds**. Binding that value back therefore compares the row against a
 * *truncated* copy of its own timestamp, and `received_at > $2` is true for the
 * very row the cursor came from:
 *
 *   select received_at,
 *          received_at > date_trunc('milliseconds', received_at) as still_after_its_own_cursor
 *   from payment_events order by received_at limit 1;
 *   --          received_at          | still_after_its_own_cursor
 *   -- 2026-09-07 20:15:02.660928+00 | t
 *
 * A pending row a pass could not settle was therefore handed back on every
 * iteration — measured, before the fix, as one drain claiming the same
 * `event_id` five times inside a single pass. The primary key does not round
 * trip through a lossy type, so the exclusion list compares the value the
 * database actually holds.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";

import { and, eq, isNull, sql } from "drizzle-orm";

import { paymentEvents, type DatabaseClient, type PaymentEvent } from "@game-shop/db";

import { DATABASE_CLIENT } from "../database/database.module.js";
import { PaymentEventProcessor } from "./payment-event-processor.service.js";

/**
 * How many events one pass will claim before handing control back.
 *
 * A bound on *this call*, not on the queue. A pass that reaches it returns
 * {@link DrainStopReason.PassLimitReached}, which is a caller's cue to run
 * another pass if it wants to — an admin sweep loops until it sees anything
 * else; a shopper's status poll does not, because nudging their own order
 * forward is not a reason to drain someone else's backlog inside their request.
 *
 * A hundred because the two bounded callers cannot exceed it in practice (an
 * order accumulates one pending row per payment event, and fifty is the
 * assignment's headline number) while the unbounded one still cannot turn a
 * single HTTP request into an open-ended job.
 */
const MAX_EVENTS_PER_PASS = 100;

/**
 * Why the pass ended. Named values rather than a boolean, matching every other
 * service in this module: the caller's `switch` reads as news and the compiler
 * has something to be exhaustive about.
 *
 * **None of them is an error**, including the last one — see
 * {@link DrainStopReason.ProcessingFailed}.
 */
export const DrainStopReason = {
  /**
   * The claim returned zero rows: **nothing pending, or every pending row is
   * held by another worker.** Both mean *not my work*, and neither is an error.
   * This is the ordinary way a pass ends.
   */
  QueueEmpty: "queue_empty",

  /**
   * {@link MAX_EVENTS_PER_PASS} events were claimed and there may be more. The
   * caller may run another pass; nothing has been lost either way, because
   * anything not reached is still in the queue with `processed_at` NULL.
   */
  PassLimitReached: "pass_limit_reached",

  /**
   * Applying a claimed event threw. The event is **still pending** — the throw
   * happened before or instead of the settle, never after it — so it is still
   * findable by the next trigger, and the pass stops rather than walking the
   * rest of the queue into the same failure.
   */
  ProcessingFailed: "processing_failed",
} as const;

export type DrainStopReason = (typeof DrainStopReason)[keyof typeof DrainStopReason];

export interface DrainResult {
  /** How many events this pass claimed and handed to the processor. */
  readonly claimed: number;
  /**
   * How many of those left the queue (`processed_at` now set). Always `<=`
   * {@link claimed}: an event whose order does not exist yet, or whose order is
   * still in flight, is claimed, considered, and deliberately left pending.
   */
  readonly settled: number;
  readonly stoppedBy: DrainStopReason;
}

@Injectable()
export class PaymentEventDrainService {
  private readonly logger = new Logger(PaymentEventDrainService.name);

  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    private readonly processor: PaymentEventProcessor,
  ) {}

  /**
   * Drain the pending events for **one order** — the trigger on order creation
   * and the one on the status poll (`architecture.md` §4, triggers 2 and 3).
   *
   *     const result = await this.drain.drainOrder(order.id);
   *     // result.claimed === 0 && result.stoppedBy === "queue_empty"
   *     //   => nothing was waiting for this order. The ordinary case, and not
   *     //      something the caller reports to anyone.
   *
   * This is the call that settles "the webhook arrived before its order": the
   * event has been sitting with `processed_at` NULL and no order to apply it to,
   * and the moment the order is committed this finds it through the partial
   * index on `(order_id)`.
   */
  async drainOrder(orderId: string): Promise<DrainResult> {
    return this.runPass(orderId);
  }

  /**
   * Drain **anything** pending — the admin sweep (`architecture.md` §4, trigger
   * 4), the backstop for whatever the other three missed.
   *
   *     let result = await this.drain.drainPending();
   *     while (result.stoppedBy === DrainStopReason.PassLimitReached) {
   *       result = await this.drain.drainPending();
   *     }
   *
   * The same statement as {@link drainOrder} with the `order_id` predicate
   * omitted, which is also the form `architecture.md` §3.1 writes under
   * "Draining the inbox".
   */
  async drainPending(): Promise<DrainResult> {
    return this.runPass(undefined);
  }

  /**
   * One pass: claim, process, remember what was claimed, repeat.
   *
   * ### Never call a drain from inside an open transaction
   *
   * The same trap as {@link OrderTransitionService.transition}, and here it is
   * worse because the pass opens several transactions of its own. The pool holds
   * one connection per instance; a caller that already has it would be waiting
   * for a connection it is itself holding — a self-deadlock that only ends at
   * `CONNECTION_TIMEOUT_MS`, with an error that names a timeout rather than its
   * cause. Order creation must therefore commit its order *first* and drain
   * afterwards, which is also the only order that makes sense: an event cannot
   * be applied to an order that is not visible to other connections yet.
   *
   * ### A failure stops the pass and is not rethrown
   *
   * A claim that throws propagates — the database is unreachable and the
   * caller's own work has failed too, so hiding it here would be a lie. A
   * *processing* failure is different: the event is still pending by
   * construction, the next trigger will re-claim it, and the callers of this
   * method are a shopper creating an order and a shopper polling their own
   * status. Turning one bad event in someone else's order into a `500` on their
   * request would be the drain damaging the path it exists to help. So it is
   * logged at `error` with both correlation ids and reported in the result, and
   * the pass stops — stopping *is* the back-off, and the retry is the next
   * trigger.
   */
  private async runPass(orderId: string | undefined): Promise<DrainResult> {
    // Loop control, not exclusion — see the header. Discarded when the pass ends.
    const alreadyClaimed: string[] = [];
    let settled = 0;

    while (alreadyClaimed.length < MAX_EVENTS_PER_PASS) {
      const event = await this.claimNextPendingEvent(orderId, alreadyClaimed);

      if (event === undefined) {
        // ##################################################################
        // # ZERO ROWS IS NOT AN ERROR, AND IT HAS TWO CAUSES WORTH NAMING.
        // ##################################################################
        //
        // Either nothing is pending, or every pending row is locked by another
        // worker's claim right now. `SKIP LOCKED` collapses the two on purpose:
        // both mean "not my work", the answer is the same in both cases — stop
        // — and distinguishing them would need a second query whose answer
        // could not be acted on anyway.
        return { claimed: alreadyClaimed.length, settled, stoppedBy: DrainStopReason.QueueEmpty };
      }

      alreadyClaimed.push(event.eventId);

      this.logger.log({
        msg: "payment event drain: claimed a pending event",
        event_id: event.eventId,
        order_id: event.orderId,
        status: event.status,
        received_at: event.receivedAt.toISOString(),
      });

      let wasSettled: boolean;

      try {
        // No transaction is open here, and that is the whole design — see the
        // header. This reaches the supplier over real HTTP for a `paid` event.
        ({ settled: wasSettled } = await this.processor.processStoredEvent(event));
      } catch (error: unknown) {
        this.logger.error({
          msg: "payment event drain: processing a claimed event failed; it stays pending for a later trigger",
          event_id: event.eventId,
          order_id: event.orderId,
          error: error instanceof Error ? error.message : String(error),
        });

        return { claimed: alreadyClaimed.length, settled, stoppedBy: DrainStopReason.ProcessingFailed };
      }

      if (wasSettled) settled += 1;
    }

    this.logger.log({
      msg: "payment event drain: pass limit reached; there may be more pending work",
      order_id: orderId,
      claimed: alreadyClaimed.length,
      settled,
    });

    return {
      claimed: alreadyClaimed.length,
      settled,
      stoppedBy: DrainStopReason.PassLimitReached,
    };
  }

  /**
   * **The claim** — `architecture.md` §3.1, "Draining the inbox", and
   * technical-considerations §2.2, "The claim".
   *
   * Emitted SQL (copied from the statement Postgres logged under
   * `log_statement = 'all'`; per the project's raw-SQL rule, `architecture.md`
   * §2, "Documentation convention"). The targeted form, mid-pass:
   *
   *   begin
   *   select "event_id", "order_id", "status", "amount_minor", "currency",
   *          "payload", "received_at", "processed_at"
   *   from "payment_events"
   *   where ("payment_events"."processed_at" is null
   *          and "payment_events"."order_id" = $1
   *          and "payment_events"."event_id" <> ALL($2))
   *   order by "payment_events"."received_at"
   *   limit $3 for update skip locked;
   *   commit
   *   -- 1 row  => THIS worker claimed that event. No other worker holding a
   *   --           claim at this instant can have been handed the same row.
   *   -- 0 rows => nothing pending, or every pending row is already held by
   *   --           another worker. Both mean "not my work"; NEITHER IS AN ERROR.
   *   --           The pass stops and returns `queue_empty`.
   *
   * The untargeted form is the same statement with the `order_id` predicate
   * omitted, and the first claim of a pass is the same again with the exclusion
   * predicate omitted — which leaves, for the admin sweep's opening claim,
   * letter for letter the statement §3.1 specifies.
   *
   * ### Reading the statement
   *
   *   - **`FOR UPDATE SKIP LOCKED`.** A row already locked by a concurrent claim
   *     is *stepped over*, not queued behind. Without `SKIP LOCKED` every drain
   *     would serialise on the oldest pending row and all but one would wake up
   *     to find it taken; with it, N workers take N different rows and none of
   *     them blocks (`postgres-best-practices`, `lock-skip-locked`).
   *   - **What the lock covers, and for how long.** Exactly this statement. The
   *     transaction commits on the next line, before the event is processed and
   *     therefore before the supplier is called. The header explains why holding
   *     it longer is both forbidden (`max: 1`) and impossible (the processor
   *     works through the pool, so it would deadlock against its own caller) —
   *     and why the guarantees that actually matter are the status guards and
   *     unique indexes the processor writes through, not this lock.
   *   - **`ORDER BY received_at`**, the queue's order and §3.1's, unchanged.
   *     Payment results are applied oldest first.
   *   - **`<> ALL($2)`, not `NOT IN ($2, $3, …)`.** One bind parameter whatever
   *     the length of the list, so the statement text — and therefore the plan —
   *     is the same on the second claim of a pass as on the fiftieth. The same
   *     reasoning as `= ANY($3)` in {@link OrderTransitionService}.
   *   - **`limit $3 for update skip locked`** is Drizzle's clause order, where
   *     §3.1 writes `FOR UPDATE SKIP LOCKED LIMIT 1`. Postgres accepts the
   *     locking clause on either side of `LIMIT` and the meaning is identical;
   *     `$3` is the bound `1`. Noted rather than smoothed over, because the
   *     point of the convention is that the comment matches what runs.
   *   - **`LIMIT 1`, not a batch.** A worker that claimed ten rows would hold
   *     ten locks while it processed the first, and the other nine would be
   *     invisible to every other worker for the whole of that time — turning
   *     `SKIP LOCKED`'s fan-out back into a queue. One row, one lock, released
   *     immediately.
   *
   * ### The index this is written for
   *
   * `payment_events_unprocessed_order_idx (order_id) WHERE processed_at IS NULL`
   * (`packages/db/src/schema/shop.ts`) — a partial index holding only
   * unprocessed rows, so it stays a handful of entries however many events the
   * table accumulates. The queue is literally the index. `EXPLAIN (ANALYZE)` on
   * the targeted claim, against a table seeded with pending rows:
   *
   *   Limit
   *     ->  LockRows
   *           ->  Sort
   *                 Sort Key: received_at
   *                 ->  Index Scan using payment_events_unprocessed_order_idx
   *                       on payment_events
   *                       Index Cond: (order_id = $1)
   *
   * `LockRows` under `Limit` is `FOR UPDATE SKIP LOCKED` taking exactly one row,
   * and it is fed by the partial index — the scan never looks at a settled
   * event. The `Sort` is `received_at` not being in the index; it sorts only the
   * pending rows for one order, which is the handful the index just returned.
   */
  private async claimNextPendingEvent(
    orderId: string | undefined,
    alreadyClaimed: readonly string[],
  ): Promise<PaymentEvent | undefined> {
    return this.database.transaction(async (tx) => {
      const [claimed] = await tx
        .select()
        .from(paymentEvents)
        .where(
          and(
            // The queue is the absence of a timestamp — there is no `status`
            // column and no jobs table (`docs/walkthrough/slice-3-webhook-inbox.md`
            // §5). This predicate is also the partial index's own, which is what
            // lets the index answer the claim rather than merely help it.
            isNull(paymentEvents.processedAt),

            // Present for `drainOrder`, absent for `drainPending`. `and()`
            // drops `undefined`, so the sweep's statement genuinely has one
            // fewer predicate rather than a `true` standing in for it.
            orderId === undefined ? undefined : eq(paymentEvents.orderId, orderId),

            // Loop control, never exclusion — see the header. `sql.param` binds
            // the whole list as ONE parameter, which is what `ALL` needs;
            // interpolating the array directly would make Drizzle expand it
            // into a row constructor `(a, b)`, which Postgres rejects here.
            // Omitted entirely while empty, so the opening claim of a pass is
            // the statement `architecture.md` §3.1 writes and nothing more.
            alreadyClaimed.length === 0
              ? undefined
              : sql`${paymentEvents.eventId} <> ALL(${sql.param([...alreadyClaimed])})`,
          ),
        )
        .orderBy(paymentEvents.receivedAt)
        .for("update", { skipLocked: true })
        .limit(1);

      return claimed;
    });
  }
}
