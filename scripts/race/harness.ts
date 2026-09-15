#!/usr/bin/env node
// @layer: script
// @spec: 002-single-issuance-under-races
/**
 * `pnpm race harness` — the check that checks the harness.
 *
 * It asserts nothing about the shop's behaviour. It asserts that the *next*
 * check's result will mean something: that every target is really serving,
 * that each one can really reach the database, and that the targets are
 * genuinely **separate processes** rather than one process wearing several
 * URLs — over HTTP, from the `x-instance-id` every answer carries, and, when
 * a database connection is available, from the separate backend connections
 * those processes hold.
 *
 * That last one is the point of the whole slice. `packages/db/src/client.ts`
 * pins the pool to `max: 1`, so concurrent requests to a single process
 * serialise in Node before Postgres sees them and a shop with no locking at
 * all passes every race check (`context/product/architecture.md` §7: 20
 * distinct keys across 1 process, 9 across 4, zero errors in both). A green
 * `race:webhooks` against one process is not evidence, and nothing in
 * `race:webhooks` itself can tell the difference. This check can.
 *
 * ---------------------------------------------------------------------------
 * THE TWO WITNESSES, AND WHICH ONE COUNTS WHERE
 * ---------------------------------------------------------------------------
 * The `pg_stat_activity` pid count is the stronger witness — it sees the
 * processes from the database's side — and it is the one that decides locally.
 * A reviewer pointed at the live shop holds no database, so there the
 * instance-id witness decides instead: N = max(8, 2 × targets) concurrent
 * `GET /api/health`, spread round-robin, every header checked against its own
 * body, and the distinct count read off (spec 006 §2.5). Externally it is a
 * PASS at ≥ 2 distinct ids and a FAIL at exactly 1 — every answer from one
 * process is the run §7 warns is worthless, and on Vercel that is what Fluid
 * Compute produces when it is left on. Locally it is INFO only: one id per
 * port is a tautology, the runner started those processes itself, and the
 * pids below are the proof. `RACE_MODE` (set by the runner) is how this file
 * tells the two apart; run by hand it assumes the external reading.
 *
 * What the count does not prove, printed with it: a distinct id proves a
 * distinct process, not that those processes overlapped in time — two ids
 * across eight answers are consistent with one instance recycled between the
 * first and the last. It rules out the one reading that would make a live run
 * worthless, and no more. K = 1 on a run means that run was not cross-process
 * evidence, whatever the checks after it say.
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
import {
  collectInstanceIds,
  INSTANCE_ID_HEADER,
  RACE_MODE_ENV,
  readInstanceId,
  resolveRaceTargets,
} from "./support/race-targets.ts";

/** `application_name` every `apps/api` instance connects with — `packages/db/src/client.ts`. */
const API_APPLICATION_NAME = "game-shop";

/**
 * The floor on the concurrent health fan-out. Eight against one deployed
 * origin gives the platform room to answer from more than one instance;
 * 2 × targets keeps every local port asked at least twice.
 */
const MIN_INSTANCE_WITNESS_REQUESTS = 8;

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

// ---------------------------------------------------------------------------
// The instance-id witness — the HTTP proof of "separate processes". See the
// header, "THE TWO WITNESSES".
// ---------------------------------------------------------------------------
interface HealthAnswer {
  readonly response: Response | undefined;
  readonly bodyInstanceId: string | undefined;
  readonly error: string | undefined;
}

async function fetchHealth(baseUrl: string): Promise<HealthAnswer> {
  try {
    const response = await fetch(`${baseUrl}/api/health`);
    const body: unknown = response.ok ? await response.json() : undefined;
    const bodyInstanceId = (body as { instance_id?: unknown } | undefined)?.instance_id;
    return {
      response,
      bodyInstanceId: typeof bodyInstanceId === "string" ? bodyInstanceId : undefined,
      error: undefined,
    };
  } catch (error: unknown) {
    return { response: undefined, bodyInstanceId: undefined, error: error instanceof Error ? error.message : String(error) };
  }
}

const witnessRequestCount = Math.max(MIN_INSTANCE_WITNESS_REQUESTS, 2 * targets.instanceCount);
const healthAnswers = await Promise.all(
  Array.from({ length: witnessRequestCount }, (_, i) => fetchHealth(targets.at(i))),
);

// Header and body must agree on every answer: the header is what every other
// check reads, the body is what a person reads, and a mismatch would mean one
// of them is not this process's id.
const disagreeing = healthAnswers.filter(
  (answer) => answer.response === undefined || readInstanceId(answer.response) !== answer.bodyInstanceId,
);
record(
  disagreeing.length === 0,
  `${INSTANCE_ID_HEADER} header equals the body's instance_id on all ${String(witnessRequestCount)} concurrent health answers`,
  disagreeing.length === 0
    ? `${String(witnessRequestCount)} of ${String(witnessRequestCount)} agree`
    : disagreeing
        .slice(0, 3)
        .map((answer) =>
          answer.response === undefined
            ? `fetch failed: ${answer.error ?? "unknown"}`
            : `header=${String(readInstanceId(answer.response))} body=${String(answer.bodyInstanceId)}`,
        )
        .join("; ") + (disagreeing.length > 3 ? "; …" : ""),
);

const witness = collectInstanceIds(healthAnswers.map((answer) => answer.response).filter((r): r is Response => r !== undefined));
const distinctInstanceIds = witness.distinct.length;
const raceMode = process.env[RACE_MODE_ENV];

if (raceMode === "local") {
  // The runner started these processes on these ports itself; one id per
  // port is a tautology. The pid count below is the local proof.
  console.log(
    `  INFO  ${String(targets.instanceCount)} targets, ${String(distinctInstanceIds)} distinct instance id(s) across ` +
      `${String(witnessRequestCount)} concurrent health answers — locally an id per port is a tautology; ` +
      "the pg_stat_activity pids below are the proof",
  );
} else {
  record(
    distinctInstanceIds >= 2,
    `the ${String(witnessRequestCount)} concurrent health answers came from at least two distinct instances`,
    distinctInstanceIds >= 2
      ? `${String(distinctInstanceIds)} distinct instance id(s) across ${String(targets.instanceCount)} target(s)`
      : `all ${String(witnessRequestCount)} answers came from one instance — re-run, or check that Fluid Compute is off`,
  );
}
console.log(
  "        A distinct id proves a distinct process, not that those processes overlapped in time.\n" +
    "        K = 1 on a run means that run was not cross-process evidence, whatever the checks after it say.",
);

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
    "        Without a database route this run cannot confirm from the database's side\n" +
      "        that the targets are separate processes, nor that they overlapped; the\n" +
      "        instance-id line above is the HTTP witness and no more. Locally it is the\n" +
      "        one thing worth confirming, so run this through `pnpm race`.",
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
