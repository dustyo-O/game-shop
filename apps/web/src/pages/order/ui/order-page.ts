/**
 * The order page at `/order/:id` — what was bought, what it costs, where the
 * order is, the key once the shop has handed it over, and the controls that pay
 * for it (functional spec §2.2, §2.3, §2.4 and §2.6,
 * technical-considerations §2.6).
 *
 * Built like the catalogue page and for the same reason: the element is returned
 * **synchronously** and filled in when the request lands. An `async` factory the
 * caller awaits leaves the document blank until the API answers — a white page
 * on a slow connection, an indefinitely white one if the API is down. Here the
 * shopper sees «Загрузка заказа…» immediately and it is replaced in place,
 * whichever way the request goes.
 *
 * ---------------------------------------------------------------------------
 * THE PAGE MOVES BY ITSELF
 * ---------------------------------------------------------------------------
 * A paid order goes `created → paid → delivering → delivered` in the shop, in
 * under a second, with nobody pressing anything. Functional spec §2.4 asks that
 * the shopper see each of those *"without the shopper reloading"*, so the page
 * reads `GET /api/orders/:id` once a second for as long as the order is still
 * moving and stops the moment it settles.
 *
 * **What "settled" means is not decided here.** `isSettledOrderStatus` comes
 * from `@game-shop/contracts`, which classifies every status as in-flight or
 * settled and fails to compile if a new one is left out. Restating «delivered,
 * payment_failed, out_of_stock» in this file would be the third copy of that
 * list, and the one nobody would remember to update when Phase 3 adds
 * `delivery_failed` — a page polling a dead order forever.
 *
 * The loop itself is `../model/poll.js`; that file explains why the next read is
 * chained off the end of the previous one rather than run on an interval.
 */
import { isSettledOrderStatus, type OrderStatus } from "@game-shop/contracts";

import {
  fetchOrder,
  OrderNotFoundError,
  renderOrderDetails,
  type Order,
} from "../../../entities/order/index.js";
import { createPaymentControls, type PaymentControls } from "../../../features/simulate-payment/index.js";
import { createElement } from "../../../shared/lib/dom.js";
import { createPoll, PollDecision, type Poll } from "../model/poll.js";

/** Technical-considerations §2.6: *"polls `GET /api/orders/:id` every second"*. */
const pollIntervalMs = 1000;

const noticeClass = "order__notice";

/**
 * Every word this page shows a shopper, in Russian — including the states
 * nobody plans for (functional spec §2.8 covers "any message shown to them",
 * which is exactly where an English "Failed to load" normally survives review).
 *
 * `notFound` and `error` are two messages rather than one because they are two
 * different situations and call for two different actions. An order that does
 * not exist will not start existing on a refresh — the address is wrong, and the
 * shopper needs to go and find the right one. An API that did not answer is
 * temporary. A single «Что-то пошло не так» would send half the shoppers who
 * read it in the wrong direction.
 *
 * Neither of the two failure sentences tells the shopper to reload, and that is
 * a change of fact rather than of tone: the page is already retrying once a
 * second, so it recovers on its own when the shop comes back. Telling someone to
 * refresh a page that is refreshing itself invites them to interrupt it.
 *
 * `offline` is the *second* kind of failure — one that arrives when there is
 * already a real order on screen. It says the same thing as `error` without
 * throwing away what the shopper is looking at.
 *
 * The payment controls' own wording is not here: it belongs to
 * `features/simulate-payment`, which owns the behaviour it describes.
 */
const text = {
  title: "Заказ",
  loading: "Загрузка заказа…",
  notFound: "Заказ не найден. Проверьте адрес страницы.",
  error: "Не удалось загрузить заказ. Проверьте соединение — страница обновится сама.",
  offline: "Связь с магазином потеряна. Страница обновится сама, как только связь появится.",
} as const;

function renderStatus(message: string, modifier: string): HTMLParagraphElement {
  return createElement("p", {
    className: `order__status order__status--${modifier}`,
    text: message,
    attributes: { role: "status" },
  });
}

/**
 * The connection notice, which sits *under* an order that is already on screen
 * rather than replacing it.
 *
 * `role="status"` and not `alert`: nothing was lost, the page is retrying, and a
 * screen reader should mention it politely rather than interrupt.
 */
function renderNotice(message: string): HTMLParagraphElement {
  return createElement("p", {
    className: noticeClass,
    text: message,
    attributes: { role: "status", "data-order-notice": "offline" },
  });
}

/**
 * The parts of an order that can change while a shopper is looking at it.
 *
 * Everything else — the product, the amount, the id — is fixed at creation, so
 * these two are the whole of "has anything happened?". See
 * {@link createOrderPage}'s `showOrder` for why that question is asked at all.
 */
interface RenderedOrder {
  readonly status: OrderStatus;
  readonly code: string | null;
}

/** Build the order page for `orderId`, start reading the order, and keep it current. */
export function createOrderPage(orderId: string): HTMLElement {
  const content = createElement("div", { className: "order__content" }, [
    renderStatus(text.loading, "loading"),
  ]);

  /** The last order actually painted, or `null` while the page shows a message instead. */
  let rendered: RenderedOrder | null = null;

  /**
   * Paint the order — but only if it is not the one already on screen.
   *
   * **The poll must not redraw a page that has not changed.** A `created` order
   * is in flight, so it is read once a second while the shopper decides; if each
   * read replaced the content region, it would replace the payment controls too
   * — wiping the disabled state of a button whose request is still open, any
   * Russian failure sentence under it, and the focus ring of whoever was
   * navigating by keyboard, once a second, forever.
   *
   * Comparing the two mutable fields costs nothing and makes the poll invisible
   * until something actually happens, at which point the whole region is
   * replaced at once.
   */
  function showOrder(order: Order): void {
    content.querySelector(`.${noticeClass}`)?.remove();

    if (rendered !== null && rendered.status === order.status && rendered.code === order.code) {
      return;
    }

    rendered = { status: order.status, code: order.code };

    /**
     * The page does not decide whether payment controls are offered — it asks
     * the feature, which answers from the order it was just handed and returns
     * `null` when there is nothing to show. That keeps "an order awaiting
     * payment gets two controls, a failed one gets a sentence, a paid one gets
     * neither" in the one file that can also explain why hiding them is only
     * cosmetic.
     */
    const paymentArea = payment.render(order);

    content.replaceChildren(
      ...(paymentArea === null
        ? [renderOrderDetails(order)]
        : [renderOrderDetails(order), paymentArea]),
    );
  }

  /** A final answer: this address identifies nothing, and retrying will not change that. */
  function showNotFound(): void {
    rendered = null;
    content.replaceChildren(renderStatus(text.notFound, "not-found"));
  }

  /**
   * The API did not answer — unreachable, a `500`, a body that is not an order.
   *
   * Two shapes, because there are two situations. With nothing on screen yet
   * there is nothing to protect and the message takes the whole region. With a
   * real order already painted, **it stays**: an order the shopper can still read
   * is worth more than a fresh apology, so the page keeps it and adds a line
   * saying it is retrying. Either way the poll keeps going and clears up after
   * itself on the next successful read.
   *
   * Both branches are idempotent, so a shop that is down for a minute produces
   * one message and sixty quiet retries rather than sixty redraws.
   */
  function showFailure(): void {
    if (rendered === null) {
      if (content.querySelector(".order__status--error") === null) {
        content.replaceChildren(renderStatus(text.error, "error"));
      }

      return;
    }

    if (content.querySelector(`.${noticeClass}`) === null) {
      content.append(renderNotice(text.offline));
    }
  }

  /**
   * One read of the order, and the decision about whether to read it again.
   *
   * Called immediately when the page is built and once a second after that. Four
   * outcomes:
   *
   *   - **The order arrived.** Paint it if it changed, then stop iff it has
   *     settled — `delivered`, `payment_failed` or `out_of_stock`, as
   *     `@game-shop/contracts` classifies them.
   *   - **The read was aborted.** The poll is shutting down, so the page is on
   *     its way out. Paint nothing: the only thing worse than a stale screen is
   *     a stale screen drawn on the way to a different page.
   *   - **`404`.** The one failure that will not fix itself. Say so and stop —
   *     an order that does not exist will not start existing a second later, and
   *     polling it forever is exactly the leak this page is careful about.
   *   - **Anything else.** Say the connection went, keep everything that was on
   *     screen, and keep reading.
   *
   * The `isConnected` check is what stops a poll that has outlived its page
   * without the document unloading — a route swap replacing the mount point's
   * children, say. It is asked *after* the read rather than before because on
   * the very first one the element is still being built and has not been
   * mounted yet.
   */
  async function readOrder(signal: AbortSignal): Promise<PollDecision> {
    try {
      const order = await fetchOrder(orderId, signal);

      showOrder(order);

      return isSettledOrderStatus(order.status) || !content.isConnected
        ? PollDecision.Stop
        : PollDecision.Continue;
    } catch (error: unknown) {
      if (signal.aborted) {
        return PollDecision.Stop;
      }

      if (error instanceof OrderNotFoundError) {
        showNotFound();

        return PollDecision.Stop;
      }

      showFailure();

      return content.isConnected ? PollDecision.Continue : PollDecision.Stop;
    }
  }

  /**
   * The payment area, built once and re-rendered from every order this page
   * reads.
   *
   * The type annotations on both this and `poll` are load-bearing rather than
   * decoration: each closes over the other — the controls ask the poll to read
   * now, the poll's read asks the controls what to render — and without them
   * TypeScript refuses the circular inference. Neither closure runs before both
   * bindings exist: one waits for a click, the other for a request to land.
   *
   * **What pressing pay does to the poll**, and why the callback is not an
   * optimisation. Structurally it changes nothing: the loop is already running,
   * because a `created` order is in flight and this page polls every order that
   * is. What it changes is *which states the shopper ever sees*.
   *
   * Phase 2 moved payment processing off the webhook's response path, so `paid`
   * and `delivering` are now real persisted states rather than steps inside one
   * request — but they are still **short**. Measured locally against the
   * loopback supplier stub, the whole run from the webhook's `200` to
   * `delivered` takes 25–65ms. A one-second poll started from a cold page will
   * essentially never land inside that.
   *
   * `refreshNow` is what does. It fires the moment the simulator's request
   * resolves — which is the moment the webhook answered, ~10ms in — so its read
   * lands *inside* the window and catches whichever of «Оплачен, готовим ключ»
   * or «Выдаём ключ» is current. The next read is then a whole interval away,
   * which is what holds that intermediate state on screen for a readable second
   * rather than a frame.
   *
   * So this callback is load-bearing for functional spec §2.5, not a way of
   * saving the shopper a second. Removing it does not cost a tick — it collapses
   * the sequence straight from «Ожидает оплаты» to «Ключ выдан», which is
   * exactly the Phase 1 behaviour that forced spec 001 §2.4 to be reworded.
   * Verified by disabling it: three runs, no intermediate state in any of them;
   * three runs with it restored, an intermediate state in all three.
   */
  const payment: PaymentControls = createPaymentControls({
    orderId,
    onOrderMayHaveChanged: () => {
      poll.refreshNow();
    },
  });

  const poll: Poll = createPoll({ intervalMs: pollIntervalMs, run: readOrder });

  const page = createElement("section", { className: "order" }, [
    createElement("h1", { className: "order__title", text: text.title }),
    content,
  ]);

  poll.start();

  return page;
}
