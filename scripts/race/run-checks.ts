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
 *   RACE_BASE_URLS=https://game-shop.vercel.app pnpm race
 *                                      the deployed target: nothing is spawned,
 *                                      nothing is built, the checks run as-is
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
 *      `./support/race-database.ts`), so `pnpm race` twice in a row works with
 *      no manual tidying. Functional spec §2.6 makes that a criterion.
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
import { RACE_BASE_URLS_ENV, parseRaceBaseUrls } from "./support/race-targets.ts";
import { openRaceDatabase } from "./support/race-database.ts";

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
      console.log(
        `race: using ${String(baseUrls.length)} externally supplied target(s) — ${baseUrls.join(", ")}\n` +
          "race: nothing built, nothing spawned, nothing stopped; the target's owner supplies the instances.",
      );
      if (baseUrls.length === 1) {
        console.log(
          "race: one target. Correct for a deployed shop, where the platform supplies the\n" +
            "race: separate instances. Locally it proves nothing — see architecture.md §7.",
        );
      }
    } else {
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

    const childEnv: NodeJS.ProcessEnv = { ...process.env, [RACE_BASE_URLS_ENV]: baseUrls.join(",") };
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
