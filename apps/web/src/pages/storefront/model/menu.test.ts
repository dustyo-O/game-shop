// @layer: unit
// @spec: 004-storefront-per-the-design
// @regression
/**
 * The catalog menu's open/closed rule, one case per row (functional spec §2.3;
 * technical-considerations §2.2, "Menu"; §4.1's table).
 *
 * No DOM: `reduceMenu` is a pure function from (isOpen, event) to isOpen, and
 * the event is a *word* — the DOM binding in `ui/catalog-menu.ts` classifies a
 * click as button / inside / outside once and hands the word here. So the rule
 * that is graded — "click inside the overlay → nothing changes" (§2.3 crit 5)
 * — is checked in this file as a return value, and the browser test only has
 * to prove the classification.
 *
 * ---------------------------------------------------------------------------
 * THE CASE THIS FILE EXISTS FOR
 * ---------------------------------------------------------------------------
 * *"InsideClick on an open menu leaves it open."*
 *
 * Every other row is what any menu does. This one is the row a menu gets wrong
 * by accident: a single document listener that closes on "any click while
 * open" is one line shorter than one that asks *where* the click landed, and
 * passes every manual check except the one the assignment grades. Writing the
 * inert row as a reducer branch — `InsideClick → isOpen`, unchanged — makes it
 * a statement the type-checker keeps total and this file keeps true.
 *
 * The RED for this file (§4.1) is to make `InsideClick` return `false` and
 * watch that case fail. Note what that mutation *cannot* flip: "InsideClick on
 * a closed menu stays closed" expects `false` and would still get it. That
 * second case guards the other wrong reading — an inside click treated as a
 * `Toggle` — which is why both are here, one `it` each.
 *
 * ---------------------------------------------------------------------------
 * THE NO-OP ROWS ARE ASSERTED, NOT ASSUMED
 * ---------------------------------------------------------------------------
 * `OutsideClick` and `Escape` on a *closed* menu must answer `false`, not throw
 * and not flip. The document listeners in the binding fire on every click and
 * every key press for the life of the page, closed menu included, so "close
 * when already closed" is the reducer's most frequent input, not an edge case.
 */
import { describe, expect, it } from "vitest";

import { MenuEvent, reduceMenu } from "./menu.js";

const OPEN = true;
const CLOSED = false;

describe("reduceMenu — the open/closed rule", () => {
  describe("Toggle", () => {
    it("from closed → open (crit 1)", () => {
      expect(reduceMenu(CLOSED, MenuEvent.Toggle)).toBe(true);
    });

    it("from open → closed (crit 2)", () => {
      expect(reduceMenu(OPEN, MenuEvent.Toggle)).toBe(false);
    });
  });

  describe("OutsideClick", () => {
    it("closes an open menu (crit 3)", () => {
      expect(reduceMenu(OPEN, MenuEvent.OutsideClick)).toBe(false);
    });

    it("on a closed menu stays closed — the listener fires on every click, closed included", () => {
      expect(reduceMenu(CLOSED, MenuEvent.OutsideClick)).toBe(false);
    });
  });

  describe("Escape", () => {
    it("closes an open menu (crit 4)", () => {
      expect(reduceMenu(OPEN, MenuEvent.Escape)).toBe(false);
    });

    it("on a closed menu stays closed", () => {
      expect(reduceMenu(CLOSED, MenuEvent.Escape)).toBe(false);
    });
  });

  describe("InsideClick", () => {
    it("on an open menu stays open — inner clicks are inert (crit 5)", () => {
      expect(reduceMenu(OPEN, MenuEvent.InsideClick)).toBe(true);
    });

    it("on a closed menu stays closed — an inside click is not a Toggle", () => {
      expect(reduceMenu(CLOSED, MenuEvent.InsideClick)).toBe(false);
    });
  });
});
