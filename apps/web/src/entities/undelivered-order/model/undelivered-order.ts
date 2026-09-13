/**
 * One paid order that is still holding no key — the frontend's half of
 * `GET /api/admin/orders/undelivered` (spec 003 technical-considerations §8).
 *
 * Mirrored rather than imported, for the reason `entities/order/model` gives:
 * `apps/web` is not a dependent of `apps/api` and must not become one. The two
 * agree because they name the same fields, and `../api/undelivered-orders-api.ts`
 * is where that agreement is checked at run time instead of assumed.
 *
 * ---------------------------------------------------------------------------
 * WHY THE TYPE IS CALLED `UndeliveredOrder` AND NOT `StuckOrder`
 * ---------------------------------------------------------------------------
 * The list is **every order paid and holding no key** — `paid`, `delivering`,
 * `out_of_stock`, `delivery_failed` (technical-considerations §4, assumption
 * A5) — so two of the four statuses on this screen belong to orders that are
 * merely in flight and will very likely deliver themselves in the next 50
 * milliseconds. Naming the type `StuckOrder` would make every reader of this
 * file believe the opposite, and the first "obvious cleanup" it invites is
 * narrowing the query to the retryable pair — which hides the one class of
 * stuck order that is otherwise invisible: an order whose worker died between
 * the claim and the outcome write.
 *
 * *Paid but undelivered* is the question the query asks. *Retryable* is a
 * narrower question, and it is asked separately, per row, in the UI — and
 * answered for real by a guarded `UPDATE` on the API, not by this page.
 */
import type { Currency, MinorUnits, OrderStatus } from "@game-shop/contracts";

/**
 * One row of `issuance_attempts` as the operator's report carries it: one ask
 * of one supplier for one order.
 *
 * `status` is a plain `string` rather than a union, and that is deliberate
 * rather than lazy. The column has **no CHECK constraint** — `packages/db`'s
 * schema says so in as many words, because the value set belongs to the retry
 * policy and should not need a Phase 1 constraint altered to extend it. Today
 * it is `unknown | ok | failed`; a narrower type here would mean a page that
 * refuses to render the first time the ladder learns a fourth word, on the one
 * screen a person opens when something has already gone wrong.
 *
 * What the page does with it is a separate matter, and the important half:
 * see `../lib/attempt-reason.ts`. An unrecognised value is shown, never
 * translated into one of the three.
 */
export interface IssuanceAttemptRecord {
  /** Which supplier was asked — `a` or `b` today. */
  readonly provider: string;

  /**
   * Which attempt this is **for this order**, counting from 1 across every
   * provider. The total order the report is sorted by; see
   * `issuance_attempts_order_id_attempt_key`.
   */
  readonly attempt: number;

  /** `unknown`, `ok` or `failed` today — and see the note above about tomorrow. */
  readonly status: string;

  /**
   * How many times this one request id has been **sent**, the first ask
   * included. A re-probe after silence does not make a second attempt row, so
   * `2` here is the shop having asked the same supplier the same question
   * twice under the same id — which is exactly what §2.2 asks it to do.
   *
   * Nullable because the report is allowed not to carry it; the cell then says
   * nothing rather than inventing a count.
   */
  readonly probeCount: number | null;

  /** The supplier's reason on a definite failure; `null` on `ok` and on `unknown`. */
  readonly lastError: string | null;
}

/** One order on the operator's screen. */
export interface UndeliveredOrder {
  /** `ord_` + ULID. The id an operator pastes into a retry, a log search or `psql`. */
  readonly orderId: string;

  readonly sku: string;

  /**
   * The catalogue name. **Nullable** for the reason `Order.productName` is: the
   * join is a LEFT JOIN, because an order is a historical record that outlives
   * its catalogue row. The row falls back to the SKU.
   */
  readonly productName: string | null;

  /** **Kopecks.** `129000` is «1290 ₽». */
  readonly amountMinor: MinorUnits;

  readonly currency: Currency;

  /** `paid`, `delivering`, `out_of_stock` or `delivery_failed` — see the header. */
  readonly status: OrderStatus;

  /** ISO 8601, as the wire sent it. */
  readonly createdAt: string;

  /**
   * When the shop first recorded a `paid` event for this order, ISO 8601 — the
   * "when was it paid for" half of §2.4's fourth criterion.
   *
   * **Nullable, and the null is worth reading**: it means the order is `paid`
   * or beyond with no `paid` event on file. Such an order is listed rather than
   * hidden (technical-considerations §4), so the page has to say *no paid event
   * on file* rather than leave the cell blank.
   */
  readonly paidAt: string | null;

  /**
   * The API's own answer to "may this order be retried?".
   *
   * **Not what the retry affordance is drawn from.** That is
   * `isRecoverableOrderStatus` from `@game-shop/contracts` — the definition both
   * ends of the wire already read, rather than a second opinion travelling as
   * data. It is parsed and kept because it is part of the documented body and a
   * field silently dropped by a parser is a field nobody notices changing; and
   * because the only authority on whether a retry runs is neither of these two
   * but the guarded `UPDATE` the API performs.
   */
  readonly retryable: boolean;

  /**
   * The newest attempt whose status is still `unknown`, or `null`.
   *
   * **This is the field that makes "never established" readable without opening
   * `psql`** (technical-considerations §8) — a supplier was asked, the shop
   * never learned the answer, and a key may or may not exist under this id. It
   * is what §2.4's fourth criterion means by *"what went wrong"* when nothing
   * definite ever went wrong.
   */
  readonly outstandingRequestId: string | null;

  /**
   * The definite reason from the newest attempt, verbatim — `null` on `ok` and
   * on `unknown`.
   *
   * **`null` here does not mean "failed" and must never be rendered as if it
   * did.** See `../lib/attempt-reason.ts`, which exists for that one sentence.
   */
  readonly lastError: string | null;

  /** The attempt history the report chose to carry. May be empty: nothing has asked a supplier yet. */
  readonly attempts: readonly IssuanceAttemptRecord[];
}

/** The whole report — the list plus the three facts about the list itself. */
export interface UndeliveredOrdersReport {
  /** How many orders are in {@link UndeliveredOrdersReport.orders}. */
  readonly count: number;

  /**
   * The report hit its 200-row ceiling (assumption A7) and there are more.
   * Shown in words, because an operator who does not know the list is cut off
   * will believe they have seen everything.
   */
  readonly truncated: boolean;

  /**
   * The API's own sentence about this report — what §2.4's fifth criterion is
   * satisfied with when the list is empty. The page prefers it to its own
   * wording and falls back when it is absent or blank.
   */
  readonly message: string;

  readonly orders: readonly UndeliveredOrder[];
}
