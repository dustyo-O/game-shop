/**
 * The whole of this app's DOM toolkit.
 *
 * `shared/` is the bottom layer: it may not import from any other layer, and
 * nothing in here knows what a product or an order is. This file exists because
 * the alternative — `innerHTML` with template strings — would put catalogue
 * names straight from the database into markup, and «CS2 Prime Status ключ» is
 * only ever safe by accident. Everything below sets `textContent`, so text is
 * text no matter what the row contains.
 *
 * It is deliberately one function. There is no component base class, no
 * lifecycle and no reactivity: the storefront has a handful of views, and a
 * miniature framework here would be more code than the views it serves.
 */

/** Everything about an element that is worth setting at construction time. */
interface ElementOptions {
  readonly className?: string;
  /** Set as `textContent`, never as markup. */
  readonly text?: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

/**
 * Build one element.
 *
 * Generic over the tag so the return type is the concrete element
 * (`createElement("button", …)` is an `HTMLButtonElement`), which is what makes
 * the call sites in `ui/` segments type-check without assertions.
 */
export function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: ElementOptions = {},
  children: readonly Node[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);

  if (options.className !== undefined) {
    element.className = options.className;
  }

  if (options.text !== undefined) {
    element.textContent = options.text;
  }

  for (const [name, value] of Object.entries(options.attributes ?? {})) {
    element.setAttribute(name, value);
  }

  element.append(...children);

  return element;
}
