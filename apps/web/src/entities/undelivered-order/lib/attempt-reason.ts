/**
 * What went wrong with one order, as three facts rather than one word.
 *
 * ###########################################################################
 * # THE REASON COLUMN MUST NOT COLLAPSE *UNKNOWN* INTO *FAILED*.
 * ###########################################################################
 *
 * This file exists for a bug that is one character long:
 *
 *     reason: order.lastError ?? "failed"      // ← wrong, and it type-checks
 *
 * `lastError` is `NULL` on two completely different outcomes. It is `NULL` when
 * a supplier answered *ok*, and it is `NULL` when a supplier **never answered at
 * all** — the row was written `unknown` before the call and nothing has come
 * back to overwrite it (`packages/db/src/schema/shop.ts`, `issuance_attempts`;
 * spec 003 technical-considerations §4). The second case is the whole subject of
 * functional spec §2.2, whose fourth criterion is:
 *
 *   > when a person later reviews that order, then the record shows the outcome
 *   > was never established, **rather than showing it as failed**.
 *
 * The recovery screen is the only place a person ever reviews that record. So
 * the criterion is met or broken here, on this screen, by this cell — and a
 * `??` with a friendly-looking default would break it while every test in the
 * repository stayed green, because nothing else in the shop reads this field.
 *
 * The defence is that this module deals in **facts, not a word**: a definite
 * failure and an unestablished outcome are two separate, independently present
 * pieces of information, and both can be true at once (an older attempt left
 * `unknown`, a newer one definitely refused). There is no slot for a default to
 * be substituted into, because there is no single slot.
 *
 * Wording belongs to the UI, not here — `../ui/undelivered-orders-table.ts` —
 * which is why this returns strings the *supplier* wrote (rendered raw, in a
 * `<code>`) and never a sentence this codebase invented about them.
 */
import type { UndeliveredOrder } from "../model/undelivered-order.js";

/** The three independent facts behind "what went wrong". */
export interface OrderReason {
  /**
   * The newest **definite** refusal, in the supplier's own words, or `null`.
   *
   * Rendered verbatim. The shop does not have a dictionary of supplier reasons
   * and must not pretend to: an unrecognised string is still the most accurate
   * thing anybody can say about this order, and translating it into one of the
   * few reasons this codebase happens to know would turn a true record into a
   * plausible one.
   */
  readonly definiteFailure: string | null;

  /**
   * The id of a request whose outcome was **never established**, or `null`.
   *
   * Not a failure. A key may exist under this id, and only re-probing it can
   * say. The id is on screen because it is the thing an operator would go and
   * look up.
   */
  readonly neverEstablishedRequestId: string | null;

  /**
   * Has any supplier been asked at all?
   *
   * `false` is *"not yet attempted"* — which reads as reassuring and is not:
   * technical-considerations §4 calls these the most alarming rows on the
   * screen, since a paid order nobody has even offered to a supplier is one the
   * shop has forgotten rather than one it is failing at. It is a distinct third
   * thing from both of the above and must not be shown as a blank cell.
   */
  readonly hasBeenAttempted: boolean;
}

/**
 * Read the three facts off one order.
 *
 * An empty string is folded into `null` for `definiteFailure`: `last_error = ''`
 * is a reason nobody wrote, and rendering an empty `<code>` element would put a
 * box with nothing in it where the explanation goes.
 */
export function readOrderReason(order: UndeliveredOrder): OrderReason {
  const definite = order.lastError;

  return {
    definiteFailure: definite === null || definite === "" ? null : definite,
    neverEstablishedRequestId: order.outstandingRequestId,
    hasBeenAttempted: order.attempts.length > 0,
  };
}
