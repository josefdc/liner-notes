import type { Request, RequestHandler, Response } from "express";
import { logger } from "../../logger.js";
import { getDb } from "../../store/database.js";
import { runExists } from "../../store/runs.js";
import {
  RUN_TOKEN_PARAM,
  RUN_TOKEN_START_WINDOW_MS,
  type RunTokenClaims,
  type RunTokens,
} from "../runToken.js";
import { refuse, sendError, sendStreamError } from "./errors.js";

const log = logger("HTTP");

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
 * Whether this request's token may start its run now: `late` past its start window, `used` when
 * it has started a run (or a request is starting one), `unknown` when that cannot be read.
 */
type StartCheck = "ok" | "late" | "used" | "unknown";

/**
 * Claims this request's token for the run it starts, from the route that starts it (after
 * routing, so no path has to be matched). The token must be within its start window and must
 * not have started a run, here or before a restart, nor be claimed by another request. Returns
 * its claims, the run's thread id among them; otherwise the request is refused and null is
 * returned: a token past its start window with `auth_expired` (inside the stream on a stream
 * route, `stream`), a used one with a 401 JSON.
 */
export function claimRunToken(
  req: Request,
  res: Response,
  { stream }: { stream: boolean },
): RunTokenClaims | null {
  const claims = runTokenOf(res);
  const claim = res.locals.claimRunStart as (() => StartCheck) | undefined;
  if (!claims || !claim) {
    refuseToken(res, "none checked");
    return null;
  }
  switch (claim()) {
    case "ok":
      return claims;
    case "late":
      log.info("Run token refused: too late to start a run");
      if (stream) sendStreamError(req, res, "auth_expired");
      else sendError(res, "auth_expired");
      return null;
    case "used":
      refuseToken(res, "already used");
      return null;
    case "unknown":
      if (stream) sendStreamError(req, res, "internal_error");
      else sendError(res, "internal_error");
      return null;
  }
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
 * - A token that has expired: the refusal `auth_expired` inside a 200 stream on the stream
 *   routes, a 401 JSON on the others.
 * - A request that starts a run: its route claims the token (claimRunToken), which must be
 *   within its start window and must not have started a run, here or before a restart (a run
 *   with its thread id is recorded), nor be claimed by another request. The run takes the
 *   token's thread id.
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
    res.locals.runToken = claims;
    res.locals.claimRunStart = (): StartCheck => {
      const now = tokens.now();
      if (now - claims.issuedAt > RUN_TOKEN_START_WINDOW_MS) return "late";
      forget(now);
      try {
        if (started.has(claims.threadId) || hasRun(claims.threadId)) return "used";
      } catch (err) {
        log.error("Could not check whether a run token was used", { err });
        return "unknown";
      }
      started.set(claims.threadId, claims.issuedAt + RUN_TOKEN_START_WINDOW_MS);
      return "ok";
    };
    next();
  };
}
