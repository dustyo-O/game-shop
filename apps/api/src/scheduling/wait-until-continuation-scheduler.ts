/**
 * The deployment implementation: hand the promise to the platform and let it
 * decide when the instance may freeze.
 *
 * ---------------------------------------------------------------------------
 * WHY A SERVERLESS FUNCTION NEEDS TO ASK PERMISSION TO KEEP WORKING
 * ---------------------------------------------------------------------------
 * `architecture.md` §5 deploys `apps/api` as a Vercel function, and a function
 * instance is suspended once its response is written. Everything still on the
 * event loop at that moment is not cancelled — it is *paused*, possibly
 * forever, possibly resumed minutes later on a request that has nothing to do
 * with it. So `void this.process(event)` in deployment is not merely
 * unprotected the way it is locally; it is work the platform has been given no
 * reason to run at all.
 *
 * `waitUntil(promise)` is how that reason is given: the platform keeps the
 * instance alive until the promise settles. It is the direct analogue of
 * `TrackedContinuationScheduler`'s in-flight set, with the platform holding the
 * set instead of us.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES **NOT** PROMISE, AND WHY THAT IS ACCEPTABLE
 * ---------------------------------------------------------------------------
 * `waitUntil` is best-effort. There is no `SIGTERM` to hook, no shutdown hook
 * that reliably runs, and no bound we could impose that the platform would
 * honour — which is why this class has no `onModuleDestroy` and it would be
 * dishonest to give it one. Work can still be lost.
 *
 * That is survivable for the same reason stated in `./continuation-scheduler.ts`:
 * the continuation is one of four triggers and none of them is load-bearing
 * (`architecture.md` §4). A lost continuation leaves its `payment_events` row
 * pending, and the order-creation drain, the status-poll drain and the admin
 * sweep each find it. The local implementation's shutdown drain is a *better*
 * guarantee than deployment gets; the system is designed not to need it.
 *
 * ---------------------------------------------------------------------------
 * PHASE 6 SEAM — READ {@link resolveWaitUntil} BEFORE DEPLOYING
 * ---------------------------------------------------------------------------
 * This class is complete. What is not wired is where its `waitUntil` comes
 * from, because `@vercel/functions` is deliberately **not** a dependency of
 * this workspace yet — Phase 6 owns deployment, and a dependency added three
 * phases early is one that gets version-bumped by a bot before anything has
 * ever imported it. See {@link resolveWaitUntil} for the exact two-line change.
 */
import { Logger } from "@nestjs/common";

import {
  guardContinuation,
  type ContinuationContext,
  type ContinuationScheduler,
} from "./continuation-scheduler.js";

/**
 * The shape of `waitUntil` from `@vercel/functions`.
 *
 * Declared here rather than imported so that this file compiles, and this class
 * is testable, without the package being installed. The signature is the
 * platform's, narrowed to what is actually used: it accepts any promise and
 * returns nothing.
 */
export type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * Obtain the platform's `waitUntil`, or `undefined` if this build has none.
 *
 * ###########################################################################
 * # THIS IS A SEAM, NOT AN IMPLEMENTATION. IT RETURNS `undefined` TODAY.
 * ###########################################################################
 *
 * Phase 2 does not deploy, so Phase 2 does not install a deployment
 * dependency. The whole of the deployment path is therefore written and
 * type-checked, and exactly one thing is absent: the import. **Phase 6 makes it
 * live with two edits and no redesign:**
 *
 *   1. `pnpm --filter @game-shop/api add @vercel/functions`
 *   2. In this file:
 *
 *          import { waitUntil } from "@vercel/functions";
 *          …
 *          export function resolveWaitUntil(): WaitUntil | undefined {
 *            return waitUntil;
 *          }
 *
 * Nothing else changes — not the interface, not the module, not a caller.
 *
 * Returning `undefined` rather than throwing is what keeps the seam honest in
 * both directions: locally it is the *expected* answer and selection falls
 * through to the tracked implementation with no noise, while on Vercel
 * `./scheduling.module.ts` turns the same answer into a loud boot-time line
 * saying the deployment is running without its continuation guarantee. A throw
 * would refuse to boot a deployment over a feature the drains already cover;
 * silence would let it ship unnoticed. A log is the honest middle.
 */
export function resolveWaitUntil(): WaitUntil | undefined {
  return undefined;
}

/**
 * The deployment {@link ContinuationScheduler}.
 *
 * The `waitUntil` function is a constructor argument rather than a module-level
 * import, which is what makes this class independent of whether the package is
 * installed — and, not incidentally, what lets a test hand it a spy and assert
 * that a rejecting continuation reaches the platform as a *fulfilled* promise.
 */
export class WaitUntilContinuationScheduler implements ContinuationScheduler {
  private readonly logger = new Logger(WaitUntilContinuationScheduler.name);

  constructor(private readonly waitUntil: WaitUntil) {}

  schedule(work: () => Promise<void>, context: ContinuationContext): void {
    // `guardContinuation` first, `waitUntil` second — never the other way
    // round. The platform attaches no rejection handler of its own, so handing
    // it a raw `work()` promise would make any failure an unhandled rejection
    // inside the function instance. What it receives here can only ever fulfil.
    this.waitUntil(guardContinuation(work, context, this.logger));
  }
}
