/**
 * Promo-code schema — the shop's own tables for spec 005, in their own module
 * because they are the second, independent instance of this project's one
 * concurrency argument and deserve to be readable on their own.
 *
 * Two tables, two invariants (`context/product/architecture.md` §3):
 *
 *   - `promo_codes` carries the **counter** — I7, "a promo is used at most N
 *     times", enforced by ONE conditional UPDATE and nothing else;
 *   - `promo_redemptions` carries the **ledger** — I8, "one redemption per
 *     order", enforced by a PRIMARY KEY on `order_id`.
 *
 * The counter and the ledger are two columns that must agree: in production
 * `promo_codes.used_count` always equals `count(*)` of `promo_redemptions`
 * grouped by `promo_id`. A test may recompute one from the other; production
 * never does (spec 005 technical-considerations §2.1). They are two things
 * rather than one because I7 needs a *row to lock*: twenty transactions that
 * all want the same code queue on that one `promo_codes` row, and each in turn
 * re-evaluates `used_count < max_uses` against the row as the previous
 * transaction committed it. A count derived from the ledger has no such row and
 * therefore no such queue.
 *
 * Reading conventions are `./shop.ts`'s: every correctness-critical constraint
 * names its invariant and quotes the exact statement Postgres runs against it,
 * including **what zero returned rows means**; every constraint is named
 * explicitly, so a Postgres error message points at the invariant that just
 * refused to be broken.
 *
 * Lock order, for anyone adding a statement that touches both tables: the
 * `orders` row first, then the `promo_codes` row. `promo_codes` is a leaf in
 * the lock graph — nothing locks anything after it, and the payment, issuance
 * and recovery paths never touch it — so there is no cycle to find. Never
 * `SKIP LOCKED` on it: the queue *is* the mechanism (technical-considerations
 * §2.2).
 */
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

import { orders } from "./shop.js";

/**
 * The two kinds of discount the brief defines: `percent` (value is percent
 * points, bounded to 100) and `amount` (value is integer minor units of
 * `currency`). Kept as an array for the same reason `orderStatuses` is: the
 * CHECK constraint below needs the list *in SQL*, and building it from the
 * array is what keeps the TypeScript union and the constraint from drifting.
 */
export const promoKinds = ["percent", "amount"] as const;

export type PromoKind = (typeof promoKinds)[number];

/** `'percent', 'amount'` — the CHECK list, built from the array above so the two cannot drift. */
const promoKindSqlList = sql.raw(promoKinds.map((kind) => `'${kind}'`).join(", "));

/**
 * `promo_codes` — the four supplied definitions, and the counter I7 guards.
 *
 * Every column except `used_count` is a *definition* — written by the seed,
 * authoritative, re-seedable with `ON CONFLICT (code) DO UPDATE` on exactly
 * those columns. `used_count` is *state*: the seed never writes it, for the
 * same reason a re-seed does not reset a supplier knob.
 *
 * `id` is `serial` — a plain `integer` identity — rather than the `bigint`
 * identity the older shop tables use, because the ledger's `promo_id` is an
 * `integer` (technical-considerations §2.1) and a foreign key's two ends must
 * be the same type. Four rows do not need 64 bits.
 *
 * No column here references a shop table, deliberately: a promo is a
 * definition with a counter, not a relation. Which order used which code is
 * the ledger's fact (`promo_redemptions` below), and the ledger points *here*,
 * never the other way round — exactly as `orders` records a `sku` and
 * `products` knows nothing about orders.
 */
export const promoCodes = pgTable(
  "promo_codes",
  {
    id: serial("id").primaryKey(),

    /**
     * The code as the shopper types it, **stored upper-case** — an invariant,
     * not a convention, enforced by `promo_codes_code_normalised` below. The
     * lookup normalises its input the same way (`trim` + `toUpperCase`), so
     * ` limit3 ` finds `LIMIT3`. UNIQUE — see `promo_codes_code_key` below.
     */
    code: text("code").notNull(),

    /** `percent` or `amount` — see `promoKinds` above and `promo_codes_kind_check`. */
    kind: text("kind", { enum: promoKinds }).notNull(),

    /**
     * Percent points for `percent` (`10` means 10 %); integer minor units for
     * `amount` (`50000` means 500 ₽). Never a float — no money anywhere in this
     * schema is floating point.
     */
    value: integer("value").notNull(),

    /**
     * ISO 4217 code for an `amount` discount, NULL for `percent` — and exactly
     * that, enforced by `promo_codes_currency_iff_amount` below. It exists so
     * the arithmetic can never subtract dollars from roubles: an `amount` code
     * whose currency is not the order's is refused as unknown.
     */
    currency: text("currency"),

    /** The limit — `N` in "used at most N times". `> 0`, see `promo_codes_max_uses_positive`. */
    maxUses: integer("max_uses").notNull(),

    /**
     * I7 — the counter. Read and written by one statement only:
     *
     *   UPDATE promo_codes SET used_count = used_count + 1
     *   WHERE id = $1 AND used_count < max_uses
     *   RETURNING used_count;
     *   -- 1 row  => this transaction holds one of the N uses; go on to write
     *   --           the ledger row and reprice the order.
     *   -- 0 rows => EXHAUSTED. Nothing has been written; the transaction
     *   --           commits empty and the shopper is told the code is spent.
     *
     * Why this admits exactly `max_uses` transactions when twenty run at once
     * across four processes, under READ COMMITTED: every UPDATE of the same
     * row queues on that row's lock, and when each in turn obtains it Postgres
     * re-evaluates the WHERE against the row *as the previous transaction
     * committed it*, not as it was first read. The fourth in the queue sees
     * `used_count = 3`, matches nothing, and returns nothing. There is no
     * window between reading the count and writing it because reading and
     * writing are one statement. A `SELECT used_count` followed by an
     * `UPDATE ... SET used_count = $computed` has that window, and passes every
     * single-process test because a `max: 1` pool serialises inside one
     * instance (technical-considerations R1).
     *
     * `DEFAULT 0` is the one default in this file, and it is correct rather
     * than convenient: the seed must not write this column at all, and "never
     * used" is the only value a freshly defined code can honestly hold.
     */
    usedCount: integer("used_count").notNull().default(0),
  },
  (t) => [
    // ---------------------------------------------------------------------
    // `code` UNIQUE — the shopper's handle for a definition, and what makes
    // the seed re-runnable.
    //
    //   CREATE TABLE promo_codes (... CONSTRAINT promo_codes_code_key UNIQUE (code));
    //
    //   INSERT INTO promo_codes (code, kind, value, currency, max_uses)
    //   VALUES ($1, $2, $3, $4, $5)
    //   ON CONFLICT (code) DO UPDATE
    //     SET kind = excluded.kind, value = excluded.value,
    //         currency = excluded.currency, max_uses = excluded.max_uses;
    //   -- `used_count` is NOT in the SET list. A re-seed updates the
    //   -- definition and leaves the counter where the shop put it.
    //
    // The lookup that starts a redemption is a plain equality on this column:
    //
    //   SELECT id, code, kind, value, currency, max_uses
    //   FROM promo_codes WHERE code = $1;
    //   -- 0 rows => UNKNOWN CODE. 422, decided before anything is written.
    //   -- No FOR UPDATE here: the definition read must not serialise twenty
    //   -- shoppers behind one row. The I7 UPDATE below is what serialises,
    //   -- and it serialises only the increment.
    // ---------------------------------------------------------------------
    unique("promo_codes_code_key").on(t.code),

    // ---------------------------------------------------------------------
    // "Stored upper-case" is an invariant, so a fixture typo fails loud instead
    // of minting a fifth code that no normalised lookup can ever find.
    //
    //   CHECK (code = upper(btrim(code)))
    //
    // `btrim`, not `trim`: Postgres's `trim(x)` is `btrim(x)` under another
    // name, and the shorter spelling is what `\d` prints back.
    // ---------------------------------------------------------------------
    check("promo_codes_code_normalised", sql`"code" = upper(btrim("code"))`),

    // The kind list, built from `promoKinds` above.
    //   CHECK (kind IN ('percent', 'amount'))
    check("promo_codes_kind_check", sql`"kind" IN (${promoKindSqlList})`),

    // A discount of nothing is not a discount, and a negative one is a surcharge.
    //   CHECK (value > 0)
    check("promo_codes_value_positive", sql`"value" > 0`),

    // A percent discount cannot exceed the price. `amount` is bounded by the
    // arithmetic instead (`min(value, amount)`), which is why the CHECK is
    // conditional on the kind.
    //   CHECK (kind <> 'percent' OR value <= 100)
    check("promo_codes_percent_bounded", sql`"kind" <> 'percent' OR "value" <= 100`),

    // `currency` is present exactly when the value is money. Boolean equality:
    // an `amount` code without a currency and a `percent` code with one are
    // both refused.
    //   CHECK ((kind = 'amount') = (currency IS NOT NULL))
    check(
      "promo_codes_currency_iff_amount",
      sql`("kind" = 'amount') = ("currency" IS NOT NULL)`,
    ),

    // A code that may be used zero times is a code that does not exist.
    //   CHECK (max_uses > 0)
    check("promo_codes_max_uses_positive", sql`"max_uses" > 0`),

    // ---------------------------------------------------------------------
    // A BACKSTOP, NOT THE MECHANISM.
    //
    //   CHECK (used_count >= 0 AND used_count <= max_uses)
    //
    // I7 is the conditional UPDATE on `used_count` above; this CHECK turns
    // "the guard cannot overshoot" into "provably does not", at the layer that
    // still holds when TypeScript is bypassed — a psql session, a seed, a
    // future service in another language.
    //
    // ###################################################################
    // # IT ALSO HIDES A BROKEN GUARD FROM ANY TEST THAT ASSERTS ONLY ON  #
    // # THE COUNTER. READ THIS BEFORE WRITING A PROOF OF I7.             #
    // ###################################################################
    //
    // Weaken the guard to an unconditional `SET used_count = used_count + 1`
    // and run twenty redemptions of a three-use code across four processes:
    // the fourth increment does not produce `used_count = 4` — it trips this
    // CHECK with `23514 check_violation`, its transaction aborts, the API
    // answers 500, and the counter reads 3. A test that asserts `used_count
    // = 3` stays green with the mechanism gone. That is Phase 2's lesson —
    // a UNIQUE index masking a broken lock — wearing a CHECK constraint.
    // Every proof of the limit therefore asserts the SHAPE of the refusals
    // (exactly N × 200, the rest × 409 exhausted, ZERO 5xx) and the ledger
    // rows, and the counter only in addition (technical-considerations R2,
    // §4's RED column).
    //
    // The lower bound guards the test harnesses' cleanup, which decrements
    // by exactly the redemptions it deleted: a cleanup that over-decremented
    // would raise here instead of leaving a negative count for the next
    // baseline check to explain.
    //
    // The seed side of the same CHECK: re-seeding `max_uses` BELOW the
    // current `used_count` trips it and aborts the seed — loud and correct,
    // since silently accepting it would leave a code that reads as
    // over-spent.
    // ---------------------------------------------------------------------
    check(
      "promo_codes_used_count_range",
      sql`"used_count" >= 0 AND "used_count" <= "max_uses"`,
    ),
  ],
);

/**
 * `promo_redemptions` — the ledger: which order used which code, at what list
 * price, for how much off.
 *
 * One row here is the shop's definition of "a use of this code was spent on
 * this order". The two amounts are **stored, not derived**, because "the record
 * of what was paid does not change after the fact" is a property of columns:
 * `orders.amount_minor` becomes the amount to pay, and `list_amount_minor` /
 * `discount_minor` here are the only place the list price survives
 * (technical-considerations §1, decision 1).
 */
export const promoRedemptions = pgTable(
  "promo_redemptions",
  {
    /**
     * I8 — one redemption per order. PRIMARY KEY, and a FK to `orders.id`.
     *
     * ############################################################
     * # PRIMARY KEY (order_id) IS I8 STRENGTHENED. ONE CODE PER    #
     * # ORDER — NOT ONE USE OF EACH CODE PER ORDER.                #
     * ############################################################
     *
     * architecture.md §3 wrote I8 as `UNIQUE (promo_id, order_id)`, which
     * would have let two *different* codes land on one order — a second
     * discount on an already-discounted price. The functional spec's rule is
     * one code per order, so the key is `(order_id)` alone. The stronger key
     * implies the weaker: a table with at most one row per `order_id` has at
     * most one row per `(promo_id, order_id)`, so every guarantee I8 was
     * written to give still holds, and architecture.md is amended to match
     * (technical-considerations §1 decision 3, §5 assumption 2).
     *
     *   INSERT INTO promo_redemptions
     *     (order_id, promo_id, list_amount_minor, discount_minor)
     *   VALUES ($1, $2, $3, $4)
     *   ON CONFLICT (order_id) DO NOTHING
     *   RETURNING order_id;
     *   -- 1 row  => the use is recorded; reprice the order and commit.
     *   -- 0 rows => IMPOSSIBLE UNDER THE ORDER LOCK, and therefore a thrown
     *   --           error, not an outcome: the transaction holds
     *   --           `SELECT ... FROM orders WHERE id = $1 FOR UPDATE` and
     *   --           read this table under it before deciding to write, so a
     *   --           conflicting row means the lock discipline was broken.
     *   --           The throw rolls back the I7 increment that preceded it —
     *   --           the one rollback path in the redemption transaction,
     *   --           and a 500.
     *
     * Contrast `deliveries_order_id_key`, where 0 rows is the *expected*
     * loser of a race and the caller keeps the existing row. Here the race
     * is settled one statement earlier, by the order lock; the constraint is
     * the proof that it was.
     *
     * WHY A REAL FOREIGN KEY — the `deliveries` argument (architecture §2):
     * only code that has already locked and read the order writes this row,
     * so a dangling reference can only be a bug, and a bug worth refusing at
     * the door. The table that deliberately carries NO such key is
     * `payment_events`, whose rows may legitimately arrive before their
     * order; the contrast is the point, and this table is on the
     * `deliveries` side of it.
     */
    orderId: text("order_id")
      .primaryKey()
      .references(() => orders.id),

    /**
     * The definition this use was spent on. FK to `promo_codes.id`; indexed
     * (`promo_redemptions_promo_id_idx` below) because this is the column the
     * counter is reconciled against.
     */
    promoId: integer("promo_id")
      .notNull()
      .references(() => promoCodes.id),

    /** The order's `amount_minor` before the discount, in integer minor units. */
    listAmountMinor: integer("list_amount_minor").notNull(),

    /**
     * The discount actually applied, clamped, in integer minor units — so
     * `list_amount_minor = orders.amount_minor + discount_minor` holds even
     * when an `amount` code is larger than the price and the order costs 0.
     */
    discountMinor: integer("discount_minor").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The two amounts must describe a discount: never negative, never more
    // than the price. The application clamps; this refuses a bypass.
    //   CHECK (discount_minor >= 0 AND discount_minor <= list_amount_minor)
    check(
      "promo_redemptions_discount_range",
      sql`"discount_minor" >= 0 AND "discount_minor" <= "list_amount_minor"`,
    ),

    // ---------------------------------------------------------------------
    // The FK column's index — and the reconciliation's access path.
    //
    //   CREATE INDEX promo_redemptions_promo_id_idx ON promo_redemptions (promo_id);
    //
    // Serves every statement that goes from a code to its uses:
    //
    //   SELECT promo_id, count(*) FROM promo_redemptions GROUP BY promo_id;
    //   -- the counter/ledger agreement check a test may run; production
    //   -- never recomputes `used_count` from this.
    //
    // and the test harnesses' cleanup, which deletes this test's rows by
    // `order_id` (the PK) and then decrements each code by exactly the number
    // it removed (technical-considerations §2.5) — never a global recompute,
    // which would silently REPAIR any drift between counter and ledger that
    // the baseline assertion exists to catch.
    //
    // `order_id` needs no index of its own: it is the primary key, and the
    // order view's `LEFT JOIN promo_redemptions ON order_id = orders.id` is a
    // 1:0..1 lookup on it.
    // ---------------------------------------------------------------------
    index("promo_redemptions_promo_id_idx").on(t.promoId),
  ],
);

export type PromoCode = typeof promoCodes.$inferSelect;
export type NewPromoCode = typeof promoCodes.$inferInsert;
export type PromoRedemption = typeof promoRedemptions.$inferSelect;
export type NewPromoRedemption = typeof promoRedemptions.$inferInsert;
