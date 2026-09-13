/**
 * Public API of the `present-admin-token` feature — what happens when an
 * operator supplies the shop's admin bearer token.
 *
 * The name is the guard's own: `admin-token.guard.ts` speaks of a token being
 * *presented*, and both halves of this slice are about that one act — the form
 * that takes it and the store that remembers it for as long as the tab lives.
 *
 * `storeAdminToken` is intentionally absent: the form already stores what it
 * accepts, so a second caller would be a caller storing something the form
 * never saw. The page gets `readAdminToken` (what do we already have?) and
 * `clearAdminToken` (the API says what we have is wrong).
 *
 * Named exports only — no `export *` — so this list is the honest inventory of
 * what the slice offers.
 */
export { clearAdminToken, readAdminToken } from "./lib/admin-token-storage.js";
export { createAdminTokenForm } from "./ui/admin-token-form.js";
