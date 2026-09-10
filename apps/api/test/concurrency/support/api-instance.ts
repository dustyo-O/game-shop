// @layer: integration
// @spec: 001-purchase-and-key-delivery
/**
 * Spawns and stops real, separate OS processes running `apps/api`'s compiled
 * `dist/main.js` — the harness that makes the concurrency proof in
 * `../key-claim-race.test.ts` genuine rather than illusory.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE HAS TO EXIST AT ALL
 * ---------------------------------------------------------------------------
 * `packages/db/src/client.ts` gives every process a connection pool of
 * `max: 1`. Inside one process, `db.transaction()` checks that single
 * connection out for the whole transaction, so a second concurrent call to the
 * key-claim transaction cannot even start until the first one finishes — it
 * queues in Node, before Postgres ever sees a second statement.
 * `docs/walkthrough/slice-4-supplier-idempotency.md` §9 measured exactly this
 * and named the consequence precisely: *"a claim written without any locking
 * behaves identically to the shipped one"* in a single process, because there
 * is never a second in-flight transaction for `SKIP LOCKED` to skip past.
 * Twenty concurrent claims in one process produced twenty distinct keys even
 * with the locking removed; the same claim, weakened the same way, produced
 * nine distinct keys once the calls were spread across four processes.
 *
 * So a Vitest test that fires N concurrent HTTP calls at **one** running
 * `apps/api` process is not a race test. It is a queue test wearing a race
 * test's clothes, and it would pass against a broken claim. The only way to
 * make N claims genuinely overlap inside Postgres is to give them N separate
 * connections held open by N separate processes — which is what spawning real
 * child processes, each with its own pool of one, buys that an in-process
 * `Promise.all` cannot.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COMPILED `dist/main.js`, NOT `nest start` OR TS SOURCE DIRECTLY
 * ---------------------------------------------------------------------------
 * NestJS reads constructor parameter types from
 * `emitDecoratorMetadata`-produced metadata, which only TypeScript's compiler
 * emits — Node's built-in type-stripping (the mechanism `scripts/with-env.ts`
 * relies on) erases type annotations without evaluating them, so it cannot
 * produce that metadata and dependency injection would fail. The test's
 * `beforeAll` therefore runs the real `apps/api` build (`tsc -p
 * tsconfig.build.json`) before spawning anything, which has one important
 * consequence for RED validation: **rebuilding is what makes a source edit to
 * `supplier-key-claim.service.ts` reach the processes this file spawns.** A
 * child process started from a stale `dist/` would silently keep running the
 * old, correct claim regardless of what the source on disk says.
 *
 * ---------------------------------------------------------------------------
 * WHY EACH INSTANCE POINTS `PAYMENT_WEBHOOK_URL` AND `SUPPLIER_A_URL` AT ITSELF
 * ---------------------------------------------------------------------------
 * Matches the shape `docs/walkthrough/slice-5-issuance.md` §1 and §3 measured
 * by hand: each spawned instance's webhook and supplier calls loop back to its
 * own port. That keeps every instance self-contained — issuing a payment
 * through instance 2 makes instance 2 alone respond to its own webhook and its
 * own supplier call — while every instance still shares the one thing that
 * has to be shared for the race to mean anything: `DATABASE_URL`, and through
 * it, `supplier_keys`.
 *
 * ---------------------------------------------------------------------------
 * `allowClientSuppliedOrderId` — OPT-IN, AND OFF UNLESS A CALLER ASKS
 * ---------------------------------------------------------------------------
 * `ALLOW_CLIENT_SUPPLIED_ORDER_ID` (`apps/api/src/config/
 * client-supplied-order-id.ts`) is the test affordance `architecture.md` §9
 * records: `POST /api/orders` accepts an explicit `id` only when this is set,
 * because `scripts/race/before-order.ts` has to pre-choose an order id to
 * deliver an early webhook against before the order exists. It is **not**
 * turned on unconditionally here. This module also spawns the instances
 * `../key-claim-race.test.ts` and `../order-lock-race.test.ts` use, and those
 * suites have no business with a client-chosen id — widening what they accept
 * "for free" would be exactly the scope creep §9 warns against ("used only by
 * seeds and this script"). So it is a plain opt-in field, defaulting to unset
 * (→ `false` in the child, per `readBooleanFlag`), and only
 * `scripts/race/run-checks.ts` — the one caller that is genuinely "this
 * script" — passes it as `true`.
 */
import { type ChildProcess, spawn } from "node:child_process";

const HEALTH_POLL_INTERVAL_MS = 50;
const HEALTH_POLL_TIMEOUT_MS = 15_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

/**
 * How much of a child's stderr is retained for the "did not become healthy"
 * message when nobody is streaming it live.
 *
 * The cap exists because the capture listener stays attached for the whole
 * life of the process, not just for the startup window: an instance that runs
 * for the length of `pnpm race` and logs on every request would otherwise
 * accumulate its entire log in the parent's heap, for a buffer that is only
 * ever read if startup failed — which, by then, it did not. 64 KiB is far more
 * than a Nest boot failure produces and small enough to be irrelevant.
 */
const STDERR_CAPTURE_LIMIT_BYTES = 64 * 1024;

export interface ApiInstanceHandle {
  /** `http://127.0.0.1:{port}` — every URL this instance's own webhook and supplier calls loop back to. */
  readonly baseUrl: string;
  readonly port: number;
  readonly pid: number;
}

export interface RunningInstance extends ApiInstanceHandle {
  readonly child: ChildProcess;
}

/** One chunk of a spawned instance's output, as handed to {@link StartApiInstanceOptions.onOutput}. */
export interface ApiInstanceOutput {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

export interface StartApiInstanceOptions {
  /** `apps/api` — the directory containing the just-built `dist/main.js`. */
  readonly apiRoot: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly supplierTimeoutMs?: number;
  /**
   * Set `ALLOW_CLIENT_SUPPLIED_ORDER_ID=true` in the spawned instance's
   * environment. Optional, and off (unset) unless a caller asks — see this
   * file's header, "`allowClientSuppliedOrderId` — OPT-IN, AND OFF UNLESS A
   * CALLER ASKS". Only `scripts/race/run-checks.ts` passes `true`.
   */
  readonly allowClientSuppliedOrderId?: boolean;
  /**
   * Called for every chunk this instance writes to stdout or stderr, for the
   * whole life of the process. Optional, and off by default.
   *
   * Added for `scripts/race/run-checks.ts`, which is the first caller that
   * outlives its own startup: a Vitest suite either passes or prints a
   * stack trace, but a reviewer watching `pnpm race` for thirty seconds needs
   * to see an instance that died at request forty rather than reading four
   * identical `fetch failed` lines and guessing. Deliberately a callback and
   * not a boolean: prefixing, filtering and verbosity are the runner's policy,
   * and keeping them there leaves this module with one job.
   *
   * Chunks are not line-buffered — a caller that wants whole lines must
   * assemble them.
   */
  readonly onOutput?: (output: ApiInstanceOutput) => void;
  /**
   * Called with the handle the moment the child exists, **before** the health
   * poll — so a caller can register it for teardown while it is still booting.
   *
   * The window this closes is small and real. `startApiInstance` does not
   * resolve until the instance answers `/api/health`, so a caller that only
   * records the resolved value has nothing to kill for the first second or so
   * of each instance's life. In Vitest that is harmless: `afterAll` cannot run
   * until `beforeAll` has returned. In `scripts/race/run-checks.ts` it is not
   * — a `SIGTERM` to the runner during startup would leave a booting `apps/api`
   * behind, listening on port 4201, for the reviewer to discover later. (An
   * interactive Ctrl-C happens to be survivable, because the signal goes to the
   * whole process group and reaches the child directly; a signal sent to the
   * runner's pid alone does not.)
   */
  readonly onSpawn?: (instance: RunningInstance) => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Poll `GET /api/health` until it answers `200`, or give up.
 *
 * Polling rather than parsing stdout for a "listening" line: it is the same
 * check a load balancer would make, it works whether or not the child's
 * stdout has been captured, and it directly proves the property the caller
 * actually needs — this instance can now serve a real HTTP request.
 */
async function waitUntilHealthy(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `apps/api instance at ${baseUrl} exited before becoming healthy ` +
          `(code=${String(child.exitCode)}, signal=${String(child.signalCode)})`,
      );
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet, or still binding. Keep polling.
    }

    await delay(HEALTH_POLL_INTERVAL_MS);
  }

  throw new Error(`apps/api instance at ${baseUrl} did not become healthy within ${String(HEALTH_POLL_TIMEOUT_MS)}ms`);
}

/**
 * Start one `apps/api` process on its own port, and wait for it to answer
 * `GET /api/health`.
 *
 * Every environment variable the process reads at boot
 * (`apps/api/src/config/env.ts`) is set explicitly rather than inherited, so
 * four instances never race each other on a shared `API_PORT`.
 */
export async function startApiInstance(options: StartApiInstanceOptions): Promise<RunningInstance> {
  const {
    apiRoot,
    port,
    databaseUrl,
    supplierTimeoutMs = 2000,
    allowClientSuppliedOrderId = false,
    onOutput,
    onSpawn,
  } = options;
  const baseUrl = `http://127.0.0.1:${String(port)}`;

  const child = spawn(
    process.execPath,
    ["dist/main.js"],
    {
      cwd: apiRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        API_PORT: String(port),
        // Self-loop, matching docs/walkthrough/slice-5-issuance.md §1: this
        // instance's own webhook and supplier calls stay inside this instance.
        PAYMENT_WEBHOOK_URL: `${baseUrl}/api/webhooks/payment`,
        SUPPLIER_A_URL: `${baseUrl}/internal/suppliers/a`,
        SUPPLIER_TIMEOUT_MS: String(supplierTimeoutMs),
        WEB_API_BASE_URL: baseUrl,
        // Explicit in both directions, never left to inherit: a `true` sitting
        // in whoever's shell launched this process must not leak into a suite
        // that never asked for it, and a caller that *did* ask gets a real
        // "true" rather than hoping process.env already agreed. See this
        // file's header, "allowClientSuppliedOrderId — OPT-IN, AND OFF UNLESS
        // A CALLER ASKS".
        ALLOW_CLIENT_SUPPLIED_ORDER_ID: String(allowClientSuppliedOrderId),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  // Startup diagnostics: stderr is retained (bounded) purely so a failure to
  // become healthy can quote what the process said before giving up. Live
  // streaming is a separate concern and goes through `onOutput`.
  const stderrChunks: Buffer[] = [];
  let stderrBytes = 0;

  function capture(stream: "stdout" | "stderr", chunk: Buffer): void {
    onOutput?.({ stream, text: chunk.toString("utf8") });
    if (stream !== "stderr" || stderrBytes >= STDERR_CAPTURE_LIMIT_BYTES) return;
    stderrBytes += chunk.length;
    stderrChunks.push(chunk);
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    capture("stdout", chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    capture("stderr", chunk);
  });

  child.on("error", (error: Error) => {
    throw new Error(`apps/api instance on port ${String(port)} failed to start: ${error.message}`);
  });

  // Register for teardown before waiting on health — see `onSpawn`.
  if (child.pid !== undefined) onSpawn?.({ baseUrl, port, pid: child.pid, child });

  try {
    await waitUntilHealthy(baseUrl, child);
  } catch (error) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}` +
        (stderr === "" ? "" : `\n--- stderr from port ${String(port)} ---\n${stderr}`),
    );
  }

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`apps/api instance on port ${String(port)} started with no pid`);
  }

  return { baseUrl, port, pid, child };
}

/**
 * Stop one spawned instance: `SIGTERM`, then wait for the process to actually
 * exit (which is `app.enableShutdownHooks()` in `apps/api/src/main.ts`
 * running Nest's `onModuleDestroy` — `DatabaseModule` draining its pool —
 * before the process exits), rather than firing the signal and moving on.
 * Escalates to `SIGKILL` if the process ignores `SIGTERM`.
 */
export async function stopApiInstance(instance: RunningInstance): Promise<void> {
  const { child } = instance;
  if (child.exitCode !== null || child.signalCode !== null) return;

  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => {
      resolve();
    });
  });

  child.kill("SIGTERM");

  const timedOut = await Promise.race([
    exited.then(() => false),
    delay(SHUTDOWN_TIMEOUT_MS).then(() => true),
  ]);

  if (timedOut) {
    child.kill("SIGKILL");
    await exited;
  }
}

export async function stopAllApiInstances(instances: readonly RunningInstance[]): Promise<void> {
  await Promise.all(instances.map((instance) => stopApiInstance(instance)));
}
