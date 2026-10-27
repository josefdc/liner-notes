import type React from 'react';
import { useState, useCallback, useId, useMemo, useRef, useEffect } from 'react';
import {
  ArrowLeft,
  Play,
  Pause,
  ExternalLink,
  Search,
  ChevronDown,
  Lock,
  LockOpen,
} from 'lucide-react';
import {
  audioReadings,
  audioValues,
  displayableFactoids,
  formatBpm,
  formatSeconds,
  measuredAudioOf,
  measuredKeyMoments,
  noKeyMomentsReason,
  FACTOID_UNAVAILABLE_TEXT,
  normalizeTrack,
  recordingOf,
} from '../constants';
import { resultModeOf } from '../utils/recording';
import SmartTimeline from './SmartTimeline';
import GenealogyGraph from './GenealogyGraph';
import { kindLabel, linkContext, shownLinks } from './genealogy/links';
import InteractiveFactoid from './InteractiveFactoid';
import {
  AudioStats,
  InferenceLabel,
  RecordedRunNotice,
  ResultNotices,
  ResultOriginLabel,
} from './EstimatedWarning';
import { AlbumCover, useAlbumCover } from './AlbumCover';
import { Badge } from './ui/Badge';
import { Button } from './ui/Button';
import { resultClaims, type ShownClaim, withoutHiddenRelations } from './provenance/claims';
import { ClaimList } from './provenance/ClaimList';
import { CreditsList } from './provenance/CreditsList';
import { RejectedClaims } from './provenance/RejectedClaims';
import { ProvenanceChip } from './provenance/ProvenanceChip';
import { moreFactsOf } from '../hooks/agent/moreFacts';
import type { MoreFacts, MoreFactsOptions, ResultMode } from '../hooks/agent/types';
import type { TrackData, Factoid, FactoidUnavailableCode, GenealogyNode } from '../types';

interface PlayerProps {
  trackData: TrackData | null;
  onBack: () => void;
  /** The facts "more facts" added so far, with their claims (useAgent's `moreFacts`). */
  moreFacts?: MoreFacts | null;
  /**
   * Asks for the next round of facts about the result (useAgent's `moreFactoidsStream`) and
   * resolves with the facts it added. Aborting `options.signal` closes the stream and rejects
   * with an AbortError.
   */
  onMoreFactoidsStream?: (result: TrackData, options?: MoreFactsOptions) => Promise<Factoid[]>;
  // Callback for navigating to a new track from genealogy graph
  onAnalyzeTrack?: (trackId: string, title: string, artist: string) => void;
  // P0:3 — New search callback
  onNewSearch?: () => void;
  // UX: Focus management on phase transition
  headingRef?: React.Ref<HTMLHeadingElement>;
}

// ─── P2:24 Default visible factoids count ───────────────────────────────────
const INITIAL_VISIBLE_FACTOIDS = 3;

// The card a result built without the model writes from the audio measurement, not from a
// source record (apps/api/src/agent/fallback.ts).
const MEASUREMENT_CARD_TITLES = new Set(['sonic profile']);
const isMeasurementCard = (factoid: Factoid) =>
  MEASUREMENT_CARD_TITLES.has(factoid.title.trim().toLowerCase());

/** Shown when there is no analysis to display: never a demo track in its place. */
const NoAnalysis: React.FC<Pick<PlayerProps, 'onBack' | 'onNewSearch' | 'headingRef'>> = ({
  onBack,
  onNewSearch,
  headingRef,
}) => (
  <div className="h-full w-full flex flex-col items-center justify-center gap-4 bg-void p-6 text-center">
    <h1
      ref={headingRef}
      tabIndex={-1}
      className="text-xl font-light text-white tracking-tight outline-none"
    >
      No analysis loaded
    </h1>
    <p className="text-xs font-mono text-text-tertiary">Search for a song to see its analysis.</p>
    <div className="flex items-center gap-3">
      <Button variant="ghost" size="sm" leftIcon={<ArrowLeft size={14} />} onClick={onBack}>
        BACK TO BASE
      </Button>
      {onNewSearch && (
        <Button variant="ghost" size="sm" leftIcon={<Search size={12} />} onClick={onNewSearch}>
          NEW SEARCH
        </Button>
      )}
    </div>
  </div>
);

const PlayerView: React.FC<Omit<PlayerProps, 'trackData'> & { track: TrackData }> = ({
  track,
  onBack,
  moreFacts,
  onMoreFactoidsStream,
  onAnalyzeTrack,
  onNewSearch,
  headingRef,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeTab, setActiveTab] = useState<'context' | 'player' | 'genealogy'>('player');
  const [isDecrypting, setIsDecrypting] = useState(false);
  // Why DECRYPT MORE could not add facts (rate limit, budget), shown under the button
  const [decryptUnavailable, setDecryptUnavailable] = useState<FactoidUnavailableCode | null>(null);
  // P3:25 — Decrypt complete toast
  const [showDecryptToast, setShowDecryptToast] = useState(false);
  const [decryptToastCount, setDecryptToastCount] = useState(0);
  // P2:24 — Factoid collapsing
  const [showAllFactoids, setShowAllFactoids] = useState(false);

  // P0:7 — Audio preview ref
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const { bpm, key } = audioValues(track);
  // The measured preview window, when the result carries its measurement.
  const cover = useAlbumCover(track.coverUrl);
  const measurement = useMemo(() => measuredAudioOf(track), [track]);
  // Key moments only where the audio was measured; otherwise why there are none.
  const noMomentsReason = useMemo(() => noKeyMomentsReason(track), [track]);
  const keyMoments = useMemo(() => measuredKeyMoments(track), [track]);
  // Written by the model, or taken from source data when the model was unavailable.
  const fromSourceData = Boolean(track.modelUnavailable);
  // What "more facts" added to this result, and whether a round is left to ask for.
  const more = useMemo(() => moreFactsOf(track, moreFacts ?? null), [track, moreFacts]);
  // The result's claims and those of the facts "more facts" added, each with how it is shown;
  // the ones the verifier rejected are listed apart and leave the main view, with the factoid
  // cards, samples and genealogy relations that state them (and those whose claim this page
  // cannot read).
  const claims = useMemo(
    () => resultClaims(track, Object.values(more.claims)),
    [track, more.claims],
  );
  const readings = useMemo(() => audioReadings(track).signal, [track]);
  const claimOf = useCallback(
    (factoid: Factoid): ShownClaim | undefined =>
      factoid.claimId ? claims.byId.get(factoid.claimId) : undefined,
    [claims],
  );
  const addedFactoids = useMemo(() => displayableFactoids(more.factoids), [more.factoids]);
  // The result's factoids, then the ones "more facts" added, each once: a card whose id was
  // shown already is a repeat, and is left out with the cards whose claim is hidden.
  const [resultFactoids, additionalFactoids] = useMemo(() => {
    const seen = new Set<string>();
    const shownOnce = (factoid: Factoid) => {
      if (claims.isHidden(factoid.claimId) || seen.has(factoid.id)) return false;
      seen.add(factoid.id);
      return true;
    };
    return [track.factoids.filter(shownOnce), addedFactoids.filter(shownOnce)];
  }, [track.factoids, addedFactoids, claims]);
  // Cards left out because the claim they state cannot be read (not rejected: those are listed),
  // each once by id.
  const unreadableCards = new Set(
    [...track.factoids, ...addedFactoids]
      .filter(
        (factoid) => claims.isUnreadable(factoid.claimId) && !claims.isRejected(factoid.claimId),
      )
      .map((factoid) => factoid.id),
  ).size;
  const genealogy = useMemo(
    () => withoutHiddenRelations(track.genealogy, claims.isHidden),
    [track.genealogy, claims],
  );
  // Relations left out because their claim is hidden, said under the graph's legend (entries
  // that are not links at all are not counted: they had no claim to hide).
  const hiddenLinks = track.genealogy.links.filter(
    (link) => typeof link === 'object' && link !== null && claims.isHidden(link.claimId),
  ).length;
  // How the shown links are known: the panel's label says "model inference" only when every one
  // is the model's (each link says its own kind in the graph, its legend and its list).
  const linkKinds = useMemo(() => {
    const context = linkContext(track.evidence, claims, { releaseYear: track.releaseYear });
    const links = shownLinks(genealogy, context);
    return {
      sourced: links.some((link) => link.kind === 'sourced'),
      inferred: links.some((link) => link.kind !== 'sourced'),
      notSourced: links.some((link) => kindLabel(link) === 'Not sourced'),
    };
  }, [genealogy, track.evidence, track.releaseYear, claims]);
  // Cards without a claim of their own are labelled by their section, or each on its own when
  // the cards beside it carry claims.
  const unclaimedFactoids = resultFactoids.some((factoid) => !claimOf(factoid));
  const claimedFactoids = resultFactoids.some((factoid) => claimOf(factoid));
  // A result built without the model: its facts name no record. A card written from the audio
  // measurement says so instead of being counted with them.
  const fallbackNote = useMemo(() => {
    if (!track.modelUnavailable) return null;
    const unclaimed = resultFactoids.filter((factoid) => !claimOf(factoid));
    const fromRecords = unclaimed.filter((factoid) => !isMeasurementCard(factoid));
    const fromMeasurement = unclaimed.filter(isMeasurementCard);
    const parts = [
      fromRecords.length > 0
        ? 'No citations: the facts taken from source records do not link to them.'
        : null,
      ...fromMeasurement.map(
        (factoid) => `"${factoid.title}" is written from the audio measurement.`,
      ),
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(' ') : null;
  }, [track.modelUnavailable, resultFactoids, claimOf]);
  const samples = useMemo(
    () => track.samples.filter((sample) => !claims.isHidden(sample.claimId)),
    [track.samples, claims],
  );
  // The result's factoids first, then the ones added by DECRYPT MORE.
  const allFactoids = useMemo(
    () => [...resultFactoids, ...additionalFactoids],
    [resultFactoids, additionalFactoids],
  );
  // Claims a card shows are not listed again, as credits or as other claims.
  const onCards = useMemo(
    () => new Set(allFactoids.map((factoid) => factoid.claimId)),
    [allFactoids],
  );
  const creditClaims = useMemo(
    () =>
      claims.shown.filter(
        (shown) => shown.claim.about === 'credit' && !onCards.has(shown.claim.id),
      ),
    [claims, onCards],
  );
  const creditsOnCards = claims.shown.filter(
    (shown) => shown.claim.about === 'credit' && onCards.has(shown.claim.id),
  ).length;
  // Claims no card or credit shows.
  const otherClaims = useMemo(
    () =>
      claims.shown.filter(
        (shown) => shown.claim.about !== 'credit' && !onCards.has(shown.claim.id),
      ),
    [claims, onCards],
  );
  // How the result was produced: more facts stay on that side (recorded, or live).
  const resultMode: ResultMode | undefined = resultModeOf(track.run);
  const recorded = recordingOf(track) !== null;
  // DECRYPT MORE on a replayed result found no recorded fact that is not shown yet.
  const [noMoreRecorded, setNoMoreRecorded] = useState(false);
  const noMoreRoundsId = useId();
  // Facts DECRYPT MORE added are written by the model: each shows its own claim, and when one
  // does, the others are labelled one by one rather than as a section.
  const claimedAdditional = additionalFactoids.some((factoid) => claimOf(factoid));

  // P2:24 — Visible factoids, split by where they come from so each part carries its label
  const visibleFactoids = showAllFactoids
    ? allFactoids
    : allFactoids.slice(0, INITIAL_VISIBLE_FACTOIDS);
  const visibleResultFactoids = visibleFactoids.slice(0, resultFactoids.length);
  const visibleDecryptedFactoids = visibleFactoids.slice(resultFactoids.length);
  const hiddenCount = allFactoids.length - INITIAL_VISIBLE_FACTOIDS;

  // Refs for transient values in handleDecryptMore
  const isDecryptingRef = useRef(false);
  // The running DECRYPT MORE stream; closed when the Player goes away.
  const decryptControllerRef = useRef<AbortController | null>(null);
  // The timer that hides the toast; cleared when another toast replaces it or the Player goes.
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      decryptControllerRef.current?.abort();
      decryptControllerRef.current = null;
      isDecryptingRef.current = false;
      if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    };
  }, []);

  // UX: Escape key shortcut to go back
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onBack();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onBack]);

  // P0:7 — Initialize and cleanup audio element
  useEffect(() => {
    audioRef.current = new Audio();
    audioRef.current.volume = 0.5;

    const audio = audioRef.current;
    audio.onplay = () => setIsPlaying(true);
    audio.onpause = () => setIsPlaying(false);
    audio.onended = () => setIsPlaying(false);
    audio.onerror = () => setIsPlaying(false);

    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  // P0:7 — Toggle audio playback
  const handlePlayPause = useCallback(() => {
    if (!audioRef.current || !track.previewUrl) return;

    if (isPlaying) {
      audioRef.current.pause();
    } else {
      if (audioRef.current.src !== track.previewUrl) {
        audioRef.current.src = track.previewUrl;
      }
      audioRef.current.play().catch((err) => {
        console.log('Audio preview blocked:', err);
        setIsPlaying(false);
      });
    }
  }, [isPlaying, track.previewUrl]);

  // Handle decrypt more factoids - streams one-by-one for faster perceived speed
  const handleDecryptMore = useCallback(async () => {
    if (!onMoreFactoidsStream || isDecryptingRef.current) return;

    isDecryptingRef.current = true;
    setIsDecrypting(true);
    setDecryptUnavailable(null);
    setNoMoreRecorded(false);
    let unavailable = false;
    const controller = new AbortController();
    decryptControllerRef.current = controller;
    try {
      // The facts are kept by the hook as they come (`moreFacts`), with their claims.
      const added = await onMoreFactoidsStream(track, {
        signal: controller.signal,
        onUnavailable: (code) => {
          unavailable = true;
          setDecryptUnavailable(code);
        },
      });
      // Only factoids that are shown count (lyric factoids are dropped).
      const newCount = displayableFactoids(added).length;
      if (resultMode === 'replay' && newCount === 0 && !unavailable) setNoMoreRecorded(true);

      // P3:25 — Show completion toast
      if (newCount > 0) {
        setDecryptToastCount(newCount);
        setShowDecryptToast(true);
        if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => {
          toastTimerRef.current = null;
          setShowDecryptToast(false);
        }, 1000);
      }
    } catch (error) {
      // Leaving the Player (or starting a new analysis) cancels the stream: not an error.
      if ((error as { name?: unknown } | null)?.name !== 'AbortError') {
        console.error('Decrypt stream error:', error);
      }
    } finally {
      if (decryptControllerRef.current === controller) {
        decryptControllerRef.current = null;
        isDecryptingRef.current = false;
        setIsDecrypting(false);
      }
    }
  }, [onMoreFactoidsStream, track, resultMode]);

  // Extract onNodeClick handler for GenealogyGraph (stable ref for React.memo)
  const handleNodeClick = useCallback(
    (node: GenealogyNode) => {
      if (!onAnalyzeTrack) return;
      const title = node.trackTitle || node.label.split(' - ')[0] || node.label;
      const artist =
        node.trackArtist || node.label.split(' - ')[1]?.replace(/\s*\(\d{4}\)$/, '') || '';
      const trackId = node.spotifyId || 'search';
      onAnalyzeTrack(trackId, title, artist);
    },
    [onAnalyzeTrack],
  );

  const tabIds = {
    context: 'panel-context',
    player: 'panel-player',
    genealogy: 'panel-genealogy',
  } as const;

  return (
    <div className="h-full w-full flex flex-col bg-void relative overflow-hidden">
      {/* Background Atmosphere */}
      {cover.src && (
        <img
          src={cover.src}
          alt=""
          onError={cover.onError}
          referrerPolicy="no-referrer"
          className="absolute inset-0 w-full h-full object-cover opacity-10 blur-3xl scale-110 pointer-events-none"
        />
      )}

      {/* Navigation (P0:3 — New Search button) */}
      <div className="z-20 px-6 py-4 flex items-center justify-between border-b border-white/5 bg-void/50 backdrop-blur-sm">
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="sm" leftIcon={<ArrowLeft size={14} />} onClick={onBack}>
            BACK TO BASE
            <span className="hidden lg:inline text-text-muted text-chrome ml-1">Esc</span>
          </Button>
          {onNewSearch && (
            <Button variant="ghost" size="sm" leftIcon={<Search size={12} />} onClick={onNewSearch}>
              NEW SEARCH
            </Button>
          )}
        </div>
        <div className="hidden md:flex items-center gap-3 text-xs font-mono text-cyber">
          <span>
            DEEP_DIVE_MODE {'//'} {bpm !== null ? `${formatBpm(bpm)} BPM` : 'BPM not measured'}
            {key !== null && ` // ${key}`}
            {measurement && ` // ${formatSeconds(measurement.windowSeconds)} s preview`}
          </span>
        </div>
      </div>

      {/* On phones only one panel shows at a time: the recording label stays above all of them */}
      {recorded && (
        <div className="md:hidden z-20 mx-4 mt-2">
          <RecordedRunNotice track={track} compact />
        </div>
      )}

      {/* Main Content Triptych */}
      <div className="flex-1 relative z-10 flex flex-col md:flex-row overflow-hidden">
        {/* Panel A: Context (Desktop: Left, Mobile: Tab) — P1:12 ARIA */}
        <div
          id={tabIds.context}
          role="tabpanel"
          aria-labelledby="tab-context"
          className={`
            md:w-1/4 p-6 border-r border-white/5 bg-black/25 backdrop-blur-sm overflow-y-auto overscroll-contain
            ${activeTab === 'context' ? 'block absolute inset-0 md:static z-20 bg-void md:bg-transparent' : 'hidden md:block'}
        `}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
            <h3 className="text-xs font-mono text-text-tertiary uppercase tracking-widest">
              Agent Analysis
            </h3>
            {unclaimedFactoids && !claimedFactoids && (
              <ResultOriginLabel fromSourceData={fromSourceData} />
            )}
          </div>
          {/* Facts built without the model name no record they were taken from */}
          {fallbackNote && (
            <p className="text-chrome font-mono text-text-chip mb-2">{fallbackNote}</p>
          )}
          {unreadableCards > 0 && (
            <p className="text-chrome font-mono text-text-chip mb-2">
              {unreadableCards === 1
                ? '1 fact is not shown: this page cannot read the claim it states.'
                : `${unreadableCards} facts are not shown: this page cannot read the claims they state.`}
            </p>
          )}
          {allFactoids.length > 0 && (
            <p className="text-xs text-text-tertiary font-mono mb-8">
              {allFactoids.length} insights decoded
            </p>
          )}
          {allFactoids.length === 0 ? (
            <div className="flex-1 flex items-center justify-center py-12">
              <p className="text-text-tertiary text-xs font-mono text-center">
                AWAITING INTEL... No insights decoded for this track.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {visibleResultFactoids.map((fact, idx) => (
                <div key={fact.id} className={`stagger-${Math.min(idx + 1, 8)}`}>
                  <InteractiveFactoid
                    factoid={fact}
                    claim={claimOf(fact)}
                    origin={claimedFactoids ? (fromSourceData ? 'record' : 'inferred') : undefined}
                    fromSourceData={fromSourceData}
                    readings={readings}
                    audio={measurement}
                  />
                </div>
              ))}

              {/* Factoids added by DECRYPT MORE are written by the model, whatever the result:
                  each shows its claim, and the section is labelled only when none has one */}
              {visibleDecryptedFactoids.length > 0 && (
                <section aria-label="Decrypted insights" className="space-y-6">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-xs font-mono text-text-tertiary uppercase tracking-widest">
                      Decrypted insights
                    </h4>
                    {!claimedAdditional && <InferenceLabel />}
                  </div>
                  {visibleDecryptedFactoids.map((fact) => (
                    <InteractiveFactoid
                      key={fact.id}
                      factoid={fact}
                      claim={claimOf(fact)}
                      origin={claimedAdditional ? 'inferred' : undefined}
                      readings={readings}
                      audio={measurement}
                    />
                  ))}
                </section>
              )}

              {/* Standalone Decrypt More card */}
              {onMoreFactoidsStream && (
                <button
                  type="button"
                  onClick={handleDecryptMore}
                  // Once every round has been asked, another click would bring nothing new.
                  disabled={isDecrypting || more.finished}
                  aria-describedby={more.finished ? noMoreRoundsId : undefined}
                  className={`w-full flex items-center justify-center gap-2 py-3 px-4
                               border border-dashed border-cyber/30 rounded-md
                               text-xs font-mono text-cyber/70 uppercase tracking-wider
                               hover:border-cyber hover:text-cyber hover:bg-cyber/5
                               focus-visible:ring-2 focus-visible:ring-cyber/70 focus-visible:outline-none
                               disabled:opacity-50
                               ${more.finished ? 'disabled:cursor-not-allowed' : 'disabled:cursor-wait'}
                               transition-all duration-(--duration-fast)`}
                >
                  {isDecrypting ? (
                    <>
                      <Lock size={12} className="animate-pulse" />
                      DECRYPTING...
                    </>
                  ) : (
                    <>
                      <LockOpen size={12} />[ DECRYPT MORE ]
                    </>
                  )}
                </button>
              )}
              {decryptUnavailable && (
                <p role="status" className="text-xs font-mono text-text-tertiary">
                  More facts unavailable: {FACTOID_UNAVAILABLE_TEXT[decryptUnavailable]}
                </p>
              )}
              {more.answerFailed && !decryptUnavailable && (
                <p role="status" className="text-xs font-mono text-text-tertiary">
                  More facts could not be written. Try again.
                </p>
              )}
              {more.failed.length > 0 && !decryptUnavailable && (
                <p role="status" className="text-xs font-mono text-text-tertiary">
                  {more.failed.length === 1
                    ? '1 fact could not be written.'
                    : `${more.failed.length} facts could not be written.`}
                </p>
              )}
              {more.finished && (
                <p
                  id={noMoreRoundsId}
                  role="status"
                  className="text-xs font-mono text-text-tertiary"
                >
                  No more facts: every angle on this track has been asked.
                </p>
              )}
              {noMoreRecorded && (
                <p role="status" className="text-xs font-mono text-text-tertiary">
                  No more facts: this result is a recording, and every fact recorded with it is
                  shown.
                </p>
              )}

              {/* Show more / collapse toggle */}
              {hiddenCount > 0 && !showAllFactoids && (
                <div className="relative">
                  {/* Gradient fade on boundary */}
                  <div className="absolute -top-12 left-0 right-0 h-12 bg-gradient-to-b from-transparent to-black/20 pointer-events-none" />
                  <button
                    type="button"
                    onClick={() => setShowAllFactoids(true)}
                    className="w-full flex items-center justify-center gap-2 py-2 text-xs font-mono text-text-tertiary hover:text-cyber focus-visible:ring-2 focus-visible:ring-cyber/70 focus-visible:outline-none transition-colors"
                  >
                    <ChevronDown size={14} />
                    Reveal {hiddenCount} hidden insights
                  </button>
                </div>
              )}
              {showAllFactoids && allFactoids.length > INITIAL_VISIBLE_FACTOIDS && (
                <button
                  type="button"
                  onClick={() => setShowAllFactoids(false)}
                  className="w-full flex items-center justify-center gap-2 py-2 text-xs font-mono text-text-tertiary hover:text-cyber transition-colors focus-visible:ring-2 focus-visible:ring-cyber/70 focus-visible:outline-none"
                >
                  <ChevronDown size={14} className="rotate-180" />
                  Show less
                </button>
              )}
            </div>
          )}

          {/* Credits, the claims no card shows, and the claims the verifier rejected */}
          <div className="mt-10 space-y-8">
            <CreditsList
              credits={creditClaims}
              onCards={creditsOnCards}
              uncited={track.credits}
              readings={readings}
              audio={measurement}
            />
            <ClaimList
              title="More claims"
              claims={otherClaims}
              readings={readings}
              audio={measurement}
            />
            <RejectedClaims
              rejected={claims.rejected}
              unreadable={claims.unreadableRejected}
              audio={measurement}
            />
          </div>

          {/* P3:25 — Decrypt complete toast */}
          {showDecryptToast && (
            <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-5 py-2.5 bg-cyber/10 border border-cyber/30 rounded-sm text-cyber text-xs font-mono tracking-widest animate-slide-up-fade shadow-glow-cyber-subtle">
              {decryptToastCount} NEW INTEL DECODED
            </div>
          )}
        </div>

        {/* Panel B: Artifact/Player (Desktop: Center, Mobile: Tab) — P1:12 ARIA */}
        <div
          id={tabIds.player}
          role="tabpanel"
          aria-labelledby="tab-player"
          className={`
            md:w-2/4 p-8 flex flex-col items-center justify-start relative overflow-y-auto overscroll-contain
            ${activeTab === 'player' ? 'block h-full' : 'hidden md:flex'}
        `}
        >
          {recorded && (
            <div className="hidden md:block w-full max-w-lg mb-4">
              <RecordedRunNotice track={track} />
            </div>
          )}
          <ResultNotices track={track} className="w-full max-w-lg mb-4" />

          {/* Album Art Container */}
          <AlbumCover
            cover={cover}
            album={track.album}
            evidence={track.evidence}
            className="mb-8 mt-4 flex-shrink-0 w-56 md:w-64 lg:w-80"
            frameClassName="group"
            surfaceClassName={`rounded-lg shadow-elevated-lg transition-all duration-(--duration-dramatic) ${isPlaying ? 'animate-pulse-slow' : ''} ${isPlaying && cover.src ? 'shadow-[var(--shadow-glow-cyber)]' : ''}`}
            iconSize={56}
          >
            <div className="absolute inset-0 bg-cyber/15 blur-3xl rounded-full opacity-0 group-hover:opacity-30 transition-opacity duration-(--duration-dramatic)"></div>
          </AlbumCover>

          {/* Meta */}
          <div className="text-center mb-6">
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="text-3xl md:text-4xl font-light leading-tight text-white tracking-tight mb-2 text-shadow-dark outline-none"
            >
              {track.title}
            </h1>
            <p className="text-lg text-text-tertiary font-mono">{track.artist}</p>
            {track.album && (
              <div className="flex items-center justify-center gap-2 text-sm text-text-tertiary mt-1">
                <span>{track.album}</span>
                {track.releaseYear && (
                  <>
                    <span className="text-text-tertiary">•</span>
                    <span>{track.releaseYear}</span>
                  </>
                )}
              </div>
            )}
            {/* Audio Stats: measured values, or "not measured" */}
            <AudioStats track={track} className="mt-3" />
            {/* Spotify Link */}
            {track.spotifyUrl && (
              <a
                href={track.spotifyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 mt-3 text-xs text-spotify hover:text-spotify transition-colors"
              >
                <ExternalLink size={12} />
                <span>Open in Spotify</span>
              </a>
            )}
          </div>

          {/* Controls (P0:4 — removed Plus/Share, P0:7 — real audio playback) */}
          <div className="flex items-center justify-center gap-8 mb-6">
            {track.previewUrl ? (
              <button
                type="button"
                onClick={handlePlayPause}
                className={`w-16 h-16 rounded-full bg-white text-black flex items-center justify-center hover:scale-105 hover:shadow-[var(--shadow-glow-white-hover)] hover:ring-2 hover:ring-white/20 active:scale-95 transition-all duration-(--duration-fast) ease-spring shadow-[var(--shadow-glow-white)] ${isPlaying ? 'animate-[glow-breathe-white_3s_ease-in-out_infinite]' : ''}`}
                aria-label={isPlaying ? 'Pause preview' : 'Play preview'}
              >
                {isPlaying ? (
                  <Pause size={28} fill="currentColor" />
                ) : (
                  <Play size={28} fill="currentColor" className="ml-1" />
                )}
              </button>
            ) : (
              <span className="text-xs font-mono text-text-tertiary px-3 py-1.5 border border-white/10 rounded">
                Preview unavailable
              </span>
            )}
          </div>

          {/* Smart Timeline with Key Moments */}
          <div className="w-full max-w-lg">
            <SmartTimeline
              segments={track.segments}
              segmentsSource={track.segmentsSource}
              durationSeconds={track.durationSeconds}
              samples={samples}
              keyMoments={keyMoments}
              audioAnalyzed={noMomentsReason === null}
              noMomentsReason={noMomentsReason}
              previewSeconds={measurement?.windowSeconds}
              beats={measurement?.beats}
              energyContour={measurement?.energyContour}
              measuredSections={measurement?.sections}
            />
          </div>
        </div>

        {/* Panel C: Genealogy (Desktop: Right, Mobile: Tab) — P1:12 ARIA */}
        <div
          id={tabIds.genealogy}
          role="tabpanel"
          aria-labelledby="tab-genealogy"
          // On phones the open panel covers the panels' area (absolute, so it has that area's
          // height for the graph); from md up it is one column of three.
          className={`
            md:w-1/4 border-l border-white/5 bg-black/25 backdrop-blur-sm md:relative
            ${activeTab === 'genealogy' ? 'block max-md:absolute max-md:inset-0 max-md:z-20 max-md:bg-void' : 'hidden md:block'}
        `}
        >
          <div className="absolute top-4 left-4 right-4 z-10 pointer-events-none flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-mono text-text-tertiary uppercase tracking-widest hidden md:block">
              Genealogy Network
            </h3>
            {/* How the shown links are known, in the words and chips the legend, the list and
                the connected-track cards use: sourced, not sourced, or (every link) the model's */}
            {genealogy.nodes.length > 1 && (
              <span data-testid="genealogy-kinds" className="inline-flex max-w-full">
                {linkKinds.sourced ? (
                  linkKinds.inferred ? (
                    <Badge variant="neutral">Sourced and not sourced links</Badge>
                  ) : (
                    <ProvenanceChip kind="sourced">Sourced links</ProvenanceChip>
                  )
                ) : linkKinds.notSourced ? (
                  // Not the model's: built from records whose evidence does not hold.
                  <ProvenanceChip kind="unconfirmed">Not sourced</ProvenanceChip>
                ) : (
                  <ResultOriginLabel fromSourceData={fromSourceData} />
                )}
              </span>
            )}
          </div>
          {genealogy.nodes.length > 1 ? (
            <GenealogyGraph
              data={genealogy}
              evidence={track.evidence}
              claims={claims}
              releaseYear={track.releaseYear}
              hiddenLinks={hiddenLinks}
              onNodeClick={handleNodeClick}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center h-full p-6">
              <p className="text-text-tertiary text-xs font-mono text-center">
                NO CONNECTIONS MAPPED. This track's network is still uncharted.
              </p>
            </div>
          )}
          <div className="absolute bottom-4 right-4 z-10 text-right pointer-events-none hidden md:block">
            <p className="text-chrome text-text-tertiary font-mono">D3.JS FORCE SIMULATION</p>
            <p className="text-chrome text-cyber font-mono">INTERACTIVE: ENABLED</p>
          </div>
        </div>
      </div>

      {/* Mobile Tab Bar (P1:12 — ARIA roles) */}
      <div
        role="tablist"
        aria-label="Player sections"
        className="md:hidden border-t border-white/5 bg-void/90 backdrop-blur-lg flex text-xs font-mono uppercase tracking-widest pb-[env(safe-area-inset-bottom)]"
      >
        <button
          type="button"
          role="tab"
          id="tab-context"
          aria-selected={activeTab === 'context'}
          aria-controls={tabIds.context}
          onClick={() => setActiveTab('context')}
          className={`flex-1 py-3 text-center focus-visible:border-t-2 focus-visible:border-cyber focus-visible:outline-none ${activeTab === 'context' ? 'text-cyber border-t-2 border-cyber' : 'text-text-tertiary'}`}
        >
          Analysis
        </button>
        <button
          type="button"
          role="tab"
          id="tab-player"
          aria-selected={activeTab === 'player'}
          aria-controls={tabIds.player}
          onClick={() => setActiveTab('player')}
          className={`flex-1 py-3 text-center focus-visible:border-t-2 focus-visible:border-cyber focus-visible:outline-none ${activeTab === 'player' ? 'text-white border-t-2 border-white' : 'text-text-tertiary'}`}
        >
          Player
        </button>
        <button
          type="button"
          role="tab"
          id="tab-genealogy"
          aria-selected={activeTab === 'genealogy'}
          aria-controls={tabIds.genealogy}
          onClick={() => setActiveTab('genealogy')}
          className={`flex-1 py-3 text-center focus-visible:border-t-2 focus-visible:border-cyber focus-visible:outline-none ${activeTab === 'genealogy' ? 'text-analog border-t-2 border-analog' : 'text-text-tertiary'}`}
        >
          Network
        </button>
      </div>
    </div>
  );
};

const Player: React.FC<PlayerProps> = ({ trackData, ...props }) => {
  // Missing lists default to empty so a partial result renders; memoised so the graph and
  // the factoid list keep their identity between renders.
  const track = useMemo(() => (trackData ? normalizeTrack(trackData) : null), [trackData]);
  return track ? <PlayerView track={track} {...props} /> : <NoAnalysis {...props} />;
};

export default Player;
