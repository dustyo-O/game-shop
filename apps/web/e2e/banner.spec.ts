// @layer: e2e
// @spec: 004-storefront-per-the-design
// @regression
/**
 * functional-spec.md §2.2, all seven criteria: the banner advances on its own
 * every 5 seconds, wraps in both directions, obeys the arrows and dots, keeps
 * exactly one dot and one slide in agreement, restarts its count on a manual
 * move (crit 6), and pauses while the pointer rests on the panel (crit 7).
 *
 * ---------------------------------------------------------------------------
 * WHY THE CLOCK IS FAKED HERE, AND MUST NOT BE IN `buy-through.spec.ts`
 * ---------------------------------------------------------------------------
 * `page.clock.install()` replaces `Date`, `setTimeout` and friends with a
 * virtual clock that only moves when told to (`page.clock.runFor(ms)`) — so
 * the 5-second policy this file drives is tested in milliseconds of real wall
 * time, not five real seconds per assertion (tech spec §4.2, R15). Every test
 * below calls `runFor` explicitly; none ever waits on real time.
 *
 * `e2e/buy-through.spec.ts` does the opposite on purpose and must keep doing
 * so: it never leaves the storefront's origin, but it does wait on
 * `pages/order/model/poll.ts`, whose `setTimeout` loop would be frozen by the
 * same fake clock this file installs — a faked clock on that spec would mean
 * the delivery poll never fires and the test hangs waiting for a key that a
 * paused clock will never let arrive. The two specs are mutually exclusive by
 * what they wait for: this one waits for a timer, that one waits for a
 * network reply chained off real async work (R15, "the buy-through spec uses
 * real time ... the poll's timers and the faked clock do not mix").
 *
 * `pointerenter`/`pointerleave` under a faked clock still fire from a real
 * `page.hover()` / `page.mouse.move()` — the clock fakes `Date` and timer
 * scheduling only, never input. `ui/banner.ts` binds those two events (not
 * `focusin`), so every hover/mouse-move call below reaches the reducer
 * exactly as a real shopper's pointer would.
 *
 * ---------------------------------------------------------------------------
 * NO ORDER IS EVER CREATED HERE
 * ---------------------------------------------------------------------------
 * `./support/orders.ts`'s `trackCreatedOrders` fixture is `auto: true`, so
 * every test importing `test` from it gets order-cleanup teardown whether it
 * asks for it or not. This spec never presses «Купить» and never reaches
 * `POST /api/orders`, so that teardown always finds zero ids and is a no-op —
 * the same situation `layout.spec.ts` and `inert-controls.spec.ts` are in,
 * and the reason this file is not the one duplicating R13's cleanup story.
 */
import type { Page } from "@playwright/test";

import { expect, test } from "./support/orders.js";

/** Waits past the product row's initial «Загрузка каталога…» into its settled state. */
async function waitForRowToSettle(page: Page): Promise<void> {
  await page.waitForSelector(".popular__list, .popular__status--error");
}

/**
 * The 1-based position of the dot currently carrying `aria-current="true"`.
 * Throws if none does — a state the reducer's own tests already rule out, so
 * a throw here means the binding, not the model, has gone wrong.
 */
async function currentDot(page: Page): Promise<number> {
  const index = await page.evaluate(() => {
    const dots = Array.from(document.querySelectorAll(".banner__dot"));
    return dots.findIndex((dot) => dot.getAttribute("aria-current") === "true");
  });

  if (index === -1) throw new Error('no .banner__dot carries aria-current="true"');
  return index + 1;
}

/**
 * The 1-based position of the one `.banner__slide` that does not carry
 * `hidden`. Throws if none does, for the same reason as {@link currentDot}.
 */
async function visibleSlide(page: Page): Promise<number> {
  const index = await page.evaluate(() => {
    const slides = Array.from(document.querySelectorAll<HTMLElement>(".banner__slide"));
    return slides.findIndex((slide) => !slide.hidden);
  });

  if (index === -1) throw new Error("no .banner__slide is visible — every one carries `hidden`");
  return index + 1;
}

/**
 * Functional spec §2.2 crit 5: "exactly one dot is highlighted and it is the
 * dot for the slide currently shown". Checked as three separate facts so a
 * failure names which one broke: exactly one slide visible, exactly one dot
 * current, and the two name the same position.
 */
async function assertInvariant(page: Page): Promise<void> {
  const visibleSlideCount = await page.evaluate(
    () => Array.from(document.querySelectorAll<HTMLElement>(".banner__slide")).filter((slide) => !slide.hidden).length,
  );
  const currentDotCount = await page.evaluate(
    () => document.querySelectorAll('.banner__dot[aria-current="true"]').length,
  );

  expect(visibleSlideCount, "exactly one .banner__slide should lack `hidden`").toBe(1);
  expect(currentDotCount, 'exactly one .banner__dot should carry aria-current="true"').toBe(1);

  const slide = await visibleSlide(page);
  const dot = await currentDot(page);
  expect(dot, `the current dot (${String(dot)}) should name the visible slide (${String(slide)})`).toBe(slide);
}

test.describe("banner — advances on its own and by hand (functional spec §2.2)", () => {
  test.beforeEach(async ({ page }) => {
    // `install()` alone does not freeze time — Playwright's own docs on
    // `clock.pauseAt` say so explicitly: until a pause method is called, the
    // fake clock keeps pace with real time, precisely so a page's own
    // in-flight timers do not get stuck while it loads. Left unpaused, the
    // real milliseconds `goto` + the settle-wait actually spend (page
    // bootstrap, the `GET /api/products` round trip — anywhere from tens to
    // several hundred ms) sit *inside* the carousel's first 5-second window
    // before the first `runFor` call ever adds to it, so a boundary test at
    // "4999ms" can fail with slide 2 already showing — reproduced and quoted
    // in the task report, both with no pause at all and with a pause taken
    // only after the settle-wait.
    //
    // The fix is to pause *before* navigating, at a synthetic fixed epoch
    // this file controls, rather than at "whatever live time load happened to
    // reach": nothing here cares about the wall-clock date, only about
    // deltas the tests themselves drive with `runFor`, so an arbitrary fixed
    // start is exactly as valid as the real one and removes the page-load
    // real-time window entirely — the browser never sees an un-paused clock
    // after this point, so no navigation or fetch time is ever credited
    // toward the carousel's countdown.
    //
    // `pauseAt` still needs a target strictly after the clock's current live
    // position, which right after `install()` is `FIXED_START_MS` plus
    // whatever the `install()` round trip itself cost (a few ms locally) — a
    // second failure mode reproduced and quoted in the task report was
    // "Cannot fast-forward to the past" from pausing at a value already
    // behind that live position. `PAUSE_MARGIN_MS` absorbs that round trip
    // while staying far short of the 5000ms to the first auto-advance.
    const FIXED_START_MS = Date.parse("2024-01-01T00:00:00.000Z");
    const PAUSE_MARGIN_MS = 100;

    await page.clock.install({ time: FIXED_START_MS });
    await page.clock.pauseAt(FIXED_START_MS + PAUSE_MARGIN_MS);

    await page.goto("/");
    // The same settle-wait `layout.spec.ts` and `inert-controls.spec.ts` use:
    // the page is fully built (the row's request has resolved one way or
    // another) before any test starts driving time with `runFor`. The clock
    // is already paused by this point, so however long this actually takes
    // in real wall time, it costs the carousel's countdown nothing.
    await waitForRowToSettle(page);
  });

  test("crit 1 — advances to the next slide at 5000ms, not before", async ({ page }) => {
    await assertInvariant(page);
    expect(await visibleSlide(page), "starts on slide 1").toBe(1);

    await page.clock.runFor(4999);
    expect(await visibleSlide(page), "still slide 1 one millisecond short of the 5-second mark").toBe(1);
    await assertInvariant(page);

    await page.clock.runFor(1);
    expect(await visibleSlide(page), "slide 2 the instant the count reaches 5000ms").toBe(2);
    await assertInvariant(page);
  });

  test("crit 2 — advancing past the last slide wraps to the first, rather than stopping", async ({ page }) => {
    await page.clock.runFor(5000); // slide 1 -> 2
    expect(await visibleSlide(page)).toBe(2);

    await page.clock.runFor(5000); // slide 2 -> 3
    expect(await visibleSlide(page)).toBe(3);

    await page.clock.runFor(5000); // slide 3 -> 4, the last slide
    expect(await visibleSlide(page)).toBe(4);
    await assertInvariant(page);

    await page.clock.runFor(5000); // slide 4 -> wraps to 1
    expect(await visibleSlide(page), "the last slide advances to the first rather than stopping").toBe(1);
    await assertInvariant(page);
  });

  test("crit 3 — the arrows move the slide at once, with no clock movement", async ({ page }) => {
    expect(await visibleSlide(page)).toBe(1);

    await page.locator(".banner__arrow--next").click();
    expect(await visibleSlide(page), "the right arrow shows the next slide immediately").toBe(2);
    await assertInvariant(page);

    await page.locator(".banner__arrow--prev").click();
    expect(await visibleSlide(page), "the left arrow shows the previous slide immediately").toBe(1);
    await assertInvariant(page);
  });

  test("crit 4 — pressing the left arrow on the first slide wraps to the last", async ({ page }) => {
    expect(await visibleSlide(page)).toBe(1);

    await page.locator(".banner__arrow--prev").click();
    expect(await visibleSlide(page), "the first slide's left arrow wraps to the last slide (4)").toBe(4);
    await assertInvariant(page);
  });

  test("crit 5 — the current dot names the visible slide after an auto tick, an arrow, and a dot click", async ({
    page,
  }) => {
    await assertInvariant(page); // the initial paint

    await page.clock.runFor(5000); // an automatic tick
    await assertInvariant(page);

    await page.locator(".banner__arrow--next").click();
    await assertInvariant(page);

    await page.locator(".banner__arrow--prev").click();
    await assertInvariant(page);

    // Dot 3 is the third `.banner__dot`, index 2.
    await page.locator(".banner__dot").nth(2).click();
    expect(await visibleSlide(page), "clicking dot 3 lands on slide 3").toBe(3);
    expect(await currentDot(page), "clicking dot 3 marks dot 3 as current").toBe(3);
    await assertInvariant(page);
  });

  test("crit 6 — an arrow press restarts the 5-second count from that moment", async ({ page }) => {
    await page.clock.runFor(3000);
    expect(await visibleSlide(page), "no auto-advance yet at 3000ms").toBe(1);

    await page.locator(".banner__arrow--next").click();
    expect(await visibleSlide(page), "the arrow moves the slide at once").toBe(2);

    // The manual move restarts the count from this moment (crit 6), so only
    // 4000 of the fresh 5000ms window have passed here — not 7000 of it.
    await page.clock.runFor(4000);
    expect(
      await visibleSlide(page),
      "still slide 2 — the count restarted at the arrow press, and only 4000ms of the new 5-second window have passed",
    ).toBe(2);
    await assertInvariant(page);

    await page.clock.runFor(1000); // the restarted count's remaining 1000ms
    expect(await visibleSlide(page), "5000ms since the arrow press — the banner advances on its own").toBe(3);
    await assertInvariant(page);
  });

  test("crit 7 — the pointer resting on the panel pauses the count, and leaving it resumes", async ({ page }) => {
    await page.hover(".banner__panel");

    await page.clock.runFor(6000);
    expect(
      await visibleSlide(page),
      "hovering the panel past the 5-second boundary does not advance the banner",
    ).toBe(1);
    await assertInvariant(page);

    // Off the panel entirely, so `pointerleave` fires and the count restarts.
    await page.mouse.move(0, 0);
    await page.clock.runFor(5000);
    expect(await visibleSlide(page), "advances one slide, 5000ms after the pointer left the panel").toBe(2);
    await assertInvariant(page);
  });

  test("assumption 3 — the pause region is the panel only; hovering the next arrow does not pause", async ({
    page,
  }) => {
    // technical-considerations §2.2 / assumption 3: the arrows sit outside
    // the pause region on purpose, so a mouse press on an arrow is never seen
    // as "the pointer is resting on the banner" — otherwise crit 6 (the
    // restart-on-manual-move behaviour) would be unobservable by a mouse
    // user, since the pointer is on an arrow every time it presses one.
    await page.hover(".banner__arrow--next");

    await page.clock.runFor(6000);
    expect(
      await visibleSlide(page),
      "the next arrow sits outside .banner__panel, so hovering it does not cancel the auto-advance",
    ).toBe(2);
    await assertInvariant(page);
  });
});
