/**
 * The body `GET /api/admin/orders/undelivered` answers with — every order that
 * was paid for and is holding no key (spec 003 functional spec §2.4,
 * technical-considerations §8).
 *
 * Not in `packages/contracts`, and that is the same call
 * `./payment-event-sweep.types.ts` makes about the sweep's report. The contracts
 * package holds the wire shapes **two sides have to agree on letter for letter**
 * — the payment webhook payload, the supplier `/issue` contract, the lifecycle
 * enum. This one has a single producer, and its consumer mirrors it rather than
 * importing it, for the reason `apps/web/src/entities/undelivered-order/model`
 * states in as many words: *`apps/web` is not a dependent of `apps/api` and must
 * not become one.*
 *
 * ###########################################################################
 * # THE WIRE SHAPE IS FIXED BY A CONSUMER THAT ALREADY EXISTS. THIS FILE
 * # FOLLOWS IT; IT DOES NOT PROPOSE IT.
 * ###########################################################################
 *
 * The operator's view was built before this endpoint and parses strictly, field
 * by field, throwing `UndeliveredOrdersResponseError` naming the exact path of
 * anything it does not recognise
 * (`apps/web/src/entities/undelivered-order/api/undelivered-orders-api.ts`).
 * §8's blockquote pins the two things it had to choose for itself:
 *
 *   - the top-level array is **`orders`**, beside `count`, `truncated` and
 *     `message`;
 *   - each attempt carries **`provider`**, **`attempt`**, **`status`**,
 *     **`probe_count`** and **`last_error`**.
 *
 * So every name below is checked against that parser rather than against taste,
 * and `snake_case` throughout matches every other body this API sends
 * (`PaymentWebhookAck`, `SupplierIssueOkResponse`, `PaymentEventSweepReport`).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE, AND CANNOT BE ADDED BY ACCIDENT
 * ---------------------------------------------------------------------------
 * **There is no field for a key.** Not `code`, not `delivery`, not under any
 * other name. The report carries no delivered key, ever — the operator has no
 * business reading a shopper's key — and that rule is kept in two independent
 * places, which is the arrangement this project uses wherever a leak would
 * matter:
 *
 *   1. the statement never selects one, so no key is sent from Postgres to this
 *      process at all (`./undelivered-orders.service.ts`, and the `CASE` in
 *      `OrderViewService.findOrder` that establishes the pattern); and
 *   2. these types have nowhere to put one, so a statement that one day forgot
 *      still could not publish it.
 */

/**
 * One row of `issuance_attempts` as the report carries it: one ask of one
 * supplier for one order.
 */
export interface UndeliveredOrderAttempt {
  /** Which supplier was asked — `a` or `b` today. */
  readonly provider: string;

  /**
   * Which attempt this is **for this order**, counting from 1 across every
   * provider. A total order with no ties, by
   * `issuance_attempts_order_id_attempt_key`.
   */
  readonly attempt: number;

  /**
   * `unknown`, `ok` or `failed` today — **and typed as a plain `string`, not as
   * a union, deliberately.**
   *
   * `issuance_attempts.status` is `text` with no CHECK constraint
   * (`packages/db/src/schema/shop.ts`), because the value set belongs to the
   * retry policy and should not need a Phase 1 constraint altered to extend it.
   * A fourth word is therefore a change the policy is allowed to make, and it
   * must reach the screen **as itself**: narrowing here would either coerce it
   * into one of the three the shop recognises, or take down the operator's only
   * screen at exactly the moment the policy got more interesting.
   *
   * The consumer makes the same choice for the same reason, and says so.
   */
  readonly status: string;

  /**
   * How many times this one `request_id` has been **sent**, the first ask
   * included. `2` means the shop asked the same supplier the same question
   * twice under the same id — a re-probe after silence, which is what spec 003
   * §2.2 asks it to do, and which deliberately does not create a second attempt
   * row.
   */
  readonly probe_count: number;

  /**
   * The supplier's reason on a **definite** failure; `null` on `ok` and on
   * `unknown`.
   *
   * **`null` here does not mean "failed"** and must never be rendered as if it
   * did — an attempt still reading `unknown` has no reason because nothing
   * definite ever went wrong. {@link UndeliveredOrder.outstanding_request_id} is
   * what says so instead.
   */
  readonly last_error: string | null;
}

/** One order on the operator's screen. */
export interface UndeliveredOrder {
  /** `ord_` + ULID. The id an operator pastes into a retry, a log search or `psql`. */
  readonly order_id: string;

  readonly sku: string;

  /**
   * The catalogue name, or `null` when the catalogue row is gone. The join is a
   * LEFT JOIN because an order is a historical record that outlives its
   * catalogue row (`orders.sku` is deliberately not a foreign key); the screen
   * falls back to the SKU.
   */
  readonly product_name: string | null;

  /** **Kopecks.** `129000` is «1290 ₽». Integer minor units, never a float. */
  readonly amount_minor: number;

  /** `RUB` today. */
  readonly currency: string;

  /** `paid`, `delivering`, `out_of_stock` or `delivery_failed` — see the service. */
  readonly status: string;

  /** ISO 8601. */
  readonly created_at: string;

  /**
   * When the shop first recorded a `paid` event for this order, ISO 8601 —
   * `min(payment_events.received_at) WHERE status = 'paid'`.
   *
   * **`null` is worth reading rather than hiding:** it means the order is `paid`
   * or beyond with no `paid` event on file, which is precisely the sort of thing
   * an operator must be shown. Such an order is listed, never filtered out
   * (technical-considerations §4).
   */
  readonly paid_at: string | null;

  /**
   * The API's own answer to "may this order be retried?" —
   * `isRecoverableOrderStatus(status)`, i.e. `out_of_stock` or
   * `delivery_failed`.
   *
   * **Advisory, and neither end treats it as the authority.** The page draws its
   * retry affordance from `isRecoverableOrderStatus` in `@game-shop/contracts`,
   * the definition both ends already read; and whether a retry actually runs is
   * decided by slice 5's status-guarded `UPDATE` matching zero rows or one. This
   * field is here because it is part of the documented body and because a wider
   * list than "stuck" needs to say, per row, which rows are the narrower thing.
   */
  readonly retryable: boolean;

  /**
   * The newest attempt whose status is still `unknown`, or `null`.
   *
   * **The field that makes "never established" readable without opening
   * `psql`** (technical-considerations §8). A supplier was asked, the shop never
   * learned the answer, and a key may or may not exist under this id — the only
   * thing that can still find out is this id, asked again. It is what §2.4's
   * fourth criterion means by *"what went wrong"* when nothing definite ever
   * went wrong.
   */
  readonly outstanding_request_id: string | null;

  /**
   * The definite reason from the newest attempt, verbatim — `null` on `ok` and
   * on `unknown`. See {@link UndeliveredOrderAttempt.last_error}.
   */
  readonly last_error: string | null;

  /**
   * The attempt history the report carries. **May be empty**, and an empty list
   * is the most alarming row on the screen rather than a missing one: this order
   * was paid for and was never offered to a supplier at all.
   */
  readonly attempts: readonly UndeliveredOrderAttempt[];
}

/** The whole report — the list, plus the three facts about the list itself. */
export interface UndeliveredOrdersReport {
  /** How many orders are in {@link UndeliveredOrdersReport.orders}. */
  readonly count: number;

  /**
   * **There are more orders than are shown.** The report is bounded
   * (assumption A7 — a shop with more than 200 stuck orders has a different
   * problem), and an operator who does not know the list is cut off will believe
   * they have seen everything.
   *
   * Exact, not pessimistic: see the `+ 1` in `./undelivered-orders.service.ts`.
   */
  readonly truncated: boolean;

  /**
   * The API's own sentence about this report, in words.
   *
   * This is what §2.4's fifth criterion is satisfied with when the list is
   * empty — *"there is nothing to recover"* has to be **said**, because a blank
   * screen and a broken screen look identical to the person who opened it during
   * an incident. Never empty; the page prefers it to its own wording and only
   * falls back if it is blank.
   */
  readonly message: string;

  readonly orders: readonly UndeliveredOrder[];
}
