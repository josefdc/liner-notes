/**
 * Cloudflare Turnstile: the check a visitor passes before the API issues a run token
 * (POST /api/runs). The verifier is a plain function, so the app takes it as a dependency and
 * tests stub it: no test calls Cloudflare.
 *
 * The check fails closed: an answer that is not a clear success (a network error, a timeout, a
 * status other than 200, a body that cannot be read, `success` not true, another hostname) is a
 * failure. Neither the token nor the secret is ever logged.
 */

import type { RunTokenSettings } from "../config/settings.js";
import { logger } from "../logger.js";

const log = logger("Turnstile");

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** How long the check waits for Cloudflare's answer. */
export const TURNSTILE_TIMEOUT_MS = 5000;
/** Longest token Cloudflare issues; a longer one is refused without asking. */
export const MAX_TURNSTILE_TOKEN_LENGTH = 2048;
/** The token that passes under the development bypass (RunTokenSettings.bypass). */
export const DEV_BYPASS_TOKEN = "dev-bypass";

/**
 * The outcome of a check: passed; `rejected`, Cloudflare (or the bypass) did not accept the
 * token; or `unavailable`, Cloudflare could not be asked or gave no answer that can be read.
 */
export type TurnstileResult = { ok: true } | { ok: false; reason: "rejected" | "unavailable" };

/** Checks a Turnstile token; `ip` is the visitor's address as the app sees it, when known. */
export type TurnstileVerifier = (token: string, ip: string | undefined) => Promise<TurnstileResult>;

export interface TurnstileOptions {
  secret: string;
  /** When set, a challenge solved on any other hostname is rejected. */
  expectedHostname?: string | null;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** A verifier that asks Cloudflare's siteverify endpoint. */
export function createTurnstileVerifier({
  secret,
  expectedHostname = null,
  fetch: fetchImpl = fetch,
  timeoutMs = TURNSTILE_TIMEOUT_MS,
}: TurnstileOptions): TurnstileVerifier {
  return async (token, ip) => {
    if (token.length === 0 || token.length > MAX_TURNSTILE_TOKEN_LENGTH) {
      return { ok: false, reason: "rejected" };
    }
    const form = new URLSearchParams({ secret, response: token });
    if (ip) form.set("remoteip", ip);

    let body: unknown;
    try {
      const res = await fetchImpl(TURNSTILE_VERIFY_URL, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) {
        log.warn(`siteverify answered ${res.status}; check failed`);
        return { ok: false, reason: "unavailable" };
      }
      body = await res.json();
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      log.warn(timedOut ? "siteverify timed out; check failed" : "siteverify failed; check failed");
      return { ok: false, reason: "unavailable" };
    }

    if (typeof body !== "object" || body === null) {
      log.warn("siteverify sent an answer that cannot be read; check failed");
      return { ok: false, reason: "unavailable" };
    }
    const { success, hostname, "error-codes": codes } = body as Record<string, unknown>;
    if (success !== true) {
      // Cloudflare's error codes name the problem (e.g. timeout-or-duplicate), never the token.
      const named = Array.isArray(codes) ? codes.filter((code) => typeof code === "string") : [];
      log.info(`Token rejected${named.length > 0 ? ` (${named.join(", ")})` : ""}`);
      return { ok: false, reason: "rejected" };
    }
    if (expectedHostname && hostname !== expectedHostname) {
      log.warn("Token solved on another hostname; rejected");
      return { ok: false, reason: "rejected" };
    }
    return { ok: true };
  };
}

/** The development bypass: DEV_BYPASS_TOKEN passes, anything else is rejected. */
export const bypassTurnstileVerifier: TurnstileVerifier = async (token) =>
  token === DEV_BYPASS_TOKEN ? { ok: true } : { ok: false, reason: "rejected" };

/**
 * The verifier the settings call for: the bypass where it applies, else Cloudflare. Settings
 * without a Turnstile secret outside the bypass cannot pass readSettings; here they get a
 * verifier that rejects every token, so a mistake never lets a request through.
 */
export function turnstileVerifierFor(settings: RunTokenSettings): TurnstileVerifier {
  if (settings.bypass) return bypassTurnstileVerifier;
  if (!settings.turnstileSecret) return async () => ({ ok: false, reason: "rejected" });
  return createTurnstileVerifier({
    secret: settings.turnstileSecret,
    expectedHostname: settings.expectedHostname,
  });
}
