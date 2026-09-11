// @layer: unit
// @spec: 003-failure-and-recovery
// @regression
/**
 * The retry ladder, exercised as what it is: **a pure function of recorded
 * state.**
 *
 * No database, no Nest container, no supplier, no clock. Rows in, rung out.
 * That is the whole reason `apps/api/src/issuance/issuance-ladder.ts` was split
 * out of the service in the first place — the rule this phase turns on is a
 * *predicate over rows*, and a predicate over rows can be checked by handing it
 * rows.
 *
 * ---------------------------------------------------------------------------
 * THE ONE TEST THAT MATTERS, AND WHY IT CANNOT BE WRITTEN AT ANY OTHER LAYER
 * ---------------------------------------------------------------------------
 * *"An `unknown` attempt present → **not** `fallThrough`."*
 *
 * `architecture.md` §4 states it as the hard rule: never ask the backup supplier
 * while an attempt for this order is outstanding, because a key may already have
 * been issued for that `request_id` and a different supplier cannot be asked the
 * same question. Break it and **two keys leave the pool**.
 *
 * An end-to-end check cannot see that break. `deliveries.order_id` UNIQUE (I3)
 * still gives the shopper exactly one key, the order still reaches `delivered`,
 * the API still answers correctly — the shop looks right from every angle a
 * shopper or an HTTP assertion can see. The only thing that moves is
 * `count(*) FROM supplier_keys WHERE claimed_by_request_id IS NOT NULL` against
 * `count(*) FROM deliveries`, which is spec 003 R2's whole point and needs four
 * processes and a race to observe. Here the same rule is one function call, and
 * a weakened guard fails it deterministically in about a millisecond.
 *
 * Both layers are worth having and neither replaces the other: this one proves
 * the *decision* is right, the concurrency check proves the decision is *taken
 * under the lock*.
 *
 * ---------------------------------------------------------------------------
 * REQUEST IDS ARE TRANSCRIBED, NOT DERIVED
 * ---------------------------------------------------------------------------
 * The expected ids below are written out as string literals rather than
 * produced by calling `deriveIssuanceRequestId`. That is the stance
 * `../concurrency/support/db.ts` documents for the same function: *"a test that
 * imported the very code it is meant to catch a mistake in cannot catch that
 * mistake."* If the derivation and this file were changed in one edit, an
 * assertion built from the derivation would agree with itself; a literal will
 * not.
 *
 * `req_{order}_{provider}_{attempt}` is the shape, and the attempt number is
 * counted **per order across every provider** — which is why the fall-through
 * below expects `req_ord_x_b_2` and never `req_ord_x_b_1` (R7).
 */
import { describe, expect, it } from "vitest";

import {
  IssuanceRestReason,
  IssuanceRung,
  nextIssuanceStep,
  settleRefusedTransition,
  supplierLadder,
  type IssuanceLadderAttempt,
} from "../../src/issuance/issuance-ladder.js";

const ORDER_ID = "ord_x";

/**
 * One `issuance_attempts` row, with the five columns the ladder is allowed to
 * read. Written as loose strings on purpose: `provider`, `status` and
 * `last_error` are `text` columns with no CHECK, so the ladder has to cope with
 * whatever is genuinely in them.
 */
function attemptRow(
  provider: string,
  attempt: number,
  status: string,
  lastError: string | null = null,
): IssuanceLadderAttempt {
  return {
    requestId: `req_${ORDER_ID}_${provider}_${String(attempt)}`,
    provider,
    attempt,
    status,
    lastError,
  };
}

describe("issuance ladder — the fall-through order", () => {
  // @regression
  it("asks `a` first and keeps `b` as the backup, taken from IssuanceProvider rather than a second list", () => {
    // §1.1 and `issuance-request-id.ts`: "The order matters and is the
    // fall-through order." A second hard-coded list is how a provider gets
    // added to the ids and never asked, or asked in an order nobody intended.
    expect(supplierLadder).toEqual(["a", "b"]);
  });
});

describe("issuance ladder — `askFirst`", () => {
  // @regression
  it("returns askFirst for an order with no attempts, at provider `a` attempt 1", () => {
    const step = nextIssuanceStep(ORDER_ID, []);

    expect(step.rung).toBe(IssuanceRung.AskFirst);
    expect(step).toMatchObject({
      provider: "a",
      attempt: 1,
      // Transcribed, not derived. See the file header.
      requestId: "req_ord_x_a_1",
    });
  });
});

describe("issuance ladder — `fallThrough` after a definite refusal", () => {
  // @regression
  it("falls through to the next untried provider at max(attempt) + 1", () => {
    const step = nextIssuanceStep(ORDER_ID, [attemptRow("a", 1, "failed", "out_of_stock")]);

    expect(step.rung).toBe(IssuanceRung.FallThrough);
    expect(step).toMatchObject({
      provider: "b",
      attempt: 2,
      // R7: `req_ord_x_b_1` here would be a per-provider counter, and the next
      // retry of `a` would then recompute `req_ord_x_a_1` — a re-probe of a
      // settled request wearing a fall-through's clothes, swallowed silently by
      // `ON CONFLICT (request_id) DO NOTHING`.
      requestId: "req_ord_x_b_2",
    });
  });

  // @regression
  it("numbers the attempt per order, not per provider — a third ask is attempt 3 whoever it goes to", () => {
    // Reachable through slice 5's operator retry after both suppliers refused.
    // The ladder has no untried provider left here, so this asserts the counter
    // that the *settle* branch would hand to the next rung: `max(attempt)` must
    // be read across every provider's rows, never within one provider's.
    const attempts = [
      attemptRow("a", 1, "failed", "out_of_stock"),
      attemptRow("b", 2, "failed", "out_of_stock"),
    ];

    const step = nextIssuanceStep(ORDER_ID, attempts);

    expect(step.rung).toBe(IssuanceRung.SettleRefused);
    expect(step).toMatchObject({ lastRequestId: "req_ord_x_b_2" });
  });

  // @regression
  it("is a pure function of the SET of rows — the caller's ORDER BY cannot change the answer", () => {
    // `IssuanceHistory.readWithin` emits `ORDER BY attempt DESC`, so
    // `attempts[0]` is usually the highest. A ladder that read the maximum off
    // position 0 would have an invisible precondition living in another file.
    const ascending = [attemptRow("a", 1, "failed", "supplier_rejected")];
    const descending = [...ascending].reverse();

    expect(nextIssuanceStep(ORDER_ID, descending)).toEqual(nextIssuanceStep(ORDER_ID, ascending));
  });
});

describe("issuance ladder — THE HARD RULE: never fall through past an outstanding attempt", () => {
  // @regression
  it("does NOT fall through while an attempt is `unknown` — it rests instead", () => {
    // ###################################################################
    // # THE ASSERTION THIS WHOLE PHASE EXISTS FOR.
    // ###################################################################
    //
    // `a/1` is outstanding: we asked and never heard. A key may already exist
    // for `req_ord_x_a_1`. Asking `b` is asking a DIFFERENT question, so
    // supplier a's ledger (I5) cannot answer it, and a second key leaves the
    // pool for an order that may already hold one.
    //
    // Weakening the guard in `issuance-ladder.ts` makes this exact call return
    // `fallThrough` at `b/2` — which is what the RED validation for this test
    // demonstrates.
    const step = nextIssuanceStep(ORDER_ID, [attemptRow("a", 1, "unknown")]);

    expect(step.rung).not.toBe(IssuanceRung.FallThrough);
    expect(step.rung).toBe(IssuanceRung.Rest);
    expect(step).toMatchObject({
      reason: IssuanceRestReason.OutcomeNeverEstablished,
      // The id slice 3's `probe` re-asks. It is on the step because it is what
      // makes "never established" readable without opening `psql`.
      outstandingRequestId: "req_ord_x_a_1",
    });
  });

  // @regression
  it("scans EVERY attempt, not just the newest — an older outstanding row still blocks", () => {
    // §1.1's wording is "no attempt for this order is `unknown`", and it has to
    // be: a ladder that checked only the newest row would fall through past an
    // outstanding `a/1` the moment a later row existed for any reason. This
    // ordering of rows is not reachable through correct code — which is exactly
    // why the predicate must not assume it is.
    const step = nextIssuanceStep(ORDER_ID, [
      attemptRow("a", 1, "unknown"),
      attemptRow("b", 2, "failed", "out_of_stock"),
    ]);

    expect(step.rung).toBe(IssuanceRung.Rest);
    expect(step).toMatchObject({ outstandingRequestId: "req_ord_x_a_1" });
  });

  // @regression
  it("treats an unrecognised status as outstanding, not as settled", () => {
    // `issuance_attempts.status` is `text` with no CHECK, deliberately — the
    // value set belongs to the retry policy. A row written by a later migration,
    // by `psql`, or by a build that knows a fourth status must not unlock a
    // fall-through: "we cannot read it" and "we do not know" demand the same
    // conservative move.
    const step = nextIssuanceStep(ORDER_ID, [attemptRow("a", 1, "in_flight")]);

    expect(step.rung).toBe(IssuanceRung.Rest);
    expect(step).toMatchObject({ reason: IssuanceRestReason.OutcomeNeverEstablished });
  });

  // @regression
  it("does not ask anybody once a code has been issued", () => {
    const step = nextIssuanceStep(ORDER_ID, [attemptRow("a", 1, "ok")]);

    expect(step.rung).toBe(IssuanceRung.Rest);
    expect(step).toMatchObject({ reason: IssuanceRestReason.AlreadyIssued });
  });
});

describe("issuance ladder — `settleRefused` and §2.4's status table", () => {
  // @regression
  it("settles once every provider in the ladder has definitely refused", () => {
    const step = nextIssuanceStep(ORDER_ID, [
      attemptRow("a", 1, "failed", "out_of_stock"),
      attemptRow("b", 2, "failed", "out_of_stock"),
    ]);

    expect(step.rung).toBe(IssuanceRung.SettleRefused);
    expect(step).toMatchObject({
      // Every reason is an empty shelf, so the shopper is told stock is coming.
      transition: "markOutOfStock",
      refusals: [
        { provider: "a", attempt: 1, requestId: "req_ord_x_a_1", reason: "out_of_stock" },
        { provider: "b", attempt: 2, requestId: "req_ord_x_b_2", reason: "out_of_stock" },
      ],
    });
  });

  // @regression
  it("routes a mix of reasons to delivery_failed, not out_of_stock", () => {
    // §2.4, and functional spec §2.3's second criterion: being temporarily out
    // of stock has to read differently from something having gone wrong. A
    // supplier that refused while the pool is full has nothing to do with
    // stock, and promising the shopper a restock would fix nothing.
    const step = nextIssuanceStep(ORDER_ID, [
      attemptRow("a", 1, "failed", "supplier_rejected"),
      attemptRow("b", 2, "failed", "out_of_stock"),
    ]);

    expect(step).toMatchObject({
      rung: IssuanceRung.SettleRefused,
      transition: "markDeliveryFailed",
    });
  });

  // @regression
  it("treats an unrecorded reason as 'not an empty shelf'", () => {
    // `out_of_stock` is the narrow claim — "both suppliers looked and the shelf
    // is empty" — so a NULL `last_error` is not enough to support it.
    expect(settleRefusedTransition([{ provider: "a", attempt: 1, requestId: "r", reason: null }])).toBe(
      "markDeliveryFailed",
    );

    expect(
      settleRefusedTransition([
        { provider: "a", attempt: 1, requestId: "r", reason: "out_of_stock" },
      ]),
    ).toBe("markOutOfStock");
  });
});
