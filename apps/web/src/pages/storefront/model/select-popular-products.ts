/**
 * Which products fill the «Популярные товары» row: purchasable items first,
 * catalogue order preserved within each half, then the first `count`
 * (functional spec §2.6; technical-considerations §2.2, "Row selection").
 *
 * Nothing here touches the DOM or the network. `ui/popular-products.ts`
 * fetches the catalogue and hands the array here; this file answers with the
 * shorter array the row should show, and the binding renders one card per
 * item. Pure and total, so it is checked in `select-popular-products.test.ts`
 * without a browser.
 *
 * ---------------------------------------------------------------------------
 * TWO READINGS OF ONE SENTENCE, AND WHY THIS ONE
 * ---------------------------------------------------------------------------
 * The functional spec asks for "the three items that can be bought first,
 * then the next two items in the shop's own order". That sentence admits two
 * selections from the seed:
 *
 *   partition  — purchasable first, the rest after, order kept within each:
 *                CS2, GTA V, Tarkov, Steam 500, Steam 1000
 *   following  — the three keys, then the two items *after the last key*:
 *                CS2, GTA V, Tarkov, Discord, YouTube
 *
 * The partition reading is chosen (technical-considerations assumption 1).
 * It is a walk down one ordering — the catalogue's — rather than a cursor
 * that has to remember where the keys ended; it stays stable if the catalogue
 * is reordered (the following reading changes its answer whenever a key moves
 * relative to its neighbours); and it puts the two display-only cards, the
 * Steam top-ups, beside the Steam block that sits directly above the row.
 *
 * ---------------------------------------------------------------------------
 * A STABLE PARTITION, NOT A SORT
 * ---------------------------------------------------------------------------
 * Two `filter` passes and a concatenation, then `slice`. `Array.prototype.sort`
 * with a comparator on `purchasable` would give the same answer today, but it
 * sorts in place — the entity's array is `readonly` and the caller may still
 * be holding it — and it would quietly become wrong the moment anyone read the
 * comparator as "sort by something else too". Two filters say exactly what the
 * rule is: the list, split in two, joined back in that order.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FUNCTION DOES NOT PROMISE
 * ---------------------------------------------------------------------------
 * It returns whatever the catalogue affords. With the seed that is five cards,
 * Купить on three; with a two-item catalogue it is two. "Exactly five, Купить
 * on exactly three" (§2.6 crit 1) is a fact about the seed, asserted by the
 * browser tests in `e2e/products.spec.ts` against the real `GET /api/products`
 * — not a guarantee this function can make, and not one it pads or throws to
 * fake.
 *
 * ---------------------------------------------------------------------------
 * WHY `pages/storefront/model/` AND NOT `entities/product/lib/`
 * ---------------------------------------------------------------------------
 * The entity knows what a product *is* — a SKU, a name, a price, whether it can
 * be bought. It has no notion of "popular": that is the storefront's word for
 * the five it chooses to put in one row on one page, and the tie-breaker
 * ("the Steam top-ups, because they sit beside the Steam block") is a fact
 * about this page's layout. A rule that reads a page's layout belongs to the
 * page. Putting it in the entity would export a page's editorial choice as if
 * it were a property of the domain, and the order page — which also imports
 * the entity — would carry it for nothing.
 */
import type { Product } from "../../../entities/product/index.js";

/** How many cards the row holds by default: the mockup draws five. */
const DEFAULT_COUNT = 5;

/**
 * The rule: purchasable items first, then the rest, each half in the order
 * the catalogue gave, cut to `count`. Never mutates `products`.
 */
export function selectPopularProducts(
  products: readonly Product[],
  count: number = DEFAULT_COUNT,
): readonly Product[] {
  const purchasable = products.filter((item) => item.purchasable);
  const displayOnly = products.filter((item) => !item.purchasable);

  return [...purchasable, ...displayOnly].slice(0, count);
}
