// @layer: integration
// @spec: 001-purchase-and-key-delivery
/**
 * Direct-to-Postgres helpers for the concurrency proof in
 * `../key-claim-race.test.ts`.
 *
 * Everything here talks to the database with raw SQL over `DatabaseClient.pool`
 * (from `@game-shop/db`) rather than through `apps/api`'s HTTP surface, per
 * `context/product/architecture.md` §7: *"Assertions query the database
 * directly — one delivery row, one claimed key, one promo redemption —
 * because an API response can look correct while the underlying state is
 * wrong."* `docs/walkthrough/slice-4-supplier-idempotency.md` §6 is the
 * concrete precedent: a bug that made the API answer nineteen of twenty
 * concurrent callers with `500` while the database stayed perfectly correct
 * underneath. A test that only reads HTTP responses cannot see that split; a
 * test that only reads the database cannot see it either. This file is the
 * database half.
 */
import { createDatabaseClient, type DatabaseClient } from "@game-shop/db";

/** The one purchasable SKU this test buys — `packages/db/src/fixtures/catalog.ts`. */
export const PURCHASABLE_SKU = "KEY-CS2-PRIME";

const ISSUANCE_PROVIDER = "a";
const FIRST_ISSUANCE_ATTEMPT = 1;

/**
 * `req_{order_id}_{provider}_{attempt}` — reproduced from
 * `apps/api/src/issuance/issuance-request-id.ts` (`deriveIssuanceRequestId`)
 * rather than imported from it.
 *
 * Deliberately not imported: this is a **test-side prediction** of what the
 * application will derive, kept as an independent transcription so the test
 * cannot be made to pass by a bug that changes the derivation in the
 * application and this file's copy in the same edit. The two are compared
 * indirectly — this id is what the test uses to scope its own database
 * cleanup to the keys and ledger rows *this test run* touched, and the
 * cleanup counts are themselves asserted, so a drift between the two
 * derivations would surface as leftover, unrecognised rows rather than as a
 * pass. Deriving it here is pure and total, exactly like the original.
 */
export function deriveTestRequestId(orderId: string): string {
  return `req_${orderId}_${ISSUANCE_PROVIDER}_${String(FIRST_ISSUANCE_ATTEMPT)}`;
}

/** One client per role, named in `pg_stat_activity.application_name` for anyone reading it live during a run. */
export function createTestDatabaseClient(role: string): DatabaseClient {
  return createDatabaseClient({ applicationName: `game-shop-test-${role}` });
}

export interface BaselineCounts {
  readonly products: number;
  readonly keysTotal: number;
  readonly keysUnclaimed: number;
  readonly orders: number;
  readonly paymentEvents: number;
  readonly deliveries: number;
  readonly issuanceAttempts: number;
  readonly supplierRequests: number;
}

/**
 * The whole-database snapshot the completion evidence checks before and after
 * this suite: 12 products, 50 unclaimed keys, and zero of everything this
 * suite (or any purchase) would create.
 *
 *   select
 *     (select count(*) from products)::int,
 *     (select count(*) from supplier_keys)::int,
 *     (select count(*) from supplier_keys where claimed_by_request_id is null)::int,
 *     (select count(*) from orders)::int,
 *     (select count(*) from payment_events)::int,
 *     (select count(*) from deliveries)::int,
 *     (select count(*) from issuance_attempts)::int,
 *     (select count(*) from supplier_requests)::int;
 *
 * Each subselect is cast `::int`: `count(*)` is `bigint`, which node-postgres
 * returns as a string to avoid silently truncating a value JavaScript's
 * `number` cannot represent exactly; nothing this table will ever hold is
 * anywhere near that large, and `::int` keeps every field here a plain number.
 */
export async function readBaselineCounts(client: DatabaseClient): Promise<BaselineCounts> {
  const { rows } = await client.pool.query<{
    products: number;
    keys_total: number;
    keys_unclaimed: number;
    orders: number;
    payment_events: number;
    deliveries: number;
    issuance_attempts: number;
    supplier_requests: number;
  }>(`
    select
      (select count(*) from products)::int                                              as products,
      (select count(*) from supplier_keys)::int                                         as keys_total,
      (select count(*) from supplier_keys where claimed_by_request_id is null)::int      as keys_unclaimed,
      (select count(*) from orders)::int                                                 as orders,
      (select count(*) from payment_events)::int                                         as payment_events,
      (select count(*) from deliveries)::int                                             as deliveries,
      (select count(*) from issuance_attempts)::int                                      as issuance_attempts,
      (select count(*) from supplier_requests)::int                                      as supplier_requests
  `);

  const row = rows[0];
  if (row === undefined) throw new Error("readBaselineCounts: query returned no row");

  return {
    products: row.products,
    keysTotal: row.keys_total,
    keysUnclaimed: row.keys_unclaimed,
    orders: row.orders,
    paymentEvents: row.payment_events,
    deliveries: row.deliveries,
    issuanceAttempts: row.issuance_attempts,
    supplierRequests: row.supplier_requests,
  };
}

const EXPECTED_PRODUCTS = 12;
const EXPECTED_KEY_POOL = 50;

/**
 * Throws with a precise diff unless the database is at the seeded baseline —
 * the precondition this suite needs before it will touch `supplier_keys`,
 * since the pool is a finite, non-renewable resource in production code (no
 * "unclaim" exists there on purpose — `packages/db/src/schema/supplier.ts`)
 * and this suite wants a known quantity to hand back exactly.
 */
export function assertBaseline(counts: BaselineCounts, when: "before" | "after"): void {
  const problems: string[] = [];

  if (counts.products !== EXPECTED_PRODUCTS) {
    problems.push(`products = ${String(counts.products)}, expected ${String(EXPECTED_PRODUCTS)}`);
  }
  if (counts.keysTotal !== EXPECTED_KEY_POOL) {
    problems.push(`supplier_keys total = ${String(counts.keysTotal)}, expected ${String(EXPECTED_KEY_POOL)}`);
  }
  if (counts.keysUnclaimed !== EXPECTED_KEY_POOL) {
    problems.push(`supplier_keys unclaimed = ${String(counts.keysUnclaimed)}, expected ${String(EXPECTED_KEY_POOL)}`);
  }
  if (counts.orders !== 0) problems.push(`orders = ${String(counts.orders)}, expected 0`);
  if (counts.paymentEvents !== 0) problems.push(`payment_events = ${String(counts.paymentEvents)}, expected 0`);
  if (counts.deliveries !== 0) problems.push(`deliveries = ${String(counts.deliveries)}, expected 0`);
  if (counts.issuanceAttempts !== 0) problems.push(`issuance_attempts = ${String(counts.issuanceAttempts)}, expected 0`);
  if (counts.supplierRequests !== 0) problems.push(`supplier_requests = ${String(counts.supplierRequests)}, expected 0`);

  if (problems.length > 0) {
    const whenPhrase = when === "before" ? "before this suite ran" : "after this suite's own cleanup";
    throw new Error(
      `database is not at the seeded baseline ${whenPhrase}:\n  - ${problems.join("\n  - ")}\n` +
        (when === "before"
          ? "Run `pnpm db:reset` (or `pnpm db:setup` against an empty database) and re-run this test."
          : "This suite's own cleanup left the database dirty — see cleanupTestOrders in support/db.ts."),
    );
  }
}

/**
 * Deletes every row this suite could have written for `orderIds`, and returns
 * any `supplier_keys` those orders' derived request ids claimed to the
 * unclaimed pool — the affordance that lets this test run repeatedly against
 * a 50-key pool with no human resetting the database in between (see the
 * completion requirement: run twice in a row with no manual reset).
 *
 * Ordered to respect the foreign keys in `packages/db/src/schema/shop.ts`:
 * `deliveries.order_id` and `issuance_attempts.order_id` reference `orders.id`
 * and must go first; `payment_events.order_id` carries no FK (by design) but
 * is cleaned up the same way for symmetry; `orders` itself last on the shop
 * side. `supplier_keys` and `supplier_requests` are the supplier's own tables
 * and are addressed by the request ids this test derived, never by a join
 * against `orders` — the same boundary `packages/db/src/schema/supplier.ts`
 * draws for the application itself.
 */
export async function cleanupTestOrders(client: DatabaseClient, orderIds: readonly string[]): Promise<void> {
  if (orderIds.length === 0) return;
  const requestIds = orderIds.map(deriveTestRequestId);

  await client.pool.query(`delete from deliveries where order_id = ANY($1::text[])`, [orderIds]);
  await client.pool.query(`delete from issuance_attempts where order_id = ANY($1::text[])`, [orderIds]);
  await client.pool.query(`delete from payment_events where order_id = ANY($1::text[])`, [orderIds]);
  await client.pool.query(`delete from orders where id = ANY($1::text[])`, [orderIds]);

  // Supplier side. Direct SQL, not an application code path: nothing in
  // apps/api ever clears claimed_by_request_id (packages/db/src/schema/
  // supplier.ts, "There is no 'unclaim'"), and that rule is about production
  // code, not about a test restoring the fixture it borrowed.
  await client.pool.query(
    `update supplier_keys set claimed_by_request_id = null, claimed_at = null where claimed_by_request_id = ANY($1::text[])`,
    [requestIds],
  );
  await client.pool.query(`delete from supplier_requests where request_id = ANY($1::text[])`, [requestIds]);
}

export interface ConcurrencyWitness {
  /** Distinct Postgres backend pids seen holding a connection while `work` was in flight. */
  readonly distinctPids: readonly number[];
  /** How many `pg_stat_activity` polls ran during the window — context for how dense the sampling was. */
  readonly samples: number;
}

/**
 * Runs `work` while continuously polling `pg_stat_activity` for the set of
 * distinct backend pids logged in under `applicationName` — direct,
 * independent evidence that the harness is genuinely holding multiple
 * connections open at once, rather than one process taking turns.
 *
 *   select pid from pg_stat_activity
 *   where application_name = $1 and pid <> pg_backend_pid();
 *
 * The poll runs in a tight loop with no delay between iterations (bounded
 * only by the round trip itself) for the entire span of `work`, on its own
 * connection so it never contends with the work it is observing. This is
 * necessarily a *sample*, not a certificate — a pid that never happened to be
 * connected at a sampled instant is invisible to it — so the test that uses
 * this treats a low count as a signal to look at the RED validation (the
 * stronger, non-samples-based proof) rather than as a hard failure on its
 * own. See `../key-claim-race.test.ts`.
 */
export async function observeDistinctBackendPidsDuring<T>(
  pollerClient: DatabaseClient,
  applicationName: string,
  work: () => Promise<T>,
): Promise<{ result: T; witness: ConcurrencyWitness }> {
  let running = true;
  let samples = 0;
  const pids = new Set<number>();

  const poll = (async (): Promise<void> => {
    while (running) {
      samples += 1;
      const { rows } = await pollerClient.pool.query<{ pid: number }>(
        `select pid from pg_stat_activity where application_name = $1 and pid <> pg_backend_pid()`,
        [applicationName],
      );
      for (const row of rows) pids.add(row.pid);
    }
  })();

  const result = await work();
  running = false;
  await poll;

  return { result, witness: { distinctPids: [...pids].sort((a, b) => a - b), samples } };
}
