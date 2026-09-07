# Slice 7 — A concurrency test that runs in one process is a queue test that always passes

> Written for the author to read and re-explain from memory. Companion to `context/product/architecture.md` §7,
> functional spec §2.5, and `technical-considerations.md` §4 ("Concurrency test (Vitest)").
> Slice 8 consolidates this and the other slice walkthroughs into the phase-level document.
>
> Slices 4, 5 and 6 measured concurrency **by hand**. This slice turns the smallest of those measurements into
> something a reviewer runs with one command — and the assertions are the easy part. This is about what had to
> exist underneath them before they could ever be *wrong*.
>
> The file is `apps/api/test/concurrency/key-claim-race.test.ts`, harness in `test/concurrency/support/`. Every
> capture below came from running the suite for this document on 2026-09-07, except the RED output in §4, quoted
> from the runs made when the test was written.

---

## 1. What §2.5 demands, and why reading the code cannot check it

Functional spec §2.5 has two criteria: two paid orders for the same item must show **two different keys**; and
once every key is given out, a further paid order must show the item cannot be delivered, with no key, on a page
that **keeps working**.

The first is a claim about *simultaneity* — not about what one request does, but about what happens when several
are inside the same rows at the same instant. Nothing about a single request is wrong in the broken version: it
reads an unclaimed key, writes its id onto it, and looks perfect in isolation. Which is why review cannot settle
it:

```sql
-- shipped
UPDATE supplier_keys SET claimed_by_request_id = $1, claimed_at = now()
 WHERE code = (SELECT code FROM supplier_keys WHERE claimed_by_request_id IS NULL
                ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
RETURNING code;

-- weakened
SELECT code FROM supplier_keys WHERE claimed_by_request_id IS NULL ORDER BY id LIMIT 1;
UPDATE supplier_keys SET claimed_by_request_id = $1 WHERE code = $2 RETURNING code;
```

Both are legal, both return one code, both pass a type check and a reviewer's eye. The difference appears only
when two of them are open in Postgres at once: the first cannot be interleaved, because read, lock and write are
one operation; the second has a window in which fifty other requests read the same row (Slice 4 §3). **So the
only instrument that can check §2.5 is simultaneous execution — and it is an instrument only if it can report a
failure.**

## 2. The trap: one process serialises its transactions at the connection pool

The obvious test is a `Promise.all` of N HTTP calls against one running API. It is wrong here, specifically.

`packages/db/src/client.ts` sets the pool to `max: 1` per instance, deliberately: a serverless instance serves
one request at a time, so "how many connections may one in-flight request hold" is one. Locally that has teeth.
`db.transaction()` checks the single client out for the whole of `BEGIN … COMMIT`. A second concurrent claim
calls `pool.connect()`, finds no idle client, and its promise goes into **node-postgres's pending-request queue —
in Node, in the same event loop, before a byte reaches Postgres.** It resumes only after the first commits.

So inside one process: two claim transactions are never both open in Postgres; `FOR UPDATE SKIP LOCKED` never
skips anything, because nothing else holds a row lock when the subquery looks; and therefore **a claim written
with no locking at all behaves identically to the shipped one.**

Measured, not argued — Slice 4 §9, the claim weakened exactly as above, twenty distinct `request_id`s:

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

Both blocks are one sentence: **the same broken code is flawless in one process and hands eleven customers a key
somebody else also holds in four.** Note `errors: 0` in *both*. It does not struggle, retry, or log anything
unusual. It is not one flaky run away from being caught; it is silent.

The shortcut everyone suggests first is *raise the pool size in tests*. Declined: `max: 1` is the production
shape, and a test that changes the configuration under test proves some other system correct. Take the
concurrency from where the deployment gets it — **more processes.**

## 3. So the harness spawns real API processes

`support/api-instance.ts` starts **four** `apps/api` processes on ports 4101–4104, clear of `API_PORT` 3000 and
`WEB_PORT` 5173 so the suite never collides with a running `pnpm dev`. Four is the number Slices 4 §9 and 5 §8
used by hand, so the automated and the manual proofs are the same experiment. Three decisions carry weight:

- **It runs the compiled `dist/main.js`, and `beforeAll` rebuilds it first.** Nest reads constructor types from
  `emitDecoratorMetadata`, which only `tsc` emits — Node's type stripping erases annotations without evaluating
  them, so DI would fail. And the rebuild is **what makes a RED edit reach the children**: a child booted from a
  stale `dist/` runs the correct claim whatever the source says, and §4's experiment would "fail to fail".
- **Each instance's environment is set explicitly, not inherited**: its own `API_PORT`, with
  `PAYMENT_WEBHOOK_URL` and `SUPPLIER_A_URL` looping back to *itself*, so paying through instance 2 means
  instance 2 answers its own webhook and calls its own supplier. The one shared thing is `DATABASE_URL`, and
  through it `supplier_keys`. **The only place the four processes meet is the row** — which is the claim itself.
- **Start and stop are both waited on**: `GET /api/health` until `200`; then `SIGTERM` and the real `exit`
  (`enableShutdownHooks` draining the pool), `SIGKILL` after 5 s — no run leaves connections behind.

### Proving they overlapped instead of assuming it

Four processes existing does not mean four requests were in Postgres together. `support/db.ts` adds a witness:
during the parallel payments a fifth connection polls in a tight loop, under its own `application_name` so it
never contends with what it observes.

```sql
select pid from pg_stat_activity where application_name = $1 and pid <> pg_backend_pid();
```

```
key-claim-race: 4 apps/api processes healthy on ports 4101, 4102, 4103, 4104 (pids 13631, 13632, 13633, 13634)
key-claim-race: 20 parallel payments in 212ms; distinct Postgres backend pids observed mid-flight:
                [4650, 4651, 4652, 4653] (97 pg_stat_activity samples taken during the window)
```

Two pid spaces, worth not confusing: `13631…` are OS processes, `4650…` are Postgres **backends** — four of them
alive during a 212 ms window sampled 97 times. And be honest about what that is: **a sample, not a certificate.**
A backend not connected at a sampled instant is invisible to it, and four live connections do not prove two were
inside the claim at the same microsecond. So the suite asserts only `>= 2` distinct pids — a smoke alarm for a
harness that has quietly stopped spawning, not the proof. The proof is RED.

## 4. RED validation is a property of the harness, not just of the code

A normal RED step asks: *does this assertion depend on the behaviour it claims to test?* Here it also asks a
question only concurrency tests raise: **is this harness delivering concurrency at all?** If the weakened claim
still passes, either the assertion is not wired to the property or the four processes are secretly taking turns.
Either way the test is worthless — and no number of green runs would say so.

The experiment: `claimAndRecord` in `apps/api/src/suppliers/supplier-key-claim.service.ts` rewritten from the
single locking `UPDATE` to a separate unlocked `SELECT` then `UPDATE` in the same transaction — the exact
weakening Slice 4 §3 and §9 measured by hand — then rebuilt (§3), then run:

```
AssertionError: N distinct keys — no code handed to two orders
  expected 9 to be 20

AssertionError: exactly one order settles per available key
  expected 55 to be 50
```

What each says about the shop:

- **`expected 9 to be 20`** — twenty orders, twenty `deliveries` rows, twenty happy shoppers, **nine distinct
  codes**. Eleven people hold a key that already belongs to someone else. Every response was `200`.
- **`expected 55 to be 50`** — fifty-five orders against a fifty-key pool, and **fifty-five delivered**. The shop
  sold five keys it does not own and reported success. Nothing raised; the pool simply lost count.

Nine-of-twenty is not a new number: it reproduces Slice 4 §9's four-process hand measurement exactly — the best
evidence available that the automated harness and the manual rig measure the same thing. **And the number moves
between runs, which is a feature**: the test file's header records `expected 12 to be 20` from a different RED
run. The collision count is decided by scheduling, which is what a race is; an identical number every time would
be the suspicious result. The source was then restored exactly and the suite went green again.

**The lesson, in the form to say out loud.** A test that cannot fail is worse than no test, because it is a false
statement about the system that grows more convincing every time it passes. No test is an honest gap somebody may
still close; a race test that silently serialises produces a green line that gets more persuasive every run,
pointed at the property most likely to be wrong. Six consecutive green runs of one would read as strong evidence
and prove nothing — the pool queue emits exactly those six lines against a claim that hands one key to eleven
customers.

RED stays a comment in the test header rather than a flag: automating the toggle means shipping a second,
deliberately broken claim and a switch to select it — a production code path that exists only to be wrong. It is
a one-time proof that the *harness* can fail, written down so anyone can repeat it.

## 5. Why the assertions query the database directly

`architecture.md` §7 requires it: *"an API response can look correct while the underlying state is wrong."*

The precedent is Slice 4 §6, and it runs the other way from what people expect. A `23505` guard written against
`error.code` never matched, because Drizzle wraps the driver error and `code` lives on the `cause`. Result:
**nineteen of twenty concurrent callers got a `500` while the database stayed perfectly correct** — one key, one
ledger row, no double issue, because Postgres had rolled the losers back regardless. The bug was in the answer.

A response-only test would have called that a **correctness failure** and been wrong; a database-only test would
have called it a **pass** and been wrong. Only both together say "state correct, answer wrong", which is the
actual bug report. So the suite does both, in that order: every payment returned `200` with
`webhook_outcome: "stored"` and every order settled `delivered` — then every correctness claim is re-derived
from Postgres in raw SQL.

```sql
select order_id, code from deliveries where order_id = ANY($1::text[]);
select count(distinct code)::int from supplier_keys where claimed_by_request_id = ANY($1::text[]);
```

Two things in `support/db.ts` look like duplication and are not. **`deriveTestRequestId` is transcribed, not
imported**, so one edit cannot move the test and the application together. And **the baseline is asserted before
*and* after** — fifty unclaimed keys, zero of everything else — because a dirty database makes §6's arithmetic
meaningless, and because the suite restores what it borrowed, including `claimed_by_request_id = null`, a thing
**only a test may do** (production has no unclaim, by design). That is what makes it re-runnable with no manual
reset. Checked directly after this document's three runs:

```
 keys_total | unclaimed | orders | deliveries | events | attempts | supplier_requests
------------+-----------+--------+------------+--------+----------+-------------------
         50 |        50 |      0 |          0 |      0 |        0 |                 0
```

## 6. The second case: 55 orders against a 50-key pool

The first case pays twenty orders into a fifty-key pool — thirty keys of headroom, so a claim could be sloppy
about the *last* key and never be caught. The second pays **five more orders than the pool holds**. Why the
boundary earns its own test rather than a bigger N:

- **It contests the tail.** At exhaustion several claims race for the final rows and most get *zero rows* back.
  Zero rows must mean `out_of_stock` — an ordinary value, not an exception (Slice 6 §2) — and this is the only
  place that path runs under contention rather than a sequential drain.
- **The outcome is arithmetically forced, not probable.** Fifty keys exist, so exactly fifty orders can be
  delivered and exactly five cannot, *however the fifty-five interleave*. Exact counts, no tolerance, no retry —
  which makes it a race test rather than a load test.
- **It checks the shop keeps answering.** All fifty-five must get an ordinary `200`: an empty pool must not
  become a `500`, which would tell a payment provider to redeliver an event we understood perfectly (Slice 6 §1).

The run, then Postgres — fifty `deliveries` rows, fifty **distinct** codes, fifty claimed keys:

```
key-claim-race: over-pool run settled as {"delivered":50,"out_of_stock":5}
```

```sql
select count(*)::int from supplier_keys where claimed_by_request_id is null;  -- 0
```

Zero unclaimed *and* exactly fifty claimed by this run's request ids means the pool was fully drained and
drained **only** by this run: no key claimed twice, none leaked, none claimed by a request id nobody asked for.

**What Slice 6's check could not do.** Slice 6 §5 drained to one key and raced two orders across two processes —
a real race, and the minimum that proves anything, but n = 2 at a single row, by hand, once. This contests the
whole tail with four processes and asserts exact counts on both sides of the boundary, on every run.

## 7. What this does not prove

- **Four processes on one machine is weaker than four serverless instances.** Same kernel, same clock, one
  loopback; the scheduler is more forgiving than a network. The strongest form runs against the deployed URL —
  Phase 2's base-URL race scripts, not this file.
- **This is §2.5, not "fifty webhooks on one order."** N orders → N keys is a different scenario from one order →
  many events, won by a different mechanism: I4's guarded `UPDATE … WHERE status = ANY('{paid}')` in the shop,
  not `SKIP LOCKED` in the supplier. Slice 5 §8 measured that by hand at twenty; the scripted version at fifty is
  Phase 2's adversarial suite.
- **The witness is a sample**, so a run does not re-establish overlap; RED is the authoritative statement about
  it, and RED is a one-time hand experiment. **Nothing here touches the timeout trap** — supplier A always
  succeeds in this phase, so `unknown` outcomes never occur (Phase 3) — and **nothing about promo codes**, whose
  tables do not exist yet (Phase 5).
- **`SELECT … FOR UPDATE`, the other half of I4, is still missing** (Slice 5 §9.3) and this suite cannot notice:
  with one entry point into issuance there is no second worker to serialise. Phase 3's retry adds one.

## 8. Where this sits in the assignment

The brief asks for a reproducible race check by name — «как воспроизвести проверку гонок» — and the product
definition makes it one of the three things the written explanation must contain, beside startup instructions and
the account of single issuance. **This file is that artefact for §2.5**, and it ships in Phase 1, not with Phase
2's adversarial suite, because §2.5 is a Phase 1 acceptance criterion.

The whole reviewer procedure — no seeding step, no cleanup, no reset between runs:

```
pnpm db:up            # only if Postgres is not already running
pnpm test:concurrency
```

```
 ✓ pays 20 orders in parallel across 4 processes: N distinct keys, N claimed supplier_keys rows,
   N deliveries rows, zero errors  309ms
 ✓ pays 55 orders in parallel — more than the 50-key pool holds: no code is ever claimed twice even at
   exhaustion, and the shop keeps answering (§2.5's second criterion)  436ms

 Test Files  1 passed (1)
      Tests  2 passed (2)
   Duration  4.76s (tests 92%, import 6%, transform 2%)
```

Six consecutive runs when the slice was verified, three more for this document (4.67 s, 4.73 s, 4.76 s), no
flakes, baseline clean afterwards. Most of those five seconds is the two TypeScript builds; the racing itself is
212 ms and 436 ms.

One scoping note, since Slice 5 §10 promised more under this heading: the named base-URL scripts
(`race:webhooks`, `race:same-event`, `recover:out-of-stock`, `recover:timeout`) are not in this slice's task list
and are not here — they belong with Phase 2's adversarial suite and Phase 3's timeout work.

The sentence to lead with: **the hard part of a race test is not the assertions, it is proving the test could
ever have been red.**

---

## Five questions, five answers

1. *Why can't you test this with `Promise.all` against one server?* — The pool is `max: 1` per instance, so a
   transaction holds the only connection for the whole of `BEGIN … COMMIT` and the second caller queues in Node
   before Postgres sees it. `SKIP LOCKED` never skips, and a claim with no locking passes: twenty distinct keys
   for twenty callers in one process, nine across four, zero errors in both. A green run there measures the
   connection pool, not the constraint. And no, you may not raise the pool size to fix it: `max: 1` is the
   serverless shape, and a test that changes the configuration under test proves some other system correct.
2. *How do you know the four processes really overlapped?* — Two ways, one much stronger. Weak: a fifth
   connection polled `pg_stat_activity` throughout and saw four distinct backend pids across 97 samples in
   212 ms — a sample, so the suite only asserts "at least two". Strong: RED, since weakening the claim made the
   suite fail, which is impossible if the harness is serialising.
3. *What did RED actually show?* — `expected 9 to be 20`: twenty deliveries, nine distinct codes, eleven shoppers
   holding someone else's key, every response `200`. And `expected 55 to be 50`: fifty-five orders delivered out
   of a fifty-key pool. Restoring the single locking `UPDATE` turned both green. The count varies between RED
   runs — the test header records twelve, not nine — which is what a scheduling-decided outcome should do.
4. *Why is a test that can't fail worse than no test?* — Because it is a false statement about the system that
   gets more convincing every time it passes. A silently-serialising race test emits the same green line whether
   the claim is correct or hands one key to eleven customers. That is why RED here validates the *harness*.
5. *Why assert against the database when the API already answered `200`?* — Because the two can disagree in both
   directions: nineteen of twenty callers once got a `500` while the database was perfectly correct (Slice 4 §6).
   Response-only calls that a correctness failure, database-only calls it a pass; only both say which it was.
