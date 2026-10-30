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
import { usePlayerLayout } from '../utils/layout';
import { useReducedMotion } from '../utils/motion';
import SmartTimeline from './SmartTimeline';
import GenealogyGraph from './GenealogyGraph';
import { ErrorBoundary } from './ErrorBoundary';
import { nodeName, nodesById, relationLabelsByClaim, yearFrom } from './genealogy/links';
import { nodeQuery } from './genealogy/nodeTrack';
import { LinkKindsChip, noConnectionsText, useConnections } from './genealogy/connections';
import { previewTracksOf } from './genealogy/previewTracks';
import InteractiveFactoid from './InteractiveFactoid';
import {
  AudioStats,
  InferenceLabel,
  RecordedRunNotice,
  ResultNotices,
  ResultOriginLabel,
} from './EstimatedWarning';
import { AlbumCover, useAlbumCover } from './AlbumCover';
import { Button } from './ui/Button';
import { resultClaims, type ShownClaim } from './provenance/claims';
import { ClaimList } from './provenance/ClaimList';
import { CreditsList } from './provenance/CreditsList';
import { linerNotes, relationLinkNotes } from './provenance/notes';
import { notPlacedNote, placeSamples } from './provenance/timelineSamples';
import { isRelationSubject, withDocumentedRelations } from './genealogy/relationWords';
import { RejectedClaims } from './provenance/RejectedClaims';
import { Attribution, shownProviders } from './provenance/Attribution';
import { closeOpen, escapeAction, tabKeyTarget } from './playerKeys';
import { moreFactsKey, moreFactsOf } from '../hooks/agent/moreFacts';
import { type PreviewEvents, usePreviewAudio } from '../hooks/usePreviewAudio';
import type { MoreFacts, MoreFactsOptions, ResultMode } from '../hooks/agent/types';
import type { TrackData, Factoid, FactoidUnavailableCode, GenealogyNode } from '../types';
import type { TrailView } from '../router/trail';
import { isPlainClick } from '../utils/plainClick';

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
  /**
   * Analyses a connected track chosen on the map (its detail panel's "Analyze this track"),
   * named as the map left it (`from`: here, the Player's map panel).
   */
  onAnalyzeTrack?: (trackId: string, title: string, artist: string, from?: TrailView) => void;
  /** The address of the result's full-size map (`/t/<id>/map`), when it has one. */
  mapHref?: string | null;
  /** Opens the full-size map in this page (a plain click on "Open the full map"). */
  onOpenMap?: () => void;
  /** The phone tab the Player opens on (one it had in this history entry). */
  initialTab?: string;
  /** Called with the phone tab opened, for the history entry to keep it. */
  onTabChange?: (tab: string) => void;
  // P0:3 — New search callback
  onNewSearch?: () => void;
  // UX: Focus management on phase transition
  headingRef?: React.Ref<HTMLHeadingElement>;
}

/** How long the "N more facts added" notice stays on screen. */
const ADDED_NOTICE_MS = 4000;

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
      className="text-xl font-light text-white tracking-tight focus-visible:outline-hidden"
    >
      No analysis loaded
    </h1>
    <p className="text-xs font-mono text-text-tertiary">Search for a song to see its analysis.</p>
    <div className="flex items-center gap-3">
      <Button variant="ghost" size="sm" leftIcon={<ArrowLeft size={14} />} onClick={onBack}>
        Back to summary
      </Button>
      {onNewSearch && (
        <Button variant="ghost" size="sm" leftIcon={<Search size={12} />} onClick={onNewSearch}>
          New search
        </Button>
      )}
    </div>
  </div>
);

/** "1 fact", "3 facts". */
const facts = (count: number) => `${count} ${count === 1 ? 'fact' : 'facts'}`;

type Tab = 'context' | 'player' | 'genealogy';
const isTab = (value: unknown): value is Tab =>
  value === 'context' || value === 'player' || value === 'genealogy';

/** The phone tabs, in their order: each names its panel, and its colour when it is open. */
const TABS: ReadonlyArray<{ id: Tab; label: string; panel: string; open: string }> = [
  { id: 'context', label: 'Analysis', panel: 'panel-context', open: 'text-cyber border-cyber' },
  { id: 'player', label: 'Player', panel: 'panel-player', open: 'text-white border-white' },
  {
    id: 'genealogy',
    label: 'Connections',
    panel: 'panel-genealogy',
    open: 'text-analog border-analog',
  },
];

const PlayerView: React.FC<Omit<PlayerProps, 'trackData'> & { track: TrackData }> = ({
  track,
  onBack,
  moreFacts,
  onMoreFactoidsStream,
  onAnalyzeTrack,
  onNewSearch,
  headingRef,
  mapHref,
  onOpenMap,
  initialTab,
  onTabChange,
}) => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeTab, setTab] = useState<Tab>(isTab(initialTab) ? initialTab : 'player');
  const setActiveTab = useCallback(
    (tab: Tab) => {
      setTab(tab);
      onTabChange?.(tab);
    },
    [onTabChange],
  );
  const [isDecrypting, setIsDecrypting] = useState(false);
  // Why "More facts" could not add facts (rate limit, budget), shown under the button
  const [decryptUnavailable, setDecryptUnavailable] = useState<FactoidUnavailableCode | null>(null);
  // P3:25 — The "N more facts added" notice
  const [showDecryptToast, setShowDecryptToast] = useState(false);
  const [decryptToastCount, setDecryptToastCount] = useState(0);
  // P2:24 — Factoid collapsing
  const [showAllFactoids, setShowAllFactoids] = useState(false);

  // P0:7 — The track's preview, through the page's one preview element: the genealogy graph's
  // previews use it too, so starting one stops the other.
  const previewEvents = useMemo<PreviewEvents>(() => {
    const stopped = () => setIsPlaying(false);
    return {
      onPlay: () => setIsPlaying(true),
      onPause: stopped,
      onEnded: stopped,
      onError: stopped,
      onStopped: stopped,
    };
  }, []);
  const preview = usePreviewAudio(previewEvents);

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
  // Claims the result left out because each states a fact a claim shown states, with its source:
  // facts were found, and are listed.
  const restatedFacts = (track.run?.verifier?.restated ?? 0) > 0;
  // Claims the notes list: facts were found, whether or not the result says how many cards it
  // left out (a stored result does not).
  const listedFacts = claims.all.length > 0;
  // Facts found but not shown: their claim was rejected or cannot be read.
  const hiddenFacts = [...track.factoids, ...addedFactoids].some((factoid) =>
    claims.isHidden(factoid.claimId),
  );
  // The relations the map shows, and how they are known: the panel's label says "model
  // inference" only when every one is the model's (each link says its own kind in the graph, its
  // legend and its list). Two links or fewer in all: the map is a compact row, and its panel (a
  // row of its own from md up) is as tall as its content.
  const {
    genealogy,
    hiddenLinks,
    graphLinks,
    sparse: sparseGenealogy,
    linkKinds,
  } = useConnections(track, claims);
  // A claim a shown link states is named as its link is, on a fact's card and in the claims
  // list: one set of words for one relation. A model claim about a relation records document is
  // named as their code-built claims are, never "Possible" (its own kind and verdict still show).
  const claimRelations = useMemo(
    () => withDocumentedRelations(relationLabelsByClaim(graphLinks), claims.all),
    [graphLinks, claims],
  );
  const relationOf = (fact: Factoid) => {
    const id = claimOf(fact)?.claim.id;
    return id === undefined ? undefined : claimRelations.get(id);
  };
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
  // The result's factoids first, then the ones added by "More facts".
  const allFactoids = useMemo(
    () => [...resultFactoids, ...additionalFactoids],
    [resultFactoids, additionalFactoids],
  );
  // Claims a card shows are not listed again, as credits or as other claims.
  const onCards = useMemo(
    () => new Set(allFactoids.map((factoid) => factoid.claimId)),
    [allFactoids],
  );
  // The liner notes below the cards: credits, samples and covers, history, then every other
  // claim, each section without the claims a card shows.
  const notes = useMemo(() => linerNotes(claims.shown, onCards), [claims, onCards]);
  // Whether the verifier rejected claims of a section (listed with the rejected claims): an
  // empty section then says so rather than that none were found.
  const rejectedAbout = (about: readonly string[]) =>
    claims.rejected.some((shown) => about.includes(shown.claim.about));
  // The providers whose data the page shows, each with a link back.
  const providers = useMemo(
    () =>
      shownProviders({
        track,
        claims,
        links: graphLinks,
        // The graph is drawn only with a related track; its preview buttons are these clips'.
        nodePreviews:
          genealogy.nodes.length > 1 ? previewTracksOf(genealogy).map((clip) => clip.url) : [],
        coverSrc: cover.src,
        factoids: resultFactoids,
      }),
    [track, claims, graphLinks, genealogy, cover.src, resultFactoids],
  );
  // The samples, covers, remixes and interpolations the graph draws that no claim about a sample
  // or cover states: listed with the claims, in the graph's words.
  const relationLinks = useMemo(() => {
    const nodes = nodesById(genealogy.nodes, yearFrom(track.releaseYear));
    return relationLinkNotes(graphLinks, (id) => nodeName(nodes.get(id), id));
  }, [graphLinks, genealogy.nodes, track.releaseYear]);
  // The timeline's samples no shown sample or cover claim states: those it draws are counted
  // when the section has nothing else to say; those it cannot draw (a time outside the song, an
  // unknown duration, no time) are listed, so a sample is never left out of view.
  const timelineSamples = useMemo(() => {
    const stated = (id: unknown) => {
      const shown = typeof id === 'string' ? claims.byId.get(id) : undefined;
      return shown !== undefined && !claims.isHidden(id) && isRelationSubject(shown.claim.about);
    };
    return placeSamples(
      samples.filter((sample) => !stated(sample.claimId)),
      track.durationSeconds,
    );
  }, [samples, claims, track.durationSeconds]);
  const relationNotes = useMemo(
    () => [...relationLinks, ...timelineSamples.notPlaced.map(notPlacedNote)],
    [relationLinks, timelineSamples],
  );
  // The Player's layout at this width: the panels are tab panels only while the tabs show.
  const layout = usePlayerLayout();
  const reducedMotion = useReducedMotion();
  const tabbed = layout === 'tabs';
  // A panel's tab panel role, named by its tab, while the tabs show (none from md up, where the
  // tabs are hidden and the panels are columns, each headed by its own heading).
  const panelRole = (tab: Tab) =>
    tabbed ? { role: 'tabpanel' as const, 'aria-labelledby': `tab-${tab}` } : {};
  // How the result was produced: more facts stay on that side (recorded, or live).
  const resultMode: ResultMode | undefined = resultModeOf(track.run);
  const recorded = recordingOf(track) !== null;
  // "More facts" on a replayed result found no recorded fact that is not shown yet.
  const [noMoreRecorded, setNoMoreRecorded] = useState(false);
  const noMoreRoundsId = useId();
  // Facts "More facts" added are written by the model: each shows its own claim, and when one
  // does, the others are labelled one by one rather than as a section.
  const claimedAdditional = additionalFactoids.some((factoid) => claimOf(factoid));

  // P2:24 — Visible factoids, split by where they come from so each part carries its label
  const visibleFactoids = showAllFactoids
    ? allFactoids
    : allFactoids.slice(0, INITIAL_VISIBLE_FACTOIDS);
  const visibleResultFactoids = visibleFactoids.slice(0, resultFactoids.length);
  const visibleDecryptedFactoids = visibleFactoids.slice(resultFactoids.length);
  const hiddenCount = allFactoids.length - INITIAL_VISIBLE_FACTOIDS;

  // A round that ended: the ids shown when it was asked for, the result it was asked about, and
  // whether the API said why it could add nothing. Each round carries its own, so a click that
  // starts the next round before this one is told does not change what this one counts. What it
  // added is told once its facts are in the list, as the facts newly shown there (not repeats,
  // nor facts whose claim is hidden).
  const [roundEnded, setRoundEnded] = useState<{
    unavailable: boolean;
    before: ReadonlySet<string>;
    result: string;
  } | null>(null);

  // Refs for transient values in handleDecryptMore
  const isDecryptingRef = useRef(false);
  // The running "More facts" stream; closed when the Player goes away.
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

  // Escape, scoped to the Player (playerKeys.ts): it closes what is open first, and goes back to
  // the summary only when nothing is; never from a text field or from outside the Player.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const action = escapeAction(event, root);
      if (action === 'none') return;
      event.preventDefault();
      // The key's target is where the focus is (the body when no element has it).
      if (action === 'close') {
        closeOpen(root, event.target instanceof Element ? event.target : document.activeElement);
      } else onBack();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onBack]);

  // P0:7 — Toggle audio playback
  const handlePlayPause = useCallback(() => {
    if (!track.previewUrl) return;

    if (isPlaying) {
      preview.pause();
    } else {
      preview.play(track.previewUrl, 0.5)?.catch((err) => {
        // A graph preview started meanwhile took the element over: nothing went wrong.
        if ((err as { name?: unknown } | null)?.name === 'AbortError') return;
        console.log('Audio preview blocked:', err);
        setIsPlaying(false);
      });
    }
  }, [isPlaying, track.previewUrl, preview]);

  // Handle decrypt more factoids - streams one-by-one for faster perceived speed
  const handleDecryptMore = useCallback(async () => {
    if (!onMoreFactoidsStream || isDecryptingRef.current) return;

    isDecryptingRef.current = true;
    setIsDecrypting(true);
    setDecryptUnavailable(null);
    setNoMoreRecorded(false);
    const before = new Set(allFactoids.map((factoid) => factoid.id));
    const result = moreFactsKey(track);
    let unavailable = false;
    const controller = new AbortController();
    decryptControllerRef.current = controller;
    try {
      // The facts are kept by the hook as they come (`moreFacts`), with their claims; what they
      // add to the list is counted once they are in it (below).
      await onMoreFactoidsStream(track, {
        signal: controller.signal,
        onUnavailable: (code) => {
          unavailable = true;
          setDecryptUnavailable(code);
        },
      });
      setRoundEnded({ unavailable, before, result });
    } catch (error) {
      // Leaving the Player (or starting a new analysis) cancels the stream: not an error.
      if ((error as { name?: unknown } | null)?.name !== 'AbortError') {
        console.error('More facts stream error:', error);
      }
    } finally {
      if (decryptControllerRef.current === controller) {
        decryptControllerRef.current = null;
        isDecryptingRef.current = false;
        setIsDecrypting(false);
      }
    }
  }, [onMoreFactoidsStream, track, allFactoids]);

  // P3:25 — A round has ended: the facts it newly shows are counted in the list itself, so a
  // repeat, a lyric fact or a fact whose claim was rejected is not called added. A recording
  // with nothing new to show says it has no more.
  useEffect(() => {
    if (!roundEnded) return;
    setRoundEnded(null);
    // The Player has moved to another result since the round was asked: nothing of it is told.
    if (roundEnded.result !== moreFactsKey(track)) return;
    const { before } = roundEnded;
    const newCount = allFactoids.filter((factoid) => !before.has(factoid.id)).length;
    if (resultMode === 'replay' && newCount === 0 && !roundEnded.unavailable) {
      setNoMoreRecorded(true);
    }
    if (newCount > 0) {
      setDecryptToastCount(newCount);
      setShowDecryptToast(true);
      if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
      toastTimerRef.current = setTimeout(() => {
        toastTimerRef.current = null;
        setShowDecryptToast(false);
      }, ADDED_NOTICE_MS);
    }
  }, [roundEnded, allFactoids, resultMode, track]);

  // A connected track chosen in the graph: searched by the node's own title and artist (its
  // label whole when it names no title), as the Dashboard's cards search it, never by an artist
  // split from its label. The node's id is the graph's: Spotify's id is used only when matched.
  const handleNodeClick = useCallback(
    (node: GenealogyNode) => {
      if (!onAnalyzeTrack) return;
      const query = nodeQuery(node);
      if (!query) return;
      onAnalyzeTrack(node.spotifyId || 'search', query, '', 'player');
    },
    [onAnalyzeTrack],
  );

  // The phone tabs (WAI-ARIA tabs): the arrow keys move to the next or previous tab, Home and End
  // to the first and last; the open tab alone is in the Tab order.
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // The connections' heading lies over the top of the map: its height, which the map keeps clear.
  const genealogyHeadingRef = useRef<HTMLDivElement>(null);
  const [genealogyHeadingHeight, setGenealogyHeadingHeight] = useState(0);
  useEffect(() => {
    const heading = genealogyHeadingRef.current;
    if (!heading || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      // A hidden panel (a phone's other tab) measures 0: the last height is kept.
      if (heading.offsetHeight > 0) setGenealogyHeadingHeight(heading.offsetHeight);
    });
    observer.observe(heading);
    return () => observer.disconnect();
  }, []);
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = tabKeyTarget(event.key, index, TABS.length);
    if (next === null) return;
    event.preventDefault();
    setActiveTab(TABS[next].id);
    tabRefs.current[next]?.focus();
  };

  // "Find more facts" and what it last said: shown with the cards, and without any (when every
  // fact found is listed below with its source, more may still be asked for).
  const moreFactsControls = (
    <>
      {onMoreFactoidsStream && (
        <button
          type="button"
          onClick={handleDecryptMore}
          // Once every round has been asked, another click would bring nothing new.
          disabled={isDecrypting || more.finished}
          aria-describedby={more.finished ? noMoreRoundsId : undefined}
          className={`w-full flex items-center justify-center gap-2 py-3 px-4
                         border border-dashed border-white/20 rounded-md
                         text-xs font-mono text-text-secondary uppercase tracking-wider
                         hover:border-white/40 hover:text-white hover:bg-white/5
                         focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:outline-hidden
                         disabled:opacity-50
                         ${more.finished ? 'disabled:cursor-not-allowed' : 'disabled:cursor-wait'}
                         transition-all duration-(--duration-fast)`}
        >
          {isDecrypting ? (
            <>
              <Lock size={12} className="animate-pulse" />
              Finding more facts…
            </>
          ) : (
            <>
              <LockOpen size={12} />
              Find more facts
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
        <p id={noMoreRoundsId} role="status" className="text-xs font-mono text-text-tertiary">
          No more facts: every angle on this track has been asked.
        </p>
      )}
      {noMoreRecorded && (
        <p role="status" className="text-xs font-mono text-text-tertiary">
          No more facts: this result is a recording, and every fact recorded with it is shown.
        </p>
      )}
    </>
  );

  return (
    <div ref={rootRef} className="h-full w-full flex flex-col bg-void relative overflow-hidden">
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
      {/* Each label stays on one line, its letters set closer on phones so both buttons fit a
          320 px row; a row still too narrow puts the second button under the first rather than
          past the window's edge. */}
      <div className="z-20 px-4 sm:px-6 pt-4 pb-2 max-md:pb-4 max-md:border-b max-md:border-white/5 flex items-center bg-void/50 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-x-2 sm:gap-x-4 gap-y-2 min-w-0">
          <Button
            variant="ghost"
            size="sm"
            leftIcon={<ArrowLeft size={14} />}
            onClick={onBack}
            className="whitespace-nowrap max-sm:tracking-normal"
          >
            Back to summary
            <span className="hidden lg:inline text-text-muted text-chrome ml-1">Esc</span>
          </Button>
          {onNewSearch && (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={<Search size={12} />}
              onClick={onNewSearch}
              className="whitespace-nowrap max-sm:tracking-normal"
            >
              New search
            </Button>
          )}
        </div>
      </div>

      {/* The track, above the columns from md up: the page's h1 (first of its headings, before
          the columns' section headings), its artist, and the audio line. The band stays above
          the columns, so it is kept short: a long title is cut at two lines and a long artist at
          one, each read whole by screen readers and shown whole on hover (title). On phones it
          is kept for screen readers only, and the Player tab shows the title and artist where
          they scroll with it: no fixed band takes the phone's height. A div, not a page banner. */}
      <div
        id="player-header"
        className="z-20 px-6 pb-3 flex flex-col md:flex-row md:items-end md:justify-between gap-x-6 gap-y-1 border-b border-white/5 bg-void/50 backdrop-blur-sm max-md:sr-only"
      >
        <div className="min-w-0">
          <h1
            ref={headingRef}
            tabIndex={-1}
            title={track.title}
            className="text-2xl md:text-3xl font-light leading-tight text-white tracking-tight text-shadow-dark focus-visible:outline-hidden break-words md:line-clamp-2"
          >
            {track.title}
          </h1>
          <p
            title={track.artist}
            className="text-sm md:text-base text-text-tertiary font-mono break-words md:line-clamp-1"
          >
            {track.artist}
          </p>
          {/* From md up a replayed result says so right under its title and artist, before any
              column (phones show it below, above the tabs' panels) */}
          {recorded && (
            <div className="hidden md:block mt-2">
              <RecordedRunNotice track={track} compact />
            </div>
          )}
        </div>
        {/* Measured values in the measured hue; what was not measured, and the separators, in
            a neutral one */}
        <div className="hidden md:flex shrink-0 flex-col items-end gap-1">
          <p
            data-testid="player-audio-line"
            className="whitespace-nowrap text-xs font-mono text-text-tertiary"
          >
            {bpm !== null ? (
              <span className="text-cyber">{formatBpm(bpm)} BPM</span>
            ) : (
              'BPM not measured'
            )}
            {key !== null && (
              <>
                {' · '}
                <span className="text-cyber">{key}</span>
              </>
            )}
            {measurement && (
              <>
                {' · '}
                <span className="text-cyber">
                  {formatSeconds(measurement.windowSeconds)} s preview
                </span>
              </>
            )}
          </p>
          {/* From md up the connections are a row below both columns, far down the page: this
              takes the reader there and puts the focus on them (a button, not a link to
              #panel-genealogy: the page's address stays the track's) */}
          <button
            type="button"
            aria-controls="panel-genealogy"
            onClick={() => {
              const panel = document.getElementById('panel-genealogy');
              if (!panel) return;
              panel.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' });
              panel.focus({ preventScroll: true });
            }}
            className="text-xs font-mono text-text-secondary hover:text-white rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyber/70"
          >
            Connections <span aria-hidden="true">↓</span>
          </button>
        </div>
      </div>

      {/* On phones only one panel shows at a time: the recording label stays above all of them,
          right after the (screen-reader) header, so it is reached before any panel */}
      {recorded && (
        <div className="md:hidden z-20 mx-4 mt-2">
          <RecordedRunNotice track={track} compact />
        </div>
      )}

      {/* The panels. Phones (below md): one at a time, chosen with the tabs below; each scrolls
          on its own. From md up: two columns, the notes and the player, with the connections
          as a full-width row below them (room for the map's year axis across the page); the
          columns take the height of their content and the whole area scrolls as one, down only
          (a timeline tooltip at rest past the window's edge must not let it scroll sideways). */}
      <div
        data-player-columns
        className="flex-1 min-h-0 relative z-10 flex flex-col overflow-hidden md:grid md:grid-cols-2 md:overflow-x-hidden md:overflow-y-auto md:overscroll-contain"
      >
        {/* Panel A: the notes (md up: the left column; phones: the Analysis tab) */}
        <div
          id="panel-context"
          {...panelRole('context')}
          className={`
            min-w-0 p-6 border-white/5 bg-black/25 backdrop-blur-sm md:border-r max-md:overflow-y-auto max-md:overscroll-contain
            ${activeTab === 'context' ? 'block absolute inset-0 md:static z-20 bg-void md:bg-transparent' : 'hidden md:block'}
        `}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
            <h2 className="text-xs font-mono text-text-tertiary uppercase tracking-widest">
              Facts
            </h2>
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
            <p className="text-xs text-text-tertiary font-mono mb-8">{facts(allFactoids.length)}</p>
          )}
          {/* One list, the controls at one place in it with cards or without: the first card
              "Find more facts" brings keeps the button, and its focus. */}
          <div className="space-y-6">
            {allFactoids.length === 0 ? (
              <div className="flex-1 flex items-center justify-center py-12">
                <p className="text-text-tertiary text-xs font-mono text-center">
                  {/* Facts were found but none is shown: the lines around say why. Facts found
                      that each restate a sourced claim are listed below, with their sources. */}
                  {hiddenFacts
                    ? 'No facts to show.'
                    : restatedFacts
                      ? 'Every fact found here is already listed with its source below.'
                      : listedFacts
                        ? 'No fact cards: the notes below list what was found.'
                        : 'No facts were found for this track.'}
                </p>
              </div>
            ) : (
              <>
                {visibleResultFactoids.map((fact, idx) => (
                  <div key={fact.id} className={`stagger-${Math.min(idx + 1, 8)}`}>
                    <InteractiveFactoid
                      factoid={fact}
                      claim={claimOf(fact)}
                      origin={
                        claimedFactoids ? (fromSourceData ? 'record' : 'inferred') : undefined
                      }
                      fromSourceData={fromSourceData}
                      readings={readings}
                      audio={measurement}
                      relation={relationOf(fact)}
                    />
                  </div>
                ))}

                {/* Factoids added by "More facts" are written by the model, whatever the result:
                  each shows its claim, and the section is labelled only when none has one */}
                {visibleDecryptedFactoids.length > 0 && (
                  <section aria-label="More facts" className="space-y-6">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-xs font-mono text-text-tertiary uppercase tracking-widest">
                        More facts
                      </h3>
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
                        relation={relationOf(fact)}
                      />
                    ))}
                  </section>
                )}
              </>
            )}

            {moreFactsControls}

            {/* Show more / collapse toggle */}
            {hiddenCount > 0 && !showAllFactoids && (
              <div className="relative">
                {/* Gradient fade on boundary */}
                <div className="absolute -top-12 left-0 right-0 h-12 bg-gradient-to-b from-transparent to-black/20 pointer-events-none" />
                <button
                  type="button"
                  onClick={() => setShowAllFactoids(true)}
                  className="w-full flex items-center justify-center gap-2 py-2 text-xs font-mono text-text-tertiary hover:text-cyber focus-visible:ring-2 focus-visible:ring-cyber/70 focus-visible:outline-hidden transition-colors"
                >
                  <ChevronDown size={14} />
                  Show {hiddenCount} more {hiddenCount === 1 ? 'fact' : 'facts'}
                </button>
              </div>
            )}
            {showAllFactoids && allFactoids.length > INITIAL_VISIBLE_FACTOIDS && (
              <button
                type="button"
                onClick={() => setShowAllFactoids(false)}
                className="w-full flex items-center justify-center gap-2 py-2 text-xs font-mono text-text-tertiary hover:text-cyber transition-colors focus-visible:ring-2 focus-visible:ring-cyber/70 focus-visible:outline-hidden"
              >
                <ChevronDown size={14} className="rotate-180" />
                Show less
              </button>
            )}
          </div>

          {/* The liner notes, below the cards: credits, samples and covers, history, then every
              other claim no card shows; the claims the verifier rejected; and where the data
              comes from. A relation is named in the words the graph and the cards use, hedged
              ("Possible sample") unless it is sourced. */}
          <div className="mt-10 space-y-8">
            <CreditsList
              credits={notes.credits.claims}
              onCards={notes.credits.onCards}
              uncited={track.credits}
              readings={readings}
              audio={measurement}
            />
            <ClaimList
              title="Samples and covers"
              claims={notes.relations.claims}
              onCards={notes.relations.onCards}
              links={relationNotes}
              // "None" only when no claim, no drawn link and no timeline marker names one
              emptyText={
                timelineSamples.drawn.length > 0
                  ? `The timeline marks ${timelineSamples.drawn.length === 1 ? '1 possible sample' : `${timelineSamples.drawn.length} possible samples`}; no claim or connection in this result states ${timelineSamples.drawn.length === 1 ? 'it' : 'them'}.`
                  : rejectedAbout(['sample', 'cover'])
                    ? 'The samples and covers found were rejected by the verifier (listed below).'
                    : 'No samples or covers were found in this result.'
              }
              readings={readings}
              audio={measurement}
              relations={claimRelations}
            />
            <ClaimList
              title="History"
              claims={notes.history.claims}
              onCards={notes.history.onCards}
              emptyText={
                rejectedAbout(['history'])
                  ? 'The history claims found were rejected by the verifier (listed below).'
                  : 'No history was found in this result.'
              }
              readings={readings}
              audio={measurement}
              relations={claimRelations}
            />
            <ClaimList
              title="More claims"
              claims={notes.more}
              readings={readings}
              audio={measurement}
              relations={claimRelations}
            />
            <RejectedClaims
              rejected={claims.rejected}
              unreadable={claims.unreadableRejected}
              audio={measurement}
            />
            <Attribution providers={providers} />
          </div>
        </div>

        {/* Panel B: the player (md up: the centre or right column; phones: the Player tab) */}
        <div
          id="panel-player"
          {...panelRole('player')}
          className={`
            min-w-0 p-8 flex flex-col items-center justify-start relative max-md:overflow-x-hidden max-md:overflow-y-auto max-md:overscroll-contain
            ${activeTab === 'player' ? 'block max-md:h-full' : 'hidden md:flex'}
        `}
        >
          {/* The tab's heading on phones; from md up the track's h1 above heads the column */}
          <h2 className="self-start mb-4 text-xs font-mono text-text-tertiary uppercase tracking-widest md:sr-only">
            Player
          </h2>
          <ResultNotices track={track} className="w-full max-w-lg mb-4" />

          {/* Album Art Container */}
          <AlbumCover
            cover={cover}
            album={track.album}
            evidence={track.evidence}
            className="mb-8 mt-4 flex-shrink-0 w-56 max-w-full md:w-64 lg:w-80"
            frameClassName="group"
            surfaceClassName={`rounded-lg shadow-elevated-lg transition-all duration-(--duration-dramatic) ${isPlaying ? 'animate-pulse-slow' : ''} ${isPlaying && cover.src ? 'shadow-[var(--shadow-glow-cyber)]' : ''}`}
            iconSize={56}
          >
            <div className="absolute inset-0 bg-cyber/15 blur-3xl rounded-full opacity-0 group-hover:opacity-30 transition-opacity duration-(--duration-dramatic)"></div>
          </AlbumCover>

          {/* Meta. The title and artist are the page's header from md up; on phones they are
              shown here, where they scroll with the tab (the header's h1 is read instead). A
              word longer than the column breaks anywhere, so it never widens the column. */}
          <div className="text-center mb-6">
            <div aria-hidden="true" className="md:hidden">
              <p className="text-3xl font-light leading-tight text-white tracking-tight mb-2 text-shadow-dark wrap-anywhere">
                {track.title}
              </p>
              <p className="text-lg text-text-tertiary font-mono wrap-anywhere">{track.artist}</p>
            </div>
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
              withheld={measurement?.withheld.fields}
            />
          </div>
        </div>

        {/* Panel C: the connections (md up: a full-width row below the columns, 14rem shorter
            than the window (the nav, the header and the footer take
            about 12rem), so a strip of the scrolling area always shows beside it to grab, even
            on a landscape phone, or as tall as its content when the connections are a compact
            row; phones: the Connections tab, covering the panels' area, absolute, so it has
            that area's height for the graph) */}
        <div
          id="panel-genealogy"
          {...panelRole('genealogy')}
          // Focus lands here from the header's "Connections" button (not a tab stop of its own),
          // and its ring shows it.
          tabIndex={-1}
          className={`
            min-w-0 focus-visible:outline-hidden forced-colors:focus-visible:-outline-offset-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyber/70 border-white/5 bg-black/25 backdrop-blur-sm md:relative md:col-span-2 md:border-t ${sparseGenealogy ? 'md:h-auto' : 'md:h-[clamp(10rem,calc(100dvh_-_14rem),40rem)]'}
            ${activeTab === 'genealogy' ? 'flex flex-col max-md:absolute max-md:inset-0 max-md:z-20 max-md:bg-void' : 'hidden md:flex md:flex-col'}
        `}
        >
          {/* Over the top of the map, on a band of the page's colour: the map leaves this band
              clear (its `topInset`), so no card sits under the heading until it is panned */}
          <div
            ref={genealogyHeadingRef}
            className="absolute top-0 left-0 right-0 z-10 px-4 pt-4 pb-2 bg-void pointer-events-none flex flex-wrap items-center gap-2"
          >
            <h2 className="text-xs font-mono text-text-tertiary uppercase tracking-widest">
              Connections
            </h2>
            {/* How the shown links are known, in the words and chips the legend, the list and
                the connected-track cards use: sourced, not sourced, or (every link) the model's */}
            {genealogy.nodes.length > 1 && (
              <LinkKindsChip kinds={linkKinds} fromSourceData={fromSourceData} />
            )}
            {/* The map on a page of its own: a real link, to copy or open in a new tab */}
            {genealogy.nodes.length > 1 && mapHref && (
              <a
                href={mapHref}
                onClick={(event) => {
                  if (!onOpenMap || !isPlainClick(event)) return;
                  event.preventDefault();
                  onOpenMap();
                }}
                className="pointer-events-auto ml-auto text-xs font-mono text-text-secondary hover:text-white underline underline-offset-4 rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-cyber/70"
              >
                Open the full map
              </a>
            )}
          </div>
          {genealogy.nodes.length > 1 ? (
            // A graph that throws while it renders leaves the rest of the Player as it is. (A
            // throw inside d3's ticks or zoom handlers or the ResizeObserver's callback is not
            // caught here: those run outside React.)
            <ErrorBoundary
              key={track.id}
              message="The connections graph could not be drawn"
              action={{ label: 'Try again' }}
              className="flex-1 min-h-0"
            >
              <GenealogyGraph
                data={genealogy}
                evidence={track.evidence}
                claims={claims}
                releaseYear={track.releaseYear}
                hiddenLinks={hiddenLinks}
                topInset={genealogyHeadingHeight}
                onNodeClick={handleNodeClick}
                trackPreviewUrl={track.previewUrl}
                replay={resultMode === 'replay'}
                // From md up the page scrolls past the graph: the wheel and one finger scroll
                // it, Ctrl or ⌘ with the wheel or two fingers zoom the graph. On phones nothing
                // scrolls behind the graph, and it takes them all.
                wheelZoom={layout === 'columns' ? 'modifier' : 'plain'}
              />
            </ErrorBoundary>
          ) : (
            <div className="flex-1 flex items-center justify-center p-6">
              <p className="text-text-tertiary text-xs font-mono text-center">
                {noConnectionsText(hiddenLinks)}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* P3:25 — How many facts a click added. Outside the tab panels, so it is shown and
          announced whichever phone tab is open; the status region stays in the page, so the
          message put in it is announced. Neutral, as the facts are the model's, not measured. */}
      <div role="status">
        {showDecryptToast && (
          <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 px-5 py-2.5 bg-surface-overlay backdrop-blur-lg border border-white/10 rounded-sm text-text-secondary text-xs font-mono animate-slide-up-fade shadow-elevated-lg">
            {decryptToastCount} more {decryptToastCount === 1 ? 'fact' : 'facts'} added
          </div>
        )}
      </div>

      {/* The phone tabs (WAI-ARIA tabs): Tab reaches the open tab only, the arrow keys move
          between the tabs and open the one they reach, Home and End go to the first and last. */}
      <div
        role="tablist"
        aria-label="Player sections"
        className="md:hidden border-t border-white/5 bg-void/90 backdrop-blur-lg flex text-xs font-mono uppercase tracking-widest pb-[env(safe-area-inset-bottom)]"
      >
        {TABS.map((tab, index) => {
          const open = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={open}
              aria-controls={tab.panel}
              tabIndex={open ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              className={`flex-1 py-3 text-center focus-visible:border-t-2 focus-visible:border-cyber focus-visible:outline-hidden forced-colors:focus-visible:-outline-offset-2 ${open ? `border-t-2 ${tab.open}` : 'text-text-tertiary'}`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    </div>
  );
};

const Player: React.FC<PlayerProps> = ({ trackData, ...props }) => {
  // Missing lists default to empty so a partial result renders; memoised so the graph and
  // the factoid list keep their identity between renders.
  const track = useMemo(() => (trackData ? normalizeTrack(trackData) : null), [trackData]);
  // One view per track: another track's Player (a breadcrumb step, Back or Forward) opens
  // afresh, on the tab its entry has, with none of this one's state.
  return track ? <PlayerView key={track.id} track={track} {...props} /> : <NoAnalysis {...props} />;
};

export default Player;
