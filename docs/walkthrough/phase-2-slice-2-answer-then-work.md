# Phase 2 · Slice 2 — The shop answers before it finishes the work

> Settles functional spec 002 §2.4 — all three of its criteria — and the payment contract's delivery guarantee: *«Ответ должен быть быстрым `200 OK` принято; `5xx` платежка повторит доставку»*.
>
> Phase 1 persisted, processed, then answered. This slice is where processing finally lands **after** the acknowledgement: 72 ms to answer, with the work still in flight.

---

## 1. What actually changed

Phase 1's webhook did four things in one request: parse the body, insert the event, **await** the processing, then answer `200`. The awaiting step had a `try/catch` around it whose only job was to stop a processing failure from becoming a `5xx`.

Now the controller does three things and stops:

1. parse the body far enough to write a row (`parsePaymentWebhookPayload`),
2. `INSERT … ON CONFLICT (event_id) DO NOTHING RETURNING *` (`PaymentEventsService.recordEvent`),
3. hand a **thunk** to a `ContinuationScheduler` and return `200`.

`docs/walkthrough/slice-3-webhook-inbox.md` §1 already argued *why* the order must be receive → persist → acknowledge → process, and it also said plainly that the last step was still running before the `200`: *"in this slice, processing still runs before the `200` … that is temporary and it does not break the pattern, because the pattern's load-bearing claim is about ordering, not latency."* This slice is where that last step finally lands after the acknowledgement. §1's argument is not re-derived here — read it there; the three provider promises (at-least-once, out-of-order, `5xx` means resend) are the whole basis of everything below.

The design that made the move cheap was already in place: `PaymentEventProcessor.processStoredEvent` takes a **stored row**, never a request body, so it does not care who calls it. Slice 3 predicted "this call site moves and nothing else does", and that is exactly what happened — plus a new `apps/api/src/scheduling/` module and a new drain service that is a second caller of the same processor.

The change, measured on a live instance. `SUPPLIER_A_URL` was pointed at a stub that accepts the connection and never answers, and `SUPPLIER_TIMEOUT_MS` raised to 30 s so the issuance could not possibly finish:

```
ack: {"event_id":"evt_01M1Z47BW9P42XBH6XJHB2DZZ1", … "webhook_outcome":"stored"}
payment response took 72 ms
order now: {"id":"ord_01M1Z47BSDK3W8HKFQ6ZGBP0Y8", … "status":"delivering","code":null}
```

72 ms to answer, while the work that order needs is stalled on a supplier that will never reply. In Phase 1 that same request would have sat there for the full supplier timeout and then answered.

## 2. Why "received" and "finished" must be different answers

A payment provider is not a human reading your error message. It is a machine with a retry policy, and that policy is keyed on your status code. So the status code is **an instruction**, and the only question worth asking about any response is: *do I want these exact bytes again?*

The rule in this codebase has three lines and no exceptions:

| Answer | Instruction | When |
| --- | --- | --- |
| `5xx` | "Send it again." | Exactly one case: we could not write the event to the inbox. |
| `400` | "Sending it again will not help." | A body that can never become a row. |
| `200` | "We have it; stop." | Everything else — including things that went wrong afterwards. |

The important consequence of moving the work after the response is that the handler **can no longer report how the work went**. There is no `try/catch` left in the controller, and no logger field either. That is not a limitation to apologise for — it is the point. In Phase 1, "a duplicate we ignored is a `200`" and "a processing failure is still a `200`" were *decisions the controller made and could have got wrong*. Now they are structural: by the time the processing can fail, the response is gone and there is no status code left for it to influence, even in principle.

**The incident that conflating them produces.** Suppose issuance fails — the supplier is down, a query errors, anything — and you let that failure become a `500`, which is what happens by default if you `await` the work and don't catch. Then:

1. The provider treats `500` as "they did not get it" and redelivers the same event on a backoff schedule.
2. The redelivery **loses** the `ON CONFLICT (event_id) DO NOTHING` insert, comes back `already_seen`, and is deliberately not processed — because processing every redelivery is the re-run of issuance that invariant I2 exists to prevent.
3. So the retry is *guaranteed* to change nothing. It cannot fix the thing that failed, and the thing that failed had nothing to do with receiving the event: the row was durable from the first millisecond.
4. The loop is self-sustaining. Nothing about the passage of time turns a duplicate into a first sight. Your error rate looks like an outage, the endpoint gets marked failing on the provider's dashboard, and some providers disable a webhook that fails long enough — because of one bad issuance.

There is a second, sneakier version that does not need any failure at all. If the work takes eight seconds and the provider's read timeout is five, the provider never *hears* your `200`. It redelivers, and now two copies of one event are in flight against the same order at the same instant. **Being slow manufactured the concurrency you then have to survive.** Answering in 72 ms instead of eight seconds removes that failure mode by removing its cause.

And the one case that genuinely deserves a `5xx` is preserved exactly: `PaymentEventsService.recordEvent` logs a failing insert with both correlation ids and **rethrows**. The database was unreachable; the event is durable nowhere; we sincerely want it again. That is the only path in the module that produces a `5xx`, and it is deliberate.

That maps one-for-one onto functional spec §2.4's three criteria: confirm promptly and complete as separate work; do not ask for a resend when something goes wrong *afterwards*; do ask when we genuinely could not record it.

## 3. What the scheduler guarantees that `void this.process(event)` does not

`void this.process(event)` compiles, passes review, and is correct about the happy path. It is wrong about three specific moments.

**A `SIGTERM` mid-flight.** A deploy, a container recycle, a Ctrl-C. With a floating promise the work vanishes with the process and — this is the expensive part — *nothing anywhere records that it did*. The event stays pending, which is recoverable by construction, but the shop cannot tell "nobody has started this yet" from "somebody started it and was killed at 14:03". With the tracked scheduler, that second case leaves a line. One was produced for real, by `SIGTERM`ing the instance while the hung supplier held the continuation open:

```
[TrackedContinuationScheduler] {
  msg: 'shutdown: waiting for in-flight continuations',
  in_flight: 1,
  timeout_ms: 5000
}
[TrackedContinuationScheduler] ERROR {
  msg: 'shutdown: gave up waiting for continuations; their work is left pending in the inbox for a later drain',
  abandoned: 1,
  waited_ms: 5001,
  timeout_ms: 5000,
  continuations: [
    {
      continuation: 'payment webhook continuation',
      order_id: 'ord_01M1Z47BSDK3W8HKFQ6ZGBP0Y8',
      event_id: 'evt_01M1Z47BW9P42XBH6XJHB2DZZ1'
    }
  ]
}
```

**The naming is the entire difference.** That is why the in-flight collection is a `Map<Promise, ContinuationContext>` and not a counter: "three continuations were lost" is not actionable; "these three orders and these three events were lost" is. And the state left behind is exactly what the log promises — the database after the process exited:

```
              id               |   status   | pending_events | attempts | attempt_status | deliveries
-------------------------------+------------+----------------+----------+----------------+-----------
 ord_01M1Z47BSDK3W8HKFQ6ZGBP0Y8 | delivering |              1 |        1 | unknown        |          0
```

Order in `delivering`, event still pending (`processed_at IS NULL` — still in the queue and still in the partial index), attempt recorded `unknown`. Recoverable, and *named*.

**A rejecting continuation.** A floating promise that rejects is an unhandled rejection, and Node 22's default for unhandled rejections is to **terminate the process**. One failed continuation would take out an instance that is in the middle of serving other people's requests. Hence `guardContinuation`, which both implementations route every unit of work through and which never rethrows. Its never-rejects property is not politeness, it is a contract two callers depend on: the tracked scheduler `Promise.all`s these promises during shutdown (a rejection there would throw out of the shutdown hook and abort Nest's `close()` part-way through, taking the database pool drain with it), and the Vercel implementation hands them to `waitUntil`, which attaches no handler of its own.

**A stuck continuation.** The obvious code is `await Promise.all(inFlight)` with no bound, and it is a trap: one continuation on a socket that never closes turns every Ctrl-C into a Ctrl-C followed by `kill -9`, and every deploy into a wait for the orchestrator's patience — after which the work is killed anyway, only later and with no log line. The bound converts "hangs indefinitely, then dies silently" into "waits a fixed time, then reports what it abandoned". In the run above the process printed the give-up line and **exited on its own**; nobody had to kill it.

There is a fourth, smaller thing: `schedule()` called *during* shutdown does not silently join a `Map` nobody is going to await. It runs the work anyway (the process is still alive; it may well finish) and warns that it is unprotected.

One nuance worth having ready, because it sounds like a weakness and is actually the design: **none of this is a guarantee, deliberately.** `architecture.md` §4 lists four processing triggers — this continuation, a drain on order creation, a drain on the status poll, and an admin sweep — precisely so that no single one is load-bearing. A dropped continuation costs latency, never a key. That is what licenses the deployment implementation (`waitUntil`) to promise nothing more than best effort, and why `guardContinuation` logs rather than retries.

## 4. The 5-second bound, and why it sits where it does

`SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000`, chosen against two neighbours:

- **Above the longest continuation this shop can legitimately produce.** The slowest is a payment continuation running a full issuance: a handful of short guarded `UPDATE`s either side of one supplier call, and that call is itself bounded by `SUPPLIER_TIMEOUT_MS`, which is 2000 ms locally. Two seconds of supplier plus statements against a local pool leaves well over half the budget spare, so a *healthy* continuation is never abandoned. If `SUPPLIER_TIMEOUT_MS` is ever raised past about 4 s, this constant has to move with it — that is the coupling to remember.
- **Below the shortest grace period anything gives us before `SIGKILL`.** `docker stop` sends `SIGTERM` and kills 10 s later by default; that is the reference supervisor. If the bound exceeded the grace, the process would be killed *mid-drain* and the give-up line — the entire point of the bound — would never print. A bound you never live long enough to report is not a bound, it is a delay.

It is a constant, not an environment variable, on purpose. `config/` exists for values naming something *outside* the process with no single right default; this names something inside it, has a right default, and is only meaningful in the environment where the tracked implementation is selected at all. A knob here would only ever get turned to work around a continuation that should have been made faster.

**Why the timer is deliberately not `unref`'d.** An `unref`'d timer does not hold the event loop open. So a process whose only remaining work is a continuation stuck on something that is *not* pending I/O would exit before the timeout fires — skipping the give-up log, which is the one thing the bound exists for. Keeping it referenced costs nothing, because `clearTimeout` runs in the `finally` the moment the drain finishes: a clean shutdown is never delayed by a pending timer. This is the inversion of the usual advice ("unref your timers so they don't keep the process alive") and it is right here for exactly the reason the usual advice is right elsewhere — here, keeping the process alive for those last milliseconds *is* the feature.

## 5. Nest's module destroy order, and why it is load-bearing

A continuation is almost always mid-query when `SIGTERM` arrives. So the shutdown drain is only useful if it runs **before** the database pool closes. That ordering is not something the code asks for; it falls out of the module graph, which makes it fragile in a way that is invisible unless you know the rule.

Nest destroys modules in **ascending** distance from the root. Verified in `@nestjs/core` 11.2.3, `nest-application-context.js`:

```js
async callDestroyHook() {
    const modulesSortedByDistance = [...this.getModulesToTriggerHooksOn()].reverse();
    for (const module of modulesSortedByDistance) {
        await callModuleDestroyHook(module);
    }
}
// getModulesToTriggerHooksOn(): compareFn = (a, b) => b.distance - a.distance
```

Sorted descending, then reversed — so shallow first, deepest last — and awaited **sequentially**, so distance 2 fully finishes before distance 3 begins. This graph:

```
AppModule = 1    SchedulingModule = 2    DatabaseModule = 3
```

`SchedulingModule` at 2 drains completely before `DatabaseModule` at 3 closes the pool. Neither number is an accident:

- `DatabaseModule` can never be shallower than 3, because nothing imports it from the root — only `catalog`, `orders`, `payments`, `issuance` and `suppliers/a` do, and each of those is itself at 2.
- `SchedulingModule` is pinned at 2 **by `AppModule` importing it directly**, even though `AppModule` injects nothing from it.

**The trap.** Import `SchedulingModule` from a module at distance 3 or more — `IssuanceModule`, say — and Nest re-parents it to 4, *behind* `DatabaseModule`. Every continuation still mid-query at shutdown then fails against a drained pool. It fails loudly (each one logs through `guardContinuation`, and its event stays pending for a later drain), but the shutdown guarantee this whole class exists for is gone, replaced by a burst of errors that look like a database problem.

**And the `AppModule` import does not protect you against that** — this is the part people get wrong. Nest's `TopologyTree` re-parents an already-seen module when it is re-encountered from a **strictly deeper** parent (`injector/topology-tree/topology-tree.js`):

```js
const existingDepth = existingSubtree.getDepth();
if (existingDepth < depth) {
    existingSubtree.relink(node);
}
```

A shallow link already recorded does not win; a deeper re-encounter *moves the subtree*. `PaymentsModule` importing `SchedulingModule` is safe because `PaymentsModule` is itself at 2, so `2 < 2` is false and nothing moves. `IssuanceModule` importing it would be `2 < 3` — true — and the module relocates to 4. The rule to carry: **add `SchedulingModule` to a module's `imports` only where that module is imported by `AppModule` itself.**

This is a good example of a general habit worth naming in an interview: a correctness property that depends on framework ordering should be *written down next to the thing that depends on it*, with the mechanism and the specific edit that would break it. It is in the `onModuleDestroy` doc comment, in `scheduling.module.ts`, and in `app.module.ts` — three places, because there are three places someone might edit it from.

## 6. The drain, and the honest limit of `SKIP LOCKED`

The drain claims one pending row at a time:

```sql
begin;
select … from "payment_events"
where ("payment_events"."processed_at" is null
       and "payment_events"."order_id" = $1
       and "payment_events"."event_id" <> ALL($2))
order by "payment_events"."received_at"
limit $3 for update skip locked;
commit;
-- 1 row  => THIS worker claimed that event.
-- 0 rows => nothing pending, OR every pending row is held by another worker.
--           Both mean "not my work". NEITHER IS AN ERROR.
```

`SKIP LOCKED` buys **dispatch exclusion**: two drains reaching for the queue at the same instant never take the same row, and the loser steps over it onto the next pending row rather than queueing behind it. Without it every drain serialises on the oldest pending row, and in this deployment (one pooled connection per instance) a request waiting on a row lock is holding its instance's only connection for the whole wait — the convoy stops being slow and starts being timeouts.

Both halves, demonstrated with three real Postgres sessions against `payment_events`:

```
worker A claims: evt_demo_1
worker B claims: evt_demo_2   <- stepped over A's row, did not block
worker C claims: evt_demo_3

-- A commits its one-statement claim transaction and starts processing (supplier call) --
worker A, a moment later, claims: evt_demo_1   <- the SAME event it is still processing
```

That last line is the honest limit, and you should volunteer it rather than be caught by it: **the lock dies at `COMMIT`, so the claim is dispatch exclusion, not durable ownership.** A drain starting a moment later can re-take an event whose processing is still in flight.

**Why that is safe.** Nothing about correctness rests on the claim. Every write the processor makes is adjudicated by Postgres against the row itself:

- `markPaid` and `beginIssuance` are **status-guarded `UPDATE`s** — the second worker matches zero rows and does nothing (I9; I4's headline, *only one worker advances an order*).
- `deliveries.order_id` is **UNIQUE**, so a second worker cannot bind a second key even if it got that far (I3).
- the supplier's `request_id → code` **ledger** returns the original code rather than issuing another (I5).
- the settle carries **`AND processed_at IS NULL`**, so a re-drained event cannot rewrite when it was *first* settled.

So a worker that re-picks an in-flight event runs a handful of statements that match nothing and returns a no-op. That is the cheap direction of the trade. The expensive direction — a claim that holds its lock across the supplier call — buys tidier bookkeeping and stalls the instance (§7).

The measurement from the drain task's verification run makes the point numerically: **30 claims for 12 events across 3 processes produced exactly 12 supplier calls.** Read those numbers carefully, because they say two different things at once. Thirty claims for twelve events means re-claiming genuinely happened, repeatedly — the limit above is real, not theoretical. Twelve supplier calls means it cost nothing, because the adjudication is in the constraints and not in the claim. A design where the claim *were* the exclusion would have needed those two numbers to be equal, and would have had to hold a lock across an HTTP call to make them equal.

One more detail in the statement: `event_id <> ALL($2)` is **loop control, never exclusion**. A `paid` event whose order is still in flight, and an event whose order does not exist yet, are both left pending on purpose — so `ORDER BY received_at` alone would hand the same unsettleable row back on every iteration and one permanently-pending row would hide the entire rest of the queue from the admin sweep. The list lives in the process, is discarded when the pass ends, and no guarantee depends on it: a row this pass stepped over is picked up by the next trigger, which is why there are four of them.

## 7. Why the claim transaction holds one statement and commits before processing

This looks like a style choice — "keep transactions short" — and it is not. Holding it across `processStoredEvent` **self-deadlocks**.

The pool is `max: 1` per instance (`packages/db/src/client.ts`). Drizzle checks that single connection out for the whole of `transaction()`. `processStoredEvent` runs its transitions through `OrderTransitionService.transition`, which asks **the pool** for a connection. The only connection is the one the enclosing transaction is holding. So the first guarded `UPDATE` waits `CONNECTION_TIMEOUT_MS` for a connection **its own caller owns**, and then fails with an error that names a timeout and says nothing about the cause. That is the worst class of bug in this codebase: the error message points at the database, and the fault is a transaction boundary two call frames up.

Even without the deadlock it would be wrong on availability grounds. A transaction held across `POST {SUPPLIER_A_URL}/issue` stalls *every other statement the instance wants to run* for up to `SUPPLIER_TIMEOUT_MS` — the symptom being unrelated requests timing out, which is the hardest failure here to trace back to its cause.

Two rules generalise out of this, and both are worth saying out loud in an interview:

- **Never hold a database transaction across a network call you do not control.** Your transaction's lifetime becomes some other service's latency.
- **In a one-connection pool, "waiting for a connection" and "holding a connection" are the same deadlock.** Which is also why `runPass` carries a warning never to call a drain from inside an open transaction — order creation must commit its order *first* and drain afterwards. That happens to be the only sensible order anyway: an event cannot be applied to an order that is not yet visible to other connections.

The processor is written against the pooled client on purpose. Passing it a `tx` handle is not a small change — it is a different processor.

## 8. The `timestamptz`/`Date` bug

The claim's loop control was first written as the obvious thing: a keyset cursor, `(received_at, event_id) > (…)`. It silently did not work, and the reason is worth carrying beyond this codebase.

`received_at` is `timestamptz`. Postgres stores it to **microsecond** precision. node-postgres parses it into a JavaScript `Date`, which holds **milliseconds**. Bind that `Date` back as a cursor and you are comparing each row against a *truncated copy of its own timestamp* — so `received_at > $cursor` is true for the very row the cursor came from. Both halves were reproduced.

Postgres, showing the truncation:

```
         received_at          | still_after_its_own_cursor
------------------------------+----------------------------
 2026-09-07 23:29:20.48987+00 | t
```

And the full round trip through the actual driver this app uses (pg 8.23.0):

```
postgres value : 2026-09-07 23:29:37.430058+00
js Date        : 2026-09-07T23:29:37.430Z (typeof: object -> Date)
row_is_after_its_own_cursor: true
```

Fifty-eight microseconds, thrown away by the type on the way out, and the cursor never advances past the row it came from. Measured before the fix as **one drain claiming the same `event_id` five times inside a single pass**.

**The general rule: never build a cursor on a value that loses precision crossing the driver boundary.** If you want a timestamp cursor, you have to keep it lossless — select it as `text` or as epoch-microseconds and bind it back in the same representation — or use a key that cannot lose anything. This code takes the second option: the primary key does not round-trip through a lossy type, so the exclusion list compares the value the database actually holds.

The part that makes it a genuinely instructive bug: **it is invisible in an ordinary single-process run.** If every event a pass claims gets settled, the settled row drops out of the `processed_at IS NULL` filter and the broken cursor never gets a chance to hand it back. The bug only surfaces when a pass legitimately leaves a row pending — an event whose order does not exist yet, or whose order is already in flight — which is precisely the case this system creates on purpose and which a happy-path test never produces. It survives code review too, because the cursor is textbook-correct as written; the fault is in the type system of the wire, not in the SQL or the TypeScript.

## 9. What this cost the test suite, and what that taught

**The predicted failure mode was wrong, and the real one was more interesting.**

The prediction was that some acceptance test would fail because processing was no longer inline. No individual `it` failed — every paying test already polls `waitUntilSettled`, which is exactly what the browser's own order page does. What failed was the **suite-level baseline guard**: `supplier_keys unclaimed = 49, expected 50`.

The mechanism: §2.3 AC1 was the one test that paid an order and then cleaned up without waiting for it to settle. So the continuation **outlived `cleanupTestOrders`**. The test deleted its order; the still-running issuance then claimed a key and wrote a `supplier_requests` row; the dirty-database guard caught the leftovers after the whole suite finished. There was a knock-on, too: a second `pnpm test` then failed the *concurrency* suite's `beforeAll` guard on the residue of the first run.

Three things to take from that:

- **Moving work off the response path changes lifetimes, not just timings.** Your teardown is now racing work you no longer await. A test can pass on every assertion and still leak, and the thing that catches it is a guard that looks at the world *after* the tests, not at any one test.
- **The guard was right; do not weaken it.** The instruction on the task said so explicitly, and it is the correct instinct: the assertion that fails when your mental model is wrong is the most valuable assertion you own. The fix was to make the test wait before cleaning up, not to teach the guard to tolerate 49.
- **The RED step surfaced a masked failure.** Validating the fix meant putting the assertions back *before* the wait to watch it fail — and what came out was not the assertion error. An exception thrown inside `finally` **replaces** the exception propagating out of `try`. So cleanup's foreign-key violation (deleting `orders` while the continuation was still inserting `issuance_attempts` rows that reference it) overwrote the real assertion error entirely. You would have debugged a database error that was a symptom, while the assertion that actually fired was never printed.

  Hence the ordering the test now uses and documents: **wait first, then assert**, so that no assertion failure can strand cleanup mid-continuation. It is a small structural rule with a large payoff — *cleanup that can throw will hide the failure it follows.*

## 10. Where this sits in the assignment

**What §2.4 settles.** All three of its criteria, and they are now settled *structurally* rather than by careful coding: the shop confirms receipt promptly and completes the order as separate work; a failure while completing does not ask the payment service to resend, because there is no longer a status code for that failure to reach; and a genuine failure to record still answers "yes, send it again", because `recordEvent` rethrows.

**What it makes possible in the slices that follow** — this is the slice with the most reach in the phase, and that is worth being explicit about:

- **Slice 3 (a payment reported before its order still delivers).** The drain built here is the machinery; Slice 3 wires it to its three remaining triggers (order creation, the status poll, the admin sweep). Out-of-order handling stops being "the event is stored correctly and nothing applies it" and becomes real.
- **Slice 4 (the shopper watches the stages).** Spec 001 §2.4 had to be *reworded down* during Phase 1 verification because the whole chain finished in about 60 ms inside the reporting request and nobody could see `paid` or `delivering`. Now the stages persist long enough to be observed — the live run above showed `delivering` for as long as the supplier stayed quiet — so the original promise can be restored rather than walked back.
- **Slice 5 (only one worker advances an order).** Phase 1 had a single entry point into issuance, so I4's `SELECT … FOR UPDATE` had nothing to defend against. The drain *is* the second worker. The lock arrives with it, and §6's "dispatch exclusion, not durable ownership" is exactly why it is needed.
- **Slice 6 (the reviewer's race scripts).** Fifty simultaneous `paid` reports for one order now get fifty prompt `200`s, so the headline scenario measures the constraints rather than the supplier's latency under load.

And the one sentence that ties this slice to the assignment's own framing: *the shop can answer quickly precisely because answering and finishing are different questions, and only one of them is the provider's business.*

---

## Interview questions this answers

**Why does the webhook return `200` before the order is delivered? Isn't that lying?**
No — it is answering the question that was asked. `200` means "this event is durable and we own it now", not "the work is finished". The provider's only decision is whether to send it again, and once the row is committed the answer is never yes. Claiming otherwise is the false statement, not this.

**When *do* you return `5xx`?**
Exactly one case: we could not write the event to the inbox. That is the only situation where redelivery helps. Everything we handled correctly, and everything a retry cannot fix, is `200`; a body that can never become a row is `400`, because identical bytes fail identically forever and `400` ends the loop instead of starting one.

**What's wrong with `void this.process(event)`?**
Three things. A `SIGTERM` kills it with no record that it ever started, so you cannot tell "not begun" from "begun and lost". A rejection is an unhandled rejection, which in Node 22 terminates a process that is serving other requests. And an unbounded wait on shutdown hangs until something sends `SIGKILL`, at which point the work dies anyway, later and silently. The tracked scheduler finishes what it can within 5 seconds, catches everything, and names the `order_id` and `event_id` of whatever it had to abandon.

**Why five seconds?**
Above the longest legitimate continuation — one supplier call bounded at 2000 ms plus a few short guarded `UPDATE`s — and below the tightest supervisor grace before `SIGKILL`, `docker stop`'s 10 s default. If the bound exceeds the grace, the process is killed mid-drain and the give-up line never prints, which removes the only reason the bound exists.

**If the claim's lock is released before the work starts, what is stopping two workers from issuing two keys?**
Not the claim — the constraints. `SKIP LOCKED` buys dispatch exclusion so two drains never take the same row at the same instant, and nothing more; a drain starting a moment later can re-take an event still being processed. That is safe because every write is adjudicated by Postgres: status-guarded `UPDATE`s, `UNIQUE` on `deliveries.order_id`, the supplier's `request_id → code` ledger, and `AND processed_at IS NULL` on the settle. Measured: 30 claims for 12 events across 3 processes, and exactly 12 supplier calls.

**Why doesn't the claim transaction stay open across the processing?**
Because it would self-deadlock. The pool is one connection per instance; the processor asks the pool for a connection, and the only one is the one the enclosing transaction holds, so the first `UPDATE` waits out the connection timeout for a connection its own caller owns and fails with an error naming a timeout instead of its cause. Even without that, holding a transaction across the supplier's HTTP call stalls every other statement in the instance for the length of that call.

**What did moving processing off the response path break?**
No test assertion — the suite's baseline guard, because a continuation outlived the test's cleanup and claimed a key after the order row was deleted. The lesson is that asynchronous work changes lifetimes, not just timings, and your teardown is now racing work you no longer await. The fix was to make the test wait before cleaning up. Validating that fix also exposed a masked failure: an exception thrown in `finally` replaces the one from `try`, so the cleanup's FK error had been hiding the real assertion error.

---

## Source files

- `apps/api/src/payments/payment-webhook.controller.ts`
- `apps/api/src/scheduling/continuation-scheduler.ts`
- `apps/api/src/scheduling/tracked-continuation-scheduler.ts`
- `apps/api/src/scheduling/scheduling.module.ts`
- `apps/api/src/app.module.ts`
- `apps/api/src/payments/payment-event-drain.service.ts`
- `apps/api/test/acceptance/purchase-and-key-delivery.test.ts`
- `packages/db/src/client.ts`
- `context/product/architecture.md` §4
- `docs/walkthrough/slice-3-webhook-inbox.md` §1, §3

**On evidence:** the 72 ms acknowledgement against a hung supplier stub, the `SIGTERM` give-up log line, the database state captured after that process exited, the three-session `SKIP LOCKED` demonstration and the `timestamptz`/`Date` round trip were all captured live during this slice; the database was returned to its seeded baseline (0 orders, 0 payment events, 50 unclaimed keys) and the temporary stub processes and scripts were stopped and deleted. The 30-claims-for-12-events-across-3-processes figure is the drain task's own verification result, reported rather than re-run.
