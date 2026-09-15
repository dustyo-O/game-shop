/**
 * The two statements behind `POST /internal/suppliers/keys/drain` and
 * `/restock` — **empty the supplier's key pool under a sentinel, and put
 * exactly those keys back** (spec 006 technical-considerations §2.4, R15).
 *
 * Paired with `./supplier-key-pool.controller.ts` the way
 * `./supplier-behaviour.service.ts` is paired with its controller: the
 * controller owns the route, the guard, the status code, the body validation
 * and the log line, and issues no SQL of its own. The statements, the
 * sentinel's shape and the concurrency argument live here.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SENTINEL IS `drain_<token>_<id>` AND NOT `drain_<token>`
 * ---------------------------------------------------------------------------
 * `supplier_keys.claimed_by_request_id` is UNIQUE (`packages/db/src/schema/supplier.ts`,
 * I6). One token for forty-nine rows would violate it on the second row, so
 * the row's own `id` is appended and every sentinel is distinct by
 * construction. The same UNIQUE index is the backstop under the paragraph
 * below: even if the reasoning there were wrong, a drain and a real claim
 * could not both own one row — the second write would raise `23505` rather
 * than succeed quietly.
 *
 * A real claim's id begins `req_` — `req_{order_id}_{provider}_{attempt}`
 * (`../issuance/issuance-request-id.ts`) — and a sentinel's begins `drain_`.
 * The two prefixes are what `restock`'s `LIKE` keys on, and they are the
 * whole of R15: a statement that can only ever match `drain_…` can never
 * release a key a shopper has been shown.
 *
 * ---------------------------------------------------------------------------
 * ONE STATEMENT EACH, NO TRANSACTION, AND WHY THAT IS ENOUGH
 * ---------------------------------------------------------------------------
 * Each route is a single `UPDATE … RETURNING id`, auto-committed. Postgres
 * runs it as one atomic operation under the instance's single connection
 * (`packages/db/src/client.ts`, `max: 1`), so there is no read-then-write
 * window for a concurrent claim to land in and nothing for a transaction to
 * add. The count each route reports is the size of the `RETURNING` set of
 * the statement that did the work — never a `count(*)` read beforehand.
 */
import { Inject, Injectable } from "@nestjs/common";
import { isNull, sql } from "drizzle-orm";

import { supplierKeys, type DatabaseClient } from "@game-shop/db";

import { DATABASE_CLIENT } from "../database/database.module.js";

@Injectable()
export class SupplierKeyPoolService {
  constructor(@Inject(DATABASE_CLIENT) private readonly database: DatabaseClient) {}

  /**
   * Claim every currently-unclaimed key under this run's sentinel. Returns how
   * many it took; `0` means the pool was already empty and is not an error.
   *
   * Emitted SQL — read back from the builder's `.toSQL()` against drizzle-orm
   * 0.45.2, so this is the text the driver sends, not a paraphrase.
   * Technical-considerations §2.4 writes the same statement unquoted:
   *
   *   update "supplier_keys"
   *   set "claimed_by_request_id" = 'drain_' || $1 || '_' || "supplier_keys"."id"::text,
   *       "claimed_at" = now()
   *   where "supplier_keys"."claimed_by_request_id" is null
   *   returning "id"
   *   -- $1 = the run token, e.g. '4f0c…'
   *   -- N rows => these N keys are now held by this run; the pool reads
   *   --           empty to every real claim until `restock` with this token.
   *   -- 0 rows => the pool was already empty. NOT an error: the caller gets
   *   --           its token back and `claimed: 0`, and a restock with that
   *   --           token releases exactly nothing.
   *
   * ### Concurrent with a real claim
   *
   * A real claim (`./supplier-key-claim.service.ts`, `claimAndRecord`) locks
   * one unclaimed row with `FOR UPDATE SKIP LOCKED` inside its transaction
   * and then updates it. The two statements can overlap in either order and
   * neither side double-claims:
   *
   *   - **The drain reached a row first.** The drain's `UPDATE` holds a row
   *     lock on every row it has written until its own commit. The claim's
   *     subquery *skips* locked rows — that is what `SKIP LOCKED` is for — so
   *     it never waits on the drain and never picks a row the drain holds.
   *     If the drain already took every row, the subquery finds nothing and
   *     the supplier answers `out_of_stock`, which is exactly the state this
   *     route exists to produce.
   *   - **The claim reached a row first.** The drain's scan arrives at the
   *     row the claim's transaction has locked and **waits** on it (a plain
   *     `UPDATE` queues; it has no `SKIP LOCKED`). When the claim commits,
   *     `READ COMMITTED` re-evaluates the drain's `WHERE` against the row's
   *     new version — `claimed_by_request_id` is now `req_…`, `IS NULL` is
   *     false — and the drain leaves it alone. If the claim rolls back, the
   *     row is still `NULL` and the drain takes it, which is correct too.
   *
   * So the two writers partition the pool between them, and the UNIQUE index
   * on `claimed_by_request_id` stands underneath in case they somehow did
   * not: a second claim on one row raises `23505` instead of succeeding.
   */
  async drain(token: string): Promise<number> {
    const claimed = await this.database.db
      .update(supplierKeys)
      .set({
        // `${supplierKeys.id}` is the column reference, so the row's own id
        // is part of the sentinel and every sentinel is distinct (UNIQUE).
        claimedByRequestId: sql`'drain_' || ${token} || '_' || ${supplierKeys.id}::text`,
        claimedAt: sql`now()`,
      })
      .where(isNull(supplierKeys.claimedByRequestId))
      .returning({ id: supplierKeys.id });

    return claimed.length;
  }

  /**
   * Release the sentinel claims — this run's when `token` is given, every
   * drain's when it is not. Returns how many rows it released.
   *
   * Emitted SQL — read back from the builder's `.toSQL()` against drizzle-orm
   * 0.45.2, so this is the text the driver sends. With a token
   * (technical-considerations §2.4 writes the same statement unquoted):
   *
   *   update "supplier_keys"
   *   set "claimed_by_request_id" = null, "claimed_at" = null
   *   where "supplier_keys"."claimed_by_request_id" like 'drain\_' || $1 || '\_%'
   *   returning "id"
   *   -- $1 = the run token
   *
   * and without one (no parameters at all):
   *
   *   update "supplier_keys"
   *   set "claimed_by_request_id" = null, "claimed_at" = null
   *   where "supplier_keys"."claimed_by_request_id" like 'drain\_%'
   *   returning "id"
   *
   *   -- N rows => these N keys are unclaimed again and the next real claim
   *   --           can take them.
   *   -- 0 rows => nothing was held under that sentinel (or any sentinel).
   *   --           NOT an error: a restock after a drain that claimed 0, or
   *   --           a second restock with the same token, releases 0.
   *
   * `null` is spelled `sql\`null\`` in the builder rather than passed as the
   * JavaScript `null`, because Drizzle binds a JavaScript `null` as a
   * parameter (`= $1` with `$1 = null`) and the statement would then read
   * differently from the one the spec quotes, with the token shifted to `$3`.
   * The meaning is identical; the text is what a reader compares against
   * `log_statement = 'all'`.
   *
   * ### `'drain\_'` — the backslash is a literal-underscore escape, and it is
   * ### the whole of R15
   *
   * In a `LIKE` pattern `_` matches any single character and `%` any run of
   * characters; `\` is the default escape, so `\_` matches one literal
   * underscore. Written `'drain_'`, the pattern would also match `drainX…`;
   * written `'drain\_'` it matches only a value that begins with the six
   * characters `drain_` — which is the sentinel's prefix and nobody else's.
   *
   * A real claim begins `req_` (`../issuance/issuance-request-id.ts`), so no
   * real claim's id starts with `drain_` and no value of `$1` can make the
   * pattern reach one: the token is appended *after* the fixed prefix, and
   * the controller refuses any token containing `_` or `%`, so the token
   * cannot widen the match even inside the sentinel namespace. The
   * acceptance test's RED for this route is exactly the widening R15 names —
   * `WHERE claimed_by_request_id IS NOT NULL` — under which a delivered
   * order's key is released and resold.
   *
   * Under the default `standard_conforming_strings = on` a backslash inside a
   * single-quoted literal is an ordinary character, so `'drain\_'` reaches
   * `LIKE` as the five characters `drain\_` and `LIKE` does the escaping.
   * The TypeScript source spells it `\\_`, because a template literal would
   * otherwise swallow the backslash before Drizzle ever saw it.
   *
   * ### Concurrent with a real claim
   *
   * There is nothing to race. A real claim's subquery reads only rows `WHERE
   * claimed_by_request_id IS NULL`; every row this statement touches holds a
   * `drain_…` value, so no claim can be looking at one. Once this commits the
   * rows are `NULL` and the next claim takes them in `id` order, as the seed
   * intended.
   */
  async restock(token: string | undefined): Promise<number> {
    const pattern =
      token === undefined
        ? sql`${supplierKeys.claimedByRequestId} like 'drain\\_%'`
        : sql`${supplierKeys.claimedByRequestId} like 'drain\\_' || ${token} || '\\_%'`;

    const released = await this.database.db
      .update(supplierKeys)
      .set({ claimedByRequestId: sql`null`, claimedAt: sql`null` })
      .where(pattern)
      .returning({ id: supplierKeys.id });

    return released.length;
  }
}
