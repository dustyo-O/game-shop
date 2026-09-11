/**
 * `issuance_attempts` as the retry ladder sees it — **the ledger read, and the
 * reservation write, both bound to a caller's open transaction.**
 *
 * ---------------------------------------------------------------------------
 * WHY `readWithin` TAKES A `Transaction` AND HAS NO POOLED OVERLOAD (R4)
 * ---------------------------------------------------------------------------
 * This is the same signature argument `../orders/order-lock.service.ts` makes
 * for `lockOrder`, and it is made here for a different — and sharper — reason.
 *
 * `lockOrder` needs a transaction because a row lock that is not held until
 * `COMMIT` is not a lock. `readWithin` needs one because of what the caller
 * does with the answer. Spec 003 §6 draws transaction A with three statements
 * and names the middle one:
 *
 *     BEGIN;
 *       (1) SELECT … FROM orders WHERE id = $1 FOR UPDATE          -- the lock
 *       (2) SELECT … FROM issuance_attempts WHERE order_id = $1    -- THIS READ
 *       (3) UPDATE orders SET status='delivering' WHERE …          -- the claim
 *     COMMIT;
 *
 *   > (2) is a **read-then-act** with nothing else protecting it.
 *
 * Every other decision in this codebase is taken by Postgres inside a guarded
 * statement — `ON CONFLICT`, `WHERE status = ANY($3)`, `used_count < max_uses`.
 * The ladder is the one decision that genuinely cannot be: "which supplier is
 * next" is a function of a *set* of rows, and no single statement evaluates it.
 * So the exclusion has to come from somewhere else, and the only thing
 * available is the order row lock taken one statement earlier.
 *
 * **What goes wrong without it, precisely.** Two workers reading *different*
 * snapshots compute *different* rungs. One reads `[a/1 failed]` and computes
 * `fallThrough → b/2`; the other reads `[a/1 failed, b/2 unknown]` and computes
 * something else. Two genuinely different questions are asked while an attempt
 * is outstanding. The supplier's ledger (I5) cannot help — it is keyed on
 * `request_id`, and these are two of them — so **two keys leave
 * `supplier_keys`.** `deliveries_order_id_key` (I3) still keeps the *shopper*
 * to one key, so the shop looks correct from outside; what breaks is stock
 * accounting, and `count(*) FROM supplier_keys WHERE claimed_by_request_id IS
 * NOT NULL` against `count(*) FROM deliveries` is the only assertion that can
 * see it (spec 003 R2).
 *
 * Two workers reading the *same* snapshot are fine, and it is worth being
 * honest that this is the common case: they compute the same rung, derive the
 * same id, and I5 answers both with one code. The lock is not defending the
 * ordinary path; it is defending the one where the snapshots differ. In the
 * phrasing `order-lock.service.ts` already uses: **the lock serialises the
 * workers; the ladder's `unknown` guard decides. Both, or neither is enough.**
 *
 * So there is no `read(orderId)` on this class. Not a convention — the type
 * system refusing to compile the refactor that "moves the query up for
 * clarity", which is exactly how R4 says the mistake arrives.
 */
import { Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";

import { OrderStatus } from "@game-shop/contracts";
import { issuanceAttempts, orders, type IssuanceAttempt, type Transaction } from "@game-shop/db";

import { IssuanceAttemptStatus } from "./issuance-attempt-status.js";
import type { IssuanceAsk } from "./issuance-ladder.js";

/**
 * The number written to `probe_count` when a row is born: **one ask.**
 *
 * A literal rather than `default`: migration 0002 dropped the column's default
 * on purpose, so passing `default` here raises `23502`
 * (`packages/db/src/schema/shop.ts`). The row exists because we are about to
 * ask, so 1 is always the right first value — it is now stated rather than
 * assumed. Slice 3's re-probe increments it; nothing here does.
 */
const FIRST_PROBE_COUNT = 1;

/**
 * The columns the reservation writes, **taken from the schema objects rather
 * than typed as strings.**
 *
 * `column.name` is the column's real name as `packages/db` declares it, so
 * renaming one in the schema changes this statement with it. That matters
 * because the statement below is a raw template — see {@link
 * IssuanceHistory.reserveWithin} for why the query builder cannot express it —
 * and a raw template is exactly where a renamed column would otherwise fail at
 * runtime, on a paid order, at the first fall-through.
 */
const RESERVED_COLUMNS = [
  issuanceAttempts.requestId,
  issuanceAttempts.orderId,
  issuanceAttempts.provider,
  issuanceAttempts.attempt,
  issuanceAttempts.status,
  issuanceAttempts.probeCount,
] as const;

/** How the guarded reservation ended. Three outcomes, and two of them are one row count. */
export const ReserveAttemptOutcome = {
  /** **This call reserved the attempt.** The row exists and says `unknown`. */
  Reserved: "reserved",

  /**
   * Zero rows, **and the order is still `delivering`** — so this `request_id`
   * was already on file, from an abandoned run of this same rung. Not an error
   * and not a reason to stop: the row this statement exists to guarantee is
   * already there, and asking the supplier again with the same id is what I5
   * makes safe.
   */
  AlreadyReserved: "already_reserved",

  /**
   * Zero rows **because the order is no longer `delivering`** — somebody else
   * finished it while we were talking to the previous supplier. Stop. Asking
   * another supplier now would obtain a second key for an order that has
   * already stopped moving.
   */
  OrderNotDelivering: "order_not_delivering",
} as const;

export type ReserveAttemptOutcome =
  (typeof ReserveAttemptOutcome)[keyof typeof ReserveAttemptOutcome];

export interface ReserveAttemptResult {
  readonly outcome: ReserveAttemptOutcome;
  /** What the order read on the follow-up SELECT, when one ran. Advisory, for the log line. */
  readonly observedStatus: string | undefined;
}

@Injectable()
export class IssuanceHistory {
  /**
   * Every attempt row for one order — **the ladder's input**, read inside the
   * caller's transaction and therefore under the order row lock the caller took
   * one statement earlier.
   *
   * Emitted SQL (copied from `.toSQL()`; per the project's raw-SQL rule,
   * `architecture.md` §2, "Documentation convention"):
   *
   *   select "id", "request_id", "order_id", "provider", "attempt", "status",
   *          "probe_count", "code", "last_error", "created_at"
   *   from "issuance_attempts" where "issuance_attempts"."order_id" = $1
   *   order by "issuance_attempts"."attempt" desc;
   *   -- Index Scan Backward using issuance_attempts_order_id_attempt_key —
   *   -- the UNIQUE (order_id, attempt) constraint migration 0002 added serves
   *   -- this read, which is why 0002 could drop issuance_attempts_order_id_idx.
   *   -- 0 rows => this order has never been offered to a supplier. The ladder
   *   --           reads that as `askFirst`; it is not an error and not a
   *   --           missing row.
   *
   * ### Two things that are deliberately not here
   *
   *   - **No `LIMIT`.** The ladder is a function of *every* attempt, not of the
   *     newest one. §1.1's rule is "no attempt for this order is `unknown`", and
   *     a `LIMIT 1` would answer a different question that happens to agree most
   *     of the time. The row count is bounded by the ladder's length anyway.
   *   - **No filter on `status`.** Same reason: the guard needs to see the
   *     outstanding rows, which are exactly the ones a "only the settled ones"
   *     filter would hide.
   *
   * `ORDER BY attempt DESC` is a convenience for reading logs, not a contract:
   * `nextIssuanceStep` computes `max(attempt)` from the set rather than trusting
   * position 0, so a caller cannot be broken by this clause changing.
   */
  async readWithin(tx: Transaction, orderId: string): Promise<readonly IssuanceAttempt[]> {
    return tx
      .select()
      .from(issuanceAttempts)
      .where(eq(issuanceAttempts.orderId, orderId))
      .orderBy(desc(issuanceAttempts.attempt));
  }

  /**
   * §6's transaction A step (4) and transaction A′ — **write down that we are
   * about to ask, and refuse to write it if the order has stopped being ours.**
   *
   * Emitted SQL (rendered through the dialect; the column names come from the
   * schema objects, see {@link RESERVED_COLUMNS}):
   *
   *   insert into "issuance_attempts"
   *     ("request_id", "order_id", "provider", "attempt", "status", "probe_count")
   *   select $1, "orders"."id", $2, $3, $4, $5
   *   from "orders"
   *   where ("orders"."id" = $6 and "orders"."status" = $7)
   *   on conflict ("request_id") do nothing
   *   returning "request_id";
   *   -- $4 = 'unknown' — always. A row is never born in any other state.
   *   -- $5 = 1         — one ask. Passed, never defaulted: 0002 dropped the
   *   --                  column default so a caller that forgot takes a 23502.
   *   -- $7 = 'delivering'
   *   -- 1 row  => attempt $3 is reserved and the order is still ours to work on.
   *   -- 0 rows => TWO DIFFERENT THINGS, NOT TO BE CONFLATED: either the order
   *   --           left `delivering` while we talked to the previous supplier
   *   --           (someone finished it — stop), or this request_id was already
   *   --           reserved by an abandoned run (carry on and re-ask). The
   *   --           follow-up SELECT below tells them apart, and runs only here.
   *
   * ### Why the guard is in the `INSERT`, not an `if` above it
   *
   * On the fall-through path there is no order transition to guard with — the
   * order is already `delivering` and stays `delivering` across the whole ladder
   * walk. So the guard moves into the insert, exactly as
   * `../orders/order-lock.service.ts` describes for its own returned row: under
   * the lock a check-then-act would in fact be *safe*, and this codebase still
   * does not write one. `architecture.md` §3's governing principle is that the
   * decision is evaluated by Postgres against the row, and that principle does
   * not get an exception for the paths where it happens to be unnecessary.
   *
   * ### Why this is a raw template rather than the query builder
   *
   * `db.insert(t).select(qb)` in drizzle-orm 0.45 requires the selected fields
   * to match **every** column of the target table, in schema order — measured,
   * it raises *"Insert select error: selected fields are not the same or are in
   * a different order compared to the table definition"* and, when forced,
   * emits an insert column list containing `"id"`, which is
   * `GENERATED ALWAYS AS IDENTITY` and cannot be written to. The builder cannot
   * express a partial-column `INSERT … SELECT` against this table, so the
   * statement is written out and the identifiers are still taken from the
   * schema so they cannot drift.
   *
   * ### The follow-up read, which runs on the zero-row path only
   *
   *   select "status" from "orders" where "orders"."id" = $1;
   *   -- 'delivering' => the request_id was already reserved. Carry on.
   *   -- anything else, or 0 rows => the order stopped moving. Stop.
   *
   * It is a read-then-act and it is safe, because the caller holds the order row
   * lock for the whole of this transaction: nothing can move the order between
   * the insert above and this read. Outside that lock it would be a guess.
   */
  async reserveWithin(
    tx: Transaction,
    orderId: string,
    ask: IssuanceAsk,
  ): Promise<ReserveAttemptResult> {
    const columnList = sql.join(
      RESERVED_COLUMNS.map((column) => sql.identifier(column.name)),
      sql`, `,
    );

    const reserved = await tx.execute<{ request_id: string }>(sql`
insert into ${issuanceAttempts} (${columnList})
select ${ask.requestId}, ${orders.id}, ${ask.provider}, ${ask.attempt}, ${IssuanceAttemptStatus.Unknown}, ${FIRST_PROBE_COUNT}
from ${orders}
where ${and(eq(orders.id, orderId), eq(orders.status, OrderStatus.Delivering))}
on conflict (${sql.identifier(issuanceAttempts.requestId.name)}) do nothing
returning ${sql.identifier(issuanceAttempts.requestId.name)}`);

    if (reserved.rows.length > 0) {
      return { outcome: ReserveAttemptOutcome.Reserved, observedStatus: OrderStatus.Delivering };
    }

    const [observed] = await tx
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, orderId));

    return {
      outcome:
        observed?.status === OrderStatus.Delivering
          ? ReserveAttemptOutcome.AlreadyReserved
          : ReserveAttemptOutcome.OrderNotDelivering,
      observedStatus: observed?.status,
    };
  }

  /**
   * Record a **definite** refusal against the attempt row — §6's transaction A′,
   * first write.
   *
   * Emitted SQL (copied from `.toSQL()`):
   *
   *   update "issuance_attempts" set "status" = $1, "last_error" = $2
   *   where "issuance_attempts"."request_id" = $3;
   *   -- $1 = 'failed' — DEFINITE. Written only because a contract-shaped error
   *   -- body was parsed by `./supplier.client.ts`; a timeout can never reach
   *   -- this statement, and writing `failed` for one is the exact bug this
   *   -- phase exists to prevent.
   *   -- `request_id` is UNIQUE (issuance_attempts_request_id_key), so this
   *   -- names at most one row and there is nothing to guard against.
   *
   * Inside the caller's transaction, and the caller holds the order row lock —
   * so this write and the rung recomputed from it in the very next statement
   * are one atomic step. A resolve that committed separately would leave a
   * window in which the ledger says `failed` and no worker owns the next rung.
   */
  async resolveRefusedWithin(
    tx: Transaction,
    requestId: string,
    reason: string,
  ): Promise<void> {
    await tx
      .update(issuanceAttempts)
      .set({ status: IssuanceAttemptStatus.Failed, lastError: reason })
      .where(eq(issuanceAttempts.requestId, requestId));
  }
}
