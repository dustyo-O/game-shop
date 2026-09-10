/**
 * `ALLOW_CLIENT_SUPPLIED_ORDER_ID` — the one deliberate hole in "order ids are
 * always server-minted", and a hole that must stay closed by default.
 *
 * `architecture.md` §9, "Known Trade-offs": *"A test affordance on order
 * creation. The API accepts an explicit order id behind a configuration flag,
 * used only by seeds and the 'webhook before order' script. Without it that
 * scenario cannot be staged deterministically, since order ids are otherwise
 * server-generated."*
 *
 * The scenario in question is `webhook:before-order` (`architecture.md` §7):
 * deliver a `paid` webhook for an order **before the order exists**, then
 * create that order — with that exact id — on a *different* API instance, and
 * confirm the pending event gets applied when it is created. `payment_events`
 * has no foreign key to `orders` for precisely this reason (`architecture.md`
 * §4, "Out-of-order tolerance"), but staging the race deterministically needs
 * a caller who can name the order id *before* the order exists, and today
 * nothing can: `./order-id.ts`'s `newOrderId()` mints it, inside the service,
 * on the INSERT. This file is what lets a test — and only a test — pick the id
 * first and hand it to both halves of the scenario.
 *
 * ---------------------------------------------------------------------------
 * THIS SITS BESIDE `./admin-token.ts`, ON PURPOSE, FOR THE SAME REASON THAT
 * ONE DOES
 * ---------------------------------------------------------------------------
 * A value out of the environment that changes what an endpoint will accept is
 * checked once, while Nest builds the container, and every consumer downstream
 * — here, `OrdersController` — receives something already proven usable rather
 * than a string and a `??`. {@link ClientSuppliedOrderIdConfig} is a
 * discriminated union over `enabled` for the same reason {@link
 * AdminTokenConfig} is a union over `configured`: the compiler will not let a
 * caller branch on "is this on" without the type forcing it to ask, so there is
 * no shape in which "off" and "on" could be confused for one another by a
 * missing `if`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONE IS `warn`, NOT `error` LIKE AN UNSET `ADMIN_TOKEN`
 * ---------------------------------------------------------------------------
 * An unset `ADMIN_TOKEN` is a *degraded* shop — a backstop trigger going dark
 * that nobody chose. `ALLOW_CLIENT_SUPPLIED_ORDER_ID=true` is the opposite
 * shape of surprise: nobody sets it by accident, because it does not exist
 * until a developer types the exact variable name into an environment. Once
 * set, though, it is a standing hole in a guarantee this codebase otherwise
 * treats as absolute — *the client never picks a primary key* — so it is not
 * quiet-default-off log-nothing territory either. `warn` says what `error`
 * would overstate and silence would underreport: notable, correctly on, and
 * something nobody should scroll past in a deploy's startup output.
 *
 * ---------------------------------------------------------------------------
 * AND UNLIKE `ADMIN_TOKEN`, THE SAFE STATE IS THE QUIET ONE
 * ---------------------------------------------------------------------------
 * The unset case is not merely tolerated, it is the *only* state every
 * real deployment and every developer's laptop should ever be in. So it gets a
 * `log`, not a `warn` and not silence — visible in a startup transcript if
 * someone goes looking for it, invisible in the sense that matters: nothing
 * about it reads as a problem.
 */
import { Logger, type Provider } from "@nestjs/common";

import { readBooleanFlag } from "./env.js";

const ALLOW_CLIENT_SUPPLIED_ORDER_ID = "ALLOW_CLIENT_SUPPLIED_ORDER_ID";

/**
 * Whether `POST /api/orders` will honour a client-supplied `id`.
 *
 * A discriminated union over `enabled`, matching {@link AdminTokenConfig}'s
 * shape and for the same reason: `OrdersController` must ask before it can
 * act, and there is no branch in which "disabled" and "enabled" are the same
 * shape for the compiler to confuse.
 */
export type ClientSuppliedOrderIdConfig = { readonly enabled: true } | { readonly enabled: false };

/**
 * Injection token for the {@link ClientSuppliedOrderIdConfig}.
 *
 * A symbol, matching `ADMIN_TOKEN_CONFIG` and `SUPPLIER_A_CONFIG`: tokens
 * share one flat namespace per application and a symbol cannot collide with
 * one a library picked.
 */
export const CLIENT_SUPPLIED_ORDER_ID_CONFIG = Symbol("CLIENT_SUPPLIED_ORDER_ID_CONFIG");

/**
 * Read and validate the flag.
 *
 * Called from a provider factory below, which is what makes this a startup
 * check — a property of the call site rather than of this function (`./env.ts`,
 * *"AT STARTUP IS A PROPERTY OF WHERE THESE ARE CALLED"*). Unset, or exactly
 * `"false"`, returns `{ enabled: false }` and the boot continues quietly.
 * Exactly `"true"` returns `{ enabled: true }` and the boot continues loudly —
 * see the provider below. Anything else throws `ConfigurationError` and stops
 * the boot, via {@link readBooleanFlag}.
 */
export function readClientSuppliedOrderIdConfig(): ClientSuppliedOrderIdConfig {
  return { enabled: readBooleanFlag(ALLOW_CLIENT_SUPPLIED_ORDER_ID) };
}

/**
 * The flag, resolved once while Nest builds its container.
 *
 * `useFactory` with no `inject` list, matching `adminTokenConfigProvider` and
 * `supplierAConfigProvider`: Nest calls it exactly once during
 * `NestFactory.create`, whether or not anything injects the token — so the
 * boot-time log line below fires, and a malformed value stops the boot, even
 * before `OrdersController` exists to ask for the token.
 */
export const clientSuppliedOrderIdConfigProvider: Provider = {
  provide: CLIENT_SUPPLIED_ORDER_ID_CONFIG,
  useFactory: (): ClientSuppliedOrderIdConfig => {
    const config = readClientSuppliedOrderIdConfig();
    const logger = new Logger("ClientSuppliedOrderIdConfig");

    if (config.enabled) {
      logger.warn({
        msg:
          "ALLOW_CLIENT_SUPPLIED_ORDER_ID is set; POST /api/orders will honour a client-supplied " +
          '"id" field verbatim, in place of a server-minted one. This is a test affordance for ' +
          "seeds and scripts/race/before-order.ts ONLY (architecture.md §9) and MUST NEVER be set " +
          "in an environment reachable by real shoppers.",
        client_supplied_order_id_enabled: true,
      });
    } else {
      logger.log({
        msg: "ALLOW_CLIENT_SUPPLIED_ORDER_ID is not set; order ids are always server-minted",
        client_supplied_order_id_enabled: false,
      });
    }

    return config;
  },
};
