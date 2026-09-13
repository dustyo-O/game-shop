/**
 * Where the operator's bearer token is kept between renders of the recovery
 * screen, and nowhere else.
 *
 * ---------------------------------------------------------------------------
 * `sessionStorage`, DELIBERATELY THE OPPOSITE CHOICE FROM `purchase-intent.ts`
 * ---------------------------------------------------------------------------
 * `features/buy-product/lib/purchase-intent.ts` keeps its value in
 * `localStorage`, and explains at length why: functional spec 002 §2.1's third
 * criterion is *two tabs on the same purchase produce one order*, and
 * `localStorage` is the only web store two tabs of an origin actually share.
 *
 * Here every part of that reasoning runs backwards, so the answer does too:
 *
 *   - **Nothing needs sharing.** One operator, one tab, one list. There is no
 *     criterion anywhere in this spec that two tabs have to agree about.
 *   - **This value is a credential, and that one was a name.** A leaked
 *     idempotency key lets somebody re-request an order they already own. A
 *     leaked admin token opens the shop's recovery surface. The blast radius
 *     decides the storage, not the convenience.
 *   - **The storefront and this page are one origin and one bundle.** Anything
 *     running in the shopper's tab — a dependency, a console paste, an
 *     extension — reads the same `localStorage` this page would have written
 *     to. `sessionStorage` is per *tab* by specification, so the ordinary
 *     storefront tab an operator also has open cannot see it at all.
 *   - **It should not outlive the tab.** Closing the tab ends the session, and
 *     that is the desired behaviour rather than an accepted cost: the next
 *     person at that machine gets a token form, not a list of orders.
 *
 * The token is **never** put in the URL — not as a path segment, not as a query
 * parameter. A URL is written into browser history, sent onward in `Referer`,
 * and recorded verbatim in every access log between the browser and the server.
 *
 * ###########################################################################
 * # AND NEVER `VITE_ADMIN_TOKEN`, OR ANY OTHER `import.meta.env` VALUE.
 * ###########################################################################
 *
 * The tempting version of this file is one line — read the token out of the
 * build's environment and skip the form. It would work perfectly in
 * development, and it would ship the shop's admin credential to **every
 * shopper**: `apps/web` builds a single bundle that serves `/` and
 * `/admin/recovery` alike, Vite inlines every `VITE_`-prefixed variable into
 * that bundle as a string literal at build time, and the result is served from
 * a CDN to anyone who asks. There is no route-splitting in this app to hide
 * behind and there must not be one added for this purpose, because the hiding
 * would be the bug: a credential in a public bundle is public whichever chunk
 * it lands in. `apps/web` has no `.env` file and no `import.meta.env` reads
 * anywhere; that is the state this file is responsible for keeping.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY SINGLE ACCESS IS WRAPPED
 * ---------------------------------------------------------------------------
 * The property access **itself** throws, not just the call: Chrome raises a
 * `SecurityError` from `window.sessionStorage` outright when site data is
 * blocked for the origin, and a `getItem` can fail where a `setItem` succeeded.
 * An uncaught throw here would happen while the page was being built and leave
 * the operator a blank document during an incident — the one outcome this
 * screen exists to prevent elsewhere.
 *
 * So storage is treated as an optimisation that is allowed to be missing, with
 * {@link inMemoryToken} behind it. A browser with site data blocked still works
 * for as long as the document lives, which is the whole of one operator's
 * sitting.
 */

/**
 * Namespaced like `purchase-intent.ts`'s key, so nothing else that writes to
 * this origin's session storage can collide with it.
 */
const storageKey = "game-shop:admin-token";

/**
 * The fallback store, used when `sessionStorage` is unavailable.
 *
 * Module-level, so it lives exactly as long as the document. That is the
 * degradation being chosen: the operator pastes once and works; a reload asks
 * again. For a credential that is a smaller loss than for an idempotency key,
 * and it is one the failing browser has already declared it wants.
 */
let inMemoryToken: string | null = null;

/**
 * The stored token, or `null`.
 *
 * Memory is consulted **after** storage rather than before, matching
 * `purchase-intent.ts`: storage is the truth when it works, and memory answers
 * only for a document that could not write.
 */
export function readAdminToken(): string | null {
  try {
    const stored = window.sessionStorage.getItem(storageKey);

    if (stored !== null && stored !== "") {
      return stored;
    }
  } catch {
    // Deliberately silent — see the header. Fall through to memory.
  }

  return inMemoryToken;
}

/**
 * Remember the token for the rest of this tab's session.
 *
 * The value is written to memory first and to storage best-effort, so a browser
 * that refuses to store it still gives the operator a working page.
 */
export function storeAdminToken(token: string): void {
  inMemoryToken = token;

  try {
    window.sessionStorage.setItem(storageKey, token);
  } catch {
    // Deliberately silent. The token is already in memory, the request is about
    // to go out with it, and there is nothing an operator could do with the news
    // that their browser will not remember it across a reload.
  }
}

/**
 * Forget the token.
 *
 * **Called on exactly one event: the API answered `401`.** The stored value has
 * just been proven wrong by the only authority on the question, so keeping it
 * would make every subsequent render of this page start by sending a credential
 * that is known not to work — and would leave the operator staring at a form
 * that silently ignores what they paste, because the page would have a token
 * already.
 *
 * Not called on `503`. That answer says nothing at all about the token: the
 * deployment has no admin surface configured, and throwing away a perfectly
 * good credential because the server was switched off would be a second problem
 * to solve after the first one is fixed.
 */
export function clearAdminToken(): void {
  inMemoryToken = null;

  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // Same stance as `storeAdminToken`: a store that cannot be cleared is a
    // store that never held anything, because a store that cannot be written is
    // the only way to reach here.
  }
}
