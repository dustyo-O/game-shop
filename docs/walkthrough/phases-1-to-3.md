> **Superseded.** The single map is now `phases-1-to-4.md`, which carries this document forward unchanged, with Phase 4 as an appendix; this file is kept as the end-of-Phase-3 snapshot and is no longer updated.

# Phases 1 to 3 — one argument, and the question each part of it answers

> Every other document in this folder explains **one slice** or **one phase**. This one is the map. It
> supersedes `phases-1-and-2.md`, which stays in place with a pointer here. `phase-1.md`, `phase-2.md` and
> `phase-3.md` each make their own argument once; this document says why they are *the same argument*, and
> gives the single answer to each question an interviewer is likely to ask — so that being asked them in any
> order does not require remembering which document they came from.
>
> Nothing here is new evidence. Every number is quoted from the walkthrough named beside it, which records
> how it was captured. No source file was read for measurements and none was modified.

---

## 1. The spine

Three phases are not three projects with a shared repository. There is **one claim**, and it has two halves
that fail in opposite directions:

> **A key that has been given to one shopper is never given to another, and one payment produces exactly one
> key.**

Break the first half and you have sold the same key twice. Break the second and you have either taken money
and delivered nothing, or burned two keys out of the pool for one payment. Every decision in all three phases
is in service of one of those two, and one rule decides *how* each is enforced:

> **Every guarantee is enforced by the database — never by a check in application code, never by a lock
> inside one process.**

The reason is structural, not stylistic. The API runs as serverless functions: two simultaneous requests are
**two separate operating-system processes with no shared memory**. A flag, a `Map`, a mutex or an `if` in one
does not exist for the other. That is why such a guard passes every test on a laptop and evaporates in
production, and it is why the guard is not merely *unreliable* — it is **not a mechanism at all**. The one
thing the two processes share is Postgres, so Postgres is the only place a decision can be made.

Phases 1 and 2 applied that rule to things the shop *can* know: whether this order already has a delivery,
whether this report has been seen, whether this click is the same intent as the last one. Phase 3 applied it
to the case where the shop **cannot** know — the supplier went quiet, the worker was killed mid-issuance, the
operator's own retry request never came back — and the rule held, but it needed a second sentence to say
what it holds *for*:

> **A shop can be wrong about the world and still be right about its records.**

Three readings of that sentence, and each is a Phase 3 mechanism. **A timeout is `unknown`, not `failed`**:
the record says *we asked and never learned the answer*, which is the only truthful thing it can say, and
`failed` is not a description but a licence to ask a different supplier for a second key. **A stranded order
is listed, not lost**: an order whose worker died between claiming it and writing the outcome rests in
`delivering` with an attempt reading `unknown`, and the operator's list shows it immediately, with no time
predicate, because it is the one class of stuck order nothing else can see. **A retry is the same issuance,
not a new one**: the operator's press enters the identical claim-under-lock and ladder walk the payment
report takes, so everything that made the first issuance yield one key makes the retry do the same.

There is also a sharpening of the rule itself, and it is the reason Phase 2's row lock stopped being
decorative. Phases 1 and 2 never met a decision Postgres could not take in a single statement — an
`ON CONFLICT`, a `WHERE status = ANY(…)`, a conditional `UPDATE`. Phase 3 met one: *which supplier is next*
is a function of a **set** of attempt rows, and no single statement evaluates it. The rule did not bend; it
gained a clause. **Where a decision needs more than one statement, the rows are read under the order row
lock and the decision is a pure function of what they say** — which is why the lock became load-bearing
exactly there (Q22), and why the decision could be proven by exhausting its inputs rather than by examples
(Q21).

Everything else follows from those sentences, including the awkward parts: why zero returned rows is a normal
answer rather than an error, why a duplicate webhook is a `200`, why an unfinished payment report is left
unfinished on purpose, why a race check pointed at one process proves nothing, why a transaction that writes
nothing about the attempt still has to open, and why an operator whose retry timed out is told *it may or may
not have run* rather than *it failed*.

### The five layers, and what each alone fails to do

| Layer | Built in | What it establishes | What it alone would fail to do |
|---|---|---|---|
| **1. The records decide, not the code** | Phase 1 | Named states with guarded transitions; UNIQUE rules; the supplier's `request_id → code` ledger | Tell two clicks from two purchases (I1 was in the schema but unwired), and pick up a report that arrived before its order — the row was stored, and nothing came back for it |
| **2. The server owns the state; the page reports it** | Phase 1 | The delivery decision, the price and the key all live server-side; the page is a reader | Show anything. The whole chain finished in ~19–60 ms inside the webhook request, so the shopper saw `created` and then `delivered` |
| **3. The world is allowed to misbehave** | Phase 2 | An intent has a name; a repeat is a `200`; the answer goes out before the work | Nothing, without layer 1. Each of these is a check-then-act unless a constraint adjudicates it: the intent key without a UNIQUE rule is a `Map`; the `200` without the `event_id` PRIMARY KEY is a guess; the scheduler without the inbox and its four triggers is a promise you can drop |
| **4. Nothing is believed until it has been seen to fail** | Phase 2 | Every check was deliberately broken, the code rebuilt, the failure recorded, the source restored | Nothing on its own — but without it, layers 1–3 are assertions. Three assumptions a careful reader would have made from the source were tested and all three were wrong (Q15, Q16) |
| **5. The shop may not know what happened, and its records say so** | Phase 3 | `unknown` as an outcome with a policy attached — re-ask the same question, never a new one; the ladder as a pure function of recorded rows, read under the lock; the operator as a second caller into the same issuance; the page's stop rule split into *terminal* and *recoverable* | **Bound anything, without layer 1**: a re-probe is only safe because the supplier's ledger (I5) answers a repeated string with the code it already cut — without that table, "ask the same question again" is simply a second question and cuts a second key. **Recover anything, without layer 3**: the stranded order is findable only because the report was durable before the work began. **Be believed, without layer 4**: all three of its REDs left every shopper-facing assertion green, so a shop losing a key on every timeout would have looked identical from the outside. And even with all four beneath it, it **cannot eliminate the loss it bounds** — at most one unaccounted key per outstanding attempt (Q24) |

Layer 3 is the one people mean when they say "concurrency work", and it is the layer that **cannot be
correct on its own**. Layer 5 is the one people mean when they say "resilience", and it is the layer that
**cannot be seen on its own**: the `unknown` record is reviewed in exactly one place, the operator's screen,
and the shopper's page is the only place a recovery is ever watched landing. Those two sentences together
are the most useful thing to be able to say about the three phases as one.

---

## 2. The question → answer index

One line each: which argument answers it, and where the evidence is. The expanded answers are in §3, in the
same order. Q1–Q17 keep the numbers `phases-1-and-2.md` gave them; the two closing questions from that map
("what isn't finished" and "an AI wrote this") have moved to the end as Q34 and Q35 so that Phase 3's
questions sit with the mechanisms they answer.

| # | The question | The one argument that answers it | Evidence |
|---|---|---|---|
| Q1 | Why Postgres, and why Drizzle rather than Prisma? | Postgres is the subject of the assignment, not a storage choice; Drizzle because `FOR UPDATE` is typed rather than a raw-SQL escape hatch | `architecture.md` §2 |
| Q2 | Why `ON CONFLICT` rather than checking first? | A check followed by an act has a gap, and the gap is where the other process lives. Twenty sessions, every check correct, twenty keys | `slice-1-data-model.md` §5 |
| Q3 | Why a state machine and not a `paid` flag? | `paid=true, delivered=false` is four different situations, and `delivering` is a claim that needs somewhere to live outside one process's memory | `slice-2-order-lifecycle.md` §2 |
| Q4 | What stops a double-click making two orders? | An `Idempotency-Key` naming the *intent*, minted per SKU in `localStorage`. The server half is the easy half | `phase-2-slice-1-…` §2–§3 |
| Q5 | Zero rows came back. What happened? | It depends on the statement — eight statements now, and two of them have two causes each that must not be conflated. One of the eight meanings is an HTTP `409` | `phase-2-slice-1-…` §5; `phase-3-slice-2-…` §2; `phase-3-slice-5-…` §2 |
| Q6 | Why is a duplicate webhook a `200`? | A status code returned to a machine is an instruction, not a description. `5xx` means "send it again", and no amount of resending turns a duplicate into a first sight | `phase-2-slice-2-…` §2 |
| Q7 | Why answer before doing the work? | Being slow *manufactures* the concurrency you then have to survive; and a failure in the work must not become the response | `phase-2-slice-2-…` §1 |
| Q8 | What's wrong with `void this.process(event)`? | Three specific moments: `SIGTERM`, a rejection, an unbounded wait. The tracked scheduler names what it abandoned. Phase 3 found the bound's stated premise false and lowered it | `phase-2-slice-2-…` §3–§4; `phase-3-slice-3-…` §6 |
| Q9 | Why is there no foreign key on `payment_events.order_id`? | A payment report is written by a stranger with no ordering guarantee. The FK would turn a millisecond race into a retry storm | `phase-2-slice-3-…` §1 |
| Q10 | Why four triggers rather than one? | Each of the first three is attached to something happening, which is what makes it useful and what makes it insufficient. The fourth is attached to nothing, which is what closes the set | `phase-2-slice-3-…` §3 |
| Q11 | Why `FOR UPDATE` on the order row but `SKIP LOCKED` on the inbox and the key pool? | Whether *any* row will do. Skipping is right for a queue and wrong for the one row you were handed | `phase-2-slice-5-…` §6 |
| Q12 | Did you prove the row lock was necessary? | Not in Phase 2 — the RED came back green ten times, and the reason is the best fact in that slice. Phase 3 is where it carries weight, and Q22 says exactly where | `phase-2-slice-5-…` §3; `phase-3-slice-3-…` §3 |
| Q13 | Why can't the lock just wrap the supplier call? | The pool is one connection per instance, so a transaction across an HTTP call is an instance-wide outage. Phase 3's hang placement is a boolean for the same reason | `phase-2-slice-5-…` §4; `phase-3-slice-3-…` §2 |
| Q14 | Why do the race checks need four processes? | One process has one connection, so a second claim queues inside Node. The same broken code hands out 20 distinct keys against one process and 9 against four | `architecture.md` §7; `slice-4-…` §9 |
| Q15 | What does a RED result that comes back **green** mean? | It is a real null result with an exact reason, and it is how you find out which invariant a check actually guards | `phase-2-slice-6-…` §4.3 |
| Q16 | So the guard is what makes the key count one? | No. Widen it so all fifty workers claim the order and the shopper still gets one key. The ledger and the UNIQUE rule do that; the guard saves forty-nine supplier calls | `phase-2-slice-6-…` §4.4 |
| Q17 | What can a reviewer run, and what does it still not cover? | `pnpm race` — eight checks, four processes, twice in a row, pointable at a deployed URL. Plus `pnpm test:concurrency`, which is the one that actually guards the key claim | `phase-2-slice-6-…` §2, §7; `phase-3-slice-7-…` §1, §5 |
| Q18 | A supplier times out. Why isn't that a failure? | The timeout is a deadline on *our* socket and says nothing about theirs. Measured: the key was cut **206 ms after** the client had classified the call. `failed` is not a description; it is a licence | `phase-3-slice-3-…` §2 |
| Q19 | Why is re-asking the same supplier safe, and asking a different one not? | They are two different questions and the identifier is what makes them different. The id is derived from three facts; a re-probe changes none of them, a fall-through changes two | `phase-3-slice-2-…` §2; `phase-3-slice-3-…` §3 |
| Q20 | Why derive the id rather than read it back — and why is `attempt` numbered per order? | Four callers, and the first to reach for a fresh id issues a duplicate with no error. Per-supplier numbering re-probes a settled question silently (R7); `UNIQUE (order_id, attempt)` catches what `request_id`'s own UNIQUE cannot | `phase-3-slice-2-…` §2 |
| Q21 | How is "never fall through while an attempt is `unknown`" enforced? | By the order the ladder's branches are written in, not by a flag; the guard is a negation on purpose; proven over **894,049** histories, then **1,788,098**, with three mutants that fail by 620,336, 265,560 and 1,024 | `phase-3-slice-3-…` §3; `phase-3-slice-5-…` §4 |
| Q22 | Phase 2 said the lock was defence in depth. Is it still? | No. The ladder is a decision over a set of rows, and two workers reading different snapshots compute different rungs — two ids, two keys. The lock serialises the workers; the `unknown` guard decides. Both, or neither is enough | `phase-3-slice-3-…` §3 |
| Q23 | Why did the RED assert stock accounting and not the shopper's key count? | Because the shopper's key count cannot fail — `deliveries.order_id` is UNIQUE — so it cannot pass meaningfully either. `claimed=2, deliveries=1` was the only place the second key showed up | `phase-3-slice-3-…` §4 |
| Q24 | Is stock accounting always true, then? | No, and asserting it everywhere fails against a correct system. On the probes-exhausted path `2 ≠ 1` is *correct*. The phase bounds the loss to one key per outstanding attempt; it does not eliminate it | `phase-3-slice-3-…` §4, §7 |
| Q25 | `delivery_failed` sounds final. Why isn't it terminal? | *Terminal* is the set I9's guarded UPDATE draws its `from` lists from, and a compile-time assertion fails the build otherwise. Proven with `TS2344` four slices before the retry existed. Two facts, two tables | `phase-3-slice-1-…` §2 |
| Q26 | Why is the operator's list wider than "stuck"? | Because the one class of stuck order nothing else can see rests in `delivering`. No time predicate; a `NOT EXISTS` that is not redundant (1 667 → 1 666); `LEFT JOIN LATERAL … LIMIT 1` (1 664 and 2 081 are both wrong); a silent supplier shows its outstanding id, not a default | `phase-3-slice-4-…` §3 |
| Q27 | You added an index and the list got 500× faster. What was actually slow? | Not the per-order-latest-row join everybody argues about (4 996 buffers) — the derived *paid at* beside it (2 469 012). `6 426 ms` against `11.9 ms`, and the status list is a literal so the partial index can be used | `phase-3-slice-4-…` §2 |
| Q28 | Where is the admin retry implemented? | It isn't. One call into the same issuance the payment takes; the entry decides only which transitions this caller may claim with. Reusing the code reuses the proofs. And no timer, deliberately | `phase-3-slice-5-…` §2 |
| Q29 | How does the endpoint decide `409`? And two retries both answered `200 delivered` — isn't that a double issue? | It doesn't decide; `409` is what both guarded transitions matching zero rows is called. `409` and `200 still_out_of_stock` are different news. The loser holds the right key; a test asserting one must `409` fails against a correct system | `phase-3-slice-5-…` §2, §5 |
| Q30 | `delivering → delivering` matches every time. What stops two operators double-issuing a stranded order? | Not the guard — it excludes nobody. The row lock and the rung both resumers necessarily compute. `probe_count 1 → 2 → 3`, pool unchanged. Named fragile (R3), shipped anyway, and the reason is the phase's subject | `phase-3-slice-5-…` §3 |
| Q31 | The retry didn't work the first time. What went wrong? | The ladder read "both refused" as a verdict; the same rows mean opposite things mid-walk and at an operator's opening turn, and rows cannot carry who is asking. `Fresh`, read by exactly one branch, below the guard; the proof doubled | `phase-3-slice-5-…` §4 |
| Q32 | Settled and terminal — aren't those the same thing? | They were, for two phases, until a person could move a recoverable order. The page stopped on the two states an operator can move; every test stayed green; the criterion was unmet. RED: 11 reads ending at 9 561 ms, then silence | `phase-3-slice-6-…` §2–§4 |
| Q33 | Your recovery checks pass. Would they catch a broken retry policy? | Each went red — 6 of 18, 5 of 16, 9 of 25 — and under every weakening every assertion about the shopper stayed green. What failed was rows, ids and counts. One RED is a bug the phase actually shipped, word for word | `phase-3-slice-7-…` §4 |
| Q34 | What isn't finished? | Every honest gap from three phases, each with the reason it was deferred rather than missed | §5 below |
| Q35 | You didn't write this — an AI did. | Ask about any decision in here. The walkthroughs exist to make sure that question is welcome | `interview-notes.md` |

---

## 3. The answers, expanded

Where two walkthroughs answer the same question differently, the better answer is given and the other is
named, with the reason for preferring it. Those are marked **▸**. Where Phase 3 changed what stands behind a
Phase 1 or 2 answer, the change is in the answer rather than appended to it.

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
never has to know Drizzle to audit a guarantee. The rule has since tightened: §3.1's blocks are copied from
the code's `.toSQL()` output rather than written by hand, because I1 and I2 drifted that way once — and the
drift was caught by an audit of `phase-2.md`, which had quoted the code correctly and therefore disagreed
with the architecture.

Isolation stays `READ COMMITTED` deliberately. `SERIALIZABLE` would also be correct, and it **hides the
guarantee inside an invisible retry-on-conflict loop you cannot point at** — which is a bad trade in a project
graded on explaining its decisions.

One small Phase 3 footnote for the "why not an enum" follow-up: order status is a `text` column under a
`CHECK`, not a Postgres enum, and the migration that widened the lifecycle is the reason. `ALTER TYPE … ADD
VALUE` cannot use the label it just added inside the transaction that added it; a `CHECK` is ordinary DDL,
dropped and re-added inside the migrator's transaction, usable by the next statement. Measured on a
20 000-row fixture: 1.853 ms plus 4.525 ms, no table rewrite — `pg_class.relfilenode` read 16419 before and
after (`phase-3-slice-1-…`).

*`architecture.md` §2; `slice-1-data-model.md` §7; `phase-3-slice-1-a-failure-you-can-see.md`.*

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

Phase 3 supplied the same mistake in a new coat, and it is worth having ready because it is one statement
shorter than the right version: a `switch` on the status the lock returned, to decide whether the operator's
retry may run. The value was true when the `SELECT` ran; the transition is written a statement later; and
under the current lock the window happens to be empty, which is exactly what lets the mistake survive review
and then survive the day the lock moves. The shipped version is a guarded `UPDATE` whose zero rows *is* the
refusal (Q29).

*`slice-1-data-model.md` §5; `phase-1.md` Keystone 3; `phase-3-slice-5-…` §2.*

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

Phase 3 gave the fourth situation its record, and it is two records rather than one. The *order* rests in
`delivery_failed` — a statement about the shop: *we did not hand over a key*. The *attempt row* reads
`unknown`, with no reason — a statement about the supplier: *we never learned what it did*. They coexist
without contradiction because they are different facts in different tables, and the retry reads the second
one, not the first, to decide what to do (Q25). The same statement, with `$3 = '{delivering}'` and
`$1 = 'delivery_failed'`, is how the shop gives up — and its zero-row path is *another worker settled or
delivered it; not an error*.

*`slice-2-order-lifecycle.md` §2; `phase-3-slice-1-…` §2; `phase-3-slice-3-…` §3.*

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

Phase 3 has the same shape in the operator's chair, and it is worth one sentence: the Retry button is
disabled after a press as a courtesy, and **the disabled button is not the protection** — §2.5's fourth
criterion is two operators on two machines, and no client state is shared between them. Which is why that
verification is not a click test either: clicking Retry twice in one browser and finding one key proves only
that the button was disabled (Q29).

*`phase-2-slice-1-one-order-per-intent.md` §2–§7; `architecture.md` §3.1 (I1); `phase-3-slice-5-…` §6.*

### Q5 — "Zero rows came back. What happened?"

The convention is one sentence — **"zero rows" is a normal answer, not an error** — but the *meaning* is
per-statement, and reciting the convention without the specific meaning is the weaker answer. Eight
statements now, eight meanings:

| Statement | 0 rows means |
|---|---|
| `INSERT … orders … ON CONFLICT (client_request_id)` | **Two causes**, and they must not be conflated — see below |
| `INSERT … payment_events … ON CONFLICT (event_id)` | We have seen this report before. Acknowledge `200`, do nothing |
| `UPDATE orders … WHERE status = ANY(...)` | Somebody else already advanced it, or it was never in a state this move may leave from |
| The key claim (`FOR UPDATE SKIP LOCKED LIMIT 1`) | Every key is claimed. Not an error — the caller is told `out_of_stock` |
| The inbox claim (`processed_at IS NULL … SKIP LOCKED`) | Nothing is waiting, **or** every waiting report is held by another worker. Both mean "not my work" |
| The attempt reservation (`INSERT … issuance_attempts … ON CONFLICT (request_id) DO NOTHING`) | **Two causes again**: a legitimate re-probe of an outstanding question, *or* a settled id being reused by mistake. The statement cannot tell them apart and neither can the caller — which is why `UNIQUE (order_id, attempt)` exists (Q20) |
| The operator's two guarded transitions, tried in order | Zero from **both** is what the wire calls `409`: this order is not stuck, nothing ran, the list was stale (Q29) |
| The probe count (`… ON CONFLICT (request_id) DO UPDATE SET probe_count = probe_count + 1`) | **Never zero.** `DO UPDATE` returns the row on both paths, unlike `DO NOTHING` — and it names exactly one column, because the row may already say `ok` (Q22) |

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

The sixth row is the Phase 3 twin of the first, and it resolves the other way: there is no read-back that
can separate a re-probe from a reused settled id, because the two are the same string. So the ambiguity is
made unrepresentable upstream — attempt numbers count per order, and `UNIQUE (order_id, attempt)` raises on
the one shape the reserving insert would have swallowed (Q20). One convention, two responses: split the
causes when a read can tell them apart, and forbid the collision when it cannot.

*`phase-2-slice-1-…` §5, §8; `phase-3-slice-2-…` §2; `phase-3-slice-5-…` §2.*

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

Phase 3 applies the same reading to the supplier, from the other side of the wire: the stub answers a
definite refusal with `422`, never a `5xx`, because *the supplier answered, and the answer was no*. A `5xx`
invites redelivery, which is the opposite of a definite refusal. And the shop reads the **body**, not the
status code, to classify: a refusal arriving with a `200` is still a refusal, and a `500` with no body is
still `unknown` (Q18).

*`phase-2-slice-2-…` §2; `phase-2-slice-6-…` §4.1; `architecture.md` §3.1 (I2); `phase-3-slice-2-…` §2.*

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

Phase 3 made the work that runs after the answer much longer — a full ladder walk can take
`3 × 2000 × 2 = 12 000 ms` — and nothing in the acknowledgement path had to change, because it was never
waiting on the work. What did have to move is the shutdown bound (Q8).

*`phase-2-slice-2-…` §1–§2; `phase-3-slice-3-…` §6.*

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
  followed by `kill -9`. So the wait has a bound, and **the bound's one product is a log line, which must never
  lose the race to print itself.**

**▸ The number and its reasoning changed in Phase 3, and the Phase 2 version must not be quoted.** Phase 2
set the bound at 5 seconds, "above the longest legitimate continuation (one supplier call, capped at
2000 ms) and below the tightest grace period anything gives before `SIGKILL` (`docker stop` kills 10 s after
asking)". Phase 3 found both halves wrong. The longest legitimate continuation is now a whole ladder walk,
`3 × 2000 × 2 = 12 000 ms` (logged at boot as `worst_case_ms: 12000`; the ordinary exhausted path alone
measures **6 102 ms**), so no number sits above it and below 5 s. And the premise was simply false: Compose
runs **only Postgres**, so `docker stop` never signals this process at all; the supervisors that really exist
— the concurrency suite's instance helper and the race runner — `SIGKILL` **5 000 ms** after `SIGTERM`, which
is *exactly* what the old bound was set to. A photo finish the give-up line loses, since it prints only after
the drain timer resolves. Measured at `SIGTERM` mid-walk: with the bound at 4 000 the process exited
**4 790 ms** after the signal — 210 ms inside the grace, a coin toss on a loaded machine; at 3 000 it exited
**3 055 ms** after, with **1 945 ms** to spare. The bound is now 3 000 ms.

Which constraint gives is the transferable part. Breaking *"wait for the longest walk"* is **recoverable and
loud**: the attempt row says `unknown` because it was written *before* the call, the order stays
`delivering`, the payment event stays pending, and the give-up line names the `order_id` and `event_id`.
Breaking *"exit before `SIGKILL`"* is **silent** — no line, no pool drain, an operator who learns nothing. A
bound whose one product is a log line must not be the thing that loses the race to print it.

None of this is promised as a guarantee, deliberately — which is the point of Q10's four triggers. **A dropped
continuation costs latency, never a key.** And Phase 3 added the place a dropped continuation is *seen*: an
order abandoned mid-ladder rests in `delivering` with an `unknown` attempt, which is exactly the row the
operator's list is wide enough to show (Q26).

*`phase-2-slice-2-…` §3–§4; `phase-3-slice-3-…` §6.*

### Q9 — "`payment_events.order_id` has no foreign key. Isn't that a data-integrity bug?"

No, and `deliveries.order_id` ten lines away is what proves it was a decision rather than an oversight. The
rule is *who can write this row before the order exists*. A delivery is only ever written by code that has
already read the order, so a dangling reference there is a real bug and the FK belongs. A payment report is
written by a **stranger**, on a different connection in a different process, with no ordering guarantee
against the shopper's own request — so an early report is legitimate.

Add the "obvious" FK and the insert raises, the endpoint returns `5xx`, the provider retries, the order still
does not exist a hundred milliseconds later, and **a race that cost nothing has become an on-call incident.**

The general shape is worth naming once: **a constraint is a statement about what rows may exist, and it is
retroactive. Adding one is never a local change.** Phase 3 used the same sentence in the other direction — a
constraint that *admits* the failure it was added to prevent is worse than none, because it gets quoted in
reviews. That was the three-column `UNIQUE (order_id, provider, attempt)` the plan first proposed and
corrected before the migration was written (Q20).

*`phase-2-slice-3-…` §1; `slice-1-data-model.md` §4; `phase-3-slice-2-…` §2.*

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

Phase 3 found the one order all four triggers miss, and it is the reason the operator's list exists in the
shape it does. Every trigger claims from `paid`. An order whose worker died *after* claiming it — the platform
killing the function mid-ladder — rests in `delivering`, which `paid` never matches, so no trigger will ever
touch it again. It is not in the inbox; no follow-up is scheduled; it is not "waiting", it is stranded. The
only thing that can move it is a person, through a transition whose guard excludes nobody (Q30), and the only
thing that can show it to that person is a list wide enough to include orders merely in flight (Q26).

*`phase-2-slice-3-…` §2–§4; `phase-3-slice-4-…` §3; `phase-3-slice-5-…` §3.*

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

Phase 3 added no fourth lock. The silence transaction, the operator's retry and the resume all take the *same*
`FOR UPDATE` on the order row as their first statement — and it is the same lock because it is the same
question: *this* order, no other. What Phase 3 changed is what happens under it — a read of a *set* of rows
and a decision computed from them (Q22) — and that is what turned a lock that changed nothing into one that
carries weight.

A related sub-question that catches people: **why `FOR UPDATE` and not `FOR NO KEY UPDATE`**, given only
`status` changes? That is the right default and it is wrong in this schema. `FOR KEY SHARE` — taken by the FK
check on every child insert — conflicts with `FOR UPDATE` and not with the weaker lock; measured at **2082 ms
versus 5.6 ms** for a concurrent `INSERT INTO deliveries`. The usual reasoning is that the extra blocking is
collateral damage on unrelated writers. Here it is not: the only two tables referencing `orders` are
`deliveries` and `issuance_attempts`, which are **the two writes issuance makes** — so the blocking is a
second independent layer of exactly the exclusion being bought. A future path that inserts a delivery without
taking the lock queues; the weaker lock would wave it through.

*`phase-2-slice-5-…` §5–§6; `slice-4-supplier-idempotency.md` §5; `phase-3-slice-3-…` §3.*

### Q12 — "Did you prove the row lock was necessary?"

**Not in Phase 2 — and that was the answer then.** Concede it before it is extracted, and then say where it
became necessary.

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
statement earlier; it does not change who wins. In Phase 2, **that lock was defence in depth, not a
load-bearing mechanism, and it changed no observable outcome.** It went in anyway, because the right time to
add a lock is before the code that needs it, so that code lands on an already-serialised path; retrofitting
locks into a working system one call site at a time is where deadlocks come from.

**Phase 3 is that code, and Q22 is where it needed the lock.** The short form: the ladder is a decision over
a *set* of attempt rows, which no single statement evaluates; two workers reading different snapshots compute
different rungs, send two different ids, and two keys leave the pool. The guarded `UPDATE`'s own write lock
cannot help, because the decision was taken before any `UPDATE` was written.

**▸ Three predictions of this moment exist and they do not quite agree; use Phase 3's wording.**
`phase-1.md` said *"recomputable by any process holding only the order id"* and predicted *"two workers
inside `delivering` with different attempt numbers is how a second key leaves the pool"*. `phase-2-slice-5-…`
said the retry path *"stops deriving the supplier request identifier from the order alone — it has to
**read** the previous attempt first"*. Phase 3 is precise: the id is **derived from three facts** — order,
supplier, attempt — and never stored and read back; what is read under the lock is the *set of rows* that
says which three facts apply. The distinction is not pedantry, because "read the id back" is the rejected
alternative (Q20). Phase 1's sentence turns out to have described Phase 3's failure mode after all — two
workers with different attempt numbers is exactly two snapshots computing two rungs — and Phase 2 was right
that the *drain* never produces it: all four triggers funnel through one guarded `paid → delivering`, and even
a double entry would send the same `req_{order}_a_1`, collapse to one code in the ledger, and un-claim on
rollback. Predicted, absent, present: three documents, one lock.

And **do not reach for `slice-1-data-model.md` §5's twenty-keys measurement to justify the lock** — that arm
used twenty *distinct* request ids and no claim at all, and an interviewer who reads it will catch the
mismatch.

*`phase-2-slice-5-…` §3; `interview-notes.md` "What isn't finished?"; `phase-3-slice-3-…` §3.*

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

Phase 3 kept both transactions short and made the rule visible in a schema column. The silence transaction is
a lock, a read of the attempt rows and a guarded `UPDATE` — the hang is never inside it. And the supplier
stub's injected hang has a placement column, `hang_before_claim`, that is a **boolean rather than a three-way
choice** for exactly this reason: the key claim and its ledger write are one transaction, so a hang is either
before it or after it commits, and the only third place anybody would reach for — *inside* that transaction —
must never exist, because it would hold the process's single connection for the length of the hang and stall
every other request in it, including the re-probe the trap is staged to observe. A two-valued column cannot
express it; an enum would give it a name and a place to sit.

*`phase-2-slice-5-…` §4; `phase-2-slice-2-…` §6; `phase-3-slice-3-…` §2.*

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

Phase 3's three recovery checks add a second use of the four processes that is worth saying out loud: each
one **arms, creates, pays and reads through different instances**, so a pass is evidence that a supplier
behaviour written through one process is read by another — which is what keeping the stubs' failure state in
Postgres rather than in memory is for. And the one-shot counters they arm (*refuse your next call*) are spent
by a single atomic `UPDATE … WHERE fail_next > 0`, so four instances cannot each spend one once.

The honest limit, offered rather than extracted: four processes on one machine is weaker than four serverless
instances — same kernel, same clock, one loopback. It is the strongest thing that runs from one command, and
the strongest *form* runs against a deployed URL, which `RACE_BASE_URLS` supports without a rewrite.

*`architecture.md` §7; `slice-4-…` §9; `phase-2-slice-6-…` §2–§3; `phase-3-slice-7-…` §1, §3.*

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

Phase 3 got no null result — all three of its REDs went red — and the finding moved to the *other* column:
which assertions **stayed green** under every weakening, and the answer was every one about the shopper
(Q33). Same discipline, opposite direction, same lesson.

*`phase-2-slice-6-…` §4.3; `phase-3-slice-7-…` §4.*

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

Phase 3 leaned on exactly this property and named it: the `resumeIssuance` transition's guard excludes nobody,
and what keeps two resumers to one key is that both compute the same rung from the same rows, send the same
recomputed id, and the ledger answers both with the code it already cut (Q30). *"The guard has been quietly
borrowing Phase 2's deterministic-id property"* is the sentence from that slice, and it is this answer in
Phase 3 clothes.

**▸ One inconsistency to correct when quoting Phase 1.** `phase-1.md`'s invariant table gives I4's "Without
it" as *"Fifty webhooks start fifty issuances"*, which is right about issuances and reads as though it were
about keys. Say "fifty supplier calls, and still one key" — the stronger and more accurate claim.

And the honest note about *how* that breach was detected: `race:webhooks` did report it, three runs of three,
but through its **cleanup failing on a foreign-key violation** rather than through any assertion it makes.
That is a genuine limitation, recorded in the harness README rather than filed off. **A check whose failure
signal arrives via its teardown is a check that got lucky.**

*`phase-2-slice-6-…` §4.4; `phase-3-slice-5-…` §3.*

### Q17 — "What can a reviewer actually run?"

```sh
pnpm race                              # all eight, against 4 freshly built local processes
pnpm race webhooks recover-timeout     # only the named ones
pnpm race:recover-out-of-stock         # the same thing through the per-check alias
pnpm race --list                       # what exists; runs nothing, needs nothing running
RACE_BASE_URLS=https://…  pnpm race    # a deployed target: builds nothing, spawns nothing
pnpm test:concurrency                  # the suite that actually guards the key claim — and slices 2, 3, 5's races
```

`pnpm race` builds the packages, starts four real API processes on ports 4601–4604, waits until each has
served a real request, runs every check against all four, and stops all four afterwards — on success, on
failure, on a thrown configuration error, and on Ctrl-C. Eight checks: Phase 2's five (`harness`, `webhooks`,
`same-event`, `before-order`, `create-order`) plus `recover-refusal` (A refuses its next call; the
fall-through reaches B under a *new* id), `recover-timeout` (A hangs *after* its key claim commits, past the
timeout; the same supplier is re-probed under the *same* id and B is never asked) and `recover-out-of-stock`
(pool drained, order paid, pool restocked, operator presses Retry; the retry asks again at `max(attempt) + 1`,
and a second press answers `409`). Run twice consecutively with no tidying in between: **`8/8 passed against
4 instance(s)`** both times; against one external URL, **`7/7 passed against 1 instance(s), 1 skipped`**.
That is earned by every check cleaning up in a `finally` block.

Which is worth one small confession, because it broke the exact property it existed to protect: the first
version of the `SKIP` outcome called `process.exit(3)` **inside the `try`**, which terminates immediately and
skips the `finally`, leaving the early payment report on disk so the next run started dirty. The fix is to set
a flag, fall out of the `try`, let cleanup run, and set the exit code at the end. **`process.exitCode` sets a
value; `process.exit()` is control flow wearing a value's clothes.**

Things about the checks worth knowing before a reviewer finds them:

- **`pnpm test:concurrency` is not redundant with `pnpm race`.** They answer different questions: `race`
  answers "does one order survive fifty reports", the Vitest suite answers "do N parallel orders yield N
  distinct keys". Q15 is why that distinction is not a matter of taste. Phase 3's two-operator races, the
  stranded-order resume and the delivery-failed retry also live in the Vitest suite.
- **`before-order` can report `SKIP`.** It needs a configuration flag that lets the script choose an order id
  — off by default, failing closed when unset, set only for the instances the harness spawns, never in a
  deployment, and recorded in `architecture.md` §9 as a known trade-off. Against a deployed shop that
  correctly refuses it, the check prints `SKIP` and is subtracted from **both** sides of the ratio, so the
  summary read `4/4 passed, 1 skipped` in Phase 2 and reads `7/7 passed, 1 skipped` now — never `4/5` or
  `7/8`. `FAIL` would report a correct system as broken and teach
  the reviewer to distrust the other four; `PASS` would count an unrun check as evidence, which is the
  decoration the criterion exists to forbid.
- **The recovery checks need `ADMIN_TOKEN`, and skip honestly without it.** A target answering `503` has the
  admin surface disabled, which is the correct deployment default; one answering `401` has a different token.
  Both are a correct system refusing an affordance, reported as `SKIP`, exit `3`, subtracted from both sides.
  `recover-out-of-stock` also needs the database — draining and restocking are database operations — and
  against a target whose database the reviewer cannot reach it **skips entirely rather than printing a pass
  over three status codes**. `recover-timeout` costs about **2.4 s**, one real timeout, and could only be
  faster by making the spawned instances a different shop.
- **Three ways to arm a supplier that look right and prove nothing**, all in one shared helper's header so
  the fourth author reads them instead of finding them: the control endpoint *replaces* the row, so a hang
  without a duration is a hang of no length that never times out; a refusal is read before a hang, so arming
  both spends the refusal and leaves the hang for whoever calls next; and the after-claim hold is
  unconditional, so a hang against an empty pool stages the opposite of the trap. **One-shot counters, never a
  failure rate**: two consecutive runs must behave the same, and a rate is a coin toss whose eventual
  intermittent red reads as a correctness defect in the shop — the most expensive wrong answer a check can
  give.
- **The port range moved once and the README lagged.** `RACE_BASE_PORT` went from 4201 to 4601 when Phase 2's
  acceptance suite turned out to bind 4201; the harness README's opening paragraph said `4201–4204` until
  Phase 3's slice 7 fixed it. A reviewer who read one number and found instances on another would have had
  reason to wonder what else was stale.

*`phase-2-slice-6-…` §2, §5–§7; `phase-3-slice-7-…` §1, §3, §5, §6.*

### Q18 — "A supplier times out. Why isn't that a failure?"

**▸ Three documents answer this and they agree; use the one with the number.** `interview-notes.md` spoke the
answer in Phase 1, before the policy existed — *"a wrong 'unknown' costs one redundant question; a wrong
'failed' costs a second key"* — and `phase-3-slice-1-…` gives the two-facts-two-tables half. `phase-3-slice-3-…`
is the one that measured it, and a measurement is what turns the cost asymmetry from a design preference into
a fact about the wire.

The shop's timeout is a deadline on *its own* socket. When it expires, the shop closes its end of the
connection. Nothing travels to the supplier. The supplier's handler is still running, and it keeps running:
it can claim a key, write that key into its ledger, and finish answering into a connection that closed half a
second ago. A handler that claims a key at 400 ms against a client that gives up at 200 ms:

```
t+205ms  CLIENT: threw TimeoutError  => classified UNKNOWN
t+206ms  SERVER: socket aborted by the client
t+412ms  SERVER: KEY CLAIMED AND COMMITTED -> ledger=["KEY-0001"]
```

**The key was cut 206 ms after the client had already classified the call.** Whatever the shop decides at
t+205, it decides in ignorance of an event that has not happened yet. No longer wait and no better error
handling fixes this, because the information does not exist at the moment the decision is taken. So `failed`
cannot be a *description* of what happened — the shop has no idea what happened. What `failed` actually is, in
this design, is a **licence**: permission to ask a *different* supplier for a *second* key. That licence may
only be issued when this supplier explicitly said no in a form the shop could parse.

The classification, and the asymmetry is the whole design: a readable success carrying the shop's own
request id → `ok`; a readable refusal with a reason the shop knows, **whatever the HTTP status** → `failed`;
and *everything else* — no response, a body that is not JSON, JSON in neither shape, a success echoing an id
the shop never sent, a refusal with an unrecognised reason — → `unknown`. The discriminator is the body, not
the status code. A timeout has no body at all, which is exactly why it cannot be read as an answer.

What the shop then does: records nothing on the attempt row (it was born `unknown` before the call went out,
and nothing truthful has changed), re-asks **that same supplier that same question** up to three times, and
if still unanswered moves the *order* to `delivery_failed` and leaves the attempt row exactly as it was —
`unknown`, no reason, `probe_count` at its ceiling. Measured across four processes: A armed to claim a key
and then hang for 2 500 ms against a 2 000 ms timeout gives **one attempt row, `a/1`, `status=ok`,
`probe_count=2`**, one ledger row, one claimed key, **zero `SupplierClient:b` lines in the full transcript of
all four processes** — B was not merely not recorded, it was never called. A armed to hang three times: the
shop asked three times, stopped after **6 102 ms** — three 2-second timeouts and no fourth — and left the
order `delivery_failed` with its attempt reading `unknown`, no reason, `probe_count 3`.

**The documentation said the opposite, in five places, for two phases.** The architecture, the supplier
configuration module, `.env.example`, the technical notes for this very phase, and an *agent briefing* all
stated the injected hang as *shorter* than the shop's timeout. Staged that way there is no timeout: the
supplier is slow, the shop waits, the supplier answers, and the headline check passes having exercised
nothing. Measured against the documented ordering: `NO TIMEOUT OCCURRED. A timeout check staged this way
asserts nothing.` The correction was not a sign flip — the old sentence described a real scenario, *a slow
supplier is not a failed one*, and was being cited as the basis for a different one. Both are kept, with
opposite orderings: `hang < timeout` for slow-but-successful, **`timeout < hang < platform ceiling`** for the
trap, with the hang placed *after* the key claim commits so the ledger holds a code for the re-probe to find.
The agent briefing was the worst of the five, because a wrong rule there does not sit still and wait to be
read; it gets re-injected into the next piece of work.

*`phase-3-slice-3-silence-is-not-failure.md` §2, §5; `phase-3-slice-1-…` §2; `interview-notes.md`.*

### Q19 — "Why is re-asking the same supplier safe, and asking a different one not?"

**▸ Slices 2 and 3 give the same answer; slice 2's is the tighter form and is used here**, with slice 3's
ledger statement beside it. Because they are two different questions, and the identifier is what makes them
different. Every question to a supplier is sent under an id computed from three facts — the order, the
supplier, the attempt number — and from nothing else: `req_<order>_<supplier>_<attempt>`.

| Rung | supplier | attempt | id |
|---|---|---|---|
| ask A for the first time | `a` | `1` | `req_x_a_1` |
| **re-probe** | same as the outstanding row | same | **byte-identical, recomputed** |
| **fall-through** | next untried | **`max(attempt) + 1`** | `req_x_b_2` |

**A re-probe changes none of the three arguments; a fall-through changes two.** That is one rule with two
readings, not two rules, and it is why the two cannot be confused by accident: there is no id to confuse,
only three arguments.

Why the same question is safe is the supplier's ledger — invariant I5, the promise the assignment makes on
the supplier's behalf (*a repeat with the same `request_id` must return the same code*) — one read before any
key is touched:

```sql
SELECT code FROM supplier_requests WHERE request_id = $1 AND provider = $2;
-- 1 row  => this supplier has answered this id before. Return THAT code,
--           however many times we are asked. No key is touched.
-- 0 rows => a new question. Claim a key, write the ledger, answer.
```

The promise is keyed on the string. One byte different and it is a new question, and a new question to a
supplier is answered the only way a supplier can answer it: by cutting a fresh key. Supplier B has never heard
of `req_x_a_1`, has no ledger entry for it, and cannot answer it with A's code. That is why a fall-through
*must* carry a new id — B asked under A's id would be asked to look something up in a ledger it never wrote —
and why a fall-through *must not* happen while A's attempt is `unknown`: A may hold a key under `req_x_a_1`, B
cuts a second under `req_x_b_2`, and two keys have left the pool for one order.

Phase 1 built that ledger and wrote down what it was for — *"a timeout is not a refusal, it is an answer you
have not read yet"* (`slice-4-supplier-idempotency.md` §4) — and Phase 3 is the first phase in which anything
reads it twice.

*`phase-3-slice-2-a-backup-supplier.md` §2; `phase-3-slice-3-…` §3; `slice-4-supplier-idempotency.md` §4.*

### Q20 — "Why derive the id rather than read it back — and why is `attempt` numbered per order?"

The obvious alternative is what `issuance_attempts.request_id` looks like it is for: mint a random id at the
top of the issuance path, store it on the attempt row, and read it back when a retry needs it. It works, and
correctness then depends on every future caller *remembering* to read it. There are four callers in this
phase alone — the automatic path, the re-probe, the fall-through, the operator's retry — and the first one
that reaches for a fresh random id instead issues a duplicate key with no error anywhere: the supplier's
ledger misses on an id it has never seen and claims a fresh key, exactly as designed. Deriving the id means
there is nothing to remember and nothing to forget. Attempt 1 for order `x` on supplier `a` is `req_x_a_1` in
every process, on every machine, forever. **The re-probe is recomputed, not remembered.**

**The attempt number counts per order, not per supplier — and the wrong version reads better.** A
per-supplier counter gives the fall-through `req_x_b_1`, which reads perfectly in a log. It breaks later. Take
an order both suppliers definitely refused, settled, and now being retried by an operator. Per order, the
ladder computes `max(attempt) + 1 = 3` and asks A under `req_x_a_3` — a question nobody has asked. Per
supplier, it computes A's next attempt as 1 and recomputes `req_x_a_1`: **a re-probe of a settled question
wearing a fall-through's clothes.** And it fails silently, because the reserving insert is
`ON CONFLICT (request_id) DO NOTHING` and its zero-row path is the honest one for a legitimate re-probe — so
the collision is swallowed, the code carries on, the operator presses retry again and gets the same nothing.
No error, no log line, and the order can never be re-issued. That is R7.

**`UNIQUE (order_id, attempt)` makes it unrepresentable, and it catches what `request_id`'s own UNIQUE
cannot.** The string constraint catches two rows carrying the same string. This one catches a stored attempt
number that has drifted from the string it appears in, and two rows that differ only in the supplier segment.
Proven against the running database inside a rolled-back transaction — two rows for one order, both attempt
3, with two *different* id strings:

```
INSERT 0 1                              -- req_ord_proof_unique_a_3, attempt 3
ERROR:  duplicate key value violates unique constraint "issuance_attempts_order_id_attempt_key"
DETAIL:  Key (order_id, attempt)=(ord_proof_unique, 3) already exists.
```

The three-column version, `(order_id, provider, attempt)`, was what the plan first proposed and was corrected
before the migration was written. It would have accepted both rows above — `(x, a, 3)` and `(x, b, 3)` are
distinct triples — and `max(attempt) + 1` would have handed the number 3 out twice. A constraint that admits
the failure it was added to prevent is worse than none, because it gets quoted in reviews.

The same constraint is what makes `attempt` a total order, which is why the operator's list reads the newest
attempt `ORDER BY attempt DESC` and never by timestamp — two rows written in one transaction carry the same
timestamp, and `LIMIT 1` picks between them differently on each run (Q26).

*`phase-3-slice-2-a-backup-supplier.md` §2; `phase-3-slice-4-…` §3.*

### Q21 — "How is 'never fall through while an attempt is `unknown`' enforced? A flag? A check at the top?"

Neither. It is the order the ladder's six branches are written in:

```
1. no attempts                                         → ask A for the first time
2. any attempt not definitely settled, asks left       → probe it
3. any attempt not definitely settled, asks spent      → settle: never established
4. any attempt says ok                                 → rest; a code exists
5. every attempt a settled refusal, a supplier untried → fall through
6. every supplier refused                              → settle: refused
```

Branches 2 and 3 sit above branch 5, and **that placement is the enforcement**. An order with an outstanding
attempt cannot *reach* the fall-through branch. Two details are load-bearing and easy to skim: branches 2 and
3 scan *every* attempt row, not the newest — a shop that checked only the newest would fall through past an
outstanding `a/1` the moment any later row existed; and `max(attempt)` is computed from the set, not read off
the first row of a sorted result, so the ladder has no invisible dependence on an `ORDER BY` in another file.

**"Definitely settled" is a negation, on purpose.** The guard asks *is this row `ok` or `failed`?* — not *is
it `unknown`?* The attempt row's status column is plain text with no database rule on its values,
deliberately, because the value set belongs to this policy and not to the schema. A row written by a future
migration, or by hand, with a fourth status would satisfy "not `unknown`" and unlock a fall-through past an
outstanding question. The negation makes *unrecognised* behave like *unknown*, which is the only reading that
cannot issue a second key.

**Proven by exhaustion, not by examples.** "Unrepresentable" is a claim about every input, so it is checked
against every input in a space small enough to enumerate: 96 distinct attempt rows built one axis per thing
the ladder looks at — every axis including a value the database can hold but this build does not recognise
(a supplier `c`, a status `in_flight`) — then every ordered history of 0 to 3 of them:

```
histories checked: 894049
histories containing an unsettled attempt: 781104
VIOLATIONS (unsettled -> anything but probe/settleNeverEstablished): 0
histories reaching fallThrough: 8152   — of those, fully settled: 8152
```

Not vacuous: 8,152 histories *do* fall through, every one fully settled, and the test asserts each counter is
non-zero and that the total is exactly `1 + 96 + 96² + 96³`, so a refactor that shrinks the space cannot pass
by checking less. And it can fail — two mutants against the same space:

```
control (tree as it stands):                           VIOLATIONS = 0
mutant: guard reordered below fallThrough:             VIOLATIONS = 620336
mutant: "definitely settled" flipped to `!== unknown`: VIOLATIONS = 265560
```

Those two numbers also say *which* part is doing the work: the first is the branch order, the second is the
negation. The test writes its own copy of the predicate out longhand rather than importing the ladder's,
because a check that imports the definition it is checking agrees with that definition however it changes —
including into the flipped version the assertion exists to catch.

When the retry added an input to the ladder (Q31), the space was doubled to **1,788,098** and re-run under
both values, still with zero violations, and a third mutant — the retry's branch moved above the guard —
produces **1,024** violations on the 9,216 two-row histories, the first of them `[a/1 failed, b/1 unknown]`: a
brand-new question to A while B may already hold a key. The input space had grown by an axis and the proof
had not; saying so plainly, and then growing the proof, is the point.

The whole rule is one pure function of recorded rows — no clock, no network — which is not over-engineering
for a two-supplier fallback: a predicate over rows is testable only by handing it rows, and keeping it pure
leaves the four-process suite to prove the things only four processes can prove. All three of Phase 3's REDs
hit that one file (Q33), which is not an accident of the exercise; it is why the ladder is a pure function of
recorded state in the first place.

*`phase-3-slice-3-silence-is-not-failure.md` §3; `phase-3-slice-5-…` §4.*

### Q22 — "Phase 2 said the row lock was defence in depth. Is it still?"

No, and Phase 2 said this was the phase that would change that. If the give-up path writes nothing about the
attempt, why open a transaction at all? Because **the next rung must be computed from rows read under the
order row lock.**

Every other guarantee in this project is one statement — an `ON CONFLICT`, a `WHERE status = ANY(…)`, a
conditional `UPDATE` — that Postgres evaluates against a row. The ladder is the one decision Postgres cannot
take in a single statement: *which supplier is next* is a function of a **set** of rows, and no single
statement evaluates it. So the exclusion has to come from the lock taken one statement earlier. What goes
wrong without it is precise: two workers reading *different* snapshots compute *different* rungs. One reads
`[a/1 failed]` and computes *fall through to B*; the other reads `[a/1 failed, b/2 unknown]` and computes
something else. Two genuinely different questions go out, and the ledger cannot help because it is keyed on
`request_id` and these are two of them. Two keys leave the pool. Two workers reading the *same* snapshot are
fine, and that is the common case; the lock is not defending the ordinary path, it is defending the one where
the snapshots differ. **The lock serialises the workers; the ladder's `unknown` guard decides. Both, or
neither is enough** — which is Phase 2's sentence about the lock and the guard, with the guard now a
six-branch function rather than a one-clause `WHERE`.

The two transactions, statement for statement, are the phase in one diff. When a supplier definitely refuses:
lock, `UPDATE issuance_attempts SET status = 'failed', last_error = $2 WHERE request_id = $3`, read every
attempt row, compute the rung, act. When a supplier goes quiet: lock, **deliberately no write to
`issuance_attempts`**, read every attempt row, compute the rung, act. **The only difference is the missing
`UPDATE`, and that missing statement is the phase in one line.** The row was written as `unknown` *before* the
call went out — every attempt row is born `unknown`; no row is ever created in any other state — so when the
call returns nothing, there is nothing truthful to change.

The probe's own bookkeeping goes in the same transaction, so the count that bounds the loop is committed
before the next pass reads it — and the statement names exactly one column:

```sql
INSERT INTO issuance_attempts (…) VALUES (…)
ON CONFLICT (request_id) DO UPDATE
  SET probe_count = issuance_attempts.probe_count + 1
RETURNING probe_count;
```

On the probe path the row may already say `ok` — the supplier answered the previous ask and another
transaction wrote the code while this worker had already decided to probe. A `SET status = 'unknown'` beside
the increment, the obvious thing to write with every other column right there, would erase the one fact worth
having and un-deliver a delivered order. It also counts **asks, not answers**, and runs *before* the call, so
a process killed mid-request leaves a truthful count with no `catch` having run. The accepted cost, stated
rather than discovered: a worker that dies before sending burns a probe.

**The honest limit on "load-bearing".** Phase 3 showed exactly *where* the lock carries weight and *what*
breaks without it, and every assertion that would notice is named (stock accounting — Q23). It did **not**
remove `.for("update")` and watch a check go red: all three Phase 3 REDs weakened the ladder, not the lock
(`phase-3-slice-3-…` §4 says so in its first sentence). So "load-bearing" is argued and localised, not
measured by removal. Phase 2's ten green executions remain the only RED the lock has had, and they were
correct for the code that existed then.

*`phase-3-slice-3-silence-is-not-failure.md` §3; `phase-2-slice-5-…` §3.*

### Q23 — "Why did the RED have to assert stock accounting and not the shopper's key count?"

Because the shopper's key count physically cannot fail. Weaken the hard rule — let a fall-through fire while
an attempt is `unknown` — and run the four-process check. Two assertions fail:

```
FAIL  claimed keys == deliveries — {"claimedKeys":2,"deliveries":1}
FAIL  supplier B was never called — b rows=1
```

Now read what did *not* fail. The order still reported `delivered`. There was still exactly one delivery row.
**The shopper's key count never moved.** A's ledger had cut a key for `a/1` — still `unknown`, unaccounted
for — while B cut a second for `b/2`, and B's was the one delivered. Because `deliveries.order_id` is UNIQUE
(I3), no amount of ladder misbehaviour can produce two deliveries, so the shopper-facing assertion *cannot
fail*, which means it cannot pass in any meaningful sense either. A shopper, an order page, an end-to-end
browser check and any assertion phrased as *"the buyer received exactly one key"* all see a perfectly correct
shop. The only place the second key shows up is one count against another:

```sql
SELECT count(*) FROM supplier_keys WHERE claimed_by_request_id IS NOT NULL;  -- left the pool
SELECT count(*) FROM deliveries;                                            -- reached a shopper
```

That is functional spec §2.2's fifth criterion word for word, and the transferable lesson is bigger than the
phase: **the assertion that catches a broken ladder is never the one about the shopper.** A suite that only
asserts what the shopper sees is green against a shop losing a key on every timeout. Phase 2 had already met
the same lesson twice — two scripted requests cannot fail the double-click test (Q4), and `race:webhooks`
passed 8/8 against a gutted key claim (Q15) — and Phase 3 met it three more times (Q33).

*`phase-3-slice-3-silence-is-not-failure.md` §4.*

### Q24 — "Is stock accounting always true, then?"

No, and asserting it everywhere would fail against a correct system. On the probes-exhausted path the
measurement is `claimed_keys 2, deliveries 1` — and that is *correct*: a key genuinely was cut, the shop asked
three times and never learned the code, the order settled `delivery_failed` with its attempt row reading
`unknown`. That is the honest meaning of `unknown`, and it is exactly the loss this phase bounds. So the
equality is asserted on **settled outcomes only** — `delivered`, `out_of_stock`, a definite
`delivery_failed` — and on a never-established outcome the assertion becomes *at most one unaccounted key per
outstanding attempt, and the attempt row still reads `unknown` with no reason*. A check that asserted the
equality everywhere would fail against a correct system, and the temptation when that happens is to "fix" the
system.

**This phase bounds the loss; it does not eliminate it.** If a silent supplier did cut a key and never says so
in three asks, that key is claimed in its ledger under an id whose code the shop never received, and no
shopper will ever hold it. What is bounded is one key per outstanding attempt — bounded by the fact that no
other supplier is ever asked while that attempt is outstanding. Give up immediately and the shop loses that
key *and* tells the shopper nothing useful; fall through and it loses that key *and* a second one. The one
thing that could still recover it is an operator retry, which asks the same id again (Q28), and the ledger
answers with the code it already issued, if it issued one.

*`phase-3-slice-3-silence-is-not-failure.md` §4, §7.*

### Q25 — "`delivery_failed` sounds final. Why isn't it terminal?"

Because *terminal* in this codebase is not a mood. It is the set that invariant I9's guarded UPDATE draws its
permitted source states from — a terminal status appears in no transition's *from* list, and a compile-time
assertion fails the build if anyone puts one there. So classifying `delivery_failed` as terminal would not
*discourage* the retry; it would make the retry's transition, `delivering` from
`[out_of_stock, delivery_failed]`, **refuse to compile**, and §2.4 and §2.5 of the spec could not be built at
all.

That was checked, and four slices before the retry existed to need it: a throwaway file replicating slice 5's
future transition rule was typechecked under both classifications. Recoverable: exit 0. Terminal:
`error TS2344: Type '"delivery_failed"' does not satisfy the constraint 'never'.` The file was deleted; what
it bought is that slice 1's classification is *known* to be the one slice 5 needs.

The distinction to hold: **terminal means no transition is ever legal; recoverable means nothing moves it by
itself — a person does.** `out_of_stock` already meant exactly that. To a passive observer the two are
indistinguishable, which is why the contracts package keeps three sets and derives the third — settled is
terminal plus recoverable — and why adding one status to the recoverable list was the entire change: the
page's stop condition, the payment processor's "is there work left" test and the race suite's "is the shop
finished" test all picked it up for free. That derivation is also the trap Q32 is about.

**"If the order says `delivery_failed`, doesn't that mean the supplier failed?"** No, and keeping those apart
is most of the phase. `orders.status = 'delivery_failed'` is the shop's statement about itself — *we did not
hand over a key*. `issuance_attempts.status = 'unknown'` is the statement about the supplier — *never
established*. Two facts, two tables, and §2.2's fourth criterion — *the record shows the outcome was never
established, rather than showing it as failed* — is satisfied by the second one, by **not writing something**.
The retry reads the attempt, not the order status, to decide between re-probing the same id and falling
through.

Adding a status is a one-line change, and four things fired without being asked, each a different question:
a classification proof broke until the status was classified (a record can be total and still classify
nothing); the label map broke until the Russian was written (there is no `default` branch to hide an apology
in); a test that reads the label file *as text* and checks the Cyrillic block broke with `found 6 labelled
entries: expected 6 to be 7` (a type proves an entry exists; only that proves it is in Russian); and eight
`apps/api` errors nobody had planned for — the migration ordering showing up as a compiler error, which is
where one would rather have it, confirmed by adding the wire member as a probe, watching all eight clear,
reverting byte-identical, and watching them return.

*`phase-3-slice-1-a-failure-you-can-see.md` §2–§3; `phase-3-slice-3-…` §3.*

### Q26 — "Why does the operator's list include orders that are merely in flight? Isn't that noise?"

It is noise, and it is deliberate.

```sql
WHERE o.status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed')
  AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.order_id = o.id)
```

Two of those four are orders that will very likely deliver themselves in the next fifty milliseconds.
Narrowing to the two an operator can retry is the obvious cleanup, it would make the screen calmer, and it
would hide **the one class of stuck order nothing else can reach**: an order whose worker died between
claiming it and writing the outcome. That order rests in `delivering` for ever with an attempt reading
`unknown`. It is no longer in the inbox; no follow-up work is scheduled; nothing automatic will ever touch it
again (Q10). It is precisely this phase's failure mode — the platform ceiling killing the function mid-ladder
— and if this list does not show it, nothing does. Retry *eligibility* is a separate, narrower question,
answered by the guarded `UPDATE` matching zero rows or one (Q29), so the model is *undelivered order*, not
*stuck order*, and an in-flight row shows "in progress" where the button would be. For the same reason there
is no time predicate: *an order must appear immediately, without waiting for any period to elapse* is a
criterion, and **a calm screen five minutes behind is worse than a busy screen that is true.**

The `NOT EXISTS` reads redundant with the status list and is not: there is a live path where a delivery row
commits while the `delivering → delivered` move matches zero rows because another worker got there first,
leaving a delivered order reading `delivering`. Constructed by hand and counted: **1 667** rows on the status
filter alone, **1 666** with the predicate, the constructed row listed zero times. Without it the operator
retries an order whose shopper is already holding the key — the one action guaranteed to be pointless.

Two more traps in the same statement, each producing a plausible screen and no error, counted on the same
1 666-order fixture. The join to the newest attempt must be `LEFT JOIN LATERAL … LIMIT 1`: the `CROSS` form
silently drops the orders with no attempt row at all (**1 664** instead of 1 666), which are the most alarming
rows on the screen — an order the shop *forgot* rather than failed at; the plain `LEFT JOIN` multiplies
(**2 081**), so the operator presses retry on the same order three times. And the newest attempt is
`ORDER BY attempt DESC`, never by timestamp (Q20).

**What the operator sees for a silent supplier, and the one-character bug that would lie.** Nothing definite
went wrong, so there is no reason to show — the reason column is `NULL`, correctly. What the screen shows
instead is the **outstanding request id**: a supplier was asked, the shop never learned the answer, a key may
or may not exist under this id, and the only thing that can still find out is this id, asked again. The bug
guarded against is `reason: lastError ?? "failed"` — it type-checks, and it is wrong because the reason is
`NULL` on two opposite outcomes, a supplier that said *ok* and a supplier that never answered. This screen is
the only place a person ever reviews that record, so §2.2's fourth criterion is met or broken by this one
cell, and a friendly default would break it while every test stayed green. The defence is three independent
facts rather than one word, so there is no single slot for a default to fall into. And the field rests on Q21:
an `unknown` row is always the newest for its order *only because* the ladder never creates a row past an
outstanding one — change that, and this field reads `null` on exactly the orders it exists for, and the only
assertion that notices is stock accounting.

*`phase-3-slice-4-finding-the-stuck-orders.md` §3.*

### Q27 — "You added an index and the list got 500× faster. What was actually slow?"

Not the part everyone looks at, and that is the finding. The list is a per-order-latest-row problem — *the
newest issuance attempt per order* — so that is where the optimisation effort naturally goes. Three strategies
were measured for it and came out within 5 % of each other, because all three were carrying the same cost
underneath: a derived *paid at* — a correlated subquery over `payment_events`, evaluated once per listed
order. In one plan with the indexes dropped, the lateral join cost **4 996** buffers and the *paid at* node
beside it cost **2 469 012**. Same plan, same run. That node reported `Rows Removed by Filter: 39999` — for
each of 1 666 listed orders, read all 40 000 payment events and throw away 39 999 — which is invisible if you
read the plan for row counts, because the row counts all look fine; you only see it in `Buffers`. With the two
partial indexes in place: **`6 426 ms` against `11.9 ms`**.

Why derived at all? Because every lifecycle transition goes through one generic guarded `UPDATE` whose whole
value is that it is the *same statement* for every transition — the source states are data, not code — and
`orders.paid_at` means a `CASE` in that statement's `SET` list, a special case in the one table designed to
have none, and a second copy of a fact `payment_events` already holds durably. So it is derived, and the index
on `(order_id, received_at)` is what makes deriving it free: Postgres rewrites `min()` over an indexed column
into "read the first row of an ordered scan and stop".

Two Postgres details worth having ready. The partial index is known to be in use **by the absence of a
`Filter`**, not by the timing — the planner proved the index's predicate implies the query's `WHERE`, so there
is nothing left to test, and a `Filter: (status = ANY ...)` on that node would mean the proof failed. And the
status list is a **literal** in this one query, against the codebase's own `= ANY($n)` convention, because a
bound parameter defeats the partial index: literals give `Index Scan using orders_undelivered_idx`, node cost
170; `= ANY($1)` under `force_generic_plan` gives `Seq Scan`, `Rows Removed by Filter: 18334`, node cost 659.
Postgres cannot prove that a value it has not been shown implies a partial index's predicate. Custom planning
rescues it today because `.prepare()` is forbidden — a planner heuristic protecting the query, not a property
of it, and not something to stake the operator's only screen on. The list is not retyped; the query embeds
the very fragment the index predicate is built from.

One thing real data caught that a fixture would not have: the driver hands every timestamp back as a raw
string for the column's own mapper to decode, so a bare `sql<Date>` fragment type-checks and returns
`'2026-09-11 12:58:49.659965+00'`, whose `.toISOString` is not a function — a `500` on the first order that
had a `paid` event, which an empty database sails past.

*`phase-3-slice-4-finding-the-stuck-orders.md` §2.*

### Q28 — "Where is the admin retry implemented?"

It isn't, in the sense the question means. The operator's whole retry, with the reporting stripped away, is
one call into the identical claim-under-lock and ladder walk the payment report takes. The operator's entry
decides exactly one thing — **which transitions this caller may claim the order with** — and nothing about
the ladder, the supplier, the ids or the settlement, because those are the same code for everybody. The
automatic path gets `paid → delivering`; the operator gets `delivering` from `[out_of_stock, delivery_failed]`
and then, if that matched nothing, `delivering` from `[delivering]` (Q30).

The rejected alternative is the one every deadline reaches for: a parallel retry implementation in the admin
module with its own lock and its own duplicate check. It would be a second thing to get right and the first
to drift. Every guarantee §2.5 asks for — *pressing twice changes nothing*, *two operators get one key*, *a
retry racing the automatic path is safe* — is already a property of the row lock (I4), the guarded UPDATE
(I9), the ledger (I5), the key claim (I6) and `deliveries.order_id` UNIQUE (I3), and Phase 2 and slice 3
proved every one on this code. **Reusing the code reuses the proofs.** The issuance module exports its runner
and nothing else, so a second path cannot be assembled from it even by someone trying. Phase 1's closing note
said it in five words — *"Phase 3 adds a caller, not a repair"* — and that is what shipped.

**No timer, deliberately.** The obvious improvement is a cron entry re-walking the recovery list every thirty
seconds, and a timer aimed at a failing supplier is how a small outage becomes a large one: every stuck order
retries on the same beat against a supplier already struggling, each leaves another `unknown` attempt, and
the next tick probes them all — the merely-stuck orders become orders whose outcome nobody knows. So the
affordance is absent from top to bottom — `POST` with no body, one order id in the path, no "retry all", no
`202` with a job to poll, manual refresh. A person watching a supplier fall over stops pressing; a timer does
not. Recorded as R11: the obvious "improvement" that must not be added without the phase that thinks it
through.

*`phase-3-slice-5-pressing-retry-twice.md` §2; `phase-1.md` "What is not finished".*

### Q29 — "How does the endpoint decide `409`? And two retries both came back `200 delivered` — isn't that a double issue?"

It doesn't decide; Postgres does, and the endpoint names the result. The operator's two transitions are tried
in order, each a guarded `UPDATE … WHERE id = $2 AND status = ANY($3)`, and **`409` is what both matching zero
rows is called on the wire.** Nothing reads `orders.status` and branches. The obvious version — a `switch` on
the status the lock returned — is one statement shorter and is the check-then-act this project argues against
(Q2). Applied twice each against the live database: `retryIssuance` on an `out_of_stock` order returns one row
then zero; on a `delivered` order both candidates return zero. Reported from four processes with an order in
`payment_failed`: every guarded claim matched zero rows, the answer was `409`, `updated_at` unchanged, zero
attempt rows written. *Nothing ran* — not "nothing was reported to have run".

**`409` and `200 still_out_of_stock` are different news, and a hurried implementation collapses them into
one red message.** The first says *this order is not stuck; your list was a few seconds old and somebody else
got there first* — the system working. The second says *it is stuck, the retry ran correctly, and every shelf
is still empty* — a supplier was asked and had nothing; the order stays in the list, and this is the only one
worth pressing again after a restock. Measured: on a still-empty pool the retry answered `200
still_out_of_stock` with `delivered: false`, the order still `out_of_stock`, no delivery row, still listed.

**Two concurrent retries on a `delivery_failed` order, from two processes, both answered `200 delivered` — and
that is correct.** The loser's transaction ran after the winner's, read `[a/1 failed, b/2 failed, a/3 unknown]`
under the lock, computed a probe of `a/3`, and asked A the byte-identical question, which A's ledger answered
with the code it had cut for the winner. The loser holds the right key; its `deliveries` insert was an
`ON CONFLICT DO NOTHING` no-op, its `delivering → delivered` matched zero rows, and its follow-up read observed
`delivered`, which is what it reported — honestly, because the shopper does hold the key this call fetched.
Telling that operator "failed" would be the lie, and it would teach them to press again. The database is
unambiguous: three attempt rows, exactly one new, one delivery, one claimed key. **A test asserting "one must
`409`" would fail against a correct system.**

**And when the retry request itself does not come back.** An operator who presses Retry and gets a `504` sees
*"The retry request did not come back. It may or may not have run — refresh to see."* Not "failed". The
claim, the supplier call and the `deliveries` insert all happen before any byte of the response is written, so
a lost answer may well have delivered a key, and an operator told "failed" presses again against a supplier
that already answered — the exact habit this phase exists to break. That is the phase's thesis applied to the
operator, who is in the position the shop is in when a supplier goes quiet. Every outcome re-fetches the list,
because the endpoint is the authority and the list is the truth.

*`phase-3-slice-5-pressing-retry-twice.md` §2, §5, §6.*

### Q30 — "`delivering → delivering` matches every time. What stops two operators double-issuing a stranded order?"

**Not the guard.** Every other transition in this codebase is verified by the second call returning zero
rows. `resumeIssuance`, applied twice to the same `delivering` row, **returns a row both times**. The guard
matches every time, so it excludes nobody, so it cannot be what keeps two retries apart. Demonstrated rather
than described, because that is the truth about it.

**Why it exists at all — two specialists reached opposite conclusions, and checking who was right exposed a
real hole.** The backend plan wanted the transition, so that an order stranded in `delivering` by a dead
worker can be recovered. The data-layer plan argued the opposite: a guard that excludes nobody needs a
mechanism this phase does not have, so a stranded order should be listed but not retryable. Both halves are
true, and the hole the first one names is real: every drain trigger claims with `paid → delivering`, whose
`from` is `[paid]`, which never matches `delivering` — so **without this row nothing in the system can ever
move a stranded order again**: not the sweep, not the shopper's poll, not the operator. Refusing the
transition leaves a permanently unrecoverable state in the phase whose entire subject is recovery. The
rejected alternative (A3) was a staleness threshold — resume only a `delivering` order older than N seconds —
a knob whose correct value nobody can know.

**What actually excludes the second resumer, and neither is in the transition table.** (1) **The order row
lock**: both take `SELECT … FOR UPDATE` as the first statement, so one reads, decides and commits before the
other reads anything. (2) **The rung they both necessarily compute**: a stranded order's outstanding attempt
is `unknown`, the ladder answers *probe*, and a probe writes no new attempt row — its one write is
`probe_count + 1` — so the second reader sees the identical ledger, computes the identical rung, and sends the
identical id, recomputed rather than remembered, which the supplier's ledger answers with the code it already
cut. Under real contention from two processes:

```
one attempt row throughout: a/1, finally ok
probe_count 1 -> 2 -> 3
one supplier_requests row — the staged one; no second request id anywhere
one delivery
unclaimed pool count: unchanged before and after
```

`probe_count` is the fingerprint. It moved twice because *both* resumers got through the guard, as they must;
the pool count not moving is the strongest line — the code both delivered came from the pre-staged claim, and
neither cut a new key. The guard has been quietly borrowing Phase 2's deterministic-id property (Q16), and
contributed nothing itself.

**And it is fragile, which is why it is its own row — R3.** Point 2 holds *only while every concurrent
resumer lands on probe*. A future rung that writes a row a probe does not, a ledger read moved out from under
the lock, a fall-through permitted while an attempt is `unknown` — any of these lets two resumers reach a
fall-through from different snapshots, two suppliers get two different questions, and two keys leave the pool.
`deliveries.order_id` UNIQUE still keeps the shopper to one, so the shop looks correct from outside; what
breaks is stock accounting, and that is the only assertion that can see it (Q23). `resumeIssuance` is kept as
a separate row rather than `delivering` widened into `retryIssuance`'s `from` list, so that its *from* list
says in one line that its guard is not what protects it.

*`phase-3-slice-5-pressing-retry-twice.md` §3; `technical-considerations.md` §2.3.*

### Q31 — "The retry didn't work the first time. What went wrong?"

The ladder could not serve it. The first retry attempt measured `200 still_out_of_stock` with
`request_id: …_b_2` and **no new attempt row — against a pool with keys in it**. The ladder had read "both
suppliers refused" as a verdict and re-settled the order without asking anyone. It read as correct because
`a` refused and `b` refused is the *same set of rows* whether written a millisecond ago by a walk still
running or a week ago by a walk that settled the order and went home — and the two need opposite answers.
**The rows cannot carry that fact, so the caller does**: one input, `Fresh`, passed by the operator's opening
turn and nothing else, read by exactly one branch — the last one — which under `Fresh` turns "every supplier
refused" into "ask again at `max(attempt) + 1`": `a/3`, never a reused `a/1` (Q20). A column cannot hold it,
because the fact is not about the rows, it is about *who is asking*, and the same rows are read by both. The
alternative — synthesising the rung in the runner, outside the pure function — is the second path into
issuance the design forbids, one level down: a rung the exhaustion never sees.

**The `Fresh` branch sits below the outstanding guard.** An order with an `unknown` attempt still probes and
still settles rather than asking anybody new. "The operator asked for it" is not a reason to obtain a second
key for a question whose outcome nobody knows.

**And the proof had to grow, because the input space had.** Slice 3's 894,049 histories had never once
evaluated `Fresh` — every call passed three arguments, which is the default round — so "the `Fresh` branch
sits below the guard" was true by reading the source and by nothing else. The space was doubled to
**1,788,098**, with zero violations under either value; the `Fresh` counts for *probe* and *settle: never
established* — 260,368 and 520,736 — are identical to the default counts, which is what "changes nothing
above branch 6" looks like when it is measured; and every one of the **6,272** "every supplier refused"
histories converts to "ask again" under `Fresh`. The total is asserted as exactly `2 × (1 + 96 + 96² + 96³)`,
so a refactor that quietly stops evaluating one round cannot pass by checking less. The third mutant — `Fresh`
moved above the guard — is Q21's 1,024 violations, the first of them `[a/1 failed, b/1 unknown]`, which is
exactly what a second operator's retry would do in the live delivery-failed race if `Fresh` outranked the
guard: read `[a/1 failed, b/2 failed, a/3 unknown]` and mint `a/4` instead of probing `a/3`.

*`phase-3-slice-5-pressing-retry-twice.md` §4.*

### Q32 — "Settled and terminal — aren't those the same thing?"

They were, for two phases, and that is the whole story of the slice. **Terminal** — `delivered`,
`payment_failed` — is I9: no transition leaves these states by any path. **Settled** is terminal plus the
recoverable pair, `out_of_stock` and `delivery_failed`: the states an order stops moving in *by itself*. The
contracts package always kept them apart, but until the operator could move a recoverable order they gave
the same answer to the page's only question — *can anything change what I am showing?* — so one predicate
served both. Then the Retry button made "will it move on its own?" and "can a person move it?" different
questions. The server still asks the first, correctly. The page had to start asking the second.

**So what was the bug?** There wasn't one, which is the interesting part. The page stopped polling on
*settled*. When `delivery_failed` joined the recoverable set, that predicate came to mean *stop on exactly the
two states an operator can move* — so a shopper watching «Не удалось выдать ключ» would never see the retry
land. The code did precisely what it was written to do, under a definition another slice changed underneath
it. It compiled, shipped, and kept every check green, and the requirement was unmet. **A criterion that fails
by definition rather than by bug.**

**How can every test pass while a requirement is unmet?** Because the tests ask about the server, and the
server was never wrong. The race suite's *wait until settled* uses the settled predicate, correctly, because
it wants to know when the shop is done. §2.6's third criterion is a claim about a browser tab somebody left
open, and no test in the repository has a tab. That is not a gap in those tests; it is a different kind of
claim, and the check that covers it has to be a browser check with the retry sent from a second context.

The RED made it literal: with the old condition restored, the shopper's page made **11 reads ending at
`t=9561 ms`** — the first read that returned `delivery_failed` — and no further reads, ever, while the
database showed the order `delivered` with a code. The fix is to stop asking the union and ask its two halves
separately: **stop** on terminal; **keep reading every 5 s** on recoverable — it is waiting on a person, and
people take minutes; and **snap back to 1 s** the moment a read shows the order in flight, because the retry's
`delivering → delivered` window is the same 25–65 ms the original issuance took, invisible on a 5 s beat, and
without the snap-back the page jumps from failure straight to key — a regression of Phase 2's watchable-stages
criterion caused by a change that never mentions it. Wall clock, shopper's tab untouched: nine reads at ~5 s,
retry sent from a shell, «Выдаём ключ» painted, next gap **1 013 ms** — the snap-back — then «Ключ выдан» with
the code, 606 ms after the retry answered. The watch is bounded at five minutes (A9): 61 reads at about 5 s,
then at 300 s the page says it has stopped and asks the shopper to refresh — the one message in the shop
allowed to say so, because it is the one moment «страница обновится сама» would be a lie.

A wire flag — the server telling the page whether to keep polling — was rejected in Phase 2 as a second copy
of the classification with somewhere to drift to. This slice adds the stronger reason: the server's settle
rule is precisely the question the page must *not* ask. A flag derived from it would have encoded the bug and
shipped it somewhere harder to see.

*`phase-3-slice-6-watching-recovery.md` §2–§4.*

### Q33 — "Your recovery checks pass. How do you know they would catch a broken retry policy?"

Because each was run against a build with its mechanism deliberately removed, the removal confirmed in
`dist/` before the result was read, and the source restored to the same hash afterwards —
`a5715427…86a24`, identical before and after every weakening. All three mechanisms live in one file, the
ladder, and each weakening was one branch of it. Every check went red: **6 of 18**, **5 of 16**, **9 of 25**
assertions. The finding is the other column:

| Check | Weakening | Failed | **Stayed green** |
|---|---|---|---|
| `recover-refusal` | the fall-through reused the failed attempt's id instead of deriving a new one | attempt row count; both rows' contents; the ledger row's supplier; which id claimed the key | **`the order settles delivered`, `exactly one deliveries row`, stock accounting** |
| `recover-timeout` | "definitely settled" widened to admit `unknown`, so the guard never fires | `claimed=2, deliveries=1`; a row for B exists; two attempt rows instead of one; `a/1` still `unknown` | **`the order settles delivered`, `exactly one deliveries row`, one key claimed by `a/1`** |
| `recover-out-of-stock` | the `Fresh` branch deleted — the pre-slice-5 ladder | the retry answered `still_out_of_stock` against fifty restocked keys; no third attempt row; the order still `out_of_stock`; the second retry `200` instead of `409` | **every assertion up to and including the restock — fifteen of them** |

**Under every weakening, every assertion phrased about the shopper passed.** A check that stopped at "the
shopper got one key" — the natural thing to write, and what §2.1's fourth criterion literally says — would
have passed all three.

The refusal row is the sharpest statement in the phase. Under the weakening, B was asked A's question. The
reserving insert for `b/2` carried `req_…_a_1`; `request_id` is UNIQUE; `ON CONFLICT DO NOTHING` swallowed
it; the follow-up read said *already reserved, carry on* — exactly what it says for a legitimate re-probe. B
issued. The success was recorded by request id, so it landed on **A's row**: `status: "ok"` with
`last_error: "supplier_rejected"` still on it — *a refusal that succeeded.* One key, one delivery, stock
accounting balanced to the unit. Nothing in the database distinguishes "the same id, asked again" from "a
different question sent under a stolen id"; the supplier's ledger cannot tell a re-probe from a fall-through
wearing a re-probe's clothes. **The id derivation is the whole mechanism**, and the only thing that can see it
broken is a check that reads attempt rows and request ids rather than stopping at `delivered`.

The timeout row is Q23's stock-accounting argument measured on the shipped check rather than quoted. And the
out-of-stock row is a regression test for a bug this phase actually shipped and found (Q31) — its RED output
is that bug's signature word for word: `"every supplier was asked and has nothing to issue"` reported against
fifty unclaimed keys, with no supplier called. If the check could not catch that, it could not catch the thing
it exists to prevent recurring.

Three findings, and all three point at the place Phase 2's did: the assertions that catch a broken ladder are
about rows, ids and counts — attempt row count, the supplier and attempt on each row, which id has a ledger
entry, claimed keys against deliveries, and a `409` that is zero rows from a guarded UPDATE.

*`phase-3-slice-7-checks-a-reviewer-can-run.md` §4.*

### Q34 — "What isn't finished?"

Answered in full in §5 below, with the five adversarial scenarios scored beside it. Offer it unprompted if the
moment fits; it is the strongest single thing in the deck, and it is the only question where the honesty *is*
the technical answer.

### Q35 — "You didn't write this, an AI did."

> "I directed it. I chose the architecture — Postgres-enforced invariants over application checks — and I
> decided what shipped and what didn't. Ask me about any decision in here: why `delivering` is a state, why
> the supplier's whole contract is `request_id → code`, why zero rows is never thrown as an error, why a
> timeout is `unknown` and not `failed`. That's what the walkthroughs are for. I wrote them to make sure I
> could."

Do not get defensive; the follow-up will be technical, and that is a gift. The strongest supporting facts are
the ones where **the measurement contradicted the plan**: the lock whose RED came back green (Q12), the check
that did not guard what its header claimed (Q15), the guard that was not what made the key count one (Q16),
the drain that missed the scenario it was written for (Q10), the documentation that staged the phase's central
trap so that it could not fire (Q18), the retry that re-settled an order against a full pool (Q31), and the
criterion that failed by definition while every test stayed green (Q32). A generated codebase does not
produce a document that argues with itself and then records who won. §7 is the list.

*`interview-notes.md`.*

---

## 4. What the three phases jointly prove that no one of them proves alone

These are the pairs and triples worth having ready, because each one is an answer a summary of any single
document could not produce.

**1. One key never reaches two orders — *and* that holds when the reports arrive fifty at once, out of order,
and duplicated — *and* when the supplier does not answer.** Phase 1 established the mechanism and measured it
by hand at twenty webhooks on one order. Phase 2 took it to the assignment's stated fifty, added the
same-`event_id` and before-the-order cases, and made all of it **one command a reviewer runs themselves, twice
in a row, against four processes.** Phase 3 added the case where the mechanism has to hold *without knowing
whether a key was cut*, re-confirmed scenario 1 at twenty concurrent reports across four processes (not
extended), and added three more checks to the same command. No part is worth much alone: Phase 1's proof lived
in a transcript, Phase 2's harness asserts nothing against a shop not built this way, and Phase 3's checks are
green against a shop losing a key per timeout unless they assert stock accounting.

**2. The server owns the state — *and* the state is visible — *and* the page knows when to keep looking.**
Phase 1 made the page a reader. Phase 2 moved the acknowledgement to the front, which made the intermediate
stages observable: webhook `200` → `delivered` was **~19–60 ms in Phase 1 and 25–65 ms in Phase 2**; the
stages did not get longer, the page's refresh simply fires at the *start* of the work, and nine real purchases
showed the intermediate state 9 times out of 9 with a **4/5 label split** that a scripted animation could not
produce. Phase 3 then broke the page without touching it: the operator's retry made *settled* and *terminal*
different questions, and the page stopped on exactly the two states a person can move (Q32). Each phase alone
gives a dishonest progress bar; Phase 3 alone gives a truthful one that has stopped looking.

**3. An early report is *stored* — *and* something comes back for it — *and* the one order nothing comes back
for is listed.** Phase 1's absent foreign key lets the row exist. Phase 2's four triggers make it a delivery
rather than a log line. Phase 3 found the order all four miss — claimed and then abandoned, resting in
`delivering`, which no trigger's `paid` ever matches — and made it findable by a list deliberately wider than
"stuck" and movable by a transition whose guard excludes nobody (Q26, Q30). Because the row is durable, no
trigger has to be reliable; because the triggers are layered, the absent FK never leaves anything stranded;
because the list is wide, the one thing the triggers cannot reach is still reached by a person.

**4. The mechanism can fail — *and* the checks can fail — *and* what stays green is the finding.** Phase 1's
RED weakened the key claim and got `expected 9 to be 20`. Phase 2 applied the discipline to five checks and
found which invariant each actually guards — one passed 8/8 against a build confirmed weakened. Phase 3 got no
null result and read the other column: under every weakening, every assertion about the shopper stayed green
(Q33). Together they are the difference between "I test races", "I know what each test is evidence *of*", and
"I know which assertions can never tell me anything".

**5. The column was written in Phase 1; the header in Phase 2 — and the ledger was written in Phase 1; the
policy that reads it twice in Phase 3.** `client_request_id` and its UNIQUE were in the schema before anything
sent the header, and Phase 1 said so. In the same way, `supplier_requests` and the *unknown*-versus-*failed*
classification on the attempt row were Phase 1's, with the policy explicitly deferred — *"a timeout is
recorded as `unknown` and the order rests in `delivering`; nothing re-drives it"*. Phase 3 supplied the
policy (probe, fall-through, settle), the retry, and the measurement — the 206 ms — that turns Phase 1's
spoken cost asymmetry into a fact about the wire (Q18). Phase 1's interview notes gave the answer before the
code existed; Phase 3 is the code. Deliberate sequencing, with the schema as the artefact that proves it.

**6. "Zero rows is normal" and "a status code is an instruction" are the same sentence at three layers.**
Phase 1 established it inside the database: a losing `UPDATE` is a caller who arrived late, not an error.
Phase 2 established it at the network boundary: a duplicate report is `200`, not `409`. Phase 3 established it
at the operator's screen: a `409` *is* zero rows from two guarded transitions — nothing ran, the list was
stale — and a retry whose response never came back is reported as *unknown*, *it may or may not have run*,
never as *failed* (Q29). All three are the same refusal — **do not turn a harmless race into an outage, and do
not turn ignorance into a verdict** — and an interviewer who hears them together hears one principle applied
consistently rather than three unrelated tricks.

**7. Phase 2 shipped the row lock as defence in depth and said Phase 3 would make it load-bearing; Phase 3
did, and showed exactly where.** Phase 1 predicted the shape (*"two workers inside `delivering` with different
attempt numbers"*). Phase 2 implemented the lock, removed it, ran the race ten times, got green ten times, and
explained why — two `UPDATE`s on one row already serialise on its write lock — while stating that the drain
never produces two attempt numbers. Phase 3 introduced the first decision Postgres cannot take in one
statement — the ladder over a set of rows — and two workers reading different snapshots is precisely two
attempt numbers (Q22). Predicted, measured absent, present: the lock went in before the code that needs it,
which is the order that avoids deadlocks. The honest coda is in Q22: Phase 3 localised the weight; it did not
RED the lock.

**8. The assertion that catches the bug is never the one about the shopper.** Phase 2, the double-click: two
scripted requests cannot fail the test, so only a real browser and a database count can pass it (Q4). Phase 2,
the weakened key claim: `race:webhooks` green 8/8, the concurrency suite `expected 10 to be 20` (Q15). Phase 3,
three times over: `claimed=2, deliveries=1` while the order read `delivered` with one delivery row; a refusal
that *succeeded* on A's row with one key and balanced stock; a retry re-settling an order against fifty keys
(Q23, Q33). In every case the shopper-facing assertion was green and the shop was wrong. It is the recurring
lesson of the project, and a candidate who says it unprompted has read their own checks.

**9. "Phase 3 adds a caller, not a repair" — said in Phase 1, shipped in Phase 3, and it is why the retry's
guarantees are free.** Phase 1's closing note; Phase 3's slice 5 is literally one call into the same runner.
Every guarantee §2.5 asks for was already a property of I3, I4, I5, I6 and I9, and Phase 2 and slice 3 had
already proven them on this code (Q28). *Reusing the code reuses the proofs* is only true because the earlier
phases refused to let any guarantee live in application code, where a second caller would have needed a
second copy.

---

## 5. Where the argument stops

### The five adversarial scenarios, scored honestly

`context/product/product-definition.md` §1.4 lists five scenarios and calls them the definition of success.
**The double-click is not one of them** — it is Phase 2's headline requirement and spec 002 §2.1, with its own
check, `create-order`, which defends the guarantee underlying all five. Conflating the two misquotes the
assignment to the person who wrote it, so the distinction is worth being precise about even though it makes
the tally look smaller.

| # | Scenario | Status after Phase 3 | Runnable as |
|---|---|---|---|
| 1 | 50 parallel `paid` reports for one order → one issuance fact, one key consumed | **Settled** (Phases 1–2); re-confirmed in Phase 3 slice 2 at 20 concurrent reports across 4 processes, not extended | `pnpm race webhooks` |
| 2 | A repeated report with the same `event_id` changes nothing | **Settled** since Phase 1 by the `event_id` PRIMARY KEY; runnable since Phase 2 | `pnpm race same-event` |
| 3 | A report arriving before its order, or out of order | **Settled** in Phase 2 — stored by the absent FK, applied by the four triggers (with the `SKIP` caveat in Q17) | `pnpm race before-order` |
| 4 | An empty key pool leaves the order recoverable; after restocking, exactly one key | **Settled in Phase 3.** Slice 1 made the state recoverable, slice 3 built the mechanism, slice 4 made the order findable, slice 5 is the retry — empty pool, `out_of_stock`, restock, one press, `a/3` issued, one delivery, one claimed key, the order gone from the list — and slice 7 made it runnable by name | `pnpm race recover-out-of-stock` |
| 5 | A promo code with limit N, under parallel requests, applied at most N times | **Phase 5. Not started** — the tables do not exist | — |

**Four of five settled and runnable by name.** The other two recovery checks cover functional spec §2.1
(`recover-refusal`) and §2.2 (`recover-timeout`) — requirements of Phase 3 rather than numbered scenarios of
the assignment. §2.2 is the phase's central trap, the answer to the assignment's own «таймаут ≠ отказ»,
which is not one of the five but is the sentence the five are built around.

**▸ Scenario 4's mechanism changed between Phase 2 and Phase 3, and the Phase 2 sentence must not be
quoted.** `phase-1.md` and `phases-1-and-2.md` both said a restock *"re-issues cleanly against the same
derived request id (verified end to end, because an out-of-stock refusal writes no supplier ledger row)"*.
That was true of the shop it was measured on — one supplier, one attempt row, no ladder. Phase 3's shop settles
an out-of-stock order with two refused rows, `a/1` and `b/2` (R12: one wasted call per out-of-stock order,
stated up front, because one shared pool is empty for both suppliers), and its retry asks a **new** question,
`a/3` at `max(attempt) + 1` — never a reused id, because a reused settled id collides with its own row in the
reserving insert and is swallowed as if it were a re-probe (R7, Q20). The first version of the retry got this
wrong in the other direction and re-settled the order without asking anyone (Q31). Say `a/3`.

The double-click has its own check, `pnpm race create-order`: twenty concurrent Buy attempts sharing one intent
key, which also asserts the **negative complement** — a *fresh* key still creates a *new* order. Without that
second half, a check proving only "concurrent things converge" would pass against an implementation that
merges every purchase of one item into a single order forever, which is Q4's content-hash failure wearing a
green tick.

### What is not finished — carried forward without softening

Every gap from three phases, each with the reason it was deferred rather than missed. Where a Phase 2 gap was
closed in Phase 3, it is marked closed rather than deleted, because the pairing is itself the answer to "how
do you decide what to defer?"

- **The row lock's RED came back green in Phase 2, and that was correct then.** Ten executions, defence in
  depth, changed no observable outcome for the code that existed. Phase 3 is where it carries weight — the
  ladder's read of a set of rows — and Phase 3 **did not RED the lock itself**; all three of its weakenings hit
  the ladder. "Load-bearing" is argued and localised (Q22), not measured by removal.
- **`race:webhooks` does not guard the atomic key claim it names.** `pnpm test:concurrency` does (Q15). And
  when `race:webhooks` did catch a widened guard, it caught it **through its teardown, not an assertion** —
  recorded in the harness README (Q16).
- **The guarded transition is not what makes the key count one.** The supplier's ledger and
  `deliveries.order_id` UNIQUE do that (Q16) — and Phase 3's `resumeIssuance` rests on exactly this, which is
  the next entry.
- **`resumeIssuance` is contained by the lock and by both resumers computing the same rung, not by its
  guard.** Stated in the transition table and as R3. Any future rung that writes a row a probe does not, or a
  ledger read moved out from under the lock, breaks it — and the only assertion that would notice is stock
  accounting (Q30).
- **Stock accounting is a bound, not a guarantee.** On a never-established outcome one key per outstanding
  attempt may be gone — claimed in a silent supplier's ledger under an id whose code the shop never received.
  The phase bounds that loss; it does not eliminate it, and a check asserting the equality everywhere would
  fail against a correct system (Q24).
- **The restock endpoint was specified and never built.** The technical notes describe
  `POST /internal/suppliers/keys`; no task scheduled it; nothing in the functional spec requires a wire-level
  restock. `recover-out-of-stock` restocks over direct SQL — un-claiming the exact rows it had itself claimed
  a moment earlier under a marker id of its own, the technique the schema reserves for tests. Every assertion
  is exercised; the wire affordance does not exist; the check's header names the one place to point at it if
  it is built. Found while writing the check, and a check may not add production code.
- **The intermediate frame is probabilistic.** This is Phase 2's timing-window caveat — *the watchable order
  page rests on a timing window nothing structurally defends* — in its Phase 3 form. The snap-back cannot make
  a 25–65 ms window visible on a 5 s beat; two of the verifier's runs went from `delivery_failed` straight to
  `delivered`, and observing «Выдаём ключ» took a legitimately slowed supplier. The guarantee the criterion is
  about — the key appears with nobody touching the page — held every time (Q32). The two structural fixes —
  pushing each transition over a socket, or recording transitions server-side so the page reads the *history*
  — remain more machinery than the criterion is worth at this scale.
- **The shutdown bound now gives up on the longest legitimate walk.** A full ladder walk can take 12 000 ms;
  the process waits 3 000 ms on `SIGTERM` and then prints what it abandoned. The two constraints on that
  number became mutually exclusive, the premise of one was false, and the one that gives is the recoverable,
  loud failure over the silent one (Q8).
- **`recover-timeout` costs about 2.4 s** and could only be faster by making the spawned instances a different
  shop. **`recover-out-of-stock` has no HTTP-only half**: against a target whose database the reviewer cannot
  reach it skips entirely rather than printing a pass over three status codes (Q17).
- **`out_of_stock` was never watched in a browser** — Phase 2's gap, **closed in Phase 3 slice 1**, whose
  render verification records that `out_of_stock` "was driven through the real issuance path with a real
  empty pool" while `delivery_failed` had to be reached by writing the row with SQL, because nothing in the
  shop could produce it until slice 3 did — *"the state renders" is proven and "the shop can get there" is
  not*, said in those words. Slice 6 then watched a real `delivery_failed` become `delivered` in a tab nobody
  touched.
- **A shopper whose browser blocks site storage loses one of the four guarantees in Phase 2's Keystone 1.**
  The intent name falls back to per-document memory, so repeated clicks and retries in one tab still share a
  name and two *tabs* no longer do. A deliberate, specific degradation rather than a crash — reading that
  storage can itself throw, and an uncaught throw there takes the purchase down for a reason unrelated to
  buying anything.
- **There is no root `README.md`.** `architecture.md` §7 says the scenario-to-check mapping lives there and
  calls that mapping the deliverable; the table above is that mapping, waiting for Phase 6. The per-check
  aliases Phase 2 wrote down as missing now exist — all seven — and the harness README's stale port range was
  fixed in Phase 3's slice 7.
- **Two stale comments found by one slice and fixed by a later one.** The wire type's polling header still
  described the old stop-on-settled rule when slice 6 was written and now states the terminal/recoverable
  split; `supplier_requests.provider` was *written but not read* at the end of slice 2 and is read since slice
  3. Both are named because a comment describing code that is not there is the cheapest thing for a reviewer
  to find.
- **Out of scope by design:** the designed storefront (Phase 4); promo codes (Phase 5); public deployment
  (Phase 6); automatic scheduled retrying (R11, deliberately absent — Q28); and webhook signature verification,
  which the assignment waives.

Offering this list unprompted is stronger than being walked through it. The pairing in `interview-notes.md` —
each Phase 1 gap with a `→` line recording what Phase 2 did about it — and the same pairing here between
Phase 2's gaps and Phase 3's closures, are together the answer to "how do you decide what to defer?"

---

## 6. The sentences worth memorising verbatim

`interview-notes.md` carried three; Phase 2 earned a fourth and changed what stood behind two. Phase 3 earns
three more and changes what stands behind three of the four.

1. **"Every guarantee is enforced by the database — never by a check in application code, never by a lock
   inside one process."**
   *Strengthened, and given a second clause.* Phase 1 argued it; Phase 2 measured the consequence of ignoring
   it — 20 distinct keys against one process, 9 against four. Phase 3 met the first decision Postgres cannot
   take in one statement and did not bend the rule: **where a decision needs more than one statement, the rows
   are read under the lock and the decision is a pure function of what they say.** That clause is why a
   six-branch policy could be proven over 1,788,098 histories, and why the lock stopped being decorative.

2. **"All twenty ran the check before any of them had inserted, so all twenty saw zero — and every one of
   those checks was correct at the instant it ran."**
   *Unchanged, and Phase 3 supplied its third instance.* The `switch` on the status the lock returned is the
   same mistake one statement shorter — *the value was true when the `SELECT` ran, the transition is written
   a statement later* — and the reason it would survive review is that under the current lock the window
   happens to be empty (Q29).

3. **"The hard part of a race test isn't the assertions — it's proving the test could ever have been red. And
   doing that is the only way to find out which invariant each test actually guards."**
   *Changed: Phase 3 added the third clause.* **"— and which assertions can never tell you anything."** Under
   every one of Phase 3's weakenings, every assertion about the shopper stayed green (Q33). The clause Phase 2
   added was about what a check guards; Phase 3's is about what a check is structurally blind to.

4. **"Being slow manufactures the concurrency you then have to survive."**
   *Unchanged.* Phase 3 made the longest unit of work after the answer six times longer — one 2 000 ms
   supplier call became a 12 000 ms walk — and nothing in the acknowledgement path had to change; the
   sentence needed nothing.

5. **"A timeout is not a description; `failed` is a licence."**
   *New in Phase 3, and the phase's thesis in nine words.* The key was cut 206 ms after the client had
   classified the call, so whatever the shop writes at that moment is written in ignorance. `unknown` is the
   only truthful record, and `failed` is not a fact about the supplier — it is permission to ask a different
   one for a second key, which may only be granted on an explicit, parseable no (Q18).

6. **"The only difference is the missing `UPDATE`, and that missing statement is the phase in one line."**
   *New in Phase 3, and the one to reach for when asked to point at the mechanism.* Two transactions,
   statement for statement identical except that the silence path writes nothing about the attempt — because
   the row was born `unknown` before the call went out and nothing truthful has changed (Q22). It is a
   guarantee enforced by an omission, so it has to be pointed at rather than found.

7. **"A shop can be wrong about the world and still be right about its records."**
   *New in Phase 3, and the through-line of all three phases said from the far end.* A timeout is `unknown`,
   not `failed`; a stranded order is listed, not lost; a retry is the same issuance, not a new one; and an
   operator whose retry timed out is told *it may or may not have run*. Every one of those is the shop
   refusing to write down something it does not know.

Runners-up worth having loaded, though not memorised: **"The same content is not the same intent"** (the whole
of Q4); **"A race check that cannot fail is worse than no race check, because it grows more convincing every
time it passes"** (the whole of Q14); **"The lock serialises the workers; the guard decides — both, or neither
is enough"** (Q12 in Phase 2, Q22 in Phase 3, the same sentence with a bigger guard); **"The assertion that
catches a broken ladder is never the one about the shopper"** (Q23, and §4's eighth proof); **"Reusing the
code reuses the proofs"** (Q28); and **"A calm screen five minutes behind is worse than a busy screen that is
true"** (Q26).

---

## 7. A note on process

This is the honest answer to "what did you learn", and it is short because none of it is a mechanism. Across
three phases:

- **A verifier refused to tick a box and found a planning error.** Phase 3's slice 2 was planned with all
  failure injection deferred to slice 3, which left its own headline scenario — *a supplier that refuses* —
  unstageable. The verifier armed A, bought, watched the order deliver via A with a single `a/1 ok` row,
  reported BLOCKED, and did not tick the box. The fix split the work on a real seam rather than moving it:
  refusal injection belongs before the key claim; only the *hang* placement belongs to slice 3, because a hang
  has to sit after the claim commits for the ledger to hold a code (`phase-3-slice-2-…` §4).
- **Two harness assumptions produced correctness-shaped failures in unrelated suites.** A cleanup helper
  derived exactly one request id per order, `req_{order}_a_1`, because through two phases that was the only
  id the shop could mint; the first fall-through to `req_{order}_b_2` left a claimed key nothing returned,
  and it surfaced later, elsewhere, as `unclaimed = 49, expected 50`. `phase-3-slice-2-…` §6 names a second of
  the same shape, a readiness budget in the concurrency support, and the pattern: *helper code accumulates
  assumptions about what the application can do, and the application changing is exactly when nobody re-reads
  the helper.* Phase 2 had its own instance — the acceptance suite turned out to bind the race harness's port
  range, found closing the phase, and the README lagged the fix by a phase (Q17).
- **Documentation was confidently wrong in five places for two phases.** The inequality that stages the
  phase's central trap was stated backwards in the architecture, the config module, `.env.example`, the
  technical notes, and an agent briefing — and staged that way the headline check passes having exercised
  nothing (Q18). It was not a typo; it was a true sentence about a different scenario being cited for this one.
- **A RED came back green, and that was the finding.** The order lock, ten executions (Q12); and
  `race:webhooks` at 8/8 against a gutted key claim (Q15). Both were real null results with exact reasons, and
  both changed what the project claims about itself rather than being filed as "the test is weak".
- **Two specialists disagreed, and checking who was right exposed a real hole.** The backend plan wanted
  `resumeIssuance`; the data-layer plan objected that a guard which excludes nobody cannot be the mechanism.
  Both were right, and working out *why* both were right surfaced that without the transition nothing in the
  system could ever move a stranded order again (Q30). The same pass corrected the backend plan's three-column
  UNIQUE before the migration was written (Q20).

Two more from Phase 2 belong in the same list: the drain written for the before-order scenario missed it in
the one genuine race run, and a later trigger caught it (Q10); and the spec was walked back honestly for one
phase and walked forward again in the next, both times with a dated entry, which is a better story than a
criterion that was quietly always true.

None of those is a mechanism. All of them are the reason the mechanisms are believable — because a project
that records its verifier saying no, its helper lying, its documents wrong, its RED green and its specialists
disagreeing is a project whose green results were not obtained by looking away.

---

## 8. Where the evidence lives

| File | Read it for |
|---|---|
| `phase-1.md` | The three Phase 1 keystones, the nine-invariant table, Phase 1's own honest gaps and its predictions of Phase 3 |
| `phase-2.md` | The four Phase 2 keystones, the scenario scoring, the harness |
| `phase-3.md` | The four Phase 3 keystones, the vocabulary, the scoring after Phase 3 |
| `interview-notes.md` | The spoken versions, the questions to fear, and the `→` annotations closing each Phase 1 gap |
| `slice-1-data-model.md` | The 20-session experiment (Q2); the missing foreign key (Q9); `SERIALIZABLE` (Q1) |
| `slice-2-order-lifecycle.md` | Why not two booleans; the 1.6-second lock (Q3); pricing |
| `slice-3-webhook-inbox.md` | Why winning an insert *is* duplicate detection; status codes as instructions |
| `slice-4-supplier-idempotency.md` | `request_id → code`; the `SIGKILL` counterfactual; the 959 ms convoy (Q11); the 1-vs-4-process measurement (Q14); «таймаут ≠ отказ» stated operationally (Q19) |
| `slice-5-issuance.md` | The thirteen hops; the attempt row written *before* the call; definite vs unknown |
| `slice-6-out-of-stock.md` | One key, two orders; the three status lists |
| `slice-7-proving-the-race.md` | Phase 1's RED; asserting against the database, not just responses |
| `phase-2-slice-1-one-order-per-intent.md` | Intent versus content; where the key is minted; the two causes of zero rows (Q4, Q5) |
| `phase-2-slice-2-answer-then-work.md` | The 72 ms answer; the status-code table; the tracked scheduler (Q6, Q7, Q8, Q13) |
| `phase-2-slice-3-out-of-order.md` | The absent foreign key; why four triggers; the poll gate's occupancy argument (Q9, Q10) |
| `phase-2-slice-4-watching-the-stages.md` | The 25–65 ms measurement that disproved the obvious explanation; the 4/5 split |
| `phase-2-slice-5-one-worker-per-order.md` | Guard versus lock; `FOR UPDATE` vs `SKIP LOCKED` vs `FOR NO KEY UPDATE`; the RED that came back green (Q11, Q12, Q13) |
| `phase-2-slice-6-checks-a-reviewer-can-run.md` | The harness; all five RED outcomes; the null result (Q14, Q15, Q16, Q17) |
| `phase-2-slice-8-the-acceptance-suite.md` | What Phase 2 settles; the port note |
| `phase-3-slice-1-a-failure-you-can-see.md` | Terminal versus recoverable versus settled; `TS2344` before the rule existed; four tripwires; a CHECK widened in 4.5 ms (Q25) |
| `phase-3-slice-2-a-backup-supplier.md` | The derived id; per-order numbering and R7; `UNIQUE (order_id, attempt)`; one pool and R12; the verifier who refused to tick (Q19, Q20, §7) |
| `phase-3-slice-3-silence-is-not-failure.md` | The 206 ms measurement; the inequality wrong in five places; the two transactions that differ by one missing `UPDATE`; 894,049 histories and two mutants; stock accounting; the shutdown bound (Q8, Q18, Q21, Q22, Q23, Q24) |
| `phase-3-slice-4-finding-the-stuck-orders.md` | 4 996 versus 2 469 012 buffers; why the list is wider than "stuck"; three silent traps in one statement; the outstanding request id (Q26, Q27) |
| `phase-3-slice-5-pressing-retry-twice.md` | One call, no admin-only path; `409` as zero rows; a guard that excludes nobody; `Fresh`, the doubled proof and the 1,024-violation mutant; two `200 delivered` responses (Q28–Q31) |
| `phase-3-slice-6-watching-recovery.md` | Settled and terminal parting ways; the RED that stopped at 9 561 ms; the snap-back; A9's five-minute window (Q32) |
| `phase-3-slice-7-checks-a-reviewer-can-run.md` | The three checks; the RED table and its "stayed green" column; the three ways to arm a supplier that prove nothing; skipping honestly (Q17, Q33) |

The nine invariants and the exact SQL for each: `context/product/architecture.md` §3, §3.1; the corrected
timeout ordering, §5. The multi-process rule: §7. The order-id affordance: §9. The Phase 3 risk register
(R2, R3, R7, R11, R12) and assumptions (A3, A9): `context/spec/003-failure-and-recovery/technical-considerations.md`
§11. Requirements: `context/spec/001-purchase-and-key-delivery/functional-spec.md`,
`context/spec/002-single-issuance-under-races/functional-spec.md`,
`context/spec/003-failure-and-recovery/functional-spec.md`.

**On evidence:** every number in this document is quoted from the walkthrough named beside it. Nothing was
measured or re-run while writing it, and no source file was modified.
