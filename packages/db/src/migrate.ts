#!/usr/bin/env node
/**
 * Applies every pending migration in `../drizzle`, then exits.
 *
 * Contract (relied on by the root `pnpm db:migrate`, `db:setup` and `db:reset`):
 *
 *   - reads `DATABASE_URL` from the environment; it does **not** load `.env`
 *     itself — `scripts/with-env.ts` has already assembled the environment, and
 *     on Vercel/Neon the platform supplies it;
 *   - applies every migration not yet recorded in `drizzle.__drizzle_migrations`;
 *   - is idempotent: a second run applies nothing and exits 0;
 *   - runs with cwd = `packages/db`, but resolves the migrations folder from its
 *     own location, so it also works when invoked from anywhere else.
 *
 * Driver: `node-postgres` over plain TCP, not `drizzle-orm/neon-serverless`.
 * Migrations are run by a developer, by `db:setup`, or by a deploy step — never
 * from inside a function invocation — and Neon's pooled endpoint speaks the
 * ordinary wire protocol just as the local Docker container does. The WebSocket
 * serverless driver exists for the request path, which never migrates.
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

    // Each migration file runs inside a transaction and is recorded in
    // `drizzle.__drizzle_migrations` in that same transaction, so a failure
    // half-way leaves neither the DDL nor the journal entry behind.
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
