/**
 * The storefront's half of the two order endpoints: creating one with
 * `POST /api/orders`, and reading one back from `GET /api/orders/:id`.
 *
 * `GET` answers a single JSON object with snake_case wire fields, or a `404`
 * for an id that identifies nothing. `POST` takes `{ sku }` and an
 * `Idempotency-Key` header, and answers `201` with the order it created, `200`
 * with the order that key had already created, or `422` for a SKU the shop will
 * not sell (technical-considerations §2.1 and §2.3). This file is the only place
 * that knows any of that, and the only place where an untyped `unknown` becomes
 * an {@link Order}.
 *
 * **Why creation lives here rather than in the feature that calls it.**
 * `features/buy-product` owns the *behaviour* — disable the control, navigate,
 * word the failure in Russian — and this segment owns the *endpoint*. The two
 * requests speak the same resource, share the parsing helpers below and share
 * the `HttpError`-to-named-error mapping; moving one of them up a layer would
 * mean either duplicating those or a feature reaching into an entity's
 * internals. The rule, stated once: an entity's `api` segment holds the requests
 * that read and write that entity; a feature holds what a shopper's click does
 * with them.
 *
 * **Why parse rather than assert**, in short — the long version is in
 * `entities/product/api/products-api.ts`: `body as Order` compiles against an
 * HTML error page and against a status the shop has never heard of, and each
 * would surface as `undefined` in the middle of the order page rather than here,
 * where it becomes a sentence the shopper can act on.
 *
 * **Why the parser is written out again** instead of sharing the product
 * parser's helpers: the two endpoints have different field sets, and what would
 * actually be shared is five lines of `typeof` checks whose error strings name
 * the slice they came from. A third parser is the moment to lift them into
 * `shared/`; two is not.
 */
import { Currency, isOrderStatus, minorUnits, OrderStatus } from "@game-shop/contracts";

import { getJson, HttpError, postJson } from "../../../shared/api/http.js";
import type { Order } from "../model/order.js";

const notFoundStatus = 404;
const unprocessableStatus = 422;

/** The response did not have the shape `GET /api/orders/:id` promises. */
export class OrderResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderResponseError";
  }
}

/**
 * The API answered `404`: there is no order with this id.
 *
 * Thrown from `fetchOrder` below, and reused by
 * `features/simulate-payment` when the simulator answers `404` for the same
 * reason — *there is no order with this id* is one fact whichever endpoint
 * reports it, and one class is what lets a caller branch on it without
 * translating between two.
 *
 * A **separate class**, not a flag on a generic failure, because it is the one
 * outcome the order page must tell apart from every other (functional spec
 * §2.6). «Заказ не найден» is a final answer — refreshing will not help — while
 * an unreachable API is a temporary one that will. One error type with a status
 * field would let the page get that distinction wrong silently; two types make
 * the branch the compiler's business.
 *
 * The API's own `404` body is developer-facing English
 * (`no order with id "ord_bogus"`) and is deliberately **not** carried into the
 * page — see `OrdersController.getOrder`. The Russian the shopper reads is
 * written by the page.
 */
export class OrderNotFoundError extends Error {
  constructor(readonly orderId: string) {
    super(`no order with id "${orderId}"`);
    this.name = "OrderNotFoundError";
  }
}

/**
 * The API answered `422`: there is no *purchasable* product with that SKU.
 *
 * A separate class for the same reason {@link OrderNotFoundError} is one — it is
 * the one creation failure that is not about the connection and will not be
 * fixed by trying again. The shop renders «Купить» only where
 * `GET /api/products` said `purchasable`, so a shopper can only reach this by
 * clicking a control the catalogue has since outgrown: the item was withdrawn,
 * or the page has been open since before it was. That makes «обновите страницу»
 * the useful thing to say, where «попробуйте ещё раз» would invite the shopper
 * to click a button that will fail identically for as long as the page is open.
 *
 * Unknown SKU and display-only SKU both land here, because `POST /api/orders`
 * deliberately gives them the same code — see `OrdersController.createOrder`:
 * they are one fact, *there is no purchasable product with that SKU*.
 *
 * As with the `404`, the API's own body is developer-facing English
 * (`no purchasable product with sku "KEY-CS2-PRIME"`) and is not carried into
 * the page. The Russian the shopper reads is written by the feature.
 */
export class ProductNotPurchasableError extends Error {
  constructor(readonly sku: string) {
    super(`no purchasable product with sku "${sku}"`);
    this.name = "ProductNotPurchasableError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OrderResponseError(`order: expected an object, got ${typeof value}`);
  }

  // Safe after the check above: an object with unknown-valued keys is the
  // weakest true statement about it, and every field below is still narrowed.
  return value as Record<string, unknown>;
}

function readString(row: Record<string, unknown>, field: string): string {
  const value = row[field];

  if (typeof value !== "string") {
    throw new OrderResponseError(`order.${field}: expected a string, got ${typeof value}`);
  }

  return value;
}

/**
 * `product_name` is the one field the API is allowed to send as `null` — see
 * {@link Order.productName}. `null` and "absent" are folded together on purpose:
 * both mean the page shows the SKU instead.
 */
function readProductName(row: Record<string, unknown>): string | null {
  const value = row["product_name"];

  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string") {
    throw new OrderResponseError(`order.product_name: expected a string or null, got ${typeof value}`);
  }

  return value;
}

/**
 * The one place a raw JSON number becomes a branded amount.
 *
 * The finiteness check is not ceremony: `JSON.parse` cannot produce `NaN`, but
 * it happily produces `null`, and `minorUnits(null as never)` would sail through
 * to `formatPrice` and render «null ₽» where the amount to pay belongs.
 */
function readAmountMinor(row: Record<string, unknown>): Order["amountMinor"] {
  const value = row["amount_minor"];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new OrderResponseError(`order.amount_minor: expected a finite number, got ${typeof value}`);
  }

  return minorUnits(value);
}

function readCurrency(row: Record<string, unknown>): Currency {
  const value = readString(row, "currency");

  if (value !== Currency.Rub) {
    throw new OrderResponseError(`order.currency: unsupported currency "${value}"`);
  }

  return value;
}

/**
 * `isOrderStatus` comes from `@game-shop/contracts`, so the check is against the
 * same six strings the database's CHECK constraint holds. A seventh status
 * reaching the browser is a shop that has outgrown this bundle, and it is caught
 * here rather than rendering a blank «Статус».
 */
function readStatus(row: Record<string, unknown>): OrderStatus {
  const value = row["status"];

  if (!isOrderStatus(value)) {
    throw new OrderResponseError(`order.status: unknown status ${JSON.stringify(value)}`);
  }

  return value;
}

/**
 * The key, and the one place the wire's `code` becomes {@link Order}'s.
 *
 * The wire carries `code` on **every** order — `null` until `delivered` — so
 * this never asks whether the field exists, only what it is allowed to be:
 *
 *   - **`delivered`:** a non-empty string, or the response is rejected. An
 *     order that says it is delivered and hands over no key is a body that
 *     contradicts its own contract, and it is caught here rather than rendering
 *     «Ключ» with nothing after it. The API treats the same impossibility as a
 *     `500` on its side (`OrdersService.findOrder`).
 *   - **anything else:** `null`, whatever arrived. Postgres already refuses to
 *     emit a key for an undelivered order (the `CASE WHEN orders.status =
 *     'delivered'` in the SELECT), and pinning it again here means a server that
 *     one day lost that `CASE` still could not show a shopper a key before the
 *     shop has decided it is theirs.
 */
function toOrder(value: unknown): Order {
  const row = asRecord(value);

  const core = {
    id: readString(row, "id"),
    sku: readString(row, "sku"),
    productName: readProductName(row),
    amountMinor: readAmountMinor(row),
    currency: readCurrency(row),
  };

  const status = readStatus(row);

  if (status === OrderStatus.Delivered) {
    const code = row["code"];

    if (typeof code !== "string" || code === "") {
      throw new OrderResponseError(
        `order.code: a delivered order must carry a non-empty key, got ${JSON.stringify(code)}`,
      );
    }

    return { ...core, status, code };
  }

  return { ...core, status, code: null };
}

/**
 * One order by id.
 *
 * Rejects with {@link OrderNotFoundError} when the API says `404`, and with
 * whatever went wrong otherwise — {@link OrderResponseError} for a body that is
 * not an order, `HttpError` for any other refusal, a `TypeError` from `fetch`
 * when the API cannot be reached at all. The page shows one message for the
 * first and one for all the rest, which is the distinction functional spec §2.6
 * actually draws.
 *
 * The id is encoded on the way into the URL. In practice `ord_` + ULID contains
 * nothing that needs it, but the id here came out of the address bar, and an
 * address bar holds whatever a shopper pasted into it.
 *
 * **`signal` is how the status page's poll lets go.** The page reads this
 * endpoint once a second while the order is still moving, and when it stops —
 * the order settled, the document is unloading, the element was detached — it
 * aborts, and any read still in flight is cancelled rather than left to resolve
 * into a page nobody is looking at. `fetch` then rejects with an `AbortError`,
 * which is why the caller checks `signal.aborted` before treating a rejection
 * as a failure worth telling a shopper about.
 */
export async function fetchOrder(orderId: string, signal?: AbortSignal): Promise<Order> {
  try {
    return toOrder(await getJson(`/api/orders/${encodeURIComponent(orderId)}`, signal));
  } catch (error: unknown) {
    if (error instanceof HttpError && error.status === notFoundStatus) {
      throw new OrderNotFoundError(orderId);
    }

    throw error;
  }
}

/**
 * Create an order for `sku`, and answer the new order's id.
 *
 * **Only the id is read out of the `201` body**, on purpose. That body also
 * carries the sku, the amount, the currency and a status that is always
 * `created` — and the caller's very next move is to hand the shopper to
 * `/order/{id}`, where `fetchOrder` reads all of it back from the endpoint that
 * owns the page's shape. Parsing the rest here would populate an object no line
 * of code reads, and would give the storefront a second, subtly different order
 * type to keep in step with the first (`apps/api/src/orders/orders.types.ts`
 * makes the same argument from the API's side).
 *
 * Rejects with {@link ProductNotPurchasableError} when the API says `422`, and
 * with whatever went wrong otherwise — {@link OrderResponseError} for a `201`
 * whose body carries no string id, `HttpError` for any other refusal, a
 * `TypeError` from `fetch` when the API cannot be reached at all. The feature
 * that calls this shows one Russian sentence for the first and one for the rest,
 * which is the only distinction a shopper can act on.
 *
 * ### `idempotencyKey` — what makes calling this twice safe
 *
 * The header names the shopper's *intent* to buy this thing once, and
 * `orders.client_request_id UNIQUE` is what turns two requests carrying it into
 * one order: the second insert loses at the index and the API reads the winner
 * back. That is the only place the guarantee can live — two simultaneous
 * requests meet at the row and nowhere else — and this function's whole part in
 * it is putting the value on the wire.
 *
 * **Required, not optional.** The API accepts the header's absence and still
 * creates an order (assumption A3, kept for the scripts and for Phase 1's
 * callers), so an optional parameter here would compile at every call site and
 * silently give up the guarantee at any one that forgot. There is exactly one
 * caller, it is `features/buy-product`, and it has a key.
 *
 * **This function does not mint it and must not.** A key minted here would be
 * minted per *call*, which is the failure the header exists to prevent: a
 * double-click would produce two keys, two orders, and a mechanism that looks
 * like it is working. The key is a property of the shopper's intent, so it is
 * owned by the feature that owns the click — see
 * `features/buy-product/lib/purchase-intent.ts`.
 *
 * ### `201` and `200` are both success here, deliberately
 *
 * The API answers `201` when this call created the order and `200` when the key
 * had already created it (`OrdersController.createOrder`). `postJson` gates on
 * `response.ok`, so both arrive here as a body, and both bodies carry the same
 * `id`. The caller navigates to the same page either way and says nothing about
 * which it got — functional spec §2.1's last criterion: a repeated attempt reads
 * exactly as a first one would have.
 *
 * The distinction is not lost, only unused by the storefront: the race scripts
 * and the API tests read the status code, which is what makes "one intent, one
 * order" observable rather than assumed.
 */
export async function createOrder(sku: string, idempotencyKey: string): Promise<string> {
  try {
    return readString(
      asRecord(await postJson("/api/orders", { sku }, { "Idempotency-Key": idempotencyKey })),
      "id",
    );
  } catch (error: unknown) {
    if (error instanceof HttpError && error.status === unprocessableStatus) {
      throw new ProductNotPurchasableError(sku);
    }

    throw error;
  }
}
