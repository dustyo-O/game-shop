// @layer: e2e
// @spec: 004-storefront-per-the-design
// @regression
/**
 * functional-spec.md §2.5, all four criteria (service tiles highlight on
 * hover) and §2.6's hover/focus criteria 2–3 (product cards lift on hover and
 * settle back on leave).
 *
 * technical-considerations.md §4.2's row for this file:
 *   | `e2e/hover.spec.ts` | §2.5; §2.6 hover/focus | `transition-duration > 0`
 *   on tile and card (the "fades" evidence, a static read); after `hover` +
 *   the duration the hovered tile's style differs from an unhovered one and
 *   only it; Tab to a tile → focus style equals hover style; card `transform`
 *   is a `translateY` matrix on hover and `none` after; `emulateMedia({
 *   reducedMotion: "reduce" })` → no transform, colour still changes |
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY HOVER ASSERTION HERE IS A STATIC READ OR AN END-STATE READ, NEVER
 * A VALUE MID-FADE (R14)
 * ---------------------------------------------------------------------------
 * `storefront.css`'s MOTION section fades every hover state over 160 ms
 * (tiles) or 180 ms (cards) rather than switching instantly — that is the
 * behaviour §2.5/§2.6 grade ("the highlight fades in rather than switching on
 * instantly", "the change animates rather than switching instantly"). A
 * computed style read *while* that fade is in flight is an interpolated
 * value — e.g. `rgba(180, 180, 183, 0.6)` partway between transparent and
 * `--sf-ground` — that depends on exactly how many milliseconds elapsed
 * before Playwright's round trip landed, which is not a fact this suite can
 * pin down and not a fact worth pinning down: the spec asks whether the
 * highlight fades, not what shade it is at some arbitrary instant (R14: "a
 * computed style mid-transition is the classic false negative").
 *
 * So this file proves "fades" two different ways, neither of which reads a
 * moving target:
 *   1. A *static* read of `transition-duration` itself — a CSS property that
 *      does not change over the course of the transition it describes — is
 *      the evidence that a fade is configured at all (crit 1 below).
 *   2. Every value this file reads *during* an interaction is read only after
 *      `page.waitForTimeout(250)`, comfortably past both the tile's 160 ms and
 *      the card's 180 ms, so it is the transition's settled END state, not a
 *      frame of it. R14 itself says "wait for `transitionend` where a final
 *      value is needed"; this file uses a fixed wait instead, on purpose: a
 *      transition that never starts (the "nothing changed" assertions —
 *      re-click, only-one-tile) never fires `transitionend`, so a test waiting
 *      for it would hang on exactly the case it exists to check. The cost is
 *      that a future duration above 250 ms would silently turn every read
 *      into a mid-value again — which is why the durations are named here.
 *
 * No `page.clock` is installed in this file (unlike `banner.spec.ts`) —
 * nothing under test here is time-based in the sense the carousel is; the
 * 250 ms waits below are real wall-clock waits for a CSS transition to
 * finish, which a faked clock does not accelerate (CSS transitions run on the
 * compositor, not on `setTimeout`).
 *
 * The exact colours and shadows below come from `storefront.css`'s "MOTION"
 * header and its `.service-tile` / `.product-card` blocks, confirmed live
 * while driving the page for Slice 4's first two tasks: tiles rest at
 * `rgba(0, 0, 0, 0)` / `box-shadow: none` and hover to `rgb(242, 242, 244)`
 * (--sf-ground) with a non-`none` shadow; cards rest at `transform: none` and
 * hover to `transform: matrix(1, 0, 0, 1, 0, -4)` (the 4-px `translateY`) with
 * `box-shadow: rgba(0, 0, 0, 0.18) 0px 16px 40px 0px` (--sf-shadow-lift).
 */
import type { Page } from "@playwright/test";

import { expect, test } from "./support/orders.js";

/** How long past a transition's own duration to wait before reading its end state (R14). */
const SETTLE_MS = 250;

const TILE_REST_BACKGROUND = "rgba(0, 0, 0, 0)";
const TILE_HOVER_BACKGROUND = "rgb(242, 242, 244)"; // --sf-ground
const CARD_LIFT_TRANSFORM = "matrix(1, 0, 0, 1, 0, -4)"; // translateY(-4px)
const CARD_LIFT_SHADOW = "rgba(0, 0, 0, 0.18) 0px 16px 40px 0px"; // --sf-shadow-lift

/** Waits past the product row's initial «Загрузка каталога…» into its settled state. */
async function waitForRowToSettle(page: Page): Promise<void> {
  await page.waitForSelector(".popular__list, .popular__status--error");
}

interface TileStyle {
  readonly background: string;
  readonly boxShadow: string;
}

async function tileStyle(page: Page, index: number): Promise<TileStyle> {
  return page.locator(".service-tile").nth(index).evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, boxShadow: style.boxShadow };
  });
}

interface CardStyle {
  readonly transform: string;
  readonly boxShadow: string;
}

async function cardStyle(page: Page, index: number): Promise<CardStyle> {
  return page.locator(".product-card").nth(index).evaluate((element) => {
    const style = getComputedStyle(element);
    return { transform: style.transform, boxShadow: style.boxShadow };
  });
}

/**
 * Presses Tab from a known, off-strip starting point until `document
 * .activeElement` is a `.service-tile`, capped so a regression that removes
 * every tile from the tab order fails loudly instead of looping forever.
 * Used instead of `locator.focus()` because `:focus-visible` — the rule the
 * stylesheet shares with `:hover` — is a real keyboard-navigation heuristic in
 * Chromium, not merely "has focus"; a genuine `Tab` keypress is what crit 4
 * ("reaches a tile with the keyboard") actually asks for.
 */
async function tabToServiceTile(page: Page): Promise<number> {
  await page.locator(".header__catalog").focus();

  for (let presses = 0; presses < 20; presses += 1) {
    await page.keyboard.press("Tab");
    const index = await page.evaluate(() => {
      const tiles = Array.from(document.querySelectorAll(".service-tile"));
      return tiles.findIndex((tile) => tile === document.activeElement);
    });
    if (index !== -1) return index;
  }

  throw new Error("Tab never reached a .service-tile within 20 presses from .header__catalog");
}

test.describe("hover — service tiles and product cards respond to the pointer and keyboard (functional spec §2.5, §2.6)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    // Tiles render synchronously (Slice 1), but the product-card tests below
    // need the row settled, so every test in this file gets one consistent
    // starting point.
    await waitForRowToSettle(page);
  });

  test("crit 1 (static) — the tile and card transitions have a positive duration, the evidence they fade rather than switch instantly", async ({
    page,
  }) => {
    const tileDuration = await page
      .locator(".service-tile")
      .first()
      .evaluate((element) => getComputedStyle(element).transitionDuration);
    const cardDuration = await page
      .locator(".product-card")
      .first()
      .evaluate((element) => getComputedStyle(element).transitionDuration);

    expect(parseFloat(tileDuration), `.service-tile transition-duration was "${tileDuration}"`).toBeGreaterThan(0);
    expect(parseFloat(cardDuration), `.product-card transition-duration was "${cardDuration}"`).toBeGreaterThan(0);
  });

  test("crit 2 — hovering the Steam tile changes its background and gives it a shadow, fading in over 160ms", async ({
    page,
  }) => {
    const rest = await tileStyle(page, 0);
    expect(rest.background, "at rest the tile is transparent").toBe(TILE_REST_BACKGROUND);
    expect(rest.boxShadow, "at rest the tile has no shadow").toBe("none");

    await page.locator(".service-tile").nth(0).hover();
    await page.waitForTimeout(SETTLE_MS);

    const hovered = await tileStyle(page, 0);
    expect(hovered.background, "hovered — --sf-ground background").toBe(TILE_HOVER_BACKGROUND);
    expect(hovered.boxShadow, "hovered — a non-none shadow appears").not.toBe("none");
  });

  test("crit 3 — moving along the strip from Steam to Telegram leaves exactly one tile highlighted, and it is the one under the pointer", async ({
    page,
  }) => {
    await page.locator(".service-tile").nth(0).hover(); // Steam
    await page.waitForTimeout(SETTLE_MS);

    await page.locator(".service-tile").nth(1).hover(); // Telegram
    await page.waitForTimeout(SETTLE_MS);

    const tileCount = await page.locator(".service-tile").count();
    expect(tileCount, "eleven tiles in the strip, «еще 841» included").toBe(11);

    const states = await Promise.all(Array.from({ length: tileCount }, (_unused, index) => tileStyle(page, index)));
    const highlightedIndices = states
      .map((state, index) => ({ state, index }))
      .filter(({ state }) => state.background === TILE_HOVER_BACKGROUND && state.boxShadow !== "none")
      .map(({ index }) => index);

    expect(highlightedIndices, "exactly one tile carries the hover background and shadow").toHaveLength(1);
    expect(highlightedIndices[0], "the highlighted tile is Telegram (index 1), not Steam (index 0)").toBe(1);
  });

  test('crit 1/2 — «еще 841» (the eleventh tile) highlights the same way, and settles back on leave', async ({ page }) => {
    await expect(page.locator(".service-tile").nth(10).locator(".service-tile__caption")).toHaveText("еще 841");

    const restBefore = await tileStyle(page, 10);
    expect(restBefore.background, "«еще 841» starts at rest like every other tile").toBe(TILE_REST_BACKGROUND);

    await page.locator(".service-tile").nth(10).hover();
    await page.waitForTimeout(SETTLE_MS);

    const hovered = await tileStyle(page, 10);
    expect(hovered.background, "«еще 841» highlights exactly like the other ten tiles").toBe(TILE_HOVER_BACKGROUND);
    expect(hovered.boxShadow, "«еще 841» gets the same non-none shadow").not.toBe("none");

    await page.mouse.move(0, 0); // off every tile
    await page.waitForTimeout(SETTLE_MS);

    const after = await tileStyle(page, 10);
    expect(after.background, "settles back to rest once the pointer leaves").toBe(TILE_REST_BACKGROUND);
    expect(after.boxShadow, "shadow is gone once the pointer leaves").toBe("none");
  });

  test("crit 4 — reaching a tile with the keyboard (Tab) shows the same highlight the pointer shows on hover", async ({
    page,
  }) => {
    const focusedIndex = await tabToServiceTile(page);
    await page.waitForTimeout(SETTLE_MS);

    const focused = await tileStyle(page, focusedIndex);
    expect(focused.background, "keyboard focus draws the same background as hover (:hover, :focus-visible share one rule)").toBe(
      TILE_HOVER_BACKGROUND,
    );
    expect(focused.boxShadow, "keyboard focus draws the same shadow as hover").not.toBe("none");
  });

  test("§2.6 crit 2/3 — hovering a product card lifts it (a translateY matrix and a deeper shadow), and leaving settles it back", async ({
    page,
  }) => {
    const rest = await cardStyle(page, 0);
    expect(rest.transform, "at rest the card has no transform").toBe("none");
    expect(rest.boxShadow, "at rest the card has no shadow").toBe("none");

    await page.locator(".product-card").first().hover();
    await page.waitForTimeout(SETTLE_MS);

    const hovered = await cardStyle(page, 0);
    expect(hovered.transform, "hovering lifts the card 4px via a translateY matrix").toBe(CARD_LIFT_TRANSFORM);
    expect(hovered.boxShadow, "the hovered card carries the deeper --sf-shadow-lift").toBe(CARD_LIFT_SHADOW);

    await page.mouse.move(0, 0);
    await page.waitForTimeout(SETTLE_MS);

    const after = await cardStyle(page, 0);
    expect(after.transform, "leaving settles the card's transform back to none").toBe("none");
    expect(after.boxShadow, "leaving settles the card's shadow back to none").toBe("none");
  });

  test("§2.6 crit 2 (keyboard) — focusing the first «Купить» lifts its own card via :focus-within", async ({ page }) => {
    const buyButton = page.locator(".product-card__buy").first();
    const card = page.locator(".product-card:has(.product-card__buy)").first();

    const restTransform = await card.evaluate((element) => getComputedStyle(element).transform);
    expect(restTransform, "at rest, before focusing «Купить»").toBe("none");

    await buyButton.focus();
    await expect(buyButton).toBeFocused();
    await page.waitForTimeout(SETTLE_MS);

    const liftedTransform = await card.evaluate((element) => getComputedStyle(element).transform);
    expect(liftedTransform, "focusing «Купить» lifts its own card, exactly as hovering the card does").toBe(
      CARD_LIFT_TRANSFORM,
    );
  });

  test('reduced motion (R11) — under prefers-reduced-motion a hovered card keeps its shadow but drops the transform; tiles still tint', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });

    const card = page.locator(".product-card").first();
    await card.hover();
    await page.waitForTimeout(SETTLE_MS);

    const hovered = await cardStyle(page, 0);
    expect(hovered.transform, "reduced motion drops only the transform half of the lift (R11)").toBe("none");
    expect(hovered.boxShadow, "the shadow still deepens — a colour/shadow fade is not motion").toBe(CARD_LIFT_SHADOW);

    // The reduced-motion media query in storefront.css touches only
    // `.product-card`; the tile's tint is a background-color/box-shadow fade
    // and is untouched by it.
    await page.locator(".service-tile").first().hover();
    await page.waitForTimeout(SETTLE_MS);

    const tileHovered = await tileStyle(page, 0);
    expect(tileHovered.background, "tiles still tint under reduced motion").toBe(TILE_HOVER_BACKGROUND);
    expect(tileHovered.boxShadow, "tiles still get a shadow under reduced motion").not.toBe("none");
  });
});
