/**
 * The app's addresses, kept in the browser's history with pushState and read back on load and
 * on Back and Forward (popstate). No router library: the app has two kinds of address.
 *
 * - `/`: the search.
 * - `/t/<spotifyId>`: the result for one track. Links the app writes carry `?q=<title artist>`,
 *   the result's own title and artist, so a link to a track whose stored result cannot be read
 *   can still be analysed under a name.
 * - `/t/<spotifyId>/map`: the same result's song-relations map, full size; `?q=` as above.
 *
 * A build served under a path (the static demo's `--base /liner-notes/`) has those addresses
 * under it: `/liner-notes/t/<spotifyId>`.
 */

/** Where the app is. */
export type Route =
  | { kind: 'search' }
  | { kind: 'track' | 'map'; trackId: string; query: string | null };

/** The route of a result: its track, or its full-size map. */
export type TrackRoute = Extract<Route, { kind: 'track' | 'map' }>;

const TRACK_PATH = /^\/t\/([^/]+)\/?$/;
const MAP_PATH = /^\/t\/([^/]+)\/map\/?$/;

/** The path the build is served under, without its last slash: empty at the origin's root. */
export function basePath(baseUrl: string = import.meta.env.BASE_URL): string {
  return baseUrl.replace(/\/+$/, '');
}

/** `pathname` as the app reads it, the build's base taken off; null for a path outside it. */
function withinBase(pathname: string, base: string): string | null {
  if (base === '') return pathname;
  if (pathname === base) return '/';
  return pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : null;
}

/** The route of an address; null for a path the app does not know. */
export function parseRoute(
  pathname: string,
  search: string,
  base: string = basePath(),
): Route | null {
  const path = withinBase(pathname, base);
  if (path === null) return null;
  if (path === '/') return { kind: 'search' };
  const map = MAP_PATH.exec(path);
  const match = map ?? TRACK_PATH.exec(path);
  if (!match) return null;
  let trackId = match[1];
  try {
    trackId = decodeURIComponent(trackId);
  } catch {
    // A malformed escape is kept as written: it is not a track id either way.
  }
  const query = new URLSearchParams(search).get('q')?.trim() || null;
  return { kind: map ? 'map' : 'track', trackId, query };
}

/** The address of a route. */
export function routeUrl(route: Route, base: string = basePath()): string {
  if (route.kind === 'search') return `${base}/`;
  const path = `${base}/t/${encodeURIComponent(route.trackId)}${route.kind === 'map' ? '/map' : ''}`;
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
