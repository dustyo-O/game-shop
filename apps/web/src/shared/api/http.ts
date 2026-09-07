/**
 * The one place the browser talks to the API.
 *
 * Two decisions worth naming:
 *
 *   - **Relative paths only.** The browser calls `/api/products`, never an
 *     absolute base. In development the Vite proxy forwards it (see
 *     `vite.config.ts`); in deployment a Vercel rewrite does. No API host is
 *     ever baked into the bundle, and there is no CORS in development that
 *     production would not also have.
 *   - **It returns `unknown`, not `T`.** A generic `getJson<T>()` is a type
 *     assertion wearing a nicer hat: it promises the caller a shape that
 *     nothing has checked. Handing back `unknown` pushes the narrowing into the
 *     slice that actually knows what the endpoint promised — which is where the
 *     `entities/product` parser lives.
 */

/** A response that arrived but said no. Carries the status so callers can branch on it. */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * `GET` a JSON document.
 *
 * Throws on a non-2xx response ({@link HttpError}), on an unreachable API
 * (`fetch` rejects with a `TypeError`), and on a body that is not JSON. All
 * three are the same thing to a caller: the data did not arrive, show the
 * failure state.
 *
 * **`signal` cancels a read that is no longer wanted.** The order page's poll
 * passes one so that a request still in flight when the page goes away is
 * aborted rather than left to resolve — `fetch` then rejects with an
 * `AbortError` (a `DOMException`), which the caller tells apart from a real
 * failure by checking `signal.aborted`. Optional because the two one-shot reads
 * in this app — the catalogue and an order creation — outlive nothing.
 */
export async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { headers: { Accept: "application/json" }, signal });

  if (!response.ok) {
    throw new HttpError(`GET ${path} responded ${String(response.status)}`, response.status);
  }

  return (await response.json()) as unknown;
}

/**
 * `POST` a JSON document and read the JSON answer.
 *
 * Throws on exactly the same three things `getJson` does — a non-2xx response
 * ({@link HttpError}, carrying the status so a caller can tell a `422` from a
 * `500`), an unreachable API (`fetch` rejects with a `TypeError`), and a body
 * that is not JSON.
 *
 * **The body is `unknown` going in as well as coming out.** The caller has
 * already decided what the endpoint accepts; this function's job is the wire
 * format, not the shape. `JSON.stringify` of a request object is the whole of
 * what it adds over `fetch`.
 *
 * **No `Idempotency-Key` header.** Phase 2 adds one here, paired with
 * `orders.client_request_id UNIQUE`, and that pair — not anything in this file
 * and not any state held in the page — is what will make a repeated create
 * return the original order instead of a second one. Named now so the omission
 * is a deferral on the roadmap rather than something nobody noticed.
 */
export async function postJson(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new HttpError(`POST ${path} responded ${String(response.status)}`, response.status);
  }

  return (await response.json()) as unknown;
}
