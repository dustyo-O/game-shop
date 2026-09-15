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
 * WHERE `waitUntil` COMES FROM — THE PHASE 6 SEAM, NOW CLOSED
 * ---------------------------------------------------------------------------
 * `@vercel/functions` is a dependency of `apps/api` since Phase 6, pinned
 * exact, and {@link resolveWaitUntil} returns its `waitUntil`. It was
 * deliberately *not* one before: Phase 2 wrote this class and the whole of the
 * deployment path with the import left as the single absent piece, because
 * Phase 6 owned deployment and a dependency added three phases early is one
 * that gets version-bumped by a bot before anything has ever imported it. The
 * seam outlived its closing on purpose — see {@link resolveWaitUntil} for what
 * it still separates.
 */
import { Logger } from "@nestjs/common";
import { waitUntil } from "@vercel/functions";

import {
  guardContinuation,
  type ContinuationContext,
  type ContinuationScheduler,
} from "./continuation-scheduler.js";

/**
 * The shape of `waitUntil` from `@vercel/functions`.
 *
 * This file's own alias rather than `typeof waitUntil` from the package, and
 * kept that way after the package arrived. It was first declared here so the
 * file compiled, and the class was testable, with the package not installed;
 * what keeps it now is that the constructor's contract is this file's to
 * state. The signature is the platform's, narrowed to what is actually used:
 * it accepts any promise and returns nothing. The package declares `void |
 * undefined`, which is assignable here without a cast.
 */
export type WaitUntil = (promise: Promise<unknown>) => void;

/**
 * Obtain the platform's `waitUntil`.
 *
 * ###########################################################################
 * # THE SEAM IS CLOSED: THIS RETURNS `@vercel/functions`'s `waitUntil`.
 * ###########################################################################
 *
 * Until Phase 6 this returned `undefined`. Phase 2 wrote the deployment path
 * without deploying it, so it did not install a deployment dependency: the
 * whole path was written and type-checked, and exactly one thing was absent —
 * the import. This function was the promised closing point, and the promised
 * two edits are what happened: `pnpm --filter @game-shop/api add
 * @vercel/functions` (exact pin, lockfile committed — technical-considerations
 * §2.7 and R13 of the Phase 6 spec), and the `import` above with the `return`
 * below. Nothing else changed — not the interface, not the module, not a
 * caller — which was the point of a seam over a `TODO`.
 *
 * ### The import is unconditional, and that is fine
 *
 * The `import` at the top of this file runs at module load in every process
 * that loads the scheduling module — `pnpm dev`, the harness's four instances,
 * every test — not only on Vercel. It is safe because `@vercel/functions` does
 * no platform work at import time: its `waitUntil` looks the request context
 * up on `globalThis` (`Symbol.for("@vercel/request-context")`) at *call* time,
 * and when there is no context it does nothing at all. Importing it
 * off-platform therefore cannot throw, and even calling it there would be a
 * silent no-op rather than an error — which is why the seam did not need to
 * become a dynamic import to close.
 *
 * ### What keeps local behaviour identical is the caller, not the package
 *
 * `./scheduling.module.ts` consults this function only when `VERCEL === "1"`
 * and builds `TrackedContinuationScheduler` otherwise, without ever calling
 * this. So `waitUntil` is imported everywhere, resolved only on the platform,
 * and *called* only through {@link WaitUntilContinuationScheduler}, which the
 * platform branch alone constructs. Locally, this file's import line is the
 * whole of the package's footprint.
 *
 * ### Why the return type still admits `undefined`
 *
 * `undefined` is no longer reachable from this body, and the type keeps it
 * anyway, for the reason it was chosen: it is the honest answer for a build
 * that has no `waitUntil`, and `./scheduling.module.ts` turns that answer into
 * a loud boot-time line saying the deployment is running without its
 * continuation guarantee — rather than a throw, which would refuse to boot
 * over a feature the drains already cover, or silence, which would let it ship
 * unnoticed. Narrowing the type would delete the branch that reports it.
 */
export function resolveWaitUntil(): WaitUntil | undefined {
  return waitUntil;
}

/**
 * The deployment {@link ContinuationScheduler}.
 *
 * The `waitUntil` function is a constructor argument rather than a use of the
 * module-level import, which is what keeps this class independent of where
 * its `waitUntil` came from — and, not incidentally, what lets a test hand it
 * a spy and assert that a rejecting continuation reaches the platform as a
 * *fulfilled* promise.
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
