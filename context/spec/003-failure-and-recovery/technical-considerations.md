# Technical Considerations: Failure and Recovery

- **Spec:** `003-failure-and-recovery`
- **Status:** Draft
- **Architecture:** `context/product/architecture.md` §3 (invariants I1–I9), §3.1 (their SQL), §4 (retry policy), §5 (runtime), §8 (errors), §9 (trade-offs)

> **On the SQL in this document.** `architecture.md` §3.1 now requires its blocks to be copied from the code's `.toSQL()` output rather than written by hand, because I1 and I2 drifted that way once. The same rule applies here: every block below is either a measured statement (§2, §5) or a shape the query builder will emit and must be re-copied once the code exists.
>
> Every timing in §2 and §6 was produced by executing against the project's own Postgres 16.11 container inside a rolled-back transaction, against a fixture of 20 000 orders / 18 401 deliveries / 21 200 attempts / 22 050 payment events, leaving 1 599 paid-but-undelivered. They are `EXPLAIN (ANALYZE, BUFFERS)` output, not estimates.

---

## 0. High-level approach

Phase 3 adds no new correctness mechanism. It adds a **second caller** into mechanisms Phase 1 and 2 already built, and one new **policy** that decides which supplier request to make next.

| Piece | What it is |
|---|---|
| **The ladder** (`issuance-ladder.ts`) | A pure function of recorded state. Given every `issuance_attempts` row for one order, return the next rung. No clock, no DB, no Nest — unit-testable without a supplier. |
| **The runner** (`issuance-runner.service.ts`) | Claim the order under the lock, walk the ladder, settle it. **The single entry point for both the automatic path and the operator retry**, so there is exactly one implementation of the claim, the lock and the rung sequence. |
| **Two stubs** | `suppliers/a/` and `suppliers/b/`, both calling the one `SupplierKeyClaimService`, with failure and hang behaviour stored in the database so it reaches every process. |
| **The recovery surface** | `GET /api/admin/orders/undelivered` and `POST /api/admin/orders/:id/retry`, behind the existing `AdminTokenGuard`. |

**There is no admin-only path into issuance.** That is the design's load-bearing simplification: §2.5's guarantees are the guarantees Phase 2 already proved, because it is literally the same code.

---

## 1. The retry ladder

### 1.1 The rungs

`IssuanceStep` is a discriminated union, in the shape every other outcome type here uses, so "nothing left to do" is an ordinary member rather than a `null`.

| Member | When | Provider | Attempt | Request id |
|---|---|---|---|---|
| `askFirst` | no attempts exist | `a` | `1` | `req_{order}_a_1` |
| `probe` | newest attempt is `unknown`, probes not exhausted | **same as that attempt** | **same** | **byte-identical** |
| `fallThrough` | newest is `failed`, **no attempt for this order is `unknown`**, an untried provider remains | next in ladder | `max(attempt) + 1` | `req_{order}_b_2` |
| `settleRefused` | every provider definitely refused | — | — | — |
| `settleNeverEstablished` | an attempt is still `unknown` and probes are exhausted | — | — | — |

The clause that carries the whole phase is in the `fallThrough` row: **`no attempt for this order is unknown`**. `architecture.md` §4 states it as the hard rule; here it is a predicate over rows. `settleNeverEstablished` outranks `fallThrough` in the decision order, which makes the rule unrepresentable rather than merely obeyed.

### 1.2 The request id at each rung — the crux

`deriveIssuanceRequestId(orderId, provider, attempt)` is unchanged: pure, total, dependency-free. **The ladder never invents an id; it chooses three arguments and the id follows.**

| Rung | provider | attempt | id | Why |
|---|---|---|---|---|
| First ask | `a` | `1` | `req_ord_x_a_1` | Unchanged from Phase 1. |
| Re-probe ×N | `a` | `1` | `req_ord_x_a_1` | **Same three arguments, therefore the same string.** Nothing is remembered and nothing is read back — it is *recomputed* and comes out identical. This is what makes the supplier's ledger (I5) answer with the code it already issued instead of claiming a second key. |
| Fall through | `b` | `2` | `req_ord_x_b_2` | A **different question**, asked of a supplier that has never heard it. |
| Operator retry after both refused | `a` | `3` | `req_ord_x_a_3` | Same mechanism, one rung further. |

No code path reads `issuance_attempts.request_id` in order to reuse it. That is the property `issuance-request-id.ts` was written for, and honouring it is what keeps the admin retry, the drain and the fall-through from each needing to remember the same thing correctly.

**Probes are counted in a column, not in the id** — `probe_count`, incremented by a narrow `ON CONFLICT DO UPDATE` that touches that column and nothing else:

```sql
insert into "issuance_attempts"
  ("id","request_id","order_id","provider","attempt","status","probe_count","code","last_error","created_at")
values (default, $1, $2, $3, $4, $5, 1, default, default, default)
on conflict ("request_id") do update
  set "probe_count" = "issuance_attempts"."probe_count" + 1
returning "id","request_id","order_id","provider","attempt","status",
          "probe_count","code","last_error","created_at";
-- $5 = 'unknown' — always. A row is never born in any other state.
-- probe_count is passed as a LITERAL 1, not `default`. Slice 2 dropped the
-- column default deliberately: `attempt` must fail loudly when a caller forgets
-- to compute it (writing 1 silently would reserve a request_id that already
-- exists, hit ON CONFLICT DO NOTHING, and re-probe an old attempt instead of
-- making a new one), and having one new column explicit while its neighbour is
-- implicit is the kind of asymmetry nobody remembers. The row exists because we
-- are about to ask, so 1 is always the right first value — it is now stated
-- rather than assumed. Passing `default` here raises 23502.
-- DO UPDATE touches probe_count AND NOTHING ELSE. On the probe path the row may
-- already say 'ok'; resetting status to 'unknown' would erase the one fact worth
-- having. Unlike DO NOTHING it always returns the row, removing a follow-up SELECT.
```

The increment runs **before** the call, outside any transaction, for the same reason the row itself is: it counts *asks*, not *answers*, so a process killed mid-request leaves a truthful count with no `catch` having run. **Accepted cost:** a worker that dies before sending burns a probe. The alternative — incrementing after — loses the count on exactly the failure it exists to count.

### 1.3 The budget, and where an unresolved order rests

**Assumption A1.** `SUPPLIER_MAX_PROBES_PER_REQUEST = 3` (one ask, two re-probes). The spec names no number. Three is the smallest count that distinguishes "the socket died once" from "this supplier is not answering".

On `settleNeverEstablished` the order moves to `delivery_failed` and **nothing is written to `issuance_attempts`**:

```sql
begin;
select … from "orders" where "orders"."id" = $1 for update;

-- DELIBERATELY NO WRITE TO issuance_attempts. The row already says
-- status = 'unknown', last_error = NULL, probe_count = 3 — and that IS the
-- record §2.2's fourth criterion asks for. Writing 'failed' is the exact bug
-- this phase exists to prevent, and there is nothing truthful to write instead.

update "orders" set "status" = $1, "updated_at" = now()
where ("orders"."id" = $2 and "orders"."status" = ANY($3))
returning …;
-- $1 = 'delivery_failed', $3 = '{delivering}'
commit;
```

**The distinction a reviewer will press on:** `orders.status = 'delivery_failed'` is a statement **about the shop** — "we did not hand over a key". `issuance_attempts.status = 'unknown'` is the statement **about the supplier** — "never established". They live in different tables because they are different facts, and §2.2's fourth criterion is satisfied by the second. The recovery list surfaces it as `outstanding_request_id`.

### 1.4 One invocation walks the whole ladder

**Assumption A2.** The ladder runs to a resting state inside one invocation, rather than one rung per invocation with the scheduler re-entering. One claim = one worker = one ladder walk keeps the exclusion story identical to Phase 2's.

The cost is a fourth term in `architecture.md` §5's ordered chain, which must be written where whoever sets these values will read it:

```
SUPPLIER_MAX_PROBES_PER_REQUEST × SUPPLIER_TIMEOUT_MS × |supplierLadder|  +  overhead
    <  function execution ceiling
```

Defaults give `3 × 2000 × 2 = 12s`, which **exceeds Vercel's Hobby ceiling**. Nothing can enforce this in code — the ceiling is the platform's. So: document it in `.env.example`, log the computed worst-case budget at boot beside the existing supplier line, and size the deployed profile deliberately (lower `SUPPLIER_TIMEOUT_MS`, or probes to 2).

When the ceiling wins anyway the failure is survivable by construction: attempts say `unknown`, the order sits in `delivering`, the payment event is still pending, and the order appears in the recovery list. **Knock-on:** `TrackedContinuationScheduler`'s `SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000` was sized against a single timeout and must move with the budget.

---

## 2. `delivery_failed`, and the transitions

### 2.1 What the tripwires force

| Tripwire | Breaks | Forces |
|---|---|---|
| `_EveryOrderStatusIsClassified` | `order-status.ts` | Classify it — into **`recoverableOrderStatuses`, not `terminalOrderStatuses`** |
| `orders_status_check` | **at runtime**, while recording a delivery failure | The migration ships in the same commit |
| `Readonly<Record<OrderStatus, string>>` | the label map | The Russian copy is written now, not hurriedly at the end |
| `settledOrderStatuses` (derived) | nothing | Picks the new status up for free — the payoff the derivation was built for |

**Terminal is I9's set** — the array the guarded `UPDATE … WHERE status = ANY($3)` draws permitted sources from. Put `delivery_failed` there and **the operator's retry is illegal by construction**; §2.4 and §2.5 cannot be built at all.

### 2.2 The transition table

| Transition | to | from |
|---|---|---|
| `markDeliveryFailed` | `delivery_failed` | `[delivering]` |
| `retryIssuance` | `delivering` | `[out_of_stock, delivery_failed]` |
| `resumeIssuance` | `delivering` | `[delivering]` — **see §2.3** |

`_NoTransitionLeavesATerminalState` still holds. This is the first time a non-terminal path re-enters issuance, and that proof is what certifies the new arcs did not smuggle a resurrection in.

### 2.3 The one decision the two specialists disagreed on

**The conflict, stated plainly.** The backend plan proposes `resumeIssuance` so an order stranded in `delivering` by a dead worker can be recovered. The data-layer plan argues the opposite: `delivering → delivering` **returns one row to both callers and therefore excludes nobody**, so it needs a mechanism this phase does not have, and a stranded order should be listed-but-not-retryable.

**Both halves are correct, and the hole is real.** If a worker dies mid-issuance, the payment event stays pending — but every drain trigger's `beginIssuance` guard requires `paid`, which never matches `delivering`. **Nothing in the system can recover that order.** Refusing `resumeIssuance` leaves a permanently unrecoverable state in the phase whose entire subject is recovery.

**Resolution: `resumeIssuance` ships, operator-only, with its exclusion stated rather than assumed.**

Its guard excludes nobody, so the exclusion is two things and neither is the guard:

1. **The order row lock**, which serialises the two claims; and
2. **The rung both resumers necessarily compute.** Under the lock they read the ledger sequentially. A `probe` writes no new attempt row, so the second reader sees the identical ledger and computes the identical rung — the **same** `request_id` — which I5 answers with the code it already issued.

That second point is what makes it safe, and it is also exactly what makes it fragile: it holds only while every concurrent resumer lands on `probe`. **If a future change lets two resumers reach `fallThrough` from different snapshots, two suppliers get two different questions and two keys leave the pool.** That is Risk R3.

`resumeIssuance` is a **separate row** in the transition table rather than a widened `from` list on `retryIssuance`, precisely so this is visible where a reviewer looks.

**Assumption A3.** Rejected alternative: a staleness threshold ("resume only a `delivering` order older than N seconds"). It adds a knob whose correct value nobody can know, and §3 of the spec states nothing is hidden from the operator on a timer.

### 2.4 Which settled status the ladder chooses

| Every provider's definite reason | Order lands in |
|---|---|
| all `out_of_stock` | `out_of_stock` — §2.3 requires this to read differently from a fault |
| any other, or a mix | `delivery_failed` |
| still `unknown` after probes | `delivery_failed`, with the attempt row carrying the truth |

`transitionForReason`'s `assertNever` over `SupplierIssueErrorReason` breaks when §4 adds `supplier_rejected`, forcing this mapping to be extended rather than defaulted.

### 2.5 Entry-point decision table

| Observed under the lock | Transition | `$3` | Outcome |
|---|---|---|---|
| `paid` | `beginIssuance` | `{paid}` | ladder from `askFirst` |
| `out_of_stock` / `delivery_failed` | `retryIssuance` | `{out_of_stock,delivery_failed}` | ladder recomputes |
| `delivering` | `resumeIssuance` | `{delivering}` | ladder probes the outstanding id |
| `delivered` / `created` / `payment_failed` | none | — | refused, `409` |

The refusals are §2.5's last criterion, decided by **zero rows from a guarded UPDATE** — not by an `if` on the row the lock returned.

---

## 3. Schema changes

| Table | Change | Why |
|---|---|---|
| `orders` | `orders_status_check` widened with `'delivery_failed'` | `shop.ts` chose `text` + CHECK over a Postgres enum **for exactly this migration** — widening a CHECK is ordinary DDL inside the migration transaction, whereas `ALTER TYPE … ADD VALUE` cannot use the new label in the same transaction that added it |
| `issuance_attempts` | `attempt integer NOT NULL` | The number exists today only as a text segment inside `request_id`. The alternative is `split_part(request_id,'_',-1)::int` — string surgery on a value whose other segments contain the same delimiter, unindexable, and silently wrong the day the id shape changes |
| `issuance_attempts` | `probe_count integer NOT NULL DEFAULT 1` | Bounds re-probes without creating a second row per probe (§1.2) |
| `issuance_attempts` | `CHECK (attempt >= 1)`, `CHECK (probe_count >= 1)` | Mirrors the TypeScript guard at the layer that holds when TypeScript is bypassed |
| `issuance_attempts` | **`UNIQUE (order_id, attempt)`** | `request_id` UNIQUE does **not** cover this: `req_x_a_3` and `req_x_b_3` are two ids both claiming attempt 3. Measured: the second insert raises `duplicate key … "issuance_attempts_order_id_attempt_key"` even with different ids |
| `supplier_requests` | `provider text NOT NULL` | Defence in depth: the ledger lookup becomes `WHERE request_id = $1 AND provider = $2`, so a mis-addressed probe returns **0 rows** rather than returning A's code for a question asked of B |

> **Resolved conflict.** The backend plan proposed `UNIQUE (order_id, provider, attempt)`. That is wrong given that both plans agree `attempt` is numbered **per order**: the three-column version would permit `(x,a,3)` and `(x,b,3)`. The two-column constraint is the one that expresses the agreed rule.

### Rejected, with reasons

- **A column for "outcome never established"** — `issuance_attempts.status` already carries it, and that is why that column exists. An `orders.failure_kind` would be a second, derived copy of a fact the ledger holds — and the one that would drift. Three readings come from one pair of columns: `failed` + `last_error` → the supplier said no; `unknown` + `last_error` NULL → *nobody knows*; no attempt row → never offered to a supplier.
- **`orders.paid_at`** — would need writing inside the one generic guarded UPDATE §3.1 specifies letter-for-letter, forcing a `CASE` in the SET list or a per-transition special case in a table whose whole point is that it is data. §2 derives it from `payment_events` instead, and §4 makes that free.
- **`orders.retry_count`, a recovery-queue table, a `delivery_failures` table** — the recovery list is a query, not a queue. No claim, no fan-out, no ordering to maintain.
- **A CHECK on `issuance_attempts.provider`** — consistent with the existing decision not to CHECK `status`: those value sets belong to the retry policy, which should not alter a constraint to extend itself.
- **Splitting the key pool per supplier** — **Assumption A4.** A and B share one fifty-key pool and one ledger. The fifty keys are the assignment's supplied fixture; §2.2's conservation check is one `count(*)` against another rather than a sum; and the ledgers are already disjoint by the provider segment in the id. **Stated consequence:** an empty pool is refused by both, so an out-of-stock order costs one wasted fall-through call before settling. One call, not fifty — and the alternative is the shop knowing its two suppliers share inventory, which is the boundary violation Phase 1 spent its effort avoiding.

---

## 4. The recovery-list query

**Assumption A5.** The list is every order paid and holding no key — `paid`, `delivering`, `out_of_stock`, `delivery_failed` — not just the two retryable ones. Restricting to the retryable pair would hide the one class of stuck order that is otherwise invisible: an order whose worker died between the claim and the outcome write. Retry *eligibility* is a separate, narrower question, answered by the guarded UPDATE.

```sql
SELECT o.id, o.sku, p.name AS product_name, o.amount_minor, o.currency,
       o.status, o.created_at,
       (SELECT min(pe.received_at) FROM payment_events pe
         WHERE pe.order_id = o.id AND pe.status = 'paid')  AS paid_at,
       a.provider AS last_provider, a.attempt AS last_attempt,
       a.status AS last_attempt_status, a.last_error AS last_attempt_error,
       a.request_id AS last_request_id
  FROM orders o
  LEFT JOIN products p ON p.sku = o.sku
  LEFT JOIN LATERAL (
        SELECT ia.provider, ia.attempt, ia.status, ia.last_error, ia.request_id
          FROM issuance_attempts ia
         WHERE ia.order_id = o.id
         ORDER BY ia.attempt DESC
         LIMIT 1
  ) a ON true
 WHERE o.status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed')
   AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.order_id = o.id)
 ORDER BY paid_at ASC NULLS LAST, o.created_at ASC
 LIMIT 200;
-- 0 rows  => THERE IS NOTHING TO RECOVER. Not an error and not an empty screen:
--            §2.4 requires the operator be told so in words. The only zero-row
--            case in this document that is a complete answer rather than a
--            signal somebody else got there first.
-- paid_at NULL     => paid with no `paid` event on file. Listed, not hidden.
-- last_* all NULL  => never offered to a supplier. "Not yet attempted", not a failure.
-- last_attempt_status = 'unknown' => THE OUTCOME WAS NEVER ESTABLISHED (§2.2 c4).
--            MUST NOT render as "failed": a key may exist for last_request_id,
--            and only re-probing that id can say.
```

**`NOT EXISTS` is not redundant with the status filter.** `issuance.service.ts` has a live `Unresolved` path — *"a key is bound to X but the order did not reach delivered"* — leaving an order reading `delivering` while the shopper already holds their key. Measured: one such row in the fixture, removed by this predicate.

**`LEFT JOIN LATERAL`, measured against the alternatives:**

| Strategy | Execution | Buffers | Verdict |
|---|---|---|---|
| **`LEFT JOIN LATERAL … LIMIT 1`** | **8.7 ms** | 11 465 | **Chosen.** One probe per outer row, at most one row by construction |
| `DISTINCT ON (order_id)` | 1 713 ms → 9.1 ms with indexes | 437 690 | Computes the latest attempt for all 19 600 orders then throws 92 % away |
| Five correlated subqueries | 2 820 ms | 441 136 | Slowest, and restates "latest" five times |

Plain `LEFT JOIN issuance_attempts` returns **3 198 rows for 1 599 orders** — the operator sees a stuck order two or three times and presses retry on each. And the trap under the trap: `CROSS JOIN LATERAL` is the natural thing to write and silently **drops** the 3 orders with no attempt row — the most alarming rows on the screen.

`ORDER BY ia.attempt DESC`, not `created_at DESC`: `created_at` defaults to `now()`, which is transaction-start time and therefore ties for two rows written in one transaction. `attempt` is a total order with no ties, because of the UNIQUE above.

**The bound-parameter trap, measured.** The status list must be **literals**, not `= ANY($1)`:

```
-- literals:            Index Scan using orders_undelivered_idx
-- = ANY($1), generic:  Seq Scan on orders   Filter: (status = ANY ($1))
```

Postgres cannot prove a value it has not seen implies a partial index's predicate. Custom planning saves it today — `client.ts` forbids `.prepare()` — but that is a planner heuristic protecting the query, not a property of the query. **This is the one place the codebase's own `= ANY($3)` convention should not be copied**: that convention exists so statement text stays stable across `from`-lists of different lengths, and there is no partial index there for a parameter to hide a predicate from.

---

## 5. Indexes

```sql
-- (1) The single largest win in this phase: 1 723.8 ms -> 12.7 ms.
CREATE INDEX payment_events_paid_order_idx
  ON payment_events (order_id, received_at) WHERE status = 'paid';
-- Partial on the strongest possible predicate: payment_events.status is written
-- once at insert and never updated anywhere in the codebase, so membership is
-- fixed at birth. Plan: InitPlan -> Limit -> Index Only Scan. Build 10.7 ms.

-- (2) Enforces §3's invariant AND serves the lateral and the §6 ledger read.
ALTER TABLE issuance_attempts
  ADD CONSTRAINT issuance_attempts_order_id_attempt_key UNIQUE (order_id, attempt);
-- Index Scan Backward, no Sort node. Build 17.2 ms.

-- (3) Now redundant — (order_id, attempt) has order_id leading.
DROP INDEX issuance_attempts_order_id_idx;
-- Verified: the FK-shaped lookup becomes an Index Only Scan (0.055 ms).
-- Removes 2.2 MB and one index to maintain on the issuance write path.

-- (4) The driving scan. 72 kB against orders_status_idx's 552 kB.
CREATE INDEX orders_undelivered_idx ON orders (created_at)
  WHERE status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed');
```

| | Execution | Buffers | Dominant cost |
|---|---|---|---|
| Phase 1 indexes only | **1 723.8 ms** | 443 383 | `Seq Scan on payment_events` × 1 599 — 436 527 of those buffers |
| + (1) + (2) | **12.7 ms** | 10 627 | — |
| + (4) | **8.7 ms** | 11 465 | — |

**196× on two indexes — and the finding worth carrying is that the expensive part was never the per-order-latest-row problem everyone looks at.** All three lateral strategies were within 5 % of each other while they all carried the same `payment_events` sequential scan. It was `paid_at`, and it is invisible until you look at `Buffers`.

**Why a partial index applies here**, for the same reason `payment_events_unprocessed_order_idx` works: the predicate is stable in the direction that matters — rows leave and never come back. An order can move *inside* the set (`out_of_stock → delivering` on a retry) but the two ways out, `delivered` and `payment_failed`, are terminal by I9. The index holds exactly the shop's unfinished business and shrinks as that business is finished.

**Honest accounting of (4):** it saves 0.5 ms on an 8.7 ms query — the smallest of the four changes. It earns its place on size and residency, not on that half-millisecond. **Caveat to write beside it:** a partial index whose predicate is a status list must be rebuilt if a later phase adds another undelivered status, and the failure mode is not an error — it is the new status silently falling out of the operator's list.

`Heap Fetches: 1599`, not 0, on the measured plan: the fixture was inserted seconds earlier and never vacuumed. On a table autovacuum has visited this becomes a true index-only scan. Stated rather than quoting a `Heap Fetches: 0` that was not measured.

---

## 6. Transaction shapes

**The hard constraint.** No transaction may span the supplier HTTP call. `max: 1` per instance means a transaction held across `POST /issue` stalls *every other statement this instance wants to run* — catalogue, order creation, webhook intake, every status poll. The retry gets no exception; it gets Phase 2's bracket with one extra statement in the first transaction.

```
TX A   BEGIN; lock; read the ledger; claim; reserve the attempt; COMMIT;
————   POST {SUPPLIER_x_URL}/issue          ← no transaction, no lock held
TX A'  BEGIN; lock; resolve attempt n; reserve attempt n+1; COMMIT;   (fall-through only)
————   POST {SUPPLIER_y_URL}/issue          ← no transaction, no lock held
TX B   BEGIN; lock; resolve; bind; finish; COMMIT;
```

### TX A — and where the lock stops being defence in depth

```sql
BEGIN;

-- (1) THE LOCK. First statement, always. (2) is a read-then-act with nothing
--     else protecting it.
SELECT … FROM "orders" WHERE "orders"."id" = $1 FOR UPDATE;
-- 0 rows => no such order, and NOTHING IS LOCKED. 404.

-- (2) THE LADDER'S INPUT — NEW, AND THE STATEMENT THAT NEEDS THE LOCK.
SELECT "id","request_id","order_id","provider","attempt","status",
       "probe_count","code","last_error","created_at"
FROM "issuance_attempts" WHERE "order_id" = $1 ORDER BY "attempt" DESC;
-- Index Scan Backward using issuance_attempts_order_id_attempt_key, 0.012 ms.
-- Read INSIDE the lock: outside it these rows are a snapshot another worker is
-- free to extend between this SELECT and the decision computed from it.

-- (3) THE CLAIM.
UPDATE "orders" SET "status" = $1, "updated_at" = now()
WHERE ("orders"."id" = $2 AND "orders"."status" = ANY($3)) RETURNING …;
-- 1 row  => THIS worker walks the ladder.
-- 0 rows => somebody else owns it, or it is finished. This worker stops.

-- (4) Reserve the attempt row BEFORE the call — Phase 2's rule, unchanged.
COMMIT;
```

**Where the lock earns its keep — precisely, and this is the honest part.** Not by preventing a second key outright: I5's ledger, I3's `deliveries_order_id_key` and I6's `supplier_keys_claimed_by_request_id_key` already do that and would keep doing it with the lock removed. Two workers reading the *same* snapshot compute the *same* rung and send the *same* id, and the ledger answers both identically — the deterministic id keeps saving the weakened code, exactly as it did in Phase 2.

The lock defends the case where the two snapshots **differ**: one worker reads `[a/1 failed]` and computes `fallThrough → b/2` while another reads `[a/1 failed, b/2 unknown]` and computes something else. Two genuinely different questions are asked while an attempt is outstanding. The ledger cannot help — it is keyed on `request_id`, and these are two of them. **Two keys leave `supplier_keys`.** `deliveries_order_id_key` still keeps the *shopper* to one key, so the shop looks correct from outside; what breaks is **§2.2's fifth criterion — stock accounting.**

In the phrasing `order-lock.service.ts` already uses: **the lock serialises the workers; the ladder's `unknown` guard decides. Both, or neither is enough.**

**The signature enforces it.** `IssuanceHistory.readWithin(tx: Transaction, orderId)` takes a `Transaction` and nothing else — no overload for the pooled handle, exactly as `OrderLockService.lockOrder` has none. Reading the ladder's inputs outside a transaction does not compile.

### TX A′ — falling through

Reached only after a **definite** refusal, with the order already `delivering` and this worker holding the claim. There is no order transition to guard with, so the guard moves into the insert:

```sql
INSERT INTO "issuance_attempts" ("request_id","order_id","provider","attempt","status")
SELECT $1, o."id", $2, $3, 'unknown' FROM "orders" o
WHERE o."id" = $4 AND o."status" = 'delivering'
ON CONFLICT ("request_id") DO NOTHING RETURNING …;
-- 1 row  => attempt $3 reserved and the order is still ours to work on.
-- 0 rows => TWO DIFFERENT THINGS, not to be conflated: either the order left
--           `delivering` while we talked to A (someone finished it — stop), or
--           this request_id was already reserved by an abandoned run (a
--           re-probe — carry on). A follow-up SELECT on the order's status
--           tells them apart, and runs only on this path.
```

Guarded `INSERT … SELECT` rather than a read-then-insert under the lock, for the reason `order-lock.service.ts` gives about its own returned row: under the lock a check-then-act would be *safe*, and this codebase still does not write one.

### The timeout re-probe writes nothing

After a timeout the attempt row already says `unknown` and the order is already `delivering`, and both are still true. The re-probe is a bare HTTP call with the same `request_id` — **no transaction at all**, which is also the cheapest thing to do while a supplier is already struggling.

---

## 7. The two stubs and their failure controls

`apps/api/src/suppliers/b/`, mirroring `a/` and, like it, **exporting nothing**. Both call the same `SupplierKeyClaimService` one level up.

**Assumption A6.** Behaviour lives in a `supplier_behaviour` table, not in process memory — `pnpm race` runs four separate processes and a deployment runs N instances, so an in-process rate reaches none of the others.

| Column | Meaning |
|---|---|
| `provider` (PK) | `a` \| `b` |
| `failure_rate`, `hang_rate` | numeric(4,3), `0.000`–`1.000` |
| `hang_ms` | how long a hang lasts |
| `fail_next`, `hang_next` | **one-shot**: affect the next N calls, then decrement |

**The one-shot counters are what make §2.7's fifth criterion achievable.** A probabilistic rate makes "the second run behaves the same as the first" untrue by construction. The reviewer's manual exploration uses the rates; **the automated checks use only `fail_next`/`hang_next` and rates of exactly 0 or 1.** Enforced by review and stated in `scripts/race/README.md`.

The decrement is an atomic conditional UPDATE, in I7's shape — two concurrent calls must not consume the same one-shot:

```sql
UPDATE supplier_behaviour SET hang_next = hang_next - 1, updated_at = now()
WHERE provider = $1 AND hang_next > 0 RETURNING hang_ms;
-- 1 row  => THIS call consumes the one-shot and hangs.
-- 0 rows => none left; fall back to hang_rate.
```

**`PUT` replaces, it does not merge** — an omitted field resets to the seeded zero, so `{}` is the reset button and a check's body fully determines the supplier's behaviour. §2.7's fifth criterion (two runs behave alike) then falls out of the method's semantics rather than out of every caller remembering to zero five fields. The cost, which check authors must know: `{"hang_next": 1}` alone leaves `hang_ms` at 0 — a zero-length hang. Pass both. The response echoes the *stored* row rather than the request, so this is visible immediately.

Control endpoint `PUT /internal/suppliers/:provider/behaviour` — on the **supplier side**, not under `/api`, because it is the reviewer's console into a simulated external service. Restocking is `POST /internal/suppliers/keys`, which **inserts new rows**; it does not un-claim existing ones (§7 of the architecture: restoring `claimed_by_request_id = NULL` is a thing only a test may do).

`SupplierIssueErrorReason` gains `supplier_rejected` — an injected refusal cannot reuse `out_of_stock`, which would be a lie whenever the pool is full and would route to the wrong order status. `4xx`, never `5xx`: **answered, and the answer is no.**

### 7.1 The inequality that is currently documented backwards

`architecture.md` §5, `supplier-config.ts` and `.env.example` all state:

```
supplier's injected hang  <  SUPPLIER_TIMEOUT_MS  <  function execution ceiling
```

**That is the wrong direction for the scenario this phase exists to demonstrate.** A hang shorter than the client's timeout produces no timeout at all. The reasoning given for it conflates two different things: the *client* giving up (`AbortSignal.timeout` aborts the socket, not the remote handler) and the *platform* killing the function.

There are two distinct hang scenarios needing opposite orderings:

| Scenario | Hang vs the claim | Inequality | Demonstrates |
|---|---|---|---|
| Slow but successful | before the claim, short | `hang_ms < SUPPLIER_TIMEOUT_MS` | a slow supplier is not a failed one |
| **The trap** | **after the claim, long** | **`SUPPLIER_TIMEOUT_MS < hang_ms < ceiling`** | a key genuinely issued, a client that cannot know it, and a re-probe that gets the same code back |

All three copies must be corrected, and the injected hang placed **after** the claim commits so the ledger has a code to return.

---

## 8. The operator's endpoints

Both behind `@UseGuards(AdminTokenGuard)` — `503` unconfigured, `401` missing or wrong. §2.4's last criterion is satisfied by the guard as it stands, with no change. `apps/api/src/admin/order-recovery.controller.ts`, following the `payment-event-sweep.*` pairing. **Re-check `admin.module.ts`'s module-distance argument after adding `OrdersModule` and `IssuanceModule` to its imports** — `SchedulingModule` must stay at distance 2.

### `GET /api/admin/orders/undelivered` → 200

Bounded at 200 rows (**Assumption A7** — a shop with more than 200 stuck orders has a different problem). The report carries `count`, `truncated`, a `message` for §2.4's fifth criterion, and per order: `order_id`, `sku`, `product_name` (nullable), `amount_minor`, `currency`, `status`, `created_at`, `paid_at`, `retryable`, **`outstanding_request_id`**, `last_error`, and the attempt list.

`outstanding_request_id` is the newest attempt whose status is `unknown`, or `null`. **It is the field that makes "never established" readable without opening `psql`**, and it is what §2.4's fourth criterion means by *"what went wrong"* when nothing definite ever went wrong.

The report carries **no delivered key, ever**. The operator has no business reading a shopper's key, and `OrdersService.findOrder` already establishes the pattern of gating it in SQL.

### `POST /api/admin/orders/:orderId/retry` → 200 | 409

`@HttpCode(200)` — nothing is created. `POST` not `GET`, for the sweep's reason: it moves orders, calls suppliers and binds keys, and a `GET` is reachable by a crawler, a prefetch or a restored tab.

The handler does one thing: `await this.runner.runForOrder(orderId, IssuanceEntry.Operator)` — the **identical** claim-under-lock and ladder the automatic path uses.

**`200` vs `409` is a distinction worth defending:** `409` means *this order is not stuck*; `200` with `outcome: "still_out_of_stock"` means *it is stuck, the retry ran correctly, and it is still stuck* — §2.5's fifth criterion, which requires the operator to be told why and the order to remain in the list.

**Assumption A8.** The endpoint reports the outcome synchronously rather than `202`. Issuance measures 25–65 ms locally.

**Safe pressed repeatedly and from two places at once, with no in-process guard, no mutex, no de-duplication cache** — every row below is a mechanism that already exists:

| Race | What happens |
|---|---|
| Two retries, same process | Both `FOR UPDATE`; one waits. Winner claims; loser re-reads and takes `resumeIssuance`, which the ladder answers with a `probe`. |
| Two retries, two instances | Identical — it is a row lock in Postgres, not a lock in a process. |
| A retry racing an automatic drain | Identical — same row lock, same guarded UPDATE. |
| Both probes reach the supplier with the same id | Both miss the ledger, both claim different keys under `SKIP LOCKED`, one loses on `supplier_requests_pkey`, **its whole transaction rolls back un-claiming its key**, and it re-reads the winner's code. |
| Two `deliveries` inserts | `deliveries_order_id_key`; the loser's `ON CONFLICT DO NOTHING` is a no-op. |

---

## 9. Frontend

### 9.1 The polling change — a criterion that fails by definition, not by bug

`delivery_failed` joins `recoverableOrderStatuses`, so `settledOrderStatuses` — which is `terminal ∪ recoverable` — now contains **exactly the two states an operator can move**. The order page's current stop condition is `isSettledOrderStatus`, so leaving it:

> compiles, ships, every existing check stays green, and **§2.6's third criterion is silently unmet** — the shopper watching a stuck order never sees the operator's retry arrive.

The stop condition splits into the two questions the contracts file always distinguished:

| Class | Test | The page does |
|---|---|---|
| Terminal — `delivered`, `payment_failed` | `isTerminalOrderStatus` | **Stop.** Nothing can ever move it |
| Recoverable — `out_of_stock`, `delivery_failed` | `isRecoverableOrderStatus` | **Keep reading, slowly** (5 s) |
| In flight | neither | 1 s, as today |

**This is not the failure the tripwire warns about.** That comment fears a page polling a *dead* order forever — an unclassified status defaulting to in-flight with nothing able to change it. Here the status is classified, the reading is deliberate, slower, and waiting on a real event a real person can cause. Cost measured in Phase 2: a settled order's poll costs **0 extra round trips and no index probe**, since the drain is gated in the database's own answer.

**Snap back to 1 s the moment a read shows the order back in flight.** Not tidiness: at a 5 s beat a 25–65 ms issuance is invisible, so the page would jump from «Не удалось выдать ключ» straight to «Ключ выдан» — a quiet regression of spec 002 §2.5 caused by a Phase 3 change that never mentions it.

**Assumption A9.** A bounded watch window of 5 minutes, after which the page says it has stopped refreshing. One constant and one branch; drop it if challenged.

### 9.2 The words

`order-status-label.ts` stops compiling until it gets `[OrderStatus.DeliveryFailed]`. A **second, independent tripwire** exists: `apps/api/test/unit/order-status-russian-labels.test.ts` iterates `orderStatuses` and scans this file's text for a Cyrillic label. Adding the contracts member first turns **both** red — a compile error and a `pnpm test` failure — before a line of label is written. That is the RED validation for this string, and it costs nothing to sequence it that way.

The label cannot carry §2.3's second half, so a new `order-recovery-explanation.ts` holds a `Readonly<Record<RecoverableOrderStatus, string>>`, total over the recoverable set:

| Status | Text |
|---|---|
| `out_of_stock` | «Оплата прошла, но ключей для этого товара сейчас нет. Заказ не потерян: как только ключи появятся, мы выдадим ваш — страница обновится сама.» |
| `delivery_failed` | «Оплата прошла, но выдать ключ не удалось из-за сбоя на стороне поставщика. Заказ не потерян: мы уже занимаемся этим — страница обновится сама.» |

Both open with «Оплата прошла» — §2.3's fourth criterion, shopper-visible. They differ in exactly the clause §2.3's second criterion asks about. Neither promises a refund or an email, both of which §3 puts out of scope.

### 9.3 The operator's view

`/admin/recovery`, functional and unstyled. Seven view states as a discriminated union with an `assertNever` default: `no-token`, `loading`, `list`, `empty`, `unauthorized` (401), `disabled` (503 — **no form**, because pasting cannot help), `error`. The `401`/`503` split mirrors `admin-token.guard.ts`'s own answers one-for-one.

**No client-side route guard, and there must not be one** — a check the browser makes is a check the browser can be told to skip. The page renders for anyone; every byte of order data comes from a guarded endpoint. §2.4's last criterion is checked by calling the endpoint, never by inspecting the DOM.

**Token handling:** `sessionStorage`, deliberately the opposite choice from `purchase-intent.ts`'s `localStorage` — there the requirement was that two tabs share a value, here it is the reverse. Every access in `try`/`catch`, because `window.sessionStorage` itself throws when site data is blocked. **Never `VITE_ADMIN_TOKEN`** — the admin page and the storefront are one bundle, so a build-time value ships to every shopper. Never in the URL.

**Assumption A10.** Operator-facing text is English; only the shopper's page is Russian. Everything else this operator reads in the same minute — the `401`/`503` bodies, `.env.example`, the guard's logs — is English.

**"Paid but undelivered" is wider than "stuck", and the row must not pretend otherwise.** Whether a row offers a retry button is decided by `isRecoverableOrderStatus`; a `paid`/`delivering` row shows "in progress" rather than a dead control; the API refuses regardless. The model type is named `UndeliveredOrder`, not `StuckOrder`.

**The reason column must not collapse *unknown* into *failed*** — a one-character bug (`reason ?? "failed"`) that breaks §2.2's fourth criterion on the only screen where a person reads that record.

### 9.4 Retry, and why the disabled button is a courtesy

Per-row busy state, never global — two stuck orders can be retried at once. Every outcome **re-fetches the whole list**; the endpoint is the authority and the button's opinion is discarded.

The unanswered-retry case applies this phase's own thesis on the client: *"The retry request did not come back. It may or may not have run — refresh to see."* **A retry whose response was lost may well have delivered a key, and a UI that reports it as failed teaches the operator to press again against a supplier that already answered.**

The double-press guard is a courtesy, not the protection: §2.5's fourth criterion is **two operators on two machines**, which no client state can address. **Therefore the check must not be a click test** — a verification that clicks Retry twice in one browser and finds one key proves only that the button was disabled; it cannot fail against a broken server, therefore it cannot pass either. §2.5's third and fourth criteria are exercised as concurrent `POST`s from several processes, asserted against the database.

**Refresh is manual.** §2.4's "without waiting for any period" is a statement about the server not hiding orders behind a grace period, not a request for auto-refresh — and an admin tab left open on a second monitor polling every second would be the one page in the shop holding the `max: 1` connection for nobody's benefit.

---

## 10. Migration safety

The task plan splits this across slices (`0001_delivery_failed_status`, then slice 2's ledger migration, then slice 4's indexes) so each slice stays independently runnable; the ordering constraints below still hold, and slice 4's `orders_undelivered_idx` still depends on slice 1's widened CHECK.

**A correction to how the runner behaves**, found while writing slice 1's migration and worth stating because the inaccurate version is repeated in `migrate.ts`'s own comment and in `0000_init.sql`'s header: drizzle-orm's pg dialect does **not** run each file in its own transaction. It opens **one** transaction spanning every pending file *and* every journal insert. The atomicity guarantee is therefore stronger than claimed, not weaker — but anyone reasoning that file N+1 commits independently of file N is reasoning from a false premise.

**Nothing here rewrites a table.** No `ALTER COLUMN … TYPE`, no volatile default, no `SET NOT NULL` on an existing column. Two operations scan; three build an index.

| # | Statement | Measured | Lock |
|---|---|---|---|
| 1 | widen `orders_status_check` | **3.6 ms** / 20 000 rows | `ACCESS EXCLUSIVE`, full scan, no rewrite |
| 2 | `ADD COLUMN attempt integer NOT NULL DEFAULT 1` | **1.7 ms** / 21 200 rows | metadata-only (`attmissingval` since PG 11) |
| 3 | `ALTER COLUMN attempt DROP DEFAULT` | **0.5 ms** | metadata-only |
| 4 | `ADD COLUMN probe_count integer NOT NULL DEFAULT 1` | metadata-only | — |
| 5 | the two `CHECK`s | **3.3 ms** | full scan, no rewrite |
| 6 | `ADD CONSTRAINT … UNIQUE (order_id, attempt)` | **17.2 ms** | `ACCESS EXCLUSIVE` |
| 7 | `DROP INDEX issuance_attempts_order_id_idx` | instant | must follow 6 |
| 8 | `CREATE INDEX payment_events_paid_order_idx` | **10.7 ms** | `SHARE` |
| 9 | `CREATE INDEX orders_undelivered_idx` | **6.0 ms** | `SHARE`; **must follow 1**, or the predicate names a status the CHECK forbids |
| 10 | `supplier_requests.provider`, then `DROP DEFAULT` | metadata-only | — |

**Why `DROP DEFAULT` matters, verified rather than assumed:** the default exists only to make the `ADD COLUMN` rewrite-free. Leaving it would let a caller that forgot to compute the next attempt number silently write `1` — reserving a request id that already exists, hitting `ON CONFLICT DO NOTHING`, and re-probing an old attempt instead of making a new one. Dropping it turns that into a `NOT NULL` violation at the first insert.

**The step most likely to fail on real data is 6** — *"add a unique constraint"* is the classic migration that passes in development and fails in production. It cannot fail here because Phases 1–2 derive exactly one request id per order and `issuance_attempts_request_id_key` means at most one attempt row per order. Worth checking rather than reasoning about, on any database that has run the race scripts:

```sql
SELECT order_id, count(*) FROM issuance_attempts GROUP BY 1 HAVING count(*) > 1;
-- 0 rows => step 6 will succeed. Run this BEFORE the migration, not after it fails.
```

**`CREATE INDEX CONCURRENTLY` is not available** — it cannot run in a transaction block, and `migrate.ts` puts every file in one. At 10.7 ms and 6.0 ms the trade is not worth making. Stating the constraint now is cheaper than discovering it during an incident.

**Ordering against the deploy:** migrations precede the deploy (`pnpm db:migrate`), which is the natural order. Reversed, the first order to exhaust its budget takes a `23514 check_violation` inside TX B, rolls back, and rests in `delivering` — a stuck order created by the very migration meant to make stuck orders recoverable.

---

## 11. Risks

| # | Risk | Mitigation |
|---|---|---|
| **R1** | **The hang inequality is documented backwards** in three places. A hang shorter than the client's timeout produces no timeout, so the trap never fires and the check passes having exercised nothing. | Correct all three to `SUPPLIER_TIMEOUT_MS < hang_ms < ceiling`, place the hang **after** the claim commits. The timeout check asserts a `supplier_requests` row exists for the timed-out id; if it does not, the check is measuring the wrong thing. |
| **R2** | **The RED validation comes back green — again.** Phase 2 removed `FOR UPDATE` and every assertion held, because the deterministic id and I3/I5/I6 masked it. The same masking applies: break the ladder's `unknown` guard and `deliveries_order_id_key` still gives the shopper one key. | **Assert stock accounting, not the shopper's key count**: `count(*) FROM supplier_keys WHERE claimed_by_request_id IS NOT NULL` must equal `count(*) FROM deliveries`. That is §2.2's fifth criterion and the only assertion that fails. Weaken the **ladder rule**, not the lock. A count that varies between runs is the signature of a genuine race. |
| **R3** | **`resumeIssuance` is safe only while every concurrent resumer lands on `probe`** (§2.3). A future change letting two resumers reach `fallThrough` from different snapshots asks two suppliers two questions and two keys leave the pool. | Named as its own transition row so it is visible. Concurrency test: two simultaneous operator retries on one order, asserting stock accounting. The walkthrough must state plainly that this arc's exclusion is the lock and nothing else. |
| **R4** | **The ladder's inputs get read outside the lock** by a refactor that "moves the query up for clarity". Two workers compute different rungs and two keys leave the pool — invisibly, because I3 still keeps the shopper to one. | `IssuanceHistory.readWithin(tx: Transaction, …)` — no overload for the pooled handle. The mistake does not compile. |
| **R5** | **The invocation budget exceeds the function ceiling** (`3 × 2000 × 2 = 12 s`). The function is killed mid-ladder: no exception, no log line. | Cannot be enforced in code. Document in `.env.example`, log the computed budget at boot, size the deployed profile deliberately. Survivable by construction: attempts say `unknown`, the order is listed, `resumeIssuance` is the way back. Move `SHUTDOWN_DRAIN_TIMEOUT_MS` with it. |
| **R6** | **`delivery_failed` added without the migration.** The CHECK rejects the write *at the moment the shop records a delivery failure* — the worst possible time, surfacing as a `500` on an already-broken order. | Migration in the same commit as the contract change. Do not weaken the CHECK to make ordering easier. An acceptance test that drives an order to `delivery_failed` catches it. |
| **R7** | **`attempt` computed per provider.** An operator retry of A after B refused recomputes `req_x_a_1` — a re-probe of a settled request — and `ON CONFLICT` swallows it silently. The order can never be re-issued. | `max(attempt) + 1` across **all** the order's attempts, plus `UNIQUE (order_id, attempt)`, which turns a drifted number into a `23505` rather than a silent reuse. Test: retry after both refuse, assert a *third* attempt row. |
| **R8** | **Fractional rates make the checks flaky**, and §2.7's fifth criterion fails intermittently — which reads as a correctness bug and is not one. | One-shot counters consumed by an atomic conditional UPDATE. Automated checks write only `0`, `1`, or a one-shot. |
| **R9** | **`SUPPLIER_B_URL` without a scheme** parses cleanly as scheme `localhost:` and fails only inside `fetch` — at the first fall-through, on a paid order, looking exactly like B being down. | `readUrl`, the validator A already uses. `.env.example` carries A's warning verbatim. Boot-time log naming B's resolved URL. |
| **R10** | **The poll keeps `isSettledOrderStatus`.** Compiles, ships, all checks green, §2.6's third criterion silently unmet. | Stop on `isTerminalOrderStatus`. The check must be a **browser** check: retry from a second context with the first page open and untouched. RED: with the old condition, it must fail. |
| **R11** | **The retry endpoint becomes an automatic loop** — an admin page that polls it, or a script on a timer — turning a supplier outage into a stampede. | Out of scope per the spec. `POST`, no body, no affordance that invites automation, manual refresh only. Worth a comment in the controller naming it a deliberate omission, since the obvious "improvement" is a timer. |
| **R13** | **Three unlinked lists of the same two provider strings** — `IssuanceProvider` (shop side), `SupplierProvider` (supplier side, deliberately separate to keep the boundary real), and `supplierBehaviourProviders` in `packages/db`'s fixtures. The first two being distinct is a decision on record; the fixture being a third copy is drift with no tripwire. A provider added to the unions but not the fixture has no behaviour row, so arming it answers `404` and a check fails for a reason that looks nothing like its cause. | Found while adding supplier B. Not fixed there — out of that task's scope. A slice 7 check that arms **both** providers would catch it, since the missing row surfaces as a `404` at arm time rather than as a wrong result later. Cheapest real fix: derive the fixture from one list, or assert length equality in a unit test. |
| **R12** | **Both suppliers draw one pool**, so an empty pool costs a wasted fall-through call and a reviewer may read that as the rule misfiring. | Stated in §3 and in the walkthrough. The out-of-stock check asserts exactly two attempt rows (`a/1 failed`, `b/2 failed`) so the extra call is a documented expectation. |

---

## 12. Checks this phase adds (§2.7)

| Check | Stages | Asserts |
|---|---|---|
| `recover:refusal` | A `fail_next = 1`, B normal | order `delivered`, exactly two attempt rows (`a/1 failed`, `b/2 ok`), one delivery, one key claimed |
| `recover:timeout` | A `hang_next = 1`, `hang_ms > SUPPLIER_TIMEOUT_MS`, hang **after** the claim | order `delivered`, **one** attempt row `a/1` with `status = 'ok'` and `probe_count = 2`, **one** `supplier_requests` row, **one** claimed key |
| `recover:out-of-stock` | pool drained, order paid, restock, operator retry | `out_of_stock` then `delivered`; **claimed keys == deliveries** before and after |

All three assert the database as well as the API response, and all three restore the seeded baseline so a second run behaves like the first.

---

## Assumptions, collected

| # | Assumption |
|---|---|
| A1 | `SUPPLIER_MAX_PROBES_PER_REQUEST = 3` (one ask, two re-probes) |
| A2 | The ladder runs to a resting state inside one invocation |
| A3 | `resumeIssuance` ships rather than a staleness threshold — see §2.3, the one place two specialists disagreed |
| A4 | A and B share one key pool and one ledger; an out-of-stock order costs one wasted fall-through call |
| A5 | The recovery list includes `paid` and `delivering`, not just the retryable pair |
| A6 | Failure behaviour lives in a database table, not process memory |
| A7 | The list is bounded at 200 rows with no pagination |
| A8 | The retry endpoint reports its outcome synchronously rather than `202` |
| A9 | The shopper's page stops watching a recoverable order after 5 minutes and says so |
| A10 | Operator-facing text is English; only the shopper's page is Russian |
