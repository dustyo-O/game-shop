/**
 * The full schema, in one place for drizzle-kit and for the query layer.
 *
 * The two halves stay in separate modules on purpose — `./shop.ts` is what this
 * application owns, `./supplier.ts` is the simulated supplier's own storage that
 * the shop reaches only over HTTP. See the header of `./supplier.ts`.
 */
export * from "./shop.js";
export * from "./supplier.js";
