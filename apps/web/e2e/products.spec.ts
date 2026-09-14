// @layer: e2e
// @spec: 004-storefront-per-the-design
// @regression
/**
 * functional-spec.md §2.6, all five criteria: the «Популярные товары» row
 * shows exactly five cards drawn from the real catalogue, Купить sits on
 * exactly the three purchasable ones, every card's picture either loads or
 * degrades to the neutral panel, a display-only card does nothing when
 * clicked, and a catalogue that cannot be loaded leaves every other block on
 * the page present and working while the row alone shows the shop's existing
 * Russian message.
 *
 * technical-considerations.md §4.2's row for this file:
 *   | `e2e/products.spec.ts` | §2.6 all five | Five cards; the three
 *   purchasable SKUs from `GET /api/products` each have `button[data-sku]`,
 *   the other two none; every `<img>` has `naturalWidth > 0` or the card
 *   carries `--empty`; clicking a display-only card leaves the URL;
 *   `page.route("**\/api/products", 503)` → the exact existing sentence in
 *   the row while the banner still advances under the clock and Каталог
 *   still opens |
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIRST TEST COMPUTES ITS EXPECTATION FROM THE LIVE CATALOGUE, NOT A
 * HARD-CODED SKU LIST
 * ---------------------------------------------------------------------------
 * `model/select-popular-products.ts` is a pure function checked against fixed
 * fixtures in `select-popular-products.test.ts`; this file's job is the
 * opposite half — proving the *real* `GET /api/products` response, read the
 * same way the storefront reads it, ends up as five cards in that order in a
 * real browser. So the expectation is built from `page.request.get` reading
 * the same endpoint the page will call, partitioned by `purchasable` the same
 * way the selection rule is documented to work
 * (technical-considerations §2.2's partition, not the rejected "following"
 * reading) — a hard-coded `["KEY-CS2-PRIME", ...]` list would silently stop
 * proving anything the day the seed changes, and would not be "the browser
 * tests assert the seed's count against the real endpoint" the model file's
 * own header promises. The one number pinned outright is "exactly three
 * purchasable", because that is a fact about the seed today, and §2.6 crit 1
 * asks for it by name ("Купить on exactly three of them").
 *
 * ---------------------------------------------------------------------------
 * CRIT 5 IS THE ONE TEST IN THIS FILE WITH A FAKED CLOCK, AND WHY
 * ---------------------------------------------------------------------------
 * Every other test below never touches banner timing, so it never installs
 * `page.clock` (a bare hover/click test gains nothing from faking time and
 * only adds ceremony to explain away). The 503 test does need to prove "the
 * banner still advances under the clock" while the row is failing, so it
 * installs and pauses the clock **before** `goto`, exactly as
 * `banner.spec.ts`'s `beforeEach` does and for the same measured reason (a
 * bare `install()` lets real page-load time leak into the countdown — see
 * that file's header for the reproduction). `buy-through.spec.ts` is the
 * opposite case — real clock only, everywhere, never faked — and its own
 * header explains why the two files cannot share a policy.
 *
 * ---------------------------------------------------------------------------
 * THE ERROR SENTENCE IS COPIED, NOT IMPORTED, FROM `config/text.ts`
 * ---------------------------------------------------------------------------
 * Every e2e spec in this project treats the running app as a black box —
 * `hover.spec.ts` hardcodes its exact hover colours "confirmed live" rather
 * than reading `storefront.css`, and no spec under `e2e/` imports anything
 * from `src/`. The crit 5 test below keeps that line: the sentence is quoted
 * verbatim from `pages/storefront/config/text.ts`'s `text.popular.error`,
 * with its source named in the test itself, rather than reached into `src/`
 * for — the one new cross-boundary import that would have introduced.
 */
import type { Page } from "@playwright/test";

import { expect, test } from "./support/orders.js";

/** Waits past the product row's initial «Загрузка каталога…» into its settled state. */
async function waitForRowToSettle(page: Page): Promise<void> {
  await page.waitForSelector(".popular__list, .popular__status--error");
}

/**
 * The 1-based position of the one `.banner__slide` that does not carry
 * `hidden`, mirroring `banner.spec.ts`'s own helper — duplicated rather than
 * shared, as every spec in this project keeps its own small DOM readers (see
 * e.g. every file's own copy of {@link waitForRowToSettle}).
 */
async function visibleSlide(page: Page): Promise<number> {
  const index = await page.evaluate(() => {
    const slides = Array.from(document.querySelectorAll<HTMLElement>(".banner__slide"));
    return slides.findIndex((slide) => !slide.hidden);
  });

  if (index === -1) throw new Error("no .banner__slide is visible — every one carries `hidden`");
  return index + 1;
}

/** The fields this file reads off `GET /api/products` — nothing else about a row matters here. */
interface CatalogueRow {
  readonly sku: string;
  readonly purchasable: boolean;
}

/** Reads the live catalogue through Playwright's own request context, the same origin the page will call. */
async function fetchCatalogueRows(page: Page): Promise<readonly CatalogueRow[]> {
  const response = await page.request.get("/api/products");
  expect(response.ok(), `GET /api/products should answer 2xx, got ${String(response.status())}`).toBe(true);

  return (await response.json()) as readonly CatalogueRow[];
}

test.describe("products — real goods on real cards (functional spec §2.6)", () => {
  test("crit 1 — five cards, Купить on exactly the three purchasable SKUs from GET /api/products, in the selection's own order", async ({
    page,
  }) => {
    const rows = await fetchCatalogueRows(page);
    const purchasableSkus = rows.filter((row) => row.purchasable).map((row) => row.sku);
    const displayOnlySkus = rows.filter((row) => !row.purchasable).map((row) => row.sku);
    const expectedCardSkus = [...purchasableSkus, ...displayOnlySkus].slice(0, 5);

    expect(purchasableSkus.length, "the seed's own fact: exactly three purchasable products").toBe(3);

    await page.goto("/");
    await waitForRowToSettle(page);

    const cardSkus = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".product-card")).map((card) => card.getAttribute("data-sku")),
    );
    expect(
      cardSkus,
      "exactly five cards, purchasable first then display-only, catalogue order kept within each half",
    ).toEqual(expectedCardSkus);

    const buySkus = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button[data-sku]")).map((button) => button.getAttribute("data-sku")),
    );
    expect(new Set(buySkus), "Купить sits on exactly the three purchasable SKUs — none on the other two").toEqual(
      new Set(purchasableSkus),
    );
    expect(buySkus.length, "one Купить per purchasable card — no duplicate, none missing").toBe(purchasableSkus.length);

    // Slice 7 addition: §2.6 crit 1 also asks for "a picture, a name and a
    // price in roubles" — the assertions above only ever pinned the SKU set
    // and the button placement, never the card's own text. `formatPrice`
    // (`shared/lib/format-price.ts`) prints every price with a trailing `₽`
    // by construction (`Currency` is a closed enum with `Rub` its only member,
    // so this is close to a type-level guarantee already), but nothing under
    // `e2e/` had ever read a `.product-card__price` node and checked it —
    // `buy-through.spec.ts` and `acceptance.spec.ts` only ever compare the
    // text to itself (card vs. order page), never to the currency the
    // criterion names.
    const cardText = await page.evaluate(() =>
      Array.from(document.querySelectorAll(".product-card")).map((card) => ({
        sku: card.getAttribute("data-sku"),
        name: card.querySelector(".product-card__name")?.textContent?.trim() ?? "",
        price: card.querySelector(".product-card__price")?.textContent?.trim() ?? "",
      })),
    );
    for (const card of cardText) {
      expect(card.name, `card ${String(card.sku)} has a non-empty name`).not.toBe("");
      expect(card.price, `card ${String(card.sku)}'s price ("${card.price}") is in roubles`).toMatch(/₽$/u);
    }
  });

  test("crit 1 — every card's picture loads (naturalWidth > 0), or the card carries --empty (R5), with no 4xx/5xx along the way", async ({
    page,
  }) => {
    const failures: string[] = [];
    page.on("response", (response) => {
      if (response.status() >= 400) failures.push(`${String(response.status())} ${response.url()}`);
    });

    await page.goto("/");
    await waitForRowToSettle(page);

    const cardCount = await page.locator(".product-card").count();
    expect(cardCount, "five cards in the row").toBe(5);

    for (let index = 0; index < cardCount; index += 1) {
      const card = page.locator(".product-card").nth(index);
      // `loading="lazy"` (product-card.ts) — only a card the browser has
      // decided to load will ever fire `load`/`error`, so bring it into view
      // before waiting on either.
      await card.scrollIntoViewIfNeeded();

      const media = card.locator(".product-card__media");
      const imageBeforeSettle = card.locator(".product-card__image");

      if ((await imageBeforeSettle.count()) === 0) {
        // `image: null` on the wire — the neutral panel from the start, no
        // request ever made (product-card.ts's `renderMedia`).
        await expect(
          media,
          `card ${String(index)} has no <img> and should carry --empty from the start`,
        ).toHaveClass(/product-card__media--empty/u);
        continue;
      }

      // Wait for the <img> to settle — loaded, or errored into the same
      // --empty fallback — before reading naturalWidth (R14's "never read a
      // value mid-transition", applied here to "mid-request").
      await imageBeforeSettle.evaluate(
        (img: HTMLImageElement) =>
          img.complete
            ? undefined
            : new Promise<void>((resolve) => {
                img.addEventListener("load", () => resolve(), { once: true });
                img.addEventListener("error", () => resolve(), { once: true });
              }),
      );

      const imageAfterSettle = card.locator(".product-card__image");
      if ((await imageAfterSettle.count()) === 0) {
        // The `error` listener removed the <img> and added --empty
        // (product-card.ts's `renderMedia`) — the file failed to load.
        await expect(
          media,
          `card ${String(index)}'s image failed to load and fell back to --empty (R5)`,
        ).toHaveClass(/product-card__media--empty/u);
        continue;
      }

      const naturalWidth = await imageAfterSettle.evaluate((img: HTMLImageElement) => img.naturalWidth);
      expect(naturalWidth, `card ${String(index)}'s image decoded — naturalWidth > 0`).toBeGreaterThan(0);
    }

    expect(failures, `request(s) answered 4xx/5xx while the row's pictures loaded: ${failures.join(" | ")}`).toEqual(
      [],
    );

    // Slice 7 gap: the loop above treats `--empty` as a legitimate pass for
    // *two* different reasons — `image: null` on the wire, or a real `<img>`
    // that failed to load — and cannot tell them apart from the outside,
    // which is exactly the blind spot. Vite's dev server answers a *missing*
    // file under `public/` (a deleted card-art PNG, say) with its SPA
    // fallback: `200 text/html`, not `404` — so `failures` above, which only
    // ever watches for `status >= 400`, would stay empty even for a request
    // that quietly never got a PNG back, and the `<img>` would fire `error`
    // (an HTML document is not a decodable image) and fall into the same
    // `--empty` branch a legitimately null `image` field takes. Today's seed
    // (`packages/db/src/fixtures/catalog.ts`) gives every one of the twelve
    // products a real `image` path — `image` is nullable in the schema, but
    // nothing in the seed exercises that null — so on this data the correct
    // count of `--empty` cards is zero, and asserting that directly closes
    // the gap the loop above cannot: if a card-art file were deleted, this
    // assertion is the one that would actually go red.
    const emptyMediaCount = await page.locator(".product-card__media--empty").count();
    expect(
      emptyMediaCount,
      "the seed gives every product a real image, so no card should carry --empty today — a non-zero count here on this seed means a picture failed to load (e.g. a deleted asset the Vite dev server masked as a 200)",
    ).toBe(0);
  });

  test("crit 2 (smoke) — hovering the first card lifts it; hover.spec.ts proves the full transition and the settle-back", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForRowToSettle(page);

    const card = page.locator(".product-card").first();
    const restTransform = await card.evaluate((element) => getComputedStyle(element).transform);
    expect(restTransform, "at rest the card has no transform").toBe("none");

    await card.hover();
    // Past the 180ms lift transition (R14) — hover.spec.ts's SETTLE_MS.
    await page.waitForTimeout(250);

    const hoveredTransform = await card.evaluate((element) => getComputedStyle(element).transform);
    expect(hoveredTransform, "hovering lifts the card off its resting transform").not.toBe("none");
  });

  test("crit 4 — clicking a display-only card's picture or name does nothing (R6)", async ({ page }) => {
    await page.goto("/");
    await waitForRowToSettle(page);

    const displayOnlyCards = page.locator(".product-card:not(:has(button[data-sku]))");
    expect(
      await displayOnlyCards.count(),
      "at least one of the five cards carries no Купить (display-only)",
    ).toBeGreaterThan(0);
    const displayOnlyCard = displayOnlyCards.first();

    const urlBefore = page.url();
    const documentRequests: string[] = [];
    const orderRequests: string[] = [];

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

    await displayOnlyCard.locator(".product-card__media").click();
    await displayOnlyCard.locator(".product-card__name").click();

    // There is no signal to wait *for* — the control is meant to do nothing —
    // so a bounded settle window is the only way to give a stray effect a
    // chance to show up before it is asserted absent (inert-controls.spec.ts's
    // `assertInert` uses the same shape for the same reason).
    await page.waitForTimeout(500);

    expect(page.url(), `the URL changed from ${urlBefore}`).toBe(urlBefore);
    expect(documentRequests, `a document (navigation) request was issued: ${documentRequests.join(", ")}`).toEqual(
      [],
    );
    expect(orderRequests, `a POST /api/orders request was issued: ${orderRequests.join(", ")}`).toEqual([]);
  });

  test("crit 5 — GET /api/products failing (503): the row alone shows the exact error sentence; everything else keeps working", async ({
    page,
  }) => {
    // Installed and paused BEFORE `goto`, exactly as `banner.spec.ts`'s
    // `beforeEach` — see that file's header for why a bare `install()` lets
    // real page-load time leak into the countdown, and why `pauseAt` must
    // target a point strictly after the clock's live position. This is the
    // only test in this file that touches the clock.
    const FIXED_START_MS = Date.parse("2024-01-01T00:00:00.000Z");
    const PAUSE_MARGIN_MS = 100;
    await page.clock.install({ time: FIXED_START_MS });
    await page.clock.pauseAt(FIXED_START_MS + PAUSE_MARGIN_MS);

    await page.route("**/api/products", (route) =>
      route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
    );

    await page.goto("/");
    await page.waitForSelector(".popular__status--error");

    await expect(page.locator(".header"), "the header stays present while the catalogue fails").toBeVisible();
    await expect(page.locator(".banner"), "the banner stays present while the catalogue fails").toBeVisible();
    await expect(
      page.locator(".services"),
      "the service strip stays present while the catalogue fails",
    ).toBeVisible();
    await expect(
      page.locator(".steam-topup"),
      "the Steam top-up block stays present while the catalogue fails",
    ).toBeVisible();

    // Copied verbatim from `pages/storefront/config/text.ts`'s
    // `text.popular.error` — see this file's header for why it is copied
    // rather than imported.
    const errorSentence = "Не удалось загрузить каталог. Проверьте соединение и обновите страницу.";
    await expect(
      page.locator(".popular__status--error"),
      "the row shows the shop's existing Russian message, verbatim",
    ).toHaveText(errorSentence);

    expect(
      await page.locator(".product-card").count(),
      "no card renders while the catalogue could not be loaded",
    ).toBe(0);

    // The banner still advances under the clock, unaffected by the row's failure.
    expect(await visibleSlide(page), "starts on slide 1").toBe(1);
    await page.clock.runFor(5000);
    expect(await visibleSlide(page), "the banner still advances every 5s while the row shows its error").toBe(2);

    // Каталог still opens.
    await page.locator(".header__catalog").click();
    const overlayHidden = await page
      .locator("#catalog-menu")
      .evaluate((element) => (element as HTMLElement).hidden);
    expect(overlayHidden, "Каталог still opens while the catalogue failed").toBe(false);
  });
});
