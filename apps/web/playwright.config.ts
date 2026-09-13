/**
 * The Playwright project that proves the storefront's five graded
 * interactions, the inert controls, and the buy-through in a real browser a
 * reviewer can run — `technical-considerations.md` §4.2.
 *
 * ---------------------------------------------------------------------------
 * TWO DEDICATED PORTS, NOT THE DEVELOPER'S `pnpm dev`
 * ---------------------------------------------------------------------------
 * 5101 (Vite) and 5102 (API) are owned by this project alone (tech spec R19):
 * reusing 5173/3000 would mean HMR state, a possibly stale API build, and a
 * collision with every port `scripts/race/README.md` already lists. Both
 * servers below run with `reuseExistingServer: false` so a stray process left
 * on either port fails loudly instead of this run silently testing against
 * whatever was already there.
 *
 * ---------------------------------------------------------------------------
 * WHY THE API'S FIVE ENV LINES MATCH `api-instance.ts`
 * ---------------------------------------------------------------------------
 * `apps/api/test/concurrency/support/api-instance.ts` (the Vitest concurrency
 * harness) spawns real `apps/api` instances the same way: `API_PORT` plus
 * `PAYMENT_WEBHOOK_URL`, `SUPPLIER_A_URL` and `SUPPLIER_B_URL` all pointing
 * back at that same instance's own port, so its webhook and supplier calls
 * loop back to itself rather than to whatever the developer's `.env` names —
 * see that file's "WHY EACH INSTANCE POINTS ... AT ITSELF" section for the
 * reasoning in full. `WEB_API_BASE_URL` is the fifth line, read by
 * `vite.config.ts` to target the dev server's own `/api` and `/internal`
 * proxy at this same API instance.
 *
 * `DATABASE_URL` and `ADMIN_TOKEN` are deliberately **not** set here: the root
 * `test:e2e` script runs this whole config through
 * `node scripts/with-env.ts pnpm --filter @game-shop/web run test:e2e`, so by
 * the time this file is evaluated `process.env` already carries them (loaded
 * from `.env.example` < `.env` < the real environment), and Playwright merges
 * `webServer.env` on top of `process.env` rather than replacing it — the two
 * port-specific env blocks below only need to override what genuinely differs
 * per server.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, defineConfig, devices } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");

const WEB_PORT = 5101;
const API_PORT = 5102;
const webBaseUrl = `http://localhost:${String(WEB_PORT)}`;
const apiBaseUrl = `http://localhost:${String(API_PORT)}`;

/**
 * Preflight #1: `DATABASE_URL` missing means this was run as bare
 * `pnpm --filter @game-shop/web run test:e2e` (or `playwright test` directly
 * inside `apps/web`), skipping the root script that loads the local
 * environment and builds the API first.
 */
if (process.env["DATABASE_URL"] === undefined || process.env["DATABASE_URL"] === "") {
  throw new Error(
    "DATABASE_URL is not set — run pnpm test:e2e from the repository root, " +
      "which loads the local environment first (scripts/with-env.ts) and " +
      "builds @game-shop/api before this config's webServer starts it.",
  );
}

/**
 * Preflight #2: a fresh clone or CI image has no browsers downloaded.
 * `chromium.executablePath()` resolves the path this Playwright version
 * expects without requiring it to exist, so `existsSync` is a cheap, reliable
 * "is it actually there" check — cheaper than letting the first test fail
 * deep inside browser launch with a less quotable error.
 */
if (!existsSync(chromium.executablePath())) {
  throw new Error(
    "Chromium is not installed for Playwright — run: pnpm exec playwright install chromium",
  );
}

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",

  // One shared database and a 50-key pool — the same reason the API's own
  // Vitest config serialises files (tech spec §4.2).
  fullyParallel: false,
  workers: 1,

  // A test that passes on the second try is a false statement, not a pass.
  retries: 0,

  reporter: "list",
  outputDir: "e2e/.results",

  expect: {
    timeout: 5_000,
  },

  use: {
    baseURL: webBaseUrl,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],

  webServer: [
    {
      // Runs from the repo root so `pnpm --filter` can resolve the
      // workspace; `root test:e2e` has already run
      // `pnpm --filter @game-shop/api run build`, so `dist/main.js` exists
      // by the time this starts it.
      command: "pnpm --filter @game-shop/api run start",
      cwd: repoRoot,
      url: `${apiBaseUrl}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        API_PORT: String(API_PORT),
        // Self-loop, matching api-instance.ts's "WHY EACH INSTANCE POINTS
        // ... AT ITSELF": this instance's own webhook and supplier calls
        // stay inside this instance.
        PAYMENT_WEBHOOK_URL: `${apiBaseUrl}/api/webhooks/payment`,
        SUPPLIER_A_URL: `${apiBaseUrl}/internal/suppliers/a`,
        SUPPLIER_B_URL: `${apiBaseUrl}/internal/suppliers/b`,
        WEB_API_BASE_URL: apiBaseUrl,
      },
    },
    {
      // The dev server rather than `build && preview`: sub-second start,
      // identical for everything a test can observe, `public/` at the same
      // paths (tech spec §4.2). `--strictPort` so a taken 5101 fails loudly
      // instead of Vite silently picking another port this config never
      // learns about.
      command: "pnpm exec vite --port 5101 --strictPort",
      cwd: here,
      url: `${webBaseUrl}/`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        // Read by vite.config.ts to target the /api and /internal proxy at
        // the API instance started above.
        WEB_API_BASE_URL: apiBaseUrl,
      },
    },
  ],
});
