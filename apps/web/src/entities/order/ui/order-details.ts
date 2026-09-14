/**
 * One order's facts: what was bought, what it costs, where it is, and — once the
 * shop has handed it over — the key (functional spec §2.2, *"they see the item's
 * name, the amount to pay, and that the order is waiting for payment"*, and §2.4,
 * *"the order page shows the order as delivered together with the key"*). Since
 * spec 005, also which promo code is on it and what it took off (functional
 * spec 005 §2.2 and §2.3: the code, the discount, the amount before and after,
 * shown from the moment it is applied and still shown once delivered).
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
  /** The applied code and its discount — present only while `order.promo` is (spec 005). */
  promo: "Промокод",
  status: "Статус",
  /** The thing the shopper actually bought (functional spec §2.4). */
  code: "Ключ",
  orderId: "Номер заказа",
} as const;

function renderRow(label: string, value: HTMLElement): readonly Node[] {
  return [createElement("dt", { className: "order-details__label", text: label }), value];
}

/**
 * The «Сумма» value: the amount to pay, and — when a code took something off —
 * the list price beside it, struck through by the stylesheet.
 *
 * `data-amount-minor` carries the kopecks so a check can assert `96750` rather
 * than parse «967,50 ₽» back into a number; `data-list-amount-minor` on the
 * span does the same for the price before the code. Both figures are printed
 * exactly as the shop sent them (technical-considerations §2.4's table) — this
 * function subtracts nothing, and it must not: the page is the one place in the
 * storefront that never decides a price.
 *
 * The span is gated on `discountMinor > 0`, not on the promo's presence. A
 * fixed-sum code clamped against a smaller price applies with a discount of
 * zero, and «1290 ₽ (было 1290 ₽)» would be a page contradicting itself for the
 * sake of a rule. The «Промокод» row still shows the code in that case — it *is*
 * on the order — with «скидка 0 ₽» as the truthful figure.
 *
 * The trailing space in the text is the separator between the two figures; it
 * is in `textContent`, not in the stylesheet, so a text match on
 * «967,50 ₽ (было 1290 ₽)» reads as one sentence.
 */
function renderAmountValue(order: Order): HTMLElement {
  const amount = formatPrice(order.amountMinor, order.currency);
  const listAmount =
    order.promo !== null && order.promo.discountMinor > 0
      ? createElement("span", {
          className: "order-details__list-amount",
          text: `(было ${formatPrice(order.promo.listAmountMinor, order.currency)})`,
          attributes: { "data-list-amount-minor": String(order.promo.listAmountMinor) },
        })
      : null;

  return createElement(
    "dd",
    {
      className: "order-details__value order-details__value--amount",
      text: listAmount === null ? amount : `${amount} `,
      attributes: { "data-amount-minor": String(order.amountMinor) },
    },
    listAmount === null ? [] : [listAmount],
  );
}

/**
 * The «Промокод» row, or nothing at all.
 *
 * **Gated on `order.promo`, never on `order.status`.** A redemption is a fact
 * about the order that outlives every transition — it is there at `created`,
 * still there at `paid`, still there at `delivered` (functional spec 005 §2.3,
 * last criterion: *"the discounted amount and the code are still shown"*). A
 * status gate here would be the bug technical-considerations §2.4 names: the
 * row appearing on the awaiting-payment page and vanishing the moment the poll
 * paints «Ключ выдан». `renderCodeRow` below is gated on status because a
 * *key* exists only in one state; a promo exists in all of them once applied.
 *
 * `data-promo-code` and `data-discount-minor` are the machine handles, as
 * `data-status` and `data-order-code` are: a check reads the code and the
 * kopecks without depending on the Russian sentence beside them. The sentence
 * itself — «LIMIT3 — скидка 322,50 ₽» — is one `dd`, not two, because it is
 * one fact: *this code, this much off*.
 */
function renderPromoRow(order: Order): readonly Node[] {
  if (order.promo === null) {
    return [];
  }

  return renderRow(
    labels.promo,
    createElement("dd", {
      className: "order-details__value order-details__value--promo",
      text: `${order.promo.code} — скидка ${formatPrice(order.promo.discountMinor, order.currency)}`,
      attributes: {
        "data-promo-code": order.promo.code,
        "data-discount-minor": String(order.promo.discountMinor),
      },
    }),
  );
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
 * whether a key is shown. **The promo is the same kind of field** — it arrives
 * in the same response and it is the entity's data — and it is rendered here
 * for the same reason (see {@link renderPromoRow}), which is also why
 * `features/apply-promo` renders nothing once a code is on: the entity's row
 * *is* the applied state, shown in the form's place.
 *
 * Row order — Товар · Сумма · Промокод · Статус · Ключ · Номер заказа — puts the
 * code directly under the amount it changed, and before the status because a
 * shopper reads *what and how much* before *where it is*.
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
    ...renderRow(labels.amount, renderAmountValue(order)),
    ...renderPromoRow(order),
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
