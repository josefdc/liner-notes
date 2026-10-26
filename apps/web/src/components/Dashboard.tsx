import React, { useState, useMemo, useCallback, useEffect, useRef, Suspense } from 'react';
const SonicFingerprint = React.lazy(() => import('./SonicFingerprint'));
import ActivityLog from './ActivityLog';
import { Music, ArrowRight, ExternalLink, Search } from 'lucide-react';
import { AppPhase, type TrackData, type AgentLog } from '../types';
import TargetScanOverlay from './TargetScanOverlay';
import { AudioStats, InferenceLabel, RecordedRunNotice, ResultNotices } from './EstimatedWarning';
import { Button } from './ui/Button';
import { Badge } from './ui/Badge';
import { ProvenanceChip } from './provenance/ProvenanceChip';
import { AlbumCover, useAlbumCover } from './AlbumCover';
import { SectionLabel } from './ui/SectionLabel';
import { isValidImageUrl } from '../utils/image';
import { audioReadings, fingerprintSubtitle, normalizeTrack } from '../constants';
import type { TrackRelation } from './genealogy/links';
import { resultClaims, withoutHiddenRelations } from './provenance/claims';
import { useLinkReader } from './genealogy/useLinkReader';
import { PLACEHOLDER_NOTE, placeholderBackground } from '../styles/placeholder';

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

type LinkReader = typeof import('./genealogy/links');

interface RelatedTrack {
  id: string;
  /** The Spotify track the node was strictly matched to, when there is one. */
  spotifyId?: string;
  /** The text a click searches (or sends with the id): the node's track title and artist. */
  query: string;
  title: string;
  artist: string;
  relation: TrackRelation;
  /** The relation as a sentence naming both tracks (null when no link joins them). */
  sentence: string | null;
  /** Where the relation comes from (null when no link joins them). */
  provenance: string | null;
  img: string | null;
}

/**
 * The genealogy the main view shows: without the relations whose claim it hides (rejected, or
 * unreadable) and the tracks only those related, as in the Player.
 */
function shownGenealogy(trackData: TrackData | null) {
  if (!trackData) return null;
  const claims = resultClaims(trackData);
  return { claims, genealogy: withoutHiddenRelations(trackData.genealogy, claims.isHidden) };
}

/** The tracks other than the analysed one; the link reader is needed only when there are some. */
const relatedNodes = (shown: ReturnType<typeof shownGenealogy>) =>
  (shown?.genealogy.nodes ?? []).filter((node) => node.group !== 1);

/**
 * Tracks connected to this one in its genealogy (empty when there are none: no stand-ins), the
 * best known first. Each says how it is related by the link that joins it to this track, read
 * with the contract's rule and the reader's stricter ones: a documented relation (a sample, a
 * cover…) only for a sourced link with evidence in the pack, never from the node's group. Null
 * while the link reader loads.
 */
function getRelatedTracks(
  trackData: TrackData | null,
  shown: ReturnType<typeof shownGenealogy>,
  reader: LinkReader | null,
): RelatedTrack[] | null {
  const others = relatedNodes(shown);
  if (!trackData || !shown || others.length === 0) return [];
  if (!reader) return null;
  const nodes = shown.genealogy.nodes;
  const links = reader.shownLinks(
    shown.genealogy,
    reader.linkContext(trackData.evidence, shown.claims, { releaseYear: trackData.releaseYear }),
  );
  const named = reader.nodesById(nodes, reader.yearFrom(trackData.releaseYear));
  const nameOf = (id: string) => reader.nodeName(named.get(id), id);
  const currentId = nodes.find((node) => node.group === 1)?.id ?? null;
  const strength = (relation: TrackRelation) => (relation.link ? reader.rank(relation.link) : -1);

  return others
    .map((node) => ({ node, relation: reader.relationToTrack(links, node.id, currentId) }))
    .sort((a, b) => strength(b.relation) - strength(a.relation))
    .slice(0, 4)
    .map(({ node, relation }) => ({
      id: node.id,
      ...(node.spotifyId ? { spotifyId: node.spotifyId } : {}),
      query: [node.trackTitle, node.trackArtist].filter(Boolean).join(' ') || node.label,
      title: node.label,
      artist: '', // Genealogy nodes don't have separate artist field
      relation,
      sentence: relation.link ? reader.relationSentence(relation.link, nameOf) : null,
      provenance: relation.link ? reader.provenanceText(relation.link) : null,
      img: isValidImageUrl(node.img) ? node.img : null,
    }));
}

const EMPTY_LOGS: AgentLog[] = [];

// A connected track without cover art
const PlaceholderCover: React.FC = () => (
  <div
    className="w-full h-full flex items-center justify-center"
    style={{ background: placeholderBackground }}
  >
    <Music size={48} data-placeholder-note style={{ color: PLACEHOLDER_NOTE.color }} />
  </div>
);

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
  // The link reader loads only when there are connected tracks to read. The contract's schemas
  // it validates with are not deferred by this: the claims module imports the contract, and the
  // app loads it at startup for the stream's event schemas.
  const shown = useMemo(() => shownGenealogy(trackData), [trackData]);
  const cover = useAlbumCover(trackData?.coverUrl);
  const relatedCount = relatedNodes(shown).length;
  const { reader, failed: readerFailed, retry: retryReader } = useLinkReader(relatedCount > 0);
  const relatedTracks = useMemo(
    () => getRelatedTracks(trackData, shown, reader),
    [trackData, shown, reader],
  );
  const hasGenreProfile = (trackData?.genreProfile?.length ?? 0) > 0;
  // The audio models' style and tag scores; null for a result without an `audio` block.
  const fingerprint = useMemo(
    () => (trackData ? audioReadings(trackData).fingerprint : null),
    [trackData],
  );
  // What the panel shows, in words: never that the audio models ran when they did not.
  const fingerprintText = useMemo(
    () => (trackData ? fingerprintSubtitle(trackData, hasGenreProfile) : 'Genre affinity'),
    [trackData, hasGenreProfile],
  );
  const hasModelScores =
    fingerprint?.styles.state === 'shown' || fingerprint?.tags.state === 'shown';
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
    (rec: { id: string; spotifyId?: string; query: string; title: string; artist: string }) => {
      if (onAnalyzeTrack) {
        // The node's own id is the graph's, not Spotify's: the track is searched by its text
        // unless the node was matched to a Spotify track. The text is the node's track title
        // and artist, which the matched track's own title and artist match.
        onAnalyzeTrack(rec.spotifyId ?? 'search', rec.query, '');
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

      {/* A replayed result says it is a recording, before anything else about it */}
      {trackData && <RecordedRunNotice track={trackData} />}

      {/* What this result is missing, named (model unavailable, audio not measured) */}
      {trackData && <ResultNotices track={trackData} />}

      {/* Now Playing Hero Section (P2:17 — stagger animation) */}
      {trackData && (
        <section className="shrink-0 bg-surface border border-border rounded-lg p-(--space-xl) md:p-(--space-2xl) relative overflow-hidden group transition-all duration-(--duration-slow) animate-stagger-in stagger-2">
          {/* Background blur effect: only behind a cover that is shown */}
          {cover.src && (
            <img
              src={cover.src}
              onError={cover.onError}
              referrerPolicy="no-referrer"
              className="absolute inset-0 w-full h-full object-cover opacity-[0.07] blur-2xl scale-110 pointer-events-none"
              alt=""
            />
          )}

          <div className="relative z-10 flex flex-col md:flex-row gap-6 items-center md:items-start">
            {/* Album Cover */}
            <AlbumCover
              cover={cover}
              album={trackData.album}
              evidence={trackData.evidence}
              className="flex-shrink-0 w-32 md:w-40"
              frameClassName="group/cover"
              surfaceClassName="rounded-md shadow-2xl"
              iconSize={40}
            >
              <div className="absolute inset-0 bg-cyber/15 blur-2xl rounded opacity-0 group-hover/cover:opacity-40 transition-opacity duration-(--duration-slow)"></div>
            </AlbumCover>

            {/* Track Info */}
            <div className="flex-1 text-center md:text-left">
              <div className="flex items-center justify-center md:justify-start gap-2 mb-2">
                <span className="text-chrome font-mono text-cyber/80 uppercase tracking-widest">
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
                  {trackData.explicit && <Badge variant="neutral">EXPLICIT</Badge>}
                </div>
              )}

              {/* Audio values: measured, model scores, or "not measured". Compact: each value
                  with a chip of its kind, its provenance behind the chip (the Player has the
                  full lines) */}
              <AudioStats
                track={trackData}
                size="md"
                compact
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
            <SectionLabel subtitle={fingerprintText} className="flex-1">
              Sonic Fingerprint
            </SectionLabel>
            <div className="flex flex-col items-end gap-1">
              {hasModelScores && (
                <ProvenanceChip
                  kind="inferred"
                  title="Scores from audio models run on the preview: estimates, not measurements and not probabilities"
                >
                  Model estimate
                </ProvenanceChip>
              )}
              {hasGenreProfile && <InferenceLabel />}
            </div>
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
                fingerprint={fingerprint}
              />
            </Suspense>
          </div>
          {/* Decorative BG */}
          <div className="absolute top-0 right-0 w-64 h-64 bg-cyber/5 blur-[100px] pointer-events-none"></div>
        </section>

        {/* Connected tracks from the genealogy (P2:17 — stagger) */}
        <div className="lg:col-span-2 flex flex-col gap-6 animate-stagger-in stagger-4">
          {/* The count moves below the heading when the two do not fit side by side */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <div>
              <h3 className="text-lg font-medium tracking-tight text-white">Connected Tracks</h3>
              <p className="text-chrome font-mono text-text-muted mt-0.5">
                {trackData?.modelUnavailable
                  ? 'From source data'
                  : 'From the genealogy graph — each card says whether its link is sourced or a model inference'}
              </p>
            </div>
            {relatedTracks !== null && relatedTracks.length > 0 && (
              <span className="text-xs font-mono text-analog whitespace-nowrap">
                {/* What the cards show, out of how many connected tracks there are */}
                {relatedTracks.length < relatedCount
                  ? `${relatedTracks.length} OF ${relatedCount} RELATED TRACKS`
                  : `${relatedCount} RELATED ${relatedCount === 1 ? 'TRACK' : 'TRACKS'}`}
              </span>
            )}
          </div>

          {relatedTracks !== null && relatedTracks.length === 0 && (
            <p className="text-xs font-mono text-text-tertiary border border-dashed border-white/10 rounded-md p-4">
              No connected tracks found for this song.
            </p>
          )}
          {relatedTracks === null && readerFailed && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 text-xs font-mono text-text-tertiary border border-dashed border-white/10 rounded-md p-4"
            >
              <span>Connected tracks could not be loaded.</span>
              <Button variant="ghost" size="sm" onClick={retryReader}>
                TRY AGAIN
              </Button>
            </div>
          )}

          {/* Busy while the link reader loads: the cards follow once their relations are read */}
          <div
            aria-busy={relatedTracks === null && !readerFailed}
            className="flex gap-(--space-lg) overflow-x-auto pb-4 scrollbar-hide pt-2 pl-2 overscroll-contain"
          >
            {(relatedTracks ?? []).map((rec, index) => (
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
                data-hovered={hoveredCardId === rec.id || undefined}
                className="relative w-[280px] shrink-0 rounded-md cursor-pointer group focus-visible:ring-2 focus-visible:ring-cyber/70 focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-none animate-fade-in-up opacity-0"
                style={{
                  animationDelay: `${index * 80}ms`,
                  animationFillMode: 'forwards',
                }}
              >
                {/* The card lifts inside a box that stays put, so a pointer near its bottom edge
                    does not drop the hover the lift itself causes. */}
                <div className="h-full bg-void border border-border p-4 rounded-md group-hover:border-cyber/30 group-hover:bg-surface-hover group-hover:-translate-y-1 group-hover:shadow-glow-cyber-subtle transition-[translate,box-shadow,border-color,background-color] duration-(--duration-normal) ease-out-expo">
                  <div className="relative aspect-square rounded-md overflow-hidden mb-4 bg-void-lighter">
                    {rec.img ? (
                      <img
                        src={rec.img}
                        alt={rec.title}
                        className="w-full h-full object-cover opacity-80 group-hover:opacity-100 group-hover:scale-105 transition-all duration-(--duration-slow)"
                      />
                    ) : (
                      <PlaceholderCover />
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

                  <div className="mt-4 pt-3 border-t border-white/5 flex flex-col items-start gap-1.5">
                    {/* A documented relation is named only for a sourced link; an inferred one
                        says so in words, not by colour alone. The neutral badge's text is raised
                        to secondary: on a hovered card its chip grey is under 4.5:1. */}
                    <Badge
                      variant={rec.relation.link?.kind === 'sourced' ? 'sourced' : 'neutral'}
                      glow={rec.relation.link?.kind === 'sourced'}
                      data-link-kind={rec.relation.link?.kind ?? 'none'}
                    >
                      <span
                        className={
                          rec.relation.link?.kind === 'sourced' ? undefined : 'text-text-secondary'
                        }
                      >
                        <span className="font-bold">LOGIC:</span> {rec.relation.text}
                      </span>
                    </Badge>
                    {rec.sentence && (
                      <p data-link-relation className="text-chrome font-mono text-text-secondary">
                        {rec.sentence}
                      </p>
                    )}
                    {rec.provenance && (
                      <p data-link-provenance className="text-chrome font-mono text-text-chip">
                        {rec.provenance}
                      </p>
                    )}
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
            className="text-xs font-mono font-bold text-cyber uppercase tracking-widest hover:text-white transition-colors focus-visible:ring-2 focus-visible:ring-cyber/70 focus-visible:outline-none px-2 py-1"
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
