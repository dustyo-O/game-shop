/**
 * What the promo-code field on the order page does: send the code to the shop
 * and ask the page to look at the order again (functional spec 005 §2.2,
 * technical-considerations §2.4).
 *
 * ---------------------------------------------------------------------------
 * WHY A FEATURE SLICE, WHEN `applyPromo` ALREADY LIVES IN THE ENTITY
 * ---------------------------------------------------------------------------
 * The *request* is the entity's — `entities/order/api/order-api.ts` holds every
 * call that reads or writes the order, and parsing the response needs its
 * private `toOrder`. What is here is the *behaviour around* the request: a
 * field, an in-flight state, four Russian sentences and a refresh. That is the
 * same split `simulate-payment` draws — the entity knows what an order is, a
 * feature knows what a shopper does to it — and it could not sit on the page
 * either, for the reason `buy-product` gives: the page's job is *which facts
 * about an order are shown*; this file's job is *what happens when a shopper
 * presses «Применить»*. They change for different reasons.
 *
 * `render(order)` is `createPaymentControls`'s shape on purpose: the page holds
 * both, asks both on every paint, and composes whatever each returns.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A REAL `<form>`, WHEN THE STOREFRONT HAS NONE
 * ---------------------------------------------------------------------------
 * Spec 004's storefront contains zero `<form>` elements, and `layout.spec.ts`
 * asserts it. The hazard it names is specific: a *decorative* control wrapped
 * in a form whose only listener cancels the submit default — a control
 * pretending to be wired, where losing that one listener turns Enter into a
 * navigation to `/?q=…`. The search field and «Ввести промокод» on the storefront are
 * decorative, so they got no form and Enter got no default to cancel.
 *
 * This field is the opposite case. It is wired: the `submit` handler is where
 * the work happens, and cancelling the default is a line inside it, not the
 * point of it. A `<form>` is what makes Enter in the field mean «Применить» — implicit
 * submission is the browser's, not this file's — and what gives the button a
 * `type="submit"` that a screen reader announces as one. Losing the handler
 * here would not leave a control pretending to work; it would leave a control
 * that visibly does not (the page reloads at `/order/ord_x?code=…` and the promo is
 * not applied — R10 names that failure, and the e2e's `window` marker is its
 * guard). `layout.spec.ts`'s zero-`<form>` assertion runs on `/` only, and this
 * form is on `/order/:id`.
 *
 * **Enter cannot reach the payment buttons.** They are `type="button"`, and they
 * are siblings of this form in the page's content region, never children of it
 * — `order-page.ts` composes details, recovery notice, promo form, payment
 * controls as four separate nodes. Implicit submission finds this form's own
 * submit button and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY THE INPUT IS `readOnly` DURING THE REQUEST, AND THE BUTTON `disabled`
 * ---------------------------------------------------------------------------
 * The shopper who pressed Enter has focus in the field. `disabled` on a focused
 * element drops focus to `body` — the focus ring vanishes, a screen reader loses
 * its place, and when the request fails and the field comes back the shopper is
 * nowhere. `readOnly` freezes the value for the length of the request and keeps
 * focus exactly where it was, so a failure lands its sentence under a field the
 * shopper is still in and can edit the moment it is writable again.
 *
 * The button is `disabled` because it should be: a disabled button dispatches
 * no click, so a second Enter or a double-click during an open request sends
 * nothing. Within this tab and on this form — the same UX guarantee, with the
 * same edges, that `buy-product` and `simulate-payment` describe. The limit
 * itself is held by one conditional `UPDATE … WHERE used_count < max_uses` in
 * the database (architecture §3, I7), which has never heard of this button.
 *
 * **The input carries no browser-side mandatory-field attribute.** It would
 * put the one English sentence on this page: the browser's native validation
 * bubble («Please fill out this field») is in the browser's language, not the
 * shop's, and functional spec §2.7 covers every message a shopper reads. An
 * empty submission is handled in the handler instead — trimmed, found empty,
 * and nothing is sent; the field simply stays as it is (§2.2's fifth
 * criterion).
 *
 * ---------------------------------------------------------------------------
 * WHY SUCCESS PAINTS NOTHING OF ITS OWN
 * ---------------------------------------------------------------------------
 * `applyPromo` returns the re-read order — the shop's view after COMMIT, promo
 * and discounted amount included. This file throws that order away and calls
 * `onOrderMayHaveChanged()` instead, and that is deliberate, not laziness.
 *
 * The order page has **one writer of its content region**: `showOrder`, fed by
 * the poll. It compares the fields that can change and repaints the whole
 * region only when one of them did. If this feature painted the returned order
 * itself there would be two writers with two ideas of what is on screen — the
 * page's memo would still say `promo: null`, and the very next scheduled read
 * (a second away, at most) could repaint the region from a stale read that had
 * left the shop before the transaction committed. `poll.refreshNow()` queues
 * behind an in-flight read rather than overlapping it, so the order of events
 * is fixed: a stale `promo: null` read, if one is open, lands first and is
 * suppressed by the memo; the refresh then reads the committed promo and paints
 * the «Промокод» row, the new «Сумма», and no form — in one replacement, with
 * no flicker. The returned order still matters: parsing it is the success
 * check, and an unparseable body is a failure, not a silent success.
 *
 * On success the form is left in its busy state. The refresh replaces it with
 * nothing — `render` returns `null` once `order.promo` is set — so re-enabling
 * would put a live field in front of a shopper for the length of one read,
 * whose next Enter sends a code to an order that already has one.
 */
import { OrderStatus } from "@game-shop/contracts";

import {
  applyPromo,
  OrderNotFoundError,
  PromoCodeExhaustedError,
  PromoCodeUnknownError,
  PromoNotApplicableError,
  type Order,
} from "../../../entities/order/index.js";
import { createElement } from "../../../shared/lib/dom.js";

/**
 * Every word this feature shows a shopper, in Russian (functional spec 005 §2.7
 * — the field, the button and the three messages, by name).
 *
 * `placeholder` is both the field's `placeholder` and its `aria-label`: the
 * one word a sighted shopper reads in the empty field is the one a screen
 * reader announces for it.
 *
 * Three refusal sentences rather than one, because they call for different
 * actions. «Такого промокода нет» — the shop has no such code; check the
 * spelling. «Промокод больше не действует» — the code exists and this order
 * could take it, but its uses are spent; trying again will fail identically.
 * «Не удалось применить…» — the API did not answer, or answered with something
 * that is not an order; the connection, so trying again is exactly right.
 * `notFound` is the same sentence every other feature on this page uses for a
 * `404`, because it is the same situation.
 *
 * There is deliberately **no sentence for `PromoNotApplicableError`** — see
 * {@link messageFor}.
 */
const text = {
  placeholder: "Промокод",
  apply: "Применить",
  unknown: "Такого промокода нет",
  exhausted: "Промокод больше не действует",
  notFound: "Заказ не найден. Проверьте адрес страницы.",
  failed: "Не удалось применить промокод. Проверьте соединение и попробуйте ещё раз.",
} as const;

/** Owned by this feature, not by the page: the field and its messages are this behaviour's, and so are their classes. */
const rootClass = "promo-form";
const errorClass = "promo-form__error";

/**
 * The sentence for a failed attempt, or `null` when the truthful response is
 * not a sentence at all.
 *
 * `PromoNotApplicableError` carries `not_awaiting_payment` or
 * `another_code_applied`, and both mean the same thing from this tab's point of
 * view: **the order moved under it** — paid in another tab, or given a code in
 * another tab — and this form was rendered from a view that is no longer true.
 * A sentence about the code would be answering the wrong question. The right
 * answer is to re-read the order, at which point the page paints what is
 * actually there: the paid status, or the other code's row, and no form.
 */
function messageFor(error: unknown): string | null {
  if (error instanceof PromoNotApplicableError) {
    return null;
  }

  if (error instanceof PromoCodeUnknownError) {
    return text.unknown;
  }

  if (error instanceof PromoCodeExhaustedError) {
    return text.exhausted;
  }

  if (error instanceof OrderNotFoundError) {
    return text.notFound;
  }

  return text.failed;
}

/** How the page (re-)renders the promo field from a freshly read order. */
export interface PromoForm {
  /**
   * The promo field for this order, or `null` when the order is in a state
   * this feature has nothing to offer: already carrying a code, or no longer
   * awaiting payment.
   */
  render(order: Order): HTMLElement | null;
}

export interface PromoFormOptions {
  readonly orderId: string;

  /**
   * Re-read the order and render it again.
   *
   * Named for what this feature actually knows — the shop has answered, so the
   * order *may* have changed — and called on every outcome that changes or
   * might have changed it: a success (the promo is on, the amount is new), and
   * a `409` that says the order is no longer the one this form was drawn for.
   * The page answers by asking `GET /api/orders/:id`, which is the authority.
   * See the file header for why this feature paints nothing itself.
   */
  readonly onOrderMayHaveChanged: () => void;
}

/**
 * Build the promo field for one order page.
 *
 * Called once, at page construction; its `render` is called on every load and
 * re-load of the order.
 */
export function createPromoForm(options: PromoFormOptions): PromoForm {
  function clearMessage(form: HTMLFormElement): void {
    form.querySelector(`.${errorClass}`)?.remove();
  }

  /**
   * The failure goes inside the form, under the field the shopper just
   * submitted, with `role="alert"` so it is announced — it appears after they
   * acted and nothing else on the page moves.
   */
  function showMessage(form: HTMLFormElement, message: string): void {
    form.append(
      createElement("p", { className: errorClass, text: message, attributes: { role: "alert" } }),
    );
  }

  /** `readOnly` on the field, `disabled` on the button — the header says why they differ. */
  function setBusy(input: HTMLInputElement, button: HTMLButtonElement, isBusy: boolean): void {
    input.readOnly = isBusy;
    button.disabled = isBusy;
  }

  /**
   * One attempt. Never rejects: every outcome is handled here, which is what
   * lets the `submit` handler fire it off without an `await`.
   *
   * An empty field — empty after trimming, so a row of spaces counts — sends
   * nothing and changes nothing: no request, no message, the field stays as it
   * is. That is functional spec §2.2's fifth criterion, and it is done here
   * rather than by the browser's own validation for the reason the header
   * gives.
   *
   * The code is sent trimmed but not upper-cased: normalisation is the shop's
   * (`normalisePromoCode` in `apps/api/src/promo/`), and the applied code comes
   * back in the shop's spelling on the re-read order. The field's value is kept
   * on every failure so a shopper can correct one letter rather than retype.
   */
  async function send(form: HTMLFormElement, input: HTMLInputElement, button: HTMLButtonElement): Promise<void> {
    const code = input.value.trim();

    if (code === "") {
      return;
    }

    clearMessage(form);
    setBusy(input, button, true);

    try {
      await applyPromo(options.orderId, code);

      // Deliberately still busy: the refresh replaces this form with nothing.
      // See the header's last section.
      options.onOrderMayHaveChanged();
    } catch (error: unknown) {
      const message = messageFor(error);

      if (message === null) {
        options.onOrderMayHaveChanged();
      } else {
        showMessage(form, message);
      }

      setBusy(input, button, false);
    }
  }

  /**
   * The field, the button and the form that binds Enter to the button.
   *
   * Wired directly rather than through a delegated listener, for the reason
   * `simulate-payment` gives: the form is built here, held here and replaced as
   * a unit by the page, so a listener on it cannot go stale.
   *
   * `autocapitalize="characters"` because every code in the brief is upper-case
   * and a phone keyboard would otherwise open in lower-case; the shop accepts
   * either. `autocomplete="off"` and `spellcheck="false"` because a promo code
   * is neither a remembered address nor a word.
   */
  function buildForm(): HTMLFormElement {
    const input = createElement("input", {
      className: `${rootClass}__input`,
      attributes: {
        type: "text",
        name: "code",
        "aria-label": text.placeholder,
        placeholder: text.placeholder,
        autocomplete: "off",
        autocapitalize: "characters",
        spellcheck: "false",
      },
    });

    const button = createElement("button", {
      className: `${rootClass}__button`,
      text: text.apply,
      attributes: { type: "submit" },
    });

    const form = createElement("form", { className: rootClass, attributes: { "data-promo-form": "" } }, [
      input,
      button,
    ]);

    // Cancelling the submit default is the first line, not the handler's job —
    // the work below it is. Without it the browser would GET the form after
    // the POST and reload `/order/ord_x?code=…` (R10).
    // Fire-and-forget: `send` handles every outcome itself and never rejects.
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void send(form, input, button);
    });

    return form;
  }

  return {
    /**
     * A field only while the order awaits payment **and** carries no code
     * (functional spec §2.2: no field for a paid, failed or delivering order;
     * once a code is on, the entity's «Промокод» row stands in the field's
     * place and it cannot be removed or replaced).
     *
     * The `null` is a deliberate default rather than an oversight: every other
     * state is one this feature has nothing to offer, and a status this file
     * has never heard of showing no field is the right failure.
     */
    render(order: Order): HTMLElement | null {
      if (order.status !== OrderStatus.Created || order.promo !== null) {
        return null;
      }

      return buildForm();
    },
  };
}
