#!/usr/bin/env node
/**
 * Applies every pending migration in `../drizzle`, then exits.
 *
 * Contract (relied on by the root `pnpm db:migrate`, `db:setup` and `db:reset`):
 *
 *   - reads `DATABASE_URL` from the environment; it does **not** load `.env`
 *     itself — `scripts/with-env.ts` has already assembled the environment, and
 *     against Neon the operator exports it for the one command (below);
 *   - applies every migration not yet recorded in `drizzle.__drizzle_migrations`;
 *   - is idempotent: a second run applies nothing and exits 0;
 *   - runs with cwd = `packages/db`, but resolves the migrations folder from its
 *     own location, so it also works when invoked from anywhere else.
 *
 * Driver: the same `node-postgres` the request path uses (Phase 6 decided
 * against a driver swap — `client.ts`'s header, "DECIDED: NO SWAP"), as a single
 * `pg.Client` rather than the pool: one connection, one operator, one run.
 *
 * Operator rule — direct endpoint, from a laptop, never from a build:
 *
 *     DATABASE_URL=<neon-direct> pnpm db:deploy     # migrate && seed
 *
 * Run by a developer (`db:setup` locally, `db:deploy` against Neon), never from
 * inside a function invocation and never from Vercel's build step. Why not the
 * build: every preview deploy would run DDL on every PR; the build would depend
 * on a cold compute and hold the database secret; and the seed is idempotent
 * but not inert — a fixture that lowers `max_uses` under a live `used_count`
 * aborts on the CHECK, which is a human's decision, not a deploy failure. Why
 * the *direct* host and not the `-pooler` one: the migrator would work through
 * PgBouncer (one transaction, no `CONCURRENTLY` — see below), but an operator's
 * single connection has no pooling problem for PgBouncer to solve, the `psql`
 * read-back that follows (`\d`, `SHOW max_connections`) is a plain session on
 * the direct host anyway, and keeping DDL off the endpoint the function shares
 * with fifty instances is one less thing to reason about during a demo.
 *
 * Run directly by Node's type stripping (`node src/migrate.ts`), on by default
 * from Node 22.18 — the same mechanism `scripts/with-env.ts` uses. No build step,
 * so `db:migrate` works on a fresh clone before anything has been compiled.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import type { Client } from "pg";

const EXIT_MISCONFIGURED = 2;

/** `packages/db/drizzle`, whether this runs as `src/migrate.ts` or `dist/migrate.js`. */
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

/**
 * How many migrations the database has already recorded. Drizzle's own journal
 * table is the source of truth; it does not exist before the first run, hence
 * the existence probe rather than a caught error.
 */
async function countAppliedMigrations(client: Client): Promise<number> {
  const present = await client.query<{ present: boolean }>(
    "SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present",
  );
  if (present.rows[0]?.present !== true) return 0;

  const counted = await client.query<{ applied: string }>(
    "SELECT count(*)::text AS applied FROM drizzle.__drizzle_migrations",
  );
  return Number(counted.rows[0]?.applied ?? "0");
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error(
      "migrate: DATABASE_URL is not set. Run through the repository scripts " +
        "(`pnpm db:migrate`), which load the local environment, or export it yourself.",
    );
    process.exit(EXIT_MISCONFIGURED);
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const before = await countAppliedMigrations(client);
    console.log(`migrate: ${before} migration(s) already applied`);

    // All pending migrations run in ONE transaction, not one per file. Drizzle's
    // pg dialect opens `session.transaction(...)` once and loops every pending
    // file — each file's statements, then its `drizzle.__drizzle_migrations`
    // insert — inside it (drizzle-orm 0.45.2, `pg-core/dialect.js`, `migrate()`
    // at line 44; the transaction at line 60). So a failure anywhere in the run
    // leaves neither DDL nor journal rows behind from *any* file of that run,
    // not merely the failing one; migration 0005's header states the same
    // boundary from the other side. It holds because no migration here uses
    // `CREATE INDEX CONCURRENTLY`, which cannot run inside a transaction block.
    await migrate(drizzle(client), { migrationsFolder });

    const after = await countAppliedMigrations(client);
    if (after === before) {
      console.log("migrate: no pending migrations — nothing to do");
    } else {
      console.log(`migrate: applied ${after - before} migration(s); ${after} total`);
    }
  } finally {
    await client.end();
  }
}

try {
  await main();
} catch (error: unknown) {
  console.error(`migrate: failed — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
