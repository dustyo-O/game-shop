/**
 * The redemption transaction — **one code, one order, one use of the limit,
 * decided by the database** (spec 005 technical-considerations §2.2;
 * `architecture.md` §3 invariants I7 and I8, §3.1 for the statements).
 *
 * `apply(orderId, rawCode)` runs one `database.transaction(async (tx) => …)`
 * and the order of its statements **is the design**. Read the table in §2.2
 * before changing a line here; this header says why the order is what it is.
 *
 * ---------------------------------------------------------------------------
 * EVERY REFUSAL BEFORE EITHER WRITE — WHY THE ORDER IS LOAD-BEARING (R4)
 * ---------------------------------------------------------------------------
 * Eight steps. Five of them can refuse; three of them write, and step 5 is
 * both — a conditional write that refuses by touching zero rows. The five that
 * can refuse run first:
 *
 *   1. lock the order row                → `order_not_found`
 *   2. its status, in memory, under 1    → `not_awaiting_payment`
 *   3. this order's existing redemption  → `already_applied` / `another_code_applied`
 *   4. the code's definition             → `unknown_code`
 *   —  `computeDiscount`, in memory, from the rows read in 1 and 4
 *   5. I7: `UPDATE promo_codes … WHERE used_count < max_uses RETURNING`
 *                                        → `exhausted`   ← the last refusal,
 *                                                           and the first write
 *   6. I8: `INSERT INTO promo_redemptions … ON CONFLICT (order_id) DO NOTHING`
 *   7. `UPDATE orders SET amount_minor … WHERE status = 'created'`
 *   8. return the outcome — nothing re-read
 *
 * The consequence, and the reason it matters in *this* codebase: **an expected
 * refusal commits an empty transaction.** Nothing has been written when steps
 * 1–4 say no, and step 5's "no" is a statement that matched zero rows, which
 * writes nothing either. So a refusal is a `return` — a value the controller
 * maps to a status — and never a throw that exists to trigger a rollback.
 * The alternative shape, increment first and then check the order, would need
 * a *sentinel* exception thrown on purpose to undo the increment, caught by
 * name in the controller and translated back into a `409`. This codebase does
 * not do that anywhere (the transition helper, the claim, the drain all report
 * zero rows as an outcome), and the reason is that a throw-to-rollback hides
 * the refusal inside the error path where it is indistinguishable from a real
 * failure to anyone reading a log or a stack trace.
 *
 * So the **only** `throw` in the transaction is an invariant violation: step
 * 6 or step 7 matching zero rows *while this transaction holds the order row
 * lock*. Both are impossible on the path that exists — step 3 read the ledger
 * under the same lock and step 2 read the status under it — and if either
 * happens the lock discipline was broken somewhere, which is worth a `500`, a
 * `ROLLBACK` of the step-5 increment, and a stack trace. That is the one
 * rollback path, and it means a bug, never a busy shop.
 *
 * ---------------------------------------------------------------------------
 * WHY STEP 5 ADMITS EXACTLY `max_uses` TRANSACTIONS — UNDER `READ COMMITTED`
 * ---------------------------------------------------------------------------
 * Twenty shoppers, four processes, one code with `max_uses = 3`. Every
 * `UPDATE` of the same `promo_codes` row queues on that row's lock; when each
 * in turn obtains it, Postgres re-evaluates the `WHERE used_count < max_uses`
 * against the row *as the previous transaction committed it*, not as it was
 * first read. The fourth transaction in the queue therefore sees
 * `used_count = 3`, matches zero rows, and returns nothing — there is no
 * window between reading the count and writing it, because reading and
 * writing are one statement. A `SELECT used_count` followed by an `UPDATE …
 * SET used_count = $computed` has that window, and it passes every
 * single-process test, because a `max: 1` pool serialises transactions inside
 * one instance (R1). The race test and `pnpm race promo` exist to run this
 * across four processes, where the window is real.
 *
 * The transaction is at the server default, `READ COMMITTED`
 * (`packages/db/src/client.ts`). Nothing here asks for `SERIALIZABLE`: the
 * guarantee is the conditional update's own, visible in the SQL, and raising
 * the isolation level to get it would hide the mechanism this phase exists to
 * demonstrate.
 *
 * ---------------------------------------------------------------------------
 * LOCK ORDER, AND WHY THERE IS NO `SKIP LOCKED` HERE
 * ---------------------------------------------------------------------------
 * `orders` row first (step 1, `FOR UPDATE`), then the `promo_codes` row (step
 * 5, the UPDATE's own row lock). `promo_codes` is a **leaf** in the lock
 * graph: nothing locks anything after it, and the payment, issuance and
 * recovery paths never touch it — so no transaction anywhere holds a
 * `promo_codes` lock while waiting for an `orders` lock, and there is no cycle
 * to form. Never `SKIP LOCKED` on step 5: the queue *is* the mechanism. A
 * transaction that skipped the locked row would answer "exhausted" to a
 * shopper whose use was still available, one commit later.
 *
 * Step 4 deliberately takes **no** lock (`SELECT` without `FOR UPDATE`). The
 * definition read must not serialise twenty shoppers behind one row; the
 * increment serialises them, and it serialises only the increment.
 *
 * ---------------------------------------------------------------------------
 * NO READ INSIDE THE TRANSACTION — R3
 * ---------------------------------------------------------------------------
 * Step 8 returns an outcome, not the order. The controller reads the view
 * **after `COMMIT`** through `OrderViewService.findOrder`, which runs on the
 * pooled handle and takes no `tx` by design (that file's header). Calling it
 * from inside this transaction would ask the pool for a second connection
 * while this transaction holds the only one (`max: 1`): a self-deadlock that
 * ends at `CONNECTION_TIMEOUT_MS` with an error that looks nothing like its
 * cause. The same rule keeps this transaction short — no network I/O, no
 * `await` on anything but `tx` — because the order row lock and the
 * instance's one connection are both held until `COMMIT`.
 *
 * ---------------------------------------------------------------------------
 * NOTHING THE PAGE SENDS IS A NUMBER
 * ---------------------------------------------------------------------------
 * The request contributes one string, and it is normalised before the
 * transaction opens (`./promo-code.ts`). Every amount below comes from
 * `orders.amount_minor` read under the lock at step 1 and from the
 * `promo_codes` row read at step 4; `./promo-discount.ts` has no parameter a
 * client-supplied figure could reach. `discount_minor` stored is the
 * *applied* (clamped) discount, so `list_amount_minor = orders.amount_minor +
 * discount_minor` holds on every ledger row, including a 0 ₽ order.
 */
import { Inject, Injectable } from "@nestjs/common";
import { and, eq, lt, sql } from "drizzle-orm";

import { OrderStatus, isCurrency, minorUnits } from "@game-shop/contracts";
import { promoCodes, promoRedemptions, type DatabaseClient, type PromoCode } from "@game-shop/db";

import { DATABASE_CLIENT } from "../database/database.module.js";
import { OrderLockService } from "../orders/order-lock.service.js";
import { OrderRepricingOutcome, OrderRepricingService } from "../orders/order-repricing.service.js";
import { normalisePromoCode } from "./promo-code.js";
import { PromoKind, computeDiscount, type PromoDefinition } from "./promo-discount.js";
import { PromoRedemptionOutcome, type PromoRedemptionResult } from "./promo.types.js";

/**
 * The columns step 4 reads — the definition, and the id the writes need. Not
 * `used_count`: the counter is read by no statement but the one that writes
 * it (I7), and leaving it out of this shape is how nothing in memory can ever
 * be tempted to compare against it.
 */
interface PromoCodeRow {
  readonly id: number;
  readonly code: string;
  readonly kind: PromoCode["kind"];
  readonly value: number;
  readonly currency: string | null;
  readonly maxUses: number;
}

/** Exhaustiveness guard: the compiler routes here only if a kind went unhandled. */
function assertNever(value: never): never {
  throw new Error(`promo: unhandled promo kind ${JSON.stringify(value)}`);
}

/**
 * Thrown — and only thrown — when a statement that cannot match zero rows
 * under the order lock matched zero rows. Typed so the controller can log the
 * ids beside the `500` before rethrowing; a plain `Error` would reach the log
 * as a message with the ids buried in it.
 *
 * Never thrown for an expected refusal. See the file header: those are
 * returned.
 */
export class PromoRedemptionInvariantError extends Error {
  constructor(
    readonly step: "ledger_insert" | "reprice",
    readonly orderId: string,
    readonly code: string,
    readonly promoId: number,
    detail: string,
  ) {
    super(`promo: invariant violated under the order lock at ${step} — ${detail}`);
    this.name = "PromoRedemptionInvariantError";
  }
}

/**
 * Narrow a `promo_codes` row into the shape the arithmetic accepts — or `null`
 * when the row is an `amount` code whose currency is not the order's.
 *
 * The `kind` check is the `switch` itself: `promoCodes.kind` is typed from the
 * schema's `promoKinds` list (`packages/db/src/schema/promo.ts`), so the two
 * `case`s are compared against that union and the `default` refuses to
 * compile if a kind is added to the list and not handled here — the
 * compile-time twin of `promo_codes_kind_check`. `value` is trusted as the
 * column delivers it: `CHECK (value > 0)` and `CHECK (kind <> 'percent' OR
 * value <= 100)` are the bounds `computeDiscount` relies on, and they hold at
 * rest.
 *
 * ### The currency check
 *
 * An `amount` code takes `value` kopecks off *in its own currency*, and the
 * schema guarantees it has one (`promo_codes_currency_iff_amount`). What the
 * schema cannot know is the order's currency, so the comparison is here, and
 * a mismatch is refused as `unknown_code` (§2.2 step 4) — from the shopper's
 * side the code does not exist for this order. All orders are `RUB` today;
 * the check is here so the arithmetic can never subtract dollars from
 * roubles when that stops being true. `isCurrency` narrows the column's
 * `string` into the branded `Currency` the definition demands, and a currency
 * the shop cannot price fails the same way for the same reason.
 *
 * A `percent` code has no currency and needs none: a fraction of the order's
 * own amount is in the order's own currency by construction.
 */
function toPromoDefinition(promo: PromoCodeRow, orderCurrency: string): PromoDefinition | null {
  switch (promo.kind) {
    case PromoKind.Percent:
      return { kind: PromoKind.Percent, value: promo.value };

    case PromoKind.Amount:
      if (!isCurrency(promo.currency) || promo.currency !== orderCurrency) {
        return null;
      }

      return { kind: PromoKind.Amount, value: minorUnits(promo.value), currency: promo.currency };

    default:
      return assertNever(promo.kind);
  }
}

@Injectable()
export class PromoRedemptionService {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    /**
     * Step 1. `OrdersModule`'s exported lock — I4's first half, and the
     * serialisation point every write below happens after. Its signature takes
     * a `Transaction` only, so the lock cannot be taken on the pooled handle
     * and silently released before the next statement.
     */
    private readonly locks: OrderLockService,
    /**
     * Step 7. The one exported way to change what an order costs — a
     * status-guarded `UPDATE` that also takes a `Transaction` only, so it can
     * only run where the lock above can be held (`../orders/orders.module.ts`).
     */
    private readonly repricing: OrderRepricingService,
  ) {}

  /**
   * Apply `rawCode` to `orderId`, or say precisely why not.
   *
   * `rawCode` is the string as the shopper typed it; it is normalised here,
   * once, before the transaction opens, so the SQL parameter at step 4, the
   * comparison at step 3 and the `code` on every returned member are the same
   * string. An input that is empty after trimming is the controller's `400`
   * and never reaches this method over HTTP (`./promo-code.ts`, "empty is
   * rejected, not looked up"); reaching it from anywhere else is a caller bug
   * and is thrown as one rather than looked up as a code.
   *
   * The eight statements, with their emitted SQL, are commented inline. Each
   * one is copied from `.toSQL()` per the project's raw-SQL rule
   * (`architecture.md` §2, "Documentation convention").
   */
  async apply(orderId: string, rawCode: string): Promise<PromoRedemptionResult> {
    const code = normalisePromoCode(rawCode);

    if (code === null) {
      throw new Error(
        `promo: apply() was called for order ${orderId} with an empty code; ` +
          "an empty code is the controller's 400 and must never reach the transaction",
      );
    }

    return this.database.transaction(async (tx): Promise<PromoRedemptionResult> => {
      // ####################################################################
      // # 1. THE ORDER ROW LOCK. Everything below happens under it.
      // ####################################################################
      //
      //   select "id", "client_request_id", "sku", "amount_minor", "currency",
      //          "status", "created_at", "updated_at"
      //   from "orders" where "orders"."id" = $1 for update;
      //   -- $1 the order id from the URL.
      //   -- 1 row  => this transaction owns the order row until COMMIT. Every
      //   --           other redemption, payment or issuance worker that reaches
      //   --           this statement for the same id waits here.
      //   -- 0 rows => no such order; nothing is locked => `order_not_found`.
      //
      // The statement is `OrderLockService`'s and is quoted in full there.
      const order = await this.locks.lockOrder(tx, orderId);

      if (order === undefined) {
        return { outcome: PromoRedemptionOutcome.OrderNotFound, orderId, code };
      }

      // ####################################################################
      // # 2. THE STATUS, IN MEMORY — SOUND BECAUSE OF 1.
      // ####################################################################
      //
      // A check-then-act on a value read under a lock that is held until
      // COMMIT: the status cannot move between this line and step 7, because
      // the transitions that would move it all take the same lock first
      // (`../orders/order-lock.service.ts`). Step 7's `WHERE status =
      // 'created'` is the independent second stop for a caller who did not.
      if (order.status !== OrderStatus.Created) {
        return {
          outcome: PromoRedemptionOutcome.NotAwaitingPayment,
          orderId,
          code,
          observedStatus: order.status,
        };
      }

      // ####################################################################
      // # 3. THIS ORDER'S EXISTING REDEMPTION — BEFORE THE CODE LOOKUP.
      // ####################################################################
      //
      //   select "promo_codes"."id", "promo_codes"."code"
      //   from "promo_redemptions"
      //   inner join "promo_codes" on "promo_codes"."id" = "promo_redemptions"."promo_id"
      //   where "promo_redemptions"."order_id" = $1;
      //   -- $1 the order id.
      //   -- 1 row whose code = the normalised input => `already_applied`.
      //   --           Nothing is written and the 200 body is the same view
      //   --           the first call produced.
      //   -- 1 row with a different code            => `another_code_applied`.
      //   -- 0 rows => no code on this order yet; go on to look the code up.
      //
      // Under the order lock, so every writer of this order's redemption is
      // serialised through step 1 (the I4 pattern: lock, then act) — which is
      // what makes step 6's `ON CONFLICT` unreachable. Read BEFORE step 4 so
      // that a retry, a double-click or a reload never touches the hot
      // `promo_codes` row at all: the answer for an order that already has
      // its code is decided from the ledger, and twenty repeats of it queue
      // on this order's lock, not on the code's.
      //
      // `promo_redemptions.order_id` is the PRIMARY KEY, so the join cannot
      // return two rows and no `LIMIT` is needed to promise one.
      const [existing] = await tx
        .select({ promoId: promoCodes.id, code: promoCodes.code })
        .from(promoRedemptions)
        .innerJoin(promoCodes, eq(promoCodes.id, promoRedemptions.promoId))
        .where(eq(promoRedemptions.orderId, orderId));

      if (existing !== undefined) {
        if (existing.code === code) {
          return {
            outcome: PromoRedemptionOutcome.AlreadyApplied,
            orderId,
            code,
            promoId: existing.promoId,
          };
        }

        return {
          outcome: PromoRedemptionOutcome.AnotherCodeApplied,
          orderId,
          code,
          appliedCode: existing.code,
          appliedPromoId: existing.promoId,
        };
      }

      // ####################################################################
      // # 4. THE CODE'S DEFINITION — NO LOCK, ON PURPOSE.
      // ####################################################################
      //
      //   select "id", "code", "kind", "value", "currency", "max_uses"
      //   from "promo_codes" where "promo_codes"."code" = $1;
      //   -- $1 the NORMALISED code (trim + upper-case), which is the stored
      //   --    form — `CHECK (code = upper(btrim(code)))` guarantees the other
      //   --    side of the equality (`./promo-code.ts`).
      //   -- 1 row  => the definition. `max_uses` is read for the log line
      //   --           only; `used_count` is deliberately not selected.
      //   -- 0 rows => `unknown_code`. Decided before anything is written.
      //
      // No `FOR UPDATE`: twenty shoppers reading one definition must not queue.
      // Step 5 is what serialises, and it serialises only the increment.
      // `promo_codes.code` is UNIQUE (`promo_codes_code_key`), so at most one
      // row and no `LIMIT`.
      const [promo] = await tx
        .select({
          id: promoCodes.id,
          code: promoCodes.code,
          kind: promoCodes.kind,
          value: promoCodes.value,
          currency: promoCodes.currency,
          maxUses: promoCodes.maxUses,
        })
        .from(promoCodes)
        .where(eq(promoCodes.code, code));

      if (promo === undefined) {
        return { outcome: PromoRedemptionOutcome.UnknownCode, orderId, code };
      }

      // The currency check lives in the narrowing: an `amount` code in another
      // currency is refused the same way as a code that does not exist.
      const definition = toPromoDefinition(promo, order.currency);

      if (definition === null) {
        return { outcome: PromoRedemptionOutcome.UnknownCode, orderId, code };
      }

      // ####################################################################
      // # THE ARITHMETIC — IN MEMORY, FROM ROWS READ UNDER THE LOCK.
      // ####################################################################
      //
      // `order.amountMinor` is the list price as it stood when this
      // transaction locked the row, branded as kopecks at the crossing. The
      // request body is not an input; there is no parameter it could be.
      const listAmountMinor = minorUnits(order.amountMinor);
      const { discountMinor, amountToPayMinor } = computeDiscount(listAmountMinor, definition);

      // ####################################################################
      // # 5. I7 — THE COUNTER. ONE STATEMENT; THE LAST REFUSAL AND THE FIRST
      // #    WRITE.
      // ####################################################################
      //
      //   update "promo_codes"
      //   set "used_count" = "promo_codes"."used_count" + 1
      //   where ("promo_codes"."id" = $1
      //          and "promo_codes"."used_count" < "promo_codes"."max_uses")
      //   returning "used_count";
      //   -- $1 the promo id from step 4.
      //   -- 1 row  => THIS transaction holds one of the N uses. The returned
      //   --           count is the use it took, for the log line.
      //   -- 0 rows => EXHAUSTED. The predicate was evaluated by Postgres
      //   --           against the row as the previous transaction committed
      //   --           it, after queueing on that row's lock — see the header.
      //   --           Nothing has been written; the transaction commits empty
      //   --           and the shopper is told the code is spent (409).
      //
      // Three details that are load-bearing:
      //
      //   - **The comparison is column-to-column, inside the statement.**
      //     `used_count < max_uses` is evaluated by Postgres against the row
      //     it is about to write, at the instant it holds the row's lock. No
      //     TypeScript variable ever holds the count.
      //   - **`used_count + 1` in SQL, not `$read + 1` from Node.** The
      //     increment is relative to the committed value, whatever it is by
      //     the time this statement runs; a computed absolute value would be
      //     relative to a value read earlier, which is the race.
      //   - **`RETURNING "used_count"` rather than `RETURNING *`.** One column
      //     tells one row from zero; `architecture.md` §3.1 writes the
      //     statement with `*`, and the difference is the column list only.
      const [use] = await tx
        .update(promoCodes)
        .set({ usedCount: sql`${promoCodes.usedCount} + 1` })
        .where(and(eq(promoCodes.id, promo.id), lt(promoCodes.usedCount, promoCodes.maxUses)))
        .returning({ usedCount: promoCodes.usedCount });

      if (use === undefined) {
        return {
          outcome: PromoRedemptionOutcome.Exhausted,
          orderId,
          code,
          promoId: promo.id,
          maxUses: promo.maxUses,
        };
      }

      // ####################################################################
      // # 6. I8 — THE LEDGER ROW. ZERO ROWS IS A BROKEN LOCK, NOT AN OUTCOME.
      // ####################################################################
      //
      //   insert into "promo_redemptions"
      //     ("order_id", "promo_id", "list_amount_minor", "discount_minor", "created_at")
      //   values ($1, $2, $3, $4, default)
      //   on conflict ("order_id") do nothing
      //   returning "order_id";
      //   -- $1 the order id, $2 the promo id, $3 the list amount read under the
      //   --    lock, $4 the APPLIED (clamped) discount from `computeDiscount`.
      //   -- 1 row  => the use is recorded; reprice the order and commit.
      //   -- 0 rows => IMPOSSIBLE UNDER THE ORDER LOCK: step 3 read this table
      //   --           under the same lock and found nothing, and every other
      //   --           writer of this order's row queues on step 1. A row here
      //   --           means the lock discipline was broken. Thrown, so the
      //   --           step-5 increment is ROLLED BACK — the one rollback path
      //   --           in this transaction — and the API answers 500.
      //
      // The conflict target is NAMED (`order_id`) so this clause forgives
      // exactly one constraint: the FK to `orders`, the FK to `promo_codes`
      // and `promo_redemptions_discount_range` still raise as the errors they
      // are rather than being read as "already redeemed". Contrast
      // `deliveries_order_id_key`, where zero rows is the *expected* loser of
      // a race; here the race was settled at step 1, and the constraint is
      // the proof that it was.
      const [recorded] = await tx
        .insert(promoRedemptions)
        .values({ orderId, promoId: promo.id, listAmountMinor, discountMinor })
        .onConflictDoNothing({ target: promoRedemptions.orderId })
        .returning({ orderId: promoRedemptions.orderId });

      if (recorded === undefined) {
        throw new PromoRedemptionInvariantError(
          "ledger_insert",
          orderId,
          code,
          promo.id,
          `a promo_redemptions row for order ${orderId} appeared while this transaction held ` +
            "its lock and had read none; the order lock discipline was broken somewhere",
        );
      }

      // ####################################################################
      // # 7. THE REPRICE — THE ONE WRITE TO `orders`, THROUGH THE EXPORTED
      // #    GUARDED WRITER.
      // ####################################################################
      //
      //   update "orders"
      //   set "amount_minor" = $1, "updated_at" = now()
      //   where ("orders"."id" = $2 and "orders"."status" = $3)
      //   returning "id";
      //   -- $1 the amount to pay from `computeDiscount`, $2 the order id,
      //   --    $3 the literal 'created'.
      //   -- 1 row  => repriced. The order was `created` at the instant Postgres
      //   --           evaluated the predicate, as step 2 already knew.
      //   -- 0 rows => impossible under the lock (step 2 read `created` under
      //   --           it and nothing can move the status without the same
      //   --           lock). Thrown => ROLLBACK of steps 5 and 6 => 500. The
      //   --           guard is the second stop that remains if a future
      //   --           caller forgets the lock (`order-repricing.service.ts`).
      //
      // The statement is `OrderRepricingService`'s and is quoted in full there.
      // It reports zero rows rather than throwing because it cannot know
      // whether its caller held the lock; this caller did, so here it is an
      // invariant.
      const repriced = await this.repricing.applyDiscount(tx, orderId, amountToPayMinor);

      if (repriced.outcome === OrderRepricingOutcome.NotInSourceState) {
        throw new PromoRedemptionInvariantError(
          "reprice",
          orderId,
          code,
          promo.id,
          `order ${orderId} read "${order.status}" under the lock at step 2 and the guarded ` +
            "reprice matched zero rows at step 7; the order lock discipline was broken somewhere",
        );
      }

      // ####################################################################
      // # 8. THE OUTCOME — AND NO RE-READ. The controller reads the view after
      // #    COMMIT (R3; the header).
      // ####################################################################
      return {
        outcome: PromoRedemptionOutcome.Applied,
        orderId,
        code,
        promoId: promo.id,
        usedCount: use.usedCount,
        maxUses: promo.maxUses,
      };
    });
  }
}
