/**
 * The wire body — and the status code — of a **definite refusal** from either
 * stub (technical-considerations 003 §7; spec 003 §2.1).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS HERE AND NOT IN `a/` AND `b/`
 * ---------------------------------------------------------------------------
 * The same argument `./supplier-issue-request.ts` makes for the request parser,
 * pointed the other way down the wire. The shape of a refusal is specific to
 * neither supplier — it is `SupplierIssueErrorResponse` in
 * `@game-shop/contracts`, transcribed from the assignment — and both stubs are
 * answering the same contract. Two copies stay correct right up until one of
 * them is changed, and here the divergence would be worse than a mismatched
 * field: if B refused with a `503` where A refused with a `4xx`, the shop would
 * read B's answer as an *unknown outcome* and would be forbidden from doing the
 * one thing it is supposed to do next.
 *
 * What still lives at each stub is what is genuinely its own: the endpoint, the
 * `SupplierProvider` identity it states, and its log lines.
 *
 * ---------------------------------------------------------------------------
 * `4xx`, NEVER `5xx` — THE FAMILY IS THE POINT, THE DIGITS ARE A HINT
 * ---------------------------------------------------------------------------
 * `../suppliers/a/supplier-a.controller.ts` sets this out in full and it is not
 * repeated here. In one line: a refusal is *answered, and the answer is no* —
 * the supplier ran, decided, and provably issued no key — while the whole `5xx`
 * family is the shape of an **unknown** outcome, being what an intermediary
 * emits when it could not reach a service and what a killed serverless function
 * produces. A stub that dressed a refusal as a `5xx` would spring the
 * assignment's central trap with its own test double: the shop would route
 * "definitely no key" through the branch built for "possibly a key", and would
 * be barred from the fall-through that a refusal exists to trigger.
 *
 * The caveat that keeps the policy honest, also from A's header: **the status
 * code is a hint, not the discriminator.** What tells the shop "definite" is a
 * parseable {@link SupplierIssueErrorResponse} body (`../issuance/supplier.client.ts`),
 * which is why the body is built here once and why nothing downstream branches
 * on the number. The digits are chosen anyway, because they are what an
 * operator reads in an access log, and the two refusals mean different things
 * to whoever has to act on them.
 *
 * ---------------------------------------------------------------------------
 * THE `assertNever` IS THE POINT OF THE `switch`
 * ---------------------------------------------------------------------------
 * A `Record<SupplierIssueErrorReason, number>` would also be total, but it would
 * let a future member be given a `5xx` by an author who never read this file. A
 * `switch` with an exhaustiveness guard stops the build at the line where the
 * choice is made, next to the paragraph explaining which half of the HTTP
 * status space is admissible and why.
 */
import {
  ConflictException,
  UnprocessableEntityException,
  type HttpException,
} from "@nestjs/common";

import {
  SupplierIssueErrorReason,
  SupplierIssueStatus,
  type SupplierIssueErrorResponse,
} from "@game-shop/contracts";

/** Exhaustiveness guard: the compiler routes here only if a reason went unhandled. */
function assertNever(value: never): never {
  throw new Error(`suppliers: unhandled refusal reason ${JSON.stringify(value)}`);
}

/**
 * Build the exception that answers one definite refusal.
 *
 * Returns rather than throws, so the caller can log the status it is about to
 * send (`refusal.getStatus()`) without that number being written down a second
 * time in the log line — the one place two copies of a status code could drift
 * apart inside a single handler.
 *
 * An `HttpException` rather than a body plus a number: Nest serialises an object
 * passed to one **verbatim**, wrapping only a *string* in its own
 * `{ message, error, statusCode }` envelope. The shop parses this body to decide
 * `failed` vs. `unknown`, so an extra field or an envelope would be a change to
 * the interface rather than to the prose.
 *
 * ### The digits, and why they differ
 *
 * - **`out_of_stock` → `409 Conflict`.** RFC 9110 §15.5.10, *"a conflict with
 *   the current state of the target resource"*: the state is the pool, the
 *   conflict is that it is empty. Nothing is wrong with the request, which is
 *   why it is not a `400`, and that is operational rather than pedantic — a
 *   `400` means someone must change the shop's client, a `409` means someone
 *   must restock. A's controller argues this at length.
 * - **`supplier_rejected` → `422 Unprocessable Content`.** RFC 9110 §15.5.21:
 *   the content type and syntax were understood, and the server *"was unable to
 *   process the contained instructions"*. The instruction is "issue a key for
 *   this `request_id`" and the supplier declined it — nothing is malformed and
 *   nothing is missing from the pool. A distinct code from `409` on purpose: the
 *   two refusals send the order to two different statuses (003 §2.4) and cost
 *   the operator two different actions, so making them indistinguishable at the
 *   status line would throw away information that is free to keep. `403` was
 *   the alternative and reads as a credentials problem the supplier does not
 *   have; the shop's own `POST /api/orders` already uses `422` for the same
 *   sense of *understood, well-formed, and refused*
 *   (`../orders/orders.controller.ts`, `ProductNotPurchasable`).
 *
 * Neither is in the `5xx` family, and neither may ever be.
 */
export function supplierRefusal(reason: SupplierIssueErrorReason): HttpException {
  // Built once, from the reason, so the body cannot disagree with the status —
  // and `satisfies` keeps it to the contract's two fields exactly.
  const body = { status: SupplierIssueStatus.Error, reason } satisfies SupplierIssueErrorResponse;

  switch (reason) {
    case SupplierIssueErrorReason.OutOfStock:
      return new ConflictException(body);

    case SupplierIssueErrorReason.SupplierRejected:
      return new UnprocessableEntityException(body);

    default:
      return assertNever(reason);
  }
}
