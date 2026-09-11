# Phase 3 · Slice 2 — A backup supplier

> The first rungs of the retry ladder: supplier A refuses, supplier B delivers, and the shopper sees an ordinary `delivered` order with no hint that anything happened. One migration, one new table, one mirrored stub, one new refusal reason, and a pure function.
>
> The interest is in three places. **One identifier rule that looks like two** — a fall-through mints a new `request_id`, a re-probe must reuse one byte-identically — and the small numbering decision underneath it that makes the difference representable at all. **One shared fifty-key pool**, whose cost is stated up front rather than discovered by a reviewer. And **a planning error that this slice's own verification caught**, which is the most useful thing in it: the slice as drafted could not be verified, the verifier said so and refused to tick the box, and the fix is the sixth task in the list.

---

## 1. What actually shipped

| # | Change | Where |
|---|---|---|
| 1 | `0002_issuance_attempt_ledger` — `attempt`, `probe_count`, two CHECKs, **`UNIQUE (order_id, attempt)`**, `supplier_requests.provider`, and one now-redundant index dropped | `packages/db/drizzle/` |
| 2 | `supplier_behaviour` — the table, the atomic one-shot decrement, and `PUT /internal/suppliers/:provider/behaviour` | `apps/api/src/suppliers/` |
| 3 | Supplier B, mirroring A, calling the same `SupplierKeyClaimService`. `SupplierAClient` generalised to `SupplierClient` | `apps/api/src/suppliers/b/`, `apps/api/src/issuance/supplier.client.ts` |
| 4 | `supplier_rejected` as a second definite-failure reason | `packages/contracts/src/supplier.ts` |
| 5 | `issuance-ladder.ts` — a pure function — and `issuance-runner.service.ts` as the single entry point | `apps/api/src/issuance/` |
| 6 | **Added mid-slice:** refusal injection wired into both stubs | both controllers |

Change 5 is the shape worth noticing. The ladder is a function from *rows* to a *rung*: no clock, no database handle, no Nest, no supplier. That is not tidiness. The phase's central rule is a predicate over recorded state, and a predicate over rows can be exercised by handing it rows — which is why `apps/api/test/unit/issuance-ladder.test.ts` exercises the hard rule with no database and no HTTP at all, and why the four-process suite is left to prove the things only four processes can prove.

Change 6 is change 5's verification bill arriving late, and §4 is about that.

---

## 2. Keystone one — the request id, and the two rules that look like one

This is the assigned question, and it is the heart of the slice.

### The ladder never invents an id. It chooses three arguments.

`deriveIssuanceRequestId(orderId, provider, attempt)` is pure, total and dependency-free:

```
deriveIssuanceRequestId("ord_x", IssuanceProvider.A, 1)  =>  "req_ord_x_a_1"
```

Nothing in the issuance path reads `issuance_attempts.request_id` in order to reuse it. Every rung that asks a supplier carries a `requestId`, and that string is *always* the derivation of the three arguments the rung already chose. The id is an output, never an input.

That one property is what makes the two rules below coexist:

| Rung | provider | attempt | id |
|---|---|---|---|
| `askFirst` | `a` | `1` | `req_x_a_1` |
| `probe` (slice 3) | **same as the outstanding attempt** | **same** | **byte-identical** |
| `fallThrough` | next untried | **`max(attempt) + 1`** | `req_x_b_2` |

- **A fall-through mints a new id** because it is *a different question asked of a different party*. B has never heard of `req_x_a_1` and has no reason to. Asking B under A's id would be asking B to look up something in a ledger it never wrote.
- **A re-probe must reuse the id byte-identically**, because that is the only phrasing the supplier's ledger (I5) can answer with *the code it already issued* instead of cutting a second key. The probe rung itself is slice 3; the rule that makes it possible is established here.

The alternative — `randomUUID()` at the top of the issuance path — is rejected in the file's own header, and it is worth naming precisely because it is the obvious implementation. A random id can of course be stored and read back; that is exactly what `issuance_attempts.request_id` is. But then correctness depends on every future caller *remembering* to read it. The operator retry, the fall-through and the shutdown drain would each have to look it up, and the first one that forgets issues a duplicate key with no error anywhere. Deriving it means there is nothing to remember: attempt 1 for `ord_x` on provider `a` recomputes to `req_ord_x_a_1` in every process, on every machine, forever.

### `attempt` is numbered per order, not per provider

This is the part worth dwelling on, because the wrong version looks perfectly reasonable.

A per-provider counter would give `req_x_b_1` for the fall-through. That reads fine in a log line — attempt 1 at supplier B, attempt 1 at supplier A, two suppliers each on their first try. It breaks later, and not here.

Take the case the risk table (R7) names. Both suppliers definitely refused; the order is settled; an operator retries it. Under per-order numbering the ladder computes `max(attempt) + 1 = 3` and asks A under `req_x_a_3` — a question nobody has asked before. Under per-provider numbering the ladder would compute *A's* next attempt as 1 and recompute `req_x_a_1`: **a re-probe of a settled request wearing a fall-through's clothes.**

And it fails silently, which is the reason it is dangerous rather than merely wrong. The reserving statement is:

```sql
insert into "issuance_attempts"
  ("request_id", "order_id", "provider", "attempt", "status", "probe_count")
select $1, "orders"."id", $2, $3, $4, $5
from "orders" where "orders"."id" = $6 and "orders"."status" = $7
on conflict ("request_id") do nothing
-- $4 = 'unknown' — always. A row is never born in any other state.
-- $5 = 1         — one ask. Passed, never defaulted.
-- $7 = 'delivering'
```

`ON CONFLICT (request_id) DO NOTHING` swallows the collision. No error, no log line, nothing on a screen. The order sits with the attempt rows it already had, the operator presses retry again and gets the same nothing, and the order can never be re-issued.

### `UNIQUE (order_id, attempt)` makes that unrepresentable — and catches what `request_id` UNIQUE cannot

The migration's constraint is two columns:

```sql
ALTER TABLE "issuance_attempts"
  ADD CONSTRAINT "issuance_attempts_order_id_attempt_key" UNIQUE("order_id","attempt");
```

`issuance_attempts_request_id_key` was already there and does not cover this. That one catches two rows carrying the same request id *string*. This one catches a stored `attempt` that has **drifted from the string it appears in** — the row whose `request_id` says `req_x_b_3` while its `attempt` column says 2, and, in general, two rows that differ only in the provider segment.

Proven against the running database, inside a rolled-back transaction — two rows for one order, both attempt 3, with two *different* id strings:

```
BEGIN
INSERT 0 1                              -- the orders row the FK needs
INSERT 0 1                              -- req_ord_proof_unique_a_3, attempt 3
ERROR:  duplicate key value violates unique constraint "issuance_attempts_order_id_attempt_key"
DETAIL:  Key (order_id, attempt)=(ord_proof_unique, 3) already exists.
ROLLBACK
```

`request_id` UNIQUE was satisfied throughout and had nothing to say: `req_ord_proof_unique_a_3` and `req_ord_proof_unique_b_3` are different strings. The two-column constraint is the one that noticed.

The **three-column version `(order_id, provider, attempt)` was what the planning originally proposed, and it was corrected in the task list before the migration was written.** It would have accepted both rows above happily — `(x, a, 3)` and `(x, b, 3)` are distinct triples — and the ladder's `max(attempt) + 1` would then have handed the number 3 out twice. A constraint that admits the failure it was added to prevent is worse than no constraint, because it is quoted in reviews.

Two more layers sit under the same idea, deliberately and at different altitudes:

- `deriveIssuanceRequestId` throws on a zero, a float or a `NaN` before it will build an id, because `req_ord_x_a_NaN` is a second key issued for one order, found by a customer rather than by a test.
- `CHECK (attempt >= 1)` and `CHECK (probe_count >= 1)` mirror that guard at the layer that still holds when TypeScript is bypassed — a seed, a `psql` session, a future service in another language.

And the column defaults are dropped immediately after the backfill that needed them. That is the same argument once more: with `DEFAULT 1` left in place, a caller that forgot to compute the next attempt number writes a row saying attempt 1, no error, nothing in a log — and derives an id that was settled long ago. With the default gone, that mistake is a `23502 not_null_violation` at the first insert.

---

## 3. Keystone two — one pool, one ledger, and the cost stated

`supplier_keys` has no provider column. `supplier_requests` is keyed on `request_id`. A and B draw from the same fifty keys:

```
                    Table "public.supplier_keys"
        Column         |  Type  | Nullable |           Default
-----------------------+--------+----------+------------------------------
 id                    | bigint | not null | generated always as identity
 code                  | text   | not null |
 claimed_by_request_id | text   |          |
 claimed_at            | timestamptz |     |
```

The rejected alternative is splitting the pool per supplier — twenty-five keys each, or fifty each. It was rejected for three reasons, recorded as assumption A4:

1. **The fifty keys are the assignment's supplied fixture.** Inventing a second pool means inventing inventory the task did not give us.
2. **§2.2's conservation check is one `count(*)` against another rather than a sum.** *"The number of keys that have left the shop's stock equals the number of shoppers who received one"* is `count(*) FROM supplier_keys WHERE claimed_by_request_id IS NOT NULL` against `count(*) FROM deliveries`. With two pools it becomes an addition, and an addition is a place for a mistake to hide.
3. **The ledgers are already disjoint** by the provider segment inside the id, so sharing the table costs nothing in ambiguity.

There is a fourth reason that is really the first one restated: the alternative is *the shop knowing that its two suppliers share inventory*. That is precisely the boundary violation Phase 1 spent its effort avoiding. The supplier side and the shop side deliberately do not even share a TypeScript type for the provider string — `IssuanceProvider` lives in `apps/api/src/issuance/`, `SupplierProvider` lives in `apps/api/src/suppliers/`, and the fact that `"a"` means the same thing on both sides is *a fact about the wire*, not a fact the compiler is asked to enforce from one side of it. Note in passing that the provider is never on the wire at all: the supplier learns which supplier it is from its own mounted path, `/internal/suppliers/a/issue` or `/internal/suppliers/b/issue`. A supplier that had to be *told* which supplier it was would be a strange thing to trust.

### The consequence, stated rather than discovered

**An empty pool is refused by A *and* by B**, because it is the same empty pool. So an out-of-stock order costs one wasted fall-through call before settling — two attempt rows where a naive reader expects one.

That is R12, and it is stated because a reviewer who was not told would read the extra row as the ladder misfiring. The check asserts exactly two rows, not one and not fifty:

```
a/1 failed out_of_stock
b/2 failed out_of_stock
→ order settles out_of_stock
```

One wasted call, not fifty. The ladder asks each *supplier* once, not each key.

### And it must settle `out_of_stock`, not `delivery_failed`

Both suppliers refused, so the order settles; *which* settled status it lands in is §2.4's decision table, and it is not cosmetic. Functional spec §2.3's second criterion requires that *"the reason is distinguishable — being temporarily out of stock reads differently from something having gone wrong."* Only one of those is fixed by waiting.

```
| Every provider's definite reason | Order lands in    |
| -------------------------------- | ----------------- |
| all `out_of_stock`               | `out_of_stock`    |
| any other, or a mix              | `delivery_failed` |
```

The test is over the whole set of refusals, not over the newest one, and the asymmetry is deliberate. `out_of_stock` is the *narrow* claim — "both suppliers looked and the shelf is empty" — so a single unreadable, unrecognised or `NULL` reason in the set is enough to make the whole thing `delivery_failed`. Claiming `out_of_stock` wrongly promises a shopper a restock that fixes nothing.

This is also why `supplier_rejected` had to be a **new** reason rather than reusing `out_of_stock` for the injected refusal. A supplier that refuses while the pool is full has nothing to do with stock, and the stub answers `422` — a definite, readable "no" — never a `5xx`. `4xx` because the supplier *answered*, and the answer is no; a `5xx` invites redelivery, which is the opposite of what a definite refusal means.

---

## 4. Keystone three — a planning error the verification caught

Tell this plainly, because it is the most useful thing in the slice.

The slice was planned with **all** failure injection deferred to slice 3. Task 2 built `supplier_behaviour`, the `fail_next` counter and the `PUT /internal/suppliers/:provider/behaviour` endpoint; wiring a stub to actually *read* those values was slice 3's business.

That left this slice's own verification **unsatisfiable**. `fail_next` round-tripped through the endpoint correctly — write 1, read 1 back — and nothing in either stub called `SupplierBehaviourService.shouldRefuse`. A supplier could not be made to refuse. §2.1's headline scenario, *main supplier refuses, backup delivers*, was not exercisable at all.

The verifying agent armed A, bought a key, and watched the order deliver via A with a single `a/1 ok` attempt row. It reported **BLOCKED**, logged a gap marker, named the missing call site, and **did not check the task off.**

Without that, slice 2 would have been marked complete with §2.1 unsettled. The ladder demonstrably worked — the out-of-stock path exercises `askFirst`, `fallThrough` and `settleRefused` through a genuinely empty pool — but *"a supplier that refuses"* had never happened, and the slice is named for it.

The fix split the work correctly rather than just moving it:

- **Refusal** injection is this slice's subject. It belongs before the key claim, so a refused call provably claims nothing and writes no ledger row. A refusal has no placement constraint beyond that.
- Only the **hang** placement belongs to slice 3, and for a real reason: a hang must sit **after** the key claim commits, so the ledger holds a code for the re-probe to find. A hang before the claim exercises the re-probe path but not the double-issue trap. Both are worth having, and they are different checks.

Both stubs now consume `fail_next` first, then `failure_rate`, before the claim. `fail_next` before `failure_rate` so that a reviewer who arms both gets the deterministic thing they asked for; and the one-shot is spent by a single atomic conditional statement in I7's shape —

```sql
update "supplier_behaviour"
set "fail_next" = "fail_next" - 1, "updated_at" = now()
where ("supplier_behaviour"."provider" = $1 and "supplier_behaviour"."fail_next" > 0)
returning "hang_next", "hang_ms";
-- 1 row  => THIS call consumes the one-shot. Nobody else can also have consumed it.
-- 0 rows => none left, or no such provider. Fall back to the rate. Not an error.
```

— not a read followed by a write, because `pnpm race` runs four processes and a check-then-act across them arms two refusals where the reviewer asked for one. The same reason the state is in Postgres at all: a reviewer's `PUT` lands in one process, and an in-process flag reaches none of the others.

And the fix was RED-validated by reverting the wiring, which **reproduced the verifier's earlier report exactly** — the same five failures, with supplier B's own assertions staying green throughout. The green half is the specificity signal: a revert that broke everything would have proven only that the tree was broken.

---

## 5. The evidence

Four real OS processes, each an independently started `dist/main.js`, with every HTTP call round-robined across them — arming the supplier through one instance, paying through another, reading the result through a third. That shape is the point: a passing run is evidence that the behaviour row written through instance 1 is actually read by instance 3's stub, which is the property a single-process check cannot touch.

Twenty concurrent `paid` reports across those four processes, against one order:

```
armed A: fail_next = 1
PASS  20 concurrent paid reports across 4 processes all answered 2xx
PASS  order reached delivered — code=LFXC-TNCS-BPCD
PASS  exactly two attempt rows: a/1 failed supplier_rejected | b/2 ok
PASS  exactly one supplier_requests row, recorded against b
PASS  stock accounting: claimed keys = deliveries — claimed=1, deliveries=1
PASS  the armed one-shot was spent — a.fail_next = 0
```

Read the fourth line again: **the ledger row is against `b`, not `a`.** A's refusal is answered *before* the key claim, so A never reaches `SupplierKeyClaimService` and never touches `supplier_requests` at all. There is no row for `req_x_a_1` to find, which is exactly right — nothing was issued under it, so nothing should be recorded under it.

The fifth line is the only assertion in this phase that can actually fail. `deliveries.order_id` UNIQUE (I3) keeps the *shopper* to one key even when the ladder's rules are broken, so "the shopper got exactly one key" is not evidence the ladder behaved. `count(*) FROM supplier_keys WHERE claimed_by_request_id IS NOT NULL` against `count(*) FROM deliveries` is what sees a second key leaving the pool. That is R2, and it is why every test in the suite checks it *in addition to*, never instead of, the delivery and attempt-row shape.

Two more cases in the same suite:

- **Both suppliers refuse** → `delivery_failed`, two attempt rows both `supplier_rejected`, no delivery, and **zero keys claimed** — an injected refusal never reaches the ledger from either side.
- **Nothing armed** → `delivered` via A, one attempt row `a/1 ok`, one delivery, one key. The ordinary path is unchanged.

---

## 6. Two smaller things worth including

### A refactor deleted a tripwire as collateral

Moving the reason-to-status mapping into the ladder removed `transitionForReason` — and with it, without anybody intending to, the `assertNever` over `SupplierIssueErrorReason` that the method had been hosting. The guarantee did not fail; it simply stopped existing, along with the function it lived inside. That is the quiet way a compile-time check dies.

It was reinstated in a different shape, because the value being classified now arrives from the database as `text` rather than as a narrowed union, so a `switch` was no longer the right instrument:

```ts
const reasonMeansAnEmptyShelf = {
  [SupplierIssueErrorReason.OutOfStock]: true,
  [SupplierIssueErrorReason.SupplierRejected]: false,
} as const satisfies Record<SupplierIssueErrorReason, boolean>;
```

`satisfies Record<…>` is what makes it total. I checked that it actually fires, with a throwaway file in `/tmp` that imports the real union from `packages/contracts` and omits one member — the exact state the ladder would be in the moment a third reason is added and nobody updates the table:

```
error TS1360: Type '{ readonly out_of_stock: true; }' does not satisfy
  the expected type 'Record<SupplierIssueErrorReason, boolean>'.
  Property 'supplier_rejected' is missing in type '{ readonly out_of_stock: true; }'
  but required in type 'Record<SupplierIssueErrorReason, boolean>'.
```

The control, with both members present, exits 0. The probe was deleted; nothing of it is in the diff. Without that table the mapping would compare against one string and route every future reason to `delivery_failed` — which *happens to be* §2.4's answer for the two reasons that exist today, and is exactly the kind of accidental agreement that stops being true without anybody noticing.

### A test helper had outgrown its assumption

`cleanupTestOrders` derived exactly one request id per order — `req_{order}_a_1` — because through Phases 1 and 2 that was the only id the shop could ever mint. This slice made it possible for an order to fall through to `req_{order}_b_2`, so a cleaned-up test order left a claimed key that nothing returned to the pool.

It did not surface here. It surfaced later, in an unrelated suite, as:

```
unclaimed = 49, expected 50
```

Now the helper matches `req_{order}_%`, which covers every rung the ladder can mint — including slice 5's `_a_3`. The headline test asserts the pool is back at 50 as its last line, specifically so that this regression cannot return quietly.

This is the second time this phase that a harness assumption produced a correctness-shaped failure somewhere else; the readiness budget in the concurrency support did it too. The pattern is worth naming: helper code accumulates assumptions about what the application can do, and the application changing is exactly when nobody re-reads the helper.

---

## 7. The honest limitation

`supplier_requests.provider` is **written but not yet read.**

The migration added the column with the narrowed read spelled out in its comment:

```sql
SELECT code FROM supplier_requests WHERE request_id = $1 AND provider = $2;
-- 0 rows => THIS supplier has never answered this id.
```

`SupplierKeyClaimService.readLedger` still emits the one-column form:

```ts
.where(eq(supplierRequests.requestId, requestId))
```

and its doc comment still says the predicate arrives "the next task but one in this slice" — a task that has since shipped. The write side is correct: `insert(supplierRequests).values({ requestId, provider, code })` records who answered.

This is defence in depth that is not yet armed, rather than a live defect, and the distinction matters. The ids themselves carry the provider segment, and they are *derived* rather than stored, so a call addressed to B always carries an id with `_b_` in it. A ledger lookup cannot currently be answered with the other supplier's code, because no code path can construct that mismatch. The column exists for the day one does — a hand-run probe, a future third supplier, a refactor that threads a provider through from the wrong place. Saying so now is cheaper than a reviewer finding a comment that describes code that is not there.

---

## 8. Where this sits in the assignment

`context/product/product-definition.md` §1.4's five adversarial scenarios. This slice settles **none** of them outright, and it would be easy and wrong to claim otherwise.

| # | Scenario | Status after this slice |
|---|---|---|
| 1 | 50 parallel `paid` webhooks → one issuance fact, one key | Settled in Phase 1, strengthened in Phase 2. Re-confirmed here at 20 concurrent reports across 4 processes, not extended. |
| 2 | A repeated webhook with the same `event_id` changes nothing | Settled since Phase 1 by the `event_id` PRIMARY KEY. Untouched. |
| 3 | A webhook before its order, or out of order | Settled in Phase 2 slice 3. Untouched. |
| 4 | Empty pool → recoverable → after restock, exactly one key | **Groundwork.** The empty pool now settles `out_of_stock` through the real ladder, with stock accounting asserted. The restock-and-retry half is slices 4–5. |
| 5 | A promo code with limit N under parallel requests | Phase 5. Not started. |

What it does settle is **functional spec §2.1** — a refused main supplier costs the shopper nothing, the backup delivers, the order reads as an ordinary delivery with no mention of which supplier answered, and both suppliers refusing leaves a state a person can act on. That is a requirement, not an adversarial scenario, and the difference is worth keeping straight.

The larger thing it lays down is the identifier rule. Slice 3's whole subject — a timeout is `unknown`, never `failed`; re-ask the same supplier the same question — is only *phrasable* because the id is derived from three arguments and one of them is an attempt number that counts per order. That rule is established here, one slice before the rung that depends on it.

---

## Interview questions this answers

**"Why does the fall-through get a new `request_id` when the retry-after-timeout reuses one? Aren't they both retries?"**
They are two different questions, and the id is what makes them different. A timeout leaves the outcome *unknown* — a key may already have been issued under `req_x_a_1` and we never heard. The only thing that can find out is asking **that same supplier that same question**, because the supplier's ledger answers a repeat with the code it already issued instead of cutting a second one. That requires a byte-identical id. A definite refusal is the opposite: the outcome is known and negative, the supplier's claim transaction committed having written nothing, and the next move is a *new* question to a party that has never heard it. B has no reason to know anything about `req_x_a_1`. So the rule is one rule, not two: the id is `deriveIssuanceRequestId(orderId, provider, attempt)` and the rung picks the three arguments. A re-probe changes none of them; a fall-through changes two.

**"Why derive the id at all? You already store it in `issuance_attempts.request_id` — just read it back."**
You can, and that is the honest version of the objection. The problem is that correctness then depends on every future caller remembering to read it. There are at least four call sites in this phase — the automatic path, the re-probe, the fall-through, the operator retry — and the first one that reaches for `randomUUID()` instead issues a duplicate key with no error anywhere, because the supplier's ledger misses on an id it has never seen and claims a fresh key. Deriving it means there is nothing to remember and nothing to forget: `deriveIssuanceRequestId` is pure and total, so attempt 1 for `ord_x` on provider `a` recomputes to `req_ord_x_a_1` in every process, on every machine, forever. The re-probe is *recomputed*, not remembered.

**"Why is `attempt` numbered per order rather than per supplier? Per supplier seems more natural."**
It reads more naturally in a log and it is wrong, which is the dangerous combination. Take an operator retrying an order after both suppliers definitely refused. Per order, the ladder computes `max(attempt) + 1 = 3` and asks A under `req_x_a_3` — a question nobody has asked. Per supplier, it would compute A's next attempt as 1 and recompute `req_x_a_1`, which is a *settled* id. The reserving insert is `ON CONFLICT (request_id) DO NOTHING`, so that collision is swallowed silently: no error, no log line, and the order can never be re-issued. That is R7, and it is the reason the number is per order.

**"`request_id` is already UNIQUE. What does `UNIQUE (order_id, attempt)` add?"**
They catch different things, which is why both exist. The `request_id` constraint catches two rows carrying the same id *string*. The two-column one catches an `attempt` value that has drifted from the string it appears in, and two rows whose ids differ only in the provider segment. I reproduced it against the running database inside a rolled-back transaction: two rows for one order, both `attempt = 3`, with two different id strings. The `request_id` constraint was satisfied throughout and said nothing; the other raised `duplicate key value violates unique constraint "issuance_attempts_order_id_attempt_key"`, `DETAIL: Key (order_id, attempt)=(ord_proof_unique, 3) already exists.` The three-column version `(order_id, provider, attempt)` was originally proposed and was corrected before the migration was written — it would have accepted both of those rows happily, and `max(attempt) + 1` would then have handed out the number 3 twice.

**"Why do the two suppliers share one key pool? Real suppliers have separate inventory."**
Three reasons, recorded as assumption A4. The fifty keys are the assignment's supplied fixture, so a second pool is inventory the task did not give us. §2.2's conservation check — *"keys that left the stock equals shoppers who received one"* — is one `count(*)` against another rather than a sum, and a sum is somewhere for a mistake to hide. And the ledgers are already disjoint by the provider segment inside the id, so sharing the table buys no ambiguity. The fourth reason is really the first restated: the alternative is the *shop* knowing that its two suppliers share inventory, which is the boundary violation the whole design avoids. The shop never even sends the provider on the wire — each supplier learns which supplier it is from its own mounted path.

**"What does sharing the pool cost you?"**
One wasted call per out-of-stock order, and it is stated up front rather than discovered. An empty pool is the *same* empty pool for both, so A refuses `out_of_stock`, the ladder falls through, and B refuses `out_of_stock` too. Two attempt rows where a naive reader expects one. That is R12; the check asserts exactly two rows so the extra call is a documented expectation rather than something a reviewer reads as the rule misfiring. It is one call, not fifty — the ladder asks each supplier once, not each key. And the order must settle `out_of_stock` rather than `delivery_failed`, because §2.3's second criterion requires the shopper to tell "temporarily out of stock" from "something went wrong": only one of those is fixed by waiting.

**"You added a `supplier_rejected` reason. Why not reuse `out_of_stock`?"**
Because it would be a lie whenever the pool is full, and the lie routes to the wrong order status. A supplier that refuses while fifty keys are sitting there has nothing to do with stock, and telling the shopper to wait for a restock promises them something that fixes nothing. The decision table is over the whole set of refusals rather than the newest one, and it is asymmetric on purpose: `out_of_stock` is the narrow claim — both suppliers looked and the shelf is empty — so one unrecognised or `NULL` reason in the set makes the whole thing `delivery_failed`. The stub answers `422`, never a `5xx`: the supplier answered, and the answer is no. A `5xx` invites redelivery, which is the opposite of a definite refusal.

**"Did anything go wrong in this slice?"**
Yes, and it is the most useful thing in it. The slice was planned with all failure injection deferred to slice 3, which left its own verification unsatisfiable: `fail_next` round-tripped through the control endpoint correctly and nothing read it, so a supplier could not be made to refuse and §2.1's headline scenario was not exercisable. The verifier armed A, bought, watched the order deliver via A with a single `a/1 ok` row, reported BLOCKED, logged a gap marker naming the missing call site, and did not tick the box. Without that the slice ships marked complete with the requirement it is named for unsettled. The fix split the work on a real seam rather than just moving it: refusal injection belongs before the key claim and is this slice's subject; only the *hang* placement belongs to slice 3, because a hang has to sit after the claim commits so the ledger holds a code for the re-probe to find.

**"How do you know the fix works and isn't just green by accident?"**
It was RED-validated by reverting the wiring, which reproduced the verifier's original report exactly — the same five failures, with supplier B's own assertions staying green. The green half is the specificity signal: a revert that broke everything would have proven only that the tree was broken. The forward run is four separate OS processes with twenty concurrent `paid` reports round-robined across them, and it asserts stock accounting — `claimed keys = deliveries` — in addition to the order status, because `deliveries.order_id` UNIQUE keeps the shopper to one key even when the ladder is broken. "The shopper got one key" cannot fail; that is the whole trap.

**"The ladder is a pure function. Isn't that over-engineering for a two-supplier fallback?"**
The rule it encodes is a predicate over recorded rows — *never fall through while any attempt for this order is `unknown`* — and a predicate over rows is testable only by handing it rows. Keeping it pure means the hard rule is exercised with no database, no HTTP and no supplier, and the four-process suite is left to prove the things only four processes can prove. The decision *order* inside it is the enforcement, not a style choice: the outstanding-attempt guard sits above the `fallThrough` branch, so an order with an unresolved attempt cannot reach a fall-through at all. The rule is unrepresentable rather than merely obeyed. And the guard is written as a negation — *not* `ok` and *not* `failed` — rather than `status === 'unknown'`, because `issuance_attempts.status` is `text` with no CHECK, and a row written by a future migration or by `psql` with a fourth status would otherwise satisfy `!== 'unknown'` and unlock a fall-through past an outstanding request.

**"Is anything in this slice not finished?"**
`supplier_requests.provider` is written but not yet read. The migration spelled out the narrowed lookup — `WHERE request_id = $1 AND provider = $2` — and `readLedger` still filters on `request_id` alone, with a doc comment that says the predicate arrives in a task that has since shipped. It is defence in depth that is not yet armed rather than a live defect: the ids carry the provider segment and are derived rather than stored, so no current code path can address a lookup to the wrong supplier. The column is there for the day one can. I would rather name it than leave a comment describing code that is not there.

---

## Source files

- `packages/db/drizzle/0002_issuance_attempt_ledger.sql` — the two-column UNIQUE, why it is not three columns, why every default is dropped, the measurements, and the pre-flight query
- `packages/db/drizzle/0003_supplier_behaviour.sql` — the behaviour table and its seeded rows
- `apps/api/src/issuance/issuance-request-id.ts` — `deriveIssuanceRequestId`, the rejected `randomUUID()`, and why `attempt` is in the id at all if a retry must reuse it
- `apps/api/src/issuance/issuance-ladder.ts` — the pure function, the decision order as enforcement, and `reasonMeansAnEmptyShelf … satisfies Record<…>`
- `apps/api/src/issuance/issuance-history.ts` — the reserving `INSERT … ON CONFLICT (request_id) DO NOTHING` and the read that the new UNIQUE serves
- `apps/api/src/issuance/issuance-runner.service.ts` — the single entry point, and the three transactions none of which spans a supplier call
- `apps/api/src/issuance/supplier.client.ts` — `SupplierAClient` generalised: the provider tag and the config are the only two things that differ
- `apps/api/src/issuance/supplier-issue.errors.ts` — `SupplierDefiniteFailure` vs `SupplierUnknownOutcome`, and why each carries the status it will be recorded as
- `apps/api/src/suppliers/supplier-key-claim.service.ts` — the shared pool, the shared ledger, and the `provider` predicate that is not there yet
- `apps/api/src/suppliers/supplier-behaviour.service.ts` — the atomic one-shot decrement, and why the state is in Postgres
- `apps/api/src/suppliers/a/supplier-a.controller.ts`, `.../b/supplier-b.controller.ts` — refusal consumed **before** the claim, in both stubs
- `apps/api/test/unit/issuance-ladder.test.ts` — the hard rule, exercised with rows and nothing else
- `apps/api/test/concurrency/supplier-refusal-and-recovery.test.ts` — four processes, and its header's account of the BLOCKED report
- `apps/api/test/concurrency/support/db.ts` — `cleanupTestOrders` and the `req_{order}_%` fix
- `context/product/architecture.md` §3, §3.1, §4 — the nine invariants, I5's SQL, and the request-id derivation rule
- `context/spec/003-failure-and-recovery/technical-considerations.md` §1.1, §1.2, §3 (A4), §11 (R2, R7, R12)
- `context/spec/003-failure-and-recovery/functional-spec.md` §2.1, §2.2, §2.3

**On evidence:** the following were run fresh while writing this document, against the tree and the local Postgres container as they stand. `pnpm -r run typecheck` across all four workspace projects — `packages/contracts`, `packages/db`, `apps/api`, `apps/web` — all Done. `vitest run test/unit/` in `apps/api`: **2 files, 15 tests passed**, which is the ladder's hard rule and the Russian-label tripwire. Four queries against the running database: `\d issuance_attempts` showing `issuance_attempts_order_id_attempt_key UNIQUE CONSTRAINT, btree (order_id, attempt)`, both CHECKs, and no `issuance_attempts_order_id_idx`; `\d supplier_requests` showing `provider text not null` with no default; `\d supplier_keys` showing **no provider column**, which is the shared pool as a schema fact; and `select count(*), count(claimed_by_request_id) from supplier_keys` returning `50 | 0`, which is the `cleanupTestOrders` fix confirmed rather than repeated. The `UNIQUE (order_id, attempt)` proof in §2 is my own re-run inside a `BEGIN … ROLLBACK`, and the transcript is that run's actual output; the rollback left nothing behind. The `TS1360` tripwire output in §6 is likewise mine, from a throwaway file in `/tmp` importing the real union from `packages/contracts`, with a two-member control that exits 0; both were deleted. I also read `readLedger` directly to establish §7 rather than taking the doc comment's word for it.

Everything else is reported by other agents in this slice and is **not** re-verified here: the migration's measured timings and the unchanged `relfilenode` pair on the 21 200-attempt fixture, the four-process run and every `PASS` line quoted in §5 including `code=LFXC-TNCS-BPCD`, the both-refuse and empty-pool cases, the original BLOCKED report and its gap marker, and the RED validation that reproduced the five failures with B's assertions staying green.
