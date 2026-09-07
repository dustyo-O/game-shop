/**
 * Order identifiers — `ord_` + ULID, minted **by this application**.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT A DATABASE SEQUENCE
 * ---------------------------------------------------------------------------
 * The reason is already written down in `packages/db/src/schema/shop.ts`, on
 * `orders.id`: *the same id has to be quotable in a webhook payload before the
 * row is ever written*. `payment_events.order_id` carries no foreign key for
 * exactly that reason (architecture.md §4, "Out-of-order tolerance"), and an
 * event naming an order that does not exist yet is a **normal path**. A
 * `bigserial` cannot produce an id before its row exists, so the identity has to
 * be something the application can hold in its hand first.
 *
 * ---------------------------------------------------------------------------
 * WHY A ULID RATHER THAN A UUIDv4
 * ---------------------------------------------------------------------------
 * A ULID is 48 bits of millisecond timestamp followed by 80 bits of randomness,
 * Crockford-base32 encoded into 26 characters. Two consequences the project uses:
 *
 *   - **It sorts by creation time as a plain string.** `ORDER BY id` is
 *     `ORDER BY created_at` without an index on a second column, which is what
 *     technical-considerations §2.2 asks for ("a prefixed sortable string ... so
 *     it sorts by creation time"). A UUIDv4 sorts by nothing at all.
 *   - **It reads like the assignment's `ord_00123`** — a short opaque token a
 *     shopper can put in a support message, rather than 36 hyphenated hex
 *     characters.
 *
 * The prefix is not decoration either: an id that carries its own type survives
 * being pasted into the wrong field. `ord_01K...` in a `request_id` column is
 * obvious on sight, where a bare ULID would look at home anywhere.
 *
 * ---------------------------------------------------------------------------
 * WHY `monotonicFactory()` RATHER THAN `ulid()`
 * ---------------------------------------------------------------------------
 * Plain `ulid()` draws fresh randomness every call, so two ids minted in the
 * *same millisecond* share a timestamp and are ordered by their random tails —
 * which is to say, not ordered at all. `monotonicFactory()` keeps the previous
 * id and increments its random component when the clock has not moved, so ids
 * from this process always ascend, including within one millisecond.
 *
 * The honest limit: that guarantee is **per process**. Two serverless instances
 * minting in the same millisecond can produce ids whose order does not match
 * their true order (architecture.md §5 — two concurrent requests are two
 * processes). Nothing here depends on cross-process ordering; `orders.created_at`
 * is stamped by the database's clock and is the authority whenever the exact
 * sequence actually matters.
 *
 * Randomness comes from `node:crypto` — the `ulid` package's Node entry point
 * selects it rather than `Math.random()`.
 */
import { monotonicFactory } from "ulid";

/**
 * The type tag every order id carries. Exported so a caller that needs to
 * recognise one — a route guard, a log filter, the Phase 3 admin view — matches
 * against this constant rather than retyping the literal.
 */
export const ORDER_ID_PREFIX = "ord_";

/**
 * Process-wide, and deliberately module-level: the monotonic guarantee above is
 * a property of *one factory's* memory of the last id it issued. A factory built
 * per call would forget, and would be exactly `ulid()` with extra steps.
 */
const nextUlid = monotonicFactory();

/**
 * A fresh order id, e.g. `ord_01K4J5N8QW9ZP2M7X6VYT3CB0D` — 30 characters, safe
 * in a URL path with no escaping.
 */
export function newOrderId(): string {
  return `${ORDER_ID_PREFIX}${nextUlid()}`;
}
