# Phase 3 · Slice 3 — Silence is not failure

> The requirement the whole phase turns on. A supplier goes quiet; the shop does not know whether a key was issued; and **neither available answer is true.** Calling it a failure buys a second key for an order that already has one. Calling it a success promises a shopper a code that may not exist. The only correct move is to go back and ask the same supplier the same question.
>
> Three things carry this slice. **A measurement that contradicts four documents** — `AbortSignal.timeout` severs the shop's own socket and does nothing at all to the supplier's handler, which is why a timeout is `unknown` rather than `failed`, and why the phase's headline check was staged backwards for two phases. **One rule enforced by the order branches are written in** rather than by a condition anybody could forget — proven by exhausting 894,049 ladder histories rather than by picking a few. And **a RED validation that had to look somewhere other than at the shopper**, because the shopper's key count physically cannot fail: a database constraint holds it at one while the key pool quietly loses a key.

---

## 1. What actually shipped

| # | Change | Where |
|---|---|---|
| 1 | **The inequality, corrected in five places.** The injected hang was documented as *shorter* than the client timeout — which produces no timeout at all | `context/product/architecture.md` §5, `apps/api/src/config/supplier-config.ts`, `.env.example`, `context/spec/.../technical-considerations.md` §7.1, and `.claude/agents/vercel-infra.md` |
| 2 | `0004_supplier_hang_placement` — `supplier_behaviour.hang_before_claim`, and `supplier-hang.ts` placing the injected hang **after** the key claim commits in both stubs | `packages/db/drizzle/`, `apps/api/src/suppliers/` |
| 3 | `readLedger` narrowed to `WHERE request_id = $1 AND provider = $2` — written since slice 2, read for the first time here | `apps/api/src/suppliers/supplier-key-claim.service.ts` |
| 4 | The **`probe`** and **`settleNeverEstablished`** rungs, `SUPPLIER_MAX_PROBES_PER_REQUEST`, and `countProbeWithin`'s narrow `ON CONFLICT … DO UPDATE` | `apps/api/src/issuance/` |
| 5 | The invocation budget logged at boot, and `SHUTDOWN_DRAIN_TIMEOUT_MS` moved from 5 000 ms to 3 000 ms | `issuance-runner.service.ts`, `tracked-continuation-scheduler.ts` |
| 6 | The exhaustion test: the hard rule checked against every history in a space of 894,049 | `apps/api/test/unit/issuance-ladder.test.ts` |

Change 4 is the slice's subject and change 1 is the reason it could be verified at all. Notice the shape of change 4: **two new branches, no new mechanism.** The `unknown` guard was already in the ladder from slice 2 — an order with an outstanding attempt already could not fall through. What it could not do was anything *else*: it rested, and rested for ever. `probe` and `settleNeverEstablished` narrow what rests. They make the resting place productive; they did not make it safe. It already was.

---

## 2. Keystone one — a timeout is not a failure, and that was measured

### What the client's deadline actually cuts

The shop's supplier call is one `fetch` with one deadline:

```ts
signal: AbortSignal.timeout(this.config.timeoutMs)
```

The choice of `AbortSignal.timeout` over racing a promise against a `setTimeout` is deliberate and it is about *this* process: the signal aborts the underlying socket, so the shop stops holding a connection open at the moment it gives up rather than waiting on a promise nobody will ever settle. It also covers reading the body, not just the headers — a supplier that answers `200` and then stalls mid-stream is a timeout too.

**What it does not do is stop the supplier.** It severs *our* socket. The remote handler keeps running. It may claim a key, write that key to its ledger, and finish answering into a connection that closed half a second ago.

That is not a theoretical concern; it is a measurable fact about how HTTP and Node work, and this is the measurement. A handler that claims at 400 ms, a client that gives up at 200 ms:

```
t+205ms  CLIENT: threw TimeoutError  => classified UNKNOWN
t+206ms  SERVER: socket aborted by the client
t+412ms  SERVER: KEY CLAIMED AND COMMITTED -> ledger=["KEY-0001"]
t+705ms  => the supplier's ledger holds ["KEY-0001"]; the client that timed out cannot know it.
```

Read the gap between lines one and three. **The key was cut 206 ms after the client had already given up and classified the call.** Any classification the client makes at t+205 is made in ignorance of an event that has not happened yet. There is no amount of care on the client side that fixes this — the information does not exist at the moment the decision is taken.

So the client's `catch` has exactly one honest thing to say, and it says it:

```
| Observation                                           | Classification |
| ----------------------------------------------------- | -------------- |
| 2xx + { status: "ok", request_id: <ours>, code }       | issued         |
| { status: "error", reason: <known> }, any status code  | **definite**   |
| no response (timeout, refused, dead socket)            | **unknown**    |
| a response whose body is not JSON                      | **unknown**    |
| JSON that is neither contract shape                    | **unknown**    |
| { status: "ok" } echoing a request_id we never sent    | **unknown**    |
| an unrecognised reason                                 | **unknown**    |
```

Every "cannot read it" lands on `unknown`, never on `failed`, and the asymmetry is the whole design. `failed` is not a description; it is a **licence to ask a different supplier for a second key.** It may only be issued when this supplier explicitly said no in a form the shop could parse. Note also that the discriminator is the *body*, not the status code: a `{ status: "error" }` arriving with a `200` is still a refusal, and a `500` with no body is still `unknown`. A timeout has no body at all, which is exactly why it cannot be read as an answer.

### The documentation said the opposite, in four places, for two phases

This is the part worth telling plainly, because it is the kind of error that survives review.

`architecture.md` §5, `apps/api/src/config/supplier-config.ts` and `.env.example` all stated the ordered chain as:

```
supplier's injected hang  <  SUPPLIER_TIMEOUT_MS  <  function execution ceiling
```

Read literally, that produces **no timeout at all.** The supplier hangs for less than the shop is willing to wait, the shop waits, the supplier answers, and the call completes normally. Staged that way, the phase's headline check passes having exercised nothing. Measured against a stub armed to the documented ordering: `NO TIMEOUT OCCURRED. A timeout check staged this way asserts nothing.`

The error is more interesting than a typo, and the interesting part is *why it read as correct*. The old text described a real and useful scenario — **a slow supplier is not a failed one** — while being cited as the basis for a different one. Both scenarios are worth having. They need opposite orderings, and only one of them is the trap:

| Scenario | Where the hang sits | Required ordering | What it demonstrates |
| --- | --- | --- | --- |
| Slow but successful | before the key claim, short | `hang_ms < SUPPLIER_TIMEOUT_MS` | a slow supplier is not a failed one — the call completes and nothing times out |
| **The timeout trap** | **after the key claim commits, long** | **`SUPPLIER_TIMEOUT_MS < hang_ms < ceiling`** | a key genuinely issued, a client that timed out and cannot know it, and a re-probe on the same `request_id` that gets the same code back |

The reasoning offered for the old direction conflated two events that must be kept apart, and keeping them apart is the whole of the correction:

- **The client giving up.** `AbortSignal.timeout` aborts the shop's socket. The supplier keeps running. The shop gets an exception, a `catch`, a log line and an attempt row that already says `unknown`. This is an event the shop can *record*.
- **The platform killing the function.** That is the execution ceiling's doing. No exception, no `catch`, no log line, no attempt row updated, and an order left in `delivering` holding a key that may or may not exist.

`SUPPLIER_TIMEOUT_MS < ceiling` is what stops the second from pre-empting the first, and it holds in **both** rows of the table: *a timeout must always be observed as a timeout, never as a killed function.* That is the term the old chain got right. `hang_ms` is not the shop's variable at all — it is the supplier's knob, armed per check — and putting it on the same side of the inequality as the shop's deadline is what made the two look like one rule.

**A fifth copy lived somewhere worse.** `.claude/agents/vercel-infra.md` is an *agent briefing* — instructions handed to whichever agent next touches supplier timing. A wrong rule there does not sit still and wait to be read; it gets re-injected into the next piece of work. It now carries the corrected form and the measurement beside it.

### The placement is a column, because there are exactly two honest places

`hang_ms` was always a column. The *placement* was not, and without it a reviewer cannot arrange the two scenarios above without rebuilding the API — which is precisely what functional spec §2.7's fourth criterion forbids: *reproduced without changing the shop itself.*

Migration `0004_supplier_hang_placement` adds one boolean:

```sql
ALTER TABLE "supplier_behaviour" ADD COLUMN "hang_before_claim" boolean NOT NULL DEFAULT false;
ALTER TABLE "supplier_behaviour" ALTER COLUMN "hang_before_claim" DROP DEFAULT;
```

A boolean rather than a `hang_at` enum, and the reason is a fact about the code rather than a simplification. **The key claim and its ledger write are one transaction.** A hang is therefore either before that transaction or after it commits — there is no third honest position. The only third value anybody would reach for is *inside* it, and that one must never exist: it holds the instance's single pooled connection (`max: 1`, the serverless shape) for the whole of `hang_ms` and stalls every other request in the process, including the re-probe the trap is staged to observe. A two-valued column cannot express it. An enum would offer it a name and a place to sit.

The column is named for the *exceptional* placement on purpose. The control endpoint `PUT /internal/suppliers/:provider/behaviour` **replaces the row rather than merging into it**, so an omitted field takes the seeded baseline — and the baseline has to be the scenario a reviewer arming a bare `hang_next` actually wants. That is the trap. A `hang_after_claim` column would have had to seed `true`, i.e. a baseline row that is not all-zero.

And the `DEFAULT` is dropped immediately after it has done its one job of backfilling two existing rows. Left in place, a future half-written `INSERT` would arm a placement nobody chose and look deliberate doing it. With it gone, that insert takes a `23502` instead. The database agrees: `hang_before_claim | boolean | not null |` with an empty default column.

All three facts — whether to hang, for how long, and where — come out of the **one statement that spends the one-shot counter**, so a concurrent `PUT` cannot move the placement between the decision and the wait:

```sql
UPDATE supplier_behaviour SET hang_next = hang_next - 1, updated_at = now()
WHERE provider = $1 AND hang_next > 0
RETURNING hang_next, hang_ms, hang_before_claim;
-- 1 row  => THIS call hangs, for THAT long, in THAT place.
-- 0 rows => none left; fall back to hang_rate. NOT an error.
```

---

## 3. Keystone two — re-asking the same supplier is safe; asking a different one is not

### Two rules that are one rule

The ladder never invents an identifier. It chooses three arguments and the identifier follows:

| Rung | provider | attempt | id |
|---|---|---|---|
| `askFirst` | `a` | `1` | `req_x_a_1` |
| `probe` | **same as the outstanding attempt** | **same** | **byte-identical, recomputed not remembered** |
| `fallThrough` | next untried | **`max(attempt) + 1`** | `req_x_b_2` |

`deriveIssuanceRequestId(orderId, provider, attempt)` is pure, total and dependency-free. **Nothing in the issuance path reads `issuance_attempts.request_id` in order to reuse it.** The probe rung takes `provider` and `attempt` off the outstanding row, hands those same three arguments to the derivation, and gets the same string back. `request_id` is a column this file could delete tomorrow without changing a single id it produces.

That property is what lets the two rules coexist without either being a special case:

- **A re-probe reuses the id byte-identically**, because that is the only phrasing the supplier's ledger (I5) can answer with *the code it already issued* instead of cutting a second key. The supplier's promise — *«на повтор с тем же `request_id` поставщик обязан вернуть тот же самый код»* — is keyed on the string. One byte different and it is a new question.
- **A fall-through mints a new id**, because it is *a different question asked of a different party*. Supplier B has never heard of `req_x_a_1` and has no reason to. Asking B under A's id would be asking B to look up something in a ledger it never wrote — and B would answer by cutting a fresh key, which is exactly the thing being avoided.

So it is one rule with two readings, not two rules: the id is `deriveIssuanceRequestId(orderId, provider, attempt)`, and the rung picks the three arguments. A re-probe changes none of them. A fall-through changes two.

The `attempt` number being counted **per order rather than per provider** is what makes the difference representable at all; that decision was made one slice earlier and `docs/walkthrough/phase-3-slice-2-a-backup-supplier.md` §2 is where it is argued.

### The hard rule: never fall through while any attempt is `unknown`

Here is what an `unknown` attempt actually means, stated in the form that makes the rule obvious: *a key may already have been issued under this request id and we did not hear the answer.* Asking a **different** supplier is asking a **different** question, so the first supplier's ledger cannot answer it, and a second key leaves the pool.

The rule is not implemented as a condition. It is implemented as the **order the branches are written in**:

```
1. No attempts                                   → askFirst
2. Any attempt not definitely settled, asks left → probe
3. Any attempt not definitely settled, asks spent→ settleNeverEstablished
4. Any attempt says `ok`                         → rest (a code already exists)
5. All settled refusals, an untried supplier left→ fallThrough
6. Every supplier refused                        → settleRefused
```

Branches 2 and 3 are above branch 5, and **that placement is the enforcement**. An order with an outstanding attempt cannot *reach* the `fallThrough` branch. The rule is unrepresentable rather than merely obeyed. There is no ordering of these six branches that both honours the rule and puts a settlement below a fall-through.

Two details in there are easy to skim past and both are load-bearing:

- Branches 2 and 3 scan **every** attempt, not the newest one. A shop that checked only the newest row would fall through past an outstanding `a/1` the moment a later row existed for any reason.
- `max(attempt)` is *computed from the set*, not read off position 0, even though the query that feeds it returns rows `ORDER BY attempt DESC`. A ladder whose correctness depended on an `ORDER BY` in a different file is a ladder with an invisible precondition.

### Proven by exhaustion, not by examples

"Unrepresentable" is a claim about *every* input, so it is checked against every input in a space small enough to enumerate. The space is built one axis per branch the ladder takes, and **every axis includes a value the database can hold but this build does not recognise** — because `provider`, `status` and `last_error` are `text` columns with no CHECK, and a migration, a seed or a `psql` session can put anything in them:

| Axis | Values | Why |
| --- | --- | --- |
| `provider` | `a`, `b`, **`c`** | head, backup, and one this build cannot address at all |
| `attempt` | `1`, `2` | distinguishes `max(attempt)`, and **collides** across rows |
| `status` | `ok`, `failed`, `unknown`, **`in_flight`** | settled, settled, outstanding, and unrecognised |
| `probeCount` | `1`, `3` | below the budget, and at it |
| `lastError` | `null`, `out_of_stock` | the two sides of the out-of-stock decision |

96 distinct rows; every ordered tuple of length 0 to 3. Histories that cannot occur through correct code are included deliberately, since `UNIQUE (order_id, attempt)` is a promise the *database* makes and this function must not assume it was kept. Re-run while writing this document:

```
alphabet rows: 96
histories checked: 894049
histories containing an unsettled attempt: 781104
VIOLATIONS (unsettled -> anything but probe/settleNeverEstablished): 0
histories reaching fallThrough: 8152
  of those, fully settled: 8152
histories reaching probe: 260368
histories reaching settleNeverEstablished: 520736
```

**Not vacuous, which is the half that makes it mean anything.** A guard that returned `rest` for everything would satisfy the conditional and prove nothing. 8,152 histories *do* reach `fallThrough` — every one of them fully settled — and 260,368 reach `probe` while 520,736 reach `settleNeverEstablished`. The test asserts all four counts are non-zero, and asserts the total is exactly `1 + 96 + 96² + 96³`, so a refactor that silently shrinks the space cannot make it pass by checking less.

Two mutations were run against the same space to show the assertion can fail. Both reproduce exactly:

```
control (tree as it stands):                          VIOLATIONS = 0
mutant: guard reordered below fallThrough:            VIOLATIONS = 620336
mutant: isDefinitelySettled flipped to `!== unknown`: VIOLATIONS = 265560
```

### Why the guard is a negation, and why the test refuses to import it

```ts
function isDefinitelySettled(attempt: IssuanceLadderAttempt): boolean {
  return attempt.status === IssuanceAttemptStatus.Ok
      || attempt.status === IssuanceAttemptStatus.Failed;
}
```

Not `status === 'unknown'`. `issuance_attempts.status` is `text` with **no CHECK** — deliberately, because the value set belongs to this policy rather than to the schema. A row written by a future migration, by `psql`, or by a build that knows a fourth status would satisfy `status !== 'unknown'` and unlock a fall-through past an outstanding request. The negation makes *"unrecognised"* behave like *"unknown"*, which is the only reading that cannot issue a second key. That is what the 265,560-violation mutant demonstrates: flipping this one predicate to the positive form is enough to break the rule on a quarter of a million histories.

The second mutant's 620,336 violations demonstrate the other half — that the branch *order* is doing the work, not a condition somebody could restore.

And the test writes its own predicate out longhand — `row.status !== "ok" && row.status !== "failed"` — rather than importing `isDefinitelySettled`. This is worth naming because it looks like duplication and is not: **a check that imports the definition it is checking will agree with that definition however it changes, including into the flipped version this assertion exists to catch.** The same argument is why the request ids in that file are transcribed rather than derived.

The provider axis earns its unrecognisable third value the same way. If an outstanding row names a supplier this build has never heard of, the probe cannot even be *phrased* — `deriveIssuanceRequestId` takes a narrowed `IssuanceProvider`. The conservative answer is **not** to fall through, which is the one thing an outstanding attempt forbids, but to settle as never established. An unaskable outstanding request is exactly that.

### On the give-up path, nothing is written to `issuance_attempts`

This is the sharpest statement of the whole phase, and it is an *omission*, so it has to be pointed at.

Compare the two transactions statement for statement. The refusal transaction:

```
BEGIN;
  SELECT … FROM orders WHERE id = $1 FOR UPDATE
  UPDATE issuance_attempts SET status = 'failed', last_error = $2 WHERE request_id = $3
  SELECT … FROM issuance_attempts WHERE order_id = $1 ORDER BY attempt DESC
  -- act on the recomputed rung
COMMIT;
```

The silence transaction:

```
BEGIN;
  SELECT … FROM orders WHERE id = $1 FOR UPDATE
  -- DELIBERATELY NO WRITE TO issuance_attempts.
  SELECT … FROM issuance_attempts WHERE order_id = $1 ORDER BY attempt DESC
  -- act on the recomputed rung
COMMIT;
```

**The only difference is the missing `UPDATE`, and that missing statement is the phase in one line.** A timeout is `unknown`, never `failed`, and the difference is not a log level — it decides whether a different supplier may be asked a different question while a key may already be sitting in this one's ledger.

The same holds at the end of the road. When the probe budget is spent, `settleNeverEstablished` moves the **order** to `delivery_failed` with a guarded `UPDATE` and touches the attempt row not at all:

```sql
update "orders" set "status" = $1, "updated_at" = now()
where ("orders"."id" = $2 and "orders"."status" = ANY($3))
returning …;
-- $1 = 'delivery_failed', $3 = '{delivering}'
```

The attempt row already says `status = 'unknown'`, `last_error` NULL, `probe_count` at its ceiling — and **that is the record.** Writing `failed` there would be a claim nobody can support, and there is nothing truthful to write instead, which is why the rung carries an order transition and no attempt-row change at all.

The distinction a reviewer will press on, so it is worth having ready: `orders.status = 'delivery_failed'` is a statement **about the shop** — *we did not hand over a key*. `issuance_attempts.status = 'unknown'` is the statement **about the supplier** — *never established*. They live in different tables because they are different facts, and functional spec §2.2's fourth criterion — *"the record shows the outcome was never established, rather than showing it as failed"* — is satisfied by the second one.

### Why the silence transaction exists at all

If nothing is written about the attempt, why open a transaction? Because the **rung that follows must be computed from rows read under the order row lock.**

The ladder is the one decision in this codebase that Postgres cannot take inside a single guarded statement. Every other invariant is a `ON CONFLICT`, a `WHERE status = ANY(…)`, a `used_count < max_uses` — one statement, evaluated by the database against the row. *"Which supplier is next"* is a function of a **set** of rows, and no single statement evaluates it. So the exclusion has to come from the order row lock taken one statement earlier.

What goes wrong without it is precise. Two workers reading *different* snapshots compute *different* rungs: one reads `[a/1 failed]` and computes `fallThrough → b/2`; the other reads `[a/1 failed, b/2 unknown]` and computes something else. Two genuinely different questions are asked, and the supplier's ledger cannot help because it is keyed on `request_id` and these are two of them. **Two keys leave the pool.**

Two workers reading the *same* snapshot are fine, and it is worth being honest that this is the common case. The lock is not defending the ordinary path; it is defending the one where the snapshots differ. In the phrasing the lock service already uses: **the lock serialises the workers; the ladder's `unknown` guard decides. Both, or neither is enough.**

The probe's own increment is then written inside that same transaction, so the count that bounds the loop is committed before the next pass reads it:

```sql
insert into "issuance_attempts" (…) values (default, $1, $2, $3, $4, $5, $6, default, default, default)
on conflict ("request_id") do update
  set "probe_count" = "issuance_attempts"."probe_count" + $7
returning "probe_count";
-- $5 = 'unknown' — always. A row is never born in any other state.
-- $6 = 1, $7 = 1
-- 1 row => ALWAYS. Unlike DO NOTHING, DO UPDATE returns the row on both paths.
```

**`DO UPDATE` touches `probe_count` and nothing else, and the omission is the design.** On the probe path the row **may already say `ok`** — the supplier answered the previous ask, another transaction wrote the code, and this worker had already decided to probe. A `SET status = 'unknown'` alongside the increment, which is the obvious thing to write since every other column is right there in the `VALUES` list, would erase the one fact worth having and un-deliver a delivered order. The `SET` clause names exactly one column.

It counts **asks, not answers**, and it runs *before* the call. A process killed mid-request therefore leaves a truthful count with no `catch` having run. The accepted cost, stated rather than discovered: a worker that dies before sending burns a probe. Incrementing afterwards would lose the count on exactly the failure it exists to count.

---

## 4. Keystone three — why the RED asserts stock accounting and not the shopper's key count

### The weakening, and what it did not break

The RED for this slice weakens the **ladder rule**, not the lock: let `fallThrough` fire while an attempt is `unknown`. Two assertions fail:

```
FAIL  claimed keys == deliveries — {"claimedKeys":2,"deliveries":1}
FAIL  supplier B was never called — b rows=1
```

Now read what *did not* fail. **The order still reported `delivered`. There was still exactly one delivery row. The shopper's key count never moved.** Supplier A's ledger had cut a key for `a/1` — an attempt still sitting at `unknown`, unaccounted for — while B cut a second for `b/2`, and B's is the one that got delivered. A shopper, an order page, an end-to-end browser check and any assertion phrased as *"the buyer received exactly one key"* all see a perfectly correct shop.

The reason is a constraint doing its job in a way that masks a different bug: **`deliveries.order_id` is UNIQUE.** One delivery per order is enforced by the database, so no amount of ladder misbehaviour can produce two. The shopper-facing assertion *cannot fail*, which means it also cannot pass in any meaningful sense.

The assertion that can fail is one `count(*)` against another:

```sql
SELECT count(*) FROM supplier_keys WHERE claimed_by_request_id IS NOT NULL;  -- what left the pool
SELECT count(*) FROM deliveries;                                            -- what reached a shopper
```

That is functional spec §2.2's fifth criterion, word for word: *"the number of keys that have left the shop's stock equals the number of shoppers who received one."* It is the only place the second key shows up.

**The general lesson, and it is the most transferable thing in this phase: the assertion that catches a broken ladder is not the one about the shopper.** A test suite that only ever asserts user-visible outcomes will be green against a shop that is losing inventory on every timeout. This is the second time in the project that a RED validation came back green because a constraint masked the weakened mechanism — Phase 2 removed `FOR UPDATE` and every assertion held — and it is recorded as a standing risk rather than as a one-off.

### And stock accounting is not globally true — a correction made during this slice

This is the part that would have been quietly wrong, and it is worth stating because the temptation is to assert the equality everywhere and feel thorough.

On the **probes-exhausted** path, measured: `claimed_keys 2, deliveries 1`. And that is **correct**. A key genuinely was cut by the supplier; the shop asked three times and never learned the code; the order settled `delivery_failed` with its attempt row reading `unknown`. One key left the pool and no shopper received it — because nobody knows the code, not because anything misbehaved. **That is the honest meaning of `unknown`, and it is exactly the loss this phase bounds rather than eliminates.**

So the check has to be phrased per outcome:

- On a **settled** outcome — `delivered`, `out_of_stock`, or a definite `delivery_failed` — assert the equality.
- On a **never-established** outcome, assert instead that **at most one key is unaccounted for per outstanding attempt**, and that the attempt row still reads `unknown` with `last_error` NULL.

A check that asserted the equality everywhere would **fail against a correct system**, and the temptation when that happens is to "fix" the system. The risk register now says so explicitly, with the measured numbers beside it.

---

## 5. The evidence

Four real OS processes, each an independently started `dist/main.js`, with every HTTP call round-robined across them — arming the supplier through one instance, paying through another, reading the result through a third. A passing run is evidence that the behaviour row written through instance 1 is read by instance 3's stub, which is the property a single-process check cannot touch.

**Headline — A armed with `hang_next: 1, hang_ms: 2500` against a 2 000 ms timeout, hang after the claim:**

```
one attempt row: a/1, status=ok, probe_count=2, code=LFXC-TNCS-BPCD
one supplier_requests row (provider a), one claimed key
zero b rows in issuance_attempts and supplier_requests
zero SupplierClient:b lines in the full process transcript
```

Every line of that is the mechanism, but `probe_count = 2` is the fingerprint. **One ask that timed out, one re-probe under a byte-identical id, and A's ledger returning the key it had already cut.** A `probe_count` of 1 would mean no re-probe happened; a row for `b` would mean the shop asked somebody else about a question they had never heard.

The two "zero b" lines are the hard rule holding end to end. The last one is worth its own sentence: B was not merely *not recorded*, it was not **called** — searched across the whole transcript of all four processes, there is no `SupplierClient:b` line at all. A check that only looked at the database could not tell "B was called and its answer discarded" from "B was never asked".

**Probes exhausted — `hang_next: 3`:**

```
order: delivery_failed
attempt row: still `unknown`, last_error NULL, probe_count 3
elapsed: 6102 ms
```

6 102 ms is exactly three 2-second timeouts and no fourth, which is the budget being spent and then stopping. The attempt row is the criterion: it reads `unknown`, not `failed`, after the shop has given up. That is §2.2's fourth criterion, and it is satisfied by *not writing something*.

**Slow but successful — hang *before* the claim, at 400 ms:**

```
order: delivered
one attempt row, probe_count = 1
no timeout, no re-probe
```

This is the second row of §2's table, and running it is what proves the two hang placements are genuinely different scenarios rather than one scenario with a dial. A slow supplier is not a failed one; nothing times out; the ladder never leaves its first rung.

**And the RED**, quoted in §4: weaken the ladder rule and stock accounting fails at `claimedKeys: 2, deliveries: 1` while the order still reads `delivered` with one delivery row.

---

## 6. Also worth including — the shutdown bound's premise was wrong

`SHUTDOWN_DRAIN_TIMEOUT_MS` is how long the process waits on in-flight background work when it receives `SIGTERM`, before giving up and printing a line naming what it abandoned. It has always been described as sitting between two neighbours:

1. **Above the longest continuation the shop can legitimately produce**, so a healthy one is never cut off; and
2. **below the shortest grace period anything gives before `SIGKILL`**, so the give-up line — the entire point of the bound — actually prints.

This slice made those mutually exclusive. The ladder now walks to a resting state inside **one** invocation, so the longest legitimate continuation is no longer one supplier call; it is the whole budget the API logs at boot:

```
SUPPLIER_MAX_PROBES_PER_REQUEST × SUPPLIER_TIMEOUT_MS × |supplierLadder|
    = 3 × 2000 × 2 = 12 000 ms          (measured at boot: worst_case_ms: 12000)
```

Even the *ordinary* exhausted path measures 6 102 ms. Constraint 1 now asks for something north of 12 s; constraint 2 caps at 5 s. No number satisfies both.

**And constraint 2's stated premise was simply false.** The comment said `docker stop` sends `SIGTERM` and kills 10 s later, *"the tightest supervisor in this project's local stack."* Compose runs **only Postgres** — the API is not containerised — so `docker stop` never signals this process at all. The supervisors that really exist are the concurrency suite's own `api-instance.ts` helper and the race-check runner that uses it, both of which `SIGKILL` **5 000 ms** after `SIGTERM`. That is `SHUTDOWN_TIMEOUT_MS = 5_000`, and **the old bound was exactly equal to it** — a photo finish the give-up line loses, since it only prints *after* the drain timer resolves.

The inequality is also not `bound < grace`, because the drain is not the last thing shutdown does. What has to fit is `bound + the shutdown tail < the tightest grace`, where the tail is the give-up line itself, the database pool closing behind it, and the abandoned continuation's own failure when it wakes on a pool that has been ended. Measured at `SIGTERM` mid-walk with the bound at 4 000: `waited_ms: 4001`, process exit **4 790 ms** after the signal — 210 ms inside a 5 000 ms grace. That is not headroom, it is a coin toss on a loaded machine. At 3 000: `waited_ms: 3001`, exit **3 055 ms** after the signal, **1 945 ms** of grace left over.

**Constraint 1 is the one that gives, and the reasoning generalises past this constant.** The two failures are not comparable:

- Breaking *"wait for the longest walk"* is **recoverable and loud**. The attempt row says `unknown` because it was written *before* the supplier call, so no error path has to run for it to stay truthful; the order stays `delivering`; the payment event stays pending, which keeps the other processing triggers able to find it; and the abandoned continuation is named — `order_id`, `event_id` — in the give-up line.
- Breaking *"exit before `SIGKILL`"* is **silent**. No give-up line, no pool drain, and an operator who learns nothing at all.

A bound whose one product is a log line must never be the thing that loses the race to print it.

Worth noticing that this is the same judgement the invocation budget makes one level up. The 12-second budget **exceeds Vercel's Hobby ceiling**, and nothing in the process can enforce that — the ceiling is the platform's, it is not in the environment, and a number hardcoded to check against would be a guess that fails a boot over a limit that no longer applies. So the number is *logged* at boot with every factor beside it, because the failure it predicts is the one that leaves no trace: the function is killed mid-ladder and the only sign is an order resting in `delivering` that looks exactly like a slow supplier.

---

## 7. The honest limitation

**This phase bounds the loss. It does not eliminate it.**

After three asks of a silent supplier the shop stops and says so. If that supplier had in fact cut a key, that key is gone: claimed in its ledger, bound to a `request_id` whose code the shop never received, and unreachable by any shopper. The order settles `delivery_failed`, the attempt row reads `unknown`, and the recovery list will surface it by `outstanding_request_id`.

What is bounded is **at most one unaccounted key per outstanding attempt**, and it is bounded by the fact that no other supplier is ever asked while that attempt is outstanding. The alternative designs both cost more: giving up immediately costs a key *and* tells the shopper nothing useful; falling through costs a key *and* a second key.

It is also worth saying that the one thing that could recover that key is the thing the shop already does — an operator retry re-asks the **same** `request_id`, which the supplier's ledger answers with the code it already issued, if it issued one. That path arrives in slice 5. The mechanism it will use is entirely this slice's.

---

## 8. Where this sits in the assignment

This slice settles **functional spec §2.2** — *"silence from a supplier never costs the shop a second key"* — which is the requirement the whole phase turns on, and all five of its criteria:

| Criterion | Settled by |
|---|---|
| Ask the *same* supplier again rather than a different one | the `probe` rung, above `fallThrough` in the decision order |
| A supplier that went quiet having issued: the shopper gets **that same** key | the byte-identical derived id and the supplier's ledger (I5) |
| Turn to the backup **only** after a definite refusal | `isDefinitelySettled` as a negation, and the branch order |
| A still-unknown outcome reads as *never established*, not as *failed* | nothing is written to `issuance_attempts` on the give-up path |
| Many orders at once: keys that left stock = shoppers who received one | stock accounting, asserted on settled outcomes |

Against `product-definition.md` §1.4's five adversarial scenarios it settles **none** outright, and claiming otherwise would be easy and wrong:

| # | Scenario | Status after this slice |
|---|---|---|
| 1 | 50 parallel `paid` webhooks → one issuance fact, one key | Settled in Phase 1, strengthened in Phase 2. Not extended here. |
| 2 | A repeated webhook with the same `event_id` changes nothing | Settled since Phase 1 by the `event_id` PRIMARY KEY. Untouched. |
| 3 | A webhook before its order, or out of order | Settled in Phase 2 slice 3. Untouched. |
| 4 | Empty pool → recoverable → after restock, exactly one key | **The mechanism its recovery half will rest on.** An operator retry re-asks the same derived `request_id`; that is this slice's rule. The retry itself is slice 5. |
| 5 | A promo code with limit N under parallel requests | Phase 5. Not started. |

The honest summary: this slice is **the mechanism scenario 4's recovery half will rest on**, and it is the answer to the assignment's own «таймаут ≠ отказ» — which is not one of the five scenarios but is the sentence the five are built around.

---

## Interview questions this answers

**"A supplier times out. Why isn't that a failure?"**
Because the timeout happens on *our* side of the wire and tells us nothing about theirs. `AbortSignal.timeout` aborts the shop's own socket; the supplier's handler keeps running, and it can claim a key, write it to its ledger and finish answering into a connection that closed half a second earlier. I measured it: a client giving up at 200 ms against a handler that claims at 400 ms throws `TimeoutError` at t+205 ms, and the key is cut and committed at t+412 ms — 206 ms *after* the client had already classified the call. There is no amount of care on the client side that fixes that, because the information does not exist when the decision is taken. So the only honest classification is `unknown`, and `failed` is reserved for a supplier that explicitly said no in a body we could parse. `failed` is not a description, it is a licence to ask a different supplier for a second key.

**"Why is re-asking the same supplier safe, when asking a different one is not?"**
Because they are two different questions, and the identifier is what makes them different. A re-probe sends a **byte-identical** `request_id`, which is the only phrasing the supplier's ledger can answer with the code it already issued instead of cutting a second one — that is the assignment's own rule, *«на повтор с тем же `request_id` поставщик обязан вернуть тот же самый код»*. A fall-through sends a **new** id to a party that has never heard of the old one, and supplier B has no ledger entry to find, so it does the only thing it can: it cuts a fresh key. Ask B while A's attempt is still `unknown` and you have bought two keys for one order. The id is derived — `deriveIssuanceRequestId(orderId, provider, attempt)` — so a probe *recomputes* the same string from the outstanding row rather than remembering it, and a fall-through changes two of the three arguments.

**"How do you stop a fall-through from happening while an attempt is unknown? A flag? A check at the top?"**
Neither — it is the order the branches are written in. `probe` and `settleNeverEstablished` both sit above `fallThrough` in the ladder, so an order with an outstanding attempt cannot *reach* the fall-through branch. The rule is unrepresentable rather than merely obeyed. And I did not verify that with a handful of chosen histories, because "unrepresentable" is a claim about every input: the test enumerates 894,049 ladder histories built from a 96-row alphabet, and asserts a conditional — if any row is not definitely settled, the answer is not `fallThrough`. Zero violations, with 781,104 of those histories actually containing an unsettled row. It is not vacuous either: 8,152 histories do reach `fallThrough` and every one of them is fully settled, which the test also asserts.

**"How do you know that test can fail?"**
Two mutations, both re-run while writing this up. Reordering the guard below the fall-through branch gives **620,336** violations. Flipping the predicate from the negation to a positive `status === 'unknown'` test gives **265,560**. The control gives zero. Those two numbers also say *which* part is doing the work — the first is the branch order, the second is the predicate — so a green run is not just "the test passes", it is "these two specific weakenings would have been caught".

**"Why is the guard a negation rather than `status === 'unknown'`?"**
Because `issuance_attempts.status` is `text` with no CHECK — deliberately, since the value set belongs to the retry policy rather than to the schema. A row written by a future migration, by `psql`, or by a build that knows a fourth status would satisfy `!== 'unknown'` and unlock a fall-through past an outstanding request. Writing it as *not `ok` and not `failed`* makes "unrecognised" behave like "unknown", which is the only reading that cannot issue a second key. The 265,560-violation mutant is exactly that mistake.

**"Your test writes out its own copy of the predicate instead of importing it. Isn't that duplication?"**
It looks like duplication and it is the opposite. A check that imports the definition it is checking will agree with that definition however it changes — including into the flipped `=== 'unknown'` version the assertion exists to catch. Importing `isDefinitelySettled` would have made the mutant pass. The predicate is written out longhand for the same reason the request ids in that file are transcribed rather than derived.

**"When you give up, what do you write to the attempt row?"**
Nothing. That is the point. The row already says `status = 'unknown'`, `last_error` NULL, `probe_count` at the ceiling, and all three are still exactly true — we asked, and we do not know. The transaction is a lock, a read and a guarded `UPDATE` on **`orders`**; there is no write to `issuance_attempts` in it at all. Writing `failed` there is the bug the phase exists to prevent, and there is nothing truthful to write instead. The distinction I'd put to a reviewer: `orders.status = 'delivery_failed'` is a statement about *the shop* — we did not hand over a key. `issuance_attempts.status = 'unknown'` is the statement about *the supplier* — never established. Two facts, two tables, and §2.2's fourth criterion is satisfied by the second.

**"Why does the silence path open a transaction at all, if it writes nothing about the attempt?"**
Because the next rung has to be computed from rows read **under the order row lock**. The ladder is the one decision in this system Postgres cannot take inside a guarded statement — "which supplier is next" is a function of a *set* of rows, and no single statement evaluates it. Two workers reading different snapshots compute different rungs, and one of them can be a fall-through; the supplier's ledger cannot save you there because it is keyed on `request_id` and those are two different ids. So two keys leave the pool. The lock serialises the workers, the `unknown` guard decides — both, or neither is enough. The probe's own `probe_count` increment goes in the same transaction, so the count that bounds the loop is committed before the next pass reads it.

**"Why does the probe count increment before the call rather than after?"**
It counts **asks, not answers**. A process killed mid-request leaves a truthful count with no `catch` having run — which matters, because the whole premise of this phase is that the failure modes worth designing for are the ones where no handler gets to run. The accepted cost is that a worker which dies before sending burns a probe, and that is stated rather than discovered. Incrementing afterwards would lose the count on exactly the failure it exists to count. The `ON CONFLICT DO UPDATE` also touches `probe_count` and nothing else, because on the probe path the row may already say `ok` — the supplier answered our previous ask and another transaction wrote the code — and a `SET status = 'unknown'` alongside the increment would un-deliver a delivered order.

**"Why did the RED have to assert stock accounting instead of the shopper's key count?"**
Because the shopper's key count physically cannot fail. `deliveries.order_id` is UNIQUE, so one delivery per order is a database guarantee no ladder bug can violate. I broke the ladder rule deliberately — let `fallThrough` fire while an attempt was `unknown` — and the order still reported `delivered` with exactly one delivery row. A shopper, an order page and any end-to-end browser check all saw a correct shop. What actually happened is that A's ledger had cut a key for `a/1`, still `unknown` and unaccounted, while B cut a second for `b/2` and B's is the one delivered. The only assertion that moved was `count(*) FROM supplier_keys WHERE claimed_by_request_id IS NOT NULL` against `count(*) FROM deliveries` — `claimedKeys: 2, deliveries: 1`. That is §2.2's fifth criterion, and the general lesson is that the assertion which catches a broken ladder is not the one about the shopper.

**"Is stock accounting always true, then?"**
No, and asserting it everywhere would fail against a correct system. On the probes-exhausted path the measurement is `claimed_keys 2, deliveries 1` and that is **correct**: a key genuinely was cut, the shop asked three times and never learned the code, and the order settled `delivery_failed`. That is the honest meaning of `unknown` and it is the loss this phase bounds rather than eliminates. So the equality is asserted on settled outcomes — `delivered`, `out_of_stock`, a definite `delivery_failed` — and on a never-established outcome the assertion becomes *at most one unaccounted key per outstanding attempt, and the attempt row still reads `unknown` with `last_error` NULL*. I'd rather state the bound than claim a guarantee the design does not make.

**"Did anything about the setup turn out to be wrong?"**
Yes, and it is the reason this slice is worth reading. The injected hang was documented as *shorter* than the client timeout — `hang < SUPPLIER_TIMEOUT_MS < ceiling` — in `architecture.md`, in the config module, in `.env.example` and in the spec's own technical notes. Staged that way there is no timeout at all: the shop waits, the supplier answers, and the headline check passes having exercised nothing. Measured: `NO TIMEOUT OCCURRED. A timeout check staged this way asserts nothing.` It was not a typo — the old text describes a real scenario (a slow supplier is not a failed one) and was being cited as the basis for a different one. The correction was to record both scenarios separately, with the trap needing `SUPPLIER_TIMEOUT_MS < hang_ms < ceiling` and the hang placed *after* the key claim commits so the ledger holds a code for the re-probe to find. A fifth copy lived in an **agent briefing**, which is worse than a stale comment: it would have re-injected the wrong rule into the next piece of work rather than sitting still.

**"Why is the hang placement a column and not a constant, or an enum?"**
A column because §2.7 requires the reviewer to reproduce both scenarios *without changing the shop itself*, and the duration half was already a column while the placement half was not. A boolean rather than an enum because there are exactly two honest places, and that is a fact about the code: the key claim and its ledger write are one transaction, so a hang is either before it or after it commits. The only third value anybody would reach for is *inside* it — and that one must never exist, because it holds the instance's single pooled connection for the whole hang and stalls every other request in the process, including the re-probe the trap is staged to observe. A two-valued column cannot express it; an enum would give it a name and a place to sit.

**"You lowered the shutdown drain timeout. Isn't that giving up on in-flight work?"**
It is, deliberately, and the reasoning is the transferable part. That constant used to sit above the longest legitimate continuation and below the shortest grace before `SIGKILL`. A 12-second ladder walk makes those mutually exclusive. It also turned out the grace period was stated wrongly — the comment named `docker stop`'s 10 s, but Compose runs only Postgres, so `docker stop` never signals this process; the real supervisor `SIGKILL`s at 5 000 ms, which is **exactly** what the old bound was set to. So which constraint gives? Breaking "wait for the longest walk" is recoverable and loud: the attempt row says `unknown` because it was written before the call, the order stays `delivering`, the payment event stays pending, and the give-up line names the `order_id` and `event_id`. Breaking "exit before `SIGKILL`" is silent — no line, no pool drain, nothing. A bound whose one product is a log line must not lose the race to print it. 4 000 was measured and rejected at 210 ms of headroom; 3 000 gives 1 945 ms.

**"What does this slice settle in the assignment, honestly?"**
Functional spec §2.2, all five criteria — which is the requirement the phase turns on. Of the assignment's five adversarial scenarios it settles **none** outright. It is the mechanism the fourth one's recovery half will rest on: after a restock, an operator retry re-asks the same derived `request_id`, and the supplier's ledger answers it. The retry itself is two slices away. What this slice is, in one sentence, is the answer to «таймаут ≠ отказ» — not one of the five scenarios, but the sentence the five are built around.

---

## Source files

- `apps/api/src/issuance/supplier.client.ts` — the deadline, what `AbortSignal.timeout` severs and what it does not, and the definite/unknown classification table
- `apps/api/src/issuance/issuance-ladder.ts` — the pure function, the decision order as enforcement, `isDefinitelySettled` as a negation, and the two new rungs
- `apps/api/src/issuance/issuance-runner.service.ts` — the walk and its bound, transaction A″ (the silence transaction that writes nothing), `settleNeverEstablished`'s report, and the boot-time invocation budget
- `apps/api/src/issuance/issuance-history.ts` — `readWithin`'s transaction-only signature and why, the reserving insert, and `countProbeWithin`'s narrow `ON CONFLICT DO UPDATE`
- `apps/api/src/issuance/issuance-request-id.ts` — `deriveIssuanceRequestId`, and why an id is derived rather than stored and read back
- `apps/api/src/config/supplier-config.ts` — `SUPPLIER_MAX_PROBES_PER_REQUEST`, assumption A1, and both hang scenarios side by side with the corrected inequality
- `apps/api/src/suppliers/supplier-hang.ts`, `apps/api/src/suppliers/a/supplier-a.controller.ts` — the hang placed after the claim, and why the two placements are different checks
- `apps/api/src/suppliers/supplier-key-claim.service.ts` — the ledger, `readLedger` now narrowed by `provider`, and the two writes in one transaction
- `apps/api/src/scheduling/tracked-continuation-scheduler.ts` — which constraint gives, the corrected supervisor table, and the measurements at 4 000 and 3 000
- `apps/api/test/unit/issuance-ladder.test.ts` — the exhaustion over 894,049 histories, the not-vacuous counters, and why the predicate is written out longhand
- `packages/db/drizzle/0004_supplier_hang_placement.sql` — the boolean, why not an enum, and why the `DEFAULT` is dropped
- `context/product/architecture.md` §3 (I3, I5, I6), §5 (the two hang scenarios), §8
- `context/spec/003-failure-and-recovery/technical-considerations.md` §1.2, §1.3, §1.4, §6, §7.1, §11 (R2, R5)
- `context/spec/003-failure-and-recovery/functional-spec.md` §2.2, §2.7
- `docs/walkthrough/phase-3-slice-2-a-backup-supplier.md` — the derived-id rule and per-order attempt numbering this slice depends on

**On evidence:** the following were run fresh while writing this document, against the tree and the local Postgres container as they stand. `pnpm -r run typecheck` across all four workspace projects — `packages/contracts`, `packages/db`, `apps/api`, `apps/web` — all Done. `vitest run test/unit/` in `apps/api`: **2 files, 23 tests passed** in 438 ms. The exhaustion counts in §3 are my own re-run of the enumeration through a throwaway script in `/tmp` importing the real `nextIssuanceStep`: 96 alphabet rows, 894,049 histories, 781,104 containing an unsettled attempt, **0 violations**, 8,152 reaching `fallThrough` with all 8,152 fully settled, 260,368 reaching `probe` and 520,736 reaching `settleNeverEstablished`. The two RED mutation counts are likewise mine, from mutated copies of `issuance-ladder.ts` placed in `/tmp` with their imports rewritten — reordering the guard gives 620,336 violations and flipping the predicate to `!== 'unknown'` gives 265,560, against a control of 0; the production file was not touched and the copies were deleted. The socket-abort transcript in §2 is my own run of a throwaway Node script — no project code, just `node:http` and `fetch` — and it reproduces the phase's earlier measurement (reported at t+213 / t+215 / t+422) at t+205 / t+206 / t+412. Against the running database I read `\d supplier_behaviour`, confirming `hang_before_claim boolean not null` with **no default**, and `select count(*), count(claimed_by_request_id) from supplier_keys` returning `50 | 0`. I also read the silence and settle paths in `issuance-runner.service.ts` and `issuance-ladder.ts` directly to establish that no write to `issuance_attempts` exists on the give-up path, rather than taking a doc comment's word for it.

Everything else is reported by other agents in this slice and is **not** re-verified here: the four-process headline run and every line quoted in §5 including `code=LFXC-TNCS-BPCD`, `probe_count = 2`, the zero-`b` transcript search, the probes-exhausted run and its 6 102 ms, the slow-but-successful run at a 400 ms pre-claim hang, the end-to-end RED and its `{"claimedKeys":2,"deliveries":1}`, the `NO TIMEOUT OCCURRED` measurement against the old documented ordering, the `claimed_keys 2, deliveries 1` measurement on the probes-exhausted path, the Postgres `log_statement = 'all'` capture of the settle transaction, and the two shutdown measurements (`waited_ms: 4001` with exit at 4 790 ms, and `waited_ms: 3001` with exit at 3 055 ms).
