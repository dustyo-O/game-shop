/**
 * The catalog overlay: built once, `hidden` until the Каталог button opens it,
 * and bound here to the three things that change that — a click, the Escape
 * key, and a return from the back/forward cache (functional spec §2.3; Figma
 * node `1:1193`). Slice 1 rendered it still; this file binds it. DOM events
 * are classified into a word from `../model/menu.ts`, the reducer there
 * answers with a boolean, and the boolean is painted as the overlay's `hidden`
 * property and the button's `aria-expanded`.
 *
 * Built at render time, not on first open, so `aria-controls` on the button
 * points at something from the first paint, and so that opening is a one-bit
 * change rather than a construction. Closed means `hidden`, which also takes
 * it out of the accessibility tree.
 *
 * ---------------------------------------------------------------------------
 * ONE CLASSIFYING LISTENER ON `document`, NONE ON THE BUTTON
 * ---------------------------------------------------------------------------
 * The obvious shape — a `click` handler on Каталог that opens, plus a `click`
 * handler on `document` that closes — has a bug built into the event order: the
 * opening click bubbles from the button up to `document`, so the second
 * handler sees it too and closes what the first one just opened (R3). The
 * usual patch is `stopPropagation()` in the button handler — and, for inner
 * clicks, on the overlay. That makes "stop the event to be exempt from the
 * closer" the page's mechanism, and stopping is untargeted: it hides the
 * event from whoever is above, which on this page means the delegated
 * listener `enableBuyControls` keeps on the product row (for any click
 * stopped inside the row) and this very `document` listener, which needs the
 * «Купить» click to reach it so the overlay closes before `location.assign`.
 * A design that never stops an event never has to decide where stopping is
 * safe. The other patch, registering the document listener from inside the
 * open handler on a zero-delay timeout so it misses the click that is still
 * bubbling, is a bet on ordering rather than a design.
 *
 * So there is no handler on the button. One `document` listener sees every
 * click on the page exactly once and asks one question — where did it land? —
 * with three answers: on the button (`Toggle`), inside the overlay
 * (`InsideClick`), anywhere else (`OutsideClick`). One click, one
 * classification, one event to the reducer; the opening click cannot also be
 * an outside click because nothing gets to look at it twice. Nothing calls
 * `stopPropagation` or `preventDefault` anywhere on the storefront; the
 * `CLAUDE.md` grep checks that.
 *
 * `click`, not `pointerdown`: the spec says clicks, and `pointerdown` would
 * close the menu the moment a shopper starts a drag-select. `document`, not
 * the page root: on a wide screen the grey ground beside the column is not
 * inside `#app`'s children, and a click there must close the menu too.
 *
 * ---------------------------------------------------------------------------
 * "INERT INSIDE" IS A PROPERTY OF THE MARKUP
 * ---------------------------------------------------------------------------
 * Functional spec §2.3 crit 5 — click any category or item, and nothing
 * changes — is not implemented by a handler that swallows inner clicks. It is
 * implemented by there being nothing inside to swallow: the five categories
 * are `<button type="button">` with no listener, the column entries are `<li>`
 * text, and there is no `<a>` anywhere on the storefront (the only navigation
 * on the page is `location.assign` in `features/buy-product`). A click inside
 * has no default action to run and no handler to reach, so the only thing it
 * can be is a click inside — which the listener above names `InsideClick`, and
 * which the reducer answers with the state unchanged. The check is a grep over
 * `pages/storefront/` for an `"a"` tag handed to `createElement` — the page's
 * `CLAUDE.md` quotes the command — and it returns nothing. The first category
 * carries an `--active` modifier because the mockup draws it highlighted;
 * nothing moves it.
 *
 * ---------------------------------------------------------------------------
 * ESCAPE, AND THE SEARCH FIELD'S OWN ESCAPE
 * ---------------------------------------------------------------------------
 * One `document` `keydown` listener acts only when the key is Escape *and* the
 * menu is open; then it closes the menu and puts focus back on Каталог, so a
 * keyboard user lands on the control that owns what just disappeared. The
 * `isOpen` guard is load-bearing: without it, Escape anywhere on the page
 * would yank focus to the button while the menu was closed.
 *
 * It calls neither `preventDefault` nor `stopPropagation`. The header's search
 * box is an `<input type="search">`, and Chromium's native Escape in such a
 * field clears its text. A shopper who opened the menu, moved into the field,
 * typed, and pressed Escape gets both effects — the menu closes and the field
 * may clear — and both are harmless (R8). Blocking the native one would be
 * this handler deciding on the search field's behalf.
 *
 * ---------------------------------------------------------------------------
 * THE BACK/FORWARD CACHE
 * ---------------------------------------------------------------------------
 * The one navigation on the page is «Купить», and the click on it is itself an
 * outside click: the document listener closes the menu synchronously, before
 * `location.assign` runs, so a page going into the cache goes in with the menu
 * closed. The `pageshow` handler below is belt and braces for that — on a
 * persisted restore it dispatches an `OutsideClick`, which the reducer treats
 * as "close" whatever the state. Without the cache, back is a full reload and
 * the menu is closed by construction (technical-considerations §2.3).
 *
 * None of the three listeners is ever removed. The app has no unmount — a page
 * is built once per document and lives as long as it — and a cached page keeps
 * its listeners along with everything else.
 */
import { createElement } from "../../../shared/lib/dom.js";
import { catalogCategories, catalogColumns, type CatalogColumn } from "../config/catalog-menu.js";
import { text } from "../config/text.js";
import { MenuEvent, reduceMenu } from "../model/menu.js";
import { createIcon } from "./icon.js";

function renderCategory(label: string, index: number): HTMLLIElement {
  const className = index === 0 ? "catalog-menu__category catalog-menu__category--active" : "catalog-menu__category";

  return createElement("li", { className: "catalog-menu__category-item" }, [
    createElement("button", { className, attributes: { type: "button" } }, [
      createElement("span", { className: "catalog-menu__category-label", text: label }),
      createIcon("menu-chevron"),
    ]),
  ]);
}

function renderColumn(column: CatalogColumn): HTMLElement {
  return createElement("div", { className: "catalog-menu__column" }, [
    createElement("h3", { className: "catalog-menu__heading" }, [
      createElement("span", { className: "catalog-menu__heading-label", text: column.title }),
      createIcon("menu-chevron"),
    ]),
    createElement(
      "ul",
      { className: "catalog-menu__list" },
      column.items.map((item) => createElement("li", { className: "catalog-menu__item", text: item })),
    ),
  ]);
}

/**
 * Build the overlay and bind it to `catalogButton`, the header's Каталог
 * control — the one element that toggles it and the one Escape hands focus
 * back to. The button already carries `aria-controls="catalog-menu"`; this is
 * the other half of that pairing.
 */
export function createCatalogMenu(catalogButton: HTMLButtonElement): HTMLElement {
  const overlay = createElement(
    "section",
    {
      className: "catalog-menu",
      attributes: { id: "catalog-menu", "aria-label": text.catalogMenu.label, hidden: "" },
    },
    [
      createElement("ul", { className: "catalog-menu__categories" }, catalogCategories.map(renderCategory)),
      createElement("div", { className: "catalog-menu__columns" }, catalogColumns.map(renderColumn)),
    ],
  );

  // Closed, and the markup agrees: the `hidden` attribute above and the
  // button's `aria-expanded="false"` from `header.ts` are this same bit,
  // written at construction so nothing has to be painted before the first
  // event.
  let isOpen = false;

  /** Paint the bit: the `hidden` property, and the attribute the CSS keys on. */
  function setOpen(next: boolean): void {
    overlay.hidden = !next;
    catalogButton.setAttribute("aria-expanded", String(next));
  }

  /** Reduce, then paint only if the answer differs — every event, this path. */
  function dispatch(event: MenuEvent): void {
    const next = reduceMenu(isOpen, event);

    if (next !== isOpen) {
      isOpen = next;
      setOpen(next);
    }
  }

  // The one click listener — see the file header for why it is on `document`
  // and why there is none on the button.
  document.addEventListener("click", (event) => {
    const { target } = event;

    if (!(target instanceof Element)) {
      return;
    }

    if (catalogButton.contains(target)) {
      dispatch(MenuEvent.Toggle);
    } else if (overlay.contains(target)) {
      dispatch(MenuEvent.InsideClick);
    } else {
      dispatch(MenuEvent.OutsideClick);
    }
  });

  // Escape — no `preventDefault`, no `stopPropagation`: the search field's
  // native Escape-clears-the-text runs alongside, and both are harmless (R8).
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !isOpen) {
      return;
    }

    dispatch(MenuEvent.Escape);
    catalogButton.focus();
  });

  // Page lifecycle — see the file header. Never removed: there is no unmount.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      dispatch(MenuEvent.OutsideClick);
    }
  });

  return overlay;
}
