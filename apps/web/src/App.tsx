import type React from 'react';
import { useState, useCallback, useEffect, useLayoutEffect, useRef, Suspense } from 'react';
import Layout from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import Onboarding from './components/Onboarding';
import { TrackLinkScreen } from './components/TrackLinkScreen';
import { lazyWithRetry } from './utils/lazyWithRetry';
// Loaded again on the screen boundary's "Try again" (or another screen) when their code failed.
const Dashboard = lazyWithRetry(() => import('./components/Dashboard'));
const Player = lazyWithRetry(() => import('./components/Player'));
const MapView = lazyWithRetry(() => import('./components/MapView'));
import { AppPhase, type TrackData } from './types';
import { useAgent } from './hooks/useAgent';
import { fetchStoredRun } from './hooks/agent/storedRun';
import { preloadsResults } from './components/console/progress';
import { isSpotifyTrackId } from './utils/spotify';
import type { AnalyzeOptions } from './hooks/agent/types';
import { currentRoute, onHistoryMove, writeHistoryEntry } from './router/route';
import { screenKey } from './router/screenKey';
import { ShownResults } from './router/shownResults';
import {
  addressOf,
  type HistoryEntry,
  linkTo,
  openingScreen,
  type TrackLink,
} from './router/screens';
import {
  explore,
  NO_TRAIL,
  type Trail,
  type TrailStep,
  type TrailView,
  trailBefore,
  trailFromState,
} from './router/trail';
import { ExploredTrail } from './components/ExploredTrail';

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

// Same padding and gaps as the Dashboard (components/Dashboard.tsx), and a top row of the "New
// search" button's height (the Dashboard's h1 is the track's title, in the hero), so the hero
// card and everything below it stay where they are when the Dashboard loads.
const DashboardSkeleton = (
  <div
    {...LOADING_VIEW_PROPS}
    className="h-full w-full p-(--space-md) md:p-(--space-2xl) flex flex-col gap-(--space-xl) md:gap-(--space-2xl) overflow-hidden bg-void animate-fade-in focus:outline-none"
  >
    {/* Top row: the "New search" button (a small Button: its padding, line and border) */}
    <div className="flex md:justify-end">
      <div
        className={`w-36 py-1.5 text-xs border border-white/10 rounded-sm ${shimmerClass}`}
        aria-hidden="true"
      >
        &nbsp;
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

// The full-size map's band (the way back and its heading) above the map's area.
const MapSkeleton = (
  <div
    {...LOADING_VIEW_PROPS}
    className="h-full w-full flex flex-col bg-void animate-fade-in focus:outline-none"
  >
    <div className="px-6 py-3 border-b border-white/5 flex flex-col gap-2">
      <div className={`h-4 w-40 ${shimmerClass} rounded-sm`} />
      <div className={`h-5 w-64 ${shimmerClass} rounded-sm`} />
    </div>
    <div className={`flex-1 m-4 ${shimmerClass} border border-white/10 rounded-lg`} />
  </div>
);

/** The screens that show a result, each with a heading that takes the focus. */
type ResultScreen = AppPhase.DASHBOARD | AppPhase.PLAYER | AppPhase.MAP;
const isResultScreen = (screen: AppPhase | 'link'): screen is ResultScreen =>
  screen === AppPhase.DASHBOARD || screen === AppPhase.PLAYER || screen === AppPhase.MAP;

/** The loading view on the page, if any (see LOADING_VIEW_PROPS). */
const loadingView = () => document.querySelector<HTMLElement>('[data-loading-view]');

/**
 * A result view's code fetched ahead of time could not be loaded: nothing to do. Preloading is
 * best effort, and the view imports its code again when it is shown (utils/lazyWithRetry.ts),
 * where a failure has its fallback. Caught, it is not an unhandled rejection.
 */
const preloadFailed = () => {};

/** The API's limit on the length of an analysis query (the contract's MAX_QUERY_LENGTH). */
const MAX_QUERY_LENGTH = 200;

/**
 * `text` cut to the API's limit, counted in UTF-16 code units as the API counts it, never inside
 * a character: a character the cut would split (an emoji) is left out whole, since half of one
 * cannot be sent in an address.
 */
function withinQueryLimit(text: string): string {
  const cut = text.slice(0, MAX_QUERY_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

const App: React.FC = () => {
  const [opening] = useState(() => openingScreen(currentRoute(), window.history.state));
  const [phase, setPhase] = useState<AppPhase>(opening.phase);
  // The tracks explored before the one on screen (router/trail.ts), as its history entry has
  // them: Back and Forward bring each entry's back.
  const [trail, setTrail] = useState<Trail>(opening.trail);
  // The trail before the last analysis from a map, for "Back to the last result".
  const trailBeforeAnalysis = useRef<Trail>(NO_TRAIL);
  // The Player's phone tab, as its history entry has it.
  const [playerTab, setPlayerTab] = useState<string | undefined>(opening.tab);
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
    retryAt,
    moreFacts,
    moreFactoidsStream,
    searchSuggest,
    reset,
  } = useAgent();

  // ─── UX: Focus management refs (Item 1) ─────────────────────────────────
  const dashboardHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const playerHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const mapHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // A result view whose heading is to take the focus as soon as it is in the page: its code
  // was still loading when it was opened. Waited for however long the code takes: the focus
  // stays on the loading view meanwhile, and is taken only from there or from the page.
  const focusWait = useRef<AppPhase | null>(null);
  const takeWaitingFocus = useCallback((screen: AppPhase, heading: HTMLHeadingElement) => {
    if (focusWait.current !== screen) return;
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
  const setMapHeading = useCallback(
    (heading: HTMLHeadingElement | null) => {
      mapHeadingRef.current = heading;
      if (heading) takeWaitingFocus(AppPhase.MAP, heading);
    },
    [takeWaitingFocus],
  );

  // ─── UX: Previous result, for "Back to the last result" (Item 8) ──────────
  const [previousTrackData, setPreviousTrackData] = useState<TrackData | null>(null);

  // ─── UX: Session restore override (Item 8) ─────────────────────────────
  // A result that is not the hook's current run (a restored one, or the stored one a link
  // loaded): the hook's trackData is null then. Cleared on the next analysis.
  const [overrideTrackData, setOverrideTrackData] = useState<TrackData | null>(null);
  const [isRestoredSession, setIsRestoredSession] = useState(false);
  const effectiveTrackData = overrideTrackData || trackData;

  // The results shown on this page, by track id (the last SHOWN_RESULTS_LIMIT): Back and
  // Forward to a result show it again without a request. One per track: an older entry of a
  // track analysed twice on this page shows the track's newest result (the same track, never
  // another's).
  const shownResults = useRef(new ShownResults());
  useEffect(() => {
    if (effectiveTrackData?.id) shownResults.current.remember(effectiveTrackData);
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
  // A result's heading takes the focus, or, while its code loads, the loading view until the
  // heading is in.
  const focusResult = useCallback((shown: ResultScreen) => {
    const heading = {
      [AppPhase.DASHBOARD]: dashboardHeadingRef,
      [AppPhase.PLAYER]: playerHeadingRef,
      [AppPhase.MAP]: mapHeadingRef,
    }[shown].current;
    if (heading?.isConnected) {
      heading.focus();
      return;
    }
    focusWait.current = shown;
    loadingView()?.focus();
  }, []);
  useLayoutEffect(() => {
    focusWait.current = null;
    if (screen === 'link') return;
    if (screen === AppPhase.ONBOARDING) {
      searchInputRef.current?.focus();
      return;
    }
    if (isResultScreen(screen)) focusResult(screen);
  }, [screen, focusResult]);
  // "Try again" on a result whose code could not be loaded: the focus moves as on opening it.
  const handleScreenRetried = useCallback(() => {
    if (isResultScreen(screen)) focusResult(screen);
  }, [screen, focusResult]);

  // A link to a result: its view's code is fetched while the stored result loads, not after.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the screen the page opened on
  useEffect(() => {
    if (!opening.link) return;
    if (opening.phase === AppPhase.PLAYER) import('./components/Player').catch(preloadFailed);
    else if (opening.phase === AppPhase.MAP) import('./components/MapView').catch(preloadFailed);
    else import('./components/Dashboard').catch(preloadFailed);
  }, []);

  // Preload lazy chunks when analysis nears completion
  useEffect(() => {
    if (preloadsResults(status)) {
      import('./components/Dashboard').catch(preloadFailed);
      import('./components/Player').catch(preloadFailed);
    }
  }, [status]);

  // UX: Eager preload Player when entering Dashboard (Item 11)
  useEffect(() => {
    if (phase === AppPhase.DASHBOARD) {
      import('./components/Player').catch(preloadFailed);
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

  // The next history entry the app writes is pushed, even for the same kind of screen (another
  // track's map from the breadcrumb), with these marks.
  const nextEntry = useRef<Pick<HistoryEntry, 'search' | 'fromPlayer'> | null>(null);

  // Handle navigation with track data
  const handleNavigate = useCallback((newPhase: AppPhase) => {
    // The Player opened from the Dashboard opens on its first tab.
    setPlayerTab(undefined);
    setPhase(newPhase);
  }, []);

  // A connected track analysed from the Dashboard or the Player, or from the full-size map. The
  // run starts at once, so the progress screen is up from its first frame and its status line
  // takes the focus. Analysed from a map (`from`), the track on screen joins the trail of the
  // next one; from anywhere else the next one starts a trail of its own.
  const handleAnalyzeTrack = useCallback(
    (trackId: string, title: string, artist: string, from?: TrailView) => {
      // The result on screen stays available: Stop, then "Back to the last result", shows it.
      setPreviousTrackData(effectiveTrackData);
      trailBeforeAnalysis.current = trail;
      const left = effectiveTrackData;
      setTrail(
        from && left && isSpotifyTrackId(left.id)
          ? explore(trail, {
              trackId: left.id,
              title: left.title || left.id,
              artist: left.artist || null,
              view: from,
            })
          : NO_TRAIL,
      );
      setOverrideTrackData(null);
      setIsRestoredSession(false);
      reset();
      analyze(`${title} ${artist}`.trim(), isSpotifyTrackId(trackId) ? { trackId } : {});
      // The progress screen's entry is taken over by the result, as a search's is: Back from
      // the result leads to the screen it was analysed from.
      nextEntry.current = { search: true };
      setPhase(AppPhase.ONBOARDING);
    },
    [reset, analyze, effectiveTrackData, trail],
  );

  const handleBackToDashboard = useCallback(() => {
    setPhase(AppPhase.DASHBOARD);
  }, []);

  // UX: Restore previous session (Item 8)
  const handleRestorePrevious = useCallback(() => {
    if (previousTrackData) {
      setOverrideTrackData(previousTrackData);
      setIsRestoredSession(true);
      setTrail(trailBeforeAnalysis.current);
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
    // A new search starts no chain: the explored tracks are cleared.
    setTrail(NO_TRAIL);
    reset();
    setPhase(AppPhase.ONBOARDING);
  }, [reset, effectiveTrackData]);

  // ─── P1:15 Browser history support ────────────────────────────────────────
  // One history entry per screen, at that screen's address; the steps of an analysis add none.
  // Each entry records how many in-app entries lie behind it (`index`). The entry a search
  // pushes (`search`) is taken over by its result.
  const address = addressOf(phase, effectiveTrackData, link);
  // A result's entry keeps its trail (none on the search's).
  const trailOfEntry = phase !== AppPhase.ONBOARDING && trail.steps.length > 0 ? trail : undefined;
  const entryRef = useRef<HistoryEntry>({ phase, index: 0, url: address });
  const writeHistory = useCallback((entry: HistoryEntry, mode: 'push' | 'replace') => {
    entryRef.current = entry;
    writeHistoryEntry(entry, entry.url, mode);
  }, []);

  // The page's own entry, at its address (an unknown path becomes the search's `/`).
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally runs only on mount
  useEffect(() => {
    writeHistory(
      {
        phase,
        index: 0,
        url: address,
        trail: trailOfEntry,
        tab: phase === AppPhase.PLAYER ? opening.tab : undefined,
        fromPlayer: opening.fromPlayer || undefined,
      },
      'replace',
    );
  }, []);

  useEffect(() => {
    const entry = entryRef.current;
    const marks = nextEntry.current;
    nextEntry.current = null;
    if (entry.phase === phase && !marks) {
      // The same screen at a new address: a link's stored result came in, and the address now
      // carries the track's name.
      if (entry.url !== address) writeHistory({ ...entry, url: address }, 'replace');
      return;
    }
    const next: HistoryEntry = {
      phase,
      index: entry.index + 1,
      url: address,
      trail: trailOfEntry,
      ...marks,
    };
    if (entry.search && phase === AppPhase.DASHBOARD) {
      writeHistory({ ...next, index: entry.index, search: undefined }, 'replace');
    } else {
      writeHistory(next, 'push');
    }
  }, [phase, address, trailOfEntry, writeHistory]);

  // The Player's phone tab, kept in its entry for Back and Forward to it.
  const handleTabChange = useCallback(
    (tab: string) => {
      setPlayerTab(tab);
      const entry = entryRef.current;
      if (entry.phase === AppPhase.PLAYER && entry.tab !== tab) {
        writeHistory({ ...entry, tab }, 'replace');
      }
    },
    [writeHistory],
  );

  // "Open the full map" in the Player: the map gets an entry of its own.
  const handleOpenMap = useCallback(() => {
    nextEntry.current = { fromPlayer: true };
    setPhase(AppPhase.MAP);
  }, []);

  // "Back to <title>" on the full-size map: back to the Player it was opened from, or (a map
  // opened from its link) on to the track's address.
  const handleMapBack = useCallback(() => {
    if (entryRef.current.fromPlayer) {
      window.history.back();
      return;
    }
    setPhase(AppPhase.DASHBOARD);
  }, []);

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
      // A new search starts no chain.
      setTrail(NO_TRAIL);
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
    const query = withinQueryLimit(link.query ?? link.trackId);
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

  // A track of the breadcrumb: its Player or full-size map, with the steps before it as its
  // trail, in an entry of its own; shown again if this page has it, else its stored result.
  const handleOpenStep = useCallback(
    (step: TrailStep, index: number) => {
      const shown = shownResults.current.get(step.trackId);
      const query = `${step.title} ${step.artist ?? ''}`.trim() || null;
      setTrail(trailBefore(trail, index));
      // Its map was opened from its Player's Connections tab.
      setPlayerTab(step.view === 'player' ? 'genealogy' : undefined);
      if (shown) {
        setOverrideTrackData(shown);
        setIsRestoredSession(true);
        setLink(null);
      } else {
        reset();
        setOverrideTrackData(null);
        setIsRestoredSession(false);
        setLink(
          linkTo({ kind: step.view === 'map' ? 'map' : 'track', trackId: step.trackId, query }),
        );
      }
      nextEntry.current = {};
      setPhase(step.view === 'map' ? AppPhase.MAP : AppPhase.PLAYER);
    },
    [trail, reset],
  );

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
        // The entry's trail and tab come back with it.
        const restored = trailFromState(target);
        entryRef.current = {
          phase: targetPhase,
          index: target.index ?? 0,
          search: target.search,
          url: `${window.location.pathname}${window.location.search}`,
          trail: restored.steps.length > 0 ? restored : undefined,
          tab: typeof target.tab === 'string' ? target.tab : undefined,
          fromPlayer: target.fromPlayer === true || undefined,
        };
        if (targetPhase === AppPhase.ONBOARDING) {
          // Back from a result starts a new search; the result stays available to restore.
          if (phase !== AppPhase.ONBOARDING || link) handleNewSearch();
          return;
        }
        setTrail(restored);
        setPlayerTab(entryRef.current.tab);
        const wanted = route?.kind === 'track' || route?.kind === 'map' ? route : null;
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

  // The address of the result's full-size map; none for a result no address loads again.
  const mapAddress = addressOf(AppPhase.MAP, effectiveTrackData, null);
  const shownTrailOf =
    !link && effectiveTrackData && isResultScreen(phase) && trail.steps.length > 0
      ? effectiveTrackData
      : null;

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
            isRestoredSession={isRestoredSession}
          />
        );
      case AppPhase.PLAYER:
        return (
          <Player
            trackData={effectiveTrackData}
            onBack={handleBackToDashboard}
            moreFacts={moreFacts}
            onMoreFactoidsStream={moreFactoidsStream}
            onAnalyzeTrack={handleAnalyzeTrack}
            onNewSearch={handleNewSearch}
            headingRef={setPlayerHeading}
            mapHref={mapAddress === '/' ? null : mapAddress}
            onOpenMap={handleOpenMap}
            initialTab={playerTab}
            onTabChange={handleTabChange}
          />
        );
      case AppPhase.MAP:
        return (
          <MapView
            trackData={effectiveTrackData}
            moreFacts={moreFacts}
            onAnalyzeTrack={handleAnalyzeTrack}
            trackHref={addressOf(AppPhase.DASHBOARD, effectiveTrackData, null)}
            onBackToTrack={handleMapBack}
            onNewSearch={handleNewSearch}
            headingRef={setMapHeading}
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
            retryAt={retryAt}
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
        {/* The tracks explored in this chain, above the result's view */}
        {shownTrailOf && (
          <ExploredTrail
            trail={trail}
            current={{
              title: shownTrailOf.title || shownTrailOf.id,
              artist: shownTrailOf.artist || null,
              url: address,
            }}
            onOpen={handleOpenStep}
          />
        )}
        {/* A screen that throws says so in its place, with a way back to the search; one whose
            code cannot be loaded offers to load it again or to reload the page. Another screen
            or result is tried afresh (resetKey), its code loaded again if it failed, without
            mounting the screen again, so its heading keeps the focus on Back and Forward. */}
        <ErrorBoundary
          resetKey={screenKey(phase, link !== null, effectiveTrackData?.id)}
          message="This screen could not be shown"
          action={{ label: 'New search', onClick: handleNewSearch }}
          loadFailedMessage="This screen could not be loaded"
          onRetried={handleScreenRetried}
          className="flex-1 min-h-0 w-full bg-void"
        >
          <Suspense
            fallback={
              phase === AppPhase.PLAYER
                ? PlayerSkeleton
                : phase === AppPhase.MAP
                  ? MapSkeleton
                  : DashboardSkeleton
            }
          >
            {renderScreen()}
          </Suspense>
        </ErrorBoundary>
      </div>
    </Layout>
  );
};

export default App;
