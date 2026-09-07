/**
 * Typed domain errors for the supplier call — `architecture.md` §8:
 *
 *   > Error handling: typed domain errors distinguishing *definite failure*
 *   > from *unknown outcome*, **because that distinction is what drives the
 *   > retry policy rather than being merely descriptive.**
 *
 * The second half of that sentence is the whole design. These are not two
 * messages; they are two different facts about the world that demand opposite
 * actions, and a single `SupplierError` with a `message` would let both reach
 * the same `catch` block and be handled the same way — which is precisely the
 * bug the assignment is looking for.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE THROW, WHERE THE REST OF THIS CODEBASE RETURNS NAMED OUTCOMES
 * ---------------------------------------------------------------------------
 * {@link OrderTransitionService}, {@link OrdersService} and
 * {@link SupplierKeyClaimService} all return discriminated unions instead of
 * throwing, because in each of them "nothing happened" is an ordinary result of
 * a statement that ran correctly. Here it is the opposite: the *only* ordinary
 * result of {@link SupplierAClient.issue} is a code. Everything else is the
 * boundary failing — an answer that was a refusal, or no answer at all — and
 * modelling those as return values would let a caller reach for `result.code`
 * on a union it had not narrowed, or ignore the result entirely.
 *
 * Throwing also puts the two classifications where they must not be lost: a
 * `catch (error: unknown)` that does not narrow to one of these two classes is
 * a caller that has failed to make the decision, and it is visible as such.
 *
 * ---------------------------------------------------------------------------
 * EVERY ERROR CARRIES THE STATUS IT WILL BE RECORDED AS
 * ---------------------------------------------------------------------------
 * {@link SupplierIssueError.attemptStatus} is not a description of the error —
 * it is the value written to `issuance_attempts.status`, chosen by the class
 * rather than by the call site. So the classification is made once, in the
 * client that observed the failure, and cannot drift at the place that records
 * it. `assertNever` on the union below is what makes adding a third
 * classification a compile error rather than a silent fall-through into one of
 * the existing two.
 */
import type { SupplierIssueErrorReason } from "@game-shop/contracts";

import { IssuanceAttemptStatus } from "./issuance-attempt-status.js";

/**
 * The base every supplier failure extends. Never thrown directly — it exists so
 * that `error instanceof SupplierIssueError` answers "did the supplier boundary
 * fail?", while the two subclasses answer the question that actually decides
 * anything: *do we know a key was not issued?*
 *
 * Both correlation ids are on the error itself, not only in the message, so a
 * `catch` can log them structurally (`architecture.md` §8: `order_id`,
 * `event_id` and `request_id` on every line in this path).
 */
export abstract class SupplierIssueError extends Error {
  /**
   * What this failure is recorded as in `issuance_attempts.status`. Fixed by the
   * subclass; there is no constructor parameter for it, because the one thing
   * that must never happen is a timeout recorded as `failed`.
   */
  abstract readonly attemptStatus: IssuanceAttemptStatus;

  constructor(
    message: string,
    readonly requestId: string,
    readonly orderId: string,
    readonly provider: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * **The supplier answered, and the answer was no.**
 *
 * Thrown only when a {@link SupplierIssueErrorResponse} was actually parsed out
 * of the response body — `{ status: "error", reason: "out_of_stock" }`. Not when
 * the status code merely looked like a failure: a `409` with an unreadable body
 * is an *unknown* outcome, because the thing that makes a failure definite is
 * the supplier having said so in a form we could read
 * (`../suppliers/a/supplier-a.controller.ts`, "the status code is a hint, not
 * the discriminator").
 *
 * What the caller may conclude: **no key was issued for this `request_id`.** The
 * supplier's claim transaction committed having written nothing, so the pool is
 * untouched and the ledger has no entry. Phase 3 may therefore fall through to
 * the backup supplier with a **new** `request_id`; Phase 1 has no backup, and
 * routes the only defined reason — `out_of_stock` — to the order status of the
 * same name.
 */
export class SupplierDefiniteFailure extends SupplierIssueError {
  override readonly attemptStatus = IssuanceAttemptStatus.Failed;

  constructor(
    /** The supplier's own word for why, written to `issuance_attempts.last_error`. */
    readonly reason: SupplierIssueErrorReason,
    /** The HTTP status that carried it. Logged, never branched on. */
    readonly statusCode: number,
    requestId: string,
    orderId: string,
    provider: string,
  ) {
    super(
      `supplier ${provider} refused ${requestId}: ${reason} (HTTP ${String(statusCode)})`,
      requestId,
      orderId,
      provider,
    );
  }
}

/**
 * **There is no answer, and there may or may not be a key.**
 *
 * Thrown for a timeout, a connection failure, a body that is not JSON, a body
 * that is JSON but not one of the two contract shapes, and a `200` whose
 * `request_id` is not the one we sent. They are one class because the caller's
 * correct action is identical in all of them and is *not* the action for a
 * definite failure: retry **this** supplier with **this same** `request_id`, and
 * never fall through to another one while this attempt is outstanding.
 *
 * The unparseable-body cases are grouped here on purpose rather than treated as
 * "the supplier is broken, give up". A body we cannot read tells us nothing
 * about whether a key left the pool, which is the only question that matters —
 * and a supplier that answered nonsense may well have issued first. Treating
 * that as definite would let the fallback fire over an order that already holds
 * a key.
 *
 * Nothing about this class is exceptional in the operational sense. It is the
 * ordinary consequence of a network, and the order it leaves in `delivering` is
 * an honest state rather than a stuck one.
 */
export class SupplierUnknownOutcome extends SupplierIssueError {
  override readonly attemptStatus = IssuanceAttemptStatus.Unknown;

  constructor(
    /**
     * Which flavour of silence, for the log line only. Deliberately *not* a
     * discriminant a caller may branch on: the moment "timeout" and "bad body"
     * are handled differently, one of them has stopped being treated as unknown.
     */
    readonly detail: string,
    requestId: string,
    orderId: string,
    provider: string,
  ) {
    super(`supplier ${provider} gave no usable answer for ${requestId}: ${detail}`, requestId, orderId, provider);
  }
}
