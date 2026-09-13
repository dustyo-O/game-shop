/**
 * Public API of the `undelivered-order` entity — one paid order holding no key,
 * as the operator's recovery screen reads it.
 *
 * `readOrderReason` is intentionally absent, for the reason `orderStatusLabel`
 * is absent from the `order` slice: how a reason is worded and laid out is this
 * slice's business, and a page reaching for the facts would be a page one step
 * away from writing `?? "failed"` itself — the exact bug
 * `./lib/attempt-reason.ts` exists to make unwritable. The page gets the table,
 * which decides both.
 *
 * Named exports only — no `export *` — so this list is the honest inventory of
 * what the slice offers.
 */
export {
  AdminSurfaceDisabledError,
  AdminUnauthorizedError,
  fetchUndeliveredOrders,
  UndeliveredOrdersResponseError,
} from "./api/undelivered-orders-api.js";
export type {
  IssuanceAttemptRecord,
  UndeliveredOrder,
  UndeliveredOrdersReport,
} from "./model/undelivered-order.js";
export { renderUndeliveredOrdersTable } from "./ui/undelivered-orders-table.js";
