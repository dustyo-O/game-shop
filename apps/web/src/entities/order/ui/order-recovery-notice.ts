/**
 * The paragraph under a stuck order that says what the shop is doing about it
 * (functional spec §2.3), or nothing at all when the order is not stuck.
 *
 * ---------------------------------------------------------------------------
 * WHY `role="status"` AND NOT `role="alert"`
 * ---------------------------------------------------------------------------
 * The same reason `order__notice` gives on the page above: **nothing was lost
 * and the page is still working.** `alert` interrupts a screen reader mid
 * sentence and is for things that need acting on now. This needs no action —
 * the payment is recorded, an operator retries it, and the page reads the order
 * until it moves. Announcing it politely, after whatever the shopper was
 * reading, is the accurate volume.
 *
 * It is a live region at all because the paragraph appears *while the shopper is
 * looking at the page*: a `paid` order can become `delivery_failed` under them
 * with nothing clicked. Text that arrives silently is text a screen reader user
 * never learns arrived.
 *
 * ---------------------------------------------------------------------------
 * WHY `data-order-recovery` CARRIES THE STATUS
 * ---------------------------------------------------------------------------
 * The same bargain `data-status` and `data-order-code` strike elsewhere: a check
 * asserts that the **right** explanation rendered — `out_of_stock`'s and not
 * `delivery_failed`'s — without pinning itself to a sentence anyone may reword.
 * The Russian is what a shopper reads; the attribute is what a machine reads,
 * and §2.3's second criterion is precisely a claim about the two being
 * different.
 *
 * ---------------------------------------------------------------------------
 * WHY IT LIVES IN `entities/order` AND NOT ON THE PAGE
 * ---------------------------------------------------------------------------
 * It is presentation of an order's own data, decided entirely by the order's
 * status — exactly like the key row in `order-details.ts`. The page composes it;
 * it does not decide whether a shopper is owed an explanation. That also keeps
 * the words next to the label they sit under, in the slice that owns both.
 */
import { isRecoverableOrderStatus } from "@game-shop/contracts";

import { createElement } from "../../../shared/lib/dom.js";
import { orderRecoveryExplanation } from "../lib/order-recovery-explanation.js";
import type { Order } from "../model/order.js";

/** Distinct from the page's `order__notice` on purpose — see `showOrder`, which removes that one by class. */
const rootClass = "order-recovery";

/**
 * The recovery notice for `order`, or `null` when there is nothing to explain.
 *
 * `null` rather than an empty element, so a delivered order's page carries no
 * empty live region a screen reader has to step through. The narrowing is what
 * makes the call to {@link orderRecoveryExplanation} legal: that table is total
 * over the recoverable set only, so this guard is not a formality — it is the
 * proof that the status has a sentence at all.
 */
export function renderOrderRecoveryNotice(order: Order): HTMLElement | null {
  const { status } = order;

  if (!isRecoverableOrderStatus(status)) {
    return null;
  }

  return createElement("p", {
    className: rootClass,
    text: orderRecoveryExplanation(status),
    attributes: { role: "status", "data-order-recovery": status },
  });
}
