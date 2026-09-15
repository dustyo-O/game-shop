// @layer: script
// @spec: 002-single-issuance-under-races
/**
 * `RACE_BASE_URLS` — the multi-instance target list every adversarial check in
 * `scripts/race/` fires its requests at.
 *
 * =========================================================================
 * THE INTERFACE, FOR SOMEONE WRITING A CHECK
 * =========================================================================
 *
 *     import { resolveRaceTargets } from "./support/race-targets.ts";
 *
 *     const targets = resolveRaceTargets();
 *     targets.announce("race:webhooks");
 *
 *     // 50 concurrent requests, spread evenly across whatever instances exist.
 *     const responses = await Promise.all(
 *       Array.from({ length: 50 }, (_, i) =>
 *         fetch(`${targets.at(i)}/api/webhooks/payment`, { ... })),
 *     );
 *
 * - `targets.at(i)` — deterministic: request `i` always goes to instance
 *   `i % instanceCount`. Prefer it when building a fixed-size batch, because a
 *   failing run and its re-run send the same request to the same instance.
 * - `targets.next()` — stateful round-robin, for loops that do not have an
 *   index to hand.
 * - `targets.instanceCount` — how many separate base URLs there are. See the
 *   warning below about what `1` means.
 * - `targets.baseUrls` — the whole list, normalised (see "What is guaranteed").
 * - `targets.announce(name)` — prints the one-line banner every check should
 *   print before it starts, plus the single-instance warning when it applies.
 *   Call it once, first; it is the line that tells a reviewer reading the
 *   transcript whether the run that follows is worth anything.
 *
 * Every base URL is an **origin** with no trailing slash, so a check always
 * writes `` `${base}/api/orders` `` and never has to think about it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS GUARANTEED WHEN A CHECK STARTS
 * ---------------------------------------------------------------------------
 * When a check is run by `scripts/race/run-checks.ts` (`pnpm race`), by the
 * time its first line executes:
 *
 *   1. `RACE_BASE_URLS` is set and every entry has already been validated by
 *      this module — so `resolveRaceTargets()` will not throw on a
 *      configuration problem that the runner could have caught first.
 *   2. Every listed instance has answered `GET /api/health` with `200`. Not
 *      "has been spawned" — has served a real HTTP request. A check does not
 *      need to poll for readiness.
 *   3. `@game-shop/db`, `@game-shop/contracts` and `apps/api` have been rebuilt
 *      from current source, so a deliberately weakened mechanism (RED
 *      validation, functional spec §2.6) is genuinely the code running.
 *   4. `DATABASE_URL` is set and accepted a `select 1`.
 *
 * None of that is guaranteed when a check is run on its own —
 * `RACE_BASE_URLS=https://shop.example pnpm exec node scripts/race/webhooks.ts`
 * — which is the deployed-target path. There, (1) still holds because this
 * module validates on every call, (2) is the platform's job, (3) is irrelevant
 * because the deployed code is whatever was deployed, and (4) may simply be
 * false. See "Database access" below.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A **LIST**, AND WHY ONE ENTRY IS A WEAKER CHECK
 * ---------------------------------------------------------------------------
 * `packages/db/src/client.ts` pins the connection pool to `max: 1` per process
 * — the serverless shape, deliberately. Inside one process a transaction holds
 * that single connection for the whole of `BEGIN … COMMIT`, so a second
 * concurrent request queues **in Node, before a byte reaches Postgres**.
 * `FOR UPDATE SKIP LOCKED` never skips, because nothing else holds a row lock
 * when the subquery looks.
 *
 * The consequence, measured in this project and recorded in
 * `context/product/architecture.md` §7: with the key claim weakened to an
 * unlocked `SELECT`-then-`UPDATE` and twenty concurrent request ids —
 *
 *   | Harness                          | Codes | Distinct | Errors |
 *   | 1 process,  pool max: 1          |    20 |   **20** |      0 |
 *   | 4 processes, pool max: 1 each    |    20 |    **9** |      0 |
 *
 * The same broken code is flawless against one instance and hands eleven
 * customers a key somebody else also holds against four — silently, in both
 * cases. **A race check pointed at a single local instance measures the
 * connection pool, not the constraint, and passes against a broken shop.**
 *
 * So a single URL is *accepted* rather than rejected — it is exactly right
 * against a deployed target, where the platform supplies the separate
 * instances and we get no say in how many — but locally it is a weaker check,
 * and `announce()` says so out loud rather than letting a green transcript
 * imply something it did not prove.
 *
 * ---------------------------------------------------------------------------
 * DATABASE ACCESS — WHICH ASSERTIONS NEED IT
 * ---------------------------------------------------------------------------
 * Nothing in this module touches the database, and nothing here assumes
 * localhost or the ability to spawn a process: point it at
 * `https://…vercel.app` and it works unchanged. But a check's assertions split
 * in two, and the split matters when the target is deployed:
 *
 *   Needs only HTTP (works against any target, no `DATABASE_URL`):
 *     - every response's status code — "all fifty answered 2xx"
 *     - the order's final status read back from `GET /api/orders/:id`
 *     - the delivered key as the shopper sees it
 *     - all N responses naming the same order id (§2.1's idempotent create)
 *
 *   Needs `DATABASE_URL` pointing at the SAME database the target uses:
 *     - `deliveries` row count for an order  ← the headline assertion
 *     - `supplier_keys` claimed count
 *     - `payment_events` row count for one `event_id`, and `processed_at`
 *     - `orders` row count for one `client_request_id`
 *     - the seeded-baseline check before/after a run, and the cleanup that
 *       makes a second run work with no manual tidying
 *
 * Both halves are asserted for the reason `architecture.md` §7 gives: the two
 * disagree in *both* directions. Phase 1 saw a mis-classified driver error
 * return `500` to nineteen of twenty callers while the database stayed
 * perfectly correct, and a broken delivered-key gate return a self-consistent
 * `null` to every read while the key sat committed in `deliveries`.
 * Response-only calls the first a failure; database-only calls the second a
 * pass.
 *
 * `./race-database.ts` is how a check asks for a connection and finds out
 * whether it has one. Against a deployed shop with no database route, a check
 * should run its HTTP half, report the database half as SKIPPED naming the
 * assertions it could not make, and **not** report a pass it did not earn.
 *
 * ---------------------------------------------------------------------------
 * THE INSTANCE-ID WITNESS — `collectInstanceIds`
 * ---------------------------------------------------------------------------
 * Every response the API sends carries `x-instance-id`, one random UUID per
 * process (`apps/api/src/instance-identity.ts`, spec 006 §2.5). Locally the
 * harness proves "separate processes" with `pg_stat_activity` pids; against a
 * deployed target nobody holds the database, so the process has to say who it
 * is over HTTP instead. A check that has just fired N concurrent requests
 * collects the header from its own N responses and prints how many distinct
 * values it saw:
 *
 *     console.log(`  ${describeInstanceIds(collectInstanceIds(results))}`);
 *     // INFO  answers came from 4 distinct instance(s) — 50 answer(s)
 *
 * What the number proves, and what it does not — `instance-identity.ts`'s
 * own words: a distinct id proves a distinct process, **not** that those
 * processes were alive at the same moment. K = 1 on a run means that run was
 * not cross-process evidence, and the line says so rather than leaving a
 * green transcript to imply otherwise. The harness (`../harness.ts`) turns the
 * same count into a PASS/FAIL against an external target; a check only
 * reports it.
 */

/** The one environment variable this module reads. */
export const RACE_BASE_URLS_ENV = "RACE_BASE_URLS";

/**
 * Set by `../run-checks.ts` for every check it spawns: `local` when the runner
 * started the instances itself, `external` when `RACE_BASE_URLS` named them.
 * Unset when a check is run by hand. The harness reads it to decide whether a
 * distinct-instance count is a PASS/FAIL or an INFO line — see `../harness.ts`.
 */
export const RACE_MODE_ENV = "RACE_MODE";

/** The header `apps/api/src/create-app.ts` sets on every response — `INSTANCE_ID_HEADER` there, transcribed. */
export const INSTANCE_ID_HEADER = "x-instance-id";

export interface RaceTargets {
  /** Normalised origins, in the order they were listed. Never empty. */
  readonly baseUrls: readonly string[];
  /** `baseUrls.length`. `1` is legal and means the run cannot prove a race locally — see the header. */
  readonly instanceCount: number;
  /** Round-robin, stateful. For loops with no index to hand. */
  next(): string;
  /** Deterministic: index `i` always maps to instance `i % instanceCount`. Negative indexes are rejected. */
  at(index: number): string;
  /** The banner a check prints before it starts, including the single-instance warning. */
  announce(checkName: string): void;
}

/**
 * Splits and validates a `RACE_BASE_URLS` value. Exported so the runner can
 * reject a bad list *before* it builds and spawns anything, and so a check can
 * validate a value it assembled itself.
 *
 * Rejects, loudly, at parse time rather than at first `fetch`:
 *
 *   - **A URL with no scheme.** `architecture.md` §8 records this exact trap,
 *     and `apps/api/src/config/env.ts` already guards against it for
 *     `SUPPLIER_A_URL`: `new URL("localhost:3000/x")` **succeeds**, with
 *     protocol `localhost:`, an empty hostname and `origin === "null"`. Left
 *     unchecked it surfaces hundreds of lines later as an unexplained
 *     `fetch failed`, which reads exactly like the shop being down.
 *   - **A non-empty path, query or fragment.** These are origins; every check
 *     appends its own path. `http://host/api/orders` is somebody pasting a
 *     whole endpoint, and silently accepting it produces `/api/orders/api/orders`.
 *   - **A duplicate.** Round-robin across the same origin twice is round-robin
 *     across it once, so a duplicate makes `instanceCount` a lie — the run
 *     reports four instances and races two. Since the entire value of this
 *     harness is that the instance count is honest, a duplicate is a typo, not
 *     a preference.
 *   - **An empty list.**
 */
export function parseRaceBaseUrls(raw: string): string[] {
  // A human writes `a, b, c`. Trim, and drop the empty entry a trailing comma
  // leaves behind rather than failing on it.
  const entries = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  if (entries.length === 0) {
    throw new Error(
      `${RACE_BASE_URLS_ENV} is empty. Set it to a comma-separated list of origins, e.g.\n` +
        `  ${RACE_BASE_URLS_ENV}=http://127.0.0.1:4201,http://127.0.0.1:4202\n` +
        `or to a single origin for a deployed target, e.g.\n` +
        `  ${RACE_BASE_URLS_ENV}=https://game-shop.vercel.app\n` +
        `Or run \`pnpm race\`, which starts local instances and sets it for you.`,
    );
  }

  const origins: string[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw new Error(
        `${RACE_BASE_URLS_ENV} entry ${JSON.stringify(entry)} is not a URL. ` +
          `Entries are origins: scheme://host[:port].`,
      );
    }

    // The §8 trap. `localhost:4201` parses; it just does not parse as anything
    // fetch can dial. Checking the protocol is what catches it, not `new URL`.
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(
        `${RACE_BASE_URLS_ENV} entry ${JSON.stringify(entry)} has scheme ${JSON.stringify(url.protocol)}, ` +
          `expected "http:" or "https:". A missing "http://" parses as a scheme of its own ` +
          `(architecture.md §8) — write ${JSON.stringify(`http://${entry}`)}.`,
      );
    }
    if (url.hostname === "") {
      throw new Error(`${RACE_BASE_URLS_ENV} entry ${JSON.stringify(entry)} has no host.`);
    }
    if (url.pathname !== "/" && url.pathname !== "") {
      throw new Error(
        `${RACE_BASE_URLS_ENV} entry ${JSON.stringify(entry)} has a path (${JSON.stringify(url.pathname)}). ` +
          `Entries are origins — each check appends its own path, so this would produce a doubled one. ` +
          `Use ${JSON.stringify(url.origin)}.`,
      );
    }
    if (url.search !== "" || url.hash !== "") {
      throw new Error(
        `${RACE_BASE_URLS_ENV} entry ${JSON.stringify(entry)} has a query string or fragment. ` +
          `Entries are origins — use ${JSON.stringify(url.origin)}.`,
      );
    }

    // `URL.origin` is the normalisation: it drops the trailing slash, lowercases
    // the host and elides a default port, so `http://Localhost:80/` and
    // `http://localhost` are recognised as the same instance below.
    const { origin } = url;
    if (seen.has(origin)) {
      throw new Error(
        `${RACE_BASE_URLS_ENV} lists ${JSON.stringify(origin)} more than once. ` +
          `Round-robin across one origin twice is round-robin across it once, so this would ` +
          `report more instances than the run actually races. Remove the duplicate, or add a ` +
          `genuinely separate instance.`,
      );
    }
    seen.add(origin);
    origins.push(origin);
  }

  return origins;
}

const SINGLE_INSTANCE_WARNING =
  "  WARNING: 1 instance. This run CANNOT prove a race against a local target.\n" +
  "  packages/db pins the pool to max: 1, so concurrent requests to one process\n" +
  "  serialise in Node before Postgres sees them, and a shop with no locking at\n" +
  "  all passes (architecture.md §7: 20 distinct keys across 1 process, 9 across 4).\n" +
  "  This is correct ONLY against a deployed target, where the platform supplies\n" +
  "  the separate instances. Locally, run `pnpm race` instead.";

/**
 * Reads and validates `RACE_BASE_URLS`, and returns the pickers a check uses.
 *
 * `raw` is an override for a caller that already has the value in hand (the
 * runner validating before it spawns); everything else omits it.
 */
export function resolveRaceTargets(raw: string | undefined = process.env[RACE_BASE_URLS_ENV]): RaceTargets {
  if (raw === undefined) {
    throw new Error(
      `${RACE_BASE_URLS_ENV} is not set.\n` +
        `  Locally:  pnpm race                       (starts instances, sets it, stops them)\n` +
        `  Deployed: ${RACE_BASE_URLS_ENV}=https://game-shop.vercel.app pnpm race`,
    );
  }

  const baseUrls = parseRaceBaseUrls(raw);
  let cursor = 0;

  function at(index: number): string {
    if (!Number.isInteger(index) || index < 0) {
      throw new Error(`RaceTargets.at: index must be a non-negative integer, got ${String(index)}`);
    }
    // `noUncheckedIndexedAccess` is on, and the modulo makes this total — but
    // the compiler cannot see that, so the guard is real code rather than a
    // non-null assertion that would silently become wrong if the list emptied.
    const picked = baseUrls[index % baseUrls.length];
    if (picked === undefined) throw new Error("RaceTargets.at: no base URLs");
    return picked;
  }

  return {
    baseUrls,
    instanceCount: baseUrls.length,

    next(): string {
      const picked = at(cursor);
      cursor += 1;
      return picked;
    },

    at,

    announce(checkName: string): void {
      const plural = baseUrls.length === 1 ? "instance" : "instances";
      console.log(`${checkName} — ${String(baseUrls.length)} ${plural}: ${baseUrls.join(", ")}`);
      if (baseUrls.length === 1) console.warn(SINGLE_INSTANCE_WARNING);
    },
  };
}

// ---------------------------------------------------------------------------
// The instance-id witness.
// ---------------------------------------------------------------------------

/** What `collectInstanceIds` counts from: a `Response`, or a check's own result object carrying an id `readInstanceId` already read. */
export type InstanceIdSource = Pick<Response, "headers"> | { readonly instanceId: string | undefined };

export interface InstanceIdWitness {
  /** Every distinct `x-instance-id` seen, in first-seen order. */
  readonly distinct: readonly string[];
  /** How many sources were counted, labelled or not. */
  readonly answers: number;
  /** Sources with no `x-instance-id` at all — a `fetch` that threw, or a target that is not this API. */
  readonly unlabelled: number;
}

/** The `x-instance-id` header of one response, or `undefined` when it carries none. Read it inside a helper that consumes the body, and keep it on the result. */
export function readInstanceId(response: Pick<Response, "headers">): string | undefined {
  const value = response.headers.get(INSTANCE_ID_HEADER);
  return value === null || value === "" ? undefined : value;
}

/**
 * Distinct `x-instance-id` values across a batch of answers. Accepts the
 * `Response`s themselves, or result objects whose `instanceId` a helper read
 * with `readInstanceId` before consuming the body — the three checks that
 * wrap `fetch` in a never-throwing helper keep the id on the result.
 */
export function collectInstanceIds(sources: Iterable<InstanceIdSource>): InstanceIdWitness {
  const distinct: string[] = [];
  const seen = new Set<string>();
  let answers = 0;
  let unlabelled = 0;
  for (const source of sources) {
    answers += 1;
    const id = "headers" in source ? readInstanceId(source) : source.instanceId;
    if (id === undefined) {
      unlabelled += 1;
      continue;
    }
    if (!seen.has(id)) {
      seen.add(id);
      distinct.push(id);
    }
  }
  return { distinct, answers, unlabelled };
}

/**
 * The one INFO line a check prints after its concurrent batch. K = 1 is
 * flagged in the line itself: every answer from one process is exactly the
 * run `architecture.md` §7 warns is not evidence.
 */
export function describeInstanceIds(witness: InstanceIdWitness): string {
  const k = witness.distinct.length;
  return (
    `INFO  answers came from ${String(k)} distinct instance(s) — ${String(witness.answers)} answer(s)` +
    (witness.unlabelled > 0 ? `, ${String(witness.unlabelled)} without an ${INSTANCE_ID_HEADER} header` : "") +
    (k === 1 ? "; a single id means this run was not cross-process evidence" : "")
  );
}
