/**
 * The local implementation: run the work, **remember it**, and refuse to finish
 * shutting down until it settles or the bound expires.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LOCAL ONE IS THE STRICT ONE
 * ---------------------------------------------------------------------------
 * That looks backwards — production should be the careful one — and it is
 * exactly the trade technical-considerations §3 records:
 *
 *   > One interface, two implementations, and the local one is the strict
 *   > version (tracked and awaited). Phase 6 exercises the deployed path; the
 *   > drains make the continuation an optimisation rather than a dependency.
 *
 * The asymmetry is not a preference, it is a difference in what each
 * environment *can* promise. On Vercel the process is not ours: the platform
 * decides when the instance freezes, `waitUntil` is the only way to ask it to
 * wait, and there is no `SIGTERM` we could hook if we wanted to. Locally the
 * process *is* ours, `SIGTERM` is delivered to it, and Nest already turns that
 * into `onModuleDestroy` (`main.ts`, `enableShutdownHooks`). Taking the
 * guarantee that is available is free; pretending the other one exists is not.
 *
 * ---------------------------------------------------------------------------
 * WHAT "TRACKED" BUYS THAT `void this.process(event)` DOES NOT
 * ---------------------------------------------------------------------------
 * Three things, and only the first is the one people expect:
 *
 *   1. In-flight work is **finished** rather than killed, so a deploy in the
 *      middle of an issuance does not leave an order in `delivering` with a
 *      supplier call whose answer nobody read.
 *   2. Work that could *not* be finished is **named** — `order_id`, `event_id`
 *      and all — in a single `error` line, so "we lost some continuations at
 *      14:03" is a fact in the log instead of an inference from a pending row.
 *   3. Rejections are caught ({@link guardContinuation}), so one failing
 *      continuation cannot terminate a process that is serving other requests.
 */
import { Logger, type OnModuleDestroy } from "@nestjs/common";

import {
  describeContinuation,
  guardContinuation,
  type ContinuationContext,
  type ContinuationScheduler,
} from "./continuation-scheduler.js";

/**
 * How long shutdown waits for in-flight continuations before giving up and
 * saying so.
 *
 * ###########################################################################
 * # A SHUTDOWN THAT HANGS FOREVER IS WORSE THAN ONE THAT GIVES UP LOUDLY.
 * ###########################################################################
 *
 * An unbounded `await Promise.all(inFlight)` is the obvious code and it is a
 * trap: one continuation stuck on a socket that never closes turns every
 * `Ctrl-C` into a `Ctrl-C` followed by `kill -9`, and every deploy into a wait
 * for the orchestrator's own patience to run out — at which point the work is
 * killed anyway, only later and with no log line. The bound converts "hangs
 * indefinitely, then dies silently" into "waits a fixed time, then reports what
 * it abandoned".
 *
 * **Five seconds**, chosen against the two neighbours it has to sit between:
 *
 *   - *Above the longest continuation this shop can legitimately produce.* The
 *     slowest is a payment continuation that runs a full issuance: a handful of
 *     guarded UPDATEs either side of one supplier call, and that call is itself
 *     bounded by `SUPPLIER_TIMEOUT_MS` (2000 ms locally — `.env.example`, and
 *     the middle term of the ordered chain in `../config/supplier-config.ts`).
 *     Two seconds of supplier plus statements against a local pool leaves well
 *     over half the budget spare, so a *healthy* continuation is never
 *     abandoned. If `SUPPLIER_TIMEOUT_MS` is ever raised past ~4 s, this
 *     constant is the thing that has to move with it.
 *   - *Below the shortest grace period anything gives us before `SIGKILL`.*
 *     `docker stop` sends `SIGTERM` and kills 10 s later by default; that is
 *     the tightest supervisor in this project's local stack
 *     (`docker-compose.yml`). Exceeding it would mean the process is killed
 *     mid-drain and the give-up line — the entire point of the bound — never
 *     prints.
 *
 * A constant rather than an environment variable, deliberately. `../config/`
 * exists for values that name something *outside* the process and have no right
 * default in both environments (`../config/env.ts`); this names something
 * inside it, has a right default, and is only meaningful in the environment
 * where this implementation is selected at all. A knob here would be a knob
 * that only ever gets turned to work around a continuation that should have
 * been made faster.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;

/**
 * The local {@link ContinuationScheduler}: tracked, awaited on shutdown,
 * bounded.
 *
 * Registered through a factory in `./scheduling.module.ts` rather than as a
 * bare class provider, so that exactly **one** provider wrapper holds this
 * instance. Nest's destroy hook walks every non-alias provider of a module and
 * calls `onModuleDestroy` on each instance it finds
 * (`@nestjs/core/hooks/on-module-destroy.hook.js`); registering the class *and*
 * aliasing a token to it would present the same object twice and drain twice.
 */
export class TrackedContinuationScheduler implements ContinuationScheduler, OnModuleDestroy {
  private readonly logger = new Logger(TrackedContinuationScheduler.name);

  /**
   * Every continuation that has been started and has not yet settled, keyed by
   * the promise so the value can be logged when it is abandoned.
   *
   * A `Map` rather than a counter, and this is the detail that makes the
   * give-up line worth having: a count tells an operator that three
   * continuations were lost, which is not actionable. The contexts tell them
   * *which orders*, which is.
   *
   * Every promise in here is a {@link guardContinuation} result and therefore
   * can never reject — the `Promise.all` below relies on it.
   */
  private readonly inFlight = new Map<Promise<void>, ContinuationContext>();

  /** Set once {@link onModuleDestroy} has begun. See {@link schedule}. */
  private isShuttingDown = false;

  schedule(work: () => Promise<void>, context: ContinuationContext): void {
    // Start it, then track it. The order is not a race: `guardContinuation` is
    // an async function, so calling it runs `work()` only as far as its first
    // `await` and hands back a pending promise; nothing can settle before this
    // method returns, because settling takes a microtask and this is
    // synchronous code.
    const settled = guardContinuation(work, context, this.logger);

    if (this.isShuttingDown) {
      // Scheduling into a closing application. Nothing here can make the work
      // safe — the drain below has already snapshotted its list — so the honest
      // move is to run it anyway (it may well finish; the process is still
      // alive) and say loudly that it is unprotected. Silently tracking it
      // would be worse: it would join a `Map` nobody is going to await.
      this.logger.warn({
        msg: "continuation scheduled during shutdown; it is running unprotected and may be lost",
        ...describeContinuation(context),
      });

      return;
    }

    this.inFlight.set(settled, context);

    // `settled` never rejects, and this callback cannot throw, so the derived
    // promise this creates never rejects either — `void` on it is safe rather
    // than the usual smell.
    void settled.then(() => {
      this.inFlight.delete(settled);
    });
  }

  /**
   * Wait for in-flight continuations, for at most
   * {@link SHUTDOWN_DRAIN_TIMEOUT_MS}.
   *
   * Reached on `SIGTERM`/`SIGINT` because `main.ts` calls
   * `app.enableShutdownHooks()` — the same mechanism that makes
   * `DatabaseModule`'s pool drain more than dead code.
   *
   * ### This must run before the database pool closes, and it does
   *
   * A continuation is almost always mid-query, so draining the pool first would
   * turn every in-flight continuation into a failure at the exact moment this
   * hook exists to let them succeed. Nest destroys modules in **ascending**
   * distance from the root — `callDestroyHook` sorts descending and then
   * reverses (`@nestjs/core/nest-application-context.js`) — so shallow modules
   * are destroyed first and the deepest last. Measured on this graph:
   *
   *     AppModule=1  SchedulingModule=2  DatabaseModule=3
   *
   * `SchedulingModule` at 2 is drained before `DatabaseModule` at 3 closes the
   * pool. Neither number is a coincidence, and both rules are worth knowing
   * before moving an `imports` line:
   *
   *   - `DatabaseModule` can never be shallower than 3, because nothing imports
   *     it from the root — only `catalog`, `orders`, `payments`, `issuance` and
   *     `suppliers/a` do, and each of those is itself at 2.
   *   - `SchedulingModule` is pinned at 2 by `AppModule` importing it directly.
   *     Nest's `TopologyTree` re-parents an already-seen module only when it is
   *     re-encountered from a **strictly deeper** parent, so a second import
   *     from any module at distance 2 leaves it at 2 — verified for the next
   *     task's `PaymentsModule` import, which does not move it.
   *
   * The trap that would invert this: importing `SchedulingModule` from a module
   * at distance 3 or more (`IssuanceModule`, say) re-parents it to 4, behind
   * `DatabaseModule`, and every continuation that is still mid-query at
   * shutdown then fails against a drained pool. It fails *loudly* — each one
   * logs through {@link guardContinuation} and its event stays pending for a
   * later drain — but the shutdown guarantee this class exists for is gone. Add
   * `SchedulingModule` to a module's `imports` only where that module is
   * imported by `AppModule` itself.
   */
  async onModuleDestroy(): Promise<void> {
    this.isShuttingDown = true;

    if (this.inFlight.size === 0) {
      return;
    }

    // Snapshotted before the wait. A continuation that schedules another one is
    // out of scope here on purpose — the drain waits for the work it can see,
    // and the `isShuttingDown` branch above tells the truth about the rest.
    const pending = [...this.inFlight.keys()];

    this.logger.log({
      msg: "shutdown: waiting for in-flight continuations",
      in_flight: pending.length,
      timeout_ms: SHUTDOWN_DRAIN_TIMEOUT_MS,
    });

    const startedAt = Date.now();
    const drained = await this.awaitAllBounded(pending);

    if (drained) {
      this.logger.log({
        msg: "shutdown: all in-flight continuations finished",
        completed: pending.length,
        waited_ms: Date.now() - startedAt,
      });

      return;
    }

    // ####################################################################
    // # THE LINE THIS WHOLE CLASS EXISTS TO BE ABLE TO PRINT.
    // ####################################################################
    //
    // Whatever is still in the map was abandoned. `error`, not `warn`: it means
    // paid work stopped half-done. It is *recoverable* — the row is still in
    // `payment_events` with `processed_at` NULL and the other three triggers
    // will find it (`architecture.md` §4) — but "recoverable" is a property of
    // the inbox, not a reason to be quiet. Every abandoned continuation names
    // its order and its event, so recovery does not start with a search.
    this.logger.error({
      msg: "shutdown: gave up waiting for continuations; their work is left pending in the inbox for a later drain",
      abandoned: this.inFlight.size,
      waited_ms: Date.now() - startedAt,
      timeout_ms: SHUTDOWN_DRAIN_TIMEOUT_MS,
      continuations: [...this.inFlight.values()].map(describeContinuation),
    });
  }

  /**
   * `true` if every promise settled inside the bound, `false` if the bound won.
   *
   * The timer is **not** `unref`'d, and that is the deliberate half of this
   * function. An unref'd timer does not hold the event loop open, so a process
   * whose only remaining work was a continuation stuck on something that is
   * *not* I/O would exit before the timeout fired — skipping the give-up log,
   * which is the one thing the bound is for. It costs nothing to keep it
   * referenced: `clearTimeout` in the `finally` runs the moment the drain
   * finishes, so a clean shutdown is never delayed by a pending timer.
   */
  private async awaitAllBounded(pending: readonly Promise<void>[]): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const expiry = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, SHUTDOWN_DRAIN_TIMEOUT_MS);
    });

    try {
      // Safe against `Promise.all`'s fail-fast rejection only because every
      // member is a `guardContinuation` result, which cannot reject.
      return await Promise.race([Promise.all(pending).then(() => true), expiry]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }
}
