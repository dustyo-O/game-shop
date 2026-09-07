/**
 * The shop's client for supplier A — `POST {SUPPLIER_A_URL}/issue` over real
 * HTTP, with `SUPPLIER_TIMEOUT_MS` as the deadline (technical-considerations
 * §2.5 step 4 and §2.7; `architecture.md` §6).
 *
 * ---------------------------------------------------------------------------
 * IT IS IN THE SAME PROCESS AND IT IS STILL A NETWORK CALL
 * ---------------------------------------------------------------------------
 * {@link SupplierKeyClaimService} is one `import` away and calling it directly
 * would be faster, atomic and completely wrong. `SupplierAModule` exports
 * nothing precisely so that route does not exist
 * (`../suppliers/a/supplier-a.module.ts`), and `architecture.md` §6 states the
 * requirement: *"reached over real HTTP so that latency, timeouts and failures
 * are genuine rather than simulated in-process."*
 *
 * What the shortcut would delete, in one sentence: inside a shared transaction
 * the outcome of an issuance is knowable by construction — it committed or it
 * did not — and the entire assignment is about the third answer.
 *
 * ---------------------------------------------------------------------------
 * THE ONLY DECISION THIS FILE MAKES: DEFINITE, OR UNKNOWN
 * ---------------------------------------------------------------------------
 * One value comes back on success — a code — and every other path throws one of
 * two typed errors (`./supplier-issue.errors.ts`, `architecture.md` §8). The
 * classification is made **here**, at the one place that saw the wire, and
 * travels with the error so it cannot be re-derived (or re-guessed) later.
 *
 * The discriminator is **the body, not the status code.** Supplier A's own
 * controller says so and explains why:
 *
 *   > the status code is a hint, not the discriminator. What tells a client
 *   > "definite" is a parseable `SupplierIssueErrorResponse` body. A timeout has
 *   > no body at all.
 *
 * So the rule below is exact, and the asymmetry in it is deliberate:
 *
 *   | Observation                                          | Classification |
 *   | ---------------------------------------------------- | -------------- |
 *   | `2xx` + `{ status: "ok", request_id: <ours>, code }`  | issued         |
 *   | `{ status: "error", reason: <known> }`, any status    | **definite**   |
 *   | no response (timeout, refused connection, dead socket)| **unknown**    |
 *   | a response whose body is not JSON                     | **unknown**    |
 *   | JSON that is neither contract shape                   | **unknown**    |
 *   | `{ status: "ok" }` echoing a `request_id` we never sent| **unknown**   |
 *   | an unrecognised `reason`                              | **unknown**    |
 *
 * Every "cannot read it" lands on `unknown`, never on `failed`, and that is the
 * conservative direction on purpose: `failed` is a licence to ask a *different*
 * supplier for a *second* key, and it may only be issued when this supplier
 * explicitly said no in a form we could read. A garbled answer from a supplier
 * that had already claimed a key, mistaken for `failed`, is exactly how one
 * order ends up paying for two.
 *
 * ---------------------------------------------------------------------------
 * PHASE 3
 * ---------------------------------------------------------------------------
 * Supplier B is a second instance of this class over `SUPPLIER_B_CONFIG` — the
 * config type is already `SupplierEndpointConfig`, named for a supplier in
 * general rather than for A (`../config/supplier-config.ts`). Nothing in the
 * parsing or the classification below is A-specific; only the injected token and
 * the `provider` tag are.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";

import {
  SupplierIssueErrorReason,
  SupplierIssueStatus,
  type SupplierIssueRequest,
} from "@game-shop/contracts";

import { SUPPLIER_A_CONFIG, type SupplierEndpointConfig } from "../config/supplier-config.js";
import { IssuanceProvider } from "./issuance-request-id.js";
import { SupplierDefiniteFailure, SupplierUnknownOutcome } from "./supplier-issue.errors.js";

/** `null`-safe object test — `typeof null` is `"object"`, and a parsed body may be `null`. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Is this one of the reasons the contract defines?
 *
 * Local to `apps/api` rather than exported from `packages/contracts`, matching
 * `isPaymentWebhookAckOutcome` in `../payments/payment-webhook.types.ts`: a wire
 * type describes what the other side promised, and checking that a particular
 * payload kept the promise belongs to the code that received it
 * (`packages/contracts/src/index.ts`, "WHAT THIS PACKAGE IS NOT").
 *
 * An unrecognised reason is deliberately **not** definite. Phase 3 adds members
 * to `SupplierIssueErrorReason`, and a shop running an older build against a
 * newer supplier would otherwise treat a reason it has never heard of as a
 * licence to ask the backup for a second key.
 */
function isKnownErrorReason(value: unknown): value is SupplierIssueErrorReason {
  return (
    typeof value === "string" &&
    (Object.values(SupplierIssueErrorReason) as readonly string[]).includes(value)
  );
}

/** How much of an unreadable body is worth putting in a log line. */
const MAX_LOGGED_BODY_CHARS = 300;

@Injectable()
export class SupplierAClient {
  private readonly logger = new Logger(SupplierAClient.name);

  /** Which supplier this instance speaks to. On every log line and in every error. */
  private readonly provider = IssuanceProvider.A;

  constructor(
    @Inject(SUPPLIER_A_CONFIG) private readonly config: SupplierEndpointConfig,
  ) {}

  /**
   * Ask supplier A to issue a key for `request.request_id`, and return the code.
   *
   * @throws {SupplierDefiniteFailure} the supplier answered with a parseable
   *   refusal. No key was issued.
   * @throws {SupplierUnknownOutcome} no usable answer. A key may or may not have
   *   been issued; ask again with this same `request_id`.
   *
   * ### The deadline
   *
   * `AbortSignal.timeout(timeoutMs)` rather than a `Promise.race` against a
   * `setTimeout`: the signal aborts the underlying socket, so a hung supplier
   * stops consuming a connection at the moment we give up instead of running to
   * completion behind a promise nobody is waiting on. It also covers reading the
   * body, not just the headers — a supplier that answers `200` and then stalls
   * mid-body is a timeout too.
   *
   * The value comes from `SUPPLIER_TIMEOUT_MS`, validated at boot, and its place
   * in the ordered chain is the load-bearing part
   * (`../config/supplier-config.ts`):
   *
   *     supplier's injected hang  <  SUPPLIER_TIMEOUT_MS  <  function ceiling
   *
   * When our client gives up first, "no answer" becomes a *value* the shop can
   * record. When the platform's ceiling arrives first, the function is killed —
   * no exception, no `catch`, no log line — and the attempt row is left saying
   * `unknown` by construction, which is the reason it is written before the call
   * (`./issuance.service.ts`).
   *
   * ### `${baseUrl}/issue`, by concatenation
   *
   * Not `new URL("issue", baseUrl)`, which resolves against the base's *parent*
   * and turns `.../suppliers/a` into `.../suppliers/issue` — a `404` that looks
   * exactly like a supplier being down. `SupplierEndpointConfig.baseUrl` is a
   * normalised string with no trailing slash for this exact reason; its own
   * documentation says so.
   */
  async issue(request: SupplierIssueRequest): Promise<string> {
    const url = `${this.config.baseUrl}/issue`;

    this.logger.log({
      msg: "supplier client: calling supplier over HTTP",
      order_id: request.order_id,
      request_id: request.request_id,
      provider: this.provider,
      sku: request.sku,
      url,
      timeout_ms: this.config.timeoutMs,
    });

    let response: Response;
    let rawBody: string;

    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });

      // Inside the same `try` as the request: the deadline covers the body, and
      // a socket that dies while the body is streaming is the same class of
      // event as one that dies before the headers.
      rawBody = await response.text();
    } catch (error: unknown) {
      // ##################################################################
      // # NO ANSWER. THIS IS `unknown`, AND IT MUST NEVER BECOME `failed`.
      // ##################################################################
      //
      // Timeout, connection refused, DNS failure, socket reset — one branch,
      // because the caller's correct action is the same in all of them and is
      // the opposite of the action for a refusal. The supplier may have claimed
      // a key a microsecond before the socket died; the only way to find out is
      // to ask again with the same `request_id` and let its ledger answer (I5).
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

      throw this.unknown(request, `no response (${detail})`);
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw this.unknown(
        request,
        `HTTP ${String(response.status)} with a body that is not JSON: ` +
          JSON.stringify(rawBody.slice(0, MAX_LOGGED_BODY_CHARS)),
      );
    }

    return this.readCode(request, response, body, rawBody);
  }

  /**
   * Turn a parsed body into a code, or into the right typed error.
   *
   * Split from {@link issue} so the transport concerns (deadline, socket,
   * JSON) and the contract concerns (which shape, which classification) are
   * readable separately. Everything here is untrusted input from a service the
   * shop distrusts by design — nothing is asserted with `as`, every field is
   * checked before it is used, and no path falls through to a default.
   */
  private readCode(
    request: SupplierIssueRequest,
    response: Response,
    body: unknown,
    rawBody: string,
  ): string {
    if (!isJsonObject(body)) {
      throw this.unknown(
        request,
        `HTTP ${String(response.status)} with a JSON body that is not an object: ` +
          JSON.stringify(rawBody.slice(0, MAX_LOGGED_BODY_CHARS)),
      );
    }

    // ------------------------------------------------------------------
    // THE DEFINITE BRANCH — and the only one there is.
    // ------------------------------------------------------------------
    // Checked before the ok branch and without consulting `response.ok`,
    // because the body is the discriminator. A `{ status: "error" }` arriving
    // with a `200` would still be a refusal, and this is the only place in the
    // system permitted to conclude "no key was issued".
    if (body["status"] === SupplierIssueStatus.Error) {
      const reason: unknown = body["reason"];

      if (!isKnownErrorReason(reason)) {
        throw this.unknown(
          request,
          `HTTP ${String(response.status)} error body with an unrecognised reason: ` +
            JSON.stringify(reason),
        );
      }

      this.logger.warn({
        msg: "supplier client: definite failure — the supplier answered and refused",
        order_id: request.order_id,
        request_id: request.request_id,
        provider: this.provider,
        reason,
        status_code: response.status,
      });

      throw new SupplierDefiniteFailure(
        reason,
        response.status,
        request.request_id,
        request.order_id,
        this.provider,
      );
    }

    // ------------------------------------------------------------------
    // THE SUCCESS BRANCH.
    // ------------------------------------------------------------------
    if (body["status"] !== SupplierIssueStatus.Ok || !response.ok) {
      throw this.unknown(
        request,
        `HTTP ${String(response.status)} with a body matching neither contract shape: ` +
          JSON.stringify(rawBody.slice(0, MAX_LOGGED_BODY_CHARS)),
      );
    }

    const code: unknown = body["code"];
    const echoedRequestId: unknown = body["request_id"];

    if (typeof code !== "string" || code === "") {
      throw this.unknown(request, `HTTP ${String(response.status)} ok body with no usable "code"`);
    }

    // The contract says the response echoes the id we sent. A different one is
    // an answer to somebody else's question, and it is evidence about *their*
    // request, not ours — so ours stays unknown rather than being resolved by a
    // code we have no right to bind. Cheap to check, and the failure it catches
    // (a proxy or a stub crossing two requests) is otherwise a key silently
    // delivered to the wrong order.
    if (echoedRequestId !== request.request_id) {
      throw this.unknown(
        request,
        `ok body echoing a different request_id: ${JSON.stringify(echoedRequestId)}`,
      );
    }

    this.logger.log({
      msg: "supplier client: supplier returned a code",
      order_id: request.order_id,
      request_id: request.request_id,
      provider: this.provider,
      status_code: response.status,
    });

    return code;
  }

  /**
   * Log the silence and build the error. One place, so an unknown outcome can
   * never be raised without the line that makes it findable — which is the line
   * the Phase 3 timeout scenario is read from (`architecture.md` §8).
   *
   * `warn`, not `error`: no answer from a supplier is an ordinary event on a
   * network and the system has a defined response to it. An `error` here would
   * train whoever watches the logs to ignore the level that matters.
   */
  private unknown(request: SupplierIssueRequest, detail: string): SupplierUnknownOutcome {
    this.logger.warn({
      msg: "supplier client: UNKNOWN outcome — no usable answer; a key may or may not have been issued",
      order_id: request.order_id,
      request_id: request.request_id,
      provider: this.provider,
      detail,
    });

    return new SupplierUnknownOutcome(detail, request.request_id, request.order_id, this.provider);
  }
}
