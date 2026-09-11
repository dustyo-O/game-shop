/**
 * `POST /internal/suppliers/b/issue` — supplier B's key issuance endpoint
 * (technical-considerations §7; spec 003 §2.1).
 *
 * ---------------------------------------------------------------------------
 * THE BACKUP SUPPLIER, AND IT IS A SECOND SERVICE, NOT A SECOND MODE OF A
 * ---------------------------------------------------------------------------
 * Everything `../a/supplier-a.controller.ts` says applies here word for word and
 * is not repeated: why the path has no `/api` on it, why `issued` and
 * `already_issued` are indistinguishable from outside, why an empty pool is a
 * `409` and never a `5xx`, and why the status code is a hint while the *body* is
 * the discriminator. Read that file; this one is the same endpoint with a
 * different address and a different identity.
 *
 * The shop reaches it through `SUPPLIER_B_URL` — a second validated address
 * (`../../config/supplier-config.ts`), never through this container. Nothing
 * routes here yet: the fall-through that will call it is the retry ladder, and
 * until that exists this endpoint answers only a request made by hand. That is
 * deliberate — the stub is built and provably working before the policy that
 * depends on it.
 *
 * ---------------------------------------------------------------------------
 * ONE POOL, ONE LEDGER — AND THE CONSEQUENCE A REVIEWER WILL SEE
 * ---------------------------------------------------------------------------
 * A and B share `supplier_keys` and `supplier_requests` (A4, and §3's rejected
 * *"split the pool per supplier"*). `supplier_keys` has no provider column and
 * `supplier_requests` is keyed on `request_id`, so B draws from exactly A's
 * inventory through exactly A's {@link SupplierKeyClaimService}.
 *
 * **Therefore an empty pool is refused by A *and* by B, and an out-of-stock
 * order costs one wasted fall-through call before it settles.** Two attempt
 * rows, not one: `a/1 failed` then `b/2 failed`. That is expected behaviour, not
 * a misfiring rule (R12) — slice 2's verification asserts exactly two attempt
 * rows for that case, and this comment is why that number is correct.
 *
 * It is one call, not fifty, and the alternative is worse: the shop would have
 * to know its two suppliers share inventory, which is precisely the boundary
 * violation the whole design spends its effort avoiding. A real shop cannot know
 * that either, so neither does this one.
 *
 * ---------------------------------------------------------------------------
 * B IS AS MISBEHAVABLE AS A, AND THAT IS NOT SYMMETRY FOR ITS OWN SAKE
 * ---------------------------------------------------------------------------
 * This stub reads its own `supplier_behaviour` row through the same
 * {@link SupplierBehaviourService.shouldRefuse} A's does — `fail_next`, then
 * `failure_rate`, **before the key claim**, answering `supplier_rejected`. A
 * backup that could not be made to refuse would leave §2.1's last rung
 * undemonstrable: *both* suppliers refusing is what the ladder has to settle an
 * order on, and a check cannot arrange it against a backup with no knobs wired.
 *
 * The **hang** knobs are live here exactly as they are in A, with the same
 * placement and the same default: the wait is decided before the claim and held
 * *after* it commits unless `hang_before_claim` says otherwise
 * (`../supplier-hang.ts`). That symmetry is not decoration either — `probe`
 * versus `fallThrough` is a decision about an outstanding request, and a check
 * that can only make the *primary* go quiet cannot stage the case where the
 * backup is the silent one.
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
  throw new Error(`suppliers/b: unhandled claim outcome ${JSON.stringify(value)}`);
}

@Controller("internal/suppliers/b")
export class SupplierBController {
  private readonly logger = new Logger(SupplierBController.name);

  constructor(
    private readonly keys: SupplierKeyClaimService,
    private readonly behaviour: SupplierBehaviourService,
  ) {}

  /**
   * Issue a key for this `request_id` — or the one it was already issued.
   *
   * `200`, not Nest's default `201`, for the reason A's controller gives: a
   * repeat of an answered `request_id` creates nothing, and an endpoint whose
   * promise is that the caller cannot tell first sight from a repeat must not
   * announce the difference in its status line.
   *
   * I5 holds here exactly as it does for A, and it is the *same* mechanism
   * rather than a second copy of it — `supplier_requests` is one table and this
   * controller reaches it through the one {@link SupplierKeyClaimService}.
   */
  @Post("issue")
  @HttpCode(HttpStatus.OK)
  async issue(@Body() body: unknown): Promise<SupplierIssueOkResponse> {
    const request = parseSupplierIssueRequest(body);

    // ##################################################################
    // # THE INJECTED REFUSAL, BEFORE THE CLAIM — A'S REASONING VERBATIM.
    // ##################################################################
    //
    // `../a/supplier-a.controller.ts` argues the placement in full and it is
    // not repeated: nothing below has run, so a refused call has provably
    // claimed no key. B refusing is how a check reaches §2.1's last rung, where
    // both suppliers say no and the order settles rather than looping.
    const refusal = await this.behaviour.shouldRefuse(SupplierProvider.B);

    if (refusal.refuse) {
      const rejected = supplierRefusal(SupplierIssueErrorReason.SupplierRejected);

      this.logger.warn({
        msg: "supplier B: injected refusal; answering 422 supplier_rejected, no key claimed",
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
    // # THE INJECTED HANG — A'S PLACEMENT, VERBATIM AND ON PURPOSE.
    // ##################################################################
    //
    // Decided before the claim, held on the side `hang_before_claim` names,
    // defaulting to *after* it commits. `../a/supplier-a.controller.ts` argues
    // both holds in full and it is not repeated here; what matters is that the
    // two stubs place the wait identically, because a backup whose silence
    // arrived at a different point in its own handler would make the `probe`
    // rung mean one thing against A and another against B.
    const hang = await this.behaviour.shouldHang(SupplierProvider.B);
    const hold = supplierHangHold(this.logger, SupplierProvider.B, request, hang);

    // Scenario 1 — "a slow supplier is not a failed one". Nothing claimed yet.
    await hold(SupplierHangPlacement.BeforeClaim);

    // `SupplierProvider.B` is stated HERE, by the controller mounted at
    // `/internal/suppliers/b`, and not read out of the body: the provider is
    // the endpoint. It is what the shared ledger records in
    // `supplier_requests.provider` (migration 0002), so a probe addressed to
    // the wrong supplier misses — `WHERE request_id = $1 AND provider = $2`
    // returns no rows — rather than being answered with the other's code.
    const result = await this.keys.issue(request, SupplierProvider.B);

    // Scenario 2 — the timeout trap, and the default. After the claim
    // transaction has committed: a code is on file for this `request_id` before
    // this wait starts, so a client that gives up mid-wait cannot know that its
    // key exists. Never inside the transaction — `max: 1` means a wait in there
    // stalls every other request in this process.
    await hold(SupplierHangPlacement.AfterClaim);

    switch (result.outcome) {
      case SupplierKeyClaimOutcome.Issued:
      case SupplierKeyClaimOutcome.AlreadyIssued:
        this.logger.log({
          msg: "supplier B: answering 200 with a code",
          request_id: request.requestId,
          order_id: request.orderId,
          sku: request.sku,
          code: result.code,
        });

        return {
          status: SupplierIssueStatus.Ok,
          request_id: request.requestId,
          code: result.code,
        };

      case SupplierKeyClaimOutcome.OutOfStock: {
        // The second refusal of a genuinely empty pool — see the header. The
        // shop asked A, was told no, and asked the backup, which draws from the
        // same fifty keys and says no for the same reason. One wasted call, and
        // the order settles `out_of_stock` immediately after it.
        //
        // The same `supplierRefusal` A calls, and that sharing is the point: a
        // backup whose refusal arrived in a different HTTP family would be read
        // as *unknown* rather than *definite*, and the ladder would be forbidden
        // from settling an order it has a definite answer about.
        const outOfStock = supplierRefusal(SupplierIssueErrorReason.OutOfStock);

        this.logger.warn({
          msg: "supplier B: pool empty; answering 409 out_of_stock",
          request_id: request.requestId,
          order_id: request.orderId,
          sku: request.sku,
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
