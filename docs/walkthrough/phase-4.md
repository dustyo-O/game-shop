# Phase 4 — the face on the proven engine: five interactions graded, the rest static by instruction

> The phase-level walkthrough required by functional spec 004 §2.9. It makes the argument **once**; the five
> Phase 4 slice walkthroughs beside it hold the evidence, and every claim names the one that proves it.
> Nothing here needs the source code to follow.
>
> Three phases proved the engine and none of it was visible: the page a shopper landed on was twelve names
> and three buttons, deliberately. Phase 4 is the face the assignment asked for on its first page —
> *structurally close* to the supplied mockup, with exactly five interactions that must work and everything
> else on the page allowed to be static — and the join between that face and the engine, which is one line
> of code and three empty diffs. The phase's own contribution to the argument is that "structurally close,
> five interactions, the rest static" is not a description of how much was skipped but a **tested
> property**: each interaction has a RED of its own, fourteen tests assert that fourteen controls do nothing
> and were shown able to see one that does, and a browser suite buys a real key through the new page and
> leaves the database exactly as the concurrency suites expect to find it.

---

## 0. The assignment's words

`context/product/product-definition.md` §2.3 is the assignment's storefront scope, transcribed against the
design file (`HdZmqsCYuX51TxhtEba3eC`, frame `1:4` "Home V3"). It is quoted rather than paraphrased because
every "why is this static?" question in the phase is answered by one of its sentences:

> The assignment relaxes fidelity: *"structurally close to the mockup"*, not pixel-perfect, and content may
> be static.
>
> **In the build:**
>
> - **Header** — Каталог button, search field, favourites and profile icons.
> - **Catalog menu** — open/close only. Clicking Каталог opens it; a second click or a click outside
>   closes it. **Column detail may be simplified — menu accuracy is explicitly not graded.**
> - **Banner carousel** — advances automatically and/or by arrows, with active dot indicators.
> - **Services strip** — service icons (Steam, Telegram, Roblox, …) with a smooth hover highlight.
> - **Steam top-up block** — laid out per the mockup. The **$/₸/₽ toggle is clickable and changes active
>   state only — no amount recalculation.** The Steam login field is decorative. The ₽/$ mismatch visible in
>   the mockup is intentional and stays.
> - **One product row** — cards with a hover lift (shadow/outline, author's choice). Купить starts the
>   purchase flow.
>
> **Not in the build:** reviews, footer, mobile and dark variants, the remaining product rows. The order
> status page and admin panel need working views only, no design.

§1.4 lists it among the supporting metrics as *"Structural fidelity to the mockup with all five required
interactions working"*; §2.1 ranks it sixth of eight features by grading weight, below every concurrency
item; §3.2 puts on the out-of-scope list, in its own words: *currency conversion* ("the toggle switches
active state only; recalculation is explicitly not required"), *Steam login handling* ("the field is
decorative"), *a working search field* ("rendered, not wired"), *the lower page*, *mobile and dark variants;
pixel-perfect fidelity*, *design work on the status page and admin panel*, and *heavy frontend frameworks*
("plain HTML/CSS/JS is the stated preference"). The roadmap's line for the phase is the one this document
exists to answer: *"Concepts to walk away able to explain: which interactions were graded and why the rest
was deliberately left static."* And its ordering note is why this is Phase 4 and not Phase 1 — the storefront
"is the phase most safely compressed if time runs short — it is the author's strongest area and the one the
assignment relaxes".

| Graded | Waived or excluded |
|---|---|
| The five blocks in the mockup's order: header, banner, service strip, Steam block, one product row | Pixel fidelity; the mockup's font; the mockup's card art |
| **1** Banner: automatic advance and arrows, active dots | Reviews, footer, the second and third product rows |
| **2** Catalog menu: open on click, close on a second click or a click outside | Menu accuracy — column detail, hover-switching, clickable categories |
| **3** Currency control: active state changes on click | Recalculation; the mockup's «$» beside a rouble sum is kept as drawn |
| **4** Service tiles: a smooth hover highlight | — |
| **5** Product cards: a hover lift, shadow or outline or rise | The struck-through old price and the «5 %» badge on cards (the shop invents no discounts) |
| Купить starts the real purchase | A working search, favourites, profile, Steam login, «Оплатить», promo control, chips, «еще 841» |
| Working views for the order page and the operator's screen | Any design for either; mobile; dark |

The functional spec turns those into 44 acceptance criteria across ten requirements; the two that matter
most for this document are §2.8 (*"Everything decorative is honestly inert"*, four criteria) and §2.9 (this
walkthrough, four criteria).

---

## 1. What shipped

Seven slices; five carried code. Sizes are as each slice's walkthrough reported them at its close, with the
suite counts as they stood at each point.

| Slice | What | Where | Size, and the suites when it closed |
|---|---|---|---|
| 1 — The structure | The page slice (public API, composer, six `ui/` sections plus the glyph helper, four `config/` files of Russian copy); the stylesheet; the artwork; the router switched and Phase 1's catalogue page deleted; the Playwright project | `apps/web/src/pages/storefront/`, `apps/web/public/`, `apps/web/playwright.config.ts`, `apps/web/e2e/` | `storefront.css` **978 lines, 102 selectors, 0 element rules**; **29 asset files, 228 KB**; `layout.spec.ts` 6 + `inert-controls.spec.ts` 14 = **20 e2e tests in 15.5–17.4 s**; ports **5101 / 5102**; 2 screenshots |
| 2 — The banner | The carousel reducer and the single-slot countdown, the binding, Vitest in `apps/web`, the browser spec, architecture §7 rewritten | `model/carousel.ts` (177 lines), `model/countdown.ts` (94), `ui/banner.ts` (293), `apps/web/vitest.config.ts`, `e2e/banner.spec.ts` (275) | **25 + 6 unit cases** (31 in ~130–190 ms); **8 e2e tests** at 345–871 ms each; the suite **28 in 22.6 s**; 2 screenshots |
| 3 — The catalog menu | The menu reducer, one `document` listener, the header handing its button over typed | `model/menu.ts` (81 lines, 16 of them the function), `ui/catalog-menu.ts` (200, from 59), `ui/header.ts`, `e2e/catalog-menu.spec.ts` | **8 unit cases** (39 in ~146 ms); **6 e2e tests** at 350–520 ms; the suite **34 in 21.9–27.8 s**; 2 screenshots, byte-identical by design |
| 4 — Currency and hover | The radio group finished; every hover and focus rule; the reduced-motion block; a seventh token | `ui/steam-topup.ts` (131 lines), `ui/storefront.css` (a new section of the sheet headed MOTION: **15 `:hover` rules**, one media block), `e2e/currency.spec.ts` (208), `e2e/hover.spec.ts` (281) | **no unit test, by decision**; **5 + 8 e2e tests**; the suite **47 in 28.0–28.5 s**; 3 screenshots |
| 5 — Real cards and buying | `image` reinstated after three phases; the card rebuilt; five cards by a pure selection; the row wired; the one feature edit; ten pictures | `entities/product/{model,api,ui}`, `model/select-popular-products.ts`, `ui/popular-products.ts`, `features/buy-product/ui/buy-controls.ts` (**+68 / −0**), `scripts/render-card-art.ts`, `public/assets/*.png`, `e2e/products.spec.ts`, `e2e/buy-through.spec.ts` | **10 + 7 unit cases** (**5 files / 56 tests**, 207–292 ms); **5 + 3 e2e tests**; the suite **55 tests in 8 files, 38.9–40.5 s**; 10 PNGs, **102 011 B**; 2 screenshots |
| 6 — The walkthrough | This document | `docs/walkthrough/phase-4.md` | — |
| 7 — Acceptance | *In flight while this was written; its first two tasks ticked in `tasks.md` by the end.* An acceptance spec; two more layout tests (hidden Russian copy; every `/assets/` response an `image/*` content-type); an assertion that no card on the seed shows the no-picture panel (`--empty`) and a row count in the products and buy-through specs; the `@regression` convention stated once | `e2e/acceptance.spec.ts`, `e2e/layout.spec.ts`, `e2e/products.spec.ts`, `e2e/buy-through.spec.ts`, `e2e/support/orders.ts` | The tree declared **57 tests in 9 files at 13:08** and **58 at 13:20** on 14 September (the 55, plus the acceptance test and two layout tests); nothing here quotes a run of it — the counts and durations are Slice 7's to report |

Two facts about the shape that are easy to miss in the table. Nothing under `apps/api`, `packages/contracts`
or `packages/db` changed in the whole phase — `git status` shows no path under any of them. And the only
thing the phase removed was Phase 1's catalogue page: `pages/catalog/` is gone, not kept beside the new one,
because only the router imported it and `typecheck` fails loudly on any stale reference
(`phase-4-slice-1-the-structure.md` §1).

---

## 2. The words this document uses

Phase 3's glossary (`phase-3.md`, "The words this document uses") covers *guarded UPDATE*, *row lock*,
*ledger*, *the pool*, *the inbox*, *the ladder*, *RED validation* and *zero rows*; those are used here without
re-introduction. *Idempotency key* is in neither phase's glossary — Phase 2 introduces it at its Keystone 1 —
and is restated below as *purchase intent*. This phase's vocabulary is a browser's, collected in four groups.

**Layout and markup.**

- **Fluid column** — the page fills the window at any width; the content column has a maximum (1 280 px)
  and auto margins, so above the cap it is centred and below it it is the window, with rows wrapping. The
  opposite is a *fixed* column with a `min-width`, which gives a narrow window a horizontal scrollbar. The
  spec said fixed; the user reversed it mid-slice; §9's last row.
- **Inert by construction** — a control that does nothing because the markup gives it nothing to do: a
  `<button type="button">` with no handler, an `<input>` with no `<form>` around it. Distinct from *inert by
  cancellation*: a control with a default action and a listener whose one job is `preventDefault()`. The
  storefront has **zero `<a>` and zero `<form>`** elements, asserted in a browser.
- **Scope-by-selector** — a stylesheet whose every rule begins with a class the page owns, so it matches
  nothing on any other page even though it is loaded there. Distinct from *scope-by-placement*, the belief
  that a file under `pages/storefront/` applies only on the storefront; this project has no mechanism for
  the second, and a rule and a check for the first. The **leftmost compound** is the first simple-selector
  group in a selector, the position that decides whether a rule can match on a page that has none of the
  storefront's classes.
- **Bubbling** — a click is delivered to the element it landed on, then to its parent, and so on up to
  `document`; every listener on the way runs in that order. A **delegated listener** sits on an ancestor and
  handles clicks for descendants by inspecting `event.target` — it works only because of bubbling. A
  **classifying listener** is a delegated one whose whole job is to say *which kind* of click this was.
  `stopPropagation` ends bubbling at the listener that calls it; it is addressed to a direction, not to a
  listener.
- **`hidden`** — the HTML attribute and DOM property that removes an element from display *and* from the
  accessibility tree. The overlay, the inactive slides and nothing else use it.
- **Radio group** — inputs of `type="radio"` sharing a `name`, which the browser treats as one control with
  one answer: checking one unchecks the rest, the group is one Tab stop entered on the checked one, the
  arrow keys move focus and the check together. `:checked` matches the one that is on; `+` is the
  adjacent-sibling combinator, so `.currency__input:checked + .currency__option` reads "the label right
  after a checked radio". **Visually hidden** is the clip recipe that leaves a radio in the DOM, the tab
  order and the accessibility tree with no pixels; `display: none` would remove it from all three.
- **`:focus-visible`, `:focus-within`** — the first matches a focused element *when the browser judges the
  focus should be shown* (after a key press, yes; after a mouse click on a radio's label, no); the second
  matches an element that *contains* the focused one — the card, when the Купить inside it has focus.
- **Token** — a CSS custom property used in more than one place. Seven are declared on `.storefront`, not
  `:root`, so the order and admin pages have none.
- **Reduced motion** — an operating-system setting ("Reduce motion") that reaches CSS as
  `@media (prefers-reduced-motion: reduce)`. A request about *movement* — position or size changing across
  frames — not about change; §3.5 turns on that distinction.

**State and timers.**

- **Reducer** — a pure function from the current state and one event to the next state: nothing read from a
  document or a clock, nothing mutated. The banner's is `reduceCarousel(state, event) → { state, timer }`;
  the menu's is `reduceMenu(isOpen, event) → boolean`.
- **Binding** — the module that connects DOM events to a reducer and paints its answer: `ui/banner.ts` for
  the carousel, `ui/catalog-menu.ts` for the menu. Its per-event routine, `dispatch`, is reduce, paint, apply.
- **`assertNever`** — a one-line helper placed on a `switch`'s `default` whose argument type is `never`, so
  that an event added to the type without a branch fails the type check at that switch rather than at run
  time. A function with a branch for every input is called **total**.
- **Timer instruction** — the *word* the carousel reducer returns beside the state: `restart`, `cancel`, or
  `keep`. A word and not a number, so the reducer never sees milliseconds.
- **Single slot** — the countdown has exactly one variable that can hold a timeout handle; `restart` clears
  it before it sets it. "Never more than one pending timeout" is this variable.
- **Pause region** — the element whose `pointerenter` / `pointerleave` stop and start the count. It is the
  slide panel, not the whole banner, and §3.1 says why that is the difference between a criterion that can
  be observed and one that cannot.
- **Purchase intent** — Phase 2's word for what the `Idempotency-Key` on `POST /api/orders` names: "this
  shopper wants one copy of this SKU", minted once per SKU, kept in `localStorage`, reused by a second click
  and a second tab, and **forgotten only when an order for it exists**. §5 turns on the moment it is
  forgotten.
- **Stable partition** — splitting a list in two by a yes/no question, keeping each half in its original
  order, then joining them. Not a sort: nothing is reordered within a half and the input is untouched.
- **Origin** — scheme, host and port: `http://localhost:5101`. A **protocol-relative URL** starts with two
  slashes and treats what follows as a *host*; `//assets/cs2.png` asks for a machine named `assets`. §8's
  one-line resolution exists because of it.
- **SPA fallback** — the dev server's (Vite's) rule that an unknown path is answered with `index.html` and
  `200`, so a client-side route survives a refresh. §7's last harness finding is what that does to a missing image.

**Testing.**

- **Write-first RED** — a test written before the module fails on `Cannot find module`; weak but real.
  **Mutation RED** — one line the test guards is changed, the failure is watched, the line is restored.
  **Inversion RED** — a "nothing happened" assertion is pointed, unmodified, at the one control that does
  something; or a "state changed" assertion is pushed one step past its boundary. All three appear below,
  and every RED line is quoted.
- **Faked clock** — Playwright's `page.clock` replaces `Date` and `setTimeout` *inside the page* with a clock
  the test moves by hand, so a 5-second policy is exercised in milliseconds. **Virtual time** is what that
  clock says has passed; **real time** is the wall. The banner spec drives ≈55–60 s of virtual time in
  ≈3.5–3.8 s of real time.
- **Route interception** — `page.route()` hands the page's own `fetch()` to the test, which performs the
  real request itself, reads the body, and only then answers the page. The order id is in hand *before* the
  page can navigate on the response. Distinct from `page.on("response")`, a listener that sees the response
  after the page already has it — and loses a race §7 records.
- **Interpolated value** — the in-between value the browser computes on each frame of a transition.
  `getComputedStyle` returns *that*, not the target: 60 ms into a 120 ms fade a label's background is a grey
  no rule names. **Settle time** is the fixed wait past the longest duration before an end state is read.
- **The three suites** — the **web unit** suite (Vitest, the unit-test runner, in `apps/web`,
  `environment: "node"`, no jsdom, the pure models only), the **e2e** suite (Playwright, the library that
  drives a real Chromium from a test, under `apps/web/e2e/`, one Chromium, `workers: 1` — one test at a
  time — `retries: 0`, its own two servers on 5101 / 5102), and the **API** suites (Phases 1–3's, unchanged).
  The first two are this phase's; the third is the proof of the purchase path and must be green after the
  second has run.
- **The drive, the verifier, the harness** — each slice's verify task drove the real page by hand through
  the Playwright MCP, a relay that lets an agent operate one shared Chromium, with no faked clock; that run
  is **the drive**, its agent **the verifier**, and its "by eye" the verifier's reading of a screenshot. Its
  readings are quoted below, never re-run. **The harness** is the Playwright project itself — config,
  fixtures, the two servers it starts — and a *harness finding* is one about that machinery, not the product.
- **The seed** — the twelve-row catalogue loaded into the database from `packages/db/src/fixtures/catalog.ts`,
  the assignment's own list transcribed verbatim; the tests treat it as a fixed input.
- **R-numbers and assumptions** — R1 to R20 are the risk register in `technical-considerations.md` §3;
  assumptions 1 to 13 are its §5, "recorded rather than confirmed; each is one line to change".

**The cache.**

- **The back/forward cache (bfcache)** — the browser's habit of keeping a page you navigate away from *alive
  and frozen* rather than destroying it, so that Back restores it instantly *as it was left*: the same DOM,
  the same JavaScript heap, the same listeners, the same pending timers, the same `disabled` attributes.
- **Restore vs reload** — a *reload* builds a new document from scratch: scripts run from the top, every
  button starts enabled, the banner starts on slide 1. A *restore* hands back the frozen document. The
  navigation-timing entry's `navigationType: "back_forward"` says only how the shopper got there, not which
  of the two happened; `pageshow`'s `event.persisted` is `true` for a restore and `false` for a reload, and
  `pagehide` fires as the page goes in.
- **`notRestoredReasons: [{ reason: "masked" }]`** — Chrome's answer when a page was *not* cached and it
  declines to say why in a form a script can read. Any page with a **debugging session** (a CDP session)
  attached is ineligible, and every Playwright page — the MCP relay included — has one. §6 is about the
  consequence: the one path three of this phase's handlers exist for is the one path no automation can
  reach.

Russian strings that appear below, because the shop's text is Russian: «Каталог» (the menu button),
«Купить» ("buy"), «Оплатить» ("pay"), «Популярные товары» ("popular goods"), «еще 841» ("841 more"),
«Ожидает оплаты» ("awaiting payment"), «Ключ выдан» ("key issued"), «Загрузка каталога…» ("loading the
catalogue"), and the one error sentence the row can show, carried verbatim from Phase 1: «Не удалось
загрузить каталог. Проверьте соединение и обновите страницу.»

---

## 3. The five interactions

One subsection each, in the same shape: what the assignment asked, what was built, the one decision a
reviewer will press on, the RED that proved the test could fail, and the screenshot. "Crit *n*" is the *n*th
acceptance criterion of that interaction's requirement, in the order the **Asked** paragraph lists them. The
depth is in the slice walkthrough named at the end of each.

### 3.1 The banner

**Asked.** *"Banner carousel — advances automatically and/or by arrows, with active dot indicators."* The
functional spec (§2.2) takes the "and": seven criteria — advance every 5 s; wrap from the last slide to the
first; arrows move at once; the left arrow from the first slide shows the last; exactly one dot highlighted
and it names the slide after automatic and manual moves alike; a manual move starts the 5-second count over;
the pointer over the banner pauses it and leaving resumes.

**Built.** A pure reducer over `{ index, count, isPaused }` and six events (`tick`, `next`, `prev`, `dot(i)`,
`pointer-enter`, `pointer-leave`) that returns the next state *and one word* — `restart`, `cancel` or `keep`
— and a countdown with one slot whose `restart` clears before it sets. The binding in `ui/banner.ts` is
three lines per event (reduce, paint, apply the word) and one function, `applyTimer`, where a word becomes a
call, with `assertNever` on the `default` so a fourth word cannot be added without the compiler pointing at
that switch. `AUTO_ADVANCE_MS = 5000` is written once, at `banner.ts:102`, and the reducer never sees it.
Across the whole page there is one `setTimeout(`, at `model/countdown.ts:77` — re-checked while writing
this. The pause region is `.banner__panel`, the dark rectangle; the arrow cluster and the dots are its
*siblings*, positioned over its corner by the stylesheet. `pagehide` cancels the countdown; `pageshow` with
`persisted` resumes it *through the reducer*, as a `pointer-leave` (§6).

**The one decision worth defending: the reducer decides what happens to the timer; the DOM only carries it
out.** The obvious version lets the handlers decide — the arrow's handler does `clearTimeout; setTimeout`,
the panel's `pointerenter` clears, `pointerleave` sets, the tick does both — or reaches for
`setInterval(next, 5000)`. What goes wrong is that the rules interlock: a tick advances *and* re-arms; an
arrow advances *and* re-arms *unless* the pointer is on the panel, in which case it advances and leaves the
timer off; enter stops without moving; leave starts without moving. Put that in five handlers and "never more
than one pending timeout" becomes every handler remembering to clear before it sets — and the failure, two
timeouts counting so the banner jumps twice within a second of a press, looks fine on the first press (R2).
`setInterval` does not help: crit 6 needs the *phase* reset on every manual move and crit 7 needs the interval
gone while hovering, so it is cleared and re-created from three handlers anyway, plus the drift an interval
accumulates. With the reducer the invariant is three facts about three files — one instruction per event; one
slot that clears before it sets; one place a word becomes a call — and the policy is checked as a table, in
25 cases, in about four milliseconds, with no browser and no clock. A second decision sits inside the first
and is §9's third assumption: the pause region is the panel, not the banner, because a mouse press on an arrow
happens with the pointer *on the arrow*, and if the arrow were inside the region the carousel would be paused
at that instant, the reducer would answer `cancel` instead of `restart`, and crit 6 — "the count starts over
from that moment" — would be unobservable by every mouse user. The same reasoning is why there is no pause on
`focusin`: a mouse click focuses the button it pressed.

**The RED that proved its test.** Write-first: **`Cannot find module './carousel.js'`**. Against a stub
reducer that answered `keep` for everything: **22 failed / 9 passed of 31** — which is why every "unchanged,
keep" row asserts the index *and* the flag *and* the word. The two mutations the tech spec prescribes, on the
shipped code: the index-wrapping helper, `wrapIndex`, without its `+ count` normalisation — **3 failed,
every one a first → last case** (`-1 % 4` is `-1` in JavaScript; `4 % 4` was always `0`, so last → first
stayed green: a carousel that breaks on exactly one gesture, the left arrow from slide 1, which is the
gesture a manual check never makes); without the modulo at all — **6 failed**. The countdown without its
`clearTimeout`: **2 failed**, `expected "vi.fn()" to be called 1 times, but got 2 times` — "restart
twice → fires once" is the test an interval could never pass. In the browser, pushing a "state changed"
assertion past its boundary: crit 6 with its clock advance of 4 000 ms (`runFor(4000)`) changed to 5 000
while keeping "still 2" → **`Expected: 2 Received: 3`**; crit 7 asserting "advanced" while still
hovering → **`Expected: 2 Received: 1`**. And one RED the harness produced by itself, which became a
rule: under a bare `page.clock.install()` the 4 999 ms boundary test reported
**`Expected: 1 Received: 2`** — slide 2 already showing one millisecond short — because an installed clock
keeps pace with the wall until it is paused (§7). One real-time observation sits beside the faked clock so
the suite is not the only witness: dot **1 → 2 inside a 5 207 ms window** on the wall.

**Screenshot.** `-banner-next.png` (a fresh load and one press of the right arrow) and `-banner-auto.png` (a
fresh load and 5.2 seconds of doing nothing). Both show «Ключи для игр», slide 2, with the second dot as the
wide pill; the files differ, the view does not — which is crit 5 in a picture and also why a reader cannot
tell them apart (§10).

*Depth: `phase-4-slice-2-the-banner.md` §3.1–§3.3 (the three decisions), §4 (both layers and the real-time
observation), §5.1 (the quiet half-failure).*

### 3.2 The catalog menu

**Asked.** *"Open/close only. Clicking Каталог opens it; a second click or a click outside closes it.
Column detail may be simplified — menu accuracy is explicitly not graded."* The functional spec (§2.3) adds
three criteria — Escape closes; a click on any category or item *inside* the overlay changes nothing (crit 5);
open and close several times behaves the same — and says in prose that the overlay's shape is the mockup's
(five categories left, the first highlighted; Steam, PlayStation, Xbox, Nintendo, Battle.net and Подборки
right), as static text.

**Built.** `reduceMenu(isOpen, event) → boolean` over four words — `Toggle`, `OutsideClick`, `InsideClick`,
`Escape` — sixteen lines, total (every event has a branch) by `assertNever`. One `click` listener on
`document` and **none on the button** (it was at line 165 when Slice 3 wrote; line 170 in the tree today,
still the only one). It first checks that the click landed on an element at all
(`event.target instanceof Element`) and then asks one question in three branches:
`catalogButton.contains(target)` → `Toggle`; `overlay.contains(target)` → `InsideClick`; otherwise →
`OutsideClick`. The boolean that comes back is painted as the overlay's `hidden` (`overlay.hidden = !next`)
and the button's `aria-expanded` (`String(next)`), the attribute that tells assistive technology whether the
menu is open. A `document` `keydown` listener acts on Escape only while open, calls neither
`preventDefault` nor `stopPropagation`, and returns focus to Каталог. A `pageshow` listener forces the
overlay closed on a persisted restore. Inside the overlay: five `<button type="button">` categories with no
listener and six columns of `<li>` text; there is no `<a>` anywhere on the storefront and no
call to `stopPropagation` anywhere in `apps/web/src` (the word appears only in comments saying so). The
header hands the button over by reference in a typed
`Header` interface rather than the menu finding it by `querySelector`.

**The one decision worth defending: one classifying listener on `document`, none on the button.** The
obvious version is two listeners — one on the button that opens, one on `document` that closes while open —
because it reads like the spec's two sentences. Walk the opening click: the shopper clicks the word
«Каталог»; the event bubbles span → button → header → … → `document`; the button's listener runs and opens;
the event keeps going, reaches `document`, and the closer runs: menu open, this is a click, close it. Both in
the same task, with no paint between, so the shopper sees nothing. The menu never opens. That is R3, and it
is not a race — it is the order events are defined to arrive in. The two usual patches were both rejected.
`stopPropagation()` in the button's handler (and, for crit 5, on the overlay too) is not addressed to the
closer; it hides the event from everything above, and this page has two listeners whose contract is to be
above and see everything: `enableBuyControls`, delegated on the product row for buttons that arrive with the
catalogue, and the menu's own, which needs the Купить click to reach `document` because *that click is the
outside click that closes the overlay* before `location.assign` — the navigation to the order page —
runs. Registering the closer on a `setTimeout(0)` from inside the open handler works and is a bet that
bubbling finishes before a timer fires. With one listener, the opening click *cannot* also be an outside
click — not because a flag was set, but because nothing gets to look at it twice. And "inner clicks are
inert" is written down twice, neither as a handler that swallows anything: once in the markup (nothing
inside has a default) and once as the branch `InsideClick → return isOpen`, which a type checker keeps
total and a unit test keeps true. The shortest implementation that passes every *other* check — close on
any click while open — fails exactly the criterion the assignment grades, and a tester who clicks inside
and sees the menu close may not register it as wrong, because that is what a dropdown does.

**The RED that proved its test.** Write-first: **`Cannot find module './menu.js'`**. The mutation the tech
spec prescribes, `InsideClick` returning `false`: **1 failed** — *"on an open menu stays open"*, and only
that; the brief had predicted two, and the closed case cannot fall under that mutation because it expects
`false` and the mutant returns `false` — a mutation proves only the tests that can see it, and "this case can
fail" has to be shown per case. The mutation the second case exists for, `InsideClick` treated as a `Toggle`
(`return !isOpen`): **2 failed**. In the browser, both for crit 5 because it is the "nothing happened"
assertion most likely to pass vacuously: assert `hidden: true` after an inside click →
**`Expected: true Received: false`**; assert the URL *changed* after an item click →
**`Expected: not "http://localhost:5101/"`**.

**Screenshot.** `-menu-open.png` and `-menu-inner-click.png` are byte-identical — `cmp` is silent, both hash
to `cabdb9d0…` — which is what "an inner click changes nothing visible" looks like as a file; the crit-5 test
and the drive's log are what establish that a click happened between the two captures. Read while writing
this: five categories on the left with «Игры и игровые сервисы» highlighted, six column headings on the
right, «Подборки» wrapped to a second row under Steam where the mockup draws six across — the overlay's
columns wrap to fit the width (`auto-fit`), and menu accuracy is not graded.

*Depth: `phase-4-slice-3-the-catalog-menu.md` §3.1–§3.2, §4 (the three layers and the accessibility-tree
snapshots), §5.1 (why clicking the search box is itself an outside click), §5.2 (the mispredicted RED).*

### 3.3 The currency control

**Asked.** *"The $/₸/₽ toggle is clickable and changes active state only — no amount recalculation. … The
₽/$ mismatch visible in the mockup is intentional and stays."* The functional spec (§2.4): «$» active on
load; clicking «₸» makes it active and «$» not, then «₽»; clicking the active one changes nothing; the sum
beside it never changes.

**Built.** Three `<input type="radio" name="currency">` — ids `currency-usd`, `currency-kzt`,
`currency-rub`, values `$`, `₸`, `₽`, «$» carrying `checked` — each followed by a `<label for>` that is the
36-px square the shopper sees, inside `<fieldset class="currency" role="radiogroup" aria-label="Валюта">`.
The radio is hidden by the clip recipe, not `display: none`. The stylesheet paints
`.currency__input:checked + .currency__option` ink on white and
`.currency__input:focus-visible + .currency__option` with a 2-px outline. That is the whole of the control:
`grep -n 'addEventListener\|\.checked\|"change"\|querySelector' ui/steam-topup.ts` returns nothing — re-run
while writing this, exit 1. «Сумма / 500 ₽» is a `<span>` of static text and reads `500 ₽` before and after
every click.

**The one decision worth defending: the active state is the browser's own radio group, and no script
touches it.** A reviewer opening `steam-topup.ts` looking for the handler finds a comment telling them why
there is none, and the tech spec surfaces this as assumption 4 rather than leaving it to be discovered. The
obvious version is three `<button role="radio" aria-checked>` and a click handler that sets one true and the
others false. To be a correct radio group and not a row of buttons that looks like one, that version has to
rebuild six things the native group gives by construction, each a thing hand-rolled versions get wrong:
exactly one active (two copies of one bit — class and attribute — that a handler must keep in step);
one Tab stop for the group (a roving `tabindex` rewritten on every change, and forgotten after a change lands
Tab on the button that *was* active); arrow keys (four keys, wrapping both ways, moving focus *and* state,
swapping under RTL — Up/Down and the wrap are the usual omissions); `aria-checked` (a third copy of the bit);
entering the group on the checked one from either side (Shift+Tab is the direction that gets missed); and
form semantics with `:checked` for the stylesheet. After all that scaffolding the handler's own logic is "set
this one true, the others false". The spec's fourth criterion — *nothing else changes* — is also easier to
keep with nothing running. On "isn't that cheating": the assignment grades that the control *changes active
state*, and it does — by click, by keyboard, with a visible active square; it was never asked to recalculate,
and a control that pretended to convert would be inventing prices, which the product definition forbids for
the same reason it forbids the struck-through old price. A radio group is not a way around the interaction;
it is the interaction, named by its standard name. The drive saw it: from a focused «$», ArrowRight moved the
check to ₸ with no script; Shift+Tab back from «Оплатить» landed on the *checked* radio with the ring on its
label only; a mouse click on a label drew no ring, because mouse focus does not match `:focus-visible`.

**The RED that proved its test.** There is no unit test, by decision — tech spec §4.1: *"native radios,
nothing to compute"*; a unit test here would test the DOM call that builds the markup (`createElement`)
and the browser's radio implementation, and the second is what the browser layer is for. In the browser:
assert «$» still checked after clicking ₸ →
**`Expected: "currency-usd" Received: "currency-kzt"`**. And a RED the harness produced by itself, the third
of its kind this phase (§7): the first version of crit 2 read each label's background *immediately* after the
click and found **`rgb(137, 137, 139)`** and `rgb(122, 122, 124)` — greys about halfway between the ground
(242) and the ink (17), values no rule in the sheet names. The radio had flipped instantly; the label's
120 ms fade was in flight; the read landed on a frame. The fix is `CURRENCY_SETTLE_MS = 200`, and the file's
header records the two mid-values so the next reader does not "tighten" the wait away.

**Screenshot.** `-currency-kzt.png`: ₸ as the dark square between a light «$» and «₽», the login field
empty, «Сумма 500 ₽», «Оплатить 500$» — the mockup's mismatch, kept.

*Depth: `phase-4-slice-4-currency-and-hover.md` §3.1 (the six things), §4 (the spec), §5.1 (the settle-time
trap), §5.2 (`:focus-visible` and the mouse).*

### 3.4 Service tiles on hover

**Asked.** *"Service icons (Steam, Telegram, Roblox, …) with a smooth hover highlight."* The functional spec
(§2.5): any tile including «еще 841» visibly highlights and the highlight *fades in rather than switching on
instantly*; leaving fades it out; moving along the strip highlights only the tile under the pointer; reaching
a tile with the keyboard shows the same highlight.

**Built.** Eleven `<button type="button">` tiles — buttons so the keyboard reaches them — each an
`<img alt="">` brand tile with its caption as visible text beside it; «еще 841» is the eleventh with the
same markup. `.service-tile { transition: background-color 160ms, box-shadow 160ms }`, and one rule for
`:hover, :focus-visible` that sets a light rounded backdrop and a shadow. No `outline: none` — the
declaration that erases the keyboard's focus ring — anywhere in the sheet.

**The one decision worth defending: "smooth" is not a thing a test can watch, so it was made into two things
a test can read.** R14 wrote the rule before the slice began: assert the static `transition-duration > 0` —
a CSS property that does not change while the transition it describes runs, so it is safe to read at any
moment — and the two end states either side of it, after a fixed wait past the longest duration; never a
value in between. The one liberty taken with R14's letter is that the specs use a fixed `SETTLE_MS = 250`
rather than waiting for `transitionend`, because the "nothing changed" assertions — only one tile
highlighted, the re-click on the currency control — are exactly the cases where a transition never *starts*
and `transitionend` never fires; a fixed wait reaches the same end state on both branches. Its cost is stated:
about 250 ms per read, and a future duration above 250 ms would silently turn every read into a mid-value
again, which is why both spec headers name the durations they wait past. The second half of the decision
belongs to the reduced-motion setting and is §3.5's, but its consequence for the tiles is worth one sentence
here: under `prefers-reduced-motion: reduce` the tiles are untouched, because they never move — a colour
going from transparent to grey moves nothing.

**The RED that proved its test.** Assert the *unhovered* Steam tile carries the hover background — crit 3's
"which index is highlighted" pointed at 0 instead of 1 → **`Expected: 0 Received: 1`**. This is the one RED
recorded for `hover.spec.ts`'s eight tests; the card tests in the same file went green with it, and no
card-specific inversion was recorded (§10). The fade *as seen* is proven by no layer; the verifier's by-eye
reading of the screenshot is the closest: *"visibly carries a light rounded-rectangle backdrop with a soft
shadow"*.

**Screenshot.** `-tile-hover.png`: the Steam tile on a grey rounded backdrop with a shadow, the other ten
flat.

*Depth: `phase-4-slice-4-currency-and-hover.md` §4 (R14 as a method), §5.1, §5.2 (why the spec presses real
Tabs to reach a tile).*

### 3.5 Product cards on hover

**Asked.** *"Cards with a hover lift (shadow/outline, author's choice)."* The functional spec (§2.6 crits
2–3): a card *visibly lifts — a raised shadow, an outline, or a rise — and the change animates rather than
switching instantly*; leaving settles it back.

**Built.** `.product-card { transition: transform 180ms ease, box-shadow 180ms ease }`; `:hover` and
`:focus-within` share one rule: `translateY(-4px)` and a seventh token,
`--sf-shadow-lift: 0 16px 40px rgba(0, 0, 0, 0.18)`. `:focus-within` and not `:focus-visible` because the
card is never focused — the Купить inside it is — so a keyboard user who Tabs onto Купить lifts the card they
are about to press. The last block in the sheet, on purpose, is:

```css
@media (prefers-reduced-motion: reduce) {
  .product-card:hover,
  .product-card:focus-within {
    transform: none;
  }
}
```

One declaration on the same two selectors, and nothing else — `transition` is left alone, so under the
setting a hovered card still gains the lifted shadow and the shadow still fades in over 180 ms; there is
simply no transform change to interpolate. Last in the file because a media query adds no specificity, so
source order decides the tie — the cascade lesson Slice 1 learned when a leftover rule in the older sheet won
a tie and thinned the Купить pill (`phase-4-slice-1-the-structure.md` §6.1), applied.

**The one decision worth defending: reduced motion drops the transform and keeps the fade.** Two obvious
alternatives, opposite in direction. The boilerplate —
`@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important } }` — is a
`*` rule, the one selector R4 forbids: the sheet is in the bundle on `/order/:id` and `/admin/recovery`, and
a `*` rule reaches both. It also removes the thing crit 1 of §2.5 grades — for the reviewer with the setting
on, the highlight would "switch on instantly", which is R11 word for word. And it is the wrong reading of the
setting: reduced motion is a request about *movement* — position or size changing across frames — because
that is what makes some people ill; a shadow deepening moves nothing, and the usual guidance is to replace a
movement with a fade, not to remove fades. Doing nothing goes wrong the other way: the 4-px rise is movement,
on every card the pointer crosses, and a shopper who asked the system for less of it would watch this page
ignore the request. The criteria still hold with the transform gone because §2.6 crit 2 lists "a raised
shadow" as one of its own three answers. The audit behind "only the card": on hover, tiles change background
and shadow; chips and buttons change background; the currency label changes background and colour; the card
changes transform and shadow. One `transform` on the page, so one declaration in the block.

**The RED that proved its test.** Shared with §3.4 — **`Expected: 0 Received: 1`** is the file's one recorded
RED. The reduced-motion test itself reads end states: switch the setting on from the test
(`emulateMedia({ reducedMotion: "reduce" })`), hover a card, read `transform: none` and `box-shadow:
rgba(0, 0, 0, 0.18) 0px 16px 40px 0px`; hover a tile, read
the tint and a shadow. The drive read a hovered card at `transform: matrix(1, 0, 0, 1, 0, -4)` settling to
`none`, and the verifier's by-eye: *"a distinct white rounded-corner panel with a visible drop shadow …
floating above the page"*.

**Screenshot.** `-card-hover.png`: «Пополнение Steam 500 ₽» risen on a shadow above rows that are otherwise
flat — and those rows are **Phase 1's**, twelve of them with a border-top and no radius, because the capture
was taken before Slice 5's rebuild; what reads as rounded corners is the 40-px blur of the lift shadow.
The lift is on the `<li>` and survived the rebuild unchanged; the capture did not (§10).

*Depth: `phase-4-slice-4-currency-and-hover.md` §3.2 (reduced motion), §4, §5.3 (the two hover shades kept
as literals), §5.4.*

---

## 4. What was left static, and why that is the instruction

Functional spec §2.8 names the controls the mockup draws and the assignment leaves unwired: *the search
field, the favourites and profile icons, the promo-code control, the Steam login field, the «Оплатить»
button, the category chips, and the «еще 841» tile.* Its scope line for them (§3) is *"visibly present and
quietly inert"*, and its four criteria are that a shopper who tries one is neither sent anywhere, nor charged,
nor shown an error, nor promised anything — *"no spinner, no 'coming soon', no message"*.

**Why static is the instruction and not the shortcut.** Each of these controls, wired, would mean inventing
something the shop does not have. Wiring the search means inventing what it searches. Wiring «Оплатить»
means inventing a Steam top-up the shop does not sell — the block is a picture of the mockup's, and the
product row already shows two of the catalogue's three Steam top-ups as display-only cards.
Recalculating on the currency control is explicitly
waived, and the mockup's own «$» beside «500 ₽» stays as drawn. Hover-switching the menu's columns means
inventing per-category content; the overlay's text is the mockup's, verbatim from Figma node `1:1193`,
including «Скидки 90%», which is there because the mockup writes it, as an `<li>` nobody can click. The
struck-through "old price" and the «5 %» badge on the mockup's cards are omitted because the shop shows one
real price per item and invents no discounts (functional spec §3); the «5 %» on the Steam block is kept as
static text because it is the mockup's. And a *half*-wired control is worse than an inert one: a spinner
that spins on nothing, a "coming soon", a message — each is a promise, and a promise the page cannot keep is
the "broken control" the storefront must never show. The line the spec draws is between *feedback* and
*result*: every inert control has `cursor: pointer` and, from Slice 4, a 120 ms hover shade, so it looks like
what it is — a button — because a `disabled` attribute or a default cursor would read as broken; what is
forbidden is anything that implies a result.

**How the page is inert: by what it is made of, not by what it cancels.** The search is
`<div role="search">` around a bare `<input type="search">` and two `<button type="button">`s. The Steam
block is a `<section>`, not a `<form>`: a bare login `<input>`, «Сумма / 500 ₽» as static text, the «i» as
an `aria-hidden` glyph, «Оплатить 500$» and «Ввести промокод» as `<button type="button">` with no handler.
The chips are buttons with «Донат» carrying a class only — no `aria-pressed`, which would claim toggling
works. Across the whole page, **0 `<a>` and 0 `<form>`**, asserted in a browser
(`document.querySelectorAll("a, form").length === 0`). The obvious alternative — a `<form>` with a `submit`
listener that calls `preventDefault()`, `<a href="#">` with a cancelling click handler — is a control
pretending to be wired, and it holds exactly as long as the listener does: lose it (a rebuilt header, a
handler bound before the element exists, an exception earlier in the same handler) and the browser does
what forms do — navigates to `/?q=…`, a full load, the banner back on slide 1, the shopper's text in the
address bar. With no `<form>` there is no default action to lose; Enter in a bare input is a keystroke. The
same fact is what makes the menu's inner clicks inert before any listener exists (§3.2).

**The fourteen inert tests, and how "nothing happened" was shown able to fail.** One function,
`assertInert(page, act)`, and fourteen callers: type «тест» and press Enter in the search field; click the
heart, the search button, the profile button, the promo control; click each of the seven chips; click
«еще 841»; type a login and click «Оплатить». It arms every listener *before* the action —
`page.on("request")` filtered to document requests and `POST /api/orders`, `page.on("pageerror")` — records
the URL and every visible text node matching `/скоро|coming soon|загруз/iu`, runs the action, waits a bounded
500 ms (there is no signal to wait *for* when the expected outcome is nothing), and asserts six absences: no
document request, no `POST /api/orders`, URL unchanged, no page error, no `[aria-busy="true"]` (the
attribute a spinner would set), no *new*
promise-shaped sentence. "Nothing happened" is the assertion most likely to pass vacuously — a listener
attached after the click, a filter that matches nothing, and every test is green forever — so the RED was not
write-first. The identical function, unmodified, was pointed at the one control on the page that *does*
something, the first «Купить», and failed on three lines:

```
a document (navigation) request was issued: …/order/ord_01M2DT7ZJNG6QT805ZYPV30HNZ
a POST /api/orders request was issued
the URL changed from http://localhost:5101/
```

A navigation, a purchase, a moved address bar — the three things the detector exists to see — and that is
what makes the fourteen green rows a statement rather than a silence. So "static" here is a tested property:
fourteen tests assert that fourteen controls do nothing, and the assertion was shown able to see a control
that does something.

*Depth: `phase-4-slice-1-the-structure.md` §3.2 (inert by construction), §5 (the two specs and their REDs),
§7 (the first interview question); `phase-4-slice-4-currency-and-hover.md` §6 (why inert controls still have
hover states).*

---

## 5. How the face joins the engine

**One line.** `enableBuyControls(region)` — the buy feature's one entry point — in `ui/popular-products.ts`,
called once when the section is built, before the catalogue has arrived, handed the region rather than
the buttons because the buttons arrive with the catalogue. Everything else is the card keeping a
contract: `renderProductCard` puts the buy control on a purchasable card as
`<button class="product-card__buy" type="button" data-sku="KEY-CS2-PRIME">Купить</button>`, directly
inside the card's body element (`__body`), the only `button` inside the card carrying `data-sku` — which is
precisely what the feature's delegated listener matches (`button[data-sku]`), disables, and, on failure,
inserts a `<p>` after and finds again through `button.parentElement`. From the click onward the path is
Phases 1–3's byte for byte: the feature's click handler, `buy()`, sets `disabled` synchronously, sends
the order request with the stored-or-minted key (`createOrder(sku, purchaseIntentKey(sku))`), forgets
the key on success, and `location.assign`s to `/order/<id>`; the order page polls to the key; the
operator's screen, the supplier stubs, the inbox, the ladder are untouched. The functional spec's scope
line is *"where the shopper starts, not what happens after"*, and Slice 5 took it literally.

**Three empty diffs.** `apps/api`, `packages/contracts`, `packages/db` — `git status` shows no path under
any of them, re-checked while writing this. Also empty: `pages/order`, `features/simulate-payment`,
`lib/purchase-intent.ts`, `apps/api/test/**`. The feature's diff is **68 insertions, 0 deletions, one file**
(`git diff --numstat HEAD -- apps/web/src/features/buy-product/`, re-run today), 56 of them comment and 12
code, all of them the handler below. The reviewer's likely question — *what did you have to change on the
purchase path to make the design work?* — has the answer "nothing", and the evidence is those diffs plus a
green `pnpm test` after the browser had bought three real orders and one real key through the new page (§7).
The obvious alternatives — a click handler of the storefront's own, or creating the order from the order page
with the SKU in the URL — each put a second place in the code that decides what an `Idempotency-Key` names,
and each would make Phases 1–3's suites the proof of a path no shopper uses any more.

**The double-click still makes one order, for the same two reasons in the same order.** First,
`button.disabled = true` runs synchronously in the first click's handler, so the second click of a
double-click lands on a disabled button and dispatches no event — the e2e counts **one** `POST /api/orders`
after `dblclick`. Second, if a second request did get out (two tabs, a reload mid-flight), it would carry the
*same* key, because the key names the intent and is read from storage rather than minted per click, and the
unique index on `orders.client_request_id` (the column that stores the key) would hand back the same
order. The page provides the first; the database provides the second; the storefront added neither and
removed neither.

**The one feature edit.** At the end of `enableBuyControls`, after the click listener that has been there
since Phase 1: a `window` `pageshow` listener that returns unless `event.persisted`, and otherwise clears
`disabled` on every `button[data-sku]:disabled` in the container. The sequence, compressed, because the
correctness of the edit is the correctness of the whole chain:

1. Купить on CS2 → the delegated listener calls `buy(button, "KEY-CS2-PRIME")`.
2. `disabled = true`, synchronously — a second click in the next few hundred milliseconds dispatches nothing.
3. `purchaseIntentKey` finds nothing in storage, mints a UUID, stores it, sends it as `Idempotency-Key`.
4. The order id arrives; `forgetPurchaseIntent(sku)` removes the key — the one moment an order for this intent is known to exist.
5. `location.assign("/order/ord_…")` with the button **still disabled**, deliberately: a live button during the navigation, after step 4, would be a second copy from an impatient click.
6. *With the cache:* the document is frozen — DOM, heap, listeners, the `disabled` attribute — and set aside. The shopper reads the order page (the drive read the stored keys there as `intentKeysRemainingInStorage: []`) and presses Back.
7. `pageshow` fires on the thawed document with `persisted: true`; the handler clears the one disabled Купить; the banner restarts its clock and the menu forces itself closed in the same moment (§6).
8. Купить again → storage is empty (step 4) → a **new** UUID → a **new** order. The shopper arrives at a second order page for a second copy.

Step 8 looks like the thing Phase 2 exists to prevent and is not: Phase 2 prevents *one decision* producing
two orders; this is *two decisions* producing two orders, which is spec 002 §2.1's fifth criterion in its own
words — *"Given a shopper has already bought an item and wants another one, when they start a fresh purchase
of the same item from the shop page, then they get a separate second order with its own key."* The three
fixes that look simpler are each wrong on one half: never disabling (two requests per double-click); re-enabling
before the navigation (a second copy from the same decision); re-enabling but keeping the old key, or rotating
it on restore instead of on success (the second press returns the *first* order, and the shop can sell each
game to each shopper exactly once, forever — Phase 2's "too late" failure reached by the back button). The
re-enable is only correct *because* the key is already gone; the two facts are one design, and the feature's
header states them together. It is a feature edit and not a page one because the feature set the state and
the feature un-sets it; the page knows about the region and nothing about `disabled`.

**What was driven.** The whole road once, through the real page: Купить on the CS2 card →
`/order/ord_01M2FR6QK83N46JVKE6STQJA6M`, «CS2 Prime Status ключ», «1290 ₽», «Ожидает оплаты»; the success
control → «Ключ выдан» in about 2.4 s with a key on the page. **97 of 97** requests answered `200` on the
landing; five `<img>` in the row, each decoded at its full width (`naturalWidth: 456`). With the API
process killed, the header, banner (still advancing), tiles, Steam block and Каталог all worked and the
row showed the Phase 1 sentence verbatim. The two screenshots — `-buy-through-awaiting-payment.png` and
`-buy-through-delivered.png` — are the order page for that order before and after payment, and they are
visibly the Phase 3 order page, because they are the Phase 3 order page: same fields, same type, «Ключ —
LFXC-TNCS-BPCD» inserted above the order number, no storefront rule reaching it (R4).

*Depth: `phase-4-slice-5-real-cards-and-buying.md` §3.1 (what did not change, enumerated), §3.3 (the
sequence and the three wrong fixes), §6 (the first two interview questions); the intent key's own argument is
`phase-2-slice-1-one-order-per-intent.md` §3, §5.*

---

## 6. The back/forward cache

**What it does to a page that stopped its own timer.** A cached page is frozen with whatever timeouts it
had pending, and on restore those timeouts resume with whatever remainder they had. A shopper who left 4.8 s
into a slide comes back to a banner that jumps **200 ms** after the page reappears — or at once, if the
deadline elapsed while the page was frozen — and then settles into its rhythm from that arbitrary moment.
Nothing is broken; the banner is simply not doing what crit 1 says, for one beat, in a way nobody could
reproduce on demand. So `pagehide` cancels the countdown and the page goes into the cache with nothing
pending. But now the restored page has a banner and no clock — R1, "banner dead after back", the failure
the handler pair exists to prevent. Without the cache this cannot happen: Back is a full reload, `mountApp`
(the app's bootstrap) runs again, slide 1 shows with a fresh count. With the cache, nothing runs again
unless something listens.

**The three handlers.** In `ui/banner.ts`: `pagehide → countdown.cancel()`, the only call to the countdown
outside `applyTimer`; `pageshow` with `persisted` → `resume()`, the restart-on-restore routine, which is
*not* a bare
`countdown.restart` but `dispatch({ type: "pointer-leave" })` — one ordinary event through the binding, the
same call that starts the clock the first time — because the
state may still say `isPaused: true` from a pointer that was on the panel when the shopper left, and a tick
into a paused reducer answers `keep`: no move, no re-arm, a dead banner until the pointer happens to cross
the edge. In `ui/catalog-menu.ts`: `pageshow` with `persisted` → the overlay forced closed, belt and braces,
since the Купить click is itself an outside click and closes it before the navigation. In
`features/buy-product/ui/buy-controls.ts`: `pageshow` with `persisted` → the re-enable of §5.

**Three measurements, one answer.** Every automated attempt to reach the cached path gave the same result:

| Attempt | Method | Result |
|---|---|---|
| Slice 2's verify | `chromium.launch({ ignoreDefaultArgs: ["--disable-back-forward-cache"] })` — the flag Playwright adds by default removed — against `vite preview` (the built app served, not the dev server) on 5101; navigate away; `goBack()` | **`pageshow.persisted: false`**; the navigation entry's **`notRestoredReasons.reasons: [{ reason: "masked" }]`** |
| Slice 5's `buy-through.spec.ts`, crit 4 | The normal harness: buy, `goBack()` | `navigationType: "back_forward"`, all three Купить enabled — **a reload**, not a restore; the test's own comment says it proves the reload path and cannot prove the other |
| Slice 5's verify | The bfcache script a third time, against the buy flow | **`persisted: false`**, **`masked`** again; one `pageshow` entry in the window's log, where a restore would have left two in the same `window` |

What it is *not* is a code-level blocker: a grep over `apps/web/src` for the usual disqualifiers — an
`unload` or `beforeunload` listener, an open `WebSocket` or `EventSource`
(`grep -rn "beforeunload\|unload\|WebSocket\|EventSource"`) — finds three prose mentions in comments and
no listener; the preview server answers `Cache-Control: no-cache`, not `no-store`, and only `no-store`
disqualifies. What it *is*, by Chromium's own documentation: a page with a debugging session attached is
not eligible, and every Playwright page — the MCP relay included — has one. That is why the tech spec's
sentence "Playwright disables bfcache" is true but understated: removing the flag does not restore
eligibility, because the session itself is the disqualifier. R1 now records the measurement rather than
the assumption.

**What automation could do, and did.** Dispatch the events from script. On the real page, with no clock
installed: a synthetic `pageshow { persisted: true }` at T+3 s replaced the tick that was due at T+5 — still
at T+5.5, advanced at T+8.5, a fresh five seconds from the restore rather than the two remaining; `pagehide`
then **6 003 ms** with no advance; `pageshow` while hovering — resumed; `pageshow { persisted: false }` —
ignored, which is right, because a fresh load has already called `resume()` at build. For the feature: a
hand-disabled button plus a synthetic `pageshow { persisted: true }` → enabled; the same with
`persisted: false` → unchanged; two disabled of three → both re-enabled, the third untouched. The handlers do
the right thing *when the events arrive*; that the browser delivers them on this page is the one thing no
test in the repository can show.

**The manual verdicts — outstanding.** The task text for this document asks for both manual Chrome
verdicts to be quoted. **There are none to quote.** The check needs a real Chrome with no automation attached,
and an agent could not drive one on this machine; the user has been asked to do it. Until the two lines below
are filled in, this document and the Slice 2 and Slice 5 walkthroughs all carry "not proven either way" for
the cached path — the reload path is proven by every Playwright `goBack()`.

> **PLACEHOLDER — to be filled in by the user after the one-minute check.**
>
> 1. `pnpm --filter @game-shop/web run build`, then `pnpm --filter @game-shop/web run preview` (the API on
>    its usual port so the catalogue loads).
> 2. Open the storefront in Chrome. DevTools → **Application** → **Back/forward cache** → **Test
>    back/forward cache**. Chrome navigates away and back by itself and reports either *"Successfully served
>    from back/forward cache"* or the list of reasons it was not. **Record the verdict verbatim here:**
>    `__________________________________________`
> 3. If eligible: note which dot is current; press Купить on a card; on the order page press Back.
>    - **Banner (Slice 2's claim):** the dot advances within 5 s of the page reappearing — yes / no:
>      `______`
>    - **Купить (Slice 5's claim):** the button is enabled, and a second press creates a *second* order at a
>      different `ord_…` — yes / no: `______`
>
> Both claims are covered by the one Back. If the verdict is "not eligible", the listed reason belongs here
> too, and the three handlers are then correct code for a path this page never takes in this browser.

*Depth: `phase-4-slice-2-the-banner.md` §3.3 (the three ways to get it wrong), §4.3 (the synthetic events),
§5.4 (the verdict and the greps); `phase-4-slice-5-real-cards-and-buying.md` §5.4 (the third
`persisted: false`).*

---

## 7. Testing: two layers, and what each cannot prove

**The trigger.** Architecture §7 had said, since Phase 1, that there would be no browser tests until "a
conditional in the rendering path derives a fact rather than mirroring one", and named Phase 4 as the place
to revisit it. Phase 4 met the trigger four times over — wrap arithmetic, a timer policy, a menu state rule,
a five-from-N row selection — and the answer was two layers, not one: Vitest for the pure models the DOM
calls, and, by the user's decision, a real Playwright project a reviewer can run. The §7 bullet has been
rewritten to say so (its counts are already behind — §10). `apps/web` had no test runner for three phases,
on purpose; it now has two, and neither is chained where the other belongs: `pnpm test` runs the API suites
and then the web unit suite; `pnpm test:e2e` is a separate command because it needs a browser and starts
servers, and a reviewer who runs `pnpm test` should not get a 276 MB Chromium download.

| Layer | Runs | Can prove | Cannot prove | RED method |
|---|---|---|---|---|
| **Web unit** — Vitest in `apps/web`, `environment: "node"`, no jsdom, `src/**/*.test.ts` | **5 files / 56 tests** — 238 ms when run for this document; 207–292 ms in the slices | The policy table row by row; "restart twice → fires once"; the menu rule including `InsideClick → unchanged`; the catalogue parser's rejection of `42` and of a *missing* key; the partition and its stability | Anything that needs a document: that the binding forwards the word, that a real `setTimeout` reaches the real reducer at the real interval, `:checked`, a fade, a click landing anywhere | Write-first, then a mutation of the one line each test guards; every RED line quoted in §3 |
| **e2e** — Playwright under `apps/web/e2e/`, one Chromium project, `workers: 1`, `retries: 0`, its own servers on 5101 / 5102 | **55 tests / 8 files in 38.9–40.5 s** at Slice 5's verify; the tree at 13:20 today declares 58 in 9 files, Slice 7 still extending it | The five interactions in a browser, under a clock the test moves; fourteen inert controls; five real cards from the live endpoint with Купить on exactly the three purchasable; the buy-through to the key on the real clock; one `POST` after `dblclick`; Back as a reload with the overlay hidden and the dot advancing | The cached restore (§6); the fade *as seen*; delivery *correctness* — that one intent is one order and one payment one key is enforced and proven at the API boundary; a missing picture under the dev server — closed by Slice 7's content-type guard and no-`--empty` assertion (the last row of the findings table); "one order exists" as a `count(*)` — asserted from captured ids since Slice 7, one step short | Weaken nothing in `src/`: point every "nothing happened" assertion at Купить; push every "state changed" assertion past its boundary or assert the pre-state |
| **API** — Phases 1–3's suites, unchanged | **11 files / 90 tests** | One intent is one order; one payment is one key; a supplier's silence is never a second key; recovery | Anything about the page | Phases 1–3's own |
| **By eye** — the verifier's eleven screenshots | — | *"visibly highlights"*, *"visibly lifts"*; the order and admin pages pixel-identical to their `003-*` captures | Nothing repeatable; nothing a second person can re-run | — |
| **Manual** — a real Chrome, no automation | outstanding (§6) | The cached path: the banner advancing within 5 s after Back; Купить enabled and a second press a second order | — | — |

**R13 — the chain that makes the whole set trustworthy.** The API suites assert `orders = 0` and
`unclaimed = 50` *before* they run; that baseline is the mechanism behind every concurrency proof in Phases
1–3, and it is a statement about one global fact in one database. The e2e is the first suite that presses
Купить for real — three orders and one claimed key per run at Slice 5's verify (four and two once Slice 7's acceptance walk landed) — so every order id is captured by route
interception before any assertion, and `afterEach` runs the same six statements the API harness's
`cleanupTestOrders` runs (`deliveries`, `issuance_attempts`, `payment_events`, `orders` by id;
`supplier_keys` un-claimed and `supplier_requests` deleted by `req_{order}_%`), quoted beside the call. The
proof is the order of operations, measured at Slice 5's verify: `pnpm test:e2e` (55 green), then
**`pnpm test` immediately after → 11 files / 90 tests (API) + 5 files / 56 tests (web), all green, baseline
`orders=0 … unclaimed=50`** — and the baseline held even through the RED run that created two extra orders on
purpose. That is what lets three suites share one seeded Postgres with `workers: 1` (one test at a time)
and no reset between them. `retries: 0` for the reason the race tests record their RED output: a test
that passes on the second try is a false statement, not a pass.

**R14 — the method, not the sentence.** Read discrete state (`:checked`, `hidden`, `aria-current`) at once;
read a painted property only after the duration; read the duration itself statically. The rule was written
before the slice that needed it and bit anyway, in the one file that was not about hover (§3.3).

**The harness findings.** Seven, none about the product, each of which became a rule:

| Finding | Measured | The rule it produced | Where |
|---|---|---|---|
| The first fixture captured the order id with `page.on("response")` and a fire-and-forget `response.json()`, and lost the race to `location.assign` on the very next line of `buy()` | **1 orphan order** after a buy-through; **0** with the fix | Capture host-side with `page.route` + `route.fetch()` + `route.fulfill()`, so the id is in hand before the page sees the response it navigates on | Slice 1 §6.2 |
| A bare `page.clock.install()` does not freeze time — it keeps pace with the wall until paused, so `goto` and the catalogue fetch were already inside the first 5-second window | `Expected: 1 Received: 2` at 4 999 ms; `pauseAt(Date.now())` after navigation threw **`Cannot fast-forward to the past`** | `install({ time: FIXED_START })` then `pauseAt(FIXED_START + 100)` **before** `goto`; every clock-driven spec copies the `beforeEach` | Slice 2 §5.2 |
| `page.waitForTimeout` in the MCP relay let the renderer go unscheduled, so a real 5-second timer never fired | The dot had not moved; waiting *inside* `page.evaluate` with the call held open: 1 → 2 in **5 207 ms** | "The banner did not advance while I waited" is not evidence unless the page was running while you waited | Slice 2 §5.3 |
| Two suites on one database run concurrently: a `pnpm test` started while another agent's run was in flight | **`orders = 55, expected 0`**; run alone, green | One database, one runner at a time — `workers: 1` inside the project, and never two projects (or two agents) at once | Slice 1 §6.4 |
| The Playwright MCP is one shared browser, and editing `src/` during a live drive triggers a hot reload | Two agents closed each other's page mid-drive; a screenshot across a reload showed the overlay open after the drive had closed it | One driver at a time; no source edits during a drive; a screenshot is taken against a tree nobody is writing to | Slice 3 §5.3 |
| A read landing at a moment the test did not control — three appearances: the unpaused clock, the unscheduled renderer, and a `getComputedStyle` mid-fade | **`rgb(137, 137, 139)`** and `rgb(122, 122, 124)` — greys no rule names | Make the moment explicit: pause before navigating; wait inside the page; wait past the duration then read the end state | Slice 4 §5.1 |
| The dev server's SPA fallback answers a *missing image* with **`200 text/html`** — Chromium's `<img>` request has `Accept: … */*;q=0.8`, so Vite serves `index.html`; the image fails to *decode*, fires `error`, and the card degrades correctly | The 4xx sweep (R10) saw `200`; the picture test's `naturalWidth > 0 **or** --empty` accepted the fallback; a deleted PNG would have passed both and the landing's "97 of 97 `200`" | Assert `content-type` starting `image/` on every `/assets/` response, and no `--empty` on the seed (it has no `null` image) — **both now declared in the tree by Slice 7** (`layout.spec.ts`, `products.spec.ts`; read, not run, for this document) | Slice 5 §5.1 |

Two of those are the same fact from two sides: a shared resource with global state — a database, a browser
— cannot be driven by two actors at once, and "flaky" is usually a second actor.

**Ports.** The e2e owns **5101 (Vite) / 5102 (API)** with `--strictPort` and `reuseExistingServer: false`,
so a stray process fails the run loudly rather than testing against whatever was already there. The row
exists because three phases produced three near-collisions, the last during this phase's own tech spec: a
proposed **4301** was already `single-issuance-under-races.test.ts`'s. The API is started with the same five
env lines `apps/api/test/concurrency/support/api-instance.ts` sets, so the instance's webhook and supplier
calls loop back to itself. Two preflight checks name what a bare run is missing: no `DATABASE_URL` prints
"run pnpm test:e2e from the repository root"; no browser prints `pnpm exec playwright install chromium`
(revision **1243**, about **276 MB** — larger than the tech spec's original "~150 MB" estimate, since
amended in place to the measured figure, and a reviewer should know that before running the install).

*Depth: `context/product/architecture.md` §7 ("Browser tests"); `technical-considerations.md` §4;
`phase-4-slice-1-the-structure.md` §5, §6.2, §6.4; `phase-4-slice-2-the-banner.md` §4, §5.2, §5.3;
`phase-4-slice-4-currency-and-hover.md` §4, §5.1; `phase-4-slice-5-real-cards-and-buying.md` §4, §5.1.*

---

## 8. The artwork

**The Figma cap.** The plan was to export every icon per node from the design file. The nine brand tiles got
out — the Figma export call (`download_assets`) on the strip node returned 14 PNGs at 240–1920 px, 3 MB raw,
downscaled with ImageMagick (`magick`) to **144 × 144** (2× of the 72-px tile), the raw exports never
committed. Then the Figma MCP hit the Starter plan's tool-call cap mid-task. `tiktok.svg`, `more.svg`,
and all **17** UI glyphs under `icons/ui/` — catalog, search, heart, profile, two arrows, two chevrons,
info, wallet, seven chip glyphs — are **hand-authored**, drawn to the mockup's shapes rather than
exported from them. The favicon was always going to be generated (the file has none); the banner is a
CSS gradient with no asset (the file's banner is one black image; the spec wants dark panels with
Russian text). So **19 of the 29** Slice 1 asset files are hand-authored — 29 files, 228 KB, none over
31 KB, and 89/89 requests `200` on the landing. What it means for fidelity: the glyphs are
approximations, the assignment waives pixel fidelity, and the brand tiles — the things a reviewer
recognises at a glance — are the real rasters. Delivery: brand tiles as `<img alt="">` with the caption
as visible text beside them; glyphs as `<span class="icon icon--<name>" aria-hidden="true">` painted
through CSS `mask-image` with `background-color: currentColor`, because `createElement` cannot build
SVG-namespace nodes and `innerHTML` is banned; `icon.ts`'s `glyphNames` list is closed, so a name not in
`public/icons/ui/` is a type error rather than an empty box.

**The card art: generated placeholders, not the mockup's.** The mockup's card art is stock imagery for a
game the catalogue does not sell, and putting it on a «CS2 Prime Status» card would mislead a shopper about
what they are buying — the same product rule that refuses the struck-through old price. Ten SVG sources
(694–743 B each) under `scripts/card-art/`: a flat 456 × 304 panel, the brand word at 64 px, the Russian
product name beneath at 24 px, in the system font (`system-ui`), text only, no logos, the fill keyed by
SKU prefix — `STEAM-` navy `#1f2a44` (one file, shared by the three top-ups), `KEY-` slate `#2e3a48`
(three), `SUB-` purple `#432b7a` (three), `GIFT-` green `#1d6b45` (three). Rendered to PNG through the
same Chromium the e2e installs (153.0.8010.12), because ImageMagick draws text only with a font it is
handed and Cyrillic plus «₽» would be tofu without one pinned into the repository; deterministic on one
machine (a re-run was byte-identical) and not across machines, which is why the PNGs are committed and
the script exists for reproducibility. The output is 2× the card's box so a high-DPI screen downscales
and never upscales; ten files, **8 453–14 434 B, 102 011 B together**, none of it in the JS bundle.
`public/` as a whole: **39 files, 352 KB** (re-counted today). The pictures live at the seed's ten
`assets/*.png` paths — twelve rows, `assets/steam.png` three times, ten distinct names — because the
seed is the brief's fixture, verbatim and diffable line by line, and its strings were never edited to
fit the art; the script does not read the seed and the agreement between its ten basenames and the
seed's ten `image` values is by convention — guarded, since Slice 7, by the two assertions in §7's last
finding rather than by a person looking at the row.

**Resolving the path from any route.** The parser keeps the wire value untouched; the card resolves it with
`new URL(image, window.location.origin).href`, and the two one-liners that look equivalent are each a bug on
a different route: `` `/${image}` `` turns a future `/assets/cs2.png` into `//assets/cs2.png`, a
protocol-relative URL to a host named `assets`, every card blank at once with `ERR_NAME_NOT_RESOLVED`; a
plain relative `src` is right on `/` and becomes `/order/assets/cs2.png` on the order route — a 404 that
arrives with the first reuse of the entity on another page. Resolving against the *origin* ignores the current
path and survives a leading slash, and it is done in the card and not the parser so the parser stays a pure
statement about the wire that runs under Vitest's `node` environment with no `window` to fake.

**Font.** The system stack already on `body`; the mockup is Montserrat-like, and a self-hosted woff2 in three
weights with Cyrillic is ≈ 100 KB for fidelity the assignment waives; a Google Fonts `<link>` was rejected
outright because `index.html` is shared by every route and a reviewer offline sees a flash or a fallback
anyway (assumption 5).

*Depth: `phase-4-slice-1-the-structure.md` §6.3; `phase-4-slice-5-real-cards-and-buying.md` §3.2 (the
three phases of `image`, the resolution, the pictures), §5.3; `technical-considerations.md` §2.7.*

---

## 9. Assumptions a reviewer might challenge

The thirteen in `technical-considerations.md` §5, "recorded rather than confirmed; each is one line to
change", plus two that are not on the list but were decided the same way. Each with its one-sentence defence
and what flipping it would take.

| # | Assumption | The defence | To flip it |
|---|---|---|---|
| 1 | "The next two items in the shop's own order" is read as a **partition** — purchasable first, the rest after, order kept within each — giving CS2, GTA V, Tarkov, Steam 500, Steam 1000; not as a cursor giving Discord and YouTube | One walk down one ordering rather than a cursor that must remember where the keys ended; stable when the catalogue is reordered; puts the two display-only Steam top-ups beneath the Steam block above them. Pinned in three places — the unit test's first case by SKU, the e2e's crit 1 computed from the live endpoint by the same rule, and the assumptions list | A `findIndex` and a `slice` in `select-popular-products.ts`, plus the unit test's first case and the e2e's rule. Not confirmed with the user |
| 2 | **Four dots**, though the mockup draws six | Four slides exist; a dot is a target for a slide; six dots for four slides would be two that name nothing | Add slides to `config/banner-slides.ts` — the dots are built from the slide count |
| 3 | The pause region is the **slide panel only**; arrows and dots sit outside it; **focus does not pause** | Otherwise a mouse press on an arrow happens while paused, the reducer answers `cancel`, and crit 6 is unobservable by every mouse user; a mouse click focuses the button it pressed. The cost is stated: a keyboard user on the arrows gets no pause | Bind `pointerenter`/`pointerleave` to `.banner` and accept that every mouse press leaves the banner stopped — or add a `focusin` row that must not fire for a mouse click, which is harder than it sounds |
| 4 | The currency control is **native radios with no JavaScript** | §3.3's six things a handler would have to rebuild — exactly one active, one Tab stop, arrow keys, `aria-checked`, entry on the checked one from either side, form semantics — to arrive at "set this one true, the others false" | Not recommended; the tech spec surfaces it so a reviewer expecting a handler reads the reason instead |
| 5 | **System font**, no webfont | ≈ 100 KB of Montserrat for fidelity the assignment waives; a CDN link fails offline and is shared by every route | `public/fonts/`, `font-display: swap`, one `@font-face` under `.storefront` |
| 6 | **Card styles live in the page sheet**, not a per-entity CSS file | A third convention for one file; the entity's card is styled by the one page that shows it | Move the `.product-card` block to `entities/product/ui/product-card.css` and import it from the card |
| 7 | Card art as **checked-in SVG rendered to PNG at the seed's existing `assets/*.png` paths**; `packages/db` untouched | The seed is the brief's fixture, verbatim and diffable; changing its paths would need a re-seed on every reviewer machine | Change the fixture's `image` strings and re-seed — the thing the choice avoids |
| 8 | **Banner copy describes what the shop sells** and promises no discounts | R17 and the functional spec's "the shop invents no discounts"; the mockup's own slide is one black image | Edit `config/banner-slides.ts` |
| 9 | **The one edit to `features/buy-product`** is in scope | It is "where the shopper starts"; 68 insertions, 0 deletions, in the feature that set the state it un-sets; the alternative is a dead Купить after Back on the cached path | Remove the listener and accept that failure |
| 10 | **`pnpm test:e2e` is separate** from `pnpm test`, on 5101 / 5102; the buy-through goes to the key; the six cleanup statements are **duplicated**, not lifted | A reviewer running `pnpm test` should not get a Chromium download; the SQL is quoted beside the call with the source of truth named | Chain it; lift the cleanup to `@game-shop/db/testing` — "the obvious follow-up now that a second caller exists" |
| 11 | **Escape closes the menu even with the search field focused**; the field's native clear also runs | Both harmless and neither blocks the other (R8); a menu that stayed open over the field the shopper is typing into would be the one lingering | A guard on `activeElement` — and a decision about which of two harmless things to suppress |
| 12 | **No "back to shop" link** on the order page | §2.7 crit 4 names the browser's back control; the order page is out of scope for redesign | An `<a href="/">` on the order page — the first `<a>` in the app |
| 13 | *(Superseded.)* **The layout is fluid**, not fixed-width: full width, column capped at 1 280 px and centred, rows wrapping | The user's decision while the sheet was being written, dated 2026-09-13 in the functional spec's change log and amended in place in the tech spec — because the spec is the document a reviewer reads *before* the code, and a silent edit would leave the task, the spec and the sheet disagreeing three ways with no record of who decided. Measured at 1 000 × 800: tiles wrap **8 + 3**, **0** elements past the right edge; at 1 280: `|leftGap − rightGap| ≤ 1` | `.storefront { min-width: 1240px }` back — and the inverted layout assertion that gave `Received: 1000` would pass |
| + | **No `widgets/` layer** — six page-local sections under `pages/storefront/ui/`, and the carousel, menu and currency control in the page's `model/`, not `features/` | Every block has one caller and, by the spec's scope, cannot gain a second this phase; the project lifts code only on a second caller (`format-price.ts` and `poll.ts` say so) and `architecture.md` names five layers; a feature here is one thing a shopper does *with a domain effect*, and none of the three touches an entity or the API — the one control that does, Купить, *is* a feature and the page calls it in one line | Move a section to `widgets/` the day a second page wants it — "lift on the second caller" is a rule about *when*, not *whether* |
| + | **Two hover shades as hex literals**, `#3a3a3f` and `#e4e4e8`, not tokens | Hover-only; keeping them out keeps "seven tokens" a true count. The cost is real: a later change to `--sf-ink` or `--sf-ground` leaves both shades one step off a colour that moved | `--sf-ink-hover` and `--sf-ground-hover`: two lines. Either answer is defensible as long as it is stated |

*Depth: `technical-considerations.md` §5; `phase-4-slice-1-the-structure.md` §3.1, §4;
`phase-4-slice-2-the-banner.md` §3.2; `phase-4-slice-4-currency-and-hover.md` §5.3;
`phase-4-slice-5-real-cards-and-buying.md` §5.2.*

---

## 10. What is not finished

- **The cached-restore path is not proven, either way.** §6. Three automated attempts, three
  `persisted: false` / `masked`; no code-level blocker found; the user has been asked for the one-minute
  Chrome check that covers both claims. `tasks.md` marks the Slice 2 and Slice 5 verify tasks done with an
  italic note that this half is outstanding.
- **Slice 7 is in flight, and its first two tasks are ticked.** While this was written, `e2e/acceptance.spec.ts`
  (one feature-level test, tagged `@layer` and `@spec` and deliberately not `@regression`), two more
  `layout.spec.ts` tests (the hidden Russian copy; every `/assets/` response an `image/*` content-type),
  a no-`--empty`-on-the-seed assertion in `products.spec.ts`, a row count beside the request count in
  `buy-through.spec.ts`, and the `@regression` convention stated once in `support/orders.ts`'s header
  all landed; the tree declared **57 tests in 9 files at 13:08 and 58 at 13:20**. The 44-row coverage
  table and the three-suite run are Slice 7's; its walkthrough,
  `docs/walkthrough/phase-4-slice-7-acceptance.md`, landed after this document's evidence window and
  reports the run as **58 tests in 9 files in 45.5 s** for the e2e and, for `pnpm test`, 11 files / 90
  tests (API) then 5 files / 56 tests (web) — quoted from it, not run here. What Slice 7 has already
  closed in the tree — and this document takes as read, not run — is §7's last finding (the two
  assertions above), `render-card-art.ts`'s header (rewritten to name both), the tech spec's §4.1 row
  for `products-api.test.ts` (now ten cases and two REDs), and the request-versus-row wording of §2.7
  crit 3.
- **`hover.spec.ts` has one recorded RED for eight tests**, taken on the tile assertion; no card-specific
  inversion was recorded (§3.5). The card's tests share the file and went green with it.
- **The card-hover screenshot shows Phase 1's row.** `-card-hover.png` was captured before Slice 5's
  rebuild; the lift survived unchanged, the capture did not. The two banner screenshots are
  indistinguishable — both correctly slide 2 with dot 2, for two different reasons — and a slide-1 frame
  beside each would let a reader see the change rather than take it on trust.
- **The small items each slice reported, as they stand in the tree today.** Most of what the five slice
  documents listed under "reported, not fixed" has since been fixed by the explain tasks or by Slice 7, and a
  reader of those documents should know which: *closed* — `config/services.ts`'s "two the file offers as
  vectors" sentence; `catalog-menu.ts`'s header, technical-considerations §2.4 and `CLAUDE.md` now say
  `stopPropagation` is untargeted rather than that it hides the click from the row's listener; `menu.ts` now
  says "five of the six"; `hover.spec.ts`'s misattributed R14 quotation and its "crit 8" title; the MOTION
  header now says "every `:hover` rule but one"; `tasks.md`'s "six" tokens now notes the seventh;
  technical-considerations §2.8 no longer says "visibly controls"; `products-api.ts` now cites "spec 001
  technical-considerations §2.3"; and the four Slice 5 items in the previous bullet. *Still open* —
  `tasks.md`'s Slice 1 task 2 quotes `min-width: 1240px`, the pre-reversal instruction; R15 still says the
  bare `page.clock.install()` where the shipped pattern is `install({ time })` + `pauseAt`; architecture
  §7's counts ("20 tests in ~16 s", "31 tests, ~130 ms") are five slices behind; the `stopPropagation` grep
  in `CLAUDE.md` is scoped to `pages/storefront/` when the argument needs `features/buy-product` too (it
  holds — zero calls in `apps/web/src`, re-checked); `phase-4-slice-1-the-structure.md` §3.2 still
  quotes the spec as saying "visibly controls"; a pointer physically on the panel at restore is assumed
  absent; `pages/storefront/CLAUDE.md` has four bullets and no Slice 5 one; neither `entities/product`
  nor `features/buy-product` has a `CLAUDE.md`; the `@game-shop/db/testing` lift. That list is as of
  13:19; by the §2.9 review at 13:37 the tree had closed three of it — architecture §7's counts, R15's
  bare `install()`, and the Slice 1 walkthrough's "visibly controls" — re-checked by `grep`.
- **Nothing from Slices 3–5 is committed.** HEAD is `038f7d4` ("slices 1-2, and slice 3 in progress");
  `git status` showed, at 13:20, 41 changed paths, 21 of them untracked, including every Slice 4 and 5
  file, five of the e2e specs and nine of the eleven screenshots. This document is the sixth slice's and
  is untracked too.
- **No root `README.md`.** `architecture.md` §7 says the scenario-to-check mapping lives there and, since
  this phase, the five interactions map the same way to a spec under `apps/web/e2e/`; the tables in §3 and §7
  are that mapping, waiting for Phase 6. There is still no `README.md` at the root.
- **Out of scope by design:** promo codes (Phase 5), public deployment (Phase 6), the lower page, mobile
  and dark variants, any wiring of the decorative controls, any change to the order page or the operator's
  screen.

---

## 11. Where the evidence lives

| Slice | Walkthrough | Read it for | Screenshots | Specs |
|---|---|---|---|---|
| 1 — The structure | `phase-4-slice-1-the-structure.md` | Page-local sections versus a `widgets/` layer; inert by construction; placement does not scope CSS and the cascade tie it hid; the layout reversal and its change log; the fixture race; the Figma cap; `orders = 55` | `-landing.png` (1 280, twelve plain cards), `-narrow-wrapped.png` (1 000, tiles 8 + 3) | `e2e/layout.spec.ts`, `e2e/inert-controls.spec.ts`, `e2e/support/{db,orders}.ts`, `playwright.config.ts` |
| 2 — The banner | `phase-4-slice-2-the-banner.md` | The reducer's timer instruction; the panel as the pause region; the three ways to get the cache wrong; the quiet half-failure; `install()` does not freeze time; `waitForTimeout` in the relay; the bfcache verdict and its greps | `-banner-next.png`, `-banner-auto.png` (both slide 2, dot 2) | `model/carousel.test.ts` (25), `model/countdown.test.ts` (6), `e2e/banner.spec.ts` (8) |
| 3 — The catalog menu | `phase-4-slice-3-the-catalog-menu.md` | One classifying listener versus `stopPropagation`; inert inside as a property of the markup; clicking the search box is an outside click; the mispredicted RED; the shared browser and the reload under the verifier's feet | `-menu-open.png`, `-menu-inner-click.png` (byte-identical) | `model/menu.test.ts` (8), `e2e/catalog-menu.spec.ts` (6) |
| 4 — Currency and hover | `phase-4-slice-4-currency-and-hover.md` | The six things a JS radio group rebuilds; reduced motion drops the transform and keeps the fade; R14 as a method; the settle-time trap's third appearance; `:focus-visible` and the mouse; hover shades as literals | `-currency-kzt.png`, `-tile-hover.png`, `-card-hover.png` (Phase 1's row) | `e2e/currency.spec.ts` (5), `e2e/hover.spec.ts` (8) |
| 5 — Real cards and buying | `phase-4-slice-5-real-cards-and-buying.md` | What did not change, enumerated; `image` dropped for three phases and resolved from any route; the eight-step sequence and the three wrong fixes; the SPA fallback's `200 text/html`; the partition's two readings; the third `persisted: false` | `-buy-through-awaiting-payment.png`, `-buy-through-delivered.png` (the Phase 3 order page) | `entities/product/api/products-api.test.ts` (10), `model/select-popular-products.test.ts` (7), `e2e/products.spec.ts` (5), `e2e/buy-through.spec.ts` (3) |

Requirements: `context/spec/004-storefront-per-the-design/functional-spec.md` (§2.1–§2.10, §3, Change Log)
and `technical-considerations.md` (§1, §2, §3 R1–R20, §4, §5). The assignment's words:
`context/product/product-definition.md` §1.4, §2.1, §2.3, §3.2; the phase's line in
`context/product/roadmap.md`. The testing decision: `context/product/architecture.md` §7, "Browser tests".
Phase 3's own argument, which this phase changes nothing in: `phase-3.md`.

**On evidence:** what was run fresh while writing this document, against the tree as it stood between 13:07
and 13:20 on 14 September 2026 — with Slice 7 writing to `apps/web/e2e/` and the two spec files in the same
window — with no server started, no browser driven, and no source, test or config file modified. `pnpm test:web` — **5 files / 56 tests passed, 238 ms** (start 13:08:49).
`pnpm --filter @game-shop/web run typecheck` — both `tsc --noEmit` passes — exit 0. `grep -rn "setTimeout("`
over `pages/storefront/` excluding tests — one line, `model/countdown.ts:77`.
`grep -n 'addEventListener("click"' ui/catalog-menu.ts` — one line, **170** (165 when Slice 3 wrote).
`grep -n 'addEventListener\|\.checked\|"change"\|querySelector' ui/steam-topup.ts` — nothing, exit 1.
`git diff --numstat HEAD -- apps/web/src/features/buy-product/` — `68 0 …/buy-controls.ts`, one file.
`git status --short` — no path under `apps/api/`, `packages/contracts/` or `packages/db/`; 41 paths changed,
21 untracked; HEAD `038f7d4`. `find apps/web/public -type f | wc -l` — 39; `du -sk` — 352 KB; ten PNGs under
`public/assets/`; seventeen files under `public/icons/ui/`. `test(` declarations across the nine e2e files,
read twice because Slice 7 was writing to them: at 13:08, 1 / 8 / 3 / 6 / 5 / 8 / 8 / 7 / 5 — 57; at 13:20,
`layout.spec.ts` at 8 — 58; the inert-controls 8 includes one inside a loop over `[0, 1, 2, 3, 4, 5, 6]`.
`tasks.md` and `technical-considerations.md` changed on disk while this was written (Slice 7's first two
tasks ticked; the §4.1 and R1 rows amended) and were re-read. The "still open" and "closed" lists in §10
were each checked by `grep` against the tree at 13:19. `scripts/race/README.md`'s port row lists 5101–5102
and 4301. There was no `docs/walkthrough/phase-4.md` before this one and there is no root `README.md`.
`-landing.png` and `-menu-open.png` opened and read; their contents are as §1 and §3.2 describe.

Everything else is quoted from the slice walkthrough named beside it, each of which records what its author
re-ran and what it took from the task agents' reports: every RED line in §3 and §4; every suite count and
duration in §1 and §7 other than today's unit run; the three bfcache measurements and the synthetic-event
results; the live-drive numbers (5 207 ms, 6 003 ms, 97 of 97, `naturalWidth: 456`,
`ord_01M2FR6QK83N46JVKE6STQJA6M`, ~2.4 s, `intentKeysRemainingInStorage: []`, the 659 / 544 px geometry,
`rgb(137, 137, 139)`); the asset sizes; the `orders=0 … unclaimed=50` baseline after the e2e; and the
verifier's two by-eye sentences. The e2e suite, `pnpm test`, and the manual Chrome check were not run for
this document: the first two start servers or touch the shared database while Slice 7 is working in the same
tree, and the third needs a person.
