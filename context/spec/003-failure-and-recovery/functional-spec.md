# Functional Specification: Failure and Recovery

- **Roadmap Item:** Phase 3 — Unreliable Suppliers, Handled; Recoverable, Not Broken
- **Status:** Draft
- **Author:** Alexander Shleyko

---

## 1. Overview and Rationale (The "Why")

The shop now survives its own customers and its own payment service. It has not yet been asked to survive its suppliers.

Everything built so far assumes that when the shop asks a supplier for a key, an answer comes back. Suppliers are not like that. They refuse, they break, and — worst of all — they go quiet, leaving the shop holding a question it cannot answer on its own: *did that request go through?*

That last case is the one that costs money, and it is the reason this phase exists. A shop that treats silence as failure will ask a second supplier for a second key, and hand out two keys for one payment while the first key sits issued and unclaimed. A shop that treats silence as success will tell a shopper their key is on its way when nothing was ever issued. **Neither answer is available, because the shop genuinely does not know** — and the only correct move is to go back and ask the same supplier the same question until it says something definite.

There is a second gap, smaller but more visible. Today an order that cannot be delivered simply stops. The shopper is told, truthfully, that something went wrong. Nobody is told *how many* such orders there are, and nobody can do anything about them. A restocked key pool does not un-stick the orders that failed while it was empty. Somebody has to be able to find those orders and push them through, and right now nobody can.

**Success looks like:** a supplier that refuses is replaced by a backup and the shopper never notices; a supplier that goes quiet costs the shop nothing but time, and never a second key; and a person running the shop can open a list of orders that were paid but never delivered, press a button, and watch them complete.

---

## 2. Functional Requirements (The "What")

### 2.1 A supplier that refuses does not cost me my purchase

- **As a** shopper, **I want** my key to arrive even when the shop's usual supplier will not provide one, **so that** a problem between the shop and its suppliers is not my problem.
  - **Acceptance Criteria:**
    - [ ] Given the shop's main supplier refuses a request outright, when the shop handles that refusal, then it asks a backup supplier instead and the shopper receives their key.
    - [ ] Given a purchase was fulfilled by the backup supplier, when the shopper looks at their order, then it reads exactly as it would have had the main supplier fulfilled it, with no mention of which supplier was used.
    - [ ] Given both suppliers refuse, when the shop has finished trying, then the order is left in a state a person can act on rather than appearing to still be in progress.
    - [ ] Given a supplier refused a request, when the shop asks the backup, then the shopper is charged once and receives exactly one key.

### 2.2 Silence from a supplier never costs the shop a second key

This is the requirement the whole phase turns on. "The supplier did not answer" and "the supplier said no" look similar from the outside and demand opposite responses.

- **As** the shop owner, **I want** an unanswered request to be investigated rather than assumed failed, **so that** the shop does not buy a second key for a purchase that was already fulfilled.
  - **Acceptance Criteria:**
    - [ ] Given a supplier does not answer a request within the time the shop is willing to wait, when the shop decides what to do next, then it asks that same supplier about that same request again rather than asking a different supplier.
    - [ ] Given a supplier went quiet but had in fact already issued a key, when the shop asks it again about that request, then the shopper receives that same key and no second key is issued.
    - [ ] Given a supplier went quiet and had not issued a key, when the shop asks it again and gets a definite refusal, then and only then does it turn to the backup supplier.
    - [ ] Given a request's outcome is still unknown after the shop has asked again, when a person later reviews that order, then the record shows the outcome was never established, rather than showing it as failed.
    - [ ] Given a supplier goes quiet on many orders at once, when the shop has finished handling all of them, then the number of keys that have left the shop's stock equals the number of shoppers who received one.

### 2.3 An order that could not be delivered is recoverable, not broken

- **As a** shopper, **I want** a purchase that could not be completed to be something the shop can still put right, **so that** paying and receiving nothing is a delay rather than a loss.
  - **Acceptance Criteria:**
    - [ ] Given the shop could not obtain a key for a paid order, when the shopper looks at their order page, then it tells them plainly that delivery did not succeed and that the shop is dealing with it.
    - [ ] Given an order could not be delivered, when the shopper reads their order page, then the reason is distinguishable — being temporarily out of stock reads differently from something having gone wrong.
    - [ ] Given an order could not be delivered, when the shopper reloads or returns to that page later, then they see the same explanation rather than an error or an empty page.
    - [ ] Given an order was paid but never delivered, when anyone looks at it, then the payment remains recorded against it rather than being discarded.

### 2.4 A person can find every purchase that was paid for but never delivered

- **As the** person running the shop, **I want** one place that lists every paid order without a key, **so that** no shopper's purchase is stuck without anybody knowing.
  - **Acceptance Criteria:**
    - [ ] Given some orders were paid but never delivered, when the operator opens the recovery list, then every one of those orders appears there.
    - [ ] Given an order has been paid and not yet delivered, when the operator opens the list, then that order is present immediately, without waiting for any period to elapse.
    - [ ] Given an order has been delivered, when the operator opens the list, then that order is not in it.
    - [ ] Given the operator is looking at a stuck order, when they read its row, then they can see what was bought, when it was paid for, and what went wrong.
    - [ ] Given no orders are stuck, when the operator opens the list, then they are told plainly that there is nothing to recover, rather than shown an empty screen with no explanation.
    - [ ] Given a person without the shop's operator credentials, when they try to open the recovery list, then they are refused.

### 2.5 An operator can push a stuck order through, and pressing twice changes nothing

- **As the** person running the shop, **I want to** retry a stuck order and trust the result, **so that** fixing one shopper's problem cannot create a worse one.
  - **Acceptance Criteria:**
    - [ ] Given a stuck order and a key available to fill it, when the operator retries that order, then the shopper receives their key and the order leaves the recovery list.
    - [ ] Given an order that was stuck because the shop had run out of keys, when stock is replenished and the operator retries, then the shopper receives exactly one key.
    - [ ] Given the operator retries the same order several times in quick succession, when the shop has finished, then the shopper has exactly one key and exactly one key has left the shop's stock.
    - [ ] Given two operators retry the same stuck order at the same moment, when the shop has finished, then the shopper has exactly one key.
    - [ ] Given a stuck order and still no key available, when the operator retries it, then they are told the retry did not succeed and why, and the order remains in the list.
    - [ ] Given an order that is not stuck, when the operator attempts to retry it, then the attempt is refused rather than re-delivering a completed purchase.

### 2.6 Watching a purchase that is taking longer than usual

- **As a** shopper, **I want** a slow purchase to look like a slow purchase, **so that** I do not think it has failed while the shop is still working on it.
  - **Acceptance Criteria:**
    - [ ] Given the shop is waiting on a supplier that has not answered, when the shopper watches their order page, then it continues to show the order as being processed rather than as failed.
    - [ ] Given the shop establishes that a purchase genuinely could not be fulfilled, when the shopper is watching the order page, then it changes to the explanation from §2.3 without the shopper reloading it.
    - [ ] Given a stuck order is retried successfully by an operator, when the shopper is watching that order page, then their key appears without them taking any action.

### 2.7 Checking the shop's promises rather than trusting them

- **As a** reviewer, **I want to** run the shop's own checks for supplier failure, **so that** I can see the recovery promises hold instead of taking the shop's word for them.
  - **Acceptance Criteria:**
    - [ ] Given the reviewer has the shop running, when they run its checks with a single command, then the supplier-failure situations are exercised alongside the existing ones.
    - [ ] Given the reviewer runs the checks, when they finish, then there is one named check for each of these: a supplier that refuses, a supplier that goes quiet, and an order recovered after stock was replenished.
    - [ ] Given a check has passed, when the mechanism it defends is deliberately weakened, then that check reports a failure.
    - [ ] Given the reviewer can make a supplier fail on demand, when they set how often it fails or goes quiet, then the shop's behaviour under those conditions can be reproduced without changing the shop itself.
    - [ ] Given the reviewer runs the checks twice in a row, when the second run finishes, then it behaves the same as the first with no manual tidying up in between.

### 2.8 Understanding what was built

- **As the** author preparing to present this work, **I want** a written walkthrough of the decisions that carry this phase, **so that** I can explain them unaided when questioned.
  - **Acceptance Criteria:**
    - [ ] When this phase is finished, then a written walkthrough accompanies it that names each keystone decision in plain language.
    - [ ] When the author reads any keystone entry, then it states what the decision is, why it was chosen over the more obvious alternative, and what specifically goes wrong without it.
    - [ ] When a keystone rests on a guarantee made by the shop's records, then the entry shows the exact instruction that enforces it next to the plain-language explanation.
    - [ ] When someone who has never seen the source reads the walkthrough, then they can follow every entry without opening the code.
    - [ ] When this phase is complete, then the walkthrough covers at least these three keystones: why an unanswered request is not a failed one; why asking the same supplier again is safe while asking a different one is not; and how a purchase can be recovered long after it went wrong.

### 2.9 Language of shopper-facing text

- **As a** shopper in the shop's market, **I want** everything I read to be in Russian, **so that** the shop reads as a real shop rather than a demonstration.
  - **Acceptance Criteria:**
    - [ ] When the shopper reads any text this phase adds or changes, then that text is in Russian, as established in spec 001 §2.8.
    - [ ] When the operator reads the recovery list, then its text may be in either language, as it is not shopper-facing.

---

## 3. Scope and Boundaries

### In-Scope

- A backup supplier, used when the main one gives a definite refusal.
- Treating an unanswered request as unknown rather than failed, and going back to the same supplier to establish what happened.
- Both suppliers being able to refuse or go quiet on demand, at a rate the reviewer sets, so every failure can be reproduced.
- Orders that could not be delivered resting in a state a person can act on, with a plain explanation for the shopper.
- A list of paid-but-undelivered orders, and a retry action, behind the shop's existing operator credentials.
- Retrying being safe to press repeatedly and from two places at once.
- Checks the reviewer runs for supplier refusal, supplier silence, and recovery after restocking.
- A written walkthrough of this phase's keystone decisions.

### Out-of-Scope

**Deferred to later roadmap phases** (added automatically, as these are separate roadmap items):

- The shop page built to match the design, and its five interactive elements — Phase 4.
- Promo codes and discounts, and the check that a limited code cannot be over-used — Phase 5.
- Publishing the shop to a public address — Phase 6.

**Already delivered, and not revisited here:**

- One order per purchase attempt, and one key per payment however many times it is reported — spec 002.
- A payment reported before its order exists — spec 002.
- The order page updating itself as the purchase progresses — spec 001 §2.4 and spec 002 §2.5.

**Deliberately not part of this phase:**

- **A shopper-facing retry.** Recovery is an operator action. A shopper repeatedly retrying an empty pool would achieve nothing and would press on a supplier that is already struggling.
- **A waiting period before an order appears in the recovery list.** Every paid, undelivered order is visible immediately; nothing is hidden from the operator on a timer.
- **Telling the shopper which supplier served them, or that a backup was used.** That is the shop's business, not theirs.
- **Refunds, or notifying a shopper by email.** The shop has no way to contact a shopper outside the order page, and promising a follow-up it cannot deliver would be worse than saying nothing.
- **A designed operator screen.** The recovery list is functional, not styled; the assignment says so explicitly.
- **Real operator accounts.** The existing shared operator credential is what protects the recovery list; there are no individual logins, roles, or audit of who pressed retry.
- **Automatic retrying on a schedule.** Recovery happens when a person asks for it. A background retry loop against a failing supplier is how a small outage becomes a large one.

---

## Change Log

_Dated amendments made after the spec was first written — typically by `/awos:spec` in Update Mode when a bug fix changed documented behavior. Each entry records the date, the source reference (bug id or fix description), and what behavior changed and why. Leave empty until the first amendment._
