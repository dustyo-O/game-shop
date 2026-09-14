/**
 * Promo-code normalisation — **trim, then upper-case, and nothing else**.
 *
 * Functional spec 005 §2.1: *"A code is matched regardless of letter case:
 * `limit3` and `Limit3` are `LIMIT3`. Spaces before or after a code are
 * ignored."* This file is the whole of that rule on the request side, and it
 * is a pure function so the unit test can state the rule by example.
 *
 * ---------------------------------------------------------------------------
 * WHY THE API NORMALISES, RATHER THAN THE QUERY
 * ---------------------------------------------------------------------------
 * The lookup in the redemption transaction is statement 4 of
 * technical-considerations §2.2 — `SELECT … FROM promo_codes WHERE code = $2`
 * — a plain equality against `UNIQUE (code)`. For that equality to find
 * `LIMIT3` when the shopper typed ` limit3 `, the value bound to `$2` must
 * already be in stored form, and putting it there is this function's job.
 *
 * The alternative — making the *comparison* forgiving, `WHERE upper(btrim(code))
 * = upper(btrim($2))` — would throw away the unique index (an expression on the
 * column is not the column) and split one rule across two places: the query for
 * lookups, and somewhere else for everything that displays, logs or compares a
 * code. Normalising once, at the boundary, means every later `code` in the
 * request's life — the SQL parameter, the `already_applied` comparison against
 * the redemption's stored code (statement 3), the log line — is the same string.
 *
 * ---------------------------------------------------------------------------
 * THE TABLE'S CHECK IS THE SAME RULE, ENFORCED AT REST
 * ---------------------------------------------------------------------------
 * `promo_codes` carries `CHECK (code = upper(btrim(code)))` (§2.1). That is
 * this function written in SQL and pointed at the *stored* side of the
 * equality: a row is admitted only if normalising it changes nothing. The two
 * together are what make the plain `=` correct — the input is normalised on
 * the way in, the stored value is guaranteed already normalised, so equal
 * strings are equal codes. Without the CHECK, a fixture typo (`Welcome10`)
 * would seed a fifth code that no normalised input can ever match; with it,
 * the seed fails loud (§2.1's note on the CHECK: "a fixture typo fails loud
 * instead of minting a fifth code").
 *
 * The two implementations differ at the edges and it does not matter which is
 * broader: `String.prototype.trim` strips every Unicode whitespace character
 * while `btrim(text)` strips only the space character, and `toUpperCase` is
 * Unicode-aware while `upper()` follows the database collation. The output
 * here is only ever *compared against* stored codes, never stored, and the
 * stored codes are the brief's four ASCII strings — so an input that the two
 * would normalise differently is simply one that does not match, and the
 * transaction answers `unknown_code` (422). Interior whitespace is left alone
 * for the same reason: `LIMIT 3` is not a code, and the shop does not guess.
 *
 * `toUpperCase`, not `toLocaleUpperCase`: the former is locale-independent, so
 * an `i` upper-cases to `I` on every server regardless of its locale settings.
 *
 * ---------------------------------------------------------------------------
 * EMPTY IS REJECTED, NOT LOOKED UP
 * ---------------------------------------------------------------------------
 * §2.2: *"empty after trim is a `400`, not a lookup."* An empty string is not a
 * code the shop failed to find — it is a request that named no code, and
 * `unknown_code` (422) would be the wrong sentence to say back. `null` is the
 * signal; the controller turns it into the 400 and never reaches the
 * transaction with it.
 */

/**
 * The stored form of a code as the shopper typed it, or `null` if there was
 * no code in the input at all.
 *
 * Trim, then upper-case: `" limit3 "` → `"LIMIT3"`, `"ONCEONLY"` →
 * `"ONCEONLY"`, `"   "` → `null`, `""` → `null`. Pure — no I/O, no globals.
 */
export function normalisePromoCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();

  return code.length === 0 ? null : code;
}
