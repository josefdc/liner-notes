import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { type Selection, select } from 'd3-selection';
import { type D3ZoomEvent, zoom, zoomIdentity, type ZoomTransform } from 'd3-zoom';
import 'd3-transition'; // Side-effect import: augments Selection with .transition()
import type { LinkType } from '@liner-notes/contract';
import { Volume2, VolumeX, MousePointerClick } from 'lucide-react';
import { colors, genealogyColors } from '../styles/theme';
import { placeholderImage } from '../styles/placeholder';
import type { GenealogyGraphProps } from './genealogy/types';
import { previewTracksOf } from './genealogy/previewTracks';
import { useAudioPreview } from './genealogy/useAudioPreview';
import {
  describeLink,
  isDocumentedSource,
  kindLabel,
  LINK_TYPES,
  nodeName,
  nodesById,
  provenanceText,
  rank,
  linkContext,
  readGenealogy,
  yearFrom,
  yearOf,
  relationLabel,
  relationSentence,
  relationToTrack,
  type ShownLink,
} from './genealogy/links';
import { labelWidth } from './genealogy/labels';
import {
  type CardBox,
  type ChipInput,
  charsToWrap,
  isSparse,
  laneOf,
  layoutLineage,
  type Orientation,
  orientationFor,
  placeChips,
  wrapText,
} from './genealogy/lineageLayout';
import { cardWords } from './genealogy/cardWords';
import { LINK_COLOR, LINK_DASH, LINK_OPACITY, linkWidth } from './genealogy/linkStyle';
import { GRAPH_TEXT_PX, LINE_LABEL_PX, NODE_LABEL_PX, SUB_LABEL_PX } from './genealogy/textSize';
import { LineageRow } from './genealogy/LineageRow';
import { LinkLegend } from './genealogy/LinkLegend';
import { LinkList } from './genealogy/LinkList';
import { PreviewList } from './genealogy/PreviewList';
import { isValidImageUrl } from '../utils/image';
import { useReducedMotion } from '../utils/motion';
import { useNoHover } from '../utils/layout';
import type { GenealogyNode, TrackData } from '../types';

/** Something in the graph that keyboard focus or the pointer can be on: a track or a link. */
type Item = { kind: 'node'; id: string } | { kind: 'link'; index: number };

const sameItem = (a: Item | null, b: Item | null) =>
  a !== null &&
  b !== null &&
  (a.kind === 'node'
    ? b.kind === 'node' && a.id === b.id
    : b.kind === 'link' && a.index === b.index);

/** True for a link that states an influence, or no relation (an influence too). */
const isStatedInfluence = (link: ShownLink) =>
  link.statedType === null || link.statedType === 'influence';

/** The words on a link's chip: its relation as the cards name it, hedged when it is not sourced. */
function lineLabel(link: ShownLink): string {
  return link.directionKnown ? relationLabel(link).toLowerCase() : 'related';
}

/** The genealogy's nodes, or none when the list is missing. */
function graphNodes(
  data: Partial<TrackData['genealogy']> | null | undefined,
): TrackData['genealogy']['nodes'] {
  return Array.isArray(data?.nodes) ? data.nodes : [];
}

// A card: a thumbnail, then the track's title (two lines at most), its artist and year (two
// lines at most) and a tag for this track or an origin, in the graph's 12 px text.
const PAD = 6;
const THUMB = 28;
const TEXT_GAP = 8;
const LINE_PX = 15;
/** A character's width in the graph's monospace text. */
const CHAR_PX = labelWidth('x', NODE_LABEL_PX);
/** A card's text is never narrower than this many characters, nor (horizontal) wider than this. */
const MIN_CHARS = 12;
const MAX_TEXT_PX = 240;
const cardWidth = (textWidth: number) => PAD + THUMB + TEXT_GAP + textWidth + PAD;
const chipHeight = LINE_LABEL_PX + 6;
const chipWidth = (text: string) => labelWidth(text, LINE_LABEL_PX) + 10;
/** Room kept round a card or a link the keyboard brings into view (screen px). */
const VIEW_PAD = 12;

// The map's margins: room for the year axis and (vertical) the links' arcs to the right of the
// cards. The panel's heading is above the map, not over it.
const MARGIN: Record<Orientation, { top: number; right: number; bottom: number; left: number }> = {
  horizontal: { top: 8, right: 24, bottom: 16, left: 16 },
  vertical: { top: 8, right: 26, bottom: 16, left: 22 },
};

/** How wide a card's text is: as wide as the longest words need for two lines, as the room allows. */
function textWidthFor(panelWidth: number, orientation: Orientation, chars: number): number {
  const need = Math.max(MIN_CHARS, chars) * CHAR_PX;
  const margin = MARGIN[orientation];
  const room =
    orientation === 'vertical'
      ? panelWidth - margin.left - margin.right - cardWidth(0)
      : MAX_TEXT_PX;
  return Math.ceil(Math.max(MIN_CHARS * CHAR_PX, Math.min(need, room)));
}

/** A point on a cubic Bézier curve at t. */
function bezier(
  [p0, p1, p2, p3]: Array<{ x: number; y: number }>,
  t: number,
): { x: number; y: number } {
  const u = 1 - t;
  const [a, b, c, d] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return {
    x: a * p0.x + b * p1.x + c * p2.x + d * p3.x,
    y: a * p0.y + b * p1.y + c * p2.y + d * p3.y,
  };
}

/**
 * A link's curve from its source card to its target card: between facing sides when the cards
 * stand apart across the page, else an arc out to the right of both and of every card between
 * them (cards in a column), its bulge growing with the distance up to `maxBulge`, so the arc runs
 * beside the cards it passes rather than under them.
 */
function edgeCurve(a: CardBox, b: CardBox, maxBulge: number, cards: readonly CardBox[]) {
  const [ay, by] = [a.y + a.height / 2, b.y + b.height / 2];
  if (a.x + a.width < b.x || b.x + b.width < a.x) {
    const forward = a.x < b.x;
    const start = { x: forward ? a.x + a.width : a.x, y: ay };
    const end = { x: forward ? b.x : b.x + b.width, y: by };
    const half = (end.x - start.x) / 2;
    return [start, { x: start.x + half, y: ay }, { x: end.x - half, y: by }, end];
  }
  const start = { x: a.x + a.width, y: ay };
  const end = { x: b.x + b.width, y: by };
  const [top, bottom] = [Math.min(ay, by), Math.max(ay, by)];
  const rail = Math.max(
    start.x,
    end.x,
    ...cards.filter((c) => c.y < bottom && c.y + c.height > top).map((c) => c.x + c.width),
  );
  const bulge = Math.min(maxBulge, 14 + (bottom - top) * 0.15);
  // The curve's middle is a quarter of its ends' x and three quarters of its controls': the
  // controls go far enough out for the middle to clear the rail by three quarters of the bulge.
  const out = rail + bulge + (rail - Math.min(start.x, end.x)) / 3;
  return [start, { x: out, y: ay }, { x: out, y: by }, end];
}

const pathOf = ([p0, p1, p2, p3]: Array<{ x: number; y: number }>) =>
  `M${p0.x},${p0.y} C${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y}`;

const GenealogyGraph: React.FC<GenealogyGraphProps> = ({
  data,
  evidence,
  claims,
  releaseYear,
  hiddenLinks = 0,
  topInset = 0,
  onNodeClick,
  wheelZoom = 'plain',
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // The links that can be drawn (one to an unknown node id is left out), each read with the
  // contract's link schema and shown by its rule and this app's stricter ones; links whose claim
  // the verifier contradicted are left out.
  const reading = useMemo(
    () => readGenealogy(data, linkContext(evidence, claims, { releaseYear })),
    [data, evidence, claims, releaseYear],
  );
  const links = reading.links;
  const hidden = reading.hidden + hiddenLinks;
  const named = useMemo(() => nodesById(data?.nodes, yearFrom(releaseYear)), [data, releaseYear]);
  const nameOf = useMemo(() => (id: string) => nodeName(named.get(id), id), [named]);
  // A track's year: the one its label ends with or the API took from MusicBrainz (the analysed
  // track's, else the result's release year); null when it carries none.
  const yearOfNode = useMemo(() => (id: string) => yearOf(named.get(id)), [named]);
  const currentId = useMemo(
    () => graphNodes(data).find((node) => node.group === 1)?.id ?? null,
    [data],
  );
  // With two relations or fewer the map is a compact row, not a canvas.
  const sparse = isSparse(links.length);
  // What the pointer is on, and what keyboard focus is on: the detail shows the first of them,
  // so moving the pointer away does not take the focused item's detail with it.
  const [hovered, setHovered] = useState<Item | null>(null);
  const [focused, setFocused] = useState<Item | null>(null);
  // The item whose detail box Escape closed: the box stays closed until the pointer or the focus
  // moves to another item (and the next Escape is the Player's).
  const [dismissed, setDismissed] = useState<Item | null>(null);
  // Closes the open detail box; false when none is open. Read by the drawing's key handler.
  const dismissRef = useRef<() => boolean>(() => false);
  // Another item under the pointer or the focus (or the same one again) shows its box again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when what is pointed at changes
  useEffect(() => {
    setDismissed(null);
  }, [hovered, focused]);

  // Audio preview (extracted hook)
  const {
    isPlaying,
    playingNodeId,
    hasPreviewSupport,
    blockedNodeId,
    unavailableNodeId,
    playPreview,
    stopPreview,
  } = useAudioPreview();

  // Ids in the drawing: this graph's own prefix (an id may hold only letters, digits, - and _)
  // and the track's index, never the track's id, which may hold any character.
  const clipPrefix = `genealogy${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;

  // What the wheel does, read by the zoom's filter at each event: a change does not draw the
  // graph again.
  const wheelZoomRef = useRef(wheelZoom);
  useEffect(() => {
    wheelZoomRef.current = wheelZoom;
  }, [wheelZoom]);

  // The analysis callback, read when a track is chosen: a new one does not draw the graph again.
  const onNodeClickRef = useRef(onNodeClick);
  useEffect(() => {
    onNodeClickRef.current = onNodeClick;
  }, [onNodeClick]);

  /** Analyses a track (never the current one), read when a track is chosen. */
  const analyseRef = useRef<(d: GenealogyNode) => void>(() => {});
  useEffect(() => {
    analyseRef.current = (d) => {
      if (d.group === 1) return;
      stopPreview();
      onNodeClickRef.current?.({
        id: d.id,
        group: d.group,
        label: d.label,
        img: d.img,
        size: d.size,
        previewUrl: d.previewUrl,
        spotifyId: d.spotifyId,
        trackTitle: d.trackTitle,
        trackArtist: d.trackArtist,
      });
    };
  }, [stopPreview]);

  // Each track's relation to the analysed one, from the link that joins them.
  const relations = useMemo(
    () => new Map(graphNodes(data).map((n) => [n.id, relationToTrack(links, n.id, currentId)])),
    [data, links, currentId],
  );
  // Tracks a sourced sample, interpolation, cover or remix says the analysed track uses.
  const isOrigin = useMemo(
    () => (id: string) => {
      const relation = relations.get(id);
      return (
        currentId !== null &&
        id !== currentId &&
        relation !== undefined &&
        isDocumentedSource(relation, id)
      );
    },
    [relations, currentId],
  );
  const nodeAriaLabel = useMemo(
    () => (d: GenealogyNode) => {
      const name = nameOf(d.id);
      if (d.group === 1) return `${name}, the analyzed track`;
      const link = relations.get(d.id)?.link;
      const said = link
        ? `${relationSentence(link, nameOf)}. ${provenanceText(link)}.`
        : 'No direct link to the analyzed track.';
      return `${name}: ${said} Press Enter to analyze it.`;
    },
    [nameOf, relations],
  );

  // The characters a card's line needs so that no title, artist or year is cut in two lines.
  const needChars = useMemo(
    () =>
      Math.max(
        MIN_CHARS,
        ...graphNodes(data).map((node) => {
          const { title, meta } = cardWords(node, yearOfNode(node.id));
          return Math.max(charsToWrap(title), charsToWrap(meta), 'This track'.length);
        }),
      ),
    [data, yearOfNode],
  );

  // The graph's size on screen (ResizeObserver) and the window's width. The layout depends on
  // the axis's direction and the cards' width, which the size sets: while they hold, a resize
  // keeps the drawing and its zoom and shifts the view so the map stays where it was in the
  // panel (`resizeRef`, set by the drawing). A hidden panel (the phone tabs) measures 0 by 0:
  // the graph keeps its last size.
  // The band the panel's heading covers at the top: the view keeps the map below it. A taller
  // heading (it wraps on a narrower panel) moves the view down by as much; nothing is drawn
  // again.
  const insetRef = useRef(topInset);
  const insetShiftRef = useRef<((by: number) => void) | null>(null);
  useEffect(() => {
    const by = topInset - insetRef.current;
    insetRef.current = topInset;
    if (by > 0) insetShiftRef.current?.(by);
  }, [topInset]);
  const sizeRef = useRef<{ width: number; height: number } | null>(null);
  const resizeRef = useRef<((size: { width: number; height: number }) => void) | null>(null);
  const [panel, setPanel] = useState<{ width: number; height: number; viewport: number } | null>(
    null,
  );

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (sparse || !wrapper) return;
    const resizeObserver = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || box.width === 0 || box.height === 0) return;
      const { width, height } = box;
      const last = sizeRef.current;
      if (last && last.width === width && last.height === height) return;
      sizeRef.current = { width, height };
      setPanel({ width, height, viewport: window.innerWidth });
    });
    resizeObserver.observe(wrapper);
    return () => resizeObserver.disconnect();
  }, [sparse]);

  const orientation = panel ? orientationFor(panel.viewport, panel.width) : null;
  const textWidth = panel && orientation ? textWidthFor(panel.width, orientation, needChars) : null;

  // Under reduced motion nothing glides or fades.
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const size = sizeRef.current;
    if (sparse || !svgRef.current || !size || orientation === null || textWidth === null) return;

    // 1. Setup & Cleanup
    const svg = select(svgRef.current);
    svg.selectAll('*').remove();
    // Listeners added here outside d3 (focus and blur), removed when the drawing goes.
    const listening: Array<{ element: SVGElement; type: string; listener: () => void }> = [];

    // A hint shown on hover fades in, or appears at once under reduced motion.
    const fadeIn = (hint: Selection<SVGGElement, unknown, null, undefined>) => {
      if (reducedMotion) hint.style('opacity', 1);
      else hint.style('opacity', 0).transition().duration(300).style('opacity', 1);
    };

    let { width, height } = size;
    svg.attr('width', width).attr('height', height);

    // 2. The glow of this track's card and of the origins', and an arrowhead per relation.
    const defs = svg.append('defs');
    for (const name of ['cyan', 'amber']) {
      const filter = defs.append('filter').attr('id', `${clipPrefix}-glow-${name}`);
      filter.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'coloredBlur');
      const merge = filter.append('feMerge');
      merge.append('feMergeNode').attr('in', 'coloredBlur');
      merge.append('feMergeNode').attr('in', 'SourceGraphic');
    }
    const arrowId = (type: LinkType) => `${clipPrefix}-arrow-${type}`;
    for (const type of LINK_TYPES) {
      defs
        .append('marker')
        .attr('id', arrowId(type))
        .attr('viewBox', '0 0 10 10')
        .attr('refX', 9)
        .attr('refY', 5)
        .attr('markerWidth', 8)
        .attr('markerHeight', 8)
        .attr('markerUnits', 'userSpaceOnUse')
        .attr('orient', 'auto')
        .append('path')
        .attr('d', 'M0,0 L10,5 L0,10 z')
        .attr('fill', LINK_COLOR[type]);
    }

    // 3. The cards and their places on the year axis.
    const margin = MARGIN[orientation];
    const chars = Math.max(MIN_CHARS, Math.floor(textWidth / CHAR_PX));
    const nodes = graphNodes(data).map((node, i) => {
      const year = yearOfNode(node.id);
      const { title, meta } = cardWords(node, year);
      const tag = node.id === currentId ? 'This track' : isOrigin(node.id) ? 'Origin' : null;
      const titleLines = wrapText(title, chars).lines;
      const metaLines = meta ? wrapText(meta, chars).lines : [];
      const lines = titleLines.length + metaLines.length + (tag ? 1 : 0);
      return {
        node,
        i,
        id: node.id,
        year,
        title,
        meta,
        tag,
        titleLines,
        metaLines,
        width: cardWidth(textWidth),
        height: PAD * 2 + Math.max(THUMB, lines * LINE_PX),
        lane: laneOf(node.id === currentId, relations.get(node.id)?.link?.type ?? null),
      };
    });
    type Card = (typeof nodes)[number];
    const layout = layoutLineage(nodes, {
      orientation,
      gap: 10,
      slotGap: orientation === 'horizontal' ? 40 : 18,
      axisSize: orientation === 'horizontal' ? 22 : 20,
      crossSpace: width - margin.left - margin.right,
      margin,
    });
    const boxOf = (id: string) => layout.cards.get(id) ?? { x: 0, y: 0, width: 0, height: 0 };
    const cardBoxes = nodes.map((d) => boxOf(d.id));

    // 4. Zoom: the map is drawn at its size (its text at 12 px), panned to see what does not
    // fit, and zoomed in, never out past its size.
    const g = svg.append('g');
    let transform: ZoomTransform = zoomIdentity;
    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 4])
      // Where the page scrolls past the graph ('modifier'), the graph takes no gesture the page
      // needs: the wheel zooms only with Ctrl or ⌘ held, and on a touch screen one finger
      // scrolls the page while two pinch and pan the graph (the svg's touch-action lets the
      // browser have the one-finger vertical pan). Elsewhere the wheel zooms, one finger pans,
      // and a drag pans and a touch pinch zooms as before (d3's own rule: no Ctrl-drag, primary
      // button only).
      .filter((event: Event) => {
        const modifier = wheelZoomRef.current === 'modifier';
        if (event.type === 'wheel') {
          const wheel = event as WheelEvent;
          return !modifier || wheel.ctrlKey || wheel.metaKey;
        }
        if (event.type === 'touchstart' && modifier) {
          return (event as TouchEvent).touches.length >= 2;
        }
        const pointer = event as MouseEvent;
        return !pointer.ctrlKey && !pointer.button;
      })
      // d3 speeds a wheel with Ctrl up tenfold, for a trackpad pinch's small steps: a mouse
      // wheel's notch (a step of 50 px or more) keeps the plain rate.
      .wheelDelta((event: WheelEvent) => {
        const rate = event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002;
        const pinch = event.ctrlKey && event.deltaMode === 0 && Math.abs(event.deltaY) < 50;
        return -event.deltaY * rate * (pinch ? 10 : 1);
      })
      // A double click zooms in a glide, or at once under reduced motion.
      .duration(reducedMotion ? 0 : 250)
      .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        transform = event.transform;
        g.attr('transform', event.transform.toString());
        drawChips();
      });
    svg.call(zoomBehavior);

    // 5. The year axis: a label for each year a card carries, and "Undated" for the rest.
    const axis = g.append('g').attr('class', 'lineage-axis').attr('aria-hidden', 'true');
    const yearLabels: CardBox[] = [];
    const lineColor = colors.gray[600];
    if (orientation === 'horizontal') {
      const y = margin.top + 14;
      axis
        .append('line')
        .attr('x1', margin.left)
        .attr('x2', layout.width - margin.right)
        .attr('y1', y + 5)
        .attr('y2', y + 5)
        .attr('stroke', lineColor);
      for (const slot of layout.slots) {
        const x = slot.start + slot.size / 2;
        axis
          .append('text')
          .attr('class', 'year-tick')
          .attr('x', x)
          .attr('y', y)
          .attr('text-anchor', 'middle')
          .attr('fill', colors.gray[400])
          .attr('font-family', 'IBM Plex Mono')
          .attr('font-size', `${GRAPH_TEXT_PX}px`)
          .text(slot.label);
        const w = labelWidth(slot.label, GRAPH_TEXT_PX);
        yearLabels.push({ x: x - w / 2, y: y - 12, width: w, height: 16 });
      }
    } else {
      const x = margin.left - 14;
      axis
        .append('line')
        .attr('x1', x)
        .attr('x2', x)
        .attr('y1', layout.slots[0]?.start ?? 0)
        .attr('y2', layout.height - margin.bottom)
        .attr('stroke', lineColor);
      for (const slot of layout.slots) {
        axis
          .append('circle')
          .attr('cx', x)
          .attr('cy', slot.start + 9)
          .attr('r', 3)
          .attr('fill', colors.gray[400]);
        axis
          .append('text')
          .attr('class', 'year-tick')
          .attr('x', margin.left)
          .attr('y', slot.start + 13)
          .attr('fill', colors.gray[400])
          .attr('font-family', 'IBM Plex Mono')
          .attr('font-size', `${GRAPH_TEXT_PX}px`)
          .text(slot.label);
        yearLabels.push({
          x: margin.left,
          y: slot.start,
          width: labelWidth(slot.label, GRAPH_TEXT_PX),
          height: 16,
        });
      }
    }

    // 6. Links: the colour is the relation a link is shown as, the line its kind (solid when
    // sourced, dashed when not), and an arrowhead its direction (from the earlier record to the
    // one that uses it; none when the direction is unknown, or for a shared producer).
    const maxBulge = orientation === 'vertical' ? (margin.right - 4) / 0.75 : (40 * 0.8) / 0.75;
    const simulationLinks = links.map((shown, n) => {
      const curve = edgeCurve(boxOf(shown.source), boxOf(shown.target), maxBulge, cardBoxes);
      return { shown, n, curve, d: pathOf(curve) };
    });
    type DrawnLink = (typeof simulationLinks)[number];
    const restingOpacity = (d: DrawnLink) => LINK_OPACITY[d.shown.kind];
    const link = g
      .append('g')
      .attr('class', 'links')
      .attr('aria-hidden', 'true')
      .selectAll('path')
      .data(simulationLinks)
      .join('path')
      .attr('d', (d) => d.d)
      .attr('fill', 'none')
      .attr('data-link-index', (d) => d.n)
      .attr('data-link-kind', (d) => d.shown.kind)
      .attr('data-link-type', (d) => d.shown.type)
      .attr('stroke', (d) => LINK_COLOR[d.shown.type])
      .attr('stroke-opacity', restingOpacity)
      .attr('stroke-width', (d) => linkWidth(d.shown.value, d.shown.kind))
      .attr('stroke-dasharray', (d) => LINK_DASH[d.shown.kind])
      .attr('marker-end', (d) =>
        d.shown.directionKnown && d.shown.type !== 'producer'
          ? `url(#${arrowId(d.shown.type)})`
          : null,
      )
      .attr('vector-effect', 'non-scaling-stroke');

    // A wider, invisible line over each link: pointing at it or focusing it shows the link's
    // relation and where it comes from; focused, it shows a band of its own as a focus ring.
    const linkTarget = g
      .append('g')
      .attr('class', 'link-targets')
      .selectAll('path')
      .data(simulationLinks)
      .join('path')
      .attr('d', (d) => d.d)
      .attr('fill', 'none')
      .attr('data-link-index', (d) => d.n)
      .attr('stroke', colors.cyber)
      .attr('stroke-opacity', 0)
      .attr('stroke-width', 12)
      .attr('vector-effect', 'non-scaling-stroke')
      .style('pointer-events', 'stroke')
      .style('outline', 'none')
      .attr('tabindex', -1)
      .attr('aria-label', (d) => describeLink(d.shown, nameOf));

    // 7. The cards, drawn over the links (a card is opaque: no line runs over its words).
    const node = g
      .append('g')
      .attr('class', 'nodes')
      .selectAll<SVGGElement, Card>('g')
      .data(nodes)
      .join('g')
      .attr('cursor', 'pointer')
      .attr('data-node-id', (d) => d.id)
      .attr('data-title', (d) => d.title)
      .attr('data-meta', (d) => d.meta)
      .attr('transform', (d) => {
        const box = boxOf(d.id);
        return `translate(${box.x},${box.y})`;
      })
      .attr('tabindex', -1)
      .attr('role', (d) => (d.node.group === 1 ? 'img' : 'button'))
      .attr('aria-label', (d) => nodeAriaLabel(d.node))
      .style('outline', 'none');

    // The card's frame: this track's in the measured cyan, an origin's in the sourced amber,
    // with their glow; the others outlined in white (3:1 or more on the page).
    node
      .append('rect')
      .attr('class', 'card')
      .attr('width', (d) => d.width)
      .attr('height', (d) => d.height)
      .attr('rx', 4)
      .attr('fill', colors.voidLighter)
      .attr('stroke', (d) =>
        d.id === currentId
          ? genealogyColors.current
          : isOrigin(d.id)
            ? genealogyColors.origin
            : colors.white,
      )
      .attr('stroke-width', (d) => (d.id === currentId ? 2 : 1.5))
      .attr('stroke-opacity', (d) => (d.id === currentId || isOrigin(d.id) ? 0.9 : 0.5))
      .attr('vector-effect', 'non-scaling-stroke')
      .style('filter', (d) =>
        d.id === currentId
          ? `url(#${clipPrefix}-glow-cyan)`
          : isOrigin(d.id)
            ? `url(#${clipPrefix}-glow-amber)`
            : 'none',
      );

    // The focus ring, shown while keyboard focus is on the card.
    node
      .append('rect')
      .attr('class', 'focus-ring')
      .attr('x', -4)
      .attr('y', -4)
      .attr('width', (d) => d.width + 8)
      .attr('height', (d) => d.height + 8)
      .attr('rx', 6)
      .attr('fill', 'none')
      .attr('stroke', colors.cyber)
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '4 3')
      .attr('opacity', 0)
      .style('pointer-events', 'none');

    // The thumbnail: the cover when the track has one, else the neutral placeholder.
    node.each(function (d) {
      const group = select(this);
      const clipId = `${clipPrefix}-clip-${d.i}`;
      group
        .append('clipPath')
        .attr('id', clipId)
        .append('rect')
        .attr('x', PAD)
        .attr('y', PAD)
        .attr('width', THUMB)
        .attr('height', THUMB)
        .attr('rx', 3);
      group
        .append('image')
        .attr(
          'href',
          isValidImageUrl(d.node.img) ? (d.node.img as string) : placeholderImage(THUMB / 2),
        )
        .attr('x', PAD)
        .attr('y', PAD)
        .attr('width', THUMB)
        .attr('height', THUMB)
        .attr('preserveAspectRatio', 'xMidYMid slice')
        .attr('clip-path', `url(#${clipId})`);
    });

    // The words: the title, then the artist and year, then the tag, each line at 12 px.
    const textX = PAD + THUMB + TEXT_GAP;
    const words = node.append('g').attr('class', 'node-label').style('pointer-events', 'none');
    const lineText = (
      className: string,
      lines: (d: Card) => string[],
      first: (d: Card) => number,
      fill: (d: Card) => string,
    ) => {
      words
        .append('text')
        .attr('class', className)
        .attr('x', textX)
        .attr('fill', fill)
        .attr('font-family', 'IBM Plex Mono')
        .attr('font-size', `${NODE_LABEL_PX}px`)
        .each(function (d) {
          const text = select(this);
          lines(d).forEach((line, index) => {
            text
              .append('tspan')
              .attr('x', textX)
              .attr('y', PAD + 11 + (first(d) + index) * LINE_PX)
              .text(line);
          });
        });
    };
    lineText(
      'card-title',
      (d) => d.titleLines,
      () => 0,
      () => colors.white,
    );
    lineText(
      'card-meta',
      (d) => d.metaLines,
      (d) => d.titleLines.length,
      () => colors.gray[400],
    );
    words
      .filter((d) => d.tag !== null)
      .append('text')
      .attr('class', 'sub-label')
      .attr('x', textX)
      .attr('y', (d) => PAD + 11 + (d.titleLines.length + d.metaLines.length) * LINE_PX)
      .attr('fill', (d) => (d.id === currentId ? genealogyColors.current : genealogyColors.origin))
      .attr('font-family', 'IBM Plex Mono')
      .attr('font-size', `${SUB_LABEL_PX}px`)
      .text((d) => d.tag ?? '');

    // A card's own drawing is decorative for screen readers: its name says it all.
    node.selectChildren().attr('aria-hidden', 'true');

    // 8. Chips: a link's relation, shown while the pointer or the focus is on the link or on a
    // card it joins, placed clear of every card and year label; a chip with no free place is
    // left out (the detail box says the same). An origin's card also says a click analyses it.
    const chips = g
      .append('g')
      .attr('class', 'link-chips')
      .attr('aria-hidden', 'true')
      .style('pointer-events', 'none');
    const obstacles = [...cardBoxes, ...yearLabels];
    let pointerOn: Item | null = null;
    let focusOn: Item | null = null;
    let hint: string | null = null;

    function drawChips() {
      chips.selectAll('*').remove();
      const active = pointerOn ?? focusOn;
      if (!active) return;
      const k = transform.k || 1;
      // What is in view, in the map's units, below the panel's heading.
      const view = {
        x: -transform.x / k,
        y: (insetRef.current - transform.y) / k,
        width: width / k,
        height: Math.max(0, height - insetRef.current) / k,
      };
      const shown =
        active.kind === 'link'
          ? simulationLinks.filter((d) => d.n === active.index)
          : simulationLinks
              .filter((d) => d.shown.source === active.id || d.shown.target === active.id)
              .sort((a, b) => rank(b.shown) - rank(a.shown));
      const wanted: Array<ChipInput & { text: string; link: DrawnLink | null }> = shown.map(
        (d, order) => ({
          near: bezier(d.curve, 0.5),
          width: chipWidth(lineLabel(d.shown)),
          height: chipHeight,
          priority: -order,
          text: lineLabel(d.shown),
          link: d,
        }),
      );
      if (active.kind === 'node' && hint === active.id) {
        const box = boxOf(active.id);
        wanted.unshift({
          near: { x: box.x + box.width / 2, y: box.y - chipHeight / 2 - 4 },
          width: chipWidth('Analyze this track'),
          height: chipHeight,
          priority: 1,
          text: 'Analyze this track',
          link: null,
        });
      }
      const at = placeChips(wanted, obstacles, view);
      wanted.forEach((chip, index) => {
        const box = at[index];
        if (!box) return;
        const group = chips
          .append('g')
          .attr('class', chip.link ? 'chip' : 'chip hint')
          .attr('transform', `translate(${box.x},${box.y})`);
        if (chip.link) group.attr('data-link-index', chip.link.n);
        group
          .append('rect')
          .attr('width', box.width)
          .attr('height', box.height)
          .attr('rx', 3)
          .attr('fill', colors.void)
          .attr('stroke', chip.link ? LINK_COLOR[chip.link.shown.type] : colors.gray[600])
          .attr('stroke-dasharray', chip.link ? LINK_DASH[chip.link.shown.kind] : 'none')
          .attr('vector-effect', 'non-scaling-stroke');
        group
          .append('text')
          .attr('class', chip.link ? null : 'preview-indicator')
          .attr('x', 5)
          .attr('y', box.height - 6)
          .attr('fill', chip.link ? colors.white : colors.gray[400])
          .attr('font-family', 'IBM Plex Mono')
          .attr('font-size', `${LINE_LABEL_PX}px`)
          .text(chip.text);
        if (!chip.link) fadeIn(group);
      });
    }

    // 9. Interactions: what the pointer and keyboard focus are on (the detail box is React's;
    // this draws the rest).
    const drawActive = () => {
      const active = pointerOn ?? focusOn;
      const activeLink = active?.kind === 'link' ? active.index : null;
      const activeNode = active?.kind === 'node' ? active.id : null;
      const touches = (d: DrawnLink) =>
        activeNode !== null && (d.shown.source === activeNode || d.shown.target === activeNode);
      link
        .attr('stroke-opacity', (d) =>
          activeLink === null && activeNode === null
            ? restingOpacity(d)
            : d.n === activeLink || touches(d)
              ? 1
              : 0.15,
        )
        .attr(
          'stroke-width',
          (d) =>
            linkWidth(d.shown.value, d.shown.kind) * (d.n === activeLink || touches(d) ? 1.8 : 1),
        );
      // The cards the pointed track is not joined to fade back.
      const joined = new Set(
        activeNode === null
          ? []
          : [
              activeNode,
              ...links.flatMap((l) =>
                l.source === activeNode ? [l.target] : l.target === activeNode ? [l.source] : [],
              ),
            ],
      );
      node.style('opacity', (d) => (activeNode === null || joined.has(d.id) ? null : '0.45'));
      // The focus ring: a band along a focused link, a dashed ring round a focused card.
      linkTarget.attr('stroke-opacity', (d) =>
        focusOn?.kind === 'link' && focusOn.index === d.n ? 0.3 : 0,
      );
      node
        .select('.focus-ring')
        .attr('opacity', (d) => (focusOn?.kind === 'node' && focusOn.id === d.id ? 1 : 0));
      drawChips();
    };
    const pointAt = (item: Item | null) => {
      pointerOn = item;
      drawActive();
      setHovered(item);
    };

    /**
     * Pans the view, at once and no further than it takes, so a focused card or the middle of a
     * focused link is in it.
     */
    const bringIntoView = (item: Item) => {
      const box =
        item.kind === 'node'
          ? boxOf(item.id)
          : (() => {
              const middle = bezier(simulationLinks[item.index].curve, 0.5);
              return { x: middle.x - 1, y: middle.y - 1, width: 2, height: 2 };
            })();
      const k = transform.k || 1;
      const [left, top] = [transform.x + box.x * k, transform.y + box.y * k];
      const [right, bottom] = [left + box.width * k, top + box.height * k];
      // The least move that brings a side into view (the near side first, if both are out).
      const shift = (low: number, high: number, size: number) =>
        low < VIEW_PAD ? VIEW_PAD - low : high > size - VIEW_PAD ? size - VIEW_PAD - high : 0;
      const [dx, dy] = [
        shift(left, right, width),
        shift(top - insetRef.current, bottom - insetRef.current, height - insetRef.current),
      ];
      if (dx !== 0 || dy !== 0) svg.call(zoomBehavior.translateBy, dx / k, dy / k);
    };

    // Keyboard: one tab stop for the whole graph (roving tabindex). The arrow keys move between
    // the tracks, then the links; Home and End go to the first and the last; Enter or Space
    // analyses the focused track.
    const items: Array<{ item: Item; element: SVGElement }> = [
      ...node.nodes().map((element, i) => ({
        item: { kind: 'node', id: nodes[i].id } as Item,
        element: element as SVGElement,
      })),
      ...linkTarget.nodes().map((element, i) => ({
        item: { kind: 'link', index: simulationLinks[i].n } as Item,
        element: element as SVGElement,
      })),
    ];
    const setRoving = (index: number) => {
      items.forEach(({ element }, i) => {
        element.setAttribute('tabindex', i === index ? '0' : '-1');
      });
    };
    setRoving(0);
    const listen = (element: SVGElement, type: string, listener: () => void) => {
      element.addEventListener(type, listener);
      listening.push({ element, type, listener });
    };
    items.forEach(({ item, element }, i) => {
      listen(element, 'focus', () => {
        setRoving(i);
        focusOn = item;
        bringIntoView(item);
        drawActive();
        setFocused(item);
      });
      listen(element, 'blur', () => {
        if (!sameItem(focusOn, item)) return;
        focusOn = null;
        drawActive();
        setFocused(null);
      });
    });
    svg.on('keydown', (event: KeyboardEvent) => {
      if (items.length === 0) return;
      const at = items.findIndex(({ element }) => element === event.target);
      if (at === -1) return;
      // Escape closes the focused item's detail box first; with none open it is the Player's.
      if (event.key === 'Escape') {
        if (dismissRef.current()) event.preventDefault();
        return;
      }
      const last = items.length - 1;
      const next =
        event.key === 'ArrowRight' || event.key === 'ArrowDown'
          ? Math.min(at + 1, last)
          : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? Math.max(at - 1, 0)
            : event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? last
                : null;
      if (next !== null) {
        event.preventDefault();
        setRoving(next);
        items[next].element.focus();
        return;
      }
      const { item } = items[at];
      if ((event.key === 'Enter' || event.key === ' ') && item.kind === 'node') {
        event.preventDefault();
        const d = nodes.find((n) => n.id === item.id);
        if (d) analyseRef.current(d.node);
      }
    });

    linkTarget
      .on('mouseenter', (_event, d) => pointAt({ kind: 'link', index: d.n }))
      .on('mouseleave', () => pointAt(null));

    node
      .on('mouseenter', (_event, d) => {
        // An origin says a click analyses the track, whether or not it has a clip. No hint
        // names a preview: previews play from their own buttons (PreviewList).
        hint = isOrigin(d.id) ? d.id : null;
        pointAt({ kind: 'node', id: d.id });
      })
      .on('mouseleave', () => {
        hint = null;
        pointAt(null);
      })
      // A click analyses the track.
      .on('click', (event, d) => {
        event.stopPropagation();
        analyseRef.current(d.node);
      });

    // The first view: the map at its size, below the panel's heading (which lies over the top of
    // the map). Across each direction a map smaller than the room is centred in it; a larger one
    // shows this track's card in the middle of the room, as far as the map allows (no empty band
    // past its edge).
    const anchor = boxOf(currentId ?? nodes[0]?.id ?? '');
    const offset = (map: number, panel: number, middle: number, from = 0) =>
      map <= panel - from
        ? from + (panel - from - map) / 2
        : Math.min(from, Math.max(panel - map, (from + panel) / 2 - middle));
    svg.call(
      zoomBehavior.transform,
      zoomIdentity.translate(
        offset(layout.width, width, anchor.x + anchor.width / 2),
        offset(layout.height, height, anchor.y + anchor.height / 2, insetRef.current),
      ),
    );

    insetShiftRef.current = (by) => {
      svg.call(zoomBehavior.translateBy, 0, by / (transform.k || 1));
    };

    // A resize that keeps the axis and the cards' width keeps the drawing and its zoom: the svg
    // takes the new size, and the view moves by half the change, so what was at the middle of
    // the panel is at its middle again.
    resizeRef.current = (next) => {
      const [dx, dy] = [(next.width - width) / 2, (next.height - height) / 2];
      ({ width, height } = next);
      svg.attr('width', width).attr('height', height);
      const k = transform.k || 1;
      svg.call(zoomBehavior.translateBy, dx / k, dy / k);
    };

    // Everything the drawing started stops with it: transitions (the hint's fade, a double
    // click's zoom) and their timers, and every listener on the svg and its elements.
    return () => {
      resizeRef.current = null;
      insetShiftRef.current = null;
      svg.interrupt();
      svg.selectAll('*').interrupt();
      svg.on('.zoom', null).on('keydown', null);
      node.on('mouseenter', null).on('mouseleave', null).on('click', null);
      linkTarget.on('mouseenter', null).on('mouseleave', null);
      for (const { element, type, listener } of listening) {
        element.removeEventListener(type, listener);
      }
      setHovered(null);
      setFocused(null);
    };
  }, [
    sparse,
    data,
    links,
    nameOf,
    yearOfNode,
    currentId,
    relations,
    isOrigin,
    nodeAriaLabel,
    orientation,
    textWidth,
    clipPrefix,
    reducedMotion,
  ]);

  // A resize the drawing keeps (see `resizeRef`).
  useEffect(() => {
    if (panel) resizeRef.current?.(panel);
  }, [panel]);

  const nodeList = graphNodes(data);
  const related = nodeList.filter((node) => node.group !== 1);
  // The gestures, in words, as the graph takes them here (see the zoom's filter).
  const touch = useNoHover();
  const hints =
    wheelZoom === 'modifier'
      ? touch
        ? [
            'Pinch with two fingers to zoom',
            'Drag with two fingers to pan',
            'Tap a track to analyze it',
          ]
        : ['Ctrl or ⌘ + scroll to zoom', 'Drag to pan', 'Click a track to analyze it']
      : touch
        ? ['Pinch to zoom', 'Drag to pan', 'Tap a track to analyze it']
        : ['Scroll to zoom', 'Drag to pan', 'Click a track to analyze it'];
  const pointed = hovered ?? focused;
  const active = sameItem(pointed, dismissed) ? null : pointed;
  useEffect(() => {
    dismissRef.current = () => {
      if (active === null) return false;
      setDismissed(active);
      return true;
    };
  }, [active]);
  const activeLink = active?.kind === 'link' ? (links[active.index] ?? null) : null;
  const activeNode =
    active?.kind === 'node' ? (nodeList.find((node) => node.id === active.id) ?? null) : null;
  const activeRelation = activeNode ? relationToTrack(links, activeNode.id, currentId) : null;
  const keyboardOnNode = focused?.kind === 'node' && sameItem(active, focused);
  // Every drawn related track with a clip, whether or not a shown link names it: each has its
  // preview button (PreviewList).
  const previewTracks = previewTracksOf(data);

  // P2:22 — Accessible summary for screen readers: each track's relation comes from the link
  // that joins it to this one, never from its group.
  const summary = (
    <div className="sr-only">
      Connections
      {related.length > 0
        ? `: ${related.length} related ${related.length === 1 ? 'track' : 'tracks'}`
        : ''}
      .
      {nodeList
        .map((node) => {
          if (node.group === 1) return ` ${nameOf(node.id)}: the analyzed track.`;
          // Which track uses which, as a sentence naming both, and how it is known.
          const relation = relationToTrack(links, node.id, currentId);
          return relation.link
            ? ` ${nameOf(node.id)}: ${relationSentence(relation.link, nameOf)} (${kindLabel(relation.link)}).`
            : ` ${nameOf(node.id)}: ${relation.text.toLowerCase()}.`;
        })
        .join('')}
      {!sparse &&
        links.length > 0 &&
        ' In the graph, the arrow keys move between the tracks and the links; Enter analyzes the focused track.'}
    </div>
  );

  // Whether a preview plays, or why it cannot: shown on the map and on the compact row alike.
  const previewState = (
    <>
      {isPlaying && playingNodeId && (
        <div className="absolute top-4 right-4 pointer-events-none">
          <div className="flex items-center gap-2 text-text-secondary text-xs font-mono bg-black/80 px-3 py-1.5 rounded border border-white/10 animate-pulse">
            <Volume2 size={12} className="animate-bounce" />
            <span>Playing preview…</span>
          </div>
        </div>
      )}

      {/* Which track's preview failed, in words: the region is in the page from the start, so
          a message put in it is announced (the badges below show it, and are not read). */}
      <p role="status" className="sr-only">
        {!hasPreviewSupport && blockedNodeId
          ? `Preview of ${nameOf(blockedNodeId)} was blocked by the browser.`
          : hasPreviewSupport && unavailableNodeId
            ? `Preview of ${nameOf(unavailableNodeId)} is unavailable.`
            : ''}
      </p>

      {/* No Preview Support Warning (browsers may block autoplay) */}
      {!hasPreviewSupport && (
        <div className="absolute top-4 right-4 pointer-events-none" aria-hidden="true">
          <div className="flex items-center gap-2 text-text-secondary text-xs font-mono bg-black/80 px-3 py-1.5 rounded border border-white/10">
            <VolumeX size={12} />
            <span>Audio blocked</span>
          </div>
        </div>
      )}

      {/* A node's clip that could not be loaded (preview links expire); its preview button
          tries again */}
      {hasPreviewSupport && unavailableNodeId && (
        <div className="absolute top-4 right-4 pointer-events-none" aria-hidden="true">
          <div className="flex items-center gap-2 text-text-secondary text-xs font-mono bg-black/80 px-3 py-1.5 rounded border border-white/10">
            <VolumeX size={12} />
            <span>Preview unavailable</span>
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className={`relative w-full flex flex-col ${sparse ? '' : 'flex-1 min-h-0'}`}>
      {sparse ? (
        // Two relations or fewer: a compact row of cards, as tall as it needs.
        <div className="relative">
          <LineageRow
            topInset={topInset}
            nodes={nodeList}
            links={links}
            currentId={currentId}
            yearOf={yearOfNode}
            isOrigin={isOrigin}
            describe={nodeAriaLabel}
            onAnalyse={(node) => analyseRef.current(node)}
          />
          {summary}
          {previewState}
        </div>
      ) : (
        <div
          ref={wrapperRef}
          className="relative flex-1 min-h-0 overflow-hidden cursor-move bg-radial-[circle_at_center] from-surface from-0% to-transparent to-70%"
        >
          <svg
            ref={svgRef}
            className="w-full h-full overflow-visible"
            // One finger scrolls the page (vertically) and two pinch the graph, where the page
            // scrolls past it
            style={wheelZoom === 'modifier' ? { touchAction: 'pan-y pinch-zoom' } : undefined}
            aria-label="Connections graph"
          ></svg>

          {summary}

          {/* What the pointer or keyboard focus is on: a link's relation and where it comes
              from, or a track's relation to this one */}
          {(activeLink || activeNode) && (
            <div
              aria-hidden="true"
              data-testid="link-detail"
              className="absolute left-2 right-2 bottom-2 z-20 max-h-[40%] overflow-hidden pointer-events-none rounded-sm border border-white/15 bg-black/90 px-2 py-1.5 text-chrome font-mono text-text-chip"
            >
              {activeLink && (
                <>
                  <p className="text-text-secondary">{relationSentence(activeLink, nameOf)}</p>
                  <p>{provenanceText(activeLink)}</p>
                </>
              )}
              {activeNode && (
                <>
                  <p className="text-text-secondary">{nameOf(activeNode.id)}</p>
                  {activeNode.group === 1 ? (
                    <p>The analyzed track</p>
                  ) : activeRelation?.link ? (
                    <>
                      <p>{relationSentence(activeRelation.link, nameOf)}</p>
                      <p>{provenanceText(activeRelation.link)}</p>
                    </>
                  ) : (
                    <p>No direct link to this track</p>
                  )}
                  {keyboardOnNode && activeNode.group !== 1 && <p>Enter: analyze this track</p>}
                </>
              )}
            </div>
          )}

          {previewState}
        </div>
      )}

      {/* What the lines mean, in words, and the links as a list (which opens over the graph) */}
      {(links.length > 0 || hidden > 0 || previewTracks.length > 0) && (
        // Opaque and above the graph: nodes the graph draws past its edge do not cover it. Its
        // extra space below is the xl column's only: in the md-to-xl row, on a short landscape
        // screen, every pixel of the row's height goes to the drawing.
        <div className="relative z-10 shrink-0 flex flex-col gap-2 border-t border-white/5 px-4 pt-3 pb-4 xl:pb-14 bg-void">
          {(links.length > 0 || hidden > 0) && (
            <LinkLegend
              types={links.map((link) => link.type)}
              grey={{
                influence: links.some(
                  (link) => link.type === 'influence' && isStatedInfluence(link),
                ),
                notSourced: links.some(
                  (link) => link.type === 'influence' && !isStatedInfluence(link),
                ),
              }}
            />
          )}
          {hidden > 0 && (
            <p className="text-chrome font-mono text-text-chip" data-testid="links-hidden">
              {hidden === 1
                ? '1 link not shown: the claim behind it was rejected or cannot be read.'
                : `${hidden} links not shown: the claims behind them were rejected or cannot be read.`}
            </p>
          )}
          <LinkList links={links} nameOf={nameOf} />
          {/* The map's gestures, in words, under it rather than over its cards: from md up,
              but not on a short screen (a landscape phone), where every pixel goes to the map;
              on a phone, in short. */}
          {!sparse && (
            <>
              <p className="hidden md:flex [@media(max-height:32rem)]:hidden flex-wrap items-center gap-x-3 gap-y-0.5 text-chrome font-mono text-text-tertiary">
                {hints.map((hint, index) => (
                  <span key={hint} className={index === 2 ? 'flex items-center gap-1' : undefined}>
                    {index === 2 && <MousePointerClick size={12} />}
                    {hint}
                  </span>
                ))}
              </p>
              <p className="md:hidden text-chrome font-mono text-text-tertiary">
                Pinch, drag or tap
              </p>
            </>
          )}
          <PreviewList
            tracks={previewTracks}
            nameOf={nameOf}
            playingId={isPlaying ? playingNodeId : null}
            onToggle={(id, url) => playPreview(url, id)}
          />
        </div>
      )}
    </div>
  );
};

export default React.memo(GenealogyGraph);
