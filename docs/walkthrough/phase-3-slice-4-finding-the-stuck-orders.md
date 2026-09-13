# Phase 3 · Slice 4 — Finding the stuck orders

> One screen, one `SELECT`, and two findings that are both about looking in the wrong place.
>
> **The first is a performance finding.** The recovery list is a per-order-latest-row problem, and that is the part everybody argues about — `LEFT JOIN LATERAL` against `DISTINCT ON` against correlated subqueries. Three strategies were measured and they came out within 5 % of each other, because the expensive part was somewhere else entirely: a `paid_at` the shop derives rather than stores, evaluated once per listed row. In one of my own plans the lateral everybody argues about costs **4 996 buffers** and the `paid_at` subquery beside it costs **2 469 012**. Same plan, same run.
>
> **The second is a correctness finding**, and it runs the opposite way. The obvious cleanup — list only the orders that are actually stuck — hides the single class of stuck order nothing else in the shop can see.

---

## 1. What actually shipped

| # | Change | Where |
|---|---|---|
| 1 | `0005_recovery_list_indexes` — `payment_events_paid_order_idx` and `orders_undelivered_idx`, both partial, with the measured before/after in the file | `packages/db/drizzle/`, `packages/db/src/schema/shop.ts` |
| 2 | `UndeliveredOrdersService` — §4's statement, its three silent traps, and the literals-not-`= ANY($1)` departure | `apps/api/src/admin/undelivered-orders.service.ts` |
| 3 | `GET /api/admin/orders/undelivered` behind the existing `AdminTokenGuard`, unchanged | `apps/api/src/admin/order-recovery.controller.ts` |
| 4 | The operator's view at `/admin/recovery` — seven states as a discriminated union, `assertNever`, no client-side route guard | `apps/web/src/pages/admin-recovery/` |
| 5 | `readOrderReason` — three facts rather than one word, so *unknown* cannot collapse into *failed* | `apps/web/src/entities/undelivered-order/lib/attempt-reason.ts` |

The indexes shipped **before** the endpoint, deliberately, so that the endpoint was never the thing that introduced a multi-second scan.

---

## 2. Keystone one — the expensive part was not where everyone looks

### The shop has no `orders.paid_at`, and that is a schema decision, not an oversight

§2.4's fourth criterion asks that the operator see *when it was paid for*. There is no column holding that.

Adding one sounds trivial and is not. Every lifecycle transition in this shop goes through **one generic status-guarded `UPDATE`** that `architecture.md` §3.1 specifies letter for letter — the same statement text for `created → paid` as for `delivering → delivered`, with the source states as a bound list. Writing `paid_at` means putting a `CASE` in that statement's `SET` list, or carving out a per-transition special case in a table whose entire value is that it is *data* rather than code. And it would be a second copy of a fact `payment_events` already holds durably, which makes it the copy that can drift.

So the fact is derived:

```sql
(SELECT min(pe.received_at) FROM payment_events pe
  WHERE pe.order_id = o.id AND pe.status = 'paid')  AS paid_at
```

A correlated subquery, evaluated **once per listed order**. That is the whole of the cost, and it is invisible if you read a plan for row counts.

### The measurement

My own run, this project's Postgres 16.11 container, a 20 000-order fixture (18 334 delivered, 1 666 paid-but-undelivered, 40 000 payment events), the shipped statement verbatim, everything inside a rolled-back transaction.

**With both indexes** — `Execution Time: 11.923 ms`, 17 101 buffers:

```
->  Index Scan using orders_undelivered_idx on orders o (actual rows=1666)
      Buffers: shared hit=3357
->  Limit  (loops=1666)                                 Buffers: shared hit=4996
      ->  Index Scan Backward using issuance_attempts_order_id_attempt_key
            Index Cond: (order_id = o.id)
SubPlan 2 -> Result  (loops=1666)                       Buffers: shared hit=8330
      InitPlan 1 -> Limit -> Index Only Scan using payment_events_paid_order_idx
            Index Cond: ((order_id = o.id) AND (received_at IS NOT NULL))
            Heap Fetches: 3332
```

**Both indexes dropped, same statement, same fixture** — `Execution Time: 6426.043 ms`:

```
->  Limit  (loops=1666)                                 Buffers: shared hit=4996
      ->  Index Scan Backward using issuance_attempts_order_id_attempt_key
SubPlan 1 -> Aggregate  (loops=1666)              Buffers: shared hit=2469012
      ->  Seq Scan on payment_events pe
            Filter: ((order_id = o.id) AND (status = 'paid'))
            Rows Removed by Filter: 39999
```

**Read those two nodes side by side in the second plan.** The lateral — the per-order-latest-row problem, the part every review spends its time on — costs **4 996 buffers**, and it costs exactly 4 996 in both plans because it was never the problem. The `paid_at` subquery beside it costs **2 469 012**. That is 494× the thing next to it, in the same plan, on the same run, and the difference between those two numbers is the entire 6.4 seconds.

`Rows Removed by Filter: 39999` is the sentence in plain form: for each of 1 666 listed orders, Postgres reads all 40 000 payment events and throws away 39 999 of them.

So the finding is not "we added an index and it got faster". The finding is that **three strategies for the per-order-latest-row problem were measured and came out within 5 % of each other**, because all three were carrying the same `payment_events` scan underneath. Optimising the part that looks hard would have bought nothing.

### The absent `Filter` is the proof, not the timing

On the fast plan, `Index Scan using orders_undelivered_idx` carries **no `Index Cond` and no `Filter`**. That absence is what a reviewer should check for, and it is easy to misread as something missing.

`orders_undelivered_idx` is partial on `status IN ('paid','delivering','out_of_stock','delivery_failed')`. Postgres proved the index's predicate implies the query's `WHERE` clause, so it dropped the status test altogether — there is nothing left to filter, because every entry in the index already qualifies. A `Filter: (status = ANY ...)` on that node would mean the exact opposite: the planner failed to prove it and is re-checking every row it reads.

### The trap that defeats it: the status list must be literals

This is the one place in the codebase where its own convention must not be copied. Everywhere else a status list is bound as a single parameter — `WHERE status = ANY($3)` in `OrderTransitionService`, `= ANY($2)` in `OrdersService.findOrder` — so that a statement's text stays stable across `from`-lists of different lengths. Here that costs the index. Measured, my own run, both forms against the same fixture with the index present:

```
literals:
  ->  Index Scan using orders_undelivered_idx on orders o
        (cost=0.28..170.27 rows=1666) (actual rows=1666)
      -- no Index Cond, no Filter

= ANY($1), SET plan_cache_mode = force_generic_plan:
  ->  Seq Scan on orders o  (cost=0.00..659.00 rows=17853) (actual rows=1666)
        Filter: (status = ANY ($1))
        Rows Removed by Filter: 18334
```

Node cost 170 against 659; top-level 799 against 1 361. **Postgres cannot prove that a value it has not been shown implies a partial index's predicate**, and a generic plan is precisely a plan built without the values.

Custom planning rescues this today, because `packages/db/src/client.ts` forbids `.prepare()` and every statement is therefore planned against its actual arguments. But that is a planner heuristic protecting the query, not a property of the query — and the gap between those two is a regression nobody gets an error about. The list is written as literals, and it is not retyped: `undeliveredOrderStatusSqlList` is the very fragment `packages/db` builds the index predicate from, exported so the query and the index are one string rather than two renderings of one array.

### A fixture trap worth knowing before you conclude the index is useless

The first attempt to measure this put the undelivered orders **contiguously at the end of the heap** — the natural thing to do when you generate fixture data, since you insert the normal rows and then the interesting ones. The planner picked `orders_status_idx` instead, and the partial index looked like dead weight.

I reproduced both, same 20 000 rows, same 1 666 results, the only difference being heap layout:

```
CONTIGUOUS heap:  ->  Index Scan using orders_status_idx on orders o        (rows=1666)
SCATTERED  heap:  ->  Index Scan using orders_undelivered_idx on orders o   (rows=1666)
```

Heap access behind *any* index looks sequential when the matching rows are adjacent, so the two indexes cost the same and the planner has no reason to prefer the smaller one. A real shop's stuck orders are scattered through its history. Without knowing this, the next person to measure concludes the index goes unused and deletes it.

### Honest accounting on the second index

`orders_undelivered_idx` is the smaller of the two by a wide margin — a few milliseconds on a query that is already in the tens. Its buffer count even goes *up*, because the plan now reads that index's own pages. It earns its place on size and residency: a partial index holds only the shop's unfinished business, and shrinks as that business is finished. If it were the only change in that migration it would be hard to justify. It is not; `payment_events_paid_order_idx` is.

And there is a caveat written beside it in capitals, because the failure mode is silence: **a partial index whose predicate is a status list must be rebuilt if a later phase adds another undelivered status.** Nothing raises, nothing logs, the query still runs and the index is still chosen — orders in the new status are simply not in it, so they are not returned, and the one screen whose entire purpose is *"nothing that was paid for is invisible"* quietly stops being true. On exactly the orders somebody added a new status for because they were unusual.

---

## 3. Keystone two — "paid but undelivered" is a wider set than "stuck"

### The four statuses, and the one class of order that is otherwise invisible

```sql
WHERE o.status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed')
  AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.order_id = o.id)
```

Two of those four belong to orders that are merely **in flight** and will very likely deliver themselves in the next fifty milliseconds. They are in the list anyway.

Narrowing to `out_of_stock` and `delivery_failed` — the two an operator can actually retry — is the obvious cleanup, and it would make the screen calmer. It would also hide **the one class of stuck order that nothing else can reach**: an order whose worker died between the claim and the outcome write. That order rests in `delivering` for ever, with an attempt row reading `unknown`. It is not in the payment inbox any more. No continuation is scheduled for it. Nothing automatic will ever touch it again. It is precisely the Phase 3 failure mode — the process killed mid-ladder that `phase-3-slice-3-silence-is-not-failure.md` §6 describes as leaving *"an order resting in `delivering` that looks exactly like a slow supplier"*.

If this list does not show it, nothing does.

So the set is *paid, and holding no key* — the in-flight set minus `created` (nobody has paid), plus the recoverable pair. And for the same reason, **there is no time predicate**. `AND o.created_at < now() - interval '5 minutes'` is the other obvious calmer-screen change, and §2.4's second criterion rules it out in as many words: an order must appear immediately, without waiting for any period to elapse. A calm screen that is five minutes behind is worse than a busy screen that is true.

### Retry eligibility is a separate, narrower question

The list being wide does not make every row actionable, and the design keeps those two ideas apart rather than blurring them:

- the model type is named **`UndeliveredOrder`**, not `StuckOrder`;
- `retryable` is `isRecoverableOrderStatus(status)` and is documented as **advisory** — neither end treats it as authority;
- an in-flight row shows "in progress" where the button would be;
- and the actual authority is slice 5's status-guarded `UPDATE`, which matches zero rows or one.

The report is a **snapshot, not a lease.** By the time it reaches the screen an order listed as `delivering` may already be `delivered`, and nothing in the response claims otherwise.

### Three traps in the statement, each of which fails silently

Every one of them produces a plausible screen. None produces an error. All three counts below are my own, on my own fixture of 1 666 paid-but-undelivered orders.

**1. `LEFT JOIN LATERAL … LIMIT 1`, and neither of its two neighbours.**

```
LEFT  JOIN LATERAL … LIMIT 1  ->  1666 rows   (correct)
CROSS JOIN LATERAL … LIMIT 1  ->  1664 rows   (2 orders silently dropped)
plain LEFT JOIN issuance_attempts -> 2081 rows (415 orders duplicated)
```

`CROSS JOIN LATERAL` is the natural thing to write, and it drops every order with **no attempt row at all** — which are orders that were paid for and never offered to a supplier. Those are not the boring rows on this screen, they are the most alarming ones: an order the shop has *forgotten* rather than one it is failing at. A `CROSS` makes exactly those invisible, and reports a plausible-looking list of everything else.

The plain `LEFT JOIN` fails the other way: the operator sees the same stuck order two or three times and presses retry on each.

So: `LEFT`, so an order with no attempts survives; `LATERAL`, so the subquery can correlate on `o.id`; `LIMIT 1`, so it cannot multiply.

There is a third ordering detail inside the lateral: `ORDER BY ia.attempt DESC`, never `created_at DESC`. `created_at` defaults to `now()`, which in Postgres is **transaction-start time**, so two attempt rows written in one transaction carry an identical timestamp and `LIMIT 1` picks between them arbitrarily — differently between runs of the same query. `attempt` is a total order with no ties, guaranteed by `UNIQUE (order_id, attempt)`, which is also the index the lateral scans backwards.

**2. `NOT EXISTS` on `deliveries` is not redundant with the status filter.**

It reads redundant: a delivered order is `delivered`, and `delivered` is not in the status list. It is not redundant, because `issuance.service.ts` has a **live path** that leaves a delivered order reading `delivering` — the delivery row is committed while the `delivering → delivered` guard matches zero rows, because another worker got there first. That is its `Unresolved` report: *a key is bound but the order did not reach delivered*.

Exercised for real rather than argued. I constructed an order in exactly that state — status `delivering`, with a genuine `deliveries` row:

```
status filter alone ............. 1667
with NOT EXISTS ................. 1666
the Unresolved row, listed? ..... 0
```

Without that predicate the operator is shown an order whose shopper is already holding their key, and retrying it is the one action guaranteed to be pointless.

**3. The status list as literals** — §2 above.

### `outstanding_request_id`, and the ladder invariant it rests on

§2.4's fourth criterion asks the operator to see *what went wrong*. On an order whose supplier went quiet, **nothing definite ever went wrong**, and there is nothing truthful to put in a reason column — `last_error` is `NULL`, correctly, because no supplier ever said anything.

`outstanding_request_id` is what makes that state readable without opening `psql`: a supplier was asked, the shop never learned the answer, a key may or may not exist under this id, and **the only thing that can still find out is this id, asked again**. It is the field that turns *"never established"* from a gap into a fact.

One dependency in it is worth stating rather than assuming. §8 asks for *"the newest attempt whose status is `unknown`"*. The service reads *"the newest attempt, if it is `unknown`"*. Those are the same row **only because of the ladder**: `settleNeverEstablished` outranks `fallThrough` in the decision order, so an outstanding attempt blocks the creation of the next one, so an `unknown` row is always the highest `attempt` for its order.

That is a real dependency on another module's policy. If the ladder were ever changed to fall through past an outstanding attempt, this field would start reading `null` on exactly the orders it exists for — and the assertion that catches that change is stock accounting (`count(*) FROM supplier_keys WHERE claimed_by_request_id IS NOT NULL` against `count(*) FROM deliveries`), not anything on this screen. Which is the same lesson slice 3 §4 records: the assertion that catches a broken ladder is never the one about the shopper.

### The reason column must not collapse *unknown* into *failed*

This is a one-character bug that type-checks:

```ts
reason: order.lastError ?? "failed"      // ← wrong
```

`lastError` is `NULL` on two completely different outcomes — a supplier that answered *ok*, and a supplier that **never answered at all**. The second is the entire subject of §2.2, whose fourth criterion is that the record *"shows the outcome was never established, rather than showing it as failed"*.

The recovery screen is the **only place a person ever reviews that record.** So the criterion is met or broken here, by this cell — and a `??` with a friendly-looking default would break it while every test in the repository stayed green, because nothing else in the shop reads this field.

The defence is not a careful `if`. `readOrderReason` returns **three independent facts** rather than one word — `definiteFailure`, `neverEstablishedRequestId`, `hasBeenAttempted` — all of which can be present or absent independently, and two of which can be true at once (an older attempt left `unknown`, a newer one definitely refused). There is no slot for a default to be substituted into, because there is no single slot. The same shape of argument as slice 3's branch ordering: make the mistake unrepresentable rather than forbidden.

The strings it returns are the **supplier's own words**, rendered raw in a `<code>`. The shop has no dictionary of supplier reasons and must not pretend to: translating an unrecognised string into one of the few this codebase happens to know turns a true record into a plausible one.

---

## 4. Also worth including

**A bug that only real data could find.** Drizzle's node-postgres driver overrides pg's own timestamp parsers so that every date arrives as a raw Postgres string and each column's `mapFromDriverValue` decodes it. That makes a bare `sql<Date>` fragment a lie the compiler cannot catch — it type-checks, and then hands back a string. Reproduced against the live database while writing this:

```
bare  sql<Date>      -> string "2026-09-11 12:58:49.659965+00"
  .toISOString()     -> THREW: TypeError: bare[0].v.toISOString is not a function
with .mapWith()      -> Date -> 2026-09-11T12:58:49.659Z
```

It surfaced as a `500` on the first order that had a `paid` event, which is to say: **an empty database would never have caught it**, and neither would any fixture without a payment event. The fix is `.mapWith(paymentEvents.receivedAt)` — naming the column the value comes from borrows exactly the decoder that column would have used. A sweep found the only other two `sql<Date>` sites in the API are `sql<Date>\`now()\`` inside `OrdersService`'s `INSERT … SELECT` projection: write-side, values going *into* Postgres and never decoded on the way back, so the hole cannot fire there.

**The integration nobody had run.** The operator's view was built *before* the endpoint, against the spec's prose, so it had to invent two things the spec left open — the name of the top-level array, and the fields of an attempt entry. Those were pinned into §8 as a blockquote and the endpoint was built against them. Verification then drove the real view against the real API and they agreed on every field, first time — no `error` state. That matters because the view **parses strictly**, throwing `UndeliveredOrdersResponseError` naming the exact path of anything it does not recognise. A green run is the only way to know the two ends genuinely match, rather than merely having been written against the same paragraph.

**No client-side route guard, deliberately.** `/admin/recovery` renders for anybody. A check the browser makes is a check the browser can be told to skip, so it is not security, it is decoration that looks like security. Every byte of data on the page comes from behind `AdminTokenGuard`, and §2.4's last criterion was checked by calling the endpoint — `401` with no token, `401` with a wrong one, `503` with `ADMIN_TOKEN` unset — never by inspecting the DOM.

The page mirrors the guard's three answers rather than collapsing them, and the two refusals have genuinely different remedies: `401` shows the token form again, because a different token is exactly what would help; `503` shows **no form at all**, because pasting cannot help and offering the field anyway would have an operator working through their password manager during an incident whose fix is a deploy.

**Token in `sessionStorage` — the opposite choice from `purchase-intent.ts`'s `localStorage`,** and the reasoning inverts cleanly. There the requirement was that two tabs share a value; here it is the reverse. Never `VITE_ADMIN_TOKEN`: the admin page and the storefront are one bundle, so a build-time token ships to every shopper.

**`empty` is a state, not an empty list.** Rendering a zero-row `<table>` satisfies the letter of "the list loaded" and fails §2.4's fifth criterion outright — a table with headers and no rows is indistinguishable from a list that failed to load, and the operator's next move is to reload a page that was already telling them the truth. The API says it in words (`"Nothing to recover: every paid order is holding a key."`) and the page prefers that sentence to its own fallback, so the API can say something more specific than "empty" when it knows something more specific.

---

## 5. Where this sits in the assignment

This slice settles **functional spec §2.4**, all six criteria:

| Criterion | Settled by |
|---|---|
| Every paid-but-undelivered order appears | the four-status set, wider than "stuck" (A5) |
| Present immediately, no waiting period | no time predicate, deliberately |
| A delivered order is not in it | the status filter **and** `NOT EXISTS` on `deliveries` |
| What was bought, when paid, what went wrong | `product_name` / derived `paid_at` / the three facts of `readOrderReason` |
| Nothing to recover is said in words | the report's own `message`, and `empty` as a distinct view state |
| Without operator credentials, refused | `AdminTokenGuard`, unchanged — `401`/`401`/`503` |

Against `product-definition.md` §1.4's five adversarial scenarios it settles **none** outright, and it is worth being exact about that:

| # | Scenario | Status after this slice |
|---|---|---|
| 1 | 50 parallel `paid` webhooks → one issuance fact, one key | Settled in Phase 1, strengthened in Phase 2. Untouched. |
| 2 | A repeated webhook with the same `event_id` changes nothing | Settled since Phase 1. Untouched. |
| 3 | A webhook before its order, or out of order | Settled in Phase 2 slice 3. Untouched. |
| 4 | Empty pool → recoverable → after restock, exactly one key | **The operator's half.** This slice is how a person *finds* such an order. The retry that pushes it through is slice 5. |
| 5 | A promo code with limit N under parallel requests | Phase 5. Not started. |

The honest summary: scenario 4 needs somebody to see the order and somebody to act on it. This is the first half, and it is the half with no moving parts.

---

## Interview questions this answers

**"You added an index and the query got 500× faster. What was actually slow?"**
Not the part I expected, and that is the finding. The list is a per-order-latest-row problem — *the newest issuance attempt per order* — so that is where the optimisation effort naturally goes. Three strategies were measured for it: `LEFT JOIN LATERAL … LIMIT 1`, `DISTINCT ON`, and five correlated subqueries. The first two came out within 5 % of each other, because all of them were carrying the same cost underneath. It was `paid_at` — a correlated subquery over `payment_events`, evaluated once per listed order. In my own plan with the indexes dropped, the lateral node costs 4 996 buffers and the `paid_at` node beside it costs 2 469 012. Same plan, same run. The subquery node reported `Rows Removed by Filter: 39999`, which is the thing in one line: for each of 1 666 listed orders, read all 40 000 payment events and throw away 39 999. It is invisible if you read the plan for row counts, because the row counts all look fine — you only see it in `Buffers`.

**"Why is `paid_at` derived at all? Why not a column?"**
Because every lifecycle transition in this shop goes through one generic status-guarded `UPDATE` whose whole value is that it is the *same statement* for every transition — the source states are data, not code. Writing `orders.paid_at` means a `CASE` in that statement's `SET` list, or a per-transition special case in the one table designed to have none. And it would be a second copy of a fact `payment_events` already holds durably, which makes it the copy that drifts. So it is derived, and the index is what makes deriving it free — `InitPlan → Limit → Index Only Scan` instead of a sequential scan per row, because the index is on `(order_id, received_at)` and Postgres rewrites `min()` over an indexed column into "read the first row of an ordered scan and stop".

**"How do you know the partial index is actually being used?"**
By the absence of a `Filter`, not by the timing. On the fast plan the node reads `Index Scan using orders_undelivered_idx on orders o` with no `Index Cond` and no `Filter` at all, which looks like something is missing and is the opposite: the planner proved the index's partial predicate implies the query's `WHERE` clause, so there is nothing left to test — every entry in the index already qualifies. A `Filter: (status = ANY ...)` on that node would mean the proof failed and it is re-checking every row. That is also why I'd distrust a timing-only check here; on a warm cache both plans can look acceptable on a small table.

**"Your codebase binds status lists as `= ANY($n)` everywhere. Why are they literals in this one query?"**
Because a bound parameter defeats the partial index, and I measured it: literals give `Index Scan using orders_undelivered_idx`, node cost 170; `= ANY($1)` under `force_generic_plan` gives `Seq Scan on orders`, `Filter: (status = ANY ($1))`, `Rows Removed by Filter: 18334`, node cost 659. Postgres cannot prove that a value it has not been shown implies a partial index's predicate, and a generic plan is exactly a plan built without the values. Custom planning rescues it today because `client.ts` forbids `.prepare()` — but that is a planner heuristic protecting the query, not a property of the query, and I'd rather not stake the operator's only screen on a heuristic. The convention it departs from exists so statement text stays stable across `from`-lists of different lengths, and there is no partial index there for a parameter to hide a predicate from. The list is not retyped either: the query embeds the very SQL fragment the index predicate is built from.

**"Is there anything about how you generated fixture data that changed the answer?"**
Yes, and it nearly cost the index. If the undelivered orders sit contiguously at the end of the heap — which is what you get naturally, inserting the normal rows and then the interesting ones — the planner picks the full `orders_status_idx` instead, because heap access behind any index looks sequential when the matching rows are adjacent, so the two indexes cost the same. I reproduced both on the same 20 000 rows returning the same 1 666 results: contiguous picks `orders_status_idx`, scattered picks `orders_undelivered_idx`. A real shop's stuck orders are scattered through its history. Without knowing that, the next person to measure concludes the partial index goes unused and deletes it.

**"Why does the list include orders that are merely in flight? Isn't that noise?"**
It is noise, and it is deliberate. Restricting to the two retryable statuses is the obvious cleanup and it hides the single class of stuck order that nothing else can reach: an order whose worker died between the claim and the outcome write. It rests in `delivering` for ever with an attempt row saying `unknown` — it is not in the payment inbox any more, no continuation is scheduled for it, nothing automatic will touch it again. That is precisely the Phase 3 failure mode, the function killed mid-ladder. If this list does not show it, nothing does. Retry *eligibility* is a separate and narrower question, answered by slice 5's status-guarded `UPDATE` matching zero rows or one — so the model type is `UndeliveredOrder` rather than `StuckOrder`, `retryable` is documented as advisory, and an in-flight row shows "in progress" where the button would be. And for the same reason there is no `created_at < now() - interval '5 minutes'`: §2.4's second criterion requires an order to appear immediately. A calm screen five minutes behind is worse than a busy screen that is true.

**"`NOT EXISTS` on `deliveries` — isn't that redundant with the status filter?"**
It reads redundant and it is not. `issuance.service.ts` has a live path that leaves a *delivered* order reading `delivering`: the delivery row commits while the `delivering → delivered` guard matches zero rows, because another worker got there first. That is its `Unresolved` report — a key is bound but the order did not reach `delivered`. I constructed an order in exactly that state, status `delivering` with a genuine `deliveries` row, and confirmed it is excluded: 1 667 rows on the status filter alone, 1 666 with the predicate, and the constructed row listed zero times. Without it the operator is shown an order whose shopper is already holding their key, and retrying it is the one action guaranteed to be pointless.

**"What's wrong with `CROSS JOIN LATERAL` here? It's shorter."**
It silently drops every order with no attempt row — measured on my fixture, 1 666 becomes 1 664. And those are not the boring rows. An order with no attempt row was paid for and **never offered to a supplier at all**: the shop has forgotten it rather than failed at it, which makes it the most alarming row on the screen and the one a `CROSS` makes invisible. The failure produces no error and a completely plausible list of everything else. The other neighbour fails the opposite way: a plain `LEFT JOIN issuance_attempts` multiplies the outer row — 2 081 rows for 1 666 orders on my fixture — so the operator sees the same stuck order two or three times and presses retry on each. `LEFT` so an order with no attempts survives, `LATERAL` so the subquery can correlate, `LIMIT 1` so it cannot multiply. And inside it, `ORDER BY attempt DESC` rather than `created_at DESC`, because `created_at` defaults to `now()` — transaction-start time — so two rows written in one transaction tie and `LIMIT 1` picks between them differently between runs.

**"An order whose supplier went silent — what does the operator actually see? There's no error message."**
There is no error message because nothing definite went wrong, and that is the point §2.2's fourth criterion turns on: the record must show the outcome was *never established*, not show it as *failed*. So the screen shows `outstanding_request_id` — the id of the request whose answer never came. A key may or may not exist under it, and the only thing that can still find out is that id, asked again of the same supplier. The bug I was guarding against is one character long: `order.lastError ?? "failed"`. It type-checks, and it is wrong because `lastError` is `NULL` on two completely different outcomes — a supplier that said *ok*, and a supplier that never answered. This screen is the only place a person ever reviews that record, so the criterion is met or broken by this one cell, and a friendly-looking default would break it while every test in the repository stayed green. The defence is that the module deals in three independent facts rather than one word — a definite failure, an unestablished request id, and whether any supplier was asked at all — so there is no single slot for a default to be substituted into.

**"That `outstanding_request_id` reads the newest attempt. What if the newest attempt isn't the unknown one?"**
It cannot be, and the reason is in another file, which is why I state the dependency rather than assume it. `settleNeverEstablished` outranks `fallThrough` in the ladder's decision order, so an outstanding attempt blocks the creation of the next one — that is the hard rule slice 3 turns on. An `unknown` row is therefore always the highest `attempt` for its order, and "the newest `unknown`" and "the newest, if it is `unknown`" cannot disagree. If the ladder were ever changed to fall through past an outstanding attempt, this field would start reading `null` on exactly the orders it exists for. The assertion that catches that change is stock accounting — claimed keys against deliveries — not anything on this screen.

**"Did having real data catch anything a fixture wouldn't have?"**
One bug, and it is a good argument for not testing against an empty database. Drizzle's node-postgres driver overrides pg's timestamp parsers so every date arrives as a raw string and each column's own mapper decodes it. That makes a bare `sql<Date>` fragment a lie the compiler cannot catch: it type-checks, and then `paid_at` comes back as `'2026-09-11 12:58:49.659965+00'`, whose `.toISOString` is not a function. It surfaced as a `500` on the first order that had a `paid` event — so an empty database, or any fixture without payment events, sails straight past it. The fix names the column the value comes from, `.mapWith(paymentEvents.receivedAt)`, which borrows exactly the decoder that column would have used. I swept the other `sql<Date>` sites: both are `now()` inside an `INSERT … SELECT` projection, write-side, never decoded on the way back, so the hole cannot fire there.

**"Why no login check on the admin page itself?"**
Because a check the browser makes is a check the browser can be told to skip — it is decoration that looks like security, and the worse failure is that it makes people think the page is protected. `/admin/recovery` renders for anybody; every byte of data on it comes from behind `AdminTokenGuard`. §2.4's last criterion was verified by calling the endpoint — `401` with no token, `401` with a wrong one, `503` with `ADMIN_TOKEN` unset — never by inspecting the DOM. The page does mirror the guard's three answers rather than collapsing them, because the two refusals have different remedies: `401` shows the token form again, `503` shows no form at all, since pasting cannot help when the admin surface is off on this deployment. The token lives in `sessionStorage` — deliberately the opposite of `purchase-intent.ts`'s `localStorage`, where the requirement was that two tabs share a value and here it is the reverse — and never in `VITE_ADMIN_TOKEN`, because the admin page and the storefront are one bundle and a build-time token ships to every shopper.

**"What does this slice settle in the assignment, honestly?"**
Functional spec §2.4, all six criteria. Of the five adversarial scenarios, none outright. It is the operator's half of scenario 4 — empty pool, restock, recover — and it is the half with no moving parts: finding the order. The retry that pushes it through is slice 5, and that is where the concurrency argument lives.

---

## Source files

- `apps/api/src/admin/undelivered-orders.service.ts` — the statement, the three silent traps, the literals-versus-`= ANY($1)` argument, `outstanding_request_id` and the ladder invariant it rests on, and the `.mapWith` note
- `apps/api/src/admin/undelivered-orders.types.ts` — the wire shape, why `status` is a plain `string` and not a union, and why there is nowhere to put a key
- `apps/api/src/admin/order-recovery.controller.ts` — why `GET` here when the sweep beside it is `POST`, and the guard as the whole of §2.4's last criterion
- `packages/db/drizzle/0005_recovery_list_indexes.sql` — both indexes, the measured before/after, the partial-predicate soundness argument, and the capitalised caveat about adding a status
- `packages/db/src/schema/shop.ts` — `undeliveredOrderStatuses` and the exported `undeliveredOrderStatusSqlList` the index predicate and the query are both built from
- `apps/web/src/entities/undelivered-order/lib/attempt-reason.ts` — three facts rather than one word, and the one-character bug it exists to prevent
- `apps/web/src/pages/admin-recovery/model/view-state.ts` — the seven states, why not three booleans, and the `401`/`503` split
- `context/spec/003-failure-and-recovery/technical-considerations.md` §3 (Rejected: `orders.paid_at`), §4 (the query, A5, the strategy table), §5 (the indexes), §8 (the wire shape)
- `context/spec/003-failure-and-recovery/functional-spec.md` §2.4
- `docs/walkthrough/phase-3-slice-3-silence-is-not-failure.md` — the `unknown` state this screen has to render honestly, and the ladder ordering `outstanding_request_id` depends on

**On evidence:** the following were run fresh while writing this document, against the tree and the local Postgres container as they stand. `pnpm -r run typecheck` across all four workspace projects — `packages/contracts`, `packages/db`, `apps/api`, `apps/web` — all Done. `vitest run test/unit/` in `apps/api`: **2 files, 23 tests passed** in 398 ms. Against the running database I confirmed both indexes exist with the predicates the migration claims (`orders_undelivered_idx btree (created_at) WHERE status = ANY (ARRAY['paid','delivering','out_of_stock','delivery_failed'])`, `payment_events_paid_order_idx btree (order_id, received_at) WHERE status = 'paid'`). **Every number in §2 and §3 is my own**, from a fixture I built and rolled back: 20 000 orders / 18 334 deliveries / 40 000 payment events / 20 413 issuance attempts, leaving 1 666 paid-but-undelivered, scattered through the heap. With both indexes, `Execution Time: 11.923 ms`; with both dropped in the same transaction, `6426.043 ms` (and `5877.911 ms` on a separate run of the identical script), with `SubPlan 1 → Aggregate → Seq Scan on payment_events` at **2 469 012 buffers** and `Rows Removed by Filter: 39999` against the lateral's 4 996 buffers in the same plan. The literals-versus-`= ANY($1)` comparison is mine, under `SET plan_cache_mode = force_generic_plan`, giving node costs 170.27 and 659.00 and `Rows Removed by Filter: 18334`. The three trap counts (1666 / 1664 / 2081) are mine on that fixture. The `NOT EXISTS` check is mine, with an order in the `Unresolved` state constructed by hand: 1667 → 1666, the constructed row listed zero times. The contiguous-versus-scattered planner flip is mine, two fixtures of the same 20 000 rows returning the same 1 666 results. The Drizzle timestamp transcript in §4 is my own run against the live database through the real `@game-shop/db` client, and the `sql<Date>` sweep is my own `grep`. Every fixture was rolled back or deleted and the database is back to 0 orders, 0 payment events, 0 deliveries; the temporary scripts are deleted and `git status` shows no files added by this work.

Not re-verified here and reported by other agents in this slice: the original migration measurements and every absolute number quoted from `0005_recovery_list_indexes.sql` and technical-considerations §5 (1 723.8 ms → 12.7 ms → 8.7 ms, the 443 383 / 10 627 / 11 465 buffer counts, the 3 832.679 ms and 1 255 215-buffer re-run, the index build times, and both readings of index size); the three-strategy comparison including `DISTINCT ON` at 1 713 ms and the five-subquery form at 2 820 ms; the 1 599 / 1 596 / 3 198 row counts from the spec's own fixture, which my numbers reproduce in shape on a fixture of my own rather than in absolute value; the live browser verification of the seven view states and the screenshots under `docs/screenshots/`; the view-against-API field agreement on the first run; the `401` / `401` / `503` endpoint checks; the `500` that the `sql<Date>` hole produced before it was fixed; and the check that the `delivering`/`unknown` row's rendered text contains no occurrence of "failed".
