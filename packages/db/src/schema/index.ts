/**
 * The full schema, in one place for drizzle-kit and for the query layer.
 *
 * The halves stay in separate modules on purpose — `./shop.ts` is what this
 * application owns, `./promo.ts` is the shop's too (spec 005's counter and
 * ledger, in their own file so the second instance of the concurrency argument
 * reads on its own), and `./supplier.ts` is the simulated supplier's own storage
 * that the shop reaches only over HTTP. See the header of `./supplier.ts`.
 */
export * from "./shop.js";
export * from "./promo.js";
export * from "./supplier.js";
