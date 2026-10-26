/**
 * Screen size of the genealogy graph's text (line labels, track labels and their tags, the hover
 * notes), whatever the zoom: zooming in does not enlarge it, so it is the chrome size
 * (--text-chrome in tokens.css), never smaller. scripts/graph-text-size.test.mjs holds it to that.
 */
export const GRAPH_TEXT_PX = 12;
export const LINE_LABEL_PX = GRAPH_TEXT_PX;
export const NODE_LABEL_PX = GRAPH_TEXT_PX;
export const SUB_LABEL_PX = GRAPH_TEXT_PX;
