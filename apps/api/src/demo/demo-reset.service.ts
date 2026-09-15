/**
 * **Put the whole demo shop back to what the seed left** — one transaction,
 * twelve statements, in the order spec 006 technical-considerations §2.4
 * writes them. That section's SQL block is the contract; this file emits it
 * verbatim through `tx.execute(sql\`…\`)`, so the text quoted beside each call
 * below *is* the SQL Postgres runs, not a paraphrase of what Drizzle builds.
 * The reason the endpoint exists, and what the promo reset next door refuses
 * to do that this one may, are the controller's to state
 * (`./demo-reset.controller.ts`); this file owns the statements.
 *
 * What it touches: every row a purchase ever creates (`orders`,
 * `deliveries`, `issuance_attempts`, `promo_redemptions`, `payment_events`),
 * the supplier's ledger (`supplier_requests`), and the three pieces of state
 * that a purchase *changes* rather than creates — a promo counter, a key's
 * claim, a supplier's armed behaviour — which go back to their seeded values.
 * What it never touches: `products`, and the 50 `supplier_keys` rows
 * themselves (only the claim on them).
 *
 * ###########################################################################
 * # ONE TRANSACTION, BECAUSE THERE ARE EXACTLY TWO HALF-STATES AND BOTH ARE
 * # FORBIDDEN.
 * ###########################################################################
 *
 * Twelve statements could be twelve autocommits, and between any two of them
 * a request on another instance sees a shop that is neither reset nor whole.
 * Two of those intermediate shops are ones the spec explicitly forbids
 * (functional spec §2.3; technical-considerations §2.4):
 *
 *   - **Orders gone, keys still claimed.** `DELETE FROM orders` committed,
 *     `UPDATE supplier_keys` not yet run: fifty keys of which some are held
 *     by `req_<order>_…` for an order that no longer exists. Nothing in the
 *     shop will ever release them — there is no unclaim on any production
 *     path (`packages/db/src/schema/supplier.ts`) — so the demo has
 *     permanently lost stock and no row explains why.
 *   - **Keys released, deliveries still standing.** The reverse order:
 *     `UPDATE supplier_keys` committed, `DELETE FROM deliveries` not yet run.
 *     A shopper reloading `/order/<id>` sees a key that is, at that instant,
 *     back in the pool and claimable by the next paid order. That is the one
 *     thing invariant I6 exists to make impossible, and a reset that made it
 *     true for even a moment would be a reset that broke the guarantee it is
 *     supposed to restore.
 *
 * Inside one transaction neither shop is ever visible: every other
 * transaction sees the rows as they were before `BEGIN` or as they are after
 * `COMMIT`, and a failure anywhere — a lock timeout, an FK refusal — rolls
 * the whole thing back to the former. There is no partial reset to reason
 * about, only "it happened" or "it did not, and the response says so".
 *
 * Under `max: 1` (`packages/db/src/client.ts`) this transaction holds the
 * instance's only connection for its duration, and the instance does nothing
 * else in the meantime. That is fine here for the reason it is not fine
 * around a supplier call: there is no network I/O inside, the demo database
 * is tens of rows, and the whole thing is sub-second. The one thing that can
 * stretch it is a lock, and `lock_timeout` bounds that.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER LOCK COMES FIRST, BEFORE A SINGLE ROW IS DELETED (R9)
 * ---------------------------------------------------------------------------
 * `SELECT id FROM orders ORDER BY id FOR UPDATE` is the same lock every
 * writer of an order takes first (`../orders/order-lock.service.ts`, the first
 * half of I4): a payment continuation, the inbox drain, the promo redemption,
 * the operator's retry — each opens with `FOR UPDATE` on its one order row.
 * Taking every one of those locks here, before anything is deleted, turns a
 * race into a queue:
 *
 *   - work that is **inside** its transaction finishes first: the reset waits
 *     on that row until the worker commits, then sees the committed rows and
 *     deletes them;
 *   - work that arrives **after** queues behind the reset, and when it gets
 *     the row the row is gone — its `FOR UPDATE` matches nothing, its guarded
 *     `UPDATE` matches nothing, and it reports `order_not_found` exactly as it
 *     would for a webhook naming an order that was never created.
 *
 * Every guard is in the database, so either ordering is consistent. The one
 * straggler R9 names is the worker that was *between* its two transactions,
 * awaiting the supplier, when the reset ran: the supplier may then claim a
 * key as `req_<deleted order>_…` after this transaction released every claim.
 * Its second transaction fails on the missing order and the key stays
 * claimed by nobody's order — a second `POST …/reset` releases it, which is
 * the documented remedy: second run non-zero, third `changed: false`.
 *
 * `ORDER BY id` is deadlock hygiene. Every application transaction holds at
 * most one order lock, so it can never be waiting on the reset while the
 * reset waits on it; ordering the sweep by the primary key costs nothing and
 * makes that argument hold even if some future path locks two.
 *
 * `SET LOCAL lock_timeout = '5s'` is the bound. Every application transaction
 * that holds an order lock is short by construction — the two-transaction
 * bracket around the supplier call exists precisely so no lock is ever held
 * across HTTP — so five seconds is generous for a healthy shop and a firm
 * ceiling for a sick one. A timeout surfaces as SQLSTATE `55P03`, the
 * transaction rolls back, the request fails with a `500`, and nothing has
 * changed; the operator re-runs. It is the only `SET` in the codebase
 * (`client.ts`'s pooler audit), and it is `LOCAL`: transaction-scoped, gone
 * at `COMMIT` or `ROLLBACK` before PgBouncer lends the backend to anyone
 * else. A session-level `SET` here would leak a five-second lock timeout onto
 * whichever request borrows that backend next.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DELETES ARE IN THIS ORDER, AND WHY `payment_events` IS WHOLESALE
 * ---------------------------------------------------------------------------
 * Dependents first, so no statement trips a foreign key: `deliveries`,
 * `issuance_attempts` and `promo_redemptions` each reference `orders.id`, and
 * `promo_redemptions` also references `promo_codes.id` (which survives). Then
 * `orders`. `payment_events` has **no** FK to `orders` by design — that
 * omission is what makes "webhook before its order" a normal path
 * (`packages/db/src/schema/shop.ts`) — so it could go anywhere; it goes with
 * the order rows because the demo is reset wholesale: processed or not, an
 * event about an order that is being deleted is history the demo no longer
 * wants, and a pending one left behind would be worse than a stale row — the
 * processor leaves an event whose order does not exist *pending* on purpose
 * ("order does not exist yet; left pending for a later drain",
 * `../payments/payment-event-processor.service.ts`), so every drain from then
 * on would re-claim it, find no order, and put it back, forever, one row off
 * baseline.
 *
 * The FK is also the reset's own backstop. An order created *and* redeemed
 * on another instance in the milliseconds between `DELETE FROM
 * promo_redemptions` and `DELETE FROM orders` makes the latter refuse
 * (`promo_redemptions_order_id_orders_id_fk`), which rolls back the whole
 * transaction rather than leaving a shop with an order but no ledger row.
 * That is the database refusing the inconsistent ordering, and a re-run is
 * the answer.
 *
 * ---------------------------------------------------------------------------
 * THE THREE RESETS CARRY A `WHERE`, AND THAT IS WHAT MAKES `changed` HONEST
 * ---------------------------------------------------------------------------
 * `UPDATE promo_codes SET used_count = 0` on its own touches four rows every
 * time and reports `4` whether anything moved or not. With `WHERE used_count
 * <> 0` the count means *rows that were not at baseline*, so on a shop that
 * is already reset all three resets report `0`, every `DELETE` reports `0`,
 * and `changed` is `false` by arithmetic over the counts rather than by
 * comparing two snapshots. The same `WHERE` is why a re-run also writes
 * nothing — no row version churn, no `updated_at` bump on a behaviour row
 * nobody armed.
 *
 * The behaviour reset compares a row constructor with `IS DISTINCT FROM` so
 * six columns are one predicate; the values are the seed's baseline
 * (`packages/db/src/fixtures/supplier-behaviour.ts`: every knob off,
 * `hang_before_claim = false`), and the baseline `SELECT` at the end counts
 * rows with `IS NOT DISTINCT FROM` the same tuple — the same comparison, so
 * the `reset` count and `now.supplier_behaviour_baseline` cannot disagree
 * about what "at baseline" means.
 *
 * ---------------------------------------------------------------------------
 * WHY `UPDATE supplier_keys … WHERE claimed_by_request_id IS NOT NULL` IS
 * ALLOWED HERE AND NOWHERE ELSE IN `src/`
 * ---------------------------------------------------------------------------
 * The harness's cleanup releases only the request ids a test derived
 * (`apps/api/test/concurrency/support/db.ts`); task 2's `restock` releases
 * only sentinel `drain_` claims. Both are scoped so a delivered key can never
 * be resold. This statement releases **every** claim and is scoped by
 * something else: it runs inside the transaction that has just deleted every
 * `deliveries` row, so at `COMMIT` there is no delivered order left for a
 * released key to have belonged to. The licence is the seed's — "the loader,
 * not a participant" (`packages/db/src/seed.ts`) — and it is why this lives
 * in `DemoModule` and not in `AdminModule` (`./demo.module.ts`).
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `TRUNCATE`
 * ---------------------------------------------------------------------------
 * `TRUNCATE orders, deliveries, …` is one statement and faster on a big
 * table, and wrong here for three reasons: it takes `ACCESS EXCLUSIVE`, which
 * blocks even plain `SELECT`s on those tables for the transaction's life —
 * every shopper's status poll and every webhook insert on every instance
 * would stall behind it, where row locks stall only writers of the rows
 * being removed; it reports no counts, and the whole body is counts; and it
 * cannot be scoped — it would not wait on an in-flight order's row lock the
 * way `FOR UPDATE` does, it would simply queue behind *every* reader, or
 * demand `CASCADE` and follow FKs it was not told about.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE NUMBERS COME FROM
 * ---------------------------------------------------------------------------
 * `tx.execute()` on the node-postgres driver returns `pg`'s `QueryResult`
 * unchanged (drizzle-orm 0.45.2, `node-postgres/session.d.ts`:
 * `NodePgQueryResultHKT.type = QueryResult<…>`), and `rowCount` is the number
 * out of the command tag Postgres sends at the end of every statement —
 * `DELETE 2`, `UPDATE 1`, `SELECT 12` (`pg` 8.23.0, `lib/result.js`,
 * `addCommandComplete`). It is typed `number | null` because a tag with no
 * count — `SET` — leaves it `null`; {@link rowCountOf} turns that into an
 * error for the statements that must have one, so a driver change that
 * stopped reporting counts fails loudly instead of reporting `0` and
 * `changed: false` over a shop it just emptied.
 */
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";

import type { DatabaseClient, Transaction } from "@game-shop/db";

import { DATABASE_CLIENT } from "../database/database.module.js";
import type { DemoBaseline, DemoResetReport } from "./demo.types.js";

@Injectable()
export class DemoResetService {
  constructor(@Inject(DATABASE_CLIENT) private readonly database: DatabaseClient) {}

  /**
   * The whole reset, as one transaction. `transaction()` emits `BEGIN` before
   * the first statement and `COMMIT` after the last, or `ROLLBACK` if any of
   * them throws (`packages/db/src/client.ts`); the isolation level is the
   * server default, `READ COMMITTED`, which is all the argument in the header
   * needs — consistency comes from the row locks and the single commit, not
   * from `SERIALIZABLE`.
   */
  async reset(): Promise<DemoResetReport> {
    return this.database.transaction(async (tx) => {
      // Every `sql\`…\`` below has no interpolations, so Drizzle emits the
      // template text unchanged with no parameters; the text in each comment
      // is byte-for-byte the statement. Kept as separate `execute` calls, one
      // command each, so every count comes back on its own result.

      //   SET LOCAL lock_timeout = '5s';
      //   -- The only SET in the codebase; LOCAL dies with the transaction
      //   -- (pooler-safe). A literal rather than a bound parameter because
      //   -- SET does not accept one. No row count: `rowCount` is null here,
      //   -- and it is the one result this method does not read.
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);

      //   SELECT id FROM orders ORDER BY id FOR UPDATE;
      //   -- The lock the application takes first: in-flight work finishes or
      //   -- queues (header, R9). Waits — up to lock_timeout — on any order
      //   -- row a worker is holding, then holds every row until COMMIT.
      //   -- n rows => n orders now locked by this transaction.
      //   -- 0 rows => no orders exist; nothing is locked and nothing needs
      //   --           to be. Not an error — the deletes below report 0 too.
      await tx.execute(sql`SELECT id FROM orders ORDER BY id FOR UPDATE`);

      //   DELETE FROM deliveries;
      //   -- dependents first (FK → orders)
      //   -- 0 rows => no order had reached `delivered`. Not an error.
      const deliveries = rowCountOf(await tx.execute(sql`DELETE FROM deliveries`), "DELETE FROM deliveries");

      //   DELETE FROM issuance_attempts;
      //   -- FK → orders. One row per rung the ladder walked.
      //   -- 0 rows => no order was ever paid. Not an error.
      const issuanceAttempts = rowCountOf(
        await tx.execute(sql`DELETE FROM issuance_attempts`),
        "DELETE FROM issuance_attempts",
      );

      //   DELETE FROM promo_redemptions;
      //   -- FK → orders, promo_codes. The ledger goes with the orders whose
      //   -- history it was, in the same transaction that zeroes the counter
      //   -- below — so counter and ledger agree at 0 = 0 by construction
      //   -- (the controller's header says why that is honest here and not
      //   -- in `promo-codes-reset`).
      //   -- 0 rows => no code was applied to any order. Not an error.
      const promoRedemptions = rowCountOf(
        await tx.execute(sql`DELETE FROM promo_redemptions`),
        "DELETE FROM promo_redemptions",
      );

      //   DELETE FROM payment_events;
      //   -- no FK; processed or not — the demo is reset wholesale
      //   -- 0 rows => no payment was ever simulated. Not an error.
      const paymentEvents = rowCountOf(
        await tx.execute(sql`DELETE FROM payment_events`),
        "DELETE FROM payment_events",
      );

      //   DELETE FROM orders;
      //   -- Every row locked above, plus any committed since (READ COMMITTED:
      //   -- the statement sees rows committed before it started; a row
      //   -- still referenced by a dependent inserted in the gap makes this
      //   -- statement refuse, and the whole transaction rolls back — header).
      //   -- 0 rows => the shop had no orders. Not an error.
      const orders = rowCountOf(await tx.execute(sql`DELETE FROM orders`), "DELETE FROM orders");

      //   UPDATE promo_codes SET used_count = 0 WHERE used_count <> 0;
      //   -- The counter half of I7, back to what the seed holds (the seed
      //   -- never writes used_count). WHERE, so the count means "codes that
      //   -- had been used", and a re-run reports 0 and writes nothing.
      //   -- 0 rows => every counter was already 0. Not an error.
      const promoCodes = rowCountOf(
        await tx.execute(sql`UPDATE promo_codes SET used_count = 0 WHERE used_count <> 0`),
        "UPDATE promo_codes",
      );

      //   UPDATE supplier_keys SET claimed_by_request_id = NULL, claimed_at = NULL WHERE claimed_by_request_id IS NOT NULL;
      //   -- Every claim, real or sentinel, released — the one place in `src/`
      //   -- that may, and only because every `deliveries` row is already gone
      //   -- in this same transaction (header). The pool's 50 rows stay.
      //   -- 0 rows => every key was already unclaimed. Not an error.
      const supplierKeys = rowCountOf(
        await tx.execute(
          sql`UPDATE supplier_keys SET claimed_by_request_id = NULL, claimed_at = NULL WHERE claimed_by_request_id IS NOT NULL`,
        ),
        "UPDATE supplier_keys",
      );

      //   DELETE FROM supplier_requests;
      //   -- The supplier's own ledger (`request_id` → the key it handed out).
      //   -- After the release above, so no ledger row ever outlives the claim
      //   -- it explains within this transaction's view — though both are
      //   -- invisible to anyone else until COMMIT either way.
      //   -- 0 rows => the supplier was never asked. Not an error.
      const supplierRequests = rowCountOf(
        await tx.execute(sql`DELETE FROM supplier_requests`),
        "DELETE FROM supplier_requests",
      );

      //   UPDATE supplier_behaviour SET failure_rate = 0, hang_rate = 0, hang_ms = 0, fail_next = 0, hang_next = 0,
      //          hang_before_claim = false, updated_at = now()
      //    WHERE (failure_rate, hang_rate, hang_ms, fail_next, hang_next, hang_before_claim) IS DISTINCT FROM (0, 0, 0, 0, 0, false);
      //   -- The seed's baseline (`fixtures/supplier-behaviour.ts`), every
      //   -- knob off. A row constructor so six columns are one predicate;
      //   -- IS DISTINCT FROM rather than <> so a NULL could never make the
      //   -- row "not different" (the columns are NOT NULL — belt and braces).
      //   -- 0 rows => neither supplier had anything armed. Not an error.
      //   -- 2 rows => both were armed; 1 => one of them.
      const supplierBehaviour = rowCountOf(
        await tx.execute(
          sql`UPDATE supplier_behaviour SET failure_rate = 0, hang_rate = 0, hang_ms = 0, fail_next = 0, hang_next = 0,
       hang_before_claim = false, updated_at = now()
 WHERE (failure_rate, hang_rate, hang_ms, fail_next, hang_next, hang_before_claim) IS DISTINCT FROM (0, 0, 0, 0, 0, false)`,
        ),
        "UPDATE supplier_behaviour",
      );

      const now = await readBaseline(tx);

      const removed = {
        orders,
        deliveries,
        issuance_attempts: issuanceAttempts,
        promo_redemptions: promoRedemptions,
        payment_events: paymentEvents,
        supplier_requests: supplierRequests,
      };
      const reset = {
        promo_codes: promoCodes,
        supplier_keys: supplierKeys,
        supplier_behaviour: supplierBehaviour,
      };

      // Arithmetic over the counts, not a comparison of two snapshots: every
      // statement above reports only rows that were not at baseline (header),
      // so "nothing was non-zero" is exactly "nothing changed".
      const changed = [...Object.values(removed), ...Object.values(reset)].some((count) => count !== 0);

      return { removed, reset, changed, now };
    });
  }
}

/**
 * The baseline `SELECT` — the last statement of the transaction, so it sees
 * every row the statements above removed and nothing another request commits
 * afterwards.
 *
 * Emitted SQL: `readBaselineCounts`'s query
 * (`apps/api/test/concurrency/support/db.ts`) verbatim — lower-case, as that
 * file writes it, so a reviewer diffing the two sees only the added column —
 * plus `supplier_behaviour_baseline`:
 *
 *   select
 *     (select count(*) from products)::int                                              as products,
 *     (select count(*) from supplier_keys)::int                                         as keys_total,
 *     (select count(*) from supplier_keys where claimed_by_request_id is null)::int      as keys_unclaimed,
 *     (select count(*) from orders)::int                                                 as orders,
 *     (select count(*) from payment_events)::int                                         as payment_events,
 *     (select count(*) from deliveries)::int                                             as deliveries,
 *     (select count(*) from issuance_attempts)::int                                      as issuance_attempts,
 *     (select count(*) from supplier_requests)::int                                      as supplier_requests,
 *     (select count(*) from promo_codes)::int                                            as promo_codes,
 *     (select coalesce(sum(used_count), 0) from promo_codes)::int                        as promo_used_count,
 *     (select count(*) from promo_redemptions)::int                                      as promo_redemptions,
 *     (select count(*) from supplier_behaviour
 *        where (failure_rate, hang_rate, hang_ms, fail_next, hang_next, hang_before_claim)
 *              is not distinct from (0, 0, 0, 0, 0, false))::int                          as supplier_behaviour_baseline
 *   -- 1 row, always: twelve scalar subqueries produce one row even over
 *   --        empty tables. `::int` because count(*) is bigint, which `pg`
 *   --        returns as a string; `coalesce(sum(…), 0)` because sum over an
 *   --        empty table is NULL (the harness's reasoning, kept).
 *   -- 0 rows => cannot happen for this shape; treated as an error so a
 *   --        rewritten query that could return none is noticed.
 *
 * `supplier_behaviour_baseline` uses `is not distinct from` against the same
 * tuple the reset's `IS DISTINCT FROM` used, so the two agree by construction
 * on what "at baseline" means: on a seeded shop it reads `2` after the
 * reset, whatever it read before.
 */
async function readBaseline(tx: Transaction): Promise<DemoBaseline> {
  const result = await tx.execute<BaselineRow>(sql`
    select
      (select count(*) from products)::int                                              as products,
      (select count(*) from supplier_keys)::int                                         as keys_total,
      (select count(*) from supplier_keys where claimed_by_request_id is null)::int      as keys_unclaimed,
      (select count(*) from orders)::int                                                 as orders,
      (select count(*) from payment_events)::int                                         as payment_events,
      (select count(*) from deliveries)::int                                             as deliveries,
      (select count(*) from issuance_attempts)::int                                      as issuance_attempts,
      (select count(*) from supplier_requests)::int                                      as supplier_requests,
      (select count(*) from promo_codes)::int                                            as promo_codes,
      (select coalesce(sum(used_count), 0) from promo_codes)::int                        as promo_used_count,
      (select count(*) from promo_redemptions)::int                                      as promo_redemptions,
      (select count(*) from supplier_behaviour
         where (failure_rate, hang_rate, hang_ms, fail_next, hang_next, hang_before_claim)
               is not distinct from (0, 0, 0, 0, 0, false))::int                          as supplier_behaviour_baseline
  `);

  const row = result.rows[0];
  if (row === undefined) throw new Error("demo reset: the baseline query returned no row");

  // Field by field rather than `return row`: the driver's row object carries
  // whatever columns the query named, and spelling the twelve out here is
  // what ties the wire body to `DemoBaseline` at compile time.
  return {
    products: row.products,
    keys_total: row.keys_total,
    keys_unclaimed: row.keys_unclaimed,
    orders: row.orders,
    payment_events: row.payment_events,
    deliveries: row.deliveries,
    issuance_attempts: row.issuance_attempts,
    supplier_requests: row.supplier_requests,
    promo_codes: row.promo_codes,
    promo_used_count: row.promo_used_count,
    promo_redemptions: row.promo_redemptions,
    supplier_behaviour_baseline: row.supplier_behaviour_baseline,
  };
}

/**
 * The baseline row as the driver hands it over — the same twelve fields as
 * {@link DemoBaseline}, spelled as a mapped type because `tx.execute<TRow>`
 * bounds `TRow` by `Record<string, unknown>` and an interface has no index
 * signature to satisfy it with. Every column is `::int`, so every field is a
 * plain `number` (the harness's reasoning, `readBaselineCounts`).
 */
type BaselineRow = { [K in keyof DemoBaseline]: DemoBaseline[K] };

/**
 * The two fields of a driver result this file reads. Structural rather than
 * `pg`'s `QueryResult`, for `../suppliers/supplier-key-claim.service.ts`'s
 * reason: `apps/api` talks to Postgres through Drizzle and does not depend on
 * the driver package — the driver is `packages/db/src/client.ts`'s decision.
 * `tx.execute()`'s return type carries both fields, so this is the driver's
 * shape narrowed to what is relied on, not a second declaration of it.
 */
interface CommandTag {
  /** The number out of the tag (`DELETE 2` → `2`), or `null` for a tag without one (`SET`). */
  readonly rowCount: number | null;
  /** The tag's verb (`DELETE`, `UPDATE`, `SET`), for the error message. */
  readonly command: string;
}

/**
 * The count out of a statement's command tag, for the statements that must
 * have one.
 *
 * `pg` leaves `rowCount` `null` when the tag carries no number (`SET`,
 * `BEGIN`), and every `DELETE` and `UPDATE` above always carries one — so a
 * `null` here means the driver, not the shop, has changed, and the honest
 * answer is to fail the reset rather than report `0` removed over a table
 * that was just emptied. The transaction rolls back with it.
 */
function rowCountOf(result: CommandTag, statement: string): number {
  if (result.rowCount === null) {
    throw new Error(`demo reset: ${statement} reported no row count (command tag "${result.command}")`);
  }

  return result.rowCount;
}
