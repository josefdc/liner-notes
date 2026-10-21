import React, { useState, useMemo, useCallback, useEffect, useRef, Suspense } from 'react';
const SonicFingerprint = React.lazy(() => import('./SonicFingerprint'));
import ActivityLog from './ActivityLog';
import { Music, ArrowRight, ExternalLink, Search } from 'lucide-react';
import { AppPhase, type TrackData, type AgentLog } from '../types';
import TargetScanOverlay from './TargetScanOverlay';
import { AudioStats, InferenceLabel, ResultNotices } from './EstimatedWarning';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { SectionLabel } from './ui/SectionLabel';
import { isValidImageUrl } from '../utils/image';
import { normalizeTrack } from '../constants';

interface DashboardProps {
  trackData: TrackData | null;
  onNavigate: (phase: AppPhase) => void;
  onAnalyzeTrack?: (trackId: string, title: string, artist: string) => void;
  logs?: AgentLog[];
  isComplete?: boolean;
  // P0:3 — New search callback
  onNewSearch?: () => void;
  // UX: Focus management on phase transition
  headingRef?: React.Ref<HTMLHeadingElement>;
  // UX: Undo analysis callback
  onUndoAnalysis?: () => void;
  // UX: Hide activity log when restoring a previous session (logs are cleared)
  isRestoredSession?: boolean;
}

/**
 * Generate a consistent gradient color based on the label
 * Creates a deterministic color for nodes without images
 */
function generateGradientColors(label: string, group: number): { from: string; to: string } {
  // Generate a hash from the label
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    const char = label.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }

  const hue = Math.abs(hash) % 360;

  // Different color schemes based on group
  const groupHueOffset: Record<number, number> = {
    1: 180, // Current: cyan family
    2: 30, // Sampled: amber family
    3: 270, // Sampler: purple family
    4: 120, // Influence: green family
  };

  const offset = groupHueOffset[group] || 0;
  const finalHue = (hue + offset) % 360;

  return {
    from: `hsl(${finalHue}, 70%, 35%)`,
    to: `hsl(${(finalHue + 40) % 360}, 60%, 25%)`,
  };
}

// Tracks connected to this one in its genealogy (empty when there are none: no stand-ins)
function getRelatedTracks(trackData: TrackData | null): Array<{
  id: string;
  title: string;
  artist: string;
  reason: string;
  img: string | null;
  group: number;
}> {
  // Filter out the current song (group 1) and get related nodes
  const relatedNodes = (trackData?.genealogy?.nodes ?? [])
    .filter((node) => node.group !== 1)
    .slice(0, 4);

  const groupLabels: Record<number, string> = {
    2: 'Sampled in this track',
    3: 'Samples this track',
    4: 'Related influence',
  };

  return relatedNodes.map((node) => ({
    id: node.id,
    title: node.label,
    artist: '', // Genealogy nodes don't have separate artist field
    reason: groupLabels[node.group] || 'Related',
    img: isValidImageUrl(node.img) ? node.img : null,
    group: node.group,
  }));
}

const EMPTY_LOGS: AgentLog[] = [];

// Placeholder component with gradient background
const PlaceholderCover: React.FC<{ title: string; group: number }> = ({ title, group }) => {
  const colors = generateGradientColors(title, group);

  return (
    <div
      className="w-full h-full flex items-center justify-center"
      style={{
        background: `linear-gradient(135deg, ${colors.from}, ${colors.to})`,
      }}
    >
      <Music size={48} className="text-white/40" />
    </div>
  );
};

const Dashboard: React.FC<DashboardProps> = ({
  trackData: rawTrackData,
  onNavigate,
  onAnalyzeTrack,
  logs = EMPTY_LOGS,
  isComplete = true,
  onNewSearch,
  headingRef,
  onUndoAnalysis,
  isRestoredSession = false,
}) => {
  // Missing lists default to empty so a partial result renders instead of throwing.
  const trackData = useMemo(
    () => (rawTrackData ? normalizeTrack(rawTrackData) : null),
    [rawTrackData],
  );
  const relatedTracks = useMemo(() => getRelatedTracks(trackData), [trackData]);
  const hasGenreProfile = (trackData?.genreProfile?.length ?? 0) > 0;
  const [hoveredCardId, setHoveredCardId] = useState<string | null>(null);

  // UX: Undo toast state (replaces confirm dialog)
  const [undoToast, setUndoToast] = useState<{
    trackTitle: string;
    timeout: ReturnType<typeof setTimeout>;
  } | null>(null);
  const undoToastRef = useRef(undoToast);
  undoToastRef.current = undoToast;

  const clearUndoToast = useCallback(() => {
    setUndoToast((prev) => {
      if (prev) clearTimeout(prev.timeout);
      return null;
    });
  }, []);

  const startUndoTimeout = useCallback((trackTitle: string) => {
    const timeout = setTimeout(() => {
      setUndoToast(null);
    }, 5000);
    setUndoToast({ trackTitle, timeout });
  }, []);

  const handleUndo = useCallback(() => {
    clearUndoToast();
    onUndoAnalysis?.();
  }, [clearUndoToast, onUndoAnalysis]);

  // Pause-on-hover for undo toast
  const handleToastMouseEnter = useCallback(() => {
    setUndoToast((prev) => {
      if (prev) {
        clearTimeout(prev.timeout);
        return { ...prev, timeout: setTimeout(() => {}, 999999) }; // paused
      }
      return prev;
    });
  }, []);

  const handleToastMouseLeave = useCallback(() => {
    setUndoToast((prev) => {
      if (prev) {
        clearTimeout(prev.timeout);
        const timeout = setTimeout(() => setUndoToast(null), 5000);
        return { ...prev, timeout };
      }
      return prev;
    });
  }, []);

  // Global Ctrl+Z / Cmd+Z undo handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && undoToastRef.current) {
        e.preventDefault();
        handleUndo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo]);

  const handleCardClick = useCallback(
    (rec: { id: string; title: string; artist: string }) => {
      if (onAnalyzeTrack) {
        onAnalyzeTrack(rec.id, rec.title, rec.artist);
        startUndoTimeout(rec.title);
      } else {
        onNavigate(AppPhase.PLAYER);
      }
    },
    [onAnalyzeTrack, onNavigate, startUndoTimeout],
  );

  return (
    <div className="h-full w-full p-(--space-md) md:p-(--space-2xl) flex flex-col gap-(--space-xl) md:gap-(--space-2xl) overflow-y-auto overflow-x-hidden pb-20 md:pb-10">
      {/* Top Bar (P0:3 — New Search button, P0:5 — removed date slider) */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 animate-stagger-in stagger-1">
        <div>
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-medium tracking-tight text-white outline-none"
          >
            Command Center
          </h2>
          <p className="text-xs font-mono text-text-tertiary mt-1">
            AGENT_ID: X9-ALPHA {'//'} STATUS: ONLINE
          </p>
        </div>
        {onNewSearch && (
          <Button variant="ghost" size="sm" leftIcon={<Search size={14} />} onClick={onNewSearch}>
            NEW SEARCH
          </Button>
        )}
      </header>

      {/* What this result is missing, named (model unavailable, audio not measured) */}
      {trackData && <ResultNotices track={trackData} />}

      {/* Now Playing Hero Section (P2:17 — stagger animation) */}
      {trackData && (
        <section className="shrink-0 bg-surface border border-border rounded-lg p-(--space-xl) md:p-(--space-2xl) relative overflow-hidden group transition-all duration-(--duration-slow) animate-stagger-in stagger-2">
          {/* Background blur effect */}
          {trackData.coverUrl && (
            <img
              src={trackData.coverUrl}
              className="absolute inset-0 w-full h-full object-cover opacity-[0.07] blur-2xl scale-110 pointer-events-none"
              alt=""
            />
          )}

          <div className="relative z-10 flex flex-col md:flex-row gap-6 items-center md:items-start">
            {/* Album Cover */}
            <div className="relative w-32 h-32 md:w-40 md:h-40 flex-shrink-0 group/cover">
              <div className="absolute inset-0 bg-cyber/15 blur-2xl rounded opacity-0 group-hover/cover:opacity-40 transition-opacity duration-(--duration-slow)"></div>
              {trackData.coverUrl ? (
                <img
                  src={trackData.coverUrl}
                  alt={trackData.title}
                  className="w-full h-full object-cover rounded-md border border-white/10 shadow-2xl relative z-10"
                />
              ) : (
                <div className="w-full h-full rounded-md border border-white/10 bg-gray-900 flex items-center justify-center">
                  <Music size={48} className="text-text-muted" />
                </div>
              )}
            </div>

            {/* Track Info */}
            <div className="flex-1 text-center md:text-left">
              <div className="flex items-center justify-center md:justify-start gap-2 mb-2">
                <span className="text-[10px] font-mono text-cyber/60 uppercase tracking-widest">
                  NOW PLAYING
                </span>
                <div className="w-1.5 h-1.5 rounded-full bg-cyber/60"></div>
              </div>

              <h2 className="text-2xl md:text-4xl font-bold text-white tracking-tight mb-1">
                {trackData.title}
              </h2>
              <p className="text-lg text-text-tertiary font-mono mb-1">{trackData.artist}</p>
              {trackData.album && (
                <div className="flex items-center gap-2 mb-4 text-sm text-text-tertiary">
                  <span>{trackData.album}</span>
                  {trackData.releaseYear && (
                    <>
                      <span className="text-text-tertiary">•</span>
                      <span>{trackData.releaseYear}</span>
                    </>
                  )}
                  {trackData.explicit && <Badge variant="gray">EXPLICIT</Badge>}
                </div>
              )}

              {/* Audio values: measured, model scores, or "not measured" */}
              <AudioStats
                track={trackData}
                size="md"
                rowClassName="justify-center md:justify-start"
                className="mb-6"
              />

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center justify-center md:justify-start gap-3">
                <Button
                  variant="cyber"
                  size="md"
                  rightIcon={<ArrowRight size={16} />}
                  onClick={() => onNavigate(AppPhase.PLAYER)}
                >
                  VIEW FULL ANALYSIS
                </Button>
                {trackData.spotifyUrl && (
                  <a
                    href={trackData.spotifyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-6 py-2.5 bg-spotify/10 border border-spotify/30 text-spotify font-mono text-sm tracking-widest uppercase hover:bg-spotify/20 hover:border-spotify/50 hover:shadow-glow-spotify-subtle active:scale-[0.97] transition-all duration-(--duration-fast) ease-out-expo rounded-sm focus-visible:ring-2 focus-visible:ring-spotify/50 focus-visible:outline-none"
                  >
                    <ExternalLink size={14} />
                    SPOTIFY
                  </a>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Main Grid (P2:17 — stagger animations). It fills spare height but never shrinks below its
          content, and the hero above never shrinks: the page scrolls instead of clipping them. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1">
        {/* Hero: Sonic Fingerprint */}
        <section
          aria-label="Sonic Fingerprint"
          className="lg:col-span-1 bg-surface border border-border rounded-md p-6 flex flex-col relative overflow-hidden group hover:border-cyber/30 transition-colors animate-stagger-in stagger-3"
        >
          <div className="flex items-start justify-between gap-2 mb-4 z-10">
            <SectionLabel
              subtitle={hasGenreProfile ? 'Genre affinity written by the model' : 'Genre affinity'}
              className="flex-1"
            >
              Sonic Fingerprint
            </SectionLabel>
            {hasGenreProfile && <InferenceLabel />}
          </div>
          <div className="flex-1 min-h-[250px] md:min-h-[300px] z-10">
            <Suspense
              fallback={
                <div className="w-full h-full flex items-center justify-center text-xs font-mono text-text-tertiary">
                  Loading...
                </div>
              }
            >
              <SonicFingerprint
                genreProfile={trackData?.genreProfile}
                modelUnavailable={trackData?.modelUnavailable}
              />
            </Suspense>
          </div>
          {/* Decorative BG */}
          <div className="absolute top-0 right-0 w-64 h-64 bg-cyber/5 blur-[100px] pointer-events-none"></div>
        </section>

        {/* Connected tracks from the genealogy (P2:17 — stagger) */}
        <div className="lg:col-span-2 flex flex-col gap-6 animate-stagger-in stagger-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-medium tracking-tight text-white">Connected Tracks</h3>
              <p className="text-[10px] font-mono text-text-muted mt-0.5">
                {trackData?.modelUnavailable
                  ? 'From source data'
                  : 'From the genealogy graph — model inference from research'}
              </p>
            </div>
            {relatedTracks.length > 0 && (
              <span className="text-xs font-mono text-analog">
                {relatedTracks.length} RELATED ARTIFACTS
              </span>
            )}
          </div>

          {relatedTracks.length === 0 && (
            <p className="text-xs font-mono text-text-tertiary border border-dashed border-white/10 rounded-md p-4">
              No connected tracks found for this song.
            </p>
          )}

          <div className="flex gap-(--space-lg) overflow-x-auto pb-4 scrollbar-hide pt-2 pl-2 overscroll-contain">
            {relatedTracks.map((rec) => (
              <div
                key={rec.id}
                role="button"
                tabIndex={0}
                onClick={() => handleCardClick(rec)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleCardClick(rec);
                  }
                }}
                onMouseEnter={() => setHoveredCardId(rec.id)}
                onMouseLeave={() => setHoveredCardId(null)}
                className="relative min-w-[280px] rounded-md cursor-pointer group focus-visible:ring-2 focus-visible:ring-cyber/30 focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-none animate-fade-in-up opacity-0"
                style={{
                  animationDelay: `${relatedTracks.indexOf(rec) * 80}ms`,
                  animationFillMode: 'forwards',
                }}
              >
                {/* The card lifts inside a box that stays put, so a pointer near its bottom edge
                    does not drop the hover the lift itself causes. */}
                <div className="h-full bg-void border border-border p-4 rounded-md group-hover:border-cyber/30 group-hover:bg-surface-hover group-hover:-translate-y-1 group-hover:shadow-glow-cyber-subtle transition-[translate,box-shadow,border-color,background-color] duration-(--duration-normal) ease-out-expo">
                  <div className="relative aspect-square rounded-md overflow-hidden mb-4 bg-gray-900">
                    {rec.img ? (
                      <img
                        src={rec.img}
                        alt={rec.title}
                        className="w-full h-full object-cover opacity-80 group-hover:opacity-100 group-hover:scale-105 transition-all duration-(--duration-slow)"
                      />
                    ) : (
                      <PlaceholderCover title={rec.title} group={rec.group} />
                    )}
                    {/* Target Scan Overlay on hover */}
                    <TargetScanOverlay isHovered={hoveredCardId === rec.id} />
                  </div>

                  <div className="space-y-1">
                    <h4 className="font-semibold text-white truncate">{rec.title}</h4>
                    {rec.artist && (
                      <p className="text-sm text-text-tertiary truncate">{rec.artist}</p>
                    )}
                  </div>

                  <div className="mt-4 pt-3 border-t border-white/5">
                    <Badge variant="analog" glow>
                      <span className="font-bold">LOGIC:</span> {rec.reason}
                    </Badge>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Agent Activity Log - Collapsible (P2:17 — stagger) */}
          {!isRestoredSession && (
            <div className="animate-stagger-in stagger-5">
              <ActivityLog logs={logs} isComplete={isComplete} />
            </div>
          )}
        </div>
      </div>

      {/* UX: Undo toast (replaces confirm dialog) */}
      {undoToast && (
        <div
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-4 px-5 py-3 bg-surface-overlay backdrop-blur-lg border border-cyber/30 rounded-md shadow-elevated-lg animate-slide-up-fade"
          onMouseEnter={handleToastMouseEnter}
          onMouseLeave={handleToastMouseLeave}
        >
          <span className="text-sm font-mono text-text-secondary">
            Analyzing <span className="text-white font-bold">{undoToast.trackTitle}</span>
          </span>
          <button
            type="button"
            onClick={handleUndo}
            className="text-xs font-mono font-bold text-cyber uppercase tracking-widest hover:text-white transition-colors focus-visible:ring-2 focus-visible:ring-cyber/30 focus-visible:outline-none px-2 py-1"
          >
            UNDO
          </button>
        </div>
      )}

      {/* UX: ARIA live region for undo toast announcements */}
      <div aria-live="assertive" className="sr-only">
        {undoToast
          ? `Analyzing ${undoToast.trackTitle}. Press Ctrl+Z or activate the undo button to cancel.`
          : ''}
      </div>
    </div>
  );
};

export default Dashboard;
