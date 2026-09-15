/**
 * `INSTANCE_ID` — one random UUID per process, minted when this module is
 * first evaluated and never again (technical-considerations §2.5).
 *
 * ---------------------------------------------------------------------------
 * THE HTTP WITNESS OF "SEPARATE PROCESSES"
 * ---------------------------------------------------------------------------
 * Every argument this repository makes about correctness ends the same way:
 * the guarantees live in Postgres, not in memory, so two requests served by two
 * processes with nothing in common but the database still cannot claim one key
 * twice or apply one webhook twice. Locally the harness proves the "two
 * processes" half with `pg_stat_activity` pids — four instances on four ports,
 * four backend pids. A reviewer pointed at the live URL cannot see the
 * database, so the process has to say who it is over HTTP instead.
 *
 * A module-scope constant is exactly the right granularity for that. Node
 * evaluates a module once per process; on Vercel a function instance *is* a
 * process, so one value here is one value per instance, and two responses
 * carrying different ids came from two instances. `createApp()` puts it on
 * every response as `x-instance-id` (`./create-app.ts`), `GET /api/health`
 * repeats it in the body so header and body can be checked against each other,
 * and `scripts/race`'s external mode counts the distinct values it sees.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PROVES, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * A distinct id proves a distinct process. It does **not** prove that those
 * processes were alive at the same moment — two ids across fifty webhooks are
 * consistent with one instance being recycled between the first and the last.
 * The overlap is argued elsewhere (the harness's concurrent fan-out and the
 * database's own view of it); this value only rules out the one reading that
 * would make the live run worthless, that every answer came from a single
 * process sharing a single `max: 1` pool. A run where every id is the same is
 * not cross-process evidence, and the runner says so rather than passing.
 *
 * `randomUUID()` rather than anything the platform hands out: Vercel exposes no
 * stable per-instance identifier to the function, and a value derived from the
 * environment would be identical across instances started from one deploy —
 * the opposite of what this is for. A UUID is not a secret and reveals nothing
 * about the instance beyond "not the other one".
 */
import { randomUUID } from "node:crypto";

export const INSTANCE_ID: string = randomUUID();
