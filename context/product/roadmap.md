# Product Roadmap: Game Shop — Digital Goods Storefront

_This roadmap outlines our strategic direction based on customer needs and business goals. It focuses on the "what" and "why," not the technical "how."_

**Ordering note.** The phases below deliberately do **not** follow the assignment's stage numbering. The assignment lists the storefront first because it reads first, but the graded weight sits in single issuance and recovery, and those need the purchase pipeline underneath them before they can be exercised at all. So the spine is built first, hardened second, and only then dressed in the real design. Phase 1 ships a deliberately ugly page purely so there is a Купить button to click; Phase 4 replaces it with the mockup.

Two consequences worth stating up front: the mandatory stage is not fully complete until Phase 4, and the storefront is the phase most safely compressed if time runs short — it is the author's strongest area and the one the assignment relaxes ("structurally close", not pixel-perfect).

_Rough budget: 13–19 hours, with the phase estimates below summing to ~17. These assume AI-assisted implementation; done entirely by hand the same scope runs closer to 25. The assignment requires reporting actual time, so track it per phase._

---

### Phase 1

_The spine. Everything downstream exists to make this pipeline unbreakable, so it is built first — plainly, with no cleverness and no styling._

- [x] **A Catalog to Buy From** _(~1h)_
  - [x] **Seeded Product Catalog:** Load the twelve supplied products (top-ups, keys, subscriptions, gift cards) so the storefront and the purchase flow have real data to work with, priced in RUB.
  - [x] **Seeded Key Pool:** Load the fifty supplied keys as issuable inventory, with the standing guarantee that one key can never reach two orders.

- [x] **The Purchase Pipeline** _(~2h)_
  - [x] **Order Creation:** A buyer clicks Купить on a product and gets an order awaiting payment. Working flow is required for one product only; the rest of the catalog may stay static.
  - [x] **Simulated Payment:** A button or endpoint marks a payment as succeeded or failed and emits a webhook matching the supplied contract — the same mechanism later used to drive the race checks.
  - [x] **Automatic Key Issuance:** A confirmed payment causes a key to be drawn from the pool and bound to the order, without human involvement.
  - [x] **Order Status Page:** The buyer watches the order move through its lifecycle and sees the delivered key at the end. Working view only; no design.
  - [x] **Throwaway UI Shell:** The minimum page needed to click Купить and reach the status page, so the pipeline is exercisable end-to-end before the real storefront exists.

_Concepts to walk away able to explain: the order lifecycle as a state machine, and why the issuance decision belongs to the server rather than the page._

---

### Phase 2

_The key stage. The pipeline from Phase 1 works when the world is polite; this phase makes it hold when the world repeats, races and reorders itself. Acceptance criteria 1–3 are settled here._

- [ ] **Single Issuance Under Races** _(~3h)_
  - [ ] **Duplicate-Proof Ordering:** An impatient double-click on Купить produces one order and one charge, guaranteed by the server rather than by a disabled button.
  - [ ] **Replay-Proof Payment Events:** A webhook redelivered with the same `event_id` changes nothing at all — the payment provider is free to retry as often as it likes.
  - [ ] **Concurrent Webhook Safety:** Fifty simultaneous "paid" notifications for a single order produce exactly one issuance and consume exactly one key.
  - [ ] **Out-of-Order Tolerance:** A payment notification that arrives before its order exists — or otherwise out of sequence — is retained and applied correctly, never lost and never doubled.
  - [ ] **Fast Acknowledgement:** Notifications are accepted and acknowledged promptly, with failures signalled deliberately so the provider retries only when we actually want it to.

- [ ] **Proof the Reviewer Can Run** _(~1h)_
  - [ ] **Reproducible Race Scripts:** One runnable script per acceptance scenario, each asserting the invariant it defends — turning the reviewer's checklist into something they execute rather than read. Required by the assignment.

_Concepts to walk away able to explain: at-least-once delivery, idempotency keys, the durable inbox pattern, and why uniqueness enforced by the database beats a check-then-act in application code._

---

### Phase 3

_Failure and recovery. Suppliers are unreliable on purpose here, and the most valuable trap in the whole assignment lives in this phase._

- [ ] **Unreliable Suppliers, Handled** _(~2h)_
  - [ ] **Two Supplier Stubs:** A primary and a fallback, each able to fail outright or hang past a timeout at configurable rates, so every failure scenario can be reproduced on demand.
  - [ ] **Same Request, Same Code:** A repeated request carrying the same identifier returns the identical code rather than issuing a new one — the property that makes safe retrying possible at all.
  - [ ] **Ambiguous Timeouts Handled Correctly:** A timeout is treated as *unknown*, never as *failed*. The system retries the same supplier with the same request identifier to discover what actually happened, and only falls through to the backup after a definite failure. This is the difference between one key issued and two.

- [ ] **Recoverable, Not Broken** _(~1.5h)_
  - [ ] **Graceful Stock Exhaustion:** An order paid against an empty pool lands in a recoverable state instead of crashing, and the buyer is told the truth about it.
  - [ ] **Admin Recovery View:** A working list of paid-but-undelivered orders with a retry action, so a human can resolve stuck orders after restocking. No design, no real authentication.
  - [ ] **Safe Re-Issuance:** Retrying a recovered order yields exactly one key, however many times the button is pressed. Settles acceptance criterion 4.

_Concepts to walk away able to explain: why a timeout is not a failure, how to recover from a partially-completed operation, and how the fallback rule prevents double issuance._

---

### Phase 4

_The storefront. With the engine proven, the product gets the face the assignment asked for. Structurally close to the mockup; pixel-perfect explicitly not required._

- [ ] **Storefront per the Design** _(~2.5h)_
  - [ ] **Page Structure:** Header, banner, service icon row, Steam top-up block and one product row, matching the mockup's structure. Reviews, footer, mobile and dark variants are out.
  - [ ] **Banner Carousel:** Advances automatically and by arrows, with active position indicators. _(Required interaction 1)_
  - [ ] **Catalog Menu:** Opens on click, closes on a second click or a click outside. Column detail may be simplified — menu accuracy is explicitly not graded. _(Required interaction 2)_
  - [ ] **Currency Toggle:** The $/₸/₽ control changes its active state on click. No amount recalculation — the assignment waives it, and the mockup's ₽/$ mismatch stays as-is. _(Required interaction 3)_
  - [ ] **Service Icon Hover:** A smooth highlight on hover across the service row. _(Required interaction 4)_
  - [ ] **Product Card Hover:** A light lift — shadow, raise or outline, to taste. _(Required interaction 5)_

- [ ] **Connecting Face to Engine** _(~0.5h)_
  - [ ] **Buy Through to Delivery:** Купить on the real card runs the Phase 1 pipeline, and the status page carries the buyer to their key.

_Concepts to walk away able to explain: which interactions were graded and why the rest was deliberately left static._

---

### Phase 5

_A new mechanic built from scratch — the assignment's bonus stage, and a second, independent demonstration that the concurrency reasoning generalises beyond the issuance path._

- [ ] **Promo Codes with Enforced Limits** _(~1.5h)_
  - [ ] **Server-Computed Discounts:** The final price is calculated on the server from the stored promo definition; amounts supplied by the client are never trusted.
  - [ ] **Limits That Hold Under Parallelism:** A code capped at N uses is applied at most N times even when redemptions arrive simultaneously — proven against the tightest supplied codes, `LIMIT3` and `ONCEONLY`. Settles acceptance criterion 5.

_Concepts to walk away able to explain: why a read-then-increment is a race, and how a single conditional update replaces it._

---

### Phase 6

_Submission. The assignment specifies exactly what the response must contain, and deploying turns the concurrency claims into something the reviewer can verify without cloning anything._

- [ ] **Live and Reproducible** _(~1h)_
  - [ ] **Deployed to Vercel:** A live URL backed by hosted Postgres. Because serverless functions run as separate processes, passing the race scenarios against the deployed system is itself evidence that correctness lives in the database and not in one process's memory.
  - [ ] **Race Checks Against the Live System:** The Phase 2 and 5 scripts pointed at the deployed URL, closing the loop on the claim above.

- [ ] **The Written Answer** _(~1h)_
  - [ ] **README:** Startup instructions, how to reproduce the race checks, and the short explanation of how single issuance was guaranteed — all explicitly required in the response.
  - [ ] **Key Decisions and Trade-Offs:** A brief account of the choices made and what was consciously left out. Stating trade-offs reads better than implying none exist.
  - [ ] **Actual Time Spent:** Reported honestly, as the assignment requires.
