import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3-force';
import type { TrackData, GenealogyNode } from '../../types';

export interface GenealogyGraphProps {
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
  type?: string; // Semantic relationship type
}
