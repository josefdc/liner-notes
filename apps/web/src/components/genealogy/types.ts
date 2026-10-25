import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3-force';
import type { TrackData, GenealogyNode } from '../../types';
import type { ShownLink } from './links';

export interface GenealogyGraphProps {
  /**
   * The genealogy as `normalizeTrack` returns it: with the result's evidence pack, which a link
   * must cite to be shown as sourced.
   */
  data: TrackData['genealogy'];
  // Callback to trigger analysis of a clicked node (infinite navigation)
  onNodeClick?: (node: GenealogyNode) => void;
}

// Extend D3 types for our specific data structure
export interface CustomNode extends SimulationNodeDatum {
  id: string;
  group: number;
  label: string;
  img?: string;
  size: number;
  // D3 simulation adds these properties
  x?: number;
  y?: number;
  // Audio & navigation fields
  previewUrl?: string;
  spotifyId?: string;
  trackTitle?: string;
  trackArtist?: string;
}

export interface CustomLink extends SimulationLinkDatum<CustomNode> {
  source: CustomNode | string;
  target: CustomNode | string;
  value: number;
  /** The link's position in the shown links (d3-force sets `index` itself). */
  n: number;
  /** The link as the app shows it: its kind, relation and citations. */
  shown: ShownLink;
}
