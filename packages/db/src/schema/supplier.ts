/**
 * Supplier-side schema — **not the shop's tables.**
 *
 * These three tables belong to the simulated key supplier (architecture §2,
 * "Core tables"; technical-considerations §2.2, and spec 003 §7 for
 * `supplier_behaviour`). They are kept in a separate module, with a separate
 * prefix, and are never joined to a shop table, because the separation is a
 * correctness device rather than a matter of tidiness:
 *
 *   - The fifty keys are **supplier-side inventory**, not shop inventory. The
 *     shop never selects from `supplier_keys`; it asks for a key over HTTP and
 *     believes the answer only once it has written a `deliveries` row of its own.
 *   - Sharing state with a service we are supposed to distrust would quietly
 *     hand the shop guarantees it has not earned. Every later phase — supplier
 *     timeouts, the same-`request_id` retry trap, the fallback to supplier B —
 *     only means something if the shop's knowledge of a key is limited to what
 *     came back across that boundary.
 *   - They live in the same database purely so one `docker compose up` runs the
 *     whole demonstration. Treat them as if they were in the supplier's own
 *     datacentre: if shop code ever imports this file, that is the bug.
 *
 * Annotation convention is the same as `./shop.ts`: each correctness-critical
 * constraint names its invariant (I1-I9, architecture §3) and quotes the exact
 * statement it supports, including what zero returned rows means.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/**
 * `supplier_keys` — the supplier's key pool. Seeded with the fifty supplied
 * codes; exhausting it is how the `out_of_stock` scenario is produced.
 *
 * A key is claimed by exactly one request, forever. There is no "unclaim":
 * restocking is adding rows, not clearing `claimed_by_request_id`.
 */
export const supplierKeys = pgTable(
  "supplier_keys",
  {
    /**
     * Sequential identity, and the claim's ordering key — `ORDER BY id` in the
     * statement below hands out keys in a stable, predictable order, which is
     * what makes a drained-pool test reproducible.
     */
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),

    /** The key itself. UNIQUE — the pool cannot contain the same code twice. */
    code: text("code").notNull(),

    /**
     * I6 — one key → at most one request.
     *
     * NULL means unclaimed. Once set it never changes. UNIQUE, so even a lost
     * race cannot produce a double claim; NULLs do not collide in a Postgres
     * unique index, so the whole unclaimed pool coexists under it.
     */
    claimedByRequestId: text("claimed_by_request_id"),

    /** When the claim happened. NULL exactly when `claimed_by_request_id` is NULL. */
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (t) => [
    // ---------------------------------------------------------------------
    // The pool cannot hold the same code twice.
    //   CREATE TABLE supplier_keys (
    //     ... CONSTRAINT supplier_keys_code_key UNIQUE (code));
    // Also what makes the seed re-runnable: ON CONFLICT (code) DO NOTHING.
    // ---------------------------------------------------------------------
    unique("supplier_keys_code_key").on(t.code),

    // ---------------------------------------------------------------------
    // I6 — one key → at most one request.
    //
    //   UPDATE supplier_keys
    //   SET claimed_by_request_id = $1, claimed_at = now()
    //   WHERE code = (
    //     SELECT code FROM supplier_keys
    //     WHERE claimed_by_request_id IS NULL
    //     ORDER BY id
    //     FOR UPDATE SKIP LOCKED
    //     LIMIT 1
    //   )
    //   RETURNING code;
    //   -- 0 rows => the pool is exhausted (every key claimed, or every
    //   --           remaining candidate is locked by a concurrent claim)
    //   --           => the supplier answers `out_of_stock`.
    //
    // The subquery picks an unclaimed key and locks it; the outer UPDATE claims
    // it. One statement, so there is no read-then-write window to race in. This
    // UNIQUE index is the backstop underneath that: even if the claim logic were
    // wrong, the same key could not be sold twice — the second claim would
    // raise instead of succeeding quietly.
    // (architecture.md §3, I6 and §3.1.)
    // ---------------------------------------------------------------------
    unique("supplier_keys_claimed_by_request_id_key").on(t.claimedByRequestId),

    // ---------------------------------------------------------------------
    // The claim's hot path (technical-considerations §2.2).
    //
    //   CREATE INDEX supplier_keys_unclaimed_idx
    //     ON supplier_keys (id) WHERE claimed_by_request_id IS NULL;
    //
    // Partial, so it holds only what is still for sale: it shrinks as the pool
    // drains and disappears entirely once it is empty, which is precisely when
    // the claim query is asked most often and must not scan fifty dead rows.
    // Indexing `id` gives the subquery's `ORDER BY id ... LIMIT 1` an ordered
    // path rather than a sort.
    // ---------------------------------------------------------------------
    index("supplier_keys_unclaimed_idx")
      .on(t.id)
      .where(sql`"claimed_by_request_id" IS NULL`),
  ],
);

/**
 * `supplier_requests` — the supplier's own idempotency ledger.
 *
 * This is the table the entire Phase 3 timeout trap rests on. When our client
 * times out it does not know whether a key was issued, so it retries **the same
 * supplier with the same `request_id`** — and this ledger is what makes that
 * retry return the original code instead of burning a second key.
 */
export const supplierRequests = pgTable("supplier_requests", {
  /**
   * I5 — one supplier request → one code.
   *
   * The request id as PRIMARY KEY: the supplier's answer is a pure function of
   * it. Checked before any key is touched:
   *
   *   SELECT code FROM supplier_requests WHERE request_id = $1;
   *   -- 1 row  => return that code unchanged, however many times we are asked.
   *   -- 0 rows => first sight of this request; claim a key (see I6) and record
   *   --           the pair here in the same transaction as the claim.
   *
   * Without it, a retry after a timeout issues a second key.
   * (architecture.md §3, I5 and §3.1.)
   */
  requestId: text("request_id").primaryKey(),

  /**
   * Which supplier answered — `a`, or `b` from Phase 3.
   *
   * **Defence in depth**, added by migration 0002 for one specific bug. A and B
   * share one key pool and one ledger table (technical-considerations §3, A4),
   * so the ledger read is narrowed from the primary key alone to the pair:
   *
   *   SELECT code FROM supplier_requests
   *   WHERE request_id = $1 AND provider = $2;
   *   -- 1 row  => THIS supplier has answered this id before; return that same
   *   --           code, however many times it is asked (I5).
   *   -- 0 rows => this supplier has never answered this id. First sight, so
   *   --           claim a key. A probe mis-addressed to the wrong supplier
   *   --           lands here — 0 rows — instead of being answered with A's
   *   --           code to a question that was asked of B.
   *
   * **No DEFAULT.** 0002 backfills the existing rows with `'a'`, the only
   * supplier Phases 1 and 2 had, and drops the default in the next statement.
   * Left in place it would be the silent form of the very bug this column
   * exists to prevent: an insert from B that forgot to say which supplier it
   * was would be recorded as `'a'`, B's own lookups would then miss, and B
   * would claim a second key for a request already answered.
   *
   * No CHECK on the value set, consistent with `issuance_attempts.provider` —
   * the ladder owns that list and should not have to alter a constraint to
   * extend it (technical-considerations §3, "Rejected").
   */
  provider: text("provider").notNull(),

  /** The code this request was answered with. Written once, never updated. */
  code: text("code").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * `supplier_behaviour` — how badly each supplier is behaving right now.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A TABLE AND NOT A MODULE-LEVEL VARIABLE
 * ---------------------------------------------------------------------------
 * Spec 003 technical-considerations §7, assumption A6, states it directly and
 * it is the whole reason this row exists in Postgres rather than in a `let`:
 *
 *   > Behaviour lives in a `supplier_behaviour` table, not in process memory —
 *   > `pnpm race` runs four separate processes and a deployment runs N
 *   > instances, so an in-process rate reaches none of the others.
 *
 * A reviewer who sets a failure rate over HTTP hits one process. With the rate
 * in that process's memory, the other three carry on succeeding, the check that
 * was supposed to observe a refusal observes a normal purchase, and it passes
 * having exercised nothing. That failure is silent — a green check — which is
 * the worst kind this project can produce, because the whole point of the race
 * scripts is that they are evidence rather than decoration.
 *
 * The same argument is why the one-shot counters below are decremented by a
 * conditional UPDATE and not read-then-written: see `fail_next`/`hang_next`.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE SUPPLIER'S STATE, NOT THE SHOP'S
 * ---------------------------------------------------------------------------
 * It lives in this file, under the supplier prefix, next to the key pool and
 * the ledger, and shop code may not read it — for the reason the header of this
 * module gives. The shop is supposed to *discover* that a supplier is refusing
 * or silent by being refused or kept waiting across an HTTP boundary it
 * distrusts. A shop module that read this table would know in advance, and
 * every Phase 3 demonstration built on that knowledge would be theatre.
 *
 * ---------------------------------------------------------------------------
 * RATES ARE FOR A HUMAN; THE ONE-SHOT COUNTERS ARE FOR THE CHECKS
 * ---------------------------------------------------------------------------
 * ##########################################################################
 * # IF YOU ARE WRITING AN AUTOMATED CHECK, USE `fail_next` / `hang_next`
 * # AND RATES OF EXACTLY 0 OR 1. NEVER A FRACTIONAL RATE.
 * ##########################################################################
 *
 * Functional spec §2.7's fifth criterion is *"the reviewer runs the checks
 * twice in a row and the second run behaves the same as the first"*. A
 * fractional rate makes that untrue **by construction** — not flaky because of
 * a bug, but unreproducible because a coin is being tossed — and the resulting
 * intermittent red reads to a reviewer as a correctness defect in the shop
 * (technical-considerations §11, R8).
 *
 * So the two mechanisms have two different audiences and they do not overlap:
 *
 *   - `failure_rate` / `hang_rate` are the **reviewer's manual exploration**.
 *     "Make it fail about half the time and let me watch." Probabilistic on
 *     purpose, because that is what the question means.
 *   - `fail_next` / `hang_next` are the **automated checks**. "Fail exactly the
 *     next call, then behave." Deterministic, consumed exactly once, and safe
 *     when four processes are asking at the same instant.
 */
export const supplierBehaviour = pgTable(
  "supplier_behaviour",
  {
    /**
     * `a` | `b` — the primary key, and therefore one row per supplier forever.
     *
     * No CHECK on the value set, consistently with `supplier_requests.provider`
     * and `issuance_attempts.provider`: the retry ladder owns the list of
     * suppliers and should not have to alter a constraint in order to extend
     * itself. What bounds the set in practice is that `../seed.ts` inserts
     * exactly the rows in `../fixtures/supplier-behaviour.ts`, and the control
     * endpoint's `UPDATE … WHERE provider = $1` matches nothing for anything
     * else — a `404` for a provider that does not exist, decided by zero
     * returned rows rather than by a list in application code.
     */
    provider: text("provider").primaryKey(),

    /**
     * Probability in `[0.000, 1.000]` that a call is refused outright.
     *
     * `numeric(4, 3)`, not `real`: a rate is a decision input a human typed and
     * a check may compare against, and binary floating point cannot represent
     * `0.1` exactly. `4, 3` holds three decimal places and one digit before the
     * point, so `1.000` fits and `10.000` cannot be stored at all.
     *
     * Read back as a JavaScript `number` (`mode: "number"`) rather than the
     * string `pg` hands over for `numeric`, because every consumer of this value
     * compares it against `Math.random()`. The rounding that `scale: 3` applies
     * is visible rather than silent: the control endpoint answers with the row
     * it stored, so a reviewer who sends `0.12345` is shown `0.123`.
     */
    failureRate: numeric("failure_rate", { precision: 4, scale: 3, mode: "number" }).notNull(),

    /** Probability in `[0.000, 1.000]` that a call is kept waiting instead. See {@link failureRate}. */
    hangRate: numeric("hang_rate", { precision: 4, scale: 3, mode: "number" }).notNull(),

    /**
     * How long a hang lasts, in milliseconds.
     *
     * Half of what decides whether a hang demonstrates anything — the other
     * half is {@link hangBeforeClaim}, and neither works without the other.
     * The inequality this has to satisfy therefore depends on which scenario is
     * being staged (technical-considerations §7.1, R1; corrected in three files
     * that had it backwards):
     *
     *   after the claim  (the trap)  `SUPPLIER_TIMEOUT_MS < hang_ms < ceiling`
     *   before the claim (slow)      `hang_ms < SUPPLIER_TIMEOUT_MS`
     *
     * A hang shorter than the shop's `SUPPLIER_TIMEOUT_MS` produces no timeout
     * at all, so pairing a short one with the trap's placement springs nothing;
     * a long one before the claim is a request that genuinely has no answer.
     * The column takes whatever it is given either way, because both scenarios
     * are legitimate and they are different checks.
     */
    hangMs: integer("hang_ms").notNull(),

    /**
     * **One-shot refusals.** Affects the next N calls to this supplier, then
     * stops — each call that consumes one decrements it.
     *
     * The reason this is a counter in a row rather than a boolean in a process
     * is the same as the table's, with one extra edge: two `/issue` calls
     * arriving at the same instant, in two different processes, must not both
     * consume the same one-shot. So it is spent by an **atomic conditional
     * UPDATE**, in the shape invariant I7 uses (`architecture.md` §3.1) —
     * exactly the read-free pattern the rest of this codebase decides things
     * with:
     *
     *   UPDATE supplier_behaviour
     *   SET fail_next = fail_next - 1, updated_at = now()
     *   WHERE provider = $1 AND fail_next > 0
     *   RETURNING fail_next;
     *   -- 1 row  => THIS call consumes the one-shot and refuses. Nobody else
     *   --           can also have consumed it: the decrement and the test are
     *   --           one statement, so there is no window between them.
     *   -- 0 rows => none left (or no such provider). Fall back to
     *   --           `failure_rate`. NOT an error.
     *
     * A `SELECT … ; if (n > 0) UPDATE …` would pass every single-process test
     * and hand the same one-shot to two of the four processes `pnpm race`
     * starts — which is precisely the class of bug this whole project exists to
     * demonstrate the absence of.
     */
    failNext: integer("fail_next").notNull(),

    /**
     * **One-shot hangs.** Identical mechanism to {@link failNext}, and the
     * statement the spec quotes verbatim (technical-considerations §7):
     *
     *   UPDATE supplier_behaviour
     *   SET hang_next = hang_next - 1, updated_at = now()
     *   WHERE provider = $1 AND hang_next > 0
     *   RETURNING hang_ms;
     *   -- 1 row  => THIS call consumes the one-shot and hangs, for the
     *   --           `hang_ms` the same row carries — read in the same
     *   --           statement that spent the counter, so a concurrent write to
     *   --           `hang_ms` cannot land between the two.
     *   -- 0 rows => none left; fall back to `hang_rate`.
     */
    hangNext: integer("hang_next").notNull(),

    /**
     * **Where an injected hang sits relative to the key claim.** `false` — the
     * baseline — means *after the claim commits*.
     *
     * The whole of the timeout trap is in this one flag, because a hang has two
     * honest placements and they demonstrate opposite things (architecture.md
     * §5; spec 003 technical-considerations §7.1). A single hang point cannot
     * produce both:
     *
     *   false — AFTER the claim transaction commits. A key is genuinely issued,
     *           the ledger holds a code for this `request_id`, and the shop's
     *           client gives up before hearing about it. Pair with
     *           `SUPPLIER_TIMEOUT_MS < hang_ms < function ceiling`. This is the
     *           trap the phase exists to demonstrate, and what makes it a trap
     *           rather than a slow call is that a re-probe on the same id has
     *           something to find.
     *   true  — BEFORE the claim. Nothing has been claimed while the wait runs.
     *           Pair with `hang_ms < SUPPLIER_TIMEOUT_MS` and it is the *slow
     *           but successful* scenario: a slow supplier is not a failed one,
     *           and the call completes normally.
     *
     * **A boolean rather than a `hang_at` enum**, and the reason is what an enum
     * would invite. There are exactly two places a hang may go, because the key
     * claim and its ledger write are one transaction: before it, or after it.
     * The only third value anybody would ever reach for is *inside* it — which
     * holds the instance's single pooled connection for the whole of `hang_ms`
     * and stalls every other request in that process (`packages/db/src/client.ts`,
     * `max: 1`). A two-valued column cannot express the one placement that must
     * never exist; an enum would offer it a name.
     *
     * **`false` is the baseline, and the polarity is not arbitrary.** The
     * control endpoint replaces the whole row, so an omitted field takes the
     * seeded value — and a reviewer arming a bare `hang_next` almost certainly
     * wants the trap, since that is the scenario this phase exists for. Naming
     * the column for the *exceptional* placement is what makes the common one
     * fall out of the zero, exactly as `fail_next = 0` is "no refusals armed".
     * A `hang_after_claim` column would have had to default to `true`, i.e. a
     * baseline row that is not all-zero, which `../fixtures/supplier-behaviour.ts`
     * argues against at length.
     *
     * **No DEFAULT on the column**, consistently with the other five: migration
     * 0004 adds it `DEFAULT false` to backfill the two seeded rows and drops the
     * default in the next statement, for the reason 0002 gives about
     * `supplier_requests.provider`. Every value in this table is one somebody
     * wrote on purpose.
     */
    hangBeforeClaim: boolean("hang_before_claim").notNull(),

    /** When the knobs were last moved. Stamped by the database's clock, never Node's. */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // ---------------------------------------------------------------------
    // The rates are probabilities, and the database says so.
    //
    //   CONSTRAINT supplier_behaviour_failure_rate_range
    //     CHECK ("failure_rate" >= 0 AND "failure_rate" <= 1)
    //   CONSTRAINT supplier_behaviour_hang_rate_range
    //     CHECK ("hang_rate" >= 0 AND "hang_rate" <= 1)
    //
    // The control endpoint REFUSES an out-of-range rate rather than clamping
    // it — a clamp silently hands the reviewer a shop that behaves differently
    // from the one they asked for, which is the same class of dishonesty as a
    // green check that exercised nothing. These two constraints are that same
    // refusal at the layer that still holds when TypeScript is bypassed: a
    // `psql` session, a seed, a future service in another language. Same
    // reasoning as `issuance_attempts_attempt_positive` (migration 0002).
    //
    //   23514 check_violation
    //   new row for relation "supplier_behaviour" violates check constraint
    //     "supplier_behaviour_failure_rate_range"
    // ---------------------------------------------------------------------
    check("supplier_behaviour_failure_rate_range", sql`"failure_rate" >= 0 AND "failure_rate" <= 1`),
    check("supplier_behaviour_hang_rate_range", sql`"hang_rate" >= 0 AND "hang_rate" <= 1`),

    // ---------------------------------------------------------------------
    // A duration cannot be negative, and a one-shot counter cannot go below
    // zero.
    //
    //   CONSTRAINT supplier_behaviour_hang_ms_nonnegative CHECK ("hang_ms" >= 0)
    //   CONSTRAINT supplier_behaviour_fail_next_nonnegative CHECK ("fail_next" >= 0)
    //   CONSTRAINT supplier_behaviour_hang_next_nonnegative CHECK ("hang_next" >= 0)
    //
    // The counters' constraint is doing more than restating the obvious: it is
    // the backstop under the conditional decrement. `SET fail_next =
    // fail_next - 1 WHERE fail_next > 0` cannot drive the column negative, and
    // this CHECK is what turns "cannot" into "provably does not" — if a future
    // decrement ever loses its `> 0` guard, the first over-spend raises 23514
    // instead of quietly arming an unbounded supply of refusals.
    // ---------------------------------------------------------------------
    check("supplier_behaviour_hang_ms_nonnegative", sql`"hang_ms" >= 0`),
    check("supplier_behaviour_fail_next_nonnegative", sql`"fail_next" >= 0`),
    check("supplier_behaviour_hang_next_nonnegative", sql`"hang_next" >= 0`),
  ],
);

export type SupplierKey = typeof supplierKeys.$inferSelect;
export type NewSupplierKey = typeof supplierKeys.$inferInsert;
export type SupplierRequest = typeof supplierRequests.$inferSelect;
export type NewSupplierRequest = typeof supplierRequests.$inferInsert;
export type SupplierBehaviourRow = typeof supplierBehaviour.$inferSelect;
export type NewSupplierBehaviourRow = typeof supplierBehaviour.$inferInsert;
