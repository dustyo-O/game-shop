// @layer: script
// @spec: 006-live-shop-and-the-written-answer
/**
 * `describeFetchError` — the one string a check records when `fetch` itself
 * threw rather than answered.
 *
 *     import { describeFetchError } from "./support/fetch-failure.ts";
 *
 *     } catch (error: unknown) {
 *       return { ok: false, status: 0, ..., error: describeFetchError(error) };
 *     }
 *
 * ---------------------------------------------------------------------------
 * WHY `error.message` ALONE LOSES THE ONLY INTERESTING PART
 * ---------------------------------------------------------------------------
 * Node's `fetch` is undici, and undici reports every transport failure as the
 * same two words — `TypeError: fetch failed` — with the real reason one level
 * down on `error.cause`:
 *
 *     TypeError: fetch failed
 *       cause: Error: connect ECONNREFUSED 127.0.0.1:65500   { code: "ECONNREFUSED" }
 *
 *     TypeError: fetch failed
 *       cause: SocketError: other side closed                { code: "UND_ERR_SOCKET" }
 *
 *     TypeError: fetch failed
 *       cause: AggregateError                                { code: "ECONNREFUSED", errors: [...] }
 *         — a dual-stack host: one error per address tried, and an EMPTY message
 *
 * During the live race runs against Vercel two of ~900 requests failed
 * client-side, every check printed `error.message`, and what reached the
 * transcript was `fetch failed` twice — indistinguishable from the shop being
 * down, from a reset socket, from a DNS blip. The cause chain is where
 * `ECONNRESET` / `UND_ERR_SOCKET` / `ETIMEDOUT` live, so the recorded detail
 * has to carry it.
 *
 * The shape: the top message, then one `(cause: <code ?? name>: <message>)`
 * per level, walking `cause` at most `MAX_CAUSE_DEPTH` deep. `code` first
 * because it is the grep-able token (`ECONNRESET`); `name` when there is none
 * (`SocketError`, `TimeoutError`). Never throws, whatever it is handed —
 * a non-`Error` becomes `String(value)`.
 */

/**
 * undici nests two deep (`TypeError: fetch failed` → `Error: <code>`); four
 * leaves room for a wrapper or two above that, and bounds the walk so a
 * self-referential `cause` can never spin it.
 */
const MAX_CAUSE_DEPTH = 4;

function readCode(error: Error): string | undefined {
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : undefined;
}

/**
 * An `AggregateError` from a dual-stack connect carries an empty `message`
 * and one error per address in `errors`; the addresses are the detail.
 */
function readMessage(error: Error): string {
  if (error.message !== "") return error.message;
  const errors: unknown = (error as { errors?: unknown }).errors;
  if (Array.isArray(errors) && errors.length > 0) {
    return errors.map((entry: unknown) => (entry instanceof Error ? entry.message : String(entry))).join("; ");
  }
  return "";
}

/**
 * `error.message`, plus `(cause: <code ?? name>: <message>)` for each level
 * of `cause` present, up to four. For anything that is not an `Error`,
 * `String(error)`.
 *
 *     fetch failed (cause: ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:65500)
 */
export function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  let detail = error.message;
  let cause: unknown = error.cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cause !== undefined && cause !== null; depth += 1) {
    if (!(cause instanceof Error)) {
      detail += ` (cause: ${String(cause)})`;
      break;
    }
    detail += ` (cause: ${readCode(cause) ?? cause.name}: ${readMessage(cause)})`;
    cause = cause.cause;
  }
  return detail;
}
