import type { TrackData, GenealogyNode } from '../../types';
import type { ResultClaims } from '../provenance/claims';

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
  /**
   * How much of the top of the map the panel's heading covers (px): the map leaves it clear in
   * its first view, and places no chip there.
   */
  topInset?: number;
  // Callback to trigger analysis of a clicked node (infinite navigation)
  onNodeClick?: (node: GenealogyNode) => void;
  /**
   * What the mouse wheel does over the graph: 'plain' zooms it (where nothing around it
   * scrolls); 'modifier' leaves the wheel to the page and zooms only with Ctrl or ⌘ held (a
   * trackpad pinch sends that too). A touch pinch zooms either way.
   */
  wheelZoom?: 'plain' | 'modifier';
}
