/**
 * The assignment's fixed inputs, transcribed.
 *
 * `./catalog.ts` and `./supplier-key-pool.ts` are data, not code: they exist so
 * the supplied catalogue and key pool can be diffed against the brief. `../seed.ts`
 * is the only thing that writes them to the database.
 *
 * The two halves stay in separate modules for the same reason the schema does —
 * the key pool is the *supplier's* inventory, and shop code has no business
 * importing it. See the header of `./supplier-key-pool.ts`.
 */
export * from "./catalog.js";
export * from "./supplier-key-pool.js";
