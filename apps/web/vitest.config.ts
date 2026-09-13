/**
 * Vitest configuration for `apps/web`'s unit suite — the pure UI models under
 * `src/**` (technical-considerations §4.1).
 *
 * `environment: "node"`, and deliberately no jsdom: everything this suite
 * checks is a reducer or a timer that never touches the DOM — the carousel
 * reducer emits a timer *instruction* rather than calling `setTimeout`, and the
 * countdown is exercised under `vi.useFakeTimers()`. Anything that needs a
 * document is a browser question and belongs to `e2e/**` under Playwright
 * (§4.2). Keeping the two runners apart is what lets the browser `tsconfig.json`
 * keep `types: []`: the tests import `describe/it/expect` from "vitest"
 * explicitly and lean on no ambient globals.
 *
 * `include` is `src/**\/*.test.ts` only, so the e2e specs (`*.spec.ts` under
 * `e2e/`) are never picked up here, and Playwright never picks up these.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
