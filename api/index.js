/**
 * The Vercel function entry — the one file under `api/` at the repository
 * root, which is what Vercel builds as a serverless function regardless of
 * `outputDirectory`. `vercel.json` (spec 006, slice 5) rewrites `/api/*` and
 * `/internal/*` here; everything else is the static site in `apps/web/dist`.
 *
 * The real code is `apps/api/src/vercel.ts`. This file only re-exports its
 * compiled form, and it is deliberately `.js` rather than `.ts`:
 *
 *   - The root `package.json` is `"type": "module"`, so `@vercel/node` loads
 *     this as ESM and follows the re-export into `apps/api/dist/`, which is
 *     already compiled by `pnpm build` under `apps/api/tsconfig.build.json` —
 *     the one tsconfig that owns that source. A `.ts` here would be compiled a
 *     second time by the platform under a tsconfig nobody in this repository
 *     wrote, with whatever `emitDecoratorMetadata` and `useDefineForClassFields`
 *     it chose, and Nest's DI would be the first thing to notice.
 *   - `tsc -p tsconfig.scripts.json` includes only `scripts/`, so a `.ts` here
 *     would not be typechecked either; there is nothing to typecheck in a
 *     one-line re-export, and the import it names is checked where it is
 *     written.
 *
 * The path is relative to this file and points at build output, so the
 * function exists only after `pnpm build` — which `vercel.json`'s
 * `buildCommand` runs before this directory is traced.
 *
 * ---------------------------------------------------------------------------
 * `vercel.json`, KEY BY KEY (JSON admits no comments, so the reasons live
 * here, beside the one file the configuration exists to serve — spec 006
 * tech spec §2.2)
 * ---------------------------------------------------------------------------
 *   "$schema"          — editor validation only; nothing at build time reads it.
 *   "framework": null  — "Other". No preset may guess a build for a pnpm
 *                        workspace whose web app is one package among four;
 *                        the three commands below say everything explicitly.
 *   "installCommand"   — `pnpm install --frozen-lockfile`: the lockfile is the
 *                        contract, and a lockfile the platform would have
 *                        rewritten is a build nobody can reproduce locally.
 *                        The root `prepare` hook runs on this install and
 *                        builds `packages/*` once; `buildCommand` builds them
 *                        again — idempotent `tsc`, so the double run is cheap
 *                        and never wrong.
 *   "buildCommand"     — `pnpm run build` = `pnpm -r run build`, topological:
 *                        contracts → db → api → web. `apps/api/dist/vercel.js`
 *                        (what this file re-exports) and `apps/web/dist` (the
 *                        static site) are both produced by the one command.
 *   "outputDirectory"  — `apps/web/dist`: the static site is served from disk
 *                        first; `/assets/*` never reaches the function. It does
 *                        not scope function detection — every file under the
 *                        Root Directory's `api/` is still built as a function.
 *   "regions"          — `["fra1"]`: Frankfurt, the region that pairs with the
 *                        Neon project's `aws-eu-central-1`. The pool is `max: 1`
 *                        per instance and every request opens at most one
 *                        connection, so the round-trip to Postgres is the cost
 *                        that repeats; keeping it inside one region keeps it
 *                        single-digit milliseconds.
 *   "functions"        — `api/index.js` → `maxDuration: 60`: the Hobby ceiling
 *                        with Fluid Compute off (the default is 10 s). The
 *                        live profile's worst case — two probes of a 5000 ms
 *                        supplier timeout across two suppliers, plus cold
 *                        starts, plus the `waitUntil` continuation counted in
 *                        the same invocation — is ≈ 30 s. The trap check's
 *                        deliberate hang (6500 ms) must satisfy
 *                        `SUPPLIER_TIMEOUT_MS < hang < maxDuration`, i.e.
 *                        5000 < 6500 < 60 000: a timeout is observed as a
 *                        timeout, never as a killed function.
 *   "rewrites"         — evaluated after the filesystem, in order:
 *                        1. `/api/(.*)`      → `/api/index` — every API route
 *                           reaches Nest with its ORIGINAL `req.url`; the
 *                           router below sees `/api/orders`, not `/api/index`.
 *                        2. `/internal/(.*)` → `/api/index` — the supplier
 *                           stubs and their behaviour knobs live in the same
 *                           container; the shop's own-origin self-calls
 *                           (`SUPPLIER_A_URL`, `PAYMENT_WEBHOOK_URL`) land on
 *                           the production alias and come back through here.
 *                        3. `/((?!api/|internal/|assets/).*)` → `/index.html`
 *                           — the SPA fallback `apps/web/src/app/router.ts`
 *                           says Phase 6 owes: `/order/ord_x` misses the
 *                           filesystem and gets the app. The negative
 *                           lookahead is what guarantees an unknown
 *                           `/api/whatever` is Nest's JSON 404 and never a
 *                           200 HTML page.
 *
 * Not in `vercel.json`, because they are not keys: Fluid Compute is OFF (a
 * dashboard toggle — concurrent requests must land in separate processes, or
 * the live race proves nothing about Postgres), Node is 22.x (resolved from
 * the root `engines.node`, the version everything was measured on), and
 * `NODE_ENV` is never set as a project variable (it would drop the
 * devDependencies the build runs on: `typescript`, `vite`, `@nestjs/cli`).
 */
export { default } from "../apps/api/dist/vercel.js";
