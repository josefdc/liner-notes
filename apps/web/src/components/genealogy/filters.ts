import type { ShownLink } from './links';

/**
 * The map's filters: which links it shows, by the relation they are named as and by how they are
 * known. A track is shown while shown links join it to the analysed track, which always is. The
 * canvas, the compact row, the list of links and the summary all read the same filtered lists.
 */

/** What a link is filtered as: the relation it is named as, or a second hop. */
export type FilterKind =
  | 'sample'
  | 'interpolation'
  | 'cover'
  | 'remix'
  | 'producer'
  | 'influence'
  | 'second-hop';

/** Every kind, in the order the toggles list them. */
export const FILTER_KINDS: readonly FilterKind[] = [
  'sample',
  'interpolation',
  'cover',
  'remix',
  'producer',
  'influence',
  'second-hop',
];

export const FILTER_LABEL: Record<FilterKind, string> = {
  sample: 'Sample',
  interpolation: 'Interpolation',
  cover: 'Cover',
  remix: 'Remix',
  producer: 'Shared producer',
  influence: 'Influence',
  'second-hop': 'Second hop',
};

/** Which links are left out: the kinds switched off, and those not sourced when `sourcedOnly`. */
export interface LinkFilter {
  off: ReadonlySet<FilterKind>;
  sourcedOnly: boolean;
}

export const NO_FILTER: LinkFilter = { off: new Set(), sourcedOnly: false };

export const isFiltering = (filter: LinkFilter) => filter.off.size > 0 || filter.sourcedOnly;

/**
 * A link's kind for the filters: a second hop when it does not touch the analysed track (and
 * there is one), else the relation it is named as (`ShownLink.named`: "Possible sample" is a
 * sample, a link whose years contradict its direction an influence).
 */
export function filterKindOf(link: ShownLink, currentId: string | null): FilterKind {
  if (currentId !== null && link.source !== currentId && link.target !== currentId) {
    return 'second-hop';
  }
  return link.named;
}

/** Whether the filter keeps a link. */
export function linkShown(link: ShownLink, currentId: string | null, filter: LinkFilter): boolean {
  if (filter.off.has(filterKindOf(link, currentId))) return false;
  return !filter.sourcedOnly || link.kind === 'sourced';
}

/**
 * The tracks and links the filter keeps: the links it keeps that still reach the analysed track
 * (a second hop goes while the track it hangs from has no shown link to it: an island joined to
 * nothing on the map says nothing about this track), and the tracks one of them touches, with
 * the analysed track always. Without a filter, the lists as given (the same arrays).
 * `hiddenTracks` counts the tracks a link joined that the filter leaves with none (a track that
 * had no link to begin with is not one the filter hides).
 */
export function filterGenealogy<N extends { id: string }>(
  nodes: readonly N[],
  links: readonly ShownLink[],
  currentId: string | null,
  filter: LinkFilter,
): { nodes: readonly N[]; links: readonly ShownLink[]; hiddenTracks: number } {
  if (!isFiltering(filter)) return { nodes, links, hiddenTracks: 0 };
  let kept = links.filter((link) => linkShown(link, currentId, filter));
  if (currentId !== null) {
    // The tracks the kept links join to the analysed track, hop by hop.
    const reached = new Set([currentId]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const link of kept) {
        const from = reached.has(link.source);
        if (from !== reached.has(link.target)) {
          reached.add(from ? link.target : link.source);
          grew = true;
        }
      }
    }
    kept = kept.filter((link) => reached.has(link.source));
  }
  const touched = new Set(kept.flatMap((link) => [link.source, link.target]));
  const linked = new Set(links.flatMap((link) => [link.source, link.target]));
  const shown = nodes.filter((node) => node.id === currentId || touched.has(node.id));
  return {
    nodes: shown,
    links: kept,
    hiddenTracks: nodes.filter(
      (node) => node.id !== currentId && linked.has(node.id) && !touched.has(node.id),
    ).length,
  };
}

/** How many links of each kind the map has (kinds it has none of are left out), in order. */
export function filterCounts(
  links: readonly ShownLink[],
  currentId: string | null,
): Array<{ kind: FilterKind; count: number }> {
  const counts = new Map<FilterKind, number>();
  for (const link of links) {
    const kind = filterKindOf(link, currentId);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return FILTER_KINDS.flatMap((kind) => {
    const count = counts.get(kind) ?? 0;
    return count > 0 ? [{ kind, count }] : [];
  });
}

/** What a filter hides, in words: "Sample and Cover links, and links that are not sourced". */
export function hiddenText(filter: LinkFilter): string {
  const kinds = FILTER_KINDS.filter((kind) => filter.off.has(kind)).map(
    (kind) => FILTER_LABEL[kind],
  );
  const parts: string[] = [];
  if (kinds.length > 0) {
    const named =
      kinds.length === 1
        ? kinds[0]
        : `${kinds.slice(0, -1).join(', ')} and ${kinds[kinds.length - 1]}`;
    parts.push(`${named} links`);
  }
  if (filter.sourcedOnly) parts.push('links that are not sourced');
  return parts.join(', and ');
}
