/**
 * The loop behind the order page's live updates: run something, wait, run it
 * again, and stop when it says so or when the page goes away
 * (technical-considerations §2.6 — *"the order page polls `GET /api/orders/:id`
 * every second while the order is in a non-terminal state"*).
 *
 * ---------------------------------------------------------------------------
 * WHY IT LIVES IN THE PAGE SLICE
 * ---------------------------------------------------------------------------
 * Polling is behaviour, so it does not belong to `entities/order`, whose job is
 * an order's data and how that data looks. It is not a `feature` either: a
 * feature is *one thing a shopper does*, and nobody does this — the shopper
 * stands still and the page keeps itself current. What it actually is, is one
 * page's lifecycle, so it belongs to that page.
 *
 * And it stays *inside* the slice rather than in `shared/lib`, even though not a
 * line of it mentions an order: shared code earns its place by being used twice,
 * and this is used once. The catalogue does not poll and neither does anything
 * else. When a second page needs it, this file moves down a layer unchanged.
 *
 * ---------------------------------------------------------------------------
 * WHY `setTimeout` AFTER EACH RUN AND NOT `setInterval`
 * ---------------------------------------------------------------------------
 * `setInterval(fn, 1000)` fires on a wall clock that knows nothing about the
 * request it started. A shop that takes two seconds to answer would get a second
 * request on top of the first, then a third, and the page would render whichever
 * happened to land last — including, in the wrong order, an older state after a
 * newer one. Chaining the next wait off the *completion* of the previous run
 * makes overlap impossible by construction: there is never more than one read in
 * flight, the answers arrive in the order they were asked for, and a failing run
 * waits exactly as long as a successful one, so nothing can spin.
 *
 * "Once per second" therefore means *a second of quiet between reads*, which is
 * the reading that keeps a slow or unreachable API from being hammered.
 */

/** What one run of the polled work decided about the next one. */
export const PollDecision = {
  /** There is more to see: run again after the interval. */
  Continue: "continue",
  /** Nothing further will change: stop, and release the timer and the signal. */
  Stop: "stop",
} as const;

export type PollDecision = (typeof PollDecision)[keyof typeof PollDecision];

export interface PollOptions {
  /** Quiet time between the end of one run and the start of the next. */
  readonly intervalMs: number;

  /**
   * The polled work.
   *
   * Given the poll's {@link AbortSignal}, which is aborted by {@link Poll.stop}
   * — pass it to `fetch` so a read still in flight when the page goes away is
   * cancelled rather than left to resolve into a page nobody is looking at, and
   * check `signal.aborted` before treating the resulting rejection as a failure
   * worth showing anyone.
   *
   * Expected to handle its own failures and answer with a decision rather than
   * rejecting; a rejection is treated as a bug and the loop keeps running, on
   * the grounds that a page which stops updating is worse than one that missed
   * a beat.
   */
  readonly run: (signal: AbortSignal) => Promise<PollDecision>;
}

export interface Poll {
  /** Run once now, then keep running until something stops it. */
  readonly start: () => void;

  /**
   * Run now instead of waiting out the current interval — for when something
   * already knows the answer has probably changed, such as a payment that has
   * just been accepted.
   *
   * Never starts a second concurrent run: if one is in flight, this is
   * remembered and applied the moment it finishes.
   */
  readonly refreshNow: () => void;

  /**
   * Stop for good. Idempotent, and safe to call from anywhere — including from
   * inside {@link PollOptions.run}.
   *
   * Cancels the pending wait, aborts the signal (and with it any request still
   * in flight), and drops the `pagehide` listener. Nothing schedules afterwards.
   */
  readonly stop: () => void;
}

/**
 * Build a poll. It does nothing until {@link Poll.start}.
 *
 * **It stops itself when the document goes away.** `pagehide` fires when the
 * browser navigates away, reloads, or puts the page in the back/forward cache —
 * the last moment a page reliably gets. Stopping there is what keeps a poll from
 * outliving the page that wanted it: the timer is cleared and the in-flight read
 * is aborted rather than resolving against a document on its way out.
 *
 * That is the belt. The braces are the caller's: {@link PollOptions.run} decides
 * whether there is still anyone to render for, and answers `Stop` when there is
 * not — which is what would end the loop if a page were ever detached without
 * the document unloading.
 */
export function createPoll(options: PollOptions): Poll {
  const controller = new AbortController();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let isRunning = false;
  let isRefreshPending = false;
  let isStopped = false;

  function stop(): void {
    if (isStopped) {
      return;
    }

    isStopped = true;

    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }

    controller.abort();
    window.removeEventListener("pagehide", stop);
  }

  function scheduleIn(delayMs: number): void {
    if (isStopped || isRunning || timer !== null) {
      return;
    }

    timer = setTimeout(() => {
      timer = null;
      // Fire-and-forget: `runOnce` handles every outcome itself and never rejects.
      void runOnce();
    }, delayMs);
  }

  async function runOnce(): Promise<void> {
    isRunning = true;

    let decision: PollDecision = PollDecision.Continue;

    try {
      decision = await options.run(controller.signal);
    } catch {
      // `run` is documented not to reject, so this is a bug in the caller rather
      // than a failure of the polled work. Keeping the loop alive turns it into
      // a missed beat instead of a page that silently stopped updating — and it
      // costs nothing, because the next run is a whole interval away either way.
      decision = PollDecision.Continue;
    } finally {
      isRunning = false;
    }

    if (isStopped) {
      return;
    }

    if (decision === PollDecision.Stop) {
      stop();
      return;
    }

    const runAgainImmediately = isRefreshPending;
    isRefreshPending = false;

    scheduleIn(runAgainImmediately ? 0 : options.intervalMs);
  }

  return {
    start(): void {
      if (isStopped || isRunning || timer !== null) {
        return;
      }

      window.addEventListener("pagehide", stop);

      // Straight into the first run rather than through `scheduleIn(0)`: the
      // first read is the page's initial load, and it should leave with the same
      // urgency it had before there was a loop around it.
      void runOnce();
    },

    refreshNow(): void {
      if (isStopped) {
        return;
      }

      if (isRunning) {
        isRefreshPending = true;
        return;
      }

      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }

      void runOnce();
    },

    stop,
  };
}
