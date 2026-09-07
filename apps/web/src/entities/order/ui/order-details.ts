/**
 * One order's facts: what was bought, what it costs, where it is, and — once the
 * shop has handed it over — the key (functional spec §2.2, *"they see the item's
 * name, the amount to pay, and that the order is waiting for payment"*, and §2.4,
 * *"the order page shows the order as delivered together with the key"*).
 *
 * A `<dl>` because that is what this is: a short list of labelled values. It gives a
 * screen reader the pairing for free, and it keeps the Russian label attached to
 * its value rather than to a stylesheet.
 *
 * Plain by design (functional spec §3, "Plain, functional pages"). Unlike the
 * catalogue, this page is *not* redressed in Phase 4 — technical-considerations
 * §2.6 gives the status page a working view and nothing more — so plain here
 * means finished, not provisional.
 */
import { OrderStatus } from "@game-shop/contracts";

import { createElement } from "../../../shared/lib/dom.js";
import { formatPrice } from "../../../shared/lib/format-price.js";
import { orderStatusLabel } from "../lib/order-status-label.js";
import type { Order } from "../model/order.js";

const labels = {
  product: "Товар",
  amount: "Сумма",
  status: "Статус",
  /** The thing the shopper actually bought (functional spec §2.4). */
  code: "Ключ",
  orderId: "Номер заказа",
} as const;

function renderRow(label: string, value: HTMLElement): readonly Node[] {
  return [createElement("dt", { className: "order-details__label", text: label }), value];
}

/**
 * The key row, or nothing at all.
 *
 * **The narrowing is the feature.** `order.code` is a `string` only inside the
 * `delivered` branch of {@link Order}, so this row cannot be built for an order
 * that has no key — not by mistake, not under a deadline. An undelivered order
 * gets no «Ключ» line rather than an empty one, which is also the honest
 * rendering of `payment_failed` and `out_of_stock`: there is no key, so the page
 * does not name one.
 *
 * `data-order-code` is the machine handle, as `data-status` is above: a check
 * can read the key without depending on the Russian label beside it.
 * Monospace, via the stylesheet, for the same reason the order id is — a shopper
 * copies this string out by eye or by hand.
 */
function renderCodeRow(order: Order): readonly Node[] {
  if (order.status !== OrderStatus.Delivered) {
    return [];
  }

  return renderRow(
    labels.code,
    createElement("dd", {
      className: "order-details__value order-details__value--code",
      text: order.code,
      attributes: { "data-order-code": order.code },
    }),
  );
}

/**
 * Render the order's fields.
 *
 * `data-status` carries the raw lifecycle value alongside the Russian label so a
 * browser check — and the poll, watching the page change under it — can assert
 * on `created` rather than on a sentence someone may reword. The label is what a
 * shopper reads; the attribute is what a machine reads.
 *
 * **The key is one of these fields, not a separate view.** It is a fact about
 * the order exactly as the amount and the status are, it arrives in the same
 * response, and it is presentation of an entity's data — so it is rendered here,
 * in the entity's own `ui` segment, and appears only in the state that has one
 * (see {@link renderCodeRow}). The page below composes; it does not decide
 * whether a key is shown.
 *
 * The name falls back to the SKU when the catalogue no longer has a row for it
 * (see {@link Order.productName}); showing the order's own SKU is a truthful
 * answer, where an empty line would look like a bug.
 */
export function renderOrderDetails(order: Order): HTMLElement {
  return createElement("dl", { className: "order-details" }, [
    ...renderRow(
      labels.product,
      createElement("dd", {
        className: "order-details__value order-details__value--product",
        text: order.productName ?? order.sku,
      }),
    ),
    ...renderRow(
      labels.amount,
      createElement("dd", {
        className: "order-details__value order-details__value--amount",
        text: formatPrice(order.amountMinor, order.currency),
      }),
    ),
    ...renderRow(
      labels.status,
      createElement("dd", {
        className: "order-details__value order-details__value--status",
        text: orderStatusLabel(order.status),
        attributes: { "data-status": order.status },
      }),
    ),
    ...renderCodeRow(order),
    ...renderRow(
      labels.orderId,
      createElement("dd", {
        className: "order-details__value order-details__value--id",
        text: order.id,
      }),
    ),
  ]);
}
