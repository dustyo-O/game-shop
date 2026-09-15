/**
 * `POST /api/admin/demo/reset` — **put the deployed demo back to what the
 * seed left, in one transaction, and say what moved** (spec 006 functional
 * spec §2.3; technical-considerations §2.4, R9).
 *
 * Paired with `./demo-reset.service.ts` the way `../admin/`'s routes are
 * paired with theirs: the controller owns the route, the guard, the status
 * code and the log line, and issues no SQL of its own. The transaction, its
 * order, and the lock argument live in the service.
 *
 * ###########################################################################
 * # A DEMO AFFORDANCE FOR THE DEPLOYED SHOP. IT IS NOT PART OF THE SHOP.
 * ###########################################################################
 *
 * This is the second entry in the register `../admin/promo-codes-reset.controller.ts`
 * opened, and it exists for the same audience in a wider situation: a
 * reviewer with the live URL and no `psql`, after any amount of buying,
 * paying, racing and arming, wants the shop as the seed left it — so the
 * next `pnpm race`, the next walk through the storefront, or the next
 * screenshot starts from a known state. The promo reset arms *one check's*
 * re-run; this arms the whole demo's.
 *
 * What it touches: everything except `products` and the fifty
 * `supplier_keys` rows themselves. Every order and every row an order ever
 * produced (`deliveries`, `issuance_attempts`, `promo_redemptions`,
 * `payment_events` — processed or not), the supplier's own ledger
 * (`supplier_requests`), and the three things a purchase *changes* rather
 * than creates, put back to their seeded values: every promo counter to `0`,
 * every key claim released, every supplier behaviour knob off. The catalogue
 * and the key pool are the fixture; the reset restores the fixture's state,
 * not the fixture.
 *
 * It is a knob for the demo, in the `supplier_behaviour` family
 * (`architecture.md` §6): a `PUT /internal/suppliers/:provider/behaviour`
 * arms a scenario, the promo reset arms a re-run, this arms a fresh start.
 * The shop itself never calls it — nothing in `src/` outside `demo/` imports
 * the service, `DemoModule` exports nothing, and there is no path from a
 * shopper's request to it. Behind {@link AdminTokenGuard} for the same reason
 * the others are: it changes what the shop will do next — and this one
 * changes it more than any other route in the API, which is why its log line
 * is at `warn` and lists every count.
 *
 * ###########################################################################
 * # LOCAL CHECKS NEVER CALL THIS. THEY CLEAN UP THROUGH THE HARNESS INSTEAD.
 * ###########################################################################
 *
 * Every local check — the four-process race, the acceptance files, the e2e,
 * `pnpm race` with a reachable database — removes **its own** rows through
 * `cleanupTestOrders` (`apps/api/test/concurrency/support/db.ts`, mirrored in
 * `apps/web/e2e/support/db.ts`): the ids it created, the request ids it
 * derived, the redemption rows it wrote, decremented by exactly that count.
 * A cleanup scoped to what the test made is a cleanup that can *fail* — it
 * leaves behind whatever the application leaked, and `assertBaseline` then
 * names it. A local run that called this endpoint instead would erase the
 * evidence along with the residue: a leaked claim, a stranded event, a
 * counter that drifted from its ledger — every one of them swept into
 * `removed` and `reset` and reported as a success. The harness is the local
 * cleanup precisely because it is *not* a reset.
 *
 * Only the deployed shop, whose database the checks cannot reach, is cleaned
 * this way — by `pnpm demo:reset` (task 2 of this slice) or the race runner's
 * `RACE_DEMO_RESET=1` (slice 4), both of which say so in their output. A
 * local run's output must never contain that line. The one local caller is
 * `demo-routes.test.ts` (task 4), which tests the endpoint itself against
 * rows it created and asserts the baseline afterwards — the same rule
 * `promo-codes-reset` lives under.
 *
 * ---------------------------------------------------------------------------
 * IT DELETES THE PROMO LEDGER. THE PROMO RESET REFUSES TO. BOTH ARE RIGHT.
 * ---------------------------------------------------------------------------
 * `../admin/promo-codes-reset.controller.ts` argues at length that
 * `promo_redemptions` must survive its reset: the ledger is *"the record of
 * what paid orders paid"* — a delivered order that paid 967,50 ₽ for a
 * 1 290 ₽ item has its `promo` row, its «было …» price and its discount
 * **only** there, and deleting it would leave a shopper's page showing a
 * discount with no code beside it. The counter is state; the ledger is
 * history. Reset the one, never the other.
 *
 * That argument is about a shop whose orders remain. Here they do not: the
 * orders whose history the ledger was are deleted **in the same
 * transaction** (`./demo-reset.service.ts`), so at `COMMIT` there is no
 * delivered order left for a ledger row to describe, no `/order/<id>` page
 * left to show `promo: null` on, and no books left to be short an entry.
 * Counter and ledger then agree at `0 = 0` by construction — which is the
 * invariant `packages/db/src/schema/promo.ts` states everywhere else in the
 * shop, restored rather than broken. The promo reset cannot delete the
 * ledger *because* it leaves the orders; this reset must delete it *because*
 * it does not. Each argument is right for its scope, and neither licenses
 * the other: a future "clear the ledger but keep the orders" would be wrong
 * in both files.
 *
 * ---------------------------------------------------------------------------
 * `POST`, `200`, NO BODY
 * ---------------------------------------------------------------------------
 * `POST`, for `PaymentEventSweepController`'s reason: it changes what the
 * shop will do next, and a `GET` that did so would be reachable by a
 * prefetch, a link preview or a browser restoring a tab — and this one would
 * empty the shop. `@HttpCode(200)` rather than Nest's `@Post` default of
 * `201` because nothing is created: no new resource, no new URL, no
 * `Location` to send; the response is a report about rows that are now gone
 * and rows that are back where the seed put them. No request body: there is
 * nothing to parameterise — a partial reset is the half-state the service's
 * header forbids — and a body would be one more thing `pnpm demo:reset` had
 * to get right.
 *
 * Idempotent in the plain sense, and it says so: a second call reports every
 * count `0`, `changed: false`, and the same `now` — functional spec §2.3's
 * "changes nothing and reports that". Idempotent also in the stronger sense
 * R9 relies on: a straggler from a continuation that was mid-flight during
 * the first call is picked up by the second, and a third is `changed: false`.
 */
import { Controller, HttpCode, HttpStatus, Logger, Post, UseGuards } from "@nestjs/common";

import { AdminTokenGuard } from "../admin/admin-token.guard.js";
import { DemoResetService } from "./demo-reset.service.js";
import type { DemoResetReport } from "./demo.types.js";

@Controller("api/admin/demo")
// On the controller rather than the handler, for the reason the admin
// controllers give: every route this class ever grows is behind the token,
// and a guard that has to be remembered per method is a guard that will
// eventually be forgotten on one. Under `api/admin/` because the token is the
// admin token and the caller is the operator; in `demo/` and not `admin/`
// because of what it is allowed to write (`./demo.module.ts`).
@UseGuards(AdminTokenGuard)
export class DemoResetController {
  private readonly logger = new Logger(DemoResetController.name);

  constructor(private readonly reset: DemoResetService) {}

  /**
   * Run the reset transaction and report what it removed, what it put back,
   * whether anything moved, and the baseline the shop now sits at.
   *
   * **`200`, not Nest's `@Post` default of `201`.** Nothing is created: this
   * is an instruction to remove and restore rows that already exist, and the
   * response is a report rather than a new resource with an address.
   */
  @Post("reset")
  @HttpCode(HttpStatus.OK)
  async resetDemo(): Promise<DemoResetReport> {
    const startedAt = Date.now();
    const report = await this.reset.reset();

    // Always logged, and at `warn`, not `log`: this is the one request that
    // empties the shop, and a log later read to explain why an order id from
    // yesterday answers 404 today should have this line in it, at a level
    // that stands out. The full counts rather than a summary: "removed 2
    // orders" is the whole story of what a reviewer's previous session left,
    // and `changed: false` on a line is how an operator sees that a second
    // call was a no-op without reading the body.
    //
    // No `order_id`, `event_id` or `request_id`, and that is not an exception
    // to `architecture.md` §8: this request concerns every order and no one
    // of them.
    this.logger.warn({
      msg: report.changed
        ? "demo reset: the shop is back at the seeded baseline; every order, delivery, event, attempt, redemption and supplier request removed, every counter, claim and behaviour knob restored"
        : "demo reset: the shop was already at the seeded baseline; nothing changed",
      removed: report.removed,
      reset: report.reset,
      changed: report.changed,
      duration_ms: Date.now() - startedAt,
    });

    return report;
  }
}
