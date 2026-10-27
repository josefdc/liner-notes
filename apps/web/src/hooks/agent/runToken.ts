/**
 * Run tokens on the client. The API requires one on every analysis, resume and factoid request
 * (the `runToken` query parameter): POST /api/runs issues it once the visitor has passed
 * Turnstile, whose widget turnstile.ts shows. A build without a Turnstile site key sends the
 * development bypass's token instead, which only an API with no Turnstile secret, outside
 * production, accepts.
 *
 * A token starts one analysis, within five minutes; that analysis's resume and any factoid
 * request may send it again until it expires.
 */

import { type RunToken, RunTokenError, requestRunToken } from './apiClient';
import { turnstileToken } from './turnstile';

/** The query parameter the API reads a run token from. */
export const RUN_TOKEN_PARAM = 'runToken';

/** The Turnstile token the API's development bypass accepts. */
export const DEV_BYPASS_TOKEN = 'dev-bypass';

/** A token this close to its expiry is not sent again: a new one is asked for. */
export const RUN_TOKEN_MARGIN_MS = 30_000;

/** The build's Turnstile site key; empty when it has none. */
function siteKey(): string {
  return import.meta.env.VITE_TURNSTILE_SITE_KEY?.trim() ?? '';
}

/**
 * A new run token from the API, asked for with the token of a Turnstile check (or, in a build
 * without a site key, the bypass's). When the API refuses Turnstile's token (a 401
 * `auth_expired`: spent, expired, or not passed), one new check is run and the token asked for
 * once more; a second refusal rejects. Rejects as requestRunToken and turnstileToken do.
 */
export async function newRunToken(signal?: AbortSignal): Promise<RunToken> {
  const key = siteKey();
  if (!key) return requestRunToken(DEV_BYPASS_TOKEN, signal);
  try {
    return await requestRunToken(await turnstileToken(key, signal), signal);
  } catch (error) {
    if (!(error instanceof RunTokenError && error.code === 'auth_expired')) throw error;
    return requestRunToken(await turnstileToken(key, signal), signal);
  }
}

/** True while `token` may still be sent: until RUN_TOKEN_MARGIN_MS before it expires. */
export function isUsable(token: RunToken | null, now: number = Date.now()): token is RunToken {
  return token !== null && token.expiresAt - RUN_TOKEN_MARGIN_MS > now;
}

/** `url` with `token` in its query. */
export function withRunToken(url: string, token: RunToken): string {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}${RUN_TOKEN_PARAM}=${encodeURIComponent(token.runToken)}`;
}
