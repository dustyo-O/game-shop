/**
 * The shapes of `POST /api/orders/:orderId/promo` — the request, the
 * transaction's verdicts, and the refusal body (spec 005,
 * technical-considerations §2.3; risk R9).
 *
 * Here rather than in `packages/contracts` for the reason `../orders/orders.types.ts`
 * gives: that package holds the contracts the shop does **not** own. This
 * request, these outcomes and this refusal body are the shop's own.
 *
 * The success body is not defined here at all. It is the bare {@link OrderView}
 * that `GET /api/orders/:id` already sends — one shape for "here is your order",
 * whichever endpoint said it — and the web's parser for it already exists.
 *
 * ---------------------------------------------------------------------------
 * `{ reason }`, NOT `{ error }` — R9
 * ---------------------------------------------------------------------------
 * Nest's default error envelope is `{ statusCode, message, error }`, and its
 * `error` field holds the status *phrase* — `"Conflict"`, `"Not Found"`. A
 * refusal that put its machine-readable reason in a field of the same name
 * would give a client one key that sometimes holds a phrase and sometimes a
 * code, and the client would parse it wrong on exactly the response it needed
 * to branch on. So the field is `reason`, and the body is `{ reason }` alone:
 * the precedent is `../suppliers/supplier-issue-refusal.ts`, where the status
 * and the body are built **once** from the reason so the two cannot disagree.
 */
import { HttpStatus } from "@nestjs/common";

import type { OrderStatus } from "@game-shop/contracts";

/**
 * The request body: **a code, and nothing else.**
 *
 * This interface is spec 005's half of the rule `CreateOrderRequest` states for
 * order creation — *never trust a client-supplied amount*. There is no
 * `discount`, no `amount`, no `percent` field to send. A code is a string that
 * selects a `promo_codes` row, and every number that follows is computed from
 * that row and from `orders.amount_minor` inside the transaction
 * (`./promo-discount.ts`, "nothing the page sends is a number").
 *
 * `code` is carried **as the shopper typed it**. `PromoRedemptionService.apply`
 * owns the normalisation (`./promo-code.ts`: trim, then upper-case), so the
 * value the SQL parameter, the already-applied comparison and the log line see
 * is produced in one place. The controller's parser calls the same function
 * once, for one purpose only: a code that is empty after trimming is a `400`
 * and never reaches the transaction.
 *
 * Extra fields are ignored, not rejected — `OrdersController`'s stance, for the
 * same reason: a `{ "code": "LIMIT3", "discount_minor": 100000 }` applies
 * `LIMIT3` at the server's price, and a rejection would suggest the extra
 * field was meaningful enough to argue with.
 */
export interface ApplyPromoRequest {
  readonly code: string;
}

/**
 * Every answer the redemption transaction can give, before any of them is an
 * HTTP status. The mapping onto `200` / `404` / `409` / `422` lives in the
 * controller, so the service stays callable from a race script or a test with
 * no HTTP opinions attached — `OrderRetryResultOutcome`'s arrangement.
 *
 * The order of members here is the order of the statements that produce them
 * (technical-considerations §2.2). That is not decoration: each outcome is
 * decided by one statement, every refusal is decided **before** either write,
 * and an expected refusal commits an empty transaction. There is no member for
 * "the invariant broke under the lock" because that is not an outcome — it is
 * a thrown {@link Error}, a `ROLLBACK`, and a `500`.
 */
export const PromoRedemptionOutcome = {
  /**
   * **This call applied the code.** The counter went up by one (I7), the
   * ledger row went in (I8), `orders.amount_minor` is now the amount to pay.
   * `200` with the view read after `COMMIT`.
   */
  Applied: "applied",

  /**
   * **This code was already on this order.** Statement 3 found the redemption
   * row and its code equals the normalised input. Nothing was written — not
   * the counter, not the ledger — and the `200` body is identical to the
   * first call's. A double-click, a retry after a lost response, a reload
   * that resubmits: all of them land here and none of them costs a use.
   */
  AlreadyApplied: "already_applied",

  /** No order with that id. Statement 1 locked nothing. `404`. */
  OrderNotFound: "order_not_found",

  /**
   * The order exists and is not `created` — it is being paid, has been paid,
   * or has settled. A promo changes the price *before* payment and never
   * after; the in-memory check under the lock is what decides this, and the
   * status guard inside `applyDiscount` is the second stop that would catch a
   * caller who skipped the lock. `409`.
   */
  NotAwaitingPayment: "not_awaiting_payment",

  /**
   * Not one of the codes on file — or an `amount` code in a currency that is
   * not the order's, refused the same way so the arithmetic can never subtract
   * dollars from roubles. `422`, decided before anything is written.
   */
  UnknownCode: "unknown_code",

  /**
   * A **different** code is already on this order. One code per order is I8's
   * strengthened key, and the shop does not stack discounts. Decided at
   * statement 3, so the hot `promo_codes` row is never touched. `409`.
   */
  AnotherCodeApplied: "another_code_applied",

  /**
   * **Zero rows from I7.** `UPDATE … WHERE used_count < max_uses` matched
   * nothing because the counter is at its limit — evaluated by Postgres
   * against the row as the previous transaction committed it, which is the
   * whole mechanism. Nothing was written; the transaction commits empty.
   * `409`.
   */
  Exhausted: "exhausted",
} as const;

export type PromoRedemptionOutcome =
  (typeof PromoRedemptionOutcome)[keyof typeof PromoRedemptionOutcome];

/**
 * A discriminated union on `outcome`. Every member carries the `orderId` and
 * the **normalised** `code` — the two fields every log line in this path must
 * name (§2.3, "Logging") — and the members that reached a `promo_codes` row
 * carry its `promoId` as well.
 */
export type PromoRedemptionResult =
  | {
      readonly outcome: typeof PromoRedemptionOutcome.Applied;
      readonly orderId: string;
      readonly code: string;
      readonly promoId: number;
      /** `RETURNING used_count` from the I7 statement — the use this call took, for the log line. */
      readonly usedCount: number;
      /** The limit, from the definition read at step 4, so the log can say `1 of 3`. */
      readonly maxUses: number;
    }
  | {
      readonly outcome: typeof PromoRedemptionOutcome.AlreadyApplied;
      readonly orderId: string;
      readonly code: string;
      readonly promoId: number;
    }
  | {
      readonly outcome: typeof PromoRedemptionOutcome.OrderNotFound;
      readonly orderId: string;
      readonly code: string;
    }
  | {
      readonly outcome: typeof PromoRedemptionOutcome.NotAwaitingPayment;
      readonly orderId: string;
      readonly code: string;
      /**
       * The status the row held **under the lock** — so, unlike the retry
       * endpoint's advisory read, this one was true at the instant the
       * decision was made. For the log line; nothing branches on it twice.
       */
      readonly observedStatus: OrderStatus;
    }
  | {
      readonly outcome: typeof PromoRedemptionOutcome.UnknownCode;
      readonly orderId: string;
      readonly code: string;
    }
  | {
      readonly outcome: typeof PromoRedemptionOutcome.AnotherCodeApplied;
      readonly orderId: string;
      /** The code the shopper asked for — never looked up, because statement 3 answered first. */
      readonly code: string;
      /** The code that is on the order, from the redemption row's join. */
      readonly appliedCode: string;
      readonly appliedPromoId: number;
    }
  | {
      readonly outcome: typeof PromoRedemptionOutcome.Exhausted;
      readonly orderId: string;
      readonly code: string;
      readonly promoId: number;
      /** The limit the counter is sitting at — the log's `3 of 3`. */
      readonly maxUses: number;
    };

/**
 * The four outcomes that answer with `{ reason }` — the `409`/`422` subset of
 * {@link PromoRedemptionOutcome}. `order_not_found` is not among them: a `404`
 * is Nest's default body, as `GET /api/orders/:id` already sends it, because it
 * is about the request target and not about the code.
 *
 * Derived from the outcome constants rather than retyped, so the string on the
 * wire and the string in the service's result are provably the same value.
 */
export type PromoRefusalReason =
  | typeof PromoRedemptionOutcome.NotAwaitingPayment
  | typeof PromoRedemptionOutcome.UnknownCode
  | typeof PromoRedemptionOutcome.AnotherCodeApplied
  | typeof PromoRedemptionOutcome.Exhausted;

/** The refusal body on the wire. Exactly one field — see the file header. */
export interface PromoRefusalBody {
  readonly reason: PromoRefusalReason;
}

/**
 * The two status codes a refusal may carry. Typed as the pair rather than as
 * `HttpStatus` so a future member cannot be handed a `5xx` — which the shop's
 * own client would read as "try again", the one thing a refusal must never
 * invite.
 */
export type PromoRefusalStatus = HttpStatus.CONFLICT | HttpStatus.UNPROCESSABLE_ENTITY;

/**
 * A refusal, ready to send: the status and the body, built together.
 *
 * A pair rather than an `HttpException`, unlike `supplierRefusal`, because the
 * controller needs the status **as a number** for its log line before it
 * throws — and an exception's `getStatus()` typed as plain `number` would let
 * the log say one thing and the wire another only by construction, whereas
 * this pair is produced by one `switch` and cannot.
 */
export interface PromoRefusal {
  readonly status: PromoRefusalStatus;
  readonly body: PromoRefusalBody;
}

/** Exhaustiveness guard: the compiler routes here only if a reason went unhandled. */
function assertNever(value: never): never {
  throw new Error(`promo: unhandled refusal reason ${JSON.stringify(value)}`);
}

/**
 * Build the refusal that answers one reason.
 *
 * Built **once, from the reason**, exactly as `supplierRefusal` does: the body
 * is constructed before the `switch` and the `switch` chooses only the status,
 * so there is no branch in which the two could name different things.
 *
 * ### The digits, and why they differ
 *
 * - **`unknown_code` → `422 Unprocessable Content`.** RFC 9110 §15.5.21: the
 *   syntax was understood and the server *"was unable to process the contained
 *   instructions"*. The instruction names a code the shop does not have. The
 *   shop's own `POST /api/orders` uses `422` for the same sense of *well-formed,
 *   understood, and not something the shop sells*
 *   (`ProductNotPurchasable`), and `404` was rejected for the reason that
 *   endpoint gives: `404` is a statement about the request target, and
 *   `/api/orders/{id}/promo` is a route that exists on an order that exists.
 * - **`exhausted` → `409 Conflict`.** RFC 9110 §15.5.10, *"a conflict with the
 *   current state of the target resource"*: the state is the counter, the
 *   conflict is that it is full. Nothing is wrong with the request; the same
 *   digits `out_of_stock` carries from the supplier stub, for the same
 *   reason. `410 Gone` was rejected: it says the target resource is gone, which
 *   is false — the order is right there and another code is still applicable.
 * - **`not_awaiting_payment` and `another_code_applied` → `409`.** Both are a
 *   conflict with the order's current state — it has moved past `created`, or
 *   it already carries a code — and both mean the same thing to the page:
 *   *the order changed under you; refresh*.
 *
 * Neither digit is in the `5xx` family, and neither may ever be — the return
 * type says so.
 */
export function promoRefusal(reason: PromoRefusalReason): PromoRefusal {
  // Built once, from the reason, so the body cannot disagree with the status —
  // and `satisfies` keeps it to the contract's one field exactly.
  const body = { reason } satisfies PromoRefusalBody;

  switch (reason) {
    case PromoRedemptionOutcome.UnknownCode:
      return { status: HttpStatus.UNPROCESSABLE_ENTITY, body };

    case PromoRedemptionOutcome.Exhausted:
    case PromoRedemptionOutcome.NotAwaitingPayment:
    case PromoRedemptionOutcome.AnotherCodeApplied:
      return { status: HttpStatus.CONFLICT, body };

    default:
      return assertNever(reason);
  }
}
