/**
 * The name of one purchase *intent*: "this shopper wants one copy of this SKU".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL, AND WHY IT IS NOT THREE LINES IN THE HANDLER
 * ---------------------------------------------------------------------------
 * `POST /api/orders` is idempotent per `Idempotency-Key`
 * (`orders.client_request_id UNIQUE`, I1): the first request carrying a key
 * creates the order, every later one is handed that same order back. All of the
 * value in that mechanism is decided *here*, by what the key is a property of.
 *
 *   - A key minted **inside the click handler** is a property of the click.
 *     A double-click mints two, sends two, and gets two orders — while every
 *     test that sends one key twice with `curl` still passes, because those
 *     tests supply the key the browser never reuses. The mechanism looks like it
 *     works and prevents nothing (technical-considerations §3, the second risk).
 *   - A key minted **per intent** — this file — is read back by the second
 *     click, by the second tab, and by the retry after a failure, so all of them
 *     arrive at the shop wearing the same name and the index folds them into one
 *     order.
 *
 * So the key is minted lazily on first need for a SKU, remembered under that
 * SKU, and forgotten the moment an order for it exists.
 *
 * ---------------------------------------------------------------------------
 * WHY `localStorage` AND NOT MEMORY OR `sessionStorage`
 * ---------------------------------------------------------------------------
 * Functional spec §2.1's third criterion is two *tabs* on the same purchase
 * producing one order. A module-level variable is per document and dies with the
 * first reload; `sessionStorage` is per tab by specification. `localStorage` is
 * the only one of the three that two tabs of the same origin actually share, and
 * it also survives the reload-then-click-again path that a shopper reaches by
 * being impatient.
 *
 * It carries an assumption, recorded rather than hidden
 * (technical-considerations, A1): **two tabs buying the same item at the same
 * time are one intent, not two.** A shopper who genuinely wants two copies gets
 * them by §2.1's fifth criterion — buy one, come back to the shop, buy again —
 * and by then the key has rotated. The cost of being wrong is a shopper who
 * wanted two copies simultaneously getting one order; the cost of the opposite
 * choice is a shopper being charged twice for one purchase. Only one of those is
 * a shop nobody trusts.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS LIVES: `features/buy-product/lib`, NOT `shared/`
 * ---------------------------------------------------------------------------
 * The key belongs with the behaviour that uses it. It is meaningless outside
 * "what happens when a shopper clicks «Купить»" — the entity's `api` segment
 * carries the header it is given and does not decide it, and `shared/` may not
 * know what a purchase is. One consumer, one owner; the moment a second feature
 * needs a safe-storage wrapper is the moment to lift the `try`/`catch` pair
 * below into `shared/lib`, and not before.
 */

/**
 * Namespaced so that one entry per SKU can be read, written and removed
 * individually, and so nothing else that ever writes to this origin's storage
 * can collide with it. The SKU is appended raw: it comes from `data-sku`, which
 * came from the catalogue, and a storage key is a string with no syntax to
 * confuse.
 */
const storageKeyPrefix = "game-shop:purchase-intent:";

/**
 * The API's own ceiling on `Idempotency-Key`, restated here because this is the
 * last place the value can be checked before it becomes a header
 * (`OrdersController.MAX_IDEMPOTENCY_KEY_LENGTH`). Nothing this file *mints*
 * comes close — a UUID is 36 characters — but what it *reads back* comes out of
 * a store the shopper can edit, and see {@link isUsableKey}.
 */
const maxKeyLength = 255;

/**
 * The fallback store, used only when `localStorage` is unavailable — see
 * {@link readStored}.
 *
 * Module-level, so it lives as long as the document and no longer. That is
 * exactly the degradation being chosen: repeated clicks and a retry after a
 * visible failure still share one key, because they happen in one document;
 * two tabs no longer do. A shopper with site data blocked keeps the guarantee
 * that matters most often and loses the one that needs storage to exist.
 */
const inMemoryKeys = new Map<string, string>();

function storageKeyFor(sku: string): string {
  return `${storageKeyPrefix}${sku}`;
}

/**
 * Is this a value that can be sent as an `Idempotency-Key` at all?
 *
 * Applied to what comes *back* from storage, never to what this file mints. The
 * store is per-origin and a shopper can put anything in it with two lines in a
 * console, and the failure mode of not checking is nasty out of proportion to
 * the check: an empty, whitespace-only or over-long key is a `400` from the API,
 * which the feature shows as «Не удалось оформить заказ…», and because a failed
 * attempt deliberately keeps its key (see {@link forgetPurchaseIntent}) the
 * shopper would be *permanently* unable to buy that SKU. Treating an unusable
 * stored value as no value at all costs one comparison and re-mints instead.
 *
 * The three clauses are the API's three, in its words: non-empty, not whitespace
 * (`value.trim() !== ""`), and at most {@link maxKeyLength}. The stricter
 * `trim() === value` rather than `trim() !== ""` is deliberate — the API stores
 * a key verbatim and would treat `"k"` and `"k "` as two different intents, so a
 * value with stray whitespace is not one this page should be sending.
 */
function isUsableKey(value: string): boolean {
  return value !== "" && value.trim() === value && value.length <= maxKeyLength;
}

/**
 * Read one intent key back, or `null`.
 *
 * ### Why every access to `localStorage` in this file is wrapped
 *
 * The property access itself throws, not just the call: Safari in private mode
 * historically threw on `setItem` past quota, Chrome throws a `SecurityError`
 * from `window.localStorage` outright when site data is blocked for the origin,
 * and a `getItem` can fail where a `setItem` succeeded. An uncaught throw here
 * would happen inside the «Купить» click handler and take the purchase down for
 * a reason that has nothing to do with buying anything.
 *
 * So storage is treated as an optimisation that is allowed to be missing. Every
 * read answers `null` on failure and every write is best-effort; the caller
 * cannot tell the difference and does not need to, because
 * {@link inMemoryKeys} is behind it.
 */
function readStored(sku: string): string | null {
  try {
    return window.localStorage.getItem(storageKeyFor(sku));
  } catch {
    return null;
  }
}

function writeStored(sku: string, key: string): void {
  try {
    window.localStorage.setItem(storageKeyFor(sku), key);
  } catch {
    // Deliberately silent. The key is already in `inMemoryKeys`, the purchase is
    // about to go out with it, and there is nothing a shopper could do with the
    // news that their browser will not remember it between tabs.
  }
}

function removeStored(sku: string): void {
  try {
    window.localStorage.removeItem(storageKeyFor(sku));
  } catch {
    // Same stance as `writeStored`: a store that cannot be cleared is a store
    // that never held anything, because a store that cannot be written is the
    // only way to reach here.
  }
}

/**
 * The key naming this shopper's intent to buy `sku` — the same string on every
 * call until {@link forgetPurchaseIntent} is called for that SKU.
 *
 * Minted lazily, on first need: no key is created for a product nobody clicked,
 * so a shopper browsing twelve items leaves nothing behind.
 *
 * `crypto.randomUUID()` — already in the browser, so nothing is added to a
 * bundle whose whole point is being hand-built, and 122 random bits make a
 * collision between two shoppers' intents a non-event. It is exactly 36
 * characters of hex and hyphens, so it satisfies the API's rules by
 * construction: non-empty, no whitespace, far inside {@link maxKeyLength}.
 * (It requires a secure context, which is both places this app runs — `localhost`
 * in development, HTTPS in deployment. Its absence would surface as the ordinary
 * Russian failure message, because the call sits inside the feature's `try`, not
 * as a page that stops responding.)
 *
 * The lookup order is storage first, then memory: storage is the shared truth
 * when it works, and memory only answers for the document that minted a key it
 * could not store.
 */
export function purchaseIntentKey(sku: string): string {
  const stored = readStored(sku);

  if (stored !== null && isUsableKey(stored)) {
    return stored;
  }

  const remembered = inMemoryKeys.get(sku);

  if (remembered !== undefined) {
    return remembered;
  }

  const minted = crypto.randomUUID();

  writeStored(sku, minted);
  inMemoryKeys.set(sku, minted);

  return minted;
}

/**
 * Forget the key for `sku`, so the next purchase of it is a new intent.
 *
 * ---------------------------------------------------------------------------
 * CALLED ON EXACTLY ONE EVENT: AN ORDER FOR THIS INTENT DEMONSTRABLY EXISTS
 * ---------------------------------------------------------------------------
 * That is `createOrder` having *resolved* — with an order id in hand, from a
 * `201` or a `200` alike — and it is the moment the shopper is being sent to
 * that order's page. Both halves of technical-considerations §2.1's "created,
 * and the shopper navigated away" are true at that instant and neither is true
 * before it.
 *
 * The two ways to get this wrong are opposite and both real:
 *
 *   - **Too early** — clearing when the request is *sent*, or on any failure —
 *     and functional spec §2.1's fourth criterion breaks. A click that appears
 *     to fail may well have succeeded at the server with only the response lost;
 *     the shopper clicks again, a fresh key is minted, and the shop cannot tell
 *     the retry from a new purchase. So a failed attempt keeps its key: that is
 *     precisely what makes clicking again safe.
 *   - **Too late** — never clearing, or clearing on some later timer — and §2.1's
 *     fifth criterion breaks in the more embarrassing direction. A shopper who
 *     buys the same game again from the shop page would send the old key and be
 *     handed their *first* order back, complete with the key they already own,
 *     with no way to buy a second copy at all.
 *
 * Between those, "the response arrived and it names an order" is the only event
 * that is certain in both directions.
 *
 * ### The one window this leaves, and why it is left open
 *
 * If the document dies between the request going out and the response arriving
 * — the tab is closed, the connection drops, the shopper hits Escape — the key
 * survives and the shopper's next click on that SKU is answered with the order
 * their lost request created. That is not a leak; it is the fourth criterion
 * working. From the shopper's side the two situations are the same one: they
 * clicked, they never saw an order, they clicked again — and they should get the
 * order they already have rather than a second charge. No expiry is put on the
 * stored key for the same reason: any timeout short enough to matter would turn
 * a slow retry into a double purchase.
 */
export function forgetPurchaseIntent(sku: string): void {
  removeStored(sku);
  inMemoryKeys.delete(sku);
}
