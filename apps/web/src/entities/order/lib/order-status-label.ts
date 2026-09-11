/**
 * The six lifecycle states, in the words a shopper reads (functional spec §2.8:
 * every string shown to a shopper is Russian).
 *
 * ---------------------------------------------------------------------------
 * WHY ALL SIX ARE HERE WHEN ONLY ONE IS REACHABLE TODAY
 * ---------------------------------------------------------------------------
 * Nothing in the shop can move an order out of `created` yet — the payment
 * controls are Slice 3 and issuance is behind them. So five of these labels are
 * unreachable through the UI as it stands.
 *
 * They are written now anyway, because the alternative is that each later slice
 * arrives with both a behaviour *and* a piece of shopper-facing copy, and the
 * copy is the half that gets written in a hurry at the end. Slices 3 and 5 add
 * a payment button and a poll; the words the shopper reads when the poll lands
 * on `out_of_stock` are already here, already Russian, already proven to render.
 *
 * ---------------------------------------------------------------------------
 * WHY A `Record<OrderStatus, string>` AND NOT A `switch` WITH A DEFAULT
 * ---------------------------------------------------------------------------
 * A total record has no fallback branch to hide in. When Phase 3 adds
 * `delivery_failed` to `OrderStatus`, this object stops compiling until someone
 * writes its Russian label — which is exactly the moment to write it. A `switch`
 * with `default: return "Неизвестный статус"` would compile, ship, and put an
 * apology on the shopper's screen instead.
 */
import { OrderStatus } from "@game-shop/contracts";

const orderStatusLabels: Readonly<Record<OrderStatus, string>> = {
  /** The state functional spec §2.2 asks the page to show on arrival. */
  [OrderStatus.Created]: "Ожидает оплаты",
  /** Money taken, key not yet handed over — the state the whole phase exists to make survivable. */
  [OrderStatus.Paid]: "Оплачен, готовим ключ",
  [OrderStatus.Delivering]: "Выдаём ключ",
  [OrderStatus.Delivered]: "Ключ выдан",
  [OrderStatus.PaymentFailed]: "Оплата не прошла",
  /**
   * Settled, but not the shopper's fault and not permanent: Phase 3's admin
   * view retries these. The wording says what happened without promising a
   * refund this phase cannot make.
   */
  [OrderStatus.OutOfStock]: "Ключей сейчас нет в наличии",
  /**
   * The other recoverable state (spec 003 §2.3): the shop could not obtain a
   * key at all — the supplier errored, timed out, or answered something the shop
   * could not read.
   *
   * It is worded as *what happened*, not *whose fault it was*, and deliberately
   * does not say «ошибка» — a shopper reading this has paid, and the one thing
   * the label must not imply is that the money went nowhere. The sentence that
   * says the payment is safe is not here: a status label is a few words in a
   * `<dd>`, and §2.3's second half needs a sentence. That lives in
   * `order-recovery-explanation.ts`, beside this file and total over the same
   * recoverable set.
   *
   * Distinct from «Ключей сейчас нет в наличии» on purpose: §2.3's second
   * criterion is that the two failures read differently, and the shopper's first
   * glance lands here rather than on the paragraph below.
   */
  [OrderStatus.DeliveryFailed]: "Не удалось выдать ключ",
};

/** The Russian label for a status — total, so every status has one. */
export function orderStatusLabel(status: OrderStatus): string {
  return orderStatusLabels[status];
}
