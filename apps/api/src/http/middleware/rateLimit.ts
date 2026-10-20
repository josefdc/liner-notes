import { type Options, rateLimit } from "express-rate-limit";
import type { RateLimitSettings } from "../../config/settings.js";
import { refuse, requestFailed } from "./errors.js";

const options = ({ windowMs, max }: RateLimitSettings): Partial<Options> => ({
  windowMs,
  limit: max,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  // JSON 429 with Retry-After; an event-stream request gets the error inside a 200 stream,
  // because an EventSource cannot read a 429.
  handler: (req, res) => refuse(req, res, "rate_limited"),
});

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
    skipFailedRequests: true,
    requestWasSuccessful: (_req, res) => !requestFailed(res),
  });
}
