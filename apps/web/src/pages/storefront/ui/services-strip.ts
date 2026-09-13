/**
 * The strip of eleven service tiles (functional spec §2.1 and §2.5; Figma node
 * `1:495`).
 *
 * Each tile is a `<button type="button">` with no handler, «еще 841» included.
 * A button rather than a `<div>` because §2.5 crit 4 wants the keyboard to
 * reach a tile and see the same highlight the pointer sees, and a button is the
 * element that is focusable, announced, and pressable without any code. That
 * the press does nothing is the assignment's own allowance
 * (technical-considerations §2.8); the hover and focus highlight is the
 * stylesheet's alone.
 *
 * The picture is `<img alt="">` with the caption as visible text beside it:
 * the caption already says «Steam», so an `alt` of «Steam» would read it twice.
 */
import { createElement } from "../../../shared/lib/dom.js";
import { services, type ServiceTile } from "../config/services.js";

function renderTile(tile: ServiceTile): HTMLLIElement {
  return createElement("li", { className: "services__item" }, [
    createElement("button", { className: "service-tile", attributes: { type: "button" } }, [
      createElement("img", {
        className: "service-tile__icon",
        attributes: { src: tile.icon, alt: "", width: "72", height: "72" },
      }),
      createElement("span", { className: "service-tile__caption", text: tile.caption }),
    ]),
  ]);
}

export function createServicesStrip(): HTMLElement {
  return createElement("section", { className: "services" }, [
    createElement("ul", { className: "services__list" }, services.map(renderTile)),
  ]);
}
