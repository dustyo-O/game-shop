// @layer: e2e
// @spec: 004-storefront-per-the-design
/**
 * The fixture every storefront e2e spec imports `test` and `expect` from
 * instead of `@playwright/test` directly.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS CAPTURES THE ORDER ID THROUGH ROUTE INTERCEPTION, NOT
 * `page.on("response")`
 * ---------------------------------------------------------------------------
 * An earlier version of this file listened for `page.on("response")` and read
 * the body with a fire-and-forget `response.json()`. That loses a real race,
 * every time «Купить» is actually pressed: `features/buy-product/ui/
 * buy-controls.ts`'s `buy()` awaits `createOrder`, which resolves the instant
 * the page's own `fetch()` gets the response, and calls
 * `window.location.assign("/order/…")` on literally the next line — no
 * `await`, no tick in between. The navigation this starts tears down the
 * document (and the network loader backing that response) before Playwright's
 * side-channel `response.json()` call — a separate CDP round trip — has a
 * chance to run. The read then rejects, the `.catch(() => {})` swallows it
 * silently, and the id is never pushed. Proven empirically: a throwaway
 * single-test repro (click «Купить», wait for `/order/ord_`, nothing else)
 * left exactly one row in `orders` after the run with the listener version,
 * and zero with the fix below — `docs/walkthrough/phase-4-slice-1-the-
 * structure.md` §6.2 carries both counts.
 *
 * `page.route(ORDERS_ROUTE_PATTERN, ...)` fixes this by capturing the body on the
 * *host* side, before the page ever sees a response to navigate on:
 *
 *   1. The page's `fetch()` reaches this route handler instead of the network.
 *   2. The handler calls `route.fetch()` itself — a real request/response,
 *      driven by Playwright, with the body already in hand as plain text.
 *   3. Only *then* does the handler call `route.fulfill()`, which is the
 *      moment the page's own `fetch()` promise resolves.
 *
 * So the id is captured in step 2, strictly before `buy()` can even begin its
 * `.then` — there is no navigation for the read to lose a race against,
 * because nothing on the page can run until this handler is done. Registered
 * before `use()`, unrouted after, so it cannot outlive the test.
 *
 * A `framenavigated` listener is kept as a belt-and-braces fallback: it reads
 * the order id straight out of the URL the shop navigates to
 * (`/order/ord_…`), which is how a response the route somehow never saw
 * (a redirect, a service worker, anything this project does not currently
 * have but a later slice might add) would still be caught. IDs from both
 * sources are deduped before cleanup, since the normal path produces the same
 * id from both.
 *
 * Teardown runs the same six statements as the API harness's
 * `cleanupTestOrders` (`./db.ts`, which names that function as its source of
 * truth) against every id this run collected. That is what lets the whole
 * project run with `workers: 1` against the one seeded database and still
 * hand the API suites back their `orders = 0` / `unclaimed = 50` baseline
 * afterwards (tech spec §4.2, risk R13 — "ids are captured ... before any
 * assertion can run").
 *
 * `trackCreatedOrders` is `auto: true`: every test gets tracking whether or
 * not it names the fixture, so a future spec cannot forget to opt in.
 * `layout.spec.ts` and `inert-controls.spec.ts` create no orders, so their
 * teardown here is the early return below — paid for once, in this file,
 * rather than as a rule every spec has to remember.
 */
import { test as base, expect, type Route } from "@playwright/test";

import { cleanupOrders, openE2eDatabase } from "./db.js";

const ORDERS_ROUTE_PATTERN = "**/api/orders";
const ORDER_URL_ID_PATTERN = /\/order\/(ord_[^/?#]+)/u;

/**
 * Reads `POST /api/orders`'s real response on the host side and re-serves it
 * unchanged, so the page behaves exactly as if this route did not exist —
 * except that by the time it sees anything, this function has already had
 * the full body in hand.
 */
async function captureOrderId(route: Route, orderIds: string[]): Promise<void> {
  if (route.request().method() !== "POST") {
    await route.continue();
    return;
  }

  const response = await route.fetch();
  const bodyText = await response.text().catch(() => "");

  if (response.status() === 200 || response.status() === 201) {
    try {
      const body: unknown = bodyText === "" ? undefined : JSON.parse(bodyText);
      if (typeof body === "object" && body !== null) {
        const { id } = body as { id?: unknown };
        if (typeof id === "string" && id !== "") orderIds.push(id);
      }
    } catch {
      // Not JSON — nothing to capture; still fulfilled below unchanged.
    }
  }

  await route.fulfill({ response, body: bodyText });
}

export const test = base.extend<{ trackCreatedOrders: void }>({
  trackCreatedOrders: [
    async ({ page }, use) => {
      const orderIds: string[] = [];

      await page.route(ORDERS_ROUTE_PATTERN, (route) => captureOrderId(route, orderIds));

      // Belt-and-braces: the id straight from the address bar, in case some
      // future path (a redirect, a service worker) reaches `/order/…`
      // without this route ever seeing the response that sent it there.
      page.on("framenavigated", (frame) => {
        if (frame !== page.mainFrame()) return;
        const match = ORDER_URL_ID_PATTERN.exec(frame.url());
        const id = match?.[1];
        if (id !== undefined && !orderIds.includes(id)) orderIds.push(id);
      });

      await use();

      await page.unroute(ORDERS_ROUTE_PATTERN);

      const uniqueOrderIds = Array.from(new Set(orderIds));
      if (uniqueOrderIds.length === 0) return;

      const client = openE2eDatabase();
      try {
        await cleanupOrders(client, uniqueOrderIds);
      } finally {
        await client.close();
      }
    },
    { auto: true },
  ],
});

export { expect };
