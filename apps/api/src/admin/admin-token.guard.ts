/**
 * The one thing standing in front of the admin surface: a shared bearer token
 * (`architecture.md` §6, *"a single shared bearer token for the admin panel,
 * which is the assignment's stated minimum"*).
 *
 * ---------------------------------------------------------------------------
 * THREE ANSWERS, AND ONLY ONE OF THEM IS "COME IN"
 * ---------------------------------------------------------------------------
 *
 *   | Situation                          | Status | Meaning                    |
 *   | ---------------------------------- | ------ | -------------------------- |
 *   | `ADMIN_TOKEN` not configured       | `503`  | the endpoint is not on here |
 *   | header missing, or not `Bearer …`  | `401`  | you did not authenticate    |
 *   | token present and wrong            | `401`  | you did not authenticate    |
 *   | token present and right            | —      | the handler runs            |
 *
 * ### Why a wrong token is `401` and not `403`
 *
 * RFC 9110 splits them on a line this endpoint sits squarely on one side of:
 * `401` is *"the request has not been applied because it lacks valid
 * authentication credentials"*, `403` is *"the server understood the request
 * but refuses to authorize it"* — that is, credentials that are valid and
 * insufficient. A single shared token carries no identity, so there is no
 * "who" to be insufficient: the token either is the token or it is not, and
 * both a missing and a wrong one are the same failure. Answering `403` would
 * imply the caller had been recognised, which is a claim this scheme cannot
 * make.
 *
 * Both `401`s carry `WWW-Authenticate: Bearer`, which RFC 9110 §11.6.1 makes a
 * MUST — it is how a client learns *which* scheme to present rather than
 * guessing, and it is the difference between a `401` an operator can act on and
 * one they have to read the source to understand.
 *
 * ### Why an unconfigured token is `503` and not `404`
 *
 * Hiding the route would be defensible as concealment, and it is the wrong
 * trade for the audience this endpoint has. The people who call it are the
 * shop's operator and a reviewer following the README, and for both of them a
 * `404` is indistinguishable from a typo in the path — so the first hour of the
 * incident this endpoint exists to clear up would be spent doubting the URL.
 * `503 Service Unavailable` says the honest thing: the route is real, and the
 * server is *"currently unable to handle the request"*. There is no
 * `Retry-After`, because the remedy is a deploy with the variable set and not a
 * wait.
 *
 * ###########################################################################
 * # NOT CONFIGURED MEANS CLOSED. IT HAS NEVER MEANT OPEN, AND MUST NOT COME
 * # TO MEAN IT.
 * ###########################################################################
 *
 * The classic version of this bug is one line long — `if (expected && expected
 * !== presented) throw` — and it reads as caution while doing the opposite: an
 * unset variable admits everybody. It is unreachable here by *type*, not by
 * care. {@link AdminTokenConfig} is a discriminated union
 * (`../config/admin-token.ts`), so `this.config.digest` does not exist until
 * `configured` has been narrowed to `true`, and the narrowing below returns
 * before that point. There is no branch in which a missing token and a matching
 * token produce the same result, and adding one would require deleting a
 * `return`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COMPARISON IS OVER TWO DIGESTS
 * ---------------------------------------------------------------------------
 * `timingSafeEqual` is the whole point of doing this in a guard rather than
 * with `===`: a string comparison stops at the first differing byte, so the
 * time it takes is a measurement of how much of the token a caller has already
 * guessed, and a token can be recovered a character at a time from nothing but
 * response latency.
 *
 * It has one sharp edge — it *throws* on buffers of unequal length, so the
 * naive fix is a length check first, and that length check is itself an early
 * exit that leaks how long the real token is. Hashing both sides to a fixed 32
 * bytes removes the edge instead of documenting it: every call compares the
 * same number of bytes whatever was presented, and the only thing that varies
 * is the answer.
 *
 * Whether that matters against an endpoint on the public internet is arguable;
 * that it costs one `createHash` per admin request is not.
 */
import { timingSafeEqual } from "node:crypto";

import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { ADMIN_TOKEN_CONFIG, digestToken, type AdminTokenConfig } from "../config/admin-token.js";

/** The scheme this guard accepts, matched case-insensitively as RFC 9110 §11.1 requires. */
const BEARER = "bearer";

/**
 * The token out of an `Authorization` header, or `undefined` if there is not
 * one to read.
 *
 * Split on whitespace rather than `startsWith("Bearer ")`: the header's grammar
 * allows more than one space between the scheme and the credentials, and a
 * proxy that normalises them differently must not be the reason an operator's
 * `curl` stops working. The scheme name is case-insensitive by the same
 * grammar, so `bearer`, `Bearer` and `BEARER` are one header.
 *
 * Anything else — no header, a non-`Bearer` scheme, a scheme with nothing after
 * it, or extra tokens after the credentials — is `undefined`, which the caller
 * turns into the same `401` a wrong token gets.
 */
function readBearerToken(request: Request): string | undefined {
  const header = request.headers.authorization;

  if (typeof header !== "string") return undefined;

  const parts = header.trim().split(/\s+/);

  if (parts.length !== 2) return undefined;

  const [scheme, credentials] = parts;

  if (scheme === undefined || credentials === undefined) return undefined;
  if (scheme.toLowerCase() !== BEARER) return undefined;

  return credentials;
}

@Injectable()
export class AdminTokenGuard implements CanActivate {
  private readonly logger = new Logger(AdminTokenGuard.name);

  constructor(
    // By symbol, because the configuration is an interface and there is no
    // constructor to name — the same shape as `SUPPLIER_A_CONFIG` and
    // `CONTINUATION_SCHEDULER`. It is in scope because `AdminModule` imports
    // `ConfigModule`, which is where the value was already proven usable.
    @Inject(ADMIN_TOKEN_CONFIG) private readonly config: AdminTokenConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();

    if (!this.config.configured) {
      // Fail closed. Logged at `warn` rather than passed over silently: somebody
      // is trying to use a backstop that is switched off, and the `error` line
      // that said so was at boot, possibly days ago.
      this.logger.warn({
        msg: "admin request refused: ADMIN_TOKEN is not configured, so the admin surface is disabled",
        method: request.method,
        path: request.path,
        status_code: 503,
      });

      throw new ServiceUnavailableException(
        "the admin surface is disabled because ADMIN_TOKEN is not configured on this deployment",
      );
    }

    const presented = readBearerToken(request);

    if (presented === undefined) {
      throw this.unauthorized(http.getResponse<Response>(), request, "no bearer token was presented");
    }

    // Both sides are 32 bytes because both went through the same SHA-256, so
    // this cannot throw on a length mismatch and cannot early-exit on one
    // either. See the header.
    if (!timingSafeEqualDigests(digestToken(presented), this.config.digest)) {
      throw this.unauthorized(http.getResponse<Response>(), request, "the bearer token did not match");
    }

    return true;
  }

  /**
   * Build the `401`, having first put `WWW-Authenticate` on the response.
   *
   * The header has to be set on the response object rather than carried by the
   * exception, because Nest's `HttpException` models a status and a body and
   * has nowhere to hang a header. Setting it here, before the throw, means the
   * exception filter serialises a response that already has it.
   *
   * ### The log line says which of the two happened; the response does not
   *
   * An operator debugging a `401` needs to know whether their `curl` sent
   * nothing or sent the wrong thing, and that distinction is free to make in
   * our own logs. It is deliberately **not** in the response body, where it
   * would tell an unauthenticated caller that the header they guessed at least
   * parsed — a small hint, and there is no reason to give it away.
   *
   * The token itself is never logged, in either branch. A rejected token is
   * still somebody's credential, and a log that collects near-misses is a log
   * that eventually collects the real one after a typo.
   */
  private unauthorized(response: Response, request: Request, reason: string): UnauthorizedException {
    response.setHeader("WWW-Authenticate", "Bearer");

    this.logger.warn({
      msg: `admin request refused: ${reason}`,
      method: request.method,
      path: request.path,
      status_code: 401,
    });

    return new UnauthorizedException("a valid admin bearer token is required");
  }
}

/**
 * `crypto.timingSafeEqual` over two digests, wrapped so the one precondition it
 * has is stated where it is relied on.
 *
 * Separate from the guard because it is the only line in this file with a
 * property that is invisible in review: it does not return early. Inlining it
 * would put a bare library call next to a `!`, and the next person to "simplify"
 * that to `!a.equals(b)` would remove the entire point of the file without
 * changing a single test result.
 */
function timingSafeEqualDigests(presented: Buffer, expected: Buffer): boolean {
  return timingSafeEqual(presented, expected);
}
