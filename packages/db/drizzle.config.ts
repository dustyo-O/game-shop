/**
 * drizzle-kit configuration.
 *
 * Used by `pnpm --filter @game-shop/db run db:generate`, which diffs `./src/schema`
 * against the snapshot in `./drizzle/meta` and writes the next migration as plain
 * SQL. Generation never connects to a database; the credentials below exist only
 * for the optional drizzle-kit commands that do (`studio`, `check`).
 *
 * Applying migrations is NOT drizzle-kit's job here — that is `./src/migrate.ts`,
 * run by the package's `migrate` script, so the deployed path uses the same
 * runner and the same driver as the application.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema",
  out: "./drizzle",
  // Empty when unset: `generate` does not connect, and the runner that does
  // reads DATABASE_URL itself and fails loudly when it is missing.
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
  strict: true,
  verbose: true,
});
