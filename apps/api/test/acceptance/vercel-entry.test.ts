// @layer: integration
// @spec: 006-live-shop-and-the-written-answer
/**
 * The Slice 1 acceptance suite for
 * `context/spec/006-live-shop-and-the-written-answer/functional-spec.md` —
 * proving `apps/api/src/vercel.ts` behaves exactly as `./create-app.ts` and
 * `main.ts` do, driven the way Vercel would actually drive it: **not** as a
 * listening `dist/main.js` process, but as `handler(req, res)` wired straight
 * onto `node:http`'s own `createServer`, with nothing else in front of it.
 * `../concurrency/support/api-instance.ts` spawns `dist/main.js` on a port it
 * chose; that mechanism is deliberately not reused here, because the whole
 * point of this file is the seam `dist/main.js` never exercises at all — a
 * request arriving with no listening socket already in front of it, answered
 * by the handler's own cached-promise bootstrap.
 *
 * ---------------------------------------------------------------------------
 * WHY A HAND-WRITTEN DRIVER, NOT `startApiInstance`
 * ---------------------------------------------------------------------------
 * `startApiInstance` spawns `node dist/main.js`, which calls `createApp()`,
 * `enableShutdownHooks()` and `listen()` itself — the *local* entry. Nothing
 * about that path ever imports `vercel.ts`, so a suite built on top of it
 * would prove `create-app.ts` again and call it deployment coverage. This
 * file spawns a **driver script of its own**: a few lines written to a temp
 * `.mjs` file at `beforeAll` time, `import`ing the compiled
 * `apps/api/dist/vercel.js` and handing its default export straight to
 * `http.createServer(...).listen(port)` — which is exactly what `@vercel/node`
 * does on the platform, minus the platform. Teardown (`SIGTERM` → `SIGKILL`
 * escalation) is genuinely shared with `api-instance.ts`'s
 * `stopApiInstance`, imported here rather than duplicated: it only ever reads
 * `instance.child`, and a plain `{ baseUrl, port, pid, child }` built around
 * this file's own spawned process satisfies that shape exactly.
 *
 * ---------------------------------------------------------------------------
 * THE ENVIRONMENT — REPLICATED, NOT IMPORTED
 * ---------------------------------------------------------------------------
 * `api-instance.ts` builds a spawned instance's environment inline inside
 * `startApiInstance` (own-origin `PAYMENT_WEBHOOK_URL`/`SUPPLIER_A_URL`/
 * `SUPPLIER_B_URL`, `SUPPLIER_TIMEOUT_MS`, `WEB_API_BASE_URL`, `DATABASE_URL`)
 * — there is no separately exported helper to import, so the minimum needed
 * here is replicated by hand below, matching that file's own values and
 * reasoning line for line (`startVercelDriver`). One line is *not* copied:
 * `API_PORT`. The driver never calls `app.listen()` itself — `vercel.ts` has
 * no port of its own — so nothing reads that variable. `ADMIN_TOKEN` is not
 * set here either, for the same reason `api-instance.ts` does not set it:
 * both rely on `...process.env` already carrying it, inherited from
 * `scripts/with-env.ts`'s merge of `.env.example`, which is how every suite
 * in this directory is run (see "Run it", below) — see this file's
 * "A GUARD'S REFUSAL" section for why that inheritance is load-bearing here.
 * `VERCEL` is deliberately left unset: this suite's `runtime` assertion reads
 * `"node"`, which is exactly what an unset `VERCEL` produces
 * (`./health.controller.ts`) — setting it would test the platform branch's
 * logging option, not this file's subject.
 *
 * ---------------------------------------------------------------------------
 * ONE PORT, TWO INSTANCES, NEVER AT THE SAME TIME
 * ---------------------------------------------------------------------------
 * `tasks.md`'s standing requirement fixes this file to port **5401** alone —
 * not a range. The healthy-instance describe block and the
 * misconfigured-instance describe block each spawn their own driver on 5401
 * and stop it in their own `afterAll` before the next block's `beforeAll`
 * runs (Vitest's own ordering guarantee for nested `describe`s), so the port
 * is never held by two processes at once and nothing beyond 5401 is ever
 * bound.
 *
 * ---------------------------------------------------------------------------
 * A GUARD'S REFUSAL: WHY THE SWEEP ENDPOINT AND NOT SOME OTHER 401
 * ---------------------------------------------------------------------------
 * `POST /api/admin/payment-events/sweep` is the one route already proven, in
 * isolation, to answer 401 for a missing token when `ADMIN_TOKEN` **is**
 * configured (`../unit/admin-token-guard.test.ts`) — as opposed to 503, which
 * is what an *unconfigured* token produces. This file needs the 401 branch
 * specifically, because the property under test is "the header survives a
 * guard's short-circuit", not "the guard exists" — so `ADMIN_TOKEN` must be
 * set on the spawned driver, which it is, by inheritance (see above).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * `GET /api/products`, the full order lifecycle, payment, delivery — every
 * domain behaviour `../acceptance/purchase-and-key-delivery.test.ts` and its
 * siblings already prove against `dist/main.js`. `tasks.md`'s standing rule
 * for this whole phase is explicit: *"Nothing about the shop's behaviour
 * changes."* This file's only subject is the entry point — that the same
 * container answers the same way through a different door, that the
 * `x-instance-id` header reaches every kind of response (success, 404, a
 * guard's refusal), and that a boot failure answers `503` for the instance's
 * whole life rather than rebooting per request.
 *
 * ---------------------------------------------------------------------------
 * RED VALIDATION
 * ---------------------------------------------------------------------------
 * The implementation this file tests already exists (Slice 1's first two
 * tasks), so — as `./promo-codes.test.ts`'s header puts it for the same
 * situation — "RED" here means a temporary, targeted inversion of what a test
 * asserts, run to see it fail for the stated reason, then reverted
 * byte-identical. **No production source under `src/` was touched.** Two
 * inversions, applied and run separately:
 *
 *   1. "body `instance_id` equals the `x-instance-id` header" — inverted to
 *      `.not.toBe(headerInstanceId)`, asserting the opposite of the file's own
 *      claim:
 *        AssertionError: body instance_id must equal the x-instance-id header: expected '<uuid>' to not be '<uuid>'
 *   2. "a misconfigured instance answers 503" — inverted to `.toBe(200)`:
 *        AssertionError: a misconfigured instance answers 503 for its whole life: expected 503 to be 200
 *
 * Command and results are quoted in full in the completion report; both
 * failed for exactly the stated reason and nothing else, then were reverted
 * and re-run GREEN.
 *
 * Run it: `node scripts/with-env.ts pnpm --filter @game-shop/api exec vitest
 * run test/acceptance/vercel-entry.test.ts` from the repository root — the env
 * wrapper supplies `DATABASE_URL` and `ADMIN_TOKEN` from `.env.example`/`.env`,
 * exactly as `./promo-codes.test.ts` is run.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { DatabaseClient } from "@game-shop/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type RunningInstance,
  stopApiInstance,
} from "../concurrency/support/api-instance.js";
import {
  PURCHASABLE_SKU,
  assertBaseline,
  cleanupTestOrders,
  createTestDatabaseClient,
  readBaselineCounts,
} from "../concurrency/support/db.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
/** `apps/api` — two levels up from `test/acceptance`. */
const API_ROOT = resolve(TEST_DIR, "..", "..");
/** The repository root — where `pnpm run build:packages` resolves from. */
const REPO_ROOT = resolve(API_ROOT, "..", "..");
/** The compiled deployment entry this whole file exists to drive. */
const DIST_VERCEL_PATH = join(API_ROOT, "dist", "vercel.js");

/**
 * Fixed by `tasks.md`'s standing requirement: "Ports 5401
 * (`vercel-entry.test.ts`) and 5402 (`demo-routes.test.ts`), listed in
 * `scripts/race/README.md`'s row; nothing else may bind them." One port for
 * the whole file — see this file's header, "ONE PORT, TWO INSTANCES".
 */
const PORT = 5401;
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;

const HEALTH_POLL_INTERVAL_MS = 50;
/** Matches `api-instance.ts`'s own bound and its own measured reason. */
const HEALTH_POLL_TIMEOUT_MS = 60_000;

/**
 * Every temp directory a driver script was written into, across the whole
 * file — module scope rather than threaded through return values, so
 * `startVercelDriver` can record its own directory the moment it creates one
 * and the outer `afterAll` below can remove all of them regardless of which
 * describe block created which.
 */
const driverTempDirs: string[] = [];

function delay(ms: number): Promise<void> {
  return new Promise((doneWaiting) => {
    setTimeout(doneWaiting, ms);
  });
}

interface StartVercelDriverOptions {
  readonly databaseUrl: string;
  /** Overrides layered onto the replicated `api-instance.ts` baseline below. */
  readonly envOverrides?: Record<string, string>;
}

/**
 * Write the tiny driver script `beforeAll` needs and spawn it: `node`
 * importing the compiled `dist/vercel.js` handler and handing it straight to
 * `http.createServer(...).listen(PORT)` — the shape `@vercel/node` itself
 * calls the handler through, minus the platform.
 *
 * Polls `GET /api/health` until *any* response arrives (`200` healthy, `503`
 * misconfigured) rather than until `response.ok`: `vercel.ts`'s handler
 * itself `await`s the cached boot promise before answering anything, so the
 * very first response already reflects the instance's final boot outcome —
 * there is no separate "still booting" status this poll needs to wait past.
 */
async function startVercelDriver(options: StartVercelDriverOptions): Promise<RunningInstance> {
  const { databaseUrl, envOverrides = {} } = options;

  const driverDir = await mkdtemp(join(tmpdir(), "vercel-entry-driver-"));
  driverTempDirs.push(driverDir);
  const driverPath = join(driverDir, "driver.mjs");
  await writeFile(
    driverPath,
    [
      `import { createServer } from "node:http";`,
      `import handler from ${JSON.stringify(DIST_VERCEL_PATH)};`,
      ``,
      `createServer(handler).listen(${String(PORT)});`,
      ``,
    ].join("\n"),
    "utf8",
  );

  const child = spawn(process.execPath, [driverPath], {
    cwd: API_ROOT,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      // Own-origin, matching api-instance.ts's own reasoning: this instance's
      // webhook and supplier calls loop back to itself.
      PAYMENT_WEBHOOK_URL: `${BASE_URL}/api/webhooks/payment`,
      SUPPLIER_A_URL: `${BASE_URL}/internal/suppliers/a`,
      SUPPLIER_B_URL: `${BASE_URL}/internal/suppliers/b`,
      SUPPLIER_TIMEOUT_MS: "2000",
      WEB_API_BASE_URL: BASE_URL,
      ...envOverrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stderrChunks: Buffer[] = [];
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`vercel-entry driver on port ${String(PORT)} started with no pid`);
  }

  const deadline = Date.now() + HEALTH_POLL_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `vercel-entry driver on port ${String(PORT)} exited before responding ` +
          `(code=${String(child.exitCode)}, signal=${String(child.signalCode)})\n` +
          `--- stderr ---\n${Buffer.concat(stderrChunks).toString("utf8")}`,
      );
    }

    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.status === 200 || response.status === 503) break;
    } catch {
      // Not listening yet. Keep polling.
    }

    if (Date.now() > deadline) {
      throw new Error(
        `vercel-entry driver on port ${String(PORT)} did not answer /api/health within ` +
          `${String(HEALTH_POLL_TIMEOUT_MS)}ms\n--- stderr ---\n${Buffer.concat(stderrChunks).toString("utf8")}`,
      );
    }
    await delay(HEALTH_POLL_INTERVAL_MS);
  }

  return { baseUrl: BASE_URL, port: PORT, pid, child };
}

interface HealthBody {
  readonly status: "ok";
  readonly service: "api";
  readonly instance_id: string;
  readonly runtime: "vercel" | "node";
  readonly supplier_timeout_ms: number;
}

interface MisconfiguredBody {
  readonly status: "misconfigured";
  readonly error: string;
}

describe("functional spec 006-live-shop-and-the-written-answer — the deployment entry, driven through node:http (port 5401)", () => {
  let db: DatabaseClient;
  let databaseUrl: string;

  beforeAll(async () => {
    const configuredDatabaseUrl = process.env["DATABASE_URL"];
    if (configuredDatabaseUrl === undefined || configuredDatabaseUrl === "") {
      throw new Error(
        "DATABASE_URL is not set. Run this suite through `node scripts/with-env.ts pnpm --filter " +
          "@game-shop/api exec vitest run test/acceptance/vercel-entry.test.ts` from the repository root, " +
          "which loads the local environment first.",
      );
    }
    if (process.env["ADMIN_TOKEN"] === undefined || process.env["ADMIN_TOKEN"] === "") {
      throw new Error(
        "ADMIN_TOKEN is not set — the guard's-refusal-carries-the-header test needs the admin surface " +
          "CONFIGURED (401 for a missing token), not disabled (503). Run through scripts/with-env.ts, as above.",
      );
    }
    databaseUrl = configuredDatabaseUrl;

    db = createTestDatabaseClient("acceptance-006-vercel-entry");
    assertBaseline(await readBaselineCounts(db), "before");

    // Rebuilding from current source is what makes RED validation meaningful
    // — see ../concurrency/support/api-instance.ts's header.
    console.log("vercel-entry: building @game-shop/db, @game-shop/contracts and @game-shop/api...");
    execFileSync("pnpm", ["run", "build:packages"], { cwd: REPO_ROOT, stdio: "inherit" });
    execFileSync("pnpm", ["--filter", "@game-shop/api", "run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
  }, 120_000);

  afterAll(async () => {
    for (const dir of driverTempDirs) {
      await rm(dir, { recursive: true, force: true });
    }

    if (db !== undefined) {
      assertBaseline(await readBaselineCounts(db), "after");
      await db.close();
    }
  }, 60_000);

  // =========================================================================
  describe("a healthy instance", () => {
    let instance: RunningInstance;

    beforeAll(async () => {
      instance = await startVercelDriver({ databaseUrl });
    }, 60_000);

    afterAll(async () => {
      // These are this file's own children, spawned directly above — killed
      // by pid here, not left to some wrapper's teardown.
      if (instance !== undefined) await stopApiInstance(instance);
    }, 15_000);

    it("GET /api/health -> 200, body instance_id equals the x-instance-id header, runtime is node, supplier_timeout_ms matches the spawned env", async () => {
      const response = await fetch(`${instance.baseUrl}/api/health`);
      expect(response.status).toBe(200);

      const headerInstanceId = response.headers.get("x-instance-id");
      expect(headerInstanceId, "the x-instance-id header must be present").not.toBeNull();

      const body = (await response.json()) as HealthBody;
      // CAN FAIL: inverted to `.not.toBe(headerInstanceId)` and re-run — see
      // this file's header, RED VALIDATION item 1:
      //   AssertionError: body instance_id must equal the x-instance-id header: expected '<uuid>' to not be '<uuid>'
      expect(body.instance_id, "body instance_id must equal the x-instance-id header").toBe(headerInstanceId);
      expect(body.runtime, "driven through node:http directly, never VERCEL — runtime is node").toBe("node");
      expect(body.supplier_timeout_ms, "supplier_timeout_ms echoes the spawned env's SUPPLIER_TIMEOUT_MS").toBe(
        2000,
      );
    });

    it("two requests to the same instance return the same instance_id", async () => {
      const first = await fetch(`${instance.baseUrl}/api/health`);
      const firstBody = (await first.json()) as HealthBody;

      const second = await fetch(`${instance.baseUrl}/api/health`);
      const secondBody = (await second.json()) as HealthBody;

      expect(secondBody.instance_id, "one process, minted once — the same id on a second request").toBe(
        firstBody.instance_id,
      );
    });

    it("GET /api/nope -> Nest's own JSON 404 shape, carrying the header (negative: an unknown route)", async () => {
      const response = await fetch(`${instance.baseUrl}/api/nope`);
      expect(response.status).toBe(404);
      expect(
        response.headers.get("x-instance-id"),
        "the header is Express middleware, ahead of the router — it covers a 404 too",
      ).not.toBeNull();

      const body = (await response.json()) as { readonly statusCode: number; readonly error: string };
      expect(body.statusCode).toBe(404);
      expect(body.error).toBe("Not Found");
    });

    it("POST /api/admin/payment-events/sweep without a token -> 401, carrying the header (negative: a guard's refusal)", async () => {
      const response = await fetch(`${instance.baseUrl}/api/admin/payment-events/sweep`, { method: "POST" });

      expect(response.status, "ADMIN_TOKEN is configured (inherited env) — no token presented is 401, not 503").toBe(
        401,
      );
      expect(
        response.headers.get("x-instance-id"),
        "the header is Express middleware, ahead of Nest's guards — a 401 short-circuit still carries it",
      ).not.toBeNull();
    });

    it("POST /api/orders with a JSON body -> 201, body parsed through the handler (Nest's body parser runs behind node:http too)", async () => {
      const response = await fetch(`${instance.baseUrl}/api/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sku: PURCHASABLE_SKU }),
      });

      let orderId: string | undefined;
      try {
        expect(response.status, `POST /api/orders -> ${String(response.status)}`).toBe(201);
        expect(response.headers.get("x-instance-id")).not.toBeNull();

        const body = (await response.json()) as { readonly id: string; readonly sku: string };
        orderId = body.id;
        expect(body.sku).toBe(PURCHASABLE_SKU);
      } finally {
        if (orderId !== undefined) await cleanupTestOrders(db, [orderId]);
      }
    });
  });

  // =========================================================================
  describe("a misconfigured instance (SUPPLIER_TIMEOUT_MS=abc)", () => {
    let instance: RunningInstance;

    beforeAll(async () => {
      instance = await startVercelDriver({ databaseUrl, envOverrides: { SUPPLIER_TIMEOUT_MS: "abc" } });
    }, 60_000);

    afterAll(async () => {
      if (instance !== undefined) await stopApiInstance(instance);
    }, 15_000);

    it("GET /api/health -> 503 { status: 'misconfigured', error naming SUPPLIER_TIMEOUT_MS }, header present", async () => {
      const response = await fetch(`${instance.baseUrl}/api/health`);
      // CAN FAIL: inverted to `.toBe(200)` and re-run — see this file's
      // header, RED VALIDATION item 2:
      //   AssertionError: a misconfigured instance answers 503 for its whole life: expected 503 to be 200
      expect(response.status, "a misconfigured instance answers 503 for its whole life").toBe(503);
      expect(
        response.headers.get("x-instance-id"),
        "set by hand in the handler's catch branch — Express never ran",
      ).not.toBeNull();

      const body = (await response.json()) as MisconfiguredBody;
      expect(body.status).toBe("misconfigured");
      expect(body.error, "the ConfigurationError names the variable").toContain("SUPPLIER_TIMEOUT_MS");
    });

    it("a second request gets the identical 503 and the same instance id — the process is alive, not rebooting per request (negative: no retry)", async () => {
      const first = await fetch(`${instance.baseUrl}/api/health`);
      const firstBody = (await first.json()) as MisconfiguredBody;
      const firstInstanceId = first.headers.get("x-instance-id");

      const second = await fetch(`${instance.baseUrl}/api/health`);
      const secondBody = (await second.json()) as MisconfiguredBody;
      const secondInstanceId = second.headers.get("x-instance-id");

      expect(second.status).toBe(503);
      expect(secondBody, "the cached, rejected promise answers identically on every call").toEqual(firstBody);
      expect(secondInstanceId, "still the same process, not a fresh one").toBe(firstInstanceId);
      expect(
        instance.child.exitCode,
        "the process is alive — a misconfigured instance answers 503 rather than crashing or exiting",
      ).toBeNull();
    });
  });
});
