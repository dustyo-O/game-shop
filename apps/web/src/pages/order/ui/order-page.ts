/**
 * The order page at `/order/:id` — what was bought, what it costs, where the
 * order is, the key once the shop has handed it over, the promo-code field
 * while it still awaits payment, and the controls that pay for it (functional
 * spec §2.2, §2.3, §2.4 and §2.6, technical-considerations §2.6; spec 005 §2.2
 * for the field).
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
 * reads `GET /api/orders/:id` once a second for as long as the order is in
 * flight.
 *
 * **Where it stops is not "settled" — it is "terminal".** Spec 003 split the
 * question the page asks after each read into two, because the two sets of
 * states that used to answer it the same way no longer do
 * (technical-considerations §9.1, R10):
 *
 *   - `delivered`, `payment_failed` — **terminal**, `isTerminalOrderStatus`.
 *     Nothing can ever move them, by any path. The page stops.
 *   - `out_of_stock`, `delivery_failed` — **recoverable**,
 *     `isRecoverableOrderStatus`. Nothing moves them *by itself*, but an
 *     operator does (`POST /api/admin/orders/:id/retry`), and functional spec
 *     §2.6 promises the shopper their key appears *"without them taking any
 *     action"*. So the page keeps reading — every five seconds rather than every
 *     one, since it is waiting on a person, not a worker — and **snaps back to a
 *     second the moment a read shows the order moving again**, so the retry's
 *     own `delivering → delivered` is watched at the same beat as the original
 *     purchase and spec 002 §2.5's visible stages are not quietly lost.
 *   - Anything else is in flight and read once a second, as before.
 *
 * Stopping on `isSettledOrderStatus` — terminal ∪ recoverable — was the previous
 * rule, and it is the trap: it compiles, ships, keeps every check green, and
 * leaves the shopper looking at «Ключей сейчас нет в наличии» while the operator's
 * retry delivers a key the page will never read.
 *
 * Both classifications come from `@game-shop/contracts`, which puts every status
 * in exactly one set and fails to compile if a new one is left out. Restating
 * the strings in this file would be the copy nobody updates.
 *
 * The reading of a recoverable order is bounded (assumption A9): after five
 * minutes the page stops and says so. That is the one message on this page
 * that does tell the shopper to reload, and correctly — a page that has
 * stopped refreshing itself should not claim otherwise.
 *
 * The loop itself is `../model/poll.js`; that file explains why the next read is
 * chained off the end of the previous one rather than run on an interval, and
 * why changing the interval from inside a read is safe.
 */
import { isRecoverableOrderStatus, isTerminalOrderStatus, type OrderStatus } from "@game-shop/contracts";

import {
  fetchOrder,
  OrderNotFoundError,
  renderOrderDetails,
  renderOrderRecoveryNotice,
  type Order,
} from "../../../entities/order/index.js";
import { createPromoForm, type PromoForm } from "../../../features/apply-promo/index.js";
import { createPaymentControls, type PaymentControls } from "../../../features/simulate-payment/index.js";
import { createElement } from "../../../shared/lib/dom.js";
import { createPoll, PollDecision, type Poll } from "../model/poll.js";

/** Technical-considerations §2.6: *"polls `GET /api/orders/:id` every second"* — while the order is in flight. */
const inFlightIntervalMs = 1000;

/**
 * Spec 003 technical-considerations §9.1: a recoverable order is read every
 * five seconds. It is waiting on an operator, and a person takes minutes, not
 * milliseconds — five times fewer reads for a wait that is five orders of
 * magnitude longer. The cost of each is small regardless: a settled order's
 * read is answered from the order row alone, with no drain and no index probe.
 */
const recoverableIntervalMs = 5000;

/**
 * Assumption A9: how long the page keeps reading a recoverable order before it
 * stops and says so. Measured from the first read that found the order
 * recoverable, and reset whenever a read finds it moving again.
 */
const recoverableWatchWindowMs = 5 * 60 * 1000;

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
 * `stopped` is the one sentence here that *does* tell the shopper to reload,
 * and the rule above is why it may: it is shown only once the page has stopped
 * reading the order (assumption A9 — five minutes of watching a recoverable
 * order), at which point «страница обновится сама» would be a lie and asking
 * them to refresh is the honest instruction.
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
  stopped: "Страница перестала обновляться автоматически. Обновите её, чтобы увидеть текущее состояние заказа.",
} as const;

function renderStatus(message: string, modifier: string): HTMLParagraphElement {
  return createElement("p", {
    className: `order__status order__status--${modifier}`,
    text: message,
    attributes: { role: "status" },
  });
}

/**
 * What a notice under the order is about — the value of its `data-order-notice`
 * handle, which is what a check reads to tell the two apart.
 */
type NoticeKind = "offline" | "stopped";

/**
 * A notice that sits *under* an order that is already on screen rather than
 * replacing it: the connection has gone, or the page has stopped watching.
 *
 * `role="status"` and not `alert`: nothing was lost, and a screen reader should
 * mention it politely rather than interrupt.
 */
function renderNotice(message: string, kind: NoticeKind): HTMLParagraphElement {
  return createElement("p", {
    className: noticeClass,
    text: message,
    attributes: { role: "status", "data-order-notice": kind },
  });
}

/**
 * The parts of an order that can change while a shopper is looking at it —
 * the memo `showOrder` compares before it repaints anything.
 *
 * Everything else — the product, the id — is fixed at creation, and the amount
 * moves only when the promo does, so these three are the whole of "has
 * anything happened?". See {@link createOrderPage}'s
 * `showOrder` for why that question is asked at all.
 *
 * **`promoCode` is load-bearing, and forgetting it fails silently.** Since spec
 * 005 an order awaiting payment can gain a promo code — and with it a new
 * amount — without its status moving: `created` before, `created` after, no
 * key either way. The promo form does not paint the applied code itself; it
 * asks the poll to re-read the order and relies on *this* comparison to notice
 * the difference (spec 005 technical-considerations §2.4, "the repaint rule";
 * R12). Without `promoCode` here, the sequence is: the `POST` succeeds, the
 * refresh returns the promo, the memo sees `created === created` and
 * `null === null`, and returns early. The form stays disabled forever, the
 * amount stays at the list price, no «Промокод» row appears — until a reload
 * builds the page from nothing, at which point everything looks right, so a
 * manual check that reloads "proves" it works. The amount is deliberately
 * *not* a fourth field: it changes only when the promo does, and one witness
 * is enough. The e2e's first test (apply by Enter, row appears, URL unchanged)
 * is the guard, and dropping this field is its RED.
 */
interface RenderedOrder {
  readonly status: OrderStatus;
  readonly code: string | null;
  /** The applied promo code, or `null` — `order.promo?.code`, the one field of the promo that identifies it. */
  readonly promoCode: string | null;
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
   * Comparing the three mutable fields costs nothing and makes the poll
   * invisible until something actually happens, at which point the whole region
   * is replaced at once. The same memo is what keeps a shopper's half-typed
   * promo code in its field while the order is read once a second under it —
   * and, through `promoCode`, what notices the moment that code has been
   * applied (see {@link RenderedOrder}).
   */
  function showOrder(order: Order): void {
    content.querySelector(`.${noticeClass}`)?.remove();

    const promoCode = order.promo?.code ?? null;

    if (
      rendered !== null &&
      rendered.status === order.status &&
      rendered.code === order.code &&
      rendered.promoCode === promoCode
    ) {
      return;
    }

    rendered = { status: order.status, code: order.code, promoCode };

    /**
     * The page does not decide whether payment controls are offered — it asks
     * the feature, which answers from the order it was just handed and returns
     * `null` when there is nothing to show. That keeps "an order awaiting
     * payment gets two controls, a failed one gets a sentence, a paid one gets
     * neither" in the one file that can also explain why hiding them is only
     * cosmetic.
     */
    const paymentArea = payment.render(order);

    /**
     * Likewise the promo field: the feature answers from the order — a field
     * only while it is `created` with no code on it, `null` otherwise — and the
     * page only asks. Once a code is applied, the entity's «Промокод» row in
     * the details above is what stands in the field's place (spec 005 §2.2).
     */
    const promoArea = promo.render(order);

    /**
     * What the shop is doing about an order it could not deliver (functional
     * spec §2.3), or `null` for the orders that need no explanation. The entity
     * decides both, exactly as it decides whether a key row exists — the page
     * only asks.
     *
     * **It is composed inside this same `replaceChildren`, on purpose.** Drawn
     * anywhere else it would land after the memo's early return, so the
     * explanation would be re-created once a second under a shopper reading it,
     * restarting its `role="status"` announcement each time. Built here it is
     * painted exactly when the status it explains changes, and the poll stays
     * invisible.
     *
     * Its class is `order-recovery`, not `order__notice`, and that is
     * load-bearing rather than cosmetic: `showOrder` opens by removing
     * `.order__notice` — the *offline* notice — from the content region on every
     * single read. Sharing the class would have this paragraph deleted a second
     * after it appeared and never redrawn, because the memo would by then be
     * reporting no change.
     */
    const recoveryNotice = renderOrderRecoveryNotice(order);

    // Details, recovery notice, promo form, then payment controls — the field
    // sits above the buttons (spec 005 §2.2's first criterion), and the form
    // and the buttons are siblings here, never nested, so Enter in the field
    // can reach only the form's own submit button.
    content.replaceChildren(
      ...[renderOrderDetails(order), recoveryNotice, promoArea, paymentArea].filter(
        (part): part is HTMLElement => part !== null,
      ),
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
      content.append(renderNotice(text.offline, "offline"));
    }
  }

  /**
   * The watch window has run out (assumption A9). The order stays on screen —
   * it is still what the shopper came for — and a line under it says the page
   * is no longer keeping it current.
   *
   * Appended after the final read painted, and nothing removes it: `showOrder`
   * clears `.order__notice` on every read, but there are no more reads.
   */
  function showStoppedWatching(): void {
    content.append(renderNotice(text.stopped, "stopped"));
  }

  /**
   * When the page first found the order in a recoverable state, on the
   * monotonic clock, or `null` while it is not in one. The A9 window is measured
   * from here.
   */
  let recoverableSince: number | null = null;

  /**
   * The three-way split from spec 003 technical-considerations §9.1, applied to
   * an order that has just been painted. This is the whole of the stop
   * condition, and the order of the questions is the point:
   *
   *   - **Terminal** (`delivered`, `payment_failed`) — stop. Nothing can move
   *     it, so a further read can only ever return the same answer.
   *   - **Recoverable** (`out_of_stock`, `delivery_failed`) — keep reading,
   *     every five seconds, for up to the A9 window. An operator's retry is the
   *     only thing that moves it, and the shopper is promised they will see it
   *     land (functional spec §2.6).
   *   - **In flight** — every second, as for a fresh purchase, and this branch
   *     is also the **snap-back**: a recoverable order that a read now shows as
   *     `delivering` has been picked up by a retry, and the retry runs
   *     `delivering → delivered` in the same 25–65 ms the original issuance
   *     did. Left at five seconds, the page would hold «Выдаём ключ» for up to
   *     five seconds after the key existed, and would miss the state entirely
   *     unless the read happened to land inside it. Back at one second, the
   *     recovery is watched exactly as spec 002 §2.5 asks the first attempt to
   *     be.
   *
   * Unclassified statuses fall to the in-flight branch — the same default
   * `isSettledOrderStatus` had — but `@game-shop/contracts` refuses to compile
   * with an unclassified status, so none reaches here.
   */
  function decideNextRead(status: OrderStatus): PollDecision {
    if (isTerminalOrderStatus(status)) {
      return PollDecision.Stop;
    }

    if (!isRecoverableOrderStatus(status)) {
      recoverableSince = null;
      poll.setIntervalMs(inFlightIntervalMs);

      return PollDecision.Continue;
    }

    const now = performance.now();
    recoverableSince ??= now;

    if (now - recoverableSince >= recoverableWatchWindowMs) {
      showStoppedWatching();

      return PollDecision.Stop;
    }

    poll.setIntervalMs(recoverableIntervalMs);

    return PollDecision.Continue;
  }

  /**
   * One read of the order, and the decision about whether to read it again.
   *
   * Called immediately when the page is built and after every quiet interval
   * since. Four outcomes:
   *
   *   - **The order arrived.** Paint it if it changed, then let
   *     `decideNextRead` answer from the status: stop on a terminal one
   *     (`delivered`, `payment_failed`), read a recoverable one (`out_of_stock`,
   *     `delivery_failed`) every five seconds, read anything else every second
   *     — as `@game-shop/contracts` classifies them.
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

      return content.isConnected ? decideNextRead(order.status) : PollDecision.Stop;
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

  /**
   * The promo field, built once and re-rendered from every order this page
   * reads — the same shape and the same circular closure as `payment` above,
   * hence the same load-bearing annotation.
   *
   * Its callback is the same `refreshNow`, and here it is not about catching
   * a short-lived state but about **who paints the applied code**: the feature
   * does not, on purpose (its header says why), so this read is the only way
   * the row, the new amount and the field's disappearance reach the screen —
   * through `showOrder`'s memo, which is why {@link RenderedOrder} carries
   * `promoCode`. `refreshNow` queues behind an in-flight read rather than
   * overlapping it, so a scheduled read that left before the promo committed
   * lands first, is suppressed, and the refresh paints the row without flicker.
   */
  const promo: PromoForm = createPromoForm({
    orderId,
    onOrderMayHaveChanged: () => {
      poll.refreshNow();
    },
  });

  const poll: Poll = createPoll({ intervalMs: inFlightIntervalMs, run: readOrder });

  const page = createElement("section", { className: "order" }, [
    createElement("h1", { className: "order__title", text: text.title }),
    content,
  ]);

  poll.start();

  return page;
}
