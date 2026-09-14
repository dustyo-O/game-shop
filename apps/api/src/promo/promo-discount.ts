/**
 * The discount arithmetic — **a pure function of stored data** (spec 005
 * technical-considerations §2.2, "Discount arithmetic"; risk R8).
 *
 * A code's definition and the order's list amount in, two kopeck amounts out.
 * No clock, no database, no Nest, no request. That is not a stylistic
 * preference: it is what lets `../../test/unit/promo-discount.test.ts` pin the
 * brief's four worked examples and R8's non-exact case by handing the function
 * its inputs, and it is what keeps the request body out of the arithmetic.
 *
 * ---------------------------------------------------------------------------
 * NOTHING THE PAGE SENDS IS A NUMBER
 * ---------------------------------------------------------------------------
 * The only thing a shopper contributes to a redemption is a *code* — a string
 * that selects a `promo_codes` row. Both arguments here come from that row and
 * from `orders.amount_minor`, read under the order lock inside the transaction
 * (§2.2, the in-memory row between statements 4 and 5). There is no parameter
 * through which a client-supplied amount, percentage or currency could reach
 * this function, and that absence is the design: the server computes the final
 * price from stored data, and a request that claimed a different discount has
 * no field to claim it in.
 *
 * ---------------------------------------------------------------------------
 * `discountMinor` IS THE APPLIED DISCOUNT, NOT THE FACE VALUE
 * ---------------------------------------------------------------------------
 * A 500 ₽ code on a 300 ₽ order takes 300 ₽ off, and 300 is what this function
 * reports. `promo_redemptions.discount_minor` stores it, and the ledger's
 * `CHECK (0 <= discount_minor AND discount_minor <= list_amount_minor)` is the
 * same statement at rest — so `list_amount = amount_to_pay + discount` holds on
 * every row, including the one where the shopper pays nothing. A function that
 * reported the face value would produce a row the CHECK refuses, and the
 * refusal would surface as a 500 in the one place §2.2 says a rollback means a
 * broken invariant.
 */
import { minorUnits, type Currency, type MinorUnits } from "@game-shop/contracts";

/**
 * How a code takes money off. Mirrors `promo_codes.kind`'s
 * `CHECK (kind IN ('percent','amount'))` (technical-considerations §2.1): the
 * column is `text`, so narrowing a row into a {@link PromoDefinition} is the
 * redemption service's job, and this is the set it narrows into.
 *
 * An `as const` object rather than a TypeScript `enum`, per the project rule
 * (`.claude/skills/typescript-development`): no runtime class, and the values
 * compare equal to the plain strings in the column and in log lines.
 */
export const PromoKind = {
  /** `value` is percent points off the list amount, `1..100`. */
  Percent: "percent",
  /** `value` is a fixed amount off, in minor units of `currency`. */
  Amount: "amount",
} as const;

export type PromoKind = (typeof PromoKind)[keyof typeof PromoKind];

/**
 * One `promo_codes` row, reduced to what the arithmetic may read.
 *
 * Narrower than the row on purpose — no `id`, no `code`, no `max_uses`, no
 * `used_count`. The limit is enforced by statement 5 of the transaction
 * (I7, `UPDATE … WHERE used_count < max_uses`), never by anything in this
 * file, and leaving those columns out is how a future edit cannot quietly make
 * the price depend on them.
 *
 * `percent.value` is `1..100`, which the schema guarantees at rest:
 * `CHECK (value > 0)` and `CHECK (kind <> 'percent' OR value <= 100)`. The
 * arithmetic below relies on the upper bound (see {@link computeDiscount}).
 * `amount.value` is {@link MinorUnits} — kopecks, the stored scale — and
 * carries its `currency` so the caller can refuse to subtract dollars from
 * roubles before ever reaching here (§2.2, statement 4).
 */
export type PromoDefinition =
  | { readonly kind: typeof PromoKind.Percent; readonly value: number }
  | {
      readonly kind: typeof PromoKind.Amount;
      readonly value: MinorUnits;
      readonly currency: Currency;
    };

/** What a code does to one order, in the stored scale. Both fields are integers. */
export interface DiscountResult {
  /**
   * The **applied** discount — clamped to the list amount, never the face
   * value. This is what `promo_redemptions.discount_minor` stores. See the
   * file header.
   */
  readonly discountMinor: MinorUnits;
  /** `amountMinor − discountMinor`. Never negative; see {@link computeDiscount}. */
  readonly amountToPayMinor: MinorUnits;
}

/** Exhaustiveness guard: the compiler routes here only if a kind went unhandled. */
function assertNever(value: never): never {
  throw new Error(`promo: unhandled promo kind ${JSON.stringify(value)}`);
}

/**
 * Apply one code's definition to one list amount.
 *
 * Pure and total over {@link PromoDefinition}. The `switch` is exhaustive by
 * {@link assertNever}: a third kind added to {@link PromoKind} stops this
 * compiling rather than pricing to `undefined`.
 *
 * ### `percent` — `Math.round((amount × value) / 100)`, half up
 *
 * Nearest kopeck, with an exact half rounding **up** — R8's resolution of the
 * brief's silence on rounding. Half-up is the ordinary retail convention (a
 * price tag says 967,50 ₽, never 967,4999 ₽), it is what a shopper checking the
 * figure on paper will reproduce, and it is what `Math.round` does for
 * non-negative input (it rounds a half toward +∞; the `-0` it yields for
 * `-0.5` is unreachable here, because neither argument is negative). The four
 * seeded examples on 1 290 ₽ are exact and cannot tell rounding modes apart;
 * the unit test pins 25 % of 9 999 → 2 500 (2 499,75 up) and 10 % of 5 → 1
 * (0,5 up), which can.
 *
 * **Float safety, and why the expression multiplies first and divides last.**
 * `amountMinor` is a Postgres `integer` (< 2³¹) and `value ≤ 100`, so the
 * product is an exact integer below 2⁵³ — no rounding happens in the
 * multiplication. Division by 100 is then correctly rounded by IEEE 754: an
 * exact half (`…50 / 100`) is representable and arrives at `Math.round` as an
 * exact `.5`, and every other quotient is at least 0,01 from a half, which is
 * orders of magnitude wider than a double's spacing at this size. Written the
 * other way round, `amount × (value / 100)` would begin from `0.1`'s inexact
 * representation and hand `Math.round` a value that is *near* a half rather
 * than *at* one.
 *
 * ### `amount` — `min(value, amount)`
 *
 * The clamp. A code worth more than the order takes the whole order and no
 * more, and the clamped figure is what is reported (file header).
 *
 * ### `amountToPayMinor ≥ 0` by construction
 *
 * For `amount`, `discount ≤ amount` is the clamp itself. For `percent`,
 * `value ≤ 100` (the schema's CHECK, stated on {@link PromoDefinition}) gives
 * `amount × value / 100 ≤ amount`, and rounding a quantity that is at most an
 * integer `amount` cannot exceed that integer. So the subtraction below is
 * never negative and no `Math.max(0, …)` is needed after it — the invariant is
 * a consequence of the two rules above, not a third rule bolted on to catch
 * their failure. If it ever fails, the bug is upstream of this file (a
 * definition that escaped the CHECK), and the redemptions CHECK
 * `discount_minor <= list_amount_minor` is the backstop that turns it into a
 * refused row rather than a negative price.
 */
export function computeDiscount(amountMinor: MinorUnits, definition: PromoDefinition): DiscountResult {
  const discount = appliedDiscount(amountMinor, definition);

  return {
    discountMinor: minorUnits(discount),
    // Never negative — see "`amountToPayMinor ≥ 0` by construction" above.
    amountToPayMinor: minorUnits(amountMinor - discount),
  };
}

/** The kopecks one definition takes off one amount — the two rules, and nothing else. */
function appliedDiscount(amountMinor: MinorUnits, definition: PromoDefinition): number {
  switch (definition.kind) {
    case PromoKind.Percent:
      // Multiply first, divide last. See `computeDiscount`, "Float safety".
      return Math.round((amountMinor * definition.value) / 100);
    case PromoKind.Amount:
      // The clamp: never more than the order is worth.
      return Math.min(definition.value, amountMinor);
    default:
      return assertNever(definition);
  }
}
