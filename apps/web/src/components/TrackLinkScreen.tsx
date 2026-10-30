import { useLayoutEffect, useRef } from 'react';
import { CircleAlert, Network, RotateCcw, Search } from 'lucide-react';
import { Button } from './ui/Button';

/**
 * What a link to a track (`/t/<spotifyId>`) shows until its stored result is on screen:
 * - `loading`: the stored result is being read (no analysis runs);
 * - `missing`: the API has no stored result of the track it can serve (none, or none it still
 *   accepts); Analyze starts one, and only on a click;
 * - `invalid`: the link does not name a Spotify track;
 * - `failed`: the stored result could not be read.
 */
export type TrackLinkState = 'loading' | 'missing' | 'invalid' | 'failed';

interface TrackLinkScreenProps {
  state: TrackLinkState;
  /** The track id in the link, as written. */
  trackId: string;
  /** The link's own words for the track (`?q=`), when it has them. */
  query: string | null;
  /** Starts an analysis of the track (shown only when it has no stored result). */
  onAnalyze: () => void;
  /** Reads the stored result again (after a failure). */
  onRetry: () => void;
  /** Goes to the search. */
  onSearch: () => void;
}

const TITLE: Record<TrackLinkState, string> = {
  loading: 'Loading the stored analysis...',
  missing: 'No stored analysis for this track yet',
  invalid: 'This link does not lead to a track',
  failed: 'The stored analysis could not be loaded',
};

const TEXT: Record<TrackLinkState, string> = {
  loading: 'Reading the latest analysis of this track. Nothing is analyzed again.',
  missing:
    'Liner Notes has no stored analysis of this track that it can show. Analyze it to trace its samples, credits, history and sound.',
  invalid: 'A track link ends with a Spotify track id: 22 letters and digits.',
  failed:
    "The analysis server did not send it. The problem may be on your side or on the server's. Try again in a moment.",
};

/** A secondary action, set as an underlined line of text. */
const TEXT_BUTTON =
  'text-xs font-mono text-text-tertiary hover:text-text-secondary underline underline-offset-4 transition-colors rounded-sm focus-visible:text-text-secondary focus-visible:ring-1 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-hidden';

export function TrackLinkScreen({
  state,
  trackId,
  query,
  onAnalyze,
  onRetry,
  onSearch,
}: TrackLinkScreenProps) {
  // Each state's heading takes the focus: the view the user came from is gone, and the focus
  // would fall to the page. It is a new element for each state (its key), so a screen reader
  // reads it as it takes the focus: a heading that only changed its words while it had the
  // focus would be read by none.
  const headingRef = useRef<HTMLHeadingElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new state is the trigger
  useLayoutEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [state]);

  const isProblem = state === 'invalid' || state === 'failed';

  return (
    <div className="h-full w-full overflow-y-auto overflow-x-hidden flex flex-col items-center bg-void px-(--space-md) py-(--space-xl)">
      <section
        aria-labelledby="track-link-title"
        aria-busy={state === 'loading'}
        className="my-auto w-full max-w-md text-center space-y-6 animate-fade-in"
      >
        <Network size={40} aria-hidden="true" className="text-cyber mx-auto" />
        <h1
          key={state}
          id="track-link-title"
          ref={headingRef}
          tabIndex={-1}
          aria-describedby="track-link-text"
          className={`text-xl font-sans font-light tracking-wide text-balance flex items-center justify-center gap-2 focus-visible:outline-hidden ${isProblem ? 'text-status-error' : 'text-text-primary'}`}
        >
          {isProblem && <CircleAlert size={18} aria-hidden="true" className="shrink-0" />}
          {TITLE[state]}
        </h1>
        <p id="track-link-text" className="text-text-secondary text-sm leading-relaxed">
          {TEXT[state]}
        </p>

        {/* The link's words are shown as the link's, not as the track's verified name */}
        <dl className="text-xs font-mono text-text-tertiary space-y-1 break-words">
          {query && (
            <div>
              <dt className="inline">Named in the link: </dt>
              <dd className="inline text-text-secondary">{query}</dd>
            </div>
          )}
          <div>
            <dt className="inline">Spotify track id: </dt>
            <dd className="inline text-text-secondary">{trackId}</dd>
          </div>
        </dl>

        {/* While the API takes its time (up to the request's deadline), the search stays one
            step away */}
        {state === 'loading' && (
          <div className="flex justify-center">
            <button type="button" onClick={onSearch} className={TEXT_BUTTON}>
              Search for a song
            </button>
          </div>
        )}
        {state !== 'loading' && (
          <div className="flex flex-col items-center gap-3">
            {state === 'missing' && (
              <Button variant="cyber" size="md" onClick={onAnalyze}>
                Analyze
              </Button>
            )}
            {state === 'failed' && (
              <Button
                variant="neutral"
                size="md"
                leftIcon={<RotateCcw size={14} />}
                onClick={onRetry}
              >
                Try again
              </Button>
            )}
            {state === 'invalid' ? (
              <Button variant="cyber" size="md" leftIcon={<Search size={14} />} onClick={onSearch}>
                Search for a song
              </Button>
            ) : (
              <button type="button" onClick={onSearch} className={TEXT_BUTTON}>
                or search for a song
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
