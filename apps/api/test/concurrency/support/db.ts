// @layer: integration
// @spec: 001-purchase-and-key-delivery, 003-failure-and-recovery, 005-promo-codes-with-enforced-limits
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
  /** Rows in `promo_codes` — the brief's four definitions (spec 005). */
  readonly promoCodes: number;
  /** `sum(used_count)` over every code — the COUNTER half of I7. Zero at baseline. */
  readonly promoUsedCount: number;
  /** Rows in `promo_redemptions` — the LEDGER half of I7/I8. Zero at baseline. */
  readonly promoRedemptions: number;
}

/**
 * The whole-database snapshot the completion evidence checks before and after
 * this suite: 12 products, 50 unclaimed keys, four promo codes with nothing
 * spent, and zero of everything this suite (or any purchase) would create.
 *
 *   select
 *     (select count(*) from products)::int,
 *     (select count(*) from supplier_keys)::int,
 *     (select count(*) from supplier_keys where claimed_by_request_id is null)::int,
 *     (select count(*) from orders)::int,
 *     (select count(*) from payment_events)::int,
 *     (select count(*) from deliveries)::int,
 *     (select count(*) from issuance_attempts)::int,
 *     (select count(*) from supplier_requests)::int,
 *     (select count(*) from promo_codes)::int,
 *     (select coalesce(sum(used_count), 0) from promo_codes)::int,
 *     (select count(*) from promo_redemptions)::int;
 *
 * Each subselect is cast `::int`: `count(*)` is `bigint`, which node-postgres
 * returns as a string to avoid silently truncating a value JavaScript's
 * `number` cannot represent exactly; nothing this table will ever hold is
 * anywhere near that large, and `::int` keeps every field here a plain number.
 *
 * `coalesce(sum(used_count), 0)`, not a bare `sum`: `sum()` over an empty
 * table is NULL, and `NULL::int` is still NULL — a `null` arriving in a field
 * this interface types as `number`. Whether that slips past a zero check
 * depends only on how the check happens to be spelled (`null > 0` is false,
 * `Number(null)` is 0, `null + 0` is 0; `null !== 0` is true) — the type is a
 * lie and the verdict an accident either way. `coalesce` makes an empty table
 * an honest 0 here, and leaves `promo_codes = 0` to report the emptiness as
 * the problem it actually is.
 *
 * Counter and ledger are read as two separate numbers on purpose: the
 * assertion below reports them separately, so a drift between them — one
 * nonzero while the other is zero — is visible as exactly that, rather than
 * being folded into one figure that could be right by coincidence.
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
    promo_codes: number;
    promo_used_count: number;
    promo_redemptions: number;
  }>(`
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
      (select count(*) from promo_redemptions)::int                                      as promo_redemptions
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
    promoCodes: row.promo_codes,
    promoUsedCount: row.promo_used_count,
    promoRedemptions: row.promo_redemptions,
  };
}

const EXPECTED_PRODUCTS = 12;
const EXPECTED_KEY_POOL = 50;
/** The brief's four codes — `packages/db/src/fixtures/promo-codes.ts` (spec 005). */
const EXPECTED_PROMO_CODES = 4;

/**
 * Throws with a precise diff unless the database is at the seeded baseline —
 * the precondition this suite needs before it will touch `supplier_keys`,
 * since the pool is a finite, non-renewable resource in production code (no
 * "unclaim" exists there on purpose — `packages/db/src/schema/supplier.ts`)
 * and this suite wants a known quantity to hand back exactly.
 *
 * The promo rows are the same shape of precondition for spec 005: a use of a
 * code is spent for good in production (nothing there ever decrements
 * `used_count` — `packages/db/src/schema/promo.ts`), so `ONCEONLY` left spent
 * by one run would refuse the next. Counter (`sum(used_count)`) and ledger
 * (`promo_redemptions`) are checked as two lines: the "after" check is the
 * one place a drift between them surfaces, because `cleanupTestOrders`
 * deliberately does NOT reconcile one from the other.
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
  if (counts.promoCodes !== EXPECTED_PROMO_CODES) {
    problems.push(`promo_codes = ${String(counts.promoCodes)}, expected ${String(EXPECTED_PROMO_CODES)}`);
  }
  if (counts.promoUsedCount !== 0) {
    problems.push(`promo_codes sum(used_count) = ${String(counts.promoUsedCount)}, expected 0`);
  }
  if (counts.promoRedemptions !== 0) problems.push(`promo_redemptions = ${String(counts.promoRedemptions)}, expected 0`);

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
 * Ordered to respect the foreign keys in `packages/db/src/schema/shop.ts` and
 * `promo.ts`: `deliveries.order_id`, `issuance_attempts.order_id` and
 * `promo_redemptions.order_id` reference `orders.id` and must go first;
 * `payment_events.order_id` carries no FK (by design) but is cleaned up the
 * same way for symmetry; `orders` itself last on the shop side. `supplier_keys`
 * and `supplier_requests` are the supplier's own tables and are addressed by
 * the request ids this test derived, never by a join against `orders` — the
 * same boundary `packages/db/src/schema/supplier.ts` draws for the
 * application itself.
 *
 * Seven statements. Six are deletes or un-claims; the promo one (spec 005)
 * is the exception worth reading: it deletes this test's ledger rows AND
 * hands back the uses they spent, by decrementing each code by exactly the
 * number of rows it removed — never by recomputing the counter from what is
 * left. The reasoning is beside the statement.
 */
export async function cleanupTestOrders(client: DatabaseClient, orderIds: readonly string[]): Promise<void> {
  if (orderIds.length === 0) return;

  // Prefix patterns, NOT `orderIds.map(deriveTestRequestId)`.
  //
  // That helper derives exactly one id — `req_{order}_a_1` — because through
  // Phases 1 and 2 that was the only id an order could ever produce. Phase 3's
  // ladder broke that assumption: an order whose first supplier refuses falls
  // through to `req_{order}_b_2`, and a retry can reach `_a_3`.
  //
  // Cleaning only `_a_1` therefore leaves a *claimed key* behind for every
  // order that fell through — and the damage does not surface here. It surfaces
  // later, in an unrelated suite, as `unclaimed = 49, expected 50`, pointing at
  // code that has nothing to do with it. The same misdirection cost real time
  // this phase when a tight readiness budget stranded rows the next suite's
  // sweep then consumed.
  //
  // `req_{order}_%` matches every rung the ladder can mint, now and after a
  // provider is added. `deriveTestRequestId` is kept for the callers that want
  // to *assert* on the first attempt's id specifically — a different job from
  // deciding what to clean up.
  const requestIdPatterns = orderIds.map((orderId) => `req_${orderId}_%`);

  await client.pool.query(`delete from deliveries where order_id = ANY($1::text[])`, [orderIds]);
  await client.pool.query(`delete from issuance_attempts where order_id = ANY($1::text[])`, [orderIds]);
  await client.pool.query(`delete from payment_events where order_id = ANY($1::text[])`, [orderIds]);

  // Promo (spec 005, technical-considerations §2.5): delete this test's
  // ledger rows and hand back exactly the uses they spent, in ONE statement.
  //
  //   with gone as (
  //     delete from promo_redemptions where order_id = any($1::text[]) returning promo_id
  //   ), per_promo as (
  //     select promo_id, count(*)::int as n from gone group by promo_id
  //   )
  //   update promo_codes p set used_count = p.used_count - per_promo.n
  //   from per_promo where p.id = per_promo.promo_id
  //   -- 0 rows updated => none of these orders had a code applied, and
  //   --                   nothing was deleted either. Not an error.
  //
  // Before `orders`, because `promo_redemptions.order_id` is a real FK. One
  // statement rather than a delete followed by an update, so there is no
  // instant at which the ledger has shrunk and the counter has not: a
  // data-modifying CTE runs to completion in the same snapshot as the UPDATE
  // it feeds, and the two commit or fail together.
  //
  // WHY A DECREMENT BY THIS TEST'S OWN COUNT, AND NOT A GLOBAL RECOMPUTE.
  // This subtracts exactly what the test removed, the way the `supplier_keys`
  // un-claim below addresses only the request ids the test derived. The
  // tempting alternative — `update promo_codes set used_count = (select
  // count(*) from promo_redemptions where promo_id = promo_codes.id)` — would
  // silently REPAIR any drift between counter and ledger that the application
  // had introduced, and drift between those two columns is precisely what
  // `assertBaseline("after")` exists to catch. A cleanup that makes the
  // baseline true is not a cleanup; it is a test that cannot fail.
  //
  // `promo_codes_used_count_range` cannot fire here while counter and ledger
  // agree: the decrement never takes `used_count` below the rows the ledger
  // still holds, and never raises it towards `max_uses`. If it does fire, it
  // is reporting that the counter was already below the ledger — the schema's
  // backstop doing its job, loudly, on a drift this test would otherwise have
  // had to explain from a negative count in the next baseline.
  //
  // Only a test may do this. Nothing in apps/api ever decrements `used_count`
  // — a use, once spent, stays spent (packages/db/src/schema/promo.ts) —
  // exactly as nothing there ever clears `claimed_by_request_id`.
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

  await client.pool.query(`delete from orders where id = ANY($1::text[])`, [orderIds]);

  // Supplier side. Direct SQL, not an application code path: nothing in
  // apps/api ever clears claimed_by_request_id (packages/db/src/schema/
  // supplier.ts, "There is no 'unclaim'"), and that rule is about production
  // code, not about a test restoring the fixture it borrowed.
  await client.pool.query(
    `update supplier_keys set claimed_by_request_id = null, claimed_at = null
       where claimed_by_request_id like any($1::text[])`,
    [requestIdPatterns],
  );
  await client.pool.query(`delete from supplier_requests where request_id like any($1::text[])`, [requestIdPatterns]);
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
