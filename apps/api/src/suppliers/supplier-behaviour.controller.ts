/**
 * `PUT /internal/suppliers/:provider/behaviour` — **the reviewer's console into
 * the simulated supplier** (spec 003 technical-considerations §7; functional
 * spec §2.7, fourth criterion).
 *
 * > Given the reviewer can make a supplier fail on demand, when they set how
 * > often it fails or goes quiet, then the shop's behaviour under those
 * > conditions can be reproduced **without changing the shop itself**.
 *
 * The last five words are the requirement. Everything Phase 3 promises —
 * a refusal answered by the backup, a silence investigated rather than assumed
 * to be failure, an order recovered after restocking — needs a way to *cause*
 * the failure, and rebuilding the API with a different constant is not one: it
 * changes the thing under test.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS UNDER `/internal` AND NOT `/api/admin`
 * ---------------------------------------------------------------------------
 * It is on the **supplier's** side of the boundary. `/internal/suppliers/a` is
 * "a different service that happens to share a process"
 * (`./a/supplier-a.controller.ts`), reached by the shop over real HTTP through
 * `SUPPLIER_A_URL`; this route configures that service. Filing it under
 * `/api/admin` — where the sweep and Phase 3's recovery endpoints correctly
 * live — would say the shop owns a switch for how reliable its suppliers are,
 * which is precisely the confusion this directory exists to prevent.
 *
 * The prefix authenticates nothing, here or anywhere
 * (`../admin/payment-event-sweep.controller.ts` says so explicitly). The token
 * does, and it is the same token, which is why the guard is imported from
 * `../admin/` rather than copied.
 *
 * ###########################################################################
 * # AND STILL NOTHING IS EXPORTED TO THE SHOP.
 * ###########################################################################
 *
 * `SupplierBehaviourModule` exports nothing, exactly as `SupplierAModule`
 * exports nothing. The shop cannot inject {@link SupplierBehaviourService},
 * cannot read the table, and therefore cannot know a supplier is about to
 * refuse before it has been refused. A shop that knew in advance would make
 * every Phase 3 demonstration theatre.
 *
 * ---------------------------------------------------------------------------
 * WHY `PUT`, AND WHY AN OMITTED FIELD IS A ZERO
 * ---------------------------------------------------------------------------
 * See {@link SupplierBehaviourRequest}. In one line: `PUT` means *make the
 * resource look like this*, so the body fully determines the supplier's
 * behaviour and a check's second run is identical to its first — which is
 * §2.7's fifth criterion, obtained from the method's own semantics rather than
 * from every caller remembering to reset six fields.
 *
 * ###########################################################################
 * # A RATE OUTSIDE [0, 1] IS REFUSED. IT IS NEVER CLAMPED.
 * ###########################################################################
 *
 * Clamping `1.5` to `1.0` gives the reviewer a shop that behaves differently
 * from the one they asked for, and says nothing about it. They then reason from
 * a premise the system quietly discarded — which is the same failure as a green
 * check that exercised nothing, and this whole slice exists to make failures
 * *observable*. `400`, with a message naming the field and the range.
 *
 * The refusal is enforced twice on purpose: here, where a person can be told
 * why, and again as a CHECK constraint (migration 0003) at the layer that still
 * holds when TypeScript is bypassed by a `psql` session or a future service in
 * another language.
 *
 * ---------------------------------------------------------------------------
 * EVERY KNOB ON THIS ROW IS NOW LIVE — INCLUDING WHERE THE HANG GOES
 * ---------------------------------------------------------------------------
 * Both stubs read their own row: `fail_next` then `failure_rate` **before** the
 * key claim (`SupplierBehaviourService.shouldRefuse`), and `hang_next` then
 * `hang_rate` decided before the claim but **held on the side
 * `hang_before_claim` names** (`./supplier-hang.ts`).
 *
 * That sixth field is the one worth knowing about, because it selects between
 * two scenarios that are not interchangeable and that a single hang point
 * cannot both produce (technical-considerations §7.1):
 *
 *   {"hang_next": 1, "hang_ms": 5000}
 *     — the **timeout trap**, and the default. The supplier claims a key,
 *       commits it to its ledger, and then waits past `SUPPLIER_TIMEOUT_MS`.
 *       A key genuinely exists; the client that timed out cannot know it.
 *
 *   {"hang_next": 1, "hang_ms": 500, "hang_before_claim": true}
 *     — **a slow supplier is not a failed one**. The wait happens before
 *       anything is claimed and, being shorter than the shop's deadline,
 *       produces no timeout at all.
 *
 * The default is the trap deliberately: it is the scenario this phase exists to
 * demonstrate, and the one a reviewer arming a bare `hang_next` is almost
 * certainly after. The other placement has to be asked for by name.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Logger,
  NotFoundException,
  Param,
  Put,
  UseGuards,
} from "@nestjs/common";

import { supplierBehaviourBaseline } from "@game-shop/db";

import { AdminTokenGuard } from "../admin/admin-token.guard.js";
import {
  SupplierBehaviourService,
  type SupplierBehaviourSettings,
  type StoredSupplierBehaviour,
} from "./supplier-behaviour.service.js";
import type { SupplierBehaviourResponse } from "./supplier-behaviour.types.js";

/** The six fields a body may carry. Anything else is a typo, and typos are refused. */
const behaviourFields = [
  "failure_rate",
  "hang_rate",
  "hang_ms",
  "fail_next",
  "hang_next",
  "hang_before_claim",
] as const;

/** `null`-safe object test — `typeof null` is `"object"`, and a body may be `null`. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An optional rate: absent, or a finite number in `[0, 1]`.
 *
 * `Number.isFinite` rather than `typeof value === "number"` alone, because
 * `NaN` and `Infinity` are both numbers and `NaN < 0` and `NaN > 1` are both
 * false — so a bare range comparison lets `NaN` straight through. Postgres
 * `numeric` accepts `NaN` as a value, and a `failure_rate` of `NaN` compares
 * false against every `Math.random()` for the rest of the row's life: a
 * supplier configured to fail that silently never does. The database's range
 * CHECK would in fact refuse it (Postgres orders `NaN` above every number, so
 * `NaN <= 1` is false), but one layer later and with a message about a
 * constraint rather than about the field.
 */
function readRate(body: Record<string, unknown>, field: string, fallback: number): number {
  const value = body[field];

  if (value === undefined) return fallback;

  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new BadRequestException(
      `"${field}" must be a number between 0 and 1 inclusive; it is refused rather than clamped, ` +
        `so that the supplier behaves exactly as asked`,
    );
  }

  return value;
}

/**
 * An optional count or duration: absent, or a non-negative whole number.
 *
 * Whole, because half a millisecond of hang and half an armed refusal are both
 * meaningless, and `hang_ms`/`fail_next` are `integer` columns — a fractional
 * value would either be rejected by the driver or silently truncated, and
 * silently truncated is the outcome this endpoint refuses to produce.
 */
function readCount(body: Record<string, unknown>, field: string, fallback: number): number {
  const value = body[field];

  if (value === undefined) return fallback;

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new BadRequestException(`"${field}" must be a whole number of 0 or more`);
  }

  return value;
}

/**
 * An optional flag: absent, or a genuine boolean.
 *
 * `typeof value !== "boolean"`, so `"true"`, `1` and `"false"` are all refused
 * rather than coerced — and `"false"` is why this is worth a paragraph. Every
 * non-empty string is truthy, so a coercing read would turn a reviewer's
 * `{"hang_before_claim": "false"}` into `true` and silently move the hang to
 * the other side of the key claim: they would arm the timeout trap, watch a
 * slow-but-successful call, and have nothing anywhere to tell them which
 * scenario actually ran. That is the same dishonesty as clamping a rate, with a
 * worse blast radius, because the field selects a *scenario* rather than an
 * amount.
 */
function readFlag(body: Record<string, unknown>, field: string, fallback: boolean): boolean {
  const value = body[field];

  if (value === undefined) return fallback;

  if (typeof value !== "boolean") {
    throw new BadRequestException(
      `"${field}" must be true or false; strings and numbers are refused rather than coerced, ` +
        `because this field chooses which scenario the supplier stages`,
    );
  }

  return value;
}

/**
 * Parse the wire body into the whole row that will replace the stored one.
 *
 * Hand-written rather than `class-validator` + a `ValidationPipe`, as every
 * other controller here is, and in the style of `parseSupplierIssueRequest`
 * next door.
 *
 * **Unknown fields are refused before anything else is read.** A body of
 * `{"failure_rated": 1}` that was accepted-and-ignored would leave the reviewer
 * certain they had armed a failure and watching a shop that never fails — the
 * clamp problem again, in a different costume. The check is first so that the
 * message is about the typo rather than about the zero the typo implied.
 *
 * A body that is not JSON at all never reaches here: Express's parser rejects
 * it and Nest turns that into a `400`, which is the same answer for the same
 * reason.
 */
function parseSupplierBehaviourRequest(body: unknown): SupplierBehaviourSettings {
  if (!isJsonObject(body)) {
    throw new BadRequestException(
      'expected a JSON object; send {} to restore the baseline, or any of ' +
        '{ "failure_rate", "hang_rate", "hang_ms", "fail_next", "hang_next" }',
    );
  }

  const known = new Set<string>(behaviourFields);
  const unknown = Object.keys(body).filter((key) => !known.has(key));

  if (unknown.length > 0) {
    throw new BadRequestException(
      `unknown field(s) ${unknown.map((key) => `"${key}"`).join(", ")}; ` +
        `this endpoint replaces the whole row, so an ignored field would silently ` +
        `leave the supplier behaving differently from what was asked. Known fields: ` +
        behaviourFields.join(", "),
    );
  }

  // The fallbacks are the seeded baseline itself, imported rather than
  // retyped — `PUT {}` and a fresh clone must mean the same thing, and one
  // constant is the only way that stays true.
  return {
    failureRate: readRate(body, "failure_rate", supplierBehaviourBaseline.failureRate),
    hangRate: readRate(body, "hang_rate", supplierBehaviourBaseline.hangRate),
    hangMs: readCount(body, "hang_ms", supplierBehaviourBaseline.hangMs),
    failNext: readCount(body, "fail_next", supplierBehaviourBaseline.failNext),
    hangNext: readCount(body, "hang_next", supplierBehaviourBaseline.hangNext),
    hangBeforeClaim: readFlag(
      body,
      "hang_before_claim",
      supplierBehaviourBaseline.hangBeforeClaim,
    ),
  };
}

/** The stored row on the wire: snake_case, and the timestamp as ISO 8601. */
function toResponse(behaviour: StoredSupplierBehaviour): SupplierBehaviourResponse {
  return {
    provider: behaviour.provider,
    failure_rate: behaviour.failureRate,
    hang_rate: behaviour.hangRate,
    hang_ms: behaviour.hangMs,
    fail_next: behaviour.failNext,
    hang_next: behaviour.hangNext,
    hang_before_claim: behaviour.hangBeforeClaim,
    updated_at: behaviour.updatedAt.toISOString(),
  };
}

/** Exhaustiveness guard: the compiler routes here only if an outcome went unhandled. */
function assertNever(value: never): never {
  throw new Error(`suppliers: unhandled behaviour write outcome ${JSON.stringify(value)}`);
}

@Controller("internal/suppliers")
// On the controller rather than the handler, for the reason
// `PaymentEventSweepController` gives: every route this class ever grows is
// behind the token, and a guard that has to be remembered per method is a guard
// that will eventually be forgotten on one.
//
// The same `AdminTokenGuard`, deliberately not a second copy: three answers,
// `503` when `ADMIN_TOKEN` is unset, `401` when it is missing or wrong, the
// handler otherwise. An unconfigured token DISABLES this endpoint; it has never
// meant "open" and must not come to.
@UseGuards(AdminTokenGuard)
export class SupplierBehaviourController {
  private readonly logger = new Logger(SupplierBehaviourController.name);

  constructor(private readonly behaviour: SupplierBehaviourService) {}

  /**
   * Replace one supplier's behaviour, and answer with the row as stored.
   *
   * `200`, which is `@Put`'s Nest default and the right code: the resource
   * already exists — the seed created it — so this replaces rather than
   * creates, and there is no new address to announce with a `201`.
   *
   * ### `404` comes from zero returned rows, not from a list of provider names
   *
   * {@link SupplierBehaviourService.replaceBehaviour} issues a guarded
   * `UPDATE … WHERE provider = $1 RETURNING *`. Zero rows means no such
   * supplier — a typo in the path, most likely — and the endpoint says so
   * instead of quietly creating a behaviour row for a supplier that does not
   * exist and letting the reviewer watch a healthy shop ignore knobs they are
   * certain they set. The set of real providers is the set of seeded rows, and
   * adding supplier C is a seed row and nothing else.
   */
  @Put(":provider/behaviour")
  async setBehaviour(
    @Param("provider") provider: string,
    @Body() body: unknown,
  ): Promise<SupplierBehaviourResponse> {
    const settings = parseSupplierBehaviourRequest(body);
    const result = await this.behaviour.replaceBehaviour(provider, settings);

    switch (result.outcome) {
      case "stored":
        // Always logged, at `log`. Somebody deliberately changed how a
        // dependency behaves, and the next confusing thing in the stream — a
        // refusal, a timeout, a fall-through — is only explicable next to this
        // line. It carries no `order_id`, `event_id` or `request_id` because it
        // concerns none: `architecture.md` §8's rule is about the payment and
        // issuance paths, and this is a configuration change that happens
        // before any of them.
        this.logger.log({
          msg: `supplier ${result.behaviour.provider}: behaviour replaced`,
          ...toResponse(result.behaviour),
        });

        return toResponse(result.behaviour);

      case "provider_not_found":
        this.logger.warn({
          msg: "supplier behaviour refused: no such provider",
          provider: result.provider,
          status_code: 404,
        });

        throw new NotFoundException(
          `no supplier "${result.provider}"; a provider exists when it has a seeded ` +
            `supplier_behaviour row`,
        );

      default:
        return assertNever(result);
    }
  }
}
