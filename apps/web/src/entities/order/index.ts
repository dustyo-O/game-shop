/**
 * Public API of the `order` entity. Code outside this slice imports from here
 * and never from `./ui/…`, `./api/…`, `./lib/…` or `./model/…` directly, so the
 * internals stay free to move.
 *
 * `orderStatusLabel` is intentionally absent, for the reason `formatPrice` was
 * absent from the product slice: how a status is worded is this slice's
 * business, and a page reaching for the label would be a page one step away
 * from writing its own. `orderRecoveryExplanation` is absent for the same
 * reason and more strongly: the page gets `renderOrderRecoveryNotice`, which
 * decides *whether* a shopper is owed an explanation as well as what it says, so
 * there is no way for a caller to render the sentence without its live region or
 * its `data-order-recovery` handle.
 *
 * Named exports only — no `export *` — so this list is the honest inventory of
 * what the slice offers.
 */
export {
  createOrder,
  fetchOrder,
  OrderNotFoundError,
  OrderResponseError,
  ProductNotPurchasableError,
} from "./api/order-api.js";
export type { Order } from "./model/order.js";
export { renderOrderDetails } from "./ui/order-details.js";
export { renderOrderRecoveryNotice } from "./ui/order-recovery-notice.js";
