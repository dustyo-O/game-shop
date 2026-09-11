/**
 * The wire shapes of `PUT /internal/suppliers/:provider/behaviour`.
 *
 * Not in `packages/contracts`, and that is the same call
 * `admin/payment-event-sweep.types.ts` and `payments/payment-webhook.types.ts`
 * make. The contracts package holds the shapes **two sides have to agree on
 * letter for letter** — the payment webhook payload, the supplier `/issue`
 * contract, the lifecycle enum — because `apps/web`, `apps/api` and the race
 * scripts all serialise or parse them. This one is the reviewer's console: a
 * single producer, and consumers that are a human with `curl` and a race script
 * reading a couple of numbers back. Publishing it into a package that
 * `apps/web` bundles into a browser would also ship the supplier's failure
 * vocabulary to every shopper, which is the boundary this whole directory
 * exists to keep.
 *
 * snake_case, matching every other body this API sends or accepts
 * (`SupplierIssueRequest`, `PaymentWebhookAck`, `PaymentEventSweepReport`).
 */

/**
 * The request body — **a replacement, not a patch.**
 *
 * ###########################################################################
 * # EVERY FIELD IS OPTIONAL AND EVERY OMITTED FIELD IS RESET TO ITS BASELINE
 * # — ZERO FOR THE FIVE NUMBERS, `false` FOR `hang_before_claim`.
 * ###########################################################################
 *
 * `PUT` means *make the resource look like this* (RFC 9110 §9.3.4), and taking
 * it at its word buys the property functional spec §2.7's fifth criterion
 * needs. A reviewer's second run is identical to their first because the body
 * they send fully determines the supplier's behaviour — not the body plus
 * whatever a previous experiment left in the row, which is history nobody can
 * see. `{}` is therefore the reset button: it restores exactly the seeded
 * baseline (`packages/db/src/fixtures/supplier-behaviour.ts`, the same constant
 * the seed uses, so the two cannot drift).
 *
 * The cost is that arming a one-shot means restating anything else you want
 * kept — `{"hang_next": 1}` alone leaves `hang_ms` at `0`, i.e. a hang of no
 * length. That is visible immediately, because the response is the row as
 * stored; the alternative, a merge, is invisible by construction.
 *
 * **Unknown fields are refused.** `{"failure_rated": 1}` accepted-and-ignored
 * would hand the reviewer a shop that behaves differently from the one they
 * think they asked for, which is the same dishonesty as clamping an
 * out-of-range rate. This is stricter than `parsePaymentWebhookPayload`, for
 * the reason `parseSupplierIssueRequest` gives about its own strictness: no
 * money has moved, the sender is not a third party reporting a real-world
 * event, and there is no evidence to preserve.
 */
export interface SupplierBehaviourRequest {
  /** Probability in `[0, 1]` that a call is refused. Out of range is **refused, never clamped**. */
  readonly failure_rate?: number;
  /** Probability in `[0, 1]` that a call is kept waiting. Out of range is **refused, never clamped**. */
  readonly hang_rate?: number;
  /** How long a hang lasts, in whole milliseconds. */
  readonly hang_ms?: number;
  /** Arm N one-shot refusals — the next N calls refuse, then it stops. */
  readonly fail_next?: number;
  /** Arm N one-shot hangs — the next N calls wait `hang_ms`, then it stops. */
  readonly hang_next?: number;
  /**
   * **Where the hang sits relative to the key claim.** Omitted — the baseline —
   * is `false`, which is **after the claim commits**.
   *
   * The only field here that selects a *scenario* rather than an amount, and
   * the two it selects between are not interchangeable
   * (`apps/api/src/suppliers/supplier-hang.ts`):
   *
   *   omitted / `false`  the timeout trap. The supplier claims a key, commits
   *                      it to its ledger, and *then* waits. Pair with
   *                      `hang_ms` greater than `SUPPLIER_TIMEOUT_MS` and the
   *                      shop times out on an answer that already exists —
   *                      which is why a timeout is `unknown` and never
   *                      `failed`, and what a re-probe on the same
   *                      `request_id` is there to find.
   *   `true`             "a slow supplier is not a failed one". The wait
   *                      happens before anything is claimed. Pair with
   *                      `hang_ms` *below* `SUPPLIER_TIMEOUT_MS` and the call
   *                      completes normally.
   *
   * A boolean rather than a `hang_at` string: there are exactly two places a
   * hang can go, because the claim and the ledger write are one transaction.
   * The schema column says the rest (`packages/db/src/schema/supplier.ts`).
   */
  readonly hang_before_claim?: boolean;
}

/**
 * The response: **the row as the database holds it**, not an echo of the
 * request.
 *
 * That distinction is the endpoint's only feedback channel and it is doing real
 * work. `failure_rate` is `numeric(4, 3)`, so `0.12345` is stored as `0.123`;
 * answering with the request would hide the rounding, answering with the row
 * shows it. The same read-back is what tells a reviewer that `{"hang_next": 1}`
 * left `hang_ms` at zero.
 */
export interface SupplierBehaviourResponse {
  /** `a` | `b` — echoed from the path, as the stored row spells it. */
  readonly provider: string;
  readonly failure_rate: number;
  readonly hang_rate: number;
  readonly hang_ms: number;
  readonly fail_next: number;
  readonly hang_next: number;
  /** `false` — the baseline — means an injected hang waits **after** the key claim commits. */
  readonly hang_before_claim: boolean;
  /** ISO 8601, stamped by the **database's** clock rather than by any instance's. */
  readonly updated_at: string;
}
