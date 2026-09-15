/**
 * `POST /internal/suppliers/keys/drain` and `POST /internal/suppliers/keys/restock`
 * — **empty the supplier's key pool on demand, and put it back** (spec 006
 * functional spec §2.2; technical-considerations §2.4, R15).
 *
 * Paired with `./supplier-key-pool.service.ts` the way
 * `./supplier-behaviour.controller.ts` is paired with its service: the
 * controller owns the routes, the guard, the status code, the body validation
 * and the log lines, and issues no SQL of its own. The two statements, the
 * sentinel's shape and the concurrent-claim argument live in the service.
 *
 * ###########################################################################
 * # TWO DEMO AFFORDANCES FOR THE DEPLOYED SHOP. THEY ARE NOT PART OF THE SHOP.
 * ###########################################################################
 *
 * These are the third and fourth entries in the register
 * `../admin/promo-codes-reset.controller.ts` opened and
 * `../demo/demo-reset.controller.ts` continued, and they exist for one
 * scenario: the empty pool. Functional spec §2.2 of spec 003 wants a shopper
 * who pays into a pool with no keys left to end at `out_of_stock` and to be
 * recovered after restocking — and the pool has fifty keys. Buying fifty
 * orders to reach that state is not a demonstration a reviewer will run twice.
 * `drain` claims every unclaimed key under a run-scoped sentinel in one
 * statement, so the very next purchase meets an empty pool; `restock`
 * releases exactly those sentinel claims, so the pool is whole again and the
 * stranded order can be retried to `delivered`.
 *
 * Who calls them:
 *
 *   - `scripts/race/recover-out-of-stock.ts` — `drain` → pay → `out_of_stock`
 *     → `restock` by token in its `finally` → retry → `delivered`. Always
 *     through these routes, with or without a database of its own, so the
 *     path a reviewer exercises against the live shop is the same path local
 *     RED sees (technical-considerations §2.4).
 *   - the reviewer, by `curl`, against the deployed shop with the demo token —
 *     the only way to stage the scenario on a database they cannot reach.
 *
 * Neither is ever called by the shop. `SupplierBehaviourModule` exports
 * nothing, nothing in `src/` outside `suppliers/` imports the service, and
 * there is no path from a shopper's request to either route.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE UNDER `/internal/suppliers` AND NOT `/api/admin/demo`
 * ---------------------------------------------------------------------------
 * Because they write `supplier_keys`, and `supplier_keys` is the supplier's
 * inventory — "treat them as if they were in the supplier's own datacentre"
 * (`packages/db/src/schema/supplier.ts`). The rule that makes every Phase 3
 * demonstration honest is that no shop module imports that schema: the shop
 * discovers an empty pool by being *told* `out_of_stock` across HTTP, never by
 * looking. A drain filed under `/api/admin` would have the shop holding a
 * switch for its supplier's stock, which is precisely the confusion
 * `./supplier-behaviour.controller.ts` refused for the behaviour knobs, and
 * for the same reason these sit beside that route, in its module, behind its
 * guard. (`../demo/demo-reset.controller.ts` does write both sides — under
 * the seed's licence, as "the loader, not a participant"; a route that
 * exists to stage one supplier scenario has no such licence and does not
 * need one.)
 *
 * The prefix authenticates nothing, here or anywhere
 * (`../admin/payment-event-sweep.controller.ts`). The token does, and it is
 * the same token, which is why the guard is imported from `../admin/` rather
 * than copied.
 *
 * ###########################################################################
 * # `restock` NEVER TOUCHES A REAL CLAIM. THAT IS THE ONLY PROMISE IT MAKES.
 * ###########################################################################
 *
 * Every production path claims a key by exactly one request forever, and
 * restocking a live pool is adding rows — `supplier.ts`'s "no unclaim" rule,
 * as amended in Phase 6. This route is one of the two demo affordances that
 * clear a claim outside those paths, and it is scoped so a delivered key can
 * never be resold: it releases only rows whose claim begins `drain_`, and a
 * real claim begins `req_`. The `LIKE 'drain\_…'` with its literal-underscore
 * escape is the whole of that guarantee (R15; the service quotes the
 * statement), and the token validation below is what keeps a caller from
 * loosening the pattern from the outside. The acceptance test's RED for this
 * file widens that `WHERE` to `IS NOT NULL` and watches a delivered order's
 * key come back for sale.
 *
 * ---------------------------------------------------------------------------
 * `POST`, `200`, A BODY THAT MAY BE EMPTY
 * ---------------------------------------------------------------------------
 * `POST`, for `PaymentEventSweepController`'s reason: both change what the
 * shop will do next, and a `GET` that did so would be reachable by a
 * prefetch. `@HttpCode(200)` rather than `@Post`'s default `201` because
 * nothing is created: no new resource, no `Location`; each answers with a
 * count of rows it changed. The body is `{ token? }` — the one demo affordance
 * with a parameter, because a drain and its restock have to agree on which
 * rows are "this run's", and the token is how they do. An empty body is legal
 * on both: `drain {}` mints a token, `restock {}` sweeps every sentinel.
 *
 * `0` is never an error on either route. A drain of an already-empty pool and
 * a restock of a token that held nothing both answer `200` with a zero, so a
 * script's `finally` can always restock without first asking whether there
 * is anything to restock.
 */
import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";

import { AdminTokenGuard } from "../admin/admin-token.guard.js";
import { SupplierKeyPoolService } from "./supplier-key-pool.service.js";
import type {
  SupplierKeyPoolDrainResponse,
  SupplierKeyPoolRequest,
  SupplierKeyPoolRestockResponse,
} from "./supplier-key-pool.types.js";

/** The one field a body may carry. Anything else is a typo, and typos are refused. */
const poolFields = ["token"] as const;

/**
 * The token's shape. Letters, digits and hyphens, 1–64 of them — a UUID
 * (what `drain` mints) and any label a script might prefix it with, joined
 * by hyphens.
 *
 * **Neither `_` nor `%`, on purpose.** `restock` builds a `LIKE` pattern
 * around the token (`'drain\_' || $1 || '\_%'`, see the service), and those
 * two characters are `LIKE`'s wildcards. A real claim can never match
 * whatever the token holds — the fixed, escaped `drain\_` prefix sees to
 * that, and it is the guarantee R15 names — but a `_` in a token would still
 * act as a single-character wildcard *inside* the sentinel namespace, so a
 * restock for `a_c` would also release a drain made as `abc`. Two runs'
 * sentinels crossing is not a resold key, but it is a token that means less
 * than it says, and the clean fix is a token that cannot carry a wildcard at
 * all. Refused with a `400` naming the rule rather than escaped on the way
 * in, for the behaviour route's reason: a silently rewritten token is one the
 * caller no longer holds.
 */
const tokenShape = /^[A-Za-z0-9-]{1,64}$/;

/** `null`-safe object test — `typeof null` is `"object"`, and a body may be `null`. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse the wire body into the optional token.
 *
 * Hand-written rather than `class-validator` + a `ValidationPipe`, in the
 * style of `parseSupplierBehaviourRequest` next door, and with the same first
 * rule: **unknown fields are refused before anything else is read**. A body of
 * `{"tokne": "…"}` that was accepted-and-ignored would drain under a minted
 * token the caller never sees and leave its `finally` restocking a token that
 * held nothing — a pool left empty by a typo, with a `200` on every step.
 *
 * `undefined` is accepted as `{}`: Express 5 leaves `req.body` unset when a
 * request carries no body at all, and a bare `curl -X POST` with no body is
 * the natural way to mint a token or sweep every sentinel. `null`, an array
 * and a JSON string are still refused — they are bodies, and they are the
 * wrong shape. A body that is not JSON at all never reaches here: Express's
 * parser rejects it and Nest turns that into a `400`.
 */
function parseSupplierKeyPoolRequest(body: unknown): SupplierKeyPoolRequest {
  if (body === undefined) return {};

  if (!isJsonObject(body)) {
    throw new BadRequestException(
      'expected a JSON object; send {} (or no body) to let the server choose, or { "token": "…" } ' +
        "to name the run",
    );
  }

  const known = new Set<string>(poolFields);
  const unknown = Object.keys(body).filter((key) => !known.has(key));

  if (unknown.length > 0) {
    throw new BadRequestException(
      `unknown field(s) ${unknown.map((key) => `"${key}"`).join(", ")}; ` +
        `an ignored field would silently drain or restock a different run than the one asked for. ` +
        `Known fields: ${poolFields.join(", ")}`,
    );
  }

  return { token: readToken(body) };
}

/** An optional token: absent, or a string matching {@link tokenShape}. */
function readToken(body: Record<string, unknown>): string | undefined {
  const value = body["token"];

  if (value === undefined) return undefined;

  if (typeof value !== "string" || !tokenShape.test(value)) {
    throw new BadRequestException(
      `"token" must be 1 to 64 letters, digits or hyphens (${tokenShape.source}); ` +
        `underscores and percent signs are LIKE wildcards in the restock pattern and are refused ` +
        `rather than escaped, so the token you hold is exactly the one that was used`,
    );
  }

  return value;
}

@Controller("internal/suppliers/keys")
// On the controller rather than the handler, for the reason
// `SupplierBehaviourController` gives: every route this class ever grows is
// behind the token, and a guard that has to be remembered per method is a
// guard that will eventually be forgotten on one.
//
// The same `AdminTokenGuard`, deliberately not a second copy: three answers,
// `503` when `ADMIN_TOKEN` is unset, `401` when it is missing or wrong, the
// handler otherwise. An unconfigured token DISABLES these routes; it has never
// meant "open" and must not come to.
@UseGuards(AdminTokenGuard)
export class SupplierKeyPoolController {
  private readonly logger = new Logger(SupplierKeyPoolController.name);

  constructor(private readonly pool: SupplierKeyPoolService) {}

  /**
   * Claim every unclaimed key under this run's sentinel and answer with the
   * token to restock by and the count taken.
   *
   * A minted token is a `randomUUID()` — 36 characters of `[0-9a-f-]`, well
   * inside {@link tokenShape} — so two runs of the same check in a row, or an
   * interrupted run followed by a fresh one, can never collide on a sentinel
   * prefix.
   */
  @Post("drain")
  @HttpCode(HttpStatus.OK)
  async drain(@Body() body: unknown): Promise<SupplierKeyPoolDrainResponse> {
    const startedAt = Date.now();
    const request = parseSupplierKeyPoolRequest(body);
    const token = request.token ?? randomUUID();
    const claimed = await this.pool.drain(token);

    // Always logged, and at `warn`, not `log`: somebody deliberately emptied
    // the supplier's pool, and every `out_of_stock` that follows in the
    // stream is only explicable next to this line, at a level that stands
    // out. The token is logged so the restock that pairs with it can be
    // found. No `order_id`, `event_id` or `request_id`, and that is not an
    // exception to `architecture.md` §8: this concerns no order — it is the
    // supplier's inventory being staged before any of them.
    this.logger.warn({
      msg:
        claimed > 0
          ? `supplier keys: pool drained — ${String(claimed)} key(s) claimed under sentinel drain_${token}_<id>; every purchase settles out_of_stock until restocked with this token`
          : "supplier keys: drain found the pool already empty; nothing claimed",
      token,
      claimed,
      duration_ms: Date.now() - startedAt,
    });

    return { token, claimed };
  }

  /**
   * Release this run's sentinel claims — or every drain's, when no token is
   * given — and answer with the count released.
   */
  @Post("restock")
  @HttpCode(HttpStatus.OK)
  async restock(@Body() body: unknown): Promise<SupplierKeyPoolRestockResponse> {
    const startedAt = Date.now();
    const request = parseSupplierKeyPoolRequest(body);
    const released = await this.pool.restock(request.token);

    // `warn`, symmetrically with `drain`: the pool changed size by a hand
    // that was not a purchase. `token: null` on the wire, not an absent
    // field, so a log reader can tell "swept every sentinel" from a line
    // that simply omitted it.
    this.logger.warn({
      msg:
        request.token === undefined
          ? `supplier keys: pool restocked — ${String(released)} sentinel claim(s) released across every drain; real claims untouched`
          : `supplier keys: pool restocked — ${String(released)} sentinel claim(s) released for this token; real claims untouched`,
      token: request.token ?? null,
      released,
      duration_ms: Date.now() - startedAt,
    });

    return { released };
  }
}
