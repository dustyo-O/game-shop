/**
 * **The injected hang, and — the part that matters — *where* it sits.**
 *
 * Spec 003 technical-considerations §7.1; `architecture.md` §5; functional spec
 * §2.2.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN FILE, BESIDE `./supplier-issue-refusal.ts`
 * ---------------------------------------------------------------------------
 * Same reason that one is: both stubs do this, and they must not come to do it
 * differently. `supplier-issue-refusal.ts` owns the one thing a refusal *is* —
 * a `4xx` carrying a contract body — so that A and B cannot drift into
 * answering a refusal in two different HTTP families. This file owns the one
 * thing a hang *is*: a wait of a stated length, at a stated place, with a log
 * line either side of it.
 *
 * The stubs keep their own identity — each names its provider, each writes its
 * own line — exactly as they do for the refusal.
 *
 * ---------------------------------------------------------------------------
 * THE ONE DECISION THIS FILE EXISTS FOR: TWO PLACEMENTS, TWO SCENARIOS
 * ---------------------------------------------------------------------------
 * A hang has two honest places to go, they demonstrate opposite things, and a
 * single hang point cannot produce both. The duration and the placement are
 * separate knobs and **both** have to be right or the scenario does not happen:
 *
 *   | Scenario            | Placement      | Duration                        |
 *   | ------------------- | -------------- | ------------------------------- |
 *   | Slow but successful | before the claim | `hang_ms < SUPPLIER_TIMEOUT_MS` |
 *   | **The trap**        | **after the claim commits** | **`SUPPLIER_TIMEOUT_MS < hang_ms < ceiling`** |
 *
 * The first says *a slow supplier is not a failed one*: nothing is claimed
 * while the wait runs, the call then completes normally, and no timeout occurs.
 *
 * The second is what this whole phase exists to demonstrate. The key is
 * genuinely issued and the ledger holds a code for this `request_id` **before**
 * the wait starts, so when the shop's `AbortSignal.timeout` severs its own
 * socket it is giving up on an answer that already exists. It cannot know that
 * — which is precisely why a timeout is `unknown` and never `failed` — and the
 * re-probe on the same `request_id` is what finds the code (I5).
 *
 * Measured, in the task that corrected §5's inequality, and it is the whole
 * basis for putting the wait after the claim rather than before it:
 *
 *     t+213ms  CLIENT: threw TimeoutError  => classified UNKNOWN
 *     t+215ms  SERVER: socket aborted by the client
 *     t+422ms  SERVER: KEY CLAIMED AND COMMITTED -> ledger=["KEY-0001"]
 *     t+914ms  => the key exists; the client that timed out cannot know it.
 *
 * ---------------------------------------------------------------------------
 * AFTER THE CLAIM MEANS AFTER THE TRANSACTION, NOT INSIDE IT
 * ---------------------------------------------------------------------------
 * ###########################################################################
 * # NOTHING IN HERE MAY BE AWAITED WHILE A DATABASE HANDLE IS OPEN.
 * ###########################################################################
 *
 * {@link SupplierKeyClaimService.claimAndRecord} does the claim and the ledger
 * write in one `BEGIN … COMMIT`, and the pool holds **one connection per
 * instance** (`packages/db/src/client.ts`, `max: 1`). A wait placed inside that
 * transaction would hold the instance's only connection for the whole of
 * `hang_ms` — every other request in that process, including the shop's own
 * re-probe, would queue in Node before a byte reached Postgres, and the check
 * staged to observe one slow supplier would instead observe a frozen shop.
 *
 * So the hold happens in the controller, between calls: after
 * `keys.issue(...)` has returned, which is after its transaction committed. The
 * only resource held across it is the HTTP socket, and that is the point —
 * the client is being kept waiting, nothing else is.
 */
import { Logger } from "@nestjs/common";
import { setTimeout as sleep } from "node:timers/promises";

import type { SupplierKeyClaimRequest, SupplierProvider } from "./supplier-key-claim.service.js";

/**
 * Where an injected hang sits relative to the key claim.
 *
 * An `as const` object rather than a TypeScript `enum`, per the project rule.
 * Two members and no third, for the reason `packages/db/src/schema/supplier.ts`
 * gives for storing this as a boolean: the claim and its ledger write are one
 * transaction, so "before it" and "after it commits" exhaust the honest
 * choices, and the only third anybody would reach for — *inside* it — is the
 * one that must not exist.
 */
export const SupplierHangPlacement = {
  /**
   * **After the claim transaction commits — the timeout trap, and the
   * default.** A code is on file for this `request_id` before the wait starts,
   * so a client that gives up is giving up on an answer that already exists.
   */
  AfterClaim: "after_claim",

  /**
   * **Before the claim — "a slow supplier is not a failed one".** Nothing has
   * been claimed while the wait runs, so a short hang here completes normally
   * and a long one leaves the request genuinely unanswered.
   */
  BeforeClaim: "before_claim",
} as const;

export type SupplierHangPlacement =
  (typeof SupplierHangPlacement)[keyof typeof SupplierHangPlacement];

/**
 * The stored `hang_before_claim` flag as a placement.
 *
 * One function, called from the one place that reads the column
 * (`./supplier-behaviour.service.ts`), so the mapping from `false` to
 * {@link SupplierHangPlacement.AfterClaim} is written once. A second `? :`
 * somewhere else is how the default comes to mean the opposite thing in one
 * stub.
 */
export function supplierHangPlacement(hangBeforeClaim: boolean): SupplierHangPlacement {
  return hangBeforeClaim ? SupplierHangPlacement.BeforeClaim : SupplierHangPlacement.AfterClaim;
}

/**
 * Which knob decided that this call hangs.
 *
 * The hang's copy of {@link SupplierRefusalSource}, and carried for the same
 * reason: a reviewer staring at a timeout they did not expect needs to know
 * whether they spent the one-shot they armed or whether a rate somebody left
 * turned up rolled against them, and those two are fixed by two different
 * actions.
 */
export const SupplierHangSource = {
  /** The `hang_next` counter, spent by this call. Deterministic. */
  OneShot: "hang_next",
  /** The `hang_rate` probability, rolled by this call. */
  Rate: "hang_rate",
} as const;

export type SupplierHangSource = (typeof SupplierHangSource)[keyof typeof SupplierHangSource];

/**
 * Whether **this** call hangs, for how long, and where.
 *
 * A discriminated union in the shape {@link SupplierRefusalDecision} uses.
 * `hangMs` and `placement` are on both affirmative branches because a hang is
 * not a decision until all three facts are fixed, and every one of them is read
 * in the same statement that made the decision — a concurrent `PUT` landing
 * between a decision and a follow-up `SELECT` would otherwise hand this call a
 * duration or a placement nobody armed it with.
 *
 * `hang: false` is the overwhelmingly common outcome and is not an error: it is
 * what every call sees against the seeded all-zero baseline.
 */
export type SupplierHangDecision =
  | {
      readonly hang: true;
      readonly source: typeof SupplierHangSource.OneShot;
      readonly hangMs: number;
      readonly placement: SupplierHangPlacement;
      /** One-shot hangs still armed **after** this one was spent. */
      readonly remaining: number;
    }
  | {
      readonly hang: true;
      readonly source: typeof SupplierHangSource.Rate;
      readonly hangMs: number;
      readonly placement: SupplierHangPlacement;
      /** The stored rate this call rolled against. */
      readonly rate: number;
    }
  | { readonly hang: false };

/** A hang that fired, narrowed out of {@link SupplierHangDecision}. */
export type SupplierHung = Extract<SupplierHangDecision, { hang: true }>;

/**
 * The knob-specific half of a stub's hang log line, snake_case like every other
 * field in this project's log stream.
 *
 * A union rather than one interface with two optional fields, matching
 * {@link SupplierRefusalLogFields}: `hang_next_remaining` and `hang_rate`
 * describe two different decisions and neither is ever *missing* from the one
 * that produced it.
 */
export type SupplierHangLogFields =
  | {
      readonly hung_by: typeof SupplierHangSource.OneShot;
      readonly hang_next_remaining: number;
    }
  | { readonly hung_by: typeof SupplierHangSource.Rate; readonly hang_rate: number };

/** Exhaustiveness guard: the compiler routes here only if a hang source went unhandled. */
function assertNever(value: never): never {
  throw new Error(`suppliers: unhandled hang source ${JSON.stringify(value)}`);
}

/**
 * The number the hang was actually decided with, for the stub's log line.
 *
 * Read off the decision rather than fetched back from the row, for the reason
 * {@link supplierRefusalLogFields} is: a log line that misreports why a call
 * hung is worse than no log line at all.
 */
export function supplierHangLogFields(decision: SupplierHung): SupplierHangLogFields {
  switch (decision.source) {
    case SupplierHangSource.OneShot:
      return { hung_by: decision.source, hang_next_remaining: decision.remaining };

    case SupplierHangSource.Rate:
      return { hung_by: decision.source, hang_rate: decision.rate };

    default:
      return assertNever(decision);
  }
}

/** Waits when this call's hang belongs at `placement`, and does nothing otherwise. */
export type SupplierHangHold = (placement: SupplierHangPlacement) => Promise<void>;

/**
 * Bind one call's hang decision to the things its log lines need, and hand back
 * the hold both stubs call **twice** — once on each side of the key claim.
 *
 * ###########################################################################
 * # TWO CALL SITES, ONE DECISION. THAT IS THE WHOLE SHAPE.
 * ###########################################################################
 *
 * The decision is made once, before the claim, because the `before` placement
 * has to be able to act on it and because {@link SupplierBehaviourService.consumeOneShot}
 * must spend `hang_next` exactly once per call. The *placement* then selects
 * which of the two holds is the real one; the other returns immediately.
 *
 * Written as a bound hold rather than as a five-argument function called twice
 * so that the two call sites differ in exactly one word — the placement — which
 * is the fact a reader of those stubs is there to check.
 *
 * ### Why `setTimeout` from `node:timers/promises` and not a spin
 *
 * A busy loop would block the event loop and stall the instance as surely as
 * holding the database connection would: the "another request is still served
 * promptly while one hangs" property is not incidental, it is what distinguishes
 * *this supplier is slow* from *this shop is broken*. An awaited timer holds
 * nothing but the HTTP socket, which is exactly what a hanging supplier holds.
 *
 * ### Two lines, and the distance between them is the incident
 *
 * The first line says a wait started; the second says it finished and how long
 * it actually took. In the trap, the shop's `SupplierClient` gives up
 * *between* them — `supplier client: UNKNOWN outcome` lands in the same stream
 * with the same `request_id`, after `supplier: key claimed and recorded` and
 * before this hold's finishing line. That ordering, readable in one log stream,
 * is the clearest statement of what the phase is about, and it is why the
 * finishing line exists at all: a response written into a socket nobody is
 * listening for leaves no other trace.
 *
 * `warn`, not `error`, matching `SupplierClient.unknown`: a supplier being slow
 * is an ordinary event that the system has a defined response to.
 */
export function supplierHangHold(
  logger: Logger,
  provider: SupplierProvider,
  request: SupplierKeyClaimRequest,
  decision: SupplierHangDecision,
): SupplierHangHold {
  return async (placement: SupplierHangPlacement): Promise<void> => {
    if (!decision.hang || decision.placement !== placement) return;

    const label = provider.toUpperCase();
    const correlation = {
      provider,
      request_id: request.requestId,
      order_id: request.orderId,
      sku: request.sku,
      hang_ms: decision.hangMs,
      placement,
      ...supplierHangLogFields(decision),
    };

    logger.warn({
      msg:
        placement === SupplierHangPlacement.AfterClaim
          ? `supplier ${label}: injected hang AFTER the key claim committed — a code is on file for this request_id and the caller may give up before hearing it`
          : `supplier ${label}: injected hang BEFORE the key claim — nothing has been claimed while this waits`,
      ...correlation,
    });

    const startedAt = Date.now();
    await sleep(decision.hangMs);

    logger.warn({
      msg: `supplier ${label}: injected hang finished; answering into a socket that may already be closed`,
      ...correlation,
      waited_ms: Date.now() - startedAt,
    });
  };
}
