import type React from 'react';
import { useEffect, useState } from 'react';
import { Disc3, ExternalLink } from 'lucide-react';
import { fetchReplays, type ReplayTrack } from '../hooks/agent/apiClient';
import { SOURCE_URL } from '../sourceUrl';

interface DemoShowcaseProps {
  /** Replays a recorded track. */
  onPick: (track: ReplayTrack) => void;
  /** Loads the recorded tracks (default: the demo's own list). */
  loadReplays?: () => Promise<ReplayTrack[]>;
}

/**
 * The static demo's opening: what this page is, the recorded tracks it can replay and where to
 * run it on any song. Only the static demo's build shows it (Onboarding).
 */
const DemoShowcase: React.FC<DemoShowcaseProps> = ({ onPick, loadReplays = fetchReplays }) => {
  const [tracks, setTracks] = useState<ReplayTrack[]>([]);

  useEffect(() => {
    let current = true;
    loadReplays().then(
      (loaded) => {
        if (current) setTracks(loaded);
      },
      () => {},
    );
    return () => {
      current = false;
    };
  }, [loadReplays]);

  return (
    <section aria-label="Recorded tracks in this demo" className="space-y-3">
      {tracks.length > 0 && (
        <ul className="flex flex-wrap justify-center gap-2">
          {tracks.map((track) => (
            <li key={track.id}>
              <button
                type="button"
                onClick={() => onPick(track)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-sm text-left bg-white/5 border border-transparent hover:bg-white/10 hover:border-white/20 transition-colors focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-hidden"
              >
                <Disc3 size={14} className="text-text-tertiary flex-shrink-0" aria-hidden="true" />
                <span className="text-white text-xs font-mono">{track.title}</span>
                <span className="sr-only">by {track.artist}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-text-tertiary text-xs font-mono leading-relaxed">
        This demo replays {tracks.length || 'a few'} recorded runs in your browser: no server, no
        model calls. To analyse any song,{' '}
        <a
          href={SOURCE_URL}
          className="text-cyber underline underline-offset-4 whitespace-nowrap rounded-sm focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-hidden"
        >
          run it yourself
          <ExternalLink size={12} className="inline ml-1 align-baseline" aria-hidden="true" />
        </a>
        .
      </p>
    </section>
  );
};

export default DemoShowcase;
