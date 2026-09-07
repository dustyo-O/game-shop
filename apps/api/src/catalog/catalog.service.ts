/**
 * Reading the product list — the whole of the `catalog` module's
 * responsibility (technical-considerations §2.4).
 *
 * There is no caching layer and no in-memory copy of the catalogue here. The
 * twelve rows are read from Postgres on every request, and that is the point:
 * `packages/db/src/fixtures/catalog.ts` is a *seed input*, not a runtime source.
 * A hard-coded list would keep answering after someone changed a price, which
 * is exactly the class of drift the seed's `ON CONFLICT (sku) DO UPDATE` exists
 * to make impossible.
 */
import { Inject, Injectable } from "@nestjs/common";

import { Currency, minorUnits } from "@game-shop/contracts";
import { products, type DatabaseClient } from "@game-shop/db";

import { DATABASE_CLIENT } from "../database/database.module.js";
import type { CatalogProduct } from "./catalog.types.js";

/**
 * One row as the query below returns it: the wire's six fields, still in the
 * schema's camelCase and still with `price_minor` as an unbranded `number` and
 * `currency` as an unbranded `text` column.
 */
interface ProductRow {
  readonly sku: string;
  readonly name: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly image: string | null;
  readonly purchasable: boolean;
}

/**
 * `text` column → {@link Currency}.
 *
 * A narrowing check rather than `row.currency as Currency`. The assertion would
 * compile and be wrong in the one case that matters: a row carrying a currency
 * the shop does not handle would reach the page typed as if it did, and
 * `MINOR_UNITS_PER_MAJOR` — correct only for exponent-2 currencies — would
 * silently misformat it. Throwing instead surfaces a bad catalogue row as a
 * `500` on the shop page, which is honest about a shop that cannot price its
 * own goods.
 */
function toCurrency(value: string): Currency {
  if (value === Currency.Rub) return value;
  throw new Error(`catalog: product row has unsupported currency "${value}"`);
}

function toCatalogProduct(row: ProductRow): CatalogProduct {
  return {
    sku: row.sku,
    name: row.name,
    // Brands the raw integer column as kopecks. See `CatalogProduct.price_minor`
    // and `packages/contracts/src/money.ts` — this is the one place a
    // `products.price_minor` value becomes a typed amount on the way out.
    price_minor: minorUnits(row.priceMinor),
    currency: toCurrency(row.currency),
    image: row.image,
    purchasable: row.purchasable,
  };
}

@Injectable()
export class CatalogService {
  constructor(@Inject(DATABASE_CLIENT) private readonly database: DatabaseClient) {}

  /**
   * The full catalogue, in the order the brief prints it.
   *
   * Ordinary CRUD, so it carries no invariant — but the emitted statement is
   * written out anyway, per the project's raw-SQL rule
   * (`context/product/architecture.md` §2, "Documentation convention"):
   *
   *   SELECT "sku", "name", "price_minor", "currency", "image", "purchasable"
   *   FROM "products"
   *   ORDER BY "id";
   *   -- 0 rows => the database has not been seeded. An empty catalogue, not an
   *   --           error: the endpoint answers `[]` and the page renders empty.
   *
   * Two choices worth naming:
   *
   *   - **An explicit column list, not `select()`.** The row shape is the
   *     response shape, so adding a column to `products` cannot quietly widen
   *     what this endpoint publishes.
   *   - **`ORDER BY id`.** `products.id` is a generated identity assigned in
   *     seed order, and the seed inserts the fixture in the brief's order — so
   *     this reproduces the catalogue as the assignment lists it. Without an
   *     ORDER BY, Postgres may return the rows in any order at all, and an
   *     UPDATE to one row is enough to move it: the shop page would reshuffle
   *     itself for no visible reason.
   */
  async listProducts(): Promise<readonly CatalogProduct[]> {
    const rows = await this.database.db
      .select({
        sku: products.sku,
        name: products.name,
        priceMinor: products.priceMinor,
        currency: products.currency,
        image: products.image,
        purchasable: products.purchasable,
      })
      .from(products)
      .orderBy(products.id);

    return rows.map(toCatalogProduct);
  }
}
