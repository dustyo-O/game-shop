/**
 * **Every order that was paid for and is holding no key** — one statement, and
 * the whole of spec 003 §2.4's answer.
 *
 * ---------------------------------------------------------------------------
 * THE LIST IS A QUERY, NOT A QUEUE
 * ---------------------------------------------------------------------------
 * There is no recovery table, no fan-out on failure, no ordering to maintain
 * and nothing to go stale (technical-considerations §3, "Rejected"). The shop
 * already records everything the question needs — `orders.status`, the payment
 * inbox, the attempt ledger, `deliveries` — so the operator's list is derived
 * from those records every time it is asked. A queue would be a second copy of
 * facts that already exist, and the failure mode of a second copy is that it
 * disagrees with the first one precisely when somebody is relying on it.
 *
 * The price of that simplification is that the query reads the whole shop every
 * time, so it has to be cheap. `0005_recovery_list_indexes` is what makes it
 * cheap — measured 3 832 ms → 11.4 ms — and this file is the consumer those two
 * indexes were built for.
 *
 * ---------------------------------------------------------------------------
 * "PAID BUT UNDELIVERED" IS A WIDER SET THAN "STUCK", ON PURPOSE (A5)
 * ---------------------------------------------------------------------------
 * The status list is `paid`, `delivering`, `out_of_stock`, `delivery_failed` —
 * the in-flight set minus `created` (nobody has paid yet), plus the recoverable
 * pair. Two of those four belong to orders that are merely in flight and will
 * very likely deliver themselves in the next fifty milliseconds, and they are in
 * the list anyway.
 *
 * Narrowing to the retryable pair is the obvious "cleanup" and it would hide
 * **the one class of stuck order that is otherwise invisible**: an order whose
 * worker died between the claim and the outcome write. Nothing automatic can
 * reach such a row — it is not in the payment inbox any more, no continuation is
 * scheduled for it, and it reads `delivering` for ever — so if this list does
 * not show it, nothing does.
 *
 * Whether a listed order may be **retried** is a separate and narrower question,
 * and it is not answered here: slice 5 answers it with a status-guarded UPDATE
 * that matches zero rows or one. {@link UndeliveredOrder.retryable} is advisory.
 *
 * ###########################################################################
 * # THREE TRAPS IN THIS STATEMENT, EACH OF WHICH FAILS SILENTLY.
 * ###########################################################################
 *
 * Every one of them produces a plausible screen. None produces an error.
 *
 * The row counts quoted below are spec 003 technical-considerations §4's, taken
 * on its 20 000-order fixture and repeated here because each is the *symptom* of
 * a trap rather than a benchmark. The plan measurements further down are this
 * file's own.
 *
 * ### 1. `LEFT JOIN LATERAL … LIMIT 1`, and neither of its two neighbours
 *
 * The report needs *the newest attempt per order*, which is one row from a table
 * that holds many per order.
 *
 *   - A **plain `LEFT JOIN issuance_attempts`** multiplies the outer row:
 *     measured **3 198 rows for 1 599 orders**. The operator sees the same stuck
 *     order two or three times and presses retry on each.
 *   - **`CROSS JOIN LATERAL`** is the natural thing to write and silently
 *     **drops** every order with no attempt row: measured 1 599 → 1 596. Those
 *     three are orders that were paid for and never offered to a supplier at
 *     all — the most alarming rows on the screen, and the ones a `CROSS` makes
 *     invisible.
 *   - `DISTINCT ON (order_id)` computes the latest attempt for all 19 600 orders
 *     and throws 92 % of it away (437 690 buffers against 11 465).
 *
 * So: `LEFT`, so an order with no attempts survives; `LATERAL`, so the subquery
 * can correlate on `o.id`; `LIMIT 1`, so it cannot multiply the row.
 *
 * ### 2. `NOT EXISTS` on `deliveries` — not redundant with the status filter
 *
 * It reads redundant, since a delivered order is `delivered` and `delivered` is
 * not in the status list. It is not, because there is a **live path** that
 * leaves a delivered order reading `delivering`: `../issuance/issuance.service.ts`
 * binds the key and finishes the order in one transaction, and when the
 * `delivering → delivered` guard matches zero rows — another worker got there
 * first, and the order left `delivering` — the delivery row is committed while
 * the status is not the one this order ended on. That is the `Unresolved` report
 * *"a key is bound but the order did not reach delivered"*. §4 measured one such
 * row in its fixture, removed by this predicate; an order in exactly that state
 * was constructed by hand when this file was written and is likewise absent from
 * the report.
 *
 * Without it the operator is shown an order whose shopper is already holding
 * their key, and retrying it is the one action guaranteed to be pointless.
 *
 * ### 3. `ORDER BY ia.attempt DESC`, never `created_at DESC`
 *
 * `issuance_attempts.created_at` defaults to `now()`, which in Postgres is
 * **transaction-start time** — so two rows written in one transaction carry the
 * identical timestamp and the `LIMIT 1` picks between them arbitrarily, differing
 * between runs of the same query. `attempt` is a total order with no ties,
 * guaranteed by `UNIQUE (order_id, attempt)` — which is also the index this
 * lateral scans backwards.
 *
 * ###########################################################################
 * # AND THE FOURTH, WHICH IS THE ONE PLACE THIS CODEBASE'S OWN CONVENTION
 * # MUST NOT BE COPIED: THE STATUS LIST IS LITERALS, NOT `= ANY($1)`.
 * ###########################################################################
 *
 * Everywhere else in `apps/api` a status list is bound as one parameter —
 * `WHERE status = ANY($3)` in `OrderTransitionService`, `= ANY($2)` in
 * `OrderViewService.findOrder` — so that a statement's text stays stable across
 * `from`-lists of different lengths. Here it would cost the index.
 *
 * Measured when this file was written, this project's Postgres 16.11 container,
 * `EXPLAIN (ANALYZE, BUFFERS)` inside a rolled-back transaction against a
 * 20 000-order / 18 334-delivery / 24 000-event fixture leaving 1 666
 * paid-but-undelivered — this statement verbatim, then the same statement with
 * only the status list replaced by `= ANY($3)` and run under
 * `SET plan_cache_mode = force_generic_plan`:
 *
 *     literals:
 *       ->  Index Scan using orders_undelivered_idx on orders
 *               (cost=0.28..190.27 rows=1666) (actual rows=1666)
 *           -- no Index Cond, no Filter
 *
 *     = ANY($3), generic plan:
 *       ->  Seq Scan on orders  (cost=0.00..900.00 rows=19980) (actual rows=1666)
 *             Filter: (status = ANY ($3))
 *             Rows Removed by Filter: 18334
 *
 * **The absent `Filter` on the first plan is the proof**, not the timings: the
 * planner proved the partial index's predicate implies the `WHERE` clause and
 * dropped the status test altogether. The second plan reads all 20 000 rows and
 * throws 18 334 of them away. Node cost 190 against 900, and the top-level plan
 * cost 3 236 against 29 799.
 *
 * `orders_undelivered_idx` is **partial** on `status IN (…)`, and Postgres can
 * only use a partial index if it can prove the query's predicate implies the
 * index's. It cannot prove that about a value it has not been shown, which is
 * exactly what a generic plan withholds. Custom planning saves it today because
 * `packages/db/src/client.ts` forbids `.prepare()` — but that is a planner
 * heuristic protecting the query, not a property of the query, and the
 * difference between those two is a 500× regression nobody gets an error about.
 *
 * The list is not retyped here either: {@link undeliveredOrderStatusSqlList} is
 * the very fragment `packages/db` builds the index predicate from, exported so
 * the two are one string rather than two renderings of one array.
 *
 * ---------------------------------------------------------------------------
 * NO TIME PREDICATE. NONE. §2.4'S SECOND CRITERION RULES IT OUT.
 * ---------------------------------------------------------------------------
 * `AND o.created_at < now() - interval '5 minutes'` is the obvious thing to add
 * — it would hide the orders that are merely in flight and make the screen
 * calmer. The spec forbids it: an order must appear **immediately**, with no
 * waiting period, because the operator's question is *"what has been paid for
 * and is not delivered right now"* and a grace window answers a different one.
 * A calm screen that is five minutes behind is worse than a busy screen that is
 * true.
 */
import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import {
  PaymentEventStatus,
  isOrderStatus,
  isRecoverableOrderStatus,
} from "@game-shop/contracts";
import {
  deliveries,
  issuanceAttempts,
  orders,
  paymentEvents,
  products,
  undeliveredOrderStatusSqlList,
  type DatabaseClient,
} from "@game-shop/db";

import { DATABASE_CLIENT } from "../database/database.module.js";
import { IssuanceAttemptStatus } from "../issuance/issuance-attempt-status.js";
import type {
  UndeliveredOrder,
  UndeliveredOrderAttempt,
  UndeliveredOrdersReport,
} from "./undelivered-orders.types.js";

/**
 * The most orders one report will show — **Assumption A7**: a shop with more
 * than 200 orders paid for and holding no key has a different problem, and the
 * useful response to that problem is not a longer list.
 *
 * A bound on rows rather than on time, for `PaymentEventSweepReport`'s reason:
 * a deadline would end the report somewhere different on every call depending
 * on how busy the database happened to be, and an operator's evidence must be
 * reproducible.
 */
const MAX_ORDERS_PER_REPORT = 200;

/**
 * One row more than the report will show.
 *
 * **The single deviation from technical-considerations §4's `LIMIT 200`, and it
 * buys an honest word.** With a flat `LIMIT 200`, `truncated` could only be
 * `rows.length === 200`, which is *"there might be more"* — and it is wrong
 * exactly when the shop has precisely 200 such orders, telling an operator to
 * go looking for a 201st that does not exist. Fetching one extra row and
 * discarding it makes `truncated` mean what the screen says it means: *"this
 * list is capped and there are more orders than are shown"*.
 *
 * The extra row changes no plan node and no predicate — it is one more index
 * entry read from a scan that had already stopped at 200.
 */
const REPORT_PROBE_LIMIT = MAX_ORDERS_PER_REPORT + 1;

/**
 * `'paid'`, rendered as a literal rather than bound.
 *
 * Same argument as the status list above, applied to the *other* partial index
 * this statement depends on: `payment_events_paid_order_idx` is partial on
 * `status = 'paid'`, and it is the index that turned 1 723.8 ms into 12.7 ms by
 * replacing a sequential scan of `payment_events` **once per listed order**
 * (436 527 buffers) with `InitPlan → Limit → Index Only Scan`. A bound `$n`
 * here is the same wager on the planner's custom-plan heuristic that the status
 * list is, on the larger of the two prizes.
 *
 * Built from `PaymentEventStatus.Paid` rather than typed as a string, so the
 * shop's reading of the provider's word stays owned by `@game-shop/contracts`.
 */
const paidEventStatusSqlLiteral = sql.raw(`'${PaymentEventStatus.Paid}'`);

/**
 * One row of the statement, still in the schema's camelCase and still with raw
 * column types — the same arrangement `OrdersService`'s `OrderViewRow` has.
 *
 * The six `last*` fields are all `null` together or all present together: they
 * come from one `LEFT JOIN LATERAL` that returns at most one row, so `null`
 * across the set means **this order has never been offered to a supplier**. Not
 * a failure, not a missing row, and — per trap 1 above — a row that must survive
 * to the screen rather than being joined away.
 */
interface UndeliveredOrderRow {
  readonly id: string;
  readonly sku: string;
  readonly productName: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly paidAt: Date | null;
  readonly lastProvider: string | null;
  readonly lastAttempt: number | null;
  readonly lastAttemptStatus: string | null;
  readonly lastProbeCount: number | null;
  readonly lastAttemptError: string | null;
  readonly lastRequestId: string | null;
}

@Injectable()
export class UndeliveredOrdersService {
  constructor(@Inject(DATABASE_CLIENT) private readonly database: DatabaseClient) {}

  /**
   * Run the report.
   *
   * Emitted SQL (copied from `.toSQL()`; per the project's raw-SQL rule,
   * `architecture.md` §2, "Documentation convention" — line breaks added, text
   * otherwise verbatim):
   *
   *   select "orders"."id", "orders"."sku", "products"."name",
   *          "orders"."amount_minor", "orders"."currency", "orders"."status",
   *          "orders"."created_at",
   *          (select min("payment_events"."received_at") from "payment_events"
   *            where "payment_events"."order_id" = "orders"."id"
   *              and "payment_events"."status" = 'paid') as "paid_at",
   *          "a"."provider", "a"."attempt", "a"."status", "a"."probe_count",
   *          "a"."last_error", "a"."request_id"
   *   from "orders"
   *   left join "products" on "products"."sku" = "orders"."sku"
   *   left join lateral (
   *     select "provider", "attempt", "status", "probe_count", "last_error",
   *            "request_id"
   *     from "issuance_attempts"
   *     where "issuance_attempts"."order_id" = "orders"."id"
   *     order by "issuance_attempts"."attempt" desc
   *     limit $1
   *   ) "a" on true
   *   where ("orders"."status" in ('paid', 'delivering', 'out_of_stock', 'delivery_failed')
   *          and not exists (select 1 from "deliveries"
   *                           where "deliveries"."order_id" = "orders"."id"))
   *   order by "paid_at" asc nulls last, "orders"."created_at" asc
   *   limit $2;
   *   -- $1 = 1   (the lateral's LIMIT; a bound LIMIT is not a predicate and
   *   --           hides nothing from a partial index)
   *   -- $2 = 201 (200 shown + the truncation probe; see REPORT_PROBE_LIMIT)
   *   -- THE STATUS LIST AND 'paid' ARE LITERALS, NOT PARAMETERS. That is the
   *   --           one deliberate departure from this codebase's bound-list
   *   --           convention, and the header says why.
   *   -- 0 rows => THERE IS NOTHING TO RECOVER. Not an error and not an empty
   *   --           screen: §2.4 requires the operator be told so in words, which
   *   --           is what `message` is for. The only zero-row case in this
   *   --           project that is a complete answer rather than a signal that
   *   --           somebody else got there first.
   *   -- paid_at NULL      => paid with no `paid` event on file. LISTED, not
   *   --           hidden.
   *   -- every "a".* NULL  => never offered to a supplier. "Not yet attempted",
   *   --           not a failure — and the row a CROSS JOIN LATERAL would drop.
   *   -- "a"."status" = 'unknown' => THE OUTCOME WAS NEVER ESTABLISHED (§2.2's
   *   --           fourth criterion). MUST NOT render as "failed": a key may
   *   --           exist under "a"."request_id", and only re-probing that id can
   *   --           say. Surfaced as `outstanding_request_id`.
   *
   * Plan on the 20 000-order fixture (`EXPLAIN (ANALYZE, BUFFERS)`, this
   * project's Postgres 16.11 container, whole run rolled back), the three nodes
   * worth reading:
   *
   *   ->  Index Scan using orders_undelivered_idx on orders
   *         (actual rows=1666)                  -- no Index Cond, and NO FILTER
   *   ->  Index Scan Backward using issuance_attempts_order_id_attempt_key
   *         Index Cond: (order_id = orders.id)  -- the lateral, loops=1666
   *   InitPlan 1 -> Limit -> Index Only Scan using payment_events_paid_order_idx
   *         Index Cond: ((order_id = orders.id) AND (received_at IS NOT NULL))
   *
   *   Execution Time: 11.171 ms
   *
   * **The absent `Filter` on that first node is the proof the partial index is
   * doing its job**: the planner proved the index predicate implies the WHERE
   * clause and dropped the status test altogether. A `Filter: (status = ANY …)`
   * there would mean exactly the opposite — see the header.
   *
   * The lateral on that run reported `(actual rows=0 loops=1666)` — every
   * undelivered order in the fixture had no attempt row — and the statement
   * still returned all 1 666 of them. That is trap 1 in one line: `CROSS JOIN
   * LATERAL` would have returned nothing at all.
   *
   * ### What is deliberately *not* selected
   *
   * `deliveries.code` and `issuance_attempts.code`. The report carries no
   * delivered key, ever, and the first of the two stops is here — a key that is
   * never sent from Postgres to this process cannot reach a log line, a stack
   * trace, an error reporter or a response by any route at all. `deliveries`
   * appears in this statement only inside `NOT EXISTS (SELECT 1 …)`, which reads
   * no column of it. Same gating-in-SQL `OrderViewService.findOrder` does with its
   * `CASE WHEN status = 'delivered'`, and for the same reason: filtering after
   * the fact leaves the key in a local variable that something downstream might
   * one day serialise.
   *
   * ### No transaction
   *
   * One statement is one snapshot, so the report is internally consistent
   * without one — `orders.status`, `deliveries` and the ledger cannot disagree
   * inside it. Opening a transaction would also hold this instance's single
   * pooled connection (`max: 1`) across the mapping below for no benefit.
   *
   * The report is a **snapshot, not a lease**. By the time it reaches the
   * screen, an order listed as `delivering` may already be `delivered`. That is
   * correct and is why nothing here claims otherwise: the authority on whether a
   * retry runs is slice 5's guarded UPDATE, not this list.
   */
  async listUndelivered(): Promise<UndeliveredOrdersReport> {
    // The lateral: the newest attempt for this order, and at most one of them.
    // Built as a named subquery so `leftJoinLateral` can place it in the FROM
    // clause with `ON true` — see trap 1 for why every word of this is load
    // bearing. `probe_count` is the one column §4's block does not list; §8's
    // blockquote pins it onto the wire, and adding it to the projection of a
    // subquery that already returns exactly one row changes no plan node.
    const newestAttempt = this.database.db
      .select({
        provider: issuanceAttempts.provider,
        attempt: issuanceAttempts.attempt,
        status: issuanceAttempts.status,
        probeCount: issuanceAttempts.probeCount,
        lastError: issuanceAttempts.lastError,
        requestId: issuanceAttempts.requestId,
      })
      .from(issuanceAttempts)
      .where(eq(issuanceAttempts.orderId, orders.id))
      // Trap 3: `attempt`, never `created_at`. `UNIQUE (order_id, attempt)` is
      // what makes this a total order, and it is the index scanned backwards.
      .orderBy(desc(issuanceAttempts.attempt))
      .limit(1)
      .as("a");

    const rows: readonly UndeliveredOrderRow[] = await this.database.db
      .select({
        id: orders.id,
        sku: orders.sku,
        productName: products.name,
        amountMinor: orders.amountMinor,
        currency: orders.currency,
        status: orders.status,
        createdAt: orders.createdAt,
        // The shop has no `orders.paid_at` column, deliberately: writing one
        // would need a `CASE` inside the single generic status-guarded UPDATE
        // every transition shares, and that statement's whole value is that it
        // is data rather than a special case per transition. The fact is
        // derived from the payment inbox instead — and this correlated
        // subquery, not the per-order-latest-row problem everyone looks at, was
        // the expensive part of this query before
        // `payment_events_paid_order_idx` existed.
        //
        // `.mapWith(paymentEvents.receivedAt)` is not decoration. Drizzle's
        // node-postgres driver **overrides pg's own timestamp parsers** so that
        // every date arrives as a raw Postgres string and each column's
        // `mapFromDriverValue` decodes it — which means a bare `sql<Date>`
        // fragment is a lie the compiler cannot catch: it type-checks, and
        // `paid_at` arrives as `'2026-09-11 13:49:00.12+00'`, whose
        // `.toISOString` is not a function. Measured here as a `500` on the
        // first row with a `paid` event. Naming the column this value comes
        // from borrows exactly the decoder that column would have used.
        paidAt: sql<Date | null>`(select min(${paymentEvents.receivedAt}) from ${paymentEvents} where ${paymentEvents.orderId} = ${orders.id} and ${paymentEvents.status} = ${paidEventStatusSqlLiteral})`
          .mapWith(paymentEvents.receivedAt)
          .as("paid_at"),
        lastProvider: newestAttempt.provider,
        lastAttempt: newestAttempt.attempt,
        lastAttemptStatus: newestAttempt.status,
        lastProbeCount: newestAttempt.probeCount,
        lastAttemptError: newestAttempt.lastError,
        lastRequestId: newestAttempt.requestId,
      })
      .from(orders)
      // LEFT, not INNER: an order outlives its catalogue row, and a withdrawn
      // product must not remove a paid order from the operator's list.
      .leftJoin(products, eq(products.sku, orders.sku))
      // Trap 1. LEFT, so an order with no attempt row survives; LATERAL, so the
      // subquery correlates on `orders.id`; LIMIT 1, so it cannot multiply.
      .leftJoinLateral(newestAttempt, sql`true`)
      .where(
        and(
          // Trap 4. Literals, from the same fragment the partial index's
          // predicate is built from. Never `= ANY($1)`.
          sql`${orders.status} in (${undeliveredOrderStatusSqlList})`,
          // Trap 2. Not redundant with the status filter — see the header.
          sql`not exists (select 1 from ${deliveries} where ${deliveries.orderId} = ${orders.id})`,
        ),
      )
      // Oldest payment first, because the order that has been waiting longest is
      // the one an operator should reach first. `NULLS LAST` puts the orders
      // with no `paid` event at the end rather than at the front, where
      // Postgres's default for ASC would otherwise put NULLs — they are unusual
      // rather than urgent, and burying the genuinely oldest purchase under them
      // would defeat the ordering. `created_at` breaks ties, and is itself
      // unique enough in practice to make the list stable between refreshes.
      .orderBy(sql`${sql.identifier("paid_at")} asc nulls last`, asc(orders.createdAt))
      .limit(REPORT_PROBE_LIMIT);

    const truncated = rows.length > MAX_ORDERS_PER_REPORT;
    const listed = truncated ? rows.slice(0, MAX_ORDERS_PER_REPORT) : rows;
    const reportOrders = listed.map((row) => toUndeliveredOrder(row));

    return {
      count: reportOrders.length,
      truncated,
      message: describeReport(reportOrders.length, truncated),
      orders: reportOrders,
    };
  }
}

/**
 * Row → wire body.
 *
 * The one piece of judgement here is {@link UndeliveredOrder.outstanding_request_id},
 * and it rests on a property of the ladder rather than on a property of this
 * query — see {@link readOutstandingRequestId}.
 */
function toUndeliveredOrder(row: UndeliveredOrderRow): UndeliveredOrder {
  const attempt = toAttempt(row);

  return {
    order_id: row.id,
    sku: row.sku,
    product_name: row.productName,
    amount_minor: row.amountMinor,
    currency: row.currency,
    status: row.status,
    created_at: row.createdAt.toISOString(),
    paid_at: row.paidAt === null ? null : row.paidAt.toISOString(),
    // `isOrderStatus` narrows a `text` column to the seven strings
    // `orders_status_check` admits. An eighth would be a shop that has outgrown
    // this build; it is reported as not retryable rather than crashing the
    // operator's only screen, because the authority on retryability is slice
    // 5's guarded UPDATE and this field is advisory.
    retryable: isOrderStatus(row.status) && isRecoverableOrderStatus(row.status),
    outstanding_request_id: readOutstandingRequestId(row),
    last_error: row.lastAttemptError,
    attempts: attempt === undefined ? [] : [attempt],
  };
}

/**
 * The newest attempt, as the report carries it — or `undefined` when the lateral
 * matched nothing.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LIST HOLDS THE NEWEST ATTEMPT AND NOT THE WHOLE HISTORY
 * ---------------------------------------------------------------------------
 * `attempts` is an array because the consumer's shape says so and because the
 * empty case has to be expressible — *"paid, and never offered to a supplier"*
 * is a row on this screen. It carries one entry rather than N because §4's
 * statement returns one: the whole history would need either a second round trip
 * keyed on 200 order ids, or a join that multiplies the outer row, which is trap
 * 1 with extra steps.
 *
 * Nothing is hidden by that: `attempt` is the attempt *number*, so a single
 * entry reading `{ provider: "b", attempt: 2 }` says on its face that there was
 * an attempt 1 and that it was not this supplier. An operator who needs the full
 * ledger is looking at one order by then, and `psql` is the right tool for it.
 */
function toAttempt(row: UndeliveredOrderRow): UndeliveredOrderAttempt | undefined {
  // The six `last*` fields come from one lateral row, so they are null together.
  // `provider` is tested because it is the one of the six that is `NOT NULL` in
  // the table — `last_error` is legitimately null on a row that exists, and
  // testing that one would drop every `ok` and every `unknown` attempt.
  if (
    row.lastProvider === null ||
    row.lastAttempt === null ||
    row.lastAttemptStatus === null ||
    row.lastProbeCount === null
  ) {
    return undefined;
  }

  return {
    provider: row.lastProvider,
    attempt: row.lastAttempt,
    // Verbatim, never coerced into one of the three words the ladder writes
    // today. The column has no CHECK, so a fourth is the retry policy's to add.
    status: row.lastAttemptStatus,
    probe_count: row.lastProbeCount,
    last_error: row.lastAttemptError,
  };
}

/**
 * `request_id` if the newest attempt is still `unknown`; `null` otherwise.
 *
 * ###########################################################################
 * # THIS READS THE NEWEST ATTEMPT, AND §8 ASKS FOR "THE NEWEST ATTEMPT WHOSE
 * # STATUS IS `unknown`". THEY ARE THE SAME ROW, AND THE REASON IS THE LADDER.
 * ###########################################################################
 *
 * `settleNeverEstablished` outranks `fallThrough` in the decision order
 * (`../issuance/issuance-ladder.ts`), which is the hard rule spec 003 §2.2 turns
 * on: **never ask another supplier while any attempt for this order is
 * `unknown`.** So no attempt row is ever written *after* an `unknown` one while
 * it is still `unknown` — an outstanding attempt blocks the creation of the
 * next. An `unknown` row is therefore always the highest `attempt` for its
 * order, and "the newest `unknown`" and "the newest, if it is `unknown`" cannot
 * disagree.
 *
 * That is a real dependency on another module's policy and it is stated rather
 * than assumed. If the ladder were ever changed to fall through past an
 * outstanding attempt, this field would start reading `null` on exactly the
 * orders it exists for — and the accounting assertion that catches that change
 * is `count(*) FROM supplier_keys WHERE claimed_by_request_id IS NOT NULL`
 * against `count(*) FROM deliveries` (spec 003 R2), not anything on this screen.
 */
function readOutstandingRequestId(row: UndeliveredOrderRow): string | null {
  return row.lastAttemptStatus === IssuanceAttemptStatus.Unknown ? row.lastRequestId : null;
}

/**
 * The report's own sentence about itself — §2.4's fifth criterion.
 *
 * In words, always, and in English to match the operator page's own strings
 * (`apps/web/src/pages/admin-recovery/ui/admin-recovery-page.ts`). The empty
 * case is the one that matters: *"there is nothing to recover"* has to be said
 * out loud, because a blank list and a broken page look identical to the person
 * who opened this screen during an incident — and the page prefers this sentence
 * to its own fallback precisely so the API can say something more specific than
 * "empty" when it knows something more specific.
 */
function describeReport(count: number, truncated: boolean): string {
  if (count === 0) {
    return "Nothing to recover: every paid order is holding a key.";
  }

  if (truncated) {
    return `Showing the ${String(count)} longest-waiting orders that were paid for and are holding no key. There are more than ${String(count)} — recover these, then refresh.`;
  }

  return count === 1
    ? "1 order was paid for and is holding no key."
    : `${String(count)} orders were paid for and are holding no key.`;
}
