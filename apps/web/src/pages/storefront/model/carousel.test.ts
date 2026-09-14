// @layer: unit
// @spec: 004-storefront-per-the-design
// @regression
/**
 * The banner's policy table (technical-considerations §2.2), one case per row.
 *
 * No DOM, no clock: `reduceCarousel` is a pure function from (state, event) to
 * (state, timer instruction), and the instruction is a *word* — `restart`,
 * `cancel`, `keep` — never a millisecond count and never a `setTimeout` call.
 * That is what makes this file possible at all: the rule "a manual move
 * restarts the 5-second count unless the pointer is resting on the panel"
 * (functional spec §2.2 crits 6–7) is checked here as a return value, and the
 * browser test only has to prove the binding forwards the word to the countdown.
 *
 * ---------------------------------------------------------------------------
 * THE WRAP CASES ARE THE ONES THAT CAN FAIL QUIETLY
 * ---------------------------------------------------------------------------
 * `index + 1` past the last slide and `index - 1` before the first are both a
 * single `%`, and JavaScript's `%` keeps the sign of the dividend: `-1 % 4` is
 * `-1`, not `3`. A carousel written with a bare modulo advances correctly all
 * day and only breaks on the first left-arrow press from slide 1 — which is
 * exactly crit 4, and exactly the case a manual check skips. The RED for this
 * file is therefore to drop the normalisation in `wrapIndex` and watch the
 * negative-index cases fail (§4.1's table).
 *
 * ---------------------------------------------------------------------------
 * EVERY UNCHANGED ROW IS ASSERTED, NOT ASSUMED
 * ---------------------------------------------------------------------------
 * "Unchanged, `keep`" is the assertion most likely to pass vacuously, so each of
 * those rows checks the index *and* the pause flag *and* the instruction, and
 * the purity case checks the input object afterwards — a reducer that mutated
 * its argument and returned it would satisfy every other case in this file.
 */
import { describe, expect, it } from "vitest";

import {
  createCarouselState,
  reduceCarousel,
  wrapIndex,
  TimerInstruction,
  type CarouselEvent,
  type CarouselState,
} from "./carousel.js";

/** Four slides, like `config/banner-slides.ts` — the count is a parameter here. */
const COUNT = 4;

function stateAt(index: number, isPaused = false): CarouselState {
  return { index, count: COUNT, isPaused };
}

const tick: CarouselEvent = { type: "tick" };
const next: CarouselEvent = { type: "next" };
const prev: CarouselEvent = { type: "prev" };
const pointerEnter: CarouselEvent = { type: "pointer-enter" };
const pointerLeave: CarouselEvent = { type: "pointer-leave" };

function dot(index: number): CarouselEvent {
  return { type: "dot", index };
}

describe("createCarouselState", () => {
  it("starts on the first slide, not paused", () => {
    expect(createCarouselState(COUNT)).toEqual({ index: 0, count: COUNT, isPaused: false });
  });

  it("refuses a count below one — a carousel with nothing to show has no first slide", () => {
    expect(() => createCarouselState(0)).toThrow();
    expect(() => createCarouselState(-1)).toThrow();
  });
});

describe("wrapIndex", () => {
  it("leaves an in-range index alone", () => {
    expect(wrapIndex(0, COUNT)).toBe(0);
    expect(wrapIndex(2, COUNT)).toBe(2);
    expect(wrapIndex(3, COUNT)).toBe(3);
  });

  it("wraps one past the last slide to the first", () => {
    expect(wrapIndex(COUNT, COUNT)).toBe(0);
  });

  it("wraps one before the first slide to the last (a bare `%` would answer -1)", () => {
    expect(wrapIndex(-1, COUNT)).toBe(COUNT - 1);
  });

  it("wraps any distance in either direction", () => {
    expect(wrapIndex(COUNT * 2 + 1, COUNT)).toBe(1);
    expect(wrapIndex(-COUNT - 1, COUNT)).toBe(COUNT - 1);
  });
});

describe("reduceCarousel — the policy table", () => {
  describe("tick", () => {
    it("advances by one and restarts the count", () => {
      expect(reduceCarousel(stateAt(1), tick)).toEqual({
        state: stateAt(2),
        timer: TimerInstruction.Restart,
      });
    });

    it("wraps last → first (crit 2)", () => {
      expect(reduceCarousel(stateAt(COUNT - 1), tick)).toEqual({
        state: stateAt(0),
        timer: TimerInstruction.Restart,
      });
    });

    it("while paused: unchanged, keep — a tick that should not have arrived changes nothing", () => {
      const paused = stateAt(1, true);
      expect(reduceCarousel(paused, tick)).toEqual({
        state: stateAt(1, true),
        timer: TimerInstruction.Keep,
      });
    });
  });

  describe("next", () => {
    it("advances by one and restarts the count (crits 3, 6)", () => {
      expect(reduceCarousel(stateAt(0), next)).toEqual({
        state: stateAt(1),
        timer: TimerInstruction.Restart,
      });
    });

    it("wraps last → first", () => {
      expect(reduceCarousel(stateAt(COUNT - 1), next)).toEqual({
        state: stateAt(0),
        timer: TimerInstruction.Restart,
      });
    });

    it("while paused: moves, but cancels rather than restarts (crit 7)", () => {
      expect(reduceCarousel(stateAt(1, true), next)).toEqual({
        state: stateAt(2, true),
        timer: TimerInstruction.Cancel,
      });
    });
  });

  describe("prev", () => {
    it("goes back by one and restarts the count (crits 3, 6)", () => {
      expect(reduceCarousel(stateAt(2), prev)).toEqual({
        state: stateAt(1),
        timer: TimerInstruction.Restart,
      });
    });

    it("wraps first → last (crit 4)", () => {
      expect(reduceCarousel(stateAt(0), prev)).toEqual({
        state: stateAt(COUNT - 1),
        timer: TimerInstruction.Restart,
      });
    });

    it("while paused: moves, but cancels rather than restarts (crit 7)", () => {
      expect(reduceCarousel(stateAt(2, true), prev)).toEqual({
        state: stateAt(1, true),
        timer: TimerInstruction.Cancel,
      });
    });
  });

  describe("dot", () => {
    it("lands on the requested slide and restarts the count", () => {
      expect(reduceCarousel(stateAt(0), dot(2))).toEqual({
        state: stateAt(2),
        timer: TimerInstruction.Restart,
      });
    });

    it("lands on the slide already showing and still restarts — a press is a press", () => {
      expect(reduceCarousel(stateAt(2), dot(2))).toEqual({
        state: stateAt(2),
        timer: TimerInstruction.Restart,
      });
    });

    it("while paused: moves, but cancels rather than restarts", () => {
      expect(reduceCarousel(stateAt(0, true), dot(3))).toEqual({
        state: stateAt(3, true),
        timer: TimerInstruction.Cancel,
      });
    });

    it("out of range above: unchanged, keep", () => {
      expect(reduceCarousel(stateAt(1), dot(COUNT))).toEqual({
        state: stateAt(1),
        timer: TimerInstruction.Keep,
      });
    });

    it("out of range below: unchanged, keep — a dot is a target, not an offset, so it does not wrap", () => {
      expect(reduceCarousel(stateAt(1), dot(-1))).toEqual({
        state: stateAt(1),
        timer: TimerInstruction.Keep,
      });
    });

    it("non-integer: unchanged, keep", () => {
      expect(reduceCarousel(stateAt(1), dot(1.5))).toEqual({
        state: stateAt(1),
        timer: TimerInstruction.Keep,
      });
    });
  });

  describe("pointer", () => {
    it("enter: index unchanged, paused, cancel (crit 7)", () => {
      expect(reduceCarousel(stateAt(2), pointerEnter)).toEqual({
        state: stateAt(2, true),
        timer: TimerInstruction.Cancel,
      });
    });

    it("leave: index unchanged, unpaused, restart (crit 7)", () => {
      expect(reduceCarousel(stateAt(2, true), pointerLeave)).toEqual({
        state: stateAt(2),
        timer: TimerInstruction.Restart,
      });
    });
  });

  describe("purity", () => {
    it("never mutates the state it is given", () => {
      const before = stateAt(3);
      const snapshot = { ...before };

      reduceCarousel(before, tick);
      reduceCarousel(before, next);
      reduceCarousel(before, prev);
      reduceCarousel(before, dot(0));
      reduceCarousel(before, pointerEnter);
      reduceCarousel(before, pointerLeave);

      expect(before).toEqual(snapshot);
    });

    it("returns a new state object when something changed", () => {
      const before = stateAt(0);
      expect(reduceCarousel(before, next).state).not.toBe(before);
    });
  });
});
