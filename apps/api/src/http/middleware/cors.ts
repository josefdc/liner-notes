import type { RequestHandler } from "express";

const ALLOWED_METHODS = "GET, POST";
const ALLOWED_HEADERS = "Content-Type, Cache-Control";
const EXPOSED_HEADERS = "RateLimit, RateLimit-Policy, Retry-After";
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * CORS for an allowlist of origins. Only a listed origin gets Access-Control-Allow-Origin (and
 * may read the rate-limit headers); any other origin gets no CORS headers, so the browser blocks
 * the response. `Vary: Origin` is set on every response so caches never serve one origin's answer
 * to another. No credentials are allowed: the web client sends no cookies or auth headers.
 *
 * A preflight (OPTIONS with Access-Control-Request-Method) is answered here with 204, and so is
 * any other OPTIONS request (with `Allow`), instead of Express's HTML answer.
 */
export function cors(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);

  return (req, res, next) => {
    res.vary("Origin");
    const origin = req.headers.origin;
    const listed = typeof origin === "string" && allowed.has(origin);
    if (listed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Expose-Headers", EXPOSED_HEADERS);
    }

    if (req.method !== "OPTIONS") {
      next();
      return;
    }

    if (req.headers["access-control-request-method"]) {
      res.vary("Access-Control-Request-Method");
      res.vary("Access-Control-Request-Headers");
      if (listed) {
        res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
        res.setHeader("Access-Control-Allow-Headers", ALLOWED_HEADERS);
        res.setHeader("Access-Control-Max-Age", String(PREFLIGHT_MAX_AGE_SECONDS));
      }
    } else {
      res.setHeader("Allow", `${ALLOWED_METHODS}, OPTIONS`);
    }
    res.status(204).end();
  };
}
