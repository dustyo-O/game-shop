# Phase 1 — the purchase path, and the three decisions that carry it

> The phase-level walkthrough required by functional spec §2.7. It makes the argument **once**; the seven
> slice walkthroughs beside it hold the evidence, and every claim names the one that proves it. Nothing here
> needs the source code to follow.

## What was built, and what it is for

A shopper opens the shop, picks one of twelve items, pays, and a game key appears on the page a moment later
with no human in the middle — catalogue, order, payment, key, with payment simulated by a button choosing
success or failure. The path is the easy part. The promise attached to it is not:

> **A key that has been given to one shopper is never given to another.**

That has to hold while a shopper double-clicks Buy, while the payment provider reports the same payment five
times — each report a *webhook*, the provider calling the shop back unprompted — while several such reports
arrive in the same millisecond, and while the supplier goes quiet halfway through a request — each of which
produces two keys for one order, or one key for two, in a shop that reads perfectly correctly one request at a
time.

**The central claim is one sentence:** every guarantee is enforced by the database — never by a check in
application code, never by a lock inside one process. The API runs as *serverless functions*, so two
simultaneous requests are two separate operating-system processes that cannot see each other's memory: a
flag or lock in one does not exist for the other, which is why such a guard passes every test on one machine
and evaporates in production. The one thing the two processes share is the database.

One convention throughout: **"zero rows" is a normal answer, not an error.** Every statement below changes
rows only if a condition still holds *at the instant the database checks it*; one row back means "you did
it", zero means "somebody else already did, or it was never yours". Three decisions carry the claim, and
each is given below as what it is, the obvious alternative, what goes wrong without it, and the exact
instruction the database runs.

---

## Keystone 1 — an order moves through named states, not a "paid" flag

**The decision.** An order is always in one of six named states, with five legal moves:

```
created ──paid──▶ paid ──claimed──▶ delivering ──key bound──▶ delivered
   │                                     │
   └─payment declined─▶ payment_failed   └─supplier had none─▶ out_of_stock
```

`delivered` and `payment_failed` are final — no move lists them as a starting point. `out_of_stock` is
settled but not final: a later phase adds a retry back into `delivering`.

**The obvious alternative.** Two true/false columns, `paid` and `delivered`. Everyone writes this first.

**What goes wrong.** `paid = true, delivered = false` is where *every* failure lands, and it is four
situations needing different handling: nobody has claimed the order; a worker is calling the supplier right
now (**no other worker may touch it**); the pool was empty; the supplier timed out and we do not know
whether a key was issued. A boolean pair cannot tell them apart. **`delivering` is a state that exists only
because concurrency exists** — not a fact about the order but a *claim*, "this one is mine", and booleans
give that claim nowhere to live but one process's memory, where the other cannot see it.

**The instruction that enforces it.** Every move is one statement naming the states it may leave from:

```sql
UPDATE orders SET status = $2, updated_at = now()
WHERE id = $1 AND status = ANY($3)   -- $3 = permitted starting states
RETURNING *;
-- 1 row  => THIS call made the move. Nobody else can also have made it.
-- 0 rows => the order was not in a state this move may leave from.
```

The naive version reads the row, checks the status in JavaScript, then writes — so two copies of one payment
report on two machines both read `paid`, both write `delivering`, and both pass, because nothing in that
write mentions the old status. Two keys leave the pool for one order, and the `if` was correct in both
processes: the gap between reading and writing is where the other process lives.

What the database does instead — two real sessions on one order (Slice 2 §2). A held its *transaction* open
two seconds — a transaction is a group of statements that all take effect or none do, and until it closes no
other session may change a row it has written; B ran the identical guarded statement 0.4 s later:

```
[A] UPDATE 1     -- moved the order
[B] UPDATE 0     -- Time: 1615.395 ms
```

B neither failed nor blindly overwrote. It **waited 1.6 seconds on A's row lock**, then re-checked its own
`WHERE` clause against the *new* version of the row and matched nothing. That re-check is the whole mechanism,
and it costs one clause. Idempotency comes free with it — *doing it twice changes no more than doing it once*:
a duplicate report is a caller who lost by three seconds instead of three milliseconds, and a `delivered`
order replayed with a late report gets `UPDATE 0` with *no code running to prevent it*.

*Depth: `slice-2-order-lifecycle.md`; why zero rows must never be thrown as an error at a payment provider
that retries on `5xx`, `slice-3-webhook-inbox.md` §3.*

---

## Keystone 2 — the shop decides that a key has been given out, not the page

**The decision.** "This shopper has been given a key" is defined as **one row in the shop's `deliveries`
table**, written by the server inside the same transaction that moves the order to `delivered`. Nothing the
browser does, shows, hides or disables participates in that decision; the page is a *reader* of state the
shop already committed. Since the database row is the only place separate processes meet, it is the only
place the decision can be made at all.

**The obvious alternative.** Let the page hold the outcome — it is right there and knows what happened. It
just pressed Pay, so it can show the key; it already submitted, so a disabled Buy button prevents a second
order; the payment failed, so hidden pay buttons prevent a second attempt; it displayed the price, so it can
send that with the order. Each is a guarantee the server never agreed to.

**What goes wrong.** *The disabled Buy button does not hold — measured.* Within one tab it is useful: a
disabled button dispatches no click, so a double-click sends one request. But the server has never heard of
it, and two orders for one intent still arrive from two tabs, from a reload mid-flight, from a client-side
timeout on a request that succeeded, and from any client that is not this page — two simultaneous order
requests today return two `201`s with two different order ids (Slice 2 §6). The hidden pay buttons are the
same courtesy: the endpoint accepts the call they would have made, and the order stays put because of a
`WHERE` clause, not a hidden element.

*A client-supplied price is the same shape of mistake*, so order creation takes an item code and nothing
else: one statement reads `price_minor` from the catalogue and writes it into the order, column to column,
with `purchasable = true` as a `WHERE` predicate rather than an `if`. No local variable holds a price for a
later edit to substitute a request field into (Slice 2 §5).

*And the key never leaves the database early.* The page's read is
`SELECT …, CASE WHEN orders.status = 'delivered' THEN deliveries.code END AS code …`, so an undelivered
order's key is not hidden by the front end — it is never sent. Hence the reload test the spec asks for:
close the tab, return much later, the same key is there, because it was never the page's to hold.

*Depth: `slice-2-order-lifecycle.md` §5–6, `slice-3-webhook-inbox.md` §6.*

---

## Keystone 3 — the same key cannot reach two orders

**The decision.** Three layers, in the order they act. **One worker may claim an order:** `paid →
delivering` is Keystone 1's guarded statement, so exactly one caller gets a row and the rest stop **before
spending money at the supplier**. **One request may claim one key:** picking a key is a *single* statement
that finds an unclaimed key, locks it and writes the claimant's id, with no gap between the two. **One order
may hold one delivery:** a *unique index* — a rule Postgres enforces on every write, that no two rows may
hold the same value in a given column — whose *never firing* is the evidence the first two layers worked.

**The obvious alternative.** `if (!alreadyDelivered) { deliver() }`, which the brief names as the thing
candidates get wrong. Twenty concurrent database sessions, released together by a clock barrier, all
handling the same payment for one order against a copy of the delivery table **with the unique index
removed**; each counts deliveries, waits 200 ms for the supplier call, and inserts if the count was zero
(Slice 1 §5):

```
--- 20 concurrent sessions, application check, NO unique index ---
 delivery_rows_for_ord_race | distinct_keys_handed_out
                         20 |                       20
```

**Twenty keys handed out for one order.** All twenty run the count before any has inserted, so all twenty
see zero, call the supplier and insert — every check correct at the moment it ran. Against the shipped table
the same twenty give one delivery row **and twenty keys still burned**: a unique index guarantees the
*shopper* one key, but by then the money is spent. Add the claim guard in front and the twenty produce one
delivery, **one key**, and nineteen workers that never reached the supplier.

**The instructions.** The key claim, one statement:

```sql
UPDATE supplier_keys SET claimed_by_request_id = $1, claimed_at = now()
WHERE code = (
  SELECT code FROM supplier_keys WHERE claimed_by_request_id IS NULL
  ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
)
RETURNING code;
-- 1 row  => this call now owns that key.
-- 0 rows => every key is claimed. Not an error: the caller is told out_of_stock.
```

`FOR UPDATE SKIP LOCKED` means *take the first unclaimed key nobody else is holding; if one is busy, step
past it rather than queue behind it*. Finding, locking and writing are one operation, so no other request
can see that key as free and act on it. Then the bind:

```sql
INSERT INTO deliveries (order_id, code, provider, request_id) VALUES ($1, $2, $3, $4)
ON CONFLICT (order_id) DO NOTHING
RETURNING *;
-- 1 row  => THIS call bound the key. At most one caller ever sees this, across every process.
-- 0 rows => this order already has a delivery. Keep the existing one; do not issue again.
```

Which half is load-bearing matters: **the unique index is the guarantee; `ON CONFLICT DO NOTHING` only stops
the loser raising an error.** Without the clause that insert raises `duplicate key value violates unique
constraint "deliveries_order_id_key"` — a crash instead of a no-op, but no broken promise.

**The measured proof.** The same twenty across four separate API processes, this time as real payment
reports with twenty *distinct* event ids, so nothing is filtered on arrival (Slice 5 §8):

```
--- 20 concurrent paid webhooks, distinct event_ids, one order, across 4 processes — 108 ms ---
http statuses: { '200': 20 }        errors (non-200): []

 order_status | delivery_rows | keys_claimed | events_stored | pool_left
 delivered    |             1 |            1 |            20 |        49
```

One delivery row, **one key out of a pool of fifty**, one supplier call, zero errors. At the boundary — one
key left, two orders paid simultaneously across two processes — one reached `delivered` with a code, the
other `out_of_stock` (Slice 6 §5).

**The supplier's half.** A timed-out call cannot tell "never arrived" from "answered, and the answer was
lost" — retrying blindly issues a second key, not retrying abandons a paid order. So **every request carries
an id derived from the order itself** (`req_{order_id}_{provider}_{attempt}`, recomputable by any process
holding only the order id), and the supplier runs `SELECT code FROM supplier_requests WHERE request_id = $1`
before touching a key: found means return that same code, however often it is asked. **A timeout is
therefore *unknown*, not failed** — an answer not yet read — retried against the same supplier with the same
id, with fallback to a backup only after an explicit, readable refusal, because a wrong "unknown" costs one
redundant question and a wrong "failed" costs a second key. Its claim and ledger writes are one transaction:
without that, `SIGKILL`ing a process between them leaves a key claimed by an id the ledger has never heard
of, and every retry then returns `500` forever, since there is no un-claim (Slice 4 §4).

*Depth: `slice-4-supplier-idempotency.md`, `slice-5-issuance.md`.*

---

## The invariant table

The nine guarantees, the mechanism enforcing each, the failure it prevents. `UNIQUE` and `PRIMARY KEY` below
are the rule glossed above: Postgres refusing a second row that carries a value another row already holds.
Exact SQL: `architecture.md` §3.1.

| # | Invariant | Mechanism | Without it |
|---|---|---|---|
| I1 | One client request → one order | `client_request_id` UNIQUE; `INSERT … ON CONFLICT DO NOTHING`, then read the winner back | A double-click makes two orders and two charges |
| I2 | One payment event applied once | `event_id` PRIMARY KEY; winning the insert *is* "first sight", losing it *is* "duplicate" | A redelivered webhook re-runs issuance |
| I3 | One order → at most one delivery | `deliveries.order_id` UNIQUE | Two workers both see "not delivered" and both issue |
| I4 | Only one worker advances an order | `SELECT … FOR UPDATE` on the order row **plus** `UPDATE … WHERE status = 'paid'` | Fifty webhooks make fifty supplier calls — and still exactly one key, because I5's ledger and I3's UNIQUE do the key-count work. Measured in Phase 2: widening the guard cost 49 avoidable supplier calls, not a second key |
| I5 | One supplier request → one code | Supplier stores `request_id → code`; a repeat returns the stored code | A retry after a timeout issues a second key |
| I6 | One key → at most one request | `supplier_keys.claimed_by_request_id` UNIQUE; one conditional `UPDATE … RETURNING` claims it | The same key is sold twice |
| I7 | A promo is used at most N times | `UPDATE … SET used_count = used_count + 1 WHERE used_count < max_uses RETURNING` | Parallel redemptions overshoot the limit |
| I8 | One promo redemption per order | UNIQUE (`promo_id`, `order_id`) | A retried order double-counts against the limit |
| I9 | Final states are terminal | Status-guarded moves; `delivered` and `payment_failed` start no move | A late webhook resurrects a completed order |

**I2, I3, I5, I6 and I9 are enforced and measured.** I4 ships its guard half only and I1 is not wired up
(both below); I7–I8 are Phase 5, whose tables do not exist yet. One deliberate absence: `payment_events` has
**no foreign key** to orders, so an event naming an order that does not exist *yet* is stored and applied
later instead of raising a `500` that would turn a few-millisecond race into a retry storm (Slice 1 §4).

---

## What is not finished

- **No idempotency key on order creation (I1).** Two concurrent `POST /api/orders` still create two orders —
  measured: two `201`s, two ids, both with `client_request_id` NULL. The column and its unique index are
  already in the schema and were proven at twenty concurrent sessions with no application code involved
  (Slice 1 §3). Missing is the header, and returning the winner on zero rows.
- **Webhook processing runs inline, so intermediate states are not observable.** From "payment reported" to
  `delivered` takes about **19 ms** by the database's own clock, so a shopper never sees `paid` or
  `delivering`. Functional spec §2.4 was **reworded during Slice 5 verification with a dated Change Log
  entry** over exactly this, so it now promises what a shopper can check. The mechanism was proven by
  slowing the supplier to 1500 ms, after which the page followed `created → delivering → delivered` live
  with no reload; moving the work off the acknowledgement path restores the latency.
- **Nineteen of twenty losing events stay pending until a Phase 2 drain.** A caller that loses the claim
  leaves its event unsettled on purpose: it cannot tell "another worker is mid-supplier-call" from "another
  worker claimed it and died", and a needless pending row costs a repeated no-op while a needless settle
  loses the payment result permanently. That buys one invariant: *an unfinished paid order always has a
  pending event pointing at it.*
- **`SELECT … FOR UPDATE` — half of I4 — is absent.** The guard makes the *transition* idempotent; the lock
  serialises *workers* across a multi-statement job. Phase 1 has one entry point into issuance, so there is
  no second worker; Phase 3's retry and admin re-issue add one, and two workers inside `delivering` with
  *different* attempt numbers is how a second key leaves the pool.
- **No retry policy, no supplier B, no admin panel.** A timeout is recorded as `unknown` and the order rests
  in `delivering`; nothing re-drives it, and nothing recovers an `out_of_stock` order. The gap is small: an
  out-of-stock refusal writes **no** supplier ledger row, so after a restock the same derived request id
  issues cleanly (verified end to end). Phase 3 adds a caller, not a repair.
- **Out of scope by design:** promo codes (Phase 5), the designed storefront (Phase 4), public deployment
  (Phase 6), and webhook signature verification, which the assignment waives.

---

## How to reproduce the race check

```
pnpm db:up            # only if Postgres is not already running
pnpm test:concurrency
```

No seeding, no cleanup, no reset. Twenty orders paid in parallel across four processes assert N distinct
keys, N claimed key rows and N delivery rows; fifty-five orders against a fifty-key pool assert exactly
fifty delivered and five `out_of_stock`, with the shop still answering.

**Why four API processes and not twenty requests at one.** Each instance holds a single database connection,
because that is the serverless shape, so within one process a transaction holds it for the whole claim and a
second concurrent claim queues **in Node, before a byte reaches Postgres**. `SKIP LOCKED` never skips, and a
claim with **no locking at all** behaves identically to the correct one (Slice 4 §9):

```
--- weakened claim, 20 distinct request_ids, 1 process  --- codes: 20  distinct: 20  errors: 0
--- weakened claim, 20 distinct request_ids, 4 processes --- codes: 20  distinct:  9  errors: 0
```

**The same broken code is flawless in one process and hands eleven customers a key somebody else also holds
in four** — zero errors in both, nothing logged. Raising the pool size in tests to "fix" this was declined:
a test that changes the configuration under test proves some other system correct.

**RED validation — proving the test can fail.** The locking statement was temporarily replaced by that
weakened version, the code rebuilt so the child processes actually ran it, and the suite run:

```
AssertionError: N distinct keys — no code handed to two orders
  expected 9 to be 20

AssertionError: exactly one order settles per available key
  expected 55 to be 50
```

**Nine of twenty** means twenty delivery rows and nine distinct codes — eleven people holding a key that
belongs to someone else, every response `200`. **Fifty-five of fifty** means the shop sold five keys it does
not own and reported success. The source was restored and the suite went green again; the count **moves
between runs** (an earlier one recorded twelve), as a scheduling-decided outcome should. The step is not
optional: a race test that silently serialises emits the same green line either way.

Assertions read the database as well as the responses, because the two disagree in both directions: during
Slice 4 a mis-written error check made **nineteen of twenty concurrent callers receive a `500` while the
database stayed perfectly correct**, so response-only would call it a correctness failure and database-only
a pass. Two limits: four processes on one machine is weaker than four serverless instances, and this is spec
§2.5 (N orders → N keys), not fifty webhooks on one order — measured by hand at twenty (Slice 5 §8).

*Depth: `slice-7-proving-the-race.md`.*

---

## Where the depth is

| File | Read it for |
|---|---|
| `slice-1-data-model.md` | The 20-session experiment; separate supplier tables; the missing foreign key |
| `slice-2-order-lifecycle.md` | Why not two booleans; the 1.6-second lock; pricing; the double-order gap |
| `slice-3-webhook-inbox.md` | Why winning an insert *is* duplicate detection; status codes as instructions |
| `slice-4-supplier-idempotency.md` | `request_id → code`; the `SIGKILL` counterfactual; `SKIP LOCKED` timings |
| `slice-5-issuance.md` | The thirteen hops; the attempt row written *before* the call; definite vs unknown |
| `slice-6-out-of-stock.md` | A thrown exception's cost; the three status lists; one key, two orders |
| `slice-7-proving-the-race.md` | Why one process proves nothing; RED; asserting against the database |

Invariants and SQL: `context/product/architecture.md` §3, §3.1. Requirements:
`context/spec/001-purchase-and-key-delivery/functional-spec.md`.
