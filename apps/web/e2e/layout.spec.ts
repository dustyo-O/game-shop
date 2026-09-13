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
});
