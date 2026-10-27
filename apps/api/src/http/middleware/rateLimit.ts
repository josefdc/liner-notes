import type { Request } from "express";
import { type Options, type RateLimitInfo, rateLimit } from "express-rate-limit";
import type { RateLimitSettings } from "../../config/settings.js";
import { refuse, requestFailed } from "./errors.js";

const options = ({ windowMs, max }: RateLimitSettings): Partial<Options> => ({
  windowMs,
  limit: max,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // JSON 429 with Retry-After; an event-stream request gets the error inside a 200 stream,
  // because an EventSource cannot read a 429, with the time left until the limit resets.
  handler: (req, res) => refuse(req, res, "rate_limited", retryAfter(req)),
});

/** The time left until the limit that refused `req` resets, when the limiter knows it. */
function retryAfter(req: Request): { retryAfterMs?: number } {
  const resetTime = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit?.resetTime;
  if (!(resetTime instanceof Date)) return {};
  return { retryAfterMs: Math.max(0, Math.ceil(resetTime.getTime() - Date.now())) };
}

/**
 * A per-IP limit: past `max` requests in `windowMs`, requests are refused. Every request counts,
 * including invalid ones. The client IP is `req.ip`, so behind a proxy it is only right when the
 * app's `trust proxy` hop count matches (TRUST_PROXY).
 */
export function perIpLimit(limit: RateLimitSettings) {
  return rateLimit(options(limit));
}

/**
 * One limit shared by every client: caps the total spend however many addresses send requests.
 * Requests that fail (invalid input, errors) are not counted once they finish, so bad requests
 * from a few addresses cannot use up everyone's budget; the per-IP limit still counts them.
 */
export function globalLimit(limit: RateLimitSettings) {
  return rateLimit({
    ...options(limit),
    keyGenerator: () => "all-clients",
    // HEAD on a stream answers headers only and costs nothing.
    skip: (req) => req.method === "HEAD",
    skipFailedRequests: true,
    requestWasSuccessful: (_req, res) => !requestFailed(res),
  });
}
