# Functional Specification: Purchase and Key Delivery

- **Roadmap Item:** Phase 1 — The Spine (A Catalog to Buy From; The Purchase Pipeline)
- **Status:** Completed
- **Author:** Alexander Shleyko

---

## 1. Overview and Rationale (The "Why")

A shopper who wants a game key expects the same thing every digital-goods shop promises: pick an item, pay, and have the key on screen seconds later, with nobody in the middle. Right now the shop does none of this — there is nothing to browse, nothing to buy, and no way to receive anything.

This specification covers that complete path, end to end, for the first time: seeing what is for sale, choosing something, paying for it, and receiving a key. It is deliberately the plain version. The shop is not yet dressed to look like the design, and the pages here are functional rather than attractive.

The reason to build it first is that everything valuable about this product happens *along* this path. Later work makes the path survive a shopper who clicks Buy twice, a payment service that reports the same payment several times, and a supplier that goes quiet halfway through. None of that can be built, and none of it can be demonstrated, until the path itself exists and works.

One promise applies from this very first version: **a key that has been given to one shopper is never given to another.** It is the shop's core commitment to the people buying from it, and it is what all the later reliability work protects.

**Success looks like:** a person can open the shop, buy something, and end up looking at a key, without anyone stepping in to help; and two shoppers who buy the same item never end up holding the same key.

---

## 2. Functional Requirements (The "What")

### 2.1 Seeing what is for sale

- **As a** shopper, **I want to** see the items the shop sells, **so that** I can choose one to buy.
  - **Acceptance Criteria:**
    - [x] When the shopper opens the shop page, then they see all twelve items from the shop's catalogue.
    - [x] When the shopper looks at any item in the list, then they see its name and its price in roubles.
    - [x] When the shopper looks at an item that can be bought, then they see a Buy control on it.

### 2.2 Starting a purchase

At least one item must support the whole purchase path. Other items may be shown for display only in this version.

- **As a** shopper, **I want to** start buying an item, **so that** I can get the key it promises.
  - **Acceptance Criteria:**
    - [x] When the shopper uses the Buy control on a purchasable item, then they arrive at an order page for that item.
    - [x] When the shopper arrives at a newly created order page, then they see the item's name, the amount to pay, and that the order is waiting for payment.
    - [x] When the shopper looks at an order that is waiting for payment, then they see one control to pay successfully and one control to make the payment fail.

### 2.3 Paying for an order

Payment is simulated in this version: the shopper chooses the outcome rather than entering card details.

- **As a** shopper, **I want to** pay for my order and see the result, **so that** I know whether my purchase went through.
  - **Acceptance Criteria:**
    - [x] Given an order is waiting for payment, when the shopper chooses the successful payment control, then the order page shows that the order is being processed.
    - [x] Given an order is waiting for payment, when the shopper chooses the failing payment control, then the order page shows that the payment did not go through and no key is shown.
    - [x] Given an order's payment has already failed, when the shopper looks at the order page, then they see no controls offering to pay again.

### 2.4 Receiving the key

- **As a** shopper, **I want to** receive my key automatically once I have paid, **so that** I do not have to wait for anyone or ask for it.
  - **Acceptance Criteria:**
    - [x] Given a payment has succeeded, when the shop finishes preparing the order, then the order page shows the order as delivered together with the key, with nobody having taken any further action.
    - [x] Given the shopper stays on the order page after paying successfully, when the order reaches a settled state, then the page shows the change without the shopper reloading it.
      - _Note: the intermediate states between paying and delivery are real but, in this version, usually last under a tenth of a second, so a shopper will rarely see them. The page updates itself for whichever states it does observe. See the Change Log._
    - [x] Given an order has been delivered, when the shopper reloads the order page, then they see the same key they saw before.
    - [x] Given an order has been delivered, when the shopper returns to that order page much later, then they still see the same key.

### 2.5 A key is never given away twice

- **As a** shopper, **I want** the key I receive to be mine alone, **so that** what I bought actually works when I use it.
  - **Acceptance Criteria:**
    - [x] Given two separate orders for the same item have both been paid, when both orders reach delivered, then the two order pages show two different keys.
    - [x] Given every key the shop holds has already been given out, when a further order is paid, then the order page shows that the item cannot be delivered at the moment and no key is shown, and the page continues to work normally rather than showing an error or failing to load.

### 2.6 Finding an order again

- **As a** shopper, **I want to** return to my order later, **so that** I can find my key again.
  - **Acceptance Criteria:**
    - [x] When the shopper opens the address of an order that exists, then they see that order's current state and, if it has been delivered, its key.
    - [x] When the shopper opens the address of an order that does not exist, then they see a message telling them the order could not be found, rather than a blank or broken page.

### 2.7 Understanding what was built

The author has to present this work and answer questions about it. A walkthrough he can read and rehearse from is therefore a deliverable of the phase, not a by-product of it — the product definition names being able to explain the work as a measure of success in its own right.

- **As the** author preparing to present this work, **I want** a written walkthrough of the decisions that carry this phase, **so that** I can explain them unaided when questioned.
  - **Acceptance Criteria:**
    - [x] When this phase is finished, then a written walkthrough accompanies it that names each keystone decision in plain language.
    - [x] When the author reads any keystone entry, then it states what the decision is, why it was chosen over the more obvious alternative, and what specifically goes wrong without it.
    - [x] When a keystone rests on a guarantee made by the shop's records, then the entry shows the exact instruction that enforces it next to the plain-language explanation.
    - [x] When someone who has never seen the source reads the walkthrough, then they can follow every entry without opening the code.
    - [x] When this phase is complete, then the walkthrough covers at least these three keystones: why an order moves through named states rather than simply being paid or not; why the shop, rather than the page the shopper is looking at, decides that a key has been given out; and how the shop makes it impossible for the same key to reach two orders.

### 2.8 Language of shopper-facing text

- **As a** shopper in the shop's market, **I want** everything I read to be in Russian, **so that** the shop reads as a real shop rather than a demonstration.
  - **Acceptance Criteria:**
    - [x] When the shopper reads any text on the shop page, the order page, or any message shown to them, then that text is in Russian.
    - [x] When the shopper sees an item's name, then it matches the name given in the shop's catalogue, such as "Пополнение Steam 500 ₽".

This applies to every later specification as well, including the view used to resolve problem orders.

---

## 3. Scope and Boundaries

### In-Scope

- The shop page listing the twelve catalogue items with names and prices.
- The complete purchase path — browse, buy, pay, receive — working for at least one item.
- Simulated payment with both a successful and a failing outcome chosen by the shopper.
- Automatic delivery of a key once payment succeeds, with no human step.
- An order page that shows the order's current state and, once delivered, the key.
- The guarantee that one key is never given to two orders.
- Plain, functional pages. Appearance is explicitly not part of this work.
- A written walkthrough of this phase's keystone decisions, in plain language, readable without the source.

### Out-of-Scope

**Deferred to later roadmap phases** (added automatically, as these are separate roadmap items):

- Correct behaviour when the shopper clicks Buy twice, when the same payment is reported more than once, when several payment reports arrive at the same time, or when they arrive in the wrong order — Phase 2.
- Recovering an order that could not be delivered, including retrying it by hand and the view listing paid-but-undelivered orders — Phase 3. This version only requires that such an order does not break the page.
- Suppliers that fail or go quiet, and switching between them — Phase 3.
- The shop page built to match the design, and its five interactive elements — Phase 4.
- Promo codes and discounts — Phase 5.
- Publishing the shop to a public address, and the written explanation of how it works — Phase 6.

**Not part of this product at all:**

- Real payment. No card details, no bank, no refunds.
- Accounts, signing in, and any personal area or purchase history.
- A basket. A shopper buys one item at a time.
- Search and filtering.
- Changing the displayed currency.

---

## Change Log

- [2026-09-07] — Slice 5 verification — §2.4's "shows each change" criterion was reworded. The page does update itself without a reload, and this was proven live for the changes it can observe (`created → out_of_stock`, `created → payment_failed`, and `created → delivered`). But in this version the shop applies a payment inside the same request that reports it, so the whole chain from paid to delivered completes in roughly 60ms and the in-between states are not reliably visible to anyone. The mechanism was confirmed by artificially slowing the supplier, which made the intermediate state appear and the page follow it. The criterion now promises what a shopper can actually check; the fuller behaviour returns when payment handling moves out of the reporting request in a later phase.

_Dated amendments made after the spec was first written — typically by `/awos:spec` in Update Mode when a bug fix changed documented behavior. Each entry records the date, the source reference (bug id or fix description), and what behavior changed and why. Leave empty until the first amendment._
