/**
 * The body `POST /api/admin/payment-events/sweep` answers with.
 *
 * Not in `packages/contracts`, and that is the same call
 * `payments/payment-webhook.types.ts` makes about its acknowledgement. The
 * contracts package holds the wire shapes **two sides have to agree on letter
 * for letter** — the payment webhook payload, the supplier `/issue` contract,
 * the lifecycle enum — because `apps/web`, `apps/api` and the race scripts all
 * serialise or parse them. This one has a single producer and its consumers are
 * a human with `curl` and, later, a reviewer script reading two integers out of
 * it. Publishing it into a package that `apps/web` bundles into a browser would
 * make the shape harder to change and buy nothing.
 *
 * Field names are snake_case, matching every other body this API sends over the
 * wire (`PaymentWebhookAck`, `SupplierIssueOkResponse`).
 */

/**
 * What one sweep did.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE ARE THREE COUNTS AND NOT ONE
 * ---------------------------------------------------------------------------
 * "How many events did you fix?" is not a question the inbox can answer with a
 * single number, because a drain has three honest outcomes per event and two of
 * them are not failures:
 *
 *   - it **settled** the event — applied, delivered, or correctly a no-op;
 *   - it **looked at** the event and deliberately left it pending, because the
 *     order does not exist yet, is still in flight, or has issuance outstanding
 *     (`PaymentEventProcessor`'s `deferred_order_missing`,
 *     `deferred_order_in_flight` and `issuance_claimed`);
 *   - it never reached the event at all.
 *
 * Collapsing those would make the endpoint's most important report — *"I swept
 * and nothing moved"* — indistinguishable from *"I swept and there was nothing
 * to move"*, which are opposite pieces of news for whoever asked.
 */
export interface PaymentEventSweepReport {
  /**
   * **Claims**, not distinct events, summed across every pass — because a row
   * this sweep could not settle is still pending when the next pass starts, and
   * each pass builds its exclusion list from scratch. A single stuck event in a
   * three-pass sweep therefore contributes 3.
   *
   * Reported as claims rather than deduplicated on purpose: it is the number
   * that explains the sweep's cost, and the gap between it and {@link settled}
   * is what says the head of the queue is being handled repeatedly.
   */
  readonly claimed: number;

  /**
   * How many of those claims ended in the event leaving the queue — an outcome
   * whose class sets `processed_at`. Always `<=` {@link claimed}.
   *
   * A count of *conclusions*, not of `UPDATE`s that matched: when two sweeps
   * overlap, both may conclude that one event is settled while only one of them
   * wrote the timestamp (the settle carries `AND processed_at IS NULL`). So
   * across concurrent sweeps these can sum to more than the number of events,
   * and the database — one delivery row, one claimed key — is the authority,
   * never this number (`architecture.md` §7).
   */
  readonly settled: number;

  /**
   * `claimed - settled`: claims this sweep considered and **correctly** left
   * pending. Not an error count. A payment reported for an order that has not
   * been created yet lives here, and so does an order somebody else is
   * mid-issuance on.
   */
  readonly left_pending: number;

  /** How many passes of the drain ran. See the controller for what bounds it. */
  readonly passes: number;

  /**
   * The `DrainStopReason` the final pass ended on, verbatim — `queue_empty`,
   * `pass_limit_reached` or `processing_failed`. None of the three is an error.
   */
  readonly stopped_by: string;

  /**
   * **This sweep stopped before it saw the end of the queue.** `true` means run
   * it again; it does not promise that a specific row was missed.
   *
   * Pessimistic on purpose: `false` only when the final claim came back empty,
   * and even that is not proof of an empty inbox, since a row held by another
   * worker's claim at that instant is skipped rather than counted.
   */
  readonly more_pending: boolean;

  /** Wall-clock for the whole sweep. An operator's first question when it is slow. */
  readonly duration_ms: number;
}
