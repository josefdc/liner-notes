import type React from 'react';
import { useMemo } from 'react';
import type { TrackData } from '../../types';
import { ResultOriginLabel } from '../EstimatedWarning';
import { type ResultClaims, withoutHiddenRelations } from '../provenance/claims';
import { ProvenanceChip } from '../provenance/ProvenanceChip';
import { Badge } from '../ui/Badge';
import { isSparse } from './lineageLayout';
import { kindLabel, linkContext, shownLinks } from './links';

/** How the shown links are known: some sourced, some not, any not sourced by a broken record. */
export interface LinkKinds {
  sourced: boolean;
  inferred: boolean;
  notSourced: boolean;
}

/**
 * A result's song relations as the Player's map panel and the full-size map show them: the
 * genealogy without the relations whose claim is hidden, how many links that leaves out, the
 * links shown, whether they make a compact row, and how they are known.
 */
export function useConnections(track: TrackData, claims: ResultClaims) {
  const genealogy = useMemo(
    () => withoutHiddenRelations(track.genealogy, claims.isHidden),
    [track.genealogy, claims],
  );
  // Relations left out because their claim is hidden, said under the graph's legend (entries
  // that are not links at all are not counted: they had no claim to hide).
  const hiddenLinks = track.genealogy.links.filter(
    (link) => typeof link === 'object' && link !== null && claims.isHidden(link.claimId),
  ).length;
  const graphLinks = useMemo(
    () =>
      shownLinks(
        genealogy,
        linkContext(track.evidence, claims, { releaseYear: track.releaseYear }),
      ),
    [genealogy, track.evidence, track.releaseYear, claims],
  );
  // Two links or fewer in all: the map is a compact row, as tall as its content.
  const sparse = isSparse(graphLinks.length);
  const linkKinds = useMemo<LinkKinds>(
    () => ({
      sourced: graphLinks.some((link) => link.kind === 'sourced'),
      inferred: graphLinks.some((link) => link.kind !== 'sourced'),
      notSourced: graphLinks.some((link) => kindLabel(link) === 'Not sourced'),
    }),
    [graphLinks],
  );
  return { genealogy, hiddenLinks, graphLinks, sparse, linkKinds };
}

/**
 * How the shown links are known, in the words and chips the legend, the list and the
 * connected-track cards use: sourced, not sourced, or (every link) the model's.
 */
export const LinkKindsChip: React.FC<{ kinds: LinkKinds; fromSourceData: boolean }> = ({
  kinds,
  fromSourceData,
}) => (
  <span data-testid="genealogy-kinds" className="inline-flex max-w-full">
    {kinds.sourced ? (
      kinds.inferred ? (
        <Badge variant="neutral">Sourced and not sourced links</Badge>
      ) : (
        <ProvenanceChip kind="sourced">Sourced links</ProvenanceChip>
      )
    ) : kinds.notSourced ? (
      // Not the model's: built from records whose evidence does not hold.
      <ProvenanceChip kind="unconfirmed">Not sourced</ProvenanceChip>
    ) : (
      <ResultOriginLabel fromSourceData={fromSourceData} />
    )}
  </span>
);

/** What the map's place says when there is no related track to draw. */
export function noConnectionsText(hiddenLinks: number) {
  // Relations were found, but the verifier rejected every one (they are listed with the
  // rejected claims).
  return hiddenLinks > 0
    ? 'No connections to show.'
    : 'No connected tracks were found for this track.';
}
