import type React from 'react';
import { Component, lazy, Suspense, useEffect, useState, useRef, useCallback } from 'react';
import type { TrackData, AgentLog } from '../types';
import {
  Network,
  Cpu,
  Search,
  Check,
  CircleAlert,
  RotateCcw,
  ArrowRight,
  ArrowLeft,
} from 'lucide-react';
import type { AgentStatus, AnalyzeOptions, PickedBy, SearchCandidate } from '../hooks/agent/types';
import SystemConsole from './SystemConsole';
import { CoverThumb } from './AlbumCover';
import {
  isLiveUnavailable,
  LIVE_UNAVAILABLE_COPY,
  type LiveUnavailableCode,
} from '../liveUnavailable';
import type { ReplayTrack } from '../hooks/agent/apiClient';
import { Button } from './ui/Button';
import { SearchBox } from './search/SearchBox';
import type { SuggestionFetcher } from './search/useSuggestions';
import { ANALYZING_STATUSES, nextProgress } from './console/progress';

// Loaded only when live analysis turns out to be unavailable.
const BudgetBanner = lazy(() => import('./BudgetBanner'));

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
// messages above, so neither the screen nor the screen reader describes a live analysis.
const REPLAY_PROGRESS_MESSAGE = 'Replaying a recorded analysis — nothing runs live...';
// At most 40 characters: the completion line is revealed up to 40ch (typing-reveal).
export const REPLAY_COMPLETE_MESSAGE = 'Replay complete. Opening the results';

/**
 * The status line for a run, live or replayed. The server's own words for the step (`note`:
 * the picker's question, the composer's fallback) win; the picker is asked live in a replay too.
 */
function statusMessage(status: AgentStatus, isReplay: boolean, note: string | null): string {
  if (note && (!isReplay || status === 'disambiguation')) return note;
  if (!isReplay || status === 'idle' || status === 'error') return STATUS_MESSAGES[status];
  return status === 'complete' ? REPLAY_COMPLETE_MESSAGE : REPLAY_PROGRESS_MESSAGE;
}

/**
 * Shows the paused-analysis banner, or, when its code cannot be loaded (a page older than the
 * deployed version, a dropped connection), the same explanation in plain text: never an empty
 * page in the state the banner exists for.
 */
class BannerBoundary extends Component<
  { code: LiveUnavailableCode; children: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const { title, text } = LIVE_UNAVAILABLE_COPY[this.props.code];
    return (
      <section
        aria-label={title}
        className="bg-status-warning/5 border border-status-warning/30 rounded-md p-6 space-y-4 text-left"
      >
        <div role="alert" className="space-y-4">
          <h2 className="text-status-warning text-sm font-mono uppercase tracking-widest text-center">
            {title}
          </h2>
          <p className="text-text-secondary text-xs font-mono leading-relaxed">{text}</p>
        </div>
        <p className="text-text-tertiary text-xs font-mono">
          The recorded tracks could not be loaded. Reload the page to see them.
        </p>
        <div className="flex justify-center">
          <Button
            variant="neutral"
            size="md"
            leftIcon={<RotateCcw size={14} />}
            onClick={() => window.location.reload()}
          >
            Reload the page
          </Button>
        </div>
      </section>
    );
  }
}

/** The picker row a navigation key moves the highlight to, or null for other keys. */
function pickerTarget(key: string, current: number, count: number): number | null {
  switch (key) {
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** The heading of the error block. */
const ERROR_TITLE = 'The analysis did not finish';

/** The error block's primary button: the step that can help after this failure. */
type ErrorAction = 'retry' | 'search' | 'reload';

interface ErrorView {
  /** What happened and what to do next. */
  lines: string[];
  action: ErrorAction;
}

const NEXT_STEP = 'Try again, or search for a different song.';
const GENERIC_ERROR = `Something went wrong. ${NEXT_STEP}`;
const NO_MATCH = 'No song matched your search. Check the title and artist, then search again.';
const CHOICE_CLOSED = 'That choice is no longer open. Try again to get a fresh list of tracks.';
const UNREADABLE_REQUEST = 'The request could not be read. Search again.';
// The connection can fail on either side (the user's network, or a server that is down or
// restarting): neither is blamed.
const EITHER_SIDE = "The problem may be on your side or on the server's. Try again in a moment.";
const CONNECTION_LOST = `The connection to the analysis server was lost. ${EITHER_SIDE}`;

const view = (line: string, action: ErrorAction): ErrorView => ({ lines: [line], action });

// The page's words, for the codes whose server message says nothing more than the code, and for
// the app's own codes (useAgent's CLIENT_ERROR_CODES and OUTDATED_ERROR). A code that is not here
// (rate_limited, upstream_unavailable, failed, internal_error, and any code this page does not
// know) shows the server's own message: it can say how long to wait, or which service refused.
const ERROR_VIEW_BY_CODE: Record<string, ErrorView> = {
  no_match: view(NO_MATCH, 'search'),
  choice_expired: view(CHOICE_CLOSED, 'retry'),
  run_interrupted: view(CHOICE_CLOSED, 'retry'),
  not_waiting: view(CHOICE_CLOSED, 'retry'),
  invalid_selection: view(CHOICE_CLOSED, 'retry'),
  // The run's own deadline: the whole analysis took too long, not one service.
  timeout: view(`The analysis took too long and was stopped. ${NEXT_STEP}`, 'retry'),
  forbidden_origin: view(
    'The analysis server does not accept requests from this page. Open Liner Notes at its usual address, then search again.',
    'search',
  ),
  invalid_input: view(UNREADABLE_REQUEST, 'search'),
  invalid_json: view(UNREADABLE_REQUEST, 'search'),
  bad_request: view(UNREADABLE_REQUEST, 'search'),
  // The app's own codes.
  wrong_track: view(
    'The recording found is not the track you picked, so it is not shown. Search again to pick another take.',
    'search',
  ),
  no_result: view(`The analysis ended without a result. ${NEXT_STEP}`, 'retry'),
  stream_stalled: view(`The analysis server stopped answering. ${EITHER_SIDE}`, 'retry'),
  connection_lost: view(CONNECTION_LOST, 'retry'),
  stream_open_failed: view('The analysis could not be started. Try again in a moment.', 'retry'),
  resume_failed: view(
    'Your choice could not be sent to the analysis server. Try again in a moment.',
    'retry',
  ),
  choice_lost: view('The track you picked could not be found again. Search again.', 'search'),
  // A newer version was deployed since this page loaded: retrying from this page cannot help.
  outdated_client: view(
    'This page is out of date. Reload the page to get the new version, then search again.',
    'reload',
  ),
};

/**
 * What the error block says, and its primary button. A code with the page's own words gets
 * them. Any other code shows the server's message (written for people, by the contract), with
 * the next step only when the message gives none. Every failure useAgent raises carries a code,
 * so an error without one is a server `error` event with an empty code: its text is not shown
 * (it could be anything), only read for the kind of failure.
 */
function errorView(error: string | null, code: string | null): ErrorView {
  if (code) {
    // Own keys only: a code such as "toString" or "constructor" is not one of these.
    const known = Object.hasOwn(ERROR_VIEW_BY_CODE, code) ? ERROR_VIEW_BY_CODE[code] : undefined;
    if (known) return known;
    if (!error) return view(GENERIC_ERROR, 'retry');
    return { lines: /try again/i.test(error) ? [error] : [error, NEXT_STEP], action: 'retry' };
  }
  const text = error ?? '';
  if (/connection|network|fetch|offline|responding|timed? ?out/i.test(text)) {
    return view(CONNECTION_LOST, 'retry');
  }
  if (/not (?:be )?found|no match|no results|\b404\b/i.test(text)) return view(NO_MATCH, 'search');
  return view(GENERIC_ERROR, 'retry');
}

const ERROR_ACTION_LABEL: Record<ErrorAction, string> = {
  retry: 'Try again',
  search: 'Search again',
  reload: 'Reload the page',
};

interface OnboardingProps {
  status: AgentStatus;
  logs: AgentLog[];
  trackData: TrackData | null;
  error: string | null;
  /**
   * The failure code of the error: the server's, or the app's own for a failure useAgent
   * raised itself (see agent/types.ts).
   */
  errorCode: string | null;
  isLoading: boolean;
  /** The run replays a recorded run (the status line says so instead of the live steps). */
  isReplay?: boolean;
  /** The server's own words for the step under way (useAgent's `statusNote`). */
  statusNote?: string | null;
  candidates: SearchCandidate[] | null;
  analyze: (query: string, options?: AnalyzeOptions) => Promise<void>;
  selectCandidate: (candidateId: string, pickedBy?: PickedBy) => Promise<void>;
  /** Runs the failed analysis again. */
  retry: () => void;
  searchSuggest: SuggestionFetcher;
  onComplete: (trackData: TrackData) => void;
  // UX: Focus management
  searchInputRef?: React.Ref<HTMLInputElement>;
  // UX: Session restore
  onRestorePrevious?: () => void;
  /** Leaves the track picker for the search box, the query kept. */
  onSearchAgain?: () => void;
}

const Onboarding: React.FC<OnboardingProps> = ({
  status,
  logs,
  trackData,
  error,
  errorCode,
  isLoading,
  isReplay = false,
  statusNote = null,
  candidates,
  analyze,
  selectCandidate,
  retry,
  searchSuggest,
  onComplete,
  searchInputRef,
  onRestorePrevious,
  onSearchAgain,
}) => {
  // Kept here, not in the search box: the box is gone while a run is under way, and "Search
  // again" brings it back with the same text.
  const [searchQuery, setSearchQuery] = useState('');

  const inputRef = useRef<HTMLInputElement | null>(null);
  // One ref function for the component's life, giving the search box to this component and to
  // the app (which focuses it when the search comes back).
  const setSearchInput = useCallback(
    (element: HTMLInputElement | null) => {
      inputRef.current = element;
      if (typeof searchInputRef === 'function') searchInputRef(element);
      else if (searchInputRef) searchInputRef.current = element;
    },
    [searchInputRef],
  );

  // ─── P1:10 Track preview state ────────────────────────────────────────────
  const [previewTrack, setPreviewTrack] = useState<{
    title: string;
    artist: string;
    coverUrl: string;
  } | null>(null);

  // ─── P1:9 Debounced ARIA live region ──────────────────────────────────────
  const [announcedStatus, setAnnouncedStatus] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => {
      const message = statusMessage(status, isReplay, statusNote);
      if (message) setAnnouncedStatus(message);
    }, 500);
    return () => clearTimeout(timer);
  }, [status, isReplay, statusNote]);

  // ─── P1:14 HITL disambiguation state ─────────────────────────────────────
  const [hitlSelectedIndex, setHitlSelectedIndex] = useState(0);
  const [hitlCountdown, setHitlCountdown] = useState<number | null>(null);
  const hitlRowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // UX: HITL pause-on-hover (Item 6)
  const [hitlPaused, setHitlPaused] = useState(false);
  // UX: Auto-scroll to disambiguation when it appears
  const hitlRef = useRef<HTMLDivElement>(null);

  // UX: Completion skip button (Item 9)
  const [showCompletionButton, setShowCompletionButton] = useState(false);
  const completionAutoRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A suggestion chosen with Enter or a click (P1:10 — set preview).
  const handlePickSuggestion = useCallback(
    (candidate: SearchCandidate) => {
      setPreviewTrack({
        title: candidate.title,
        artist: candidate.artist,
        coverUrl: candidate.coverUrl,
      });
      // The suggestion's own track is analysed, by its id: not whatever its text finds (a
      // re-recording or a cover with the same title). It is a deliberate click on that track,
      // so the result does not warn that the text matched it loosely (a self-titled song, such
      // as "Black Sabbath" by Black Sabbath, reads as a partial match of its own text).
      analyze(`${candidate.title} ${candidate.artist}`, {
        trackId: candidate.id,
        pickedBy: 'click',
      });
    },
    [analyze],
  );

  // Handle completion (Item 9 — skip button + silent auto-proceed)
  useEffect(() => {
    if (status === 'complete' && trackData) {
      // Show button after 400ms delay
      const showTimer = setTimeout(() => setShowCompletionButton(true), 400);
      // Silent auto-proceed at 3.5s (no visible countdown)
      completionAutoRef.current = setTimeout(() => {
        onComplete(trackData!);
      }, 3500);
      return () => {
        clearTimeout(showTimer);
        if (completionAutoRef.current) clearTimeout(completionAutoRef.current);
        setShowCompletionButton(false);
      };
    }
  }, [status, trackData, onComplete]);

  const handleCompletionSkip = useCallback(() => {
    if (completionAutoRef.current) clearTimeout(completionAutoRef.current);
    if (trackData) onComplete(trackData);
  }, [trackData, onComplete]);

  // A typed search: whatever track an earlier pick showed is not this search's.
  const handleSearch = useCallback(
    (query: string) => {
      setPreviewTrack(null);
      analyze(query);
    },
    [analyze],
  );

  // The error block shows plain words; the error's own text goes to the console.
  const showsErrorBlock = status === 'error' && !isLiveUnavailable(errorCode);
  // Each failure, told apart by the log line useAgent's `fail()` writes for it: a retry that
  // fails at once leaves the block up (no new mount), and is still a new failure.
  let failureId: string | null = null;
  if (showsErrorBlock) {
    for (let index = logs.length - 1; index >= 0; index--) {
      if (logs[index].code === 'SYS-ERROR') {
        failureId = logs[index].id;
        break;
      }
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: logged once per failure (failureId)
  useEffect(() => {
    if (showsErrorBlock)
      console.warn('[Onboarding] The analysis failed:', errorCode ?? '(no code)', error);
  }, [showsErrorBlock, failureId, error, errorCode]);
  // The block replaces the view that had the focus (the progress screen, the picker): its
  // heading takes the focus for each failure, so it is announced with what happened (its
  // description) and focus never falls to the page.
  const errorHeadingRef = useRef<HTMLHeadingElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per failure (failureId)
  useEffect(() => {
    if (showsErrorBlock) errorHeadingRef.current?.focus();
  }, [showsErrorBlock, failureId]);
  const shownError = showsErrorBlock ? errorView(error, errorCode) : null;

  const isAnalyzing = isLoading || ANALYZING_STATUSES.has(status);

  // ─── P1:14 HITL disambiguation logic ──────────────────────────────────────
  // Any candidate list is shown to the user; nothing is chosen without them seeing it.
  const showPicker = status === 'disambiguation' && !!candidates && candidates.length > 0;

  useEffect(() => {
    if (status === 'disambiguation' && candidates && candidates.length > 0) {
      // Show disambiguation UI with 5s countdown
      setHitlSelectedIndex(0);
      setHitlCountdown(5);
    } else {
      // Clear HITL state when not in disambiguation
      setHitlCountdown(null);
    }
  }, [status, candidates]);

  // Bring the picker into view and give it the keyboard when it appears
  useEffect(() => {
    if (status === 'disambiguation' && candidates && candidates.length > 0 && hitlRef.current) {
      hitlRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      hitlRef.current.focus({ preventScroll: true });
    }
  }, [status, candidates]);

  // "Search again" in the picker: the countdown stops, the run is dropped and the search box
  // gets the keyboard once it is back.
  const focusSearchOnIdle = useRef(false);
  const handleSearchAgain = useCallback(() => {
    setHitlCountdown(null);
    focusSearchOnIdle.current = true;
    onSearchAgain?.();
  }, [onSearchAgain]);
  useEffect(() => {
    if (status === 'idle' && focusSearchOnIdle.current) {
      focusSearchOnIdle.current = false;
      inputRef.current?.focus();
    }
  }, [status]);

  // HITL candidate selection handler: a click or Enter on a row, or the countdown at zero.
  const handleHitlSelect = useCallback(
    (index: number, pickedBy: PickedBy) => {
      const candidate = candidates?.[index];
      if (!candidate) return;
      // Update preview (P1:10)
      setPreviewTrack({
        title: candidate.title,
        artist: candidate.artist,
        coverUrl: candidate.coverUrl,
      });
      setHitlSelectedIndex(index);
      setHitlCountdown(null);
      selectCandidate(candidate.id, pickedBy);
    },
    [candidates, selectCandidate],
  );

  // HITL countdown timer (respects pause state). The selection at zero happens here, in
  // the effect, never inside a state updater.
  useEffect(() => {
    if (hitlCountdown === null || hitlPaused) return;
    if (hitlCountdown <= 0) {
      handleHitlSelect(hitlSelectedIndex, 'countdown');
      return;
    }
    const timer = setTimeout(
      () => setHitlCountdown((prev) => (prev === null ? null : prev - 1)),
      1000,
    );
    return () => clearTimeout(timer);
  }, [hitlCountdown, hitlPaused, hitlSelectedIndex, handleHitlSelect]);

  // Arrow keys, Home and End move the highlight (and focus) and stop the countdown; Enter
  // selects the highlighted row, wherever focus is inside the picker.
  const handleHitlKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!candidates || candidates.length === 0) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        handleHitlSelect(hitlSelectedIndex, 'click');
        return;
      }
      const next = pickerTarget(e.key, hitlSelectedIndex, candidates.length);
      if (next !== null) {
        e.preventDefault();
        setHitlSelectedIndex(next);
        setHitlCountdown(null); // Pause countdown on interaction
        hitlRowRefs.current[next]?.focus();
      }
    },
    [candidates, hitlSelectedIndex, handleHitlSelect],
  );

  // A recorded track offered while live analysis is unavailable: its title and artist name its
  // recording, which the API replays (labelled as a recording).
  const handleAnalyzeRecorded = useCallback(
    (track: ReplayTrack) => {
      const query = `${track.title} ${track.artist}`;
      setSearchQuery(query);
      setPreviewTrack({ title: track.title, artist: track.artist, coverUrl: '' });
      analyze(query);
    },
    [analyze],
  );

  // ─── P0:2 Error retry handlers ────────────────────────────────────────────
  const handleReset = useCallback(() => {
    setSearchQuery('');
    setPreviewTrack(null);
    inputRef.current?.focus();
  }, []);

  // The bar's place: it never moves back within a run (console/progress.ts).
  const shownProgress = useRef(0);
  shownProgress.current = nextProgress(shownProgress.current, status);
  const progress = shownProgress.current;

  // Display track for analysis view (P1:10 — previewTrack || trackData)
  const displayTrack =
    previewTrack ||
    (trackData
      ? { title: trackData.title, artist: trackData.artist, coverUrl: trackData.coverUrl }
      : null);

  return (
    <div
      className={`h-[100dvh] w-full flex flex-col items-center bg-void text-white relative overflow-y-auto overflow-x-hidden ${!isAnalyzing && status !== 'complete' ? 'justify-center' : 'justify-start pt-[min(8vh,4rem)]'}`}
    >
      {/* Background ambience: decorative, barely above the page (about 1.04:1 at its centre) */}
      <div
        aria-hidden="true"
        data-testid="background-ambience"
        className="absolute inset-0 bg-radial-[circle_at_center] from-void-lighter via-void to-void opacity-40"
      ></div>

      {!isAnalyzing && status !== 'complete' ? (
        <div className="z-10 text-center space-y-12 animate-fade-in-up max-w-md mx-auto px-4">
          <div className="relative inline-block">
            <div className="absolute -inset-4 bg-cyber blur-3xl opacity-20 animate-pulse"></div>
            <Network size={64} className="text-cyber relative z-10 mx-auto" />
          </div>

          <h1 className="text-4xl md:text-5xl font-sans font-light tracking-wide leading-tight text-shadow-glow-cyber">
            Liner Notes
          </h1>
          <p className="text-text-secondary font-sans text-base max-w-md mx-auto leading-relaxed">
            Type a song and its artist. Liner Notes traces the song's samples, credits, history and
            sound, and shows which claims are measured, sourced or inferred.
          </p>

          <SearchBox
            value={searchQuery}
            onValueChange={setSearchQuery}
            onSearch={handleSearch}
            onPick={handlePickSuggestion}
            fetchSuggestions={searchSuggest}
            isBusy={isAnalyzing}
            inputRef={setSearchInput}
          />

          {/* Live analysis paused (budget) or off (recordings only): say so and offer the
              recorded tracks; never a result in place of the analysis */}
          {status === 'error' && isLiveUnavailable(errorCode) && (
            <div className="space-y-3">
              <BannerBoundary key={errorCode} code={errorCode}>
                <Suspense
                  fallback={
                    <p role="status" className="text-text-tertiary text-xs font-mono">
                      {LIVE_UNAVAILABLE_COPY[errorCode].title}. Loading the recorded tracks...
                    </p>
                  }
                >
                  <BudgetBanner code={errorCode} onPick={handleAnalyzeRecorded} />
                </Suspense>
              </BannerBoundary>
              <button
                type="button"
                onClick={handleReset}
                className="text-xs font-mono text-text-tertiary hover:text-text-secondary underline underline-offset-4 transition-colors rounded-sm focus-visible:text-text-secondary focus-visible:ring-1 focus-visible:ring-status-warning/70 focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-none"
              >
                or try a different song
              </button>
            </div>
          )}

          {/* Error state: what happened and what to do next, in plain words */}
          {shownError && (
            <div className="bg-status-error/5 border border-status-error/20 rounded-md p-6 space-y-4">
              <h2
                ref={errorHeadingRef}
                tabIndex={-1}
                aria-describedby={shownError.lines
                  .map((_, index) => `error-line-${index}`)
                  .join(' ')}
                className="text-status-error text-sm font-mono text-balance flex items-center justify-center gap-2 focus:outline-none"
              >
                <CircleAlert size={16} aria-hidden="true" className="shrink-0" />
                {ERROR_TITLE}
              </h2>
              {shownError.lines.map((line, index) => (
                <p
                  // The lines are fixed for one error: their place is their identity.
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above
                  key={index}
                  id={`error-line-${index}`}
                  className={`text-xs font-mono text-center ${index === 0 ? 'text-text-secondary' : 'text-text-tertiary'}`}
                >
                  {line}
                </p>
              ))}
              <div className="flex flex-col items-center gap-3">
                <Button
                  variant="cyber"
                  size="md"
                  leftIcon={
                    shownError.action === 'search' ? <Search size={14} /> : <RotateCcw size={14} />
                  }
                  onClick={
                    shownError.action === 'retry'
                      ? retry
                      : shownError.action === 'search'
                        ? handleSearchAgain
                        : () => window.location.reload()
                  }
                >
                  {ERROR_ACTION_LABEL[shownError.action]}
                </Button>
                {/* "Search again" already leads to a different song: no second link beside it */}
                {shownError.action !== 'search' && (
                  <button
                    type="button"
                    onClick={handleReset}
                    className="text-xs font-mono text-text-tertiary hover:text-text-secondary underline underline-offset-4 transition-colors rounded-sm focus-visible:text-text-secondary focus-visible:ring-1 focus-visible:ring-status-error/70 focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-none"
                  >
                    or try a different song
                  </button>
                )}
              </div>
            </div>
          )}

          {/* UX: Session restore link (Item 8) */}
          {status === 'idle' && onRestorePrevious && (
            <button
              type="button"
              onClick={onRestorePrevious}
              className="text-text-tertiary hover:text-cyber text-xs font-mono animate-fade-in transition-colors focus-visible:outline-none focus-visible:underline flex items-center gap-1.5"
            >
              <ArrowLeft size={12} />
              Back to the last result
            </button>
          )}
        </div>
      ) : (
        <div className="z-10 w-full max-w-2xl p-6">
          {/* Central Node Graphic (P1:11 — completion reveal animation) */}
          <div
            className={`flex justify-center ${status === 'disambiguation' ? 'mb-4' : 'mb-8'} transition-all duration-300`}
          >
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
          {displayTrack && (
            <div className="flex flex-col items-center justify-center gap-4 mb-6 animate-fade-in">
              {/* No cover, or one that fails to load: nothing, as for a track without one */}
              <CoverThumb
                url={displayTrack.coverUrl}
                className="w-20 h-20 rounded-md shadow-lg border border-border"
                fallback={null}
              />
              <div className="text-center">
                <div className="text-white font-bold">{displayTrack.title}</div>
                <div className="text-text-tertiary text-sm">{displayTrack.artist}</div>
              </div>
            </div>
          )}

          {/* P1:14 HITL Disambiguation UI (Item 6 — pause-on-hover, keyboard hint, timer bar) */}
          {showPicker && candidates && (
            <div
              ref={hitlRef}
              className="mb-6 animate-fade-in-up rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-4 focus-visible:ring-offset-void"
              onKeyDown={handleHitlKeyDown}
              tabIndex={0}
              onMouseEnter={() => setHitlPaused(true)}
              onMouseLeave={() => setHitlPaused(false)}
            >
              <div className="text-center mb-3">
                <p className="text-sm font-mono text-text-secondary">Is this the right track?</p>
                {/* Keyboard hint above candidates */}
                <p className="text-chrome font-mono text-text-muted mt-1">
                  ↑↓ navigate &nbsp; Enter select &nbsp; hover pauses timer
                </p>
              </div>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {candidates.map((candidate, index) => (
                  <button
                    type="button"
                    key={candidate.id}
                    ref={(el) => {
                      hitlRowRefs.current[index] = el;
                    }}
                    aria-current={index === hitlSelectedIndex ? 'true' : undefined}
                    onClick={() => handleHitlSelect(index, 'click')}
                    onFocus={(e) => {
                      // Keyboard focus (Tab) moves the highlight there and stops the
                      // countdown, as the arrow keys do. A mouse press is left alone: the
                      // click selects the row, and a layout change between press and
                      // release would swallow that click.
                      if (!e.currentTarget.matches(':focus-visible')) return;
                      setHitlSelectedIndex(index);
                      setHitlCountdown(null);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-sm text-left transition-all focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-none ${
                      index === hitlSelectedIndex
                        ? 'bg-white/10 border border-white/30'
                        : 'bg-white/5 border border-transparent hover:bg-white/10'
                    }`}
                  >
                    <CoverThumb
                      url={candidate.coverUrl}
                      className="w-8 h-8 rounded"
                      iconSize={12}
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-white text-sm font-mono truncate block">
                        {candidate.title}
                      </span>
                      <span className="text-text-tertiary text-xs truncate block">
                        {candidate.artist} • {candidate.releaseYear || candidate.album}
                      </span>
                    </div>
                    {index === hitlSelectedIndex && (
                      <span className="text-text-secondary text-xs font-mono flex-shrink-0">▶</span>
                    )}
                  </button>
                ))}
              </div>
              {/* Visual timer bar */}
              {hitlCountdown !== null && (
                <div className="mt-2">
                  <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-text-secondary rounded-full transition-all duration-1000 ease-linear"
                      style={{ width: `${(hitlCountdown / 5) * 100}%` }}
                    />
                  </div>
                  <p className="text-xs font-mono text-text-tertiary mt-1 text-center">
                    {hitlPaused ? (
                      <span className="text-text-muted">(paused)</span>
                    ) : (
                      `Take your time. We'll pick the top match if you don't.`
                    )}
                  </p>
                </div>
              )}
              {onSearchAgain && (
                <div className="mt-2 flex justify-center">
                  <button
                    type="button"
                    onClick={handleSearchAgain}
                    // Its own Enter, not the picker's (which picks the highlighted row)
                    onKeyDown={(e) => e.stopPropagation()}
                    className="px-2 py-1 text-xs font-mono text-text-secondary hover:text-text-primary underline underline-offset-4 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                  >
                    Search again
                  </button>
                </div>
              )}
            </div>
          )}

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

          {/* P1:9 ARIA live region (debounced) */}
          <div aria-live="polite" className="sr-only">
            {announcedStatus}
          </div>

          {/* Status Text (P0:1 — human-readable messages) */}
          <div
            className={`text-center mt-4 text-sm font-mono ${status === 'complete' ? 'text-status-success animate-fade-in' : 'text-text-tertiary'}`}
          >
            {status === 'complete' ? (
              <span className="inline-block overflow-hidden whitespace-nowrap border-r-2 border-status-success animate-[typing-reveal_1s_steps(40)_forwards] max-w-0">
                {statusMessage(status, isReplay, statusNote)}
              </span>
            ) : (
              statusMessage(status, isReplay, statusNote)
            )}
          </div>

          {/* UX: Completion skip button (Item 9) */}
          {status === 'complete' && showCompletionButton && (
            <div className="flex justify-center mt-4 animate-fade-in-up">
              <Button
                variant="neutral"
                size="md"
                rightIcon={<ArrowRight size={16} />}
                onClick={handleCompletionSkip}
              >
                Open the results
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Onboarding;
