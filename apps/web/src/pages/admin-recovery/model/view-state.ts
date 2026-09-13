/**
 * The seven things the recovery screen can be showing, as one closed set.
 *
 * ---------------------------------------------------------------------------
 * WHY SEVEN STATES AND NOT THREE BOOLEANS
 * ---------------------------------------------------------------------------
 * The obvious shape for this page is a handful of flags — `loading`, `error`,
 * `orders`, `token` — and it is wrong in a way that only shows up on the screen
 * an operator opens during an incident. Flags make impossible combinations
 * *representable*: loading **and** unauthorized, a list **and** an error, a
 * `503` **with** a token form under it. Each of those renders something, and
 * what it renders is a page telling somebody two contradictory things about why
 * their shop's stuck orders are not on screen.
 *
 * A discriminated union makes every one of those unrepresentable, and the
 * `assertNever` in `../ui/admin-recovery-page.ts` makes an eighth state a
 * compile error rather than a blank region.
 *
 * ---------------------------------------------------------------------------
 * THE 401/503 SPLIT MIRRORS THE GUARD, ONE-FOR-ONE
 * ---------------------------------------------------------------------------
 * `apps/api/src/admin/admin-token.guard.ts` answers exactly three ways, and two
 * of them are refusals with genuinely different remedies:
 *
 *   - {@link AdminRecoveryView.Unauthorized} — `401`. The token was missing or
 *     wrong. **Show the form again**; a different token is exactly what would
 *     help.
 *   - {@link AdminRecoveryView.Disabled} — `503`. `ADMIN_TOKEN` is not
 *     configured on this deployment. **Show no form at all**: pasting cannot
 *     help, and offering the field anyway would have an operator working
 *     through their password manager during an incident whose fix is a deploy.
 *
 * Collapsing them into one "refused" state is the natural simplification and it
 * costs the operator the only piece of information that tells them where to go.
 *
 * ---------------------------------------------------------------------------
 * `empty` IS A STATE, NOT AN EMPTY `list`
 * ---------------------------------------------------------------------------
 * Functional spec §2.4's fifth criterion asks that an operator with nothing to
 * recover be *"told plainly that there is nothing to recover, rather than shown
 * an empty screen with no explanation"*. Rendering a zero-row `<table>` would
 * satisfy the letter of "the list loaded" and fail the criterion outright: a
 * table with headers and no rows is indistinguishable from a list that failed
 * to load, and the operator's next move would be to reload a page that was
 * already telling them the truth.
 */
import type { UndeliveredOrdersReport } from "../../../entities/undelivered-order/index.js";

/**
 * The seven discriminants. An `as const` object rather than bare string
 * literals so the switch arms and the states are spelled once.
 */
export const AdminRecoveryView = {
  /** Nothing has been presented yet. The form, and no request has been made. */
  NoToken: "no-token",
  /** A request is in flight. */
  Loading: "loading",
  /** The report came back with at least one order. */
  List: "list",
  /** The report came back with none — see the note above. */
  Empty: "empty",
  /** `401`: the token was missing or wrong, and the stored one has been forgotten. */
  Unauthorized: "unauthorized",
  /** `503`: this deployment has no admin surface. No form. */
  Disabled: "disabled",
  /** Anything else: unreachable API, a `500`, a body that is not a report. */
  Error: "error",
} as const;

export type AdminRecoveryView = (typeof AdminRecoveryView)[keyof typeof AdminRecoveryView];

/** What the page is showing, and everything needed to show it. */
export type AdminRecoveryViewState =
  | { readonly view: typeof AdminRecoveryView.NoToken }
  | { readonly view: typeof AdminRecoveryView.Loading }
  | {
      readonly view: typeof AdminRecoveryView.List;
      /** Carried whole, because the page renders its `count`, `truncated` and `message` too. */
      readonly report: UndeliveredOrdersReport;
    }
  | {
      readonly view: typeof AdminRecoveryView.Empty;
      /**
       * The API's own sentence, or the page's fallback when the report's
       * `message` was blank. Resolved before the state is built so that the
       * renderer has nothing left to decide.
       */
      readonly message: string;
    }
  | { readonly view: typeof AdminRecoveryView.Unauthorized }
  | { readonly view: typeof AdminRecoveryView.Disabled }
  | {
      readonly view: typeof AdminRecoveryView.Error;
      /**
       * What actually went wrong, in the words of whatever threw — `GET … responded
       * 500`, `Failed to fetch`, `report.orders: expected an array, got undefined`.
       *
       * Shown to the operator verbatim, which is the opposite of what the
       * shopper's pages do with the same information and is right for the same
       * reason: the audience here is the person who will go and read the API's
       * logs next, and a generic «что-то пошло не так» would send them to do it
       * with no idea what they are looking for.
       */
      readonly detail: string;
    };
