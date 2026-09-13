/**
 * The header: the Каталог button, the search box with its heart and search
 * buttons, and the profile button (functional spec §2.1; Figma node `1:598`).
 *
 * Only Каталог does anything, and this file is not where it does it: the
 * button is returned by reference alongside the header, and `catalog-menu.ts`
 * binds it — one `document` listener that recognises clicks on this element,
 * no listener on the element itself. It already carries
 * `aria-expanded="false"` and `aria-controls="catalog-menu"` because those are
 * facts about the markup, not about the listener: the overlay exists from the
 * first render and this button is the one that owns it.
 *
 * The search box is a `<div role="search">` around a bare `<input
 * type="search">`, deliberately not a `<form>`. With no form, Enter has no
 * default action, so there is nothing to cancel and no listener whose only job
 * is to stop the page navigating to `/?q=…` — the field is inert by
 * construction rather than by a `preventDefault` that could one day be lost
 * (technical-considerations §2.8). The heart, the search glyph and the profile
 * are `<button type="button">` with no handler, for the same reason.
 */
import { createElement } from "../../../shared/lib/dom.js";
import { text } from "../config/text.js";
import { createIcon } from "./icon.js";

/**
 * The header element, and the one control inside it another section needs to
 * hold: `catalog-menu.ts` takes `catalogButton` to toggle on and to return
 * focus to. Handed back typed rather than found by `querySelector`, so the
 * pairing is a signature the compiler checks, not a class name and a guard.
 */
export interface Header {
  readonly element: HTMLElement;
  readonly catalogButton: HTMLButtonElement;
}

export function createHeader(): Header {
  const catalogButton = createElement(
    "button",
    {
      className: "header__catalog",
      attributes: { type: "button", "aria-expanded": "false", "aria-controls": "catalog-menu" },
    },
    [createIcon("catalog"), createElement("span", { className: "header__catalog-label", text: text.header.catalog })],
  );

  const search = createElement("div", { className: "search", attributes: { role: "search" } }, [
    createElement("input", {
      className: "search__input",
      attributes: {
        type: "search",
        "aria-label": text.header.search,
        placeholder: text.header.searchPlaceholder,
        autocomplete: "off",
      },
    }),
    createElement(
      "button",
      { className: "search__favourites", attributes: { type: "button", "aria-label": text.header.favourites } },
      [createIcon("heart")],
    ),
    createElement(
      "button",
      { className: "search__submit", attributes: { type: "button", "aria-label": text.header.find } },
      [createIcon("search")],
    ),
  ]);

  const profileButton = createElement(
    "button",
    { className: "header__profile", attributes: { type: "button", "aria-label": text.header.profile } },
    [createIcon("profile")],
  );

  const element = createElement("header", { className: "header" }, [catalogButton, search, profileButton]);

  return { element, catalogButton };
}
