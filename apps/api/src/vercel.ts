/**
 * The deployed entry: one Node function answering `(req, res)` for every
 * `/api/*` and `/internal/*` request (technical-considerations §2.1).
 *
 * The repository-root `api/index.js` re-exports this file's compiled form
 * (`dist/vercel.js`), and `vercel.json` rewrites both prefixes to it. The
 * container is `./create-app.ts`'s, the same one `./main.ts` serves locally;
 * this file only decides how that container meets a request that arrives
 * without a listening socket.
 *
 * ---------------------------------------------------------------------------
 * THE CONTRACT
 * ---------------------------------------------------------------------------
 * Vercel's Node runtime calls the default export once per request with Node's
 * own `IncomingMessage` and `ServerResponse`, and considers the invocation
 * over when the response ends. An Express application is itself a
 * `RequestListener` — `(req, res) => void` — so once Nest has initialised one,
 * handing the request straight to it is the whole of the job: Nest's body
 * parsers, router, guards, filters and the `x-instance-id` middleware all run
 * exactly as they do behind `app.listen()`. Nothing here parses, routes or
 * logs a request.
 *
 * ---------------------------------------------------------------------------
 * A CACHED **PROMISE**, NOT A CACHED APP
 * ---------------------------------------------------------------------------
 * A function instance is a process that is reused for as long as the platform
 * keeps it warm, and it may receive a second request while the first is still
 * building the container. The naive shape —
 *
 *     let app; if (!app) app = await createApp();
 *
 * — is a check-then-act across an `await`: both requests see `undefined`, both
 * call `createApp()`, and the instance ends up with two containers, two
 * `DatabaseModule`s and therefore two `max: 1` pools, which is exactly the
 * per-instance connection budget `packages/db` sized Neon against, doubled.
 * Storing the promise on the first line of the module closes the gap because
 * there is no gap: the module evaluates once per process, the call happens
 * during that evaluation, and every invocation — including two that overlap
 * on a cold instance — awaits the same promise and receives the same listener.
 * This is the one place in the API where a process-level singleton is the
 * right tool: it guards a resource that is *meant* to be per-process, not a
 * correctness invariant, which stay in Postgres (`architecture.md` §3).
 *
 * ---------------------------------------------------------------------------
 * A MISCONFIGURED INSTANCE ANSWERS `503` FOR ITS LIFETIME
 * ---------------------------------------------------------------------------
 * The config providers validate the environment while the container is built
 * (`./config/config.module.ts`), which here is the first invocation an
 * instance receives. `createApp({ onBootFailure: "reject" })` turns that throw
 * into a rejection of the cached promise instead of a `process.exit(1)` — and
 * the rejection is kept, deliberately, for as long as the instance lives.
 * Retrying `createApp()` per request would turn one bad variable into a boot
 * loop: every request paying a full Nest boot to hit the same throw, with the
 * pool and the logs churning underneath. The environment cannot change under a
 * running instance anyway; fixing a variable means a redeploy, and a redeploy
 * creates new instances that read the corrected value on their own first
 * invocation.
 *
 * So the handler answers `503 { status: "misconfigured", error }` with the
 * `ConfigurationError`'s message — it names the variable — and the
 * `x-instance-id` header set by hand, because Express never ran and the
 * middleware that would have set it never existed. `GET /api/health` is
 * therefore the operator's boot probe: `200` with an `instance_id` means the
 * container built; `503` names what to fix (R11).
 *
 * The failure is logged once per instance, from the promise's own `.catch`
 * rather than from the handler. That `.catch` does double duty: without a
 * handler attached at module scope, a rejection that happens before the first
 * request reaches `await` is an *unhandled* rejection, and Node ends the
 * process over it — the platform's `500`, the boot loop, the whole path this
 * file exists to avoid. Attaching it there marks the rejection handled while
 * leaving `listener` itself rejected, so every later `await` still sees the
 * error.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * No `enableShutdownHooks()`: a function receives no `SIGTERM` it can act on —
 * the platform freezes and discards instances without telling the process —
 * so the hook would be a listener that never fires, and `DatabaseModule`'s
 * pool drain is not the mechanism that closes connections here. No `listen()`,
 * no port, no `waitUntil`: post-response work is the scheduler's business
 * (`./scheduling/scheduling.module.ts`), selected on the same `VERCEL` flag,
 * not the entry's.
 */
import type { IncomingMessage, RequestListener, ServerResponse } from "node:http";

import { Logger } from "@nestjs/common";

import { INSTANCE_ID_HEADER, createApp } from "./create-app.js";
import { INSTANCE_ID } from "./instance-identity.js";

/** The body a misconfigured instance answers every request with. */
export interface MisconfiguredResponse {
  readonly status: "misconfigured";
  readonly error: string;
}

const logger = new Logger("VercelEntry");

/**
 * The Express listener, built once per process. See the header for why this
 * is a promise stored at module scope and why a rejection is never retried.
 */
const listener: Promise<RequestListener> = createApp({ onBootFailure: "reject" }).then(
  async (app) => {
    await app.init();
    // `getInstance()` is typed as `any` by Nest's abstract adapter; for the
    // Express adapter it is the Express application, which is callable as a
    // Node request listener.
    return app.getHttpAdapter().getInstance() as RequestListener;
  },
);

// The once-per-instance log and the unhandled-rejection guard, in one
// statement — see "A MISCONFIGURED INSTANCE ANSWERS `503`" in the header.
listener.catch((error: unknown) => {
  logger.error({
    msg: "container could not be built; this instance answers 503 until it is replaced",
    instance_id: INSTANCE_ID,
    error: describeBootFailure(error),
  });
});

/** The message the `503` carries: the error's own words, or a stringified non-error. */
function describeBootFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The function's request handler. One request in, one response out; the
 * container is shared across every call the instance ever receives.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let serve: RequestListener;

  try {
    serve = await listener;
  } catch (error: unknown) {
    const body: MisconfiguredResponse = {
      status: "misconfigured",
      error: describeBootFailure(error),
    };

    res.statusCode = 503;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader(INSTANCE_ID_HEADER, INSTANCE_ID);
    res.end(JSON.stringify(body));
    return;
  }

  serve(req, res);
}
