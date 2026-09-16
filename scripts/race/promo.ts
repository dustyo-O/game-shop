#!/usr/bin/env node
// @layer: script
// @spec: 005-promo-codes-with-enforced-limits
/**
 * `pnpm race promo` — functional spec §2.4 and §2.5: the fifth adversarial
 * scenario, run by name. Many shoppers apply a capped code at the same moment
 * from several places at once; exactly the cap's worth of them get it.
 *
 * ---------------------------------------------------------------------------
 * THE MECHANISM THIS PROVES
 * ---------------------------------------------------------------------------
 * I7 (`architecture.md` §3.1; `apps/api/src/promo/promo-redemption.service.ts`):
 * one conditional update takes the use and decides the refusal in the same
 * statement —
 *
 *   UPDATE promo_codes SET used_count = used_count + 1
 *    WHERE id = $1 AND used_count < max_uses
 *    RETURNING used_count
 *
 * — zero rows is `409 exhausted`, and nothing else is written. Nothing in that
 * path reads the counter and then decides; the `WHERE` is re-evaluated by
 * Postgres against the row as the previous transaction committed it, behind
 * the row lock the previous `UPDATE` queued everyone else on. Beside it, I8
 * writes the ledger row (`promo_redemptions`, `PRIMARY KEY (order_id)`) and
 * the order is repriced to the shop's own arithmetic — the shopper sent a
 * code, never a number.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEEDS FOUR PROCESSES TO MEAN ANYTHING — R1
 * ---------------------------------------------------------------------------
 * `packages/db` pins the pool to `max: 1`, so a read-then-increment passes
 * every single-process run purely by having nowhere to interleave — see
 * `./README.md`, "Why the harness starts *four* processes", and the 20-vs-9
 * measurement it quotes from `architecture.md` §7.
 *
 * ---------------------------------------------------------------------------
 * WHY "ZERO 5xx" IS AN ASSERTION OF ITS OWN — R2
 * ---------------------------------------------------------------------------
 * The schema carries `CHECK (used_count <= max_uses)`. Weaken I7 to an
 * unconditional `SET used_count = used_count + 1` and the fourth increment
 * does not produce `used_count = 4` — it trips the CHECK, that transaction
 * aborts, and the API answers `500`. The counter still reads **3**. Three
 * orders carry the code. A check that asserted the counter, or even the
 * ledger, would stay green against a guard that is gone; what turns it red is
 * the *shape* of the refusals — exactly three `200`, exactly seventeen
 * `409 exhausted`, and not one `5xx`. So the shape is asserted first and the
 * counter in addition, never instead.
 *
 * ---------------------------------------------------------------------------
 * WHY CLEANUP DECREMENTS RATHER THAN RECOMPUTES
 * ---------------------------------------------------------------------------
 * `cleanupTestOrders` (`apps/api/test/concurrency/support/db.ts`) deletes this
 * run's redemption rows and subtracts from each code exactly the number it
 * deleted, in one statement. It does **not** set `used_count` to whatever the
 * ledger still holds: a recompute would silently repair any drift between
 * counter and ledger that the shop had introduced, and that drift is
 * precisely what the suites' `assertBaseline("after")` exists to catch. A
 * cleanup that makes the baseline true is a test that cannot fail.
 *
 * ---------------------------------------------------------------------------
 * A TARGET WHOSE DATABASE THIS PROCESS CANNOT REACH — R15
 * ---------------------------------------------------------------------------
 * Against a deployed shop there may be no `DATABASE_URL` here, so nothing can
 * decrement anything and the next run would find `LIMIT3` spent. For that case
 * only — `openRaceDatabase` returned `undefined` — the check falls back, after
 * the scenarios, to `POST /api/admin/promo-codes/reset` (technical-
 * considerations §2.3): it zeroes every counter and leaves the ledger, so the
 * two disagree afterwards by design, and the output says so. With a database
 * in hand the reset is never called; the verify task greps for that.
 */
import { PURCHASABLE_SKU, cleanupTestOrders, openRaceDatabase } from "./support/race-database.ts";
import { describeFetchError } from "./support/fetch-failure.ts";
import { collectInstanceIds, describeInstanceIds, readInstanceId, resolveRaceTargets } from "./support/race-targets.ts";
import {
  type AdminApiResult,
  describeMissingAdminAffordance,
  isMissingAdminAffordance,
  readAdminToken,
} from "./support/recovery-scenario.ts";

const CHECK_NAME = "race:promo";

const targets = resolveRaceTargets();
targets.announce(CHECK_NAME);

const failures: string[] = [];

function record(ok: boolean, label: string, detail: string): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

/**
 * `KEY-CS2-PRIME` lists at 1 290 ₽ — `packages/db/src/fixtures/catalog.ts`.
 * In kopecks, because every amount on the wire is (`orders.types.ts`).
 * Transcribed rather than read from the catalogue endpoint so the expected
 * discounts below are fixed inputs the shop is measured against, not values
 * derived from whatever the shop answered.
 */
const LIST_AMOUNT_MINOR = 129_000;

interface PromoScenario {
  /** The code as seeded — `packages/db/src/fixtures/promo-codes.ts`. */
  readonly code: string;
  /** Its `max_uses`: how many of the attempts below may succeed. */
  readonly maxUses: number;
  /** Simultaneous attempts, one per fresh order, round-robin across the instances. */
  readonly attempts: number;
  /**
   * The discount the shop must take off `LIST_AMOUNT_MINOR` — the worked
   * examples from `apps/api/test/unit/promo-discount.test.ts`, restated here
   * as a prediction the responses are checked against.
   */
  readonly discountMinor: number;
}

/**
 * Twenty against a cap of three, ten against a cap of one — the tech spec's
 * two shapes (§2.5). Twenty is the same scale every other check in this
 * directory uses for a contest on one row; ten is enough to show that a cap
 * of one is not a special case of the mechanism.
 */
const SCENARIOS: readonly PromoScenario[] = [
  { code: "LIMIT3", maxUses: 3, attempts: 20, discountMinor: 32_250 },
  { code: "ONCEONLY", maxUses: 1, attempts: 10, discountMinor: 64_500 },
];

// ---------------------------------------------------------------------------
// HTTP, never throwing — a network failure is a result with `status: 0`, so a
// batch of these can run under one `Promise.all` and be counted afterwards.
// ---------------------------------------------------------------------------

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

interface CreatedOrderResult {
  readonly status: number;
  readonly id: string | undefined;
  readonly amountMinor: number | undefined;
  readonly error: string | undefined;
}

/** `POST /api/orders` — no `Idempotency-Key`; every attempt here wants a distinct order. */
async function postCreateOrder(baseUrl: string, sku: string): Promise<CreatedOrderResult> {
  try {
    const response = await fetch(`${baseUrl}/api/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku }),
    });
    const text = await response.text();
    const body = parseJson(text);
    const id = isJsonObject(body) && typeof body["id"] === "string" ? body["id"] : undefined;
    const amountMinor = isJsonObject(body) && typeof body["amount_minor"] === "number" ? body["amount_minor"] : undefined;
    return { status: response.status, id, amountMinor, error: response.ok ? undefined : text };
  } catch (error: unknown) {
    return { status: 0, id: undefined, amountMinor: undefined, error: describeFetchError(error) };
  }
}

/** The slice of the `OrderView` this check reads off a `200`. */
interface AppliedView {
  readonly id: string;
  readonly amountMinor: number;
  readonly promo: { readonly code: string; readonly discountMinor: number; readonly listAmountMinor: number } | null;
}

interface ApplyPromoResult {
  /** Which order this attempt was made on — the `200`s' ids are compared with the ledger by this. */
  readonly orderId: string;
  readonly status: number;
  /** The `OrderView`, on a `200`. */
  readonly view: AppliedView | undefined;
  /** `{ reason }` on a refusal. */
  readonly reason: string | undefined;
  readonly error: string | undefined;
  /** The answering process's `x-instance-id` — `collectInstanceIds` counts the distinct ones after the race. */
  readonly instanceId: string | undefined;
}

function readAppliedView(body: unknown): AppliedView | undefined {
  if (!isJsonObject(body)) return undefined;
  const id = body["id"];
  const amountMinor = body["amount_minor"];
  if (typeof id !== "string" || typeof amountMinor !== "number") return undefined;

  const rawPromo = body["promo"];
  if (rawPromo === null) return { id, amountMinor, promo: null };
  if (!isJsonObject(rawPromo)) return undefined;
  const code = rawPromo["code"];
  const discountMinor = rawPromo["discount_minor"];
  const listAmountMinor = rawPromo["list_amount_minor"];
  if (typeof code !== "string" || typeof discountMinor !== "number" || typeof listAmountMinor !== "number") {
    return undefined;
  }
  return { id, amountMinor, promo: { code, discountMinor, listAmountMinor } };
}

/** `POST /api/orders/:orderId/promo { code }` — `200` with the view, or `{ reason }` with a `409`/`422`. */
async function postApplyPromo(baseUrl: string, orderId: string, code: string): Promise<ApplyPromoResult> {
  try {
    const response = await fetch(`${baseUrl}/api/orders/${orderId}/promo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const text = await response.text();
    const body = parseJson(text);
    const reason = isJsonObject(body) && typeof body["reason"] === "string" ? body["reason"] : undefined;
    return {
      orderId,
      status: response.status,
      view: response.ok ? readAppliedView(body) : undefined,
      reason,
      error: response.ok ? undefined : text,
      instanceId: readInstanceId(response),
    };
  } catch (error: unknown) {
    return {
      orderId,
      status: 0,
      view: undefined,
      reason: undefined,
      error: describeFetchError(error),
      instanceId: undefined,
    };
  }
}

/** `AdminApiResult`'s shape (so `isMissingAdminAffordance` can read it) plus the counters the reset echoes. */
interface ResetResult extends AdminApiResult {
  readonly counters: readonly { readonly code: string; readonly usedCount: number }[] | undefined;
}

/**
 * `POST /api/admin/promo-codes/reset` — no body, bearer `ADMIN_TOKEN`, exactly
 * as the other admin routes are called (`./support/recovery-scenario.ts`).
 * Answers `200 { promo_codes: [{ code, max_uses, used_count }] }`. Never
 * throws: `401` and `503` are answers this check turns into a SKIP line.
 */
async function postPromoCodesReset(baseUrl: string, adminToken: string): Promise<ResetResult> {
  try {
    const response = await fetch(`${baseUrl}/api/admin/promo-codes/reset`, {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const text = await response.text();
    const parsed = parseJson(text);
    const body = isJsonObject(parsed) ? parsed : undefined;
    const list = body !== undefined && Array.isArray(body["promo_codes"]) ? (body["promo_codes"] as unknown[]) : undefined;
    const counters = list
      ?.filter(isJsonObject)
      .map((entry) => ({
        code: typeof entry["code"] === "string" ? entry["code"] : "?",
        usedCount: typeof entry["used_count"] === "number" ? entry["used_count"] : Number.NaN,
      }));
    return { ok: response.ok, status: response.status, body, text, counters };
  } catch (error: unknown) {
    return { ok: false, status: 0, body: undefined, text: describeFetchError(error), counters: undefined };
  }
}

// ---------------------------------------------------------------------------
// One scenario: N fresh orders, N simultaneous applications of one code.
// ---------------------------------------------------------------------------

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((value) => right.has(value));
}

/**
 * The four answers a response can be sorted into. `applied` and `exhausted`
 * are the only two the race admits; `server_error` is the one a masked guard
 * produces (R2); `other` is everything else — a `422`, a `409` with a
 * different reason, a `404`, a network failure — and must be empty too.
 */
const ResponseKind = {
  Applied: "applied",
  Exhausted: "exhausted",
  ServerError: "server_error",
  Other: "other",
} as const;
type ResponseKind = (typeof ResponseKind)[keyof typeof ResponseKind];

function classify(result: ApplyPromoResult): ResponseKind {
  if (result.status === 200) return ResponseKind.Applied;
  if (result.status === 409 && result.reason === "exhausted") return ResponseKind.Exhausted;
  if (result.status >= 500) return ResponseKind.ServerError;
  return ResponseKind.Other;
}

function histogram(results: readonly ApplyPromoResult[]): string {
  const counts = new Map<string, number>();
  for (const result of results) {
    const key = result.status === 0 ? "network" : `${String(result.status)}${result.reason === undefined ? "" : ` ${result.reason}`}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, n]) => `${key}: ${String(n)}`)
    .join(", ");
}

interface ScenarioRun {
  /** Every order this scenario created — for cleanup, whatever else happened. */
  readonly orderIds: readonly string[];
  /** The orders that answered `200` — the ledger is compared against these. */
  readonly appliedOrderIds: readonly string[];
  /** `false` when the race itself could not be staged (not every order was created). */
  readonly raced: boolean;
}

async function runScenario(scenario: PromoScenario): Promise<ScenarioRun> {
  const { code, maxUses, attempts, discountMinor } = scenario;
  const refusals = attempts - maxUses;
  const amountToPay = LIST_AMOUNT_MINOR - discountMinor;

  console.log(
    `\n  ${code} — max_uses ${String(maxUses)}, ${String(attempts)} simultaneous applications on ${String(attempts)} fresh orders ` +
      `across ${String(targets.instanceCount)} instance(s): expect ${String(maxUses)} × 200, ${String(refusals)} × 409 exhausted, 0 × 5xx`,
  );

  // Step 1 — the orders, round-robin: order `i` is created on instance
  // `i % instanceCount`, and below its application goes to the same one.
  const created = await Promise.all(Array.from({ length: attempts }, (_, i) => postCreateOrder(targets.at(i), PURCHASABLE_SKU)));
  const orderIds = created.map((result) => result.id).filter((id): id is string => id !== undefined);

  const allCreated = orderIds.length === attempts && created.every((result) => result.status === 201);
  record(
    allCreated,
    `all ${String(attempts)} orders created (201)`,
    allCreated
      ? `${String(orderIds.length)} order(s)`
      : created
          .filter((result) => result.status !== 201)
          .map((result) => `${String(result.status)}${result.error === undefined ? "" : ` ${result.error}`}`)
          .join("; "),
  );
  if (!allCreated) {
    console.log(`  SKIP  the ${code} race — not every order exists, so the expected counts would not be ${String(maxUses)}/${String(refusals)}`);
    return { orderIds, appliedOrderIds: [], raced: false };
  }

  const allListPriced = created.every((result) => result.amountMinor === LIST_AMOUNT_MINOR);
  record(
    allListPriced,
    `every order starts at the list price ${String(LIST_AMOUNT_MINOR)}`,
    allListPriced ? "yes" : `saw ${[...new Set(created.map((result) => String(result.amountMinor)))].join(", ")}`,
  );

  // Step 2 — the race. One `Promise.all`, one code, one attempt per order,
  // `targets.at(i)` so that every instance takes its share of the contest.
  const results = await Promise.all(orderIds.map((orderId, i) => postApplyPromo(targets.at(i), orderId, code)));

  const applied = results.filter((result) => classify(result) === ResponseKind.Applied);
  const exhausted = results.filter((result) => classify(result) === ResponseKind.Exhausted);
  const serverErrors = results.filter((result) => classify(result) === ResponseKind.ServerError);
  const other = results.filter((result) => classify(result) === ResponseKind.Other);

  console.log(`  INFO  response shape — ${histogram(results)}`);
  // Who answered the applications — the HTTP witness of "separate processes"
  // for THIS race (spec 006 §2.5). Informational: the harness decides on it.
  console.log(`  ${describeInstanceIds(collectInstanceIds(results))}`);

  // Step 3 — the shape of the responses. The order of these four lines is
  // the order a reader needs them in: how many got it, how many were told
  // no, and then the two that a masked guard would show up in.
  record(applied.length === maxUses, `exactly ${String(maxUses)} × 200 — the cap's worth, no more`, `${String(applied.length)} × 200`);
  record(
    exhausted.length === refusals,
    `exactly ${String(refusals)} × 409 exhausted — every other shopper told no, in words`,
    `${String(exhausted.length)} × 409 exhausted`,
  );
  record(
    serverErrors.length === 0,
    "zero 5xx — a guard weakened to an unconditional increment trips the CHECK as 500s while the counter still reads the cap (R2)",
    serverErrors.length === 0
      ? "none"
      : `${String(serverErrors.length)} × 5xx: ${serverErrors
          .slice(0, 3)
          .map((result) => `${String(result.status)} ${result.error ?? ""}`)
          .join("; ")}${serverErrors.length > 3 ? "; …" : ""}`,
  );
  record(
    other.length === 0,
    "no other status at all — 200 and 409 exhausted are the only two answers this race admits",
    other.length === 0 ? "none" : histogram(other),
  );

  // Step 4 — what the 200s say. The shop's price, not the page's; the code
  // named; the order it was asked on.
  const appliedOrderIds = applied.map((result) => result.orderId);
  const viewsAgree = applied.every(
    (result) =>
      result.view !== undefined &&
      result.view.id === result.orderId &&
      result.view.promo !== null &&
      result.view.promo.code === code &&
      result.view.promo.discountMinor === discountMinor &&
      result.view.promo.listAmountMinor === LIST_AMOUNT_MINOR &&
      result.view.amountMinor === amountToPay,
  );
  record(
    viewsAgree,
    `every 200 carries promo { code: ${code}, discount_minor: ${String(discountMinor)}, list_amount_minor: ${String(LIST_AMOUNT_MINOR)} } ` +
      `and amount_minor ${String(amountToPay)} on the order it was asked on`,
    viewsAgree
      ? `${String(applied.length)} view(s) agree`
      : applied
          .filter(
            (result) =>
              result.view === undefined ||
              result.view.id !== result.orderId ||
              result.view.promo?.code !== code ||
              result.view.promo.discountMinor !== discountMinor ||
              result.view.promo.listAmountMinor !== LIST_AMOUNT_MINOR ||
              result.view.amountMinor !== amountToPay,
          )
          .map((result) => `${result.orderId}: ${JSON.stringify(result.view)}`)
          .join("; "),
  );
  record(
    new Set(appliedOrderIds).size === applied.length,
    "the 200s name distinct orders — one use per order, never two on one",
    `${String(new Set(appliedOrderIds).size)} distinct of ${String(applied.length)}`,
  );

  return { orderIds, appliedOrderIds, raced: true };
}

// ---------------------------------------------------------------------------
// The database half — counter, ledger, and the repriced rows. SKIP by name
// when there is no route to the database (`./support/race-database.ts`).
// ---------------------------------------------------------------------------

type RaceDatabase = NonNullable<ReturnType<typeof openRaceDatabase>>;

async function readUsedCount(db: RaceDatabase, code: string): Promise<number | undefined> {
  // select used_count from promo_codes where code = $1
  const { rows } = await db.pool.query<{ used_count: number }>(`select used_count from promo_codes where code = $1`, [code]);
  return rows[0]?.used_count;
}

async function assertDatabaseHalf(db: RaceDatabase, scenario: PromoScenario, run: ScenarioRun): Promise<void> {
  const { code, maxUses, discountMinor } = scenario;
  const amountToPay = LIST_AMOUNT_MINOR - discountMinor;

  const usedCount = await readUsedCount(db, code);
  record(usedCount === maxUses, `used_count = ${String(maxUses)} for ${code} — the counter half of I7`, `used_count = ${String(usedCount)}`);

  // The ledger, scoped to THIS run's orders and joined to the code: of the N
  // orders this scenario created, exactly max_uses carry a row, every one of
  // them for this code, and they are the N that answered 200. Scoped rather
  // than global, because the claim is about these orders; whether the table
  // as a whole agrees with the counter is `assertBaseline`'s job in the
  // Vitest suites, and after an admin reset on a deployed shop the two are
  // allowed to disagree (the file header, R15).
  //
  //   select r.order_id, c.code
  //     from promo_redemptions r
  //     join promo_codes c on c.id = r.promo_id
  //    where r.order_id = any($1::text[])
  const ledger = await db.pool.query<{ order_id: string; code: string }>(
    `select r.order_id, c.code
       from promo_redemptions r
       join promo_codes c on c.id = r.promo_id
      where r.order_id = any($1::text[])`,
    [run.orderIds],
  );
  record(
    ledger.rows.length === maxUses && ledger.rows.every((row) => row.code === code),
    `exactly ${String(maxUses)} promo_redemptions row(s) among this run's ${String(run.orderIds.length)} orders, all for ${code} — the ledger half of I8`,
    `${String(ledger.rows.length)} row(s)${ledger.rows.some((row) => row.code !== code) ? `, codes: ${[...new Set(ledger.rows.map((row) => row.code))].join(", ")}` : ""}`,
  );
  const ledgerOrderIds = ledger.rows.map((row) => row.order_id);
  record(
    sameSet(ledgerOrderIds, run.appliedOrderIds),
    "the ledger's order_id set equals the 200s' — the responses and the database name the same winners",
    `ledger: [${ledgerOrderIds.join(", ")}]; 200s: [${run.appliedOrderIds.join(", ")}]`,
  );

  // The price the shop will charge: discounted on the winners, the list
  // price on everyone else — `orders.amount_minor` is what the payment
  // simulator reads, so this is the number that reaches the webhook.
  //
  //   select id, amount_minor from orders where id = any($1::text[])
  const priced = await db.pool.query<{ id: string; amount_minor: number }>(
    `select id, amount_minor from orders where id = any($1::text[])`,
    [run.orderIds],
  );
  const winners = new Set(run.appliedOrderIds);
  const wrong = priced.rows.filter((row) => row.amount_minor !== (winners.has(row.id) ? amountToPay : LIST_AMOUNT_MINOR));
  record(
    priced.rows.length === run.orderIds.length && wrong.length === 0,
    `the ${String(maxUses)} winners carry amount_minor ${String(amountToPay)} and the other ${String(run.orderIds.length - maxUses)} still carry ${String(LIST_AMOUNT_MINOR)}`,
    wrong.length === 0
      ? `${String(priced.rows.length)} row(s) as expected`
      : wrong.map((row) => `${row.id}: ${String(row.amount_minor)}`).join("; "),
  );
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

console.log(
  `${CHECK_NAME} — proves: I7, one conditional UPDATE ... WHERE used_count < max_uses decides the ` +
    "limit (architecture.md §3.1), and I8's ledger row names who got it. Invariant: of N " +
    "simultaneous applications of a code capped at K, exactly K answer 200, the rest 409 " +
    "exhausted, none 5xx — and the database says the same three things.",
);

const db = openRaceDatabase("promo");
const allOrderIds: string[] = [];

try {
  for (const scenario of SCENARIOS) {
    if (db !== undefined) {
      // A spent counter is the one precondition that would make the shape
      // below fail for a reason that is not the shop's — say so first.
      const before = await readUsedCount(db, scenario.code);
      record(
        before === 0,
        `${scenario.code} starts at used_count = 0 — nothing left spent by an earlier run`,
        before === 0
          ? "yes"
          : `used_count = ${String(before)}; an earlier run left it spent — \`pnpm db:reset\`, or find what wrote it: this run's cleanup hands back only its own uses`,
      );
    }

    const run = await runScenario(scenario);
    allOrderIds.push(...run.orderIds);

    if (!run.raced) continue;

    if (db === undefined) {
      console.log(
        `  SKIP  used_count = ${String(scenario.maxUses)} for ${scenario.code}; ${String(scenario.maxUses)} promo_redemptions row(s) ` +
          `matching the 200s; the winners repriced and the rest at the list price — needs DATABASE_URL`,
      );
    } else {
      await assertDatabaseHalf(db, scenario, run);
    }
  }
} finally {
  if (db !== undefined) {
    // The cleanup that makes a second run work with no manual tidying
    // (functional spec §2.5's last criterion): every order this check
    // created, and — inside the same helper — its redemption rows deleted
    // and each code decremented by exactly that many. The file header says
    // why it is a decrement and not a recompute.
    await cleanupTestOrders(db, allOrderIds);
    await db.close();
  } else {
    // No database to decrement through. The next run needs LIMIT3 and
    // ONCEONLY back at zero, and the only handle this process has on a
    // deployed shop is the admin reset — R15, and the file header. This
    // branch is unreachable under `pnpm race` in local mode, which always has
    // a database; external mode without `RACE_DATABASE_URL` reaches it on
    // every run (the reviewer's command), which is why the demo reset that
    // follows reports `promo_codes 0` beside a non-zero `promo_redemptions`.
    const adminToken = readAdminToken();
    if (adminToken === undefined) {
      console.log(
        `  SKIP  the admin reset — no ADMIN_TOKEN in this process, and no DATABASE_URL to decrement through, so the counters stay spent. ` +
          `The next run of ${CHECK_NAME} against this target will report 409 exhausted for every attempt. ` +
          "Fix: export ADMIN_TOKEN with the value the target is configured with (the check then calls POST /api/admin/promo-codes/reset " +
          "after its scenarios), or export a DATABASE_URL pointing at the target's database so cleanup can decrement the counters instead.",
      );
    } else {
      const reset = await postPromoCodesReset(targets.at(0), adminToken);
      if (isMissingAdminAffordance(reset)) {
        console.log(
          `  SKIP  the admin reset — ${describeMissingAdminAffordance(reset)} ` +
            `The counters stay spent: the next run of ${CHECK_NAME} against this target will report 409 exhausted for every attempt.`,
        );
      } else {
        const allZero =
          reset.counters !== undefined && reset.counters.length > 0 && reset.counters.every((counter) => counter.usedCount === 0);
        record(
          reset.status === 200 && allZero,
          "the admin reset answered 200 with every used_count at 0",
          reset.status === 200 && reset.counters !== undefined
            ? reset.counters.map((counter) => `${counter.code}=${String(counter.usedCount)}`).join(", ")
            : `status=${String(reset.status)} ${reset.text}`,
        );
        console.log(
          "  INFO  counters reset through the admin endpoint; the ledger keeps the rows — a database was not reachable to clean up",
        );
      }
    }
  }
}

if (failures.length > 0) {
  console.error(`${CHECK_NAME} FAILED (${String(failures.length)}):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`${CHECK_NAME} passed.`);
}
