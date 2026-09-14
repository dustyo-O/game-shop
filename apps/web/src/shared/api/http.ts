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
 *
 * A third, from spec 005, about the *failed* response:
 *
 *   - **`HttpError.body` is `unknown` too, and reading it never throws.** A
 *     refusal may carry a JSON body worth branching on — `POST
 *     /api/orders/:id/promo` answers `409 { reason: "exhausted" }` — so the
 *     error carries whatever the body parsed to, and the slice that knows the
 *     endpoint narrows `reason` out of it (`entities/order/api`), for exactly
 *     the reason `getJson` does not narrow its own success body. What the body
 *     parses to is decided by {@link readBody}, and `readBody` is **total**: a
 *     Nest default envelope, an HTML error page from a proxy, a read that was
 *     aborted mid-stream all become `null`, and the error still surfaces as an
 *     `HttpError` carrying its status. The alternative is not hypothetical
 *     (technical-considerations R11): every failed read of the order page's
 *     poll passes through here, and if a non-JSON `404` made `readBody` throw,
 *     the `HttpError` would never be constructed, `fetchOrder`'s `instanceof`
 *     would be skipped, and «Заказ не найден» would become «Не удалось
 *     загрузить заказ». Four consumers branch on `instanceof HttpError` and
 *     `.status`; one exception leaking from this function would change the
 *     class of every one of their refusals at once.
 */

/**
 * A response that arrived but said no. Carries the status so callers can branch
 * on it, and the body — `unknown`, `null` when there was none worth having —
 * so a caller that knows its endpoint can branch on a reason as well.
 *
 * `body` defaults to `null` rather than being required, so the two throw sites
 * below and a test constructing one by hand read the same way; nothing else
 * constructs an `HttpError` (the header's grep-able claim: `new HttpError`
 * occurs in this file and nowhere else).
 */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * The failed response's body, or `null`.
 *
 * **Never throws** — see the header. `response.json()` rejects on a body that
 * is not JSON, on an empty body, and on a stream that was aborted before it
 * finished; each of those is folded into `null` here because none of them
 * changes what the caller needs to know first, which is the status. The
 * `catch` binds nothing on purpose: there is no error class to tell apart, and
 * no branch in which this function should do anything but answer `null`.
 */
async function readBody(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

/** Everything a `GET` may need beyond its path. */
export interface GetOptions {
  /**
   * Cancels a read that is no longer wanted — see {@link getJson}.
   */
  readonly signal?: AbortSignal;

  /**
   * Extra request headers, spread **after** the default `Accept` so a caller
   * could replace it, and typed as a plain record because that is what every
   * call site has.
   *
   * **This is how the operator's `Authorization: Bearer …` reaches the wire**,
   * and it is the whole of what this file knows about it. The token's value,
   * where it is kept and when it is forgotten belong to
   * `features/present-admin-token`; a transport that read a credential out of
   * storage for itself would be a transport holding an opinion about who the
   * caller is, on behalf of every endpoint. The same argument `postJson` makes
   * about `Idempotency-Key`, for the same reason.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * `GET` a JSON document.
 *
 * Throws on a non-2xx response ({@link HttpError}, carrying the status and
 * whatever the refusal's body parsed to), on an unreachable API (`fetch`
 * rejects with a `TypeError`), and on a **success** body that is not JSON. All
 * three are the same thing to a caller: the data did not arrive, show the
 * failure state. A *failed* response's unparseable body is not a fourth case —
 * {@link readBody} folds it into `null` and the `HttpError` is thrown anyway.
 *
 * **`options.signal` cancels a read that is no longer wanted.** The order
 * page's poll passes one so that a request still in flight when the page goes
 * away is aborted rather than left to resolve — `fetch` then rejects with an
 * `AbortError` (a `DOMException`), which the caller tells apart from a real
 * failure by checking `signal.aborted`. Optional because the one-shot reads in
 * this app — the catalogue, an order creation, the operator's recovery list —
 * outlive nothing.
 *
 * An options object rather than positional parameters: the second reader of
 * this function needs headers and not a signal, and
 * `getJson(path, undefined, headers)` is a call site that has to be read twice.
 */
export async function getJson(path: string, options: GetOptions = {}): Promise<unknown> {
  const response = await fetch(path, {
    headers: { Accept: "application/json", ...options.headers },
    signal: options.signal,
  });

  if (!response.ok) {
    throw new HttpError(
      `GET ${path} responded ${String(response.status)}`,
      response.status,
      await readBody(response),
    );
  }

  return (await response.json()) as unknown;
}

/**
 * `POST` a JSON document and read the JSON answer.
 *
 * Throws on exactly the same three things `getJson` does — a non-2xx response
 * ({@link HttpError}, carrying the status so a caller can tell a `422` from a
 * `500`, and the body so it can tell one `409` from another), an unreachable
 * API (`fetch` rejects with a `TypeError`), and a success body that is not
 * JSON.
 *
 * **The body is `unknown` going in as well as coming out.** The caller has
 * already decided what the endpoint accepts; this function's job is the wire
 * format, not the shape. `JSON.stringify` of a request object is the whole of
 * what it adds over `fetch`.
 *
 * **`headers` is how `Idempotency-Key` reaches the wire**, and it is the whole
 * of what this file knows about it. Phase 2's guarantee — a repeated create
 * returning the original order rather than a second one — is made by
 * `orders.client_request_id UNIQUE` at the write, and the *value* of the key is
 * decided by the feature that owns the shopper's purchase intent
 * (`features/buy-product/lib/purchase-intent.ts`). Neither decision belongs in
 * `shared/`: a transport that minted or remembered a key would be a transport
 * with an opinion about what two requests mean, and it would hold that opinion
 * for every caller of every endpoint.
 *
 * The extras are spread **after** the two defaults, so a caller can replace
 * `Accept` if it ever needs to, and are typed as a plain record because that is
 * what every call site has: `Headers` and `[string, string][]` are the other two
 * shapes `fetch` accepts and nothing here produces either.
 */
export async function postJson(
  path: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new HttpError(
      `POST ${path} responded ${String(response.status)}`,
      response.status,
      await readBody(response),
    );
  }

  return (await response.json()) as unknown;
}
