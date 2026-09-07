# Slice 2 — The order lifecycle, and why every transition names where it may come from

> Written for the author to read and re-explain from memory. Companion to `context/product/architecture.md` §3 (I9) and §3.1.
> Slice 8 consolidates this and the other slice walkthroughs into the phase-level document.

## 1. What the lifecycle actually is

Six states in Phase 1, and **five** legal moves between them:

| Move | From → To | Who calls it |
|---|---|---|
| `markPaid` | `created → paid` | webhook, `status: "paid"` |
| `markPaymentFailed` | `created → payment_failed` | webhook, `status: "failed"` |
| `beginIssuance` | `paid → delivering` | the worker claiming the order |
| `completeDelivery` | `delivering → delivered` | after the key is bound in `deliveries` |
| `markOutOfStock` | `delivering → out_of_stock` | supplier's pool was empty |

Two absences are as load-bearing as the five entries. There is **no `paid → delivered`** — delivery can only be finished by whoever claimed the order into `delivering`, so the claim cannot be skipped. And **nothing leaves `delivered`, `payment_failed` or `out_of_stock`**: those statuses appear in no `from` list at all.

### Why not two booleans?

`paid` and `delivered` give four combinations, and the interesting one — `paid = true, delivered = false` — is where *every* failure in this system lands. That single combination is at least four genuinely different situations needing different handling:

- money taken, nobody has picked the order up yet → **a worker should claim it**;
- money taken, a worker is right now on the phone to the supplier → **no other worker may touch it**;
- money taken, the supplier's pool was empty → **nothing to hand over; surface it, don't retry blindly**;
- money taken, the supplier timed out and we don't know whether a key was issued → Phase 3, and the most dangerous of the four.

A boolean pair cannot tell those apart, so the code has to guess. Same problem on the other side: `paid = false` means both "hasn't paid yet" and "payment was declined" — the page must show pay buttons in the first case and must not in the second.

The sharpest way to put it: **`delivering` is a state that exists only because concurrency exists.** It is not a fact about the order, it is a *claim* — "this one is mine". With booleans there is nowhere to write that down, so it ends up in process memory or inferred from a read — exactly the check-then-act the architecture forbids.

> *Interview answer:* "Because 'paid but no key yet' is not one situation, it's four, and one of them is 'someone else is already working on this' — which has nowhere to live in a boolean."

## 2. Why every transition names its permitted source states

One statement does the work (architecture §3.1, I9):

```sql
UPDATE orders SET status = $2, updated_at = now()
WHERE id = $1 AND status = ANY($3)   -- permitted source states only
RETURNING *;
-- 1 row  => THIS call made the transition; nobody else can also have made it.
-- 0 rows => the order was not in a state this transition may leave from.
```

Zero rows does not mean "error". It means: *at the instant Postgres evaluated that predicate, the row did not look like that.* Three ordinary causes — somebody else already advanced it, a late event arrived for a finished order, or the order hasn't reached the source state yet.

### The obvious alternative, and the incident it produces

```ts
const order = await db.select()...;                          // t0
if (order.status === "paid") {                               // t1
  await db.update(orders).set({ status: "delivering" })...;  // t2
}
```

Two webhook copies for order X, on two serverless instances:

- **t0** — instance A reads X: `paid`.
- **t1** — instance B reads X: `paid`. B's snapshot is just as true as A's.
- **t2** — A writes `delivering`. Passes.
- **t3** — B writes `delivering`. Also passes — nothing in that UPDATE mentions the old status.
- Both now call the supplier with different `request_id`s. Two keys leave the pool for one order.

The `if` was true in both processes because it was evaluated against a *copy* of the row. The `WHERE` clause is the same test, evaluated **at the write**, by the only party that can see both requests.

### The part worth memorising: what Postgres actually does

Two real sessions on one order. Session A opened a transaction, ran the guarded update, held it two seconds, then committed. Session B ran the identical statement 0.4 s later:

```
[A] UPDATE 1     -- returned the row, status 'paid'
[B] UPDATE 0     -- Time: 1615.395 ms
```

B did not fail, and it did not blindly overwrite. It **blocked on the row lock for 1.6 s**, and when A committed, B re-evaluated its `WHERE` clause against the *new* version of the row — saw `paid`, not `created` — and matched nothing. That re-check under `READ COMMITTED` is why this guard survives genuine simultaneity and not merely interleaving. It is the whole mechanism, and it costs one clause.

### Idempotency is not a separate feature

"Has this event already been applied?" and "did someone else already advance this order?" are the same question: *was the row in a state I am allowed to leave from?* A duplicate webhook is just a caller who lost the race by three seconds instead of three milliseconds. That is why there is no separate "seen it already" check on the transition path — a second mechanism would be a second place to get it wrong.

Terminality falls out of the same clause. An order taken to `delivered`, then replayed with a late payment event and a late claim:

```
UPDATE ... status = ANY(ARRAY['created'])  -> UPDATE 0   -- late "paid" webhook
UPDATE ... status = ANY(ARRAY['paid'])     -> UPDATE 0   -- late issuance claim
SELECT status -> delivered
```

A completed order cannot be resurrected, and no code was executed to prevent it.

## 3. Why the lifecycle is a table, not five methods

Five methods would each carry their own `WHERE status = …`, and the set of legal moves would exist only as the union of five function bodies. Nobody could answer "can an order go from `delivered` back to `delivering`?" without reading all five, and the sixth method, written under deadline pressure, would get a hand-written `WHERE` — possibly without a status predicate at all.

As data it reads in ten lines, and two further things become possible.

**Callers name a transition, never a to/from pair.** `transition(orderId, "beginIssuance")`. There is no call site where the guard can be weakened, because no call site supplies it.

**The compiler can assert something about the table.** `PermittedSourceStatus` is the union of every status appearing in any `from` list; `Extract<PermittedSourceStatus, TerminalOrderStatus>` is the terminal states appearing as a source; `_NoTransitionLeavesATerminalState` requires that set to be `never`. Adding a plausible-looking `redeliver: { to: Delivering, from: [Delivered] }` stops the build:

```
error TS2344: Type '"delivered"' does not satisfy the constraint 'never'.
```

pointing at the line that would have made a completed order resurrectable.

**Be precise about what that proof does not do.** It emits no code. It does not check that the `from` lists are *correct* — `markPaid: from: [created, paid, delivering]` would compile happily and be wrong. It cannot see a raw `UPDATE orders SET status = …` written elsewhere; "one writer only" is a convention, not a compiler guarantee. And above all: it catches a **developer's** mistake, made once, at edit time.

**Only the guarded `UPDATE` holds against a concurrent caller.** The type system defends the table against me; the `WHERE` clause defends the order against the world. Asked which is the enforcement, the answer is the SQL, every time.

The payoff: Phase 3's `delivery_failed`, plus retrying `out_of_stock` and `delivery_failed` back into `delivering`, is *new rows in this table and nothing else*.

## 4. Why zero rows is a return value and not an exception

The service returns a discriminated union rather than throwing:

- `transitioned` — carries `order` (the row after the move);
- `not_in_source_state` — carries `observed`;
- `order_not_found` — carries `orderId`.

Different property names on purpose: `result.order` does not type-check until you have narrowed on `result.outcome`, so "did I actually do it?" cannot be skipped by accident, only refused deliberately. (`observed` is explicitly advisory — under `READ COMMITTED` the row may move again between the UPDATE and the read-back. The load-bearing fact is the outcome itself.)

### The incident that throwing produces

Payment providers retry on `5xx`. That is the contract, and the whole reason for receive → persist → acknowledge → process.

- The provider sends `evt_1` for order X. We process it; X reaches `delivered`.
- The provider retries `evt_1` anyway — at-least-once delivery needs no cause.
- The handler applies `created → paid`. Zero rows: X is `delivered`.
- **If that throws**, Nest turns it into a `500`. The provider reads `500` as "they didn't get it" and retries. With backoff, for hours. Every retry throws again.

You now have an error rate that looks like an outage, an alert storm, your endpoint marked failing on the provider's dashboard, and — on some providers — the webhook disabled entirely. Nothing was wrong: the order was delivered correctly the first time, and the *correct* behaviour was to do nothing and say `200`.

So `5xx` is reserved for the one case where redelivery is genuinely wanted — we could not write the event to the inbox. Everything the system handled correctly, including duplicates it correctly ignored, answers `200`.

The third outcome exists for a related reason: `payment_events.order_id` carries **no foreign key**, so an event may legitimately name an order that does not exist *yet*. That caller must leave the event pending and drain it later. Collapsing `order_not_found` into `not_in_source_state` would either lose the event or force every caller to re-query to find out which one it had.

> *Interview answer:* "We return `5xx` only when we want the provider to send it again. A duplicate we correctly ignored is a `200`, because turning a correctly-ignored duplicate into a `500` is how you ask for the duplicate again."

## 5. How the amount is protected at order creation

`POST /api/orders` takes `{ sku }` and nothing else. Creation is **one statement**:

```sql
insert into orders (id, client_request_id, sku, amount_minor, currency, status, created_at, updated_at)
select $1, null, "sku", "price_minor", "currency", $2, now(), now()
from products
where products.sku = $3 and products.purchasable = $4
returning id, sku, amount_minor, currency, status;
-- 1 row  => the order exists, priced from the catalogue row in the same statement that created it.
-- 0 rows => no purchasable product with that SKU. Nothing was inserted. -> 422
```

`price_minor` and `currency` are read by Postgres and written by Postgres, column to column. **The price never becomes a JavaScript value.** The request's only contribution is `$3`.

### The obvious alternative and its two costs

```ts
const product = await db.select().from(products).where(eq(products.sku, sku));
if (!product?.purchasable) throw ...;
await db.insert(orders).values({ amountMinor: product.priceMinor, ... });
```

**The trust cost.** There is now a local variable holding a price, in a handler that also holds a request body. The bug does not get written today — it gets written in Phase 4 by someone adding promo codes, as `amount_minor: body.amount_minor ?? product.priceMinor`, and it reviews fine. In the current shape there is no such variable to substitute into; the attack surface was removed rather than guarded.

**The race cost.** Between the read and the insert, the catalogue can move:

- **t0** — read product P: `purchasable`, 129000.
- **t1** — an admin withdraws P (or reprices it to 199000).
- **t2** — insert an order for a product no longer for sale, at a price that is no longer the price.

The single statement evaluates the predicate and reads the price in one snapshot, so the window does not exist. Note the shape: `purchasable = true` is a **`WHERE` predicate, not an `if`** — the same move as the promo-limit update. The house pattern throughout this codebase: *the `WHERE` clause is the decision.*

One more thing worth being able to say: `created_at`/`updated_at` are `now()` in SQL, not `new Date()` in Node, so every timestamp comes from the one clock all processes are compared against. A serverless instance's clock is not that clock.

## 6. The duplicate-order gap, stated honestly

**Today, two concurrent `POST /api/orders` create two orders.** Two simultaneous requests for `KEY-CS2-PRIME`:

```
A http=201   B http=201
{"id":"ord_01M1W3ZXVFDV0BYF7Y5QR9KWD0", ... "status":"created"}
{"id":"ord_01M1W3ZXVHAAYJFQ3FNGJJ32K9", ... "status":"created"}
```

Two rows, both with `client_request_id` NULL.

**What the disabled button does.** It is disabled before the request goes out and re-enabled only on failure. Within one tab, on one element, a disabled button dispatches no click event — so an impatient double-click sends one request rather than two, and the shopper is never left holding a dead control. A real UX guarantee, worth having.

**What it does not do.** The server has never heard of that button. Two orders for one intent still arrive from: two tabs; a reload mid-flight (the flag dies with the document while the first request is still travelling); a request that timed out at the client but succeeded at the server, retried by a shopper who was shown the failure message; and any client that is not this page.

**Where the boundary has to be, and why it cannot be anywhere earlier.**

- *Not the page.* One client among many, and the only one that cooperates.
- *Not the API process.* "Have I seen this key?" followed by an insert is check-then-act, and it races with itself the moment two requests overlap. An in-memory `Map` or mutex is worse than nothing: `apps/api` runs as Vercel serverless functions, so two concurrent requests are typically two instances with separate memory. Such a lock **passes locally and evaporates in production** — the most dangerous kind of fix, because your test goes green.
- *It has to be the write itself.* The database row is the first and only place every concurrent attempt meets.

**What Phase 2 adds** (I1): an `Idempotency-Key` header naming the shopper's *intent*, stored as `client_request_id`, with a UNIQUE index behind it —

```sql
INSERT INTO orders (id, client_request_id, sku, amount, currency, status)
VALUES ($1, $2, $3, $4, $5, 'created')
ON CONFLICT (client_request_id) DO NOTHING
RETURNING *;
-- 0 rows => another request won the race; read that order back and return it with 200
```

Same shape as everything else: zero rows is news, not an error. The loser creates nothing, reads the winner's order, and returns it — so both clicks land on the same order page with the same id. The column already exists (written as an explicit NULL today) and the unique index already accepts any number of NULLs, because Postgres treats NULLs as distinct. Phase 2 is a header plus a changed insert, not a migration plus a new mechanism.

Worth adding if pressed: the key is the *client's intent id*, not a hash of the body — two deliberate purchases of the same game must both succeed.

## 7. Where this sits in the assignment

**Moved forward by this slice:**

- The mandated lifecycle exists in three agreeing places: the enum in `packages/contracts` (what the wire and frontend read), the `orders_status_check` CHECK constraint (what the database accepts), and the transition table (what may move where).
- The purchase path's first leg: an order with a **server-computed** amount, and a status page to watch it on.
- The mechanism the graded scenarios are won by. Fifty simultaneous "paid" webhooks producing exactly one issuance is won by `paid → delivering`: exactly one caller gets `transitioned`, the other forty-nine match zero rows and stop. Those slices are not written yet — but the thing that makes them correct is written, and it is thirty lines.

**Deliberately left open:**

- **Scenario 1, the double-click** → Phase 2, I1. This slice does not pretend otherwise, and the disabled button must not be presented as the answer.
- **I4's row lock** (`SELECT … FOR UPDATE` before the claim) → Phase 2. The guard alone already prevents a second *status* change; the lock serialises the whole claim-and-issue sequence around it.
- **`delivery_failed`, recovery, admin retry** → Phase 3. Deliberately absent from the enum *and* the CHECK constraint: a status the shop cannot reach should not be a value either layer accepts.
- **The webhook** (Slice 3) and **issuance** (Slice 5) — this slice built the thing they both call.

## Six questions, six answers

1. *Why a state machine and not a `paid` flag?* — Because "paid but no key yet" is four different situations, and one of them is "another worker already owns this".
2. *What does zero affected rows mean?* — That the row was not in a state this transition may leave from, at the instant Postgres checked. Ordinary traffic, not an error.
3. *How is that also idempotency?* — A duplicate event and a lost race are the same question: was the row in a permitted source state? One clause answers both.
4. *Why not throw on zero rows?* — Because it becomes a `500`, and `5xx` is how you ask a payment provider to send the duplicate again. Forever.
5. *What stops two orders from one double-click today?* — Nothing on the server. Phase 2's `client_request_id UNIQUE` with `ON CONFLICT DO NOTHING`; the button is UX only.
6. *What holds if two requests arrive at the same instant?* — Only the guarded `UPDATE`. The compile-time proof catches my mistakes; Postgres catches the world's.
