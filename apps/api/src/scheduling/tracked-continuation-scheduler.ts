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
 * ###########################################################################
 * # THE TWO CONSTRAINTS NO LONGER BOTH FIT, AND THIS IS WHICH ONE GIVES.
 * ###########################################################################
 *
 * This constant has always been described as sitting *between* two neighbours:
 *
 *   1. **Above the longest continuation this shop can legitimately produce**, so
 *      a healthy one is never abandoned; and
 *   2. **below the shortest grace period anything gives us before `SIGKILL`**,
 *      so the give-up line — the entire point of the bound — actually prints.
 *
 * Spec 003 slice 3 made those two mutually exclusive. The ladder now walks to a
 * resting state inside **one** invocation (technical-considerations §1.4, A2),
 * so the longest legitimate continuation is no longer one supplier call, it is
 * the whole budget the API logs at boot:
 *
 *     SUPPLIER_MAX_PROBES_PER_REQUEST × SUPPLIER_TIMEOUT_MS × |supplierLadder|
 *         = 3 × 2000 × 2 = 12 000 ms          (measured at boot: worst_case_ms: 12000)
 *
 * and even the *ordinary* exhausted path — one supplier silent through all three
 * asks — measures **6102 ms**, which is already past where this bound used to
 * sit. Constraint 1 now asks for something north of 12 s. Constraint 2 caps us
 * at 5 s (below). There is no number that satisfies both.
 *
 * **Constraint 1 gives.** Not because the walk does not matter, but because the
 * two failures are not comparable:
 *
 *   - Breaking constraint 1 — cutting a walk mid-flight — is **recoverable and
 *     loud**. `issuance_attempts.status` is written `unknown` *before* the
 *     supplier call, so no `catch` has to run for the row to stay truthful; the
 *     order stays `delivering`; `payment_events.processed_at` stays NULL, which
 *     is what keeps the other three triggers (`architecture.md` §4) able to find
 *     it; and the abandoned continuation is named — `order_id`, `event_id` — in
 *     the `error` line below. Slice 4's operator recovery list surfaces exactly
 *     that shape. §1.4 already accepts this outcome for the platform ceiling;
 *     accepting it for a shutdown costs nothing new.
 *   - Breaking constraint 2 is **silent**. `SIGKILL` mid-drain means no give-up
 *     line, no pool drain, and an operator who learns nothing at all. A bound
 *     whose one product is that line must never be the thing that loses the race
 *     to print it.
 *
 * A bound that chased the 12 s walk would also make every `Ctrl-C` on the dev
 * server wait up to twelve seconds for work whose loss costs *promptness* and
 * nothing else.
 *
 * ---------------------------------------------------------------------------
 * THREE SECONDS, AND WHICH SUPERVISOR THAT IS UNDER
 * ---------------------------------------------------------------------------
 * The grace period this has to fit inside was stated wrongly here until now, as
 * *"`docker stop` … kills 10 s later; that is the tightest supervisor in this
 * project's local stack (`docker-compose.yml`)."* It is not: Compose runs **only
 * Postgres** (see that file's header — "Only the database is containerised"), so
 * `docker stop` never signals a process that selects this implementation at all.
 * The supervisors that really exist are:
 *
 * | Who sends `SIGTERM`                                     | `SIGKILL` after |
 * | ------------------------------------------------------- | --------------- |
 * | `../../test/concurrency/support/api-instance.ts`, `stopApiInstance` | **5 000 ms** |
 * | `scripts/race/run-checks.ts` (via the same helper)       | 5 000 ms        |
 * | An interactive `Ctrl-C` on `pnpm dev`                    | never           |
 *
 * **5 000 ms is the real ceiling, and the old value was equal to it** — the
 * give-up line and the `SIGKILL` were a photo finish that the line loses, since
 * it only prints *after* this timer resolves.
 *
 * And the inequality is not `bound < grace`, because this drain is not the last
 * thing shutdown does. What has to fit is:
 *
 *     SHUTDOWN_DRAIN_TIMEOUT_MS  +  the shutdown tail  <  the tightest grace
 *
 * The tail is the give-up line itself, `DatabaseModule` closing the pool behind
 * it, and the abandoned continuation's own failure (it wakes on a pool that has
 * been `end`ed and logs through `guardContinuation`). **Measured on this project
 * at `SIGTERM` mid-walk: `waited_ms: 4001`, process exit 4 790 ms after the
 * signal — a tail of ~790 ms, and 210 ms of a 5 000 ms grace left over.** That
 * is not headroom, it is a coin toss on a loaded machine.
 *
 * Three seconds was then measured the same way — `SIGTERM` one second into a
 * walk whose supplier is silent — and gives **`waited_ms: 3001`, process exit
 * 3 055 ms after the signal, 1 945 ms of the grace left over.** That is
 * headroom.
 *
 * Every *healthy* continuation still finishes far inside it: the guarded
 * statements around a supplier call run in tens of milliseconds against a local
 * pool (16 ms, 24 ms and 41 ms for the three ladder transactions of a measured
 * walk), so even a slow-but-successful supplier — a hang placed under
 * `SUPPLIER_TIMEOUT_MS`, `../config/supplier-config.ts`'s first scenario —
 * lands near 2 s. What 3 s excludes is a walk that has already spent one
 * supplier timeout and started another, which is the pathological case and the
 * one whose abandonment is recoverable.
 *
 * **What a shutdown mid-walk costs, stated plainly:** the order is left in
 * `delivering` with its newest `issuance_attempts` row saying `unknown` and
 * `last_error` NULL, its payment event still pending, and no key delivered. That
 * is not a lost order — it is the recovery list's entry for it, and an operator
 * retry re-asks the *same* `request_id`, which the supplier's ledger (I5)
 * answers with the code it already issued if it issued one.
 *
 * **If either neighbour moves, this constant moves with it.** Raising
 * `SUPPLIER_TIMEOUT_MS` does *not* require raising this (constraint 1 is already
 * conceded); raising `SHUTDOWN_TIMEOUT_MS` in `api-instance.ts` is the only
 * change that would let this grow, and it would have to grow by the tail as
 * well as by the bound.
 *
 * A constant rather than an environment variable, deliberately. `../config/`
 * exists for values that name something *outside* the process and have no right
 * default in both environments (`../config/env.ts`); this names something
 * inside it, has a right default, and is only meaningful in the environment
 * where this implementation is selected at all. A knob here would be a knob
 * that only ever gets turned to work around a continuation that should have
 * been made faster.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 3_000;

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
