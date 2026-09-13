/**
 * The banner's auto-advance clock: wait, fire once, and do nothing more until
 * told to count again (technical-considerations §2.2, "Countdown").
 *
 * `ui/banner.ts` calls {@link Countdown.restart} with 5000 whenever the
 * reducer answers `restart`, {@link Countdown.cancel} whenever it answers
 * `cancel`, and nothing at all on `keep`. `onFire` is the binding's "dispatch a
 * tick", whose reducer step answers `restart` again — so the loop is the
 * reducer's doing, not this file's. This file waits and fires; it does not
 * repeat.
 *
 * ---------------------------------------------------------------------------
 * ONE SLOT
 * ---------------------------------------------------------------------------
 * There is exactly one place a timeout handle can live, `timer`, and
 * {@link Countdown.restart} always clears it before it sets it. That is the
 * whole mechanism behind "never more than one pending timeout": the reducer
 * emits one instruction per event, and the only instruction that can create a
 * timeout first destroys the one before it. Nothing here needs to know *why* a
 * restart came — a tick, an arrow, a dot, the pointer leaving the panel — because
 * every one of them is the same operation on the same slot.
 *
 * When the timeout fires, the slot is emptied *before* `onFire` runs. The order
 * matters: `onFire` dispatches a tick, the tick's step says `restart`, and that
 * restart sets a fresh timeout into the slot. Nulling afterwards would overwrite
 * that fresh handle with `null` — `isPending()` would say nothing is counting
 * while something was, and the next restart would find nothing to clear.
 *
 * ---------------------------------------------------------------------------
 * NOT A GENERALISATION OF `pages/order/model/poll.ts`
 * ---------------------------------------------------------------------------
 * Both files own a timeout handle and both clear it on the way out, and that is
 * where the resemblance ends. The poll runs its work *immediately* and chains
 * the next wait off the *completion* of async work, carries an `AbortSignal`
 * for a request in flight, and must never resume after the page comes back
 * from the back/forward cache. This countdown waits *before* its first fire,
 * does synchronous work, has pause, resume and restart, and *must* resume on
 * `pageshow`. One abstraction over both would have to expose every one of
 * those differences as an option, and the contract `poll.ts` documents so
 * carefully would blur into a parameter list.
 *
 * Page lifecycle is not this file's concern either: `pagehide` cancels and
 * `pageshow` restarts, and both are `ui/banner.ts`'s to wire, because they are
 * about the page and this is about a number of milliseconds.
 */

export interface Countdown {
  /**
   * Count `ms` from now, replacing whatever was counting. Fires `onFire` once
   * when the time is up. Calling it again before then starts over — it never
   * stacks.
   */
  readonly restart: (ms: number) => void;

  /** Stop counting and leave nothing pending. Safe to call when idle. */
  readonly cancel: () => void;

  /** Whether a timeout is currently counting. */
  readonly isPending: () => boolean;
}

/** Build a countdown. Nothing is scheduled until {@link Countdown.restart}. */
export function createCountdown(onFire: () => void): Countdown {
  /**
   * The one slot. `null` means nothing is counting; anything else is the handle
   * of the single pending timeout, which `restart` clears before it sets and
   * the fire callback empties before it calls out.
   */
  let timer: ReturnType<typeof setTimeout> | null = null;

  return {
    restart(ms: number): void {
      if (timer !== null) {
        clearTimeout(timer);
      }

      timer = setTimeout(() => {
        timer = null;
        onFire();
      }, ms);
    },

    cancel(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },

    isPending(): boolean {
      return timer !== null;
    },
  };
}
