// @layer: e2e
// @spec: 004-storefront-per-the-design
/**
 * The Slice 7 feature-level acceptance spec —
 * `context/spec/004-storefront-per-the-design/tasks.md`, "Feature Testing &
 * Regression": not one more per-criterion regression guard (those are
 * `banner.spec.ts`, `catalog-menu.spec.ts`, `currency.spec.ts`, `hover.
 * spec.ts`, `inert-controls.spec.ts`, `layout.spec.ts`, `products.spec.ts`
 * and `buy-through.spec.ts`, each written and RED-validated slice by slice
 * against a freshly loaded page), but the one seam none of them was ever
 * positioned to prove: that all five graded interactions still work — and
 * still let a real purchase through — *after* a shopper has actually used
 * the page, in one session, not in eight independent ones.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL — THE SEAM, NOT THE SLICES AGAIN
 * ---------------------------------------------------------------------------
 * Every sibling spec's `beforeEach` calls `page.goto("/")` and drives exactly
 * the one interaction it is named for, so none of them can see whether:
 *   - the banner's own timer survives a manual arrow press, an opened-then-
 *     closed catalog menu, a currency click and two hovers happening first
 *     (`model/countdown.ts`'s "one timer slot" claim, exercised for real
 *     rather than only unit-tested against the reducer in isolation);
 *   - the catalog menu's single `document` click listener — the one this
 *     project deliberately has only one of (`pages/storefront/CLAUDE.md`) —
 *     still classifies a click on Каталог correctly after the currency
 *     radio group and the hover states have already handled pointer/focus
 *     events of their own;
 *   - a card carrying the CSS-only hover lift (`transform`, no script) still
 *     delivers a real click to its `button[data-sku]` and reaches the same
 *     order page `buy-through.spec.ts` reaches from a page that was never
 *     touched first;
 *   - the reload path back from that order page (`goBack()`) restores a
 *     *used* storefront — menu closed, banner ticking — not merely a fresh
 *     one that happened to start that way.
 * Each of those is a fact about the composed page, not about any one
 * criterion, and a regression in the composition (state one interaction
 * leaves behind leaking into another) is exactly the class of bug eight
 * isolated specs, each starting clean, cannot see by construction.
 *
 * One test, not five: splitting "banner, then menu, then currency, then
 * hover, then buy" into five tests would either duplicate the whole setup
 * five times or silently couple five tests through Playwright's execution
 * order — which this project does not rely on anywhere else (`buy-through.
 * spec.ts`'s header makes the same call for the same reason). This is
 * deliberately the one file in the project where that coupling is the point:
 * the thing under test *is* the sequence.
 *
 * ---------------------------------------------------------------------------
 * REAL CLOCK THROUGHOUT — NO `page.clock` ANYWHERE IN THIS FILE (R15)
 * ---------------------------------------------------------------------------
 * This is a buy-through (`buy-through.spec.ts`'s own header explains why a
 * faked clock and the order page's delivery poll cannot mix), so the banner
 * arrow press is asserted as an instant DOM change (no timer involved) and
 * the one auto-advance this file observes — after `goBack()`, proving the
 * countdown survived the whole session — is read with `expect.poll` over a
 * real ~7.5s budget, exactly as `buy-through.spec.ts`'s own back-navigation
 * test does, and for the same reason: `expect.poll` is one assertion with a
 * time budget, not a manual wait loop.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE CARRIES NO `@regression`
 * ---------------------------------------------------------------------------
 * See `./support/orders.ts`'s header — the decision for every file under
 * `e2e/` is written there once: the eight sibling specs are permanent,
 * one-criterion-at-a-time regression guards and keep `@regression`; this
 * file is the feature-level walk of the whole assembled path, the same role
 * `apps/api/test/acceptance/failure-and-recovery.test.ts` plays for spec 003
 * (which likewise carries `@layer` and `@spec`, never `@regression`), and
 * does not.
 *
 * RED (tasks.md's standing rule, and this task's own allowance to satisfy it
 * "by pointing an assertion at the wrong state" when the behaviour under test
 * already exists end to end from earlier slices): the catalog-menu assertion
 * below was first written as `expect(afterClose.hidden, ...).toBe(false)` —
 * asserting the overlay was still open after the second Каталог click — and
 * failed with `Expected: false / Received: true`, proving the assertion
 * actually runs against the real page rather than passing vacuously. Fixed to
 * `.toBe(true)` below once that failure was recorded.
 *
 * A second RED was added by a follow-up to this slice (`docs/walkthrough/
 * phase-4-slice-7-acceptance.md` §5, §7, §9): step 7's final poll used to
 * read `dotBeforeReturn` *before* `page.goBack()`, while the page was still
 * on `/order/ord_…`, where `currentDotIndex` finds no `.banner__dot` and
 * returns `-1` — so `expect.poll(...).not.toBe(dotBeforeReturn)` compared the
 * fresh storefront's dot 0 against `-1` and passed on its first read whether
 * or not the timer was running. Fixed the way `buy-through.spec.ts`'s crit 4
 * test already does it: the dot is read only after `goBack()` and
 * `toHaveURL("/")` confirm the page is back on `/`, renamed `dotAfterReturn`
 * to match.
 *
 * The first inversion tried — `.toBe(dotAfterReturn)`, asserting the dot
 * never changes — turned out to be exactly the same vacuous shape as the bug
 * being fixed: `expect.poll`'s callback runs once immediately, and at that
 * instant the dot has not yet had time to move, so `.toBe(dotAfterReturn)`
 * is satisfied on its very first read and the test passes in ~3s without
 * ever exercising the 7.5s budget — proven by running it, not assumed.
 * Inverted instead to `.toBe(-1)`, a value `currentDotIndex` cannot return
 * once the storefront has real `.banner__dot` elements, which forces the
 * poll to exhaust its full budget against a page that is genuinely
 * advancing, and failed with:
 *
 *   Error: the current dot should change within ~7.5s of returning, proving
 *   the banner's timer is running again after the whole session above
 *   expect(received).toBe(expected) // Object.is equality
 *   Expected: -1
 *   Received: 1
 *   Call Log:
 *   - Timeout 7500ms exceeded while waiting on the predicate
 *
 * — `Received: 1`, a real dot index rather than the old `-1` sentinel,
 * proving both that the fixed read no longer returns `-1` and that the poll
 * runs against live state for the full window rather than short-circuiting.
 * Reverted to `.not.toBe(dotAfterReturn)` below once that failure was
 * recorded. `orders = 0` / `unclaimed = 50` held after this failing run too
 * — the fixture's cleanup runs on a failed test the same as a passing one.
 */
import type { Page } from "@playwright/test";

import { expect, test } from "./support/orders.js";

/** Waits past the product row's initial «Загрузка каталога…» into its settled state. */
async function waitForRowToSettle(page: Page): Promise<void> {
  await page.waitForSelector(".popular__list, .popular__status--error");
}

/** The 1-based position of the one `.banner__slide` that does not carry `hidden`. */
async function visibleSlide(page: Page): Promise<number> {
  const index = await page.evaluate(() => {
    const slides = Array.from(document.querySelectorAll<HTMLElement>(".banner__slide"));
    return slides.findIndex((slide) => !slide.hidden);
  });
  if (index === -1) throw new Error("no .banner__slide is visible — every one carries `hidden`");
  return index + 1;
}

/** The 0-based index of the `.banner__dot` currently carrying `aria-current="true"`. */
async function currentDotIndex(page: Page): Promise<number> {
  return page.evaluate(() => {
    const dots = Array.from(document.querySelectorAll(".banner__dot"));
    return dots.findIndex((dot) => dot.getAttribute("aria-current") === "true");
  });
}

/** Real-time budget for one automatic banner tick after `goBack()` — matches `buy-through.spec.ts` (§2.7 crit 4; R15). */
const BANNER_TICK_TIMEOUT_MS = 7_500;

/** Real-time budget for the key to arrive after the success control is pressed — matches `buy-through.spec.ts` (§2.7 crit 2; R15). */
const KEY_DELIVERY_TIMEOUT_MS = 15_000;

/** `PaymentOutcome.Success` (`features/simulate-payment/api/payment-simulator-api.ts`) — the wire value, not the Russian label. */
const successControlSelector = '.payment-controls__button[data-outcome="success"]';

/** How long to wait past a CSS transition before reading its settled end state (R14) — matches `hover.spec.ts`'s `SETTLE_MS`. */
const HOVER_SETTLE_MS = 250;

test.describe("acceptance — the whole path once: every graded interaction touched, then a real buy-through and back", () => {
  test("land at /, use the banner arrow, open+close the menu, switch currency, hover a tile and a card, buy through to the key, and return", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForRowToSettle(page);

    // ---- 1. Banner: the next arrow moves the slide at once (§2.2 crit 3) ----
    expect(await visibleSlide(page), "starts on slide 1").toBe(1);
    await page.locator(".banner__arrow--next").click();
    expect(await visibleSlide(page), "the arrow moved the slide before anything else on the page was touched").toBe(
      2,
    );

    // ---- 2. Catalog menu: opens, then closes on a second click (§2.3 crits 1-2) ----
    const menuState = async (): Promise<{ hidden: boolean; expanded: string | null }> =>
      page.evaluate(() => {
        const overlay = document.querySelector("#catalog-menu");
        const button = document.querySelector(".header__catalog");
        if (overlay === null) throw new Error("#catalog-menu was not found");
        if (button === null) throw new Error(".header__catalog was not found");
        return { hidden: (overlay as HTMLElement).hidden, expanded: button.getAttribute("aria-expanded") };
      });

    expect((await menuState()).hidden, "closed before the first click").toBe(true);
    await page.locator(".header__catalog").click();
    const afterOpen = await menuState();
    expect(afterOpen.hidden, "open after clicking Каталог").toBe(false);
    expect(afterOpen.expanded, 'aria-expanded="true" while open').toBe("true");

    await page.locator(".header__catalog").click();
    const afterClose = await menuState();
    expect(afterClose.hidden, "closed again after the second click — the menu does not stay open for the rest of the session").toBe(
      true,
    );
    expect(afterClose.expanded, 'aria-expanded="false" once closed').toBe("false");

    // ---- 3. Currency: clicking ₸ makes it active (§2.4 crit 2) ----
    await page.locator('label[for="currency-kzt"]').click();
    const kztChecked = await page.locator("#currency-kzt").isChecked();
    expect(kztChecked, "«₸» became the active option — the earlier menu clicks did not consume this click").toBe(
      true,
    );

    // ---- 4. Hover a service tile: it highlights (§2.5 crits 1, 3) ----
    const tileBackgroundBefore = await page
      .locator(".service-tile")
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await page.locator(".service-tile").first().hover();
    await page.waitForTimeout(HOVER_SETTLE_MS);
    const tileBackgroundAfter = await page
      .locator(".service-tile")
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(
      tileBackgroundAfter,
      "hovering the first tile changed its painted background, after the banner/menu/currency interactions above",
    ).not.toBe(tileBackgroundBefore);

    // ---- 5. Hover, then buy, the same product card (§2.6 crits 2-3; §2.7 crits 1-2) ----
    // The card under test is whichever the first purchasable button belongs
    // to — read fresh here, not assumed, the same discipline `buy-through.
    // spec.ts` uses. Hovering it first is the realistic shopper motion this
    // file exists to prove does not interfere with the click underneath the
    // CSS-only lift transform.
    const buyButton = page.locator("button[data-sku]").first();
    const sku = await buyButton.getAttribute("data-sku");
    if (sku === null) throw new Error("the first button[data-sku] has no data-sku attribute");
    const card = page.locator(`.product-card[data-sku="${sku}"]`);

    const cardTransformBefore = await card.evaluate((element) => getComputedStyle(element).transform);
    await card.hover();
    await page.waitForTimeout(HOVER_SETTLE_MS);
    const cardTransformAfter = await card.evaluate((element) => getComputedStyle(element).transform);
    expect(cardTransformAfter, "hovering the card lifted it").not.toBe(cardTransformBefore);

    const productName = (await card.locator(".product-card__name").innerText()).trim();
    const productPrice = (await card.locator(".product-card__price").innerText()).trim();

    await buyButton.click();
    await page.waitForURL(/\/order\/ord_/u);

    await expect(
      page.locator(".order-details__value--product"),
      "the order page names the card that was hovered a moment ago, not some other one",
    ).toHaveText(productName);
    await expect(page.locator(".order-details__value--amount")).toHaveText(productPrice);
    await expect(
      page.locator(".order-details__value--status"),
      "«Ожидает оплаты» — the order starts waiting for payment",
    ).toHaveText("Ожидает оплаты");

    // ---- 6. Pay, and reach the key with no further action (§2.7 crit 2) ----
    await page.locator(successControlSelector).click();
    await expect(page.locator(".order-details__value--status")).toHaveAttribute("data-status", "delivered", {
      timeout: KEY_DELIVERY_TIMEOUT_MS,
    });
    const code = await page.locator("[data-order-code]").getAttribute("data-order-code");
    expect(code, "a non-empty key was handed over").not.toBeNull();
    expect(code, "a non-empty key was handed over").not.toBe("");

    // ---- 7. Back to the storefront: menu still closed, banner still running (§2.7 crit 4, reload path) ----
    await page.goBack();
    await expect(page).toHaveURL("/");

    const overlayHiddenOnReturn = await page
      .locator("#catalog-menu")
      .evaluate((element) => (element as HTMLElement).hidden);
    expect(
      overlayHiddenOnReturn,
      "the catalog overlay is closed on return — a fresh mount starts closed by construction, and this session had already opened it once",
    ).toBe(true);

    // Read only now — once the page is confirmed back on "/" and a
    // `.banner__dot` actually exists to read. Reading it any earlier (while
    // still on `/order/ord_…`, where no `.banner__dot` exists and this
    // helper returns `-1`) is the bug this poll used to carry: the fresh
    // page's dot 0 would then differ from `-1` on the very first read,
    // passing whether or not the timer was running (phase-4-slice-7-
    // acceptance.md §5, §7, §9).
    const dotAfterReturn = await currentDotIndex(page);
    await expect
      .poll(async () => currentDotIndex(page), {
        message: "the current dot should change within ~7.5s of returning, proving the banner's timer is running again after the whole session above",
        timeout: BANNER_TICK_TIMEOUT_MS,
      })
      .not.toBe(dotAfterReturn);
  });
});
