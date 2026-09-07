/**
 * Payment event identifiers — `evt_` + ULID.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE PAYMENT PROVIDER'S IDENTIFIER, NOT THE SHOP'S
 * ---------------------------------------------------------------------------
 * `event_id` belongs to whoever emits the event, and in this system that is the
 * simulator standing in for the provider (`architecture.md` §6 — *"a stub
 * endpoint that emits webhooks matching the supplied contract"*). So this file
 * lives in `payments` beside the simulator that calls it, not in `orders`
 * beside `newOrderId`, even though the two are shaped alike: they mint ids for
 * two different systems that happen to be hosted in one process.
 *
 * The assignment's example reads `"event_id": "evt_a1b2c3"`, and the prefix is
 * kept for the reason `./../orders/order-id.ts` gives for `ord_`: an id that
 * carries its own type survives being pasted into the wrong field. `evt_01K…`
 * in an `order_id` column is wrong on sight.
 *
 * ---------------------------------------------------------------------------
 * WHY EVERY CALL PRODUCES A DIFFERENT ONE
 * ---------------------------------------------------------------------------
 * `event_id` is the deduplication key — it is the PRIMARY KEY of
 * `payment_events`, and losing the `ON CONFLICT (event_id)` insert is the whole
 * definition of "redelivery" (invariant I2). A simulator that reused an id
 * would therefore drive the *duplicate* path on its second call and quietly
 * never exercise the first, which is the one bug a payment simulator must not
 * have: every race script asserting "exactly one `stored` out of twenty" would
 * pass for the wrong reason.
 *
 * So a fresh id is the default and a deliberate replay is opt-in — the caller
 * pins `event_id` in the request body (see `./payment-simulator.types.ts`).
 * Monotonic ULIDs rather than `randomUUID()` for the same two reasons order ids
 * are: they sort by mint time as plain strings, so a run of simulated events
 * reads in order, and they are short enough to quote in a log line.
 */
import { monotonicFactory } from "ulid";

/**
 * The type tag every simulated payment event id carries. Exported so a caller
 * that needs to recognise one matches this constant rather than retyping the
 * literal.
 */
export const PAYMENT_EVENT_ID_PREFIX = "evt_";

/**
 * Process-wide and deliberately module-level: the monotonic guarantee is a
 * property of *one factory's* memory of the last id it issued. A factory built
 * per call would forget, and would be `ulid()` with extra steps
 * (`../orders/order-id.ts` carries the full reasoning).
 */
const nextUlid = monotonicFactory();

/**
 * A fresh payment event id, e.g. `evt_01K4J5N8QW9ZP2M7X6VYT3CB0D`.
 *
 * **Never call this to "re-send" an event.** A resend is the same `event_id`,
 * which is why the simulator accepts one rather than minting here unconditionally.
 */
export function newPaymentEventId(): string {
  return `${PAYMENT_EVENT_ID_PREFIX}${nextUlid()}`;
}
