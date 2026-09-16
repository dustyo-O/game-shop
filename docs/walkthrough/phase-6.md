# Phase 6 — the shop where every request is its own process, and the written answer

> The phase-level walkthrough required by functional spec 006 §2.7. It makes the argument **once**; the five
> Phase 6 slice walkthroughs beside it hold the evidence, and every claim names the one that proves it.
> Nothing here needs the source code to follow, and nothing here was run against the live shop or against a
> database while it was written.
>
> Five phases built a shop that sells one key per payment however the world misbehaves, proved it with
> checks a reviewer can run, gave it the assignment's face, and made a promo limit hold under parallel use.
> Phase 6 is the assignment's *response*: the shop on a public address, the sources published, the checks
> run against that address, and one Russian document that answers the brief's questions in the brief's
> order. It is the one phase that adds **no mechanism** to the argument. What it adds is a subtraction and a
> number. The subtraction: on the hosting chosen, with one setting turned off, every concurrent request is
> handled by its own process with its own memory, so the one explanation a laptop run could never fully
> exclude — that some lock, cache or queue inside a process was doing the work — has nowhere left to live.
> The number: fifty simultaneous reports of one payment were answered by **thirty** distinct processes and
> produced one key, printed by the same check that prints the count, with its limit printed beside it.
>
> The phase's own contribution beyond that is a set of findings about the platform rather than about the
> shop, and two of them would have made the phase's sentence quietly false. **Fluid Compute was on by
> default** on a fresh project — the setting under which requests *share* an instance and the whole
> measurement collapses into architecture §7's single-process shape — and turning it off **dropped the
> project's default function timeout from 300 s to 10 s**, which would have killed the timeout-trap check's
> 6.5-second hang; `vercel.json`'s `maxDuration: 60` is a key and not a comfort because of it. Beside them,
> the shop's own cross-process guard fired during an ordinary purchase that nobody was racing — a status
> poll on one instance and a webhook continuation on another met on the same order, and the log names which
> one stepped back — which is the phase's sentence in its smallest possible form. Every word this document
> leans on is collected in §2 before it is used in earnest.

---

## 0. The assignment's words

The brief says what the response must contain, and the functional spec (§1) restates it as the list this
phase is built around: *a live link or startup instructions — we deliver both; the sources; how to
reproduce the race check; a couple of lines on how single issuance was guaranteed; the key decisions; and
the actual time spent.* The tech spec's §2.8 fixes the README's headings in the assignment's own language,
and those are the five items as the README now carries them:

1. «Живая витрина и исходники» — the live address *and* the repository address.
2. «Запуск локально» — the instructions, for a reviewer who would rather run it than trust it.
3. «Как воспроизвести гонки» — locally and against the live address, with the author's recorded run.
4. «Как гарантирована единственная выдача» — the couple of lines a reviewer can quote.
5. «Затраченное время» — reported honestly.

And the standard the brief grades by, quoted in `product-definition.md` §1 and in `tasks.md`'s standing
requirement: «чистоту кода и способность объяснить решения» — the code's cleanliness *and the ability to
explain the decisions*. The roadmap's Phase 6 line puts the two halves together and says why the first item
is more than a link: *"Because serverless functions run as separate processes, passing the race scenarios
against the deployed system is itself evidence that correctness lives in the database and not in one
process's memory."* The sentence the standing requirement asks to be said unaided — *passing the race
checks on Vercel, where every request is its own process, is evidence that the guarantees live in Postgres
and not in memory* — is that line with the platform named, and §3 is this document's version of it.

The functional spec turns the list into seven requirements and 30 acceptance criteria. The five that matter
most here are §2.1 (*the shop is live at one public address* — every self-call on the alias, the next-day
criterion), §2.2 (*the checks run against the live shop, and the result is on record* — twice in a row, the
second run identical to the first with no tidying between), §2.3 (*the demo can be reset*), §2.4–§2.6 (the
written answer, the time, the sources) and §2.7 (this walkthrough: why separate processes strengthen the
claim, what had to change, what the live run showed — every entry readable without the source).

| The brief fixes | The phase decided |
|---|---|
| A live link **or** startup instructions | Both: the alias `https://game-shop-ochre.vercel.app`, and a README whose local section was rehearsed from a clean clone (§6) |
| The sources | Public at `https://github.com/dustyo-O/game-shop`, with the one published secret labelled as the demo's (§6, §8) |
| How to reproduce the race check | One command, the same script locally and live, the recorded run kept in `docs/walkthrough/evidence/` (§5) |
| A couple of lines on single issuance | README §4 — the winning `INSERT`, the row lock, `FOR UPDATE SKIP LOCKED`, the inbox keyed by `event_id` — with `phases-1-to-5.md` as the long form |
| The key decisions | README §5, each paired with its cost; the eight here that a reviewer is most likely to push on are §8 |
| The actual time spent | Reconstructed from evidence, confirmed by the author before publication, three readings shown (§7) |
| — | Nothing about the shop's behaviour changes: a behaviour found wrong during deployment is a bug against its own spec (§1) |
| — | Fluid Compute off, the same `pg` driver, migrations from a laptop, the demo affordances behind one published token (§4, §8) |

---

## 1. What shipped

Six slices; five carried code, none of it on a shopper's path. Sizes and suite counts are as each slice's
walkthrough or task report gave them at its close.

| Slice | What | Where | Size, and the suites when it closed |
|---|---|---|---|
| 1 — One function, proven locally | `createApp()` — the one `NestFactory.create`, the `x-instance-id` Express middleware, nothing else; the local entry reduced to `createApp()`, `enableShutdownHooks()`, `listen()`; the deployed entry over a module-scope cached **promise** of the Express listener, `503 { status: "misconfigured", error }` for a boot that fails; `api/index.js`; `/api/health` gains `instance_id`, `runtime`, `supplier_timeout_ms`; the `waitUntil` seam closed (`@vercel/functions` 3.9.7); the simulator's self-call bounded at 10 s | `apps/api/src/create-app.ts`, `vercel.ts`, `instance-identity.ts`, `main.ts`, `health.controller.ts`, `scheduling/wait-until-continuation-scheduler.ts`, `payments/payment-simulator.service.ts`; `api/index.js` (new, repository root) | Ten changes. **7 acceptance tests** on port **5401** (6.93 s) through `node:http`, two inversion REDs; **3 unit tests**, one inversion RED (Appendix A.1–A.2). Measured: six concurrent `/api/health` during a cold boot → 6 × `200`, one instance id, one `Starting Nest application`; the self-call bound fired at 10.007 s |
| 2 — Neon holds the shop's memory | `db:deploy`; `.env.example`'s `DATABASE_URL` comment (pooled vs direct, `verify-full`, the pg-9 reason); `client.ts`'s "PHASE 6 — DECIDED: NO SWAP" with the transaction-mode audit grep; `migrate.ts`'s "all pending, in one transaction"; architecture §2 amended; the runner README's paragraph on why one local process against a hosted database is not a supported target | `package.json`, `.env.example`, `packages/db/src/client.ts`, `migrate.ts`, `context/product/architecture.md` §2, `scripts/race/README.md`; the Neon project (`aws-eu-central-1`, Postgres 16.15, 0.25 CU, `max_connections 112`) | No new tests. `db:deploy` twice: `migrate: applied 7 migration(s); 7 total` then `no pending migrations`; the seed `12 products / 4 promo codes / 50 keys / 2 behaviour rows`, then `0 inserted, 12 updated … 4 updated … 50 already present … 2 already present`. One local `dist/main.js` against the pooled endpoint sold a key in **2.41 s** over three polls; `pnpm race webhooks` against that one instance failed 2 of 2 for the reason §4.5 gives |
| 3 — Reset, drain, restock | `DemoModule` and `POST /api/admin/demo/reset` (tech spec §2.4's transaction verbatim, twelve statements, every count a command tag); `POST /internal/suppliers/keys/{drain,restock}` beside the behaviour route, the sentinel `drain_<token>_<id>` and `LIKE 'drain\_' \|\| $1 \|\| '\_%'`; `pnpm demo:reset`; the out-of-stock check speaking HTTP on every run; `schema/supplier.ts` and architecture §6/§7 reconciled | `apps/api/src/demo/*`, `suppliers/supplier-key-pool.{controller,service,types}.ts`, `scripts/demo-reset.ts`, `scripts/race/recover-out-of-stock.ts`, `support/recovery-scenario.ts` | Thirteen changes. **13 acceptance tests** on port **5402** (5.13 s), three inversion REDs (A.3); the check's own RED re-run: **9 of 29** fail, every one after the restock (A.4). Measured: a lock held 8 s → `500` after 5.20 s with `55P03`, nothing changed; held 3 s → queued, `removed.orders 1`; a drain against a held claim waited **14.31 s**, then `claimed 47` |
| 4 — The runner tells the truth | External mode: `DATABASE_URL` stripped unless `RACE_DATABASE_URL`; the mode line; the hint on the default token; the warm-up on `GET /api/products`; the one banner; `RACE_DEMO_RESET=1` after the last check (external only — the function throws if reached locally); the harness's HTTP half (eight concurrent `GET /api/health`, `PASS` ≥ 2 distinct, `FAIL` at 1 naming Fluid Compute, `INFO` locally); `collectInstanceIds` and the K line in `webhooks`, `same-event`, `promo`; `recover-timeout` reading `supplier_timeout_ms` from the target; README and `.env.example` (the `4201-4204` → `4601-4604` fix) | `scripts/race/run-checks.ts`, `harness.ts`, `support/race-targets.ts`, `webhooks.ts`, `same-event.ts`, `promo.ts`, `recover-timeout.ts`, `scripts/race/README.md`, `.env.example` | Twelve changes; no new test file — three external runs against four hand-spawned `dist/main.js` on 4601–4604 (39 named `SKIP`s, `4 distinct instance id(s)`, K = 4 four times, `9/9`), the two negatives (A.5–A.6), local mode unchanged; `pnpm test` after: **17 files / 144 tests** (API) + **6 / 69** (web) |
| 5 — Live | `vercel.json` (18 lines) with its key-by-key reasons in `api/index.js`'s header; `.vercelignore` (32 lines); the demo carve-out sentence in three places; the project linked, Fluid Compute off and Node 22.x through one API call; ten production variables; `vercel --prod --yes` → `dpl_H3dkL5L33UBV49kaSQquWY3MP97Q`; the curl ladder; five reviewer runs and two author runs; the manual drive; `describeFetchError` | `vercel.json`, `.vercelignore`, `api/index.js`, `apps/api/src/config/client-supplied-order-id.ts`, `.env.example`; `scripts/race/support/fetch-failure.ts` (new) and ten one-line replacements across the checks and `scripts/demo-reset.ts`; `docs/walkthrough/evidence/phase-6-live-race-run.txt` (285 lines); `docs/screenshots/006-live-{storefront,order-with-promo,delivered,admin}.png` | Built in 57.8 s, `λ api/index (1.93MB) [fra1]`, pnpm 10.18.0, zero tracing warnings. Reviewer runs **8/9, 9/9, 8/9, 9/9, 9/9**; author's runs **8/9, 9/9** with `26 distinct backend pid(s)` and zero `SKIP`s; no local suites (none touched) |
| 6 — The written answer | The time table reconstructed (a scratchpad script, never committed) and confirmed; the root `README.md` in Russian, 162 lines; the clean-clone rehearsal; `gh repo create --public --push`; the repository address into the README; the final `vercel --prod --yes` from the committed tree → `dpl_5Kam2ikY5xtdBtiSHn2nvukoQND9`, built in 41 s from `2152986`; this document and the map's pointer | `README.md`; `docs/walkthrough/phase-6.md`; `docs/walkthrough/phases-1-to-5.md` (one blockquote, one ▸ clause) | The rehearsal from a clean clone: `pnpm install` (`prepare` built the packages), `pnpm db:setup` (7 migrations, the seed), `pnpm dev`, `pnpm race` **9/9**, `pnpm test` **17 / 144 + 6 / 69**, `pnpm test:e2e` **65** — one README edit needed (§6) |

Two facts about the shape that are easy to miss in the table. **Nothing about the shop's behaviour
changed.** The nine check files are byte-identical between `pnpm race` on a laptop and `pnpm race` against
the alias — only the environment and the first line of the transcript differ (Slice 4); the statements under
test are the seven migrations Slice 2 applied to Neon, unchanged; `apps/web`'s source has no diff in the
phase; and the tech spec's §1 opens with the rule this follows from — *"Nothing about how the shop behaves
changes. This phase changes where it runs and how it is described."* A behaviour found wrong during
deployment would have been a bug against its own spec, fixed there, and none was found. And **every change
is one of three kinds** — a second entry point (Slice 1: the same container behind a second door), a demo
affordance (Slice 3: a way back to the seeded state, and a way to stage the empty pool over HTTP), or a
runner that tells the truth about a target it did not start (Slice 4: what a transcript is allowed to
claim). Slices 2, 5 and 6 add no code a request ever executes: a database somewhere else, eighteen lines of
JSON and ten variables, and a document.

The arithmetic of the suites: before the phase, `pnpm test` was 14 files / 121 tests for the API (tech spec
§4); the phase added three files — 7 + 3 + 13 = 23 tests — and 17 / 144 is what Slice 4's verify, the
rehearsal and the README all report. The web's 6 / 69 and the e2e's 65 did not move.

---

## 2. The words this document uses

Phase 3's glossary (`phase-3.md`) covers *guarded UPDATE*, *row lock*, *RED validation* and *zero rows*;
Phase 4's covers *the seed*, *inversion RED*, *the drive* and *the harness*; Phase 5's covers *the ledger*
(the promo one) and *the counter*. Those are used here without re-introduction.

- **Instance** — the process the platform runs a function in: reused while warm, frozen between requests,
  discarded without notice. With Fluid Compute off, one instance serves one request at a time; a second
  concurrent request gets a second instance. A module evaluates once per process, which is why one
  `randomUUID()` at module load is one value per instance.
- **Invocation** — one call of the function for one request, over when the response ends plus whatever was
  handed to `waitUntil`. The shop's self-calls — both suppliers and the payment webhook — are *second*
  invocations on the alias, each possibly cold.
- **Fluid Compute** — the platform mode under which one instance serves *many* concurrent invocations. On
  by default for a new project. Off here, by decision and by one API call, because "on" is architecture
  §7's single-process shape: requests queue on the one `max: 1` pool inside Node before Postgres sees them,
  and a shop with no locking at all passes.
- **Cold boot** — the first invocation an instance receives: the platform's init, then `createApp()`, then
  the pool's first connection. Measured on the alias at 1.81 s of platform init plus 29 ms for Nest.
- **The witness, `x-instance-id`** — a response header on every answer, equal to the process's UUID;
  `GET /api/health` repeats it in the body as `instance_id`. A witness and not a guarantee: it says which
  process answered, and nothing about which processes were alive together.
- **K** — the number of distinct `x-instance-id` values one burst of a check saw. Printed by the harness
  (eight concurrent health calls) as a verdict, and by `webhooks`, `same-event` and `promo` as an `INFO`
  line for their own burst. K = 1 means that burst was not cross-process evidence, whatever the checks
  after it say — the runner prints that sentence under the number.
- **The pooled endpoint** — Neon's PgBouncer in transaction mode: it lends a client one Postgres backend for
  one statement or for `BEGIN … COMMIT` and takes it back, so anything a *session* would remember between
  statements silently lands elsewhere later. The shop survives it by audit, not trust (§4.5).
- **`SKIP` by name** — what a check prints for an assertion it cannot make without a database: the label the
  `PASS` or `FAIL` would have carried, never counted in the tally. The recorded run has 39 of them inside a
  `9/9` that counts only what ran.
- **The reset** — `POST /api/admin/demo/reset`: one transaction, every order's row lock first, six deletes
  in foreign-key order, promo counters to zero, every key released, every supplier knob back to baseline,
  the baseline read last. `pnpm demo:reset` is the operator's spelling; `RACE_DEMO_RESET=1` is the
  runner's.
- **Drain and restock** — `POST /internal/suppliers/keys/drain` claims every unclaimed key under a
  run-scoped sentinel `drain_<token>_<id>`; `/restock` releases exactly those sentinels. They live on the
  supplier's side of the boundary, because `supplier_keys` is the supplier's inventory and no shop module may
  look at it.
- **The alias** — `https://game-shop-ochre.vercel.app`, the one address that survives every deploy and is
  public under Deployment Protection's defaults; per-deployment URLs are login-gated, and a self-call to one
  would be answered by a login page (R6). The three self-call variables name the alias and never
  `VERCEL_URL`.
- **The recorded run** — the fifth of five reviewer attempts and the second of two consecutive `9/9`s, kept
  as `docs/walkthrough/evidence/phase-6-live-race-run.txt`. It is the README's run; §5 is where the other
  four live.
- **The 30-minute rule** — the time report's one convention: consecutive events at most thirty minutes
  apart belong to one working window, and a longer gap closes it.

---

## 3. The keystone: separate processes make the guarantee's address checkable

### 3.1 In plain language, first

The phase's sentence, said unaided, before any mechanism:

> Passing the race checks on Vercel, where every request is its own process, is evidence that the
> guarantees live in Postgres and not in memory. On a laptop the nine checks run against four processes the
> author started, and a reader has to take one thing on trust: that no lock, cache or queue inside one of
> those processes was quietly doing the work and four happened not to expose it. On the alias, with Fluid
> Compute off, the platform gives each concurrent request a fresh instance with its own memory and no way
> to reach another's; fifty simultaneous reports of one payment were answered by thirty of them, and the
> shopper got one key. Thirty processes that never shared a byte cannot have shared a lock, so whatever
> decided that one key was in the only thing they did share — the database at the end of `DATABASE_URL`.

Everything else in this section is that paragraph slowed down: what the laptop cannot exclude (§3.2), what
the platform setting promises (§3.3), how the transcript knows how many processes there were (§3.4), what
the numbers were (§3.5), what they do not prove (§3.6), and where the measurement sits among the ones before
it (§3.7).

### 3.2 The alternative explanation a laptop run cannot exclude

Every proof in Phases 2 and 5 ran across four `dist/main.js` processes, and the reason four was the number
is architecture §7's founding measurement: the key claim weakened to an unlocked `SELECT`-then-`UPDATE`
hands out **20** distinct keys against one process and **9** against four. One process is worthless as a
harness because `packages/db` pins the pool to `max: 1` — the serverless shape, not a test setting — so
inside one process a transaction holds the only connection from `BEGIN` to `COMMIT` and a second concurrent
claim waits *in Node* for a connection before a byte reaches Postgres. The broken code is flawless in one
process; a single-instance race measures the connection pool, not the constraint.

Four processes expose that. What they do not do is close the argument, because the four are the author's:
started by the author's harness, on the author's machine, from the author's build, sharing a kernel, a
clock and a filesystem. A careful reader is entitled to one residual doubt — that something in a process's
memory the author forgot about, or a shared resource the four happened to have, was doing part of the work,
and that four was simply too few to catch it. Nothing in a laptop run can answer that doubt except more
laptop runs. The pids in `pg_stat_activity` say the four were separate backends; they do not say the four
were the only thing that could have been separate.

### 3.3 What Fluid Compute off guarantees

The tech spec's §1 states the platform's promise as the phase's first decision: *"Fluid Compute is off (user
decision): one instance per concurrent request, so fifty simultaneous webhooks are fifty processes with
nothing in common but Postgres."* Slice 5 §4 says what the setting buys in mechanism: with it off, a
function instance takes one invocation at a time; concurrency is met with more instances, each a fresh
process with its own module scope, its own `INSTANCE_ID`, its own `max: 1` pool, and no way to reach another
instance's memory. The instances are spawned by a scheduler the author does not control, on machines the
author has never seen, with the one thing in common being the string in `DATABASE_URL`.

That is why the setting is load-bearing and why it was the first finding of the deploy (Slice 5 §8.1): a
fresh project had Fluid Compute **on**. With it on, one instance serves many concurrent invocations — the
`max: 1` pool serialises them in-process, `waitUntil` contexts interleave, and the run collapses into the
shape §3.2 calls worthless. R3 anticipated the toggle being left on by mistake; it had not anticipated that
"left" is the default state. It was turned off through the project API in the same call that pinned Node
to 22.x — `{"resourceConfig":{"fluid":false},"nodeVersion":"22.x"}` — before the first deploy, and the
side effect was the second finding: the project's default function timeout dropped from 300 s to 10 s.
`vercel.json`'s `functions."api/index.js".maxDuration: 60` overrides it, and the deployment carries 60.

The setting has no key in the tree, and nothing in the tree can check it. What the tree *can* do is make the
transcript refuse to call a Fluid-on run a pass, which is §3.4.

### 3.4 The witness

A reviewer at a public URL cannot see the database, so the process has to say who it is over HTTP.
`apps/api/src/instance-identity.ts` mints `INSTANCE_ID = randomUUID()` at module load — once per process,
hence once per instance — and an Express middleware registered in `createApp()` ahead of Nest's router puts
it on every response as `x-instance-id`: a `200`, an unknown route's `404`, a guard's `401`, and the entry's
own `503` (set by hand, because Express never ran). Middleware rather than an interceptor because two of
those four never reach an interceptor, and two of them are asserted (Slice 1 §4.4).

The runner counts. The harness fires N = max(8, 2 × targets) concurrent `GET /api/health`, checks that every
answer's header equals its own body's `instance_id`, and counts distinct values: against an external target
`PASS` at ≥ 2, `FAIL` at exactly 1 with the detail *all N answers came from one instance — re-run, or check
that Fluid Compute is off*; locally an `INFO` line only, because an id per port is a tautology and the
`pg_stat_activity` pids are the proof there. `webhooks`, `same-event` and `promo` collect the header from
their own burst and print `INFO answers came from K distinct instance(s) — N answer(s)`. The threshold is
≥ 2 and not ≥ targets on purpose: exactly one id across eight concurrent answers is the one reading §3.2
calls worthless, so it is a verdict; above one, the number is information with its limit printed beside it
(Slice 4 §4.3).

Why the pid could not be the witness there: every function log line on this platform reads `pid: 4`,
whichever instance wrote it — thirty instances, one process id (Slice 5 §8.3). A process id is a witness only
where processes share a kernel; the HTTP witness has to be something the process mints itself.

### 3.5 The measurement

Every number is a line in `docs/walkthrough/evidence/phase-6-live-race-run.txt` or in Slice 5's task
report; none was re-measured for this document.

| Burst | K of N | The line | What it says |
|---|---|---|---|
| harness — eight concurrent `GET /api/health` | **5 of 8** | `PASS  the 8 concurrent health answers came from at least two distinct instances — 5 distinct instance id(s) across 1 target(s)` | Five processes answered eight one-millisecond requests: the platform spread even the cheapest call |
| promo — twenty `LIMIT3` applications | **18 of 20** | `INFO  answers came from 18 distinct instance(s) — 20 answer(s)` | Twenty simultaneous applications of a code capped at 3 were decided by eighteen processes — `3 × 200, 17 × 409 exhausted`, zero `5xx`, exactly as on the laptop |
| promo — ten `ONCEONLY` applications | **10 of 10** | `INFO  answers came from 10 distinct instance(s) — 10 answer(s)` | Every application its own process; `1 × 200, 9 × 409 exhausted` |
| same-event — one `event_id` twenty times | **9 of 20** | `INFO  answers came from 9 distinct instance(s) — 20 answer(s)` | `stored=1, duplicate=19, unrecognised=0` across nine processes |
| webhooks — fifty distinct reports of one payment | **30 of 50** | `INFO  answers came from 30 distinct instance(s) — 50 answer(s)` | **Fifty reports, thirty processes, one key.** `every response 2xx`, `50 of 50` stored, `status=delivered` |
| the author's run — the database's own view | **26 distinct backend pid(s)** | the harness's database half, `RACE_DATABASE_URL` forwarded | Twenty-six server connections carried the shop's `application_name` at the moment the harness looked; the local harness counts 4 |

Then the verdicts around the numbers: `9/9` twice in a row (attempts 4 and 5, identical after normalising
ids, the reset at the end of #4 the only tidying #5 had); 39 database-side assertions reported as `SKIP` by
name; the trap check reading `supplier timeout 5000 ms (from target /api/health)` and arming 6500; the
whole webhook check in **1539 ms** — the shape Slice 2 said the live run must show, fifty webhooks with no
ten-second queue behind one connection, because there is no shared connection to queue on.

**Why 30 of 50 and not 50 of 50.** K counts processes; N counts requests. A webhook handler stores the
event, answers `200` and hands the rest to `waitUntil` — a few tens of milliseconds of request time — so by
the time the fiftieth report leaves the laptop, instances that took the first ones are free again, and the
platform prefers a free warm instance to a cold new one. Thirty is the platform's answer to "how many did
fifty simultaneous arrivals need". Reuse is not sharing in the Fluid sense: an instance that has finished a
webhook still takes one invocation at a time. The number to be suspicious of is 1, and it is the one the
harness fails on.

### 3.6 The caveat, printed with the number

Two limits, and the runner prints both under every harness `PASS`:

> A distinct id proves a distinct process, not that those processes overlapped in time.
> K = 1 on a run means that run was not cross-process evidence, whatever the checks after it say.

*Distinct ≠ overlapping.* Two ids across fifty answers would be consistent with one instance recycled
between the first and the last. The concurrent fan-out argues the overlap — all fifty were sent before any
answer was awaited — and the author's 26 backends argue it from the database's side, but K itself is a
count of processes, and the transcript says so rather than folding it into the verdict.

*K = 1 on a cold platform is the witness's weak spot.* The harness's endpoint is the cheapest one the shop
has: a health call does no database work and completes in about a millisecond. Eight of them fired
"concurrently" from one laptop arrive spread over a few milliseconds of network jitter, and right after a
deploy there was one pre-initialised instance, free again before the next arrival landed. Attempt 1's
harness saw exactly that — K = 1, `FAIL`, as designed — while the promo, same-event and webhook bursts of the
*same run*, each of which holds an instance for a real transaction over Neon, were answered by **17, 10, 8
and 19** instances. So the witness is weakest on precisely the endpoint it uses and strongest on the checks
that matter, which is the right way round; the cost is that the `FAIL` can fire on a cold platform with the
toggle correctly off. It is not retried, on purpose (§8): a witness that retries until it sees ≥ 2 cannot
fail, and a witness that cannot fail is not a witness. The `FAIL` line names the remedy — *re-run* — and the
README's §3 tells the reviewer what an `8/9` with only `harness` failing means.

### 3.7 The third measurement of one rule

Architecture §7's rule — a single-instance run measures the connection pool, not the constraint; the proof
needs separate processes — has now been measured three times, each with a number:

1. **Phase 2, the keys**: the claim weakened to an unlocked read-then-write hands out 20 distinct codes in
   one process and 9 in four (`phase-2.md`, `slice-7-proving-the-race.md`; architecture §7's table).
2. **Phase 5, the counter**: the guard weakened to a read-then-increment admits 9, then 11, of twenty for a
   limit of three across four processes, and by arithmetic exactly three against one (`phase-5.md` §3.4).
3. **Phase 6, the platform**: the unchanged mechanism, across thirty processes the author did not start —
   one key; eighteen processes — three winners.

The first two are REDs: the mechanism removed, the number going wrong. The third is the opposite kind of
measurement — the mechanism in place, the number staying right where an in-process guard *could not* have
kept it right — and that is exactly why it is evidence for Phases 2 and 5 and not a new argument. Nothing
was added to the proof: no new assertion, no new invariant, no new map. Architecture §7 counts the same
event as the *second* measurement of its **witness** — one backend pid locally per process (1 → 1, 4 → 4),
26 on the alias — and both countings are right about what they count; this document counts the rule.

---

## 4. What had to change to run there

Nine changes of shape, none of behaviour. Each with what it replaced and what the alternative would have
cost; the slice walkthroughs carry the full argument and the measurements.

### 4.1 One container, two doors — `createApp()` and the two entries

`apps/api/src/main.ts` used to build the container and listen. Now `create-app.ts` owns the one
`NestFactory.create(AppModule, new ExpressAdapter(), …)` plus the instance-id middleware and *nothing an
entry owns* — no port, no shutdown hook, no policy for a boot that fails — and the two entries keep only
their disagreement. `main.ts`: `createApp()`, `enableShutdownHooks()`, `listen(API_PORT)`; behaviour
unchanged for `pnpm dev`, the harness's four instances and every test. `vercel.ts`: a module-scope cached
**promise** of the Express listener — `createApp({ onBootFailure: "reject" }).then(init, getInstance)` —
and a handler that awaits it and calls it with Node's own `req` and `res`. `api/index.js` at the repository
root is one line, `export { default } from "../apps/api/dist/vercel.js";`, and it is `.js` because the root
is `"type": "module"` and a `.ts` there would be compiled a second time under a tsconfig nobody wrote (Slice
1 §9).

Why a promise and not the app: `if (!app) app = await build()` is a check-then-act across an `await`, and
two requests on a cold instance would both see `undefined` and both build — two containers, two
`DatabaseModule`s, two `max: 1` pools, the per-instance budget Neon was sized against doubled with no error
logged. A promise on the module's first line is built once per process during evaluation, before any
request can arrive. Measured on `node:http`: six concurrent `/api/health` during a cold boot, six `200`s,
one instance id, one `Starting Nest application` (Slice 1 §4.2). With Fluid off that overlap cannot happen
on the platform; the code is correct under either setting, which is the shape this repository accepts.

Why one `createApp()` at all: the phase's claim is that nothing about the shop's behaviour changes between
local and live, and two containers written separately can only agree by discipline. One expression both
entries call makes it a property of the code.

### 4.2 A boot that fails stays failed — the `abortOnError` finding and the `503` probe

The one finding of the phase that changed a design rather than a sentence (Slice 1 §8.1). Nest's default
answer to a `ConfigurationError` thrown during `create` is not a rejected promise. In
`@nestjs/core@11.2.3`, `nest-factory.js` line 107 chooses a teardown, and `errors/exceptions-zone.js` line 6
is `const DEFAULT_TEARDOWN = () => process.exit(1)`: the error is logged and the process is ended *from
inside `create`*, so `await NestFactory.create(...)` never returns and never throws. That is exactly right
for a process that owns a port — `dist/main.js` under the harness with a bad variable logs, exits `1`, binds
nothing, and the suite fails loudly — and it is a boot loop inside a function: the instance dies
mid-request, the platform answers its own `500`, the next request cold-boots a fresh instance that reads the
same environment and dies the same way, every request paying a full Nest boot to reach the same throw.

So `createApp()` takes one option, `onBootFailure: "exit" | "reject"`, translated into Nest's
`abortOnError`; `main.ts` keeps the exit, `vercel.ts` asks for the rejection, keeps it for the instance's
life, and turns every request into `503 { status: "misconfigured", error }` with the variable named and the
header set by hand. A `.catch` at module scope logs the failure once per instance and — the part that is
easy to miss — marks the rejection *handled*, because a promise that rejects before the first request
arrives is otherwise an unhandled rejection, and Node's default for those is to end the process: the boot
loop again, by a different road. Not retried per request: nothing that throws during `create` is transient,
and the environment cannot change under a running instance; a redeploy creates new instances. Measured:
`SUPPLIER_TIMEOUT_MS=abc` → `503 {"status":"misconfigured","error":"SUPPLIER_TIMEOUT_MS must be a whole
number written in decimal digits, not \"abc\""}`, a second request the same body with the same instance id,
the process alive.

`GET /api/health` is therefore the operator's boot probe (R11): `200` with `instance_id` means the container
built; `503` says which variable did not. On the alias it read `200` with `runtime: "vercel"` and
`supplier_timeout_ms: 5000` — 0.444 s then 0.325 s right after the deploy — and the `503` was never
exercised live, because every variable was right the first time (§9).

### 4.3 `waitUntil` — the seam, closed

Phase 2 wrote `WaitUntilContinuationScheduler` complete and left exactly one thing absent: the import of
`@vercel/functions`, behind a function `resolveWaitUntil()` that returned `undefined` and whose header
prescribed its own closing. Slice 1 made those two edits — the dependency pinned exact at `3.9.7`, the
import and the `return` — and nothing else changed: not the interface, not the module, not a caller. That is
what a seam is for, as opposed to a `TODO`. `scheduling.module.ts` consults it only on `VERCEL === "1"`
(the question is "is there a platform holding the process's lifetime", not "is this production"), and the
import is safe everywhere because `@vercel/functions` resolves the request context on `globalThis` at *call*
time — off-platform, a silent no-op, not a throw.

What it buys is promptness, not correctness. Without it the continuation is paused when the instance freezes
at the response, and the order settles when the next drain finds the pending row — a status poll, the next
order creation, or the admin sweep (architecture §4's four triggers, none load-bearing). With it the platform
keeps the invocation alive until the continuation settles, bounded by `maxDuration`. The unit file pins the
one thing that would otherwise be a crash: a rejecting continuation reaches the platform as a *fulfilled*
promise, because `guardContinuation` runs first and `waitUntil` second (A.2). On the alias the boot line
read `implementation: "wait_until"`, and every check's order settled.

### 4.4 The simulator's self-call had no timeout

The one pre-existing gap the deployment's shape exposed rather than created (Slice 1 §6, §8.2). The payment
simulator posts the webhook to `PAYMENT_WEBHOOK_URL` with `fetch`, and before this phase the call carried no
`signal` — harmless while the other end was the same process one hop away, and a 60-second wait ending in
the platform's own error the moment the other end is a second, possibly cold, invocation. Now
`AbortSignal.timeout(10_000)`, mapped to the outcome that already meant "no answer, the event may have been
stored" (`Unreachable`) with the detail `no answer from <url> within 10000 ms`. Ten seconds because it is a
bound and not a budget — nothing here retries, so it only has to be above a cold boot and below the ceiling.
Measured locally at 10.007 s against a socket that accepts and never answers; on the alias the cold
self-call took 2.38 s and the key arrived at t+4.31 s.

### 4.5 The same `pg`, the pooled endpoint, `verify-full`

The plan since Phase 1 had been to swap `pg` for Neon's WebSocket driver at deployment. Slice 2 refused the
swap and wrote the refusal into `client.ts` as "PHASE 6 — DECIDED: NO SWAP": a Vercel *Node* function can
open a TCP socket, and the two measurements the whole argument rests on — architecture §7's 20-versus-9
table and `client.ts`'s named-versus-unnamed parse — were made with *this* driver and its `max: 1`, and
would otherwise be true on a laptop and merely plausible in production, which is the opposite of what the
deployment is for. The property that always mattered was the protocol, not the driver: the pooled endpoint
speaks the plain Postgres wire protocol, so `drizzle-orm/node-postgres` over `pg@8.23.0` runs locally against
the Compose container and live against Neon with only `DATABASE_URL` different.

The pooled endpoint is PgBouncer in transaction mode, and the codebase was audited for it rather than
trusted to it. One grep, quoted in `client.ts`'s header —
`SET LOCAL|SET SESSION|search_path|set_config|pg_advisory|LISTEN|NOTIFY|\.prepare\(` over `apps`, `packages`
and `scripts` — has exactly one code-line hit,
the demo reset's `SET LOCAL lock_timeout`, which dies with its transaction before the backend is lent to
anyone else. Every guarantee the shop makes is taken inside `BEGIN … COMMIT` on one checked-out connection,
which is exactly the unit the pooler pins to one backend. `sslmode=verify-full` rather than the `require`
Neon's console offers, because `pg-connection-string@2.14.0` treats `require` as an alias of `verify-full`
*with a `SECURITY WARNING` on stderr once per process* — one line per cold start, forever — and because in pg
9 `require` stops verifying the certificate, so a URL that verifies today would stop on a dependency bump.
`db:deploy` printed no warning with `verify-full`.

What one local process against that endpoint taught (Slice 2 §5.1): `pnpm race webhooks` from a single
`dist/main.js` on a laptop failed twice out of twice — fifty events stored in about two seconds, then fifty
continuations queued in Node on the process's one connection at ~30 ms a round trip instead of ~5 (median
wait ~10 s, the longest ~18 s), the in-process supplier stub hitting its 2000 ms deadline, the polls waiting
past `connectionTimeoutMillis` and answering `500`. One key per order still, both runs, and the timeout trap
occurring organically and handled as designed. That is architecture §7 made visible by latency: one local
instance against a hosted database has the deployment's latency and the laptop's process count, the one
combination that pays for both, and the runner's README now says it is not a supported target. It is also
the prediction §3.5 confirmed by its absence: on the alias the same check took 1539 ms.

### 4.6 Migrations from a laptop, never from a build

`DATABASE_URL=<neon-direct> pnpm db:deploy` — `db:migrate` then `db:seed`, through `scripts/with-env.ts`,
which layers `.env.example`, `.env`, then the real environment, so the exported variable wins and nothing
about the project lands in a file. All pending migrations run in **one** transaction (drizzle-orm 0.45.2
opens `session.transaction(...)` once and loops every pending file inside it — `migrate.ts` used to say
"each file in a transaction", and that was the doc fix the tech spec named). The direct endpoint rather than
the pooled one for three small reasons and never from a build for three larger ones (Slice 2 §4.4): every
preview deploy would run DDL against whatever database the preview's environment names (R5); a build would
hold the database secret against a cold compute; and the seed is idempotent but not inert — a lowered
`max_uses` under a live `used_count` trips `promo_codes_used_count_range` and aborts the seed transaction,
which is a human's decision about a demo that has been used, not a deploy failure for a bot to retry.
Forgetting is loud: a function against a database one migration behind boots fine and fails on the first
statement that names the missing column. Run twice: `applied 7 migration(s); 7 total`, then `no pending
migrations`; `SHOW max_connections` → 112.

### 4.7 The demo affordances, and their honesty

A reviewer's run against the deployed shop has no database to clean up with, and before Slice 3 every
purchase spent a key forever, every promo check spent uses, and the out-of-stock scenario needed fifty
purchases to stage. Three routes, all behind the admin token, none reachable from a shopper's request
(`DemoModule` and `SupplierBehaviourModule` export nothing; no shop module imports either service):

**The reset is one transaction, lock-first.** Twelve statements between `BEGIN` and `COMMIT`, tech spec
§2.4's block verbatim: `SET LOCAL lock_timeout = '5s'`; `SELECT id FROM orders ORDER BY id FOR UPDATE` —
the same row lock every writer of an order takes first; five deletes in foreign-key order (`deliveries`,
`issuance_attempts`, `promo_redemptions`, `payment_events`, `orders`) and `supplier_requests`; three
`WHERE`-guarded resets (counters, claims, behaviour rows); the baseline read last. Why one transaction
(Slice 3 §4.1): between any two autocommits a request on another instance would see one of the two
half-states the spec forbids in as many words — *orders gone, keys still claimed* by `req_<order>_…` for
orders that no longer exist, stock lost with no row to explain why; or *keys released, deliveries still
standing*, a shopper's page showing a key that is at that instant back in the pool and claimable by the next
paid order, I6 made false for a moment by the tool meant to restore it. Why lock-first (§4.2): work in
flight on another instance either finishes before the deletes or arrives to find no row and reports
`order_not_found`, the path that already exists; `TRUNCATE` would take `ACCESS EXCLUSIVE`, block every
reader on every instance, report no counts and demand `CASCADE`. Why deleting the promo ledger is honest
*here* and not in the promo reset (§4.3): the promo reset keeps the orders, so their history must stay; the
demo reset deletes them in the same transaction, so at `COMMIT` there is no order left for a ledger row to
describe, and counter and ledger agree at `0 = 0` by construction. Every count in the response is the
statement's own command tag, never a number read beforehand; a second run reports every count `0` and
`changed: false`. Measured locally: a lock held 8 s → `500` after 5.20 s with `canceling statement due to
lock timeout` (`55P03`), nothing changed; held 3 s → the reset queued, proceeded the moment the `COMMIT`
landed, `removed.orders 1`.

**Drain and restock use a sentinel, on the supplier's side.** `supplier_keys` is the supplier's inventory
— "treat them as if they were in the supplier's own datacentre" — and the shop discovers an empty pool by
being *told* `out_of_stock` across HTTP, never by looking; a drain filed under `/api/admin` would have the
shop holding a switch for its supplier's stock. So the two routes sit beside `PUT
/internal/suppliers/:provider/behaviour`, behind the same guard. Drain is one `UPDATE … WHERE
claimed_by_request_id IS NULL RETURNING id` writing `'drain_' || $1 || '_' || id` — the row's own id in the
value because `claimed_by_request_id` is UNIQUE and a fixed `'drained'` would violate it on the second row;
the token because two runs must never release each other's rows. Restock releases `LIKE 'drain\_' || $1
|| '\_%'` — the escaped underscore is the whole of R15: a real claim begins `req_` and no value of `$1` can
make a pattern that begins with a fixed, escaped `drain\_` reach it. **Never a real claim**: the acceptance
file's RED (a) is the line that goes red the day that `WHERE` is widened to `IS NOT NULL` (A.3), and the
recorded run shows it in the wild — `drain` `claimed 49` and `restock` `released 49` around the one real
`req_…` claim `before-order` had made earlier in the same run. Concurrent with a real claim (Slice 3
§4.4): drain first, the claim's `FOR UPDATE SKIP LOCKED` skips the drain's locked rows and the supplier
answers `out_of_stock` — `UPDATE 0` measured with the drain's transaction held open; claim first, the drain
waits on the locked row and `READ COMMITTED` re-evaluates `IS NULL` after the commit — measured, the drain
blocked **14.31 s** until a held claim committed, then answered `claimed 47`, having left the claimed row
alone. The token's shape is `^[A-Za-z0-9-]{1,64}$` and a `_` is refused with a `400` rather than escaped —
the finding of §6.3 there: inside `LIKE`, an unescaped underscore in the token would be a wildcard within
the sentinel namespace.

**The out-of-stock check speaks HTTP everywhere.** Drain → `out_of_stock` → restock by token in `finally`
→ retry → `delivered`, on every run, locally too, with `DATABASE_URL` gating only the assertions (15 `PASS`
and 15 `SKIP` by name without it, 29 assertions with it). A path exercised only against the live shop is a
path local RED never sees; the check's own RED row was re-run after the switch and the break stayed confined
to what happens after a person presses retry — **9 of 29**, every one after the restock (A.4).

### 4.8 The runner's external mode

`pnpm race` with `RACE_BASE_URLS` set builds nothing and spawns nothing; the target's owner supplies the
instances. Four things it had to learn to say (Slice 4):

- **Not to see the local database.** `scripts/with-env.ts` merges `.env.example` into every run, so an
  external run would have handed each check `DATABASE_URL=…localhost:5433…` — the database half failing on
  `ECONNREFUSED` or, worse, asserting the local Docker database's rows as the target's, and nothing in the
  check can tell the two apart (R7). External mode strips it unless `RACE_DATABASE_URL` puts one back on
  purpose, and the first line says which run this is: `database: none (assertions SKIP by name)` or
  `RACE_DATABASE_URL forwarded`.
- **`SKIP` by name, never a silent pass.** One banner, then every database-side assertion printed with the
  label its `PASS` or `FAIL` would have carried and never counted — 39 of them in the recorded run inside a
  `9/9` that counts only what ran. The orders stay on the target; the banner names the tidying, and
  `RACE_DEMO_RESET=1` makes the runner call the reset after the last check and print the counts, or exit
  `2` if it is refused — a transcript asked to end at baseline and unable to must not exit `0`. The function
  throws if reached in local mode, so a local run's residue can never be swept into a reset's `removed`.
- **To count, and to say what the count means** — §3.4 and §3.6. The negative was staged the only way a
  laptop can stage R3: the same command against *one* of four local targets printed `FAIL  the 8 concurrent
  health answers came from at least two distinct instances — all 8 answers came from one instance — re-run,
  or check that Fluid Compute is off`, ending `race: 0/1` (A.5).
- **To learn the target's timeout.** `recover-timeout` derived `hang_ms = SUPPLIER_TIMEOUT_MS + 1500` from
  its own environment — the local 2000 — and against a live 5000 a 3500 ms hang lands on the
  slow-but-successful side: no timeout, no `unknown`, no re-probe, every HTTP assertion green, nothing
  exercised (R8). It now prefers `supplier_timeout_ms` from the target's `/api/health` and prints the
  source. The precedence was proven locally with `SUPPLIER_TIMEOUT_MS=9999` exported and the line still
  reading `supplier timeout 2000 ms (from target /api/health)` (A.6); R8's own case was then staged live —
  `supplier timeout 5000 ms (from target /api/health)`, `hang_ms: 6500`, the order `delivered` in ~6 s.

Also: the warm-up (`GET /api/products` until `200`, because `/api/health` opens no connection and proves
nothing about Neon's autosuspend — 195 ms in the recorded run), the hint when `ADMIN_TOKEN` is still
`.env.example`'s default, and the `.env.example` port comment that had said `4201-4204` since Phase 2 moved
the runner to `4601-4604`.

### 4.9 Eighteen lines and ten variables

Everything the platform does with this repository is decided by `vercel.json` — `framework: null`,
`installCommand: pnpm install --frozen-lockfile`, `buildCommand: pnpm run build`, `outputDirectory:
apps/web/dist`, `regions: ["fra1"]`, `functions."api/index.js".maxDuration: 60`, and three rewrites in order
(`/api/(.*)` and `/internal/(.*)` to the function with the original `req.url`; everything not under `api/`,
`internal/` or `assets/` to `index.html`) — and by ten production variables (tech spec §2.7): `DATABASE_URL`
(the pooled host, `sslmode=verify-full`), the three self-call URLs on the alias, `SUPPLIER_TIMEOUT_MS=5000`,
`SUPPLIER_MAX_PROBES_PER_REQUEST=2`, `ADMIN_TOKEN` (a fresh demo token), `ALLOW_CLIENT_SUPPLIED_ORDER_ID=true`,
`NODEJS_HELPERS=0`, `ENABLE_EXPERIMENTAL_COREPACK=1`; never `NODE_ENV`. JSON admits no comments, so
`api/index.js`'s header carries the reason for every key beside the one line the configuration exists to
serve, plus the three things that are *not* keys: Fluid off, Node 22.x, `NODE_ENV` unset. `.vercelignore`
exists because the CLI never reads `.gitignore`, and the live shop must be built from the published sources
and not from a laptop's `dist/`.

The timeout profile is sized to a measurement, not a guess: a cold second invocation costs ~1.8 s before
Nest sees the request and 2.38 s end to end, so the local 2000 ms deadline would have read a healthy cold
supplier as `unknown`; 5000 leaves room, probes 2 make the worst case `worst_case_ms 20000` (the boot line
read exactly that), and the trap check's 6500 sits above 5000 and far below 60 000 — architecture §5's
inequality with live numbers in it.

---

## 5. The live run, honestly

### 5.1 Five attempts, two of which were not the shop

The reviewer's command, `RACE_BASE_URLS=https://game-shop-ochre.vercel.app ADMIN_TOKEN=<the demo token>
RACE_DEMO_RESET=1 pnpm race`, was run five times in a row on 16 September, between 11:48 and 11:58 UTC:

| Attempt | Tally | K (harness; promo `LIMIT3`, `ONCEONLY`; same-event; webhooks) | What failed, and why it was not the shop |
|---|---|---|---|
| 1 | 8/9 | **1**; 17, 10; 8; 19 | `harness` — `FAIL … all 8 answers came from one instance`. Eight ~1 ms health calls served back to back by the single warm instance on an otherwise cold platform, while the work checks of the same run were spread over 17, 10, 8 and 19 instances — a Fluid-on platform would not have spread those either. The harness did exactly what Slice 4 designed it to do on the one observable it decides on (§3.6) |
| 2 | 9/9 | 6; 19, 10; 12; 25 | — |
| 3 | 8/9 | not quoted in Slice 5 | `same-event` — one of twenty concurrent redeliveries never got an answer: client-side `fetch failed`, `status 0`; the nineteen that did read `stored=1, duplicate=18`. An undici transport failure between the laptop and the edge; the shop never saw the request or its answer never came back. The invariant held on everything that answered, and the assertion *all 20 concurrent redeliveries answered 2xx* correctly refused to count a request it could not see |
| 4 | 9/9 | 6; 19, 10; 15; 27 | — |
| **5** | **9/9** | **5; 18, 10; 9; 30** | — **the recorded run** |

Two of roughly nine hundred requests over the seven runs failed on the client side with the two-word
message; the second was the author's first full run (§5.3). Node's `fetch` is undici, and undici reports
every transport failure as `TypeError: fetch failed` with the real reason one level down on `error.cause`
— which every check's never-throwing fetch helper had been discarding. The follow-up is
`scripts/race/support/fetch-failure.ts`: `describeFetchError` walks the `cause` chain at most four deep and
prints `fetch failed (cause: <code ?? name>: <message>)`; the nine fetch helpers and `demo-reset.ts` call it,
and the harness's disagreement line now names the request index and its target. No assertion changed, no
retry was added; the cause of these two is unknown and recorded as unknown.

Why the recorded run is #5 with #4 beside it: functional spec §2.2 asks for two things at once — the
author's run on record, and *twice in a row, the second run reports the same verdicts as the first, with no
manual tidying in between*. Attempts 4 and 5 are that pair, identical line for line after normalising ids,
the reset block at the end of #4 the only tidying #5 had. A README that quoted #5 and hid #1 and #3 would be
the dishonest version; the README quotes #5 and says two of five failed, and this document is where
attempts 1 and 3 live with their lines.

### 5.2 The recorded run

`docs/walkthrough/evidence/phase-6-live-race-run.txt`, 285 lines. Its shape, in the order the transcript
prints it: the mode line (`external target(s) … — database: none (assertions SKIP by name)`); the warm-up
(`GET …/api/products → 200 in 195ms (attempt 1 of 6)`); the banner; nine checks, each opening with the
single-target warning the runner prints against one URL (correct for a deployed shop, where the platform
supplies the instances), each closing `passed`; the reset block; the summary. The lines that carry the
phase are in §3.5; the ones that carry the rest:

- `create-order`: `1 distinct id(s) seen` across twenty concurrent Buy attempts under one key, `201: 1, 200:
  19`; a fresh key a different order.
- `before-order`: the early webhook `status=200, outcome=stored`; `404` before the order exists; the order
  created with the pre-chosen id on a different instance; `status=delivered` with no action beyond watching.
- `recover-out-of-stock`: `claimed 49`, `status=out_of_stock`, `released 49`, `released == claimed`, the
  retry `"outcome":"delivered"`, a further retry `409`.
- `recover-refusal`: `fail_next: 1` armed on A; `status=delivered` despite A's refusal.
- `recover-timeout`: `supplier timeout 5000 ms (from target /api/health)`; `hang_ms: 6500`, placed after
  the claim, *the walk will hang 6500ms, past the target's supplier timeout of 5000ms*; `status=delivered —
  the re-probe found A's own ledger already held a code`.
- The durations: harness 782 ms, before-order 1108, create-order 992, promo 1060, recover-out-of-stock
  1919, recover-refusal 1158, recover-timeout **6005**, same-event 843, webhooks **1539**; `race: 9/9 passed
  against 1 instance(s)`.

**The reset's arithmetic**, which is the transcript's own (Slice 5 §6):

```
race:   removed  orders 38 · deliveries 6 · issuance_attempts 9 · promo_redemptions 4 · payment_events 55 · supplier_requests 6
race:   reset    promo_codes 0 · supplier_keys 6 · supplier_behaviour 1
race:   now      products 12 · keys_total 50 · keys_unclaimed 50 · orders 0 · payment_events 0 · deliveries 0 · issuance_attempts 0 · supplier_requests 0 · promo_codes 4 · promo_used_count 0 · promo_redemptions 0 · supplier_behaviour_baseline 2
```

38 orders: `before-order` 1, `create-order` 2, `promo` 30 (twenty for `LIMIT3`, ten for `ONCEONLY`), one
each for the five remaining checks. 55 payment events: the fifty distinct `event_id`s, `same-event`'s one
stored once, one each for the three recover checks and `before-order`. 6 deliveries, hence 6 keys released
and 6 supplier requests (a refusal and an out-of-stock answer write no ledger row). 9 issuance attempts:
three for the out-of-stock check (`a/1, b/2, a/3`), two for the refusal, one each for the other four
deliveries. 4 redemptions — three `LIMIT3` winners and one `ONCEONLY` — with `promo_codes 0` under `reset`
because the promo check had already zeroed its own counters through the promo reset, leaving the ledger it
may not delete. `supplier_behaviour 1`: A's `hang_ms 6500` left armed with `hang_next` at 0 after the trap
check — harmless, not baseline, put back here. "Twice in a row" is true because #4 ended with keys back at
50, counters at 0 and every behaviour row at baseline, not because the checks tolerate residue:
`recover-out-of-stock` would meet `keys_unclaimed 44` after one un-reset run and its drain would assert
against a pool it expects full.

### 5.3 The author's full run

The same command with `RACE_DATABASE_URL=<the direct endpoint>` forwarded, so the mode line reads
`RACE_DATABASE_URL forwarded` and the 39 skipped assertions are made for real. Attempt 1: 8/9, the harness's
own fan-out losing one request to the second `fetch failed`. Attempt 2: **9/9**, zero `SKIP`s, K = 6, 19,
10, 9, 25, and the database's own witness — `26 distinct backend pid(s)`, where the local harness counts 4.
The lines that the reviewer's run could only skip: `used_count = 3 for LIMIT3`, `exactly THREE attempt rows
after the retry (a/1, b/2, a/3)`, `a/1 reads status=ok, probe_count=2`; the checks' own cleanup ran, and
Neon read baseline afterwards. Through a transaction-mode pooler a backend is a pooler-owned server
connection, opened when concurrent transactions needed it and kept afterwards, not one per instance — so 26
is the database's count of how many connections the run needed at once, printed with that limit.

### 5.4 The cold-start numbers

All from the first deploy's curl ladder and the function log (Slice 5 §3, §7):

| What | Measured | Against |
|---|---|---|
| A cold instance | **1.81 s** of platform init + **29 ms** of Nest `init()` | R1's estimate 1.5–2.5 s; the number is inside it |
| `/api/health` right after the deploy | 0.444 s, then 0.325 s | Instances the platform had pre-initialised; a warm repeat is ~0.15 s |
| `POST /api/orders` | 0.97 s | With a Neon `start_compute` inside it |
| The simulator's self-call, cold | **2.38 s**; `delivered` at **t+4.31 s** | A second invocation, cold, inside the first: the price of one purchase on a cold platform |
| The manual drive's purchase | «Ключ выдан» in about three seconds | The shopper's version of the same path, warm |

The profile follows from the first row: 2000 ms would have read a healthy cold supplier as `unknown`, and
5000 with two probes is what §4.9 set.

### 5.5 Neon's suspend, and two clocks

Neon's log shows `suspend_compute` 5 min 15 s after the last query. Six minutes after the ladder,
`GET /api/health` answered in **0.226 s** — the function instance was still warm — and the next `GET
/api/products` took **0.793 s**, the `start_compute` on the first query. Two idle clocks, and the shorter one
is the database's: a shopper arriving after a pause of between five minutes and however long the platform
keeps an instance pays Neon's resume and not the platform's; after a longer pause, both — roughly 1.8 s
plus 0.8 s. `connectionTimeoutMillis: 10_000` covers both with room; the runner's warm-up absorbs the first
for the checks; the README's "the first request may take a few seconds" is the shopper's version.

### 5.6 The cross-process guard, caught in the log

During the curl ladder — one order, one simulated payment, no race check — the function log recorded:

```
"the guarded claim matched zero rows; this call does not own the order","locked_status":"delivering"
```

The shape (Slice 5 §8.4): the simulator delivered the webhook to instance B, which stored the event,
answered `200` and continued under `waitUntil` into the issuance ladder; meanwhile the poll of `GET
/api/orders/:id` landed on instance A, whose status-poll drain — Phase 2's "answer, then work" — found the
pending event and tried the guarded `paid → delivering` update, which matched zero rows because B had
already moved the order on. A logged that it does not own the order and stepped back; B finished, and the
key arrived at t+4.31 s. This is I4 doing on two instances what Phase 2 proved it does on four laptop
processes, and it was not staged: the shop's own two triggers on two random instances produced the
contention, and the database decided it. It is the smallest possible version of the phase's sentence.

### 5.7 The manual drive

Through the Playwright MCP against the alias, with a person watching: the five storefront interactions,
Купить, `LIMIT3` applied (the price recomputed on the server), «Оплатить успешно», «Ключ выдан» with the
key, a reload, the operator's view with the demo token; zero console errors beyond the intentional `4xx`
resource lines. Four screenshots, `docs/screenshots/006-live-{storefront,order-with-promo,delivered,admin}.png`,
timestamped 13:57–13:59 on the day of the runs, 20–213 KB. `pnpm demo:reset` afterwards. This is the manual
cover for the one thing the tech spec's §4 lists as not done — no Playwright *suite* against the live URL
(§9).

---

## 6. The written answer

### 6.1 What the README asserts, and where each assertion's evidence is

`README.md`, 162 lines, in Russian except commands, addresses, file names, codes and the shop's own
messages. Each section's claim with the place it can be checked:

| README section | What it asserts | Where the evidence is |
|---|---|---|
| §1 «Живая витрина и исходники» | The alias and the repository address; the demo's flow (Купить → `LIMIT3` → «Оплатить успешно» → «Ключ выдан»); `/admin/recovery` opens by token; the token is the live demo's only, published on purpose, and differs from the local default | The four `006-live-*` screenshots (§5.7); the token's own label in the README, and R16; the local default in `.env.example` |
| §2 «Запуск локально» | Node ≥ 22.18, pnpm 10, Docker; `pnpm install` / `pnpm db:setup` / `pnpm dev`; what `/api/health` answers (`runtime: "node"`, `supplier_timeout_ms: 2000`); the three suites and their counts (17 / 144 + 6 / 69; 10 files / 65; 9/9) run one at a time | The clean-clone rehearsal (§6.2), which ran every command as written |
| §3 «Как воспроизвести гонки» | Four real processes locally and why one is not enough (20-vs-9); the nine checks and what each proves; the live command; `SKIP` by name never counted; the reset; the paragraph on an `8/9` with only `harness` failing; the recorded run's key lines; two of five failed and why; the author's run with `26 distinct backend pid(s)`; the one bold sentence about separate processes | `docs/walkthrough/evidence/phase-6-live-race-run.txt` line for line; §5.1 for the attempts; architecture §7 for 20-vs-9; `scripts/race/README.md` for the mode |
| §4 «Как гарантирована единственная выдача» | One paragraph: the winning `INSERT` on `deliveries.order_id UNIQUE`; the order row lock and the status-guarded `UPDATE`; `FOR UPDATE SKIP LOCKED` on the pool with `claimed_by_request_id UNIQUE`; the inbox keyed by `event_id` | `phases-1-to-5.md` (the long form, linked); architecture §3's invariant table with the SQL |
| §5 «Ключевые решения и компромиссы» | Eight decisions, each with its cost: Postgres as the inbox; serverless for the proof (with the measured cold-start numbers); `READ COMMITTED` plus explicit locks; no webhook signature; the demo affordances and the published token; no Vercel Cron; R6 documented, not closed; what was consciously not done | §5.4 for the numbers; §4.7 and §8 for the affordances; architecture §9 |
| §6 «Две карты» | Five scenarios → `pnpm race <check>` + the guarding test file; five interactions → `apps/web/e2e/<spec>` | Every file named exists (the rehearsal's `ls`); `scripts/race/README.md`'s RED rows |
| §7 «Затраченное время» | The per-phase table beside the roadmap's estimates, 50.0 h total; the method sentence; the exclusions; the three readings (70 h, ~12 h) | §7 below; the scratchpad table the author confirmed |
| §8 «Где читать дальше» | The map, the phase walkthroughs, the slice walkthroughs, the runner's README, the architecture, the specs | This folder |

Every number in the README that this document also carries agrees with this document's source; the
README's own text was rehearsed rather than re-derived (§6.2).

### 6.2 The rehearsal

Tested by following it (tech spec §4's last bullet): a clean clone on the author's machine, with
`POSTGRES_PORT=5434` and a distinct Compose project name so the running stack was untouched — the one noted
deviation from the README's text. `pnpm install` (the `prepare` hook built `packages/*`), `pnpm db:setup` (7
migrations, the seed), `pnpm dev`, `curl /api/health`, `pnpm race` **9/9**, `pnpm test` **17 / 144** + **6 /
69**, `pnpm test:e2e` **65**. One README edit was needed, and it is the paragraph §3.6 ends on: what an
`8/9` with only `harness` failing means on a cold platform, and that re-running is the remedy. The clone and
its containers and volumes were deleted afterwards.

### 6.3 The publishing, and live = published

`gh repo create --public --source=. --push` created `https://github.com/dustyo-O/game-shop`; the Git
integration was left unconnected (no auto-deploy on push — out of scope, and a deploy from a dirty tree
would break the next sentence). Before it, a secret scan of the tree — `postgresql://`, `neon.tech`,
`npg_`, `VERCEL_OIDC`, keys — found nothing; the demo token appears in the README only, by design (R16;
§8). The repository address went into the README's placeholder as commit `2152986`, and the final
`vercel --prod --yes` ran from that committed tree: `dpl_5Kam2ikY5xtdBtiSHn2nvukoQND9`, built in 41 s, and
Vercel records `2152986` as the deployment's `githubCommitSha`. The live shop equals the published sources —
which is the standing rule "deploy only from a clean, committed tree" made checkable by anyone who compares
the two hashes.

---

## 7. The time report

### 7.1 The table

Reconstructed, not remembered (functional spec §2.5; tech spec §2.9): a throwaway script in the scratchpad
— never committed — over `git log` (17 commits, 7–16 September), the two main Claude Code transcript files
for this project with their 238 subagent transcripts, the roadmap's estimates, and the dated lines in the
walkthroughs. Presented to the author as a per-phase table with the sources per row, and confirmed before a
number was written into the README.

| Phase | Roadmap estimate | Active hours (30-minute rule) | Days |
|---|---|---|---|
| Phase 0 — setup, product definition, roadmap, architecture, hire | — | 1.9 | 2 (1, 2 Sep) |
| Phase 1 — catalogue and purchase pipeline | ~3 h | 10.3 | 6 (2–7 Sep) |
| Phase 2 — single issuance under races, reproducible checks | ~4 h | 8.8 | 3 (7, 8, 10 Sep) |
| Phase 3 — unreliable suppliers, recovery | ~3.5 h | 12.2 | 3 (10, 11, 13 Sep) |
| Phase 4 — the storefront per the design, and its wiring | ~3 h | 5.5 | 2 (13, 14 Sep) |
| Phase 5 — promo codes with enforced limits | ~1.5 h | 5.4 | 1 (14 Sep) |
| Phase 6 — live and reproducible; the written answer (to 16 Sep 14:14) | ~2 h | 5.9 | 3 (14, 15, 16 Sep) |
| **Total** | **~17 h** (roadmap budget 13–19 h; "~25 by hand") | **50.0 h** | 14 distinct days, 1–16 Sep |

The estimates are the roadmap's items summed per phase; the roadmap's ~17 h also assumed AI-assisted
implementation, and the README shows both figures side by side as the functional spec asks.

### 7.2 The method, and the three readings

*Active time* is the length of working windows reconstructed from the transcripts — the author's typed
messages, slash commands, accepted suggestions and interrupts, plus the assistant's main-thread turns and
tool results — where consecutive events at most 30 minutes apart belong to one window and a longer gap
closes it; windows are cut at phase boundaries fixed by the author's `/awos:*` messages and the commit
history, and summed per calendar day. The 30-minute rule was chosen and its sensitivity recorded: at 15
minutes the same events give 30.8 h, at 60 minutes 58.9 h.

The same windows counted three ways, because the number depends on what one thinks is being measured:

| Reading | Hours | What it counts |
|---|---|---|
| The author's own attention | 4.2 h strict; **~12 h** (12.4) with a 10-minute allowance per message | Only the author's messages — the floor; the allowance is the time to read a reply and type the next move |
| **Active** — the README's headline | **50.0 h** | The author's messages plus the assistant's main-thread turns and tool results; a background agent that ran silently for more than 30 minutes while the main thread waited breaks the window, so pure waiting is not counted |
| Session-elapsed, including background agents | 70.0 h | Every timestamp in the subagent transcripts added to the stream, so time when only a background agent was producing output also counts |

**What it measures.** An AI coding agent, orchestrating specialist sub-agents under the author's direction,
plus the author's own hands on it — the README says so in as many words, and the 50 h is the second row
because that is the process that produced the tree. The strict 4.2 h is what a stopwatch on the author's
keyboard would have read; the 70 h is what a clock on the wall of the session would have read.

**What it excludes.** Reading the brief before 1 September; anything done outside a Claude Code session —
the Figma file, the Vercel and Neon dashboards, thinking away from the keyboard; the subagent transcripts as
evidence of the author's attention; and the stretches while background agents ran without any author or
main-thread event for more than 30 minutes (three planners running through one night, an agent stalled for
eleven hours, the internet outage of 5–6 September, the "pause all development" of 13–14 September — none
of them cost an hour). Phase 6 was counted up to 16 September 14:14, before the README, the rehearsal and
the publishing; the hours after that are not in the table, and the README says so.

---

## 8. Assumptions a reviewer might challenge

The eleven in `technical-considerations.md`'s assumptions list and the alternatives the slice walkthroughs
argued against, each with its one-sentence defence and what flipping it would take.

| # | Assumption | The defence | To flip it |
|---|---|---|---|
| 1 | **Fluid Compute off** — the platform's default is on, and on is cheaper | On, one instance serves many concurrent invocations: the `max: 1` pool serialises them in Node before Postgres sees them, `waitUntil` contexts interleave, K reads 1 — architecture §7's single-process shape, measured as worthless for a race. A shop that passed under Fluid would have proved nothing about where the guarantee lives. The costs are real and listed: cold starts (1.81 s), a default timeout that drops to 10 s and has to be overridden, more instances per burst | One `PATCH` — and the README's sentence, the harness's verdict and this document's §3 all become false |
| 2 | **`fra1`** and Neon's `aws-eu-central-1` | Either pair works; they must pair. With a `max: 1` pool every request pays the database round trip on every statement — the one cost that repeats — and keeping function and database in one region keeps it single-digit milliseconds. The build ran on `iad1`, which is where Vercel builds and has nothing to do with where the function runs | Move both; moving one puts a WAN round trip on every statement — Slice 2 measured ~35 ms from a laptop against ~5 on Docker, and one process starved on it |
| 3 | **The published token** | The shop has no real shoppers and no real money; the worst the token allows is what the reset undoes — put the demo back to baseline, or arm a supplier hang or refusal that the next reset or the next check's own `PUT` clears. It reaches only the admin routes and the supplier knobs, never a secret; it differs from the local default so the README can label it as the demo's; R16 accepts the trade by decision, and a reviewer who can reset the shop is a reviewer who can run the checks twice, which is the point | Rotate it (`vercel env add`) and hand it out on request — one fewer thing a stranger can verify without asking |
| 4 | **`ALLOW_CLIENT_SUPPLIED_ORDER_ID=true` on the demo** | Without it `before-order` cannot be staged: the scenario needs an order id known before the order exists. The flag's "must never be set where real shoppers can reach it" stands; the demo is the one named exception, because it has no real shoppers and `pnpm demo:reset` returns it to baseline, and the boot-time `warn` says so on every instance with the carve-out sentence | Unset it; `before-order` takes its `SKIP` branch against the alias and one of the five scenarios is proven locally only |
| 5 | **The reset's scope** — six tables, every key, every counter, the promo ledger | Each is what "the seeded state" means, and each is inside one transaction that takes every order's lock first (§4.7); deleting the promo ledger is honest here because the orders it describes go in the same `COMMIT`; the promo reset elsewhere keeps the ledger *because* it keeps the orders. Local checks never call it and the runner refuses to in local mode | A narrower reset leaves residue — `keys_unclaimed 44` — and "twice in a row" stops being true for the out-of-stock check |
| 6 | **`pg` over `@neondatabase/serverless`** | Neon's driver is for runtimes that cannot open TCP, and a Vercel Node function can. Swapping at the deployment boundary would leave architecture §7's 20-vs-9 table and `client.ts`'s prepared-statement argument true on a laptop and assumed in production. One driver keeps both measurements about the thing that is running | `Database` is an alias; one import line — and two measurements to redo against the new driver |
| 7 | **`sslmode=verify-full`**, not `require`, not a pinned CA | `require` is `verify-full` with a `SECURITY WARNING` per cold start today and no verification in pg 9; a pinned CA is a copy Neon will rotate on its own schedule, turning the pin into an outage that looks like Neon being down. `verify-full` against Node's maintained root store checks the chain and the hostname today and after the rotation | One query-string word — and a warning line in every cold instance's log |
| 8 | **The alias, not the deployment URL** | Deployment Protection's defaults gate every per-deployment URL behind a login and leave the production alias public; the shop calls itself on three URLs, and a self-call to a gated URL answers a `401` login page the issuance client would read as a definite refusal and fall through to B — R6, a real order lost to a platform setting. The alias also survives the next deploy, which is the address the README must carry. `VERCEL_URL` is never read | Turn protection off for previews, or accept that previews cannot sell a key |
| 9 | **The 30-minute rule** | A gap rule is the only way to turn a stream of timestamps into hours without remembering; 30 minutes is the conventional reading of "stepped away", the sensitivity to 15 and 60 is recorded (30.8 h / 58.9 h), and the strict author-attention floor (4.2 h) and the session-elapsed ceiling (70 h) are both shown so the headline is bracketed rather than asserted | Any other rule — the README would show a different number with the same bracket around it |
| + | **The harness burst is not retried on K = 1** | A witness that retries until it sees ≥ 2 cannot fail, and a witness that cannot fail is not a witness; attempt 1's `FAIL` is a true statement about that burst at that moment, the `FAIL` line names the remedy, and a person re-running has two consecutive runs to compare, which is the criterion anyway | A retry loop in `harness.ts` — and a `PASS` that costs nothing |
| + | **No Playwright suite against the live URL** | The e2e config starts its own servers on 5101/5102 and takes no base URL; the manual drive covered the shopper's path with screenshots; a live suite would need a `baseURL` mode, its own reset discipline, and would run the same assertions against the same static bundle | A `PLAYWRIGHT_BASE_URL` mode in the config and a reset in `globalSetup` |
| + | **The `503` boot probe and `maxDuration: 60` are configured and proven elsewhere, not exercised live** | Every variable was right the first time, and staging the `503` live means deploying a broken environment on purpose — the acceptance test on `node:http` is the cheaper proof. The recorded run's longest continuation (~6 s) sits under the default 10 s as well; a run that exercised the override would need a ladder walk past 10 s, which no check stages and no check should, since it would leave an order in `delivering` if the override were missing | A deliberate bad deploy, and a check that risks a stranded order |

---

## 9. What is not finished

- **R6 is open by decision.** The apply-vs-pay window — a code applied to a `created` order in the
  milliseconds between the simulator's unlocked read of the amount and `markPaid` lands on a list-price
  payment, because the processor never compares amounts. Documented in architecture §9 and README §5 with
  the honest fix named (compare `payment_events.amount_minor` to `orders.amount_minor` under the order lock;
  route a mismatch to `payment_failed`); closing it changes the payment path and the fifty-webhook race's
  staged amounts; spec 005's §3 put it out of that phase, and spec 006 changes no behaviour by rule.
- **No Playwright suite against the live URL.** The e2e config starts its own servers and takes no base
  URL; the manual drive through the Playwright MCP — five interactions, buy, `LIMIT3`, pay, key, reload,
  the operator's view, zero console errors — covers the shopper's path, and the four screenshots are its
  record. Stated as not done, per tech spec §4.
- **The harness's K = 1 on a cold platform is documented, not auto-retried.** §3.6 and §8: the weak spot
  exists, its shape is recorded, the README tells the reviewer what an `8/9` with only `harness` failing
  means, and the remedy is a re-run by a person. The endpoint was not swapped for `/api/products`, which
  would make the witness depend on Neon being awake.
- **The `fetch failed` cause is unknown, and is now printed.** Two of roughly nine hundred requests; the
  helper in `scripts/race/support/fetch-failure.ts` walks `error.cause` so the next one names itself. Until
  one happens, unknown is what the record says.
- **The reset's `duration_ms` on Neon is unrecorded.** Slice 3 asked for one timing on a quiet host and one
  against Neon (the local number, 2.7–3.3 s, was taken at a load average of 14 against 308 ms for a no-op
  and 1.16 ms of execution for the slowest statement); the runner prints counts, not the timing. One
  `pnpm demo:reset` with the response body read in full would settle it.
- **Two recover checks still `SKIP` their database half as one blanket line** — `recover-refusal` and
  `recover-timeout` print `SKIP every database assertion below — needs DATABASE_URL` where
  `recover-out-of-stock` prints fifteen labels. The rule — never counted — holds; the by-name half is
  honoured at the block, not the assertion (Slice 4 §9).
- **The Phase 4 manual check is still outstanding.** `phase-4.md` §6's placeholder — the one-minute
  real-Chrome back/forward-cache verdict that covers the banner's restart and Купить's re-enable after Back —
  is still unfilled (checked by reading the file while writing this), and nothing in this phase changes
  that.
- **Slice 7's acceptance pass — done after this was written** (`phase-6-slice-7-acceptance.md`: 30 rows, 0 not covered anywhere by name; the final run e2e 65 / race 9/9 / test 17-144 + 6-69 / live 9/9 after the documented cold `8/9`). When this section was written: the 30-row coverage table over functional spec 006's
  criteria (covered in `<file>` / verified live in slice N with the transcript / a document / not testable
  at this layer and why), `@spec` on the three new test files, `@regression` per the convention, the
  three-suite run in R13's order plus one more live run, `phase-6-slice-7-acceptance.md`, the spec marked
  Completed and the roadmap ticked. The counts in §1 are this document's evidence window, not Slice 7's.
- **The hours after 16 September 14:14 are not in the time table** — the README, the rehearsal, the
  publishing, the final deploy and this document. The README says where its count stops.
- **The small items each slice reported, as they stand in the tree today.** *Closed since* — re-checked by
  `grep` while writing: Slice 1's misquoted RED line in the unit file's header (it now reads `promise
  resolved "undefined" instead of rejecting`), the tech spec's paragraph that filed the instance-id
  assertions under `demo-routes.test.ts` on 5401 (§4 now names `vercel-entry.test.ts`), the scheduling
  module's "seam still open" comment; Slice 2's three (the `slice-4` swap sentence, `seed.ts`'s "the platform
  supplies it", Slice 3's "nothing has run against Neon"); Slice 3's four (`support/db.ts`'s three "nothing
  in apps/api ever clears" sentences now scoped to production paths, the tech spec's "no request body" now
  naming `{ token }`); Slice 4's four (`promo.ts`'s "unreachable under `pnpm race`" now scoped to local mode,
  the harness's database-side wording, the runner's rule 4 with its "when it has a database" clause, Slice
  3's `14 SKIP` now `15`); Slice 5's eight (Slice 4's three "never run / unmeasured / unstaged" bullets and
  Slice 2's cold-compute bullet now carry the measured values, `api/index.js` says Node 22.x is the project
  setting, `.env.example` says *default* timeout, the tech spec's Fluid sentence names the API field and the
  default). *Still open* — none found: every sentence the five slice walkthroughs listed as made false has
  its correction in the tree.
- **Out of scope by design:** a custom domain; monitoring and alerts; CI and auto-deploy (the deploy is a
  manual step from a committed tree, and the Git integration is deliberately unconnected); Vercel Cron (on
  the Hobby plan it runs roughly daily — useless as a safety net; the four processing triggers are the
  design); preview deployments with their own database branch; a webhook signature (waived by the brief).

---

## 10. Where the evidence lives

| Evidence | Path | Read it for |
|---|---|---|
| The recorded run | `docs/walkthrough/evidence/phase-6-live-race-run.txt` (285 lines) | Every K line, every `SKIP`, the trap check's `5000 ms (from target /api/health)`, the reset block, the nine durations, `9/9 passed against 1 instance(s)` |
| The manual drive | `docs/screenshots/006-live-storefront.png`, `006-live-order-with-promo.png`, `006-live-delivered.png`, `006-live-admin.png` | The five interactions, `LIMIT3` applied with the recomputed price, «Ключ выдан», the operator's view with the demo token |
| Slice 1 — one function, proven locally | `phase-6-slice-1-one-function-proven-locally.md` | The container and its two doors; the promise cache and the six-concurrent measurement; the `abortOnError` finding with its line numbers; the seam's closing; the self-call bound at 10.007 s; the three REDs |
| Slice 2 — Neon | `phase-6-slice-2-neon-holds-the-shops-memory.md` | Transaction mode and the audit grep; the no-swap decision; `verify-full` and pg 9; migrations in one transaction from a laptop; the single-instance starvation at WAN latency and why it is §7 and not a pooler defect |
| Slice 3 — reset, drain, restock | `phase-6-slice-3-reset-drain-restock.md` | The two forbidden half-states; lock-first and the `55P03` measurement; the ledger deleted here and kept there; the sentinel, the escape and the 14.31 s wait; the three REDs and the 9-of-29 |
| Slice 4 — the runner | `phase-6-slice-4-the-runner-tells-the-truth.md` | Environment hygiene; `SKIP` by name; what K proves and does not; the two negatives (`0/1` on one target; `9999` ignored); the reset after a no-database run |
| Slice 5 — live | `phase-6-slice-5-live.md` | The numbers table; why the pass is evidence and not a new argument; the five attempts; every "verify on first deploy" item with its observed answer; the eight findings, Fluid's default and the 300 → 10 s among them |
| The written answer | `README.md` (Russian, 162 lines) | The five items under their own headings; the two maps; the time table; the demo token, labelled |
| The three test files | `apps/api/test/acceptance/vercel-entry.test.ts` (5401), `apps/api/test/unit/wait-until-continuation-scheduler.test.ts`, `apps/api/test/acceptance/demo-routes.test.ts` (5402) | The REDs, verbatim in the headers (Appendix A) |
| The configuration | `vercel.json`, `api/index.js` (the key-by-key header), `.vercelignore`, `.env.example` (the live-profile comments) | Why each of the eighteen lines is there; the three things that are not keys |
| The runner's README | `scripts/race/README.md` | "External mode", "The instance-id witness", "Which assertions need database access", the port row with 5401 and 5402, the paragraph on one local instance against a hosted database |
| The architecture, as amended | `context/product/architecture.md` §2 (the driver), §5 (the layout, Fluid off, the boot probe, the measured cold boot, the trap row's live numbers), §6 and §7 (the affordances that clear a claim; the HTTP witness beside the pid proof), §9 (the three trade-off bullets with the measured costs) | Every amendment marked *Amended in Phase 6* with the old wording kept as history |
| The requirements | `context/spec/006-live-shop-and-the-written-answer/functional-spec.md` (§1, §2.1–§2.7, §3), `technical-considerations.md` (§1, §2.1–§2.11, R1–R17, §4, the eleven assumptions), `tasks.md` (the standing requirement and the six slices) | What was planned, and — in Slice 5 §7 — what each plan sentence turned out to be |
| The time table's sources | The scratchpad's `phase-6-time-table.md` and `time-reconstruction.py` — **not committed**, by the task's design; the README's §7 is the published form | The per-day list, the sensitivity table, the assumptions and judgment calls, the sources per row |

**On evidence:** what was run fresh while writing this document, against the tree at `2152986` with one
modified path (`tasks.md`), with no server started, no port bound, nothing sent to the live shop, and no
database — local or hosted — touched: `git log --oneline -12` and `git status --short`; `wc -l` over
`vercel.json` (18), `.vercelignore` (32), `api/index.js` (93), `README.md` (162), the evidence transcript
(285) and the five slice walkthroughs; `ls -la docs/screenshots/006-live-*.png` (four files, 20 697 to
212 822 bytes, 13:57–13:59 on 16 September); `git log -1 --date=iso 2152986` (16 September 15:02:17 +0200);
`grep` over the three test headers for their `RED VALIDATION` blocks, quoted below; `grep` for every
sentence the five slice walkthroughs listed as made false (§9's last bullet — all corrected); `grep -n
PLACEHOLDER docs/walkthrough/phase-4.md` (line 726, still there); the evidence transcript read in full and
every line §3.5, §5.2 and Appendix A quote found in it verbatim; the README, the five slice walkthroughs,
the tech spec, the functional spec, `phase-5.md`'s sections, the architecture's §5, §7 and §9 amendments, the
map's lead and §1, the findings notes and the time table read for this document.

Everything else is quoted from the five slice walkthroughs, the three test headers, the transcript, the
README and the last three task reports, never re-run: every K line and duration; the deployment ids, build
times and the `githubCommitSha`; the cold-start, self-call and suspend timings; the lock, drain and
checkpoint measurements; the single-instance starvation figures; the rehearsal's counts; the secret scan;
the time reconstruction's every figure. `pnpm test`, `pnpm test:e2e`, `pnpm race`, `pnpm demo:reset` and any
request to the alias were not run for this document: the task forbids it, and none of them is needed to
quote a number that a walkthrough already recorded with its method.

---

## Appendix A — every RED and every measured line, quoted

Every deliberate breakage across Phase 6's three test files and the one re-run check row, with the failing
line verbatim from the file's own header or the slice walkthrough, and the measured lines the sections
above lean on, so a reviewer can find each in one place.

### A.1 `apps/api/test/acceptance/vercel-entry.test.ts` — two inversions, port 5401

The implementation existed before the file, so RED is the inversion `promo-codes.test.ts` established for
that situation: one assertion flipped, run, quoted, restored byte-identical, no source under `src/` touched.
Two inversions, applied and run separately:

1. "body `instance_id` equals the `x-instance-id` header" — inverted to `.not.toBe(headerInstanceId)`:
   ```
   AssertionError: body instance_id must equal the x-instance-id header: expected '<uuid>' to not be '<uuid>'
   ```
2. "a misconfigured instance answers 503" — inverted to `.toBe(200)`:
   ```
   AssertionError: a misconfigured instance answers 503 for its whole life: expected 503 to be 200
   ```

Reverted: 7 tests, 6.93 s, green. The file also asserts the database baseline before and after, because
`POST /api/orders` writes a row.

### A.2 `apps/api/test/unit/wait-until-continuation-scheduler.test.ts` — one inversion

"a rejecting continuation reaches the platform as a fulfilled promise" — `.resolves.toBeUndefined()` became
`.rejects.toBeInstanceOf(Error)`:

```
node scripts/with-env.ts pnpm --filter @game-shop/api exec vitest run test/unit/wait-until-continuation-scheduler.test.ts
→ Test Files  1 failed (1)  /  Tests  1 failed, 2 passed (3)  /  Duration  ~250ms

AssertionError: promise resolved "undefined" instead of rejecting
```

Vitest's own framing for `.rejects` on a promise that in fact fulfilled — the class kept its promise: the
rejection never reached the platform. Reverted: 3 passed, 0 failed.

### A.3 `apps/api/test/acceptance/demo-routes.test.ts` — three inversions, port 5402

Applied and run one at a time, 12 of 13 passing each time, `assertBaseline` holding before and after every
run:

- (a) "the real claim (`req_...`) is untouched by drain+restock" — inverted to `.toBe(0)`; this is R15's
  guard, the line that goes red the day `restock`'s `WHERE` is widened to `IS NOT NULL`:
  ```
  AssertionError: the real claim (req_...) is untouched by drain+restock — R15's whole guarantee: expected 1 to be +0 // Object.is equality
  ```
- (b) "a second call on an already-reset shop changes nothing" — inverted to `.toBe(true)`:
  ```
  AssertionError: a second call on an already-reset shop changes nothing: expected false to be true // Object.is equality
  ```
- (c) "removed equals exactly what this test created" — `removableBefore` spread with `orders` reduced by
  one:
  ```
  AssertionError: removed equals exactly what this test created — a rowCount from the transaction itself, not a recomputed guess: expected { orders: 2, deliveries: 1, …(4) } to deeply equal { orders: 1, deliveries: 1, …(4) }
  ```

Reverted: 13 tests, 5.13 s, green.

### A.4 `scripts/race/README.md`'s `recover-out-of-stock` row — re-run after the switch to HTTP

The same cut as before: the ladder's `IssuanceRound.Fresh` branch removed, so an operator's retry recomputes
`settleRefused` from the two refusals already on file instead of asking anyone. The twenty assertions up to
and including the restock passed — `drain` `"claimed":50`, the pool empty before paying, `restock`
`{"released":50}`, `released == claimed` — and **9 of 29** failed, every one after the restock, starting with:

```
FAIL  the retry report says delivered: true — {"outcome":"still_out_of_stock",…,"delivered":false}
```

against a pool the check had just refilled to 50. The staging is HTTP on every run and untouched by the
weakening; the break is confined to what happens after a person presses retry.

### A.5 The harness's negative for K — one target, local

The external command against *one* of four hand-spawned local instances:

```
FAIL  the 8 concurrent health answers came from at least two distinct instances — all 8 answers came from one instance — re-run, or check that Fluid Compute is off
race: 0/1
```

The shape a Fluid-on deployment would produce, staged the only way it can be staged on a laptop.

### A.6 The precedence negative for R8 — `9999` ignored

`recover-timeout` with `SUPPLIER_TIMEOUT_MS` unset in the runner's shell, and again with
`SUPPLIER_TIMEOUT_MS=9999` exported; both printed:

```
supplier timeout 2000 ms (from target /api/health)
```

The second is the proof: a value the old code would have used — an 11 499 ms hang — was ignored in favour of
the target's. R8's own case then printed, live: `supplier timeout 5000 ms (from target /api/health)`,
`hang_ms: 6500`.

### A.7 The reset's lock bound — `55P03`

With `psql` holding `SELECT id FROM orders FOR UPDATE` in an open transaction for 8 s: the reset answered
`500` after 5.20 s with `canceling statement due to lock timeout` (SQLSTATE `55P03`), the transaction rolled
back, nothing changed. With the same lock held for 3 s: the reset queued, proceeded the moment the `COMMIT`
landed, and answered `removed.orders 1`.

### A.8 The drain against a held claim — 14.31 s

With a real claim's transaction held open on its row: the drain blocked for **14.31 s** until that
transaction committed, then answered `claimed 47`, having re-checked `IS NULL` after the commit and left the
claimed row where it was. The mirror image, with the drain's transaction held open: the claim's `SKIP
LOCKED` subquery found nothing and the outer statement reported `UPDATE 0`.

### A.9 The cold-boot timings

From the first deploy's function log and curl ladder: platform init **1.81 s** + Nest `init()` **29 ms** on a
cold instance; `/api/health` 0.444 s then 0.325 s right after the deploy; `POST /api/orders` 0.97 s with a
Neon `start_compute` inside; the simulator's cold self-call **2.38 s**, `delivered` at **t+4.31 s**; a warm
repeat ~0.15 s. Neon `suspend_compute` **5 min 15 s** after the last query; six idle minutes later
`/api/health` **0.226 s** (the instance kept), `/api/products` **0.793 s** (the resume). The local self-call
bound: `502 … no answer from … within 10000 ms` at 10.007 s.

### A.10 The recorded run's lines that carry the phase

```
race: external target(s) https://game-shop-ochre.vercel.app — database: none (assertions SKIP by name)
race: warm-up — GET https://game-shop-ochre.vercel.app/api/products → 200 in 195ms (attempt 1 of 6)
  PASS  the 8 concurrent health answers came from at least two distinct instances — 5 distinct instance id(s) across 1 target(s)
        A distinct id proves a distinct process, not that those processes overlapped in time.
        K = 1 on a run means that run was not cross-process evidence, whatever the checks after it say.
  INFO  answers came from 18 distinct instance(s) — 20 answer(s)
  INFO  answers came from 10 distinct instance(s) — 10 answer(s)
  supplier timeout 5000 ms (from target /api/health)
  INFO  answers came from 9 distinct instance(s) — 20 answer(s)
  PASS  exactly one of the concurrent copies was stored as first sight; every other one was acknowledged as a duplicate — stored=1, duplicate=19, unrecognised=0
  INFO  answers came from 30 distinct instance(s) — 50 answer(s)
  PASS  all 50 reports were acknowledged as first sight ("stored") — 50 of 50 — I2 must not treat a distinct event_id as a duplicate
  PASS  the order settles delivered — status=delivered
race:   removed  orders 38 · deliveries 6 · issuance_attempts 9 · promo_redemptions 4 · payment_events 55 · supplier_requests 6
race:   reset    promo_codes 0 · supplier_keys 6 · supplier_behaviour 1
  PASS  recover-timeout          passed (6005ms)
  PASS  webhooks                 passed (1539ms)
race: 9/9 passed against 1 instance(s).
```

And the author's run's one line the reviewer's cannot print: `26 distinct backend pid(s)`.

### A.11 The single-instance starvation, for the record

`pnpm race webhooks` from one local `dist/main.js` against the pooled endpoint, twice: fifty events stored
in about two seconds; fifty continuations queued in Node on one connection at ~30 ms a round trip, median
wait ~10 s, the longest ~18 s; the in-process supplier stub past its 2000 ms deadline — `issuance: UNKNOWN
outcome — the request is outstanding; the same id must be re-asked, never another supplier`; the polls
past `connectionTimeoutMillis` at 10 s answering `500`; the order `delivered` about 11 s later with one
delivery, both runs. The harness against the same target: one backend pid, K = 1, `FAIL`. The shape the
live run must not show, and — at 1539 ms for the same check — did not.
