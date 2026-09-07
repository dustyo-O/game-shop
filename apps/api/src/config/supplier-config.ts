/**
 * Where supplier A is, and how long the shop will wait for it —
 * `SUPPLIER_A_URL` and `SUPPLIER_TIMEOUT_MS` (technical-considerations §2.7,
 * `architecture.md` §5).
 *
 * This is the shop's side of the boundary. It is *not* part of the supplier
 * stub: `suppliers/a/` is the thing being called and exports nothing on purpose
 * (`../suppliers/a/supplier-a.module.ts`), so its address has to be configured
 * from outside it, the same way a real supplier's would be. Putting this file
 * under `suppliers/` would put the caller's configuration inside the callee,
 * and the first person to notice would fix it by exporting the claim service.
 *
 * There is no client here, and there is deliberately no client here. Slice 5
 * builds the issuance module that does the calling, the parsing, the retrying
 * and the `deliveries` write. What this file guarantees is that when that module
 * asks for an address and a deadline, it gets two values that have already been
 * proven usable — rather than two strings and a `??` that turns a missing
 * variable into a default nobody chose.
 */
import { Logger, type Provider } from "@nestjs/common";

import { readPositiveInteger, readUrl } from "./env.js";

const SUPPLIER_A_URL = "SUPPLIER_A_URL";
const SUPPLIER_TIMEOUT_MS = "SUPPLIER_TIMEOUT_MS";

/**
 * One supplier's address and deadline.
 *
 * Named for a supplier in general rather than for A, because Phase 3 adds
 * supplier B and it is the same two facts with different values — a second
 * provider over this same interface, not a second interface.
 */
export interface SupplierEndpointConfig {
  /**
   * The supplier's base URL, with any trailing slash removed, so that
   *
   *     `${config.baseUrl}/issue`
   *
   * is the endpoint whichever way the variable was spelled. Both
   * `http://host/internal/suppliers/a` and `http://host/internal/suppliers/a/`
   * normalise to the first, and `http://host` normalises to `http://host`.
   *
   * A normalised **string**, where {@link PaymentSimulatorService} holds a
   * `URL` — because that one is a complete endpoint handed straight to `fetch`,
   * and this one is a base that a path gets appended to. The distinction is
   * worth the inconsistency: `new URL("issue", base)` is the obvious way to
   * append to a `URL` and it is wrong here, because it resolves relative to the
   * base's *parent* — `.../suppliers/a` + `issue` gives `.../suppliers/issue`,
   * a `404` that looks exactly like a supplier that is down. Handing the caller
   * a string it can only concatenate removes the trap rather than documenting
   * it.
   */
  readonly baseUrl: string;

  /**
   * How long the shop waits for a supplier response before giving up, in
   * milliseconds.
   *
   * ---------------------------------------------------------------------------
   * THE ORDERED CHAIN — `architecture.md` §5
   * ---------------------------------------------------------------------------
   * Three durations, and they must stay in this order:
   *
   *     supplier's injected hang  <  this timeout  <  function execution ceiling
   *      (Phase 3, configurable)     (SUPPLIER_        (the platform's, not ours)
   *                                   TIMEOUT_MS)
   *
   * Read left to right, each inequality buys one thing:
   *
   *   - **hang < timeout** is what makes an injected hang *survivable*. Phase 3
   *     stages the timeout trap by hanging the supplier for a while and then
   *     answering anyway; the retry that follows must find the same
   *     `request_id` already answered and get the same code back. If the hang
   *     outlasted the timeout by enough that the supplier never got to its
   *     claim, the scenario being demonstrated would not have happened — the
   *     retry would issue a first key rather than re-reading an existing one,
   *     and the ledger would never be exercised.
   *
   *   - **timeout < ceiling** is what makes a timeout *observable*. This is the
   *     load-bearing one. When our own client gives up first, the shop learns
   *     "no answer" as a value: it records the attempt as `unknown`, keeps the
   *     `request_id`, retries this supplier and refuses to fall through to the
   *     backup while the attempt is outstanding (`architecture.md` §4). When
   *     the platform's ceiling arrives first, the function is killed mid-flight
   *     — there is no exception, no `catch`, no log line, and no attempt row
   *     updated. The order is simply left in `delivering` with a key that may
   *     or may not have been issued, and the only thing that recovers it is the
   *     admin sweep.
   *
   * That second collapse is the one to watch for, because it does not look like
   * a bug. It looks like a slow supplier, and the shop's own logs contain
   * nothing to contradict that reading. Hence the rule in one line: **a timeout
   * must always be observed as a timeout, never as a killed function.**
   *
   * Nothing enforces the right-hand inequality in code, and it is worth being
   * plain about why rather than leaving it looking like an oversight. The
   * ceiling is the platform's, not ours — it is whatever Vercel gives this
   * function on this plan, it is not in the environment, and a number hardcoded
   * here to check against would be a guess that goes stale the day the plan
   * changes, failing the boot over a limit that no longer applies. The left-hand
   * inequality has nothing to compare against yet either: the hang is Phase 3's
   * knob and does not exist. What exists now is the constraint, written where
   * whoever sets either value will read it — here, and in `.env.example`.
   */
  readonly timeoutMs: number;
}

/**
 * Injection token for supplier A's {@link SupplierEndpointConfig}.
 *
 * A symbol, matching `DATABASE_CLIENT` (`../database/database.module.ts`) and
 * for the same reason: tokens share one flat namespace per application and a
 * symbol cannot collide with one a library picked.
 *
 * Slice 5's issuance service injects it by naming both the token and the type,
 * since neither is inferable from the other:
 *
 *     constructor(
 *       @Inject(SUPPLIER_A_CONFIG) private readonly supplierA: SupplierEndpointConfig,
 *     ) {}
 *
 * and then has `supplierA.baseUrl` and `supplierA.timeoutMs` with no further
 * checking to do — by the time any constructor runs, the values have already
 * been validated or the process has already exited.
 *
 * A token per supplier rather than a map keyed by provider name: Phase 3's
 * supplier B gets `SUPPLIER_B_CONFIG` over this same interface, which keeps the
 * "is this supplier configured?" question answered at boot for each of them
 * separately instead of at lookup time for whichever one a request happened to
 * reach.
 */
export const SUPPLIER_A_CONFIG = Symbol("SUPPLIER_A_CONFIG");

/**
 * Read and validate supplier A's configuration.
 *
 * Called from a provider factory (`./config.module.ts`), which is what makes
 * this a startup check — see the header of `./env.ts` for why that is a
 * property of the call site rather than of the readers.
 */
export function readSupplierAConfig(): SupplierEndpointConfig {
  const baseUrl = readUrl(
    SUPPLIER_A_URL,
    "the shop has no address to request keys from and cannot deliver anything it sells",
  );

  const timeoutMs = readPositiveInteger(
    SUPPLIER_TIMEOUT_MS,
    "without a deadline a hung supplier is waited on until the platform kills the function, " +
      "which is the one outcome the timeout exists to prevent",
  );

  return {
    // `href` rather than the original string, so the value is whatever the URL
    // parser agreed it meant. `new URL("http://host")` has an `href` of
    // `"http://host/"`, which the strip below turns back into `"http://host"` —
    // so a bare origin and a path-carrying base come out of here in the same
    // shape and `${baseUrl}/issue` is correct for both.
    baseUrl: baseUrl.href.replace(/\/+$/, ""),
    timeoutMs,
  };
}

/**
 * Supplier A's configuration, resolved once while Nest builds its container.
 *
 * `useFactory` with no `inject` list: Nest calls it exactly once during
 * `NestFactory.create`, and a throw from it rejects the bootstrap. Crucially,
 * it is called *whether or not anything injects the token* — which is the whole
 * point today, because nothing does until Slice 5. The configuration is
 * therefore already proven usable before the first issuance client exists to
 * prove it with.
 */
export const supplierAConfigProvider: Provider = {
  provide: SUPPLIER_A_CONFIG,
  useFactory: (): SupplierEndpointConfig => {
    const config = readSupplierAConfig();

    // Logged at boot because the two most common supplier faults are "pointed
    // at the wrong place" and "waiting the wrong amount of time", and both are
    // answered by one line in the startup output instead of by reading the
    // environment of a running process. Safe to log: an address and a duration,
    // neither of them a credential. `SUPPLIER_A_URL` is also the one value a
    // reviewer wants to see when a race script is run against a deployment
    // rather than against localhost.
    new Logger("SupplierConfig").log({
      msg: "supplier A configured",
      supplier: "a",
      base_url: config.baseUrl,
      timeout_ms: config.timeoutMs,
    });

    return config;
  },
};
