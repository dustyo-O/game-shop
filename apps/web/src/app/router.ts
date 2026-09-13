/**
 * Which page a path shows. The whole router, and it is meant to stay this size.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS AND NOT A ROUTING LIBRARY
 * ---------------------------------------------------------------------------
 * There are three routes. A router package would bring a history abstraction, a
 * route-matching DSL, and a component adapter — none of which this app has
 * anything to ask of, and all of which would ship to every visitor of a
 * storefront whose whole point is that it is hand-built without a framework.
 * One regular expression and one `if` say the same thing in fewer lines than
 * the import statement would take to configure.
 *
 * ---------------------------------------------------------------------------
 * WHY IT RESOLVES ONCE, AT MOUNT, AND LISTENS TO NOTHING
 * ---------------------------------------------------------------------------
 * No `pushState`, no `popstate` listener, no in-app navigation. «Купить» now
 * navigates — `features/buy-product` sends the shopper to `/order/{id}` — and
 * it does it with an ordinary full-page load, exactly as this note anticipated:
 * one request against a bundle this size, and the back button, bookmarking and
 * reload all correct for free rather than re-implemented. Nothing pushes
 * history, so a `popstate` listener would still be machinery guarding an event
 * that cannot fire.
 *
 * If a later phase wants client-side transitions, this is where they go: push
 * the URL, call `resolveRoute` again, replace the mount point's children. The
 * signature does not have to change for that.
 *
 * ---------------------------------------------------------------------------
 * WHAT SERVES `/order/:id` — IT IS NOT THIS FILE
 * ---------------------------------------------------------------------------
 * A deep link only reaches this code if the *server* answers `/order/ord_x`
 * with `index.html`. Vite's dev server and `vite preview` both do (their SPA
 * fallback). The Vercel deployment needs a rewrite saying the same thing, and
 * that is Phase 6's business — recorded here so it is a known step rather than a
 * discovery made by a broken link after deploy.
 */
import { createAdminRecoveryPage } from "../pages/admin-recovery/index.js";
import { createOrderPage } from "../pages/order/index.js";
import { createStorefrontPage } from "../pages/storefront/index.js";

/**
 * `/order/{id}`, with an optional trailing slash. `[^/]+` rather than a
 * `ord_`-plus-ULID shape on purpose: matching the *format* of an id here would
 * be a second place that has to stay true of every id the shop has ever issued,
 * and it would answer a bad id by falling through to the storefront. Anything in
 * the slot is taken as an id and handed to the API, which answers `404`, and the
 * shopper reads «Заказ не найден» — the sentence functional spec §2.6 asks for.
 */
const orderPathPattern = /^\/order\/([^/]+)\/?$/u;

/**
 * The operator's recovery screen, with an optional trailing slash. A fixed path
 * with no parameter, so there is nothing to capture.
 *
 * ###########################################################################
 * # THIS LINE IS NOT A ROUTE GUARD, AND NOTHING HERE MAY BECOME ONE.
 * ###########################################################################
 *
 * `resolveRoute` answers this address for anybody who types it, with no check
 * of any kind — see `pages/admin-recovery/ui/admin-recovery-page.ts` for the
 * argument in full. The short version: a check the browser makes is a check the
 * browser can be told to skip, so the page renders for everyone and shows
 * nothing but a token form, while every byte of order data comes from an
 * endpoint that refuses without the token. Adding a redirect here would protect
 * nothing and would create the belief that something was protected.
 *
 * There is deliberately **no link to this path** anywhere in the storefront.
 */
const adminRecoveryPathPattern = /^\/admin\/recovery\/?$/u;

/**
 * `location.pathname` is percent-encoded; an order id is not. `ord_` + ULID
 * needs no decoding at all, but the value here came out of the address bar, and
 * an address bar holds whatever was pasted into it.
 *
 * The `try` is here because `decodeURIComponent` *throws* on a malformed
 * escape, and a throw on this line would leave the document blank — the one
 * outcome functional spec §2.6 rules out by name.
 *
 * Recorded honestly: **it could not be provoked through a browser.** Navigating
 * to `/order/%zz` never reaches this function, because the dev server rejects
 * the malformed URL itself (`ERR_HTTP_RESPONSE_CODE_FAILURE`) and the bundle is
 * never loaded. So this is a cheap second line rather than a branch the app can
 * demonstrate today; it stays because the failure it prevents is a white page
 * and the guard is three lines. The raw segment is a fine fallback anyway: it
 * reaches the API, matches nothing, and becomes «Заказ не найден».
 */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Build the page for a path.
 *
 * Anything that is neither the operator's screen nor an order path is the shop.
 * There is no separate
 * "page not found" screen, and that is a decision rather than an omission: the
 * shop has one address a shopper can mistype into something else, `/order/…`,
 * and that case already has its own Russian message from the API's `404`. A
 * mistyped `/shp` landing on the storefront is a shopper who is where they
 * wanted to be anyway.
 */
export function resolveRoute(pathname: string): HTMLElement {
  if (adminRecoveryPathPattern.test(pathname)) {
    return createAdminRecoveryPage();
  }

  const orderMatch = orderPathPattern.exec(pathname);

  if (orderMatch !== null) {
    // Group 1 exists whenever the pattern matched — it is the only group, and
    // it is not optional.
    return createOrderPage(decodeSegment(orderMatch[1] ?? ""));
  }

  return createStorefrontPage();
}
