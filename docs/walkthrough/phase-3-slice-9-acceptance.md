# Phase 3 · Slice 9 — The acceptance suite, and what Phase 3 actually settles

> Phase 2's slice 8 closed that phase with a suite and a coverage table in which four rows did not say "covered". This is the same closing statement for Phase 3, and the table is longer in both directions: **40** criteria rather than 28, and more rows that name where the proof lives instead of pretending to hold it. `pnpm test` now runs **11 files, 90 tests** — 3 unit, 3 acceptance, 5 concurrency — in a reported 44.9 s.
>
> Three things are worth the reader's attention. **The suite tests the wire, not the race.** Every concurrency claim in the spec was already proven across four real processes in slices 2, 3 and 5; this file is the HTTP contract those proofs never pinned down. It never arms a hang, and it stages every "never established" row by SQL, for a reason its header states and §3 weighs. **One row says "not covered anywhere by name"** — §2.2's fifth criterion, many orders quiet at once — and this document says so rather than pointing at an adjacent assertion. And **the exercise found a hole that was not in the suite's brief**: nothing in the repository had ever executed the operator guard's `503` branch, so a five-test unit file now does.
>
> Reading the suite for this document found five smaller things, and the slice closed four of them before it was ticked — the fifth is a decision, not a fix. The one assertion on `paid_at` in the whole test tree was `toBeNull()`, on a row that was staged rather than paid; the live-paid row now asserts an ISO 8601 shape (§5). The acceptance file's comments claimed seven inversions where five had quoted output; the other four were then run, and every comment quotes its own failure line (§6). `pnpm race`'s default port range, 4601–4604, was the range `supplier-refusal-and-recovery.test.ts` had bound since slice 2 — the exact collision Phase 2 hit once — and the harness README's "clear of every Vitest port" list stopped three suites short; the suite moved to 4701 and the list is complete (§7). `@regression` was on the new acceptance file against the Phase 1–2 convention; removed. And `tasks.md` said the phase had 38 criteria; the spec has 40, and the count is corrected.

---

## 1. What actually shipped

Three files, two new and one extended. `pnpm test` runs **11 files / 90 tests** — 64 that already existed and 26 new. The parent re-ran the whole suite independently after the testing agent's own run (46.11 s) and got the same 90 in 44.9 s.

| File | Tests | Shape | Covers |
| --- | --- | --- | --- |
| `apps/api/test/acceptance/failure-and-recovery.test.ts` | **16** (new) | One API process, port 4901, raw SQL against `db.pool` | §2.1 criteria 2–3, §2.2 criterion 4, §2.3 criteria 2–4, §2.4 all six, §2.5 criteria 5–6, §2.7 criterion 4's one-shot half; plus three negatives — `404` for an unknown provider, `409` for an unpaid order, `404` for a missing order id |
| `apps/api/test/unit/admin-token-guard.test.ts` | **5** (new) | No database, no HTTP, no Nest container — the real `AdminTokenGuard` class driven with a hand-built `ExecutionContext` | §2.4 criterion 6's third answer: `503` when `ADMIN_TOKEN` is unconfigured, *even with the right token presented*; and the guard's full decision table |
| `apps/api/test/unit/order-status-russian-labels.test.ts` | **8** (3 existing + 5 new) | Reads `apps/web`'s two string tables as text | §2.9 criterion 1 for `order-recovery-explanation.ts`; the shopper-facing halves of §2.3 criteria 2 and 4 |

Every new test carries `@spec: 003-failure-and-recovery` and `@layer`. The Russian-label file now carries two `@spec` lines, deliberately — it holds regression coverage for spec 002 §2.8 and spec 003 §2.9 in one place, and a grep for either tag finds it.

The full layer picture, since the total moved from Phase 2's 32 to 90:

| Layer | Files | Tests | Needs |
| --- | --- | --- | --- |
| `test/unit/` | `issuance-ladder` (23), `order-status-russian-labels` (8), `admin-token-guard` (5) | 36 | nothing — 1.13 s, run fresh for this document |
| `test/acceptance/` | `purchase-and-key-delivery` (13), `single-issuance-under-races` (11), `failure-and-recovery` (16) | 40 | one `apps/api` process each, a real Postgres |
| `test/concurrency/` | `key-claim-race` (2), `order-lock-race` (2), `fifty-webhooks-one-order` (1), `supplier-refusal-and-recovery` (4), `operator-retry-race` (5) | 14 | four `apps/api` processes each, a real Postgres |

Files run strictly one after another (`fileParallelism: false` in `apps/api/vitest.config.ts`) — every file that spawns processes assumes exclusive use of the fifty-key pool for its own span, and asserts the seeded baseline before it starts and after its own cleanup.

---

## 2. The words this document uses

- **Wire shape** — what a client actually receives over HTTP: which fields, with which names and values, and which status code. Distinct from what the database holds, and distinct from what a browser renders from it.
- **Staged** — a database state written directly by a test with raw SQL, rather than produced by driving the shop. `stageNeverEstablishedOrder` in this file, `stageStrandedDeliveringOrder` in the operator-retry race.
- **Unknown / never established** — an `issuance_attempts` row whose `status` is `unknown` and whose `last_error` is `NULL`: the shop asked, no answer came, and nobody knows whether a key was cut. The word the whole phase turns on; the opposite of `failed`.
- **Stock accounting (R2)** — `count(*) FROM supplier_keys WHERE claimed_by_request_id IS NOT NULL` equals `count(*) FROM deliveries`. The one assertion that sees a broken ladder, because `deliveries.order_id UNIQUE` holds the shopper's key count at one regardless. It holds on settled outcomes only.
- **Disposition** — one of four answers for a criterion in the coverage map: *covered here*, *covered in a named file*, *verified manually in a named slice*, or *not testable at this layer, and why*. A fifth, *not covered anywhere by name*, appears once.
- **Inversion** — the RED method for a suite written after the code: flip one assertion, run, watch it fail for the stated reason, restore. Never a change under `apps/api/src`.

---

## 3. What the suite is for

### The wire, because the race was already proven

The four-process suites from slices 2, 3 and 5 were written to prove concurrency: that a fall-through mints a new id, that a re-probe reuses the old one, that two operators pressing Retry at once produce one key. They assert attempt rows, request ids and stock accounting. What they do *not* pin down is the contract a shopper's page or an operator's screen consumes — that an order fulfilled by supplier B carries the same field set as one fulfilled by A and no field naming either; that the recovery list answers `200` with an explicit empty array and a sentence when nothing is stuck; that a retry on a delivered order is `409` and a retry into an empty pool is `200` with `outcome: "still_out_of_stock"` and a reason in words; that `unknown` reaches the wire as `unknown`.

That is this file's whole subject, and it is why it runs on **one** instance. `architecture.md` §7 puts `test/acceptance/` on one process "since nothing there needs overlapping requests", and nothing here does: every criterion it holds is about what one shopper or one operator sees on one path. A wire-shape assertion does not become more true across four processes; a race assertion does not become true at all inside one.

### No hang is ever armed, and every `unknown` row is staged

The file's header makes an argument worth restating, because a reviewer's first reaction is "you never actually timed out".

The claim: the *mechanism* that produces an `unknown` attempt — the timeout ladder — is already proven exhaustively (1,788,098 histories in `issuance-ladder.test.ts`, both rounds, plus its mutant) and run live (`pnpm race recover-timeout`, slice 3's four-process verification, `operator-retry-race.test.ts`'s `settleNeverEstablished` test). This file's subject is the **wire representation of that state once it exists**, and `GET /api/admin/orders/undelivered` reads `orders` and `issuance_attempts` — it cannot tell a hand-written row from one the ladder left behind, because it reads the same tables either way. Re-deriving the state through a real `SUPPLIER_TIMEOUT_MS`-bounded wait would spend six seconds per test (three probes at two seconds each) re-establishing a fact this file does not need to establish.

The shape it writes: the order at `delivery_failed`; one `issuance_attempts` row `a/1`, `status = 'unknown'`, `last_error` left `NULL`, `probe_count = 3`; a real key claimed under `req_{order}_a_1`; and a `supplier_requests` ledger row binding that id to that code. It cites technical-considerations §1.3 — on `settleNeverEstablished` "nothing is written to `issuance_attempts`", so the row a real exhaustion leaves is exactly the row the ladder found when it gave up.

**I agree the reasoning is sound, with one thing to add and one cost to name.** The thing to add is that the staged shape is a *legitimate* ladder output, not merely a plausible one. `issuance-ladder.ts`'s branch (2) probes while `outstanding.probeCount < maxProbesPerRequest` and otherwise falls to branch (3), `SettleNeverEstablished`, which "moves the ORDER" and touches no attempt row. With the default of three, an order whose very first supplier call hung after its claim and whose two re-probes hung the same way arrives at precisely: `a/1 unknown`, `probe_count 3`, a ledger row and a claimed key, `delivery_failed`. That is `recover-timeout`'s scenario with the silence lasting three calls instead of one. So the staged row is not a fiction the endpoint happens to accept; it is the row the live shop produces on that path — and the fact that the live shop *does* produce it is what `operator-retry-race.test.ts`'s `settleNeverEstablished` test proves, on the operator path, across four processes. The two files divide the work rather than duplicating it. (The header names both `stageStrandedDeliveringOrder` and the `settleNeverEstablished` test as the shape's source; strictly the acceptance file's row matches the second — `delivery_failed` and a spent budget, not `delivering` with one probe — and the header says so in its own words.)

The cost is the `paid_at` caveat in §5: staging bypasses the payment flow, so the row has no `payment_events` entry, so on the staged row the only honest assertion for "when it was paid for" is `null`. That is the exact place where the shortcut loses information the live path would have carried — which is why the non-null shape is asserted on the one row in the file that *was* paid through the live path, not papered over on the staged one.

### Assertions read the database; staging writes raw SQL

Per `architecture.md` §7 and the Phase 2 precedent: every database fact a test produces or depends on is read or written with a literal SQL string on `db.pool`, quoted beside the call. The file uses no query builder, so there is nothing to derive from `.toSQL()` — the emitted statement *is* the text in the source. The two fixtures it borrows — the sentinel drain of the whole key pool and its reversal — are the same technique the two four-process suites and `recover-out-of-stock` use, and for the same reason: `claimed_by_request_id` is UNIQUE (I6), so fifty rows cannot share one literal sentinel.

Cleanup is unconditional. `afterEach` resets both suppliers' one-shot counters to zero by SQL after every test, whatever it did — a leaked `fail_next` from one test would be the next test's silent wrong answer. `afterAll` asserts the seeded baseline again. That is §2.7's fifth criterion, "twice in a row with no tidying", applied to the Vitest suite rather than the race harness.

---

## 4. The coverage map — all 40 criteria

Section counts: §2.1 has 4, §2.2 has 5, §2.3 has 4, §2.4 has 6, §2.5 has 6, §2.6 has 3, §2.7 has 5, §2.8 has 5, §2.9 has 2. Dispositions: **15 covered here** (one with a caveat), **10 covered in another test file**, **8 verified in a named slice**, **6 not testable at this layer**, **1 not covered anywhere by name**.

| § | Criterion | Disposition | Where, and the note that matters |
| --- | --- | --- | --- |
| 2.1.1 | Main supplier refuses → backup is asked, shopper receives a key | covered in `test/concurrency/supplier-refusal-and-recovery.test.ts` | "headline: A's fail_next=1 -> B delivers", four processes; runnable as `pnpm race recover-refusal`. This file walks the same path only as a *precondition* for 2.1.2, confirming `["a", "b"]` off the attempt ledger before asserting anything |
| 2.1.2 | Fulfilled by the backup reads identically, no mention of which supplier | **covered here** | identical sorted key set on both `OrderView`s; none of `provider`, `supplier`, `supplier_a`, `supplier_b`, `vendor`, `source` on either |
| 2.1.3 | Both refuse → a state a person can act on, not "in progress" | **covered here** | settles `delivery_failed`, `code: null`, listed with `retryable: true`. The row mechanics — two `failed` rows, no key claimed — are in `supplier-refusal-and-recovery` |
| 2.1.4 | After a refusal, charged once and exactly one key | covered in `supplier-refusal-and-recovery.test.ts` | one delivery, one `supplier_requests` row against B, claimed keys == deliveries. A stock-accounting claim, which is why it is not here |
| 2.2.1 | No answer in time → the same supplier is asked about the same request, not a different one | covered in `test/unit/issuance-ladder.test.ts` | the `probe` rung: over 1,788,098 histories no unsettled history reaches `fallThrough`. Run live by `pnpm race recover-timeout` — `a/1 ok probe_count=2`, zero rows for `b` |
| 2.2.2 | Went quiet but had issued → the shopper gets that same key, no second | covered in `test/concurrency/operator-retry-race.test.ts` | the stranded `delivering` race: `unknown` attempt, ledger already holding the code, two concurrent resumers from different processes, one delivery, claimed == deliveries. The automatic path, live: `recover-timeout` |
| 2.2.3 | Went quiet, had not issued → asked again → definite refusal → *then and only then* the backup | covered in `issuance-ladder.test.ts` | the rule: `fallThrough` is reachable only from a fully settled history, and `failed` after spent probes is settled. **No live test sequences hang → refusal → backup end to end.** Each half runs live (`recover-timeout`, `recover-refusal`); the composition is proven at the unit layer only — see §5 |
| 2.2.4 | Still unknown after asking again → the record says never established, not failed | **covered here** | `attempts[0].status === "unknown"`, `last_error` null, `outstanding_request_id` set, top-level `last_error` null — on a staged row (§3). That the live ladder produces this row: `operator-retry-race`'s `settleNeverEstablished` test |
| 2.2.5 | Many orders quiet at once → keys that left stock equal shoppers who received one | **not covered anywhere by name** | universally: the ladder exhaustion is the rule that makes it true. Per scenario: R2 is asserted in every four-process test and all three `recover-*` checks. **No test stages simultaneous silence on many orders.** And on never-established outcomes the equality is deliberately *not* asserted — see §5 |
| 2.3.1 | Shopper told plainly that delivery failed and the shop is dealing with it | verified manually in slice 1 | a real browser; `docs/screenshots/003-failure-and-recovery-delivery-failed.png`, `…-out-of-stock.png`. "Plainly" is a judgement about prose. The precondition — two statuses reach the wire — is 2.3.2 here; the sentence exists and is Russian — `order-status-russian-labels` |
| 2.3.2 | The reason is distinguishable: out of stock reads differently from went wrong | **covered here** | `out_of_stock` and `delivery_failed` both on the wire, both `isRecoverableOrderStatus`, not equal. The two sentences differ — `order-status-russian-labels.test.ts` |
| 2.3.3 | Reload or return later → the same explanation, not an error or an empty page | **covered here** | two `GET`s 50 ms apart, `toEqual` on the whole view |
| 2.3.4 | Paid but never delivered → the payment remains recorded | **covered here** | `payment_events` rows with `status = 'paid'` for the order: exactly 1 after `delivery_failed`. The shopper-facing half — both explanations open «Оплата прошла» — `order-status-russian-labels.test.ts` |
| 2.4.1 | Every paid-but-undelivered order appears in the list | **covered here** (membership) | a live-paid order into a drained pool is listed. **Breadth** — all four statuses `paid`, `delivering`, `out_of_stock`, `delivery_failed`, and the delivered-but-still-`delivering` order excluded by `NOT EXISTS` — verified manually in slice 4 against the endpoint |
| 2.4.2 | Present immediately, without any period elapsing | **covered here** | the list is read in the line after payment is reported; no delay of any kind |
| 2.4.3 | A delivered order is not in it | **covered here** | the direct negative of membership |
| 2.4.4 | A row shows what was bought, when it was paid for, what went wrong | **covered here, with a caveat** | `sku`, `product_name`, `amount_minor`, `currency`; status `unknown` never `failed`; `probe_count`, `provider`, `attempt`. **`paid_at` is `null` on this staged row, by construction; its live shape is asserted by the criterion-2 test** — see §5 |
| 2.4.5 | Nothing stuck → told plainly, not a blank screen | **covered here** | `200`, `count: 0`, `orders: []` as an explicit array, `truncated: false`, `message` a non-empty string. The rendered empty state: slice 4, `…-recovery-empty.png` |
| 2.4.6 | Without operator credentials → refused | **covered here** + `test/unit/admin-token-guard.test.ts` | `401` with no token, a wrong token, and the right token under `Basic` — on the list *and* the retry route, end to end. The `503` unconfigured branch, including "correct token, still `503`": the unit file (§7). `503` against a live endpoint with `ADMIN_TOKEN` unset: slice 4 |
| 2.5.1 | Stuck order and a key available → key delivered, order leaves the list | covered in `test/concurrency/operator-retry-race.test.ts` | "restock after an empty pool, then retry"; runnable as `pnpm race recover-out-of-stock` |
| 2.5.2 | Stuck for lack of keys → restocked → retried → exactly one key | covered in `operator-retry-race.test.ts` | the same test: `a/3`, never a reused `a/1`; one delivery; claimed == deliveries |
| 2.5.3 | The same order retried several times in quick succession → one key, one key left stock | covered in `operator-retry-race.test.ts` | two concurrent retries on a `delivery_failed` order (`retryIssuance`), and every further press `409` |
| 2.5.4 | Two operators at the same moment → one key | covered in `operator-retry-race.test.ts` | two races from separate processes: the `retryIssuance` guard, and the stranded `resumeIssuance` whose guard excludes nobody |
| 2.5.5 | Still no key → told it did not succeed and why, order stays listed | **covered here** | `200`, `outcome: "still_out_of_stock"`, `delivered: false`, non-empty `detail`, still in the list. Also in `operator-retry-race` |
| 2.5.6 | Not stuck → refused rather than re-delivering | **covered here** | `409` on a delivered order, code unchanged, still one `deliveries` row; `409` on a never-paid `created` order; `404` on an id that does not exist |
| 2.6.1 | Waiting on a silent supplier → the page shows processing, not failed | verified manually in slice 6 | not testable here: it is what a `setInterval` inside `apps/web` does, and a script driving `fetch` cannot see it. Recoverable cadence observed at 5019–5041 ms; a terminal order issued 0 reads over 36 s |
| 2.6.2 | Established as unfulfillable → the page changes to §2.3's explanation without a reload | verified manually in slice 6 | `docs/screenshots/003-slice-6-watch-window-stopped.png` |
| 2.6.3 | Retried successfully by an operator → the key appears with no shopper action | verified manually in slice 6, RED-validated | retry from a second tab, shopper's tab untouched; with `isSettledOrderStatus` restored as the stop condition: 11 reads ending at 9 561 ms, then silence. The precondition this file *does* prove: §2.5's tests show the server-side status moves under a retry with no shopper action |
| 2.7.1 | One command exercises the supplier-failure situations alongside the existing ones | verified in slice 7 (`scripts/race/`) | `pnpm race` 8/8, twice in a row. These are the reviewer's checks, not behaviour under test — the same line Phase 2's suite drew for spec 002 §2.6 |
| 2.7.2 | One named check each for refuses, goes quiet, recovered after restock | verified in slice 7 | `recover-refusal.ts`, `recover-timeout.ts`, `recover-out-of-stock.ts`; `pnpm race --list` re-run fresh for this document prints all three |
| 2.7.3 | Weakened mechanism → the check reports a failure | verified in slice 7 | 6 of 18, 5 of 16, 9 of 25 assertions red; the ladder restored to `a5715427…86a24` |
| 2.7.4 | A supplier can be made to fail on demand, at a set rate, without changing the shop | **covered here** (the one-shot half) | `fail_next` armed through `PUT /internal/suppliers/:provider/behaviour`, `PUT {}` as the reset, `404` for an unknown provider; that a behaviour written through one process is read by another — `supplier-refusal-and-recovery`. **The "how often" half — a fractional `failure_rate` or `hang_rate` — is armed by no automated check anywhere, by design (R8)** |
| 2.7.5 | Twice in a row, no manual tidying between | verified in slice 7 | 8/8 both times. This suite asserts the seeded baseline before and after, and resets both suppliers after every test |
| 2.8.1 | A written walkthrough accompanies the phase, naming each keystone | not testable at this layer — a document | `docs/walkthrough/phase-3.md`; slice 8's two-pass review |
| 2.8.2 | Each keystone states the decision, the more obvious alternative, and what goes wrong without it | not testable at this layer | slice 8, second pass against the source |
| 2.8.3 | Where a keystone rests on the records, the exact statement sits beside the explanation | not testable at this layer | slice 8, second pass: SQL, constraint names and numbers fact-checked |
| 2.8.4 | Readable without opening the source | not testable at this layer | slice 8, first pass: read with the source closed, every load-bearing unexplained term listed |
| 2.8.5 | Covers the three named keystones | not testable at this layer | Keystones 1, 2 and 3 of `phase-3.md` are exactly the three the criterion names |
| 2.9.1 | Text this phase adds or changes is in Russian | covered in `test/unit/order-status-russian-labels.test.ts` | five tests over `order-recovery-explanation.ts`: one entry per recoverable status, Cyrillic, distinct, «Оплата прошла» first, no promise of a refund or an email. The rendered-body scan for leaked ASCII: slice 1 |
| 2.9.2 | The operator's text may be in either language | not testable — imposes no constraint | nothing can fail it (A10) |

---

## 5. What is deliberately not here, and where it lives

**The concurrency criteria — §2.1's first and fourth, §2.2's first three, §2.5's first four.** `tasks.md`'s standing requirement says why in one sentence: a `max: 1` pool serialises everything inside one instance, so a single-instance check passes against a broken implementation. `architecture.md` §7 measured it — twenty distinct keys from one process, nine from four, with the same unlocked claim. Each of these nine criteria is held by a named test in `supplier-refusal-and-recovery.test.ts` or `operator-retry-race.test.ts`, every one of which asserts stock accounting across four processes, or by the ladder exhaustion for the rule underneath. Re-stating them here as one more end-to-end example on one process would produce a green row that guards nothing.

**§2.6, all three — the shopper watches.** Each is a fact about what a browser, left open and polling, goes on to render. No HTTP assertion from this file can distinguish a page that kept its poll running from one that silently stopped; both look identical to a script calling `fetch`, and different only to a `setInterval` inside `apps/web`. Slice 6's walkthrough records the criterion as one that "fails by definition rather than by bug" when the polling change is skipped, and its RED showed exactly that shape — with the old stop condition restored, the shopper's tab made eleven reads, the last returning `delivery_failed`, and then nothing, while the database showed the order delivered. That class of fact needs a tab. This project has no browser test layer by design (`architecture.md` §7), so the tab was a real one, in slice 6. What this file *can* prove is the precondition — that the server-side status genuinely changes under an operator's retry with no shopper action — and §2.5's tests do.

**§2.7 — the reviewer's checks.** `recover:refusal`, `recover:timeout`, `recover:out-of-stock` *are* the checks the criteria describe; they are not application behaviour to be tested from here. Built, RED-validated and run twice consecutively in slice 7. The one part of §2.7 this file does hold is criterion 4's control surface, because the suite itself drives it: a one-shot refusal armed through the endpoint, the documented `PUT {}` reset, and a `404` for a provider that does not exist.

**§2.8 — a document.** Reviewed in slice 8 in two passes, the first with the source closed.

**§2.9's first criterion — the actual Russian text.** A `GET` from this file sees `status: "out_of_stock"`, never the sentence `apps/web` renders for it. The sentence is checked as text in `order-status-russian-labels.test.ts`, extended rather than duplicated. **§2.3's first criterion — "plainly"** — is a judgement about rendered prose, made by a person in slice 1's browser check.

Four things in this section are not a clean hand-off to another home, and they are the part worth reading.

**§2.2 criterion 5 is not covered anywhere by name.** *"Given a supplier goes quiet on many orders at once, when the shop has finished handling all of them, then the number of keys that have left the shop's stock equals the number of shoppers who received one."* What exists: the ladder exhaustion proves, for every history over the alphabet, that silence never leads to a fall-through — the rule that makes the criterion true; and every four-process test and every `recover-*` check asserts claimed keys against deliveries after its own scenario. What does not exist: a test that stages silence on N orders at once and reads stock accounting over all N. Nobody wrote it, and this document is not going to claim the two halves add up to it. There is also a second, sharper point. On a never-established outcome the equality is *deliberately* not asserted — R2 was amended in slice 3 after measuring `claimed_keys 2, deliveries 1` on the probes-exhausted path and recognising it as correct: a key genuinely cut by a silent supplier, its code never received. The phase bounds that loss to one key per outstanding attempt; it does not eliminate it. So the criterion as literally written holds on settled outcomes and is a bound, not an equality, on the one path the criterion is most about. `phase-3.md`'s "What is not finished" says the same.

**`paid_at` was asserted once in the whole test tree, and the assertion was `toBeNull()` — found here, fixed here.** §2.4 criterion 4 asks for "when it was paid for". The row this file examines for that criterion was staged (§3), so it has no `payment_events` entry, so the honest assertion on it is `null` — the file says so beside the line. As first written, the criterion-2 test — the one order in the file paid through the real webhook path, which therefore carries a real `paid_at` — asserted membership only and never read the field. Why that mattered more than a nit: slice 4's walkthrough records a bug found only by real data — a bare `sql<Date>` that type-checked and handed back a string, surfacing as a `500` "on the first order that had a `paid` event … an empty database would never have caught it, and neither would any fixture without a payment event." The one `paid_at` assertion in the tree sat on exactly such a fixture. The criterion-2 test now reads its own row back and asserts `paid_at` against `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/` — the shape only a `Date` serialises to. A `not.toBeNull()` would have been the wrong fix: the slice-4 bug's raw `'2026-09-11 13:49:00.12+00'` is not null. `grep paid_at apps/api/test` now returns two assertions, one per fixture shape, and each says why it is the one it is.

**§2.2 criterion 3's composition is proven at the unit layer only.** "Went quiet, asked again, got a definite refusal, then the backup" is three rungs in sequence. The ladder exhaustion proves the sequence is the only one the rule permits. `recover-timeout` runs the first two rungs live (hang, re-probe); `recover-refusal` runs the last two (refusal, fall-through). No live test runs all three on one order. Staging it is not free: both stubs read `fail_next` *before* the ledger and before the hang, so a test would have to arm the refusal during the two-second silence window between the first call and the re-probe. Possible, not done.

**§2.7 criterion 4's "how often" is never exercised automatically.** The rate fields round-trip through the endpoint and every check sends them as `0`. Slice 7's walkthrough explains why no check may arm one — a rate is a coin toss, and a coin toss makes criterion 5 untrue by construction (R8). The rates exist for a person exploring by hand, and that is the only way they have been used.

---

## 6. RED validation without touching `src/`

Slices 3, 6 and 7 established RED by weakening production code and restoring it byte-identical. The brief for this slice forbids repeating that, and the implementation already exists, so "write it failing first" is not on the table either. The method is the Phase 2 one: invert one assertion, run, read the failure to confirm it failed for the stated reason, restore. Five inversions were run across the three files, none touching `apps/api/src`. The lines below are quoted from the test files — the assertion and the comment that names its inversion — rather than paraphrased. The failure output itself is in the testing agent's report to the parent and is not reproduced here; it was not re-run for this document.

**1. `503` versus `401` on the guard** — `test/unit/admin-token-guard.test.ts`. The test titled *"ADMIN_TOKEN not configured: refused with 503 EVEN WHEN the presented token is the correct one — unconfigured means closed, never open"* asserts:

```ts
expect(() => guard.canActivate(contextWithAuthorization(`Bearer ${REAL_TOKEN}`))).toThrow(
  ServiceUnavailableException,
);
```

Inverted to `UnauthorizedException`. This is the inversion that matters most, because it is the one a plausible bug would produce: a guard that checked the token before checking whether a token was configured would answer `401` here, and until this file nothing in the repository could tell.

**2. A wrong `PAYMENT_RETAINED_PREFIX`** — `test/unit/order-status-russian-labels.test.ts`:

```ts
const PAYMENT_RETAINED_PREFIX = "Оплата прошла";
…
expect(
  explanation.startsWith(PAYMENT_RETAINED_PREFIX),
  `explanation #${String(index)} ("${explanation}") does not open with "${PAYMENT_RETAINED_PREFIX}"`,
).toBe(true);
```

The constant changed to a string neither explanation opens with. This one guards §2.3's fourth criterion on the shopper's side — that the first words a shopper reads on a failed order say the payment went through.

**3. `.not.toContain("provider")` inverted** — `failure-and-recovery.test.ts`, §2.1 criterion 2:

```ts
// CAN FAIL: the shop genuinely never sends this field — inverted
// to `.toContain` and re-run; see this task's report for the
// quoted failure.
for (const forbidden of ["provider", "supplier", "supplier_a", "supplier_b", "vendor", "source"]) {
  expect(mainKeys, `no "${forbidden}" field on a normal order`).not.toContain(forbidden);
  expect(backupKeys, `no "${forbidden}" field on a fallen-through order`).not.toContain(forbidden);
}
```

**4. `unknown` → `failed` expected** — `failure-and-recovery.test.ts`, §2.4 criterion 4:

```ts
// CAN FAIL — the exact bug technical-considerations §9.3 names
// (`reason ?? "failed"`): inverted to `.toBe("failed")` and
// re-run; see this task's report for the quoted failure.
expect(attempt.status, "the newest attempt must read 'unknown', never 'failed'").toBe("unknown");
```

This is §2.2's fourth criterion on the wire, and the one-character bug technical-considerations §9.3 warns about on the only screen where a person reads that record.

**5. `409` → `200` expected** — `failure-and-recovery.test.ts`, §2.5 criterion 6:

```ts
// CAN FAIL: a retry endpoint with no status guard would happily
// re-run issuance on an already-delivered order — inverted to
// `.toBe(200)` and re-run; see this task's report for the
// quoted failure.
expect(retried.status, `retry on a delivered order -> ${JSON.stringify(retried.body)}`).toBe(409);
```

One discrepancy was found here and closed here. As first written, the acceptance file's comments described **seven** inversions as "inverted … and re-run" — the three above plus four more — while the header promised quoted output "for at least three", and only the five in this section had output anyone had seen. Two of the four comments also named a flip the code could not take (`.not.toContain` on a boolean `toBe(true)`). The four were then actually run, all at once in one pass over the file, with the other twelve tests untouched:

**6. `message` length `.toBeGreaterThan(0)` → `.toBe(0)`** — §2.4 criterion 5:

```
AssertionError: message: "Nothing to recover: every paid order is holding a key.": expected 54 to be +0
```

**7. Immediate membership `.toBe(true)` → `.toBe(false)`** — §2.4 criteria 1 & 2:

```
AssertionError: order ord_01M2DFFAC6H496908F8208ER9A must appear immediately; list: ["ord_01M2DFFAC6H496908F8208ER9A"]: expected true to be false
```

**8. Delivered order absent `.toBe(false)` → `.toBe(true)`** — §2.4 criterion 3:

```
AssertionError: a delivered order must not be listed; list: []: expected false to be true
```

**9. `paid` event count `.toBe(1)` → `.toBe(0)`** — §2.3 criterion 4:

```
AssertionError: the 'paid' event is still on record after delivery failed: expected 1 to be +0
```

`Tests  4 failed | 12 passed (16)`, then the file restored byte-for-byte from a copy taken before the edits. Every one of the nine comments in the three files now names the exact flip and quotes its own failure line, so the header's "at least three" is no longer a promise about a report — it is checkable against the file. Number 8 is worth a second look: the list was `[]`, so the inversion proves the `NOT EXISTS (SELECT 1 FROM deliveries …)` predicate is doing its work on a delivered order, which is the one negative assertion in the file that a query missing that predicate would fail.

---

## 7. Also worth including

**The `503` branch had zero executable coverage anywhere, and it took a coverage table to notice.** Every suite that reaches `AdminTokenGuard` boots its instance with `ADMIN_TOKEN` set, because every one of them needs it — to arm a supplier or press Retry. So the branch that answers `503` when the variable is *unset* had never once run under a test. Slice 4 had verified it by hand against a live endpoint, correctly; nothing guarded it afterwards. Spinning up a second `apps/api` process without the variable would have cost up to ~13 s (the harness's own measured startup on a loaded machine) to prove three lines of TypeScript that need no database, no HTTP server and no Nest container. `@Injectable()` is inert until a container reads it, so `new AdminTokenGuard(config)` with a hand-built `AdminTokenConfig` and a hand-built `ExecutionContext` is the whole test. Five cases: unconfigured with the *right* token still `503`; configured with no header, a one-character-off token, and a `Basic` scheme all `401`; configured with the right token admitted. What the unit file does not prove — that `@UseGuards(AdminTokenGuard)` on `OrderRecoveryController` actually consults this table — is what the acceptance suite's `401` tests prove against a running instance. Neither replaces the other, and both say so.

**`tasks.md` said 38; the spec has 40.** Counted section by section while writing the coverage map — 4, 5, 4, 6, 6, 3, 5, 5, 2 — and the file's header now reads 40. A coverage table over the wrong denominator is a table that cannot be complete, whichever way it is filled in.

**One convention diverged, silently; restored.** Phase 2's closing walkthrough records that `@regression` goes on the concurrency and unit files "and not on the acceptance suite, which is the same pattern Phase 1's `purchase-and-key-delivery.test.ts` already follows." Both earlier acceptance suites have no `@regression` line; `failure-and-recovery.test.ts` had one at file level as first written. Removed, so the three acceptance files agree and the convention holds without a footnote.

**The port collision Phase 2 fixed once came back, and the comment that should have prevented it was wrong.** `scripts/race/run-checks.ts` has `DEFAULT_BASE_PORT = 4601`; `supplier-refusal-and-recovery.test.ts` had bound `4601–4604` since slice 2. The two never run at the same moment in the documented flow — `pnpm race` is not a Vitest suite — so nothing had failed; but the new acceptance file's port comment named `4201–4204` as `pnpm race`'s default, which was the range Phase 2 moved *away from* for exactly this reason, and `scripts/race/README.md`'s `RACE_BASE_PORT` row claimed 4601 was "clear of every port the Vitest suites bind" with a list that stopped at 4504. `supplier-refusal-and-recovery.test.ts` now binds `4701–4704` and says why beside the constant; the acceptance file's comment and the README row list every range the tree actually binds: 4101–4104, 4201, 4301, 4401–4402, 4501–4504, 4601–4604 (`pnpm race`), 4701–4704, 4801–4804, 4901.

**The acceptance file's header pointed at "this task's report"** for the row-by-row disposition and the RED output — a report that is not in the tree. Both pointers now name this document's §4 and §6.

---

## 8. Where this sits in the assignment

`context/product/product-definition.md` §1.4 lists five adversarial scenarios. `phase-3.md` scores them; this document adds the column that is this slice's business — what runs on every `pnpm test` without anyone remembering to.

| # | Scenario | Status after Phase 3 | Runnable by name | On every `pnpm test` |
| --- | --- | --- | --- | --- |
| 1 | 50 parallel `paid` reports → one issuance fact, one key | Settled (Phases 1–2) | `pnpm race webhooks` | `fifty-webhooks-one-order.test.ts`, four processes |
| 2 | A repeated report with the same `event_id` changes nothing | Settled (Phase 1) | `pnpm race same-event` | `single-issuance-under-races.test.ts` |
| 3 | A report before its order | Settled (Phase 2) | `pnpm race before-order` | `single-issuance-under-races.test.ts` |
| 4 | Empty pool → recoverable → after restock, exactly one key | **Settled this phase** | `pnpm race recover-out-of-stock` | `operator-retry-race.test.ts` (the race, four processes) and this suite (the wire: `200 still_out_of_stock` into an empty pool, `409` on a delivered order) |
| 5 | A promo code with limit N under parallel requests | Phase 5. Not started | — | — |

Scenario 4 was "half-won" at the end of Phase 2 — the state existed, the list and the retry did not. It now has a race script, a permanent four-process regression test, and a wire-contract suite. The phase's central trap, «таймаут ≠ отказ», is not one of the five numbered scenarios; it is §2.2, and its permanent homes are the ladder exhaustion, `recover-timeout`, and the `unknown`-on-the-wire tests here.

---

## 9. What is not finished

- **§2.2 criterion 5 by name.** A test that arms `hang_next = N` on supplier A after the claim, pays N orders across four processes, waits for all N to settle, and asserts R2 over the settled ones and the amended bound over the rest. Every building block exists — the sentinel drain, `armBehaviour`, `waitUntilSettled`, four instances — and nobody assembled them. Cost: N × 2 s of genuine waiting per run.
- **§2.2 criterion 3 end to end.** Hang, re-probe, refusal, backup on one order. Needs the refusal armed during the silence window, since the stubs read `fail_next` before anything else.
- **The browser-test judgement has met its own trigger.** `architecture.md` §7 declines a browser layer "as of Phase 1" and names what would change that: a conditional in the rendering path that derives a fact rather than mirroring one. Slice 6's poll stop condition is a client-side branch whose failure no API-layer test can observe — the walkthrough's own phrase is "no test in the repository has a tab." §7 names Phase 4 as the place to revisit it. This is a note that the case has strengthened, not a decision.
- **No root `README.md`**, still. The scenario table above is the mapping `architecture.md` §7 says lives there.

---

## Interview questions this answers

**"What does this suite prove that the four-process suites don't?"**
The contract. The race suites were written to prove concurrency, and they assert what concurrency breaks — attempt rows, request ids, claimed keys against deliveries. They never pinned down what a client receives: that an order fulfilled by the backup carries the same field set as one fulfilled by the main supplier and nothing naming either; that an empty recovery list is `200` with an explicit empty array and a sentence; that a retry into an empty pool is `200 still_out_of_stock` with a reason and a retry on a delivered order is `409`; that `unknown` reaches the wire as `unknown` and not as `failed`. Sixteen tests on one instance, because a wire-shape fact does not become truer across four processes and a race fact does not become true at all inside one.

**"You never inject a hang here. Isn't staging the `unknown` row cheating?"**
It would be if this file were proving the ladder. It is proving what the endpoint says about a row once the row exists, and the endpoint reads `orders` and `issuance_attempts` — it cannot tell a staged row from one the ladder left. And the staged row is exactly what the ladder leaves: branch (2) probes while `probe_count` is below the ceiling and branch (3) settles the order without touching the attempt, so three silent calls on the first attempt produce `a/1 unknown probe_count 3`, a ledger row, a claimed key, and `delivery_failed` — the shape the file writes. That the live ladder does produce it is proven where it should be, in the four-process operator-retry suite's exhausted-probes test. The real cost of the shortcut is one I named rather than hid: the staged row has no payment event, so `paid_at` is asserted `null`.

**"Which rows don't say 'covered here', and why not just cover them?"**
Twenty-five of forty. Nine are concurrency claims, held across four processes in two suites or by the ladder exhaustion — restating them on one process produces a green row that a broken lock passes. Three are §2.6, facts about a browser tab left open, which a script calling `fetch` cannot distinguish from a tab that stopped; they were watched in a real browser, and the RED there showed the exact failure — eleven reads and then silence. Four are §2.7, the reviewer's checks themselves. Five are §2.8, a document. Two are text — the Russian sentence, checked as text in the unit file, and "plainly", judged by a person. One imposes no constraint at all. And one — many orders quiet at once — is not covered anywhere by name, and the table says so. Covering any of them here would mean asserting something adjacent and calling it the criterion.

**"There is a row that says 'not covered anywhere by name'. What would it take?"**
§2.2's fifth criterion — many orders quiet at once, keys out equals shoppers served. The rule that makes it true is proven over every history the ladder can see, and stock accounting is asserted after every four-process scenario and every race check. What nobody wrote is a test that arms silence on N orders at once and reads the accounting over all N. It is a day's assembly of parts that exist. And the honest second half: on never-established outcomes the equality is deliberately not asserted, because it is false on a correct system — a silent supplier may have cut a key whose code never arrived. The phase bounds that loss at one per outstanding attempt. So the criterion is an equality on settled outcomes and a bound on the path it most cares about.

**"You wrote these tests after the code. How do you know they can fail?"**
Five assertions were inverted, one at a time, and each run went red for the stated reason before the line was restored — with nothing under `apps/api/src` touched. `ServiceUnavailableException` to `UnauthorizedException` on the unconfigured guard; the «Оплата прошла» prefix changed to a string neither explanation opens with; `.not.toContain("provider")` to `.toContain`; `.toBe("unknown")` to `.toBe("failed")`, which is the one-character bug the technical notes name; `.toBe(409)` to `.toBe(200)` on a retry against a delivered order. The file's comments describe four more inversions than were confirmed with output, and I say so rather than round up.

**"Did the exercise find anything?"**
Several, none in the suite's brief, and all but one closed in the slice. The operator guard's `503` branch — refuse when `ADMIN_TOKEN` is unconfigured, even with the right token presented — had never executed under any test, because every suite that reaches the guard needs the token set; it now has a five-case unit file that drives the real class with no process. The task list's criterion count was 38 against a spec with 40. The only `paid_at` assertion in the tree was `toBeNull()` on a staged row — the one fixture shape that cannot catch the decoder bug slice 4 found on real data — and the live-paid row now asserts the ISO shape. Four inversion comments claimed a run nobody had seen; they were run. And `pnpm race`'s port range had been shared with a Vitest suite for two slices while the comment meant to prevent that named the wrong range — the suite moved.

**"What is still not done?"**
The many-orders silence test. The three-rung composition of §2.2's third criterion run live on one order. And the standing items — the restock endpoint, the root README, and Phase 4's revisit of the browser-test question, which slice 6 made sharper.

---

## Source files

- `apps/api/test/acceptance/failure-and-recovery.test.ts` — the sixteen tests; the header's "what is deliberately not here" and "why no hang is ever injected"; `stageNeverEstablishedOrder`; the `CAN FAIL` comments beside each decisive assertion
- `apps/api/test/unit/admin-token-guard.test.ts` — the `503` gap, why it is a unit test and not a second process, and what it does not prove
- `apps/api/test/unit/order-status-russian-labels.test.ts` — the second `describe`, `PAYMENT_RETAINED_PREFIX`, and why the file reads `apps/web` as text
- `apps/api/test/concurrency/supplier-refusal-and-recovery.test.ts` — §2.1 across four processes
- `apps/api/test/concurrency/operator-retry-race.test.ts` — §2.5 across four processes; `stageStrandedDeliveringOrder` and the `settleNeverEstablished` test whose row shape this suite borrows
- `apps/api/test/unit/issuance-ladder.test.ts` — §2.2 criteria 1–3 as a rule over 1,788,098 histories, and the mutant
- `apps/api/test/concurrency/support/db.ts` — `cleanupTestOrders`'s prefix pattern, which is what lets a staged key under `req_{order}_a_1` be un-claimed; `assertBaseline`
- `apps/api/src/issuance/issuance-ladder.ts` — branches (2) and (3): `probeCount < maxProbesPerRequest`, and the settle that touches no attempt row
- `apps/api/vitest.config.ts` — `fileParallelism: false`
- `scripts/race/run-checks.ts` — `DEFAULT_BASE_PORT = 4601`
- `context/spec/003-failure-and-recovery/functional-spec.md` — the 40 criteria
- `context/spec/003-failure-and-recovery/technical-considerations.md` §1.3, §8, §9.3, §11 (R2, R8) — the give-up path writes nothing; the guard's three answers; `reason ?? "failed"`; the amended stock-accounting bound; why no check arms a rate
- `context/product/architecture.md` §7 — one process for acceptance, four for races, and the browser-test judgement with its own trigger
- `docs/walkthrough/phase-2-slice-8-the-acceptance-suite.md` — the precedent, and the `@regression` convention this slice's file diverges from
- `docs/walkthrough/phase-3-slice-1-a-failure-you-can-see.md` §4 — the rendered-body scan and the screenshots behind §2.3.1
- `docs/walkthrough/phase-3-slice-4-finding-the-stuck-orders.md` — the `401`/`401`/`503` endpoint checks, and the `sql<Date>` bug behind the `paid_at` caveat
- `docs/walkthrough/phase-3-slice-6-watching-recovery.md` §3, §4 — "no test in the repository has a tab", and the RED that stopped at 9 561 ms
- `docs/walkthrough/phase-3-slice-7-checks-a-reviewer-can-run.md` §2, §4 — why no check arms a rate; the three REDs
- `docs/walkthrough/phase-3.md` — "Stock accounting is a bound, not a guarantee"

**On evidence:** what I ran fresh while writing this document, against the tree as it stands, with no server started, no source file and no test file modified. `vitest run test/unit/` in `apps/api`: **3 files, 36 tests passed** in 1.13 s. `pnpm race --list`: eight names — `harness`, `before-order`, `create-order`, `recover-out-of-stock`, `recover-refusal`, `recover-timeout`, `same-event`, `webhooks`. `grep -c` on `it(` declarations across all eleven test files: 23, 8, 5, 16, 11, 13, 2, 2, 1, 4, 5 — summing to 90, matching the reported run. The nine criteria groups of the functional spec counted by hand: 4, 5, 4, 6, 6, 3, 5, 5, 2 — 40. `grep hang_next` over the acceptance file: one `PUT` body carrying `hang_next: 0` and the `afterEach` reset, no arming. `grep paid_at` over `apps/api/test`: one assertion, `toBeNull()` — before the fix. `grep -c @regression` over the three acceptance suites: 0, 0, 1 — before the fix. `DEFAULT_BASE_PORT = 4601` in `run-checks.ts` and `BASE_PORT = 4601` in `supplier-refusal-and-recovery.test.ts`, against the acceptance file's comment saying `4201-4204` — before the fix. I read `issuance-ladder.ts`'s branches (2) and (3), `stageStrandedDeliveringOrder` and the `settleNeverEstablished` staging in `operator-retry-race.test.ts`, `cleanupTestOrders`'s `req_{order}_%` pattern, and `git status` — the four modified and four untracked paths, none under `apps/api/src` or `packages/` except a comment-only edit to `packages/db/src/schema/shop.ts` that predates this task.

The fixes in §5–§7 and the four extra inversions in §6 were made and run after this document was first written, and their outputs are quoted from that run. Everything else is reported by other agents and quoted rather than re-run: the full `pnpm test` at 11 files / 90 tests — 46.11 s from the testing agent and 44.9 s from the parent's independent re-run before the fixes, and the post-fix run recorded in `tasks.md`; the first five inversions and their failure output; the browser evidence of slices 1, 4 and 6 (the screenshots I opened only by name); slice 7's `8/8` runs and RED table; slice 3's and slice 5's exhaustion counts; and the `20 distinct / 9 distinct` measurement in `architecture.md` §7 behind the four-process rule.
