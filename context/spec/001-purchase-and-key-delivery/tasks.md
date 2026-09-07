# Tasks: Purchase and Key Delivery

Spec: `context/spec/001-purchase-and-key-delivery/`
Slices are vertical — after each one the application starts and does something new that can be seen or tested.

---

- [x] **Slice 1: The shop shows what it sells**

  > First runnable state: a page listing all twelve catalogue items with names and prices in Russian.

  - [x] Scaffold the pnpm workspace: `apps/api` (NestJS + Express adapter), `apps/web` (Vite + vanilla TypeScript), `packages/contracts`, `packages/db`. Strict TypeScript across all of them. **[Agent: vercel-infra]**
  - [x] Add `docker-compose.yml` with Postgres 16, plus the npm scripts that start the database, run migrations, seed, and launch API and web together. **[Agent: vercel-infra]**
  - [x] Define the full Drizzle schema in `packages/db` and generate the first migration: `products`, `orders`, `payment_events`, `issuance_attempts`, `deliveries`, `supplier_keys`, `supplier_requests` — with every constraint and index from technical-considerations §2.2, including the ones no code exercises yet. Money as integer minor units. Annotate each correctness-critical constraint with the invariant it enforces (I1–I9). **[Agent: postgres-drizzle-database]**
  - [x] Configure the database client for serverless-compatible use from the start: pool size 1, prepared statements disabled. **[Agent: postgres-drizzle-database]**
  - [x] Write the seed: the twelve supplied products (with `purchasable` true for the three of type `key`) and the fifty supplied keys into `supplier_keys`. **[Agent: postgres-drizzle-database]**
  - [x] Define the shared wire types in `packages/contracts`: order status enum, webhook payload, supplier `/issue` request and response. **[Agent: nestjs-backend]**
  - [x] Implement `GET /api/products` returning the catalogue. **[Agent: nestjs-backend]**
  - [x] Build the shop page at `/`: twelve items with name and price, a «Купить» control on purchasable ones only. All text in Russian. Plain and functional — no design work. **[Agent: vanilla-ts-frontend]**
  - [x] Verify: start the stack from a clean database, confirm migrations and seed run, open the shop page and confirm twelve items render with Russian names, prices, and «Купить» only on the three key products. Then delete any screenshots or recordings produced during the check. **[Agent: testing-expert]**
  - [x] Explain to the user how this concrete feature works and what its role is among the key points of the test task in particular — here: the data model, and why every correctness constraint ships before any code exercises it. **[Agent: postgres-drizzle-database]**

- [x] **Slice 2: A shopper can create an order and see it awaiting payment**

  > Clicking «Купить» produces a real order with its own page.

  - [x] Implement the status transition helper — the single place any order status changes, with every transition naming its permitted source states. This is what makes final states terminal (I9). **[Agent: nestjs-backend]**
  - [x] Implement `POST /api/orders` accepting `{ sku }`, creating an order in `created` with a `ord_`-prefixed ULID id and the server-computed amount. Reject non-purchasable SKUs. **[Agent: nestjs-backend]**
  - [x] Implement `GET /api/orders/:id` returning status, product name and amount, with a not-found response for an unknown id. **[Agent: nestjs-backend]**
  - [x] Build the order page at `/order/:id`: product name, amount, «Ожидает оплаты», and a Russian not-found message for an unknown order. **[Agent: vanilla-ts-frontend]**
  - [x] Wire «Купить» to create the order and navigate to its page. **[Agent: vanilla-ts-frontend]**
  - [x] Verify: drive the browser from the shop page through «Купить» to the order page, confirm the product name, amount and awaiting-payment state appear; open a made-up order address and confirm the not-found message. Then delete any screenshots or recordings produced during the check. **[Agent: testing-expert]**
  - [x] Explain to the user how this concrete feature works and what its role is among the key points of the test task in particular — here: the order lifecycle as a state machine, and why every transition names the states it is allowed to leave from. **[Agent: nestjs-backend]**

- [x] **Slice 3: A failed payment is visible and final**

  > The shorter payment path first — it gets the webhook and the simulator working without touching issuance.

  - [x] Implement `POST /api/webhooks/payment`: insert into `payment_events` with `ON CONFLICT (event_id) DO NOTHING RETURNING *`, treating zero returned rows as "already seen" and acknowledging without further work (I2). Annotate with the emitted SQL and what zero rows means. **[Agent: nestjs-backend]**
  - [x] Apply a `failed` event to its order as a status-guarded transition `created → payment_failed`, where zero affected rows means the event is a no-op. Mark the event processed. **[Agent: nestjs-backend]**
  - [x] Implement `POST /api/payments/:orderId/simulate` accepting `{ outcome }`, building a contract-shaped event and delivering it to the webhook endpoint. **[Agent: nestjs-backend]**
  - [x] Add «Оплатить успешно» and «Оплата не прошла» controls to the order page while awaiting payment; render the failed state and hide the controls once payment has failed. **[Agent: vanilla-ts-frontend]**
  - [x] Verify: create an order, choose the failing control, confirm the page shows payment did not go through, no key is shown, and no payment controls remain; confirm re-sending the same event id changes nothing. Then delete any screenshots or recordings produced during the check. **[Agent: testing-expert]**
  - [x] Explain to the user how this concrete feature works and what its role is among the key points of the test task in particular — here: at-least-once delivery, and why the event id winning or losing an insert is what decides a duplicate, rather than the handler checking first. **[Agent: nestjs-backend]**

- [x] **Slice 4: The supplier issues keys and never issues one twice**

  > The supplier stub stands alone as a service before anything calls it. Not user-visible, but directly testable over HTTP.

  - [x] Implement the key claim inside the supplier: look up `supplier_requests` by `request_id` first and return the stored code if present (I5); otherwise claim an unclaimed key with a single conditional `UPDATE … WHERE code = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING code` and record the request (I6). Annotate both statements with the SQL and what zero rows means. **[Agent: postgres-drizzle-database]**
  - [x] Expose it as `POST /internal/suppliers/a/issue` per the supplied contract, returning `{ status: "ok", request_id, code }` or an error body with `reason: "out_of_stock"` when the pool is empty. Always succeeds in this phase — no failure or timeout injection yet. **[Agent: nestjs-backend]**
  - [x] Add `SUPPLIER_A_URL` and `SUPPLIER_TIMEOUT_MS` configuration, and call the stub over real HTTP rather than in-process. **[Agent: vercel-infra]**
  - [x] Verify: call the endpoint twice with the same `request_id` and confirm the identical code comes back both times with only one key claimed in the database; call it with a fresh `request_id` and confirm a different code. Then delete any temporary scripts produced during the check. **[Agent: testing-expert]**
  - [x] Explain to the user how this concrete feature works and what its role is among the key points of the test task in particular — here: the supplier's own idempotency ledger, why a repeat with the same `request_id` must return the same code, and why this is the property the Phase 3 timeout trap depends on. **[Agent: postgres-drizzle-database]**

- [x] **Slice 5: A successful payment delivers a key**

  > The spine closes. This is the slice the whole assignment is about.

  - [x] Apply a `paid` event as a status-guarded transition `created → paid`, then `paid → delivering`, where zero affected rows means another path already advanced the order. **[Agent: nestjs-backend]**
  - [x] Implement the issuance module: derive `request_id` as `req_{order_id}_{provider}_{attempt}`, record the attempt, call supplier A, and bind the result by inserting into `deliveries` with `ON CONFLICT (order_id) DO NOTHING` — the unique index, not an application check, is what makes a second delivery impossible (I3). Then transition `delivering → delivered` and mark the event processed. Annotate with the emitted SQL. **[Agent: nestjs-backend]**
  - [x] Return the key from `GET /api/orders/:id` only once the order is `delivered`. **[Agent: nestjs-backend]**
  - [x] Render the processing and delivered states on the order page, show the key, and poll once per second while the order is non-terminal, stopping on any terminal state. **[Agent: vanilla-ts-frontend]**
  - [x] Verify: drive the browser through buy → pay successfully → watch the page move to delivered and show a key without reloading; reload and confirm the same key; confirm exactly one row in `deliveries` and one claimed key in the database. Then delete any screenshots or recordings produced during the check. **[Agent: testing-expert]**
  - [x] Explain to the user how this concrete feature works and what its role is among the key points of the test task in particular — here: why the shop rather than the page decides a key was given out, and why a unique index on the order beats an application-level "has it been delivered?" check. **[Agent: nestjs-backend]**

- [x] **Slice 6: An empty key pool does not break the shop**

  > Minimum honest handling. Recovery and manual retry stay in Phase 3.

  - [x] Route a supplier `out_of_stock` response to the `delivering → out_of_stock` transition instead of raising, leaving no delivery bound and no exception escaping. **[Agent: nestjs-backend]**
  - [x] Render `out_of_stock` on the order page as an ordinary state in Russian, with no key shown, and stop polling. **[Agent: vanilla-ts-frontend]**
  - [x] Verify: drain the pool, pay for an order, and confirm the page renders the state normally rather than erroring or failing to load, with no code bound in the database. Then delete any screenshots or recordings produced during the check. **[Agent: testing-expert]**
  - [x] Explain to the user how this concrete feature works and what its role is among the key points of the test task in particular — here: why "paid, but there is nothing to hand over" has to be a state the system understands rather than an error, and how that sets up the recovery work in Phase 3. **[Agent: nestjs-backend]**

- [x] **Slice 7: Prove a key is never handed to two orders**

  > Functional spec §2.5 is a Phase 1 requirement, so its proof belongs here rather than in Phase 2's adversarial suite.

  - [x] Write a concurrency test that pays N orders in parallel and asserts against the database directly: N distinct keys, exactly N claimed rows in `supplier_keys`, exactly N rows in `deliveries`. Apply RED validation by temporarily weakening the claim to a read-then-write and confirming the test fails, then restoring it and confirming it passes. **[Agent: testing-expert]**
  - [x] Verify: run the test repeatedly (at least five consecutive runs) to confirm it is not flaky, and record the observed outcome. **[Agent: testing-expert]**
  - [x] Explain to the user how this concrete feature works and what its role is among the key points of the test task in particular — here: why a race is only ever proven by concurrent execution asserted against the database, why a sequential pass proves nothing, and what the RED step demonstrated when the claim was weakened. **[Agent: testing-expert]**

- [x] **Slice 8: The walkthrough of what was built**

  > Functional spec §2.7. A deliverable of the phase, not documentation overhead.

  - [x] Write `docs/walkthrough/phase-1.md` covering the three required keystones: why an order moves through named states rather than a paid flag; why the shop rather than the page decides a key was given out; and how the same key cannot reach two orders. Each entry states the decision, the more obvious alternative, what breaks without it, and — where a guarantee is enforced by the database — the exact statement and what zero returned rows means. **[Agent: nestjs-backend]**
  - [x] Review the walkthrough against the §2.7 acceptance criteria: confirm every entry is followable by someone who has never seen the source, that no entry relies on unexplained jargon, and that each of the four required elements is present in each entry. Revise anything that fails the test. **[Agent: general-purpose]**
  - [x] Explain to the user how this concrete feature works and what its role is among the key points of the test task in particular — here: how the three keystones combine into a single argument the author can deliver aloud, and which interview question each one answers. **[Agent: general-purpose]**

- [x] **Slice 9: Feature Testing & Regression**

  > Verifies the whole feature end-to-end against functional-spec.md, run after all implementation slices are complete.
  - [x] Read functional-spec.md acceptance criteria in full. Generate acceptance-level tests that verify the entire feature as a whole — not individual slices. Cover applicable layers (unit for pure logic, integration for service interactions, e2e for user flows) based on the project's testing stack. Write tests with RED validation (must fail before implementation is confirmed done). Annotate each test with `@spec: 001-purchase-and-key-delivery` and `@regression` if suitable for long-term regression. **[Agent: testing-expert]**
  - [x] Run all generated tests. All must pass. Fix any failures before proceeding. **[Agent: testing-expert]**
  - [x] Explain to the user how this concrete feature works and what its role is among the key points of the test task in particular — here: how the assignment's acceptance criteria became executable tests rather than a checklist read by hand, and which criteria Phase 1 settles versus which remain for Phases 2 and 3. **[Agent: nestjs-backend]**
