// @layer: e2e
// @spec: 005-promo-codes-with-enforced-limits
// @regression
/**
 * The shopper's half of promo codes on the order page — functional spec 005
 * §2.2 (the field, the applied row, the reload path), §2.4 (the two refusal
 * messages) and §2.7 (Russian throughout) — proved in a real browser against
 * the real API, the way `buy-through.spec.ts` proves a purchase.
 *
 * technical-considerations.md §4's row for this file names six tests, T1–T6;
 * Slice 6's coverage pass added T7 (functional spec §2.2's sixth criterion —
 * no promo field once an order has settled, code or no code), and this file
 * has exactly one `test()` per letter, for the reason
 * `hover.spec.ts` and `inert-controls.spec.ts` give every criterion its own
 * `test()`: a shared one that fails only says "something in promo broke",
 * never which criterion did.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE CARRIES `@regression` — PER `support/orders.ts`'S CONVENTION,
 * NOT REPEATED HERE
 * ---------------------------------------------------------------------------
 * `./support/orders.ts`'s header states the rule once for the whole `e2e/`
 * directory: the permanent, one-criterion-at-a-time regression guards carry
 * `@regression` (every sibling spec except `acceptance.spec.ts`, which is the
 * feature-level walk), and the acceptance-level composite does not. Each
 * `test()` below is exactly one of technical-considerations §4's six named
 * criteria, written before the behaviour existed and RED-validated on its
 * own — the same shape as every other file this rule already covers — so
 * this file is one more of them, not the exception, and the convention is not
 * re-argued here.
 *
 * ---------------------------------------------------------------------------
 * REAL CLOCK THROUGHOUT (R15's reasoning, restated for this file)
 * ---------------------------------------------------------------------------
 * As in `buy-through.spec.ts`: the order page's poll
 * (`pages/order/model/poll.ts`) is a real `setTimeout` chained off a real
 * `GET /api/orders/:id`, and every assertion below that waits for a repaint —
 * the promo row appearing after a submit, «Ключ выдан» after a payment — is
 * waiting on that real loop against a real, self-looped `apps/api` instance
 * (`playwright.config.ts`). No `page.clock` appears anywhere in this file.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY TEST GOES THROUGH THE STOREFRONT RATHER THAN `POST /api/orders`
 * DIRECTLY
 * ---------------------------------------------------------------------------
 * `./support/orders.ts`'s `trackCreatedOrders` fixture (`auto: true`) only
 * ever learns an order id by intercepting the page's own
 * `POST /api/orders` — the same mechanism `buy-through.spec.ts` relies on,
 * and for the same reason (that file's header: a raw `page.on("response")`
 * loses a real race against `location.assign`). A test that minted an order
 * through `fetch` or `curl` instead would leave that id uncleaned, and the
 * very first thing this project's cleanup harness would have broken is its
 * own promo counters (R13, below). So every test here starts with the same
 * `buyThroughToOrderPage` — click the first purchasable card, wait for
 * `/order/ord_…` — that `buy-through.spec.ts` and `acceptance.spec.ts` use,
 * duplicated locally rather than imported, as this project's convention is
 * for every spec to keep its own small DOM readers.
 *
 * ---------------------------------------------------------------------------
 * BUDGET — WHY NO TEST HERE CAN SEE ANOTHER'S USES (tasks.md Slice 4 task 3)
 * ---------------------------------------------------------------------------
 * `LIMIT3` may be applied 3 times in total, `ONCEONLY` once, across every
 * shopper and every order the seeded database has ever seen
 * (`packages/db/src/fixtures/promo-codes.ts`). Three tests below apply
 * `LIMIT3` — T1, T4, T5 — and one, T6, applies `ONCEONLY` twice on purpose
 * (once to succeed, once to be refused). That looks like it should exhaust
 * both codes by the middle of the file, and it would, except for two things
 * that hold together:
 *
 *   1. **`workers: 1`** (`playwright.config.ts`) serialises every test in
 *      this whole project, not just this file — no two tests, in any spec,
 *      are ever mid-flight at once.
 *   2. **`trackCreatedOrders`'s teardown runs after every single test**
 *      (`./support/orders.ts`), and `cleanupOrders` (`./support/db.ts`)
 *      deletes that test's own `promo_redemptions` rows and decrements each
 *      code's `used_count` by exactly the number it removed — the same CTE
 *      `apps/api/test/concurrency/support/db.ts` uses, duplicated per R13.
 *
 * So by the time T4 runs, T1's `LIMIT3` use has already been handed back;
 * by the time T5 runs, T4's has. Each test sees the code at `used_count = 0`
 * (`LIMIT3`) or `used_count = 0`/`1` (`ONCEONLY`, within T6's own two
 * applications) exactly as if it were the only test in the file — never a
 * count left over from a sibling. This is also why `used_count` is never
 * read or asserted directly in this file: this layer proves the *shopper's*
 * path (a code applies, a spent code is refused), not the counter's
 * arithmetic under load — that is `promo-limit-race.test.ts`'s job
 * (Slice 3), on a budget of its own twenty and ten redemptions that this
 * file's three-plus-two never touches.
 *
 * ---------------------------------------------------------------------------
 * R10 — WHY T1 SETS A `window` MARKER BEFORE SUBMITTING
 * ---------------------------------------------------------------------------
 * `promo-form.ts`'s `submit` handler cancels the browser's default the moment
 * it fires; if that one line were ever lost, the browser would instead `GET`
 * the form back to `/order/ord_x?code=…` — a real navigation that *looks* like
 * nothing happened, because the same order page loads again with the code
 * now applied (the shop already recorded the redemption; only the client's
 * reload is the bug). `page.url()` alone is too easy to get half-right: a
 * check that only asserts "no trailing `?`" would pass if the reload landed
 * on a URL some router silently normalised. A `window` global set
 * immediately before the submit survives nothing but the same document —
 * any navigation, silent or not, throws it away — so asserting it is still
 * there after the row appears is the proof that no reload happened, not an
 * inference from the address bar.
 *
 * ---------------------------------------------------------------------------
 * RED VALIDATION — RUN, RECORDED, REVERTED (tasks.md Slice 4 task 3)
 * ---------------------------------------------------------------------------
 * GREEN was confirmed first (`6 passed (10.5s)`), then each edit below was
 * applied one at a time against a `cp`-taken copy of the file in the
 * scratchpad, run, its failing line quoted, and restored — checked
 * byte-identical against that copy with `cmp` (not `git diff --stat`: the
 * working tree already carries uncommitted Slice 4 changes to these files,
 * so only a pre-edit copy proves nothing was left behind). GREEN was
 * reconfirmed (`6 passed (8.9s)`) once every edit was reverted.
 *
 *   - **T1** (named RED, tasks.md): dropped `promoCode` from `RenderedOrder`
 *     in `apps/web/src/pages/order/ui/order-page.ts` and from the object
 *     literal and comparison `showOrder` builds — the silent failure the
 *     header there already names: the `POST` succeeds, the refresh reads
 *     the promo back, the memo sees `created === created` and returns
 *     early, and the row never paints. RED, quoted verbatim:
 *     `Expected: "LIMIT3 — скидка 322,50 ₽"` / `Error: element(s) not found`
 *     (`toHaveText` on `promoRowSelector`, 10000ms timeout).
 *   - **T2**: mapped `PromoCodeUnknownError` to `text.exhausted` instead of
 *     `text.unknown` in `promo-form.ts`'s `messageFor`. RED, quoted
 *     verbatim: `Expected: "Такого промокода нет"` /
 *     `Received: "Промокод больше не действует"`.
 *   - **T3**: removed the `if (code === "") return;` guard in `send()`. RED,
 *     quoted verbatim: `expected zero POST …/promo requests, saw 2: …` /
 *     `- Array []` / `+ Array [ "http://localhost:5101/api/orders/ord_…/
 *     promo", "http://localhost:5101/api/orders/ord_…/promo" ]`.
 *   - **T4**: the table names no inversion for this row, and the first one
 *     tried — the same status-gate as T5's, below — **passed** T4 instead of
 *     failing it: T4's order never leaves `created`, so gating the row on
 *     `status === "created"` changes nothing for a reload that never repaints
 *     a status transition. That is itself a finding, not a shortcoming of the
 *     test — recorded rather than quietly swapped for a weaker check. The
 *     inversion that does isolate T4's own claim (state survives a *cold*
 *     read, not a poll-driven repaint) was applied instead, temporarily, in
 *     `order-page.ts`'s `showOrder`: capture `isFirstPaintRedTemp = rendered
 *     === null` before the memo updates it, and render
 *     `{ ...order, promo: null }` through `renderOrderDetails` whenever that
 *     is true. This suppresses the promo row on a page's very *first* paint
 *     only — exactly the state `page.reload()` leaves a promo-carrying order
 *     in — while every other paint in a page's session (T1's post-submit
 *     repaint, T5's post-payment repaint, each order's first, promo-less
 *     paint in T1/T5/T6) takes the untouched branch. Confirmed isolated: only
 *     T4 failed, T1/T2/T3/T5/T6 stayed green in the same run. RED, quoted
 *     verbatim: `Expected: "LIMIT3 — скидка 322,50 ₽"` /
 *     `Error: element(s) not found` (`toHaveText` on `promoRowSelector`,
 *     5000ms timeout, immediately after `await page.reload();`).
 *   - **T5**: gated `renderPromoRow` in
 *     `apps/web/src/entities/order/ui/order-details.ts` on
 *     `order.status !== OrderStatus.Created` in addition to `order.promo` —
 *     the table's "gate the row on `status === 'created'`". RED, quoted
 *     verbatim: `Expected: "LIMIT3 — скидка 322,50 ₽"` /
 *     `Error: element(s) not found` (`toHaveText` on `promoRowSelector`,
 *     5000ms timeout, after the status reached `delivered`) — and in the
 *     same run, T4 stayed green, which is what first surfaced the T4 finding
 *     above.
 *   - **T6**: mapped `PromoCodeExhaustedError` to `text.unknown` instead of
 *     `text.exhausted` — the T2 edit's mirror. RED, quoted verbatim:
 *     `Expected: "Промокод больше не действует"` /
 *     `Received: "Такого промокода нет"`.
 *   - **T7** (added by Slice 6, RED by inversion rather than by a `src/`
 *     edit): `.toHaveCount(0)` inverted to `.toHaveCount(1)` — RED, quoted
 *     verbatim: `Expected: 1` / `Received: 0`; restored, `7 passed`.
 *
 * Every edit was reverted immediately after its RED was recorded; `cmp`
 * against the pre-edit scratchpad copy of each of the three files
 * (`order-page.ts`, `order-details.ts`, `promo-form.ts`) reported no
 * differences before GREEN was re-run.
 */
import type { Page } from "@playwright/test";

import { expect, test } from "./support/orders.js";

/** Waits past the product row's initial «Загрузка каталога…» into its settled state — `buy-through.spec.ts`'s own helper, duplicated per this project's convention. */
async function waitForRowToSettle(page: Page): Promise<void> {
  await page.waitForSelector(".popular__list, .popular__status--error");
}

/** From a fresh storefront load to a fresh `created` order's page — see the header on why every test starts here rather than at `POST /api/orders` directly. */
async function buyThroughToOrderPage(page: Page): Promise<void> {
  await page.goto("/");
  await waitForRowToSettle(page);
  await page.locator("button[data-sku]").first().click();
  await page.waitForURL(/\/order\/ord_/u);
}

const promoFormSelector = "[data-promo-form]";
const promoInputSelector = `${promoFormSelector} input[name="code"]`;
const promoButtonSelector = `${promoFormSelector} button[type="submit"]`;
const promoErrorSelector = `${promoFormSelector} .promo-form__error`;
const promoRowSelector = ".order-details__value--promo";
const amountValueSelector = ".order-details__value--amount";
const listAmountSelector = ".order-details__list-amount";
const statusValueSelector = ".order-details__value--status";
/** `PaymentOutcome.Success` — `buy-through.spec.ts`'s own constant, duplicated per this project's convention. */
const successControlSelector = '.payment-controls__button[data-outcome="success"]';
/** `features/simulate-payment/ui/payment-controls.ts`'s `rootClass` — the sibling the promo form must precede (T1). */
const paymentControlsSelector = ".payment-controls";

/** Real-time budget for the promo row to appear after a submit — the same order of magnitude `buy-through.spec.ts` gives key delivery, generous for a single write plus one poll tick. */
const PROMO_APPLIED_TIMEOUT_MS = 10_000;

/** Real-time budget for the key to arrive after the success control is pressed — `buy-through.spec.ts`'s `KEY_DELIVERY_TIMEOUT_MS`, duplicated per this project's convention. */
const KEY_DELIVERY_TIMEOUT_MS = 15_000;

/**
 * True once a freshly loaded `created` order has painted both the promo
 * field and the payment controls — the state `order-page.ts`'s first read
 * leaves a fresh order in (`createPaymentControls.render` and
 * `createPromoForm.render` both answer for `status === "created"`). Waiting
 * on this rather than on a fixed timeout is what makes every later action in
 * this file act on a page the poll has actually finished its first paint of.
 */
async function orderContentReady(page: Page): Promise<void> {
  await expect(page.locator(promoFormSelector)).toBeVisible();
  await expect(page.locator(paymentControlsSelector)).toBeVisible();
}

/**
 * The promo form's position among `.order__content`'s direct children,
 * relative to the payment controls — T1's DOM-order criterion, read through
 * `evaluate` because Playwright has no built-in "element A precedes element
 * B" matcher.
 */
async function formPrecedesPaymentControls(page: Page): Promise<boolean> {
  return page.evaluate(
    ({ formSelector, paymentSelector }) => {
      const content = document.querySelector(".order__content");
      if (content === null) return false;

      const children = Array.from(content.children);
      const formIndex = children.findIndex((el) => el.matches(formSelector));
      const paymentIndex = children.findIndex((el) => el.matches(paymentSelector));

      return formIndex !== -1 && paymentIndex !== -1 && formIndex < paymentIndex;
    },
    { formSelector: promoFormSelector, paymentSelector: paymentControlsSelector },
  );
}

/** Fills the field and submits it either by Enter (implicit submission) or by clicking «Применить» — both reach the same `submit` handler. */
async function applyPromoCode(page: Page, code: string, method: "enter" | "click"): Promise<void> {
  await page.locator(promoInputSelector).fill(code);

  if (method === "enter") {
    await page.locator(promoInputSelector).press("Enter");
  } else {
    await page.locator(promoButtonSelector).click();
  }
}

test.describe("promo — the order page's field (functional spec 005 §2.2, §2.4, §2.7)", () => {
  test("T1 — Enter applies LIMIT3: the form precedes the payment controls, the discount row and the new amount appear, the form is gone, and the URL and a pre-submit marker both survive (R10)", async ({
    page,
  }) => {
    await buyThroughToOrderPage(page);
    await orderContentReady(page);

    await expect(
      formPrecedesPaymentControls(page),
      "the promo form must be mounted before the payment controls in the content region's DOM order — functional spec §2.2's first criterion",
    ).resolves.toBe(true);

    const urlBeforeSubmit = page.url();
    const marker = `t1-${Date.now().toString()}`;
    await page.evaluate((value: string) => {
      (window as unknown as Record<string, unknown>)["__promoMarker"] = value;
    }, marker);

    // Lower case, spaces around it — functional spec §2.1's case/space
    // criterion, folded into the same submit as R10's marker check rather
    // than a seventh test, since both assert on the same one application.
    await applyPromoCode(page, " limit3 ", "enter");

    await expect(page.locator(promoRowSelector)).toHaveText("LIMIT3 — скидка 322,50 ₽", {
      timeout: PROMO_APPLIED_TIMEOUT_MS,
    });
    await expect(page.locator(promoRowSelector)).toHaveAttribute("data-promo-code", "LIMIT3");
    await expect(page.locator(promoRowSelector)).toHaveAttribute("data-discount-minor", "32250");

    await expect(page.locator(amountValueSelector)).toHaveAttribute("data-amount-minor", "96750");
    await expect(page.locator(amountValueSelector)).toContainText("967,50 ₽");
    await expect(page.locator(listAmountSelector)).toHaveText("(было 1290 ₽)");
    await expect(page.locator(listAmountSelector)).toHaveAttribute("data-list-amount-minor", "129000");

    await expect(
      page.locator(promoFormSelector),
      "the field is gone once a code is applied — the entity's «Промокод» row stands in its place",
    ).toHaveCount(0);

    expect(
      page.url(),
      "no navigation happened — a lost preventDefault() would have reloaded /order/ord_x?code=… (R10)",
    ).toBe(urlBeforeSubmit);

    const markerAfter = await page.evaluate(
      () => (window as unknown as Record<string, unknown>)["__promoMarker"],
    );
    expect(
      markerAfter,
      "a real navigation would have thrown every window global away, this marker included (R10)",
    ).toBe(marker);
  });

  test("T2 — an unknown code is refused with «Такого промокода нет»; the amount and the field's value are unchanged", async ({
    page,
  }) => {
    await buyThroughToOrderPage(page);
    await orderContentReady(page);

    await applyPromoCode(page, "nope", "click");

    await expect(page.locator(promoErrorSelector)).toHaveText("Такого промокода нет");
    await expect(page.locator(amountValueSelector)).toHaveAttribute("data-amount-minor", "129000");
    await expect(page.locator(promoInputSelector)).toHaveValue("nope");
    await expect(
      page.locator(promoFormSelector),
      "the field stays editable after a refusal — the shopper can correct one letter rather than retype",
    ).toBeVisible();
    await expect(page.locator(promoRowSelector)).toHaveCount(0);
  });

  test("T3 — an empty or whitespace-only submit sends zero POST …/promo requests, and the form is unchanged", async ({
    page,
  }) => {
    await buyThroughToOrderPage(page);
    await orderContentReady(page);

    // Armed before either attempt, as `inert-controls.spec.ts`'s
    // `assertInert` arms its listeners before `act()` — nothing either
    // attempt below triggers can be missed.
    const promoRequests: string[] = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      try {
        if (/^\/api\/orders\/[^/]+\/promo$/u.test(new URL(request.url()).pathname)) {
          promoRequests.push(request.url());
        }
      } catch {
        // Not a parseable absolute URL — cannot be the promo endpoint.
      }
    });

    // Empty field, submitted by Enter (implicit submission).
    await page.locator(promoInputSelector).press("Enter");

    // Whitespace-only, submitted by the button — functional spec §2.2's
    // fifth criterion trims before deciding "empty".
    await page.locator(promoInputSelector).fill("   ");
    await page.locator(promoButtonSelector).click();

    // No signal to wait *for* here — both attempts are meant to do nothing —
    // so a bounded settle window, as `inert-controls.spec.ts` uses.
    await page.waitForTimeout(500);

    expect(
      promoRequests,
      `expected zero POST …/promo requests, saw ${String(promoRequests.length)}: ${promoRequests.join(", ")}`,
    ).toEqual([]);

    await expect(page.locator(promoFormSelector)).toBeVisible();
    await expect(page.locator(promoErrorSelector)).toHaveCount(0);
    await expect(page.locator(promoRowSelector)).toHaveCount(0);
    await expect(page.locator(amountValueSelector)).toHaveAttribute("data-amount-minor", "129000");
  });

  test("T4 — a reload after applying LIMIT3 shows the same row and the same amounts, and no form", async ({
    page,
  }) => {
    await buyThroughToOrderPage(page);
    await orderContentReady(page);

    await applyPromoCode(page, "LIMIT3", "enter");
    await expect(page.locator(promoRowSelector)).toHaveText("LIMIT3 — скидка 322,50 ₽", {
      timeout: PROMO_APPLIED_TIMEOUT_MS,
    });

    await page.reload();

    await expect(page.locator(promoRowSelector)).toHaveText("LIMIT3 — скидка 322,50 ₽");
    await expect(page.locator(promoRowSelector)).toHaveAttribute("data-promo-code", "LIMIT3");
    await expect(page.locator(promoRowSelector)).toHaveAttribute("data-discount-minor", "32250");
    await expect(page.locator(amountValueSelector)).toHaveAttribute("data-amount-minor", "96750");
    await expect(page.locator(listAmountSelector)).toHaveAttribute("data-list-amount-minor", "129000");
    await expect(
      page.locator(promoFormSelector),
      "one code per order, kept — the field never comes back once a code is on",
    ).toHaveCount(0);
  });

  test("T5 — paying an order carrying LIMIT3 delivers the key with the promo row and the discounted amount still shown", async ({
    page,
  }) => {
    await buyThroughToOrderPage(page);
    await orderContentReady(page);

    await applyPromoCode(page, "LIMIT3", "enter");
    await expect(page.locator(promoRowSelector)).toHaveText("LIMIT3 — скидка 322,50 ₽", {
      timeout: PROMO_APPLIED_TIMEOUT_MS,
    });

    await page.locator(successControlSelector).click();

    // The order page's own poll does everything from here, exactly as
    // `buy-through.spec.ts`'s first test relies on.
    await expect(page.locator(statusValueSelector)).toHaveAttribute("data-status", "delivered", {
      timeout: KEY_DELIVERY_TIMEOUT_MS,
    });
    await expect(page.locator(statusValueSelector)).toHaveText("Ключ выдан");

    await expect(
      page.locator(promoRowSelector),
      "functional spec §2.3's last criterion — the record of what was paid does not change after the fact",
    ).toHaveText("LIMIT3 — скидка 322,50 ₽");
    await expect(page.locator(amountValueSelector)).toHaveAttribute("data-amount-minor", "96750");
    await expect(page.locator(amountValueSelector)).toContainText("967,50 ₽");

    const code = await page.locator("[data-order-code]").getAttribute("data-order-code");
    expect(code, "a non-empty key was handed over").not.toBeNull();
    expect(code, "a non-empty key was handed over").not.toBe("");
  });

  test("T6 — ONCEONLY applies to one order and is refused with «Промокод больше не действует» on a second", async ({
    page,
  }) => {
    await buyThroughToOrderPage(page);
    await orderContentReady(page);

    await applyPromoCode(page, "ONCEONLY", "enter");
    await expect(page.locator(promoRowSelector)).toHaveText("ONCEONLY — скидка 645 ₽", {
      timeout: PROMO_APPLIED_TIMEOUT_MS,
    });
    await expect(page.locator(promoRowSelector)).toHaveAttribute("data-discount-minor", "64500");
    await expect(page.locator(amountValueSelector)).toHaveAttribute("data-amount-minor", "64500");

    // A second, unrelated order — a different shopper trying the same
    // exhausted code, exactly as functional spec §2.4's second criterion
    // describes.
    await buyThroughToOrderPage(page);
    await orderContentReady(page);

    await applyPromoCode(page, "ONCEONLY", "click");

    await expect(page.locator(promoErrorSelector)).toHaveText("Промокод больше не действует");
    await expect(page.locator(amountValueSelector)).toHaveAttribute("data-amount-minor", "129000");
    await expect(
      page.locator(promoRowSelector),
      "the second order carries no code — the refusal changed nothing about it",
    ).toHaveCount(0);
  });

  // ===========================================================================
  // Added by Slice 6 (feature-level coverage pass): functional spec §2.2's
  // sixth criterion — "Given an order has been paid, or has failed, or is
  // being delivered, when the shopper opens its page, then there is no
  // promo-code field." T1-T6 above each apply a code before an order settles,
  // so the field's absence after that point is *entailed* by §2.2's third
  // criterion (the field is replaced by the applied-code row and never comes
  // back) rather than exercised on its own — none of them proves the field
  // stays gone for an order that reaches `paid`/`delivering`/`delivered`
  // having never had a code applied to it at all, which is the case
  // `createPromoForm`'s own render rule (`status === "created" && order.promo
  // === null`) has a whole clause for on its own. T7 is that case.
  test("T7 — an order that reaches `delivered` with no code ever applied shows no promo field, on the settling paint and on a cold reload", async ({
    page,
  }) => {
    await buyThroughToOrderPage(page);
    await orderContentReady(page);

    // No code is applied here — paid straight away.
    await page.locator(successControlSelector).click();

    await expect(page.locator(statusValueSelector)).toHaveAttribute("data-status", "delivered", {
      timeout: KEY_DELIVERY_TIMEOUT_MS,
    });

    // CAN FAIL: inverted to `.toHaveCount(1)` and re-run — see this file's
    // RED VALIDATION header for the quoted failure.
    await expect(
      page.locator(promoFormSelector),
      "functional spec §2.2's sixth criterion — a delivered order shows no promo field, code applied or not",
    ).toHaveCount(0);
    await expect(page.locator(promoRowSelector), "no code was ever applied, so no applied-code row either").toHaveCount(0);

    // A cold reload of the same delivered order — proof the render rule
    // itself gates on status, not merely on "this tab already painted once
    // without a form and never re-added it".
    await page.reload();
    await expect(page.locator(promoFormSelector), "still absent after a fresh load of the same order").toHaveCount(0);
  });
});
