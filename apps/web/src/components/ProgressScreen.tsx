import type React from 'react';
import { useRef } from 'react';
import { ArrowRight, Check, Cpu, Square } from 'lucide-react';
import type { AgentLog } from '../types';
import type { AgentStatus } from '../hooks/agent/types';
import SystemConsole from './SystemConsole';
import { CoverThumb } from './AlbumCover';
import { Button } from './ui/Button';
import { nextProgress } from './console/progress';

// ─── Status Messages (P0:1) ────────────────────────────────────────────────
// What the analysis is doing, in plain words. The completion line is at most 40 characters: it
// is revealed up to 40ch (typing-reveal).
const STATUS_MESSAGES: Record<AgentStatus, string> = {
  idle: '',
  connecting: 'Connecting to the analysis server...',
  searching: 'Searching Spotify for your track...',
  // The engineer's step: measuring only while the server says a measurement runs.
  analyzing: 'Reading the audio...',
  measuring: 'Measuring tempo, key and energy from the preview clip...',
  researching: 'Searching sources for samples, credits and history...',
  composing: 'Writing the liner notes...',
  checking: 'Checking the notes against their sources...',
  // Used only when the server's own question is missing.
  disambiguation: 'Pick the track to analyze...',
  complete: 'Analysis complete. Opening the results',
  // Nothing here: an error replaces this view with the error block, which says what happened.
  error: '',
};

// While a recorded run plays, the recorded progress is not live work: these replace the
// messages above, so the screen does not describe a live analysis.
const REPLAY_PROGRESS_MESSAGE = 'Replaying a recorded analysis — nothing runs live...';
// At most 40 characters: the completion line is revealed up to 40ch (typing-reveal).
const REPLAY_COMPLETE_MESSAGE = 'Replay complete. Opening the results';

/**
 * The status line for a run, live or replayed. The server's own words for the step (`note`:
 * the picker's question, the composer's fallback) win; the picker is asked live in a replay too.
 */
function statusMessage(status: AgentStatus, isReplay: boolean, note: string | null): string {
  if (note && (!isReplay || status === 'disambiguation')) return note;
  if (!isReplay || status === 'idle' || status === 'error') return STATUS_MESSAGES[status];
  return status === 'complete' ? REPLAY_COMPLETE_MESSAGE : REPLAY_PROGRESS_MESSAGE;
}

/** The track a run is about, as the screen shows it. */
export interface ShownTrack {
  title: string;
  artist: string;
  coverUrl: string;
}

interface ProgressScreenProps {
  status: AgentStatus;
  logs: AgentLog[];
  /** The run replays a recorded run (the status line says so instead of the live steps). */
  isReplay: boolean;
  /** The server's own words for the step under way (useAgent's `statusNote`). */
  statusNote: string | null;
  /** The track being analysed, when it is known. */
  track: ShownTrack | null;
  /** The track picker, while the run waits for the user's pick. */
  picker?: React.ReactNode;
  /** The "Open the results" button is shown (the run has completed). */
  showCompletionButton: boolean;
  onOpenResults: () => void;
  /** The status line: the focus goes there after a pick or a retry. */
  statusRef?: React.Ref<HTMLDivElement>;
  /**
   * Stops the run: its stream is closed, which makes the server stop the analysis, and the
   * search comes back. Offered until the run completes, except while the picker is open (it has
   * its own way back to the search).
   */
  onStop?: () => void;
}

/**
 * The progress screen: the track, the picker when there is one, the run log, the bar and the
 * status line.
 *
 * What screen readers hear, and from where:
 * - The run log (SystemConsole's `role="log"`, polite) announces each line the run adds, once:
 *   the steps, the picker's question, "Analysis complete." It is the only region that speaks
 *   while the run is under way.
 * - The completion notice (`role="status"`, polite, empty until then) announces once, when the
 *   run completes, that the results are opening: they open by themselves a few seconds later
 *   (Onboarding), and the log does not say so. A replay says "Replay complete" there.
 * - The status line sums up the step the log already announced, so it is not a live region. It
 *   takes the focus when a search, a pick or a retry starts a step, and is read then.
 * - The progress bar is a `progressbar`, read when it is reached, never announced.
 */
export function ProgressScreen({
  status,
  logs,
  isReplay,
  statusNote,
  track,
  picker,
  showCompletionButton,
  onOpenResults,
  statusRef,
  onStop,
}: ProgressScreenProps) {
  // The bar's place: it never moves back within a run (console/progress.ts).
  const shownProgress = useRef(0);
  shownProgress.current = nextProgress(shownProgress.current, status);
  const progress = shownProgress.current;

  return (
    <div className="z-10 w-full max-w-2xl p-6">
      {/* Central Node Graphic (P1:11 — completion reveal animation). Its margin changes at
          once, not in a transition: the picker scrolls into view as it opens, and a margin
          still shrinking would move it after that (its question off the top of a short window). */}
      <div className={`flex justify-center ${status === 'disambiguation' ? 'mb-4' : 'mb-8'}`}>
        <div
          className={`relative ${status === 'complete' ? 'animate-completion-reveal' : ''} ${status === 'disambiguation' ? 'scale-75' : ''} transition-transform duration-300`}
        >
          <div
            className={`w-28 h-28 rounded-full border ${status === 'complete' ? 'border-status-success/50' : 'border-white/20'} flex items-center justify-center animate-spin-slow`}
          >
            <div
              className={`w-16 h-16 rounded-full border ${status === 'complete' ? 'border-status-success/30' : 'border-white/30'} flex items-center justify-center animate-spin-reverse`}
            >
              {status === 'complete' ? (
                <Check size={24} className="text-status-success" />
              ) : (
                <Cpu size={24} className="text-white opacity-80" />
              )}
            </div>
          </div>
          {/* Data Lines */}
          <div
            className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[200%] h-[1px] bg-gradient-to-r from-transparent ${status === 'complete' ? 'via-status-success/50' : 'via-white/30'} to-transparent animate-pulse`}
          ></div>
          <div
            className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[1px] h-[200%] bg-gradient-to-b from-transparent ${status === 'complete' ? 'via-status-success/50' : 'via-white/30'} to-transparent animate-pulse`}
          ></div>
          {/* Corner brackets */}
          <div
            className={`absolute -top-2 -left-2 w-4 h-4 border-l border-t ${status === 'complete' ? 'border-status-success/30' : 'border-white/30'}`}
          />
          <div
            className={`absolute -top-2 -right-2 w-4 h-4 border-r border-t ${status === 'complete' ? 'border-status-success/30' : 'border-white/30'}`}
          />
          <div
            className={`absolute -bottom-2 -left-2 w-4 h-4 border-l border-b ${status === 'complete' ? 'border-status-success/30' : 'border-white/30'}`}
          />
          <div
            className={`absolute -bottom-2 -right-2 w-4 h-4 border-r border-b ${status === 'complete' ? 'border-status-success/30' : 'border-white/30'}`}
          />
        </div>
      </div>

      {/* Currently Analyzing — P1:10 uses previewTrack || trackData */}
      {track && (
        <div className="flex flex-col items-center justify-center gap-4 mb-6 animate-fade-in">
          {/* No cover, or one that fails to load: nothing, as for a track without one */}
          <CoverThumb
            url={track.coverUrl}
            className="w-20 h-20 rounded-md shadow-lg border border-border"
            fallback={null}
          />
          <div className="text-center">
            <div className="text-white font-bold">{track.title}</div>
            <div className="text-text-tertiary text-sm">{track.artist}</div>
          </div>
        </div>
      )}

      {picker}

      {/* System Console */}
      <SystemConsole
        logs={logs}
        isComplete={status === 'complete'}
        isWaiting={status === 'disambiguation'}
        isReplay={isReplay}
      />

      {/* Progress Bar (P1:9 — ARIA progressbar, P2:16 — shimmer) */}
      <div
        className="w-full h-[3px] bg-white/5 mt-6 rounded-full overflow-hidden"
        role="progressbar"
        aria-valuenow={progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Analysis progress"
      >
        <div
          className={`h-full transition-all duration-700 ease-out relative rounded-full ${status === 'complete' ? 'bg-status-success' : 'bg-text-secondary'}`}
          style={{ width: `${progress}%` }}
        >
          {/* P2:16 Shimmer effect (only while loading, not on complete) */}
          {status !== 'complete' && progress > 0 && (
            <div
              className="absolute inset-0 animate-progress-shimmer"
              style={{
                backgroundImage:
                  'linear-gradient(90deg, transparent, var(--color-border-hover), transparent)',
                backgroundSize: '200px 100%',
                backgroundRepeat: 'no-repeat',
              }}
            />
          )}
        </div>
      </div>

      {/* The completion notice: in the page from the start of the run, so the one change of its
          text, at completion, is announced. */}
      <p role="status" className="sr-only">
        {status === 'complete' ? statusMessage(status, isReplay, statusNote) : ''}
      </p>

      {/* Status Text (P0:1 — human-readable messages). Not a live region: the run log
          announces the progress. Scrolled into view with a little room around it (its scroll
          margin): the scroll stops on a whole pixel, which could leave a fraction of it out. */}
      <div
        ref={statusRef}
        tabIndex={-1}
        data-progress-status
        className={`text-center mt-4 text-sm font-mono scroll-my-2 focus:outline-none ${status === 'complete' ? 'text-status-success animate-fade-in' : 'text-text-tertiary'}`}
      >
        {status === 'complete' ? (
          <span className="inline-block overflow-hidden whitespace-nowrap border-r-2 border-status-success animate-[typing-reveal_1s_steps(40)_forwards] max-w-0">
            {statusMessage(status, isReplay, statusNote)}
          </span>
        ) : (
          statusMessage(status, isReplay, statusNote)
        )}
      </div>

      {onStop && status !== 'complete' && !picker && (
        <div className="flex justify-center mt-4">
          <Button variant="ghost" size="sm" leftIcon={<Square size={12} />} onClick={onStop}>
            Stop
          </Button>
        </div>
      )}

      {/* UX: Completion skip button (Item 9) */}
      {status === 'complete' && showCompletionButton && (
        <div className="flex justify-center mt-4 animate-fade-in-up">
          <Button
            variant="neutral"
            size="md"
            rightIcon={<ArrowRight size={16} />}
            onClick={onOpenResults}
          >
            Open the results
          </Button>
        </div>
      )}
    </div>
  );
}
