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
  /**
   * Analyses a related track: called by the detail panel's "Analyze this track", the one way the
   * map starts an analysis (a click on a card selects it).
   */
  onNodeClick?: (node: GenealogyNode) => void;
  /** The analysed track's preview clip, for A/B listening with a selected track. */
  trackPreviewUrl?: string | null;
  /**
   * True for a replayed recording: it keeps no previews (preview links expire), so the detail
   * panel says they play in a live analysis.
   */
  replay?: boolean;
  /**
   * What the mouse wheel does over the graph: 'plain' zooms it (where nothing around it
   * scrolls); 'modifier' leaves the wheel to the page and zooms only with Ctrl or ⌘ held (a
   * trackpad pinch sends that too). A touch pinch zooms either way.
   */
  wheelZoom?: 'plain' | 'modifier';
  /**
   * The level of the selected track's heading in its detail panel: one below the heading the
   * graph sits under (3 under the Player's h2, 2 on the map's own page under its h1).
   */
  detailHeadingLevel?: 2 | 3;
}
