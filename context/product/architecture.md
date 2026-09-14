# System Architecture Overview: Game Shop — Digital Goods Storefront

_Every choice below is justified against one requirement: the system must stay correct when requests repeat, arrive simultaneously, or arrive out of order — including across separate processes. Alternatives considered are named so the trade-offs can be defended._

---

## 1. Application & Technology Stack

- **Repository layout:** pnpm workspace monorepo — `apps/web`, `apps/api`, `packages/contracts`, `packages/db`. _Alternatives: two repos (splits the shared contract and doubles deployment setup); npm/yarn workspaces (equivalent, pnpm chosen for speed and strict linking)._
- **Frontend:** Vite + TypeScript with vanilla DOM components, organised in FSD-inspired layers (`app / pages / features / entities / shared`). _Alternative: React — deliberately declined; the assignment prefers no heavy framework and there are five interactive elements._
- **Backend framework:** NestJS on the Express adapter. _Alternatives: bare Fastify (lighter, faster cold starts, but less structure); Express alone (no DI, weaker module boundaries). Nest earns its cost through explicit modules and testable providers._
- **Language:** TypeScript end to end, strict mode.
- **Shared contracts:** `packages/contracts` holds the order lifecycle enum, webhook payload and supplier `/issue` types, imported by both apps and by the race scripts, so the wire format has a single definition.
- **Runtime:** Node.js 22 LTS.

---

## 2. Data & Persistence

- **Primary database:** PostgreSQL 16. _Alternatives: SQLite or file storage (permitted by the assignment, but they cannot demonstrate row locks or concurrent constraint enforcement — the entire subject of the test); MySQL (workable; Postgres chosen for `FOR UPDATE SKIP LOCKED`, partial unique indexes and `ON CONFLICT ... RETURNING`)._
- **Hosted instance:** Neon, connected through its pooled (PgBouncer) endpoint. _Alternatives: Supabase or Vercel Postgres (both fine); Neon chosen for instant provisioning and a serverless driver that supports real transactions._
- **Local instance:** Postgres 16 in Docker Compose, so the same engine runs in development and production.
- **Query layer:** Drizzle ORM with `drizzle-orm/neon-serverless`. _Alternatives: Prisma — genuinely capable here (interactive transactions, atomic increments, and column-to-column comparison via field references all work natively); its one real gap is that it has no pessimistic locking in the query API, so `FOR UPDATE` and `FOR UPDATE SKIP LOCKED` drop to `$queryRaw`. It is also heavier in serverless, though driver adapters have narrowed that. TypeORM: closest to Nest conventions and has first-class locking, but weaker type inference. Drizzle chosen for typed locking and the lightest serverless footprint._
- **Documentation convention (decided):** every correctness-critical Drizzle call carries a comment with the **exact SQL it emits**, and §3.1 below collects them in one place. The point is that the reviewer never has to know Drizzle to audit the guarantees, and the ORM is visibly a convenience over SQL that is understood rather than a substitute for understanding it. The same pairings go into the README.
- **Migrations:** `drizzle-kit` generated SQL, applied by a versioned migration runner. Seeds load the supplied catalog, key pool and promo codes.
- **Connection policy:** pool size of 1 per function instance against the pooled endpoint, prepared statements disabled. This is what keeps fifty concurrent invocations from exhausting the connection limit.
- **Isolation level:** default `READ COMMITTED`, with correctness carried by explicit unique constraints, row locks and conditional updates rather than by `SERIALIZABLE`. _Alternative: `SERIALIZABLE` — correct, but it moves the guarantee into an invisible retry-on-conflict loop; explicit constraints are both cheaper and far easier to defend in an interview._

### Core tables

| Table | Purpose | Key constraints |
| --- | --- | --- |
| `products` | Catalog from the supplied JSON | `sku` UNIQUE |
| `orders` | Order and its lifecycle | `client_request_id` UNIQUE |
| `payment_events` | Durable webhook inbox | `event_id` PRIMARY KEY; **no FK** to `orders` |
| `issuance_attempts` | One row per supplier call | `request_id` UNIQUE; FK to `orders` |
| `deliveries` | The issued key bound to an order | `order_id` UNIQUE, `request_id` UNIQUE; FK to `orders` |
| `promo_codes` | Supplied promo definitions | `code` UNIQUE, `used_count <= max_uses` CHECK |
| `promo_redemptions` | Which order used which promo | UNIQUE (`promo_id`, `order_id`) |
| `supplier_keys` | The fifty keys — **supplier-side** inventory | `code` UNIQUE, `claimed_by_request_id` UNIQUE |
| `supplier_requests` | Supplier's own idempotency ledger | `request_id` UNIQUE |

**The foreign-key asymmetry is deliberate and load-bearing.** `deliveries.order_id` and `issuance_attempts.order_id` reference `orders`; `payment_events.order_id` does not. The rule is *who can write this row before the order exists*: a delivery or an attempt can only ever be written by code that has already read the order, so a dangling reference there is a bug worth refusing. A payment event can legitimately arrive first — the client's `POST /orders` and the provider's webhook are separate connections in separate processes with no ordering guarantee — so refusing it would turn a millisecond race into a `500`, and a `5xx` is how you ask a payment provider to redeliver. Both the schema and the migration carry a boxed comment saying so, and the two FKs ten lines away are what stop the omission reading as forgetfulness.

The last two tables belong to the simulated suppliers, not to the shop. Keeping them separate is deliberate: it forces our code to earn its guarantees over an unreliable network boundary instead of quietly sharing state with the thing it is supposed to distrust.

- **Order identifiers:** prefixed sortable ids (`ord_01J…`) so they read like the contract's `ord_00123` and sort by creation time.

---

## 3. The Correctness Model

The centre of the system. Each invariant names the mechanism that enforces it and the failure that occurs without it.

| # | Invariant | Mechanism | Without it |
| --- | --- | --- | --- |
| I1 | One client request → one order | `client_request_id` UNIQUE; `INSERT … ON CONFLICT DO NOTHING`, then read the winner back | A double-click creates two orders and two charges |
| I2 | One payment event is applied once | `event_id` PRIMARY KEY; `INSERT … ON CONFLICT DO NOTHING` decides duplicate vs. first sight | A redelivered webhook re-runs issuance |
| I3 | One order → at most one delivery | `deliveries.order_id` UNIQUE | Two concurrent workers both see "not delivered" and both issue |
| I4 | Only one worker advances an order | `SELECT … FOR UPDATE` on the order row, plus status-guarded updates (`WHERE status = 'paid'`) | Fifty webhooks make fifty supplier calls — and still exactly one key, because I5's ledger and I3's UNIQUE do the key-count work. Measured in Phase 2: widening the guard cost 49 avoidable supplier calls, not a second key |
| I5 | One supplier request → one code | Supplier stores `request_id → code`; a repeat returns the stored code | A retry after timeout issues a second key |
| I6 | One key → at most one request | `supplier_keys.claimed_by_request_id` UNIQUE; claim by conditional `UPDATE … RETURNING` | The same key is sold twice |
| I7 | A promo is used at most N times | `UPDATE … SET used_count = used_count + 1 WHERE used_count < max_uses RETURNING` | Parallel redemptions overshoot the limit |
| I8 | One promo redemption per order | UNIQUE (`promo_id`, `order_id`) | A retried order double-counts against the limit |
| I9 | Final states are terminal | Status-guarded transitions; `delivered` and `payment_failed` accept no further transitions | A late webhook resurrects a completed order |

### 3.1 The SQL underneath

Each mechanism above, as the statement Postgres actually executes. These pairings live beside the code as comments and are reproduced in the README.

**These blocks are copied from the code's own `.toSQL()` output, not written by hand.** I1 and I2 drifted once — they carried a hand-written `VALUES` insert with an `amount` column while the code emitted `INSERT … SELECT` with `amount_minor` — and the drift was caught by an audit of `docs/walkthrough/phase-2.md`, which had quoted the code correctly and therefore disagreed with this file. When a statement changes, re-copy it from the service's `Emitted SQL` comment rather than editing it here.

**I1 — one client request → one order.** The insert itself decides the winner; nobody reads first.

```sql
insert into "orders" ("id", "client_request_id", "sku", "amount_minor",
                      "currency", "status", "created_at", "updated_at")
select $1 as "id", $2 as "client_request_id", "sku", "price_minor",
       "currency", $3 as "status",
       now() as "created_at", now() as "updated_at"
from "products"
where ("products"."sku" = $4 and "products"."purchasable" = $5)
on conflict ("client_request_id") do nothing
returning "id", "sku", "amount_minor", "currency", "status";
-- $1 the application-minted `ord_` + ULID, $2 the Idempotency-Key or NULL,
-- $3 the literal 'created', $4 the SKU from the request body, $5 true.
-- 1 row  => THIS call created the order, priced from the catalogue row in
--           the same statement. 201.
-- 0 rows => TWO DIFFERENT THINGS, and they must not be conflated: either the
--           client_request_id already made an order (read it back, 200), or the
--           SKU is not purchasable, so the conflict clause was never reached
--           (422). A follow-up SELECT on client_request_id tells them apart, and
--           runs only on this path.
```

It is `INSERT … SELECT` rather than `INSERT … VALUES` for a reason worth stating: the price is copied
out of the catalogue row **column-to-column, inside the same statement**, so no client-supplied amount
ever participates and there is no window in which the price could be read and then changed.

**I2 — one payment event applied once.** The same shape, and it is also how duplicate detection works: winning the insert means "first sight", losing it means "already seen".

```sql
insert into "payment_events" ("event_id", "order_id", "status",
                              "amount_minor", "currency", "payload",
                              "received_at", "processed_at")
values ($1, $2, $3, $4, $5, $6, default, default)
on conflict ("event_id") do nothing
returning "event_id", "order_id", "status", "amount_minor", "currency",
          "payload", "received_at", "processed_at";
-- 1 row  => FIRST SIGHT of this event. It is durable now, with processed_at
--           NULL, and this call is the one that must process it. Exactly one
--           caller ever sees this per event_id, across every process.
-- 0 rows => REDELIVERY. Acknowledge 200 and stop.
```

The conflict target is **named** (`event_id`) rather than left bare, so this clause forgives exactly one
constraint. A future `NOT NULL` or `CHECK` failure still raises, instead of being silently reported to the
payment provider as a duplicate.

**I3 — one order → at most one delivery.** The constraint is the guarantee; the `ON CONFLICT` only keeps the loser from raising.

```sql
INSERT INTO deliveries (order_id, code, provider, request_id)
VALUES ($1, $2, $3, $4)
ON CONFLICT (order_id) DO NOTHING
RETURNING *;
```

**I4 — only one worker advances an order.** The lock serialises the workers; the status guard makes the transition itself idempotent.

```sql
BEGIN;
SELECT * FROM orders WHERE id = $1 FOR UPDATE;

UPDATE orders SET status = 'delivering', updated_at = now()
WHERE id = $1 AND status = 'paid'
RETURNING *;
-- 0 rows => someone else already advanced it; this worker does nothing
COMMIT;
```

**Draining the inbox.** `SKIP LOCKED` is what lets several workers pull from the same queue without ever handing one event to two of them.

```sql
SELECT * FROM payment_events
WHERE processed_at IS NULL
ORDER BY received_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
```

**I5 — one supplier request → one code.** Inside the supplier stub, before any key is touched.

```sql
SELECT code FROM supplier_requests WHERE request_id = $1;
-- found => return that code unchanged, however many times we are asked
```

**I6 — one key → at most one request.** The subquery picks an unclaimed key and locks it; the outer update claims it. `claimed_by_request_id` is UNIQUE, so even a lost race cannot produce a double claim.

```sql
UPDATE supplier_keys
SET claimed_by_request_id = $1, claimed_at = now()
WHERE code = (
  SELECT code FROM supplier_keys
  WHERE claimed_by_request_id IS NULL
  ORDER BY id
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING code;
-- 0 rows => pool exhausted => out_of_stock
```

**I7 — a promo is used at most N times.** One statement: no read-then-write, so there is no window to race in.

```sql
UPDATE promo_codes
SET used_count = used_count + 1
WHERE id = $1 AND used_count < max_uses
RETURNING *;
-- 0 rows => exhausted; reject the redemption
```

**I8 — one redemption per order.** Keeps a retried order from consuming a second use of the same code.

```sql
INSERT INTO promo_redemptions (promo_id, order_id)
VALUES ($1, $2)
ON CONFLICT (promo_id, order_id) DO NOTHING;
```

**I9 — final states are terminal.** Every transition names the states it is allowed to leave from, so a late webhook cannot resurrect a completed order.

```sql
UPDATE orders SET status = $2, updated_at = now()
WHERE id = $1 AND status = ANY($3)  -- permitted source states only
RETURNING *;
```

- **The governing principle:** every guarantee is enforced by the database, never by a check-then-act in application code and never by an in-process lock. Two requests may both observe "no delivery yet"; only one can win a unique index.
- **Idempotency key:** clients send `Idempotency-Key` on order creation; it is stored as `client_request_id`. A repeat returns the original order with `200` rather than creating a second.
- **Order lifecycle:** `created → paid → delivering → delivered`, with branches to `payment_failed`, `out_of_stock` and `delivery_failed`. The last two are recoverable and re-enter `delivering`.

---

## 4. Asynchronous Processing & Delivery

- **Webhook handling pattern:** receive → persist → acknowledge → process. The endpoint writes to `payment_events` and returns `200` immediately; issuance happens outside the acknowledgement path. `5xx` is returned only when we genuinely want redelivery, because the provider retries on it.
- **Out-of-order tolerance:** `payment_events.order_id` carries **no foreign key**. An event for an order that does not exist yet is stored with `processed_at` null and drained later — this is what makes "webhook before order" a normal path rather than an error.
- **Work queue:** the inbox is the queue. Pending events are claimed with `SELECT … FOR UPDATE SKIP LOCKED LIMIT 1`, which lets several workers drain it concurrently without ever handing the same event to two of them. _Alternatives: Redis/BullMQ or SQS — real queues, but they add infrastructure to a system that already has a transactional store, and the queue would sit outside the transaction that must commit with the state change._
- **Processing triggers,** layered so no single one is load-bearing:
  1. `waitUntil` from `@vercel/functions` continues processing after the webhook response is sent.
  2. Order creation drains any events already waiting for that order id.
  3. The order status poll opportunistically drains that order's pending events.
  4. An admin sweep endpoint drains everything still pending.
  - _Vercel Cron is deliberately not depended on: the Hobby plan permits roughly daily runs, which is useless as a safety net. It can be added on a paid plan without changing any code._
- **Supplier retry policy** — the assignment's central trap:
  - `ok` → record the delivery.
  - **Definite failure** (a `4xx`/`5xx` with a reason) → mark the attempt failed, then try the fallback supplier with a **new** `request_id`.
  - **Timeout** → the attempt is `unknown`, never failed. Retry **the same supplier with the same `request_id`**, which returns the original code if one was issued.
  - **The hard rule:** never fall through to the backup supplier while any attempt is `unknown`. Exhausting the retries moves the order to `delivery_failed`, and manual retry re-probes the outstanding `request_id` before anything else.
- **Request id derivation:** deterministic per attempt (`req_{order_id}_{provider}_{attempt}`), so a retry naturally reuses the identifier instead of relying on a caller to remember it.
- **Recovery:** `out_of_stock` and `delivery_failed` orders are listed in the admin panel and retried through the same idempotent path the automatic flow uses — so a retry cannot produce a second key.

---

## 5. Infrastructure & Deployment

- **Hosting:** Vercel — `apps/web` as a static build, `apps/api` as a single Node serverless function that bootstraps Nest once and caches it across invocations. _Alternatives: Railway or Fly.io for a long-lived API process (simpler concurrency story, but a long-lived process would let an in-memory lock accidentally paper over a missing database guarantee — the serverless split proves it isn't there)._
- **Why serverless strengthens the claim:** concurrent requests land in separate processes, so passing the fifty-webhook scenario against the deployed URL is direct evidence that correctness lives in Postgres and not in one process's memory. This is the README's strongest sentence.
- **Local development:** Docker Compose (Postgres + API + web) with one-command startup, seeds included. The assignment accepts a fully local setup, so this is the guaranteed path; the deployment is the bonus.
- **Configuration:** environment variables for the database URL, supplier failure and timeout rates, retry counts and the admin token. Supplier behaviour must be tunable at runtime so every failure scenario can be reproduced on demand.
- **Serverless timeouts — two hang scenarios, and they need opposite orderings.** The supplier stub's deliberate hang is configuration, not a constant, and which side of `SUPPLIER_TIMEOUT_MS` it lands on decides which scenario is being staged. Both are worth having as named checks; neither substitutes for the other.

  | Scenario | Where the hang sits | Required ordering | What it demonstrates |
  | --- | --- | --- | --- |
  | Slow but successful | before the key claim, short (`hang_before_claim: true`) | `hang_ms < SUPPLIER_TIMEOUT_MS` | a slow supplier is not a failed one — the call completes normally and no timeout occurs |
  | **The timeout trap** | **after the key claim commits, long (the default)** | **`SUPPLIER_TIMEOUT_MS < hang_ms < function execution ceiling`** | a key genuinely issued, a client that timed out and cannot know it, and a re-probe on the same `request_id` that gets the same code back |

  **The placement is stored, not compiled in.** `supplier_behaviour.hang_before_claim` (migration 0004) selects between the two rows above and is armed per check beside `hang_ms`, through `PUT /internal/suppliers/:provider/behaviour`. It is a boolean rather than an enum because the key claim and its ledger write are one transaction, so there are exactly two honest placements — and the only third value anybody would reach for is *inside* that transaction, which would hold the instance's one pooled connection for `hang_ms` and stall every other request in the process. It defaults to `false`, i.e. **after the claim**, because that is the scenario this phase exists to demonstrate; the other must be asked for by name.

  **The trap's ordering is the one the retry policy above turns on, and it was written backwards here until Phase 3.** The old text gave `hang < SUPPLIER_TIMEOUT_MS < ceiling` as the rule for every case, which produces no timeout at all: the client waits, the supplier answers, and a timeout check staged that way passes having exercised nothing. It was not simply inverted — it describes the first row, and was being cited as the basis for the second.

  The reasoning offered for the old direction conflated two different events, and keeping them apart is the point of this bullet:

  - **The client giving up.** `AbortSignal.timeout` aborts the *shop's own socket* (`apps/api/src/issuance/supplier.client.ts`). It does not stop the supplier's handler, which keeps running, may claim a key, and may finish its work and write a response nobody is listening for. That is exactly what makes a timeout **`unknown`** rather than **`failed`**, and it is the whole subject of §4's retry policy. Measured, not assumed: a client aborting at 200 ms against a handler that claims at 400 ms throws `TimeoutError` while the claim still commits and the ledger still holds the code.
  - **The platform killing the function.** That is the execution ceiling's doing, not the timeout's — no exception, no `catch`, no log line, no attempt row updated, and an order left in `delivering` holding a key that may or may not exist.

  `SUPPLIER_TIMEOUT_MS < ceiling` is what stops the second from pre-empting the first, and it holds in both rows: **a timeout must always be observed as a timeout, never as a killed function.** `hang_ms < ceiling` is the trap row's right-hand term, and it is what leaves the supplier time to finish and have a code on file for the re-probe to find.

---

## 6. Simulated External Services

- **Payment provider:** a stub endpoint that emits webhooks matching the supplied contract, callable from the order page and from the race scripts. No real acquiring, and — as the assignment waives it — no signature verification.
- **Suppliers A and B:** two HTTP endpoints implementing `POST /issue`, deployed as part of the API but reached over real HTTP so that latency, timeouts and failures are genuine rather than simulated in-process. Each supports configurable failure and timeout rates and honours the same-`request_id`-same-code rule through `supplier_requests`.
- **Key pool:** the fifty supplied keys live in `supplier_keys` as supplier-side inventory. Exhausting it is how the empty-pool scenario is produced; restocking is an admin action.
- **Authentication:** none for the storefront; a single shared bearer token for the admin panel, which is the assignment's stated minimum.

---

## 7. Testing & Verification

- **Concurrency proofs must run across separate API processes.** This is the single most important rule in this section, and it was learned by measurement rather than reasoning. `packages/db` sets the connection pool to `max: 1` per instance — the serverless shape — so within one process a transaction holds the only connection for the whole of `BEGIN … COMMIT` and a second concurrent claim queues **in Node, before a byte reaches Postgres**. `FOR UPDATE SKIP LOCKED` never skips, because nothing else holds a row lock when the subquery looks. The consequence: a claim written with **no locking at all** behaves identically to the correct one. Measured, with the key claim weakened to an unlocked `SELECT`-then-`UPDATE` and twenty distinct request ids:

  | Harness | Codes handed out | Distinct | Errors |
  | --- | --- | --- | --- |
  | 1 process, pool of `max: 1` | 20 | **20** | 0 |
  | 4 processes, pool of `max: 1` each | 20 | **9** | 0 |

  The same broken code is flawless in one process and hands eleven customers a key somebody else also holds in four — with nothing raised or logged in either case. A single-instance run measures the connection pool, not the constraint. **Raising the pool size in tests is not the fix**: `max: 1` is the production shape, and a test that changes the configuration under test proves some other system correct.

- **RED validation is a property of the harness, not only of the code under test.** Weakening the mechanism a concurrency test defends must make that test fail. If it does not, the harness is serialising and the test is worthless — and no number of green runs will say so. A race test that cannot fail is worse than no test: it is a false statement about the system that grows more convincing every time it passes. Record the RED output; a count that varies between runs (9, then 12, of 20) is the signature of a genuine race.

- **Assertions query the database directly** as well as reading the API response — one delivery row, one claimed key, one promo redemption. The two disagree in *both* directions, and only asserting both distinguishes them: a mis-classified driver error once returned `500` to nineteen of twenty callers while the database stayed perfectly correct, and a broken delivered-key gate once returned a self-consistent `null` to every read while the key sat committed in `deliveries`. Response-only would call the first a correctness failure; database-only would call the second a pass.

- **Test layout:** Vitest, configured in `apps/api/vitest.config.ts`, with tests under `apps/api/test/`:
  - `test/concurrency/` — the race proofs. `key-claim-race.test.ts` plus a `support/` harness that spawns real compiled API processes on dedicated ports, waits on `/api/health`, tears them down on `SIGTERM`, and samples `pg_stat_activity` for distinct backend pids as a smoke check that the processes genuinely overlapped.
  - `test/acceptance/` — feature-level tests mapping the functional spec's criteria, run against one API process, since nothing there needs overlapping requests.
  - Both assert the seeded baseline before and after, and clean up what they wrote, so they are re-runnable with no manual reset. Restoring `claimed_by_request_id = null` is a thing **only a test may do** — production has no un-claim, by design.
  - Reviewer commands: `pnpm test` (the API suites, then `test:web`), `pnpm test:concurrency`, `pnpm test:acceptance`, `pnpm test:web`, and `pnpm test:e2e` — the last after a one-time `pnpm exec playwright install chromium`.

- **Adversarial scripts taking a base URL** (`race:webhooks` for fifty webhooks on one order, `race:same-event`, `race:create-order`, `race:promo`, `recover:out-of-stock`, `recover:timeout`, `webhook:before-order`) arrive with the phases that own their scenarios. Written against a configurable base URL so the identical script runs locally and against the deployed system — which is the strongest form of the claim, since serverless instances share neither kernel nor clock.

- **Browser tests: two layers as of Phase 4, admitted by the trigger Phase 1 named.** Phase 1 had deliberately none: every DOM-visible fact in the spec's criteria was a branch-free rendering of data the integration tests already asserted at the API and database boundary, so a browser-test project would have added infrastructure without adding coverage. What would change that judgement, it said, was a conditional in the rendering path that *derives* a fact rather than mirroring one — a client-computed discount, a status label with a `default` branch — and Phase 4, which rebuilds the UI, was the place to revisit it. Phase 4 met the trigger four times over: wrap arithmetic, a timer policy that emits one instruction per event, a menu state rule, a five-from-N row selection. The answer is two layers, not one (`context/spec/004-storefront-per-the-design/technical-considerations.md` §4):

  | Layer | What it proves | RED method | Command |
  | --- | --- | --- | --- |
  | Vitest in `apps/web` — `environment: "node"`, no jsdom, colocated `src/**/*.test.ts` | The pure models the DOM calls. At the phase's close: `pages/storefront/model/{carousel,countdown,menu,select-popular-products}.test.ts` and `entities/product/api/products-api.test.ts` — 5 files / 56 tests, ~200 ms | As the API suites practise it — a mutation of the one line the test guards. `wrapIndex` without the `+ count` normalisation fails only *first→last* and leaves *last→first* green (the quiet half-failure); `restart` without `clearTimeout` fails "restart twice → fires once" with two calls | `pnpm test:web`, chained after the API suites in `pnpm test` |
  | Playwright under `apps/web/e2e/` — one Chromium project, `workers: 1`, `retries: 0` | The five graded interactions, the inert controls and the buy-through in a real browser a reviewer can run, arriving with the slices that own them; at the phase's close nine spec files — eight behaviour-level guards and one acceptance walk — 58 tests in ~45 s. The carousel's 5-second policy runs under `page.clock`; the buy-through spec must not install it, or the order page's poll freezes | Weakening nothing in `src/`. Every "nothing happened" assertion is pointed, identical, at Купить — it failed on three lines (a `document` request to `/order/ord_…`, a `POST /api/orders`, the URL changed). Every "state changed" assertion pushes the clock past the boundary | `pnpm test:e2e` — **not** chained into `pnpm test`: it needs a browser and starts servers. Install once: `pnpm exec playwright install chromium` (one browser, revision 1243, a ~276 MB download) |

  `retries: 0` for the reason the race tests record their RED output: a test that passes on the second try is a false statement, not a pass.

  **Ports.** The config owns both servers — **5101 (Vite) / 5102 (API)** — with `reuseExistingServer: false`, the API started with the same five env lines `apps/api/test/concurrency/support/api-instance.ts` sets, and both listed in `scripts/race/README.md`'s port row. That row exists because three phases produced three near-collisions, the last during this phase's own tech spec: a proposed 4301 was already `single-issuance-under-races.test.ts`'s. Two preflight checks in the config say what a bare run is missing — no `DATABASE_URL` prints "run pnpm test:e2e from the repository root"; no browser prints `pnpm exec playwright install chromium`.

  **The database precondition is shared, and the e2e restores it.** The API suites assert `orders = 0` and `unclaimed = 50` before they run; every order the e2e creates is deleted in `afterEach` through the same six statements as `cleanupTestOrders`, duplicated in `e2e/support/db.ts` with a comment naming the source of truth. Two things were learned by measurement on the way to that rule, and they are why it reads as it does:

  | Finding | Measured | Rule it produced |
  | --- | --- | --- |
  | The first fixture read the `POST /api/orders` body with a fire-and-forget `response.json()` and lost the race to `location.assign` on the very next line of `buy()` | **1 orphan order** after a buy-through; **0** with the fix | Capture the id host-side with `page.route` + `route.fetch()`, so it is in hand before the page sees the response it navigates on |
  | Two suites sharing one database cannot run concurrently: a `pnpm test` started while another run was in flight | Failed its own precondition with `orders = 55, expected 0`; run sequentially, both green — the API run 11 files / 90 tests, then the web models 5 files / 56 tests, and 58 e2e tests in ~45 s | One database, one runner at a time: `workers: 1` inside the project, and never two projects at once |

  **What remains manual.** The back/forward-cache restore — any attached CDP session disqualifies the page, measured three times as `persisted: false` / `notRestoredReasons: masked`, so no automation reaches it — needs a person in real Chrome (DevTools → Application → Back/forward cache → Test); `docs/walkthrough/phase-4.md` §6 carries a placeholder for that verdict until it is done. A fade *as seen* is not asserted: the e2e reads `transition-duration` and end states, never an interpolated value, because a computed style mid-transition is the classic false negative. Delivery *correctness* is still the API suites' proof — the buy-through watches a key arrive; one-order-per-intent and one-key-per-payment are enforced, and proven, at the boundary below.

- **Coverage target:** the five acceptance scenarios each map to a named, runnable test or script — and, since Phase 4, the storefront's five graded interactions map the same way to a spec under `apps/web/e2e/`. That mapping is the deliverable, and it lives in the README.

---

## 8. Observability & Configuration

- **Logging:** NestJS's built-in `Logger` with structured object payloads carrying `order_id`, `event_id` and `request_id` on every line in the payment and issuance paths. _Pino was specified here originally and deliberately not adopted: adding a logging dependency is an infrastructure decision that no Phase 1 task owned, and Nest's logger already gives the correlation ids, which are the part that matters — they are what make a race reproduction readable after the fact. Revisit if structured log shipping is ever needed._
- **Request correlation:** an incoming request id is generated or accepted, then carried through logs and into supplier calls.
- **Error handling:** typed domain errors distinguishing *definite failure* from *unknown outcome*, because that distinction is what drives the retry policy rather than being merely descriptive.
- **Configuration is validated at startup, not at first use** (`apps/api/src/config/`). A shop that boots without knowing where its supplier lives looks healthy and cannot deliver anything, so a missing or malformed value stops the process rather than surfacing as a `500` on the first paid order. Two traps this catches that a naive read does not: `SUPPLIER_A_URL=localhost:3000/…` — a forgotten `http://` — **parses cleanly** as scheme `localhost:` and would fail only inside `fetch`; and a timeout of `2e3`, `0x7d0` or `2000ms` is silently accepted by `Number()`. One caveat worth knowing: this is right *by consequence, not by construction* — the reads sit in constructors, and constructors are startup-time only because Nest instantiates default-scoped providers eagerly. A `Scope.REQUEST` would relocate the check to first use with no test noticing. On Vercel, boot **is** the first invocation, so this guarantee is load-bearing locally and advisory in deployment.
- **Metrics and alerting:** out of scope. The admin panel's paid-but-undelivered list is the operational surface.

---

## 9. Known Trade-offs

Stated plainly here so they carry into the README rather than being discovered by the reviewer:

- **A Postgres-backed inbox is not a broker.** It is right at this scale and keeps the state change and the queue in one transaction; at high volume a real queue with a dead-letter path would replace it.
- **Serverless costs cold starts.** The fifty-webhook scenario may run slower than it would against a long-lived process. That is a fair price for proving the guarantees are not process-local, and the scripts also run locally.
- **No signature verification on webhooks.** Waived by the assignment; in production this endpoint is unauthenticated and would need HMAC verification.
- **A test affordance on order creation.** The API accepts an explicit order id behind a configuration flag, used only by seeds and the "webhook before order" script. Without it that scenario cannot be staged deterministically, since order ids are otherwise server-generated.
- **`READ COMMITTED` plus explicit locks, not `SERIALIZABLE`.** The chosen path is more verbose but visible; the alternative hides the guarantee in retry logic.
