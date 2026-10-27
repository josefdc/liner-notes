/**
 * Run tokens on the client. The API requires one on every analysis, resume and factoid request
 * (the `runToken` query parameter): POST /api/runs issues it once the visitor has passed
 * Turnstile. A build without a Turnstile site key sends the development bypass's token instead,
 * which only an API with no Turnstile secret, outside production, accepts.
 *
 * A token starts one analysis, within five minutes; that analysis's resume and any factoid
 * request may send it again until it expires.
 */

import { type RunToken, RunTokenError, requestRunToken } from './apiClient';

/** The query parameter the API reads a run token from. */
export const RUN_TOKEN_PARAM = 'runToken';

/** The Turnstile token the API's development bypass accepts. */
export const DEV_BYPASS_TOKEN = 'dev-bypass';

/** A token this close to its expiry is not sent again: a new one is asked for. */
export const RUN_TOKEN_MARGIN_MS = 30_000;

/** The token of a passed Turnstile check: the bypass's, while this build has no site key. */
async function turnstileToken(): Promise<string> {
  if (!import.meta.env.VITE_TURNSTILE_SITE_KEY) return DEV_BYPASS_TOKEN;
  throw new RunTokenError(
    'This version of the page cannot verify requests yet.',
    'verification_unavailable',
  );
}

/** A new run token from the API. Rejects as requestRunToken does. */
export async function newRunToken(signal?: AbortSignal): Promise<RunToken> {
  return requestRunToken(await turnstileToken(), signal);
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
