import type { RequestHandler, Response } from "express";
import { logger } from "../../logger.js";
import { getDb } from "../../store/database.js";
import { runExists } from "../../store/runs.js";
import {
  RUN_TOKEN_PARAM,
  RUN_TOKEN_START_WINDOW_MS,
  type RunTokenClaims,
  type RunTokens,
} from "../runToken.js";
import { refuse, sendError } from "./errors.js";

const log = logger("HTTP");

/** The requests that start a run: each needs a token that has started none. */
const STARTS = new Set(["POST /api/analyze", "GET /api/analyze/stream"]);

export interface RunTokenGateOptions {
  /**
   * True when a run with this thread id is recorded: its token has started a run already, in
   * this process or an earlier one. Reads the runs store by default.
   */
  hasRun?: (threadId: string) => boolean;
}

/** The checked token of this request, set by requireRunToken; null when there is none. */
export function runTokenOf(res: Response): RunTokenClaims | null {
  const claims = res.locals.runToken as RunTokenClaims | undefined;
  return claims && typeof claims.threadId === "string" ? claims : null;
}

/**
 * Refuses a request whose token cannot be used: a 401 JSON `auth_expired`, on every route, an
 * event stream's included. Only a token that has expired is refused inside a stream
 * (refuseExpired): an EventSource cannot read a 401, and that client only needs a new token.
 */
export function refuseToken(res: Response, why: string): void {
  log.info(`Run token refused: ${why}`);
  sendError(res, "auth_expired");
}

/**
 * True when this request's token was issued for run `threadId`: a resume continues only the
 * run its token started. Otherwise the request is refused (refuseToken) and false returned.
 */
export function requireTokenFor(res: Response, threadId: string): boolean {
  if (runTokenOf(res)?.threadId === threadId) return true;
  refuseToken(res, "issued for another run");
  return false;
}

/**
 * Requires a run token (the `runToken` query parameter, ../runToken.ts) on the routes it is
 * mounted on: the analysis and the factoid routes, their JSON forms included. HEAD and OPTIONS
 * pass: they never start any work.
 *
 * - No token, a malformed one or one this server did not sign: 401 JSON `auth_expired`.
 * - A token that has expired, or one past its start window on a request that starts a run: the
 *   refusal `auth_expired` inside a 200 stream on the stream routes, a 401 JSON on the others.
 * - A request that starts a run: the token must not have started one, here or before a restart
 *   (a run with its thread id is recorded), nor be in use by another request; else 401 JSON. The
 *   run takes the token's thread id (runTokenOf).
 * - A resume: the route checks that the token is the run's (requireTokenFor), once it has read
 *   the thread id from the query or the body.
 * - Factoids: any valid token that has not expired.
 *
 * The token is never logged.
 */
export function requireRunToken(
  tokens: RunTokens,
  { hasRun = (threadId) => runExists(getDb(), threadId) }: RunTokenGateOptions = {},
): RequestHandler {
  /** Threads whose token has started a request here, until their start window closes. */
  const started = new Map<string, number>();
  const forget = (now: number) => {
    for (const [threadId, until] of started) if (until <= now) started.delete(threadId);
  };

  return (req, res, next) => {
    if (req.method === "HEAD" || req.method === "OPTIONS") {
      next();
      return;
    }
    const raw = req.query?.[RUN_TOKEN_PARAM];
    if (typeof raw !== "string" || raw === "") {
      refuseToken(res, raw === undefined ? "none sent" : "malformed");
      return;
    }
    const check = tokens.verify(raw);
    if (!check.ok && check.reason === "invalid") {
      refuseToken(res, "invalid");
      return;
    }
    if (!check.ok) {
      log.info("Run token refused: expired");
      refuse(req, res, "auth_expired");
      return;
    }

    const { claims } = check;
    const path = req.originalUrl.split("?")[0].toLowerCase().replace(/\/+$/, "");
    if (STARTS.has(`${req.method} ${path}`)) {
      const now = tokens.now();
      if (now - claims.issuedAt > RUN_TOKEN_START_WINDOW_MS) {
        log.info("Run token refused: too late to start a run");
        refuse(req, res, "auth_expired");
        return;
      }
      forget(now);
      let used: boolean;
      try {
        used = started.has(claims.threadId) || hasRun(claims.threadId);
      } catch (err) {
        log.error("Could not check whether a run token was used", { err });
        refuse(req, res, "internal_error");
        return;
      }
      if (used) {
        refuseToken(res, "already used");
        return;
      }
      started.set(claims.threadId, claims.issuedAt + RUN_TOKEN_START_WINDOW_MS);
    }
    res.locals.runToken = claims;
    next();
  };
}
