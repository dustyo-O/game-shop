/**
 * The Steam top-up block: the Steam icon and title with its «5%» badge, the
 * promo-code button, the login field, the sum, the currency control, and
 * «Оплатить» (functional spec §2.1, §2.4 and §2.8; Figma node `1:547`).
 *
 * One thing here is graded — the currency control — and it needs no script.
 * Three visually-hidden `<input type="radio" name="currency">` in a
 * `<fieldset role="radiogroup">` are the state: exactly one is checked because
 * that is what a radio group is, arrow keys move between them because that is
 * what a radio group does, and the stylesheet paints the active one through
 * `:checked + label`. «$» is checked at render, as the mockup draws it, beside
 * a sum in roubles — the pairing is the mockup's and stays (functional spec
 * §2.4; technical-considerations §2.2). The alternative, three `<button
 * role="radio" aria-checked>` and a click handler, would re-implement all of
 * that to arrive at "set this one true, the others false".
 *
 * Everything else is inert by what it is (technical-considerations §2.8). Not
 * a `<form>`, so Enter in the login field has no default. The login is a bare
 * input with `autocomplete="off"` — the browser has no business remembering a
 * value nothing reads. «Сумма / 500 ₽» is text, not an input: an input invites
 * typing and expecting a recalculation the spec waives. The «i» is a glyph in
 * an `aria-hidden` span, not a button, because a button would promise a
 * tooltip. «Оплатить 500$» and «Ввести промокод» are `<button type="button">`
 * with no handler.
 */
import { createElement } from "../../../shared/lib/dom.js";
import { steamIcon } from "../config/services.js";
import { currencies, text } from "../config/text.js";
import { createIcon } from "./icon.js";

function renderCurrencyOption(option: (typeof currencies)[number]): readonly [HTMLInputElement, HTMLLabelElement] {
  const attributes: Record<string, string> = {
    type: "radio",
    name: "currency",
    id: option.id,
    value: option.symbol,
  };

  if (option.symbol === "$") {
    attributes["checked"] = "";
  }

  return [
    createElement("input", { className: "currency__input", attributes }),
    createElement("label", { className: "currency__option", text: option.symbol, attributes: { for: option.id } }),
  ];
}

function renderCurrencyControl(): HTMLFieldSetElement {
  return createElement(
    "fieldset",
    { className: "currency", attributes: { role: "radiogroup", "aria-label": text.steamTopup.currency } },
    currencies.flatMap(renderCurrencyOption),
  );
}

export function createSteamTopup(): HTMLElement {
  const service = createElement("div", { className: "steam-topup__service" }, [
    createElement("img", {
      className: "steam-topup__icon",
      attributes: { src: steamIcon, alt: "", width: "72", height: "72" },
    }),
    createElement("div", { className: "steam-topup__info" }, [
      createElement("div", { className: "steam-topup__heading" }, [
        createElement("p", { className: "steam-topup__title", text: text.steamTopup.title }),
        createElement("span", { className: "steam-topup__badge", text: text.steamTopup.badge }),
      ]),
      createElement("button", { className: "steam-topup__promo", attributes: { type: "button" } }, [
        createElement("span", { className: "steam-topup__promo-label", text: text.steamTopup.promo }),
        createIcon("chevron-down"),
      ]),
    ]),
  ]);

  const login = createElement("div", { className: "steam-topup__login" }, [
    createIcon("profile"),
    createElement("input", {
      className: "steam-topup__login-input",
      attributes: {
        type: "text",
        "aria-label": text.steamTopup.login,
        placeholder: text.steamTopup.login,
        autocomplete: "off",
      },
    }),
    createElement("span", { className: "steam-topup__hint", attributes: { "aria-hidden": "true" } }, [createIcon("info")]),
  ]);

  const amount = createElement("div", { className: "steam-topup__amount" }, [
    createIcon("wallet"),
    createElement("div", { className: "steam-topup__sum" }, [
      createElement("span", { className: "steam-topup__sum-label", text: text.steamTopup.sumLabel }),
      createElement("span", { className: "steam-topup__sum-value", text: text.steamTopup.sum }),
    ]),
    renderCurrencyControl(),
  ]);

  const pay = createElement("button", {
    className: "steam-topup__pay",
    text: text.steamTopup.pay,
    attributes: { type: "button" },
  });

  return createElement("section", { className: "steam-topup" }, [service, login, amount, pay]);
}
