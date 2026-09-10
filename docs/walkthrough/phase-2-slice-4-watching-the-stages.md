# Phase 2 · Slice 4 — The shopper watches the stages

> Settles functional spec 002 §2.5, and restores spec 001 §2.4's second criterion to the wording it was written with, lost during verification, and had to spend a phase without.
>
> The stages did not get longer. **The shop started answering earlier.** This slice is the one place a reviewer can *see* Slice 2's concurrency decision without reading a line of code.

---

## 1. The obvious explanation is wrong, and the measurement caught it before the prose did

The story everyone reaches for — including the one written into this slice's own task list:

> Restores the promise spec 001 §2.4 had to walk back. The mechanism was always correct; the stages were simply too brief to see.

Read that as *"and now they are long enough"* and you have the natural account: Phase 1 applied the payment inside the webhook request, so `paid` and `delivering` were steps inside one function call rather than states anyone could observe; Phase 2 moved processing off the response path; therefore the states persist; therefore they last longer; therefore you can see them.

The first three clauses are true. **The fourth is false**, and the verification measured it false before this document could be written.

A direct API probe — create, pay, then poll `GET /api/orders/:id` in a tight loop with no browser involved:

| Measured | Phase 1 | Phase 2, after this slice |
|---|---|---|
| Webhook `200` → `delivered` | ~19–60 ms | **25–65 ms**, across 5 samples |

Nothing opened. If anything the window is a hair wider, and a hair is not what turns an invisible state into one that nine of nine shoppers see.

**What actually changed is when the shop answers the payment service.**

- **Phase 1:** the webhook did the work and *then* answered. A page that refreshed itself on hearing that answer was already too late — by the time the `200` existed, the order was `delivered`. Every refresh, however prompt, saw a finished order.
- **Phase 2:** the webhook records the event, answers `200` immediately, and completes the order on a scheduled continuation (`docs/walkthrough/phase-2-slice-2-answer-then-work.md` §1 — *72 ms to answer, with the work still in flight*). The same refresh now fires at the **start** of the work and lands inside the 25–65 ms window.

The state was always there. Phase 1 handed out the only invitation to look at it *after* the party. The stage is visible now because the acknowledgement moved to the front — which is exactly the concurrency change Slice 2 made for reasons that had nothing to do with the shopper's screen.

---

## 2. The single line, and the timeline it changes

```ts
const payment: PaymentControls = createPaymentControls({
  orderId,
  onOrderMayHaveChanged: () => {
    poll.refreshNow();
  },
});
```

`refreshNow` runs the polled read now instead of waiting out the current second. It fires when the payment simulator's request resolves — **the moment the webhook answered**, about 10 ms in.

Put the two timelines side by side. The right-hand column is not hypothetical; it is what the RED runs in §4 actually did.

| t | With the callback | With the callback removed |
|---|---|---|
| 0 ms | pay pressed, request to the simulator | same |
| ~10 ms | simulator resolves — the webhook has answered `200`. **`refreshNow()` reads the order** and paints «Оплачен, готовим ключ» or «Выдаём ключ» | simulator resolves. Nothing reads. Screen still says «Ожидает оплаты» |
| 25–65 ms | the shop finishes `paid → delivering → delivered` | same |
| ~1000 ms | next scheduled read → «Ключ выдан» | next scheduled read → «Ключ выдан» (measured at ~990 ms) |

**The two columns differ by one HTTP GET, fired about 990 ms before a read that was going to happen anyway.** That is the entire distance between a shop that appears to sit still for a second and then produce a key, and a shop the shopper can watch working.

Two details inside that table are worth naming because they are easy to get backwards:

- **The dwell time is the poll's period, not the state's lifetime.** The intermediate label stays on screen for 1000–1060 ms. The state it names lasted tens of milliseconds. Nothing reads the order in between, so nothing contradicts it. The second of legibility is bought by the interval, not by the shop.
- **The loop was already running.** A `created` order is in flight and this page polls every order that is. `refreshNow` starts nothing and stops nothing; `poll.ts` chains each wait off the *completion* of the previous run, so there is never a second read in flight and the refresh simply replaces the front of the queue.

---

## 3. The page shows a state that has usually already passed — and the honest move is to say so

Nine real purchases in Chromium against `localhost:5173`, each watching `data-status` and the rendered Russian label through a `MutationObserver`:

```
intermediate state observed:            9 of 9
  «Оплачен, готовим ключ»                4
  «Выдаём ключ»                          5
held on screen:                         ~1000–1060 ms
performance.getEntriesByType('navigation').length:  1   (every run)
```

**The 4/5 split is the most convincing number on the page.** A page animating a scripted sequence would show the same label every time. That the label varies is the fingerprint of a genuine race being sampled: sometimes the read lands before `paid → delivering`, sometimes after. Nobody chose which; the sequence is not a story the page tells, it is a photograph of wherever the order happened to be.

And `navigation.length === 1` is the criterion's actual claim — *without the shopper reloading it*. One navigation entry means one page load. Everything after it was the page moving on its own.

So, stated plainly and without hedging: **the page renders a state that was true when it was read and has usually already passed by the time a human eye reaches it.** That is worth saying out loud rather than leaving for an interviewer to work out, and it is not a bug. The page is not claiming *"your order is being processed right now"*; it is reporting where the order was when the shop was last asked. The shopper's question is *"is anything happening, or has this stalled?"* — and the answer the page gives to that question is true. Nothing shown was ever invented, and every state shown was read back from the server that owns it.

Two ways of making the stage appear more reliably were available and both were rejected:

**Rejected — slow the shop down.** Spec 001's Slice 5 verification confirmed the mechanism by raising the supplier stub's latency to 1500 ms, which made the intermediate state appear and the page follow it. That is a fine *diagnostic* and a dishonest *fix*: it spends the shopper's time to buy a progress indicator. The shop would be worse and would look better, which is the wrong direction on both axes.

**Rejected — fake the stage in the page.** Paint «Оплачен, готовим ключ» the instant the button is pressed, without asking the server. Most storefronts do exactly this, and it would produce the stage 100% of the time instead of 9 times in 9. Two costs, the first concrete and the second structural:

1. **Both payment controls resolve.** The failing control also completes its request. An optimistic paint would show «Оплачен, готовим ключ» for an order that has just moved to `payment_failed` — a page telling a shopper their money was taken when it was not, in the exact second when getting that wrong matters most.
2. **It breaks the one claim the architecture rests on.** The server decides what state an order is in and the page reports it; that is the answer to *"why does the server decide a key was delivered, not the page?"*, and it is why `data-status` carries the raw lifecycle value straight off the API response. Putting a client-invented state into the shopper-facing view would break that claim in precisely the place a reviewer looks first.

The design that survives is the one where the page is never the author of anything it shows. The cost of that discipline is that visibility depends on timing. **The cost is worth naming; it is not worth paying to remove.**

---

## 4. A claim about the UI, proven the way the concurrency claims are proven

Spec 002 §2.6 asks that *"given a check has passed, when the mechanism it defends is deliberately weakened, then that check reports a failure — so a passing check is evidence rather than decoration."* That requirement was written for the adversarial race scripts. It was applied here, to a claim about a screen.

The callback in §2 was temporarily neutered, and the same nine-purchase harness re-run:

```
callback removed:   3 runs — 3 collapses
                    «Ожидает оплаты» → «Ключ выдан» at ~990 ms
                    intermediate state: 0 of 3

file restored:      byte-identical, sha256 d9c35fc8…
                    intermediate state: 3 of 3
```

Three collapses straight from awaiting payment to delivered, at the tick the schedule was always going to fire — **which is Phase 1's behaviour reproduced exactly**, in Phase 2's codebase, by removing one line. That is the strongest form the argument can take: the thing that forced spec 001 §2.4 to be reworded is still reachable, and one line is what holds it shut.

The poll's other half was measured in the same runs:

```
while created:      reads at 942 ms, 1957 ms, 2973 ms — once a second, continuing
after settling:     0 reads in 4 seconds
```

The loop stops exactly on the terminal state, and *what counts as terminal is not decided in the page*. `isSettledOrderStatus` comes from `packages/contracts/src/order-status.ts`, which classifies every status and fails to compile when a new one is left out. A page holding its own copy of «delivered, payment_failed, out_of_stock» is the copy nobody updates when Phase 3 adds `delivery_failed` — and the failure mode is a page reading a dead order once a second forever, which nothing would ever page anyone about.

**Why a RED run beats a passing check here specifically.** A green check on a UI claim tells you the behaviour occurred once. It cannot distinguish *"this happened because the mechanism works"* from *"this happened and the mechanism is irrelevant"* — and for a claim that rests on a race landing inside a few tens of milliseconds, that distinction is the whole question. The neutered run answers it. It is the same instinct as Phase 1 leaving nineteen contested payment events deliberately pending rather than settling them dishonestly: **a claim is only worth as much as the thing that would falsify it.**

---

## 5. The right amount of code for this slice was zero lines, and the change that was made was a comment

The task list said so in advance — *"the poll, the change detection and the Russian labels for every status already exist; this task is expected to be small, and adding machinery would be a sign of misreading it."* It was. The poll, the diffing render, the label map and the `refreshNow` hook were all built in Phase 1 for their own reasons. Slice 2 moved the acknowledgement. Between them the criterion became true, and the correct engineering response was to verify it and touch nothing.

One thing was changed, and it was a comment, and it was a genuine defect. The old text above the callback read:

> `refreshNow` only spends the remainder of the current second … **If the callback were removed tomorrow the page would still get there on the next tick.**

The RED run disproves that sentence. And the sentence sat directly above the single line that makes §2.5 true, telling the next developer that deleting it costs nothing — a comment that had turned into an invitation to reintroduce the exact regression the phase existed to fix. **A comment that misstates why a line exists is not documentation debt; it is a trap with a timer on it.** The replacement records the 25–65 ms measurement, the ~10 ms firing point, and the RED result, so the next reader has the falsification rather than the assurance.

One residual is owed rather than fixed, and is recorded here so it is not discovered by someone else. `apps/web/src/features/simulate-payment/ui/payment-controls.ts` documents the same option from the feature's side, and still carries the older judgement:

> Remove it tomorrow and the page still gets there on the next tick, **which is the property that makes it a courtesy rather than a mechanism.**

Read narrowly the first clause is true — the page does still reach `delivered`. *"A courtesy rather than a mechanism"* is the disproven part, and it sits in the file a developer reads when deciding what the option is *for*. This slice's change was scoped to the page; the feature's public-API doc should get the same correction.

---

## 6. Walking a promise back with a date, and forward again with a second date

This is the half of the slice that is about specification rather than code, and it is the better interview answer.

**The original criterion**, as spec 001 §2.4 was written:

> Given the shopper stays on the order page after paying successfully, when the order moves from awaiting payment through being processed to delivered, then the page shows each change without the shopper reloading it.

**What it became**, during spec 001's Slice 5 verification, when the stages proved unobservable:

> Given the shopper stays on the order page after paying successfully, when the order reaches a settled state, then the page shows the change without the shopper reloading it.
> _Note: the intermediate states between paying and delivery are real but, in this version, usually last under a tenth of a second, so a shopper will rarely see them._

That weakening carries a dated Change Log entry (2026-09-07) which says why, admits what was lost, and records that the mechanism was separately confirmed by artificially slowing the supplier to 1500 ms — so the criterion was narrowed to what a shopper could actually check, without pretending the underlying behaviour was absent.

Spec 002 §2.5 exists to restore it, and says so in its own preamble. This slice put the original wording back, deleted the caveat note, and added a second dated entry (2026-09-08) recording the nine browser runs, the 25–65 ms measurement, the fact that **the stages did not become longer**, and the fragility that comes with the restored promise.

### The detail worth telling: the original wording was not in git

`d6b9943` is the repository's root commit and it already contains the reworded text. The rewording predates the first commit; there is no revision to diff against. The original was recovered from a **verbatim quotation preserved in a sibling document** — `context/spec/001-purchase-and-key-delivery/technical-considerations.md:111`, written against the pre-reword spec:

> This satisfies "the page shows each change without the shopper reloading it" without introducing a socket, which the architecture calls decoration at this scale.

That is the `then` clause, in quotation marks, intact. The `when` clause is a faithful reconstruction and is labelled as such rather than passed off as recovered. Getting a sentence back out of a document that quoted it is a small thing, but the discipline it depends on is not: **a spec that is quoted elsewhere leaves fingerprints, and cross-references are load-bearing history.**

### The argument

The alternative most projects take is to leave the optimistic wording alone. Nobody is checking, the criterion is aspirational, the behaviour is *nearly* there, and the phase that fixes it is already planned. It costs nothing today.

It costs something specific later. A criterion that is checked while being false teaches the next reader that the checkboxes do not mean anything, and that lesson does not stay local — it discredits the twenty-three criteria that *were* honestly verified. **A specification's only asset is that its claims can be believed one at a time.** One decorative green box spends that asset for everything around it.

Walking the criterion back with a date and a reason, and forward again with a second date and a reason, produces a record that is *more* convincing than a criterion that had been quietly green throughout — because the file now demonstrates, in its own history, that somebody checks. It is the same instinct as Phase 1 refusing to settle nineteen contested payment events it could not honestly account for, and the same instinct as the RED requirement in §4.

The sentence to remember: **a spec that promises what the software does not do is worse than one that admits a gap, because the first kind teaches people to stop reading it.**

---

## 7. Where this sits in the assignment

Be precise about the numbering, because it is easy to inflate. `context/product/product-definition.md` §1.4 lists five adversarial scenarios, and **the shopper-visible order page is not one of them.** This slice settles functional spec 002 §2.5 and serves two of the assignment's Этап 1 requirements: the storefront's order status page, and a working `created → paid → delivering → delivered` lifecycle a reviewer can watch.

Its real weight is different from either, and this is the sentence to lead with:

**The order page is where a reviewer can see the asynchronous acknowledgement without reading any code.** Slice 2's decision — record the event, answer `200`, do the work afterwards — is invisible from outside. It shows up as a latency figure in a log, a scheduler module, and a `try/catch` that stopped existing. The screenshot in `docs/screenshots/002-single-issuance-under-races-intermediate-state.png` is that decision rendered: «Выдаём ключ», no key row yet, on a page nobody reloaded. **A correctness change that only a maintainer could verify became one a shopper can observe.** That is the connection between the two halves of this phase, and it is what makes this slice worth more than its diff.

**What remains, honestly:**

- **§2.5 holds on a timing window, and the window is not defended by anything structural.** The refresh has to land inside a few tens of milliseconds. A slower webhook acknowledgement pushes it late; a faster supplier closes it early; a production supplier over a real network changes both. The two fixes that would make it a guarantee rather than a likelihood are (a) pushing every transition to the page over a socket or SSE, which `product-definition.md` §3.2 puts out of scope as decoration at this scale, and (b) recording the transitions server-side and letting the page read the *history* rather than sampling the *current state*, which needs a table this phase has no other use for. Both are more machinery than the criterion is worth today. The fragility is recorded rather than fixed, and recorded is not the same as unnoticed.
- **`out_of_stock` was not exercised in a browser.** Reaching it needs the 50-key pool exhausted, which would have wrecked the baseline every other check in this phase runs against. It was verified by an enum cross-check only: `orderStatusLabel`'s `Readonly<Record<OrderStatus, string>>` is total, so a status without a Russian label stops the build. That is real evidence that the label exists and weaker evidence than the five states that were actually watched rendering. Say the difference out loud rather than letting the two blur.
- **The feature-side comment in `payment-controls.ts`** still carries the claim §4 disproved. See §5.

---

## Interview questions this answers

**"So you made payment processing asynchronous, and that made the stages last long enough to see?"**
No — and the measurement is the interesting part. The run from the webhook's `200` to `delivered` takes 25–65 ms now; it took roughly 19–60 ms before. The stages did not get longer by any amount that matters. What moved is **when the shop answers the payment service**. Phase 1 did the work and answered afterwards, so a page refreshing itself on hearing the answer was already too late — the order was delivered before the `200` existed. Now the shop answers first and works afterwards, so the same refresh fires at the start of the work and lands inside the window. Same duration, different vantage point.

**"The page is showing a state that has already passed by the time I read it. Isn't that lying to the shopper?"**
It is showing a state that was true when it was read, and I would rather say that plainly than have it discovered. The page never claims *"this is true right now"* — it reports where the order was when the shop was last asked, and everything it shows was read back from the server that owns the state. The shopper's actual question is "is something happening, or has this stalled?", and to that question the answer is truthfully yes. What would be a lie is the version most storefronts ship: painting «Оплачен» the moment the button is pressed. That one shows a paid order for a payment that just failed, because the failing control resolves too.

**"That callback looks like an optimisation. How do you know it's load-bearing?"**
Because we removed it and watched what happened. Three runs with it neutered: three collapses straight from «Ожидает оплаты» to «Ключ выдан» at about 990 ms, no intermediate state in any of them — Phase 1's behaviour reproduced exactly, in Phase 2's codebase, by deleting one line. Restore the file byte-identical and the intermediate state comes back in three of three. That is the same RED discipline spec 002 §2.6 demands of the race scripts, applied to a claim about a screen — and it is the reason the comment above that line now records the falsification instead of the old assurance that removing it "would still get there on the next tick".

**"The whole slice is a comment change. What did you actually do?"**
Verified a criterion, and corrected a comment that had become a trap. The poll, the diffing render and the Russian label map were built in Phase 1; Slice 2 moved the acknowledgement; between them the criterion became true and the honest engineering response was to prove it and add nothing. The task list said as much up front — *"adding machinery would be a sign of misreading it"*. The comment mattered because it sat directly above the one line §2.5 depends on and told the next developer that deleting it cost nothing. The RED run is what that costs.

**"Your spec has a criterion that was weakened and then restored. Doesn't that look like moving the goalposts?"**
The opposite, and the dates are why. It was weakened on 2026-09-07 with a Change Log entry saying what could not be observed and why, and restored on 2026-09-08 with a second entry saying what changed and what the evidence was. A criterion that had been quietly green the whole time would be less convincing, not more — it would only tell you nobody looked. A spec that promises what the software does not do is worse than one that admits a gap, because the first kind teaches people to stop trusting the whole document. One small thing I like about the restoration: the original wording wasn't in git — the root commit already had the reworded text — so it was recovered from a verbatim quotation in `technical-considerations.md`, with the one clause that had to be reconstructed labelled as reconstructed.

**"What would you do if that intermediate state had to be guaranteed rather than likely?"**
Stop sampling. The fragility is entirely that the page reads *current state* on a timer, so visibility depends on a read landing inside a few tens of milliseconds. Two structural answers: push each transition to the page over a socket or SSE so nothing has to be caught; or record the transitions server-side and have the page read the history, so a stage that has passed is still reportable. Both are real fixes and both are more machinery than this criterion justifies at this scale — the product definition explicitly calls real-time transport decoration here. So the limitation is written down in the Change Log rather than engineered away, which is the same trade every other known gap in this project gets.

**"Where does this sit against the five adversarial scenarios?"**
It isn't one of them, and I'd rather say that than stretch it. §1.4's five are the races; this is Этап 1's storefront requirement and the watchable lifecycle. Its real value is as the visible face of an invisible change: Slice 2 moved the acknowledgement to the front for concurrency reasons, and that decision is normally only checkable from a log. The order page is where a reviewer can watch it happen.

---

## Source files

- `apps/web/src/pages/order/ui/order-page.ts` — the `onOrderMayHaveChanged` callback, and the comment this slice corrected
- `apps/web/src/pages/order/model/poll.ts` — `refreshNow`, and why the next wait chains off the previous run
- `apps/web/src/features/simulate-payment/ui/payment-controls.ts` — the callback's other side, and the residual comment noted in §5
- `apps/web/src/entities/order/lib/order-status-label.ts` — the total `Record<OrderStatus, string>` behind the `out_of_stock` cross-check
- `apps/web/src/entities/order/ui/order-details.ts` — `data-status`, the machine handle the verification observed
- `packages/contracts/src/order-status.ts` — `isSettledOrderStatus`, which decides where the poll stops
- `context/spec/001-purchase-and-key-delivery/functional-spec.md` §2.4 and both Change Log entries
- `context/spec/001-purchase-and-key-delivery/technical-considerations.md` §2.6 — the preserved quotation the original wording was recovered from
- `context/spec/002-single-issuance-under-races/functional-spec.md` §2.5
- `docs/walkthrough/phase-2-slice-2-answer-then-work.md` §1 — the acknowledgement move this slice makes visible
- `docs/screenshots/002-single-issuance-under-races-intermediate-state.png`

**On evidence:** the 25–65 ms figure is a direct API probe over 5 samples with no browser involved. The nine purchases, the 4/5 label split, the 1000–1060 ms dwell, the single navigation entry, the poll timings and the RED runs are this slice's browser verification, driven through Playwright against Chromium on `localhost:5173` and reported by the verifying agent. `out_of_stock` was **not** exercised in a browser; it is covered by a compile-time enum cross-check only, which is deliberately recorded in §7 as the weaker evidence it is.
