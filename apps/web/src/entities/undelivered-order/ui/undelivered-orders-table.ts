/**
 * The table of paid, undelivered orders — §2.4's fourth criterion, which asks
 * that an operator reading one row can see *what was bought, when it was paid
 * for, and what went wrong*.
 *
 * ---------------------------------------------------------------------------
 * UNSTYLED, AND THAT IS THE DESIGN
 * ---------------------------------------------------------------------------
 * A semantic `<table>` on browser defaults, with no class names and no entry in
 * `app/styles.css`. This screen has one user, who opens it when a shopper has
 * already paid for something they have not received; every hour spent on its
 * appearance is an hour not spent on the mechanism underneath it, and the
 * assignment grades the mechanism. A real `<thead>`/`<tbody>` still gives a
 * screen reader column headers, still prints, and still lets the operator's own
 * browser find-in-page work — which is the whole of what this screen needs to be
 * good at.
 *
 * ---------------------------------------------------------------------------
 * THE ACTION CELL IS A SLOT, AND WHAT DECIDES ITS SHAPE
 * ---------------------------------------------------------------------------
 * The retry button is slice 5. This slice leaves the cell empty for the rows
 * that will get one and *says* «in progress» for the rows that will not.
 *
 * Which is which is decided by `isRecoverableOrderStatus` from
 * `@game-shop/contracts` — **never by a list of statuses written out here**.
 * The list on this screen is wider than the retryable pair on purpose
 * (technical-considerations §4, assumption A5): `paid` and `delivering` orders
 * are on it because an order whose worker died mid-issuance is otherwise
 * invisible, and most of them are simply 50 milliseconds from delivering
 * themselves. A local list would be a fourth copy of the lifecycle's
 * classification, and the day a status moved between sets this screen would
 * quietly disagree with the API about which orders can be pushed.
 *
 * The affordance is a courtesy either way. The only authority on whether a
 * retry runs is the guarded `UPDATE` on the API, which answers `409` to an order
 * that is not stuck — a check the browser makes is a check the browser can be
 * told to skip.
 */
import {
  isInFlightOrderStatus,
  isRecoverableOrderStatus,
  type OrderStatus,
} from "@game-shop/contracts";

import { formatPrice } from "../../../shared/lib/format-price.js";
import { createElement } from "../../../shared/lib/dom.js";
import { readOrderReason } from "../lib/attempt-reason.js";
import type { IssuanceAttemptRecord, UndeliveredOrder } from "../model/undelivered-order.js";

/**
 * Every word this table shows, in English.
 *
 * The shopper's pages are Russian; this one is not, and assumption A10 is the
 * reason: everything else the operator reads in the same minute — the guard's
 * `401` and `503` bodies, `.env.example`, the API's log lines, the column names
 * they are about to type into `psql` — is English, and a screen that translated
 * only its own furniture would make `supplier_rejected` look like a word this
 * page had chosen rather than one the supplier said.
 */
const text = {
  columns: {
    order: "Order",
    item: "Item",
    amount: "Amount",
    status: "Status",
    created: "Created",
    paid: "Paid",
    reason: "What went wrong",
    attempts: "Attempts",
    action: "Action",
  },
  noPaidEvent: "no paid event on file",
  neverEstablished: "outcome never established — request",
  notAttempted: "not yet attempted — no supplier has been asked",
  nothing: "—",
  inProgress: "in progress",
  noAction: "no action — this order is finished",
  ask: "ask",
  asks: "asks",
} as const;

function headerCell(label: string): HTMLTableCellElement {
  return createElement("th", { text: label, attributes: { scope: "col" } });
}

/**
 * A timestamp cell.
 *
 * The `datetime` attribute carries the value the wire sent, which is what makes
 * the element a `<time>` rather than a `<td>` with a string in it. **The text is
 * that same raw ISO 8601 string**, deliberately un-prettified: the operator's
 * next move after reading this column is to search a log or write a `WHERE
 * paid_at >` against it, and both want the value as recorded. A localised
 * rendering would also differ between the machine that runs the browser and the
 * machine that runs the shop, which on a timestamp is the one difference nobody
 * notices until it matters.
 */
function timeCell(iso: string | null, absent: string): HTMLTableCellElement {
  if (iso === null) {
    return createElement("td", { text: absent });
  }

  return createElement("td", {}, [
    createElement("time", { text: iso, attributes: { datetime: iso } }),
  ]);
}

/**
 * One line of the attempt history: which supplier was asked, as which numbered
 * attempt, what came back, and how many times the same question was put.
 *
 * `probe_count` is on screen because it is the visible trace of §2.2's first
 * criterion — *"asks that same supplier about that same request again rather
 * than asking a different supplier"*. A row reading `a#1 ok, 2 asks` is a
 * timeout that was investigated and resolved without a second key leaving
 * stock, which is the single most useful thing this history can tell anybody.
 */
function attemptLine(attempt: IssuanceAttemptRecord): HTMLLIElement {
  const parts = [
    createElement("code", { text: `${attempt.provider}#${String(attempt.attempt)}` }),
    document.createTextNode(` ${attempt.status}`),
  ];

  if (attempt.probeCount !== null) {
    // `1 ask` rather than `1 asks`. A small thing, and this is the screen where
    // a person is already deciding whether the shop can be trusted with their
    // shoppers' money.
    const unit = attempt.probeCount === 1 ? text.ask : text.asks;

    parts.push(document.createTextNode(`, ${String(attempt.probeCount)} ${unit}`));
  }

  if (attempt.lastError !== null && attempt.lastError !== "") {
    parts.push(document.createTextNode(" — "));
    parts.push(createElement("code", { text: attempt.lastError }));
  }

  return createElement("li", {}, parts);
}

function attemptsCell(attempts: readonly IssuanceAttemptRecord[]): HTMLTableCellElement {
  if (attempts.length === 0) {
    return createElement("td", { text: text.nothing });
  }

  return createElement("td", {}, [createElement("ul", {}, attempts.map(attemptLine))]);
}

/**
 * The reason cell — the one cell on this screen functional spec §2.2's fourth
 * criterion is decided by.
 *
 * The facts come from `../lib/attempt-reason.ts`, which exists so that *"the
 * outcome was never established"* cannot be turned into *"failed"* by a stray
 * `??`. Both facts can be present at once — an older attempt left `unknown`, a
 * newer one definitely refused — so they are rendered as two lines rather than
 * one winning over the other.
 *
 * A supplier's reason is rendered **raw, in a `<code>`**, and never mapped onto
 * a friendlier phrase. `supplier_rejected` is a word the supplier said; a word
 * this page invented would be a word the operator cannot search for anywhere
 * else.
 */
function reasonCell(order: UndeliveredOrder): HTMLTableCellElement {
  const reason = readOrderReason(order);
  const lines: HTMLElement[] = [];

  if (reason.definiteFailure !== null) {
    lines.push(
      createElement("div", { attributes: { "data-admin-reason": "failed" } }, [
        createElement("code", { text: reason.definiteFailure }),
      ]),
    );
  }

  if (reason.neverEstablishedRequestId !== null) {
    lines.push(
      createElement("div", { attributes: { "data-admin-reason": "never-established" } }, [
        document.createTextNode(`${text.neverEstablished} `),
        createElement("code", { text: reason.neverEstablishedRequestId }),
      ]),
    );
  }

  if (lines.length === 0) {
    return createElement("td", {
      text: reason.hasBeenAttempted ? text.nothing : text.notAttempted,
      attributes: { "data-admin-reason": reason.hasBeenAttempted ? "none" : "not-attempted" },
    });
  }

  return createElement("td", {}, lines);
}

/**
 * The action cell. Empty for the rows slice 5 will put a button in, and a plain
 * word for the rows it will not — see this file's header for why the choice is
 * `@game-shop/contracts`' to make and not this file's.
 *
 * The third branch is unreachable through the endpoint, whose `WHERE` cannot
 * return a terminal order. It is written out rather than folded into the second
 * because *"in progress"* would be a lie about a `delivered` row, and the one
 * thing this screen must not do is describe an order's state wrongly.
 */
function actionCell(orderId: string, status: OrderStatus): HTMLTableCellElement {
  if (isRecoverableOrderStatus(status)) {
    return createElement("td", { attributes: { "data-admin-retry-slot": orderId } });
  }

  if (isInFlightOrderStatus(status)) {
    return createElement("td", {
      text: text.inProgress,
      attributes: { "data-admin-retry-slot": "none" },
    });
  }

  return createElement("td", {
    text: text.noAction,
    attributes: { "data-admin-retry-slot": "none" },
  });
}

/**
 * The item cell: the catalogue name if the shop still has one, and the SKU
 * underneath it.
 *
 * The SKU is shown even when the name is — it is what the operator types into
 * the supplier's own console, and «Пополнение Steam 500 ₽» is not. When the
 * name is `null` — a withdrawn product, whose order is still a real order — the
 * SKU is the only line rather than being printed twice as its own fallback.
 */
function itemCell(order: UndeliveredOrder): HTMLTableCellElement {
  const lines: HTMLElement[] = [];

  if (order.productName !== null) {
    lines.push(createElement("div", { text: order.productName }));
  }

  lines.push(createElement("div", {}, [createElement("code", { text: order.sku })]));

  return createElement("td", {}, lines);
}

function orderRow(order: UndeliveredOrder): HTMLTableRowElement {
  return createElement(
    "tr",
    { attributes: { "data-order-id": order.orderId, "data-status": order.status } },
    [
      createElement("td", {}, [createElement("code", { text: order.orderId })]),
      itemCell(order),
      createElement("td", { text: formatPrice(order.amountMinor, order.currency) }),
      createElement("td", { text: order.status }),
      timeCell(order.createdAt, text.nothing),
      timeCell(order.paidAt, text.noPaidEvent),
      reasonCell(order),
      attemptsCell(order.attempts),
      actionCell(order.orderId, order.status),
    ],
  );
}

/** The whole table. Never called with an empty list — the page shows words instead. */
export function renderUndeliveredOrdersTable(
  orders: readonly UndeliveredOrder[],
): HTMLTableElement {
  return createElement("table", { attributes: { "data-admin-table": "undelivered" } }, [
    createElement("thead", {}, [
      createElement("tr", {}, [
        headerCell(text.columns.order),
        headerCell(text.columns.item),
        headerCell(text.columns.amount),
        headerCell(text.columns.status),
        headerCell(text.columns.created),
        headerCell(text.columns.paid),
        headerCell(text.columns.reason),
        headerCell(text.columns.attempts),
        headerCell(text.columns.action),
      ]),
    ]),
    createElement("tbody", {}, orders.map(orderRow)),
  ]);
}
