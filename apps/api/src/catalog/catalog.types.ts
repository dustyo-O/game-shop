/**
 * The body of `GET /api/products` (technical-considerations §2.3).
 *
 * Lives in `apps/api` rather than in `packages/contracts` on purpose: that
 * package holds the contracts the shop does not own — the payment provider's
 * webhook body and the supplier's `/issue` pair, both fixed inputs — plus the
 * order lifecycle, which the database's CHECK constraint and the status page
 * must agree on letter for letter (§2.1). The catalogue row is none of those.
 * It is this application's own response shape, and when `apps/web` renders it
 * the two will be reading the same field names because this file names them,
 * not because a shared package forced them to.
 */
import type { Currency, MinorUnits } from "@game-shop/contracts";

/**
 * One catalogue item as the shop page sees it.
 *
 * Field names are snake_case because they are wire fields, matching §2.3
 * verbatim; the database row they come from is camelCase on the TypeScript
 * side. The mapping between the two happens in exactly one place,
 * `CatalogService.listProducts`.
 *
 * Note what is absent: `products.id` and `products.type`. The id is internal —
 * `sku` is the shop's public handle, and it is what `POST /api/orders` takes.
 * `type` decides `purchasable` at seed time (assumption A4) and the page has no
 * use for the category itself.
 */
export interface CatalogProduct {
  /** The catalogue handle, e.g. `KEY-CS2-PRIME`. `products.sku`, UNIQUE. */
  readonly sku: string;

  /** Russian display name, verbatim from the catalogue (functional spec §2.8). */
  readonly name: string;

  /**
   * **Kopecks, not roubles.** `129000` is 1 290 ₽, not 129 000 ₽.
   *
   * The API deliberately does not format money. `packages/contracts/src/money.ts`
   * exists because the same amount appears as `500` on the payment provider's
   * wire and as `50000` in Postgres, and every bug that boundary produces comes
   * from a number that had lost track of its scale. So the value crosses this
   * boundary in the scale it is stored in, under a name that says which scale
   * that is, carrying the {@link MinorUnits} brand for anyone compiling against
   * it. Turning it into «1 290 ₽» is the frontend's job — one place, at the
   * moment of display, where the currency is also in hand.
   */
  readonly price_minor: MinorUnits;

  /** ISO 4217. `RUB` for every row of the supplied catalogue. */
  readonly currency: Currency;

  /**
   * Image reference relative to the web app's asset root, e.g. `assets/cs2.png`.
   * `null` when the catalogue row has no image — the column is nullable so an
   * item without one is still listed rather than dropped.
   */
  readonly image: string | null;

  /**
   * Whether this item offers the buy path. True for the three products of type
   * `key`, false for the other nine (assumption A4). The page uses it to decide
   * whether to render the «Купить» control (functional spec §2.1).
   */
  readonly purchasable: boolean;
}
