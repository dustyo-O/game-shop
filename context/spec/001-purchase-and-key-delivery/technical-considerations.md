# Technical Specification: Purchase and Key Delivery

- **Functional Specification:** `context/spec/001-purchase-and-key-delivery/functional-spec.md`
- **Status:** Completed
- **Author(s):** Alexander Shleyko

---

## 1. High-Level Technical Approach

Stand up the pnpm monorepo, the Postgres schema, and the shortest honest path from a product listing to a delivered key: `POST /orders` → simulated payment → payment webhook → issuance through a supplier stub → key bound to the order → status page shows it.

Three choices shape everything below, and each one exists to avoid rework in Phases 2 and 3 rather than to add cleverness now:

1. **The full set of constraints ships in the first migration.** Unique indexes cost nothing to add now and are the entire correctness story later. Phase 2 adds the *behaviour* that exploits them (locking, idempotency keys, async draining); it should not have to add the constraints themselves.
2. **Issuance goes through a supplier stub over real HTTP, from day one.** The key pool is supplier-side inventory, not shop inventory. Phase 1 builds only supplier A, always succeeding — but the network boundary and the supplier's own `request_id → code` ledger exist immediately, so Phase 3 adds supplier B, failure injection and the retry policy without restructuring anything.
3. **The webhook persists the event before acting on it, and only then processes it — inline, in the same request.** The persist-first shape is what Phase 2 keeps; all Phase 2 changes is *when* processing happens (moving it out of the acknowledgement path). Processing inline now keeps Phase 1 debuggable and its tests synchronous.

What Phase 1 deliberately does **not** do: order-row locking, idempotency keys on order creation, out-of-order event handling, the async drain, and the full race suite. Those are Phase 2 and are called out in §3 so the boundary is explicit.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1 Repository layout

| Path | Responsibility |
| --- | --- |
| `apps/api` | NestJS application — catalog, orders, payments, webhook, issuance, supplier stub |
| `apps/web` | Vite + vanilla TypeScript — product list page, order status page |
| `packages/contracts` | Shared wire types: order status enum, webhook payload, supplier `/issue` request and response |
| `packages/db` | Drizzle schema, migrations, seed scripts |
| `docs/walkthrough/phase-1.md` | The §2.7 deliverable — keystone decisions in plain language |
| `docker-compose.yml` | Postgres 16 for local development |

### 2.2 Data model

Created in the first migration. Tables marked *(later phase)* are deferred — promo tables arrive in Phase 5.

**Shop tables**

| Table | Key columns | Constraints and indexes |
| --- | --- | --- |
| `products` | `sku`, `name`, `type`, `price_minor`, `currency`, `image`, `purchasable` | `sku` UNIQUE |
| `orders` | `id`, `client_request_id`, `sku`, `amount_minor`, `currency`, `status`, `created_at`, `updated_at` | `client_request_id` UNIQUE (nullable in Phase 1, populated in Phase 2); index on `status` |
| `payment_events` | `event_id`, `order_id`, `status`, `amount_minor`, `currency`, `payload`, `received_at`, `processed_at` | `event_id` PRIMARY KEY; **no foreign key on `order_id`**; partial index on `order_id WHERE processed_at IS NULL` |
| `issuance_attempts` | `request_id`, `order_id`, `provider`, `status`, `code`, `last_error`, `created_at` | `request_id` UNIQUE; index on `order_id` |
| `deliveries` | `id`, `order_id`, `code`, `provider`, `request_id`, `created_at` | `order_id` UNIQUE, `request_id` UNIQUE |

**Supplier-side tables** — the simulated supplier's own storage. Kept separate on purpose: the shop must earn its guarantees across a boundary it distrusts.

| Table | Key columns | Constraints and indexes |
| --- | --- | --- |
| `supplier_keys` | `id`, `code`, `claimed_by_request_id`, `claimed_at` | `code` UNIQUE; `claimed_by_request_id` UNIQUE; partial index on `id WHERE claimed_by_request_id IS NULL` (the claim query's hot path) |
| `supplier_requests` | `request_id`, `code`, `created_at` | `request_id` PRIMARY KEY |

**Order status values (Phase 1):** `created`, `paid`, `delivering`, `delivered`, `payment_failed`, `out_of_stock`. `delivery_failed` is added in Phase 3.

**Identifiers:** `orders.id` is a prefixed sortable string (`ord_` + ULID) so it reads like the assignment's `ord_00123` and sorts by creation time. `issuance_attempts.request_id` is derived deterministically as `req_{order_id}_{provider}_{attempt}` — this is what makes a Phase 3 retry naturally reuse the same identifier instead of depending on a caller to remember it.

**Money:** stored as integer minor units (`price_minor`), never floating point.

**Seeds:** the twelve supplied products and the fifty supplied keys. `purchasable` is true for products of type `key`.

### 2.3 API contracts

All under `/api`. Shapes are described, not implemented.

| Endpoint | Purpose | Notes |
| --- | --- | --- |
| `GET /api/products` | Catalog for the shop page | Returns all twelve with `sku`, `name`, `price_minor`, `currency`, `image`, `purchasable` |
| `POST /api/orders` | Create an order | Body `{ sku }`; responds `201` with the order. Phase 2 adds the `Idempotency-Key` header and its handling |
| `GET /api/orders/:id` | Order state for the status page | Returns status, product name, amount; includes `code` only once `delivered`; `404` with a not-found body for an unknown id |
| `POST /api/payments/:orderId/simulate` | Stand in for the payment provider | Body `{ outcome: "success" \| "failure" }`; constructs a contract-shaped event and delivers it to the webhook endpoint. This is the same mechanism the Phase 2 race scripts drive |
| `POST /api/webhooks/payment` | Receive a payment event | Body per the supplied contract (`event_id`, `order_id`, `status`, `amount`, `currency`, `created_at`); responds `200` |
| `POST /internal/suppliers/a/issue` | Supplier A stub | Body `{ request_id, sku, order_id }`; responds `{ status: "ok", request_id, code }` or an error body `{ status: "error", reason: "out_of_stock" }` |

### 2.4 Backend components

| Module | Responsibility |
| --- | --- |
| `catalog` | Read the product list |
| `orders` | Create orders; read order state; own the status transition helper that every other module calls |
| `payments` | The simulator endpoint, and the webhook receiver that writes to `payment_events` |
| `issuance` | Drive a paid order to `delivered`: call the supplier, record the attempt, bind the delivery |
| `suppliers/a` | The supplier A stub, with its own tables and its own idempotency ledger |

**The status transition helper** is the single place any status changes, and every transition names the states it is allowed to leave from. That is what makes I9 (final states are terminal) enforceable rather than a convention.

### 2.5 Logic: the delivery path

Written as the ordered decisions, with the guarantee each step rests on. The SQL that enforces each is specified in `context/product/architecture.md` §3.1 and is annotated at the call site per the project's raw-SQL rule.

1. **Webhook arrives.** Insert into `payment_events` with `ON CONFLICT (event_id) DO NOTHING RETURNING *`. Zero rows returned means this event has been seen before — acknowledge `200` and stop. *(Invariant I2.)*
2. **Apply the event to the order.** `status: "failed"` moves `created → payment_failed`. `status: "paid"` moves `created → paid`. Both are status-guarded updates: zero rows means the order was not in the expected state, and the event is a no-op. *(Invariant I9.)*
3. **Begin issuance.** Move `paid → delivering` with the same guarded update. Zero rows means someone else already started; stop. *(In Phase 1 this is the only concurrency defence on the order; Phase 2 adds the row lock for I4.)*
4. **Claim a key from the supplier.** The supplier stub first checks `supplier_requests` for this `request_id` and returns the stored code if present *(I5)*. Otherwise it claims an unclaimed key with a single conditional `UPDATE … WHERE code = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING code` and records the request. Zero rows means the pool is exhausted → `out_of_stock`. *(I6.)*
5. **Bind the delivery.** Insert into `deliveries` with `ON CONFLICT (order_id) DO NOTHING`. The unique index on `order_id` — not an application-level check — is what makes a second delivery impossible. *(I3.)*
6. **Finish.** Move `delivering → delivered`, or `delivering → out_of_stock` when step 4 found nothing. `out_of_stock` is terminal *for Phase 1*; Phase 3 makes it recoverable.
7. **Mark the event processed.** Set `processed_at` on the `payment_events` row.

### 2.6 Frontend

Two plain pages in `apps/web`, laid out in the project's layer structure but with minimal ceremony. All text in Russian per functional spec §2.8.

| Page | Contents |
| --- | --- |
| `/` | Twelve products with name and price; a «Купить» control on purchasable ones |
| `/order/:id` | Product name, amount, current state; «Оплатить успешно» and «Оплата не прошла» controls while awaiting payment; the key once delivered; a not-found message for an unknown order |

**Live updates:** the order page polls `GET /api/orders/:id` every second while the order is in a non-terminal state, and stops polling on `delivered`, `payment_failed` or `out_of_stock`. This satisfies "the page shows each change without the shopper reloading it" without introducing a socket, which the architecture calls decoration at this scale.

### 2.7 Configuration

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `API_PORT` | API listen port |
| `WEB_API_BASE_URL` | API base the frontend calls |
| `SUPPLIER_A_URL` | Base URL of the supplier A stub — a real URL even locally, to keep the boundary honest |
| `SUPPLIER_TIMEOUT_MS` | Client-side timeout on supplier calls. Present from Phase 1 so Phase 3 only changes its value |

### 2.8 The walkthrough deliverable

`docs/walkthrough/phase-1.md` satisfies functional spec §2.7 and covers the three required keystones:

1. **Why an order moves through named states.** The alternative — a `paid` boolean — cannot express "money taken, key not yet handed over", which is precisely the state every later failure lands in.
2. **Why the shop, not the page, decides a key was given out.** The pay button reports an outcome; it does not grant anything. Delivery follows from a recorded event, so a closed tab, a refresh, or a reissued report all converge on the same result.
3. **How the same key cannot reach two orders.** Two independent guards: the supplier's conditional claim on `supplier_keys`, and the shop's `deliveries.order_id` unique index. Each is shown with its SQL and what zero returned rows means.

Each entry states the decision, the more obvious alternative, what breaks without it, and the exact statement where a guarantee is enforced.

---

## 3. Impact and Risk Analysis

### System Dependencies

- No existing code — this specification creates the repository's first source.
- Postgres 16 via Docker Compose locally. Neon and Vercel are Phase 6; nothing here may assume a long-lived process.
- The supplied catalog, key pool and webhook contract are fixed inputs and must be used verbatim.

### Potential Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| **Phase 1 shortcuts become Phase 2 rewrites.** | The three shaping decisions in §1 exist for exactly this. Constraints, the supplier boundary and persist-before-process all ship now; Phase 2 adds behaviour on top rather than restructuring. |
| **Inline webhook processing is slow and blocks acknowledgement.** | Accepted and explicit for Phase 1. The contract's fast-`200` requirement is a Phase 2 acceptance criterion, not a Phase 1 one. Recorded here so it is a known deferral, not an oversight. |
| **The key claim is the one place Phase 1 genuinely races** — functional spec §2.5 demands it hold now. | The conditional `UPDATE … FOR UPDATE SKIP LOCKED` plus the unique index on `claimed_by_request_id` handle it, and §4 includes a concurrent test rather than deferring all concurrency proof to Phase 2. |
| **Statuses drift as phases add branches.** | One transition helper, one enum in `packages/contracts`, every transition naming its permitted source states. |
| **Money handled as floats.** | Integer minor units throughout; no floating point in prices or amounts. |
| **An empty pool crashes the order page.** | Step 6 routes to `out_of_stock`, which the status page renders as a normal state. Covered by a §4 test. |

---

## 4. Testing Strategy

**Integration tests (Vitest, against a real Postgres — never a mock):**

- Order creation returns an order awaiting payment for a purchasable product.
- A successful payment event drives the order to `delivered` with a code present.
- A failed payment event drives the order to `payment_failed` with no code.
- A replayed event with the same `event_id` changes nothing — the order's state and code are byte-identical afterward.
- Two separate paid orders receive two different keys.
- With the pool emptied, a paid order lands in `out_of_stock`, no code is bound, and no exception escapes.
- An unknown order id returns a not-found response rather than an error.

**Concurrency test (Vitest):** N orders paid in parallel produce N distinct keys, exactly N claimed rows in `supplier_keys`, and exactly N rows in `deliveries`. This is the smallest proof of functional spec §2.5 and is deliberately not deferred to Phase 2 — §2.5 is a Phase 1 requirement. The full adversarial suite (fifty webhooks on one order, out-of-order arrival, duplicate ordering) remains Phase 2.

**Assertions query the database directly**, not only the API response. A response can look correct while the state beneath it is wrong.

**Browser test (Playwright):** open the shop, buy a purchasable product, choose the successful payment control, and see the key appear on the order page without reloading.

**RED validation** applies to every test written here: each must be shown failing before the code that satisfies it exists.

---

## Assumptions

Recorded rather than confirmed — challenge any of these:

- **A1.** Issuance goes through a supplier A stub over HTTP in Phase 1, rather than reading the pool directly. Costs a little now, saves restructuring in Phase 3.
- **A2.** All correctness constraints ship in the first migration, including ones no Phase 1 code exercises yet.
- **A3.** The webhook processes inline after persisting. Async processing and the fast `200` are Phase 2.
- **A4.** Purchasable products are the three of type `key`; the other nine are display-only. The assignment requires only one, so this exceeds it at no cost.
- **A5.** The order page polls once per second and stops on a terminal state.
- **A6.** Order ids are `ord_` + ULID; supplier request ids are `req_{order_id}_{provider}_{attempt}`.
- **A7.** Promo tables are not created in this phase — they arrive with Phase 5.
