// @layer: unit
// @spec: 004-storefront-per-the-design
// @regression
/**
 * The five-card selection rule, one case per reading it has to settle
 * (functional spec §2.6 crit 1; technical-considerations §2.2 "Row selection",
 * §4.1's table, assumption 1).
 *
 * No DOM and no network: `selectPopularProducts` is a pure function from a
 * product list to a shorter product list, and the fixture below is the seed's
 * twelve SKUs with the seed's purchasable flags — the three `KEY-*` items at
 * indices 3–5 are the only ones that can be bought. The order of the fixture
 * *is* the catalogue's order (`packages/db/src/fixtures/catalog.ts`, verbatim
 * from the brief), which is what makes the first case an assertion about the
 * shop and not about an arbitrary list.
 *
 * ---------------------------------------------------------------------------
 * THE CASE THIS FILE EXISTS FOR
 * ---------------------------------------------------------------------------
 * *"The seed-shaped fixture → CS2, GTA V, Tarkov, Steam 500, Steam 1000."*
 *
 * The functional spec says "the three items that can be bought first, then
 * the next two items in the shop's own order". Two readings fit that
 * sentence: partition the list (purchasable first, then the rest, order kept)
 * and take five; or take the three keys and then the two items *following the
 * last key* (Discord, YouTube). Assumption 1 picks the partition. This case
 * pins that choice by name so that whichever way the function is later
 * rewritten, the row a reviewer sees is the one the spec's assumptions list
 * says they will see.
 *
 * The RED for this file (§4.1) is to replace the body with
 * `products.slice(0, count)` — the simplest thing that returns five — and
 * watch this case fail with the three Steam top-ups leading. The other cases
 * survive that mutation or do not, as noted on each; together they make sure
 * the fix is "partition" and not "return these five SKUs".
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT ASSERTED HERE
 * ---------------------------------------------------------------------------
 * "Exactly five, Купить on three" is a fact about the seed, not about the
 * function: with a two-item catalogue the function returns two. The browser
 * tests in `e2e/products.spec.ts` assert the seed's count against the real
 * `GET /api/products`; this file asserts the *rule* on lists of other shapes.
 */
import { Currency, minorUnits } from "@game-shop/contracts";
import { describe, expect, it } from "vitest";

import type { Product } from "../../../entities/product/index.js";
import { selectPopularProducts } from "./select-popular-products.js";

/**
 * A `Product` with the minimum a test needs to tell it apart: the SKU, and the
 * flag the rule reads. `name` and `priceMinor` are filled so the object is a
 * real `Product` and not a cast; `image` is `null`, the column's nullable
 * shape, because nothing here looks at it.
 */
function product(sku: string, purchasable: boolean): Product {
  return {
    sku,
    name: sku,
    priceMinor: minorUnits(100),
    currency: Currency.Rub,
    image: null,
    purchasable,
  };
}

function skus(products: readonly Product[]): readonly string[] {
  return products.map((item) => item.sku);
}

/**
 * The seed, in the seed's order: three Steam top-ups, three keys, three
 * subscriptions, three gift cards. Only the keys are purchasable
 * (`purchasableProductType = "key"` in the fixture).
 */
const seedShaped: readonly Product[] = [
  product("STEAM-TOPUP-500", false),
  product("STEAM-TOPUP-1000", false),
  product("STEAM-TOPUP-2500", false),
  product("KEY-CS2-PRIME", true),
  product("KEY-GTA5", true),
  product("KEY-EFT", true),
  product("SUB-DISCORD-1M", false),
  product("SUB-YT-3M", false),
  product("SUB-SPOTIFY-1M", false),
  product("GIFT-PSN-1000", false),
  product("GIFT-XBOX-1500", false),
  product("GIFT-ROBLOX-800", false),
];

describe("selectPopularProducts — purchasable first, catalogue order within each half, first count", () => {
  it("the seed-shaped fixture → CS2, GTA V, Tarkov, Steam 500, Steam 1000 (assumption 1)", () => {
    // The RED case: `slice(0, 5)` answers with the three Steam top-ups leading.
    // The two display-only cards are the *first* two non-purchasable items in
    // catalogue order — not Discord and YouTube, the two after the last key.
    expect(skus(selectPopularProducts(seedShaped))).toEqual([
      "KEY-CS2-PRIME",
      "KEY-GTA5",
      "KEY-EFT",
      "STEAM-TOPUP-500",
      "STEAM-TOPUP-1000",
    ]);
  });

  it("an empty catalogue → an empty row", () => {
    expect(selectPopularProducts([])).toEqual([]);
  });

  it("three items, one purchasable → all three, the purchasable one first", () => {
    // Fewer items than `count`: the function returns what the catalogue
    // affords, still partitioned. "Exactly five" is the seed's fact, not the
    // function's promise.
    const three = [product("A", false), product("B", true), product("C", false)];

    expect(skus(selectPopularProducts(three))).toEqual(["B", "A", "C"]);
  });

  it("seven purchasable of nine → the first five purchasable, in input order", () => {
    // More purchasable items than `count`: the second half is never reached,
    // and the five that are taken are the first five keys as listed, not a
    // sorted or shuffled five.
    const nine = [
      product("N1", false),
      product("P1", true),
      product("P2", true),
      product("N2", false),
      product("P3", true),
      product("P4", true),
      product("P5", true),
      product("P6", true),
      product("P7", true),
    ];

    expect(skus(selectPopularProducts(nine))).toEqual(["P1", "P2", "P3", "P4", "P5"]);
  });

  it("preserves catalogue order within each half — a partition, not a sort", () => {
    // `count` larger than the list, so the whole partition is visible: every
    // purchasable item in its original relative order, then every other item
    // in its original relative order. A sort by SKU would put "A" first.
    const mixed = [
      product("Z-plain", false),
      product("M-key", true),
      product("A-plain", false),
      product("B-key", true),
    ];

    expect(skus(selectPopularProducts(mixed, 10))).toEqual([
      "M-key",
      "B-key",
      "Z-plain",
      "A-plain",
    ]);
  });

  it("honours count — count = 2 on the seed → the first two keys", () => {
    expect(skus(selectPopularProducts(seedShaped, 2))).toEqual(["KEY-CS2-PRIME", "KEY-GTA5"]);
  });

  it("does not mutate its input", () => {
    // A `sort` in place would pass every case above and still corrupt the
    // caller's list; the entity's array is `readonly` and this keeps it so.
    const before = skus(seedShaped);
    const input = [...seedShaped];

    selectPopularProducts(input);

    expect(skus(input)).toEqual(before);
  });
});
