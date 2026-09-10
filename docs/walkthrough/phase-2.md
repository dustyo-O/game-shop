# Phase 2 — one order per intent, one key per payment, and an answer that arrives first

> The phase-level walkthrough required by functional spec 002 §2.7. It makes the argument **once**; the six
> Phase 2 slice walkthroughs beside it hold the evidence, and every claim names the one that proves it.
> Nothing here needs the source code to follow.

## What this phase is for

Phase 1 built the purchase path and attached one promise to it:

> **A key that has been given to one shopper is never given to another.**

That promise held as long as the world behaved. Phase 2 is about the world not behaving. A shopper
double-clicks Buy because nothing happened fast enough, and opens the same purchase in a second tab. The
payment service reports one payment fifty times at the same instant — that is not a bug, it is how such
services guarantee a report is never lost — and one of those reports can arrive *before* the shop has
finished writing down the order it refers to. Each of those produces two orders for one intent, or two keys
for one order, or a paid order with no key, in a shop that reads perfectly correctly one request at a time.

Four things were built:

1. **One order per purchase attempt**, however many times the shopper clicks (`phase-2-slice-1-…`).
2. **An answer to the payment service that arrives before the work is done** (`…-slice-2-…`), which is what
   made the out-of-order handling (`…-slice-3-…`) and the watchable order page (`…-slice-4-…`) possible.
3. **A row lock in front of the order transition** (`…-slice-5-…`), which today changes nothing and is
   honest about that.
4. **Checks a reviewer runs themselves** — `pnpm race` (`…-slice-6-…`).

The first two are two of the three keystones §2.7 asks for; the third keystone lives inside the second. The
fourth is not on that list and is added anyway, because it is the reason to believe the other three.

---

## The words this document uses

Everything below is explained where it first matters, but seven terms recur often enough to be worth
collecting.

- **Webhook.** The payment service calling the shop back, unprompted, to report that a payment happened.
  The shop does not ask; it is told. The service promises to deliver each report *at least* once, which
  means it may deliver it many times and in any order.
- **Serverless functions.** The shop's API runs as short-lived processes, one per request, with no shared
  memory. Two simultaneous requests are two separate operating-system processes: a flag, a lock or a `Map`
  in one **does not exist** for the other. This is why such a guard passes every test on a laptop and
  evaporates in production, and why every guarantee below is enforced by the database — the one thing the
  two processes share.
- **A transaction** is a group of database statements that all take effect or none do. Until it finishes,
  no other session may change a row it has written.
- **The supplier** is the outside service the shop buys game keys from, reached over HTTP. In this project
  it is a stub with a pool of fifty keys, and it behaves like the real thing: it can be slow, and it can go
  quiet mid-request.
- **Issuance** is the shop's word for the whole act of getting a key from the supplier and binding it to one
  order. It is the part that spends money and cannot be taken back, which is why most of this document is
  about who is allowed to start it.
- **UNIQUE and PRIMARY KEY** are rules Postgres enforces on every write: no two rows may hold the same value
  in the named column. Postgres refuses the second one. `ON CONFLICT (column) DO NOTHING` attached to an
  insert says *if that refusal happens, do not raise an error — just write nothing and tell me you wrote
  nothing.*
- **"Zero rows" is a normal answer, not an error.** Every statement below changes rows only if a condition
  still holds *at the instant the database checks it*. One row back means "you did it"; zero means "somebody
  else already did, or it was never yours". Reading zero rows as a failure is the single most common way to
  turn a harmless race into an outage, and Keystone 2 below is exactly what happens when you do.

Two more, used only where they belong. A **status-guarded UPDATE** is a write that names the states it is
allowed to move an order *from*, so the database and not the application code decides whether the move is
legal. And `context/product/architecture.md` §3 keeps a numbered list of nine such guarantees, referred to as
**I1** through **I9**; this phase leans on I1 (one purchase attempt, one order), I2 (one payment report
applied once) and I4 (only one worker advances an order).

---

## Keystone 1 — the shop can tell a repeated click from a second purchase

**The decision.** Every Buy click carries a **name for the shopper's intention** — an `Idempotency-Key`
header, a random identifier minted once per item and kept in the browser's `localStorage` — the one browser
store that two tabs of the same site share, and that survives a reload. The shop stores that name on the
order behind a UNIQUE rule. Two requests carrying the same name can only ever produce one order; the second
is answered with the first one, silently.

Two halves, and the second is the one that takes the thinking.

**The obvious alternative, part one: hash the request body.** Take `sha256({"sku":"KEY-CS2-PRIME"})` and use
that as the name. It needs no cooperation from the browser at all, which is exactly why it is tempting.

**What goes wrong.** Two deliberate purchases of the same game have byte-identical bodies. A content hash
calls the second one a duplicate and hands back the first order — complete with the key the shopper already
owns. You have built a shop that can sell each game to each shopper **exactly once, forever**
(`phase-2-slice-1-one-order-per-intent.md` §2). The lesson is one sentence: *the same content is not the
same intent.* Only the client knows whether this is a retry or a new decision, so only the client can name
it; the server's job is to enforce that one name produces one order, not to guess what the name should be.

**The obvious alternative, part two: mint the name in the click handler.** `createOrder(sku, crypto.randomUUID())`.

**What goes wrong, and this is the part that is invisible.** The server is now perfect — the UNIQUE rule is
right, the conflict clause is right, the read-back is right — and **a double-click still buys two copies**,
because two clicks mint two names, and two different names are two different intentions by definition. The
key names *the click* instead of the purchase. Worse, every scripted check still passes: a `curl` test that
sends one key twice supplies the key the browser never reuses. The mechanism looks like it works, protects
nothing, and the suite is green (`…-slice-1-…` §3). That is why this criterion can only be verified by a real
double-click in a real browser with the resulting order count read out of the database — two scripted
requests cannot fail this test, which means they cannot pass it either.

Three smaller decisions fall out, each with a cost stated rather than hoped away (`…-slice-1-…` §4, §5):

- **`localStorage`, not `sessionStorage`.** `sessionStorage` is per tab by specification, and one of the
  criteria is that two tabs on the same purchase produce one order. The assumption being made out loud:
  *two tabs buying the same item at the same moment are one intent, not two.* The cost of being wrong is one
  shopper getting one order when they wanted two simultaneously; the cost of the opposite choice is a
  shopper charged twice. Only one of those is a shop nobody trusts.
- **The name is cleared on exactly one event** — the create request having *resolved* with an order id in
  hand. Cleared any earlier and a click that appeared to fail (but succeeded at the server, with only the
  response lost) mints a fresh name on the retry and buys a second copy. Cleared any later, or never, and a
  shopper buying the same game a second time is handed their first order back.
- **255 characters, and the limit was measured rather than assumed.** The column is indexed, and a Postgres
  index entry cannot exceed roughly a third of an 8 kB page: a 3200-character key produced
  `ERROR: index row size 3216 exceeds btree version 4 maximum 2704`. The non-obvious half is that a *long
  but repetitive* key inserts fine, because Postgres compresses it first — so the values that hit the
  ceiling are precisely the *good* keys, since a good idempotency key is random and random data does not
  compress. Without a check at the door, a well-behaved client can turn the constraint protecting it into a
  `500`.

**The instruction that enforces it.** Order creation is still exactly one statement. It copies the price out
of the catalogue column-to-column — no client-supplied amount ever participates — and carries the conflict
clause:

```sql
INSERT INTO orders (id, client_request_id, sku, amount_minor, currency, status, created_at, updated_at)
SELECT $1, $2, sku, price_minor, currency, $3, now(), now()
FROM products
WHERE products.sku = $4 AND products.purchasable = $5
ON CONFLICT (client_request_id) DO NOTHING
RETURNING id, sku, amount_minor, currency, status;
-- $1 the order id, $2 the Idempotency-Key (NULL if the client sent none),
-- $3 the literal 'created', $4 the SKU from the request body, $5 true.
-- 1 row  => THIS request created the order. 201.
-- 0 rows => two possible causes, and they must not be conflated (below).
```

Nothing in the application ever asks *"have I seen this name before?"*. That question is a check followed by
an act, and two overlapping requests both answer "no" and both insert. The UNIQUE rule is the first and only
place the two attempts meet, so the index picks the winner and the code only reads the verdict.

**What zero rows means here — two things, and conflating them is wrong in both directions.** Either the name
already made an order (a legitimate retry), or the item is not purchasable (a rejection). A follow-up read
tells them apart, and it runs only on the zero-row path, so the happy path is still one round trip:

```sql
SELECT … FROM orders WHERE client_request_id = $1;
-- 1 row  => this name already named a purchase. Return that order with 200.
-- 0 rows => the name was new, so the conflict clause was never reached:
--           the item is not purchasable. 422.
```

Treat every zero-row as a conflict and a bad item code is answered with somebody else's order. Treat every
zero-row as a rejection and a retrying shopper gets a `422` for an order that already exists, with their
money gone and no page to look at. The specific bad case the split prevents: a shopper retries, and in the
meantime the item was withdrawn from sale, so the insert now fails for *both* reasons at once. The read-back
finds the order and returns `200`. **A `422` never displaces a `200`.**

**And the read-back cannot miss a winner that is about to commit.** This is the question a good interviewer
asks, and the answer is structural rather than lucky. The worry is that request B loses the conflict, gets
zero rows, reads back, and A's row is not committed yet — so B sees nothing and answers `422` for an order
that is about to exist. That window does not exist, and not because it is narrow. When the row an insert
collides with belongs to a transaction that has not finished, Postgres neither fails nor skips: it **waits**
for that transaction to end and then looks again. If A aborted, the collision is gone and B inserts and wins.
If A committed, B gets zero rows *and A's row is now committed* — so B's follow-up read takes its snapshot
afterwards and cannot miss it. There is no ordering of events in which the loser sees nothing
(`…-slice-1-…` §8). No retry loop, no sleep, and deliberately no transaction wrapping the pair.

*Depth: `phase-2-slice-1-one-order-per-intent.md`, all sections; the exact SQL is `architecture.md` §3.1 (I1).*

---

## Keystone 2 — a report the shop has already handled is answered "yes, thank you", not "error"

**The decision.** The status code the shop returns to the payment service is **an instruction, not a
description.** That service is a machine with a retry policy keyed on it, so the only question worth asking
about any response is: *do I want these exact bytes again?* Three lines, no exceptions
(`phase-2-slice-2-answer-then-work.md` §2):

| Answer | Instruction to the payment service | When |
|---|---|---|
| `5xx` | "Send it again." | Exactly one case: the shop could not write the report down. |
| `400` | "Sending it again will not help." | A body that can never become a row. |
| `200` | "We have it; stop." | Everything else — **including a duplicate, and including things that went wrong afterwards.** |

**The obvious alternative.** Answer a duplicate with an error, because it *is* a duplicate — `409 Conflict`
reads like the honest answer — and let a failure during processing become the `500` it naturally is if you
simply do the work and do not catch.

**What goes wrong.** A `5xx` is a request for redelivery, so an error on a duplicate is a self-sustaining
loop that can never fix anything:

1. The service treats the error as "they did not get it" and redelivers on a backoff schedule.
2. The redelivery is a duplicate too, so it gets the same error.
3. The retry is **guaranteed** to change nothing. Nothing about the passage of time turns a duplicate into a
   first sight, and the thing that failed had nothing to do with receiving the report — the row was durable
   from the first millisecond.
4. The error rate looks like an outage, the endpoint gets marked failing on the provider's dashboard, and
   some providers disable a webhook that fails for long enough. Because of one bad issuance.

**The instruction that enforces it.** The report's own identifier is the table's PRIMARY KEY, and the insert
carries the conflict clause:

```sql
INSERT INTO payment_events (event_id, order_id, status, amount_minor, currency, payload)
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT (event_id) DO NOTHING
RETURNING *;
-- 1 row  => FIRST SIGHT of this report. Exactly one caller ever sees this,
--           across every process. Process it.
-- 0 rows => we have seen this report before. Acknowledge 200 and do nothing.
```

**What zero rows means here is the whole mechanism, not a side effect of it.** Winning that insert *is*
"first sight"; losing it *is* "duplicate". There is no separate detection step to get wrong, no `SELECT`
beforehand, and no window between checking and acting for a second copy to slip through. The conflict target
is **named** (`event_id`) rather than left bare, so this clause forgives exactly one constraint — a future
`NOT NULL` or `CHECK` failure still raises, instead of being silently reported to the provider as a
duplicate.

**The evidence is a RED validation, and it failed in two independent ways at once.** In Slice 6 that single
`ON CONFLICT (event_id) DO NOTHING` clause was deleted from the source, the code rebuilt so the running
processes actually executed it, and one report delivered twenty times at once
(`phase-2-slice-6-checks-a-reviewer-can-run.md` §4.1):

```
race:same-event, with ON CONFLICT (event_id) removed:
  HTTP 500 × 19 of 20
  outcome assertion: stored=1, duplicate=0, unrecognised=19
```

The `500`s say the *acknowledgement* broke — nineteen of twenty redeliveries got an error, which is exactly
how the retry storm above starts. The `duplicate=0` says the *classification* broke: without the clause the
shop can no longer tell "first sight" from "already seen" at all. A check that only counted database rows
would have caught half of it.

The one case that genuinely deserves a `5xx` is preserved exactly and is the only path in the module that
produces one: a failing insert is logged with both identifiers and **rethrown**. The database was
unreachable, the report is durable nowhere, and the shop sincerely wants it again.

**The same rule, one layer down, is why an early report is stored rather than refused.** `payment_events`
deliberately carries **no foreign key** to `orders`, and the two tables ten lines away
(`deliveries`, `issuance_attempts`) do — so the absence reads as a decision rather than an oversight. The
rule is *who can write this row before the order exists*: a delivery row is only ever written by code that
has already read the order, so a dangling reference there is a real bug; a payment report is written by a
stranger, on a different connection in a different process, with no ordering guarantee against the shopper's
own request. Add the "obvious" foreign key and an early report raises an error, the endpoint returns `5xx`,
the provider retries, the order still does not exist a hundred milliseconds later — and a race that cost
nothing has become an on-call incident (`phase-2-slice-3-out-of-order.md` §1). The general shape is worth
naming: **a constraint is a statement about what rows may exist, and it is retroactive.** Adding one is never
a local change.

Storing the report correctly is not the same as handling it, though, and Phase 1 had only the first half. An
early report sat with nothing coming back for it — *a durable queue with no consumer is a log file with
ambitions.* Phase 2 added four independent triggers that pick such reports up (a **sweep**, in the table
below, is a pass over the stored reports that picks up anything nobody finished with), and the reason there
are four is that each of the first three is attached to something happening, which is simultaneously what
makes it useful and what makes it insufficient (`…-slice-3-…` §3):

| Trigger | Fires when | Therefore cannot fire when |
|---|---|---|
| the webhook's own follow-up work | a report arrives *and* the process survives long enough | the process is recycled between the `200` and the work |
| a sweep when an order is created | the order is created **after** the report arrived | the report arrives after the order |
| a sweep when the shopper's page polls | somebody has that order's page open | nobody is looking |
| an operator's sweep | an operator asks | — |

The fourth requires nothing, which is not a weaker property — it is the only one that makes the set closed.
Compose the first three gaps and you get an ordinary story: a shopper pays, closes the tab, and the instance
handling the webhook is recycled between the `200` and the work. Money taken, no key, and every automatic
mechanism has legitimately already run and legitimately found nothing to do.

*Depth: `phase-2-slice-2-answer-then-work.md` §2, `phase-2-slice-3-out-of-order.md` §1–§3,
`phase-2-slice-6-checks-a-reviewer-can-run.md` §4.1; exact SQL `architecture.md` §3.1 (I2).*

---

## Keystone 3 — the shop answers first and does the work afterwards

**The decision.** The webhook endpoint now does three things and stops: parse the body far enough to write a
row, insert it into the inbox — the `payment_events` table of Keystone 2 — and hand the remaining work to a
scheduler that runs it **after** the response has gone out. The order is
*receive → persist → acknowledge → process*, and only the first two are the provider's business.

**The obvious alternative.** Do the work and then answer, which is what Phase 1 did and what almost every
tutorial does. It is simpler, it needs no scheduler, and on the happy path it is indistinguishable.

**What goes wrong, and this is the sentence to remember: being slow *manufactures* the concurrency you then
have to survive.** The failure needs no failure at all. Suppose the work takes eight seconds and the
provider's read timeout — how long it waits for a reply before giving up on the connection — is five. The
provider never *hears* the `200`, so it redelivers — and now two copies of one report are in flight against
the same order at the same instant, created by nothing but the shop's own
latency (`phase-2-slice-2-answer-then-work.md` §2). The second failure mode is the retry loop of Keystone 2:
awaiting the work means a failure in it becomes the response, and the response is an instruction to send it
again.

**The measurement.** The supplier was replaced with a stub that accepts the connection and never answers,
and the supplier timeout raised to 30 s so the work could not possibly finish:

```
ack: {"event_id":"evt_01M1Z47BW9P42XBH6XJHB2DZZ1", … "webhook_outcome":"stored"}
payment response took 72 ms
order now: {"id":"ord_01M1Z47BSDK3W8HKFQ6ZGBP0Y8", … "status":"delivering","code":null}
```

**72 ms to answer, with the work still hanging on a supplier that will never reply.** In Phase 1 that same
request would have sat there for the full supplier timeout and then answered.

There is a structural gain hiding in that, and it is worth stating: the handler **can no longer report how
the work went**. There is no `try`/`catch` left in it and no place for one. In Phase 1, "a duplicate is a
`200`" and "a processing failure is still a `200`" were decisions the controller made and could have got
wrong. Now they are unreachable: by the time the work can fail, the response is gone and there is no status
code left for it to influence, even in principle.

### What a tracked scheduler guarantees that fire-and-forget does not

The obvious way to run work after the response is to call it and never look back — in this language, one
line: `void this.process(event)`. It compiles, passes review, and is correct about the happy path. It is
wrong about three specific moments (`…-slice-2-…` §3, §4). "Continuation" below just means *the work that
continues after the response* — the thing handed to the scheduler; the scheduler is "tracked" because it
keeps a record of every continuation still running, and that record is the whole difference.

- **A `SIGTERM` mid-flight** — a deploy, a container recycle, a Ctrl-C. A floating promise dies with the
  process and, expensively, *nothing anywhere records that it did*. The report stays unfinished, which is
  recoverable by construction, but the shop cannot tell "nobody has started this" from "somebody started it
  and was killed at 14:03". The tracked scheduler leaves a line, produced for real by sending `SIGTERM`
  while the hung supplier held the work open:

  ```
  ERROR shutdown: gave up waiting for continuations; their work is left pending
        in the inbox for a later drain
    abandoned: 1, waited_ms: 5001, timeout_ms: 5000,
    continuations: [ { order_id: 'ord_01M1Z47BSDK3W8HKFQ6ZGBP0Y8',
                       event_id: 'evt_01M1Z47BW9P42XBH6XJHB2DZZ1' } ]
  ```

  ("Drain" is the codebase's word for the sweeps in the table above — a pass over the inbox that picks up
  reports nobody finished with. Three of the four triggers are drains.)

  **The naming is the entire difference.** The in-flight collection maps each promise to its context rather
  than being a counter, because "three continuations were lost" is not actionable and "these three orders and
  these three reports were lost" is. And the state left behind is exactly what the log promises: order in
  `delivering`, report still unfinished in the inbox, the supplier attempt recorded as `unknown`.
- **A rejecting continuation.** A floating promise that rejects is an unhandled rejection, and Node 22's
  default for those is to **terminate the process** — one failed piece of work taking out an instance in the
  middle of serving other people's requests. Every unit of work goes through a guard that never rethrows.
- **An unbounded wait.** `await` everything with no limit and one continuation stuck on a socket that never
  closes turns every Ctrl-C into a Ctrl-C followed by `kill -9`, and every deploy into a wait for the
  orchestrator's patience — after which the work dies anyway, later and with no log line. The bound is
  **5 seconds**: above the longest legitimate continuation (one supplier call, capped at 2000 ms locally,
  plus a few short statements) and below the tightest grace period anything gives before `SIGKILL`
  (`docker stop` kills 10 s after asking). A bound you never live long enough to report is not a bound, it
  is a delay.

None of that is promised as a guarantee, deliberately. Four independent triggers exist precisely so that no
single one is load-bearing: **a dropped continuation costs latency, never a key.**

**The instruction that catches whatever a continuation dropped.** The sweep claims one unfinished report at
a time:

```sql
SELECT * FROM payment_events
WHERE processed_at IS NULL
ORDER BY received_at
FOR UPDATE SKIP LOCKED
LIMIT 1;
-- 1 row  => THIS worker claimed that report.
-- 0 rows => nothing is waiting, OR every waiting report is held by another
--           worker. Both mean "not my work". NEITHER IS AN ERROR.
```

`FOR UPDATE SKIP LOCKED` means *take the first row nobody else is holding, and if one is busy step past it
rather than queue behind it*. Two sweeps reaching for the inbox at the same instant never take the same row.

The honest limit is worth volunteering rather than being caught by: **that hold ends when the claiming
transaction commits.** So what the claim buys is *dispatch exclusion* — two workers reaching for the queue
at the same instant never take the same row — and not *durable ownership*, which would mean nobody else may
touch that report until this worker is done. A sweep starting a moment later can re-take a report whose
processing is still in flight. That is safe because nothing about correctness
rests on the claim; every write the processing makes is adjudicated by Postgres against the row itself. The
measurement makes the point numerically: **30 claims for 12 reports across 3 processes produced exactly 12
supplier calls** (`…-slice-2-…` §6). Thirty-for-twelve means re-claiming genuinely happened, repeatedly.
Twelve supplier calls means it cost nothing. A design where the claim *were* the exclusion would have needed
those two numbers to be equal — and would have had to hold a database transaction open across an HTTP call
to the supplier to make them equal, which stalls every other statement in that instance for the length of
the call.

### The consequence nobody predicted: the shopper can now watch

Spec 001 promised the order page shows each stage as it happens. That promise had to be **reworded down**
during Phase 1 verification, with a dated change-log entry, because the whole chain finished inside the
webhook request and nobody could see `paid` or `delivering`. Phase 2 restored the original wording, with a
second dated entry.

The natural explanation for why is wrong, and the measurement caught it before the prose could be written
(`phase-2-slice-4-watching-the-stages.md` §1). The stages did **not** get longer:

| Measured, webhook `200` → `delivered` | Phase 1 | Phase 2 |
|---|---|---|
| direct API probe, no browser involved | ~19–60 ms | **25–65 ms**, across 5 samples |

If anything the window is a hair wider, and a hair is not what turns an invisible state into one that nine of
nine shoppers see. What changed is **when the shop answers**. In Phase 1 a page that refreshed itself on
hearing the `200` was already too late — by the time that answer existed, the order was delivered. Now the
same refresh fires at the *start* of the work and lands inside the window. Same duration, different vantage
point. Nine real purchases in a browser observed the intermediate state 9 times out of 9, held on screen for
1000–1060 ms, with one page load and no reload.

The most convincing number there is the **4/5 split**: four of the nine showed "Оплачен, готовим ключ"
("paid, preparing your key" — the shop's text is Russian) and five showed "Выдаём ключ" ("issuing the key").
A page animating a scripted sequence would show the same label every time. That
the label varies is the fingerprint of a genuine race being sampled — sometimes the read lands before the
order moves, sometimes after. Nobody chose which.

Two ways of making the stage appear more reliably were available and both rejected. **Slow the shop down** —
a fine diagnostic and a dishonest fix, spending the shopper's time to buy a progress indicator. **Paint the
stage optimistically in the page** the instant the button is pressed, which most storefronts do: it would
produce the stage 100% of the time, and it would show "Оплачен" ("paid") for a payment that just *failed*,
because the failing payment control also resolves. It would also break the one claim the whole architecture rests on —
the server decides what state an order is in and the page reports it.

*Depth: `phase-2-slice-2-answer-then-work.md` §1–§7, `phase-2-slice-4-watching-the-stages.md` §1–§4, §6.*

---

## Keystone 4 — every check was deliberately broken before it was believed

This is not in §2.7's required three, and it earns its place because it is the only reason to trust the
other three. Spec 002 §2.6 states it as an acceptance criterion: *given a check has passed, when the
mechanism it defends is deliberately weakened, then that check reports a failure — so a passing check is
evidence rather than decoration.*

**The decision.** For every claim in this phase, the mechanism was removed from the source, the code rebuilt
so the running processes actually executed the weakened version, the check re-run, and the file restored and
confirmed byte-identical. This is called a RED validation: *watch it fail before believing it passes.*

**The obvious alternative.** A green check is evidence. Everybody ships this.

**What goes wrong** is not that the checks are weak — it is that **you do not find out which promise each
check actually guards.** Three findings came out of doing it, and all three contradicted an assumption a
careful reader would have made from reading the source.

**Finding one — a weakening that produced no failure at all.** The fifty-parallel-webhooks check names the
**key claim** among the mechanisms it defends. The key claim is the one statement inside the supplier that
finds an unclaimed key, locks it and marks it as belonging to this request, with no gap between finding and
marking. That statement was gutted — its `FOR UPDATE SKIP LOCKED` removed, leaving an ordinary read followed
by a separate write, with exactly the gap the single statement exists to close — and the check **passed, 8
assertions of 8**, against a build confirmed weakened
(`phase-2-slice-6-checks-a-reviewer-can-run.md` §4.3). Not a stale build: a real null result, with an exact
reason. That check fires fifty reports at **one** order, and only one worker is ever admitted to issuance,
so the key claim is *called once* in the entire check. There is no concurrency there for the weakening to
expose. Meanwhile the weakening is catastrophic, which the separate concurrency suite showed against that
same build, because it pays many orders in parallel:

```
AssertionError: N distinct keys — no code handed to two orders: expected 10 to be 20
AssertionError: exactly one order settles per available key:    expected 55 to be 50
```

Ten of twenty shoppers holding a key somebody else also held; fifty-five orders delivered from a fifty-key
pool. So the check that guards the key claim is the concurrency suite, and the fifty-webhook check guards
only the rule that one worker advances one order — which is what its own header says and all it should ever
be credited with. **Nothing except running it would have told us.**

**Finding two — the guard is not what makes the key count one.** The status-guarded UPDATE that admits one
worker to issuance was widened so that fifty workers could all claim the same order. All fifty walked to the
supplier. And the shopper **still received exactly one key**, with every named assertion passing
(`…-slice-6-…` §4.4). Because the identifier the shop puts on its request to the supplier is computed from
the order itself, so all fifty workers asked the supplier the *same question*. The supplier keeps a ledger —
a table of `request_id → code` it consults before touching a key — so it answered all fifty with the *same
code*. And the UNIQUE rule on `deliveries.order_id` let that code be bound to the order exactly once.
**The ledger and that UNIQUE rule are what make the key count one. The guard's job is stopping forty-nine
workers from reaching the supplier at all** — measurable as `1` versus `50` lines of "claimed the order for
issuance" in the logs. The check did report the breach, three runs of three, but through its
*cleanup* failing rather than through any assertion it makes. That is a genuine limitation, written into the
harness README rather than filed off: a check whose failure signal arrives via a foreign-key violation in its
teardown is a check that got lucky.

**Finding three — a lock that changed nothing, reported as nothing.** Phase 2 added the `SELECT … FOR UPDATE`
row lock that completes I4. **The instruction, both halves of it.** The lock takes the order row for the
length of the transaction, so no other worker may read-for-update or write it meanwhile; the status-guarded
UPDATE beside it names the one state the order is allowed to move *from*:

```sql
BEGIN;
SELECT … FROM orders WHERE id = $1 FOR UPDATE;
UPDATE orders SET status = 'delivering', updated_at = now()
WHERE id = $1 AND status = ANY($3)   -- $3 is the permitted source states: {'paid'}
RETURNING …;
-- 1 row  => THIS worker claimed the order, and it is the one that calls the supplier.
-- 0 rows => somebody else already advanced it. This worker does nothing.
COMMIT;
```

That is the statement Finding two widened (`$3` given `{'paid','delivering'}`, so fifty workers all matched)
and the statement whose `FOR UPDATE` this finding removed. The RED validation **came back green**: the lock
was removed, the code rebuilt, and the multi-process race run five times — ten executions — with every
assertion holding (`phase-2-slice-5-one-worker-per-order.md` §3). The reason is the best technical fact in
that slice, and it is not "the test was weak": **two concurrent `UPDATE`s on the same row already serialise on that row's write
lock, whether or not anybody took an explicit lock first.** The second update reaches the row, finds it held
by the first's uncommitted write, and blocks; when the first commits, the second re-reads the newly committed
version, re-evaluates its own `WHERE` clause against it — the status has moved on — and reports zero rows. So
the status-guarded UPDATE is *already* indivisible by itself. The explicit lock moves the wait one statement earlier; it
does not change who wins.

So the honest statement is: **today that lock is defence in depth, not a load-bearing mechanism, and it
changes no observable outcome.** It was added anyway for two reasons that are stronger for being accurate.
Phase 3 makes it load-bearing — the retry path stops deriving the supplier request identifier from the order
alone (it has to *read* the previous attempt first), and an operator's re-issue racing a timeout retry puts
two legitimate workers at one order, at which point "read the attempt, classify *unknown* versus *failed*,
choose re-probe or fall through to the backup supplier" is exactly the multi-statement read-then-act only a
row lock protects. And the right time to add a lock is *before* the code that needs it, so that code lands on
an already-serialised path; retrofitting locks into a working system, one call site at a time, is where
deadlocks come from.

**The general lesson, stated once:** *a claim is only worth as much as the thing that would falsify it.* It
is the same instinct as Phase 1 leaving nineteen contested payment reports deliberately unfinished rather
than settling them dishonestly, and the same instinct as walking a specification criterion back with a dated
entry rather than leaving it decoratively green. A specification's only asset is that its claims can be
believed one at a time.

*Depth: `phase-2-slice-6-checks-a-reviewer-can-run.md` §4, `phase-2-slice-5-one-worker-per-order.md` §3.*

---

## Why the checks run four processes and not four requests

Every check here runs against **four separate API processes**, and that is not thoroughness — it is the
difference between a check and a decoration.

Each instance holds a **single database connection**, because that is the serverless shape: fifty concurrent
invocations each holding ten connections would ask the database for five hundred. So within one process a
transaction holds that one connection for its whole life, and a second concurrent request **queues inside
Node, before a byte reaches Postgres**. `SKIP LOCKED` never skips, because nothing else holds a row lock when
it looks. The database never sees two statements in flight, so no database-level mechanism is ever exercised.

Which means a shop with **no locking at all** passes. Measured, not argued
(`architecture.md` §7, quoted in `…-slice-6-…` §2):

| Harness | Codes handed out | Distinct | Errors |
|---|---|---|---|
| 1 process | 20 | **20** | 0 |
| 4 processes | 20 | **9** | 0 |

**The same broken code is flawless against one process and hands eleven customers a key somebody else also
holds against four** — silently, with nothing raised or logged in either case. And the count moves between
runs (9, then 12), which is itself the signature of a genuine race; a stable number would mean something is
serialising.

Two tempting alternatives are rejected explicitly. **Raise the connection pool for tests** — one line, and it
proves a different system correct, because that pool size *is* the configuration under test. **Fire fifty
requests at one dev server and call it a race** — this is what most projects ship, and it is the specific
failure the harness exists to prevent, not because it is lazy but because it is *convincing*: real traffic,
real rows, a green transcript, and a completely false statement about the system. A race check that cannot
fail is worse than no race check, because it grows more convincing every time it passes.

The harness therefore checks its own premise before any other check runs. That premise check is itself one of
the five — `harness`, the only one of them that asserts nothing about the shop — and it works by counting
distinct Postgres backends. Pointed at `http://localhost:4301` and `http://127.0.0.1:4301` — two different
origins that are very often one process — it reports:

```
PASS  http://localhost:4301 serves /api/health — HTTP 200, status="ok"
PASS  http://127.0.0.1:4301 serves /api/health — HTTP 200, status="ok"
FAIL  targets hold separate database connections — 1 distinct backend pid(s) as 'game-shop', need >= 2
```

Postgres runs one *backend* — one server-side process — per open connection, and lists them in a system
table. Counting distinct backends that identify themselves as this shop is therefore a direct count of how
many separate API processes are really connected, and it excludes the checking session itself so it cannot
count itself into a pass.

Both targets are healthy; both would answer every request the other checks make; every assertion would pass
and prove nothing. **"Serving" and "separate" are exactly the two things it refuses to conflate.**

---

## The five adversarial scenarios, scored honestly

`context/product/product-definition.md` §1.4 lists five scenarios and calls them the definition of success.
**The double-click is not one of them** — it is stage 2's headline requirement and spec 002 §2.1, and
conflating the two misquotes the assignment to the person who wrote it.

| # | Scenario | Status after Phase 2 |
|---|---|---|
| 1 | 50 parallel `paid` reports for one order → one issuance fact, one key consumed | Settled, and now **runnable**: `pnpm race webhooks`, at the assignment's stated number, across four processes |
| 2 | A repeated report with the same `event_id` changes nothing | Settled since Phase 1 by the `event_id` PRIMARY KEY; now runnable: `pnpm race same-event` |
| 3 | A report arriving before its order, or out of order | Settled this phase — stored by the absent foreign key, applied by the four triggers; runnable: `pnpm race before-order` |
| 4 | An empty key pool leaves the order recoverable; after restocking, exactly one key | **Half-won.** The out-of-stock state is real and a restock re-issues cleanly against the same derived request id. The operator's list of paid-but-undelivered orders and the manual retry are Phase 3, and there is no check for them here |
| 5 | A promo code with limit N, under parallel requests, applied at most N times | Phase 5. Not started |

The double-click has its own check — `pnpm race create-order`, twenty concurrent Buy attempts sharing one
key — which also asserts the negative complement: a **fresh** key still creates a **new** order. Without that
second half, a check proving only "concurrent things converge" would pass against an implementation that
merges every purchase of one item into a single order forever, which is Keystone 1's content-hash failure
wearing a green tick.

---

## What is not finished

- **The row lock is defence in depth, not a mechanism.** Stated plainly above and worth repeating here: it
  changes no observable outcome today, ten RED executions confirmed it, and Phase 3 is what makes it
  load-bearing.
- **The fifty-webhook check reports a widened guard through its teardown, not an assertion.** Recorded in
  the harness README. It is a check that got lucky, and knowing that is the value of the RED exercise.
- **The watchable order page rests on a timing window nothing structurally defends.** The page's refresh has
  to land inside a few tens of milliseconds. A slower acknowledgement pushes it late; a faster supplier
  closes it early; a real network changes both. The two fixes that would make it a guarantee — pushing each
  transition to the page over a socket, or recording transitions server-side and reading the *history*
  rather than sampling the *current state* — are both more machinery than the criterion is worth at this
  scale. Written down rather than engineered away.
- **`out_of_stock` was never watched in a browser.** Reaching it needs the fifty-key pool exhausted, which
  would have wrecked the baseline every other check in this phase runs against. It is covered by a
  compile-time check that every status has a Russian label, which is real evidence that the label exists and
  weaker evidence than the five states that were actually watched rendering. The difference is said out loud
  rather than left to blur.
- **The before-order check needs an affordance, and says so.** Order ids are server-generated, so the
  scenario cannot be staged without letting the script choose the id. A configuration flag allows it: off by
  default, fails closed when unset, set only for the instances the harness spawns for itself, never in a
  deployment, and recorded in `architecture.md` §9 as a known trade-off. Against a deployed shop that
  correctly refuses it, the check reports **`SKIP`** — printed by name and subtracted from *both* sides of
  the ratio, so the summary reads `4/4 passed, 1 skipped`, never `4/5`. `FAIL` would report a correct system
  as broken and teach the reviewer to distrust the other four; `PASS` would count an unrun check as
  evidence, which is the decoration §2.6 exists to forbid.
- **No root `README.md`.** `architecture.md` §7 says the mapping from scenario to named check lives in the
  README and calls that mapping the deliverable; the harness's own `scripts/race/README.md` documents it
  thoroughly, but the top-level file is Phase 6 work. (The per-check aliases that document also names —
  `race:webhooks`, `race:same-event`, `race:create-order` — were missing when Slice 6 was written and now
  exist in `package.json`, as `race:before-order` rather than the `webhook:before-order` the architecture
  calls it.)
- **A shopper whose browser blocks site storage loses one of the four guarantees in Keystone 1** — repeated
  clicks, an attempt re-sent by the page, a retry after a click that appeared to fail, and two tabs on one
  purchase. The purchase-intent name falls back to per-document memory, so repeated clicks and retries in one
  tab still share a name and two *tabs* no longer do. A deliberate, specific degradation rather than a
  crash — reading that storage can itself throw, and an uncaught throw there takes the purchase down for a
  reason that has nothing to do with buying anything.
- **Out of scope by design:** suppliers that fail or go quiet, the *unknown*-versus-*failed* classification,
  the backup supplier and the operator's retry (Phase 3); the designed storefront (Phase 4); promo codes
  (Phase 5); public deployment (Phase 6); and webhook signature verification, which the assignment waives.

---

## How to run the checks

```sh
pnpm race                              # all five, against 4 freshly built local processes
pnpm race webhooks same-event          # only the named ones
pnpm race:webhooks                     # the same thing through the per-check alias
pnpm race --list                       # what exists; runs nothing, needs nothing running
RACE_BASE_URLS=https://…  pnpm race    # a deployed target: builds nothing, spawns nothing
pnpm test:concurrency                  # the suite that actually guards the key claim
```

`pnpm race` builds the packages, starts four real API processes, waits until each has served a real health
request, runs every check against all four, and stops all four afterwards — on success, on failure, on a
thrown configuration error, and on Ctrl-C. It was run twice consecutively with no tidying in between:
**5/5 both times, exit 0 both times**, with the database back at its seeded baseline afterwards
(12 products, 50 unclaimed keys, 0 orders, 0 reports, 0 deliveries). That is spec §2.6's fourth criterion,
and it is earned by every check cleaning up in a `finally` block.

One bug worth telling, because it broke the exact property it was introduced to protect. The first version of
the `SKIP` outcome called `process.exit(3)` at the point the refusal was detected — inside the `try`. That
terminates immediately and **skips the `finally`**, leaving the early payment report on disk, so the next run
would start against a dirty database. The fix is to set a flag, fall out of the `try`, let cleanup run, and
set the exit code at the end. `process.exitCode` sets a value; `process.exit()` is control flow wearing a
value's clothes.

---

## Where the depth is

| File | Read it for |
|---|---|
| `phase-2-slice-1-one-order-per-intent.md` | Intent versus content; where the key is minted; the two causes of zero rows; why the read-back cannot miss a winner |
| `phase-2-slice-2-answer-then-work.md` | The 72 ms answer; the status-code table; what the scheduler guarantees; the honest limit of `SKIP LOCKED`; the timestamp-precision bug |
| `phase-2-slice-3-out-of-order.md` | The absent foreign key; why four triggers; what the once-a-second status read costs on a one-connection pool; the corrected scenario table |
| `phase-2-slice-4-watching-the-stages.md` | The 25–65 ms measurement that disproved the obvious explanation; the 4/5 split; walking a criterion back with a date |
| `phase-2-slice-5-one-worker-per-order.md` | Guard versus lock; why the lock cannot wrap the supplier call; the RED validation that came back green |
| `phase-2-slice-6-checks-a-reviewer-can-run.md` | The harness; all five RED outcomes; the null result and what it revealed; the third exit code |

Phase 1's own argument: `phase-1.md`. The nine invariants and the exact SQL for each:
`context/product/architecture.md` §3, §3.1. Requirements:
`context/spec/002-single-issuance-under-races/functional-spec.md`.

**On evidence:** every number in this document is quoted from the slice walkthrough named beside it, which
records how it was captured. Nothing was measured or re-run while writing this, and no source file was
modified.
