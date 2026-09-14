/**
 * Creating orders — the first half of the `orders` module's own work ("Create
 * orders; read order state", technical-considerations §2.4). The status
 * transition helper beside it owns every *change* to an order; this file owns
 * the one moment an order comes into existence, in `created`. The read the
 * status page lives on was here too until spec 005 moved it to
 * `./order-view.service.ts`, so that the reader could leave the module without
 * this class — and its `createOrder` — going with it (see `./orders.module.ts`).
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
 *
 * ---------------------------------------------------------------------------
 * AND IT IS STILL ONE STATEMENT NOW THAT IT IS IDEMPOTENT
 * ---------------------------------------------------------------------------
 * Phase 2 gives creation an identity — the `Idempotency-Key` header, stored as
 * `orders.client_request_id` behind a UNIQUE index (I1). The obvious way to use
 * it is "look the key up, and insert if you did not find it", which is both a
 * race with itself and the read-then-write this file exists to avoid; it would
 * undo the paragraph above as a side effect of fixing something else.
 *
 * So the only things added to the statement are `ON CONFLICT
 * (client_request_id) DO NOTHING` and a read of the winner on the zero-row
 * path. The price is still copied column-to-column by Postgres, the
 * purchasability check is still a `WHERE` predicate, and there is still no
 * local variable holding a price. See {@link OrdersService.createOrder}.
 */
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";

import { OrderStatus, minorUnits } from "@game-shop/contracts";
import { orders, products, type DatabaseClient } from "@game-shop/db";

import { DATABASE_CLIENT } from "../database/database.module.js";
import { OrderCreatedNotifier } from "./order-created-notifier.service.js";
import { toCurrency } from "./order-currency.js";
import { newOrderId } from "./order-id.js";
import type { CreatedOrder, CreateOrderResponse, ExistingOrder } from "./orders.types.js";

/**
 * Which of the two things happened. Named values rather than `CreatedOrder |
 * null`, so the caller's `switch` reads as two pieces of news and the compiler
 * has something to be exhaustive about — the same shape
 * {@link OrderTransitionService} uses for its three outcomes.
 */
export const CreateOrderOutcome = {
  /** **This call** created the order. At most one request per key ever sees this. `201`. */
  Created: "created",
  /**
   * This request's `Idempotency-Key` had already created an order; the row in
   * {@link CreateOrderResult.order} is that one, and this call created nothing.
   * `200` — see {@link CreateOrderResponse}.
   */
  AlreadyCreated: "already_created",
  /**
   * No purchasable product with that SKU. Unknown and display-only are **one
   * outcome on purpose** — see the zero-row note on {@link OrdersService.createOrder}.
   */
  ProductNotPurchasable: "product_not_purchasable",
  /**
   * The caller supplied `requestedOrderId`, and it already names another order.
   *
   * Reachable **only** on the client-supplied-id path — `requestedOrderId !==
   * undefined`. The ordinary, server-minted path can in principle hit the same
   * primary-key collision, and deliberately does not get this outcome: see
   * {@link OrdersService.createOrder}'s "What could still go wrong, and does
   * not" section for why that path is left exactly as it always was, an
   * unhandled throw. `409` — see `OrdersController.createOrder`.
   */
  OrderIdAlreadyExists: "order_id_already_exists",
} as const;

export type CreateOrderOutcome = (typeof CreateOrderOutcome)[keyof typeof CreateOrderOutcome];

export type CreateOrderResult =
  | {
      readonly outcome: typeof CreateOrderOutcome.Created;
      readonly order: CreatedOrder;
    }
  | {
      readonly outcome: typeof CreateOrderOutcome.AlreadyCreated;
      /**
       * The order that key created. A separate type from the `created` branch's
       * because it is a *read* of a row that may have moved on — see
       * {@link ExistingOrder}.
       */
      readonly order: ExistingOrder;
    }
  | {
      readonly outcome: typeof CreateOrderOutcome.ProductNotPurchasable;
      /** Echoed back so the caller can name it in the error body without re-parsing the request. */
      readonly sku: string;
    }
  | {
      readonly outcome: typeof CreateOrderOutcome.OrderIdAlreadyExists;
      /** The id the caller requested, echoed back so the `409` body can name it. */
      readonly orderId: string;
    };

/**
 * The five columns the create path reads back, in the schema's camelCase.
 *
 * One interface for both statements on that path — the `RETURNING` of the
 * INSERT, and the follow-up `SELECT` that reads the winner back on the zero-row
 * path — because they select the same five columns on purpose: the `201` body
 * and the `200` body must be the same shape, or a client would have to know
 * which it got before it could read the response.
 */
interface OrderCreationRow {
  readonly id: string;
  readonly sku: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: OrderStatus;
}

/**
 * {@link OrderCreationRow}'s columns as a selection, shared by the INSERT's
 * `RETURNING` and by the zero-row path's follow-up `SELECT`.
 *
 * One constant rather than two literals, because the two statements answer the
 * same request with the same body and a column added to one and forgotten in
 * the other would make `201` and `200` publish different orders. An explicit
 * list either way, as `catalog.service.ts` uses for the same reason: a column
 * added to `orders` later cannot quietly widen what this endpoint publishes.
 */
const orderCreationColumns = {
  id: orders.id,
  sku: orders.sku,
  amountMinor: orders.amountMinor,
  currency: orders.currency,
  status: orders.status,
} as const;

/**
 * `unique_violation` — Postgres SQLSTATE 23505.
 *
 * The one constraint {@link OrdersService.createOrder}'s INSERT can raise it
 * for is `orders_pkey`, on the client-supplied-id path — see
 * {@link isUniqueViolation} and that method's "What could still go wrong, and
 * does not" section.
 */
const POSTGRES_UNIQUE_VIOLATION = "23505";

/** Enough to walk Drizzle's wrapper and one or two layers under it; bounded so a cyclic `cause` cannot spin. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Does this error — or anything in its `cause` chain — carry SQLSTATE 23505?
 *
 * A duplicate of `../suppliers/supplier-key-claim.service.ts`'s function of the
 * same name and body, not a shared import — deliberately, for the reason
 * `./order-currency.ts` gives for `toCurrency`'s duplication against
 * `catalog`: hoisting it would couple `orders` to `suppliers`, a module this
 * one has no other reason to import from, to save four lines neither will
 * change independently.
 *
 * **The chain is the whole point, and it is not decoration.** Drizzle wraps
 * every driver error in a `DrizzleQueryError` whose message is the failed SQL
 * and whose `cause` is the `pg` error that actually carries `code` and
 * `constraint`. A guard that inspected only the outer error would find no
 * `code` and rethrow every id collision as "unexpected" — turning the one case
 * this method is supposed to answer with `409` into a `500`.
 *
 * Structural rather than `instanceof pg.DatabaseError`, for the same reason:
 * `apps/api` talks to Postgres through Drizzle and does not depend on the
 * driver package, and Phase 6 swaps `pg` for `@neondatabase/serverless`
 * underneath (`packages/db/src/client.ts`). The SQLSTATE is the stable part of
 * that contract; the error class is not.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && current.code === POSTGRES_UNIQUE_VIOLATION) return true;
    if (!("cause" in current)) return false;
    current = current.cause;
  }

  return false;
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
function toCreatedOrder(row: OrderCreationRow): CreatedOrder {
  if (row.status !== OrderStatus.Created) {
    throw new Error(`orders: newly inserted order ${row.id} came back as "${row.status}"`);
  }

  return { ...toExistingOrder(row), status: row.status };
}

/**
 * Row → wire body, for the order an already-used `Idempotency-Key` read back.
 *
 * The same five fields as {@link toCreatedOrder}, and deliberately **without**
 * its status check: this row was written by an earlier request and the order
 * has had time to move, so `paid` and `delivered` are ordinary answers here
 * rather than the impossibility they would be above. See {@link ExistingOrder}.
 */
function toExistingOrder(row: OrderCreationRow): ExistingOrder {
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

@Injectable()
export class OrdersService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    /**
     * Told about each order this service creates — see the end of
     * {@link createOrder}. A publisher, never a collaborator: this service
     * cannot ask it a question, waits for nothing it does, and behaves
     * identically if nobody is subscribed
     * (`./order-created-notifier.service.ts`).
     */
    private readonly orderCreated: OrderCreatedNotifier,
  ) {}

  /**
   * Create an order for `sku`, in `created`, priced from the catalogue — or,
   * when `clientRequestId` names a purchase that has already been made, hand
   * back the order it made.
   *
   * ---------------------------------------------------------------------------
   * I1 — ONE CLIENT REQUEST → ONE ORDER. THE INDEX DECIDES, NOT THIS CODE.
   * ---------------------------------------------------------------------------
   * `clientRequestId` is the `Idempotency-Key` header, naming the shopper's
   * *intent* to buy this thing once (`architecture.md` §3, I1). `null` when the
   * header was absent, which is Phase 1's path and still creates an order.
   *
   * Nothing here asks "have I seen this key before?". That question is
   * check-then-act: two overlapping requests both answer "no" and both insert,
   * and the window between the read and the write is exactly the double-click
   * this method exists to survive. `apps/api` runs as serverless functions, so
   * the two requests are typically two *processes* — an in-memory `Map` or a
   * mutex would pass locally and evaporate in production
   * (`docs/walkthrough/slice-2-order-lifecycle.md` §6). The unique index is the
   * first and only place every concurrent attempt meets, so it is the index that
   * picks the winner and this code only reads the verdict.
   *
   * Emitted SQL (copied from `.toSQL()`; per the project's raw-SQL rule,
   * `architecture.md` §2, "Documentation convention"):
   *
   *   insert into "orders" ("id", "client_request_id", "sku", "amount_minor",
   *                         "currency", "status", "created_at", "updated_at")
   *   select $1 as "id", $2 as "client_request_id", "sku", "price_minor",
   *          "currency", $3 as "status",
   *          now() as "created_at", now() as "updated_at"
   *   from "products"
   *   where ("products"."sku" = $4 and "products"."purchasable" = $5)
   *   on conflict ("client_request_id") do nothing
   *   returning "id", "sku", "amount_minor", "currency", "status";
   *   -- $1 the application-minted `ord_` + ULID, $2 the Idempotency-Key or NULL,
   *   -- $3 the literal 'created', $4 the SKU from the request body, $5 true.
   *   -- 1 row  => THIS call created the order, priced from the catalogue row in
   *   --           the same statement. 201.
   *   -- 0 rows => TWO DIFFERENT THINGS. See below — they must not be conflated.
   *
   * The column list is the *whole* table because Drizzle requires an
   * `INSERT ... SELECT`'s select list to line up with the table definition
   * ("selected fields are not the same or are in a different order compared to
   * the table definition"). The two columns the application has nothing to say
   * about are written as exactly what the schema's own defaults would have
   * produced — `now()`, `now()` — which costs nothing and buys one thing worth
   * having: `created_at` is stamped by **the database's clock**, the one every
   * other process is compared against, rather than by a serverless instance's.
   * Same reasoning as `updated_at = now()` in {@link OrderTransitionService}.
   *
   * The index the conflict clause names, as Postgres holds it:
   *
   *   CREATE UNIQUE INDEX orders_client_request_id_key
   *     ON public.orders USING btree (client_request_id);
   *
   * Postgres treats NULLs as distinct from one another, so it accepts any number
   * of unkeyed orders while still rejecting two equal non-NULL keys — which is
   * what lets one statement serve both the header-present and header-absent
   * cases.
   *
   * ### Zero rows has two causes, and telling them apart is the whole task
   *
   * Either the key already won (a legitimate retry) **or** the SKU is not
   * purchasable (a rejection). Conflating them hands a retrying shopper a `422`
   * for an order that exists, or answers a bad SKU with somebody's order. The
   * follow-up read is what separates them, and it runs **only** on the zero-row
   * path — the path with no work to do anyway:
   *
   *   select "id", "sku", "amount_minor", "currency", "status"
   *   from "orders" where "orders"."client_request_id" = $1;
   *   -- 1 row  => this key already created that order. Nothing was created now.
   *   --           200 with that order (architecture.md §3.1, I1).
   *   -- 0 rows => the key is new, so the conflict clause was never reached and
   *   --           the INSERT's own SELECT matched no purchasable product. 422.
   *
   * **The read cannot miss the winner it is looking for.** That is a guarantee
   * of `ON CONFLICT DO NOTHING`, not an assumption about timing: when the
   * conflicting row is still uncommitted, the index insertion waits on the other
   * transaction (`_bt_check_unique` → `XactLockTableWait`) and retries — so if
   * that transaction aborts we insert and win, and if it commits we get zero
   * rows. By the time zero rows comes back the winner is committed, and this
   * statement's own snapshot, taken afterwards, sees it. There is no window in
   * which the loser sees neither its own row nor the winner's.
   *
   * A `null` key skips the read entirely: NULLs do not collide in a Postgres
   * unique index, so the conflict clause is unreachable and zero rows can only
   * mean the SKU was rejected. It would also be the wrong query — `= NULL`
   * matches nothing, and matching *some* NULL-keyed order would be worse.
   *
   * ### What the shape buys, unchanged from Phase 1
   *
   *   - **The amount cannot come from the client.** `price_minor` and `currency`
   *     are read by Postgres and written by Postgres; the request contributes
   *     `$4` and the header contributes `$2`, and neither is money. Still one
   *     `INSERT ... SELECT`, not a read-then-insert: adding the conflict clause
   *     and the read-back must not turn creation back into a sequence, because
   *     the sequence is where a `amount ?? product.priceMinor` gets written.
   *     See this file's header.
   *   - **Purchasability is still a `WHERE` predicate, not an `if`.** A
   *     display-only SKU matches no row, so nothing is inserted — no window in
   *     which a product is read as purchasable and then written after being
   *     withdrawn.
   *   - **Unknown SKU and display-only SKU are still one outcome**, for the
   *     reasons the `ProductNotPurchasable` doc gives.
   *   - **No transaction.** The insert is one statement and already atomic; the
   *     follow-up read is a second, and it deliberately does *not* join them
   *     into a transaction. Nothing it reads can be un-decided later — the
   *     winner is committed — and wrapping the pair would hold this instance's
   *     only connection across two round trips instead of one
   *     (`packages/db/src/client.ts`, "WHY `max: 1`").
   *
   * ### What could still go wrong, and does not
   *
   * The conflict target is named (`client_request_id`) rather than bare, so this
   * clause swallows exactly one constraint. A primary-key collision on `id`
   * still raises rather than being quietly reported as a retry — on the ordinary,
   * server-minted path (`requestedOrderId` not given), 80 bits of `node:crypto`
   * randomness per millisecond makes it a non-event, but it is not silently
   * swallowed if it ever happens: the `catch` below only ever intercepts a
   * unique violation when `requestedOrderId !== undefined`, so this path's
   * behaviour on that collision is unchanged from every earlier phase — an
   * unhandled throw.
   *
   * ### `requestedOrderId` — no longer a non-event, and here is what happens instead
   *
   * `architecture.md` §9, "A test affordance on order creation": behind
   * `ALLOW_CLIENT_SUPPLIED_ORDER_ID`, a caller can name `orderId` instead of
   * having one minted (`../config/client-supplied-order-id.ts`). That turns the
   * PK collision described above from an astronomically unlikely accident into
   * an ordinary, expected outcome — `scripts/race/before-order.ts` and a
   * careless seed can both retry with an id already in use — and it needs a
   * clean `409`, not a 500 with a driver stack trace in the response.
   *
   * Observed against a local Postgres 16 (`docker compose up` + `pnpm db:setup`,
   * then a duplicate insert of this exact statement with a repeated `id`), per
   * the project's "quote the real thing" documentation rule: the second insert
   * raised a `DatabaseError` with `.code === "23505"`, `.constraint ===
   * "orders_pkey"`, and `.detail === 'Key (id)=(...) already exists.'`. That is
   * the one and only constraint this statement's `catch` can be reached by:
   * `client_request_id` is the named conflict target and cannot raise (`ON
   * CONFLICT ... DO NOTHING` swallows it before it becomes an exception), so any
   * `23505` reaching the `catch` is `orders_pkey` by elimination — confirmed,
   * not assumed, by the observation above. {@link isUniqueViolation} checks only
   * the SQLSTATE and not the constraint name for the same reason
   * `../suppliers/supplier-key-claim.service.ts` does: matching by SQLSTATE
   * alone is what survives the Phase 6 driver swap
   * (`packages/db/src/client.ts`), and nothing else on this table's insert path
   * can raise a 23505 for this statement to confuse it with.
   *
   * The key is **not** re-checked against the SKU. Sending one key for two
   * different games is a client bug, and the honest answer to it is still the
   * order that key created — that is what the key means. The alternative, a
   * `409`, would invent a failure mode the shopper cannot act on for a request
   * their own page cannot make (the key is minted per SKU).
   */
  async createOrder(
    sku: string,
    clientRequestId: string | null,
    requestedOrderId?: string,
  ): Promise<CreateOrderResult> {
    const orderId = requestedOrderId ?? newOrderId();

    let created: OrderCreationRow | undefined;

    try {
      [created] = await this.database.db
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
              // I1's column: the `Idempotency-Key` header, or NULL when it was
              // not sent. The UNIQUE index accepts any number of NULLs, so the
              // header stays optional without a second statement for that case.
              //
              // A **bound parameter**, where Phase 1 had the literal keyword
              // `null`, and deliberately with no `::text` cast on it. The cast
              // looks necessary — an untyped `$2` in a SELECT list normally has
              // nothing to resolve against, and a NULL one even less — but
              // Postgres analyses this SELECT as the source of an INSERT and
              // resolves the parameter from the target column. Measured both ways
              // against the live database before this line was written: with the
              // cast and without it, bound to a string and bound to NULL, all
              // four succeed. So the cast is dropped and the emitted statement
              // stays the one `architecture.md` §3.1 specifies.
              clientRequestId: sql<string | null>`${clientRequestId}`.as("client_request_id"),
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
        // I1. Named target, so only `orders_client_request_id_key` is forgiven —
        // see "What could still go wrong" above.
        .onConflictDoNothing({ target: orders.clientRequestId })
        // An explicit column list, as `catalog.service.ts` uses for the same
        // reason: the returned row is the response shape, so a column added to
        // `orders` later cannot quietly widen what this endpoint publishes.
        .returning(orderCreationColumns);
    } catch (error: unknown) {
      // Reachable at all only via `orders_pkey` — see "What could still go
      // wrong, and does not" above for why that is the only constraint this
      // statement's `catch` can be reached by, and what was actually observed
      // raising it.
      //
      // `requestedOrderId !== undefined` is checked *first* and is what keeps
      // this from changing the ordinary, server-minted path: an id collision
      // there is still left to propagate as an unhandled throw, exactly as
      // every earlier phase of this file already documented and relied on.
      if (requestedOrderId !== undefined && isUniqueViolation(error)) {
        return { outcome: CreateOrderOutcome.OrderIdAlreadyExists, orderId: requestedOrderId };
      }

      throw error;
    }

    if (created !== undefined) {
      // ####################################################################
      // # THE ORDER IS COMMITTED. SAY SO — AND DO NOT WAIT FOR THE ANSWER.
      // ####################################################################
      //
      // `architecture.md` §4's second processing trigger hangs off this line:
      // an event that arrived before its order has been sitting in
      // `payment_events` with `processed_at` NULL and nothing to apply it to,
      // and this is the first instant it *can* be applied.
      //
      // Three properties of this call, each deliberate:
      //
      //   - **After the statement, never inside it.** The INSERT has resolved,
      //     so the row is committed and visible to every other connection — the
      //     only state in which an event can be applied to it. It is also the
      //     only safe order: a drain opens transactions of its own, and this
      //     instance's pool is `max: 1`, so a drain started from inside an open
      //     transaction would wait for a connection its own caller is holding
      //     (`../payments/payment-event-drain.service.ts`, `runPass`). This
      //     method opens no transaction at all, which makes that unreachable
      //     twice over.
      //   - **Synchronous and unawaited.** `notify` returns `void`, so creation
      //     cannot be made to wait on what a listener does — and what today's
      //     listener does is a drain that can reach a supplier over HTTP. The
      //     `201` must not be behind a supplier round trip; the listener
      //     schedules that work instead (`../payments/order-creation-drain.ts`).
      //   - **On this branch only.** `AlreadyCreated` is a retry of a request
      //     whose original already announced this order, and nothing has come
      //     into existence to announce. A pending event for it is the status
      //     poll's and the sweep's to find.
      //
      // Losing this call entirely would cost latency and never a key: the event
      // stays pending, in the partial index, for the other three triggers.
      this.orderCreated.notify(created.id);

      return { outcome: CreateOrderOutcome.Created, order: toCreatedOrder(created) };
    }

    // Zero rows. Which of the two causes was it?
    //
    // With no key there is only one candidate: the conflict clause is
    // unreachable for a NULL, so the SKU was rejected. Asking Postgres would
    // cost a round trip to answer a question with one possible answer.
    if (clientRequestId === null) {
      return { outcome: CreateOrderOutcome.ProductNotPurchasable, sku };
    }

    const [existing] = await this.database.db
      .select(orderCreationColumns)
      .from(orders)
      .where(eq(orders.clientRequestId, clientRequestId));

    if (existing === undefined) {
      return { outcome: CreateOrderOutcome.ProductNotPurchasable, sku };
    }

    return { outcome: CreateOrderOutcome.AlreadyCreated, order: toExistingOrder(existing) };
  }
}
