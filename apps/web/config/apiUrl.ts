// Checks on VITE_API_URL, run when Vite loads its config (vite.config.ts). The app itself only
// trims a trailing slash (src/hooks/agent/types.ts), so a value that cannot work would otherwise
// show up as failed requests at run time.

/** The path the dev and preview servers forward to the local API. */
export const PROXIED_PATH = '/api';

export type ApiUrlProblem = { level: 'error' | 'warning'; message: string };

/**
 * What is wrong with a VITE_API_URL value, or null when it looks usable. An `error` cannot work
 * anywhere and fails the config; a `warning` is about the dev and preview servers (`serving`),
 * which forward only PROXIED_PATH to the API.
 */
export function apiUrlProblem(value: string | undefined, serving: boolean): ApiUrlProblem | null {
  const base = value?.trim().replace(/\/+$/, '');
  if (!base) return null;
  const error = (message: string): ApiUrlProblem => ({
    level: 'error',
    message: `VITE_API_URL="${value}" ${message}`,
  });

  if (base.startsWith('/') && !base.startsWith('//')) {
    if (serving && base !== PROXIED_PATH) {
      return {
        level: 'warning',
        message: `VITE_API_URL="${value}": the dev and preview servers forward only ${PROXIED_PATH} to the API, so requests to ${base} get the app's index.html`,
      };
    }
    return null;
  }

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return error('is neither a path starting with / nor an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return error('is neither a path starting with / nor an absolute http(s) URL');
  }
  if (url.pathname === '/' || url.pathname === '') {
    return error(
      `has no path; the API's routes live under ${PROXIED_PATH} (e.g. ${url.origin}${PROXIED_PATH})`,
    );
  }
  return null;
}

/**
 * Where the dev and preview servers send PROXIED_PATH: API_PROXY_TARGET when set (an http(s)
 * origin, e.g. an API in a container or on another machine), else the local API on API_PORT.
 */
export function apiProxyTarget(env: { API_PROXY_TARGET?: string; API_PORT?: string }): string {
  const configured = env.API_PROXY_TARGET?.trim();
  if (!configured) return `http://127.0.0.1:${env.API_PORT || '3001'}`;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(`API_PROXY_TARGET="${configured}" is not an http(s) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`API_PROXY_TARGET="${configured}" is not an http(s) URL`);
  }
  if (url.pathname !== '/' || url.search) {
    throw new Error(
      `API_PROXY_TARGET="${configured}" must be an origin without a path; ${PROXIED_PATH} is appended as requested`,
    );
  }
  return url.origin;
}
