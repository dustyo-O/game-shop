# Technical Specification: Promo Codes with Enforced Limits

- **Functional Specification:** `./functional-spec.md`
- **Status:** Completed
- **Author(s):** Alexander Shleyko

---

## 1. High-Level Technical Approach

The architecture already carries this phase's design in two rows of its invariant table: **I7** — a promo is used at most N times, enforced by one conditional `UPDATE … WHERE used_count < max_uses RETURNING`, and **I8** — one redemption per order, enforced by a unique index. Phase 5 builds the tables those rows describe, the one transaction that uses them, the endpoint and page that let a shopper reach it, and the proofs that the limit holds across four processes. The purchase path is not changed: a discounted order is an order whose `amount_minor` is smaller, and the payment simulator, the webhook, the issuance ladder and the recovery screen all read that column as they always have.

Four decisions are made here that the functional spec leaves open:

1. **`orders.amount_minor` is the amount to pay.** The list price and the discount are recorded on the redemption row (`list_amount_minor`, `discount_minor`) — stored, not derived, because "the record of what was paid does not change after the fact" is a property of columns. No new column on `orders`; the payment simulator already reads `amount_minor` and so carries the discounted amount to the webhook with no change (`payment-simulator.service.ts`'s `readOrderCharge`).
2. **Every refusal is decided before anything is written, so an expected refusal commits with nothing to roll back.** This codebase never throws a sentinel to abort a transaction; services return a discriminated-union outcome and controllers `switch` on it. The transaction is ordered so that every statement that can say "no" — the order lock, the status check, the code lookup, the already-applied read, the I7 guarded increment — runs before either write that follows it; the only rollback path is an invariant violation under the lock, which is a `500` and a bug.
3. **One code per order, enforced as `UNIQUE (order_id)`** — stronger than architecture §3's `(promo_id, order_id)`, which would have allowed two different codes on one order. The stronger key implies the weaker, so I8 still holds; architecture.md is amended.
4. **Two proofs of the limit, at two layers, plus the reviewer's check.** A four-process Vitest race (ports 5201–5204) and `pnpm race promo` both fire twenty simultaneous redemptions of `LIMIT3` and ten of `ONCEONLY` and assert **on the responses and the redemption rows, never only on `used_count`** — the `CHECK (used_count <= max_uses)` would turn a weakened guard's fourth increment into a thrown error rather than a fourth use, which is Phase 2's UNIQUE-masks-a-broken-lock lesson wearing a CHECK constraint.

Systems affected: `packages/db` (migration `0006`, two tables, a fixture, the seed, both test harnesses' baseline and cleanup), `apps/api` (a `promo` module, one exported repricing service in `orders`, the order view, one admin affordance), `apps/web` (the order entity's parser and details, a new `apply-promo` feature, the order page's repaint rule, `HttpError`), `scripts/race` (one check), docs. Systems untouched: the storefront, the issuance ladder, the recovery screen, the payment webhook and processor.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1 Data model

| Table | Columns | Constraints | Notes |
| --- | --- | --- | --- |
| `promo_codes` | `id serial PK`; `code text` — stored upper-case; `kind text`; `value integer` — percent points for `percent`, minor units for `amount`; `currency text NULL`; `max_uses integer`; `used_count integer NOT NULL DEFAULT 0` | `UNIQUE (code)`; `CHECK (code = upper(btrim(code)))` — "stored upper-case" is an invariant, so a fixture typo fails loud instead of minting a fifth code; `CHECK (kind IN ('percent','amount'))`; `CHECK (value > 0)`; `CHECK (kind <> 'percent' OR value <= 100)`; `CHECK ((kind = 'amount') = (currency IS NOT NULL))`; `CHECK (max_uses > 0)`; `CHECK (used_count >= 0 AND used_count <= max_uses)` | The counter is the thing I7 guards. The CHECK is a backstop, not the mechanism — see §4's RED note. |
| `promo_redemptions` | `order_id text PK` → `orders(id)`; `promo_id integer` → `promo_codes(id)`; `list_amount_minor integer`; `discount_minor integer`; `created_at timestamptz DEFAULT now()` | `PRIMARY KEY (order_id)` (= I8, strengthened); `CHECK (0 <= discount_minor AND discount_minor <= list_amount_minor)`; index on `promo_id` | The ledger. `used_count` must always equal `count(*)` grouped by `promo_id` in production; a test may *compare* one against the other and decrement the counter by the ledger rows it deletes; production never touches the counter except through I7. |

The FK from `promo_redemptions.order_id` to `orders` is the `deliveries` argument from architecture §2: only code that has already locked the order can write this row, so a dangling reference is a bug worth refusing.

**Migration.** `packages/db/drizzle/0006_promo_codes.sql`, generated by `drizzle-kit` from `packages/db/src/schema/promo.ts` (a new schema file, exported from the schema barrel) and hand-annotated like `0003` and `0005`. One new file; the migrator's one-transaction-for-all-pending-files behaviour is irrelevant to it.

**Fixture and seed.** `packages/db/src/fixtures/promo-codes.ts` carries the brief's four codes verbatim, with the same "a fixed input, diffable against the brief" header as `catalog.ts`:

| Code | Kind | Value (as stored) | Max uses |
| --- | --- | --- | --- |
| `WELCOME10` | percent | 10 | 100 |
| `GG500` | amount | 50 000 minor (500 ₽), `RUB` | 20 |
| `LIMIT3` | percent | 25 | 3 |
| `ONCEONLY` | percent | 50 | 1 |

The seed inserts with `ON CONFLICT (code) DO UPDATE SET kind, value, currency, max_uses = excluded.…` — the definition is authoritative, as `products` is — **and never touches `used_count`**: a re-seed must not reset a counter, for the same reason it does not reset a supplier knob. `SeedSummary` gains a `promoCodes` line.

### 2.2 The redemption transaction

`PromoRedemptionService.apply(orderId, rawCode)` runs one `database.transaction(async (tx) => …)`. The order of statements is the design; every statement that can refuse runs before either statement that writes.

| # | Statement (emitted SQL, quoted beside the Drizzle call as the house rule requires) | Zero rows / failure → outcome |
| --- | --- | --- |
| 1 | `SELECT … FROM orders WHERE id = $1 FOR UPDATE` — `OrderLockService.lockOrder(tx, orderId)` | `order_not_found` → 404 |
| 2 | (in memory) `status !== 'created'` | `not_awaiting_payment` → 409 |
| 3 | `SELECT p.code FROM promo_redemptions r JOIN promo_codes p ON p.id = r.promo_id WHERE r.order_id = $1` — under the order lock, so every writer of this order's redemption is serialised (the I4 pattern: lock, then act). Read **before** the promo lookup so a retry or a double-click never touches the hot `promo_codes` row at all | row whose `code` equals the normalised input → `already_applied` → 200, nothing written; a different code → `another_code_applied` → 409 |
| 4 | `SELECT id, code, kind, value, currency, max_uses FROM promo_codes WHERE code = $2` — no `FOR UPDATE`; the definition read must not serialise twenty shoppers behind one row; for an `amount` code, `currency` must equal the order's | `unknown_code` → 422 (a currency mismatch is refused the same way — all orders are `RUB`; the check is there so the arithmetic can never subtract dollars from roubles) |
| — | (in memory) `computeDiscount(order.amount_minor, promo)` → `{ discountMinor, amountToPayMinor }` from stored data only; the request body's `code` never touches a number; `discount_minor` stored is the *applied* (clamped) discount so `list = amount + discount` holds even at 0 ₽ | — |
| 5 | **I7.** `UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $3 AND used_count < max_uses RETURNING used_count` | 0 rows → `exhausted` → 409. Nothing has been written; the transaction commits empty. |
| 6 | **I8.** `INSERT INTO promo_redemptions (order_id, promo_id, list_amount_minor, discount_minor) VALUES ($1, $3, $4, $5) ON CONFLICT (order_id) DO NOTHING RETURNING order_id` | 0 rows is impossible under the lock → `throw` → ROLLBACK undoes step 5 → 500. The one rollback path, and it means the lock discipline was broken. |
| 7 | `OrderRepricingService.applyDiscount(tx, orderId, amountToPayMinor)` — `UPDATE orders SET amount_minor = $6, updated_at = now() WHERE id = $1 AND status = 'created' RETURNING id` | 0 rows impossible under the lock → `throw` → 500. The status guard is the second stop that remains if a future caller forgets the lock. |
| 8 | return `{ outcome: "applied" }` — **no re-read inside the transaction** | — |

The controller reads the view **after COMMIT** through an exported reader. Reading inside the transaction through `OrdersService.findOrder` — which runs on the pooled handle — would wait for the one connection the transaction holds: the `max: 1` self-deadlock `client.ts` and `order-lock.service.ts` both warn about.

**Why step 5 admits exactly `max_uses` transactions when twenty run at once in four processes, under `READ COMMITTED`.** Every `UPDATE` of the same `promo_codes` row queues on that row's lock; when each in turn obtains it, Postgres re-evaluates the `WHERE used_count < max_uses` against the row *as the previous transaction committed it*, not as it was first read. The fourth transaction in the queue therefore sees `used_count = 3`, matches zero rows, and returns nothing — there is no window between reading the count and writing it, because reading and writing are one statement. That sentence is the walkthrough's keystone (functional spec §2.6): a read-then-increment has the window; a conditional update does not.

**Lock order** is `orders` row → `promo_codes` row in every transaction that takes both; `promo_codes` is a leaf in the lock graph — nothing locks anything after it — and the payment, issuance and recovery paths never touch it, so there is no cycle. Never `SKIP LOCKED` here: the queue *is* the mechanism. The two specialists disagreed on whether the increment (step 5) should come before the two writes or last before COMMIT; both are correct, and increment-first is kept because it matches the codebase's no-sentinel-throw idiom (an expected refusal commits empty) at the cost of holding the hot row for two more small statements.

**Discount arithmetic** — `promo-discount.ts`, pure and unit-tested: `percent` → `discount = Math.round(amount * value / 100)` (nearest kopeck, half up — the four seeded examples on 1 290 ₽ are exact; the unit test pins a non-exact case, 25 % of 9 999 kopecks → 2 500); `amount` → `discount = min(value, amount)`; `amountToPay = amount − discount ≥ 0`. `promo-code.ts`: `normalisePromoCode = trim + toUpperCase`; empty after trim is a `400`, not a lookup.

### 2.3 API

**Module** `apps/api/src/promo/` — `promo.module.ts` (imports `DatabaseModule`, `OrdersModule`; registered in `AppModule` with the module-distance note every module header carries), `promo.controller.ts`, `promo-redemption.service.ts`, `promo-discount.ts`, `promo-code.ts`, `promo.types.ts`. `OrdersModule` gains and exports `OrderRepricingService` (the one status-guarded write to `orders` from outside the module — the module header's "nothing that would let a status be written without a source-state guard" extends to the amount) and exports an order-view reader (`OrdersService.findOrder` is not exported today; export a narrow `OrderViewService` or `OrdersService` itself — the implementer picks and says why).

**Endpoint.** `POST /api/orders/:orderId/promo`, body `{ "code": string }`, `@HttpCode(200)`. Success body: the **bare `OrderView`** — `GET /api/orders/:id` and `POST /api/orders` both return the bare order and the web's parser already exists.

| Case | Status | Body | Written |
| --- | --- | --- | --- |
| Applied | 200 | `OrderView` with `promo` set, `amount_minor` = to pay | counter +1, one redemption row, `orders.amount_minor` |
| Same code on the same order again | 200 | the identical view | nothing |
| Body not `{ code: string }`, or empty after trim | 400 | Nest default | nothing |
| No such order | 404 | Nest default | nothing |
| Not one of the four codes | 422 | `{ "reason": "unknown_code" }` | nothing |
| Counter at `max_uses` | 409 | `{ "reason": "exhausted" }` | nothing |
| Order not `created` | 409 | `{ "reason": "not_awaiting_payment" }` | nothing |
| A different code already on the order | 409 | `{ "reason": "another_code_applied" }` | nothing |
| Invariant violated under the lock | 500 | Nest default | rolled back |

`reason`, not `error`: Nest's default error body already uses `error` for the reason *phrase* (`"Conflict"`), and a field that sometimes holds a phrase and sometimes a code will be parsed wrong. The precedent is `supplierRefusal` in `supplier-issue-refusal.ts` — a `{ status, reason }` built once from the reason so body and status cannot disagree. 409 for exhausted follows `out_of_stock → 409` (the state is the counter; the conflict is that it is full); 422 for unknown follows `ProductNotPurchasable → 422`. `410 Gone` was rejected: it describes the request's target resource as gone, which is false — the order exists and another code is still applicable.

**The order view.** `OrderViewCore` gains `promo: { code: string; discount_minor: MinorUnits; list_amount_minor: MinorUnits } | null` — always present, `null` until applied, the same stable-field rule as `code`. `findOrder` gains `LEFT JOIN promo_redemptions ON order_id = orders.id LEFT JOIN promo_codes ON id = promo_id` — 1:0..1 because `order_id` is the primary key, so no row multiplication. The `amount_minor` comment in `orders.types.ts` ("never recomputed") is amended: it is the amount to pay, which a promo changes once, under the order lock, before payment. The admin undelivered list reads `amount_minor` unchanged — it is what was paid.

**The reviewer's reset affordance.** `POST /api/admin/promo-codes/reset` behind `AdminTokenGuard`, in `admin/`: `UPDATE promo_codes SET used_count = 0`. It exists for one reason — `pnpm race promo` must be runnable twice against a shop whose database the check cannot reach (the deployed one, Phase 6), and race scripts take only a base URL. Locally the check cleans up through the database instead (§2.5), which decrements each counter by exactly the redemptions it deletes; the endpoint zeroes the counter and leaves the ledger, so after it the two disagree by design. It is a demo affordance in the `supplier_behaviour` family, documented as such, never called by the shop itself. **Assumption:** this is acceptable for a test assignment; the alternative — a check that never leaves a trace on a deployed shop — does not exist for any of the eight existing checks either.

**Logging.** Every line: `order_id`, `promo_code` (normalised), `promo_id`, `outcome`, `status_code`, `duration_ms`.

### 2.4 Web

**Wire and `HttpError`.** `shared/api/http.ts`'s `HttpError` gains `readonly body: unknown` — the failed response's JSON body when it parses, `null` otherwise — read once by `getJson`/`postJson` through a `readBody` that **never throws** (a Nest `{ statusCode, message, error }`, an HTML body, an aborted read all become `null` and the error still surfaces as `HttpError(status)`; if this leaked any other exception, `fetchOrder`'s 404 mapping would be skipped and «Заказ не найден» would become «Не удалось загрузить заказ» — the existing 404 acceptance test is the guard). `http.ts` keeps returning `unknown`; narrowing the `reason` stays in the slice that knows the endpoint. No existing caller breaks: `new HttpError` occurs twice, both in `http.ts`; the four consumers use `instanceof` and `.status` only.

**Entity.** `Order` (both union branches) gains `promo: AppliedPromo | null` with `AppliedPromo { code; discountMinor; listAmountMinor }`; `toOrder` gains `readPromo` — absent/`null` → `null`, otherwise an object with a non-empty string `code` and two finite non-negative minor amounts, else `OrderResponseError("order.promo.…")`. `applyPromo(orderId, code): Promise<Order>` lives in **`entities/order/api/order-api.ts`**, not in the feature: the entity's own header says its `api` segment holds the requests that read and write the order, and parsing the response needs the private `toOrder`. Typed errors beside `OrderNotFoundError`: `PromoCodeUnknownError` (422), `PromoCodeExhaustedError` (409 + `exhausted`), `PromoNotApplicableError(reason)` (409 + the other two).

`renderOrderDetails`: rows Товар · Сумма · **Промокод** · Статус · Ключ · Номер заказа. The promo row is gated on `order.promo !== null`, **not on status**, so it survives `paid → delivered` (§2.3 crit 4).

| Row | `dt` | `dd` text | Hooks |
| --- | --- | --- | --- |
| amount, no promo | Сумма | `1290 ₽` | `data-amount-minor="129000"` |
| amount, promo | Сумма | `967,50 ₽ ` + `<span class="order-details__list-amount">(было 1290 ₽)</span>` | `data-amount-minor="96750"`; span `data-list-amount-minor="129000"` |
| promo | Промокод | `LIMIT3 — скидка 322,50 ₽` | `data-promo-code="LIMIT3"`, `data-discount-minor="32250"` |

(`formatPrice(32250)` already yields `322,50 ₽`; the functional spec's «1 290 ₽» is the brief's typography — the shop prints `1290 ₽`, as it always has.)

**Feature `features/apply-promo/`** — `ui/promo-form.ts` + `index.ts` + `CLAUDE.md`, `buy-product`'s shape: `createPromoForm({ orderId, onOrderMayHaveChanged }) → { render(order): HTMLElement | null }`; `render` returns the form only for `status === "created" && order.promo === null`, `null` otherwise — once applied, the entity's «Промокод» row *is* "shown in its place". A real `<form data-promo-form>` with a `submit` handler that calls `preventDefault()` and does the work — not Slice 1's hazard (a decorative control whose only listener cancels); `layout.spec.ts`'s zero-`<form>` assertion runs on `/` only. `<input type="text" name="code" aria-label="Промокод" placeholder="Промокод" autocomplete="off" autocapitalize="characters" spellcheck="false">` — **no `required`** (the browser's native bubble is English); empty after trim → nothing sent. During the request: `button.disabled = true`, `input.readOnly = true` (not `disabled` — disabling a focused element drops focus to `body`). `text`: «Такого промокода нет» / «Промокод больше не действует» / «Не удалось применить промокод. Проверьте соединение и попробуйте ещё раз.» / the existing «Заказ не найден…»; **no message** for `PromoNotApplicableError` — both reasons mean the order moved under this tab, and the truthful response is `onOrderMayHaveChanged()`.

**After success the form calls `onOrderMayHaveChanged()` and does not paint from the returned order** — one writer of the content region; `poll.refreshNow()` queues behind an in-flight read so a stale `promo: null` read lands first, is suppressed by the memo, and the refresh paints the row with no flicker. `applyPromo` still returns `Order` because the parse is the success check.

**The repaint rule** — `order-page.ts`'s `RenderedOrder { status, code }` gains `promoCode: string | null`. Forgotten, the failure is silent: the POST succeeds, the refresh returns the promo, the memo sees `created === created`, `null === null`, returns early; the form stays disabled, the amount stays, no row — until a reload, at which point everything is right, so a manual check that reloads "proves" it works. The e2e's first test is the guard and its RED. `content.replaceChildren` order: details, recovery notice, **promo form, then payment controls**.

**CSS** in `app/styles.css` (the order page's sheet — the storefront's is untouched): `.promo-form`, `__input`, `__button` (+`:disabled`), `__error` (a selector list with `.payment-controls__error`), `.order-details__list-amount`.

### 2.5 The reviewer's check and the harnesses

`scripts/race/promo.ts` (`pnpm race promo`; alias `race:promo`, already named in architecture §7): twenty orders created round-robin across the four instances, twenty simultaneous `POST …/promo { code: "LIMIT3" }`, then ten orders and ten of `ONCEONLY`; prints applied/refused counts; exits non-zero unless exactly 3 and 1; database half via `openRaceDatabase` with the SKIP convention when unreachable (redemption rows = 3 and 1; `used_count` = 3 and 1); cleanup through `cleanupTestOrders` in `finally`.

Both harnesses (`apps/api/test/concurrency/support/db.ts` and its duplicate `apps/web/e2e/support/db.ts`) change together: `readBaselineCounts`/`assertBaseline` gain `promo_codes = 4`, `sum(used_count) = 0`, `promo_redemptions = 0`; `cleanupTestOrders` gains, *before* the `orders` delete (FK), one atomic statement that deletes this test's redemptions and **decrements each code by exactly what it removed**: `WITH gone AS (DELETE FROM promo_redemptions WHERE order_id = ANY($1::text[]) RETURNING promo_id), per_promo AS (SELECT promo_id, count(*)::int AS n FROM gone GROUP BY promo_id) UPDATE promo_codes p SET used_count = p.used_count - per_promo.n FROM per_promo WHERE p.id = per_promo.promo_id`. A global recompute (`used_count = count(*) FROM promo_redemptions …`) was rejected: it would silently *repair* any drift between counter and ledger, which is exactly what `assertBaseline("after")` exists to catch — the same discipline as the `supplier_keys` un-claim, which addresses only what the test derived. The baseline sums with `coalesce(sum(used_count), 0)` (a NULL from an empty table would pass `=== 0` by accident). Safe because no two suites run at once (`fileParallelism: false`, `workers: 1`, one runner at a time — R13's discipline). Without it, run two of any suite finds `ONCEONLY` spent by run one.

---

## 3. Impact and Risk Analysis

**System dependencies.** Depends on `OrderLockService` (exported), the order view reader (to be exported), the payment simulator reading `orders.amount_minor` (unchanged), and both test harnesses' baseline (extended). Affects nothing in the issuance path, the recovery screen, or the storefront.

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | **A read-then-increment passes every single-process test** — the `max: 1` pool serialises transactions inside one instance, so the race is invisible without four processes (architecture §7's 20-vs-9 measurement) | The race test and `pnpm race promo` run across four instances; RED weakens the guard and must show more than three successes |
| R2 | **The `CHECK (used_count <= max_uses)` masks a weakened guard**: with read-then-increment, the fourth increment *throws* (500) rather than producing `used_count = 4`, so a RED that only asserts the counter stays green | Assert on the responses (`exactly 3 × 200 and 17 × 409 exhausted, and no other status`) and on redemption rows; the counter is asserted *in addition*. Phase 2's lesson in a CHECK's clothing |
| R3 | **Self-deadlock on the `max: 1` pool** if the view is re-read inside the transaction through the pooled handle | Read after COMMIT; `lockOrder` takes `tx` by signature; the module header names the trap |
| R4 | **A refusal that has already written something** (e.g. the increment before the already-applied check) would need a rollback the codebase's idiom does not use | Statement order §2.2: every refusal before either write; the only throw is an invariant violation |
| R5 | **The seed resets the counter** on re-run, or the check leaves the counter spent | Seed never writes `used_count`; cleanup decrements by exactly what the test spent (never a global recompute, which would hide drift); the admin reset exists for the deployed shop |
| R6 | **Apply-vs-pay window.** The simulator reads `orders.amount_minor` without a lock, then delivers the webhook; a code applied to a `created` order in the milliseconds between the read and `markPaid` is applied at a list-price payment, and the processor never compares amounts (a Phase 1 decision: "settlement belongs to processing") | The status guard closes every ordering except that one; the window is one simulated-provider round trip. **Documented, not closed**: the honest fix — compare `payment_events.amount_minor` to `orders.amount_minor` under the lock in the processor and route a mismatch to `payment_failed` — changes the payment path and the fifty-webhook race's staged amounts, and is out of this phase's scope by the functional spec's own §3. Recorded as a known trade-off in architecture §9 by Slice 3, beside the admin reset. |
| R7 | **A different code on the same order via two tabs** | The order lock serialises; the second sees the redemption row and gets `another_code_applied`; the page refreshes rather than explains |
| R8 | **Percent rounding unspecified** | `Math.round` to the nearest kopeck; a non-exact case in the unit test; the four seeded amounts on 1 290 ₽ are exact |
| R9 | **`{ error }` collides with Nest's default body field** | `{ reason }` |
| R10 | **A forgotten `preventDefault()` on the promo form looks like success** — the POST lands, the browser then GETs the form and reloads `/order/ord_x?code=…`, which shows the applied code | The e2e sets a `window` marker before submitting and asserts it survives; the URL's trailing `?` alone is too easy to normalise away |
| R11 | **`readBody` throwing on a non-JSON error body** would change the class of every existing 404/401/503 and break four consumers' mappings at once | `try/catch` total; the existing 404 acceptance test guards it |
| R12 | **The repaint memo without `promoCode`** — the silent failure of §2.4 | e2e T1 asserts the row appears with the URL and a `window` marker unchanged |
| R13 | **Two harness files must move together** (`apps/api/test/…/db.ts` and `apps/web/e2e/support/db.ts`) or the e2e leaves `ONCEONLY` spent and the API suites' new baseline fails | Both edited in one task; `pnpm test` after `pnpm test:e2e` is the proof, as in Phase 4 |
| R14 | **Ports** | Race test 5201–5204, acceptance 5301, listed in `scripts/race/README.md`'s row |
| R15 | **The admin reset desynchronises counter and ledger** on a deployed shop | Stated in the endpoint's comment and the README; local checks decrement through the harness and never call it |

---

## 4. Testing Strategy

| Layer | File | Asserts | RED |
| --- | --- | --- | --- |
| API unit | `apps/api/test/unit/promo-discount.test.ts` | 129 000 → 116 100 / 79 000 / 96 750 / 64 500; `amount` larger than the price → 0; 25 % of 9 999 → 2 500; `normalisePromoCode` trims and upper-cases; empty → rejected | `computeDiscount` returning the list amount → the four examples fail |
| API concurrency | `apps/api/test/concurrency/promo-limit-race.test.ts`, four processes on 5201–5204 | `LIMIT3` ×20 simultaneous on twenty orders → exactly 3 × `200` with the code applied, exactly 17 × `409 exhausted`, **zero 5xx**; `used_count = 3`; the ledger holds 3 rows for `LIMIT3` whose `order_id` set equals the three `200`s' orders; those three orders carry `amount_minor = list − discount` and the other seventeen still carry the list amount; the `ConcurrencyWitness` saw more than one backend pid. `ONCEONLY` ×10 → 1. One order, the same code ×4 simultaneously → four `200` with identical bodies, one row, counter +1. | Replace step 5 with a read-then-increment across four processes. Two shapes of the weakening, both predicted: `SET used_count = $computed` → more than three `200`s and more than three ledger rows with the counter still ≤ 3 — the responses and the ledger fail (predicted here as "all twenty write `1`, twenty `200`s"; measured 9 × 200 / 11 × 409 for `LIMIT3` and 4 × 200 for `ONCEONLY`: four `max: 1` pools admit one wave of four transactions per committed value, so the counter moves once per wave and the ledger once per winner — `promo-limit-race.test.ts`'s header); `SET used_count = used_count + 1` unconditionally → the fourth increment trips the CHECK, `23514`, its transaction aborts, the API answers `500` — `used_count = 3`, 3 rows, 3 successes, **and a counter-only test passes**; the "17 × 409, zero 5xx" assertion is what turns it red. For the same-order case: replace `lockOrder` with a plain `SELECT` → two processes pass step 3, the second's INSERT conflicts → 500. |
| API acceptance | `apps/api/test/acceptance/promo-codes.test.ts`, one instance on 5301 | the four amounts on a 1 290 ₽ order; `nope` → 422 `unknown_code`; ` limit3 ` → applied as `LIMIT3`; a paid order → 409 `not_awaiting_payment`; `payment_events.amount_minor` equals the discounted amount after the simulator; the delivered view still carries `promo`; the same code twice → 200 and one row | per criterion, by inversion or by pointing at the state the shop does not satisfy — weaken nothing in `src/` |
| Reviewer's check | `scripts/race/promo.ts` | as the concurrency test, printed; exit non-zero otherwise; run twice back to back | the same weakening, recorded in `scripts/race/README.md`'s RED table |
| Web unit | `apps/web/src/entities/order/api/order-api.test.ts` | `readPromo`: `null`/absent → `null`; valid → three branded fields; `"LIMIT3"` (a string) → throws; missing `discount_minor` → throws naming the field | write-first: before `readPromo` exists, `promo` is `undefined` and the null cases fail |
| e2e | `apps/web/e2e/promo.spec.ts` (`@regression`, real clock) | T1 apply `LIMIT3` by Enter: the form precedes the payment controls; row `LIMIT3 — скидка 322,50 ₽`; «Сумма» `967,50 ₽ (было 1290 ₽)`; form gone; URL unchanged **and** a `window` marker set before submit still present. T2 `nope` → «Такого промокода нет», amount unchanged, value kept, input editable. T3 empty submit → zero `POST …/promo`. T4 reload → same row and amounts. T5 pay → «Ключ выдан» with the row still present. T6 `ONCEONLY` on two orders → the second reads «Промокод больше не действует» | T1: drop `promoCode` from the memo (the silent failure); T2/T6: map the reason to the generic sentence; T3: remove the trim guard; T4: suppress the row on the *first* paint only (a status gate passes T4 — a reloaded order is still `created`); T5: gate the row on `status === "created"` |
| Russian | `apps/api/test/unit/order-status-russian-labels.test.ts` extended to the feature's `text` table | every sentence Cyrillic | — |

Order of runs stays R13's: `pnpm test:e2e`, then `pnpm test`; the new baseline rows make a leaked redemption or counter fail the API suites' precondition rather than pass silently.

---

## 5. Assumptions

1. `orders.amount_minor` is the amount to pay; list price and discount live on the redemption row.
2. `PRIMARY KEY (order_id)` on `promo_redemptions` — one code per order — supersedes architecture's `UNIQUE (promo_id, order_id)`; architecture.md is amended.
3. Percent discounts round to the nearest kopeck (`Math.round`).
4. A use is spent at apply time and never returned (functional spec §2.4); the seed never resets counters; test cleanup decrements by exactly the redemptions it deleted, never recomputes globally.
5. The admin reset endpoint (`used_count = 0`, ledger untouched) is an acceptable demo affordance for a deployed shop.
6. The apply-vs-pay window (R6) is documented, not closed, this phase.
7. Refusals return `{ reason }` with 422/409, not `410`; `HttpError` carries the body as `unknown`.
8. `applyPromo` lives in the order entity's `api`; the feature is UI only.
9. Ports 5201–5204 and 5301.
10. `OrdersModule` exports a repricing service and a view reader; `PromoModule` writes `orders` only through the former.
