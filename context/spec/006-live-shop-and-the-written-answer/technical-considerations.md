# Technical Specification: Live Shop and the Written Answer

- **Functional Specification:** `context/spec/006-live-shop-and-the-written-answer/functional-spec.md`
- **Status:** Completed
- **Author(s):** Alexander Shleyko

---

## 1. High-Level Technical Approach

Nothing about how the shop behaves changes. This phase changes **where it runs** and **how it is described**, and adds the one thing a live demo needs that a laptop does not: a way back to the starting state.

1. **One Vercel project at the repository root**, serving `apps/web/dist` as the static site and `apps/api` as **one Node serverless function** at the same origin. A rewrite sends `/api/*` and `/internal/*` to the function and everything else to `index.html`. The browser keeps calling relative paths; the API keeps calling itself over HTTP for the suppliers and the payment webhook — on Vercel those self-calls become second invocations, which is the point. **Fluid Compute is off** (user decision): one instance per concurrent request, so fifty simultaneous webhooks are fifty processes with nothing in common but Postgres.
2. **Neon Postgres**, reached by the **same `pg` driver** the shop already uses (user decision: no driver swap), through Neon's pooled endpoint with `sslmode=verify-full`. Migrations and the seed run **from the operator's machine** against the direct endpoint — never in the build.
3. **Demo affordances**, all behind the existing admin token: `POST /api/admin/demo/reset` (the whole shop back to its seeded state, one transaction, idempotent), and `POST /internal/suppliers/keys/{drain,restock}` on the supplier's side of the boundary, so the out-of-stock recovery check can stage an empty pool over HTTP. Together with `ALLOW_CLIENT_SUPPLIED_ORDER_ID=true` on the live demo (user decision), **all nine race checks run against the live URL** with only `RACE_BASE_URLS` and `ADMIN_TOKEN`; database-side assertions are reported as SKIP by name.
4. **An HTTP witness of "separate processes"**: every response carries `x-instance-id`, generated once per process; the harness check and the three N-concurrent checks count distinct ids, so the sentence "correctness lives in Postgres" arrives with a number in it even for a reviewer who cannot see the database.
5. **The written answer**: a Russian root `README.md` in the assignment's order, with the two maps, the recorded live run, the time report reconstructed from git and session history and confirmed by the author, and links to the walkthroughs; the repository published publicly on GitHub.

Systems affected: `apps/api` (a second entry point, one seam, one module, one controller, one middleware, one header field), `scripts/race` (external mode), `packages/db` (a script alias and a comment), root (`vercel.json`, `api/index.js`, `README.md`, `.env.example`), `context/product/architecture.md`. `apps/web` source is untouched.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1 The function and the static site — layout on Vercel

**One project, Root Directory = repo root.** Rejected: Root Directory = `apps/api` (scopes both the static output and `api/` detection to that subtree; the web build would have to be copied in) and `api/[...path].ts` (still needs the `/internal/*` rewrite, so buys nothing).

| Path | Responsibility |
| --- | --- |
| `apps/api/src/create-app.ts` (new) | `createApp(): Promise<NestExpressApplication>` — `NestFactory.create(AppModule, new ExpressAdapter())` plus the `x-instance-id` middleware (§2.5) and nothing else: no `listen`, no shutdown hooks, no port. Both entries call it, so the container that serves locally and the one on Vercel are the same expression. |
| `apps/api/src/main.ts` (edit) | Local entry: `await createApp()`, `enableShutdownHooks()`, `listen(API_PORT)`. Unchanged behaviour for `pnpm dev`, the harness's four instances, tests. |
| `apps/api/src/vercel.ts` (new) | `export default async function handler(req, res)`. Module-scope cached **promise**: `createApp().then(app => app.init()).then(app => app.getHttpAdapter().getInstance())` — the Express request listener. Every invocation: `(await listener)(req, res)`. Cache the promise, not the app, so two overlapping cold invocations never build two containers (two `max: 1` pools). No `enableShutdownHooks` — a function receives no signal it can act on. |
| `api/index.js` (new, repo root) | `export { default } from "../apps/api/dist/vercel.js";` with a header comment. `.js`, not `.ts`: the root is `"type": "module"`, so `@vercel/node` treats it as ESM and there is no second TypeScript compile under an unowned tsconfig; `tsc -p tsconfig.scripts.json` cannot pick it up. Vercel builds every `api/**` file under the Root Directory as a function regardless of `outputDirectory`. |

**A misconfigured instance.** Config providers validate at `NestFactory.create` (`apps/api/src/config/*`), which on Vercel is the first invocation per instance. If it throws, the cached promise stays rejected for the instance's life — deliberately: retrying `create` per request turns a bad variable into a boot loop. The handler catches the rejection and answers **`503 { status: "misconfigured", error: "<ConfigurationError message>" }`** with the `x-instance-id` header set by hand (Express never ran), logging once. Config changes need a redeploy, which creates new instances. `GET /api/health` is therefore the operator's boot probe: `200` with `instance_id` means the container built.

**Logging.** Nest's `ConsoleLogger` to stdout, captured per invocation. On `VERCEL === "1"`, `createApp()` passes the JSON logger option (verify the exact Nest 11 option name before writing it) so `order_id`/`event_id`/`request_id` are searchable fields in the function log. Locally unchanged.

### 2.2 `vercel.json` and routing

```jsonc
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": null,
  "installCommand": "pnpm install --frozen-lockfile",
  "buildCommand": "pnpm run build",            // pnpm -r run build, topological: contracts → db → api → web
  "outputDirectory": "apps/web/dist",
  "regions": ["fra1"],                          // must pair with the Neon project's region (aws-eu-central-1)
  "functions": { "api/index.js": { "maxDuration": 60 } },   // Hobby ceiling with Fluid off; default is 10 s
  "rewrites": [
    { "source": "/api/(.*)",      "destination": "/api/index" },
    { "source": "/internal/(.*)", "destination": "/api/index" },
    { "source": "/((?!api/|internal/|assets/).*)", "destination": "/index.html" }
  ]
}
```

- **Filesystem first, then rewrites** — `/assets/*` and `/api/index` are served from disk; `/api/orders` misses and reaches the function with its **original** `req.url`; `/order/ord_x` misses and falls to `index.html` — the step `apps/web/src/app/router.ts` says Phase 6 owes. The negative lookahead guarantees an unknown `/api/whatever` is a Nest JSON 404, never a 200 HTML page.
- Vercel picks pnpm 10 from `packageManager`; project env `ENABLE_EXPERIMENTAL_COREPACK=1` pins it exactly. The root `prepare` hook runs on the installer (it is the project's own script, not a dependency's), building the packages; `buildCommand` builds them again — idempotent `tsc`. **Never set `NODE_ENV=production`** as a project variable: it drops devDependencies (`typescript`, `vite`, `@nestjs/cli`).
- Node: resolved from root `engines.node >= 22.18` → 22.x.
- Bundling: `@vercel/node` traces from `api/index.js` through `apps/api/dist/**` and the pnpm-symlinked workspace packages (`exports` → `dist/`). Nest's optional imports (`@nestjs/microservices`, `@nestjs/websockets`, `class-validator`, `pg-native`) appear as tracing **warnings** only. `includeFiles` is not needed: no migration, seed, or `.sql` is read at runtime.
- `NODEJS_HELPERS=0` (project env): turns off `@vercel/node`'s pre-read `req.body`/`query` helpers so Nest's body parser sees the same raw stream it sees locally.
- **Fluid Compute off** is a project setting, **on by default** for a new project — a dashboard toggle (Project → Settings → Functions) or the project API's `resourceConfig.fluid` (set through the API in this phase, together with `nodeVersion: "22.x"`), done after `vercel link` and before the first `vercel --prod`; there is no `vercel.json` key. Turning it off drops the project's default function timeout from 300 s to 10 s, which `maxDuration: 60` overrides. Deployment Protection defaults stay: production alias public, previews and per-deployment URLs gated — which is why the self-call URLs (§2.7) must be the **production alias**, never `VERCEL_URL` (a self-call to a protected URL gets a 401 login page, which the issuance client would read as a definite refusal).
- `apps/web`: no source change. `vite.config.ts`'s proxy already mirrors the rewrites. `sourcemap: true` publishes `.map` files — the sources are public by requirement, so they leak nothing; left as is.
- Optional `.vercelignore` (`context/`, `docs/`, `apps/web/e2e/`, `**/test/`) to shrink the upload; no effect on the build.

### 2.3 The database on Neon

**Driver: `pg` over TCP, unchanged** (user decision). `packages/db/src/client.ts` keeps `max: 1`, `idleTimeoutMillis: 10_000`, `allowExitOnIdle`, no prepared statements. The URL is Neon's **pooled** host with `sslmode=verify-full` — `pg-connection-string` treats `require` as an alias of `verify-full` today but prints a deprecation warning per process (per cold start, in the function log) and will stop verifying in pg 9; `verify-full` says what is meant. No `ssl` pool option is needed (Node's root store holds Neon's chain). Neon's console appends `channel_binding=require`; `pg` ignores it.

PgBouncer transaction mode, checked against this codebase: zero `SET`, advisory locks, `LISTEN`, cursors or `.prepare(` anywhere (the three `.prepare(` hits are the comments forbidding it). `transaction()` checks out one client for `BEGIN … COMMIT`, exactly the unit the pooler pins to one backend. `application_name` survives the pooler, so `pg_stat_activity` reads keep meaning; `pg_prepared_statements` audits do not (session-local) — run those locally.

**Migrations and seed: operator-run, direct endpoint, never in the build.** `DATABASE_URL=<neon-direct> pnpm db:deploy`, where `db:deploy` is a new root alias `pnpm run db:migrate && pnpm run db:seed` — no Docker; `scripts/with-env.ts` lets the exported variable win over `.env`. Why not the build: preview deploys would run DDL on every PR; the build would depend on a cold compute and hold the secret; the seed is idempotent but not inert (a fixture lowering `max_uses` under a live `used_count` aborts on the CHECK — a human's decision, not a deploy failure). The drizzle migrator runs all pending migrations in one transaction and none uses `CONCURRENTLY`, so it would work through the pooler; the direct endpoint is used anyway (doc fix: `migrate.ts` says "each file in a transaction"; it is "all pending, in one").

**Architecture amendments:** §2 "Hosted instance" → a PgBouncer pooled endpoint speaking the plain wire protocol, the same driver locally and live; "Query layer" → `drizzle-orm/node-postgres` (strike `neon-serverless`, with the reason: one driver for the `max: 1` measurement and the prepared-statement argument to stay valid); `client.ts`'s "PHASE 6 — SWAPPING IN NEON" block → "DECIDED: NO SWAP".

### 2.4 Demo affordances

All behind `AdminTokenGuard` (503 unconfigured / 401 wrong), `@HttpCode(200)`, no request body (the reset) or an optional `{ token }` (drain and restock), a `warn`-level log line, and a header comment naming them **demo affordances** in the register of `promo-codes-reset.controller.ts`.

#### `POST /api/admin/demo/reset` — new `DemoModule` (`apps/api/src/demo/`)

Not `AdminModule`: that module's header argues it "still cannot write `orders.status` by any route" and uses `DATABASE_CLIENT` for one `SELECT` and one `UPDATE`; a six-table delete is the thing that argument excludes. `DemoModule` imports `ConfigModule` and `DatabaseModule`, registers the guard as a provider (precedent: `supplier-behaviour.controller.ts`), exports nothing, and is the seed's sibling — "the loader, not a participant" (`seed.ts`) — which is its licence to write both sides of the supplier boundary. `POST /api/admin/promo-codes/reset` stays (a check's per-run precondition); the demo reset is the operator's whole-shop action.

One transaction; emitted with `tx.execute(sql\`…\`)` so this text *is* the SQL:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';        -- the only SET in the codebase; LOCAL dies with the transaction (pooler-safe)
SELECT id FROM orders ORDER BY id FOR UPDATE;   -- the lock the application takes first: in-flight work finishes or queues
DELETE FROM deliveries;                          -- dependents first (FK → orders)
DELETE FROM issuance_attempts;
DELETE FROM promo_redemptions;                   -- FK → orders, promo_codes
DELETE FROM payment_events;                      -- no FK; processed or not — the demo is reset wholesale
DELETE FROM orders;
UPDATE promo_codes SET used_count = 0 WHERE used_count <> 0;
UPDATE supplier_keys SET claimed_by_request_id = NULL, claimed_at = NULL WHERE claimed_by_request_id IS NOT NULL;
DELETE FROM supplier_requests;
UPDATE supplier_behaviour SET failure_rate = 0, hang_rate = 0, hang_ms = 0, fail_next = 0, hang_next = 0,
       hang_before_claim = false, updated_at = now()
 WHERE (failure_rate, hang_rate, hang_ms, fail_next, hang_next, hang_before_claim) IS DISTINCT FROM (0, 0, 0, 0, 0, false);
SELECT … ;  -- readBaselineCounts' query plus supplier_behaviour_baseline (rows at baseline = 2)
COMMIT;
```

Response: `{ removed: { orders, deliveries, issuance_attempts, promo_redemptions, payment_events, supplier_requests }, reset: { promo_codes, supplier_keys, supplier_behaviour }, changed: boolean, now: <baseline counts> }`. A second run returns all zeros, `changed: false`, and `now` = 12 products / 50 keys, 50 unclaimed / 0 orders … / 4 codes, 0 used, 0 redemptions / 2 behaviour rows at baseline — functional spec §2.3's "changes nothing and reports that". No `TRUNCATE` (ACCESS EXCLUSIVE, no counts). Sub-second on a demo-sized database; bounded by `lock_timeout`.

Why one transaction: the two half-states are the ones the spec forbids — orders gone but keys claimed by nobody, or keys unclaimed while `deliveries` still holds them (a shopper's page showing a key that is back in stock). Under `max: 1` the transaction holds the instance's only connection and the instance does nothing else.

Why the promo ledger may be deleted here when `promo-codes-reset` refuses to: the orders whose history it was go in the same transaction, so counter and ledger agree at 0 = 0 by construction. Both arguments are right for their scope; the header says so.

**Reconciling `schema/supplier.ts`'s "no unclaim" comment** (amend there and at architecture §6/§7): on every production path a key is claimed by exactly one request forever, and restocking a live pool is adding rows. Two demo affordances outside those paths clear the claim, each scoped so a delivered key can never be resold: the harness's cleanup (only request ids the test derived) and the demo reset (every key, only inside the transaction that deletes every `deliveries` row). `restock` releases only sentinel claims.

#### `POST /internal/suppliers/keys/drain` and `/restock` — supplier side, beside the behaviour route

Made production code on the supplier's side of the boundary so shop modules still never import `schema/supplier.ts`; same guard as `PUT /internal/suppliers/:provider/behaviour`. `drain` mints a run token (or accepts `{ token }`) and returns `{ token, claimed }`; `restock` takes `{ token }` (scoped) or nothing (every sentinel claim) and returns `{ released }`.

```sql
-- drain: $1 = run token
UPDATE supplier_keys SET claimed_by_request_id = 'drain_' || $1 || '_' || id::text, claimed_at = now()
 WHERE claimed_by_request_id IS NULL RETURNING id;
-- 0 rows => already empty; not an error. Concurrent with a real claim: its FOR UPDATE SKIP LOCKED skips rows we hold;
-- we wait on the row it holds and re-check IS NULL after its commit — neither side double-claims; UNIQUE backstops it.

-- restock: '\_' is a literal underscore; a real claim begins 'req_' and can never match
UPDATE supplier_keys SET claimed_by_request_id = NULL, claimed_at = NULL
 WHERE claimed_by_request_id LIKE 'drain\_' || $1 || '\_%' RETURNING id;   -- or LIKE 'drain\_%' without a token
```

The Vitest concurrency suites keep their SQL fixtures; `scripts/race/recover-out-of-stock.ts` **always** uses the endpoints (with or without `DATABASE_URL`) — a path exercised only live is a path local RED never sees, and its own header already names this plan. Its `finally` restocks by token whenever drain succeeded, so a half-run never leaves the shop empty. `DATABASE_URL` then gates only its assertions (attempt rows, delivery count, `supplier_requests`), which SKIP by name.

#### `scripts/demo-reset.ts` → `pnpm demo:reset`

Through `with-env.ts` like its siblings: first target from `RACE_BASE_URLS` (reuse `parseRaceBaseUrls`), `ADMIN_TOKEN`, `POST /api/admin/demo/reset`, prints the counts one per line and "already at baseline" when `changed` is false; exit 1 on non-200 with the existing `describeMissingAdminAffordance` text for 401/503.

### 2.5 Instance identity — the HTTP witness

`apps/api/src/instance-identity.ts`: `INSTANCE_ID = randomUUID()` at module load — one per process, hence one per function instance. Express **middleware** in `createApp()` (not an interceptor: a guard's 401, a 404 and a filter's response carry no interceptor) sets `x-instance-id` on every response; `GET /api/health` gains `instance_id`, `runtime: "vercel" | "node"`, and **`supplier_timeout_ms`** (the effective value — see §2.6).

`scripts/race/harness.ts` gains an HTTP half before its database half: N = max(8, 2 × targets) concurrent `GET /api/health`, header and body ids must agree; against an external target **PASS if ≥ 2 distinct ids**, FAIL if exactly 1 with the detail "all answers came from one instance — re-run, or check that Fluid Compute is off"; locally INFO only (an id per port is a tautology; the `pg_stat_activity` pids are the proof there). `webhooks`, `same-event`, `promo` collect the header from their own N responses (helper `collectInstanceIds` in `support/race-targets.ts`) and print `INFO answers came from K distinct instance(s)`. Honesty limits, printed: a distinct id proves a distinct process, not that those processes overlapped; K = 1 on a given run means that run was not cross-process evidence — the README says so and records the K of the author's run.

### 2.6 The race runner's external mode

`scripts/race/run-checks.ts`, `RACE_BASE_URLS` set — builds nothing, spawns nothing:

- **Environment hygiene.** `with-env.ts` merges `.env.example` into the child env, so today an external run hands every check `DATABASE_URL=…localhost:5433…` and the local `ADMIN_TOKEN` default: the database half either fails with `ECONNREFUSED` or asserts against the wrong database. External mode **strips `DATABASE_URL`** unless `RACE_DATABASE_URL` is set (forwarded as `DATABASE_URL` — the author's full run), and prints one line saying which mode this is; when `ADMIN_TOKEN` equals the `.env.example` default it prints a hint to export the demo token (the recover checks would otherwise 401).
- **Warm-up.** Before the first check, `GET /api/products` until 200 (it touches the database; `/api/health` builds the pool lazily and proves nothing about Neon's autosuspend).
- **One banner, not nine lines:** "no `DATABASE_URL` — every database-side assertion below is reported as SKIP by name; orders these checks create stay on the target — run `pnpm demo:reset` when the run ends, or set `RACE_DEMO_RESET=1`". `RACE_DEMO_RESET=1` (external mode only, never local) makes the runner call the reset after the last check and print the counts; the README's recorded run uses it so the transcript ends at baseline.
- **`recover-timeout` reads the target's timeout.** Today it derives `hang_ms = SUPPLIER_TIMEOUT_MS + 1500` from its own env (the local 2000); against a live 5000 the hang would land on the *slow-but-successful* side and the trap check would pass vacuously. It prefers `supplier_timeout_ms` from `GET /api/health`, printing which source it used, so the reviewer's command stays `RACE_BASE_URLS=… ADMIN_TOKEN=… pnpm race`.
- **`before-order`** needs no change: with `ALLOW_CLIENT_SUPPLIED_ORDER_ID=true` on the live demo its `201` path runs; the SKIP branch stays for a target without the flag.
- Per check, the reviewer without a database sees real PASS/FAIL for the HTTP spine and named SKIPs only for database-only assertions — functional spec §2.2's second criterion.

### 2.7 The live profile — environment and sizing

Set with `vercel env add NAME production` (value on stdin; `--sensitive` where the CLI supports it, else the dashboard checkbox). `POSTGRES_*`, `WEB_*`, `RACE_*`, `API_PORT` are local-only and are **not** set.

| Variable | Production value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | Neon **pooled** host, `?sslmode=verify-full` | production only; previews get a Neon branch or no URL (refuse to boot — loud, harmless) |
| `SUPPLIER_A_URL`, `SUPPLIER_B_URL` | `https://<prod-alias>/internal/suppliers/{a,b}` | the production alias exists at `vercel link`, before any deploy — read it, do not guess; never `VERCEL_URL` |
| `PAYMENT_WEBHOOK_URL` | `https://<prod-alias>/api/webhooks/payment` | |
| `SUPPLIER_TIMEOUT_MS` | **`5000`** | a cold self-invocation costs Lambda init + Nest `init()` + first connect (+ Neon resume) ≈ 1.5–2.5 s; the local 2000 would read a healthy cold supplier as `unknown` |
| `SUPPLIER_MAX_PROBES_PER_REQUEST` | **`2`** | worst case 2 × 5000 × 2 = 20 s + cold starts ≈ 30 s, under `maxDuration: 60` with the `waitUntil` continuation counted in the same invocation; the trap check's hang 6500 satisfies 5000 < 6500 < 60 000 |
| `ADMIN_TOKEN` | a **new** demo token (`openssl rand -hex 16`), published in the README on purpose | must differ from the `.env.example` default so the README can say "this is the demo's, not the local default" |
| `ALLOW_CLIENT_SUPPLIED_ORDER_ID` | `true` | user decision; the "MUST NEVER be set…" comment and the `warn` log gain a one-sentence demo carve-out |
| `NODEJS_HELPERS` | `0` | production + preview |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` | production + preview (build-time) |
| `NODE_ENV` | **not set** | |

Two small code changes the live profile needs: `@vercel/functions` added to `apps/api` dependencies and `resolveWaitUntil()` returning its `waitUntil` (the two lines the seam's own comment prescribes; `scheduling.module.ts` already selects it on `VERCEL === "1"`, and the seam is never consulted locally); and the payment simulator's self-call, which has **no timeout today**, gains `AbortSignal.timeout(10_000)` mapped to the existing "no answer" outcome — a cold inner invocation must not hold the outer one open indefinitely.

### 2.8 The written answer — `README.md` (Russian)

Root `README.md`, in the assignment's order (functional spec §2.4). Commands, addresses, file names, codes and the shop's own messages stay verbatim; everything else in Russian. `scripts/race/README.md` and the walkthroughs stay English and are linked.

1. Живая витрина (the production alias) and the repository address.
2. Запуск локально — Docker + pnpm from a clean clone: prerequisites (Node ≥ 22.18, pnpm 10, Docker), `pnpm install`, `pnpm db:setup`, `pnpm dev`, what to see; `pnpm test`, `pnpm test:e2e` (with the one-time `playwright install chromium`).
3. Воспроизведение гонок — `pnpm race` locally (nine checks, four processes) and `RACE_BASE_URLS=<prod> ADMIN_TOKEN=<demo> pnpm race` against the live shop; what SKIP means there; `pnpm demo:reset`; **the author's recorded run** (command, date, full output of the second of two consecutive runs, the K distinct instances), and the sentence: passing on Vercel, where every request is its own process, is evidence that the guarantees live in Postgres, not in memory.
4. Как гарантирована единственная выдача — one paragraph: the winning `INSERT` on `deliveries.order_id UNIQUE`, the order row lock, the claim by `FOR UPDATE SKIP LOCKED`, the webhook inbox keyed by `event_id`; link to `docs/walkthrough/phases-1-to-5.md`.
5. Ключевые решения и компромиссы — each paired with its cost: Postgres-as-inbox not a broker; serverless (cold starts) for the proof; `READ COMMITTED` + explicit locks not `SERIALIZABLE`; no webhook signature (waived); the demo affordances (reset, drain/restock, the order-id flag, the published token) and why they are safe on a shop with no real shoppers; no Vercel Cron on Hobby; R6's apply-vs-pay window documented, not closed.
6. Две карты — five adversarial scenarios → `pnpm race <check>` + the guarding test file; five storefront interactions → `apps/web/e2e/<spec>`.
7. Затраченное время — §2.9's table beside the roadmap's estimates, the total, one sentence on method and exclusions.
8. Где читать дальше — the walkthrough index.

### 2.9 The time report

Reconstructed, not remembered: (a) `git log` timestamps (13 commits, 7–14 September); (b) the Claude Code session transcripts under `~/.claude/projects/-Users-dusty-projects-test-tasks-game-shop/*.jsonl` — user-message timestamps give active working windows (a gap > 30 minutes closes a window); (c) the dated evidence inside the walkthroughs. A throwaway script in the scratchpad (not committed) produces per-day windows mapped to phases by commit boundaries; the result is presented to the author as a per-phase table with sources, and **nothing is published until the author confirms or corrects it** (functional spec §2.5). The README shows actual beside the roadmap's estimate per phase, the total, and what is excluded (reading the brief before 1 September; anything done outside a session).

### 2.10 Publishing and the operator's runbook

Ordered; `!`-steps are the user's (interactive auth or dashboard), the rest an agent runs.

1. `! vercel login`, then `! vercel link` from the repo root (creates the project; **note the production alias it shows** — if `game-shop` is taken Vercel suffixes it). `.vercel/` is gitignored.
2. Dashboard (user): Functions → **Fluid Compute off**; confirm Node 22.x; Deployment Protection at defaults.
3. Neon (user): create the project in the console, region `aws-eu-central-1`, Postgres 16 — or `! neonctl auth` and an agent runs `neonctl projects create …`. Take both connection strings (pooled for the function, direct for migrations). Skip Neon's Vercel integration (it injects differently-named variables; explicit `vercel env add` keeps the list auditable).
4. Agent: `DATABASE_URL=<direct> pnpm db:deploy`; read back counts and `SHOW max_connections`.
5. Agent: `vercel env add` for every row in §2.7.
6. Agent: the code of §2.1–§2.6, `pnpm build`, `pnpm test`, `pnpm race` locally green; commit. **Deploy only from a clean, committed tree** — `vercel --prod` uploads the working tree, so the live shop and the published sources must agree.
7. Agent: `vercel --prod --yes`; read the build log (pnpm 10 detected, `prepare` output, `Serverless Functions: api/index.js`, tracing warnings only).
8. Agent, verification in order: `curl -si <prod>/api/health` → 200 JSON with `instance_id`, `runtime: "vercel"`; `curl -si <prod>/order/anything` → 200 HTML; `curl -si <prod>/api/nope` → JSON 404; `POST /api/orders` with a JSON body → 201; function logs show the scheduler line `wait_until` and the issuance budget line; then `RACE_BASE_URLS=<prod> ADMIN_TOKEN=<demo> RACE_DEMO_RESET=1 pnpm race` **twice in a row** — the second run's transcript is the README's recorded run; then the author's full run with `RACE_DATABASE_URL=<direct>`.
9. `! gh auth login`, then agent `gh repo create <name> --public --source=. --push` — after the README exists. The Git integration is left unconnected (no auto-deploy on push; out of scope).
10. Manual drive of the live shop (buy, promo, pay, key, the operator's view with the demo token) — screenshots for the walkthrough.

### 2.11 Documentation amendments

`context/product/architecture.md`: §2 (driver, §2.3), §5 (the layout of §2.1–§2.2, Fluid off, region pairing, `maxDuration`, the `503` boot probe; "Docker Compose (Postgres + API + web)" → Postgres only), §6 (restock affordances), §7 (the HTTP witness beside the pid proof; that the live run is the second measurement of the four-process rule), §9 (three bullets: *a demo affordance on the whole shop*; *the test affordance is on in the live demo*; *serverless costs cold starts* gains the measured timeout choice). `schema/supplier.ts`'s comment and `client.ts`'s Phase 6 block per §2.3–§2.4. `.env.example`: comments under `SUPPLIER_TIMEOUT_MS`, `ADMIN_TOKEN`, `ALLOW_CLIENT_SUPPLIED_ORDER_ID`, `RACE_BASE_URLS` describing the live profile. `scripts/race/README.md`: external-mode section (hygiene, warm-up, banner, `RACE_DEMO_RESET`, `RACE_DATABASE_URL`), the demo endpoints, ports 5401 and 5402 in the port row. `docs/walkthrough/phase-6.md` per functional spec §2.7, plus `phases-1-to-5.md` gaining a short Phase 6 pointer (the live run is evidence for Phases 2 and 5, not a new argument).

---

## 3. Impact and Risk Analysis

**System dependencies.** Vercel (Hobby: one region, 60 s ceiling, Fluid toggle), Neon (free tier: 0.25 CU, autosuspend after 5 min, ~100 server connections behind the pooler), GitHub. Locally nothing changes: `main.ts` still listens, the harness still spawns `dist/main.js`, `VERCEL` is unset so the seam is never consulted, `@vercel/functions` is an installed dependency imported behind that flag.

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | **Cold self-invocations misread as timeouts.** Each supplier `/issue` and the simulator's webhook are second invocations; cold ≈ 1.5–2.5 s. | `SUPPLIER_TIMEOUT_MS=5000`, probes 2 (§2.7); measure the real cold boot from the first live logs; the simulator's self-call gets its own 10 s abort. |
| R2 | **The 60 s ceiling eats a ladder walk** → an order left `delivering` holding a maybe-issued key. | Worst case ≈ 30 s (§2.7); `maxDuration: 60` explicit (the default 10 s would kill the trap check); the four drains and the admin sweep are the recovery for anything the ceiling still eats. |
| R3 | **Fluid Compute left on** → requests share an instance, the `max: 1` pool serialises them in-process (architecture §7's blind spot), `waitUntil` contexts interleave. | Dashboard toggle before the first deploy; the harness's instance-id half turns "one instance answered everything" into a FAIL; the README sentence depends on it. |
| R4 | **Neon autosuspend + function cold start** — the first request after five idle minutes pays both. | `connectionTimeoutMillis: 10_000` already covers it; external mode warms with `GET /api/products`; the README says the first request may take a few seconds. |
| R5 | **Previews sharing the production database** — a preview with the production URL writes test orders into the demo. | `DATABASE_URL` production-only; previews get a Neon branch or refuse to boot; previews are protected anyway. |
| R6 | **Self-call to a protected URL** (`VERCEL_URL`, a preview) → 401 HTML read as a supplier refusal → fall-through to B. | Only the production alias in the three URL variables; `curl /api/health` on the alias first. |
| R7 | **External mode asserting against the local database** — `with-env.ts` exports `.env.example`'s `DATABASE_URL` into every check. | §2.6: strip it unless `RACE_DATABASE_URL`; print the mode. |
| R8 | **The trap check going vacuous live** — `hang_ms` derived from the local 2000 against a live 5000. | §2.6: read `supplier_timeout_ms` from the target's `/api/health`; print the source. |
| R9 | **The reset racing an in-flight continuation** on another instance — a key claimed by `req_<deleted order>_…` after the reset's release ran. | `SELECT … FOR UPDATE` on every order first, `lock_timeout = 5s`, key release last, all in one transaction; every guard is in the database, so either ordering is consistent; "run the reset twice" is the documented remedy for a straggler (second run non-zero, third `changed: false`). |
| R10 | **Deploying a dirty tree** — `vercel --prod` uploads the working tree, so live ≠ published sources. | Deploy only after commit; the README's links and the live URL then agree. |
| R11 | **A misconfigured deploy looks like a dead site** — `ConfigurationError` on first invocation. | The handler's `503 { misconfigured, error }` names the variable; `/api/health` is the boot probe in the runbook. |
| R12 | **Function tracing gap** — nft misses a dynamically required module; pnpm symlink oddity. | Build-log review; `/api/health` exercises Nest + DB; a missing module names itself at runtime and `includeFiles` is the fix. |
| R13 | **`prepare` on Vercel's installer** fails if devDependencies are skipped or the lockfile is stale. | Never `NODE_ENV=production`; commit `pnpm-lock.yaml` after adding `@vercel/functions`; `buildCommand` rebuilds packages anyway. |
| R14 | **Frozen-instance socket death** — `idleTimeoutMillis` cannot fire while frozen; a checkout can race a dead socket → one `ECONNRESET`. | Keep 10 s and `pool.on("error")`; if observed on the first live runs, add a one-shot retry on connection-class errors for the first statement after checkout — not planned blind. |
| R15 | **Restock releasing a real claim** if the pattern were widened. | `LIKE 'drain\_%'` with the literal-underscore escape; the acceptance test's RED is exactly that widening. |
| R16 | **The demo token published** — anyone can reset the demo or arm supplier behaviour. | Accepted by decision: the shop has no real shoppers and the reset is the remedy for any mischief; the README labels it; the token differs from the local default. |
| R17 | **The time figure** is a reconstruction. | Presented with its sources and confirmed by the author before publishing; the README states the method and exclusions (functional spec §2.5). |

---

## 4. Testing Strategy

- **Local suites stay the contract and stay green.** `pnpm test` (API 14 files / 121 tests + web 6 / 69), `pnpm test:e2e` (65), `pnpm race` (9/9) after every code change of §2.1–§2.6; the harness's baseline before and after.
- **New acceptance files.** `apps/api/test/acceptance/vercel-entry.test.ts` on port **5401**: the compiled handler served through `node:http` — `x-instance-id` equal in header and `/api/health` body, identical across two requests to one instance, present on a 401 and a 404; a JSON body reaches Nest through the handler; a misconfigured child answers `503 { misconfigured }` and stays alive; RED by inversion (header ≠ body; 503 asserted as 200). `apps/api/test/acceptance/demo-routes.test.ts` on port **5402** (both in the README's port row), one instance from `dist/main.js`: the guard table (503/401); `drain` then a purchase settles `out_of_stock`; `restock` releases exactly the drained count and leaves a real `req_%` claim alone (create one delivered order first); `reset` returns counts equal to what the test created, a second `reset` returns all zeros with `changed: false`. **RED**: widen restock's `WHERE` to `IS NOT NULL` (the real claim is released); hard-code `changed: false` (the first reset's assertion fails). `assertBaseline` after.
- **Unit**: `resolveWaitUntil()` returns a function; the wait-until scheduler's "a rejecting continuation reaches the platform as a fulfilled promise" with a spy. Verify first that importing `@vercel/functions` outside Vercel does not throw at load; if it does, test the seam and the class separately and leave selection to the deploy's boot line.
- **`recover-out-of-stock` via the endpoints** keeps its local RED (the check's own README row) — re-run its weakening locally after the switch and update the row if the reported line changes.
- **Live verification is the recorded run** (§2.10 step 8): two consecutive external runs, all nine checks, K distinct instances printed, the reset at the end; then the author's full run with `RACE_DATABASE_URL`. Plus the curl ladder and a manual drive with screenshots. No Playwright against the live URL (the e2e config starts its own servers; the manual drive covers the shopper's path) — stated in the walkthrough as not done.
- **The README is tested by following it**: a clean clone on this machine (`git clone <repo> /tmp/…`, `pnpm install`, `pnpm db:setup` against a fresh compose project name, `pnpm dev`, `pnpm race`) — functional spec §2.4's first two criteria, done once, output recorded in the walkthrough.

---

## Assumptions

Recorded rather than confirmed — challenge any of them:

1. **Region `fra1` / Neon `aws-eu-central-1`.** Either pair works; they must match. Chosen for the author's timezone.
2. **`SUPPLIER_TIMEOUT_MS=5000`, probes `2`** for the live profile; both are dials, adjusted after the first live logs.
3. **`x-instance-id` as a random UUID per process**, header + health body; PASS threshold ≥ 2 distinct against an external target.
4. **Drain/restock under `/internal/suppliers/keys/*`** (supplier side) rather than under `/api/admin/demo/*`; restock scoped by token when given.
5. **A misconfigured instance answers `503`** for its lifetime rather than retrying boot per request.
6. **`recover-out-of-stock` always uses the endpoints**, locally too; the Vitest suites keep SQL.
7. **`RACE_DEMO_RESET=1` and `RACE_DATABASE_URL`** as the two runner-side knobs; no new API variable.
8. **The demo `ADMIN_TOKEN` is generated fresh** and published; the `.env.example` default is never used live.
9. **The time report's method** (git + session transcripts + walkthrough dates, 30-minute gap rule) — the author corrects the table before it is published.
10. **No `.vercelignore` is required**; added only if the upload is slow.
11. **Optional JSON logger on Vercel** — dropped if the Nest 11 option differs from what is assumed.
