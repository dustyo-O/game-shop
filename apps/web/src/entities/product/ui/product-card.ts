/**
 * One catalogue item as a card on the storefront's «Популярные товары» row:
 * its picture, its name, its price, and — only where the catalogue allows
 * buying — a «Купить» control (functional spec §2.6; technical-considerations
 * §2.5).
 *
 * The markup, which `features/buy-product` and `storefront.css` both read:
 *
 *   li.product-card[data-sku]
 *     div.product-card__media  > img.product-card__image[alt=""][width][height][loading=lazy]
 *                                (or the `--empty` modifier and no `<img>`)
 *     div.product-card__body   > h3.product-card__name
 *                                p.product-card__price
 *                                button.product-card__buy[type=button][data-sku]  (purchasable only)
 *
 * The entity owns the structure and the class names; the page that shows the
 * card owns how they look (`pages/storefront/ui/storefront.css`, and nothing
 * else). No struck-through old price and no badge: the shop invents no
 * discounts (functional spec §3).
 *
 * ---------------------------------------------------------------------------
 * THE BUY FEATURE'S CONTRACT, KEPT BYTE FOR BYTE
 * ---------------------------------------------------------------------------
 * `features/buy-product` listens on the row for clicks that land on
 * `button[data-sku]`, disables that button, and on failure inserts a `<p>`
 * after it and later finds that `<p>` through `button.parentElement`. Three
 * things here are that contract: the control is a `<button type="button">`,
 * it is the only element inside the card carrying `data-sku`, and it sits
 * directly inside `__body`, so `parentElement` is a box the message can live
 * in. The card's own `data-sku` is on the `<li>` — an identity a browser check
 * selects a specific card by — and the feature never matches it, because its
 * selector names the tag. Nothing wraps the card in an `<a>` or a `<button>`:
 * a card without «Купить» must not look like a control and must do nothing
 * when clicked (§2.6 crit 4, R6), and the cheapest way to guarantee that is
 * to give it no element that could react.
 *
 * ---------------------------------------------------------------------------
 * THE ONE LISTENER IN THIS ENTITY'S `ui/`
 * ---------------------------------------------------------------------------
 * The `img`'s `error` handler is the only event listener the product entity
 * registers, and it is presentational: a file that fails to load makes the
 * card show the same neutral panel a row with `image: null` shows, instead of
 * the browser's broken-image glyph (R5). It changes a class on the card and
 * nothing outside it, talks to no other slice, and is why a wrong path in the
 * catalogue is a grey square rather than a visibly broken shop. Behaviour
 * that reaches beyond the card — what pressing «Купить» does — stays in the
 * feature, for the reason given on the button below.
 */
import { createElement } from "../../../shared/lib/dom.js";
import { formatPrice } from "../../../shared/lib/format-price.js";
import type { Product } from "../model/product.js";

const buyLabel = "Купить";

/**
 * The picture's box on the page, as attributes on the `<img>`: 3:2, half of
 * the 456 × 304 the files under `public/assets/` are drawn at. Fixed so the
 * browser reserves the box before the bytes arrive and the row does not jump
 * when they do; the stylesheet's `aspect-ratio` and `object-fit: cover` make
 * the same box fluid inside the grid column.
 */
const imageWidth = 228;
const imageHeight = 152;

const mediaClass = "product-card__media";
const mediaEmptyClass = "product-card__media--empty";

/**
 * The catalogue's `assets/cs2.png` → the address the `<img>` loads.
 *
 * Resolved against the page's **origin**, not against the current path and
 * not by prefixing a slash:
 *
 *   - `image` as given is relative, and a relative `src` resolves against the
 *     document's URL. On `/` that is `/assets/cs2.png`; on `/order/ord_…` it
 *     would be `/order/assets/cs2.png` — a 404 waiting for the first page
 *     other than the storefront to render a card.
 *   - `` `/${image}` `` fixes that route and breaks another: the day a
 *     catalogue row arrives as `/assets/cs2.png` the template yields
 *     `//assets/cs2.png`, which is a protocol-relative URL to a host named
 *     `assets`.
 *
 * `new URL(relative, base)` handles both forms of `image` the same way and
 * yields an absolute URL on this origin either way. The value is the wire
 * value untouched — the parser keeps it, this is where presentation resolves
 * it (`../api/products-api.ts`).
 */
function imageUrl(image: string): string {
  return new URL(image, window.location.origin).href;
}

/** The neutral panel: what a card shows in place of a picture it does not have. */
function markEmpty(media: HTMLDivElement): void {
  media.classList.add(mediaEmptyClass);
}

/**
 * The picture, or the panel that stands in for one.
 *
 * `image: null` is a catalogue row without artwork (the column is nullable):
 * no `<img>`, no request, the `--empty` modifier from the start. A string is
 * an `<img>` that may still fail — a renamed file, a typo in the seed — and
 * then the `error` event swaps in the very same modifier and drops the
 * element, so both roads end at the same grey square. The listener is
 * attached before `src` is assigned: the browser only ever fires `error` from
 * a queued task, so the order does not matter in practice, but writing it
 * this way means nobody has to know that.
 *
 * `alt=""` because the name sits beneath the picture in the same card; an
 * `alt` repeating it would read every product twice to a screen reader.
 * `loading="lazy"` because the row is the last block on the page and usually
 * below the fold at 1 280 × 800; `decoding="async"` so a decoded bitmap never
 * blocks the frame the four blocks above are painting in.
 */
function renderMedia(image: string | null): HTMLDivElement {
  const media = createElement("div", { className: mediaClass });

  if (image === null) {
    markEmpty(media);

    return media;
  }

  const picture = createElement("img", {
    className: "product-card__image",
    attributes: {
      alt: "",
      width: String(imageWidth),
      height: String(imageHeight),
      loading: "lazy",
      decoding: "async",
    },
  });

  picture.addEventListener(
    "error",
    () => {
      markEmpty(media);
      picture.remove();
    },
    { once: true },
  );

  picture.src = imageUrl(image);
  media.append(picture);

  return media;
}

/**
 * Render the card as an `<li>` — the row's list is a `<ul>`, so the five items
 * are a list to a screen reader as well as to the eye. The name is an `<h3>`:
 * «Популярные товары» is the page's `<h2>`, and the visually hidden «Магазин»
 * its `<h1>` (technical-considerations §2.4), so the outline reads
 * shop → row → product without a skipped level.
 *
 * `data-sku` is on the card because the sku is the item's identity everywhere
 * else in this system: it is what `POST /api/orders` takes, and it is what a
 * browser check selects a specific card by without depending on the item's
 * position or its Russian name.
 */
export function renderProductCard(product: Product): HTMLLIElement {
  const body = createElement("div", { className: "product-card__body" }, [
    createElement("h3", { className: "product-card__name", text: product.name }),
    createElement("p", {
      className: "product-card__price",
      text: formatPrice(product.priceMinor, product.currency),
    }),
  ]);

  if (product.purchasable) {
    // The control is rendered here and its *behaviour* lives in
    // `features/buy-product`, which listens for clicks on `button[data-sku]`
    // from the row's region. An entity may not import a sibling entity, so a
    // handler here would be a card calling `entities/order` — the one import
    // the layer rules rule out. The card says what the item is; the feature
    // says what pressing it does.
    body.append(
      createElement("button", {
        className: "product-card__buy",
        text: buyLabel,
        attributes: { type: "button", "data-sku": product.sku },
      }),
    );
  }

  return createElement("li", { className: "product-card", attributes: { "data-sku": product.sku } }, [
    renderMedia(product.image),
    body,
  ]);
}
