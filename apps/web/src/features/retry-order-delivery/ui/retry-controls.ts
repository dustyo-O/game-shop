/**
 * The Retry button, its per-row busy state, and the running account of what
 * every press came to.
 *
 * ---------------------------------------------------------------------------
 * PER-ROW BUSY STATE, NEVER GLOBAL
 * ---------------------------------------------------------------------------
 * The easy version disables the table — one `inFlight` flag, one `disabled`
 * pass over every button — and it is wrong in a way that only hurts during the
 * incident this screen exists for. Two stuck orders can be retried at once:
 * they are different rows, different suppliers, different locks. A global flag
 * serialises the operator's work behind the slowest supplier call for no
 * mechanical reason at all. So the busy set is keyed by order id, and a button
 * is disabled only while *its own* order is in flight.
 *
 * ---------------------------------------------------------------------------
 * THE DOUBLE-PRESS GUARD IS A COURTESY, NOT THE PROTECTION
 * ---------------------------------------------------------------------------
 * `button.disabled` and the `busy.has(orderId)` check below stop one operator
 * double-clicking one button in one tab. That is a usability nicety and nothing
 * more. §2.5's fourth criterion is **two operators on two machines**, and no
 * state in this module is shared with the other machine — there is no client
 * guard that could address it, in this design or any other.
 *
 * What actually makes the second press harmless is server-side and unchanged by
 * anything here: the order row `FOR UPDATE` lock, the guarded UPDATE that moves
 * the order (zero rows matched = somebody else already claimed it), the
 * `deliveries.order_id UNIQUE` constraint, and the supplier's request ledger
 * that answers a repeated `request_id` with the code it already issued.
 * **Delete the `disabled` line and not one guarantee changes** — that is the
 * test of whether a client-side guard is load-bearing, and this one is not.
 * `docs/walkthrough/phase-2-slice-1-one-order-per-intent.md` §3 makes the same
 * point about the idempotency key from the other direction: a check that clicks
 * twice in one browser cannot fail against a broken server, so it cannot pass
 * either.
 *
 * ---------------------------------------------------------------------------
 * EVERY OUTCOME RE-FETCHES THE WHOLE LIST
 * ---------------------------------------------------------------------------
 * Success, refusal, silence — all three end in `onRetryConcluded()`, and the
 * endpoint's next answer is what the operator sees. In particular the delivered
 * row is **not** removed optimistically. A row that vanishes because the client
 * decided it should is a row an operator stops watching, and if the delivery
 * did not actually stick, the order is now invisible and still stuck. The
 * button's opinion is discarded; the list is the authority.
 *
 * ---------------------------------------------------------------------------
 * WHY THE NOTICES OUTLIVE THE TABLE
 * ---------------------------------------------------------------------------
 * Re-fetching destroys the table the button was in — so a message written into
 * the row would be legible for exactly as long as one HTTP request, which is to
 * say not at all. The outcome is the *news*, and §2.5's fifth criterion is that
 * the operator is told why, so the account of each retry is kept in a node this
 * module owns ({@link RetryControls.notices}) that the page re-inserts on every
 * render. A retry whose order then leaves the list is the one case where the
 * row cannot carry its own explanation, and it is exactly the case an operator
 * most wants confirmed.
 *
 * Manual refresh only. No timer, here or anywhere on this screen: §9.4 — an
 * admin tab left open on a second monitor polling every second would be the one
 * page in the shop holding the `max: 1` connection for nobody's benefit.
 */
import {
  AdminSurfaceDisabledError,
  AdminUnauthorizedError,
} from "../../../entities/undelivered-order/index.js";
import { createElement } from "../../../shared/lib/dom.js";
import {
  OrderNotStuckError,
  RetryRefusedError,
  RetryReportError,
  RetryUnansweredError,
  retryOrderDelivery,
} from "../api/retry-order-api.js";
import { RetryOutcome, type RetryOrderReport } from "../model/retry-report.js";

/** The attribute `entities/undelivered-order`'s table marks its action cells with. */
const slotAttribute = "data-admin-retry-slot";

/** The value that cell carries when the order is *not* retryable. */
const noSlot = "none";

const text = {
  retry: "Retry",
  retrying: "Retrying…",
  noticesLabel: "What the retries came to",
} as const;

/** Kinds are rendered as `data-admin-retry-notice`, so they double as selectors. */
const NoticeKind = {
  NotStuck: "not-stuck",
  Unanswered: "unanswered",
  Unreadable: "unreadable",
  Unauthorized: "unauthorized",
  Disabled: "disabled",
  Refused: "refused",
  NoToken: "no-token",
} as const;

type NoticeKind = (typeof NoticeKind)[keyof typeof NoticeKind];

interface Notice {
  /** An outcome, or a {@link NoticeKind}. */
  readonly kind: string;

  /** `status` for news, `alert` for the paths where the operator must act. */
  readonly role: "status" | "alert";

  readonly message: string;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected retry outcome: ${JSON.stringify(value)}`);
}

/**
 * Append the API's own sentence when it sent one.
 *
 * `detail` is English and operator-facing by §8's definition, so it is rendered
 * as given rather than mapped onto a phrase of this module's choosing — the
 * supplier's actual words are the part worth reading.
 */
function withDetail(sentence: string, detail: string | null): string {
  return detail === null || detail === "" ? sentence : `${sentence} The shop says: ${detail}`;
}

function outstandingClause(report: RetryOrderReport): string {
  return report.outstandingRequestId === null
    ? ""
    : ` — request ${report.outstandingRequestId} has still not been answered`;
}

/** The four things a retry that ran can have concluded, in the operator's words. */
function describeOutcome(report: RetryOrderReport): Notice {
  const head = `Order ${report.orderId}`;
  const tail = `Status is now ${report.status}.`;

  switch (report.outcome) {
    case RetryOutcome.Delivered:
      return {
        kind: report.outcome,
        role: "status",
        message: withDetail(
          `${head}: delivered. The retry issued a key, so the order is no longer stuck and drops out of the list on the next read. The key itself belongs to the shopper and is never shown here. ${tail}`,
          report.detail,
        ),
      };

    case RetryOutcome.StillOutOfStock:
      return {
        kind: report.outcome,
        role: "status",
        message: withDetail(
          `${head}: the retry ran correctly and the order is still out of stock — the supplier had nothing to hand over. This is not a failed retry and not a stale row: the order stays in the list below, and retrying it after a restock is exactly what it is there for. ${tail}`,
          report.detail,
        ),
      };

    case RetryOutcome.DeliveryFailed:
      return {
        kind: report.outcome,
        role: "status",
        message: withDetail(
          `${head}: the retry ran and the supplier refused it. The order stays in the list below and can be retried again. ${tail}`,
          report.detail,
        ),
      };

    case RetryOutcome.Unresolved:
      return {
        kind: report.outcome,
        role: "status",
        message: withDetail(
          `${head}: the retry ran and the outcome is still unknown${outstandingClause(report)}. It may or may not have produced a key, so the shop refuses to guess. The order stays in the list below; retrying asks the supplier about that same request rather than starting a new one. ${tail}`,
          report.detail,
        ),
      };

    default:
      return assertNever(report.outcome);
  }
}

/**
 * Everything that is not a report, in the operator's words.
 *
 * The unknown-error fallback is deliberately the *unanswered* wording rather
 * than a generic failure: if this module cannot say what went wrong, it
 * certainly cannot say the retry did not run, and claiming otherwise is the one
 * mistake with a cost — an operator pressing again against a supplier that has
 * already answered.
 */
function describeFailure(orderId: string, error: unknown): Notice {
  const head = `Order ${orderId}`;

  if (error instanceof OrderNotStuckError) {
    return {
      kind: NoticeKind.NotStuck,
      role: "alert",
      message: `${head}: nothing was retried. The API answered 409 — this order is not stuck, so there was no stuck order to push through. That is a different answer from a retry that ran and found no stock: it means the row you pressed was already out of date, because another operator's retry or the automatic drain got there first. The refreshed list below is the current truth.`,
    };
  }

  if (error instanceof RetryUnansweredError) {
    return {
      kind: NoticeKind.Unanswered,
      role: "alert",
      message: `${head}: the retry request did not come back. It may or may not have run — refresh to see. Do not read this as a failure: a retry whose answer was lost can still have issued a key, and the list below is being re-read for exactly that reason.`,
    };
  }

  if (error instanceof RetryReportError) {
    return {
      kind: NoticeKind.Unreadable,
      role: "alert",
      message: `${head}: the retry ran — the API answered 200 — but its report could not be read (${error.message}). The work happened; only the account of it is missing. The refreshed list below says where the order actually stands.`,
    };
  }

  if (error instanceof AdminUnauthorizedError) {
    return {
      kind: NoticeKind.Unauthorized,
      role: "alert",
      message: `${head}: the admin token was refused (401), so the retry never reached issuance. Paste the token again and press Retry once more.`,
    };
  }

  if (error instanceof AdminSurfaceDisabledError) {
    return {
      kind: NoticeKind.Disabled,
      role: "alert",
      message: `${head}: this deployment has no admin surface (503 — ADMIN_TOKEN is not configured on the API), so the retry never reached issuance. A token cannot help; the fix is a deploy with the variable set.`,
    };
  }

  if (error instanceof RetryRefusedError) {
    return {
      kind: NoticeKind.Refused,
      role: "alert",
      message: `${head}: the API refused the retry with HTTP ${String(error.status)} and did no work. Refresh the list; if the row is still there, this is a bug worth reporting rather than a press worth repeating.`,
    };
  }

  return {
    kind: NoticeKind.Unanswered,
    role: "alert",
    message: `${head}: the retry request did not come back. It may or may not have run — refresh to see. (${error instanceof Error ? error.message : String(error)})`,
  };
}

/** What the page composes. */
export interface RetryControls {
  /**
   * The account of concluded retries. A stable node: the page puts it back into
   * the view on every render, and it keeps its children across the re-fetch
   * that every retry triggers.
   */
  readonly notices: HTMLElement;

  /**
   * Put a Retry button in every retryable action cell of a freshly rendered
   * table, restoring the busy state of any retry still in flight.
   *
   * Called after **every** list render, because the table is a new one each
   * time.
   */
  mount(table: ParentNode): void;
}

export interface RetryControlsOptions {
  /**
   * Read at press time rather than captured at construction: the token can be
   * cleared between renders (a `401` on the list does exactly that), and a
   * button holding a stale copy would send a credential the page has already
   * been told is wrong.
   *
   * A function rather than the store itself — `features/present-admin-token`
   * is a sibling feature, and features do not import features.
   */
  readonly getToken: () => string | null;

  /**
   * Re-read the list. Called on every conclusion, success or not — see the
   * header.
   */
  readonly onRetryConcluded: () => void;
}

export function createRetryControls(options: RetryControlsOptions): RetryControls {
  /**
   * The orders with a retry in flight. A set, not a boolean — see the header.
   * It survives table renders, so a row whose retry is still running comes back
   * disabled rather than inviting a second press.
   */
  const busy = new Set<string>();

  /**
   * One notice per order, newest last. Re-inserting an order's notice moves it
   * to the end (a `Map` delete-then-set), so the running account reads in the
   * order things actually concluded.
   */
  const notices = new Map<string, Notice>();

  const noticeList = createElement("div", {
    attributes: { "data-admin-retry-notices": "", "aria-label": text.noticesLabel },
  });

  function renderNotices(): void {
    noticeList.replaceChildren(
      ...[...notices].map(([orderId, notice]) =>
        createElement("p", {
          text: notice.message,
          attributes: {
            role: notice.role,
            "data-admin-retry-notice": notice.kind,
            "data-admin-retry-order": orderId,
          },
        }),
      ),
    );
  }

  function record(orderId: string, notice: Notice): void {
    notices.delete(orderId);
    notices.set(orderId, notice);
    renderNotices();
  }

  function setBusy(button: HTMLButtonElement, isBusy: boolean): void {
    button.disabled = isBusy;
    button.textContent = isBusy ? text.retrying : text.retry;
    button.setAttribute("data-admin-retry-busy", isBusy ? "true" : "false");
  }

  async function send(orderId: string, button: HTMLButtonElement): Promise<void> {
    // The courtesy guard. See the header: removing it changes no guarantee.
    if (busy.has(orderId)) {
      return;
    }

    const token = options.getToken();

    if (token === null) {
      record(orderId, {
        kind: NoticeKind.NoToken,
        role: "alert",
        message: `Order ${orderId}: nothing was sent — this tab no longer has an admin token. Paste it again.`,
      });
      options.onRetryConcluded();

      return;
    }

    busy.add(orderId);
    setBusy(button, true);

    try {
      record(orderId, describeOutcome(await retryOrderDelivery(orderId, token)));
    } catch (error: unknown) {
      record(orderId, describeFailure(orderId, error));
    } finally {
      // Cleared *before* the re-fetch, so the table that comes back renders this
      // row's button enabled. Retry-after-restock is §2.5's second criterion:
      // a button that stayed disabled after a failure would make the one thing
      // the operator came here to do impossible without a reload.
      busy.delete(orderId);
      setBusy(button, false);
      options.onRetryConcluded();
    }
  }

  function buildButton(orderId: string): HTMLButtonElement {
    const button = createElement("button", {
      attributes: { type: "button", "data-admin-retry": orderId },
    });

    setBusy(button, busy.has(orderId));

    button.addEventListener("click", () => {
      void send(orderId, button);
    });

    return button;
  }

  return {
    notices: noticeList,

    mount(table: ParentNode): void {
      for (const cell of table.querySelectorAll(`[${slotAttribute}]`)) {
        const orderId = cell.getAttribute(slotAttribute);

        // `none` is the entity's way of saying this order is finished or already
        // moving; the cell explains itself and gets no button.
        if (orderId === null || orderId === noSlot) {
          continue;
        }

        cell.replaceChildren(buildButton(orderId));
      }
    },
  };
}
