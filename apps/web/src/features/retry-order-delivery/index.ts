/**
 * Public API of the `retry-order-delivery` feature — what the operator's Retry
 * button does, and what each press is reported as.
 *
 * The page hands it a way to read the admin token and a way to re-read the
 * list, then composes two things: the notices node and a `mount` call over the
 * table the entity rendered. Everything else — the endpoint, the per-row busy
 * set, the `409`/`still_out_of_stock` distinction, the wording of an unanswered
 * retry — is this slice's business. `retryOrderDelivery` and the error classes
 * are deliberately absent: a page reaching for them would be a page one step
 * away from wiring its own retry button.
 *
 * Named exports only — no `export *` — so this list is the honest inventory of
 * what the slice offers.
 */
export { createRetryControls } from "./ui/retry-controls.js";
export type { RetryControls, RetryControlsOptions } from "./ui/retry-controls.js";
