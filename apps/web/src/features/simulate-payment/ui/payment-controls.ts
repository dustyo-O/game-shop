/**
 * What «Оплатить успешно» and «Оплата не прошла» do, and what stands in their
 * place once the answer is in (functional spec §2.3).
 *
 * ---------------------------------------------------------------------------
 * WHY A SECOND FEATURE SLICE RATHER THAN MORE OF `buy-product`
 * ---------------------------------------------------------------------------
 * `features/buy-product` is one feature because a feature is *one thing a
 * shopper does*, and these are two different things done on two different pages
 * against two different endpoints. Folding them together would make a slice
 * whose public API is "everything a shopper can press", which is a layer, not a
 * slice.
 *
 * It could not have gone in `entities/order` either — the payment area imports
 * the simulator request, and an entity that knows how a payment is instructed is
 * an entity holding a feature's behaviour. And it could not sit on the order
 * page for the reason `buy-product` gives: the page's job is *which facts about
 * an order are shown*, this file's job is *what happens when a shopper presses
 * pay* — a request, an in-flight state, a handful of Russian sentences and a
 * refresh.
 * They change for different reasons.
 *
 * ---------------------------------------------------------------------------
 * WHY A FACTORY WHERE `buy-product` IS A FUNCTION
 * ---------------------------------------------------------------------------
 * `enableBuyControls` wires one delegated listener and never needs to remember
 * anything: the click navigates away and the page it was on ceases to exist.
 *
 * Here the page stays and re-renders under the shopper, so the two things a
 * click needs — which order to pay for, and how to tell the page to look again —
 * are bound once, at page construction, and `render(order)` stays a pure
 * function of the order it is handed. That is the whole of the factory: a
 * closure over two options. There is no store, no event bus and no component
 * base class.
 *
 * **It used to hold state, and no longer does.** Until the shop could deliver a
 * key, a successful payment left the order sitting in `created`, so this file
 * kept a page-session boolean — *this shopper has already paid on this screen* —
 * and a sentence explaining why nothing had moved. Both are gone. A successful
 * payment now moves the order to `paid` and on to `delivered` within a second,
 * and the *status* answers "has this been paid?" — for a reload, for a second
 * tab, and for a shopper who comes back next week, none of which a boolean in
 * one page's memory could ever have done.
 *
 * ---------------------------------------------------------------------------
 * HIDING THE CONTROLS IS COSMETIC — THE GUARANTEE IS IN THE DATABASE
 * ---------------------------------------------------------------------------
 * On a `payment_failed` order this file renders no buttons. That is a courtesy
 * to the shopper and **nothing else**. It is not what makes a failed order stay
 * failed, and it must not be read as if it were:
 *
 *   **What it guarantees.** A shopper looking at this page is not offered a
 *   control that would do nothing — functional spec §2.3, *"they see no controls
 *   offering to pay again"*. That is the whole of it.
 *
 *   **What it guarantees nothing about.** The endpoint. `POST /api/payments/
 *   :orderId/simulate` has never heard of this element and will happily accept
 *   the call the hidden button would have made — from `curl`, from a second tab
 *   whose copy of the page predates the failure, from a script, from anything.
 *   Each such call mints a real event and really delivers it to the webhook.
 *
 * The order does not move anyway, and the reason is a `WHERE` clause. Every
 * status change goes through the transition helper, which names the states the
 * transition may leave from; `markPaymentFailed` is `created → payment_failed`
 * and `markPaid` is `created → paid`, so an order already sitting in
 * `payment_failed` matches neither (`apps/api/src/orders/order-transitions.ts`):
 *
 *     update "orders"
 *     set "status" = $1, "updated_at" = now()
 *     where ("orders"."id" = $2 and "orders"."status" = ANY($3))
 *     returning *;
 *     -- $3 is the transition's permitted source states.
 *     -- 0 rows => the order was not in a state this transition may leave from.
 *     --           The caller does nothing. This is invariant I9: `delivered`
 *     --           and `payment_failed` are terminal, and a late or replayed
 *     --           event cannot resurrect a settled order.
 *
 * Zero rows, not an error — the event is stored, marked processed, and changes
 * nothing. That is the guarantee. This file draws the picture of it, and the
 * verification for this task deliberately bypasses the picture to show the
 * guarantee holding without it.
 */
import { OrderStatus } from "@game-shop/contracts";

import { OrderNotFoundError, type Order } from "../../../entities/order/index.js";
import { createElement } from "../../../shared/lib/dom.js";
import {
  PaymentNotDeliveredError,
  PaymentOutcome,
  simulatePayment,
} from "../api/payment-simulator-api.js";

/**
 * Every word this feature shows a shopper, in Russian (functional spec §2.8 —
 * "any message shown to them", which includes the ones nobody plans for).
 *
 * The two button labels are the spec's own wording and are not paraphrased.
 *
 * Three failure sentences rather than one, on the split the rest of this app
 * already uses — they call for different actions. A `404` means the address is
 * wrong or the order is gone, and pressing again will fail identically. A `502`
 * means the shop could not take the event this time and trying again is exactly
 * right. Everything else — the API unreachable, a `500` — is the connection, and
 * says so.
 */
const text = {
  paySuccess: "Оплатить успешно",
  payFailure: "Оплата не прошла",
  /**
   * Shown under the status line, which already reads «Оплата не прошла». It
   * deliberately does not repeat that: it adds the two things the status does
   * not say — that no key was issued, and what a shopper can do next.
   */
  failed: "Ключ не выдан. Чтобы попробовать снова, оформите новый заказ.",
  errorNotFound: "Заказ не найден. Проверьте адрес страницы.",
  errorNotDelivered: "Магазин не смог принять платёж. Попробуйте ещё раз.",
  error: "Не удалось отправить платёж. Проверьте соединение и попробуйте ещё раз.",
} as const;

/** Owned by this feature, not by the page: the messages are this behaviour's, and so are their classes. */
const rootClass = "payment-controls";
const errorClass = "payment-controls__error";

function messageFor(error: unknown): string {
  if (error instanceof OrderNotFoundError) {
    return text.errorNotFound;
  }

  if (error instanceof PaymentNotDeliveredError) {
    return text.errorNotDelivered;
  }

  return text.error;
}

/**
 * `data-outcome` carries the wire value alongside the Russian label, so a
 * browser check can target the control by what it does rather than by a sentence
 * someone may reword — the same bargain `data-sku` and `data-status` strike
 * elsewhere in this app.
 *
 * `type="button"` because a bare `<button>` inside a form defaults to `submit`.
 * There is no form on this page today; the attribute costs nothing and stops
 * that from becoming a surprise when one appears.
 */
function renderButton(label: string, outcome: PaymentOutcome): HTMLButtonElement {
  return createElement("button", {
    className: "payment-controls__button",
    text: label,
    attributes: { type: "button", "data-outcome": outcome },
  });
}

/**
 * The settled sentence that stands where the controls used to be.
 *
 * `role="status"` rather than `alert`: it appears as the result of something the
 * shopper did and it is not an emergency, so a screen reader should announce it
 * politely rather than interrupt.
 */
function renderFailedNote(): HTMLElement {
  return createElement("p", {
    className: `${rootClass}__note ${rootClass}__note--failed`,
    text: text.failed,
    attributes: { role: "status", "data-payment-note": "failed" },
  });
}

/** How the page (re-)renders the payment area from a freshly read order. */
export interface PaymentControls {
  /**
   * The payment area for this order, or `null` when the order is in a state
   * this feature has nothing to say about.
   */
  render(order: Order): HTMLElement | null;
}

export interface PaymentControlsOptions {
  readonly orderId: string;

  /**
   * Re-read the order and render it again.
   *
   * Named for what it actually knows: an event has reached the shop, so the
   * order *may* have moved — this feature is not the authority on whether it
   * did, or on how far. The page answers by asking `GET /api/orders/:id`, which
   * is.
   *
   * The page is already reading the order once a second — every order this page
   * shows a control for is, by definition, still in flight — so this does not
   * start anything. It only spends the remainder of the current second.
   *
   * DO NOT REMOVE IT. An earlier version of this comment called it a courtesy
   * rather than a mechanism, on the reasoning that the page still reaches
   * `delivered` on the next scheduled tick either way. That is true and it is
   * not the point. This callback is the only reason a shopper ever sees an
   * intermediate state at all, and spec 002 §2.5 is a criterion about exactly
   * that.
   *
   * Measured, Phase 2 Slice 4: the shop takes 25-65ms to get from answering the
   * webhook to `delivered`. The scheduled poll fires once a second, so it will
   * essentially never land inside that window. This callback fires ~10ms in —
   * the moment the simulator's request resolves, which is the moment the webhook
   * answered `200` — and its read lands mid-flight. The intermediate state then
   * stays on screen until the next scheduled read, which is where the ~1s of
   * legibility comes from: the poll's period, not the state's lifetime.
   *
   * Proven by removing it: 3 runs, 3 collapses straight from «Ожидает оплаты» to
   * «Ключ выдан» at ~990ms, no intermediate state — which is precisely the
   * Phase 1 behaviour that forced spec 001 §2.4 to be reworded for a phase.
   * Restored byte-identical: 3 of 3 intermediate states back.
   *
   * See docs/walkthrough/phase-2-slice-4-watching-the-stages.md §2 and §4.
   */
  readonly onOrderMayHaveChanged: () => void;
}

/**
 * Build the payment area for one order page.
 *
 * Called once, at page construction; its `render` is called on every load and
 * re-load of the order.
 */
export function createPaymentControls(options: PaymentControlsOptions): PaymentControls {
  function clearMessage(area: HTMLElement): void {
    area.querySelector(`.${errorClass}`)?.remove();
  }

  /**
   * The failure goes inside the payment area, under the two controls the shopper
   * just pressed, with `role="alert"` so it is announced — it appears after they
   * acted and nothing else on the page moves.
   */
  function showMessage(area: HTMLElement, message: string): void {
    area.append(
      createElement("p", { className: errorClass, text: message, attributes: { role: "alert" } }),
    );
  }

  /**
   * One payment attempt. Never rejects: both outcomes are handled here, which is
   * what lets the click handler fire it off without an `await`.
   *
   * Both controls are disabled for the length of the request, and the same
   * caveat applies as on «Купить»: within this tab a second click during an open
   * request does nothing, and that is a UX guarantee about one element. It says
   * nothing about the endpoint, which will accept a second call from anywhere
   * else — see the note at the top of this file about what does hold the line.
   *
   * On success the buttons are left disabled and the area is thrown away: the
   * refresh replaces this element with whatever the re-read order calls for. On
   * failure they are re-enabled, so the shopper is never left holding a dead
   * control.
   */
  async function send(
    area: HTMLElement,
    buttons: readonly HTMLButtonElement[],
    outcome: PaymentOutcome,
  ): Promise<void> {
    clearMessage(area);

    for (const button of buttons) {
      button.disabled = true;
    }

    try {
      await simulatePayment(options.orderId, outcome);

      options.onOrderMayHaveChanged();
    } catch (error: unknown) {
      showMessage(area, messageFor(error));

      for (const button of buttons) {
        button.disabled = false;
      }
    }
  }

  /**
   * The two controls, wired directly rather than through one delegated listener.
   *
   * `buy-product` delegates because its buttons arrive with the catalogue, after
   * the listener is wired, and can be replaced under it. These two are built
   * here, held here and replaced as a unit, so a listener per button cannot go
   * stale — there is nothing this feature owns that outlives them to delegate to.
   */
  function buildControls(): HTMLElement {
    const area = createElement("div", { className: rootClass });
    const buttons: HTMLButtonElement[] = [];

    for (const [outcome, label] of [
      [PaymentOutcome.Success, text.paySuccess],
      [PaymentOutcome.Failure, text.payFailure],
    ] as const) {
      const button = renderButton(label, outcome);

      // `buttons` is captured by reference and is complete before any click can
      // happen, so each handler disables both controls, not only its own.
      // Fire-and-forget: `send` handles both outcomes itself and never rejects.
      button.addEventListener("click", () => {
        void send(area, buttons, outcome);
      });

      buttons.push(button);
    }

    area.append(...buttons);

    return area;
  }

  return {
    /**
     * `created` is the only status that gets controls (functional spec §2.3),
     * `payment_failed` gets the sentence explaining what that means, and
     * everything else gets nothing.
     *
     * The `null` is a deliberate default rather than an oversight. `paid`,
     * `delivering`, `delivered` and `out_of_stock` are states this feature has
     * nothing to say about: what they need is a progress line and a key, and
     * both of those are the order's own data, rendered by `entities/order`. A
     * status this file has never heard of showing no payment controls is the
     * right failure, where an `assertNever` would put a thrown error on a
     * shopper's screen for a state the shop understands perfectly well.
     *
     * There is no longer any "I have already pressed pay" branch here, and none
     * is wanted: after a successful payment the order is no longer `created`, so
     * this returns `null` and the status line above it — «Оплачен, готовим
     * ключ» — says what happened, in a way that survives a reload and is the
     * same in every tab.
     */
    render(order: Order): HTMLElement | null {
      if (order.status === OrderStatus.PaymentFailed) {
        return renderFailedNote();
      }

      if (order.status !== OrderStatus.Created) {
        return null;
      }

      return buildControls();
    },
  };
}
