import type React from 'react';
import { useCallback, useEffect, useMemo } from 'react';
import { ArrowLeft, Search } from 'lucide-react';
import { normalizeTrack, recordingOf } from '../constants';
import { moreFactsOf } from '../hooks/agent/moreFacts';
import type { MoreFacts } from '../hooks/agent/types';
import type { TrailView } from '../router/trail';
import type { GenealogyNode, TrackData } from '../types';
import { isPlainClick } from '../utils/plainClick';
import { resultModeOf } from '../utils/recording';
import { RecordedRunNotice } from './EstimatedWarning';
import { ErrorBoundary } from './ErrorBoundary';
import GenealogyGraph from './GenealogyGraph';
import { LinkKindsChip, noConnectionsText, useConnections } from './genealogy/connections';
import { nodeQuery } from './genealogy/nodeTrack';
import { resultClaims } from './provenance/claims';
import { Button } from './ui/Button';

interface MapViewProps {
  trackData: TrackData | null;
  /** The facts "more facts" added so far, with their claims (useAgent's `moreFacts`). */
  moreFacts?: MoreFacts | null;
  /** Analyses a track chosen on the map (its detail panel's "Analyze this track"). */
  onAnalyzeTrack?: (trackId: string, title: string, artist: string, from?: TrailView) => void;
  /** The address of the track's own view (`/t/<id>`), for "Back to <title>". */
  trackHref: string;
  /** Shows the track's own view in this page (a plain click on "Back to <title>"). */
  onBackToTrack: () => void;
  onNewSearch?: () => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}

/** The page's title while the map shows: the track's and the map's. */
const pageTitle = (track: TrackData) =>
  `Song relations map: ${[track.title, track.artist].filter(Boolean).join(' by ')} · Liner Notes`;

/**
 * A result's song-relations map on a page of its own (`/t/<id>/map`): the whole window under a
 * band with the way back to the track, the map's heading and how its links are known. The map
 * is the Player's (selection, the detail panel, A/B listening, filters, the list), with the room
 * for its year axis across the window.
 */
const MapScreen: React.FC<Omit<MapViewProps, 'trackData'> & { track: TrackData }> = ({
  track,
  moreFacts,
  onAnalyzeTrack,
  trackHref,
  onBackToTrack,
  headingRef,
}) => {
  const more = useMemo(() => moreFactsOf(track, moreFacts ?? null), [track, moreFacts]);
  const claims = useMemo(
    () => resultClaims(track, Object.values(more.claims)),
    [track, more.claims],
  );
  const { genealogy, hiddenLinks, sparse, linkKinds } = useConnections(track, claims);
  const replay = resultModeOf(track.run) === 'replay';
  const recorded = recordingOf(track) !== null;
  const title = track.title || 'this track';

  useEffect(() => {
    const before = document.title;
    document.title = pageTitle(track);
    return () => {
      document.title = before;
    };
  }, [track]);

  // A track chosen on the map: searched by the node's own title and artist, as the Player's
  // panel searches it; this view is where its trail step was left.
  const handleNodeClick = useCallback(
    (node: GenealogyNode) => {
      if (!onAnalyzeTrack) return;
      const query = nodeQuery(node);
      if (!query) return;
      onAnalyzeTrack(node.spotifyId || 'search', query, '', 'map');
    },
    [onAnalyzeTrack],
  );

  return (
    <div className="h-full w-full flex flex-col bg-void overflow-hidden" data-map-view>
      <div className="shrink-0 px-4 md:px-6 py-3 border-b border-white/5 flex flex-col gap-2">
        <a
          href={trackHref}
          onClick={(event) => {
            if (!isPlainClick(event)) return;
            event.preventDefault();
            onBackToTrack();
          }}
          className="self-start inline-flex items-center gap-1.5 text-xs font-mono text-text-secondary hover:text-white rounded-sm break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyber/70"
        >
          <ArrowLeft size={14} aria-hidden="true" className="shrink-0" />
          <span className="min-w-0 break-words">Back to {title}</span>
        </a>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="min-w-0 break-words text-base md:text-lg font-light text-white tracking-tight outline-none"
          >
            Song relations of {title}
            {track.artist && <span className="text-text-tertiary"> · {track.artist}</span>}
          </h1>
          {genealogy.nodes.length > 1 && (
            <LinkKindsChip kinds={linkKinds} fromSourceData={Boolean(track.modelUnavailable)} />
          )}
        </div>
        {recorded && <RecordedRunNotice track={track} compact />}
      </div>
      <div className={`flex-1 min-h-0 flex flex-col ${sparse ? 'overflow-y-auto p-4 md:p-6' : ''}`}>
        {genealogy.nodes.length > 1 ? (
          // A map that throws while it renders leaves the band and its way back as they are.
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
              onNodeClick={handleNodeClick}
              trackPreviewUrl={track.previewUrl}
              replay={replay}
              // Nothing scrolls behind the map: the wheel and one finger zoom and pan it.
              wheelZoom="plain"
            />
          </ErrorBoundary>
        ) : (
          <div className="flex-1 flex items-center justify-center p-6">
            <p data-map-empty className="text-text-tertiary text-xs font-mono text-center">
              {noConnectionsText(hiddenLinks)}
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

/** Shown when there is no analysis to display: never a demo track in its place. */
const NoAnalysis: React.FC<Pick<MapViewProps, 'onNewSearch' | 'headingRef'>> = ({
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
    {onNewSearch && (
      <Button variant="ghost" size="sm" leftIcon={<Search size={12} />} onClick={onNewSearch}>
        New search
      </Button>
    )}
  </div>
);

const MapView: React.FC<MapViewProps> = ({ trackData, ...props }) => {
  // Missing lists default to empty so a partial result renders.
  const track = useMemo(() => (trackData ? normalizeTrack(trackData) : null), [trackData]);
  return track ? <MapScreen track={track} {...props} /> : <NoAnalysis {...props} />;
};

export default MapView;
