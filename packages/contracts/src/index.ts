/**
 * Shared wire types for the game shop.
 *
 * `apps/api`, `apps/web` and the race scripts in `scripts/` all import from
 * here, so the wire format has exactly one definition and cannot drift between
 * the side that writes it and the side that reads it (architecture §1, "Shared
 * contracts").
 *
 * What lives here:
 *
 *   - `./order-status` — the lifecycle `created → paid → delivering → delivered`
 *     with its `payment_failed` and `out_of_stock` branches, plus which of those
 *     are terminal, which are recoverable, and which stop the status page's
 *     poll. Mirrors the `orders_status_check` CHECK constraint exactly.
 *   - `./payment-webhook` — the payment provider's event body, verbatim from the
 *     assignment.
 *   - `./supplier` — the supplier `/issue` request and its two response bodies.
 *   - `./money` — the two currency unit scales and the conversions between them.
 *
 * ---------------------------------------------------------------------------
 * ONE THING TO KNOW BEFORE USING ANY OF IT: THE WIRE AND THE DATABASE DISAGREE
 * ABOUT WHAT `500` MEANS.
 * ---------------------------------------------------------------------------
 * The payment webhook's `amount: 500` is **five hundred roubles**. The database
 * column for that same order, `orders.amount_minor`, holds **50000**. Both are
 * `number`, so nothing stops `event.amount === order.amountMinor` from
 * compiling — and it is false for every legitimate payment.
 *
 * So the two scales are separate types here, `MajorUnits` (the wire) and
 * `MinorUnits` (storage), neither assignable to the other. Cross the boundary
 * with `majorToMinor` / `minorToMajor`, never by assignment. `./money.ts` has
 * the full reasoning.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PACKAGE IS NOT
 * ---------------------------------------------------------------------------
 * Types, constants and pure predicates — nothing else, and **no runtime
 * dependencies**. `apps/web` bundles this into a browser, so a validation
 * framework or a Nest decorator here would ship to every visitor. And a wire
 * type is a description of what the other side promised, never evidence that a
 * particular payload conformed: validating an incoming body belongs to the
 * endpoint that receives it.
 *
 * Nothing here uses a TypeScript `enum`, and every enum-like value is an
 * `as const` object with a derived union type.
 *
 * Note precisely where the compiler does and does not force that. Today
 * `erasableSyntaxOnly` is set only in `tsconfig.scripts.json`, which covers
 * `scripts/` — the race and recovery scripts Node runs straight from source
 * through type stripping, where a construct needing real emit is rejected
 * outright (TS1294). This package builds under its own tsconfig without that
 * flag, so an `enum` here would compile. The rule is kept anyway because the
 * reasons are independent of the flag: a const object emits no runtime class,
 * tree-shakes out of the browser bundle `apps/web` ships, and compares equal to
 * the plain strings Postgres hands back from the `text` columns these values
 * live in — which a numeric-or-reverse-mapped enum does not. It also matches
 * `packages/db/src/schema/shop.ts`, whose `orderStatuses` this file mirrors.
 */

export * from "./money.js";
export * from "./order-status.js";
export * from "./payment-webhook.js";
export * from "./supplier.js";
