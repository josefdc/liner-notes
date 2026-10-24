import type React from 'react';
import { useEffect, useState } from 'react';
import { CirclePause, Disc3 } from 'lucide-react';
import { fetchReplays, type ReplayTrack } from '../hooks/agent/apiClient';
import { recordedDate } from '../utils/recordedDate';
import type { LiveUnavailableCode } from './liveUnavailable';

const COPY: Record<LiveUnavailableCode, { title: string; text: string }> = {
  budget_exhausted: {
    title: 'Live analysis paused',
    text:
      'The budget for live analysis is spent for now, so no new song is analysed. ' +
      'The recorded runs below can still be shown. Each one is labelled as a recording, ' +
      'not a live analysis.',
  },
  live_disabled: {
    title: 'Live analysis is off here',
    text:
      'This server does not analyse songs live: it only replays recorded runs. ' +
      'Pick a recorded track below. It is shown as a recording, not a live analysis.',
  },
};

interface BudgetBannerProps {
  code: LiveUnavailableCode;
  /** Analyses a recorded track (by its title and artist, which replays its recording). */
  onPick: (track: ReplayTrack) => void;
  /** Loads the recorded tracks (default: GET /api/replays). */
  loadReplays?: () => Promise<ReplayTrack[]>;
}

type Listing =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'loaded'; tracks: ReplayTrack[] };

/**
 * Shown instead of a result when the API cannot analyse live (the budget is spent, or the
 * server only replays recordings): says why, and offers the recorded showcase tracks. It never
 * shows a result of its own.
 */
const BudgetBanner: React.FC<BudgetBannerProps> = ({
  code,
  onPick,
  loadReplays = fetchReplays,
}) => {
  const [listing, setListing] = useState<Listing>({ state: 'loading' });
  const { title, text } = COPY[code];

  useEffect(() => {
    let current = true;
    loadReplays().then(
      (tracks) => {
        if (current) setListing({ state: 'loaded', tracks });
      },
      () => {
        if (current) setListing({ state: 'failed' });
      },
    );
    return () => {
      current = false;
    };
  }, [loadReplays]);

  return (
    <section
      aria-label={title}
      className="bg-analog/5 border border-analog/30 rounded-md p-6 space-y-4 text-left"
    >
      <h2 className="text-analog text-sm font-mono uppercase tracking-widest flex items-center justify-center gap-2">
        <CirclePause size={16} aria-hidden="true" />
        {title}
      </h2>
      <p className="text-text-secondary text-xs font-mono leading-relaxed">{text}</p>

      {listing.state === 'loading' && (
        <p role="status" className="text-text-tertiary text-xs font-mono">
          Loading the recorded tracks...
        </p>
      )}
      {listing.state === 'failed' && (
        <p role="status" className="text-text-tertiary text-xs font-mono">
          The recorded tracks could not be loaded. Try again later.
        </p>
      )}
      {listing.state === 'loaded' && listing.tracks.length === 0 && (
        <p role="status" className="text-text-tertiary text-xs font-mono">
          No recorded tracks are available on this server.
        </p>
      )}
      {listing.state === 'loaded' && listing.tracks.length > 0 && (
        <ul aria-label="Recorded tracks" className="space-y-1">
          {listing.tracks.map((track) => {
            const date = recordedDate(track.recordedAt);
            return (
              <li key={track.id}>
                <button
                  type="button"
                  onClick={() => onPick(track)}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-sm text-left bg-white/5 border border-transparent hover:bg-white/10 hover:border-analog/30 transition-colors focus-visible:ring-2 focus-visible:ring-analog/30 focus-visible:outline-none"
                >
                  <Disc3 size={16} className="text-analog flex-shrink-0" aria-hidden="true" />
                  <span className="flex-1 min-w-0">
                    <span className="block text-white text-sm font-mono truncate">
                      {track.title}
                    </span>
                    <span className="block text-text-tertiary text-xs truncate">
                      {track.artist}
                      {date ? ` • recorded ${date}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

export default BudgetBanner;
