# Phase 2 · Slice 8 — The acceptance suite, and what Phase 2 actually settles

> This is the last task of Phase 2, and it is a closing statement rather than a new argument. The arguments
> live in the six slice walkthroughs, in `phase-2.md`, and in `phases-1-and-2.md`; this document says what
> the suite added, which of the assignment's five adversarial scenarios are now settled, which are not, and
> what a reviewer can run for themselves.
>
> Two things in it are worth a reader's attention. **All 28 of spec 002's acceptance criteria are mapped, and
> four of those mappings are not a test run** — they are named as untestable at this layer, with the place
> they were actually verified written next to them. A coverage table whose every row says "covered" is a
> table nobody checked. And **the RED exercise found a defect in a test rather than in the shop** — one
> inverted assertion leaked an `orders` row, because the inversion sat before its own cleanup registration.
> That is precisely what the exercise is for.

---

## 1. What this slice added

Three files. `pnpm test` now runs **6 files / 32 tests** — 17 that already existed and 15 new — and the whole
suite was run twice consecutively with identical results.

| File | Tests | Shape | Covers |
| --- | --- | --- | --- |
| `apps/api/test/acceptance/single-issuance-under-races.test.ts` | 11 | One API process, port 4301 | §2.1 (all six criteria), §2.2 criteria 1 and 3, §2.3 (all three), §2.4 criteria 1 and 2, plus a malformed-body negative case |
| `apps/api/test/concurrency/fifty-webhooks-one-order.test.ts` | 1 | **Four real API processes**, ports 4501–4504 | §2.2 criterion 2 — the assignment's fifty-report scenario, as a permanent regression test |
| `apps/api/test/unit/order-status-russian-labels.test.ts` | 3 | No database, no process | §2.8 |

Every test carries `@spec: 002-single-issuance-under-races` and a `@layer`. `@regression` is on the two files
that belong in the permanent regression suite — the concurrency test and the unit test — and not on the
acceptance suite, which is the same pattern Phase 1's `purchase-and-key-delivery.test.ts` already follows.

Two of those three deserve a sentence each on *why they exist at all*, because both look redundant at first
glance.

**The fifty-webhook test duplicates `pnpm race webhooks` on purpose.** They are the same scenario at the same
scale, and neither replaces the other. The race script is what functional spec §2.6 names as the reviewer's
own reproducible check — a thing someone runs deliberately. The Vitest test is what runs on every `pnpm test`
without anybody remembering to. `architecture.md` §7 describes the two as siblings rather than alternatives,
and Slice 6 §4.3 is the reason to keep both: the RED exercise there found that `race:webhooks` does **not**
guard the atomic key claim it named, and that the check which does is a Vitest concurrency test. The two
suites catch different breakages.

**The Russian-label test is new because its premise changed.** Phase 1 left §2.8 to a source-review note for
a good reason: only `created` was reachable through the UI, so the other five labels were unread prose. Phase
2 makes `paid`, `delivering`, `payment_failed` and `out_of_stock` states a shopper genuinely watches go past
(§2.5), so a label silently left in English would now be shown to a real person. It reads
`apps/web/src/entities/order/lib/order-status-label.ts` as **text** rather than importing it — `apps/web` is a
separate Vite application, not a workspace package `apps/api` depends on, and a test that imports the very
table it is meant to catch a mistake in cannot catch that mistake.

---

## 2. The four rows that do not say "covered"

This is the part of the coverage table worth reading. Each of these is mapped to where it *was* verified, not
to a test that quietly asserts nothing.

**§2.1 criterion 1 — a genuine double-click.** No request Vitest can send distinguishes "one idempotency key
sent twice" from "two keys sent once": from the test's side both are two identical-looking HTTP calls. That
distinction is the entire failure mode `phase-2-slice-1-one-order-per-intent.md` §3 describes — a key minted
inside the click handler passes every scripted test while a real double-click still buys two copies. So the
test here proves the *server* half (the UNIQUE index converges concurrent requests that already share one
key) and says so in its own comment. The criterion itself was verified in Slice 1 the only way it can be: a
real browser, a real double-click, the database read afterwards.

**§2.4 criterion 3 — a genuine `5xx` when the shop could not record a report.** One path produces it: the
inbox insert itself throwing, in `payment-events.service.ts`'s catch-and-rethrow — "the one case that is
allowed to fail". Reaching it means breaking real database connectivity mid-test. Confirmed by source review;
not by execution, and labelled that way rather than approximated with a test that always passes.

**§2.5's browser-visible criteria.** `phase-2.md`'s "What is not finished" already admits that nothing in the
source structurally defends the timing window the order page's refresh has to land inside. A polling test
either flakes on a slow CI box or asserts nothing. Verified in Slice 4 the same way spec 001's counterpart
was — a real browser, an intermediate label observed **9 times out of 9**. What the suite asserts instead is
the structural precondition that creates the window at all: §2.4's test proves the webhook acknowledges
before the order settles.

**§2.7 — the walkthrough.** A document, not runtime behaviour. Verified by Slice 7's two-pass audit.

The alternative was available and is rejected: write a test per criterion, let the four thin ones assert
something adjacent, and report 28/28. That produces a table where every row is green and four of them are
decoration — the same failure §2.6 exists to forbid for the race checks, in a different costume. A reviewer
who finds one such row stops trusting the other 24.

---

## 3. RED validation without touching production source

Slice 6 established RED for the five race checks by weakening production code and restoring it byte-identical
(`phase-2-slice-6-checks-a-reviewer-can-run.md` §4). That method belongs to an implementation-capable agent
and was already done. It is not available here for a second reason as well: the implementation these tests
cover already exists, so "write it failing first" is not on the table.

The method used instead was a temporary, targeted inversion of what each test asserts — never a change to
`apps/api/src` — run to watch it fail for the stated reason, then reverted. All 15 new tests went through it.
Four of the observed failures:

| Inverted assertion | Failure |
| --- | --- |
| Idempotency convergence | `expected 1 to be 2` |
| Redelivery classification | `expected 'duplicate' to be 'stored'` |
| Out-of-order application | `expected 'delivered' to be 'payment_failed'` |
| Acknowledgement timing | `expected 5 to be less than 1` |

**One inversion leaked a single `orders` row**, because the inverted line sat before its own cleanup
registration — so the test's `finally` had nothing to delete. It was found by direct SQL against the database
after the run and removed. That is worth telling plainly: the RED exercise found a flaw in the *test*, which
is exactly the class of thing it exists to find. A test whose cleanup is registered after the assertion that
can throw is a test that poisons the next run's baseline, and it would have surfaced later as a mysterious
`unclaimed = 49, expected 50` in some unrelated suite — which is precisely how the Slice 2 leak was found the
first time.

---

## 4. The five adversarial scenarios, scored

`context/product/product-definition.md` §1.4 lists five scenarios and calls them the definition of success.
**The double-click is not one of them** — it is Этап 2's headline requirement and spec 002 §2.1. Conflating
the two misquotes the assignment to the person who wrote it, and this project made that error once already.

| # | Scenario | Status after Phase 2 |
| --- | --- | --- |
| 1 | 50 parallel `paid` reports for one order → one issuance fact, one key | **Settled and runnable** — `pnpm race webhooks`, plus a permanent regression test across four processes |
| 2 | A repeated report with the same `event_id` changes nothing | **Settled** since Phase 1 by the `event_id` PRIMARY KEY; runnable as `pnpm race same-event` |
| 3 | A report arriving before its order | **Settled this phase** — stored by the absent foreign key, applied by the four triggers; runnable as `pnpm race before-order` |
| 4 | An empty pool leaves the order recoverable; after restocking, exactly one key | **Half-won.** The out-of-stock state is real, and a restock re-issues cleanly against the same derived request id. The operator's list of paid-but-undelivered orders and the manual retry are **Phase 3**, with no check here |
| 5 | A promo code with limit N under parallel requests | **Phase 5. Not started** — the tables do not exist |

The double-click has its own check, `pnpm race create-order`, which also asserts the negative complement: a
*fresh* key still creates a *new* order. Why that second half is load-bearing is Keystone 1's argument in
`phase-2.md`, not re-derived here.

---

## 5. What a reviewer can run

```sh
pnpm race              # five checks, four real processes, twice in a row, 5/5
pnpm race --list       # what exists; runs nothing, needs nothing running
pnpm test              # 6 files, 32 tests
pnpm test:concurrency  # the suite that actually guards the atomic key claim
RACE_BASE_URLS=https://…  pnpm race    # a deployed target
```

Two npm aliases were hardcoded to a single file each and had been silently omitting newer tests:

```
"test:concurrency": "vitest run test/concurrency/key-claim-race.test.ts"
"test:acceptance":  "vitest run test/acceptance/purchase-and-key-delivery.test.ts"
```

`test:concurrency` was missing the order-lock race from Slice 5 (fixed during Phase 2, when that file
arrived); `test:acceptance` was missing this slice's own new suite until now. Both are directory globs today.
The general lesson costs one line: **a hardcoded test path is a test that stops running the moment somebody
adds a sibling** — and it fails silently, in the direction of a green run.

One practical note on ports, since the suites now spread across several: the Vitest files bind 4101, 4201,
4301, 4401 and 4501–4504, while `pnpm race` defaults to 4201–4204. They do not collide when run one at a
time, which is how both are documented; running them simultaneously needs `RACE_BASE_PORT` set. (The comment
in `run-checks.ts` still describes the Vitest suite as occupying 4101–4104, which was true when it was
written.)

---

## 6. What remains after Phase 2

Said plainly, because the phase is over and a reviewer should not have to infer it.

- **Phase 3** — unreliable suppliers, the *unknown*-versus-*failed* distinction, the backup supplier, the
  admin recovery view and manual retry. This is where scenario 4 closes. It is also where the order row lock
  stops being defence in depth and starts being load-bearing: `phase-2-slice-5-one-worker-per-order.md` §3
  records that today the lock changes no observable outcome — ten RED executions confirmed it.
- **Phase 4** — the storefront built to the Figma design, with its five graded interactions. The assignment's
  mandatory Этап 1, and the first thing a reviewer opens.
- **Phase 5** — promo codes, and scenario 5.
- **Phase 6** — the Vercel deploy, the root `README.md` — which `architecture.md` §7 already calls the
  deliverable and which does not exist yet — and the honest time report.

---

## Interview questions this answers

**"Which of the five adversarial scenarios does your solution actually settle?"**
Three outright, one half, one not started. Fifty parallel reports for one order, a repeated report with the
same `event_id`, and a report arriving before its order are all settled and all runnable by name —
`pnpm race webhooks`, `pnpm race same-event`, `pnpm race before-order` — across four real processes. Scenario
4 is half-won: the out-of-stock state is real and a restock re-issues cleanly against the same derived request
id, but the operator's list of paid-but-undelivered orders and the manual retry are Phase 3 and there is no
check for them here. Scenario 5, the promo limit, is Phase 5 and the tables do not exist. Worth stating
separately: the double-click is *not* one of the five — it is Этап 2's headline requirement and spec 002 §2.1,
and it does have its own check, `pnpm race create-order`.

**"Your coverage table has rows that say 'not covered'. Why not just cover them?"**
Because covering them at this layer would mean asserting something adjacent and calling it the criterion.
Four rows are like that. A genuine double-click cannot be distinguished from two scripted requests carrying
one key — from Vitest both are two identical HTTP calls, and that difference is the exact failure mode where
minting the key in the click handler passes every test and protects nothing; it was verified in a real
browser. A genuine "could not record the report" `5xx` needs real database connectivity broken mid-test; it
was confirmed by reading the catch-and-rethrow in `payment-events.service.ts`. §2.5's browser-visible criteria
rest on a timing window nothing structurally defends, so a polling test either flakes or asserts nothing; they
were watched in a browser, 9 of 9. §2.7 is a document. I would rather hand a reviewer 24 rows they can trust
and four that name where the proof actually is than 28 rows where four are decoration — because the moment
they find one decorated row, the other 24 stop counting.

**"You wrote these tests after the code. How do you know they can fail?"**
Every one of the 15 was made to fail on purpose. One assertion inverted, the file run, the failure read to
confirm it failed for the stated reason, the file reverted. `expected 1 to be 2` on idempotency convergence,
`expected 'duplicate' to be 'stored'` on redelivery, `expected 'delivered' to be 'payment_failed'` on
out-of-order arrival, `expected 5 to be less than 1` on the acknowledgement timing. No production source was
touched — that method was Slice 6's, where five race checks were validated by weakening the mechanism each
defends and restoring it byte-identical.

**"Did that exercise find anything?"**
Yes, and not in the shop. One inversion leaked a single `orders` row, because the inverted line sat before its
own cleanup registration, so the test's `finally` had nothing to delete. Found by direct SQL after the run and
removed. That is the exercise working: a test whose cleanup is registered after the assertion that can throw
poisons the next run's baseline, and it would otherwise have surfaced much later as an unexplained
`unclaimed = 49, expected 50` in some unrelated suite.

**"Why is the fifty-report scenario both a script and a test?"**
Because they run at different moments and catch different breakages. `pnpm race webhooks` is what a reviewer
runs deliberately — §2.6 names it as the reproducible check. The Vitest file is what runs on every `pnpm test`
without anyone remembering. And Slice 6's RED exercise is the concrete reason to keep both: `race:webhooks`
turned out not to guard the atomic key claim it named — it fires fifty reports at *one* order, and the guarded
transition admits one worker, so the key claim is called once — while a Vitest concurrency suite, which pays
many orders in parallel, caught the same weakening immediately.

**"What would you fix first if you had another hour?"**
Nothing in the tests. Phase 3 — the *unknown*-versus-*failed* distinction on supplier timeouts. It is the most
valuable trap in the assignment, it is where scenario 4 closes, and it is what makes the order row lock
load-bearing instead of defence in depth. After that, the root `README.md`, which `architecture.md` §7 already
calls the deliverable and which still does not exist.

---

## Source files

- `apps/api/test/acceptance/single-issuance-under-races.test.ts` — the feature-level suite, and its header's list of what is deliberately not in it
- `apps/api/test/concurrency/fifty-webhooks-one-order.test.ts` — §2.2 criterion 2 across four processes, as a permanent regression test
- `apps/api/test/unit/order-status-russian-labels.test.ts` — §2.8, and why it reads the label file as text rather than importing it
- `apps/api/package.json`, `package.json` — the test and race aliases a reviewer invokes
- `context/spec/002-single-issuance-under-races/functional-spec.md` — the 28 criteria
- `context/product/product-definition.md` §1.4 — the five adversarial scenarios, and the fact that the double-click is not one of them
- `docs/walkthrough/phase-2.md` — the four keystones, the honest scenario scoring, and "What is not finished"
- `docs/walkthrough/phases-1-and-2.md` — the nineteen questions the two phases jointly answer; Q17 and Q18 are this document's territory in more depth
- `docs/walkthrough/phase-2-slice-1-one-order-per-intent.md` §3 — why a genuine double-click is not scriptable
- `docs/walkthrough/phase-2-slice-5-one-worker-per-order.md` §3 — the lock as defence in depth, and the RED validation that came back green
- `docs/walkthrough/phase-2-slice-6-checks-a-reviewer-can-run.md` §4 — the five RED outcomes, and the null result that showed which invariant a check really guards

**On evidence:** what I verified myself while writing this is source inspection only — no servers started, no
tests run, no source file modified. I confirmed the three new files exist with 11, 1 and 3 tests
(`grep -c` on their `it(` declarations) against 13, 2 and 2 in the three pre-existing files, which is the
6 files / 32 tests figure; that each new file carries `@spec: 002-single-issuance-under-races` and a `@layer`,
with `@regression` on the concurrency and unit files and not on the acceptance suite, matching Phase 1's file;
the ports 4301 and 4501–4504 and `PROCESS_COUNT = 4`, `REPORT_COUNT = 50`; that `git status` shows no
modification anywhere under `apps/api/src` or `packages/`, only the two new test files, the new `test/unit/`
directory, `apps/api/package.json` and `tasks.md`; that `git diff` on `apps/api/package.json` is exactly
`test/acceptance/purchase-and-key-delivery.test.ts` → `test/acceptance/`, and that `git log -p` shows
`test:concurrency` making the same single-file → directory change earlier in Phase 2; and the eight criteria
groups of the functional spec summing to 28.

Everything else is reported by the testing agent in this slice and quoted rather than paraphrased: that all 32
tests pass, that the suite was run twice consecutively with identical results, the four inverted-assertion
failure messages, and the leaked `orders` row found by direct SQL and removed. The 9-of-9 browser observation
is Slice 4's; the RED outcomes for the five race checks and the 8/8 null result are Slice 6's; the
`20 distinct / 9 distinct` pool measurement behind the four-process rule is Phase 1's, recorded in
`architecture.md` §7.
