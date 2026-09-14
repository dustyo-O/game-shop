/**
 * Public API of the `apply-promo` feature — what the promo-code field on the
 * order page does.
 *
 * The order page hands it an order id and a way to re-read the order, and knows
 * nothing about the request, the in-flight state or the Russian wording of any
 * of it. `applyPromo` itself is the order entity's and is deliberately not
 * re-exported here: the page has no business calling it, and a page that could
 * would be a page one step away from wiring its own field.
 *
 * Named exports only — no `export *` — so this list is the honest inventory of
 * what the slice offers.
 */
export { createPromoForm } from "./ui/promo-form.js";
export type { PromoForm, PromoFormOptions } from "./ui/promo-form.js";
