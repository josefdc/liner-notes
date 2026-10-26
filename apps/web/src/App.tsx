import type React from 'react';
import { useState, useCallback, useEffect, useLayoutEffect, useRef, Suspense, lazy } from 'react';
import Layout from './components/Layout';
import Onboarding from './components/Onboarding';
import { TrackLinkScreen, type TrackLinkState } from './components/TrackLinkScreen';
const Dashboard = lazy(() => import('./components/Dashboard'));
const Player = lazy(() => import('./components/Player'));
import { AppPhase, type TrackData } from './types';
import { useAgent } from './hooks/useAgent';
import { fetchStoredRun } from './hooks/agent/storedRun';
import { preloadsResults } from './components/console/progress';
import { isSpotifyTrackId } from './utils/spotify';
import type { AnalyzeOptions } from './hooks/agent/types';
import {
  currentRoute,
  onHistoryMove,
  type Route,
  routeUrl,
  writeHistoryEntry,
} from './router/route';

// ─── P2:18 Dashboard skeleton fallback ──────────────────────────────────────
const shimmerClass =
  'bg-gradient-to-r from-white/[0.03] via-white/[0.07] to-white/[0.03] bg-[length:200%_100%] animate-progress-shimmer';

// The skeletons stand in for a result view while its code loads. Each holds the focus meanwhile
// (`data-loading-view`), so the focus never falls to the page, until the view's heading takes it.
const LOADING_VIEW_PROPS = {
  'data-loading-view': true,
  tabIndex: -1,
  role: 'status',
  'aria-label': 'Loading the results',
} as const;

// Same padding and gaps as the Dashboard (components/Dashboard.tsx), so nothing shifts when it loads.
const DashboardSkeleton = (
  <div
    {...LOADING_VIEW_PROPS}
    className="h-full w-full p-(--space-md) md:p-(--space-2xl) flex flex-col gap-(--space-xl) md:gap-(--space-2xl) overflow-hidden bg-void animate-fade-in focus:outline-none"
  >
    {/* Header skeleton */}
    <div className="flex justify-between items-center">
      <div className="space-y-2">
        <div className={`h-7 w-48 ${shimmerClass} rounded-sm`} />
        <div className={`h-3 w-64 ${shimmerClass} rounded-sm`} />
      </div>
    </div>
    {/* Hero card skeleton */}
    <div className={`h-48 ${shimmerClass} border border-white/10 rounded-lg`} />
    {/* Grid skeleton */}
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0">
      <div
        className={`lg:col-span-1 ${shimmerClass} border border-white/10 rounded-lg min-h-[300px]`}
      />
      <div className="lg:col-span-2 flex flex-col gap-6">
        <div className={`h-5 w-40 ${shimmerClass} rounded-sm`} />
        <div className="flex gap-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className={`min-w-[280px] h-80 ${shimmerClass} border border-white/10 rounded-lg`}
            />
          ))}
        </div>
      </div>
    </div>
  </div>
);

const PlayerSkeleton = (
  <div
    {...LOADING_VIEW_PROPS}
    className="h-full w-full flex flex-col bg-void animate-fade-in focus:outline-none"
  >
    <div className="px-6 py-4 border-b border-white/5">
      <div className={`h-4 w-32 ${shimmerClass} rounded-sm`} />
    </div>
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-6">
        <div className={`w-64 h-64 mx-auto ${shimmerClass} rounded-md`} />
        <div className={`h-6 w-48 mx-auto ${shimmerClass} rounded-sm`} />
        <div className={`h-4 w-32 mx-auto ${shimmerClass} rounded-sm`} />
      </div>
    </div>
  </div>
);

/** How long a result view's heading is waited for (its code may still be loading). */
const FOCUS_WAIT_MS = 10_000;

/** The loading view on the page, if any (see LOADING_VIEW_PROPS). */
const loadingView = () => document.querySelector<HTMLElement>('[data-loading-view]');

/** The API's limit on the length of an analysis query (the contract's MAX_QUERY_LENGTH). */
const MAX_QUERY_LENGTH = 200;

/** A link to a track (`/t/<spotifyId>`) whose result is not on screen yet. */
interface TrackLink {
  trackId: string;
  /** The link's own words for the track (`?q=`). */
  query: string | null;
  state: TrackLinkState;
}

const linkTo = (route: Extract<Route, { kind: 'track' }>): TrackLink => ({
  trackId: route.trackId,
  query: route.query,
  // An id that cannot be a Spotify track id is not sent to the API.
  state: isSpotifyTrackId(route.trackId) ? 'loading' : 'invalid',
});

/** What the app stores in each browser history entry. */
interface HistoryEntry {
  phase: AppPhase;
  /** In-app entries behind this one. */
  index: number;
  /** Pushed when a search started; its result replaces it. */
  search?: boolean;
  /** The entry's address. */
  url: string;
}

/**
 * The address of a screen: `/` for the search (and an analysis under way), the link's own
 * address while its result loads, and `/t/<id>?q=<title artist>` for a result.
 */
function addressOf(phase: AppPhase, track: TrackData | null, link: TrackLink | null): string {
  if (link) return routeUrl({ kind: 'track', trackId: link.trackId, query: link.query });
  if (phase === AppPhase.ONBOARDING || !track?.id) return '/';
  const query = `${track.title ?? ''} ${track.artist ?? ''}`.trim() || null;
  return routeUrl({ kind: 'track', trackId: track.id, query });
}

/** The screen the page opens on: the search, or the result its address names. */
function openingScreen(): { phase: AppPhase; link: TrackLink | null } {
  const route = currentRoute();
  if (route?.kind !== 'track') return { phase: AppPhase.ONBOARDING, link: null };
  // A reload of the Player keeps the Player (the entry's state survives a reload).
  const saved = window.history.state as Partial<HistoryEntry> | null;
  return {
    phase: saved?.phase === AppPhase.PLAYER ? AppPhase.PLAYER : AppPhase.DASHBOARD,
    link: linkTo(route),
  };
}

const App: React.FC = () => {
  const [opening] = useState(openingScreen);
  const [phase, setPhase] = useState<AppPhase>(opening.phase);
  // A link to a track whose stored result is loading, missing or failed: shown instead of the
  // phase's view until the result is in.
  const [link, setLink] = useState<TrackLink | null>(opening.link);
  const {
    status,
    logs,
    trackData,
    candidates,
    error,
    errorCode,
    isLoading,
    isComplete,
    isReplay,
    statusNote,
    analyze,
    selectCandidate,
    retry,
    decryptMoreFactoidsStream,
    searchSuggest,
    reset,
  } = useAgent();

  // ─── UX: Focus management refs (Item 1) ─────────────────────────────────
  const dashboardHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const playerHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // A result view whose heading is to take the focus as soon as it is in the page: its code
  // was still loading when it was opened. Waited for up to FOCUS_WAIT_MS.
  const focusWait = useRef<{ screen: AppPhase; until: number } | null>(null);
  const takeWaitingFocus = useCallback((screen: AppPhase, heading: HTMLHeadingElement) => {
    const wait = focusWait.current;
    if (wait?.screen !== screen || performance.now() > wait.until) return;
    focusWait.current = null;
    // Unless the user has moved it elsewhere meanwhile (from the loading view, or from the
    // page where the loading view's removal left it).
    const active = document.activeElement;
    if (active && active !== document.body && active !== loadingView()) return;
    heading.focus();
  }, []);
  const setDashboardHeading = useCallback(
    (heading: HTMLHeadingElement | null) => {
      dashboardHeadingRef.current = heading;
      if (heading) takeWaitingFocus(AppPhase.DASHBOARD, heading);
    },
    [takeWaitingFocus],
  );
  const setPlayerHeading = useCallback(
    (heading: HTMLHeadingElement | null) => {
      playerHeadingRef.current = heading;
      if (heading) takeWaitingFocus(AppPhase.PLAYER, heading);
    },
    [takeWaitingFocus],
  );

  // ─── UX: Previous result, for undo and "Back to the last result" (Items 2, 8) ──
  const [previousTrackData, setPreviousTrackData] = useState<TrackData | null>(null);

  // ─── UX: Session restore / undo override (Items 2, 8) ──────────────────
  // A result that is not the hook's current run (a restored one, or the stored one a link
  // loaded): the hook's trackData is null then. Cleared on the next analysis.
  const [overrideTrackData, setOverrideTrackData] = useState<TrackData | null>(null);
  const [isRestoredSession, setIsRestoredSession] = useState(false);
  const effectiveTrackData = overrideTrackData || trackData;

  // Every result shown on this page, by track id: Back and Forward to a result show it again
  // without a request.
  const shownResults = useRef(new Map<string, TrackData>());
  useEffect(() => {
    if (effectiveTrackData?.id) shownResults.current.set(effectiveTrackData.id, effectiveTrackData);
  }, [effectiveTrackData]);

  // ─── A link's stored result (GET /api/runs/by-track/:id): read only, never an analysis ──
  const loadingTrackId = link?.state === 'loading' ? link.trackId : null;
  useEffect(() => {
    if (!loadingTrackId) return;
    const controller = new AbortController();
    fetchStoredRun(loadingTrackId, controller.signal).then(
      (result) => {
        if (controller.signal.aborted) return;
        if (result.kind === 'found') {
          setOverrideTrackData(result.track);
          // Not a run of this page: it has no activity log to show.
          setIsRestoredSession(true);
          setLink(null);
          return;
        }
        setLink((current) =>
          current?.trackId === loadingTrackId ? { ...current, state: result.kind } : current,
        );
      },
      // Aborted: another screen replaced the link.
      () => {},
    );
    return () => controller.abort();
  }, [loadingTrackId]);

  // ─── UX: Focus management on screen changes (Item 1, UXN-05) ────────────
  // In the same commit as the screen change, so the focus never rests on the page: a result's
  // heading takes it, or, while the result's code loads, the loading view until the heading
  // is in (setDashboardHeading, setPlayerHeading); the search box takes it on the search. A
  // link's screen and the progress screen focus their own heading and status line.
  const screen = link ? 'link' : phase;
  useLayoutEffect(() => {
    focusWait.current = null;
    if (screen === 'link') return;
    if (screen === AppPhase.ONBOARDING) {
      searchInputRef.current?.focus();
      return;
    }
    const heading =
      screen === AppPhase.DASHBOARD ? dashboardHeadingRef.current : playerHeadingRef.current;
    if (heading?.isConnected) {
      heading.focus();
      return;
    }
    focusWait.current = { screen, until: performance.now() + FOCUS_WAIT_MS };
    loadingView()?.focus();
  }, [screen]);

  // Preload lazy chunks when analysis nears completion
  useEffect(() => {
    if (preloadsResults(status)) {
      import('./components/Dashboard');
      import('./components/Player');
    }
  }, [status]);

  // UX: Eager preload Player when entering Dashboard (Item 11)
  useEffect(() => {
    if (phase === AppPhase.DASHBOARD) {
      import('./components/Player');
    }
  }, [phase]);

  // ─── P2:19 Preload images during analysis ─────────────────────────────────
  // Keyed by the image addresses: a new result object with the same images loads nothing again.
  const coverUrl = effectiveTrackData?.coverUrl ?? '';
  const nodes = effectiveTrackData?.genealogy?.nodes;
  const nodeImages = Array.isArray(nodes)
    ? nodes
        .map((node) => node?.img)
        .filter(Boolean)
        .join('\n')
    : '';
  useEffect(() => {
    if (coverUrl) new Image().src = coverUrl;
  }, [coverUrl]);
  useEffect(() => {
    for (const src of nodeImages.split('\n')) {
      if (src) new Image().src = src;
    }
  }, [nodeImages]);

  // Handle song analysis completion
  const handleAnalysisComplete = useCallback(() => {
    setOverrideTrackData(null); // New analysis data comes from hook
    setIsRestoredSession(false);
    setPhase(AppPhase.DASHBOARD);
  }, []);

  // Handle navigation with track data
  const handleNavigate = useCallback((newPhase: AppPhase) => {
    setPhase(newPhase);
  }, []);

  // A connected track analysed from the Dashboard or the Player. The run starts at once, so the
  // progress screen is up from its first frame and its status line takes the focus.
  const handleAnalyzeTrack = useCallback(
    (trackId: string, title: string, artist: string) => {
      // Save current trackData for undo (Item 2)
      setPreviousTrackData(effectiveTrackData);
      setOverrideTrackData(null);
      setIsRestoredSession(false);
      reset();
      analyze(`${title} ${artist}`.trim(), isSpotifyTrackId(trackId) ? { trackId } : {});
      setPhase(AppPhase.ONBOARDING);
    },
    [reset, analyze, effectiveTrackData],
  );

  const handleBackToDashboard = useCallback(() => {
    setPhase(AppPhase.DASHBOARD);
  }, []);

  // UX: Undo analysis — abort SSE, restore previous state (Item 2)
  const handleUndoAnalysis = useCallback(() => {
    reset();
    if (previousTrackData) {
      setOverrideTrackData(previousTrackData);
      setIsRestoredSession(true);
      setPhase(AppPhase.DASHBOARD);
      setPreviousTrackData(null);
    } else {
      setPhase(AppPhase.ONBOARDING);
    }
  }, [reset, previousTrackData]);

  // UX: Restore previous session (Item 8)
  const handleRestorePrevious = useCallback(() => {
    if (previousTrackData) {
      setOverrideTrackData(previousTrackData);
      setIsRestoredSession(true);
      setPhase(AppPhase.DASHBOARD);
    }
  }, [previousTrackData]);

  // ─── P0:3 New search handler (Item 8 — save session for restore) ─────────
  const handleNewSearch = useCallback(() => {
    // Save current trackData so user can restore previous session
    if (effectiveTrackData) {
      setPreviousTrackData(effectiveTrackData);
    }
    setOverrideTrackData(null);
    setIsRestoredSession(false);
    setLink(null);
    reset();
    setPhase(AppPhase.ONBOARDING);
  }, [reset, effectiveTrackData]);

  // ─── P1:15 Browser history support ────────────────────────────────────────
  // One history entry per screen, at that screen's address; the steps of an analysis add none.
  // Each entry records how many in-app entries lie behind it (`index`). The entry a search
  // pushes (`search`) is taken over by its result.
  const address = addressOf(phase, effectiveTrackData, link);
  const entryRef = useRef<HistoryEntry>({ phase, index: 0, url: address });
  const writeHistory = useCallback((entry: HistoryEntry, mode: 'push' | 'replace') => {
    entryRef.current = entry;
    writeHistoryEntry(entry, entry.url, mode);
  }, []);

  // The page's own entry, at its address (an unknown path becomes the search's `/`).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally runs only on mount
  useEffect(() => {
    writeHistory({ phase, index: 0, url: address }, 'replace');
  }, []);

  useEffect(() => {
    const entry = entryRef.current;
    if (entry.phase === phase) {
      // The same screen at a new address: a link's stored result came in, and the address now
      // carries the track's name.
      if (entry.url !== address) writeHistory({ ...entry, url: address }, 'replace');
      return;
    }
    if (entry.search && phase === AppPhase.DASHBOARD) {
      writeHistory({ phase, index: entry.index, url: address }, 'replace');
    } else {
      writeHistory({ phase, index: entry.index + 1, url: address }, 'push');
    }
  }, [phase, address, writeHistory]);

  // A search started on an entry with nothing of the app behind it (the first search after
  // loading the page, or one after going back to the search) gets an entry of its own, so
  // Back reaches the guard below instead of leaving the app. Called from the click or submit
  // handler: an entry pushed without a user action may be skipped by the browser's Back.
  const markSearchEntry = useCallback(() => {
    const entry = entryRef.current;
    if (entry.search || entry.index > 0) return;
    writeHistory(
      { phase: AppPhase.ONBOARDING, index: entry.index + 1, search: true, url: '/' },
      'push',
    );
  }, [writeHistory]);

  const startSearch = useCallback(
    (query: string, options?: AnalyzeOptions) => {
      markSearchEntry();
      return analyze(query, options);
    },
    [markSearchEntry, analyze],
  );

  const retrySearch = useCallback(() => {
    markSearchEntry();
    retry();
  }, [markSearchEntry, retry]);

  // Analyze, on a link to a track without a stored result: that very track, by its id, under
  // the link's words for it (or its id when the link has none: the API reads the track by its
  // id, and the words only label the run). Nothing but this click starts it. The link's entry
  // becomes the search's, so Back from the result leads to the search, not to this screen.
  const handleAnalyzeLink = useCallback(() => {
    if (!link) return;
    const query = (link.query ?? link.trackId).slice(0, MAX_QUERY_LENGTH);
    writeHistory(
      { phase: AppPhase.ONBOARDING, index: entryRef.current.index, url: '/' },
      'replace',
    );
    setLink(null);
    setOverrideTrackData(null);
    setIsRestoredSession(false);
    setPhase(AppPhase.ONBOARDING);
    startSearch(query, { trackId: link.trackId, pickedBy: 'click' });
  }, [link, writeHistory, startSearch]);

  const handleRetryLink = useCallback(() => {
    setLink((current) => (current ? { ...current, state: 'loading' } : current));
  }, []);

  useEffect(
    () =>
      onHistoryMove((route, state) => {
        const target = state as Partial<HistoryEntry> | null;
        const targetPhase = target?.phase;
        // Not an entry of the app's (the skip link's #main-content): nothing to change.
        if (!target || !targetPhase) return;
        // Guard: don't interrupt a running analysis or an open track picker
        if (phase === AppPhase.ONBOARDING && !link && (isLoading || status === 'disambiguation')) {
          // Re-push the entry the user was on to prevent navigation
          writeHistory(entryRef.current, 'push');
          return;
        }
        entryRef.current = {
          phase: targetPhase,
          index: target.index ?? 0,
          search: target.search,
          url: `${window.location.pathname}${window.location.search}`,
        };
        if (targetPhase === AppPhase.ONBOARDING) {
          // Back from a result starts a new search; the result stays available to restore.
          if (phase !== AppPhase.ONBOARDING || link) handleNewSearch();
          return;
        }
        const wanted = route?.kind === 'track' ? route : null;
        const fits = (track: TrackData | null | undefined): track is TrackData =>
          !!track && (!wanted || track.id === wanted.trackId);
        if (!link && fits(effectiveTrackData)) {
          setPhase(targetPhase);
          return;
        }
        // Forward to a result left with Back, or to another result shown on this page: shown
        // again, with no new analysis and no request.
        const shown = wanted ? shownResults.current.get(wanted.trackId) : previousTrackData;
        if (fits(shown)) {
          setOverrideTrackData(shown);
          setIsRestoredSession(true);
          setLink(null);
          setPhase(targetPhase);
          return;
        }
        if (wanted) {
          // A result this page has not shown: its stored result is read.
          reset();
          setOverrideTrackData(null);
          setIsRestoredSession(false);
          setLink(linkTo(wanted));
          setPhase(targetPhase);
          return;
        }
        // Guard: don't navigate to dashboard/player without track data
        setLink(null);
        setPhase(AppPhase.ONBOARDING);
      }),
    [
      phase,
      link,
      isLoading,
      status,
      effectiveTrackData,
      previousTrackData,
      handleNewSearch,
      reset,
      writeHistory,
    ],
  );

  const renderScreen = () => {
    if (link) {
      return (
        <TrackLinkScreen
          state={link.state}
          trackId={link.trackId}
          query={link.query}
          onAnalyze={handleAnalyzeLink}
          onRetry={handleRetryLink}
          onSearch={handleNewSearch}
        />
      );
    }
    switch (phase) {
      case AppPhase.DASHBOARD:
        return (
          <Dashboard
            trackData={effectiveTrackData}
            onNavigate={handleNavigate}
            onAnalyzeTrack={handleAnalyzeTrack}
            logs={logs}
            isComplete={isComplete}
            onNewSearch={handleNewSearch}
            headingRef={setDashboardHeading}
            onUndoAnalysis={handleUndoAnalysis}
            isRestoredSession={isRestoredSession}
          />
        );
      case AppPhase.PLAYER:
        return (
          <Player
            trackData={effectiveTrackData}
            onBack={handleBackToDashboard}
            onDecryptMoreStream={decryptMoreFactoidsStream}
            onAnalyzeTrack={handleAnalyzeTrack}
            onNewSearch={handleNewSearch}
            headingRef={setPlayerHeading}
          />
        );
      default:
        return (
          <Onboarding
            status={status}
            logs={logs}
            trackData={effectiveTrackData}
            error={error}
            errorCode={errorCode}
            isLoading={isLoading}
            isReplay={isReplay}
            statusNote={statusNote}
            candidates={candidates}
            analyze={startSearch}
            selectCandidate={selectCandidate}
            retry={retrySearch}
            searchSuggest={searchSuggest}
            onComplete={handleAnalysisComplete}
            searchInputRef={searchInputRef}
            onRestorePrevious={previousTrackData ? handleRestorePrevious : undefined}
            onSearchAgain={handleNewSearch}
          />
        );
    }
  };

  return (
    <Layout footerFromMd={!link && phase === AppPhase.PLAYER}>
      <div id="main-content" className="flex-1 min-h-0 w-full flex flex-col">
        <Suspense fallback={phase === AppPhase.PLAYER ? PlayerSkeleton : DashboardSkeleton}>
          {renderScreen()}
        </Suspense>
      </div>
    </Layout>
  );
};

export default App;
