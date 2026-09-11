/**
 * The retry ladder — **a pure function of recorded state** (spec 003
 * technical-considerations §1.1).
 *
 * Given every `issuance_attempts` row for one order, return the next rung: ask
 * the first supplier, fall through to the backup, or settle. No clock, no
 * database, no Nest, no supplier. That is not a stylistic preference — it is
 * what makes the phase's central rule testable at all. The rule is a *predicate
 * over rows*, and a predicate over rows can be exercised by handing it rows.
 *
 * ---------------------------------------------------------------------------
 * THE CLAUSE THAT CARRIES THE WHOLE PHASE
 * ---------------------------------------------------------------------------
 * From §1.1's table, on the `fallThrough` row:
 *
 *   > newest is `failed`, **no attempt for this order is `unknown`**, an
 *   > untried provider remains
 *
 * `architecture.md` §4 states it as the hard rule; here it is
 * {@link nextIssuanceStep}'s second branch, and it comes *before* the branch
 * that could fall through. That ordering is the enforcement: an order with an
 * outstanding attempt cannot reach the `fallThrough` branch at all, so the rule
 * is unrepresentable rather than merely obeyed.
 *
 * Why it matters is worth restating where the code is, because the failure is
 * invisible from outside the shop. An `unknown` attempt means *a key may
 * already have been issued for that request id and we did not hear the answer*.
 * Asking a **different** supplier is asking a **different** question, so the
 * first supplier's ledger (I5) cannot answer it — and a second key leaves the
 * pool. `deliveries.order_id` UNIQUE (I3) still keeps the shopper to one key,
 * so the shop looks correct from outside; what breaks is **stock accounting**,
 * and `count(*) FROM supplier_keys WHERE claimed_by_request_id IS NOT NULL`
 * against `count(*) FROM deliveries` is the only assertion that can see it
 * (spec 003 R2).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SLICE BUILDS, AND WHAT IS DELIBERATELY MISSING
 * ---------------------------------------------------------------------------
 * §1.1 names five rungs. Three are here — {@link IssuanceRung.AskFirst},
 * {@link IssuanceRung.FallThrough} and {@link IssuanceRung.SettleRefused}. The
 * other two, `probe` and `settleNeverEstablished`, belong to slice 3 and are
 * the *only* two things that may ever be done about an outstanding attempt.
 *
 * Until they exist, an order with an `unknown` attempt has **no rung available
 * and rests where it is** — {@link IssuanceRung.Rest}. That is exactly Phase
 * 1's behaviour (`./issuance.service.ts`, "WHAT THIS SLICE DOES NOT DO") and it
 * is correct: the order sits in `delivering`, the attempt row says `unknown`,
 * the payment event stays pending, and nothing has been claimed twice. Slice 3
 * makes that resting place *productive*; it does not make it *safe*, because it
 * already is.
 *
 * So the `unknown` guard is here **now**, one slice before the rung that acts
 * on it. Adding `probe` and `settleNeverEstablished` then narrows what routes
 * to `Rest` — two new branches between the guard and `fallThrough` — rather
 * than moving the guard. That is the shape §1.1 asks for: *"`settleNeverEstablished`
 * outranks `fallThrough` in the decision order."*
 *
 * ---------------------------------------------------------------------------
 * THE LADDER NEVER INVENTS AN ID. IT CHOOSES THREE ARGUMENTS.
 * ---------------------------------------------------------------------------
 * §1.2, and it is the crux of the phase. Every rung that asks a supplier
 * carries a `requestId`, and that string is always
 * {@link deriveIssuanceRequestId}`(orderId, provider, attempt)` — pure, total,
 * dependency-free. Nothing here reads `issuance_attempts.request_id` in order
 * to reuse it. That is why a re-probe (slice 3) recomputes a *byte-identical*
 * id with no state to remember, and why a fall-through mints a genuinely new
 * one:
 *
 * | Rung          | provider        | attempt                | id            |
 * | ------------- | --------------- | ---------------------- | ------------- |
 * | `askFirst`    | `a`             | `1`                    | `req_x_a_1`   |
 * | `probe` (s3)  | **same as the outstanding attempt** | **same** | **identical** |
 * | `fallThrough` | next untried    | **`max(attempt) + 1`** | `req_x_b_2`   |
 *
 * **`max(attempt) + 1` is across ALL of the order's attempts, not per
 * provider**, and that is R7. A per-provider counter would recompute
 * `req_x_a_1` for an operator's retry of A after B refused — a *re-probe of a
 * settled request*, swallowed silently by `ON CONFLICT (request_id) DO
 * NOTHING`, leaving an order that can never be re-issued.
 * `issuance_attempts_order_id_attempt_key` (UNIQUE `(order_id, attempt)`,
 * migration 0002) is what turns a drifted number into a `23505` instead of a
 * silent reuse — but only if the number is computed per order in the first
 * place, which is this file's job.
 */
import { SupplierIssueErrorReason } from "@game-shop/contracts";

import type { OrderTransitionName } from "../orders/order-transitions.js";
import { IssuanceAttemptStatus } from "./issuance-attempt-status.js";
import {
  FIRST_ISSUANCE_ATTEMPT,
  IssuanceProvider,
  deriveIssuanceRequestId,
} from "./issuance-request-id.js";

/**
 * The order the suppliers are asked in, **derived from
 * {@link IssuanceProvider} rather than restated**.
 *
 * `./issuance-request-id.ts` says so at the declaration: *"The order matters
 * and is the fall-through order… The retry ladder takes its sequence from this
 * object rather than keeping a second list of the same two strings somewhere
 * else to disagree with it."* A second list is how a provider gets added to the
 * ids and never asked, or asked in an order nobody intended.
 *
 * `Object.values` on an `as const` object preserves declaration order, which is
 * the property being relied on. R13 notes a third copy of these two strings
 * living in `packages/db`'s fixtures; that one is out of this task's scope and
 * is recorded there, not fixed here.
 */
export const supplierLadder: readonly IssuanceProvider[] = Object.values(IssuanceProvider);

/**
 * Who `askFirst` asks. `supplierLadder[0]` under `noUncheckedIndexedAccess`,
 * with a fallback that cannot be reached while {@link IssuanceProvider} has at
 * least one member — it is a total expression, not a guess.
 */
const firstSupplier: IssuanceProvider = supplierLadder[0] ?? IssuanceProvider.A;

/**
 * Which rung of the ladder the recorded state puts this order on.
 *
 * An `as const` object rather than a TypeScript `enum`, per the project rule
 * (`.claude/skills/typescript-development`): no runtime class, and the values
 * compare equal to the plain strings that appear in log lines.
 */
export const IssuanceRung = {
  /** No attempt exists. Ask `a`, attempt 1. */
  AskFirst: "askFirst",

  /**
   * The newest attempt is a **definite** refusal, no attempt is outstanding,
   * and a supplier that has never heard about this order remains. A new
   * question, a new id.
   */
  FallThrough: "fallThrough",

  /** Every supplier in the ladder definitely refused. Settle the order. */
  SettleRefused: "settleRefused",

  /**
   * **Nothing to do, and the order stays where it is.** An ordinary member
   * rather than a `null`, in the shape every other outcome type in this
   * codebase uses (§1.1), so a caller's `switch` has to say what it does about
   * it instead of dereferencing a maybe.
   *
   * Slice 3 narrows this: an outstanding attempt becomes `probe` or
   * `settleNeverEstablished`. {@link IssuanceRestReason.AlreadyIssued} stays.
   */
  Rest: "rest",
} as const;

export type IssuanceRung = (typeof IssuanceRung)[keyof typeof IssuanceRung];

/** Why the ladder has nothing to offer. For the log line; the caller does the same thing either way. */
export const IssuanceRestReason = {
  /**
   * An attempt is still `unknown` — **we asked and never heard**. A key may or
   * may not exist for {@link RestStep.outstandingRequestId}, and the only thing
   * that can find out is another call with that same id. Slice 3's `probe` is
   * that call; until then the order rests in `delivering` and is listed as
   * paid-but-undelivered.
   */
  OutcomeNeverEstablished: "outcome_never_established",

  /**
   * An attempt already says `ok`, so a code exists for this order. Reachable
   * only if the delivery or the finishing status did not commit with it — the
   * `Unresolved` path `./issuance.service.ts` reports when a key is bound and
   * the order did not reach `delivered`. Asking any supplier again would be
   * asking for a second key for an order that has one.
   */
  AlreadyIssued: "already_issued",
} as const;

export type IssuanceRestReason = (typeof IssuanceRestReason)[keyof typeof IssuanceRestReason];

/**
 * The row shape the ladder reads — **narrower than `IssuanceAttempt` on
 * purpose.**
 *
 * `readWithin` hands over whole rows; this interface says which five columns a
 * decision may be made from, so a future field cannot quietly start
 * participating. `provider`, `status` and `lastError` are `string`/`string |
 * null` because that is what the `text` columns hold — there is deliberately no
 * CHECK on `issuance_attempts.status` (`packages/db/src/schema/shop.ts`: the
 * value set belongs to this policy), so narrowing them is this file's job and
 * not the schema's.
 */
export interface IssuanceLadderAttempt {
  readonly requestId: string;
  readonly provider: string;
  readonly attempt: number;
  readonly status: string;
  readonly lastError: string | null;
}

/** The three arguments a supplier call is made from, and the id they derive. */
export interface IssuanceAsk {
  readonly provider: IssuanceProvider;
  /** Counted **per order**, across every provider. See the file header, R7. */
  readonly attempt: number;
  /** `deriveIssuanceRequestId(orderId, provider, attempt)`. Never invented. */
  readonly requestId: string;
}

/** One recorded definite refusal, as {@link IssuanceRung.SettleRefused} reports it. */
export interface IssuanceRefusal {
  readonly provider: string;
  readonly attempt: number;
  readonly requestId: string;
  /**
   * `issuance_attempts.last_error` as recorded. `null` is possible — the column
   * is nullable and nothing constrains its values — and a `null` is *not*
   * `out_of_stock`, which is the only thing §2.4's mapping needs to know.
   */
  readonly reason: string | null;
}

/**
 * The two transitions a settled refusal may take, drawn from the transition
 * table rather than written as two strings.
 *
 * `Extract` over {@link OrderTransitionName} is a tripwire: rename either
 * transition in `../orders/order-transitions.ts` and this stops compiling,
 * rather than the ladder naming a move that no longer exists.
 */
export type SettleRefusedTransition = Extract<
  OrderTransitionName,
  "markOutOfStock" | "markDeliveryFailed"
>;

export type AskFirstStep = { readonly rung: typeof IssuanceRung.AskFirst } & IssuanceAsk;
export type FallThroughStep = { readonly rung: typeof IssuanceRung.FallThrough } & IssuanceAsk;

export interface SettleRefusedStep {
  readonly rung: typeof IssuanceRung.SettleRefused;
  /** Chosen by {@link settleRefusedTransition} — §2.4's decision table. */
  readonly transition: SettleRefusedTransition;
  /** Every definite refusal on file, oldest attempt first. */
  readonly refusals: readonly IssuanceRefusal[];
  /** The newest attempt's id — the correlation id for the log line. */
  readonly lastRequestId: string;
}

export interface RestStep {
  readonly rung: typeof IssuanceRung.Rest;
  readonly reason: IssuanceRestReason;
  /** The id whose outcome was never established, or `null` when that is not why. */
  readonly outstandingRequestId: string | null;
}

/**
 * The next rung, as a discriminated union.
 *
 * The two asking rungs are separate members rather than one `ask` with a flag,
 * because they are two different pieces of news: `askFirst` says *this order
 * has never been offered to anyone*, `fallThrough` says *one supplier has
 * already definitely said no*. A caller that logs them identically loses the
 * one distinction a reviewer reads the log for.
 */
export type IssuanceStep = AskFirstStep | FallThroughStep | SettleRefusedStep | RestStep;

/** Whether a step is one that calls a supplier. Narrows to {@link IssuanceAsk}. */
export function isAskStep(step: IssuanceStep): step is AskFirstStep | FallThroughStep {
  return step.rung === IssuanceRung.AskFirst || step.rung === IssuanceRung.FallThrough;
}

/**
 * **The predicate the whole phase turns on**, written as a negation on purpose.
 *
 * An attempt is *definitely settled* only when the supplier answered: `ok` (it
 * issued) or `failed` (it refused). Everything else — `unknown`, and any value
 * this code has never heard of — means **we do not know whether a key was
 * issued**, and the two demand the same conservative move: do not ask anybody
 * else.
 *
 * Written this way rather than as `status === 'unknown'` for a reason that is
 * not defensive decoration. `issuance_attempts.status` is `text` with no CHECK
 * (deliberately — the value set belongs to this policy). A row written by a
 * future migration, by `psql`, or by a build that knows a fourth status would
 * satisfy `status !== 'unknown'` and unlock a fall-through past an outstanding
 * request. The negation makes "unrecognised" behave like "unknown", which is
 * the only reading that cannot issue a second key.
 */
function isDefinitelySettled(attempt: IssuanceLadderAttempt): boolean {
  return (
    attempt.status === IssuanceAttemptStatus.Ok || attempt.status === IssuanceAttemptStatus.Failed
  );
}

/**
 * Which refusal reasons mean *the shelf is empty* rather than *something went
 * wrong* — **the tripwire `transitionForReason` used to carry, kept alive
 * across the move into this file.**
 *
 * `satisfies Record<SupplierIssueErrorReason, boolean>` is what makes it total.
 * `packages/contracts/src/supplier.ts` states the property this upholds: adding
 * a member to `SupplierIssueErrorReason` must be caught *by a compiler rather
 * than by a reader*. Without this table the mapping below would compare against
 * one string and quietly route every future reason to `delivery_failed` — which
 * happens to be §2.4's answer for the reasons that exist today, and is exactly
 * the kind of accidental agreement that stops being true without anybody
 * noticing.
 *
 * A lookup table rather than a `switch` because the value being classified
 * arrives from the database as `text`, not as a narrowed union — see
 * {@link refusalMeansAnEmptyShelf}.
 */
const reasonMeansAnEmptyShelf = {
  [SupplierIssueErrorReason.OutOfStock]: true,
  [SupplierIssueErrorReason.SupplierRejected]: false,
} as const satisfies Record<SupplierIssueErrorReason, boolean>;

/** The reasons above that mean an empty shelf, as plain strings to compare `last_error` against. */
const emptyShelfReasons: readonly string[] = Object.entries(reasonMeansAnEmptyShelf)
  .filter(([, meansAnEmptyShelf]) => meansAnEmptyShelf)
  .map(([reason]) => reason);

/**
 * Does one recorded refusal mean the shelf was empty?
 *
 * `reason` is `issuance_attempts.last_error` — a nullable `text` column with no
 * CHECK — so this deliberately does not assume it is a member of
 * {@link SupplierIssueErrorReason}. `null`, and any value this build has never
 * heard of, answer **no**, which is the conservative side: `out_of_stock` is
 * the narrow claim, and claiming it wrongly promises the shopper a restock that
 * fixes nothing.
 */
function refusalMeansAnEmptyShelf(refusal: IssuanceRefusal): boolean {
  return refusal.reason !== null && emptyShelfReasons.includes(refusal.reason);
}

/**
 * §2.4's decision table: which settled status a fully-refused order lands in.
 *
 * | Every provider's definite reason | Order lands in    |
 * | -------------------------------- | ----------------- |
 * | all `out_of_stock`               | `out_of_stock`    |
 * | any other, or a mix              | `delivery_failed` |
 *
 * **The two must read differently to a shopper** (functional spec 003 §2.3's
 * second criterion): `out_of_stock` renders as «ключей сейчас нет» — *wait,
 * stock is coming* — while `delivery_failed` says something went wrong and the
 * shop is dealing with it. A supplier that refused while the pool is full has
 * nothing to do with stock, and routing it to `out_of_stock` would promise the
 * shopper a restock that fixes nothing.
 *
 * The test is on the whole set, not on the newest refusal, and the asymmetry is
 * deliberate: `out_of_stock` is the *narrow* claim — "both suppliers looked and
 * the shelf is empty" — so a single unreadable or unrecognised reason in the
 * set is enough to make it `delivery_failed`. A `null` `last_error` is one such
 * reason and falls to the same side; see {@link refusalMeansAnEmptyShelf}.
 */
export function settleRefusedTransition(
  refusals: readonly IssuanceRefusal[],
): SettleRefusedTransition {
  return refusals.every(refusalMeansAnEmptyShelf) ? "markOutOfStock" : "markDeliveryFailed";
}

/**
 * The ladder itself: every attempt row for one order in, the next rung out.
 *
 * Pure and total. No argument is a handle, nothing is read, nothing is written,
 * and the same rows give the same answer in every process — which is what lets
 * `../../test/unit/issuance-ladder.test.ts` exercise the rule with no database
 * and no supplier at all.
 *
 * ### The decision order IS the enforcement
 *
 * Read top to bottom. Each branch is unreachable from the ones above it, so the
 * order is not a style choice — it is what makes the hard rule structural:
 *
 *   1. **No attempts** → `askFirst`. Nothing has been offered to anybody.
 *   2. **Any attempt not definitely settled** → `rest`
 *      ({@link IssuanceRestReason.OutcomeNeverEstablished}). *This is the
 *      guard.* Slice 3 replaces this branch with `probe` (probes remain) and
 *      `settleNeverEstablished` (probes exhausted); both stay **above**
 *      `fallThrough`, which is what §1.1 means by "outranks".
 *   3. **Any attempt says `ok`** → `rest`
 *      ({@link IssuanceRestReason.AlreadyIssued}). A code exists for this order.
 *   4. Everything on file is now a definite refusal. **An untried supplier
 *      remains** → `fallThrough`, at `max(attempt) + 1`.
 *   5. **Every supplier refused** → `settleRefused`.
 *
 * Branch 2 scans **every** attempt, not the newest one. §1.1's wording is *"no
 * attempt for this order is `unknown`"*, and it has to be: a shop that checked
 * only the newest row would fall through past an outstanding `a/1` the moment
 * a later row existed for any reason.
 *
 * ### `max(attempt)` is computed, not read off position 0
 *
 * `IssuanceHistory.readWithin` returns the rows `ORDER BY attempt DESC`, so
 * `attempts[0]` would usually be the highest. This function does not rely on
 * that: it is a pure function of a *set* of rows, and a caller that passed them
 * in another order — a test, a future batched read — must get the same answer.
 * A ladder whose correctness depended on an `ORDER BY` in a different file is a
 * ladder with an invisible precondition.
 *
 * @param orderId The order these attempts belong to. Used only to derive ids.
 * @param attempts Every `issuance_attempts` row for that order, in any order.
 */
export function nextIssuanceStep(
  orderId: string,
  attempts: readonly IssuanceLadderAttempt[],
): IssuanceStep {
  // (1) Never offered to anybody. §1.1: provider `a`, attempt 1, `req_x_a_1` —
  //     unchanged from Phase 1, and the same three arguments Phase 1 passed.
  if (attempts.length === 0) {
    return {
      rung: IssuanceRung.AskFirst,
      provider: firstSupplier,
      attempt: FIRST_ISSUANCE_ATTEMPT,
      requestId: deriveIssuanceRequestId(orderId, firstSupplier, FIRST_ISSUANCE_ATTEMPT),
    };
  }

  // #######################################################################
  // # (2) THE GUARD. NOTHING BELOW THIS LINE RUNS WHILE AN OUTCOME IS
  // #     OUTSTANDING — WHICH IS THE POINT, BECAUSE `fallThrough` IS BELOW.
  // #######################################################################
  //
  // Weakening this — restricting it to the newest row, or comparing against
  // `'unknown'` and letting an unrecognised status through — is what slice 3's
  // RED validation does deliberately, and the assertion that catches it is
  // stock accounting, never the shopper's key count (R2).
  const outstanding = attempts.find((attempt) => !isDefinitelySettled(attempt));
  if (outstanding !== undefined) {
    return {
      rung: IssuanceRung.Rest,
      reason: IssuanceRestReason.OutcomeNeverEstablished,
      outstandingRequestId: outstanding.requestId,
    };
  }

  // (3) A code already exists for this order. Not a rung: there is nothing to
  //     ask for, and the recovery path for it is binding the code that exists,
  //     not obtaining another.
  const issued = attempts.find((attempt) => attempt.status === IssuanceAttemptStatus.Ok);
  if (issued !== undefined) {
    return {
      rung: IssuanceRung.Rest,
      reason: IssuanceRestReason.AlreadyIssued,
      outstandingRequestId: null,
    };
  }

  // Everything on file is a definite refusal from here down.
  const highestAttempt = attempts.reduce(
    (highest, attempt) => Math.max(highest, attempt.attempt),
    0,
  );

  // (4) "Next in the ladder" is read as **the first supplier that has never
  //     been asked about this order**, rather than "the one after the newest
  //     attempt's provider". With two suppliers the two readings agree; with
  //     three they diverge on a history that skipped one, and only this reading
  //     keeps the promise the rung's name makes — a supplier that has never
  //     heard the question.
  const untried = supplierLadder.find(
    (provider) => !attempts.some((attempt) => attempt.provider === provider),
  );

  if (untried !== undefined) {
    // R7: per **order**, not per provider. `req_x_a_1` recomputed here instead
    // of `req_x_b_2` would be a re-probe of a settled request wearing a
    // fall-through's clothes.
    const attempt = highestAttempt + 1;

    return {
      rung: IssuanceRung.FallThrough,
      provider: untried,
      attempt,
      requestId: deriveIssuanceRequestId(orderId, untried, attempt),
    };
  }

  // (5) Every supplier in the ladder has definitely refused. Ordered oldest
  //     first so the log line reads as the history it is.
  const refusals: readonly IssuanceRefusal[] = [...attempts]
    .sort((left, right) => left.attempt - right.attempt)
    .map((attempt) => ({
      provider: attempt.provider,
      attempt: attempt.attempt,
      requestId: attempt.requestId,
      reason: attempt.lastError,
    }));

  const newest = refusals[refusals.length - 1];

  return {
    rung: IssuanceRung.SettleRefused,
    transition: settleRefusedTransition(refusals),
    refusals,
    // `refusals` is non-empty on this branch — branch (1) returned for the
    // empty case — so the fallback is unreachable rather than a default.
    lastRequestId: newest?.requestId ?? "",
  };
}
