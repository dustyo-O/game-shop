/**
 * Where the suppliers are, and how long the shop will wait for them —
 * `SUPPLIER_A_URL`, `SUPPLIER_B_URL` and `SUPPLIER_TIMEOUT_MS`
 * (technical-considerations §2.7, `architecture.md` §5).
 *
 * This is the shop's side of the boundary. It is *not* part of either supplier
 * stub: `suppliers/a/` and `suppliers/b/` are the things being called and export
 * nothing on purpose (`../suppliers/a/supplier-a.module.ts`), so their addresses
 * have to be configured from outside them, the same way a real supplier's would
 * be. Putting this file under `suppliers/` would put the caller's configuration
 * inside the callee, and the first person to notice would fix it by exporting
 * the claim service.
 *
 * There is no client here, and there is deliberately no client here.
 * `../issuance/supplier.client.ts` does the calling, the parsing and the
 * classifying. What this file guarantees is that when it asks for an address and
 * a deadline, it gets values that have already been proven usable — rather than
 * strings and a `??` that turns a missing variable into a default nobody chose.
 *
 * ---------------------------------------------------------------------------
 * TWO ADDRESSES, ONE DEADLINE
 * ---------------------------------------------------------------------------
 * `SUPPLIER_TIMEOUT_MS` is deliberately **not** per supplier. The deadline is a
 * property of what the *shop* can afford to wait — it is one term in
 * `architecture.md` §5's ordered chain, and the invocation budget multiplies it
 * by the number of providers. Two independent timeouts would make that budget
 * unstateable, and there is no scenario in this system where the shop wants to
 * be more patient with the backup than with the primary.
 */
import { Logger, type Provider } from "@nestjs/common";

import { readPositiveInteger, readPositiveIntegerWithDefault, readUrl } from "./env.js";

const SUPPLIER_A_URL = "SUPPLIER_A_URL";
const SUPPLIER_B_URL = "SUPPLIER_B_URL";
const SUPPLIER_TIMEOUT_MS = "SUPPLIER_TIMEOUT_MS";
const SUPPLIER_MAX_PROBES_PER_REQUEST = "SUPPLIER_MAX_PROBES_PER_REQUEST";

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
   * One inequality holds unconditionally, because it is what makes a timeout
   * *observable* at all:
   *
   *     this timeout  <  function execution ceiling
   *     (SUPPLIER_        (the platform's, not ours)
   *      TIMEOUT_MS)
   *
   * Where the supplier's injected hang goes is **not** one fixed answer. It is
   * a choice between two scenarios that need opposite orderings, and picking
   * the wrong one is how a timeout check comes back green having exercised
   * nothing:
   *
   *   - **Slow but successful** — a short hang placed *before* the key claim:
   *
   *         hang_ms  <  SUPPLIER_TIMEOUT_MS  <  ceiling
   *
   *     No timeout occurs and none is meant to. The call completes normally and
   *     the point being made is that a slow supplier is not a failed one.
   *
   *   - **The timeout trap** — a long hang placed *after* the key claim
   *     commits, and this is the one Phase 3 exists to demonstrate:
   *
   *         SUPPLIER_TIMEOUT_MS  <  hang_ms  <  ceiling
   *
   *     A key is genuinely issued, our client gives up before hearing about it,
   *     and the re-probe on the same `request_id` gets the same code back out
   *     of the supplier's ledger (I5). What arms the trap is the **placement**
   *     of the hang — after the claim, so there is a code on file — and what
   *     makes the shop meet it at all is the **duration**, which must outlast
   *     our deadline or nothing times out.
   *
   * **This was documented backwards until Phase 3**, as `hang < timeout <
   * ceiling` for every case. Read literally it produces no timeout: the client
   * waits, the supplier answers, and the check passes without the scenario ever
   * occurring. The old text is not simply inverted — it describes the first
   * bullet while being cited as the basis for the second.
   *
   * The reasoning that supported it conflated two different events. Keeping
   * them apart is the whole of this comment:
   *
   *   - **Our client giving up.** `AbortSignal.timeout` aborts *our socket*
   *     (`../issuance/supplier.client.ts`). It does **not** stop the supplier's
   *     handler, which keeps running, can claim a key and can finish its work
   *     and write a response nobody is listening for. That is precisely what
   *     makes a timeout `unknown` rather than `failed`: the shop records the
   *     attempt as `unknown`, keeps the `request_id`, retries this supplier and
   *     refuses to fall through to the backup while the attempt is outstanding
   *     (`architecture.md` §4). The old fear — that a hang outlasting the
   *     timeout means the supplier "never got to its claim" — reads the abort
   *     as if it reached across the network and stopped the remote handler. It
   *     does not. Whether the claim happens is decided by **where the hang is
   *     placed relative to it**, not by how our deadline compares to it.
   *
   *   - **The platform killing the function.** That is the ceiling's doing, not
   *     the timeout's. The function is killed mid-flight — no exception, no
   *     `catch`, no log line, no attempt row updated — and the order is left in
   *     `delivering` with a key that may or may not have been issued, with only
   *     the admin sweep to recover it.
   *
   * That second collapse is the one to watch for, because it does not look like
   * a bug. It looks like a slow supplier, and the shop's own logs contain
   * nothing to contradict that reading. Hence the rule in one line: **a timeout
   * must always be observed as a timeout, never as a killed function.**
   *
   * Nothing enforces any of this in code, and it is worth being plain about why
   * rather than leaving it looking like an oversight. The ceiling is the
   * platform's, not ours — it is whatever Vercel gives this function on this
   * plan, it is not in the environment, and a number hardcoded here to check
   * against would be a guess that goes stale the day the plan changes, failing
   * the boot over a limit that no longer applies. `hang_ms` is not ours either:
   * it is a column on the *supplier's* `supplier_behaviour` row, set per check.
   * What exists here is the constraint, written where whoever sets either value
   * will read it — here, and in `.env.example`.
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
 * A consumer injects it by naming both the token and the type, since neither is
 * inferable from the other:
 *
 *     constructor(
 *       @Inject(SUPPLIER_A_CONFIG) private readonly supplierA: SupplierEndpointConfig,
 *     ) {}
 *
 * and then has `supplierA.baseUrl` and `supplierA.timeoutMs` with no further
 * checking to do — by the time any constructor runs, the values have already
 * been validated or the process has already exited.
 *
 * **A token per supplier rather than a map keyed by provider name.** That is the
 * decision this file made in Phase 1 and Phase 3 is where it pays: "is this
 * supplier configured?" stays a question answered at *boot*, separately for each
 * of them, instead of at lookup time for whichever one a request happened to
 * reach. A `Record<provider, config>` built from `process.env` would let the
 * shop come up with B unconfigured and only discover it at the first
 * fall-through — on a paid order, which is the worst possible moment.
 */
export const SUPPLIER_A_CONFIG = Symbol("SUPPLIER_A_CONFIG");

/**
 * Injection token for supplier B's {@link SupplierEndpointConfig} — the backup.
 *
 * The same interface with different values: a second provider, not a second
 * kind of thing. See {@link SUPPLIER_A_CONFIG} for why there are two tokens
 * rather than one map.
 */
export const SUPPLIER_B_CONFIG = Symbol("SUPPLIER_B_CONFIG");

/**
 * Read and validate one supplier's configuration.
 *
 * Called from a provider factory (`./config.module.ts`), which is what makes
 * this a startup check — see the header of `./env.ts` for why that is a
 * property of the call site rather than of the readers.
 *
 * ---------------------------------------------------------------------------
 * `readUrl`, AND WHY A `process.env` READ WITH A `??` DEFAULT IS NOT THE SAME
 * ---------------------------------------------------------------------------
 * `architecture.md` §8 and R9 both record this trap, and it is not hypothetical:
 *
 *     new URL("localhost:3000/internal/suppliers/b")   // SUCCEEDS
 *       .protocol  === "localhost:"
 *       .hostname  === ""
 *       .origin    === "null"
 *
 * A forgotten `http://` **parses**. It fails only inside `fetch`, and for
 * supplier B that means: not at boot, not on the catalogue, not on order
 * creation, but at the first fall-through — on an order somebody has already
 * paid for — where it surfaces as `fetch failed`, is classified `unknown` by the
 * client (correctly, it has no answer), and looks exactly like B being down.
 * {@link readUrl} is the one thing that catches it, by checking the *protocol*
 * rather than trusting the parse.
 *
 * Which is why both suppliers go through this function and neither is read with
 * `process.env.SUPPLIER_B_URL ?? "http://localhost:3000/…"`. A default would be
 * worse than the typo: it would make a *missing* variable indistinguishable from
 * a correct one on a laptop and silently wrong everywhere else.
 */
function readSupplierConfig(
  urlVariable: string,
  missingUrlConsequence: string,
): SupplierEndpointConfig {
  const baseUrl = readUrl(urlVariable, missingUrlConsequence);

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

/** Read and validate supplier A's configuration. */
export function readSupplierAConfig(): SupplierEndpointConfig {
  return readSupplierConfig(
    SUPPLIER_A_URL,
    "the shop has no address to request keys from and cannot deliver anything it sells",
  );
}

/**
 * Read and validate supplier B's configuration.
 *
 * The consequence sentence differs from A's because the failure differs, and
 * saying so is the point of these strings: with no `SUPPLIER_B_URL` the shop can
 * still sell — right up until supplier A refuses one order, at which point there
 * is nowhere to fall through to and a recoverable refusal becomes a delivery
 * failure. Fatal at boot for the same reason A's is: a shop that boots not
 * knowing where its backup lives looks healthy and has no backup.
 */
export function readSupplierBConfig(): SupplierEndpointConfig {
  return readSupplierConfig(
    SUPPLIER_B_URL,
    "the shop has no backup supplier to fall through to, so the first refusal from " +
      "supplier A becomes a failed delivery instead of a retry",
  );
}

/**
 * Build the boot-time provider for one supplier's configuration.
 *
 * `useFactory` with no `inject` list: Nest calls it exactly once during
 * `NestFactory.create`, and a throw from it rejects the bootstrap. Crucially, it
 * is called *whether or not anything injects the token* — which is what makes it
 * a startup guarantee rather than a lazy read. `SUPPLIER_B_CONFIG` has no
 * consumer until the retry ladder exists, and is validated at boot regardless;
 * the shop cannot come up unable to reach its backup and look healthy doing it.
 *
 * A factory-of-a-factory rather than two copies: the log line below is the one
 * a reviewer reads to confirm which addresses a running instance actually
 * resolved, and two hand-written copies of it is how B's ends up saying `a`.
 */
function supplierConfigProvider(
  token: symbol,
  supplier: string,
  read: () => SupplierEndpointConfig,
): Provider {
  return {
    provide: token,
    useFactory: (): SupplierEndpointConfig => {
      const config = read();

      // Logged at boot because the two most common supplier faults are "pointed
      // at the wrong place" and "waiting the wrong amount of time", and both are
      // answered by one line in the startup output instead of by reading the
      // environment of a running process. Safe to log: an address and a
      // duration, neither of them a credential. These are also the values a
      // reviewer wants to see when a race script is run against a deployment
      // rather than against localhost — and, for B, the line that distinguishes
      // "the backup is misconfigured" from "the backup is down", which is
      // otherwise the same `fetch failed` at the first fall-through.
      new Logger("SupplierConfig").log({
        msg: `supplier ${supplier.toUpperCase()} configured`,
        supplier,
        base_url: config.baseUrl,
        timeout_ms: config.timeoutMs,
      });

      return config;
    },
  };
}

/** Supplier A's configuration, resolved once while Nest builds its container. */
export const supplierAConfigProvider: Provider = supplierConfigProvider(
  SUPPLIER_A_CONFIG,
  "a",
  readSupplierAConfig,
);

/** Supplier B's configuration, resolved once while Nest builds its container. */
export const supplierBConfigProvider: Provider = supplierConfigProvider(
  SUPPLIER_B_CONFIG,
  "b",
  readSupplierBConfig,
);

/**
 * Injection token for {@link SupplierProbeBudgetConfig} — **how many times one
 * request id may be asked, and how long each ask may take.**
 *
 * A third token rather than two more fields on {@link SupplierEndpointConfig},
 * because neither number is a property of a supplier. `SUPPLIER_TIMEOUT_MS` is
 * already documented here as *"a property of what the shop can afford to
 * wait"*, and `SUPPLIER_MAX_PROBES_PER_REQUEST` is a property of the shop's
 * **retry policy**: it bounds `issuance-ladder.ts`'s `probe` rung, which is not
 * addressed to a supplier at all — it is addressed to one `request_id`, and the
 * whole point of that rung is that the supplier on the other end never changes.
 *
 * Hung off the two numbers together so the invocation budget in
 * technical-considerations §1.3 can be *computed* rather than assembled by a
 * caller from two injections it happened to have:
 *
 *     SUPPLIER_MAX_PROBES_PER_REQUEST × SUPPLIER_TIMEOUT_MS × |supplierLadder|
 *         +  overhead   <   function execution ceiling
 *
 * The third factor is the ladder's length and deliberately does **not** live in
 * this file: which suppliers exist is the retry policy's business
 * (`../issuance/issuance-ladder.ts`), and a copy of that list here would be a
 * second list to disagree with the first. {@link IssuanceRunnerService} holds
 * both halves and logs the product at boot.
 */
export const SUPPLIER_PROBE_BUDGET_CONFIG = Symbol("SUPPLIER_PROBE_BUDGET_CONFIG");

/**
 * **Assumption A1** (technical-considerations §1.3): one ask and two re-probes.
 *
 * The spec names no number. Three is the smallest count that distinguishes *"the
 * socket died once"* from *"this supplier is not answering"* — two would let a
 * single dropped packet settle an order as `delivery_failed` while a key sits in
 * the supplier's ledger, and a larger number multiplies straight into the
 * invocation budget above without telling anybody anything new.
 *
 * It counts **asks, not retries**: the row is born with `probe_count = 1`
 * (`../issuance/issuance-history.ts`), so this value is reached after the
 * original ask plus two probes, and the third silence is what settles the order.
 */
export const DEFAULT_SUPPLIER_MAX_PROBES_PER_REQUEST = 3;

/**
 * The two numbers the ladder's `probe` rung is bounded by.
 *
 * Both are shop-wide, both are read through `./env.ts`'s validators, and both
 * are multiplied together in a budget that no code can enforce — the third term
 * is the platform's execution ceiling, which is not in the environment and must
 * not be guessed at here (R5).
 */
export interface SupplierProbeBudgetConfig {
  /**
   * How many times one `request_id` may be asked before the shop stops asking
   * and records that the outcome was never established.
   *
   * **Not a retry count with a different name.** Every ask in this budget sends
   * the *same three arguments* to `deriveIssuanceRequestId` and therefore the
   * *same* id, so each one is the same question — *"did my earlier request
   * produce a key?"* — answered by the supplier's own ledger (I5). Asking a
   * different supplier instead is what this budget exists to make unnecessary,
   * and `issuance-ladder.ts` is what makes it unrepresentable.
   */
  readonly maxProbesPerRequest: number;

  /** `SUPPLIER_TIMEOUT_MS` — see {@link SupplierEndpointConfig.timeoutMs}, which reads the same variable. */
  readonly timeoutMs: number;
}

/**
 * Read and validate the probe budget.
 *
 * `SUPPLIER_MAX_PROBES_PER_REQUEST` is the one supplier value in this file whose
 * absence is **not** fatal, and the asymmetry is deliberate: an address and a
 * deadline name things outside this process, while the probe count is a policy
 * constant this repository chose and defended (A1). Unset means
 * {@link DEFAULT_SUPPLIER_MAX_PROBES_PER_REQUEST}; set-but-unusable still stops
 * the boot, because `readPositiveIntegerWithDefault` delegates to the same
 * checks `SUPPLIER_TIMEOUT_MS` goes through (`./env.ts`).
 */
export function readSupplierProbeBudgetConfig(): SupplierProbeBudgetConfig {
  return {
    maxProbesPerRequest: readPositiveIntegerWithDefault(
      SUPPLIER_MAX_PROBES_PER_REQUEST,
      DEFAULT_SUPPLIER_MAX_PROBES_PER_REQUEST,
      "a shop that may ask a silent supplier zero times would settle every timeout as a " +
        "delivery failure while a key sits in that supplier's ledger",
    ),
    timeoutMs: readPositiveInteger(
      SUPPLIER_TIMEOUT_MS,
      "without a deadline a hung supplier is waited on until the platform kills the function, " +
        "which is the one outcome the timeout exists to prevent",
    ),
  };
}

/**
 * The probe budget, resolved once while Nest builds its container.
 *
 * No log line of its own, unlike the two supplier providers above: the number
 * that is worth reading at boot is the **product**, and a line carrying one
 * factor of a three-factor budget invites exactly the arithmetic nobody does.
 * {@link IssuanceRunnerService}'s constructor logs the computed worst case with
 * every factor beside it, in the same startup output.
 */
export const supplierProbeBudgetConfigProvider: Provider = {
  provide: SUPPLIER_PROBE_BUDGET_CONFIG,
  useFactory: readSupplierProbeBudgetConfig,
};
