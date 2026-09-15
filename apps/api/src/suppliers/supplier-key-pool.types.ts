/**
 * The bodies `POST /internal/suppliers/keys/drain` and
 * `POST /internal/suppliers/keys/restock` answer with (spec 006
 * technical-considerations §2.4, "supplier side, beside the behaviour route").
 *
 * Not in `packages/contracts`, for `./supplier-behaviour.types.ts`'s reason:
 * the contracts package holds wire shapes two sides must agree on letter for
 * letter — the webhook payload, the supplier `/issue` exchange, the lifecycle
 * enum — and these two have a single producer whose callers
 * (`scripts/race/recover-out-of-stock.ts`, `scripts/race/support/recovery-scenario.ts`,
 * an operator's `curl`) mirror them rather than import them, so a script stays
 * a script that takes a base URL and nothing else.
 *
 * Field names are snake_case, matching every other body this API sends.
 *
 * ---------------------------------------------------------------------------
 * EVERY NUMBER HERE IS THE COUNT OF ROWS ONE `UPDATE … RETURNING id` HANDED
 * BACK, NEVER A COUNT READ BEFOREHAND
 * ---------------------------------------------------------------------------
 * `claimed` is how many keys the drain statement actually claimed and
 * `released` is how many the restock statement actually released — the length
 * of each statement's `RETURNING` set. Nothing is a `SELECT count(*)` taken
 * first and trusted to still be right by the time the `UPDATE` ran: that
 * would be a number read in one statement and written in another, the pattern
 * the whole project argues against, and against a concurrent real claim it
 * would be wrong by exactly the rows the claim took in between.
 */

/** The request body both routes accept. Every field optional; an unknown field is a `400`. */
export interface SupplierKeyPoolRequest {
  /**
   * The run token that scopes a drain and its matching restock.
   *
   * Optional on `drain`: when absent the server mints a UUID and returns it,
   * and the caller restocks with what it was given. Optional on `restock` too,
   * with a different meaning: absent means *every* sentinel claim, whichever
   * drain made it — the sweep for a run that lost its token.
   *
   * Shape: `^[A-Za-z0-9-]{1,64}$`. Why neither `_` nor `%` — the two
   * characters `LIKE` treats as wildcards — is allowed, and why that matters
   * even though a real claim can never match regardless, is in
   * `./supplier-key-pool.controller.ts` (`readToken`).
   */
  readonly token?: string;
}

/** `POST /internal/suppliers/keys/drain` → the token to restock with, and how many keys it now holds. */
export interface SupplierKeyPoolDrainResponse {
  /** The run token — the caller's own, or the one minted for it. Restock with exactly this. */
  readonly token: string;
  /**
   * Keys claimed by this call. `0` is not an error: it means the pool was
   * already empty — every key held by a real order or by an earlier drain —
   * and a `restock` with this token will release exactly `0`.
   */
  readonly claimed: number;
}

/** `POST /internal/suppliers/keys/restock` → how many sentinel claims were released. */
export interface SupplierKeyPoolRestockResponse {
  /**
   * Keys released by this call — only ever rows whose claim began with
   * `drain_`. A key delivered to a shopper (claimed `req_…`) is never among
   * them, whatever the token (R15).
   */
  readonly released: number;
}
