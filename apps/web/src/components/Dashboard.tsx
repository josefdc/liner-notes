import type React from 'react';
import { useState, useMemo, useCallback, useRef, Suspense } from 'react';
import { lazyWithRetry } from '../utils/lazyWithRetry';
import { ErrorBoundary } from './ErrorBoundary';
const SonicFingerprint = lazyWithRetry(() => import('./SonicFingerprint'));
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
import { isSpotifyTrackId } from '../utils/spotify';
import { isWholeRecording } from '../utils/recording';
import { audioReadings, fingerprintSubtitle, normalizeTrack } from '../constants';
import type { TrackRelation } from './genealogy/links';
import { nodeQuery, nodeTrack } from './genealogy/nodeTrack';
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
  /** The track's own title, from its node. */
  title: string;
  /** Its artist, from its node; null when the node does not name one (nothing is shown). */
  artist: string | null;
  relation: TrackRelation;
  /** The relation as a sentence naming both tracks (null when no link joins them). */
  sentence: string | null;
  /** Where the relation comes from (null when no link joins them). */
  provenance: string | null;
  /** The chip of the link's kind, in the words and colours the graph's list uses (null: no link). */
  chip: 'sourced' | 'inferred' | 'unconfirmed' | null;
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
    .map(({ node, relation }) => {
      const track = nodeTrack(node);
      return {
        id: node.id,
        ...(node.spotifyId ? { spotifyId: node.spotifyId } : {}),
        // The text the Player searches the same node by (a node with nothing to search by is
        // not searched at all).
        query: nodeQuery(node),
        ...track,
        relation,
        sentence: relation.link ? reader.relationSentence(relation.link, nameOf) : null,
        provenance: relation.link ? reader.provenanceText(relation.link) : null,
        chip: relation.link ? reader.linkProvenanceKind(relation.link) : null,
        img: isValidImageUrl(node.img) ? node.img : null,
      };
    });
}

/**
 * A connected track's relation, as the badge of its card. A documented relation is named as
 * known only for a sourced link; otherwise it is hedged ("Possible sample"). The badge is the
 * link's provenance chip (sourced: amber and a book; a model inference: violet and sparkles; not
 * sourced: neutral), as in the graph's list; without a link it is a neutral badge. A neutral chip's text is raised to secondary: on a hovered card its
 * chip grey is under 4.5:1.
 */
const RelationBadge: React.FC<{ rec: RelatedTrack }> = ({ rec }) => {
  const relation = (
    <span
      className={
        rec.chip === 'sourced' || rec.chip === 'inferred' ? undefined : 'text-text-secondary'
      }
    >
      {rec.relation.text}
    </span>
  );
  // The label stays outside the chip, so the chip (icon and relation) fits the card on one line.
  return (
    <span
      data-link-kind={rec.relation.link?.kind ?? 'none'}
      className="flex max-w-full flex-wrap items-center gap-x-1.5 gap-y-1"
    >
      <span className="text-chrome font-mono font-bold uppercase tracking-widest text-text-secondary">
        Relation:
      </span>{' '}
      {rec.chip ? (
        <ProvenanceChip kind={rec.chip} glow={rec.chip === 'sourced'}>
          {relation}
        </ProvenanceChip>
      ) : (
        <Badge variant="neutral">{relation}</Badge>
      )}
    </span>
  );
};

const EMPTY_LOGS: AgentLog[] = [];

// A connected track without cover art (in its card's button: phrasing content only)
const PlaceholderCover: React.FC = () => (
  <span
    className="w-full h-full flex items-center justify-center"
    style={{ background: placeholderBackground }}
  >
    <Music size={48} data-placeholder-note style={{ color: PLACEHOLDER_NOTE.color }} />
  </span>
);

const Dashboard: React.FC<DashboardProps> = ({
  trackData: rawTrackData,
  onNavigate,
  onAnalyzeTrack,
  logs = EMPTY_LOGS,
  isComplete = true,
  onNewSearch,
  headingRef,
  isRestoredSession = false,
}) => {
  // The Sonic Fingerprint panel: takes the focus after its chart's "Try again".
  const fingerprintRef = useRef<HTMLElement>(null);
  const focusFingerprint = useCallback(
    () => fingerprintRef.current?.focus({ preventScroll: true }),
    [],
  );
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
  // Relations left out because the verifier rejected their claim (or it cannot be read).
  const hiddenLinks = (trackData?.genealogy.links ?? []).filter(
    (link) =>
      typeof link === 'object' && link !== null && shown?.claims.isHidden(link.claimId) === true,
  ).length;
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

  const handleCardClick = useCallback(
    (rec: { spotifyId?: string; query: string }) => {
      if (onAnalyzeTrack) {
        if (!rec.query) return;
        // The node's own id is the graph's, not Spotify's: the track is searched by its text
        // unless the node was matched to a Spotify track. The text is the node's track title
        // and artist, which the matched track's own title and artist match.
        onAnalyzeTrack(rec.spotifyId ?? 'search', rec.query, '');
      } else {
        onNavigate(AppPhase.PLAYER);
      }
    },
    [onAnalyzeTrack, onNavigate],
  );

  return (
    <div className="h-full w-full p-(--space-md) md:p-(--space-2xl) flex flex-col gap-(--space-xl) md:gap-(--space-2xl) overflow-y-auto overflow-x-hidden pb-20 md:pb-10">
      {/* Top Bar (P0:3 — New Search button, P0:5 — removed date slider). The page's h1 is the
          track's title, in the hero below; without a result it says so here. */}
      <header
        className={`flex flex-col md:flex-row items-start md:items-center gap-4 animate-stagger-in stagger-1 ${trackData ? 'md:justify-end' : 'justify-between'}`}
      >
        {!trackData && (
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-medium tracking-tight text-white focus-visible:outline-hidden"
          >
            No analysis loaded
          </h1>
        )}
        {onNewSearch && (
          <Button variant="ghost" size="sm" leftIcon={<Search size={14} />} onClick={onNewSearch}>
            New search
          </Button>
        )}
      </header>

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
                <span className="text-chrome font-mono text-text-tertiary uppercase tracking-widest">
                  Analyzed track
                </span>
                <div className="w-1.5 h-1.5 rounded-full bg-white/30"></div>
              </div>

              <h1
                ref={headingRef}
                tabIndex={-1}
                className="text-2xl md:text-4xl font-bold text-white tracking-tight mb-1 focus-visible:outline-hidden"
              >
                {trackData.title}
              </h1>
              <p className="text-lg text-text-tertiary font-mono mb-1">{trackData.artist}</p>
              {/* Centred under the title on phones, as the rows above and below it */}
              {trackData.album && (
                <div className="flex flex-wrap items-center justify-center md:justify-start gap-2 mb-4 text-sm text-text-tertiary">
                  <span>{trackData.album}</span>
                  {trackData.releaseYear && (
                    <>
                      <span className="text-text-tertiary">•</span>
                      <span>{trackData.releaseYear}</span>
                    </>
                  )}
                  {trackData.explicit && <Badge variant="neutral">Explicit</Badge>}
                </div>
              )}

              {/* Audio values: measured, model scores, or "not measured". Compact: each value
                  with a chip of its kind, its provenance behind the chip (the Player shows a
                  short label, the same lines behind "How this was measured") */}
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
                  View full analysis
                </Button>
                {trackData.spotifyUrl && (
                  <a
                    href={trackData.spotifyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 px-6 py-2.5 bg-spotify/10 border border-spotify/30 text-spotify font-mono text-sm tracking-widest uppercase hover:bg-spotify/20 hover:border-spotify/50 hover:shadow-glow-spotify-subtle active:scale-[0.97] transition-all duration-(--duration-fast) ease-out-expo rounded-sm focus-visible:ring-2 focus-visible:ring-spotify/70 focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-hidden"
                  >
                    <ExternalLink size={14} />
                    Spotify
                  </a>
                )}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* A replayed result says it is a recording after the hero that holds its title (the h1
          the focus lands on): reading on from the title reaches it, before the panels below */}
      {trackData && <RecordedRunNotice track={trackData} />}

      {/* What this result is missing, named (model unavailable, audio not measured) */}
      {trackData && <ResultNotices track={trackData} />}

      {/* Main Grid (P2:17 — stagger animations). It fills spare height but never shrinks below its
          content, and the hero above never shrinks: the page scrolls instead of clipping them. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 forced-colors:lg:grid-rows-[auto_1fr]">
        {/* Hero: Sonic Fingerprint. It takes the focus by script; in forced-colors mode it shows
            it with an outline 4px outside it. From lg it stretches to its row, and the row can be
            taller than the screen above the footer (at 1440×900 the open activity log makes it
            901px, in an 875px view), so no scroll showed the whole outline. In that mode the grid
            has two rows and the connected tracks' column beside it spans both (its own class), so
            the panel's row is as tall as its content: it still stretches to it (its chart sizes to
            that height), and never hides any of it. A focus scroll leaves 8px beyond it (Chrome's
            scroll lands up to 1px past the margin), so the outline stays in view wherever the
            content fits. */}
        <section
          ref={fingerprintRef}
          tabIndex={-1}
          aria-label="Sonic Fingerprint"
          className="focus-visible:outline-hidden focus-visible:border-cyber/70 forced-colors:scroll-my-2 lg:col-span-1 bg-surface border border-border rounded-md p-6 flex flex-col relative overflow-hidden group hover:border-cyber/30 transition-colors animate-stagger-in stagger-3"
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
            {/* A chart that cannot be loaded or drawn says so in its place, with a retry: the
                rest of the Dashboard stays, and its heading keeps the focus. After the retry,
                the panel takes the focus from the button that is gone. */}
            <ErrorBoundary
              resetKey={trackData?.id}
              message="The Sonic Fingerprint could not be drawn"
              action={{ label: 'Try again' }}
              loadFailedMessage="The Sonic Fingerprint could not be loaded"
              focusOnFail={false}
              onRetried={focusFingerprint}
              // A reload shows this result again only from its address, which only a result
              // under a Spotify track id has (App.tsx, addressOf): for any other, it would lose
              // the whole result for one chart, so it is not offered.
              offersReload={isSpotifyTrackId(trackData?.id)}
              className="w-full h-full"
            >
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
            </ErrorBoundary>
          </div>
          {/* Decorative BG */}
          <div className="absolute top-0 right-0 w-64 h-64 bg-cyber/5 blur-[100px] pointer-events-none"></div>
        </section>

        {/* Connected tracks from the genealogy (P2:17 — stagger) */}
        <div className="lg:col-span-2 flex flex-col gap-6 animate-stagger-in stagger-4 forced-colors:lg:row-span-2">
          {/* The count moves below the heading when the two do not fit side by side */}
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            <div>
              <h2 className="text-lg font-medium tracking-tight text-white">Connections</h2>
              <p className="text-chrome font-mono text-text-muted mt-0.5">
                {trackData?.modelUnavailable
                  ? 'From source data'
                  : 'From the genealogy graph — each card says whether its link is sourced, not sourced or a model inference'}
              </p>
            </div>
            {relatedTracks !== null && relatedTracks.length > 0 && (
              <span className="text-xs font-mono text-analog whitespace-nowrap">
                {/* What the cards show, out of how many connected tracks there are */}
                {relatedTracks.length < relatedCount
                  ? `${relatedTracks.length} of ${relatedCount} related tracks`
                  : `${relatedCount} related ${relatedCount === 1 ? 'track' : 'tracks'}`}
              </span>
            )}
          </div>

          {relatedTracks !== null && relatedTracks.length === 0 && (
            <p className="text-xs font-mono text-text-tertiary border border-dashed border-white/10 rounded-md p-4">
              {/* Relations were found, but every one was rejected */}
              {hiddenLinks > 0
                ? 'No connections to show.'
                : 'No connected tracks found for this song.'}
            </p>
          )}
          {relatedTracks === null && readerFailed && (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 text-xs font-mono text-text-tertiary border border-dashed border-white/10 rounded-md p-4"
            >
              <span>Connected tracks could not be loaded.</span>
              <Button variant="ghost" size="sm" onClick={retryReader}>
                Try again
              </Button>
            </div>
          )}

          {/* Busy while the link reader loads: the cards follow once their relations are read */}
          <div
            aria-busy={relatedTracks === null && !readerFailed}
            className="flex gap-(--space-lg) overflow-x-auto pb-4 scrollbar-hide pt-2 pl-2 overscroll-contain"
          >
            {(relatedTracks ?? []).map((rec, index) => (
              // A button, so Enter and Space press it; what it holds is phrasing content only
              // (spans laid out as the blocks they stand for).
              <button
                type="button"
                key={rec.id}
                onClick={() => handleCardClick(rec)}
                onMouseEnter={() => setHoveredCardId(rec.id)}
                onMouseLeave={() => setHoveredCardId(null)}
                data-hovered={hoveredCardId === rec.id || undefined}
                className="relative flex flex-col w-[280px] shrink-0 rounded-md text-start cursor-pointer group focus-visible:ring-2 focus-visible:ring-cyber/70 focus-visible:ring-offset-2 focus-visible:ring-offset-void focus-visible:outline-hidden animate-fade-in-up opacity-0"
                style={{
                  animationDelay: `${index * 80}ms`,
                  animationFillMode: 'forwards',
                }}
              >
                {/* The card lifts inside a box that stays put, so a pointer near its bottom edge
                    does not drop the hover the lift itself causes. */}
                <span className="block h-full bg-void border border-border p-4 rounded-md group-hover:border-cyber/30 group-hover:bg-surface-hover group-hover:-translate-y-1 group-hover:shadow-glow-cyber-subtle transition-[translate,box-shadow,border-color,background-color] duration-(--duration-normal) ease-out-expo">
                  <span className="block relative aspect-square rounded-md overflow-hidden mb-4 bg-void-lighter">
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
                  </span>

                  <span className="block space-y-1">
                    <span data-card-title className="block font-semibold text-white truncate">
                      {rec.title}
                    </span>
                    {rec.artist && (
                      <span data-card-artist className="block text-sm text-text-tertiary truncate">
                        {rec.artist}
                      </span>
                    )}
                  </span>

                  <span className="mt-4 pt-3 border-t border-white/5 flex flex-col items-start gap-1.5">
                    <RelationBadge rec={rec} />
                    {rec.sentence && (
                      <span
                        data-link-relation
                        className="block text-chrome font-mono text-text-secondary"
                      >
                        {rec.sentence}
                      </span>
                    )}
                    {rec.provenance && (
                      <span
                        data-link-provenance
                        className="block text-chrome font-mono text-text-chip"
                      >
                        {rec.provenance}
                      </span>
                    )}
                  </span>
                </span>
              </button>
            ))}
          </div>

          {/* Agent Activity Log - Collapsible (P2:17 — stagger) */}
          {!isRestoredSession && (
            <div className="animate-stagger-in stagger-5">
              <ActivityLog
                logs={logs}
                isComplete={isComplete}
                recorded={isWholeRecording(trackData?.run)}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
