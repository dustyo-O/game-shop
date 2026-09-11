/**
 * The supplier's failure knobs, read and written where every process can see
 * them (spec 003 technical-considerations §7, assumption A6).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SERVICE SITS BESIDE `supplier-key-claim.service.ts` AND NOT UNDER
 * `a/`
 * ---------------------------------------------------------------------------
 * Same reason that one does. There is one behaviour row per provider in one
 * table, and both stubs consume it through this one class; what is specific to
 * a supplier is its controller and its mounted path, not the mechanism. Each
 * stub module lists this service in its own `providers`, exactly as it lists
 * {@link SupplierKeyClaimService}, so neither has to export anything.
 *
 * ###########################################################################
 * # NOTHING IN THE SHOP MAY INJECT THIS. IT IS THE SUPPLIER'S STATE.
 * ###########################################################################
 *
 * The shop is supposed to *discover* that a supplier is refusing or silent by
 * being refused or kept waiting across an HTTP boundary it distrusts. A shop
 * module that read this table would know in advance, and every Phase 3
 * demonstration built on that knowledge — the timeout that is not a failure,
 * the re-probe that gets the same code back, the fall-through to B — would be
 * theatre. The `exports: []` on the supplier modules is what keeps that from
 * being reachable at all.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STATE IS IN POSTGRES RATHER THAN IN A MODULE-LEVEL VARIABLE
 * ---------------------------------------------------------------------------
 *   > `pnpm race` runs four separate processes and a deployment runs N
 *   > instances, so an in-process rate reaches none of the others.
 *
 * A reviewer's `PUT` lands in one process. With the rate in that process's
 * memory the other three keep succeeding, the check that was meant to observe a
 * refusal observes an ordinary purchase, and it passes having exercised
 * nothing. A green check that proves nothing is the worst output this
 * repository can produce, and it is worth a round trip to Postgres on a path
 * that could obviously have been a variable.
 *
 * ---------------------------------------------------------------------------
 * ONE-SHOTS ARE FOR CHECKS; RATES ARE FOR PEOPLE
 * ---------------------------------------------------------------------------
 * ###########################################################################
 * # IF YOU ARE WRITING AN AUTOMATED CHECK, USE `fail_next` / `hang_next` AND
 * # RATES OF EXACTLY 0 OR 1. NEVER A FRACTIONAL RATE.
 * ###########################################################################
 *
 * Functional spec §2.7's fifth criterion is that *the second run behaves the
 * same as the first*. A fractional rate makes that untrue **by construction** —
 * not flaky because of a bug, but unreproducible because a coin is being tossed
 * — and the intermittent red that follows reads to a reviewer as a correctness
 * defect in the shop rather than as a property of the check
 * (technical-considerations §11, R8). The one-shot counters are what make that
 * criterion achievable: "refuse exactly the next call, then behave" is a
 * statement about a specific call, and two runs of it are identical.
 *
 * The rates stay for the reviewer's manual exploration, where "make it fail
 * about half the time and let me watch" is exactly the question being asked.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";

import { supplierBehaviour, type DatabaseClient } from "@game-shop/db";

import { DATABASE_CLIENT } from "../database/database.module.js";
import {
  SupplierHangSource,
  supplierHangPlacement,
  type SupplierHangDecision,
} from "./supplier-hang.js";

/**
 * The two one-shot counters, as a value rather than as two method names.
 *
 * They are decremented by the *same* statement shape against different columns,
 * so making the column a parameter keeps one copy of the annotated SQL. Column
 * identifiers cannot be bound as parameters, so the mapping from this value to
 * a Drizzle column reference is a lookup below and never string concatenation.
 */
export const SupplierOneShot = {
  /** Refuse the next call outright — a **definite** failure, answered and provably key-less. */
  Fail: "fail",
  /** Keep the next call waiting for `hang_ms` — an **unknown** outcome to whoever is asking. */
  Hang: "hang",
} as const;

export type SupplierOneShot = (typeof SupplierOneShot)[keyof typeof SupplierOneShot];

/**
 * Whether *this* call spent a one-shot.
 *
 * A discriminated union rather than a `boolean`, in the shape
 * {@link OrderTransitionResult} uses, because the affirmative branch carries
 * facts the negative one cannot have: `hangMs` is read in the same statement
 * that spends the counter, so it is the duration that was armed at the instant
 * the counter was spent rather than whatever the row says by the time a second
 * query gets there.
 *
 * `consumed: false` is an **ordinary outcome, never an error** — it is what
 * every call sees once the counter is empty, and it is also what a call for a
 * provider that has no row sees. The caller falls back to the rate.
 */
export type SupplierOneShotResult =
  | {
      readonly consumed: true;
      /** How long the hang lasts, from the same row, in the same statement. */
      readonly hangMs: number;
      /**
       * Where the hang sits relative to the key claim, from the same row, in the
       * same statement — `false` is *after the claim commits*, which is the
       * trap (`packages/db/src/schema/supplier.ts`, `hangBeforeClaim`).
       *
       * Returned here for exactly the reason `hangMs` is, and it matters more:
       * a `PUT` landing between the decrement and a follow-up `SELECT` would
       * move the wait to the other side of the claim, turning the trap into an
       * ordinary slow call — or the reverse — with nothing in any log line to
       * say it happened.
       */
      readonly hangBeforeClaim: boolean;
      /** One-shots still armed **after** this one was spent. For a log line, not a decision. */
      readonly remaining: number;
    }
  | { readonly consumed: false };

/**
 * Which knob decided that this call is refused.
 *
 * Carried so the stub's log line can name it. A reviewer staring at a refusal
 * they did not expect needs to know whether they spent the one-shot they armed
 * or whether a rate somebody left turned up rolled against them, and those two
 * are fixed by two different actions.
 */
export const SupplierRefusalSource = {
  /** The `fail_next` counter, spent by this call. Deterministic. */
  OneShot: "fail_next",
  /** The `failure_rate` probability, rolled by this call. */
  Rate: "failure_rate",
} as const;

export type SupplierRefusalSource =
  (typeof SupplierRefusalSource)[keyof typeof SupplierRefusalSource];

/**
 * Whether **this** call is refused before it reaches the key claim.
 *
 * A discriminated union rather than a `boolean`, in the shape
 * {@link SupplierOneShotResult} uses, because each affirmative branch carries a
 * fact the others cannot have: the one-shot branch knows how many are still
 * armed *after* this one was spent, and the rate branch knows the rate it
 * rolled against. Both belong in the log line beside the refusal, and neither
 * is safe to fetch afterwards — a concurrent `PUT` would hand the line a number
 * nobody decided with.
 *
 * `refuse: false` is the overwhelmingly common outcome and is not an error: it
 * is what every call sees against the seeded all-zero baseline.
 */
export type SupplierRefusalDecision =
  | {
      readonly refuse: true;
      readonly source: typeof SupplierRefusalSource.OneShot;
      /** One-shot refusals still armed **after** this one was spent. */
      readonly remaining: number;
    }
  | {
      readonly refuse: true;
      readonly source: typeof SupplierRefusalSource.Rate;
      /** The stored rate this call rolled against. */
      readonly rate: number;
    }
  | { readonly refuse: false };

/** A refusal that fired, narrowed out of {@link SupplierRefusalDecision}. */
export type SupplierRefused = Extract<SupplierRefusalDecision, { refuse: true }>;

/**
 * The knob-specific half of a stub's refusal log line, snake_case like every
 * other field in this project's log stream.
 *
 * A union rather than one interface with two optional fields: `fail_next_remaining`
 * and `failure_rate` describe two different decisions and neither is ever
 * *missing* from the one that produced it. Built here rather than in each stub
 * so the two cannot come to log a refusal differently — the whole reason
 * `./supplier-issue-refusal.ts` sits one level above `a/` and `b/`.
 */
export type SupplierRefusalLogFields =
  | {
      readonly refused_by: typeof SupplierRefusalSource.OneShot;
      readonly fail_next_remaining: number;
    }
  | { readonly refused_by: typeof SupplierRefusalSource.Rate; readonly failure_rate: number };

/** Exhaustiveness guard: the compiler routes here only if a refusal source went unhandled. */
function assertNever(value: never): never {
  throw new Error(`suppliers: unhandled refusal source ${JSON.stringify(value)}`);
}

/**
 * The number the refusal was actually decided with, for the stub's log line.
 *
 * Read off the decision rather than fetched back from the row, for the reason
 * {@link SupplierBehaviourService.consumeOneShot} returns `hang_ms` from its own
 * statement: a concurrent `PUT` between the decision and a follow-up `SELECT`
 * would put a number in the log that nobody decided with, and a log line that
 * misreports why a call was refused is worse than no log line at all.
 */
export function supplierRefusalLogFields(decision: SupplierRefused): SupplierRefusalLogFields {
  switch (decision.source) {
    case SupplierRefusalSource.OneShot:
      return { refused_by: decision.source, fail_next_remaining: decision.remaining };

    case SupplierRefusalSource.Rate:
      return { refused_by: decision.source, failure_rate: decision.rate };

    default:
      return assertNever(decision);
  }
}

/**
 * The knobs, as a whole row. Every field is required: the control endpoint
 * replaces the row rather than merging into it, so there is no such thing as a
 * partially-specified behaviour reaching the database.
 */
export interface SupplierBehaviourSettings {
  readonly failureRate: number;
  readonly hangRate: number;
  readonly hangMs: number;
  readonly failNext: number;
  readonly hangNext: number;
  /** `false` — the baseline — puts an injected hang **after** the key claim commits. */
  readonly hangBeforeClaim: boolean;
}

/** The stored row, as the control endpoint echoes it back. */
export interface StoredSupplierBehaviour extends SupplierBehaviourSettings {
  readonly provider: string;
  readonly updatedAt: Date;
}

/**
 * The result of asking to store a behaviour.
 *
 * `provider_not_found` is decided by **zero rows from the guarded UPDATE**, not
 * by an `if` against a list of provider names held in application code — the
 * same call this codebase makes everywhere else it has to know whether
 * something exists. Adding supplier C means seeding a row, and nothing here
 * changes.
 */
export type SupplierBehaviourWriteResult =
  | { readonly outcome: "stored"; readonly behaviour: StoredSupplierBehaviour }
  | { readonly outcome: "provider_not_found"; readonly provider: string };

@Injectable()
export class SupplierBehaviourService {
  private readonly logger = new Logger(SupplierBehaviourService.name);

  constructor(@Inject(DATABASE_CLIENT) private readonly database: DatabaseClient) {}

  /**
   * Spend one armed one-shot of `kind` for `provider`, if there is one.
   *
   * ###########################################################################
   * # ONE STATEMENT. THE TEST AND THE DECREMENT ARE NOT SEPARABLE.
   * ###########################################################################
   *
   * Emitted SQL (verified against `.toSQL()`; per the project's raw-SQL rule,
   * `architecture.md` §2, "Documentation convention"), for `kind = "hang"`:
   *
   *   update "supplier_behaviour"
   *   set "hang_next" = "supplier_behaviour"."hang_next" - 1, "updated_at" = now()
   *   where ("supplier_behaviour"."provider" = $1
   *          and "supplier_behaviour"."hang_next" > 0)
   *   returning "hang_next", "hang_ms", "hang_before_claim";
   *   -- 1 row  => THIS call consumes the one-shot and hangs, for the `hang_ms`
   *   --           the same row carries, on the side of the key claim that
   *   --           `hang_before_claim` names. Nobody else can also have
   *   --           consumed it.
   *   -- 0 rows => none left, or no such provider. Fall back to `hang_rate`.
   *   --           NOT an error, and by far the common case.
   *
   * The right-hand side is table-qualified because that is what Drizzle emits;
   * the spec quotes the same statement with a bare `hang_next` and the two are
   * the same statement — `SET x = t.x - 1` is ordinary UPDATE syntax, and only
   * the *left* of a SET may not be qualified.
   *
   * For `kind = "fail"` it is the identical statement against `fail_next`.
   *
   * This is invariant I7's shape (`architecture.md` §3.1) applied to a knob instead of
   * to a promo redemption, and the reason is the reason I7 has that shape:
   *
   *   - **The API runs as serverless functions, so two requests are two
   *     processes.** An in-process mutex protects nothing, and `pnpm race`
   *     starts four processes precisely so that a check cannot pass by accident
   *     on a single-process implementation.
   *   - **`SELECT` then `if (n > 0)` then `UPDATE` would pass every
   *     single-process test** and hand the same one-shot to two of those four
   *     processes, arming two refusals where the reviewer asked for one. A check
   *     built on that would report a fall-through the shop never made.
   *
   * `hang_ms` and `hang_before_claim` are returned by this statement rather
   * than read separately for the same reason: a `PUT` that lands between a
   * decrement and a follow-up `SELECT` would hand this call a duration — or, worse,
   * a *placement* — that nobody armed it with, and a hang that moved to the
   * other side of the claim is a different scenario wearing this one's name.
   */
  async consumeOneShot(provider: string, kind: SupplierOneShot): Promise<SupplierOneShotResult> {
    // The column both halves of the statement talk about. Named once so the
    // `WHERE` guard and the `RETURNING` cannot come to disagree about which
    // counter is being spent — which would be a decrement that fires when the
    // *other* counter is armed, and it would look exactly like a working
    // one-shot until somebody armed both.
    const isFail = kind === SupplierOneShot.Fail;
    const counter = isFail ? supplierBehaviour.failNext : supplierBehaviour.hangNext;

    // Spelled out per branch rather than as a computed key: Drizzle's `.set()`
    // is keyed by the *TypeScript* property name, so a dynamic
    // `{ [counter.name]: ... }` would silently address a column that does not
    // exist under that key. Two literal objects cost three lines and cannot.
    const decrement = { updatedAt: sql`now()` } as const;
    const set = isFail
      ? { failNext: sql`${counter} - 1`, ...decrement }
      : { hangNext: sql`${counter} - 1`, ...decrement };

    const [spent] = await this.database.db
      .update(supplierBehaviour)
      .set(set)
      .where(and(eq(supplierBehaviour.provider, provider), sql`${counter} > 0`))
      .returning({
        remaining: counter,
        hangMs: supplierBehaviour.hangMs,
        hangBeforeClaim: supplierBehaviour.hangBeforeClaim,
      });

    if (spent === undefined) return { consumed: false };

    // Logged at `log` and not `debug`: a one-shot firing is the single most
    // interesting thing that happens on a run that is investigating a failure,
    // and the line that says which call spent it is what ties an injected
    // refusal to the order it broke. `request_id` is not in scope here — the
    // caller's own line carries it, and the two are adjacent in the stream.
    this.logger.log({
      msg: `supplier ${provider}: consumed a one-shot ${kind}`,
      provider,
      one_shot: kind,
      remaining: spent.remaining,
      hang_ms: spent.hangMs,
      hang_before_claim: spent.hangBeforeClaim,
    });

    return {
      consumed: true,
      hangMs: spent.hangMs,
      hangBeforeClaim: spent.hangBeforeClaim,
      remaining: spent.remaining,
    };
  }

  /**
   * Is **this** call refused? `fail_next` first, then `failure_rate`.
   *
   * ###########################################################################
   * # BOTH STUBS CALL THIS BEFORE THE KEY CLAIM, AND THE ORDER IS NOT A
   * # PREFERENCE.
   * ###########################################################################
   *
   * **`fail_next` before `failure_rate`.** A reviewer who arms both gets the
   * deterministic one first, which is the only ordering that makes
   * *"refuse exactly the next call"* mean what it says. The reverse order would
   * let a rate steal the call the one-shot was armed for and leave the counter
   * standing — the refusal still happens, so nothing looks wrong, and the
   * *next* call is refused too.
   *
   * **Both before the claim.** A refusal must claim nothing. Refusing after the
   * claim would hand back `supplier_rejected` while a key sat committed against
   * this `request_id`, so an armed refusal would silently drain the fifty-key
   * pool and the shop's stock accounting — `claimed keys = deliveries`, this
   * phase's only assertion that can fail (R2) — would go wrong for a reason
   * that has nothing to do with the shop.
   *
   * ### The one-shot is spent only when it fires
   *
   * {@link consumeOneShot}'s `UPDATE … WHERE fail_next > 0` decrements *and*
   * refuses, in one statement, or does neither. There is deliberately no path
   * here that spends a one-shot on a call it then lets through: `fail_next = 2`
   * is a promise that **the next two calls are refused**, and a decrement on a
   * successful call would break that promise in the least visible way possible
   * — the reviewer would watch two purchases, see one refusal, and have no way
   * to tell which half of the system lied.
   *
   * ### Two round trips, and why not one
   *
   * The rate read is a second statement, and only on the common path where no
   * one-shot fired. Folding both into one `UPDATE` would mean writing the row
   * on **every** `/issue` call — a row lock on the single `supplier_behaviour`
   * row that every concurrent issuance across every process would then queue
   * behind, which is precisely the serialisation `SKIP LOCKED` exists to avoid
   * one table over. Two indexed single-row statements against the supplier's
   * own storage are cheaper than that by a wide margin.
   *
   * Emitted SQL for the rate read (verified against `.toSQL()`; per the
   * project's raw-SQL rule, `architecture.md` §2, "Documentation convention"):
   *
   *   select "failure_rate" from "supplier_behaviour"
   *   where "supplier_behaviour"."provider" = $1;
   *   -- 1 row  => roll against it.
   *   -- 0 rows => no such provider. Treated as "not refusing", NOT as an
   *   --           error: a supplier with no behaviour row is a supplier with
   *   --           no injected chaos, which is exactly how this endpoint
   *   --           behaved before the table existed.
   *
   * `provider` is the PRIMARY KEY, so this is an index lookup of at most one
   * row, and `mode: "number"` on the `numeric(4,3)` column is what makes the
   * value directly comparable to `Math.random()`.
   *
   * ### `<`, and why `<=` would be wrong
   *
   * `Math.random()` returns a value in `[0, 1)`. With `roll < rate`:
   *
   *   - **rate `0` never refuses** — nothing is `< 0`, including the `0` that
   *     `Math.random()` is entitled to return.
   *   - **rate `1` always refuses** — every value in `[0, 1)` is `< 1`.
   *
   * That is the exact contract `scripts/race/README.md` records, because it is
   * what lets an automated check use a rate at all: *"a rate of exactly 0 never
   * refuses, a rate of exactly 1 always refuses"*. `<=` would break the first
   * half on the one run in 2^53 where `Math.random()` returns zero — a check
   * that fails once a year for no discoverable reason is worse than one that
   * never passes. Fractional rates stay out of checks entirely; they are for a
   * person exploring by hand, and this class's header says why.
   */
  async shouldRefuse(provider: string): Promise<SupplierRefusalDecision> {
    const oneShot = await this.consumeOneShot(provider, SupplierOneShot.Fail);
    if (oneShot.consumed) {
      return {
        refuse: true,
        source: SupplierRefusalSource.OneShot,
        remaining: oneShot.remaining,
      };
    }

    const [row] = await this.database.db
      .select({ failureRate: supplierBehaviour.failureRate })
      .from(supplierBehaviour)
      .where(eq(supplierBehaviour.provider, provider));

    // No behaviour row is a supplier with no injected chaos. Not an error.
    if (row === undefined) return { refuse: false };

    // The one place the rate contract lives. Deliberately no `rate === 0`
    // short-circuit above it: a second spelling of "0 never refuses" is a
    // second thing that can come to disagree with this line.
    if (Math.random() < row.failureRate) {
      return { refuse: true, source: SupplierRefusalSource.Rate, rate: row.failureRate };
    }

    return { refuse: false };
  }

  /**
   * Does **this** call hang — for how long, and on which side of the key claim?
   * `hang_next` first, then `hang_rate`.
   *
   * {@link shouldRefuse}'s twin, and deliberately its mirror image down to the
   * ordering argument: the deterministic one-shot is spent before the rate is
   * rolled, so *"hang exactly the next call"* means what it says, and a rate
   * cannot steal the call a one-shot was armed for and leave the counter
   * standing.
   *
   * ###########################################################################
   * # THIS DECIDES; THE STUB PLACES. THE DECISION HAPPENS BEFORE THE CLAIM
   * # EITHER WAY.
   * ###########################################################################
   *
   * Both stubs call this **before** `keys.issue(...)`, because the
   * `before_claim` placement has nothing to act on otherwise and because
   * {@link consumeOneShot} must spend `hang_next` exactly once per call. What
   * the decision does *not* do is wait: the returned
   * {@link SupplierHangDecision} carries the placement, and the stub holds on
   * the side it names (`./supplier-hang.ts`, `supplierHangHold`). Waiting here
   * would make every hang a before-the-claim hang and quietly delete the
   * scenario this phase exists to demonstrate.
   *
   * ### A refusal short-circuits this, and the one-shot is not spent
   *
   * A stub that has already been refused by {@link shouldRefuse} returns before
   * reaching this call, so an armed `hang_next` is still armed and lands on the
   * *next* call. That follows from the rule {@link consumeOneShot} states —
   * a one-shot is spent only when it fires — and it is the honest reading:
   * `fail_next = 1, hang_next = 1` is a promise about two calls, not a promise
   * that one call both refuses and hangs, which it cannot do.
   *
   * ### Two round trips, and why not one
   *
   * The rate read is a second statement, and only on the common path where no
   * one-shot fired — {@link shouldRefuse}'s argument applies verbatim: folding
   * both into one `UPDATE` would write the single `supplier_behaviour` row on
   * every `/issue` call and queue every concurrent issuance in every process
   * behind that row lock.
   *
   * Emitted SQL for the rate read (verified against `.toSQL()`; per the
   * project's raw-SQL rule, `architecture.md` §2, "Documentation convention"):
   *
   *   select "hang_rate", "hang_ms", "hang_before_claim" from "supplier_behaviour"
   *   where "supplier_behaviour"."provider" = $1;
   *   -- 1 row  => roll against `hang_rate`; the other two columns are the
   *   --           duration and the placement this call would use, read in the
   *   --           same snapshot as the rate that chose it.
   *   -- 0 rows => no such provider. Treated as "not hanging", NOT as an error:
   *   --           a supplier with no behaviour row is a supplier with no
   *   --           injected chaos.
   *
   * `provider` is the PRIMARY KEY, so this is an index lookup of at most one
   * row. `<` rather than `<=` against `Math.random()`, for the reason
   * {@link shouldRefuse} spells out: rate `0` never hangs and rate `1` always
   * does, which is the contract `scripts/race/README.md` records and the only
   * one a check can be written against.
   *
   * ### A `hang_ms` of zero is a zero-length hang, and it is reported as one
   *
   * There is deliberately no short-circuit for it. `{"hang_next": 1}` without
   * `hang_ms` is the documented cost of `PUT` replacing rather than merging
   * (`./supplier-behaviour.types.ts`), it is visible in the row the endpoint
   * echoes back, and inventing a default here would hide the one thing that
   * tells a reviewer their check armed nothing.
   */
  async shouldHang(provider: string): Promise<SupplierHangDecision> {
    const oneShot = await this.consumeOneShot(provider, SupplierOneShot.Hang);
    if (oneShot.consumed) {
      return {
        hang: true,
        source: SupplierHangSource.OneShot,
        hangMs: oneShot.hangMs,
        placement: supplierHangPlacement(oneShot.hangBeforeClaim),
        remaining: oneShot.remaining,
      };
    }

    const [row] = await this.database.db
      .select({
        hangRate: supplierBehaviour.hangRate,
        hangMs: supplierBehaviour.hangMs,
        hangBeforeClaim: supplierBehaviour.hangBeforeClaim,
      })
      .from(supplierBehaviour)
      .where(eq(supplierBehaviour.provider, provider));

    // No behaviour row is a supplier with no injected chaos. Not an error.
    if (row === undefined) return { hang: false };

    if (Math.random() < row.hangRate) {
      return {
        hang: true,
        source: SupplierHangSource.Rate,
        hangMs: row.hangMs,
        placement: supplierHangPlacement(row.hangBeforeClaim),
        rate: row.hangRate,
      };
    }

    return { hang: false };
  }

  /**
   * Replace `provider`'s whole behaviour row with `settings`.
   *
   * Emitted SQL (verified against `.toSQL()`):
   *
   *   update "supplier_behaviour"
   *   set "failure_rate" = $1, "hang_rate" = $2, "hang_ms" = $3,
   *       "fail_next" = $4, "hang_next" = $5, "hang_before_claim" = $6,
   *       "updated_at" = now()
   *   where "supplier_behaviour"."provider" = $7
   *   returning "provider", "failure_rate", "hang_rate", "hang_ms",
   *             "fail_next", "hang_next", "updated_at", "hang_before_claim";
   *   -- $1 and $2 go over the wire as the strings "0" / "0.5": `numeric` is
   *   --   sent as text so no value is routed through a binary float on its way
   *   --   to a column chosen precisely to avoid one. It comes back a `number`
   *   --   (`mode: "number"`), which is what the rate is compared against.
   *   -- 1 row  => stored. The caller answers 200 with THIS row — the values as
   *   --           the database holds them, so `numeric(4,3)`'s rounding is
   *   --           shown rather than hidden.
   *   -- 0 rows => THERE IS NO SUCH SUPPLIER. 404. Decided by zero returned
   *   --           rows rather than by a list of provider names in application
   *   --           code, so adding supplier C is a seed row and nothing else.
   *
   * **An UPDATE, deliberately not an upsert.** `INSERT … ON CONFLICT (provider)
   * DO UPDATE` would answer a typo in the path — `/internal/suppliers/aa/…` —
   * by silently creating a behaviour row for a supplier that does not exist,
   * and the reviewer would then watch a perfectly healthy shop ignore knobs they
   * are certain they set. The seed owns which providers exist; this endpoint
   * only moves their knobs.
   *
   * `updated_at = now()` in SQL rather than `new Date()` in Node, for the reason
   * `OrderTransitionService` gives: the clock that stamps the row is the
   * database's, the same one every other process is compared against.
   */
  async replaceBehaviour(
    provider: string,
    settings: SupplierBehaviourSettings,
  ): Promise<SupplierBehaviourWriteResult> {
    const [stored] = await this.database.db
      .update(supplierBehaviour)
      .set({
        failureRate: settings.failureRate,
        hangRate: settings.hangRate,
        hangMs: settings.hangMs,
        failNext: settings.failNext,
        hangNext: settings.hangNext,
        hangBeforeClaim: settings.hangBeforeClaim,
        updatedAt: sql`now()`,
      })
      .where(eq(supplierBehaviour.provider, provider))
      .returning();

    if (stored === undefined) {
      return { outcome: "provider_not_found", provider };
    }

    return {
      outcome: "stored",
      behaviour: {
        provider: stored.provider,
        failureRate: stored.failureRate,
        hangRate: stored.hangRate,
        hangMs: stored.hangMs,
        failNext: stored.failNext,
        hangNext: stored.hangNext,
        hangBeforeClaim: stored.hangBeforeClaim,
        updatedAt: stored.updatedAt,
      },
    };
  }
}
