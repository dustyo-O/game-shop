/**
 * Kopecks → the string a shopper reads.
 *
 * This is the single place in the storefront where a stored amount becomes
 * display text, and it is the reason `apps/api` does not format money itself
 * (`catalog.types.ts`): the conversion happens once, at the moment of display,
 * where the currency is also in hand.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SITS IN `shared/` AND NOT IN `entities/product/`
 * ---------------------------------------------------------------------------
 * It started in the product slice, where it had exactly one caller and the
 * slice's public API deliberately withheld it — "it is the card's business how
 * a price is spelled". The order page's «Сумма» is the second caller, and it
 * lives in `entities/order`, so leaving the helper where it was would mean an
 * entity importing from a sibling entity: the same-layer import the layer rules
 * forbid outright, because it welds two slices together sideways where neither
 * can be changed alone.
 *
 * The two escape hatches for genuine entity-to-entity coupling do not apply
 * either, and it is worth saying why rather than picking one: a cross-import
 * would claim an order knows something about a *product*, and composing in a
 * higher layer would mean the page assembling money strings itself. Neither is
 * true of what this function does. It knows about kopecks and currency symbols
 * — `@game-shop/contracts` and nothing else — and knows nothing about either
 * business object. That is the definition of `shared/`, and the "not until two
 * callers" rule is now satisfied rather than anticipated.
 */
import { Currency, minorToMajor, type MinorUnits } from "@game-shop/contracts";

/**
 * The symbol for each currency the shop handles.
 *
 * A `Record<Currency, string>` rather than a lookup with a fallback: `Currency`
 * is a closed set, so adding a currency to it breaks this object at compile
 * time instead of quietly printing an amount with no unit on it.
 */
const currencySymbols: Readonly<Record<Currency, string>> = {
  [Currency.Rub]: "₽",
};

/**
 * Format an amount for the page — `formatPrice(minorUnits(129000), "RUB")` is
 * `"1290 ₽"`.
 *
 * No thousands separator. `Intl.NumberFormat("ru-RU")` would render 1290 as
 * `1 290` using a narrow no-break space, which reads correctly but makes the
 * price impossible to match by text in a test or a browser check without
 * knowing which invisible character was chosen. The catalogue's own names
 * («Пополнение Steam 500 ₽») are unseparated too, so grouping here would make
 * the row disagree with itself.
 *
 * The fractional branch exists because `minorToMajor` does not promise an
 * integer — 4999 kopecks is 49.99. Every price in the supplied catalogue is a
 * whole number of roubles, so this branch is unreachable today; it is here so
 * that a future price ending in kopecks renders as «49,99 ₽» with the Russian
 * decimal comma rather than as a bare JavaScript float.
 */
export function formatPrice(amount: MinorUnits, currency: Currency): string {
  const major = minorToMajor(amount);
  const digits = Number.isInteger(major) ? String(major) : major.toFixed(2).replace(".", ",");

  return `${digits} ${currencySymbols[currency]}`;
}
