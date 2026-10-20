import type { RequestHandler } from "express";
import { logText, refuse } from "./errors.js";

/**
 * Guards the routes that spend money. CORS only stops other sites from reading a response; it
 * does not stop a visitor's browser from sending the request (an `<img>`, a no-cors fetch or a
 * form), which would run an analysis on the visitor's rate-limit budget. So a request is refused
 * (403 `forbidden_origin`, or in the stream for event-stream requests) when:
 *
 * - it carries an `Origin` that is not listed, or
 * - it carries no `Origin` and `Sec-Fetch-Site: cross-site` (a cross-site no-cors GET).
 *
 * A request with neither header (curl, server to server) is allowed. The web app's own requests
 * pass: its cross-origin fetches and EventSources send its listed origin, and same-origin GETs
 * send no Origin and `Sec-Fetch-Site: same-origin`.
 */
export function listedOriginsOnly(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);

  return (req, res, next) => {
    const origin = req.headers.origin;
    const crossSite = req.headers["sec-fetch-site"] === "cross-site";
    const refused = origin !== undefined ? !allowed.has(origin) : crossSite;
    if (!refused) {
      next();
      return;
    }
    console.warn(
      `[HTTP] ${req.method} ${logText(req.originalUrl.split("?")[0])}: refused ${
        origin !== undefined ? `origin ${logText(origin)}` : "a cross-site request"
      }`,
    );
    refuse(req, res, "forbidden_origin");
  };
}
