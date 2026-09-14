// @layer: unit
// @spec: 005-promo-codes-with-enforced-limits
// @regression
/**
 * The discount arithmetic and the code normalisation, exercised as what they
 * are: **pure functions of stored data**.
 *
 * No database, no Nest container, no clock. A definition and an amount in, two
 * numbers out. That is the whole reason `apps/api/src/promo/promo-discount.ts`
 * is a module of its own rather than four lines inside the redemption
 * transaction — the arithmetic is the one part of spec 005 that can be wrong
 * *deterministically*, and a deterministic rule can be checked by handing it
 * its inputs.
 *
 * ---------------------------------------------------------------------------
 * EXPECTED VALUES ARE TRANSCRIBED, NOT COMPUTED
 * ---------------------------------------------------------------------------
 * Every number on the right-hand side of an `expect` below is written out as a
 * literal taken from the functional spec (§2.1's four criteria on a 1 290 ₽
 * order) or from the technical spec (R8's non-exact case). None is produced by
 * doing the arithmetic in the test. That is the stance
 * `./issuance-ladder.test.ts` takes for its request ids and
 * `../concurrency/support/db.ts` states outright: *"a test that imported the
 * very code it is meant to catch a mistake in cannot catch that mistake."* A
 * test that wrote `Math.round((129_000 * 10) / 100)` would agree with the
 * module however the module rounded.
 *
 * The four seeded definitions are transcribed here for the same reason, rather
 * than imported from `packages/db`'s fixture: this file pins what the *brief*
 * says the codes do, and a fixture edited alongside the arithmetic would agree
 * with itself.
 *
 * ---------------------------------------------------------------------------
 * WHAT `discountMinor` MEANS
 * ---------------------------------------------------------------------------
 * The **applied** discount — clamped to the price — never the code's face
 * value. `promo_redemptions.discount_minor` stores this number, and the view
 * shows `list_amount_minor` beside it, so `list = amount_to_pay + discount`
 * has to hold on every row, including the one where a 500 ₽ code met a 300 ₽
 * order and the shopper pays nothing (technical-considerations §2.2, the
 * in-memory row of the transaction table). The clamp test below is that row.
 */
import { describe, expect, it } from "vitest";

import { Currency, minorUnits } from "@game-shop/contracts";

import { normalisePromoCode } from "../../src/promo/promo-code.js";
import { computeDiscount, PromoKind, type PromoDefinition } from "../../src/promo/promo-discount.js";

/**
 * The brief's four codes, as the brief states them. `GG500` is "500 ₽ off",
 * which in stored units is 50 000 kopecks — the one place the unit boundary
 * `packages/contracts/src/money.ts` warns about touches this file.
 */
const WELCOME10: PromoDefinition = { kind: "percent", value: 10 };
const GG500: PromoDefinition = { kind: "amount", value: minorUnits(50_000), currency: Currency.Rub };
const LIMIT3: PromoDefinition = { kind: "percent", value: 25 };
const ONCEONLY: PromoDefinition = { kind: "percent", value: 50 };

/** The order every §2.1 criterion is stated against: 1 290 ₽. */
const LIST_AMOUNT = minorUnits(129_000);

describe("promo discount — the two kinds a code can be", () => {
  // @regression
  it("names exactly the two kinds the schema's CHECK admits, as those strings", () => {
    // technical-considerations §2.1: `CHECK (kind IN ('percent','amount'))`.
    // The strings here are transcribed from that CHECK, not from the module —
    // a `promo_codes.kind` column and this union have to agree or the
    // redemption service cannot narrow a row into a definition.
    expect(Object.values(PromoKind)).toEqual(["percent", "amount"]);
  });
});

describe("promo discount — the four seeded codes on a 1 290 ₽ order (functional spec §2.1)", () => {
  // @regression
  it("WELCOME10 (10 %) → 1 161 ₽ to pay, 129 ₽ off", () => {
    expect(computeDiscount(LIST_AMOUNT, WELCOME10)).toEqual({
      discountMinor: 12_900,
      amountToPayMinor: 116_100,
    });
  });

  // @regression
  it("GG500 (500 ₽ off) → 790 ₽ to pay, 500 ₽ off", () => {
    expect(computeDiscount(LIST_AMOUNT, GG500)).toEqual({
      discountMinor: 50_000,
      amountToPayMinor: 79_000,
    });
  });

  // @regression
  it("LIMIT3 (25 %) → 967,50 ₽ to pay, 322,50 ₽ off — the one example with kopecks in it", () => {
    expect(computeDiscount(LIST_AMOUNT, LIMIT3)).toEqual({
      discountMinor: 32_250,
      amountToPayMinor: 96_750,
    });
  });

  // @regression
  it("ONCEONLY (50 %) → 645 ₽ to pay, 645 ₽ off", () => {
    expect(computeDiscount(LIST_AMOUNT, ONCEONLY)).toEqual({
      discountMinor: 64_500,
      amountToPayMinor: 64_500,
    });
  });
});

describe("promo discount — an amount code is clamped to the price", () => {
  // @regression
  it("GG500 on a 300 ₽ order → 0 ₽ to pay, and the APPLIED discount is 300 ₽, not 500 ₽", () => {
    // technical-considerations §2.2: "`discount_minor` stored is the *applied*
    // (clamped) discount so `list = amount + discount` holds even at 0 ₽". A
    // module that reported the face value here would write a ledger row
    // claiming 500 ₽ came off a 300 ₽ order — and the redemptions CHECK
    // `discount_minor <= list_amount_minor` would refuse it as a 500.
    expect(computeDiscount(minorUnits(30_000), GG500)).toEqual({
      discountMinor: 30_000,
      amountToPayMinor: 0,
    });
  });
});

describe("promo discount — percent rounds half up to the nearest kopeck (R8)", () => {
  // @regression
  it("25 % of 9 999 kopecks → 2 500 off — the non-exact case R8 asks the unit test to pin", () => {
    // 2 499,75 → 2 500. Nearest, not truncation: a shop that floored would
    // quote 2 499 here and short the shopper a kopeck on every odd amount.
    expect(computeDiscount(minorUnits(9_999), LIMIT3)).toEqual({
      discountMinor: 2_500,
      amountToPayMinor: 7_499,
    });
  });

  // @regression
  it("10 % of 5 kopecks → 1 off — an exact half rounds UP, not to even", () => {
    // 0,5 → 1. This is the case that separates "half up" from banker's
    // rounding (`0,5 → 0`) and from truncation (`0,5 → 0`); the other cases in
    // this file cannot tell the three apart.
    expect(computeDiscount(minorUnits(5), WELCOME10)).toEqual({
      discountMinor: 1,
      amountToPayMinor: 4,
    });
  });

  // @regression
  it("33 % of 100 kopecks → 33 off — an exact quotient is left alone", () => {
    const thirtyThreePercent: PromoDefinition = { kind: "percent", value: 33 };

    expect(computeDiscount(minorUnits(100), thirtyThreePercent)).toEqual({
      discountMinor: 33,
      amountToPayMinor: 67,
    });
  });
});

describe("promo code — normalisation: trim, then upper-case (functional spec §2.1's last criterion)", () => {
  // @regression
  it("` limit3 ` → `LIMIT3` — surrounding spaces and letter case are both the shopper's, not the code's", () => {
    expect(normalisePromoCode(" limit3 ")).toBe("LIMIT3");
  });

  // @regression
  it("`ONCEONLY` is already in stored form and comes back unchanged", () => {
    expect(normalisePromoCode("ONCEONLY")).toBe("ONCEONLY");
  });

  // @regression
  it("whitespace alone is rejected — it is not a code the shop failed to find, it is no code at all", () => {
    // technical-considerations §2.2: "empty after trim is a `400`, not a
    // lookup". `null` is the signal the controller turns into that 400.
    expect(normalisePromoCode("   ")).toBeNull();
  });

  // @regression
  it("the empty string is rejected the same way", () => {
    expect(normalisePromoCode("")).toBeNull();
  });
});
