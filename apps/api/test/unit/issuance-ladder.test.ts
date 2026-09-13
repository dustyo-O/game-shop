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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  IssuanceRestReason,
  IssuanceRound,
  IssuanceRung,
  nextIssuanceStep,
  settleRefusedTransition,
  supplierLadder,
  type IssuanceLadderAttempt,
} from "../../src/issuance/issuance-ladder.js";

const ORDER_ID = "ord_x";

/**
 * `SUPPLIER_MAX_PROBES_PER_REQUEST`'s default — assumption A1, one ask and two
 * re-probes.
 *
 * **Transcribed, not imported**, for the same reason the request ids below are:
 * a test that took the number from the module it is checking would agree with
 * that module however the number changed. `DEFAULT_SUPPLIER_MAX_PROBES_PER_REQUEST`
 * in `../../src/config/supplier-config.ts` must equal this, and if somebody
 * changes it there the probe tests below will say so.
 */
const MAX_PROBES = 3;

/**
 * One `issuance_attempts` row, with the six columns the ladder is allowed to
 * read. Written as loose strings on purpose: `provider`, `status` and
 * `last_error` are `text` columns with no CHECK, so the ladder has to cope with
 * whatever is genuinely in them.
 *
 * `probeCount` defaults to 1 — one ask on file, which is what
 * `IssuanceHistory.reserveWithin` writes when a row is born, and therefore the
 * value every attempt row in this system starts life with.
 */
function attemptRow(
  provider: string,
  attempt: number,
  status: string,
  lastError: string | null = null,
  probeCount = 1,
): IssuanceLadderAttempt {
  return {
    requestId: `req_${ORDER_ID}_${provider}_${String(attempt)}`,
    provider,
    attempt,
    status,
    lastError,
    probeCount,
  };
}

/**
 * The ladder, asked at the default budget.
 *
 * A wrapper rather than a third argument at twenty call sites, so a test that
 * *does* care about the budget — the exhaustion ones below — passes it
 * explicitly and reads as the exception it is.
 */
function nextStep(attempts: readonly IssuanceLadderAttempt[], maxProbes = MAX_PROBES) {
  return nextIssuanceStep(ORDER_ID, attempts, maxProbes);
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
    const step = nextStep([]);

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
    const step = nextStep([attemptRow("a", 1, "failed", "out_of_stock")]);

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

    const step = nextStep(attempts);

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

    expect(nextStep(descending)).toEqual(nextStep(ascending));
  });
});

describe("issuance ladder — THE HARD RULE: never fall through past an outstanding attempt", () => {
  // @regression
  it("does NOT fall through while an attempt is `unknown` — it probes the same id instead", () => {
    // ###################################################################
    // # THE ASSERTION THIS WHOLE PHASE EXISTS FOR.
    // ###################################################################
    //
    // `a/1` is outstanding: we asked and never heard. A key may already exist
    // for `req_ord_x_a_1`. Asking `b` is asking a DIFFERENT question, so
    // supplier a's ledger (I5) cannot answer it, and a second key leaves the
    // pool for an order that may already hold one.
    //
    // Weakening the guard in `issuance-ladder.ts` — or simply moving either of
    // its two branches below the `fallThrough` branch — makes this exact call
    // return `fallThrough` at `b/2`, which is what the RED validation for this
    // test demonstrates.
    const step = nextStep([attemptRow("a", 1, "unknown")]);

    expect(step.rung).not.toBe(IssuanceRung.FallThrough);
    expect(step.rung).toBe(IssuanceRung.Probe);
    expect(step).toMatchObject({
      // THE SAME THREE ARGUMENTS. Same supplier, same attempt number, and
      // therefore an id that is byte-identical to the one already outstanding —
      // recomputed, never read back off the row.
      provider: "a",
      attempt: 1,
      requestId: "req_ord_x_a_1",
      probeCount: 1,
    });
  });

  // @regression
  it("scans EVERY attempt, not just the newest — an older outstanding row still blocks", () => {
    // §1.1's wording is "no attempt for this order is `unknown`", and it has to
    // be: a ladder that checked only the newest row would fall through past an
    // outstanding `a/1` the moment a later row existed for any reason. This
    // ordering of rows is not reachable through correct code — which is exactly
    // why the predicate must not assume it is.
    const step = nextStep([
      attemptRow("a", 1, "unknown"),
      attemptRow("b", 2, "failed", "out_of_stock"),
    ]);

    expect(step.rung).toBe(IssuanceRung.Probe);
    expect(step).toMatchObject({ provider: "a", attempt: 1, requestId: "req_ord_x_a_1" });
  });

  // @regression
  it("treats an unrecognised status as outstanding, not as settled", () => {
    // `issuance_attempts.status` is `text` with no CHECK, deliberately — the
    // value set belongs to the retry policy. A row written by a later migration,
    // by `psql`, or by a build that knows a fourth status must not unlock a
    // fall-through: "we cannot read it" and "we do not know" demand the same
    // conservative move.
    const step = nextStep([attemptRow("a", 1, "in_flight")]);

    expect(step.rung).not.toBe(IssuanceRung.FallThrough);
    expect(step.rung).toBe(IssuanceRung.Probe);
  });

  // @regression
  it("does not ask anybody once a code has been issued", () => {
    const step = nextStep([attemptRow("a", 1, "ok")]);

    expect(step.rung).toBe(IssuanceRung.Rest);
    expect(step).toMatchObject({ reason: IssuanceRestReason.AlreadyIssued });
  });
});

describe("issuance ladder — `probe`: the same question, asked again", () => {
  // @regression
  it("recomputes a byte-identical id from the same three arguments on every probe", () => {
    // The crux of §1.2. `probe_count` moves 1 → 2 → 3 and the id does not move
    // at all, because the id is a function of (order, provider, attempt) and
    // none of those three changed. Nothing is remembered between probes and
    // `issuance_attempts.request_id` is never the source — which is why a
    // second process, a later invocation or an operator's retry all phrase the
    // identical question without sharing any state.
    const first = nextStep([attemptRow("a", 1, "unknown", null, 1)]);
    const second = nextStep([attemptRow("a", 1, "unknown", null, 2)]);

    expect(first).toMatchObject({
      rung: IssuanceRung.Probe,
      provider: "a",
      attempt: 1,
      requestId: "req_ord_x_a_1",
      probeCount: 1,
    });
    expect(second).toMatchObject({
      rung: IssuanceRung.Probe,
      provider: "a",
      attempt: 1,
      requestId: "req_ord_x_a_1",
      probeCount: 2,
    });
  });

  // @regression
  it("probes the provider the outstanding attempt named, not the head of the ladder", () => {
    // `b/2` is outstanding after a definite refusal from `a`. The probe must go
    // back to **b**: only the supplier that was asked can say whether it issued
    // a key under `req_ord_x_b_2`, and `a` has never heard that id in its life.
    const step = nextStep([
      attemptRow("a", 1, "failed", "supplier_rejected"),
      attemptRow("b", 2, "unknown"),
    ]);

    expect(step).toMatchObject({
      rung: IssuanceRung.Probe,
      provider: "b",
      attempt: 2,
      requestId: "req_ord_x_b_2",
    });
  });

  // @regression
  it("is a pure function of the SET of rows — the caller's ORDER BY cannot change which id is probed", () => {
    const descending = [attemptRow("b", 2, "unknown"), attemptRow("a", 1, "failed", "out_of_stock")];
    const ascending = [...descending].reverse();

    expect(nextStep(descending)).toEqual(nextStep(ascending));
    expect(nextStep(ascending)).toMatchObject({ requestId: "req_ord_x_b_2" });
  });
});

describe("issuance ladder — `settleNeverEstablished`: the probes are spent", () => {
  // @regression
  it("settles once probe_count reaches the budget, writing nothing about the attempt", () => {
    // A1: three asks in total — the original and two re-probes. At
    // `probe_count = 3` there is nothing left to ask and the step carries no
    // instruction to touch `issuance_attempts`: it names an ORDER transition and
    // reports the row as it stands. The row still says `unknown` with
    // `last_error` NULL, and THAT is the record functional spec §2.2's fourth
    // criterion asks for. A `failed` there is the bug this phase exists to
    // prevent.
    const step = nextStep([attemptRow("a", 1, "unknown", null, MAX_PROBES)]);

    expect(step.rung).toBe(IssuanceRung.SettleNeverEstablished);
    expect(step).toMatchObject({
      // `markDeliveryFailed`, NEVER `markOutOfStock` (§2.4's third row): "nobody
      // knows" is not "the shelf is empty", and promising the shopper a restock
      // would be a claim about stock nobody has evidence for.
      transition: "markDeliveryFailed",
      outstandingRequestId: "req_ord_x_a_1",
      provider: "a",
      attempt: 1,
      probeCount: MAX_PROBES,
    });
  });

  // @regression
  it("OUTRANKS `fallThrough` — an untried supplier is not asked when the probes run out", () => {
    // ###################################################################
    // # THE ORDERING ASSERTION. §1.1: "settleNeverEstablished outranks
    // # fallThrough in the decision order", which is what makes the hard rule
    // # unrepresentable rather than merely obeyed.
    // ###################################################################
    //
    // Supplier `b` has never been asked about this order, so `fallThrough` is
    // *available* on every reading except the one that matters. A key may exist
    // for `req_ord_x_a_1`; asking `b` would be a different question to a
    // different ledger, and a second key would leave the pool. The shopper would
    // still get exactly one key (I3), which is precisely why this assertion
    // lives here and the end-to-end one asserts stock accounting (R2).
    const step = nextStep([attemptRow("a", 1, "unknown", null, MAX_PROBES)]);

    expect(step.rung).not.toBe(IssuanceRung.FallThrough);
    expect(step.rung).toBe(IssuanceRung.SettleNeverEstablished);
    expect(supplierLadder).toContain("b");
  });

  // @regression
  it("settles rather than probing a provider this build cannot address", () => {
    // `issuance_attempts.provider` is `text` with no CHECK. A row naming a
    // supplier this build has never heard of cannot be probed — there is no
    // client and `deriveIssuanceRequestId` would not take the value — and the
    // conservative answer is still not to ask somebody else.
    const step = nextStep([attemptRow("c", 1, "unknown")]);

    expect(step.rung).not.toBe(IssuanceRung.FallThrough);
    expect(step.rung).toBe(IssuanceRung.SettleNeverEstablished);
    expect(step).toMatchObject({ provider: "c", outstandingRequestId: "req_ord_x_c_1" });
  });

  // @regression
  it("takes the budget from its argument rather than a constant of its own", () => {
    // `SUPPLIER_MAX_PROBES_PER_REQUEST` is configuration
    // (`../../src/config/supplier-config.ts`), and the ladder stays a pure
    // function of its arguments: the same rows settle or probe depending only on
    // the number passed in. A default baked in here would be a second copy of
    // that number, and the copy that drifts is the one nobody looks at.
    const rows = [attemptRow("a", 1, "unknown", null, 2)];

    expect(nextStep(rows, 3).rung).toBe(IssuanceRung.Probe);
    expect(nextStep(rows, 2).rung).toBe(IssuanceRung.SettleNeverEstablished);
  });
});

describe("issuance ladder — `settleRefused` and §2.4's status table", () => {
  // @regression
  it("settles once every provider in the ladder has definitely refused", () => {
    const step = nextStep([
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
    const step = nextStep([
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

describe("issuance ladder — the hard rule, exhausted rather than sampled", () => {
  /**
   * ###########################################################################
   * # THE RULE IS UNREPRESENTABLE, AND THIS IS THE ASSERTION THAT SAYS SO.
   * ###########################################################################
   *
   * Every test above this one hands the ladder a *chosen* history. Chosen
   * histories prove the rule holds where somebody thought to look, which is
   * exactly the guarantee §1.1 declines to settle for: *"`settleNeverEstablished`
   * outranks `fallThrough` in the decision order, **which makes the rule
   * unrepresentable rather than merely obeyed**."* Unrepresentable is a claim
   * about *every* input, so it is checked against every input in a space small
   * enough to enumerate.
   *
   * The space is built from what the ladder can actually distinguish, one axis
   * per branch it takes, and **every axis includes a value the database can hold
   * but this build does not recognise** — because `provider`, `status` and
   * `last_error` are `text` columns with no CHECK, and a migration, a seed or a
   * `psql` session can put anything in them:
   *
   * | Axis         | Values                                    | Why |
   * | ------------ | ----------------------------------------- | --- |
   * | `provider`   | `a`, `b`, **`c`** | head, backup, and one this build cannot address at all |
   * | `attempt`    | `1`, `2`                                  | distinguishes `max(attempt)`, and **collides** across rows |
   * | `status`     | `ok`, `failed`, `unknown`, **`in_flight`** | settled, settled, outstanding, and unrecognised |
   * | `probeCount` | `1`, `3`                                  | below the budget, and at it |
   * | `lastError`  | `null`, `out_of_stock`                    | §2.4's two sides |
   *
   * 96 distinct rows, every ordered tuple of length 0 to 3 — histories that
   * cannot occur through correct code included, since `UNIQUE (order_id,
   * attempt)` is a promise the *database* makes and this function must not
   * assume it was kept.
   *
   * **What is asserted is a conditional, not a rung.** For every input: if any
   * row is not definitely settled, the answer is not `fallThrough`. The
   * predicate on the left is written here *independently* of
   * `isDefinitelySettled` — `!== "ok" && !== "failed"`, spelled out — for the
   * same reason the request ids in this file are transcribed rather than
   * derived: a check that imported the definition it is checking would agree
   * with that definition however it changed, including into
   * `status === "unknown"`, which is the exact weakening this assertion exists
   * to catch.
   *
   * Counterexamples are collected rather than asserted one at a time: 894 049
   * `expect` calls would dominate the suite's runtime, and a failure that names
   * the offending history is more useful than a failure that names the first
   * one.
   */
  it("cannot reach `fallThrough` from ANY history containing an unsettled attempt", () => {
    const providers = ["a", "b", "c"] as const;
    const attemptNumbers = [1, 2] as const;
    const statuses = ["ok", "failed", "unknown", "in_flight"] as const;
    const probeCounts = [1, MAX_PROBES] as const;
    const lastErrors = [null, "out_of_stock"] as const;

    const alphabet: IssuanceLadderAttempt[] = [];
    for (const provider of providers) {
      for (const attempt of attemptNumbers) {
        for (const status of statuses) {
          for (const probeCount of probeCounts) {
            for (const lastError of lastErrors) {
              alphabet.push(attemptRow(provider, attempt, status, lastError, probeCount));
            }
          }
        }
      }
    }

    /**
     * "Not definitely settled", written out rather than imported. See the
     * comment above: importing `isDefinitelySettled` would make this assertion
     * agree with any future edit to it.
     */
    const isUnsettled = (row: IssuanceLadderAttempt): boolean =>
      row.status !== "ok" && row.status !== "failed";

    const counterexamples: { readonly history: readonly IssuanceLadderAttempt[] }[] = [];
    let checked = 0;
    let withAnUnsettledRow = 0;
    let reachedFallThrough = 0;
    let reachedProbe = 0;
    let reachedNeverEstablished = 0;

    const check = (history: readonly IssuanceLadderAttempt[]): void => {
      checked += 1;
      const step = nextIssuanceStep(ORDER_ID, history, MAX_PROBES);
      const unsettled = history.some(isUnsettled);

      if (unsettled) withAnUnsettledRow += 1;
      if (step.rung === IssuanceRung.FallThrough) reachedFallThrough += 1;
      if (step.rung === IssuanceRung.Probe) reachedProbe += 1;
      if (step.rung === IssuanceRung.SettleNeverEstablished) reachedNeverEstablished += 1;

      // THE RULE. `architecture.md` §4, §1.1's `fallThrough` row.
      if (unsettled && step.rung === IssuanceRung.FallThrough) {
        counterexamples.push({ history: [...history] });
      }

      // The corollary, and the half that makes "outranks" mean something: the
      // only two rungs an unsettled history may produce are the two that are
      // ABOVE `fallThrough` in the decision order. A future branch that rested,
      // or settled as refused, past an outstanding request would slip through an
      // assertion that only forbade `fallThrough`.
      if (
        unsettled &&
        step.rung !== IssuanceRung.Probe &&
        step.rung !== IssuanceRung.SettleNeverEstablished
      ) {
        counterexamples.push({ history: [...history] });
      }
    };

    check([]);
    for (const first of alphabet) {
      check([first]);
      for (const second of alphabet) {
        check([first, second]);
        for (const third of alphabet) {
          check([first, second, third]);
        }
      }
    }

    // Named so a failure reads as the history it is, not as a count.
    expect(counterexamples.slice(0, 3)).toEqual([]);
    expect(counterexamples).toHaveLength(0);

    // 1 + 96 + 96² + 96³. Asserted so that a refactor which silently shrinks the
    // space cannot make this test pass by checking less.
    expect(checked).toBe(1 + 96 + 96 * 96 + 96 * 96 * 96);

    // ###################################################################
    // # NOT VACUOUS. The space genuinely contains every rung the rule is
    // # about — a guard that returned `rest` for everything would satisfy
    // # the conditional above and fail these four.
    // ###################################################################
    expect(withAnUnsettledRow).toBeGreaterThan(0);
    expect(reachedFallThrough).toBeGreaterThan(0);
    expect(reachedProbe).toBeGreaterThan(0);
    expect(reachedNeverEstablished).toBeGreaterThan(0);
  });
});

describe("issuance ladder — the hard rule, exhausted across BOTH rounds (slice 5's gap, closed)", () => {
  /**
   * ###########################################################################
   * # THE GAP technical-considerations.md §1.1 RECORDS, AND WHAT CLOSES IT.
   * ###########################################################################
   *
   * "Slice 3's exhaustion over 894,049 histories predates this input. It still
   * exhausts the *attempt-history* space but no longer spans the ladder's whole
   * input space, so the hard rule is currently proven for `Continuing` and
   * argued structurally for `Fresh`."
   *
   * The block above calls `nextIssuanceStep` with three arguments everywhere,
   * which is `round = IssuanceRound.Continuing` by default (see this file's
   * import and `nextIssuanceStep`'s signature) — so it never once evaluated
   * `IssuanceRound.Fresh`. "The Fresh branch sits below the outstanding check"
   * was true by reading the source, not by exercising it. This block runs the
   * *identical* 96-row alphabet and the *identical* 0..3-length histories
   * through both rounds and checks two properties over the doubled space:
   *
   *   1. **THE HARD RULE, under either round.** An unsettled history never
   *      reaches `fallThrough`, and the only two rungs an unsettled history may
   *      reach are `probe` and `settleNeverEstablished` — with `round` set to
   *      `Fresh` on every single one of them. Branch 6 (where `Fresh` is read)
   *      sits below branches 2 and 3 in `issuance-ladder.ts`, so `Fresh` must
   *      never change what an unsettled history returns — this is what "cannot
   *      reorder the guard" means, checked rather than read.
   *
   *   2. **FRESH'S OWN JOB.** On every history where `Continuing` reaches
   *      `settleRefused` (every provider in the ladder has definitely
   *      refused), `Fresh` must instead reach `askFirst` at `max(attempt) + 1`
   *      — "ask again", never re-settling the order a second time. That is
   *      §1.2's last row ("Operator retry after both refused → a, 3,
   *      req_ord_x_a_3"), proven over every fully-refused history the alphabet
   *      can build rather than the one hand-picked example above.
   */
  // @regression
  it("Continuing and Fresh agree on every unsettled history; Fresh converts every fully-refused settlement into 'ask again'", () => {
    const providers = ["a", "b", "c"] as const;
    const attemptNumbers = [1, 2] as const;
    const statuses = ["ok", "failed", "unknown", "in_flight"] as const;
    const probeCounts = [1, MAX_PROBES] as const;
    const lastErrors = [null, "out_of_stock"] as const;

    const alphabet: IssuanceLadderAttempt[] = [];
    for (const provider of providers) {
      for (const attempt of attemptNumbers) {
        for (const status of statuses) {
          for (const probeCount of probeCounts) {
            for (const lastError of lastErrors) {
              alphabet.push(attemptRow(provider, attempt, status, lastError, probeCount));
            }
          }
        }
      }
    }

    /** Same independent transcription as the block above — see its comment. */
    const isUnsettled = (row: IssuanceLadderAttempt): boolean =>
      row.status !== "ok" && row.status !== "failed";

    const hardRuleCounterexamples: {
      round: IssuanceRound;
      rung: IssuanceRung;
      history: readonly IssuanceLadderAttempt[];
    }[] = [];
    const freshSettleCounterexamples: {
      history: readonly IssuanceLadderAttempt[];
      freshRung: IssuanceRung;
    }[] = [];

    let checked = 0;
    let reachedProbeFresh = 0;
    let reachedNeverEstablishedFresh = 0;
    let reachedSettleRefusedContinuing = 0;
    let convertedToAskFirstUnderFresh = 0;

    const check = (history: readonly IssuanceLadderAttempt[]): void => {
      const unsettled = history.some(isUnsettled);

      // Exactly two calls per history — one per round, neither recomputed.
      const continuingStep = nextIssuanceStep(ORDER_ID, history, MAX_PROBES, IssuanceRound.Continuing);
      const freshStep = nextIssuanceStep(ORDER_ID, history, MAX_PROBES, IssuanceRound.Fresh);
      checked += 2;

      if (freshStep.rung === IssuanceRung.Probe) reachedProbeFresh += 1;
      if (freshStep.rung === IssuanceRung.SettleNeverEstablished) reachedNeverEstablishedFresh += 1;

      // PROPERTY 1 — THE HARD RULE, checked separately for each round's result.
      for (const [round, step] of [
        [IssuanceRound.Continuing, continuingStep],
        [IssuanceRound.Fresh, freshStep],
      ] as const) {
        if (unsettled && step.rung === IssuanceRung.FallThrough) {
          hardRuleCounterexamples.push({ round, rung: step.rung, history: [...history] });
        }
        if (
          unsettled &&
          step.rung !== IssuanceRung.Probe &&
          step.rung !== IssuanceRung.SettleNeverEstablished
        ) {
          hardRuleCounterexamples.push({ round, rung: step.rung, history: [...history] });
        }
      }

      // PROPERTY 2 — FRESH'S OWN JOB. Only meaningful where Continuing settles
      // refused; everywhere else Fresh's agreement with Continuing is already
      // covered by property 1 (both unsettled) or is not this property's claim.
      if (continuingStep.rung === IssuanceRung.SettleRefused) {
        reachedSettleRefusedContinuing += 1;
        if (freshStep.rung === IssuanceRung.AskFirst) {
          convertedToAskFirstUnderFresh += 1;
        } else {
          freshSettleCounterexamples.push({ history: [...history], freshRung: freshStep.rung });
        }
      }
    };

    check([]);
    for (const first of alphabet) {
      check([first]);
      for (const second of alphabet) {
        check([first, second]);
        for (const third of alphabet) {
          check([first, second, third]);
        }
      }
    }

    // Named so a failure reads as the history and the round it is, not as a count.
    expect(hardRuleCounterexamples.slice(0, 3)).toEqual([]);
    expect(hardRuleCounterexamples).toHaveLength(0);

    // 2 rounds × (1 + 96 + 96² + 96³) — asserted so a refactor that silently
    // shrinks the space, or silently stops evaluating one round, cannot pass by
    // checking less.
    expect(checked).toBe(2 * (1 + 96 + 96 * 96 + 96 * 96 * 96));

    // NOT VACUOUS under Fresh specifically: Fresh must still be reaching the
    // guard's two outcomes on its own, not merely inheriting a pass because it
    // never got there.
    expect(reachedProbeFresh).toBeGreaterThan(0);
    expect(reachedNeverEstablishedFresh).toBeGreaterThan(0);

    // PROPERTY 2's own report, and its own non-vacuity: there must be at least
    // one fully-refused history in the alphabet for "Fresh converts it" to mean
    // anything.
    expect(freshSettleCounterexamples.slice(0, 3)).toEqual([]);
    expect(freshSettleCounterexamples).toHaveLength(0);
    expect(reachedSettleRefusedContinuing).toBeGreaterThan(0);
    expect(convertedToAskFirstUnderFresh).toBe(reachedSettleRefusedContinuing);

    // Quoted verbatim in this task's report rather than paraphrased.
    // eslint-disable-next-line no-console
    console.log(
      "issuance ladder round-axis exhaustion — " +
        `checked=${String(checked)} (2 × 894049), ` +
        `reachedProbeFresh=${String(reachedProbeFresh)}, ` +
        `reachedNeverEstablishedFresh=${String(reachedNeverEstablishedFresh)}, ` +
        `reachedSettleRefusedContinuing=${String(reachedSettleRefusedContinuing)}, ` +
        `convertedToAskFirstUnderFresh=${String(convertedToAskFirstUnderFresh)}`,
    );
  });
});

describe("issuance ladder — RED validation for the round axis (mutant, not a source edit)", () => {
  /**
   * ###########################################################################
   * # WHY THIS RED IS A MUTANT REIMPLEMENTATION, NOT AN EDIT-AND-RESTORE OF
   * # apps/api/src/issuance/issuance-ladder.ts
   * ###########################################################################
   * The verification brief for this slice asks to "move the Fresh branch above
   * the outstanding guard, watch violations appear, restore byte-identical,
   * and report the hash." The agent writing this file is constrained to test
   * files and test configuration only, and may not modify
   * `apps/api/src/issuance/issuance-ladder.ts` — not even transiently with
   * intent to restore it byte-for-byte. That boundary is fixed for this agent,
   * not a per-task judgement call, and it overrides the literal wording above.
   *
   * What follows demonstrates the same fact a source edit-and-restore would:
   * that the property proven above has genuine discriminating power against
   * *exactly* the mistake technical-considerations.md §1.1 names — "It cannot
   * reorder the guard — the Fresh branch sits below the outstanding check."
   *
   * `weakenedNextStep` below is an **independent reimplementation**, not an
   * import and not a monkey-patch of the real function: it makes the same
   * decision `nextIssuanceStep` makes, with exactly one change, spelled out at
   * the point it differs — the `Fresh` branch is tested *before* the
   * outstanding-attempt guard rather than after it, which is precisely the
   * reordering §1.1 forbids. Run against histories this same alphabet can
   * build, it produces real counterexamples: a `Fresh` retry with an
   * outstanding `unknown` attempt asks a brand-new supplier instead of probing
   * the one already in flight — obtaining a second key for a request whose
   * outcome nobody knows, which is the exact failure this whole phase exists
   * to rule out.
   *
   * `apps/api/src/issuance/issuance-ladder.ts` is never opened for writing by
   * this file. Its sha256 is computed and logged below once — "before" and
   * "after" are the same measurement, of a file this suite never touches —
   * which is the honest form of "restored byte-identical" when nothing was
   * ever changed.
   */

  /** Provider order, transcribed rather than imported — see this file's header on that stance. */
  const MUTANT_SUPPLIER_LADDER = ["a", "b"] as const;
  const MUTANT_FIRST_SUPPLIER = "a";

  type MutantRung =
    | "askFirst"
    | "probe"
    | "fallThrough"
    | "settleRefused"
    | "settleNeverEstablished"
    | "rest";

  interface MutantStep {
    readonly rung: MutantRung;
    readonly provider?: string;
    readonly attempt?: number;
  }

  /**
   * The mistake, reified. Identical decision to `nextIssuanceStep`, except the
   * `round === Fresh` check — copied from the bottom branch of the real
   * function — is evaluated first, above the outstanding-attempt guard that in
   * the shipped ladder outranks it.
   */
  function weakenedNextStep(
    attempts: readonly IssuanceLadderAttempt[],
    maxProbesPerRequest: number,
    round: IssuanceRound,
  ): MutantStep {
    if (attempts.length === 0) {
      return { rung: "askFirst", provider: MUTANT_FIRST_SUPPLIER, attempt: 1 };
    }

    const highestAttempt = attempts.reduce((highest, a) => Math.max(highest, a.attempt), 0);

    // #####################################################################
    // # THE MISTAKE: Fresh is decided HERE, above the outstanding guard.
    // #####################################################################
    if (round === IssuanceRound.Fresh) {
      const everyProviderTried = MUTANT_SUPPLIER_LADDER.every((p) =>
        attempts.some((a) => a.provider === p),
      );
      const anyIssued = attempts.some((a) => a.status === "ok");
      if (everyProviderTried && !anyIssued) {
        return { rung: "askFirst", provider: MUTANT_FIRST_SUPPLIER, attempt: highestAttempt + 1 };
      }
    }

    const outstanding = attempts.reduce<IssuanceLadderAttempt | undefined>(
      (newest, a) =>
        a.status === "ok" ||
        a.status === "failed" ||
        (newest !== undefined && newest.attempt >= a.attempt)
          ? newest
          : a,
      undefined,
    );

    if (outstanding !== undefined) {
      if (
        outstanding.probeCount < maxProbesPerRequest &&
        (MUTANT_SUPPLIER_LADDER as readonly string[]).includes(outstanding.provider)
      ) {
        return { rung: "probe", provider: outstanding.provider, attempt: outstanding.attempt };
      }
      return {
        rung: "settleNeverEstablished",
        provider: outstanding.provider,
        attempt: outstanding.attempt,
      };
    }

    if (attempts.some((a) => a.status === "ok")) return { rung: "rest" };

    const untried = MUTANT_SUPPLIER_LADDER.find((p) => !attempts.some((a) => a.provider === p));
    if (untried !== undefined) {
      return { rung: "fallThrough", provider: untried, attempt: highestAttempt + 1 };
    }

    return { rung: "settleRefused" };
  }

  // @regression
  it("reordering Fresh above the outstanding guard produces real violations that the shipped ladder does not", () => {
    const providers = ["a", "b", "c"] as const;
    const attemptNumbers = [1, 2] as const;
    const statuses = ["ok", "failed", "unknown", "in_flight"] as const;
    const probeCounts = [1, MAX_PROBES] as const;
    const lastErrors = [null, "out_of_stock"] as const;

    const alphabet: IssuanceLadderAttempt[] = [];
    for (const provider of providers) {
      for (const attempt of attemptNumbers) {
        for (const status of statuses) {
          for (const probeCount of probeCounts) {
            for (const lastError of lastErrors) {
              alphabet.push(attemptRow(provider, attempt, status, lastError, probeCount));
            }
          }
        }
      }
    }

    const isUnsettled = (row: IssuanceLadderAttempt): boolean =>
      row.status !== "ok" && row.status !== "failed";

    // Pairs are sufficient to demonstrate the mistake — a length-2 history
    // already produces a provider that has been tried by both suppliers while
    // one of the two rows is outstanding, which is exactly the shape the
    // mistake mishandles. (Length-3 histories reproduce the same violations;
    // the block above already exhausts the full 0..3-length space against the
    // real function, so this file does not repeat that scale for a mutant it
    // wrote for one purpose.)
    let checked = 0;
    const mutantViolations: { history: readonly IssuanceLadderAttempt[]; mutantRung: MutantRung }[] = [];
    const realStayedCorrect: { history: readonly IssuanceLadderAttempt[]; realRung: IssuanceRung }[] = [];

    for (const first of alphabet) {
      for (const second of alphabet) {
        const history = [first, second];
        checked += 1;

        const unsettled = history.some(isUnsettled);
        if (!unsettled) continue;

        const mutant = weakenedNextStep(history, MAX_PROBES, IssuanceRound.Fresh);
        const real = nextIssuanceStep(ORDER_ID, history, MAX_PROBES, IssuanceRound.Fresh);

        if (mutant.rung === "askFirst" || mutant.rung === "fallThrough") {
          mutantViolations.push({ history: [...history], mutantRung: mutant.rung });
        }
        if (real.rung === IssuanceRung.Probe || real.rung === IssuanceRung.SettleNeverEstablished) {
          realStayedCorrect.push({ history: [...history], realRung: real.rung });
        }
      }
    }

    // THE RED: the mutant, with the guard reordered, genuinely violates the
    // rule on unsettled histories — this is the failure a source edit-and-
    // restore would have produced, reached here with zero production edits.
    expect(
      mutantViolations.length,
      "the mutant (Fresh checked above the outstanding guard) must produce at least one " +
        "violation on an unsettled history — otherwise this RED proves nothing",
    ).toBeGreaterThan(0);

    // THE CONTRAST: every single history that violates the mutant is a history
    // on which the real, shipped `nextIssuanceStep` still returns
    // probe/settleNeverEstablished — this is what "cannot reorder the guard"
    // means in the running code, demonstrated on the exact histories where the
    // mistake bites.
    for (const violation of mutantViolations) {
      const stillCorrect = realStayedCorrect.some(
        (entry) =>
          entry.history.length === violation.history.length &&
          entry.history.every((row, index) => row === violation.history[index]),
      );
      expect(
        stillCorrect,
        `real nextIssuanceStep must stay correct on the exact history the mutant violates: ${JSON.stringify(violation.history)}`,
      ).toBe(true);
    }

    // eslint-disable-next-line no-console
    console.log(
      "issuance ladder mutant RED — " +
        `checked=${String(checked)} pairs, mutantViolations=${String(mutantViolations.length)}, ` +
        `sample=${JSON.stringify(mutantViolations.slice(0, 2))}`,
    );
  });

  // @regression
  it("apps/api/src/issuance/issuance-ladder.ts was not modified by this suite — sha256 reported, not diffed", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const ladderPath = resolve(testDir, "..", "..", "src", "issuance", "issuance-ladder.ts");

    const contents = readFileSync(ladderPath);
    const sha256 = createHash("sha256").update(contents).digest("hex");

    // Not a before/after diff — this test file makes exactly one filesystem
    // read of the source, never a write, so there is only one measurement to
    // report. "Restored byte-identical" is true by construction: nothing was
    // ever changed.
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);

    // eslint-disable-next-line no-console
    console.log(`apps/api/src/issuance/issuance-ladder.ts sha256 = ${sha256} (unmodified throughout this suite)`);
  });
});
