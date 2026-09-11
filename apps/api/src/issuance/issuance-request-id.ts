/**
 * `req_{order_id}_{provider}_{attempt}` — the identifier the supplier keys its
 * ledger on (technical-considerations §2.2, `architecture.md` §4, "Request id
 * derivation").
 *
 * ---------------------------------------------------------------------------
 * DERIVED, NEVER GENERATED. THAT IS THE WHOLE POINT OF THE FILE.
 * ---------------------------------------------------------------------------
 * The obvious implementation is `randomUUID()` at the top of the issuance path,
 * and it is wrong in a way that only shows up in the one scenario the assignment
 * is built around. When a supplier call times out, the shop does not know
 * whether a key was issued; the only safe move is to ask **the same supplier the
 * same question again**, because the supplier's ledger answers a repeat with the
 * code it already issued rather than issuing a second one (I5,
 * `docs/walkthrough/slice-4-supplier-idempotency.md` §2). A random id makes that
 * repeat impossible to phrase: the retry asks a *different* question, the ledger
 * misses, and a second key leaves the pool for an order that may already hold
 * one.
 *
 * A random id can of course be *stored* and read back — that is what
 * `issuance_attempts.request_id` is — but then correctness depends on every
 * future caller remembering to read it. The admin retry, the Phase 3 fallback
 * and the drain would each have to look it up, and the first one that forgets
 * issues a duplicate key with no error anywhere. Deriving it means there is
 * nothing to remember: attempt 1 for `ord_x` on provider `a` recomputes to
 * `req_ord_x_a_1` in every process, on every machine, forever.
 *
 * So the function below is pure, total and has no dependencies. It is the reason
 * a Phase 3 retry is one line (`attempt` stays the same) rather than a lookup.
 *
 * ---------------------------------------------------------------------------
 * WHY `attempt` IS IN THE ID AT ALL, IF A RETRY MUST REUSE IT
 * ---------------------------------------------------------------------------
 * Because the retry policy has two different retries and they are not the same
 * question (`architecture.md` §4):
 *
 *   - **Retry after a timeout** — the outcome is *unknown*. Same provider, same
 *     `attempt`, therefore the same id: "did my earlier request produce a key?"
 *   - **Fall through after a definite failure** — the outcome is *known* and
 *     negative. A different provider, and a **new** id, because it is a new
 *     question asked of a supplier that has never heard it.
 *
 * `attempt` is what lets the second one exist without a random component. It is
 * Phase 3 that increments it; Phase 1 only ever issues attempt
 * {@link FIRST_ISSUANCE_ATTEMPT}.
 */

/**
 * Which supplier a call is addressed to — the `{provider}` segment.
 *
 * Phase 1 built only `a` (technical-considerations §1); Phase 3 adds `b`, and
 * it really is *one member added here*, which is what makes the ids of the two
 * suppliers un-confusable: `req_ord_x_a_1` and `req_ord_x_b_2` are different
 * rows in `issuance_attempts` and different keys in the shared ledger.
 *
 * **The order matters and is the fall-through order.** `a` is asked first and
 * `b` is the backup (spec 003 §2.1). The retry ladder — `issuance-ladder.ts`,
 * still to be built — takes its sequence from this object rather than keeping a
 * second list of the same two strings somewhere else to disagree with it.
 *
 * An `as const` object rather than a TypeScript `enum`, per the project rule:
 * it emits no runtime class and compares equal to the plain strings Postgres
 * hands back from `issuance_attempts.provider`, which is a `text` column.
 */
export const IssuanceProvider = {
  A: "a",
  B: "b",
} as const;

export type IssuanceProvider = (typeof IssuanceProvider)[keyof typeof IssuanceProvider];

/**
 * The attempt number every Phase 1 issuance uses.
 *
 * One, not zero: the segment is read by a human in a log line and in
 * `psql`, and "attempt 0" reads as "no attempt". Phase 3's retry policy counts
 * up from here.
 */
export const FIRST_ISSUANCE_ATTEMPT = 1;

/**
 * Build the request id for one supplier call.
 *
 *     deriveIssuanceRequestId("ord_01K4...", IssuanceProvider.A, 1)
 *       => "req_ord_01K4..._a_1"
 *
 * Pure: the same three arguments give the same string in every process, which
 * is the property the whole retry policy rests on.
 *
 * The `attempt` guard is not defensive decoration. A `NaN`, a float or a
 * negative would each produce a *different* string for what a caller believed
 * was the same attempt — `req_ord_x_a_NaN` — and the failure would be a second
 * key issued for one order, discovered by a customer rather than by a test. It
 * is cheaper to refuse to build the id.
 */
export function deriveIssuanceRequestId(
  orderId: string,
  provider: IssuanceProvider,
  attempt: number,
): string {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(
      `issuance: attempt must be a positive whole number, received ${JSON.stringify(attempt)}`,
    );
  }

  return `req_${orderId}_${provider}_${String(attempt)}`;
}
