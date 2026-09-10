# Interview notes — Phase 1

> The spoken version of `phase-1.md`. Every number below is measured, and traceable to a slice walkthrough.

---

## The thirty-second answer

> "It's a game-key shop. Browse, buy, pay, the key appears — no human in the middle. The interesting part is
> the promise attached to it: **a key given to one shopper is never given to another.** That has to hold
> while somebody double-clicks Buy, while the payment provider reports the same payment five times, and while
> the supplier goes quiet halfway through. So there's one rule for the whole system: **every
> guarantee is enforced by the database — never by a check in application code, never by a lock inside one
> process.** The API runs as serverless functions. Two simultaneous requests are two processes that can't see
> each other's memory. The one thing they share is Postgres. That's where every decision gets made."

Then stop, and let them choose where to go.

---

## The three keystones, as spoken answers

### 1 — "Why a state machine and not a `paid` flag?"

> "Because `paid = true, delivered = false` is where *every* failure lands, and it's four different
> situations. Nobody has claimed the order. A worker is at the supplier right now. The pool was empty. The
> supplier timed out and we don't know whether a key was issued. Two booleans can't tell them apart.
> `delivering` exists only because concurrency exists — not a fact about the order, a claim: *this one is
> mine*. Booleans give that claim nowhere to live but one process's memory."

```sql
UPDATE orders SET status = $2 WHERE id = $1 AND status = ANY($3) RETURNING *;
```

> "One row means this call made the move; zero means somebody else did. Two real sessions on one order: B
> waited **1.6 seconds** on A's row lock, re-checked its `WHERE` against the new row, matched nothing —
> `UPDATE 0`, 1615 ms. That re-check is the whole mechanism, and it costs one clause."

### 2 — "Why does the server decide a key was delivered, not the page?"

> "Because 'this shopper has a key' is one row in `deliveries`, written inside the same transaction that moves
> the order to `delivered`. The page is a *reader*. It doesn't hold the outcome, the price, or the key. The
> database row is the only place two separate processes meet. So it's the only place the decision can be made."

```sql
SELECT …, CASE WHEN orders.status = 'delivered' THEN deliveries.code END AS code
```

> "An undelivered order's key isn't hidden by the front end — it's never sent. That's why the reload test
> passes: close the tab, come back much later, same key."

### 3 — "How do you make it impossible for one key to reach two orders?"

> "Three layers, in the order they act. **One worker may claim the order** — the guarded `UPDATE`, so the
> other nineteen stop *before spending money at the supplier*. **One request may claim one key** — finding,
> locking and writing are a single statement, so there's no gap. **One order may hold one delivery** — a
> unique index on `deliveries.order_id`, whose never firing is the evidence the first two layers worked."

**The number:** twenty concurrent `paid` webhooks, distinct event ids, one order, four processes — **one
delivery row, one key out of a pool of fifty, twenty `200`s, zero errors.**

**The line:** `FOR UPDATE SKIP LOCKED LIMIT 1`, inside the `UPDATE` that writes the claimant.

---

## The questions to hope for

**"How do you stop a double-click creating two orders?"**

> "Today, nothing on the server does. Two concurrent `POST /api/orders` return two `201`s with different
> ids — measured. The disabled button is UX only; the server has never heard of it. Two orders still arrive
> from two tabs, from a reload mid-flight, from a client timeout on a request that succeeded. Phase 2 is an
> `Idempotency-Key` stored as `client_request_id` behind a unique index, `ON CONFLICT DO NOTHING`, and the
> loser reads the winner back. Column and index are in the schema already. What's missing is the header."

The honesty *is* the answer. Never offer the button as the mechanism.

**"What if the supplier times out?"**

> "A timeout is **unknown**, not failed. A timed-out client can't tell 'never arrived' from 'answered, and the
> answer was lost'. So every request carries an id derived from the order — `req_{order_id}_{provider}_
> {attempt}` — which any process can recompute. The supplier reads its ledger before touching a key: found
> means return that same code, however often you ask. So the retry goes to the same supplier with the same
> id, and we fall through to B only after an explicit, readable refusal. A wrong 'unknown' costs one
> redundant question. A wrong 'failed' costs a second key."

If pushed: "Claim and ledger write are one transaction. I removed it and `SIGKILL`ed a process between them —
the key ends up claimed by an id the ledger never heard of, and every retry returns `500` forever."

**"Why not just check whether it's already delivered?"**

The brief names this as what candidates get wrong. Say you ran it.

> "Twenty concurrent sessions, released together, all handling one payment for one order, against a copy of
> the delivery table with the unique index removed. **Twenty deliveries, twenty distinct keys, one order.**
> All twenty ran the count before any had inserted, so all twenty saw zero. Every check was correct at the
> instant it ran. The gap between reading and writing is where the other nineteen live. Against the shipped
> table the same twenty give **one delivery row — and twenty keys still burned.** A unique index guarantees
> the *shopper* one key; by then the money is spent. Put the claim guard in front and you get one delivery,
> **one key**, and nineteen workers that never reached the supplier."

**"How would you test that?"**

> "`pnpm db:up`, `pnpm test:concurrency`. No seeding, no reset. Twenty orders paid in parallel across four
> API processes; then fifty-five orders against a fifty-key pool, asserting exactly fifty delivered and five
> `out_of_stock`, shop still answering. Four processes, not twenty requests at one: each instance holds one
> database connection — the serverless shape — so in one process the second claim queues **in Node, before a
> byte reaches Postgres**."

Then volunteer:

> "I proved the test can fail. Swapped in a weakened claim, rebuilt so the child processes really ran it, and
> got `expected 9 to be 20` and `expected 55 to be 50`. Nine of twenty means eleven people holding a key
> somebody else also holds, every response `200`. **The same broken code is flawless in one process.** And
> the assertions read the database, not just the responses."

---

## The questions to fear

**Name each of these before they do.**

**"Four processes on one laptop isn't really distributed."**

> "Agreed — weaker than four serverless instances. Same kernel, same clock, one loopback. It's the strongest
> thing that runs from one command; the strongest *form* runs against the deployed URL, in Phase 2. What it
> does establish: nothing depends on being one process. The same weakened claim hands out twenty distinct
> keys in one process and nine in four. And it's twenty webhooks by hand, not the fifty the brief asks for —
> the scripted fifty is Phase 2."

**"You didn't write this, an AI did."**

> "I directed it. I chose the architecture — Postgres-enforced invariants over application checks — and I
> decided what shipped and what didn't. Ask me about any decision in here: why `delivering` is a state, why
> the supplier's whole contract is `request_id → code`, why zero rows is never thrown as an error. That's
> what the walkthroughs are for. I wrote them to make sure I could."

Don't get defensive. The follow-up will be technical, and that's a gift.

**"What isn't finished?"** — offer this unprompted if the moment fits. Written at the close of Phase 1;
the `→` lines record what Phase 2 did about each, and that pairing is itself the answer to "how do you
decide what to defer?"

- **No idempotency key on order creation.** Two concurrent POSTs still make two orders. Column and unique
  index are in the schema; the header and the read-back are not.
  → **Closed, Phase 2 Slice 1.** The client mints a `client_request_id` per SKU and holds it until the
  create call *resolves*; the server inserts `ON CONFLICT (client_request_id) DO NOTHING` and reads back on
  zero rows. The column was in the schema from day one because the shape of the fix was known before the fix
  was scheduled.
- **Webhook processing runs inline**, so the intermediate states are real but unobservable — **19 ms** from
  event to `delivered`, by the database's clock. Rather than leave the spec overpromising, §2.4 was reworded
  with a dated Change Log entry; slowing the supplier to 1500 ms made the page follow `created → delivering →
  delivered` live.
  → **Closed, Phase 2 Slice 2**, and the reword reversed in Slice 4 with a second dated entry. The webhook
  now records the event, answers `200`, and completes the order on a tracked continuation. Worth saying out
  loud: the spec was walked back honestly for one phase and then walked forward again, both times dated —
  which is a better story than a criterion that was quietly always true.
- **Nineteen of twenty losing events stay pending** until a Phase 2 drain. Deliberate: a loser can't tell
  "another worker is mid-call" from "another worker died". A needless pending row costs a no-op; a needless
  settle loses the payment result.
  → **Closed, Phase 2 Slice 3.** Four triggers now drain the inbox — the webhook's own continuation, order
  creation, the shopper's status poll, and an operator sweep. The sweep re-examines the losers later, finds
  the order `delivered`, and settles them `no_op`. Only the sweep is tied to nothing happening, which is
  what makes the set closed.
- **`SELECT … FOR UPDATE`, half of I4, is absent.** The guard makes the *transition* idempotent; the lock
  serialises *workers*. Phase 1 has one entry point into issuance, so there's no second worker.
  → **Closed, Phase 2 Slice 5**, and the reasoning is worth more than the fix. The Phase 1 note expected
  Phase 3's retry to introduce the second worker; Phase 2's drain arrived first. But when the lock was
  actually implemented, the assumed exposure turned out **not** to exist: all four drain triggers funnel
  through one guarded `paid → delivering`, and `deriveIssuanceRequestId` is deterministic per attempt, so
  even a double entry would send the same `req_{order}_a_1`, collapse to one code in the supplier's ledger,
  and un-claim on rollback. **Do not cite slice-1 §5's twenty-keys measurement here** — that arm used twenty
  *distinct* request ids and no claim at all, and an interviewer who reads it will catch the mismatch. The
  real case is forward-looking: Phase 3's `attempt + 1` retry and supplier-B fall-through make the request id
  stop being derivable from the order alone, and that classify-then-choose step is a multi-statement
  read-then-act only a row lock protects. The lock went in **before** that code, so Phase 3 lands on an
  already-serialised path. Measured after the change: 20 webhooks, 4 processes → 1 delivery, 1 attempt,
  1 supplier request, **1 key claimed.**
- **No retry policy, no supplier B, no admin panel.** A timeout rests in `delivering` and nothing re-drives
  it. But an out-of-stock refusal writes no ledger row, so after a restock the same derived id issues
  cleanly — verified.
  → **Still Phase 3**, except that `POST /api/admin/payment-events/sweep` now exists behind a shared bearer
  token. That is the operator's answer to "someone paid and got nothing"; the panel and manual retry are
  still to come.

Two more traps. *"So `ON CONFLICT DO NOTHING` is your guarantee?"* — no, the unique index is; `ON CONFLICT`
only stops the loser raising. *"Why `SKIP LOCKED`, not `SERIALIZABLE`?"* — both are correct; plain
`FOR UPDATE` convoys, **959 ms against 54 ms** for twenty claims, and `SERIALIZABLE` hides the guarantee in a
retry loop I can't point at.

---

## Three sentences worth memorising verbatim

1. **"Every guarantee is enforced by the database — never by a check in application code, never by a lock
   inside one process."**
2. **"All twenty ran the check before any of them had inserted, so all twenty saw zero — and every one of
   those checks was correct at the instant it ran."**
3. **"The hard part of a race test isn't the assertions. It's proving the test could ever have been red."**
