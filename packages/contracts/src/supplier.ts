/**
 * The supplier's key-issuance endpoint — `POST /issue`.
 *
 * **This shape is a fixed input**, transcribed from the assignment; the
 * snake_case field names are the supplier's and may not be renamed
 * (technical-considerations §2.3, §3).
 *
 * The supplier is reached over real HTTP even in local development
 * (`SUPPLIER_A_URL`), and its key pool is *supplier-side* inventory living in
 * tables the shop does not read (architecture §6). That separation is a
 * correctness device, not tidiness: it forces the shop to earn its guarantees
 * across a boundary it distrusts instead of quietly sharing state with the thing
 * it is meant to be defending against.
 *
 * Which is also why nothing here is `Promise`-shaped or client-shaped: these are
 * wire types, and a response object typed as {@link SupplierIssueResponse} is
 * what parsing produced, never a claim that it was verified.
 */

/**
 * The request body, verbatim from the assignment:
 *
 *     { "request_id": "req_00123-1", "sku": "STEAM-TOPUP-500", "order_id": "ord_00123" }
 */
export interface SupplierIssueRequest {
  /**
   * The idempotency key for this supplier call — **the single most important
   * field in the system.**
   *
   * Derived deterministically as `req_{order_id}_{provider}_{attempt}`
   * (technical-considerations §2.2), so a retry *recomputes* the same id rather
   * than depending on a caller to have remembered it. The supplier keys its own
   * ledger on it (invariant I5):
   *
   *   SELECT code FROM supplier_requests WHERE request_id = $1;
   *   -- found => return that code unchanged, however many times we are asked
   *
   * That is what makes retry-after-timeout safe. Architecture §4 spells out the
   * policy this field carries:
   *
   *   - **Definite failure** (a `4xx`/`5xx` with a {@link SupplierIssueErrorResponse}
   *     body) → the attempt is `failed`; fall through to the backup supplier with
   *     a **new** `request_id`.
   *   - **Timeout** → the attempt is `unknown`, *never* `failed`. Retry **the
   *     same supplier** with **the same `request_id`**, which returns the
   *     original code if one was already issued.
   *   - **The hard rule:** never fall through to the backup while any attempt is
   *     still `unknown`. A timeout means we do not know whether a key was issued,
   *     and issuing a second one on a guess is how the same order gets charged
   *     for two keys.
   */
  readonly request_id: string;

  /** The catalogue SKU being issued, e.g. `STEAM-TOPUP-500`. */
  readonly sku: string;

  /** The order the key is for, as `orders.id`. Correlation and logging only. */
  readonly order_id: string;
}

/** The discriminant on {@link SupplierIssueResponse}. */
export const SupplierIssueStatus = {
  Ok: "ok",
  Error: "error",
} as const;

export type SupplierIssueStatus = (typeof SupplierIssueStatus)[keyof typeof SupplierIssueStatus];

/**
 * Why a supplier refused, on a **definite** failure.
 *
 * "Definite" is the load-bearing word. A body from this set means the supplier
 * answered and said no — it is safe to conclude that no key was issued and to
 * move on to the fallback. A *timeout* produces no body at all and is a
 * different thing entirely; see {@link SupplierIssueRequest.request_id}.
 *
 * `out_of_stock` is the only reason Phase 1 defines. Phase 3's failure injection
 * adds members here — one line, in one place, which is what this package is for.
 */
export const SupplierIssueErrorReason = {
  /**
   * The supplier's key pool is empty. Its claim query returned nothing:
   *
   *   UPDATE supplier_keys
   *   SET claimed_by_request_id = $1, claimed_at = now()
   *   WHERE code = (
   *     SELECT code FROM supplier_keys
   *     WHERE claimed_by_request_id IS NULL
   *     ORDER BY id
   *     FOR UPDATE SKIP LOCKED
   *     LIMIT 1
   *   )
   *   RETURNING code;
   *   -- 0 rows => pool exhausted => out_of_stock
   *
   * The shop's answer is the `out_of_stock` order status, which the status page
   * renders as an ordinary outcome rather than an error.
   */
  OutOfStock: "out_of_stock",
} as const;

export type SupplierIssueErrorReason =
  (typeof SupplierIssueErrorReason)[keyof typeof SupplierIssueErrorReason];

/**
 * `200` — a key was issued, or this `request_id` had already issued one.
 *
 *     { "status": "ok", "request_id": "req_00123-1", "code": "LFXC-TNCS-BPCD" }
 *
 * Both cases are indistinguishable by design: the supplier's ledger returns the
 * stored code for a repeated `request_id` (I5), so a retry after a timeout is
 * answered with the *same* code rather than a second one.
 */
export interface SupplierIssueOkResponse {
  readonly status: typeof SupplierIssueStatus.Ok;
  /** Echoes the request's `request_id`, so a response can be matched to its call. */
  readonly request_id: string;
  /** The issued key, e.g. `LFXC-TNCS-BPCD`. */
  readonly code: string;
}

/**
 * `4xx`/`5xx` — a definite refusal.
 *
 *     { "status": "error", "reason": "out_of_stock" }
 *
 * Note there is no `request_id` in the assignment's error body. Callers must
 * correlate by the id they sent, not by one they hoped to read back.
 */
export interface SupplierIssueErrorResponse {
  readonly status: typeof SupplierIssueStatus.Error;
  readonly reason: SupplierIssueErrorReason;
}

/**
 * The two possible bodies, discriminated on `status`.
 *
 * A discriminated union rather than one interface with optional `code` and
 * `reason`: `{ status: "ok" }` with no `code` must not typecheck, since the
 * whole point of calling the supplier is the code.
 *
 * **A third outcome exists and is deliberately not in this union: the timeout.**
 * A timeout produces no response body, so it cannot be a member here — it is the
 * *absence* of one of these. Modelling it as a variant would be the exact
 * mistake the retry policy exists to prevent, because it would let a timeout be
 * handled by the same branch as a definite failure.
 */
export type SupplierIssueResponse = SupplierIssueOkResponse | SupplierIssueErrorResponse;
