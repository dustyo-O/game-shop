/**
 * `text` column → {@link Currency}, for the `orders` module's two row mappers.
 *
 * A narrowing check rather than `row.currency as Currency`, for the reason
 * `catalog.service.ts` gives at its own copy of this function: the assertion
 * would compile and be wrong in the one case that matters, letting a currency
 * the shop cannot price reach the shopper as if it could.
 *
 * ### Why this is one file inside `orders` and still a copy of `catalog`'s
 *
 * Until spec 005 this function lived in `./orders.service.ts`, beside the one
 * mapper that used it, with a note that the duplication against `catalog` was
 * deliberate: hoisting four lines into a shared module would couple `orders`
 * to `catalog` — or invent a third home for it — to save nothing. That
 * argument is about a *module* edge, and it still holds; `catalog` keeps its
 * copy.
 *
 * What changed is that `orders` now has two mappers in two files —
 * `toExistingOrder` in `./orders.service.ts` and `toOrderView` in
 * `./order-view.service.ts` — and a second copy *inside one module* is not a
 * boundary being respected, it is the same function twice a directory apart.
 * So the definition moved here, where both can import it without either file
 * importing the other. No module edge was added; `catalog` is untouched.
 */
import { Currency } from "@game-shop/contracts";

export function toCurrency(value: string): Currency {
  if (value === Currency.Rub) return value;
  throw new Error(`orders: order row has unsupported currency "${value}"`);
}
