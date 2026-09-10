// @layer: script
// @spec: 002-single-issuance-under-races
/**
 * The database half of an adversarial check — and the one place that decides
 * what happens when there is no database to reach.
 *
 * =========================================================================
 * THE INTERFACE, FOR SOMEONE WRITING A CHECK
 * =========================================================================
 *
 *     import { openRaceDatabase, readBaselineCounts, cleanupTestOrders } from "./support/race-database.ts";
 *
 *     const db = openRaceDatabase("webhooks");   // undefined when DATABASE_URL is unset
 *     try {
 *       if (db === undefined) {
 *         console.log("  SKIPPED (no DATABASE_URL): deliveries row count, supplier_keys claimed");
 *       } else {
 *         const { rows } = await db.pool.query("select count(*)::int as n from deliveries where order_id = $1", [orderId]);
 *         ...
 *       }
 *     } finally {
 *       await db?.close();
 *     }
 *
 * `requireRaceDatabase(role)` is the same thing for a check whose *entire*
 * point is a database fact and which would be meaningless without one — it
 * throws a message naming what could not be checked instead of returning
 * `undefined`.
 *
 * Everything else exported here is re-exported unchanged from
 * `apps/api/test/concurrency/support/db.ts` so that a check and the Vitest
 * concurrency suite talk to Postgres through exactly one module: the seeded
 * baseline (`readBaselineCounts` / `assertBaseline`), the cleanup that makes a
 * second run work with no manual tidying (`cleanupTestOrders`), the derived
 * issuance request id, and the purchasable SKU. Read that file's comments
 * before using any of them; they explain, among other things, why restoring
 * `claimed_by_request_id = null` is something only a check may do.
 *
 * ---------------------------------------------------------------------------
 * WHY `undefined` RATHER THAN A THROW, AND WHY NOT A SILENT PASS
 * ---------------------------------------------------------------------------
 * The same check file must run against `pnpm race`'s local instances and
 * against a deployed shop (functional spec §2.6's last criterion: "without
 * being rewritten"). Locally, `scripts/with-env.ts` has already put
 * `DATABASE_URL` in the environment and the runner has proved it connects.
 * Against Vercel + Neon, whoever runs the check may or may not hold that
 * connection string — and requiring it would mean the deployed run, the
 * strongest form of the claim, is the one that cannot be made at all.
 *
 * So the database half degrades to SKIPPED. The rule that makes that safe is
 * the caller's, and it is not optional: **a skipped assertion is reported by
 * name, and never counted as a pass.** A check that quietly drops
 * "exactly one delivery row" when `DATABASE_URL` is missing and still prints
 * PASS is worse than one that fails, because it is a false statement about
 * the system that gets more convincing every time it runs — the same trap
 * `architecture.md` §7 names for a race check that silently serialises.
 *
 * A caveat to state plainly: this module cannot verify that `DATABASE_URL`
 * points at the database the *target* is using. Locally the runner passes both
 * to the same place, so it does. Against a deployed target it is the operator's
 * claim, and a mismatch shows up as a check that finds zero rows for an order
 * the API just returned.
 */
import { createTestDatabaseClient } from "../../../apps/api/test/concurrency/support/db.ts";

export {
  PURCHASABLE_SKU,
  type BaselineCounts,
  assertBaseline,
  cleanupTestOrders,
  createTestDatabaseClient,
  deriveTestRequestId,
  observeDistinctBackendPidsDuring,
  readBaselineCounts,
} from "../../../apps/api/test/concurrency/support/db.ts";

/**
 * `DatabaseClient` from `@game-shop/db`, derived rather than imported.
 *
 * Not stylistic: the repo root has no `@game-shop/db` in `node_modules` (only
 * `apps/api` and `packages/*` depend on it), so a bare `@game-shop/db`
 * specifier in a file under `scripts/` resolves in neither Node nor tsc.
 * Reaching it through the one module that legitimately imports it keeps the
 * type available here without adding a workspace dependency to the root
 * package purely so a script can name a type.
 */
export type RaceDatabaseClient = ReturnType<typeof createTestDatabaseClient>;

/**
 * A database connection if one is configured, `undefined` if not.
 *
 * `role` lands in `pg_stat_activity.application_name` as
 * `game-shop-test-{role}`, so a connection held by a check is distinguishable
 * from an API instance's while a run is in flight. Pass the check's own name.
 *
 * The caller closes it — `await db?.close()` in a `finally`.
 */
export function openRaceDatabase(role: string): RaceDatabaseClient | undefined {
  const url = process.env.DATABASE_URL;
  if (url === undefined || url === "") return undefined;
  return createTestDatabaseClient(role);
}

/**
 * Same, for a check that has no meaningful HTTP-only half. Throws with the
 * assertions that were lost, rather than a bare "DATABASE_URL is not set" that
 * leaves the reader to work out why a URL matters to a check about HTTP.
 */
export function requireRaceDatabase(role: string, assertions: readonly string[]): RaceDatabaseClient {
  const client = openRaceDatabase(role);
  if (client === undefined) {
    throw new Error(
      `DATABASE_URL is not set, and ${role} asserts against the database directly:\n` +
        assertions.map((assertion) => `  - ${assertion}`).join("\n") +
        `\nRun this through \`pnpm race\` (which loads the local environment), or export a ` +
        `DATABASE_URL pointing at the same database the target is using.`,
    );
  }
  return client;
}
