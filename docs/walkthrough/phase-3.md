# Phase 3 — silence is not failure, the same question asked again, and a purchase recovered long after

> The phase-level walkthrough required by functional spec 003 §2.8. It makes the argument **once**; the seven
> Phase 3 slice walkthroughs beside it hold the evidence, and every claim names the one that proves it.
> Nothing here needs the source code to follow.

## What this phase is for

Phase 2 ended with the shop able to survive its own shoppers and its own payment service: a double-click
makes one order, fifty copies of one payment report make one key, and a report that arrives before its order
is kept rather than refused. Every one of those held because the *supplier* — the outside service the shop
buys keys from — answered every question it was asked.

Phase 3 is about the supplier not answering, and about the difference between two ways of not answering that
look identical from the shop's side of the wire and are opposite in every way that matters.

A supplier can say **no** — the shelf is empty, or it refuses this request. That is a definite answer, and
the right response is to ask somebody else. A supplier can also say **nothing**: the connection times out,
the socket dies, the reply is unreadable. That is not an answer at all — and the trap the phase turns on is
that it *looks* like a no. Treat it as one and the shop asks a second supplier for a second key, while the
first supplier may already have cut one and written it down. Nobody sees this happen. The shopper gets
exactly one key either way, because a database rule holds them to one. What is lost is a key from the shop's
pool of unsold keys, silently, on every timeout.

And whichever way it went wrong, the shopper has paid. So the phase has a second subject: a paid order that
could not be delivered must rest somewhere a person can find it, and that person must be able to push it
through — once, five times in a row, or from two machines at the same instant — and the shopper who has been
staring at a failure page must see the key arrive without touching anything.

Seven slices:

1. **A failure the shopper can see** — a second resting state, `delivery_failed`, classified so that a
   person may leave it (`phase-3-slice-1-…`).
2. **A backup supplier**, and the identifier rule that makes "ask the backup" a different question from
   "ask again" (`…-slice-2-…`).
3. **Silence is not failure** — the central slice: a timeout is *unknown*, never *failed*, and the shop
   goes back to the same supplier with the same question (`…-slice-3-…`).
4. **The operator's list** of every paid order that holds no key (`…-slice-4-…`).
5. **The retry button** — one call into the same issuance the payment takes, safe to press twice
   (`…-slice-5-…`).
6. **The shopper watching** the retry land on a page that had shown a failure (`…-slice-6-…`).
7. **Three more checks a reviewer runs** — refusal, silence, and recovery after a restock — each broken on
   purpose before it was believed (`…-slice-7-…`).

§2.8 asks for three keystones: why an unanswered request is not a failed one (slice 3); why asking the same
supplier again is safe while asking a different one is not (slices 2 and 3); and how a purchase is recovered
long after it went wrong (slices 1, 4, 5 and 6). A fourth is added, as Phase 2 did, because it is the reason
to believe the other three.

---

## The words this document uses

Everything below is explained where it first matters, but this phase has more vocabulary than the last one,
so it is collected here in four groups. Phase 2's glossary (`phase-2.md`) covers *webhook*, *serverless
functions*, *transaction*, *UNIQUE / PRIMARY KEY* and *ON CONFLICT DO NOTHING*; those are used here without
re-introduction. *Zero rows* is restated at the end, because it does more work in this phase than in any
other.

**The parties.**

- **The supplier** is the outside service the shop buys game keys from, reached over HTTP. This project has
  two, **A** and **B**, both stubs the shop runs itself, and both behave like the real thing: each can be
  told to refuse its next call, or to go quiet for a chosen number of milliseconds at a chosen point. B is
  the **backup**: asked only when A has definitely said no.
- **The operator** is a person with the shop's admin credentials — not a shopper. The recovery list and the
  retry button exist for them.
- **A worker** is whichever process is currently doing the issuance for an order. Two workers can be at one
  order at the same time, from two different processes; most of this document is about what happens then.
- **The automatic path** is everything that happens without a person: a payment report arrives, the shop
  writes it into its inbox, answers the payment service, and a worker issues the key afterwards. **The
  operator path** is the same work started by a button instead.
- **The platform ceiling** is the point at which the serverless host kills a function outright — no
  exception, no `catch`, no log line. It is the one failure the shop cannot record, and several decisions
  below are shaped by it.

**The records.** Six tables carry this phase, and the argument depends on which fact lives in which.

- `orders` — one row per purchase, with a `status` column that moves through the lifecycle
  `created → paid → delivering → delivered`, and can rest instead at `payment_failed`, `out_of_stock` or
  `delivery_failed`.
- `payment_events` — **the inbox**: every payment report the shop has received, written before it is acted
  on, so that no report is lost if the acting fails.
- `issuance_attempts` — **the shop's** record of every question it has asked a supplier: which order, which
  supplier (`provider`), which attempt number, the identifier the question was sent under (`request_id`), a
  `status` of `ok`, `failed` or `unknown`, the supplier's reason if it gave one (`last_error`), and
  `probe_count` — how many times the question has been sent under that id. Called **the attempt rows**
  throughout.
- `supplier_requests` — **the supplier's** record of every answer it has given, keyed on `request_id`.
  Called **the ledger**. It is what lets a supplier answer a repeated question with the same code instead of
  cutting a second key. This is a different table from the attempt rows, on the other side of the wire, and
  the two are never confused below.
- `supplier_keys` — **the pool**: fifty keys, each either unclaimed or claimed by exactly one `request_id`.
  Both suppliers draw from this one pool.
- `deliveries` — one row per key handed to a shopper, and at most one per order.

**The mechanism.**

- **Issuance** is the whole act of obtaining a key from a supplier and binding it to one order. It spends
  money and cannot be undone.
- **The ladder** is the rule that decides, from an order's attempt rows, what to do next. Each thing it can
  decide is a **rung**: *ask A for the first time*; *ask the same supplier the same question again* (a
  **probe**, or **re-probe**); *move on to the next untried supplier* (a **fall-through**); *rest, a key
  exists*; *settle, nobody could answer*; or *settle, every supplier refused*. It is a pure function of the
  rows — no clock, no network — which is why it can be tested by handing it rows. **A walk** is the ladder
  being climbed repeatedly inside one invocation until it reaches a resting rung.
- **The request id** is the string a question is sent under: `req_<order>_<supplier>_<attempt>`. It is
  **derived** from those three facts every time it is needed, never stored and read back. Keystone 2 is
  entirely about this. An attempt is written `a/1` for short below — supplier `a`, attempt 1.
- **A guarded UPDATE** — Phase 2's *status-guarded UPDATE* — is a write that names the states it is
  allowed to move an order *from*, so the database and not the application decides whether the move is
  legal. It returns the row it changed, or no row.
- **The row lock** is `SELECT … FOR UPDATE` on the order row: the first statement of a transaction takes
  the row, and no other transaction may take or write it until this one finishes. Phase 2 added it and
  measured that it changed nothing; this phase is where it starts carrying weight.
- **Stock accounting** is one count against another: keys that have left the pool (`count(*)` of
  `supplier_keys` with a claimant) against keys that reached a shopper (`count(*)` of `deliveries`). It is
  the only assertion in the project that can see a key leave the pool without arriving anywhere.
- **A one-shot** is a counter on a supplier stub — *refuse your next call*, *hang on your next call* —
  spent by a single conditional statement, so that four processes cannot each spend it once.
- **Four processes.** Every check in this phase runs against four separate API processes, each holding one
  database connection, for the reason `phase-2.md` gives at length: against one process no lock is ever
  contested, and a shop with no locking at all passes.
- **RED validation** — deliberately removing the mechanism a check defends, rebuilding, and watching the
  check fail before believing that its passing means anything.

**The words for outcomes.**

- **Definite failure** — the supplier answered, in a form the shop could read, and the answer was no.
  Recorded as `failed` on the attempt row, with the supplier's reason beside it.
- **Unknown** — the shop asked and never learned the answer. Timeout, refused connection, unreadable body, a
  reply echoing an id the shop never sent. Recorded as `unknown`, with no reason, because there is none. An
  attempt in this state is called **outstanding** below.
- **Terminal** — an order status no transition may ever leave: `delivered`, `payment_failed`.
  **Recoverable** — a status nothing moves by itself but a person can: `out_of_stock`, `delivery_failed`.
  **Settled** is the union — the states an order stops moving in on its own. Keystone 3 is largely about the
  day *settled* and *terminal* stopped answering the same question.
- **Zero rows is a normal answer, not an error.** Every statement quoted below changes rows only if a
  condition still holds at the instant the database checks it. One row back means "you did it"; zero means
  "somebody else already did, or it was never yours". In this phase a zero-row answer is, at different
  moments, a `409` (HTTP's *conflict* answer) to the operator, a duplicate press correctly ignored, and — in
  one place — a silent swallowing that would make an order un-reissuable forever, which is why one constraint
  exists specifically to turn that silence into an error.

Two conventions from the planning documents. `context/product/architecture.md` §3 keeps the numbered list of
nine guarantees, **I1** through **I9**; this phase leans on I3 (one order, at most one delivery), I4 (one
worker advances an order), I5 (one supplier request, one code), I6 (one key, at most one request) and I9
(final states are terminal). And **R-numbers** (R2, R3, R7, R11, R12) are entries in the phase's risk
register, `technical-considerations.md` §11, while **A-numbers** (A9) are recorded assumptions.

Four Russian strings appear, because the shop's text is Russian: «Не удалось выдать ключ» ("we could not
issue the key"), «Выдаём ключ» ("issuing the key"), «Ключ выдан» ("key issued"), «страница обновится сама»
("the page will refresh itself"). And the assignment's own phrase for this phase, «таймаут ≠ отказ» — "a
timeout is not a refusal".

---

## Keystone 1 — an unanswered request is not a failed one

**The decision.** When the supplier does not answer, the shop records the attempt as `unknown` — not
`failed` — and the only thing it is then permitted to do is ask **that same supplier that same question**
again. It may not ask the backup. After three unanswered asks it stops, moves the *order* to
`delivery_failed`, and leaves the attempt row exactly as it was: `unknown`, with no reason, because the shop
still does not know one.

**The obvious alternative.** A timeout is a failure. The call threw, the `catch` ran, there is an exception
object in hand with `TimeoutError` written on it; record `failed` and move on to supplier B, which is what a
backup supplier is for. Every retry library in every language ships this behaviour by default.

**What goes wrong, and it was measured rather than argued.** The shop's timeout is a deadline on *its own*
socket. When it expires, the shop closes its end of the connection. Nothing travels to the supplier. The
supplier's handler is still running, and it keeps running: it can claim a key, write that key into its
ledger, and finish answering into a connection that closed half a second ago. A throwaway measurement with a
handler that claims a key at 400 ms and a client that gives up at 200 ms
(`phase-3-slice-3-silence-is-not-failure.md` §2):

```
t+205ms  CLIENT: threw TimeoutError  => classified UNKNOWN
t+206ms  SERVER: socket aborted by the client
t+412ms  SERVER: KEY CLAIMED AND COMMITTED -> ledger=["KEY-0001"]
```

**The key was cut 206 ms after the client had already classified the call.** Whatever the shop decides at
t+205, it decides in ignorance of an event that has not happened yet. There is no client-side care that fixes
this — no longer wait, no better error handling — because the information does not exist at the moment the
decision is taken. So `failed` cannot be a description of what happened; the shop has no idea what happened.
What `failed` actually is, in this design, is a **licence**: permission to ask a *different* supplier for a
*second* key. That licence may only be issued when this supplier explicitly said no in a form the shop could
parse.

The classification the shop's supplier call makes, and the asymmetry is the whole design:

| The shop observes | It records |
|---|---|
| a readable success carrying the shop's own request id and a code | `ok` |
| a readable refusal with a reason the shop knows — whatever the HTTP status code | **definite** → `failed` |
| no response at all: timeout, refused connection, dead socket | **unknown** |
| a response whose body is not JSON | **unknown** |
| JSON in neither expected shape | **unknown** |
| a success echoing a request id the shop never sent | **unknown** |
| a refusal with a reason the shop does not recognise | **unknown** |

Every "cannot read it" lands on `unknown`. Only an explicit, parseable no lands on `failed`. The discriminator
is the *body*, not the status code — a refusal arriving with a `200` is still a refusal, and a `500` with no
body is still unknown. A timeout has no body at all, which is exactly why it cannot be read as an answer.

**The documentation said the opposite, in five places, for two phases.** The architecture, the supplier
configuration module, `.env.example`, the technical notes for this very phase, and — worst — an *agent
briefing*, the instructions handed to whichever agent next touches supplier timing, all stated the injected
hang as *shorter* than the shop's timeout. Staged that way there is no timeout: the supplier is slow, the shop
waits, the supplier answers, and the phase's headline check passes having exercised nothing. Measured against
the documented ordering: `NO TIMEOUT OCCURRED. A timeout check staged this way asserts nothing.` The agent
briefing is the worst of the five because a wrong rule there does not sit still and wait to be read; it gets
re-injected into the next piece of work (`…-slice-3-…` §2).

The correction was not a sign flip. The old sentence described a real and useful scenario — *a slow supplier
is not a failed one* — and was being cited as the basis for a different one. Both are worth having, and they
need opposite orderings:

| Scenario | Where the hang sits | Ordering | What it shows |
|---|---|---|---|
| Slow but successful | before the key claim, short | `hang < timeout` | nothing times out; the ladder never leaves its first rung |
| **The timeout trap** | **after the key claim commits, long** | **`timeout < hang < platform ceiling`** | a key genuinely cut, a client that cannot know it, and a re-probe that gets that key back |

`timeout < ceiling` holds in both rows and is the term the old chain got right: *a timeout must always be
observed as a timeout, never as a killed function*, because a killed function records nothing. The placement
became a column on the supplier stub, `hang_before_claim`, so a reviewer can stage either scenario without
rebuilding the shop — and a boolean rather than a three-way choice, because the key claim and its ledger
write are one transaction, so a hang is either before it or after it commits. The only third place anybody
would reach for is *inside* that transaction, and that one must never exist: it would hold the process's
single database connection for the length of the hang and stall every other request in it, including the
re-probe the trap is staged to observe (`…-slice-3-…` §2).

**The instruction that enforces it is an omission, so it has to be pointed at.** Two transactions, statement
for statement. When a supplier definitely refuses:

```
BEGIN;
  SELECT … FROM orders WHERE id = $1 FOR UPDATE;                  -- the row lock
  UPDATE issuance_attempts SET status = 'failed', last_error = $2
    WHERE request_id = $3;                                        -- record the no
  SELECT … FROM issuance_attempts WHERE order_id = $1 ORDER BY attempt DESC;
  -- compute the next rung from what was just read; act on it
COMMIT;
```

When a supplier goes quiet:

```
BEGIN;
  SELECT … FROM orders WHERE id = $1 FOR UPDATE;                  -- the row lock
  -- DELIBERATELY NO WRITE TO issuance_attempts.
  SELECT … FROM issuance_attempts WHERE order_id = $1 ORDER BY attempt DESC;
  -- compute the next rung from what was just read; act on it
COMMIT;
```

**The only difference is the missing `UPDATE`, and that missing statement is the phase in one line.** The
row was written as `unknown` *before* the call went out — every attempt row is born `unknown`; no row is ever
created in any other state — so when the call returns nothing, there is nothing truthful to change.

The same holds when the shop gives up. After the third unanswered ask, the order is moved with a guarded
UPDATE and the attempt row is not touched:

```sql
UPDATE orders SET status = $1, updated_at = now()
WHERE id = $2 AND status = ANY($3)
RETURNING …;
-- $1 = 'delivery_failed', $3 = '{delivering}'
-- 1 row  => this worker settled the order. It reads delivery_failed from now on.
-- 0 rows => the order was no longer in delivering — another worker settled it,
--           or delivered it. Nothing to do; NOT an error.
```

The attempt row still says `status = 'unknown'`, no reason, `probe_count` at its ceiling — **and that is the
record.** Writing `failed` there would be a claim nobody can support.

**Two facts, two tables, and a reviewer will press on this.** `orders.status = 'delivery_failed'` is a
statement **about the shop**: *we did not hand over a key.* `issuance_attempts.status = 'unknown'` is a
statement **about the supplier**: *we never learned what it did.* They coexist without contradiction because
they are different facts, and the retry in Keystone 3 reads the second one, not the first, to decide what to
do (`phase-3-slice-1-a-failure-you-can-see.md` §2, `…-slice-3-…` §3).

**What the shop gets for this.** Supplier A armed to claim a key and then hang for 2 500 ms against a
2 000 ms timeout, across four processes (`…-slice-3-…` §5):

```
one attempt row: a/1, status=ok, probe_count=2, code=LFXC-TNCS-BPCD
one supplier_requests row (provider a), one claimed key
zero b rows in issuance_attempts and supplier_requests
zero SupplierClient:b lines in the full process transcript
```

`probe_count = 2` is the fingerprint: one ask that timed out, one re-probe under the identical id, and A's
ledger handing back the key it had already cut. The last line is the hard rule holding end to end — B was not
merely not recorded; searched across the full transcript of all four processes, it was never *called*. With A
armed to hang three times, the shop asked three times, stopped after `6 102 ms` — three 2-second timeouts and
no fourth — and left the order `delivery_failed` with its attempt row reading `unknown`, no reason,
`probe_count 3`. And with the hang placed *before* the claim at 400 ms, nothing timed out at all: one attempt,
`probe_count = 1`, `delivered`. The two placements are genuinely different scenarios, not one scenario with a
dial.

**The honest bound.** This does not eliminate the loss; it bounds it. If a silent supplier did cut a key and
never says so in three asks, that key is claimed in its ledger under an id whose code the shop never received,
and no shopper will ever hold it. What is bounded is **at most one unaccounted key per outstanding
attempt** — and it is bounded by the fact that no other supplier is ever asked while that attempt is
outstanding. Give up immediately and the shop loses that key *and* tells the shopper nothing useful; fall
through and it loses that key *and* a second one (`…-slice-3-…` §7). The one thing that could still recover
it is an operator retry, which asks the same id again — Keystone 3.

*Depth: `phase-3-slice-3-silence-is-not-failure.md` §2, §3 (the two transactions), §5, §7;
`phase-3-slice-1-a-failure-you-can-see.md` §2 (two facts, two tables). The corrected ordering is
`architecture.md` §5.*

---

## Keystone 2 — asking the same supplier again is safe; asking a different one is not

**The decision.** Every question to a supplier is sent under an identifier computed from three facts — the
order, the supplier, and the attempt number — and from nothing else: `req_<order>_<supplier>_<attempt>`.
Nothing in the issuance path ever reads a stored id back in order to reuse it. A re-probe takes the supplier
and attempt number off the outstanding attempt row, recomputes, and gets a byte-identical string. A
fall-through picks the next untried supplier and `max(attempt) + 1`, and gets a new one.

| Rung | supplier | attempt | id |
|---|---|---|---|
| ask A for the first time | `a` | `1` | `req_x_a_1` |
| **re-probe** | same as the outstanding row | same | **byte-identical, recomputed** |
| **fall-through** | next untried | **`max(attempt) + 1`** | `req_x_b_2` |

So it is one rule with two readings, not two rules: **a re-probe changes none of the three arguments; a
fall-through changes two.** That is what makes re-asking the same supplier safe and asking a different one
not — and it is why the two cannot be confused by accident, because there is no id to confuse; there are only
three arguments (`phase-3-slice-2-a-backup-supplier.md` §2, `…-slice-3-…` §3).

**Why the same question is safe: the supplier's ledger.** Invariant I5 is the promise the assignment makes on
the supplier's behalf — *a repeat with the same `request_id` must return the same code* — and inside the stub
it is one read before any key is touched (narrowed by supplier in slice 3):

```sql
SELECT code FROM supplier_requests WHERE request_id = $1 AND provider = $2;
-- 1 row  => this supplier has answered this id before. Return THAT code,
--           however many times we are asked. No key is touched.
-- 0 rows => a new question. Claim a key, write the ledger, answer.
```

The promise is keyed on the string. One byte different and it is a new question, and a new question to a
supplier is answered the only way a supplier can answer it: by cutting a fresh key. Supplier B has never heard
of `req_x_a_1`, has no ledger entry for it, and cannot answer it with A's code. That is the whole reason a
fall-through *must* carry a new id — B asked under A's id would be asked to look something up in a ledger it
never wrote — and the whole reason a fall-through *must not* happen while A's attempt is `unknown`: A may
hold a key under `req_x_a_1`, B cuts a second under `req_x_b_2`, and two keys have left the pool for one
order.

**The obvious alternative.** Mint a random id at the top of the issuance path, store it on the attempt row,
and read it back when a retry needs it. It is what `issuance_attempts.request_id` looks like it is for.

**What goes wrong.** Correctness now depends on every future caller *remembering* to read it. There are four
callers in this phase alone — the automatic path, the re-probe, the fall-through, the operator's retry — and
the first one that reaches for a fresh random id instead issues a duplicate key with no error anywhere: the
supplier's ledger misses on an id it has never seen and claims a fresh key, exactly as designed. Deriving the
id means there is nothing to remember and nothing to forget. Attempt 1 for order `x` on supplier `a` is
`req_x_a_1` in every process, on every machine, forever. *The re-probe is recomputed, not remembered*
(`…-slice-2-…` §2).

### The attempt number counts per order, not per supplier — and the wrong version reads better

A per-supplier counter gives the fall-through `req_x_b_1`: attempt 1 at B, attempt 1 at A, which reads
perfectly in a log. It breaks later. Take an order both suppliers definitely refused, settled, and now being
retried by an operator. Per order, the ladder computes `max(attempt) + 1 = 3` and asks A under `req_x_a_3` —
a question nobody has asked. Per supplier, it computes A's next attempt as 1 and recomputes `req_x_a_1`:
**a re-probe of a settled question wearing a fall-through's clothes.**

And it fails silently, which is why it is dangerous rather than merely wrong. The statement that reserves an
attempt row before a question goes out is:

```sql
INSERT INTO issuance_attempts (request_id, order_id, provider, attempt, status, probe_count)
SELECT $1, orders.id, $2, $3, $4, $5
FROM orders WHERE orders.id = $6 AND orders.status = $7
ON CONFLICT (request_id) DO NOTHING
RETURNING request_id;
-- $4 = 'unknown' — always. A row is never born in any other state.
-- $5 = 1 — one ask.   $7 = 'delivering'
-- 1 row  => this question is reserved; send it.
-- 0 rows => an attempt row with this id already exists — a legitimate re-probe
--           of an outstanding question, OR a settled id being reused by mistake.
--           The statement cannot tell these apart, and neither can the caller.
```

The zero-row path is the honest one for a re-probe, so the code carries on. Under per-supplier numbering the
recomputed `req_x_a_1` collides with the settled row, is swallowed as if it were a re-probe, and the operator
presses retry again and gets the same nothing. No error, no log line, and the order can never be re-issued
(`…-slice-2-…` §2, R7).

**The instruction that makes that unrepresentable — and it catches what the id's own UNIQUE cannot.**

```sql
ALTER TABLE issuance_attempts
  ADD CONSTRAINT issuance_attempts_order_id_attempt_key UNIQUE (order_id, attempt);
```

`request_id` was already UNIQUE, and it has nothing to say here: it catches two rows carrying the same
*string*. This one catches a stored attempt number that has drifted from the string it appears in, and two
rows that differ only in the supplier segment. Proven against the running database inside a rolled-back
transaction — two rows for one order, both attempt 3, with two *different* id strings:

```
INSERT 0 1                              -- req_ord_proof_unique_a_3, attempt 3
ERROR:  duplicate key value violates unique constraint "issuance_attempts_order_id_attempt_key"
DETAIL:  Key (order_id, attempt)=(ord_proof_unique, 3) already exists.
```

The three-column version, `(order_id, provider, attempt)`, was what the plan first proposed and was corrected
before the migration was written. It would have accepted both rows above — `(x, a, 3)` and `(x, b, 3)` are
distinct triples — and `max(attempt) + 1` would have handed the number 3 out twice. A constraint that admits
the failure it was added to prevent is worse than none, because it gets quoted in reviews
(`…-slice-2-…` §2).

### The hard rule, enforced by the order the branches are written in

*Never fall through while any attempt for this order is `unknown`.* It is not implemented as a condition
somebody could forget. It is implemented as the order of the ladder's six branches:

```
1. no attempts                                         → ask A for the first time
2. any attempt not definitely settled, asks left       → probe it
3. any attempt not definitely settled, asks spent      → settle: never established
4. any attempt says ok                                 → rest; a code exists
5. every attempt a settled refusal, a supplier untried → fall through
6. every supplier refused                              → settle: refused
```

Branches 2 and 3 sit above branch 5, and **that placement is the enforcement**. An order with an outstanding
attempt cannot *reach* the fall-through branch. There is no ordering of these six that both honours the rule
and puts a settlement below a fall-through. Two details are load-bearing and easy to skim: branches 2 and 3
scan *every* attempt row, not the newest — a shop that checked only the newest would fall through past an
outstanding `a/1` the moment any later row existed; and `max(attempt)` is computed from the set, not read off
the first row of a sorted result, so the ladder has no invisible dependence on an `ORDER BY` in another file
(`…-slice-3-…` §3).

**"Definitely settled" is a negation, on purpose.** The guard asks *is this row `ok` or `failed`?* — not *is
it `unknown`?* The attempt row's status column is plain text with no database rule on its values,
deliberately, because the value set belongs to this policy and not to the schema. A row written by a future
migration, or by hand, with a fourth status would satisfy "not `unknown`" and unlock a fall-through past an
outstanding question. The negation makes *unrecognised* behave like *unknown*, which is the only reading that
cannot issue a second key.

**Proven by exhaustion, not by examples.** "Unrepresentable" is a claim about every input, so it is checked
against every input in a space small enough to enumerate: 96 distinct attempt rows built one axis per thing
the ladder looks at — and every axis includes a value the database can hold but this build does not recognise
(a supplier `c`, a status `in_flight`) — then every ordered history of 0 to 3 of them. Re-run while slice 3
was written (`…-slice-3-…` §3):

```
histories checked: 894049
histories containing an unsettled attempt: 781104
VIOLATIONS (unsettled -> anything but probe/settleNeverEstablished): 0
histories reaching fallThrough: 8152   — of those, fully settled: 8152
histories reaching probe: 260368
histories reaching settleNeverEstablished: 520736
```

Not vacuous: 8,152 histories *do* fall through, every one fully settled, and the test asserts each counter
is non-zero and that the total is exactly `1 + 96 + 96² + 96³`, so a refactor that shrinks the space cannot
pass by checking less. And it can fail — two mutants against the same space:

```
control (tree as it stands):                           VIOLATIONS = 0
mutant: guard reordered below fallThrough:             VIOLATIONS = 620336
mutant: "definitely settled" flipped to `!== unknown`: VIOLATIONS = 265560
```

Those two numbers also say *which* part is doing the work: the first is the branch order, the second is the
negation. The test writes its own copy of the predicate out longhand rather than importing the ladder's,
because a check that imports the definition it is checking agrees with that definition however it changes —
including into the flipped version the assertion exists to catch. When Keystone 3's retry added an input to
the ladder (a two-valued one; Keystone 3 names it `Fresh`), the space was doubled to **1,788,098** and re-run
under both values, still with zero violations, and a third mutant — the retry's branch moved above the
guard — produces **1,024** violations on the 9,216 two-row histories, the first of them
`[a/1 failed, b/1 unknown]`: a brand-new question to A while B may already hold a key
(`phase-3-slice-5-pressing-retry-twice.md` §4).

### Why the silence transaction opens a lock at all — and this is where Phase 2's lock became load-bearing

If the give-up path writes nothing about the attempt, why open a transaction? Because **the next rung must be
computed from rows read under the order row lock.**

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
neither is enough** (`…-slice-3-…` §3).

Phase 2 added that lock, measured that it changed nothing, and said so — and said this was the phase that
would make it matter. It is.

The probe's own bookkeeping goes in the same transaction, so the count that bounds the loop is committed
before the next pass reads it:

```sql
INSERT INTO issuance_attempts (…) VALUES (…, $5, $6, …)
ON CONFLICT (request_id) DO UPDATE
  SET probe_count = issuance_attempts.probe_count + $7
RETURNING probe_count;
-- $5 = 'unknown' — always.   $6 = 1, $7 = 1
-- 1 row => ALWAYS. Unlike DO NOTHING, DO UPDATE returns the row on both paths.
```

**`DO UPDATE` touches `probe_count` and nothing else, and the omission is the design.** On the probe path
the row may already say `ok` — the supplier answered the previous ask and another transaction wrote the code
while this worker had already decided to probe. A `SET status = 'unknown'` beside the increment, the obvious
thing to write with every other column right there, would erase the one fact worth having and un-deliver a
delivered order. It also counts **asks, not answers**, and runs *before* the call, so a process killed
mid-request leaves a truthful count with no `catch` having run. The accepted cost, stated rather than
discovered: a worker that dies before sending burns a probe (`…-slice-3-…` §3).

### Stock accounting — the assertion that sees a broken ladder, and where it must not be asserted

Weaken the hard rule — let a fall-through fire while an attempt is `unknown` — and run the four-process
check. Two assertions fail (`…-slice-3-…` §4):

```
FAIL  claimed keys == deliveries — {"claimedKeys":2,"deliveries":1}
FAIL  supplier B was never called — b rows=1
```

Now read what did *not* fail. The order still reported `delivered`. There was still exactly one delivery row.
**The shopper's key count never moved.** A's ledger had cut a key for `a/1` — still `unknown`, unaccounted
for — while B cut a second for `b/2`, and B's was the one delivered. Because `deliveries.order_id` is UNIQUE
(I3), no amount of ladder misbehaviour can produce two deliveries, so the shopper-facing assertion *cannot
fail*, which means it cannot pass in any meaningful sense either. The only place the second key shows up is
one count against another:

```sql
SELECT count(*) FROM supplier_keys WHERE claimed_by_request_id IS NOT NULL;  -- left the pool
SELECT count(*) FROM deliveries;                                            -- reached a shopper
```

That is functional spec §2.2's fifth criterion word for word. The transferable lesson: **the assertion that
catches a broken ladder is never the one about the shopper.** A suite that only asserts what the shopper sees
is green against a shop losing a key on every timeout.

And the equality is **not globally true**, which is the correction that would have been quietly wrong. On the
probes-exhausted path the measurement is `claimed_keys 2, deliveries 1` — and that is *correct*: a key
genuinely was cut, the shop asked three times and never learned the code, the order settled `delivery_failed`
with its attempt row reading `unknown`. That is the honest meaning of `unknown`, and it is exactly the loss
Keystone 1 bounds. So the equality is asserted on **settled outcomes only** — `delivered`, `out_of_stock`, a
definite `delivery_failed` — and on a never-established outcome the assertion becomes *at most one
unaccounted key per outstanding attempt, and the attempt row still reads `unknown` with no reason*. A check
that asserted the equality everywhere would fail against a correct system, and the temptation when that
happens is to "fix" the system (`…-slice-3-…` §4).

*Depth: `phase-3-slice-2-a-backup-supplier.md` §2 (the derivation, per-order numbering, the two-column
UNIQUE), `phase-3-slice-3-silence-is-not-failure.md` §3 (the branch order, the exhaustion, the negation, the
lock) and §4 (stock accounting), `phase-3-slice-5-pressing-retry-twice.md` §4 (the doubled space and the
third mutant). The exact ledger and key-claim statements are `architecture.md` §3.1 (I5, I6).*

---

## Keystone 3 — a purchase can be recovered long after it went wrong

**The decision, in four parts.** A paid order the shop could not deliver rests in a state a person may leave
(slice 1). Every such order appears in one list, immediately, with the fact that explains it (slice 4). One
button sends that order back into *the same issuance the payment took* — not a separate admin implementation
— so that everything which made the first issuance yield one key makes the retry do the same (slice 5). And
the shopper's page, which stopped on a failure, keeps looking, so the key appears without them touching
anything (slice 6).

**The obvious alternative, and it is four alternatives.** Call `delivery_failed` final, because it sounds
final. List only the orders that are "stuck". Build the retry in the admin module with its own lock and its
own duplicate check. Stop polling the page the moment the order stops moving. Each is the shorter version,
and each was measured to break something specific.

### Recoverable, not terminal — proven against a rule that did not exist yet

*Terminal* in this codebase is not a mood. It is the set that invariant I9's guarded UPDATE draws its
permitted source states from:

```sql
UPDATE orders SET status = $2, updated_at = now()
WHERE id = $1 AND status = ANY($3)   -- $3: the states this transition may leave FROM
RETURNING *;
-- 0 rows => the order was not in a state this transition may leave from.
```

A terminal status appears in no transition's *from* list, and a compile-time assertion fails the build if
anyone puts one there. So classifying `delivery_failed` as terminal would not *discourage* the retry — it
would make the retry's transition, `delivering` from `[out_of_stock, delivery_failed]`, refuse to compile.
Slice 1 proved that four slices before the retry was written: a throwaway file replicating slice 5's future
transition rule was typechecked under both classifications. Recoverable: exit 0. Terminal:
`error TS2344: Type '"delivery_failed"' does not satisfy the constraint 'never'.` The file was deleted; what
it bought is that slice 1's classification is *known* to be the one slice 5 needs
(`phase-3-slice-1-a-failure-you-can-see.md` §2).

The distinction to hold: **terminal means no transition is ever legal; recoverable means nothing moves it by
itself — a person does.** To a passive observer they are indistinguishable, which is why the contracts
package (the one set of shared definitions the API, the page and the checks all import) keeps three sets
and derives the third — settled is terminal plus recoverable — and why adding one status to the recoverable
list was the entire change: the page's stop condition, the payment processor's
"is there work left" test and the race suite's "is the shop finished" test all picked it up for free. That
derivation is also the trap the last part of this keystone is about.

### The list is wider than "stuck", and the reason is the one order nothing else can see

```sql
WHERE o.status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed')
  AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.order_id = o.id)
```

Two of those four are orders merely in flight, which will very likely deliver themselves in the next fifty
milliseconds. They are in the list anyway. Narrowing to the two an operator can retry is the obvious cleanup
and it would make the screen calmer — and it would hide **the one class of stuck order nothing else can
reach**: an order whose worker died between claiming it and writing the outcome. That order rests in
`delivering` for ever with an attempt row reading `unknown`. It is no longer in the inbox; no follow-up work
is scheduled for it; nothing automatic will ever touch it again. It is precisely this phase's failure mode —
the platform ceiling killing the function mid-ladder — and if this list does not show it, nothing does. For
the same reason there is no time predicate: *an order must appear immediately, without waiting for any
period to elapse* is a criterion, and a calm screen five minutes behind is worse than a busy screen that is
true (`phase-3-slice-4-finding-the-stuck-orders.md` §3).

The `NOT EXISTS` reads redundant with the status list and is not: there is a live path where a delivery row
commits while the `delivering → delivered` move matches zero rows because another worker got there first,
leaving a delivered order reading `delivering`. Constructed by hand and counted: 1 667 rows on the status
filter alone, 1 666 with the predicate, the constructed row listed zero times. Without it the operator
retries an order whose shopper is already holding the key.

Two more traps in the same statement, each of which produces a plausible screen and no error, both counted
on the same 1 666-order fixture (`…-slice-4-…` §3). The join to the newest attempt must be
`LEFT JOIN LATERAL … LIMIT 1`: the `CROSS` form silently drops the orders with no attempt row at all
(1 664 instead of 1 666), which are the most alarming rows on the screen — an order the shop *forgot* rather
than failed at; the plain `LEFT JOIN` multiplies (2 081), so the operator presses retry on the same order
three times. And the newest attempt is `ORDER BY attempt DESC`, never by timestamp, because two rows written
in one transaction carry the same timestamp and `LIMIT 1` picks between them differently on each run;
`UNIQUE (order_id, attempt)` from Keystone 2 is what makes `attempt` a total order.

**What the operator sees for a silent supplier, and the one-character bug that would lie.** On an order whose
supplier went quiet, nothing definite went wrong, so there is no reason to show — the reason column is
`NULL`, correctly. What the screen shows instead is the **outstanding request id**: a supplier was asked, the
shop never learned the answer, a key may or may not exist under this id, and the only thing that can still
find out is this id, asked again. The bug guarded against is `reason: lastError ?? "failed"` — it
type-checks, and it is wrong because the reason is `NULL` on two opposite outcomes, a supplier that said *ok*
and a supplier that never answered. This screen is the only place a person ever reviews that record, so
§2.2's fourth criterion — *never established, not failed* — is met or broken by this one cell, and a
friendly default would break it while every test stayed green. The defence is three independent facts rather
than one word, so there is no single slot for a default to fall into (`…-slice-4-…` §3). The field itself
rests on Keystone 2: an `unknown` row is always the newest for its order *only because* the ladder never
creates a row past an outstanding one.

The performance finding in the same slice is worth one paragraph because it runs against instinct. The list
is a per-order-latest-row problem, and that is where the review effort goes; three strategies for it came out
within 5 % of each other. The expensive part was a derived *paid at* — there is no `orders.paid_at` column,
deliberately, because every transition goes through one generic guarded UPDATE and a special case there is
the one thing that table exists not to have — evaluated once per listed row. In one plan with the indexes
dropped, the join everybody argues about cost **4 996** buffers and the *paid at* subquery beside it cost
**2 469 012**: `6 426 ms` against `11.9 ms` with the two partial indexes in place (`…-slice-4-…` §2).

### The retry is one call into the same issuance — and `409` is zero rows, not an `if`

The operator's whole retry, with the reporting stripped away, is one call into the identical claim-under-lock
and ladder walk the payment report takes. The operator's entry decides exactly one thing — **which
transitions this caller may claim the order with** — and nothing about the ladder, the supplier, the ids or
the settlement, because those are the same code for everybody. The rejected alternative is the one every
deadline reaches for: a parallel retry implementation in the admin module with its own lock and its own
idempotency check. It would be a second thing to get right and the first to drift. Every guarantee §2.5 asks
for — *pressing twice changes nothing*, *two operators get one key*, *a retry racing the automatic path is
safe* — is already a property of the row lock (I4), the guarded UPDATE (I9), the ledger (I5), the key claim
(I6) and `deliveries.order_id` UNIQUE (I3), and Phase 2 and slice 3 proved every one on this code.
**Reusing the code reuses the proofs.** The issuance module exports its runner and nothing else, so a second
path cannot be assembled from it even by someone trying (`phase-3-slice-5-pressing-retry-twice.md` §2).

**The instruction.** The operator's entry names two transitions, tried in order until one returns a row:

```sql
UPDATE orders SET status = $1, updated_at = now()
WHERE id = $2 AND status = ANY($3)
RETURNING …;
-- retryIssuance:   $1 = 'delivering', $3 = '{out_of_stock,delivery_failed}'
-- resumeIssuance:  $1 = 'delivering', $3 = '{delivering}'   -- only if the first matched zero rows
-- 1 row  => THIS caller claimed the order; walk the ladder.
-- 0 rows from BOTH => the order is not stuck. On the wire that is called 409.
```

Nothing on this path reads the status and decides whether to run. `409` is what *both matching zero rows* is
called, and it is the only way to produce one. The obvious version — a `switch` on the status the lock
returned — is one statement shorter and is the check-then-act this project argues against: the value was
true when the `SELECT` ran, the transition is written a statement later, and under this lock the window is
currently empty, which is exactly what lets the mistake survive review and then survive the day the lock
moves. Applied twice each against the live database: `retryIssuance` on an `out_of_stock` order returns one
row then zero; on a `delivered` order both candidates return zero. Reported from four processes with an order
in `payment_failed`: every guarded claim matched zero rows, the answer was `409`, `updated_at` unchanged,
zero attempt rows written. *Nothing ran* — not "nothing was reported to have run" (`…-slice-5-…` §2).

**`409` and `200 still_out_of_stock` are different news.** The first says *this order is not stuck; your
list was a few seconds old and somebody else got there first* — the system working. The second says *it is
stuck, the retry ran correctly, and every shelf is still empty* — the order stays in the list, and this is
the only one worth pressing again after a restock. A hurried implementation collapses them into one red
message.

**A transition whose guard excludes nobody, shipped anyway, with what actually contains it named.**
`resumeIssuance` is `delivering → delivering`. Applied twice to the same row, **both calls return a row.**
The guard matches every time, so it cannot be what keeps two operators to one key. It exists because without
it a stranded order — the worker died mid-ladder — can never be moved again by anything: every automatic
trigger claims from `paid`, which never matches `delivering`. Refusing the transition leaves a permanently
unrecoverable state in the phase whose subject is recovery. What actually excludes the second resumer is
(1) the row lock — both take it as the first statement, so one reads, decides and commits before the other
reads anything; and (2) the rung they both necessarily compute — a stranded order's outstanding attempt is
`unknown`, the ladder answers *probe*, and a probe writes no new attempt row, so the second reader sees the
identical ledger, computes the identical rung, and sends the identical id, which the supplier's ledger
answers with the code it already cut. Under real contention from two processes: one attempt row throughout,
`probe_count 1 → 2 → 3`, one ledger row, no second request id anywhere, one delivery, **unclaimed pool count
unchanged before and after**. The count moved twice because both resumers got through the guard, as they
must; the pool not moving says neither cut a new key. This is named as *fragile* (R3) rather than assumed
safe — it holds only while every concurrent resumer lands on *probe* — and it is kept as its own row in the
transition table so that its *from* list says in one line that its guard is not what protects it
(`…-slice-5-…` §3).

**The ladder could not serve a retry, and the proof had to grow.** The first retry attempt measured
`200 still_out_of_stock` with no new attempt row — against a pool with keys in it. The ladder had read "both
suppliers refused" as a verdict and re-settled the order without asking anyone. It read as correct because
`a` refused and `b` refused is the *same set of rows* whether written a millisecond ago by a walk still
running or a week ago by a walk that settled the order and went home — and the two need opposite answers.
The rows cannot carry that fact, so the caller does: one input, `Fresh`, passed by the operator's opening
turn and nothing else, read by exactly one branch, the last one, which under `Fresh` turns "every supplier
refused" into "ask again at `max(attempt) + 1`" — `a/3`, never a reused `a/1` (R7 again). **The `Fresh`
branch sits below the outstanding guard**: an order with an `unknown` attempt still probes and still settles
rather than asking anybody new. "The operator asked for it" is not a reason to obtain a second key for a
question whose outcome nobody knows. Slice 3's 894,049 histories had never once evaluated `Fresh` — the
input space had grown by an axis and the proof had not — so the space was doubled to 1,788,098, with zero
violations under either value and every one of the 6,272 "every supplier refused" histories converting to
"ask again" under `Fresh` (`…-slice-5-…` §4).

Two concurrent retries on a `delivery_failed` order, from two processes, both answered `200 delivered` — not
one `200` and one `409` — and that is correct. The loser's transaction ran after the winner's, read
`[a/1 failed, b/2 failed, a/3 unknown]` under the lock, computed a probe of `a/3`, and asked A the
byte-identical question, which A's ledger answered with the code it had cut for the winner. The loser holds
the right key; it simply was not the one that got to write it down. Telling that operator "failed" would be
the lie, and it would teach them to press again. A test asserting "one must `409`" would fail against a
correct system (`…-slice-5-…` §5).

**No timer, deliberately.** The obvious improvement is a cron entry re-walking the recovery list every thirty
seconds. A timer aimed at a failing supplier is how a small outage becomes a large one: every stuck order
retries on the same beat against a supplier already struggling, each leaves another `unknown` attempt, and
the next tick probes them all. So the affordance is absent from top to bottom — `POST` with no body, one
order id in the path, no "retry all", manual refresh. A person watching a supplier fall over stops pressing
(`…-slice-5-…` §2, R11).

### The page stops on *terminal*, not *settled* — a criterion that fails by definition while every test stays green

For two phases, "will this order move on its own?" and "can anything ever change what I am showing?" had the
same answer, because nobody could move a recoverable order. One predicate served both. Slice 5 gave the
operator a button that moves `out_of_stock` and `delivery_failed` back to `delivering` — and the page's stop
condition, unchanged, now read: *stop polling on exactly the two states an operator can move.* A shopper
looking at «Не удалось выдать ключ» would never see the retry land. Nothing is broken. Every test is green.
The requirement is unmet, because no test asks the question the requirement is about — every check in the
repository asks about the server, and the server was never wrong; §2.6's third criterion is a claim about a
browser tab somebody left open, and no test has a tab (`phase-3-slice-6-watching-recovery.md` §2, §3).

The RED made it literal: with the old condition restored, the shopper's page made **11 reads ending at
`t=9561 ms`** — the first read that returned `delivery_failed` — and no further reads, ever, while the
database showed the order `delivered` with a code. The fix is to stop asking the union and ask its two halves
separately: **stop** on terminal (nothing can ever move it); **keep reading every 5 s** on recoverable (it is
waiting on a person, not a worker); and **snap back to 1 s** the moment a read shows the order in flight, so
the recovery is watched at the beat the first attempt was — otherwise the `delivering → delivered` window,
25–65 ms, is invisible on a 5 s beat and the page jumps from failure straight to key. Wall clock, shopper's
tab untouched: nine reads at ~5 s, retry sent from a shell, «Выдаём ключ» painted, next gap **1 013 ms** —
the snap-back — then «Ключ выдан» with the code, 606 ms after the retry answered. The watch is bounded at
five minutes (A9); at 300 s the page says it has stopped and asks the shopper to refresh — the one message in
the shop allowed to say so, because it is the one moment «страница обновится сама» would be a lie
(`…-slice-6-…` §2, §4).

A wire flag — the server telling the page whether to keep polling — was rejected in Phase 2 as a second copy
of the classification with somewhere to drift to. This slice adds the stronger reason: the server's settle
rule is precisely the question the page must *not* ask. A flag derived from it would have encoded the bug.

*Depth: `phase-3-slice-1-a-failure-you-can-see.md` §2; `phase-3-slice-4-finding-the-stuck-orders.md`
§2–§3; `phase-3-slice-5-pressing-retry-twice.md` §2–§5; `phase-3-slice-6-watching-recovery.md` §2–§4. The
exact transition SQL is `architecture.md` §3.1 (I9).*

---

## Keystone 4 — every check went red, and what stayed green under every weakening

Not required by §2.8, and added for the reason Phase 2 gave: it is the only reason to believe the other
three. Functional spec §2.7's third criterion is Phase 2's, verbatim — *given a check has passed, when the
mechanism it defends is deliberately weakened, then that check reports a failure.*

**The decision.** Three new checks joined the harness — `recover-refusal`, `recover-timeout`,
`recover-out-of-stock` — and each was run against a build with its mechanism deliberately removed, the
removal confirmed in the built artefact before the result was read, and the source restored to the same hash
afterwards, `a5715427…86a24`, the same before and after every weakening. All three mechanisms live in one
file, the ladder, and each weakening was one branch of it
(`phase-3-slice-7-checks-a-reviewer-can-run.md` §4).

**The obvious alternative.** A green check is evidence.

**What was found.** No null result this time — every check went red: **6 of 18**, **5 of 16**, **9 of 25**
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
it; the follow-up read said *already reserved, carry on* — exactly what it says for a legitimate re-probe.
B issued. The success was recorded by request id, so it landed on **A's row**: `status: "ok"` with
`last_error: "supplier_rejected"` still on it — *a refusal that succeeded.* One key, one delivery, stock
accounting balanced to the unit. Nothing in the database distinguishes "the same id, asked again" from "a
different question sent under a stolen id"; `UNIQUE (request_id)` is satisfied either way, and the supplier's
ledger cannot tell a re-probe from a fall-through wearing a re-probe's clothes. **The id derivation is the
whole mechanism**, and the only thing that can see it broken is a check that reads attempt rows and request
ids rather than stopping at `delivered` (`…-slice-7-…` §4.2).

The timeout row is Keystone 2's stock-accounting argument measured on the shipped check rather than quoted,
with the same shape as slice 3's own RED. And the out-of-stock row is a regression test for a bug this phase
actually shipped and found — its RED output is that bug's signature word for word:
`"every supplier was asked and has nothing to issue"` reported against fifty unclaimed keys, with no supplier
called. If the check could not catch that, it could not catch the thing it exists to prevent recurring.

Three findings, and all three point at the place Phase 2's did: the assertions that catch a broken ladder are
about rows, ids and counts — attempt row count, the supplier and attempt on each row, which id has a ledger
entry, claimed keys against deliveries, and a `409` that is zero rows from a guarded UPDATE. All three
weakenings hit one pure function, which is not an accident of the exercise; it is why the ladder is a pure
function of recorded state in the first place (`…-slice-7-…` §4.3).

One more thing the slice fixed before it could go wrong: three checks, three authors, one supplier control
surface with three ways to arm it that look right and prove nothing. The control endpoint *replaces* the
row, so arming a hang without a duration is a hang of no length that never times out; a refusal is read
before a hang, so arming both spends the refusal and leaves the hang for whoever calls next; and the hang
after the claim is unconditional, so a hang against an empty pool stages the opposite of the trap. All three
live in one shared helper's header, so the fourth author reads them instead of finding them
(`…-slice-7-…` §3). And the same instinct, one slice earlier: slice 2 was planned with all failure injection
deferred, which left its own headline scenario — *a supplier that refuses* — unstageable; the verifier armed
A, watched the order deliver via A, reported BLOCKED, and refused to tick the box
(`phase-3-slice-2-a-backup-supplier.md` §4).

*Depth: `phase-3-slice-7-checks-a-reviewer-can-run.md` §2–§4; `phase-3-slice-3-silence-is-not-failure.md`
§4; `phase-3-slice-2-a-backup-supplier.md` §4.*

---

## The five adversarial scenarios, scored honestly

`context/product/product-definition.md` §1.4 lists five scenarios and calls them the definition of success.
**The double-click is not one of them** — it is Phase 2's headline and has its own check, `create-order`,
which defends the guarantee underlying all five.

| # | Scenario | Status after Phase 3 | Runnable as |
|---|---|---|---|
| 1 | 50 parallel `paid` reports for one order → one issuance fact, one key consumed | Settled (Phases 1–2); re-confirmed in slice 2 at 20 concurrent reports across 4 processes, not extended | `pnpm race webhooks` |
| 2 | A repeated report with the same `event_id` changes nothing | Settled (Phase 1) | `pnpm race same-event` |
| 3 | A report before its order, or out of order | Settled (Phase 2) | `pnpm race before-order` |
| 4 | An empty key pool leaves the order recoverable; after restocking, exactly one key | **Settled this phase.** Slice 1 made the state recoverable, slice 3 built the mechanism, slice 4 made the order findable, slice 5 is the retry — empty pool, `out_of_stock`, restock, one press, `a/3` issued, one delivery, one claimed key, the order gone from the list — and slice 7 made it runnable by name | `pnpm race recover-out-of-stock` |
| 5 | A promo code with limit N, under parallel requests, applied at most N times | Phase 5. Not started | — |

**Four of five settled and runnable by name.** The other two recovery checks cover functional spec §2.1
(`recover-refusal`) and §2.2 (`recover-timeout`) — requirements of this phase rather than numbered scenarios
of the assignment. §2.2 is the phase's central trap, the answer to the assignment's own «таймаут ≠ отказ»,
which is not one of the five but is the sentence the five are built around.

---

## What is not finished

- **The restock endpoint was specified and never built.** The technical notes describe
  `POST /internal/suppliers/keys`; no task scheduled it; nothing in the functional spec requires a
  wire-level restock. `recover-out-of-stock` restocks over direct SQL — un-claiming the exact rows it had
  itself claimed a moment earlier under a marker id of its own, the technique the schema reserves for
  tests. Every assertion is exercised; the wire affordance does not exist, and the check's header names the
  one place to point at it if it is built (`…-slice-7-…` §6).
- **Stock accounting is a bound, not a guarantee.** On a never-established outcome one key per outstanding
  attempt may be gone — claimed in a silent supplier's ledger under an id whose code the shop never
  received. The phase bounds that loss to one per outstanding attempt; it does not eliminate it, and a check
  asserting the equality everywhere would fail against a correct system (`…-slice-3-…` §4, §7).
- **The intermediate frame is probabilistic.** The snap-back cannot make a 25–65 ms window visible on a 5 s
  beat; two of the verifier's runs went from `delivery_failed` straight to `delivered`, and observing
  «Выдаём ключ» took a legitimately slowed supplier. The guarantee the criterion is about — the key appears
  with nobody touching the page — held every time (`…-slice-6-…` §4). This is Phase 2's timing-window
  caveat in its Phase 3 form.
- **No root `README.md`.** `architecture.md` §7 says the scenario-to-check mapping lives there. The table
  above is that mapping, waiting for Phase 6. The per-check aliases Phase 2 wrote down as missing now exist
  — all seven.
- **`resumeIssuance` is contained by the lock and by both resumers computing the same rung, not by its
  guard.** Stated in the transition table and as R3. Any future rung that writes a row a probe does not, or
  a ledger read moved out from under the lock, breaks it — and the only assertion that would notice is stock
  accounting (`…-slice-5-…` §3).
- **The shutdown bound now gives up on the longest legitimate walk.** A full ladder walk can take
  `3 × 2000 × 2 = 12 000 ms`; the process waits 3 000 ms for in-flight work on `SIGTERM` and then prints
  what it abandoned. The two constraints on that number became mutually exclusive, the premise of one turned
  out to be false (`docker stop` never signals this process; the real supervisor kills at 5 000 ms, which
  was exactly the old bound), and the one that gives is the recoverable, loud failure over the silent one:
  measured, 4 000 left 210 ms of headroom and 3 000 leaves 1 945. A bound whose one product is a log line
  must never lose the race to print it (`…-slice-3-…` §6).
- **`recover-timeout` costs about 2.4 s** — one real timeout — and could only be faster by making the
  spawned instances a different shop. **`recover-out-of-stock` has no HTTP-only half**: against a target
  whose database the reviewer cannot reach it skips entirely rather than printing a pass over three status
  codes (`…-slice-7-…` §6).
- **One stale comment slice 6 found and could not fix has since been fixed.** The wire type's header, which
  still described the old stop-on-settled rule when `…-slice-6-…` §5 was written, now states the
  terminal/recoverable split. Checked while writing this.
- **Out of scope by design:** the designed storefront (Phase 4), promo codes (Phase 5), public deployment
  (Phase 6), and automatic scheduled retrying (R11, deliberately absent).

---

## How to run the checks

```sh
pnpm race                              # all eight, against 4 freshly built local processes
pnpm race recover-timeout              # only the named one
pnpm race:recover-out-of-stock         # the same thing through the per-check alias
pnpm race --list                       # what exists; runs nothing, needs nothing running
RACE_BASE_URLS=https://…  pnpm race    # a deployed target: builds nothing, spawns nothing
pnpm test:concurrency                  # the Vitest suite behind slices 2, 3 and 5
```

Eight checks on four processes at ports 4601–4604: the five from Phase 2 plus `recover-refusal` (A refuses
its next call; the fall-through reaches B under a *new* id), `recover-timeout` (A hangs *after* its key
claim commits, past the timeout; the same supplier is re-probed under the *same* id and B is never asked),
and `recover-out-of-stock` (pool drained, order paid, pool restocked, operator presses Retry; the retry asks
again at `max(attempt) + 1`, and a second press answers `409`). Each arms, creates, pays and reads through
*different* instances, so a pass is evidence that a supplier behaviour written through one process is read
by another — which is what keeping that state in Postgres rather than in memory is for.

Reported: `pnpm race` twice in a row with no tidying between, **`8/8 passed against 4 instance(s)`** both
times; against one external URL, **`7/7 passed against 1 instance(s), 1 skipped`** — the recovery checks
*ran* (they need `ADMIN_TOKEN`, and a target answering `401` or `503` is reported as `SKIP`, subtracted from
both sides of the ratio, never `FAIL`), and the one skip is `before-order`'s, exactly as in Phase 2 — the report carries the ratio, not the
name; the slice infers the name from the skip mechanics (`…-slice-7-…` §1, §5).

---

## Where the depth is

| File | Read it for |
|---|---|
| `phase-3-slice-1-a-failure-you-can-see.md` | Terminal versus recoverable versus settled; the classification proven against a rule that did not exist; four tripwires that are four different questions; a CHECK widened in 4.5 ms with no table rewrite |
| `phase-3-slice-2-a-backup-supplier.md` | The derived id; per-order attempt numbering and the silent failure of the alternative; `UNIQUE (order_id, attempt)`; one shared pool and its stated cost; the planning error the verifier refused to tick |
| `phase-3-slice-3-silence-is-not-failure.md` | The 206 ms measurement; the inequality wrong in five places; the two transactions that differ by one missing `UPDATE`; the branch order proven over 894,049 histories and its two mutants; why the RED had to look away from the shopper; the shutdown bound |
| `phase-3-slice-4-finding-the-stuck-orders.md` | 4 996 versus 2 469 012 buffers; why the list is wider than "stuck"; three silent traps in one statement; the outstanding request id and the one-character bug it prevents |
| `phase-3-slice-5-pressing-retry-twice.md` | One call, no admin-only path; `409` as zero rows; a guard that excludes nobody and what contains it; `Fresh`, the doubled proof and the 1,024-violation mutant; two `200 delivered` responses that are not a double issue |
| `phase-3-slice-6-watching-recovery.md` | Settled and terminal parting ways; the RED that stopped at 9 561 ms; the snap-back; A9's five-minute window and the one place the copy rule flips |
| `phase-3-slice-7-checks-a-reviewer-can-run.md` | The three checks; the RED table and its "stayed green" column; the three ways to arm a supplier that prove nothing; skipping honestly against a deployed target |

Phase 2's own argument: `phase-2.md`. The nine invariants and the exact SQL for each:
`context/product/architecture.md` §3, §3.1; the corrected timeout ordering, §5. Requirements:
`context/spec/003-failure-and-recovery/functional-spec.md`.

**On evidence:** every number in this document is quoted from the slice walkthrough named beside it, which
records how it was captured and which of its numbers that walkthrough's author re-ran versus took from
another agent's report. Nothing was measured or re-run while writing this, and no source file was modified.
Five facts stated in "What is not finished" were checked directly against the tree as it stands:
`apps/api/src/issuance/issuance-ladder.ts` is at
`a5715427c387d7d27c9ac9d58a089dd1d68c80c6c9a762211e83972192b86a24`, the hash the RED table restores to;
`grep` for `suppliers/keys` over `apps/api/src` returns nothing; there is no root `README.md`; all seven
`race:*` aliases are in `package.json`; and the wire type's polling comment now states the
terminal/recoverable rule.
