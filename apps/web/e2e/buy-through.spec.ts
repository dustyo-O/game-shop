// @layer: e2e
// @spec: 004-storefront-per-the-design
// @regression
/**
 * functional-spec.md §2.7, criteria 1–4 (the reload path), plus §2.6 crit 1's
 * name/amount pairing carried onto the order page reached from a real card.
 *
 * technical-considerations.md §4.2's row for this file:
 *   | `e2e/buy-through.spec.ts` (real clock) | §2.7 crits 1–4 (reload path);
 *   §2.6 crit 1 | Click Купить on the first purchasable card →
 *   `waitForURL(/\/order\/ord_/)`, product name, amount, «Ожидает оплаты»;
 *   click the success control → the key appears with no further action
 *   (≤ 15 s); `dblclick` on a fresh page → exactly one `POST /api/orders` in
 *   the request log; `goBack()` → storefront, overlay hidden, and the dot
 *   advanced within ~7 s of real time. Every order id is captured from the
 *   `POST` response in a fixture before any assertion. |
 *
 * ---------------------------------------------------------------------------
 * WHY NO `page.clock` ANYWHERE IN THIS FILE (R15) — READ BEFORE ADDING ONE
 * ---------------------------------------------------------------------------
 * `banner.spec.ts` fakes time because every assertion it makes is about a
 * `setTimeout` this project owns end to end (`pages/storefront/model/
 * countdown.ts`). This file waits on something a faked clock cannot move:
 * `pages/order/model/poll.ts`'s `setTimeout` loop, chained off a *real*
 * `GET /api/orders/:id` round trip and a *real* delivery the API performs
 * against its own self-looped supplier stubs
 * (`apps/api/test/concurrency/support/api-instance.ts`'s "WHY EACH INSTANCE
 * POINTS ... AT ITSELF" — this project's `playwright.config.ts` spawns the
 * e2e's `apps/api` instance the same self-looped way, so a simulated payment
 * pressed below really is delivered a key by the local supplier stubs, not a
 * stand-in). Installing `page.clock` replaces the page's `setTimeout` with a
 * virtual one that only advances when `runFor` is called — the poll would
 * never fire again, no key would ever arrive, and the second test below would
 * hang until Playwright's own timeout rather than fail cleanly. So this file
 * is real-clock by necessity, not by omission, and the two places that costs
 * real wall time are named where they happen: the key normally arrives in
 * well under a second (order-page.ts's own measured 25–65ms delivery plus one
 * ~1s poll interval), given up to 15s of budget; the post-`goBack()` banner
 * tick normally lands at 5000ms, given up to 7.5s.
 *
 * ---------------------------------------------------------------------------
 * WHY ORDER IDS COME FROM THE FIXTURE'S ROUTE INTERCEPTION, NEVER FROM THE
 * URL AS THE PRIMARY SOURCE (R13)
 * ---------------------------------------------------------------------------
 * `./support/orders.ts`'s `trackCreatedOrders` fixture is `auto: true` and
 * captures every order id by reading `POST /api/orders`'s response on the
 * host side, strictly before the page's own `fetch()` can resolve and
 * `location.assign` navigate away — see that file's header for the proven
 * race a `page.on("response")` listener loses (one row left behind with the
 * listener version, zero with the route-interception fix). This is the one
 * spec file in the project that actually presses «Купить» for real, so it is
 * the one file whose cleanup does real work every time it runs: every test
 * below relies entirely on that fixture's teardown — which runs after each
 * test, functioning as this suite's `afterEach` — to keep the API suites'
 * `orders = 0` / `unclaimed = 50` baseline intact once this file is done. No
 * test here reads an id out of `page.url()` for cleanup purposes; the URL is
 * only ever used to match `waitForURL`'s pattern, and the id it could be
 * parsed out of is thrown away — the fixture's route interception is the
 * thing "only a test may do" (tech spec §4.2), and a second, ad hoc copy of
 * that extraction per test would be exactly the kind of drifting duplicate
 * R13 exists to avoid.
 *
 * ---------------------------------------------------------------------------
 * `pnpm test` MUST BE GREEN IMMEDIATELY AFTER THIS SUITE RUNS (R13)
 * ---------------------------------------------------------------------------
 * This file creates three real orders across its three tests and claims one
 * real key from the 50-key pool. `apps/api`'s own suites assert `orders = 0`
 * and `unclaimed = 50` before they run, so the fixture's cleanup below is not
 * optional housekeeping — it is the one thing standing between this file and
 * every suite that runs after it in `pnpm test`. See `./support/db.ts` for
 * the seven statements duplicated from the API harness's `cleanupTestOrders`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIRST TWO CRITERIA SHARE ONE TEST, AND THE OTHER TWO DO NOT
 * ---------------------------------------------------------------------------
 * §2.7 crit 2 ("simulate a successful payment ... through to their key")
 * only makes sense continuing from crit 1's own order page — it is the same
 * order, one purchase, watched to its end — so splitting them would either
 * duplicate the click-and-arrive steps or silently couple two tests through
 * execution order, which Playwright does not guarantee across files or
 * retries. R9's double-click and crit 4's back-navigation are each a
 * *different* scenario applied to a fresh purchase, so each gets its own
 * order and its own test, for the same reason `hover.spec.ts` and
 * `inert-controls.spec.ts` give every criterion its own `test()`: a shared
 * one that fails only says "something in this block broke", never which
 * criterion did.
 */
import type { Page } from "@playwright/test";

import { openE2eDatabase } from "./support/db.js";
import { expect, test } from "./support/orders.js";

/** Waits past the product row's initial «Загрузка каталога…» into its settled state. */
async function waitForRowToSettle(page: Page): Promise<void> {
  await page.waitForSelector(".popular__list, .popular__status--error");
}

/** Real-time budget for the key to arrive after the success control is pressed (§2.7 crit 2; R15). */
const KEY_DELIVERY_TIMEOUT_MS = 15_000;

/** Real-time budget for one automatic banner tick after `goBack()` (§2.7 crit 4; R15; tasks.md Slice 5 task 6). */
const BANNER_TICK_TIMEOUT_MS = 7_500;

/** `PaymentOutcome.Success` (`features/simulate-payment/api/payment-simulator-api.ts`) — the wire value, not the Russian label. */
const successControlSelector = '.payment-controls__button[data-outcome="success"]';

/**
 * The 0-based index of the `.banner__dot` currently carrying
 * `aria-current="true"`, mirroring `banner.spec.ts`'s own helper —
 * duplicated rather than shared, as every spec in this project keeps its own
 * small DOM readers.
 */
async function currentDotIndex(page: Page): Promise<number> {
  return page.evaluate(() => {
    const dots = Array.from(document.querySelectorAll(".banner__dot"));
    return dots.findIndex((dot) => dot.getAttribute("aria-current") === "true");
  });
}

test.describe("buy-through — Купить on the storefront reaches the key (functional spec §2.7)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await waitForRowToSettle(page);
  });

  test("crits 1–2 — Купить leads to the order page (name, amount, «Ожидает оплаты»), and the success control carries the shopper to the key within 15s", async ({
    page,
  }) => {
    // The card handed back is read by the same `data-sku` the button
    // carries — not by DOM proximity — so it is unambiguously the one the
    // click below is for.
    const buyButton = page.locator("button[data-sku]").first();
    const sku = await buyButton.getAttribute("data-sku");
    if (sku === null) throw new Error("the first button[data-sku] has no data-sku attribute");
    const card = page.locator(`.product-card[data-sku="${sku}"]`);

    // Read from the card BEFORE clicking — the card's own page is gone the
    // instant the click resolves (`buy-controls.ts`'s `location.assign`).
    const productName = (await card.locator(".product-card__name").innerText()).trim();
    const productPrice = (await card.locator(".product-card__price").innerText()).trim();

    await buyButton.click();
    await page.waitForURL(/\/order\/ord_/u);

    await expect(
      page.locator(".order-details__value--product"),
      "the order page names the same item the card did",
    ).toHaveText(productName);
    await expect(
      page.locator(".order-details__value--amount"),
      "the order page shows the same price the card did",
    ).toHaveText(productPrice);
    await expect(page.locator(".order-details__value--status")).toHaveAttribute("data-status", "created");
    await expect(
      page.locator(".order-details__value--status"),
      "«Ожидает оплаты» — entities/order/lib/order-status-label.ts's label for `created`",
    ).toHaveText("Ожидает оплаты");

    await page.locator(successControlSelector).click();

    // The order page's own poll (`pages/order/model/poll.ts`) does
    // everything from here with no further action from this test —
    // `toHaveAttribute` polls the DOM under the hood, so this is one
    // assertion with a real-time budget, not a manual wait loop.
    await expect(page.locator(".order-details__value--status")).toHaveAttribute("data-status", "delivered", {
      timeout: KEY_DELIVERY_TIMEOUT_MS,
    });
    await expect(
      page.locator(".order-details__value--status"),
      "«Ключ выдан» — order-status-label.ts's label for `delivered`",
    ).toHaveText("Ключ выдан");

    const code = await page.locator("[data-order-code]").getAttribute("data-order-code");
    expect(code, "a non-empty key was handed over").not.toBeNull();
    expect(code, "a non-empty key was handed over").not.toBe("");
  });

  test("R9 — double-clicking Купить still sends exactly one POST /api/orders, and one order exists", async ({
    page,
    createdOrderIds,
  }) => {
    const orderRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      try {
        if (new URL(request.url()).pathname === "/api/orders") orderRequests.push(request.url());
      } catch {
        // Not a parseable absolute URL — cannot be the orders endpoint.
      }
    });

    await page.locator("button[data-sku]").first().dblclick();
    await page.waitForURL(/\/order\/ord_/u);

    expect(
      orderRequests,
      `expected exactly one POST /api/orders, saw ${String(orderRequests.length)}: ${orderRequests.join(", ")}`,
    ).toHaveLength(1);

    // Slice 7 addition: §2.7 crit 3 says "one order exists", a fact about the
    // `orders` table — not "one POST was sent", the assertion above. The two
    // only look equivalent because this shop creates exactly one order per
    // successful POST; `createdOrderIds` (`./support/orders.ts`) is the same
    // signal the fixture's own cleanup trusts enough to delete rows by, so
    // reading it here checks the criterion's own words rather than a proxy
    // for them.
    //
    // RED: attempting the "two different cards" method used to RED-validate
    // `products.spec.ts`'s crit 1 in Slice 5 turned out unreliable on this
    // harness — a real navigation (`location.assign`, not an SPA route
    // change) tears down the document as soon as the first click's own
    // `createOrder` resolves, which on localhost is consistently faster than
    // the second `locator.click()`'s own actionability round trip through
    // CDP, so the second click either times out waiting for a now-detached
    // button or never reaches a document that still exists to receive it —
    // reproduced, not assumed: `locator.click: Test timeout of 30000ms
    // exceeded ... waiting for locator('button[data-sku]').nth(1)` with a
    // sequential second click, and a silent single order even with both
    // clicks fired concurrently via `Promise.all`. RED here instead points
    // the assertion at the wrong state, the task's other sanctioned method:
    // temporarily `.toBe(2)` against this same, correct single-`dblclick`
    // run failed with `Received: 1`, proving the check executes against the
    // real page rather than passing vacuously. Reverted to `.toBe(1)` below.
    expect(
      new Set(createdOrderIds).size,
      `expected exactly one order to exist, captured ${String(createdOrderIds.length)}: ${createdOrderIds.join(", ")}`,
    ).toBe(1);

    // Follow-up to Slice 7 (`docs/walkthrough/phase-4-slice-7-acceptance.md`
    // §5, §7 — "'one order exists' is asserted from ids, not rows"): the
    // assertion above is still the server's own claim, via the ids the route
    // handler captured off `2xx` bodies, that it created one order — closer
    // than a request count, but not yet the criterion's own words, which name
    // the `orders` table. A `count(*)` through the e2e's own client
    // (`./support/db.ts`'s `openE2eDatabase`, already the cleanup fixture's
    // source of truth for a real connection) is that row count directly.
    const db = openE2eDatabase();
    try {
      // select count(*)::int as n from orders where id = any($1::text[])
      const { rows } = await db.pool.query<{ n: number }>(
        `select count(*)::int as n from orders where id = any($1::text[])`,
        [createdOrderIds],
      );
      expect(
        rows[0]?.n,
        `expected exactly one row in orders for id(s) ${createdOrderIds.join(", ")}, found ${String(rows[0]?.n)}`,
      ).toBe(1);
    } finally {
      await db.close();
    }
  });

  test("crit 4 — the browser's back control returns to the storefront: overlay hidden, banner running again (reload path)", async ({
    page,
  }) => {
    await page.locator("button[data-sku]").first().click();
    await page.waitForURL(/\/order\/ord_/u);

    // Playwright disables the back/forward cache under any attached CDP
    // session (tech spec R1: "removing --disable-back-forward-cache does not
    // restore eligibility ... any attached CDP session disqualifies the
    // page"), so this `goBack()` is a full reload — `mountApp` runs again
    // from nothing, exactly as a fresh `goto("/")` would. The path this does
    // NOT exercise — the page restored *as it was left*, with its timer
    // cancelled and its Купить button still disabled — is proven by hand in
    // real Chrome per that same risk note; it cannot be automated here.
    await page.goBack();
    await expect(page).toHaveURL("/");

    const overlayHidden = await page
      .locator("#catalog-menu")
      .evaluate((element) => (element as HTMLElement).hidden);
    expect(overlayHidden, "the catalog overlay is closed — a fresh mount starts closed by construction").toBe(
      true,
    );

    // A fresh mount starts the carousel at slide 1 / dot 0 with a real
    // 5000ms `setTimeout` behind it (`model/countdown.ts`) — no clock is
    // installed anywhere in this file (see the header). This is the one
    // real-time wait in this suite: up to `BANNER_TICK_TIMEOUT_MS` of wall
    // time for the first automatic tick, margin included over the 5000ms
    // policy for CI jitter.
    const dotAfterReturn = await currentDotIndex(page);
    await expect
      .poll(async () => currentDotIndex(page), {
        message: "the current dot should change within ~7s of returning, proving the banner is running again",
        timeout: BANNER_TICK_TIMEOUT_MS,
      })
      .not.toBe(dotAfterReturn);
  });
});
