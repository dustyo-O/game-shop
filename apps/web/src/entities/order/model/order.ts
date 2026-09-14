/**
 * An order as the storefront holds it — the frontend's half of
 * `GET /api/orders/:id` (`apps/api/src/orders/orders.types.ts`, `OrderView`).
 *
 * Mirrored rather than imported, for the reason `entities/product/model` gives
 * about `CatalogProduct`: `apps/web` is not a dependent of `apps/api` and must
 * not become one. The two agree because they name the same fields, and the
 * parser in `../api/order-api.ts` is where that agreement is checked at run
 * time instead of assumed.
 *
 * What *is* imported is `@game-shop/contracts` — `MinorUnits` so nothing treats
 * 129000 as roubles, and `OrderStatus` because the lifecycle is a contract the
 * shop shares with itself across three codebases and a CHECK constraint. A
 * frontend copy of those six strings would be a seventh place for them to drift.
 */
import type { Currency, MinorUnits, OrderStatus } from "@game-shop/contracts";

/**
 * A promo code as it stands on one order — the storefront's half of
 * `AppliedPromoView` in `apps/api/src/orders/orders.types.ts`.
 *
 * Three fields and an identity between them that the database enforces
 * (`promo_redemptions_discount_range`): `discountMinor` is what actually came
 * off, `listAmountMinor` is what the order cost before, and the order's own
 * `amountMinor` is their difference. The page never computes any of the three;
 * it prints what it was given (functional spec §2.3, *"the page only displays
 * it"*). That is why `discountMinor` is here at all rather than
 * being derived on the page from the other two: a derived figure would be the
 * first number in this storefront that the server did not decide.
 *
 * `discountMinor` may be `0` — an amount-typed code clamped against a price it
 * exceeds — and the render treats that as "a code, but nothing to strike out".
 */
export interface AppliedPromo {
  /** The code as the shop stores it — trimmed, upper-case — e.g. «LIMIT3». Not what the shopper typed. */
  readonly code: string;

  /** **Kopecks.** The discount taken off, already clamped to the list price. `promo_redemptions.discount_minor`. */
  readonly discountMinor: MinorUnits;

  /** **Kopecks.** The order's `amount_minor` as it stood before the code. `promo_redemptions.list_amount_minor`. */
  readonly listAmountMinor: MinorUnits;
}

/**
 * The fields an order carries in **every** state, delivered or not.
 *
 * Split out only so {@link Order} can pair them with the two `status`/`code`
 * combinations below without writing them twice. Not exported: callers name
 * {@link Order}, which is the shape the page actually renders.
 */
interface OrderCore {
  /** `ord_` + ULID — the id in the page's address bar. */
  readonly id: string;

  /** The SKU the order was placed for, and the page's fallback label — see {@link OrderCore.productName}. */
  readonly sku: string;

  /**
   * The catalogue name, e.g. «CS2 Prime Status ключ» — what functional spec
   * §2.2 means by *"they see the item's name"*.
   *
   * **Nullable**, because the API's join is a LEFT JOIN: an order is a
   * historical record that outlives its catalogue row, so a withdrawn product
   * must not turn a real order into a `404`. The shop says "I no longer know
   * what this was called" and the page falls back to the SKU. Unreachable in
   * this phase — nothing deletes from the seeded catalogue — and typed anyway
   * so that stays a fact rather than an assumption.
   */
  readonly productName: string | null;

  /**
   * **Kopecks.** `129000` is «1290 ₽». `orders.amount_minor` — **the amount to
   * pay**, as the column holds it now. Recorded from the catalogue at creation
   * and, since spec 005, changed exactly once if a promo code is applied while
   * the order is still `created`: the API reprices the column under the order
   * lock and the payment path reads it back without recomputing anything
   * (technical-considerations §2.2). So this is the discounted amount whenever
   * {@link OrderCore.promo} is set, and the list price is then only reachable
   * through `promo.listAmountMinor`; whatever the catalogue has since done to
   * the product's price changes neither.
   *
   * Named `amountMinor` where the wire calls it `amount_minor`: the snake_case
   * belongs to the JSON, and it stops at the parser.
   */
  readonly amountMinor: MinorUnits;

  readonly currency: Currency;

  /**
   * The promo code applied to this order, or `null` — which is what every order
   * carries until a code is applied, and what most carry forever.
   *
   * **On `OrderCore`, not on a status branch, deliberately.** A redemption is a
   * fact about the order from the moment it lands until the row is gone: it is
   * `created` when the code goes on, it is still there when the order is
   * `paid`, `delivered`, even `payment_failed`. Typing it on the core is what
   * makes `renderOrderDetails`'s «Промокод» row a check on `order.promo`, never
   * on `order.status` — the row survives `paid → delivered` because nothing
   * about it ever depended on the status (technical-considerations §2.4).
   *
   * `null` here is the wire's `null` and *also* the wire's absence: the parser
   * folds the two so the page has one shape to render, not two to ask about.
   */
  readonly promo: AppliedPromo | null;
}

/**
 * One order, as the status page renders it.
 *
 * ---------------------------------------------------------------------------
 * WHY A UNION RATHER THAN `status: OrderStatus; code: string | null`
 * ---------------------------------------------------------------------------
 * The API models the same fact as a union and for the same reason
 * (`apps/api/src/orders/orders.types.ts`, `OrderView`): *"the key is shown only
 * once the order is delivered"* is a rule, and a rule stated in a comment is a
 * rule someone breaks under deadline pressure. Here it is the compiler's:
 * `order.code` is not a `string` anywhere until the code has narrowed on
 * `status === "delivered"`, so the key markup **cannot** be rendered onto a page
 * that has no key to put in it. That is the whole of functional spec §2.4's
 * "together with the key" and technical-considerations §2.3's *includes `code`
 * only once `delivered`* — enforced rather than remembered.
 *
 * Mirroring the API's shape also means the two ends fail to compile together
 * rather than disagreeing quietly, which is the only kind of duplication worth
 * having across a wire.
 *
 * The parser is what makes the narrowing honest: `../api/order-api.ts` builds
 * one branch or the other from the response, and refuses a `delivered` body
 * with no key rather than handing the page an object whose type lies.
 */
export type Order =
  | (OrderCore & {
      /**
       * Terminal, and the key below is final: reloading the page in a month
       * shows the same one (functional spec §2.4, last two criteria). The page
       * stops polling here — see `isTerminalOrderStatus` in `@game-shop/contracts`.
       */
      readonly status: typeof OrderStatus.Delivered;

      /** The key the shopper bought, from `deliveries.code` on the API side. */
      readonly code: string;
    })
  | (OrderCore & {
      /**
       * Anything but `delivered`: `created` (awaiting payment), `paid`,
       * `delivering`, `payment_failed` or `out_of_stock`. Rendered through
       * `../lib/order-status-label.ts`, which has a Russian label for every one
       * of the six.
       */
      readonly status: Exclude<OrderStatus, typeof OrderStatus.Delivered>;

      /**
       * No key, because none has been handed over.
       *
       * The API produces this `null` in Postgres — the SELECT wraps
       * `deliveries.code` in `CASE WHEN orders.status = 'delivered'`, so a key
       * belonging to an undelivered order never leaves the database. The parser
       * pins it to `null` here a second time, so a server that one day forgot
       * that `CASE` still could not put a key on this page early.
       */
      readonly code: null;
    });
