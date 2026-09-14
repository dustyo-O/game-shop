/**
 * The supplied promo codes — four definitions, **verbatim from the assignment**.
 *
 * This is a fixed input, not a design decision, in exactly the sense
 * `./catalog.ts` is (technical-considerations §3, "System Dependencies": *the
 * supplied catalog, key pool and webhook contract are fixed inputs and must be
 * used verbatim*). It is kept as a flat table of literals, in the brief's own
 * order and with the brief's own units, so a reviewer can diff this file
 * against the brief line by line. Nothing here is computed, sorted, or
 * normalised; everything derived lives in `../seed.ts`.
 *
 * The brief, in full — one sentence and four rows:
 *
 *   «Промокоды для этапа 4 (fullstack). Лимит должен соблюдаться даже под
 *   параллельными запросами. Скидку считает сервер.»
 *
 *   { "code": "WELCOME10", "type": "percent", "value": 10,  "max_uses": 100 }
 *   { "code": "GG500",     "type": "amount",  "value": 500, "currency": "RUB", "max_uses": 20 }
 *   { "code": "LIMIT3",    "type": "percent", "value": 25,  "max_uses": 3 }
 *   { "code": "ONCEONLY",  "type": "percent", "value": 50,  "max_uses": 1 }
 *
 * The sentence is the whole of Phase 5: the limit is I7, the server's discount
 * is decision 1 of the tech spec, and the four rows are what this file holds.
 *
 * ---------------------------------------------------------------------------
 * GG500'S VALUE IS IN WHOLE ROUBLES HERE. THE DATABASE STORES MINOR UNITS.
 * ---------------------------------------------------------------------------
 * The brief writes `"value": 500` with `"currency": "RUB"` — five hundred
 * roubles; `promo_codes.value` holds `50000`. That conversion is deliberately
 * **not** applied in this file, for the reason `./catalog.ts` gives for its
 * prices: if it were, the number below would no longer match the brief and the
 * fixture would stop being diffable, which is its whole purpose. The
 * multiplication happens in exactly one expression in `../seed.ts`, against
 * `MINOR_UNITS_PER_ROUBLE` from `./catalog.ts` — the same constant and the same
 * place that turns `priceRub` into `price_minor`. The three `percent` values
 * are percent points and are stored as the brief prints them; no conversion
 * applies.
 *
 * ---------------------------------------------------------------------------
 * THE BRIEF SAYS `type`; THE SCHEMA SAYS `kind`.
 * ---------------------------------------------------------------------------
 * The column is `promo_codes.kind` (`../schema/promo.ts`, `promoKinds`), because
 * `type` is already the catalogue's word for a product's category and one word
 * meaning two things in one schema is how a join goes wrong. This file keeps
 * the brief's spelling so it stays a transcription; `../seed.ts` is the one
 * place that writes `kind: item.type`, and the two literal lists — the brief's
 * `percent` / `amount` and the schema's — are checked against each other there
 * at compile time. That is the only renaming between this file and the table.
 *
 * `used_count` is not here, and must never be: it is *state*, written by the
 * shop as codes are redeemed. This file is the *definition* — the columns a
 * re-seed is allowed to rewrite (`ON CONFLICT (code) DO UPDATE` on exactly
 * these, `../seed.ts`).
 */

/**
 * One row of the brief, in the brief's own units. A discriminated union on the
 * brief's `type`, because the brief's two shapes differ in what `value` means:
 * percent points for one, roubles-with-a-currency for the other. Modelling that
 * as one shape with an optional `currency` would let a `percent` row carry a
 * currency or an `amount` row omit one — both of which the database refuses
 * (`promo_codes_currency_iff_amount`), and neither of which should have to
 * reach the database to be caught.
 */
export type PromoCodeDefinition = PercentPromoDefinition | AmountPromoDefinition;

/** A percentage off the order. */
export interface PercentPromoDefinition {
  /** The shopper's handle, **upper-case**; `promo_codes.code`, UNIQUE. */
  readonly code: string;
  /** The brief's word; becomes `promo_codes.kind`. See the header. */
  readonly type: "percent";
  /** Percent points, exactly as the brief prints them (`10` is 10 %). Stored as-is. */
  readonly value: number;
  /** The brief's `max_uses` — `N` in "used at most N times". */
  readonly maxUses: number;
}

/** A fixed sum off the order, in a named currency. */
export interface AmountPromoDefinition {
  /** The shopper's handle, **upper-case**; `promo_codes.code`, UNIQUE. */
  readonly code: string;
  /** The brief's word; becomes `promo_codes.kind`. See the header. */
  readonly type: "amount";
  /**
   * **Whole roubles**, exactly as the brief prints `value` — not minor units.
   * Multiplied by `MINOR_UNITS_PER_ROUBLE` (`./catalog.ts`) on its way into
   * `promo_codes.value`, in `../seed.ts` and nowhere else.
   */
  readonly valueRub: number;
  /** ISO 4217 code, as the brief writes it on the row; `promo_codes.currency`. */
  readonly currency: string;
  /** The brief's `max_uses` — `N` in "used at most N times". */
  readonly maxUses: number;
}

/**
 * The four codes. Order, spelling, values and limits are the brief's.
 *
 * `satisfies` rather than a type annotation, as in `./catalog.ts`: the literal
 * types survive (so `type: "percnet"` is a compile error here, and so is a
 * `percent` row that tries to carry a `currency`) while the shape is still
 * checked against {@link PromoCodeDefinition}.
 */
export const promoCodeDefinitions = [
  {
    code: "WELCOME10",
    type: "percent",
    value: 10,
    maxUses: 100,
  },
  {
    code: "GG500",
    type: "amount",
    valueRub: 500,
    currency: "RUB",
    maxUses: 20,
  },
  {
    code: "LIMIT3",
    type: "percent",
    value: 25,
    maxUses: 3,
  },
  {
    code: "ONCEONLY",
    type: "percent",
    value: 50,
    maxUses: 1,
  },
] as const satisfies readonly PromoCodeDefinition[];

/**
 * Four. Named so a caller asserting on the definitions — the test harnesses'
 * baseline is `promo_codes = 4` — does not hard-code it.
 */
export const PROMO_CODE_COUNT = promoCodeDefinitions.length;
