/**
 * Vitest configuration for `apps/api`'s Vitest suite.
 *
 * Test configuration only — see `context/product/architecture.md` §7, "Unit
 * and integration tests: Vitest against a real Postgres instance." This is the
 * first Vitest suite in the repository (Slice 7's concurrency proof for
 * functional spec §2.5), so this file exists to give it somewhere to run.
 *
 * Timeouts are generous rather than tight: `beforeAll` in the concurrency test
 * rebuilds `apps/api` from source (so a RED edit to the source is guaranteed to
 * be the code the spawned processes actually run — see that file's header) and
 * boots four separate Node processes against a real Postgres container, which
 * is legitimately slower than a unit test without being a sign anything is
 * wrong.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // No parallel test files by default here — the concurrency test manages
    // its own internal parallelism (N orders, K processes) and owns exclusive
    // use of the supplier_keys pool for the span of its own run.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
