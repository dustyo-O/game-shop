/**
 * Creating orders and reading them back — the `orders` module's own work
 * ("Create orders; read order state", technical-considerations §2.4). The status
 * transition helper beside it owns every *change* to an order; this file owns
 * the one moment an order comes into existence, in `created`, and the read the
 * status page lives on.
 *
 * ---------------------------------------------------------------------------
 * THE CLIENT SENDS A SKU. IT DOES NOT SEND A PRICE, AND IT COULD NOT.
 * ---------------------------------------------------------------------------
 * The assignment's standing rule is that the server computes what is owed. The
 * usual way to honour it is a careful sequence — read the product, take its
 * price, ignore whatever the body said, insert — and the usual way it is broken,
 * a phase or two later, is a well-meaning `amount ?? product.priceMinor` written
 * by someone who has not read this comment.
 *
 * So the amount never passes through TypeScript at all. `createOrder` is **one
 * statement**, an `INSERT ... SELECT` that copies `products.price_minor` and
 * `products.currency` into the new row column-to-column inside Postgres. The
 * only value from the request that reaches it is the SKU, bound as a parameter
 * in the `WHERE` clause. There is no local variable holding a price, and
 * therefore no line where a client-supplied one could be substituted.
 *
 * The same statement is also the purchasability check: `purchasable = true` is a
 * `WHERE` predicate, not an `if`. A display-only SKU matches no row, so nothing
 * is inserted — no read-then-act, and no window in which a product is read as
 * purchasable and then written after being withdrawn.
 */
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";

import { Currency, OrderStatus, minorUnits } from "@game-shop/contracts";
import { deliveries, orders, products, type DatabaseClient } from "@game-shop/db";

import { DATABASE_CLIENT } from "../database/database.module.js";
import { newOrderId } from "./order-id.js";
import type { CreatedOrder, OrderView } from "./orders.types.js";

/**
 * Which of the two things happened. Named values rather than `CreatedOrder |
 * null`, so the caller's `switch` reads as two pieces of news and the compiler
 * has something to be exhaustive about — the same shape
 * {@link OrderTransitionService} uses for its three outcomes.
 */
export const CreateOrderOutcome = {
  /** The order exists now. */
  Created: "created",
  /**
   * No purchasable product with that SKU. Unknown and display-only are **one
   * outcome on purpose** — see the zero-row note on {@link OrdersService.createOrder}.
   */
  ProductNotPurchasable: "product_not_purchasable",
} as const;

export type CreateOrderOutcome = (typeof CreateOrderOutcome)[keyof typeof CreateOrderOutcome];

export type CreateOrderResult =
  | {
      readonly outcome: typeof CreateOrderOutcome.Created;
      readonly order: CreatedOrder;
    }
  | {
      readonly outcome: typeof CreateOrderOutcome.ProductNotPurchasable;
      /** Echoed back so the caller can name it in the error body without re-parsing the request. */
      readonly sku: string;
    };

/**
 * Which of the two things happened when an order was looked up. The same
 * named-outcome shape {@link CreateOrderOutcome} and
 * {@link OrderTransitionService} use, for the same reason: the caller's `switch`
 * reads as news, and the compiler has something to be exhaustive about.
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

/** The five columns `RETURNING` hands back, in the schema's camelCase. */
interface InsertedOrderRow {
  readonly id: string;
  readonly sku: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: OrderStatus;
}

/**
 * `text` column → {@link Currency}.
 *
 * A narrowing check rather than `row.currency as Currency`, for the reason
 * `catalog.service.ts` gives at its own copy of this function: the assertion
 * would compile and be wrong in the one case that matters, letting a currency
 * the shop cannot price reach the shopper as if it could.
 *
 * The duplication is deliberate rather than overlooked. Hoisting four lines into
 * a shared module would couple `orders` to `catalog` — or invent a third home
 * for it — to save nothing; whoever writes the third copy has earned the
 * refactor.
 */
function toCurrency(value: string): Currency {
  if (value === Currency.Rub) return value;
  throw new Error(`orders: order row has unsupported currency "${value}"`);
}

/**
 * Row → wire body.
 *
 * The status check is not defensive padding: it is what narrows the column's
 * union type to the literal `"created"` that {@link CreatedOrder} promises. The
 * statement below binds `'created'` itself, so the branch is unreachable — and
 * if it ever *is* reached, an order that came back in some other state is worth
 * a `500` rather than a response that quietly disagrees with its own type.
 */
function toCreatedOrder(row: InsertedOrderRow): CreatedOrder {
  if (row.status !== OrderStatus.Created) {
    throw new Error(`orders: newly inserted order ${row.id} came back as "${row.status}"`);
  }

  return {
    id: row.id,
    sku: row.sku,
    // Brands the raw integer column as kopecks — the one place an
    // `orders.amount_minor` value becomes a typed amount on its way out
    // (`packages/contracts/src/money.ts`).
    amount_minor: minorUnits(row.amountMinor),
    currency: toCurrency(row.currency),
    status: row.status,
  };
}

/**
 * One row as {@link OrdersService.findOrder}'s query returns it — three tables
 * flattened into the seven values the status page needs, still in the schema's
 * camelCase and still with the raw column types.
 *
 * Two fields are nullable for two entirely different reasons, and the difference
 * matters when reading the mapper below:
 *
 *   - `productName` — the LEFT JOIN found no catalogue row. Ordinary, and the
 *     page falls back to the SKU (see `OrderViewCore.product_name`).
 *   - `code` — either there is no delivery, or there is one and the order is not
 *     `delivered` so Postgres refused to hand it over. The `CASE` in the query
 *     is what makes those two indistinguishable here, on purpose.
 */
interface OrderViewRow {
  readonly id: string;
  readonly status: OrderStatus;
  readonly sku: string;
  readonly productName: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly code: string | null;
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
    // `toCreatedOrder` above (`packages/contracts/src/money.ts`).
    amount_minor: minorUnits(row.amountMinor),
    currency: toCurrency(row.currency),
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
export class OrdersService {
  constructor(@Inject(DATABASE_CLIENT) private readonly database: DatabaseClient) {}

  /**
   * Create an order for `sku`, in `created`, priced from the catalogue.
   *
   * Emitted SQL (copied from the statement Postgres logged under
   * `log_statement = 'all'`; per the project's raw-SQL rule, `architecture.md`
   * §2, "Documentation convention"):
   *
   *   insert into "orders" ("id", "client_request_id", "sku", "amount_minor",
   *                         "currency", "status", "created_at", "updated_at")
   *   select $1 as "id", null as "client_request_id", "sku", "price_minor",
   *          "currency", $2 as "status",
   *          now() as "created_at", now() as "updated_at"
   *   from "products"
   *   where ("products"."sku" = $3 and "products"."purchasable" = $4)
   *   returning "id", "sku", "amount_minor", "currency", "status";
   *   -- $1 the application-minted `ord_` + ULID, $2 the literal 'created',
   *   -- $3 the SKU from the request body, $4 true.
   *   -- 1 row  => the order exists, priced from the catalogue row in the same
   *   --           statement that created it.
   *   -- 0 rows => no purchasable product with that SKU. Nothing was inserted.
   *
   * The column list is the *whole* table because Drizzle requires an
   * `INSERT ... SELECT`'s select list to line up with the table definition
   * ("selected fields are not the same or are in a different order compared to
   * the table definition"). The three columns the application has nothing to say
   * about are written as exactly what the schema's own defaults would have
   * produced — `null`, `now()`, `now()` — which costs nothing and buys one
   * thing worth having: `created_at` is stamped by **the database's clock**, the
   * one every other process is compared against, rather than by a serverless
   * instance's. Same reasoning as `updated_at = now()` in
   * {@link OrderTransitionService}.
   *
   * ### What the shape buys
   *
   *   - **The amount cannot come from the client.** `price_minor` and `currency`
   *     are read by Postgres and written by Postgres; the request's only
   *     contribution is `$3`. See this file's header.
   *   - **Zero rows is the rejection.** Unknown SKU and display-only SKU both
   *     land here, and they are deliberately one outcome: the statement cannot
   *     tell them apart without a second query, the client's fix is the same for
   *     both (only offer the buy path where `purchasable` is true, which
   *     `GET /api/products` already publishes), and the catalogue is public
   *     anyway. Contrast {@link OrderTransitionService}, which *does* pay for a
   *     follow-up `SELECT` on its zero-row path — there the two causes lead to
   *     genuinely different behaviour (drain the event later vs. do nothing).
   *   - **`client_request_id` is written as an explicit NULL.** That is Phase
   *     2's column (I1, the `Idempotency-Key` header) and nothing sends the
   *     header yet. Its UNIQUE index does not object: Postgres holds NULLs to be
   *     distinct from one another, so a unique index accepts any number of them
   *     while still rejecting two equal non-NULL values. Checked against the
   *     live index rather than taken on faith — many orders coexist with
   *
   *       CREATE UNIQUE INDEX orders_client_request_id_key
   *         ON public.orders USING btree (client_request_id);
   *
   *     all of them NULL, and inserting the same non-NULL value twice still
   *     raises `duplicate key value violates unique constraint`.
   *   - **No transaction.** A single statement is already atomic; wrapping it in
   *     `BEGIN`/`COMMIT` would add two round trips and check out this instance's
   *     only connection for longer (`packages/db/src/client.ts`, "WHY `max: 1`").
   *
   * ### What could still go wrong, and does not
   *
   * A primary-key collision on `id` would raise rather than return zero rows —
   * 80 bits of `node:crypto` randomness per millisecond makes it a non-event,
   * and it is not silently swallowed here if it ever happens.
   */
  async createOrder(sku: string): Promise<CreateOrderResult> {
    const orderId = newOrderId();

    const [created] = await this.database.db
      .insert(orders)
      // `.select()` rather than `.values()`: this is what makes it one
      // statement. `.values({ amountMinor: <number> })` would require reading
      // the product first and carrying its price through JavaScript — the read
      // -then-write this file exists to avoid.
      .select((qb) =>
        qb
          .select({
            // Every column of `orders`, in schema order — see the doc comment.
            //
            // `.as(...)` on each literal is required by Drizzle, not decoration:
            // a bare `sql` fragment in a selection that feeds another statement
            // has no name to be referred to by, and the type error says so. The
            // aliases appear in the emitted SQL and Postgres ignores them — an
            // INSERT ... SELECT matches the select list to the insert column
            // list by position, never by name.
            id: sql<string>`${orderId}`.as("id"),
            // Phase 2's `Idempotency-Key` (I1). Nothing sends it yet, and the
            // UNIQUE index accepts any number of NULLs.
            clientRequestId: sql<string | null>`null`.as("client_request_id"),
            // The three the shop must not invent: they are read out of the
            // catalogue row this statement is selecting from.
            sku: products.sku,
            amountMinor: products.priceMinor,
            currency: products.currency,
            status: sql<OrderStatus>`${OrderStatus.Created}`.as("status"),
            createdAt: sql<Date>`now()`.as("created_at"),
            updatedAt: sql<Date>`now()`.as("updated_at"),
          })
          .from(products)
          .where(and(eq(products.sku, sku), eq(products.purchasable, true))),
      )
      // An explicit column list, as `catalog.service.ts` uses for the same
      // reason: the returned row is the response shape, so a column added to
      // `orders` later cannot quietly widen what this endpoint publishes.
      .returning({
        id: orders.id,
        sku: orders.sku,
        amountMinor: orders.amountMinor,
        currency: orders.currency,
        status: orders.status,
      });

    if (created === undefined) {
      return { outcome: CreateOrderOutcome.ProductNotPurchasable, sku };
    }

    return { outcome: CreateOrderOutcome.Created, order: toCreatedOrder(created) };
  }

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
   * endpoint that runs in a loop. It is a single `SELECT` with two joins, and it
   * stays one.
   *
   * Emitted SQL (copied from `.toSQL()`; per the project's raw-SQL rule,
   * `architecture.md` §2, "Documentation convention"):
   *
   *   select "orders"."id", "orders"."status", "orders"."sku", "products"."name",
   *          "orders"."amount_minor", "orders"."currency",
   *          case when "orders"."status" = $1 then "deliveries"."code" end as "code"
   *   from "orders"
   *   left join "products" on "products"."sku" = "orders"."sku"
   *   left join "deliveries" on "deliveries"."order_id" = "orders"."id"
   *   where "orders"."id" = $2;
   *   -- $1 the literal 'delivered', $2 the id from the URL.
   *   -- 1 row  => the order exists. `code` is the key, or NULL.
   *   -- 0 rows => no order with that id => 404 (functional spec §2.6).
   *
   * Three joins' worth of index lookups and nothing else: `orders.id` is the
   * primary key, `products.sku` is UNIQUE (`products_sku_key`) and
   * `deliveries.order_id` is UNIQUE (`deliveries_order_id_key`, invariant I3).
   * The last one is also why no `LIMIT` is needed to guarantee a single row —
   * neither join can multiply it, because both join keys are unique.
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
   * ### LEFT, not INNER, on both sides
   *
   * An INNER JOIN to `products` would `404` an order whose catalogue row was
   * withdrawn, and an INNER JOIN to `deliveries` would `404` every order that
   * has not been delivered — which is all of them until Slice 5. Functional spec
   * §2.6 wants a `404` for exactly one reason: *there is no such order*.
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
   * ### Deliberately not here
   *
   * The opportunistic drain of that order's pending `payment_events`
   * (`architecture.md` §4, processing trigger 3) belongs on this endpoint, but
   * not yet: nothing writes `payment_events` until the webhook lands, and the
   * drain is a second statement on the polled path that must be added with its
   * own reasoning about locking rather than smuggled in now.
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
        // The rule, evaluated by Postgres. `${OrderStatus.Delivered}` is bound
        // as a parameter, not inlined, so the status list stays owned by
        // `@game-shop/contracts` rather than being retyped into a SQL string.
        code: sql<string | null>`case when ${orders.status} = ${OrderStatus.Delivered} then ${deliveries.code} end`.as(
          "code",
        ),
      })
      .from(orders)
      .leftJoin(products, eq(products.sku, orders.sku))
      .leftJoin(deliveries, eq(deliveries.orderId, orders.id))
      .where(eq(orders.id, orderId));

    if (row === undefined) {
      return { outcome: FindOrderOutcome.NotFound, orderId };
    }

    return { outcome: FindOrderOutcome.Found, order: toOrderView(row) };
  }
}
