import type React from 'react';
import { Pause, Play } from 'lucide-react';

/**
 * The related tracks that have a preview clip, each with a button that plays it or, playing,
 * stops it. The one place a preview starts: pointing at a track never plays one, and clicking it
 * analyses it. Collapsed by default; open, it lies over the graph as the list of links does.
 */
export const PreviewList: React.FC<{
  /** The related tracks with a clip: id and clip link. */
  tracks: ReadonlyArray<{ id: string; url: string }>;
  nameOf: (id: string) => string;
  /** The track whose preview is playing, if any. */
  playingId: string | null;
  /** Plays the track's preview, or stops it when it is the one playing. */
  onToggle: (id: string, url: string) => void;
}> = ({ tracks, nameOf, playingId, onToggle }) => {
  if (tracks.length === 0) return null;
  return (
    <details name="genealogy-lists" className="text-chrome font-mono text-text-chip">
      <summary className="cursor-pointer select-none text-text-secondary hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyber/70 rounded-sm">
        Previews ({tracks.length})
      </summary>
      <ul
        aria-label="Track previews"
        className="absolute bottom-full left-0 right-0 z-30 flex flex-col gap-1.5 max-h-[min(15rem,35dvh)] overflow-y-auto border-t border-white/10 bg-void px-4 py-3"
      >
        {tracks.map(({ id, url }) => {
          const playing = playingId === id;
          return (
            <li key={id}>
              <button
                type="button"
                aria-label={`Play preview of ${nameOf(id)}`}
                aria-pressed={playing}
                onClick={() => onToggle(id, url)}
                className={`inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-left hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyber/70 ${playing ? 'border-cyber/50 text-cyber' : 'border-white/15 text-text-secondary'}`}
              >
                {playing ? (
                  <Pause size={10} aria-hidden="true" className="shrink-0" />
                ) : (
                  <Play size={10} aria-hidden="true" className="shrink-0" />
                )}
                {nameOf(id)}
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
};
