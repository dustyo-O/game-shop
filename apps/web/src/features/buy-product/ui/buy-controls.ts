/**
 * What «Купить» does: create the order and hand the shopper to its page
 * (functional spec §2.2 — *"when the shopper uses the Buy control on a
 * purchasable item, then they arrive at an order page for that item"*).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FEATURE SLICE AND NOT A FEW LINES ON THE CATALOGUE PAGE
 * ---------------------------------------------------------------------------
 * It could not have gone in `entities/product` in any case: the card would have
 * to call `entities/order`, and an entity importing a sibling entity is the
 * same-layer import the layer rules forbid outright.
 *
 * That leaves the page or a feature, and the split the layers describe is the
 * one that actually applies here. The catalogue page's job is *which items
 * exist and how the list is built*; this file's job is *what happens when a
 * shopper clicks one* — a request, an in-flight state, two Russian failure
 * sentences and a navigation. They change for different reasons: the page
 * changes when the catalogue does, this changes when creating an order does.
 * Phase 4 replaced the catalogue page wholesale with `pages/storefront/`, the
 * storefront built from the design, and that page has «Купить» controls too —
 * behaviour left on the old page would have been behaviour rewritten then,
 * while this feature was one call from the new page.
 *
 * The project prefers light ceremony, and the ceremony here is genuinely light:
 * two files, one public function, no config and no model segment invented for
 * the sake of the shape.
 *
 * ---------------------------------------------------------------------------
 * WHY ONE DELEGATED LISTENER RATHER THAN A HANDLER PER BUTTON
 * ---------------------------------------------------------------------------
 * The page returns its element synchronously and replaces the content region
 * when the catalogue lands, so the buttons do not exist when this is wired up
 * and they can be replaced again afterwards. A listener on the container that
 * survives its own children is wired once, at page construction, and cannot go
 * stale — where per-button wiring would need re-running after every render, and
 * would silently do nothing the first time someone forgot.
 *
 * It keys on `button[data-sku]` rather than on the card's class name. The
 * entity puts `data-sku` on the control and documents it as *"the item's
 * identity everywhere else in this system: it is what `POST /api/orders`
 * takes"*, so this depends on the attribute the card advertises rather than on
 * a CSS class that belongs to its stylesheet.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE DISABLED BUTTON GUARANTEES, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * The control is disabled before the request goes out. It is re-enabled only
 * when the request fails — on success the page is already leaving, and
 * re-enabling would put a live «Купить» in front of a shopper for the duration
 * of the navigation, whose next click buys a second copy.
 *
 * That is a UX guarantee, and it is worth being exact about its edges.
 *
 *   **It guarantees**, within this one tab and on this one element, that a
 *   second click during an open request does nothing at all: a disabled button
 *   dispatches no click event, so an impatient double-click sends one request
 *   rather than two. The shopper is also never left holding a dead control —
 *   every failure path re-enables it and says why in Russian.
 *
 *   **It guarantees nothing whatsoever about the server**, which has never
 *   heard of this button. Two orders for one intent still arrive from: two
 *   tabs; a reload mid-flight and another click, since the reload throws the
 *   flag away while the first request is still on its way; a request that timed
 *   out at the client but succeeded at the server, retried by a shopper who was
 *   shown the failure message; and any client that is not this page at all —
 *   `curl`, a script, a mobile browser that double-submits. Phase 1's
 *   verification demonstrated the last of those on purpose: two concurrent
 *   `POST /api/orders` for one SKU created two orders, and no state held in a
 *   page could have stopped it.
 *
 * **Where the real boundary has to sit, and now does.** Not in the page: the
 * page is one client among many and the only one that cooperates. Not in the API
 * process either — a "have I seen this already?" check followed by an insert
 * races with itself the moment two requests are in flight together, and in the
 * deployed shape they are served by two function instances that share no memory.
 * It has to be at the write, in the database, which is the first and only place
 * every concurrent attempt meets the same row. Phase 2 puts it there:
 * `orders.client_request_id UNIQUE` plus an `Idempotency-Key` header naming the
 * shopper's intent, so the second insert loses the race and the original order
 * comes back instead of a new one (architecture.md §3, I1).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE CONTRIBUTES TO THAT: THE KEY IS NOT MINTED HERE
 * ---------------------------------------------------------------------------
 * The database can only fold two requests into one order if they arrive wearing
 * the same name, and choosing that name is the browser's half of the mechanism —
 * the half that is easy to get wrong invisibly. `crypto.randomUUID()` written
 * into `buy` below would name the *click*: a double-click would send two names
 * and buy two copies, with the server behaving perfectly throughout.
 *
 * So the name comes from `../lib/purchase-intent.js`, where it is a property of
 * the shopper's intent to buy this SKU — minted once, shared by every later
 * click, by a second tab and by a retry after a visible failure, and forgotten
 * only once an order for it exists. That file carries the reasoning; the two
 * calls below are the whole of its use.
 *
 * ---------------------------------------------------------------------------
 * THE BACK/FORWARD CACHE: THE ONE PLACE THE DISABLED BUTTON OUTLIVES ITS PAGE
 * ---------------------------------------------------------------------------
 * `buy` disables the control synchronously and leaves it disabled while
 * `location.assign` runs. That is right for the page that is leaving — the
 * section above says why — and it rests on the page actually leaving: the
 * navigation discards the document, and the dead button goes with it.
 *
 * The back/forward cache breaks that assumption in exactly one direction. A
 * browser that caches the storefront on the way out restores it on the way
 * back *as it was left* — same document, same listeners, same DOM — and the
 * DOM was left with one «Купить» disabled. The shopper who bought a game,
 * looked at their order and pressed back would meet a control that does
 * nothing, with no request open and no message saying why: the broken control
 * spec 004's functional spec §1 says the storefront never shows (its
 * technical-considerations §2.3; R12).
 *
 * So on a persisted `pageshow` — `event.persisted === true` is a restore from
 * the cache, and nothing else — every disabled buy button inside the container
 * is re-enabled. **A second press is then correct as a new order, not a
 * double charge.** `forgetPurchaseIntent(sku)` already ran on success, before
 * the navigation, so the intent that produced the first order no longer exists
 * in storage; the next click on that SKU mints a fresh key, and the fresh key
 * names a fresh intent. The shop is not charging twice for one decision — it
 * is selling a second copy on a second decision, which is spec 002 §2.1's
 * fifth criterion (buy, come back, buy again) reached by the back button
 * instead of by the shop's own link.
 *
 * The guard on `persisted` is not what protects a fresh load — a fresh load
 * never has a disabled button, because `mountApp` builds the page from
 * nothing. It is there so that this handler does exactly one thing on exactly
 * one event and is a no-op everywhere else, which is what makes the next
 * paragraph true.
 *
 * **Nothing else in the feature changes.** The click path is the same
 * delegated listener; the key is still minted by `../lib/purchase-intent.js`
 * and still forgotten only on success; every failure path still re-enables
 * and still speaks Russian; `POST /api/orders` still receives the same
 * `Idempotency-Key`. This handler touches the `disabled` property of buttons
 * that are already in the container and nothing more. Its listener is never
 * removed — the app has no unmount, and a cached page keeps its listeners
 * along with everything else, which is exactly what lets `pageshow` find it
 * (the same stance `pages/storefront/ui/banner.ts` takes for its clock and
 * `ui/catalog-menu.ts` for its overlay).
 *
 * This path is not reachable under Playwright: any CDP session disables the
 * back/forward cache, so under automation back is always a full reload and
 * the button is enabled by construction. Its proof is a person in real Chrome
 * (spec 004 technical-considerations §2.3, "both restore paths must be
 * exercised, by different means").
 */
import { createOrder, ProductNotPurchasableError } from "../../../entities/order/index.js";
import { createElement } from "../../../shared/lib/dom.js";
import { forgetPurchaseIntent, purchaseIntentKey } from "../lib/purchase-intent.js";

/**
 * The two sentences a shopper can be shown when a purchase does not start
 * (functional spec §2.8: every message shown to a shopper is Russian).
 *
 * Two rather than one, and the split is the same one `entities/order` draws for
 * reading an order: these call for different actions. An API that did not answer
 * is temporary and clicking again is exactly right. A `422` means this page's
 * catalogue no longer matches the shop's — the control is offered only where
 * `GET /api/products` said `purchasable` — so clicking again will fail the same
 * way for as long as the page stays open, and reloading is the move.
 */
const text = {
  failed: "Не удалось оформить заказ. Проверьте соединение и попробуйте ещё раз.",
  notPurchasable: "Этот товар сейчас нельзя купить. Обновите страницу.",
} as const;

/** The control the entity renders on a purchasable card — see the note above on `data-sku`. */
const buyButtonSelector = "button[data-sku]";

/** Owned by this feature, not by the card: the message is this behaviour's, and so is its class. */
const errorClass = "buy-product__error";

function messageFor(error: unknown): string {
  return error instanceof ProductNotPurchasableError ? text.notPurchasable : text.failed;
}

/**
 * Drop the message left by a previous attempt, so a shopper who clicks again
 * does not read a stale sentence while the new request is still open.
 */
function clearMessage(button: HTMLButtonElement): void {
  button.parentElement?.querySelector(`.${errorClass}`)?.remove();
}

/**
 * Put the failure next to the control that failed, not at the top of the page:
 * the shopper is looking at the button they just pressed, and on a list of
 * twelve items a message anywhere else would belong to no particular row.
 *
 * `role="alert"` so a screen reader announces it — this text appears after the
 * shopper acted and nothing else on screen moves.
 */
function showMessage(button: HTMLButtonElement, message: string): void {
  button.insertAdjacentElement(
    "afterend",
    createElement("p", { className: errorClass, text: message, attributes: { role: "alert" } }),
  );
}

/**
 * One purchase attempt.
 *
 * Never rejects: both outcomes are handled here, which is what lets the click
 * handler fire it off without an `await` it has nothing to do with.
 *
 * The navigation is an ordinary full-page load, as `app/router.ts` anticipated.
 * There are two routes and no history listener, and a load gets the back
 * button, bookmarking and reload right without re-implementing any of them. It
 * also discards this page and everything it was holding, which is why success
 * has no state to unwind — the disabled button leaves with the document.
 *
 * **The intent key is read, not made, and is dropped only on success.** Reading
 * it inside the `try` means a browser that cannot mint one becomes the ordinary
 * Russian failure rather than a click that does nothing. Dropping it after
 * `createOrder` resolves — before the navigation, because `location.assign` does
 * not stop this function and a storage write is synchronous — is the one moment
 * an order for this intent is known to exist. Every failure path below leaves it
 * in place on purpose, which is what makes clicking «Купить» again after a
 * failure produce the *same* order instead of a second one.
 */
async function buy(button: HTMLButtonElement, sku: string): Promise<void> {
  clearMessage(button);
  button.disabled = true;

  try {
    const orderId = await createOrder(sku, purchaseIntentKey(sku));

    forgetPurchaseIntent(sku);

    // Deliberately still disabled: see the note above on what that does and
    // does not mean.
    window.location.assign(`/order/${encodeURIComponent(orderId)}`);
  } catch (error: unknown) {
    showMessage(button, messageFor(error));
    button.disabled = false;
  }
}

/**
 * Make every «Купить» control inside `container` — including the ones rendered
 * after this call — start a purchase.
 *
 * Wired once, at page construction. `container` is the element that survives
 * the catalogue landing; the buttons inside it need not exist yet.
 */
export function enableBuyControls(container: HTMLElement): void {
  container.addEventListener("click", (event: MouseEvent) => {
    const { target } = event;

    if (!(target instanceof Element)) {
      return;
    }

    // `instanceof` rather than a cast: `closest` promises an `Element`, and
    // this is the line that makes it a button the code can disable.
    const button = target.closest(buyButtonSelector);

    if (!(button instanceof HTMLButtonElement)) {
      return;
    }

    // The selector matched on the attribute, so this is present in practice;
    // the check is what turns "in practice" into something the compiler holds.
    const sku = button.getAttribute("data-sku");

    if (sku === null || sku === "") {
      return;
    }

    // Fire-and-forget: `buy` handles both outcomes itself and never rejects.
    void buy(button, sku);
  });

  // Page lifecycle — see the file header's back/forward-cache section. Never
  // removed: there is no unmount. The selector narrows to `:disabled` so an
  // enabled button is not touched at all, and the `instanceof` is the same
  // line as the click path's — `querySelectorAll` promises `Element`, and
  // this is what makes it a button with a `disabled` property to clear.
  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) {
      return;
    }

    for (const button of container.querySelectorAll(`${buyButtonSelector}:disabled`)) {
      if (button instanceof HTMLButtonElement) {
        button.disabled = false;
      }
    }
  });
}
