/**
 * The supplier's failure knobs at rest — **every one of them off.**
 *
 * A fixture in the same sense as `./supplier-key-pool.ts`: data, not code, and
 * the only thing `../seed.ts` writes into `supplier_behaviour`. It is here
 * rather than inline in the seed because it has a second consumer that must not
 * be allowed to drift from it — `PUT /internal/suppliers/:provider/behaviour`
 * replaces the whole row, so *"the value an omitted field takes"* and *"the
 * value a fresh clone starts at"* have to be one definition or the reviewer's
 * reset button and the seed would eventually disagree about what "off" means
 * (`apps/api/src/suppliers/supplier-behaviour.controller.ts`).
 *
 * ---------------------------------------------------------------------------
 * WHY THE BASELINE IS ALL ZEROS AND NOT A "SENSIBLE" SET OF RATES
 * ---------------------------------------------------------------------------
 * A fresh clone must behave **exactly as it did before this table existed**:
 * supplier A answers, every time, with no injected refusal and no injected
 * silence. Any non-zero default would make the shop's ordinary behaviour depend
 * on a row nobody asked for, and the first symptom would be an intermittently
 * failing purchase in a checkout that has nothing to do with Phase 3.
 *
 * `hangMs: 0` is worth one extra sentence, because zero is a slightly odd
 * length for a hang. It is the honest value: with `hangRate` and `hangNext`
 * both zero nothing ever waits, so the column holds "no hang has been
 * configured" rather than a number somebody might mistake for a policy. A
 * reviewer arming `hang_next` without also naming `hang_ms` gets a zero-length
 * hang and sees it in the endpoint's echoed row immediately — which is the
 * failure mode this project prefers to a silently-invented default.
 *
 * ---------------------------------------------------------------------------
 * THIS IS SUPPLIER-SIDE STATE. SHOP CODE MUST NOT IMPORT IT.
 * ---------------------------------------------------------------------------
 * Same rule, same reason, as the key pool: how badly the supplier is behaving
 * is the *supplier's* business, and the shop is supposed to discover it by
 * being refused or kept waiting over HTTP. The legitimate consumers are
 * `../seed.ts` and `apps/api/src/suppliers/…`, which is the simulated supplier
 * rather than the shop.
 */

/**
 * The providers that get a behaviour row.
 *
 * Both are seeded now, before `suppliers/b` exists, and that is deliberate: the
 * control endpoint decides whether a provider is real by whether its guarded
 * `UPDATE … WHERE provider = $1` matches a row, so a missing `b` row would
 * answer a reviewer's perfectly good request with a `404` for reasons that have
 * nothing to do with what they asked. Seeding the row is what makes `b`
 * addressable the moment its stub is mounted.
 *
 * Not a CHECK constraint on the column, consistently with
 * `supplier_requests.provider` and `issuance_attempts.provider`: the retry
 * ladder owns the list of suppliers and should not have to alter a constraint
 * in order to extend itself. Here the PRIMARY KEY plus the seeded rows already
 * bound the set to exactly the providers that exist.
 */
export const supplierBehaviourProviders = ["a", "b"] as const;

export type SupplierBehaviourProvider = (typeof supplierBehaviourProviders)[number];

/** Every knob off. See the header for why each zero is the honest value. */
export const supplierBehaviourBaseline = {
  /** Probability a call is refused outright. `0` — never. */
  failureRate: 0,
  /** Probability a call is kept waiting. `0` — never. */
  hangRate: 0,
  /** How long a hang lasts. `0` — no hang has been configured. */
  hangMs: 0,
  /** One-shot refusals armed. `0` — none. */
  failNext: 0,
  /** One-shot hangs armed. `0` — none. */
  hangNext: 0,
  /**
   * Where an injected hang sits relative to the key claim. `false` — **after
   * the claim commits**, which is the timeout trap.
   *
   * The one field here whose baseline is a *placement* rather than an amount,
   * so it is worth saying why `false` is still the honest zero. With
   * `hangRate` and `hangNext` both zero nothing ever waits, so this flag
   * decides nothing at rest; what it settles is what a reviewer gets when they
   * arm `hang_next` and say nothing else. That is the trap — a key genuinely
   * issued and a client that timed out and cannot know it — because that is the
   * scenario this phase exists to demonstrate, and the `true` placement is the
   * one somebody has to ask for on purpose
   * (`../schema/supplier.ts`, `hangBeforeClaim`).
   */
  hangBeforeClaim: false,
} as const;
