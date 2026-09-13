/**
 * The monochrome glyphs — header, arrows, chevrons, the chip icons — as
 * `<span class="icon icon--<name>" aria-hidden="true">`.
 *
 * Why a span and not the SVG itself: `createElement` builds HTML-namespace
 * nodes only, `innerHTML` is banned across the app (see `shared/lib/dom.ts`),
 * and a `createSvgElement` helper would have exactly one caller. So the markup
 * carries a name, and the stylesheet paints it: one `mask-image` rule per name
 * pointing at `public/icons/ui/<name>.svg`, with `background-color:
 * currentColor` so the glyph takes the colour of the text beside it
 * (technical-considerations §2.7).
 *
 * `aria-hidden` on every one: each glyph sits inside a control that already has
 * a name — a labelled button, a chip with visible text — so announcing the
 * picture too would read everything twice.
 *
 * `glyphNames` is the inventory the stylesheet generates its rules from; a name
 * used here that is missing from `public/icons/ui/` is an empty box, which is
 * why the list is closed rather than any string.
 */
import { createElement } from "../../../shared/lib/dom.js";

export const glyphNames = [
  "catalog",
  "search",
  "heart",
  "profile",
  "arrow-left",
  "arrow-right",
  "chevron-down",
  "info",
  "wallet",
  "chip-donate",
  "chip-subscriptions",
  "chip-items",
  "chip-accounts",
  "chip-keys",
  "chip-game-currency",
  "chip-other",
  "menu-chevron",
] as const;

export type GlyphName = (typeof glyphNames)[number];

export function createIcon(name: GlyphName): HTMLSpanElement {
  return createElement("span", {
    className: `icon icon--${name}`,
    attributes: { "aria-hidden": "true" },
  });
}
