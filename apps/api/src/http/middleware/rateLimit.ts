import { rateLimit } from "express-rate-limit";
import type { RateLimitSettings } from "../../config/settings.js";
import { sendError } from "./errors.js";

/**
 * A per-IP limit: past `max` requests in `windowMs`, requests get 429 with a JSON body and
 * Retry-After. Every request counts, including invalid ones. The client IP is `req.ip`, so behind
 * a proxy it is only right when the app's `trust proxy` hop count matches (TRUST_PROXY).
 */
export function perIpLimit({ windowMs, max }: RateLimitSettings) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => sendError(res, "rate_limited"),
  });
}
