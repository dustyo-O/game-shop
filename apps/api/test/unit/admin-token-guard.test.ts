// @layer: unit
// @spec: 003-failure-and-recovery
// @regression
/**
 * `AdminTokenGuard`'s three-way answer, exercised directly — no HTTP, no
 * Nest DI container, no spawned process.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS: A GENUINE, UNTESTED GAP
 * ---------------------------------------------------------------------------
 * Functional spec 003 §2.4's last criterion — *"a person without the shop's
 * operator credentials is refused"* — and technical-considerations §8 both
 * name three answers: `401` missing, `401` wrong, `503` when `ADMIN_TOKEN`
 * is not configured at all. Every existing suite that reaches this guard
 * (`../concurrency/supplier-refusal-and-recovery.test.ts`,
 * `../concurrency/operator-retry-race.test.ts`, the acceptance suite beside
 * this file) boots its `apps/api` instance with `ADMIN_TOKEN` set, because
 * each of them needs it to arm supplier behaviour or drive a retry. None of
 * them — and, checked before writing this file, nothing else in the
 * repository — ever starts an instance with the variable unset, so the
 * `503` branch has zero executable coverage anywhere. Found while building
 * the spec 003 feature-acceptance suite (`../acceptance/failure-and-
 * recovery.test.ts`), which is the task that made the omission visible.
 *
 * A whole second `apps/api` process is the wrong tool for closing that gap:
 * `../concurrency/support/api-instance.ts`'s own header measures process
 * startup at up to ~13s on a loaded machine, to prove a decision that is
 * three lines of TypeScript
 * (`apps/api/src/admin/admin-token.guard.ts`, `canActivate`) and needs no
 * database, no HTTP server and no Nest container. `@Injectable()` is inert
 * until a DI container reads it — nothing stops `new AdminTokenGuard(config)`
 * — and the guard's one constructor argument is exactly the
 * `AdminTokenConfig` union `../../src/config/admin-token.ts` already exports
 * a pure reader and a pure hasher for. So this is `@layer: unit` in the
 * strict sense used elsewhere in this directory: the real production guard
 * class, imported and driven with a hand-built `ExecutionContext`, checked
 * against a hand-built `AdminTokenConfig` rather than against `process.env`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT PROVE, AND WHERE THAT PART LIVES INSTEAD
 * ---------------------------------------------------------------------------
 * That the guard is actually wired in front of
 * `GET /api/admin/orders/undelivered` and `POST /api/admin/orders/:id/retry`
 * — i.e. that `@UseGuards(AdminTokenGuard)` on `OrderRecoveryController` does
 * what the decorator says — is an end-to-end fact, and it is what
 * `../acceptance/failure-and-recovery.test.ts`'s missing/wrong-token tests
 * prove against a real running instance. This file proves the guard's own
 * decision table is correct in isolation; that file proves the table is the
 * one actually consulted. Neither replaces the other.
 */
import type { ExecutionContext } from "@nestjs/common";
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { describe, expect, it } from "vitest";

import { AdminTokenGuard } from "../../src/admin/admin-token.guard.js";
import { digestToken, type AdminTokenConfig } from "../../src/config/admin-token.js";

const REAL_TOKEN = "correct-horse-battery-staple-secret-003";
const CONFIGURED: AdminTokenConfig = { configured: true, digest: digestToken(REAL_TOKEN) };
const UNCONFIGURED: AdminTokenConfig = { configured: false };

/**
 * A minimal fake `ExecutionContext` carrying only what
 * `AdminTokenGuard.canActivate` actually reads: `request.headers.authorization`
 * for the check, and `request.method` / `request.path` for its log lines.
 * `response.setHeader` is exercised on the 401 path (`WWW-Authenticate`).
 *
 * Not a mocking library's spy — a plain object literal is enough because
 * nothing here asserts on how the guard logs; it asserts on what the guard
 * *decides*, which is the thrown/returned value.
 */
function contextWithAuthorization(authorization: string | undefined): ExecutionContext {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers["authorization"] = authorization;

  const request = { headers, method: "GET", path: "/api/admin/orders/undelivered" } as unknown as Request;
  const response = { setHeader: () => undefined } as unknown as Response;

  return {
    switchToHttp: () => ({
      getRequest: <T>() => request as T,
      getResponse: <T>() => response as T,
    }),
  } as unknown as ExecutionContext;
}

describe("AdminTokenGuard — the three answers (functional spec 003 §2.4 criterion 6)", () => {
  // @regression
  it(
    "ADMIN_TOKEN not configured: refused with 503 EVEN WHEN the presented token is the correct one — " +
      "unconfigured means closed, never open",
    () => {
      const guard = new AdminTokenGuard(UNCONFIGURED);

      expect(() => guard.canActivate(contextWithAuthorization(`Bearer ${REAL_TOKEN}`))).toThrow(
        ServiceUnavailableException,
      );
    },
  );

  // @regression
  it("configured, no Authorization header at all: refused with 401 (negative)", () => {
    const guard = new AdminTokenGuard(CONFIGURED);

    expect(() => guard.canActivate(contextWithAuthorization(undefined))).toThrow(UnauthorizedException);
  });

  // @regression
  it("configured, a token that differs by one character: refused with 401, not merely 'close enough' (negative, boundary)", () => {
    const guard = new AdminTokenGuard(CONFIGURED);
    const almostRight = `${REAL_TOKEN.slice(0, -1)}x`;

    expect(almostRight).not.toBe(REAL_TOKEN);
    expect(() => guard.canActivate(contextWithAuthorization(`Bearer ${almostRight}`))).toThrow(
      UnauthorizedException,
    );
  });

  // @regression
  it('configured, a non-"Bearer" scheme (e.g. "Basic"): refused with 401 (negative — malformed auth scheme)', () => {
    const guard = new AdminTokenGuard(CONFIGURED);

    expect(() => guard.canActivate(contextWithAuthorization(`Basic ${REAL_TOKEN}`))).toThrow(
      UnauthorizedException,
    );
  });

  // @regression
  it("configured, the correct token: admitted — canActivate returns true (the positive case the four refusals above contrast against)", () => {
    const guard = new AdminTokenGuard(CONFIGURED);

    expect(guard.canActivate(contextWithAuthorization(`Bearer ${REAL_TOKEN}`))).toBe(true);
  });
});
