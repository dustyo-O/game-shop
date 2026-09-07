/**
 * Public API of the `product` entity. Code outside this slice imports from
 * here and never from `./ui/…`, `./api/…` or `./model/…` directly, so the
 * internals stay free to move.
 *
 * `formatPrice` is intentionally absent, as it always was — but it no longer
 * lives here at all. The order page needs the same helper, and an entity may
 * not import from a sibling entity, so it moved down to
 * `shared/lib/format-price.ts` (which explains the move at length). Nothing
 * above this layer should be assembling money strings of its own either way.
 *
 * Named exports only — no `export *` — so this list is the honest inventory of
 * what the slice offers.
 */
export { fetchProducts, CatalogResponseError } from "./api/products-api.js";
export type { Product } from "./model/product.js";
export { renderProductCard } from "./ui/product-card.js";
