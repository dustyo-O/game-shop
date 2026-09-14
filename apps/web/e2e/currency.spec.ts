// @layer: e2e
// @spec: 004-storefront-per-the-design
// @regression
/**
 * functional-spec.md §2.4, all four criteria: «$» is active on load, clicking
 * another option makes it active and the previous one inactive, re-clicking
 * the active option changes nothing, and the sum shown beside the control
 * never changes.
 *
 * technical-considerations.md §4.2's row for this file:
 *   | `e2e/currency.spec.ts` | §2.4 all four | `:checked` on the radios; the
 *   «Сумма» text identical throughout |
 *
 * ---------------------------------------------------------------------------
 * NO SCRIPT, NO FAKE CLOCK — THE RADIO GROUP IS THE WHOLE CONTRACT
 * ---------------------------------------------------------------------------
 * `ui/steam-topup.ts`'s `renderCurrencyOption` comment is the source of truth
 * this file drives against: three `<input type="radio" name="currency">`
 * (`#currency-usd`, `#currency-kzt`, `#currency-rub` — `config/text.ts`'s
 * `currencies`) with `<label for>` as the 36-px square the shopper actually
 * clicks. There is no `change` handler anywhere on this page (the page's
 * `CLAUDE.md`: "No script touches the currency group"), so every assertion
 * below reads the browser's own `:checked` state and the stylesheet's
 * `:checked + .currency__option` paint — never a class this file would have
 * to imagine a handler toggling. No `page.clock` is installed: nothing under
 * test here is time-based.
 *
 * The exact colours below (`rgb(17, 17, 19)` for the checked label, the
 * --sf-ink token; `rgb(242, 242, 244)` for the other two, --sf-ground) come
 * from `storefront.css`'s "The currency control: native radios, no script"
 * block and were confirmed live while driving the page for Slice 4's first
 * two tasks.
 */
import type { Page } from "@playwright/test";

import { expect, test } from "./support/orders.js";

const CURRENCY_IDS = ["currency-usd", "currency-kzt", "currency-rub"] as const;
type CurrencyId = (typeof CURRENCY_IDS)[number];

interface CurrencyState {
  readonly checkedId: CurrencyId;
  readonly backgrounds: Readonly<Record<CurrencyId, string>>;
}

/**
 * Reads which radio is checked and every label's painted background in one
 * round trip, so a failure names which fact disagreed rather than leaving the
 * others assumed — the same shape `catalog-menu.spec.ts`'s `menuState` uses.
 * Throws if zero or more than one radio is checked: the native group makes
 * that impossible by construction, so a throw here means the markup itself
 * has drifted, not that this test's assertion was too strict.
 */
async function currencyState(page: Page): Promise<CurrencyState> {
  return page.evaluate((ids: readonly CurrencyId[]) => {
    const checked = ids.filter((id) => {
      const input = document.getElementById(id);
      if (input === null) throw new Error(`#${id} was not found`);
      return (input as HTMLInputElement).checked;
    });

    if (checked.length !== 1) {
      throw new Error(`expected exactly one checked currency radio, found ${String(checked.length)}: ${checked.join(", ")}`);
    }

    const backgrounds = {} as Record<CurrencyId, string>;
    for (const id of ids) {
      const label = document.querySelector(`label[for="${id}"]`);
      if (label === null) throw new Error(`label[for="${id}"] was not found`);
      backgrounds[id] = getComputedStyle(label).backgroundColor;
    }

    return { checkedId: checked[0] as CurrencyId, backgrounds };
  }, CURRENCY_IDS);
}

/** The «Сумма» value text — static per functional spec §2.4's last criterion. */
async function sumText(page: Page): Promise<string> {
  return page.locator(".steam-topup__sum-value").innerText();
}

/**
 * How long to wait after a click before reading a label's background: the
 * `.currency__option` rule fades `background-color, color` over 120ms
 * (`storefront.css`'s MOTION header), so a colour read immediately after a
 * click can land mid-fade — caught live while writing this file (crit 3
 * below first failed with `rgb(137, 137, 139)` / `rgb(122, 122, 124)`,
 * interpolated values between --sf-ground and --sf-ink, not the settled
 * colour either end names). Reading `:checked` itself needs no such wait —
 * that state is discrete, never interpolated — only a *painted colour* read
 * does (the same R14 principle `hover.spec.ts` applies to tile and card
 * transitions, here for the currency control's own 120ms fade).
 */
const CURRENCY_SETTLE_MS = 200;

test.describe("currency control — changes its active state (functional spec §2.4)", () => {
  test.beforeEach(async ({ page }) => {
    // The Steam block renders synchronously from Slice 1's static markup, the
    // same as the catalog menu — nothing here depends on `GET /api/products`.
    await page.goto("/");
  });

  test("crit 1 — on load «$» is the only checked option, and its label's background differs from the other two", async ({
    page,
  }) => {
    const state = await currencyState(page);

    expect(state.checkedId, "«$» is checked on load, as the mockup draws it").toBe("currency-usd");
    expect(state.backgrounds["currency-usd"], "the checked «$» label is painted --sf-ink").toBe("rgb(17, 17, 19)");
    expect(state.backgrounds["currency-kzt"], "the unchecked «₸» label is painted --sf-ground").toBe("rgb(242, 242, 244)");
    expect(state.backgrounds["currency-rub"], "the unchecked «₽» label is painted --sf-ground").toBe("rgb(242, 242, 244)");
    expect(
      state.backgrounds["currency-usd"],
      "the checked label's background differs from an unchecked one",
    ).not.toBe(state.backgrounds["currency-kzt"]);
  });

  test("crit 2 — clicking «₸» makes it active and unchecks «$»; clicking «₽» next makes it active and unchecks «₸»", async ({
    page,
  }) => {
    await page.locator('label[for="currency-kzt"]').click();
    await page.waitForTimeout(CURRENCY_SETTLE_MS);

    const afterKzt = await currencyState(page);
    expect(afterKzt.checkedId, "«₸» is checked after clicking its label").toBe("currency-kzt");
    expect(afterKzt.backgrounds["currency-kzt"], "«₸» label now painted --sf-ink").toBe("rgb(17, 17, 19)");
    expect(afterKzt.backgrounds["currency-usd"], "«$» label back to --sf-ground — it is no longer active").toBe(
      "rgb(242, 242, 244)",
    );

    await page.locator('label[for="currency-rub"]').click();
    await page.waitForTimeout(CURRENCY_SETTLE_MS);

    const afterRub = await currencyState(page);
    expect(afterRub.checkedId, "«₽» is checked after clicking its label").toBe("currency-rub");
    expect(afterRub.backgrounds["currency-rub"], "«₽» label now painted --sf-ink").toBe("rgb(17, 17, 19)");
    expect(afterRub.backgrounds["currency-kzt"], "«₸» label back to --sf-ground — it is no longer active").toBe(
      "rgb(242, 242, 244)",
    );
  });

  test("crit 3 — clicking the option that is already active leaves the full state unchanged", async ({ page }) => {
    await page.locator('label[for="currency-rub"]').click();
    await page.waitForTimeout(CURRENCY_SETTLE_MS);
    const before = await currencyState(page);
    expect(before.checkedId, "«₽» is the active option going in").toBe("currency-rub");

    await page.locator('label[for="currency-rub"]').click();
    await page.waitForTimeout(CURRENCY_SETTLE_MS);

    const after = await currencyState(page);
    expect(after.checkedId, "still «₽» checked after re-clicking the already-active option").toBe(before.checkedId);
    expect(after.backgrounds, "all three labels' backgrounds are unchanged").toEqual(before.backgrounds);
  });

  test("crit 4 — the «Сумма» text is identical before and after every click, including a re-click", async ({ page }) => {
    const initial = await sumText(page);
    expect(initial, 'the sum reads "500 ₽" per config/text.ts, unaffected by the active currency').toBe("500 ₽");

    await page.locator('label[for="currency-kzt"]').click();
    expect(await sumText(page), "sum unchanged after clicking «₸»").toBe(initial);

    await page.locator('label[for="currency-rub"]').click();
    expect(await sumText(page), "sum unchanged after clicking «₽»").toBe(initial);

    await page.locator('label[for="currency-rub"]').click(); // re-click the already-active option
    expect(await sumText(page), "sum unchanged after re-clicking the active option").toBe(initial);

    await page.locator('label[for="currency-usd"]').click();
    expect(await sumText(page), "sum unchanged after clicking back to «$»").toBe(initial);
  });

  test("keyboard — ArrowRight moves the check through the group, and Tab re-enters on the checked radio with a visible ring", async ({
    page,
  }) => {
    // `.focus()` rather than `.click()`: a click also checks the radio it
    // lands on, which would make the very first assertion below untestable —
    // `catalog-menu.spec.ts` uses the same `.focus()` convention for the same
    // reason (reaching a state without the click's own side effect).
    await page.locator("#currency-usd").focus();
    await expect(page.locator("#currency-usd")).toBeFocused();
    expect((await currencyState(page)).checkedId, "«$» starts both focused and checked").toBe("currency-usd");

    await page.keyboard.press("ArrowRight");
    expect((await currencyState(page)).checkedId, "ArrowRight moves the check to «₸»").toBe("currency-kzt");
    await expect(page.locator("#currency-kzt"), "ArrowRight also moves focus to «₸»").toBeFocused();

    await page.keyboard.press("ArrowRight");
    expect((await currencyState(page)).checkedId, "ArrowRight again moves the check to «₽»").toBe("currency-rub");
    await expect(page.locator("#currency-rub")).toBeFocused();

    await page.keyboard.press("Tab"); // leaves the group, onto «Оплатить»
    await expect(page.locator(".steam-topup__pay"), "Tab leaves the group onto the next control").toBeFocused();

    await page.keyboard.press("Shift+Tab"); // the browser re-enters a radio group on the CHECKED radio
    await expect(
      page.locator("#currency-rub"),
      "Shift+Tab re-enters the group on the checked radio («₽»), not the first one",
    ).toBeFocused();

    const outlineStyle = await page
      .locator('label[for="currency-rub"]')
      .evaluate((element) => getComputedStyle(element).outlineStyle);
    expect(outlineStyle, "the keyboard-focused label draws a non-none outline (:focus-visible + .currency__option)").not.toBe(
      "none",
    );
  });
});
