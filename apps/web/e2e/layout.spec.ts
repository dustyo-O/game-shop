// @layer: e2e
// @spec: 004-storefront-per-the-design
// @regression
/**
 * functional-spec.md §2.1 (**as amended** — see the spec's Change Log: the
 * layout is fluid, not fixed-width) and §2.10; tech spec §4.2's table, with
 * the layout rows following the amendment. Also covers risks R5/R10's asset
 * sweep: nothing on the landing page answers 4xx/5xx.
 */
import type { Page } from "@playwright/test";

import { expect, test } from "./support/orders.js";

/**
 * Brand names the storefront prints with no Cyrillic anywhere in the same
 * text node — §2.1's own list. Every one of the seeded catalogue's product
 * names (`packages/db/src/fixtures/catalog.ts`) pairs an English brand word
 * with Russian text in the same node ("CS2 Prime Status ключ"), so those pass
 * the "contains Cyrillic" half of the check on their own and never need an
 * allowlist entry; only the service strip's bare captions (Steam, Telegram,
 * ...) do.
 */
const BRAND_ALLOWLIST = [
  "Steam",
  "Telegram",
  "Roblox",
  "Brawl Stars",
  "PUBG Mobile",
  "App Store",
  "ChatGPT",
  "PlayStation",
  "TikTok",
  "Mobile Legends",
  "Xbox",
  "Nintendo",
  "Battle.net",
  "PS Plus",
  "EA Play",
  "Xbox Game Pass",
  "NS Online",
  "World of Warcraft",
  "Steam Deck",
  "Bundle",
  "Discord",
  "YouTube",
  "Spotify",
  "PSN",
  "Robux",
  "CS2",
  "GTA",
  "Tarkov",
  "Nitro",
  "Premium",
  "Gift Card",
] as const;

/** Waits past the product row's initial «Загрузка каталога…» into its settled state. */
async function waitForRowToSettle(page: Page): Promise<void> {
  await page.waitForSelector(".popular__list, .popular__status--error");
}

test.describe("layout — the mockup's structure at / (functional spec §2.1, amended)", () => {
  test("the five sections appear in the mockup's order, and the row is the content's last child", async ({
    page,
  }) => {
    await page.goto("/");

    const found = await page.evaluate(() => {
      const top = (selector: string): number | null => {
        const element = document.querySelector(selector);
        return element === null ? null : element.getBoundingClientRect().top;
      };

      const content = document.querySelector(".storefront__content");

      return {
        header: top(".header"),
        banner: top(".banner"),
        services: top(".services"),
        steamTopup: top(".steam-topup"),
        popular: top(".popular"),
        popularIsLastChild: content?.lastElementChild?.classList.contains("popular") ?? false,
      };
    });

    expect(found.header, "header section present").not.toBeNull();
    expect(found.banner, "banner section present").not.toBeNull();
    expect(found.services, "service strip present").not.toBeNull();
    expect(found.steamTopup, "Steam top-up block present").not.toBeNull();
    expect(found.popular, "popular row present").not.toBeNull();

    const tops = [found.header, found.banner, found.services, found.steamTopup, found.popular] as number[];
    const labels = ["header", "banner", "services", "steam-topup", "popular"];
    for (let i = 1; i < tops.length; i += 1) {
      expect(
        tops[i],
        `${labels[i]} should sit at or below ${labels[i - 1]} (top ${String(tops[i])} vs ${String(tops[i - 1])})`,
      ).toBeGreaterThanOrEqual(tops[i - 1]!);
    }

    expect(found.popularIsLastChild, "the popular row is the content's last child — nothing renders below it").toBe(
      true,
    );
  });

  test("there is no <a> and no <form> anywhere on the page", async ({ page }) => {
    await page.goto("/");

    const count = await page.evaluate(() => document.querySelectorAll("a, form").length);

    expect(count, "no navigation element belongs on a page that is inert by construction").toBe(0);
  });

  test("at 1280x800 the page never scrolls sideways and the column is centred", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");

    const measured = await page.evaluate(() => {
      const root = document.documentElement;
      const column = document.querySelector(".storefront__column");
      if (column === null) throw new Error("`.storefront__column` was not found");
      const rect = column.getBoundingClientRect();

      return {
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
        leftGap: rect.left,
        rightGap: root.clientWidth - rect.right,
      };
    });

    expect(measured.scrollWidth, "no horizontal scrollbar at >= 1280px (functional spec §2.1 crit 3)").toBeLessThanOrEqual(
      measured.clientWidth,
    );
    expect(
      Math.abs(measured.leftGap - measured.rightGap),
      `the column should be centred — left gap ${String(measured.leftGap)}px vs right gap ${String(measured.rightGap)}px`,
    ).toBeLessThanOrEqual(1);
  });

  test("at 1000x800 the page still never scrolls sideways, fills the window, and the tile row wraps", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto("/");

    // The five static blocks render synchronously (Slice 1's markup), so no
    // wait on the catalogue request is needed before measuring the frame.
    const measured = await page.evaluate(() => {
      const root = document.documentElement;
      const column = document.querySelector(".storefront__column");
      if (column === null) throw new Error("`.storefront__column` was not found");
      const tileTops = Array.from(document.querySelectorAll(".services__item")).map(
        (tile) => tile.getBoundingClientRect().top,
      );

      return {
        scrollWidth: root.scrollWidth,
        clientWidth: root.clientWidth,
        columnWidth: column.getBoundingClientRect().width,
        tileTops,
      };
    });

    expect(measured.scrollWidth, "no horizontal scrollbar below the 1280px cap (functional spec §2.1 crit 4)").toBeLessThanOrEqual(
      measured.clientWidth,
    );
    expect(
      measured.columnWidth,
      `the column should fill the narrow window (column ${String(measured.columnWidth)}px vs viewport ${String(measured.clientWidth)}px)`,
    ).toBeCloseTo(measured.clientWidth, 0);

    const distinctTops = new Set(measured.tileTops);
    expect(
      distinctTops.size,
      `the eleven-tile row should wrap onto more than one line below the cap — saw ${String(distinctTops.size)} distinct row(s)`,
    ).toBeGreaterThan(1);
  });

  test("every visible text node is Russian, has no letters, or is an allowed brand name (functional spec §2.10)", async ({
    page,
  }) => {
    await page.goto("/");
    await waitForRowToSettle(page);

    const offenders = await page.evaluate((allowlist: readonly string[]) => {
      const cyrillic = /[\u0400-\u04ff]/u;
      const letter = /\p{L}/u;

      // Longest names first, so a shorter brand name occurring inside a
      // longer allowed one is never stripped out from under it — no such
      // overlap exists in this allowlist today, but the walk stays correct
      // if one is added.
      const sortedAllowlist = [...allowlist].sort((a, b) => b.length - a.length);

      function stripsToNoLetters(value: string): boolean {
        let rest = value;
        for (const brand of sortedAllowlist) rest = rest.split(brand).join(" ");
        return !letter.test(rest);
      }

      function isVisible(element: Element): boolean {
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      const bad: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node !== null) {
        const text = (node.textContent ?? "").trim();
        const parent = node.parentElement;
        if (text !== "" && parent !== null && isVisible(parent)) {
          if (!cyrillic.test(text) && letter.test(text) && !stripsToNoLetters(text)) {
            bad.push(text);
          }
        }
        node = walker.nextNode();
      }
      return bad;
    }, BRAND_ALLOWLIST);

    expect(offenders, `non-Russian, non-allowlisted text found: ${offenders.join(" | ")}`).toEqual([]);
  });

  /**
   * Slice 7 (feature-level acceptance) gap: the sweep above only walks
   * *visible* text nodes, and on a freshly loaded page that is banner slide 1
   * and a closed catalog menu — `storefront.css`'s `.banner__slide[hidden]`
   * and `.catalog-menu[hidden]` both resolve to `display: none`, so slides
   * 2–4's headlines/text and every category and column item inside the
   * overlay never reach `document.createTreeWalker`'s visibility filter in
   * that test. Neither `banner.spec.ts` nor `catalog-menu.spec.ts` checks
   * language at all — they only drive structure and timing — so nothing in
   * the suite had ever read those strings for Cyrillic before this test.
   * `textContent` is readable on a `hidden` element regardless of paint, so
   * this reads it directly rather than opening the menu or clicking through
   * all four slides — the config files those strings come from
   * (`config/banner-slides.ts`, `config/catalog-menu.ts`) render unconditionally
   * into the DOM at mount, hidden or not.
   */
  test("banner slides 2–4 and the catalog menu's categories/columns are Russian too — hidden by default, so the sweep above never reveals them (functional spec §2.10)", async ({
    page,
  }) => {
    await page.goto("/");

    const offenders = await page.evaluate((allowlist: readonly string[]) => {
      const cyrillic = /[\u0400-\u04ff]/u;
      const letter = /\p{L}/u;
      const sortedAllowlist = [...allowlist].sort((a, b) => b.length - a.length);

      function stripsToNoLetters(value: string): boolean {
        let rest = value;
        for (const brand of sortedAllowlist) rest = rest.split(brand).join(" ");
        return !letter.test(rest);
      }

      const bad: string[] = [];
      // `.banner__slide` (all four, hidden or not) and `.catalog-menu` (the
      // whole overlay, hidden by default) — the two containers whose content
      // the main sweep's `isVisible` filter can never reach on a fresh load.
      const containers = document.querySelectorAll(".banner__slide, .catalog-menu");
      for (const container of Array.from(containers)) {
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node !== null) {
          const text = (node.textContent ?? "").trim();
          if (text !== "" && !cyrillic.test(text) && letter.test(text) && !stripsToNoLetters(text)) {
            bad.push(text);
          }
          node = walker.nextNode();
        }
      }
      return bad;
    }, BRAND_ALLOWLIST);

    expect(
      offenders,
      `non-Russian, non-allowlisted text found inside a hidden-by-default container: ${offenders.join(" | ")}`,
    ).toEqual([]);
  });

  test("no request answers 4xx/5xx while the page loads (R5/R10)", async ({ page }) => {
    const failures: string[] = [];
    page.on("response", (response) => {
      if (response.status() >= 400) failures.push(`${String(response.status())} ${response.url()}`);
    });

    await page.goto("/");
    await waitForRowToSettle(page);
    await page.waitForLoadState("networkidle");

    expect(failures, `request(s) answered 4xx/5xx: ${failures.join(" | ")}`).toEqual([]);
  });

  /**
   * Slice 7 gap: the status-only sweep above is blind to a missing asset on
   * this project's dev server. `apps/web`'s `vite --port 5101 --strictPort`
   * (this config's own `webServer` entry) answers a request for a *missing*
   * file under `public/` with its SPA fallback — `index.html`, `200
   * text/html` — rather than a `404`, because Vite cannot tell "this is a
   * route the client-side router will handle" from "this file genuinely does
   * not exist" for any path that is not an asset it recognises up front. So
   * a deleted service-tile SVG or a renamed card-art PNG would sail through
   * the check above with a `200` and be invisible to it. `content-type` is
   * the fact the fallback cannot fake: `index.html` is always `text/html`, a
   * real image response is always `image/*`, and nothing under `/assets/`,
   * `/icons/` or the favicon is ever meant to legitimately answer HTML.
   */
  test("every asset response is actually an image, not Vite's SPA-fallback HTML for a missing file (R5/R10)", async ({
    page,
  }) => {
    const offenders: string[] = [];
    // Matches product-card art (`/assets/<name>.png`), every service-tile
    // and UI glyph under `/icons/` at any depth (`icons/services/*.png`,
    // `icons/ui/*.svg`), and the favicon — 31 real responses on this seed,
    // the matched count logged once while writing this test and confirmed on
    // an isolated single-test run (`playwright test e2e/layout.spec.ts
    // --grep "every asset response"`, 1 worker): eleven service-tile
    // glyphs — the nine PNG brand tiles, `tiktok.svg` (the brand strip's
    // tenth tile), and the "more" glyph `more.svg` — plus sixteen of the
    // seventeen files under `icons/ui/` (`ls apps/web/public/icons/ui | wc
    // -l` → 17; `menu-chevron.svg` is on disk but never requested by this
    // page, so it is not one of the 31), plus the four distinct product-card
    // PNGs the five popular cards load (cs2, gta5, eft, steam — one image,
    // steam.png, is reused across the two Steam top-up cards, so five cards
    // produce four responses, not five). `favicon.svg` did not appear as its
    // own response in either the isolated run or the full suite — Chromium
    // answers the icon-link request from its own cache before this
    // listener ever sees a network round trip for it, so it is matched by
    // the pattern but contributes 0 of the 31 in practice. 11 + 16 + 4 = 31.
    const assetUrlPattern = /\/(assets\/[^/]+\.png|icons\/.+|favicon\.svg)(?:[?#]|$)/u;

    page.on("response", (response) => {
      if (!assetUrlPattern.test(new URL(response.url()).pathname)) return;
      const contentType = response.headers()["content-type"] ?? "";
      if (!contentType.startsWith("image/")) {
        offenders.push(`${response.url()} answered content-type "${contentType}" (status ${String(response.status())})`);
      }
    });

    await page.goto("/");
    await waitForRowToSettle(page);
    await page.waitForLoadState("networkidle");

    expect(
      offenders,
      `asset request(s) that did not answer an image content-type — a status-only check would have missed these: ${offenders.join(" | ")}`,
    ).toEqual([]);
  });
});
