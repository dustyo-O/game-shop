# Phases 1 to 5 — one argument, and the question each part of it answers

> Every other document in this folder explains **one slice** or **one phase**. This one is the map. It
> supersedes `phases-1-to-4.md`, which stays in place with a pointer here, as that document superseded
> `phases-1-to-3.md` and that one `phases-1-and-2.md`. `phase-1.md`, `phase-2.md`, `phase-3.md`, `phase-4.md`
> and `phase-5.md` each make their own argument once; this document says why the first three are *the same
> argument* and the fifth its second instance, and gives the single answer to each question an interviewer is
> likely to ask — so that being asked them in any order does not require remembering which document they
> came from.
>
> Nothing here is new evidence. Every number is quoted from the walkthrough named beside it, which records
> how it was captured. No source file was read for measurements and none was modified.

> **▸ Phase 4, and what it does to this map.** Phase 4 changes nothing in the concurrency argument. It adds a
> **face** — the storefront the assignment asked for on its first page, structurally close to the mockup, with
> exactly five graded interactions and everything else static on instruction — and a **testing layer**: Vitest
> for the page's pure models and a Playwright project a reviewer can run. The join between the face and the
> engine is one line of code and three empty diffs (`apps/api`, `packages/contracts`, `packages/db`), so the
> spine (§1), the nine joint proofs (§4) and the seven memorised sentences (§6) stand as written, and §3 is
> Phases 1–3's text with in-place edits marked ▸ only where Phase 4 made a sentence false. Phase 4's own
> questions live in **Appendix A** (Q36–Q58), numbered on from Q35; the earlier answers it touches are tabled
> in **Appendix B**; its memorised sentences are **Appendix C**. Two exceptions to "stands as written", named
> here so they are not discovered: **(a)** the spine's testing layer (§1, layer 4) and Q17 — *what can a
> reviewer run* — now have a browser layer to mention, with a RED method of its own that weakens nothing in
> `src/`; **(b)** the honest gap *"no browser tests"* (`architecture.md` §7, since Phase 1) is no longer the
> gap. It became *"no browser test can reach the cached restore"* — a smaller gap, differently shaped: three
> `pageshow` handlers exist for a path every automated browser is disqualified from taking, measured three
> times as `persisted: false`, `notRestoredReasons: [{ reason: "masked" }]` (Appendix A, Q55 and Q58).

> **▸ Phase 5, and what it does to this map.** Unlike Phase 4, Phase 5 *does* touch the concurrency argument
> — not by changing it but by being its **second, independent instance**. The assignment's bonus stage is a
> limit on a **counter** rather than a key in a pool; the guard is **one conditional `UPDATE`**
> (`… SET used_count = used_count + 1 WHERE id = $1 AND used_count < max_uses RETURNING used_count`) rather
> than `FOR UPDATE SKIP LOCKED`; the proof is the **same four-process measurement** (the broken shape admitted
> nine, then eleven, of twenty for a limit of three, and would admit exactly three against one process); and
> the trap is the **same CHECK-shaped one** Phase 2 met as a UNIQUE index — a backstop that holds with the
> mechanism gone, so that a test reading the counter passes while seventeen shoppers are answered `500`. So
> the spine's sentence about the rule gains its second example in one ▸ clause (§1), and §2–§3, §5 and §8
> carry in-place ▸ edits only where Phase 5 made a sentence false: Q5's count of statements, Q17's *what can
> a reviewer run* (nine checks; `pnpm race promo`; `promo-limit-race.test.ts` on every `pnpm test`), the
> scenario table's fifth row and its *four of five*, the honest-gaps list, and the evidence table. The nine
> joint proofs (§4) and the seven memorised sentences (§6) stand as written, with the exceptions named here
> so they are not discovered: **(a)** §4's proofs 1, 4, 6 and 8 and §6's sentences 1–3 each gain an
> *instance* from Phase 5, tabled in Appendix E and Appendix F rather than edited in; **(b)** §5's *where the
> argument stops* listed Phase 5 as future work — it is done, and what it leaves open is named there: R6's
> apply-vs-pay window, the lock gap in the reviewer's copy, and two harness findings; **(c)** the one thing
> Phase 1 predicted about this phase and got wrong — I8's key, `UNIQUE (promo_id, order_id)`, which Phase 5
> strengthened to `PRIMARY KEY (order_id)` — is the first row of Appendix E, with Phase 1's wording quoted.
> Phase 5's own questions are **Appendix D** (Q59–Q79), numbered on from Q58; the earlier answers it touches
> are tabled in **Appendix E**; its memorised sentences are **Appendix F**. Every Phase 5 number is
> `phase-5.md`'s, with its section named beside it, as this map does for the other phases.

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
thing the two processes share is Postgres, so Postgres is the only place a decision can be made. **▸** Phase 5
is that rule's second, independent instance — a limit on a counter rather than a key in a pool, one conditional
`UPDATE … WHERE used_count < max_uses` rather than `FOR UPDATE SKIP LOCKED`, the same broken shape measured the
same way: nine of twenty for a limit of three across four processes, and exactly three against one (Appendix D,
Q59–Q61).

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

**▸ Phase 4 and the layers.** Phase 4 adds no sixth layer and moves nothing between these five. It touches
two. Layer 2 gains a clause: the page now owns *view* state — which slide is showing, whether the menu is
open, which currency is checked — and still owns no *domain* state; the card is a reader of the same
catalogue, and Купить is the same delegated control Phase 1 wired. Layer 4 gains a browser instance in which
the RED is an *inversion* rather than a weakening: the identical "nothing happened" assertion pointed at the
one control that does something, failing on three lines (Appendix A, Q38). Appendix B tables both.

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
questions sit with the mechanisms they answer. **▸** Phase 4's questions are Q36–Q58, indexed and answered in
Appendix A rather than here, because none of them is a question about the concurrency argument. **▸** Phase 5's
are Q59–Q79, in Appendix D — and those *are* questions about the concurrency argument, kept as an appendix so
that every Q number the earlier maps gave stays stable and the second instance sits beside the first rather
than inside it.

| # | The question | The one argument that answers it | Evidence |
|---|---|---|---|
| Q1 | Why Postgres, and why Drizzle rather than Prisma? | Postgres is the subject of the assignment, not a storage choice; Drizzle because `FOR UPDATE` is typed rather than a raw-SQL escape hatch | `architecture.md` §2 |
| Q2 | Why `ON CONFLICT` rather than checking first? | A check followed by an act has a gap, and the gap is where the other process lives. Twenty sessions, every check correct, twenty keys | `slice-1-data-model.md` §5 |
| Q3 | Why a state machine and not a `paid` flag? | `paid=true, delivered=false` is four different situations, and `delivering` is a claim that needs somewhere to live outside one process's memory | `slice-2-order-lifecycle.md` §2 |
| Q4 | What stops a double-click making two orders? | An `Idempotency-Key` naming the *intent*, minted per SKU in `localStorage`. The server half is the easy half | `phase-2-slice-1-…` §2–§3 |
| Q5 | Zero rows came back. What happened? | It depends on the statement — eight statements now, and two of them have two causes each that must not be conflated. One of the eight meanings is an HTTP `409`. **▸** Ten since Phase 5, and one of the two new meanings is the first zero-rows-that-throws — Appendix D, Q65, Q68 | `phase-2-slice-1-…` §5; `phase-3-slice-2-…` §2; `phase-3-slice-5-…` §2; `phase-5.md` §5 |
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
| Q17 | What can a reviewer run, and what does it still not cover? | `pnpm race` — eight checks (**▸** nine since Phase 5: `pnpm race promo`), four processes, twice in a row, pointable at a deployed URL. Plus `pnpm test:concurrency`, which is the one that actually guards the key claim (**▸** and, since Phase 5, the one that guards the same-order case `pnpm race promo` cannot see). **▸** Since Phase 4, `pnpm test:web` and `pnpm test:e2e` as well — Appendix A, Q55–Q57; Appendix D, Q71, Q79 | `phase-2-slice-6-…` §2, §7; `phase-3-slice-7-…` §1, §5; `phase-4-slice-7-…` §3; `phase-5.md` §7, §9 |
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
statements now, eight meanings — **▸** ten since Phase 5, the two rows marked ▸:

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
| **▸** I7, the promo counter (`UPDATE promo_codes SET used_count = used_count + 1 WHERE id = $1 AND used_count < max_uses RETURNING used_count`) | `exhausted`. Not an error — nothing was written, the transaction commits empty, and the shopper is told `409 { "reason": "exhausted" }`, which under twenty simultaneous shoppers is the limit *holding* (Appendix D, Q60, Q65) |
| **▸** I8, the promo ledger (`INSERT … promo_redemptions … ON CONFLICT (order_id) DO NOTHING RETURNING order_id`) | **Impossible under the order lock, and therefore thrown** — the first zero-rows in the codebase that is a `500` and not an outcome: the transaction read this table under the lock and found nothing, so a conflicting row means the lock discipline was broken; the throw rolls back the I7 increment (Appendix D, Q68, Q71) |

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
causes when a read can tell them apart, and forbid the collision when it cannot. **▸** Phase 5 adds a
third response: when a zero-row result is *impossible* under the lock the caller holds, it is thrown, because it
is evidence of a bug and not of a busy shop (Appendix D, Q68).

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
pnpm race                              # all eight, against 4 freshly built local processes — ▸ nine since Phase 5
pnpm race webhooks recover-timeout     # only the named ones
pnpm race:recover-out-of-stock         # the same thing through the per-check alias
pnpm race --list                       # what exists; runs nothing, needs nothing running
RACE_BASE_URLS=https://…  pnpm race    # a deployed target: builds nothing, spawns nothing
pnpm race promo                        # ▸ the ninth check, since Phase 5: twenty LIMIT3 and ten ONCEONLY across the four
pnpm test:concurrency                  # the suite that actually guards the key claim — and slices 2, 3, 5's races, ▸ and promo-limit-race.test.ts
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
That is earned by every check cleaning up in a `finally` block. **▸** Nine since Phase 5: `promo` — twenty
simultaneous `LIMIT3` applications across the four instances and ten of `ONCEONLY`, asserting the *shape* of the
responses before the counter (exactly `3 × 200`, `17 × 409 exhausted`, **zero `5xx`**, then `used_count = 3`,
exactly three ledger rows whose `order_id` set equals the winners', the three at `96750` and the seventeen still
at `129000`); run twice back to back, **3 × 200 / 17 × 409 and 1 × 200 / 9 × 409, both passed**, and `pnpm race`
for all nine **9/9** (`phase-5.md` §7). Its cleanup is the reason the second run starts from zero, and it is a
*decrement* of exactly what the run spent, never a recompute (Appendix D, Q64).

Which is worth one small confession, because it broke the exact property it existed to protect: the first
version of the `SKIP` outcome called `process.exit(3)` **inside the `try`**, which terminates immediately and
skips the `finally`, leaving the early payment report on disk so the next run started dirty. The fix is to set
a flag, fall out of the `try`, let cleanup run, and set the exit code at the end. **`process.exitCode` sets a
value; `process.exit()` is control flow wearing a value's clothes.**

Things about the checks worth knowing before a reviewer finds them:

- **`pnpm test:concurrency` is not redundant with `pnpm race`.** They answer different questions: `race`
  answers "does one order survive fifty reports", the Vitest suite answers "do N parallel orders yield N
  distinct keys". Q15 is why that distinction is not a matter of taste. Phase 3's two-operator races, the
  stranded-order resume and the delivery-failed retry also live in the Vitest suite. **▸** Phase 5 gives the
  distinction a third form: `promo-limit-race.test.ts`, run by every `pnpm test`, has a same-order scenario —
  four presses on one order — that `pnpm race promo` does not, and the lock RED (`FOR UPDATE` removed from the
  order lock) went red only there while the reviewer's copy printed `passed` (Appendix D, Q71).
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

**▸ Since Phase 4 there are two more commands, and neither is redundant with the six above.** `pnpm test:web`
— Vitest in `apps/web`, `environment: "node"`, no jsdom, **5 files / 56 tests** in ~200 ms (238 ms when
`phase-4.md` ran it, ~190 ms when Slice 7 did), chained after the API suites inside `pnpm test` — proves the page's pure models; `pnpm test:e2e` — Playwright, **58 tests
in 9 files in 45.5 s**, deliberately *not* chained, because it needs a browser and starts two servers —
proves the five graded interactions, the fourteen inert controls and a real buy-through to a key. What each
proves and cannot, why they share one database with the API suites, and what `orders = 55` taught are
Appendix A, Q55–Q57. **▸** Since Phase 5 the counts are **6 files / 69 tests** for `pnpm test:web` and **64 in
10 files** for `pnpm test:e2e` (`promo.spec.ts`, T1–T6, real clock), with `pnpm test`'s API half at **14 files /
120 tests** (`phase-5.md` §9; its §11 records the tenth acceptance `it(` and the e2e `T7` that landed as Slice 6
began — 121 and 65 as the tree stands, Slice 6's run to report). The three suites still share one database, and
Phase 5 added three baseline rows to it — four codes, `sum(used_count) = 0`, no ledger rows — so a leaked use
fails the next suite's precondition rather than passing silently (Appendix D, Q64).

*`phase-2-slice-6-…` §2, §5–§7; `phase-3-slice-7-…` §1, §3, §5, §6; `phase-4-slice-7-acceptance.md` §3;
`phase-5.md` §7, §9.*

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
open, and no test in the repository had a tab (**▸** since Phase 4 one does — the Playwright project — and it
still does not cover this criterion: `buy-through.spec.ts` watches a *delivery* land on the real clock, not a
recovery sent from a second context; Appendix B). That is not a gap in those tests; it is a different kind of
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

| # | Scenario | Status after Phase 3 (**▸** row 5: after Phase 5) | Runnable as |
|---|---|---|---|
| 1 | 50 parallel `paid` reports for one order → one issuance fact, one key consumed | **Settled** (Phases 1–2); re-confirmed in Phase 3 slice 2 at 20 concurrent reports across 4 processes, not extended | `pnpm race webhooks` |
| 2 | A repeated report with the same `event_id` changes nothing | **Settled** since Phase 1 by the `event_id` PRIMARY KEY; runnable since Phase 2 | `pnpm race same-event` |
| 3 | A report arriving before its order, or out of order | **Settled** in Phase 2 — stored by the absent FK, applied by the four triggers (with the `SKIP` caveat in Q17) | `pnpm race before-order` |
| 4 | An empty key pool leaves the order recoverable; after restocking, exactly one key | **Settled in Phase 3.** Slice 1 made the state recoverable, slice 3 built the mechanism, slice 4 made the order findable, slice 5 is the retry — empty pool, `out_of_stock`, restock, one press, `a/3` issued, one delivery, one claimed key, the order gone from the list — and slice 7 made it runnable by name | `pnpm race recover-out-of-stock` |
| 5 | A promo code with limit N, under parallel requests, applied at most N times | **▸ Settled in Phase 5.** Slice 1 built the two tables and the CHECK, slice 2 the transaction (eight steps, six statements, refusals before writes), slice 3 the four-process proof — `LIMIT3` ×20 → exactly 3 × `200`, 17 × `409 exhausted`, zero `5xx`, `used_count = 3`, three ledger rows equal to the winners' set; `ONCEONLY` ×10 → 1 — with three REDs (nine and eleven of twenty under a read-then-increment; seventeen `500`s under an unconditional increment while every database fact stayed correct; three `500`s and a counter held by the rollback with the order lock gone) and the reviewer's copy; slice 4 the shopper's form (`phase-5.md` §1, §6, §7) | `pnpm race promo` |

**▸ Phase 4 settles no scenario.** The column still reads "after Phase 3" because "after Phase 4" would
read identically: the storefront sends the same `POST /api/orders` the plain page sent, `apps/api` has no
diff, and `pnpm race` still lists eight checks. `phase-4-slice-7-acceptance.md` §8 re-scores this table
unchanged and puts a second one beside it — the five graded interactions, each mapped to a spec under
`apps/web/e2e/` the way these five map to a check — which is `architecture.md` §7's coverage-target clause
since Phase 4.

**▸ Phase 5 settles the fifth**, the one row Phase 3 left as *not started*, and `pnpm race` lists nine checks.
`phase-5.md` §9 tables what each of its six suites proves and cannot — the race test's three tests are the only
place `exhausted` is exercised at all, because the acceptance suite's budget keeps every test under every
code's `max_uses` by construction — and with row 5 the first mapping `architecture.md` §7 names is complete.

**Four of five settled and runnable by name** through Phase 4 — **▸ five of five since Phase 5**. The other two
recovery checks cover functional spec §2.1
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
  fixed in Phase 3's slice 7. **▸** Still none after Phase 4, which added a second mapping to wait beside the
  first — the five graded interactions to their specs under `apps/web/e2e/` — held in
  `phase-4-slice-7-acceptance.md` §8 until the file exists. **▸** Still none after Phase 5, which completed
  the first mapping (five scenarios, five checks, the ninth in `pnpm race`) and whose own 31-criterion
  coverage table is Slice 6's, `phase-5-slice-6-acceptance.md`, being written as this map was.
- **Two stale comments found by one slice and fixed by a later one.** The wire type's polling header still
  described the old stop-on-settled rule when slice 6 was written and now states the terminal/recoverable
  split; `supplier_requests.provider` was *written but not read* at the end of slice 2 and is read since slice
  3. Both are named because a comment describing code that is not there is the cheapest thing for a reviewer
  to find.
- **Out of scope by design:** the designed storefront (Phase 4) — **▸ closed in Phase 4**, the way Phase 3
  closed Phase 2's gaps above: five graded interactions, each with a RED of its own; the rest static as a
  tested property — fourteen tests assert that fourteen controls do nothing, and the assertion was shown able
  to see the one control that does; the join one line and three empty diffs; and Phase 1's throwaway catalogue
  page deleted rather than kept beside the new one (Appendix A, Q37–Q40). Promo codes (Phase 5) — **▸ closed
  in Phase 5**, the same way: the limit as one conditional `UPDATE` proven across four processes with three
  REDs, the price the shop's alone (`{ code }` the only input), and the shopper's form with six browser REDs
  (Appendix D). **What Phase 5 leaves open, carried forward without softening** (`phase-5.md` §11): **R6, the
  apply-vs-pay window** — the simulator reads `orders.amount_minor` without a lock and then delivers the
  webhook, so a code applied in the milliseconds between that read and `markPaid` is applied to a list-price
  payment; documented in `architecture.md` §9, the honest fix named (compare `payment_events.amount_minor` to
  `orders.amount_minor` under the order lock in the processor and route a mismatch to `payment_failed`), out
  of the phase's scope by the spec's own §3 (Q72); **the lock gap in the reviewer's copy** — `pnpm race promo`
  stayed `passed` with `FOR UPDATE` removed from the order lock, because it never sends two requests for one
  order; only the Vitest third test guards that case (Q71); and **two harness findings** — the
  e2e-cleanup-vs-continuation race (once, under a load of 14–30, the fixture's teardown deleted an order while
  the server's continuation was still running, and the continuation claimed a key after the order was gone; a
  harness ordering gap, not a product bug) and the `key-claim-race` load flake (5/7 under a load of 12–16,
  green alone at about 9; nothing in Phase 5 touched its path) (Q77). Public
  deployment (Phase 6); automatic scheduled retrying (R11, deliberately absent — Q28); and webhook signature
  verification, which the assignment waives.

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
| **▸** `phase-4.md` | The five interactions in one shape each — asked, built, the decision, the RED, the screenshot; static as the instruction and the fourteen inert tests; the join in one line and three empty diffs; the back/forward cache and its three `persisted: false`; two testing layers and seven harness findings; the artwork; fifteen assumptions (Q36–Q58) |
| **▸** `phase-4-slice-1-the-structure.md` | Page-local sections, not `widgets/`; inert by construction; placement does not scope CSS; the layout reversal and its change log; the fixture race (1 orphan → 0); the Figma cap; `orders = 55` (Q37–Q39, Q52, Q53, Q56) |
| **▸** `phase-4-slice-2-the-banner.md` | The reducer's timer instruction; the panel as the pause region; the three ways to get the cache wrong; the quiet half-failure (3 of 31, every one first → last); `install()` does not freeze time; the bfcache verdict and its greps (Q45, Q46, Q54, Q58) |
| **▸** `phase-4-slice-3-the-catalog-menu.md` | One classifying listener versus `stopPropagation`; inert inside as a property of the markup; clicking the search box is an outside click; the mispredicted RED (Q47, Q48) |
| **▸** `phase-4-slice-4-currency-and-hover.md` | The six things a JavaScript radio group rebuilds; reduced motion drops the transform and keeps the fade; R14 as a method and the settle-time trap's third appearance (`rgb(137, 137, 139)`); why inert controls still have hover states (Q44, Q49) |
| **▸** `phase-4-slice-5-real-cards-and-buying.md` | What did not change, enumerated; `image` dropped for three phases and resolved from any route; the eight-step sequence and the three wrong fixes; the SPA fallback's `200 text/html`; the third `persisted: false` (Q40–Q43, Q50, Q51) |
| **▸** `phase-4-slice-7-acceptance.md` | Three suites, three kinds of fact; one database, one runner at a time; why `pnpm test:e2e` is its own command; the 44-row coverage map (38 / 1 / 1 / 4 / 0); six inversions without touching `src/`; the acceptance walk's assertion that compares against `-1` (Q55–Q58) |
| **▸** `phase-5.md` | The two keystones — the race and its one-statement replacement, the price the shop's; the eight-step transaction; the three REDs (Shape A's nine and eleven and the `−6`, Shape B's seventeen `500`s, the lock RED's second stop); the reviewer's copy and the reset; the shopper's form, the one writer, the memo and the T4 finding; ten assumptions and the four alternatives; every RED line in one place (Q59–Q79) |
| **▸** `phase-5-slice-1-the-codes-and-the-counter.md` | Two columns that must agree and only one is the mechanism; the seed's third `ON CONFLICT` shape (`used_count` never named); the cleanup that decrements; seven negative schema proofs; the arithmetic's thirteen cases and why multiply-first (Q64, Q67–Q69) |
| **▸** `phase-5-slice-2-the-shop-decides-the-price.md` | The eight steps with every emitted statement; the sentinel's five costs; the `max: 1` self-deadlock and the three places its comment lives; the branded kopeck; the smoke test to `payment_events` (Q65–Q67) |
| **▸** `phase-5-slice-3-the-limit-holds-under-parallelism.md` | The race and its replacement, slowly; I6 beside I7; four processes and the waves; the shape before the counter; Shape A, Shape B and the lock RED with their output; the `−6`; the second stop; the reviewer's copy and the reset (Q59–Q64, Q70, Q71) |
| **▸** `phase-5-slice-4-the-shopper-enters-a-code.md` | One code from the field to the row; `required`, the `<form>`, `readOnly`; the one writer; the memo; `HttpError.body` and R11; the T4 finding; the operator's `required` (Q73–Q76) |

The nine invariants and the exact SQL for each: `context/product/architecture.md` §3, §3.1; the corrected
timeout ordering, §5. The multi-process rule: §7. The order-id affordance: §9. The Phase 3 risk register
(R2, R3, R7, R11, R12) and assumptions (A3, A9): `context/spec/003-failure-and-recovery/technical-considerations.md`
§11. Requirements: `context/spec/001-purchase-and-key-delivery/functional-spec.md`,
`context/spec/002-single-issuance-under-races/functional-spec.md`,
`context/spec/003-failure-and-recovery/functional-spec.md`. **▸** For Phase 4:
`context/spec/004-storefront-per-the-design/functional-spec.md` (§2.1–§2.10, §3, Change Log) and
`technical-considerations.md` (§3 R1–R20, §4, §5); the "no framework" decision, `architecture.md` §1; the
testing reversal, `architecture.md` §7 "Browser tests"; the assignment's storefront words,
`product-definition.md` §1.4, §2.1, §2.3, §3.2; the phase's line in `roadmap.md`. **▸** For Phase 5:
`context/spec/005-promo-codes-with-enforced-limits/functional-spec.md` (§1, §2.1–§2.7, §3) and
`technical-considerations.md` (§1's four decisions, §2.1–§2.5, §3 R1–R15, §4, §5); the I7 and I8 statements
and the three `_Amended in Phase 5_` markers, `architecture.md` §2 (core tables), §3, §3.1; §7's browser-test
rows with the Phase 5 counts beside Phase 4's; §9's two new bullets (the reset; R6); the assignment's four
codes, `packages/db/src/fixtures/promo-codes.ts`; the `(order_id)` key's boxed comment,
`packages/db/src/schema/promo.ts`; the phase's line in `roadmap.md`.

**On evidence:** every number in this document is quoted from the walkthrough named beside it. Nothing was
measured or re-run while writing it, and no source file was modified. **▸** The same holds for the
appendices: every Phase 4 number is `phase-4.md`'s or a slice walkthrough's, each of which records what it
re-ran. What was *read* from the tree for the appendices — not run — at about 13:30 on 14 September 2026:
`git status --short` shows no path under `apps/api/`, `packages/contracts/` or `packages/db/`, HEAD
`038f7d4`; `test(` declarations in the nine e2e files count 1 / 8 / 3 / 6 / 5 / 8 / 8 / 8 / 5, the
inert-controls 8 including one inside a loop over seven, which is the 58; `buy-through.spec.ts` asserts one
`POST /api/orders` after `dblclick` and one distinct id in `createdOrderIds`, its RED (`.toBe(2)` →
`Received: 1`) quoted in the file beside the assertion; there is no root `README.md`; and
`phase-4-slice-7-acceptance.md` appeared in the tree at 13:31 while this was being written, so the
appendices quote it too. **▸** The same holds for Appendices D–F: every Phase 5 number is `phase-5.md`'s,
with its section named, or a slice walkthrough's, each of which records what it re-ran. What was *read* from
the tree for them — not run — at about 21:55 on 14 September 2026: HEAD `4b5c18f`, `git status --short` 61
paths, 27 untracked (Phase 5 uncommitted, as `phase-5.md` §11 says); Phase 1's wording of I7 and I8,
`git show d6b9943:context/product/architecture.md` — the first commit of that file, 7 September — and the
same at `4b5c18f`, quoted in Appendix E; the `_Amended in Phase 5_` markers at three places in
`architecture.md`; `it(` / `test(` counts of 10 in `promo-codes.test.ts`, 7 in `promo.spec.ts` and 3 in
`promo-limit-race.test.ts` — the tenth and the T7 being the ones §11 records as Slice 6's; 14 test files
under `apps/api/test`, 6 under `apps/web/src`, 10 under `apps/web/e2e`; `race:promo` in `package.json`; and
no `phase-5-slice-6-acceptance.md` in the tree at that moment — it appeared at 21:58, while this was being
written, and unlike Phase 4's late arrival it is *not* quoted here: Slice 6's counts and runs are its own
report's, and every number in these appendices is `phase-5.md`'s or a Phase 5 slice walkthrough's.
`pnpm test`, `pnpm test:e2e`, `pnpm race` and `pnpm race promo` were not run for this map, no port was bound
and the database was not touched.

---

## Appendix A — Phase 4's questions

Numbered on from Q35. None of these is a question about the concurrency argument, which is why they are an
appendix and not a re-synthesis: the storefront sends the same request the plain page sent, and everything
§1–§6 says stands. Each answer is in the map's register — the code fact beside the plain reason — and ends
with the slice document that has the depth. Where two Phase 4 documents answer the same question
differently, the better answer is used and the other is named, marked **▸** as in §3. The roadmap's line
for the phase is the one this appendix exists to answer: *"which interactions were graded and why the rest
was deliberately left static."*

| # | The question | The one argument that answers it | Evidence |
|---|---|---|---|
| Q36 | Why no framework — and isn't five interactions where vanilla DOM starts to hurt? | Two of the five are a stylesheet, one is the browser's own control, two are a pure function and a three-line binding; one `setTimeout(`, one `click` listener, 0 `<a>`, 0 `<form>` on the page | `architecture.md` §1; `phase-4.md` §3 |
| Q37 | Why these five, and why is the rest static? | The assignment's words, and "static" is a tested property: fourteen tests assert fourteen controls do nothing | `phase-4.md` §0, §4; `phase-4-slice-1-…` §7 |
| Q38 | How do you know a "nothing happened" test can fail? | The identical function pointed at Купить failed on three lines | `phase-4-slice-1-…` §5; `phase-4-slice-7-…` §6 |
| Q39 | Why no `widgets/` layer? | Every block has one caller; the project lifts on the second | `phase-4-slice-1-…` §3.1 |
| Q40 | What changed on the purchase path? | Nothing — three empty diffs, one feature edit of **68 / 0**, `pnpm test` green after the browser had bought real keys | `phase-4-slice-5-…` §3.1; `phase-4.md` §5 |
| Q41 | Why is a double-click still one order from the new page? | Neither half of the guarantee lives in the card: `disabled` synchronously, and the key names the intent | `phase-4-slice-5-…` §3.3; `phase-4-slice-7-…` §5 |
| Q42 | You re-enable Купить after Back. Doesn't that let them buy twice? | Buy *again*, not twice: the key was forgotten on success, so a second press is a second decision | `phase-4-slice-5-…` §3.3 |
| Q43 | The API is down. What does the shopper see? | Everything but the goods, and the Phase 1 sentence in the row | `phase-4-slice-5-…` §6 |
| Q44 | No JavaScript on the currency toggle — isn't that cheating? | It is the interaction by its standard name; a handler rebuilds six things to reach "set one true" | `phase-4-slice-4-…` §3.1 |
| Q45 | Why does the reducer emit a timer instruction? | Five interlocking rules in five handlers is "every handler remembers to clear"; one word per event is a table of 25 | `phase-4-slice-2-…` §3.1 |
| Q46 | Why is the pause region the panel, not the banner? | Otherwise a mouse press on an arrow is `cancel`, and crit 6 is unobservable | `phase-4-slice-2-…` §3.2 |
| Q47 | Why one classifying listener and not `stopPropagation`? | Two listeners open and close in one task; `stopPropagation` is addressed upward, and two listeners live up there by contract | `phase-4-slice-3-…` §3.1 |
| Q48 | Why is "inert" a property of the markup? | A cancelling listener holds only as long as the listener does; a bare `<input>` has no default to lose | `phase-4-slice-3-…` §3.2; `phase-4-slice-1-…` §3.2 |
| Q49 | Reduced motion keeps the fade. Isn't a fade an animation? | Movement is what the setting is about; one `transform` on the page, one declaration in the block | `phase-4-slice-4-…` §3.2 |
| Q50 | Why `new URL(image, window.location.origin)`? | The two one-liners are each a bug on a different route | `phase-4-slice-5-…` §3.2 |
| Q51 | Why placeholders and not the mockup's art? | The mockup's art is a game the shop does not sell — the same rule that refuses the struck-through price | `phase-4-slice-5-…` §3.2 |
| Q52 | What did the Figma cap do to the artwork? | 19 of 29 files hand-authored; the brand tiles, the ones a reviewer recognises, are the real rasters | `phase-4-slice-1-…` §6.3 |
| Q53 | You changed the layout mid-slice. Where is that recorded? | A dated change-log entry, because the spec is read before the code | `phase-4-slice-1-…` §4 |
| Q54 | How do you test five seconds in 400 ms, and what does `install()` not do? | `page.clock`; `install()` keeps pace with the wall until paused — `Expected: 1 Received: 2` at 4 999 ms | `phase-4-slice-2-…` §4.2, §5.2 |
| Q55 | What does the browser layer prove, and what can it not? | State, silence, and a key arriving; not the cached restore, the fade as seen, or delivery correctness | `phase-4-slice-7-…` §3, §5; `phase-4.md` §7 |
| Q56 | Why do three suites share one database, and what did `orders = 55` teach? | The baseline is one global fact; the e2e hands it back; two runners at once break it | `phase-4-slice-1-…` §6.4; `phase-4-slice-7-…` §3 |
| Q57 | Why isn't `pnpm test:e2e` in `pnpm test`? | It needs a browser and starts two servers; a reviewer should not get a 276 MB download | `phase-4-slice-7-…` §3 |
| Q58 | What remains unproven? | The cached restore, either way; the fade as seen; one assertion that compares against `-1` | `phase-4.md` §6, §10; `phase-4-slice-7-…` §9 |

### Q36 — "Why no framework? Five interactions is where vanilla DOM starts to hurt."

The decision predates the storefront — `architecture.md` §1: *"React — deliberately declined; the assignment
prefers no heavy framework and there are five interactive elements"*, and `product-definition.md` §3.2 lists
*heavy frontend frameworks* among the non-goals, *"plain HTML/CSS/JS is the stated preference"* — and Phase 4
is where it stopped being a preference and became evidence. Of the five graded interactions, two are a
stylesheet (`:hover` / `:focus-visible` on the tiles, `:hover` / `:focus-within` on the cards), one is the
browser's own control with no script of its own (`grep -n 'addEventListener\|\.checked\|"change"\|querySelector'
ui/steam-topup.ts` — nothing, exit 1), and the two that need state hold it as a pure function each —
`reduceCarousel(state, event) → { state, timer }` over `{ index, count, isPaused }`, and
`reduceMenu(isOpen, event) → boolean` in sixteen lines — behind a three-line binding per event; across the
whole page there is **one `setTimeout(`** (`model/countdown.ts:77`), **one `click` listener** for the menu
(`ui/catalog-menu.ts:170`, none on the button), and **0 `<a>` and 0 `<form>`**. That is why five makes the
case stronger, not weaker: what a framework sells is keeping view and state in step across components that
share it, and this page has three pieces of view state, none touching an entity or the API, none derived from
the server — the only domain action, Купить, is Phase 1's delegated listener unchanged (Q40). A render loop
would be added to a page whose domain state lives entirely on the other side of `POST /api/orders` (§1,
layer 2), and "what is inert" would move from the markup into a component tree (Q48).

*`architecture.md` §1; `product-definition.md` §3.2; `phase-4.md` §3 (each "Built" paragraph), §4;
`phase-4-slice-1-the-structure.md` §3.1.*

### Q37 — "Why these five interactions, and why is everything else static? That looks like the shortcut."

**▸ `phase-4-slice-1-…` §7 and `phase-4.md` §4 give the same answer; `phase-4.md`'s is used because it adds
the feedback-versus-result line from Slice 4.** The five are the assignment's own list, transcribed in
`product-definition.md` §2.3 — banner (auto-advance and arrows, active dots), catalog menu (open on click,
close on a second click or a click outside; *"menu accuracy is explicitly not graded"*), the $/₸/₽ control
(*"changes active state only — no amount recalculation"*), tile hover, card hover — with the storefront ranked
sixth of eight by grading weight in §2.1 and *"structural fidelity to the mockup with all five required
interactions working"* a supporting metric in §1.4. Static is the instruction and not the shortcut because
each inert control, wired, would invent something the shop does not have: a search that searches nothing
known, an «Оплатить» for a Steam top-up the shop does not sell, a conversion with no exchange rate, per-category
menu columns nobody wrote — and a *half*-wired control (a spinner, a "coming soon") is worse than an inert one
because it promises; the line functional spec §2.8 draws is between *feedback*, which every inert control has
(`cursor: pointer`, a 120 ms hover shade), and *result*, which none may imply. And "static" is a tested
property rather than a description of what was skipped: one function, `assertInert`, and **fourteen** callers
assert six absences after each press — no document request, no `POST /api/orders`, URL unchanged, no page
error, no `[aria-busy="true"]`, no new sentence matching `/скоро|coming soon|загруз/iu` — and the assertion was
shown able to see a control that acts (Q38).

*`phase-4.md` §0, §4; `phase-4-slice-1-the-structure.md` §3.2, §5, §7; `phase-4-slice-4-…` §6.*

### Q38 — "How do you know the 'nothing happened' tests can fail?"

Because "nothing happened" is the assertion most likely to pass vacuously — a listener armed after the click,
a filter that matches nothing, and every row is green forever — so the RED was not write-first. The identical
`assertInert`, unmodified, was pointed at the one control on the page that does something, the first
«Купить», and failed on three lines: `a document (navigation) request was issued: …/order/ord_01M2DT7ZJNG6QT805ZYPV30HNZ`,
`a POST /api/orders request was issued`, `the URL changed from http://localhost:5101/`. The layout spec's two
most vacuous-looking assertions were inverted the same way — `toBeGreaterThan(0)` on the `<a>` / `<form>`
count gave `Received: 0`, and `scrollWidth > clientWidth` at 1 000 wide gave `Received: 1000` — and Slice 7
added six more inversions, none touching `apps/web/src` (the menu-closed step of the acceptance walk as
`.toBe(false)` → `Expected: false / Received: true`; one order id as `.toBe(2)` → `Received: 1`). This is
layer 4's Phase 4 instance: the discipline is the same as the race REDs' — prove the check could ever have
been red — with the method changed from *weaken the mechanism* to *invert the assertion*, because on a page
there is no `src/` mechanism to weaken without changing what the shopper sees.

*`phase-4-slice-1-the-structure.md` §5; `phase-4-slice-7-acceptance.md` §2 ("Inversion"), §6; `phase-4.md`
§4.*

### Q39 — "Why no `widgets/` layer? Isn't that what FSD says a header is?"

Every block on this page has one caller and, by the spec's scope, cannot gain a second this phase — the
order page and the operator's screen are left alone — and the project lifts code only on a second caller
(`format-price.ts` and `poll.ts` say so; `architecture.md` names five layers). So the six sections are
page-local under `pages/storefront/ui/`, and the carousel, menu and currency control are page *state* in
`pages/storefront/model/`, not features, by the same discipline: a feature here is one thing a shopper does
*with a domain effect*, and none of the three touches an entity or the API — the one control that does,
Купить, *is* a feature, and the page calls it in one line (Q40). Six single-use slices with six public APIs
would be ceremony with nothing to guard; if the header ever has a second page it moves to `widgets/` then,
unchanged — "lift on the second caller" is a rule about *when*, not *whether*.

*`phase-4-slice-1-the-structure.md` §3.1, §7; `phase-4.md` §9 (the first "+" row).*

### Q40 — "What did you have to change on the purchase path to make the design work? Prove it."

Nothing, and the proof is three empty diffs and one green run. `git status` shows no path under `apps/api`,
`packages/contracts` or `packages/db` for the whole phase — nor under `pages/order`,
`features/simulate-payment`, `lib/purchase-intent.ts` or `apps/api/test/**` — and the feature's diff is
**68 insertions, 0 deletions, one file** (`git diff --numstat HEAD -- apps/web/src/features/buy-product/`),
56 of them comment and 12 code, all of them the `pageshow` handler of Q42. The page's whole involvement is one
line, `enableBuyControls(region)` in `ui/popular-products.ts`, handed the region rather than the buttons
because the buttons arrive with the catalogue; the new card keeps the contract the delegated listener matches
— `<button class="product-card__buy" type="button" data-sku="…">Купить</button>`, the only `data-sku` button
in the card, directly inside `__body` — and from the click on it is `buy()` as Phases 1–3 left it. Then
`pnpm test` — the API suites that prove one intent is one order and one payment one key, **11 files / 90
tests** — ran green immediately after the browser suite had bought real orders and real keys through the new
page (**▸** *three orders and one key* per run at Slice 5's verify, as `phase-4.md` §7 says; *four and two*
once Slice 7's acceptance walk landed, as `phase-4-slice-7-…` §1 says — the later count is current). The
rejected alternatives — a click handler of the storefront's own, or creating the order from the order page
with the SKU in the URL — each put a second place in the code that decides what an `Idempotency-Key` names,
and each would make Phases 1–3's suites the proof of a path no shopper uses.

*`phase-4-slice-5-real-cards-and-buying.md` §3.1, §6; `phase-4.md` §1, §5.*

### Q41 — "Why is a double-click still one order from the new page? You rebuilt the card."

Because neither half of the guarantee lives in the card, and both were Phase 2's. First,
`button.disabled = true` runs synchronously in the first click's handler, so the second click of a double-click
lands on a disabled element and dispatches no event — the e2e counts **one** `POST /api/orders` after
`dblclick`. Second, if a second request did get out — two tabs, a reload mid-flight — it would carry the *same*
`Idempotency-Key`, because the key names the intent to buy this SKU and is read from `localStorage` rather
than minted per click, and the unique index on `orders.client_request_id` would hand back the same order (Q4).
The page provides the first, the database the second, and the storefront added neither and removed neither;
Slice 7 then asserted the criterion in its own words — one distinct id in `createdOrderIds` beside the one
`POST`, RED `.toBe(2)` → `Received: 1` — which is one step closer to the `orders` table than a request count
and one step short of the `count(*)` Q4 asks for.

*`phase-4-slice-5-real-cards-and-buying.md` §3.1, §6; `phase-4-slice-7-acceptance.md` §5 ("asserted from
ids, not rows"); `phase-4.md` §5.*

### Q42 — "You re-enable Купить after the shopper comes back. Doesn't that let them buy twice?"

**▸ `phase-4-slice-5-…` §6 and `phase-4.md` §5 agree; the slice's one-sentence form is the one to say
first.** It lets them buy *again*, which is different, and it is the spec's own requirement — spec 002 §2.1's
fifth criterion, *buy, come back, buy again*, reached by the back button instead of the shop's link. `buy()`
leaves the button disabled while `location.assign` runs, on purpose, because a live button during the
navigation would be a second copy from an impatient click; the back/forward cache preserves that `disabled`
past its meaning, so a shopper who bought, read the order and pressed Back would meet a control that does
nothing — the "broken control" the storefront must never show. On a persisted `pageshow` the feature clears
`disabled` on its own `button[data-sku]:disabled`, and a second press then creates a *second* order, which is
correct only *because* `forgetPurchaseIntent(sku)` already ran on success before the navigation (the drive
saw `intentKeysRemainingInStorage: []` on the order page): the re-enable and the forgotten key are one design,
and the feature's header states them together. The three fixes that look simpler each break one half — never
disabling (two requests per double-click), re-enabling before the navigation (a second copy from the same
decision), keeping the old key (the second press returns the *first* order, and the shop can sell each game
once, forever — Q4's content-hash failure reached by the back button).

*`phase-4-slice-5-real-cards-and-buying.md` §3.3, §6; `phase-4.md` §5 (the eight steps), §6.*

### Q43 — "The API is down. What does the shopper see?"

Everything but the goods. `createPopularProducts` returns its section synchronously with «Загрузка
каталога…» in the region, `storefront-page.ts` never awaits it, and `loadInto` paints the loading, empty and
error states into that one `region` element and nowhere else — so the header, banner, tiles and Steam block
are on the page and answering the pointer whether the catalogue takes a second or never arrives. The drive
killed the API process and watched the banner keep advancing and Каталог keep opening while the row showed
Phase 1's sentence verbatim — «Не удалось загрузить каталог. Проверьте соединение и обновите страницу.» — and
the e2e reproduces it with a `503` route: four blocks visible, zero cards, the exact sentence, slide 2 after
`runFor(5000)`, the overlay opening. Every failure — unreachable, non-2xx, a body that is not the promised
array — lands in the same `catch` and the same sentence, because to a shopper they are one event.

*`phase-4-slice-5-real-cards-and-buying.md` §6; `phase-4.md` §5 ("What was driven").*

### Q44 — "There is no JavaScript on the currency toggle. Isn't that cheating on a graded interaction?"

It is the interaction, done by the mechanism that defines it. §2.4's contract — *exactly one active; clicking
another makes it active; clicking the active one changes nothing; nothing else changes* — is the definition
of a radio group, so the markup is three `<input type="radio" name="currency">` inside
`<fieldset role="radiogroup" aria-label="Валюта">`, each followed by the `<label for>` the shopper sees, the
radio hidden by the clip recipe rather than `display: none`, and the stylesheet paints
`.currency__input:checked + .currency__option`. A JavaScript version has to rebuild six things to arrive at a
handler whose logic is "set this one true, the others false" — exactly one active (two copies of one bit),
one Tab stop for the group (a roving `tabindex`), arrow keys wrapping both ways and moving focus with state,
`aria-checked` (a third copy), entering the group on the checked one from either side (Shift+Tab is the one
that gets missed), and `:checked` for the stylesheet — and every one is a thing hand-rolled versions get
wrong; the tech spec surfaces this as assumption 4 so a reviewer expecting a handler reads the reason instead.
On "cheating": the assignment grades that the control *changes active state*, and it does — by click, by
ArrowRight, with a visible active square and a `:focus-visible` ring that a mouse click correctly does not
draw — while recalculation is waived in the assignment's own words, and a control that pretended to convert
would be inventing prices, which the product definition forbids for the same reason it forbids the
struck-through old price; «Сумма / 500 ₽» is a `<span>` that reads `500 ₽` before and after every click.

*`phase-4-slice-4-currency-and-hover.md` §3.1, §4, §5.2, §6; `phase-4.md` §3.3, §9 (assumption 4).*

### Q45 — "Why does a reducer decide what happens to the timer? The handlers know what they did."

That is the problem — each knows what *it* did and has to guess what the others did. The rules interlock: a
tick advances *and* re-arms; an arrow advances *and* re-arms *unless* the pointer is on the panel, in which
case it advances and leaves the timer off; enter stops without moving; leave starts without moving — and put
in five handlers, "never more than one pending timeout" becomes every handler remembering to clear before it
sets, with a failure (two timeouts counting, the banner jumping twice within a second of a press) that looks
fine on the first press (R2). So `reduceCarousel` returns the next state *and one word* — `restart`, `cancel`
or `keep` — and the invariant becomes three facts about three files: one instruction per event; one slot in
`countdown.ts` that clears before it sets; one place, `applyTimer`, where a word becomes a call, with
`assertNever` on the `default` so a fourth word cannot be added without the compiler pointing at the switch.
The word is a word and not a number so the reducer never sees milliseconds — `AUTO_ADVANCE_MS = 5000` is
written once, at `banner.ts:102` — and the policy is checked as a table, **25 cases in about four
milliseconds**, no browser, no clock; the REDs say which line each test guards: `wrapIndex` without its
`+ count` → **3 failed, every one first → last** (`-1 % 4` is `-1`; `4 % 4` was always `0`, so the left arrow
from slide 1 is the one gesture a manual check never makes); the countdown without its `clearTimeout` →
`expected "vi.fn()" to be called 1 times, but got 2 times`, which is the test an interval could never pass.

*`phase-4-slice-2-the-banner.md` §3.1, §4.1, §5.1, §6; `phase-4.md` §3.1.*

### Q46 — "Why is the pause region the panel and not the whole banner? The spec says 'over the banner'."

Because crit 6 has to be *observable*. A manual move restarts the count "from that moment" — but a mouse
press on an arrow happens with the pointer *on the arrow*, and if the arrow were inside the pause region the
carousel would be paused at that instant, the reducer would answer `cancel` instead of `restart`, and the
count would never visibly start: every mouse user would find the banner stopped after every press. So the
region is `.banner__panel`, the dark rectangle, and the arrow cluster and the dots are its *siblings*,
positioned over its corner by the stylesheet — moving from the panel to the arrow *is* leaving the region,
and the press is a `next` with the flag clear. The same reasoning is why there is no pause on `focusin`,
whatever the APG pattern says: a mouse click focuses the button it pressed, so pausing on focus is the same
failure by another route; the stated cost is that a keyboard user on the arrows gets no pause. Tested both
ways — hover the next arrow and run the clock 6 000 ms → slide 2; and on the wall, 6 036 ms with the pointer
resting on the arrow → advanced — and recorded as assumption 3.

*`phase-4-slice-2-the-banner.md` §3.2, §6; `phase-4.md` §3.1, §9 (assumption 3).*

### Q47 — "Why one classifying listener on `document`, and not `stopPropagation` in the button handler? Everyone does."

Because the opening click and the outside check have to be one decision. Walk the obvious two-listener
version: the shopper clicks «Каталог»; the event bubbles span → button → header → … → `document`; the button's
listener opens; the event keeps going and the closer on `document` sees an open menu and a click and closes
it — same task, no paint between, the menu never opens (R3), and that is not a race but the order events are
defined to arrive in. `stopPropagation()` in the button's handler is not addressed to the closer; it hides the
event from everything above, and this page has two listeners whose contract is to be above and see everything
— `enableBuyControls`, delegated on the product row for buttons that arrive with the catalogue, and the
menu's own, which needs the Купить click to reach `document` because *that click is the outside click that
closes the overlay* before `location.assign`; the other patch, a closer registered on `setTimeout(0)` from
inside the opener, is a bet that bubbling finishes before a timer fires. With one listener every click
arrives once and is classified once — `catalogButton.contains(target)` → `Toggle`,
`overlay.contains(target)` → `InsideClick`, otherwise `OutsideClick` — so the opening click *cannot* also be an
outside click, not because a flag was set but because nothing gets to look at it twice;
`addEventListener("click"` is on exactly one line of the file (170 today, 165 when Slice 3 wrote) and there is
no `stopPropagation` anywhere in `apps/web/src`. The mutation REDs: `InsideClick` returning `false` → **1
failed** (the brief predicted two, and the closed case cannot see that mutant because it expects `false` — a
mutation proves only the tests that can see it); `InsideClick` treated as a `Toggle` → **2 failed**.

*`phase-4-slice-3-the-catalog-menu.md` §3.1, §5.2, §6; `phase-4.md` §3.2.*

### Q48 — "Why is 'inert' a property of the markup rather than a handler that cancels?"

Because a listener whose only job is to cancel a default is a control pretending to be wired, and it holds
exactly as long as the listener does: lose it — a rebuilt header, a handler bound before the element exists,
an exception earlier in the same handler — and the browser does what forms do, navigating to `/?q=…`, a full
load, the banner back on slide 1, the shopper's text in the address bar. With no `<form>` there is no default
action to lose; Enter in a bare `<input type="search">` is a keystroke, «Оплатить» is a
`<button type="button">` with no handler, the chips are buttons with «Донат» carrying a class and no
`aria-pressed`, and across the page **0 `<a>` and 0 `<form>`**, asserted in a browser
(`document.querySelectorAll("a, form").length === 0`). The same fact makes the menu's inner clicks inert before
any listener exists — categories are `<button type="button">` with no listener, entries are `<li>` text, the
grep for `createElement("a"` over the storefront returns nothing — and it is written down a second time as the
branch `InsideClick → return isOpen`, which a type checker keeps total and a unit test keeps true; the browser
layer is the third: a category and an `<li>` clicked with `request` and `pageerror` armed, overlay still open,
URL unchanged, and two screenshots either side of the click byte-identical (`cabdb9d0…`).

*`phase-4-slice-3-the-catalog-menu.md` §3.2, §6; `phase-4-slice-1-the-structure.md` §3.2, §7; `phase-4.md`
§4.*

### Q49 — "Reduced motion keeps the fade. Isn't a fade an animation?"

It is a transition, and it is not motion. `prefers-reduced-motion` is a request about *movement* — position
or size changing across frames — because that is what makes some people ill; a colour going from
transparent to grey, or a shadow deepening, moves nothing, and the usual guidance is to replace a movement
with a fade, not to remove fades. So the last block in the sheet withdraws the one thing on the page that
moves on hover, the card's `translateY(-4px)`, and nothing else — `transform: none` on the lift's two
selectors, `transition` untouched, so the lifted shadow still fades in over 180 ms — and the criteria still
hold because §2.6 crit 2 accepts "a raised shadow" as one of its own three answers. The boilerplate
alternative, `* { transition: none !important }`, is a `*` rule R4 forbids (the sheet is in the bundle on
`/order/:id` and `/admin/recovery`) and would make the tiles switch on instantly for exactly the reviewer R11
worries about; doing nothing goes wrong the other way, ignoring a request the shopper made. Last in the file
because a media query adds no specificity and source order decides the tie — the cascade lesson Slice 1
learned the hard way, applied.

*`phase-4-slice-4-currency-and-hover.md` §3.2, §6; `phase-4.md` §3.5.*

### Q50 — "Why `new URL(image, window.location.origin)` and not a template string?"

Because the two one-liners that look equivalent are each a bug on a route the other is right on.
`` `/${image}` `` is right today and turns a future `/assets/cs2.png` into `//assets/cs2.png` — a
protocol-relative URL to a host named `assets`, every card blank at once with `ERR_NAME_NOT_RESOLVED`. A plain
relative `src` is right on `/` and becomes `/order/assets/cs2.png` on the order route — a 404 that arrives
with the first reuse of the entity on another page. Resolving against the *origin* — scheme, host, port, no
path — ignores where the page is and survives a leading slash, and it is done in the card and not the parser
so the parser stays a pure statement about the wire that runs under Vitest's `node` environment with no
`window` to fake; that parser's own RED was the one-line shortcut `row["image"] ?? null`, which lets `42`
through to `new URL(42, origin)`, a valid `http://host/42`, where `readNullableString` rejects it and a
*missing* key too.

*`phase-4-slice-5-real-cards-and-buying.md` §3.2, §6; `phase-4.md` §8.*

### Q51 — "Why placeholders and not the mockup's own card art?"

Because the mockup's art is stock imagery for a game the catalogue does not sell, and putting it on a «CS2
Prime Status» card would mislead a shopper about what they are buying — the same product rule that refuses
the mockup's struck-through old price and «5 %» badge on cards (*the shop invents no discounts*). The
placeholders say only what the row is: ten SVG sources (694–743 B) — brand word, Russian product name, a flat
colour keyed by SKU prefix, text and nothing else — rendered to PNG through the same Chromium the e2e installs,
because the text is Cyrillic plus «₽» and ImageMagick would need a pinned font; committed as PNG (**8 453–14
434 B, 102 011 B together**) because `system-ui` renders differently per OS and a reviewer installs nothing.
They live at the seed's ten `assets/*.png` paths so `packages/db` stays untouched — the seed is the brief's
fixture, verbatim and diffable — and the agreement between the script's ten basenames and the seed's ten
`image` values is by convention, guarded since Slice 7 by an `image/*` content-type assertion on every
`/assets/` response and a no-`--empty`-on-this-seed assertion, because the dev server's SPA fallback answers a
*missing* PNG with `200 text/html` and a deleted file would otherwise have passed the whole suite.

*`phase-4-slice-5-real-cards-and-buying.md` §3.2, §5.1, §5.3, §6; `phase-4.md` §8; `phase-4-slice-7-…` §5.*

### Q52 — "What did the Figma cap do to the artwork?"

The nine brand tiles got out — `download_assets` on the strip node returned 14 PNGs at 240–1920 px, 3 MB
raw, downscaled with `magick` to **144 × 144** (2× of the 72-px tile), the raw exports never committed — and
then the Figma MCP hit the Starter plan's tool-call cap mid-task. `tiktok.svg`, `more.svg` and all **17** UI
glyphs under `icons/ui/` are hand-authored, drawn to the mockup's shapes rather than exported from them; the
favicon was always going to be generated (the file has none) and the banner is a CSS gradient (the file's
banner is one black image). So **19 of the 29** Slice 1 asset files are hand-authored — 29 files, 228 KB,
none over 31 KB, 89 of 89 requests `200` on the landing — and what that means for fidelity is stated rather
than hidden: the glyphs are approximations the assignment waives, and the brand tiles, the things a reviewer
recognises at a glance, are the real rasters. Delivery follows the split — tiles as `<img alt="">` with the
caption as visible text; glyphs as `<span class="icon icon--<name>" aria-hidden="true">` painted through CSS
`mask-image`, because `createElement` cannot build SVG-namespace nodes and `innerHTML` is banned, with
`icon.ts`'s `glyphNames` list closed so a name not in `public/icons/ui/` is a type error rather than an empty
box.

*`phase-4-slice-1-the-structure.md` §6.3; `phase-4.md` §8.*

### Q53 — "You changed the layout in the middle of the slice. Where is that recorded?"

The spec said a fixed 1 200-px column with a horizontal scrollbar under 1 280, and the task text quotes
`min-width: 1240px`; the user reversed it while the sheet was being written — full width, column capped at
1 280 px and centred, rows wrapping below. The sheet was built to the reversal (no `min-width`,
`max-width: 1280px; margin: 0 auto`, `flex-wrap`, `auto-fill` cards) and measured at 1 000 × 800: tiles wrap
**8 + 3**, **0** elements past the right edge; at 1 280, `|leftGap − rightGap| ≤ 1`; and the inverted layout
assertion, `scrollWidth > clientWidth`, gave `Received: 1000` — which the pre-reversal spec would have passed.
Why a change log and not an edit: the spec is the document a reviewer reads *before* the code, so the
functional spec carries a dated entry (2026-09-13) naming the task and the decision, the tech spec's §2.6 is
amended in place, and the tests follow the amendment — a silent edit would have left the task, the spec and
the sheet disagreeing three ways with no record of who decided. Still open, and said so: `tasks.md`'s Slice 1
task 2 quotes the pre-reversal instruction.

*`phase-4-slice-1-the-structure.md` §4, §7; `phase-4.md` §9 (assumption 13), §10.*

### Q54 — "How do you test a 5-second policy in 400 milliseconds, and what does `install()` not do?"

`page.clock` replaces the page's `Date` and `setTimeout` with a clock the test moves — `runFor(4999)`, assert
still slide 1; `runFor(1)`, assert slide 2 — so the banner spec drives ≈55–60 s of virtual time in ≈3.5–3.8 s
on the wall, and "state changed" assertions are proven able to fail by pushing them past their boundary (crit
6 with `runFor(5000)` while keeping "still 2" → `Expected: 2 Received: 3`; crit 7 asserting "advanced" while
still hovering → `Expected: 2 Received: 1`). What `install()` does not do is stop time: a bare
`page.clock.install()` keeps pace with the wall until paused, so the milliseconds `goto` and the catalogue
fetch spent were already inside the first 5-second window and the 4 999 ms boundary reported **`Expected: 1
Received: 2`** — slide 2 already showing one millisecond short — while `pauseAt(Date.now())` after navigation
threw `Cannot fast-forward to the past`. The rule every clock-driven spec now copies is
`install({ time: FIXED_START })` then `pauseAt(FIXED_START + 100)` *before* `goto`; and the spec that watches
the order page's delivery poll must *not* install the clock at all, or the poll freezes and the key never
arrives (R15). One real-time observation sits beside the faked clock so the suite is not the only witness —
dot 1 → 2 inside a **5 207 ms** window, waited *inside* `page.evaluate`, because a `page.waitForTimeout` in
the MCP relay let the renderer go unscheduled and a real timer never fired.

*`phase-4-slice-2-the-banner.md` §4.2, §4.3, §5.2, §5.3, §6; `phase-4.md` §7 (the findings table).*

### Q55 — "What does the browser layer prove, and what can it not?"

**▸ `phase-4.md` §7 lists what the e2e cannot prove as of Slice 5; `phase-4-slice-7-…` §5 lists it after
Slice 7 closed two of those items and named two more — use Slice 7's.** It proves the five interactions *as
state* (`hidden` on a slide, `aria-current` on a dot, `aria-expanded` on Каталог, `:checked` on a radio, a
`transform` matrix after the transition has finished), the fourteen inert controls *as silence*, five real
cards from the live endpoint with Купить on exactly the three purchasable, the buy-through to a key on the
real clock, one `POST` after `dblclick`, and Back as a reload with the overlay hidden and the dot advancing —
**58 tests in 9 files in 45.5 s**, one Chromium, `workers: 1`, `retries: 0` because *a test that passes on the
second try is a false statement, not a pass*. It cannot prove five things, each with a measurement or a
reason behind it: the **cached restore** — three attempts, three framings, every one `persisted: false` with
`notRestoredReasons: [{ reason: "masked" }]`, because a page with a debugging session attached is not eligible
for the back/forward cache and every automated page has one; the **fade as seen** — a computed style mid-fade
is an interpolated value (`rgb(137, 137, 139)`, a grey no rule names), so the suite reads `transition-duration`
statically and end states after a settle, never a frame, and "visibly" was judged by a person on three
screenshots; **delivery correctness** — the browser watches one key arrive and has no way to count what left
stock, so one-intent-one-order and one-payment-one-key stay the API suites' proof (11 files / 90 tests, four
processes, stock accounting), which is the layer-4 lesson of Q23 and Q33 in a browser's clothes; **any browser
but Chromium**; and **the mockup's wording**, a comparison with a Figma frame that a test does not make.

*`phase-4-slice-7-acceptance.md` §3, §5; `phase-4.md` §6, §7; `phase-4-slice-4-…` §4 (R14).*

### Q56 — "Why do three suites share one database, and what did `orders = 55` teach?"

Because the API suites' baseline assertion — `orders = 0` and `unclaimed = 50` before a file touches the pool
— is the mechanism behind every concurrency proof in Phases 1–3, and it is a statement about one global fact
in one database; the e2e is the first suite that presses Купить for real, so it either hands that fact back
or breaks every suite after it. It hands it back: every order id is captured host-side by `page.route` +
`route.fetch()` + `route.fulfill()` *before* the page sees the response it navigates on — the first fixture
used `page.on("response")` with a fire-and-forget `response.json()` and lost the race to `location.assign`
on the very next line of `buy()`, **1 orphan order** per buy-through, **0** with the fix — and `afterEach`
runs the same six statements as the API harness's `cleanupTestOrders`, quoted beside the call; the proof is the
order of operations, `pnpm test:e2e` then **`pnpm test` immediately after → 11 / 90 + 5 / 56, all green,
baseline `orders=0 … unclaimed=50`**, held even through the RED run that created two extra orders on purpose
(R13). What `orders = 55, expected 0` taught is that the rule is a discipline, not a structure: a `pnpm test`
started while another agent's run was in flight failed its own precondition, run alone it was green, and the
same fact appeared from the other side when two agents shared one Playwright browser and closed each other's
page mid-drive — a shared resource with global state cannot be driven by two actors at once, and "flaky" is
usually a second actor. `workers: 1` inside the project and never two runners at once; a database per run
would make it structural, and nobody built it.

*`phase-4-slice-1-the-structure.md` §6.2, §6.4; `phase-4-slice-7-acceptance.md` §3; `phase-4.md` §7 (R13
and the findings table).*

### Q57 — "Why isn't `pnpm test:e2e` part of `pnpm test`?"

It needs a browser and it starts two servers. A reviewer who runs `pnpm test` expecting the API suites should
not be handed a Chromium download — revision **1243**, about **276 MB**, larger than the spec's "~150 MB"
estimate, and a reviewer should know that before running the install — or a port collision; so `pnpm test`
is API then web unit, nothing in it needing more than Postgres, and `pnpm test:e2e` is its own command that
builds the API first (so the code under test is the code that runs) and hands Playwright a config that owns
**5101 (Vite) / 5102 (API)** with `--strictPort` and `reuseExistingServer: false`, failing loudly on a stray
process rather than testing against whatever was there. That row exists because three phases produced three
near-collisions, the last during this phase's own tech spec: a proposed 4301 was already
`single-issuance-under-races.test.ts`'s. Two preflight checks name what a bare run is missing — no
`DATABASE_URL` prints "run pnpm test:e2e from the repository root"; no browser prints
`pnpm exec playwright install chromium` — and `pnpm race` is unchanged at eight checks and needs only
Postgres.

*`phase-4-slice-7-acceptance.md` §3, "Interview questions"; `phase-4.md` §7 ("Ports"); `phase-4.md` §9
(assumption 10).*

### Q58 — "What is still unproven?"

**▸ `phase-4-slice-5-…` §6 names two things; `phase-4-slice-7-…` §9 closes the second and adds three — use
Slice 7's list.** First and largest: **the cached-restore path is not proven, either way.** Three automated
attempts, three `persisted: false` / `masked`; no code-level blocker (no `unload` listener, no open socket,
`no-cache` rather than `no-store`); the three `pageshow` handlers — restart the countdown through the reducer,
force the menu closed, re-enable Купить — exercised only by synthetic events dispatched from script, which
proves they do the right thing *when the event arrives*, not that Chrome delivers it; the one-minute check in
a real Chrome (`vite preview`; DevTools → Application → Back/forward cache → Test; buy; Back; the dot advances
within 5 s and a second press creates a second order) has been asked of the user, and `phase-4.md` §6 carries
a placeholder rather than a verdict. Second, the fade *as seen* is asserted by nobody, by design (Q55). Third,
and found by reading the suite: the acceptance walk's last assertion — "the banner is running again after
Back" — reads its "before" value while the page is still on `/order/…`, where no dot exists, so it compares
the fresh page's dot 0 with `-1` and passes whether or not the timer runs; §2.7 crit 4's row rests on
`buy-through.spec.ts` alone, which reads after `toHaveURL("/")` and is right. Smaller and named: "one order
exists" is asserted from captured ids, one step short of `count(*)`; the `@game-shop/db/testing` lift now that
a second caller exists; a database per run; and still no root `README.md`. Slice 5's other item — a missing
picture answered `200 text/html` by the dev server — is closed by Slice 7's two assertions (Q51).

*`phase-4.md` §6, §10; `phase-4-slice-7-acceptance.md` §5, §9; `phase-4-slice-2-…` §5.4;
`phase-4-slice-5-…` §5.4, §6.*

---

## Appendix B — which earlier answers Phase 4 touches

Phase 4 rewrites none of them. Each row is a sentence in the body that gained a clause, an instance or a
runnable form, with the reason; the in-place ▸ edits in §1–§5 and §8 are the ones marked *edited*, the rest
are touched here only.

| Where | The sentence that changed or gained a clause | Why |
|---|---|---|
| `architecture.md` §1 — *"React — deliberately declined; the assignment prefers no heavy framework and there are five interactive elements"* | Written as a prediction; now has evidence. Five interactions in vanilla DOM: two a stylesheet, one the browser's radio group with no script, two a pure reducer and a three-line binding; **0 `<a>` / 0 `<form>`**, **one `setTimeout(`** (`countdown.ts:77`), **one `click` listener** for the menu (`catalog-menu.ts:170`), zero `stopPropagation` in `apps/web/src` | The argument for a framework is shared view state across components; this page has three pieces of view state, none shared, none from the server (Q36) |
| `architecture.md` §7 — *"no browser tests"*, since Phase 1, with a trigger named | **Reversed on its own trigger.** The trigger was *a conditional in the rendering path that derives a fact rather than mirroring one*; Phase 4 met it four times — wrap arithmetic, a timer policy, a menu state rule, a five-from-N selection — and the answer was two layers, not one. What was measured on the way to the rule: `orders = 55, expected 0` when two runners shared the database; **1 orphan** order from `page.on("response")` → **0** with `page.route`; a bare `install()` not freezing time (`Expected: 1 Received: 2` at 4 999 ms) | The gap did not vanish; it changed shape: *no browser test can reach the cached restore* — three `persisted: false` / `masked` — and the fade as seen and delivery correctness stay with a person's eye and the API suites (Q55, Q58) |
| §1, layer 2 — *"The server owns the state; the page reports it"* (*edited*) | Gains a clause: the page now owns *view* state — slide, menu, checked currency — and still no *domain* state; the card is a reader and Купить the same delegated control | The five interactions have no domain effect, which is also why they are page `model/`, not `features/` (Q39) |
| §1, layer 4 — *"Nothing is believed until it has been seen to fail"* (*edited*) | Gains a browser instance with a RED method of its own: *inversion* — point the identical "nothing happened" assertion at Купить (three lines), push every "state changed" assertion past its boundary, change nothing in `src/` | Weakening a page mechanism changes what the shopper sees; inverting the assertion proves the check reads the real page without doing so (Q38) |
| Q4 — *"this criterion can only be verified by a real double-click in a real browser with the resulting order count read out of the database"* | Phase 4 is the first phase with a real browser, and it does the double-click: `buy-through.spec.ts` — `dblclick` → **one** `POST /api/orders`, one distinct id in `createdOrderIds`, RED `.toBe(2)` → `Received: 1`. The count is of ids captured off `2xx` bodies, one step short of `count(*)` from `orders` | Q4's sentence stands, with a runnable form beside the scripted `pnpm race create-order` (Q41) |
| Q17 — *"What can a reviewer run?"* (*edited*) | Two more commands: `pnpm test:web` (5 / 56, chained into `pnpm test`) and `pnpm test:e2e` (58 / 9 in 45.5 s, deliberately not chained) | Neither is redundant with the other or with `pnpm race`; each suite is blind to the other two's subject (Q55–Q57) |
| Q32 — *"no test in the repository has a tab"* (*edited*) | Now one does — and it still does not cover spec 003 §2.6's third criterion: the buy-through watches a delivery on the real clock (it must not install `page.clock`, R15), not a recovery sent from a second context | The claim Q32 makes about *that* criterion is unchanged; only the literal sentence was false |
| Q34 / §5 "What is not finished" — *"Out of scope by design: the designed storefront (Phase 4)"* (*edited*) | Marked closed the way Phase 3 closed Phase 2's gaps: five interactions with a RED each, the rest static as a tested property, the join in one line and three empty diffs, Phase 1's catalogue page deleted | The pairing of a deferral with its closure is the answer to "how do you decide what to defer?" |
| §5 — *"Four of five settled and runnable by name"* (*edited*) | Unchanged in substance, said explicitly: Phase 4 settles no scenario; `phase-4-slice-7-…` §8 re-scores the table identically and adds a second one — the five graded interactions to their specs | `architecture.md` §7's coverage-target clause now names both mappings; both wait on the README |
| §5 — *"There is no root `README.md`"* (*edited*) | Still none; a second mapping now waits beside the first | Carried forward without softening, as before |
| Q35 — *"You didn't write this, an AI did"* | Gains Phase 4 instances of *the measurement contradicting the plan*: the mispredicted mutation RED (two failures predicted, one observed — `phase-4-slice-3-…` §5.2); `install()` not freezing time; the layout reversed mid-slice with a dated entry; the SPA fallback hole found by the suite that closed it; the acceptance walk's own assertion that compares against `-1`, reported rather than filed off | *A generated codebase does not produce a document that argues with itself and then records who won* — the same sentence, four more times |
| §4, joint proof 8 — *"The assertion that catches the bug is never the one about the shopper"* | Gains a browser counterpart in two directions: the "nothing happened" assertion is the one most likely to pass vacuously, so it was proven by inversion; and the e2e watches a key *arrive* but cannot count what left stock, so delivery correctness stays with the API suites | Q23 and Q33 in a browser's clothes (Q38, Q55) |
| §6, sentence 3 — *"…proving the test could ever have been red…"* | Gains an instance, not a clause: the same discipline applied to a non-race assertion, with the RED an inversion rather than a weakening | Appendix C says which of the seven Phase 4 touches |
| §8 — the evidence table (*edited*) | Seven Phase 4 rows: `phase-4.md` and slices 1, 2, 3, 4, 5, 7 | The seventh, `phase-4-slice-7-acceptance.md`, appeared in the tree while this appendix was written |

---

## Appendix C — the sentences Phase 4 earns

Phase 3's seventh sentence — *"A shop can be wrong about the world and still be right about its records"* —
is the through-line of the concurrency argument said from the far end, and Phase 4 has no counterpart to it,
because Phase 4 makes no claim about records. Its two sentences are about the face and about the join, and
each is the phase's own wording or assembled from it.

1. **"Structurally close, five interactions, the rest static — is a tested property, not a description of
   what was skipped."**
   *`phase-4.md`'s preface, in its own words.* The five have a RED each (write-first, then a mutation of the
   one line the test guards); fourteen tests assert that fourteen controls do nothing, and the assertion was
   shown able to see the one that does (Q37, Q38). Say it when asked why the search does not search: the
   answer is not "we ran out of time" but "here is the test that proves it doesn't, and here is the run that
   proves the test can tell."

2. **"The face joins the engine by sending the same request: three empty diffs and one feature edit."**
   *Assembled from `phase-4.md` §5's three headings — "One line", "Three empty diffs", "The one feature
   edit" — and `phase-4-slice-5-…` §6's first answer, "Nothing, and the proof is three empty diffs and one
   green run".* `apps/api`, `packages/contracts`, `packages/db` untouched; `features/buy-product` at 68 / 0,
   all of it the re-enable on restore, which is correct only because the intent key was already forgotten
   (Q40, Q42). Say it when asked what the storefront cost the concurrency proofs: nothing, because no
   guarantee ever lived in the page, which is sentence 1 of §6 seen from the front.

**Which of the seven earlier sentences Phase 4 touches.** None of the four Phases 1 and 2 earned (§6, 1–4)
changes its wording, and none of Phase 3's three (5–7) is touched at all. The one that gains anything is the
third, the testing one — *"proving the test could ever have been red … is the only way to find out which
invariant each test actually guards — and which assertions can never tell you anything"* — and it gains an
instance rather than a clause: on a page, the RED is an inversion, and the assertion that can never tell you
anything is the browser's about delivery correctness, which is why that proof stayed where it was. Sentence
1 is not touched but is reaffirmed from the other side — the join moved no guarantee into the page — which is
what makes sentence 2 above true.

Runners-up worth having loaded, though not memorised: **"Inert by construction, not by cancellation"**
(`phase-4.md` §2; Q48); **"The reducer decides what happens to the timer; the DOM only carries it out"**
(§3.1; Q45); **"'Smooth' is not a thing a test can watch, so it was made into two things a test can read"**
(§3.4; Q55); **"'Serving' and 'separate' are exactly the two things it refuses to conflate"** was Phase 2's (Q14),
and Phase 4's twin is **"a shared resource with global state cannot be driven by two actors at once, and
'flaky' is usually a second actor"** (`phase-4.md` §7; Q56); and **"a test that passes on the second try is a false statement, not a pass"**
(`retries: 0`; Q55).

---

## Appendix D — Phase 5's questions

Numbered on from Q58. Unlike Appendix A's, every one of these *is* a question about the concurrency argument
— Phase 5 is its second, independent instance — and they are an appendix rather than a re-synthesis so that
every Q number the earlier maps gave stays stable and the second instance can be read beside the first. Each
answer is in the map's register — the code fact beside the plain reason — and ends with the section of
`phase-5.md` that has the depth and the slice document behind it. Where two Phase 5 documents answer the same
question differently, the better answer is used and the other is named, marked **▸** as in §3. The roadmap's
line for the phase is the one this appendix exists to answer: *"why a read-then-increment is a race, and how
a single conditional update replaces it."*

| # | The question | The one argument that answers it | Evidence |
|---|---|---|---|
| Q59 | Why is a read-then-increment a race? It checks the limit. | The check and the write are two round trips with a decision between them, made against a number that is already stale: two shoppers read `2`, both pass `2 < 3`, both write `3`. Nothing in a process closes the gap, because the gap is between the process and the database | `phase-5.md` §3.1, §3.2 |
| Q60 | How does one conditional `UPDATE` replace it? | The check is in the `WHERE`, the write is relative to the row, `RETURNING` says which way it went; twenty queue on the row's lock and each, when its turn comes, is re-evaluated against the row as the previous transaction committed it | `phase-5.md` §3.3, §2 |
| Q61 | Why four processes, and what would one show? | `max: 1` serialises a single process in Node before Postgres sees anything; the broken guard admitted nine, then eleven, of twenty across four and would admit exactly three against one. Waves | `phase-5.md` §3.4 |
| Q62 | Isn't this just the key claim again? | Same principle, different statement: I6 picks a free row and skips locked ones; I7 tests-and-writes one row and must not skip. Both REDs have the same signature — a count that varies between runs | `phase-5.md` §3.5; `phase-5-slice-3-…` §4.4 |
| Q63 | The CHECK already says `used_count <= max_uses`. Isn't that the limit? | The backstop, and it hid a broken guard: drop the `WHERE`, and the counter reads `3`, three rows, three prices — every database fact correct — while seventeen shoppers were answered `500` (`23514`) | `phase-5.md` preface, §6.2 |
| Q64 | Why does the cleanup decrement rather than recompute? | A cleanup that makes the baseline true is a test that cannot fail; the decrement lets drift survive to the after-run assertion — and it caught the race from below, as a `−6` the same CHECK refused | `phase-5.md` §7, §6.1 |
| Q65 | Why refuse before writing, and what would a sentinel throw cost? | Every statement that can say no runs before either that only writes, and a refusal is a *value* the transaction returns after committing nothing; a sentinel costs the exhaustive `switch`, a `ROLLBACK` round trip on `max: 1`, a stack trace per busy shopper, and Nest's filter | `phase-5.md` §5 |
| Q66 | Why is the order view read after `COMMIT`? | A pooled read inside the transaction on `max: 1` is a self-deadlock — ten seconds with the order lock held; `findOrder` takes no `tx` and `lockOrder` only a `tx`, so the wrong composition has no API | `phase-5.md` §5 |
| Q67 | How does the server keep the price its own? | `{ code }` is the only input; the amount is computed under the lock from two stored numbers; `amount_minor` is written by two statements in the codebase; the wire carries no `kind` or `value`; the page has no arithmetic — one calculator | `phase-5.md` §4 |
| Q68 | Why is one code per order a `PRIMARY KEY (order_id)`? | Phase 1's `UNIQUE (promo_id, order_id)` admitted two *different* codes on one order; the stronger key implies the weaker, and zero rows from `ON CONFLICT (order_id)` under the order lock is a throw, not an outcome | `phase-5.md` §10 (row 1), §5 (step 6); `architecture.md` §3.1 |
| Q69 | Why is a use spent at apply time, never returned? | The spec's own criterion — an abandoned order does not return a use; a reservation needs a state, a sweeper and a second transaction on the hot row, for a fairness the brief did not ask for | `phase-5.md` §10 (row 2) |
| Q70 | What does the admin reset touch, and why do local checks never call it? | `UPDATE promo_codes SET used_count = 0`, the ledger untouched — the counter is state, the ledger is history; locally the CTE hands back exactly what a run spent, and a run that reset instead would fail the next suite's baseline on the ledger | `phase-5.md` §7; `architecture.md` §9 |
| Q71 | What happens with the order lock gone, and why can't `pnpm race promo` see it? | Twenty distinct orders: nothing — I7's own row lock serialises them. One order ×4: three `500`s, the counter held by the rollback, not the lock — I8's `ON CONFLICT` is a second stop. The reviewer's copy never sends two requests for one order | `phase-5.md` §6.3, §10 (the first "+" row) |
| Q72 | What is R6, and why is it open? | The simulator reads `amount_minor` without a lock, then delivers the webhook; a code applied in that window is applied to a list-price payment. The honest fix is in the processor and out of scope by the spec's §3 | `phase-5.md` §10 (row 4), §11; `architecture.md` §9 |
| Q73 | How does the page show a price it never computed? | `formatPrice` over three kopeck fields the shop sent; `discount_minor` on the wire as its own field so the page never derives it; no optimistic paint | `phase-5.md` §4, §8 |
| Q74 | Why does the form refresh through the poll instead of painting its answer? | One writer; a stale poll read landing after the form's paint would repaint `promo: null`; `refreshNow` runs after any in-flight read — exactly one repaint, whichever read carries the news | `phase-5.md` §8 |
| Q75 | What does the `promoCode` memo protect against? | The one failure in the phase that produces no evidence of itself: the `POST` succeeds, the refresh reads the promo back, the memo says nothing changed, and the shopper sees nothing happen until they pay or reload | `phase-5.md` §8 |
| Q76 | What did the T4 first-paint finding teach? | The obvious inversion (a status gate) failed T5 and *passed* T4; T4 claims a cold read, so its inversion is a first-paint-only suppression — the memo guards later comparisons and the first one, and neither test stands in for the other | `phase-5.md` §8 |
| Q77 | What are the two harness findings, and what are they not? | The e2e teardown deleted an order while the server's continuation was still running (once, load 14–30); `key-claim-race` failed 5/7 under load 12–16 and passed alone. Harness ordering and load, not product bugs, and carried as open | `phase-5.md` §9, §11 |
| Q78 | Why not `SERIALIZABLE`, an advisory lock, `COUNT(*)`, or Redis? | Each is a page of code and a new failure mode: a retry loop the reader cannot see (seventeen of twenty aborting), a lock the next person deletes, a scan that is not a thing with a lock, an increment in a different process from the ledger | `phase-5.md` §10 (row 10) |
| Q79 | What does Phase 5 leave unproven or unfinished? | Shape B's 8 553 ms recorded and not explained; the one-process `3` arithmetic, not measured; the harness lift; the tree moved past the evidence window; Slice 6 to come | `phase-5.md` §11, §10 (the two "+" rows) |

### Q59 — "Why is a read-then-increment a race? It's three lines and it checks the limit."

Because the check and the write are two round trips with a decision made in between, and the number the
decision uses is stale by the time the write is sent. Take the obvious implementation, the one every first
draft writes: `SELECT used_count FROM promo_codes WHERE code = 'LIMIT3'` returns `2`; TypeScript compares
`2 < 3` and goes on; `UPDATE promo_codes SET used_count = 3` — `$read + 1`. Two shoppers at the same instant
with the counter at `2`: A's `SELECT` returns `2`; B's returns `2`, because nothing has changed yet and a
`SELECT` takes no lock that would make B wait for A; both pass; both write `3`; both insert a ledger row. The
code was applied twice, the counter moved once. Generalised: N transactions reading at the same moment all
read the same committed value, all pass, all write the same `read + 1` — **the counter advances by one per
*moment*, the ledger by one per *transaction*.** Nothing between the two round trips closes the window, and
the list of things that look as though they would is the useful part of the answer: a second check in
TypeScript checks the same stale number; a lock in Node is one process's lock, and the API runs as serverless
functions where two requests are two processes (§1); a retry loop retries the same read-then-write; and
making the gap shorter does not help, because it is a race and not a timeout — the harness's whole
twenty-request race took **204 ms** and still admitted nine (Q61). What closes it is one of two things, and
both put the decision in Postgres: make the database decide the value at the moment it writes, or hold a lock
from the read to the write so nobody else can read in between. The first does it in one statement, and that
is I7 (Q60); the second is what the same-order test exercises through I4's order lock, where five statements
have to run under it rather than one (Q62, Q71). This is Q2's twenty-sessions experiment with a counter in
place of a delivery row, and §6's second sentence — *every one of those checks was correct at the instant it
ran* — is the reason the shape survives review: `2 < 3` was true.

*`phase-5.md` §3.1, §3.2; `phase-5-slice-3-the-limit-holds-under-parallelism.md` §3, §9.*

### Q60 — "So what replaces it, and why is one statement enough?"

One statement, as the ORM emits it and as the comment beside the call quotes it:

```sql
update "promo_codes"
set "used_count" = "promo_codes"."used_count" + 1
where ("promo_codes"."id" = $1
       and "promo_codes"."used_count" < "promo_codes"."max_uses")
returning "used_count";
-- 1 row  => THIS transaction holds one of the N uses
-- 0 rows => EXHAUSTED. Nothing has been written; the transaction commits
--           empty and the shopper is told the code is spent (409)
```

The check is in the `WHERE`, the write is relative to the row, and nothing is read into a variable. Twenty of
these arrive at one row. The first to reach it takes the row's lock — an `UPDATE` always does — and holds it
until its transaction commits; the other nineteen **queue on that row**: not on the table (a shopper applying
`WELCOME10` is not waiting behind `LIMIT3`'s queue) and not in Node (four processes share no memory; the
queue is inside Postgres, where the row is). When the first commits, `used_count` is `1`, and the second
obtains the lock. Here is the step that makes the statement correct rather than merely tidy. Under
`READ COMMITTED`, the second `UPDATE` began with a snapshot in which `used_count` was still `0` — but Postgres
does not write on that stale version. Having waited for the lock, it fetches the row **as the previous
transaction committed it**, re-evaluates `used_count < max_uses` against that version, and only if it still
matches applies `used_count + 1` to it. Postgres's name for the machinery is EvalPlanQual; this map otherwise
says *re-evaluates the `WHERE` against the row as the previous transaction committed it*. So the second sees
`1 < 3` and writes `2`; the third `2 < 3` and writes `3`; the fourth obtains the lock, re-evaluates `3 < 3`,
matches zero rows, updates nothing, and `RETURNING` hands back nothing — the `409`. Three winners, seventeen
refusals, in whatever order the twenty reached the row. Three details are load-bearing, and each RED in Q63
and Q61 leans on one: **`used_count + 1` in SQL, not `$read + 1` from Node** — relative to the committed value
after the queue and the re-evaluation, where a computed absolute is relative to a value read earlier, and
"earlier" is the window (Shape A); **`RETURNING "used_count"` tells one row from zero** — an empty result *is*
the exhausted branch (Shape B removes the `WHERE` that produces it); and **the definition read at step 4 does
not select `used_count`** — the counter is read by no statement but the one that writes it, so nothing in
memory can be tempted to compare against a count it read a moment ago; Shape A began by adding `used_count` to
that very column list. This is Q12's null-result sentence — *two concurrent `UPDATE`s on the same row already
serialise on that row's write lock … re-evaluates its own `WHERE` against the newly committed version* — no
longer the reason a RED came back green but the mechanism itself.

*`phase-5.md` §3.1, §3.3, §2 ("Re-evaluation", "The row lock, and the queue"); `architecture.md` §3.1 (I7);
`phase-5-slice-3-…` §4.1–§4.3.*

### Q61 — "Why did the proof need four API processes? Twenty concurrent requests to one server is concurrency."

Not with a pool of one. `packages/db/src/client.ts` pins the pool to `max: 1` per API process — the
serverless shape, not a test setting — so inside one process a transaction holds the only connection from
`BEGIN` to `COMMIT` and the second concurrent redemption waits *in Node* for a connection before a byte
reaches Postgres. Every transaction runs alone. A read-then-increment in that setting reads the newest
committed value every time — `0`, then `1`, then `2`, then `3` and refused — and produces exactly three,
because the pool serialised what the code did not. That is Q14's argument in Phase 5's clothes, and Q14's
measurement is still the only one against one process: Phase 2's key claim weakened to an unlocked
`SELECT`-then-`UPDATE` gave **20** distinct keys against one process and **9** against four; this phase did
not run Shape A against one process to record the `3`, and says so — the one-process number is arithmetic
from the pool (`phase-5.md` §10, last row). So the harness starts four: `promo-limit-race.test.ts` builds the
packages, spawns four `dist/main.js` on **5201–5204**, waits on each `/api/health`, creates twenty orders
round-robin, fires twenty `POST …/promo { code: "LIMIT3" }` in one `Promise.all` — all twenty sent before any
answer is awaited — and throughout samples `pg_stat_activity` from a second connection for distinct backend
pids, a soft witness that the requests overlapped, beside the RED, which is the hard one; on the three RED
runs it saw **`[9204, 9205, 9206, 9207]`**, **`[9885, 9886, 9887, 9888]`** and **`[10098, 10099, 10100,
10101]`**, four distinct every time. **Nine of twenty, and the wave arithmetic.** With the guard replaced by a
read-then-increment (Shape A) the four-process harness admitted **9 × `200`** on one run and **11 × `200`** on
the next, for a limit of three; the technical spec had predicted twenty. The reason it was nine is the same
`max: 1` pool that makes one process useless as a harness: four processes, four connections, at most four
transactions inside Postgres at once — a *wave*. Every member of a wave reads the same committed counter and
writes the same `read + 1`: wave one reads `0`, four winners, counter `1`; wave two reads `1`, four winners,
counter `2`; wave three reads `2`, four winners, counter `3`; wave four reads `3` and refuses. The counter
advances by one per wave, the ledger by one per winner; the most the shape can admit is twelve, and nine and
eleven are waves not perfectly aligned — some transactions in a wave already saw the previous commit.
`ONCEONLY` is the cleaner case: only the first wave can win, so the winner count is the wave size, and it was
**4 × `200`** on both runs — the number of processes, exactly. Against one process there would be one
transaction per wave, each reading the newest value, and the count would be exactly three: the race invisible.
The spec was right in kind and wrong in degree, for the same reason one process shows nothing — and that is
R1 stated as arithmetic, and why the four-process number is the proof and the one-process number is nothing.

*`phase-5.md` §3.4, §10 (last row); `phase-5-slice-3-…` §5.1, §7.1; `architecture.md` §7.*

### Q62 — "Isn't this just Phase 2's key claim again?"

Same principle, different statement — and the difference is Q11's rule applied a fourth time. Phase 2's I6
*picks a free row*: the subquery locks one unclaimed key with `FOR UPDATE SKIP LOCKED` and skips any row
another transaction already holds, so twenty claimants take twenty different keys without waiting for each
other. I7 *tests-and-writes one row*: every redemption of `LIMIT3` wants the same row, so they must queue on
it, and `SKIP LOCKED` would be exactly wrong — a transaction that skipped the locked row would tell a shopper
"exhausted" one commit before the count was known. Ask whether *any* row will do: for a key, yes, skip; for
the counter, no, wait. What they share is what makes both correct across processes: the decision (is this key
free? is this count below the limit?) and the write (claim it; increment it) are one statement, evaluated by
Postgres under a row lock, and `RETURNING` reports which way it went. Neither reads a value into a process and
acts on it later. Both REDs have the same signature — **a count that varies between runs**: nine, then ten,
of twenty for the keys; nine and eleven for a limit of three here — which is Q14's observation that a stable
number would mean something is serialising. **▸ `phase-5.md` §3.5 and the slice's §4.4 say the same thing;
the slice adds the one sentence about the same-order test**, which exercises the older invariant too: four
presses on one order race I4's `SELECT … FOR UPDATE` on the order row first, the first through takes the use
and writes the ledger row, and the other three find that row at step 3 and answer `already_applied` with the
identical view — a lock across a read and a write, the second of Q59's two closings, and the right tool there
because the transaction has five statements to run under it, not one.

*`phase-5.md` §3.5; `phase-5-slice-3-…` §4.4; `architecture.md` §3.1 (I6, I7).*

### Q63 — "Your CHECK constraint already says `used_count <= max_uses`. Isn't that the limit?"

It is the backstop, and it hid a broken guard from every test that read the counter — which is the finding
Phase 5 adds to the argument rather than a mechanism it adds. **Shape B**: keep `used_count + 1` in SQL and
drop the `WHERE used_count < max_uses` — the increment is still relative, the guard is gone. Three
transactions increment `0 → 1 → 2 → 3`; the fourth obtains the row lock, computes `3 + 1`, and Postgres
refuses the row before it is written:

```
ERROR [ExceptionsHandler] DrizzleQueryError: Failed query: update "promo_codes" set "used_count" = "promo_codes"."used_count" + 1 where "promo_codes"."id" = $1 returning "used_count"
  cause: error: new row for relation "promo_codes" violates check constraint "promo_codes_used_count_range"
  severity: 'ERROR', code: '23514',
  detail: 'Failing row contains (3, LIMIT3, percent, 25, null, 3, 4).',
  constraint: 'promo_codes_used_count_range', routine: 'ExecConstraints'
```

`Failing row contains (3, LIMIT3, percent, 25, null, 3, 4)` is the row it tried to write, column by column in
the table's order — `id 3`, `LIMIT3`, `percent`, `25`, no currency, `max_uses 3`, `used_count 4`; `23514` is
Postgres's error code for a `CHECK` violation and `ExecConstraints` the routine that raised it — **26 times**
in the instances' stderr, 17 + 9, one per `500`. The transaction aborts, the error reaches Nest's default
handler, and the shopper gets `500 { "statusCode": 500, "message": "Internal server error" }`. Measured across
four processes: `LIMIT3` ×20 → **3 × `200`, 17 × `500`, 0 × `409`**, in 8 553 ms; `ONCEONLY` ×10 → 1, 9, 0.
Now read the database: the counter reads `3`; the ledger holds three rows for the three winners (the fourth
never reached step 6); the three winners carry `96750` and the seventeen losers `129000`; the ledger's
`order_id` set equals the winners'; `afterAll`'s baseline **held**, because counter and ledger agreed. **Every
database-side fact a counter-only test could read was correct, and only the shoppers' responses were wrong.**
The reviewer's copy said it line by line — `PASS  exactly 3 × 200`, `PASS  used_count = 3 for LIMIT3`,
`PASS  exactly 3 promo_redemptions row(s)`, `PASS  the ledger's order_id set equals the 200s'`, and `FAIL  zero
5xx — a guard weakened to an unconditional increment trips the CHECK as 500s while the counter still reads the
cap (R2) — 17 × 5xx`: four failures, every one a response-shape line, every database line green. That is
Phase 2's lesson — a UNIQUE index once masked a broken lock (Q15) — wearing a CHECK constraint, and it decides
the assertion order in every proof of the limit: every response is `200` or `409` (*the load-bearing
assertion (R2)*, the inline comment says), exactly N × `200`, exactly the rest × `409 exhausted`, **zero
`5xx`**, and only then the counter and the ledger, as corroboration. Under this shape the first red line was
`every response must be 200 or 409, never anything else: got 500 … expected [ 200, 409 ] to include 500`. The
CHECK keeps its place — it holds when TypeScript is bypassed, and its lower bound is what made Q64's `−6` an
error rather than a negative count — but it is the backstop, not the mechanism, and a proof that reads only
the backstop's column proves nothing about the mechanism. Shape B was predicted exactly (R2); one number in
it is recorded and not explained — 8 553 ms against Shape A's 204 (Q79).

*`phase-5.md` preface, §6.2, Appendix A.2–A.3; `phase-5-slice-3-…` §5.2, §6 ("Shape B").*

### Q64 — "Why does the cleanup decrement rather than recompute — and what did that have to do with the race?"

Because *a cleanup that makes the baseline true is not a cleanup; it is a test that cannot fail* — the
harness's own comment. Functional spec §2.5's last criterion is that the second run behaves like the first
with no manual tidying, and locally that is one statement in `finally`, placed before the `orders` delete
because `promo_redemptions.order_id` is a real foreign key:

```sql
with gone as (
  delete from promo_redemptions where order_id = any($1::text[]) returning promo_id
), per_promo as (
  select promo_id, count(*)::int as n from gone group by promo_id
)
update promo_codes p set used_count = p.used_count - per_promo.n
from per_promo where p.id = per_promo.promo_id
-- 0 rows updated => none of these orders had a code applied; not an error
```

Delete this run's ledger rows returning which code each named, group, subtract from each code exactly the
number removed; one statement, so there is no instant at which the ledger has shrunk and the counter has not.
The obvious alternative — recompute `used_count` from `count(*)` of the ledger, or simply zero it — was
rejected because it erases evidence: if the application drifted during a run (counter 3, ledger 2, which is
what a broken rollback looks like) a recompute writes 2, the delete brings it to 0, and
`assertBaseline("after")` passes on a bug it just erased; the decrement subtracts the two rows the test
removed, leaves 1, and the assertion fails with `sum(used_count) = 1, expected 0`, pointing at a counter that
outran its ledger. Proven live in Slice 1 on rows written by SQL — counter 3 against a ledger of 2 → CTE →
1 / 0 where a recompute would have written 0. **Then, unplanned, it fired from the other side.** Under Shape A
(Q61) the guard admitted nine against a counter of three; the `finally` cleanup deleted nine ledger rows and
subtracted nine from three, and `promo_codes_used_count_range`'s *lower* bound — `used_count >= 0`, added in
Slice 1 for an over-decrementing cleanup — refused the row it tried to write: `Failing row contains
(3, LIMIT3, percent, 25, null, 3, -6)`. Slice 1's argument was that a recompute would *hide* a counter that
outran its ledger; here the ledger outran the counter, and the decrement made it impossible to miss — a
recompute would have written `0` and reported a clean baseline on a run that had just admitted nine. Two
smaller facts from the same run: in JavaScript a `throw` from `finally` replaces whatever was already
propagating out of the `try`, so Vitest reported the CHECK violation at
`cleanupTestOrders test/concurrency/support/db.ts:296:3` in place of the assertion, `afterAll` read
`orders = 30`, `sum(used_count) = 4`, `promo_redemptions = 13`, and the assertions were only read on a second
run with the cleanup's throw caught temporarily in the test file (`expected […] to have a length of 3 but got
11`); and the debris was cleaned by hand with `UPDATE promo_codes SET used_count = 0` — the admin reset's
shape, the one time it is honest, because counter and ledger had been *made* to disagree. The baseline reads
the counter with `coalesce(sum(used_count), 0)` — a `sum()` over an empty table is `NULL`, and whether `NULL`
slips past a zero check depends only on how the check is spelled — and reports counter and ledger as two lines,
so a drift is visible as *which one* moved. The same statement, byte for byte, is in
`apps/web/e2e/support/db.ts`, and R13's order of runs — `pnpm test:e2e`, then `pnpm race promo` twice, then
`pnpm test` — is the proof that the chain holds: each later run's baseline is the evidence the earlier one
cleaned up.

*`phase-5.md` §7, §6.1, §9 ("R13"); `phase-5-slice-1-…` §3.3; `phase-5-slice-3-…` §5.3, §7.2.*

### Q65 — "Why do the refusals come before the writes — and what would throwing to roll back have cost?"

Because the order of statements *is* the design. `PromoRedemptionService.apply(orderId, rawCode)` is one
`BEGIN … COMMIT` on one connection, eight numbered steps, six of them SQL: (1) the order lock,
`select … from "orders" where "orders"."id" = $1 for update` — zero rows `order_not_found`, `404`; (2) in
memory, `status !== 'created'` — sound only because of step 1 — `not_awaiting_payment`, `409`; (3) this
order's existing redemption, read under the order lock and **before** the code lookup — the same code,
`already_applied`, `200` with nothing written; a different code, `another_code_applied`, `409`; (4) the
code's definition with no `FOR UPDATE` and **`used_count` deliberately not selected** — `unknown_code`, `422`;
then `computeDiscount` in memory; (5) **I7**, the conditional `UPDATE` — `exhausted`, `409`, nothing written,
the transaction commits empty; (6) **I8**, the ledger insert — impossible under the lock, a throw; (7)
`applyDiscount` — impossible under the lock, a throw; (8) return `{ outcome: "applied", … }`, with **no
re-read inside the transaction** (Q66). Five steps can say no, and they run ahead of the two that only write.
When any of the five says no, the method *returns* a member of the seven-member outcome union, the wrapper
issues `COMMIT`, and the commit is of a transaction that changed nothing; step 5 sits at the hinge — the last
thing that can refuse and the first thing that writes, and the two are the same fact, a statement that
matched zero rows wrote nothing. The controller's `switch` over the union, with `assertNever` in its
`default`, is the only place an outcome becomes a status, and `promoRefusal(reason)` builds body and status
together so they cannot disagree — `422` for an unknown code in the sense `POST /api/orders` already uses for
a SKU the shop does not sell, `409` for exhausted in the sense of `out_of_stock` (the state is the counter;
the conflict is that it is full), `{ reason }` because `error` is already Nest's field for the phrase
(`phase-5.md` §10, row 6). Step 3 sits before step 4 for a reason that matters under load: a retry, a
double-click, a reload that resubmits are all answered from *this order's* ledger row under *this order's*
lock and never touch the `promo_codes` row twenty other shoppers are queueing on — which is also why the same
code twice is a `200` and not a `409`; a `409` would make a retry look like a conflict (row 7). **The obvious
alternative** is to increment first, then lock the order and check the rest, and when a later check fails
throw a sentinel so the wrapper rolls the increment back, catching it by type in the controller; the technical
spec records that two reviewers disagreed on exactly this and that both orderings are correct *for the limit*.
What the sentinel costs is everything around the limit: the exhaustive `switch` becomes an `instanceof` chain
the compiler cannot check, so a new refusal in the service is a new `500` in the controller until somebody
remembers the second file; every expected refusal becomes a real `ROLLBACK` round trip on a `max: 1` pool with
the order lock — and, in that shape, the hot promo row's lock — held until it completes; a refused shopper
shows up in the log as an error with a stack trace, indistinguishable from a real one, when an exhausted code
under twenty simultaneous shoppers is the limit *holding*; and Nest's exception filter either has to unpack a
domain error or the service has to throw HTTP types from inside a database transaction. This codebase has
never thrown to roll back anywhere — the transition helper, the key claim and the inbox drain all report zero
rows as an outcome (Q5) — and the transaction was written in the shape that keeps that true, at the admitted
price of holding the hot row for two more small statements.

*`phase-5.md` §5, §10 (rows 5–7); `phase-5-slice-2-the-shop-decides-the-price.md` §3, §4.1.*

### Q66 — "Why is the order view read after `COMMIT`, and not returned from the transaction?"

Because on a `max: 1` pool the alternative is a self-deadlock, and it is worth saying slowly. The handler is
two calls in a fixed order: `apply` runs the transaction to `COMMIT` and returns an outcome, never the order;
then, for `applied` and `already_applied`, `OrderViewService.findOrder(orderId)` reads the view on the pooled
handle — one `SELECT` with four `LEFT JOIN`s, two of them new (`promo_redemptions` on `order_id`,
`promo_codes` on `promo_id`; 1:0..1 because `order_id` is the primary key, so no row multiplication). The
body the shopper receives is the committed row, which every other process can also see. The wrong composition
— a pooled read *inside* the transaction — goes like this: the transaction has checked the instance's only
connection out for its whole body; `findOrder` asks the pool for a connection; the pool has none until the
transaction releases its own; the transaction is `await`ing `findOrder` and will not release until it returns.
Nothing can ever return. The driver gives up after `CONNECTION_TIMEOUT_MS` — ten seconds — with an error that
names the pool rather than the cause, and the order row lock has been held for those ten seconds with every
payment worker and every other redemption for that order queued behind it. Q13's sentence — *the connection
is a mutex rather than a resource with headroom* — is the same fact from the other side. It was not discovered
here: `client.ts`'s `transaction()` doc, `OrderTransitionService` and the inbox drain all name it from Phase 2,
and the tech spec carried it as R3 before the code existed. The code avoids it by construction rather than by
care: `findOrder` takes no `tx` and there is no `findOrderWithin(tx, …)`; `lockOrder` and `applyDiscount` take
*only* a `tx`. **The two signatures point opposite ways so the wrong composition has no API to be written
with.**

*`phase-5.md` §5 (the last paragraph); `phase-5-slice-2-…` §4.2.*

### Q67 — "How does the server keep the price its own? The page shows the discount."

By accepting exactly one thing from the shopper — the code, as text — and working out the amount to pay
inside the same locked transaction from two numbers it reads from its own tables. **`{ code }` is the only
input.** The controller's parser reads the `code` key and no other; an extra field is ignored, not rejected —
`{ "code": "LIMIT3", "discount_minor": 100000 }` applies `LIMIT3` at the server's price; empty after trimming
is a `400` before any transaction opens; the string is normalised once — trim, then upper-case — and the
schema's `CHECK (code = upper(btrim(code)))` guarantees the stored side of the equality. **The amount is
computed under the lock from stored data only.** Step 1 locks the order row and returns its `amount_minor` —
`129000` for the 1 290 ₽ `KEY-CS2-PRIME` every test in the phase buys; step 4 reads the code's `kind`,
`value`, `currency`, `max_uses`; `computeDiscount(129000, { kind: 'percent', value: 25 })` is
`Math.round(129000 × 25 / 100) = 32250`, to pay `96750`. Both inputs came from rows read inside this
transaction; the request body is not an input and there is no parameter it could be. The arithmetic is a pure
function with the brief's four worked examples pinned in its unit file — on a 1 290 ₽ order, `WELCOME10` →
1 161 ₽, `GG500` → 790 ₽, `LIMIT3` → 967,50 ₽, `ONCEONLY` → 645 ₽ (`116100 / 79000 / 96750 / 64500`) — and
two cases the seeded amounts cannot tell apart: 25 % of 9 999 kopecks → 2 500 (half up, not truncation) and a
fixed sum larger than the price → 0 ₽ with the whole list price recorded as the discount; it multiplies first
and divides last, so an exact half reaches `Math.round` as an exact `.5`. **Written once, while `created`.**
`orders.amount_minor` is written by exactly two statements in the codebase: the `INSERT … SELECT` that creates
the order, copying `products.price_minor` column-to-column inside Postgres so no TypeScript variable ever holds
a price (Q4's statement), and step 7 — `update "orders" set "amount_minor" = $1, "updated_at" = now() where
("orders"."id" = $2 and "orders"."status" = $3) returning "id"` — at most once more, under the order lock,
taking the branded kopeck type so an unbranded number from a body cannot reach it without an explicit
conversion at a call site the transaction is the only one of. **The list price and the discount live on the
ledger**: `list_amount_minor = amount_minor + discount_minor` holds on every row — including the 0 ₽ row — and
`CHECK (0 <= discount_minor AND discount_minor <= list_amount_minor)` refuses any row for which it would not;
that is what "the record of what was paid does not change after the fact" means as a property of columns, and
a delivered order's view reads the ledger a month later without asking a catalogue that may have changed. On
the wire, `promo` carries `code`, `discount_minor` and `list_amount_minor` and **no `kind`, no `value`, no
percentage**. What goes wrong in a shop that does not do this is the functional spec's §1 in one line — *a
shop that lets the page say what the discounted price is will sell a 3 490 ₽ key for 1 ₽ to anyone who edits
a number* — and the softer version fails one step later: a server that trusts the client's `amount` as the
base "since the page just read it from the API" has let a stale tab or a hand-edited body choose the base.
Measured end to end by hand: an order at `129000`; `LIMIT3` → `amount_minor 96750`, `promo { code LIMIT3,
discount_minor 32250, list_amount_minor 129000 }`; the simulator built its webhook with `amount 967.5` and
the inbox row landed as `payment_events.amount_minor = 96750`; the order went to `delivered` with the promo
still on the view; a second `LIMIT3` on the delivered order → `409 {"reason":"not_awaiting_payment"}`; `FIFTH`
on a fresh order → `422 {"reason":"unknown_code"}`. **The payment path did not change by a line**:
`PaymentSimulatorService.readOrderCharge` selects `orders.amount_minor` and `currency` and nothing else, so the
discounted amount reaches the webhook because the column it always read now holds a smaller number —
confirmed by reading, not editing. The acceptance file's ninth test reads `payment_events.amount_minor` from
the table, and its RED is `expected 96750 to be 129000`.

*`phase-5.md` §4, §1 ("The payment path did not change by a line"), Appendix A.1; `phase-5-slice-2-…` §3,
§4.3; `phase-5-slice-1-…` §4.*

### Q68 — "Why is one code per order a `PRIMARY KEY (order_id)`? The architecture said `UNIQUE (promo_id, order_id)`."

Because the architecture's key admitted a row the functional spec forbids. `UNIQUE (promo_id, order_id)` is
one row per *code per order* — it would have let two *different* codes land on one order, a second discount
on an already-discounted price. The functional spec's rule is one code per order, so the key is `(order_id)`
alone, and the stronger key implies the weaker: a table with at most one row per `order_id` has at most one
row per `(promo_id, order_id)`, so every guarantee I8 was written to give — a retried order never consumes a
second use of the same code — still holds, and `architecture.md` carries the amendment inline in three places
(§2's core tables, §3's row, §3.1's block), each marked `_Amended in Phase 5 (spec 005)_`. The negative proof
was the row the old key would have accepted, refused by `promo_redemptions_pkey` inside a rolled-back
transaction. The statement is `insert into "promo_redemptions" (…) values ($1, $2, $3, $4, default) on
conflict ("order_id") do nothing returning "order_id"`, with the target **named** so the clause forgives
exactly one constraint — the two real foreign keys and the discount-range CHECK still raise as the errors they
are (Q2's rule) — and its zero-row path is the new thing in the codebase: **impossible under the order lock,
and therefore thrown.** Step 3 read this table under I4's lock and found nothing, and every other writer of
this order's ledger row must first take the same lock at its own step 1, so no row can appear between step 3
and step 6; if one does, something wrote to the order without the lock, and that is worth a `500`, a
`ROLLBACK` that undoes the step-5 increment, and a stack trace with `order_id`, `promo_code`, `promo_id` and
`step` on it — the typed `PromoRedemptionInvariantError`. The schema's boxed comment says it in capitals —
*PRIMARY KEY (order_id) IS I8 STRENGTHENED. ONE CODE PER ORDER — NOT ONE USE OF EACH CODE PER ORDER* — and
draws the contrast Q5 needs: `deliveries_order_id_key`, where zero rows is the *expected* loser of a race and
the caller keeps the existing row; here the race is settled one statement earlier, by the order lock, and the
constraint is the proof that it was. Q71 is what that looks like when the lock is actually removed. What it
would take to flip: a composite key and a rule for stacking discounts the brief does not define.

*`phase-5.md` §10 (row 1), §5 (step 6, "The two invariant throws"); `architecture.md` §2, §3, §3.1 (I8,
`_Amended in Phase 5_`); `packages/db/src/schema/promo.ts` (the boxed comment on `promo_redemptions`);
`phase-5-slice-1-…` §3.*

### Q69 — "A shopper applies a code and never pays. You've burned a use. Why?"

Because that is the specification's own criterion — functional spec §2.4's last: *an abandoned order does not
return a use* — and the alternative is a phase, not a line. A use is spent when the code is *applied*, by I7's
increment at step 5, inside the same commit as the ledger row and the repriced order. Returning it would mean
reserve on apply, consume on payment, release on expiry: a reservation state, a sweeper, and a second
transaction on the hot `promo_codes` row — the row twenty shoppers are queueing on — for every abandoned
order. The brief asked for a limit that *holds*, not a limit that is *fair*; a limit that holds is one
increment under one lock, and a limit that is fair is a lifecycle. It is also why the acceptance suite's budget
keeps every test under every code's `max_uses` by construction and why `exhausted` is not exercised there at
all — the only place a use is spent is the one place that spends it, so the four-process race and the
reviewer's copy are the whole of the evidence for the limit (`phase-5.md` §9). To flip it: a `reserved_until`
column, a sweeper, and the fifty-webhook race's staged amounts revisited.

*`phase-5.md` §10 (row 2), §9 (the acceptance row); `phase-5-slice-1-…` §3.*

### Q70 — "There's an admin endpoint that zeroes the counters. Why does it exist, what does it touch, and why don't the local checks use it?"

It exists because a deployed shop is otherwise a one-run shop. Phase 6 points the race scripts at the
deployed URL as the strongest form of the claim — serverless instances share neither kernel nor clock — and a
race script takes a base URL and nothing else; it cannot reach that shop's database. Without a reset the first
run spends `LIMIT3`'s three and `ONCEONLY`'s one, and the second is twenty `409`s that prove nothing. So
`POST /api/admin/promo-codes/reset`, behind the admin bearer token, runs `UPDATE promo_codes SET used_count = 0`
— every row, no `WHERE`, no transaction — returns the four codes with their zeroed counters, and is logged at
`warn` because it is the one write in the shop that makes the counter and the ledger disagree. **It leaves the
ledger alone, and that is deliberate.** `orders.amount_minor` stays discounted after delivery; the code, the
list price and the discount a delivered order shows as «было …» exist only in `promo_redemptions`. Delete the
ledger and an order that paid 967,50 ₽ for a 1 290 ₽ item reads `promo: null` — a discount with no code beside
it, on the shopper's page and in the shop's books. **The counter is state; the ledger is history.** Reset the
one, never the other, and accept that after a reset the counter means "uses since the last reset" while the
ledger keeps the truth — the trade `architecture.md` §9 records beside `ALLOW_CLIENT_SUPPLIED_ORDER_ID`, in
the `supplier_behaviour` family of demo affordances, the same price the eight other checks pay. The check
reaches for it only when it has no database: in `finally` it reads `ADMIN_TOKEN`, calls the endpoint on the
first target, and prints `INFO  counters reset through the admin endpoint; the ledger keeps the rows — a
database was not reachable to clean up`; with no token either, it prints a `SKIP` saying the counters stay
spent and the next run will report `409 exhausted` for every attempt. **Local runs never reach that branch** —
`pnpm race` always has a database, the code comment on the branch says it is unreachable there, and the verify
grepped both local runs' output for the `INFO` sentence and found nothing. Why it must not: a local run that
called the reset instead of the CTE would pass its own counter assertion and fail the next suite's baseline on
the ledger — `sum(used_count) = 0` with `promo_redemptions > 0` — which is the harness noticing exactly what
the reset does (Q64). The shop itself never calls it.

*`phase-5.md` §7 ("Repeatability on a deployed shop"), §10 (row 3); `architecture.md` §9 ("A demo affordance
on promo counters"); `phase-5-slice-3-…` §5.3.*

### Q71 — "What happens if the order lock is missing — and why did the reviewer's check stay green?"

Two different answers for two different scenarios, and the second is the honest gap. **Twenty distinct
orders: nothing.** The lock RED — `.for("update")` dropped from `lockOrder`, so step 1 is an ordinary `SELECT`
— left both twenty-order tests green, because they race distinct orders, so the order lock is not what
serialises them; I7's own row lock on `promo_codes` is. **One order, four presses: three `500`s.** All four
read the order without a lock, all four see `created`, all four find no ledger row at step 3, all four reach
step 5 and queue on the `promo_codes` row. The first increments `0 → 1`, inserts, reprices, commits. The
second obtains the promo row lock, re-evaluates `1 < 3`, increments to `2` — then its
`INSERT … ON CONFLICT (order_id) DO NOTHING RETURNING order_id` finds the first's committed row and returns
zero rows, which the service treats as what it is: a row appeared under a lock this transaction believed it
held. `PromoRedemptionInvariantError` at `ledger_insert`, `ROLLBACK`, the increment undone, `500`; the third
and fourth the same. Measured: `one order, LIMIT3 x4: raced in 230ms; statuses=[500, 500, 500, 200]; pids
[10098, 10099, 10100, 10101]`, and in the instances' stderr `promo: invariant violated under the order lock at
ledger_insert — a promo_redemptions row for order ord_01M2GKW2J13HEP55RBDF3B15E1 appeared while this
transaction held its lock and had read none; the order lock discipline was broken somewhere`. `used_count`
read **1** afterwards, not more — the "and/or `used_count` above `1`" half of the prediction did not happen.
**The counter was held by the rollback, not by the lock.** What the prediction underrated is that I8's
`ON CONFLICT (order_id)` plus the refusal to treat zero rows there as an outcome is a *second* stop that stays
standing when the first is removed; three shoppers saw `500`, which is the honest answer to a broken
invariant, and the ledger, the counter and the price were all correct afterwards. This is Q12's finding a
third time — the guard's own statement serialises even with the explicit lock gone — with the difference that
here the second stop *throws*, because a zero-row ledger insert under the lock is a bug and not a race (Q68).
**And `pnpm race promo` under this RED printed `race:promo passed.`** — 200: 3 / 409 exhausted: 17; 200: 1 /
409 exhausted: 9 — because it has no same-order scenario and cannot see a missing order lock. It is named for
adversarial scenario 5, a limit under parallel requests from many shoppers, and that is what it proves; the
double-click on one order is a different race, on I4 rather than I7, guarded by the Vitest third test in the
commands a reviewer runs (`pnpm test`). What would add it — a third scenario in `promo.ts`, one order, one
`POST` per instance, four `200`s with identical bodies, one row, counter +1, and the README's RED row recording
the lock RED against it — is cheap and not added because the task did not ask; `phase-5.md` §11 carries the
gap.

*`phase-5.md` §6.3, §10 (the first "+" row), §11; `phase-5-slice-3-…` §6 ("The lock RED"), §7.3, §7.4.*

### Q72 — "R6 — the apply-vs-pay window. What is it, and why is it open?"

The one ordering the status guard does not close. The payment simulator reads `orders.amount_minor` without
a lock and then delivers the webhook; a code applied to a `created` order in the milliseconds between that
read and `markPaid` is applied to a list-price payment, and the processor never compares amounts — a Phase 1
decision, *settlement belongs to processing*. Every other ordering is closed: a code cannot land on an order
that is already `paid`, because step 2 reads the status under the order lock and step 7's `UPDATE` names
`status = 'created'`; the window is one simulated-provider round trip. The honest fix is named rather than
hidden — compare `payment_events.amount_minor` to `orders.amount_minor` under the order lock in the processor
and route a mismatch to `payment_failed` with one new reason — and it changes the payment path and the
fifty-webhook race's staged amounts, which the functional spec's own §3 puts out of this phase. So it is
documented in `architecture.md` §9 as a known trade-off, *documented, not closed*, and `phase-5.md` §11
expects Slice 6's coverage table to carry it as a "not covered anywhere by name" row and to say so rather than
fake it. It is Q34's discipline applied to the one gap Phase 5 chose: the reason it was deferred, the fix, and
the cost of the fix, all written down before a reviewer finds it.

*`phase-5.md` §10 (row 4), §11; `architecture.md` §9 ("The apply-vs-pay window", R6).*

### Q73 — "How does the page show a price it never computed?"

By formatting three kopeck fields the shop sent and doing no arithmetic of its own. «967,50 ₽» is
`formatPrice(order.amountMinor)`; «322,50 ₽» is `formatPrice(order.promo.discountMinor)`; «1290 ₽» is
`formatPrice(order.promo.listAmountMinor)`. `formatPrice` divides kopecks by 100 and spells a Russian comma —
arithmetic of *units*, not of *price*, the same function the catalogue has used since Phase 1. A `grep` across
the three files that render or submit an amount, for any amount field beside `+`, `−`, `×` or `/`, finds
nothing; `discount_minor` is on the wire as its own field precisely so the page never derives it as
`list − amount`. So the number on screen is the number in `orders.amount_minor`, which is the number the
simulator reads when the shopper pays, and there is one calculator in the system (Q67). Two calculators drift
on the first input that separates them — the server rounds integer kopecks half up, a page working in roubles
from a float will not always, and a fixed sum larger than the price needs the server's clamp reproduced in a
second language or the page shows a negative amount — and an optimistic paint lies for the length of a
refusal: under the race Q61 measures, seventeen of twenty shoppers would watch a discount appear and vanish.
The shop's answer is the only answer, so the page waits for it. The row is what it waits for: «Сумма»
`967,50 ₽` followed by `(было 1290 ₽)`, then `<dt>Промокод</dt><dd data-promo-code="LIMIT3"
data-discount-minor="32250">LIMIT3 — скидка 322,50 ₽</dd>`, gated on `order.promo !== null` and **never on
status**, so it survives `paid → delivered` — the delivered order shows «Ключ выдан», the key, and the promo
row beneath the discounted amount, which is §2.3's fourth criterion in a picture and T5's claim. This is §1's
layer 2 — *the server owns the state; the page reports it* — with a number in it: the only thing the page
could have been tempted to own is a price, and it owns none.

*`phase-5.md` §4 ("The page has no arithmetic", "What goes wrong in a shop that does not do this"), §8 ("The
row"); `phase-5-slice-4-the-shopper-enters-a-code.md` §4.1.*

### Q74 — "The form gets the repriced order back from the `POST`. Why does it throw it away and ask the poll?"

Because the content region has one writer, and a second one races it. On success the form has the repriced
order in hand — `applyPromo` returns it, and parsing it is how the form knows the `200` meant what it said —
and *discards it*. It calls `onOrderMayHaveChanged()`, which is the poll's `refreshNow()`, and leaves itself
busy. The page already has a loop reading the order once a second, each read chained off the end of the
previous one rather than run on a timer, and one function, `showOrder`, that replaces the content region with
an order in hand; the form, the payment controls and the recovery notice hand it elements and never place
them. A second writer means two snapshots racing for the same region: a poll read that left the browser before
the transaction committed lands *after* the form's paint with `promo: null`, and either the form reaches into
the page's memo or a later read repaints a row that is already there. `refreshNow` has the property that makes
the one-writer rule cheap: if a read is in flight it is *remembered* and run the instant that read lands, never
concurrently. So the stale read lands, the memo suppresses it; the refresh reads the committed view; one
`replaceChildren` paints the row, the new amount, and no form — **exactly one repaint, whichever read carries
the news first.** The form is removed by that repaint, not by itself; left busy and then discarded, the field
cannot be reused by accident to send a second code to an order that already has one. It is Phase 4's *the
reducer decides; the DOM carries it out* (Q45) at the page's other end, and Q32's split — the poll keeps
reading on `created` because the order is waiting on a person — is what makes the refresh free. On a refusal
the form paints its own sentence, because a refusal changes no order: `422 unknown_code` → «Такого промокода
нет», the field editable with the shopper's text in it; `409 exhausted` → «Промокод больше не действует», the
fifth scenario's refusal with a face on it; `409 not_awaiting_payment` or `another_code_applied` → *nothing*,
the form asks the poll to re-read, because the order moved under this tab and a sentence about the code answers
the wrong question; no answer, a `500`, a `200` that is not an order → «Не удалось применить промокод.
Проверьте соединение и попробуйте ещё раз.», the one case where a retry is right. `HttpError` gained a `body`
for this, read once through a `readBody` that **never throws**, and a `409` is classified as a promo refusal
*before* its reason is read, so a `409` whose body was lost in transit can never fall through to the sentence
that invites a retry of something the server has already refused.

*`phase-5.md` §8 ("The poll is the one writer", "The three sentences"), §2 ("The poll", "One writer");
`phase-5-slice-4-…` §4.2, §5.*

### Q75 — "What does the `promoCode` memo protect against?"

The one failure in the phase that produces no evidence of itself. The page's memo — its record of the last
order it painted — was `{ status, code }` for four phases, and it was correct: nothing else on an order
changed after creation. A code applied to a `created` order moves neither. Forget to add `promoCode`, and the
`POST` succeeds, the refresh reads the promo back, the memo compares `created === created` and `null === null`
and returns early. The form stays disabled — it was left busy on purpose, waiting for a repaint that now never
comes (Q74). The amount stays at the list price. No row. A second Enter does nothing. The shopper who applied
a code sees *nothing happen*, with no error anywhere, until something *else* moves the status — they pay, and
the row appears beside «Оплачен» a minute after it was earned — or they reload, at which point `mountApp`
builds the page from nothing with the memo at `null` and everything is right. So a manual check that reloads
between "apply" and "look" proves nothing, every API test stays green, and the webhook carried `96750`
throughout. The only test that can see it asks for the row *by name* without reloading, and that is T1:
`promoCode` dropped from `RenderedOrder`, from the object literal and from the comparison in `showOrder` →
`Expected: "LIMIT3 — скидка 322,50 ₽"` / `Error: element(s) not found`, `toHaveText` on the row's selector,
10 000 ms. It is §4's eighth joint proof — *the assertion that catches the bug is never the one about the
shopper* — inverted once more: here the shopper-facing assertion is the *only* one that can see it, because
the bug is in what the page declines to paint, and every assertion about rows, statuses and webhooks is green.

*`phase-5.md` §8 ("The `promoCode` memo", the T1 row), §2 ("The memo"); `phase-5-slice-4-…` §4.3.*

### Q76 — "What did the T4 first-paint finding teach?"

That two tests which look like one claim are two, and that the obvious inversion proves it. The tech spec's
table named an inversion for T5 — gate the promo row on `status === "created"` — and none for T4 (*a reload
shows the same row and amounts, and no form*). The natural first try for T4 is T5's, and it fails T5 and
*passes* T4: T5's order moves `created → delivered`, so the poll repaints it and a status-gated row vanishes
(`Error: element(s) not found`, 5 000 ms, after the status reached `delivered`); T4's order never leaves
`created` — it is applied, the page is reloaded, and the first paint of the new document builds the row from
a `created` order carrying a promo, which a status gate on `created` admits. So the status gate is not an
inversion of what T4 claims. What T4 claims is that the applied state survives a *cold read* — the page built
from nothing, the memo starting at `null` — as opposed to T1's poll-driven repaint of a page that was already
open. The inversion that isolates that is a temporary branch in `showOrder` rendering `{ ...order,
promo: null }` on a page's very first paint and nothing else; only T4 failed (`Error: element(s) not found`,
5 000 ms, immediately after `page.reload()`), and the other five stayed green in the same run. It sharpens
what the memo protects: T1 guards its *later* comparisons, T4 its *first* one, and neither test can stand in
for the other. The tech spec's §4 row now carries it. It is Q47's mispredicted mutation and Q38's inversion
method together — a mutation proves only the tests that can see it, and the way to find out which is to run
the wrong one first.

*`phase-5.md` §8 ("The T4 first-paint finding", the T4 and T5 rows), Appendix A.4; `phase-5-slice-4-…` §6.*

### Q77 — "Two suites failed under load while you were finishing. What were they, and what were they not?"

Two harness findings, both under machine loads the phase recorded, neither a product bug, both carried as
open rather than filed off. **The e2e-cleanup-vs-continuation race.** Once, under a load average of 14–30,
the simulated supplier timed out inside `buy-through.spec.ts`'s 15-second delivery wait; the fixture's
teardown then deleted the order while the server's continuation was still running, and the continuation
claimed a key after the order had been deleted. Cleaned by hand; the API suites were green after. A harness
ordering gap — the teardown does not wait for a settled state before it deletes — of exactly the shape §7 of
this map names, *helper code accumulates assumptions about what the application can do*: Phase 4's fixture
assumed a delivery lands inside its wait, which under Phase 3's timeout ladder is a property of the machine's
load, not of the shop. **The `key-claim-race` load flake.** Spec 002's race failed **5/7** when batched under a
load of 12–16 and passed alone and at a load of about 9 — the same supplier-timeout mechanism. Nothing in
Phase 5 touched its path; the non-promo source changes in the tree were verified comment-only. What they are
not: evidence about the limit or the price. The full e2e run otherwise stood at **64** (58 + 6), and the
phase's own suites — the race test's `3 passed` in 9.40 s, `pnpm race promo` twice, `pnpm race` 9/9 — were
green in R13's order with the baseline held. Both are the Phase 4 sentence *"flaky" is usually a second actor*
(Q56) with the second actor being load rather than a second runner, and both are in `phase-5.md` §11 with the
numbers, so that a reviewer who sees one does not learn about it from the reviewer's chair.

*`phase-5.md` §9 ("The whole set, today"), §11; this map's §7.*

### Q78 — "Why not `SERIALIZABLE`, an advisory lock, `COUNT(*)` over the ledger, or Redis?"

Each is a page of code and a new failure mode, and none is one line. **`SERIALIZABLE`** works, and the
architecture rejected it in Phase 1 (Q1) for a reason sharper here than anywhere: the guarantee moves out of
the statement into a retry loop the reader cannot see, and under this load seventeen of twenty transactions
would abort and retry for a result the conditional `UPDATE` reaches with zero aborts. **An advisory lock** —
`pg_advisory_xact_lock(promo_id)` around a read-then-increment — works, costs a round trip, hides the lock
from the schema, and makes the read-then-increment *look* safe to the next person, who will drop the lock
call; the conditional `UPDATE` cannot be made unsafe by deleting a line around it, only by editing the
statement. **`COUNT(*)` over the ledger** is the result of a scan, not a thing with a lock; making it safe
means locking something — a `promo_codes` row, which is the counter under another name; the table, which
serialises every code behind every other; or `SERIALIZABLE`, above. **Redis `INCR`** is atomic in a different
process from the one that holds the ledger, the order and the price; the increment and the ledger row stop
being one transaction, and a crash between them is drift by construction. The database already has a row
that can be incremented atomically under the same commit as the ledger row, and that is the whole answer: the
counter and the ledger are *asserted* to agree at every commit, never made to agree by copying one into the
other (Q64), and only a single Postgres transaction can promise that.

*`phase-5.md` §10 (row 10), §2 ("The ledger"); `architecture.md` §9 (the last bullet).*

### Q79 — "What does Phase 5 leave unproven or unfinished?"

The list, carried forward without softening, is `phase-5.md` §11, and the items with a number are these.
**R6 is open by decision** (Q72). **The lock gap in the reviewer's copy** (Q71). **The two harness findings**
(Q77). **Shape B's 8 553 ms** — the `LIMIT3` race under the unconditional increment took 8 553 ms against
Shape A's 204; seventeen aborted transactions with a stack trace logged for each is the obvious suspect, it
was not investigated, and the document does not guess. **The one-process `3` is arithmetic, not a
measurement** — the 20-vs-9 table in `architecture.md` §7 is the only comparison against one process; one more
RED run with `PROCESS_COUNT = 1` would record it. **The tree moved past the evidence window**: between 21:36
and 21:38 on 14 September the acceptance file gained a tenth `it(` (an abandoned order's use still counts) and
`promo.spec.ts` a T7 (a delivered order that never carried a code shows no field) — Slice 6 beginning — so
every count `phase-5.md` quotes is its window's, 9 and 6, and this map says 120 and 64 where it quotes §9 and
121 and 65 where it reads the tree. **The Slice 6 acceptance pass**: the 31-row coverage table, `@spec` on
every new file, `@regression` per the convention, the three-suite run in R13's order, and
`phase-5-slice-6-acceptance.md`, being written as this map was. **The harness lift** —
`apps/web/e2e/support/db.ts` still duplicates the API harness's statements, now seven, and both files still
carry their original `@spec` tags. **The operator's token form keeps `required`** — Phase 3's, against the
Russian rule the shopper's field follows; an inconsistency worth a line in whichever phase next opens that
file. **Two stale sentences in `tasks.md` and the tech spec** — Slice 3 task 1 still carries the Shape A
prediction as "twenty `200`s, twenty rows" where the measurement was nine and eleven; Slice 1 task 3 and tech
spec §4 describe the unit RED as "the four examples fail" where the run recorded eight. **The Phase 4 manual
check is still outstanding** (Q58). **Nothing from Phase 5 is committed beyond `4b5c18f`.** And **out of
scope by design**: entering a code anywhere but the order page; removing or replacing an applied code;
returning a use on abandonment; expiry dates, per-shopper limits, minimum amounts, combining codes; creating
or editing codes; a discount on the storefront's shown prices; public deployment and the root `README.md`
(Phase 6).

*`phase-5.md` §11, §10 (the two "+" rows), §6.2 (the 8 553 ms).*

---

## Appendix E — which earlier answers Phase 5 touches

Phase 5 rewrites none of them, and — unlike Phase 4 — it *does* touch the argument: each row below is a
sentence in the body that gained its second instance, a number, or a runnable form. The first row is the one
the roadmap asked this appendix to write: I7 and I8 were predicted in Phase 1's architecture, and the
prediction was right about the mechanism and wrong about the key. The in-place ▸ edits in §1–§3, §5 and §8
are the rows marked *edited*; the rest are touched here only.

| Where | The sentence that changed or gained a clause | Why |
|---|---|---|
| `architecture.md` §3 — **I7 and I8 as Phase 1 wrote them**, at `d6b9943` (7 September) and unchanged through `4b5c18f`: *I7 — "A promo is used at most N times" — `UPDATE … SET used_count = used_count + 1 WHERE used_count < max_uses RETURNING` — "Parallel redemptions overshoot the limit"*; *I8 — "One promo redemption per order" — `UNIQUE (promo_id, order_id)` — "A retried order double-counts against the limit"*; §3.1: *"**I7** — One statement: no read-then-write, so there is no window to race in"* and *"**I8** — Keeps a retried order from consuming a second use of the same code"* over `INSERT INTO promo_redemptions (promo_id, order_id) VALUES ($1, $2) ON CONFLICT (promo_id, order_id) DO NOTHING;`; §2's core tables: `promo_codes` — *"`code` UNIQUE, `used_count <= max_uses` CHECK"*; `promo_redemptions` — *"Which order used which promo — UNIQUE (`promo_id`, `order_id`)"* | **What the prediction got right, and it is most of it.** I7's statement shipped as predicted — the conditional `UPDATE … WHERE used_count < max_uses` as the guard, one statement, `RETURNING` deciding — and *"no read-then-write, so there is no window to race in"* is the sentence Phase 5 measured, nine and eleven of twenty with the window put back (Q59–Q61). The ledger as the second column — one row per order that spent a use, beside the counter — shipped, and "the counter equals `count(*)` of the ledger at every commit" became the baseline's two lines (Q64). The CHECK shipped, as the upper bound of `promo_codes_used_count_range` (Q63). **What it did not.** I8's key: `UNIQUE (promo_id, order_id)` is one row per *code per order*, which would have allowed two *different* codes on one order — a second discount on an already-discounted price. Phase 5 strengthened it to **`PRIMARY KEY (order_id)`** — one code per order, the functional spec's rule — with `ON CONFLICT (order_id) DO NOTHING RETURNING order_id` (the target renamed, `RETURNING` added); the stronger key implies the weaker, so every guarantee the original was written for still holds; `architecture.md` carries `_Amended in Phase 5 (spec 005)_` at all three places, and the schema's boxed comment says it in capitals (Q68). Three smaller things the prediction did not have: the CHECK's *lower* bound, `used_count >= 0`, added in Slice 1 for an over-decrementing cleanup, which is what turned Shape A's `−6` into an error (Q64); the two price columns on the ledger, `list_amount_minor` and `discount_minor`, which are what make "the record of what was paid" a property of columns (Q67); and I8's zero-row path, which Phase 1 wrote as a bare `DO NOTHING` and Phase 5 made a *throw* — impossible under the order lock, the one rollback path in the transaction, the second stop of Q71 — with the "Without it" widened to *"or a second code stacks on an already-discounted price"* | Predicted in Phase 1, measured in Phase 5, one key strengthened on the way: the same shape as §4's seventh joint proof for the lock, and the schema is again the artefact that proves the sequencing |
| `architecture.md` §7 — *"Concurrency proofs must run across separate API processes … Measured, with the key claim weakened to an unlocked `SELECT`-then-`UPDATE`: 20 distinct keys against one process, 9 against four"* | Gains its **second measurement**, on a different table: Shape A across four processes admitted **9 × `200`**, then **11**, for a limit of three, where the tech spec had predicted twenty — the wave arithmetic — and `ONCEONLY` admitted **4**, the process count exactly; the harness's premise witness is `pg_stat_activity` pids, four distinct on every RED run (Q61). And an honest asymmetry: the 20-vs-9 table is still the only comparison against *one* process; Phase 5's one-process `3` is arithmetic from `max: 1`, not a run (Q79) | The rule was learned by measurement once; the second instance confirms it in kind and corrects the prediction in degree (twenty → nine), for the same reason one process shows nothing |
| `architecture.md` §9 — two new bullets: *"A demo affordance on promo counters"* and *"The apply-vs-pay window"* | The reset — `UPDATE promo_codes SET used_count = 0`, the ledger untouched, local checks never call it — beside `ALLOW_CLIENT_SUPPLIED_ORDER_ID` as the second test affordance a reviewer should read before finding; R6 as *documented, not closed*, with the honest fix named | Q17's rule that a check must run twice against a deployed URL has a second price; Q34's rule that a gap is deferred with its reason has a fifth-phase instance (Q70, Q72) |
| §1, the spine — *"The one thing the two processes share is Postgres, so Postgres is the only place a decision can be made"* (*edited*) | Gains its second, independent instance in one ▸ clause: a limit on a counter rather than a key in a pool; one conditional `UPDATE` rather than `FOR UPDATE SKIP LOCKED`; the same broken shape measured the same way. Untouched but reaffirmed: layer 1 (*the records decide, not the code* — a counter whose guard is inside the statement that increments it); layer 2 (*the server owns the state; the page reports it* — the only thing the page could have owned is a price, and it owns none, Q73); layer 4 (*nothing is believed until it has been seen to fail* — three REDs, one mispredicted in degree, one exactly as predicted, one with a second stop the prediction underrated: Q61, Q63, Q71) | The rule's first sentence — *never by a check in application code* — is the read-then-increment named in advance; Phase 5 is what it costs to ignore it on a counter |
| §2's index and Q5 — *"Eight statements now, eight meanings"* (*edited*) | Ten: I7's zero rows is `exhausted`, the transaction commits empty, `409`; I8's zero rows is **impossible under the lock and thrown** — the first zero-rows in the codebase that is a `500` and not an outcome. One convention, now three responses: split the causes when a read can tell them apart, forbid the collision when it cannot, and throw when the result is evidence of a broken lock rather than of a busy shop (Q65, Q68) | The two new rows are the two halves of the second instance: the mechanism's zero rows and the backstop's |
| Q1 — *"`SERIALIZABLE` would also be correct, and it hides the guarantee inside an invisible retry-on-conflict loop you cannot point at"* | Gains its sharpest number: under twenty simultaneous redemptions of a limit-3 code, seventeen of twenty transactions would abort and retry for a result the conditional `UPDATE` reaches with zero aborts — and three more rejected alternatives beside it, each a page of code (Q78) | The Phase 1 decision stated as a cost rather than a preference |
| Q2 — *"A check followed by an act has a gap, and the gap is where the other process lives"* — twenty sessions, every check correct, twenty keys | Gains its **fourth instance** and the first on a counter: `SELECT used_count` → `2 < 3` in TypeScript → `UPDATE … SET used_count = $read + 1`; nine and eleven of twenty for a limit of three across four processes, every `2 < 3` true at the instant it ran (Q59). And the instance is the roadmap's own question — *why a read-then-increment is a race* — so this is the one to say first | Q2's measurement was twenty keys for one order; Phase 5's is nine uses for a limit of three; same gap, second table |
| Q11 — *"Ask whether any row will do. If the work is 'give me a unit nobody else has', skip. If it is 'this specific row I was handed', wait"* | Gains its **fourth answer**, and it is the clean case of *wait*: every redemption of `LIMIT3` wants the same `promo_codes` row, so twenty queue on it, and `SKIP LOCKED` would be exactly wrong — a transaction that skipped the locked row would tell a shopper "exhausted" one commit before the count was known. I6 picks a free row; I7 tests-and-writes one row (Q62) | The same repository now answers the question four ways on one rule |
| Q12 — *"Two concurrent `UPDATE`s on the same row already serialise on that row's write lock … re-reads the newly committed version, re-evaluates its own `WHERE` against it"* | The Phase 2 sentence that explained a RED coming back *green* is, in Phase 5, **the mechanism itself**: I7 has no explicit lock and needs none, because an `UPDATE` takes the row's lock and `READ COMMITTED`'s re-evaluation (EvalPlanQual, named once in Q60) is what makes the fourth in line see `3 < 3`. And the lock RED is the sentence measured a third time: with the order lock gone the twenty-order tests stayed green because I7's own row lock serialises them, and the same-order case was held by I8's rollback, not by any lock (Q71) | Phase 2's null result was a prediction about every guarded `UPDATE` in the codebase; Phase 5 built one that rests on it entirely |
| Q13 — *"the pool is `max: 1` per instance, which makes the connection a mutex rather than a resource with headroom"* | Gains the self-deadlock instance: a pooled read *inside* the redemption transaction waits ten seconds for a connection the transaction will not release until the read returns, with the order lock held throughout; the view is read after `COMMIT`, and `findOrder` takes no `tx` while `lockOrder` takes only one, so the wrong composition has no API (Q66) | Q13 said a transaction across an HTTP call is an instance-wide outage; Phase 5 adds that a transaction across a *pool checkout* is a self-inflicted one |
| Q14 — *"Why do the race checks need four processes?"* — the harness counts distinct Postgres backends before any check runs | The Vitest race samples `pg_stat_activity` for distinct backend pids *during* the requests — `[9204, 9205, 9206, 9207]`, `[9885, …]`, `[10098, …]` on the three RED runs — a soft witness beside the RED, which is the hard one; and Q14's two rejected fixes (raise the pool size; fire fifty at one dev server) are rejected again in the same words (Q61) | Same premise check, second harness |
| Q15 and Q16 — *"which invariant a check actually guards"*; *"the guard is not what makes the key count one — the ledger and the UNIQUE rule do"* | Phase 5's mirror image: **the CHECK is not what makes the limit hold** — it is the backstop, and it held with the guard gone while seventeen shoppers were answered `500` (Shape B; Q63). And a second Q15: `pnpm race promo` guards I7 and not I4 — it printed `passed` under the lock RED, because it never sends two requests for one order; the Vitest third test is what guards the same-order case (Q71) | Phase 2 learned that a UNIQUE index masks a broken lock; Phase 5 learned that a CHECK masks a broken guard, and ordered every assertion accordingly |
| Q17 — *"What can a reviewer run?"* (*edited*) | Nine checks: `pnpm race promo` — 3 × 200 / 17 × 409 and 1 × 200 / 9 × 409, twice; `pnpm race` 9/9; `promo-limit-race.test.ts` on every `pnpm test`, with the same-order scenario the reviewer's copy lacks; the counts — 14 / 120 API and 6 / 69 web in `phase-5.md` §9's window, 64 e2e; 121 and 65 as the tree stands | The one command a reviewer runs now covers all five of the assignment's scenarios by name |
| Q23 and Q33; §4, joint proof 8 — *"The assertion that catches the bug is never the one about the shopper"* | Phase 5's form: **never the one about the counter.** Under Shape B every database-side line was green — `used_count = 3`, three rows, the `order_id` sets equal, the prices right — and the only red lines were the shape of the responses; so the shape comes first and the counter is corroboration (Q63). And one inversion of the inversion: the `promoCode` memo's failure is visible *only* to a shopper-facing assertion, because the bug is in what the page declines to paint (Q75) | The lesson's fifth phase, and the first time the "wrong" assertion was about a database column rather than a shopper |
| §4, joint proofs 1 and 4 — one command, twice in a row, four processes; the mechanism can fail *and* the checks can fail | Proof 1 gains the fifth scenario, runnable by name; proof 4 gains three REDs of which one was mispredicted in degree (nine, not twenty — the wave arithmetic), one landed exactly as predicted (Shape B, R2), and one was half right (the lock RED's `used_count` stayed at `1` — the second stop the prediction underrated) (Q61, Q63, Q71) | The RED discipline's fourth phase produced a *prediction* record beside the result record, which §4's proof 4 did not have before |
| §4, joint proof 6 — *"Zero rows is normal" and "a status code is an instruction" are the same sentence at three layers* | A fourth layer, and a boundary on the sentence: a refusal is a *value* the transaction returns after committing nothing (`409 exhausted` is the limit *holding*, not an error), and the one zero-rows that is thrown is thrown because it is not a race but a broken invariant (Q65, Q68) | The convention now says where it stops |
| §5, the scenario table and *"Four of five settled and runnable by name"* (*edited*) | Row 5 settled; five of five; `pnpm race promo` | The first mapping `architecture.md` §7 names is complete, and still waits on the README |
| §5, *What is not finished* (*edited*) | Promo codes closed the way Phase 3 closed Phase 2's gaps and Phase 4 its own; what Phase 5 leaves open named in the same list — R6, the lock gap, two harness findings (Q72, Q71, Q77) — and the README bullet gains the ninth check and Slice 6's coverage table to wait for | Carried forward without softening, as before |
| §6, sentences 1–3 | Appendix F says which of the seven Phase 5 touches and how | — |
| Q35 — *"the measurement contradicted the plan"* | Gains Phase 5 instances: nine of twenty where the spec predicted twenty; the cleanup's `−6` that nobody planned, catching the race from below; the lock RED's second stop; the T4 inversion that failed the wrong test first; Shape B's 8 553 ms recorded and not explained; two reviewers disagreeing on the increment's position and both being right for the limit (Q61, Q64, Q65, Q71, Q76, Q79) | *A generated codebase does not produce a document that argues with itself and then records who won* — six more times |
| §7, a note on process — the verifier, the helpers, the documents, the RED that came back green, the specialists | Phase 5's entries in the same list: a technical spec whose prediction was right in kind and wrong in degree, and said so rather than being edited to match; a cleanup helper that caught what the assertion could not, from the side nobody was watching; a `throw` in `finally` that replaced the assertion it was meant to follow; two harness suites that failed under load and were recorded with the load rather than re-run until green (Q61, Q64, Q77) | The reason the mechanisms are believable, fifth phase |
| §8 — the evidence table and the evidence note (*edited*) | Five Phase 5 rows: `phase-5.md` and slices 1–4; the spec and architecture pointers; what was read from the tree for Appendices D–F, at what time, and that no suite was run | The map's own rule, kept |

---

## Appendix F — the sentences Phase 5 earns

Phase 5 has what Phase 4 could not have — a sentence about records — because it is the second instance of
the argument those sentences are about. Its four are below: the first verbatim from `phase-5.md` §3.1, the
third and fourth verbatim from its preface and §7, the second assembled from §4's own words with the
section named.

1. **"A read-then-increment is a race because the count is read in one round trip and checked and written in
   another, so the check is made against a number that may already be stale — two shoppers both read `2`,
   both pass `2 < 3`, both write `3`, and two uses are recorded while the counter moved once. One conditional
   update replaces it because the check and the write are one statement that the database itself evaluates,
   one transaction at a time under the row's lock, against the row as the previous transaction left it — so
   the fourth in line sees `3 < 3`, changes nothing, and the limit holds across any number of processes."**
   *`phase-5.md` §3.1, verbatim — the roadmap's question answered in two sentences before any code is opened,
   and the phase's keystone.* Everything else in the phase is those two sentences slowed down: "one
   transaction at a time under the row's lock" is the queue, "against the row as the previous transaction left
   it" is `READ COMMITTED`'s re-evaluation, and the SQL is `UPDATE promo_codes SET used_count = used_count + 1
   WHERE id = $1 AND used_count < max_uses RETURNING used_count` (Q59, Q60). Say it when asked the roadmap's
   question; the number to have beside it is nine of twenty (Q61).

2. **"The shop accepts exactly one thing from the shopper — the code, as text — and there is one calculator
   in the system."**
   *Assembled from `phase-5.md` §4's first and last paragraphs — "accepting exactly one thing from the
   shopper — the code, as text" and "there is one calculator in the system".* `{ code }` is the only input;
   the amount is computed under the lock from two stored numbers; `orders.amount_minor` is written by two
   statements in the codebase; the wire carries no `kind`, no `value`, no percentage; the page formats three
   kopeck fields and does no arithmetic (Q67, Q73). Say it when asked how the price stays the shop's, and have
   the spec's own line ready for what goes wrong otherwise: *a shop that lets the page say what the discounted
   price is will sell a 3 490 ₽ key for 1 ₽ to anyone who edits a number.*

3. **"A counter with a `CHECK` on it hides a broken guard from any test that reads the counter."**
   *`phase-5.md`'s preface, verbatim — the phase's own contribution to the argument, a finding rather than a
   mechanism.* Drop the `WHERE` and twenty parallel shoppers still leave `used_count = 3`, three ledger rows
   and three repriced orders — every database fact correct — while seventeen are answered `500` (`23514`,
   `Failing row contains (3, LIMIT3, percent, 25, null, 3, 4)`). So every proof of the limit asserts the
   *shape* of the responses first and the counter only in addition (Q63). It is Phase 2's lesson — a UNIQUE
   index once masked a broken lock — wearing a CHECK constraint, and §6's third sentence gains its Phase 5
   instance from it: the assertion that can never tell you anything about the guard is the one about the
   column the backstop protects.

4. **"A cleanup that makes the baseline true is not a cleanup; it is a test that cannot fail."**
   *`phase-5.md` §7, verbatim, quoting the harness's own comment.* The decrement subtracts exactly what the
   run deleted, so drift the shop introduced survives to the after-run assertion; a recompute would erase it.
   Proven in Slice 1 from above (counter 3, ledger 2 → 1, where a recompute writes 0) and, unplanned, under
   Shape A from below — nine deleted from a counter of three, and the CHECK's lower bound refusing `−6` (Q64).
   Say it when asked why the harness does not simply zero the counters, and why the admin reset — which does
   exactly that — is for a deployed shop only and never for a local run (Q70).

**Which of the seven earlier sentences Phase 5 touches.** Three of the four Phases 1 and 2 earned gain an
instance, none changes its wording, and none of Phase 3's three is touched. **Sentence 1** — *every guarantee
is enforced by the database — never by a check in application code, never by a lock inside one process* —
gains its second, independent instance, and the cleanest one: a limit on a counter, one statement, no explicit
lock at all, correct across four processes because Postgres re-evaluates the `WHERE` under the row's own lock;
the clause Phase 3 added (*where a decision needs more than one statement, the rows are read under the lock*)
is the same-order test's half, I4's lock over five statements (Q62). **Sentence 2** — *all twenty ran the check
before any of them had inserted, so all twenty saw zero — and every one of those checks was correct at the
instant it ran* — gains its fourth instance and its second measurement: `2 < 3` was true for every transaction
in a wave, nine and eleven of twenty (Q59, Q61). **Sentence 3** — *proving the test could ever have been red …
is the only way to find out which invariant each test actually guards — and which assertions can never tell
you anything* — gains both halves at once: `pnpm race promo` guards I7 and not I4 (the lock RED, Q71), and the
counter assertion can never tell you anything about the guard (Shape B, Q63). Sentence 4 is untouched — the
redemption is answered inside the request, not after it, and the payment path did not change by a line.
Sentences 5–7 are Phase 3's, and Phase 5 makes no claim about ignorance; the one footnote to sentence 7 is
that the admin reset is the one write in the shop that makes two of its records disagree, and it is
deliberately the reviewer's affordance and not the shop's (Q70).

Runners-up worth having loaded, though not memorised: **"The counter is state; the ledger is history"**
(`phase-5.md` §7; Q70); **"The counter was held by the rollback, not by the lock"** (§6.3; Q71); **"It is the
backstop, not the mechanism, and a proof that reads only the backstop's column proves nothing about the
mechanism"** (§6.2; Q63); **"Both REDs have the same signature — a count that varies between runs"** (§3.5;
Q62), which is Q14's *a stable number would mean something is serialising* from the other side; **"The two
signatures point opposite ways so the wrong composition has no API to be written with"** (§5; Q66); **"Exactly
one repaint, whichever read carries the news first"** (§8; Q74); and the one to say when asked why the proof
is four processes and not a `Promise.all` against one — **"A single-instance race test measures the connection
pool, not the constraint"** (§3.4; Q61), which was `architecture.md` §7's in Phase 2 and is measured a second
time here.
