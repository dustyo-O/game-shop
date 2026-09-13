/**
 * **One stuck order, pushed back through issuance by a person** (spec 003
 * functional spec §2.5, technical-considerations §8).
 *
 * Paired with `./order-recovery.controller.ts` exactly as
 * `./undelivered-orders.service.ts` is: the controller owns the route, the
 * guard, the status codes and the log line; this file owns the call into
 * issuance, the one read-back it needs and the mapping onto the wire.
 *
 * ###########################################################################
 * # THERE IS NO ADMIN-ONLY PATH INTO ISSUANCE. THIS FILE IS DELIBERATELY
 * # ALMOST EMPTY, AND THAT IS THE DESIGN'S LOAD-BEARING SIMPLIFICATION.
 * ###########################################################################
 *
 * The whole of the retry is one line:
 *
 *     await this.runner.runForOrder(orderId, IssuanceEntry.Operator)
 *
 * — the **identical** claim under the identical row lock, the identical ladder
 * walk, the identical settlement the automatic path takes
 * (`../issuance/issuance-runner.service.ts`). `IssuanceModule` exports the
 * runner and nothing else, so a second implementation — a lock taken here, a
 * supplier called here, a status written here — cannot be assembled from this
 * module's injector even by someone trying.
 *
 * That is what makes §2.5's guarantees free. *Pressing twice changes nothing*,
 * *two operators on two machines get one key*, *a retry racing the automatic
 * drain is safe*: none of those is defended by code in this file, because they
 * are defended by the order row lock (I4), the status-guarded UPDATE (I9),
 * `supplier_requests_pkey` (I5), `supplier_keys` claimed under
 * `FOR UPDATE SKIP LOCKED` (I6) and `deliveries_order_id_key` (I3) — every one
 * of which Phase 2 and slice 3 already proved, on this same code. Anything
 * clever here would be a new mechanism needing new proof.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE `409` IS, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * {@link OrderRetryOutcome.NotStuck} is produced **only** by
 * {@link IssuanceRunOutcome.NotClaimable}, which the runner returns when every
 * transition in the operator's entry row matched **zero rows**: `retryIssuance`
 * (`from` `out_of_stock, delivery_failed`) and then `resumeIssuance` (`from`
 * `delivering`). Nothing in this file, and nothing in the runner, reads
 * `orders.status` and decides. The `WHERE … status = ANY($3)` is the decision,
 * evaluated by Postgres against the row at the instant it is written.
 *
 * So a `409` is never a guess about what the operator will find when the list
 * refreshes; it is a fact about a write that did not happen. And it is
 * emphatically not `still_out_of_stock`, which is a `200`: that retry ran, asked
 * every supplier, and found the shelf empty.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";

import type { OrderStatus } from "@game-shop/contracts";
import { orders, type DatabaseClient } from "@game-shop/db";

import { DATABASE_CLIENT } from "../database/database.module.js";
import type { IssuanceRefusal } from "../issuance/issuance-ladder.js";
import {
  IssuanceEntry,
  IssuanceOutcome,
  IssuanceRunOutcome,
  IssuanceRunnerService,
  type IssuanceResult,
} from "../issuance/issuance-runner.service.js";
import { OrderRetryOutcome, type OrderRetryReport } from "./order-retry.types.js";

/**
 * The three answers the endpoint has, before any of them is an HTTP status.
 *
 * A discriminated union rather than a report-or-throw, so the mapping onto
 * `200` / `409` / `404` lives in the controller with the rest of the HTTP and
 * this file has no opinion about wire protocols. The compiler makes the
 * controller handle all three.
 */
export const OrderRetryResultOutcome = {
  /** The retry ran. `report` is §8's `200` body. */
  Ran: "ran",

  /**
   * **This order is not stuck.** Every guarded UPDATE matched zero rows, so
   * nothing ran: no supplier was called, no key was claimed, no status moved.
   * The controller answers `409`.
   */
  NotStuck: "not_stuck",

  /**
   * No order with that id. Distinct from {@link OrderRetryResultOutcome.NotStuck}
   * because the two are different news for the operator: one is a stale list,
   * the other is a wrong id. The controller answers `404`.
   */
  OrderNotFound: "order_not_found",
} as const;

export type OrderRetryResultOutcome =
  (typeof OrderRetryResultOutcome)[keyof typeof OrderRetryResultOutcome];

export type OrderRetryResult =
  | {
      readonly outcome: typeof OrderRetryResultOutcome.Ran;
      readonly report: OrderRetryReport;
    }
  | {
      readonly outcome: typeof OrderRetryResultOutcome.NotStuck;
      readonly orderId: string;
      /**
       * The row as the claim's own follow-up read saw it. **Advisory** — for the
       * log line, never for a second decision. The load-bearing fact is that
       * zero rows were matched, and that is true forever.
       */
      readonly observedStatus: OrderStatus;
    }
  | {
      readonly outcome: typeof OrderRetryResultOutcome.OrderNotFound;
      readonly orderId: string;
    };

/** Exhaustiveness guard: the compiler routes here only if a case went unhandled. */
function assertNever(value: never): never {
  throw new Error(`order retry: unhandled value ${JSON.stringify(value)}`);
}

/**
 * Every definite refusal on file as one operator-facing sentence.
 *
 * `reason ?? "failed"` is the one-character bug §9.3 names — it collapses *we
 * never found out* into *the supplier said no* on the one screen where a person
 * reads that record. A refusal with no recorded reason says so in those words
 * instead. (A refusal reaching this function is by definition **definite**;
 * silence never produces an {@link IssuanceRefusal} at all, which is why the
 * unknown case is handled a level up, on its own outcome.)
 */
function describeRefusals(refusals: readonly IssuanceRefusal[]): string {
  if (refusals.length === 0) return "every supplier refused, and no reason was recorded";

  return refusals
    .map((refusal) => `${refusal.provider}: ${refusal.reason ?? "refused with no recorded reason"}`)
    .join("; ");
}

@Injectable()
export class OrderRetryService {
  private readonly logger = new Logger(OrderRetryService.name);

  constructor(
    private readonly runner: IssuanceRunnerService,
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
  ) {}

  /**
   * Claim this order as the operator and walk it to a resting state.
   *
   * Reports the outcome **synchronously** rather than answering `202` with a
   * promise to get on with it (A8): issuance measures 25–65 ms locally, and the
   * operator pressed the button in order to find out what happened. The one
   * thing that makes the wait unbounded is a supplier that will not answer, and
   * that is bounded by `SUPPLIER_TIMEOUT_MS` × the probe budget — the number
   * `IssuanceRunnerService` logs at boot (R5).
   */
  async retry(orderId: string): Promise<OrderRetryResult> {
    // ####################################################################
    // # THE WHOLE RETRY. Claim under the lock, walk the ladder, settle —
    // # the same call, the same code, as the payment event's own path.
    // ####################################################################
    const run = await this.runner.runForOrder(orderId, IssuanceEntry.Operator);

    switch (run.outcome) {
      case IssuanceRunOutcome.OrderNotFound:
        return { outcome: OrderRetryResultOutcome.OrderNotFound, orderId };

      case IssuanceRunOutcome.NotClaimable:
        // ZERO ROWS FROM EVERY GUARDED UPDATE. Not an error, and not a status
        // anybody read: see this file's header.
        return {
          outcome: OrderRetryResultOutcome.NotStuck,
          orderId,
          observedStatus: run.observed.status,
        };

      case IssuanceRunOutcome.Ran:
        return {
          outcome: OrderRetryResultOutcome.Ran,
          report: this.toReport(orderId, run.result, await this.readStatus(orderId, run.claimed.status)),
        };

      default:
        return assertNever(run);
    }
  }

  /**
   * Where the order stands now — one `SELECT`, after the walk, holding no lock.
   *
   * Emitted SQL (per the project's raw-SQL rule, `architecture.md` §2):
   *
   *   select "id", "client_request_id", "sku", "amount_minor", "currency",
   *          "status", "created_at", "updated_at"
   *   from "orders" where "orders"."id" = $1;
   *
   * ### Why a read at all, when the outcome nearly tells us
   *
   * Four of the five issuance outcomes settled the order themselves, under the
   * lock, one statement earlier — so a table mapping outcome → status would be
   * right four times out of five. The fifth, {@link IssuanceOutcome.Unresolved},
   * means *nothing was concluded*, and there is no honest constant to write for
   * it. Rather than keep two mappings — a real one and an "unknown" — the
   * endpoint reports a status the database actually held.
   *
   * It is **advisory** and the type says nothing to the contrary: no lock is
   * held, so another process may move the order between the walk and this read.
   * That is fine for what it is for. The operator's list is the authority, the
   * consumer re-fetches it after every retry, and nothing in the shop branches
   * on this field.
   *
   * ### The fallback is unreachable and is still not an exception
   *
   * Nothing in this system deletes an order, and the runner has already claimed
   * this one — so the row exists. If it somehow does not, the claim's own row
   * (`delivering`) is reported and the discrepancy is logged at `error`.
   * Throwing would answer `5xx`, and a `5xx` on this endpoint reads to the
   * operator as *"the retry may or may not have run"*
   * (`apps/web/src/features/retry-order-delivery/api/retry-order-api.ts`) — which
   * would be a lie: it ran, it finished, and only the postscript is missing.
   */
  private async readStatus(orderId: string, claimedStatus: OrderStatus): Promise<OrderStatus> {
    const [row] = await this.database.db.select().from(orders).where(eq(orders.id, orderId));

    if (row === undefined) {
      this.logger.error({
        msg: "admin retry: the order vanished between the ladder walk and the status read-back",
        order_id: orderId,
        status: claimedStatus,
      });

      return claimedStatus;
    }

    return row.status;
  }

  /**
   * The runner's result, as §8's report.
   *
   * A `switch` with `assertNever` under it, so a sixth issuance outcome stops
   * the build here rather than reaching an operator as a word their screen
   * cannot parse. The two that matter most:
   *
   *   - {@link IssuanceOutcome.OutOfStock} becomes `still_out_of_stock`, a
   *     `200`. The retry ran, every supplier was asked, the shelf is empty.
   *   - {@link IssuanceOutcome.NeverEstablished} becomes `unresolved` **with
   *     `outstanding_request_id` set**, and its detail says a key may exist.
   *     Collapsing it into `delivery_failed` would report *we never found out*
   *     as *the supplier refused* — §2.2's fourth criterion, on the one screen
   *     where a person reads that record.
   */
  private toReport(orderId: string, result: IssuanceResult, status: OrderStatus): OrderRetryReport {
    switch (result.outcome) {
      case IssuanceOutcome.Delivered:
        // `result.code` is in scope here and is deliberately not read. §8: the
        // report carries no delivered key, ever.
        return {
          outcome: OrderRetryOutcome.Delivered,
          order_id: orderId,
          status,
          provider: result.provider,
          request_id: result.requestId,
          outstanding_request_id: null,
          detail: `supplier ${result.provider} issued a key for this order`,
          delivered: true,
        };

      case IssuanceOutcome.OutOfStock:
        return {
          outcome: OrderRetryOutcome.StillOutOfStock,
          order_id: orderId,
          status,
          provider: lastRefusalProvider(result.refusals),
          request_id: result.requestId,
          outstanding_request_id: null,
          detail: `every supplier was asked and has nothing to issue (${describeRefusals(result.refusals)})`,
          delivered: false,
        };

      case IssuanceOutcome.DeliveryFailed:
        return {
          outcome: OrderRetryOutcome.DeliveryFailed,
          order_id: orderId,
          status,
          provider: lastRefusalProvider(result.refusals),
          request_id: result.requestId,
          outstanding_request_id: null,
          detail: `every supplier refused (${describeRefusals(result.refusals)})`,
          delivered: false,
        };

      case IssuanceOutcome.NeverEstablished:
        return {
          outcome: OrderRetryOutcome.Unresolved,
          order_id: orderId,
          status,
          provider: result.provider,
          request_id: result.requestId,
          // The field that makes "never established" readable without opening
          // psql, and the only thing that can still find out what happened.
          outstanding_request_id: result.requestId,
          detail:
            `supplier ${result.provider} did not answer within the timeout, after ` +
            `${String(result.probeCount)} ask(s) of the same request id. A key MAY have been ` +
            `issued for it — retrying asks that same supplier the same question again, which ` +
            `is the only way to find out.`,
          delivered: false,
        };

      case IssuanceOutcome.Unresolved:
        return {
          outcome: OrderRetryOutcome.Unresolved,
          order_id: orderId,
          status,
          provider: null,
          request_id: result.requestId,
          outstanding_request_id: null,
          detail: result.detail,
          delivered: false,
        };

      default:
        return assertNever(result);
    }
  }
}

/**
 * The supplier that refused last — the one the final `request_id` belongs to.
 *
 * Refusals are recorded oldest first, so the last element is the last rung
 * walked. `null` when the list is empty, which the type already allows and no
 * caller has to special-case.
 */
function lastRefusalProvider(refusals: readonly IssuanceRefusal[]): string | null {
  return refusals.at(-1)?.provider ?? null;
}
