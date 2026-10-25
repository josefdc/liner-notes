import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3-force';
import type { TrackData, GenealogyNode } from '../../types';
import type { ResultClaims } from '../provenance/claims';
import type { ShownLink } from './links';

export interface GenealogyGraphProps {
  data: TrackData['genealogy'];
  /**
   * The result's evidence pack (`evidence`, as sent). A link is shown as sourced only when every
   * id it cites is in it; without it every link is a model inference.
   */
  evidence?: unknown;
  /**
   * The result's claims (`resultClaims`): a link whose claim the main view hides is not drawn,
   * and a model link is sourced only when its claim has a supporting verdict.
   */
  claims?: ResultClaims | null;
  /**
   * The result's `releaseYear`: the analysed track's year for the direction check and its name,
   * when its node's label names none (the API labels it with the title alone).
   */
  releaseYear?: unknown;
  /** Links the caller left out already because their claim is hidden (said under the legend). */
  hiddenLinks?: number;
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
