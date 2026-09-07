/**
 * Public API of the `simulate-payment` feature — what «Оплатить успешно» and
 * «Оплата не прошла» do, and what is shown once the answer is in.
 *
 * The order page hands it an order id and a way to re-read the order, and knows
 * nothing about the request, the in-flight state or the Russian wording of any
 * of it. `simulatePayment`, `PaymentOutcome` and `PaymentNotDeliveredError` are
 * deliberately absent: the endpoint is this slice's business, and a page reaching
 * for it would be a page one step away from wiring its own pay button.
 *
 * Named exports only — no `export *` — so this list is the honest inventory of
 * what the slice offers.
 */
export { createPaymentControls } from "./ui/payment-controls.js";
export type { PaymentControls, PaymentControlsOptions } from "./ui/payment-controls.js";
