// @layer: unit
// @spec: 006-live-shop-and-the-written-answer
// @regression
/**
 * `resolveWaitUntil()` and `WaitUntilContinuationScheduler` — the Phase 6 seam
 * `apps/api/src/scheduling/wait-until-continuation-scheduler.ts`'s own header
 * calls "closed" — exercised directly: no HTTP, no Nest DI container, no
 * Vercel request context.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PINS
 * ---------------------------------------------------------------------------
 * Two claims that file's header makes, both load-bearing for the reasons it
 * gives:
 *
 *   1. `resolveWaitUntil()` now returns `@vercel/functions`'s `waitUntil` — a
 *      function — rather than the `undefined` it returned before Phase 6
 *      closed the seam. `./scheduling.module.ts` reads this while Nest builds
 *      the container to decide whether the deployment can honour its
 *      continuation guarantee at all; a regression here is a boot-time branch
 *      silently taking the wrong arm.
 *   2. `WaitUntilContinuationScheduler.schedule` hands the platform a promise
 *      that **can only ever fulfil**, even when the work it wraps rejects.
 *      `guardContinuation` (`../../src/scheduling/continuation-scheduler.ts`)
 *      is what makes that true, and its own header states why both
 *      schedulers depend on it: the platform's `waitUntil` attaches no
 *      rejection handler of its own, so a raw, unguarded promise that
 *      rejected would be an *unhandled rejection inside the function
 *      instance* — precisely the crash `../../src/vercel.ts` exists to keep
 *      one bad continuation from causing.
 *
 * ---------------------------------------------------------------------------
 * WHY A HAND-WRITTEN SPY, NOT A MOCKING LIBRARY'S
 * ---------------------------------------------------------------------------
 * `WaitUntilContinuationScheduler`'s constructor takes exactly one
 * collaborator — the `waitUntil` function itself — for the reason its own
 * header gives: independence from where that function came from, so "a test
 * can hand it a spy and assert what the platform received." A plain closure
 * that records its argument is that spy; nothing here needs `@vercel/functions`
 * to be running on a real platform, and it never has one to run on off-Vercel
 * — see `resolveWaitUntil`'s own header, "the import is unconditional, and
 * that is fine."
 *
 * ---------------------------------------------------------------------------
 * THE LOGGER IS SILENCED, NOT ASSERTED ON
 * ---------------------------------------------------------------------------
 * `guardContinuation` logs at `error` when `work` rejects, and at `debug` when
 * it resolves — deliberately, per its own header ("`error` level is right
 * anyway"). That line is real, correct behaviour, not a leak this test needs
 * to catch; letting it print during a green run only adds a stack trace to
 * output a reader would reasonably mistake for a failure. `Logger.prototype`'s
 * `error` and `debug` — both ordinary instance methods, not class fields
 * shadowing them (`@nestjs/common`'s `services/logger.service.js`) — are
 * spied and silenced per test, restored in `afterEach` so no other suite
 * inherits the mock.
 *
 * ---------------------------------------------------------------------------
 * RED VALIDATION
 * ---------------------------------------------------------------------------
 * The implementation this file tests already exists (Slice 1's first two
 * tasks), so — as `../acceptance/promo-codes.test.ts`'s header puts it for the
 * same situation — "RED" here means a temporary, targeted inversion of what a
 * test asserts, run to see it fail for the stated reason, then reverted
 * byte-identical. **No production source under `src/` was touched.**
 *
 * Inverted: "a rejecting continuation reaches the platform as a fulfilled
 * promise" — `.resolves.toBeUndefined()` became `.rejects.toBeInstanceOf(Error)`,
 * asserting the opposite of the class's own guarantee. Command and result:
 *
 *   node scripts/with-env.ts pnpm --filter @game-shop/api exec vitest run \
 *     test/unit/wait-until-continuation-scheduler.test.ts
 *   → Test Files  1 failed (1)  /  Tests  1 failed, 2 passed (3)  /  Duration  ~250ms
 *
 * The failing line, quoted verbatim:
 *
 *   AssertionError: promise resolved "undefined" instead of rejecting
 *   (vitest's own framing for `.rejects` on a promise that in fact fulfilled —
 *   the class kept its promise: the rejection never reached the platform)
 *
 * Reverted, the same command is GREEN: 3 passed, 0 failed.
 *
 * Run it: `node scripts/with-env.ts pnpm --filter @game-shop/api exec vitest
 * run test/unit/wait-until-continuation-scheduler.test.ts` — no database, no
 * spawned process, no `ADMIN_TOKEN`; the env wrapper is only what every other
 * suite in this directory is run through, for a consistent command.
 */
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  resolveWaitUntil,
  WaitUntilContinuationScheduler,
  type WaitUntil,
} from "../../src/scheduling/wait-until-continuation-scheduler.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveWaitUntil — the seam Phase 6 closed (functional spec 006, technical-considerations §2.1)", () => {
  // @regression
  it("returns a function — the platform's own waitUntil — not the undefined it returned before Phase 6", () => {
    const resolved = resolveWaitUntil();

    expect(typeof resolved, "resolveWaitUntil() must return a callable, not undefined").toBe("function");
  });
});

describe("WaitUntilContinuationScheduler.schedule — the platform never sees a rejection", () => {
  // @regression
  it("a rejecting continuation reaches the platform as a FULFILLED promise, never a rejected one", async () => {
    vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);

    let handedToPlatform: Promise<unknown> | undefined;
    const spyWaitUntil: WaitUntil = (promise) => {
      handedToPlatform = promise;
    };

    const scheduler = new WaitUntilContinuationScheduler(spyWaitUntil);
    const rejectingWork = (): Promise<void> => Promise.reject(new Error("continuation boom"));

    scheduler.schedule(rejectingWork, { name: "test continuation — rejecting" });

    expect(handedToPlatform, "schedule() must call waitUntil synchronously, with a promise").toBeDefined();
    // CAN FAIL: inverted to `.rejects.toBeInstanceOf(Error)` and re-run — see
    // this file's header, RED VALIDATION:
    //   AssertionError: promise resolved "undefined" instead of rejecting
    await expect(
      handedToPlatform,
      "the promise handed to waitUntil must fulfil even though the work it wraps rejected",
    ).resolves.toBeUndefined();
  });

  // @regression
  it("a resolving continuation also reaches the platform as a fulfilled promise — the ordinary path is unaffected", async () => {
    vi.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);

    let handedToPlatform: Promise<unknown> | undefined;
    const spyWaitUntil: WaitUntil = (promise) => {
      handedToPlatform = promise;
    };

    const scheduler = new WaitUntilContinuationScheduler(spyWaitUntil);
    const resolvingWork = (): Promise<void> => Promise.resolve();

    scheduler.schedule(resolvingWork, { name: "test continuation — resolving" });

    expect(handedToPlatform).toBeDefined();
    await expect(handedToPlatform).resolves.toBeUndefined();
  });
});
