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
 * called. Nothing about this file needed restructuring for it, and the failure
 * half of that prediction has now been cashed twice over: the `reason` member is
 * `supplier_rejected`, it cost one line in `packages/contracts`, and it is built
 * by the shared `../supplier-issue-refusal.ts` exactly as `out_of_stock` is — an
 * injected refusal is a *reason*, not a second way of answering.
 *
 * Around the service and never inside it, because the service's guarantees are
 * about what is *stored*, and injected chaos must not be able to weaken them.
 *
 * ### Both halves are now read, and they sit in different places
 *
 * `supplier_behaviour` holds a row per provider, tunable through
 * `PUT /internal/suppliers/:provider/behaviour`, and this endpoint reads all of
 * it:
 *
 *   - **The refusal.** {@link SupplierBehaviourService.shouldRefuse} spends
 *     `fail_next` and then rolls `failure_rate`, **before the key claim**, so a
 *     refused call provably claims nothing. An armed refusal that claimed first
 *     would quietly drain the fifty-key pool and break the one assertion this
 *     phase rests on — `claimed keys = deliveries`.
 *   - **The hang.** {@link SupplierBehaviourService.shouldHang} spends
 *     `hang_next` and then rolls `hang_rate`, also before the claim — but the
 *     *wait* it decides on happens on the side of the claim that
 *     `hang_before_claim` names, and the default is **after**.
 *
 * ### And the hang's placement is the whole of the trap
 *
 * A hang after the claim commits is precisely the Phase 3 trap: a key genuinely
 * issued, a ledger row holding its code, a client that timed out and cannot
 * know it, and a re-probe on the same `request_id` that gets the same code
 * back. Placed *before* the claim instead, the same knob stages a different and
 * equally real scenario — *a slow supplier is not a failed one* — and the two
 * are different checks rather than two settings of one
 * (`../supplier-hang.ts`; technical-considerations §7.1).
 *
 * Neither wait is inside a transaction. `keys.issue(...)` has returned by the
 * time the `after` hold runs, so the claim has committed and the instance's one
 * pooled connection is free; a wait held *inside* that transaction would stall
 * every other request in this process (`packages/db/src/client.ts`, `max: 1`).
 *
 * There is now a second stub beside this one (`../b/supplier-b.controller.ts`),
 * the backup a definite refusal falls through to. It draws from the same pool
 * and the same ledger, and states its own identity at its own endpoint exactly
 * as this one does.
 */
import { Body, Controller, HttpCode, HttpStatus, Logger, Post } from "@nestjs/common";

import {
  SupplierIssueErrorReason,
  SupplierIssueStatus,
  type SupplierIssueOkResponse,
} from "@game-shop/contracts";

import {
  SupplierBehaviourService,
  supplierRefusalLogFields,
} from "../supplier-behaviour.service.js";
import { SupplierHangPlacement, supplierHangHold } from "../supplier-hang.js";
import { supplierRefusal } from "../supplier-issue-refusal.js";
import { parseSupplierIssueRequest } from "../supplier-issue-request.js";
import {
  SupplierKeyClaimOutcome,
  SupplierKeyClaimService,
  SupplierProvider,
} from "../supplier-key-claim.service.js";

/** Exhaustiveness guard: the compiler routes here only if an outcome went unhandled. */
function assertNever(value: never): never {
  throw new Error(`suppliers/a: unhandled claim outcome ${JSON.stringify(value)}`);
}

@Controller("internal/suppliers/a")
export class SupplierAController {
  private readonly logger = new Logger(SupplierAController.name);

  constructor(
    private readonly keys: SupplierKeyClaimService,
    private readonly behaviour: SupplierBehaviourService,
  ) {}

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

    // ##################################################################
    // # THE INJECTED REFUSAL, AND IT IS BEFORE THE CLAIM ON PURPOSE.
    // ##################################################################
    //
    // `fail_next` is spent first, then `failure_rate` is rolled —
    // `SupplierBehaviourService.shouldRefuse` owns that order and argues for it.
    // What this line owns is the *placement*: nothing below has run, so a
    // refused call has provably claimed no key and written no ledger row. Move
    // this past `this.keys.issue(...)` and an armed refusal starts draining the
    // fifty-key pool while telling the shop it issued nothing, which breaks
    // `claimed keys = deliveries` — the one assertion this phase turns on.
    const refusal = await this.behaviour.shouldRefuse(SupplierProvider.A);

    if (refusal.refuse) {
      // The same shared builder `out_of_stock` uses below, with a different
      // reason: an injected refusal is a *reason*, not a second way of
      // answering. `422`, chosen in `../supplier-issue-refusal.ts` — a `4xx`,
      // because this is *answered, and the answer is no*, and the shop's ladder
      // is allowed to fall through to B on it. A `5xx` would read as an
      // **unknown** outcome and forbid exactly that.
      const rejected = supplierRefusal(SupplierIssueErrorReason.SupplierRejected);

      this.logger.warn({
        msg: "supplier A: injected refusal; answering 422 supplier_rejected, no key claimed",
        request_id: request.requestId,
        order_id: request.orderId,
        sku: request.sku,
        status_code: rejected.getStatus(),
        reason: SupplierIssueErrorReason.SupplierRejected,
        ...supplierRefusalLogFields(refusal),
      });

      throw rejected;
    }

    // ##################################################################
    // # THE HANG IS DECIDED HERE AND HELD LATER. THE TWO ARE NOT THE SAME
    // # EVENT.
    // ##################################################################
    //
    // Decided before the claim because `hang_next` must be spent exactly once
    // per call and because the `before_claim` placement would have nothing to
    // act on otherwise. Where the *wait* happens is carried on the decision,
    // and the hold below fires on exactly one side of the claim.
    const hang = await this.behaviour.shouldHang(SupplierProvider.A);
    const hold = supplierHangHold(this.logger, SupplierProvider.A, request, hang);

    // SCENARIO 1 — "a slow supplier is not a failed one" (`hang_before_claim:
    // true`). Nothing has been claimed while this waits, so with
    // `hang_ms < SUPPLIER_TIMEOUT_MS` the call simply completes late, and with a
    // longer one the shop times out on a request that genuinely has no answer.
    await hold(SupplierHangPlacement.BeforeClaim);

    // `SupplierProvider.A` is stated HERE, by the controller mounted at
    // `/internal/suppliers/a`, and not read out of the body: the provider is
    // the endpoint. It is what the shared ledger records in
    // `supplier_requests.provider` (migration 0002), so that once supplier B
    // exists a probe addressed to the wrong one misses rather than being
    // answered with the other's code.
    const result = await this.keys.issue(request, SupplierProvider.A);

    // ##################################################################
    // # SCENARIO 2 — THE TIMEOUT TRAP, AND THE DEFAULT. AFTER THE CLAIM
    // # TRANSACTION HAS COMMITTED, NOT INSIDE IT.
    // ##################################################################
    //
    // `this.keys.issue(...)` has returned, so `BEGIN … COMMIT` is over: on the
    // `issued` branch a key is claimed and `supplier_requests` holds its code
    // for this `request_id`, durably, before a millisecond of this wait
    // elapses. With `SUPPLIER_TIMEOUT_MS < hang_ms` the shop's
    // `AbortSignal.timeout` severs its own socket while that code sits on file
    // — the abort does not reach this handler — and the shop is left with an
    // `unknown` outcome over an answer that already exists. That is the trap,
    // and a re-probe on the same `request_id` is what springs it.
    //
    // Unconditional across outcomes, deliberately: a supplier that is slow to
    // answer is slow whatever the answer is, so an empty pool hangs before its
    // `409` in exactly the same way. That is the honest simulation, and it is
    // also the one scenario where a timeout genuinely has no key behind it.
    //
    // Moving this line above `keys.issue(...)` deletes the trap while leaving
    // every knob, every log line and every type exactly as they are — which is
    // precisely why the placement is stated in a comment this size.
    await hold(SupplierHangPlacement.AfterClaim);

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

      case SupplierKeyClaimOutcome.OutOfStock: {
        // Built by `../supplier-issue-refusal.ts`, which both stubs share: the
        // body is the contract's two fields and nothing else, and the status is
        // a `4xx` — *answered, and the answer is no* — chosen there, once, with
        // the argument for why the `5xx` family is inadmissible. `409` for an
        // empty pool; this file's header explains that choice at length.
        //
        // The *genuine* refusal, as opposed to the injected one above, and the
        // two must stay distinguishable: `out_of_stock` sends the order to a
        // status a restock fixes, `supplier_rejected` to one a retry fixes. The
        // same call builds both, because a refusal is a reason rather than a
        // second way of answering.
        const outOfStock = supplierRefusal(SupplierIssueErrorReason.OutOfStock);

        this.logger.warn({
          msg: "supplier A: pool empty; answering 409 out_of_stock",
          request_id: request.requestId,
          order_id: request.orderId,
          sku: request.sku,
          // Read back off the exception being thrown rather than restated, so
          // the line cannot claim a status the response did not carry.
          status_code: outOfStock.getStatus(),
          reason: SupplierIssueErrorReason.OutOfStock,
        });

        throw outOfStock;
      }

      default:
        return assertNever(result);
    }
  }
}
