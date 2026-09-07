/**
 * Reading the catalogue from `GET /api/products`.
 *
 * The endpoint answers a bare JSON array of twelve rows with snake_case wire
 * fields (technical-considerations §2.3). This file is the only place that
 * knows that, and the only place where an untyped `unknown` becomes a
 * {@link Product}.
 *
 * **Why parse at all rather than assert.** `packages/contracts` puts it well: a
 * wire type is a description of what the other side promised, never evidence
 * that a particular payload conformed. `body as Product[]` compiles against a
 * `404` HTML page, against `{"products": []}`, and against a row whose price
 * arrived as the string `"129000"` — and each of those would surface much later
 * as `undefined` in the middle of the page instead of here, where it can be
 * turned into the one thing a shopper can act on: «Не удалось загрузить
 * каталог».
 */
import { Currency, minorUnits } from "@game-shop/contracts";

import { getJson } from "../../../shared/api/http.js";
import type { Product } from "../model/product.js";

const productsEndpoint = "/api/products";

/** The response did not have the shape `GET /api/products` promises. */
export class CatalogResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogResponseError";
  }
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CatalogResponseError(`${context}: expected an object, got ${typeof value}`);
  }

  // Safe after the check above: an object with unknown-valued keys is the
  // weakest true statement about it, and every field below is still narrowed.
  return value as Record<string, unknown>;
}

function readString(row: Record<string, unknown>, field: string): string {
  const value = row[field];

  if (typeof value !== "string") {
    throw new CatalogResponseError(`product.${field}: expected a string, got ${typeof value}`);
  }

  return value;
}

/**
 * The one place a raw JSON number becomes a branded amount.
 *
 * The finiteness check is not ceremony: `JSON.parse` cannot produce `NaN`, but
 * it happily produces `null`, and `minorUnits(null as never)` would sail
 * through to `formatPrice` and render «null ₽».
 */
function readPriceMinor(row: Record<string, unknown>): Product["priceMinor"] {
  const value = row["price_minor"];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CatalogResponseError(`product.price_minor: expected a finite number, got ${typeof value}`);
  }

  return minorUnits(value);
}

function readCurrency(row: Record<string, unknown>): Currency {
  const value = readString(row, "currency");

  if (value !== Currency.Rub) {
    throw new CatalogResponseError(`product.currency: unsupported currency "${value}"`);
  }

  return value;
}

function readPurchasable(row: Record<string, unknown>): boolean {
  const value = row["purchasable"];

  if (typeof value !== "boolean") {
    throw new CatalogResponseError(`product.purchasable: expected a boolean, got ${typeof value}`);
  }

  return value;
}

/**
 * `products.image` is read but not carried into {@link Product}, and that is on
 * purpose. The column holds paths like `assets/steam.png`; **those files do not
 * exist in this repository**, and this deliberately plain page has no picture
 * to show anyway. Dropping the field here means no `<img>` is ever constructed,
 * so there are no 404s in the network panel and no `net::ERR` lines in the
 * console. Phase 4 builds the real storefront against the Figma design, ships
 * the artwork with it, and reinstates the field then.
 */
function toProduct(value: unknown): Product {
  const row = asRecord(value, "product");

  return {
    sku: readString(row, "sku"),
    name: readString(row, "name"),
    priceMinor: readPriceMinor(row),
    currency: readCurrency(row),
    purchasable: readPurchasable(row),
  };
}

/**
 * The full catalogue, in the order the API returns it — which is the order the
 * assignment prints it, because `CatalogService` orders by the seed's identity
 * column.
 *
 * Rejects rather than returning an empty list when the request fails: an empty
 * catalogue and an unreachable API are different things to a shopper, and the
 * page renders a different message for each.
 */
export async function fetchProducts(): Promise<readonly Product[]> {
  const body = await getJson(productsEndpoint);

  if (!Array.isArray(body)) {
    throw new CatalogResponseError(`${productsEndpoint}: expected an array`);
  }

  return body.map(toProduct);
}
