# Phase 4 · Slice 3 — The catalog menu

> One thing on the page starts moving in this slice: the overlay under the «Каталог» button. It opens on a click, closes on a second click, on a click anywhere else, on Escape, and on a return from the back/forward cache; a click on anything inside it changes nothing. That last sentence is the graded one — functional spec §2.3's fifth criterion — and it is the one a menu gets wrong by accident, because the shortest implementation that passes every *other* check is a listener that closes on any click while open.
>
> Two decisions carry the slice, and both are about *where a decision is made* rather than what it is. **Every click on the page is read once, by one listener on `document`, which asks a single question — where did it land? — and hands one of three words to a pure reducer.** There is no listener on the button. The obvious alternative, a listener on the button plus a closer on `document`, has a bug built into the order events bubble in, and its usual patch, `stopPropagation`, makes a hole in the mechanism the page's «Купить» buttons depend on. And **"inner clicks are inert" is a fact about the markup, written down twice** — once as what is inside the overlay (`<button type="button">`s with no handler, `<li>` text, no `<a>` anywhere on the storefront) and once as a reducer branch, `InsideClick → unchanged`, that a type checker keeps total and a unit test keeps true. It is not implemented by a handler that swallows anything.
>
> Reading the delivered work found two things about the harness and none about the product: the Playwright MCP is one shared browser, and two agents driving it at once closed each other's page mid-drive; and editing `src/` while a verifier is driving the dev server triggers a hot reload that can leave the overlay open in a screenshot. Both are now scheduling rules. Reading the code for this document found one sentence in a file header that is one degree too strong — reported in §5.4, not fixed.

---

## 1. What actually shipped

| # | Change | Where | Size |
| --- | --- | --- | --- |
| 1 | The menu's rule as a pure reducer: `MenuEvent` (`Toggle / OutsideClick / InsideClick / Escape`) and `reduceMenu(isOpen, event) → boolean`, total by `assertNever` | `apps/web/src/pages/storefront/model/menu.ts` | 81 lines, 16 of them the function |
| 2 | Its unit test — one `it` per row | `pages/storefront/model/menu.test.ts` | **8 cases**; `pnpm test:web` is now **3 files / 39 tests, ~146 ms** |
| 3 | The binding: one `document` `click` listener that classifies `event.target`, one `document` `keydown` listener for Escape, one `pageshow` listener; `hidden` and `aria-expanded` painted from the reducer's answer | `pages/storefront/ui/catalog-menu.ts` | 200 lines (Slice 1's was 59); `addEventListener("click"` on **exactly one line, 165** |
| 4 | `createHeader()` returns `{ element, catalogButton }` — the button handed over typed, not found by `querySelector` plus `instanceof` | `pages/storefront/ui/header.ts`, `ui/storefront-page.ts` | the `Header` interface; one line in the composer |
| 5 | The "one document listener" rule and its three grep checks | `pages/storefront/CLAUDE.md` | one bullet |
| 6 | The browser spec | `apps/web/e2e/catalog-menu.spec.ts` | **6 tests, 350–520 ms each**; the e2e suite is now **34 tests in 21.9–27.8 s** |
| 7 | Two screenshots | `docs/screenshots/004-storefront-per-the-design-menu-open.png`, `-menu-inner-click.png` | pixel-identical, by design |

Nothing in `config/catalog-menu.ts` changed: the five categories and six columns are Slice 1's, verbatim from Figma node `1:1193`, and Slice 3 bound them without touching them. Nothing in `features/buy-product` changed either — it appears in this document because the menu's design was chosen partly so that it would not have to.

The live drive the verify task took against the delivered page, quoted rather than re-run: closed on load; open after one click (`aria-expanded="true"`, computed `display: flex`); closed after a second; closed after a click on `<h2>Популярные товары</h2>` (the heading's top at **659 px**, the overlay's bottom at **544 px** — outside by geometry, not only by ancestry); a category click and then an `<li>` click → still open, URL unchanged, **0** console errors; Tab into the search field, type «тест», Escape → closed, focus on `header__catalog`, field value `""`; menu closed, Escape in the field → focus stays on the field; open/close **×3** identical; a synthetic `pageshow` with `persisted: true` → closed; a click on the grey ground at **(20, 400)** → closed.

---

## 2. The words this document uses

- **Bubbling** — after a click lands on an element, the browser delivers the event to that element, then to its parent, then to the parent's parent, up to `document` and `window`. Every listener on the way runs, in that order, unless one of them stops it. The order is not a detail: it is the reason a listener on a button runs *before* a listener on `document` for the same click.
- **Delegated listener** — a listener placed on an ancestor that handles clicks for its descendants by inspecting `event.target`. It works because of bubbling and only because of it: a click that stops below the ancestor never reaches it. `enableBuyControls` is one, on the product row, for buttons that do not exist when it is wired.
- **Classifying listener** — a delegated listener whose whole job is to say *which kind* of click this was. The menu's is on `document`, sees every click on the page exactly once, and answers with one of three words. It holds no menu logic; the reducer does.
- **`stopPropagation`** — a call that ends bubbling at the listener that makes it. It is not addressed to a listener; it is addressed to a direction: nothing above this element sees the event, whoever that is.
- **Inert by markup** — a click that does nothing because the thing clicked has nothing to do: a `<button type="button">` with no handler, an `<li>` of text. Distinct from *inert by handler*: a thing with a default action or a listener, plus another listener that cancels or swallows it. Slice 1's walkthrough draws the same line for the search field and «Оплатить»; this slice applies it inside the overlay.
- **Idempotent close** — `OutsideClick` and `Escape` answer `false` whatever the state, so closing a closed menu is a no-op, not a flip. It matters because the listeners fire on every click and every key press for the life of the page: "close when already closed" is the reducer's most frequent input.
- **Accessibility tree** — the structure assistive technology reads, built from the DOM minus what is not displayed. An element with `hidden` that really is `display: none` is absent from it; an element painted transparent or off-screen is not. The verify task's snapshots are of this tree, not of pixels.

---

## 3. The two decisions the task names

Each in the same shape: what was built, the more obvious alternative, and what goes wrong without the decision — with the code fact beside the plain-language reason.

### 3.1 One classifying listener on `document`, none on the button

**What.** `catalog-menu.ts` registers exactly one `click` listener, on `document` (line 165), and none on the Каталог button. `header.ts` builds the button with `aria-expanded="false"` and `aria-controls="catalog-menu"` — facts about the markup, not about any listener — and hands it back by reference in the `Header` interface; `catalog-menu.ts` takes it as an argument. The listener guards `event.target` with `instanceof Element` and asks one question in three branches: `catalogButton.contains(target)` → `Toggle`; `overlay.contains(target)` → `InsideClick`; otherwise → `OutsideClick`. The word goes to `reduceMenu`; the boolean that comes back is painted as `overlay.hidden = !next` and `aria-expanded = String(next)`, and only when it differs from the current state. Nothing in `pages/storefront/` calls `stopPropagation` or `preventDefault` — the grep in `CLAUDE.md` returns nothing — and nothing in the whole of `apps/web/src` calls `stopPropagation`.

**The obvious alternative.** A `click` listener on the button that opens, and a `click` listener on `document` that closes while open. It is the shape every first implementation takes, because it reads like the spec's two sentences: "clicks Каталог → opens"; "clicks anywhere outside → closes".

**What goes wrong with the alternative.** Walk the opening click. The shopper clicks the word «Каталог»; `event.target` is `span.header__catalog-label`. The event bubbles: span → `button.header__catalog` → `header.header` → `div.storefront__column` → `div.storefront` → `#app` → `body` → `html` → `document`. Under the two-listener design the button's listener runs when the event reaches the button — `isOpen = true`, overlay shown — and then the event keeps going, reaches `document`, and the closer runs: menu open, this is a click, close it. Both run in the same task with no paint between them, so the shopper sees nothing at all. The menu never opens. That is R3, and it is not a race or a browser quirk; it is the order events are defined to arrive in.

Under the classifying design the same click passes every element without a listener, arrives at `document` once, matches `catalogButton.contains(target)`, and becomes one `Toggle`. There is no second listener to see it as something else, so the opening click *cannot* also be an outside click — not because a flag was set, but because nothing gets to look at it twice.

The two-listener design has two patches, and both were rejected. The first is `stopPropagation()` in the button's handler, so the click ends at the button and `document` never sees it — and, for crit 5, the same call on the overlay, or every inner click reaches the closer and closes. `stopPropagation` is not addressed to a listener; it says that nothing above this element sees this event, whoever that is. On today's tree the two places the design would have to stop clicks — the button and the overlay — happen to contain no delegated target, so a Каталог click stopped at the button is not, literally, a click the product row's listener was waiting for: the row is a sibling subtree, not an ancestor of the header. What the patch does is make "stop the event to be exempt from the closer" the page's mechanism, and that mechanism is in direct tension with the two listeners whose contract is to be above and to see everything. `enableBuyControls` sits on the row region and handles buttons that arrive with the catalogue — it works only if clicks travel up. And the menu's own listener needs the Купить click to reach `document`, because that click is the outside click that closes the overlay synchronously before `location.assign` runs (technical-considerations §2.3). A design that never needs to stop an event never has to decide where stopping is safe. This one never does.

The second patch is registering the `document` closer from inside the open handler on a zero-delay timeout — so the closer is not yet attached while the opening click is still bubbling — and removing it on close. It works. It is a bet that the click will have finished bubbling before a timer fires, and a listener that appears and disappears with the state: a design a reader has to run in their head to trust.

Two smaller choices sit inside the big one. **`click`, not `pointerdown`:** the spec says clicks; `pointerdown` fires on press, so a shopper who presses outside to start a drag-select would close the menu before releasing; and a keyboard user who presses Enter or Space on the focused Каталог button fires a `click` and no `pointerdown`, so the one listener serves both. **`document`, not the page root:** on a window wider than 1 280 px the grey ground beside the column is `div.storefront`, outside `#app`'s children — the verify task's click at (20, 400) landed there, and it closed.

### 3.2 "Inert inside" is a property of the markup, written down as a rule

**What.** Inside the overlay: five `<button type="button">` categories with no listener, the first with a `--active` class because the mockup draws it highlighted and nothing moves it; six columns of `<h3>` headings and `<li>` text. There is no `<a>` anywhere under `pages/storefront/` — the grep for `createElement("a"` returns nothing — and no `<form>`; the only navigation on the page is `location.assign` in `features/buy-product`. A click inside the overlay therefore has no default action to run and no handler to reach. The classifying listener names it `InsideClick`, and the reducer's branch for that word is `return isOpen` — the state as it was. `menu.test.ts` asserts that branch in two cases, and `catalog-menu.spec.ts` clicks a category and an `<li>` in a browser and asserts the overlay is still open, the URL unchanged, no document request, no page error.

**The obvious alternative.** Any of three. Make the categories `<a href="#">` — they look like links — and add a click handler that calls `preventDefault()`. Or keep the two-listener design and stop propagation on the overlay so inner clicks never reach the closer. Or the shortest one: a `document` listener that closes on *any* click while open, and no exemption at all.

**What goes wrong with the alternative.** The third is the interesting one, because it is the one a careful implementer writes and a careful tester passes. Open on Каталог — works. Second click closes — works. Click on the heading, on the ground, on a tile — closes, works. Escape — works. Three times in a row — works. Every manual check on the list is green. Then the reviewer clicks «Игровые ценности» and the menu closes, and that is the criterion the assignment grades: *"when the shopper clicks any category or item inside the overlay, then nothing changes"*. A tester who clicks inside and sees it close may not even register it as wrong — it is what a dropdown does. The rule is not one a manual pass finds; it has to be written down to be checked, and `InsideClick → isOpen` is the writing-down. Because the `switch` ends in `assertNever`, a fifth event added without deciding what it does is a type error rather than a menu that silently ignores it; and because the branch exists as a line, a test can assert it and a mutation can break it — §4 shows the line fall.

The first alternative holds only while the handler holds. An `<a href="#">` has a default: navigate to `#`, scroll to the top, put a `#` in the address bar. The `preventDefault` that cancels it is one lost listener away from all three — a rebuild of the overlay that forgets it, an exception earlier in the same handler. It would also give `layout.spec.ts`'s `document.querySelectorAll("a, form").length === 0` a non-zero, which is Slice 1's argument for the rest of the page applied to this corner of it. The second alternative is §3.1's `stopPropagation` again.

The point the two halves make together: the markup decides that a click inside *does nothing of its own*; the reducer decides that the menu *does nothing in response*. Neither depends on a handler swallowing anything, so there is nothing that can be lost.

---

## 4. What each test layer proves, and how each was shown able to fail

**Unit — `menu.test.ts`, 8 cases, no DOM.** `reduceMenu` is a function from `(isOpen, event)` to `isOpen`; the event is a word. So the graded rule is a return value here, and the browser test only has to prove the classification.

| Group | Case | Expects |
| --- | --- | --- |
| Toggle | closed → open (crit 1) | `true` |
| Toggle | open → closed (crit 2) | `false` |
| OutsideClick | closes an open menu (crit 3) | `false` |
| OutsideClick | on a closed menu stays closed | `false` |
| Escape | closes an open menu (crit 4) | `false` |
| Escape | on a closed menu stays closed | `false` |
| InsideClick | on an open menu stays open (crit 5) | `true` |
| InsideClick | on a closed menu stays closed — not a Toggle | `false` |

Three REDs, in order. Written before the module existed: **`Cannot find module './menu.js'`** — every case red, the weak-but-real write-first. Then the mutation the tech spec prescribes, `InsideClick` returning `false`: **1 failed** — *"on an open menu stays open"*, and only that. The implementing agent's brief had predicted two; the closed case expects `false` and the mutant returns `false`, so it cannot fall under that mutation, and §5.2 says what that teaches. Then the mutation the second case exists for, `InsideClick` treated as a `Toggle` (`return !isOpen`): **2 failed** — both InsideClick cases, open→`false` and closed→`true`. Restored: `pnpm test:web` **3 files / 39 tests, ~146 ms** — `carousel`, `countdown`, `menu`.

**Browser — `catalog-menu.spec.ts`, 6 tests, 350–520 ms each.** No `page.clock` — nothing under test has a timer, and the file's header says so. Every test reads two DOM facts at once through one helper, `menuState`: the overlay's `hidden` *property* and the button's `aria-expanded` *attribute*, written together by `setOpen` but two different facts, so a failure names which one disagreed.

| Test | Asserts |
| --- | --- |
| crit 1 — closed on load; Каталог opens | `hidden: true` and `aria-expanded="false"` before; `false` / `"true"` after; the first category and heading visible; **5** `.catalog-menu__category`, **6** `.catalog-menu__heading` |
| crit 2 — second click closes | open before; `hidden: true`, `"false"` after |
| crit 3 — outside click closes, two ways | `page.mouse.click(20, 400)` on the ground beside the column; then reopen and click `.popular__title` — the `<h2>` |
| crit 4 — Escape with the search field focused (R8); no focus theft while closed | open, `.focus()` the field (never `.click()` — §5.1), `keyboard.press("Escape")` → closed, `activeElement` is `header__catalog`; the field's value logged, not asserted; then closed + Escape in the field → still closed, field still focused |
| crit 5 — a category and an `<li>` clicked | `assertStillOpenAndInert`: `request` (document) and `pageerror` listeners armed *before* the act, URL captured; after → still open, URL unchanged, no document request, no error |
| crit 6 — ×3 | open then close, three cycles, both facts each time |

Two REDs, both for crit 5, because it is the "nothing happened" assertion most likely to pass vacuously. Assert `hidden: true` after the inside click — the wrong reading — against the real page: **`Expected: true Received: false`**. Assert the URL *changed* after an item click: **`Expected: not "http://localhost:5101/"`**. Both are the detector seeing the page do the right thing when told to expect the wrong one. With the four other specs: **34 tests in 21.9–27.8 s**.

**The accessibility tree — the verify task's after-action snapshots.** With the menu closed, the tree under the header shows `button "Каталог"` and nothing of the overlay — no «Каталог товаров» region, no category, no column node. Open: the region is present with five categories and six column headings. After an Escape-close the tree is back to the closed shape. This is the one check the browser spec does not make, and the one that proves `hidden` is doing what the attribute promises rather than what a class would: the closed overlay is absent, not merely invisible.

**The screenshots.** `-menu-open.png` and `-menu-inner-click.png` are byte-identical — `cmp` is silent and both hash to `cabdb9d0…`. That is what "an inner click changes nothing visible" looks like as a file: five categories on the left with «Игры и игровые сервисы» highlighted and, on the right, Steam, PlayStation, Xbox, Nintendo, Battle.net and Подборки. Identical bytes are consistent with the claim; they cannot on their own show that a click happened between the two captures — the crit-5 test and the drive's log are what establish that.

**What the three layers do not prove.** The real back/forward cache: the `pageshow` handler was exercised with a synthetic `persisted: true` event, and Playwright disables the cache, so the Chrome-by-hand check belongs to Slice 5's buy-through, where a page actually leaves and comes back. Anything about what the categories *should* do — nothing, by the product definition, and nothing beyond that is asserted.

---

## 5. Findings

### 5.1 Clicking the search box is itself an outside click

The Escape criterion (R8) wants the menu open *and* the search field focused. The first attempt to reach that state clicked the field, and the menu closed before Escape was pressed. It is not a bug; it is the classification doing exactly what it says. `.search__input` is in `.header`, not in `#catalog-menu`, so a click on it is neither `Toggle` nor `InsideClick`, and the spec's own words for crit 3 are *"anywhere on the page outside the overlay"* — the search box is on the page and outside the overlay. The state is reached without a click: Tab in the drive, `locator.focus()` in the spec, and the spec's header carries a paragraph telling the next reader not to "fix" the `.focus()` calls to `.click()`. Whether it is *right* is §6's fifth question; the short answer is that a shopper who moves to search has left the menu, and a menu that stayed open over the field they are typing into would be the one lingering.

Two more facts from the same drive. Chromium's native Escape in an `<input type="search">` cleared «тест» to `""` alongside the menu closing — which is R8 exactly, both effects running and neither blocking the other, because the handler calls neither `preventDefault` nor `stopPropagation`. And with the menu closed, Escape in the field left focus on the field: the `isOpen` guard in the `keydown` listener is the only thing between that and focus being yanked to Каталог on every Escape on the page. That is why the guard was kept there while the `pageshow` handler has none — the reducer's close is idempotent and `dispatch` skips the paint when nothing changes, so a guard on `pageshow` would protect nothing.

### 5.2 The RED that was mispredicted

The brief for the unit test predicted that making `InsideClick` return `false` would fail two cases. One fell. The closed case — `reduceMenu(CLOSED, InsideClick)` — expects `false`, and a mutant that always returns `false` returns exactly that. The case is not wrong; it guards a different mutation: an inside click treated as a `Toggle`, which turns closed into open. Run that mutation and both cases fall.

The lesson is the one Slice 2's `wrapIndex` RED taught (dropping the `+ count` normalisation failed only the first→last case and left last→first green): a mutation proves only the tests that can see it, and "this case can fail" has to be shown per case, not per file. A prediction of two was a guess that both cases watched the same thing. They do not, and the file's header now says which mutation each one is for.

### 5.3 The shared browser, and the reload under the verifier's feet

Two findings about the harness, neither about the product, both now scheduling rules.

The Playwright MCP is **one browser**, shared by every agent in the session. Two agents driving it concurrently — one verifying this slice, another working on its own — closed each other's page mid-drive: a `goto` from one is a navigation in the other's tab. The rule: one driver at a time; a verify task is scheduled after, not beside, any other task that uses the MCP.

Editing `src/` while a verifier is driving the dev server triggers Vite's hot-module reload. For a page that holds its state in closures — `isOpen` is a `let` inside `createCatalogMenu` — a reload rebuilds the page mid-drive, and a screenshot taken across that boundary can show the overlay open when the drive's last action closed it. The rule: no source edits during a live drive; a screenshot is taken against a tree nobody is writing to.

Both are the fact Slice 1's §6.4 found for the database, moved to the browser: a shared resource with global state cannot be driven by two actors at once, and "flaky" is usually a second actor.

### 5.4 Read while writing this document — reported, not fixed

- **One sentence in `catalog-menu.ts`'s header is one degree too strong.** Lines 22–25: `stopPropagation()` in the button handler "hides the click from every listener above the button — including the delegated one `enableBuyControls` keeps on the product row". The row's listener is on a sibling subtree, not above the button; a Каталог click never reaches it under any design. The accurate claim is §3.1's: the patch makes stopping events the page's exemption mechanism, and that mechanism punches a hole for whoever is above — which on this page means the row's delegated listener for any click stopped inside the row, and the menu's own `document` listener for the Купить click it needs to see. Technical-considerations §2.4 and `CLAUDE.md` carry the same parenthetical.
- **`menu.ts`'s header counts "five graded menu criteria"** (line 15); functional spec §2.3 has six, the sixth being "several times in a row". Nothing depends on the number.
- **`CLAUDE.md`'s `stopPropagation` grep is scoped to `pages/storefront/`.** The argument in §3.1 needs it to hold for `features/buy-product` too — the Купить click has to reach `document`. It does: the grep over the whole of `apps/web/src` finds zero `stopPropagation` and exactly one `preventDefault`, in `features/present-admin-token/ui/admin-token-form.ts:88`, a real `<form>`'s real submit on the admin page this phase does not touch.
- **The Подборки column wraps to a second row** in both screenshots, under Steam, where the mockup draws six columns across. The overlay's columns are `auto-fit` by the tech spec's own §2.6, and menu accuracy is not graded; noted so nobody reads it as a regression later.

---

## 6. Interview questions this answers

**"Why is the click listener on `document` and not on the button?"**
Because the opening click and the outside check have to be one decision. A listener on the button runs first and opens; the same click keeps bubbling to a closer on `document`, which sees an open menu and closes it — in the same task, before a paint, so the menu never opens. With one listener on `document`, every click on the page arrives once and is classified once: on the button → `Toggle`, inside the overlay → `InsideClick`, anything else → `OutsideClick`. There is no second listener to disagree with the first. `addEventListener("click"` appears on exactly one line of the file, and there is no `stopPropagation` anywhere in the web app — because nothing needs one.

**"Why not just `stopPropagation` in the button handler? Everyone does."**
Because `stopPropagation` is not aimed at the menu's closer; it is aimed upward at everything. The page has two listeners whose contract is to be above and see every click: `enableBuyControls`, delegated on the product row for buttons that arrive with the catalogue, and the menu's own, which needs the Купить click to reach `document` so the overlay is closed before `location.assign`. Making "stop the event to be exempt from the closer" the page's mechanism means every future exemption is a hole for whatever delegated listener sits above it. On today's tree the button and the overlay contain no delegated target, so the hole would be empty — but a design that never stops an event never has to decide where stopping is safe.

**"Why `click` and not `pointerdown`?"**
The spec says clicks. `pointerdown` fires on press, so a shopper who presses outside the overlay to start a drag-select of text would close the menu before releasing. And a keyboard user who presses Enter or Space on the focused Каталог button gets a `click` event and no `pointerdown` at all — the one listener serves mouse and keyboard because it listens for the event both produce.

**"Escape closes the menu but you don't `preventDefault`. Why not?"**
There is nothing of ours to prevent. The only element on the page with its own Escape behaviour is the search field, an `<input type="search">`, whose native Escape clears its text in Chromium. Blocking that would be the menu deciding on the search field's behalf. The drive shows both effects: Tab into the field, type «тест», Escape → the menu closes, focus returns to Каталог, and the field reads `""`. That is R8 exactly: both harmless, neither blocking the other. The guard that *is* there is `isOpen` — without it, Escape anywhere on the page would yank focus to the button while the menu was closed; the test presses Escape in the field with the menu closed and asserts the field keeps focus.

**"Clicking the search box closes the menu. Is that right?"**
Yes, and it is the spec's own wording: *"clicks anywhere on the page outside the overlay"*. The search box is in the header, not in the overlay. A shopper who moves to search has left the menu; a menu that stayed open over the field they were typing into would be the one lingering over the page — the thing §2.3's user story says it must never do. The consequence for testing is that "menu open and search field focused" cannot be reached by clicking; the drive used Tab and the spec uses `locator.focus()`, and the spec's header tells the next reader not to change that.

**"Why toggle the `hidden` attribute rather than an `is-open` class?"**
Because `hidden` is the standard word for the state, and three readers already know it: CSS through `[hidden]`; the DOM through the boolean `overlay.hidden`, which the test reads beside `aria-expanded` instead of parsing a class name; and the accessibility tree, which drops what is not displayed. An `is-open` class is a convention private to this stylesheet — nothing else on the page or in the test knows what it means, and the closed state becomes "whatever the absence of a class does". The one trap is that the browser's `[hidden] { display: none }` is a user-agent rule and the overlay's own `display: flex` outranks it — so the sheet carries `.catalog-menu[hidden] { display: none }` with a comment saying exactly that, and the accessibility-tree snapshot is the check that the bit reaches the reader it is for: closed, the tree shows `button "Каталог"` and no «Каталог товаров» region.

**"The menu's columns don't switch when you hover a category. Isn't that unfinished?"**
It is the assignment's instruction. The product definition quotes it: *"open/close only … column detail may be simplified — menu accuracy is explicitly not graded"*. What is graded is that Каталог opens it and a second click or a click outside closes it — and the spec adds Escape, inert inner clicks, and repeatability. The content is still the mockup's, verbatim from Figma node `1:1193` in `config/catalog-menu.ts`, including «Скидки 90%», which is there because the mockup writes it, as an `<li>` nobody can click. Wiring hover-switching would mean inventing per-category content the shop does not have, which is the same reason the search is not wired.

**"How do you know inner clicks are inert, rather than believing it?"**
Three layers, each shown able to fail. Markup: the grep for `createElement("a"` over the storefront returns nothing, categories are `<button type="button">` with no listener, items are `<li>` text — there is no default action and no handler for a click to reach. Reducer: `InsideClick → isOpen` is a branch with a test; make it return `false` and *"on an open menu stays open"* fails. Browser: a category and an `<li>` are clicked with `request` and `pageerror` listeners armed beforehand, and the overlay is still open, the URL unchanged, no document request, no error — and asserting the opposite gives `Expected: true Received: false` and `Expected: not "http://localhost:5101/"`. Plus the drive's 0 console errors and two byte-identical screenshots either side of the click.

---

## 7. What is not finished

- **Slice 4.** The currency control's graded confirmation, every hover and focus rule — the sheet still has none — and `currency.spec.ts` / `hover.spec.ts`.
- **Slice 5.** Five cards, the picture, the buy-through from this page, and the real back/forward-cache check in Chrome. The menu's `pageshow` handler has been exercised only with a synthetic `persisted: true` event; the first time a page actually leaves for `/order/:id` and comes back is Slice 5's buy-through, and that is where the DevTools verdict gets recorded.
- **Slice 2's explain task.** `docs/walkthrough/phase-4-slice-2-the-banner.md` was being written in parallel and appeared as this document was being finished; it uses the same headings, and its §3.3 and §5.4 are where the back/forward-cache verdict lives — this document only points there.
- **Slice 6.** `docs/walkthrough/phase-4.md`; this document is the slice's explanation, not the phase's.
- **The four items in §5.4.** Reported, not changed: the header's `stopPropagation` sentence in `catalog-menu.ts` and the same parenthetical in technical-considerations §2.4 and `CLAUDE.md`; "five" for six in `menu.ts`; the grep's scope; the wrapped sixth column.
- **Task 5 of Slice 3** — this document — is unticked in `tasks.md` until the user has read it; task 4's tick is in the working tree and not yet committed, and the two screenshots are untracked.

---

## Source files

- `apps/web/src/pages/storefront/model/menu.ts` — `MenuEvent`, `reduceMenu`; the header on why six lines earn a file and why close is idempotent
- `apps/web/src/pages/storefront/model/menu.test.ts` — the eight cases; the header on which mutation each InsideClick case is for
- `apps/web/src/pages/storefront/ui/catalog-menu.ts` — the one click listener at line 165, the `keydown` listener at 183, `pageshow` at 193; the four header sections
- `apps/web/src/pages/storefront/ui/header.ts` — the `Header` interface; `aria-expanded` and `aria-controls` as facts about the markup
- `apps/web/src/pages/storefront/ui/storefront-page.ts` — `createCatalogMenu(header.catalogButton)`, the one dependency between sections
- `apps/web/src/pages/storefront/ui/storefront.css` — `.catalog-menu` and the `[hidden]` rule that outranks its `display: flex`
- `apps/web/src/pages/storefront/config/catalog-menu.ts` — the five categories and six columns, verbatim from Figma `1:1193`
- `apps/web/src/pages/storefront/CLAUDE.md` — the "one document listener" bullet and its three greps
- `apps/web/src/features/buy-product/ui/buy-controls.ts` — `enableBuyControls`: the delegated listener that needs clicks to travel up
- `apps/web/src/pages/storefront/ui/popular-products.ts` — `enableBuyControls(region)`, the one line
- `apps/web/e2e/catalog-menu.spec.ts` — the six tests; `menuState`; `assertStillOpenAndInert`; the header's three facts from driving the page
- `context/spec/004-storefront-per-the-design/functional-spec.md` §2.3
- `context/spec/004-storefront-per-the-design/technical-considerations.md` §2.2 (Menu), §2.3, §2.4, §4.1, §4.2, R3, R8
- `context/product/product-definition.md` §2.3 — "open/close only … menu accuracy is explicitly not graded"
- `docs/screenshots/004-storefront-per-the-design-menu-open.png`, `-menu-inner-click.png`

**On evidence:** what I ran fresh while writing this document, against the tree as it stands, with no server started and no source, test or config file modified. `pnpm --filter @game-shop/web run typecheck` — both `tsc --noEmit` passes — clean. `pnpm test:web` — **3 files / 39 tests, 146 ms**, all passed. `grep -n 'addEventListener("click"' ui/catalog-menu.ts` — one line, **165**; all `addEventListener` calls in that file — three, at 165 (`document`, click), 183 (`document`, keydown), 193 (`window`, pageshow). `grep -rn '\.stopPropagation(\|\.preventDefault('` over `pages/storefront/` — nothing; over the whole of `apps/web/src` — zero `stopPropagation`, one `preventDefault` at `features/present-admin-token/ui/admin-token-form.ts:88`. `grep -rn 'createElement("a"'` and `createElement("form"` over `pages/storefront/` — nothing. `setTimeout(` over `pages/storefront/` — one line, `model/countdown.ts:77`. `cmp` on the two screenshots — identical; both `md5` `cabdb9d0f9d533bdf5bec8c60e6511d6`; both opened and read. `test(` declarations across the four e2e files — 6 / 6 / 8 / 8, the inert-controls 8 including one inside a loop of seven chips, which is the 34. `git log` — the slice's code and spec are in commit `038f7d4`; `git status` — `tasks.md` modified (task 4 ticked), the two screenshots untracked. `wc -l` — `menu.ts` 81, `menu.test.ts` 88, `catalog-menu.ts` 200, `header.ts` 77, `storefront-page.ts` 55, `catalog-menu.spec.ts` 257.

Everything else is reported by the slice's four task agents and quoted rather than re-run: the three unit REDs and their counts, the two e2e RED lines, the 350–520 ms per test and 21.9–27.8 s suite times, every fact of the live drive (the 659 / 544 px geometry, the `display: flex`, the `""` after Escape, the (20, 400) click, the synthetic `pageshow`), the three accessibility-tree snapshots, and the two harness findings. The e2e suite was not run for this document — it starts two servers and touches the shared database, and §5.3 is the reason not to do that while another slice is working.
