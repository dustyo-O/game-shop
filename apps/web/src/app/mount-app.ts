/**
 * The `app` layer: global styles, and the decision of which page the document
 * shows.
 *
 * That decision now has two answers — the shop at `/` and one order at
 * `/order/:id` — so it moved into `./router.ts`, which explains why the routing
 * is a regular expression rather than a dependency.
 */
import { resolveRoute } from "./router.js";

import "./styles.css";

/**
 * Render the page for the current address into the document's mount point.
 *
 * The path is a parameter with a default rather than a `window.location` read
 * buried in the body: the caller passes nothing, and the function stays
 * something that can be handed a path and asked what it would show.
 */
export function mountApp(root: HTMLElement, pathname: string = window.location.pathname): void {
  root.replaceChildren(resolveRoute(pathname));
}
