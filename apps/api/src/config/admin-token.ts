/**
 * `ADMIN_TOKEN` — the single shared bearer token that stands in front of the
 * admin surface (`architecture.md` §6, *"a single shared bearer token for the
 * admin panel, which is the assignment's stated minimum"*;
 * technical-considerations §2.5).
 *
 * This is the shop's side of an operator's boundary, and it sits here beside
 * `./supplier-config.ts` for the same reason that one does: a value read out of
 * the environment is checked once, while Nest builds the container, and every
 * consumer downstream receives something that has already been proven usable
 * rather than a string and a `??`.
 *
 * Today there is exactly one consumer — `../admin/admin-token.guard.ts`, in
 * front of the payment-event sweep. Phase 3's admin panel (the
 * paid-but-undelivered list and its manual retry) is the second, and it wants
 * the same token behind the same guard, which is why the reading of it is here
 * and not inside the guard.
 *
 * ###########################################################################
 * # AN UNSET TOKEN DISABLES THE ENDPOINT. IT NEVER OPENS IT.
 * ###########################################################################
 *
 * The one failure mode that must be impossible is the familiar one: a missing
 * credential quietly meaning *no credential required*. Every path in this file
 * and in the guard is written so that the **only** way a request is admitted is
 * a configured token that a caller matched. {@link AdminTokenConfig} is a
 * discriminated union rather than a `string | undefined` precisely so that the
 * compiler will not let the guard reach `digest` without having asked whether
 * there is one; there is no branch in which "unconfigured" and "matched" are
 * the same shape.
 *
 * What an unset token *does* cost is stated where the decision is made
 * (`./env.ts`, {@link readOptionalSecret}): the sweep is one of four layered
 * triggers, so losing it loses a backstop rather than an order, and refusing to
 * boot over it would take the catalogue, order creation and the webhook down
 * with it. So: boot, log at `error`, and answer `503` at the door.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CONFIG CARRIES A DIGEST AND NOT THE TOKEN
 * ---------------------------------------------------------------------------
 * The guard compares with `timingSafeEqual`, which requires two buffers of
 * equal length and throws on a mismatch — so a raw-string comparison would have
 * to be length-checked first, and that length check is itself an early-exit
 * that leaks how long the real token is. Hashing both sides to a fixed 32 bytes
 * removes the question: every comparison is over the same number of bytes
 * whatever was presented, and the only thing that varies is whether they match.
 *
 * Keeping the plaintext out of the DI container is a second, smaller benefit.
 * It is not a security boundary — the value is still in `process.env` — but a
 * heap dump or an accidental `JSON.stringify` of an injected config is one
 * fewer place the token appears.
 */
import { createHash } from "node:crypto";

import { Logger, type Provider } from "@nestjs/common";

import { readOptionalSecret } from "./env.js";

const ADMIN_TOKEN = "ADMIN_TOKEN";

/**
 * The shortest value this shop will accept as a shared secret.
 *
 * Sixteen characters is not a cryptographic claim; it is the line under which a
 * value is obviously not a secret — `admin`, `test`, `password`, a SKU somebody
 * pasted by mistake. A real one is generated (`openssl rand -hex 32` is what
 * `.env.example` suggests) and is far longer, so this floor only ever fires on
 * a mistake, which is exactly what a startup check is for.
 */
const MIN_ADMIN_TOKEN_LENGTH = 16;

/**
 * Whether there is an admin token, and if so what it hashes to.
 *
 * A discriminated union over `configured`, per the project's TypeScript
 * conventions and for the reason in the header: the guard cannot read a digest
 * without first proving one exists, so "no token" cannot silently take the
 * "token matched" branch.
 */
export type AdminTokenConfig =
  | {
      readonly configured: true;
      /** SHA-256 of the configured token, 32 bytes. See the header. */
      readonly digest: Buffer;
    }
  | { readonly configured: false };

/**
 * Injection token for the {@link AdminTokenConfig}.
 *
 * A symbol, matching `DATABASE_CLIENT`, `SUPPLIER_A_CONFIG` and
 * `CONTINUATION_SCHEDULER`: tokens share one flat namespace per application and
 * a symbol cannot collide with one a library picked.
 */
export const ADMIN_TOKEN_CONFIG = Symbol("ADMIN_TOKEN_CONFIG");

/** SHA-256 as a 32-byte buffer. One line, named, so both sides of the comparison provably agree. */
export function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

/**
 * Read and validate the admin token.
 *
 * Called from a provider factory below, which is what makes this a startup
 * check — a property of the call site rather than of this function (`./env.ts`,
 * *"AT STARTUP IS A PROPERTY OF WHERE THESE ARE CALLED"*). A token that is
 * present but too short throws from here and rejects `NestFactory.create`; a
 * token that is absent returns `{ configured: false }` and the boot continues.
 */
export function readAdminTokenConfig(): AdminTokenConfig {
  const token = readOptionalSecret(ADMIN_TOKEN, MIN_ADMIN_TOKEN_LENGTH);

  if (token === undefined) return { configured: false };

  return { configured: true, digest: digestToken(token) };
}

/**
 * The admin token, resolved once while Nest builds its container.
 *
 * `useFactory` with no `inject` list, as `supplierAConfigProvider` is: Nest
 * calls it exactly once during `NestFactory.create`, whether or not anything
 * injects the token.
 *
 * ### The `error` line is the whole of the "loud" half
 *
 * An operator who has not configured the token learns it from one line in the
 * startup output, naming the variable and the consequence — not from a `503`
 * discovered during the incident the sweep exists to clear up. `error` rather
 * than `warn` for the same reason `SchedulingModule` uses `error` for a missing
 * `waitUntil`: it is not fatal, and it is also not something anybody should
 * scroll past.
 *
 * The configured branch logs the *fact*, never the token and never the digest.
 * A digest of a shared secret is a hash of a guessable-length string and there
 * is no reason to publish it; the only thing an operator needs from this line
 * is "yes, it is set", which is exactly what a `false` here would have them
 * chasing.
 */
export const adminTokenConfigProvider: Provider = {
  provide: ADMIN_TOKEN_CONFIG,
  useFactory: (): AdminTokenConfig => {
    const config = readAdminTokenConfig();
    const logger = new Logger("AdminTokenConfig");

    if (config.configured) {
      logger.log({
        msg: "admin token configured; the admin surface is available",
        admin_token_configured: true,
      });
    } else {
      // Names every route behind the guard, not just the first one. The list
      // grows with `AdminModule`, and a boot warning that still names only the
      // sweep would tell an operator the recovery list was merely broken.
      logger.error({
        msg:
          "ADMIN_TOKEN is not set; the whole admin surface is DISABLED and answers 503 — " +
          "the payment-event sweep and the paid-but-undelivered recovery list. " +
          "The shop still delivers, but two things are gone: the backstop for events the " +
          "other three processing triggers miss (architecture.md §4), and the only screen " +
          "that shows an order that was paid for and never delivered (spec 003 §2.4). " +
          "Set ADMIN_TOKEN (see .env.example) to enable them.",
        admin_token_configured: false,
      });
    }

    return config;
  },
};
