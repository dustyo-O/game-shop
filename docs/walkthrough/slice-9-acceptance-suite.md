# Slice 9 — Turning the acceptance criteria into something a reviewer runs

> Written for the author to read and re-explain from memory. Closes the slice series; companion to
> `slice-7-proving-the-race.md`, which it does not repeat.
>
> The eight implementation slices each proved their own thing, mostly by hand. This one asks: **when a shopper
> walks the whole path, do the seams between them hold — and can a reviewer check that in one command?** The
> file is `apps/api/test/acceptance/purchase-and-key-delivery.test.ts` (13 tests); captures are from running it
> on 2026-09-07, except §4's RED output.

---

## 1. What the suite is for, and the one command

The assignment is graded two ways: the **five adversarial scenarios** (`product-definition.md` §1.4) are the
reviewer's definition of reliability, and the spec's §2.1–§2.8 are this phase's acceptance criteria. Until now
they were a list somebody read and ticked; the product definition asks for more — *"every acceptance criterion
maps to a named, runnable script."*

```
pnpm db:up     # only if Postgres is not already running
pnpm test
```

```
 Test Files  2 passed (2)
      Tests  15 passed (15)
   Duration  9.53s (tests 93%, import 6%, transform 1%)
```

Two files, two questions: `pnpm test:acceptance` runs the 13 below (4.95 s), `pnpm test:concurrency` the 2 that
own §2.5. No seeding step and no reset between runs — both assert the seeded baseline before starting, clean up
what they wrote, and assert it again afterwards (Slice 7 §5).

The suite boots a real compiled `apps/api` on port 4201 against real Postgres and drives it over HTTP as the
browser does. Then — per `architecture.md` §7, for the reason §4 makes concrete — **every correctness claim is
re-derived from the database in raw SQL** and compared with the API's answer.

## 2. The coverage map, honestly

| Criterion | How it is proven |
|---|---|
| §2.1 — twelve items, names, prices, Buy control | `GET /api/products` item-by-item against a transcribed catalogue *and* the `products` rows; `purchasable` pinned to three SKUs |
| §2.2 — order page: name, amount, awaiting payment | `POST /api/orders` → `GET /api/orders/:id`, both against the `orders` row |
| §2.3 — processing; failure with no key; no paying twice | leaves `created`; `payment_failed` in API *and* `orders`, no `deliveries` row; the hidden button's endpoint invoked directly and refused by I9 |
| §2.4 — delivery, same key on reload and later | delivered with a code, `deliveries.code` equal to every read |
| §2.5 — a key is never given away twice | **concurrency suite**: 20 orders across four processes, 55 against a 50-key pool |
| §2.6 — find an order again; unknown id | the same `GET /api/orders/:id` before and after delivery; `404` with a real body — unicode and 500-character ids included |
| §2.7, §2.8 AC1 | not runtime-testable — below. §2.8 AC2 (names verbatim) is the §2.1 comparison |

Four more tests carry no criterion, since a criterion is only as good as its negative. **§2.5 is not re-tested
here** — it has a four-process proof next door.

**Two criteria are not runtime-testable — a decision with a reason, not an omission.**

- **§2.7, the walkthrough.** `phase-1.md` is a document, and §2.7 asks that the prose *teaches* three keystones
  to a reader who never opens the source. A file-existence or heading check would pass against a file
  explaining nothing — theatre, and worse than nothing, since it reports the criterion as met. Verified by
  reading.
- **§2.8 AC1, shopper-facing text is Russian.** Every such string in `apps/web` is a static literal with no
  branch; `order-status-label.ts` is a total `Record<OrderStatus, string>` with no `default`, so it stops
  compiling when Phase 3 adds `delivery_failed` without a label. A test asserts what a rendering *chooses*, and
  nothing chooses here. The boundary: **API error bodies stay developer-facing English**, not shopper text.

## 3. Why there is no Playwright runner

`apps/web` has no test runner, and adding one is the "heavy infrastructure the assignment does not need" this
task was warned against. Why it buys nothing:

**Every DOM-visible fact in §2.1–§2.4 is a branch-free rendering of something this suite already asserts.** The
Buy control is `if (product.purchasable)` on the exact boolean the API returns and the suite pins to three
SKUs; the status line is a total-record lookup; the key is whatever `code` the API sends, and the API only
sends one for a `delivered` order — Postgres decides that in the query's `CASE WHEN`. The one thing a browser
would add, that the page updates *without a reload*, is `poll.ts` calling `fetch` on a timer — which this suite
runs directly: read, pay, read again.

**What would change this judgement:** a conditional in the rendering path that *derives* a fact instead of
mirroring one — purchasability computed from price rather than read off the flag, a status label with a
`default` branch, a discount computed client-side (Phase 5). Then the DOM holds a decision no API assertion
covers, and a browser test earns its cost. Phase 4 rebuilds this UI — the place to revisit it.

## 4. RED, three cycles — and the one that found something

RED means what it means in Slice 7 §4: weaken the production code a test defends, rebuild, run, watch it fail
for the stated reason, restore exactly. Three cycles, six files, each restored and confirmed byte-identical
with `diff -q`. Cycle 1 — catalogue cut to five rows, the transition from-lists emptied, `404` swapped for
`400` — failed nine of thirteen as targeted: `expected 5 to be 12`, `expected 400 to be 404`, orders stuck in
`created`. Cycle 2 — the insert writing `paid`, the empty-SKU check dropped — failed both:
`POST /api/orders … -> 500`, and `expected 422 to be 400`.

Cycle 3 broke four things, and its fourth is the most valuable finding in this slice: **`toOrderView`'s
`delivered` check swapped to `out_of_stock`**, so a delivered order's key is never published. The §2.4 AC3/AC4
test compares three reads of one order:

```ts
expect(reload.code, "reload: the same key (§2.4 AC3)").toBe(first.code);
expect(later.code,  "much later: still the same key (§2.4 AC4)").toBe(first.code);
```

Both **passed**. The gate was broken consistently, so every read returned `code: null`, and `null === null` is
a perfectly good same-value comparison: a suite built only from "the shop says the same thing twice" would have
gone green while the shop showed nobody their key. What caught it was the last assertion, the one that asks
Postgres instead — `select code from deliveries where order_id = $1`:

```
AssertionError: the database agrees with every read
  expected 'LFXC-TNCS-BPCD' to be null
```

The key was there — claimed, bound, committed. Only the answer was wrong.

**This is the Slice 4 §6 defect from the opposite direction.** There, a `23505` guard matched `error.code` that
Drizzle had moved onto the `cause`, so nineteen of twenty callers got a `500` while the database stayed
correct — *state right, answer wrong, screaming.* Here state is right and answer wrong again, but the wrong
answer is a plausible `200`, so the same split arrives as **silence**: a clean green run.

The rule, to say out loud: **an assertion that compares a system with itself can only find inconsistency, never
wrongness** — anything round-tripped through one layer stays stable when that layer is uniformly broken. An
assertion earns its keep when its two sides have *independent* sources of truth; also why `EXPECTED_CATALOG`
and `deriveTestRequestId` are transcribed into the tests rather than imported.

## 5. The leaked rows, reported honestly

Cycles 2 and 3 left order rows behind — six, then one. The cycle-2 break made `POST /api/orders` insert the row
and *then* fail on the way out, answering `500`; the helper throws on any status but `201`, so the id never
came back, never reached `orderIds`, and `cleanupTestOrders` — which deletes by the ids the test collected —
had nothing to delete. Both were caught at once, by the thing meant to catch them:

```
Error: database is not at the seeded baseline after this suite's own cleanup:
  - orders = 1, expected 0
```

They were deleted by hand, the baseline reconfirmed, and **the test left exactly as it was** — a decision:

- **Correct code cannot produce this state.** An order is created by one statement in one transaction: either
  it commits and the id comes back in the `201`, or it does not commit at all. The leak is a *symptom* of the
  deliberate break — §4's "state written, answer wrong" shape again — not a weakness in the harness.
- **Hardening cleanup would have hidden the signal.** The obvious fix, `delete from orders` in `afterAll`,
  removes rows this suite never created — dangerous against a shared database — and turns a loud, specific
  failure into silence. The baseline check is the right instrument, and it refuses the next run until the
  database is clean (`pnpm db:reset`).

Rewriting a test against a fault that exists only while you are deliberately breaking things is how harnesses
accumulate machinery that protects nothing.

## 6. One API process here, four next door

The concurrency suite spawns four `apps/api` processes because one process holds a connection pool of `max: 1`,
so two claims can never overlap inside Postgres and a claim with no locking passes cleanly (Slice 7 §2). None
of that applies here: every criterion in §2.1–§2.4, §2.6 and §2.8 is about **what one shopper sees on one
path**, and nothing needs a second request to overlap. So this suite reuses that harness and asks for one
instance on its own port. Four where nothing races would triple the boot cost and prove what one proves.

## 7. What Phase 1's testing does not cover

Three of the five adversarial scenarios are not Phase 1's to answer:

- **50 parallel webhooks on one order**, the repeated `event_id`, the out-of-order webhook (scenarios 1–3) —
  Phase 2. A different mechanism from §2.5: I4's guarded `UPDATE … WHERE status = ANY('{paid}')` in the shop,
  not `SKIP LOCKED` in the supplier. Slice 5 §8 measured it by hand at twenty.
- **The timeout trap and supplier B** — Phase 3. Supplier A always succeeds here, so an `unknown` outcome never
  occurs and nothing exercises retry-with-the-same-`request_id` or fall-through.
- **Promo codes under parallel redemption** (scenario 5) — Phase 5; those tables do not exist yet.
- **The deployed system** — Phase 6. Four processes on one machine share a kernel, a clock and a loopback;
  serverless instances do not, and the strongest form of these races runs against a public base URL.

What Phase 1 does settle is scenario 4's first half — an empty pool leaves the order recoverable and the shop
answering normally — and the spec's opening promise: one key, one shopper, proven under contention.

---

## Four questions, four answers

1. *Why no UI test, when half these criteria are about what a shopper sees?* — Every DOM-visible fact in
   §2.1–§2.4 renders a value this suite already asserts, with no decision of its own. When the rendering path
   starts deriving rather than mirroring, that changes.
2. *Why no test for §2.7 or the Russian strings?* — Neither has runtime behaviour to assert: a file-existence
   check passes against a walkthrough that explains nothing, and the labels are static literals in a total
   record that fails to compile when a status arrives without one.
3. *What did RED find, and what rule does it prove?* — Breaking the delivered-key gate did **not** fail the
   same-value assertions: both reads returned `code: null`, so `reload.code === first.code` held. Only the SQL
   cross-check disagreed — `expected 'LFXC-TNCS-BPCD' to be null`. The rule: comparing a system with itself
   finds inconsistency, never wrongness.
4. *Your test leaked rows. Why not fix it?* — Correct code cannot produce that state; only my deliberate break
   could. The baseline check caught it (`orders = 1, expected 0`) and blocks the next run until the database is
   clean — a blanket `delete from orders` would turn that signal into silence.
