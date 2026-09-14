/**
 * Reading the catalogue from `GET /api/products`.
 *
 * The endpoint answers a bare JSON array of twelve rows with snake_case wire
 * fields (spec 001 technical-considerations §2.3). This file is the only place that
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
 * A nullable text column on the wire: a string or JSON `null`, nothing else.
 *
 * A *missing* key is `undefined`, and it is rejected rather than read as
 * `null`. `CatalogService` writes `image: row.image` for every row and the
 * column is `string | null`, so the key is always on the wire —
 * `JSON.stringify` omits `undefined`, never `null`. A body without the key is
 * therefore not "a row with no picture"; it is a body that is not the one
 * `GET /api/products` promises (a renamed field, another endpoint answering
 * on the same path), and it is rejected for the same reason `{"products": []}`
 * is. Read as `null`, it would blank every card without a word in the console.
 * Same rule as {@link readString}, which also treats an absent key as a wrong
 * type.
 */
function readNullableString(row: Record<string, unknown>, field: string): string | null {
  const value = row[field];

  if (value !== null && typeof value !== "string") {
    throw new CatalogResponseError(`product.${field}: expected a string or null, got ${typeof value}`);
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
 * One wire row → one {@link Product}. Every field is read through a checked
 * reader; nothing is copied across on trust.
 *
 * `image` is carried through as the wire holds it — `assets/cs2.png`, or
 * `null` for a row without artwork. The artwork ships with the page under
 * `apps/web/public/assets/`, at the very paths the seed already holds, so the
 * value needs no rewriting here; resolving it against the page's origin is the
 * card's job (`../ui/product-card.ts`), which keeps this function a pure
 * statement about the wire. (Phases 1–3 dropped the field at this line on
 * purpose: no files existed and the plain page had nowhere to show one, so not
 * constructing an `<img>` was what kept the network panel free of 404s.)
 */
function toProduct(value: unknown): Product {
  const row = asRecord(value, "product");

  return {
    sku: readString(row, "sku"),
    name: readString(row, "name"),
    priceMinor: readPriceMinor(row),
    currency: readCurrency(row),
    image: readNullableString(row, "image"),
    purchasable: readPurchasable(row),
  };
}

/**
 * The parser proper, separated from the request so it can be exercised on
 * hand-built bodies in `products-api.test.ts` without a server. Takes the
 * decoded JSON as `unknown` — a bare array of rows is the promised shape, and
 * anything else (`{"products": []}`, an HTML error page, a lone row) throws.
 * Row order is the API's, which is the seed's.
 *
 * Exported for the colocated test only; the slice's `index.ts` does not
 * re-export it, because nothing above the entity has a body to parse.
 */
export function parseCatalogResponse(body: unknown): readonly Product[] {
  if (!Array.isArray(body)) {
    throw new CatalogResponseError(`${productsEndpoint}: expected an array`);
  }

  return body.map(toProduct);
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
  return parseCatalogResponse(await getJson(productsEndpoint));
}
