/**
 * Work that outlives the response that started it — the interface, the token,
 * and the one rule both implementations share.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * `architecture.md` §4 makes the webhook *receive → persist → acknowledge →
 * process*, and technical-considerations §2.2 spells out the consequence: the
 * `200` goes out before the processing is done, so the processing has to be
 * scheduled rather than awaited. On Vercel that is `waitUntil` from
 * `@vercel/functions`, which tells the platform not to freeze the instance
 * while a promise is still running. Locally there is no platform to tell, so
 * the same job is done by tracking the promise and refusing to finish shutting
 * down until it settles.
 *
 * One interface, two implementations, chosen by environment
 * (`./scheduling.module.ts`). Callers see only this.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `void this.process(event)`
 * ---------------------------------------------------------------------------
 * It compiles, it passes review, and it is right about the happy path. It is
 * wrong about the two moments that matter:
 *
 *   - **`SIGTERM` mid-flight.** A deploy, a container recycle, a Ctrl-C. The
 *     continuation vanishes with the process, and — this is the part that
 *     costs — *nothing anywhere records that it did*. The event stays pending,
 *     which is recoverable by construction (that is what the inbox is for), but
 *     the shop cannot tell "nobody has started this yet" from "somebody started
 *     it and was killed". {@link ContinuationScheduler} makes the second case
 *     leave a log line naming the `order_id` and `event_id` it abandoned.
 *   - **A rejection.** A floating promise that rejects is an unhandled
 *     rejection, and Node 22's default for those is to *terminate the process*.
 *     One failed continuation would take out an instance that is mid-way
 *     through other requests. Hence {@link guardContinuation}, which both
 *     implementations route every unit of work through, and which never
 *     rethrows.
 *
 * ---------------------------------------------------------------------------
 * THIS IS AN OPTIMISATION, NOT A GUARANTEE — AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 * Nothing scheduled here is *relied* upon. `architecture.md` §4 lists four
 * processing triggers precisely so that no single one is load-bearing: this
 * continuation, a drain on order creation, a drain on the status poll, and the
 * admin sweep. A continuation that is dropped on the floor costs latency, never
 * a key — the row is still in `payment_events` with `processed_at` NULL, still
 * in the partial index, and still findable by the other three.
 *
 * That is what licenses the deployment implementation to have *no* shutdown
 * guarantee at all (`waitUntil` promises best effort and no more), and it is
 * why this file is careful to log rather than to retry.
 */
import type { Logger } from "@nestjs/common";

/**
 * Injection token for the {@link ContinuationScheduler}.
 *
 * A symbol, matching `DATABASE_CLIENT` and `SUPPLIER_A_CONFIG`, and for the
 * same reason: tokens share one flat namespace per application and a symbol
 * cannot collide with one a library picked.
 *
 *     constructor(
 *       @Inject(CONTINUATION_SCHEDULER) private readonly scheduler: ContinuationScheduler,
 *     ) {}
 */
export const CONTINUATION_SCHEDULER = Symbol("CONTINUATION_SCHEDULER");

/**
 * Who this piece of work is for, so a failure can be found afterwards.
 *
 * `architecture.md` §8 requires `order_id`, `event_id` and `request_id` on every
 * line in the payment and issuance paths. A scheduled continuation is the one
 * place those ids are *most* needed and *least* available: by the time it fails
 * the request that started it is gone, its response has been sent, and there is
 * no stack to tie the failure back to a shopper. So the ids are passed in at
 * scheduling time and held for the lifetime of the work.
 *
 * Both ids are optional because the four triggers do not all have both
 * (`architecture.md` §4): the webhook continuation has an `event_id` and an
 * `order_id`, the creation and status-poll drains have only an `order_id`, and
 * the admin sweep has neither. What is *not* optional is {@link name}, because
 * a log line that says only "a continuation failed" is barely better than
 * silence.
 */
export interface ContinuationContext {
  /**
   * What the work is, in the terms an operator reading a log would use —
   * `"payment webhook continuation"`, `"order creation drain"`. Short, stable,
   * and greppable; it is the primary key of a log search.
   */
  readonly name: string;

  /** The order this work concerns, when it concerns exactly one. */
  readonly orderId?: string;

  /** The inbox event this work is applying, when it is applying one. */
  readonly eventId?: string;
}

/**
 * Run work after the response has gone out.
 *
 * ### The return type is `void` on purpose
 *
 * There is deliberately no promise handed back, because the only thing a caller
 * could do with one is `await` it — which is exactly the inline processing this
 * whole mechanism exists to remove (`payment-webhook.controller.ts`, "Inline
 * now; asynchronous in Phase 2"). A caller cannot re-serialise the work by
 * accident if there is nothing to await. It matches `waitUntil`'s own signature
 * for the same reason.
 *
 * ### The work function must be a thunk, not a promise
 *
 * `schedule(() => this.process(event), …)` rather than
 * `schedule(this.process(event), …)`. Passing an already-started promise means
 * the work begins before the scheduler has seen it, and — worse — a rejection
 * that happens in that window is unhandled *before* {@link guardContinuation}
 * can attach a `catch`. A thunk hands the scheduler the work, not its
 * aftermath.
 *
 * ### It never throws
 *
 * Calling it is safe from inside a controller that has already decided its
 * status code. Failures inside `work` are logged (see
 * {@link guardContinuation}); failures to *schedule* are not a category that
 * exists — the local implementation adds to a `Set`, and the deployment one
 * hands the promise to the platform.
 */
export interface ContinuationScheduler {
  schedule(work: () => Promise<void>, context: ContinuationContext): void;
}

/** The correlation ids as log fields, in the snake_case the payment path uses. */
function correlationFields(context: ContinuationContext): Record<string, string> {
  const fields: Record<string, string> = {};

  if (context.orderId !== undefined) {
    fields["order_id"] = context.orderId;
  }

  if (context.eventId !== undefined) {
    fields["event_id"] = context.eventId;
  }

  return fields;
}

/**
 * Wrap one unit of scheduled work so that **it cannot reject**.
 *
 * ###########################################################################
 * # THE RETURNED PROMISE IS ALWAYS FULFILLED. BOTH IMPLEMENTATIONS DEPEND ON IT.
 * ###########################################################################
 *
 * This is the shared half of both schedulers, and it is shared rather than
 * duplicated because the two callers depend on the same non-obvious property:
 *
 *   - {@link TrackedContinuationScheduler} keeps these promises in a `Set` and
 *     `Promise.all`s them during shutdown. If one could reject, the `Promise.all`
 *     would reject, the shutdown hook would throw, and Nest's `close()` would
 *     abort part-way through — taking the *database pool drain* with it, since
 *     `DatabaseModule` is destroyed after this module.
 *   - {@link WaitUntilContinuationScheduler} hands them to Vercel's `waitUntil`,
 *     which attaches no handler of its own. A rejection there is an unhandled
 *     rejection in the function instance.
 *
 * So the `catch` is not politeness, it is the contract. Nothing is rethrown,
 * and there is nowhere for it to be rethrown *to*: the response has already
 * been sent, and this promise has no awaiting caller by design.
 *
 * ### What a failure costs, stated plainly
 *
 * Nothing, beyond latency. The work this schedules is always work some other
 * trigger can also do (`architecture.md` §4), against a row that is still
 * pending in the inbox. `error` level is right anyway: "the webhook answered
 * `200` and the order never moved" is exactly the incident that is invisible
 * without a line, and it is the same reasoning the inline `catch` in
 * `payment-webhook.controller.ts` already carries.
 */
export async function guardContinuation(
  work: () => Promise<void>,
  context: ContinuationContext,
  logger: Logger,
): Promise<void> {
  const startedAt = Date.now();

  try {
    await work();

    logger.debug({
      msg: `continuation finished: ${context.name}`,
      continuation: context.name,
      ...correlationFields(context),
      duration_ms: Date.now() - startedAt,
    });
  } catch (error: unknown) {
    logger.error({
      msg: `continuation failed: ${context.name}; the work is still pending and another trigger will retry it`,
      continuation: context.name,
      ...correlationFields(context),
      duration_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
  }
}

/** Exported for the shutdown log, so an abandoned continuation names its order. */
export function describeContinuation(context: ContinuationContext): Record<string, string> {
  return { continuation: context.name, ...correlationFields(context) };
}
