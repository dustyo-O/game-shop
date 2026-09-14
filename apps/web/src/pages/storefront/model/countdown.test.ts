// @layer: unit
// @spec: 004-storefront-per-the-design
// @regression
/**
 * The countdown behind the banner's auto-advance, under fake timers
 * (technical-considerations §2.2, "Countdown"; §4.1's table).
 *
 * ---------------------------------------------------------------------------
 * THE ONE CASE THIS FILE EXISTS FOR
 * ---------------------------------------------------------------------------
 * *"restart twice → fires once."*
 *
 * The carousel's whole timing story rests on there never being more than one
 * pending timeout: every event becomes one instruction, and `restart` is the
 * instruction that could break that if it merely *added* a timeout instead of
 * replacing the one already counting. Two pending timeouts is a banner that
 * jumps twice within a second of a manual move — crit 6 broken in a way no
 * single-press check would notice, because the first press always looks fine.
 *
 * The RED for this file is to delete the `clearTimeout` in `restart` and watch
 * this case fail with two calls. It is the only mutation that flips it, which
 * is why it is the one worth recording.
 *
 * Fake timers, real module: `vi.useFakeTimers()` replaces the global
 * `setTimeout`/`clearTimeout` the countdown reaches for at call time, so the
 * code under test is the shipped code and the clock is the only thing faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCountdown } from "./countdown.js";

const DELAY_MS = 5000;

describe("createCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("restart twice → fires once — the second restart replaces the first count, it does not add to it", () => {
    const onFire = vi.fn();
    const countdown = createCountdown(onFire);

    countdown.restart(DELAY_MS);
    countdown.restart(DELAY_MS);

    vi.advanceTimersByTime(DELAY_MS * 2);

    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("restart mid-count starts the wait over from that moment (crit 6)", () => {
    const onFire = vi.fn();
    const countdown = createCountdown(onFire);

    countdown.restart(DELAY_MS);
    vi.advanceTimersByTime(3000);
    countdown.restart(DELAY_MS);

    // 4 s after the restart, 7 s after the first call: the first count would
    // have fired by now; the restarted one has a second to go.
    vi.advanceTimersByTime(4000);
    expect(onFire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onFire).toHaveBeenCalledTimes(1);
  });

  it("cancel → never fires", () => {
    const onFire = vi.fn();
    const countdown = createCountdown(onFire);

    countdown.restart(DELAY_MS);
    countdown.cancel();

    vi.advanceTimersByTime(DELAY_MS * 2);

    expect(onFire).not.toHaveBeenCalled();
    expect(countdown.isPending()).toBe(false);
  });

  it("cancel with nothing pending is a no-op", () => {
    const countdown = createCountdown(vi.fn());

    expect(countdown.isPending()).toBe(false);
    expect(() => countdown.cancel()).not.toThrow();
    expect(countdown.isPending()).toBe(false);
  });

  it("isPending reports the slot: false before, true while counting, false after firing", () => {
    const onFire = vi.fn();
    const countdown = createCountdown(onFire);

    expect(countdown.isPending()).toBe(false);

    countdown.restart(DELAY_MS);
    expect(countdown.isPending()).toBe(true);

    vi.advanceTimersByTime(DELAY_MS);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(countdown.isPending()).toBe(false);
  });

  it("the slot is emptied before onFire runs, so a restart from inside onFire is a fresh count", () => {
    // This is how the banner keeps going: the tick's reducer step answers
    // `restart`, and the binding calls `restart(5000)` from inside `onFire`.
    // If the slot were nulled *after* `onFire`, that inner restart would be
    // overwritten to null — `isPending()` would lie, and the next `restart`
    // would have nothing to clear while a timeout was still counting.
    const onFire = vi.fn(() => {
      countdown.restart(DELAY_MS);
    });
    const countdown = createCountdown(onFire);

    countdown.restart(DELAY_MS);

    vi.advanceTimersByTime(DELAY_MS);
    expect(onFire).toHaveBeenCalledTimes(1);
    expect(countdown.isPending()).toBe(true);

    vi.advanceTimersByTime(DELAY_MS);
    expect(onFire).toHaveBeenCalledTimes(2);
    expect(countdown.isPending()).toBe(true);

    countdown.cancel();
    expect(countdown.isPending()).toBe(false);
  });
});
