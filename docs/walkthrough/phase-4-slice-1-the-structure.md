# Phase 4 · Slice 1 — The structure

> Nothing in this slice moves. The mockup's five blocks are on the page at `/`, in its order, in Russian, with every control the assignment leaves unwired present and doing nothing; the product row still shows Phase 1's plain card — all twelve of them — because the five-card selection and the picture are Slice 5's. What the slice settles is the *shape* the four interaction slices build into, and three decisions about that shape which look like taste and are not.
>
> Three things are worth the reader's attention. **The page is inert by what it is made of, not by what it cancels**: zero `<a>` and zero `<form>` elements, so Enter in the search field and a press on «Оплатить» have no default action for a listener to intercept — and no listener to lose. **A stylesheet's location says nothing about where it applies**: `storefront.css` is in the bundle on `/order/:id` too, and the only thing keeping it off that page is that all **102** of its selectors start with a storefront-owned class — a fact a script can check, and did. And **the one layout decision the spec made was reversed by the user while the sheet was being written**, and the spec carries a dated change-log entry rather than a silent edit.
>
> Reading the delivered work found four things, none in the slice's brief. A cascade-order fact nobody had written down: `app/styles.css` is injected *after* `storefront.css`, so a leftover `.product-card__buy { font: inherit }` was silently thinning the pill from weight 600 to 400 until task 4 deleted it. A fixture race that would have left one orphan order behind every buy-through, found by RED and fixed before the task was ticked. The Figma export budget ran out mid-task, so nineteen of the twenty-nine asset files are hand-authored. And the first `pnpm test` after the e2e failed with `orders = 55, expected 0` — not the e2e's fault, and the lesson is in §6.

---

## 1. What actually shipped

| # | Change | Where | Size |
| --- | --- | --- | --- |
| 1 | The storefront page slice: public API, `CLAUDE.md`, four `config/` files (all Russian copy, `as const`), six `ui/` sections plus the glyph helper, and the composer | `apps/web/src/pages/storefront/` | `index.ts` 2 lines; `storefront-page.ts` 50; `header.ts` 61, `catalog-menu.ts` 59, `services-strip.ts` 35, `steam-topup.ts` 105, `popular-products.ts` 100, `icon.ts` 50 |
| 2 | The page's stylesheet — the mockup's blocks, the fluid column, the currency control's `:checked` state; no hover rules yet | `pages/storefront/ui/storefront.css` | **978 lines, 102 selectors**, 0 element-level rules |
| 3 | The artwork: nine brand tiles, two vector tiles, seventeen UI glyphs, a favicon | `apps/web/public/` | **29 files, 228 KB**, none over 31 KB |
| 4 | Router fallback → `createStorefrontPage()`; `pages/catalog/` deleted; `app/styles.css` cleaned and re-headed; three future-tense comments moved to the past; the favicon line | `app/router.ts`, `app/styles.css`, `index.html`, `poll.ts`, `buy-controls.ts`, `product-card.ts` | `app/styles.css` keeps one element rule: `body` |
| 5 | The Playwright project: config, two support modules, two specs | `apps/web/playwright.config.ts`, `e2e/support/{db,orders}.ts`, `e2e/{layout,inert-controls}.spec.ts` | **20 tests**, 15.5–17.4 s; ports **5101 / 5102** |
| 6 | Wiring for 5: `tsconfig.node.json` (`lib: DOM`, `include` gains the config and `e2e`), `.gitignore` (`apps/web/e2e/.results/`), root `test:e2e` and `test:web`, the README's port row | root and `apps/web` | — |
| 7 | Two screenshots | `docs/screenshots/004-storefront-per-the-design-landing.png`, `-narrow-wrapped.png` | 1 280 × 800 and 1 000 × 800 |

Two things in that directory are **not** this slice's: `model/carousel.ts`, `model/countdown.ts`, their tests, and the bound `ui/banner.ts` belong to Slice 2, which ran in parallel and is why `pnpm test` now reports a web unit suite. Slice 1 rendered the banner still — slide 1 showing, arrows inert, four dots — and Slice 2 gave it a clock.

Change 4 is the one to notice for what it *removes*. Phase 1's catalogue page is gone, not kept beside the new one: only `router.ts` imported it, `typecheck` fails loudly on any stale reference, and the three sentences that spoke of Phase 4 in the future tense now speak of it in the past. `poll.ts`'s last paragraph is the interesting one — it used to promise that "when a second page needs it, this file moves down a layer unchanged", and the second page arrived and needed something else (a countdown that waits before its first tick, pauses, resumes, and comes back on `pageshow`), so the sentence now says so rather than being quietly deleted.

The measurements the verify task took against the delivered page, quoted rather than re-run: five sections in DOM order with tops **0 / 164 / 308 / 1220 / 1539** at 1 280 wide as first measured — strictly ascending, which is the fact the spec asks for; the values belong to that first measurement, the test asserts the ordering, and the screenshot taken later with the finished sheet has the Steam block far higher. **0 `<a>`, 0 `<form>`.** **59 visible text nodes**, every one Cyrillic, letterless, or on the brand allowlist; the only two with no Cyrillic that are not bare brand captions are the seed product names `Xbox Gift Card 1500 ₽` and `Roblox 800 Robux`, which `entities/product`'s card renders — not the page — and which the allowlist admits word by word. **89/89** requests answered 200 on the landing.

---

## 2. The words this document uses

- **Fluid column** — the page fills the window at any width; the content column has a *maximum* (1 280 px) and auto margins, so above the cap it is centred with equal space either side and below it it is the window. The opposite is a *fixed* column: a `min-width` on the frame, so a narrow window gets a horizontal scrollbar rather than a reflow.
- **Inert by construction** — a control that does nothing because the markup gives it nothing to do: a `<button type="button">` with no handler, an `<input>` with no `<form>` around it. Distinct from *inert by cancellation*: a control with a default action and a listener whose job is to call `preventDefault()`.
- **Scope-by-selector** — a stylesheet whose every rule begins with a class the page owns, so it matches nothing on any other page even though it is loaded there. Distinct from *scope-by-placement*, the belief that a file under `pages/storefront/` applies only on the storefront. This project has no mechanism for the second; it has a rule and a check for the first.
- **Leftmost compound** — the first simple-selector group in a selector, reading left to right: in `.services__list .service-tile img` it is `.services__list`. The rule is about this position because it is the one that decides whether a rule can match at all on a page that has none of the storefront's classes.
- **Route interception** — Playwright's `page.route()`: the page's own `fetch()` is handed to a handler on the test's side, which can perform the real request itself (`route.fetch()`), read the body, and only then answer the page (`route.fulfill()`). Distinct from `page.on("response")`, a *listener* that sees the response after the page already has it.
- **bfcache** — the browser's back/forward cache, which restores a page *as it was left* rather than reloading it. Mentioned here only because Slice 2's `pagehide`/`pageshow` handling exists and Playwright disables the cache; this slice has nothing to say about it beyond that.

---

## 3. The three decisions the task names

Each in the same shape: what was built, the more obvious alternative, and what goes wrong without the decision — with the exact markup or CSS fact beside the plain-language reason.

### 3.1 Page-local sections, not a `widgets/` layer

**What.** Six modules under `pages/storefront/ui/` — `header.ts`, `catalog-menu.ts`, `banner.ts`, `services-strip.ts`, `steam-topup.ts`, `popular-products.ts` — each exporting one `create*` function, each with exactly one caller, `storefront-page.ts`, which composes them in the mockup's order and owns nothing else: no state, no listener, no timer. There is no `widgets/` directory in `apps/web/src`. The Russian copy sits in `config/` (the FSD segment for constants, not an invented `content/`), and the page's public API is one named export, `createStorefrontPage`.

**The obvious alternative.** Feature-Sliced Design's `widgets/` layer: `widgets/header`, `widgets/banner`, `widgets/services-strip`, and so on — six slices, each with its own `index.ts`, `ui/` segment and `CLAUDE.md`, imported by the page through six public APIs. That is what the methodology's layer table says a "composite UI block" is, and a reviewer who knows FSD will ask why it is not here.

**What goes wrong with the alternative.** Six public APIs, six `CLAUDE.md` files and six layer boundaries for code that has one caller each — and, by the spec's own scope, *cannot* gain a second this phase: the order page and the operator's screen are explicitly left alone (functional spec §3, "a redesign of the order page or the operator screen" is out). The project lifts code only when a second caller exists; `shared/lib/format-price.ts` and `pages/order/model/poll.ts` both say so in their headers, and `architecture.md` §1 names five layers, not six. A `widgets/` layer created for this page would be ceremony with no boundary to guard.

The same reasoning puts the three interactive blocks — carousel, menu, currency control — in the page's `model/` and not in `features/`. `buy-product`'s own header defines a feature here as one thing a shopper does *with a domain effect*; none of the three touches an entity or the API. The one control on the page that does — «Купить» — *is* a feature, and the page's entire involvement with it is one line in `popular-products.ts`: `enableBuyControls(region)`, handed the region rather than the buttons because the buttons arrive with the catalogue and could be replaced again.

What the decision keeps: the import direction. The page imports downward — `entities/product`, `features/buy-product`, `shared/lib/dom` — and the sections import `../config/*` and `./icon.js` and nothing from each other. If a second page ever wants the header, the code moves to `widgets/` then, unchanged; "lift on the second caller" is a rule about *when*, not *whether*.

### 3.2 Inert by construction, not by `preventDefault`

**What.** The search box is `<div role="search">` around a bare `<input type="search" aria-label="Поиск" autocomplete="off">` and two `<button type="button">`s (heart, search). The Steam block is a `<section>`, not a `<form>`: a bare `<input type="text" aria-label="Логин Steam" autocomplete="off">`; «Сумма / 500 ₽» as static text, not an input; the «i» as a glyph in an `aria-hidden` span, not a button; «Оплатить 500$» and «Ввести промокод» as `<button type="button">` with no handler. The chips are `<button type="button">` with «Донат» carrying `chip--active` as a class only — no `aria-pressed`, which would claim toggling works. «еще 841» is the eleventh tile with the same markup as the other ten. Inside the overlay, the five categories are `<button type="button">` and the column entries are `<li>` text. Across the whole page: **0 `<a>`, 0 `<form>`** — `grep` over `pages/storefront/` for `createElement("a"` and `createElement("form"` finds nothing, and `layout.spec.ts` asserts `document.querySelectorAll("a, form").length === 0` in a browser. The only navigation on the page is `window.location.assign` in `features/buy-product`.

**The obvious alternative.** Mark up the search as a `<form>` — it *is* a search, after all — and add a `submit` listener that calls `preventDefault()`. Make the tiles and chips `<a href="#">` with a click handler that cancels. Give the Steam block a `<form>` so a future phase can wire it.

**What goes wrong with the alternative.** A `<form>` gives Enter a default: submit. A listener whose only job is to cancel that default is a control pretending to be wired, and it holds only while the listener holds. Lose it — a refactor that rebuilds the header, a handler bound before the element exists, an exception thrown earlier in the same handler — and the browser does what forms do: navigates to `/?q=…`, a full page load, the banner back on slide 1, the menu closed, the shopper's typed text in the address bar. Nothing warns. With no `<form>`, there is no default action for anything to lose; Enter in a bare input is a keystroke. The same holds for `<a href="#">`: the cancel is one missed listener away from a scroll-to-top and a `#` in the URL.

This is also why the *look* is not neutralised. Every inert control has `cursor: pointer` and — from Slice 4 — a hover state, because the spec's scope line for them is "visibly present and quietly inert" and a `disabled` attribute or a default cursor would read as broken. What §2.8 forbids is a *promise*: a spinner, a "coming soon", a message. A button that looks pressed and does nothing is honest; a button that shows a spinner and does nothing is not.

And it is why Slice 3's graded criterion — "a click inside the menu changes nothing" — is already true of the markup before any listener exists. The menu's inner clicks are inert because nothing inside the overlay has a default; the listener Slice 3 adds classifies clicks, it does not suppress them.

### 3.3 Placement does not scope CSS

**What.** `storefront.css` is imported once, by `storefront-page.ts` (`import "./storefront.css"`). `app/router.ts` imports all three pages statically — `createAdminRecoveryPage`, `createOrderPage`, `createStorefrontPage` — so the sheet is in the module graph on every route, and Vite emits it into the same bundle. What keeps it off `/order/:id` and `/admin/recovery` is selectors: the leftmost compound of every one of its **102** selectors is one of `.storefront`, `.header`, `.search`, `.icon`, `.catalog-menu`, `.banner`, `.services`, `.service-tile`, `.steam-topup`, `.currency`, `.popular`, `.chip` or `.product-card`, with their `__elements` and `--modifiers`. There is no `body`, `html` or `*` rule and no bare `button`, `input`, `img`, `h1` or `ul` — not even as the leftmost compound of a descendant selector. The tokens (`--sf-ground`, `--sf-surface`, `--sf-ink`, `--sf-muted`, `--sf-radius`, `--sf-shadow`) are declared on `.storefront`, not `:root`, for the same reason. In the other direction, `app/styles.css` lost `.catalog*` (the page is gone) and `.product-card*` (its `border-top` and padding would have landed on the new cards, since the class is shared), kept `.buy-product__error` (feature-owned, still used) and every order/admin rule, and keeps exactly one element rule — `body { margin: 0; font-family: system-ui, sans-serif; line-height: 1.5 }` — which the storefront deliberately inherits and which its header says must never gain a sibling.

**The obvious alternative.** Trust the file's location: it is under `pages/storefront/`, so it is the storefront's. Or make that literally true with a dynamic `import()` per route, so the sheet loads only when the page does. Or reach for CSS Modules and let the build mangle the class names.

**What goes wrong with the alternative.** Location is a fact about the file system; the cascade reads the document. A `button { font: inherit }` or `img { display: block }` written in `storefront.css` lands on the order page's payment-simulation buttons and on the operator's screen the moment those pages render, because the sheet is there and the elements match. A dynamic import would hide the rule rather than state it, and would trade a sub-100-KB bundle's single request for a per-route waterfall on a page whose whole argument is that it is hand-built and small. CSS Modules solve name collisions between components; the hazard here is *element* rules, which a module system does nothing about.

The verification was the one R4 prescribes: on `/order/:id` and `/admin/recovery`, the count of elements matching any storefront selector is **0**, `body`'s computed `min-width` is **`0px`**, and both pages are pixel-identical to their `003-*` screenshots. And the direction nobody was watching is the one that had the bug — see §6.1: the cascade *order* of the two sheets is decided by an import order in `mount-app.ts` that nobody chose for that reason, and a shared class name let a rule from the old sheet win a tie it should never have been in.

---

## 4. The layout reversal

**What the spec said.** Functional spec §2.1 criteria 3–4 as first written: a fixed column of the mockup's width, and in a window narrower than the column "the layout keeps its full width and a horizontal scrollbar appears". Technical-considerations §2.6 spelled out the CSS — `.storefront { min-width: 1240px }`, `__column { max-width: 1280px }`, `__content { width: 1200px }` — with 1 240 rather than 1 280 so a vertical scrollbar at exactly 1 280 px would not force a horizontal one. `tasks.md`'s task 2 records that instruction verbatim, and its Slice 1 blockquote still says "a fixed column that scrolls sideways when the window is narrow".

**What the user said, while the sheet was being written.** The opposite: the page takes 100 % of the window; the column is capped at 1 280 px and centred; rows wrap below the cap. Mobile stays out of scope.

**What was built.** `.storefront { min-height: 100vh; background: var(--sf-surface) }` with no `min-width`. `.storefront__column { position: relative; max-width: 1280px; margin: 0 auto }`. `.header` and `.storefront__content` carry `padding: 0 40px` rather than a 1 200-px width, so at the cap the measure is exactly the mockup's 1 200 px and below it the content is the window minus 80. Rows wrap: the tile strip is `flex-wrap: wrap`; the Steam block's two fields are `flex: 1 1 260px`; the card grid is `repeat(auto-fill, minmax(227px, 1fr))`; the overlay's text columns are `auto-fit`. No `overflow-x` anywhere. Measured at 1 000 × 800: the eleven tiles wrap **8 + 3** (`tops [375×8, 503×3]`), the «Оплатить» button drops to a second line inside the Steam block, the card grid goes to three columns, and **0** elements extend past the right edge. At 1 280 × 800: no horizontal scrollbar and the column centred — the test asserts `|leftGap − rightGap| ≤ 1`.

**Why a change log and not a silent edit.** The spec is the document a reviewer reads *before* the code, and the task list quotes the spec's numbers. Edit the spec quietly and a reader now has three artefacts — a task saying `min-width: 1240px`, a spec saying fluid, and a sheet saying fluid — with no way to tell which one is the mistake and no record that a decision was ever made. The functional spec's Change Log carries a dated entry (2026-09-13) naming the task, the source of the decision ("user decision during implementation"), what changed and why; §2.6 of the technical spec was amended in place with a parenthetical saying the same; assumption 13 is marked superseded. The stylesheet's own header repeats the story so the file explains itself without the spec open.

The residue is small and reported at the end of this document: the technical spec's §4.2 test table and §4.4 still describe a narrow-window scrollbar, and the task blockquote does too. The tests were written to the amended criteria, as task 5's text instructs.

---

## 5. What the two e2e specs prove, and how each was shown able to fail

**The project first.** `apps/web/playwright.config.ts` owns both servers: the API on **5102** (`pnpm --filter @game-shop/api run start`, readiness on `/api/health`, with the same five env lines `apps/api/test/concurrency/support/api-instance.ts` sets so the instance's webhook and supplier calls loop back to itself) and Vite on **5101** (`vite --port 5101 --strictPort`, `WEB_API_BASE_URL` pointing at 5102 so the `/api` proxy targets the e2e API). Both are `reuseExistingServer: false`, so a stray process on either port fails the run loudly rather than testing against whatever was already there. `workers: 1`, `fullyParallel: false` (one database, one 50-key pool), `retries: 0` (a pass on the second try is a false statement). Two preflight checks throw before any test: `DATABASE_URL` missing → "run pnpm test:e2e from the repository root"; Chromium missing → "run: pnpm exec playwright install chromium". The browser installed for this was Chromium revision **1243**, about **276 MB** — larger than the spec's "~150 MB" estimate, and a reviewer should know that before running the install.

One wiring detail is worth knowing before anyone adds a third spec: `tsconfig.node.json` needed `lib: ["ES2023", "DOM", "DOM.Iterable"]`. The `page.evaluate(() => …)` callbacks in the specs run in the browser, but the compiler checks them against the *enclosing file's* lib, and the enclosing file is Node-side. The app's own `tsconfig.json` keeps `types: []` and is untouched, so the bundle never sees Playwright or Node.

**`e2e/layout.spec.ts` — 6 tests, functional spec §2.1 as amended, §2.10, R5/R10.**

| Test | Asserts |
| --- | --- |
| The five sections appear in the mockup's order | `.header`, `.banner`, `.services`, `.steam-topup`, `.popular` all present; each `getBoundingClientRect().top` ≥ the previous; `.popular` is `.storefront__content`'s last child — nothing renders below it |
| No `<a>` and no `<form>` | `document.querySelectorAll("a, form").length === 0` |
| At 1 280 × 800 | `scrollWidth ≤ clientWidth`; the column's left and right gaps differ by ≤ 1 px |
| At 1 000 × 800 | `scrollWidth ≤ clientWidth`; the column's width ≈ the viewport's; the eleven `.services__item`s have more than one distinct `top` |
| Every visible text node is Russian, letterless, or an allowed brand | A `TreeWalker` over `document.body`'s text nodes, visibility by computed style and box size; a node fails only if it has no Cyrillic, has a letter, and still has a letter after every allowlisted brand is stripped |
| No response ≥ 400 during load | `page.on("response")` armed before `goto`; waits for the row to settle and `networkidle` |

RED, two ways. Write-first against the empty page is available for new behaviour and was used — a spec written before its section fails on a missing element, which is weak but real. Stronger, for the two assertions most likely to pass vacuously, the assertion was inverted and run against the finished page: `toBeGreaterThan(0)` on the `<a>`/`<form>` count → **`Received: 0`**; `scrollWidth > clientWidth` at 1 000 wide → **`Received: 1000`**. The second is the layout reversal made checkable: the pre-reversal spec would have *passed* that inverted line.

**`e2e/inert-controls.spec.ts` — 14 tests, functional spec §2.8, all four criteria.**

One function, `assertInert(page, act)`, and fourteen callers: type «тест» and press Enter in the search field; click the heart; click the search button; click the profile button; click the promo control; click each of the seven chips; click «еще 841» (the last `.service-tile`); type a login and click «Оплатить». The function arms every listener *before* `act` runs — `page.on("request")` filtering `resourceType() === "document"` and `POST` to `/api/orders`, `page.on("pageerror")` — records the URL and every visible text node matching `/скоро|coming soon|загруз/iu`, runs the action, waits a bounded 500 ms (there is no signal to wait *for* when the expected outcome is nothing), and then asserts six absences: no document request, no `POST /api/orders`, URL unchanged, no page error, no `[aria-busy="true"]`, no *new* promise-shaped sentence. The «Загрузка каталога…» that is legitimately on the page while the catalogue loads is captured before the click, so only a sentence that *appeared* counts.

RED here is not write-first, and the file's header says why: "nothing happened" is the assertion most likely to pass vacuously — a listener attached after the click, a resource-type filter that matches nothing, a URL read from the wrong frame, and every test is green forever. So the proof is the identical `assertInert`, unmodified, pointed at the one control on the page that *does* something: the first «Купить». It failed on three lines:

```
a document (navigation) request was issued: …/order/ord_01M2DT7ZJNG6QT805ZYPV30HNZ
a POST /api/orders request was issued
the URL changed from http://localhost:5101/
```

That is the detector seeing exactly the three things it is supposed to see — a navigation, a purchase, a moved address bar — and it is what makes the fourteen green rows a statement rather than a silence. The order that run created was cleaned up by the fixture; that it *was* cleaned up is the subject of §6.2.

**Together: 20 tests, 15.5–17.4 s** across the runs the slice recorded, both servers included.

**What they do not prove.** Nothing about hover, the banner, the menu or the currency control's active state — those are Slices 2–4's specs. Nothing about buying — Slice 5's. And the fixture's cleanup path is exercised by no committed spec: `layout.spec.ts` and `inert-controls.spec.ts` create no orders, so `trackCreatedOrders`'s teardown takes its early return on every test. The path was exercised by the throwaway repro in §6.2 and by the «Купить» RED, and will be exercised on every run once `buy-through.spec.ts` exists.

---

## 6. Findings

### 6.1 The cascade order, and the tie nobody knew was being decided

`app/mount-app.ts` reads, in this order:

```ts
import { resolveRoute } from "./router.js";

import "./styles.css";
```

`router.js` imports `pages/storefront/index.js` → `storefront-page.js` → `storefront.css`. So `storefront.css` enters the module graph — and the document — *before* `app/styles.css`, and when two rules of equal specificity disagree, `app/styles.css` wins. Nobody chose that order for that reason; it is the order the imports happen to be written in.

Until task 4, `app/styles.css` still held Phase 1's `.product-card__buy { font: inherit; … }`. `storefront.css`'s `.product-card__buy` sets `font: inherit` and then `font-weight: 600`. Same selector, same specificity, and the old sheet's `font: inherit` came *later* in the cascade — so it reset the weight to 400 and the «Купить» pill rendered regular, not semibold. Nothing errored; the page just looked slightly wrong, in a way a reviewer comparing to the mockup would see and a reviewer reading `storefront.css` could not explain. Task 4 deleted the old rule; the before/after diff of **60** computed properties on the pill showed exactly **one** difference, `font-weight: 400 → 600`.

The lesson is the second half of §3.3: "no leak" has to be checked in *both* directions, and the direction from the old sheet into the new page is the one a shared class name (`.product-card`, which the entity owns and both pages have styled) opens. The header of `app/styles.css` now says the file must never gain a `body`-level rule beyond the one it has, and must never start a selector with a storefront-owned block.

### 6.2 The fixture race, found by RED before the task was ticked

`e2e/support/orders.ts` exists for R13: every order the browser creates must be deleted before the API suites run, and the id must be captured *before any assertion* so a test that fails mid-way still cleans up. The first version captured it with `page.on("response")` and a fire-and-forget `response.json()`.

That loses a real race, every time «Купить» is actually pressed. `buy-controls.ts`'s `buy()` awaits `createOrder`, which resolves the instant the page's own `fetch()` has the response, and calls `window.location.assign("/order/…")` on the very next line — no `await`, no tick between. The navigation tears down the document and the network loader behind that response before Playwright's side-channel `response.json()` — a separate CDP round trip — has run. The read rejects; the `.catch(() => {})` swallows it; the id is never pushed; the row stays. RED: a throwaway single-test repro (click «Купить», wait for `/order/ord_`, nothing else) left **1** orphan order in the database with the listener version.

The fix is route interception. `page.route("**/api/orders", …)`: the page's `fetch()` is handed to the handler; the handler calls `route.fetch()` itself and has the body as text; it parses the id; *only then* does it call `route.fulfill({ response, body })`, which is the moment the page's promise resolves. The id is in hand strictly before `buy()` can reach its next line, because nothing on the page runs until the handler returns. A `framenavigated` listener reads the id out of the URL as a fallback for any future path the route never sees (a redirect, a service worker); the two sources are deduplicated. Same repro: **0** orphans. The fixture is `auto: true`, so every spec gets it whether or not it names it.

One more thing was found while restoring the file after the RED: the glob `**/api/orders` had been written inside a `/** … */` block comment, and the literal `**/` closed the comment early. In the file as it stands the glob is a named constant, `ORDERS_ROUTE_PATTERN`, and the header refers to it by name rather than spelling it out.

Why it matters beyond tidiness: the API suites assert `orders = 0` *before* they run. One orphan per buy-through means `pnpm test` after `pnpm test:e2e` fails on a baseline the e2e was supposed to restore — and the failure would look exactly like the one in §6.4, with a different cause.

### 6.3 The Figma cap, and what "from Figma" means for each file

The plan (technical-considerations §2.7) was to export every icon per node from the design file. The nine brand tiles got out: `download_assets` on the strip node returned 14 PNGs at 240–1920 px, 3 MB raw, downscaled with `magick` to **144 × 144** (2× of the 72-px tile), and the raw exports were never committed. Then the Figma MCP hit the Starter plan's tool-call cap mid-task. `tiktok.svg`, `more.svg`, and all **17** UI glyphs under `icons/ui/` — catalog, search, heart, profile, two arrows, two chevrons, info, wallet, seven chip glyphs — are **hand-authored**, drawn to the mockup's shapes rather than exported from them. The favicon was always going to be generated (the file has none).

The result: **29 files, 228 KB, none over 31 KB**; **89/89** requests 200 on the landing. Delivery is as the spec says — brand tiles as `<img alt="">` with the caption as visible text beside them, glyphs as `<span class="icon icon--<name>" aria-hidden="true">` painted through CSS `mask-image` with `background-color: currentColor`, because `createElement` cannot build SVG-namespace nodes and `innerHTML` is banned. `icon.ts`'s `glyphNames` list is closed on purpose: a name not in `public/icons/ui/` is an empty box, so the type refuses any string.

What it means for fidelity: the glyphs are approximations; the assignment waives pixel fidelity; the brand tiles — the things a reviewer recognises at a glance — are the real rasters. `config/services.ts`'s comment still says the two SVG tiles are "the two the file offers as vectors", which was the plan and not what happened; reported below.

### 6.4 The concurrent-suite collision: two suites, one database

The verify task's order was the one R13 prescribes: `pnpm test:e2e`, then `pnpm test`, and the second must be green because the first restored the baseline. The first `pnpm test` failed:

```
orders = 55, expected 0
```

This was **not** flakiness and not the e2e's orphan. Another agent — Slice 2, running in parallel — was running `pnpm test` against the same local Postgres at the same moment, and the API suites create and delete orders as they go. The re-run, alone, was green: **11 files / 90 tests** for the API suites and **2 files / 31 tests** for the web unit suite Slice 2 had added by then.

The lesson deserves to be stated plainly rather than as a footnote. The API suites' baseline assertion — `orders = 0`, `unclaimed = 50` before a file runs — is a statement about a *global* fact in one database, and it is the mechanism that makes every concurrency proof in Phases 1–3 trustworthy. It cannot be shared between two runners. Every file in `apps/api/test` already serialises for this reason (`fileParallelism: false`); the e2e serialises for this reason (`workers: 1`); and now there is a third thing that has to serialise, which is *people* (or agents) running suites on one machine. R13 is this fact seen from the e2e's side; `orders = 55` is the same fact seen from the API's side. The fix that would make it structural — a database per run, or a schema per runner — is not built and is listed in §8.

---

## 7. Interview questions this answers

**"Why is everything else on the page static? That looks like the shortcut."**
It is the instruction, in the assignment's own words: structurally close to the mockup, not pixel-perfect, content may be static, and exactly five interactions graded — the banner, the catalog menu's open/close, the currency control's active state, the service-tile hover, the card hover. `product-definition.md` §2.3 quotes it; functional spec §2.8 turns "the rest is static" into four acceptance criteria and fourteen tests. The reason it is not a shortcut is what the alternative would be: wiring the search means inventing what it searches; wiring «Оплатить» means inventing a Steam top-up the shop does not sell; recalculating on the currency control is explicitly waived, and the mockup's «$» beside a rouble sum stays as drawn. A half-wired control — a spinner, a "coming soon" — is worse than an inert one, because it promises. So "static" here is a tested property: fourteen tests assert that fourteen controls do nothing, and the assertion was shown able to see a control that does something.

**"Why no `widgets/` layer? Isn't that what FSD says a header is?"**
Every block on this page has one caller and, by the spec's scope, cannot gain a second this phase — the order page and the operator's screen are left alone. The project lifts code only on a second caller; `format-price.ts` and `poll.ts` say so, and `architecture.md` names five layers. Six single-use slices with six public APIs would be ceremony with nothing to guard. The three interactive blocks are page state and not features for the same discipline: a feature here is one thing a shopper does with a domain effect, and none of carousel, menu or currency touches an entity or the API. The one thing that does, «Купить», is a feature, and the page calls it in one line. If the header ever has a second page, it moves to `widgets/` then, unchanged.

**"Why not a `<form>` with `preventDefault`? A search *is* a form."**
Because a listener whose only job is to cancel a default is a control pretending to be wired, and it holds exactly as long as the listener does. Lose it — a rebuild of the header, a handler bound too early, an exception earlier in the same handler — and the browser submits: a full navigation to `/?q=…`, the banner reset, the menu closed, and nothing warns. With no `<form>`, Enter in a bare input is a keystroke; there is no default to lose. The page has zero `<a>` and zero `<form>`, both asserted in a browser, and the only navigation on it is `location.assign` in the buy feature. The same reasoning is why Slice 3's "inner clicks are inert" is true of the overlay's markup before any listener exists: categories are `<button type="button">`, entries are `<li>` text.

**"Your stylesheet is under `pages/storefront/`. Why does it matter where it applies?"**
Because location is a fact about the file system and the cascade reads the document. `router.ts` imports every page statically, so `storefront.css` is in the bundle on `/order/:id` and `/admin/recovery`, and it would apply there if anything in it matched. What keeps it off those pages is that all 102 of its selectors start with a storefront-owned class — no `body`, `html`, `*`, no bare element, not even leftmost in a descendant selector — and the tokens live on `.storefront`, not `:root`. Checked on both pages: zero matching elements, `body` `min-width` `0px`, pixel-identical to the Phase 3 screenshots. And the direction I was not watching is where the bug was: `mount-app.ts` imports the router before `app/styles.css`, so the old sheet wins ties, and a leftover `.product-card__buy { font: inherit }` was resetting the pill's weight from 600 to 400 — the only difference in a 60-property diff — until task 4 deleted it.

**"How do you know the 'nothing happened' tests can fail?"**
Because the identical function was pointed at the one control that does something. `assertInert` arms `page.on("request")` and `page.on("pageerror")` before the action, waits 500 ms, and asserts six absences. Run unchanged against the first «Купить», it failed on three lines: `a document (navigation) request was issued: …/order/ord_01M2DT7ZJNG6QT805ZYPV30HNZ`, `a POST /api/orders request was issued`, and `the URL changed from http://localhost:5101/`. The layout spec's two most vacuous-looking assertions were inverted the same way: `toBeGreaterThan(0)` on the `<a>`/`<form>` count gave `Received: 0`, and `scrollWidth > clientWidth` at 1 000 wide gave `Received: 1000` — which the pre-reversal spec would have passed.

**"You changed the layout in the middle of the slice. Where is that recorded?"**
The spec said a fixed 1 200-px column with a horizontal scrollbar under 1 280, and the task text quotes `min-width: 1240px`. The user reversed it while the sheet was being written: full width, column capped at 1 280 and centred, rows wrapping below. The sheet was built to the reversal — no `min-width`, `max-width: 1280px; margin: 0 auto`, 40-px padding for the mockup's 1 200 at the cap, `flex-wrap`, `auto-fill` cards — and measured at 1 000 wide: tiles 8 + 3, nothing past the right edge. The functional spec carries a dated change-log entry naming the task and the decision; the tech spec's §2.6 is amended in place; the tests follow the amendment. A silent edit would have left the task, the spec and the code disagreeing three ways with no record of who decided.

**"Did the exercise find anything?"**
Four things, none in the brief. The cascade-order tie above. A fixture race: capturing the order id with `page.on("response")` and a fire-and-forget `response.json()` loses to `location.assign` on the next line of `buy()` — one orphan order per buy-through, found by a throwaway repro, fixed with `page.route` + `route.fetch()` + `route.fulfill()` so the id is read before the page can navigate; zero orphans after. The Figma MCP's tool-call cap, which meant nineteen of the twenty-nine asset files are hand-authored. And the first `pnpm test` after the e2e failing with `orders = 55, expected 0` because another agent was running the API suites on the same database — not flakiness, and the same "one database, one baseline" fact R13 is about, from the other side.

**"What is not done?"**
Everything that moves. The row shows twelve plain cards, not five, with no picture; the banner, menu, currency control and hover are Slices 2–4; buying from the new page and the bfcache handling on «Купить» are Slice 5; the phase walkthrough is Slice 6. And two things this slice surfaced without solving: the e2e cleanup path runs under no committed spec yet, and two suites on one database still collide.

---

## 8. What is not finished

- **Five cards, not twelve.** `popular-products.ts` renders every product `fetchProducts` returns through Phase 1's `renderProductCard`. `selectPopularProducts` — purchasable first, catalogue order kept, first five — and the `__media` / `__body` card markup are Slice 5's.
- **No picture.** The `image` field is still dropped by the web parser, as it has been since Phase 1; the card has no `<img>`. Reinstating it, resolving it with `new URL(image, origin)`, and shipping the ten card-art PNGs are Slice 5's.
- **The four interactions.** The banner is bound by Slice 2, in parallel with this document; the catalog menu's document listener is Slice 3; the currency control's graded confirmation and every hover and focus rule — the sheet has none yet — are Slice 4. The currency radios exist and «$» is checked, which is the state Slice 4 styles.
- **The walkthrough.** `docs/walkthrough/phase-4.md` is Slice 6; this document is the slice's own explanation, not the phase's.
- **The cleanup path has no committed caller.** Both specs create no orders; `trackCreatedOrders`'s teardown early-returns on every test. The path was exercised by the repro in §6.2 and by the «Купить» RED. `buy-through.spec.ts` will make it run on every `pnpm test:e2e`.
- **Two runners, one database.** §6.4. A database or schema per run would make R13 structural rather than a discipline; nothing is built.
- **The `@game-shop/db/testing` lift.** `e2e/support/db.ts` duplicates `cleanupTestOrders`'s six statements (~25 lines) and names the source of truth; the spec calls the lift "the obvious follow-up now that a second caller exists". Not done this phase.
- **The spec's residue.** Technical-considerations §4.2's `layout.spec.ts` row and §4.4's "the narrow-window scrollbar", and `tasks.md`'s Slice 1 blockquote, still describe the fixed-width layout the change log reversed.

---

## Source files

- `apps/web/src/pages/storefront/ui/storefront-page.ts` — the composition, and the header paragraph on page-local sections and why the CSS import does not scope
- `apps/web/src/pages/storefront/ui/header.ts` — `<div role="search">` and the argument against a `<form>`
- `apps/web/src/pages/storefront/ui/steam-topup.ts` — the block that is not a form; the radio group; what each inert control is and is not
- `apps/web/src/pages/storefront/ui/catalog-menu.ts` — built and `hidden` from the first render; buttons and `<li>` text, no `<a>`
- `apps/web/src/pages/storefront/ui/services-strip.ts` — buttons so the keyboard reaches a tile; `<img alt="">`
- `apps/web/src/pages/storefront/ui/popular-products.ts` — `enableBuyControls(region)`, the synchronous region, the three states
- `apps/web/src/pages/storefront/ui/icon.ts` — the closed `glyphNames` list and `mask-image` delivery
- `apps/web/src/pages/storefront/ui/storefront.css` — the two header sections: no element selectors, and the fluid column without a `body` rule
- `apps/web/src/pages/storefront/config/{text,services,catalog-menu,banner-slides}.ts` — every visible string; §2.10 is reviewed by reading four files
- `apps/web/src/pages/storefront/CLAUDE.md` — the two non-obvious rules
- `apps/web/src/app/styles.css` — the header: this file must stay free of storefront rules and must never gain a second `body`-level rule
- `apps/web/src/app/mount-app.ts` — the import order that decides the cascade tie
- `apps/web/src/app/router.ts` — every page imported statically; the fallback is the storefront
- `apps/web/playwright.config.ts` — the two `webServer` entries, the preflight checks, `workers: 1`, `retries: 0`
- `apps/web/e2e/support/orders.ts` — the header on why route interception and not `page.on("response")`
- `apps/web/e2e/support/db.ts` — the six statements, duplicated and attributed
- `apps/web/e2e/layout.spec.ts`, `apps/web/e2e/inert-controls.spec.ts` — the twenty tests; `assertInert`
- `apps/web/tsconfig.node.json` — why `lib: DOM` on a Node-side config
- `context/spec/004-storefront-per-the-design/functional-spec.md` §2.1 (as amended), §2.8, §2.10, §3, Change Log
- `context/spec/004-storefront-per-the-design/technical-considerations.md` §2.1, §2.6, §2.7, §2.8, §4.2, R4, R10, R13, R19
- `context/product/product-definition.md` §1.4, §2.3 — what the assignment grades and what it waives
- `docs/screenshots/004-storefront-per-the-design-landing.png`, `-narrow-wrapped.png`

**On evidence:** what I ran fresh while writing this document, against the tree as it stands, with no server started and no source, test or config file modified. `pnpm --filter @game-shop/web run typecheck` — both `tsc --noEmit` passes (the app's `tsconfig.json` with `types: []`, and `tsconfig.node.json` with the config and `e2e`) — clean. A script over `storefront.css` with comments stripped: **100** rule blocks, **102** individual selectors after splitting on commas, **0** whose leftmost compound is not a class, and the distinct leftmost blocks are exactly the thirteen the header names with their `__elements` and `--modifiers`; `wc -l` reads **977**, one short of the 978 the task reported. `grep` over `pages/storefront/` for `createElement("a"` and `createElement("form"`: nothing; for `setTimeout(` outside tests: one line, `model/countdown.ts:77`, as `CLAUDE.md` claims. `grep -c "test("` over the two specs: 6 and 8 declarations, one of the 8 inside a loop of 7 chips — 20. `find apps/web/public -type f`: **29** files; `du -sk`: **228** KB; the largest file 30 118 bytes; the nine brand PNGs at 144 × 144 by `sips`; seventeen files under `icons/ui/`. `app/styles.css` grepped for element rules: only `body`; for `.product-card` and `.catalog`: only the header's prose. `mount-app.ts` read: `router.js` imported before `styles.css`. Both screenshots opened and read: the landing at 1 280 shows the five blocks and twelve plain cards in five columns; the narrow one at 1 000 shows tiles wrapped 8 + 3, «Оплатить» on a second line, cards in three columns, no horizontal scrollbar. `git status`: the storefront directory, `e2e/`, `public/`, the config and the two screenshots untracked; `pages/catalog/` deleted; the modified files as §1 lists them.

Everything else is reported by the six task agents and quoted rather than re-run: the section tops `0 / 164 / 308 / 1220 / 1539`, the 59 text nodes and the two seed names, the 89/89 responses, the `tops [375×8, 503×3]` wrap and the zero elements past the edge, the zero storefront matches and `min-width: 0px` on the order and admin pages and their pixel comparison against the `003-*` screenshots, the 60-property diff with its one `font-weight` line, the three «Купить» failure lines and the two `Received:` lines, the 1-then-0 orphan counts of the fixture repro, the 3 MB raw export and the Starter-plan cap, Chromium revision 1243 at ~276 MB, the 15.5–17.4 s run times, `orders = 55, expected 0` and the green re-run at 11 files / 90 tests plus 2 files / 31 tests. The e2e suite and `pnpm test` were not run for this document: both start servers or touch the shared database, and §6.4 is the reason not to do that while another slice is working.
