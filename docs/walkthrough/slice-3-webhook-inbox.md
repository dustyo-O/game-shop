# Slice 3 — The webhook inbox, and why winning an insert is what "first sight" means

> Written for the author to read and re-explain from memory. Companion to `context/product/architecture.md` §3 (I2), §3.1 and §4.
> Slice 8 consolidates this and the other slice walkthroughs into the phase-level document.
>
> **Superseded in part by Slice 5.** This document describes the inbox as it stood when `paid` events were
> banked unprocessed (`deferred_issuance`). Slice 5 replaced that branch with `markPaid` → `beginIssuance`
> and reworked the settle rule, so §5's outcome table is now a record of Slice 3's behaviour rather than
> current behaviour. Everything else here — the intake statement, the status-code rule, apply-then-settle,
> and the four-process concurrency argument — still holds. See `slice-5-*.md` for the current outcomes.

## 1. The shape: receive → persist → acknowledge → process

A payment provider makes three promises, and every one of them is a promise about *bad* behaviour:

- **At-least-once delivery.** It will send each event one or more times. Not exactly once — one or more.
- **Out-of-order arrival.** Event B may reach you before event A, and either may reach you before the thing it is about exists on your side.
- **`5xx` triggers redelivery.** If you answer with a server error, it will send the same bytes again, on a backoff schedule, for as long as its policy says.

Those three facts decide the endpoint's shape. `POST /api/webhooks/payment` does four things in a fixed order:

1. **Receive** — parse the body *only* far enough to write a row. Five checks, each one traceable to a NOT NULL column: `event_id`, `order_id`, `status`, `currency` must be non-empty strings, `amount` must be a finite number that fits a Postgres `integer` after the roubles→kopecks conversion. Nothing else is validated. Not that the status is one we recognise, not that the currency is `RUB`, not that the order exists.
2. **Persist** — one `INSERT` into `payment_events`. That statement is the whole of invariant I2 and is the subject of §2 below.
3. **Acknowledge** — `200`. The provider is done with us.
4. **Process** — apply the event to its order and settle it.

### The naive alternative: do the work, then answer

The obvious handler does the work first and lets the status code report how it went. Three specific costs:

- **The provider's clock is not our clock.** Issuance in the full system means an HTTP call to a supplier that may take seconds and may hang. If the provider's read timeout is five seconds and our work takes eight, it never hears the `200` — so it redelivers, and now there are two copies of one event in flight against the same order. The work being slow has manufactured the concurrency.
- **A crash loses the event.** If nothing was written before the work began, an instance that dies mid-processing leaves no trace that the event ever arrived. The only recovery is the provider's retry, which is a policy we do not own and which eventually stops.
- **Every processing failure is forced into the status code.** If the answer is written after the work, a failure in the work has nowhere to go but a `5xx` — which, per promise three, is a request for redelivery. §3 is entirely about why that is the wrong instruction in almost every case.

Persisting first removes all three. Once the row is committed the event cannot be lost, the acknowledgement no longer depends on how long the work takes, and a failure in the work is not a failure to receive.

### Stated honestly: in this slice, processing still runs before the `200`

`PaymentWebhookController.receiveEvent` calls the processor inline, before returning. That is temporary and it does not break the pattern, because the pattern's load-bearing claim is about **ordering**, not about latency: nothing is decided before the row exists, so a crash between the two steps loses no event.

`architecture.md` §4 lists four processing triggers — `waitUntil` after the response is sent, a drain on order creation, a drain on the status poll, an admin sweep — layered so no single one is load-bearing. None exists yet. Running inline trades a few milliseconds of provider-visible latency for a system with exactly one path and no way to lose an event.

The design that makes the move cheap: `PaymentEventProcessor.processStoredEvent` takes a **stored row**, never a request body. It does not care who calls it — the webhook today, a `waitUntil` continuation and a `FOR UPDATE SKIP LOCKED` drain tomorrow. When those arrive, *this call site moves and nothing else does*.

> *Interview answer:* "Receive, persist, acknowledge, process. The 200 says 'this event is durable', not 'the work is finished' — because the provider's retry policy is triggered by our status code, and it must only ever fire when we actually want the event again."

## 2. Winning the insert is what "first sight" means

The endpoint contains no `SELECT`. Nothing asks "have I seen this event before?" — that question is answered *by writing*, and the answer is how many rows came back.

The statement, copied from what Postgres logged under `log_statement = 'all'`:

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
--           caller ever sees this per event_id.
-- 0 rows => REDELIVERY. A row with this event_id already exists and was left
--           untouched. Acknowledge 200 and stop.
```

### The check-then-act this system exists to avoid

The alternative is one line longer and wrong:

```ts
const seen = await db.select().from(paymentEvents).where(eq(eventId, id));
if (seen.length > 0) return alreadySeen();       // <- check
await db.insert(paymentEvents).values(...);      // <- act
```

Trace two overlapping redeliveries of `evt_1`:

- **t0** — instance A runs the `SELECT`. Zero rows.
- **t1** — instance B runs the `SELECT`. Also zero rows. Under `READ COMMITTED`, B's snapshot is exactly as true as A's; readers do not block each other and there is nothing to block on yet.
- **t2** — A inserts. Succeeds.
- **t3** — B inserts. The primary key refuses it, Postgres raises a duplicate-key error, and Nest turns an unhandled exception into a `500`.

And a `500` is how you ask a payment provider to send the duplicate a **third** time. The check-then-act does not merely fail to help — it manufactures the retry storm it was written to prevent. Note the shape: the `if` was correct in both processes, and the outcome is still an incident. The gap between the read and the write is where the other request lives.

An in-process `Set` of seen ids is worse still. `apps/api` deploys to Vercel as serverless functions, so two concurrent webhooks are typically two processes with separate memory (`architecture.md` §5). Such a guard passes locally and evaporates in production — the most dangerous kind of fix, because the test goes green.

`ON CONFLICT (event_id) DO NOTHING` moves the decision inside Postgres, where the row itself is the only place every concurrent copy of an event meets.

### Three details in that statement that are load-bearing

- **`DO NOTHING`, not `DO UPDATE`.** A redelivery must leave the stored row byte-identical. `DO UPDATE SET payload = excluded.payload` looks harmless, overwrites the first-sight `received_at` evidence, and — much worse — **returns a row**, which makes every redelivery look like a first sight and re-runs issuance. That is precisely the failure I2 exists to prevent.
- **The conflict target is named.** A bare `ON CONFLICT DO NOTHING` absorbs a violation of *any* constraint on the table, so a future NOT NULL or CHECK failure would be silently reported to the provider as a duplicate. Naming `event_id` means only the redelivery it is meant for is swallowed.
- **`default, default` for the last two columns.** `received_at` is stamped by **the database's clock** — the one every process is compared against, unlike a serverless instance's. `processed_at` has no default, so `default` is NULL: the row enters the queue as pending, which is the complete and correct outcome of this endpoint.

### "Exactly one statement" — what the proof buys

Under `log_statement = 'all'`, a first-sight delivery produced one logged statement — that `INSERT` — and a duplicate delivery produced one logged statement, the same `INSERT`. No `SELECT` before it. No follow-up read on the zero-row path.

That is not a performance observation. **A race needs two statements to live between.** With one statement, the check and the write are the same event inside Postgres, adjudicated by the primary key's unique index, and there is no instant at which another transaction could observe "not present" and act on it. Proving the endpoint issues exactly one statement is therefore proving the window does not exist — not that it is small, that there is none.

(The zero-row path deliberately issues no follow-up query at all. `OrderTransitionService` pays for a second `SELECT` when its UPDATE matches nothing, because there "nothing happened" has two causes that need different handling. Here it has exactly one — a row with this `event_id` exists — so the duplicate path, which is the most common request a retrying provider makes, is answered as cheaply as it possibly can be.)

The log from a real run of this slice, one order, one event delivered twice:

```
[PaymentEventsService] msg: 'payment webhook: event stored, pending processing',
  event_id: 'evt_01M1W9851HPABC3CCRA492CK0A', status: 'failed', amount_minor: 129000
[PaymentSimulatorService] replayed: false, webhook_outcome: 'stored'

[PaymentEventsService] msg: 'payment webhook: redelivery of an event already in the inbox; nothing written',
  event_id: 'evt_01M1W9851HPABC3CCRA492CK0A'
[PaymentSimulatorService] replayed: true, webhook_outcome: 'duplicate'
```

Same id, `stored` then `duplicate`, nothing written the second time, `200` both times.

> *Interview answer:* "There is no duplicate check. Losing the insert *is* the duplicate check — and it is the only version of it that cannot be raced, because the decision and the write are one statement."

## 3. The status code is an instruction, not a report

This is the heart of the slice. A provider retries on `5xx`. That makes the status code a message to a machine with a retry policy, and the only question worth asking about each response is: **do I want these exact bytes again?**

| Answer | Means | Used for |
| --- | --- | --- |
| `5xx` | "Send it again." | Exactly one case: we could not write the event to the inbox. |
| `400` | "Sending it again will not help." | A body that can never become a row. |
| `200` | "We have it; stop." | Everything else — including things that went wrong. |

### `5xx` — the one case

`PaymentEventsService.recordEvent` catches a failing insert, logs it with both correlation ids, and **rethrows**. It does not handle it. The database was unreachable or the pool was exhausted; the event is durable nowhere; we genuinely want it again. That is the only path in this module that produces a `5xx`, and it is deliberate.

### `400` — a body that can never become a row

Five parse checks, each mapped to a NOT NULL column, plus the amount's int4 range check. Why the range check exists when nothing else is validated: `amount_minor` is a Postgres `integer`, so `NaN`, `Infinity` or `999_999_999_999` would make the **INSERT itself raise**.

- **Wrong choice: let it raise.** The insert throws, Nest returns `500`, the provider treats that as "they didn't get it" and redelivers the identical bytes. They fail identically. Forever, on a backoff schedule. Your error rate looks like an outage, the endpoint is marked failing on the provider's dashboard, and some providers disable the webhook entirely — because of one malformed field.
- **Right choice: `400`.** Truthful (this is the sender's problem) and it *ends the loop* instead of starting one.

Note what is **not** rejected. An unrecognised `status` is stored verbatim — `payment_events.status` carries no CHECK constraint for exactly this reason. A currency the shop cannot price is stored. An `order_id` naming an order that does not exist is stored, because the column has no foreign key on purpose. Negative amounts are accepted; a refund-shaped event is evidence worth keeping. The rule is narrow and consistent: *reject only what cannot become a row.* Every stricter rule destroys evidence about real money and — because the provider retries on `5xx` — asks for it again.

### `200` — a duplicate

Zero rows from the insert. Nothing was written, nothing is processed, `{"outcome":"duplicate"}` with a `200`.

- **Wrong choice: `409 Conflict`, or worse a `500`.** `409` is defensible-sounding and mostly harmless with a well-behaved provider, but `500` is catastrophic and it is the one people actually write, usually by letting a duplicate-key exception escape. The incident: the provider redelivers, that redelivery is also a duplicate, which also returns `500`, which triggers another redelivery. **The loop is self-sustaining** — nothing about the passage of time can turn a duplicate into a first sight.
- The sentence worth memorising: *a duplicate we correctly ignored is a success.* Turning it into an error is how you ask for it again.

### `200` — an event whose order does not exist

Stored with `processed_at` NULL, `200`, and the processor's outcome is `deferred_order_missing`.

- **Wrong choice: `404`, or a `500` from a foreign key.** A `POST /api/orders` and a provider's webhook are separate connections in separate processes with no ordering guarantee between them. The provider knows an order id we gave it and has every right to report on it before our own write is visible. Reject it and you have converted a normal few-millisecond race into an error — one which, if answered `5xx`, becomes a retry storm, and which, if the provider gives up before the order appears, **loses a real payment result**.
- This is the same decision as Slice 1's missing foreign key on `payment_events.order_id`, seen from the endpoint's side. Both files carry a boxed "do not fix this" comment for the same reason.

### `200` — applying an already-stored event fails

The subtlest one. `processStoredEvent` is wrapped in a `catch` that logs at `error` level and **swallows**. The `200` still goes out. Three independent reasons, and the third is the one to lead with:

1. **A retry could not fix it.** A redelivered copy loses the `ON CONFLICT` insert, comes back `already_seen`, and is deliberately not processed. So a `5xx` here buys a stream of redeliveries that are *guaranteed* to do nothing, on the provider's schedule, until the endpoint is disabled.
2. **Something else already will fix it.** The failure left `processed_at` NULL, which is not an error state — it is the queue. The event sits in `payment_events_unprocessed_order_idx` waiting for the drain, exactly as an event that arrived early does.
3. **`5xx` means "we do not have this event." We have it.** Reporting otherwise is not caution; it is a false statement to the one system whose behaviour depends on the answer.

Two details about where that `catch` lives. It is at the **controller**, not inside the processor: `200` is an HTTP decision, and a drain calling the same processor needs the error to propagate so it can back off and retry. And it logs at `error` with `event_id` and `order_id`, because "the webhook succeeded and the order did not move" is precisely the incident that is invisible without a log line.

> *Interview answer:* "We return 5xx only when we want the provider to send it again — which is only when we failed to write the event down. Everything we handled correctly, and everything a retry cannot fix, is a 200. The status code is an instruction to a machine, not a description of our feelings about the request."

## 4. Apply, then settle. Never the reverse.

Processing is two writes: the guarded `UPDATE` on `orders`, then the `UPDATE` that stamps `processed_at`. They are **two statements, not one transaction**, and the ordering is what makes that safe.

**Crash after the transition, before the settle:**

- The order is `payment_failed`.
- The event is still pending (`processed_at` NULL), so it is still in the queue.
- A later drain re-applies it. The status guard `WHERE status = ANY('{created}')` now matches zero rows, because the order is already `payment_failed`. Outcome: `no_op`. The event is settled.
- **Correct** — because applying an event twice is a no-op by construction (I9). The duplicate work was harmless.

**Crash the other way round (settle first, then apply):**

- The event reads "processed".
- The order never moved.
- Nothing will ever look at it again — the row has left the queue, so no drain will find it.
- **That is a lost payment result**, and it is the only ordering that can produce one.

The general rule, worth being able to state in one line: **the record of "not yet done" must outlive the doing.** A false "not done" costs a repeated no-op. A false "done" costs the work, permanently. So do the work first and mark it done second, and make the work idempotent so the repeat is free.

This is why the processor needs no transaction to be correct — it needs the writes in this order. Phase 2 adds one anyway, for a different reason: the drain claims the event with `SELECT … FOR UPDATE SKIP LOCKED` and the claim, the apply and the settle then belong to one unit of work.

### The settle, and its `AND processed_at IS NULL` guard

```sql
update "payment_events" set "processed_at" = now()
where ("payment_events"."event_id" = $1
       and "payment_events"."processed_at" is null)
returning "event_id", "processed_at";
-- 1 row  => THIS call settled the event; it is out of the queue.
-- 0 rows => it was already settled (or, once the drain exists, another worker
--           settled it first). Nothing to do, and not an error.
```

Exactly the same shape as the status guard on `orders`, for exactly the same reason: it makes the write idempotent. Without it, a re-drained event would overwrite the timestamp recording when it was **first** settled — replaying the inbox would quietly rewrite the history the inbox exists to preserve. And once several workers drain concurrently, the row count is how a worker learns whether it was the one that settled the event, rather than assuming it.

Two smaller points in the same statement. `now()` is evaluated **in SQL, not `new Date()` in Node** — the clock that stamps the row is the database's, the one `received_at` and every other process is compared against. And there is no `order_id` predicate: `event_id` is the primary key and already names exactly one row; adding a second predicate would imply the row could be found some other way.

## 5. `processed_at IS NULL` is the queue

There is no `status` column on `payment_events` and no separate jobs table. Pending work is the *absence of a timestamp*, and the access path is a partial index:

```sql
CREATE INDEX payment_events_unprocessed_order_idx
  ON payment_events (order_id) WHERE processed_at IS NULL;
```

The index holds only unprocessed rows, so it stays a handful of entries however many events the table accumulates — the queue is literally the index. It serves both drains: the targeted one (order creation and the status poll drain that order's own pending events) and the global sweep:

```sql
SELECT * FROM payment_events
WHERE processed_at IS NULL
ORDER BY received_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
-- 0 rows => nothing pending, or every pending row is held by another worker.
```

**Why not a status field?** Three reasons.

- A `status` column is a second thing to keep in step with the truth, and the two can disagree. `processed_at` is not an opinion about the work — it *is* the fact, and it carries *when*, which a boolean or an enum does not.
- A status enum invites a `failed` value, and a `failed` value is a dead-letter box that nothing retries. The whole point here is that a failure and an early arrival leave the row in the *same* state, so the *same* mechanism recovers both. There is no second path to write and forget to run.
- `NULL` is exactly what a partial index wants. A three-valued status column would need its own index and a predicate that has to be kept in step with the enum.

### The five outcomes

`PaymentEventProcessor` returns a named outcome and a derived `settled` flag — derived, so the two cannot disagree:

| Outcome | Settled? | Why |
| --- | --- | --- |
| `applied` | yes | The order moved `created → payment_failed`. |
| `no_op` | yes | The guard matched zero rows — already `payment_failed`, or `paid`, or terminal. Considered, and correctly changed nothing. |
| `unknown_status` | yes | A status this shop has no lifecycle move for. Stored verbatim for reconciliation. |
| `deferred_order_missing` | **no** | No such order *yet*. Left pending for a later drain. |
| `deferred_issuance` | **no** | A `paid` event. Left pending because it drives issuance, which is Slice 5. |

None of them is an error. Every one of them is a `200`.

**The pair worth explaining, because it looks inconsistent and is not:** an event for a nonexistent order stays pending, while an event with an unrecognised status is settled. The test is not "did it succeed?" — it is **"could a later attempt know more than this one did?"**

- Missing order: **yes.** The order may be committed a millisecond from now. Settling the event here would silently discard a real payment result, because nothing would ever look at the row again.
- Unrecognised status: **no.** The same string will be just as unrecognised tomorrow. Leaving it pending would put a permanent occupant in the queue that every future drain re-examines and never clears — the queue poisons itself, and the genuinely pending events get harder to see.

Same test explains `no_op` being settled: the order is not in a state this transition may leave from, and *that stays true forever* (`delivered`, `payment_failed` and `out_of_stock` are terminal — Slice 2, I9). There is nothing to come back for.

### Why a successful payment leaves the order in `created`

`deferred_issuance` is the outcome that surprises people, so it is worth being explicit. A `paid` event is stored and then deliberately not applied in this slice. Moving the order to `paid` with no issuance behind it would manufacture, for **every** successful payment, exactly the paid-and-undelivered state the admin panel exists to flag — and it would do so while `processed_at` claimed the event had been fully handled. Better to leave the row in the queue, which is precisely what a queue is for. Slice 5 turns this branch into `markPaid` plus the rest of the chain, and the events banked in the meantime drain in `received_at` order.

The order page tells the shopper the truth rather than papering over it: «Платёж отправлен, и магазин его принял. Заказ пока остаётся в состоянии «Ожидает оплаты»…» — a sentence written to be deleted in Slice 5.

From a real run:

```
[PaymentEventsService]   'payment webhook: event stored, pending processing'  status: 'paid'
[PaymentEventProcessor]  'payment event: paid, left pending for issuance'
```

## 6. The simulator is an instrument, not a convenience

There is no real acquiring in this system, so something has to play the payment provider. `POST /api/payments/:orderId/simulate` does, and three of its decisions are load-bearing.

### It mints a fresh `event_id` by default; a replay is opt-in

`event_id` is the deduplication key. A simulator that reused an id would drive the **duplicate** path on its second call and quietly never exercise the first — and then every assertion of the form "exactly one `stored` out of twenty" would pass for the wrong reason. That is the one bug a payment simulator must not have, because it makes the test that proves I2 pass against a system that does not implement I2.

So the default is a fresh ULID (`evt_01M1W9…`), and a duplicate is something a caller has to *ask for*, by pinning `event_id` in the request body. An optional field rather than a `/replay` endpoint (which would duplicate the amount lookup and the delivery, and drift the moment one was fixed) and rather than letting scripts build payloads themselves (which would create a second place that knows the roubles↔kopecks conversion).

The ack body reports what the webhook said — `stored` or `duplicate` — passed through unchanged, because the only authority on which insert won is the process that ran it. That field is what a race script asserts on.

### It crosses a real HTTP boundary

`PaymentWebhookController` is a class in the same process. Injecting it here would work, would be faster, and would be a mistake. What an in-process call quietly stops testing:

- **Serialisation.** A direct call hands the controller a live object with a branded `MajorUnits` amount. The wire hands it `JSON.parse` output — which is the only input `parsePaymentWebhookPayload` will ever see in production, and the entire reason it exists.
- **The acknowledgement.** `200` vs `400` vs `5xx` is the whole vocabulary this shop uses to speak to a payment provider. A method call returns a value; only a request returns a status code, and **only a status code can be got wrong in the way that matters** (§3).
- **The process boundary Phase 2 depends on.** In production the two sides are separate serverless invocations with separate memory. A race script driving an in-process call collapses both sides into one stack and proves nothing about the deployed system.

This was verified rather than asserted: pointing `PAYMENT_WEBHOOK_URL` at a raw listening socket instead of the API and triggering a payment produced a genuine HTTP request on that socket — request line `POST /api/webhooks/payment HTTP/1.1`, the `content-type: application/json` header the client sets, and the contract-shaped JSON body carrying all six fields including `created_at`. The reason a raw socket is the right instrument: **an in-process call would have produced nothing on it at all.** There is no way to fake that result.

### It refuses an unknown order, even though the webhook accepts one

The two endpoints answer differently about the same missing order. The asymmetry is deliberate, and it is the most interesting thing in this file:

- **The webhook must accept it.** `payment_events.order_id` has no foreign key precisely so "webhook before order" is a normal path. A real provider knows an order id we gave it and may legitimately report on it before our own write is visible.
- **The simulator cannot.** It is not a provider that was told an amount — it is a piece of the shop that *derives* the amount from `orders.amount_minor`, the value the catalogue wrote at creation time. With no order row there is no amount, no currency, and therefore no contract-shaped event to build. The failure is not "too early", it is **"unpriceable"**, and there is no later moment at which this call would have succeeded. `404` is the honest code.

Inventing an amount to fill the gap is the one thing that must not happen: it would put a number on the wire that no catalogue row backs — the exact shape of the client-supplied-amount bug the whole pricing path is built to prevent. So the "webhook before order" scenario is staged by calling `POST /api/webhooks/payment` directly, which is ordinary HTTP, not by asking the simulator to price something that does not exist.

One more absence: the simulator does **not** check the order's status. A `payment_failed` order can be simulated again, and so can a `delivered` one. A real provider is not asking permission, and an `if (order.status !== "created")` here would be a check-then-act with a window between the read and the delivery — moving a guarantee out of the database and into application code, which §3's governing principle forbids. The defence against a late or repeated event is the status-guarded transition that refuses it.

Which is why the front end's behaviour is described in its own file as cosmetic: on a `payment_failed` order the page renders no payment buttons, and that is a courtesy to the shopper — functional spec §2.3's "they see no controls offering to pay again" — and **nothing else**. The endpoint has never heard of that element and will accept the call the hidden button would have made, from `curl`, from a stale second tab, from a script. The order does not move anyway, and the reason is a `WHERE` clause:

```sql
update "orders" set "status" = $1, "updated_at" = now()
where ("orders"."id" = $2 and "orders"."status" = ANY($3))
returning *;
-- 0 rows => the order was not in a state this transition may leave from.
```

Observed in a real run — a second, distinct `failed` event delivered to an order that had already failed:

```
[PaymentEventProcessor] msg: 'payment event: no-op, order was not in a state this transition may leave from',
  event_id: 'evt_01M1W997P3K1B7HFDXREHYXWM2', observed_status: 'payment_failed'
[PaymentEventProcessor] msg: 'payment event: processed', processed_at: '2026-09-06T21:16:41.037Z'
```

Zero rows, no error, event settled, order unchanged. That is the guarantee; the hidden button is the picture of it.

## 7. Why the concurrency proof needed four processes

**Interview question: "You ran twenty concurrent requests and they behaved. What did that actually prove?"**

Against a single dev instance: **nothing**, and this is the trap worth understanding.

`packages/db` configures the pool with `max: 1` per instance, deliberately — a serverless instance serves one request at a time, so the pool's `max` is "how many connections may one in-flight request hold", and the answer is one. Locally that has a side effect: a single API process with a single connection **serialises its statements**. Request A's `INSERT` acquires the only client, completes, and returns it before request B's `INSERT` can start. Twenty "concurrent" HTTP requests become twenty sequential statements at the database.

So a green single-process run would have demonstrated that a queue of one connection processes things one at a time. It would have said nothing about `ON CONFLICT`, because **under real serialisation the check-then-act passes too** — A's `SELECT`/`INSERT` both complete before B's `SELECT` runs, so B sees the row and returns "already seen". The naive implementation this slice exists to reject would have produced identical output. A test the broken code also passes is not evidence.

The run therefore used **four separate API processes** on four ports, with the twenty requests spread across them. Four pools of one, four independent connections, statements genuinely overlapping inside Postgres — and the only place the requests meet is the row.

What it showed, against one order:

- **20 first-sights.** Every request minted its own `event_id`, so all twenty legitimately won their inserts and were acknowledged `stored`. That is I2 working as specified: the inbox deduplicates *events*, not payments — twenty different events are twenty different rows.
- **Exactly one `UPDATE` matching `WHERE status = ANY('{created}')`.** One caller made the transition. The contested resource here is the *order row*, and the guarded update is what arbitrates it.
- **19 no-ops.** Nineteen callers were told zero rows, logged `observed_status: 'payment_failed'`, and settled their events. Not errors — considered, and correctly changed nothing.
- **Zero errors.** No `5xx`, anywhere. A real provider would have retried nothing.

That is the same shape as the assignment's "fifty webhooks, one issuance" scenario, with `markPaymentFailed` standing in for the `markPaid → beginIssuance` chain until Slice 5 exists. The mechanism being proved — one guarded `UPDATE` picks exactly one winner across processes that cannot see each other — is identical.

**Two honest limits.** Four processes on one machine is still weaker than the deployed version, where concurrent requests land in genuinely separate serverless instances; passing these scripts against the deployed URL is the strongest form of the claim (`architecture.md` §5). And this proves the *inbox* and the *transition*, not issuance — there is nothing here that calls a supplier yet, so the key-is-never-issued-twice half of the scenario belongs to Slices 4, 5 and 7.

> *Interview answer:* "One process with a pool of one serialises the requests, so the broken implementation passes too. The proof has to run in separate processes, or it is measuring the connection pool instead of the constraint."

## 8. Where this sits in the assignment

| Graded scenario | After Slice 3 | What is still missing |
| --- | --- | --- |
| **Parallel webhooks → one issuance** | Half-settled. The endpoint exists, the inbox absorbs every copy, and the guarded transition picks exactly one winner — demonstrated at 20 requests across four processes with 19 no-ops and zero errors. | The issuance it should trigger. Slice 5 adds `created → paid → delivering`, the supplier call and the `deliveries` insert (I3); Phase 2 adds `FOR UPDATE` (I4) so the losers never reach the supplier at all. |
| **Replayed `event_id`** | **Settled.** Zero rows from the insert → `200 duplicate`, nothing written, nothing processed. Proven with a live replay: `stored`, then `duplicate`, order unchanged. | Phase 2's `race:same-event` firing N *concurrent* copies of one pinned id, and asserting the delivery is unchanged — which needs a delivery to exist. |
| **Webhook before its order** | Half-settled, and the correct half. The event is stored with `processed_at` NULL and reported as `deferred_order_missing` instead of being rejected. | The drain that applies it once the order appears — `architecture.md` §4's four triggers, all Phase 2. |
| **Empty pool → restock → recovery** | Untouched. | Slice 6 for the `out_of_stock` state; Phase 3 for recovery and manual retry. |
| **Concurrent promo redemption** | Not started — Phase 5 tables. | `UPDATE … WHERE used_count < max_uses RETURNING` and UNIQUE (`promo_id`, `order_id`). |

Against functional spec §2.3, the slice's own acceptance criteria:

- *"the failing control → the page shows the payment did not go through and no key is shown"* — **settled**, end to end through the real webhook.
- *"payment already failed → no controls offering to pay again"* — **settled**, with the caveat stated in §6: that is presentation, and the guarantee is the `WHERE` clause behind it.
- *"the successful control → the page shows the order is being processed"* — **half-settled, deliberately**. The event is stored and acknowledged; the order stays `created` because issuance does not exist yet, and the page says so in plain Russian rather than asserting a state the shop has not reached.

The sentence to lead with: **this slice is where the system starts talking to a machine that retries.** Everything in it — one statement, no read first, `200` for a duplicate, `200` for an early event, `200` even when the work fails, apply before settle — is a consequence of that one fact, and every wrong answer produces the same incident: a retry loop the shop asked for.

## Eight questions, eight answers

1. *Why persist before processing?* — Because the `200` must mean "this event is durable", not "the work is finished". Otherwise a slow supplier call, a crash, or any processing failure turns into a redelivery request we did not intend.
2. *How do you detect a duplicate?* — By losing an insert. `ON CONFLICT (event_id) DO NOTHING RETURNING *`: one row is first sight, zero rows is a redelivery. There is no `SELECT`.
3. *Why not check first?* — Because two overlapping redeliveries both read "not present", both insert, and the second raises a duplicate-key error that becomes a `500` — which asks the provider for a third copy. The check-then-act manufactures the storm it was meant to prevent, and an in-process `Set` is worse: it evaporates across serverless instances.
4. *When do you return `5xx`?* — Only when we failed to write the event to the inbox, because that is the only case where we want it sent again. A duplicate is `200`. An event for an order that does not exist is `200`. A failure while *applying* an event we already hold is `200` — we have it, the row is still pending, and a redelivery would be refused by the insert anyway.
5. *Why is `400` right for a malformed body?* — Because the same bytes will fail identically forever. `400` ends the retry loop; a `500` starts one that can never resolve.
6. *Why apply before settling?* — A crash between them leaves the order moved and the event pending, which a later drain re-applies as a harmless no-op. The reverse order leaves the event marked done and the order unmoved — the only sequence that can lose a payment result. And the settle carries `AND processed_at IS NULL`, so a re-drain cannot rewrite when the event was first settled.
7. *Why is a missing order left pending but an unknown status settled?* — Because the question is "could a later attempt know more?" An order can appear a millisecond later; an unrecognised status will be just as unrecognised tomorrow, and a row that can never be settled is a permanent occupant of the queue.
8. *What did the concurrency run prove, and why four processes?* — One API process with a pool of one serialises the requests, so the check-then-act would pass too. Across four processes the statements genuinely overlap: 20 events all stored, exactly one `UPDATE` matched `WHERE status = ANY('{created}')`, 19 no-ops, zero errors. One winner, chosen by Postgres, in a place no application code could have chosen it.
