import type { TrackLinkState } from '../components/TrackLinkScreen';
import { AppPhase, type TrackData } from '../types';
import { isSpotifyTrackId } from '../utils/spotify';
import { type Route, routeUrl, type TrackRoute } from './route';
import { NO_TRAIL, type Trail, trailFromState } from './trail';

/** A link to a track (`/t/<spotifyId>`, or its map) whose result is not on screen yet. */
export interface TrackLink {
  trackId: string;
  /** The link's own words for the track (`?q=`). */
  query: string | null;
  state: TrackLinkState;
}

export const linkTo = (route: TrackRoute): TrackLink => ({
  trackId: route.trackId,
  query: route.query,
  // An id that cannot be a Spotify track id is not sent to the API.
  state: isSpotifyTrackId(route.trackId) ? 'loading' : 'invalid',
});

/** What the app stores in each browser history entry. */
export interface HistoryEntry {
  phase: AppPhase;
  /** In-app entries behind this one. */
  index: number;
  /** Pushed when a search started; its result replaces it. */
  search?: boolean;
  /** The entry's address. */
  url: string;
  /** The tracks explored before this one (router/trail.ts); none when absent. */
  trail?: Trail;
  /** The Player's open tab on phones, kept for Back and Forward to it. */
  tab?: string;
  /** A full-size map opened from its track's Player: "Back to" the track goes back to it. */
  fromPlayer?: boolean;
  /**
   * The progress of a track analysed from a result: the entry behind it is that result's, so
   * "Back to the last result" goes back to it.
   */
  fromResult?: boolean;
}

/**
 * The address of a screen: `/` for the search (and an analysis under way), the link's own
 * address while its result loads, `/t/<id>?q=<title artist>` for a result and
 * `/t/<id>/map?q=<title artist>` for its full-size map.
 */
export function addressOf(
  phase: AppPhase,
  track: TrackData | null,
  link: TrackLink | null,
): string {
  const kind = phase === AppPhase.MAP ? 'map' : 'track';
  if (link) return routeUrl({ kind, trackId: link.trackId, query: link.query });
  // Only a Spotify track id makes a link that loads again: a result under any other id (a
  // recording's placeholder) keeps the search's address rather than one the page calls invalid.
  if (phase === AppPhase.ONBOARDING || !isSpotifyTrackId(track?.id))
    return routeUrl({ kind: 'search' });
  const query = `${track.title ?? ''} ${track.artist ?? ''}`.trim() || null;
  return routeUrl({ kind, trackId: track.id, query });
}

/**
 * The screen the page opens on, from its address and its history entry's state (which survives
 * a reload): the search, or the result its address names, with the entry's trail and tab.
 */
export function openingScreen(
  route: Route | null,
  state: unknown,
): {
  phase: AppPhase;
  link: TrackLink | null;
  trail: Trail;
  tab: string | undefined;
  fromPlayer: boolean;
} {
  if (route?.kind !== 'track' && route?.kind !== 'map') {
    return {
      phase: AppPhase.ONBOARDING,
      link: null,
      trail: NO_TRAIL,
      tab: undefined,
      fromPlayer: false,
    };
  }
  const saved = state as Partial<HistoryEntry> | null;
  // A reload of the Player keeps the Player; a map's address is the map's.
  const phase =
    route.kind === 'map'
      ? AppPhase.MAP
      : saved?.phase === AppPhase.PLAYER
        ? AppPhase.PLAYER
        : AppPhase.DASHBOARD;
  return {
    phase,
    link: linkTo(route),
    trail: trailFromState(saved),
    tab: typeof saved?.tab === 'string' ? saved.tab : undefined,
    fromPlayer: route.kind === 'map' && saved?.fromPlayer === true,
  };
}
