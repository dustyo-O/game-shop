// @layer: unit
// @spec: 005-promo-codes-with-enforced-limits
// @regression
/**
 * The order parser's `promo` field, and `applyPromo`'s status-to-error mapping
 * (technical-considerations §2.4, "Entity"; R11).
 *
 * `toOrder` is private to `order-api.ts` — deliberately, so no page can build an
 * `Order` from a body the parser never saw — which is why this file reaches it
 * through `fetchOrder` and `applyPromo` with `fetch` stubbed rather than calling
 * it directly. The stub answers with a real `Response`, so `response.ok`,
 * `response.status` and `response.json()` behave exactly as the browser's
 * would; nothing here is a mock of the transport's *behaviour*, only of the
 * network under it. `environment: "node"` (see `vitest.config.ts`) has both
 * `fetch` and `Response` as globals.
 *
 * ---------------------------------------------------------------------------
 * THE CASES THIS FILE EXISTS FOR
 * ---------------------------------------------------------------------------
 * *"`promo: null` and an absent `promo` both read as `null`."* The wire always
 * carries the field (`OrderViewCore.promo` is `AppliedPromoView | null`), and a
 * page that has to ask `order.promo === undefined` as well as `=== null` is a
 * page one branch away from rendering «Промокод» with nothing after it. The
 * RED for this file is exactly that: before `readPromo` exists, `toOrder`
 * simply does not set the field, and `toBe(null)` fails on `undefined`.
 *
 * *"A `409` with a non-JSON body still maps."* Every failed read of the order
 * page's poll passes through `readBody`; if a body that is not JSON made it
 * throw, the `HttpError` would never be constructed and the `instanceof` that
 * turns a `404` into «Заказ не найден» would be skipped (R11). The case here
 * asserts the promo mapping survives an HTML `409`, which is the same guard from
 * the other side: `readBody` yielded `null`, `readReason` yielded `null`, and
 * the caller still got a *typed* refusal rather than a generic failure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyPromo,
  fetchOrder,
  OrderNotFoundError,
  OrderResponseError,
  PromoCodeExhaustedError,
  PromoCodeUnknownError,
  PromoNotApplicableError,
} from "./order-api.js";

/**
 * `GET /api/orders/:id`'s body for a fresh 1 290 ₽ order — every field the
 * wire always sends, **minus `promo`**, so the absent-key case is a fixture in
 * its own right rather than a `delete` on a copy.
 */
const createdWithoutPromo = {
  id: "ord_01J0000000000000000000TEST",
  sku: "KEY-CS2-PRIME",
  product_name: "CS2 Prime Status ключ",
  amount_minor: 129000,
  currency: "RUB",
  status: "created",
  code: null,
} as const;

const created = { ...createdWithoutPromo, promo: null } as const;

/** `LIMIT3` on the order above: 25 % of 129 000 is 32 250, to pay 96 750. */
const limit3Applied = {
  ...createdWithoutPromo,
  amount_minor: 96750,
  promo: { code: "LIMIT3", discount_minor: 32250, list_amount_minor: 129000 },
} as const;

/**
 * A `Response` the way the API would have sent it: a JSON body under a JSON
 * content type. A factory, not a value — a `Response` body is a stream and
 * can be read once, so a test that calls `fetchOrder` twice (once for the
 * class, once for the message) needs a fresh one each time, exactly as a
 * browser would get.
 */
function jsonResponse(status: number, body: unknown): () => Response {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

/**
 * Answer every `fetch` with a fresh `Response` from `respond`, and hand back
 * the spy so a test can read what was sent. `vi.stubGlobal` is undone in
 * `afterEach` below.
 */
function stubFetch(respond: () => Response): ReturnType<typeof vi.fn> {
  const spy = vi.fn(() => Promise.resolve(respond()));
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchOrder — the wire's `promo` becomes Order.promo", () => {
  it("promo: null reads as null — the field the wire sends until a code is applied", async () => {
    stubFetch(jsonResponse(200, created));

    const order = await fetchOrder(created.id);

    expect(order.promo).toBe(null);
  });

  it("an absent promo reads as null too — one shape for the page, not two", async () => {
    stubFetch(jsonResponse(200, createdWithoutPromo));

    const order = await fetchOrder(createdWithoutPromo.id);

    expect(order.promo).toBe(null);
  });

  it("a valid promo carries the three fields, kopecks under the branded names and the snake_case gone", async () => {
    stubFetch(jsonResponse(200, limit3Applied));

    const order = await fetchOrder(limit3Applied.id);

    expect(order.promo).toEqual({ code: "LIMIT3", discountMinor: 32250, listAmountMinor: 129000 });
    expect(order.amountMinor).toBe(96750);
  });

  it("a string where the object belongs throws OrderResponseError naming order.promo", async () => {
    stubFetch(jsonResponse(200, { ...createdWithoutPromo, promo: "LIMIT3" }));

    await expect(fetchOrder(createdWithoutPromo.id)).rejects.toThrow(OrderResponseError);
    await expect(fetchOrder(createdWithoutPromo.id)).rejects.toThrow(/^order\.promo/);
  });

  it("a promo without discount_minor throws, naming the missing field", async () => {
    stubFetch(
      jsonResponse(200, {
        ...createdWithoutPromo,
        promo: { code: "LIMIT3", list_amount_minor: 129000 },
      }),
    );

    await expect(fetchOrder(createdWithoutPromo.id)).rejects.toThrow(OrderResponseError);
    await expect(fetchOrder(createdWithoutPromo.id)).rejects.toThrow(/^order\.promo\.discount_minor/);
  });

  it("an empty code throws — a redemption with no code is a body that contradicts itself", async () => {
    stubFetch(
      jsonResponse(200, {
        ...limit3Applied,
        promo: { ...limit3Applied.promo, code: "" },
      }),
    );

    await expect(fetchOrder(limit3Applied.id)).rejects.toThrow(/^order\.promo\.code/);
  });
});

describe("applyPromo — POST /api/orders/:id/promo, and its refusals as typed errors", () => {
  it("sends { code } to the order's promo route and answers the parsed order", async () => {
    const spy = stubFetch(jsonResponse(200, limit3Applied));

    const order = await applyPromo(limit3Applied.id, "limit3");

    expect(spy).toHaveBeenCalledTimes(1);
    const [path, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(path).toBe(`/api/orders/${limit3Applied.id}/promo`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ code: "limit3" });
    expect(order.promo).toEqual({ code: "LIMIT3", discountMinor: 32250, listAmountMinor: 129000 });
  });

  it("422 → PromoCodeUnknownError", async () => {
    stubFetch(jsonResponse(422, { reason: "unknown_code" }));

    await expect(applyPromo(created.id, "nope")).rejects.toThrow(PromoCodeUnknownError);
  });

  it("409 + { reason: 'exhausted' } → PromoCodeExhaustedError", async () => {
    stubFetch(jsonResponse(409, { reason: "exhausted" }));

    await expect(applyPromo(created.id, "ONCEONLY")).rejects.toThrow(PromoCodeExhaustedError);
  });

  it("409 + { reason: 'another_code_applied' } → PromoNotApplicableError carrying that reason", async () => {
    stubFetch(jsonResponse(409, { reason: "another_code_applied" }));

    const failure = await applyPromo(created.id, "GG500").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PromoNotApplicableError);
    expect((failure as PromoNotApplicableError).reason).toBe("another_code_applied");
  });

  it("404 → OrderNotFoundError — the same class fetchOrder throws, one fact whichever endpoint reports it", async () => {
    stubFetch(jsonResponse(404, { statusCode: 404, message: 'no order with id "ord_bogus"', error: "Not Found" }));

    await expect(applyPromo("ord_bogus", "LIMIT3")).rejects.toThrow(OrderNotFoundError);
  });

  it("409 with a non-JSON body → PromoNotApplicableError('unknown') — readBody never throws (R11)", async () => {
    stubFetch(() => new Response("<html><body>Conflict</body></html>", { status: 409 }));

    const failure = await applyPromo(created.id, "LIMIT3").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PromoNotApplicableError);
    expect((failure as PromoNotApplicableError).reason).toBe("unknown");
  });

  it("any other refusal is rethrown as it came — a 500 is not a promo verdict", async () => {
    stubFetch(jsonResponse(500, { statusCode: 500, message: "Internal server error" }));

    const failure = await applyPromo(created.id, "LIMIT3").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PromoNotApplicableError);
    expect(failure).not.toBeInstanceOf(PromoCodeUnknownError);
    expect((failure as { status?: unknown }).status).toBe(500);
  });
});
