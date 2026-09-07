# Technical Specification: Single Issuance Under Races

- **Functional Specification:** `context/spec/002-single-issuance-under-races/functional-spec.md`
- **Status:** Draft
- **Author(s):** Alexander Shleyko

---

## 1. High-Level Technical Approach

Three changes, in this order. Each is small; the second is the one with reach.

1. **Give order creation an identity.** `orders.client_request_id` and its UNIQUE index already exist and were proven at twenty concurrent sessions in Phase 1 with no application code involved. What is missing is a header carrying the shopper's *intent*, an insert that lets the index decide the winner, and a caller that reads the winner back instead of failing. Settles §2.1 and acceptance scenario 1.

2. **Move processing off the acknowledgement path.** The webhook currently persists the event and then processes it inline before answering (`payment-webhook.controller.ts:256`). Phase 2 persists, answers, and processes as separate work claimed from the inbox with `FOR UPDATE SKIP LOCKED`. This one change settles §2.4, completes §2.3 (an event stored before its order is now actually applied by a later drain rather than merely retained), and restores §2.5 — the stages become observable because they stop finishing inside one request.

3. **Add I4's missing half.** The status guard makes a *transition* idempotent; `SELECT … FOR UPDATE` on the order row serialises *workers* across the multi-statement issuance job. Phase 1 had one entry point so there was no second worker. The drain is the second worker, so the lock arrives with it.

Then the deliverable the assignment names: **adversarial scripts a reviewer runs.** Their design is governed by the rule Phase 1 learned and `architecture.md` §7 now records — a pool of `max: 1` serialises transactions, so a script firing fifty requests at *one* local instance measures the connection pool, not the constraint.

**What deliberately does not change:** the schema (every constraint Phase 2 needs already ships), the supplier, the storefront, and the invariant set. Phase 2 is behaviour on top of guarantees that already exist and were already measured.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1 Order creation becomes idempotent (§2.1, scenario 1)

**API.** `POST /api/orders` accepts an `Idempotency-Key` header. The value is the shopper's purchase *intent*, not a hash of the body — two deliberate purchases of the same game must both succeed.

| Case | Response |
| --- | --- |
| Header absent | `201`, order created, `client_request_id` null — the Phase 1 path, kept so existing callers and scripts do not break |
| Header present, first use | `201`, order created, key stored |
| Header present, already used | **`200`** with the original order body — not `201`, because nothing was created |
| Header present, malformed or over-long | `400` |

The status distinction is deliberate and testable: `201` means "this call created it", `200` means "this call found it". A caller that cannot tell them apart cannot detect its own retry.

**Mechanism** — the statement already specified in `architecture.md` §3.1 (I1):

```sql
INSERT INTO orders (id, client_request_id, sku, amount_minor, currency, status)
SELECT $1, $2, sku, price_minor, currency, 'created'
FROM products WHERE sku = $3 AND purchasable = true
ON CONFLICT (client_request_id) DO NOTHING
RETURNING *;
-- 0 rows => either this key already won (read that order back and return 200),
--           or the SKU is not purchasable. These are different outcomes and the
--           caller must distinguish them — see the risk in §3.
```

Phase 1's creation is a single `INSERT … SELECT` so that no price ever passes through TypeScript. That property is preserved; only the conflict clause and the read-back are added.

**Frontend — the decision that makes or breaks this.** If the key is minted *inside the click handler*, a double-click mints two keys, produces two orders, and the entire mechanism accomplishes nothing while appearing to work. The key must be minted per **purchase intent** and survive repeated clicks.

- Minted lazily on first need for a given product, stored under a per-SKU entry in `localStorage`, and cleared once an order for it has been created and the shopper navigated away.
- `localStorage` rather than in-memory or `sessionStorage` because §2.1's third criterion requires two *tabs* to produce one order, and `sessionStorage` is per-tab.
- **Assumption (challenge this):** two tabs buying the same item concurrently is one intent, not two. §2.1 criterion 5 covers the legitimate second purchase — it starts fresh from the shop page after the first completed, by which time the key has rotated.

### 2.2 Processing moves off the acknowledgement path (§2.3, §2.4, §2.5)

**The webhook** persists the event, answers `200`, and schedules processing. It no longer awaits the work.

**Four triggers, layered so no single one is load-bearing** (`architecture.md` §4):

| Trigger | When | Purpose |
| --- | --- | --- |
| Continuation after the response | every webhook | the ordinary path; `waitUntil` from `@vercel/functions` in deployment |
| Drain for one order | on order creation | settles "webhook arrived before its order" — §2.3's first criterion |
| Drain for one order | on the order status poll | the shopper's own page nudges its own order forward |
| Sweep | admin endpoint | the backstop for everything the above missed |

**Local equivalent of `waitUntil`.** Vercel's helper does not exist locally, and a bare floating promise is lost on shutdown. Wrap it: a small scheduler that runs the continuation, tracks in-flight work, and is awaited by Nest's `onModuleDestroy` so a `SIGTERM` does not abandon a half-processed event. One interface, two implementations, chosen by environment.

**The claim** — how a drain takes work without two workers taking the same row:

```sql
SELECT * FROM payment_events
WHERE processed_at IS NULL AND order_id = $1   -- omitted for the sweep
ORDER BY received_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
-- 0 rows => nothing pending, or every pending row is held by another worker.
--           Both mean "not my work"; neither is an error.
```

Served by the partial index `payment_events (order_id) WHERE processed_at IS NULL`, which already exists.

**Ordering is unchanged and remains the safety property:** apply, then settle. A crash between them leaves a pending event a later drain re-applies as a harmless no-op. The reverse is the only order that can lose a payment result.

**The nineteen pending events.** Phase 1 leaves losing events unsettled by design — a caller that lost the claim cannot establish whether anyone else is still working. The drain is what settles them: it re-examines each, finds the order now settled, and marks it processed. Verifying this is part of §2.2.

### 2.3 The order row lock (I4)

`SELECT … FOR UPDATE` on the order at the start of the issuance span, so the claim, the supplier call and the delivery bind are serialised against a second worker.

**The constraint that shapes it:** the pool is `max: 1` per instance, so a transaction held across the supplier HTTP call stalls the whole instance. The lock therefore cannot simply wrap the existing span. Two options, and the plan takes the first:

- **Lock, transition, release; call the supplier; lock again to bind.** The `delivering` claim remains the exclusion for the supplier call, and the lock protects each short transaction around it.
- Lock across the whole span — correct in a long-lived process, unacceptable here.

### 2.4 The adversarial scripts (§2.6)

`scripts/race/`, one file per scenario, driven by an npm script and taking configuration from the environment.

| Script | Scenario | Asserts |
| --- | --- | --- |
| `race:create-order` | many simultaneous Buy attempts, one intent key | exactly one order exists |
| `race:webhooks` | **fifty** simultaneous `paid` reports for one order | one delivery row, one key claimed, order `delivered`, every response `2xx` |
| `race:same-event` | one `event_id` delivered many times concurrently | one stored event, order and delivery unchanged |
| `webhook:before-order` | a report delivered before its order is created | event stored pending, then applied once the order appears; exactly one key |

**Concurrency across processes is the whole point.** A script pointed at one local instance serialises at that instance's single connection and would pass against a broken implementation. So the scripts accept a **list** of base URLs and round-robin across it:

```
RACE_BASE_URLS=http://localhost:3001,http://localhost:3002,http://localhost:3003,http://localhost:3004
```

Against a deployed system a single URL is correct, because the platform supplies the separate instances. The npm script starts the local instances, runs the scenarios, and stops them — the harness in `apps/api/test/concurrency/support/` already does exactly this and should be reused rather than rebuilt.

**Assertions read the database**, not only the responses — `architecture.md` §7, for the reason Phase 1 demonstrated in both directions.

**Each script must be able to fail.** §2.6 makes this an acceptance criterion, so each ships with a recorded RED result naming what was weakened and what the failure said.

### 2.5 Configuration

| Variable | Purpose |
| --- | --- |
| `RACE_BASE_URLS` | Comma-separated instances the scripts round-robin across; a single URL for a deployed target |
| `ADMIN_TOKEN` | Bearer token for the sweep endpoint — the assignment's stated minimum |

---

## 3. Impact and Risk Analysis

### System Dependencies

- The schema needs **no migration**: `client_request_id` UNIQUE and the partial index on unprocessed events both ship in `0000_init.sql`.
- The supplier, the storefront and the catalogue are untouched.
- `apps/api/test/concurrency/support/` is reused by the race scripts.

### Potential Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| **The Phase 1 acceptance suite breaks.** It asserts `delivered` immediately after simulating payment (7 occurrences in `purchase-and-key-delivery.test.ts`); once processing is asynchronous those reads see `paid` or `delivering`. This is a *correct* consequence of the change, not a regression — but it will look like one mid-implementation. | Update those tests to poll for a settled state with a bounded timeout, in the same task that makes processing async. Do not weaken an assertion to make it pass; a test that stops checking delivery is worse than a failing one. |
| **The idempotency key minted per click instead of per intent.** The mechanism then does nothing while every test that sends the key explicitly still passes. | The frontend key lives in `localStorage` per SKU, not in the click handler. §2.1's first criterion must be verified by *actually double-clicking in a browser*, not by sending one key twice with `curl` — the latter passes either way. |
| **Zero rows from the insert has two causes** — key already used, or SKU not purchasable — and conflating them returns `200` with someone else's order or `422` for a legitimate retry. | Distinguish before responding: a follow-up read by `client_request_id` finding an order means retry (`200`); finding none means the SKU was rejected (`422`). |
| **A race script that silently serialises.** Pointed at one instance it passes against a broken claim — Phase 1 measured 20 distinct keys in one process versus 9 across four, zero errors in both. | `RACE_BASE_URLS` takes a list; the npm script starts several instances. Each script's RED result is recorded, which is the only real proof the harness works. |
| **A floating continuation lost on shutdown**, leaving events pending with no drain running. | The scheduler tracks in-flight work and is awaited in `onModuleDestroy`. The sweep endpoint is the backstop, and pending events are recoverable by construction — that is what the inbox is for. |
| **Double processing** — the continuation and a drain both picking up the same event. | `FOR UPDATE SKIP LOCKED` on the claim, and the settle guarded by `AND processed_at IS NULL`. Both already exist; the drain must use them rather than reading the event by id. |
| **Vercel `waitUntil` untested locally.** The deployed path differs from the one exercised in development. | One interface, two implementations, and the local one is the strict version (tracked and awaited). Phase 6 exercises the deployed path; the drains make the continuation an optimisation rather than a dependency. |

---

## 4. Testing Strategy

**Extend the existing suites rather than starting new ones.** `apps/api/test/concurrency/` already spawns real API processes and asserts against the database; that harness is the right shape for everything below.

- **Idempotency (§2.1):** concurrent creates sharing one key across several processes → exactly one order; a repeat after completion → `200` with the same order; distinct keys → distinct orders. Plus a browser check that a genuine double-click produces one order, since that is the only form that catches a key minted in the wrong place.
- **Replay and concurrency (§2.2):** fifty concurrent reports for one order across processes → one delivery, one key, `delivered`, no `5xx`. The same `event_id` many times → one stored event, nothing changed.
- **Out-of-order (§2.3):** an event stored before its order exists is applied when the order appears, and the shopper's key arrives with no further action.
- **Acknowledgement (§2.4):** the webhook answers before the work completes — asserted by timing the response against the order's settle time, not by inspecting internals. A failure while completing an accepted event still answers `2xx`.
- **Observable stages (§2.5):** in a browser, the order page shows an intermediate state between paying and delivered without a reload — the criterion 001 had to walk back.
- **RED validation is mandatory for every test and every script**, per §2.6. Record what was weakened and what the failure said.
- **Regression:** the Phase 1 suites must still pass, with the polling adjustment noted in §3 — `pnpm test` stays the single reviewer command.

---

## Assumptions

Recorded rather than confirmed — challenge any of these:

- **A1.** Two tabs buying the same item concurrently are one purchase intent, so the idempotency key lives in `localStorage` keyed by SKU rather than per tab or per click.
- **A2.** A repeat with a known key returns `200` (not `201`), so a caller can tell "created" from "found".
- **A3.** A request with no `Idempotency-Key` still succeeds and creates an order, keeping Phase 1's callers and scripts working.
- **A4.** The key is cleared after a successful creation, so a deliberate second purchase of the same item gets a fresh key.
- **A5.** The local continuation is tracked and awaited on shutdown rather than fire-and-forget, even though Vercel's `waitUntil` gives no such guarantee.
- **A6.** The race scripts reuse the concurrency harness rather than introducing a second way to start API processes.
