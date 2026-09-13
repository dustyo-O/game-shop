// @layer: e2e
// @spec: 004-storefront-per-the-design
// @regression
/**
 * functional-spec.md §2.8, all four criteria: every decorative control on the
 * storefront does nothing that looks like something — no navigation, no
 * request, no promise of a result it does not deliver.
 *
 * ---------------------------------------------------------------------------
 * RED FOR THIS FILE IS NOT WRITE-FIRST
 * ---------------------------------------------------------------------------
 * "Nothing happened" is the assertion most likely to pass vacuously (tech
 * spec §4.2's RED rule), so the real proof is running `assertInert` — the
 * exact function below, unmodified — against the one control on the page
 * that *does* do something: the first «Купить» button. That run, its failing
 * lines, and the restoration are recorded in `docs/walkthrough/phase-4-slice-
 * 1-the-structure.md` §5 rather than left in this file, so this spec always
 * contains only the real, passing checks
 * §2.8 asks for.
 */
import type { Page } from "@playwright/test";

import { expect, test } from "./support/orders.js";

const PROMISE_LEAK_PATTERN = /скоро|coming soon|загруз/iu;

/**
 * Every visible text node matching {@link PROMISE_LEAK_PATTERN}, so a click
 * can be compared against what was already on the page — the row's own
 * «Загрузка каталога…» is legitimately present while the catalogue is in
 * flight, and only a *new* match after a click would mean some control
 * started promising a result it does not deliver.
 */
async function promiseLeakTexts(page: Page): Promise<string[]> {
  return page.evaluate((source: string) => {
    const pattern = new RegExp(source, "iu");
    const found: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node !== null) {
      const text = (node.textContent ?? "").trim();
      if (text !== "" && pattern.test(text)) found.push(text);
      node = walker.nextNode();
    }
    return found;
  }, PROMISE_LEAK_PATTERN.source);
}

/** Waits past the product row's initial «Загрузка каталога…» into its settled state. */
async function waitForRowToSettle(page: Page): Promise<void> {
  await page.waitForSelector(".popular__list, .popular__status--error");
}

/**
 * Runs `act`, then asserts nothing on the page reacted to it: no navigation
 * request, no purchase request, no URL change, no uncaught page error, no
 * busy indicator, and no new "coming soon"-shaped sentence.
 *
 * Every listener is armed before `act` runs, so nothing it triggers can be
 * missed — the same ordering `support/orders.ts` uses for `POST /api/orders`.
 */
async function assertInert(page: Page, act: () => Promise<void>): Promise<void> {
  await waitForRowToSettle(page);

  const urlBefore = page.url();
  const leaksBefore = await promiseLeakTexts(page);

  const documentRequests: string[] = [];
  const orderRequests: string[] = [];
  const pageErrors: string[] = [];

  page.on("request", (request) => {
    if (request.resourceType() === "document") documentRequests.push(request.url());
    if (request.method() === "POST") {
      try {
        if (new URL(request.url()).pathname === "/api/orders") orderRequests.push(request.url());
      } catch {
        // Not a parseable absolute URL — cannot be the orders endpoint.
      }
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await act();

  // There is no signal to wait *for* here — every control under test is
  // meant to do nothing — so a bounded settle window is the only way to give
  // a stray effect a chance to show up before it is asserted absent.
  await page.waitForTimeout(500);

  const busyCount = await page.locator('[aria-busy="true"]').count();
  const leaksAfter = await promiseLeakTexts(page);
  const newLeaks = leaksAfter.filter((text) => !leaksBefore.includes(text));

  expect(documentRequests, `a document (navigation) request was issued: ${documentRequests.join(", ")}`).toEqual([]);
  expect(orderRequests, `a POST /api/orders request was issued: ${orderRequests.join(", ")}`).toEqual([]);
  expect(page.url(), `the URL changed from ${urlBefore}`).toBe(urlBefore);
  expect(pageErrors, `an uncaught script error was thrown: ${pageErrors.join(" | ")}`).toEqual([]);
  expect(busyCount, "an [aria-busy=\"true\"] element appeared").toBe(0);
  expect(newLeaks, `a "coming soon"-shaped sentence appeared: ${newLeaks.join(" | ")}`).toEqual([]);
}

test.describe("inert controls — functional spec §2.8", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("typing into the search field and pressing Enter does nothing", async ({ page }) => {
    await assertInert(page, async () => {
      await page.locator(".search__input").fill("тест");
      await page.locator(".search__input").press("Enter");
    });
  });

  test("clicking the favourites heart does nothing", async ({ page }) => {
    await assertInert(page, () => page.locator(".search__favourites").click());
  });

  test("clicking the search button does nothing", async ({ page }) => {
    await assertInert(page, () => page.locator(".search__submit").click());
  });

  test("clicking the profile button does nothing", async ({ page }) => {
    await assertInert(page, () => page.locator(".header__profile").click());
  });

  test("clicking the promo-code control does nothing", async ({ page }) => {
    await assertInert(page, () => page.locator(".steam-topup__promo").click());
  });

  const chipPositions = [0, 1, 2, 3, 4, 5, 6] as const;
  for (const index of chipPositions) {
    test(`clicking chip ${String(index + 1)} of 7 does nothing`, async ({ page }) => {
      await assertInert(page, () => page.locator(".chip").nth(index).click());
    });
  }

  test("clicking the «еще 841» tile does nothing", async ({ page }) => {
    // The eleventh and last service tile — see config/services.ts.
    await assertInert(page, () => page.locator(".service-tile").last().click());
  });

  test("typing a Steam login and clicking «Оплатить» does nothing", async ({ page }) => {
    await assertInert(page, async () => {
      await page.locator(".steam-topup__login-input").fill("test_login");
      await page.locator(".steam-topup__pay").click();
    });
  });
});
