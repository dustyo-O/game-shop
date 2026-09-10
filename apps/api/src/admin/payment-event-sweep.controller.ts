/**
 * `POST /api/admin/payment-events/sweep` — **processing trigger 4**, the admin
 * sweep (`architecture.md` §4, *"an admin sweep endpoint drains everything
 * still pending"*; technical-considerations §2.2, the `Sweep` row).
 *
 * ---------------------------------------------------------------------------
 * THE ONLY TRIGGER THAT IS NOT TIED TO SOMETHING HAPPENING
 * ---------------------------------------------------------------------------
 * The other three are each attached to an event in the shop's life, and that is
 * also their limit:
 *
 *   | Trigger                       | Needs                                    |
 *   | ----------------------------- | ---------------------------------------- |
 *   | 1. webhook continuation       | a webhook to have arrived, and the process to survive |
 *   | 2. order creation drain       | that order to be created *after* the event |
 *   | 3. order status poll drain    | somebody to be looking at that order      |
 *   | 4. **this**                   | nothing                                   |
 *
 * An event whose order nobody has open, whose creation drain was lost to a
 * `SIGTERM`, and whose webhook continuation was abandoned at shutdown has no
 * other route back into processing. That is the whole job: *"the backstop for
 * everything the above missed"*, and the reason `architecture.md` can say the
 * four are layered **so that no single one is load-bearing**.
 *
 * It is also what settles the rows Phase 1 left pending on purpose.
 * Technical-considerations §2.2 names them — *"the nineteen pending events"* —
 * every losing copy of a contested `paid` event, unsettleable at the time
 * because a caller that lost the claim cannot establish whether anyone else is
 * still working. This endpoint re-examines each, finds the order now
 * `delivered`, and marks it processed as a `no_op`.
 *
 * ---------------------------------------------------------------------------
 * THE STATEMENT UNDERNEATH — `architecture.md` §3.1, "Draining the inbox"
 * ---------------------------------------------------------------------------
 * This controller issues no query of its own. It calls
 * {@link PaymentEventDrainService.drainPending}, whose opening claim is §3.1's
 * statement letter for letter — the sweep is the caller that form was written
 * for, since it is the only one with no `order_id` to add:
 *
 *   SELECT * FROM payment_events
 *   WHERE processed_at IS NULL
 *   ORDER BY received_at
 *   FOR UPDATE SKIP LOCKED
 *   LIMIT 1;
 *   -- 0 rows => nothing pending, or every pending row is held by another
 *   --           worker. Both mean "not my work"; NEITHER IS AN ERROR.
 *
 * `SKIP LOCKED` is what makes two operators (or two function instances) able to
 * sweep at the same instant without either of them handling an event the other
 * is already handling. It is also why `stopped_by: "queue_empty"` is not a
 * promise that the inbox is empty — a row another worker holds right now is
 * stepped over, not counted.
 *
 * ###########################################################################
 * # THE SWEEP DOES ITS WORK BEFORE ANSWERING. THAT IS THE OPPOSITE OF
 * # TRIGGERS 2 AND 3, AND IT IS DELIBERATE.
 * ###########################################################################
 *
 * `OrderCreationDrain` and `OrderStatusPollDrain` both schedule their drain
 * through `CONTINUATION_SCHEDULER` and return immediately, because a shopper is
 * on the other end of those responses and a drain that finds a `paid` event
 * runs issuance, which is a supplier round trip over real HTTP. Making a
 * shopper wait for that is the exact problem Slice 2 removed from the webhook.
 *
 * Nobody is waiting here except the person who asked for the work. So this
 * endpoint `await`s, for three reasons that all point the same way:
 *
 *   1. **The report is the deliverable.** *"Report what it did in the
 *      response"* — a scheduled sweep could only answer `202 { started: true }`,
 *      which tells an operator nothing about whether anything was actually
 *      pending and tells a reviewer nothing at all.
 *   2. **A reviewer has to be able to drive it** (functional spec §2.6). A
 *      check that sweeps and then asserts must know the sweep finished;
 *      otherwise it has to sleep, and a sleep in a race script is precisely
 *      what makes a check flaky rather than evidential.
 *   3. **A `SIGTERM` mid-sweep should be visible.** Scheduled work that is
 *      abandoned leaves a log line and a caller who thinks it succeeded. An
 *      awaited sweep drops the caller's connection, which is the honest signal
 *      — and the rows are still pending either way, because that is what the
 *      inbox is.
 *
 * The cost of awaiting is a long request, and that is what the bound below is
 * for.
 *
 * ###########################################################################
 * # WHY THIS LOOPS, AND WHY THE LOOP IS BOUNDED THREE WAYS
 * ###########################################################################
 *
 * `drainPending()` claims at most `MAX_EVENTS_PER_PASS` (100) events and then
 * returns `pass_limit_reached`, which its own documentation describes as *"a
 * caller's cue to run another pass if it wants to — an admin sweep loops until
 * it sees anything else"*. One pass is therefore not "drains everything still
 * pending"; a queue of 150 would be answered with 100 and a shrug.
 *
 * But `while (pass_limit_reached)` on its own is wrong in two different ways,
 * and only the first is obvious.
 *
 * ### 1. Arrivals. The queue can grow faster than the sweep drains it.
 *
 * An endpoint that keeps going until the inbox is empty has handed its
 * termination condition to the payment provider. Under sustained load the
 * request never returns, holds this instance's single pooled connection for the
 * whole of it, and on a platform is killed at the function ceiling — no
 * response, no report, and an operator who cannot tell a hung sweep from a busy
 * one. Hence {@link MAX_EVENTS_PER_SWEEP}: a ceiling on the *work*, not on the
 * queue, after which the endpoint answers honestly with `more_pending: true`.
 * Calling it again is safe and is the intended remedy — every guarantee is in
 * Postgres, so a second sweep re-running a claim is a handful of statements
 * that match nothing.
 *
 * ### 2. **The exclusion list does not survive a pass**, and this is the subtle one.
 *
 * A pass excludes the events it has already been handed (`event_id <> ALL($n)`)
 * so that a permanently-unsettleable row at the head of the queue does not get
 * handed back forever — *loop control, not exclusion*, in the drain's own
 * words. That list lives inside one call and is discarded when it returns.
 *
 * So consider 100 events for orders that do not exist (`deferred_order_missing`
 * — claimed, considered, deliberately left pending), and 50 settleable events
 * behind them. Pass 1 claims the same 100, settles none, and reports
 * `pass_limit_reached`. Pass 2 starts with an empty exclusion list, orders by
 * `received_at`, and claims **the same 100 again**. A naive loop would do that
 * until the platform killed it, never reaching event 101 and never returning.
 *
 * The bound above would eventually stop it, but only after 900 wasted claims.
 * The precise fix is a **progress condition**: a pass that hit its limit and
 * settled *nothing* has removed nothing from the queue, so the next pass sees
 * the identical queue and will do the identical thing. Stop, and say
 * `more_pending: true`. That is not a failure to report — it is the incident
 * report, and it is exactly the shape an operator needs: *"the head of your
 * queue is stuck; 100 events are waiting on orders that never arrived."*
 *
 * A pass that settled even one row did shorten the queue, so another pass
 * reaches at least one row further, and the loop makes progress by
 * construction.
 *
 * ### 3. The pass's own reason, unchanged
 *
 * `queue_empty` and `processing_failed` both end the sweep on the first pass
 * that sees them, exactly as they end a pass. `processing_failed` is *not* an
 * error here either: the event is still pending by construction, the sweep
 * reports it, and the next trigger — including the next sweep — retries it.
 *
 * ---------------------------------------------------------------------------
 * WHY `/api` AND NOT `/internal`
 * ---------------------------------------------------------------------------
 * `/internal` is not a privacy namespace in this codebase, and reading it as
 * one would be the mistake. It holds exactly one thing — the simulated supplier
 * — and it holds it because that endpoint is *"a different service that happens
 * to share a process"*, reached by the shop over real HTTP through
 * `SUPPLIER_A_URL` (`../suppliers/a/supplier-a.controller.ts`). It is no less
 * reachable than `/api`: `apps/web`'s dev server proxies both, and nothing
 * about the prefix authenticates anything.
 *
 * The sweep is not a foreign service. It is the shop's own operational surface,
 * called by the shop's operator, and `architecture.md` §6 already files it
 * under *"the admin panel"* — which Phase 3 grows into a paid-but-undelivered
 * list and a manual retry, both of which belong beside this one at
 * `/api/admin/…`. Putting it under `/internal` would say it was somebody else's
 * service, and would also imply the prefix was doing security work that the
 * bearer token is in fact doing alone.
 *
 * `POST`, not `GET`: it moves orders, calls suppliers and binds keys. A `GET`
 * that issued a key would be reachable by a crawler, a prefetch, a link
 * preview, or a browser restoring a tab.
 */
import {
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UseGuards,
} from "@nestjs/common";

import {
  DrainStopReason,
  PaymentEventDrainService,
  type DrainResult,
} from "../payments/payment-event-drain.service.js";
import { AdminTokenGuard } from "./admin-token.guard.js";
import type { PaymentEventSweepReport } from "./payment-event-sweep.types.js";

/**
 * The most events one call to this endpoint will claim, across every pass.
 *
 * A thousand because it is comfortably more than any scenario this system is
 * built to demonstrate — fifty simultaneous webhooks is the assignment's
 * headline number, and the Phase 1 residue is nineteen rows — while still being
 * a number an operator can hold: an inbox with more than a thousand pending
 * events is an incident, and the useful answer to an incident is *"I did a
 * thousand and there is more"*, not a request that never returns.
 *
 * Deliberately a bound on **events and not on seconds**. A deadline would end
 * the sweep somewhere different on every call depending on how slow the
 * supplier happened to be that minute, which makes the endpoint's report
 * unreproducible — and unreproducible is the one thing a reviewer's evidence
 * must not be. The per-event wall-clock is already bounded elsewhere, by
 * `SUPPLIER_TIMEOUT_MS`, and a pass stops on the first processing failure
 * anyway, so the pathological "every event takes the full timeout and still
 * succeeds" case needs a supplier that is slow and healthy at once.
 */
const MAX_EVENTS_PER_SWEEP = 1000;

@Controller("api/admin/payment-events")
// On the controller rather than the handler: every route this class ever grows
// is behind the token, and a guard that has to be remembered per method is a
// guard that will eventually be forgotten on one.
@UseGuards(AdminTokenGuard)
export class PaymentEventSweepController {
  private readonly logger = new Logger(PaymentEventSweepController.name);

  constructor(
    // The drain is `PaymentsModule`'s only export, precisely so that the three
    // triggers outside it inject the service that owns the claim rather than
    // writing a second `FOR UPDATE SKIP LOCKED` of their own.
    private readonly drain: PaymentEventDrainService,
  ) {}

  /**
   * Drain everything pending, then report what happened.
   *
   * **`200`, not Nest's `@Post` default of `201`.** Nothing is created: this is
   * an instruction to do work that has already been recorded, and the response
   * is a report rather than a new resource with an address.
   *
   * ### There is no transaction here, and there must not be
   *
   * `PaymentEventDrainService.runPass` opens several of its own, and the pool is
   * `max: 1` per instance — a caller holding the connection would wait
   * `CONNECTION_TIMEOUT_MS` for a connection it is itself holding, then fail
   * with an error naming a timeout rather than its cause. This handler holds
   * nothing; it awaits passes, in sequence, each of which begins and commits its
   * own claim.
   *
   * ### Sequential passes, never `Promise.all`
   *
   * Two passes started at once inside *this* process would contend for that
   * single connection and serialise anyway — and worse, each would build its own
   * exclusion list, so they would hand each other's rows back and forth. The way
   * to sweep faster is more processes, which `SKIP LOCKED` already handles: N
   * instances take N different rows and none of them blocks.
   */
  @Post("sweep")
  @HttpCode(HttpStatus.OK)
  async sweep(): Promise<PaymentEventSweepReport> {
    const startedAt = Date.now();

    let claimed = 0;
    let settled = 0;
    let passes = 0;
    let pass: DrainResult;

    do {
      pass = await this.drain.drainPending();

      passes += 1;
      claimed += pass.claimed;
      settled += pass.settled;
    } while (this.shouldRunAnotherPass(pass, claimed));

    const report: PaymentEventSweepReport = {
      claimed,
      settled,
      left_pending: claimed - settled,
      passes,
      stopped_by: pass.stoppedBy,
      // Only a pass that ran out of rows to claim saw the end of the queue.
      // Every other ending — the pass limit, the sweep's own cap, no progress,
      // a processing failure — left work behind. Pessimistic by design: see
      // `PaymentEventSweepReport.more_pending`.
      more_pending: pass.stoppedBy !== DrainStopReason.QueueEmpty,
      duration_ms: Date.now() - startedAt,
    };

    // Always logged, and at `log`: an operator asked a question and the answer
    // is news whatever it is, including "nothing was pending".
    //
    // No `order_id` or `event_id` on this line, and that is not an exception to
    // `architecture.md` §8 — the sweep concerns no single order or event. The
    // per-event lines that carry both ids are the drain's ("claimed a pending
    // event") and the processor's, one per event this pass touched, and they are
    // what a reader follows from this summary into a specific order.
    this.logger.log({ msg: "admin payment-event sweep finished", ...report });

    return report;
  }

  /**
   * Whether the sweep has a reason to run another pass. The three bounds from
   * the header, in the order they can fire.
   *
   * Returning `false` never loses anything: every row not reached is still in
   * `payment_events` with `processed_at` NULL, still in the partial index, and
   * still findable by this endpoint's next call and by the other three
   * triggers.
   */
  private shouldRunAnotherPass(pass: DrainResult, claimedSoFar: number): boolean {
    // The pass saw the end of the queue, or stopped on a processing failure.
    // Either way another pass is not what happens next.
    if (pass.stoppedBy !== DrainStopReason.PassLimitReached) return false;

    // No progress: this pass claimed its limit and settled nothing, so the queue
    // is exactly as it was and the next pass — starting with an empty exclusion
    // list — would claim the identical rows. See the header, bound 2.
    if (pass.settled === 0) return false;

    // The sweep's own ceiling on total work. See the header, bound 1.
    return claimedSoFar < MAX_EVENTS_PER_SWEEP;
  }
}
