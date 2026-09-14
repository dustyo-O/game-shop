/**
 * **Zero every promo counter, and say what the counters read now** — one
 * statement, and the whole of spec 005 technical-considerations §2.3's reset
 * affordance. The reason it exists, and the reason local checks must never
 * call it, are the controller's to state (`./promo-codes-reset.controller.ts`);
 * this file owns the statement.
 *
 * ---------------------------------------------------------------------------
 * ONE STATEMENT, NO WHERE, NO TRANSACTION
 * ---------------------------------------------------------------------------
 * `UPDATE promo_codes SET used_count = 0` touches every row, on purpose. The
 * reviewer's check spends two codes (`LIMIT3` ×20, `ONCEONLY` ×10), and the
 * state a second run must start from is "as seeded" — the seed never writes
 * `used_count`, so this is the only statement in the shop that puts a counter
 * back to what a fresh definition holds. A per-code variant would give a
 * script two calls to make and a half-reset state to reason about; the whole
 * table is four rows.
 *
 * One statement is one snapshot, so there is nothing for a transaction to make
 * consistent, and holding this instance's single pooled connection (`max: 1`)
 * across the mapping below would buy nothing — `UndeliveredOrdersService`'s
 * argument, unchanged.
 *
 * ###########################################################################
 * # THE COUNTER GOES TO ZERO. THE LEDGER STAYS. THEY NOW DISAGREE, BY DESIGN.
 * ###########################################################################
 *
 * `promo_redemptions` is not in this file. Every row a paid order wrote there
 * — which code, at what list price, for how much off — survives the reset,
 * and `promo_codes.used_count` no longer equals `count(*)` of the ledger
 * grouped by `promo_id`, which everywhere else in the shop is an invariant
 * (`packages/db/src/schema/promo.ts`, header). After a reset the ledger keeps
 * the true history and the counter means *uses since the last reset*; the
 * controller's header says why that is the right trade and who is allowed to
 * make it. The baseline assertion in the test harnesses
 * (`apps/api/test/concurrency/support/db.ts`, `assertBaseline`) is what would
 * catch this endpoint being called locally: `sum(used_count) = 0` with
 * `promo_redemptions > 0` is exactly the disagreement it exists to notice.
 *
 * ---------------------------------------------------------------------------
 * IT CANNOT TRIP THE CHECK, AND IT CANNOT DEADLOCK WITH A REDEMPTION
 * ---------------------------------------------------------------------------
 * `promo_codes_used_count_range` is `used_count >= 0 AND used_count <=
 * max_uses`, and `0` satisfies it for every `max_uses > 0`, which
 * `promo_codes_max_uses_positive` guarantees — so this statement has no
 * failure mode of its own.
 *
 * A reset racing a redemption queues the way redemptions queue with each
 * other: the I7 increment holds its code's row lock until COMMIT, and this
 * UPDATE waits on it when it reaches that row. `promo_codes` is a leaf in the
 * lock graph (schema header — nothing locks anything after it) and a
 * redemption holds exactly one of its rows, so a sweep across all four cannot
 * close a cycle with one. Whichever commits second wins the row: a redemption
 * after the reset leaves `used_count = 1` beside one new ledger row, which is
 * one use *since the reset* — consistent with what the counter now means.
 */
import { Inject, Injectable } from "@nestjs/common";

import { promoCodes, type DatabaseClient } from "@game-shop/db";

import { DATABASE_CLIENT } from "../database/database.module.js";
import type { PromoCodeCounter, PromoCodesResetReport } from "./promo-codes-reset.types.js";

/**
 * One row as the statement returns it, still in the schema's camelCase — the
 * arrangement `UndeliveredOrderRow` has. `id` is here for the sort and goes no
 * further (`./promo-codes-reset.types.ts`, "No `id`").
 */
interface ResetPromoCodeRow {
  readonly id: number;
  readonly code: string;
  readonly maxUses: number;
  readonly usedCount: number;
}

@Injectable()
export class PromoCodesResetService {
  constructor(@Inject(DATABASE_CLIENT) private readonly database: DatabaseClient) {}

  /**
   * Zero every counter and report every code.
   *
   * Emitted SQL (copied from `.toSQL()`; per the project's raw-SQL rule,
   * `architecture.md` §2, "Documentation convention"):
   *
   *   update "promo_codes" set "used_count" = $1
   *   returning "id", "code", "max_uses", "used_count";
   *   -- $1 = 0. Bound, not a literal: there is no partial index on this table
   *   --           for a literal to keep, and the statement's text stays the
   *   --           one every other Drizzle UPDATE in this codebase emits.
   *   -- NO WHERE. Every row, every time — see the header.
   *   -- 4 rows => the four seeded codes, each now reading 0. This is the only
   *   --           count a seeded shop produces.
   *   -- 0 rows => THE TABLE IS EMPTY. Not an error here — the seed has not
   *   --           run on this database, and `{ promo_codes: [] }` is the
   *   --           honest report of that; the reviewer's script is what turns
   *   --           "fewer than four" into a failed run.
   *   -- "used_count" in the RETURNING list is the value AS WRITTEN, never a
   *   --           value read beforehand. The body reports what the statement
   *   --           did, not what it found.
   *
   * ### `RETURNING`, then sorted in memory — not a read-back
   *
   * `UPDATE … RETURNING` guarantees no row order, so the four come back in
   * heap order and the body wants seed order. Two ways to get it: sort the
   * returned rows by `id` here, or follow the UPDATE with `SELECT … ORDER BY
   * id`. **This is the sort**, for one reason that matters and one that does
   * not:
   *
   *   - **The body must describe this statement's work.** A read-back is a
   *     second statement outside any transaction, and between the two a
   *     redemption on another instance can commit — the read-back would then
   *     report `used_count = 1` for a reset that did zero the row, and a
   *     reviewer's script asserting "every counter is 0 after reset" would
   *     fail on a body that was true when written. `RETURNING` reports the
   *     rows exactly as this UPDATE left them, which is the only thing this
   *     endpoint can honestly claim. (A transaction around both would close
   *     that window — and hold the instance's one connection for a second
   *     round trip to answer a question the first already answered.)
   *   - The one that does not matter: it is one round trip instead of two, on
   *     a pool of one. Four rows sorted by an integer is not a cost.
   */
  async resetCounters(): Promise<PromoCodesResetReport> {
    const rows: readonly ResetPromoCodeRow[] = await this.database.db
      .update(promoCodes)
      // A literal zero, not `used_count - used_count` or anything relative:
      // the target state is absolute and does not depend on what the row held.
      .set({ usedCount: 0 })
      .returning({
        id: promoCodes.id,
        code: promoCodes.code,
        maxUses: promoCodes.maxUses,
        usedCount: promoCodes.usedCount,
      });

    // Seed order. `RETURNING` promises nothing about order, and the header
    // says why this is a sort rather than a second statement. `toSorted`, not
    // `sort`: the driver's array is not ours to reorder in place.
    const ordered = rows.toSorted((left, right) => left.id - right.id);

    return { promo_codes: ordered.map((row) => toPromoCodeCounter(row)) };
  }
}

/** Row → wire body. Drops `id`; keeps the three fields a script asserts on. */
function toPromoCodeCounter(row: ResetPromoCodeRow): PromoCodeCounter {
  return {
    code: row.code,
    max_uses: row.maxUses,
    used_count: row.usedCount,
  };
}
