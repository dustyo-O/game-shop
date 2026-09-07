/**
 * Public API of the `buy-product` feature — what «Купить» does.
 *
 * One export, and the internals stay internal: the pages that offer a Buy
 * control hand it a container and know nothing about the request, the in-flight
 * state or the Russian wording of a failure.
 *
 * Named exports only — no `export *` — so this list is the honest inventory of
 * what the slice offers.
 */
export { enableBuyControls } from "./ui/buy-controls.js";
