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
 * {@link nextIssuanceStep}'s second and third branches, and both come *before*
 * the branch that could fall through. That ordering is the enforcement: an order
 * with an outstanding attempt cannot reach the `fallThrough` branch at all, so
 * the rule is unrepresentable rather than merely obeyed.
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
 * THE TWO RUNGS THAT MAY EVER BE TAKEN ABOUT AN OUTSTANDING ATTEMPT
 * ---------------------------------------------------------------------------
 * §1.1 names five rungs and all five are here. Two of them —
 * {@link IssuanceRung.Probe} and {@link IssuanceRung.SettleNeverEstablished} —
 * sit inside the guard above, and they are the *only* two things this system
 * may ever do about an attempt whose outcome was never established:
 *
 *   - **Ask the same supplier the same question again** (`probe`), up to
 *     `SUPPLIER_MAX_PROBES_PER_REQUEST` asks in total, or
 *   - **stop asking and say so** (`settleNeverEstablished`), which moves the
 *     *order* to `delivery_failed` and writes **nothing** to the attempt row —
 *     it already says `unknown` with `last_error` NULL, and that is the record
 *     functional spec §2.2's fourth criterion asks for.
 *
 * They were added one slice after the guard itself, and the sequencing is worth
 * noticing: the guard was correct on its own (the order rested in `delivering`,
 * nothing was claimed twice), and these two rungs make that resting place
 * *productive* rather than making it *safe*. Adding them **narrowed** what
 * routes to {@link IssuanceRung.Rest} instead of moving the guard, which is
 * exactly the shape §1.1 asks for: *"`settleNeverEstablished` outranks
 * `fallThrough` in the decision order."* Both new branches are above
 * `fallThrough`, so no reordering can make the hard rule optional without
 * deleting a branch outright.
 *
 * ---------------------------------------------------------------------------
 * THE LADDER NEVER INVENTS AN ID. IT CHOOSES THREE ARGUMENTS.
 * ---------------------------------------------------------------------------
 * §1.2, and it is the crux of the phase. Every rung that asks a supplier
 * carries a `requestId`, and that string is always
 * {@link deriveIssuanceRequestId}`(orderId, provider, attempt)` — pure, total,
 * dependency-free. Nothing here reads `issuance_attempts.request_id` in order
 * to reuse it. That is why a re-probe recomputes a *byte-identical* id with no
 * state to remember, and why a fall-through mints a genuinely new one:
 *
 * | Rung          | provider        | attempt                | id            |
 * | ------------- | --------------- | ---------------------- | ------------- |
 * | `askFirst`    | `a`             | `1`                    | `req_x_a_1`   |
 * | `probe`       | **same as the outstanding attempt** | **same** | **identical** |
 * | `fallThrough` | next untried    | **`max(attempt) + 1`** | `req_x_b_2`   |
 *
 * **The `probe` row is the whole phase in one line.** Nothing is remembered and
 * nothing is read back: the rung takes `provider` and `attempt` off the
 * outstanding row and hands those same three arguments to
 * {@link deriveIssuanceRequestId}, which recomputes a **byte-identical** string.
 * `issuance_attempts.request_id` is never the source — it is a column this file
 * could delete tomorrow without changing a single id it produces. That is what
 * makes the supplier's ledger (I5) answer a probe with the code it already
 * issued rather than cutting a second one, and it is why the re-probe needs no
 * state, no cache and no correct remembering by any future caller.
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
  /**
   * **Ask the first supplier in the ladder**, at `max(attempt) + 1`.
   *
   * Two histories reach it, and they agree on everything except the number:
   *
   *   - nothing is on file at all — `a`, attempt 1, `req_{order}_a_1`, which is
   *     Phase 1's opening move unchanged;
   *   - **an operator opened a fresh round** on an order every supplier had
   *     already refused — `a`, `max(attempt) + 1`, `req_{order}_a_3` on the
   *     usual history (§1.2's last row, *"same mechanism, one rung further"*).
   *     See {@link IssuanceRound}.
   */
  AskFirst: "askFirst",

  /**
   * **An attempt's outcome was never established and there are asks left in its
   * budget.** Ask the *same* supplier the *same* `request_id` again — the only
   * question whose answer can say whether a key was issued under it.
   *
   * Not a retry of a failure: nothing here has failed. The supplier may have
   * issued a key and lost the answer on the way back, and only its own ledger
   * knows. Counted in `issuance_attempts.probe_count`, bounded by
   * `SUPPLIER_MAX_PROBES_PER_REQUEST`, and above `fallThrough` in the decision
   * order so no silence can ever be answered by asking somebody else.
   */
  Probe: "probe",

  /**
   * The newest attempt is a **definite** refusal, no attempt is outstanding,
   * and a supplier that has never heard about this order remains. A new
   * question, a new id.
   */
  FallThrough: "fallThrough",

  /** Every supplier in the ladder definitely refused. Settle the order. */
  SettleRefused: "settleRefused",

  /**
   * **An attempt is still outstanding and its probes are spent.** Stop asking.
   *
   * The order moves to `delivery_failed` — a statement about *the shop*, "we
   * did not hand over a key" — and **nothing is written to
   * `issuance_attempts`**, because the statement about *the supplier* is
   * already on file and already true: `status = 'unknown'`, `last_error` NULL,
   * `probe_count` at its ceiling. Two different facts, two tables (§1.3).
   *
   * Writing `failed` on that row is the exact bug this phase exists to prevent,
   * and there is nothing truthful to write instead — which is why this rung
   * carries an order transition and no attempt-row change at all.
   */
  SettleNeverEstablished: "settleNeverEstablished",

  /**
   * **Nothing to do, and the order stays where it is.** An ordinary member
   * rather than a `null`, in the shape every other outcome type in this
   * codebase uses (§1.1), so a caller's `switch` has to say what it does about
   * it instead of dereferencing a maybe.
   *
   * Narrower than it was: an outstanding attempt now routes to
   * {@link IssuanceRung.Probe} or {@link IssuanceRung.SettleNeverEstablished},
   * and the one case left is {@link IssuanceRestReason.AlreadyIssued}.
   */
  Rest: "rest",
} as const;

export type IssuanceRung = (typeof IssuanceRung)[keyof typeof IssuanceRung];

/**
 * Why the ladder has nothing to offer. For the log line; the caller does the
 * same thing either way.
 *
 * **One member, and that is the news.** It used to have two: an outstanding
 * attempt also rested here, because there was no rung that could act on one.
 * `probe` and `settleNeverEstablished` took that case away, so *"we asked and
 * never heard"* is no longer a reason to do nothing — it is a reason to ask
 * again, and then a reason to settle. A one-member union rather than a bare
 * string so the next case that genuinely rests has somewhere to be named.
 */
export const IssuanceRestReason = {
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
 * `readWithin` hands over whole rows; this interface says which six columns a
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
  /**
   * How many times this `request_id` has been **asked** — one at birth, plus one
   * per re-probe (`./issuance-history.ts`).
   *
   * Asks, not answers, and not retries. The row is written before the call, so a
   * process killed mid-request leaves a truthful count with no `catch` having
   * run; the accepted cost, stated in §1.2, is that a worker which dies before
   * sending burns a probe. Compared against
   * `SUPPLIER_MAX_PROBES_PER_REQUEST` — `probe_count >= max` is what turns
   * {@link IssuanceRung.Probe} into
   * {@link IssuanceRung.SettleNeverEstablished}.
   */
  readonly probeCount: number;
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

/**
 * The one transition an order takes when a supplier never answered.
 *
 * `Extract` rather than the literal, for the reason {@link
 * SettleRefusedTransition} gives: rename it in `../orders/order-transitions.ts`
 * and this stops compiling. **Never `markOutOfStock`** — §2.4's third row.
 * "Nobody knows whether a key was issued" is not "both suppliers looked and the
 * shelf is empty", and telling the shopper to wait for a restock would be a
 * promise about stock nobody has any evidence for.
 */
export type SettleNeverEstablishedTransition = Extract<OrderTransitionName, "markDeliveryFailed">;

export type AskFirstStep = { readonly rung: typeof IssuanceRung.AskFirst } & IssuanceAsk;
export type FallThroughStep = { readonly rung: typeof IssuanceRung.FallThrough } & IssuanceAsk;

/**
 * Ask the outstanding request again — **the same three arguments, therefore the
 * same id.**
 *
 * An {@link IssuanceAsk} like the other two asking rungs, and structurally
 * indistinguishable from them on purpose: the supplier call takes a provider, an
 * attempt number and an id, and a probe is not a special kind of call. What is
 * special is *which* three values these are, and they are read off the
 * outstanding attempt rather than computed forward.
 */
export type ProbeStep = {
  readonly rung: typeof IssuanceRung.Probe;
  /**
   * `issuance_attempts.probe_count` **as it stands before this probe** — the
   * number of asks already on file. The increment that makes it `probeCount + 1`
   * runs in the same transaction that acts on this rung
   * (`./issuance-history.ts`), so this value is what a log line should read as
   * *"ask n of `SUPPLIER_MAX_PROBES_PER_REQUEST`"* with `n = probeCount + 1`.
   */
  readonly probeCount: number;
} & IssuanceAsk;

/**
 * **The outcome was never established and the shop has stopped asking.**
 *
 * Carries no `requestId` of its own making: {@link
 * SettleNeverEstablishedStep.outstandingRequestId} is the id off the row, and it
 * is here to be *reported* — in the log line, and as `outstanding_request_id` on
 * the operator's recovery list (§8), which is what makes "never established"
 * readable without opening `psql`. It is never handed back to a supplier; a rung
 * that asks derives its id (see the file header).
 */
export interface SettleNeverEstablishedStep {
  readonly rung: typeof IssuanceRung.SettleNeverEstablished;
  /** Always `markDeliveryFailed`. See {@link SettleNeverEstablishedTransition}. */
  readonly transition: SettleNeverEstablishedTransition;
  /** The id whose outcome nobody knows. Reported, never re-asked from here. */
  readonly outstandingRequestId: string;
  /** The supplier that was asked and did not answer. `string`, because the column is `text`. */
  readonly provider: string;
  readonly attempt: number;
  /** The spent budget — equal to `SUPPLIER_MAX_PROBES_PER_REQUEST` on the ordinary path. */
  readonly probeCount: number;
}

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
export type IssuanceStep =
  | AskFirstStep
  | ProbeStep
  | FallThroughStep
  | SettleRefusedStep
  | SettleNeverEstablishedStep
  | RestStep;

/**
 * Whether a step is one that calls a supplier. Narrows to {@link IssuanceAsk}.
 *
 * `probe` is one of them, and a caller that treats it as such is right to:
 * `IssuanceService.askSupplier` takes an {@link IssuanceAsk} and neither knows
 * nor needs to know which rung produced it. What the *runner* must keep separate
 * is what it writes down beforehand — a first ask and a fall-through **reserve**
 * a row, a probe **increments** one — so `actOnStep` tests for `probe` before it
 * reaches this predicate.
 */
export function isAskStep(step: IssuanceStep): step is AskFirstStep | ProbeStep | FallThroughStep {
  return (
    step.rung === IssuanceRung.AskFirst ||
    step.rung === IssuanceRung.Probe ||
    step.rung === IssuanceRung.FallThrough
  );
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
 * Is this `issuance_attempts.provider` value one this build can actually call?
 *
 * The column is `text` with no CHECK, and {@link deriveIssuanceRequestId} takes
 * an {@link IssuanceProvider} — so a probe of a row naming a supplier this build
 * has never heard of cannot be phrased, let alone sent. It is unreachable
 * through this file's own rungs, which only ever write providers drawn from
 * {@link supplierLadder}, and it is checked anyway for the reason every other
 * narrowing here is: a row can arrive from a later migration, from `psql`, or
 * from a build that knew a third supplier.
 *
 * The conservative answer when it fails is **not** to fall through — that is the
 * one thing an outstanding attempt forbids — but to settle as never established,
 * which is exactly what an unaskable outstanding request is.
 */
function isIssuanceProvider(provider: string): provider is IssuanceProvider {
  return (supplierLadder as readonly string[]).includes(provider);
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
 * Whether the rung being computed **opens a new round** of asking.
 *
 * ###########################################################################
 * # THE ONE FACT THE ATTEMPT ROWS CANNOT CARRY.
 * ###########################################################################
 *
 * Every other input to {@link nextIssuanceStep} is on file. This one is not,
 * and it cannot be: `a` refused and `b` refused is the *same set of rows*
 * whether it was written a millisecond ago by the walk that is still running,
 * or a week ago by a walk that settled the order and went home. The two need
 * opposite answers —
 *
 *   - **mid-walk**, every supplier having refused means there is nobody left to
 *     ask and the order settles ({@link IssuanceRung.SettleRefused}); a walk
 *     that started another round here would loop for as long as the shelf
 *     stayed empty, calling both suppliers for ever;
 *   - **at the opening of an operator retry**, those same rows are *history*,
 *     not a verdict. The whole reason a person pressed the button is that
 *     something has changed since — the restock arrived, the supplier that was
 *     refusing is answering again — and §2.5's first criterion is that the
 *     retry obtains a key.
 *
 * — so the caller says which it is. It is the entry point's fact, and
 * `../issuance/issuance-runner.service.ts` is the only thing that knows it:
 * {@link IssuanceRound.Fresh} is passed by exactly one call site, the opening
 * turn of `IssuanceEntry.Operator`. Every recomputation inside a walk takes the
 * default.
 *
 * **It cannot reorder the guard.** A fresh round changes branch (6) and nothing
 * above it, so an order with an outstanding `unknown` attempt still probes and
 * still settles rather than asking anybody new — the rule §1.1 makes structural
 * is untouched, and deliberately so: "the operator asked for it" is not a reason
 * to obtain a second key for a request whose outcome nobody knows.
 */
export const IssuanceRound = {
  /**
   * The default, and what every rung after the first of a walk gets: this is the
   * continuation of a round already under way.
   */
  Continuing: "continuing",

  /**
   * **An operator is opening a new round on a settled order.** Only
   * `IssuanceEntry.Operator`'s opening turn passes it, and it is read by exactly
   * one branch — the last one.
   */
  Fresh: "fresh",
} as const;

export type IssuanceRound = (typeof IssuanceRound)[keyof typeof IssuanceRound];

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
 *   2. **Any attempt not definitely settled, with asks left** → `probe`. *This
 *      is the guard's first half.* Same provider, same attempt number, byte-
 *      identical id.
 *   3. **Any attempt not definitely settled, asks spent** →
 *      `settleNeverEstablished`. *The guard's second half.* The order moves to
 *      `delivery_failed`; the attempt row is left exactly as it is.
 *   4. **Any attempt says `ok`** → `rest`
 *      ({@link IssuanceRestReason.AlreadyIssued}). A code exists for this order.
 *   5. Everything on file is now a definite refusal. **An untried supplier
 *      remains** → `fallThrough`, at `max(attempt) + 1`.
 *   6. **Every supplier refused** → `settleRefused` mid-walk, or — when an
 *      operator is opening a fresh round ({@link IssuanceRound.Fresh}) —
 *      `askFirst` again at `max(attempt) + 1`, which is §1.2's last row.
 *
 * **Branches 2 and 3 are above branch 5, and that placement is the enforcement.**
 * §1.1: *"`settleNeverEstablished` outranks `fallThrough` in the decision
 * order"* — an order with an outstanding attempt cannot reach the `fallThrough`
 * branch at all, so "never ask another supplier while an attempt is
 * outstanding" is unrepresentable rather than merely obeyed. There is no
 * ordering of these six branches that both honours the rule and puts a
 * settlement below a fall-through; move either of them down and the RED
 * validation in `../../test/unit/issuance-ladder.test.ts` fails immediately,
 * which is the point of writing it as an order rather than as a condition.
 *
 * Branches 2 and 3 scan **every** attempt, not the newest one. §1.1's wording is
 * *"no attempt for this order is `unknown`"*, and it has to be: a shop that
 * checked only the newest row would fall through past an outstanding `a/1` the
 * moment a later row existed for any reason. Which outstanding row gets probed
 * *is* the newest of them, chosen by `max(attempt)` over the outstanding set
 * rather than by position, for the same order-independence reason `max(attempt)`
 * is computed below.
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
 * @param round Whether this rung opens a new round of asking. Defaults to
 *   {@link IssuanceRound.Continuing}, which is every caller inside a walk; see
 *   {@link IssuanceRound} for why the rows cannot carry this and the entry point
 *   must.
 * @param maxProbesPerRequest `SUPPLIER_MAX_PROBES_PER_REQUEST` — how many times
 *   one id may be asked in total (A1: one ask and two re-probes). **A required
 *   parameter with no default**, deliberately: a default here would be a second
 *   copy of a number `../config/supplier-config.ts` already owns and validates,
 *   and the copy that drifts is always the one nobody is looking at. Passing it
 *   in also keeps this function pure — the budget is configuration, and a pure
 *   function that read configuration would stop being testable by handing it
 *   rows.
 */
export function nextIssuanceStep(
  orderId: string,
  attempts: readonly IssuanceLadderAttempt[],
  maxProbesPerRequest: number,
  round: IssuanceRound = IssuanceRound.Continuing,
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
  // # (2) AND (3) — THE GUARD. NOTHING BELOW THESE TWO BRANCHES RUNS WHILE AN
  // #     OUTCOME IS OUTSTANDING, WHICH IS THE POINT: `fallThrough` IS BELOW.
  // #######################################################################
  //
  // Weakening this — restricting it to the newest row, comparing against
  // `'unknown'` and letting an unrecognised status through, or moving either
  // branch below `fallThrough` — is what slice 3's RED validation does
  // deliberately, and the assertion that catches it end to end is stock
  // accounting, never the shopper's key count (R2).
  //
  // The **newest** outstanding row is the one acted on: `max(attempt)` over the
  // outstanding set, not `find`'s first hit, so the answer does not depend on
  // the caller's `ORDER BY` (see this function's header).
  const outstanding = attempts.reduce<IssuanceLadderAttempt | undefined>(
    (newest, attempt) =>
      isDefinitelySettled(attempt) || (newest !== undefined && newest.attempt >= attempt.attempt)
        ? newest
        : attempt,
    undefined,
  );

  if (outstanding !== undefined) {
    // (2) ASKS LEFT — RE-ASK THE SAME SUPPLIER THE SAME QUESTION.
    //
    // The three arguments come off the row and go straight into the derivation,
    // which is why the id below is byte-identical to the one already sent and
    // why `outstanding.requestId` is not read to produce it. The supplier's
    // ledger (I5) answers this with the code it already issued, if it issued
    // one — the single fact nothing on this side of the network can know.
    if (outstanding.probeCount < maxProbesPerRequest && isIssuanceProvider(outstanding.provider)) {
      return {
        rung: IssuanceRung.Probe,
        provider: outstanding.provider,
        attempt: outstanding.attempt,
        requestId: deriveIssuanceRequestId(orderId, outstanding.provider, outstanding.attempt),
        probeCount: outstanding.probeCount,
      };
    }

    // (3) ASKS SPENT — STOP ASKING AND SAY SO.
    //
    // The transition moves the ORDER. Nothing here touches the attempt row, and
    // the step carries no instruction to: it says `unknown` with `last_error`
    // NULL and `probe_count` at the ceiling, and that IS the record functional
    // spec §2.2's fourth criterion asks for (§1.3).
    return {
      rung: IssuanceRung.SettleNeverEstablished,
      transition: "markDeliveryFailed",
      outstandingRequestId: outstanding.requestId,
      provider: outstanding.provider,
      attempt: outstanding.attempt,
      probeCount: outstanding.probeCount,
    };
  }

  // (4) A code already exists for this order. Not a rung: there is nothing to
  //     ask for, and the recovery path for it is binding the code that exists,
  //     not obtaining another.
  const issued = attempts.find((attempt) => attempt.status === IssuanceAttemptStatus.Ok);
  if (issued !== undefined) {
    return { rung: IssuanceRung.Rest, reason: IssuanceRestReason.AlreadyIssued };
  }

  // Everything on file is a definite refusal from here down.
  const highestAttempt = attempts.reduce(
    (highest, attempt) => Math.max(highest, attempt.attempt),
    0,
  );

  // (5) "Next in the ladder" is read as **the first supplier that has never
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

  // #######################################################################
  // # (6) EVERY SUPPLIER IN THE LADDER HAS DEFINITELY REFUSED.
  // #######################################################################
  //
  // Mid-walk that is the end of the road and the order settles. At the opening
  // of an operator's retry it is history: ask the first supplier again, one
  // rung further on (§1.2, "Operator retry after both refused → `a`, `3`,
  // `req_ord_x_a_3`").
  //
  // `max(attempt) + 1`, never `1` — R7. Reusing attempt 1 would recompute
  // `req_{order}_a_1`, collide on `issuance_attempts_request_id_key`, be
  // swallowed as a re-probe of a settled request, and leave the order
  // permanently unable to be issued. The `UNIQUE (order_id, attempt)` added in
  // slice 2 turns the same mistake made elsewhere into a `23505` instead.
  //
  // This is the whole of the operator retry's effect on the ladder, and it is
  // one branch at the bottom: the rungs above it — the `unknown` guard, the
  // probe, the fall-through — behave for a person exactly as they behave for a
  // payment event, because they are the same code reading the same rows.
  if (round === IssuanceRound.Fresh) {
    const attempt = highestAttempt + 1;

    return {
      rung: IssuanceRung.AskFirst,
      provider: firstSupplier,
      attempt,
      requestId: deriveIssuanceRequestId(orderId, firstSupplier, attempt),
    };
  }

  // Ordered oldest first so the log line reads as the history it is.
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
