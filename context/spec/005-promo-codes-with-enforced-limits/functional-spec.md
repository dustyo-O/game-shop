# Functional Specification: Promo Codes with Enforced Limits

- **Roadmap Item:** Phase 5 — Promo Codes with Enforced Limits
- **Status:** Completed
- **Author:** Alexander Shleyko

---

## 1. Overview and Rationale (The "Why")

The shop can now be trusted to sell one key per payment, however the world misbehaves. The assignment's last stage asks it to prove that the same care extends to a mechanic that has nothing to do with keys: a promo code with a hard limit on how many times it may be used.

The brief supplies four codes and one sentence about them: *the limit must hold even under parallel requests, and the server computes the discount.* Both halves are traps a typical shop falls into. A shop that lets the page say what the discounted price is will sell a 3 490 ₽ key for 1 ₽ to anyone who edits a number. A shop that checks "has this code been used fewer than three times?" and then records a use will let ten simultaneous shoppers all pass the check and all record a use — a code capped at three used ten times, with every individual request looking correct. The five adversarial scenarios the assignment grades end with exactly this one: *a promo code with limit N under parallel requests is applied at most N times.*

This phase adds the code to the purchase the shopper already makes. On the order page, before paying, they may enter a code; the shop tells them what it is worth and what they now owe; the payment is for that amount; and a code that has reached its limit is refused — for the next shopper and for the tenth simultaneous one alike.

**Success looks like:** a shopper enters `LIMIT3` on an order and pays a quarter less; the fourth shopper to try it is told the code is exhausted; a reviewer fires twenty redemptions of `LIMIT3` at the shop in the same instant and finds exactly three applied and seventeen refused, with the counter reading three; and nothing a shopper types into the page can change a price by anything other than a valid code.

---

## 2. Functional Requirements (The "What")

### 2.1 The four codes

The shop honours exactly the four codes the assignment supplies, and no others:

| Code | What it gives | How many times it may be used, in total, across all shoppers |
| --- | --- | --- |
| `WELCOME10` | 10 % off the order | 100 |
| `GG500` | 500 ₽ off the order | 20 |
| `LIMIT3` | 25 % off the order | 3 |
| `ONCEONLY` | 50 % off the order | 1 |

A code is matched regardless of letter case: `limit3` and `Limit3` are `LIMIT3`. Spaces before or after a code are ignored.

- **As the** shop owner, **I want** the codes from the brief to work exactly as written, **so that** a reviewer can try each one and see the advertised effect.
  - **Acceptance Criteria:**
    - [ ] Given an order for 1 290 ₽ awaiting payment, when the shopper applies `WELCOME10`, then the amount to pay becomes 1 161 ₽.
    - [ ] Given an order for 1 290 ₽ awaiting payment, when the shopper applies `GG500`, then the amount to pay becomes 790 ₽.
    - [ ] Given an order for 1 290 ₽ awaiting payment, when the shopper applies `LIMIT3`, then the amount to pay becomes 967,50 ₽.
    - [ ] Given an order for 1 290 ₽ awaiting payment, when the shopper applies `ONCEONLY`, then the amount to pay becomes 645 ₽.
    - [ ] When the shopper types a code in lower case or with spaces around it, then it is treated as the same code.
    - [ ] When the shopper applies a code that is not one of the four, then they see «Такого промокода нет» and the amount to pay does not change.

### 2.2 Entering a code on the order page

A code is entered on the order page, and only while the order is waiting for payment. The storefront's «Ввести промокод» control in the Steam top-up block stays as it was — a drawn control that does nothing — because it belongs to a block that is not a purchase.

- **As a** shopper, **I want to** enter a promo code before I pay, **so that** I pay the discounted amount.
  - **Acceptance Criteria:**
    - [ ] Given an order that is waiting for payment, when the shopper opens its page, then they see a field for a promo code and a button «Применить» above the payment controls.
    - [ ] When the shopper applies a valid code, then the page shows the code as applied, the size of the discount, the original amount, and the new amount to pay — for example «Промокод LIMIT3: −322,50 ₽», «Сумма: 967,50 ₽».
    - [ ] Given a code has been applied to an order, when the shopper looks at the page, then the entry field is gone and the applied code is shown in its place — one code per order, and it cannot be removed or replaced.
    - [ ] Given a code has been applied, when the shopper reloads the page or returns to it later, then the same code and the same amounts are shown.
    - [ ] When the shopper presses «Применить» with an empty field, then nothing is applied and the field simply stays as it is.
    - [ ] Given an order has been paid, or has failed, or is being delivered, when the shopper opens its page, then there is no promo-code field.
    - [ ] When the shopper applies a valid code, then the amount to pay changes without the page being reloaded.

### 2.3 The shop decides the price

Nothing the shopper types, other than a valid code, changes what they owe. The discounted amount is worked out by the shop from the code's definition and the order's original price; the page only displays it.

- **As the** shop owner, **I want** the discounted price to be the shop's decision, **so that** no shopper can pay less by editing what the page sends.
  - **Acceptance Criteria:**
    - [ ] When a code is applied, then the amount to pay equals the original amount less the code's discount, calculated to the kopeck, and never anything the shopper supplied.
    - [ ] Given a fixed-sum code larger than the order's price, when it is applied, then the amount to pay is 0 ₽, never a negative amount.
    - [ ] Given a code has been applied, when the shopper pays, then the payment is for the discounted amount, and the paid order shows that amount.
    - [ ] Given an order is delivered, when the shopper looks at it, then the discounted amount and the code are still shown — the record of what was paid does not change after the fact.

### 2.4 A limit that holds

Each code may be used at most the number of times in its definition, counted across every shopper and every order. A use is counted when a code is applied to an order, whether or not that order is later paid. Once the count is reached, the code is refused to everyone.

- **As the** shop owner, **I want** a code capped at N to be applied at most N times, **so that** a promotion costs what it was meant to cost.
  - **Acceptance Criteria:**
    - [ ] Given `LIMIT3` has been applied to three orders, when a shopper applies it to a fourth, then they see «Промокод больше не действует» and the amount to pay does not change.
    - [ ] Given `ONCEONLY` has been applied once, when any shopper applies it again, then they see «Промокод больше не действует».
    - [ ] Given many shoppers apply `LIMIT3` to their own orders at the same moment, when the shop has finished, then exactly three of those orders carry the code and the rest are refused — never a fourth.
    - [ ] Given many shoppers apply `ONCEONLY` at the same moment, when the shop has finished, then exactly one order carries it.
    - [ ] When the shopper presses «Применить» twice quickly for the same code on the same order, then the code is applied once, the order counts as one use, and the amount is discounted once.
    - [ ] Given a code was applied to an order that was then never paid, when the count is read, then that order's use still counts — an abandoned order does not return a use.

### 2.5 Checking the promise rather than trusting it

- **As a** reviewer, **I want to** run the shop's own check for the promo limit, **so that** I can see the fifth adversarial scenario hold instead of taking the shop's word for it.
  - **Acceptance Criteria:**
    - [ ] Given the shop is running, when the reviewer runs the shop's checks with a single command, then a named check for promo limits runs alongside the existing ones.
    - [ ] When the promo check runs, then it fires many simultaneous redemptions of `LIMIT3` and of `ONCEONLY` from several places at once and reports exactly three and exactly one applied.
    - [ ] Given the check has passed, when the mechanism it defends is deliberately weakened, then the check reports a failure.
    - [ ] When the reviewer runs the check twice in a row, then the second run behaves the same as the first, with no manual tidying up in between.

### 2.6 Understanding what was built

The roadmap names the concept this phase must leave the author able to explain: *why a read-then-increment is a race, and how a single conditional update replaces it.*

- **As the** author preparing to present this work, **I want** a written walkthrough of the decisions that carry this phase, **so that** I can explain them unaided when questioned.
  - **Acceptance Criteria:**
    - [ ] When this phase is finished, then a written walkthrough accompanies it that explains, in plain language, why checking a code's count and then recording a use lets a limit be exceeded, and what replaces it so that it cannot.
    - [ ] When the author reads the walkthrough, then it states how the shop keeps the price its own decision, and what goes wrong in a shop that does not.
    - [ ] When someone who has never seen the source reads the walkthrough, then they can follow every entry without opening the code.

### 2.7 Language of shopper-facing text

- **As a** shopper in the shop's market, **I want** everything I read to be in Russian, **so that** the shop reads as a real shop rather than a demonstration.
  - **Acceptance Criteria:**
    - [ ] When the shopper reads any text this phase adds — the field, the button, the applied-code line, the three messages — then it is in Russian, as established in spec 001 §2.8; the codes themselves are shown exactly as the brief writes them.

---

## 3. Scope and Boundaries

### In-Scope

- The four supplied codes, with their effects and limits, exactly as the brief defines them.
- Entering a code on the order page while the order awaits payment; one code per order; the discount and the new amount shown and kept.
- The discounted amount decided by the shop, paid at payment, and shown on the order afterwards.
- A limit that holds under simultaneous use, with a plain refusal once reached.
- A named reviewer's check for the limit, alongside the existing checks.
- A written walkthrough of the phase's keystone decision.

### Out-of-Scope

**Deferred to later roadmap phases** (added automatically, as these are separate roadmap items):

- Publishing the shop to a public address, the root README and the time report — Phase 6.

**Already delivered, and not revisited here:**

- Everything about creating, paying for, issuing and recovering an order — specs 001–003. A discounted order goes through the same path with a smaller amount.
- The storefront and its five interactions — spec 004. The «Ввести промокод» control in the Steam top-up block stays decorative.

**Deliberately not part of this phase:**

- **Entering a code anywhere but the order page.** The storefront card and the Steam block have no order to apply a code to.
- **Removing or replacing an applied code.** One code per order, applied once, kept.
- **Returning a use when an order is abandoned.** A use is spent when the code is applied.
- **Expiry dates, per-shopper limits, minimum order amounts, combining codes.** The brief defines none of these; the four codes have a discount and a total limit and nothing else.
- **Creating or editing codes, or an operator view of their use.** The four codes are fixed.
- **A discount on the storefront's shown prices.** Cards show the catalogue price; the discount appears on the order.

---

## Change Log

_Dated amendments made after the spec was first written — typically by `/awos:spec` in Update Mode when a bug fix changed documented behavior. Each entry records the date, the source reference (bug id or fix description), and what behavior changed and why. Leave empty until the first amendment._
