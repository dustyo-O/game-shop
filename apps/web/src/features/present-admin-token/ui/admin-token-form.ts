/**
 * The form an operator pastes the shop's admin token into.
 *
 * ---------------------------------------------------------------------------
 * `preventDefault` IS LOAD-BEARING, NOT BOILERPLATE
 * ---------------------------------------------------------------------------
 * A `<form>` with no submit handler navigates, and a form with a named field
 * and no `method` navigates **`GET`** — which appends every field to the URL.
 * That is the one thing `admin-token-storage.ts` names as forbidden: the token
 * would land in the address bar, in browser history, in the `Referer` of the
 * very next request, and in the access log of anything between here and the
 * server. So the handler below is not the usual single-page-app ceremony to
 * stop a reload; it is the thing that keeps a credential out of a URL, and the
 * field is left unnamed as a second line of the same defence.
 *
 * ---------------------------------------------------------------------------
 * `type="password"` FOR A VALUE THAT IS NOT A PASSWORD
 * ---------------------------------------------------------------------------
 * It is a shared bearer token, so it has no owner and no "forgot it" flow — but
 * it is read off a screen exactly the way a password is, usually during an
 * incident, usually with somebody standing behind the operator. `autocomplete`
 * is `off` so no browser offers to save a credential that is the shop's rather
 * than this person's, and `required` lets the browser refuse an empty submit
 * without this file having to word a message for it.
 *
 * This is a feature, not part of the page or of the entity: the entity's `api`
 * segment carries the token it is handed and does not decide it, and the page
 * composes the form without knowing where the value it receives came from. The
 * same division `features/buy-product` has with `Idempotency-Key`.
 */
import { createElement } from "../../../shared/lib/dom.js";
import { storeAdminToken } from "../lib/admin-token-storage.js";

const text = {
  label: "Admin token",
  hint: "The shop's ADMIN_TOKEN. It is kept for this tab only and is never put in the address bar.",
  submit: "Show undelivered orders",
} as const;

/** What the page wants to happen once a token has been supplied. */
interface AdminTokenFormOptions {
  /**
   * Called with the trimmed token **after** it has been stored, so the page can
   * go and read the list. Storing before calling back, rather than leaving it to
   * the page, keeps "the token is remembered" and "the token is used" from ever
   * being two different values.
   */
  readonly onTokenPresented: (token: string) => void;
}

/**
 * Build the form.
 *
 * The value is trimmed before it is stored: an admin token pasted out of a
 * terminal or a password manager arrives with a newline more often than not,
 * and `Authorization: Bearer <token>\n` is not a header the guard's
 * whitespace-splitting parser would read as the token it holds. A value that is
 * nothing but whitespace is dropped without a word — `required` has already
 * caught the empty case, and there is no useful sentence to say about a
 * paste that contained no characters.
 */
export function createAdminTokenForm(options: AdminTokenFormOptions): HTMLFormElement {
  const input = createElement("input", {
    attributes: {
      type: "password",
      id: "admin-token",
      autocomplete: "off",
      required: "required",
      "data-admin-token-input": "",
    },
  });

  const form = createElement("form", { attributes: { "data-admin-form": "token" } }, [
    createElement("div", {}, [
      createElement("label", { text: text.label, attributes: { for: "admin-token" } }),
    ]),
    createElement("div", {}, [input]),
    createElement("div", {}, [
      createElement("small", { text: text.hint }),
    ]),
    createElement("div", {}, [
      createElement("button", { text: text.submit, attributes: { type: "submit" } }),
    ]),
  ]);

  form.addEventListener("submit", (event: SubmitEvent) => {
    // See the header. Without this line the token goes into the URL.
    event.preventDefault();

    const token = input.value.trim();

    if (token === "") {
      return;
    }

    input.value = "";
    storeAdminToken(token);
    options.onTokenPresented(token);
  });

  return form;
}
