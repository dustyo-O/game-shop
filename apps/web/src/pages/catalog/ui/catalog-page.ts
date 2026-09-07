/**
 * The shop page at `/` — the twelve catalogue items with their names and
 * prices, and a «Купить» control on the ones that can be bought
 * (functional spec §2.1, technical-considerations §2.6).
 *
 * Phase 1's plain version, on purpose. Appearance is out of scope here and this
 * page is replaced wholesale in Phase 4 by the storefront built from the design
 * — so there is no header, no banner, no carousel and no Steam block, and the
 * stylesheet does nothing beyond making twelve rows legible.
 *
 * The page returns its element **synchronously** and fills it in when the
 * request lands. The alternative — an `async` factory the caller awaits —
 * leaves the document empty until the API answers, which is a blank white page
 * on a slow connection and an indefinitely blank one if the API is down. Here
 * the shopper sees «Загрузка каталога…» immediately and it is replaced in
 * place, whichever way the request goes.
 */
import { fetchProducts, renderProductCard, type Product } from "../../../entities/product/index.js";
import { enableBuyControls } from "../../../features/buy-product/index.js";
import { createElement } from "../../../shared/lib/dom.js";

/**
 * Every word this page shows a shopper, in Russian — including the states
 * nobody plans for (functional spec §2.8 covers "any message shown to them",
 * which is exactly where an English "Failed to load" normally survives review).
 */
const text = {
  title: "Магазин",
  loading: "Загрузка каталога…",
  empty: "Каталог пуст.",
  error: "Не удалось загрузить каталог. Проверьте соединение и обновите страницу.",
} as const;

function renderStatus(message: string, modifier?: string): HTMLParagraphElement {
  const className = modifier === undefined ? "catalog__status" : `catalog__status catalog__status--${modifier}`;

  return createElement("p", { className, text: message, attributes: { role: "status" } });
}

function renderList(products: readonly Product[]): HTMLElement {
  return createElement("ul", { className: "catalog__list" }, products.map(renderProductCard));
}

/**
 * Swap the page's content region for whatever the catalogue request produced.
 *
 * Every failure — the API unreachable, a non-2xx response, a body that is not
 * the promised array — lands in the same branch and shows the same Russian
 * message, because they are the same event to a shopper: the goods did not
 * arrive. The distinctions are still in the thrown error for a developer
 * reading the network panel.
 */
async function loadInto(content: HTMLElement): Promise<void> {
  try {
    const products = await fetchProducts();

    content.replaceChildren(products.length === 0 ? renderStatus(text.empty) : renderList(products));
  } catch {
    content.replaceChildren(renderStatus(text.error, "error"));
  }
}

/**
 * Build the shop page, make its «Купить» controls work, and start loading the
 * catalogue into it.
 *
 * The page composes; it does not implement. What a Buy click *does* — the
 * request, the disabled control, the Russian failure message, the navigation to
 * `/order/{id}` — belongs to `features/buy-product`, and this line is the whole
 * of the page's involvement in it.
 *
 * `enableBuyControls` is given the content region rather than each button,
 * because the buttons do not exist yet: they arrive with the catalogue, into
 * this same element, and could be replaced again. The listener is on the part
 * that stays.
 */
export function createCatalogPage(): HTMLElement {
  const content = createElement("div", { className: "catalog__content" }, [renderStatus(text.loading)]);

  const page = createElement("section", { className: "catalog" }, [
    createElement("h1", { className: "catalog__title", text: text.title }),
    content,
  ]);

  enableBuyControls(content);

  // Fire-and-forget: `loadInto` handles both outcomes itself and never
  // rejects, so there is nothing for a caller to await or catch.
  void loadInto(content);

  return page;
}
