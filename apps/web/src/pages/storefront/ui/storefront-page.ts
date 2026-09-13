/**
 * The shop's front page at `/` — the mockup's upper half, block by block, in
 * its order: header, banner, service tiles, the Steam top-up block, and one
 * row of «Популярные товары». Nothing below that row (functional spec §2.1).
 *
 * This file composes and owns nothing else: no state, no listener, no timer.
 * Each block is a page-local section under `./`, not a `widgets/` slice —
 * every one of them has exactly one caller, and the project lifts code only
 * when a second caller exists (technical-considerations §2.1).
 *
 * The overlay sits between the header and the content as a sibling, built and
 * `hidden` from the first render, so the Каталог button's `aria-controls` has
 * something to point at from the first paint. The one dependency between
 * sections is visible here: the header hands back its Каталог button, and the
 * overlay is built around it — `catalog-menu.ts` owns the listeners, this file
 * only passes the reference.
 *
 * The visually-hidden `<h1>Магазин</h1>` heads the outline so that
 * «Популярные товары» can be the page's h2 and card names its h3s
 * (technical-considerations §2.4).
 *
 * The page's stylesheet, `./storefront.css`, is imported here — once, by the
 * module that composes the page. That import does not scope it: the router
 * imports every page statically, so the sheet is in every route's bundle, and
 * its selectors are what keep it off the order and admin pages (see the
 * sheet's header).
 */
import { createElement } from "../../../shared/lib/dom.js";
import { text } from "../config/text.js";
import { createBanner } from "./banner.js";
import { createCatalogMenu } from "./catalog-menu.js";
import { createHeader } from "./header.js";
import { createPopularProducts } from "./popular-products.js";
import { createServicesStrip } from "./services-strip.js";
import { createSteamTopup } from "./steam-topup.js";

import "./storefront.css";

export function createStorefrontPage(): HTMLElement {
  const header = createHeader();

  return createElement("div", { className: "storefront" }, [
    createElement("div", { className: "storefront__column" }, [
      header.element,
      createCatalogMenu(header.catalogButton),
      createElement("main", { className: "storefront__content" }, [
        createElement("h1", { className: "storefront__title", text: text.title }),
        createBanner(),
        createServicesStrip(),
        createSteamTopup(),
        createPopularProducts(),
      ]),
    ]),
  ]);
}
