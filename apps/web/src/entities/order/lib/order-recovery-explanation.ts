/**
 * The sentence a shopper reads under the status line when their paid order could
 * not be delivered (functional spec §2.3).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT PART OF `order-status-label.ts`
 * ---------------------------------------------------------------------------
 * A status label is a few words in a `<dd>` — «Ключей сейчас нет в наличии».
 * §2.3 asks for three things a label of that size cannot carry:
 *
 *   - that delivery did not succeed **and the shop is dealing with it** (first
 *     criterion),
 *   - a reason a shopper can tell apart from the other failure (second),
 *   - that the payment is still recorded against the order (fourth).
 *
 * So this is a second table, keyed by the same status, holding the sentence. The
 * label answers *where is my order*; this answers *what happens now*.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS TOTAL OVER `RecoverableOrderStatus` AND NOT OVER `OrderStatus`
 * ---------------------------------------------------------------------------
 * Only a recoverable order has anything to explain. `delivered` needs no
 * apology, `payment_failed` already has its own sentence in
 * `features/simulate-payment`, and `created`/`paid`/`delivering` are not
 * failures at all. Typing this over the whole lifecycle would force five
 * placeholder strings whose only job is to satisfy the compiler — and a
 * placeholder is exactly the kind of string that reaches a shopper.
 *
 * Keyed over the recoverable set instead, it buys the same tripwire in the place
 * that matters: **a third recoverable status stops this file compiling** until
 * someone writes what the shop will do about it, exactly as a seventh
 * `OrderStatus` stops `order-status-label.ts` compiling. There is no `default`
 * branch here to hide an apology in, for the reason that file's header gives.
 *
 * ---------------------------------------------------------------------------
 * THE THREE PROPERTIES THE TWO SENTENCES SHARE — PRESERVE THEM IF YOU REWORD
 * ---------------------------------------------------------------------------
 *   1. **Both open with «Оплата прошла».** §2.3's fourth criterion is that the
 *      payment stays recorded rather than being discarded; the database holds
 *      that, and this is where the shopper is told. It comes first because it is
 *      the thing they are most afraid of.
 *   2. **They differ in exactly the clause §2.3's second criterion asks about**
 *      — *ключей сейчас нет* against *сбой на стороне поставщика* — and are
 *      otherwise deliberately parallel. Two failures that read identically fail
 *      that criterion; two that are worded differently all the way through make
 *      the difference harder to spot, not easier.
 *   3. **Neither promises a refund or an email.** Spec 003 §3 puts both out of
 *      scope, and the shop can deliver neither — a sentence that promises one is
 *      a sentence that becomes a lie the moment it is read.
 *
 * Each ends with «страница обновится сама», which is a statement of fact rather
 * than reassurance: the page keeps reading the order, so an operator's retry
 * arrives without the shopper doing anything.
 */
import { OrderStatus, type RecoverableOrderStatus } from "@game-shop/contracts";

const orderRecoveryExplanations: Readonly<Record<RecoverableOrderStatus, string>> = {
  /** The supplier's pool was empty. Nothing is broken; there is simply nothing to hand over yet. */
  [OrderStatus.OutOfStock]:
    "Оплата прошла, но ключей для этого товара сейчас нет. Заказ не потерян: как только ключи появятся, мы выдадим ваш — страница обновится сама.",
  /** The shop could not obtain a key at all: the supplier errored, timed out, or answered unreadably. */
  [OrderStatus.DeliveryFailed]:
    "Оплата прошла, но выдать ключ не удалось из-за сбоя на стороне поставщика. Заказ не потерян: мы уже занимаемся этим — страница обновится сама.",
};

/**
 * What the shop will do about a recoverable order, in the shopper's words.
 *
 * Total over the recoverable set, so this cannot return `undefined` and has no
 * fallback string to return instead. Callers that hold an arbitrary
 * {@link OrderStatus} narrow with `isRecoverableOrderStatus` first — see
 * `../ui/order-recovery-notice.ts`, which is the only caller.
 */
export function orderRecoveryExplanation(status: RecoverableOrderStatus): string {
  return orderRecoveryExplanations[status];
}
