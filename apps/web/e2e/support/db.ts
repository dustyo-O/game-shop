// @layer: e2e
// @spec: 004-storefront-per-the-design, 005-promo-codes-with-enforced-limits
/**
 * Deletes every row a Playwright run could have written, so `apps/api`'s own
 * suites find the seeded baseline (`orders = 0`, `unclaimed = 50`, and since
 * spec 005 `promo_redemptions = 0` with every `used_count = 0`) after this
 * project has run — tech spec §4.2's cleanup paragraph, risk R13 of both
 * specs, and `tasks.md`'s standing requirement on every slice.
 *
 * ---------------------------------------------------------------------------
 * SOURCE OF TRUTH: `apps/api/test/concurrency/support/db.ts`'s
 * `cleanupTestOrders`. DUPLICATED, NOT IMPORTED.
 * ---------------------------------------------------------------------------
 * The seven statements below are copied from that function, not imported from
 * it: `apps/api/test/concurrency/support/` lives inside `apps/api`'s own test
 * tree, which is not a package this workspace publishes anywhere an `apps/web`
 * dev dependency could reach — importing across it would make this
 * project's tests depend on `apps/api`'s test sources rather than on
 * `@game-shop/db`, the one package the two apps are meant to share. Tech spec
 * §4.2 names the lift to a `@game-shop/db/testing` subpath as "the obvious
 * follow-up now that a second caller exists"; that refactor is out of scope
 * for this slice, which only has to duplicate ~25 lines and say so.
 *
 * Ordered exactly as the source does, to respect the same foreign keys
 * (`packages/db/src/schema/shop.ts` and `promo.ts`): `deliveries`,
 * `issuance_attempts` and `promo_redemptions` reference `orders.id` and must
 * be removed first; `payment_events` carries no FK but is cleaned the same way
 * for symmetry; `orders` itself last on the shop side. `supplier_keys` and
 * `supplier_requests` are the supplier's own tables and are addressed by the
 * request ids this run's orders could have minted, never by a join against
 * `orders`. The promo statement is the one that is not a plain delete — it
 * also hands back the uses those orders spent — and the full reasoning for
 * its shape lives beside the source, not here.
 */
import { createDatabaseClient, type DatabaseClient } from "@game-shop/db";

/** One client for this Playwright run, named so `pg_stat_activity` can tell it apart from the API or the seed. */
export function openE2eDatabase(): DatabaseClient {
  return createDatabaseClient({ applicationName: "game-shop-e2e" });
}

/**
 * Deletes every row `orderIds` could have written, and un-claims the
 * `supplier_keys` those orders' derived request ids claimed.
 *
 * `req_{order}_%`, not one fixed request id: exactly the same reason
 * `cleanupTestOrders` gives — an order can mint more than one request id as
 * it falls through the issuance ladder (`req_{order}_a_1`, `_b_2`, `_a_3`,
 * ...), and cleaning only the first would leave a claimed key behind for any
 * order that fell through.
 */
export async function cleanupOrders(client: DatabaseClient, orderIds: readonly string[]): Promise<void> {
  if (orderIds.length === 0) return;

  const requestIdPatterns = orderIds.map((orderId) => `req_${orderId}_%`);

  // delete from deliveries where order_id = ANY($1::text[])
  await client.pool.query(`delete from deliveries where order_id = ANY($1::text[])`, [orderIds]);

  // delete from issuance_attempts where order_id = ANY($1::text[])
  await client.pool.query(`delete from issuance_attempts where order_id = ANY($1::text[])`, [orderIds]);

  // delete from payment_events where order_id = ANY($1::text[])
  await client.pool.query(`delete from payment_events where order_id = ANY($1::text[])`, [orderIds]);

  // with gone as (
  //   delete from promo_redemptions where order_id = any($1::text[]) returning promo_id
  // ), per_promo as (
  //   select promo_id, count(*)::int as n from gone group by promo_id
  // )
  // update promo_codes p set used_count = p.used_count - per_promo.n
  // from per_promo where p.id = per_promo.promo_id
  //
  // Copied verbatim from `cleanupTestOrders` (spec 005 tech spec §2.5). One
  // statement: this run's ledger rows go, and each code is decremented by
  // exactly the number of rows removed — NOT recomputed from what is left. A
  // global recompute would silently repair any drift between counter and
  // ledger, which is what the API suites' `assertBaseline("after")` exists
  // to catch; a decrement by this run's own count, like the un-claim below,
  // touches only what this run spent. Only a test may decrement `used_count`;
  // production never does. Before `orders` because of the FK.
  await client.pool.query(
    `with gone as (
       delete from promo_redemptions where order_id = any($1::text[]) returning promo_id
     ), per_promo as (
       select promo_id, count(*)::int as n from gone group by promo_id
     )
     update promo_codes p set used_count = p.used_count - per_promo.n
     from per_promo where p.id = per_promo.promo_id`,
    [orderIds],
  );

  // delete from orders where id = ANY($1::text[])
  await client.pool.query(`delete from orders where id = ANY($1::text[])`, [orderIds]);

  // update supplier_keys set claimed_by_request_id = null, claimed_at = null
  //   where claimed_by_request_id like any($1::text[])
  await client.pool.query(
    `update supplier_keys set claimed_by_request_id = null, claimed_at = null
       where claimed_by_request_id like any($1::text[])`,
    [requestIdPatterns],
  );

  // delete from supplier_requests where request_id like any($1::text[])
  await client.pool.query(`delete from supplier_requests where request_id like any($1::text[])`, [requestIdPatterns]);
}
