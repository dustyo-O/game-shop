# Slice 4 — The supplier's ledger, and why a repeat must return the same code

> Written for the author to read and re-explain from memory. Companion to `context/product/architecture.md` §3 (I5, I6), §3.1, §4 and §6.
> Slice 8 consolidates this and the other slice walkthroughs into the phase-level document.

## 1. What the supplier is, and what would become untestable if it were our inventory table

Slice 1 stated the rule: `supplier_keys` and `supplier_requests` belong to the simulated supplier, are never joined to a shop table, and live in the same database only so that one `docker compose up` runs the whole demonstration. This slice is the first code that touches them, so it is worth being precise about what the separation actually buys — because the shortcut is genuinely attractive.

The shortcut: the fifty keys are already in our Postgres. Issuance could be one statement inside the same transaction as the `deliveries` insert —

```sql
UPDATE supplier_keys SET claimed_by_request_id = $1 WHERE code = (…) RETURNING code;
INSERT INTO deliveries (order_id, code, …) VALUES (…);
COMMIT;
```

— atomic, no HTTP, no parsing, no timeout, one round trip instead of two. It is faster and shorter and it is the wrong answer, because five separate things stop being reachable.

**1. "A key was issued and we do not know it" becomes unrepresentable.** Inside one transaction the outcome is knowable by construction: it committed or it did not, and the process that ran it is told which. There is no third answer. The entire Phase 3 trap is that third answer. You cannot make it happen locally, so you cannot test the code that handles it, so you will not write that code.

**2. `request_id` has nothing to be.** With a local claim, "did this already happen?" is answered by our own transaction's commit. I5 loses its subject, `supplier_requests` becomes a table with no reason to exist, and the ledger read, the crash window and the whole of this slice disappear.

**3. The retry policy loses its two branches.** `architecture.md` §4 splits a definite failure (record it `failed`, fall through to supplier B with a **new** `request_id`) from an unknown outcome (record it `unknown`, retry **this** supplier with **the same** `request_id`, never fall through). A local `UPDATE` never produces `unknown`. `issuance_attempts.status` becomes a column with one reachable value, and the most interesting rule in the assignment guards nothing.

**4. Supplier B stops being a second supplier.** Over HTTP, B is a second address that can be slow, down, or lying. As local inventory it is `WHERE provider = 'b'` — a branch that cannot fail in any of the ways a network fails, so the fallback demonstration proves only that an `if` works.

**5. The distrust code becomes dead code.** A local claim cannot return a malformed body, a `502` from something that is not the supplier, or a `404` because `SUPPLIER_A_URL` was mistyped. Everything the shop writes to *parse and doubt* a supplier response has no input, so it is never exercised and quietly rots.

That is the honest answer to the obvious challenge, and it is worth saying in one line: **the shortcut does not make the hard requirement easier, it deletes it.**

The separation is enforced structurally rather than by convention. `SupplierAModule` provides `SupplierKeyClaimService` and has **no `exports` array at all** — so Slice 5's issuance module cannot inject it even by accident and must go through `POST {SUPPLIER_A_URL}/issue` like any other client. The claim service imports `supplierKeys` and `supplierRequests` and nothing else; it treats `order_id` as an opaque string it logs and forgets. And the endpoint deliberately sits at `/internal/suppliers/a/issue`, outside the `/api` namespace, because `/api` is the shop's and this is not the shop.

> *Interview answer:* "Because a key pool inside my own transaction cannot time out. If I take the shortcut, the state the whole assignment is about — 'a key may have been issued and I cannot tell' — is not merely rare, it is unrepresentable, and I would have deleted the hardest requirement by accident."

## 2. The ledger: `request_id → code` is the entire contract

The assignment's sentence, which everything below serves:

> «На повтор с тем же `request_id` поставщик обязан вернуть тот же самый код, а не выдать новый» — и поэтому «таймаут ≠ отказ».

`supplier_requests` is that promise, written down. `request_id` is the PRIMARY KEY and `code` is written once and never updated, so the supplier's answer is a pure function of the id it was asked with.

The first thing `issue()` does, before any key is touched:

```sql
-- I5 — one supplier request → one code. architecture.md §3.1.
execute <unnamed>: select "code" from "supplier_requests"
                   where "supplier_requests"."request_id" = $1
DETAIL: parameters: $1 = 'req_ord_00123_a_1'
-- 1 row  => this request_id HAS BEEN ANSWERED. Return that code and stop. No key
--           is claimed, nothing is written, and the answer is the same on the
--           thousandth call as on the second.
-- 0 rows => not answered *as of this snapshot*. First sight, so go and claim.
--           Note what this does NOT prove: a concurrent transaction may hold
--           this request_id uncommitted, and under READ COMMITTED we cannot see
--           it. The unique constraints settle that case, not this read — see §5.
```

Three live calls against the seeded pool, two of them sharing an id:

```
--- first call ---
HTTP/1.1 200 OK
{"status":"ok","request_id":"req_ord_00123_a_1","code":"LFXC-TNCS-BPCD"}
--- second call, same request_id ---
HTTP/1.1 200 OK
{"status":"ok","request_id":"req_ord_00123_a_1","code":"LFXC-TNCS-BPCD"}
--- third call, fresh request_id ---
HTTP/1.1 200 OK
{"status":"ok","request_id":"req_ord_00123_a_2","code":"P3EI-W8UO-9B4K"}
```

```
      code      | claimed_by_request_id        request_id     |      code
----------------+-----------------------    -------------------+----------------
 LFXC-TNCS-BPCD | req_ord_00123_a_1          req_ord_00123_a_1 | LFXC-TNCS-BPCD
 P3EI-W8UO-9B4K | req_ord_00123_a_2          req_ord_00123_a_2 | P3EI-W8UO-9B4K
```

Two calls, one key. A third id, a second key. The pool went from fifty to forty-eight, not forty-seven.

### Why this one property is worth a whole table

Follow what a client actually knows when its HTTP call times out. It knows it sent bytes and did not get an answer. Exactly three things may be true, and **nothing the client can observe distinguishes them**:

1. the request never arrived;
2. it arrived, a key was issued, and the *response* was lost;
3. it arrived and is still being worked on.

Without the ledger, both available actions are wrong under some branch. Retry, and under (2) you issue a second key — the pool drains, the shop pays twice, and one of the two keys is handed to nobody. Do not retry, and under (1) a paid order never gets a key at all. You are forced to pick a failure mode blind, and the *only* defensible choice is to give up, which is how a paid order ends with nothing.

With the ledger, the retry is correct under all three:

- under (1) the ledger misses, and the retry issues for the first time;
- under (2) the ledger hits, and the retry learns the code the first attempt got;
- under (3) the retry either blocks briefly and then hits the ledger, or loses a same-`request_id` race and is answered with the winner's code (§5).

So the ledger converts "no answer" from a terminal condition into a *missing observation* — and a missing observation can simply be taken again. **That is what «таймаут ≠ отказ» means operationally: a timeout is not a refusal, it is an answer you have not read yet.** Everything Phase 3 does — `unknown` rather than `failed`, retry the same supplier with the same id, never fall through to B while an attempt is outstanding — is downstream of that single sentence, and none of it is safe without this table.

Two further properties fall out of the ledger being *stored* rather than remembered. It survives the process, so a retry that lands on a cold serverless instance is answered as well as one that lands on the instance that issued. And two concurrent copies of the same request meet **in the same row** rather than in two instances' memory — which is the only place they can meet at all when they are running on different machines.

### Why the ledger read sits outside the transaction

Moving it inside would buy nothing. Under `READ COMMITTED` — the project's deliberate isolation level — a concurrent transaction holding the same `request_id` is invisible until it commits, whether the `SELECT` runs before `BEGIN` or after it. The guarantee comes from the unique constraints, not from where the read sits. So it sits where it is cheapest: outside, taking no locks, holding the instance's single connection for one round trip. This is the retry-after-timeout path, and it is deliberately the cheapest path in the file.

### The alternative that was declined

`supplier_keys.claimed_by_request_id` is already UNIQUE, so it *is* a `request_id → code` map. Dropping `supplier_requests` and reading that index instead would leave one write instead of two — no crash window at all, and §4 below would be unnecessary.

It was declined because §2.2 and §3.1 specify the ledger as the supplier's own table and I5 reads it, and because a real supplier's ledger outlives the inventory row it points at: keys get archived, re-keyed and rotated, and an idempotency record that vanishes when its inventory row does is not an idempotency record. Worth knowing as an answer, though — "why two writes when one would do?" is a fair question, and the answer is not "I didn't think of it".

## 3. The claim: one statement, and what zero rows means

```sql
-- I6 — one key → at most one request. Copied from what Postgres logged
-- under log_statement = 'all'.
execute <unnamed>: update "supplier_keys"
set "claimed_by_request_id" = $1, "claimed_at" = now()
where "supplier_keys"."code" = (
  select "code" from "supplier_keys"
  where "supplier_keys"."claimed_by_request_id" is null
  order by "supplier_keys"."id"
  limit $2 for update skip locked
)
returning "code"
DETAIL: parameters: $1 = 'req_ord_00123_a_1', $2 = '1'
-- 1 row  => this call now owns that key.
-- 0 rows => THE POOL IS EXHAUSTED — every key is claimed, or every remaining
--           candidate is locked by a concurrent claim. Not an error: the
--           transaction commits having written nothing and the caller is told
--           `out_of_stock`.
```

`EXPLAIN (ANALYZE)` against the seeded fifty-key pool, re-run for this document:

```
 Update on supplier_keys (actual rows=0 loops=1)
   InitPlan 1 (returns $2)
     ->  Limit (actual rows=1 loops=1)
           ->  LockRows (actual rows=1 loops=1)
                 ->  Index Scan using supplier_keys_unclaimed_idx on supplier_keys
                       Filter: (claimed_by_request_id IS NULL)
   ->  Seq Scan on supplier_keys
         Filter: (code = $2)
```

`LockRows` under `Limit` is the locking clause picking exactly one row, fed by the partial index `supplier_keys_unclaimed_idx (id) WHERE claimed_by_request_id IS NULL` — the subquery never looks at a sold key, and the index shrinks as the pool drains. The outer `Seq Scan` is the planner declining an index on a fifty-row table, which is the right call at this size.

### Why one statement and not a read then a write

The obvious version reads a free key, then claims it:

```ts
const [key] = await db.select().from(supplierKeys).where(isNull(claimedByRequestId)).limit(1);
await db.update(supplierKeys).set({ claimedByRequestId: requestId }).where(eq(code, key.code));
```

Between those two statements is a window every other concurrent request lives in. Measured, with the claim weakened to exactly that shape — `SELECT` then `UPDATE`, both *inside* the transaction, twenty concurrent requests each with a distinct `request_id`, driven through four connection pools:

```
--- claim weakened to SELECT-then-UPDATE, 20 distinct request_ids, 4 pool(s) of max:1 ---
codes handed to callers: 20  distinct: 9
rows claimed in supplier_keys: 9
errors: 0
```

Twenty callers, **nine distinct codes**. Eleven of them walked away holding a code that the database says belongs to somebody else, because the last `UPDATE` to touch a row wins. And note the last line: **zero errors.** Nothing raised. `UNIQUE (claimed_by_request_id)` cannot catch this, because every `request_id` here genuinely is unique — the constraint's job is "one request never holds two keys", and this is the other failure, "one key reaches two requests". That direction is protected by the row having a single `claimed_by_request_id` column *and by nobody being allowed to overwrite it*, which is precisely what the lock enforces. A shop built on this claim would deliver the same key to several paying customers and log nothing at all.

The shipped statement has no window: the subquery, the lock and the write are one operation Postgres executes atomically. There is no instant at which another transaction can observe a key as free and act on it.

### `SKIP LOCKED` rather than plain `FOR UPDATE` — and a correction

The intuition I started with was that plain `FOR UPDATE` would be *incorrect* here: twenty claims all select row 1, nineteen queue, and when the winner commits the waiters find the row no longer matches `claimed_by_request_id IS NULL`, so `LIMIT 1` has spent its candidate and they come back empty — a false `out_of_stock` against a pool that is 98% full.

**That is wrong, and it is worth saying so rather than repeating it.** Measured, twenty concurrent claims, each holding its lock 40 ms:

```
--- 20 concurrent claims, FOR UPDATE ---
wall clock for all 20 : 959 ms
slowest single claim  : 959 ms   median: 505 ms
distinct keys claimed : 20  told out_of_stock: 0

--- 20 concurrent claims, FOR UPDATE SKIP LOCKED ---
wall clock for all 20 : 54 ms
slowest single claim  : 54 ms   median: 51 ms
distinct keys claimed : 20  told out_of_stock: 0
```

Both are correct. Postgres re-evaluates the qualifier when the lock is released and moves on to the next unclaimed row, so plain `FOR UPDATE` hands out twenty distinct keys too. What it does not do is *scale*: the twenty claims form a convoy on row 1 and serialise, 959 ms against 54 ms — almost exactly twenty times the hold time, which is what a lock convoy looks like when you plot it.

So the reason for `SKIP LOCKED` is availability, not correctness, and in this deployment that distinction is thinner than it sounds. Each API instance holds **one** connection (`packages/db/src/client.ts`, `max: 1`), and a request waiting on a row lock is holding that connection for the whole wait. Fifty simultaneous webhooks would put fifty instances in a queue behind one row, each stalling its own instance; `connectionTimeoutMillis` is 10 s, so at the tail the convoy stops being slow and starts being errors. `SKIP LOCKED` says *a candidate someone else is already holding is not a candidate* — a claim that finds row 1 locked takes row 2 instead of queueing, and the twenty claims proceed in parallel because they are not contending for the same resource at all.

(The header comment in `supplier-key-claim.service.ts` says without `SKIP LOCKED` "forty-nine would wake up to find it taken". Read that as describing the serialisation, not an incorrect answer — as measured above they do each get a key. The costly part is the waiting.)

`ORDER BY id` is the third piece: the pool is handed out in seed order, which is what makes a drained-pool test reproducible and lets the partial index answer the subquery from an ordered scan.

## 4. The crash window, and the counterfactual that proves the fix

This is the centre of the slice.

Issuing for the first time means writing **twice**: claim the key, then record `request_id → code`. Between those two writes lies a state that must never be observable:

```
supplier_keys:     one row with claimed_by_request_id = R
supplier_requests: no row for R
```

Read what that state means to a retry. It arrives with `R`, reads the ledger, finds nothing, concludes "first sight", and goes to claim a key. That is the exact double-issue this service exists to prevent — produced not by a race, but by a crash.

And it is not hypothetical in this deployment. The process can die between those two writes for entirely ordinary reasons: the platform's function execution ceiling, an OOM kill, an instance being recycled mid-request, a deploy. None of them runs a `catch` block.

### The experiment

Two arms, differing in one thing: whether the two writes are one transaction. In both arms a child process runs the real claim statement against the real `supplier_keys`, announces that it has reached the window, and is `SIGKILL`ed there — no cleanup, no exception, no unwind, which is what a killed function actually looks like. Then the **real** endpoint is called over HTTP with the same `request_id`.

**Arm A — the naive version. Two writes, not in one transaction.**

```
=== ARM: naive — request_id req_crash_naive ===
child: claimed LFXC-TNCS-BPCD
AT_WINDOW
parent: SIGKILL sent to pid 72013 between the claim and the ledger insert
state on disk after the kill:
  supplier_keys claimed by req_crash_naive: 1 {"code":"LFXC-TNCS-BPCD","claimed_by_request_id":"req_crash_naive"}
  supplier_requests row for req_crash_naive: 0
retry with the same request_id -> HTTP 500 {"statusCode":500,"message":"Internal server error"}
state on disk after the retry:
  supplier_keys claimed by req_crash_naive: 1 {"code":"LFXC-TNCS-BPCD","claimed_by_request_id":"req_crash_naive"}
  supplier_requests row for req_crash_naive: 0
```

The torn state is on disk exactly as predicted: a key claimed by a `request_id` the ledger has never heard of. Then trace the retry, which is where it gets interesting:

- the ledger read misses — correctly, there is no row;
- the claim runs and takes the *next* free key, setting `claimed_by_request_id = 'req_crash_naive'` on it;
- `UNIQUE (claimed_by_request_id)` refuses, because that value is already on the first key. From the API log:

```
DrizzleQueryError: Failed query: update "supplier_keys" set "claimed_by_request_id" = $1 …
  cause: error: duplicate key value violates unique constraint "supplier_keys_claimed_by_request_id_key"
    code: '23505',
    detail: 'Key (claimed_by_request_id)=(req_crash_naive) already exists.',
    constraint: 'supplier_keys_claimed_by_request_id_key',
```

- the `23505` handler re-reads the ledger, still finds nothing, and rethrows — correctly, because there is no code it could honestly return;
- `500`.

**And it never recovers.** There is no unclaim in this schema; `claimed_by_request_id` is written once and never cleared. So every retry repeats identically:

```
--- three further retries, same request_id ---
retry 1 -> HTTP 500
retry 2 -> HTTP 500
retry 3 -> HTTP 500

 ledger_rows | claimed_keys
-------------+--------------
           0 |            1
```

One key permanently burned, one `request_id` permanently unanswerable, and — this is the part that matters upstream — **a paid order that can never be delivered by any amount of retrying.** The Phase 3 retry policy would keep the attempt `unknown`, keep re-probing the same `request_id`, and refuse to fall through to supplier B, exactly as it is designed to. It would be right to do so, and it would never terminate.

**Arm B — the shipped version. Both writes in one transaction.**

```
=== ARM: fixed — request_id req_crash_fixed ===
child: claimed LFXC-TNCS-BPCD
AT_WINDOW
parent: SIGKILL sent to pid 72042 between the claim and the ledger insert
state on disk after the kill:
  supplier_keys claimed by req_crash_fixed: 0
  supplier_requests row for req_crash_fixed: 0
retry with the same request_id -> HTTP 200 {"status":"ok","request_id":"req_crash_fixed","code":"LFXC-TNCS-BPCD"}
state on disk after the retry:
  supplier_keys claimed by req_crash_fixed: 1 {"code":"LFXC-TNCS-BPCD","claimed_by_request_id":"req_crash_fixed"}
  supplier_requests row for req_crash_fixed: 1 {"request_id":"req_crash_fixed","code":"LFXC-TNCS-BPCD"}
```

Same kill, same instant, nothing on disk. Postgres saw the connection die with a transaction open and aborted it, so the claim was rolled back and the key went back to the pool — note that the retry gets `LFXC-TNCS-BPCD`, the *same* key the killed attempt had taken. The pool lost nothing. The retry is an ordinary first issue, and it ends with one claimed key and one ledger row.

The whole difference between a permanently stuck order and a clean retry is `BEGIN … COMMIT` around two statements.

### The completeness argument

The reason this is a *fix* and not merely an improvement is that the two arms are not "usually fine" versus "usually broken" — every way the process can end maps onto one of exactly **two committed states**.

The claim and the ledger insert are inside one transaction, so the only two outcomes Postgres will ever publish are:

- **both writes**, if `COMMIT` is reached;
- **neither write**, otherwise.

And "otherwise" is genuinely exhaustive:

| How it ends | What Postgres does | Committed state |
| --- | --- | --- |
| The claim returns zero rows | the callback returns `out_of_stock`; the transaction commits having written nothing | neither |
| The ledger insert raises `23505` | Drizzle rolls back | neither |
| Any other exception in the callback | Drizzle rolls back | neither |
| `SIGKILL`, OOM, function execution ceiling | the backend sees the connection drop and aborts the open transaction | neither |
| Network partition between API and database | same — the backend aborts | neither |
| The database itself crashes | recovery replays the WAL, which contains only committed transactions | neither |
| Normal completion | `COMMIT` | both |

There is no row of that table that produces the torn state, which is why the service has **no repair path for it and should never grow one**. The state is not handled; it is unreachable. A reviewer who adopts an orphaned claim on a ledger miss is writing code to repair something that cannot exist — and, worse, code that would mask a genuine `23505` if the invariant were ever actually broken.

The retry is well-defined against both committed states, which is the property the whole design is for: on "both", the ledger read hits and returns the original code; on "neither", it misses and issues for the first time.

One layer beneath the transaction sits `UNIQUE (claimed_by_request_id)`, and it is what makes this defensible rather than merely plausible. **The transaction is code, and code can be changed; the constraint holds regardless.** Arm A is the proof: with the two writes torn apart, the constraint still refused to let one `request_id` hold two keys. It turned a silent pool drain into a loud `500`. That is a worse outcome than the fixed version and a far better one than the alternative.

> *Interview answer:* "The two writes are one transaction, so there is no instant where a key is claimed by a `request_id` the ledger has never heard of. I proved it by taking the transaction away and `SIGKILL`ing the process in that window: the retry then hits `23505` on `claimed_by_request_id` and returns 500 forever, because there is no unclaim. With the transaction, the same kill leaves the pool untouched and the retry issues cleanly."

## 5. The same-`request_id` race, and why it needs no retry loop

The crash window is the sequential hazard. The concurrent one is two calls carrying the same `request_id` arriving at the same instant — which is exactly what a client that timed out and retried produces, if the first call was merely slow rather than lost.

Both read the ledger. Both miss — legitimately, because under `READ COMMITTED` neither can see the other's uncommitted work. Both proceed to claim, and `SKIP LOCKED` (§3) *guarantees they take different rows*, because its whole purpose is to stop them queueing. Nothing prevents them from both claiming. So the collision is settled at commit time, by whichever unique index the loser reaches first:

- `supplier_keys_claimed_by_request_id_key`, if the winner's claim is already committed — or the loser blocks on the winner's pending index entry and is rejected the moment it commits; or
- `supplier_requests_pkey`, on the ledger insert.

Either way **the loser's whole transaction rolls back, which un-claims the key it had taken.** The pool loses nothing. By then the winner's ledger row is committed and visible, so the handler re-reads the ledger and returns the winner's code. One key claimed, both callers answered identically, no retry loop.

Twenty concurrent calls with one shared `request_id`, spread across four separate API processes:

```
--- 20 concurrent /issue calls, same request_id, across 4 process(es) — 52 ms ---
http statuses: { '200': 20 }
distinct codes returned: 1
  LFXC-TNCS-BPCD x20
errors (non-200): []
database: { claimed_keys: 1, ledger_rows: 1, distinct_codes: 1, pool: { total: 50, claimed: 1 } }
```

Twenty `200`s, one code, **one key gone from a pool of fifty**, zero errors. The log tally shows which path each request took:

```
key claimed and recorded                -> 1
lost a same-request_id race             -> 11
repeat of a request_id already answered -> 8
```

One winner. Eleven callers reached the claim, collided on a unique index, rolled back and were answered from the ledger. Eight arrived late enough to read the winner's row and never touched a key. Twenty answers, one key. Three repeat runs gave 1/7/12, 1/7/12 and 1/5/14 — the split moves with scheduling, the totals do not.

And the same twenty requests with twenty *distinct* ids, to show nothing is being over-serialised:

```
--- 20 concurrent /issue calls, distinct request_id, across 4 process(es) — 54 ms ---
distinct codes returned: 20
database: { claimed_keys: 20, ledger_rows: 20, distinct_codes: 20, pool: { total: 50, claimed: 20 } }
```

Twenty ids, twenty keys, no collisions, 54 ms.

### Why no retry loop, and why no deadlock

**No retry loop,** because the loser does not need to re-attempt anything. Its transaction rolled back cleanly and the answer it wanted is now committed by somebody else — so it reads the ledger once and it is done. A loop would be there to handle "try again and hope", and there is nothing to hope for: after the winner commits, the ledger read cannot miss. (If it somehow did, the original error is rethrown rather than guessed at. That would be an invariant violation, not traffic, and it should surface as one.)

**No deadlock,** and the argument is worth being able to give precisely. A deadlock needs a cycle in the wait-for graph. Here a transaction can only ever wait on the index entries for **its own `request_id`** — one in `supplier_keys.claimed_by_request_id`, one in `supplier_requests.request_id` — and it inserts the first before the second. So consider two transactions sharing an id: whichever inserts the `claimed_by_request_id` entry first proceeds without ever waiting, because the other cannot hold anything it wants; the other blocks there and is refused when the first commits. The second transaction can never be holding the ledger entry while waiting for the key entry, because reaching the ledger insert *requires* having already won the key entry. The wait-for graph has a single sink and no cycle.

The row locks cannot deadlock either: `SKIP LOCKED` means a transaction never waits for a row lock at all — it takes a different row.

## 6. The `DrizzleQueryError` defect — found by running it, not by reading it

The `23505` recovery in §5 was written before it worked. The guard that classifies the error started as the obvious thing:

```ts
if (error.code !== "23505") throw error;
```

and against a real database it rejected **nineteen of twenty** concurrent callers on one `request_id`. Every one of them was a case the service is supposed to answer correctly, turned into a `500`.

The cause, printed from a real `23505` raised through Drizzle:

```
error.constructor.name : DrizzleQueryError
error.code             : undefined
'code' in error        : false
error.cause.constructor: DatabaseError
error.cause.code       : "23505"
error.cause.constraint : "supplier_keys_claimed_by_request_id_key"
```

Drizzle wraps every driver error. The outer `DrizzleQueryError` carries the failed SQL and its parameters — useful, and the reason it exists — but **not** `code` and **not** `constraint`. Those live one level down, on the `pg` error, reachable through `cause`.

The failure mode is the nasty kind: the guard did not throw, did not warn, and did not look wrong. `error.code` was simply `undefined`, `undefined !== "23505"` is true, and every collision took the rethrow branch. A guard that silently never matches is indistinguishable from a guard that matches and finds nothing to do — until you look at what came back over the wire.

So `isUniqueViolation` walks the `cause` chain instead, bounded to eight levels so a cyclic `cause` cannot spin, and matches structurally on the SQLSTATE rather than on `instanceof pg.DatabaseError`. That is deliberate too: `apps/api` talks to Postgres through Drizzle and does not depend on the driver package, and Phase 6 weighed a swap to `@neondatabase/serverless` and kept `pg`; the argument does not depend on which. **The SQLSTATE is the stable part of that contract; the error class is not.**

Two lessons worth carrying, and the second is the more important one.

**Every layer between you and the database may wrap its errors, and a wrapper is not obliged to forward the fields you are matching on.** ORMs, drivers, connection pools, retry helpers and HTTP clients all do this. Any code that branches on `error.code`, `error.name` or `instanceof` is making an assumption about a wrapping scheme that nobody promised to keep stable — and the assumption fails silently, in the direction of "not my case".

**The database stayed correct the whole time the code was wrong,** and that is not luck. Look at what the buggy version actually did: it rethrew after the loser's transaction had already rolled back. The rollback is Postgres's, not the application's, and it happened whether or not the `catch` block understood what it had caught. So the invariants held perfectly — one claimed key, one ledger row, no double issue — while the API returned nineteen `500`s. The bug was entirely in *the answer given to the caller*, never in *the state on disk*.

That is precisely the split the whole project is built on: correctness lives in constraints and locks, and application code is what turns a correct outcome into a useful response. It is also the argument for the project's rule that **assertions query the database directly**. A test that only read HTTP status codes would have called this a correctness failure; a test that only read the database would have called it a pass. It takes both to see what actually happened.

> *Interview answer:* "I wrote the `23505` guard against `error.code` and nineteen of twenty concurrent callers got a 500. Drizzle wraps the driver error, and `code` is on the `cause`, not on the wrapper — so the guard silently never matched. What is worth noticing is that the database was correct throughout: the losing transactions had already rolled back. The bug was in the answer, not in the state, and only asserting against the database *and* the response shows you which is which."

## 7. Why `issued` and `already_issued` collapse into one response

Internally the service returns a three-way discriminated union: `issued` carries the code it just claimed, `already_issued` carries the code the ledger already held, `out_of_stock` carries no code at all (so `result.code` does not type-check until the caller has narrowed — the empty pool cannot be skipped by accident, only refused on purpose).

Over the wire the first two share a single `case` and produce byte-identical bodies. From the live run in §2, the first and second calls with the same id:

```
{"status":"ok","request_id":"req_ord_00123_a_1","code":"LFXC-TNCS-BPCD"}
{"status":"ok","request_id":"req_ord_00123_a_1","code":"LFXC-TNCS-BPCD"}
```

Both `200`. Not `201` then `200` — the endpoint answers `200` on both, overriding Nest's default for `@Post`, because a repeat creates nothing and **an endpoint whose entire promise is that the caller cannot tell first sight from a repeat must not announce the difference in its status line.**

The distinction survives only in the logs, on the supplier's side of the boundary:

```
[SupplierKeyClaimService] msg: 'supplier: key claimed and recorded', request_id: 'req_ord_00123_a_1'
[SupplierAController]     msg: 'supplier A: answering 200 with a code', code: 'LFXC-TNCS-BPCD'

[SupplierKeyClaimService] msg: 'supplier: repeat of a request_id already answered; returning the stored code'
[SupplierAController]     msg: 'supplier A: answering 200 with a code', code: 'LFXC-TNCS-BPCD'
```

Two different first lines, identical second lines. That is the shape to remember: **the difference is observable to the operator and invisible to the client.**

### Why hiding it is the feature

Because a client that could see the distinction would eventually act on it, and the first such action is wrong.

Suppose the response said `"already_issued": true`. The natural reading is "somebody already got this one" — and the natural handling is a warning, a reconciliation task, an alert, or worst of all a decision to *not* record the delivery because it looks like a duplicate. Now trace the ordinary Phase 3 sequence:

- attempt 1 goes out with `req_ord_00123_a_1`;
- the supplier claims a key and answers `200`;
- **the answer is lost** — the client's timeout fires, or the response is dropped in transit;
- the client records the attempt `unknown` and retries the same supplier with the same id, exactly as §4 of the architecture requires;
- attempt 2 is answered from the ledger.

Attempt 2 is flagged `already_issued`. But nothing anomalous has happened. The key was issued once, to this order, for this `request_id`, and this client has never seen the code before — it is receiving its own first answer, late. **A first attempt that succeeded and then timed out is, to the retry, indistinguishable from a first attempt that never arrived** — and it *should* be, because the correct action is identical in both cases: record this code as the delivery for this order.

So the distinction is not merely useless to the client; it is actively misleading. It labels the system's designed recovery path as an exception, and every use a client could make of that label makes the shop worse: alerting on a normal event, skipping a delivery that should be recorded, or falling through to supplier B when it must not.

The client's job is to bind whatever code came back to the order via `INSERT INTO deliveries … ON CONFLICT (order_id) DO NOTHING` (I3), which is idempotent on its own account. It does not need to know how many times it has asked, and the endpoint refuses to tell it — because an interface that cannot express a wrong distinction cannot have a client that acts on one.

## 8. The `409`, and why the family matters more than the digits

An empty pool is the one outcome this endpoint cannot answer with a code:

```
pool after draining: { total: 50, claimed: 50 }
empty pool  -> HTTP 409 {"status":"error","reason":"out_of_stock"}
ledger rows for req_after_empty: 0 (so the request_id is still unanswered)
same request_id after restock -> HTTP 200 {"status":"ok","request_id":"req_after_empty","code":"RSTK-0001-TEST"}
```

The reasoning that picks the status code starts with Phase 3's retry policy, which has two branches that are **not symmetric** (`architecture.md` §4):

- **Definite failure** — the supplier answered and said no. No key was issued, the attempt is `failed`, and the client may fall through to the backup supplier with a **new** `request_id`.
- **Unknown outcome** — no answer at all. The attempt is `unknown`, *never* `failed`; the client retries **this** supplier with **the same** `request_id`, and must never fall through while it is outstanding.

An empty pool is squarely the first, and provably so: the claim returned zero rows, so the transaction committed **having written nothing** — no key touched, no ledger row. There is no key, and we are certain there is no key.

That certainty is what rules out the whole `5xx` family before the choice of digits begins. `502`, `503` and `504` are what an intermediary emits when it could not reach a service or gave up waiting — they are the wire signature of an *unknown* outcome, and on Vercel they are exactly what a killed function produces. **Dressing the one outcome we are certain about in the costume of the ones we are not is how a client ends up routing "definitely no key" and "possibly a key" through the same branch** — which is the assignment's trap, sprung by its own stub. A `4xx`, by contrast, cannot be produced by a supplier that never ran.

Among the `4xx`s, `409 Conflict` is the one that describes the situation — RFC 9110 §15.5.10, *"the request could not be completed due to a conflict with the current state of the target resource"*. The state is the pool; the conflict is that it is empty. The alternatives and their specific costs:

- **`400`** would say the request is malformed. It is not, and the difference is operational rather than pedantic: a `400` means the shop's client is wrong and someone must change code; a `409` means inventory ran out and someone must restock.
- **`404`** is worse, because a mistyped `SUPPLIER_A_URL` also produces one. A routing mistake and an empty pool would be indistinguishable at the status line, and the first thing anyone would do is go looking for the wrong bug.
- **`200` with an error body** would make every client that checks `res.ok` believe it had a key.

`409` also happens to be true about retrying, which the last line of the capture shows: because `out_of_stock` writes nothing to the ledger, the `request_id` is still unanswered, and the identical bytes succeed once the pool is restocked. That is what lets Phase 3 re-drive an `out_of_stock` order through this same idempotent path instead of minting a new identifier — and note that restocking is *adding rows*, never clearing `claimed_by_request_id`, so no previously issued key can be resold.

### The caveat that keeps the policy honest

**The status code is a hint. The discriminator is the body.**

What tells the client "definite failure" is a parseable `SupplierIssueErrorResponse` — `{ status: "error", reason: "out_of_stock" }` — which is why the controller throws an object rather than a string (Nest serialises an object verbatim and wraps a string in its own `{ message, error, statusCode }` envelope, which would be a change to the interface, not to the prose).

The reason the body has to be load-bearing rather than the status: **a timeout has no status code at all.** There is no response, no headers, no body, nothing to parse. That is why `SupplierIssueResponse` in `packages/contracts` has no timeout member — the timeout is not a response the supplier can send, it is the *absence* of one, observed by the client's own clock. A retry policy that keyed off status codes alone would have no case to write for the one outcome it exists to handle.

## 9. Why the proofs needed four processes

Same trap as Slice 3, and it is worth restating in this slice's terms because the specific thing that hides here is different.

`packages/db` sets the pool to `max: 1` per instance, deliberately: a serverless instance serves one request at a time, so the pool's `max` is "how many connections may one in-flight request hold", and the answer is one. Locally, that has a consequence — a *transaction* checks out the single client for the whole of `BEGIN … COMMIT`, so **two claim transactions inside one process can never overlap.** They queue at the connection pool, in Node, before Postgres ever sees them.

Which means, in a single process:

- `FOR UPDATE SKIP LOCKED` never skips anything, because no second transaction is ever holding a row lock when the first looks;
- the row-lock contention `SKIP LOCKED` exists to avoid never occurs;
- and a claim written **without** any locking behaves identically to the shipped one.

That last point is the whole argument, and it is measured. The claim weakened to `SELECT`-then-`UPDATE` (§3), twenty distinct `request_id`s:

```
--- claim weakened to SELECT-then-UPDATE, 20 distinct request_ids, 1 pool(s) of max:1 ---
codes handed to callers: 20  distinct: 20
rows claimed in supplier_keys: 20
errors: 0

--- claim weakened to SELECT-then-UPDATE, 20 distinct request_ids, 4 pool(s) of max:1 ---
codes handed to callers: 20  distinct: 9
rows claimed in supplier_keys: 9
errors: 0
```

**The broken claim passes perfectly in one process.** Twenty callers, twenty distinct keys, no errors — a green run, against an implementation that hands the same key to eleven customers the moment there are four processes instead of one. A test the broken code also passes is not evidence, and a single-instance run of this endpoint is exactly that test.

The same-`request_id` race has a milder version of the same problem. In a single process the ledger read and the claim transaction are *separate* pool checkouts, so some interleaving does survive — but only a little. Three single-process runs produced 3, 0 and 0 losers out of twenty, against 11, 7, 7 and 5 across four processes. In two of the three single-process runs the `23505` recovery path — the whole of §5, the code that took a real defect to get right (§6) — **was not executed at all.** A green run there means "nineteen requests arrived after the winner committed", not "the collision is handled".

So the proofs ran four separate API processes on four ports, with the twenty requests spread across them: four pools of one, four independent connections, statements genuinely overlapping inside Postgres, and the only place the requests meet is the row.

**Two honest limits.** Four processes on one machine is still weaker than the deployed version, where concurrent requests land in genuinely separate serverless instances; running these against the deployed URL is the strongest form of the claim. And these prove the *supplier's* guarantees only. Nothing here has an order, a payment or a `deliveries` row — the shop's half of "a key is never handed to two orders" is Slices 5 and 7.

> *Interview answer:* "One process with a pool of one queues its transactions at the connection pool, so `SKIP LOCKED` never skips and a claim with no locking at all passes the test — I measured it: twenty distinct keys in one process, nine in four. The proof has to run in separate processes, or it is measuring the connection pool instead of the constraint."

## 10. Where this sits in the assignment

**What Slice 4 settles.** The supplier now keeps its two promises, both proven against the real database rather than asserted:

- **I5 — one `request_id` → one code.** A repeat returns the stored code, no key touched, `200` and a byte-identical body. Twenty concurrent copies of one id produced one key and one code.
- **I6 — one key → at most one request.** The claim is a single locking statement; `UNIQUE (claimed_by_request_id)` sits underneath it and was observed refusing a torn second claim in §4's Arm A.
- **The crash window is closed**, and closed in the strong sense: the torn state is unreachable, not repaired, with every way the process can end mapping to one of two committed states.
- **An empty pool is an ordinary outcome**, not an exception — a branch of the return type, a `409` with a parseable body, and a `request_id` left unanswered so a restock makes the identical retry succeed.

**What it sets up for Phase 3's timeout trap.** The trap is: hang the supplier past the client's `SUPPLIER_TIMEOUT_MS`, let it answer anyway, and require the shop to survive not knowing. Everything that makes that survivable is now in place and none of it needs to change:

- the ledger, so the retry gets the original code rather than a second key;
- `issued`/`already_issued` indistinguishable, so the retry cannot make a decision it has no business making;
- `409` with a body reserved for the certain outcome, so the `failed` versus `unknown` split has a wire signature to key off;
- `SUPPLIER_A_URL` and `SUPPLIER_TIMEOUT_MS` validated at boot, and the ordered chain **injected hang < `SUPPLIER_TIMEOUT_MS` < function execution ceiling** written down where whoever sets either value will read it. The right-hand inequality is the load-bearing one: when our client gives up first, the shop learns "no answer" as a *value* and records the attempt `unknown`; when the platform's ceiling arrives first the function is simply killed, with no exception, no log line and no attempt row updated — a timeout wearing the costume of a slow supplier. **A timeout must always be observed as a timeout, never as a killed function.**

Phase 3's failure and timeout injection goes at the *top of the controller*, above the service and never inside it, so the guarantees proven here are not weakened by the chaos that tests them. A hang injected *after* a successful claim is precisely the trap: a key genuinely issued, a client that cannot know it, and a retry on the same `request_id` that gets the same code back.

**What Slice 5 still has to build on top.** Everything on the shop's side of the boundary:

| Graded scenario | After Slice 4 | What is still missing |
| --- | --- | --- |
| **Parallel webhooks → one issuance** | The supplier half is settled: twenty concurrent calls on one `request_id` yield one key. | The shop half — `created → paid → delivering`, `FOR UPDATE` (I4) so the losers never reach the supplier, and `deliveries.order_id` UNIQUE (I3) as the backstop. Slice 5, proven at scale in Slice 7. |
| **Replayed `event_id`** | Untouched here; settled in Slice 3. | Nothing from this slice. |
| **Webhook before its order** | Untouched. | The drain triggers, Phase 2. |
| **Empty pool → restock → recovery** | Half-settled, and the harder half: the supplier answers `409` with a reason, writes nothing, and honours the identical retry after a restock. | The shop routing that to `delivering → out_of_stock` instead of raising (Slice 6), the admin list and the manual retry (Phase 3). |
| **Concurrent promo redemption** | Not started — Phase 5. | `UPDATE … WHERE used_count < max_uses RETURNING` and UNIQUE (`promo_id`, `order_id`). |

And the specific work Slice 5 owns: derive `request_id` as `req_{order_id}_{provider}_{attempt}` so a retry reuses the identifier without a caller having to remember it; record the attempt in `issuance_attempts` *before* the call, so a timeout has somewhere to be written down; call `POST {SUPPLIER_A_URL}/issue` over real HTTP with a deadline; parse an untrusted response; and bind the result with `INSERT INTO deliveries … ON CONFLICT (order_id) DO NOTHING`. The supplier is finished. What is left is the client that must not believe it.

The sentence to lead with: **this slice is where the system acquires something it is required to distrust.** Every decision in it — the separate tables, the empty `exports`, the real URL, the stored ledger, the two writes in one transaction, the response that refuses to say which branch ran — exists so that the shop has to earn its guarantees across a boundary rather than inherit them from a shared transaction.

## Nine questions, nine answers

1. *Why is the supplier a separate service when you control both sides?* — Because a key pool inside my own transaction cannot time out. The shortcut does not simplify the hard requirement, it deletes it: `request_id` has nothing to be, `unknown` becomes unreachable, and the fallback to supplier B is a branch that cannot fail the way a network fails.
2. *What is the supplier's contract?* — `request_id → code`, stored, forever. A repeat returns the same code and touches no key. Everything Phase 3 does rests on that one property.
3. *Why does that make «таймаут ≠ отказ» true?* — Because a timed-out client cannot distinguish "never arrived" from "answered and the answer was lost". With the ledger the retry is correct under both, so a timeout stops being a terminal condition and becomes an answer you have not read yet.
4. *Why one statement for the claim, and what does zero rows mean?* — Zero rows means the pool is exhausted: nothing was written and the caller is told `out_of_stock`. It is one statement because a `SELECT` followed by an `UPDATE` has a window — measured at nine distinct keys handed to twenty callers, with no error raised, because the constraint cannot catch that direction.
5. *Why `SKIP LOCKED` rather than `FOR UPDATE`?* — Both are correct; I measured it, and my first assumption that plain `FOR UPDATE` returns a false `out_of_stock` was wrong. What plain `FOR UPDATE` does is convoy: 959 ms versus 54 ms for twenty claims. With one connection per instance, a convoy is instances stalling, and at the tail it becomes errors.
6. *What is the crash window and how do you know it is closed?* — Claim and ledger are two writes; between them a key is claimed by a `request_id` the ledger has never heard of, and a retry would issue a second key. I removed the transaction and `SIGKILL`ed the process there: the retry hits `23505` on `claimed_by_request_id` and returns 500 forever, because there is no unclaim. With the transaction the same kill leaves nothing on disk and the retry issues cleanly. Every way the process can end maps to "both writes" or "neither".
7. *Two concurrent calls with the same `request_id` — what happens, and can it deadlock?* — Both miss the ledger, both claim different rows via `SKIP LOCKED`, the loser is refused by a unique index and its rollback un-claims its key, then it re-reads the ledger and returns the winner's code. No deadlock: a transaction only ever waits on the index entries for its own `request_id`, and reaching the second requires having won the first, so the wait-for graph has no cycle.
8. *Why can't the caller tell `issued` from `already_issued`?* — Because a first attempt that succeeded and then timed out looks, to the retry, exactly like one that never arrived — and the correct action is the same in both. Any use a client made of the distinction would be wrong: alerting on a normal event, or skipping a delivery it should record.
9. *Why `409` and not `503`?* — Because `5xx` is the wire signature of an *unknown* outcome, and an empty pool is the one thing we are certain about — the claim committed having written nothing. But the status code is only a hint: the discriminator is the parseable error body, because a timeout has no status code, no headers and no body at all.
