# Tasks: Single Issuance Under Races

Spec: `context/spec/002-single-issuance-under-races/`
Slices are vertical — after each one the application starts and does something new that can be seen or tested.

No migration is needed anywhere in this phase: every constraint it uses already shipped in `0000_init.sql`.

---

- [ ] **Slice 1: A double-click produces one order**

  > The gap Phase 1 measured and left open. Closes §2.1 and the assignment's first adversarial scenario.

  - [ ] Accept an `Idempotency-Key` header on `POST /api/orders` and store it as `client_request_id` (today it is written as an explicit `null`). Use `INSERT … ON CONFLICT (client_request_id) DO NOTHING RETURNING *` so the unique index decides the winner, and read the winner back on zero rows. Respond `201` when this call created the order and `200` when it found one, so a caller can tell its own retry from a fresh creation. **Zero rows has two causes** — key already used, or SKU not purchasable — and they must be distinguished before responding, or a legitimate retry gets `422` and a bad SKU gets someone else's order. Annotate with the emitted SQL and what zero rows means. **[Agent: nestjs-backend]**
  - [ ] Mint the idempotency key per **purchase intent**, not per click: created lazily on first need for a product, stored in `localStorage` keyed by SKU, cleared once an order for it has been created and the shopper has navigated away. A key minted inside the click handler makes a double-click produce two keys and two orders — the mechanism would do nothing while every `curl` test that sends one key twice still passes. **[Agent: vanilla-ts-frontend]**
  - [ ] Verify: in a real browser, genuinely double-click Купить and confirm one order exists; open the same purchase in two tabs and confirm one order; complete a purchase then start a fresh one and confirm a second, separate order with its own key. Confirm the repeated attempt shows the order silently, with no notice about the repeat. Assert against the database, not only the responses. Then delete any screenshots or recordings produced during the check. **[Agent: testing-expert]**
  - [ ] Explain to the user how this concrete feature works and what its role is among the key points of the test task in particular — here: why an idempotency key names the shopper's *intent* rather than the request's content, and why minting it in the wrong place produces a mechanism that passes its tests and protects nothing. **[Agent: nestjs-backend]**

- [ ] **Slice 2: The shop answers before it finishes the work**

  > Moves processing off the acknowledgement path. The change with the most reach in this phase — it is what later makes out-of-order handling real and the stages observable.

  - [ ] Add a scheduler for work that outlives a response: one interface, two implementations. Locally it tracks in-flight work and is awaited by `onModuleDestroy`, so a `SIGTERM` does not abandon a half-processed event; in deployment it delegates to `waitUntil`. A bare floating promise is not acceptable — it is lost on shutdown with no trace. **[Agent: nestjs-backend]**
  - [ ] Change the webhook to persist the event, answer `200`, and schedule processing rather than awaiting it (`payment-webhook.controller.ts:256` today). Preserve the existing status-code rule exactly: `5xx` only when the event could not be written; everything the shop accepted, including duplicates and events for orders that do not exist, still answers `200`. **[Agent: nestjs-backend]**
  - [ ] Implement the drain that claims pending work with `SELECT … WHERE processed_at IS NULL … ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1` inside a transaction, processes the claimed event through the existing processor, and settles it. Keep apply-then-settle ordering and the `AND processed_at IS NULL` guard on the settle — both already exist and are the reason a crash between the two writes is harmless. Annotate with the emitted SQL and what zero rows means. **[Agent: nestjs-backend]**
  - [ ] Update the Phase 1 acceptance tests, which assert `delivered` immediately after simulating a payment (seven occurrences) and will now read `paid` or `delivering`. Change them to poll for a settled state with a bounded timeout. **Do not weaken an assertion to make it pass** — a test that stops checking delivery is worse than a failing one. **[Agent: testing-expert]**
  - [ ] Verify: the webhook's response returns before the order settles — established by timing the response against the order's settle time, not by inspecting internals. Confirm a failure while completing an already-accepted event still answers `2xx`, and that `pnpm test` passes with the polling adjustment. Then delete any temporary scripts produced during the check. **[Agent: testing-expert]**
  - [ ] Explain to the user how this concrete feature works and what its role is among the key points of the test task in particular — here: why "received" and "finished" must be different answers when the other party retries on `5xx`, and what the scheduler guarantees that a floating promise does not. **[Agent: nestjs-backend]**

- [ ] **Slice 3: A payment reported before its order still delivers**

  > Completes §2.3 and the assignment's third adversarial scenario. Phase 1 stored such an event correctly; nothing applied it.

  - [ ] Drain that order's pending events when an order is created, so an event that arrived first is applied the moment its order exists. **[Agent: nestjs-backend]**
  - [ ] Drain that order's pending events on the order status read, so a shopper's own page nudges their order forward. Keep it one extra statement on the polled path, not a fan-out. **[Agent: nestjs-backend]**
  - [ ] Add an admin sweep endpoint that drains everything still pending, behind the shared bearer token. This is the backstop for whatever the other three triggers missed, and the reason no single trigger is load-bearing. **[Agent: nestjs-backend]**
  - [ ] Verify: deliver a payment report for an order id that does not exist yet, confirm it is stored pending and answered `200`; then create that order and confirm the key arrives with no further action. Separately, confirm the losing events Phase 1 left pending are now settled by a drain rather than accumulating. Assert against the database. Then delete any temporary scripts produced during the check. **[Agent: testing-expert]**
  - [ ] Explain to the user how this concrete feature works and what its role is among the key points of the test task in particular — here: why the missing foreign key from Phase 1 is what made this possible, and why four triggers exist rather than one. **[Agent: nestjs-backend]**

- [ ] **Slice 4: The shopper watches the stages**

  > Restores the promise spec 001 §2.4 had to walk back. The mechanism was always correct; the stages were simply too brief to see.

  - [ ] Confirm the order page shows intermediate states now that they persist, and adjust the polling only if the change surfaces something the page handles poorly. The poll, the change detection and the Russian labels for every status already exist — this task is expected to be small, and adding machinery would be a sign of misreading it. **[Agent: vanilla-ts-frontend]**
  - [ ] Amend spec 001 §2.4's second criterion back to its original wording now that it holds again, with a dated Change Log entry recording that Phase 2's asynchronous processing restored it. **[Agent: general-purpose]**
  - [ ] Verify: in a real browser, pay for an order and observe an intermediate state between paying and delivered without reloading, capturing the observed sequence of status labels. Then delete any screenshots or recordings produced during the check. **[Agent: testing-expert]**
  - [ ] Explain to the user how this concrete feature works and what its role is among the key points of the test task in particular — here: how a correctness change made a user-visible promise true again, and why the spec was reworded rather than left overpromising in the meantime. **[Agent: vanilla-ts-frontend]**

- [ ] **Slice 5: Only one worker advances an order**

  > Invariant I4's missing half. Phase 1 had a single entry point into issuance; the drain is the second worker, so the lock arrives with it.

  - [ ] Add `SELECT … FOR UPDATE` on the order row around the short transactions that bracket the supplier call. The lock must **not** span the HTTP call: the pool is one connection per instance, so holding a transaction across a network call stalls the whole instance. The `delivering` claim remains the exclusion for the call itself. Annotate with the emitted SQL. **[Agent: nestjs-backend]**
  - [ ] Verify: drive a continuation and a drain at the same order simultaneously across more than one process and confirm exactly one delivery row, one key claimed, and no double issuance. A single instance would serialise at its connection pool and prove nothing. Then delete any temporary scripts produced during the check. **[Agent: testing-expert]**
  - [ ] Explain to the user how this concrete feature works and what its role is among the key points of the test task in particular — here: the difference between making a transition idempotent and serialising workers across a multi-statement job, and why the lock cannot simply wrap the whole span. **[Agent: nestjs-backend]**

- [ ] **Slice 6: The reviewer runs the adversarial checks**

  > The artefact the assignment names — «как воспроизвести проверку гонок». Settles §2.6 and turns scenarios 1–3 into something executed rather than read.

  - [ ] Provide the multi-instance harness the scripts run against: `RACE_BASE_URLS` as a comma-separated list the scripts round-robin across, an npm script that starts the local instances and stops them afterwards, and a single URL accepted for a deployed target where the platform supplies the separate instances. Reuse `apps/api/test/concurrency/support/` rather than building a second way to start API processes. **[Agent: vercel-infra]**
  - [ ] Write `race:create-order` — many simultaneous Buy attempts sharing one intent key, asserting exactly one order exists. **[Agent: testing-expert]**
  - [ ] Write `race:webhooks` — **fifty** simultaneous `paid` reports for one order, asserting one delivery row, one key claimed, the order `delivered`, and every response `2xx`. This is the assignment's headline scenario at its stated number. **[Agent: testing-expert]**
  - [ ] Write `race:same-event` — one `event_id` delivered many times concurrently, asserting one stored event and an unchanged order and delivery. **[Agent: testing-expert]**
  - [ ] Write `webhook:before-order` — a report delivered before its order is created, asserting the event is stored pending, applied once the order appears, and yields exactly one key. **[Agent: testing-expert]**
  - [ ] Apply RED validation to every script: weaken the mechanism each defends, record the failure it produces, restore the source exactly, and confirm it is byte-identical. §2.6 makes this an acceptance criterion — a check that cannot fail is decoration, and against a single instance a broken claim passes. **[Agent: testing-expert]**
  - [ ] Verify: run the whole set twice in a row with no manual tidying between runs, and confirm the scripts can be pointed at a single base URL without being rewritten. Assert against the database throughout. Then delete any temporary artifacts produced during the check. **[Agent: testing-expert]**
  - [ ] Explain to the user how this concrete feature works and what its role is among the key points of the test task in particular — here: why a race check pointed at one instance measures the connection pool rather than the constraint, and what each script's RED result actually proves. **[Agent: nestjs-backend]**

- [ ] **Slice 7: The walkthrough of what was built**

  > Functional spec §2.7. A deliverable of the phase, not documentation overhead.

  - [ ] Write `docs/walkthrough/phase-2.md` covering the three required keystones: how the shop tells a repeated attempt from a genuine second purchase; why a report the shop has already handled is a success rather than an error; and why work that happens after the shop says "received" is what lets it say so quickly. Each entry states the decision, the more obvious alternative, what breaks without it, and — where a guarantee is enforced by the database — the exact statement and what zero returned rows means. Match the format of the existing slice walkthroughs and cite them rather than re-deriving what they cover. **[Agent: nestjs-backend]**
  - [ ] Review the walkthrough against the §2.7 acceptance criteria in two passes: first reading **only** the walkthrough, standing in for a reader who has never seen the source, listing every term that carries load without being explained; then opening the source to fact-check its SQL, constraint names and numbers. Revise what genuinely fails a criterion; do not rewrite for taste. **[Agent: general-purpose]**
  - [ ] Explain to the user how this concrete feature works and what its role is among the key points of the test task in particular — here: how Phase 2's keystones combine with Phase 1's into one argument, and which interview question each answers. **[Agent: general-purpose]**

- [ ] **Slice 8: Feature Testing & Regression**

  > Verifies the whole feature end-to-end against functional-spec.md, run after all implementation slices are complete.
  - [ ] Read functional-spec.md acceptance criteria in full. Generate acceptance-level tests that verify the entire feature as a whole — not individual slices. Cover applicable layers (unit for pure logic, integration for service interactions, e2e for user flows) based on the project's testing stack. Write tests with RED validation (must fail before implementation is confirmed done). Annotate each test with `@spec: 002-single-issuance-under-races` and `@regression` if suitable for long-term regression. **[Agent: testing-expert]**
  - [ ] Run all generated tests. All must pass. Fix any failures before proceeding. **[Agent: testing-expert]**
  - [ ] Explain to the user how this concrete feature works and what its role is among the key points of the test task in particular — here: which of the assignment's five adversarial scenarios Phase 2 settles, which remain, and what a reviewer can now run for themselves. **[Agent: nestjs-backend]**
