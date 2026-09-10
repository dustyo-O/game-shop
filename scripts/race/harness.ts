#!/usr/bin/env node
// @layer: script
// @spec: 002-single-issuance-under-races
/**
 * `pnpm race harness` — the check that checks the harness.
 *
 * It asserts nothing about the shop's behaviour. It asserts that the *next*
 * check's result will mean something: that every target is really serving,
 * that each one can really reach the database, and — when a database
 * connection is available — that the targets are genuinely **separate
 * processes holding separate connections** rather than one process wearing
 * several URLs.
 *
 * That last one is the point of the whole slice. `packages/db/src/client.ts`
 * pins the pool to `max: 1`, so concurrent requests to a single process
 * serialise in Node before Postgres sees them and a shop with no locking at
 * all passes every race check (`context/product/architecture.md` §7: 20
 * distinct keys across 1 process, 9 across 4, zero errors in both). A green
 * `race:webhooks` against one process is not evidence, and nothing in
 * `race:webhooks` itself can tell the difference. This check can.
 *
 * It is also the worked example for the other checks in this directory: read
 * it top to bottom for the shape — resolve targets, announce, run the HTTP
 * assertions that work anywhere, then the database assertions that need
 * `DATABASE_URL`, reporting them as SKIPPED by name when there is none.
 */
import {
  type BaselineCounts,
  openRaceDatabase,
  readBaselineCounts,
} from "./support/race-database.ts";
import { resolveRaceTargets } from "./support/race-targets.ts";

/** `application_name` every `apps/api` instance connects with — `packages/db/src/client.ts`. */
const API_APPLICATION_NAME = "game-shop";

const targets = resolveRaceTargets();
targets.announce("race:harness");

const failures: string[] = [];

function record(ok: boolean, label: string, detail: string): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

// ---------------------------------------------------------------------------
// HTTP half. Needs no database, and runs unchanged against a deployed target.
// ---------------------------------------------------------------------------
for (const baseUrl of targets.baseUrls) {
  try {
    const response = await fetch(`${baseUrl}/api/health`);
    const body: unknown = response.ok ? await response.json() : undefined;
    const status = (body as { status?: unknown } | undefined)?.status;
    record(
      response.ok && status === "ok",
      `${baseUrl} serves /api/health`,
      `HTTP ${String(response.status)}, status=${JSON.stringify(status)}`,
    );
  } catch (error) {
    record(false, `${baseUrl} serves /api/health`, error instanceof Error ? error.message : String(error));
  }
}

// Health answers `200` with no database at all — `apps/api` builds its pool
// lazily — so liveness alone would let a run start against instances that
// cannot serve a single order. The catalogue is the cheapest read that
// actually goes to Postgres, and hitting it here is also what opens each
// instance's one connection for the pid count below.
for (const baseUrl of targets.baseUrls) {
  try {
    const response = await fetch(`${baseUrl}/api/products`);
    const body: unknown = response.ok ? await response.json() : undefined;
    const count = Array.isArray(body) ? body.length : -1;
    record(
      response.ok && count > 0,
      `${baseUrl} reaches its database`,
      `GET /api/products → HTTP ${String(response.status)}, ${String(count)} product(s)`,
    );
  } catch (error) {
    record(false, `${baseUrl} reaches its database`, error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Database half. Needs DATABASE_URL pointing at the same database the targets
// use. Reported as SKIPPED by name when there is none — never as a pass.
// ---------------------------------------------------------------------------
const db = openRaceDatabase("race-harness");

if (db === undefined) {
  console.log("  SKIP  distinct backend connections — needs DATABASE_URL");
  console.log("  SKIP  seeded baseline counts — needs DATABASE_URL");
  console.log(
    "        Without a database route this run cannot confirm the targets are separate\n" +
      "        processes. On a deployed target that is the platform's guarantee; locally it\n" +
      "        is the one thing worth confirming, so run this through `pnpm race`.",
  );
} else {
  try {
    // Every instance has just served GET /api/products, so every instance is
    // holding its single connection. `idleTimeoutMillis` is 10s
    // (packages/db/src/client.ts), so they are all still logged in now — which
    // is why one query after the requests is a firmer count than sampling
    // during them.
    //
    //   select pid, application_name from pg_stat_activity
    //   where application_name = 'game-shop' and pid <> pg_backend_pid();
    //
    // `application_name = 'game-shop'` is the API's; this script connects as
    // `game-shop-test-race-harness`, so it never counts itself.
    const { rows } = await db.pool.query<{ pid: number }>(
      `select pid from pg_stat_activity where application_name = $1 and pid <> pg_backend_pid()`,
      [API_APPLICATION_NAME],
    );
    const distinct = new Set(rows.map((row) => row.pid)).size;
    record(
      distinct >= targets.instanceCount,
      "targets hold separate database connections",
      `${String(distinct)} distinct backend pid(s) as '${API_APPLICATION_NAME}', ` +
        `need >= ${String(targets.instanceCount)}` +
        (distinct > targets.instanceCount ? " (a `pnpm dev` API would also be counted)" : ""),
    );

    const counts: BaselineCounts = await readBaselineCounts(db);
    const atBaseline =
      counts.products === 12 &&
      counts.keysTotal === 50 &&
      counts.keysUnclaimed === 50 &&
      counts.orders === 0 &&
      counts.paymentEvents === 0 &&
      counts.deliveries === 0;
    // Informational, not a failure: a reviewer may be pointing this at a
    // database with real rows in it, and each check owns its own baseline
    // policy. Printing the counts is what makes a later "one delivery row"
    // assertion readable.
    console.log(
      `  ${atBaseline ? "INFO" : "WARN"}  seeded baseline — products=${String(counts.products)} ` +
        `keys=${String(counts.keysUnclaimed)}/${String(counts.keysTotal)} unclaimed ` +
        `orders=${String(counts.orders)} payment_events=${String(counts.paymentEvents)} ` +
        `deliveries=${String(counts.deliveries)}` +
        (atBaseline ? "" : " — not the seeded baseline; run `pnpm db:reset` if a check complains"),
    );
  } finally {
    await db.close();
  }
}

if (failures.length > 0) {
  console.error(`race:harness FAILED (${String(failures.length)}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log("race:harness passed.");
}
