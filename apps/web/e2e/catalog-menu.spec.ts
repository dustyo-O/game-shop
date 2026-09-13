// @layer: e2e
// @spec: 004-storefront-per-the-design
// @regression
/**
 * functional-spec.md §2.3, all six criteria: Каталог opens the overlay,
 * clicking it again closes it, a click outside the overlay closes it, Escape
 * closes it, a click on a category or a column item inside the overlay
 * changes nothing, and opening/closing several times in a row behaves the
 * same each time.
 *
 * technical-considerations.md §4.2's row for this file:
 *   | `e2e/catalog-menu.spec.ts` | §2.3 all six | `hidden` on the overlay and
 *   `aria-expanded` on the button; outside click on `body` far from the
 *   column; `keyboard.press("Escape")` with the search field focused (R8); a
 *   category and an item clicked → still open, URL unchanged, no
 *   `pageerror`; open/close ×3 |
 * ...and R8: "Escape while typing in the search field also closes the menu /
 * native clear interferes — the handler acts only when the menu is open and
 * never `preventDefault`s; both effects harmless; e2e drives the case with
 * the field focused."
 *
 * ---------------------------------------------------------------------------
 * NO FAKE CLOCK HERE
 * ---------------------------------------------------------------------------
 * Unlike `banner.spec.ts`, this file never installs `page.clock` — nothing
 * under test is time-based (`model/menu.ts` has no timer), and a faked clock
 * would only add ceremony a reviewer would have to explain away.
 *
 * ---------------------------------------------------------------------------
 * THREE FACTS FROM DRIVING `ui/catalog-menu.ts` LIVE, THAT SHAPE EVERY TEST
 * BELOW — READ THIS BEFORE "FIXING" THE `.focus()` CALLS TO `.click()`
 * ---------------------------------------------------------------------------
 * 1. The overlay is opened/closed by toggling its `hidden` *property*
 *    (`ui/catalog-menu.ts`'s `setOpen`), and the button's state is a
 *    separate `aria-expanded` attribute on `.header__catalog`. The two are
 *    written together by the same `setOpen` call but are two different DOM
 *    facts, so every test below reads both at once through the {@link
 *    menuState} helper rather than asserting one and assuming the other.
 *
 * 2. Clicking the search field is ITSELF an outside click: `.search__input`
 *    lives in `.header`, not inside `#catalog-menu`, so the one `document`
 *    click listener classifies a click there as `OutsideClick` and closes
 *    the menu (`ui/catalog-menu.ts`'s classification: button / overlay /
 *    anything else). To reach "menu open AND the search field focused" for
 *    the Escape case (R8), the field must be focused WITHOUT a click —
 *    `locator.focus()` below, never `.click()` — or the menu would already
 *    be closed before Escape is ever pressed. After Escape: the menu is
 *    closed and `document.activeElement` is the Каталог button
 *    (`catalogButton.focus()` in the handler); the field's own value is
 *    whatever Chromium's native `type="search"` Escape-clears behaviour
 *    leaves it as (the handler calls neither `preventDefault` nor
 *    `stopPropagation` — see that file's "ESCAPE, AND THE SEARCH FIELD'S OWN
 *    ESCAPE" section) — reported below for the record, asserted on nothing.
 *
 * 3. Two outside-click variants were confirmed by hand at this project's
 *    1440×900 viewport (`playwright.config.ts`): `page.mouse.click(20, 400)`
 *    lands on the grey ground beside the column
 *    (`document.elementFromPoint(20, 400)` → `DIV.storefront`, outside
 *    `.storefront__column`), and a click on `.popular__title`
 *    (`<h2>Популярные товары</h2>`) is a second, unrelated outside click —
 *    both are exercised together in the outside-click test below.
 *
 * ---------------------------------------------------------------------------
 * "STILL OPEN, NO NAVIGATION, NO ERROR" REUSES `inert-controls.spec.ts`'S
 * SHAPE
 * ---------------------------------------------------------------------------
 * An inner click on a category or a column item is exactly the kind of
 * "nothing happens" control `inert-controls.spec.ts`'s `assertInert` proves
 * for §2.8 — a `document`-request listener and a `pageerror` listener armed
 * *before* the act, plus a URL-unchanged check. `assertStillOpenAndInert`
 * below borrows that same listener pair rather than reinventing it, adding
 * only the one fact `assertInert` has no reason to know about: the overlay's
 * `hidden` state must also be unchanged.
 */
import type { Page } from "@playwright/test";

import { expect, test } from "./support/orders.js";

interface MenuState {
  readonly hidden: boolean;
  readonly expanded: string | null;
}

/**
 * Reads the overlay's `hidden` property and the button's `aria-expanded`
 * attribute together, so a failure names which one disagreed rather than
 * leaving the other assumed (fact 1 above).
 */
async function menuState(page: Page): Promise<MenuState> {
  return page.evaluate(() => {
    const overlay = document.querySelector("#catalog-menu");
    const button = document.querySelector(".header__catalog");
    if (overlay === null) throw new Error("#catalog-menu was not found");
    if (button === null) throw new Error(".header__catalog was not found");

    return {
      hidden: (overlay as HTMLElement).hidden,
      expanded: button.getAttribute("aria-expanded"),
    };
  });
}

/** The number of elements currently matching `selector`, anywhere in the document. */
async function elementCount(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel: string) => document.querySelectorAll(sel).length, selector);
}

/**
 * Runs `act`, then asserts the overlay is still open, the URL did not
 * change, and nothing errored or tried to navigate — the same
 * request/pageerror listener shape `inert-controls.spec.ts`'s `assertInert`
 * uses for §2.8's "nothing happened", plus the one extra fact specific to an
 * inner click on this overlay: `hidden` must not have flipped.
 */
async function assertStillOpenAndInert(page: Page, act: () => Promise<void>): Promise<void> {
  const urlBefore = page.url();
  const documentRequests: string[] = [];
  const pageErrors: string[] = [];

  page.on("request", (request) => {
    if (request.resourceType() === "document") documentRequests.push(request.url());
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  await act();

  expect((await menuState(page)).hidden, "the overlay stays open after a click inside it").toBe(false);
  expect(page.url(), `the URL changed from ${urlBefore}`).toBe(urlBefore);
  expect(documentRequests, `a document (navigation) request was issued: ${documentRequests.join(", ")}`).toEqual([]);
  expect(pageErrors, `an uncaught script error was thrown: ${pageErrors.join(" | ")}`).toEqual([]);
}

test.describe("catalog menu — opens and closes (functional spec §2.3)", () => {
  test.beforeEach(async ({ page }) => {
    // No settle-wait on the product row: every section the menu touches
    // (the header, the overlay itself) renders synchronously from Slice 1's
    // static markup — nothing here depends on `GET /api/products`.
    await page.goto("/");
  });

  test("crit 1 — closed on load; clicking Каталог opens the overlay with five categories and six columns", async ({
    page,
  }) => {
    const before = await menuState(page);
    expect(before.hidden, "the overlay is hidden on load").toBe(true);
    expect(before.expanded, 'aria-expanded="false" on load').toBe("false");

    await page.locator(".header__catalog").click();

    const after = await menuState(page);
    expect(after.hidden, "the overlay is no longer hidden after clicking Каталог").toBe(false);
    expect(after.expanded, 'aria-expanded="true" after clicking Каталог').toBe("true");

    await expect(page.locator(".catalog-menu__category").first()).toBeVisible();
    await expect(page.locator(".catalog-menu__heading").first()).toBeVisible();

    expect(await elementCount(page, ".catalog-menu__category"), "five categories down the left").toBe(5);
    expect(await elementCount(page, ".catalog-menu__heading"), "six column headings on the right").toBe(6);
  });

  test("crit 2 — clicking Каталог again on an open menu closes it", async ({ page }) => {
    await page.locator(".header__catalog").click();
    expect((await menuState(page)).hidden, "open before the second click").toBe(false);

    await page.locator(".header__catalog").click();

    const after = await menuState(page);
    expect(after.hidden, "closed after the second click").toBe(true);
    expect(after.expanded, 'aria-expanded="false" after the second click').toBe("false");
  });

  test("crit 3 — a click outside the overlay closes it (the ground beside the column, and the h2 heading)", async ({
    page,
  }) => {
    // Variant 1 (fact 3 above): the grey ground beside the column.
    await page.locator(".header__catalog").click();
    expect((await menuState(page)).hidden, "open before the first outside click").toBe(false);

    await page.mouse.click(20, 400);

    const afterGround = await menuState(page);
    expect(afterGround.hidden, "closed after clicking the ground beside the column").toBe(true);
    expect(afterGround.expanded, 'aria-expanded="false" after clicking the ground').toBe("false");

    // Variant 2: `<h2>Популярные товары</h2>` — a second, unrelated outside click.
    await page.locator(".header__catalog").click();
    expect((await menuState(page)).hidden, "open before the second outside click").toBe(false);

    await page.locator(".popular__title").click();

    const afterHeading = await menuState(page);
    expect(afterHeading.hidden, "closed after clicking the «Популярные товары» heading").toBe(true);
    expect(afterHeading.expanded, 'aria-expanded="false" after clicking the heading').toBe("false");
  });

  test("crit 4 — Escape closes the menu with the search field focused (R8), and steals no focus while closed", async ({
    page,
  }) => {
    // Open first, THEN focus the field with .focus() — never .click(), which
    // is itself an outside click and would close the menu before Escape is
    // ever pressed (fact 2 above).
    await page.locator(".header__catalog").click();
    expect((await menuState(page)).hidden, "open before focusing the search field").toBe(false);

    await page.locator(".search__input").focus();
    await expect(page.locator(".search__input")).toBeFocused();
    expect((await menuState(page)).hidden, "still open — focusing the field is not a click").toBe(false);

    await page.keyboard.press("Escape");

    const afterEscape = await menuState(page);
    expect(afterEscape.hidden, "closed after Escape, even with the search field focused").toBe(true);
    expect(afterEscape.expanded, 'aria-expanded="false" after Escape').toBe("false");

    const activeElementClassName = await page.evaluate(() => document.activeElement?.className ?? null);
    expect(activeElementClassName, "focus returns to the Каталог button").toBe("header__catalog");

    // Reported, not asserted (fact 2 above): Chromium's native Escape-clears
    // behaviour on `type="search"` runs alongside, since the handler calls
    // neither `preventDefault` nor `stopPropagation` by design.
    const searchValueAfterEscape = await page.locator(".search__input").inputValue();
    console.info(`crit 4: search field value after Escape = ${JSON.stringify(searchValueAfterEscape)}`);

    // The `isOpen` guard (ui/catalog-menu.ts): with the menu CLOSED,
    // focusing the field and pressing Escape must not steal focus to
    // Каталог — no focus theft.
    await page.locator(".search__input").focus();
    await page.keyboard.press("Escape");

    expect((await menuState(page)).hidden, "still closed — Escape on a closed menu is a no-op").toBe(true);
    await expect(page.locator(".search__input")).toBeFocused();
  });

  test("crit 5 — clicking a category or a column item inside the overlay changes nothing", async ({ page }) => {
    await page.locator(".header__catalog").click();
    expect((await menuState(page)).hidden, "open before the inner clicks").toBe(false);

    await assertStillOpenAndInert(page, () => page.locator(".catalog-menu__category").first().click());
    await assertStillOpenAndInert(page, () => page.locator(".catalog-menu__item").first().click());
  });

  test("crit 6 — opening and closing the menu three times in a row behaves the same each time", async ({ page }) => {
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      await page.locator(".header__catalog").click();
      const opened = await menuState(page);
      expect(opened.hidden, `open on cycle ${String(cycle)}`).toBe(false);
      expect(opened.expanded, `aria-expanded="true" on cycle ${String(cycle)}`).toBe("true");

      await page.locator(".header__catalog").click();
      const closed = await menuState(page);
      expect(closed.hidden, `closed on cycle ${String(cycle)}`).toBe(true);
      expect(closed.expanded, `aria-expanded="false" on cycle ${String(cycle)}`).toBe("false");
    }
  });
});
