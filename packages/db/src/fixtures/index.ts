/**
 * The assignment's fixed inputs, transcribed.
 *
 * `./catalog.ts` and `./supplier-key-pool.ts` are data, not code: they exist so
 * the supplied catalogue and key pool can be diffed against the brief. `../seed.ts`
 * is the only thing that writes them to the database.
 *
 * `./supplier-behaviour.ts` is the third, and the only one that is not an input
 * from the brief: it is the *off* position of Phase 3's failure knobs, kept
 * beside the others because `../seed.ts` loads it the same way and because the
 * control endpoint that resets those knobs must reset them to the same values a
 * fresh clone starts with.
 *
 * The halves stay in separate modules for the same reason the schema does — the
 * key pool and the behaviour knobs are the *supplier's*, and shop code has no
 * business importing either. See the header of `./supplier-key-pool.ts`.
 */
export * from "./catalog.js";
export * from "./supplier-behaviour.js";
export * from "./supplier-key-pool.js";
