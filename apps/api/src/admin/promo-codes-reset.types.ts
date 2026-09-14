/**
 * The body `POST /api/admin/promo-codes/reset` answers with — the four codes
 * and their counters, every counter now `0` (spec 005 technical-considerations
 * §2.3, "The reviewer's reset affordance").
 *
 * Not in `packages/contracts`, and that is the same call
 * `./payment-event-sweep.types.ts` and `./undelivered-orders.types.ts` make.
 * The contracts package holds the wire shapes **two sides have to agree on
 * letter for letter**; this one has a single producer, and its one consumer —
 * `scripts/race/promo.ts`, when it falls back to the reset because the
 * database is out of reach — mirrors it rather than importing it, so that a
 * race script stays a script that takes a base URL and nothing else.
 *
 * Field names are snake_case, matching every other body this API sends
 * (`PaymentEventSweepReport`, `UndeliveredOrdersReport`).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * **No count of what was released.** The statement zeroes the counter without
 * reading it first, and the body reports the counter *as the statement left
 * it*, never as it was — a "was 3" would be a number read in one statement and
 * written in another, which is the pattern this whole phase exists to argue
 * against, and an operator who wants to know what a code had been used for has
 * the ledger, which this endpoint does not touch.
 *
 * **No `id`.** The service orders by it; the wire does not need it. A code is
 * its own handle everywhere else in this API (`POST /api/orders/:id/promo`
 * takes `{ code }`), and the seed's `ON CONFLICT (code)` is what makes the
 * code the stable identity across re-seeds.
 */

/** One code as the reset reports it: the definition's limit and the counter it just zeroed. */
export interface PromoCodeCounter {
  /** The code as stored — upper-case, `promo_codes_code_normalised`. */
  readonly code: string;

  /** The limit, untouched by the reset: `N` in "used at most N times". */
  readonly max_uses: number;

  /**
   * The counter **after** this reset — `0` on every row, by construction.
   *
   * Reported rather than implied so that a reviewer's script can assert it
   * rather than trust it, and so that the body says the same thing the next
   * `pnpm race promo` will start from.
   */
  readonly used_count: number;
}

/** The whole report: every code in `promo_codes`, in seed order. */
export interface PromoCodesResetReport {
  /**
   * All four codes, ordered by `promo_codes.id` — which is seed order, and
   * therefore the order the brief lists them in (`WELCOME10`, `GG500`,
   * `LIMIT3`, `ONCEONLY`; `packages/db/src/fixtures/promo-codes.ts`). Stable
   * across calls and across re-seeds, since `ON CONFLICT (code) DO UPDATE`
   * keeps the ids.
   */
  readonly promo_codes: readonly PromoCodeCounter[];
}
