/**
 * ###########################################################################
 * # MONEY CROSSES A UNIT BOUNDARY IN THIS SYSTEM. READ THIS BEFORE USING IT. #
 * ###########################################################################
 *
 * There are two different numbers for the same amount of money, and they differ
 * by a factor of 100:
 *
 *   | Where                            | Field           | 500 ₽ looks like |
 *   | -------------------------------- | --------------- | ---------------- |
 *   | Payment webhook (the wire)       | `amount`        | `500`            |
 *   | Supplied catalogue (the brief)   | `price`         | `500`            |
 *   | `orders` / `products` (Postgres) | `*_minor`       | `50000`          |
 *
 * The wire shape is fixed by the assignment and cannot be changed; the database
 * shape is fixed by "money is integer minor units, never floating point"
 * (technical-considerations §2.2). So the boundary is real and permanent, and
 * the only question is whether it is visible.
 *
 * The bug this file exists to make impossible is one line long and passes review
 * every time:
 *
 *     if (event.amount !== order.amountMinor) rejectAsMismatched();  // always true
 *
 * `500 !== 50000`, so every legitimate payment looks fraudulent — or, with the
 * comparison the other way round, a 500-kopeck payment settles a 500-rouble
 * order. Both numbers are `number`, so nothing catches it.
 *
 * The fix is nominal typing: {@link MajorUnits} and {@link MinorUnits} are both
 * `number` at run time and neither is assignable to the other at compile time.
 * The line above stops compiling, and the only way to write it is to say which
 * unit you meant:
 *
 *     if (majorToMinor(event.amount) !== order.amountMinor) rejectAsMismatched();
 *
 * There is no runtime cost: the brand is a phantom property that exists only in
 * the type system, so a `MajorUnits` *is* a `number` and arithmetic on it works
 * unchanged. A determined caller can still cast past it — that is fine. The
 * target is the accident, not the adversary.
 */

/**
 * Minor units in one major unit — kopecks in a rouble.
 *
 * Correct only for ISO 4217 exponent-2 currencies, which is why
 * {@link Currency} is a closed set rather than a bare `string`: the constant and
 * the currency list have to be true together or neither is.
 *
 * `packages/db/src/fixtures/catalog.ts` carries the same 100 as
 * `MINOR_UNITS_PER_ROUBLE`, and the duplication is deliberate. That one converts
 * *the brief* to the database once, at seed time; this one converts *the wire*
 * to the database on every request. This package has no dependencies at all —
 * `apps/web` imports it into a browser bundle — so it cannot reach into
 * `@game-shop/db` to borrow the number, and should not: a contracts package that
 * depends on the database is no longer a contracts package.
 */
export const MINOR_UNITS_PER_MAJOR = 100;

/**
 * The currencies the shop handles. The supplied catalogue is entirely `RUB`, and
 * {@link MINOR_UNITS_PER_MAJOR} is only correct for a currency with two decimal
 * places, so widening this set is not a one-line change.
 *
 * A webhook naming any other currency is an event to reject, not a reason to
 * loosen the type.
 */
export const Currency = {
  Rub: "RUB",
} as const;

export type Currency = (typeof Currency)[keyof typeof Currency];

/**
 * Narrow an unvalidated value to a {@link Currency}.
 *
 * The storage-side twin of `isPaymentEventStatus`: `orders.currency` and
 * `products.currency` are `text` columns, so a row hands TypeScript a `string`
 * and something has to decide whether it is a currency this shop can actually
 * price. A `value as Currency` would compile and be wrong in precisely the case
 * that matters, letting an amount the shop cannot scale reach the wire as if it
 * could — {@link MINOR_UNITS_PER_MAJOR} is only true for an exponent-2 currency.
 *
 * A pure predicate, so it stays inside this package's rule: types, constants and
 * pure predicates, no runtime dependencies (`./index.ts`).
 */
export function isCurrency(value: unknown): value is Currency {
  return value === Currency.Rub;
}

/**
 * The phantom property that separates the two unit scales.
 *
 * Declared once and used at two different literal types, so the compiler's
 * complaint names the units it refused to mix:
 *
 *     Type 'MinorUnits' is not assignable to type 'MajorUnits'.
 *       Types of property '__currencyUnitScale' are incompatible.
 *         Type '"minor"' is not assignable to type '"major"'.
 *
 * It is never present at run time. `JSON.stringify(majorUnits(500))` is `500`.
 */
interface CurrencyUnitBrand<TScale extends "major" | "minor"> {
  readonly __currencyUnitScale: TScale;
}

/**
 * Whole roubles — **the wire scale**. The payment webhook's `amount: 500` and
 * the supplied catalogue's `price: 500` are this.
 *
 * Never write one of these to the database. Convert with {@link majorToMinor}.
 */
export type MajorUnits = number & CurrencyUnitBrand<"major">;

/**
 * Kopecks — **the stored scale**. `orders.amount_minor` and
 * `products.price_minor` hold this; 500 ₽ is `50000`.
 *
 * Never put one of these on the wire. Convert with {@link minorToMajor}.
 */
export type MinorUnits = number & CurrencyUnitBrand<"minor">;

/**
 * Assert that a raw `number` is whole roubles.
 *
 * This is the boundary crossing, and it is a function call precisely so that it
 * is greppable: every place raw JSON or a raw column becomes a typed amount is
 * one of these. It brands and does nothing else — validating that the value is
 * finite, non-negative and correctly scaled belongs to the endpoint that parses
 * the request, not to a shared type package.
 */
export function majorUnits(value: number): MajorUnits {
  return value as MajorUnits;
}

/** Assert that a raw `number` is kopecks. The storage-side twin of {@link majorUnits}. */
export function minorUnits(value: number): MinorUnits {
  return value as MinorUnits;
}

/**
 * Wire → storage. `majorToMinor(majorUnits(500))` is `50000`.
 *
 * Rounded because floating-point multiplication does not respect decimal money:
 * `4.35 * 100` evaluates to `434.99999999999994`, and `orders.amount_minor` is
 * an integer column. Truncating that would lose a kopeck on an amount the
 * shopper was quoted correctly. Rounding here is what keeps the "no floating
 * point in stored money" rule true at the one place a float can enter.
 */
export function majorToMinor(amount: MajorUnits): MinorUnits {
  return Math.round(amount * MINOR_UNITS_PER_MAJOR) as MinorUnits;
}

/**
 * Storage → wire. `minorToMajor(minorUnits(50000))` is `500`.
 *
 * The result is not necessarily an integer — `minorToMajor(minorUnits(4999))` is
 * `49.99` — so it is a display and payload value, never something to feed back through
 * {@link majorToMinor} as a way of "normalising" a stored amount.
 */
export function minorToMajor(amount: MinorUnits): MajorUnits {
  return (amount / MINOR_UNITS_PER_MAJOR) as MajorUnits;
}
