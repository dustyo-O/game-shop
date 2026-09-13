# Technical Specification: Storefront per the Design

- **Functional Specification:** `./functional-spec.md`
- **Status:** Draft
- **Author(s):** Alexander Shleyko

---

## 1. High-Level Technical Approach

This is a frontend-only phase. Nothing in `apps/api`, `packages/contracts` or `packages/db` changes; the storefront consumes the catalogue exactly as `GET /api/products` serves it today and starts a purchase exactly as the plain page does — the same `POST /api/orders` with the same `Idempotency-Key` header, minted by the same feature. What changes is the page at `/`: `pages/catalog/` (Phase 1's deliberately plain list) is deleted and replaced by `pages/storefront/`, composed of five page-local sections that mirror the mockup's upper half, with the five graded interactions each modelled as a **pure function the DOM calls**, so the parts that *derive* something — where the next slide is, whether a click was inside or outside, which five cards to show — are unit-tested without a browser, and the DOM bindings around them are thin.

Three things are decided here that are not obvious from the functional spec:

1. **Architecture §7's trigger for browser tests has been met, and the answer is two layers, not one.** The trigger was "a conditional in the rendering path that derives a fact rather than mirroring one". Phase 4 introduces several: wrap arithmetic, a timer policy, a menu state rule, a row selection. Those become pure models with Vitest tests in `apps/web`. On top of that — by the user's decision — a real Playwright project under `apps/web/e2e/` proves the five interactions, the inert controls and the buy-through in a browser a reviewer can run, with the carousel's clock faked so a 5-second policy is tested in milliseconds. The `apps/api` suites remain the proof of the purchase path itself.
2. **The catalogue's `image` field is reinstated in the web app and artwork ships with the page.** The API has always served it; the web parser has dropped it since Phase 1 because no files existed. Service-tile icons are exported from the Figma file the assignment supplied; product card art is generated placeholders — the mockup's card art is stock imagery for a game the catalogue does not sell, and reusing it on a «CS2 Prime Status» card would mislead.
3. **One small change lands in `features/buy-product`.** Under back/forward cache a page is restored *as it was left*, and the buy feature deliberately leaves Купить disabled after a successful navigation. After browser back the shopper would meet a dead button. The feature re-enables its buttons on a persisted `pageshow`. This is "where the shopper starts", which the functional spec puts in scope, not "what happens after", which it does not.

Systems affected: `apps/web` (new page, entity card markup, one feature edit, router, stylesheet, `public/` assets, Vitest and Playwright configuration), root `package.json` scripts, `context/product/architecture.md` §7, and a new `docs/walkthrough/phase-4.md`. Systems untouched: the API, the database, the contracts, the order and admin pages.

---

## 2. Proposed Solution & Implementation Plan (The "How")

### 2.1 File layout — page-local sections, no `widgets/` layer

Every block on this page has exactly one caller. The project lifts code only when a second caller exists (`shared/lib/format-price.ts`, `pages/order/model/poll.ts` both say so), architecture §1 names five layers, and the order page is explicitly left alone — so a `widgets/` layer with six single-use slices would be the ceremony the project avoids. The carousel, the menu and the currency control are likewise page state, not `features/`: a feature here is "one thing a shopper does with a domain effect" (`buy-product`'s own header reasons this out), and none of the three touches an entity or the API.

| Path | Responsibility |
| --- | --- |
| `apps/web/src/pages/storefront/index.ts` | Public API: `createStorefrontPage`. Named exports only, as every slice. |
| `pages/storefront/CLAUDE.md` | The two non-obvious rules: one `document` click listener for the menu; one timer slot for the carousel. Mirrors `features/retry-order-delivery/CLAUDE.md`. |
| `pages/storefront/ui/storefront-page.ts` | Composes header → banner → services strip → Steam block → popular row, in the mockup's order; owns no state. Imports `./storefront.css`. |
| `pages/storefront/ui/storefront.css` | The page's stylesheet — see §2.6. |
| `pages/storefront/ui/header.ts` | Каталог button (`aria-expanded`, `aria-controls`), the inert search box with its heart and search buttons, the inert profile button. |
| `pages/storefront/ui/catalog-menu.ts` | Builds the overlay from `config/catalog-menu.ts`; `attachCatalogMenu(button, overlay)` binds the document listeners to `model/menu.ts`. |
| `pages/storefront/ui/banner.ts` | Four slides, two arrows, four dots; binds `model/carousel.ts` and `model/countdown.ts`; owns `pagehide`/`pageshow`. |
| `pages/storefront/ui/services-strip.ts` | Eleven `<button type="button">` tiles from `config/services.ts`; hover and focus are CSS only. |
| `pages/storefront/ui/icon.ts` | The closed `glyphNames` list and `createIcon(name)` → an `aria-hidden` span painted through CSS `mask-image` (§2.7). |
| `pages/storefront/ui/steam-topup.ts` | Icon, title, «5 %» badge, promo button, login input, «Сумма», the currency radio group, «Оплатить» — everything inert except the toggle. |
| `pages/storefront/ui/popular-products.ts` | Heading, chips, the row region: `fetchProducts` → `selectPopularProducts` → `renderProductCard`; `enableBuyControls(rowRegion)`; the loading / empty / error states, carrying the existing error sentence verbatim. |
| `pages/storefront/model/carousel.ts` | Pure reducer: `(state, event) → { state, timer }`. |
| `pages/storefront/model/countdown.ts` | The single-slot timer: `restart(ms)`, `cancel()`, `isPending()`. No page-lifecycle knowledge. |
| `pages/storefront/model/menu.ts` | Pure reducer over `Toggle / OutsideClick / InsideClick / Escape`. |
| `pages/storefront/model/select-popular-products.ts` | Pure selection of five cards from N products. |
| `pages/storefront/config/{banner-slides,catalog-menu,services,text}.ts` | All static Russian copy, `as const`. §2.10 of the functional spec is reviewed by reading four files. |
| `pages/storefront/model/*.test.ts` | Vitest, colocated. |
| `apps/web/e2e/**` | Playwright project — see §4.2. |
| `apps/web/public/**` | Artwork — see §2.7. |
| `docs/walkthrough/phase-4.md` | The §2.9 deliverable. |

`config/` rather than an invented `content/` segment: it is the FSD segment for constants.

### 2.2 The interactions as pure models

**Carousel.** A reducer that returns the next state *and one timer instruction*, so "exactly one pending timeout, ever" is a property of the design rather than of call-site discipline.

```
CarouselState  = { index, count, isPaused }
CarouselEvent  = Tick | Next | Prev | Dot(index) | PointerEnter | PointerLeave
TimerInstruction = Restart | Cancel | Keep
reduceCarousel(state, event) → { state, timer }
wrapIndex(index, count)      → ((index % count) + count) % count
```

| Event | Index | Timer |
| --- | --- | --- |
| `Tick` | +1, wrapped | `Restart` |
| `Next` / `Prev` / `Dot(i)` | moved, wrapped | `isPaused ? Cancel : Restart` — a manual move restarts the 5-second count (§2.2 crit 6) unless the pointer is resting on the panel |
| `PointerEnter` | unchanged, `isPaused = true` | `Cancel` |
| `PointerLeave` | unchanged, `isPaused = false` | `Restart` |
| `Tick` while paused | unchanged | `Keep` (defensive; should not arrive) |
| `Dot(i)` out of range | unchanged | `Keep` |

The reducer never sees milliseconds; the DOM passes `5000` to `countdown.restart`. **The pause region is the slide panel only.** The mockup cuts the arrows out of the panel; if the arrows were inside the pause region a mouse user's arrow press would always leave the timer cancelled and crit 6 would be unobservable. For the same reason the carousel does **not** pause on `focusin` (which APG suggests): a mouse click focuses the arrow.

**Countdown.** `createCountdown(onFire)` with one `timer` slot; `restart` always clears before it sets; `onFire` clears the slot before calling out. Testable with fake timers, no DOM. It is *not* a generalisation of `poll.ts`: the poll runs immediately and chains off the completion of async work with an `AbortSignal`, and must not resume after `pageshow`; the carousel waits before its first tick, has pause/resume/restart, does synchronous work, and must resume. One abstraction over both would blur the contract `poll.ts` documents carefully. `poll.ts`'s last sentence ("moves down a layer unchanged when a second page needs it") is updated to say the second page arrived and needed something else.

**Menu.** `reduceMenu(isOpen, event) → boolean`: `Toggle` flips; `OutsideClick` and `Escape` close; `InsideClick` leaves it unchanged. Six lines — but it is the written statement of "inner clicks are inert", which is graded.

**Currency.** The active state is the browser's own: three visually-hidden `<input type="radio" name="currency">` in a `<fieldset role="radiogroup" aria-label="Валюта">`, styled through `:checked + label`, «$» checked by default. Zero JavaScript, exactly-one-active by construction, arrow-key navigation for free. The alternative — three `<button role="radio" aria-checked>` with a click handler — reimplements the radio group to get a handler whose only logic is "set this one true, the others false". Surfaced as an assumption because a reviewer may expect to *see* the JS interaction.

**Row selection.** `selectPopularProducts(products, count = 5)`: purchasable items first, catalogue order preserved within each half, then the first `count`. With the seed this yields CS2, GTA V, Tarkov, Steam 500, Steam 1000. The functional spec's "then the next two items in the shop's own order" also admits "the two items *following the last key*" (Discord, YouTube); the partition reading is chosen because it is a walk down one ordering, stays stable if the catalogue is reordered, and puts the two display-only cards beside the Steam block above them. The function returns whatever the catalogue affords — "exactly five, Купить on three" is a fact about the seed, asserted by the browser tests, not by the function.

### 2.3 Timers and back-navigation

`ui/banner.ts` starts the countdown once the DOM exists; cancels it on `pagehide` (the `poll.ts` moment — and not only hygiene: a timeout left pending in a back/forward-cached page is frozen and resumed with whatever remainder it had, so the first tick after return would land at an unpredictable moment); and on `pageshow` with `event.persisted === true` dispatches a resume so a fresh 5 seconds begins. Without the cache, browser back is a full reload — `mountApp` runs again, the carousel starts at slide 0, the menu is closed by construction. Both paths satisfy §2.7 crit 4.

The menu closes before any navigation without special handling: the click on Купить is itself an outside click, so the overlay is closed synchronously before `location.assign`. `catalog-menu.ts` additionally forces closed on a persisted `pageshow`, belt and braces.

`enableBuyControls` gains the one feature-side change: on persisted `pageshow`, re-enable every `button[data-sku]:disabled` in its container. The purchase-intent key was already forgotten on success, so a second press mints a new intent and a new order — which is what a second purchase is.

**Both restore paths must be exercised, by different means.** Playwright launches Chromium with the back/forward cache disabled, so the browser tests prove the reload path only. The cached path is checked by hand in Chrome (DevTools → Application → Back/forward cache → Test) against `vite preview`, and the result recorded in the walkthrough.

### 2.4 Click-outside, Escape, and the accessibility contract

**One `document` click listener, no listener on the Каталог button.** It classifies `event.target` (guarded with `instanceof Element`): inside the button → `Toggle`; inside the overlay → `InsideClick`; otherwise → `OutsideClick`. Because the opening click and the outside check are one listener making one decision, the bubbling-order problem — the opening click also being seen as an outside click — cannot occur. Rejected: a button listener plus a document listener with `stopPropagation()` (which would also hide the click from the buy feature's delegated listener); registering the document listener on open via `setTimeout(0)` (a hack around ordering). `click`, not `pointerdown`: the spec says clicks, and `pointerdown` would close the menu when a shopper starts a drag-select. `document`, not the page root: on a wide screen the grey ground beside the column is outside `#app`'s children.

Inner clicks are inert because nothing inside the overlay has a default: categories are `<button type="button">`, column items are `<li>` text, and there are **no `<a>` elements anywhere on the storefront** — the only navigation on the page is `location.assign` in `buy-product`.

Escape: one `document` `keydown` listener that acts only when `key === "Escape"` and the menu is open, calls neither `preventDefault` nor `stopPropagation`, then returns focus to the Каталог button. The search field is `<input type="search">`, whose native Escape clears its text in Chromium; both behaviours run and neither blocks the other.

Attributes: Каталог `aria-expanded` + `aria-controls="catalog-menu"`; overlay `<section id="catalog-menu" aria-label="Каталог товаров" hidden>` toggled via the `hidden` property (out of the accessibility tree when closed). Banner `<section aria-roledescription="carousel" aria-label="Предложения">`; slides `role="group" aria-roledescription="slide" aria-label="1 из 4"` with `hidden` on inactive ones; arrows `aria-label="Предыдущий слайд"` / `"Следующий слайд"`; dots `aria-label="Слайд 1 из 4"` with `aria-current="true"` on the active one. Tiles are buttons so the keyboard reaches them (§2.5 crit 4). A visually-hidden `<h1>Магазин</h1>` keeps the heading outline sane; «Популярные товары» is the `<h2>`, card names are `<h3>`.

### 2.5 The product row and the `image` field

`Product` regains `readonly image: string | null` (the column is nullable). The parser accepts a string or `null` and throws `CatalogResponseError` otherwise, and `parseCatalogResponse(body: unknown)` is exported so it can be unit-tested. The parser keeps the wire value; resolution is presentation: `product-card.ts` builds `new URL(image, window.location.origin).href`. Rejected: `` `/${image}` `` (a future leading slash yields `//assets/…`, a protocol-relative URL to a host named `assets`); plain relative `src` (resolves against the current path — `/order/assets/steam.png` is the bug waiting for the first reuse).

Card markup keeps the buy feature's contract byte for byte — the card is still an `<li class="product-card" data-sku>`, and only the buy button carries `button[data-sku][type="button"]`:

```
li.product-card[data-sku]
  div.product-card__media  > img.product-card__image[alt=""][width][height][loading=lazy]   (or modifier --empty, no img)
  div.product-card__body   > h3.product-card__name, p.product-card__price, button.product-card__buy[data-sku]  (button only if purchasable)
```

`alt=""` because the name sits beneath (an `alt` of the name reads it twice). A `null` image → no `<img>`, a neutral panel via the `--empty` modifier, no request. A file that fails to load → the `img`'s `error` event adds the same modifier, so a wrong path degrades to the placeholder rather than a broken-image glyph. Fixed `width`/`height` plus `aspect-ratio` and `object-fit: cover` → no layout shift. `buy-controls.ts` inserts its error `<p>` after the button and finds it via `button.parentElement` — both still hold inside `__body`. No struck-through old price, no badge (functional spec §3).

Hover lift: `transition: transform 180ms ease, box-shadow 180ms ease`; `:hover, :focus-within` → `translateY(-4px)` and the lifted shadow, so the keyboard user on Купить gets the same lift.

### 2.6 CSS — a separate sheet, scoped by selector, not by file

`pages/storefront/ui/storefront.css`, imported by the page module. `app/styles.css` is the order/admin sheet and its header promises Phase 4 leaves those pages alone.

**Placement does not scope.** `router.ts` imports every page statically, so `storefront.css` is in the module graph on `/order/:id` and `/admin/recovery` too, and Vite emits it into the same bundle. What keeps it from leaking is selectors: every rule in `storefront.css` starts with a storefront-owned block (`.storefront`, `.header`, `.banner`, `.services`, `.steam-topup`, `.popular`, `.catalog-menu`, `.product-card`, `.chip`, `.currency`); no `body`, `html`, `*`, or bare element rules. In the other direction, `app/styles.css` loses `.catalog*` (page deleted) and **must** lose `.product-card*` (its border-top and padding would land on the new cards); `.buy-product__error` stays (feature-owned, still used); the only element-level rule left is `body { margin: 0; font-family: system-ui; line-height: 1.5 }`, which the storefront is happy to inherit. Verification: re-screenshot `/order/:id` and `/admin/recovery` and compare with the 003 screenshots.

Fluid column without a `body` rule *(amended during Slice 1 — the user reversed the fixed-width decision while the sheet was being written; functional spec §2.1 crits 3–4 and its change log record it)*: `.storefront { min-height: 100vh; background: surface }` with **no `min-width`**; `.storefront__column { max-width: 1280px; margin: 0 auto; position: relative }` so the column is capped and centred with flexible space either side; `.header` and `.storefront__content` carry `padding: 0 40px` rather than a fixed 1200-px width, so at the cap the content is exactly the mockup's 1200 px and below it the page still fills the window. Rows wrap below the cap: tiles `flex-wrap: wrap`, the Steam block's two fields `flex: 1 1 260px`, the card grid `repeat(auto-fill, minmax(227px, 1fr))`, the overlay's text columns `auto-fit`. No `overflow-x` anywhere and never a horizontal scrollbar. The earlier `min-width: 1240px` reasoning (a vertical scrollbar at exactly 1 280 px) no longer applies.

Transitions: tiles `background-color, box-shadow 160ms`; cards `transform, box-shadow 180ms`; chips and buttons 120 ms. Slide change is an instant `hidden` swap — the spec says "appears at once", and a crossfade with a tick landing mid-fade of an arrow press is a state to get wrong for no graded gain. `:focus-visible` shares every hover rule; no global outline reset. `@media (prefers-reduced-motion: reduce)` drops the `transform` half of the lift and keeps the colour/shadow fade — a fade is not motion, and §2.5/§2.6 accept "a raised shadow, an outline, or a rise". Auto-advance stays (the spec mandates it; the pointer pause is the stop mechanism).

A handful of custom properties scoped on `.storefront` (`--sf-ground`, `--sf-surface`, `--sf-ink`, `--sf-muted`, `--sf-radius`, `--sf-shadow`, `--sf-shadow-lift`): the hover states repeat the same four colours, and scoping keeps "no tokens" true for the rest of the app.

Fonts: the system stack already on `body` — nothing to add. The mockup is Montserrat-like; a self-hosted woff2 in three weights with Cyrillic is ≈ 100 KB for fidelity the spec waives. A Google Fonts `<link>` is rejected outright: `index.html` is shared by every route, and a reviewer offline or behind a blocked CDN sees a flash or a fallback anyway. If closer fidelity is wanted later: `public/fonts/`, `font-display: swap`, one `@font-face` applied under `.storefront`.

### 2.7 Assets

```
apps/web/public/
  favicon.svg                 generated mark (the Figma file has none)
  assets/                     product images at the paths the seed already holds:
                              steam cs2 gta5 eft discord youtube spotify psn xbox roblox .png  (10 files for 12 rows)
  icons/services/             11 tiles: steam telegram roblox brawl-stars pubg-mobile app-store chatgpt playstation tiktok mobile-legends more
  icons/ui/                   monochrome glyphs: catalog search heart profile arrow-left arrow-right chevron-down info wallet + 7 chip glyphs
```

- **From Figma:** the brand tiles and the Steam-block icon are raster fills in the file (`download_assets` on the strip node returns 14 PNGs at 240–1920 px, 3 MB raw; TikTok and «еще» are SVG); header, arrow, chevron and chip glyphs are vectors, exported per node as 0.3–3 KB SVGs. Tile PNGs are downscaled to 144 × 144 (2× of the 72-px tile) with `magick` before commit — **raw exports are never committed**.
- **Generated:** the banner (the file's banner is one black image; the spec wants dark panels with Russian text → CSS gradient, no asset); the favicon; and the ten product images — checked-in SVG sources under `apps/web/scripts/card-art/*.svg` (a flat coloured 456 × 304 panel, brand word large, Russian product name beneath, palette keyed by SKU prefix) rendered to `public/assets/<name>.png` by `apps/web/scripts/render-card-art.ts` in the same Chromium the e2e installs (`setContent` → `screenshot`). Both sources and PNG outputs are committed, so a reviewer installs nothing; the script exists so a change is reproducible. ImageMagick was rejected because Cyrillic and «₽» need a pinned font it does not ship with.
- **Rejected:** SVG placeholders at `.svg` seed paths — touches `packages/db` fixtures and needs a re-seed on every reviewer machine; reusing the mockup's card art — misleading on the real SKUs.

Glyph delivery: brand tiles as `<img alt="">`; monochrome glyphs via CSS `mask-image` on a `<span aria-hidden="true">` with `background-color: currentColor` — `createElement` cannot build SVG-namespace nodes, `innerHTML` is banned, and a `createSvgElement` helper in `shared/lib` would have one caller.

Total ≈ 250–400 KB in `public/`, none of it in the JS bundle. `index.html`'s `<link rel="icon" href="data:,">` becomes `href="/favicon.svg" type="image/svg+xml"` (Safari ignores SVG favicons and will request `/favicon.ico` — a single 404 in Safari only). `public/assets/*` lands in `dist/assets/` beside the hashed bundles; no collision is possible, and `assetsDir` is left alone rather than renamed into the deploy story.

### 2.8 Decorative controls — inert by construction

The storefront contains **zero `<a>` and zero `<form>` elements**, so nothing has a default to cancel.

- Search: `<div role="search">` + `<input type="search" aria-label="Поиск" autocomplete="off">` + heart and search `<button type="button">`s. No form → Enter has no default → no navigation and no code. Rejected: a `<form>` with `submit` `preventDefault` — if that listener is ever lost the page navigates to `/?q=…`, and a listener whose only job is to cancel a default is a control pretending to be wired.
- Steam block: also not a form. `<input type="text" aria-label="Логин Steam" autocomplete="off">`; the «i» is a `<span aria-hidden>`, not a button (a button promises a tooltip); «Сумма / 500 ₽» is static text, not an input (an input invites typing and expecting recalculation); «Оплатить 500$» and «Ввести промокод» are `<button type="button">` with no handler; «5 %» is static.
- Profile `<button type="button" aria-label="Профиль">`; chips `<button type="button" class="chip">` with «Донат» carrying `chip--active` visually only (no `aria-pressed`, which would claim toggling works); «еще 841» is the eleventh tile with the same markup and hover rule.
- Look: `cursor: pointer` and a hover state on all of them — the spec says "visibly controls", and `cursor: default` or `disabled` would read as broken. `:active` feedback is fine: "promises no result" is about spinners, messages and navigation, not a button looking pressed.

### 2.9 The walkthrough

`docs/walkthrough/phase-4.md`, following `phase-N.md`. It must name each graded interaction, what the assignment asked, what was built and — the reviewer's likely question — *why the rest was left static*; how the storefront connects to the purchase path and the one feature edit; the bfcache finding; and the two-layer testing decision with what each layer can and cannot prove.

### 2.10 Existing files that change, and files that go

| File | Change |
| --- | --- |
| `apps/web/src/app/router.ts` | Fallback becomes `createStorefrontPage()`; comment updated. |
| `apps/web/src/app/styles.css` | Remove `.catalog*` and `.product-card*`; keep `body`, `.buy-product__error`, all order/payment/admin rules; header rewritten (the storefront's sheet lives elsewhere; this file must stay free of storefront rules). |
| `apps/web/src/entities/product/model/product.ts` | `readonly image: string \| null`. |
| `apps/web/src/entities/product/api/products-api.ts` | Nullable-string read for `image`; export `parseCatalogResponse`; replace the "dropped on purpose" comment. |
| `apps/web/src/entities/product/ui/product-card.ts` | New markup, `imageUrl`, `error` fallback. |
| `apps/web/src/features/buy-product/ui/buy-controls.ts` | Persisted-`pageshow` re-enable; "Phase 4 replaces…" paragraph to past tense. Nothing else. |
| `apps/web/src/pages/order/model/poll.ts` | Comment only (the "second page" sentence). |
| `apps/web/index.html` | Favicon line. |
| `apps/web/package.json`, `apps/web/tsconfig.node.json` | Dev deps `vitest`, `@playwright/test`, `@game-shop/db` (e2e cleanup and the card-art script only); scripts `test`, `test:e2e`, `assets:card-art`; `tsconfig.node.json` `include` gains `vitest.config.ts`, `playwright.config.ts`, `e2e`, `scripts` so the browser tsconfig (`types: []`) never sees Playwright or Node. |
| `package.json` (root) | `test:web`, `test:e2e`; `test` chains `test:web`. |
| `context/product/architecture.md` §7 | The Phase 4 revisit and its outcome. |
| `.gitignore` | `apps/web/e2e/.results/` under the existing test-output section (`playwright-report/`, `test-results/` are already there). |
| **Delete** `apps/web/src/pages/catalog/index.ts`, `apps/web/src/pages/catalog/ui/catalog-page.ts` | Only `router.ts` imports them; `typecheck` fails loudly on any stale reference. |

---

## 3. Impact and Risk Analysis

**System dependencies.** Depends on `GET /api/products` (unchanged, seed order, `image` nullable) and `POST /api/orders` (unchanged). Affects nothing server-side. The `apps/api` suites' baseline assertion (`orders = 0` before and after) is a dependency *on* the new e2e suite: any order the browser tests create must be deleted before the API suites run — see §4.2.

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | Back/forward cache restores the page with the timer cancelled → banner dead after back (§2.7 crit 4) | `pageshow` + `persisted` → restart. Playwright disables bfcache, so this path is a manual Chrome check against `vite preview`, recorded in the walkthrough. |
| R2 | Stacked timeouts from arrow + tick + resume → banner jumps off-beat | Single-slot countdown; the reducer emits one instruction per event; fake-timer test "restart twice fires once". |
| R3 | The opening click is also seen as an outside click → menu never opens or flickers | One document listener classifying the target; no `stopPropagation`; a Playwright test for open and for outside-close. |
| R4 | `storefront.css` is in every route's module graph → leaks into the order/admin pages | Block-scoped selectors only, no element rules; `.product-card*` removed from `app/styles.css`; re-screenshot order and admin. |
| R5 | `image` null / relative / missing → broken glyph or `/order/assets/…` 404 | Nullable parse; `new URL(image, origin)`; all ten seed files shipped; `error` → placeholder; a network sweep in the e2e asserts no 4xx. |
| R6 | New card markup breaks the delegated buy contract, or a display-only card becomes clickable | Card stays `<li>`; only the buy button carries `data-sku`; no wrapping `<a>`/`<button>`; e2e clicks a display-only card and asserts no request. |
| R7 | `noUncheckedIndexedAccess`: `slides[index]` is `T \| undefined`, tempting a `!` | Never index; toggle `hidden`/`aria-current` by iterating with `i === index`; the reducer's range invariant is unit-tested. |
| R8 | Escape while typing in the search field also closes the menu / native clear interferes | The handler acts only when the menu is open and never `preventDefault`s; both effects harmless; e2e drives the case with the field focused. |
| R9 | Double-click on the new card creates two orders | `disabled` is set synchronously on the first click (feature unchanged); e2e counts `POST /api/orders` on `dblclick`; the API idempotency suite covers the server side. |
| R10 | Asset 404s — 21 icons, 10 images; one wrong path is "a broken control" | e2e network sweep is a required assertion; `public/` is copied verbatim so dev paths = prod paths. |
| R11 | Reduced-motion reviewer sees no fade | Keep colour/shadow transitions, drop only transforms; say so in the walkthrough. |
| R12 | Disabled Купить restored by bfcache → dead control after back | Persisted-`pageshow` re-enable in `enableBuyControls`; the intent key is already forgotten, so a re-press is a new order — correct. |
| R13 | e2e-created orders — and, since the buy-through goes to the key, claimed keys — break the API suites' `orders = 0` / `unclaimed = 50` baseline | Order ids are captured from the `POST /api/orders` *response* in a fixture, before any assertion, so a test that fails mid-way still cleans up; `afterEach` runs the same six statements as the API harness's `cleanupTestOrders` (`req_{order}_%` un-claim included), quoted beside the call; `workers: 1`. An aborted run leaves rows and gets the API suites' existing «db:reset» message. |
| R14 | Playwright hover assertions read computed style mid-transition → false failures | Assert state (class, `aria-current`, `hidden`) and the static `transition-duration > 0`, never an interpolated value; wait for `transitionend` where a final value is needed. |
| R15 | The 5-second policy tested with real waits → slow and flaky; or a faked clock freezing the order page's poll | `page.clock.install()` and `clock.runFor()` in every spec that never leaves the storefront; the buy-through spec uses real time (its back-navigation check waits ~7 s once) because the poll's timers and the faked clock do not mix. |
| R16 | System font metrics differ per OS → «Mobile Leg…» overflows the 76-px tile | `white-space: nowrap; overflow: hidden; text-overflow: ellipsis` — the mockup truncates the same way. |
| R17 | Banner copy invents promotions on a shop that "invents no discounts" | Slide copy describes what the shop sells (пополнение Steam, ключи, подписки, подарочные карты); no percentages. |
| R18 | Deleting `pages/catalog` leaves stale references or a stale sentence | `typecheck`; update `styles.css` header, `poll.ts`'s last sentence, `buy-controls.ts`'s "Phase 4 replaces…" paragraph. |
| R19 | Port collision with a Vitest suite or `pnpm race` (found while closing Phases 2 and 3) | The e2e owns dedicated ports **5101 (Vite) / 5102 (API)** — clear of 3000, 5173, 4101–4104, 4201, 4301, 4401–4402, 4501–4504, 4601–4604, 4701–4704, 4801–4804, 4901; `--strictPort` so Vite fails loudly; both listed in `scripts/race/README.md`'s port row. |
| R20 | Chromium not installed on the reviewer's machine → the suite fails before the first test | `pnpm exec playwright install chromium` in the README, and a config-level check that prints that command. |

---

## 4. Testing Strategy

Two new layers, one existing one, and a manual check — each named with what it can and cannot prove.

### 4.1 Vitest in `apps/web` — the pure models

`vitest` (same major as the API), `apps/web/vitest.config.ts` with `environment: "node"` and `include: ["src/**/*.test.ts"]` — no jsdom; tests import `describe/it/expect` explicitly so `types: []` stays. `"test": "vitest run"`; root `test:web`, chained into `pnpm test`.

| File | Asserts | RED method |
| --- | --- | --- |
| `pages/storefront/model/carousel.test.ts` | last→first on `Tick`/`Next`, first→last on `Prev`, `Dot(i)` lands on i, out-of-range `Dot` ignored; the policy table above, row by row | Write first against a stub reducer returning `Keep` → all red; then break `wrapIndex` — as run: dropping the `+ count` normalisation fails only *first→last* and leaves *last→first* green (the quiet half-failure); dropping the modulo entirely fails all six wrap cases; restore. |
| `pages/storefront/model/countdown.test.ts` (fake timers) | restart twice → fires once; cancel → never fires; after firing `isPending()` is false | Remove the `clearTimeout` in `restart` → "fires once" fails with two calls. |
| `pages/storefront/model/menu.test.ts` | `Toggle` flips both ways; `OutsideClick`/`Escape` close only; `InsideClick` unchanged | Make `InsideClick` return `false` → fails. |
| `pages/storefront/model/select-popular-products.test.ts` | seed-shaped fixture → `[CS2, GTA5, EFT, STEAM-500, STEAM-1000]`; empty → `[]`; 3 → 3; 7 purchasable → first 5; order preserved | Replace the body with `products.slice(0, count)` → first test fails (Steam ×3 leads). |
| `entities/product/api/products-api.test.ts` | `parseCatalogResponse`: `image: null` ok, string ok, `42` throws `CatalogResponseError`; `price_minor: null` throws | Accept any `image` → the `42` case fails. |

The currency control has no unit test — native radios, nothing to compute.

### 4.2 Playwright in `apps/web/e2e` — the five interactions in a browser a reviewer can run

- **Shape.** `@playwright/test` as a dev dependency of `apps/web`; `apps/web/playwright.config.ts` with `testDir: "e2e"`, one project (`chromium`, Desktop Chrome at 1 440 × 900), `workers: 1` and `fullyParallel: false` (one shared database and a 50-key pool — the same reason the API config serialises files), `retries: 0` (a test that passes on the second try is a false statement, not a pass), `screenshot: "only-on-failure"`, `trace: "retain-on-failure"`, `outputDir: "e2e/.results"`. Unit tests are `*.test.ts` under `src/`, e2e specs `*.spec.ts` under `e2e/`, so neither runner picks up the other's files.
- **The config owns both servers on dedicated ports; Postgres is a precondition.** `webServer` is an array of two, both `reuseExistingServer: false`: the API on **5102** (`node scripts/with-env.ts pnpm --filter @game-shop/api run start`, readiness on `/api/health`, with the same five env lines `apps/api/test/concurrency/support/api-instance.ts` sets — `API_PORT`, `PAYMENT_WEBHOOK_URL`, `SUPPLIER_A_URL`, `SUPPLIER_B_URL`, `WEB_API_BASE_URL`, all pointing at 5102 — with a comment naming that file) and Vite on **5101** (`vite --port 5101 --strictPort`, `WEB_API_BASE_URL` → 5102 so the `/api` proxy targets the e2e API). Rejected: reusing the developer's `pnpm dev` on 5173/3000 — HMR state, a possibly stale API, and the collisions above. The dev server rather than `build && preview`: sub-second start, identical for everything a test can observe, `public/` at the same paths. Postgres on 5433 is the same precondition `pnpm test` already has.
- **Scripts.** `apps/web`: `"test:e2e": "playwright test"`; root: `"test:e2e": "pnpm --filter @game-shop/api run build && node scripts/with-env.ts pnpm --filter @game-shop/web run test:e2e"` — the API's `start` runs `dist/main.js`, so the root script builds first, as the acceptance suite rebuilds in `beforeAll` so the code under test is the code that runs. Running `playwright test` bare fails with a clear message from the config (`DATABASE_URL` missing → «run pnpm test:e2e from the repository root»). **Not** chained into `pnpm test`: it needs a browser and starts servers, and a reviewer who runs `pnpm test` expecting the API suites should not get a Chromium download. Reviewer install: `pnpm exec playwright install chromium` — one browser; measured ~276 MB download (revision 1243), 368 MB on disk. Run time: API build 5–8 s, boot ~2 s, ~30 cases at 0.5–1 s with faked clocks, buy-through ~4 s and back-navigation ~7 s real → **about 45–60 s** end to end.
- **Clock.** Every banner-timing test calls `page.clock.install()` before navigation and drives time with `clock.runFor(...)`: auto-advance at 5 000 ms; no advance at 4 999; an arrow press at 3 000 followed by `runFor(4 000)` shows no auto-move and `runFor(1 000)` more shows one — that is §2.2 crit 6; `hover(panel)` then `runFor(6 000)` unchanged, then move away and `runFor(5 000)` advances. The countdown uses `setTimeout`, which the clock fakes; no storefront-only test waits five real seconds. **Measured while writing the spec:** a bare `page.clock.install()` does not freeze time — the clock keeps pace with the wall until paused, so the real milliseconds spent by `goto` and the catalogue fetch were already inside the carousel's first 5-second window and `runFor(4 999)` advanced the slide. The harness pattern is `install({ time: FIXED_START })` followed by `pauseAt(FIXED_START + 100)` **before** `goto`; a `pauseAt(Date.now())` after navigation throws `Cannot fast-forward to the past`. Every clock-driven spec copies that `beforeEach`. The buy-through spec does **not** install the clock — the order page's poll would freeze and the delivery it waits for is real.
- **Files and what each proves.**

| File | Covers | Method |
| --- | --- | --- |
| `e2e/layout.spec.ts` | §2.1 (as amended); R5, R10 | Five sections present with bounding boxes in ascending `y`, the row last; zero `<a>`; at 1 280 × 800 `scrollWidth <= clientWidth` and the column centred (left gap = right gap ± 1); at 1 000 × 800 still `scrollWidth <= clientWidth`, the column as wide as the window, and the tile row on more than one line; visible text nodes contain Cyrillic or are on a brand allowlist; no response with status ≥ 400 during load |
| `e2e/banner.spec.ts` | §2.2 all seven | `page.clock.install()` before `goto`; `aria-current` on dots, `hidden` on slides; the clock sequence above |
| `e2e/catalog-menu.spec.ts` | §2.3 all six | `hidden` on the overlay and `aria-expanded` on the button; outside click on `body` far from the column; `keyboard.press("Escape")` with the search field focused (R8); a category and an item clicked → still open, URL unchanged, no `pageerror`; open/close ×3 |
| `e2e/currency.spec.ts` | §2.4 all four | `:checked` on the radios; the «Сумма» text identical throughout |
| `e2e/hover.spec.ts` | §2.5; §2.6 hover/focus | `transition-duration > 0` on tile and card (the "fades" evidence, a static read); after `hover` + the duration the hovered tile's style differs from an unhovered one and only it; Tab to a tile → focus style equals hover style; card `transform` is a `translateY` matrix on hover and `none` after; `emulateMedia({ reducedMotion: "reduce" })` → no transform, colour still changes |
| `e2e/products.spec.ts` | §2.6 all five | Five cards; the three purchasable SKUs from `GET /api/products` each have `button[data-sku]`, the other two none; every `<img>` has `naturalWidth > 0` or the card carries `--empty`; clicking a display-only card leaves the URL; `page.route("**/api/products", 503)` → the exact existing sentence in the row while the banner still advances under the clock and Каталог still opens |
| `e2e/inert-controls.spec.ts` | §2.8 all four | Type + Enter in search; click heart, profile, promo, each chip, «еще 841»; type a login + «Оплатить» — each asserts no `document` request, no `POST /api/orders`, URL unchanged, no `pageerror`, no `[aria-busy]`, no text matching `/скоро|coming soon|загруз/i` appearing |
| `e2e/buy-through.spec.ts` (real clock) | §2.7 crits 1–4 (reload path); §2.6 crit 1 | Click Купить on the first purchasable card → `waitForURL(/\/order\/ord_/)`, product name, amount, «Ожидает оплаты»; click the success control → the key appears with no further action (≤ 15 s); `dblclick` on a fresh page → exactly one `POST /api/orders` in the request log; `goBack()` → storefront, overlay hidden, and the dot advanced within ~7 s of real time. Every order id is captured from the `POST` response in a fixture before any assertion. |
| `e2e/support/db.ts`, `e2e/support/orders.ts` | R13 | `afterEach` cleanup through `@game-shop/db`'s client running the same six statements as the API harness's `cleanupTestOrders` — `DELETE` from `deliveries`, `issuance_attempts`, `payment_events`, `orders` by id; un-claim `supplier_keys` and delete `supplier_requests` by `req_{order}_%` — duplicated (~25 lines) with a comment naming the source of truth rather than refactoring the Phase 1–3 harness from a UI phase; the SQL is quoted beside the call, as everywhere. The lift to a `@game-shop/db/testing` subpath is the obvious follow-up now that a second caller exists. |

- **RED.** The rule matches the API suites: weaken nothing in `src/` to prove a test. These are new behaviours, so write-first-fail is available — a spec written before its section fails on a missing element (weak but real). Stronger, and required for every «nothing happened» assertion: **point the identical assertion at the one control that does something** — run the inert-controls check against Купить and watch it fail on the `document` request and the `POST` — because «nothing happened» is the assertion most likely to pass vacuously. For every «state changed» assertion, assert the pre-state after the action, or push the clock past the boundary (`runFor(4 000)` → «still», then assert «advanced» → fails). RED output is recorded in the walkthrough as the API suites record theirs.
- **What the e2e does not prove.** Delivery *correctness* — the buy-through watches a key arrive, but one-order-per-intent, one-key-per-payment and recovery are the API suites' proofs at the boundary where they are enforced (§4.3); the e2e's un-claim in cleanup is the thing «only a test may do», and it does it for the same reason the API harness does. The bfcache restore path (R1) — Playwright disables the cache. The fade *as seen* — a computed style mid-transition is the classic false negative; the e2e asserts the duration and the end state.

### 4.3 The API suites — unchanged, and still the proof of the purchase

The storefront sends the same request the plain page sent, so `apps/api/test/acceptance/purchase-and-key-delivery.test.ts`, `single-issuance-under-races.test.ts`, the concurrency suites and `pnpm race` remain the proof that one intent is one order, one payment is one key, and a supplier's silence is never a second key. Nothing in them changes. They must still pass after the e2e has run (R13).

### 4.4 Verification by driving the real page, and screenshots

Independent of the suites, each slice's verify task drives the page through the Playwright MCP and captures `docs/screenshots/004-storefront-per-the-design-<slug>.png` — landing at 1 280, the narrow window with its rows wrapped, each interaction's before/after, the buy-through, the order page unchanged. The bfcache path is checked by hand in Chrome and recorded in the walkthrough with the DevTools verdict.

---

## 5. Assumptions

Recorded rather than confirmed; each is one line to change.

1. Row selection is the partition reading (CS2, GTA V, Tarkov, Steam 500, Steam 1000), not "the two following the last key".
2. Four dots for four slides, although the mockup draws six.
3. The pause region is the slide panel only; arrows and dots sit outside it; focus does not pause.
4. The currency control is native radio inputs with no JavaScript, not buttons with a handler.
5. System font stack, no webfont; self-hosted Montserrat under `.storefront` is the fallback if fidelity is wanted.
6. Card styles live in `storefront.css`, not in a per-entity CSS file (a third convention for one file).
7. Card art as checked-in SVG sources rendered to PNG through Chromium at the seed's existing `assets/*.png` paths; `packages/db` untouched (its fixture header says it is verbatim from the brief and diffable line by line).
8. Banner copy describes what the shop sells and promises no discounts.
9. The one edit to `features/buy-product` (re-enable on persisted `pageshow`) is in scope.
10. `pnpm test:e2e` is a separate command, not part of `pnpm test`, on dedicated ports 5101/5102; the buy-through goes all the way to the key and the e2e restores the API suites' baseline itself, with the cleanup statements duplicated from the API harness rather than lifted this phase.
11. Escape closes the menu even while the search field is focused; the field's native clear also runs.
12. The order page gains no "back to shop" link — §2.7 crit 4 is the browser's back control, as the functional spec states.
13. *(Superseded during Slice 1.)* The layout is fluid, not fixed-width: full-width page, column capped at 1 280 px and centred, rows wrapping below the cap. Recorded in §2.6 and the functional spec's change log.
