# Slice 5 — Issuance, and the purchase spine closed

> Written for the author to read and re-explain from memory. Companion to `context/product/architecture.md` §3 (I3, I4, I5, I6), §3.1, §4 and §8.
> Slice 8 consolidates this and the other slice walkthroughs into the phase-level document.
>
> **This slice supersedes part of Slice 3.** `docs/walkthrough/slice-3-webhook-inbox.md` §5 describes a
> `paid` event being banked unprocessed (`deferred_issuance`). That branch is gone: a `paid` event now runs
> `markPaid` → `beginIssuance` → issuance inline, and the settle rule was rewritten around it (§7 below).
> Everything else in Slice 3 — the intake statement, the status-code rule, apply-then-settle — still holds.
>
> Every capture in this document was produced by running the system for this document, on 2026-09-07,
> against the local stack: four API processes on ports 3000–3003 sharing one Postgres, plus purpose-built
> instances pointed at a dead port and at two lying suppliers. Nothing is quoted from memory.

---

## 1. The whole chain, in one place

Four slices built pieces. This one joins them, and the joined thing is the assignment: a shopper clicks
«Купить» and ends up looking at a key that nobody typed in for them.

Here is the entire path, hop by hop, with the mechanism that guards each hop. **Every guard is a database
statement.** There is not one `if` in this column.

| # | Hop | The statement that does it | Guarded by |
| --- | --- | --- | --- |
| 1 | «Купить» → `POST /api/orders` | `INSERT INTO orders … SELECT sku, price_minor, currency FROM products WHERE sku = $3 AND purchasable = $4` | the price never enters JavaScript; `client_request_id` UNIQUE waits for I1 (Phase 2) |
| 2 | `POST /api/payments/:id/simulate` | `SELECT amount_minor, currency FROM orders WHERE id = $1`, then a real HTTP POST to `PAYMENT_WEBHOOK_URL` | the amount is read from the order, never from the caller |
| 3 | webhook intake | `INSERT INTO payment_events … ON CONFLICT (event_id) DO NOTHING RETURNING *` | **I2** — `event_id` PRIMARY KEY. Winning the insert *is* "first sight" |
| 4 | `markPaid` | `UPDATE orders SET status = $1 … WHERE id = $2 AND status = ANY($3)`, `$1='paid'`, `$3='{created}'` | **I9** — the source-state guard |
| 5 | `beginIssuance` — **the claim** | same statement, `$1='delivering'`, `$3='{paid}'` | **I4** (guard half) — exactly one caller per order ever sees one row |
| 6 | record the attempt | `INSERT INTO issuance_attempts … VALUES (…, 'unknown', …) ON CONFLICT (request_id) DO NOTHING` | `issuance_attempts_request_id_key` |
| 7 | supplier HTTP | `POST {SUPPLIER_A_URL}/issue` with `SUPPLIER_TIMEOUT_MS` as the deadline | nothing — this is the boundary the shop must distrust |
| 8 | (inside the supplier) ledger read | `SELECT code FROM supplier_requests WHERE request_id = $1` | **I5** — a repeat returns the stored code |
| 9 | (inside the supplier) claim a key | `UPDATE supplier_keys SET claimed_by_request_id = $1 WHERE code = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING code` | **I6** — `claimed_by_request_id` UNIQUE |
| 10 | bind the delivery | `INSERT INTO deliveries … ON CONFLICT (order_id) DO NOTHING RETURNING *` | **I3** — `deliveries_order_id_key` |
| 11 | `completeDelivery` | `UPDATE orders … status = 'delivered' … WHERE status = ANY('{delivering}')` | **I9** |
| 12 | settle the event | `UPDATE payment_events SET processed_at = now() WHERE event_id = $1 AND processed_at IS NULL` | idempotent by its own `IS NULL` guard |
| 13 | the page shows a key | `SELECT … CASE WHEN orders.status = $1 THEN deliveries.code END … LEFT JOIN deliveries` | the key never leaves Postgres unless the order is `delivered` |

Hops 10 and 11 are **one transaction**. Hops 6 and 7 are deliberately *not* (§3).

### The same chain, as Postgres saw it

`log_statement = 'all'` on the container, one purchase through the real endpoints, one backend process
(`[2442]` — with `max: 1` an instance has exactly one connection, so this is the whole instance's traffic).
Trimmed to the statement text and its parameters:

```
10:57:24.252 [2442] execute: insert into "orders" (…) select $1 as "id", null as "client_request_id",
                             "sku", "price_minor", "currency", $2 as "status", now(), now()
                             from "products" where ("products"."sku" = $3 and "products"."purchasable" = $4)
             DETAIL: $1 = 'ord_01M1XR80QY5K2R01AEKEK2GECN', $2 = 'created', $3 = 'KEY-CS2-PRIME', $4 = 't'

10:57:24.275 [2442] execute: select "amount_minor", "currency" from "orders" where "orders"."id" = $1
                             -- the simulator learning what to charge. Not from the caller.

10:57:24.283 [2442] execute: insert into "payment_events" (…) values ($1,…) on conflict ("event_id") do nothing returning …
             DETAIL: $1 = 'evt_01M1XR80SMZXTY5JQKVQ0C7T4E', $2 = 'ord_01M1XR80QY5K2R01AEKEK2GECN',
                     $3 = 'paid', $4 = '129000', $5 = 'RUB'                          -- I2

10:57:24.286 [2442] execute: update "orders" set "status" = $1, "updated_at" = now()
                             where ("orders"."id" = $2 and "orders"."status" = ANY($3)) returning …
             DETAIL: $1 = 'paid',       $3 = '{created}'                             -- I9, markPaid

10:57:24.288 [2442] execute: update "orders" set "status" = $1, … where (… and "status" = ANY($3)) returning …
             DETAIL: $1 = 'delivering', $3 = '{paid}'                                -- I4, the claim

10:57:24.290 [2442] execute: insert into "issuance_attempts" (…) values (default,$1,$2,$3,$4,default,default,default)
                             on conflict ("request_id") do nothing returning …
             DETAIL: $1 = 'req_ord_01M1XR80QY5K2R01AEKEK2GECN_a_1', $3 = 'a', $4 = 'unknown'

        ---- 5 ms with no statement at all: this is POST /internal/suppliers/a/issue ----

10:57:24.295 [2442] execute: select "code" from "supplier_requests" where "supplier_requests"."request_id" = $1   -- I5
10:57:24.296 [2442] statement: begin
10:57:24.298 [2442] execute: update "supplier_keys" set "claimed_by_request_id" = $1, "claimed_at" = now()
                             where "supplier_keys"."code" = (select "code" … for update skip locked)  returning   -- I6
10:57:24.299 [2442] execute: insert into "supplier_requests" ("request_id", "code", "created_at") values ($1,$2,default)
             DETAIL: $2 = 'X93K-NYAQ-GEC1'
10:57:24.299 [2442] statement: commit

10:57:24.302 [2442] statement: begin
10:57:24.303 [2442] execute: update "issuance_attempts" set "status" = $1, "code" = $2 where … "request_id" = $3
             DETAIL: $1 = 'ok', $2 = 'X93K-NYAQ-GEC1'
10:57:24.303 [2442] execute: insert into "deliveries" (…) values (default,$1,$2,$3,$4,default)
                             on conflict ("order_id") do nothing returning …                          -- I3
10:57:24.304 [2442] execute: update "orders" set "status" = $1, … where (… and "status" = ANY($3)) returning …
             DETAIL: $1 = 'delivered', $3 = '{delivering}'                                            -- I9
10:57:24.305 [2442] statement: commit

10:57:24.306 [2442] execute: update "payment_events" set "processed_at" = now()
                             where ("event_id" = $1 and "processed_at" is null) returning …
10:57:24.312 [2442] execute: select …, case when "orders"."status" = $1 then "deliveries"."code" end as "code"
                             from "orders" left join "products" … left join "deliveries" … where "orders"."id" = $2
             DETAIL: $1 = 'delivered'                              -- the page, now holding a key
```

Read that block twice. It is the entire assignment in fifty-three milliseconds, and there are exactly two
`begin`/`commit` pairs in it: the supplier's, and the shop's finishing write. **Neither of them contains the
HTTP call.**

And the shopper's side of the same run:

```
order id                : ord_01M1XR80QY5K2R01AEKEK2GECN
status before paying    : created  code: null
POST /simulate ack      : {"event_id":"evt_01M1XR80SMZXTY5JQKVQ0C7T4E","order_id":"ord_01M1XR80QY5K2R01AEKEK2GECN",
                           "status":"paid","amount":1290,"currency":"RUB","webhook_outcome":"stored"}
status right after ack  : delivered  code: X93K-NYAQ-GEC1
```

The page is a chained-`setTimeout` poll (`apps/web/src/pages/order/model/poll.ts`) that stops itself when
`isSettledOrderStatus` says the order has stopped moving. It never sees a key it should not: hop 13 makes an
undelivered order's key *not leave Postgres*, and `toOrderView` independently returns the literal `null` for
any status but `delivered`. Two stops on the same leak.

> *Interview answer:* "Thirteen hops, and every one of them is guarded by a statement rather than by a
> branch. The claim decides who may issue, the unique index on `deliveries.order_id` decides who may bind,
> and the supplier's ledger decides what a repeat gets. My code decides nothing that two processes could
> disagree about."

---

## 2. Why the attempt row is written before the supplier call

The service header states the ordering in capitals because it is the one thing in the file that cannot be
rearranged:

```
1. WRITE   record the attempt as `unknown`      (one statement, no tx)
2. CALL    POST {SUPPLIER_A_URL}/issue          (no transaction open)
3. WRITE   resolve the attempt + bind + finish  (one short transaction)
```

Step 1 writes a row whose `status` is `'unknown'` — always, on every path, with no other value reachable at
birth. Then it asks.

### What a timeout means if the row does not exist

Take the natural ordering — call the supplier, then write down what happened — and trace a function that
dies mid-call. Not a rare death: the platform's execution ceiling, an OOM kill, an instance recycled during
a deploy. **None of those runs a `catch` block, a `finally`, or an unwind.**

- **t0** the shop sends `POST /issue`.
- **t1** the supplier claims key `K`, writes `request_id → K` to its ledger, commits, starts writing 200.
- **t2** the shop's function is killed. No exception. No log line. No write.

On disk: the order is `delivering`, `issuance_attempts` is empty, `deliveries` is empty. On the *supplier's*
side, key `K` is claimed and paid for.

Now ask what any later worker — a Phase 2 drain, a Phase 3 retry, an admin — can conclude from that. It sees
an order in `delivering` and no attempt row. Two entirely different histories produce that exact state:

1. the claim committed and the process died *before* it ever called anybody;
2. the claim committed, a call went out, a key was issued, and the answer was lost.

Nothing on disk distinguishes them, and they demand opposite actions. Under (1) the right move is to issue
normally. Under (2) the right move is to re-ask **this** supplier with **this** id and bind whatever comes
back. And with Phase 3 present, a worker that reads "no attempts recorded" has the strongest possible licence
to start fresh — including falling through to supplier B with a new id, which is precisely the move
`architecture.md` §4 forbids while anything is outstanding. **The absence of a row reads as "we never asked",
and "we never asked" is a licence.**

Write the row first and that ambiguity is gone. The row says `unknown`, which means exactly *we asked and we
do not know*, and it says it from the instant it is written — so it is still saying it after a `SIGKILL`, an
OOM, or a ceiling. **No error handler has to run for the record to be correct, which is the only kind of
record that survives the failure modes it exists to describe.**

There is a second-order objection worth pre-empting, because it is the sharp one: *the `request_id` is
derived (§5), so a recovery could re-derive it and probe the supplier — why does it need the row at all?*
Correct, and the two mechanisms do different jobs. Derivation makes the question **re-askable**. The attempt
row records that the question was **asked**, by whom, of which provider, on which attempt number — which is
what the retry policy reads to decide whether anything is outstanding. Derivation alone tells you what
`req_ord_x_a_1` would be; it cannot tell you whether `req_ord_x_a_1` was ever sent, or whether attempt 2 to
supplier B has also gone out. The id is the address; the row is the evidence.

### The proof

An API instance was started with `SUPPLIER_A_URL=http://127.0.0.1:59999/internal/suppliers/a`, a port nothing
listens on:

```
nothing is listening on 59999
port 3004 -> 200                        (the shop instance itself is healthy)
pool before: total=50 unclaimed=48 ledger_rows=2
```

A real order, a real simulated payment, through the real endpoints:

```
order id            : ord_01M1XQYXVTXKPY25K18T2BX9KE
POST /simulate      : 200 {"event_id":"evt_01M1XQYXWCTEPRB1S5MYBQH1KT", … "webhook_outcome":"stored"}
elapsed ms          : 46
order page shows    : delivering  code: null
```

What the shop wrote down:

```
               request_id               | provider | status  | code | last_error
----------------------------------------+----------+---------+------+------------
 req_ord_01M1XQYXVTXKPY25K18T2BX9KE_a_1 | a        | unknown |      |
```

And what the supplier did about it — nothing, because it never heard the question:

```
 order_status | deliveries | events_pending | supplier_ledger_rows | keys_claimed_for_this_id | pool_unclaimed_after | ledger_rows_total
--------------+------------+----------------+----------------------+--------------------------+----------------------+-------------------
 delivering   |          0 |              1 |                    0 |                        0 |                   48 |                 2

--- what the supplier process (:3000) logged about this request_id ---
0
(0 = the supplier never saw it)
```

The pool is untouched at 48, the supplier's ledger is untouched at 2, and the supplier's own process log
contains zero lines mentioning that `request_id`. The shop's log says:

```
msg: 'supplier client: UNKNOWN outcome — no usable answer; a key may or may not have been issued',
order_id: 'ord_01M1XQYXVTXKPY25K18T2BX9KE',
request_id: 'req_ord_01M1XQYXVTXKPY25K18T2BX9KE_a_1',
provider: 'a',
detail: 'no response (TypeError: fetch failed)'
```

Here is the part that makes this a proof rather than a demo. **The on-disk state after a request the supplier
provably never received is byte-for-byte the state after a request it received and answered into a dead
socket.** That is not a weakness of the record — it is the record being honest. The shop genuinely cannot
tell those apart, and the row says so. Everything downstream (retry the same supplier, same id, never fall
through) is correct under both, which is exactly why it is safe to write one row for both.

Note also what the shop did *not* do: it did not raise, did not answer the payment provider with a `5xx`, and
did not move the order anywhere. `POST /simulate` returned `200` in 46 ms and the page shows `delivering` —
an honest state, not a stuck one.

A purist will point out that `ECONNREFUSED` is arguably definite: nothing was listening, so nothing can have
been issued. The client deliberately does not special-case it, and should not. At the shop's remove, a
connection refused may come from a load balancer in front of a supplier that is perfectly healthy, or from an
instance recycling between the SYN and the accept. The cost asymmetry settles it: a wrong `unknown` costs one
redundant probe that the ledger answers for free; a wrong `failed` costs a second key.

> *Interview answer:* "The row is written before the call because the failure it exists to record — the
> process dying between sending and reading — is exactly the failure that would stop it from ever being
> written afterwards. I proved the ordering by pointing an instance at a dead port: the attempt row says
> `unknown`, and the supplier's log has zero lines for that `request_id` and its pool is untouched. The row
> is correct without any handler running, which is the only kind of record worth having."

---

## 3. Why no transaction spans the HTTP call

`packages/db/src/client.ts`:

```ts
export const MAX_CONNECTIONS_PER_INSTANCE = 1;
const CONNECTION_TIMEOUT_MS = 10_000;
```

with a comment that spells out the trap: `connectionTimeoutMillis` "bounds two waits at once… With `max: 1`,
any statement issued while a transaction is open is queued, so this value is also *how long a statement may
wait behind an open transaction before it fails*."

`max: 1` is not a performance setting. It is derived from the deployment: on Vercel each concurrent request
is its own function instance with its own pool, so `max` answers "how many connections may **one in-flight
request** hold", and the answer is one. The consequence is absolute: **while a transaction is open on an
instance, that instance can run no other statement at all.**

So the obvious version —

```ts
await db.transaction(async (tx) => {
  await tx.insert(issuanceAttempts).values({ …, status: "unknown" });
  const code = await supplier.issue(request);          // ← a network call, inside BEGIN
  await tx.insert(deliveries).values({ …, code });
  await transitions.transitionWithin(tx, order.id, "completeDelivery");
});
```

— is shorter, reads better, and is genuinely atomic. It is also wrong in three separate ways, and it is worth
being able to name all three because an interviewer will only expect one.

**1. It holds the instance's only connection across an unbounded wait.** Everything else that instance wants
to do — another webhook, an order creation, a status poll — queues in Node behind `BEGIN`, for as long as the
supplier takes, up to `SUPPLIER_TIMEOUT_MS`. At `CONNECTION_TIMEOUT_MS` those queued statements stop being
slow and start being errors, and the error they raise ("timeout exceeded when trying to connect") names
nothing that would lead you to the supplier. The symptom is unrelated requests failing.

**2. It holds a row lock across the same wait.** The `orders` row was just updated to `delivering` inside
that transaction, so it stays write-locked until `COMMIT`. Any other statement touching that order — another
webhook's guarded `UPDATE`, a Phase 3 admin action — blocks for the length of a supplier call, not the length
of a statement. The whole point of the guarded update is that a loser finds out in microseconds.

**3. Locally, it self-deadlocks immediately.** The supplier stub is served by the same API process
(`SUPPLIER_A_URL=http://localhost:3000/internal/suppliers/a`), so the loopback request needs a connection
from the same pool of one — the one the transaction is holding. It waits ten seconds and fails. The statement
log in §1 shows this directly: the supplier's `begin` at `24.296` and `commit` at `24.299` are **on backend
`[2442]`, the same connection every shop statement used**. That only worked because the shop was holding
nothing at that moment.

Hence the shape, which is worth memorising as four words: **write, release, call, write.**

```
insert issuance_attempts …          -- one statement, its own implicit transaction, connection released
        ← HTTP →                    -- no transaction, no lock, no connection held
begin; update attempt; insert deliveries; update orders; commit
```

The positive evidence that nothing is held: with a supplier artificially slowed to 1500 ms, the same instance
answered a status poll every ~215 ms *throughout* the call.

```
t+  10ms  status=created  code=null
t+ 218ms  status=delivering  code=null
t+ 437ms  status=delivering  code=null
t+ 657ms  status=delivering  code=null
t+ 882ms  status=delivering  code=null
t+1105ms  status=delivering  code=null
t+1331ms  status=delivering  code=null
t+1560ms  status=delivering  code=null
t+1767ms  status=delivered  code=FEL3-GUXN-TCCH
```

Seven reads answered by the instance whose issuance was outstanding, each at the poll's own cadence and none
of them stalled. With the transaction wrapped around the call, every one of those reads would have queued
behind it.

### What is given up, and why it does not matter

Atomicity across the call, obviously. So the failure to reason about is a crash *after* the supplier answered
and *before* the finishing transaction commits.

Trace it: the attempt row still says `unknown`, no `deliveries` row exists, the order is still `delivering`,
and the payment event is still pending. That is exactly the state §2 describes, and it is recoverable by the
one move the system is built around — ask the same supplier the same `request_id`, get the same code from the
ledger (I5), bind it. **Nothing is lost, because nothing about the code was ours to lose.** The code lives in
the supplier's ledger, keyed by an id we can re-derive from the order id alone.

The same applies to a rollback of the finishing transaction: it reverts the attempt to `unknown`, binds
nothing, leaves the order `delivering`, and a later call with the same id is answered identically.

> *Interview answer:* "One connection per instance, so a transaction across an HTTP call stops that instance
> for the length of the call and holds the order's row lock while it does. Locally it is worse than slow —
> the supplier stub shares the process, so it deadlocks on the connection the transaction is holding. The
> shape is write, release, call, write, and I gave up atomicity across the call in exchange for a crash
> window that is recoverable by re-asking the same `request_id`."

---

## 4. Definite failure versus unknown outcome

This is the assignment's central trap, and it is a *data* distinction before it is a code one. It lives in
three places that agree by construction:

- `issuance_attempts.status` — `unknown` | `ok` | `failed` (`issuance-attempt-status.ts`);
- two typed error classes, `SupplierDefiniteFailure` and `SupplierUnknownOutcome`;
- `SupplierIssueError.attemptStatus` — an `abstract readonly` fixed by the subclass, with **no constructor
  parameter**, so the value written to the column is chosen by the class that observed the failure and cannot
  drift at the site that records it.

### The table

Every classification is made in `SupplierAClient`, at the one place that saw the wire:

| Observation | Classification |
| --- | --- |
| `2xx` + `{ status: "ok", request_id: <ours>, code }` | **issued** |
| `{ status: "error", reason: <known> }`, at any status code | **definite** |
| no response — timeout, connection refused, dead socket, DNS | **unknown** |
| a response whose body is not JSON | **unknown** |
| JSON that is neither contract shape | **unknown** |
| `{ status: "ok" }` echoing a `request_id` we never sent | **unknown** |
| an unrecognised `reason` | **unknown** |

One row is definite. Six are unknown. The governing sentence, from the client's own header:

> Every "cannot read it" lands on `unknown`, never on `failed`, and that is the conservative direction on
> purpose: **`failed` is a licence to ask a *different* supplier for a *second* key**, and it may only be
> issued when this supplier explicitly said no in a form we could read.

Note two things the table does *not* key off. It does not key off the status code — a `{ status: "error" }`
body arriving with a `200` is still a refusal, and a `409` with an unreadable body is still unknown. And a
timeout has no status code at all: no response, no headers, no body, nothing to parse. **A classification
scheme built on status codes would have no case to write for the one outcome the system exists to handle.**

The `request_id` echo check earns its line too. An `ok` body carrying somebody else's id is evidence about
*their* request, not ours; binding its code would deliver a key to the wrong order. It stays unknown.

### What goes wrong if an unparseable body were definite

Suppose `readCode` treated "I cannot read this" as a refusal — the reasonable-sounding "the supplier is
broken, give up and try the other one". Trace a sequence that happens on any real network:

- **t0** the shop sends `POST /issue` with `req_ord_x_a_1`.
- **t1** the supplier claims key `K`, writes `req_ord_x_a_1 → K` to its ledger, commits, answers `200`.
- **t2** something between them — a proxy, a load balancer, a gateway rewriting a response it thinks failed —
  replaces the body with an HTML error page. Or the supplier's own framework wraps it. Either way the shop
  receives bytes it cannot parse.
- **t3** the shop classifies **definite**, writes `issuance_attempts.status = 'failed'`.
- **t4** Phase 3 reads `failed`, and `failed` says *no key was issued*, so it falls through to supplier B with
  a **new** `request_id` — because that is the correct action for a definite failure.
- **t5** supplier B claims key `L` and answers cleanly. The shop binds `L` in `deliveries`.

The result: **two keys left two pools for one order.** `K` is claimed, paid for, bound to nothing, and
unsellable — `deliveries.order_id` is UNIQUE, so the order already holds `L` and there is no row for `K` to
go in. The shop's own tables record no anomaly at all: one order, one delivery, one key. The only trace of
the loss is a row in the supplier's `supplier_keys` with a `claimed_by_request_id` nobody will ever ask about
again. You find it by counting the pool, which is to say you find it when a customer cannot buy.

Classified as **unknown**, the same sequence ends correctly: the attempt stays `unknown`, no fallback fires,
and the retry asks A again with `req_ord_x_a_1`. The ledger hits, returns `K`, and `K` is bound. One key, and
the shop learns its own first answer, late.

**That is the whole asymmetry: a wrong `unknown` costs a redundant question; a wrong `failed` costs a key.**
There is no symmetric argument for the other direction, which is why the code has none.

### Both classifications, exercised

Two fake suppliers were stood up. The first answers a contract-shaped refusal:

```
HTTP 409  {"status":"error","reason":"out_of_stock"}
```

```
order: ord_01M1XR3PV7QTTE8MBV7FJNJ6G3
t+   9ms  status=created  code=null
t+ 224ms  status=out_of_stock  code=null
distinct statuses observed by the poll: created -> out_of_stock
```

```
msg: 'supplier client: definite failure — the supplier answered and refused',
request_id: 'req_ord_01M1XR3PV7QTTE8MBV7FJNJ6G3_a_1', provider: 'a', reason: 'out_of_stock', status_code: 409

msg: 'issuance: definite failure — supplier refused; order moved to out_of_stock, no delivery bound',
attempt_status: 'failed', status: 'out_of_stock'
```

The second answers `200` with an HTML page — the shape a gateway in front of a supplier produces:

```
HTTP 200  <html><body>502 Bad Gateway (from a load balancer that is not the supplier)</body></html>
```

```
order: ord_01M1XR5CAPCYR1TP3T56Z0609T
t+   6ms  status=created  code=null
t+ 215ms  status=delivering  code=null
t+ 441ms  status=delivering  code=null
…                                                (it stays there, correctly)

msg: 'supplier client: UNKNOWN outcome — no usable answer; a key may or may not have been issued',
detail: 'HTTP 200 with a body that is not JSON: "<html><body>502 Bad Gateway (from a load balancer that is not the supplier)</body></html>"'
```

And the four arms side by side, straight out of the database:

```
               id               | order_status | attempt_status |  last_error  | deliveries | events_pending | supplier_ledger
--------------------------------+--------------+----------------+--------------+------------+----------------+-----------------
 ord_01M1XQYXVTXKPY25K18T2BX9KE | delivering   | unknown        |              |          0 |              1 |               0   ← dead port
 ord_01M1XR3PV7QTTE8MBV7FJNJ6G3 | out_of_stock | failed         | out_of_stock |          0 |              0 |               0   ← definite
 ord_01M1XR5CAPCYR1TP3T56Z0609T | delivering   | unknown        |              |          0 |              1 |               0   ← unreadable body
 (the happy path)               | delivered    | ok             |              |          1 |              0 |               1
```

A `200` with an HTML body and a connection to a dead port land on the same row of that table. That is the
design working: from the shop's position they are the same fact — *no usable answer* — and the correct action
is identical.

Two smaller decisions in the same file, both defensible on their own:

- **An unrecognised `reason` is unknown, not definite.** Phase 3 adds members to `SupplierIssueErrorReason`.
  A shop running an older build against a newer supplier must not read a word it has never seen as permission
  to ask the backup for a second key.
- **`SupplierUnknownOutcome.detail` is documented as "for the log line only — deliberately *not* a
  discriminant a caller may branch on".** The moment "timeout" and "bad body" are handled differently, one of
  them has stopped being treated as unknown.

The classification is enforced by `instanceof` on two classes rather than by a string field, so if the two
`catch` arms in `issuance.service.ts` were ever collapsed into one, it would be a visible edit to typed code
rather than a silently widened comparison.

> *Interview answer:* "One row of the table is definite: the supplier answered with a body I could parse as a
> refusal. Everything else — timeout, dead socket, HTML, JSON of the wrong shape, an echoed id that is not
> mine — is unknown. It has to be asymmetric, because `failed` is permission to ask a second supplier for a
> second key. I tested it with a fake supplier that answers `200` with an HTML error page: the order stays in
> `delivering` with the attempt `unknown`, which is exactly what a supplier that already issued and got
> mangled by a proxy deserves."

---

## 5. Why `request_id` is derived, not generated

```ts
export function deriveIssuanceRequestId(orderId: string, provider: IssuanceProvider, attempt: number): string {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error(…);
  return `req_${orderId}_${provider}_${String(attempt)}`;
}
```

`req_ord_01M1XR80QY5K2R01AEKEK2GECN_a_1`. Pure, total, no dependencies, no clock, no randomness.

The obvious alternative is `randomUUID()` at the top of the issuance path, and it is wrong in a way that only
shows up in the one scenario the assignment is built around.

### What determinism buys a retry that has forgotten everything

The supplier's promise is `request_id → code`: ask twice with the same id, get the same code, no second key
(I5, Slice 4 §2). That promise is only usable by a client that can **phrase the same question again**.

A random id can of course be stored — that is what `issuance_attempts.request_id` is — and read back. But
then correctness depends on every future caller remembering to read it, and there are going to be several:
the Phase 2 drain, the Phase 3 automatic retry, the Phase 3 fallback decision, the admin re-issue. Each is a
separate code path written at a separate time. **The first one that forgets the lookup issues a duplicate key
and raises nothing anywhere.** No constraint catches it: `deliveries.order_id` UNIQUE stops the second key
being *bound*, but the key has already left the pool and been paid for; the shop simply loses it.

Derivation removes the thing to remember. Attempt 1 for `ord_x` on provider `a` recomputes to
`req_ord_x_a_1` in every process, on every machine, forever — including in a process that has never heard of
this order before and holds nothing but the id from the URL. A Phase 3 retry is therefore *one line* — call
`deriveIssuanceRequestId` with the same three arguments — rather than a query plus a null check plus a
decision about what to do when the row is missing.

That last clause matters more than it looks. With a random id, "the attempt row is missing" and "the id is
unknown" are the same condition, and the only available recovery is to mint a new id — which is the
double-issue. With derivation, a missing row costs nothing: the id was never in the row, it was in the order
id all along.

### Why a random UUID breaks the Phase 3 trap specifically

The trap: the supplier hangs past `SUPPLIER_TIMEOUT_MS`, answers anyway, and the shop must survive not
knowing. Play it with a UUID:

- attempt 1 goes out as `9f2c…`, times out. Attempt row written (assuming step 1 ran) with `status='unknown'`
  and `request_id='9f2c…'`. The supplier has issued key `K` against `9f2c…`.
- the retry runs. If it re-derives, there is nothing to derive — the id was random. So it must read the row.
- suppose the retry is on a cold instance after a deploy, or is the admin's manual re-issue, or is the branch
  that forgot. It generates `4b71…` and asks.
- the supplier's ledger misses on `4b71…` — correctly, it has never seen it — and issues key `L`.
- one order, two keys, and the shop's own tables show one delivery.

The ledger did nothing wrong. **A retry with a fresh id is not a retry; it is a second order placed with the
same supplier.** «Таймаут ≠ отказ» is only operative if the retry can ask *the same question*, and a random
id makes the same question unaskable.

### Why `attempt` is in the id at all, if a retry must reuse it

Because the policy has two retries and they are different questions (`architecture.md` §4):

- **after a timeout** — the outcome is unknown. Same provider, same `attempt`, therefore the same id: *"did
  my earlier request produce a key?"*
- **after a definite failure** — the outcome is known and negative. A different provider and a **new** id,
  because it is a new question asked of a supplier that has never heard it.

`attempt` is what lets the second exist without a random component. Phase 1 only ever issues
`FIRST_ISSUANCE_ATTEMPT = 1`; Phase 3 increments it. And `a` versus `b` in the segment is what makes the two
suppliers' ids un-confusable: `req_ord_x_a_1` and `req_ord_x_b_1` are different rows in `issuance_attempts`
and different keys in two different ledgers.

The `attempt` guard is not decoration either. A `NaN`, a float or a negative would each produce a *different*
string for what the caller believed was the same attempt — `req_ord_x_a_NaN` — and the failure would be a
second key, discovered by a customer rather than by a test. Cheaper to refuse to build the id.

> *Interview answer:* "Because a retry has to be able to ask the same question, and a random id makes that
> unaskable — the ledger misses and a second key leaves the pool. Storing the random id would work only as
> long as every future caller remembers to read it, and there will be four of them. Deriving it means there
> is nothing to remember: `req_{order_id}_{provider}_{attempt}` recomputes identically in every process."

---

## 6. `deliveries.order_id` UNIQUE is the guarantee; `ON CONFLICT` is politeness

The bind, in the finishing transaction:

```sql
insert into "deliveries" ("id", "order_id", "code", "provider", "request_id", "created_at")
values (default, $1, $2, $3, $4, default)
on conflict ("order_id") do nothing
returning "id", "order_id", "code", "provider", "request_id", "created_at";
-- 1 row  => THIS call bound the key. At most one caller ever sees this per order, across every process.
-- 0 rows => this order ALREADY has a delivery. Not an error and not a branch to re-issue on.
```

It is easy to read `ON CONFLICT DO NOTHING` as the mechanism. It is not. **The unique index
`deliveries_order_id_key` is the guarantee; `ON CONFLICT` only keeps the loser from raising.**

Proof, run against the delivered order from §8. First the same insert *without* the clause — which is what a
second worker would execute if somebody "cleaned up" the statement:

```sql
INSERT INTO deliveries (order_id, code, provider, request_id)
VALUES ('ord_01M1XQWE5FQX5956ZTRT3K7SKG', 'DUPE-0000-TEST', 'a', 'req_ord_01M1XQWE5FQX5956ZTRT3K7SKG_a_2');
```

```
ERROR:  duplicate key value violates unique constraint "deliveries_order_id_key"
DETAIL:  Key (order_id)=(ord_01M1XQWE5FQX5956ZTRT3K7SKG) already exists.
```

Then the shipped statement, same values:

```
 id | order_id | code
----+----------+------
(0 rows)
INSERT 0 0

 delivery_rows |     codes
---------------+----------------
             1 | LFXC-TNCS-BPCD
```

Zero rows, no exception, and the shopper still holds the key they were given. **Removing `ON CONFLICT` would
not break the guarantee — it would only turn the loser's no-op into a `23505`.** That is the whole difference
between the two statements, and it is worth being able to say it in one sentence, because the reviewer is
checking whether you know which half is load-bearing.

Two consequences follow from taking the index seriously.

**The zero-row path reads the winner back rather than trusting the code in hand.**

```ts
const existing = inserted ?? (await tx.select().from(deliveries).where(eq(deliveries.orderId, order.id)))[0];
```

Inside the transaction, so it sees the row that beat us however recently it committed. The log line and the
result then report *the key the shopper actually holds*, not the one this call happened to fetch. The code
this call obtained is discarded — not re-bound, not re-issued, not compared and warned about.

**`deliveries_request_id_key` is deliberately not a conflict target.** `deliveries` has a second unique
index, on `request_id`, and it is *not* named in the `ON CONFLICT`. A violation of it would mean one supplier
request bound to two different orders, which is not something to swallow: it raises, and it should. Choosing
the conflict target is a statement about which collision is ordinary traffic and which is a broken invariant.

### The alternative, and the specific failure it produces

```ts
const existing = await db.select().from(deliveries).where(eq(deliveries.orderId, id));
if (existing === undefined) await db.insert(deliveries).values(…);
```

Slice 1 measured exactly this, twenty concurrent sessions against a mirror table with the index removed:
**twenty delivery rows and twenty distinct keys for one order**, no error raised, every session's `if`
correct at the moment it ran. Under `READ COMMITTED` all twenty read a snapshot from before any of them
wrote. No lock in this process closes that window, because on Vercel the other worker is not in this process
— it is another function instance with separate memory.

`deliveries_order_id_key` is enforced by the one component every instance shares, and it is enforced **at
write time rather than at read time**, so there is no window at all.

---

## 7. The settle rule: ask the order, not the call

`payment_events.processed_at IS NULL` is both "pending work" and the queue itself. Deciding when to stamp it
is the most subtle decision in the slice, and the rule is one sentence:

> **Settle a `paid` event when the *order* has stopped moving — not when this *call* has finished.**

`isSettledOrderStatus` (from `@game-shop/contracts`, so Phase 3's `delivery_failed` is classified once, in
the package that owns the lifecycle) answers "stopped moving": `delivered`, `payment_failed`, `out_of_stock`.

### The four cases

| This call | The order afterwards | Event | Outcome name |
| --- | --- | --- | --- |
| won the claim, issuance delivered | `delivered` | **settle** | `delivered` |
| won the claim, supplier refused definitely | `out_of_stock` | **settle** | `out_of_stock` |
| won the claim, no usable answer | `delivering` | **leave pending** | `issuance_claimed` |
| lost the claim (zero rows) | ask the order: settled → **settle** (`no_op`); in flight → **leave pending** (`deferred_order_in_flight`) | | |

(And a fifth that predates this slice: no such order yet → leave pending, `deferred_order_missing`. That is
what the missing foreign key on `payment_events.order_id` exists to allow.)

**Case 3 is the one the rule was written for.** The winner reached the supplier, got silence, and the order
rests in `delivering` with an outstanding `request_id`. Settling here would take the only queue entry
pointing at a paid, undelivered order *out of the queue* — and this order genuinely needs somebody to come
back to it. Phase 3's retry is that somebody, and it finds the order by draining the queue.

**Case 4, the losing caller, is the one that looks wrong and is not.** Nineteen of twenty callers land here.
Every instinct says: I did nothing, therefore I am done, therefore settle. The reason not to:

`observed` — the status read back after the zero-row `UPDATE` — is **advisory**. Under `READ COMMITTED` the
row may have moved again between the update and the read. An order sitting in `delivering` is equally
consistent with *"a worker is mid-supplier-call right now"* and *"the worker that claimed it died between two
statements"*, and this caller cannot tell which. It cannot verify that anybody else still owns the work.

So the decision is made on the asymmetry of the mistake rather than on a guess:

- a needless pending row costs **a repeated no-op** — two guarded `UPDATE`s per drain pass that match nothing;
- a needless settle costs **the payment result, permanently** — nothing will ever look at that order again.

One direction is cheap and self-correcting. The other is silent and terminal. That is not a close call.

### The invariant it buys

> **An unfinished paid order always has at least one pending event pointing at it.**

That is the sentence to lead with, because it is what makes the queue usable. No drain has to work out which
of N racing events "owns" an order in order to be sure the outstanding work is still findable. It just reads
`processed_at IS NULL` and every unfinished order is in the result set, by construction. The alternative —
settling on the claim, which is tempting because the claim *is* the processor's last write — would produce a
queue that is empty while a paid order sits undelivered, which is the one state a work queue must never be
able to reach.

The price is stated in the code rather than discovered by a reviewer: *N* `paid` events for one order leave
*N* pending rows until the order settles. §8 shows nineteen of them.

### And it settles when the order does

The rule is self-clearing, which is what stops the queue growing forever. Case 4's first branch is exactly
that: a losing caller that observes a *settled* order stamps the event, because no future drain can know more
than this one did — nothing returns an order to `created` or `paid`, so the event can never apply. It was
caught live in the third race run of §8, where one straggler arrived after the order had already reached
`delivered`:

```
  37 observed_status: 'delivering'
  18 payment event: no-op, this call did not claim the order; left pending until the order settles
   1 observed_status: 'delivered'
   1 payment event: no-op, the order has already stopped moving          ← settled, correctly
   1 payment event: issuance delivered a key; the order is finished
   2 payment event: processed
```

Two events settled out of twenty in that run: the winner, and the one loser that arrived late enough to see a
finished order. The other eighteen are Phase 2's work.

> *Interview answer:* "The event is settled when the order stops moving, not when my call returns. A caller
> that lost the claim leaves it pending because it cannot tell 'someone else is working on it' from 'someone
> else claimed it and died' — and the two mistakes are not symmetric: a needless pending row costs a repeated
> no-op, a needless settle costs the payment result forever. What that buys is one invariant: an unfinished
> paid order always has at least one pending event pointing at it."

---

## 8. The headline scenario, measured

The graded scenario is *fifty parallel webhooks produce exactly one issuance*. This runs it at twenty, with
**distinct** `event_id`s — deliberately the harder shape, because twenty copies of one `event_id` would be
stopped by I2 at the inbox and never reach the lifecycle at all. Twenty distinct events all pass
`ON CONFLICT (event_id)`, all reach `markPaid`, all reach the claim. The only thing standing between them and
twenty supplier calls is one `WHERE` clause.

Four API processes on ports 3000–3003, one Postgres, one order, twenty requests released together and spread
round-robin across the four.

```
order: ord_01M1XQWE5FQX5956ZTRT3K7SKG  amount_minor=129000  status=created
--- 20 concurrent paid webhooks, distinct event_ids, one order, across 4 processes — 108 ms ---
http statuses: { '200': 20 }
errors (non-200): []
ack outcomes: { stored: 20 }
```

The database, which is the only assertion that counts:

```
 order_status | delivery_rows | attempt_rows | keys_claimed | ledger_rows | events_stored | events_settled | pool_left
--------------+---------------+--------------+--------------+-------------+---------------+----------------+-----------
 delivered    |             1 |            1 |            1 |           1 |            20 |              1 |        49

            order_id            |      code      | provider |               request_id
--------------------------------+----------------+----------+----------------------------------------
 ord_01M1XQWE5FQX5956ZTRT3K7SKG | LFXC-TNCS-BPCD | a        | req_ord_01M1XQWE5FQX5956ZTRT3K7SKG_a_1

               request_id               | provider | status |      code      | last_error
----------------------------------------+----------+--------+----------------+------------
 req_ord_01M1XQWE5FQX5956ZTRT3K7SKG_a_1 | a        | ok     | LFXC-TNCS-BPCD |
```

**One delivery row. One key out of a pool of fifty. One attempt. One ledger entry. Order `delivered`. Every
response `200`. Zero errors.**

Two repeat runs, same shape: 89 ms and 82 ms, both `delivered`, both one delivery / one attempt / one key /
twenty events.

### Which mechanism produced that, exactly

The log tally across all four process logs, re-ordered here into causal order (the counts are as counted):

```
  20 payment webhook: event stored, pending processing
  19 payment event: order was not in `created`; another path already applied a payment result
   1 payment event: applied, order moved to paid
   1 payment event: claimed the order for issuance
   1 issuance: attempt recorded as unknown BEFORE the supplier call
   1 supplier client: calling supplier over HTTP
   1 supplier: key claimed and recorded
   1 supplier A: answering 200 with a code
   1 supplier client: supplier returned a code
   1 issuance: key bound and order delivered
   1 payment event: issuance delivered a key; the order is finished
   1 payment event: processed
  19 payment event: no-op, this call did not claim the order; left pending until the order settles
```

Read it as a funnel. Twenty in; **one** line for the supplier call; **one** line for the key claim. The
losers were spread across all four processes — 4, 5, 5, 5 — so this is genuinely four processes racing, not
one process taking turns.

Now be precise about which invariant did what, because "the invariants held" is not an answer:

- **I2 filtered nothing.** Twenty distinct `event_id`s, twenty successful inserts. I2 is the *replayed event*
  scenario (Slice 3); it is not what wins this one, and saying otherwise would be claiming credit in the
  wrong place.
- **I9's guard did the first cut.** Twenty `markPaid` statements, one matched `{created}`, nineteen matched
  zero rows. That alone does not stop them: the nineteen deliberately continue to the claim, because
  "somebody else moved it to `paid`" and "somebody else moved it to `paid` and then died" look identical from
  here, and the claim is the statement that tells them apart.
- **I4 did the actual work — and only half of I4 exists.** Twenty `UPDATE orders SET status='delivering'
  WHERE id=$2 AND status = ANY('{paid}')` statements arrive at one row. Postgres serialises them on that
  row's write lock; the first finds `paid` and returns a row; the other nineteen block, and when the winner
  commits they **re-evaluate their `WHERE` clause against the new version of the row**, see `delivering`, and
  match nothing. That re-check under `READ COMMITTED` is the entire mutual exclusion. Nineteen callers
  stopped before the supplier because of one clause.
- **I6 claimed exactly one key.** One `request_id`, one `FOR UPDATE SKIP LOCKED` claim, pool 50 → 49.
- **I5 was not exercised.** One supplier call means the ledger read missed once and issued once. The
  same-`request_id` repeat path is Slice 4's proof, not this one's.
- **I3 never fired, and that is the point.** The bind inserted one row; `ON CONFLICT (order_id)` had nothing
  to refuse. I3 is the backstop, and its *not* firing is the evidence that the layer above it worked. If it
  had returned zero rows here, the claim guard would be broken.

The honest summary: **this scenario is won by hop 5 and audited by hop 10.** One `WHERE` clause decides, and
a unique index stands behind it in case the clause is ever weakened.

### Why the proof needs four processes

Same trap as Slice 4 §9, and it applies with full force here. `packages/db` sets `max: 1` per instance, so a
single process runs its statements one at a time on one connection. Two webhooks handled by one process
therefore never have their `beginIssuance` statements inside Postgres simultaneously — **the connection pool
serialises them in Node, before the database sees them.** A green run in one process is measuring the pool,
not the guard. Slice 4 measured this directly: a claim weakened to `SELECT`-then-`UPDATE` handed out twenty
distinct keys in one process and nine in four.

Two honest limits. Four processes on one machine is still weaker than the deployed shape, where concurrent
requests land in genuinely separate serverless instances — running this against the deployed URL is the
strongest form of the claim, and it is Slice 7's job. And twenty is not fifty; the scenario's number is fifty,
and the scripted version of this run is also Slice 7's.

> *Interview answer:* "Twenty distinct paid events for one order across four processes: one delivery row, one
> key out of fifty, order delivered, twenty `200`s, zero errors. What did it is the guarded update
> `WHERE status = ANY('{paid}')` — Postgres serialises the twenty on the row lock and re-evaluates the
> predicate after each commit, so nineteen match zero rows and stop before the supplier. `deliveries.order_id`
> UNIQUE is behind it and never had to fire, which is exactly what I want to be able to say about a backstop."

---

## 9. What is honestly not finished

Three things. All three were found by running the system, and all three are written down here rather than
left for a reviewer to notice.

### 1. The intermediate states are real but unobservable

`paid` and `delivering` are genuine rows in `orders` with genuine timestamps. But in this version the webhook
is processed **inline, before the acknowledgement** — `architecture.md` §4's four processing triggers do not
exist yet — so the whole chain from "payment reported" to "order delivered" runs inside one request.

Measured by the database's own clock, on one purchase:

```
status                   | delivered
order_created            | 10:51:54.544
event_received           | 10:51:54.574
delivery_written         | 10:51:54.593
order_updated            | 10:51:54.593
event_processed          | 10:51:54.598
ms_received_to_delivered | 19
```

Nineteen milliseconds from the event landing in the inbox to the order reading `delivered`. A page polling
once per second has roughly a one-in-fifty chance of catching `paid` or `delivering`, and in practice never
does:

```
--- the real supplier, no injected delay ---
t+   7ms  status=created  code=null
t+ 212ms  status=delivered  code=YPLV-QK2Z-IUS5
distinct statuses observed by the poll: created -> delivered
```

This is why the functional spec's §2.4 was reworded during Slice 5 verification, with a Change Log entry
dated 2026-09-07. The original criterion promised the page "shows each change"; it now promises that the page
updates itself without a reload, notes that the intermediate states usually last under a tenth of a second,
and says the page updates for whichever states it does observe. **The criterion now promises what a shopper
can actually check.**

The mechanism was nonetheless proven, by slowing the supplier to 1500 ms and polling the same endpoint the
page polls:

```
--- supplier slowed to 1500 ms ---
t+  10ms  status=created  code=null
t+ 218ms  status=delivering  code=null
t+ 437ms  status=delivering  code=null
t+ 657ms  status=delivering  code=null
t+ 882ms  status=delivering  code=null
t+1105ms  status=delivering  code=null
t+1331ms  status=delivering  code=null
t+1560ms  status=delivering  code=null
t+1767ms  status=delivered  code=FEL3-GUXN-TCCH
distinct statuses observed by the poll: created -> delivering -> delivered
```

The state machine, the read and the poll all work. What is missing is *latency to observe*, and that is a
consequence of where the processing runs, not of anything being wrong.

**Phase 2 fixes it by moving the work out of the acknowledgement path.** `waitUntil` returns the `200` and
continues processing after the response is sent; the drain triggers pick up anything left. The order then
sits in `paid`/`delivering` for as long as the supplier actually takes, which is what the page was written
for. The important detail is that nothing in this slice has to change for that: `PaymentEventProcessor` takes
a *stored row*, not a request body, precisely so the call site can move without the logic moving with it.

### 2. Nineteen pending events per raced order

Section 8's run left `events_settled = 1` of 20. The other nineteen sit with `processed_at IS NULL`,
correctly, by the rule in §7 — each was a losing caller that observed an order still in flight.

They are not lost and they are not harmful, but they are not free either. Until a drain exists, they simply
remain. When the Phase 2 drain arrives, each one is re-read once, runs two guarded `UPDATE`s that match
nothing, observes a settled order, and stamps itself. That is the cheap direction of a trade taken on
purpose: the alternative (settling on the claim) risks losing a payment result, and this risks running two
no-op statements per stale row.

Worth stating plainly, because a reviewer will spot the nineteen rows and ask: **they are not a leak, they
are the queue doing its job, and the last run in §8 caught one clearing itself the moment its order settled.**

### 3. `SELECT … FOR UPDATE` — half of I4 is missing

`architecture.md` §3.1 specifies I4 as a lock *and* a guard:

```sql
BEGIN;
SELECT * FROM orders WHERE id = $1 FOR UPDATE;
UPDATE orders SET status = 'delivering' WHERE id = $1 AND status = 'paid' RETURNING *;
COMMIT;
```

This slice ships the `UPDATE` and not the `SELECT … FOR UPDATE`. That is deliberate and it is a real gap, so
be exact about what each half does:

- **the guard makes the *transition* idempotent** — exactly one caller may leave `paid`, ever;
- **the lock serialises the *workers*** — it holds the order for the span of a multi-statement job.

The guard's exclusivity ends when its statement commits. In Phase 1 that is enough, because there is exactly
one entry point into issuance — the claim winner — and the only statements that move an order out of
`delivering` are the two this service issues. There is no second worker to serialise.

Phase 3 adds one: the automatic retry, and the admin re-issue. Then two workers can both be inside
`delivering` for the same order, neither of them trying to leave `paid`, so neither excluded by the guard.
With the same derived id (attempt 1) that is survivable — the ledger returns the same code (I5) and
`deliveries.order_id` UNIQUE binds it once (I3). With **different** attempt numbers it is not: worker A is
outstanding on `req_ord_x_a_1` while worker B asks `req_ord_x_a_2`, and a second key leaves the pool for one
order. That is the hard rule broken not by bad classification but by two workers who cannot see each other.

So the lock is not decoration deferred; it is the mechanism that makes the Phase 3 retry policy safe, and it
lands with the retry policy that needs it.

One more absence worth naming: `payment_events` has no drain claim yet either
(`SELECT … FOR UPDATE SKIP LOCKED LIMIT 1`), for the same reason — there is no second worker to hand a row
to.

---

## 10. Where this sits in the assignment

### What Slice 5 settles

| Graded scenario | After Slice 5 | What is still owed |
| --- | --- | --- |
| **Parallel webhooks → one issuance** | **Settled, end to end.** 20 distinct `paid` events across 4 processes: one delivery, one key, order `delivered`, twenty `200`s, zero errors. Both halves now proven — the shop's claim (§8) and the supplier's ledger (Slice 4). | The named script at fifty, and against the deployed URL — Slice 7. The `FOR UPDATE` half of I4 — Phase 2. |
| **Replayed `event_id`** | Settled in Slice 3 by `event_id` PRIMARY KEY; unchanged here, and now with something real behind it — a redelivery no longer re-enters an issuance that would call a supplier. | Nothing from this slice. |
| **Webhook before its order** | The path is intact: no FK, event stored, `processed_at` NULL, `deferred_order_missing`. | The drain triggers that pick it up — Phase 2. |
| **Empty pool → restock → recovery** | The shop half now exists: a definite refusal becomes `delivering → out_of_stock` with **no delivery row and no ledger entry**, the event settles, the page shows an honest state and keeps working. Proven with a supplier that answers `409 {"status":"error","reason":"out_of_stock"}`. | The admin list, the restock action and the manual retry — Slice 6 and Phase 3. |
| **Concurrent promo redemption** | Not started — Phase 5. | `UPDATE … WHERE used_count < max_uses RETURNING` and UNIQUE (`promo_id`, `order_id`). |

And the non-scenario deliverables this slice closes: the purchase spine («Купить» → key on the page) runs end
to end; `issuance_attempts` has a writer and its `unknown`/`ok`/`failed` column is populated by the class that
observed the outcome; `order_id`, `event_id` and `request_id` appear on every line in the payment and issuance
paths (`architecture.md` §8), which is what made every capture in this document readable —

```
msg: 'payment event: issuance delivered a key; the order is finished',
event_id: 'evt_ord_01M1XQWE5FQX5956ZTRT3K7SKG_01',
order_id: 'ord_01M1XQWE5FQX5956ZTRT3K7SKG',
request_id: 'req_ord_01M1XQWE5FQX5956ZTRT3K7SKG_a_1'
```

### What Slices 6, 7 and Phases 2–3 still owe

- **Slice 6** — the shopper-facing surface of the states this slice can now reach: `out_of_stock` rendered as
  an honest message rather than an error, and the `payment_failed` page with no pay controls.
- **Slice 7** — the named race and recovery scripts (`race:webhooks`, `race:same-event`,
  `webhook:before-order`, `recover:out-of-stock`, `recover:timeout`), each asserting **against the database**
  rather than the response, and each taking a base URL so the identical script runs locally and against the
  deployment. The measurements in this document are the rehearsal; those scripts are the deliverable.
- **Phase 2** — `waitUntil` and the four drain triggers (which makes §9.1 disappear), `Idempotency-Key` and
  I1, the drain's `FOR UPDATE SKIP LOCKED` claim, and the `SELECT … FOR UPDATE` half of I4.
- **Phase 3** — the retry policy itself. And this is the part worth stressing at the end: **everything Phase 3
  needs is already recorded.** The attempt row exists before the call, says `unknown` by construction, and
  carries the provider and the attempt number. The id is re-derivable from the order id alone. The
  classification that decides "retry this supplier" versus "fall through to the next" is already being
  written to `issuance_attempts.status` on every attempt, by the one class that saw the wire. Phase 3 adds a
  loop, a second `SupplierAClient` bound to supplier B's config, and `attempt + 1` — not a new mechanism.

The sentence to lead with: **this slice is where the shop stops describing its guarantees and starts
depending on them.** Slices 1–4 built constraints and proved them in isolation; Slice 5 puts a paid customer
behind them, and the only reason twenty simultaneous events produce one key is that not one decision in the
path is taken by application code.

---

## Ten questions, ten answers

1. *Walk me through what happens when someone clicks «Купить».* — Thirteen hops, every one guarded by a
   statement: `INSERT … SELECT` prices the order in Postgres; the simulator reads the amount from the order
   and POSTs a contract-shaped event over real HTTP; the webhook wins `ON CONFLICT (event_id)` (I2);
   `markPaid` and then the claim `beginIssuance` (I9, I4); an attempt row written `unknown`; the supplier call
   with the derived `request_id` (I5, I6 on their side); `INSERT INTO deliveries … ON CONFLICT (order_id)`
   (I3) and `completeDelivery` in one transaction; the event settles; the page's `CASE WHEN status =
   'delivered'` hands over the key.

2. *Why is the attempt row written before the supplier call?* — Because the failure it exists to record — the
   process dying between sending the request and reading the answer — is exactly the failure that would stop
   it from being written afterwards. It says `unknown` from birth, so a `SIGKILL` or an execution ceiling
   leaves a correct record with no handler running. Without it, "we asked and don't know" is indistinguishable
   from "we never asked", and only the second is a licence to ask a different supplier.

3. *How do you know the ordering actually holds?* — I pointed an instance at a dead port. The attempt row
   says `unknown`, the order rests in `delivering`, the event stays pending, and the supplier's process log
   has zero lines for that `request_id` with its pool and ledger untouched. The state on disk is identical to
   the state after a request that *was* received and lost — which is the record being honest, not vague.

4. *Why isn't the supplier call inside the transaction?* — `max: 1` per instance. A transaction across the
   call holds the instance's only connection and the order's row lock for the length of a network round trip,
   so unrelated requests queue and then fail at `connectionTimeoutMillis` with an error that names nothing
   useful. Locally it is worse: the supplier stub shares the process, so it deadlocks on the connection the
   transaction holds. The shape is write, release, call, write — and the statement log shows the supplier's
   `begin`/`commit` running on the same backend connection, which is only possible because the shop held
   nothing.

5. *What do you lose by not wrapping it, and why is that acceptable?* — Atomicity across the call. A crash
   after the supplier answered leaves the attempt `unknown`, no delivery, the order `delivering` and the event
   pending — recoverable by re-asking the same `request_id`, which the ledger answers with the same code.
   Nothing is lost because nothing about the code was ours to lose.

6. *Definite versus unknown — where is the line?* — One row is definite: a parseable
   `{ status: "error", reason: <known> }`, at any status code. Everything else — timeout, dead socket, HTML,
   JSON of the wrong shape, an unrecognised reason, an echoed `request_id` that isn't mine — is unknown.
   It has to be asymmetric because `failed` is permission to ask a second supplier for a second key. If an
   unreadable body were definite, a supplier that issued and got mangled by a proxy would trigger a fallback,
   two keys would leave two pools for one order, and the shop's own tables would record nothing wrong.

7. *Why derive the `request_id` instead of generating one?* — Because a retry has to be able to ask the same
   question, and the ledger only recognises the same id. A random id would have to be stored and re-read by
   four separate future callers — the drain, the automatic retry, the fallback and the admin re-issue — and
   the first one that forgets issues a duplicate key with no error anywhere. `req_{order_id}_{provider}_
   {attempt}` recomputes identically in every process, so there is nothing to remember. `attempt` is in it
   because falling through after a *definite* failure is a new question and needs a new id.

8. *`ON CONFLICT DO NOTHING` — is that your guarantee?* — No. The unique index `deliveries_order_id_key` is;
   `ON CONFLICT` only keeps the loser from raising. I ran the same insert without the clause and got
   `duplicate key value violates unique constraint "deliveries_order_id_key"`. Removing the clause would not
   break the guarantee, only turn a no-op into a `23505`. And `deliveries_request_id_key` is deliberately not
   a conflict target: one request bound to two orders is a broken invariant, not traffic.

9. *When is a payment event settled?* — When the *order* stops moving, not when the call returns. A caller
   that lost the claim leaves it pending, because it cannot distinguish "someone else is working on it" from
   "someone else claimed it and died", and the mistakes are not symmetric — a needless pending row costs a
   repeated no-op, a needless settle costs the payment result permanently. The invariant that buys: an
   unfinished paid order always has at least one pending event pointing at it.

10. *What is not finished?* — Three things. The intermediate states are real but complete in about 19 ms
    under inline processing, so a shopper cannot observe them; §2.4 of the spec was reworded with a dated
    Change Log entry, and the mechanism was proven by slowing the supplier until the page followed
    `created → delivering → delivered`. Phase 2's asynchronous drain restores the observable latency. Nineteen
    losing events stay pending until that drain runs — by design, and one of them was caught clearing itself
    the moment its order settled. And `SELECT … FOR UPDATE` is absent: the guard makes the transition
    idempotent, the lock serialises workers across a multi-statement job, and there is only one worker per
    order until Phase 3's retry adds a second.
