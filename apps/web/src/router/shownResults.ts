import type { TrackData } from '../types';

/** How many results a page keeps for Back and Forward. */
export const SHOWN_RESULTS_LIMIT = 20;

/**
 * The results shown on this page, one per track id (the newest), for Back and Forward to show
 * again without a request. Bounded: past the limit the result shown longest ago is dropped,
 * and its entry reads the track's stored result instead, as a link does.
 */
export class ShownResults {
  private readonly results = new Map<string, TrackData>();

  constructor(private readonly limit = SHOWN_RESULTS_LIMIT) {}

  /** Keeps `track` as its id's result, now the most recently shown. */
  remember(track: TrackData) {
    // Taken out and put back: a Map keeps its keys in the order they were set.
    this.results.delete(track.id);
    this.results.set(track.id, track);
    while (this.results.size > this.limit) {
      const oldest = this.results.keys().next().value;
      if (oldest === undefined) break;
      this.results.delete(oldest);
    }
  }

  get(trackId: string): TrackData | undefined {
    return this.results.get(trackId);
  }

  get size() {
    return this.results.size;
  }
}
