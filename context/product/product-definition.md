# Product Definition: Game Shop — Digital Goods Storefront (Test Assignment)

- **Version:** 2.0
- **Status:** Approved — written against the full assignment text

> **Sources.** The assignment document (stages, acceptance criteria, contracts, seed materials), the vacancy description, and the Figma design `HdZmqsCYuX51TxhtEba3eC` ("Home V3", frame `1:4`), inspected directly. No assumptions remain outstanding.

---

## 1. The Big Picture (The "Why")

### 1.1. Project Vision & Purpose

To build a working slice of a digital-goods game shop (the GGSel niche — keys, top-ups, subscriptions, gift cards) where **a paid order always results in exactly one issued key** — no matter how many times the payment provider retries its webhook, how many times the buyer double-clicks Купить, in what order events arrive, or whether the supplier times out mid-issuance.

The assignment states its own thesis outright: the tasks are built around **single issuance and recovery from failure**, and *"a typical tutorial shop will fail the concurrency and recovery checks."* The storefront is the visible half; the graded half is underneath it.

Two purposes run in parallel, and both must succeed:

1. **Deliver a test assignment** that wins the Fullstack vacancy.
2. **Build presentable expertise.** The assignment grades "чистоту кода и способность объяснить решения" and requires a written explanation of how single issuance was achieved. Code the author cannot defend is a failed outcome here.

**North star ⭐:** _At-least-once delivery + idempotent processing = exactly-once observable outcome._

### 1.2. Target Audience

Three audiences, in priority order:

1. **The reviewer** — runs the solution through adversarial scenarios (§1.4), reads the code, and asks the author to explain his decisions.
2. **The simulated buyer** — purchases a digital key from the storefront.
3. **The author, as learner and presenter** — needs the codebase to double as a teaching artifact.

### 1.3. User Personas

- **Persona 1: "The Reviewer"**
  - **Role:** Senior engineer at the hiring company; builds payment and supplier integrations daily.
  - **Goal:** Run five adversarial scenarios and see whether the system holds. Then judge code cleanliness and the author's explanation.
  - **Frustration:** Candidates who write `if (!order.delivered) { deliver() }` and call it idempotency; solutions that pass the happy path and collapse at 50 concurrent webhooks.
  - **What wins them over:** A reproducible race script they can run themselves, and a two-line explanation that names the actual mechanism.

- **Persona 2: "Maya the Buyer"**
  - **Role:** Gamer buying a game key.
  - **Goal:** Click Купить, pay, and get a working key within seconds.
  - **Frustration:** Impatient — double-clicks Купить when nothing happens fast enough. She is the *source* of duplicate requests, not an edge case.

- **Persona 3: "Alexander the Candidate"**
  - **Role:** The author. Strong frontend; deliberately building depth in backend distributed-systems concerns.
  - **Goal:** Ship the assignment *and* leave able to explain idempotency, ambiguous timeouts, durable inboxes and row-level locking under questioning.
  - **Frustration:** Generated code he cannot defend. Needs the *why* at every non-obvious decision.

### 1.4. Success Metrics

**The five adversarial scenarios are the definition of success.** The assignment states the solution is considered reliable if:

1. **50 parallel `paid` webhooks** for one order → exactly one issuance fact, exactly one key consumed.
2. **A repeated webhook with the same `event_id`** changes nothing.
3. **A webhook arriving before order creation, or out of order,** is handled correctly — no loss, no duplicate.
4. **An empty key pool** leaves the order in a recoverable state without crashing; after restocking, re-issuance yields exactly one key.
5. **A promo code with limit N** under parallel requests is applied at most N times (stage 4).

Supporting metrics:

- **Explainability:** the author can state each invariant, name the mechanism enforcing it, and describe the failure that occurs without it — unaided.
- **Every acceptance criterion maps to a named, runnable script.** The assignment requires a way to reproduce the race check; the criteria list becomes the test suite.
- **Structural fidelity to the mockup** with all five required interactions working.
- **Honest reporting**, including the actual hours spent — the assignment asks for it explicitly, so time is tracked from the start.

---

## 2. The Product Experience (The "What")

### 2.1. Core Features

Ordered by grading weight, which is deliberately **not** the order the storefront suggests:

1. **Purchase pipeline** — `product → order → simulated payment → webhook → issuance → delivered key`, over the mandated lifecycle: `created → paid → delivering → delivered`, with failure branches `payment_failed`, `out_of_stock`, `delivery_failed`.
2. **Single issuance under races** — the key stage. One key never reaches two orders; a double-click, a replayed webhook, and two simultaneous webhooks for one order all yield exactly one issuance.
3. **Durable webhook intake** — events are persisted and acknowledged with a fast `200 OK`, then processed separately. A webhook that arrives *before* its order is held and applied later. `5xx` means the provider will retry, so failures must be deliberate, not accidental.
4. **Supplier issuance with the timeout trap** — two supplier stubs (A primary, B fallback), each able to fail with `5xx` or hang past a timeout, with configurable rates. The contract's central rule: **a repeat with the same `request_id` must return the same code.** Therefore *timeout ≠ failure* — the supplier may have issued a code whose response was lost, so a retry must reuse the `request_id` rather than fall through to B.
5. **Recovery from failure** — `out_of_stock` and `delivery_failed` are recoverable, not crashes. An admin list of "paid but not delivered" orders offers safe, idempotent manual re-issuance after restocking. No design required.
6. **Storefront slice** — the upper page per §2.3, with five mandatory interactions.
7. **Promo codes with a hard usage limit** (stage 4) — four seeded codes including `LIMIT3` (max 3) and `ONCEONLY` (max 1). The server computes the discount; client-supplied amounts are never trusted.
8. **The written explanation** — README with run instructions, race reproduction, and a short account of how single issuance was guaranteed. A required deliverable, not documentation overhead.

### 2.2. User Journey

**The buyer's journey:**
Maya lands on the storefront, opens the Каталог menu and closes it again, watches the banner carousel advance, hovers the service icons and product cards, and clicks the currency toggle. She clicks Купить on a product card and lands on an order status page: *Waiting for payment*, with buttons to simulate a successful or failed payment. She impatiently clicked Купить twice — she still has one order. On success the page moves through *Processing…* to *Delivered*, showing her key. If the pool is empty she sees a recoverable state, not an error page — and once the admin restocks and retries, she gets exactly one key.

**The reviewer's journey:**
The reviewer follows the README to start the system, opens the storefront and exercises the five interactions, then runs the race scripts: 50 parallel webhooks, a replayed `event_id`, a webhook before its order, an exhausted pool followed by restock, and concurrent promo redemption. Each asserts the invariant it defends. They then read the code and the explanation of single issuance, and question the author on it.

### 2.3. Storefront Scope (from the design + assignment)

The assignment relaxes fidelity: *"structurally close to the mockup"*, not pixel-perfect, and content may be static.

**In the build:**

- **Header** — Каталог button, search field, favourites and profile icons.
- **Catalog menu** — open/close only. Clicking Каталог opens it; a second click or a click outside closes it. **Column detail may be simplified — menu accuracy is explicitly not graded.**
- **Banner carousel** — advances automatically and/or by arrows, with active dot indicators.
- **Services strip** — service icons (Steam, Telegram, Roblox, …) with a smooth hover highlight.
- **Steam top-up block** — laid out per the mockup. The **$/₸/₽ toggle is clickable and changes active state only — no amount recalculation.** The Steam login field is decorative. The ₽/$ mismatch visible in the mockup is intentional and stays.
- **One product row** — cards with a hover lift (shadow/outline, author's choice). Купить starts the purchase flow.

**Not in the build:** reviews, footer, mobile and dark variants, the remaining product rows. The order status page and admin panel need working views only, no design.

---

## 3. Project Boundaries

### 3.1. What's In-Scope for this Version

- Storefront upper section per §2.3, with all five mandated interactions.
- Catalog seeded from the supplied 12 SKUs (top-ups, keys, subscriptions, gift cards).
- **A working purchase flow for one product** — the assignment permits this explicitly; the remaining cards may be static.
- Order creation safe against duplicate and concurrent submission.
- Payment simulation endpoint/button (success and failure) that emits a webhook per the supplied contract.
- Webhook endpoint: durable, fast-acknowledging, idempotent on `event_id`, tolerant of out-of-order arrival.
- Two supplier stubs per the `/issue` contract, with configurable failure and timeout rates, and same-`request_id` → same-code behaviour.
- Key pool of 50 supplied keys, with a key never issued twice.
- The seven mandated order statuses and their transitions, idempotent against replays.
- Recoverable `out_of_stock` / `delivery_failed` states with safe manual re-issuance.
- Admin list of paid-but-undelivered orders with a retry action — no auth or a simple token.
- Order status page reflecting live progression to the delivered key.
- Promo codes (stage 4) from the four supplied codes, server-computed discount, limit-safe under concurrency.
- Reproducible race scripts covering all five acceptance criteria.
- README: startup instructions, race reproduction, explanation of single issuance, actual time spent.
- **Deployment to Vercel** — a live URL the reviewer can open without cloning anything, with a hosted Postgres behind it. Local startup via README stays supported as the fallback path and for running the race scripts.

### 3.2. What's Out-of-Scope (Non-Goals)

- **Real acquiring.** Webhook stub only; no real money movement, no signature or secret verification — the assignment waives it.
- **Real suppliers.** Both are stubs we write, so their failure modes can be triggered on demand.
- **Authentication.** None, or at most a simple token for the admin panel.
- **Currency conversion.** The toggle switches active state only; recalculation is explicitly not required.
- **Steam login handling.** The field is decorative.
- **A working search field.** Rendered, not wired.
- **The lower page.** Reviews, footer, the second and third product rows.
- **Mobile and dark variants; pixel-perfect fidelity.**
- **Design work on the status page and admin panel.** Working views suffice.
- **Cart and multi-item checkout.** Purchase starts from Купить on a single card.
- **Catalog at scale.** No filtering, faceting, pagination or performance work.
- **Promo anywhere before stage 4.** The "Ввести промокод" control in the mockup is decoration until then.
- **CI/CD, monitoring, alerting.**
- **Real-time transport.** Status is polled; WebSockets would be decoration.
- **Heavy frontend frameworks.** Plain HTML/CSS/JS is the stated preference.

### 3.3. Optional, If Time Allows

- **Background retry** of recoverable orders, in addition to manual admin retry.

### 3.4. Note on Deploying to Vercel

Deployment is in scope, and it does more than satisfy deliverable 1 — it *strengthens* the central claim. On Vercel the API runs as serverless functions, so concurrent requests land in **separate processes**. Any correctness that depended on an in-process mutex or a single Node.js instance would break there. Passing the 50-parallel-webhook scenario against the deployed URL is therefore direct evidence that the guarantees live in Postgres — unique constraints, row locks, atomic updates — and not in application memory. That is a sentence worth having in the README.

Two constraints this imposes, to be resolved in `/awos:architecture`:

- **Hosted Postgres** is required (Neon, Supabase, or Vercel Postgres); serverless functions need a connection method that tolerates many short-lived connections.
- **Serverless execution limits** cap how long a function may run. The supplier stub's deliberate "hang" must stay below that ceiling, so timeout values are configuration, not constants.

---

## 4. Required Deliverables

The assignment specifies exactly what the response must contain. These are product requirements, not process notes:

1. A live link **or** a README with startup instructions — we deliver **both**: a Vercel URL plus local run instructions.
2. Sources — a GitHub repository or an archive.
3. How to reproduce the race check.
4. A couple of lines on how single issuance was guaranteed.
5. **The actual time spent** — so tracking starts now.

Plus, from the brief: *"In your response, briefly explain the key decisions."*
