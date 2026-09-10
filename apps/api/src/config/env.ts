/**
 * Reading configuration out of the environment — the two shapes this API needs,
 * in one place.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE THROW INSTEAD OF DEFAULTING
 * ---------------------------------------------------------------------------
 * Every value read through this file names something *outside* the process: an
 * address, or a deadline measured against a platform limit. Neither has a
 * default that is right in both development and deployment, and both fail in
 * the same expensive way when they are wrong — the API comes up, reports
 * healthy, serves the catalogue, and cannot complete the one transaction it
 * exists for. That failure is discovered by a shopper, at the worst moment, and
 * it looks like a bug rather than like a missing line in an environment.
 *
 * `main.ts` reads `API_PORT` with a default and that is not an inconsistency: a
 * wrong port announces itself the instant anything tries to connect. A wrong
 * supplier URL announces itself only once a payment has already been taken.
 *
 * ---------------------------------------------------------------------------
 * "AT STARTUP" IS A PROPERTY OF *WHERE THESE ARE CALLED*, NOT OF THIS FILE
 * ---------------------------------------------------------------------------
 * Nothing here can make a check happen at boot. These are ordinary functions;
 * they run when someone calls them. What makes the check a *startup* check is
 * that the call sites are provider factories and constructors of default-scoped
 * providers, which Nest instantiates eagerly while building the DI container —
 * before `app.listen()`, and whether or not anything injects them. A throw at
 * that moment rejects `NestFactory.create`, and the process exits non-zero
 * without ever binding the port.
 *
 * The corollary is the thing to be careful about: move one of these calls into
 * a method body, or give its provider `Scope.REQUEST`, and the check silently
 * relocates to first use. Nothing would fail; the guarantee would simply be
 * gone, and the first sign of it would be a `500` on a real order. Call these
 * from construction, always.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * `PaymentSimulatorService` had the URL reader inline first, and
 * {@link readSupplierAConfig} wanted the same one two files later. Two copies of
 * a validation rule drift — one of them grows a scheme check, the other does
 * not, and which variable gets the better error becomes an accident of
 * authorship. One copy, two call sites, and the message shape is identical
 * whichever variable is wrong.
 */

/**
 * A configuration value that is missing or unusable.
 *
 * A distinct class rather than a bare `Error` for one reason, and it is a
 * reason about *reading a crash log*: this failure arrives wrapped in Nest's DI
 * stack trace, ten frames of `Injector.instantiateClass` deep, and the name on
 * the first line is the only part an operator reads before deciding what kind
 * of problem they have. `ConfigurationError` says "your environment", which is
 * a five-second fix. `Error` says "their code", which is an hour.
 *
 * Nothing catches it. It is thrown to stop the boot, and stopping the boot is
 * the entire behaviour.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** Decimal digits, optional sign. See {@link readPositiveInteger}. */
const DECIMAL_INTEGER = /^-?[0-9]+$/;

/**
 * The variable's trimmed value, or `undefined` if it is absent **or empty**.
 *
 * Empty is treated as absent. `scripts/with-env.ts` parses `KEY=` into an empty
 * string and Vercel's dashboard stores a cleared variable the same way, so a
 * value someone deleted arrives here as `""` rather than as `undefined` — and
 * "I removed it" and "I never set it" are the same mistake with the same fix.
 *
 * Trimmed, because an environment file and a dashboard field both collect
 * trailing whitespace that nobody typed on purpose and nobody can see.
 *
 * The one shape shared by every reader below, including the optional one — so
 * "what counts as set?" has a single answer whether the absence is fatal or
 * not.
 */
function readTrimmed(variable: string): string | undefined {
  const configured = process.env[variable];

  if (configured === undefined || configured.trim() === "") return undefined;

  return configured.trim();
}

/**
 * The variable's value, or a refusal to continue.
 *
 * @param consequence What breaks if this is not set, in the operator's terms.
 *   It becomes the middle of the error message, so write it as a clause: *"the
 *   payment simulator has nowhere to deliver events"*.
 */
function readPresent(variable: string, consequence: string): string {
  const configured = readTrimmed(variable);

  if (configured === undefined) {
    throw new ConfigurationError(`${variable} is not set; ${consequence} (see .env.example)`);
  }

  return configured;
}

/**
 * An address this process will hand to `fetch`.
 *
 * Two checks, and the second is the one that earns its keep. `new URL()` alone
 * accepts `mailto:someone@example.com` and `wat://nonsense` — both are
 * syntactically valid URLs and neither is something `fetch` can send a POST to.
 * A scheme check at boot turns that into a refusal to start; without it the
 * same typo becomes a `TypeError` from `fetch` on the first real order, which
 * is a runtime failure wearing the costume of a network problem.
 *
 * The parsed value is returned rather than the string, so a caller that wants
 * `.origin` or `.pathname` does not re-parse and cannot disagree with this
 * function about what the string meant.
 */
export function readUrl(variable: string, consequence: string): URL {
  const configured = readPresent(variable, consequence);

  let parsed: URL;

  try {
    parsed = new URL(configured);
  } catch {
    throw new ConfigurationError(`${variable} is not a valid URL: "${configured}"`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigurationError(
      `${variable} must be an http: or https: URL, not "${configured}" (scheme "${parsed.protocol}")`,
    );
  }

  return parsed;
}

/**
 * A count or a duration: a whole number greater than zero.
 *
 * ---------------------------------------------------------------------------
 * WHY THE REGEX, WHEN `Number()` WOULD "WORK"
 * ---------------------------------------------------------------------------
 * Because `Number()` succeeds on things nobody meant:
 *
 *   - `Number("2e3")`   → 2000. An exponent in a milliseconds field is far more
 *                         likely a typo than a plan.
 *   - `Number("0x7d0")` → 2000. Same.
 *   - `Number("")`      → 0. Caught earlier by {@link readPresent}, and a
 *                         reminder of how quietly this function type fails.
 *   - `Number("2000ms")`→ NaN, which at least fails — but only because the unit
 *                         was spelled out, not because anything checked.
 *
 * Each of those is a *silent coercion*: a value that parses to a number the
 * author did not write. The task this file was built for is a timeout that must
 * sit inside an ordered chain of three durations, and a timeout that is
 * secretly a different number than the one in the environment file makes that
 * chain unverifiable by reading. So: digits, then a range check, then a value.
 *
 * The sign is allowed through the pattern on purpose, so that `-1` reaches the
 * range check and is told it must be greater than zero, rather than being told
 * it is not a number — which it plainly is.
 */
export function readPositiveInteger(variable: string, consequence: string): number {
  const configured = readPresent(variable, consequence);

  if (!DECIMAL_INTEGER.test(configured)) {
    throw new ConfigurationError(
      `${variable} must be a whole number written in decimal digits, not "${configured}"`,
    );
  }

  const parsed = Number(configured);

  // A digit string long enough to lose precision. `Number("9007199254740993")`
  // is 9007199254740992, and a value that is not the value that was written is
  // exactly what this function refuses to produce.
  if (!Number.isSafeInteger(parsed)) {
    throw new ConfigurationError(
      `${variable} is too large to be represented exactly: "${configured}"`,
    );
  }

  if (parsed <= 0) {
    throw new ConfigurationError(
      `${variable} must be greater than zero, not ${String(parsed)}; ${consequence}`,
    );
  }

  return parsed;
}

/**
 * A shared secret that the process can legitimately run **without** — the third
 * shape, and the only one whose absence is not fatal.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONE DOES NOT THROW ON ABSENCE, WHEN THE OTHER TWO DO
 * ---------------------------------------------------------------------------
 * `readUrl` and {@link readPositiveInteger} guard the path a *shopper* is on:
 * without them the shop comes up healthy and cannot complete the one
 * transaction it exists for, so refusing to boot is strictly cheaper than the
 * alternative. Nothing of the kind is true of a credential for an operator's
 * endpoint. The four processing triggers are layered *"so no single one is
 * load-bearing"* (`architecture.md` §4), so an unconfigured admin token costs
 * one backstop, not one order — and refusing to boot over it would convert a
 * degraded backstop into a total outage of the catalogue, order creation and
 * the webhook, none of which the missing variable has anything to do with.
 *
 * That is not a new judgement in this codebase; it is the one
 * `SchedulingModule` already makes when it finds itself on Vercel with no
 * `waitUntil`: *"It is not fatal, because the other three triggers in
 * `architecture.md` §4 still complete every order"*. Loud, and not fatal. The
 * caller is responsible for the "loud" half and for **failing closed** — see
 * `./admin-token.ts`.
 *
 * ### Present but too short *is* fatal, and the asymmetry is deliberate
 *
 * An absent variable is the state of a fresh clone and of the window in the
 * middle of a rotation; both must leave the shop serving. A two-character
 * token is neither. It is an attempt to have the endpoint that does not work —
 * a door someone asked to lock, fitted with a lock that opens to a guess — and
 * unlike absence it does not fail closed. So it stops the boot, in the same
 * spirit as {@link readPositiveInteger} refusing `"2e3"`: a value that would
 * "work" is not the same as the value the author meant.
 *
 * @param minimumLength The shortest value that is a secret rather than a
 *   password. Whatever it is, it must be the caller's decision and it must be
 *   checked here, at startup, and not at the first request that presents one.
 */
export function readOptionalSecret(variable: string, minimumLength: number): string | undefined {
  const configured = readTrimmed(variable);

  if (configured === undefined) return undefined;

  if (configured.length < minimumLength) {
    throw new ConfigurationError(
      `${variable} is set but is only ${String(configured.length)} characters; a shared secret ` +
        `must be at least ${String(minimumLength)}. Unset it entirely to disable the endpoints ` +
        `it protects, which fail closed — a short token does not (see .env.example)`,
    );
  }

  return configured;
}

/**
 * A boolean switch — the fourth shape, and the only one where *absence itself*
 * is the safe default rather than a thing to report.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONE MUST NEVER THROW ON ABSENCE, WHEN {@link readOptionalSecret}
 * ABOVE ALSO DOES NOT — AND WHY IT STILL THROWS ON EVERYTHING BUT TWO EXACT
 * STRINGS
 * ---------------------------------------------------------------------------
 * `readOptionalSecret` is unset in the *ordinary* run of this shop — a fresh
 * clone, a rotation window — and its absence still costs something (a backstop
 * goes dark) worth a boot-time log line. A flag read through this function is
 * different again: for its one caller today (`./client-supplied-order-id.ts`)
 * the unset state is not a degraded mode of the ordinary shop, it *is* the
 * ordinary shop, and nothing about reading it should look like a warning
 * waiting to be explained. So unlike every other reader in this file, this one
 * must not throw on the case that is expected on every developer's laptop and
 * every real deployment: nothing set at all.
 *
 * What does not relax is the "silent coercion" stance {@link
 * readPositiveInteger} already takes with `"2e3"`. A boolean has exactly two
 * spellings that mean what they say; every other candidate — `"1"`, `"0"`,
 * `"TRUE"`, `"yes"`, `"on"` — is a value that *some* parser somewhere would
 * accept, which is precisely the trap this file exists to catch: a value that
 * would silently coerce to something the author did not write. So: unset is
 * `false` and free, `"true"`/`"false"` are `true`/`false` exactly, and anything
 * else is a refusal to guess what the author meant.
 */
export function readBooleanFlag(variable: string): boolean {
  const configured = readTrimmed(variable);

  if (configured === undefined) return false;
  if (configured === "true") return true;
  if (configured === "false") return false;

  throw new ConfigurationError(
    `${variable} must be exactly "true" or "false" when set, not "${configured}"`,
  );
}
