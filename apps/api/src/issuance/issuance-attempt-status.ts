/**
 * `issuance_attempts.status` — the three words the Phase 3 retry policy reasons
 * over, and the only place the definite/unknown split is written down.
 *
 * ---------------------------------------------------------------------------
 * `failed` AND `unknown` ARE NOT TWO SHADES OF THE SAME THING
 * ---------------------------------------------------------------------------
 * This is the assignment's central trap, and it is a *data* distinction before
 * it is a code one (`architecture.md` §4, "Supplier retry policy"):
 *
 *   - **`failed` — a definite failure.** The supplier answered and said no. We
 *     know no key was issued, because the answer arrived from a transaction that
 *     committed having written nothing
 *     (`../suppliers/supplier-key-claim.service.ts`). It is safe to try the
 *     backup supplier with a **new** `request_id`.
 *   - **`unknown` — no answer.** A timeout, a dead socket, a body that did not
 *     parse. Three mutually exclusive things may be true and nothing observable
 *     distinguishes them: the request never arrived; it arrived, issued a key,
 *     and the response was lost; it arrived and is still running. The only safe
 *     move is to ask **the same supplier the same `request_id`** again, which
 *     the ledger answers with the original code if there was one
 *     (`docs/walkthrough/slice-4-supplier-idempotency.md` §2).
 *   - **The hard rule that falls out of it:** never fall through to the backup
 *     supplier while any attempt for this order is still `unknown`. Doing so is
 *     how one order gets charged for two keys.
 *
 * A row is written `unknown` **before** the call and only ever leaves that value
 * on a definite answer. That ordering is what makes the column trustworthy: a
 * process killed mid-request, a function that hits its execution ceiling, a
 * machine that loses power — all of them leave the row saying exactly what is
 * true, that we asked and do not know. No `catch` block has to run for the
 * record to be correct, which is the only kind of record that survives the
 * failure modes it exists to describe.
 *
 * There is deliberately **no CHECK constraint** on the column
 * (`packages/db/src/schema/shop.ts`): the value set belongs to the retry policy,
 * which is Phase 3's, and it should not have to alter a Phase 1 constraint to
 * extend it.
 */

/**
 * The three states of one supplier call, in the order a row moves through them:
 * written `unknown`, then resolved to `Ok` or `Failed` — or left `unknown`
 * forever, which is a legitimate resting place and not a stuck row.
 */
export const IssuanceAttemptStatus = {
  /**
   * **We asked and do not know the answer.** The row's value from the moment it
   * is written until a definite answer replaces it. Retry *this* provider with
   * *this* `request_id`; never fall through to another supplier.
   */
  Unknown: "unknown",

  /** The supplier returned a code. `issuance_attempts.code` holds it. */
  Ok: "ok",

  /**
   * **A definite refusal.** The supplier answered with a parseable error body;
   * `issuance_attempts.last_error` holds its reason. No key was issued, so
   * Phase 3 may fall through to the backup with a new `request_id`.
   */
  Failed: "failed",
} as const;

export type IssuanceAttemptStatus =
  (typeof IssuanceAttemptStatus)[keyof typeof IssuanceAttemptStatus];
