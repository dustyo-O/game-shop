/**
 * The banner carousel as a pure model: which slide is showing, whether the
 * pointer is resting on the panel, and — for every event — what should happen
 * to the auto-advance timer (functional spec §2.2; technical-considerations
 * §2.2, "Carousel").
 *
 * Nothing in this file touches the DOM or a clock. `ui/banner.ts` turns DOM
 * events into {@link CarouselEvent}s, feeds them through {@link reduceCarousel},
 * paints the returned state, and hands the returned {@link TimerInstruction} to
 * the countdown in `countdown.ts` together with the one number this file never
 * sees: 5000 milliseconds.
 *
 * ---------------------------------------------------------------------------
 * WHY THE REDUCER EMITS A TIMER INSTRUCTION INSTEAD OF THE DOM DECIDING
 * ---------------------------------------------------------------------------
 * The banner's timing rules are small but they interlock: a tick advances *and
 * re-arms*; an arrow press advances *and re-arms from that moment* (§2.2 crit
 * 6) — unless the pointer is on the panel, in which case it advances and the
 * timer stays *off* (crit 7); pointer-enter stops the clock without moving;
 * pointer-leave starts it without moving. Written as separate event handlers,
 * each one would have to know what the others did to the timer, and the
 * invariant that matters — **there is never more than one pending timeout** —
 * would be a property of every handler remembering to clear before it sets.
 *
 * Putting the decision in one function makes it a property of the design: each
 * event produces exactly one instruction, `restart`, `cancel` or `keep`, and
 * the binding does the same three-line thing with it every time. The policy
 * table in technical-considerations §2.2 is then checkable row by row with no
 * browser and no clock (`carousel.test.ts`), and the browser test only has to
 * prove the binding forwards the word.
 *
 * The instruction is a word and not a number on purpose. The reducer knows
 * nothing about milliseconds, so the 5-second figure lives in one place — the
 * call site in `ui/banner.ts` — and a test of the policy is not a test of the
 * duration.
 *
 * ---------------------------------------------------------------------------
 * WRAPPING, AND THE SIGN OF `%`
 * ---------------------------------------------------------------------------
 * "On the last slide, advance → the first" and "on the first, back → the last"
 * (crits 2, 4) are both a modulo, but JavaScript's `%` keeps the sign of the
 * dividend: `-1 % 4` is `-1`. {@link wrapIndex} normalises in the standard
 * way, `((index % count) + count) % count`, so `-1` becomes `3`. A bare `%`
 * would advance correctly forever and break only on the first left-arrow press
 * from slide 1 — which is why that case has its own test.
 *
 * ---------------------------------------------------------------------------
 * A DOT IS A TARGET, AN ARROW IS AN OFFSET
 * ---------------------------------------------------------------------------
 * `next`/`prev` wrap because they are relative — one step past the end *means*
 * the start. A `dot` names a slide by index, so an index that names no slide is
 * ignored rather than wrapped: there is no fourth dot to press on a four-slide
 * banner, and if the DOM ever sent one it would be a bug to paper over.
 */

export interface CarouselState {
  /** The slide showing, `0 … count - 1`. */
  readonly index: number;
  /** How many slides there are; fixed for the life of the carousel. */
  readonly count: number;
  /**
   * Whether the pointer is resting on the slide panel. While true, manual
   * moves still happen but the auto-advance stays off (§2.2 crit 7).
   */
  readonly isPaused: boolean;
}

/**
 * What the DOM saw, stripped of everything but the fact.
 *
 * `tick` is the countdown firing; `next`/`prev` the arrows; `dot` a dot press
 * carrying the slide it names; `pointer-enter`/`pointer-leave` the pointer
 * crossing the slide panel's edge — the panel only, not the arrows, so a mouse
 * user's arrow press can leave the panel and be seen to restart the count
 * (technical-considerations §2.2, "the pause region is the slide panel only").
 */
export type CarouselEvent =
  | { readonly type: "tick" | "next" | "prev" | "pointer-enter" | "pointer-leave" }
  | { readonly type: "dot"; readonly index: number };

/**
 * What the binding should do to the countdown after applying the state.
 * `restart` — clear whatever is pending and count 5 seconds from now;
 * `cancel` — clear and leave nothing pending; `keep` — touch nothing.
 */
export const TimerInstruction = {
  Restart: "restart",
  Cancel: "cancel",
  Keep: "keep",
} as const;

export type TimerInstruction = (typeof TimerInstruction)[keyof typeof TimerInstruction];

/** One reducer step: the state to paint and the one thing to do to the timer. */
export interface CarouselStep {
  readonly state: CarouselState;
  readonly timer: TimerInstruction;
}

/** The first slide showing, nothing paused. Throws if there is no first slide. */
export function createCarouselState(count: number): CarouselState {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`A carousel needs at least one slide; got ${String(count)}`);
  }

  return { index: 0, count, isPaused: false };
}

/** Bring any integer into `0 … count - 1`, negative ones included. */
export function wrapIndex(index: number, count: number): number {
  return ((index % count) + count) % count;
}

function assertNever(value: never): never {
  throw new Error(`Unexpected carousel event: ${JSON.stringify(value)}`);
}

/** A row of the table that does not touch the state: same object, `keep`. */
function unchanged(state: CarouselState): CarouselStep {
  return { state, timer: TimerInstruction.Keep };
}

/**
 * A manual move — arrow or dot: land on the slide, then re-arm the count from
 * this moment (crit 6) unless the pointer is resting on the panel, in which
 * case the clock stays off until it leaves (crit 7).
 */
function moveTo(state: CarouselState, index: number): CarouselStep {
  return {
    state: { ...state, index: wrapIndex(index, state.count) },
    timer: state.isPaused ? TimerInstruction.Cancel : TimerInstruction.Restart,
  };
}

/**
 * The policy table, one branch per row. Pure: the input is never mutated, and
 * a row that changes nothing hands back the same object so a caller can see
 * that it did.
 */
export function reduceCarousel(state: CarouselState, event: CarouselEvent): CarouselStep {
  switch (event.type) {
    case "tick":
      // Defensive: a pointer-enter cancels the timer, so a tick while paused
      // should not arrive. If one does — a fire already queued when the cancel
      // ran — it must not move the slide under a resting pointer.
      if (state.isPaused) {
        return unchanged(state);
      }

      return {
        state: { ...state, index: wrapIndex(state.index + 1, state.count) },
        timer: TimerInstruction.Restart,
      };

    case "next":
      return moveTo(state, state.index + 1);

    case "prev":
      return moveTo(state, state.index - 1);

    case "dot":
      if (!Number.isInteger(event.index) || event.index < 0 || event.index >= state.count) {
        return unchanged(state);
      }

      return moveTo(state, event.index);

    case "pointer-enter":
      return { state: { ...state, isPaused: true }, timer: TimerInstruction.Cancel };

    case "pointer-leave":
      return { state: { ...state, isPaused: false }, timer: TimerInstruction.Restart };

    default:
      return assertNever(event);
  }
}
