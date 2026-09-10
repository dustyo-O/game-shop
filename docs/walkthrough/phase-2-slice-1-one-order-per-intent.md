# Phase 2 · Slice 1 — A double-click produces one order

> Settles functional spec 002 §2.1 and the assignment's stage-2 headline: *«при двойном клике "Купить" … ключ выдается ровно один раз без задвоения и потери»*.
>
> Phase 1 measured this gap and refused to paper over it — two concurrent `POST /api/orders` produced two orders, both with `client_request_id` NULL. This slice puts the fix in the write itself, and the harder half of it lives on the client.

---

## 1. What was built

Four small pieces, and the whole guarantee lives in the seam between them.

**The header.** `POST /api/orders` now reads an optional `Idempotency-Key`. The controller validates it can be a key at all — non-empty, not pure whitespace, at most 255 characters — and passes it through verbatim. Absent is legal and means "no key"; that keeps every Phase 1 caller and script working unchanged.

**The insert.** The key is stored as `orders.client_request_id`, behind a UNIQUE index. Creation is still exactly one statement — the same `INSERT ... SELECT` that copies the price out of `products` column-to-column, now with a conflict clause bolted on:

```sql
insert into orders (id, client_request_id, sku, amount_minor, currency, status, created_at, updated_at)
select $1, $2, "sku", "price_minor", "currency", 'created', now(), now()
from products
where products.sku = $4 and products.purchasable = $5
on conflict (client_request_id) do nothing
returning id, sku, amount_minor, currency, status;
```

Nothing in the service ever asks "have I seen this key before?". That question is check-then-act: two overlapping requests both answer "no" and both insert. The unique index is the first and only place two concurrent attempts meet, so the index picks the winner and the code only reads the verdict.

**The read-back.** Zero rows means one of two things; a follow-up `SELECT ... WHERE client_request_id = $1` on that path tells them apart. One row → this key already made an order, return it with `200`. Zero rows → the key was new, so the conflict clause was never reached and the SKU simply isn't purchasable → `422`.

**The client that mints the key.** `apps/web/src/features/buy-product/lib/purchase-intent.ts`. A `crypto.randomUUID()` per SKU, minted lazily, kept in `localStorage`, cleared only once an order for it exists.

## 2. Why the key names intent, not content

The obvious alternative is to hash the request body: `sha256({"sku":"KEY-CS2-PRIME"})`, and use that as the key. It needs no client cooperation at all, which is exactly why it's tempting.

It breaks the fifth acceptance criterion in §2.1: *a shopper who has already bought an item and wants another one gets a separate second order with its own key.* Two deliberate purchases of the same game have identical bodies. A content hash makes the second one a "duplicate" of the first and hands back the original order — with the key the shopper already owns. The shop becomes one that can sell you any given game exactly once, forever.

That is the point: **the same content is not the same intent.** Only the client knows whether this is a retry or a new decision, so only the client can name it. The server's job is to enforce that one name produces one order, not to guess what the name should be.

The converse is the case people usually ask about next. What if a client sends one key with two *different* SKUs? The answer is: the original order comes back, unchanged, with the original SKU. The key is not re-checked against the body. Sending one key for two games is a client bug, and the honest answer to it is still "that key already named a purchase, here it is". The alternative — a `409 Conflict` — invents a failure mode the shopper cannot act on, for a request their own page cannot make, since the key is minted per SKU.

## 3. Why minting location is the whole game

This is the part that is easy to get wrong invisibly, and it is worth being blunt about it.

Suppose the key is minted inside the click handler:

```ts
const orderId = await createOrder(sku, crypto.randomUUID());  // wrong
```

The server is now perfect. The index is unique, the conflict clause is right, the read-back is right. And a double-click still buys two copies, because two clicks mint two UUIDs, and two different keys are two different intents by definition. The key names *the click* instead of the purchase.

Now look at what your tests say. Every `curl` check — send one key twice, assert one order — passes, because the test supplies the key itself. It supplies the key the browser never reuses. The mechanism looks like it works and protects nothing, and the test suite is *green*.

So the verification criterion has to change shape. "Two scripted requests with the same key produce one order" tests the database half only. The client half — that a second click reuses the first click's name — can only be verified by a real double-click in a real browser, driven through Playwright, with the resulting order count checked in the database. Two `curl` calls cannot fail this test, which means they cannot pass it either.

The correct version reads the key rather than making it:

```ts
const orderId = await createOrder(sku, purchaseIntentKey(sku));
```

## 4. Why `localStorage`

Driven directly by §2.1's third criterion: *two tabs on the same purchase produce one order.*

- A module-level variable is per document. It dies on reload, and two tabs never see each other's.
- `sessionStorage` is per tab, by specification. It is the one that looks right and is definitionally wrong for this criterion.
- `localStorage` is the only one of the three that two tabs of the same origin actually share, and it also survives the reload-then-click-again path an impatient shopper reaches naturally.

It carries an assumption worth stating out loud: **two tabs buying the same item at the same time are one intent, not two.** A shopper who genuinely wants two copies gets them via criterion five — buy one, come back, buy again — and by then the key has rotated. The cost of being wrong here is one shopper getting one order when they wanted two simultaneously; the cost of the opposite choice is a shopper charged twice. Only one of those is a shop nobody trusts.

Every access to `localStorage` is wrapped in `try`/`catch`, and not defensively — the property access itself throws. Chrome throws `SecurityError` from `window.localStorage` outright when site data is blocked for the origin. An uncaught throw there happens inside the «Купить» click handler and takes the purchase down for a reason that has nothing to do with buying anything.

The fallback is a module-level `Map`, and it is a deliberate, specific degradation: **repeated clicks and retries within one document still share a key; two tabs no longer do.** A shopper with site data blocked keeps the guarantee that fires most often and loses the one that requires storage to exist.

One more thing that gets checked: values read *back* out of storage are validated (`isUsableKey`), because a shopper can put anything in that store with two lines in a console. An empty or over-long stored key would be a `400` from the API — and since failed attempts deliberately keep their key, that shopper would be *permanently* unable to buy that SKU. An unusable stored value is treated as no value and re-minted.

## 5. Where the key is cleared

Exactly one event clears it: `createOrder` having **resolved**, with an order id in hand, from a `201` or a `200` alike, at the moment the shopper is being sent to that order's page.

Both ways of getting this wrong are real and opposite.

**Too early** — clearing when the request is sent, or on any failure — breaks §2.1's fourth criterion, and it costs the shopper money. A click that appears to fail may well have succeeded at the server with only the response lost. The shopper clicks again, a fresh key is minted, and the shop cannot tell the retry from a new purchase. So every failure path in `buy()` deliberately leaves the key in place. That is precisely what makes clicking again safe.

**Too late** — never clearing, or clearing on a timer — breaks criterion five in the more embarrassing direction. A shopper buying the same game a second time sends the old key and is handed their *first* order back, complete with the key they already own, with no way to buy a second copy at all.

Between those, "the response arrived and it names an order" is the only event that is certain in both directions.

There is one window this leaves open on purpose. If the document dies between the request going out and the response arriving — tab closed, connection dropped — the key survives, and the shopper's next click on that SKU is answered with the order their lost request created. That is not a leak; that is the fourth criterion working. From the shopper's side the two situations are the same one: they clicked, they never saw an order, they clicked again. And no expiry is put on the stored key, because any timeout short enough to matter would turn a slow retry into a double purchase.

## 6. Why zero rows has two causes

Zero rows from that insert means either *the key already won* (a legitimate retry) or *the SKU is not purchasable* (a rejection). Conflating them is wrong in both directions:

- Treat every zero-row as a conflict → a bad SKU is answered with somebody else's order.
- Treat every zero-row as a rejection → a retrying shopper gets a `422` for an order that already exists, and their money is gone with no page to look at.

The second is the more likely bug, and it is worse. Note the specific bad case it prevents: a shopper retries, and in the meantime the item has been withdrawn from sale. The insert now fails for *both* reasons at once. The read-back finds the order and returns `200`. **A `422` never displaces a `200`.**

The follow-up read runs only on the zero-row path — the path with no work to do anyway — so the happy path is still one round trip. And when the key is `null` the read is skipped entirely: NULLs do not collide in a Postgres unique index, so the conflict clause is unreachable and zero rows can only mean the SKU was rejected. `= NULL` would match nothing anyway, and matching *some* NULL-keyed order would be far worse than nothing.

## 7. The 255-character limit, measured not assumed

Three reasons, in order of weight. It is well above anything a client would legitimately mint (a UUID is 36 characters, a ULID 26). It is the value Stripe uses, so any client library written against another API is already inside it. And — the real one — **the column is indexed, and a btree index entry is not unbounded.**

An index entry may not exceed roughly a third of an 8 kB page. This was tested against the live index rather than taken from the manual, and a 3200-character random key produced:

```
ERROR:  index row size 3216 exceeds btree version 4 maximum 2704
        for index "orders_client_request_id_key"
```

The non-obvious detail is what happens with a *long but compressible* key. Three thousand repeated characters inserts fine — pglz compresses the value before the index ever sees it. So the limit cannot be reasoned about from length alone, and the values that hit it are precisely the *good* keys: a good idempotency key is random, and random data is incompressible.

Without a check at the door, a client can turn the very constraint that is protecting it into a `500`. That is a database error raised by client input, which is the shape of an availability bug — and it would happen only for well-formed random keys, which is a delightful thing to debug at 3am. 255 keeps every stored value an order of magnitude clear of the ceiling, and the rejection is a `400`, because re-sending the identical bytes would fail identically.

## 8. Why the read-back cannot miss the winner

This is the part that makes the design structural rather than lucky, and it is the question a good interviewer asks.

The worry: request B loses the conflict, gets zero rows, reads back — and A's row isn't committed yet. B sees neither its own row nor A's, and answers `422` for an order that is about to exist.

That window does not exist, and not because it's narrow. It is a property of `ON CONFLICT DO NOTHING`. When the conflicting row is still uncommitted, the index insertion does not fail and does not skip — inside `_bt_check_unique` it takes `XactLockTableWait` on the other transaction and blocks. When A finishes, B re-checks:

- A **aborted** → the conflicting entry is dead, B inserts and wins. `201`.
- A **committed** → B gets zero rows, and A's row is now committed.

By the time zero rows comes back to the application, the winner is committed. B's follow-up `SELECT` takes its snapshot *after* that, so it sees the row. There is no ordering of events in which the loser sees nothing.

That's the difference between "we tested it and it worked" and "it cannot fail". Postgres does the waiting; the code does not need a retry loop, a sleep, or a transaction wrapping the pair.

Two details fall out of that. There is deliberately **no transaction** around insert + read-back — nothing the read sees can become un-decided later, and wrapping them would hold this serverless instance's single connection across two round trips instead of one. And the conflict target is **named** (`client_request_id`), not bare, so this clause forgives exactly one constraint: a primary-key collision on `id` still raises rather than being silently misreported as a retry.

## 9. Where this sits in the assignment

Phase 1 measured this gap and refused to paper over it. `docs/walkthrough/slice-2-order-lifecycle.md` §6 states it plainly: two concurrent `POST /api/orders` produced two orders, both with `client_request_id` NULL, and the disabled button was explicitly not offered as the answer. §6 also worked out where the fix had to go — *not the page* (one client among many, and the only one that cooperates), *not the API process* (an in-memory `Map` or mutex passes locally and evaporates on Vercel, where two concurrent requests are two instances with separate memory — the most dangerous kind of fix, because your test goes green), *it has to be the write itself*.

This slice puts it there. It closes the first adversarial scenario in the assignment — the double-click — and it is the answer to the interview question Phase 1 could only answer honestly-but-negatively. "What stops two orders from one double-click?" used to be "nothing on the server yet, and here is exactly why the button doesn't count." It is now "a unique index and a conflict clause, plus a key that names the intent rather than the click — and here is why the second half is the part that took the thinking."

---

## Interview questions this answers

**Why an intent id and not a hash of the request body?**
Because two deliberate purchases of the same game have identical bodies. A content hash makes the second one look like a duplicate and hands back the first order, so the shop can sell each game to each shopper exactly once, forever. Only the client knows whether this is a retry or a new decision.

**What if a client sends the same key with a different SKU?**
It gets the original order back. The key names an intent that has already produced an order, and that is the honest answer. A `409` would invent a failure the shopper cannot act on, for a request the page cannot make — the key is minted per SKU.

**Where does the key get minted, and why does that matter more than the SQL?**
Per SKU, in `localStorage`, not in the click handler. A key minted per click names the click: a double-click sends two names and buys two copies while the server behaves perfectly. And every `curl` test that sends one key twice still passes, because the test supplies the key the browser never reuses. That is why this criterion has to be verified with a real double-click in a browser, not two scripted requests.

**Zero rows came back from the insert. What happened?**
One of two things, and they must not be conflated: the key already created an order (retry → `200` with that order), or the SKU is not purchasable (→ `422`). A follow-up read on `client_request_id` separates them, and it runs only on the zero-row path. A `422` never displaces a `200`.

**How do you know the read-back sees the winner and not an empty result?**
Because `ON CONFLICT DO NOTHING` waits. When the conflicting row is uncommitted, `_bt_check_unique` takes `XactLockTableWait` on the other transaction rather than returning. If that transaction aborts we insert and win; if it commits we get zero rows *and it is committed*. The read's snapshot is taken afterwards, so it cannot miss it. Structural, not a timing assumption.

---

## Source files

- `apps/api/src/orders/orders.service.ts`
- `apps/api/src/orders/orders.controller.ts`
- `apps/web/src/features/buy-product/lib/purchase-intent.ts`
- `apps/web/src/features/buy-product/ui/buy-controls.ts`
- `docs/walkthrough/slice-2-order-lifecycle.md` §6
- `context/product/architecture.md` §3 (I1)

**On evidence:** the btree index-row-size error and the compressible-key counterexample in §7 were produced against the live index rather than quoted from the manual; the `_bt_check_unique` / `XactLockTableWait` guarantee in §8 is Postgres behaviour, not a measurement of this codebase. Nothing was written and no source was modified while the explanation was produced.
