// @layer: e2e
// @spec: 004-storefront-per-the-design
/**
 * Deletes every row a Playwright run could have written, so `apps/api`'s own
 * suites find the seeded baseline (`orders = 0`, `unclaimed = 50`) after this
 * project has run — tech spec §4.2's cleanup paragraph, risk R13, and
 * `tasks.md`'s standing requirement on every slice.
 *
 * ---------------------------------------------------------------------------
 * SOURCE OF TRUTH: `apps/api/test/concurrency/support/db.ts`'s
 * `cleanupTestOrders`. DUPLICATED, NOT IMPORTED.
 * ---------------------------------------------------------------------------
 * The six statements below are copied from that function, not imported from
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
 * (`packages/db/src/schema/shop.ts`): `deliveries` and `issuance_attempts`
 * reference `orders.id` and must be removed first; `payment_events` carries no
 * FK but is cleaned the same way for symmetry; `orders` itself last on the
 * shop side. `supplier_keys` and `supplier_requests` are the supplier's own
 * tables and are addressed by the request ids this run's orders could have
 * minted, never by a join against `orders`.
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
