import type { RequestHandler } from "express";
import { logText, refuse } from "./errors.js";
import { logger } from "../../logger.js";
import { pacingClock } from "../../sources/pacing.js";

const log = logger("HTTP");

/** Sec-Fetch-Site values a request without an Origin may carry: the API's own origin, or none. */
const SAME_ORIGIN_SITES = new Set(["same-origin", "none"]);

/**
 * A refusal is logged at most once per origin (or kind of request) in this interval, measured on
 * the monotonic clock: a step of the wall clock neither mutes refusals longer nor logs them
 * sooner.
 */
export const REFUSAL_LOG_INTERVAL_MS = 60_000;
const MAX_LOGGED_KEYS = 1000;

/**
 * Guards the routes that spend money. CORS only stops other sites from reading a response; it
 * does not stop a visitor's browser from sending the request (an `<img>`, a no-cors fetch or a
 * form), which would run an analysis on the visitor's rate-limit budget. So a request is refused
 * (403 `forbidden_origin`, or in the stream for event-stream requests) when:
 *
 * - it carries an `Origin` that is not listed, or
 * - it carries no `Origin` and a `Sec-Fetch-Site` other than `same-origin` or `none`. A
 *   `same-site` request is refused too: a site ignores ports, so any other page on localhost
 *   (or a sibling subdomain) is the same site.
 *
 * A request with neither header (curl, server to server) is allowed, and so is one a browser
 * marks `Sec-Fetch-Site: same-origin` (a page cannot set that header): the page is served from
 * the API's own origin, whatever the Origin it sends (a same-origin POST, such as POST
 * /api/runs, sends one). The web app's own requests pass: its cross-origin fetches and
 * EventSources send its listed origin, and its same-origin requests are marked so.
 */
export function listedOriginsOnly(
  allowedOrigins: readonly string[],
  now: () => number = pacingClock,
): RequestHandler {
  const allowed = new Set(allowedOrigins);
  const lastLogged = new Map<string, number>();

  // A flood of refusals must not flood the log.
  const shouldLog = (key: string) => {
    const at = now();
    const last = lastLogged.get(key);
    // An age below 0 (a clock that reads earlier than the last line) counts as past the interval.
    const since = last === undefined ? Number.POSITIVE_INFINITY : at - last;
    if (since >= 0 && since < REFUSAL_LOG_INTERVAL_MS) return false;
    if (lastLogged.size >= MAX_LOGGED_KEYS) lastLogged.clear();
    lastLogged.set(key, at);
    return true;
  };

  return (req, res, next) => {
    const origin = req.headers.origin;
    const site = req.headers["sec-fetch-site"];
    const refused =
      site === "same-origin"
        ? false
        : origin !== undefined
          ? !allowed.has(origin)
          : site !== undefined && !SAME_ORIGIN_SITES.has(site);
    if (!refused) {
      next();
      return;
    }
    const what = origin !== undefined ? `origin ${logText(origin)}` : `a ${logText(site)} request`;
    if (shouldLog(what)) {
      log.warn(
        `${req.method} ${logText(req.originalUrl.split("?")[0])}: refused ${what}` +
          ` (repeats muted for ${REFUSAL_LOG_INTERVAL_MS / 1000} s)`,
      );
    }
    refuse(req, res, "forbidden_origin");
  };
}
