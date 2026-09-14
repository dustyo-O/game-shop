// @layer: unit
// @spec: 004-storefront-per-the-design
// @regression
/**
 * `parseCatalogResponse` — the one place an untyped `GET /api/products` body
 * becomes `Product[]` (technical-considerations §2.5; §4.1's table; R5).
 *
 * No network: the function takes `unknown` and is exercised with hand-built
 * rows shaped like the seed (`packages/db/src/fixtures/catalog.ts`). The
 * `fetch` half of `fetchProducts` is not under test here; it is a one-line
 * call to `shared/api/http.js`, and the browser suite covers it by routing the
 * endpoint to a 503 and reading the row's error sentence.
 *
 * ---------------------------------------------------------------------------
 * THE CASE THIS FILE EXISTS FOR
 * ---------------------------------------------------------------------------
 * *"`image: 42` throws `CatalogResponseError`."*
 *
 * `image` is the catalogue's only nullable field, and a nullable field is the
 * one a parser gets wrong by accident: `image: row["image"] ?? null` is a line
 * shorter than a real check, compiles, passes the `null` and string cases, and
 * lets a number through to the card — where `new URL(42, origin)` is a
 * perfectly valid `http://host/42`, and the row becomes five 404s the console
 * reports one by one instead of one `CatalogResponseError` reported here. The
 * RED for this file (§4.1) is exactly that shortcut: make the reader accept
 * any value and watch this case fail.
 *
 * ---------------------------------------------------------------------------
 * A MISSING KEY IS NOT `null`
 * ---------------------------------------------------------------------------
 * `CatalogService` writes `image: row.image` for every row and the column is
 * `string | null`, so the key is always on the wire — `JSON.stringify` omits
 * `undefined`, never `null`. A body without the key is therefore not "a row
 * with no picture"; it is a body that is not the one the endpoint promises (a
 * renamed field, a different endpoint answering on the same path), and it is
 * rejected for the same reason `{"products": []}` is. Read as `null` it would
 * blank every card without a word in the console.
 *
 * `price_minor: null` is the pre-existing guard restated: `JSON.parse` cannot
 * produce `NaN`, but it produces `null` gladly, and `typeof null` is not
 * `"number"`. It stays here so a later edit to the money reader cannot loosen
 * it unnoticed.
 */
import { describe, expect, it } from "vitest";

import { CatalogResponseError, parseCatalogResponse } from "./products-api.js";

/**
 * The seed's CS2 row minus `image`, so the missing-key case is a fixture in
 * its own right rather than a `delete` on a copy.
 */
const cs2WithoutImage = {
  sku: "KEY-CS2-PRIME",
  name: "CS2 Prime Status ключ",
  price_minor: 129000,
  currency: "RUB",
  purchasable: true,
} as const;

const cs2 = { ...cs2WithoutImage, image: "assets/cs2.png" } as const;

const gta5 = {
  sku: "KEY-GTA5",
  name: "GTA V ключ активации",
  price_minor: 199000,
  currency: "RUB",
  image: "assets/gta5.png",
  purchasable: true,
} as const;

/** One parsed row, or the throw — `parseCatalogResponse` always takes the array. */
function parseOne(row: unknown): ReturnType<typeof parseCatalogResponse>[number] {
  const [product] = parseCatalogResponse([row]);

  if (product === undefined) {
    throw new Error("parseOne: the parser returned no rows for a one-row body");
  }

  return product;
}

describe("parseCatalogResponse — the wire becomes Product[]", () => {
  describe("a valid row", () => {
    it("carries every field, kopecks under the branded name and the wire snake_case gone", () => {
      expect(parseOne(cs2)).toEqual({
        sku: "KEY-CS2-PRIME",
        name: "CS2 Prime Status ключ",
        priceMinor: 129000,
        currency: "RUB",
        image: "assets/cs2.png",
        purchasable: true,
      });
    });
  });

  describe("image — the nullable column", () => {
    it("null is kept as null: a row without artwork is listed, not dropped", () => {
      expect(parseOne({ ...cs2, image: null }).image).toBeNull();
    });

    it("a string is kept verbatim — relative, no leading slash; resolving it is the card's job", () => {
      expect(parseOne({ ...cs2, image: "assets/cs2.png" }).image).toBe("assets/cs2.png");
    });

    it("42 throws CatalogResponseError — the case this file exists for", () => {
      expect(() => parseOne({ ...cs2, image: 42 })).toThrow(CatalogResponseError);
      expect(() => parseOne({ ...cs2, image: 42 })).toThrow(/^product\.image/);
    });

    it("a missing key throws — the wire always sends it, so its absence is a different payload", () => {
      expect(() => parseOne(cs2WithoutImage)).toThrow(CatalogResponseError);
      expect(() => parseOne(cs2WithoutImage)).toThrow(/^product\.image/);
    });
  });

  describe("the guards that were already there", () => {
    it("price_minor: null throws — JSON.parse produces null, and null is not a finite number", () => {
      expect(() => parseOne({ ...cs2, price_minor: null })).toThrow(CatalogResponseError);
    });

    it("a non-array body throws — {\"products\": []} is not the promised shape", () => {
      expect(() => parseCatalogResponse({ products: [] })).toThrow(CatalogResponseError);
    });

    it("a row that is not an object throws", () => {
      expect(() => parseCatalogResponse(["KEY-CS2-PRIME"])).toThrow(CatalogResponseError);
    });
  });

  describe("the array", () => {
    it("an empty body is an empty catalogue, not an error — the page tells those apart", () => {
      expect(parseCatalogResponse([])).toEqual([]);
    });

    it("keeps the rows in the order the API sent them", () => {
      expect(parseCatalogResponse([cs2, gta5]).map((product) => product.sku)).toEqual([
        "KEY-CS2-PRIME",
        "KEY-GTA5",
      ]);
      expect(parseCatalogResponse([gta5, cs2]).map((product) => product.sku)).toEqual([
        "KEY-GTA5",
        "KEY-CS2-PRIME",
      ]);
    });
  });
});
