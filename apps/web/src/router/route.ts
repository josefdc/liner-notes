/**
 * The app's addresses, kept in the browser's history with pushState and read back on load and
 * on Back and Forward (popstate). No router library: the app has two kinds of address.
 *
 * - `/`: the search.
 * - `/t/<spotifyId>`: the result for one track. Links the app writes carry `?q=<title artist>`,
 *   the words the track was found by, so a link to a track that has no stored result yet can
 *   still be analysed under a name.
 */

/** Where the app is. */
export type Route = { kind: 'search' } | { kind: 'track'; trackId: string; query: string | null };

const TRACK_PATH = /^\/t\/([^/]+)\/?$/;

/** The route of an address; null for a path the app does not know. */
export function parseRoute(pathname: string, search: string): Route | null {
  if (pathname === '/') return { kind: 'search' };
  const match = TRACK_PATH.exec(pathname);
  if (!match) return null;
  let trackId = match[1];
  try {
    trackId = decodeURIComponent(trackId);
  } catch {
    // A malformed escape is kept as written: it is not a track id either way.
  }
  const query = new URLSearchParams(search).get('q')?.trim() || null;
  return { kind: 'track', trackId, query };
}

/** The address of a route. */
export function routeUrl(route: Route): string {
  if (route.kind === 'search') return '/';
  const path = `/t/${encodeURIComponent(route.trackId)}`;
  return route.query ? `${path}?${new URLSearchParams({ q: route.query })}` : path;
}

/** The route of the page's current address; null for a path the app does not know. */
export function currentRoute(): Route | null {
  return parseRoute(window.location.pathname, window.location.search);
}

/** Adds a history entry (`push`) or rewrites the current one (`replace`). */
export function writeHistoryEntry(state: unknown, url: string, mode: 'push' | 'replace') {
  if (mode === 'push') window.history.pushState(state, '', url);
  else window.history.replaceState(state, '', url);
}

/**
 * Calls `listener` with the new route and the entry's state when Back or Forward moves to
 * another entry. Returns the function that stops listening.
 */
export function onHistoryMove(listener: (route: Route | null, state: unknown) => void) {
  const handle = (event: PopStateEvent) => listener(currentRoute(), event.state);
  window.addEventListener('popstate', handle);
  return () => window.removeEventListener('popstate', handle);
}
