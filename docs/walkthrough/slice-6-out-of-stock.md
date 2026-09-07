# Slice 6 — "Paid, but there is nothing to hand over" is a state, not an error

> Written for the author to read and re-explain from memory. Companion to `context/product/architecture.md` §3 (I3, I9), §4 ("Recovery") and functional spec §2.5.
> Slice 8 consolidates this and the other slice walkthroughs into the phase-level document.
>
> **This is a short one on purpose.** Slice 5 already built the mechanism — the definite/unknown split, the
> transaction shape, the settle rule — and Slice 4 §8 derives the `409`. Neither is restated here. This
> document does one job: explain why an empty pool is modelled as a **status** rather than an exception, and
> what that single decision buys downstream.
>
> Every capture below was produced by running the system for this document on 2026-09-07: two API processes
> on ports 3000 and 3001 sharing one Postgres, the key pool drained to exactly one key.

---

## 1. What the naive shop does here

The supplier answers `409 {"status":"error","reason":"out_of_stock"}`. The obvious code is one line:

```ts
if (!res.ok) throw new Error(`supplier refused: ${res.status}`);
```

Follow what that produces, in order, because each step is worse than the one before it:

1. **The exception unwinds out of issuance** and out of the webhook handler. The order is left in
   `delivering` — a status meaning *"a worker has this order and is calling the supplier right now"*, which
   is no longer true and never will be again. No process is coming back for it.
2. **The webhook returns `500`.** A payment provider treats `5xx` as "not delivered, try again", so it
   redelivers — on a schedule, for hours. Every redelivery hits the same empty pool and produces the same
   `500`. The shop has enrolled itself in a retry loop that cannot terminate, over an event it received and
   understood perfectly the first time. (`architecture.md` §4: *"`5xx` is returned only when we genuinely
   want redelivery"*.)
3. **The shopper is told nothing true.** In the mild version the page shows «Выдаём ключ» forever; in the
   version where the `500` leaks into the read path, «Не удалось загрузить заказ» about an order that exists
   and is paid for.
4. **Nobody can find it later.** The order says `delivering` — and so does an order whose supplier call is
   genuinely in flight, and so does an order whose function was killed mid-request. Three different
   situations, one status, and no way to write the query that separates them.

Point 4 is the expensive one. The first three are visible and someone would fix them in a week. A lost
distinction does not show up as a bug; it shows up in Phase 3 as *"we cannot build the admin list, because
we cannot write its `WHERE` clause."* An exception is for the paths the program did not plan for; inventory
running out is a path the *business* plans for, and modelling a planned outcome as an unplanned one discards
the fact that it was planned.

## 2. Why it is a status

`IssuanceService.applyDefiniteFailure` writes two rows in one transaction and returns normally:

```sql
UPDATE issuance_attempts SET status = 'failed', last_error = 'out_of_stock' WHERE request_id = $1;
UPDATE orders SET status = 'out_of_stock', updated_at = now()
  WHERE id = $2 AND status = ANY('{delivering}') RETURNING *;
```

No `throw`, no `deliveries` row, and a `200` to the payment provider. Naming the state rather than
signalling it buys three things, each of which is a query somebody writes later:

| Who asks | The question | What the name gives them |
| --- | --- | --- |
| The order page | "what do I tell this shopper?" | `status = 'out_of_stock'` → «Ключей сейчас нет в наличии» |
| The admin panel (Phase 3) | "which paid orders owe a key?" | `WHERE status = 'out_of_stock'` — one predicate |
| The retry (Phase 3) | "which orders may I re-drive?" | the same predicate, as the transition's source guard |

An order stuck in `delivering` answers none of the three: the page cannot say anything true, the admin list
cannot select it without also selecting every healthy in-flight order, and a retry cannot be guarded on it
without racing a worker that may still be running. **The supplier's refusal is information, and swallowing
it is how it stops being information.**

The acceptance criterion (functional spec §2.5) is specifically that the page *"continues to work normally
rather than showing an error or failing to load"*. Measured — a `200` from the API
(`"status":"out_of_stock","code":null`), and the rendered page read out of the accessibility tree:

```
- heading "Заказ"
- Товар: CS2 Prime Status ключ / Сумма: 1290 ₽
- Статус: Ключей сейчас нет в наличии
- Номер заказа: ord_01M1Y4HR2V75YQRA5X4MVCAXVT
console errors: 0
```

Three things fall out of the status existing, and none is a special case written for this screen. There is
**no «Ключ» row at all** — not an empty one — because `Order.code` is a `string` only inside the `delivered`
branch of the discriminated union, so `renderCodeRow` cannot build a key row for an order that has none.
There are **no payment controls**, because that feature renders only for `created`. And the poll **stopped**,
because `out_of_stock` is in `settledOrderStatuses`.

## 3. Three lists, because they answer three different questions

`packages/contracts/src/order-status.ts` exports `terminalOrderStatuses`, `recoverableOrderStatuses` and
`settledOrderStatuses`. Two look redundant. They are not — ask what each one is asked:

- **`terminal` = `{delivered, payment_failed}`** — *"are any transitions out of this state legal?"* This is
  invariant **I9**. Neither accepts any, ever, by any path. A late webhook must not resurrect a completed
  order.
- **`recoverable` = `{out_of_stock}`** — *"may a later phase legally move an order out of this state?"* Yes:
  `out_of_stock → delivering` is a transition Phase 3 adds.
- **`settled` = terminal ∪ recoverable** — *"will this order change on its own, with nobody doing
  anything?"* No. The page's stop-polling condition, and Phase 3's admin inbox.

The two questions people conflate are **"no legal transitions"** and **"nothing happens by itself"**. They
coincide for `delivered` and diverge for `out_of_stock`, which is the entire reason for a third list.

What breaks on collapse:

- **`out_of_stock` folded into terminal.** The transition helper enforces I9 by refusing any transition
  whose source is terminal, so Phase 3's retry becomes illegal under the shop's own rules. Recovery then
  requires either weakening I9 — the invariant keeping late webhooks from re-delivering completed orders —
  or carving an exception into it, under deadline, for something that was foreseeable.
- **terminal folded into settled, used for I9.** The guard meaning "finished forever" now also matches
  `out_of_stock`, so nothing distinguishes the retryable state from the permanent one.
- **only `settled` kept.** The page is right and the retry is unwritable.

The keeper is the type-level assertion at the bottom of that file:

```ts
type _EveryOrderStatusIsClassified =
  AssertNoUnclassifiedStatus<Exclude<OrderStatus, InFlightOrderStatus | SettledOrderStatus>>;
```

It emits nothing and costs nothing. When Phase 3 adds `delivery_failed` to `OrderStatus`, this alias stops
compiling until somebody classifies it. Without it, an unclassified status reads as in-flight to
`isSettledOrderStatus` and the order page polls a dead order forever — a bug that would ship, because it is
invisible in every state that exists today.

## 4. The one failure the shop is certain about

`out_of_stock` is reachable as a status only because the client could classify the refusal as **definite**.
Slice 5 §4 derives that split; Slice 4 §8 derives the `409`. The sentence connecting them is the one worth
repeating:

**An empty pool is the one failure the shop is provably certain about, because the supplier's claim
statement committed having written nothing** — no key touched, no `supplier_requests` row. There is no key,
and we know there is no key. Nothing else in this system has that property.

That certainty is what licenses a terminal-looking write. Moving an order to `out_of_stock` asserts "no key
exists for this order". On a timeout the same write would be a lie: the request may have been served, a key
may be sitting in the ledger, and the shop would have paid for a key it then told the shopper it does not
have. So the unknown path (`leaveUnresolved`) writes **nothing at all** — the attempt stays `unknown`, the
order stays `delivering`, the payment event stays pending.

The discriminator is the **body**, not the status code: a timeout has no status code, no headers and no body
to parse, which is why `SupplierIssueResponse` has no timeout member. The classification is carried by two
typed errors and branched with `instanceof`, so the compiler is what keeps a timeout out of this branch:

```ts
if (error instanceof SupplierDefiniteFailure) return this.applyDefiniteFailure(order, error);
if (error instanceof SupplierUnknownOutcome)  return this.leaveUnresolved(order, error);
throw error;   // our defect, not the supplier's answer
```

And the `switch` mapping a reason to a transition ends in `assertNever`, so Phase 3 adding a new
`SupplierIssueErrorReason` is a compile error rather than a new failure silently routed to `out_of_stock`.

## 5. What recovery will actually need — measured, not assumed

The claim this slice makes about Phase 3 is narrow, and it was checked rather than asserted: **recovering an
`out_of_stock` order is "call this again", not "repair torn state."** Three facts.

**(a) An `out_of_stock` writes no `supplier_requests` row.** Pool drained to one key, two orders paid, one
refused — the supplier's ledger afterwards:

```
 request_id                             | code
----------------------------------------+----------------
 req_ord_01M1Y4HQY5THKNJS3M4EJDSES6_a_1 | 7EQM-K09J-XKUO      <- the delivered order
(1 row)                                                       <- the refused one is absent
```

The refused `request_id` is *unanswered*, not answered-with-a-failure — so after a restock the identical id
issues normally, with no new identifier and no new attempt number:

```
POST /internal/suppliers/a/issue {"request_id":"req_ord_01M1Y4HR2V75YQRA5X4MVCAXVT_a_1", …}
-> 200 {"status":"ok","request_id":"req_ord_01M1Y4HR2V75YQRA5X4MVCAXVT_a_1","code":"RSTK-0001-SLICE6"}
```

Because `request_id` is *derived* (`req_{order_id}_{provider}_{attempt}`, Slice 5 §5), a Phase 3 retry that
has forgotten everything reconstructs the id from the order row alone. And if a key somehow *had* been
issued against it, I5 returns that same code rather than a second one. Recovery is idempotent for free.

**(b) The attempt row already says what happened** — `status = 'failed'`, `last_error = 'out_of_stock'`.
Phase 3 does not reconstruct why the order stopped; the code that observed the outcome wrote it down.

**(c) Nothing is torn.** No delivery row, no key claimed, no partially-applied transaction, and the payment
event is settled because the order reached a finishing status (the settle rule, Slice 5 §7). The order sits
in `out_of_stock` waiting for something to call it again.

### The boundary case: one key, two orders, two processes

The interesting run is the transition itself, where the last key is contested by two concurrent orders in
two separate processes. Pool drained to exactly one free key, two orders for `KEY-CS2-PRIME`, paid
simultaneously against ports 3000 and 3001:

```
p2 http=200 t=0.075199
p1 http=200 t=0.077364

 id                             | status       | delivered_code | attempt_status | last_error
--------------------------------+--------------+----------------+----------------+--------------
 ord_01M1Y4HQY5THKNJS3M4EJDSES6 | delivered    | 7EQM-K09J-XKUO | ok             |
 ord_01M1Y4HR2V75YQRA5X4MVCAXVT | out_of_stock |                | failed         | out_of_stock

 free_keys | claimed_by_real_requests        deliveries_total
-----------+--------------------------      ------------------
         0 |                        1                       1
```

One key existed, one key was claimed, one delivery bound, one shopper got a code and the other an honest
sentence. Both webhooks `200`, zero errors. The loser was not chosen by any application `if` — it lost
inside Postgres at `FOR UPDATE SKIP LOCKED`, and learned about it as a `409`.

Two processes is the minimum that proves anything, for the reason Slice 4 §9 measures: one process with a
pool of `max: 1` queues its transactions at the connection pool, so the claims never overlap in Postgres and
a broken implementation passes. And the correlation ids make the whole path one log search
(`architecture.md` §8):

```
msg: 'issuance: definite failure — supplier refused; order moved to out_of_stock, no delivery bound',
order_id: 'ord_01M1Y4HR2V75YQRA5X4MVCAXVT', request_id: 'req_ord_01M1Y4HR2V75YQRA5X4MVCAXVT_a_1',
reason: 'out_of_stock', attempt_status: 'failed', status: 'out_of_stock'
```

## 6. What Phase 1 deliberately does not do

Three absences, all intentional, named here so a reviewer need not guess whether they were forgotten:

- **No automatic retry.** Nothing re-drives an `out_of_stock` order. The processing triggers are Phase 2 and
  the retry policy that uses them is Phase 3.
- **No admin list.** The predicate exists; the endpoint and the screen do not.
- **No restock UI.** Adding keys is `INSERT INTO supplier_keys`, by hand. Restocking is *adding rows*, never
  clearing `claimed_by_request_id` — so no previously issued key can be resold.

The honest summary: **the state is recoverable, and nothing recovers it yet.** §5 is what makes that gap
small — Phase 3 adds a caller, not a repair procedure. What it also adds, and this is the real dependency,
is the `SELECT … FOR UPDATE` half of I4 (Slice 5 §9): a manual retry is the *second* worker that can be
inside `delivering` for one order, and the guarded `UPDATE` alone does not serialise two workers who are
both already past the guard.

---

## Five questions, five answers

1. *Why isn't an empty pool an exception?* — Because it is a planned business outcome, and an exception
   discards the fact that it was planned. Concretely: the throw leaves the order in `delivering` forever,
   returns a `500` that makes the provider redeliver an event that will fail identically every time, and
   destroys the distinction between "supplier said no" and "supplier is still answering" — the distinction
   Phase 3's admin list has to select on.
2. *What does a status buy that an error doesn't?* — Three otherwise-unwritable queries: the page's, the
   admin list's `WHERE status = 'out_of_stock'`, and the retry's source-state guard. All three are the same
   predicate, and none exists if the outcome only ever lived in a stack trace.
3. *Why three status lists instead of one?* — Because "no legal transitions" (I9) and "nothing happens on
   its own" (stop polling) are different questions that happen to agree about `delivered`. `out_of_stock` is
   where they diverge: settled but not terminal. Fold it into terminal and Phase 3's retry is illegal under
   our own invariant; fold terminal into settled and I9 stops meaning anything.
4. *Why may you write a terminal-looking status here but not on a timeout?* — Because the supplier's claim
   committed having written nothing, so we are certain no key exists. On a timeout a key may already be in
   the ledger, and `out_of_stock` would assert something we cannot know. The discriminator is the parseable
   error body, not the status code — a timeout has no status code at all.
5. *How do you know recovery is just "call it again"?* — Measured: an `out_of_stock` leaves no
   `supplier_requests` row, so the identical derived `request_id` issues cleanly after a restock (verified
   end to end); the attempt row already reads `failed`/`out_of_stock`; and there is no delivery, no claimed
   key and no pending event to reconcile. The boundary case — one key, two orders paid concurrently across
   two processes — ended with one delivered, one `out_of_stock`, exactly one key claimed, one delivery row.
