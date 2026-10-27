import type React from 'react';
import {
  Component,
  createRef,
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useState,
  useRef,
  useCallback,
} from 'react';
import type { TrackData, AgentLog } from '../types';
import { Network, Search, CircleAlert, RotateCcw, ArrowLeft } from 'lucide-react';
import type { AgentStatus, AnalyzeOptions, PickedBy, SearchCandidate } from '../hooks/agent/types';
import {
  isLiveUnavailable,
  LIVE_UNAVAILABLE_COPY,
  type LiveUnavailableCode,
} from '../liveUnavailable';
import type { ReplayTrack } from '../hooks/agent/apiClient';
import { Button } from './ui/Button';
import { SearchBox } from './search/SearchBox';
import type { SuggestionFetcher } from './search/useSuggestions';
import { TrackPicker } from './search/TrackPicker';
import { ANALYZING_STATUSES } from './console/progress';
import { ProgressScreen, type ShownTrack } from './ProgressScreen';
import { spokenWait, useTimeLeft, waitText } from '../hooks/useTimeLeft';

// Loaded only when live analysis turns out to be unavailable.
const BudgetBanner = lazy(() => import('./BudgetBanner'));

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
  // The explanation's heading takes the focus, as the banner's does: the view that had it is
  // gone.
  private headingRef = createRef<HTMLHeadingElement>();

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidMount() {
    if (this.state.failed) this.headingRef.current?.focus();
  }

  componentDidUpdate(_props: unknown, previous: { failed: boolean }) {
    if (this.state.failed && !previous.failed) this.headingRef.current?.focus();
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
          <h2
            ref={this.headingRef}
            tabIndex={-1}
            className="text-status-warning text-sm font-mono uppercase tracking-widest text-center outline-none"
          >
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

/**
 * Stands in for the paused-analysis banner while its code loads, and holds the focus meanwhile:
 * the view that had it (the picker, the progress screen) is gone, and the banner's heading takes
 * it once the banner is in.
 */
function BannerLoading({ code }: { code: LiveUnavailableCode }) {
  const lineRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    lineRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <p
      ref={lineRef}
      tabIndex={-1}
      role="status"
      className="text-text-tertiary text-xs font-mono outline-none"
    >
      {LIVE_UNAVAILABLE_COPY[code].title}. Loading the recorded tracks...
    </p>
  );
}

/** The code of a Turnstile check whose script could not be loaded (agent/turnstile.ts). */
const VERIFICATION_UNAVAILABLE = 'verification_unavailable';

/** The steps a run reaches only once it has passed the Turnstile check. */
const PAST_THE_CHECK = new Set<AgentStatus>([
  'searching',
  'analyzing',
  'measuring',
  'researching',
  'composing',
  'checking',
  'disambiguation',
  'complete',
]);

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
  // The Turnstile check that comes before every analysis gave no token (agent/turnstile.ts).
  verification_unavailable: view(
    'The check that protects the analysis could not be loaded. A content blocker or the network may be stopping it. Try again in a moment.',
    'retry',
  ),
  verification_failed: view(
    'The check that protects the analysis did not pass. Try again to run it again.',
    'retry',
  ),
  verification_timeout: view(
    'The check that protects the analysis did not finish in time. Try again to run it again.',
    'retry',
  ),
  stream_refused: view(
    'The analysis server did not accept the request. Try again to send it with a new check.',
    'retry',
  ),
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
  /**
   * When the refusal said how long to wait (useAgent's `retryAt`): "Try again" stays disabled
   * until then and says how long is left.
   */
  retryAt?: number | null;
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
  retryAt = null,
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
  const [previewTrack, setPreviewTrack] = useState<ShownTrack | null>(null);

  // The progress screen's status line takes the focus when a run starts or moves on from the
  // user's hand (a search, a pick, a retry): the box, row or button that had it is gone, and the
  // focus would fall to the page. The picker and the error block take it themselves. A run
  // started from another screen (a connected track, a link's Analyze) is under way when this
  // screen mounts: the status line takes the focus then too.
  const statusRef = useRef<HTMLDivElement>(null);
  const focusStatusNext = useRef(isLoading || ANALYZING_STATUSES.has(status));

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
      focusStatusNext.current = true;
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
      focusStatusNext.current = true;
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
  // description) and focus never falls to the page: in the commit that shows it (a layout
  // effect), not after a paint with the focused view gone.
  const errorHeadingRef = useRef<HTMLHeadingElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per failure (failureId)
  useLayoutEffect(() => {
    if (showsErrorBlock) errorHeadingRef.current?.focus();
  }, [showsErrorBlock, failureId]);
  const shownError = showsErrorBlock ? errorView(error, errorCode) : null;
  // "Try again" waits for the time the refusal named: a request before then is refused again.
  const retryWait = useTimeLeft(shownError?.action === 'retry' ? retryAt : null);
  // The wait is over: said once, through a polite live region (the time left is not announced
  // as it counts down; the heading's description says it when the block takes the focus).
  const retryReady = shownError?.action === 'retry' && retryAt !== null && retryWait === 0;

  // Failures in a row in which the Turnstile check could not be loaded, counted once per failure
  // (failureId) during render, so the block shows its buttons in the commit that shows it. A run
  // that got past the check (any step after connecting) starts the count again.
  const [unavailable, setUnavailable] = useState<{ last: string | null; count: number }>({
    last: null,
    count: 0,
  });
  if (failureId !== null && failureId !== unavailable.last) {
    setUnavailable({
      last: failureId,
      count: errorCode === VERIFICATION_UNAVAILABLE ? unavailable.count + 1 : 0,
    });
  } else if (unavailable.count > 0 && PAST_THE_CHECK.has(status)) {
    setUnavailable({ last: unavailable.last, count: 0 });
  }
  // The check failed to load twice in a row: reloading the page loads it afresh.
  const offerReload =
    shownError?.action === 'retry' &&
    errorCode === VERIFICATION_UNAVAILABLE &&
    unavailable.count >= 2;

  const isAnalyzing = isLoading || ANALYZING_STATUSES.has(status);

  // ─── P1:14 Track picker ───────────────────────────────────────────────────
  // Any candidate list is shown to the user, and nothing is chosen without them: the run waits
  // for a pick for as long as the picker is open.
  const showPicker = status === 'disambiguation' && !!candidates && candidates.length > 0;

  // See statusRef: once the progress screen shows a step, unless the picker or the error block
  // has taken the focus.
  useEffect(() => {
    if (!focusStatusNext.current) return;
    if (status === 'idle' || status === 'error' || showPicker) {
      focusStatusNext.current = false;
      return;
    }
    if (statusRef.current) {
      focusStatusNext.current = false;
      // Scrolled no further than it takes to show the line: on a short window the track and the
      // top of the log stay in view as far as they can.
      statusRef.current.focus({ preventScroll: true });
      statusRef.current.scrollIntoView?.({ block: 'nearest' });
    }
  }, [status, showPicker]);

  // "Search again" in the picker, Escape, or Stop on the progress screen: the run is dropped
  // (its stream closed, so the server stops it) and the search box gets the keyboard once it is
  // back.
  const focusSearchOnIdle = useRef(false);
  const handleSearchAgain = useCallback(() => {
    focusSearchOnIdle.current = true;
    onSearchAgain?.();
  }, [onSearchAgain]);
  useEffect(() => {
    if (status === 'idle' && focusSearchOnIdle.current) {
      focusSearchOnIdle.current = false;
      inputRef.current?.focus();
    }
  }, [status]);

  // A row of the picker chosen with Enter or a click: always the user's own pick.
  const handlePick = useCallback(
    (candidate: SearchCandidate) => {
      // Update preview (P1:10)
      setPreviewTrack({
        title: candidate.title,
        artist: candidate.artist,
        coverUrl: candidate.coverUrl,
      });
      focusStatusNext.current = true;
      selectCandidate(candidate.id, 'click');
    },
    [selectCandidate],
  );

  // A retry is a new attempt: the track an earlier pick showed may not be this one's.
  const handleRetry = useCallback(() => {
    setPreviewTrack(null);
    focusStatusNext.current = true;
    retry();
  }, [retry]);

  // An open picker means no track is chosen yet: the card shows none until one is picked.
  useEffect(() => {
    if (showPicker) setPreviewTrack(null);
  }, [showPicker]);

  // A recorded track offered while live analysis is unavailable: its title and artist name its
  // recording, which the API replays (labelled as a recording).
  const handleAnalyzeRecorded = useCallback(
    (track: ReplayTrack) => {
      const query = `${track.title} ${track.artist}`;
      setSearchQuery(query);
      setPreviewTrack({ title: track.title, artist: track.artist, coverUrl: '' });
      focusStatusNext.current = true;
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

  // Display track for analysis view (P1:10 — previewTrack || trackData)
  const displayTrack =
    previewTrack ||
    (trackData
      ? { title: trackData.title, artist: trackData.artist, coverUrl: trackData.coverUrl }
      : null);

  return (
    <div
      className={`h-full w-full flex flex-col items-center bg-void text-white relative overflow-y-auto overflow-x-hidden ${!isAnalyzing && status !== 'complete' ? '' : 'pt-[min(8vh,4rem)]'}`}
    >
      {/* Background ambience: decorative, barely above the page (about 1.04:1 at its centre) */}
      <div
        aria-hidden="true"
        data-testid="background-ambience"
        className="absolute inset-0 bg-radial-[circle_at_center] from-void-lighter via-void to-void opacity-40"
      ></div>

      {!isAnalyzing && status !== 'complete' ? (
        // Centred while it fits (the auto margins), and from the top when it does not: centring
        // with justify-content would push the top out of reach of the scroll on a short window.
        // On a phone it starts near the top, leaving the room below to the suggestions (and the
        // on-screen keyboard).
        <div className="z-10 text-center space-y-12 animate-fade-in-up max-w-md mx-auto mt-(--space-lg) mb-auto sm:my-auto py-(--space-lg) px-4">
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
                <Suspense fallback={<BannerLoading code={errorCode} />}>
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
                aria-describedby={[
                  ...shownError.lines.map((_, index) => `error-line-${index}`),
                  ...(retryWait > 0 ? ['error-wait'] : []),
                ].join(' ')}
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
              {/* Not a live region: read with the heading's description, never as it counts down.
                  Screen readers get the units in words ("42 seconds"). */}
              {retryWait > 0 && (
                <p id="error-wait" className="text-xs font-mono text-center text-text-tertiary">
                  <span aria-hidden="true">{`You can try again in ${waitText(retryWait)}.`}</span>
                  <span className="sr-only">{`You can try again in ${spokenWait(retryWait)}.`}</span>
                </p>
              )}
              <div id="error-retry-ready" role="status" className="sr-only">
                {retryReady ? 'You can try again now.' : ''}
              </div>
              <div className="flex flex-col items-center gap-3">
                <div className="flex flex-wrap justify-center gap-3">
                  <Button
                    variant="cyber"
                    size="md"
                    leftIcon={
                      shownError.action === 'search' ? (
                        <Search size={14} />
                      ) : (
                        <RotateCcw size={14} />
                      )
                    }
                    disabled={retryWait > 0}
                    onClick={
                      shownError.action === 'retry'
                        ? handleRetry
                        : shownError.action === 'search'
                          ? handleSearchAgain
                          : () => window.location.reload()
                    }
                  >
                    {ERROR_ACTION_LABEL[shownError.action]}
                  </Button>
                  {offerReload && (
                    <Button
                      variant="neutral"
                      size="md"
                      leftIcon={<RotateCcw size={14} />}
                      onClick={() => window.location.reload()}
                    >
                      {ERROR_ACTION_LABEL.reload}
                    </Button>
                  )}
                </div>
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
        <ProgressScreen
          status={status}
          logs={logs}
          isReplay={isReplay}
          statusNote={statusNote}
          track={displayTrack}
          picker={
            showPicker &&
            candidates && (
              <TrackPicker
                candidates={candidates}
                onPick={handlePick}
                onSearchAgain={onSearchAgain ? handleSearchAgain : undefined}
              />
            )
          }
          showCompletionButton={showCompletionButton}
          onOpenResults={handleCompletionSkip}
          statusRef={statusRef}
          onStop={onSearchAgain ? handleSearchAgain : undefined}
        />
      )}
    </div>
  );
};

export default Onboarding;
