/**
 * The body `POST /api/admin/demo/reset` answers with — what the transaction
 * removed, what it put back, whether anything moved at all, and the baseline
 * the shop now sits at (spec 006 technical-considerations §2.4; functional
 * spec §2.3, "changes nothing and reports that").
 *
 * Not in `packages/contracts`, for `../admin/promo-codes-reset.types.ts`'s
 * reason: the contracts package holds wire shapes two sides must agree on
 * letter for letter, and this one has a single producer whose consumers —
 * `scripts/demo-reset.ts`, the race runner's `RACE_DEMO_RESET=1`, an
 * operator's `curl` — mirror it rather than import it, so a script stays a
 * script that takes a base URL and nothing else.
 *
 * Field names are snake_case, matching every other body this API sends.
 *
 * ---------------------------------------------------------------------------
 * EVERY NUMBER IN `removed` AND `reset` IS A `rowCount`, NEVER A COUNT READ
 * BEFOREHAND
 * ---------------------------------------------------------------------------
 * The service issues each statement once and reports the count Postgres put
 * in that statement's command tag (`DELETE 2`, `UPDATE 1`). Nothing here is a
 * `SELECT count(*)` taken before the delete and trusted to still be right by
 * the time the delete ran — that would be a number read in one statement and
 * written in another, which is the pattern the whole project argues against.
 * The body describes what the transaction *did*.
 *
 * `now`, by contrast, is a read — the last statement of the same transaction,
 * so it sees every row the transaction removed and nothing a concurrent
 * request commits after it. It is the harness's `readBaselineCounts` query
 * (`apps/api/test/concurrency/support/db.ts`) plus one column, so the
 * operator's eye and the test's assertion look at the same twelve numbers.
 */

/**
 * The shop's whole-database snapshot as the reset leaves it — the eleven
 * columns `readBaselineCounts` reads, plus `supplier_behaviour_baseline`.
 *
 * At baseline on a seeded shop: `products 12`, `keys_total 50`,
 * `keys_unclaimed 50`, `orders 0`, `payment_events 0`, `deliveries 0`,
 * `issuance_attempts 0`, `supplier_requests 0`, `promo_codes 4`,
 * `promo_used_count 0`, `promo_redemptions 0`, `supplier_behaviour_baseline 2`.
 */
export interface DemoBaseline {
  /** Rows in `products` — the brief's catalogue. Never touched by the reset. */
  readonly products: number;
  /** Rows in `supplier_keys` — the fixture pool. Never touched by the reset (only their claims are). */
  readonly keys_total: number;
  /** Keys with `claimed_by_request_id IS NULL`. Equal to `keys_total` at baseline. */
  readonly keys_unclaimed: number;
  /** Rows in `orders`. */
  readonly orders: number;
  /** Rows in `payment_events`, processed or not. */
  readonly payment_events: number;
  /** Rows in `deliveries`. */
  readonly deliveries: number;
  /** Rows in `issuance_attempts`. */
  readonly issuance_attempts: number;
  /** Rows in `supplier_requests` — the supplier's own ledger. */
  readonly supplier_requests: number;
  /** Rows in `promo_codes` — the brief's four definitions. Never touched by the reset (only their counters are). */
  readonly promo_codes: number;
  /** `sum(used_count)` over every code — the COUNTER half of I7. */
  readonly promo_used_count: number;
  /** Rows in `promo_redemptions` — the LEDGER half of I7/I8. */
  readonly promo_redemptions: number;
  /**
   * Rows in `supplier_behaviour` whose six knobs equal the seeded baseline
   * (`packages/db/src/fixtures/supplier-behaviour.ts`: every one off). `2`
   * on a seeded shop — one row per provider, both at rest.
   */
  readonly supplier_behaviour_baseline: number;
}

/** Rows each `DELETE` removed, in the order the transaction issued them. */
export interface DemoResetRemoved {
  readonly orders: number;
  readonly deliveries: number;
  readonly issuance_attempts: number;
  readonly promo_redemptions: number;
  readonly payment_events: number;
  readonly supplier_requests: number;
}

/**
 * Rows each `UPDATE` changed. Each statement carries a `WHERE` that matches
 * only rows *not* already at baseline, so on a shop that is already reset
 * every one of these is `0` — which is what lets `changed` be computed from
 * the counts rather than from a comparison with a snapshot.
 */
export interface DemoResetReset {
  /** `promo_codes` rows whose `used_count` was non-zero. */
  readonly promo_codes: number;
  /** `supplier_keys` rows that held a claim. */
  readonly supplier_keys: number;
  /** `supplier_behaviour` rows that had any knob armed. */
  readonly supplier_behaviour: number;
}

/** The whole report. */
export interface DemoResetReport {
  readonly removed: DemoResetRemoved;
  readonly reset: DemoResetReset;
  /**
   * `true` if any count in `removed` or `reset` is non-zero. A second call on
   * an untouched shop answers `false`, and `now` reads the same — functional
   * spec §2.3's "changes nothing and reports that".
   */
  readonly changed: boolean;
  /** The baseline as the transaction's last statement read it. */
  readonly now: DemoBaseline;
}
