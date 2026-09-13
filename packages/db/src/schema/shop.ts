/**
 * Shop-side schema — the tables this application owns.
 *
 * The supplier's own storage lives in `./supplier.ts` and is deliberately not
 * imported from here: see the header of that file for why the separation is a
 * correctness device rather than tidiness.
 *
 * Reading conventions used throughout this file, per the project rule in
 * `context/product/architecture.md` §2 ("Documentation convention"):
 *
 *   - Every correctness-critical constraint names the invariant it enforces
 *     (I1-I9, `architecture.md` §3) and quotes the exact statement Postgres
 *     runs against it, including **what zero returned rows means**. A reviewer
 *     must be able to audit the guarantees without knowing Drizzle.
 *   - Constraints are named explicitly rather than left to Drizzle's defaults,
 *     so the constraint name in a Postgres error message points straight at the
 *     invariant that just refused to be broken.
 *
 * Two naming notes for anyone comparing this file against `architecture.md`
 * §3.1: that section writes the money column as `amount`; here it is
 * `amount_minor`, because the value is **integer minor units** (kopecks) and
 * the name should say so. No money anywhere in this schema is floating point.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

/**
 * The order lifecycle — `created → paid → delivering → delivered`, with
 * branches to `payment_failed`, `out_of_stock` and, from Phase 3,
 * `delivery_failed` (technical-considerations §2.2; spec 003 §2.3).
 *
 * `delivery_failed` was deliberately absent through Phases 1 and 2 — a status
 * the shop could not reach should not be a value the database will accept — and
 * arrives here with migration `0001_delivery_failed_status`, in the same commit
 * as the code that can reach it (spec 003 technical-considerations §11, R6).
 *
 * It is a statement **about the shop**: "we did not hand over a key". The
 * matching statement about the supplier — "the outcome was never established" —
 * is `issuance_attempts.status = 'unknown'`. Two different facts, two tables, on
 * purpose (spec 003 technical-considerations §1.3).
 *
 * It is **recoverable, not terminal**: an operator retry moves it back to
 * `delivering`. Terminality is I9's set (`delivered`, `payment_failed`) and
 * lives in `packages/contracts`, not here — this array only bounds which values
 * may exist at all.
 *
 * The wire-level enum shipped to the frontend belongs to `packages/contracts`
 * (technical-considerations §2.4). This array exists because the CHECK
 * constraint below needs the list *in SQL*; the two must be kept in step, and
 * the CHECK is what makes a drift fail loudly instead of silently.
 */
export const orderStatuses = [
  "created",
  "paid",
  "delivering",
  "delivered",
  "payment_failed",
  "out_of_stock",
  "delivery_failed",
] as const;

export type OrderStatus = (typeof orderStatuses)[number];

/** `'created', 'paid', ...` — the CHECK list, built from the array above so the two cannot drift. */
const orderStatusSqlList = sql.raw(orderStatuses.map((status) => `'${status}'`).join(", "));

/**
 * **Paid, and holding no key** — the four states the recovery list draws from,
 * and the predicate of the `orders_undelivered_idx` partial index below (spec
 * 003 technical-considerations §4 and §5).
 *
 * It is not a slice of anything `packages/contracts` already exports, which is
 * why it is written out rather than derived: it is the in-flight set *minus*
 * `created`, plus the recoverable pair. `created` is out because nobody has
 * paid yet; `delivered` and `payment_failed` are out because they are I9's
 * terminal pair. What is left is exactly the shop's unfinished business.
 *
 * **Wider than "stuck", deliberately** (technical-considerations §4, A5).
 * `paid` and `delivering` are in the list so an order whose worker died between
 * the claim and the outcome write is *visible* — the one class of stuck order
 * that is otherwise invisible, because no automatic trigger can reach it.
 * Whether such a row may be **retried** is a separate and narrower question,
 * answered by a status-guarded UPDATE, never by this list.
 *
 * ######################################################################
 * # ADDING A STATUS TO THIS ARRAY IS A MIGRATION, NOT AN EDIT.          #
 * ######################################################################
 *
 * This array is a partial index's predicate. Postgres never re-evaluates a
 * predicate against rows that were not in the index when they were written, so
 * widening the list here without rebuilding the index raises **nothing**: the
 * new status silently stops appearing in the operator's list. The failure mode
 * is an absence, not an error. See the index's own comment below, and
 * `0005_recovery_list_indexes`.
 *
 * The `satisfies` clause is the one tripwire this file can offer on its own: a
 * status that `orderStatuses` has never heard of fails to compile here, before
 * it can become an index predicate naming a value `orders_status_check` forbids.
 */
export const undeliveredOrderStatuses = [
  "paid",
  "delivering",
  "out_of_stock",
  "delivery_failed",
] as const satisfies readonly OrderStatus[];

/**
 * `'paid', 'delivering', ...` — the index predicate's list, built from the array
 * above.
 *
 * ######################################################################
 * # EXPORTED, AND THE RECOVERY-LIST QUERY MUST USE THIS VERY FRAGMENT.  #
 * ######################################################################
 *
 * `orders_undelivered_idx` below is partial on `status IN (<this list>)`, and
 * `UndeliveredOrdersService` (`apps/api/src/admin/undelivered-orders.service.ts`)
 * has to write the same list **as literals** in its `WHERE` clause — a bound
 * `= ANY($1)` is planned without the values, and Postgres cannot prove a value
 * it has not seen implies a partial index's predicate, so the plan degrades to
 * `Seq Scan on orders  Filter: (status = ANY ($1))` (spec 003
 * technical-considerations §4, "the bound-parameter trap"; the measurement is
 * in `0005_recovery_list_indexes`).
 *
 * The fragment is exported rather than re-derived at the call site so that the
 * predicate and the query are not two renderings of one array that could drift
 * — they are one string, built once, embedded twice. Re-deriving it in
 * `apps/api` would compile, would emit the identical text today, and would go
 * quietly wrong the day somebody changes the quoting or the separator in one of
 * the two places.
 *
 * Reusing one `SQL` object in several statements is safe: `sql.raw` holds a
 * single static chunk and binds nothing.
 */
export const undeliveredOrderStatusSqlList = sql.raw(
  undeliveredOrderStatuses.map((status) => `'${status}'`).join(", "),
);

/**
 * `products` — the supplied catalog (twelve items, loaded by the seed).
 *
 * `sku` UNIQUE is the shop's public handle for an item: `POST /api/orders`
 * takes a SKU, and the order records the SKU it was placed for.
 */
export const products = pgTable(
  "products",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    /** Catalog identity. UNIQUE — see `products_sku_key` below. */
    sku: text("sku").notNull(),
    /** Russian display name, verbatim from the supplied catalog (functional spec §2.8). */
    name: text("name").notNull(),
    /** Catalog category, e.g. `key`. Purchasable items are the `key` ones (§2.2). */
    type: text("type").notNull(),
    /** Integer minor units (kopecks). Never a float — technical-considerations §2.2, "Money". */
    priceMinor: integer("price_minor").notNull(),
    /** ISO 4217 code, `RUB` for the supplied catalog. */
    currency: text("currency").notNull(),
    /**
     * Image reference from the catalog. Nullable on purpose: the catalog is an
     * external input, and an item that arrives without an image must still be
     * listed rather than break the seed.
     */
    image: text("image"),
    /**
     * Whether the buy path is offered for this item. Defaults to false so a new
     * catalog row is display-only until someone says otherwise.
     */
    purchasable: boolean("purchasable").notNull().default(false),
  },
  (t) => [
    // `sku` UNIQUE (architecture §2, "Core tables").
    //   CREATE TABLE products (... CONSTRAINT products_sku_key UNIQUE (sku));
    // Not correctness-critical for a race — it is the catalog's identity, and
    // what makes the seed re-runnable via ON CONFLICT (sku) DO UPDATE.
    unique("products_sku_key").on(t.sku),

    // Money is unsigned minor units. This is our own data, written by the seed,
    // so rejecting nonsense at the boundary is free.
    //   CHECK (price_minor >= 0)
    check("products_price_minor_nonnegative", sql`"price_minor" >= 0`),
  ],
);

/**
 * `orders` — one row per purchase attempt, and the state machine that carries it.
 *
 * `id` is a prefixed sortable string (`ord_` + ULID, technical-considerations
 * §2.2), so it reads like the assignment's `ord_00123` and sorts by creation
 * time. It is generated by the application, not by the database: the same id
 * has to be quotable in a webhook payload before the row is ever written (the
 * "webhook before order" scenario), and a sequence cannot do that.
 */
export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(),

    /**
     * I1 — one client request → one order.
     *
     * The `Idempotency-Key` header sent by the client on order creation.
     * Nullable in Phase 1 (nothing sends the header yet) and populated in
     * Phase 2; the constraint ships now because it is the constraint, not the
     * behaviour, that makes the guarantee. NULLs do not collide in a Postgres
     * unique index, so unkeyed Phase 1 orders coexist with it happily.
     */
    clientRequestId: text("client_request_id"),

    /**
     * The catalog SKU this order is for. Intentionally **not** a foreign key to
     * `products.sku`: an order is a historical record of what was bought, and
     * it must survive a catalog row being renamed or withdrawn. The amount is
     * copied for the same reason.
     */
    sku: text("sku").notNull(),

    /** Integer minor units, server-computed from the catalog at creation time. */
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),

    /**
     * I9 — final states are terminal.
     *
     * The column is `text` plus a CHECK rather than a Postgres enum, and Phase 3
     * is the migration that decision was made for. Widening a CHECK is ordinary
     * DDL inside the migration transaction — drop and re-add in one transaction,
     * one full scan, **no table rewrite** (measured: 3.6 ms on 20 000 rows,
     * `ACCESS EXCLUSIVE`). `ALTER TYPE ... ADD VALUE` cannot use the new label
     * in the same transaction that added it, which would forbid widening and
     * backfilling in one file.
     *
     * Terminality itself is enforced by the status-guarded UPDATEs (see the
     * table comment below), not by this list — the list only bounds which states
     * can exist at all.
     */
    status: text("status", { enum: orderStatuses }).notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // ---------------------------------------------------------------------
    // I1 — one client request → one order.
    //
    //   INSERT INTO orders (id, client_request_id, sku, amount_minor, currency, status)
    //   VALUES ($1, $2, $3, $4, $5, 'created')
    //   ON CONFLICT (client_request_id) DO NOTHING
    //   RETURNING *;
    //   -- 0 rows => another request won the race; read that order back and
    //   --           return it with 200 rather than creating a second order.
    //
    // The insert itself decides the winner; nobody reads first. Without this
    // index a double-click creates two orders and two charges.
    // (architecture.md §3, I1 and §3.1.)
    // ---------------------------------------------------------------------
    unique("orders_client_request_id_key").on(t.clientRequestId),

    // ---------------------------------------------------------------------
    // I9 — the set of states an order may be in.
    //
    //   CHECK (status IN ('created', 'paid', 'delivering', 'delivered',
    //                     'payment_failed', 'out_of_stock', 'delivery_failed'))
    //
    // `delivery_failed` was added by 0001_delivery_failed_status. This CHECK is
    // a tripwire, not decoration: without the migration, the first order the
    // shop tries to record as failed takes a `23514 check_violation` inside the
    // transaction that was recording it — a 500 on an already-broken order.
    //
    // Every transition is a status-guarded UPDATE naming its permitted source
    // states, which is what makes `delivered` and `payment_failed` terminal:
    //
    //   UPDATE orders SET status = $2, updated_at = now()
    //   WHERE id = $1 AND status = ANY($3)   -- permitted source states only
    //   RETURNING *;
    //   -- 0 rows => the order was not in a state this transition may leave
    //   --           from; the caller does nothing. A late webhook therefore
    //   --           cannot resurrect a completed order.
    // ---------------------------------------------------------------------
    check("orders_status_check", sql`"status" IN (${orderStatusSqlList})`),

    // Our own money column: unsigned minor units.
    //   CHECK (amount_minor >= 0)
    check("orders_amount_minor_nonnegative", sql`"amount_minor" >= 0`),

    // Index on `status` (technical-considerations §2.2). Serves the Phase 3
    // admin view — "paid but undelivered" — and the recovery sweeps.
    //   CREATE INDEX orders_status_idx ON orders (status);
    index("orders_status_idx").on(t.status),

    // ---------------------------------------------------------------------
    // THE RECOVERY LIST'S DRIVING SCAN — "paid, and holding no key".
    //
    //   CREATE INDEX orders_undelivered_idx ON orders (created_at)
    //     WHERE status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed');
    //
    // Added by 0005_recovery_list_indexes. It serves the outer relation of the
    // recovery-list query (spec 003 technical-considerations §4):
    //
    //   SELECT ... FROM orders o
    //    WHERE o.status IN ('paid', 'delivering', 'out_of_stock', 'delivery_failed')
    //      AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.order_id = o.id)
    //    ORDER BY paid_at ASC NULLS LAST, o.created_at ASC
    //    LIMIT 200;
    //   -- 0 rows => THERE IS NOTHING TO RECOVER. Not an error and not an empty
    //   --           screen: the operator is told so in words. It is the only
    //   --           zero-row case in this schema that is a complete answer
    //   --           rather than a signal that somebody else got there first.
    //
    // **THE STATUS LIST MUST BE WRITTEN AS LITERALS, NOT `= ANY($1)`** — the one
    // place this codebase's own bound-parameter convention must not be copied.
    // Measured: with the four values inlined the plan is
    // `Index Scan using orders_undelivered_idx`; with a bound array under a
    // generic plan it is `Seq Scan on orders  Filter: (status = ANY ($1))`.
    // Postgres cannot prove that a value it has not seen implies a partial
    // index's predicate. Custom planning saves it today because `client.ts`
    // forbids `.prepare()`, but that is a planner heuristic protecting the
    // query, not a property of the query.
    //
    // WHY A PARTIAL INDEX IS SOUND HERE — the same argument that licenses
    // `payment_events_unprocessed_order_idx` above. The predicate is stable in
    // the direction that matters: rows leave the set and never come back. An
    // order may move *inside* it (`out_of_stock → delivering` on a retry), but
    // the two ways out — `delivered` and `payment_failed` — are terminal by I9.
    // The index therefore holds exactly the shop's unfinished business and
    // shrinks as that business is finished. Measured at 72 kB against
    // `orders_status_idx`'s 552 kB on the same 20 000-order fixture.
    //
    // #################################################################
    // # CAVEAT — A LATER PHASE THAT ADDS ANOTHER UNDELIVERED STATUS    #
    // # MUST REBUILD THIS INDEX, AND THE FAILURE MODE IS NOT AN ERROR: #
    // # IT IS THE NEW STATUS SILENTLY FALLING OUT OF THE OPERATOR'S    #
    // # LIST.                                                          #
    // #################################################################
    //
    // Nothing raises. The query still runs, the index is still used, and the
    // orders in the new status are simply not in it — so they are not returned,
    // and the screen whose whole purpose is "nothing paid-for is invisible"
    // quietly stops being true. Widening `undeliveredOrderStatuses` above is
    // therefore a migration (drop and re-create this index), not an edit.
    // ---------------------------------------------------------------------
    index("orders_undelivered_idx")
      .on(t.createdAt)
      .where(sql`"status" IN (${undeliveredOrderStatusSqlList})`),
  ],
);

/**
 * `payment_events` — the durable webhook inbox, and the work queue that drains it.
 *
 * The endpoint's shape is receive → persist → acknowledge → process
 * (architecture §4): the row is written before anything is decided, so an event
 * is never lost to a crash between the `200` and the work.
 */
export const paymentEvents = pgTable(
  "payment_events",
  {
    /**
     * I2 — one payment event is applied once.
     *
     * The provider's own event id, used directly as the PRIMARY KEY. There is
     * no surrogate key here on purpose: the natural key *is* the deduplication
     * mechanism, and giving the table a second identity would let the same
     * event exist twice.
     *
     *   INSERT INTO payment_events (event_id, order_id, status, amount_minor, currency, payload)
     *   VALUES ($1, $2, $3, $4, $5, $6)
     *   ON CONFLICT (event_id) DO NOTHING
     *   RETURNING *;
     *   -- 1 row  => first sight of this event; process it.
     *   -- 0 rows => redelivery; acknowledge 200 and stop.
     *
     * Winning the insert is what "first sight" means. Without it a redelivered
     * webhook re-runs issuance. (architecture.md §3, I2 and §3.1.)
     */
    eventId: text("event_id").primaryKey(),

    /**
     * The order the provider says this event is about.
     *
     * ############################################################
     * # DELIBERATELY NOT A FOREIGN KEY. DO NOT "FIX" THIS.        #
     * ############################################################
     *
     * architecture.md §4, "Out-of-order tolerance": an event for an order that
     * does not exist yet is stored with `processed_at` NULL and drained later.
     * That omission is exactly what makes "webhook arrives before its order" a
     * **normal path** rather than an error.
     *
     * Add a REFERENCES clause here and the webhook endpoint starts returning
     * 500 for an event that arrived a few milliseconds early — which makes the
     * provider retry, which is the failure this design exists to avoid.
     *
     * The other child tables of `orders` (`deliveries`, `issuance_attempts`) DO
     * carry foreign keys, because those rows can only ever be written by code
     * that has already read the order. The contrast is the point: this one is
     * missing by decision, not by oversight.
     */
    orderId: text("order_id").notNull(),

    /**
     * The provider's verdict, `paid` or `failed` per the supplied contract.
     *
     * No CHECK constraint, on purpose. This column holds a value from a system
     * we do not control, and persist-before-process means an unrecognised
     * status must still be stored (and then ignored by the transition rules)
     * rather than rejected at the door with a 500 that triggers redelivery.
     */
    status: text("status").notNull(),

    /** Integer minor units, as reported by the provider. */
    amountMinor: integer("amount_minor").notNull(),
    currency: text("currency").notNull(),

    /**
     * The raw event body, kept verbatim so a disputed delivery can be audited
     * against what the provider actually sent. Typed `unknown` on the TypeScript
     * side: the database guarantees valid JSON, not a shape.
     */
    payload: jsonb("payload").notNull(),

    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),

    /**
     * NULL until the event has been applied to its order. NULL is therefore
     * both "pending work" and the queue itself — see the partial index below.
     */
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    // ---------------------------------------------------------------------
    // The inbox is the queue (architecture §4, "Work queue"). This partial
    // index is that queue's access path, and it is small by construction: it
    // holds only unprocessed events, so it stays a handful of rows however
    // many events the table accumulates.
    //
    //   CREATE INDEX payment_events_unprocessed_order_idx
    //     ON payment_events (order_id) WHERE processed_at IS NULL;
    //
    // Serves both drains:
    //
    //   -- targeted: order creation and the status poll drain that order's
    //   -- own pending events (an index scan on order_id)
    //   SELECT * FROM payment_events
    //   WHERE order_id = $1 AND processed_at IS NULL
    //   ORDER BY received_at
    //   FOR UPDATE SKIP LOCKED;
    //
    //   -- global: the admin sweep, matching the index predicate
    //   SELECT * FROM payment_events
    //   WHERE processed_at IS NULL
    //   ORDER BY received_at
    //   FOR UPDATE SKIP LOCKED
    //   LIMIT 1;
    //   -- 0 rows => nothing pending, or every pending row is already held by
    //   --           another worker. SKIP LOCKED is what lets several workers
    //   --           drain the same queue without one event reaching two of them.
    // ---------------------------------------------------------------------
    index("payment_events_unprocessed_order_idx")
      .on(t.orderId)
      .where(sql`"processed_at" IS NULL`),

    // ---------------------------------------------------------------------
    // `paid_at` — THE SINGLE LARGEST PERFORMANCE WIN IN PHASE 3, and the one
    // nobody goes looking for.
    //
    //   CREATE INDEX payment_events_paid_order_idx
    //     ON payment_events (order_id, received_at) WHERE status = 'paid';
    //
    // Added by 0005_recovery_list_indexes. It serves the correlated scalar the
    // recovery list derives "when was this paid for" from, once per listed
    // order (spec 003 technical-considerations §4 and §5):
    //
    //   SELECT min(pe.received_at) FROM payment_events pe
    //    WHERE pe.order_id = $1 AND pe.status = 'paid';
    //   -- NULL => paid with no `paid` event on file. The order is LISTED, not
    //   --         hidden: a missing event is a thing an operator must see.
    //   -- Plan: InitPlan -> Limit -> Index Only Scan using
    //   --       payment_events_paid_order_idx. `min()` over an indexed column
    //   --       is rewritten by the planner as "first row of an ordered scan",
    //   --       which is why `received_at` is the second index column and not
    //   --       merely along for the ride.
    //
    // WITHOUT IT: `Seq Scan on payment_events` once per listed order — 1 599
    // scans, 436 527 of the query's 443 383 buffers, and 1 723.8 ms of its
    // 1 723.8 ms. With it, 12.7 ms. Measured on the 20 000-order fixture; see
    // 0005's header for the full table.
    //
    // **The finding worth keeping**, because it is the counter-intuitive one:
    // the expensive part of that query was never the per-order-latest-attempt
    // problem everyone looks at. All three strategies for "the newest attempt
    // row per order" measured within 5 % of each other, because all three were
    // carrying this sequential scan. It was `paid_at`, and it is invisible
    // until you look at `Buffers` rather than at row counts.
    //
    // WHY PARTIAL, ON AN EVEN STRONGER PREDICATE than
    // `payment_events_unprocessed_order_idx` above: `processed_at IS NULL` is a
    // predicate rows leave (which is sound, and is why that index stays small);
    // `status = 'paid'` is one they can never leave, because
    // `payment_events.status` is written once by the INSERT that records the
    // event and is never UPDATEd anywhere in the codebase. Membership is fixed
    // at birth. The caveat attached to `orders_undelivered_idx` — a predicate
    // over a value that later changes meaning — cannot arise here.
    // ---------------------------------------------------------------------
    index("payment_events_paid_order_idx")
      .on(t.orderId, t.receivedAt)
      .where(sql`"status" = 'paid'`),
  ],
);

/**
 * `issuance_attempts` — one row per supplier call, and the ledger the Phase 3
 * retry policy reasons over.
 *
 * The distinction that matters is `failed` (definite: try the fallback supplier
 * with a **new** request id) versus `unknown` (a timeout: retry **the same**
 * supplier with **the same** request id, because the supplier may already have
 * issued a code — see I5). architecture §4, "Supplier retry policy".
 */
export const issuanceAttempts = pgTable(
  "issuance_attempts",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),

    /**
     * The identifier sent to the supplier, derived deterministically as
     * `req_{order_id}_{provider}_{attempt}` (technical-considerations §2.2).
     * Deterministic derivation is what makes a retry *naturally* reuse the same
     * id instead of depending on a caller to have remembered it.
     *
     * UNIQUE — see `issuance_attempts_request_id_key` below.
     */
    requestId: text("request_id").notNull(),

    /** FK to `orders.id`: an attempt only exists for an order we have already read. */
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),

    /** Which supplier was called: `a` in Phase 1, `b` added in Phase 3. */
    provider: text("provider").notNull(),

    /**
     * Which attempt this is **for this order** — counting from 1 across every
     * provider, not per provider.
     *
     * That distinction is the whole reason the column is here rather than being
     * read back out of `request_id`. `req_x_a_3` and `req_x_b_3` are two ids
     * both claiming to be attempt 3 of order `x`; only one of them can be, and
     * `issuance_attempts_order_id_attempt_key` below is what refuses the second.
     *
     * The alternative to storing it is `split_part(request_id, '_', -1)::int` —
     * string surgery on a value whose other segments contain the same
     * delimiter, unindexable, and silently wrong the day the id shape changes
     * (spec 003 technical-considerations §3).
     *
     * **No DEFAULT, deliberately.** Migration 0002 adds the column
     * `NOT NULL DEFAULT 1` so the `ADD COLUMN` stays metadata-only, then drops
     * the default in the very next statement. Leaving it would be a
     * silent-reuse bug: a caller that forgot to compute the next attempt number
     * would write `1`, derive a `request_id` that already exists, hit
     * `ON CONFLICT DO NOTHING` and re-probe a settled attempt instead of making
     * a new one. Without the default that mistake is a
     * `23502 not_null_violation` at the first insert (§10, §11 R7).
     */
    attempt: integer("attempt").notNull(),

    /**
     * `unknown` | `ok` | `failed`, in that order of appearance: a row is written
     * as `unknown` *before* the call, so a process that dies mid-request leaves
     * evidence that an issuance may have happened. No CHECK constraint here —
     * the value set belongs to the Phase 3 retry policy, which owns this column
     * and should not have to alter a Phase 1 constraint to extend it.
     */
    status: text("status").notNull(),

    /**
     * How many times this one `request_id` has been **sent**, the first ask
     * included.
     *
     * A re-probe after a timeout deliberately does not create a second row — it
     * is the same question, to the same supplier, under the same id — so the
     * count lives in a column and the retry ladder bounds it with
     * `SUPPLIER_MAX_PROBES_PER_REQUEST` (spec 003 technical-considerations §1.2).
     *
     * It counts **asks, not answers**: it is incremented before the call, inside
     * the same short transaction that reads the ladder's inputs under the order
     * row lock and commits before the supplier is contacted — so the count that
     * bounds the loop is committed before the next pass reads it, and a process
     * killed mid-request still leaves a truthful count with no `catch` having
     * had to run. (An earlier version of this comment said "outside any
     * transaction"; the increment was moved into the silence transaction when
     * the probe rung landed, and the walkthrough for that slice records why.) Accepted cost — a worker that
     * dies before sending burns a probe; incrementing afterwards would lose the
     * count on exactly the failure the column exists to count.
     *
     * **No DEFAULT**, for the reason `attempt` has none: 0002 adds it
     * `NOT NULL DEFAULT 1` to stay rewrite-free and drops the default
     * immediately, so the number of asks is always a number somebody wrote on
     * purpose.
     */
    probeCount: integer("probe_count").notNull(),

    /** The issued code, present only once `status = 'ok'`. */
    code: text("code"),

    /** The supplier's reason on a definite failure; NULL on `ok` and on `unknown`. */
    lastError: text("last_error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // ---------------------------------------------------------------------
    // `request_id` UNIQUE (technical-considerations §2.2).
    //
    //   CREATE TABLE issuance_attempts (
    //     ... CONSTRAINT issuance_attempts_request_id_key UNIQUE (request_id));
    //
    // The shop's half of I5. Request ids are derived, not random, so a retry of
    // attempt 2 computes the same `req_{order}_{provider}_2` it used before;
    // this index guarantees that recording that retry updates one row rather
    // than accumulating a second history for the same supplier call:
    //
    //   INSERT INTO issuance_attempts
    //     (request_id, order_id, provider, attempt, status, probe_count)
    //   VALUES ($1, $2, $3, $4, 'unknown', $5)
    //   ON CONFLICT (request_id) DO NOTHING
    //   RETURNING *;
    //   -- 0 rows => this request_id is already on file. The row is NOT
    //   --           rewritten: on the re-probe path it may already say `ok`,
    //   --           and resetting it to `unknown` would erase the one fact
    //   --           worth having. The caller reads the existing row back.
    //   -- $4 is the attempt number the ladder computed. It is passed, never
    //   --           defaulted — see the column comment above.
    // ---------------------------------------------------------------------
    unique("issuance_attempts_request_id_key").on(t.requestId),

    // ---------------------------------------------------------------------
    // `attempt` IS NUMBERED PER ORDER — one attempt number, one row.
    //
    //   ALTER TABLE issuance_attempts
    //     ADD CONSTRAINT issuance_attempts_order_id_attempt_key
    //     UNIQUE (order_id, attempt);
    //
    // TWO COLUMNS, NOT THREE. `(order_id, provider, attempt)` would permit
    // `(x, a, 3)` and `(x, b, 3)` — two rows both claiming to be attempt 3 of
    // order x — and the ladder's `max(attempt) + 1` would then hand the same
    // number out twice.
    //
    // `issuance_attempts_request_id_key` above does NOT cover this. It catches
    // two rows carrying the same request id *string*; this one catches a stored
    // `attempt` that has drifted from the string it appears in. That is the
    // shape of R7: a retry that numbers attempts per provider recomputes
    // `req_x_a_1` — an id that was settled long ago — and `ON CONFLICT DO
    // NOTHING` swallows it in silence, leaving an order that can never be
    // re-issued. With this constraint the drift is instead
    //
    //     23505 unique_violation  "issuance_attempts_order_id_attempt_key"
    //
    // raised by the INSERT that reserves the attempt, before any supplier is
    // called.
    //
    // It is also the ladder's access path, and it replaces
    // `issuance_attempts_order_id_idx` — `order_id` leads, so the FK-shaped
    // lookup keeps an index. Migration 0002 drops the old one, after adding
    // this one:
    //
    //   SELECT id, request_id, order_id, provider, attempt, status,
    //          probe_count, code, last_error, created_at
    //   FROM issuance_attempts WHERE order_id = $1 ORDER BY attempt DESC;
    //   -- Index Scan Backward using issuance_attempts_order_id_attempt_key,
    //   -- no Sort node.
    //   -- 0 rows => this order was never offered to a supplier. NOT a failure:
    //   --           the recovery list renders it as "not yet attempted".
    //   -- Read INSIDE the order row lock (I4): outside it these rows are a
    //   -- snapshot another worker is free to extend between this SELECT and
    //   -- the rung computed from it.
    //
    // `ORDER BY attempt`, not `created_at`: `created_at` defaults to `now()`,
    // which is transaction-start time and therefore ties for two rows written
    // in one transaction. This UNIQUE is what makes `attempt` a total order
    // with no ties.
    // (spec 003 technical-considerations §3, §5 and §11 R7.)
    // ---------------------------------------------------------------------
    unique("issuance_attempts_order_id_attempt_key").on(t.orderId, t.attempt),

    // ---------------------------------------------------------------------
    // `deriveIssuanceRequestId` already refuses a zero, a float or a NaN before
    // it will build an id. These two mirror that guard at the layer that still
    // holds when TypeScript is bypassed — a seed, a psql session, a future
    // service in another language.
    //
    //   CHECK (attempt >= 1)
    //   CHECK (probe_count >= 1)
    //
    // Attempt 0 reads as "no attempt" to anyone looking at a log line; a
    // probe_count of 0 would claim a row exists for a request nobody sent, when
    // the row is written precisely because one is about to be.
    //
    // No CHECK on `provider` or on `status`, on purpose: those value sets
    // belong to the retry policy, which should not have to alter a constraint
    // in order to extend itself (technical-considerations §3, "Rejected").
    // ---------------------------------------------------------------------
    check("issuance_attempts_attempt_positive", sql`"attempt" >= 1`),
    check("issuance_attempts_probe_count_positive", sql`"probe_count" >= 1`),
  ],
);

/**
 * `deliveries` — the issued key bound to an order. One row here is the shop's
 * definition of "this shopper has been given a key".
 */
export const deliveries = pgTable(
  "deliveries",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),

    /**
     * I3 — one order → at most one delivery. UNIQUE; also a FK to `orders.id`,
     * since a delivery is only ever written by code that has already locked and
     * read the order.
     */
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),

    /** The key handed to the shopper. */
    code: text("code").notNull(),

    /** Which supplier issued it. */
    provider: text("provider").notNull(),

    /**
     * I3 — the supplier request this code came from. UNIQUE, so the same
     * supplier request cannot end up bound to two different orders even if the
     * issuance path is re-entered with a stale request id.
     */
    requestId: text("request_id").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // ---------------------------------------------------------------------
    // I3 — one order → at most one delivery.
    //
    //   INSERT INTO deliveries (order_id, code, provider, request_id)
    //   VALUES ($1, $2, $3, $4)
    //   ON CONFLICT (order_id) DO NOTHING
    //   RETURNING *;
    //   -- 0 rows => this order already has a delivery; the caller keeps the
    //   --           existing one and does NOT issue again.
    //
    // The constraint is the guarantee; the ON CONFLICT only keeps the loser
    // from raising. Without it, two concurrent workers both see "not delivered"
    // and both issue. (architecture.md §3, I3 and §3.1.)
    // ---------------------------------------------------------------------
    unique("deliveries_order_id_key").on(t.orderId),

    // I3, second half — one supplier request → one delivery row.
    //   CREATE TABLE deliveries (
    //     ... CONSTRAINT deliveries_request_id_key UNIQUE (request_id));
    // Pairs with `supplier_keys.claimed_by_request_id` UNIQUE on the supplier
    // side (I6): the request id is the thread that ties one claimed key to one
    // delivered order, and it is unique at both ends of it.
    unique("deliveries_request_id_key").on(t.requestId),
  ],
);

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
export type PaymentEvent = typeof paymentEvents.$inferSelect;
export type NewPaymentEvent = typeof paymentEvents.$inferInsert;
export type IssuanceAttempt = typeof issuanceAttempts.$inferSelect;
export type NewIssuanceAttempt = typeof issuanceAttempts.$inferInsert;
export type Delivery = typeof deliveries.$inferSelect;
export type NewDelivery = typeof deliveries.$inferInsert;
