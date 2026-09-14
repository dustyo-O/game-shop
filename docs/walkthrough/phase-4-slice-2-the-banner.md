# Phase 4 · Slice 2 — The banner

> The first of the five graded interactions, and the only one with a clock in it. The banner shows four dark panels with Russian headlines, moves to the next one every 5 seconds on its own, obeys the arrows and the dots at once, wraps at both ends, starts its count over on every manual move, and holds still while the pointer rests on the panel. Slice 1 drew it; this slice gave it the clock — and the clock is where every decision in the slice lives.
>
> Three things are worth the reader's attention. **The reducer decides what happens to the timer and the DOM only carries it out**: `reduceCarousel(state, event)` returns the next state *and one word* — `restart`, `cancel` or `keep` — and the binding turns that word into a call in exactly one function, so "never more than one pending timeout" is a property of the design rather than of every handler remembering to clear before it sets. **A Playwright fake clock does not stop time when it is installed**: a bare `page.clock.install()` keeps pace with the wall until it is paused, so the real milliseconds spent loading the page had already eaten into the carousel's first 5-second window and the boundary test at 4 999 ms found slide 2 showing — the harness pattern is `install({ time })` + `pauseAt` *before* `goto`. And **the back/forward-cache restore path is not proven, either way**: under any Chromium a Playwright script can reach, the cache answers `notRestoredReasons: [{ reason: "masked" }]` and the page reloads instead; the handlers were exercised with synthetic events and read to be right, and one minute in a real Chrome with DevTools open is what settles it.
>
> Reading the delivered work found four things. A mutation of `wrapIndex` that fails only half of the wrap cases — the half a manual check never presses. The fake-clock finding above, which is now the `beforeEach` every clock-driven spec copies. A `page.waitForTimeout` in the MCP relay under which the real 5-second timer never fired, because the renderer went unscheduled while nothing held the CDP call open. And the bfcache verdict, with the grep that rules out every code-level blocker and leaves the debugging session itself as the reason.

---

## 1. What actually shipped

| # | Change | Where | Size |
| --- | --- | --- | --- |
| 1 | The carousel reducer: `CarouselState`, `CarouselEvent`, `TimerInstruction`, `createCarouselState`, `wrapIndex`, `reduceCarousel` | `apps/web/src/pages/storefront/model/carousel.ts` | 177 lines; **25** test cases |
| 2 | The single-slot countdown: `createCountdown(onFire)` → `restart(ms)`, `cancel()`, `isPending()` | `pages/storefront/model/countdown.ts` | 94 lines; **6** test cases; the page's one `setTimeout(`, at line 77 |
| 3 | The binding: DOM events → reducer → paint → `applyTimer`; the pause region; `pagehide` / `pageshow` | `pages/storefront/ui/banner.ts` | 293 lines; `AUTO_ADVANCE_MS = 5000` at line 102 |
| 4 | Vitest in `apps/web`: `vitest.config.ts` (`environment: "node"`, `include: ["src/**/*.test.ts"]`, no jsdom), `"test": "vitest run"`, root `test:web` chained *after* the API suites in `pnpm test`, `tsconfig.node.json` `include` | `apps/web/vitest.config.ts`, `apps/web/package.json`, root `package.json`, `apps/web/tsconfig.node.json` | 24 lines of config; **31 tests in ~130–190 ms** when the slice closed |
| 5 | The browser spec: §2.2's seven criteria plus assumption 3, under `page.clock` | `apps/web/e2e/banner.spec.ts` | 275 lines; **8 tests**, 345–871 ms each |
| 6 | Architecture §7's "Browser tests" bullet rewritten: the Phase 1 trigger fired, two layers, the RED discipline both inherit, the ports, the shared database precondition and the two measured findings | `context/product/architecture.md` §7 | — |
| 7 | The "one timer slot" rule | `pages/storefront/CLAUDE.md` | the second bullet |
| 8 | Two screenshots | `docs/screenshots/004-storefront-per-the-design-banner-next.png`, `-banner-auto.png` | both slide 2 with dot 2 — see §4.3 |

One thing under `model/` is **not** this slice's: `menu.ts` and `menu.test.ts` (8 cases) are Slice 3's, which ran in parallel; that is why `pnpm test:web` reports **39** tests today and 31 when this slice closed.

Change 4 is the one that changes the project's shape rather than the page's. `apps/web` had no test runner for three phases, on purpose: architecture §7 said browser tests would arrive when "a conditional in the rendering path derives a fact rather than mirroring one", and this slice is the first such conditional — wrap arithmetic and a timer policy. The runner is Vitest with `environment: "node"` and deliberately no jsdom: everything the suite checks is a reducer or a timer that never touches a document, the tests import `describe/it/expect` from `"vitest"` explicitly so the browser `tsconfig.json` keeps `types: []`, and anything that needs a DOM is a Playwright question by construction. The root `test` script reads `node scripts/with-env.ts pnpm --filter @game-shop/api run test && pnpm run test:web` — the web suite after the API suites, never instead of them.

The verify task's live drive, quoted rather than re-run (the browser MCP is held by another slice while this is written): fresh load, dot 1; next → 2, prev → 1, prev → 4, next → 1; dot 3 → 3; left alone **5 306 ms**, 3 → 4; next, then **4 006 ms** later still 1 and at **5 514 ms** → 2; pointer on the panel for **6 006 ms**, still; mouse away, **5 322 ms** later, advanced; pointer resting on the next arrow for **6 036 ms**, advanced. The whole of §2.2 by hand, in real time, before the faked-clock suite is trusted to stand for it.

---

## 2. The words this document uses

- **Reducer** — a pure function from the current state and one event to the next state: same inputs, same output, nothing read from a document or a clock, nothing mutated. Here `reduceCarousel(state, event) → { state, timer }`, and there is a test that hands it a state, calls it six times, and checks the state is untouched afterwards. Purity is what lets the policy be checked in a few milliseconds with no browser.
- **Timer instruction** — the *word* the reducer returns beside the state: `restart` ("clear whatever is pending and count 5 seconds from now"), `cancel` ("clear and leave nothing pending"), `keep` ("touch nothing"). A word and not a number, so the reducer never sees milliseconds and a test of the policy is not a test of the duration.
- **Single slot** — the countdown has exactly one variable that can hold a timeout handle, `timer`; `restart` always clears it before it sets it; the fire callback empties it *before* calling out. "Never more than one pending timeout" is this variable.
- **Pause region** — the element whose `pointerenter` and `pointerleave` pause and resume the count. Here `.banner__panel`, the dark rectangle with the slides in it — and not `.banner`, the section that also holds the arrow cluster and the dots.
- **Back/forward cache (bfcache)** — the browser's habit of keeping a page you navigate away from *alive and frozen* rather than destroying it, so that Back restores it instantly *as it was left*: the same DOM, the same JavaScript state, the same listeners, and — the point of this slice — the same pending timers. `pagehide` fires as the page goes in; `pageshow` fires as it comes back, with `event.persisted === true` when it came from the cache rather than from a fresh load. Not every page is eligible, and Chrome reports why a page was not cached under `notRestoredReasons`.
- **Faked clock** — Playwright's `page.clock`: it replaces `Date`, `setTimeout` and their relatives *inside the page* with a clock the test moves by hand (`page.clock.runFor(ms)`), so a 5-second policy is exercised in milliseconds of wall time. It fakes time and scheduling, not input: a `page.hover()` still delivers a real `pointerenter`.
- **Virtual time vs real time** — virtual time is what the faked clock says has passed (`runFor(5000)` is 5 000 ms of it); real time is what the wall says. The banner spec drives ≈55–60 s of virtual time in ≈3.5–3.8 s of real time. One real-time observation was taken on purpose — one automatic advance seen inside a **5 207 ms** window on the wall — so both kinds are on record and neither has to stand in for the other.

---

## 3. The three decisions the task names

Each in the same shape: what was built, the more obvious alternative, and what goes wrong without the decision — with the exact code fact beside the plain-language reason.

### 3.1 The reducer emits a timer instruction; the DOM only applies it

**What.** `model/carousel.ts` is a reducer over a three-field state — `{ index, count, isPaused }` — and six events: `tick`, `next`, `prev`, `dot(index)`, `pointer-enter`, `pointer-leave`. Every call returns two things: the state to paint, and one of three words, `TimerInstruction.Restart | Cancel | Keep`. The policy is a table, and the code is the table with one branch per row:

| Event | Index | `isPaused` | Timer |
| --- | --- | --- | --- |
| `tick` | +1, wrapped | — | `restart` |
| `tick` while paused | unchanged | — | `keep` (defensive: a `pointer-enter` cancels the timer, so a tick should not arrive) |
| `next` / `prev` / `dot(i)` | moved, wrapped | — | `isPaused ? cancel : restart` — a manual move starts the 5-second count over from that moment (crit 6) unless the pointer is resting on the panel (crit 7) |
| `dot(i)` out of range or non-integer | unchanged | — | `keep` — a dot is a target, not an offset, so it does not wrap |
| `pointer-enter` | unchanged | `true` | `cancel` |
| `pointer-leave` | unchanged | `false` | `restart` |

`model/countdown.ts` is the other half: `createCountdown(onFire)` with one slot, `restart(ms)` that clears before it sets, `cancel()`, `isPending()`. It waits and fires once; it does not repeat — the loop is the reducer's doing, because the tick's own row answers `restart`.

`ui/banner.ts` joins them and adds nothing of its own. `dispatch(event)` is three lines — `reduceCarousel`, paint, `applyTimer` — and `applyTimer` (lines 178–194) is the *one* place an instruction becomes a call: `restart` → `countdown.restart(AUTO_ADVANCE_MS)`, `cancel` → `countdown.cancel()`, `keep` → nothing, and a `default` that calls `assertNever`, so a fourth word could not be added to the type without the compiler pointing at this switch. `AUTO_ADVANCE_MS = 5000` is written at line 102 and nowhere else; the reducer never sees it. Across the whole of `pages/storefront/`, `grep -rn "setTimeout("` finds one line, `model/countdown.ts:77`, and that is the check `CLAUDE.md` names. Painting is by iteration, never by index — `slides.forEach((slide, i) => { slide.hidden = i !== state.index })` and the same for `aria-current` on the dots — so `grep "slides\[\|dots\["` finds nothing and there is no `!` to silence the `HTMLElement | undefined` that `noUncheckedIndexedAccess` would hand back (R7).

**The obvious alternative.** Let the handlers decide. The arrow's click handler moves the slide and calls `clearTimeout(timer); timer = setTimeout(tick, 5000)`; the panel's `pointerenter` calls `clearTimeout`; `pointerleave` calls `setTimeout`; the tick does both. Or reach for `setInterval(tick, 5000)` and, on an arrow press, clear and re-create it. Both are shorter than a reducer, and both are how most carousels are written.

**What goes wrong with the alternative.** The rules interlock — a tick advances *and* re-arms; an arrow advances *and* re-arms *unless* the pointer is on the panel, in which case it advances and leaves the timer *off*; enter stops without moving; leave starts without moving — so each handler has to know what every other handler did to the timer, and the one invariant that matters, *never more than one pending timeout*, becomes a property of every handler remembering to clear before it sets. Miss it once and two timeouts are counting: the banner moves on its own twice within a second of a manual move, which is crit 6 broken in a way no single-press check notices, because the first press always looks fine (R2). `setInterval` does not help: crit 6 needs the *phase* reset on every manual move, and crit 7 needs the interval gone while hovering, so the interval is cleared and re-created from three handlers anyway — the same slot problem, plus the drift an interval accumulates.

With the reducer, the invariant has three parts and each is a fact about one file: the reducer emits exactly one instruction per event; the countdown has one slot and `restart` clears before it sets; and the binding has one function that turns a word into a call. A handler that wanted a timer of its own would have to say so to the reducer, where its wish would join the policy table and the unit test that checks it row by row — it cannot schedule a timeout itself without adding a second `setTimeout(` to the page, which the grep would show. The other half of the payoff is the test: the policy table is checked in 25 cases in about four milliseconds with no browser and no clock, and the browser test only has to prove that the binding forwards the word.

### 3.2 The pause region is the panel, not the banner

**What.** `pointerenter` and `pointerleave` are bound to `.banner__panel` (lines 227–232) — the dark rectangle with the four slides in it — and not to the `.banner` section. The arrow cluster (`.banner__arrows`, holding both buttons) and the dot row are *siblings* of the panel in the markup (lines 271–273), and the stylesheet positions them over the panel's corner from the section: `.banner__arrows { position: absolute; top: 0; right: 0 }`, with a comment on `.banner` saying the arrow cluster must not be the panel's child because the panel alone is the pause region. There is no `focusin` handler — the word appears in `banner.ts` once, in the paragraph explaining why not. `aria-live="off"` sits on the panel, because a region that rotates on its own must not announce every rotation.

**The obvious alternative.** Pause on the whole banner — arrows, dots and panel — because that is what "the pointer is over the banner" sounds like, and it is what the functional spec literally says in crit 7. And pause on `focusin` as well, because the APG carousel pattern suggests it: a keyboard user who has tabbed onto the arrows should not have the slide move under them.

**What goes wrong with the alternative.** Crit 6 — "when the shopper presses an arrow, the automatic 5-second count starts over from that moment" — becomes impossible to *observe* with a mouse. A mouse press on an arrow happens with the pointer on the arrow; if the arrow is inside the pause region the carousel is paused at that instant, `moveTo` answers `cancel` rather than `restart` (the crit 7 row), and the count that was supposed to start over never starts at all. Every mouse user's every arrow press would leave the banner stopped until the pointer wandered off, and a reviewer checking crit 6 by hand would conclude it was not implemented. With the arrows outside the region, moving the pointer from the panel to the cluster fires `pointerleave` — the arrows are not descendants of the panel, so leaving for them *is* leaving — the reducer answers `restart`, and the press that follows is a `next` with `isPaused: false`, which answers `restart` again: the count visibly begins at the press. `focusin` fails the same way for the same reason: a mouse click focuses the button it pressed, so pausing on focus pauses on every mouse press.

The evidence is the same fact seen twice: `banner.spec.ts`'s "assumption 3" test hovers `.banner__arrow--next`, runs the clock 6 000 ms and expects slide **2**; the live drive held the real pointer on the arrow for **6 036 ms** and saw the banner advance. What the decision costs is stated rather than hidden: a keyboard user who tabs to the arrows gets no pause — the pause is a pointer affordance — and the spec's own words for crit 7 ("over the banner") are read as "over the panel", which the technical spec records as assumption 3.

### 3.3 What the back/forward cache does to a page that stopped its own timer

**What.** Two `window` listeners at the end of `createBanner` (lines 283–290), never removed. `pagehide` → `countdown.cancel()` — the only call to the countdown anywhere in the file outside `applyTimer`. `pageshow` → `if (event.persisted) resume()`. And `resume()` is not a bare `countdown.restart(5000)`: it is `dispatch({ type: "pointer-leave" })` — the same function that starts the clock the first time, at line 280, before the element is even handed to the page.

The sequence, as it is meant to run. A shopper presses Купить, or types an order URL, 4.8 seconds into a slide. `pagehide` fires; `countdown.cancel()` clears the slot; the document goes into the cache with **nothing pending**. A minute later the shopper presses Back. The page is restored as it was: same DOM, same `state` object, same listeners. `pageshow` fires with `persisted: true`; `resume()` dispatches `pointer-leave`; the reducer answers `{ isPaused: false }` and `restart`; `applyTimer` calls `countdown.restart(5000)`; the banner counts a fresh five seconds from the moment it reappeared, and §2.7 crit 4 — "they return to the storefront, with the banner running" — holds.

**The obvious alternative.** Do nothing on `pagehide` — the page is going away, why tidy? — and either do nothing on `pageshow` or call `countdown.restart(5000)` directly, since all that is wanted is a running clock.

**What goes wrong with the alternative — in three parts, because there are three ways to get it wrong.**

*No `pagehide` cancel.* A cached page is frozen with whatever timeouts it had pending, and on restore those timeouts resume with whatever remainder they had. The shopper who left 4.8 s into a slide comes back to a banner that jumps **200 ms** after the page reappears — or at once, if the deadline elapsed while the page was frozen — and then settles into its rhythm from that arbitrary moment. Nothing is *broken*; the banner is simply not doing what crit 1 says ("every 5 seconds"), for one beat, in a way no one could reproduce on demand. Cancelling on `pagehide` leaves nothing to resume. (This is what the technical spec's §2.3 calls "not only hygiene"; it is also the moment `pages/order/model/poll.ts` stops its own loop, for its own reasons.)

*Cancel but no `pageshow`.* Now the cached page comes back with a banner and no clock — R1, "banner dead after back", the failure the whole handler pair exists to prevent. Without the cache this cannot happen: Back is a full reload, `mountApp` runs again, `createBanner` runs again, slide 1 shows with a fresh count. With the cache, nothing runs again unless something listens for the restore.

*Restore with a bare `countdown.restart`.* The state may still say `isPaused: true`. Picture the pointer resting on the panel — timer cancelled, flag set — while the shopper tabs to Купить and presses Enter. Navigate, return. A direct `restart(5000)` fires a tick into a reducer whose state says paused; the `tick`-while-paused row answers `keep` and leaves the index alone; `keep` means the countdown is *not* re-armed; the banner is dead until the pointer happens to cross the panel's edge. Going through `pointer-leave` clears the flag and restarts in one step, and keeps the file to its rule — the reducer decides, `applyTimer` applies. The live drive dispatched a synthetic `pageshow` *while hovering* and saw the banner resume. The same drive dispatched `pageshow` with `persisted: false` and saw it ignored, which is right: a fresh load has already called `resume()` at build, and a second call would be harmless but would be acting on an event that does not mean "restored".

Two neighbours of the decision. `ui/catalog-menu.ts` forces the overlay closed on a persisted `pageshow` for the same reason (belt and braces — the click on Купить is itself an outside click, so the menu is closed before the navigation begins). And the one edit to `features/buy-product` — re-enabling a Купить the cache would restore *disabled* — is the same fact from the button's side, and is Slice 5's.

What the decision cannot claim, yet: that a real Chrome actually takes the cached path on this page. §5.4.

---

## 4. What the two test layers prove, and how each was shown able to fail

### 4.1 Vitest — the policy table, row by row

`carousel.test.ts`, **25 cases**; `countdown.test.ts`, **6 cases** under `vi.useFakeTimers()`. The first RED was the trivial one — the tests existed before the modules and failed with `Cannot find module './carousel.js'`. The next was a stub reducer that returned `keep` for everything: **22 failed / 9 passed of 31**, the 9 reported as the "unchanged, keep" rows a stub that always answers `keep` satisfies for free — which is why every one of those rows asserts the index *and* the pause flag *and* the instruction, and why the purity case checks the input object afterwards. Then the two mutations the technical spec's §4.1 prescribes, on the shipped code:

| Row | Cases | What guards it |
| --- | --- | --- |
| `createCarouselState` | starts at 0, not paused; refuses 0 and −1 | write-first |
| `wrapIndex` | in-range untouched; `count → 0`; `−1 → count − 1`; any distance either way | **without the `+ count` normalisation: 3 failed, all *first → last*** — `−1 % 4` is `−1`, `4 % 4` is `0`, so *last → first* stayed green (§5.1); **without the modulo at all: 6 failed** |
| `tick` | +1 and `restart`; wraps last → first (crit 2); while paused: unchanged, `keep` | stub → red; the wrap case is one of the six that fail without the modulo |
| `next` / `prev` | +1 / −1 and `restart` (crits 3, 6); wraps both ways (crit 4); while paused: moves and `cancel` (crit 7) | stub → red; `prev` *first → last* is one of the three the `+ count` mutation flips |
| `dot(i)` | lands and `restart`; the same slide still `restart` ("a press is a press"); while paused `cancel`; above range, below range, non-integer: unchanged, `keep` | stub → red for the first three; the three `keep` rows are held by the three-fact assertion |
| `pointer-enter` / `pointer-leave` | index unchanged; flag set / cleared; `cancel` / `restart` | stub → red |
| purity | never mutates its argument; returns a new object when something changed | — |
| `countdown` — **restart twice → fires once** | two `restart(5000)` then 10 000 ms: `onFire` once | **`clearTimeout` removed from `restart`: 2 failed** — `expected "vi.fn()" to be called 1 times, but got 2 times`; reading the file, the only other case that mutation can flip is the one below |
| `countdown` — restart mid-count starts over (crit 6) | `restart`, 3 000 ms, `restart`, 4 000 ms: nothing; 1 000 more: once | the same mutation — the un-cleared first count fires at the 7-second mark into a `not.toHaveBeenCalled()` |
| `countdown` — cancel never fires; cancel when idle is a no-op; `isPending` before / during / after; the slot is emptied *before* `onFire` | — | the last case documents the ordering bug it exists for: null the slot *after* `onFire` and the restart made from inside the tick would be overwritten with `null` |

Run fresh for this document: **3 files, 39 tests, 136 ms** — the 31 above plus Slice 3's 8.

### 4.2 Playwright — §2.2 in a browser, under a clock the test moves

`banner.spec.ts`, **8 tests**, 345–871 ms each, ≈3.5–3.8 s of real time for ≈55–60 s of virtual time (the `runFor` arguments in the file sum to 55 000 ms). Every assertion reads state, never a style: `visibleSlide` is the one `.banner__slide` without `hidden`, `currentDot` the one `.banner__dot` with `aria-current="true"`, and `assertInvariant` checks crit 5 as three separate facts — exactly one slide visible, exactly one dot current, and the two name the same position — so a failure says which of the three broke.

| Test | Virtual time driven | Asserts |
| --- | --- | --- |
| crit 1 — at 5 000, not before | 4 999 + 1 | still 1 at 4 999; 2 at 5 000 |
| crit 2 — wraps to the first | 4 × 5 000 | 2, 3, 4, then **1** |
| crit 3 — arrows at once | 0 | next → 2, prev → 1 with no clock movement |
| crit 4 — left from the first | 0 | prev → **4** |
| crit 5 — the dot names the slide | 5 000 | the invariant after a tick, an arrow each way, and dot 3 → 3 |
| crit 6 — the count starts over | 3 000 + 4 000 + 1 000 | still **2** at 4 000 after the press; **3** at 5 000 |
| crit 7 — pause and resume | 6 000 + 5 000 | hovering the panel: still 1 at 6 000; `mouse.move(0, 0)`: 2 at 5 000 later |
| assumption 3 — the arrow is not the region | 6 000 | hovering `.banner__arrow--next`: **2** |

RED, as the task prescribes — push a "state changed" assertion past its boundary, weaken nothing in `src/`: crit 6 with `runFor(4000)` changed to `runFor(5000)` while keeping "still 2" → **`Expected: 2 Received: 3`**; crit 7 asserting "advanced" while still hovering → **`Expected: 2 Received: 1`**. The full e2e run when the slice closed: **28 tests in 22.6 s**; 34 today with Slice 3's six.

**The clock method, and the finding that shaped it.** The `beforeEach` is not `page.clock.install()` and then `goto`, which is what the tech spec's table and the task text say. It is:

```ts
const FIXED_START_MS = Date.parse("2024-01-01T00:00:00.000Z");
const PAUSE_MARGIN_MS = 100;

await page.clock.install({ time: FIXED_START_MS });
await page.clock.pauseAt(FIXED_START_MS + PAUSE_MARGIN_MS);

await page.goto("/");
await waitForRowToSettle(page);
```

because a bare `install()` does not freeze time (§5.2). The spec that must **not** do this is `buy-through.spec.ts` (Slice 5's): it waits on the order page's poll, whose `setTimeout` loop the same fake clock would freeze, so the key it waits for would never arrive. The two specs are mutually exclusive by what they wait for — one waits for a timer, the other for a network reply chained off real async work — and the banner spec's header says so at length so that nobody "fixes" the buy-through by adding the clock.

### 4.3 The real-time observation

The faked clock proves the policy; it cannot prove that the page's real `setTimeout` reaches the real reducer at the real interval. So the verify task drove the real page once, through the Playwright MCP, with no clock installed: the sequence in §1, and then the wait the task asked for — dot **1 → 2** across a window of **5 207 ms** on the wall (`t` **1789320465223 → 1789320470430**): the tick fell inside a 5.2-second wait, as crit 1 says it must. The number is the window, not the instant the timer fired; the faked-clock suite is what pins the instant. The same drive dispatched the lifecycle events from script, which is the most any automation can do for them (§5.4): `pageshow { persisted: true }` at T+3 s replaced the tick that was due at T+5 — still at T+5.5, advanced at T+8.5, a fresh five seconds from the restore rather than the two remaining; `pagehide` then **6 003 ms** — no advance; `pageshow` while hovering — resumed; `pageshow { persisted: false }` — ignored.

The two screenshots are the same view reached two ways, and that is what they are for. `-banner-next.png` is a fresh load and one press of the right arrow; `-banner-auto.png` is a fresh load and 5.2 seconds of doing nothing. Both show «Ключи для игр» — slide 2 — with the second dot drawn as the wide pill; the files differ (59 949 and 59 768 bytes), the view does not. That is crit 5 in a picture: after a manual move and after an automatic one, the dot names the slide. A reader should know they will not be able to tell the two apart, and that a "before" frame of slide 1 would have made each more useful on its own (§7).

### 4.4 What none of them prove

The cached restore. Every path above — unit, e2e, live drive — either never navigates or navigates under a debugging session, and under a debugging session Chromium does not cache the page. The synthetic events prove the handlers do the right thing *when the events arrive*; they do not prove the browser delivers them on this page. §5.4 has the verdict and what settles it.

---

## 5. Findings

### 5.1 The quiet half-failure

`wrapIndex` is `((index % count) + count) % count`. Remove the `+ count` and the second `%` — leave a bare `index % count` — and the suite reports **3 failed**, every one a *first → last* case: `wrapIndex(-1, 4)`, `wrapIndex(-5, 4)`, and `prev` from slide 1. Every *last → first* case stays green, because `4 % 4` is `0` and always was; the sign of `%` follows the dividend in JavaScript, so `-1 % 4` is `-1` and only negative indexes go wrong. Remove the modulo entirely and **6 fail** — both directions, three in `wrapIndex` and three in the reducer.

Why it is the mutation worth recording rather than the bigger one: a carousel with a bare `%` advances correctly all day, ticks through the wrap correctly, obeys the right arrow correctly, and breaks on exactly one gesture — the left arrow from slide 1 — which is exactly the gesture a manual check ("press next a few times, watch it wrap") never makes. The test file's header says this is the reason crit 4 has its own case; the RED is what shows the case is not decorative.

### 5.2 `install()` does not freeze time

The first version of the spec did what the tech spec's table and the task text say: `page.clock.install()`, then `goto`. Crit 1's `runFor(4999)` then found **`Expected: 1 Received: 2`** — slide 2 already showing one millisecond short of the boundary. The cause is in Playwright's own documentation of `pauseAt`: until a pause method is called, the installed clock *keeps pace with real time*, precisely so a page's in-flight timers do not stall while it loads. So the real milliseconds spent by `goto`, the bootstrap and the `GET /api/products` round trip — anywhere from tens to several hundred — were already inside the carousel's first 5-second window before the first `runFor` added to it, and 4 999 virtual plus a few hundred real crossed 5 000. The next attempt, `pauseAt(Date.now())` after navigation, threw **`Cannot fast-forward to the past`**: the target was already behind the clock's live position by the time the call arrived.

The fix is to pause *before* navigating, at a synthetic epoch the file owns: `install({ time: FIXED_START })` then `pauseAt(FIXED_START + 100)` — the 100 ms absorbs the `install()` round trip that had already moved the clock past `FIXED_START`, and is nowhere near the 5 000 that matters — and only then `goto`. Nothing in the tests cares what the date is, only about the deltas they drive themselves, so an arbitrary fixed start is exactly as valid as the real one, and the browser never sees an unpaused clock after that line. The tech spec's §4.2 Clock paragraph carries the measurement; the spec's `beforeEach` carries the explanation; and any later clock-driven spec copies the `beforeEach` rather than the table's shorthand.

### 5.3 `waitForTimeout` in the relay

Taking the real-time observation nearly produced a false alarm. The first attempt waited with `page.waitForTimeout` in the MCP relay and then read the dot — and the dot had not moved. The real timer had not fired: with no CDP call held open against the page, the renderer went unscheduled and its timers with it. Moving the wait *inside* `page.evaluate` — awaited by the page itself, with the call held open for its duration — kept the renderer scheduled and the timer honest: dot 1 → 2 across a **5 207 ms** window. The lesson for anyone repeating the drive is that "the banner did not advance while I waited" is not evidence against the banner unless the page was actually running while you waited.

### 5.4 The bfcache verdict, and what settles it

The verify task tried to reach the cached path from a script. `chromium.launch({ ignoreDefaultArgs: ["--disable-back-forward-cache"] })` — removing the flag Playwright adds by default — against `vite preview` on 5101, navigate away, `goBack()`: **`pageshow.persisted: false`**, and the navigation entry's `notRestoredReasons.reasons: [{ reason: "masked" }]`. The page was not cached, and Chrome declines to say why in a form a script can read.

What it is *not*: a code-level blocker. `grep -rn "beforeunload\|unload\|WebSocket\|EventSource"` over `apps/web/src` finds three prose mentions of "unloading" in comments and no listener; the preview server answers `Cache-Control: no-cache`, not `no-store` (only `no-store` disqualifies). What it *is*, by Chromium's own documentation of the cache: a page with a debugging session attached is not eligible — and every Playwright page, MCP relay included, has one. That is why the tech spec's sentence "Playwright disables bfcache" is true but understated: removing the flag does not restore eligibility, because the session itself is the disqualifier. The manual check the task prescribed — a real Chrome, no automation — could not be completed by an agent on this machine (no screen-recording permission), and the user has been asked to do it.

So the honest state is: **the cached-restore path is not proven either way**. The handlers are read to be right and were exercised with synthetic events (§4.3); the reload path — Back as a full reload, `mountApp` again, slide 1 with a fresh count — is what every Playwright-driven back navigation actually takes and is proven by that. What settles the other path is one minute in a real Chrome, and the record of it belongs here when it exists:

1. `pnpm --filter @game-shop/web run build`, then `pnpm --filter @game-shop/web run preview` (the API on its usual port, so the catalogue loads).
2. Open the storefront; DevTools → **Application** → **Back/forward cache** → **Test back/forward cache**. Chrome navigates away and back by itself and reports either "Successfully served from back/forward cache" or the list of reasons it was not. Record the verdict verbatim.
3. If eligible: note which dot is current, navigate to any order page (or any URL) in the same tab, press Back, and watch the dot advance within 5 s of the page reappearing. That is `pageshow { persisted: true }` → `resume()` doing its job in the wild, and §2.7 crit 4 on the path the tests cannot reach.

---

## 6. Interview questions this answers

**"Why not `setInterval(next, 5000)`? That is what a carousel is."**
Because two of the seven criteria are about *when the count starts*, not just how long it is. An arrow press has to start the 5 seconds over from that moment (crit 6), and hovering has to stop the count and leaving has to start it (crit 7) — so the interval would be cleared and re-created from three different handlers, which is every problem of a timeout with none of the clarity, plus the drift an interval accumulates. The countdown waits once and fires once; the *loop* is the reducer's, because the tick's row answers `restart`. And there is a test that says what an interval could not: restart twice, fires once.

**"Why does a reducer decide what happens to the timer? The handlers know what they did."**
That is the problem — each one knows what *it* did and has to guess what the others did. The rules interlock: tick advances and re-arms; an arrow advances and re-arms unless the pointer is on the panel, in which case it advances and leaves the timer off; enter stops without moving; leave starts without moving. Put that in five handlers and "never more than one pending timeout" is a matter of every handler clearing before it sets, and the failure — two timeouts, a banner that jumps twice within a second of a press — looks fine on the first press. Put it in one function that returns the next state *and one word* — `restart`, `cancel`, `keep` — and the invariant is three facts: one instruction per event, one slot that clears before it sets, one place a word becomes a call. It is also what makes the policy testable without a browser: 25 cases, no DOM, no clock, and the word is checked as a return value.

**"Why is 5 000 not in the reducer?"**
So that a test of the policy is not a test of the duration. The reducer says *restart*; `ui/banner.ts` says *5 000*, once, at `AUTO_ADVANCE_MS`; the countdown says *count this many*. Change the spec to four seconds and one line changes, and none of the 25 policy cases care.

**"Why doesn't the carousel pause on focus? The APG pattern says it should."**
Because a mouse click focuses the button it pressed. Pause on `focusin` and every mouse press on an arrow pauses the banner — the same failure as putting the arrows inside the pause region, by another route. The pause here is a pointer affordance, bound to the panel's `pointerenter`/`pointerleave`; a keyboard user who tabs onto the arrows gets no pause, and that is stated in the file rather than hidden.

**"Why is the pause region the panel and not the whole banner? The spec says 'over the banner'."**
Because crit 6 has to be *observable*. An arrow press restarts the count "from that moment" — but a mouse press on an arrow happens with the pointer on the arrow, and if the arrow is inside the pause region the carousel is paused at that instant, the reducer answers `cancel` instead of `restart`, and the count never visibly starts. Every mouse user would find the banner stopped after every press. So the arrows and dots are siblings of the panel in the markup, positioned over its corner by the stylesheet; moving from the panel to the arrow *is* leaving the region, the count restarts as the pointer arrives, and the press is a `next` with the flag clear. Tested both ways: hover the next arrow and run the clock 6 000 ms — slide 2; and in real time, 6 036 ms with the pointer resting on the arrow — advanced. Assumption 3 in the tech spec records the reading.

**"What does the back/forward cache do to your timers, and what do you do about it?"**
It freezes the page with whatever timeouts are pending and resumes them on restore with whatever remainder they had — so a shopper who left 4.8 s into a slide would see the banner jump 200 ms after coming back, once, at a moment nobody could reproduce. `pagehide` cancels the countdown, so the page goes into the cache with nothing pending. Then the restored page has no clock, which would be a dead banner after Back — so `pageshow` with `persisted: true` restarts it. And it restarts *through the reducer*, as a `pointer-leave`, not with a bare `countdown.restart`: the state may still say paused from a pointer that was on the panel when the shopper left, and a tick into a paused reducer answers `keep` — no move, no re-arm, dead banner until the pointer crosses the edge. The `pointer-leave` clears the flag and restarts in one step, and it is the same function that starts the clock on first build. Without the cache, Back is a reload and none of this runs; with it, none of this runs unless something listens.

**"How do you test a 5-second policy in 400 milliseconds?"**
`page.clock` replaces the page's `Date` and `setTimeout` with a clock the test moves — `runFor(4999)`, assert still slide 1, `runFor(1)`, assert slide 2. Eight tests drive about 55 seconds of virtual time in under four seconds of real time. Two things had to be learned. `install()` alone does not stop time: it keeps pace with the wall until paused, so the milliseconds `goto` spent were already inside the first 5-second window and the 4 999 boundary failed with slide 2 showing — the fix is `install({ time })` and `pauseAt` *before* navigating. And the spec that watches the order page's delivery poll must *not* install the clock, or the poll freezes and the key never arrives. One real-time observation sits beside the faked-clock suite so the suite is not the only witness: one advance inside a 5 207 ms window on the wall.

**"Why can't Playwright prove the restore?"**
Because a page with a debugging session attached is not eligible for the cache, and every page Playwright touches has one. Removing the `--disable-back-forward-cache` flag it adds by default does not help: `goBack()` still reports `persisted: false` and `notRestoredReasons: [{ reason: "masked" }]`. There is no code-level blocker — no `unload` listener, no open socket, `no-cache` rather than `no-store` — so the session itself is the reason. What automation *can* do is dispatch the events from script, and it did: a synthetic `pageshow { persisted: true }` replaced the pending tick with a fresh five seconds, `pagehide` stopped it, `pageshow` while hovering resumed it, `persisted: false` was ignored. What only a person can do is the one-minute check in a real Chrome — DevTools → Application → Back/forward cache → Test — and the walkthrough says "not proven" until that verdict is recorded.

**"How do you know the wrap tests can fail?"**
By breaking the line they guard and watching which cases go red. Drop the `+ count` normalisation from `wrapIndex` and 3 fail — every one a *first → last* case, because `4 % 4` is already `0` and only `-1 % 4` goes wrong. Drop the modulo entirely and 6 fail. The first mutation is the one worth recording: it is the bug a bare `%` gives you, it breaks exactly one gesture — the left arrow from slide 1 — and it is the gesture a manual check never makes. The countdown's RED is the same shape: delete the `clearTimeout` in `restart` and "restart twice → fires once" reports `called 1 times, but got 2 times`.

**"What did the exercise find?"**
Four things. The half-failure above. That a bare `page.clock.install()` does not freeze time — the 4 999 boundary failed with slide 2 showing, `pauseAt(Date.now())` after navigation threw `Cannot fast-forward to the past`, and the fix is a fixed epoch paused before `goto`. That a `page.waitForTimeout` in the MCP relay lets the renderer go unscheduled so a real timer never fires — the wait had to live inside `page.evaluate`. And that the bfcache path is unreachable from any automation, with the greps that rule out every code-level reason and leave the debugging session as the cause.

---

## 7. What is not finished

- **The cached-restore path is not proven.** §5.4. The user has been asked for the one-minute Chrome check; this document says "not proven" until the DevTools verdict and the post-Back advance are recorded here. `tasks.md` marks the Slice 2 verify task done although this part of it could not be completed by an agent.
- **The reload path has no committed spec yet.** `goBack()` after a buy-through, with the overlay hidden and the dot advancing within ~7 s of real time, is `buy-through.spec.ts` — Slice 5's, with the real clock.
- **Купить after Back.** The cache restores the button *disabled*; the persisted-`pageshow` re-enable in `features/buy-product` is Slice 5's, and is the same finding from the button's side.
- **No pause for the keyboard.** By decision (§3.2): the pause is the pointer's. A keyboard user on the arrows sees the slide move under them at the 5-second mark. If that is ever wanted, it is a `focusin` row in the policy table that must *not* fire for a mouse click — which is harder than it sounds and is why it was not done.
- **A pointer already on the panel at restore.** `resume()` assumes the pointer is not there. If it physically is and has not moved, the state says "not paused" until the next boundary event. Not verified in either direction, and not reachable by automation for the reason in §5.4.
- **The two screenshots are indistinguishable.** Both show slide 2 with dot 2, correctly, for two different reasons; a slide-1 frame beside each would let a reader see the change rather than take it on trust.
- **The task text and the spec's table still say the bare `install()`.** `tasks.md` Slice 2 task 3 and the tech spec's §4.2 file table say `page.clock.install()` before `goto`; the Clock paragraph and the shipped `beforeEach` say `install({ time })` + `pauseAt`. Reported, not edited.
- **Architecture §7's numbers are already behind.** "20 tests in ~16 s" and "31 tests, ~130 ms" were true when the bullet was written; Slice 3 has since added 6 e2e and 8 unit cases (34 and 39). Slice 3's own explain task is the place to move them.
- **The phase walkthrough.** `docs/walkthrough/phase-4.md` is Slice 6; this document is the slice's own explanation, not the phase's.

---

## Source files

- `apps/web/src/pages/storefront/model/carousel.ts` — the reducer; the header on why it emits an instruction, the sign of `%`, and why a dot does not wrap
- `apps/web/src/pages/storefront/model/countdown.ts` — the one slot; why the slot is emptied *before* `onFire`; why it is not a generalisation of `poll.ts`
- `apps/web/src/pages/storefront/model/carousel.test.ts` — the policy table as 25 cases; the header on the quiet half-failure and on asserting every "unchanged" row three ways
- `apps/web/src/pages/storefront/model/countdown.test.ts` — "restart twice → fires once" and the five around it, under `vi.useFakeTimers()`
- `apps/web/src/pages/storefront/ui/banner.ts` — the three header sections: the reducer decides, the panel is the region, and `pagehide`/`pageshow`; `applyTimer`; `resume()`; `AUTO_ADVANCE_MS`
- `apps/web/src/pages/storefront/ui/storefront.css` — the `.banner` comment: the arrow cluster is positioned from the section because the panel alone is the pause region
- `apps/web/src/pages/storefront/config/banner-slides.ts` — the four slides; no percentages, no invented discounts (R17)
- `apps/web/src/pages/storefront/CLAUDE.md` — the "one timer slot" rule and the grep that checks it
- `apps/web/src/pages/order/model/poll.ts` — the other timer on the site, and the sentence that says why the banner did not reuse it
- `apps/web/vitest.config.ts` — `environment: "node"`, no jsdom, `src/**/*.test.ts` only
- `apps/web/e2e/banner.spec.ts` — the eight tests; the `beforeEach` and its comment on `install()`; the header on why `buy-through.spec.ts` must not install the clock
- `apps/web/package.json`, root `package.json` — `"test": "vitest run"`; `test:web` chained after the API suites in `test`
- `context/spec/004-storefront-per-the-design/functional-spec.md` §2.2 (all seven criteria), §2.7 crit 4
- `context/spec/004-storefront-per-the-design/technical-considerations.md` §2.2 (Carousel, Countdown), §2.3, §4.1, §4.2's Clock paragraph, R1, R2, R7, R15, assumption 3
- `context/spec/004-storefront-per-the-design/tasks.md` — Slice 2, the six task texts
- `context/product/architecture.md` §7 — the "Browser tests" bullet, two layers and the two measured findings
- `docs/screenshots/004-storefront-per-the-design-banner-next.png`, `-banner-auto.png`

**On evidence:** what I ran fresh while writing this document, against the tree as it stands, with no server started, no browser driven (the MCP is held by another slice), and no source, test or config file modified. `pnpm --filter @game-shop/web run typecheck` — both `tsc --noEmit` passes — clean. `pnpm test:web` — **3 files, 39 tests passed, 136 ms**. `grep -rn "setTimeout(" --include='*.ts'` over `pages/storefront/`, tests included: one line, `model/countdown.ts:77`; `clearTimeout` at lines 74 and 85 of the same file and nowhere else; `setInterval`: nothing; `slides\[\|dots\[`: nothing; `focusin`: once, in `banner.ts`'s comment at line 44; `aria-live`: `banner.ts:222`; `pagehide`/`pageshow` listeners at `banner.ts:283` and `:286` and `catalog-menu.ts:193`; `countdown.cancel()` called at `banner.ts:185` (inside `applyTimer`) and `:284` (`pagehide`), `countdown.restart` at `:181` only. `grep -rn "beforeunload\|unload\|WebSocket\|EventSource"` over `apps/web/src`: three prose hits on "unloading" in comments, no listener. `grep -c "it("` over the model tests: 25 / 6 / 8; `test("` declarations over the four specs: 8 / 6 / 7 (one inside a loop of seven chips) / 6 — 34. `wc -l`: `carousel.ts` 177, `countdown.ts` 94, `carousel.test.ts` 244, `countdown.test.ts` 130, `banner.ts` 293, `banner.spec.ts` 275, `vitest.config.ts` 24. `AUTO_ADVANCE_MS = 5000` at `banner.ts:102`; `FIXED_START_MS`/`PAUSE_MARGIN_MS = 100` at `banner.spec.ts:135–136`; the `runFor` arguments in the spec sum to 55 000 ms. Both screenshots opened and read: each shows «Ключи для игр» with the second dot as the wide pill and the arrow cluster in the top-right notch; `ls -l` 59 949 and 59 768 bytes, different `shasum`s. Root `package.json`'s `test` script read as quoted. `git log -1 --format=%B 038f7d4` read. `git status` when writing began: clean but for Slice 3's two menu screenshots and `.playwright-mcp/`; by the end, Slice 4's edits to `steam-topup.ts`, `storefront.css` and `tasks.md` had appeared alongside — none of them this slice's, and none read for this document.

Everything else is reported by the slice's task agents and quoted rather than re-run: `Cannot find module './carousel.js'`; 22 failed / 9 passed of 31 under the `keep` stub; 3 failed and 6 failed for the two `wrapIndex` mutations; 2 failed and `expected "vi.fn()" to be called 1 times, but got 2 times` without `clearTimeout`; 31 tests in ~130–190 ms; the 345–871 ms per-test and ≈3.5–3.8 s per-file timings; `Expected: 2 Received: 3` and `Expected: 2 Received: 1`; `Expected: 1 Received: 2` under the bare `install()` and `Cannot fast-forward to the past`; 28 e2e tests in 22.6 s; every number in the live drive — 5 306, 4 006, 5 514, 6 006, 5 322, 6 036, 6 003 ms, the T+3 / T+5.5 / T+8.5 sequence, and `t` 1789320465223 → 1789320470430 = **5 207 ms**; `pageshow.persisted: false` and `notRestoredReasons.reasons: [{ reason: "masked" }]` under `ignoreDefaultArgs: ["--disable-back-forward-cache"]` against `vite preview` on 5101; `Cache-Control: no-cache`. The e2e suite, `pnpm test`, and the manual Chrome check were not run for this document: the first two start servers or touch the shared database while another slice is working, and the third needs a person.
