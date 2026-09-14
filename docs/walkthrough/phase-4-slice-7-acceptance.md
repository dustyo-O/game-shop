# Phase 4 · Slice 7 — The acceptance suite, and what Phase 4 actually settles

> Phase 3's slice 9 closed that phase with a wire-contract suite and a 40-row coverage table. This is the same closing statement for Phase 4, and it differs in one way that matters: this phase added a testing layer as well as a feature, so the table has three suites to point at rather than one. `pnpm test:e2e` runs **58 tests in 9 files in 45.5 s** — Chromium against two servers the config starts itself. `pnpm test` runs the API's **11 files / 90 tests** (~44–46 s) and then the web's **5 files / 56 tests** (~190 ms). The 44-row table counts **38 covered, 1 covered with a caveat, 1 verified by hand, 4 a document, 0 not covered anywhere by name** — and the seeded baseline, `orders = 0` / `unclaimed = 50`, holds before and after every run of all three (R13).
>
> Three things are worth the reader's attention. **The suites prove state, not sight.** Every hover, lift and fade is asserted as a `transition-duration` that is positive and an end state read after it — never a frame, never "it looked smooth"; whether a person *sees* the highlight is a judgement three screenshots and a verifier's eye made, and this document says which rows rest on that. **One row is half-proven and says so** — §2.7's fourth, Back returns to a running banner: the reload path is proven on every run, and the cached restore is proven nowhere, because any attached debugging session disqualifies a page from Chromium's back/forward cache (`persisted: false`, `notRestoredReasons: masked`, measured three times). **And the exercise found a hole that was not in its brief**: Vite's dev server answers a request for a missing PNG with `200 text/html`, so deleting a card-art file would have passed the 4xx sweep, the picture test's `--empty` escape hatch, and the whole suite. It is now closed both ways — an asset content-type guard, and a "zero `--empty` on this seed" assertion.
>
> Reading the suite for this document found six smaller things, and — as in Phase 3's slice 9 — all but one were fixed in the same slice before it was ticked, by a follow-up after this document was first written. The one that mattered: `acceptance.spec.ts`'s last assertion, "the banner is running again after Back", read its "before" value while the page was still on `/order/…`, where no dot exists, so it compared the fresh page's dot 0 with `-1` and passed on the first poll whether or not the timer ran. It now reads the dot *after* `toHaveURL("/")`, as `buy-through.spec.ts` does, and its RED is a real one — and the first inversion tried was itself vacuous, which §6 records (§7). The rest: the dispositions this slice's report gave as 39 + 1 + 1 + 4 summed to 45 against 44 rows (38 is right); `architecture.md` §7's counts were five slices behind (now 58 / 56); an asset-count comment enumerated 30 of the 31 it announced (now 11 + 16 + 4); R20's "in the README" pointed at a root README that still does not exist (now says so); and §2.7 crit 3's "one order exists" was asserted from captured ids — it is now a `count(*)` on `orders` through the e2e's own client.

---

## 1. What actually shipped

Slice 7 wrote one new file and extended four. Slices 1–5 had already written every behaviour-level spec and every unit file — write-first where the behaviour was new, RED-validated in every case — so this slice's job was the feature-level view: the coverage table, the seam between slices, and the criteria the per-slice specs had asserted by proxy rather than by their own words.

| File | Change | Covers |
| --- | --- | --- |
| `apps/web/e2e/acceptance.spec.ts` | **new, 1 test** — every graded interaction touched in one session (arrow, menu open + close, «₸», a tile hover, a card hover), then Купить on the hovered card, payment, the key, and Back | The seam: that state one interaction leaves behind does not break the next; no single criterion. **No `@regression`** (§3) |
| `apps/web/e2e/layout.spec.ts` | **+2 tests (6 → 8)** — a Russian sweep over `.banner__slide` and `.catalog-menu`, whose text the visible-only sweep could never reach; a content-type guard over every `/assets/*.png`, `/icons/**` and `/favicon.svg` response | §2.10 for slides 2–4 and the overlay; R5/R10 closed against the SPA fallback (§7) |
| `apps/web/e2e/products.spec.ts` | **+2 assertions** inside existing tests — every card has a non-empty name and a price ending in `₽`; zero `.product-card__media--empty` on this seed | §2.6 crit 1's own words ("a name and a price in roubles"); the `--empty` escape hatch |
| `apps/web/e2e/buy-through.spec.ts` | the R9 test now also asserts **one distinct order id** in a new `createdOrderIds` fixture value, beside the one `POST` it already counted | §2.7 crit 3's own words ("one order exists") |
| `apps/web/e2e/support/orders.ts` | `createdOrderIds` split out of `trackCreatedOrders`'s closure into its own fixture; the `@regression` decision for every file under `e2e/` written once in the header | — |
| `carousel.test.ts`, `countdown.test.ts` | `@regression` **0 → 1** each — the two unit files Slice 2 wrote before the tag was settled for `apps/web` | — |

Every file under `e2e/` and every `*.test.ts` under `src/` carries `@layer` and `@spec: 004-storefront-per-the-design`. The eight behaviour-level specs and the five unit files carry `@regression`; `acceptance.spec.ts` does not.

The full layer picture, since this is the first phase with three suites:

| Suite | Files | Tests | Needs | Command |
| --- | --- | --- | --- | --- |
| Web unit — Vitest, `environment: "node"`, no jsdom | `carousel` (25), `countdown` (6), `menu` (8), `select-popular-products` (7), `products-api` (10) | **56** | nothing — ~190 ms | `pnpm test:web`, chained after the API suites in `pnpm test` |
| Browser — Playwright, one `chromium` project at 1 440 × 900, `workers: 1`, `retries: 0` | `layout` (8), `inert-controls` (14), `banner` (8), `catalog-menu` (6), `currency` (5), `hover` (8), `products` (5), `buy-through` (3), `acceptance` (1) | **58** | Chromium; Postgres on 5433; the API on **5102** and Vite on **5101**, both started by the config — 45.5 s | `pnpm test:e2e` — **not** in `pnpm test` |
| API — Vitest, `fileParallelism: false` | 3 unit, 3 acceptance, 5 concurrency (Phases 1–3, unchanged) | **90** | Postgres on 5433; four `apps/api` processes for the race files — ~44–46 s | `pnpm test` |

Files run one after another in every suite, and the three suites run one after another — never two at once (§3). The e2e creates **four real orders and claims two real keys** per run (`buy-through.spec.ts` three orders and one key; `acceptance.spec.ts` one of each) and deletes every one of them in the fixture's teardown.

---

## 2. The words this document uses

- **Suite / layer** — one of the three runners above. "Layer" is the `@layer` tag a file carries: `unit`, `e2e`, or the API's `unit` / `integration` / `concurrency`.
- **Behaviour-level / feature-level** — a behaviour-level spec holds one acceptance criterion per `test()` and was written before the behaviour it checks existed; a feature-level spec walks the assembled path once and a failure in it says "something in the composition broke", not which criterion. The `@regression` tag follows this line (§3).
- **Disposition** — one of five answers for a criterion in the coverage map: *covered* (an automated test asserts the criterion's own words), *covered with a caveat*, *verified by hand* (a person in a real browser or a screenshot, named), *a document*, or *not covered anywhere by name*. The last appears zero times in this phase's table.
- **Baseline** — the seeded state `apps/api`'s harness asserts before and after every file: `products = 12`, `supplier_keys total = 50`, `unclaimed = 50`, `orders = 0`, and zero rows in `payment_events`, `deliveries`, `issuance_attempts`, `supplier_requests`. R13 is the requirement that the e2e hand this state back.
- **Reload path / cached restore** — the two ways Back can return to the storefront. Under any automated browser Back is a full reload: `mountApp` runs again, the carousel starts at slide 1 with a fresh count, Купить is enabled by construction. In real Chrome without DevTools attached, Back may instead restore the page *as it was left* from the back/forward cache — timer cancelled, button disabled — and the `pageshow` handlers exist for that path.
- **Static read / end-state read (R14)** — the two ways a CSS transition is asserted: `transition-duration` read from the stylesheet (a property that does not change while the fade runs), and a computed style read after a fixed wait longer than the duration. Never a value mid-fade.
- **SPA fallback** — Vite's dev-server behaviour for a path it does not recognise as a file: serve `index.html`, `200 text/html`. Right for client-side routes; invisible to a status-only network sweep when the path was meant to be an image.
- **Inversion** — the RED method for an assertion added after the behaviour exists: point the assertion at the wrong state, run, read the failure, restore. Never a change under `apps/web/src`. **Write-first** and **mutation** are the other two methods the phase used, recorded in the slice walkthroughs.

---

## 3. What the suite is for

### Three suites, because three kinds of fact

**The web unit suite proves the derived facts, and nothing about the page.** `architecture.md` §7's Phase 1 judgement was that a browser layer earns its place only when the rendering path *derives* a fact rather than mirroring one, and Phase 4 met that trigger four times: `wrapIndex` and the carousel's policy table, the countdown's one slot, the menu's open/closed rule, the five-from-N row selection — plus the catalogue parser, whose `image` column came back nullable. Those are functions from values to values, so they are tested as functions: 56 cases in ~190 ms, no `document`, no timers except the faked ones `countdown.test.ts` installs. What this suite cannot prove is that the DOM calls them: that `ui/banner.ts` applies the reducer's timer instruction, that the one `document` listener classifies a click the way `reduceMenu` expects, that the five SKUs the selection returns are the five `<li>`s in the row. And it has nothing to say about the currency control, because native radios derive nothing — tech spec §4.1 says so and Slice 4's walkthrough defends it.

**The browser suite proves the five interactions as state, the inert controls as silence, and the buy-through to a key.** Every assertion in the eight behaviour-level specs reads a discrete fact — `hidden` on a slide, `aria-current` on a dot, `aria-expanded` on Каталог, `:checked` on a radio, a `transform` matrix after the transition has finished, a `data-status` on the order page — or the absence of one: no `document` request, no `POST /api/orders`, no `pageerror`, no `[aria-busy]`, no new sentence matching `/скоро|coming soon|загруз/iu`. The carousel's five-second policy runs under `page.clock`, installed and **paused before `goto`** so page-load time never leaks into the first window (Slice 2 §5.2); the buy-through and the acceptance walk run on the real clock, because the order page's poll is a `setTimeout` chain off a real delivery and a faked clock would freeze it. One Chromium project, `Desktop Chrome` at 1 440 × 900, `workers: 1`, `retries: 0` — "a test that passes on the second try is a false statement, not a pass".

What the browser suite cannot prove is listed by name in §5, and the tech spec named most of it before the suite existed: the cached restore; a fade *as seen*; delivery *correctness*; any browser but Chromium; the mockup's wording.

**The API suites prove the purchase, and are the reason the e2e cleans up.** Nothing in `apps/api/test` changed this phase, and nothing should have: the storefront sends the same `POST /api/orders` the plain page sent, so one-intent-one-order, one-payment-one-key and silence-is-not-a-second-key are still proven at the boundary where they are enforced — across four processes, with stock accounting asserted. The e2e watches a key *arrive*; it does not, and cannot, prove that the key was the only one cut. Those 90 tests cannot see the page at all, and they assert the seeded baseline before they will touch the key pool. That assertion is what R13 protects.

### One database, one runner at a time

All three suites share one Postgres on 5433 and one 50-key pool, and each asserts or depends on the baseline. So the order is fixed: `pnpm test:e2e`, then `pnpm test`, and the second is green only if the first handed the database back. Slice 5's verify ran exactly that sequence and recorded it — 55 e2e green, then `11 files / 90 tests` and `5 files / 56 tests` with `orders=0 … unclaimed=50` — and this slice ran it again at 58. Slice 1's verify recorded what happens when the rule is broken: a `pnpm test` started while another agent's `pnpm test` was in flight failed its own precondition with **`orders = 55, expected 0`** — not the e2e's fault, not flakiness, one database and two runners.

The e2e's half of the contract is `e2e/support/orders.ts` and `db.ts`: a `page.route` handler that reads every `POST /api/orders` response body on the host side *before* the page's own `fetch()` resolves — because `buy()` calls `location.assign` on the line after `await createOrder`, and a `page.on("response")` listener lost that race and left **1 orphan** order behind per buy-through (Slice 1 §6.2; **0** with the route) — and a teardown that runs the same six statements as the API harness's `cleanupTestOrders`, SQL quoted beside each call, `req_{order}_%` un-claim included. The fixture is `auto: true`: a spec cannot forget it.

### Why `pnpm test:e2e` is a separate command

Because it needs a browser and starts two servers. A reviewer who runs `pnpm test` expecting the API suites should not get a 276 MB Chromium download or a port collision. `pnpm test` is `API then web unit`; `pnpm test:e2e` builds the API (`dist/main.js` is what `start` runs) and then hands Playwright a config that owns both servers on **5101 / 5102** with `reuseExistingServer: false`, so a stray process on either port fails loudly rather than being tested against. The same config has two preflight checks that throw before any test with the sentence a bare run is missing (§8, "What a reviewer installs").

### The acceptance spec: the seam, and why it carries no `@regression`

Every sibling spec's `beforeEach` is `page.goto("/")` and one interaction. None of them can see whether the banner's single timer slot survives an arrow press *followed by* an opened-and-closed menu, a radio click and two hovers; whether the one `document` click listener still classifies Каталог correctly after the radio group has handled pointer events of its own; whether a card carrying a CSS-only `translateY` still delivers a click to the `button[data-sku]` beneath it. `acceptance.spec.ts` is one test that does all of that in sequence, then buys, pays, reads the key, and goes back. One test, not five, on purpose: the thing under test is the sequence, and splitting it would either duplicate the setup five times or couple five tests through execution order.

That is also why it has no `@regression`. `e2e/support/orders.ts`'s header states the decision once for every file under `e2e/`: the Phase 1–3 convention puts the tag on the permanent, one-criterion-at-a-time guards and not on the acceptance suite (`failure-and-recovery.test.ts` carries `@layer` and `@spec`, never `@regression`, for the same reason). The eight behaviour-level specs are those guards — one criterion per `test()`, write-first, RED-validated — and keep it. The acceptance walk is the feature-level file, and a failure in it says "the composed page broke", not which criterion; it does not.

---

## 4. The coverage map — all 44 criteria

Section counts: §2.1 has 5, §2.2 has 7, §2.3 has 6, §2.4 has 4, §2.5 has 4, §2.6 has 5, §2.7 has 4, §2.8 has 4, §2.9 has 4, §2.10 has 1. Dispositions: **38 covered**, **1 covered with a caveat** (§2.7 crit 4), **1 verified by hand** (§2.1 crit 2), **4 a document** (§2.9), **0 not covered anywhere by name**. Test titles are quoted from the spec files; RED lines are the slice walkthroughs' unless marked Slice 7 (§6).

| § | Criterion | Disposition | Where, and the note that matters |
| --- | --- | --- | --- |
| 2.1.1 | Header, banner, service strip, Steam block, «Популярные товары», and nothing below | **covered** | `layout.spec.ts` *"the five sections appear in the mockup's order, and the row is the content's last child"* — five selectors present, each `top` ≥ the previous, `.popular` is `.storefront__content`'s last child |
| 2.1.2 | Every block present, in the mockup's order, **with the mockup's own labels** | **verified by hand** | Presence and order are the row above. "The mockup's own labels" is a comparison with Figma frame `1:4` that no test makes: a human read of `docs/screenshots/004-storefront-per-the-design-landing.png` against the frame (Slice 1's verify, re-read for this table). Labels tests *do* pin by name: «еще 841» on tile 11 (`hover.spec.ts`), five categories and six column headings (`catalog-menu.spec.ts`), «500 ₽» (`currency.spec.ts`), the error sentence verbatim (`products.spec.ts`) |
| 2.1.3 | ≥ 1 280 px: one centred column, equal space either side, no horizontal scrollbar | **covered** | *"at 1280x800 the page never scrolls sideways and the column is centred"* — `scrollWidth ≤ clientWidth`; left and right gaps within 1 px |
| 2.1.4 | Narrower: fills edge to edge, no horizontal scrollbar, rows wrap | **covered** | *"at 1000x800 the page still never scrolls sideways, fills the window, and the tile row wraps"* — column width ≈ viewport; the eleven tiles have more than one distinct `top`. Slice 1 RED: `scrollWidth > clientWidth` inverted → **`Received: 1000`** |
| 2.1.5 | Everything but a brand name is Russian | **covered** | *"every visible text node is Russian, has no letters, or is an allowed brand name (functional spec §2.10)"* — a `TreeWalker` over visible text with a 31-name brand allowlist; plus row 2.10.1's hidden-container sweep |
| 2.2.1 | Advances every 5 s untouched | **covered** | `banner.spec.ts` *"crit 1 — advances to the next slide at 5000ms, not before"* — still 1 at 4 999, 2 at 5 000 under a paused clock. The rule: `carousel.test.ts` *"tick › advances by one and restarts the count"* |
| 2.2.2 | Last slide advances to the first | **covered** | *"crit 2 — advancing past the last slide wraps to the first, rather than stopping"* — 2, 3, 4, then 1. Unit: *"tick › wraps last → first (crit 2)"*; `wrapIndex` without the modulo → **6 failed** |
| 2.2.3 | Arrows move at once | **covered** | *"crit 3 — the arrows move the slide at once, with no clock movement"* |
| 2.2.4 | Left arrow on the first slide → the last | **covered** | *"crit 4 — pressing the left arrow on the first slide wraps to the last"*. Unit: *"prev › wraps first → last (crit 4)"* — `wrapIndex` without the `+ count` normalisation → **3 failed, all first → last**, last → first still green (the quiet half-failure, Slice 2 §5.1) |
| 2.2.5 | Exactly one dot highlighted, the current slide's, after auto and manual moves | **covered** | *"crit 5 — the current dot names the visible slide after an auto tick, an arrow, and a dot click"*; `assertInvariant` — one slide visible, one dot current, same position — runs in every test of the file |
| 2.2.6 | An arrow press restarts the 5-second count | **covered** | *"crit 6 — an arrow press restarts the 5-second count from that moment"* — 3 000, press, still 2 at +4 000, 3 at +5 000. Slice 2 RED: `runFor(4000)` → `5000` keeping "still" → **`Expected: 2 Received: 3`**. Unit: `countdown.test.ts` *"restart mid-count starts the wait over from that moment (crit 6)"*, *"restart twice → fires once"* — `clearTimeout` removed → **`expected "vi.fn()" to be called 1 times, but got 2 times`** |
| 2.2.7 | Pointer over the banner pauses; leaving resumes | **covered** | *"crit 7 — the pointer resting on the panel pauses the count, and leaving it resumes"* — still 1 at 6 000 hovered; 2 at 5 000 after `mouse.move(0, 0)`. Slice 2 RED: "advanced" while hovering → **`Expected: 2 Received: 1`**. Assumption 3's own test: hovering the arrow does *not* pause. Unit: the `pointer` rows |
| 2.3.1 | Каталог opens the overlay with five categories and the columns | **covered** | `catalog-menu.spec.ts` *"crit 1 — closed on load; clicking Каталог opens the overlay with five categories and six columns"* — `hidden` and `aria-expanded` read together; 5 `.catalog-menu__category`, 6 `.catalog-menu__heading`. Unit: `menu.test.ts` *"Toggle › from closed → open (crit 1)"* |
| 2.3.2 | Каталог again closes it | **covered** | *"crit 2 — clicking Каталог again on an open menu closes it"*; also the acceptance walk's second Каталог click — Slice 7's RED (§6) |
| 2.3.3 | A click anywhere outside closes it | **covered** | *"crit 3 — a click outside the overlay closes it (the ground beside the column, and the h2 heading)"* — `mouse.click(20, 400)` and `.popular__title` |
| 2.3.4 | Escape closes it | **covered** | *"crit 4 — Escape closes the menu with the search field focused (R8), and steals no focus while closed"* — the field reached by `.focus()`, never `.click()`, which is itself an outside click (Slice 3 §5.1) |
| 2.3.5 | A click inside changes nothing — open, no navigation, no error | **covered** | *"crit 5 — clicking a category or a column item inside the overlay changes nothing"* — `document`-request and `pageerror` listeners armed before the act. Slice 3 REDs: `hidden: true` after the inner click → **`Expected: true Received: false`**; URL changed → **`Expected: not "http://localhost:5101/"`**. Unit: *"InsideClick › on an open menu stays open"* — `InsideClick` returning `false` → **1 failed** |
| 2.3.6 | Several times in a row, the same each time | **covered** | *"crit 6 — opening and closing the menu three times in a row behaves the same each time"* |
| 2.4.1 | «$» active on load, the other two not | **covered** | `currency.spec.ts` *"crit 1 — on load «$» is the only checked option, and its label's background differs from the other two"* — `:checked` on `#currency-usd`; `rgb(17, 17, 19)` against `rgb(242, 242, 244)` |
| 2.4.2 | «₸» then «₽» each become the active one | **covered** | *"crit 2 — clicking «₸» makes it active and unchecks «$»; clicking «₽» next makes it active and unchecks «₸»"*. Slice 4 RED: «$» still checked after clicking ₸ → **`Expected: "currency-usd" Received: "currency-kzt"`** |
| 2.4.3 | Re-clicking the active option changes nothing | **covered** | *"crit 3 — clicking the option that is already active leaves the full state unchanged"* — `checkedId` and all three backgrounds `toEqual` the pre-state |
| 2.4.4 | The sum does not change | **covered** | *"crit 4 — the «Сумма» text is identical before and after every click, including a re-click"* — `"500 ₽"` throughout |
| 2.5.1 | Any tile, «еще 841» included, visibly highlights, fading in | **covered** | `hover.spec.ts` *"crit 1 (static) — the tile and card transitions have a positive duration, the evidence they fade rather than switch instantly"*; *"crit 2 — hovering the Steam tile changes its background and gives it a shadow, fading in over 160ms"*; *"crit 1/2 — «еще 841» (the eleventh tile) highlights the same way, and settles back on leave"*. "Visibly" — a person's eye on `-tile-hover.png` (§5) |
| 2.5.2 | Pointer off: fades out, returns to before | **covered** | the «еще 841» test's second half — `mouse.move(0, 0)`, then `rgba(0, 0, 0, 0)` and `none` |
| 2.5.3 | Only the tile under the pointer, moving along the strip | **covered** | *"crit 3 — moving along the strip from Steam to Telegram leaves exactly one tile highlighted, and it is the one under the pointer"* — all 11 read, exactly one at index 1. Slice 4 RED: index 0 expected → **`Expected: 0 Received: 1`** |
| 2.5.4 | Keyboard reaches a tile → the same highlight | **covered** | *"crit 4 — reaching a tile with the keyboard (Tab) shows the same highlight the pointer shows on hover"* — real `Tab` presses, because `:focus-visible` is about how focus arrived (Slice 4 §5.2) |
| 2.6.1 | Exactly five cards; picture, name, price in roubles; Купить on exactly three | **covered** | `products.spec.ts` *"crit 1 — five cards, Купить on exactly the three purchasable SKUs from GET /api/products, in the selection's own order"* — expectation computed from the live endpoint; **since Slice 7** also a non-empty name and a price matching `/₽$/u` per card. *"crit 1 — every card's picture loads (naturalWidth > 0), or the card carries --empty (R5), with no 4xx/5xx along the way"* — **since Slice 7** also zero `--empty` on this seed. Unit: `select-popular-products.test.ts` *"the seed-shaped fixture → CS2, GTA V, Tarkov, Steam 500, Steam 1000 (assumption 1)"* — `slice(0, count)` → **5 of 7 failed**; `products-api.test.ts`'s ten — write-first **5 pass / 5 fail**, `?? null` → the `42` and missing-key cases fail |
| 2.6.2 | Hover lifts the card, animated | **covered** | `hover.spec.ts` *"§2.6 crit 2/3 — hovering a product card lifts it (a translateY matrix and a deeper shadow), and leaving settles it back"* — `matrix(1, 0, 0, 1, 0, -4)` and `rgba(0, 0, 0, 0.18) 0px 16px 40px 0px`; *"§2.6 crit 2 (keyboard) — focusing the first «Купить» lifts its own card via :focus-within"*; the reduced-motion test (R11: shadow kept, transform dropped); `products.spec.ts` *"crit 2 (smoke)"*. "Visibly" — `-card-hover.png` (§5) |
| 2.6.3 | Pointer off: settles back | **covered** | the same hover test's leave half — `transform: none`, `box-shadow: none` after `SETTLE_MS` |
| 2.6.4 | A card without Купить: nothing looks like a button; clicking does nothing | **covered** | `products.spec.ts` *"crit 4 — clicking a display-only card's picture or name does nothing (R6)"* — no `document` request, no `POST /api/orders`, URL unchanged. "Nothing looks like a button" — a person's eye on the row (§5) |
| 2.6.5 | Catalogue unavailable: everything else works; the row alone shows the existing Russian message | **covered** | *"crit 5 — GET /api/products failing (503): the row alone shows the exact error sentence; everything else keeps working"* — the sentence verbatim from `config/text.ts`, zero cards, the banner advancing under the clock, Каталог opening. Slice 5 RED: five cards asserted under the 503 route → **`Received: 0`** |
| 2.7.1 | Купить → the order page: name, amount, waiting for payment | **covered** | `buy-through.spec.ts` *"crits 1–2 — Купить leads to the order page (name, amount, «Ожидает оплаты»), and the success control carries the shopper to the key within 15s"* — name and price read from the card *before* the click; `data-status="created"`. The acceptance walk repeats it on a card that was hovered first |
| 2.7.2 | Simulated payment → the key, no further action | **covered** | the same test — `data-status="delivered"` within 15 s, «Ключ выдан», non-empty `data-order-code`. Delivery *correctness* is the API suites' (§5) |
| 2.7.3 | Double-click → one order page, one order exists | **covered** | *"R9 — double-clicking Купить still sends exactly one POST /api/orders, and one order exists"* — one `POST` in the request log and, **since Slice 7**, `new Set(createdOrderIds).size === 1`. Slice 7 RED: `.toBe(2)` → **`Expected: 2 / Received: 1`** (§6). One step short of a row count — §7 |
| 2.7.4 | Back → the storefront, banner running, menu closed | **covered with a caveat** | *"crit 4 — the browser's back control returns to the storefront: overlay hidden, banner running again (reload path)"* — `goBack()`, `hidden: true`, the current dot changes within 7.5 s of real time. **The reload path only.** The cached restore — timer cancelled, Купить disabled, `pageshow { persisted: true }` — is proven nowhere: any CDP session disqualifies the page (`persisted: false`, `notRestoredReasons: masked`, three measurements). Outstanding: the manual Chrome check (§5) |
| 2.8.1 | Search + Enter: no results, no navigation, no error | **covered** | `inert-controls.spec.ts` *"typing into the search field and pressing Enter does nothing"* |
| 2.8.2 | Favourites, profile, promo, a chip, «еще 841»: no navigation, no error | **covered** | *"clicking the favourites heart does nothing"*, *"clicking the profile button does nothing"*, *"clicking the promo-code control does nothing"*, *"clicking chip N of 7 does nothing"* × 7, *"clicking the «еще 841» tile does nothing"* — and one the criterion does not name, the search button. Slice 1 RED: the identical `assertInert` pointed at Купить failed on **three lines** (a `document` request to `/order/ord_…`, a `POST /api/orders`, the URL changed) |
| 2.8.3 | A Steam login + «Оплатить»: no order, no navigation, no error | **covered** | *"typing a Steam login and clicking «Оплатить» does nothing"* — no `POST /api/orders` |
| 2.8.4 | Nothing promises a result — no spinner, no "coming soon" | **covered** | inside every one of the fourteen: no `[aria-busy="true"]`, no *new* text matching `/скоро|coming soon|загруз/iu`; the structural half — `layout.spec.ts` *"there is no <a> and no <form> anywhere on the page"*, Slice 1 RED **`Received: 0`** |
| 2.9.1 | A walkthrough names each of the five interactions, what was asked, what was built | a document | `docs/walkthrough/phase-4.md` — Slice 6, being written as this document is; its two-pass review is Slice 6's second task |
| 2.9.2 | It states what was left static, and why that is the instruction | a document | `phase-4.md` |
| 2.9.3 | It states how the storefront joins the purchase path, and what did and did not change | a document | `phase-4.md`; the one feature edit is Slice 5 §3.3 |
| 2.9.4 | Readable without the source | a document | Slice 6's second pass |
| 2.10.1 | Text this phase adds is Russian, brand names as the mockup writes them | **covered** | `layout.spec.ts`'s visible sweep and, **since Slice 7**, *"banner slides 2–4 and the catalog menu's categories/columns are Russian too — hidden by default, so the sweep above never reveals them"* — `textContent` read through `[hidden]`; Slice 7 RED **`Received: 0`** (§6) |

---

## 5. What is deliberately not here, and where it lives

**§2.1 criterion 2 — the mockup's own labels.** The layout test proves five blocks in the mockup's order; the Russian sweep proves the language; four specs pin a handful of labels by name. What none of them does is open Figma frame `1:4` and compare. That comparison was made by a person, twice: Slice 1's verify captured `-landing.png` at 1 280 × 800 and read it against the frame, and this slice re-read it for the table. The row says "verified by hand" rather than "covered" because a screenshot a person looked at is a different kind of evidence from an assertion that runs, and the table should not blur them.

**§2.7 criterion 4's cached half — nowhere.** The criterion says Back returns to a storefront "with the banner running and the menu closed". On the reload path — which is every path an automated browser can take — that is proven on every run: `buy-through.spec.ts` waits up to 7.5 s of real time for the dot to change after `goBack()`. On the cached path it is not proven at all. Three attempts across two slices, each framed differently — Slice 2's verify launching Chromium without Playwright's `--disable-back-forward-cache` flag, `buy-through.spec.ts`'s own `goBack()` under the normal harness, Slice 5's verify against the buy flow — all returned `pageshow.persisted: false` with `notRestoredReasons: [{ reason: "masked" }]`: a page with a debugging session attached is not eligible for the cache, and every automated browser has one. So the handlers this path exists for — `pageshow` + `persisted` → restart the countdown (Slice 2), force the menu closed (Slice 3), re-enable every disabled `button[data-sku]` (Slice 5) — have been exercised only with synthetic events dispatched from script, which proves they do the right thing *when the event arrives*, not that Chrome delivers it. **Outstanding: the manual Chrome check** the user has been asked for, which covers both halves in one minute — `vite preview`, DevTools → Application → Back/forward cache → Test; buy; Back; the dot advances within 5 s **and** Купить is enabled and a second press creates a second order — with the DevTools verdict recorded verbatim in `phase-4.md`.

**§2.9, all four — a document.** `phase-4.md` is being written concurrently with this one; its review against §2.9's four criteria, in two passes, is Slice 6's second task and has not run.

**The halves no automated test can make — "visibly", "looks like".** Three criteria contain a judgement about pixels beside a fact about state. §2.5 crit 1 says the tile "visibly highlights"; §2.6 crit 2 says the card "visibly lifts"; §2.6 crit 4 says "nothing on it looks like a button". The tests prove the state half — a background that changed, a `translateY` matrix, no `button` element and no request on click. The pixel half was the verifier's eye in Slice 4: `-tile-hover.png` shows the Steam tile on a grey rounded backdrop with a shadow and the other ten flat; `-card-hover.png` shows «Пополнение Steam 500 ₽» risen on a shadow above rows that are otherwise flat. The rows stay "covered" because the words that can be asserted are asserted; this paragraph is where the other words went. The fade *as seen* — that a 160 ms transition is perceived as smooth — is asserted by nobody: R14 says why a mid-transition read is a false negative, and the suite reads durations and end states only.

**Delivery correctness — the API suites.** `buy-through.spec.ts` and the acceptance walk each watch one key arrive. That the key was the only one cut, that the payment was recorded once, that a stalled supplier would not have produced a second — those are `purchase-and-key-delivery.test.ts`, `single-issuance-under-races.test.ts`, the five four-process files and `pnpm race`, none of which changed. The e2e's un-claim of `supplier_keys` in cleanup is the thing "only a test may do", and it does it for the same reason the API harness does.

**Any browser but Chromium.** One project. `:focus-visible`'s heuristic, the native `type="search"` Escape-clear, and `prefers-reduced-motion` handling all differ per engine and are asserted in one.

Three things in this section are not a clean hand-off, and they are the part worth reading.

**The acceptance walk's last assertion proved nothing as first written — found here, fixed here.** Step 7 read `dotBeforeReturn = await currentDotIndex(page)` *before* `page.goBack()` — while the page was `/order/ord_…`, where `document.querySelectorAll(".banner__dot")` is empty and `findIndex` returns `-1`. After Back the fresh storefront's dot 0 is current, `0 !== -1`, and `expect.poll(...).not.toBe(dotBeforeReturn)` passed on its first read, timer running or not. `buy-through.spec.ts`'s crit 4 test did it right — `dotAfterReturn` read *after* `toHaveURL("/")` — and the acceptance walk now does the same. The acceptance spec's original RED was on the menu-closed assertion; this line had never been inverted, and an inversion would have shown it — §6 has the one that did, and the one that did not.

**"One order exists" is asserted from ids, not rows.** §2.7 crit 3's words name the `orders` table. Before Slice 7 the R9 test counted `POST /api/orders` in the request log — "one attempt was sent", which equals "one order exists" only because this shop creates one order per successful `POST`, the fact the assertion took for granted. Now it also asserts one distinct id in `createdOrderIds`, the array the route handler fills from `2xx` response bodies and the cleanup deletes rows by. That is the server saying "I created this id", which is closer; the criterion's own words are a row count, so the test now also runs `select count(*)::int as n from orders where id = any($1::text[])` through `openE2eDatabase()` — SQL quoted beside the call — and expects `1`. RED `.toBe(2)` → `expected exactly one row in orders for id(s) ord_01M2FVKHT372BXN81GNJ4Z7870, found 1`.

**The `--empty` escape hatch is closed on this seed and would open again on another.** `products.spec.ts`'s picture test accepts `naturalWidth > 0` *or* `.product-card__media--empty`, the right shape for a nullable `image` column. The seed gives all twelve products a real path, so on this seed the `or` was an escape hatch nothing should take — and a deleted PNG, answered `200 text/html` by the dev server, took it silently (Slice 5 §5.1). The new assertion, zero `--empty`, closes it *for this seed*; a future fixture with a genuine `null` would need the number changed, and the assertion's message says so.

---

## 6. RED validation without touching `src/`

Slices 1–5 established RED three ways — write-first against the empty page, a mutation of the one line the test guards, and pointing an identical "nothing happened" assertion at Купить — and each walkthrough quotes its lines; §4 carries them per row. This slice added assertions to behaviour that already existed end to end, so the method is inversion: point the new assertion at the wrong state, run, read the failure, restore. Six inversions, none touching `apps/web/src`; every one is quoted in the file beside the assertion it proved.

**1. The acceptance walk's second Каталог click** — `acceptance.spec.ts`:

```ts
expect(afterClose.hidden, "closed again after the second click — the menu does not stay open for the rest of the session").toBe(true);
```

First written as `.toBe(false)` — the overlay still open after the second click — and run against the real page:

```
Expected: false
Received: true
```

This is the one inversion in the new file, and the header says so. It proves the walk reaches the real page and reads a real `hidden` property after four other interactions have run; it does not prove the six other assertions in the walk, and §5 names the one that would have failed an inversion.

**2. The hidden-container Russian sweep** — `layout.spec.ts`, the new §2.10 test. The original sweep filters by `isVisible`, and on a fresh load `.banner__slide[hidden]` and `.catalog-menu[hidden]` resolve to `display: none`, so slides 2–4 and every category and column item had never been read for Cyrillic by any test — `banner.spec.ts` and `catalog-menu.spec.ts` drive structure and timing, never language. The new test walks `.banner__slide` and `.catalog-menu` through `textContent`, which is readable regardless of paint. Inverted to demand at least one offender:

```
Received: 0
```

**3. The asset content-type guard** — `layout.spec.ts`. Every response whose path matches `/\/(assets\/[^/]+\.png|icons\/.+|favicon\.svg)(?:[?#]|$)/u` must carry a `content-type` starting `image/`. **31 real responses** matched on this seed. Inverted the same way:

```
Received: 0
```

Why this test exists is §7's first entry.

**4. A price in roubles** — `products.spec.ts`, crit 1:

```ts
expect(card.price, `card ${String(card.sku)}'s price ("${card.price}") is in roubles`).toMatch(/₽$/u);
```

Inverted to `.not.toMatch`:

```
card KEY-CS2-PRIME's price ("1290 ₽") should NOT match
```

`formatPrice` prints every price with a trailing `₽` by construction — `Currency` is a closed enum with one member — so this is close to a type-level fact already; but nothing under `e2e/` had ever read a `.product-card__price` node against the currency the criterion names. `buy-through.spec.ts` and the acceptance walk compare the text to itself, card against order page.

**5. Zero `--empty` on this seed** — `products.spec.ts`, the picture test:

```ts
expect(emptyMediaCount, "the seed gives every product a real image, so no card should carry --empty today — …").toBe(0);
```

Inverted to `.toBe(1)`:

```
Received: 0
```

**6. One order id, not one request** — `buy-through.spec.ts`, R9:

```ts
expect(new Set(createdOrderIds).size, `expected exactly one order to exist, captured ${String(createdOrderIds.length)}: …`).toBe(1);
```

Inverted to `.toBe(2)`:

```
Expected: 2
Received: 1
```

The method first tried here — Slice 5's "click two different Купить buttons once each and assert one `POST`", which had produced `saw 2` / `Received length: 2` — turned out unreliable on this harness and the test's comment records why: a real `location.assign` tears the document down as soon as the first click's `createOrder` resolves, which on localhost is consistently faster than a second `locator.click()`'s actionability round trip through CDP. Sequentially, the second click reported **`locator.click: Test timeout of 30000ms exceeded ... waiting for locator('button[data-sku]').nth(1)`**; fired concurrently through `Promise.all`, a silent single order. So the RED is the inversion above instead — the task's other sanctioned method — and the comment says which method failed and how, so nobody reaches for it again.

**Two changes carry no RED because they assert nothing.** `carousel.test.ts` and `countdown.test.ts` gained `@regression`, one line each — their own REDs are Slice 2's (`3 failed` without `+ count`, `6 failed` without the modulo, `2 failed` without `clearTimeout`) and `git diff` on both files shows exactly the tag line.

---

## 7. Also worth including

**The dev server answers a missing image with `200 text/html`, and two tests that were supposed to notice would not have.** Slice 5's verify found it by pointing a card's `src` at a path that does not exist: the `<img>` fell back to `--empty` as designed, and the network panel showed `200`, `text/html` — Vite's SPA fallback serving `index.html`, because a Chromium image request's `Accept` ends in `*/*;q=0.8` and Vite cannot tell "a route the client router will handle" from "a file that is not there". The page behaved correctly. The tests did not: `layout.spec.ts`'s sweep watches for `status >= 400` and saw `200`; `products.spec.ts`'s picture test accepted the `--empty` fallback as a pass; the landing's "97 of 97 `200`" count was true and meaningless. A PNG deleted from `public/assets/`, or an SVG source renamed so `render-card-art.ts` stopped producing one, would have passed the whole suite — and `render-card-art.ts`'s own header claimed the sweep would catch exactly that. Slice 5 §5.1 named two fixes; this slice made both. The content-type guard is the general one: `index.html` is always `text/html`, a real image is always `image/*`, and nothing under `/assets/`, `/icons/` or the favicon should ever legitimately answer HTML — 31 responses on the landing, every one checked. The `--empty` count is the specific one: on a seed with no `null` image, the fallback branch should never run.

**The two-click RED, found unreliable and replaced.** §6's sixth entry. Worth restating as a rule: a RED method that depends on a second Playwright action landing before a real navigation completes is a race against CDP round-trip time, and on localhost it loses. Inversion does not race anything.

**The `@regression` line, drawn once.** The Phase 1–3 convention was read from `phase-2-slice-8-the-acceptance-suite.md`: the tag belongs on the permanent regression suite — concurrency and unit files — and not on the acceptance suite. `apps/web` has no concurrency layer, so the reading that carries is "one-criterion-at-a-time guards carry it; the feature-level walk does not". Eight e2e specs and five unit files carry it; `acceptance.spec.ts` does not; the decision is in `e2e/support/orders.ts`'s header rather than in nine file headers. Two unit files Slice 2 wrote before that reading was settled had no tag and now do.

**The harness findings this suite carries, with the number each produced.** None is about the product; every one changed how a test is written.

| Finding | Where | Measured | Rule |
| --- | --- | --- | --- |
| A `page.on("response")` listener loses to `location.assign` | Slice 1 §6.2 | **1 orphan** order per buy-through; **0** with `page.route` + `route.fetch()` | Capture the id host-side, before the page sees the response it navigates on |
| `page.clock.install()` does not freeze time | Slice 2 §5.2 | crit 1's `runFor(4999)` → **`Expected: 1 Received: 2`**; `pauseAt(Date.now())` after `goto` → `Cannot fast-forward to the past` | `install({ time })` then `pauseAt(time + 100)` **before** `goto` |
| `waitForTimeout` in the MCP relay leaves the renderer unscheduled | Slice 2 §5.3 | the dot did not move; waited inside `page.evaluate` → **5 207 ms** window, dot 1 → 2 | Wait inside the page when a real timer must fire |
| Two suites, one database | Slice 1 §6.4 | **`orders = 55, expected 0`** | One runner at a time; `pnpm test:e2e` then `pnpm test`, never overlapping |
| The Playwright MCP is one browser | Slice 3 §5.3 | a `goto` from one agent navigated the other's tab | One driver at a time; no `src/` edits during a live drive (HMR rebuilds the page) |
| A computed style mid-transition | Slice 4 §5.1, third appearance | **`rgb(137, 137, 139)`** / `rgb(122, 122, 124)` — greys no rule names | Read end states after a wait past the duration; `SETTLE_MS = 250`, `CURRENCY_SETTLE_MS = 200` |
| The SPA fallback | Slice 5 §5.1 | **`200 text/html`** for a missing PNG | Assert `content-type`, not status (this slice) |
| The port near-miss | tech spec R19, `architecture.md` §7 | a proposed **4301** was already `single-issuance-under-races.test.ts`'s | 5101 / 5102, `--strictPort`, listed in the README's port row |
| The two-click RED | this slice, §6 | **`Test timeout of 30000ms exceeded`** on the second click; a silent single order with `Promise.all` | Invert the assertion instead |

**Read while writing this document — and, by a follow-up in the same slice, fixed.** The brief for the explain task forbade edits to any test file, so these were reported; the fixes below landed before the slice was ticked, each with its RED, and `pnpm test:e2e` (58 in 50.0 s) then `pnpm test` (11 / 90, 5 / 56) ran green after them with the baseline intact.

- **`acceptance.spec.ts`'s final `expect.poll` is vacuous.** §5 has the mechanism: `dotBeforeReturn` is read on the order page and is `-1`. The fix is one line moved — read it after `toHaveURL("/")`, as `buy-through.spec.ts` does — and one inversion to prove it.
- **The reported dispositions summed to 45.** This slice's own report said 39 covered, 1 caveat, 1 by hand, 4 documents; the spec has 44 criteria and the table in §4 has 44 rows. Counted row by row above: 38 covered. The extra one was most likely §2.1 crit 2 counted twice — once for the presence-and-order half the layout test proves, once for the labels half a person checked.
- **`architecture.md` §7's layer table is behind the tree.** It says "today `layout.spec.ts` and `inert-controls.spec.ts`, 20 tests in ~16 s" and "31 tests, ~130 ms" for the web unit suite — Slice 2's numbers. The tree has 58 and 56. The prose around it (the trigger, the RED discipline, the ports, the baseline) is current.
- **The asset guard's comment enumerates 30 of the 31 it announces.** "nine service-tile images, one 'more' glyph, sixteen UI/chip glyphs, four product-card PNGs" sums to 30; the strip has ten brand tiles — nine PNGs and `tiktok.svg` — so the missing one is almost certainly the TikTok vector. The assertion is unaffected; the number in the comment is.
- **R20 says the install command is "in the README".** There is no root `README.md`, still. The command lives in the config's preflight message, tech spec §4.2 and `architecture.md` §7 — which is enough for a reviewer who runs the suite once, and is not what R20 says.
- **§2.7 crit 3 is asserted from captured ids, not a row count.** §5. One statement through `db.ts`'s client would close it.

---

## 8. Where this sits in the assignment

`context/product/product-definition.md` §1.4 lists five adversarial scenarios; Phase 3's closing document scored them and added the column "on every `pnpm test`". Phase 4 changes nothing in that table — the storefront sends the same request — and adds a second one beside it, because `architecture.md` §7's coverage-target clause now reads: *"the five acceptance scenarios each map to a named, runnable test or script — and, since Phase 4, the storefront's five graded interactions map the same way to a spec under `apps/web/e2e/`."*

| # | Scenario | Status after Phase 4 | Runnable by name | On every `pnpm test` |
| --- | --- | --- | --- | --- |
| 1 | 50 parallel `paid` reports → one issuance fact, one key | Settled (Phases 1–2) | `pnpm race webhooks` | `fifty-webhooks-one-order.test.ts`, four processes |
| 2 | A repeated report with the same `event_id` changes nothing | Settled (Phase 1) | `pnpm race same-event` | `single-issuance-under-races.test.ts` |
| 3 | A report before its order | Settled (Phase 2) | `pnpm race before-order` | `single-issuance-under-races.test.ts` |
| 4 | Empty pool → recoverable → after restock, exactly one key | Settled (Phase 3) | `pnpm race recover-out-of-stock` | `operator-retry-race.test.ts` and `failure-and-recovery.test.ts` |
| 5 | A promo code with limit N under parallel requests | Phase 5. Not started | — | — |

Unchanged by this phase, and `pnpm race` still lists eight checks. What Phase 4 adds is the face on top of that engine, and the assignment grades exactly five things about it:

| # | Graded interaction | Spec under `apps/web/e2e/` | Model test under `src/` | Screenshot |
| --- | --- | --- | --- | --- |
| 1 | Banner carousel — arrows, dots, auto-advance | `banner.spec.ts` (8) | `carousel.test.ts` (25), `countdown.test.ts` (6) | `-banner-next.png`, `-banner-auto.png` |
| 2 | Catalog menu — open, close, click-outside | `catalog-menu.spec.ts` (6) | `menu.test.ts` (8) | `-menu-open.png`, `-menu-inner-click.png` |
| 3 | `$ / ₸ / ₽` — active state only | `currency.spec.ts` (5) | none — native radios, nothing to compute | `-currency-kzt.png` |
| 4 | Service tile hover | `hover.spec.ts` — four tile tests, plus the two that cover both (static duration, reduced motion) | none — a stylesheet | `-tile-hover.png` |
| 5 | Product card hover | `hover.spec.ts` — two card tests, plus the same two; `products.spec.ts` crit 2 smoke | none | `-card-hover.png` |
| — | The face joined to the engine | `buy-through.spec.ts` (3), `acceptance.spec.ts` (1) | `select-popular-products.test.ts` (7), `products-api.test.ts` (10) | `-buy-through-awaiting-payment.png`, `-buy-through-delivered.png` |
| — | The rest is static, on instruction | `inert-controls.spec.ts` (14), `layout.spec.ts` (8) | — | `-landing.png`, `-narrow-wrapped.png` |

The mapping `architecture.md` says "lives in the README" lives in this table until the README exists (§9).

---

## 9. What is not finished

- **The manual Chrome check.** The only evidence the cached-restore path will ever have, covering Slice 2's claim (the dot advances within 5 s of Back) and Slice 5's (Купить enabled, a second press creates a second order) in one minute. The user has been asked; `phase-4.md` carries "not proven" until the DevTools verdict is recorded.
- **The `@game-shop/db/testing` lift.** `e2e/support/db.ts` still duplicates `cleanupTestOrders`'s six statements with a comment naming the source of truth. Two callers now; the tech spec called the lift "the obvious follow-up" in §4.2.
- **A database per run.** `orders = 55` is what happens when two runners share one; `workers: 1` and "one runner at a time" are disciplines, not structure.
- **No root `README.md`**, still. Both mapping tables in §8, the install steps below, and R20's own sentence are waiting on it.

---

## Interview questions this answers

**"What does each of the three suites prove?"**
The web unit suite proves the five facts the page *derives* — wrap arithmetic, the one-slot timer policy, the menu rule, the five-from-twelve selection, the nullable `image` parse — as functions from values to values, 56 cases in under a fifth of a second, with no document. The browser suite proves that a real Chromium, driving the real page against a real API, sees the five graded interactions change state the way the criteria say, sees fourteen presses on decorative controls do nothing, and reaches a key from Купить — 58 tests in 45.5 s. The API suites prove the purchase itself — one intent one order, one payment one key, silence never a second key — across four processes with stock accounting, and they did not change, because the storefront sends the same request the plain page sent. Each suite is blind to the other two's subject: the unit suite cannot see the DOM binding, the browser suite cannot see whether the key it watched arrive was the only one cut, and the API suites cannot see the page.

**"Why three suites and one database? Why not isolate them?"**
Because the API suites' baseline assertion — `orders = 0`, `unclaimed = 50` before a file touches the pool — is the mechanism that makes every concurrency proof in Phases 1–3 trustworthy, and it is a statement about one global fact. The e2e buys real keys through that same engine, so it either restores that fact or breaks every suite after it. It restores it: ids captured host-side before the page can navigate, the same six cleanup statements as the API harness, `workers: 1`. The cost is an ordering rule — `pnpm test:e2e`, then `pnpm test`, never two runners at once — and Slice 1 measured what breaking it looks like: `orders = 55, expected 0`. A database per run would make the rule structural; nobody built it, and the document says so.

**"Why isn't `pnpm test:e2e` part of `pnpm test`?"**
It needs a browser and it starts two servers. A reviewer who runs `pnpm test` expecting the API suites should not be handed a 276 MB download or a port collision. So `pnpm test` is API then web unit — nothing it runs needs more than Postgres — and `pnpm test:e2e` is its own command that builds the API first, so the code under test is the code that runs, and hands Playwright a config that owns 5101 and 5102 outright. The config's two preflight checks say in one sentence what a bare run is missing.

**"You wrote these assertions after the behaviour existed. How do you know they can fail?"**
Each one was pointed at the wrong state, run, and read. The menu-closed assertion in the acceptance walk as `.toBe(false)` — `Expected: false / Received: true`. The hidden-container Russian sweep and the asset content-type guard each demanding an offender — `Received: 0`, twice. The rouble price as `.not.toMatch` — `card KEY-CS2-PRIME's price ("1290 ₽") should NOT match`. Zero `--empty` as `.toBe(1)` — `Received: 0`. One order id as `.toBe(2)` — `Expected: 2 / Received: 1`. Nothing under `apps/web/src` was touched. And one method was abandoned in the process: clicking two different cards to produce two orders races a real navigation against a CDP round trip and loses on localhost — the second click timed out at 30 s — so the test's comment says not to try it again. The one assertion that had *not* been inverted — the acceptance walk's "banner running after Back" — turned out to compare against `-1` and could not fail; it was fixed, and the inversion first tried on the fixed line (`.toBe(dotAfterReturn)`) was itself vacuous, because `expect.poll` is satisfied on its first read before the dot has moved. The RED that held is `.toBe(-1)`, a value the index cannot take once real dots exist: `Expected: -1 / Received: 1`, after the full 7.5-second poll — the `1` being a real dot index, which is what proves the read now happens on the storefront.

**"What can the suite not see, and how do you know rather than assume?"**
Five things, each with a measurement or a reason behind it. The cached restore — three attempts, three framings, every one `persisted: false` with `masked`; a debugging session disqualifies the page, and every automated browser has one. A fade *as seen* — a computed style mid-transition is an interpolated value that depends on when the round trip landed; Slice 4 caught `rgb(137, 137, 139)` doing exactly that, so the suite reads durations and end states only, and a person's eye on three screenshots is where "visibly" was judged. Delivery correctness — the browser watches one key arrive and has no way to count what left stock; the API suites do. Any browser but Chromium — one project. And the mockup's wording — a comparison with a Figma frame is not something a test makes, so §2.1 crit 2 says "verified by hand" and names the screenshot.

**"What does a reviewer need installed to run all of it?"**
Node ≥ 22.18 and pnpm 10.18 (`packageManager` pins it); `pnpm install`; Docker for Postgres — `pnpm db:setup` brings the container up on 5433, migrates and seeds; and once, `pnpm exec playwright install chromium` — one browser, revision 1243, a ~276 MB download and 368 MB on disk, measured. Then `pnpm test` (~45 s: API then web unit) and `pnpm test:e2e` (~46 s including the API build). If `DATABASE_URL` is missing the config says "run pnpm test:e2e from the repository root"; if the browser is missing it says "run: pnpm exec playwright install chromium". `pnpm race` is unchanged at eight checks and needs only Postgres.

**"Why does the acceptance file have no `@regression` when every other test file does?"**
Because of what a failure in it would tell you. The eight behaviour-level specs hold one criterion per `test()` and were written before the behaviour existed; when one goes red it names the criterion, and that is what a regression suite is for. The acceptance walk is one test through every interaction and a purchase in one session; when it goes red it says "the composed page broke somewhere", and the file to open is one of the other eight. That is the same line Phases 1–3 drew — `@regression` on the concurrency and unit files, never on `purchase-and-key-delivery.test.ts` or `failure-and-recovery.test.ts` — and Phase 3's slice 9 removed the tag from its own acceptance file when it found it there. The decision is written once, in `e2e/support/orders.ts`'s header, so eight files do not each repeat it.

**"Did the exercise find anything?"**
One hole that was not in its brief and would have hidden a broken page: the dev server's SPA fallback answers a missing PNG with `200 text/html`, so the 4xx sweep, the picture test's `--empty` branch and the "97 of 97" landing count would all have stayed green with a card-art file deleted. Closed both ways. Two criteria asserted by proxy — "one order exists" from a request count, "a price in roubles" never read — now asserted in their own words. A whole class of text nobody had ever checked for Cyrillic — three banner slides and the entire menu, hidden on load — now swept. Two unit files missing a tag. And, reading the result for this document, one assertion in the new file that cannot fail, and a handful of numbers that had drifted.

**"What is still not done?"**
The manual Chrome check, which is the only evidence the cached path will get. The `db/testing` lift, a database per run, and the root README — all carried from earlier phases, and each one more overdue than last time.

---

## Source files

- `apps/web/e2e/acceptance.spec.ts` — the one test; the header's "why this file exists at all", "real clock throughout", "why no `@regression`", and the RED paragraph; step 7's `dotBeforeReturn`
- `apps/web/e2e/support/orders.ts` — the `@regression` decision for every file under `e2e/`; the route-interception race; `createdOrderIds`
- `apps/web/e2e/support/db.ts` — the six statements, SQL quoted, `cleanupTestOrders` named as source of truth
- `apps/web/e2e/layout.spec.ts` — the visible sweep and the hidden-container sweep; the status sweep and the content-type guard, with the SPA-fallback paragraph
- `apps/web/e2e/products.spec.ts` — the name/price assertions; the `--empty` count and its message
- `apps/web/e2e/buy-through.spec.ts` — the R9 test's two assertions and the two-click comment; crit 4's `dotAfterReturn`, read after Back
- `apps/web/e2e/banner.spec.ts`, `catalog-menu.spec.ts`, `currency.spec.ts`, `hover.spec.ts`, `inert-controls.spec.ts` — the behaviour-level guards, one criterion per `test()`
- `apps/web/src/pages/storefront/model/carousel.test.ts`, `countdown.test.ts`, `menu.test.ts`, `select-popular-products.test.ts`, `apps/web/src/entities/product/api/products-api.test.ts` — the five unit files
- `apps/web/playwright.config.ts` — the two preflight throws, the two `webServer` entries, `workers: 1`, `retries: 0`
- `apps/web/vitest.config.ts` — `environment: "node"`, `include: ["src/**/*.test.ts"]`
- `package.json` (root) — `test`, `test:web`, `test:e2e`, `race`, `db:setup`
- `apps/api/test/concurrency/support/db.ts` — `assertBaseline`, the eight counts
- `context/spec/004-storefront-per-the-design/functional-spec.md` — the 44 criteria
- `context/spec/004-storefront-per-the-design/technical-considerations.md` §4, R13, R14, R15, R19, R20 — the three layers and what each cannot prove; the baseline; no mid-transition reads; faked versus real clocks; the ports; the browser install
- `context/product/architecture.md` §7 — the browser-tests bullet, its two findings table, and the coverage-target clause
- `docs/walkthrough/phase-4-slice-1-the-structure.md` §5, §6.2, §6.4 — the Купить RED, the fixture race, `orders = 55`
- `docs/walkthrough/phase-4-slice-2-the-banner.md` §4, §5 — the unit and clock REDs, `install()` not freezing time, the relay wait, the first bfcache verdict
- `docs/walkthrough/phase-4-slice-3-the-catalog-menu.md` §4, §5 — the menu REDs, the search-box outside click, the shared browser
- `docs/walkthrough/phase-4-slice-4-currency-and-hover.md` §4, §5 — the currency and hover REDs, the mid-fade read, the by-eye halves
- `docs/walkthrough/phase-4-slice-5-real-cards-and-buying.md` §4, §5 — the products and buy-through REDs, the SPA fallback, the third `persisted: false`
- `docs/walkthrough/phase-3-slice-9-acceptance.md` — the shape this document follows, and the scenario table §8 carries forward
- `docs/walkthrough/phase-2-slice-8-the-acceptance-suite.md` — the `@regression` convention
- `docs/screenshots/004-storefront-per-the-design-*.png` — eleven files: landing, narrow-wrapped, banner-next, banner-auto, menu-open, menu-inner-click, currency-kzt, tile-hover, card-hover, buy-through-awaiting-payment, buy-through-delivered

**On evidence:** what I ran fresh while writing this document, against the tree as it stands, with no server started, no browser opened, and no source, test or config file modified. `grep -c` on `test(` declarations across the nine e2e files: 1, 8, 3, 6, 5, 8, 8, 8, 5 — with `inert-controls.spec.ts`'s one declaration inside a seven-chip loop, 14 tests there and **58** in total, matching the reported run. The same over the five unit files: 25, 7, 8, 6, 10 — **56**. `grep "^// @regression"`: eight e2e files and five unit files carry it as a tag line; `acceptance.spec.ts` mentions the word three times in prose and carries no tag. `git diff` on `carousel.test.ts` and `countdown.test.ts`: one added line each, the tag. `git diff --stat` on `layout.spec.ts` (+100) and `support/orders.ts` (+74 / −7). `ls docs/screenshots/004-*`: eleven files. `find apps/web/public -type f`: 39 files — 10 under `assets/`, 11 under `icons/services/` (nine PNG, `tiktok.svg`, `more.svg`), 17 under `icons/ui/`, the favicon. `packages/db/src/fixtures/catalog.ts`: twelve `image:` values, none null, four distinct on the five popular cards. `.env.example`: `POSTGRES_PORT=5433`. `scripts/race/README.md`'s port row: 5101–5102 present. Root `package.json`: `engines.node >=22.18`, `packageManager pnpm@10.18.0`, the three `test*` scripts as quoted in §3. `ls README.md`: no root README. I read `acceptance.spec.ts`'s step 7 and `buy-through.spec.ts`'s crit 4 test side by side, which is how the vacuous poll was found; the ten section counts of the functional spec by hand — 5, 7, 6, 4, 4, 5, 4, 4, 4, 1 — 44.

Everything else is reported by other agents and quoted rather than re-run: the three suite totals and durations (58 / 45.5 s; 56 / ~190 ms; 90 / ~44–46 s) and the baseline holding before and after; the six Slice 7 RED lines and the 31 matched responses; the two-click timeout; the slice REDs in §4's rows; the three bfcache measurements; the 276 MB / 368 MB Chromium; the `orders = 55`, the `1 orphan`, the `5 207 ms`, the `rgb(137, 137, 139)`; and the screenshots, which I opened only by name.
