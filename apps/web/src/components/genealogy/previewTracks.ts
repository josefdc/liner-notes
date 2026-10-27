import type { TrackData } from '../../types';

/** A related track the graph offers a preview of: its node id and its clip. */
export interface PreviewTrack {
  id: string;
  url: string;
}

/**
 * The related tracks the graph offers a preview of: every drawn track but the analysed one with
 * a clip, whether or not a shown link names it (each has its preview button, PreviewList). The
 * attribution credits these clips' providers, and no other node's.
 */
export function previewTracksOf(
  data: Partial<TrackData['genealogy']> | null | undefined,
): PreviewTrack[] {
  const nodes = Array.isArray(data?.nodes) ? data.nodes : [];
  return nodes.flatMap((node) =>
    node && node.group !== 1 && typeof node.previewUrl === 'string' && node.previewUrl
      ? [{ id: node.id, url: node.previewUrl }]
      : [],
  );
}
