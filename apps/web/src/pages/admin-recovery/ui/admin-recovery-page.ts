/**
 * `/admin/recovery` — the one place a person can see every purchase that was
 * paid for and never delivered (functional spec §2.4).
 *
 * ###########################################################################
 * # THERE IS NO CLIENT-SIDE ROUTE GUARD HERE, AND THERE MUST NOT BE ONE.
 * ###########################################################################
 *
 * This page renders for **anybody** who types the address. It does not check a
 * token before mounting, it does not redirect, and it does not hide itself. The
 * reason is not laziness about security, it is the opposite:
 *
 *   > A check the browser makes is a check the browser can be told to skip.
 *
 * Every line of this file runs on a machine the caller controls. A route guard
 * here would be one `return` away from being deleted in a devtools console, one
 * breakpoint away from being stepped over, and gone entirely from a bundle
 * someone re-hosts. What it *would* reliably do is create the belief that the
 * admin surface is protected by something on this side of the wire — and that
 * belief is what makes the real protection get relaxed later.
 *
 * So the page renders, and it renders **nothing but a form** until the API says
 * otherwise. Every byte of order data on this screen arrives from
 * `GET /api/admin/orders/undelivered`, which is behind `AdminTokenGuard` on the
 * server. §2.4's last criterion — *"a person without the shop's operator
 * credentials … is refused"* — is therefore checked by **calling the endpoint**,
 * never by inspecting this DOM. A verification that loads this URL without a
 * token and observes a redirect would be testing a lie; the honest check is
 * `curl` with a bad token, and it is an API-side check.
 *
 * ---------------------------------------------------------------------------
 * AND NO LINK TO IT FROM THE SHOP
 * ---------------------------------------------------------------------------
 * The operator has the URL. A link in the storefront's header would advertise
 * the door to every shopper, and buy the one person who already knows where it
 * is exactly one click.
 *
 * ---------------------------------------------------------------------------
 * FUNCTIONAL, NOT STYLED — AND MANUALLY REFRESHED
 * ---------------------------------------------------------------------------
 * Browser-default `<form>`, `<table>`, `<button>`, `<time>` and `<code>`, no
 * class names, nothing added to `app/styles.css`. There is no auto-refresh
 * timer either, and that is a decision rather than an omission
 * (technical-considerations §9.4): §2.4's *"without waiting for any period"* is
 * a statement about the **server** not hiding fresh orders behind a grace
 * period, not a request for polling. An admin tab left open on a second monitor
 * polling every second would be the one page in this shop holding the API's
 * `max: 1` connection for nobody's benefit.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE PAGE OWNS OF THE RETRY, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * `features/retry-order-delivery` owns the button, the per-row busy state, the
 * endpoint and every sentence about what a press came to. This page owns two
 * things only: it fills the action cells the entity's table leaves empty
 * (`retryControls.mount`), and it answers `onRetryConcluded` by re-reading the
 * list — which is the same {@link load} the Refresh button runs, because the
 * endpoint is the authority on what is still stuck and the button's opinion is
 * discarded.
 *
 * The notices node is composed **above** the table and is the same element on
 * every render. That is load-bearing rather than tidy: each re-read replaces
 * the table, so an outcome written into a row would be legible for exactly as
 * long as one HTTP request — and the delivered order, the one an operator most
 * wants confirmed, has no row left at all.
 */
import {
  AdminSurfaceDisabledError,
  AdminUnauthorizedError,
  fetchUndeliveredOrders,
  renderUndeliveredOrdersTable,
  type UndeliveredOrdersReport,
} from "../../../entities/undelivered-order/index.js";
import {
  clearAdminToken,
  createAdminTokenForm,
  readAdminToken,
} from "../../../features/present-admin-token/index.js";
import { createRetryControls } from "../../../features/retry-order-delivery/index.js";
import { createElement } from "../../../shared/lib/dom.js";
import { AdminRecoveryView, type AdminRecoveryViewState } from "../model/view-state.js";

/**
 * Every word this page shows, in English — assumption A10. See the table's own
 * note: everything else this operator reads in the same minute is English, and
 * a screen that translated only its furniture would make the supplier's own
 * words look like ones this page had chosen.
 */
const text = {
  title: "Recovery",
  subtitle: "Orders that were paid for and are holding no key.",
  loading: "Loading…",
  refresh: "Refresh",
  noToken: "Paste the shop's admin token to see the list.",
  unauthorized:
    "The admin token was missing or wrong, and the one this tab had has been forgotten. Paste it again.",
  disabled:
    "This deployment has no admin surface: ADMIN_TOKEN is not configured on the API, so it refuses every admin request with 503. Pasting a token cannot help — the fix is a deploy with the variable set. Reload this page once it is.",
  errorLead: "Could not load the list.",
  emptyFallback: "Nothing to recover: every paid order is holding a key.",
  truncated:
    "This list is capped and there are more orders than are shown. Recover these, then refresh.",
} as const;

/**
 * The project's convention, one module-private copy per file that needs it —
 * `apps/api` has six of them and none of them is imported from anywhere.
 *
 * Its value is entirely at compile time: the `default` arm below passes the
 * narrowed state to a parameter of type `never`, so adding an eighth member to
 * {@link AdminRecoveryViewState} without adding an arm for it is a type error
 * at this line. The throw is what happens if a hand-written cast or a wire value
 * gets past the compiler anyway, and on this page it would be visible as a
 * thrown error rather than as a blank region nobody can explain.
 */
function assertNever(value: never): never {
  throw new Error(`Unexpected view state: ${JSON.stringify(value)}`);
}

function paragraph(message: string, role: "status" | "alert" = "status"): HTMLParagraphElement {
  return createElement("p", { text: message, attributes: { role } });
}

/** The summary line above the table: how many, and whether that is all of them. */
function reportSummary(report: UndeliveredOrdersReport): readonly HTMLElement[] {
  const lines = [paragraph(report.message === "" ? `${String(report.count)} orders.` : report.message)];

  if (report.truncated) {
    lines.push(paragraph(text.truncated, "alert"));
  }

  return lines;
}

/** Build the page for `/admin/recovery` and start reading the list if a token is already held. */
export function createAdminRecoveryPage(): HTMLElement {
  /**
   * The region every state is painted into. `data-admin-view` names the current
   * state on the element itself: it is the handle a browser check reads, and it
   * means "which of the seven is on screen" never has to be inferred from which
   * sentences happen to be present.
   */
  const region = createElement("div", { attributes: { "data-admin-view": AdminRecoveryView.NoToken } });

  /**
   * The read in flight, if any.
   *
   * Two Refresh presses a second apart, or a press while the first load is still
   * running, would otherwise race: the slower response lands last and paints a
   * list the operator has already replaced. Aborting the previous read makes the
   * newest request the only one that can paint, and the `signal.aborted` check
   * in {@link load} is what keeps the loser silent rather than turning its
   * `AbortError` into the error state.
   */
  let inFlight: AbortController | null = null;

  const refreshButton = createElement("button", {
    text: text.refresh,
    attributes: { type: "button", "data-admin-action": "refresh" },
  });

  /**
   * Re-read the list with whatever token the tab now has.
   *
   * One function for two callers — the Refresh button and every concluded retry
   * — so "the endpoint is the authority" is literally the same code path in
   * both cases. A `null` token means the tab was cleared by a `401` in between,
   * and the form is the only useful thing to show.
   *
   * A function declaration rather than a `const`: it is referenced by
   * `retryControls` a few lines below, which is built before {@link load} is
   * reached in source order, and hoisting is what lets the three read in the
   * order a person would explain them.
   */
  function refreshList(): void {
    const token = readAdminToken();

    if (token === null) {
      render({ view: AdminRecoveryView.NoToken });

      return;
    }

    void load(token);
  }

  refreshButton.addEventListener("click", refreshList);

  /**
   * The Retry buttons, and the running account of what they came to.
   *
   * `readAdminToken` is passed as a function, not as a value: the token can be
   * cleared between renders and a captured copy would send a credential this
   * page has already been told is wrong. The feature cannot read the store
   * itself — `present-admin-token` is a sibling feature, and features do not
   * import features.
   */
  const retryControls = createRetryControls({
    getToken: readAdminToken,
    onRetryConcluded: refreshList,
  });

  const tokenForm = createAdminTokenForm({
    onTokenPresented: (token: string) => {
      void load(token);
    },
  });

  /**
   * Paint one state, and nothing else.
   *
   * Every arm replaces the whole region, so no fragment of a previous state can
   * survive into the next one — a `401` message left standing under a list that
   * has since loaded would be the same lie the discriminated union exists to
   * prevent.
   */
  function render(state: AdminRecoveryViewState): void {
    region.setAttribute("data-admin-view", state.view);

    switch (state.view) {
      case AdminRecoveryView.NoToken:
        region.replaceChildren(paragraph(text.noToken), tokenForm);

        return;

      case AdminRecoveryView.Loading:
        region.replaceChildren(paragraph(text.loading));

        return;

      case AdminRecoveryView.List: {
        // A fresh table every time, so a fresh set of buttons every time —
        // `mount` also restores the busy state of any retry still in flight,
        // which is how a second row's press survives the first row's re-read.
        const table = renderUndeliveredOrdersTable(state.report.orders);

        region.replaceChildren(
          ...reportSummary(state.report),
          refreshButton,
          retryControls.notices,
          table,
        );

        retryControls.mount(table);

        return;
      }

      case AdminRecoveryView.Empty:
        // §2.4's fifth criterion: words, not a blank screen and not a table
        // with headers and no rows.
        //
        // The notices come along: an operator who has just retried the last
        // stuck order arrives here, and "nothing to recover" on its own would
        // leave them guessing whether *their* press is the reason.
        region.replaceChildren(paragraph(state.message), refreshButton, retryControls.notices);

        return;

      case AdminRecoveryView.Unauthorized:
        region.replaceChildren(paragraph(text.unauthorized, "alert"), tokenForm);

        return;

      case AdminRecoveryView.Disabled:
        // **No form.** See `../model/view-state.ts`: pasting cannot help, and
        // offering the field would send the operator looking for a better token
        // instead of at the deployment's environment.
        region.replaceChildren(paragraph(text.disabled, "alert"));

        return;

      case AdminRecoveryView.Error:
        // Also here, and for the sharper version of the same reason: the read
        // that failed may be the one a retry asked for, and the retry's own
        // account is the only thing on screen that still says what happened.
        region.replaceChildren(
          paragraph(`${text.errorLead} ${state.detail}`, "alert"),
          refreshButton,
          retryControls.notices,
        );

        return;

      default:
        return assertNever(state);
    }
  }

  /**
   * Read the list once with the token in hand, and put the answer on screen.
   *
   * The four outcomes are the guard's three plus everything else:
   *
   *   - **A report.** `empty` when it holds no orders, `list` otherwise. The
   *     API's own `message` is preferred over this page's wording, because §8
   *     says the endpoint carries one for exactly this criterion; the fallback
   *     covers a report whose message is blank.
   *   - **`401`.** The stored token has just been proven wrong by the only
   *     authority on the question, so it is **forgotten** — otherwise the next
   *     render would silently re-send a credential known not to work, and the
   *     form the operator is looking at would have no effect.
   *   - **`503`.** The token is not the problem and is left exactly where it is.
   *   - **Anything else.** Say what happened, in the words of whatever threw.
   */
  async function load(token: string): Promise<void> {
    inFlight?.abort();

    const controller = new AbortController();

    inFlight = controller;

    render({ view: AdminRecoveryView.Loading });

    try {
      const report = await fetchUndeliveredOrders(token, controller.signal);

      if (controller.signal.aborted) {
        return;
      }

      render(
        report.orders.length === 0
          ? {
              view: AdminRecoveryView.Empty,
              message: report.message === "" ? text.emptyFallback : report.message,
            }
          : { view: AdminRecoveryView.List, report },
      );
    } catch (error: unknown) {
      if (controller.signal.aborted) {
        return;
      }

      if (error instanceof AdminUnauthorizedError) {
        clearAdminToken();
        render({ view: AdminRecoveryView.Unauthorized });

        return;
      }

      if (error instanceof AdminSurfaceDisabledError) {
        render({ view: AdminRecoveryView.Disabled });

        return;
      }

      render({
        view: AdminRecoveryView.Error,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const page = createElement("main", { attributes: { "data-admin-page": "recovery" } }, [
    createElement("h1", { text: text.title }),
    paragraph(text.subtitle),
    region,
  ]);

  /**
   * A token already in this tab's session storage means the operator has
   * presented one during this sitting, so the list is read immediately and they
   * do not have to paste it again on every navigation. With nothing stored the
   * page opens on the form and **makes no request at all** — an anonymous
   * visitor who has found this URL generates no admin traffic to be refused.
   */
  const storedToken = readAdminToken();

  if (storedToken === null) {
    render({ view: AdminRecoveryView.NoToken });
  } else {
    void load(storedToken);
  }

  return page;
}
