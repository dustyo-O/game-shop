#!/usr/bin/env node
// @layer: script
// @spec: 002-single-issuance-under-races
/**
 * `pnpm race` — starts several real `apps/api` processes, runs every
 * adversarial check in `scripts/race/` against them, and stops the processes
 * again whatever happens.
 *
 * =========================================================================
 * USAGE
 * =========================================================================
 *
 *   pnpm race                          every check, against 4 local instances
 *   pnpm race webhooks same-event      only those checks
 *   pnpm race --list                   what checks exist, without running them
 *
 *   RACE_BASE_URLS=https://game-shop.vercel.app ADMIN_TOKEN=<the demo token> pnpm race
 *                                      the deployed target: nothing is spawned,
 *                                      nothing is built, the checks run as-is;
 *                                      no database, so database-side assertions
 *                                      are SKIP by name — the reviewer's command
 *
 *   RACE_BASE_URLS=… ADMIN_TOKEN=… RACE_DATABASE_URL=<the target's database> pnpm race
 *                                      the author's full run: every assertion,
 *                                      cleanup included — the URL is forwarded
 *                                      to the checks as DATABASE_URL
 *
 *   RACE_BASE_URLS=… ADMIN_TOKEN=… RACE_DEMO_RESET=1 pnpm race
 *                                      after the last check, POST
 *                                      /api/admin/demo/reset on the first target
 *                                      so the transcript ends at baseline
 *
 * Exit code: `0` every check passed, `1` at least one failed, `2` the command
 * or the configuration was wrong.
 *
 * =========================================================================
 * ADDING A CHECK
 * =========================================================================
 * Drop a file at `scripts/race/<name>.ts`. It is picked up automatically —
 * there is no registry to update, deliberately, because four different authors
 * add the four checks and a shared list is four chances to forget. Rules:
 *
 *   1. Top-level `.ts` files in `scripts/race/` are checks. Helpers go in
 *      `scripts/race/support/`, which is never scanned.
 *   2. A check reads its targets from `RACE_BASE_URLS` via
 *      `./support/race-targets.ts`, and never hard-codes a host or a port.
 *   3. A check exits `0` on pass, `1` on fail, and `3` when it could not run
 *      against this target at all (see EXIT_CHECK_SKIPPED below). Nothing else
 *      is inspected — not stdout, not a report file.
 *   4. A check cleans up what it wrote (`cleanupTestOrders` in
 *      `./support/race-database.ts`) when it has a database, so `pnpm race`
 *      twice in a row works with no manual tidying. Functional spec §2.6 makes
 *      that a criterion. Without one (external mode, no `RACE_DATABASE_URL`)
 *      the orders stay on the target and the banner names the tidying:
 *      `pnpm demo:reset`, or `RACE_DEMO_RESET=1` on the run itself.
 *   5. `<name>` becomes the check's name here and should match the npm alias
 *      its author adds, e.g. `scripts/race/webhooks.ts` ←→ `pnpm race:webhooks`.
 *
 * `harness.ts` runs first when present; everything else runs in filename
 * order. Checks run one at a time, not concurrently: they share one 50-key
 * `supplier_keys` pool and one seeded baseline, so overlapping them would make
 * each one's cleanup another one's flake.
 *
 * =========================================================================
 * WHY THIS SPAWNS SEVERAL PROCESSES
 * =========================================================================
 * `packages/db/src/client.ts` pins the pool to `max: 1` per process. Fifty
 * concurrent requests to **one** local API process therefore serialise in
 * Node, before Postgres sees a second statement, and a shop with no locking at
 * all passes every check — measured, `context/product/architecture.md` §7: the
 * same weakened key claim handed out 20 distinct keys across 1 process and 9
 * across 4, with zero errors reported in both runs.
 *
 * So the harness's whole job is to put the checks in front of genuinely
 * separate OS processes. On Vercel the platform does that for us, which is why
 * a single `RACE_BASE_URLS` entry is accepted rather than rejected — see
 * `./support/race-targets.ts`.
 *
 * =========================================================================
 * KNOBS (all optional, all with working defaults)
 * =========================================================================
 *   RACE_BASE_URLS        Set → external mode: use these targets, spawn and
 *                         build nothing. Unset → local mode (the default).
 *   RACE_INSTANCES        Local instances to start. Default 4 — the number
 *                         architecture.md §7's measurement used.
 *   RACE_BASE_PORT        First port. Default 4601, clear of `pnpm dev`
 *                         (3000, 5173) and of every port the Vitest suites
 *                         bind (4101, 4201, 4301, 4401, 4501-4504).
 *   RACE_SKIP_BUILD       Non-empty → skip the rebuild. Faster to iterate, and
 *                         WRONG for RED validation: the spawned processes run
 *                         `dist/`, so a weakened source file that was not
 *                         rebuilt is not the code under test.
 *   RACE_CHECK_TIMEOUT_MS Per check. Default 180000.
 *   RACE_VERBOSE          Non-empty → stream each instance's stdout too, not
 *                         just its stderr.
 *   RACE_DATABASE_URL     External mode only. Forwarded to the checks as
 *                         DATABASE_URL — the target's own database, for the
 *                         author's full run. Without it external mode STRIPS
 *                         DATABASE_URL from the checks' environment: see
 *                         "EXTERNAL MODE — ENVIRONMENT HYGIENE" below.
 *   RACE_DEMO_RESET       External mode only; ignored (with one line) locally.
 *                         Non-empty → POST /api/admin/demo/reset on the first
 *                         target after the last check, counts printed.
 *   RACE_MODE             Not a knob — SET BY THIS RUNNER for the checks it
 *                         spawns: `local` or `external`. `harness.ts` reads it
 *                         to decide whether a distinct-instance count is a
 *                         PASS/FAIL (external) or an INFO line (local).
 *
 * =========================================================================
 * EXTERNAL MODE — ENVIRONMENT HYGIENE (spec 006 §2.6, R7)
 * =========================================================================
 * `scripts/with-env.ts` merges `.env.example` into this process's environment,
 * so an external run would otherwise hand every check
 * `DATABASE_URL=…localhost:5433…` — the LOCAL database — while the target
 * writes to its own. The database half of every check would then either fail
 * on `ECONNREFUSED` or, worse, assert against a database the target never
 * touched and report it. So in external mode the child environment is built
 * WITHOUT `DATABASE_URL` unless `RACE_DATABASE_URL` names the target's own,
 * and the mode line says which of the two this run is. Without a database the
 * checks report every database-side assertion as SKIP by name (never as a
 * pass — `support/race-database.ts`), and the orders they create stay on the
 * target: hence the banner, `pnpm demo:reset`, and `RACE_DEMO_RESET=1`.
 *
 * `ADMIN_TOKEN` is forwarded as-is — the recover checks arm the supplier with
 * it — but `.env.example`'s local default is almost certainly not the
 * target's, so a hint is printed when the two would collide as a `401`.
 *
 * Local mode is untouched by any of this: the child environment is the
 * runner's own plus `RACE_BASE_URLS` and `RACE_MODE=local`, exactly as before.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type RunningInstance,
  startApiInstance,
  stopAllApiInstances,
} from "../../apps/api/test/concurrency/support/api-instance.ts";
import { RACE_BASE_URLS_ENV, RACE_MODE_ENV, parseRaceBaseUrls } from "./support/race-targets.ts";
import { openRaceDatabase } from "./support/race-database.ts";
import {
  describeMissingAdminAffordance,
  isMissingAdminAffordance,
  postDemoReset,
  readAdminToken,
} from "./support/recovery-scenario.ts";

const RACE_DIR = dirname(fileURLToPath(import.meta.url));
/** The repository root — where `pnpm` workspace filters resolve from. */
const REPO_ROOT = resolve(RACE_DIR, "..", "..");
const API_ROOT = resolve(REPO_ROOT, "apps", "api");

/** This file is the runner, not a check. */
const RUNNER_FILENAME = "run-checks.ts";
/** Runs first when it exists: if the harness itself is broken, every other failure is noise. */
const FIRST_CHECK = "harness";

const DEFAULT_INSTANCE_COUNT = 4;
/**
 * First port `pnpm race` binds, for `RACE_INSTANCES` consecutive ports.
 *
 * 4601 and not 4201. The original default was 4201 and it **collided** with
 * `test/acceptance/purchase-and-key-delivery.test.ts`, which binds that exact
 * port — the comment below this one used to claim there was no collision, and
 * two later test files documented the overlap in their own headers rather than
 * resolving it.
 *
 * Nobody hit it because both are documented as run one at a time, which is
 * exactly what makes it worth moving: the failure would only appear when
 * somebody ran `pnpm test` and `pnpm race` together — in CI, or on the machine
 * of a reviewer with two terminals open — and it would present as an instance
 * that would not start, or worse, as one suite's requests being answered by the
 * other suite's process.
 *
 * The Vitest suites bind 4101, 4201, 4301, 4401 and 4501-4504. This range is
 * clear of all of them and of `pnpm dev` (3000, 5173).
 */
const DEFAULT_BASE_PORT = 4601;
const DEFAULT_CHECK_TIMEOUT_MS = 180_000;

/**
 * `.env.example`'s `ADMIN_TOKEN`, transcribed. External mode compares the
 * token it is about to forward against this: a reviewer who exported nothing
 * inherits it through `with-env.ts`, and every admin-guarded check would then
 * SKIP on a `401` without saying why the token was wrong.
 */
const LOCAL_DEFAULT_ADMIN_TOKEN = "local-dev-admin-token-not-a-secret";

/**
 * The warm-up: `GET /api/products` on the first target until it answers 200.
 * `/api/health` would not do — `apps/api` builds its pool lazily, so health
 * answers 200 with no database at all and proves nothing about a Neon branch
 * resuming from autosuspend. Six attempts, five seconds apart: a cold
 * function plus a cold database is a few seconds; thirty is a target that is
 * not coming up, and the run should say so rather than spend nine checks
 * discovering it.
 */
const WARM_UP_ATTEMPTS = 6;
const WARM_UP_INTERVAL_MS = 5_000;
const WARM_UP_REQUEST_TIMEOUT_MS = 20_000;

type RaceMode = "local" | "external";

const EXIT_OK = 0;
const EXIT_CHECK_FAILED = 1;
const EXIT_USAGE = 2;

/**
 * A check exits with this when it could not run *here* — not when the shop is
 * wrong.
 *
 * The distinction matters because these checks are meant to be pointed at a
 * deployed shop, and some of them need an affordance a deployment may not
 * grant. `before-order` is the case that forced this: it needs
 * `ALLOW_CLIENT_SUPPLIED_ORDER_ID` on every targeted instance, which `pnpm
 * race` sets for the instances it spawns and a deployed target may
 * legitimately refuse.
 *
 * Both of the binary answers are lies there. `FAIL` says the shop is broken
 * when it is fine, and a reviewer who sees red on a correct system stops
 * trusting the other four. `PASS` is worse: it counts an unrun check as
 * evidence, which is exactly the decoration §2.6 exists to forbid.
 *
 * So: reported by name, counted as neither, and the run still exits `0`
 * because nothing that ran was wrong. This is the same rule
 * `support/race-database.ts` already applies to a single assertion with no
 * `DATABASE_URL`, raised to the level of a whole check.
 */
const EXIT_CHECK_SKIPPED = 3;

interface Check {
  readonly name: string;
  readonly path: string;
}

interface CheckResult {
  readonly name: string;
  /** A skipped check is `ok` — nothing it ran was wrong — but not a pass. */
  readonly ok: boolean;
  readonly skipped?: boolean;
  readonly detail: string;
  readonly durationMs: number;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  // Decimal digits only, matching how apps/api/src/config/env.ts reads a
  // number: `Number()` accepts "4e0" and "0x4", and a count that is secretly a
  // different number than the one written is the kind of thing nobody notices
  // until a race check reports two instances and claims four.
  if (!/^\d+$/.test(raw.trim()) || Number(raw.trim()) === 0) {
    throw new Error(`${name} must be a positive whole number, got ${JSON.stringify(raw)}`);
  }
  return Number(raw.trim());
}

function isEnabled(name: string): boolean {
  const raw = process.env[name];
  return raw !== undefined && raw !== "" && raw !== "0" && raw.toLowerCase() !== "false";
}

/**
 * Every top-level `.ts` file in `scripts/race/`, minus this one.
 *
 * `support/` is a directory and so is skipped by the extension filter, which
 * is also why helpers belong there.
 */
function discoverChecks(): Check[] {
  const names = readdirSync(RACE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && entry.name !== RUNNER_FILENAME)
    .map((entry) => entry.name.slice(0, -".ts".length))
    .sort((a, b) => {
      if (a === FIRST_CHECK) return -1;
      if (b === FIRST_CHECK) return 1;
      return a.localeCompare(b);
    });

  return names.map((name) => ({ name, path: join(RACE_DIR, `${name}.ts`) }));
}

function runCheck(check: Check, env: NodeJS.ProcessEnv, timeoutMs: number, onSpawn: (child: ChildProcess) => void): Promise<CheckResult> {
  return new Promise<CheckResult>((resolvePromise) => {
    const startedAt = Date.now();
    // A separate process per check, with inherited stdio. Not an in-process
    // import: a check must stay runnable on its own against a deployed target
    // (`RACE_BASE_URLS=… node scripts/race/webhooks.ts`), and running it here
    // exactly the way a reviewer would run it by hand is what keeps that true.
    // It also means a check that crashes the runtime fails that check rather
    // than killing the run and leaking four API processes.
    const child = spawn(process.execPath, [check.path], { cwd: REPO_ROOT, env, stdio: "inherit" });
    onSpawn(child);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    }, timeoutMs);
    timer.unref();

    child.once("error", (error: Error) => {
      clearTimeout(timer);
      resolvePromise({ name: check.name, ok: false, detail: `could not run: ${error.message}`, durationMs: Date.now() - startedAt });
    });

    child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      if (timedOut) {
        resolvePromise({ name: check.name, ok: false, detail: `timed out after ${String(timeoutMs)}ms`, durationMs });
        return;
      }
      if (signal !== null) {
        resolvePromise({ name: check.name, ok: false, detail: `killed by ${signal}`, durationMs });
        return;
      }
      if (code === EXIT_CHECK_SKIPPED) {
        resolvePromise({ name: check.name, ok: true, skipped: true, detail: "skipped (see above)", durationMs });
        return;
      }
      resolvePromise({
        name: check.name,
        ok: code === 0,
        detail: code === 0 ? "passed" : `exited ${String(code)}`,
        durationMs,
      });
    });
  });
}

/**
 * Prove the database is reachable before building anything or spawning
 * anything.
 *
 * Without this the failure mode is four processes that come up perfectly
 * healthy — `apps/api` builds its pool lazily, so `/api/health` answers `200`
 * with no database at all — followed by every check failing on an unrelated
 * error. One round trip here turns that into one sentence.
 */
async function preflightDatabase(): Promise<void> {
  const client = openRaceDatabase("race-runner");
  if (client === undefined) {
    throw new Error(
      "DATABASE_URL is not set. Run through `pnpm race`, which loads the local environment " +
        "via scripts/with-env.ts.",
    );
  }
  try {
    await client.pool.query("select 1");
  } catch (error) {
    throw new Error(
      `cannot reach the database at DATABASE_URL: ${error instanceof Error ? error.message : String(error)}\n` +
        "Start it and seed it with `pnpm db:setup` (or `pnpm db:reset` to return to the seeded baseline).",
    );
  } finally {
    await client.close();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((doneWaiting) => {
    setTimeout(doneWaiting, ms);
  });
}

/**
 * External mode's first request: the catalogue, until it answers 200.
 * Bounded — see WARM_UP_ATTEMPTS. Throws when the target never comes up,
 * which the caller reports as a configuration error rather than nine `fetch
 * failed`s.
 */
async function warmUpTarget(baseUrl: string): Promise<void> {
  for (let attempt = 1; attempt <= WARM_UP_ATTEMPTS; attempt += 1) {
    const startedAt = Date.now();
    let outcome: string;
    try {
      const response = await fetch(`${baseUrl}/api/products`, { signal: AbortSignal.timeout(WARM_UP_REQUEST_TIMEOUT_MS) });
      const elapsedMs = Date.now() - startedAt;
      if (response.ok) {
        console.log(
          `race: warm-up — GET ${baseUrl}/api/products → ${String(response.status)} in ${String(elapsedMs)}ms ` +
            `(attempt ${String(attempt)} of ${String(WARM_UP_ATTEMPTS)})`,
        );
        return;
      }
      outcome = `HTTP ${String(response.status)} in ${String(elapsedMs)}ms`;
    } catch (error: unknown) {
      const reason = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
      outcome = `${reason} after ${String(Date.now() - startedAt)}ms`;
    }
    console.log(
      `race: warm-up — GET ${baseUrl}/api/products → ${outcome} (attempt ${String(attempt)} of ${String(WARM_UP_ATTEMPTS)})` +
        (attempt < WARM_UP_ATTEMPTS ? `; retrying in ${String(WARM_UP_INTERVAL_MS / 1000)}s` : ""),
    );
    if (attempt < WARM_UP_ATTEMPTS) await delay(WARM_UP_INTERVAL_MS);
  }
  throw new Error(
    `the target never answered 200 on GET ${baseUrl}/api/products in ${String(WARM_UP_ATTEMPTS)} attempts. ` +
      "Nothing below could pass; check the URL, the deployment, and its database.",
  );
}

/**
 * The child environment for every check. Local mode: this process's own plus
 * the two markers — unchanged from before external mode existed. External
 * mode: the same minus `DATABASE_URL`, which is put back only from
 * `RACE_DATABASE_URL`. See the header, "EXTERNAL MODE — ENVIRONMENT HYGIENE".
 */
function buildChildEnv(mode: RaceMode, baseUrls: readonly string[], raceDatabaseUrl: string | undefined): NodeJS.ProcessEnv {
  const markers = { [RACE_BASE_URLS_ENV]: baseUrls.join(","), [RACE_MODE_ENV]: mode };
  if (mode === "local") return { ...process.env, ...markers };

  const { DATABASE_URL: _localDatabaseUrl, ...withoutDatabase } = process.env;
  return raceDatabaseUrl === undefined
    ? { ...withoutDatabase, ...markers }
    : { ...withoutDatabase, DATABASE_URL: raceDatabaseUrl, ...markers };
}

/** `key 1 · key 2` over the numeric fields of one part of the reset report — the shape is `apps/api/src/demo/demo.types.ts`'s, read defensively. */
function describeCounts(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "(no counts)";
  const entries = Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === "number");
  return entries.length === 0 ? "(no counts)" : entries.map(([key, count]) => `${key} ${String(count)}`).join(" · ");
}

/**
 * `RACE_DEMO_RESET=1`, external mode only: `POST /api/admin/demo/reset` on the
 * first target after the last check, so a transcript that created orders on
 * a target nobody can clean through SQL still ends at baseline.
 *
 * The mode guard is a thrown error, not a silent return, because the local
 * harness must never reach this: locally every check cleans up its own rows
 * and the harness asserts the baseline after, and a reset in their place
 * would sweep a leaking application's residue into `removed` and call it a
 * pass (`support/recovery-scenario.ts`, `postDemoReset`). The caller only
 * calls this in external mode; this is the assertion that it stayed so.
 *
 * Returns `true` when the target answered 200; `false` when it refused —
 * reported by the caller as a configuration error, since a run that was
 * asked to end at baseline and did not must not exit 0.
 */
async function resetDemoAfterRun(mode: RaceMode, baseUrl: string): Promise<boolean> {
  if (mode !== "external") {
    throw new Error("RACE_DEMO_RESET reached the reset in local mode — this must be unreachable; see resetDemoAfterRun");
  }
  const adminToken = readAdminToken();
  console.log(`\nrace: RACE_DEMO_RESET — POST ${baseUrl}/api/admin/demo/reset`);
  if (adminToken === undefined) {
    console.error("race: RACE_DEMO_RESET — no ADMIN_TOKEN in this process; the reset was not attempted.");
    return false;
  }
  let result: Awaited<ReturnType<typeof postDemoReset>>;
  try {
    result = await postDemoReset(baseUrl, adminToken);
  } catch (error: unknown) {
    console.error(`race: RACE_DEMO_RESET — could not reach the target: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
  if (isMissingAdminAffordance(result)) {
    console.error(`race: RACE_DEMO_RESET — the reset did not run: ${describeMissingAdminAffordance(result)}`);
    return false;
  }
  if (!result.ok || result.body === undefined) {
    console.error(`race: RACE_DEMO_RESET — the target answered ${String(result.status)}: ${result.text}`);
    return false;
  }
  const changed = result.body["changed"];
  if (changed === false) {
    console.log("race:   already at baseline — nothing removed, nothing reset");
  } else {
    console.log(`race:   removed  ${describeCounts(result.body["removed"])}`);
    console.log(`race:   reset    ${describeCounts(result.body["reset"])}`);
  }
  console.log(`race:   now      ${describeCounts(result.body["now"])}`);
  return true;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const wantsList = args.includes("--list");
  const selectors = args.filter((arg) => !arg.startsWith("--"));

  const unknownFlags = args.filter((arg) => arg.startsWith("--") && arg !== "--list");
  if (unknownFlags.length > 0) {
    console.error(`race: unknown option ${unknownFlags.join(", ")}. Usage: pnpm race [--list] [check-name...]`);
    return EXIT_USAGE;
  }

  const discovered = discoverChecks();

  if (wantsList) {
    if (discovered.length === 0) console.log("race: no checks in scripts/race/ yet.");
    for (const check of discovered) console.log(check.name);
    return EXIT_OK;
  }

  if (discovered.length === 0) {
    console.error(
      "race: no checks found in scripts/race/. Add one as scripts/race/<name>.ts — " +
        "see the header of scripts/race/run-checks.ts.",
    );
    return EXIT_USAGE;
  }

  let checks = discovered;
  if (selectors.length > 0) {
    const known = new Set(discovered.map((check) => check.name));
    const unknown = selectors.filter((selector) => !known.has(selector));
    if (unknown.length > 0) {
      console.error(
        `race: no such check: ${unknown.join(", ")}. Available: ${discovered.map((c) => c.name).join(", ")}`,
      );
      return EXIT_USAGE;
    }
    checks = discovered.filter((check) => selectors.includes(check.name));
  }

  // ---------------------------------------------------------------------
  // Mode. An externally supplied RACE_BASE_URLS means somebody else owns the
  // instances — a deployed target, or a stack already running locally — so
  // this process spawns nothing, builds nothing, and must not assume it could.
  // ---------------------------------------------------------------------
  const externalTargets = process.env[RACE_BASE_URLS_ENV];
  const isExternal = externalTargets !== undefined && externalTargets.trim() !== "";
  const mode: RaceMode = isExternal ? "external" : "local";
  const rawRaceDatabaseUrl = process.env["RACE_DATABASE_URL"];
  const raceDatabaseUrl = rawRaceDatabaseUrl === undefined || rawRaceDatabaseUrl.trim() === "" ? undefined : rawRaceDatabaseUrl.trim();
  const wantsDemoReset = isEnabled("RACE_DEMO_RESET");

  const instances: RunningInstance[] = [];
  let activeCheck: ChildProcess | undefined;
  let shuttingDown = false;

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    activeCheck?.kill("SIGTERM");
    if (instances.length > 0) {
      console.log(`race: stopping ${String(instances.length)} instance(s) (pids ${instances.map((i) => String(i.pid)).join(", ")})...`);
      await stopAllApiInstances(instances);
      console.log("race: all instances stopped.");
    }
  }

  // Ctrl-C already reaches the children too (same process group), but a signal
  // sent to this pid alone does not — and either way the run must not report a
  // clean stop it did not perform. Cleanup first, then re-raise with the
  // handler removed, so whatever launched pnpm still sees a real interrupt.
  // Matches scripts/with-env.ts.
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    process.on(signal, () => {
      console.log(`\nrace: ${signal} — shutting down.`);
      void shutdown().then(() => {
        for (const other of signals) process.removeAllListeners(other);
        process.kill(process.pid, signal);
      });
    });
  }

  let baseUrls: readonly string[];

  try {
    if (isExternal) {
      // Validate here, not in each check: a typo should cost one line, not
      // four identical stack traces after a 30-second build.
      baseUrls = parseRaceBaseUrls(externalTargets);
      // The mode line: which targets, and — the R7 question — which database
      // the checks will see. "none" is the reviewer's run; "forwarded" the
      // author's. Nothing else on this run touches a database.
      console.log(
        `race: external target(s) ${baseUrls.join(", ")} — database: ` +
          (raceDatabaseUrl === undefined ? "none (assertions SKIP by name)" : "RACE_DATABASE_URL forwarded") +
          "\nrace: nothing built, nothing spawned, nothing stopped; the target's owner supplies the instances.",
      );
      if (baseUrls.length === 1) {
        console.log(
          "race: one target. Correct for a deployed shop, where the platform supplies the\n" +
            "race: separate instances. Locally it proves nothing — see architecture.md §7.",
        );
      }
      if (readAdminToken() === LOCAL_DEFAULT_ADMIN_TOKEN) {
        console.log(
          "race: ADMIN_TOKEN is the local default — export the target's token or the admin-guarded checks will answer 401",
        );
      }

      const [firstTarget] = baseUrls;
      if (firstTarget === undefined) throw new Error("RACE_BASE_URLS parsed to no origins");
      await warmUpTarget(firstTarget);

      if (raceDatabaseUrl === undefined) {
        // One banner for the whole run, not one per check: the checks each
        // name their skipped assertions when they get there.
        console.log(
          "race: ┌─ no DATABASE_URL for this run ──────────────────────────────────────────\n" +
            "race: │ every database-side assertion below is reported as SKIP by name — never counted as a pass;\n" +
            "race: │ orders these checks create stay on the target. Run `pnpm demo:reset` when the run ends,\n" +
            "race: │ or set RACE_DEMO_RESET=1 to have this runner call POST /api/admin/demo/reset after the last check.\n" +
            "race: └──────────────────────────────────────────────────────────────────────────",
        );
      }
    } else {
      if (wantsDemoReset) {
        // Ignored, and said once. The reset must never run against the local
        // harness — `resetDemoAfterRun` throws if it is ever reached here.
        console.log(
          "race: RACE_DEMO_RESET is set but this is local mode — ignored. Local checks clean up their own rows " +
            "and the harness asserts the baseline; the demo reset is external mode's affordance only.",
        );
      }
      const instanceCount = readPositiveInt("RACE_INSTANCES", DEFAULT_INSTANCE_COUNT);
      const basePort = readPositiveInt("RACE_BASE_PORT", DEFAULT_BASE_PORT);

      await preflightDatabase();

      if (isEnabled("RACE_SKIP_BUILD")) {
        console.log("race: RACE_SKIP_BUILD set — spawning from the existing dist/. NOT valid for RED validation.");
      } else {
        // The spawned processes run `dist/main.js`, so this is what makes a
        // source edit reach them. Skipping it silently runs the previous build
        // — which is how a RED validation "fails to fail".
        console.log("race: building @game-shop/db, @game-shop/contracts and @game-shop/api...");
        execFileSync("pnpm", ["run", "build:packages"], { cwd: REPO_ROOT, stdio: "inherit" });
        execFileSync("pnpm", ["--filter", "@game-shop/api", "run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
      }

      const databaseUrl = process.env.DATABASE_URL;
      if (databaseUrl === undefined) throw new Error("DATABASE_URL disappeared between preflight and startup");

      const verbose = isEnabled("RACE_VERBOSE");
      console.log(`race: starting ${String(instanceCount)} apps/api instance(s) from port ${String(basePort)}...`);

      await Promise.all(
        Array.from({ length: instanceCount }, async (_, index) => {
          const port = basePort + index;
          return startApiInstance({
            apiRoot: API_ROOT,
            port,
            databaseUrl,
            // The one caller of api-instance.ts that is genuinely "this
            // script" per architecture.md §9's "used only by seeds and the
            // 'webhook before order' script" — scripts/race/before-order.ts
            // needs to pre-choose the order id it delivers an early webhook
            // against. See api-instance.ts's header, "allowClientSuppliedOrderId
            // — OPT-IN, AND OFF UNLESS A CALLER ASKS": every other spawner
            // (the Vitest concurrency suite) leaves this unset and gets `false`.
            allowClientSuppliedOrderId: true,
            // Registered before the health poll, so a signal during startup
            // still tears this child down. See api-instance.ts's `onSpawn`.
            onSpawn: (instance) => instances.push(instance),
            onOutput: ({ stream, text }) => {
              if (stream === "stdout" && !verbose) return;
              process.stderr.write(
                text
                  .split("\n")
                  .filter((line) => line !== "")
                  .map((line) => `  [:${String(port)}] ${line}\n`)
                  .join(""),
              );
            },
          });
        }),
      );

      baseUrls = instances
        .slice()
        .sort((a, b) => a.port - b.port)
        .map((instance) => instance.baseUrl);

      console.log(
        `race: ${String(instances.length)} instance(s) healthy — ${baseUrls.join(", ")} ` +
          `(pids ${instances.map((i) => String(i.pid)).join(", ")})`,
      );

      // An instance that dies mid-run turns every later check into an
      // unexplained `fetch failed`. Say it once, plainly, when it happens.
      for (const instance of instances) {
        instance.child.once("exit", (code, signal) => {
          if (shuttingDown) return;
          console.error(
            `race: instance on port ${String(instance.port)} EXITED mid-run ` +
              `(code=${String(code)}, signal=${String(signal)}). Results below are not trustworthy.`,
          );
        });
      }
    }

    const childEnv = buildChildEnv(mode, baseUrls, raceDatabaseUrl);
    const timeoutMs = readPositiveInt("RACE_CHECK_TIMEOUT_MS", DEFAULT_CHECK_TIMEOUT_MS);
    const results: CheckResult[] = [];

    for (const check of checks) {
      if (shuttingDown) break;
      console.log(`\n${"─".repeat(72)}\nrace: ${check.name}\n${"─".repeat(72)}`);
      const result = await runCheck(check, childEnv, timeoutMs, (child) => {
        activeCheck = child;
      });
      activeCheck = undefined;
      results.push(result);
    }

    if (shuttingDown) {
      // Interrupted. A summary here would read as a verdict on a run that was
      // never finished — and the two checks it did get through say nothing
      // about the ones it did not.
      console.log(`\nrace: interrupted after ${String(results.length)} of ${String(checks.length)} check(s). No verdict.`);
      return EXIT_CHECK_FAILED;
    }

    // After the last check and before the verdict, so the transcript's
    // last database-shaped lines are the baseline the target was left at.
    // External mode only — see `resetDemoAfterRun`'s guard.
    let demoResetRefused = false;
    if (wantsDemoReset && mode === "external") {
      const [firstTarget] = baseUrls;
      if (firstTarget === undefined) throw new Error("RACE_BASE_URLS parsed to no origins");
      demoResetRefused = !(await resetDemoAfterRun(mode, firstTarget));
    }

    console.log(`\n${"═".repeat(72)}\nrace: summary\n${"═".repeat(72)}`);
    for (const result of results) {
      const verdict = result.skipped === true ? "SKIP" : result.ok ? "PASS" : "FAIL";
      console.log(`  ${verdict}  ${result.name.padEnd(24)} ${result.detail} (${String(result.durationMs)}ms)`);
    }
    const failed = results.filter((result) => !result.ok);
    const skipped = results.filter((result) => result.skipped === true);
    const ran = results.length;
    // Skipped checks are subtracted from BOTH sides of the ratio. Leaving them
    // in the denominator would read as "4/5 passed" — a reviewer's eye lands on
    // the missing one and calls it a failure; taking them out of the numerator
    // only would be the false pass this whole exit code exists to prevent.
    const attempted = ran - skipped.length;
    console.log(
      `race: ${String(attempted - failed.length)}/${String(attempted)} passed against ${String(baseUrls.length)} instance(s)` +
        (skipped.length === 0 ? "." : `, ${String(skipped.length)} skipped (${skipped.map((s) => s.name).join(", ")}).`),
    );

    if (demoResetRefused) {
      console.error("race: RACE_DEMO_RESET was requested and the reset did not run — the target is not at baseline.");
      return EXIT_USAGE;
    }
    return failed.length === 0 && ran === checks.length ? EXIT_OK : EXIT_CHECK_FAILED;
  } finally {
    // The only place instances are stopped. Reached on success, on a failing
    // check, on a thrown configuration error, and on a signal — which is the
    // whole point of putting it here rather than at the end of the happy path.
    await shutdown();
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`race: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = EXIT_USAGE;
}
