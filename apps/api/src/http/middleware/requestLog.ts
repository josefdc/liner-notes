import type { RequestHandler } from "express";
import { ipHash, logger } from "../../logger.js";
import { logText } from "./errors.js";

const log = logger("HTTP");

/** Probes a container runtime or a monitor sends all the time: logged at debug level. */
const PROBE_PATHS = new Set(["/api/health", "/api/ready"]);

/**
 * One log line per request once it is answered (or the client has gone): the method, the path
 * without its query string, the status, the time taken, and a keyed hash of the client address
 * (logger.ts `ipHash`). Never the address, the query string (it holds what the visitor typed),
 * the User-Agent or the Referer. A request of an analysis carries its run id (`res.locals.runId`,
 * set by the analyze routes). Health and readiness probes, HEAD and OPTIONS are logged at debug
 * level; answers of 500 and above at warn.
 *
 * Mounted first, so requests other middleware refuses (origin, rate limits, bodies) are logged.
 */
export const requestLog: RequestHandler = (req, res, next) => {
  const started = process.hrtime.bigint();
  // Read now: routers mounted on a path rewrite req.url while they run.
  const method = req.method;
  const path = logText(req.path);
  let written = false;

  const write = (aborted: boolean) => {
    if (written) return;
    written = true;
    const durationMs = Number((process.hrtime.bigint() - started) / 1000n) / 1000;
    const runId = typeof res.locals.runId === "string" ? res.locals.runId : undefined;
    const fields = {
      method,
      path,
      status: res.statusCode,
      durationMs,
      ipHash: ipHash(req.ip ?? req.socket.remoteAddress),
      ...(aborted ? { aborted: true } : {}),
      ...(runId ? { runId } : {}),
    };
    const quiet =
      PROBE_PATHS.has(path.toLowerCase().replace(/\/+$/, "")) ||
      method === "HEAD" ||
      method === "OPTIONS";
    const message = `${method} ${path} ${res.statusCode}`;
    if (quiet) log.debug(message, fields);
    else if (res.statusCode >= 500) log.warn(message, fields);
    else log.info(message, fields);
  };

  res.on("finish", () => write(false));
  // A client that leaves before the answer is finished: logged with what was sent so far.
  res.on("close", () => write(!res.writableFinished));
  next();
};
