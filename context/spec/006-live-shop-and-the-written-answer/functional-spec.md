# Functional Specification: Live Shop and the Written Answer

- **Roadmap Item:** Phase 6 — Live and Reproducible; The Written Answer
- **Status:** Completed
- **Author:** Alexander Shleyko

---

## 1. Overview and Rationale (The "Why")

Five phases built a shop that sells one key per payment however the world misbehaves, proves it with checks a reviewer can run, wears the assignment's design, and honours a promo code's limit under parallel use. None of that has yet been handed to anyone. The assignment is explicit about what the response must contain: a live link or startup instructions (we deliver both), the sources, how to reproduce the race check, a couple of lines on how single issuance was guaranteed, the key decisions, and the actual time spent. This phase is that response.

Putting the shop on a public address does more than satisfy the first item. On the hosting chosen, every request the shop receives is handled in its own separate process — there is no shared memory between two shoppers' requests, ever. So when the reviewer fires fifty simultaneous payment reports at one order on the live address and exactly one key comes out, that result cannot be explained by a lock inside one running program; it can only be explained by the database. The live shop turns the central claim of the whole assignment into something the reviewer can verify from their own machine, without cloning or installing anything.

The written answer is the other half. A reviewer who has never seen this repository should be able to open one file, start the shop on their own machine, run the checks locally and against the live address, and read — in a couple of lines, then in as much depth as they want — why single issuance holds, what was decided, what was consciously left out, and how long it took.

**Success looks like:** a reviewer opens the link, buys a key with the demo payment buttons, runs one command against the live address and watches all five adversarial scenarios pass, follows the README to a running shop on their own machine in a few minutes, and finds in it the reasons, the trade-offs, and an honest number of hours.

---

## 2. Functional Requirements (The "What")

### 2.1 The shop is live at one public address

The whole shop — the storefront, the order page, the operator's view, and the demo payment — is reachable at one public web address, with the shop's data kept by a hosted database. Nothing about how the shop behaves changes between running locally and running at that address.

- **As a** reviewer, **I want to** open the shop in my browser from a link, **so that** I can see it work without cloning or installing anything.
  - **Acceptance Criteria:**
    - [x] When the reviewer opens the live address, then the storefront appears with its five interactions working exactly as they do locally.
    - [x] When the reviewer presses «Купить» on a product card at the live address, then they land on that order's page at the same address, showing the product, the amount, and «Ожидает оплаты».
    - [x] Given an order awaiting payment on the live shop, when the reviewer presses «Оплатить успешно», then within 15 seconds the page shows «Ключ выдан» and a key.
    - [x] Given an order awaiting payment on the live shop, when the reviewer applies `LIMIT3`, then the amount to pay becomes a quarter less, exactly as it does locally.
    - [x] Given the operator's demo token from the README, when the reviewer opens the operator's view at the live address, then the list of paid-but-undelivered orders and the retry action work as they do locally.
    - [x] When the reviewer returns to the live address the next day, then the same orders and keys are still there — the shop's memory is the hosted database, not the process that served the last request.

### 2.2 The checks run against the live shop, and the result is on record

The shop's own adversarial checks accept the live address as their target. Pointed at it, they need nothing running locally; each check reports its verdict from the shop's responses alone and says plainly which assertions it could not make because it has no access to the live database. The author's own run against the live address is recorded in the README, output included, so the claim "correctness lives in the database" comes with its evidence attached.

- **As a** reviewer, **I want to** run the shop's checks against the live address with one command, **so that** I can see the five scenarios hold on a system where no two requests share a process.
  - **Acceptance Criteria:**
    - [x] Given the reviewer has the repository and the live address, when they run the checks with the address as the target, then every check runs, reports pass or fail, and the run ends with a one-line summary of how many passed.
    - [x] When a check cannot verify something because it has no access to the live database, then it says so by name in its output rather than passing silently or failing.
    - [x] When the reviewer runs the checks against the live address twice in a row, then the second run reports the same verdicts as the first, with no manual tidying in between.
    - [x] When the reviewer reads the README, then they find the author's own run of the checks against the live address — the command, the date, and the output — and the sentence explaining why passing there is evidence that the guarantees do not depend on a single running process.

### 2.3 The demo can be reset

The live shop starts with a fixed supply of keys, and every purchase and every check run consumes some of it, spends promo uses, and leaves test orders behind. One operator action returns the live shop to its starting state: keys back in stock, promo counters at zero, orders from checks and demos removed. The README names it; a reviewer never has to meet an empty shop by accident.

- **As the** operator of the demo, **I want** one action that restores the live shop to its starting state, **so that** every reviewer, and every repeated check run, starts from the same shop.
  - **Acceptance Criteria:**
    - [x] Given the live shop has sold keys, spent promo uses, and holds test orders, when the operator performs the reset action named in the README, then the storefront shows the full catalogue, all keys are back in stock, every promo code can be used its full number of times again, and the test orders are gone.
    - [x] When the operator performs the reset action twice in a row, then the second run changes nothing and reports that.
    - [x] When a shopper or reviewer without the operator's token attempts the reset, then it is refused and the shop is unchanged.
    - [x] When the reset has run, then the checks pointed at the live address pass in full again — including the out-of-stock recovery scenario, which needs keys to be available.

### 2.4 The written answer

A single README at the root of the repository, written in Russian, is the response to the assignment. A reviewer who has never seen the repository reads it first and needs nothing else to start.

It contains, in this order or close to it:

1. The live address and the repository address.
2. How to start the shop on their own machine, from a clean clone: what to have installed, the commands to run, and what they should see when it works.
3. How to reproduce the race checks — locally and against the live address — and what each check proves; the author's recorded run against the live address.
4. How single issuance was guaranteed, in a couple of lines a reviewer can quote, with a pointer to the longer explanation.
5. The key decisions and the trade-offs: what was chosen, what it cost, and what was consciously left out.
6. Two maps: the five adversarial scenarios from the assignment, each with the check that proves it and the automated test that guards it; and the storefront's five required interactions, each with the browser test that guards it.
7. The actual time spent (§2.5).
8. Where the deeper explanations live — the walkthroughs — for a reviewer who wants them.

- **As a** reviewer, **I want** one document that answers the assignment's questions in the order the assignment asks them, **so that** I can evaluate the submission without hunting.
  - **Acceptance Criteria:**
    - [x] When a reviewer with a clean machine follows the README's local startup section step by step, then they reach a working shop in their browser without needing any instruction the README does not give.
    - [x] When the reviewer follows the README's "reproduce the race checks" section locally, then all nine checks run and pass on their machine with the commands as written.
    - [x] When the reviewer reads the single-issuance explanation, then it is at most a short paragraph, names the mechanism in plain words, and links to the fuller account.
    - [x] When the reviewer looks for any of the assignment's five required items — live link or startup, sources, race reproduction, single-issuance explanation, time spent — then each has its own heading in the README.
    - [x] When the reviewer reads the decisions section, then every decision is paired with what it cost or what it excluded — no decision is presented as free.
    - [x] When the reviewer reads the two maps, then every one of the five scenarios and every one of the five interactions points at something they can run by name.
    - [x] When the reviewer reads the README, then everything in it is in Russian, except commands, addresses, file names, and the codes and messages quoted exactly as the shop shows them.
    - [x] When the reviewer opens any address or file the README refers to, then it exists.

### 2.5 Actual time spent, honestly

The assignment asks for the actual time spent. The figure is derived from the repository's history and the author's working sessions, laid out per phase with a total, confirmed by the author before it is published, and stated together with what it does and does not include.

- **As the** author, **I want** the reported time to be reconstructed from evidence and confirmed by me, **so that** the number in the README is honest rather than remembered.
  - **Acceptance Criteria:**
    - [x] When the time figure is first produced, then it is presented to the author as a per-phase table with the sources it was derived from, and nothing is published until the author confirms or corrects it.
    - [x] When the reviewer reads the time section, then they see a per-phase breakdown, a total, and one sentence on how it was measured and what it excludes.
    - [x] When the roadmap's original estimates are compared to the reported figures, then the README shows both side by side rather than only the estimate.

### 2.6 Sources published

The repository is published publicly. The README's repository link resolves; the published repository contains no real secrets — the operator's demo token is the one exception, published on purpose and labelled as a demo affordance.

- **As a** reviewer, **I want** the sources at a public address, **so that** I can read and run them without asking for access.
  - **Acceptance Criteria:**
    - [x] When the reviewer opens the repository address from the README, then the repository opens without signing in and its README is the same document.
    - [x] When the reviewer clones the repository and follows the README, then nothing is missing that the README relies on — no file that exists only on the author's machine.
    - [x] When the repository is searched for credentials, then the only token in it is the demo operator token, and the README says why it is there.

### 2.7 Understanding what was deployed

- **As the** author preparing to present this work, **I want** a written walkthrough of what it took to put the shop on a public address and what the live run showed, **so that** I can explain it unaided when questioned.
  - **Acceptance Criteria:**
    - [x] When this phase is finished, then a written walkthrough accompanies it that explains, in plain language, why running each request in a separate process strengthens the single-issuance claim, what had to change for the shop to run that way, and what the recorded live run showed.
    - [x] When someone who has never seen the source reads the walkthrough, then they can follow every entry without opening the code.

---

## 3. Scope and Boundaries

### In-Scope

- The shop live at one public address with a hosted database; the same behaviour as locally.
- The checks runnable against the live address; the author's run recorded in the README.
- One operator reset action for the live demo, named in the README.
- The README in Russian, with the eight parts in §2.4, including the two maps.
- The time report, reconstructed from evidence and confirmed by the author.
- The sources published as a public repository.
- A written walkthrough of the deployment.

### Out-of-Scope

**Already delivered, and not revisited here:**

- Everything about how the shop behaves — specs 001–005. This phase changes where the shop runs and how it is described, not what it does. Any behaviour found wrong during deployment is a bug against its own spec, not a change here.

**Deliberately not part of this phase:**

- **A custom domain, analytics, monitoring, alerting, or uptime guarantees.** The live shop is a demonstration for review, not a service.
- **A scheduled safety net on the hosting.** The shop's own recovery paths already exist; a scheduled run on the hosting's free tier would fire too rarely to be one, and this is recorded as a trade-off rather than built.
- **Production-grade security for the payment report endpoint.** The assignment waived signature verification; the README lists it among the trade-offs.
- **Hiding the demo operator token.** It is published on purpose so the reviewer can use the operator's view and run the recovery checks against the live shop.
- **Restocking the live shop automatically.** The reset is an operator action; the reviewer is not expected to trigger it.
- **A written answer in English.** The README is in Russian; the walkthroughs and code stay in English as they are.
- **Continuous integration or automatic deployment on every push.** Deploying is a manual step described in the walkthrough.

---

## Change Log

_Dated amendments made after the spec was first written — typically by `/awos:spec` in Update Mode when a bug fix changed documented behavior. Each entry records the date, the source reference (bug id or fix description), and what behavior changed and why. Leave empty until the first amendment._
