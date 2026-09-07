/**
 * The database client: one Drizzle instance over a pool of **exactly one**
 * connection, with **no server-side prepared statements**.
 *
 * Both of those are load-bearing, and both are consequences of where this code
 * runs. `apps/api` deploys to Vercel as a serverless function
 * (`context/product/architecture.md` §5), so the fifty-webhook scenario is fifty
 * *separate processes*, not fifty requests through one. That is deliberate: it
 * is what makes passing the race scripts against the deployed URL direct
 * evidence that correctness lives in Postgres and not in one process's memory.
 * The price is that connection policy stops being a tuning knob and becomes a
 * correctness constraint. architecture.md §2, "Connection policy":
 *
 *   > pool size of 1 per function instance against the pooled endpoint,
 *   > prepared statements disabled. This is what keeps fifty concurrent
 *   > invocations from exhausting the connection limit.
 *
 * ---------------------------------------------------------------------------
 * WHY `max: 1` — DO NOT RAISE IT
 * ---------------------------------------------------------------------------
 * The intuition "a bigger pool is faster" is right for a long-lived server and
 * wrong here. A serverless instance handles **one request at a time**; a second
 * concurrent request is served by a second instance with its own module state
 * and therefore its own pool. So the pool's `max` is not "how much concurrency
 * do we want", it is "how many connections may a single in-flight request hold
 * simultaneously" — and the answer is one, because one request issues its
 * statements sequentially.
 *
 * The arithmetic is the whole argument. Total connections held ≈
 * `max` × (live instances). Fifty concurrent webhooks with `max: 1` ask the
 * pooled endpoint for 50 connections; with pg's default `max: 10` they ask for
 * 500. Neon's pooled (PgBouncer) endpoint would start refusing, and the
 * failure would look like a flaky race script rather than like a
 * misconfiguration — which is exactly how this gets "optimised" upward and then
 * spends a day being debugged.
 *
 * The cost is real and accepted: because Drizzle checks a client out of the
 * pool for the whole of `transaction()`, a transaction blocks every other
 * statement from this instance until it commits. That is a feature. It makes
 * the `lock-short-transactions` rule structural instead of advisory: a
 * transaction must never wrap a supplier HTTP call, and here it *cannot*
 * without visibly stalling its own instance. architecture.md §4 already
 * requires that ordering — call the supplier, then open a transaction to record
 * the result.
 *
 * ---------------------------------------------------------------------------
 * WHY NO PREPARED STATEMENTS
 * ---------------------------------------------------------------------------
 * Neon's pooled endpoint is PgBouncer in **transaction mode**: a client's
 * server connection is returned to the pool at every COMMIT, so the next
 * statement may land on a different backend. A server-side named prepared
 * statement (`PREPARE p1 AS ...`) lives on one backend and one session, so the
 * later `EXECUTE p1` arrives at a backend that has never heard of it:
 *
 *   ERROR:  prepared statement "p1" does not exist
 *
 * The mechanism that keeps that from happening here is narrow and worth stating
 * precisely, because it is not a flag:
 *
 *   - node-postgres (and `@neondatabase/serverless`, which mirrors its API)
 *     sends a **named** parse only when a query config carries a `name`.
 *     Without one it uses the *unnamed* statement of the extended query
 *     protocol — Parse/Bind/Execute in a single round trip, nothing retained on
 *     the backend, nothing that can go missing later. Parameters are still sent
 *     out-of-band, so this has no bearing on SQL injection.
 *   - Drizzle passes a `name` only when a query builder is finished with
 *     `.prepare("some_name")`. Every other call — `db.select()`, `db.insert()`,
 *     `db.execute(sql`...`)` — passes `name: undefined`.
 *
 * So the rule is: **never call `.prepare()` on a Drizzle query in this
 * codebase.** There is no pool option that would catch a violation, so the
 * check is a server-side one, and it is exact:
 *
 *   SELECT count(*) FROM pg_prepared_statements;
 *   -- must be 0 after any amount of application traffic
 *
 * (`pg_prepared_statements` is session-local, so it must be read on the same
 * connection the application used — which, with `max: 1`, is the only one this
 * client has.)
 *
 * ---------------------------------------------------------------------------
 * PHASE 6 — SWAPPING IN NEON
 * ---------------------------------------------------------------------------
 * Today this speaks the ordinary Postgres wire protocol over TCP, which is what
 * the Docker Compose container serves. Neon's serverless driver tunnels the
 * same protocol over a WebSocket so it works from an edge/serverless runtime,
 * and it deliberately mirrors node-postgres' `Pool` API. The migration is
 * therefore confined to this file, and to two lines of it:
 *
 *     -import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
 *     -import pg from "pg";
 *     +import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
 *     +import { Pool } from "@neondatabase/serverless";
 *
 * plus the `Database` alias below and the `pool` property's type. `max`,
 * `idleTimeoutMillis`, `connectionTimeoutMillis` and `application_name` carry
 * over unchanged; `Transaction` is derived from `Database`, so it follows on its
 * own. Nothing outside this file — no call site, no import of `@game-shop/db` —
 * changes, and `DATABASE_URL` moves from the Compose container to Neon's
 * **pooled** endpoint (the host with `-pooler` in it; the direct endpoint would
 * defeat the whole policy above).
 *
 * `./migrate.ts` stays on plain node-postgres over TCP on purpose and is not
 * part of this swap — see its header.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema/index.js";

/**
 * One connection per function instance. See the header — this is a correctness
 * constraint derived from the deployment shape, not a performance setting.
 */
export const MAX_CONNECTIONS_PER_INSTANCE = 1;

/**
 * How long an unused connection is kept before it is dropped. Ten seconds:
 * long enough that a warm instance handling back-to-back requests reuses its
 * connection rather than reconnecting, short enough that an instance that has
 * gone quiet stops occupying a slot other instances want.
 */
const IDLE_TIMEOUT_MS = 10_000;

/**
 * Bounds two waits at once, which is easy to misread: pg applies it to the
 * TCP/TLS handshake *and* to time spent queued for a free client. With
 * `max: 1`, any statement issued while a transaction is open is queued, so this
 * value is also "how long a statement may wait behind an open transaction
 * before it fails". Ten seconds sits comfortably under a serverless execution
 * ceiling while leaving room for a legitimately busy instance; a lower value
 * would turn ordinary contention into spurious failures.
 */
const CONNECTION_TIMEOUT_MS = 10_000;

/** Shows up in `pg_stat_activity.application_name`, which is how a connection gets attributed. */
const DEFAULT_APPLICATION_NAME = "game-shop";

/** The full schema, so relational queries and `db.query.*` see every table. */
type Schema = typeof schema;

/**
 * The Drizzle handle every caller works against.
 *
 * Callers name *this* type, never the driver's, so Phase 6 rewrites the right
 * hand side here and nothing else. See the header.
 */
export type Database = NodePgDatabase<Schema>;

/**
 * The handle passed to a `transaction()` callback: the same query API as
 * `Database`, bound to the open transaction. Derived from `Database` rather
 * than named directly, so the Phase 6 swap carries it along for free.
 */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export interface DatabaseClientOptions {
  /** Defaults to `process.env.DATABASE_URL`. */
  readonly connectionString?: string;
  /**
   * Recorded as `application_name` on the connection, so `pg_stat_activity` can
   * tell an API instance from the seed or from a race script. Defaults to
   * `game-shop`.
   */
  readonly applicationName?: string;
}

export interface DatabaseClient {
  /** The Drizzle query API. */
  readonly db: Database;
  /**
   * The underlying pool, for diagnostics (`pool.totalCount`, `pool.waitingCount`)
   * and for anything that must speak to the driver directly. Holding a client
   * out of it by hand defeats `max: 1`; go through `db` or `transaction()`.
   */
  readonly pool: pg.Pool;
  /** See {@link DatabaseClient.transaction}. */
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  /** Drains the pool. For scripts and for a graceful API shutdown. */
  close(): Promise<void>;
}

/**
 * Builds a client. Reads `DATABASE_URL` from the environment and does **not**
 * load `.env`: locally `scripts/with-env.ts` has already assembled the
 * environment, and on Vercel the platform supplies it.
 *
 * Most callers want {@link getDatabaseClient} instead — this exists for scripts
 * and tests that need an instance with its own lifetime.
 */
export function createDatabaseClient(options: DatabaseClientOptions = {}): DatabaseClient {
  const connectionString = options.connectionString ?? process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === "") {
    throw new Error(
      "@game-shop/db: DATABASE_URL is not set. Run through the repository scripts " +
        "(which load the local environment via scripts/with-env.ts), or export it yourself.",
    );
  }

  const pool = new pg.Pool({
    connectionString,

    // The policy. See the header before changing either of the next two facts:
    // `max` is 1, and nothing here enables prepared statements.
    max: MAX_CONNECTIONS_PER_INSTANCE,

    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,

    // Don't hold the event loop open on an idle pool. A script (the seed, a race
    // script) then exits when its work is done even if it forgets `close()`,
    // while the API is kept alive by its HTTP server regardless.
    allowExitOnIdle: true,

    application_name: options.applicationName ?? DEFAULT_APPLICATION_NAME,
  });

  // An idle connection dropped by the server — or by PgBouncer's own idle
  // timeout, which is the common case on Neon — surfaces as an 'error' event on
  // the pool. Unhandled, that is an uncaught exception that would take the
  // whole instance down over a connection nobody was using. pg has already
  // discarded the client by this point; the next checkout dials a fresh one.
  pool.on("error", (error: Error) => {
    console.error(`@game-shop/db: idle connection error — ${error.message}`);
  });

  const db: Database = drizzle(pool, { schema });

  return {
    db,
    pool,

    /**
     * Runs `work` inside one transaction on one connection, emitting exactly:
     *
     *   BEGIN;
     *   -- ... every statement `work` issues against `tx`, in order ...
     *   COMMIT;                     -- work resolved
     *   ROLLBACK;                   -- work threw; the error is rethrown
     *
     * No isolation level is named, so the transaction runs at the server
     * default, `READ COMMITTED`. That is the project's deliberate choice
     * (architecture.md §2, "Isolation level"): correctness comes from unique
     * constraints, `SELECT ... FOR UPDATE` and status-guarded conditional
     * updates — all of which are visible in the SQL — rather than from
     * `SERIALIZABLE` and an invisible retry-on-conflict loop. Raising the
     * isolation level here to paper over a missing constraint would hide the
     * guarantee this system exists to demonstrate.
     *
     * Two consequences of `max: 1` that callers must respect:
     *
     *   - This checks out the instance's only connection for the duration.
     *     Every other statement from this instance queues behind it (and fails
     *     after CONNECTION_TIMEOUT_MS). Never `await` a supplier HTTP call, or
     *     any other network I/O, inside `work`.
     *   - Do not call `transaction()` from inside `work`. Use the `tx` handle;
     *     it nests via SAVEPOINT. Reaching for the outer client instead would
     *     wait for a connection that `work` itself is holding — a self-deadlock
     *     that only ends at CONNECTION_TIMEOUT_MS.
     *
     * Row locks taken here (`FOR UPDATE` for I4, `FOR UPDATE SKIP LOCKED` for
     * the inbox drain and the supplier's key claim) are held until COMMIT or
     * ROLLBACK, which is why the body must stay short.
     */
    async transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
      return db.transaction(work);
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * The process-wide client.
 *
 * A serverless instance bootstraps once and is reused across invocations
 * (architecture.md §5), so this module-level cache is what makes "one pool per
 * instance" true: the second invocation on a warm instance reuses the first
 * one's connection instead of dialling a new one. Built lazily so that merely
 * importing `@game-shop/db` — for the schema, say — never opens a connection or
 * demands `DATABASE_URL`.
 */
let cachedClient: DatabaseClient | undefined;

export function getDatabaseClient(): DatabaseClient {
  cachedClient ??= createDatabaseClient();
  return cachedClient;
}

/** The Drizzle handle from the process-wide client. Sugar for `getDatabaseClient().db`. */
export function getDb(): Database {
  return getDatabaseClient().db;
}

/**
 * Drains the process-wide client, if one was ever built. For scripts and for a
 * graceful API shutdown; a later call to {@link getDatabaseClient} builds a new
 * one.
 */
export async function closeDatabaseClient(): Promise<void> {
  const client = cachedClient;
  cachedClient = undefined;
  if (client !== undefined) await client.close();
}
