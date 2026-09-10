/**
 * The wire shapes of `POST /api/orders` and `GET /api/orders/:id`
 * (technical-considerations §2.3).
 *
 * Here rather than in `packages/contracts` for the same reason
 * `catalog.types.ts` gives: that package holds the contracts the shop does
 * **not** own — the payment provider's webhook body, the supplier's `/issue`
 * pair — plus the order lifecycle, which the database CHECK constraint and the
 * status page have to agree on letter for letter. This request and this response
 * are neither; they are this application's own shapes.
 *
 * Field names are snake_case because they are wire fields, matching §2.3 and
 * `GET /api/products` before it. The database row they come from is camelCase on
 * the TypeScript side, and each shape is built in exactly one place —
 * `OrdersService.createOrder` and `OrdersService.findOrder`.
 */
import type { Currency, MinorUnits, OrderStatus } from "@game-shop/contracts";

/**
 * The request body: **a SKU, and — behind a flag — an id.**
 *
 * This interface is the whole of the "never trust a client-supplied amount"
 * rule, stated as a type. There is no `amount`, no `price`, no `discount` and no
 * `currency` field to send, because the server reads all of them from the
 * `products` row inside the same INSERT that creates the order — see the
 * statement in `OrdersService.createOrder`.
 *
 * A body carrying extra fields is **ignored, not rejected** (see
 * `OrdersController.createOrder`): a client that adds `amount: 1` gets an order
 * for the catalogue price, which is the correct answer to that request. Phase 5
 * adds promo codes, and they arrive the same way — as a *code* the server prices,
 * never as a discount the client computes.
 *
 * `id` is the one deliberate exception to that "ignored, not rejected" stance,
 * and the reason is the reason itself does not apply to it: `amount` and
 * `discount` can *never* be honoured, by any caller, under any configuration —
 * the server never reads a client-supplied number, full stop, so silently
 * dropping them costs a well-behaved client nothing it could have had. `id` is
 * different. It genuinely *would* be honoured with `ALLOW_CLIENT_SUPPLIED_ORDER_ID`
 * set, so a caller sending it while the flag is off — almost certainly a
 * misconfigured seed or race script, not a shopper — must not be told `201`
 * while a random id was substituted underneath it. See {@link
 * CreateOrderRequest.id} and `OrdersController`'s `parseRequestedOrderId`.
 *
 * The `Idempotency-Key` is a **header**, not a body field, and is stored as
 * `orders.client_request_id` (I1). Deliberately not here: it names the shopper's
 * *intent*, and the body describes *what is being bought*. Two deliberate
 * purchases of the same game send identical bodies and different keys, so a
 * field on this interface would be a field whose value could not be derived
 * from the rest of it. A request that omits the header still creates an order
 * and leaves the column NULL — which its UNIQUE index tolerates, since Postgres
 * treats NULLs as distinct from one another.
 */
export interface CreateOrderRequest {
  /** The catalogue handle, e.g. `KEY-CS2-PRIME`. `products.sku`, UNIQUE. */
  readonly sku: string;

  /**
   * A caller-chosen order id, in place of the server-minted `ord_` + ULID
   * (`./order-id.ts`). Optional, and — deliberately unlike every other field an
   * ordinary caller might add to this body — **not** covered by this
   * interface's own "extra fields are ignored" precedent above: whether `id` is
   * honoured, ignored, or rejected is a runtime decision gated by
   * `ALLOW_CLIENT_SUPPLIED_ORDER_ID`, and the type here only says the field is
   * *shaped* like an id, not that it will be used.
   *
   * See `../config/client-supplied-order-id.ts` for the flag and
   * `architecture.md` §9 ("A test affordance on order creation") for why it
   * exists at all: `webhook:before-order` has to name an order id *before* the
   * order exists, and nothing else in this codebase lets a caller do that. This
   * is a test affordance for seeds and that script, off by default, and it must
   * never be reachable by a real shopper.
   */
  readonly id?: string;
}

/**
 * The `201` body: the order as it was just written.
 *
 * Deliberately smaller than the status page's view. The client's next move is to
 * navigate to `/order/{id}`, and `GET /api/orders/:id` — the next task — is what
 * owns the shape that page renders (product name, amount, status, and the key
 * once delivered). Publishing a second, subtly different view of the same order
 * from here would be two shapes to keep in step for no gain.
 */
export interface CreatedOrder {
  /** `ord_` + ULID. See `./order-id.ts` for why the application mints it. */
  readonly id: string;

  /** The SKU the order was placed for, copied from the catalogue row. */
  readonly sku: string;

  /**
   * **Kopecks, not roubles** — `129000` is 1 290 ₽. The value is
   * `products.price_minor` as it stood at creation time, copied column-to-column
   * by the INSERT; no arithmetic and no client input touch it. Formatting it as
   * «1 290 ₽» is the frontend's job.
   */
  readonly amount_minor: MinorUnits;

  /** ISO 4217, copied from the same catalogue row. `RUB` throughout. */
  readonly currency: Currency;

  /**
   * Always `created` — the only status this endpoint can produce
   * (`packages/contracts/src/order-status.ts`: *"the only state
   * `POST /api/orders` produces"*). Typed as the literal rather than as the full
   * union so the response says so, and so a future change that lets creation
   * land anywhere else has to change this line and be noticed.
   */
  readonly status: typeof OrderStatus.Created;
}

/**
 * The `200` body: the order this `Idempotency-Key` **already** created.
 *
 * Same five fields as {@link CreatedOrder}, and on the wire the two are one
 * shape — a client reads `id` from either without asking which it got. They are
 * two types for exactly one reason, and it is the `status` field.
 *
 * ---------------------------------------------------------------------------
 * WHY `status` WIDENS HERE AND NOWHERE ELSE
 * ---------------------------------------------------------------------------
 * {@link CreatedOrder} can promise the literal `"created"` because the statement
 * that produces it binds `'created'` itself. This body is produced by a *read*
 * of a row somebody else's request wrote, possibly some time ago, and an order
 * does not stand still: the ordinary repeat lands milliseconds later and reads
 * `created`, but a shopper who returns to a stale tab and clicks Buy again
 * re-sends the same key against an order that has since become `paid` or
 * `delivered`. Both are the same news — *this key already made an order, here
 * it is* — and answering the second with a `500` because the row failed to
 * still say `created` would turn a correctly-recognised retry into an outage.
 *
 * So the widening is a fact about where the value comes from, not a relaxation.
 * The literal type stays exactly where it is true.
 *
 * `Omit<CreatedOrder, "status">` rather than a copied field list: the four
 * remaining fields *are* {@link CreatedOrder}'s, documented once there, and a
 * field added to the `201` body must appear in the `200` body or the endpoint
 * would publish two different orders depending on which call you made.
 */
export interface ExistingOrder extends Omit<CreatedOrder, "status"> {
  /**
   * Wherever the order has got to since the key first created it — any member
   * of the lifecycle, not just `created`. See this interface's header.
   */
  readonly status: OrderStatus;
}

/**
 * What `POST /api/orders` answers with, in either of its two successful cases.
 *
 * The union is what the *status code* distinguishes, not the body: `201` is a
 * {@link CreatedOrder} and means "this call created it"; `200` is an
 * {@link ExistingOrder} and means "this call found it". A caller that cannot
 * tell those apart cannot detect its own retry — which is the whole point of
 * sending an `Idempotency-Key` — so the split is carried by the one part of the
 * response every HTTP client already inspects, rather than by a flag in the
 * body that half of them would ignore.
 */
export type CreateOrderResponse = CreatedOrder | ExistingOrder;

/**
 * The fields an order view carries in **every** state, delivered or not.
 *
 * Split out only so {@link OrderView} can pair them with the two `status`/`code`
 * combinations below without writing them twice. Not exported: callers name
 * {@link OrderView}, which is the shape that actually goes on the wire.
 */
interface OrderViewCore {
  /** `ord_` + ULID — the id in the page's address bar. */
  readonly id: string;

  /**
   * The SKU the order was placed for, as `orders.sku` recorded it at creation.
   *
   * Also the page's fallback label when {@link OrderViewCore.product_name} is
   * `null` — see that field.
   */
  readonly sku: string;

  /**
   * The catalogue name, e.g. «CS2 Prime Status ключ» — what functional spec §2.2
   * means by *"they see the item's name"*.
   *
   * It is here so the order page can render itself from **one** request. The
   * order row does not carry a name (a copied name would go stale the moment the
   * catalogue was corrected), so the read joins `products` on the SKU — see
   * `OrdersService.findOrder`.
   *
   * **Nullable, and deliberately so.** The join is a LEFT JOIN because an order
   * is a historical record that must outlive its catalogue row
   * (`packages/db/src/schema/shop.ts`, on `orders.sku`: *"it must survive a
   * catalog row being renamed or withdrawn"*). An INNER JOIN would make a
   * withdrawn product turn a perfectly real order into a `404`, which is the one
   * answer functional spec §2.6 forbids for an order that exists. So the shop
   * says "I no longer know what this was called" and the page falls back to the
   * SKU, rather than the order vanishing.
   *
   * In this phase it is never `null`: the catalogue is seeded and nothing
   * deletes from it. The type is what keeps that from being an assumption baked
   * into the frontend.
   */
  readonly product_name: string | null;

  /**
   * **Kopecks, not roubles** — `129000` is «1 290 ₽». `orders.amount_minor`,
   * computed by the server at creation time and never recomputed here: this
   * endpoint reads the column, so the amount the page shows is the amount the
   * order was created with, whatever the catalogue has since done.
   *
   * Formatting is the frontend's job, as it is for `GET /api/products` — see
   * `CatalogProduct.price_minor` and `packages/contracts/src/money.ts`.
   */
  readonly amount_minor: MinorUnits;

  /** ISO 4217, from `orders.currency`. `RUB` throughout. */
  readonly currency: Currency;
}

/**
 * The `200` body of `GET /api/orders/:id` — everything the order status page
 * renders, in one response (technical-considerations §2.3 and §2.6, functional
 * spec §2.2 and §2.6).
 *
 * ---------------------------------------------------------------------------
 * WHY A UNION RATHER THAN `status: OrderStatus; code: string | null`
 * ---------------------------------------------------------------------------
 * *"The key is shown only once the order is delivered"* is a rule, and a rule
 * stated only in a comment is a rule someone breaks under deadline pressure. As
 * a discriminated union it is a fact the compiler checks at both ends:
 *
 *   - **Producing one:** there is no way to build a `delivered` view without a
 *     `code`, and no way to attach a `code` to any other status. The literal
 *     `null` in `OrdersService.findOrder`'s non-delivered branch is the only
 *     value that branch can return.
 *   - **Consuming one:** `apps/web` cannot read `order.code` as a string until
 *     it has narrowed on `order.status === "delivered"`, so the key markup
 *     cannot be rendered on a page that has no key to put in it.
 *
 * The wire shape is unchanged by the union: `code` is **always present**, `null`
 * until delivered. That is the stable field contract — a client that reads
 * `code` never has to ask whether the field exists yet.
 *
 * ---------------------------------------------------------------------------
 * WHAT DECIDES WHETHER THE PAGE KEEPS POLLING
 * ---------------------------------------------------------------------------
 * `status`, and nothing else. The page polls this endpoint once a second while
 * the order is in flight and stops when it settles (technical-considerations
 * §2.6); *which* statuses those are is classified once, in
 * `@game-shop/contracts` — `isSettledOrderStatus` / `settledOrderStatuses`.
 *
 * This response deliberately carries **no** `settled`, `final` or `polling`
 * boolean. A second copy of that classification on the wire is a second thing to
 * keep in step with the lifecycle, and Phase 3's `delivery_failed` would have to
 * be remembered in both places. The contracts package already makes the
 * classification exhaustive at compile time; restating it here would only give
 * it somewhere to drift to.
 */
export type OrderView =
  | (OrderViewCore & {
      /**
       * The order is delivered — terminal, and the key below is final. Reloading
       * the page in a month shows the same one (functional spec §2.4).
       */
      readonly status: typeof OrderStatus.Delivered;

      /**
       * The key the shopper bought, from `deliveries.code`.
       *
       * Guaranteed present, not merely usually: `delivering → delivered` and the
       * `deliveries` insert commit in one transaction (technical-considerations
       * §2.5 steps 5-6), so a single `SELECT` sees both or neither. An order
       * that reads `delivered` therefore has a delivery row, and
       * `OrdersService.findOrder` treats the impossible case as a `500` rather
       * than answering with a body that contradicts its own type.
       */
      readonly code: string;
    })
  | (OrderViewCore & {
      /**
       * Anything but `delivered`: `created` (awaiting payment — the state
       * functional spec §2.2 asks the page to show), `paid`, `delivering`,
       * `payment_failed` or `out_of_stock`.
       */
      readonly status: Exclude<OrderStatus, typeof OrderStatus.Delivered>;

      /**
       * No key, because none has been handed over. The `null` is produced by
       * **Postgres**, not by a filter in this application: the SELECT wraps
       * `deliveries.code` in `CASE WHEN orders.status = 'delivered'`, so a key
       * belonging to an undelivered order never crosses the wire out of the
       * database in the first place.
       */
      readonly code: null;
    });
