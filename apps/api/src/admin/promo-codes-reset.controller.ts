/**
 * `POST /api/admin/promo-codes/reset` — **zero every promo counter and leave
 * the ledger alone** (spec 005 technical-considerations §2.3, "The reviewer's
 * reset affordance"; R5, R15; `architecture.md` §9).
 *
 * Paired with `./promo-codes-reset.service.ts` the way the other three routes
 * are paired with theirs: the controller owns the route, the guard, the status
 * code and the log line, and issues no SQL of its own. The statement, the
 * `RETURNING`-then-sort decision and the lock argument live in the service.
 *
 * ###########################################################################
 * # A DEMO AFFORDANCE FOR THE DEPLOYED SHOP. IT IS NOT PART OF THE SHOP.
 * ###########################################################################
 *
 * This endpoint exists for exactly one caller in exactly one situation:
 * `pnpm race promo` run for the second time against a shop **whose database
 * the check cannot reach** — the deployed one, Phase 6 — where the race
 * scripts take a base URL and nothing else. The first run spends `LIMIT3`'s
 * three uses and `ONCEONLY`'s one; without a way to put them back, the second
 * run is twenty `409 exhausted`s and proves nothing about the limit, and a
 * reviewer with a URL and no `psql` is stuck at one run. `POST` here, and the
 * shop is where the seed left it.
 *
 * It is a knob for a check, in the `supplier_behaviour` family
 * (`architecture.md` §6): a `PUT /internal/suppliers/:provider/behaviour` arms
 * a scenario, this arms a re-run. The shop itself never calls it — nothing in
 * `src/` outside `admin/` imports the service, and there is no path from a
 * shopper's request to it. Behind {@link AdminTokenGuard} for the same reason
 * the other three routes are: it changes what the shop will do next.
 *
 * ---------------------------------------------------------------------------
 * IT ZEROES THE COUNTER AND LEAVES THE LEDGER. AFTER IT, THE TWO DISAGREE —
 * BY DESIGN.
 * ---------------------------------------------------------------------------
 * `promo_codes.used_count` goes to `0` on every row. `promo_redemptions` is
 * not touched: every row a paid order wrote there — which code, at what list
 * price, for how much off — is still there afterwards. Everywhere else in the
 * shop the counter equals `count(*)` of the ledger grouped by `promo_id`
 * (`packages/db/src/schema/promo.ts`, header); after this call it does not,
 * and that is the trade being made, not a defect in it:
 *
 *   - **the ledger keeps the true history** — every redemption that ever
 *     happened, and every order view's `promo` row, reads exactly as before;
 *   - **the counter becomes "uses since the last reset"** — which is the only
 *     thing a re-runnable check needs it to mean.
 *
 * ### Why it is not `DELETE FROM promo_redemptions`
 *
 * Deleting the ledger *would* keep the two in agreement — at `0 = 0` — and it
 * is the wrong statement, because the ledger is not test residue. It is the
 * record of what paid orders paid. `orders.amount_minor` is the amount to pay
 * and stays discounted after delivery; the order's `promo` row, the
 * `list_amount_minor` it shows as «было …» and the `discount_minor` it was
 * given exist **only** in `promo_redemptions` (technical-considerations §1,
 * decision 1: "the record of what was paid does not change after the fact").
 * Delete it and a delivered order that paid 967,50 ₽ for a 1 290 ₽ item reads
 * `promo: null` — a discount with no code beside it, on a shopper's page and
 * in the shop's own books. The counter is state; the ledger is history. Reset
 * the one, never the other.
 *
 * ###########################################################################
 * # LOCAL CHECKS NEVER CALL THIS. THEY CLEAN UP THROUGH THE HARNESS INSTEAD.
 * ###########################################################################
 *
 * Every local check — the four-process race, the acceptance file, the e2e,
 * `pnpm race promo` with a reachable database — restores the counter through
 * `cleanupTestOrders` in `apps/api/test/concurrency/support/db.ts` (mirrored
 * in `apps/web/e2e/support/db.ts`): a CTE that deletes **this test's**
 * redemption rows and decrements each code by **exactly that count**. That
 * leaves counter and ledger in agreement, which is what `assertBaseline`
 * checks before and after every suite — `sum(used_count) = 0` *and*
 * `promo_redemptions = 0`. A local run that called this endpoint instead
 * would pass its own assertions on the counter and fail the next suite's
 * baseline on the ledger, which is the harness noticing exactly what the
 * header above says this endpoint does. `scripts/race/promo.ts` says in its
 * own output when it has fallen back to this route, and a local run's output
 * must never contain that line.
 *
 * Never a global recompute from the ledger, in either direction: a cleanup
 * that recomputed `used_count` from `count(*)` would silently *repair* any
 * drift between the two that the baseline exists to catch (technical-
 * considerations §2.5, R5).
 *
 * ---------------------------------------------------------------------------
 * `POST`, `200`, NO BODY
 * ---------------------------------------------------------------------------
 * `POST`, for `PaymentEventSweepController`'s reason: it changes what the shop
 * will do next, and a `GET` that did so would be reachable by a prefetch, a
 * link preview or a browser restoring a tab. `@HttpCode(200)` rather than
 * Nest's `@Post` default of `201` because nothing is created — no new
 * resource, no new URL, no `Location` to send; the response is a report about
 * four rows that already existed. No request body: there is nothing to
 * parameterise (`./promo-codes-reset.service.ts`, "no WHERE"), and a body
 * would be one more thing a script had to get right to make a shop
 * re-runnable.
 *
 * Idempotent in the plain sense: calling it twice is two zeroes.
 */
import { Controller, HttpCode, HttpStatus, Logger, Post, UseGuards } from "@nestjs/common";

import { AdminTokenGuard } from "./admin-token.guard.js";
import { PromoCodesResetService } from "./promo-codes-reset.service.js";
import type { PromoCodesResetReport } from "./promo-codes-reset.types.js";

@Controller("api/admin/promo-codes")
// On the controller rather than the handler, for the reason the other two
// admin controllers give: every route this class ever grows is behind the
// token, and a guard that has to be remembered per method is a guard that
// will eventually be forgotten on one.
@UseGuards(AdminTokenGuard)
export class PromoCodesResetController {
  private readonly logger = new Logger(PromoCodesResetController.name);

  constructor(private readonly reset: PromoCodesResetService) {}

  /**
   * Zero every counter, then report every code with its limit and its (now
   * zero) counter, in seed order.
   *
   * **`200`, not Nest's `@Post` default of `201`.** Nothing is created: this
   * is an instruction to change rows that already exist, and the response is
   * a report rather than a new resource with an address.
   */
  @Post("reset")
  @HttpCode(HttpStatus.OK)
  async resetCounters(): Promise<PromoCodesResetReport> {
    const startedAt = Date.now();
    const report = await this.reset.resetCounters();

    // Always logged, and at `warn`, not `log`: unlike the sweep and the
    // recovery list this is not ordinary operation — it is the one write in
    // the shop that makes the counter and the ledger disagree, and a log that
    // is later read to explain why `used_count` is below `count(*)` of the
    // ledger should have this line in it, at a level that stands out.
    //
    // No `order_id`, `event_id` or `request_id`, and that is not an exception
    // to `architecture.md` §8: this request concerns no order and no event.
    // The four codes are listed, not counted — four short strings are the
    // whole story, and the count alone could not say which shop state a
    // reviewer's second run started from.
    this.logger.warn({
      msg: "admin promo-code reset: every counter zeroed, the ledger left as it was",
      codes: report.promo_codes.map((entry) => entry.code),
      duration_ms: Date.now() - startedAt,
    });

    return report;
  }
}
