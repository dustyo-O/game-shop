/**
 * The simulated supplier's key issuance — **invariants I5 and I6**
 * (`architecture.md` §3, §3.1; technical-considerations §2.5 step 4).
 *
 * ---------------------------------------------------------------------------
 * THIS FILE IS THE SUPPLIER, NOT THE SHOP
 * ---------------------------------------------------------------------------
 * It reads and writes `supplier_keys` and `supplier_requests` and nothing else.
 * It imports no shop table, knows nothing about orders, deliveries or issuance
 * attempts, and treats `order_id` as an opaque string it logs and forgets.
 * `packages/db/src/schema/supplier.ts` states the rule the other way round —
 * *if shop code ever imports that file, that is the bug* — and this is the
 * matching half: the only thing that ever crosses the boundary is a code, in an
 * HTTP response, which the shop then has to believe or not on its own.
 *
 * It is not under `suppliers/a/` on purpose. There is one pool and one ledger:
 * `supplier_keys` has no provider column at all, so Phase 3's supplier B draws
 * from exactly this inventory through exactly this code. The *ledger* does
 * record who answered — `supplier_requests.provider`, migration 0002 — and
 * {@link SupplierKeyClaimService.readLedger} reads it, so the shared table
 * still answers each supplier only about its own requests. What differs between
 * A and B is the *endpoint* and its injected failure behaviour — that is what
 * `suppliers/a` (§2.4) is for.
 *
 * ---------------------------------------------------------------------------
 * THE PROPERTY THE WHOLE PHASE 3 TRAP RESTS ON
 * ---------------------------------------------------------------------------
 * From the assignment: *«На повтор с тем же `request_id` поставщик обязан
 * вернуть тот же самый код, а не выдать новый»* — and therefore *«таймаут ≠
 * отказ»*. A client whose call timed out does not know whether a key was issued.
 * It may only retry safely because this service promises that the same
 * `request_id` yields the same code forever, so a retry either learns the
 * original answer or issues for the first time. Take that promise away and the
 * only safe response to a timeout is to give up, which is how a paid order ends
 * with no key — or, worse, with two.
 *
 * The promise is a *stored* one, not a remembered one. `supplier_requests` is on
 * disk, so it survives the process, and two concurrent copies of the same
 * request meet in the same row rather than in two instances' memory.
 *
 * ---------------------------------------------------------------------------
 * TWO WRITES, ONE TRANSACTION — AND WHY THAT IS THE WHOLE FIX
 * ---------------------------------------------------------------------------
 * Issuing for the first time means writing twice: claim the key, then record
 * `request_id → code`. Between those two writes lies a state that must never be
 * observable:
 *
 *     supplier_keys:     one row claimed_by_request_id = R
 *     supplier_requests: no row for R
 *
 * A retry with R would find nothing in the ledger, conclude "first sight", and
 * try to claim again — the exact double-issue this service exists to prevent,
 * produced by a crash rather than by a race. So the two writes are one
 * transaction (`BEGIN … COMMIT`, see {@link SupplierKeyClaimService.issue}).
 * There is then no "between": a process that dies mid-flight leaves the claim
 * rolled back by Postgres, the key unclaimed, and the retry issues once. The
 * state above is not *handled*, it is *unreachable* — which is why this file has
 * no repair path for it and should never grow one.
 *
 * `supplier_keys.claimed_by_request_id` UNIQUE is the second, independent layer
 * underneath, and it is what makes the fix defensible rather than merely
 * plausible. The transaction is code, and code can be changed; the constraint
 * holds regardless. Even with the two writes torn apart, R could never end up
 * holding two keys — the second claim would raise `23505` instead of quietly
 * draining the pool. That is the direction of the constraint that matters here:
 * *one request can never hold two keys.* (The other direction — one key can
 * never have two claimants — is structural, since the row has one
 * `claimed_by_request_id` column.)
 *
 * Alternatives considered:
 *
 *   - **Drop `supplier_requests` and read `supplier_keys` by
 *     `claimed_by_request_id`.** One write, so no window at all — the UNIQUE
 *     index already *is* a `request_id → code` map. Declined: §2.2 and §3.1
 *     specify the ledger as the supplier's own table and I5 reads it, and a real
 *     supplier's ledger outlives the inventory row it points at.
 *   - **Leave the writes separate and repair on read** — on a ledger miss, look
 *     for a key already claimed by R and adopt it. Also correct, and strictly
 *     more code: it leaves torn rows on disk and then reasons about them, where
 *     the transaction stops them existing.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE
 * ---------------------------------------------------------------------------
 * No HTTP, no controller: `suppliers/a` supplies those next. No failure or
 * timeout injection — technical-considerations §1 builds *"only supplier A,
 * always succeeding"* in this phase, so the only way this call does not produce
 * a code is an empty pool. Phase 3 adds configurable failure and timeout rates
 * at the endpoint, above this service, so the guarantees below stay exactly as
 * they are.
 */
import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";

import {
  supplierKeys,
  supplierRequests,
  type Database,
  type DatabaseClient,
  type Transaction,
} from "@game-shop/db";

import { DATABASE_CLIENT } from "../database/database.module.js";

/**
 * Which simulated supplier is answering — the value written to
 * `supplier_requests.provider`.
 *
 * **Not part of the request.** It is not on the wire and the shop never sends
 * it: the provider is the *endpoint*, `/internal/suppliers/a/issue` or
 * `/internal/suppliers/b/issue`, so each controller states its own identity and
 * this service records it. A supplier that had to be *told* which supplier it
 * was would be a strange thing to trust.
 *
 * Declared here rather than imported from `../issuance/issuance-request-id.ts`,
 * which is shop-side code: the whole point of `packages/db/src/schema/supplier.ts`'s
 * header is that the two sides share a database only as a convenience of
 * running one container. They must not share types either — the `{provider}`
 * segment agreeing across the boundary is a fact about the wire, not a fact the
 * compiler should be asked to enforce from one side of it.
 *
 * An `as const` object rather than a TypeScript `enum`, per the project rule: no
 * runtime class, and it compares equal to the plain strings Postgres hands back
 * from a `text` column.
 */
export const SupplierProvider = {
  A: "a",
  B: "b",
} as const;

export type SupplierProvider = (typeof SupplierProvider)[keyof typeof SupplierProvider];

/**
 * What the supplier was asked for.
 *
 * camelCase, because this is the domain call — the snake_case wire shape is
 * `SupplierIssueRequest` in `@game-shop/contracts` and the controller maps
 * between them. Only `requestId` is load-bearing.
 */
export interface SupplierKeyClaimRequest {
  /**
   * **The only field that decides anything.** The supplier's answer is a pure
   * function of it (I5): same id, same code, forever.
   */
  readonly requestId: string;
  /**
   * The SKU asked for. Correlation and logging only: the pool is undifferentiated
   * — `supplier_keys` has no `sku` column, and the assignment's fifty codes are
   * interchangeable — so no query below reads this.
   */
  readonly sku: string;
  /**
   * The shop's order id. Passed through as data and logged; never stored, never
   * joined, never interpreted. The supplier has no idea what an order is.
   */
  readonly orderId: string;
}

/**
 * Which of the three things happened.
 *
 * Named values rather than `string | null`, matching {@link OrderTransitionService}
 * and {@link PaymentEventsService}: the caller's `switch` reads as three pieces
 * of news and the compiler has something to be exhaustive about.
 *
 * **None of the three is an error, and the caller needs no `try`/`catch` to tell
 * them apart.** An empty pool in particular is an ordinary outcome — the
 * assignment's out-of-stock scenario is *produced* by draining it — so it is a
 * branch of the return type, not an exception.
 */
export const SupplierKeyClaimOutcome = {
  /** **First issue for this `request_id`.** This call claimed the key. */
  Issued: "issued",
  /**
   * This `request_id` had already been answered; the code below is the one it
   * was answered with the first time. No key was claimed by this call.
   */
  AlreadyIssued: "already_issued",
  /**
   * The pool is empty. Nothing was claimed and **nothing was written to the
   * ledger** — so this `request_id` is still unanswered, and a retry with it
   * once the pool is restocked issues normally. That is what makes the Phase 3
   * recovery of an `out_of_stock` order go through this same idempotent path
   * rather than needing a new identifier.
   */
  OutOfStock: "out_of_stock",
} as const;

export type SupplierKeyClaimOutcome =
  (typeof SupplierKeyClaimOutcome)[keyof typeof SupplierKeyClaimOutcome];

/**
 * The result of asking the supplier to issue.
 *
 * A discriminated union on `outcome`. The two success branches carry `code`
 * under the same name because they are the same news to the shop — over the
 * wire both are `{ status: "ok", request_id, code }`, and the contract says so:
 * *"Both cases are indistinguishable by design."* They stay distinct in here
 * because the difference is exactly what a log line, a test and the walkthrough
 * need to see: `already_issued` on a retry is the timeout trap being survived.
 *
 * `out_of_stock` carries no `code`, so `result.code` does not type-check until
 * the caller has narrowed — the empty pool cannot be skipped by accident, only
 * refused on purpose.
 */
export type SupplierKeyClaimResult =
  | {
      readonly outcome: typeof SupplierKeyClaimOutcome.Issued;
      /** The key just claimed, as `RETURNING code` produced it. */
      readonly code: string;
    }
  | {
      readonly outcome: typeof SupplierKeyClaimOutcome.AlreadyIssued;
      /** The code the ledger already held for this `request_id`. */
      readonly code: string;
    }
  | {
      readonly outcome: typeof SupplierKeyClaimOutcome.OutOfStock;
      readonly requestId: string;
    };

/**
 * `unique_violation` — Postgres SQLSTATE 23505.
 *
 * Two constraints in this file's world can raise it, and both mean the same
 * thing to the caller: *another transaction has already answered this
 * `request_id`*. See {@link SupplierKeyClaimService.issue}.
 */
const POSTGRES_UNIQUE_VIOLATION = "23505";

/** Enough to walk Drizzle's wrapper and one or two layers under it; bounded so a cyclic `cause` cannot spin. */
const MAX_CAUSE_DEPTH = 8;

/**
 * Does this error — or anything in its `cause` chain — carry SQLSTATE 23505?
 *
 * **The chain is the whole point, and it is not decoration.** Drizzle wraps
 * every driver error in a `DrizzleQueryError` whose message is the failed SQL
 * and whose `cause` is the `pg` error that actually carries `code` and
 * `constraint`. A guard that inspected only the outer error would find no
 * `code`, classify every same-`request_id` collision as "unexpected", and
 * rethrow it — turning a case this service is supposed to answer correctly into
 * a 500. That was observed, not imagined: nineteen of twenty concurrent callers
 * on one `request_id` came back as rejections until this walked the chain.
 *
 * Structural rather than `instanceof pg.DatabaseError`: `apps/api` talks to
 * Postgres through Drizzle and does not depend on the driver package, and
 * the driver is `packages/db/src/client.ts`'s decision, not this module's
 * (Phase 6 weighed a swap to `@neondatabase/serverless` and kept `pg`). The
 * SQLSTATE is the stable part of that contract; the error class is not.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && current.code === POSTGRES_UNIQUE_VIOLATION) return true;
    if (!("cause" in current)) return false;
    current = current.cause;
  }

  return false;
}

/** A handle that can run these statements: the pooled client, or one bound to an open transaction. */
type SupplierReader = Database | Transaction;

@Injectable()
export class SupplierKeyClaimService {
  private readonly logger = new Logger(SupplierKeyClaimService.name);

  constructor(@Inject(DATABASE_CLIENT) private readonly database: DatabaseClient) {}

  /**
   * Issue a key for `request.requestId`, or report that the pool is empty.
   *
   * Three steps, in this order and for this reason:
   *
   *   1. **Read the ledger** (I5). A hit ends the call — no lock is taken, no
   *      key is touched, nothing is written. This is the retry-after-timeout
   *      path and it is deliberately the cheapest one in the file.
   *   2. **Claim a key and record the request, in one transaction** (I6). Two
   *      writes, atomically, so the crash window described in the file header
   *      never exists. Zero rows from the claim is `out_of_stock`, and the
   *      transaction ends having written nothing.
   *   3. **Catch `23505` and re-read the ledger.** The one case steps 1-2 cannot
   *      settle on their own; see "The losing side of a same-`request_id` race"
   *      below.
   *
   * ### Why the ledger read is outside the transaction
   *
   * Moving it inside would buy nothing. Under `READ COMMITTED` — the project's
   * deliberate isolation level (`architecture.md` §2) — a concurrent transaction
   * holding the same `request_id` is invisible until it commits, whether the
   * read happens before `BEGIN` or after it. The guarantee comes from the unique
   * constraints, not from where the `SELECT` sits, so it sits where it is
   * cheapest: outside, on the common path, taking no locks and holding the
   * instance's single connection for one round trip.
   *
   * ### The losing side of a same-`request_id` race
   *
   * Two concurrent calls carrying the same `request_id` both read an empty
   * ledger and both proceed to claim. `SKIP LOCKED` means they take *different*
   * key rows — it is designed to keep them from queueing — so nothing stops them
   * until one commits. Then whichever constraint the loser reaches first says no:
   *
   *   - `supplier_keys_claimed_by_request_id_key`, if the winner's claim is
   *     already committed (or the loser blocks on the winner's pending index
   *     entry and is rejected the moment it commits); or
   *   - `supplier_requests_pkey`, on the ledger insert.
   *
   * Either way the loser's whole transaction rolls back, **which un-claims the
   * key it had taken** — the pool loses nothing — and the winner's row is by
   * then committed and visible. So the handler re-reads the ledger and returns
   * the winner's code: one key claimed, both callers answered identically. That
   * is the concurrent form of the same promise the timeout retry relies on.
   *
   * There is no retry loop and no deadlock to worry about: a transaction here
   * can only ever wait on the single index entry for its own `request_id`, and
   * it inserts exactly one, so no two transactions can wait on each other.
   *
   * If the re-read somehow finds nothing, the original error is rethrown rather
   * than guessed at. That is an invariant violation, not traffic, and it should
   * surface as one. Since {@link SupplierKeyClaimService.readLedger} is now
   * narrowed by `provider`, one such violation has a name: `supplier_requests`
   * is keyed on `request_id` alone, so a row written by the *other* supplier
   * under this id raises `23505` here and then does **not** satisfy the re-read.
   * The 23505 surfaces instead of this call returning a code the other supplier
   * cut. Nothing can construct that today — ids are derived and carry the
   * provider segment — and if something ever does, a raise is the right answer.
   */
  async issue(
    request: SupplierKeyClaimRequest,
    provider: SupplierProvider,
  ): Promise<SupplierKeyClaimResult> {
    const { requestId, sku, orderId } = request;

    const alreadyIssued = await this.readLedger(this.database.db, requestId, provider);
    if (alreadyIssued !== undefined) {
      this.logger.log({
        msg: "supplier: repeat of a request_id already answered; returning the stored code",
        request_id: requestId,
        order_id: orderId,
        sku,
      });

      return { outcome: SupplierKeyClaimOutcome.AlreadyIssued, code: alreadyIssued };
    }

    let result: SupplierKeyClaimResult;

    try {
      result = await this.claimAndRecord(requestId, provider);
    } catch (error: unknown) {
      if (!isUniqueViolation(error)) throw error;

      const settledByTheWinner = await this.readLedger(this.database.db, requestId, provider);
      if (settledByTheWinner === undefined) throw error;

      this.logger.log({
        msg: "supplier: lost a same-request_id race; this claim rolled back and the winner's code stands",
        request_id: requestId,
        order_id: orderId,
        sku,
      });

      return { outcome: SupplierKeyClaimOutcome.AlreadyIssued, code: settledByTheWinner };
    }

    if (result.outcome === SupplierKeyClaimOutcome.OutOfStock) {
      this.logger.warn({
        msg: "supplier: key pool exhausted; answering out_of_stock",
        request_id: requestId,
        order_id: orderId,
        sku,
      });
    } else {
      this.logger.log({
        msg: "supplier: key claimed and recorded",
        request_id: requestId,
        order_id: orderId,
        sku,
      });
    }

    return result;
  }

  /**
   * I5 — one supplier request → one code, **asked of one supplier**.
   * `architecture.md` §3.1, narrowed by the `provider` column migration 0002
   * added (whose §(7) spells this read out) and `packages/db/src/schema/supplier.ts`
   * quotes on the column itself:
   *
   *   SELECT code FROM supplier_requests
   *   WHERE request_id = $1 AND provider = $2;
   *   -- found => return that code unchanged, however many times we are asked
   *
   * Emitted SQL (copied from the statement Postgres logged under
   * `log_statement = 'all'`; per the project's raw-SQL rule, `architecture.md`
   * §2, "Documentation convention"):
   *
   *   execute <unnamed>: select "code" from "supplier_requests"
   *                      where ("supplier_requests"."request_id" = $1
   *                        and "supplier_requests"."provider" = $2)
   *   DETAIL: parameters: $1 = 'req_ord_00123_a_1', $2 = 'a'
   *   -- 1 row  => THIS SUPPLIER HAS ANSWERED THIS request_id. Return that code
   *   --           and stop. No key is claimed, nothing is written, and the
   *   --           answer is the same on the thousandth call as on the second.
   *   --           This single row is what makes «таймаут ≠ отказ» true.
   *   -- 0 rows => *this* supplier has not answered it, as of this snapshot.
   *   --           Two different situations land here and both are answered by
   *   --           going on to claim:
   *   --             * first sight — nobody has answered this id at all; or
   *   --             * MIS-ADDRESSED — the id was answered by the OTHER
   *   --               supplier. `$2` is the whole reason this is a miss rather
   *   --               than a hit: without it the row comes back and B hands the
   *   --               shop a code A cut, recorded as though B had issued it,
   *   --               for a question B was never asked.
   *   --           Note what zero rows does NOT prove: a concurrent transaction
   *   --           may hold this request_id uncommitted, and under READ
   *   --           COMMITTED we cannot see it. The unique constraints settle
   *   --           that case, not this read — see `issue()`.
   *
   * `request_id` is the PRIMARY KEY, so this is still an index lookup of at most
   * one row and `provider` is a filter applied to that row rather than a second
   * index it needs — which is why no `(request_id, provider)` index was added:
   * the primary key has already reduced the scan to one row, and an extra index
   * would cost the claim's write path more than the one `=` it saves.
   * `[found]` destructures that at-most-one row and is `undefined` on the
   * zero-row path.
   *
   * **`execute <unnamed>`** is worth reading, and it is the same on every
   * statement below. It is the *unnamed* statement of the extended query
   * protocol — parsed, bound and executed in one round trip, with nothing
   * retained on the backend. That is the observable form of the
   * no-server-side-prepared-statements rule (`packages/db/src/client.ts`): a
   * named `PREPARE` would live on one backend, and Neon's pooled endpoint hands
   * the next statement to a different one.
   *
   * Runs on whichever handle it is given so that it can be called both outside a
   * transaction (the fast path) and, if a caller ever needs it, inside one.
   *
   * ### Why `provider` is read here now, when it was written two tasks ago
   *
   * `supplier_requests.provider` has been *written* since supplier B shipped —
   * `claimAndRecord` passes it and each controller states its own identity,
   * because the provider is the endpoint. Until this read it was recorded and
   * never consulted, and narrowing changed nothing observable: request ids are
   * **derived** rather than remembered — `req_{order}_{provider}_{attempt}`, see
   * the shop's `issuance/issuance-request-id.ts` — so `req_x_a_1` can only ever
   * be sent to A, and no path could address a lookup to the wrong supplier.
   *
   * **The re-probe is what makes this read load-bearing.** A timed-out attempt
   * is re-asked *of the same supplier, under the same id*, and this one row is
   * what stops a second key being cut for it. Against that, *"nothing can
   * currently construct a mismatch"* is a far thinner guarantee than *"a
   * mismatch returns zero rows"*: the first is a property of every present and
   * future caller, the second is a property of this statement. The column was
   * defence in depth; this predicate is what arms it.
   */
  private async readLedger(
    handle: SupplierReader,
    requestId: string,
    provider: SupplierProvider,
  ): Promise<string | undefined> {
    const [found] = await handle
      .select({ code: supplierRequests.code })
      .from(supplierRequests)
      .where(
        and(eq(supplierRequests.requestId, requestId), eq(supplierRequests.provider, provider)),
      );

    return found?.code;
  }

  /**
   * I6 — one key → at most one request. The two writes, atomically.
   *
   * Emitted SQL — the four statements below are exactly what Postgres logged
   * under `log_statement = 'all'`, in this order, on one connection. The
   * `begin`/`commit` are Drizzle's `transaction()` (`packages/db/src/client.ts`);
   * no isolation level is named, so this runs at the server default,
   * `READ COMMITTED`:
   *
   *   statement: begin
   *
   *   execute <unnamed>: update "supplier_keys"
   *   set "claimed_by_request_id" = $1, "claimed_at" = now()
   *   where "supplier_keys"."code" = (
   *     select "code" from "supplier_keys"
   *     where "supplier_keys"."claimed_by_request_id" is null
   *     order by "supplier_keys"."id"
   *     limit $2 for update skip locked
   *   )
   *   returning "code"
   *   DETAIL: parameters: $1 = 'req_ord_00123_a_1', $2 = '1'
   *   -- 1 row  => this call now owns that key. Nobody else can also own it: the
   *   --           row has one claimed_by_request_id column, and the subquery
   *   --           locked it before the outer UPDATE wrote.
   *   -- 0 rows => THE POOL IS EXHAUSTED — every key is claimed, or every
   *   --           remaining candidate is locked by a concurrent claim. Not an
   *   --           error: the transaction commits having written nothing and the
   *   --           caller is told `out_of_stock`, which the shop renders as an
   *   --           ordinary order state.
   *
   *   execute <unnamed>: insert into "supplier_requests"
   *                      ("request_id", "provider", "code", "created_at")
   *                      values ($1, $2, $3, default)
   *   DETAIL: parameters: $1 = 'req_ord_00123_a_1', $2 = 'a',
   *                       $3 = 'LFXC-TNCS-BPCD'
   *   -- $2 is PASSED, never defaulted: migration 0002 added the column with
   *   --    DEFAULT 'a' to backfill and dropped the default in the next
   *   --    statement, so a supplier that forgets to say which one it is takes
   *   --    a 23502 rather than being recorded as A. Recorded as A, ITS OWN
   *   --    later lookups would miss and it would claim a second key for a
   *   --    request that was already answered.
   *   -- Always exactly one row, or it raises. There is deliberately no
   *   -- ON CONFLICT DO NOTHING here: a conflict means another transaction has
   *   -- already answered this request_id, and the correct response is to undo
   *   -- *this* transaction — including the key claim above — not to swallow the
   *   -- conflict and commit a claim the ledger does not point at. The raise is
   *   -- the mechanism; `issue()` catches 23505 and re-reads the ledger.
   *
   *   statement: commit
   *   -- or `rollback`, and NEITHER write happened. That is the crash window
   *   -- closed: there is no instant at which a key is claimed by a request_id
   *   -- the ledger has never heard of. See this file's header.
   *
   * ### Reading the claim statement
   *
   *   - **One statement, not a read then a write.** `SELECT` an unclaimed key,
   *     then `UPDATE` it, would leave a window in which fifty other requests read
   *     the same key. Here the subquery, the lock and the write are one operation
   *     Postgres executes atomically — there is no window to race in.
   *   - **`FOR UPDATE SKIP LOCKED`.** A candidate already locked by a concurrent
   *     claim is *skipped*, not queued behind. Fifty concurrent claims therefore
   *     take fifty different rows and none of them blocks; without `SKIP LOCKED`
   *     they would serialise on the first row and forty-nine would wake up to
   *     find it taken (`postgres-best-practices`, `lock-skip-locked`).
   *   - **`ORDER BY id`.** The pool is handed out in seed order, which is what
   *     makes a drained-pool test reproducible, and what lets the partial index
   *     `supplier_keys_unclaimed_idx (id) WHERE claimed_by_request_id IS NULL`
   *     answer the subquery from an ordered scan of only the unsold keys.
   *   - **`limit $2 for update skip locked`** is Drizzle's clause order, where
   *     `architecture.md` §3.1 writes `FOR UPDATE SKIP LOCKED LIMIT 1`. Postgres
   *     accepts the locking clause on either side of `LIMIT` and the meaning is
   *     identical; `$2` is the bound `1`. The two textual differences from §3.1
   *     are noted here rather than smoothed over, because the point of the
   *     convention is that the comment matches what actually runs.
   *   - **`claimed_at = now()`**, in SQL — and `created_at` left to its column
   *     `default`, which is also `now()`. Both stamps come from the database's
   *     clock, the one every process is compared against; a serverless
   *     instance's clock is not.
   *
   * `EXPLAIN (ANALYZE)` on the claim, against the seeded fifty-key pool:
   *
   *   Update on supplier_keys
   *     InitPlan 1 (returns $2)
   *       ->  Limit
   *             ->  LockRows
   *                   ->  Index Scan using supplier_keys_unclaimed_idx on supplier_keys
   *                         Filter: (claimed_by_request_id IS NULL)
   *     ->  Seq Scan on supplier_keys
   *           Filter: (code = $2)
   *           Rows Removed by Filter: 49
   *
   * `LockRows` under `Limit` is `FOR UPDATE SKIP LOCKED` picking exactly one
   * row, and it is fed by the partial index — the subquery never looks at a sold
   * key. The outer `Seq Scan` is the planner declining `supplier_keys_code_key`
   * on a fifty-row table, which is the right call at this size and would become
   * an index scan on a pool worth indexing.
   *
   * ### Why this transaction is safe to hold
   *
   * Two statements against a fifty-row table, no network I/O of any kind. The pool
   * holds one connection per instance (`packages/db/src/client.ts`), so anything
   * slow in here would stall the whole instance — which is exactly why a
   * supplier's own storage is the only thing it touches and why an HTTP call
   * inside a transaction is forbidden project-wide (`lock-short-transactions`).
   * The row lock the subquery takes lives until COMMIT, and COMMIT is one
   * statement away.
   */
  private async claimAndRecord(
    requestId: string,
    provider: SupplierProvider,
  ): Promise<SupplierKeyClaimResult> {
    return this.database.transaction(async (tx) => {
      // Built, not executed: this is the locking subquery embedded in the
      // UPDATE's WHERE clause above. Awaiting it here would be a separate
      // statement and would reintroduce the read-then-write window.
      const nextUnclaimedKey = tx
        .select({ code: supplierKeys.code })
        .from(supplierKeys)
        .where(isNull(supplierKeys.claimedByRequestId))
        .orderBy(supplierKeys.id)
        .for("update", { skipLocked: true })
        .limit(1);

      const [claimed] = await tx
        .update(supplierKeys)
        .set({ claimedByRequestId: requestId, claimedAt: sql`now()` })
        .where(eq(supplierKeys.code, nextUnclaimedKey))
        .returning({ code: supplierKeys.code });

      if (claimed === undefined) {
        return { outcome: SupplierKeyClaimOutcome.OutOfStock, requestId };
      }

      await tx.insert(supplierRequests).values({ requestId, provider, code: claimed.code });

      return { outcome: SupplierKeyClaimOutcome.Issued, code: claimed.code };
    });
  }
}
