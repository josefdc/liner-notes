/**
 * Run tokens: what a client shows to start an analysis, resume it and ask for more facts. POST
 * /api/runs issues one once the visitor has passed Turnstile (./turnstile.ts); the routes that
 * cost money require one (./middleware/requireRunToken.ts).
 *
 * A token is `v1.<payload>.<signature>`: the payload is base64url JSON `{ t, s, i, e }` (the
 * thread id of the run it may start, its scope, when it was issued and when it expires, in
 * milliseconds since the epoch), and the signature is the base64url HMAC-SHA256 of
 * `v1.<payload>` under the server's key, compared in constant time. The token carries no secret
 * of its own; it is never logged (logger.ts scrubs it from URLs and `runToken=` pairs).
 *
 * A token starts at most one run, within RUN_TOKEN_START_WINDOW_MS of being issued, and is
 * accepted by that run's resume and by factoid requests until it expires.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { RunTokenSettings } from "../config/settings.js";

/** The query parameter a token is sent in, on every route that requires one. */
export const RUN_TOKEN_PARAM = "runToken";
/** How long after it is issued a token may start its run. */
export const RUN_TOKEN_START_WINDOW_MS = 5 * 60_000;
/** How long a token is accepted at all (its run's resume, factoids). */
export const RUN_TOKEN_TTL_MS = 30 * 60_000;
/** The only scope tokens have today: the run they name. */
export const RUN_TOKEN_SCOPE = "run";

const VERSION = "v1";
/** Longer than any token this server issues; a longer one is refused before it is decoded. */
const MAX_TOKEN_LENGTH = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const THREAD_ID = /^[A-Za-z0-9_-]{1,100}$/;

export interface RunTokenClaims {
  /** The thread id of the run the token may start (the run id). */
  threadId: string;
  scope: typeof RUN_TOKEN_SCOPE;
  /** When it was issued, in milliseconds since the epoch. */
  issuedAt: number;
  /** When it expires, in milliseconds since the epoch. */
  expiresAt: number;
}

/**
 * The outcome of checking a token: valid; `invalid` (malformed, or not signed with this
 * server's key: nothing it says can be trusted); or `expired`, signed by this server but past
 * its expiry.
 */
export type RunTokenCheck =
  | { ok: true; claims: RunTokenClaims }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "expired"; claims: RunTokenClaims };

export interface RunTokens {
  /** Issues a token for a new run: a fresh thread id, unless one is given (tests). */
  mint(threadId?: string): { runToken: string; claims: RunTokenClaims };
  verify(token: string): RunTokenCheck;
  /** The clock tokens are issued and checked by, in milliseconds since the epoch. */
  now(): number;
}

const encode = (text: string) => Buffer.from(text, "utf8").toString("base64url");

function parseClaims(payload: string): RunTokenClaims | null {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { t, s, i, e } = value as Record<string, unknown>;
  if (typeof t !== "string" || !THREAD_ID.test(t) || s !== RUN_TOKEN_SCOPE) return null;
  if (!Number.isSafeInteger(i) || !Number.isSafeInteger(e)) return null;
  const issuedAt = i as number;
  const expiresAt = e as number;
  if (expiresAt <= issuedAt || expiresAt - issuedAt > RUN_TOKEN_TTL_MS) return null;
  return { threadId: t, scope: RUN_TOKEN_SCOPE, issuedAt, expiresAt };
}

/**
 * Tokens signed with `key`. The key must be secret and at least 32 bytes (readSettings checks
 * RUN_TOKEN_SECRET); `now` is the wall clock, so a token issued before a restart is still checked
 * by the same times after it.
 */
export function createRunTokens(key: Buffer, now: () => number = Date.now): RunTokens {
  if (key.length < 32) throw new Error("A run token key must be at least 32 bytes");
  const sign = (signed: string) => createHmac("sha256", key).update(signed).digest();

  return {
    now,
    mint(threadId = randomUUID()) {
      if (!THREAD_ID.test(threadId)) throw new Error("Not a thread id");
      const issuedAt = now();
      const claims: RunTokenClaims = {
        threadId,
        scope: RUN_TOKEN_SCOPE,
        issuedAt,
        expiresAt: issuedAt + RUN_TOKEN_TTL_MS,
      };
      const payload = encode(
        JSON.stringify({ t: claims.threadId, s: claims.scope, i: issuedAt, e: claims.expiresAt }),
      );
      const signed = `${VERSION}.${payload}`;
      return { runToken: `${signed}.${sign(signed).toString("base64url")}`, claims };
    },
    verify(token) {
      if (token.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "invalid" };
      const parts = token.split(".");
      if (parts.length !== 3) return { ok: false, reason: "invalid" };
      const [version, payload, signature] = parts;
      if (version !== VERSION || !BASE64URL.test(payload) || !BASE64URL.test(signature)) {
        return { ok: false, reason: "invalid" };
      }
      // Compared as text, so a signature written another way (base64url decoding ignores some
      // trailing bits) is not accepted. The lengths match for any signature this server made;
      // timingSafeEqual needs them to.
      const expected = Buffer.from(sign(`${version}.${payload}`).toString("base64url"));
      const given = Buffer.from(signature);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
        return { ok: false, reason: "invalid" };
      }
      const claims = parseClaims(payload);
      if (!claims) return { ok: false, reason: "invalid" };
      if (now() >= claims.expiresAt) return { ok: false, reason: "expired", claims };
      return { ok: true, claims };
    },
  };
}

/**
 * The tokens the settings call for: signed with RUN_TOKEN_SECRET, or, when it is not set
 * (development only; production cannot start without it), with a random key made for this
 * process, so tokens do not outlive it.
 */
export function runTokensFor(settings: RunTokenSettings): RunTokens {
  if (settings.secret) return createRunTokens(Buffer.from(settings.secret, "utf8"));
  return createRunTokens(randomBytes(32)); // guard-allow: random-values-api — a signing key, never data
}
