#!/usr/bin/env node
// @layer: script
// @spec: 006-live-shop-and-the-written-answer
/**
 * `pnpm demo:reset` — put a shop you can only reach over HTTP back to what
 * the seed left, and print what moved (spec 006 functional spec §2.3;
 * technical-considerations §2.4, "`scripts/demo-reset.ts`").
 *
 * One `POST /api/admin/demo/reset` to the first target in `RACE_BASE_URLS`,
 * with `ADMIN_TOKEN` as the bearer. The endpoint does the work in one
 * transaction (`apps/api/src/demo/demo-reset.service.ts`); this script only
 * asks and reports. It prints every count in `removed` and `reset` one per
 * line, or "already at baseline" when the shop answers `changed: false`, and
 * then the baseline the shop now sits at, so the operator's eye and the
 * harness's `assertBaseline` look at the same twelve numbers.
 *
 * ---------------------------------------------------------------------------
 * WHO RUNS THIS, AND WHO MUST NOT
 * ---------------------------------------------------------------------------
 * The deployed shop's operator, between sessions — after a reviewer has
 * bought, paid, raced and armed, and before the next `pnpm race`, the next
 * storefront walk or the next screenshot. The race runner's
 * `RACE_DEMO_RESET=1` (external mode only) calls the same endpoint at the
 * end of a run for the same reason.
 *
 * Never a local suite. Every local check cleans up **its own** rows through
 * the harness (`apps/api/test/concurrency/support/db.ts`, `cleanupTestOrders`)
 * and asserts the baseline afterwards; a reset in their place would sweep the
 * residue a leaking application left behind into `removed` and call it a
 * pass. `apps/api/src/demo/demo-reset.controller.ts` says this at length, and
 * says a local run's output must never contain the line this script prints.
 * Locally, `pnpm db:reset` rebuilds the database from scratch instead.
 *
 * ---------------------------------------------------------------------------
 * WHY `RACE_BASE_URLS` AND NOT A `DEMO_URL` OF ITS OWN
 * ---------------------------------------------------------------------------
 * The reviewer already has `RACE_BASE_URLS` in their shell for `pnpm race`;
 * one variable for "the shop I am pointing at" is one fewer to get wrong,
 * and `parseRaceBaseUrls` already refuses the traps a hand-typed origin
 * falls into — a missing scheme, a pasted endpoint path, a duplicate
 * (`./race/support/race-targets.ts`). The first entry is used: a reset is one
 * transaction on one database, and against a deployed target every entry is
 * the same alias anyway.
 *
 * Exit codes follow `./race/README.md`: `0` reset (or already at baseline),
 * `1` the target refused or could not be reached, `2` this process was not
 * given what it needs. `401`/`503` are reported with the same words
 * `describeMissingAdminAffordance` gives every check, because they are the
 * same two situations.
 */
import { parseRaceBaseUrls, RACE_BASE_URLS_ENV } from "./race/support/race-targets.ts";
import { describeFetchError } from "./race/support/fetch-failure.ts";
import { describeMissingAdminAffordance, readAdminToken } from "./race/support/recovery-scenario.ts";

const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;

// ---------------------------------------------------------------------------
// The response, mirrored rather than imported — `apps/api/src/demo/demo.types.ts`
// explains why the shape is not in `packages/contracts`: a script takes a
// base URL and nothing else, so it reads the body defensively and prints
// whatever numbers are there.
// ---------------------------------------------------------------------------

interface DemoResetReport {
  readonly removed: Readonly<Record<string, number>>;
  readonly reset: Readonly<Record<string, number>>;
  readonly changed: boolean;
  readonly now: Readonly<Record<string, number>>;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keeps only the numeric fields, so a body with an unexpected shape prints what it can rather than `undefined`. */
function numericFields(value: unknown): Record<string, number> {
  if (!isJsonObject(value)) return {};
  const out: Record<string, number> = {};
  for (const [key, field] of Object.entries(value)) {
    if (typeof field === "number") out[key] = field;
  }
  return out;
}

function parseReport(text: string): DemoResetReport | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isJsonObject(parsed) || typeof parsed["changed"] !== "boolean") return undefined;
  return {
    removed: numericFields(parsed["removed"]),
    reset: numericFields(parsed["reset"]),
    changed: parsed["changed"],
    now: numericFields(parsed["now"]),
  };
}

/** `removed.orders   2` — the key padded so the numbers line up in a column. */
function printCounts(prefix: string, counts: Readonly<Record<string, number>>): void {
  const width = Math.max(...Object.keys(counts).map((key) => `${prefix}.${key}`.length), 0);
  for (const [key, count] of Object.entries(counts)) {
    console.log(`  ${`${prefix}.${key}`.padEnd(width)}  ${String(count)}`);
  }
}

/** The one-line baseline — the same twelve numbers the harness's `assertBaseline` reads, in the same order. */
function describeBaseline(now: Readonly<Record<string, number>>): string {
  const n = (key: string): string => (key in now ? String(now[key]) : "?");
  return (
    `products ${n("products")} · keys ${n("keys_unclaimed")}/${n("keys_total")} unclaimed · ` +
    `orders ${n("orders")} · payment_events ${n("payment_events")} · deliveries ${n("deliveries")} · ` +
    `issuance_attempts ${n("issuance_attempts")} · supplier_requests ${n("supplier_requests")} · ` +
    `promo_codes ${n("promo_codes")} (used ${n("promo_used_count")}, redemptions ${n("promo_redemptions")}) · ` +
    `supplier_behaviour rows at baseline ${n("supplier_behaviour_baseline")}`
  );
}

// ---------------------------------------------------------------------------
// Inputs.
// ---------------------------------------------------------------------------

const rawTargets = process.env[RACE_BASE_URLS_ENV];
if (rawTargets === undefined || rawTargets.trim() === "") {
  console.error(
    `demo:reset: ${RACE_BASE_URLS_ENV} is not set.\n` +
      `  Locally:  ${RACE_BASE_URLS_ENV}=http://localhost:3000 pnpm demo:reset       (against \`pnpm dev\`)\n` +
      `  Deployed: ${RACE_BASE_URLS_ENV}=https://game-shop.vercel.app pnpm demo:reset\n` +
      `The first origin in the list is the one reset; the same value drives \`pnpm race\`.`,
  );
  process.exit(EXIT_USAGE);
}

// `parseRaceBaseUrls` throws with its own explanation for a bad entry — a
// missing scheme, a pasted path, a duplicate — and that message is the one
// the reviewer already knows from `pnpm race`. Printed as a usage error
// rather than left as an uncaught throw: an operator reading a stack trace
// to find one sentence is the thing the message was written to avoid.
let target: string | undefined;
try {
  [target] = parseRaceBaseUrls(rawTargets);
} catch (error: unknown) {
  console.error(`demo:reset: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(EXIT_USAGE);
}
if (target === undefined) {
  console.error(`demo:reset: ${RACE_BASE_URLS_ENV} parsed to no origins.`);
  process.exit(EXIT_USAGE);
}

const adminToken = readAdminToken();
if (adminToken === undefined) {
  console.error(
    "demo:reset: ADMIN_TOKEN is not set. The reset is behind the admin bearer token; export the value " +
      "the target is configured with (the demo token for the deployed shop, the .env default locally).",
  );
  process.exit(EXIT_USAGE);
}

// ---------------------------------------------------------------------------
// The call.
// ---------------------------------------------------------------------------

console.log(`demo:reset — POST ${target}/api/admin/demo/reset`);
console.log(
  "  INFO  this is the deployed shop's affordance: one transaction removes every order and restores every " +
    "counter, claim and behaviour knob. Local suites never call it — they clean up through the harness.",
);

let response: Response;
try {
  response = await fetch(`${target}/api/admin/demo/reset`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}` },
  });
} catch (error: unknown) {
  console.error(`demo:reset: could not reach ${target}: ${describeFetchError(error)}`);
  process.exit(EXIT_REFUSED);
}

const text = await response.text();

if (response.status === 401 || response.status === 503) {
  console.error(
    `demo:reset: ${describeMissingAdminAffordance({ ok: false, status: response.status, body: undefined, text })}`,
  );
  process.exit(EXIT_REFUSED);
}

if (response.status !== 200) {
  console.error(`demo:reset: the target answered ${String(response.status)}: ${text}`);
  process.exit(EXIT_REFUSED);
}

const report = parseReport(text);
if (report === undefined) {
  console.error(`demo:reset: the target answered 200 with a body this script does not recognise: ${text}`);
  process.exit(EXIT_REFUSED);
}

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

if (report.changed) {
  printCounts("removed", report.removed);
  printCounts("reset", report.reset);
} else {
  console.log("  already at baseline — nothing removed, nothing reset");
}
console.log(`  now: ${describeBaseline(report.now)}`);
