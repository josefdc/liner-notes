// Checks on VITE_API_URL, run when Vite loads its config (vite.config.ts). The app itself only
// trims a trailing slash (src/hooks/agent/types.ts), so a value that cannot work would otherwise
// show up as failed requests at run time.

/** The path the dev and preview servers forward to the local API. */
export const PROXIED_PATH = '/api';

/**
 * Returns what is wrong with a VITE_API_URL value, or null when it looks usable. `serving` is
 * true for `vite` and `vite preview`, where only PROXIED_PATH is forwarded to the API.
 */
export function apiUrlWarning(value: string | undefined, serving: boolean): string | null {
  const base = value?.trim().replace(/\/+$/, '');
  if (!base) return null;

  if (base.startsWith('/') && !base.startsWith('//')) {
    if (serving && base !== PROXIED_PATH) {
      return `VITE_API_URL="${value}": the dev and preview servers forward only ${PROXIED_PATH} to the API, so requests to ${base} get the app's index.html`;
    }
    return null;
  }

  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return `VITE_API_URL="${value}" is neither a path starting with / nor an absolute http(s) URL`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `VITE_API_URL="${value}" is neither a path starting with / nor an absolute http(s) URL`;
  }
  if (url.pathname === '/' || url.pathname === '') {
    return `VITE_API_URL="${value}" has no path; the API's routes live under ${PROXIED_PATH} (e.g. ${url.origin}${PROXIED_PATH})`;
  }
  return null;
}
