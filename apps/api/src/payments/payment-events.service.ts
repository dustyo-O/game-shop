/**
 * The webhook inbox — **one statement, and it is the whole of invariant I2**
 * (`architecture.md` §3, §3.1).
 *
 * ---------------------------------------------------------------------------
 * WINNING THE INSERT IS WHAT "FIRST SIGHT" MEANS
 * ---------------------------------------------------------------------------
 * There is no `SELECT` here. Nothing asks "have I seen this event before?" —
 * that question is answered *by writing*, and the answer is how many rows came
 * back. The obvious alternative is one line longer and wrong:
 *
 *     const seen = await db.select().from(paymentEvents).where(eq(eventId, id));
 *     if (seen.length > 0) return alreadySeen();       // <- check
 *     await db.insert(paymentEvents).values(...);      // <- act
 *
 * Two redeliveries that overlap both read zero rows, both insert, and the second
 * one raises a duplicate-key error that Nest turns into a `500` — which is
 * precisely how you ask a payment provider to send the duplicate a third time.
 * The check-then-act does not merely fail to help; it manufactures the retry
 * storm it was meant to prevent. And an in-process `Set` of seen ids would be
 * worse still: `apps/api` runs as serverless functions, so two concurrent
 * webhooks are typically two processes with separate memory — such a guard
 * passes locally and evaporates in production.
 *
 * `ON CONFLICT (event_id) DO NOTHING` moves the decision inside Postgres, where
 * the row itself is the only place every concurrent copy of an event meets.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE PERSISTS. IT DOES NOT PROCESS.
 * ---------------------------------------------------------------------------
 * receive → persist → acknowledge → process (`architecture.md` §4). A row
 * written here has `processed_at` NULL, which is both "pending work" and the
 * queue itself (the partial index `payment_events_unprocessed_order_idx`).
 * Applying the event to its order is the *next* step and deliberately not this
 * one's: the endpoint's job is to make the event durable and get out of the way.
 * `./payment-event-processor.service.ts` is that next step, and it takes the row
 * this file returns — never a request body — which is what makes it callable
 * from a drain as easily as from the webhook.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";

import { paymentEvents, type DatabaseClient, type PaymentEvent } from "@game-shop/db";

import { DATABASE_CLIENT } from "../database/database.module.js";
import type { StorablePaymentEvent } from "./payment-webhook.types.js";

/**
 * Which of the two things happened. Named values rather than
 * `PaymentEvent | null`, matching {@link OrderTransitionService} and
 * {@link OrdersService}: the caller's `switch` reads as two pieces of news, and
 * the compiler has something to be exhaustive about.
 *
 * Both are `200`. Neither is an error.
 */
export const RecordPaymentEventOutcome = {
  /** **First sight.** This call won the insert; the row is in the inbox, unprocessed. */
  Stored: "stored",
  /** A redelivery. The event was already in the inbox and nothing was written. */
  AlreadySeen: "already_seen",
} as const;

export type RecordPaymentEventOutcome =
  (typeof RecordPaymentEventOutcome)[keyof typeof RecordPaymentEventOutcome];

export type RecordPaymentEventResult =
  | {
      readonly outcome: typeof RecordPaymentEventOutcome.Stored;
      /**
       * The row as `RETURNING` produced it — `processed_at` NULL, `received_at`
       * stamped by the database's clock.
       *
       * Only this branch carries it, so "did I actually store it?" cannot be
       * skipped by accident: reaching for `result.event` on an unnarrowed result
       * is a compile error, not a silent `undefined`. The next task's processing
       * step hangs off exactly this branch.
       */
      readonly event: PaymentEvent;
    }
  | {
      readonly outcome: typeof RecordPaymentEventOutcome.AlreadySeen;
      /** Echoed back so the caller can acknowledge without re-reading the request body. */
      readonly eventId: string;
    };

@Injectable()
export class PaymentEventsService {
  private readonly logger = new Logger(PaymentEventsService.name);

  constructor(@Inject(DATABASE_CLIENT) private readonly database: DatabaseClient) {}

  /**
   * Write `event` to the inbox, or discover that it is already there.
   *
   * Emitted SQL (copied from the statement Postgres logged under
   * `log_statement = 'all'`; per the project's raw-SQL rule, `architecture.md`
   * §2, "Documentation convention"):
   *
   *   insert into "payment_events" ("event_id", "order_id", "status",
   *                                 "amount_minor", "currency", "payload",
   *                                 "received_at", "processed_at")
   *   values ($1, $2, $3, $4, $5, $6, default, default)
   *   on conflict ("event_id") do nothing
   *   returning "event_id", "order_id", "status", "amount_minor", "currency",
   *             "payload", "received_at", "processed_at";
   *   -- 1 row  => FIRST SIGHT of this event. It is durable now, with
   *   --           processed_at NULL, and this call is the one that must
   *   --           process it. Exactly one caller ever sees this per event_id.
   *   -- 0 rows => REDELIVERY. A row with this event_id already exists and was
   *   --           left untouched — same received_at, same payload, same
   *   --           processed_at as when it was first stored. Acknowledge 200
   *   --           and stop. This is invariant I2: without it, a redelivered
   *   --           webhook re-runs issuance and the shopper gets a second key.
   *
   * ### Reading the statement
   *
   *   - **`default, default` for the last two columns.** Drizzle names every
   *     column of the table and writes `default` for the ones this call has
   *     nothing to say about. They are the two the shop must not invent:
   *     `received_at` is stamped by **the database's clock**, the one every
   *     other process is compared against rather than a serverless instance's;
   *     `processed_at` has no default, so `default` is NULL — the row enters the
   *     queue as pending, which is the correct and complete outcome of this
   *     endpoint.
   *   - **`DO NOTHING`, not `DO UPDATE`.** A redelivery must leave the stored
   *     row byte-identical. `DO UPDATE SET payload = excluded.payload` would
   *     look harmless and would overwrite the first-sight `received_at`
   *     evidence, and — worse — would return a row, making every redelivery look
   *     like a first sight and re-running issuance.
   *   - **`RETURNING` an explicit column list.** `architecture.md` §3.1 writes
   *     `RETURNING *`; Drizzle expands the star into the table's columns, which
   *     is the same thing to Postgres and one fewer way for a column added later
   *     to change what this method hands its caller.
   *
   * ### No follow-up read on the zero-row path
   *
   * {@link OrderTransitionService} pays for a second `SELECT` when its UPDATE
   * matches nothing, because there "nothing happened" has two causes that lead
   * to different behaviour. Here it has exactly one: a row with this `event_id`
   * exists. There is nothing to disambiguate and nothing a caller would do
   * differently, so the duplicate path issues no query at all — the cheapest
   * possible answer to the most common request a retrying provider makes.
   *
   * ### The one case that is allowed to fail
   *
   * If the insert throws — the database is unreachable, the pool is exhausted —
   * this method does not swallow it. That is the **single** situation in which
   * this system wants a `5xx`: we could not write the event to the inbox, so we
   * genuinely want the provider to send it again (`architecture.md` §4). The
   * catch below logs the correlation ids and rethrows; it does not handle.
   */
  async recordEvent(event: StorablePaymentEvent): Promise<RecordPaymentEventResult> {
    let inserted: PaymentEvent | undefined;

    try {
      [inserted] = await this.database.db
        .insert(paymentEvents)
        .values({
          eventId: event.eventId,
          orderId: event.orderId,
          status: event.status,
          amountMinor: event.amountMinor,
          currency: event.currency,
          payload: event.payload,
        })
        // The conflict target is named rather than left bare: `ON CONFLICT DO
        // NOTHING` with no target swallows a violation of *any* constraint on
        // the table, so a future NOT NULL or CHECK failure would be silently
        // reported to the provider as a duplicate. Naming `event_id` means only
        // the redelivery it is meant for is absorbed here.
        .onConflictDoNothing({ target: paymentEvents.eventId })
        .returning();
    } catch (error: unknown) {
      // Logged and rethrown, not handled. Nest turns this into a 500 and the
      // provider retries — which is what we want, because the event is not
      // durable anywhere.
      this.logger.error({
        msg: "payment webhook: could not write event to the inbox; asking for redelivery",
        event_id: event.eventId,
        order_id: event.orderId,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }

    if (inserted === undefined) {
      this.logger.log({
        msg: "payment webhook: redelivery of an event already in the inbox; nothing written",
        event_id: event.eventId,
        order_id: event.orderId,
      });

      return { outcome: RecordPaymentEventOutcome.AlreadySeen, eventId: event.eventId };
    }

    this.logger.log({
      msg: "payment webhook: event stored, pending processing",
      event_id: inserted.eventId,
      order_id: inserted.orderId,
      status: inserted.status,
      amount_minor: inserted.amountMinor,
    });

    return { outcome: RecordPaymentEventOutcome.Stored, event: inserted };
  }
}
