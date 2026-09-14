/**
 * A catalogue item as the storefront holds it.
 *
 * This is deliberately **not** an import of `apps/api`'s `CatalogProduct`. That
 * file says so itself: the catalogue row is the API's own response shape, not a
 * contract the shop shares with an outside party, and `packages/contracts` is
 * reserved for the wire formats the shop does not own. `apps/web` is not a
 * dependent of `apps/api` and must not become one — the two agree because they
 * name the same six fields, and the parser in `../api/products-api.ts` is where
 * that agreement is checked at run time rather than assumed.
 *
 * What *is* imported from `@game-shop/contracts` is the money type. The API
 * sends kopecks; `MinorUnits` is what stops a display helper from treating
 * `129000` as roubles.
 */
import type { Currency, MinorUnits } from "@game-shop/contracts";

export interface Product {
  /** The catalogue handle, e.g. `KEY-CS2-PRIME`. What `POST /api/orders` will take. */
  readonly sku: string;

  /** Russian display name, verbatim from the catalogue (functional spec §2.8). */
  readonly name: string;

  /**
   * **Kopecks.** `129000` is 1290 ₽. Named `priceMinor` where the wire calls it
   * `price_minor`: the snake_case belongs to the JSON, and it stops at the
   * parser.
   */
  readonly priceMinor: MinorUnits;

  readonly currency: Currency;

  /**
   * The picture's path exactly as the catalogue holds it — `assets/cs2.png`:
   * relative, no leading slash — or `null`, because the column is nullable and
   * a row without artwork is still listed. The parser keeps the wire value;
   * turning it into something an `<img>` can load (resolution against the
   * page's origin, so it works from `/order/…` as well as from `/`) is the
   * card's job in `../ui/product-card.ts`, not the parser's.
   */
  readonly image: string | null;

  /**
   * Whether this item offers the buy path — true for the three products of type
   * `key`, false for the other nine. The card renders its «Купить» control from
   * this and nothing else (functional spec §2.1).
   */
  readonly purchasable: boolean;
}
