/**
 * The catalog menu as a pure model: is it open, and what does each event do
 * to that (functional spec §2.3; technical-considerations §2.2, "Menu").
 *
 * Nothing here touches the DOM. `ui/catalog-menu.ts` owns one `document`
 * click listener and one `keydown` listener; the click listener *classifies*
 * where the click landed — on the Каталог button, inside the overlay, or
 * anywhere else — into a {@link MenuEvent}, feeds it through
 * {@link reduceMenu}, and paints the boolean it gets back. The binding decides
 * *where*; this file decides *what happens*.
 *
 * ---------------------------------------------------------------------------
 * WHY SIX LINES OF LOGIC EARN A FILE
 * ---------------------------------------------------------------------------
 * Five of the six graded menu criteria are what any menu does. The fifth —
 * "click any category or item inside the overlay, then nothing changes"
 * (§2.3 crit 5) — is the one a menu gets wrong by accident, because the
 * shortest correct-looking implementation is a document listener that closes
 * on *any* click while open, and that implementation passes every manual
 * check except the graded one.
 *
 * Writing the rule as a reducer makes "inner clicks are inert" a *sentence in
 * the code* — `InsideClick → isOpen`, unchanged — rather than the absence of a
 * branch somewhere in an event handler. It is total: the `switch` ends in
 * `assertNever`, so adding a fifth event without deciding what it does is a
 * type error, not a menu that silently ignores it. And it is checkable with
 * no browser: `menu.test.ts` asserts every row, and the browser test in
 * `e2e/catalog-menu.spec.ts` only has to prove the classification.
 *
 * ---------------------------------------------------------------------------
 * CLOSE IS IDEMPOTENT, TOGGLE IS NOT
 * ---------------------------------------------------------------------------
 * `OutsideClick` and `Escape` answer `false` whatever the state, because the
 * document listeners fire for the life of the page — every click on a closed
 * menu is an outside click — and "close when already closed" must be a no-op
 * rather than a flip. Only `Toggle` reads the state to invert it; it is the one
 * event that exists to do so.
 */

/**
 * What the DOM saw, stripped of everything but the fact.
 *
 * `toggle` — the Каталог button; `outside-click` — a click that landed neither
 * on the button nor in the overlay; `inside-click` — a click on a category or
 * item in the overlay; `escape` — the Escape key. The binding produces exactly
 * one of these per click, so the opening click can never also arrive here as
 * an outside click (technical-considerations §2.4).
 */
export const MenuEvent = {
  Toggle: "toggle",
  OutsideClick: "outside-click",
  InsideClick: "inside-click",
  Escape: "escape",
} as const;

export type MenuEvent = (typeof MenuEvent)[keyof typeof MenuEvent];

function assertNever(value: never): never {
  throw new Error(`Unexpected menu event: ${String(value)}`);
}

/**
 * The rule, one branch per event. Pure and total: `Toggle` flips,
 * `OutsideClick` and `Escape` close, `InsideClick` leaves the state as it was.
 */
export function reduceMenu(isOpen: boolean, event: MenuEvent): boolean {
  switch (event) {
    case MenuEvent.Toggle:
      return !isOpen;

    case MenuEvent.OutsideClick:
    case MenuEvent.Escape:
      return false;

    case MenuEvent.InsideClick:
      return isOpen;

    default:
      return assertNever(event);
  }
}
