/**
 * `POST /internal/suppliers/a/issue` — supplier A's key issuance endpoint
 * (technical-considerations §2.3 and §2.4; architecture.md §6).
 *
 * ---------------------------------------------------------------------------
 * THIS IS A DIFFERENT SERVICE THAT HAPPENS TO SHARE A PROCESS
 * ---------------------------------------------------------------------------
 * The shop does not call {@link SupplierKeyClaimService}. It calls *this URL*,
 * over real HTTP, through `SUPPLIER_A_URL` — and it believes what comes back
 * only as far as it can write a `deliveries` row of its own. Architecture §6
 * makes that a requirement rather than a stylistic choice: *"reached over real
 * HTTP so that latency, timeouts and failures are genuine rather than simulated
 * in-process."* Every guarantee the later phases demonstrate — the timeout that
 * is not a failure, the retry that returns the same code, the fallback that must
 * not fire while an attempt is outstanding — only means something if the shop
 * has to earn it across a boundary it distrusts.
 *
 * Hence the path with no `/api` on it. That is a deliberate absence: `/api` is
 * the shop's namespace, and this is not the shop. There is no
 * `setGlobalPrefix("api")` anywhere in `main.ts` — each shop controller carries
 * the prefix itself — precisely so this route can sit outside it, and
 * `.env.example` already points `SUPPLIER_A_URL` at
 * `http://localhost:3000/internal/suppliers/a`, to which the issuance client
 * appends `/issue`.
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE THIS ENDPOINT EXISTS TO KEEP
 * ---------------------------------------------------------------------------
 * From the assignment: *a repeat with the same `request_id` must return the same
 * code, not issue a new one.* {@link SupplierKeyClaimService} keeps that promise
 * in Postgres; what this file adds is that **the caller cannot tell the two
 * apart from the outside.** `issued` and `already_issued` share a single `case`
 * below and produce byte-identical `200 { status, request_id, code }` bodies.
 *
 * That indistinguishability is the feature, not a simplification. A client whose
 * call timed out does not know whether its first attempt got through — and with
 * this endpoint, it does not need to. It retries with the same `request_id` and
 * is answered correctly either way. The moment the response revealed which
 * branch ran ("issued" vs. "already issued"), a client could start *deciding*
 * things from it, and the first such decision would be wrong: a first attempt
 * that succeeded and then timed out looks, to the retry, exactly like a first
 * attempt that never arrived.
 *
 * ---------------------------------------------------------------------------
 * WHY `409` FOR AN EMPTY POOL — THE FAMILY MATTERS MORE THAN THE DIGITS
 * ---------------------------------------------------------------------------
 * Phase 3's retry policy has two branches and they are not symmetric
 * (architecture.md §4):
 *
 *   - **Definite failure** — the supplier answered and said no. No key was
 *     issued, the attempt is `failed`, and the client may fall through to the
 *     backup supplier with a **new** `request_id`.
 *   - **Unknown outcome** — a timeout. No answer at all. The attempt is
 *     `unknown`, *never* `failed`; the client retries **this** supplier with
 *     **the same** `request_id` and must never fall through while it is
 *     outstanding.
 *
 * An empty pool is squarely the first: immediate, answered, and provably
 * key-less, because the claim transaction commits having written nothing
 * (`SupplierKeyClaimService.claimAndRecord`). So the status code has to read as
 * *"answered, and the answer is no"*.
 *
 * That rules out the whole `5xx` family before the choice of digits begins.
 * `502`, `503` and `504` are what an intermediary emits when it could not reach
 * a service or gave up waiting — the shape of an *unknown* outcome, and on
 * Vercel exactly what a killed function produces. Dressing the one outcome we
 * are certain about in the costume of the ones we are not is how a client ends
 * up routing "definitely no key" and "possibly a key" through one branch, which
 * is the assignment's trap sprung by its own stub. A `4xx` cannot be produced by
 * a supplier that never ran.
 *
 * Among the `4xx`s, `409 Conflict` is the one that describes this — RFC 9110
 * §15.5.10, *"the request could not be completed due to a conflict with the
 * current state of the target resource"*. The state is the pool; the conflict is
 * that it is empty. Nothing is wrong with the request, which is why it is not
 * `400`, and that distinction is operational rather than pedantic: a `400` here
 * means the shop's client is malformed and someone must change code, a `409`
 * means inventory ran out and someone must restock. `404` would be worse again —
 * a mistyped `SUPPLIER_A_URL` produces one, so a routing mistake and an empty
 * pool would be indistinguishable at the status line.
 *
 * `409` also happens to be true about retrying: the identical bytes succeed once
 * the pool is restocked, because `out_of_stock` writes nothing to the ledger and
 * leaves this `request_id` unanswered. That is what lets Phase 3 re-drive an
 * `out_of_stock` order through this same idempotent path instead of minting a
 * new identifier.
 *
 * One caveat worth stating plainly, because it is what keeps the policy honest:
 * **the status code is a hint, not the discriminator.** What tells a client
 * "definite" is a parseable {@link SupplierIssueErrorResponse} body. A timeout
 * has no body at all — which is why `SupplierIssueResponse` has no timeout
 * member (`packages/contracts/src/supplier.ts`).
 *
 * ---------------------------------------------------------------------------
 * WHERE PHASE 3'S FAILURE AND TIMEOUT INJECTION GOES
 * ---------------------------------------------------------------------------
 * Here, at the top of {@link SupplierAController.issue}, before the service is
 * called — as an injected provider of `SupplierAModule` reading its rates from
 * the environment (architecture.md §5, *"supplier behaviour must be tunable at
 * runtime"*). Nothing about this file needs restructuring for it: an injected
 * failure returns the same error shape with a new `reason` member, which is one
 * line in `packages/contracts`; an injected timeout sleeps past
 * `SUPPLIER_TIMEOUT_MS` and never reaches the claim at all.
 *
 * Above the service and never inside it, because the service's guarantees are
 * about what is *stored*, and injected chaos must not be able to weaken them. A
 * hang injected *after* a successful claim is precisely the Phase 3 trap — a key
 * genuinely issued, a client that timed out and cannot know it, and a retry on
 * the same `request_id` that gets the same code back.
 *
 * None of those knobs exist yet. Technical-considerations §1 builds *"only
 * supplier A, always succeeding"* in this phase, so the only way this endpoint
 * does not return a code is an empty pool.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
} from "@nestjs/common";

import {
  SupplierIssueErrorReason,
  SupplierIssueStatus,
  type SupplierIssueErrorResponse,
  type SupplierIssueOkResponse,
} from "@game-shop/contracts";

import {
  SupplierKeyClaimOutcome,
  SupplierKeyClaimService,
  type SupplierKeyClaimRequest,
} from "../supplier-key-claim.service.js";

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
 * kind of leniency that hides a client bug until Phase 3 is trying to explain a
 * missing key.
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
function parseSupplierIssueRequest(body: unknown): SupplierKeyClaimRequest {
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

/** Exhaustiveness guard: the compiler routes here only if an outcome went unhandled. */
function assertNever(value: never): never {
  throw new Error(`suppliers/a: unhandled claim outcome ${JSON.stringify(value)}`);
}

@Controller("internal/suppliers/a")
export class SupplierAController {
  private readonly logger = new Logger(SupplierAController.name);

  constructor(private readonly keys: SupplierKeyClaimService) {}

  /**
   * Issue a key for this `request_id` — or the one it was already issued.
   *
   * **`200`, not Nest's default `201` for `@Post`.** The assignment's contract
   * says `200`, and it is right on its own terms: a repeat of an answered
   * `request_id` creates nothing at all, and an endpoint whose whole promise is
   * that the caller cannot tell first sight from a repeat must not announce the
   * difference in its status line. `201` on one and `200` on the other would
   * leak exactly the fact this design hides.
   *
   * ### The two success outcomes share one `case` on purpose
   *
   * They are the same news to the shop. The difference survives only in the log
   * lines below and in {@link SupplierKeyClaimService}'s, where it is the Phase 3
   * timeout trap being visibly survived rather than something a client acts on.
   *
   * ### Why the success line logs the code
   *
   * Because the property being demonstrated — *the same `request_id` came back
   * with the same code* — is only readable in the log stream if the code is in
   * it. This is the simulated supplier's own log, not the shop's, and the code is
   * on the wire to that shop a microsecond later; there is no secret being spent
   * here that the response does not already spend.
   *
   * It also records something {@link SupplierKeyClaimService} cannot: that a
   * `200` carrying a code *was sent*. The service's line proves the database
   * write. In Phase 3 the interesting incident is a client that timed out while
   * the supplier had already answered, and the distance between those two lines
   * is precisely the window that incident lives in.
   */
  @Post("issue")
  @HttpCode(HttpStatus.OK)
  async issue(@Body() body: unknown): Promise<SupplierIssueOkResponse> {
    const request = parseSupplierIssueRequest(body);

    const result = await this.keys.issue(request);

    switch (result.outcome) {
      case SupplierKeyClaimOutcome.Issued:
      case SupplierKeyClaimOutcome.AlreadyIssued:
        this.logger.log({
          msg: "supplier A: answering 200 with a code",
          request_id: request.requestId,
          order_id: request.orderId,
          sku: request.sku,
          code: result.code,
        });

        // `request.requestId`, not anything from `result`: the contract says the
        // response echoes the id the caller sent, and on the repeat path there
        // is nothing else it could be — the ledger row holds a code, not a
        // second copy of the id it is keyed by.
        return {
          status: SupplierIssueStatus.Ok,
          request_id: request.requestId,
          code: result.code,
        };

      case SupplierKeyClaimOutcome.OutOfStock:
        this.logger.warn({
          msg: "supplier A: pool empty; answering 409 out_of_stock",
          request_id: request.requestId,
          order_id: request.orderId,
          sku: request.sku,
          status_code: HttpStatus.CONFLICT,
        });

        // Thrown rather than returned so the body is the contract's two fields
        // and nothing else. Nest serialises an object passed to an
        // `HttpException` verbatim — it only wraps a *string* in its own
        // `{ message, error, statusCode }` envelope — and the client parses this
        // body to decide `failed` vs. `unknown`, so an extra field or a wrapper
        // would be a change to the interface, not to the prose.
        throw new ConflictException({
          status: SupplierIssueStatus.Error,
          reason: SupplierIssueErrorReason.OutOfStock,
        } satisfies SupplierIssueErrorResponse);

      default:
        return assertNever(result);
    }
  }
}
