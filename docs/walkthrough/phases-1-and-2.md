# Phases 1 and 2 — one argument, and the question each part of it answers

> Every other document in this folder explains **one slice**. This one is the map. `phase-1.md` and
> `phase-2.md` each make their own argument once; this document says why they are *the same argument*, and
> gives the single answer to each question an interviewer is likely to ask — so that being asked them in any
> order does not require remembering which document they came from.
>
> Nothing here is new evidence. Every number is quoted from the walkthrough named beside it, which records
> how it was captured. No source file was read for measurements and none was modified.

---

## 1. The spine

Phase 1 and Phase 2 are not two projects with a shared repository. There is **one claim**, and it has two
halves that fail in opposite directions:

> **A key that has been given to one shopper is never given to another, and one payment produces exactly one
> key.**

Break the first half and you have sold the same key twice. Break the second and you have either taken money
and delivered nothing, or burned two keys out of the pool for one payment. Every decision in both phases is
in service of one of those two, and one rule decides *how* each is enforced:

> **Every guarantee is enforced by the database — never by a check in application code, never by a lock
> inside one process.**

The reason is structural, not stylistic. The API runs as serverless functions: two simultaneous requests are
**two separate operating-system processes with no shared memory**. A flag, a `Map`, a mutex or an `if` in one
does not exist for the other. That is why such a guard passes every test on a laptop and evaporates in
production, and it is why the guard is not merely *unreliable* — it is **not a mechanism at all**. The one
thing the two processes share is Postgres, so Postgres is the only place a decision can be made.

Everything else follows from that sentence, including the awkward parts: why zero returned rows is a normal
answer rather than an error, why a duplicate webhook is a `200`, why an unfinished payment report is left
unfinished on purpose, and why a race check pointed at one process proves nothing.

### The four layers, and what each alone fails to do

| Layer | Built in | What it establishes | What it alone would fail to do |
|---|---|---|---|
| **1. The records decide, not the code** | Phase 1 | Named states with guarded transitions; UNIQUE rules; the supplier's `request_id → code` ledger | Tell two clicks from two purchases (I1 was in the schema but unwired), and pick up a report that arrived before its order — the row was stored, and nothing came back for it |
| **2. The server owns the state; the page reports it** | Phase 1 | The delivery decision, the price and the key all live server-side; the page is a reader | Show anything. The whole chain finished in ~19–60 ms inside the webhook request, so the shopper saw `created` and then `delivered` |
| **3. The world is allowed to misbehave** | Phase 2 | An intent has a name; a repeat is a `200`; the answer goes out before the work | Nothing, without layer 1. Each of these is a check-then-act unless a constraint adjudicates it: the intent key without a UNIQUE rule is a `Map`; the `200` without the `event_id` PRIMARY KEY is a guess; the scheduler without the inbox and its four triggers is a promise you can drop |
| **4. Nothing is believed until it has been seen to fail** | Phase 2 | Every check was deliberately broken, the code rebuilt, the failure recorded, the source restored | Nothing on its own — but without it, layers 1–3 are assertions. Three assumptions a careful reader would have made from the source were tested and all three were wrong (§3.4) |

Layer 3 is the one people mean when they say "concurrency work", and it is the layer that **cannot be
correct on its own**. That is the single most useful thing to be able to say about the two phases together.

---

## 2. The question → answer index

One line each: which argument answers it, and where the evidence is. The expanded answers are in §3, in the
same order.

| # | The question | The one argument that answers it | Evidence |
|---|---|---|---|
| Q1 | Why Postgres, and why Drizzle rather than Prisma? | Postgres is the subject of the assignment, not a storage choice; Drizzle because `FOR UPDATE` is typed rather than a raw-SQL escape hatch | `architecture.md` §2 |
| Q2 | Why `ON CONFLICT` rather than checking first? | A check followed by an act has a gap, and the gap is where the other process lives. Twenty sessions, every check correct, twenty keys | `slice-1-data-model.md` §5 |
| Q3 | Why a state machine and not a `paid` flag? | `paid=true, delivered=false` is four different situations, and `delivering` is a claim that needs somewhere to live outside one process's memory | `slice-2-order-lifecycle.md` §2 |
| Q4 | What stops a double-click making two orders? | An `Idempotency-Key` naming the *intent*, minted per SKU in `localStorage`. The server half is the easy half | `phase-2-slice-1-…` §2–§3 |
| Q5 | Zero rows came back. What happened? | It depends on the statement, and one of the five cases must be split into two causes or it is wrong in both directions | `phase-2-slice-1-…` §5 |
| Q6 | Why is a duplicate webhook a `200`? | A status code returned to a machine is an instruction, not a description. `5xx` means "send it again", and no amount of resending turns a duplicate into a first sight | `phase-2-slice-2-…` §2 |
| Q7 | Why answer before doing the work? | Being slow *manufactures* the concurrency you then have to survive; and a failure in the work must not become the response | `phase-2-slice-2-…` §1 |
| Q8 | What's wrong with `void this.process(event)`? | Three specific moments: `SIGTERM`, a rejection, an unbounded wait. The tracked scheduler names what it abandoned | `phase-2-slice-2-…` §3–§4 |
| Q9 | Why is there no foreign key on `payment_events.order_id`? | A payment report is written by a stranger with no ordering guarantee. The FK would turn a millisecond race into a retry storm | `phase-2-slice-3-…` §1 |
| Q10 | Why four triggers rather than one? | Each of the first three is attached to something happening, which is what makes it useful and what makes it insufficient. The fourth is attached to nothing, which is what closes the set | `phase-2-slice-3-…` §3 |
| Q11 | Why `FOR UPDATE` on the order row but `SKIP LOCKED` on the inbox and the key pool? | Whether *any* row will do. Skipping is right for a queue and wrong for the one row you were handed | `phase-2-slice-5-…` §6 |
| Q12 | Did you prove the row lock was necessary? | No. The RED came back green ten times, and the reason is the best fact in the slice | `phase-2-slice-5-…` §3 |
| Q13 | Why can't the lock just wrap the supplier call? | The pool is one connection per instance, so a transaction across an HTTP call is an instance-wide outage | `phase-2-slice-5-…` §4 |
| Q14 | Why do the race checks need four processes? | One process has one connection, so a second claim queues inside Node. The same broken code hands out 20 distinct keys against one process and 9 against four | `architecture.md` §7; `slice-4-…` §9 |
| Q15 | What does a RED result that comes back **green** mean? | It is a real null result with an exact reason, and it is how you find out which invariant a check actually guards | `phase-2-slice-6-…` §4.3 |
| Q16 | So the guard is what makes the key count one? | No. Widen it so all fifty workers claim the order and the shopper still gets one key. The ledger and the UNIQUE rule do that; the guard saves forty-nine supplier calls | `phase-2-slice-6-…` §4.4 |
| Q17 | What can a reviewer run, and what does it still not cover? | `pnpm race` — five checks, four processes, twice in a row, pointable at a deployed URL. Plus `pnpm test:concurrency`, which is the one that actually guards the key claim | `phase-2-slice-6-…` §2, §7 |
| Q18 | What isn't finished? | Six honest gaps, each with the reason it was deferred rather than missed | §5 below |
| Q19 | You didn't write this — an AI did. | Ask about any decision in here. The walkthroughs exist to make sure that question is welcome | `interview-notes.md` |

---

## 3. The answers, expanded

Where two walkthroughs answer the same question differently, the better answer is given and the other is
named, with the reason for preferring it. Those are marked **▸**.

### Q1 — "Why Postgres, and why Drizzle rather than Prisma?"

Postgres is not a storage choice here, it is the subject. SQLite and file storage are explicitly permitted by
the assignment and **cannot demonstrate row locks or concurrent constraint enforcement**, which is the entire
graded topic. Postgres specifically for `FOR UPDATE SKIP LOCKED`, partial unique indexes and
`ON CONFLICT … RETURNING`.

Prisma is a fair question and deserves a fair answer rather than a dismissal: it handles interactive
transactions, atomic increments and column-to-column comparison natively, so most of this design would work.
Its **one real gap is pessimistic locking** — there is no `FOR UPDATE` in its query API, so every lock in this
project would drop to `$queryRaw`. In a codebase whose entire argument is "the locks and constraints are the
mechanism", pushing exactly those to raw strings is the wrong place to lose type safety. TypeORM has
first-class locking and weaker inference. Drizzle was chosen for typed locking and the lightest serverless
footprint.

The convention that follows from this is worth volunteering: **every correctness-critical Drizzle call carries
a comment with the exact SQL it emits**, and `architecture.md` §3.1 collects them in one place, so a reviewer
never has to know Drizzle to audit a guarantee.

Isolation stays `READ COMMITTED` deliberately. `SERIALIZABLE` would also be correct, and it **hides the
guarantee inside an invisible retry-on-conflict loop you cannot point at** — which is a bad trade in a project
graded on explaining its decisions.

*`architecture.md` §2; `slice-1-data-model.md` §7.*

### Q2 — "Why `ON CONFLICT` rather than checking whether it's already been done?"

This is the question the brief itself names as what candidates get wrong — `if (!order.delivered) { deliver() }`
— so the answer should be a measurement, not an opinion.

Twenty concurrent database sessions, released together by a clock barrier, all handling the same payment for
one order against a copy of the delivery table **with the unique index removed**. Each counts deliveries,
waits 200 ms for the supplier, and inserts if the count was zero:

```
--- 20 concurrent sessions, application check, NO unique index ---
 delivery_rows_for_ord_race | distinct_keys_handed_out
                         20 |                       20
```

Twenty keys for one order. **All twenty ran the count before any of them had inserted, so all twenty saw
zero — and every one of those checks was correct at the instant it ran.** The gap between reading and writing
is where the other nineteen live.

Against the shipped table the same twenty produce one delivery row **and twenty keys still burned** — a
unique index guarantees the *shopper* one key, but by then the money is spent. Put the claim guard in front
and the twenty produce one delivery, **one key**, and nineteen workers that never reached the supplier.

The precise attribution matters, because it is what makes the sentence survive a follow-up: **the unique index
is the guarantee; `ON CONFLICT DO NOTHING` only stops the loser raising an error.** Without the clause the
insert raises `duplicate key value violates unique constraint "deliveries_order_id_key"` — a crash instead of
a no-op, and no broken promise. The conflict target is always **named** rather than left bare, so the clause
forgives exactly one constraint; a future `NOT NULL` or `CHECK` failure still raises instead of being silently
reported to the payment provider as a duplicate.

*`slice-1-data-model.md` §5; `phase-1.md` Keystone 3.*

### Q3 — "Why a state machine and not a `paid` flag?"

Because `paid = true, delivered = false` is where *every* failure lands, and it is four situations needing
four different responses: nobody has claimed the order; a worker is at the supplier right now (**no other
worker may touch it**); the pool was empty; the supplier timed out and nobody knows whether a key was issued.
Two booleans cannot tell them apart.

The sharp version: **`delivering` is a state that exists only because concurrency exists.** It is not a fact
about the order, it is a *claim* — "this one is mine" — and booleans give that claim nowhere to live but one
process's memory, where the other process cannot see it.

Every move is one statement naming the states it may leave from:

```sql
UPDATE orders SET status = $2, updated_at = now()
WHERE id = $1 AND status = ANY($3)   -- $3 = permitted starting states
RETURNING *;
-- 1 row  => THIS call made the move. Nobody else can also have made it.
-- 0 rows => the order was not in a state this move may leave from.
```

Two real sessions on one order: A held its transaction open two seconds, B ran the identical statement 0.4 s
later and got `UPDATE 0` after **1615.395 ms**. B neither failed nor overwrote — it waited on A's row lock,
then re-checked its own `WHERE` clause against the *new* version of the row and matched nothing. **That
re-check is the whole mechanism, and it costs one clause.** Idempotency comes free with it: a duplicate report
is a caller who lost by three seconds instead of three milliseconds.

*`slice-2-order-lifecycle.md` §2.*

### Q4 — "What stops a double-click from making two orders?"

**▸ Two answers exist and only one is current.** `interview-notes.md` records the Phase 1 answer — *"today,
nothing on the server does; the disabled button is UX only"* — and that answer was correct and is now
obsolete. Use the Phase 2 answer. The Phase 1 answer survives only as the *reason* the fix has the shape it
has, and it is still worth saying in one clause: the server has never heard of a disabled button, and two
orders still arrive from two tabs, from a reload mid-flight, and from a client-side timeout on a request that
succeeded.

Every Buy click carries an `Idempotency-Key`: a random identifier minted **once per item** and kept in
`localStorage` — the one browser store two tabs of the same site share, and which survives a reload. The shop
stores it on the order behind a UNIQUE rule, and order creation is still exactly one statement:

```sql
INSERT INTO orders (id, client_request_id, sku, amount_minor, currency, status, created_at, updated_at)
SELECT $1, $2, sku, price_minor, currency, $3, now(), now()
FROM products
WHERE products.sku = $4 AND products.purchasable = $5
ON CONFLICT (client_request_id) DO NOTHING
RETURNING id, sku, amount_minor, currency, status;
```

Two rejected alternatives, and the second one is the answer worth giving:

- **Hash the request body.** Two deliberate purchases of the same game have byte-identical bodies, so a
  content hash calls the second one a duplicate and hands back the first order — complete with the key the
  shopper already owns. You have built a shop that can sell each game to each shopper **exactly once,
  forever**. *The same content is not the same intent.*
- **Mint the key in the click handler.** Here the server is *perfect* — right index, right conflict clause,
  right read-back — and **a double-click still buys two copies**, because two clicks mint two names and two
  names are two intentions by definition. The key would name *the click* rather than the purchase. Worse,
  every scripted check still passes, because a `curl` test that sends one key twice supplies the key the
  browser never reuses. The mechanism looks correct, protects nothing, and the suite is green.

That second failure is why this criterion **can only be verified by a real double-click in a real browser**
with the resulting order count read out of the database. Two scripted requests cannot fail this test, which
means they cannot pass it either.

Three smaller decisions, each with its cost stated: `localStorage` not `sessionStorage` (the latter is per-tab
by specification, and one criterion is that two tabs on one purchase produce one order); the name is cleared
on exactly one event — the create call having **resolved** with an order id (earlier and a click that appeared
to fail mints a fresh name and buys a second copy; later and a genuine second purchase is handed the first
order); and a 255-character limit, measured rather than assumed — a 3200-character key produced
`ERROR: index row size 3216 exceeds btree version 4 maximum 2704`. The non-obvious half of that: a *long but
repetitive* key inserts fine because Postgres compresses it first, so the values that hit the ceiling are
precisely the **good** keys, since a good idempotency key is random and random data does not compress.

*`phase-2-slice-1-one-order-per-intent.md` §2–§7; `architecture.md` §3.1 (I1).*

### Q5 — "Zero rows came back. What happened?"

The convention is one sentence — **"zero rows" is a normal answer, not an error** — but the *meaning* is
per-statement, and reciting the convention without the specific meaning is the weaker answer. Five statements,
five meanings:

| Statement | 0 rows means |
|---|---|
| `INSERT … orders … ON CONFLICT (client_request_id)` | **Two causes**, and they must not be conflated — see below |
| `INSERT … payment_events … ON CONFLICT (event_id)` | We have seen this report before. Acknowledge `200`, do nothing |
| `UPDATE orders … WHERE status = ANY(...)` | Somebody else already advanced it, or it was never in a state this move may leave from |
| The key claim (`FOR UPDATE SKIP LOCKED LIMIT 1`) | Every key is claimed. Not an error — the caller is told `out_of_stock` |
| The inbox claim (`processed_at IS NULL … SKIP LOCKED`) | Nothing is waiting, **or** every waiting report is held by another worker. Both mean "not my work" |

The first row is the one an interviewer should push on. Zero rows from order creation means *either* the name
already made an order (a legitimate retry) *or* the item is not purchasable (a rejection). A follow-up read on
`client_request_id` separates them, and it runs **only** on the zero-row path, so the happy path is still one
round trip. Conflate them in one direction and a bad item code is answered with somebody else's order.
Conflate them in the other and a retrying shopper gets a `422` for an order that already exists, with their
money gone and no page to look at. The specific case the split saves: a shopper retries, and in the meantime
the item was withdrawn from sale, so the insert now fails for *both* reasons at once — the read-back finds the
order and returns `200`. **A `422` never displaces a `200`.**

And the follow-up read cannot miss a winner that is about to commit — this is structural, not a timing
assumption. When an insert collides with a row belonging to an unfinished transaction, Postgres **waits** for
that transaction to end and then looks again. If it aborted, the collision is gone and we insert and win. If
it committed, we get zero rows *and its row is now committed*, so the follow-up read's snapshot is taken
afterwards and cannot miss it. There is no ordering of events in which the loser sees nothing. No retry loop,
no sleep, and deliberately no transaction wrapping the pair.

*`phase-2-slice-1-…` §5, §8.*

### Q6 — "Why is a duplicate webhook a `200`? Isn't that lying?"

No — it is answering the question that was asked. The status code returned to a payment provider is **an
instruction, not a description**, because that provider is a machine with a retry policy keyed on it. The only
question worth asking about any response is: *do I want these exact bytes again?* Three lines, no exceptions:

| Answer | Instruction to the provider | When |
|---|---|---|
| `5xx` | "Send it again." | Exactly one case: the shop could not write the report down |
| `400` | "Sending it again will not help." | A body that can never become a row |
| `200` | "We have it; stop." | Everything else — **including a duplicate, and including things that went wrong afterwards** |

`409 Conflict` reads like the honest answer and is a self-sustaining loop: the provider treats the error as
"they did not get it", redelivers on a backoff, the redelivery is also a duplicate, and **the retry is
guaranteed to change nothing** — nothing about the passage of time turns a duplicate into a first sight, and
the thing that failed had nothing to do with receiving the report, which was durable from the first
millisecond. The error rate then looks like an outage, and some providers disable a webhook that fails for
long enough. Because of one bad issuance.

The mechanism is that the report's own identifier is the table's PRIMARY KEY and the insert carries
`ON CONFLICT (event_id) DO NOTHING`. **Winning that insert *is* "first sight"; losing it *is* "duplicate".**
There is no separate detection step to get wrong, no `SELECT` beforehand, and no window between checking and
acting.

The evidence is a RED validation that failed in two independent ways at once. That single clause was deleted,
the code rebuilt, and one report delivered twenty times:

```
race:same-event, with ON CONFLICT (event_id) removed:
  HTTP 500 × 19 of 20
  outcome assertion: stored=1, duplicate=0, unrecognised=19
```

The `500`s say the **acknowledgement** broke — nineteen of twenty redeliveries got exactly the error that
starts the retry storm. The `duplicate=0` says the **classification** broke — without the clause the shop can
no longer tell first sight from already-seen at all. A check that only counted database rows would have caught
half of it.

*`phase-2-slice-2-…` §2; `phase-2-slice-6-…` §4.1; `architecture.md` §3.1 (I2).*

### Q7 — "Why does the work happen after the answer?"

**The sentence to remember: being slow *manufactures* the concurrency you then have to survive.** The failure
needs no failure at all. Suppose the work takes eight seconds and the provider's read timeout is five. The
provider never *hears* the `200`, so it redelivers — and now two copies of one report are in flight against
the same order at the same instant, created by nothing but the shop's own latency.

The second failure mode is Q6's loop from the other end: awaiting the work means a failure *in* the work
becomes the response, and the response is an instruction to send it again.

So the endpoint does three things and stops — parse far enough to write a row, insert it into the inbox, hand
the rest to a scheduler that runs after the response has gone. The order is **receive → persist → acknowledge
→ process**, and only the first two are the provider's business. Measured against a supplier stub that accepts
the connection and never answers, with the supplier timeout raised to 30 s so the work could not possibly
finish: **72 ms to answer**, order left in `delivering`, work still hanging. In Phase 1 that same request would
have sat there for the full supplier timeout.

There is a structural gain worth naming, because it is stronger than the latency one: the handler **can no
longer report how the work went.** There is no `try`/`catch` left in it and no place for one. In Phase 1, "a
duplicate is a `200`" and "a processing failure is still a `200`" were decisions the controller made and could
have got wrong. Now they are unreachable — by the time the work can fail, the response is gone and there is no
status code left for it to influence, even in principle.

*`phase-2-slice-2-…` §1–§2.*

### Q8 — "What's wrong with `void this.process(event)`?"

It compiles, passes review, and is correct about the happy path. It is wrong about three specific moments.

- **`SIGTERM` mid-flight** — a deploy, a container recycle, a Ctrl-C. A floating promise dies with the process
  and, expensively, *nothing records that it did*. The report stays unfinished, which is recoverable by
  construction, but the shop cannot tell "nobody has started this" from "somebody started it and was killed at
  14:03". The tracked scheduler leaves a line, produced for real by sending `SIGTERM` while a hung supplier
  held the work open:

  ```
  ERROR shutdown: gave up waiting for continuations; their work is left pending
        in the inbox for a later drain
    abandoned: 1, waited_ms: 5001, timeout_ms: 5000,
    continuations: [ { order_id: 'ord_01M1Z47BSDK3W8HKFQ6ZGBP0Y8',
                       event_id: 'evt_01M1Z47BW9P42XBH6XJHB2DZZ1' } ]
  ```

  **The naming is the entire difference.** The in-flight collection maps each promise to its context rather
  than being a counter, because "three continuations were lost" is not actionable and "these three orders and
  these three reports were lost" is.
- **A rejecting continuation.** An unhandled rejection in Node 22 **terminates the process** — one failed unit
  of work taking out an instance in the middle of serving other people's requests. Every unit goes through a
  guard that never rethrows.
- **An unbounded wait.** One continuation stuck on a socket that never closes turns every Ctrl-C into a Ctrl-C
  followed by `kill -9`. The bound is **5 seconds**: above the longest legitimate continuation (one supplier
  call, capped at 2000 ms locally, plus a few short statements) and below the tightest grace period anything
  gives before `SIGKILL` (`docker stop` kills 10 s after asking). **A bound you never live long enough to
  report is not a bound, it is a delay.**

None of this is promised as a guarantee, deliberately — which is the point of Q10's four triggers. **A dropped
continuation costs latency, never a key.**

*`phase-2-slice-2-…` §3–§4.*

### Q9 — "`payment_events.order_id` has no foreign key. Isn't that a data-integrity bug?"

No, and `deliveries.order_id` ten lines away is what proves it was a decision rather than an oversight. The
rule is *who can write this row before the order exists*. A delivery is only ever written by code that has
already read the order, so a dangling reference there is a real bug and the FK belongs. A payment report is
written by a **stranger**, on a different connection in a different process, with no ordering guarantee
against the shopper's own request — so an early report is legitimate.

Add the "obvious" FK and the insert raises, the endpoint returns `5xx`, the provider retries, the order still
does not exist a hundred milliseconds later, and **a race that cost nothing has become an on-call incident.**

The general shape is worth naming once: **a constraint is a statement about what rows may exist, and it is
retroactive. Adding one is never a local change.**

*`phase-2-slice-3-…` §1; `slice-1-data-model.md` §4.*

### Q10 — "Why four triggers rather than one?"

Storing a report correctly is not the same as handling it, and Phase 1 had only the first half: an early
report sat with nothing coming back for it. **A durable queue with no consumer is a log file with ambitions.**

Each of the first three triggers is attached to something happening, which is simultaneously what makes it
useful and what makes it insufficient:

| Trigger | Fires when | Therefore cannot fire when |
|---|---|---|
| the webhook's own follow-up work | a report arrives *and* the process survives long enough | the process is recycled between the `200` and the work |
| a sweep when an order is created | the order is created **after** the report arrived | the report arrives after the order |
| a sweep when the shopper's page polls | somebody has that order's page open | nobody is looking |
| an operator's sweep | an operator asks | — |

**The fourth requires nothing, and that is not a weaker property — it is the only one that makes the set
closed.** Compose the first three gaps and you get an ordinary story, not a contrived one: a shopper pays,
closes the tab, and the instance handling the webhook is recycled between the `200` and the work. Money taken,
no key, and every automatic mechanism has legitimately already run and legitimately found nothing to do.

The layering is also what lets each individual trigger be *cheap*: because none is load-bearing, trigger 2 can
decline to retry and trigger 3 can be gated behind an `EXISTS`.

If asked for a case where the redundancy actually did something — it was not staged. In the genuine race run
for verification, the report landed first, the order was created, and **the creation drain, the trigger
written for exactly this scenario, missed it.** The order sat in `created` with the report pending, unchanged
after two seconds. The shopper's next page load fired the status-poll drain, which applied it and issued the
key. A passing test proves the primary path works; that run proves the system survives the primary path
failing for a reason nobody predicted.

*`phase-2-slice-3-…` §2–§4.*

### Q11 — "Why `FOR UPDATE` on the order row, but `SKIP LOCKED` on the inbox and the key pool?"

This is the best "do you understand your own tools" question in the project, because the same repository uses
row locks three times and answers this question **differently for each**, on one rule:

> Ask whether *any* row will do. If the work is "give me a unit nobody else has", skip. If it is "this
> specific row I was handed", wait.

- **The key pool** — any unclaimed key will do. `SKIP LOCKED`. Plain `FOR UPDATE` is also *correct* (Postgres
  re-evaluates the qualifier when the lock is released and moves to the next unclaimed row), but it
  **convoys**: twenty claims serialise at **959 ms against 54 ms**, which is almost exactly twenty times the
  hold time — what a lock convoy looks like when you plot it. With one connection per instance a convoy is
  instances stalling, and at the tail it becomes errors.
- **The inbox** — any unfinished report will do. `SKIP LOCKED`, so two sweeps reaching for the queue at the
  same instant never take the same row.
- **The order row** — `FOR UPDATE`, no skipping. The order is not *a* unit of work, it is **the** order this
  worker was handed; there is no other row to take. Skipping returns zero rows, which here is
  indistinguishable from "this order does not exist yet" — a normal path, precisely because `payment_events`
  has no FK (Q9). It would also throw away the answer the loser needs: a worker that waits, gets the lock and
  finds the order `delivered` can settle its report; a worker that skipped knows nothing and leaves a
  settleable report pending forever. And the 959 ms convoy does not transfer, because of what this lock does
  *not* span — the queue waits for a two-statement transaction with no network in it, not for the supplier
  call.

A related sub-question that catches people: **why `FOR UPDATE` and not `FOR NO KEY UPDATE`**, given only
`status` changes? That is the right default and it is wrong in this schema. `FOR KEY SHARE` — taken by the FK
check on every child insert — conflicts with `FOR UPDATE` and not with the weaker lock; measured at **2082 ms
versus 5.6 ms** for a concurrent `INSERT INTO deliveries`. The usual reasoning is that the extra blocking is
collateral damage on unrelated writers. Here it is not: the only two tables referencing `orders` are
`deliveries` and `issuance_attempts`, which are **the two writes issuance makes** — so the blocking is a
second independent layer of exactly the exclusion being bought. A future path that inserts a delivery without
taking the lock queues; the weaker lock would wave it through.

*`phase-2-slice-5-…` §5–§6; `slice-4-supplier-idempotency.md` §5.*

### Q12 — "Did you prove the row lock was necessary?"

**No — and that is the answer.** Concede it before it is extracted.

The lock and the guard exclude different things, and that framing has to come first or the concession sounds
like an admission of dead code. The **guard** excludes an illegal *transition*, and its exclusivity lasts
exactly one statement — the instant it commits it has no further opinion about anybody. The **lock** excludes
another *worker*, and lasts until `COMMIT`, so it can cover a decision spanning several statements. With only
the guard, the winner of `paid → delivering` is alone for one statement and then shares a five-statement
issuance with whoever else shows up. With only the lock, two workers that take it in turn both write
`delivering` and both call the supplier — perfectly serialised, each burning a key. **The lock serialises the
workers; the guard decides.**

Then the honest result: `.for("update")` was removed, the code rebuilt so the child processes ran the weakened
version, and the multi-process race run five times — **ten executions, green every time**. The reason is not
"the test was weak":

> **Two concurrent `UPDATE`s on the same row already serialise on that row's write lock, whether or not
> anybody took an explicit lock first.** The second reaches the row, finds it held by the first's uncommitted
> write, and blocks; when the first commits, the second re-reads the newly committed version, re-evaluates its
> own `WHERE` against it, and reports zero rows.

So the status-guarded `UPDATE` is *already* indivisible by itself. The explicit lock moves the wait one
statement earlier; it does not change who wins. **Today that lock is defence in depth, not a load-bearing
mechanism, and it changes no observable outcome.**

It is in the diff anyway, for two reasons that are stronger for being accurate. **Phase 3 makes it
load-bearing**: the retry path stops deriving the supplier request identifier from the order alone — it has to
*read* the previous attempt first — and an operator's re-issue racing a timeout retry puts two legitimate
workers at one order, at which point "read the attempt, classify *unknown* versus *failed*, choose re-probe or
fall through to supplier B" is exactly the multi-statement read-then-act only a row lock protects. And **the
right time to add a lock is before the code that needs it**, so that code lands on an already-serialised path;
retrofitting locks into a working system one call site at a time is where deadlocks come from. The measured
fact that makes both arguments affordable is that it costs nothing on the current path.

**▸ One correction to carry.** `phase-1.md`'s "What is not finished" predicted this gap differently — that
*"two workers inside `delivering` with different attempt numbers is how a second key leaves the pool"*, with
Phase 3's retry supplying the second worker. Phase 2's drain arrived first, and when the lock was actually
implemented the assumed exposure **turned out not to exist**: all four triggers funnel through one guarded
`paid → delivering`, and the request id is deterministic per attempt, so even a double entry would send the
same `req_{order}_a_1`, collapse to one code in the supplier's ledger, and un-claim on rollback. Use the
Phase 2 answer. And **do not reach for `slice-1-data-model.md` §5's twenty-keys measurement to justify the
lock** — that arm used twenty *distinct* request ids and no claim at all, and an interviewer who reads it will
catch the mismatch.

*`phase-2-slice-5-…` §3; `interview-notes.md` "What isn't finished?".*

### Q13 — "Why not just hold the lock across the supplier call? That's obviously correct."

Because the pool is `max: 1` per instance, which makes **the connection a mutex rather than a resource with
headroom**. A transaction held across an HTTP round trip blocks every other database statement in that
process — catalogue, order creation, webhook intake, every status poll — for up to `SUPPLIER_TIMEOUT_MS`
(2000 ms). A slow supplier becomes a total instance outage with unrelated requests timing out.

So: two short transactions bracketing the call. And the exclusion *for the call itself* is not a lock at all —
it is the `delivering` claim, a **durable state change that outlives the transaction that made it**. A worker
that got zero rows from the guard does not call the supplier, and it cannot get one row later, because nothing
returns an order to `paid`.

The same reasoning explains why the inbox claim's `SKIP LOCKED` hold ends at commit rather than lasting
through processing. What the claim buys is **dispatch exclusion**, not durable ownership: a sweep starting a
moment later can re-take a report whose processing is still in flight. That is safe because nothing about
correctness rests on the claim — every write the processing makes is adjudicated by Postgres against the row
itself. The measurement makes the point numerically: **30 claims for 12 reports across 3 processes produced
exactly 12 supplier calls.** Thirty-for-twelve means re-claiming genuinely happened, repeatedly; twelve
supplier calls means it cost nothing. A design where the claim *were* the exclusion would need those two
numbers to be equal — and would have to hold a transaction open across the supplier call to make them equal.

*`phase-2-slice-5-…` §4; `phase-2-slice-2-…` §6.*

### Q14 — "Why do the race checks need four processes?"

Because each instance holds a **single database connection** — that is the serverless shape, since fifty
concurrent invocations each holding ten would ask the database for five hundred. So within one process a
transaction holds that one connection for its whole life, and a second concurrent request **queues inside
Node, before a byte reaches Postgres**. `SKIP LOCKED` never skips, because nothing else holds a row lock when
it looks. The database never sees two statements in flight, so **no database-level mechanism is ever
exercised**, which means a shop with no locking at all passes.

Measured, not argued — the key claim weakened to an unlocked `SELECT`-then-`UPDATE`:

| Harness | Codes handed out | Distinct | Errors |
|---|---|---|---|
| 1 process | 20 | **20** | 0 |
| 4 processes | 20 | **9** | 0 |

**The same broken code is flawless against one process and hands eleven customers a key somebody else also
holds against four** — silently, nothing raised or logged in either case. And the count moves between runs
(9, then 12), which is itself the signature of a genuine race; a stable number would mean something is
serialising.

Two tempting fixes are rejected explicitly. **Raise the pool size for tests** — one line, and it proves a
different system correct, because that pool size *is* the configuration under test. **Fire fifty requests at
one dev server and call it a race** — this is what most projects ship, and it is the specific failure the
harness exists to prevent, not because it is lazy but because it is *convincing*: real traffic, real rows, a
green transcript, and a completely false statement about the system. **A race check that cannot fail is worse
than no race check, because it grows more convincing every time it passes.**

So the harness checks its own premise before any other check runs, by counting distinct Postgres backends —
one backend per open connection — that identify themselves as this shop, excluding its own session so it
cannot count itself into a pass. Pointed at `http://localhost:4301` and `http://127.0.0.1:4301`, two origins
that are very often one process:

```
PASS  http://localhost:4301 serves /api/health — HTTP 200, status="ok"
PASS  http://127.0.0.1:4301 serves /api/health — HTTP 200, status="ok"
FAIL  targets hold separate database connections — 1 distinct backend pid(s) as 'game-shop', need >= 2
```

Both targets are healthy; both would answer every request the other checks make; every assertion would pass
and prove nothing. **"Serving" and "separate" are exactly the two things it refuses to conflate.**

The honest limit, offered rather than extracted: four processes on one machine is weaker than four serverless
instances — same kernel, same clock, one loopback. It is the strongest thing that runs from one command, and
the strongest *form* runs against a deployed URL, which `RACE_BASE_URLS` supports without a rewrite.

*`architecture.md` §7; `slice-4-…` §9; `phase-2-slice-6-…` §2–§3.*

### Q15 — "What does a RED validation that comes back green mean?"

It means either a stale build or a **real null result**, and the difference is decided by checking `dist/`
before and after, which was done every time.

The one that came back green with a reason: `race:webhooks` names the **atomic key claim** among the
mechanisms it defends. That claim was gutted — `FOR UPDATE SKIP LOCKED` removed, leaving an ordinary read
followed by a separate write, with exactly the gap the single statement exists to close — and the check
**passed, 8 assertions of 8**, against a build confirmed weakened. The reason is exact: `race:webhooks` fires
fifty reports at **one** order, and only one worker is ever admitted to issuance, so the key claim is *called
once* in the entire check. There is no concurrency there for the weakening to expose.

Meanwhile the weakening is catastrophic, which the separate concurrency suite showed against that same build,
because it pays many orders in parallel:

```
AssertionError: N distinct keys — no code handed to two orders: expected 10 to be 20
AssertionError: exactly one order settles per available key:    expected 55 to be 50
```

Ten of twenty shoppers holding a key somebody else also held; fifty-five orders delivered from a fifty-key
pool. **So the check that guards the key claim is `pnpm test:concurrency`, and `race:webhooks` guards only the
rule that one worker advances one order** — which is what its own header says and all it should ever be
credited with.

That is the general lesson, and it is bigger than the finding: **RED validation is not a formality that
confirms a check can go red. It is the only way to find out which invariant a check actually guards.** Three
assumptions a careful reader would have made from the source were tested; all three were wrong. Nothing except
running it would have said so.

*`phase-2-slice-6-…` §4.3.*

### Q16 — "So the guarded transition is what makes the key count one?"

**No.** This is the second of the three wrong assumptions, and it is worth volunteering because it makes the
architecture legible.

The guard was widened so that fifty workers could all claim the same order. All fifty walked to the supplier.
And the shopper **still received exactly one key**, with every named assertion passing. Because the identifier
the shop puts on its request is computed from the order itself, so all fifty asked the supplier the *same
question*; the supplier keeps a `request_id → code` ledger it consults before touching a key, so it answered
all fifty with the *same code*; and the UNIQUE rule on `deliveries.order_id` let that code be bound exactly
once.

> **The supplier's ledger and `deliveries.order_id` UNIQUE are what make the key count one. The guard's job is
> stopping forty-nine workers from reaching the supplier at all** — measurable as `1` versus `50` lines of
> "claimed the order for issuance" in the logs.

That is not the guard being unimportant: forty-nine avoidable supplier calls is the difference between a shop
and a shop that is being drained, and Q2's twenty-keys measurement is the same point from the other side (the
unique index guarantees the shopper one key, *by which time the money is spent*).

**▸ One inconsistency to correct when quoting Phase 1.** `phase-1.md`'s invariant table gives I4's "Without
it" as *"Fifty webhooks start fifty issuances"*, which is right about issuances and reads as though it were
about keys. Say "fifty supplier calls, and still one key" — the stronger and more accurate claim.

And the honest note about *how* that breach was detected: `race:webhooks` did report it, three runs of three,
but through its **cleanup failing on a foreign-key violation** rather than through any assertion it makes.
That is a genuine limitation, recorded in the harness README rather than filed off. **A check whose failure
signal arrives via its teardown is a check that got lucky.**

*`phase-2-slice-6-…` §4.4.*

### Q17 — "What can a reviewer actually run?"

```sh
pnpm race                              # all five, against 4 freshly built local processes
pnpm race webhooks same-event          # only the named ones
pnpm race:webhooks                     # the same thing through the per-check alias
pnpm race --list                       # what exists; runs nothing, needs nothing running
RACE_BASE_URLS=https://…  pnpm race    # a deployed target: builds nothing, spawns nothing
pnpm test:concurrency                  # the suite that actually guards the key claim
```

`pnpm race` builds the packages, starts four real API processes, waits until each has served a real request,
runs every check against all four, and stops all four afterwards — on success, on failure, on a thrown
configuration error, and on Ctrl-C. Run twice consecutively with no tidying in between: **5/5 both times,
exit 0 both times**, with the database back at its seeded baseline (12 products, 50 unclaimed keys, 0 orders,
0 reports, 0 deliveries). That is earned by every check cleaning up in a `finally` block.

Which is worth one small confession, because it broke the exact property it existed to protect: the first
version of the `SKIP` outcome called `process.exit(3)` **inside the `try`**, which terminates immediately and
skips the `finally`, leaving the early payment report on disk so the next run started dirty. The fix is to set
a flag, fall out of the `try`, let cleanup run, and set the exit code at the end. **`process.exitCode` sets a
value; `process.exit()` is control flow wearing a value's clothes.**

Two things about the checks are worth knowing before a reviewer finds them:

- **`pnpm test:concurrency` is not redundant with `pnpm race`.** They answer different questions: `race`
  answers "does one order survive fifty reports", the Vitest suite answers "do N parallel orders yield N
  distinct keys". Q15 is why that distinction is not a matter of taste.
- **`before-order` can report `SKIP`.** It needs a configuration flag that lets the script choose an order id
  — off by default, failing closed when unset, set only for the instances the harness spawns, never in a
  deployment, and recorded in `architecture.md` §9 as a known trade-off. Against a deployed shop that
  correctly refuses it, the check prints `SKIP` and is subtracted from **both** sides of the ratio, so the
  summary reads `4/4 passed, 1 skipped`, never `4/5`. `FAIL` would report a correct system as broken and teach
  the reviewer to distrust the other four; `PASS` would count an unrun check as evidence, which is the
  decoration the criterion exists to forbid.

*`phase-2-slice-6-…` §2, §5–§7.*

### Q18 — "What isn't finished?"

Answered in full in §5 below, with the five adversarial scenarios scored beside it. Offer it unprompted if the
moment fits; it is the strongest single thing in the deck, and it is the only question where the honesty *is*
the technical answer.

### Q19 — "You didn't write this, an AI did."

> "I directed it. I chose the architecture — Postgres-enforced invariants over application checks — and I
> decided what shipped and what didn't. Ask me about any decision in here: why `delivering` is a state, why
> the supplier's whole contract is `request_id → code`, why zero rows is never thrown as an error. That's
> what the walkthroughs are for. I wrote them to make sure I could."

Do not get defensive; the follow-up will be technical, and that is a gift. The strongest supporting facts are
the ones where **the measurement contradicted the plan**: the lock whose RED came back green (Q12), the check
that did not guard what its header claimed (Q15), the guard that was not what made the key count one (Q16),
and the drain that missed the scenario it was written for (Q10). A generated codebase does not produce a
document that argues with itself and then records who won.

*`interview-notes.md`.*

---

## 4. What the two phases jointly prove that neither proves alone

These are the pairs worth having ready, because each one is an answer a summary of either document could not
produce.

**1. One key never reaches two orders — *and* that holds when the reports arrive fifty at once, out of order,
and duplicated.** Phase 1 established the mechanism and measured it by hand at twenty webhooks on one order.
Phase 2 took it to the assignment's stated fifty, added the same-`event_id` and before-the-order cases, and
made all of it **one command a reviewer runs themselves, twice in a row, against four processes.** Neither
half is worth much alone: Phase 1's proof lived in a transcript in a document, and Phase 2's harness would
assert nothing against a shop that had not already been built this way.

**2. The server owns the state — *and* the state is now visible.** Phase 1 made the page a reader: the key is
never sent for an undelivered order, the price is copied column-to-column, and nothing the browser does
participates in a decision. Phase 2 moved the acknowledgement to the front, which made the intermediate stages
observable. Either alone gives you a dishonest progress bar. Phase 1 alone is a truthful page with nothing to
show — the whole chain finished in tens of milliseconds. Phase 2 alone, with the page painting the stage
optimistically on click (which most storefronts do), would show «Оплачен» for a payment that just **failed**,
because the failing control also resolves.

The measurement is the good part, because it disproved the obvious explanation before the prose could be
written: webhook `200` → `delivered` was **~19–60 ms in Phase 1 and 25–65 ms in Phase 2 across 5 samples.**
The stages did not get longer. What changed is *when the shop answers*, so the page's refresh now fires at the
**start** of the work instead of after it. Nine real purchases showed the intermediate state 9 times out of 9,
held 1000–1060 ms, one page load, no reload — and the most convincing number is the **4/5 label split**
(four showed «Оплачен, готовим ключ», five «Выдаём ключ»). A scripted animation would show the same label
every time. That the label varies is the fingerprint of a genuine race being sampled.

**3. An early report is *stored* — *and* something comes back for it.** Phase 1's absent foreign key is what
lets the row exist at all; without it the insert raises, the endpoint returns `5xx`, and the provider's
retries turn a millisecond race into a storm. Phase 2's four triggers are what make it a delivery rather than
a log line. Neither alone is the assignment's third adversarial scenario, and each is the reason the other is
affordable: because the row is durable, no trigger has to be reliable; because the triggers are layered, the
absent FK never leaves anything stranded.

**4. The mechanism can fail — *and* the checks can fail.** Phase 1's RED weakened the key claim and got
`expected 9 to be 20` and `expected 55 to be 50`, which proves the *suite* was capable of red. Phase 2 applied
the same discipline to five checks and found something Phase 1's single exercise could not: **which invariant
each check actually guards.** One check passed 8/8 against a build confirmed weakened; one guard turned out
not to be what made the key count one; one check reported a breach only through its teardown. Together they
are the difference between "I test races" and "I know what each of my tests is evidence *of*".

**5. The column was written in Phase 1; the header in Phase 2.** `client_request_id` and its unique index were
in the schema from day one and were proven at twenty concurrent sessions **with no application code involved**
— before anything sent the header. Phase 1's "What is not finished" said exactly that: *the shape of the fix
was known before the fix was scheduled.* Phase 2 supplied the client half, and the hard part turned out to be
the half nobody writes down (where the key is minted, not what the SQL says). Jointly they demonstrate the
thing the interview is actually probing — deliberate sequencing — and the schema is the artefact that proves
it rather than a claim about intentions.

**6. "Zero rows is normal" and "a status code is an instruction" are the same sentence at two layers.**
Phase 1 established it inside the database: a losing `UPDATE` is a caller who arrived late, not an error.
Phase 2 established it at the network boundary: a duplicate report is `200`, not `409`. Both are the same
refusal — **do not turn a harmless race into an outage** — and an interviewer who hears them both hears one
principle applied consistently rather than two unrelated tricks.

---

## 5. Where the argument stops

### The five adversarial scenarios, scored honestly

`context/product/product-definition.md` §1.4 lists five scenarios and calls them the definition of success.
**The double-click is not one of them** — it is stage 2's headline requirement and spec 002 §2.1. Conflating
the two misquotes the assignment to the person who wrote it, so the distinction is worth being precise about
even though it makes the tally look smaller.

| # | Scenario | Status after Phase 2 |
|---|---|---|
| 1 | 50 parallel `paid` reports for one order → one issuance fact, one key consumed | **Settled and runnable**: `pnpm race webhooks`, at the assignment's stated number, across four processes |
| 2 | A repeated report with the same `event_id` changes nothing | **Settled** since Phase 1 by the `event_id` PRIMARY KEY; now runnable: `pnpm race same-event` |
| 3 | A report arriving before its order, or out of order | **Settled this phase** — stored by the absent FK, applied by the four triggers; runnable: `pnpm race before-order` (with the `SKIP` caveat in Q17) |
| 4 | An empty key pool leaves the order recoverable; after restocking, exactly one key | **Half-won.** The out-of-stock state is real, and a restock re-issues cleanly against the same derived request id (verified end to end, because an out-of-stock refusal writes **no** supplier ledger row). The operator's list of paid-but-undelivered orders and the manual retry are **Phase 3**, and there is no check for them here |
| 5 | A promo code with limit N, under parallel requests, applied at most N times | **Phase 5. Not started** — the tables do not exist |

The double-click has its own check, `pnpm race create-order`: twenty concurrent Buy attempts sharing one intent
key, which also asserts the **negative complement** — a *fresh* key still creates a *new* order. Without that
second half, a check proving only "concurrent things converge" would pass against an implementation that
merges every purchase of one item into a single order forever, which is Q4's content-hash failure wearing a
green tick.

### What is not finished — carried forward without softening

- **The row lock is defence in depth, not a load-bearing mechanism.** It changes no observable outcome today;
  ten RED executions confirmed it; Phase 3 is what makes it load-bearing (Q12).
- **`race:webhooks` does not guard the atomic key claim it names.** `pnpm test:concurrency` does (Q15). And
  when `race:webhooks` did catch a widened guard, it caught it **through its teardown, not an assertion** —
  recorded in the harness README (Q16).
- **The guarded transition is not what makes the key count one.** The supplier's ledger and
  `deliveries.order_id` UNIQUE do that (Q16).
- **The watchable order page rests on a timing window nothing structurally defends.** The page's refresh has
  to land inside a few tens of milliseconds. A slower acknowledgement pushes it late; a faster supplier closes
  it early; a real network changes both. The two structural fixes — pushing each transition over a socket, or
  recording transitions server-side so the page reads the *history* rather than sampling the *current state* —
  are both more machinery than the criterion is worth at this scale. Written down rather than engineered away.
- **`out_of_stock` was never watched in a browser.** Reaching it needs the fifty-key pool exhausted, which
  would have wrecked the baseline every other check runs against. It is covered by a compile-time check that
  every status has a Russian label — real evidence that the label exists, and weaker evidence than the five
  states that were actually watched rendering.
- **A shopper whose browser blocks site storage loses one of the four guarantees in Keystone 1.** The intent
  name falls back to per-document memory, so repeated clicks and retries in one tab still share a name and two
  *tabs* no longer do. A deliberate, specific degradation rather than a crash — reading that storage can
  itself throw, and an uncaught throw there takes the purchase down for a reason unrelated to buying anything.
- **There is no root `README.md`.** `architecture.md` §7 says the scenario-to-check mapping lives there and
  calls that mapping the deliverable; `scripts/race/README.md` documents it thoroughly, but the top-level file
  is **Phase 6** work.
- **Out of scope by design:** suppliers that fail or go quiet, the *unknown*-versus-*failed* classification,
  supplier B, the operator's list and manual retry (**Phase 3**); the designed storefront (**Phase 4**); promo
  codes (**Phase 5**); public deployment (**Phase 6**); and webhook signature verification, which the
  assignment waives.

Offering this list unprompted is stronger than being walked through it, and the pairing in
`interview-notes.md` — each Phase 1 gap with a `→` line recording what Phase 2 did about it — is itself the
answer to "how do you decide what to defer?"

---

## 6. The sentences worth memorising verbatim

`interview-notes.md` already carries three. Phase 2 changed what stands behind two of them and earned a
fourth.

1. **"Every guarantee is enforced by the database — never by a check in application code, never by a lock
   inside one process."**
   *Unchanged, and now carrying more weight.* Phase 1 argued it; Phase 2 measured the consequence of ignoring
   it twice over — the same broken code handing out 20 distinct keys against one process and 9 against four,
   and a guard that turned out not to be the thing making the key count one.

2. **"All twenty ran the check before any of them had inserted, so all twenty saw zero — and every one of
   those checks was correct at the instant it ran."**
   *Unchanged, and still the single best answer to "why not check first".* Phase 2 added nothing to it and
   nothing needed adding; it is Phase 1's measurement and it is the one to reach for.

3. **"The hard part of a race test isn't the assertions — it's proving the test could ever have been red. And
   doing that is the only way to find out which invariant each test actually guards."**
   *The second clause is Phase 2's, and it is the half worth the extra breath.* Phase 1 could claim the first
   sentence from one RED run. Phase 2 ran the exercise across five checks and had three assumptions
   overturned, including a check that passed 8/8 against a build confirmed weakened.

4. **"Being slow manufactures the concurrency you then have to survive."**
   *New in Phase 2, and the most portable idea in the project.* It explains why the shop answers before it
   works without needing a single failure in the story: an eight-second handler against a five-second read
   timeout produces two copies of one report in flight, created by nothing but the shop's own latency.

Two runners-up worth having loaded, though not memorised: **"The same content is not the same intent"** (the
whole of Q4 in five words), and **"A race check that cannot fail is worse than no race check, because it grows
more convincing every time it passes"** (the whole of Q14).

---

## 7. Where the evidence lives

| File | Read it for |
|---|---|
| `phase-1.md` | The three Phase 1 keystones, the nine-invariant table, Phase 1's own honest gaps |
| `phase-2.md` | The four Phase 2 keystones, the scenario scoring, the harness |
| `interview-notes.md` | The spoken versions, the questions to fear, and the `→` annotations closing each Phase 1 gap |
| `slice-1-data-model.md` | The 20-session experiment (Q2); the missing foreign key (Q9); `SERIALIZABLE` (Q1) |
| `slice-2-order-lifecycle.md` | Why not two booleans; the 1.6-second lock (Q3); pricing |
| `slice-3-webhook-inbox.md` | Why winning an insert *is* duplicate detection; status codes as instructions |
| `slice-4-supplier-idempotency.md` | `request_id → code`; the `SIGKILL` counterfactual; the 959 ms convoy (Q11); the 1-vs-4-process measurement (Q14) |
| `slice-5-issuance.md` | The thirteen hops; the attempt row written *before* the call; definite vs unknown |
| `slice-6-out-of-stock.md` | One key, two orders; the three status lists |
| `slice-7-proving-the-race.md` | Phase 1's RED; asserting against the database, not just responses |
| `phase-2-slice-1-one-order-per-intent.md` | Intent versus content; where the key is minted; the two causes of zero rows (Q4, Q5) |
| `phase-2-slice-2-answer-then-work.md` | The 72 ms answer; the status-code table; the tracked scheduler (Q6, Q7, Q8, Q13) |
| `phase-2-slice-3-out-of-order.md` | The absent foreign key; why four triggers; the poll gate's occupancy argument (Q9, Q10) |
| `phase-2-slice-4-watching-the-stages.md` | The 25–65 ms measurement that disproved the obvious explanation; the 4/5 split |
| `phase-2-slice-5-one-worker-per-order.md` | Guard versus lock; `FOR UPDATE` vs `SKIP LOCKED` vs `FOR NO KEY UPDATE`; the RED that came back green (Q11, Q12, Q13) |
| `phase-2-slice-6-checks-a-reviewer-can-run.md` | The harness; all five RED outcomes; the null result (Q14, Q15, Q16, Q17) |

The nine invariants and the exact SQL for each: `context/product/architecture.md` §3, §3.1. The multi-process
rule: §7. The order-id affordance: §9. Requirements:
`context/spec/001-purchase-and-key-delivery/functional-spec.md` and
`context/spec/002-single-issuance-under-races/functional-spec.md`.

**On evidence:** every number in this document is quoted from the walkthrough named beside it. Nothing was
measured or re-run while writing it, and no source file was modified.
