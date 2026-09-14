# Functional Specification: Storefront per the Design

- **Roadmap Item:** Phase 4 — Storefront per the Design; Connecting Face to Engine
- **Status:** Completed
- **Author:** Alexander Shleyko

---

## 1. Overview and Rationale (The "Why")

Three phases in, the shop is right about the hard things: one order per purchase, one key per payment, a supplier's silence never costing a second key, a stuck order recoverable by a person. None of that is visible. The page a shopper lands on today is a plain list of twelve names and prices with a button on three of them — deliberately so, because appearance was out of scope until the engine underneath was proven.

The assignment asked for something else on its first page: a storefront built from a supplied design. It is the first thing a reviewer opens, before any check is run or any line of code is read, and a shop whose front looks unfinished is judged unfinished, however sound its records. The assignment is also precise about how much of that design matters. The page must be *structurally* close to the mockup — the same blocks in the same order — and exactly five interactions must work: the banner advancing, the catalog menu opening and closing, the currency control changing state, the service icons highlighting on hover, and the product cards lifting on hover. Everything else on the page may be static, pixel-perfect fidelity is explicitly not required, and the reviews, footer, mobile and dark variants are explicitly excluded.

This phase gives the shop that face, and connects it to the engine: the buy button on a real product card starts the same purchase the plain page starts today, and the shopper is carried to the same order page and the same key.

**Success looks like:** a reviewer opens the shop and, at a glance, recognises the top half of the mockup; tries each of the five interactions and each one responds; presses Купить on a card, pays on the order page, and receives a key — through a storefront that never once shows them a word of English or a broken control.

---

## 2. Functional Requirements (The "What")

### 2.1 The page a shopper lands on

The shop's front page is rebuilt to match the mockup's upper half. From top to bottom it contains: a header with the Каталог button, a search field, and favourites and profile icons; a wide banner with left/right arrows and a row of position dots; a strip of service tiles (Steam, Telegram, Roblox, Brawl Stars, PUBG Mobile, App Store, ChatGPT, PlayStation, TikTok, Mobile Legends, and an «еще 841» tile); a Steam top-up block with a promo-code control, a Steam login field, a sum, a $/₸/₽ control, and an «Оплатить» button; and one row titled «Популярные товары» with a set of category chips and five product cards. Nothing appears below that row.

- **As a** reviewer, **I want** the shop's front page to be recognisably the mockup, **so that** the first thing I open matches what the assignment asked for.
  - **Acceptance Criteria:**
    - [ ] When the shopper opens the shop's front page, then they see, from top to bottom, the header, the banner, the service strip, the Steam top-up block, and the «Популярные товары» row, and nothing below it — no reviews, no footer, no further product rows.
    - [ ] When the shopper compares the page with the mockup, then every block named above is present, in the mockup's order, with the mockup's own labels.
    - [ ] Given a window at least 1 280 pixels wide, when the shopper opens the page, then the content sits in a single centred column of the mockup's width with equal space either side and no horizontal scrollbar.
    - [ ] Given a window narrower than the mockup's column, when the shopper opens the page, then the page still fills the window edge to edge with no horizontal scrollbar — rows of tiles and cards wrap onto further lines rather than overlapping or being cut off.
    - [ ] When the shopper reads anything on the page other than a brand name (Steam, Roblox, TikTok and the like), then it is in Russian.

### 2.2 The banner advances on its own and by hand

The banner shows four slides, each a dark panel with a short Russian headline and one line of text. It moves on its own, can be moved by the arrows, and always shows which slide is current.

- **As a** shopper, **I want** the banner to move on its own and to obey the arrows, **so that** I can watch the offers pass or go straight to the one I want.
  - **Acceptance Criteria:**
    - [ ] When the shopper opens the page and does nothing, then the banner advances to the next slide every 5 seconds.
    - [ ] When the banner is on its last slide and advances, then it shows the first slide again rather than stopping.
    - [ ] When the shopper presses the right arrow, then the next slide appears at once; when they press the left arrow, then the previous slide appears at once.
    - [ ] Given the banner is on the first slide, when the shopper presses the left arrow, then the last slide appears.
    - [ ] When the shopper looks at the dots beneath the banner, then exactly one dot is highlighted and it is the dot for the slide currently shown, after both automatic and manual moves.
    - [ ] When the shopper presses an arrow, then the automatic 5-second count starts over from that moment, so the banner does not jump again immediately after a manual move.
    - [ ] Given the shopper's pointer is over the banner, when 5 seconds pass, then the banner does not advance; when the pointer leaves, then automatic advancing resumes.

### 2.3 The catalog menu opens and closes

Pressing Каталог opens an overlay in the shape of the mockup's: five categories down the left with the first one highlighted, and the mockup's column lists on the right (Steam, PlayStation, Xbox, Nintendo, Battle.net, and Подборки). Its contents are static text; the assignment does not grade the menu's accuracy, only that it opens and closes correctly.

- **As a** shopper, **I want** the catalog menu to open when I ask and close when I am done, **so that** it never traps me or lingers over the page.
  - **Acceptance Criteria:**
    - [ ] Given the menu is closed, when the shopper clicks Каталог, then the overlay appears below the header, over the page, showing the five left-hand categories and the right-hand columns.
    - [ ] Given the menu is open, when the shopper clicks Каталог again, then the overlay closes.
    - [ ] Given the menu is open, when the shopper clicks anywhere on the page outside the overlay, then the overlay closes.
    - [ ] Given the menu is open, when the shopper presses the Escape key, then the overlay closes.
    - [ ] Given the menu is open, when the shopper clicks any category or item inside the overlay, then nothing changes — the overlay stays open, the page does not navigate, and no error appears.
    - [ ] When the shopper opens and closes the menu several times in a row, then it behaves the same way each time.

### 2.4 The currency control changes its active state

The Steam top-up block carries a three-way control: $, ₸ and ₽. Exactly one is active at a time. Clicking another makes it the active one. Nothing else on the page changes — the sum shown beside it stays as it is, because recalculating amounts is explicitly waived, and the mockup's own pairing of an active «$» with a sum in roubles is reproduced as drawn.

- **As a** shopper, **I want** the currency control to show which option I picked, **so that** I can see my choice took.
  - **Acceptance Criteria:**
    - [ ] When the shopper opens the page, then the «$» option is shown as active and the other two are not, as in the mockup.
    - [ ] When the shopper clicks «₸», then «₸» becomes the active option and «$» is no longer active; when they then click «₽», then «₽» is active and «₸» is not.
    - [ ] When the shopper clicks the option that is already active, then it stays active and nothing else changes.
    - [ ] When the shopper changes the active option, then the sum shown in the block does not change.

### 2.5 Service tiles highlight on hover

- **As a** shopper, **I want** the service tiles to respond when I point at them, **so that** the strip feels alive rather than printed.
  - **Acceptance Criteria:**
    - [ ] When the shopper moves the pointer over any tile in the service strip, including «еще 841», then that tile visibly highlights, and the highlight fades in rather than switching on instantly.
    - [ ] When the shopper moves the pointer off the tile, then the highlight fades out and the tile returns to how it looked before.
    - [ ] When the shopper moves the pointer along the strip from one tile to the next, then only the tile under the pointer is highlighted at any moment.
    - [ ] When the shopper reaches a tile with the keyboard, then it shows the same highlight it shows on hover.

### 2.6 Product cards lift on hover, and show the real catalogue

The «Популярные товары» row holds five cards drawn from the shop's real catalogue: the three items that can be bought first, then the next two items in the shop's own order, shown for display only. Each card carries the item's picture, its name and its price in roubles; the three purchasable ones carry a Купить button.

- **As a** shopper, **I want** the cards to respond when I point at them and to show real goods, **so that** the row is a shop and not a picture of one.
  - **Acceptance Criteria:**
    - [ ] When the shopper looks at the row, then they see exactly five cards, each with a picture, a name and a price in roubles, and Купить on exactly three of them.
    - [ ] When the shopper moves the pointer over a card, then the card visibly lifts — a raised shadow, an outline, or a rise — and the change animates rather than switching instantly.
    - [ ] When the shopper moves the pointer off a card, then it settles back to how it looked before.
    - [ ] When the shopper looks at a card without Купить, then nothing on it looks like a button and clicking it does nothing.
    - [ ] Given the catalogue cannot be loaded, when the shopper opens the page, then the header, banner, service strip and Steam block are all present and working, and the product row alone shows the shop's existing Russian message that the catalogue could not be loaded.

### 2.7 Buying from the new page reaches the key

Купить on a real card starts the same purchase the shop already supports. Nothing about the order page, payment, or delivery changes in this phase; what changes is where the shopper starts.

- **As a** shopper, **I want** the buy button on the new storefront to actually buy, **so that** the page is connected to the shop behind it.
  - **Acceptance Criteria:**
    - [ ] When the shopper presses Купить on a purchasable card, then they arrive at the order page for that item, showing its name, the amount to pay, and that the order is waiting for payment.
    - [ ] Given the shopper is on the order page, when they simulate a successful payment, then the page carries them through to their key without any further action — exactly as it did from the plain page.
    - [ ] When the shopper double-clicks Купить, then they still arrive at one order page, and one order exists.
    - [ ] Given the shopper is on the order page, when they use the browser's back control, then they return to the storefront, with the banner running and the menu closed.

### 2.8 Everything decorative is honestly inert

Several controls on the mockup are drawn but not wired, by the assignment's own allowance: the search field, the favourites and profile icons, the promo-code control, the Steam login field, the «Оплатить» button, the category chips, and the «еще 841» tile. A shopper who tries one must not be misled and must not meet an error.

- **As a** shopper, **I want** a control that does nothing to do nothing quietly, **so that** I am never sent somewhere broken or shown an error for trying.
  - **Acceptance Criteria:**
    - [ ] When the shopper types into the search field and presses Enter, then no results appear, the page does not navigate, and no error is shown.
    - [ ] When the shopper clicks the favourites icon, the profile icon, the promo-code control, a category chip, or the «еще 841» tile, then the page does not navigate and no error is shown.
    - [ ] When the shopper types a Steam login and presses «Оплатить», then no order is created, the page does not navigate, and no error is shown.
    - [ ] When the shopper looks at any of these controls, then nothing about them promises a result they do not deliver — no spinner, no "coming soon", no message.

### 2.9 Understanding what was built

The author has to present this work and answer questions about it. For this phase the question a reviewer is most likely to ask is not *how* an interaction works but *why these five and not the rest* — and why the rest was left static on purpose.

- **As the** author preparing to present this work, **I want** a written walkthrough of the decisions that carry this phase, **so that** I can explain them unaided when questioned.
  - **Acceptance Criteria:**
    - [ ] When this phase is finished, then a written walkthrough accompanies it that names each of the five graded interactions, what the assignment asked of it, and what was built for it.
    - [ ] When the author reads the walkthrough, then it states which parts of the page were deliberately left static, and why that is the assignment's instruction rather than a shortcut.
    - [ ] When the author reads the walkthrough, then it states how the storefront is connected to the purchase path built in earlier phases, and what was and was not changed on that path.
    - [ ] When someone who has never seen the source reads the walkthrough, then they can follow every entry without opening the code.

### 2.10 Language of shopper-facing text

- **As a** shopper in the shop's market, **I want** everything I read to be in Russian, **so that** the shop reads as a real shop rather than a demonstration.
  - **Acceptance Criteria:**
    - [ ] When the shopper reads any text this phase adds — banner slides, menu categories and columns, chips, block labels, buttons, tile captions — then it is in Russian, as established in spec 001 §2.8, with brand names as the mockup writes them.

---

## 3. Scope and Boundaries

### In-Scope

- The front page rebuilt to the mockup's upper half: header, banner, service strip, Steam top-up block, one product row.
- The five graded interactions: banner carousel (automatic, arrows, dots), catalog menu (open/close), currency control (active state), service tile hover, product card hover.
- Four static banner slides with Russian text; a static catalog overlay mirroring the mockup's categories and columns.
- Five product cards from the real catalogue, with Купить on the three purchasable items, connected to the existing purchase path.
- Decorative controls that are visibly present and quietly inert.
- A desktop layout that fills the window, with the content column centred and capped at the mockup's width, and rows that wrap in a narrower window.
- A written walkthrough of the five interactions and what was left static.

### Out-of-Scope

**Deferred to later roadmap phases** (added automatically, as these are separate roadmap items):

- Promo codes and discounts — Phase 5. The «Ввести промокод» control stays decorative until then.
- Publishing the shop to a public address — Phase 6.

**Already delivered, and not revisited here:**

- The order page, payment simulation, key delivery, and their behaviour under races and supplier failure — specs 001, 002 and 003.
- The operator's recovery screen — spec 003.

**Superseded:**

- Spec 001 §2.1's first criterion — *"they see all twelve items from the shop's catalogue"* — described the plain Phase 1 page. From this phase the front page shows five items in one row; the other seven remain in the catalogue but are not shown on the page. Spec 001's remaining criteria for what a card shows, and for the Buy control, still hold.

**Deliberately not part of this phase:**

- **The lower page.** Reviews, footer, and the «Рекомендованные товары» and «Другие товары» rows — the assignment excludes them.
- **Mobile and dark variants; pixel-perfect fidelity.** Structurally close is the stated bar.
- **Working search, favourites, profile, Steam login, «Оплатить», chips, «еще 841».** Rendered, not wired, by the product definition.
- **Currency recalculation.** The control changes state only; the mockup's «$» beside a rouble sum stays as drawn.
- **The mockup's struck-through "old price" and «5 %» badge.** The shop shows one real price per item and invents no discounts.
- **Hover-switching or clickable categories inside the catalog menu.** Menu accuracy is not graded; open/close is.
- **A redesign of the order page or the operator screen.** Working views suffice, per the product definition.
- **Any change to how purchases, payments or deliveries behave.** This phase changes where the shopper starts, not what happens after.

---

## Change Log

_Dated amendments made after the spec was first written — typically by `/awos:spec` in Update Mode when a bug fix changed documented behavior. Each entry records the date, the source reference (bug id or fix description), and what behavior changed and why. Leave empty until the first amendment._

- 2026-09-13 — Slice 1 task 2 (stylesheet), user decision during implementation — §2.1 criteria 3–4 changed from a fixed-width column that scrolls sideways in a narrow window to a full-width page whose centred column is capped at the mockup's width and whose rows wrap below it. The original answer ("fixed width, scroll sideways") was reversed by the user while the stylesheet was being written; the fluid layout was kept and the spec brought into line. Mobile remains out of scope.
