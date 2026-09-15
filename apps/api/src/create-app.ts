/**
 * `createApp()` — the one expression that builds this API's container.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE FUNCTION, CALLED BY TWO ENTRIES
 * ---------------------------------------------------------------------------
 * The API has two ways in. `./main.ts` is the local one: it listens on a port,
 * and it is what `pnpm dev`, the harness's four instances and every test
 * process run. `./vercel.ts` is the deployed one: it answers `(req, res)` from
 * inside a serverless function and never listens on anything. Both call this
 * and nothing else to get an application, so the container serving locally and
 * the one serving on Vercel are the same expression — the same modules, the
 * same config providers refusing the same bad variables at the same moment,
 * the same middleware on every response. What differs between the entries is
 * only what happens *after* this returns: whether something holds a port, and
 * whether the process has a lifetime it can act on
 * (technical-considerations §2.1).
 *
 * That is also why this function does deliberately little. No `listen`, no
 * `enableShutdownHooks`, no port: each of those is a fact about one entry and
 * would be wrong in the other. A function receives no signal it can act on, so
 * shutdown hooks there would be a listener that never fires; the local entry
 * needs them so `DatabaseModule`'s pool drain runs on Ctrl-C.
 *
 * ---------------------------------------------------------------------------
 * `x-instance-id` AS EXPRESS MIDDLEWARE, NOT A NEST INTERCEPTOR
 * ---------------------------------------------------------------------------
 * The header (`./instance-identity.ts`) has to be on *every* response for the
 * race runner's count to mean anything, and "every" includes the ones Nest's
 * request pipeline never fully runs: a guard's `401` short-circuits before any
 * interceptor, a `404` for an unknown route has no handler for an interceptor
 * to wrap, and an exception filter's response is written after interceptors
 * have already been unwound. Express middleware registered on the adapter runs
 * before Nest's router sees the request at all, so it covers all three. It is
 * the only piece of behaviour in this file, and it is the only thing that
 * would be worth an interceptor if an interceptor could do it.
 *
 * ---------------------------------------------------------------------------
 * WHAT A BOOT FAILURE DOES IS THE ENTRY'S CHOICE, NOT THIS FILE'S
 * ---------------------------------------------------------------------------
 * The config providers (`./config/config.module.ts`) throw while the container
 * is built, and what happens to that throw is the one thing the two entries
 * genuinely disagree on. Nest's default — `abortOnError: true` — logs the
 * error and calls `process.exit(1)` from inside `NestFactory.create`, so the
 * promise never settles: the process is simply gone, which is exactly right
 * for a process that owns its own lifetime (`./main.ts`, and every spawned
 * instance under the harness: "never became healthy", non-zero exit, no port
 * bound). Inside a function invocation the same `process.exit(1)` kills the
 * instance mid-request, the platform answers with its own `500`, and the
 * *next* request boots a fresh instance that dies the same way — a boot loop
 * wearing the costume of a flapping site. `./vercel.ts` needs the opposite:
 * the promise must **reject**, once, and stay rejected for the instance's
 * life so every request gets the same honest `503`. Hence {@link
 * CreateAppOptions.onBootFailure}: each entry names its policy, and this file
 * only translates it into Nest's flag.
 *
 * ---------------------------------------------------------------------------
 * LOGGING ON THE PLATFORM
 * ---------------------------------------------------------------------------
 * Every log line on the payment and issuance paths carries `order_id`,
 * `event_id` and `request_id` as fields of an object. Locally Nest's
 * `ConsoleLogger` pretty-prints that object, which is what a person at a
 * terminal wants. On Vercel the function log is searched, not read, and a
 * pretty-printed object is several lines that no query can join back together.
 * `ConsoleLogger`'s `json` option (present in Nest 11 — `ConsoleLoggerOptions`
 * in `@nestjs/common`) prints each entry as one JSON line, so those fields are
 * searchable in the dashboard. Selected on `VERCEL === "1"` for the reason
 * `../scheduling/scheduling.module.ts` gives: the question is "is there a
 * platform on the other end", not "is this production".
 */
import "reflect-metadata";

import { ConsoleLogger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { ExpressAdapter } from "@nestjs/platform-express";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";

import { AppModule } from "./app.module.js";
import { INSTANCE_ID } from "./instance-identity.js";

/** The response header every answer from this process carries. See `./instance-identity.ts`. */
export const INSTANCE_ID_HEADER = "x-instance-id";

/** The entry's policy for a container that cannot be built — see the header. */
export interface CreateAppOptions {
  /**
   * `"exit"` (the default, and Nest's): the error is logged and the process
   * ends with status 1 from inside `NestFactory.create`; the returned promise
   * never settles. `"reject"`: the error is logged and the returned promise
   * rejects with it, so the caller can keep serving something in its place.
   */
  readonly onBootFailure?: "exit" | "reject";
}

/**
 * Build the container and attach the instance-identity middleware.
 *
 * Returns an application that has **not** been initialised or told to listen.
 * `./main.ts` calls `listen`, which initialises as a side effect; `./vercel.ts`
 * calls `init()` explicitly and takes the Express listener out. Both are
 * covered by the config-provider guarantee in `./config/config.module.ts`: a
 * missing or unusable variable stops the boot here, and neither entry gets an
 * application to serve with — what "stops" means is {@link
 * CreateAppOptions.onBootFailure}.
 */
export async function createApp(options: CreateAppOptions = {}): Promise<NestExpressApplication> {
  const isPlatformFunction = process.env["VERCEL"] === "1";
  const { onBootFailure = "exit" } = options;

  const app = await NestFactory.create<NestExpressApplication>(AppModule, new ExpressAdapter(), {
    abortOnError: onBootFailure === "exit",
    // Left unset locally, which is Nest's own `ConsoleLogger` pretty-printing —
    // the same logger the platform branch configures, in its other mode.
    ...(isPlatformFunction ? { logger: new ConsoleLogger({ json: true }) } : {}),
  });

  // Registered on the adapter before `init()` runs, so it is ahead of Nest's
  // body parsers and router in Express's stack and runs for every request,
  // including the ones the router answers with a `404` and the ones a guard
  // refuses. See the header for why this is not an interceptor.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader(INSTANCE_ID_HEADER, INSTANCE_ID);
    next();
  });

  return app;
}
