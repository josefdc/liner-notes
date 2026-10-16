import React, { useState, useCallback, useEffect, useLayoutEffect, useRef, Suspense, lazy, startTransition } from 'react';
import Layout from './components/Layout';
import Onboarding from './components/Onboarding';
const Dashboard = lazy(() => import('./components/Dashboard'));
const Player = lazy(() => import('./components/Player'));
import { AppPhase, TrackData, AgentLog } from './types';
import { useAgent } from './hooks/useAgent';
import type { AgentStatus, SearchCandidate } from './hooks/agent/types';
import type { Factoid } from './types';

// ─── P2:18 Dashboard skeleton fallback ──────────────────────────────────────
const shimmerClass = 'bg-gradient-to-r from-white/[0.03] via-white/[0.07] to-white/[0.03] bg-[length:200%_100%] animate-progress-shimmer';

const DashboardSkeleton = (
  <div className="h-full w-full p-4 md:p-10 flex flex-col gap-6 md:gap-8 overflow-hidden bg-void animate-fade-in">
    {/* Header skeleton */}
    <div className="flex justify-between items-center">
      <div className="space-y-2">
        <div className={`h-7 w-48 ${shimmerClass} rounded-[--radius-sm]`} />
        <div className={`h-3 w-64 ${shimmerClass} rounded-[--radius-sm]`} />
      </div>
    </div>
    {/* Hero card skeleton */}
    <div className={`h-48 ${shimmerClass} border border-white/10 rounded-[--radius-lg]`} />
    {/* Grid skeleton */}
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0">
      <div className={`lg:col-span-1 ${shimmerClass} border border-white/10 rounded-[--radius-lg] min-h-[300px]`} />
      <div className="lg:col-span-2 flex flex-col gap-6">
        <div className={`h-5 w-40 ${shimmerClass} rounded-[--radius-sm]`} />
        <div className="flex gap-4">
          {[1, 2, 3].map(i => (
            <div key={i} className={`min-w-[280px] h-80 ${shimmerClass} border border-white/10 rounded-[--radius-lg]`} />
          ))}
        </div>
      </div>
    </div>
  </div>
);

const PlayerSkeleton = (
  <div className="h-full w-full flex flex-col bg-void animate-fade-in">
    <div className="px-6 py-4 border-b border-white/5">
      <div className={`h-4 w-32 ${shimmerClass} rounded-[--radius-sm]`} />
    </div>
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-6">
        <div className={`w-64 h-64 mx-auto ${shimmerClass} rounded-[--radius-md]`} />
        <div className={`h-6 w-48 mx-auto ${shimmerClass} rounded-[--radius-sm]`} />
        <div className={`h-4 w-32 mx-auto ${shimmerClass} rounded-[--radius-sm]`} />
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
  isLoading: boolean;
  isComplete: boolean;
  candidates: SearchCandidate[] | null;
  analyze: (query: string) => Promise<void>;
  selectCandidate: (candidateId: string) => Promise<void>;
  searchSuggest: (query: string, limit?: number) => Promise<SearchCandidate[]>;
  // Player props
  decryptMoreFactoidsStream: (
    trackTitle: string,
    trackArtist: string,
    existingIds: string[],
    onFactoid: (factoid: Factoid) => void
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

const PhaseView = React.memo<PhaseViewProps>(({
  phase,
  status,
  logs,
  trackData,
  error,
  isLoading,
  isComplete,
  candidates,
  analyze,
  selectCandidate,
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
          isLoading={isLoading}
          candidates={candidates}
          analyze={analyze}
          selectCandidate={selectCandidate}
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
          isLoading={isLoading}
          candidates={candidates}
          analyze={analyze}
          selectCandidate={selectCandidate}
          searchSuggest={searchSuggest}
          onComplete={onAnalysisComplete}
          searchInputRef={searchInputRef}
          onRestorePrevious={onRestorePrevious ?? undefined}
        />
      );
  }
});

const App: React.FC = () => {
  const [phase, setPhase] = useState<AppPhase>(AppPhase.ONBOARDING);
  const {
    status, logs, trackData, candidates, error, isLoading, isComplete,
    analyze, selectCandidate, decryptMoreFactoidsStream, searchSuggest, reset,
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
  const [pendingQuery, setPendingQuery] = useState<string | null>(null);

  useEffect(() => {
    if (pendingQuery && phase === AppPhase.ONBOARDING) {
      analyze(pendingQuery);
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
    if (status === 'composing') {
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
      td.genealogy?.nodes?.forEach(node => {
        if (node.img) {
          const img = new Image();
          img.src = node.img;
        }
      });
    }
  }, [effectiveTrackData]);

  // Handle song analysis completion
  const handleAnalysisComplete = useCallback((completedData: TrackData) => {
    setOverrideTrackData(null); // New analysis data comes from hook
    setIsRestoredSession(false);
    setPhase(AppPhase.DASHBOARD);
  }, []);

  // Handle navigation with track data
  const handleNavigate = useCallback((newPhase: AppPhase) => {
    setPhase(newPhase);
  }, []);

  // Handle analyzing a track from Dashboard (Discovered Gems) — P1:13 fix
  const handleAnalyzeTrack = useCallback((trackId: string, title: string, artist: string) => {
    // Save current trackData for undo (Item 2)
    previousTrackDataRef.current = effectiveTrackData;
    setOverrideTrackData(null);
    setIsRestoredSession(false);
    reset();
    setPendingQuery(`${title} ${artist}`.trim());
    startTransition(() => setPhase(AppPhase.ONBOARDING));
  }, [reset, effectiveTrackData]);

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
  useEffect(() => {
    window.history.replaceState({ phase }, '');
  }, []); // Set initial state

  useEffect(() => {
    // Don't push during analysis (would create noise)
    if (status !== 'idle' && status !== 'complete' && status !== 'error' && phase === AppPhase.ONBOARDING) {
      return;
    }
    window.history.pushState({ phase }, '');
  }, [phase, status]);

  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      if (event.state?.phase) {
        const targetPhase = event.state.phase as AppPhase;
        // Guard: don't interrupt a running analysis
        if (phase === AppPhase.ONBOARDING && isLoading) {
          // Re-push current state to prevent navigation
          window.history.pushState({ phase }, '');
          return;
        }
        // Guard: don't navigate to dashboard/player without track data
        if ((targetPhase === AppPhase.DASHBOARD || targetPhase === AppPhase.PLAYER) && !effectiveTrackData) {
          setPhase(AppPhase.ONBOARDING);
          return;
        }
        setPhase(targetPhase);
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [phase, isLoading, effectiveTrackData]);

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
            isLoading={isLoading}
            isComplete={isComplete}
            candidates={candidates}
            analyze={analyze}
            selectCandidate={selectCandidate}
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
