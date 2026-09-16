# Phase 6 · Slice 5 — Live

> This is the slice where the shop leaves the laptop. What exists after it is one public address, `https://game-shop-ochre.vercel.app`, serving the storefront from `apps/web/dist` and the whole API from one Node function in Frankfurt (`fra1`), with Fluid Compute **off** so that every concurrent request is its own instance, and the shop's memory in a Neon Postgres in `eu-central-1` reached through the pooled endpoint with the same `pg` driver as locally. One deployment, `dpl_H3dkL5L33UBV49kaSQquWY3MP97Q`: built in 57.8 s, `λ api/index (1.93MB) [fra1]`, pnpm 10.18.0 through corepack, Node 22.x, zero tracing warnings, zero build errors. Against that address the reviewer's one command — `RACE_BASE_URLS=https://game-shop-ochre.vercel.app ADMIN_TOKEN=<the demo token> RACE_DEMO_RESET=1 pnpm race` — was run five times; the last two passed `9/9` back to back and the fifth is the recorded transcript, `docs/walkthrough/evidence/phase-6-live-race-run.txt`. The author's run with the database forwarded passed `9/9` with zero `SKIP`s and `26 distinct backend pid(s)`. A person drove the live shop through a browser: five storefront interactions, buy, `LIMIT3`, «Оплатить успешно», «Ключ выдан» in about three seconds, the operator's view with the demo token, zero console errors — four screenshots under `docs/screenshots/006-live-*.png`. Nothing about the shop's behaviour changed: the slice added `vercel.json`, `.vercelignore`, `api/index.js`'s header, one carve-out sentence, ten environment variables, and — after the runs — one helper in the race scripts that prints why a `fetch` failed.
>
> Four things carry the slice, and each is a number with its meaning pinned beside it. **The live run has K in it**: `5 distinct instance id(s)` across the harness's eight concurrent health calls, `18` of 20 and `10` of 10 promo applications, `9` of 20 redeliveries of one event, **`30` of 50 webhooks** — thirty processes with nothing in common but Postgres delivered fifty distinct reports of one payment and the shopper got one key. **Passing there is evidence for Phases 2 and 5, not a new argument**: the nine checks are byte-identical to the local ones and the shop's statements are the ones Phase 2 and Phase 5 proved with RED validation; what the platform removes is the alternative explanation a laptop cannot fully exclude, that something in one process's memory was doing the work. **Five attempts, two of which failed, and neither failure was the shop**: a harness reading of K = 1 on a cold platform, and one client-side `fetch failed` in about nine hundred requests. **The reset is what makes "twice in a row" true**: a run leaves 38 orders, 55 payment events and 6 deliveries on the target, and `RACE_DEMO_RESET=1` — or the operator's `pnpm demo:reset` — takes them off in one transaction so the next run starts where this one did.
>
> Reading the platform found seven things. Fluid Compute was **on by default** on a fresh project, and turning it off was done through the project API rather than the dashboard, in the same call that pinned Node to 22.x. Turning it off dropped the project's default function timeout from 300 s to 10 s — a side effect `vercel.json`'s `maxDuration: 60` overrides, and the reason that key is not optional. Every function log line carries `pid: 4`, whichever instance wrote it, so the process id is meaningless as a witness on this platform and `x-instance-id` is the only one HTTP can give. The shop's own cross-process guard fired during an ordinary purchase, unprompted by any check — a poll on one instance and a webhook continuation on another met on the same order, and the log says which one stepped back. The harness's K = 1 in run 1 was eight one-millisecond health calls served back to back by the one warm instance on an otherwise cold platform, while the work checks of the same run were answered by 17, 10, 8 and 19 instances — the witness's known weak spot on a cheap endpoint. Two requests in about nine hundred failed client-side with undici's two-word `fetch failed`, and the cause is now printed. And after six idle minutes the function instance was still warm (0.226 s) while Neon had suspended at 5 min 15 s — two clocks, and the first request after a pause pays whichever has expired.

---

## 1. What actually shipped

| # | Change | Where | Size |
| --- | --- | --- | --- |
| 1 | `vercel.json` exactly as tech spec §2.2: `framework: null`, `installCommand: pnpm install --frozen-lockfile`, `buildCommand: pnpm run build`, `outputDirectory: apps/web/dist`, `regions: ["fra1"]`, `functions."api/index.js".maxDuration: 60`, and the three rewrites in order (`/api/(.*)` and `/internal/(.*)` → `/api/index`; everything not under `api/`, `internal/` or `assets/` → `/index.html`) | `vercel.json` | 18 lines, no comments — JSON admits none |
| 2 | The key-by-key reasons for every line of change 1, beside the one file the configuration exists to serve, plus the three things that are *not* keys: Fluid off, Node 22.x, `NODE_ENV` never set | `api/index.js` header | One comment block over a one-line re-export |
| 3 | `.vercelignore`: build output, `context/`, `docs/`, the test trees, agent tooling, every `.env*` except `.env.example` — because the CLI never reads `.gitignore`, and the live shop must be built from the published sources, not from a laptop's `dist/` | `.vercelignore` | 32 lines |
| 4 | The demo carve-out: `ALLOW_CLIENT_SUPPLIED_ORDER_ID=true` is set on the live demo on purpose — no real shoppers, `pnpm demo:reset` returns it to baseline — said in the flag's comment, in its `warn` line, and in `.env.example` | `apps/api/src/config/client-supplied-order-id.ts`, `.env.example` | One sentence, three places |
| 5 | The project: linked from the repo root; Fluid Compute off and Node 22.x through one API call; Deployment Protection at its defaults (the alias public, per-deployment URLs login-gated) | Vercel project settings — nothing in the tree | User steps plus one `PATCH` |
| 6 | The production environment, every row of tech spec §2.7: `DATABASE_URL` (the pooled host, `sslmode=verify-full`), `SUPPLIER_A_URL`, `SUPPLIER_B_URL`, `PAYMENT_WEBHOOK_URL` (all three on the alias), `SUPPLIER_TIMEOUT_MS=5000`, `SUPPLIER_MAX_PROBES_PER_REQUEST=2`, `ADMIN_TOKEN` (a fresh demo token), `ALLOW_CLIENT_SUPPLIED_ORDER_ID=true`, `NODEJS_HELPERS=0`, `ENABLE_EXPERIMENTAL_COREPACK=1`; never `NODE_ENV` | Vercel project environment — nothing in the tree | Ten variables; values in the shell for the session, none in git |
| 7 | The deployment: `vercel --prod --yes` from a clean, committed tree → `dpl_H3dkL5L33UBV49kaSQquWY3MP97Q` | The alias | One deploy |
| 8 | The recorded run — the fifth of five reviewer attempts, the second of two consecutive `9/9`s — kept for the README | `docs/walkthrough/evidence/phase-6-live-race-run.txt` | 285 lines |
| 9 | Four screenshots of the live shop driven by a person: the storefront, an order with `LIMIT3` applied, the delivered key, the operator's view | `docs/screenshots/006-live-{storefront,order-with-promo,delivered,admin}.png` | Four files |
| 10 | The follow-up the runs earned: `describeFetchError` walks undici's `cause` chain so a transport failure prints its code (`ECONNRESET`, `UND_ERR_SOCKET`) instead of the bare `fetch failed`; the harness's disagreement detail now names the request index and target | `scripts/race/support/fetch-failure.ts` (new), nine call sites across `scripts/race/*.ts`, `scripts/demo-reset.ts` | One helper, ten one-line replacements — in the working tree, not yet committed |

Changes 1 and 6 are the ones to read first: everything the platform does with this repository is decided by eighteen lines of JSON and ten variables, and the header in `api/index.js` (change 2) is where each of the eighteen lines says why. Changes 5–9 are not code; they are the observations this document exists to record. Change 10 is the one thing the runs changed in the tree, and it changes no assertion — only the words a failure carries.

**Where this sits in the assignment.** Phases 1–5 built a shop whose guarantees are Postgres constraints and locks, and proved each one locally across four processes with RED validation. Phase 6's sentence — *passing the race checks on Vercel, where every request is its own process, is evidence that the guarantees live in Postgres and not in memory* — was, until this slice, a sentence about a platform nobody had deployed to: Slice 1 built the function's shape on `node:http`, Slice 2 put the schema on Neon, Slice 3 gave the demo a way back to baseline, Slice 4 taught the runner to tell the truth about a target it did not start. This slice is the sentence being tested. It is also the assignment's first required item, «ссылка на задеплоенный проект», made real: the address in the README will be the one in this document, and the run the README quotes is the one in `evidence/`.

| # | What the live evidence says | What it does not say, and where that is printed |
| --- | --- | --- |
| 1 | Nine checks, `9/9`, twice in a row, against one address, with 39 named `SKIP`s inside a tally that counts only what ran | Anything about the rows — `deliveries`, `supplier_keys`, `issuance_attempts`, the ledger — which the author's run asserts instead |
| 2 | How many processes answered each burst: 5 of 8, 18 of 20, 10 of 10, 9 of 20, 30 of 50 | That those processes overlapped in time — the two honesty lines under the harness's `PASS`; the fan-out and, in the author's run, the 26 backends argue the overlap |
| 3 | Fluid Compute was off: no burst was answered by one instance, and the one K = 1 (run 1's harness) sits beside four work checks in the same run at 17, 10, 8 and 19 | That the toggle is *proven* off by the transcript alone — the project setting is the authority; the transcript rules out the reading the toggle being on would produce |
| 4 | The target was left at baseline: `orders 0 · … · keys_unclaimed 50` after the reset block | The reset's own `duration_ms` against Neon — the runner prints counts, not the timing Slice 3 asked to have re-measured |

---

## 2. The words this document uses

- **The alias** — `https://game-shop-ochre.vercel.app`, the production address `vercel link` assigned. Public. Every self-call the shop makes (`SUPPLIER_A_URL`, `SUPPLIER_B_URL`, `PAYMENT_WEBHOOK_URL`) lands here and comes back through the `/api` and `/internal` rewrites as a second invocation.
- **A deployment URL** — the per-deployment address the CLI prints (`…-<hash>.vercel.app`). Login-gated under Deployment Protection's defaults, which is why it appears nowhere in the environment and nowhere in a check.
- **An instance** — one microVM running one Node process with the container Slice 1 built and one `max: 1` pool. With Fluid Compute off an instance serves one invocation at a time; a concurrent request that finds no free instance gets a new one. The platform keeps an instance warm for a while after it finishes and may reuse it.
- **Cold / warm** — a cold invocation pays the platform's init (measured: 1.81 s) plus Nest's `init()` (measured: 29 ms) before the request is seen; a warm one pays neither (~0.15 s end to end for `/api/health`). Independently, Neon's compute is cold after five idle minutes and the first query then pays `start_compute` (measured: 0.793 s).
- **K** — the number of distinct `x-instance-id` values one burst of N requests saw. Printed by the harness as a verdict (`PASS` at ≥ 2, `FAIL` at exactly 1) and by `promo`, `same-event` and `webhooks` as `INFO answers came from K distinct instance(s) — N answer(s)`.
- **A backend pid** — what `pg_stat_activity` on the direct host reports for a server connection carrying the shop's `application_name`; the database's own witness of concurrency, available only to a run with `RACE_DATABASE_URL`.
- **An attempt** — one full `pnpm race` against the alias. Five as the reviewer (no database), two as the author (the direct host forwarded). Numbered in the order they were run.
- **The recorded run** — attempt 5, the second of two consecutive `9/9`s (attempts 4 and 5), saved verbatim as `docs/walkthrough/evidence/phase-6-live-race-run.txt`; the README will quote it.
- **The ladder** — here, the sequence of `curl`s tech spec §2.10 step 8 prescribes after the first deploy, one per thing that had to be verified on the platform rather than assumed. (The *issuance* ladder — supplier A, then B — keeps its name from Phase 3 and appears in §3.)
- **The reset** — `POST /api/admin/demo/reset`, Slice 3's one-transaction return to the seeded state, called by the runner on `RACE_DEMO_RESET=1` after the last check, or by an operator through `pnpm demo:reset`.

---

## 3. What the live run showed — the numbers

Every number below is a line in `docs/walkthrough/evidence/phase-6-live-race-run.txt`, a line from the task reports, or the function log; none was re-measured while writing this.

| Number | Where it is printed | What it means | What it does not mean |
| --- | --- | --- | --- |
| **`5 distinct instance id(s)`** across 8 concurrent `GET /api/health` | harness, `PASS … at least two distinct instances` | Five processes answered a burst of eight one-millisecond requests: the platform was spreading even the cheapest call | That eight would have been the "right" answer — the platform reuses an instance the moment it is free, and a health call frees it in ~1 ms |
| **`18 distinct`** of 20 (`LIMIT3`), **`10`** of 10 (`ONCEONLY`) | promo, `INFO answers came from …` | Twenty simultaneous applications of a code capped at 3 were decided by eighteen processes — `3 × 200, 17 × 409 exhausted, 0 × 5xx`, exactly as on the laptop | That the eighteen were all alive at the same instant (the honesty line) |
| **`9`** of 20 | same-event | One event id delivered twenty times at once, across nine processes: `stored=1, duplicate=19` | — |
| **`30`** of 50 | webhooks | **Fifty distinct reports of one payment, thirty processes, one key.** The headline of the phase | That the other twenty were served by a shared process in the Fluid sense — they were served by instances already warm from the first thirty, each still one invocation at a time |
| **`9/9`, twice** | attempts 4 and 5, the summary line | Functional spec §2.2's third criterion: the second consecutive run reports the same verdicts as the first with no tidying between them | That every attempt passed — attempts 1 and 3 did not (§5) |
| **39 `SKIP`** lines | inside the nine checks | Every database-side assertion, by name, never counted — the same 39 Slice 4 counted locally | That anything skipped was true; the author's run is where those 39 are asserted |
| **`26 distinct backend pid(s)`** | the author's run, harness | The database's own view of concurrency during the run: twenty-six server connections carried the shop's name at the moment the harness looked. The second measurement of architecture §7's rule — 1 process → 1 pid, 4 → 4, the live shop → 26 | That 26 instances existed at once: through a transaction-mode pooler a backend is a pooler-owned server connection, opened when concurrent transactions needed it and kept afterwards, not one per instance |
| **0 `SKIP`s** in the author's run | the mode line reads `RACE_DATABASE_URL forwarded` | Every database-side line was asserted for real: `used_count = 3 for LIMIT3`, `exactly THREE attempt rows after the retry (a/1, b/2, a/3)`, `a/1 reads status=ok, probe_count=2`; Neon at baseline afterwards through the checks' own cleanup | — |
| **`supplier timeout 5000 ms (from target /api/health)`**, hang **6500** | recover-timeout | R8's own case, staged for the first time: the runner's shell knows nothing of 5000, the target said it, and the hang was derived from the target's number | — |
| **~6.0 s** (`6005ms`) for the trap check | the summary's durations | The order settled `delivered` about 6 s after the webhook: the 6500 ms hang and the re-probe ran inside one continuation and the platform did not kill it | That `maxDuration: 60` was *exercised* — 6 s sits under the default 10 s as well; the override is read from the deployment's configuration, not from this run |
| **782 ms … 1539 ms** for the harness and the fifty webhooks | the summary's durations | The shape Slice 2 said the live run must show: fifty webhooks with no 10 s median queue behind one connection, because there is no shared connection to queue on | — |
| **1.81 s + 29 ms** | the function log's cold boot | The platform's init and Nest's `init()` on a cold instance; R1's estimate was 1.5–2.5 s and the number is inside it | That every request pays it — the two health calls right after deploy took 0.444 s and 0.325 s on instances the platform had pre-initialised, and a warm repeat is ~0.15 s |
| **2.38 s** for the simulator's self-call, **t+4.31 s** to `delivered` | the curl ladder | A second invocation, cold, inside the first: the price of one purchase on a cold platform | — |
| **5 min 15 s**, then **0.793 s** | Neon's `suspend_compute`, the next `/api/products` | Neon suspends its 0.25 CU compute after five idle minutes and the first query afterwards pays `start_compute` | That the function instance had gone cold too — it had not: `/api/health` after the same six minutes took 0.226 s |
| **38 · 6 · 9 · 4 · 55 · 6**, then **6**, **1** | the reset block: `removed orders 38 · deliveries 6 · issuance_attempts 9 · promo_redemptions 4 · payment_events 55 · supplier_requests 6`; `reset … supplier_keys 6 · supplier_behaviour 1` | What one reviewer run leaves on the shop and what one transaction takes off (§6) | — |

**Why 30 of 50 and not 50 of 50.** K counts processes; N counts requests. A webhook handler stores the event, answers `200` and hands the rest to `waitUntil` — a few tens of milliseconds of request time — so by the time the fiftieth report leaves the laptop, instances that took the first ones are free again, and the platform prefers a free warm instance to a cold new one. Thirty is the platform's answer to "how many did fifty simultaneous arrivals need", and it is the number that matters: it is thirty times larger than the number that would have made the run worthless. The four K lines of one run are not monotonic and should not be read as one — 18, 10, 9, 30 in the recorded run, 19, 10, 12, 25 in attempt 2 — each is one burst's spread at one moment.

**What Slice 2 said this run must show, and did.** *K ≥ 2 from the runner's instance-id half* — 5, then 18, 10, 9, 30. *The fifty webhooks answered 200* — `every response 2xx`, `50 of 50` stored. *The order delivered with one key* — `status=delivered`, and in the author's run the single `deliveries` row. *No 500 on any poll* — none. *A wall-clock that does not carry a 10 s median queue* — 1539 ms for the whole check. The reading Slice 2 warned about (the single-process shape, Fluid on) did not appear.

---

## 4. Why passing on separate processes is evidence for Phases 2 and 5, and not a new argument

**The claim.** Phase 2: one order per intent (`orders.client_request_id UNIQUE`, I1), one event per id (`payment_events.event_id PRIMARY KEY`, I2), one worker per order (`SELECT … FOR UPDATE` and the status-guarded `paid → delivering` update, I4), and one key per order (`deliveries.order_id UNIQUE`). Phase 5: a promo limit decided by one conditional `UPDATE … WHERE used_count < max_uses` (I7) with a ledger row per winner (I8). Each was proven locally across four `dist/main.js` processes, with the mechanism weakened and the check watched to fail — architecture §7's table is the founding measurement: the same unlocked claim hands out 20 distinct codes in one process and 9 in four.

**The platform's guarantee.** With Fluid Compute off, a Vercel function instance takes one invocation at a time; concurrency is met with more instances, each a fresh process with its own module scope, its own `INSTANCE_ID`, its own `max: 1` pool, and no way to reach another instance's memory. Fifty simultaneous webhooks are therefore at least as many processes as the platform needs to answer them without queueing — thirty, in the recorded run — and the only thing those thirty share is the Postgres at the end of `DATABASE_URL`.

**The witness.** `x-instance-id`, one UUID minted when `instance-identity.ts` is evaluated, which is once per process. Every response carries it; the checks count distinct values per burst and print K. In the author's run the database adds its own witness: 26 distinct backend pids under the shop's `application_name`.

**Why this is evidence, not a new argument.** Nothing was added to the proof. The nine check files are byte-identical between `pnpm race` on a laptop and `pnpm race` against the alias (Slice 4: only the environment and the first line of the transcript differ); the statements under test are the same migrations Slice 2 applied to Neon; no new assertion, no new invariant, no new map is needed in `phases-1-to-5.md`. What the platform contributes is subtraction: a laptop run across four processes leaves one explanation the reader has to take on trust — that some in-process lock, cache or queue the author forgot about was doing the work and four processes happened not to expose it. Thirty processes that never shared a byte of memory, spawned by a scheduler the author does not control, handing out exactly one key, leaves that explanation nowhere to live. The guarantee must be in the one thing they shared. That is the whole of Phase 6's sentence, and it is a statement about Phases 2 and 5, with a number in it now.

**The caveat, printed with the number.** A distinct id proves a distinct process; it does not prove the processes overlapped in time — two ids across fifty answers would be consistent with one instance recycled between the first and the last. The concurrent fan-out argues the overlap, and the author's 26 backends argue it from the database's side, but K itself is a count of processes and the harness prints that limit under every `PASS`. And the witness has a weak spot: a cheap endpoint on a cold platform. Eight `GET /api/health` calls, each ~1 ms of work, fired "concurrently" from one laptop arrive spread over a few milliseconds of network jitter, and a single warm instance can be free again before the next one lands — which is exactly what attempt 1's harness saw (K = 1, `FAIL`, as designed) while the promo, same-event and webhook bursts of the *same run*, each of which holds an instance for a real transaction, were answered by 17, 10, 8 and 19 instances. K = 1 on a burst means that burst was not cross-process evidence; it does not mean Fluid is on, and it does not mean the checks after it are wrong. It means: run again.

---

## 5. The five attempts, honestly

| Attempt | Tally | What failed | Why it was not the shop |
| --- | --- | --- | --- |
| 1 | 8/9 | `harness` — `FAIL … all 8 answers came from one instance` (K = 1) | Eight ~1 ms health calls, served sequentially by the single warm instance on an otherwise cold platform. The work checks in the same run printed K = 17, 10, 8 and 19; a Fluid-on platform would not have spread those either. The harness did exactly what Slice 4 designed it to do on the one observable it decides on |
| 2 | 9/9 | — | K = 6, 19, 10, 12, 25 |
| 3 | 8/9 | `same-event` — one of the 20 concurrent redeliveries never got an answer: client-side `fetch failed`, `status 0`; the 19 that did read `stored=1, duplicate=18` | An undici transport failure between the laptop and the edge; the shop never saw the request or its answer never came back. The invariant held on everything that answered — one stored, the rest duplicates — and the assertion `all 20 concurrent redeliveries answered 2xx` correctly refused to count a request it could not see. Two such failures in roughly nine hundred requests across the seven runs |
| 4 | 9/9 | — | K = 6, 19, 10, 15, 27 |
| **5** | **9/9** | — | **K = 5, 18, 10, 9, 30 — the recorded run** |

**The author's two.** Attempt 1 with `RACE_DATABASE_URL` forwarded: 8/9, the harness's `GET /api/health` fan-out losing one request to the same `fetch failed` — the second of the two. Attempt 2: 9/9, `26 distinct backend pid(s)`, K = 6, 19, 10, 9, 25, zero `SKIP`s, cleanup ran, Neon at baseline afterwards.

**Why the recorded run is #5, with #4 beside it.** Functional spec §2.2 asks for two things at once: the author's run on record, and *twice in a row, the second run reports the same verdicts as the first, with no manual tidying in between*. Attempts 4 and 5 are that pair — consecutive, both `9/9`, and identical after normalising ids (the task's comparison); the K lines and the durations are the numbers that differ between them, as they must, and the reset block at the end of #4 is the only tidying #5 had. The transcript kept is the second of the two because that is what the criterion names; the first is its witness that nothing was done by hand between them.

**The transport flake, and what was done about it.** Node's `fetch` is undici, and undici reports every transport failure as the same two words — `TypeError: fetch failed` — with the real reason one level down on `error.cause` (`ECONNRESET`, `UND_ERR_SOCKET`, `ETIMEDOUT`, or an `AggregateError` with an empty message for a dual-stack host). Every check's never-throwing fetch helper recorded `error.message`, so what reached attempts 3 and the author's 1 was `fetch failed` twice, indistinguishable from the shop being down, from a reset socket, from a DNS blip. The follow-up is `scripts/race/support/fetch-failure.ts`: `describeFetchError` walks the `cause` chain at most four deep and prints `fetch failed (cause: <code ?? name>: <message>)` per level; the nine fetch helpers across the checks and `demo-reset.ts` now call it, and the harness's disagreement line names the request index and its target so a re-run can send the same request to the same instance. No assertion changed, no retry was added — the next flake will say what it was, and until one happens the cause of these two is unknown and is recorded as unknown.

---

## 6. What the reset makes repeatable

A reviewer's run has no database, so no check can clean up after itself; the banner says so once and the orders stay. The recorded run's reset block says how many:

```
race:   removed  orders 38 · deliveries 6 · issuance_attempts 9 · promo_redemptions 4 · payment_events 55 · supplier_requests 6
race:   reset    promo_codes 0 · supplier_keys 6 · supplier_behaviour 1
race:   now      products 12 · keys_total 50 · keys_unclaimed 50 · orders 0 · payment_events 0 · deliveries 0 · issuance_attempts 0 · supplier_requests 0 · promo_codes 4 · promo_used_count 0 · promo_redemptions 0 · supplier_behaviour_baseline 2
```

The arithmetic is the transcript's own. **38 orders**: `before-order` 1; `create-order` 2 (twenty attempts under one key → `1 distinct id(s)`, plus the fresh-key order); `promo` 30 (`20 order(s)` for `LIMIT3`, `10 order(s)` for `ONCEONLY`); one each for `recover-out-of-stock`, `recover-refusal`, `recover-timeout`, `same-event` and `webhooks`. **55 payment events**: `webhooks`' `50 distinct event_ids`, `same-event`'s one id stored once, and one each for the three recover checks and `before-order`. **6 deliveries**, hence **6 supplier keys** released and **6 supplier requests** (a refusal and an out-of-stock answer write no ledger row). **9 issuance attempts**: three for the out-of-stock check (`a/1, b/2, a/3`), two for the refusal (A refuses, B issues), one each for the other four deliveries. **4 promo redemptions**: three `LIMIT3` winners and one `ONCEONLY`, with `promo_codes 0` under `reset` because the promo check had already zeroed its counters through the promo reset (Slice 4 §6.3). **`supplier_behaviour 1`**: A's `hang_ms 6500` left armed with `hang_next` at 0 after the trap check (Slice 4 §6.4) — harmless, not baseline, put back here.

Two ways to run it, one endpoint. `RACE_DEMO_RESET=1` makes the runner call it after the last check and print the block — the reviewer's command carries the flag, so the transcript ends at baseline or exits `2`. `pnpm demo:reset` with `RACE_BASE_URLS` and `ADMIN_TOKEN` is the operator's version for any other time — after a manual drive, after mischief with the published token — and the slice ended with it after the manual drive. Either way it is Slice 3's one transaction: every order's lock first, then the six deletes, then the key release, `lock_timeout` at five seconds, so a straggling continuation on another instance either waits or fails cleanly. R9's "run it twice" remedy for a straggler was not needed in the runs reported: each reset's `now` line read baseline, and the run after it passed.

What "repeatable" then means: attempts 4 and 5 gave the same verdicts because #4 ended with keys back at 50, counters at 0 and every behaviour row at baseline — not because the checks tolerate residue. `promo` would still pass on a dirty shop (it resets its own counters and mints fresh orders); `recover-out-of-stock` would not, because its drain asserts `claimed` against a pool it expects full, and `keys_unclaimed 44` after one un-reset run is the number it would meet.

---

## 7. Every "verify on first deploy" item, with its observed answer

Tech spec §2.2 and §3 name the things the plan could describe but not know until a deployment existed. Each with what the first deploy, the curl ladder and the function log answered.

| Item | Expected (tech spec) | Observed |
| --- | --- | --- |
| pnpm 10 picked from `packageManager`, pinned by `ENABLE_EXPERIMENTAL_COREPACK=1` | §2.2 | pnpm 10.18.0 via corepack in the build log; `pnpm install --frozen-lockfile` accepted the committed lockfile |
| `api/` built as a function even though `outputDirectory` is `apps/web/dist` | §2.1, §2.2 | `λ api/index (1.93MB) [fra1]` |
| The rewrites hand Nest the original `req.url` | §2.2 | `/api/nope` → Nest's JSON 404; `POST /api/orders` → 201; `PUT /internal/suppliers/a/behaviour` → 200 through the second rewrite; `/order/anything` → 200 HTML through the third — the step `router.ts` said Phase 6 owed |
| POST bodies reach Nest's parser with `NODEJS_HELPERS=0` | §2.2, Slice 1 §11 | `POST /api/orders` 201 in 0.97 s (a Neon `start_compute` inside); the promo `PUT`s and the fifty webhook `POST`s all parsed |
| `sslmode=verify-full` accepted by `pg` against Neon's pooled host | §2.3 | The shop reached its database on the first order (`POST /api/orders` 201) and on every check after |
| The cold boot ≈ 1.5–2.5 s | R1 | Platform init 1.81 s + Nest 29 ms |
| The scheduler line says `wait_until` | §2.10 step 8 | `implementation: "wait_until"` in the log; the continuations completed — every check's order settled |
| The issuance budget line | §2.7 | `worst_case_ms 20000` (2 × 5000 × 2) |
| Tracing warnings only, no errors | §2.2, R12 | Zero warnings, zero errors |
| Fluid Compute off | §2.2, R3 | Off through the project API; no burst answered by one instance except attempt 1's harness (§5) |
| `maxDuration: 60` in force | §2.2, R2 | Set in the deployment; the project's default had dropped to 10 s with Fluid off, and the recorded run's longest continuation (~6 s) does not distinguish 10 from 60 — the configuration is the evidence, not the run |
| The timeout profile: `SUPPLIER_TIMEOUT_MS=5000`, probes 2 | §2.7, R1 | Justified by the measured 1.8 s: a cold second invocation costs ~1.8 s before Nest sees the request and 2.38 s end to end for the simulator's self-call, so a 2000 ms deadline would have read a healthy cold supplier as `unknown`; 5000 leaves room, and the trap check's 6500 still sits above it and far below 60 s |
| The JSON logger under `VERCEL=1` | §2.1, Slice 1 §11 | The log's fields are searchable: `implementation`, `worst_case_ms`, `locked_status` — and `pid` (§8.3) |
| Deployment Protection at defaults | §2.2, R6 | The alias public (every self-call succeeded); per-deployment URLs login-gated |
| The demo carve-out `warn` | §2.7 | Printed at boot with the carve-out sentence; the supplier URLs on the alias in the same output |
| `/api/health` as the boot probe | §2.1, R11 | 200 with `instance_id`, `runtime: "vercel"`, `supplier_timeout_ms: 5000` — 0.444 s then 0.325 s right after deploy |
| The `503` for a misconfigured instance | §2.1, R11 | Not exercised live — every variable was right the first time. Proven on `node:http` in Slice 1; unchanged here |
| The 401 without the token | §2.4 | `401`, and nothing changed |
| Neon autosuspend plus a function cold start | R4 | After six idle minutes: instance warm (0.226 s), Neon suspended at 5 min 15 s, first query 0.793 s; the runner's warm-up (`GET /api/products` → 200 in 195 ms in the recorded run) absorbs it before any check |
| R14's frozen-socket `ECONNRESET` | R14 | Not observed in seven runs; the one-shot retry it would justify stays unwritten |

---

## 8. Findings

### 8.1 Fluid Compute was on by default, and the toggle is an API call

A fresh project had Fluid Compute **on**. R3 anticipated the toggle being left on by mistake; it did not anticipate that "left" is the default state. It was turned off with one call to the project API — `{"resourceConfig":{"fluid":false},"nodeVersion":"22.x"}` — the same call that pinned Node, rather than through the dashboard the tech spec describes. Worth recording for two reasons. A setting that is on by default and off by decision is exactly the kind of thing the README must state, since the whole sentence of the phase depends on it; and a `PATCH` is reproducible from a script where a dashboard click is not, so a second project (a reviewer's own deploy) has an exact instruction.

### 8.2 Turning Fluid off dropped the project's default timeout from 300 s to 10 s

Fluid's default maximum duration is 300 s; the classic model's is 10 s. Switching the mode switched the default underneath the project, which would have killed the trap check's 6500 ms hang plus re-probe on a cold instance and every ladder walk that approached `worst_case_ms 20000`. `vercel.json`'s `functions."api/index.js".maxDuration: 60` overrides it, and the deployment carries 60. The tech spec already said the default was 10 s with Fluid off; what it did not say is that the default *moves* when the toggle does, which makes the key load-bearing rather than belt-and-braces: a project that turned Fluid off after deploying without the key would silently shrink its ceiling.

### 8.3 Every log line says `pid: 4`

Nest's JSON logger includes the process id, and on this platform every instance's Node process reports pid 4; whatever the platform's reason, thirty instances share one pid. The consequence is exactly what `instance-identity.ts`'s header said in Slice 1 without having seen it: a process id is a witness only where processes share a kernel, and the HTTP witness has to be something the process mints itself. `x-instance-id` (a UUID at module load) is the only process witness a live response carries; the database's is the backend pid on the direct host, which the author's run reads and the reviewer's cannot.

### 8.4 The cross-process guard fired on an ordinary purchase

During the curl ladder — one order, one simulated payment, no race check — the log recorded: `"the guarded claim matched zero rows; this call does not own the order","locked_status":"delivering"`. The shape: the simulator delivered the webhook to instance B, which stored the event, answered `200`, and continued under `waitUntil` into the issuance ladder; meanwhile the poll of `GET /api/orders/:id` landed on instance A, whose status-poll drain (Phase 2's "answer, then work") found the pending event and tried the guarded `paid → delivering` update, which matched zero rows because B had already moved the order on. A logged that it does not own the order and stepped back; B finished and the key arrived at t+4.31 s. This is I4 doing on two instances what Phase 2 proved it does on four laptop processes — and it was not staged. The shop's own two triggers on two random instances produced the contention, and the database decided it. It is the smallest possible version of the phase's sentence, in the log of a purchase nobody was racing.

### 8.5 The harness's K = 1 on a cold platform

Attempt 1's harness fired eight concurrent `GET /api/health` and every answer came from one instance; the same run's promo, same-event and webhook bursts came from 17, 10, 8 and 19. The difference is the cost of the request. A health call does no database work and completes in about a millisecond; the platform routes each arrival to a free warm instance when one exists, and right after a deploy there was one pre-initialised instance, free again before the next of the eight arrived. A promo application holds its instance for a transaction over Neon, so the second arrival finds it busy and gets a new one. The witness is therefore weakest on precisely the endpoint it uses, and strongest on the checks that matter — which is the right way round, but it means the harness's `FAIL` can fire on a cold platform with the toggle correctly off. The verdict, the `FAIL` text (*re-run, or check that Fluid Compute is off*) and the threshold (≥ 2) are all as Slice 4 designed them; what this run adds is the measurement that the weak spot exists and what it looks like. Not changed: the burst is not retried (§10), and the endpoint is not swapped for `/api/products`, which would make the harness's witness depend on Neon being awake.

### 8.6 `fetch failed`, twice

Two of roughly nine hundred requests over the seven runs failed on the client side with `status 0` and the two-word message — attempt 3's `same-event` and the author's first harness. Both were reported by the client's transport (`status 0`, no HTTP response), not by the shop; both correctly failed their check, because a request that got no answer cannot be counted as a `2xx`; and both were recorded with a message that could not say what happened. §5 has the follow-up: `describeFetchError` and the harness's request-and-target detail, in the working tree. The cause of these two remains unknown and is written down as unknown rather than guessed.

### 8.7 Neon suspends at five minutes; the instance was kept for six

Neon's log shows `suspend_compute` 5 min 15 s after the last query. Six minutes after the ladder, `GET /api/health` answered in 0.226 s — the function instance was still warm — and the next `GET /api/products` took 0.793 s, the `start_compute` on the first query. Two idle clocks, and the shorter one is the database's: a shopper arriving after a pause of between five minutes and however long the platform keeps an instance pays Neon's resume and not the platform's; after a longer pause, both (≈ 1.8 s + ≈ 0.8 s). `connectionTimeoutMillis: 10_000` covers both with room; the runner's warm-up absorbs the first for the checks; the README's "the first request may take a few seconds" is the shopper's version.

### 8.8 Sentences the slice made false

None edited; each with its correction.

- `docs/walkthrough/phase-6-slice-4-the-runner-tells-the-truth.md:227` — *"Never run against a real Vercel target."* True when written. Correction: seven runs against the alias — five as the reviewer (8/9, 9/9, 8/9, 9/9, 9/9) and two as the author (8/9, 9/9); `runtime` read `vercel`; the warm-up took 195 ms in the recorded run.
- `docs/walkthrough/phase-6-slice-4-the-runner-tells-the-truth.md:228` — *"K under Fluid Compute off is unmeasured."* Correction: measured — the harness saw `5 distinct instance id(s)` of 8 in the recorded run (6 in attempts 2 and 4, 1 in attempt 1); the checks saw 18, 10, 9 and 30.
- `docs/walkthrough/phase-6-slice-4-the-runner-tells-the-truth.md:229` — *"R8's own case is unstaged."* Correction: staged — the recorded run prints `supplier timeout 5000 ms (from target /api/health)` and arms `hang_ms: 6500`.
- `docs/walkthrough/phase-6-slice-2-neon-holds-the-shops-memory.md:238` — *"The cold-compute cost is unmeasured from a function."* Correction: 0.793 s for the first `/api/products` after Neon's suspend, from a warm instance; the platform's own cold start is 1.81 s + 29 ms and independent of it.
- `docs/walkthrough/phase-6-slice-3-reset-drain-restock.md:263` — *"the first reset through PgBouncer is Slice 5's"*. Correction: done — the reset ran through the pooled endpoint at the end of every reviewer run and after the manual drive; the counts are in §6. Its `duration_ms` against Neon (the same document's line 264) is still unrecorded: the runner prints counts, not the timing.
- `api/index.js:85–86` — *"Node is 22.x (resolved from the root `engines.node`, the version everything was measured on)"*. Correction: Node 22.x is the project setting, pinned through the API in the same call that turned Fluid Compute off; `engines.node >= 22.18` agrees with it but is not what decided it.
- `.env.example:237` — *"12 S EXCEEDS VERCEL'S HOBBY CEILING"* (of `3 × 2000 × 2 = 12 000 ms`). Correction: 12 s exceeds the platform's *default* function timeout (10 s with Fluid Compute off); the deployed profile sets `maxDuration: 60` in `vercel.json` and runs `2 × 5000 × 2 = 20 000 ms` under it — the boot line read `worst_case_ms 20000`.
- `context/spec/006-live-shop-and-the-written-answer/technical-considerations.md:64` — *"**Fluid Compute off** is a dashboard toggle … there is no `vercel.json` key."* Still no key; the toggle is also a project-API field (`resourceConfig.fluid`), which is how it was done, and its default is **on**. Recorded against the spec because the runbook's step 2 will be followed by the next person.

---

## 9. Role among the key points

The assignment's subject is a shop whose correctness under concurrency is enforced by the database — unique constraints, row locks, guarded updates — and not by anything a process remembers. Phases 1–5 argued that claim by running the code against a Postgres in Docker, four processes at a time, and reading the rows. Phase 6's sentence turns the argument into evidence a stranger can gather with two variables: *passing the race checks on Vercel, where every request is its own process, is evidence that the guarantees live in Postgres and not in memory.*

This slice is where the sentence acquires its numbers. Thirty processes for fifty webhooks, eighteen for twenty promo applications, one key and three winners; `9/9` twice in a row; 26 backends on the database's side. Each number is printed by the same check that would have printed a smaller one if the platform had been sharing a process, and the one run where the cheapest check printed `1` is in this document with its explanation rather than out of it. The reviewer can produce their own numbers with `RACE_BASE_URLS=https://game-shop-ochre.vercel.app ADMIN_TOKEN=<the demo token> RACE_DEMO_RESET=1 pnpm race` — nothing to install beyond the repository, nothing to clean up afterwards — and compare them to the recorded run. That is the difference between "we tested it" and evidence, and it is the shape the README's third item («воспроизведение гонок») will take.

The slice's own contribution beside that is narrower and worth naming: the deployment is *the same expression* as the laptop. One `createApp()` (Slice 1), one `pg` driver and one schema (Slice 2), one reset (Slice 3), one runner (Slice 4) — and eighteen lines of `vercel.json` with a header saying why each is there. Nothing was forked for the platform, so the shop the reviewer sees at the alias is the shop `pnpm dev` runs, and the log of an ordinary purchase there (§8.4) shows Phase 2's guard deciding a real contention between two instances nobody raced.

---

## 10. What a reviewer might challenge

- **Why the alias and not the deployment URL?** Because Deployment Protection's defaults gate every per-deployment URL behind a login and leave the production alias public, and the shop calls itself: `SUPPLIER_A_URL`, `SUPPLIER_B_URL` and `PAYMENT_WEBHOOK_URL` are all on the alias. A self-call to a gated URL answers a `401` login page, and the issuance client would read that as a definite refusal and fall through to B — R6, a real order lost to a platform setting. The alias is also the one address that survives the next deploy, which is the address the README must carry. `VERCEL_URL` is never read.
- **Why not Fluid Compute? It is the platform's default and it is cheaper.** Because Fluid shares one instance across concurrent invocations, and that is the single-process shape architecture §7 measured as worthless for a race: the `max: 1` pool serialises requests in Node before Postgres sees them, `waitUntil` contexts interleave in one process, and the K witness reads 1. A shop that passed under Fluid would have proved nothing about where the guarantee lives. The costs are real and listed: cold starts (1.8 s), a default timeout that drops to 10 s (§8.2) and has to be overridden, more instances per burst. They are the price of the sentence.
- **Why `fra1`?** Because the Neon project is in `aws-eu-central-1`, and with a `max: 1` pool every request opens at most one connection and pays the database round trip on every statement — the one cost that repeats. Keeping function and database in one region keeps that cost single-digit milliseconds; either pair would do, but they must pair. The build ran on `iad1`, which is where Vercel builds and has nothing to do with where the function runs.
- **Why is the reset endpoint safe to publish, with its token in the README?** Because the shop has no real shoppers and no real money, and the worst the token allows is what the reset undoes: put the demo back to baseline, or arm a supplier hang or refusal that the next reset (or the next check's own `PUT` before arming) clears. The token differs from the local default so the README can label it as the demo's; it reaches only the admin routes and the supplier knobs, never a secret; and R16 accepts the trade by decision — a reviewer who can reset the shop is a reviewer who can run the checks twice, which is the point.
- **Why not retry the harness burst automatically when K = 1?** For the reason `retries: 0` is set on the e2e and the race checks record their RED output: a witness that retries until it sees ≥ 2 cannot fail, and a witness that cannot fail is not a witness. Attempt 1's `FAIL` is a true statement about that burst on that platform at that moment; the transcript shows it, this document explains it, and the remedy is the one the `FAIL` line names — re-run — done by a person who then has two consecutive runs to compare, which is the criterion anyway.
- **`30 of 50` — why not 50? Doesn't reuse mean sharing?** Not in the Fluid sense. An instance that has finished a webhook is free and the platform prefers it to a cold one; it still takes one invocation at a time. Thirty is the count of processes fifty simultaneous arrivals needed, and every one of the fifty ran alone in its process with its own pool. The number to be suspicious of is 1, and it is what the harness fails on.
- **Two of five reviewer runs failed. Why is the recorded one honest?** Because both failures are in this document with their lines (§5), neither was the shop, and the recorded run is not the best of five — it is the second of the two consecutive runs the functional spec asks for, with the first beside it. A README that quoted #5 and hid #1 and #3 would be the dishonest version; the walkthrough is where #1 and #3 live.
- **The `503` boot probe was never exercised live.** True, and it is in §7 as not exercised: every variable was right the first time. It was proven on `node:http` in Slice 1 with a misconfigured child, and nothing in `vercel.ts` changed. Staging it live would mean deploying a broken environment on purpose; the acceptance test is the cheaper proof.
- **`maxDuration: 60` is asserted, not measured.** Also true (§7). The longest continuation in the recorded run is ~6 s, under the default 10 s as well. The configuration is read from the deployment; a run that exercised the override would need a ladder walk past 10 s — two probes of 5000 on both suppliers — which no check stages and no check should, since it would leave an order in `delivering` if the override were missing.

---

## 11. Interview questions this answers

**"What did the live run show, in one breath?"**
Nine unchanged checks against `https://game-shop-ochre.vercel.app`, `9/9` twice in a row, with the transcript itself saying how many processes answered — 5 of 8 health calls, 18 of 20 and 10 of 10 promo applications, 9 of 20 redeliveries, 30 of 50 webhooks — 39 database-side assertions reported as `SKIP` by name, the trap check reading the target's 5000 ms and arming 6500, and the reset taking 38 orders off at the end; the author's run with the database forwarded made every skipped assertion for real and counted 26 backend pids.

**"Why is 30 of 50 the number, and not 50?"**
K counts processes, N counts requests. A webhook handler stores and answers in tens of milliseconds, so instances that took the first reports are free before the last ones arrive and the platform reuses them — one invocation at a time each. Thirty is how many processes fifty simultaneous arrivals needed. The only number that would have mattered the other way is 1.

**"How do you know Fluid Compute was really off?"**
The project setting, turned off through the API before the first deploy. The transcript cannot prove a setting, but it rules out what the setting being on would produce: every burst answered by one instance. The one K = 1 in seven runs was the cheapest burst on a cold platform, beside four bursts in the same run at 17, 10, 8 and 19.

**"What does `pid: 4` on every line tell you?"**
That a process id is a witness only where processes share a kernel. Thirty instances, one pid. The process has to mint its own identity — `x-instance-id`, a UUID at module load — and the database has to keep its own — the backend pid on the direct host — and the two witnesses are read by two different runs.

**"Two of five runs failed. Which failures would have worried you?"**
Any failure with a database line behind it — a second `deliveries` row, a `used_count` above the cap, a `500`. Neither of these was that: one was the harness's own cheap-endpoint blind spot on a cold platform, one was a client socket that never got an answer, and in both the shop's answers that did arrive satisfied the invariant. What would have worried me is if either had been retried until green.

**"How did you size the timeout, and what did the platform actually cost?"**
Measured: 1.81 s of platform init plus 29 ms of Nest on a cold instance, 2.38 s end to end for a cold second invocation. The local 2000 ms would have read a healthy cold supplier as `unknown`; 5000 leaves room, two probes across two suppliers make the worst case 20 s (`worst_case_ms 20000`), and `maxDuration: 60` sits above that — necessary, because turning Fluid off had dropped the project's default to 10 s. The trap's 6500 sits between 5000 and 60 000, so a timeout is observed as a timeout and never as a killed function.

**"What happens to the first shopper after lunch?"**
Two clocks. Neon suspends its compute after five idle minutes (observed at 5 min 15 s) and the first query pays about 0.8 s to resume; the platform kept the instance warm longer than that (0.226 s for health after six minutes), so a shopper after a short pause pays Neon and not the function, and after a long one pays both — under three seconds in the worst case, inside the 10 s connection timeout. The runner absorbs it with a warm-up before the first check.

**"What is left on the shop after a reviewer's run, and who cleans it?"**
38 orders, 55 payment events, 6 deliveries, 9 attempts, 4 redemptions, 6 ledger rows, 6 keys claimed and one supplier behaviour row armed. The runner cleans it when `RACE_DEMO_RESET=1` is set, in one transaction after the last check; an operator cleans it with `pnpm demo:reset` at any other time. Without either, the next run's out-of-stock check meets 44 unclaimed keys instead of 50.

**"Why did the shop's own guard fire during a plain purchase?"**
Because the webhook's continuation on one instance and the shopper's poll on another both tried to take the order from `paid` to `delivering`, and the status-guarded update under the row lock let exactly one through — the log says the other `matched zero rows; this call does not own the order`. Phase 2's I4, on two instances, staged by nobody.

**"What does the author's run add that the reviewer's cannot?"**
The rows. `used_count = 3 for LIMIT3`, exactly three attempt rows after the retry (`a/1, b/2, a/3`), `a/1` reading `status=ok, probe_count=2` after the trap, one `deliveries` row per order, 26 backend pids — the 39 assertions the reviewer's transcript names as `SKIP`. Same command plus `RACE_DATABASE_URL`; zero `SKIP`s; the checks clean up after themselves and Neon reads baseline afterwards.

---

## 12. What is not finished

- **The README.** Slice 6's: the Russian root `README.md` in the assignment's order, with the alias, the recorded run quoted from `evidence/`, the one sentence about separate processes, the two maps, the time table, and the demo token labelled as the demo's. Every number in this document is written to be lifted into it.
- **The repository is not public.** `gh repo create … --public` and the final `vercel --prod --yes` from the committed tree are Slice 6's; until then the live shop equals a tree that is committed but not published, and the follow-up helper (§5) is in the working tree and not yet in a commit.
- **The time report.** Reconstructed from git, session transcripts and the walkthroughs' dates, confirmed by the author before it is written anywhere — Slice 6, not here.
- **No Playwright against the live URL.** The e2e config starts its own servers on 5101/5102 and does not take a base URL; the manual drive through the Playwright MCP — five interactions, buy, `LIMIT3`, pay, key, reload, the operator's view, zero console errors — covers the shopper's path, and the four screenshots are its record. Stated as not done, per tech spec §4.
- **`phases-1-to-5.md` has no Phase 6 pointer yet** — the one paragraph saying the live run is evidence for Phases 2 and 5 and needs no new map is Slice 6's last task, with `phase-6.md`.
- **`.env.example` does not yet describe the live profile** under `SUPPLIER_TIMEOUT_MS` (5000, probes 2, and why) and `ADMIN_TOKEN` (a fresh demo token, published, distinct from the local default) — tech spec §2.11 lists both comments; the carve-out under `ALLOW_CLIENT_SUPPLIED_ORDER_ID` and the `RACE_BASE_URLS` block are done.
- **The reset's `duration_ms` against Neon is unrecorded.** Slice 3 asked for one timing on a quiet host and one against Neon; the runner prints counts. One `pnpm demo:reset` with the response body read in full would settle it.
- **`maxDuration: 60` and the `503` boot probe are configured and proven elsewhere, not exercised live** (§7, §10).
- **The cause of the two `fetch failed`s is unknown**, and will stay so until the next one prints its `cause` through the helper.
- **Two recover checks still `SKIP` their database half as one blanket line** (Slice 4 §9); unchanged.
- **Eight stale sentences**, §8.8, awaiting the fix the parent schedules; none was edited.
- **The commit is the orchestrator's.** This document, the architecture amendments, the evidence transcript and the screenshots are in the working tree.

---

## 13. The two sentences

The standing requirement asks that each slice's question be answerable unaided, in two sentences, before any code is opened. For this slice — the shop live, and the sentence of the phase tested:

> The shop runs at `https://game-shop-ochre.vercel.app` as one static site and one Node function in `fra1` with Fluid Compute off — so every concurrent request is its own instance with its own `max: 1` pool and nothing in common with the next but the Neon Postgres in `eu-central-1` — and the reviewer's one command, `RACE_BASE_URLS=https://game-shop-ochre.vercel.app ADMIN_TOKEN=<the demo token> RACE_DEMO_RESET=1 pnpm race`, ran the nine unchanged checks against it and passed `9/9` twice in a row (attempts 4 and 5 of five, identical line for line once ids are normalised), with the transcript itself saying how many processes answered — `5 distinct instance id(s)` across the harness's eight health calls, `18` of 20 and `10` of 10 promo applications, `9` of 20 redeliveries, `30` of 50 webhooks — 39 database-side assertions reported as `SKIP` by name, the trap check reading `supplier timeout 5000 ms (from target /api/health)` and arming 6500, and the demo reset removing the 38 orders, 55 events and 6 deliveries the run left so the next run starts where this one did; the author's run with the database forwarded made every skipped assertion for real (`used_count = 3 for LIMIT3`, `a/1, b/2, a/3`, `probe_count=2`) and counted `26 distinct backend pid(s)`.

> That pass is evidence for Phases 2 and 5 and not a new argument because nothing in the checks or the shop changed between the laptop and the alias — the same `INSERT … ON CONFLICT`, the same `FOR UPDATE` and status-guarded `UPDATE`, the same `used_count < max_uses` — and what the platform removes is the one alternative explanation a four-process laptop run could not fully exclude, that a lock, a cache or a queue in one process's memory was doing the work: thirty processes that never shared a byte of memory still handed out one key, so the guarantee must live in the only thing they shared, with the caveat printed beside every K that a distinct id proves a distinct process and not that the processes overlapped, and that a harness reading of K = 1 — seen once, on a cold platform, from eight one-millisecond health calls a single warm instance served back to back while the work checks of the same run were answered by 17, 10, 8 and 19 — is the witness's known weak spot and a re-run, never a retry.

---

## Source files

- `vercel.json` — the eighteen lines: `framework: null`, the two commands, `outputDirectory`, `regions: ["fra1"]`, `functions."api/index.js".maxDuration: 60`, the three rewrites in order
- `api/index.js` — the one-line re-export of `../apps/api/dist/vercel.js`; "`vercel.json`, KEY BY KEY"; why `.js` and not `.ts`; the three things that are not keys (Fluid off, Node 22.x, `NODE_ENV` never set)
- `.vercelignore` — why the CLI's built-in list is not `.gitignore`, and why `dist/` must be named so the live shop is built from the published sources
- `apps/api/src/vercel.ts` — "A MISCONFIGURED INSTANCE ANSWERS `503` FOR ITS LIFETIME"; the cached promise; the handler's own `x-instance-id` on the `503`
- `apps/api/src/instance-identity.ts` — "THE HTTP WITNESS OF 'SEPARATE PROCESSES'"; one UUID per process; "WHAT IT PROVES, AND WHAT IT DOES NOT"; why not a platform value — and, after §8.3, why not the pid
- `apps/api/src/health.controller.ts` — `instance_id`, `runtime`, `supplier_timeout_ms` from `SUPPLIER_A_CONFIG`; `200` with an id means the container built
- `apps/api/src/config/client-supplied-order-id.ts` — the "MUST NEVER be set" comment with the demo carve-out, and the `warn` text that names it
- `apps/api/src/scheduling/wait-until-continuation-scheduler.ts` — the seam the log line `implementation: "wait_until"` reports
- `apps/api/src/issuance/issuance-runner.service.ts` — the boot line `worst_case_ms` with its three factors; `20000` under the live profile
- `apps/api/src/demo/demo-reset.service.ts` — the one transaction the reset block's counts come from; `IS DISTINCT FROM (0, 0, 0, 0, 0, false)` and why `supplier_behaviour 1`
- `scripts/race/run-checks.ts` — external mode; the mode line, the warm-up, the banner, `RACE_DEMO_RESET`; exit `2` on a refused reset
- `scripts/race/harness.ts` — the eight-call fan-out; `PASS` at ≥ 2 and `FAIL` at 1 with the Fluid detail; the two honesty lines; the `pg_stat_activity` pids; the request-and-target detail on a disagreement (working tree)
- `scripts/race/support/race-targets.ts` — `collectInstanceIds`, `describeInstanceIds` and the K = 1 flag
- `scripts/race/support/fetch-failure.ts` — "WHY `error.message` ALONE LOSES THE ONLY INTERESTING PART"; `MAX_CAUSE_DEPTH = 4`; the shape `fetch failed (cause: <code ?? name>: <message>)` (working tree)
- `scripts/race/recover-timeout.ts` — `resolveSupplierTimeout` and the three sources; `hangMs = supplierTimeoutMs + 1_500`
- `scripts/race/webhooks.ts`, `scripts/race/same-event.ts`, `scripts/race/promo.ts` — the K line after each burst; `promo.ts`'s no-database fallback to the promo reset
- `scripts/demo-reset.ts` — the operator's `pnpm demo:reset`; "WHO RUNS THIS, AND WHO MUST NOT"
- `packages/db/src/client.ts` — `max: 1`, `idleTimeoutMillis: 10_000`, `connectionTimeoutMillis: 10_000`, no prepared statements; "DECIDED: NO SWAP"
- `scripts/race/README.md` — "External mode"; "The instance-id witness"; "Which assertions need database access"; the two commands
- `docs/walkthrough/evidence/phase-6-live-race-run.txt` — the recorded run, every line quoted above
- `docs/screenshots/006-live-{storefront,order-with-promo,delivered,admin}.png` — the manual drive
- `context/product/architecture.md` §5, §7, §9 — amended in this slice with the observed values (the layout, the HTTP witness beside the pid proof, the three trade-off bullets)
- `context/spec/006-live-shop-and-the-written-answer/technical-considerations.md` §2.1, §2.2, §2.7, §2.10, §2.11, §3 — the plan this slice tested; every row of §7 above is one of its sentences with an answer

**On evidence:** what I did while writing this document, against the tree as it stands: nothing was run against the live shop or against any database, no server was started, no port bound, and no source, test, config or spec file was modified — the two files written are this walkthrough and the amendments to `context/product/architecture.md`. Read in full: `vercel.json`, `.vercelignore`, `api/index.js`, `docs/walkthrough/evidence/phase-6-live-race-run.txt` (285 lines; every quoted line — `5 distinct instance id(s) across 1 target(s)`, `18 distinct`, `10 distinct`, `9 distinct`, `30 distinct`, `supplier timeout 5000 ms (from target /api/health)`, `hang_ms: 6500`, the reset block, the nine durations, `9/9 passed against 1 instance(s)` — is in it verbatim), the four Phase 6 slice walkthroughs, tech spec §1–§4, functional spec §2.1–§2.2, architecture §5–§9, the race README's external-mode and witness sections, and `scripts/race/support/fetch-failure.ts`'s header plus `git diff` over the ten script files it touched. `ls docs/screenshots/006-live-*.png` — four files, 20–213 KB, timestamped 13:57–13:59 on the day of the runs. `grep -n "engines.node" api/index.js` — line 86, for §8.8. `sed -n 237p .env.example` — the `12 S EXCEEDS` line, for §8.8. Every number that is not in the transcript — the deployment id, 57.8 s, `iad1`, `1.93MB`, pnpm 10.18.0, the `PATCH` body, 300 → 10 s, 0.444 / 0.325 / 0.97 / 2.38 / 4.31 / 0.226 / 0.793 s, 1.81 s + 29 ms, 5 min 15 s, `pid: 4`, the guard's log line, the K lines of attempts 1–4 and the author's two, `26 distinct backend pid(s)`, "~2 in ~900", the manual drive's ~3 s and zero console errors — is the task reports' and is quoted, not re-measured.
