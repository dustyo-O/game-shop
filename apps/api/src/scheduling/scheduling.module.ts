/**
 * `scheduling` — one provider, chosen by environment, for work that outlives
 * the response that started it (technical-considerations §2.2, "Local
 * equivalent of `waitUntil`").
 *
 * ---------------------------------------------------------------------------
 * ONE CONSUMER TODAY, AND STILL IMPORTED IN `AppModule` AS WELL
 * ---------------------------------------------------------------------------
 * `PaymentWebhookController` schedules the processing it used to `await`
 * inline, so `PaymentsModule` imports this module and injects the token. The
 * `AppModule` import stays regardless, for three reasons — the same two that
 * kept `ConfigModule` there, and one that is specific to this module:
 *
 *   - The selection below runs while Nest builds the container, so a
 *     misconfigured environment is a boot-time line rather than a discovery
 *     made on the first paid order.
 *   - {@link TrackedContinuationScheduler}'s `onModuleDestroy` is only
 *     registered if the provider is instantiated, and a shutdown hook that is
 *     wired the same day it is first needed is a shutdown hook nobody has
 *     watched work.
 *   - **Destroy order.** Nest destroys modules in ascending distance from the
 *     root. Being imported by `AppModule` pins this module at distance 2, ahead
 *     of `DatabaseModule` at 3, so the continuation drain runs while the
 *     connection pool is still open. `PaymentsModule` is itself at 2, so its
 *     import does not move this one; dropping the `AppModule` line and relying
 *     on that alone would leave the distance at the mercy of whoever next edits
 *     an `imports` array. See `./tracked-continuation-scheduler.ts`,
 *     `onModuleDestroy`.
 *
 * Not `@Global()`, matching `DatabaseModule` and `ConfigModule`: the module
 * that schedules background work says so in its own `imports`, and the import
 * graph stays the answer to "what runs after a response".
 */
import { Logger, Module, type Provider } from "@nestjs/common";

import {
  CONTINUATION_SCHEDULER,
  type ContinuationScheduler,
} from "./continuation-scheduler.js";
import { TrackedContinuationScheduler } from "./tracked-continuation-scheduler.js";
import {
  WaitUntilContinuationScheduler,
  resolveWaitUntil,
} from "./wait-until-continuation-scheduler.js";

/**
 * Set to `"1"` by Vercel in every build and every function invocation, and by
 * nothing else. It is the platform's own marker, which is why it is preferred
 * here over `NODE_ENV`: `NODE_ENV=production` is also what a local production
 * build sets, and a local production build has a `SIGTERM` and wants the
 * tracked implementation. The question this variable answers is not "is this
 * production" but "is there a platform holding the process's lifetime", and
 * those are different questions with different right answers.
 */
const VERCEL = "VERCEL";

/**
 * The one provider: whichever {@link ContinuationScheduler} this environment can
 * actually honour.
 *
 * ###########################################################################
 * # ONE PROVIDER WRAPPER, ONE INSTANCE, ONE `onModuleDestroy` CALL.
 * ###########################################################################
 *
 * Deliberately a single `useFactory` rather than registering
 * {@link TrackedContinuationScheduler} as a class provider and aliasing the
 * token to it with `useExisting`. Nest's destroy hook collects the `.instance`
 * of every non-alias provider in the module and calls `onModuleDestroy` on each
 * (`@nestjs/core/hooks/on-module-destroy.hook.js`), so two wrappers holding the
 * same object would drain it twice — concurrently, since the hooks are started
 * with `Promise.all`, which would double every shutdown log line and race the
 * two snapshots against each other.
 *
 * `useFactory` with no `inject` list, as `supplierAConfigProvider` is: Nest
 * calls it exactly once during `NestFactory.create`, whether or not anything
 * injects the token.
 */
const continuationSchedulerProvider: Provider = {
  provide: CONTINUATION_SCHEDULER,
  useFactory: (): ContinuationScheduler => {
    const logger = new Logger("SchedulingModule");
    const isPlatformFunction = process.env[VERCEL] === "1";
    const waitUntil = isPlatformFunction ? resolveWaitUntil() : undefined;

    if (waitUntil !== undefined) {
      logger.log({
        msg: "continuations delegated to the platform",
        implementation: "wait_until",
      });

      return new WaitUntilContinuationScheduler(waitUntil);
    }

    if (isPlatformFunction) {
      // Running as a Vercel function with `resolveWaitUntil()` returning
      // `undefined` — unreachable since Phase 6 closed the seam, kept so a
      // reopened seam is loud rather than silent (see `resolveWaitUntil`).
      // The tracked implementation is a poor substitute
      // here (there is no `SIGTERM` and the instance freezes at the response),
      // so this is loud. It is not fatal, because the other three triggers in
      // `architecture.md` §4 still complete every order; what is lost is
      // promptness, and refusing to boot over promptness would be the worse
      // trade.
      logger.error({
        msg:
          "running on Vercel without waitUntil; continuations are unprotected and orders will " +
          "settle on a later drain instead. Install @vercel/functions and wire resolveWaitUntil " +
          "(apps/api/src/scheduling/wait-until-continuation-scheduler.ts)",
        implementation: "tracked",
      });
    } else {
      logger.log({
        msg: "continuations tracked in-process and awaited on shutdown",
        implementation: "tracked",
      });
    }

    return new TrackedContinuationScheduler();
  },
};

@Module({
  providers: [continuationSchedulerProvider],
  exports: [CONTINUATION_SCHEDULER],
})
export class SchedulingModule {}
