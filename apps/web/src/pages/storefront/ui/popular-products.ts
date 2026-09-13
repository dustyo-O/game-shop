/**
 * The «Популярные товары» row: the heading, seven category chips, and the
 * region the catalogue is loaded into (functional spec §2.1, §2.6 and §2.8;
 * Figma node `1:145`).
 *
 * The region works exactly as Phase 1's page did: the element is returned
 * **synchronously** with «Загрузка каталога…» in it and is filled in when the
 * request lands, so the shopper never looks at a blank row and the four blocks
 * above never wait on the API. Every failure — unreachable, non-2xx, a body
 * that is not the promised array — lands in the same branch and shows the same
 * Russian sentence, because they are the same event to a shopper: the goods
 * did not arrive. The sentence is Phase 1's, verbatim, which is what §2.6 crit
 * 5 asks for.
 *
 * `enableBuyControls` is given the region rather than each button, because the
 * buttons do not exist yet: they arrive with the catalogue, into this element,
 * and could be replaced again. The listener is on the part that stays. What a
 * «Купить» press *does* belongs to `features/buy-product`; that one line is
 * the whole of this file's involvement in it.
 *
 * For now the row shows every product through `renderProductCard` as it is
 * today; the selection of five and the redesigned card are Slice 5's. The
 * chips are `<button type="button">` with no handler, «Донат» carrying
 * `chip--active` as the mockup draws it and no `aria-pressed`, which would
 * claim a toggle that does not exist (technical-considerations §2.8).
 */
import { fetchProducts, renderProductCard, type Product } from "../../../entities/product/index.js";
import { enableBuyControls } from "../../../features/buy-product/index.js";
import { createElement } from "../../../shared/lib/dom.js";
import { text } from "../config/text.js";
import { createIcon, type GlyphName } from "./icon.js";

interface Chip {
  readonly label: string;
  readonly glyph: GlyphName;
}

/** The seven chips in the mockup's order; labels from `config/`, glyphs paired here. */
const chips: readonly Chip[] = [
  { label: text.popular.chips.donate, glyph: "chip-donate" },
  { label: text.popular.chips.subscriptions, glyph: "chip-subscriptions" },
  { label: text.popular.chips.items, glyph: "chip-items" },
  { label: text.popular.chips.accounts, glyph: "chip-accounts" },
  { label: text.popular.chips.keys, glyph: "chip-keys" },
  { label: text.popular.chips.gameCurrency, glyph: "chip-game-currency" },
  { label: text.popular.chips.other, glyph: "chip-other" },
];

function renderChip(chip: Chip, index: number): HTMLButtonElement {
  const className = index === 0 ? "chip chip--active" : "chip";

  return createElement("button", { className, attributes: { type: "button" } }, [
    createIcon(chip.glyph),
    createElement("span", { className: "chip__label", text: chip.label }),
  ]);
}

function renderStatus(message: string, modifier?: string): HTMLParagraphElement {
  const className = modifier === undefined ? "popular__status" : `popular__status popular__status--${modifier}`;

  return createElement("p", { className, text: message, attributes: { role: "status" } });
}

function renderList(products: readonly Product[]): HTMLElement {
  return createElement("ul", { className: "popular__list" }, products.map(renderProductCard));
}

async function loadInto(region: HTMLElement): Promise<void> {
  try {
    const products = await fetchProducts();

    region.replaceChildren(products.length === 0 ? renderStatus(text.popular.empty) : renderList(products));
  } catch {
    region.replaceChildren(renderStatus(text.popular.error, "error"));
  }
}

export function createPopularProducts(): HTMLElement {
  const region = createElement("div", { className: "popular__region" }, [renderStatus(text.popular.loading)]);

  const section = createElement(
    "section",
    { className: "popular", attributes: { "aria-labelledby": "popular-title" } },
    [
      createElement("div", { className: "popular__header" }, [
        createElement("h2", { className: "popular__title", text: text.popular.title, attributes: { id: "popular-title" } }),
        createElement("div", { className: "popular__chips" }, chips.map(renderChip)),
      ]),
      region,
    ],
  );

  enableBuyControls(region);

  // Fire-and-forget: `loadInto` handles both outcomes itself and never
  // rejects, so there is nothing for a caller to await or catch.
  void loadInto(region);

  return section;
}
