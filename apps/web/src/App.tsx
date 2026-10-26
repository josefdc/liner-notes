import React, {
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  Suspense,
  lazy,
  startTransition,
} from 'react';
import Layout from './components/Layout';
import Onboarding from './components/Onboarding';
const Dashboard = lazy(() => import('./components/Dashboard'));
const Player = lazy(() => import('./components/Player'));
import { AppPhase, type TrackData, type AgentLog } from './types';
import { useAgent } from './hooks/useAgent';
import { preloadsResults } from './components/console/progress';
import { isSpotifyTrackId } from './utils/spotify';
import type { AgentStatus, AnalyzeOptions, ResultMode, SearchCandidate } from './hooks/agent/types';
import type { Factoid, FactoidUnavailableCode } from './types';

// ─── P2:18 Dashboard skeleton fallback ──────────────────────────────────────
const shimmerClass =
  'bg-gradient-to-r from-white/[0.03] via-white/[0.07] to-white/[0.03] bg-[length:200%_100%] animate-progress-shimmer';

// Same padding and gaps as the Dashboard (components/Dashboard.tsx), so nothing shifts when it loads.
const DashboardSkeleton = (
  <div className="h-full w-full p-(--space-md) md:p-(--space-2xl) flex flex-col gap-(--space-xl) md:gap-(--space-2xl) overflow-hidden bg-void animate-fade-in">
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
  <div className="h-full w-full flex flex-col bg-void animate-fade-in">
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

// Choose skeleton based on likely phase
const LOADING_FALLBACK = DashboardSkeleton;

interface PhaseViewProps {
  phase: AppPhase;
  // Onboarding props
  status: AgentStatus;
  logs: AgentLog[];
  trackData: TrackData | null;
  error: string | null;
  errorCode: string | null;
  isLoading: boolean;
  isComplete: boolean;
  isReplay: boolean;
  /** The server's own words for the step under way. */
  statusNote: string | null;
  candidates: SearchCandidate[] | null;
  analyze: (query: string) => Promise<void>;
  selectCandidate: (candidateId: string) => Promise<void>;
  retry: () => void;
  searchSuggest: (query: string, limit?: number) => Promise<SearchCandidate[]>;
  // Player props
  decryptMoreFactoidsStream: (
    trackTitle: string,
    trackArtist: string,
    existingIds: string[],
    onFactoid: (factoid: Factoid) => void,
    signal?: AbortSignal,
    onUnavailable?: (code: FactoidUnavailableCode) => void,
    resultMode?: ResultMode,
  ) => Promise<void>;
  // Navigation
  onAnalysisComplete: (trackData: TrackData) => void;
  onNavigate: (phase: AppPhase) => void;
  onAnalyzeTrack: (trackId: string, title: string, artist: string) => void;
  onBackToBoard: () => void;
  // P0:3 — New search
  onNewSearch: () => void;
  // UX: Focus management refs
  dashboardHeadingRef: React.RefObject<HTMLHeadingElement | null>;
  playerHeadingRef: React.RefObject<HTMLHeadingElement | null>;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  // UX: Undo analysis
  onUndoAnalysis: () => void;
  // UX: Session restore
  onRestorePrevious: (() => void) | null;
  isRestoredSession: boolean;
}

const PhaseView = React.memo<PhaseViewProps>(
  ({
    phase,
    status,
    logs,
    trackData,
    error,
    errorCode,
    isLoading,
    isComplete,
    isReplay,
    statusNote,
    candidates,
    analyze,
    selectCandidate,
    retry,
    searchSuggest,
    decryptMoreFactoidsStream,
    onAnalysisComplete,
    onNavigate,
    onAnalyzeTrack,
    onBackToBoard,
    onNewSearch,
    dashboardHeadingRef,
    playerHeadingRef,
    searchInputRef,
    onUndoAnalysis,
    onRestorePrevious,
    isRestoredSession,
  }) => {
    switch (phase) {
      case AppPhase.ONBOARDING:
        return (
          <Onboarding
            status={status}
            logs={logs}
            trackData={trackData}
            error={error}
            errorCode={errorCode}
            isLoading={isLoading}
            isReplay={isReplay}
            statusNote={statusNote}
            candidates={candidates}
            analyze={analyze}
            selectCandidate={selectCandidate}
            retry={retry}
            searchSuggest={searchSuggest}
            onComplete={onAnalysisComplete}
            searchInputRef={searchInputRef}
            onRestorePrevious={onRestorePrevious ?? undefined}
          />
        );
      case AppPhase.DASHBOARD:
        return (
          <Dashboard
            trackData={trackData}
            onNavigate={onNavigate}
            onAnalyzeTrack={onAnalyzeTrack}
            logs={logs}
            isComplete={isComplete}
            onNewSearch={onNewSearch}
            headingRef={dashboardHeadingRef}
            onUndoAnalysis={onUndoAnalysis}
            isRestoredSession={isRestoredSession}
          />
        );
      case AppPhase.PLAYER:
        return (
          <Player
            trackData={trackData}
            onBack={onBackToBoard}
            onDecryptMoreStream={decryptMoreFactoidsStream}
            onAnalyzeTrack={onAnalyzeTrack}
            onNewSearch={onNewSearch}
            headingRef={playerHeadingRef}
          />
        );
      default:
        return (
          <Onboarding
            status={status}
            logs={logs}
            trackData={trackData}
            error={error}
            errorCode={errorCode}
            isLoading={isLoading}
            isReplay={isReplay}
            statusNote={statusNote}
            candidates={candidates}
            analyze={analyze}
            selectCandidate={selectCandidate}
            retry={retry}
            searchSuggest={searchSuggest}
            onComplete={onAnalysisComplete}
            searchInputRef={searchInputRef}
            onRestorePrevious={onRestorePrevious ?? undefined}
          />
        );
    }
  },
);

/** What the app stores in each browser history entry. */
interface HistoryEntry {
  phase: AppPhase;
  /** In-app entries behind this one. */
  index: number;
  /** Pushed when a search started; its result replaces it. */
  search?: boolean;
}

const App: React.FC = () => {
  const [phase, setPhase] = useState<AppPhase>(AppPhase.ONBOARDING);
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

  // ─── UX: Previous track data for undo (Item 2) ──────────────────────────
  const previousTrackDataRef = useRef<TrackData | null>(null);

  // ─── UX: Session restore / undo override (Items 2, 8) ──────────────────
  // When undoing or restoring, the hook's trackData is null (reset clears it).
  // This override holds the restored data, which is cleared on next analysis.
  const [overrideTrackData, setOverrideTrackData] = useState<TrackData | null>(null);
  const [isRestoredSession, setIsRestoredSession] = useState(false);
  const effectiveTrackData = overrideTrackData || trackData;

  // ─── P1:13 Replace setTimeout hack with pendingQuery + useEffect ──────────
  // The track's Spotify id goes with the text when it is known: that very track is analysed.
  const [pendingQuery, setPendingQuery] = useState<{ query: string; trackId?: string } | null>(
    null,
  );

  useEffect(() => {
    if (pendingQuery && phase === AppPhase.ONBOARDING) {
      analyze(pendingQuery.query, pendingQuery.trackId ? { trackId: pendingQuery.trackId } : {});
      setPendingQuery(null);
    }
  }, [pendingQuery, phase, analyze]);

  // ─── UX: Focus management on phase transitions (Item 1) ─────────────────
  useLayoutEffect(() => {
    const focusWithRetry = (ref: React.RefObject<HTMLElement | null>) => {
      requestAnimationFrame(() => {
        if (ref.current) {
          ref.current.focus();
        } else {
          // Retry on next frame if lazy chunk hasn't resolved yet
          requestAnimationFrame(() => ref.current?.focus());
        }
      });
    };

    switch (phase) {
      case AppPhase.ONBOARDING:
        requestAnimationFrame(() => searchInputRef.current?.focus());
        break;
      case AppPhase.DASHBOARD:
        focusWithRetry(dashboardHeadingRef);
        break;
      case AppPhase.PLAYER:
        focusWithRetry(playerHeadingRef);
        break;
    }
  }, [phase]);

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
  useEffect(() => {
    const td = effectiveTrackData;
    if (td) {
      if (td.coverUrl) {
        const img = new Image();
        img.src = td.coverUrl;
      }
      // Preload genealogy node images
      td.genealogy?.nodes?.forEach((node) => {
        if (node.img) {
          const img = new Image();
          img.src = node.img;
        }
      });
    }
  }, [effectiveTrackData]);

  // Handle song analysis completion
  const handleAnalysisComplete = useCallback((_completedData: TrackData) => {
    setOverrideTrackData(null); // New analysis data comes from hook
    setIsRestoredSession(false);
    setPhase(AppPhase.DASHBOARD);
  }, []);

  // Handle navigation with track data
  const handleNavigate = useCallback((newPhase: AppPhase) => {
    setPhase(newPhase);
  }, []);

  // Handle analyzing a track from Dashboard (Discovered Gems) — P1:13 fix
  const handleAnalyzeTrack = useCallback(
    (trackId: string, title: string, artist: string) => {
      // Save current trackData for undo (Item 2)
      previousTrackDataRef.current = effectiveTrackData;
      setOverrideTrackData(null);
      setIsRestoredSession(false);
      reset();
      setPendingQuery({
        query: `${title} ${artist}`.trim(),
        ...(isSpotifyTrackId(trackId) ? { trackId } : {}),
      });
      startTransition(() => setPhase(AppPhase.ONBOARDING));
    },
    [reset, effectiveTrackData],
  );

  const handleBackToDashboard = useCallback(() => {
    setPhase(AppPhase.DASHBOARD);
  }, []);

  // UX: Undo analysis — abort SSE, restore previous state (Item 2)
  const handleUndoAnalysis = useCallback(() => {
    reset();
    if (previousTrackDataRef.current) {
      setOverrideTrackData(previousTrackDataRef.current);
      setIsRestoredSession(true);
      setPhase(AppPhase.DASHBOARD);
      previousTrackDataRef.current = null;
    } else {
      setPhase(AppPhase.ONBOARDING);
    }
  }, [reset]);

  // UX: Restore previous session (Item 8)
  const handleRestorePrevious = useCallback(() => {
    if (previousTrackDataRef.current) {
      setOverrideTrackData(previousTrackDataRef.current);
      setIsRestoredSession(true);
      setPhase(AppPhase.DASHBOARD);
    }
  }, []);

  // ─── P0:3 New search handler (Item 8 — save session for restore) ─────────
  const handleNewSearch = useCallback(() => {
    // Save current trackData so user can restore previous session
    if (effectiveTrackData) {
      previousTrackDataRef.current = effectiveTrackData;
    }
    setOverrideTrackData(null);
    setIsRestoredSession(false);
    reset();
    setPhase(AppPhase.ONBOARDING);
  }, [reset, effectiveTrackData]);

  // ─── P1:15 Browser history support ────────────────────────────────────────
  // One history entry per screen; the steps of an analysis add none. Each entry records how
  // many in-app entries lie behind it (`index`). The entry a search pushes (`search`) is
  // taken over by its result.
  const entryRef = useRef<HistoryEntry>({ phase, index: 0 });
  const writeHistory = useCallback((entry: HistoryEntry, mode: 'push' | 'replace') => {
    entryRef.current = entry;
    if (mode === 'push') window.history.pushState(entry, '');
    else window.history.replaceState(entry, '');
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally runs only on mount
  useEffect(() => {
    writeHistory({ phase, index: 0 }, 'replace');
  }, []);

  useEffect(() => {
    const entry = entryRef.current;
    // Already recorded: the initial entry, or the entry the browser just moved to.
    if (entry.phase === phase) return;
    if (entry.search && phase === AppPhase.DASHBOARD) {
      writeHistory({ phase, index: entry.index }, 'replace');
    } else {
      writeHistory({ phase, index: entry.index + 1 }, 'push');
    }
  }, [phase, writeHistory]);

  // A search started on an entry with nothing of the app behind it (the first search after
  // loading the page, or one after going back to the search) gets an entry of its own, so
  // Back reaches the guard below instead of leaving the app. Called from the click or submit
  // handler: an entry pushed without a user action may be skipped by the browser's Back.
  const markSearchEntry = useCallback(() => {
    const entry = entryRef.current;
    if (entry.search || entry.index > 0) return;
    writeHistory({ phase: AppPhase.ONBOARDING, index: entry.index + 1, search: true }, 'push');
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

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const target = event.state as HistoryEntry | null;
      const targetPhase = target?.phase;
      if (!target || !targetPhase) return;
      // Guard: don't interrupt a running analysis or an open track picker
      if (phase === AppPhase.ONBOARDING && (isLoading || status === 'disambiguation')) {
        // Re-push the entry the user was on to prevent navigation
        writeHistory(entryRef.current, 'push');
        return;
      }
      entryRef.current = { phase: targetPhase, index: target.index ?? 0, search: target.search };
      if (targetPhase === AppPhase.ONBOARDING) {
        // Back from a result starts a new search; the result stays available to restore.
        if (phase !== AppPhase.ONBOARDING) handleNewSearch();
        return;
      }
      if (!effectiveTrackData) {
        // Forward to a result left with Back: show it again, without a new analysis.
        if (previousTrackDataRef.current) {
          setOverrideTrackData(previousTrackDataRef.current);
          setIsRestoredSession(true);
          setPhase(targetPhase);
        } else {
          // Guard: don't navigate to dashboard/player without track data
          setPhase(AppPhase.ONBOARDING);
        }
        return;
      }
      setPhase(targetPhase);
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [phase, isLoading, status, effectiveTrackData, handleNewSearch, writeHistory]);

  return (
    <Layout>
      <div id="main-content" className="h-[100dvh] w-full flex flex-col">
        <Suspense fallback={phase === AppPhase.PLAYER ? PlayerSkeleton : LOADING_FALLBACK}>
          <PhaseView
            phase={phase}
            status={status}
            logs={logs}
            trackData={effectiveTrackData}
            error={error}
            errorCode={errorCode}
            isLoading={isLoading}
            isComplete={isComplete}
            isReplay={isReplay}
            statusNote={statusNote}
            candidates={candidates}
            analyze={startSearch}
            selectCandidate={selectCandidate}
            retry={retrySearch}
            searchSuggest={searchSuggest}
            decryptMoreFactoidsStream={decryptMoreFactoidsStream}
            onAnalysisComplete={handleAnalysisComplete}
            onNavigate={handleNavigate}
            onAnalyzeTrack={handleAnalyzeTrack}
            onBackToBoard={handleBackToDashboard}
            onNewSearch={handleNewSearch}
            dashboardHeadingRef={dashboardHeadingRef}
            playerHeadingRef={playerHeadingRef}
            searchInputRef={searchInputRef}
            onUndoAnalysis={handleUndoAnalysis}
            onRestorePrevious={previousTrackDataRef.current ? handleRestorePrevious : null}
            isRestoredSession={isRestoredSession}
          />
        </Suspense>
      </div>
    </Layout>
  );
};

export default App;
