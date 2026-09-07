/**
 * Public API of the `order` entity. Code outside this slice imports from here
 * and never from `./ui/…`, `./api/…`, `./lib/…` or `./model/…` directly, so the
 * internals stay free to move.
 *
 * `orderStatusLabel` is intentionally absent, for the reason `formatPrice` was
 * absent from the product slice: how a status is worded is this slice's
 * business, and a page reaching for the label would be a page one step away
 * from writing its own.
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
