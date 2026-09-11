/**
 * The wire body of `POST /internal/suppliers/:provider/issue`, parsed once for
 * every stub (technical-considerations §2.3; spec 003 §7).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS HERE AND NOT IN `a/`
 * ---------------------------------------------------------------------------
 * Same reason {@link SupplierKeyClaimService} is here. `./a/supplier-a.module.ts`
 * states the split: *"What is specific to A is what lives here: an endpoint, and
 * the failure and timeout behaviour injected in front of it."* The shape of the
 * request is specific to neither — it is `SupplierIssueRequest` in
 * `@game-shop/contracts`, transcribed from the assignment, and both stubs are
 * answering the same contract.
 *
 * Two copies of a validator is the kind of duplication that stays correct right
 * up until one of them is tightened. If supplier B accepted a body supplier A
 * rejected, the fall-through would start succeeding for the wrong reason and the
 * difference would read as B being more reliable than A.
 *
 * This is a **parser**, not a policy: it holds no database handle, decides
 * nothing about keys, and each stub still states its own `SupplierProvider`
 * identity at its own endpoint.
 */
import { BadRequestException } from "@nestjs/common";

import type { SupplierKeyClaimRequest } from "./supplier-key-claim.service.js";

/** `null`-safe object test — `typeof null` is `"object"`, and a body may be `null`. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A required wire field. Empty is as absent as missing. */
function readNonEmptyString(body: Record<string, unknown>, field: string): string {
  const value = body[field];

  if (typeof value !== "string" || value === "") {
    throw new BadRequestException(`"${field}" must be a non-empty string`);
  }

  return value;
}

/**
 * Parse the wire body and map it onto the domain request.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE ONE PLACE snake_case BECOMES camelCase
 * ---------------------------------------------------------------------------
 * `SupplierIssueRequest` (`@game-shop/contracts`) is the supplier's fixed wire
 * shape, transcribed from the assignment and unrenameable.
 * {@link SupplierKeyClaimRequest} is the domain call. The three-line object
 * below is the entire crossing between them, so nothing downstream of here ever
 * sees a `request_id` and nothing upstream ever sees a `requestId`.
 *
 * ### All three fields are required, even though only one decides anything
 *
 * The service reads `requestId` and logs the other two — the pool is
 * undifferentiated, so no query touches `sku`. They are still required, because
 * the contract fixes all three and a supplier that quietly accepted a call with
 * no SKU would be lenient about something a real one would reject, which is the
 * kind of leniency that hides a client bug until a fall-through is trying to
 * explain a missing key.
 *
 * This is deliberately **stricter than `parsePaymentWebhookPayload`**, and the
 * asymmetry is the point. That endpoint stores a status it does not recognise
 * because the sender is a real payment provider reporting something that
 * happened to real money, and destroying that evidence is worse than not
 * understanding it. Nothing of the kind applies here: the sender is our own
 * issuance client, no money has moved, and there is nothing to preserve — the
 * same reasoning `parseSimulatePaymentRequest` gives for narrowing `outcome`.
 *
 * Rejecting is also safe in a way that matters to the retry policy: a `400`
 * happens before any key is touched, so nothing is claimed and nothing is
 * written to the ledger. A corrected retry carrying the same `request_id` issues
 * normally.
 *
 * `request_id` is read first, so a body missing everything complains about the
 * field that actually matters.
 *
 * Hand-written rather than `class-validator` + a `ValidationPipe`, as every
 * other controller here is: `packages/contracts` stays free of validation
 * frameworks because `apps/web` bundles it into a browser.
 *
 * A body that is not JSON at all never reaches this function — Express's JSON
 * parser rejects it first and Nest turns that into a `400`, which is the same
 * answer for the same reason.
 */
export function parseSupplierIssueRequest(body: unknown): SupplierKeyClaimRequest {
  if (!isJsonObject(body)) {
    throw new BadRequestException(
      'expected a JSON body of the form { "request_id": string, "sku": string, "order_id": string }',
    );
  }

  return {
    requestId: readNonEmptyString(body, "request_id"),
    sku: readNonEmptyString(body, "sku"),
    orderId: readNonEmptyString(body, "order_id"),
  };
}
