# Phase 2 · Slice 3 — A payment reported before its order still delivers

> Settles functional spec 002 §2.3 and the assignment's third adversarial scenario: *«вебхук пришёл раньше, чем создан заказ»*.
>
> Phase 1 stored such an event correctly. Nothing applied it. This slice is the difference between **durable** and **reachable**.

---

## 1. The decision that made this survivable was made in Phase 1, before any code needed it

`payment_events.order_id` has no foreign key. `deliveries.order_id` and `issuance_attempts.order_id` do. That asymmetry is the whole reason this slice was buildable at all, and it was written into migration `0000_init.sql` long before anything drained anything.

The rule behind it is **who can write this row before the order exists**. A delivery row can only ever be written by code that has already read and advanced the order — a dangling reference there is a genuine bug and refusing it is right. A payment event is written by a stranger. The shopper's `POST /api/orders` and the provider's webhook are separate connections, in separate processes, with no ordering guarantee between them. There is no mechanism that makes one land first, and there never will be.

The demonstration, run inside a transaction and rolled back:

```
BEGIN
-- 1. early event into payment_events (no FK)
    event_id     |        order_id        | processed_at
-----------------+------------------------+--------------
 evt_early_probe | ord_does_not_exist_yet |
(1 row)
INSERT 0 1

-- 2. the provider's redelivery of the same event
 event_id
----------
(0 rows)
INSERT 0 0

-- 3. the identical early write against a table that DOES carry the FK
ERROR:  insert or update on table "deliveries" violates foreign key constraint
        "deliveries_order_id_orders_id_fk"
DETAIL:  Key (order_id)=(ord_does_not_exist_yet) is not present in table "orders".
ROLLBACK
```

And the schema itself, the cheapest way to see the omission is real:

```
Indexes:
    "payment_events_pkey" PRIMARY KEY, btree (event_id)
    "payment_events_unprocessed_order_idx" btree (order_id) WHERE processed_at IS NULL
```

No `Foreign-key constraints:` block. `deliveries` has one.

**What the omission bought:** the early event is *stored*, with `processed_at` NULL, and the endpoint answers `200`. It is a normal path.

**What the "helpful" fix would have cost.** Trace it, because the damage is several steps away from the change:

1. A reviewer adds `REFERENCES orders(id)` to `payment_events.order_id`, reasoning that a dangling id is obviously wrong.
2. The next early webhook raises the error above inside the insert.
3. The webhook endpoint has nothing sensible to do with it and returns `5xx`.
4. **A payment provider retries on `5xx`.** That is what `5xx` means to it — the shop is asking to be told again.
5. The order still does not exist a hundred milliseconds later, so the retry raises too. And the one after that.
6. You now have a retry storm, escalating provider alerts, and an on-call incident — produced by an event that was **a few milliseconds early**.

The FK converts a race that costs nothing into a self-inflicted outage. Slice-1 §4 states this and both the schema file and the migration carry a boxed `DO NOT FIX THIS` comment, with the two real FKs ten lines away so the absence cannot read as forgetfulness.

The general shape is worth naming, because it recurs: **a constraint is a statement about what rows may exist, and it is retroactive.** Adding one is never a local change — it is a change to what every writer, including writers that do not exist yet, is permitted to do. The FK is not "extra safety"; it is a decision about how the shop behaves when a stranger is early.

---

## 2. Storing an event correctly is not the same as handling it

This is the precise gap Slice 3 closes, and it is worth being exact because the two look similar from outside.

Phase 1 delivered the *storage* half completely:

- the event is written verbatim,
- `processed_at` is NULL,
- it is in the partial index `payment_events_unprocessed_order_idx`,
- the endpoint answers `200`, so the provider stops retrying,
- a redelivery of the same `event_id` returns zero rows and is acknowledged as "already seen".

Every one of those is correct and none of them delivers a key. The row sat there. Nothing came back for it. Functional spec §2.3's criterion reads: *"…then the payment is applied to it and the shopper receives their key **without taking any further action**."* Phase 1 satisfied every word up to those last five.

Said plainly: **Phase 1 made the event durable; Slice 3 made it *reachable*.** A durable queue with no consumer is a log file with ambitions.

There is a smaller point inside this that an interviewer may press on. Phase 1 was not lazy in leaving the row pending; leaving it pending was the *only correct answer available* at the time. The processor's outcome table says so explicitly — `deferred_order_missing` maps to `settled: false`:

```ts
const outcomeSettlesTheEvent = {
  [ProcessPaymentEventOutcome.Applied]: true,
  [ProcessPaymentEventOutcome.NoOp]: true,
  [ProcessPaymentEventOutcome.UnknownStatus]: true,
  [ProcessPaymentEventOutcome.Delivered]: true,
  [ProcessPaymentEventOutcome.OutOfStock]: true,
  [ProcessPaymentEventOutcome.DeferredOrderMissing]: false,
  [ProcessPaymentEventOutcome.IssuanceClaimed]: false,
  [ProcessPaymentEventOutcome.DeferredOrderInFlight]: false,
} as const satisfies Record<ProcessPaymentEventOutcome, boolean>;
```

Note `UnknownStatus: true` sitting next to `DeferredOrderMissing: false`. An event naming a lifecycle status the shop has no move for is **settled**, because no future drain will know any more than this one did — leaving it pending would poison the queue forever. An event whose order does not exist yet is **not** settled, because a future drain genuinely will know more.

That is the difference between *"I cannot handle this"* and *"I cannot handle this **yet**"*, and the table is where it is written down once instead of at eight `return` sites. The `satisfies` clause makes it total: adding a ninth outcome without classifying it stops the build.

---

## 3. Why four triggers rather than one

Each of the first three is attached to *something happening*, and that attachment is simultaneously what makes it useful and what makes it insufficient.

| Trigger | Fires when | Therefore cannot fire when |
|---|---|---|
| 1. webhook continuation (`waitUntil` / tracked scheduler) | a webhook arrives *and* the process survives long enough to finish | `SIGTERM` between the `200` and the work; a frozen serverless instance; a `waitUntil` that never ran |
| 2. order creation drain | the order is created **after** the event arrived | the event arrives *after* the order — nothing is waiting at creation time |
| 3. order status poll drain | a shopper has that order's page open | nobody is looking — closed tab, backgrounded mobile, email link not clicked yet |
| 4. **admin sweep** | an operator asks | — |

Trigger 4 requires nothing. That is not a weaker property; it is the *only* property that makes the set closed.

**The concrete case only the sweep can catch.** Compose the three gaps, which is not exotic:

A shopper pays, closes the tab immediately, and the API instance handling the webhook is recycled between sending `200` and running the continuation. Trigger 1 is gone with the process. Trigger 2 cannot help — the order was created minutes ago, long before the event, so creation's drain ran against an empty queue. Trigger 3 cannot help — nobody has the page open, and nobody will, because the shopper is waiting for an email. The `payment_events` row sits with `processed_at` NULL. **The shopper's money is taken and no key exists**, and every automatic mechanism has legitimately already run and legitimately found nothing to do.

That is the order the sweep exists for. `POST /api/admin/payment-events/sweep` is the operator's answer to *"someone says they paid and got nothing"*, and its claim is architecture §3.1's statement letter for letter — the sweep is the caller that form was written for, because it is the only one with no `order_id` to add:

```sql
SELECT * FROM payment_events
WHERE processed_at IS NULL
ORDER BY received_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
-- 0 rows => nothing pending, OR every pending row is held by another worker.
--           Both mean "not my work". NEITHER IS AN ERROR.
```

There is also a second, quieter job. Phase 1 deliberately left nineteen rows pending — every losing copy of a contested `paid` event. A caller that loses the claim cannot establish whether anyone else is still working on that order, so it cannot settle the row honestly. The sweep re-examines each one later, finds the order now `delivered`, and settles it as `no_op`. That is housekeeping no shopper-facing trigger should be doing.

The layering is also what makes each individual trigger *allowed to be cheap*. Because no single one is load-bearing, trigger 2 can decline to retry, trigger 3 can be gated, and losing an in-process notification can be a latency cost rather than a correctness cost. One trigger doing all the work would have to be paranoid; four cooperating ones can each be simple.

---

## 4. The verification found the argument's own proof by accident

This is the part to lead with in an interview.

The verifier could not stage "webhook before order" deterministically, because order ids are exclusively server-generated (`newOrderId()`, and `POST /api/orders` accepts only `{sku}`), so a script cannot pre-choose the id it sends a webhook for. So they drove it as a **genuine race** — fire the webhook and the order creation at the same instant and see which lands first — and won it on the first of three attempts.

Here is what the winning run actually did. The event landed first and was stored pending, correctly. The order was then created. **Trigger 2 ran and missed it.** The order sat in `created` with the event still pending, unchanged, two seconds later. Then the shopper's page polled, trigger 3's gate came back true, and the status poll drain applied the event and issued the key.

Why the miss is not a bug: `OrdersService.createOrder` calls `this.orderCreated.notify(created.id)` immediately after the INSERT resolves, and the listener *schedules* a drain. In a race that tight, the drain's claim can execute in the window where the event row's own webhook continuation is still holding it — `SKIP LOCKED` steps over a locked row and returns zero, which the code reports as `queue_empty` at `debug`, because it means "not my work" and not "something is wrong". The continuation then died or lost its race, and the event went back to being pending with nobody assigned to it.

**Why this is stronger evidence than a test that passes.** A green test tells you the mechanism worked *on the path the test drove*. It cannot tell you what happens when that path does not fire, because a test that exercises the fallback has to *simulate* the primary failing — and a simulated failure only proves the fallback works against the failure you imagined.

What happened here is different in kind. The primary trigger failed **for a reason nobody wrote down in advance**, under real concurrency, and the shopper still got their key. That is not a demonstration of the design; it is the design being *used*. The header comment on `order-created-notifier.service.ts` had already staked the claim in the abstract:

> **losing a notification costs latency and never a key.** … Drop this one and the shopper's key arrives on their next status poll instead of a few milliseconds after creation. Nothing is lost; something is late.

The verification run is that sentence happening. Latency: about two seconds. Keys lost: zero.

And the reason it reads as evidence rather than as an anecdote is that the two triggers write **different log lines on purpose** — `"order creation drain: …"` versus `"order status poll drain: applied events the shopper's own page found waiting"` — so *"which trigger settled this order?"* was answerable from the log after the fact. That naming discipline is argued in `order-pending-events-notifier.service.ts` as a reason not to route both facts through one notifier, and this is the run where it paid.

---

## 5. The poll gate: an optimisation that must never become a guarantee

Trigger 3 differs from the other three in one way that changes how it is built. Order creation happens once per order. The webhook continuation happens once per event. The sweep happens when an operator asks. **The status poll happens once a second, per open order page, for as long as the page is open.**

The obvious implementation is trigger 2's: subscribe to the read and call `drainOrder` every time. A drain that finds nothing is not one statement — the claim runs inside a transaction, so it is `BEGIN` / `SELECT … FOR UPDATE SKIP LOCKED` / `COMMIT`, three round trips. And an order sits in `created` for as long as the shopper takes to decide to pay, which is unbounded.

So the gate rides along inside the statement the poll was already running:

```sql
case when "orders"."status" = ANY($2) then exists (
  select 1 from "payment_events"
  where "payment_events"."order_id" = "orders"."id"
    and "payment_events"."processed_at" is null
) else false end as "has_pending_events"
```

Two design points inside that fragment:

- **`EXISTS`, not a join.** `findOrder` already `LEFT JOIN`s `products` and `deliveries`, and both are safe because their join keys are unique — neither can multiply the row. `payment_events.order_id` is **not** unique; an order can have several pending events, so a join would return several rows and this statement's single-row guarantee is load-bearing. `EXISTS` stops at the first match and cannot change the row count.
- **Wrapped in `CASE WHEN status = ANY(in-flight)`.** A settled order does not probe the index at all.

`EXPLAIN (ANALYZE)` on both branches, against scratch rows in a rolled-back transaction:

```
=== IN-FLIGHT ORDER (created) ===
   SubPlan 1
     ->  Index Only Scan using payment_events_unprocessed_order_idx on payment_events (actual rows=0 loops=1)
           Index Cond: (order_id = orders.id)
           Heap Fetches: 0

=== SETTLED ORDER (delivered) ===
   SubPlan 1
     ->  Index Only Scan using payment_events_unprocessed_order_idx on payment_events (never executed)
           Index Cond: (order_id = orders.id)
           Heap Fetches: 0
```

`never executed` — Postgres short-circuits the `CASE` and does not touch the index. And in the in-flight case it is an **Index Only Scan with `Heap Fetches: 0`**: the partial index's predicate is the query's predicate, so the index answers the question outright without visiting a table row.

### Why the real constraint is connection occupancy, not query time

| Shape | Connection time per viewer-hour | Per poll (derived) |
|---|---|---|
| Ungated (drain on every read) | **9.44 s** | ~2.6 ms |
| Gated (`EXISTS` inside the existing statement) | **0.51 s** | ~0.14 ms |

Both numbers look tiny, and that is exactly the trap. Read as *query time*, 2.6 ms is nothing. The reason it matters is `packages/db`'s pool:

```
max: 1 per instance
```

That is the production shape — architecture §2's connection policy, chosen so fifty concurrent serverless invocations cannot exhaust the connection limit. It means the connection is not a shared resource with headroom; **it is a mutex**, and every millisecond of occupancy is a millisecond in which something else queues *inside Node, before a byte reaches Postgres*.

So the question is never "is 2.6 ms fast?" It is "what is waiting behind it?" Behind it are the guarded UPDATEs that move orders (I9), the drain's claim, and the read that hands a delivered shopper their key. At 100 open pages, the ungated shape is ~262 ms of every second spent holding the only connection to learn that nothing is pending — a quarter of the instance's total database capacity, permanently, doing no work. The gated shape is ~14 ms. And the load scales with viewers × seconds-watched, which is unbounded and entirely outside the shop's control.

**In a `max: 1` pool, cost is measured in exclusive occupancy, not in latency.** A profiler showing 0.039 ms query durations tells you nothing about it. Architecture §7 makes the same point from the other direction — a single-instance concurrency test measures the connection pool rather than the constraint, which is why race proofs must span processes.

### Why the gate being wrong must cost latency and never a key

- **False positive** (says pending, nothing there by the time the drain runs). Ordinary: another worker claimed the row via `SKIP LOCKED`, or the webhook's own continuation settled it. The drain reports `queue_empty` at `debug`. Cost: one wasted claim.
- **False negative** (says nothing pending when something is). The row is still in `payment_events` with `processed_at` NULL, still in the partial index. The next poll, one second later, re-evaluates the same expression against the same durable row. The sweep is behind that.

The *structural* reason a false negative cannot lose a key is that **the gate stores nothing and decides nothing.** It is derived fresh, per read, from the identical predicate the claim itself uses. It is not a lock, not a cache, not a "seen" marker, and nothing is skipped on the strength of what this process remembers.

Name the alternative to see why that matters. The tempting speed-up is an in-process `Set<orderId>` of "orders I have already drained recently". That is precisely the shape architecture §3 forbids for a correctness mechanism — a check-then-act in application memory — and it fails in production specifically: two requests are two serverless processes, so the `Set` is empty in the instance that needed it and populated in the one that did not. Worse, a wrong entry there is **permanent**, because nothing removes it. A false negative in a *stored* gate loses a key forever. A false negative in a *derived* gate loses one second.

---

## 6. The dependency inversion, and why `forwardRef` would have been the wrong answer

The natural way to write trigger 2 is to inject `PaymentEventDrainService` into `OrdersService` and call it after the INSERT. That import cannot be written:

```
PaymentsModule --imports--> OrdersModule    (already true — applying an event moves an order,
                                             and OrderTransitionService is the only way to do it)
OrdersModule   --imports--> PaymentsModule  (what the trigger wants)
```

Nest's answer to a cycle is `forwardRef()` on both sides. It compiles and it works. It is still the wrong answer, for four reasons that stack:

1. **It tolerates the cycle rather than removing it.** `forwardRef` fixes Nest's DI *resolution order* — it defers reading a class reference that is not defined yet. It changes nothing about the dependency graph. After adding it you still cannot answer "does `orders` depend on `payments` or the other way round?", and neither can anyone reading the code in six months.

2. **The domain claim underneath is false.** `orders` has no business knowing a payment inbox exists. Creating an order is complete on its own terms the moment the row commits. That some other module keeps a queue keyed on `order_id` is that module's affair.

3. **It would put an `await` where an `await` must never be.** This is the one to lead with, because it is not aesthetic. If `OrdersService` held a reference to the drain, it could call `await this.drain.drainOrder(id)`. A drain that finds a pending `paid` event runs `created → paid`, `paid → delivering`, and then `POST {SUPPLIER_A_URL}/issue` over real HTTP. One `await` puts a supplier round trip on `POST /api/orders`' response path — reintroducing on the creation endpoint exactly what Slice 2 removed from the webhook.

   The inversion makes that **unreachable by type**, not by discipline:

   ```ts
   export type OrderCreatedListener = (orderId: string) => void;
   ```

   There is no promise to await. A listener that wants to do slow work has exactly one honest option: schedule it.

4. **It would have changed `imports` arrays, and this codebase has a measured rule about those.** `SchedulingModule` may only be imported from a module `AppModule` imports directly. Import it from somewhere deeper and Nest re-parents it below `DatabaseModule`; since Nest destroys modules in ascending distance from the root, the shutdown drain would then run against a closed connection pool, and continuations mid-query at `SIGTERM` would fail instead of finishing.

So the arrow is inverted rather than added. `orders` publishes a fact about its own domain — **news, not an ability** — and the listener lives in `payments`, which already depends on `orders`. The whole diff to the module wiring is:

```
-  providers: [OrdersService, OrderTransitionService],
-  exports: [OrderTransitionService],
+  providers: [OrdersService, OrderTransitionService,
+              OrderCreatedNotifier, OrderPendingEventsNotifier],
+  exports: [OrderTransitionService, OrderCreatedNotifier, OrderPendingEventsNotifier],
```

**No `imports` array changed for any of Slice 3's three triggers.** The `SchedulingModule` distance rule was preserved for free — not by anyone remembering it, but because the design never touched the thing it constrains. That is the good kind of preservation.

Two smaller decisions an interviewer may probe:

- **What is exported is `notify`'s publisher, but a subscriber has no way to publish.** `notify` is called by `OrdersService` and by nothing else, because both facts are only true when `orders` says they are.
- **Two near-identical notifiers, not one, and not a general event bus.** They are different claims with different truth conditions — "an order now exists" is true exactly once per order; "there is pending work for an order that can still move" is false on almost every poll. And trigger 2's listener drains *unconditionally*, by design, so routing status polls through it would run an ungated claim once a second per viewer, defeating §5's gate by construction. A general `@nestjs/event-emitter` bus would trade one unwritable import for an unanswerable question — "who reacts to this?" The four lines of duplication are deliberate; the project's rule (from `toCurrency`) is that whoever writes the third copy has earned the refactor.

---

## 7. The sweep's two surprises

### Surprise 1: the exclusion list does not survive a pass

`drainPending()` claims at most `MAX_EVENTS_PER_PASS` (100) and then returns `pass_limit_reached`, so one pass is not "drains everything still pending" — a queue of 150 would be answered with 100 and a shrug. So the endpoint loops.

`while (pass_limit_reached)` is wrong, and the obvious reason is not the interesting one. The obvious reason is arrivals: an endpoint that runs until the inbox is empty has handed its termination condition to the payment provider. Under sustained load it never returns, holds the single pooled connection throughout, and is eventually killed at the platform's function ceiling — no response, no report, and an operator who cannot tell a hung sweep from a busy one. `MAX_EVENTS_PER_SWEEP = 1000` bounds that, deliberately in **events and not seconds**, so the report is reproducible rather than depending on how slow the supplier happened to be that minute.

The subtle reason is this. A pass excludes the events it has already been handed, so a permanently-unsettleable row at the head of the queue is not handed back *within that pass*:

```ts
alreadyClaimed.length === 0
  ? undefined
  : sql`${paymentEvents.eventId} <> ALL(${sql.param([...alreadyClaimed])})`,
```

The code comment calls this *"loop control, never exclusion"*, and the list is a local `const` inside `runPass` — **discarded when the pass returns.**

Now consider 100 events for orders that do not exist (`deferred_order_missing`: claimed, considered, deliberately left pending), with 50 settleable events behind them.

- Pass 1 claims those 100, settles none, reports `pass_limit_reached`.
- Pass 2 starts with an **empty** exclusion list, orders by `received_at`, and claims **the same 100 again**.
- Pass 3 does the same. And so on.

A naive loop re-claims the identical rows until the platform kills it. It never reaches event 101, never touches the 50 settleable ones, and never returns.

The fix is a **progress condition**, and the sentence that states it is the one to remember: *a pass that settled nothing has shortened the queue by nothing.*

```ts
private shouldRunAnotherPass(pass: DrainResult, claimedSoFar: number): boolean {
  if (pass.stoppedBy !== DrainStopReason.PassLimitReached) return false;
  if (pass.settled === 0) return false;                    // no progress
  return claimedSoFar < MAX_EVENTS_PER_SWEEP;
}
```

If a pass hit its limit and settled nothing, the queue is exactly as it was and the next pass — starting fresh — would do the identical thing. Stop, and answer `more_pending: true`. Conversely, a pass that settled even one row *did* shorten the queue, so the next pass reaches at least one row further and the loop makes progress by construction.

And the stopping is not a failure to do the job. **It is the incident report**, and it is the shape the operator needs: *"the head of your queue is stuck; 100 events are waiting on orders that never arrived."* A loop that kept grinding would have hidden exactly that.

One related detail: `more_pending` is computed pessimistically — `pass.stoppedBy !== QueueEmpty`. Only a pass that ran out of rows to claim saw the end of the queue. The pass limit, the sweep cap, no-progress and a processing failure all left work behind, and `SKIP LOCKED` means even `queue_empty` is not a promise the inbox is empty, only that nothing was available to *this* worker.

### Surprise 2: an unset admin token disables the endpoint; a short one stops the boot

| Situation | Status |
|---|---|
| `ADMIN_TOKEN` not configured | `503` |
| header missing, or not `Bearer …` | `401` |
| token present and wrong | `401` |
| token present and right | handler runs |

The asymmetry to defend: **absence is survivable, a short token is fatal.**

Absence is survivable because losing the sweep loses a *backstop*, not an order. The four triggers are layered precisely so no single one is load-bearing, so an unconfigured token costs the fourth of four. Refusing to boot over it would convert a degraded backstop into a total outage of the catalogue, order creation and the webhook — none of which the missing variable has anything to do with. So: boot, log at `error` naming the variable and the consequence, answer `503` at the door. That is the same judgement `SchedulingModule` already makes when it finds itself on Vercel with no `waitUntil`: loud, and not fatal.

A token present and under 16 characters *does* stop the boot:

```
ADMIN_TOKEN is set but is only N characters; a shared secret must be at least 16.
Unset it entirely to disable the endpoints it protects, which fail closed —
a short token does not (see .env.example)
```

The distinction is **fail-closed**. An absent variable is the state of a fresh clone, and the state of the window in the middle of a rotation; both must leave the shop serving, and both are closed. A two-character token is neither: it is a door someone asked to lock, fitted with a lock that opens to a guess. Sixteen is not a cryptographic claim — a real token is `openssl rand -hex 32` and far longer — it is the line under which a value is obviously not a secret (`admin`, `test`, `password`, a SKU pasted by mistake). It only ever fires on a mistake, which is what a startup check is for.

And the failure mode that must be impossible — a missing credential quietly meaning *no credential required* — is unreachable by **type**, not by care. The classic bug is one line and reads as caution:

```ts
if (expected && expected !== presented) throw;   // unset variable admits everybody
```

Instead:

```ts
export type AdminTokenConfig =
  | { readonly configured: true; readonly digest: Buffer }
  | { readonly configured: false };
```

`this.config.digest` does not exist until `configured` has been narrowed to `true`. There is no branch in which "no token" and "token matched" have the same shape, and creating one would require deleting a `return` rather than forgetting an `&&`.

Two smaller decisions worth having ready: the config carries a **SHA-256 digest, not the token**, because `timingSafeEqual` throws on buffers of unequal length, and the naive length-check fix is itself an early exit that leaks how long the real token is — hashing both sides to a fixed 32 bytes removes the edge instead of documenting it. And a wrong token is `401`, not `403`, because a single shared token carries no identity: there is no "who" to be insufficient, so `403` would imply the caller had been recognised, which this scheme cannot claim.

---

## 8. Where this sits in the assignment

**Settled by this slice:** functional spec 002 §2.3, and the assignment's third adversarial scenario — a payment reported before its order still delivers, with no further action from the shopper.

Slice-1 §6 predicted this exact division of labour: *"Webhook before its order — settled by the **absence** of the FK. What Phases 2–3 still add: the drain triggers — `waitUntil`, order creation, status poll, admin sweep."* All four now exist. The schema decided what was possible; this slice decided what happens.

Also cleared: the nineteen events Phase 1 deliberately left pending now have a mechanism that settles them as `no_op` rather than accumulating forever.

**What remains, honestly:**

- **Slice 5 is now more necessary than it was, and this slice is why.** Invariant I4 has two halves — a `SELECT … FOR UPDATE` on the order row that serialises workers, and the status-guarded UPDATE that makes each transition idempotent. Only the second is in place today; there is no `FOR UPDATE` on `orders` anywhere in `apps/api/src`. Phase 1 got away with that because there was exactly one entry point into issuance. **The drain is the second worker**, so Slice 3 introduced the concurrency that Slice 5's lock is for. The guarded UPDATE and the `deliveries.order_id` UNIQUE still make a double key impossible.

  Resist the tempting overstatement here — it was made while writing this section and disproved while implementing Slice 5. It is **not** true that two workers can currently both reach the supplier and burn keys. All four triggers funnel through the one guarded `paid → delivering`, and nothing returns an order to `paid`; and even if two somehow both got through, `deriveIssuanceRequestId` is deterministic per attempt, so both would send `req_{order}_a_1`, the supplier's ledger (I5) would collapse them to one code, and the loser's rollback would un-claim the key it took. Slice-1 §5's twenty-keys-claimed measurement is **a different arm**: twenty *distinct* request ids and no claim at all. It does not describe today's issuance path, and citing it as though it did would be caught.

  The honest case for the lock is forward-looking, and stronger for being accurate: the pool becomes genuinely exposed the moment a request id stops being derivable from the order alone — Phase 3's `attempt + 1` retry, and the supplier-B fall-through. That decision (read the attempt row, classify `unknown` versus `failed`, choose re-probe or fall-through) is exactly a multi-statement read-then-act that only a row lock can protect. **The right time to add the lock is before that code exists**, so Phase 3 arrives into an already-serialised path rather than being retrofitted around one.
- **Slice 6** — the reviewer-runnable adversarial scripts. Note the gap: the *mechanism* for scenario 3 is proven, but the repeatable `webhook:before-order` script is not written yet, and this slice's verification is what discovered why. Order ids are exclusively server-generated, so the scenario can only be driven as a genuine race today. The fix — an explicit order id behind a config flag, used only by seeds and that script — is recorded in architecture §9 as a known trade-off.

Against the assignment's five adversarial scenarios, as numbered in `product-definition.md` §1.4 — note that **the double-click is not one of them**; it is Этап 2's headline requirement and spec 002 §2.1, and conflating the two misquotes the assignment to the person who wrote it:

| # | Scenario | Status |
|---|---|---|
| 1 | 50 parallel `paid` webhooks → one issuance fact, one key consumed | **Mechanism settled in Phase 1** — the key claim and the guarded transitions — and proven across four real processes by `apps/api/test/concurrency/key-claim-race.test.ts`. The reviewer-runnable script is Slice 6. |
| 2 | A repeated webhook with the same `event_id` changes nothing | **Settled since Phase 1** by the `event_id` PRIMARY KEY. Script in Slice 6. |
| 3 | A webhook arriving before its order, or out of order | **Settled here.** Repeatable script still owed — see the note above on server-generated order ids. |
| 4 | An empty key pool leaves the order recoverable; after restock, exactly one key | **Half-won.** `out_of_stock` is a real state, the claim returns zero rows on an empty pool, and a restock re-issues cleanly against the same derived id — verified. The admin list of paid-but-undelivered orders and manual retry are Phase 3. |
| 5 | A promo code with limit N, under parallel requests, applied at most N times | Phase 5. Not started. |

---

## Interview questions this answers

**"Your `payment_events.order_id` has no foreign key. Isn't that a data-integrity bug?"**
No — it is the design, and `deliveries.order_id` ten lines away is what proves it was a decision. The rule is *who can write this row before the order exists*. A delivery is only ever written by code that has already read the order, so a dangling reference is a real bug and the FK belongs there. A payment webhook and the shopper's `POST /api/orders` are separate connections in separate processes with no ordering guarantee, so an early event is legitimate. Adding the FK makes the insert raise, which makes the endpoint return `5xx`, which is how you ask a payment provider to **redeliver** — turning a millisecond race into a retry storm.

**"Why four processing triggers? Isn't one enough, and isn't four just redundancy?"**
Each of the first three is attached to something happening, and that attachment is also its limit: trigger 1 needs the process to survive, trigger 2 needs the order to be created *after* the event, trigger 3 needs somebody watching. Compose those three gaps — a shopper who pays and closes the tab while the instance is recycled — and no automatic trigger can fire. The sweep is tied to nothing, which is why it closes the set. The layering is also what lets each individual trigger be cheap: because none is load-bearing, trigger 2 can decline to retry and trigger 3 can be gated.

**"Can you show me a case where the redundancy actually did something?"**
Yes, and we didn't stage it. In the genuine race we ran for verification, the event landed first, the order was created, and **the creation drain — the trigger written for this exact scenario — missed it.** The order sat in `created` with the event pending, unchanged after two seconds. The shopper's next page load fired the status poll drain, which applied the event and issued the key. A test that passes proves the primary path works; that run proves the system survives the primary path failing for a reason nobody predicted.

**"You're running an `EXISTS` subquery on every status poll. Isn't that premature optimisation of a 0.04 ms query?"**
It goes the other way: the `EXISTS` is what *removes* work. The alternative — draining on every read — costs three round trips (`BEGIN` / claim / `COMMIT`), measured at 9.44 s of connection time per viewer per hour against 0.51 s. And the constraint isn't query time, it's **occupancy**: the pool is `max: 1` per instance, so the connection is a mutex, and every millisecond held is a millisecond in which a guarded UPDATE queues inside Node before reaching Postgres. At 100 open pages the ungated shape holds a quarter of the instance's only connection, permanently, to learn that nothing is pending.

**"If your gate is ever wrong, do you lose a payment?"**
No, and the reason is structural rather than careful. The gate stores nothing and decides nothing — it is derived fresh, per read, from the same `processed_at IS NULL` predicate the claim itself uses. A false negative means the row is still in `payment_events` and still in the partial index, so the next poll a second later sees it, and the sweep is behind that. The version that *would* lose a key is the tempting one: an in-process `Set` of "orders I already drained". That is a check-then-act in application memory, it is empty in the serverless instance that needs it, and a wrong entry there is permanent.

**"`OrdersModule` and `PaymentsModule` need each other. Why not just use `forwardRef`?"**
Because `forwardRef` tolerates a cycle rather than removing one, and the concrete cost is not architectural tidiness. If `OrdersService` held a reference to the drain, someone would eventually `await` it — and a drain that finds a pending `paid` event calls the supplier over HTTP, putting a network round trip on `POST /api/orders`' response path, which is the exact thing Slice 2 removed from the webhook. The inversion makes that unreachable by type: the listener signature returns `void`, so there is no promise to await. `orders` publishes news about its own domain, `payments` subscribes, and no `imports` array changed — which also preserved the `SchedulingModule` shutdown-ordering constraint without anyone having to remember it.

**"Your admin endpoint returns `503` when the token is unset. Isn't a missing credential a reason to refuse to start?"**
For a shopper-facing dependency, yes — that is why a missing `SUPPLIER_A_URL` is fatal. For an operator's endpoint, no: the four triggers are layered so an unconfigured token costs one backstop, not one order, and refusing to boot would take the catalogue, order creation and the webhook down over a variable that concerns none of them. So it boots, logs at `error`, and fails closed at the door — enforced by a discriminated union, so "unconfigured" cannot take the "matched" branch. A token that is *present and under 16 characters* does stop the boot, because absence fails closed and a guessable lock does not.

---

## Source files

- `apps/api/src/orders/order-created-notifier.service.ts`
- `apps/api/src/orders/order-pending-events-notifier.service.ts`
- `apps/api/src/orders/orders.service.ts`
- `apps/api/src/payments/order-creation-drain.ts`
- `apps/api/src/payments/order-status-poll-drain.ts`
- `apps/api/src/payments/payment-event-drain.service.ts`
- `apps/api/src/payments/payment-event-processor.service.ts`
- `apps/api/src/admin/payment-event-sweep.controller.ts`
- `apps/api/src/admin/admin-token.guard.ts`
- `apps/api/src/config/admin-token.ts`
- `context/product/architecture.md` §3, §3.1, §4
- `docs/walkthrough/slice-1-data-model.md` §4, §5, §6

**On evidence:** the FK-asymmetry output and both `EXPLAIN (ANALYZE)` plans were captured against the running local Postgres inside rolled-back transactions; the database was left unchanged. The 9.44 s / 0.51 s occupancy figures and the missed-creation-drain race are the slice's own verification results, reported by the verifying agent.
