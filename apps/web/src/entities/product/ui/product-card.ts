/**
 * One catalogue item on the shop page: name, price, and — only where the
 * catalogue allows buying — a «Купить» control (functional spec §2.1).
 *
 * This is Phase 1's plain version. Appearance is explicitly out of scope
 * (functional spec §3, "Plain, functional pages"), and Phase 4 replaces the
 * whole storefront with the one built from the design.
 */
import { createElement } from "../../../shared/lib/dom.js";
import { formatPrice } from "../../../shared/lib/format-price.js";
import type { Product } from "../model/product.js";

const buyLabel = "Купить";

/**
 * Render the card as an `<li>` — the page's list is a `<ul>`, so the twelve
 * items are a list to a screen reader as well as to the eye.
 *
 * `data-sku` is on the card because the sku is the item's identity everywhere
 * else in this system: it is what `POST /api/orders` takes in the next slice,
 * and it is what a browser check selects a specific row by without depending on
 * the item's position or its Russian name.
 *
 * There is no `<img>`. See the note on `toProduct` in `../api/products-api.ts`:
 * the catalogue's image paths point at files this repository does not contain,
 * and a broken `<img>` per row would be twelve console errors and twelve 404s
 * in exchange for nothing this page needs.
 */
export function renderProductCard(product: Product): HTMLLIElement {
  const card = createElement(
    "li",
    { className: "product-card", attributes: { "data-sku": product.sku } },
    [
      createElement("h2", { className: "product-card__name", text: product.name }),
      createElement("p", {
        className: "product-card__price",
        text: formatPrice(product.priceMinor, product.currency),
      }),
    ],
  );

  if (product.purchasable) {
    // The control is rendered here and its *behaviour* lives in
    // `features/buy-product`, which listens for clicks on `[data-sku]` from the
    // page's content region. An entity may not import a sibling entity, so a
    // handler here would be a card calling `entities/order` — the one import
    // the layer rules rule out. The card says what the item is; the feature
    // says what pressing it does.
    card.append(
      createElement("button", {
        className: "product-card__buy",
        text: buyLabel,
        attributes: { type: "button", "data-sku": product.sku },
      }),
    );
  }

  return card;
}
