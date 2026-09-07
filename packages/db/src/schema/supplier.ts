/**
 * Supplier-side schema — **not the shop's tables.**
 *
 * These two tables belong to the simulated key supplier (architecture §2, "Core
 * tables"; technical-considerations §2.2). They are kept in a separate module,
 * with a separate prefix, and are never joined to a shop table, because the
 * separation is a correctness device rather than a matter of tidiness:
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
import { bigint, index, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";

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

  /** The code this request was answered with. Written once, never updated. */
  code: text("code").notNull(),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SupplierKey = typeof supplierKeys.$inferSelect;
export type NewSupplierKey = typeof supplierKeys.$inferInsert;
export type SupplierRequest = typeof supplierRequests.$inferSelect;
export type NewSupplierRequest = typeof supplierRequests.$inferInsert;
