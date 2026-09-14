/**
 * Reading an order back — the read the status page lives on, and the one
 * `orders` reader other modules may import ("read order state",
 * technical-considerations §2.4; spec 005 §2.2–2.3).
 *
 * Until spec 005 this was `OrdersService.findOrder`, beside `createOrder` in
 * one class, and nothing outside the module could call it. The promo endpoint
 * changed that: `POST /api/orders/:orderId/promo` answers with the bare
 * {@link OrderView} — the same body `GET /api/orders/:id` sends — and it lives
 * in `PromoModule`, so *some* reader had to leave `OrdersModule`. The choice
 * was between exporting `OrdersService` whole and extracting the read; the
 * read was extracted. `./orders.module.ts`'s header carries the reason in the
 * paragraph about its export list, and it is one sentence long: `OrdersService`
 * also creates orders, behind the client-supplied-id affordance, and creating
 * an order is not a favour other modules ask for.
 *
 * ---------------------------------------------------------------------------
 * THIS READS AFTER COMMIT, ON THE POOLED HANDLE, BY DESIGN
 * ---------------------------------------------------------------------------
 * {@link OrderViewService.findOrder} runs on `this.database.db` — the pooled
 * handle — and takes no `tx`. That is the opposite arrangement from
 * `./order-lock.service.ts` and `./order-repricing.service.ts`, whose
 * signatures *refuse* the pool, and it is just as deliberate:
 *
 *   - **It is the polled path.** `apps/web` calls this once a second per open
 *     order page. A read that could only run inside a transaction would open
 *     one per poll — `BEGIN` / `SELECT` / `COMMIT`, three round trips on the
 *     instance's only connection — to read a single committed row.
 *   - **It must not be called inside a transaction, and the pool is why.**
 *     `packages/db/src/client.ts` sets `max: 1` per instance, and a
 *     transaction checks that one connection out for its whole body. A caller
 *     that opens a transaction and then calls this method asks the pool for a
 *     *second* connection while holding the only one: it waits for itself,
 *     and after `CONNECTION_TIMEOUT_MS` (ten seconds) gets a timeout error
 *     that looks nothing like its cause. `OrderTransitionService.transition`
 *     documents the same self-deadlock for the same reason.
 *
 * So the promo controller's shape (technical-considerations §2.2, step 8 and
 * the paragraph after the table) is: run the redemption transaction to
 * `COMMIT`, *then* call this. Two consequences follow, both intended. The view
 * returned is the committed one — every other process can see the same row,
 * so the body the shopper receives is never a snapshot of writes that could
 * still roll back. And the transaction stays six statements long — three
 * reads that can refuse, three writes — with no view read inside it, which is
 * what keeps the order row lock — and the instance's one connection — held
 * for microseconds rather than for a round trip more.
 *
 * There is no `findOrderWithin(tx, …)`, and one should not be added for
 * convenience: a reader that accepts the transaction handle invites exactly
 * the read-inside-the-lock the paragraph above rules out.
 */
import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";

import { OrderStatus, inFlightOrderStatuses, minorUnits } from "@game-shop/contracts";
import {
  deliveries,
  orders,
  paymentEvents,
  products,
  promoCodes,
  promoRedemptions,
  type DatabaseClient,
} from "@game-shop/db";

import { DATABASE_CLIENT } from "../database/database.module.js";
import { toCurrency } from "./order-currency.js";
import { OrderPendingEventsNotifier } from "./order-pending-events-notifier.service.js";
import type { AppliedPromoView, OrderView } from "./orders.types.js";

/**
 * Which of the two things happened when an order was looked up. The same
 * named-outcome shape `CreateOrderOutcome` and `OrderTransitionService` use,
 * for the same reason: the caller's `switch` reads as news, and the compiler
 * has something to be exhaustive about.
 *
 * A missing order is **not** an exception here. `NotFoundException` is an HTTP
 * decision, and it belongs to the controller — leaving the service callable from
 * an integration test, or from the Phase 2 race scripts, without an HTTP layer's
 * opinions attached.
 */
export const FindOrderOutcome = {
  /** The order exists; {@link FindOrderResult.order} is the status page's whole view of it. */
  Found: "found",
  /** No row with that id. Functional spec §2.6's «не найден» page. */
  NotFound: "not_found",
} as const;

export type FindOrderOutcome = (typeof FindOrderOutcome)[keyof typeof FindOrderOutcome];

export type FindOrderResult =
  | {
      readonly outcome: typeof FindOrderOutcome.Found;
      readonly order: OrderView;
    }
  | {
      readonly outcome: typeof FindOrderOutcome.NotFound;
      /** Echoed back so the caller can name it without re-reading the route parameter. */
      readonly orderId: string;
    };

/**
 * One row as {@link OrderViewService.findOrder}'s query returns it — five
 * tables flattened into the ten values the status page needs, still in the
 * schema's camelCase and still with the raw column types.
 *
 * Five fields are nullable, for three entirely different reasons, and the
 * difference matters when reading the mapper below:
 *
 *   - `productName` — the LEFT JOIN found no catalogue row. Ordinary, and the
 *     page falls back to the SKU (see `OrderViewCore.product_name`).
 *   - `code` — either there is no delivery, or there is one and the order is not
 *     `delivered` so Postgres refused to hand it over. The `CASE` in the query
 *     is what makes those two indistinguishable here, on purpose.
 *   - `promoCode`, `promoDiscountMinor`, `promoListAmountMinor` — the LEFT JOIN
 *     to `promo_redemptions` found no ledger row, so no code has been applied.
 *     **All three or none**, never a mix: they come from one ledger row whose
 *     amount columns are NOT NULL and whose `promo_id` is NOT NULL with a
 *     foreign key to `promo_codes`, so a redemption row cannot exist without
 *     its code row or its two amounts. {@link toAppliedPromo} treats a mixed
 *     row as the invariant violation it would be, not as a fourth case.
 */
interface OrderViewRow {
  readonly id: string;
  readonly status: OrderStatus;
  readonly sku: string;
  readonly productName: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly code: string | null;
  readonly promoCode: string | null;
  readonly promoDiscountMinor: number | null;
  readonly promoListAmountMinor: number | null;
  /**
   * Processing trigger 3's gate: **this order can still move, and there is at
   * least one unapplied event naming it.** Both halves, in one expression — see
   * {@link OrderViewService.findOrder}.
   *
   * Deliberately on this interface and on **no** member of {@link OrderView}.
   * It is not a fact about the order the shopper is looking at; it is a fact
   * about an inbox they have never heard of, true a few milliseconds at a time,
   * and the moment it went on the wire some client would start branching on it.
   * {@link toOrderView} never sees it — the mapper takes this row and drops it,
   * which is the same arrangement `code` has one field up.
   */
  readonly hasPendingEvents: boolean;
}

/**
 * The three promo columns → `OrderViewCore.promo`, or `null` when the ledger
 * has no row for this order.
 *
 * Two cases, and a third that is an invariant rather than a branch. The LEFT
 * JOIN to `promo_redemptions` either found the order's one ledger row or it did
 * not. If it did, all three values are present: `discount_minor` and
 * `list_amount_minor` are NOT NULL on that row, and `promo_id` is NOT NULL with
 * a foreign key to `promo_codes.id`, so the second LEFT JOIN always finds the
 * code. If it did not, all three are NULL. A row with some of the three set and
 * others not therefore cannot come out of a database whose constraints hold —
 * it would mean a ledger row without its code, or a code without its amounts —
 * and that is worth a `500` and a stack trace, not a view that silently
 * publishes a discount without a code or a code without a discount. Same stance
 * as the `delivered`-without-a-key check in {@link toOrderView}.
 */
function toAppliedPromo(row: OrderViewRow): AppliedPromoView | null {
  const { promoCode, promoDiscountMinor, promoListAmountMinor } = row;

  if (promoCode === null && promoDiscountMinor === null && promoListAmountMinor === null) {
    return null;
  }

  if (promoCode === null || promoDiscountMinor === null || promoListAmountMinor === null) {
    throw new Error(
      `orders: order ${row.id} has a partial promo redemption (code=${String(promoCode)}, discount=${String(promoDiscountMinor)}, list=${String(promoListAmountMinor)})`,
    );
  }

  return {
    code: promoCode,
    // The same kopecks branding as `amount_minor` two lines up in the caller.
    discount_minor: minorUnits(promoDiscountMinor),
    list_amount_minor: minorUnits(promoListAmountMinor),
  };
}

/**
 * Row → wire body, and the one place the "a key only exists on a delivered
 * order" rule turns from SQL into a type.
 *
 * The two branches are the two members of {@link OrderView}. Note what each one
 * does with `code`:
 *
 *   - **`delivered`** — hands back `row.code`, and refuses to answer at all if
 *     it is `null`. That state is unreachable (`delivering → delivered` commits
 *     in the same transaction as the `deliveries` insert, so one `SELECT` sees
 *     both or neither), and if it ever happens the shop has a paid order whose
 *     key it cannot find — worth a `500` and a stack trace, not a `200` with a
 *     `code` field the type says is a string and the value says is `null`.
 *   - **anything else** — returns the literal `null`, never `row.code`. So even
 *     if the `CASE` in the query were one day edited away, this branch still
 *     cannot publish a key for an order that has not been delivered. Two
 *     independent stops on the same leak, which is the arrangement the project
 *     uses everywhere a guarantee matters.
 */
function toOrderView(row: OrderViewRow): OrderView {
  const core = {
    id: row.id,
    sku: row.sku,
    product_name: row.productName,
    // Brands the raw integer column as kopecks — same crossing as
    // `toCreatedOrder` in `./orders.service.ts` (`packages/contracts/src/money.ts`).
    amount_minor: minorUnits(row.amountMinor),
    currency: toCurrency(row.currency),
    promo: toAppliedPromo(row),
  };

  if (row.status === OrderStatus.Delivered) {
    if (row.code === null) {
      throw new Error(`orders: order ${row.id} is "delivered" but has no delivery row`);
    }

    return { ...core, status: row.status, code: row.code };
  }

  return { ...core, status: row.status, code: null };
}

@Injectable()
export class OrderViewService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    /**
     * Told when a status read finds unapplied events for an order that can
     * still move — see the end of {@link findOrder}. A publisher, never a
     * collaborator: this service cannot ask it a question, waits for nothing it
     * does, and behaves identically if nobody is subscribed
     * (`./order-pending-events-notifier.service.ts`).
     */
    private readonly pendingEvents: OrderPendingEventsNotifier,
  ) {}

  /**
   * The status page's whole view of one order — **one statement, always**.
   *
   * ---------------------------------------------------------------------------
   * THIS IS THE POLLED PATH
   * ---------------------------------------------------------------------------
   * `apps/web` calls this once a second per open order page while the order is
   * in flight (technical-considerations §2.6). So the cost of the read is the
   * cost of watching an order, and "fetch the order, then fetch its product,
   * then fetch its delivery" — three round trips that each look harmless — is
   * three times the traffic and three times the connection time, on the one
   * endpoint that runs in a loop. It is a single `SELECT` with four `LEFT
   * JOIN`s, and it stays one.
   *
   * Emitted SQL (copied from `.toSQL()`; per the project's raw-SQL rule,
   * `architecture.md` §2, "Documentation convention" — line breaks added, text
   * otherwise verbatim):
   *
   *   select "orders"."id", "orders"."status", "orders"."sku", "products"."name",
   *          "orders"."amount_minor", "orders"."currency",
   *          "promo_codes"."code", "promo_redemptions"."discount_minor",
   *          "promo_redemptions"."list_amount_minor",
   *          case when "orders"."status" = $1 then "deliveries"."code" end as "code",
   *          case when "orders"."status" = ANY($2) then exists (
   *            select 1 from "payment_events"
   *            where "payment_events"."order_id" = "orders"."id"
   *              and "payment_events"."processed_at" is null
   *          ) else false end as "has_pending_events"
   *   from "orders"
   *   left join "products" on "products"."sku" = "orders"."sku"
   *   left join "deliveries" on "deliveries"."order_id" = "orders"."id"
   *   left join "promo_redemptions" on "promo_redemptions"."order_id" = "orders"."id"
   *   left join "promo_codes" on "promo_codes"."id" = "promo_redemptions"."promo_id"
   *   where "orders"."id" = $3;
   *   -- $1 the literal 'delivered', $2 `inFlightOrderStatuses` as a text[],
   *   -- $3 the id from the URL.
   *   -- 1 row  => the order exists. `code` is the key, or NULL; the three
   *   --           promo columns are all set, or all NULL.
   *   -- 0 rows => no order with that id => 404 (functional spec §2.6).
   *
   * Five index lookups and nothing else, one per table: `orders.id` is the
   * primary key, `products.sku` is UNIQUE (`products_sku_key`),
   * `deliveries.order_id` is UNIQUE (`deliveries_order_id_key`, invariant I3),
   * `promo_redemptions.order_id` is the PRIMARY KEY (invariant I8, one code per
   * order), and `promo_codes.id` is the primary key the ledger's `promo_id`
   * points at. That is also why no `LIMIT` is needed to guarantee a single row
   * — no join can multiply it, because every join key is unique on the joined
   * side. The two promo joins are **1:0..1** in the strictest sense: an order
   * has at most one ledger row because `order_id` *is* that table's key, and a
   * ledger row has exactly one code because `promo_id` is NOT NULL with a
   * foreign key. The statement's single-row guarantee is load-bearing (the
   * `EXISTS` below relies on it), and a join key that was merely indexed rather
   * than unique would have broken it silently.
   *
   * ### Why `CASE WHEN status = 'delivered'` rather than an `if` in TypeScript
   *
   * Both would answer correctly. The difference is where the key is when the
   * decision is made: with the `CASE`, an undelivered order's key is never sent
   * from Postgres to this process, so it cannot reach a log line, a stack trace,
   * an error reporter or a response by any route at all. Filtering after the
   * fact leaves it sitting in a local variable that something downstream might
   * one day serialise.
   *
   * It is also read as one consistent snapshot. A single statement sees one
   * version of the database, so `orders.status` and `deliveries.code` cannot
   * disagree — whereas two separate reads could straddle the transaction that
   * commits the delivery and land on `delivered` with no key.
   *
   * ### LEFT, not INNER, on every side
   *
   * An INNER JOIN to `products` would `404` an order whose catalogue row was
   * withdrawn, an INNER JOIN to `deliveries` would `404` every order that has
   * not been delivered — which is all of them until Slice 5 — and an INNER JOIN
   * to `promo_redemptions` would `404` every order that never used a code,
   * which is most of them. Functional spec §2.6 wants a `404` for exactly one
   * reason: *there is no such order*.
   *
   * ### What spec 005 changed here: two joins and three columns, no `CASE`
   *
   * The promo columns ride along unconditionally, unlike `code`. A key is gated
   * on status because the rule is "shown only once delivered"; a promo has no
   * such rule — it is applied while the order is `created`, and the ledger row
   * outlives every later transition, so the page shows «Промокод» in every
   * state and gates the row on `promo !== null`, never on status
   * (technical-considerations §2.4). The amount the page shows next to it,
   * `amount_minor`, is already the discounted one — the same column the
   * payment simulator reads to build the webhook, so the discounted amount
   * reaches `payment_events.amount_minor` with no change to the payment path.
   *
   * ### What Slice 5 changed here: nothing
   *
   * `deliveries` now has a writer — `IssuanceService` binds a key with
   * `INSERT ... ON CONFLICT (order_id) DO NOTHING`
   * (`../issuance/issuance.service.ts`) — and this statement started returning
   * codes without a character changing. The shape, the joins and `OrderView`
   * were already right, which was the point of writing the `LEFT JOIN` and the
   * `CASE` before there was anything to join to.
   *
   * ---------------------------------------------------------------------------
   * PROCESSING TRIGGER 3 IS THE SECOND `CASE`, AND IT ADDS NO STATEMENT
   * ---------------------------------------------------------------------------
   * `architecture.md` §4's third trigger is *"the order status poll
   * opportunistically drains that order's pending events"* — the one that makes
   * a shopper's own page nudge their own order forward when the webhook's
   * continuation was lost.
   *
   * The obvious implementation is trigger 2's: call `drainOrder` on every read.
   * On *this* endpoint that is a standing load rather than a one-off, because
   * the page polls once a second per open order and a drain that finds nothing
   * is still `BEGIN` / `SELECT … FOR UPDATE SKIP LOCKED` / `COMMIT` — three
   * round trips holding this instance's only pooled connection (`max: 1`),
   * every second, for every viewer, for as long as an order sits in `created`
   * waiting for a shopper to decide to pay.
   *
   * So the trigger is **gated on the database's own answer**, and the gate
   * rides along in the statement that was already running:
   *
   *   - `EXISTS` against `payment_events_unprocessed_order_idx (order_id)
   *     WHERE processed_at IS NULL` — a partial index holding *only* unapplied
   *     events, so it is a handful of entries however large the table grows.
   *     Not a join: a join could multiply the row (an order may have N pending
   *     events), and this statement's single-row guarantee is load-bearing.
   *     `EXISTS` stops at the first match and cannot change the row count.
   *   - wrapped in `CASE WHEN status = ANY($2)` — the in-flight states. A
   *     settled order (`delivered`, `payment_failed`, `out_of_stock`) does not
   *     probe the index at all, and `EXPLAIN (ANALYZE)` says so: the SubPlan
   *     reports `never executed`.
   *
   * Only when it comes back true does {@link OrderPendingEventsNotifier} fire,
   * and the subscriber schedules the drain off this response path
   * (`../payments/order-status-poll-drain.ts`, which argues the policy in full,
   * including why a settled order is deliberately left to the admin sweep).
   *
   * ### Why the predicate names another module's table, which is a real cost
   *
   * `payment_events` belongs to `payments`, and `./order-created-notifier.service.ts`
   * states the principle this rubs against: *`orders` has no business knowing
   * that a payment inbox exists.* Three things make it the right trade here,
   * and it is worth being explicit that it *is* a trade:
   *
   *   - **It is a read, in one statement, exactly as `products` and
   *     `deliveries` already are.** Those tables belong to `catalog` and
   *     `issuance`, and this statement joins both — for precisely this reason:
   *     on the polled endpoint, a fact worth having is worth having without a
   *     second round trip. A fourth table read the same way is the same trade,
   *     not a new one.
   *   - **No module edge is created.** The import is `paymentEvents` from
   *     `@game-shop/db`, the shared schema. `OrdersModule` imports nothing new,
   *     there is no cycle, and `SchedulingModule`'s distance from the root is
   *     untouched.
   *   - **The alternative costs the thing this trigger is trying to save.**
   *     Keeping the predicate inside `payments` means publishing every in-flight
   *     read and letting the subscriber ask — which is a round trip per poll per
   *     viewer, i.e. the load the gate exists to remove.
   *
   * What is *not* traded away: this service still cannot do anything to a
   * payment event. It reads one boolean and announces it. The claim, the apply
   * and the settle stay in `payments`, behind `PaymentEventDrainService`.
   */
  async findOrder(orderId: string): Promise<FindOrderResult> {
    const [row] = await this.database.db
      .select({
        id: orders.id,
        status: orders.status,
        sku: orders.sku,
        productName: products.name,
        amountMinor: orders.amountMinor,
        currency: orders.currency,
        // The applied promo, from the ledger row and the definition it points
        // at — three plain columns, NULL when no code has been applied. No
        // `CASE` here, unlike `code` below: a promo is not gated on status, it
        // is a fact about the order from the moment it is applied until the
        // order is deleted, and the page shows it in every state.
        promoCode: promoCodes.code,
        promoDiscountMinor: promoRedemptions.discountMinor,
        promoListAmountMinor: promoRedemptions.listAmountMinor,
        // The rule, evaluated by Postgres. `${OrderStatus.Delivered}` is bound
        // as a parameter, not inlined, so the status list stays owned by
        // `@game-shop/contracts` rather than being retyped into a SQL string.
        code: sql<string | null>`case when ${orders.status} = ${OrderStatus.Delivered} then ${deliveries.code} end`.as(
          "code",
        ),
        // Trigger 3's gate, evaluated by Postgres inside the round trip this
        // read was making anyway — see the header.
        //
        // `sql.param` binds the whole status list as ONE parameter, which is
        // what `ANY` needs; interpolating the array directly would make Drizzle
        // expand it into a row constructor `(a, b, c)`, which Postgres rejects
        // here. Same binding as `OrderTransitionService`'s guard, and the list
        // is imported from `@game-shop/contracts` rather than retyped into a
        // SQL string, so "still moving" means the same thing here, in the
        // frontend's stop condition and in the processor's settle rule.
        //
        // `else false`, never `else null`: the column is read as a boolean by
        // the mapper below and a three-valued answer would make "no pending
        // work" and "did not look" the same value.
        hasPendingEvents: sql<boolean>`case when ${orders.status} = ANY(${sql.param([...inFlightOrderStatuses])}) then exists (select 1 from ${paymentEvents} where ${paymentEvents.orderId} = ${orders.id} and ${paymentEvents.processedAt} is null) else false end`.as(
          "has_pending_events",
        ),
      })
      .from(orders)
      .leftJoin(products, eq(products.sku, orders.sku))
      .leftJoin(deliveries, eq(deliveries.orderId, orders.id))
      // 1:0..1 — `promo_redemptions.order_id` is the PRIMARY KEY (I8), so this
      // join cannot multiply the row; and `promo_codes.id` is a PRIMARY KEY
      // too, so neither can the next one. See the header.
      .leftJoin(promoRedemptions, eq(promoRedemptions.orderId, orders.id))
      .leftJoin(promoCodes, eq(promoCodes.id, promoRedemptions.promoId))
      .where(eq(orders.id, orderId));

    if (row === undefined) {
      return { outcome: FindOrderOutcome.NotFound, orderId };
    }

    if (row.hasPendingEvents) {
      // ######################################################################
      // # AFTER THE READ, UNAWAITED, AND ONLY WHEN THERE IS SOMETHING TO DO.
      // ######################################################################
      //
      // `architecture.md` §4's third processing trigger hangs off this line.
      // Four properties, each deliberate:
      //
      //   - **Gated by the statement above.** False on every poll of an order
      //     with an empty queue, and on every poll of a settled order — which
      //     is all but a handful of the reads this endpoint serves. That is the
      //     whole cost argument; see the header.
      //   - **After the statement, never inside it.** This method opens no
      //     transaction, and a drain opens transactions of its own against a
      //     `max: 1` pool — a drain started from inside one would wait for a
      //     connection its own caller is holding
      //     (`../payments/payment-event-drain.service.ts`, `runPass`).
      //   - **Synchronous and unawaited.** `notify` returns `void`, so the poll
      //     cannot be made to wait on what a listener does — and what today's
      //     listener does is a drain that reaches a supplier over HTTP. A page
      //     that polls once a second must not be behind a supplier round trip;
      //     the listener schedules that work instead
      //     (`../payments/order-status-poll-drain.ts`).
      //   - **Advisory, never an instruction.** By the time a listener runs,
      //     another worker may already have claimed that row. A drain that
      //     finds nothing is an ordinary outcome, not a contradiction.
      //
      // Losing this call entirely would cost latency and never a key: the event
      // stays pending, in the partial index, for the next poll a second later
      // and for the admin sweep behind it.
      this.pendingEvents.notify(row.id);
    }

    return { outcome: FindOrderOutcome.Found, order: toOrderView(row) };
  }
}
