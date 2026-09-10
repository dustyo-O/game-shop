/**
 * The order row lock — **the first half of invariant I4** (`architecture.md`
 * §3, §3.1).
 *
 * I4 is two mechanisms, not one, and the table in §3 names both:
 *
 *   > `SELECT … FOR UPDATE` on the order row, **plus** status-guarded updates
 *   > (`WHERE status = 'paid'`)
 *
 * `./order-transition.service.ts` is the second half and has been here since
 * Phase 1. This file is the first half, and the two do genuinely different
 * jobs — which is why neither one replaces the other:
 *
 *   - **The guard makes a *transition* idempotent.** It is exact and it is
 *     free, but its exclusivity lasts exactly as long as its own statement.
 *     The instant that UPDATE commits, the guard has no further opinion about
 *     anybody.
 *   - **The lock makes a *worker* exclusive.** It says nothing about which
 *     transition is legal; it says that for as long as this transaction lives,
 *     no other transaction may read-for-update or write this order row. That
 *     is the only thing that can cover a decision spanning more than one
 *     statement.
 *
 * Phase 1 needed only the guard, because there was exactly one entry point into
 * issuance and its last write was the claim itself. Phase 2 Slice 3 ended that:
 * the payment-event drain is a second worker, reachable from four independent
 * triggers (`architecture.md` §4, "Processing triggers") — the webhook's own
 * `waitUntil` continuation, order creation, the shopper's status poll, and the
 * admin sweep. Two of those can be examining the same order in two processes at
 * the same instant, so the span between "decide to issue" and "record what the
 * supplier said" now has real concurrency in it and needs the lock.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SIGNATURE DEMANDS A `Transaction`, AND CANNOT TAKE THE POOL
 * ---------------------------------------------------------------------------
 * A row lock lives until `COMMIT` or `ROLLBACK`. Taken on the pooled handle it
 * would be taken inside the implicit transaction of its own statement and
 * released before the next line of TypeScript ran — a lock that is held for
 * nanoseconds and protects nothing, which is worse than no lock at all because
 * it *reads* as protection.
 *
 * So {@link OrderLockService.lockOrder} accepts `Transaction` and not
 * `Database`. That is not a convention, it is the type system refusing to
 * compile the mistake: there is no overload, no optional handle, and no way to
 * call this outside a transaction. `./order-transition.service.ts` keeps the
 * same split for the same reason — `transition` vs `transitionWithin` — and
 * this file is the reason its header's "no `SELECT … FOR UPDATE` here" bullet
 * now has somewhere to point.
 *
 * ---------------------------------------------------------------------------
 * TWO SHORT TRANSACTIONS BRACKET THE SUPPLIER CALL. NEVER ONE LONG ONE.
 * ---------------------------------------------------------------------------
 * The obvious shape — lock the order, call the supplier, write the result,
 * commit — is the one design this codebase cannot have. `packages/db/src/client.ts`
 * sets the pool to `max: 1` per instance, deliberately, and Drizzle checks that
 * single connection out for the whole of `transaction()`. A transaction held
 * across an HTTP round trip therefore blocks **every other database statement
 * in this process** — the catalogue, order creation, webhook intake, every
 * status poll — for as long as the supplier takes, and `SUPPLIER_TIMEOUT_MS` is
 * 2000ms. A slow supplier would become a total instance outage, and the symptom
 * would be unrelated requests timing out.
 *
 * The shape that is used instead:
 *
 *     TX A   BEGIN; SELECT … FOR UPDATE; UPDATE … WHERE status = ANY('{paid}'); COMMIT;
 *     ————   POST {SUPPLIER_A_URL}/issue        ← no transaction, no lock held
 *     TX B   BEGIN; SELECT … FOR UPDATE; …resolve, bind, finish…; COMMIT;
 *
 * The call itself is excluded by neither lock. **Its exclusion is the
 * `delivering` claim**: TX A's guarded UPDATE returns one row to exactly one
 * worker and zero rows to every other, and a worker holding zero rows does not
 * call the supplier. The lock's job is to make the *claim decision* and the
 * *outcome write* each atomic against another worker, not to span the network.
 *
 * ---------------------------------------------------------------------------
 * `FOR UPDATE`, NOT `FOR NO KEY UPDATE` — AND THE FK ARGUMENT IS THE REASON
 * ---------------------------------------------------------------------------
 * This is a real question in this schema rather than trivia, because `orders`
 * has two referencing tables (`packages/db/src/schema/shop.ts`):
 *
 *     deliveries.order_id         REFERENCES orders(id)
 *     issuance_attempts.order_id  REFERENCES orders(id)
 *
 * An `INSERT` into either one makes Postgres take `FOR KEY SHARE` on the parent
 * `orders` row to prove it still exists. `FOR KEY SHARE` conflicts with
 * `FOR UPDATE` and does **not** conflict with `FOR NO KEY UPDATE`; that is the
 * entire difference between the two strengths. The usual advice — "you are only
 * changing `status`, not a key column, so take the weaker lock and let foreign
 * keys through" — is right in general and wrong here, for three reasons:
 *
 *   1. **The rows those FK checks are for are the exact rows being serialised.**
 *      The only two tables that reference `orders` are the two that issuance
 *      writes. So `FOR UPDATE`'s extra blocking is not collateral damage on some
 *      unrelated hot path; it is a second, independent layer of precisely the
 *      exclusion being asked for. If a future code path inserts a `deliveries`
 *      row for an order without taking this lock first, `FOR UPDATE` still
 *      makes it queue behind the worker that did. `FOR NO KEY UPDATE` would wave
 *      it through.
 *   2. **Nothing that matters is blocked.** `payment_events.order_id` carries
 *      no foreign key, on purpose (`architecture.md` §4, "Out-of-order
 *      tolerance"), so webhook intake takes no lock on `orders` at all. The
 *      shopper's status poll is a plain `SELECT` and under `READ COMMITTED` a
 *      plain reader never waits on a row lock. Order creation inserts a new row
 *      and touches nobody else's.
 *   3. **§3.1 specifies `FOR UPDATE`,** letter for letter, and the project's
 *      rule is to implement the statement in the spec rather than a defensible
 *      variant of it. Reaching for the weaker lock would be an optimisation
 *      against a contention profile this schema does not have.
 *
 * The honest cost, stated rather than discovered: a second worker's
 * `INSERT INTO issuance_attempts` (`../issuance/issuance.service.ts` step 1,
 * which runs outside any transaction) can block on the FK check while another
 * worker holds this lock in TX B. That wait is bounded by TX B, which is three
 * statements and no network I/O — microseconds — and it cannot deadlock,
 * because the waiter holds no other lock while it waits.
 *
 * ---------------------------------------------------------------------------
 * `FOR UPDATE`, NOT `FOR UPDATE SKIP LOCKED` — THE OPPOSITE CHOICE FROM THE QUEUE
 * ---------------------------------------------------------------------------
 * `SKIP LOCKED` is used twice in this codebase — the inbox drain
 * (`../payments/payment-event-drain.service.ts`) and the supplier's key claim
 * (`../suppliers/supplier-key-claim.service.ts`) — and it is right in both,
 * because both are asking *"give me a unit of work nobody else has"*. Any row
 * will do, a locked row means somebody else is already on it, and stepping over
 * it is how N workers fan out across N rows instead of queueing on one. A prior
 * measurement in this project put numbers on that: twenty contending key claims
 * convoyed at **959ms** under plain `FOR UPDATE` against **54ms** under
 * `SKIP LOCKED`.
 *
 * The order row is asking a different question, and the numbers do not carry
 * over. Here the row is not *a* unit of work, it is *the* order this worker was
 * handed, and there is no other row it could take instead. Skipping would
 * return zero rows, which:
 *
 *   - is indistinguishable from "no such order" — and those two must stay
 *     distinguishable, because `payment_events.order_id` has no FK and an event
 *     for an order that does not exist yet is a normal path that must be left
 *     pending rather than settled; and
 *   - throws away the answer the loser actually needs. A worker that *waits*,
 *     gets the lock, and re-reads to find `delivering` or `delivered` knows the
 *     order is owned or finished and can settle its event accordingly
 *     (`../payments/payment-event-processor.service.ts`,
 *     `settleOrDeferPaidEvent`). A worker that skipped knows nothing and would
 *     have to leave a settle-able event in the queue forever.
 *
 * And the convoy that made `SKIP LOCKED` worth 900ms on the key pool does not
 * exist here, because **of what the lock does not span.** The queue behind this
 * lock waits for TX A — two statements, no network — not for the supplier call,
 * which happens with no lock held. Twenty webhooks for one order serialise
 * through a few hundred microseconds of Postgres and then nineteen of them
 * discover, correctly and cheaply, that there is nothing for them to do. That
 * convoy is not a cost to be avoided; it *is* the serialisation being bought.
 *
 * `NOWAIT` is rejected for a related reason: it turns contention into an error,
 * and contention here is the ordinary case rather than the exceptional one.
 *
 * ---------------------------------------------------------------------------
 * LOCK ORDERING — WHY THIS CANNOT DEADLOCK
 * ---------------------------------------------------------------------------
 * A deadlock needs two transactions each holding a lock the other wants. The
 * property that rules it out here is stronger and simpler than an ordering
 * convention: **no transaction in this codebase ever waits on a second row lock
 * while holding one it acquired in another table.**
 *
 *   - The inbox drain takes `payment_events … FOR UPDATE SKIP LOCKED` and
 *     `COMMIT`s before it processes anything, so no order lock is ever held at
 *     the same time as an event lock.
 *   - The supplier's key claim takes `supplier_keys … FOR UPDATE SKIP LOCKED`
 *     inside its own transaction, reached over HTTP as a separate request, at a
 *     moment when the calling worker is deliberately holding **no** lock — the
 *     supplier call is between TX A and TX B.
 *   - TX A locks one order row and writes that same row. One row, one table.
 *   - TX B locks the order row and then writes `issuance_attempts` and
 *     `deliveries`, whose FK checks want `FOR KEY SHARE` on that same order row
 *     — already held by this transaction, and a transaction never conflicts with
 *     itself. So the only ordering that exists anywhere is **parent first, then
 *     its children**, taken by a transaction that already holds the parent.
 *     Every contending transaction follows it, so there is no cycle to form.
 *
 * Nothing here locks two orders, and nothing locks an order and a supplier key.
 */
import { Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";

import { orders, type Order, type Transaction } from "@game-shop/db";

@Injectable()
export class OrderLockService {
  /**
   * Take the row lock on one order **inside the caller's transaction**, and
   * hand back the row as it stands under that lock.
   *
   * Emitted SQL (copied from `.toSQL()`; per the project's raw-SQL rule,
   * `architecture.md` §2, "Documentation convention"):
   *
   *   select "id", "client_request_id", "sku", "amount_minor", "currency",
   *          "status", "created_at", "updated_at"
   *   from "orders" where "orders"."id" = $1 for update;
   *   -- 1 row  => THIS transaction now owns the order row. Every other worker
   *   --           that reaches this statement for the same id waits here until
   *   --           this transaction commits or rolls back.
   *   -- 0 rows => no such order, and NOTHING IS LOCKED. Not an error: an event
   *   --           may name an order that does not exist yet (no FK on
   *   --           `payment_events.order_id`). The caller's guarded UPDATE will
   *   --           match nothing either and report `order_not_found`.
   *
   * That is §3.1's statement unchanged, including the `SELECT *` — Drizzle
   * spells the star as the column list, which is the same thing. Three details
   * are load-bearing:
   *
   *   - **No `LIMIT`.** `orders.id` is the PRIMARY KEY, so the predicate already
   *     names at most one row. A `LIMIT 1` would suggest it might not.
   *   - **The whole row, not `SELECT 1`.** The returned status is what lets a
   *     caller log *what it found when it got in* — "waited, acquired, order was
   *     already `delivered`" is the log line that makes a lost race readable
   *     instead of invisible.
   *   - **Nothing branches on the returned row.** Under the lock a
   *     check-then-act would actually be safe, which is exactly why it is worth
   *     saying that this codebase still does not do one: the decision stays the
   *     status-guarded UPDATE that follows, evaluated by Postgres against the
   *     row (`architecture.md` §3, the governing principle). The lock serialises
   *     the workers; the guard decides. Both, or neither is enough.
   *
   * ### What the caller owes
   *
   *   - **Take this first.** It is the serialisation point, so every write the
   *     transaction makes must happen after it. A lock taken after the writes
   *     protects the writes that already happened, which is nothing.
   *   - **Keep the transaction short and free of network I/O.** The lock is held
   *     until `COMMIT`, and with `max: 1` so is the instance's only connection
   *     (`packages/db/src/client.ts`). See the header for the shape.
   *   - **Do not call this from a nested `database.transaction()`.** Use the
   *     `tx` handle you already have; asking the pool for a second connection
   *     self-deadlocks against the one this transaction is holding.
   */
  async lockOrder(tx: Transaction, orderId: string): Promise<Order | undefined> {
    const [locked] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");

    return locked;
  }
}
