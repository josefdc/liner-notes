import { routeUrl } from './route';

/**
 * The tracks explored in one chain: each analysed from the song-relations map of the one before
 * ("Analyze this track" in the map's detail panel). Kept in the history entries of the chain's
 * screens (App.tsx), never in storage or on the server: Back and Forward bring each screen's
 * trail back, a reload keeps it while the browser keeps the entry's state, and a shared link
 * has none.
 */

/** Where a step of the trail was left: the Player (its map panel) or the full-size map. */
export type TrailView = 'player' | 'map';

/** A track the chain went through, and the view its next track was analysed from. */
export interface TrailStep {
  trackId: string;
  title: string;
  artist: string | null;
  view: TrailView;
}

/** The steps before the track on screen, oldest first, and how many earlier ones were dropped. */
export interface Trail {
  steps: TrailStep[];
  earlier: number;
}

export const NO_TRAIL: Trail = { steps: [], earlier: 0 };

/** How many steps an entry keeps; older ones are only counted. */
export const TRAIL_KEPT = 50;
/** How many tracks the breadcrumb names, the one on screen included. */
export const TRAIL_SHOWN = 5;

/** The trail of the next track, analysed from `from`'s map: `from` added last. */
export function explore(trail: Trail, from: TrailStep, kept = TRAIL_KEPT): Trail {
  const steps = [...trail.steps, from];
  const over = Math.max(0, steps.length - kept);
  return { steps: steps.slice(over), earlier: trail.earlier + over };
}

/** The trail of the step at `index`, opened from the breadcrumb: the steps before it. */
export function trailBefore(trail: Trail, index: number): Trail {
  return { steps: trail.steps.slice(0, Math.max(0, index)), earlier: trail.earlier };
}

const VIEWS: ReadonlySet<unknown> = new Set<TrailView>(['player', 'map']);

const isStep = (value: unknown): value is TrailStep => {
  if (typeof value !== 'object' || value === null) return false;
  const step = value as Record<string, unknown>;
  return (
    typeof step.trackId === 'string' &&
    step.trackId !== '' &&
    typeof step.title === 'string' &&
    (step.artist === null || typeof step.artist === 'string') &&
    VIEWS.has(step.view)
  );
};

/**
 * The trail a history entry's state holds (`state.trail`), or none: an entry of another
 * version of the app, or one the app did not write, is read as having no trail.
 */
export function trailFromState(state: unknown): Trail {
  const trail = (state as { trail?: unknown } | null)?.trail as Partial<Trail> | undefined;
  if (!trail || !Array.isArray(trail.steps) || !trail.steps.every(isStep)) return NO_TRAIL;
  const earlier =
    typeof trail.earlier === 'number' && Number.isInteger(trail.earlier) && trail.earlier > 0
      ? trail.earlier
      : 0;
  return { steps: trail.steps.slice(-TRAIL_KEPT), earlier };
}

/** The address of a step: its track's Player, or its full-size map. */
export function stepUrl(step: TrailStep): string {
  const query = `${step.title} ${step.artist ?? ''}`.trim() || null;
  return routeUrl({ kind: step.view === 'map' ? 'map' : 'track', trackId: step.trackId, query });
}

/**
 * What the breadcrumb shows: the last steps (the track on screen counts as one of
 * `TRAIL_SHOWN`), each with its index in the trail, and how many earlier ones it leaves out.
 */
export function shownTrail(trail: Trail, shown = TRAIL_SHOWN) {
  const room = Math.max(0, shown - 1);
  const from = Math.max(0, trail.steps.length - room);
  return {
    steps: trail.steps.slice(from).map((step, offset) => ({ step, index: from + offset })),
    hidden: trail.earlier + from,
  };
}
