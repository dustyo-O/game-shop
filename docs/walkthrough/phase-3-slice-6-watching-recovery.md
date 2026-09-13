# Phase 3 · Slice 6 — Watching recovery happen

> The smallest slice in the phase: one predicate swapped for two, a second interval, a bounded window. The interest is entirely in the reasoning, and the reasoning is this — **for two phases, "settled" and "terminal" were the same question, and slice 5 quietly made them different ones.** A page that kept asking the old question would compile, ship, and pass every check in the repository, while the shopper it was built for sat looking at «Не удалось выдать ключ» as their key was delivered behind it.
>
> That is what "a criterion fails by definition, not by bug" means. Nothing is broken. Every test is green. The requirement is simply unmet, because no test asks the question the requirement is about.

---

## 1. What actually shipped

| # | Change | Where |
|---|---|---|
| 1 | The stop condition split three ways — stop on `isTerminalOrderStatus`, read `isRecoverableOrderStatus` every 5 s, read everything else every 1 s, and **snap back** to 1 s the moment a read shows the order in flight | `apps/web/src/pages/order/ui/order-page.ts` — `decideNextRead` |
| 2 | `Poll.setIntervalMs` — the interval is read once per run, at the moment the next wait is scheduled, and nowhere else | `apps/web/src/pages/order/model/poll.ts` |
| 3 | Assumption A9 — a five-minute watch window on a recoverable order, and a `stopped` notice when it runs out | `order-page.ts` |
| 4 | The doc comments that stated the old rule, amended — in contracts, the page, `entities/order`, and two in `apps/api` the task list had not named | `packages/contracts/src/order-status.ts`, `apps/web/src/entities/order/model/order.ts`, `apps/api/src/orders/orders.controller.ts`, `apps/api/src/payments/order-status-poll-drain.ts` |
| 5 | Verified in a real browser with the retry sent from a second context, and RED-validated against the old condition | `docs/screenshots/003-slice-6-*.png` |

No endpoint, no schema change, no new test file. Most of the diff in `order-page.ts` is comment; the code is one function and two constants.

---

## 2. Keystone — "settled" and "terminal" stopped being the same question

### The union was right, and it still is — for the server

`@game-shop/contracts` has always kept two sets apart. **Terminal** — `delivered`, `payment_failed` — is invariant I9: no transition leaves these states by any path, and the guarded `UPDATE … WHERE status = ANY($3)` draws its permitted source states from it. **Recoverable** — `out_of_stock`, and since slice 1 `delivery_failed` — is where a paid order rests when the shop could not obtain a key. And `settledOrderStatuses` is their union: the states in which an order stops moving *by itself*.

The union answers one question — *"will this move on its own?"* — and it is the right question for everything on the server. The payment-event processor asks it to decide whether an event still has work to do. The drain asks it. The race suite's `waitUntilSettled` asks it, and is right to: the test wants to know when the shop has finished, not when a person might intervene.

Through Phases 1 and 2 the order page asked it too, and that was also right, because nobody *could* move a recoverable order. "Will it move on its own?" and "can anything ever change what I am showing?" had the same answer, so one predicate served both. That derivation is what let `delivery_failed` join the recoverable set in slice 1 without touching the page at all — the contracts comment at the time said so, with some pride.

### Slice 5 gave the page a second question

Then the operator got a Retry button. `POST /api/admin/orders/:id/retry` moves `out_of_stock` and `delivery_failed` back to `delivering`, and from there the ladder runs exactly as it did for the original purchase. The page's stop condition, unchanged, now read: *stop polling on exactly the two states an operator can move*.

The implementer's line, which the rest of this document is built around:

> A page that stops on the union is correct by every existing test, because every test asks about the server. The only thing that fails is a shopper standing in front of it.

The union cannot answer *"can a person move it?"* — it was built to erase precisely that distinction. So the page stops asking it, and asks the two sets it is made of, separately:

| Class | Test | The page does |
|---|---|---|
| Terminal — `delivered`, `payment_failed` | `isTerminalOrderStatus` | **Stop.** Nothing can ever move it, so a further read can only return the same answer |
| Recoverable — `out_of_stock`, `delivery_failed` | `isRecoverableOrderStatus` | **Keep reading**, every 5 s — it is waiting on a person, not a worker |
| In flight — `created`, `paid`, `delivering` | neither | Every 1 s, as before |

The whole of it, comments stripped:

```ts
function decideNextRead(status: OrderStatus): PollDecision {
  if (isTerminalOrderStatus(status)) {
    return PollDecision.Stop;
  }
  if (!isRecoverableOrderStatus(status)) {
    recoverableSince = null;
    poll.setIntervalMs(inFlightIntervalMs);          // 1 s — and this branch is the snap-back
    return PollDecision.Continue;
  }
  const now = performance.now();
  recoverableSince ??= now;
  if (now - recoverableSince >= recoverableWatchWindowMs) {
    showStoppedWatching();                            // A9
    return PollDecision.Stop;
  }
  poll.setIntervalMs(recoverableIntervalMs);          // 5 s
  return PollDecision.Continue;
}
```

The order of the questions is the point. Terminal first, because it is the only answer that ends the loop unconditionally. Then "not recoverable" rather than "in flight", so that an unclassified status falls to the fast branch — the same default `isSettledOrderStatus` had — and the contracts package refuses to compile with an unclassified status anyway, so none reaches here.

### The snap-back

Once a retry lands, the order is `delivering` and the ladder runs `delivering → delivered` in the same 25–65 ms the original issuance took. A page still on the 5 s beat would hold «Выдаём ключ» for up to five seconds after the key existed — or, far more likely, never see that frame at all and jump from «Не удалось выдать ключ» straight to «Ключ выдан». Spec 002 §2.5 spent a slice making those stages observable; losing them again here would be a regression caused by a change that never mentions §2.5. So the in-flight branch does not merely keep the interval, it *resets* it: the moment a read shows the order moving, the next wait is a second, and the recovery is watched at the beat the first attempt was.

There is a case where this matters more than the numbers above suggest. A retry against a supplier that answers at once holds `delivering` for tens of milliseconds. A retry that finds the supplier hung holds it for the full probe budget — seconds, not milliseconds — and that is Phase 3's own scenario. At a 5 s beat the page might show one frame of the recovery, or none; at 1 s it shows the order being processed for as long as it genuinely is.

### This is not the failure the tripwire warns about

The contracts package has a compile-time assertion that every status is classified, and its comment names the failure it fears: an unclassified status silently reading as in-flight, and the page polling a *dead* order once a second forever. That is not what happens here, and the difference is worth stating because "keep polling a settled order" sounds like exactly that.

Here the status *is* classified. The reading is deliberate, slower, bounded, and waiting on a real event a real person can cause. And it is cheap in a way Phase 2 measured rather than assumed: a read of a settled order costs **0 extra round trips and no index probe**, because the drain that a read can trigger is gated inside the database's own answer, and a settled order never qualifies. Five reads a minute of a row lookup, per tab left open, is the whole cost.

### A9 — and the one place the copy doctrine flips

The watch is bounded at five minutes from the first read that found the order recoverable, reset whenever a read finds it moving again. When the window runs out, the order stays on screen and a line under it says the page has stopped keeping it current — and asks the shopper to refresh.

Every other message on this page follows one rule: **never tell a shopper to reload a page that reloads itself.** The `error` and `offline` notices both end in «страница обновится сама». The `stopped` notice is the one exception, and it is the correct one: once the page has genuinely stopped, «обновится сама» would be a lie, and the honest instruction is the one the rule otherwise forbids. Reported by the verifier: 61 reads at roughly 5 s, then the stopped notice at 300 s.

### What was not done, and why

- **Keep the 1 s beat on recoverable orders.** Five times the reads for a wait measured in minutes rather than milliseconds, and without A9 it is unbounded — every stuck order's tab polling until the browser is closed.
- **Stop, and tell the shopper to come back later.** This fails §2.6's third criterion by construction — *"their key appears without them taking any action"* — and it puts the copy in the position of promising an update the page will not deliver.
- **A `keep_polling` or `settled` flag on the wire.** `orders.types.ts` rejected a wire flag in Phase 2 as a second copy of the classification with somewhere to drift to. This slice adds a stronger reason: the server's settle rule is precisely the question the page must *not* ask. A flag derived from `settledOrderStatuses` would have encoded the bug.
- **Push — SSE or a WebSocket.** Heavier than anything this storefront has, for a tab that may sit for minutes waiting on a person. A read every five seconds costs less than a held connection, and needs nothing new on the server.

---

## 3. How a criterion fails by definition while every test stays green

R10 named it during planning: *"the poll keeps `isSettledOrderStatus`. Compiles, ships, all checks green, §2.6's third criterion silently unmet."* The RED reproduced it exactly.

With the old stop condition restored, the verifier left a shopper's page open on a `delivery_failed` order and sent the retry from a shell. The page made **11 reads ending at `t=9561 ms`** — the first read that returned `delivery_failed` — and **no further reads, ever.** The retry landed; the database showed the order `delivered` with a code; the shopper's tab sat on «Не удалось выдать ключ» with nothing to tell it otherwise. The source was then restored byte-identical, and the rebuild reproduced the original asset hash.

**Why no test failed.** Look at what the existing checks ask. `key-claim-race.test.ts` polls with `waitUntilSettled`, which uses `isSettledOrderStatus` — correctly, because the suite wants to know when the *shop* has finished with an order. The unit tests exhaust the ladder's decision table and scan the Russian labels. Slice 5's races assert attempt rows, deliveries and claimed keys. Every one of them is a question about the server, and the server was never wrong. §2.6's third criterion is a claim about a browser tab somebody left open, and no test in the repository has a tab.

That is what "by definition" means here. A bug is code doing something other than what it was written to do; every test would catch some of that. This is code doing exactly what it was written to do, two phases ago, under a definition that a later slice changed underneath it. Nothing in the code is wrong. The question it asks has become the wrong question.

**Which is why the check had to be a browser check, from a second context.** R10 says so and the reason is the same one slice 5 gave for not testing the disabled button with a double-click: the thing under test is that the page *discovers* the change by reading, with nobody touching it. A retry sent from the shopper's own tab, or a test that reads the order through the API after retrying, exercises nothing this slice changed.

I reproduced the shape of both runs at the loop level, without a server, so the document can show it rather than describe it: the real `createPoll` from `poll.ts`, the real predicates from the built contracts package, `decideNextRead` restated in eight lines, intervals scaled 100× down (5 s → 50 ms, 1 s → 10 ms), and a scripted sequence of three `delivery_failed` reads, one `delivering`, one `delivered`:

```
new rule — stop on terminal:
read status           gap(ms) t(ms)  next wait
1    delivery_failed  0       0      50 (slow)
2    delivery_failed  51      51     50 (slow)
3    delivery_failed  51      103    50 (slow)
4    delivering       51      154    10 (snap-back)
5    delivered        11      165    STOP
reads after 'delivered': 0

old rule — stop on settled:
read status           gap(ms) t(ms)  next wait
1    delivery_failed  0       0      50 (slow)
(no further reads; the loop stopped itself)
```

Read 5 arrives 11 ms after read 4 — the wait that follows the `delivering` read is already the short one, which is the guarantee `setIntervalMs` makes: called from inside a run, it sets the wait that follows that very run. Under the old rule the sequence ends at read 1. Same loop, same predicates, same script; the only difference is which set the first read is checked against.

---

## 4. The evidence

The implementer's own trace, wall clock, shopper's tab untouched throughout:

| Wall clock | What happened |
|---|---|
| 11:06:18 → 11:06:58 | 9 reads, gaps ~5 s, every one `delivery_failed` |
| 11:06:58.893 | Retry sent from the shell |
| 11:07:03.693 | Read → «Выдаём ключ» painted |
| 11:07:04.706 | Next read, **gap 1013 ms** — the snap-back |
| 11:07:05.722 | Read → «Ключ выдан» with the code, 606 ms after the retry answered |

The independent verification then did it the way R10 asks: retry pressed from the admin page in a **second tab**, the shopper's tab never touched, and the shopper's tab repainted to `delivered` on its own next poll. Recoverable orders kept reading at 5019–5041 ms gaps; a terminal order issued 0 reads over 36 s of watching. The two screenshots under `docs/screenshots/` are the end states: `003-slice-6-shopper-sees-retry-land.png` shows «Ключ выдан» with the key on screen; `003-slice-6-watch-window-stopped.png` shows «Не удалось выдать ключ», the §2.3 explanation under it, and below that the stopped notice.

**The honest finding on the snap-back.** The intermediate «Выдаём ключ» frame is **probabilistic under default timing.** Two of the verifier's attempts landed the 5 s read just outside the real `delivering` window and the page went straight from `delivery_failed` to `delivered`; to *observe* the frame rather than infer it, the verifier widened the window with a legitimate slow-supplier setting. This is the same shape as Phase 2's finding about the visible stages: the intermediate state is a well-timed observation, not a guarantee, and the snap-back cannot make a 25–65 ms window visible on a 5 s beat — it can only make sure that, once the page has seen the order moving, it watches at the beat that gives it the best chance. The load-bearing guarantee — the key appears with no interaction — held every time, regardless of which frames were seen on the way.

---

## 5. Also worth including

**A stale tripwire is worse than none.** The slice amended the comments that stated the old rule — the four in contracts and the page the task list names, plus two in `apps/api` it did not: `orders.controller.ts`'s description of the endpoint the page polls, and `order-status-poll-drain.ts`'s note on what the page stops on. A comment saying the poll stops on settled, sitting next to code that does not, is the thing the next reader believes, and the whole argument of §2 is that the old rule *looks* right.

**The sweep missed one, and this document does not fix it.** `apps/api/src/orders/orders.types.ts`, in the `OrderView` header under "WHAT DECIDES WHETHER THE PAGE KEEPS POLLING", still reads *"the page polls this endpoint once a second while the order is in flight and stops when it settles … `isSettledOrderStatus` / `settledOrderStatuses`"*. That is the exact class of comment the previous paragraph is about, on the wire type the page reads. Found by grepping for the two identifiers while writing this; left as found, because this task is prose only. It should go in the same commit as the rest of the slice.

**`setIntervalMs` is deliberately weak.** It cannot start a run and cannot touch a wait that is already counting down; the loop reads the interval in exactly one place, as it schedules the wait after a run. That is what keeps the no-overlap guarantee `poll.ts` was built on — one read in flight, answers in the order they were asked — intact under a change the loop was not originally designed for. A page that wants a read *now* has `refreshNow`; keeping the two apart is the design.

**The notice carries its kind.** `data-order-notice` is now `"offline"` or `"stopped"`, so a check can tell the two notices apart without matching Russian text.

---

## 6. Where this sits in the assignment

This slice settles **functional spec §2.6**, all three criteria:

| Criterion | Settled by |
|---|---|
| A supplier that has not answered looks like processing, not failure | the in-flight branch — `delivering` reads every second, and shows «Выдаём ключ» for as long as it lasts |
| A genuine failure changes the page to §2.3's explanation without a reload | the in-flight beat carries the order into `delivery_failed`, where the page paints the explanation and slows down rather than stopping |
| An operator's successful retry makes the key appear with no action from the shopper | the recoverable branch — 5 s reads, the snap-back, and the terminal stop on `delivered` |

Against `product-definition.md` §1.4's five adversarial scenarios it settles **none**:

| # | Scenario | Status after this slice |
|---|---|---|
| 1 | 50 parallel `paid` webhooks → one issuance fact, one key | Phases 1 and 2. Untouched. |
| 2 | A repeated webhook with the same `event_id` changes nothing | Phase 1. Untouched. |
| 3 | A webhook before its order, or out of order | Phase 2 slice 3. Untouched. |
| 4 | Empty pool → recoverable → after restock, exactly one key | Settled by slice 5. **This slice is its shopper-facing half** — the retry was already correct; now the person it was for can see it land. |
| 5 | A promo code with limit N under parallel requests | Phase 5. Not started. |

The honest summary: nothing about the shop's guarantees changed here. What changed is that one of them became visible to the person it was made for.

---

## Interview questions this answers

**"Settled and terminal — aren't those the same thing?"**
They were, for two phases, and that is the whole story of this slice. Terminal is I9: `delivered` and `payment_failed`, which no transition leaves by any path. Settled is terminal plus the recoverable pair, `out_of_stock` and `delivery_failed` — the states an order stops moving in *by itself*. Those are different definitions, and the contracts package always kept them apart, but until slice 5 they gave the same answer to the page's only question, "can anything change what I'm showing?", because nobody could move a recoverable order. The operator's Retry made "will it move on its own?" and "can a person move it?" different questions. The server still asks the first, correctly. The page had to start asking the second.

**"So what was the actual bug?"**
There wasn't one, which is the interesting part. The page stopped polling on `isSettledOrderStatus`. When `delivery_failed` joined the recoverable set in slice 1, that predicate came to mean "stop on exactly the two states an operator can move" — so a shopper watching a stuck order would never see the operator's retry arrive. The code did precisely what it was written to do, under a definition another slice changed underneath it. It compiled, shipped, and kept every check green, and the requirement was unmet. Technical-considerations §9.1 calls it a criterion that fails by definition rather than by bug, and I think that is the exact phrase.

**"How can every test pass while a requirement is unmet? Doesn't that mean the tests are bad?"**
It means the tests ask about the server, and the server was never wrong. The race suite's `waitUntilSettled` uses `isSettledOrderStatus` — correctly, because it wants to know when the shop is done. The ladder tests exhaust a decision table. Slice 5's races assert attempt rows, deliveries and claimed keys. §2.6's third criterion is a claim about a browser tab someone left open, and no test in the repository has a tab. That is not a gap in those tests; it is a different kind of claim. The check that covers it has to be a browser check with the retry sent from a second context, and R10 required that from the start.

**"What did the RED look like?"**
With the old condition restored: 11 reads ending at 9561 ms — the first read that returned `delivery_failed` — and no further reads, ever. The retry landed, the database showed `delivered` with a code, and the shopper's tab sat on «Не удалось выдать ключ». Then the source restored byte-identical, and the rebuild reproduced the original asset hash. I also reproduced the shape at the loop level with the real `createPoll` and the real predicates on a scripted status sequence: under the new rule five reads and a stop, with the wait after the `delivering` read already the short one; under the old rule, one read and silence.

**"Why keep polling a settled order at all? Isn't that the 'polls a dead order forever' failure your own contracts comment warns about?"**
That comment fears an *unclassified* status defaulting to in-flight — a page reading once a second, forever, for an order nothing can ever change. This is classified, deliberate, slower, bounded at five minutes, and waiting on a real event a real person can cause. And it is cheap in a way Phase 2 measured: a read of a settled order costs no extra round trips and no index probe, because the drain a read can trigger is gated inside the database's own answer. Five row lookups a minute per open tab.

**"Why five seconds, and why snap back to one?"**
Five seconds because the page is waiting on a person, and people take minutes. The snap-back is not tidiness. Once the retry lands, the ladder runs `delivering → delivered` in the same 25–65 ms the original issuance took, and at a 5 s beat that frame is invisible: the page jumps from «Не удалось выдать ключ» straight to «Ключ выдан», which is a regression of spec 002 §2.5 caused by a change that never mentions it. So the moment a read shows the order in flight, the next wait is a second. It matters most when the retry is slow — a hung supplier and a full probe budget, which is this phase's own scenario — because then the page shows the order being processed for as long as it actually is.

**"Did you actually see the intermediate frame?"**
Sometimes, and I would rather say that than claim it. Two of the verifier's runs landed the read just outside the `delivering` window and went straight to `delivered`; observing the frame took a legitimately slowed supplier. The snap-back cannot make a 25 ms window visible on a 5 s beat — it makes sure that once the page has seen movement, it watches at the beat that gives it the best chance. The guarantee that held every time is the one the criterion is about: the key appeared with nobody touching the page.

**"Why not have the server tell the page whether to keep polling?"**
A wire flag was rejected in Phase 2 as a second copy of the classification with somewhere to drift to. This slice adds the stronger reason: the server's settle rule is exactly the question the page must not ask. A `keep_polling` derived from `settledOrderStatuses` would have encoded the bug, and shipped it to a place harder to see.

**"The page tells the shopper to refresh after five minutes. Doesn't that contradict your own copy rule?"**
The rule is never to tell a shopper to reload a page that reloads itself. The `stopped` notice is shown only after the page has stopped reloading itself, at which point «страница обновится сама» would be the lie. The rule flips there because the fact it rests on has flipped. Reported measurement: 61 reads at about 5 s, then the notice at 300 s.

**"What does this slice settle in the assignment, honestly?"**
Functional spec §2.6, all three criteria. None of the five adversarial scenarios — scenario 4 was settled by slice 5's retry, which was correct before this slice and is not more correct after it. What this slice does is make that retry visible to the shopper it was for. Nothing about the shop's guarantees changed; one of them stopped being invisible.

---

## Source files

- `apps/web/src/pages/order/ui/order-page.ts` — `decideNextRead`, the three-way split, the snap-back, A9, and the header explaining why "settled" is the trap
- `apps/web/src/pages/order/model/poll.ts` — `setIntervalMs`, why it is read in one place, and why that keeps the no-overlap guarantee
- `packages/contracts/src/order-status.ts` — `terminalOrderStatuses`, `recoverableOrderStatuses`, `settledOrderStatuses`, the amended comments naming which caller asks which question, and the compile-time classification assertion
- `apps/web/src/entities/order/model/order.ts` — the `Delivered` member's comment, now pointing at `isTerminalOrderStatus`
- `apps/api/src/orders/orders.controller.ts` — the endpoint the page polls, with its description of the poll corrected
- `apps/api/src/payments/order-status-poll-drain.ts` — the drain's note on what the page stops on, corrected
- `apps/api/src/orders/orders.types.ts` — the `OrderView` header that still states the old rule (§5)
- `apps/api/test/concurrency/key-claim-race.test.ts` — `waitUntilSettled`, the server's question asked correctly, and why that is why every test stayed green
- `context/spec/003-failure-and-recovery/technical-considerations.md` §9.1 (the split, the tripwire distinction, the snap-back, A9), §11 (R10), Assumptions (A9)
- `context/spec/003-failure-and-recovery/functional-spec.md` §2.6, §2.3
- `context/spec/002-single-issuance-under-races/functional-spec.md` §2.5 — the visible stages the snap-back protects
- `docs/walkthrough/phase-3-slice-5-pressing-retry-twice.md` — the retry this slice makes visible, and the disabled-button argument the second-context check mirrors

**On evidence:** the following were run fresh while writing this document, against the tree as it stands, with no server started and no source file modified. `pnpm -r run typecheck` across all four workspace projects — `packages/contracts`, `packages/db`, `apps/api`, `apps/web` — all Done. `vitest run test/unit/` in `apps/api`: **2 files, 26 tests passed** in 692 ms. The classification table is my own, from the built contracts package over all seven statuses: `delivered` and `payment_failed` terminal and settled; `out_of_stock` and `delivery_failed` recoverable and settled; `created`, `paid`, `delivering` in flight; no status in two classes, none in none. The loop-level traces in §3 are my own — the real `createPoll` under `node --experimental-strip-types` with a stubbed `window`, the real predicates, and `decideNextRead` restated without the A9 window — giving gaps of 51 / 51 / 51 / 11 ms and zero reads after `delivered` under the new rule, and a single read under the old. I read `decideNextRead`, `setIntervalMs` and the single site that consults the interval directly rather than taking the comments' word for them, grepped every remaining mention of `isSettledOrderStatus` and `settledOrderStatuses` outside the contracts file, and opened both slice-6 screenshots to confirm what they show. The scratch scripts live in the session scratchpad, not the repository.

Everything else is reported by other agents in this slice and is **not** re-verified here: the browser runs and every number quoted from them — the 11 reads ending at `t=9561 ms` under the old condition and the byte-identical restore with the reproduced asset hash; the wall-clock trace in §4 including the 1013 ms snap-back gap and the 606 ms; the second-tab verification, the 5019–5041 ms recoverable cadence and the 0 reads over 36 s on a terminal order; the 61 reads and the stopped notice at 300 s; the two attempts that missed the intermediate frame and the slow-supplier setting used to observe it; the 25–65 ms issuance timing from slice 5; and Phase 2's measurement that a settled order's read costs 0 extra round trips and no index probe.
