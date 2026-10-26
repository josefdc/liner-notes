import type React from 'react';
import {
  Component,
  lazy,
  Suspense,
  useEffect,
  useState,
  useReducer,
  useRef,
  useCallback,
} from 'react';
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
import { inputVisualStyles } from './ui/Input';
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
  disambiguation: 'Pick the track to analyse...',
  complete: 'Analysis complete. Opening the results',
  error: 'The analysis failed. Check your search and try again.',
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
      </section>
    );
  }
}

// Debounce hook for search suggestions
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => clearTimeout(handler);
  }, [value, delay]);

  return debouncedValue;
}

// Suggestion state reducer
interface SuggestionState {
  suggestions: SearchCandidate[];
  showSuggestions: boolean;
  selectedIndex: number;
  isLoading: boolean;
  /** The last request for suggestions failed. */
  error: boolean;
}

type SuggestionAction =
  | { type: 'FETCH_START' }
  | { type: 'FETCH_SUCCESS'; results: SearchCandidate[] }
  | { type: 'FETCH_ERROR' }
  | { type: 'CLEAR' }
  | { type: 'SET_SELECTED'; index: number }
  | { type: 'SET_SHOW'; show: boolean };

const initialSuggestionState: SuggestionState = {
  suggestions: [],
  showSuggestions: false,
  selectedIndex: -1,
  isLoading: false,
  error: false,
};

function suggestionReducer(state: SuggestionState, action: SuggestionAction): SuggestionState {
  switch (action.type) {
    case 'FETCH_START':
      return { ...state, isLoading: true };
    case 'FETCH_SUCCESS':
      return {
        ...state,
        suggestions: action.results,
        showSuggestions: action.results.length > 0,
        selectedIndex: -1,
        isLoading: false,
        error: false,
      };
    case 'FETCH_ERROR':
      return {
        ...state,
        suggestions: [],
        showSuggestions: false,
        selectedIndex: -1,
        isLoading: false,
        error: true,
      };
    case 'CLEAR':
      return {
        ...state,
        suggestions: [],
        showSuggestions: false,
        selectedIndex: -1,
        isLoading: false,
        error: false,
      };
    case 'SET_SELECTED':
      return { ...state, selectedIndex: action.index };
    case 'SET_SHOW':
      return { ...state, showSuggestions: action.show };
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

const NEXT_STEP = 'Try again, or search for a different song.';
const GENERIC_ERROR = `Something went wrong. ${NEXT_STEP}`;
const NO_MATCH = 'No song matched your search. Check the title and artist, then try again.';
const CHOICE_CLOSED = 'That choice is no longer open. Search again.';
const SERVICE_DOWN = 'A music service is not answering right now. Try again in a few minutes.';
const UNREADABLE_SEARCH = 'The search could not be read. Check what you typed, then try again.';
const OFFLINE_ERROR =
  'The connection to the analysis server failed. Check your internet connection, then try again.';

// What happened and what to do next, for each failure code the API (or the app) sends with an
// error.
const ERROR_COPY_BY_CODE: Record<string, string> = {
  no_match: NO_MATCH,
  choice_expired: CHOICE_CLOSED,
  run_interrupted: CHOICE_CLOSED,
  not_waiting: CHOICE_CLOSED,
  invalid_selection: CHOICE_CLOSED,
  upstream_unavailable: SERVICE_DOWN,
  timeout: SERVICE_DOWN,
  rate_limited: 'Too many requests. Wait a minute, then try again.',
  forbidden_origin:
    'The analysis server does not accept requests from this page. Open Liner Notes at its usual address and try again.',
  invalid_input: UNREADABLE_SEARCH,
  invalid_json: UNREADABLE_SEARCH,
  bad_request: UNREADABLE_SEARCH,
  // The app's own codes (useAgent's CLIENT_ERROR_CODES and OUTDATED_ERROR).
  wrong_track: `The recording found is not the track you picked, so it is not shown. ${NEXT_STEP}`,
  no_result: `The analysis ended without a result. ${NEXT_STEP}`,
  stream_stalled:
    'The analysis stopped responding. Check your internet connection, then try again.',
  connection_lost:
    'Lost the connection to the analysis. Check your internet connection, then try again.',
  choice_lost: 'The track you picked could not be found again. Search again.',
  // A newer version was deployed since this page loaded.
  outdated_client:
    'This page is out of date. Reload the page to get the new version, then search again.',
};

/**
 * The lines the error block shows. A failure code this page knows (the API's or the app's own)
 * gets its own words. Any other code shows the server's message (short and written for people,
 * by the contract) and the next step. An error without a code is a thrown exception's own text
 * ("Failed to fetch"): it is never shown, only read for the kind of failure.
 */
function errorCopy(error: string | null, code: string | null): string[] {
  if (code) {
    const known = ERROR_COPY_BY_CODE[code];
    if (known) return [known];
    return error ? [error, NEXT_STEP] : [GENERIC_ERROR];
  }
  const text = error ?? '';
  if (/connection|network|fetch|offline|responding|timed? ?out/i.test(text)) return [OFFLINE_ERROR];
  if (/not (?:be )?found|no match|no results|\b404\b/i.test(text)) return [NO_MATCH];
  return [GENERIC_ERROR];
}

interface OnboardingProps {
  status: AgentStatus;
  logs: AgentLog[];
  trackData: TrackData | null;
  error: string | null;
  /** The failure code of the error, when the server sent one. */
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
  searchSuggest: (query: string, limit?: number) => Promise<SearchCandidate[]>;
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
  const [searchQuery, setSearchQuery] = useState('');
  // An empty search was submitted: the box says what to type until the query changes.
  const [emptySubmit, setEmptySubmit] = useState(false);
  const [sugState, sugDispatch] = useReducer(suggestionReducer, initialSuggestionState);
  const {
    suggestions,
    showSuggestions,
    selectedIndex,
    isLoading: isLoadingSuggestions,
    error: suggestionsFailed,
  } = sugState;

  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const debouncedQuery = useDebounce(searchQuery, 300);

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

  // Fetch suggestions when debounced query changes
  useEffect(() => {
    // A response for an older query must not replace the current one.
    let current = true;
    const fetchSuggestions = async () => {
      if (debouncedQuery.length < 2) {
        sugDispatch({ type: 'CLEAR' });
        return;
      }

      sugDispatch({ type: 'FETCH_START' });
      try {
        const results = await searchSuggest(debouncedQuery, 5);
        if (current) sugDispatch({ type: 'FETCH_SUCCESS', results });
      } catch {
        if (current) sugDispatch({ type: 'FETCH_ERROR' });
      }
    };

    fetchSuggestions();
    return () => {
      current = false;
    };
  }, [debouncedQuery, searchSuggest]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(event.target as Node)
      ) {
        sugDispatch({ type: 'SET_SHOW', show: false });
      }
    };

    document.addEventListener('mousedown', handleClickOutside, { passive: true });
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Handle selecting a suggestion (single click - fill only)
  const handleSelectSuggestion = useCallback((candidate: SearchCandidate) => {
    setSearchQuery(`${candidate.title} ${candidate.artist}`);
    sugDispatch({ type: 'CLEAR' });
    inputRef.current?.focus();
  }, []);

  // Handle double-click or Enter - fill and analyze (P1:10 — set preview)
  const handleSelectAndAnalyze = useCallback(
    (candidate: SearchCandidate) => {
      const query = `${candidate.title} ${candidate.artist}`;
      setSearchQuery(query);
      sugDispatch({ type: 'CLEAR' });
      setPreviewTrack({
        title: candidate.title,
        artist: candidate.artist,
        coverUrl: candidate.coverUrl,
      });
      // The suggestion's own track is analysed, by its id: not whatever its text finds (a
      // re-recording or a cover with the same title). It is a deliberate click on that track,
      // so the result does not warn that the text matched it loosely (a self-titled song, such
      // as "Black Sabbath" by Black Sabbath, reads as a partial match of its own text).
      analyze(query, { trackId: candidate.id, pickedBy: 'click' });
    },
    [analyze],
  );

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!showSuggestions || suggestions.length === 0) {
        return;
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          sugDispatch({
            type: 'SET_SELECTED',
            index: selectedIndex < suggestions.length - 1 ? selectedIndex + 1 : 0,
          });
          break;
        case 'ArrowUp':
          e.preventDefault();
          sugDispatch({
            type: 'SET_SELECTED',
            index: selectedIndex > 0 ? selectedIndex - 1 : suggestions.length - 1,
          });
          break;
        case 'Enter':
          if (selectedIndex >= 0 && suggestions[selectedIndex]) {
            e.preventDefault();
            handleSelectAndAnalyze(suggestions[selectedIndex]);
          }
          break;
        case 'Escape':
          sugDispatch({ type: 'SET_SHOW', show: false });
          sugDispatch({ type: 'SET_SELECTED', index: -1 });
          break;
        case 'Tab':
          if (selectedIndex >= 0 && suggestions[selectedIndex]) {
            e.preventDefault();
            handleSelectSuggestion(suggestions[selectedIndex]);
          }
          break;
      }
    },
    [showSuggestions, suggestions, selectedIndex, handleSelectAndAnalyze, handleSelectSuggestion],
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

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      setEmptySubmit(false);
      analyze(searchQuery.trim());
    } else {
      setEmptySubmit(true);
      inputRef.current?.focus();
    }
  };
  const showEmptyHint = emptySubmit && !searchQuery.trim();

  // The error block shows plain words; the error's own text goes to the console.
  const showsErrorBlock = status === 'error' && !isLiveUnavailable(errorCode);
  useEffect(() => {
    if (showsErrorBlock)
      console.warn('[Onboarding] The analysis failed:', errorCode ?? '(no code)', error);
  }, [showsErrorBlock, error, errorCode]);

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
            Type a song and its artist. Liner Notes traces its samples, credits, history and sound,
            and shows which claims are measured, sourced or inferred.
          </p>

          {/* Search Form */}
          <form onSubmit={handleSearch} className="space-y-4">
            <div className="relative">
              <div className="relative group">
                <Search
                  className="absolute left-4 top-1/2 -translate-y-1/2 text-text-tertiary group-focus-within:text-cyber transition-colors z-10"
                  size={20}
                />
                {isLoadingSuggestions && (
                  <div className="absolute right-4 top-1/2 -translate-y-1/2 z-10">
                    <div className="w-4 h-4 border-2 border-cyber/30 border-t-cyber rounded-full animate-spin" />
                  </div>
                )}
                <input
                  ref={(el) => {
                    // Merge internal ref and external searchInputRef
                    (inputRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
                    if (typeof searchInputRef === 'function') searchInputRef(el);
                    else if (searchInputRef)
                      (searchInputRef as React.MutableRefObject<HTMLInputElement | null>).current =
                        el;
                  }}
                  type="text"
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setEmptySubmit(false);
                  }}
                  onKeyDown={handleKeyDown}
                  onFocus={() =>
                    suggestions.length > 0 && sugDispatch({ type: 'SET_SHOW', show: true })
                  }
                  placeholder="Song title and artist"
                  maxLength={200}
                  className={`${inputVisualStyles} pl-12 pr-10`}
                  autoComplete="off"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded={showSuggestions}
                  aria-controls="search-suggestions"
                  aria-invalid={showEmptyHint || undefined}
                  aria-describedby={showEmptyHint ? 'search-empty-hint' : undefined}
                />
              </div>

              {showEmptyHint && (
                <p
                  id="search-empty-hint"
                  role="alert"
                  className="mt-2 text-xs font-mono text-text-secondary text-left"
                >
                  Type a song title and its artist first, for example: Midnight City M83.
                </p>
              )}

              {suggestionsFailed && (
                <p role="status" className="mt-2 text-xs font-mono text-text-tertiary text-left">
                  Suggestions are unavailable right now. You can still search.
                </p>
              )}

              {/* Suggestions Dropdown */}
              {showSuggestions && suggestions.length > 0 && (
                <div
                  ref={dropdownRef}
                  id="search-suggestions"
                  role="listbox"
                  className="absolute z-50 w-full mt-2 bg-surface-overlay backdrop-blur-lg border border-border rounded-lg shadow-elevated-lg max-h-[320px] overflow-y-auto animate-scale-in"
                >
                  {suggestions.map((candidate, index) => (
                    <button
                      key={candidate.id}
                      type="button"
                      role="option"
                      aria-selected={index === selectedIndex}
                      onClick={() => handleSelectAndAnalyze(candidate)}
                      className={`w-full flex items-center gap-3 p-3 text-left transition-all animate-fade-in-up opacity-0 focus-visible:ring-2 focus-visible:ring-cyber/70 focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-none ${
                        index === selectedIndex
                          ? 'bg-cyber/20 border-l-2 border-cyber'
                          : 'hover:bg-white/5 border-l-2 border-transparent'
                      }`}
                      style={{ animationDelay: `${index * 50}ms`, animationFillMode: 'forwards' }}
                    >
                      <CoverThumb url={candidate.coverUrl} className="w-10 h-10 rounded" />
                      <div className="flex-1 min-w-0">
                        <div className="text-white font-mono text-sm truncate">
                          {candidate.title}
                        </div>
                        <div className="text-text-tertiary text-xs truncate">
                          {candidate.artist} • {candidate.album}
                        </div>
                      </div>
                    </button>
                  ))}
                  <div className="px-3 py-2 text-xs text-text-tertiary border-t border-white/5 font-mono">
                    Arrow keys to move, Enter to analyze, Esc to close
                  </div>
                </div>
              )}
            </div>

            <Button
              type="submit"
              variant="cyber"
              size="lg"
              isLoading={isAnalyzing}
              className="w-full"
            >
              Analyze
            </Button>
          </form>

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
          {showsErrorBlock && (
            <div className="bg-status-error/5 border border-status-error/20 rounded-md p-6 space-y-4">
              <h2 className="text-status-error text-sm font-mono flex items-center justify-center gap-2">
                <CircleAlert size={16} aria-hidden="true" />
                {ERROR_TITLE}
              </h2>
              {errorCopy(error, errorCode).map((line, index) => (
                <p
                  key={line}
                  className={`text-xs font-mono text-center ${index === 0 ? 'text-text-secondary' : 'text-text-tertiary'}`}
                >
                  {line}
                </p>
              ))}
              <div className="flex flex-col items-center gap-3">
                <Button
                  variant="cyber"
                  size="md"
                  leftIcon={<RotateCcw size={14} />}
                  onClick={retry}
                >
                  Try again
                </Button>
                <button
                  type="button"
                  onClick={handleReset}
                  className="text-xs font-mono text-text-tertiary hover:text-text-secondary underline underline-offset-4 transition-colors rounded-sm focus-visible:text-text-secondary focus-visible:ring-1 focus-visible:ring-status-error/70 focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-none"
                >
                  or try a different song
                </button>
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
