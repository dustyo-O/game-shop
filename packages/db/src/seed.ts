#!/usr/bin/env node
/**
 * Loads the assignment's fixed inputs — the twelve supplied products and the
 * fifty supplied supplier keys — plus one all-zero `supplier_behaviour` row per
 * supplier, then exits.
 *
 * Contract (relied on by the root `pnpm db:seed`, `db:setup` and `db:reset`),
 * matching `./migrate.ts`:
 *
 *   - reads `DATABASE_URL` from the environment; it does **not** load `.env` —
 *     `scripts/with-env.ts` has already assembled the environment, and on
 *     Vercel/Neon the platform supplies it;
 *   - runs with cwd = `packages/db`, but depends on nothing in the working
 *     directory (the data is imported, not read from disk);
 *   - **is safe to run twice.** `pnpm db:setup` runs migrate-then-seed on every
 *     `pnpm dev:stack`, so this runs against a database that is usually already
 *     seeded and may already have live orders against it. See "Idempotence" below.
 *   - reports what it did, so a developer sees whether anything changed.
 *
 * ---------------------------------------------------------------------------
 * IDEMPOTENCE — TWO DIFFERENT ON CONFLICT CLAUSES, ON PURPOSE
 * ---------------------------------------------------------------------------
 * The three tables want different things, and the difference is the whole of
 * this script's correctness:
 *
 *   - `products` uses **ON CONFLICT (sku) DO UPDATE**. The catalogue is a
 *     transcription of the brief, so the fixture is authoritative: correcting a
 *     price or a name in `./fixtures/catalog.ts` and re-seeding must fix the
 *     row. That is safe because an order copies `sku` and `amount_minor` at
 *     creation time and never reads them back through `products`
 *     (`./schema/shop.ts`, `orders.sku`) — so re-pricing the catalogue cannot
 *     rewrite the history of what someone was charged.
 *
 *   - `supplier_behaviour` uses **ON CONFLICT (provider) DO NOTHING**, for the
 *     same reason as `supplier_keys` in a milder form: the row carries a knob a
 *     reviewer may have set moments ago, and a routine `pnpm dev:stack` must not
 *     spend their armed one-shot behind their back. The reset button is the
 *     control endpoint, not this script.
 *
 *   - `supplier_keys` uses **ON CONFLICT (code) DO NOTHING**. A key row carries
 *     state this script did not write: once claimed, `claimed_by_request_id` and
 *     `claimed_at` are the supplier's record that a code was handed to exactly
 *     one request (I6, `context/product/architecture.md` §3). There is no
 *     "unclaim"; DO UPDATE here — even setting only the columns below — would be
 *     a way for a routine `pnpm dev:stack` to resell a key that a delivered
 *     order is already holding. DO NOTHING makes an existing row untouchable.
 *
 * All three statements are single multi-row INSERTs (one round trip each, per
 * the `data-batch-inserts` rule) and all three are atomic
 * insert-or-ignore/update rather than SELECT-then-INSERT (`data-upsert`):
 * nothing here reads a row to decide whether to write it, so two seeds racing
 * each other cannot both insert.
 *
 * This script writes both the shop's tables and the supplier's, which no other
 * code in the repository is allowed to do. It is the loader, not a participant:
 * it runs before the system starts and never during a request. The boundary the
 * rest of the codebase honours is described in `./schema/supplier.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONE COMPILES FIRST AND `./migrate.ts` DOES NOT
 * ---------------------------------------------------------------------------
 * `pnpm --filter @game-shop/db run seed` is `pnpm run build && node dist/seed.js`,
 * whereas `run migrate` is plain `node src/migrate.ts` under Node's type
 * stripping. The difference is not taste, it is module resolution: type stripping
 * compiles a file but does **not** rewrite import specifiers, and Node will not
 * resolve `./client.js` to `./client.ts` —
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/client.js'
 *     imported from .../src/seed.ts
 *
 * `./migrate.ts` gets away with it because it imports nothing local. This file
 * imports the schema, the client and the fixtures, and each of those imports
 * others, so the whole graph would have to switch to `.ts` specifiers — a
 * repository-wide convention flip to save one `tsc` run. Compiling first also
 * means an edit to `./fixtures/catalog.ts` can never be seeded from a stale
 * `dist/`, and a type error stops the seed instead of reaching the database.
 */
import { sql } from "drizzle-orm";

import { createDatabaseClient, type Transaction } from "./client.js";
import {
  MINOR_UNITS_PER_ROUBLE,
  catalogCurrency,
  productCatalog,
  purchasableProductType,
} from "./fixtures/catalog.js";
import {
  supplierBehaviourBaseline,
  supplierBehaviourProviders,
} from "./fixtures/supplier-behaviour.js";
import { supplierKeyPool } from "./fixtures/supplier-key-pool.js";
import { products, type NewProduct } from "./schema/shop.js";
import {
  supplierBehaviour,
  supplierKeys,
  type NewSupplierBehaviourRow,
  type NewSupplierKey,
} from "./schema/supplier.js";

const EXIT_MISCONFIGURED = 2;

interface SeedSummary {
  readonly productsInserted: number;
  readonly productsUpdated: number;
  readonly productsTotal: number;
  readonly keysInserted: number;
  readonly keysTotal: number;
  readonly keysClaimed: number;
  readonly behaviourInserted: number;
  readonly behaviourTotal: number;
}

/**
 * The catalogue rows as the database wants them.
 *
 * Two derivations happen here and nowhere else, which is why this is a named
 * function rather than an inline `.map()`:
 *
 *  1. **Roubles → minor units.** The brief prints «CS2 Prime Status ключ» at
 *     1290 ₽; `products.price_minor` must hold `129000`. A factor-of-100 error
 *     would not fail anything here — it would surface much later as a wrong
 *     amount on the order page — so the multiplication is one expression, next
 *     to the constant that names it.
 *  2. **`purchasable`.** Assumption A4 (technical-considerations §Assumptions):
 *     the three products of type `key` are purchasable, the other nine are
 *     display-only. Derived from `type` rather than listed by hand, so the two
 *     cannot drift apart when the catalogue changes.
 */
function catalogRows(): NewProduct[] {
  return productCatalog.map((item) => ({
    sku: item.sku,
    name: item.name,
    type: item.type,
    priceMinor: item.priceRub * MINOR_UNITS_PER_ROUBLE,
    currency: catalogCurrency,
    image: item.image,
    purchasable: item.type === purchasableProductType,
  }));
}

/** The pool as the database wants it: every code unclaimed. */
function keyPoolRows(): NewSupplierKey[] {
  // `claimed_by_request_id` and `claimed_at` are left to their column defaults
  // (NULL) rather than written explicitly — an unclaimed key is the absence of a
  // claim, and naming the columns here would invite a future edit that resets
  // them on an existing row.
  return supplierKeyPool.map((code) => ({ code }));
}

/**
 * The behaviour rows as the database wants them: one per provider, every knob
 * off.
 *
 * Written out column by column with no reliance on a column default, because
 * `supplier_behaviour` has none (migration 0003) — every number in that table is
 * one somebody wrote on purpose, and this is the somebody for a fresh clone.
 */
function behaviourRows(): NewSupplierBehaviourRow[] {
  return supplierBehaviourProviders.map((provider) => ({
    provider,
    ...supplierBehaviourBaseline,
  }));
}

/**
 *   SELECT count(*)::int AS n FROM products;
 *
 * The cast is not decoration: `count(*)` is `bigint`, which node-postgres hands
 * back as a string to avoid silently truncating; `::int` keeps this a number.
 */
async function countProducts(tx: Transaction): Promise<number> {
  const rows = await tx.select({ n: sql<number>`count(*)::int` }).from(products);
  return rows[0]?.n ?? 0;
}

async function seed(tx: Transaction): Promise<SeedSummary> {
  const productsBefore = await countProducts(tx);

  // ---------------------------------------------------------------------
  //   INSERT INTO products (sku, name, type, price_minor, currency, image, purchasable)
  //   VALUES ($1, $2, $3, $4, $5, $6, $7), ...   -- all twelve rows, one statement
  //   ON CONFLICT (sku) DO UPDATE SET
  //     name        = excluded.name,
  //     type        = excluded.type,
  //     price_minor = excluded.price_minor,
  //     currency    = excluded.currency,
  //     image       = excluded.image,
  //     purchasable = excluded.purchasable
  //   RETURNING sku;
  //   -- 12 rows, always: DO UPDATE returns the row whether it was inserted or
  //   --                  updated, so the count says nothing about which. How
  //   --                  many were new is the before/after difference below.
  //   -- Fewer than 12 is impossible: a duplicate sku in the fixture would make
  //   --   Postgres raise "ON CONFLICT DO UPDATE command cannot affect row a
  //   --   second time" rather than quietly drop one, so the twelve rows in
  //   --   ./fixtures/catalog.ts are twelve distinct products by construction.
  //
  // `excluded` is the row this statement proposed; the conflict target is the
  // `products_sku_key` unique index from ./schema/shop.ts, which is what makes
  // the whole statement re-runnable.
  // ---------------------------------------------------------------------
  const upserted = await tx
    .insert(products)
    .values(catalogRows())
    .onConflictDoUpdate({
      target: products.sku,
      set: {
        name: sql`excluded.name`,
        type: sql`excluded.type`,
        priceMinor: sql`excluded.price_minor`,
        currency: sql`excluded.currency`,
        image: sql`excluded.image`,
        purchasable: sql`excluded.purchasable`,
      },
    })
    .returning({ sku: products.sku });

  const productsAfter = await countProducts(tx);
  const productsInserted = productsAfter - productsBefore;

  // ---------------------------------------------------------------------
  //   INSERT INTO supplier_keys (code)
  //   VALUES ($1), ($2), ...                     -- all fifty codes, one statement
  //   ON CONFLICT (code) DO NOTHING
  //   RETURNING code;
  //   -- Returns ONLY the codes actually inserted, because DO NOTHING skips the
  //   --   conflicting rows entirely — which makes this count exact with no
  //   --   before/after arithmetic.
  //   -- 0 rows  => every code is already in the pool; this run changed nothing.
  //   --            That is the ordinary `pnpm dev:stack` case.
  //   -- 50 rows => a fresh database.
  //   -- Anything in between => the pool was partially loaded; the missing codes
  //   --            were added and the existing rows, claimed or not, were left
  //   --            exactly as they were.
  //
  // DO NOTHING, never DO UPDATE. The conflict target is `supplier_keys_code_key`
  // (./schema/supplier.ts); a row that already exists may be holding a claim
  // (I6 — one key → at most one request), and re-seeding must not be able to
  // hand a delivered order's key back to the pool.
  // ---------------------------------------------------------------------
  const insertedKeys = await tx
    .insert(supplierKeys)
    .values(keyPoolRows())
    .onConflictDoNothing({ target: supplierKeys.code })
    .returning({ code: supplierKeys.code });

  // ---------------------------------------------------------------------
  //   SELECT count(*)::int                       AS total,
  //          count(claimed_by_request_id)::int   AS claimed
  //   FROM supplier_keys;
  //
  // `count(<column>)` counts non-NULL values, so `claimed` is the number of keys
  // already handed out. Reported so a re-seed visibly leaves them alone.
  // ---------------------------------------------------------------------
  const poolRows = await tx
    .select({
      total: sql<number>`count(*)::int`,
      claimed: sql<number>`count("claimed_by_request_id")::int`,
    })
    .from(supplierKeys);
  const pool = poolRows[0] ?? { total: 0, claimed: 0 };

  // ---------------------------------------------------------------------
  //   INSERT INTO supplier_behaviour
  //     (provider, failure_rate, hang_rate, hang_ms, fail_next, hang_next)
  //   VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)
  //   ON CONFLICT (provider) DO NOTHING
  //   RETURNING provider;
  //   -- Returns ONLY the providers actually inserted; DO NOTHING skips the
  //   --   conflicting rows entirely, so this count is exact with no
  //   --   before/after arithmetic.
  //   -- 0 rows => both rows are already there. The ordinary `pnpm dev:stack`
  //   --   case, and the one this clause exists for.
  //   -- 2 rows => a fresh database. Every knob starts off, so the shop behaves
  //   --   exactly as it did before this table existed.
  //
  // DO NOTHING, NOT DO UPDATE — the opposite call from `products` above, and the
  // same one as `supplier_keys`, for a related reason. A behaviour row that
  // already exists carries a setting somebody deliberately made: a reviewer who
  // armed `fail_next = 1` and then ran `pnpm dev:stack` in the next terminal
  // would find their one-shot silently spent by a re-seed, and would then be
  // debugging a check that "randomly" stopped reproducing.
  //
  // The seed is therefore the loader and not the reset button. Restoring the
  // baseline is `PUT /internal/suppliers/:provider/behaviour` with an empty
  // body, which replaces the row with exactly the values below — the same
  // constant, so the two cannot drift.
  // ---------------------------------------------------------------------
  const insertedBehaviour = await tx
    .insert(supplierBehaviour)
    .values(behaviourRows())
    .onConflictDoNothing({ target: supplierBehaviour.provider })
    .returning({ provider: supplierBehaviour.provider });

  //   SELECT count(*)::int AS n FROM supplier_behaviour;
  const behaviourCountRows = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(supplierBehaviour);

  return {
    productsInserted,
    productsUpdated: upserted.length - productsInserted,
    productsTotal: productsAfter,
    keysInserted: insertedKeys.length,
    keysTotal: pool.total,
    keysClaimed: pool.claimed,
    behaviourInserted: insertedBehaviour.length,
    behaviourTotal: behaviourCountRows[0]?.n ?? 0,
  };
}

function report(summary: SeedSummary): void {
  console.log(
    `seed: products — ${summary.productsInserted} inserted, ` +
      `${summary.productsUpdated} updated; ${summary.productsTotal} in the catalogue`,
  );
  console.log(
    `seed: supplier_keys — ${summary.keysInserted} inserted, ` +
      `${summary.keysTotal - summary.keysInserted} already present; ` +
      `${summary.keysTotal} in the pool, ${summary.keysClaimed} claimed`,
  );
  console.log(
    `seed: supplier_behaviour — ${summary.behaviourInserted} inserted, ` +
      `${summary.behaviourTotal - summary.behaviourInserted} already present; ` +
      `${summary.behaviourTotal} providers configured`,
  );
  if (
    summary.productsInserted === 0 &&
    summary.keysInserted === 0 &&
    summary.behaviourInserted === 0
  ) {
    // "no new rows", not "nothing changed": the catalogue upsert rewrites all
    // twelve rows from the fixture on every run, which is how a drifted price
    // gets corrected. Only `supplier_keys` is genuinely untouched.
    console.log("seed: no new rows — the database was already seeded");
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl === "") {
    console.error(
      "seed: DATABASE_URL is not set. Run through the repository scripts " +
        "(`pnpm db:seed`), which load the local environment, or export it yourself.",
    );
    process.exit(EXIT_MISCONFIGURED);
  }

  // Its own client rather than the process-wide one: this is a script with a
  // lifetime, and `application_name` distinguishes it from an API instance in
  // `pg_stat_activity`. The pool is still one connection — see ./client.ts.
  const client = createDatabaseClient({ applicationName: "game-shop-seed" });

  try {
    // One transaction, so a failure half-way leaves neither half of the fixture
    // behind. It stays short and issues no network I/O of its own, which is what
    // ./client.ts requires of anything holding the instance's only connection.
    //
    //   BEGIN;  -- READ COMMITTED, the server default: this needs no isolation
    //           -- guarantees, only the two unique indexes it conflicts against.
    //   ... the statements above ...
    //   COMMIT;
    report(await client.transaction(seed));
  } finally {
    await client.close();
  }
}

try {
  await main();
} catch (error: unknown) {
  console.error(`seed: failed — ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
