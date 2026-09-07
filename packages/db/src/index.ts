/**
 * Database access for the game shop.
 *
 * Three parts:
 *
 *   - `./schema` — every table, constraint and index, each annotated with the
 *     invariant (I1-I9, `context/product/architecture.md` §3) it enforces and
 *     the exact SQL statement it supports.
 *   - `./client` — the serverless-shaped client: a pool of exactly one
 *     connection per function instance, no server-side prepared statements, and
 *     a thin transaction helper. Read that file's header before touching either
 *     setting; both follow from the deployment shape rather than from taste.
 *   - `./fixtures` — the assignment's fixed inputs, transcribed so they can be
 *     diffed against the brief: the twelve supplied products and the fifty
 *     supplied supplier keys.
 *
 * Two executables sit alongside them and are deliberately **not** exported, since
 * importing either should never be how they run: `./migrate.ts` applies the
 * migrations in `./drizzle` (`pnpm --filter @game-shop/db run migrate`) using its
 * own plain-TCP connection, and `./seed.ts` loads the fixtures above
 * (`pnpm --filter @game-shop/db run seed`). Both are safe to run twice.
 */

export * from "./schema/index.js";
export * from "./client.js";
export * from "./fixtures/index.js";
