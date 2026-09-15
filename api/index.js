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
 */
export { default } from "../apps/api/dist/vercel.js";
