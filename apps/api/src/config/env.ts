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
 * The variable's value, or a refusal to continue.
 *
 * Empty is treated as absent. `scripts/with-env.ts` parses `KEY=` into an empty
 * string and Vercel's dashboard stores a cleared variable the same way, so a
 * value someone deleted arrives here as `""` rather than as `undefined` — and
 * "I removed it" and "I never set it" are the same mistake with the same fix.
 *
 * Trimmed, because an environment file and a dashboard field both collect
 * trailing whitespace that nobody typed on purpose and nobody can see.
 *
 * @param consequence What breaks if this is not set, in the operator's terms.
 *   It becomes the middle of the error message, so write it as a clause: *"the
 *   payment simulator has nowhere to deliver events"*.
 */
function readPresent(variable: string, consequence: string): string {
  const configured = process.env[variable];

  if (configured === undefined || configured.trim() === "") {
    throw new ConfigurationError(`${variable} is not set; ${consequence} (see .env.example)`);
  }

  return configured.trim();
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
