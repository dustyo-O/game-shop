# Functional Specification: Single Issuance Under Races

- **Roadmap Item:** Phase 2 — Single Issuance Under Races; Proof the Reviewer Can Run
- **Status:** Draft
- **Author:** Alexander Shleyko

---

## 1. Overview and Rationale (The "Why")

The shop already works when the world behaves. A shopper clicks once, the payment service reports the payment once, and everything arrives in the order it was sent. Under those conditions the shop keeps its promise: one payment, one key.

The world does not behave. Shoppers double-click when nothing happens fast enough, and open the same purchase in a second tab. Payment services report the same payment several times on purpose — that is how they guarantee a report is never lost — and those reports can arrive at the same instant, or before the shop has finished writing down the order they refer to.

**Today the shop does not survive all of that.** Two clicks in quick succession produce two separate orders, and a shopper could be charged twice for one purchase. That gap is known and measured; closing it is the first thing this phase does.

There is a second reason this phase matters as much as the first. The shop's central promise — *a key given to one shopper is never given to another* — is currently something a reviewer has to take on trust for the situations that matter most. This phase turns it into something they can check themselves in one command: the shop ships the adversarial checks it claims to survive, and each one is able to report a failure.

**Success looks like:** an impatient shopper who clicks Buy three times ends up with one order and one key; a shopper whose payment is reported fifty times at once ends up with one key; and a reviewer who runs the shop's own checks watches each of them exercise the shop and report a verdict.

---

## 2. Functional Requirements (The "What")

### 2.1 Buying once, however many times I click

A repeated attempt is shown **silently**: the shopper sees their order page exactly as if the first click had worked, with no notice that anything was repeated. They clicked again because nothing appeared to happen, so naming the repetition answers a question they never asked and makes correct behaviour look like a fault.

- **As a** shopper, **I want** my repeated clicks to produce one purchase, **so that** I am never charged twice for something I meant to buy once.
  - **Acceptance Criteria:**
    - [ ] Given a shopper is looking at a purchasable item, when they click Buy several times in quick succession, then they arrive at a single order and only that one order exists.
    - [ ] Given a shopper's click has already produced an order, when the same purchase attempt reaches the shop again, then they are shown that same order rather than a new one.
    - [ ] Given a shopper opens the same purchase in a second tab before the first has finished, when both attempts complete, then only one order exists for that purchase.
    - [ ] Given a shopper's click appears to fail because the shop was briefly unreachable, when they click Buy again for the same purchase, then they end up with one order rather than two.
    - [ ] Given a shopper has already bought an item and wants another one, when they start a fresh purchase of the same item from the shop page, then they get a separate second order with its own key.
    - [ ] Given a shopper's repeated attempt is shown the order they already started, when they look at the page, then it reads exactly as it would have had their first attempt succeeded, with no notice that anything was repeated.

### 2.2 Receiving exactly one key, however many times my payment is reported

- **As a** shopper, **I want** one key for one payment, **so that** what I bought is mine alone and the shop's stock is not quietly drained.
  - **Acceptance Criteria:**
    - [ ] Given a shopper's payment has been reported once and their key delivered, when the payment service reports that same payment again, then the order is unchanged and the shopper still holds exactly one key.
    - [ ] Given the payment service reports one shopper's payment fifty times at the same moment, when the shop has finished, then the shopper has been given exactly one key and exactly one key has left the shop's stock.
    - [ ] Given many reports of one payment are being handled at once, when the shopper looks at their order page throughout, then they never see two different keys or an error.

### 2.3 My purchase completes even when news arrives out of order

- **As a** shopper, **I want** my purchase to complete regardless of the order in which the shop learns things, **so that** a few milliseconds of bad luck does not cost me a key I paid for.
  - **Acceptance Criteria:**
    - [ ] Given the payment service reports a payment before the shop has finished recording the order it belongs to, when the order is recorded, then the payment is applied to it and the shopper receives their key without taking any further action.
    - [ ] Given news about one order arrives in an unexpected sequence, when the shop has finished handling all of it, then the order rests in the state the shopper's actual payment left it in.
    - [ ] Given a payment was reported for an order that never appears, when a person later looks for it, then that report is still on record rather than discarded.

### 2.4 The shop takes responsibility the moment it is told

- **As a** shopper, **I want** the shop to own my payment from the instant it hears about it, **so that** my purchase is not lost because the shop was busy or something went wrong afterwards.
  - **Acceptance Criteria:**
    - [ ] Given the payment service reports a payment, when the shop accepts the report, then it confirms receipt promptly and completes the order as separate work rather than making the payment service wait for it.
    - [ ] Given the shop has accepted a report, when something goes wrong while completing that order, then the payment service is not asked to send the same report again.
    - [ ] Given the shop genuinely could not record a report, when the payment service asks whether to send it again, then the answer is yes.

### 2.5 Watching my purchase progress

Spec 001 §2.4 promised that the page shows each change as it happens, and was reworded during verification because the whole sequence finished in about a tenth of a second — the stages were real but nobody could see them. Confirming receipt before doing the work (§2.4 above) makes them observable again, so the original promise can be restored. The reason is not that the stages became longer — they did not — but that the shop now answers at the *start* of the work rather than at the end, so a page that refreshes itself on hearing that answer looks while the work is still happening.

- **As a** shopper, **I want to** watch my order move through its stages, **so that** I can see the shop is working rather than wondering whether it has stalled.
  - **Acceptance Criteria:**
    - [ ] Given a shopper stays on the order page after paying successfully, when the order moves from awaiting payment through being processed to delivered, then the page shows each of those changes without the shopper reloading it.
    - [ ] Given the shop is taking longer than usual to complete an order, when the shopper watches the order page, then they see that the order is being processed rather than an unexplained wait.

### 2.6 Checking the shop's promises rather than trusting them

The reviewer is a named audience for this product. The assignment asks for a reproducible way to check the shop under adversarial conditions, and this is that deliverable.

- **As a** reviewer, **I want to** run the shop's own adversarial checks, **so that** I can see the promises hold instead of taking the shop's word for it.
  - **Acceptance Criteria:**
    - [ ] Given the reviewer has the shop running, when they run its adversarial checks with a single command, then each check exercises the shop and reports whether the promise held.
    - [ ] Given the reviewer runs the checks, when they finish, then there is one named check for each of these three situations: many payment reports for one order at the same moment; the same report delivered twice; and a report arriving before its order.
    - [ ] Given a check has passed, when the mechanism it defends is deliberately weakened, then that check reports a failure — so a passing check is evidence rather than decoration.
    - [ ] Given the reviewer runs the checks twice in a row, when the second run finishes, then it behaves the same as the first with no manual tidying up in between.
    - [ ] Given the shop is published to a public address, when the reviewer points the same checks at that address, then they run there without being rewritten.

### 2.7 Understanding what was built

- **As the** author preparing to present this work, **I want** a written walkthrough of the decisions that carry this phase, **so that** I can explain them unaided when questioned.
  - **Acceptance Criteria:**
    - [ ] When this phase is finished, then a written walkthrough accompanies it that names each keystone decision in plain language.
    - [ ] When the author reads any keystone entry, then it states what the decision is, why it was chosen over the more obvious alternative, and what specifically goes wrong without it.
    - [ ] When a keystone rests on a guarantee made by the shop's records, then the entry shows the exact instruction that enforces it next to the plain-language explanation.
    - [ ] When someone who has never seen the source reads the walkthrough, then they can follow every entry without opening the code.
    - [ ] When this phase is complete, then the walkthrough covers at least these three keystones: how the shop tells a repeated attempt from a genuine second purchase; why a report the shop has already handled is a success rather than an error; and why work that happens after the shop says "received" is what makes the shop able to say it quickly.

### 2.8 Language of shopper-facing text

- **As a** shopper in the shop's market, **I want** everything I read to be in Russian, **so that** the shop reads as a real shop rather than a demonstration.
  - **Acceptance Criteria:**
    - [ ] When the shopper reads any text this phase adds or changes, then that text is in Russian, as established in spec 001 §2.8.

---

## 3. Scope and Boundaries

### In-Scope

- One order per purchase attempt, however many times the shopper clicks or retries.
- One key per payment, however many times or however simultaneously that payment is reported.
- Correct handling of a payment reported before its order exists, and of reports arriving out of sequence.
- Prompt confirmation of receipt, with the order completed as separate work.
- The order page showing each stage of a purchase as it happens.
- Adversarial checks the reviewer runs, covering the three situations named in §2.6, each able to report a failure, re-runnable, and able to run against a published address.
- A written walkthrough of this phase's keystone decisions.

### Out-of-Scope

**Deferred to later roadmap phases** (added automatically, as these are separate roadmap items):

- Suppliers that fail or go quiet, the handling of a supplier that may or may not have done what was asked, and switching to a backup supplier — Phase 3.
- Recovering an order that could not be delivered, the view listing paid-but-undelivered orders, and manual retry — Phase 3.
- The shop page built to match the design, and its five interactive elements — Phase 4.
- Promo codes and discounts, and the check that a limited code cannot be over-used — Phase 5.
- Publishing the shop to a public address — Phase 6. This phase only requires that the checks *can* be pointed at one.

**Already delivered in spec 001, and not revisited here:**

- Browsing, buying, paying, and receiving a key on the ordinary path.
- One key never reaching two orders, and the check that proves it.
- An empty key stock leaving an order recoverable rather than broken.

**Not part of this product at all:**

- Real payment. The payment service remains simulated.
- Accounts, signing in, a personal area, or purchase history.
- A basket. A shopper buys one item at a time.

---

## Change Log

_Dated amendments made after the spec was first written — typically by `/awos:spec` in Update Mode when a bug fix changed documented behavior. Each entry records the date, the source reference (bug id or fix description), and what behavior changed and why. Leave empty until the first amendment._
