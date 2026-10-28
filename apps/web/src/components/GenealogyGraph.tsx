import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  relationCount,
  routeLinks,
  wrapText,
} from './genealogy/lineageLayout';
import { cardName, cardWords } from './genealogy/cardWords';
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

/** The genealogy's nodes, or none when the list is missing. */
function graphNodes(
  data: Partial<TrackData['genealogy']> | null | undefined,
): TrackData['genealogy']['nodes'] {
  return Array.isArray(data?.nodes) ? data.nodes : [];
}

// A card: a thumbnail, then the track's title (four lines at most), its artist and year (three
// lines at most) and a tag for this track or an origin, in the graph's 12 px text.
const PAD = 6;
const THUMB = 28;
const TEXT_GAP = 8;
const LINE_PX = 15;
const TITLE_LINES = 4;
const META_LINES = 3;
/** A character's width in the graph's monospace text. */
const CHAR_PX = labelWidth('x', NODE_LABEL_PX);
/** A card's text is never narrower than this many characters, nor (horizontal) wider than this. */
const MIN_CHARS = 12;
const MAX_TEXT_PX = 208;
/** A card's text width moves in steps of this many px: a resize of a pixel draws nothing again. */
const TEXT_STEP_PX = 16;
const cardWidth = (textWidth: number) => PAD + THUMB + TEXT_GAP + textWidth + PAD;
const chipHeight = LINE_LABEL_PX + 6;
const chipWidth = (text: string) => labelWidth(text, LINE_LABEL_PX) + 10;
/** Room kept round a card or a link the keyboard brings into view (screen px). */
const VIEW_PAD = 12;
/**
 * How far from its link's middle a chip may go (map px): no chip far from what it names. One
 * that is not by its link is joined to it by a leader, drawn under the cards.
 */
const CHIP_REACH = 240;
/** A chip this far from its link's middle (map px) or more gets a leader to it. */
const LEADER_FROM = 24;
/** The space between year slots; in the row it also holds the rails of a year's own links. */
const SLOT_GAP: Record<Orientation, number> = { horizontal: 44, vertical: 18 };

// The map's margins: room for the year axis and, to the right, the links' rails. The panel's
// heading lies over the top of the map (`topInset`).
const MARGIN: Record<Orientation, { top: number; right: number; bottom: number; left: number }> = {
  horizontal: { top: 8, right: 24, bottom: 16, left: 16 },
  vertical: { top: 8, right: 0, bottom: 16, left: 22 },
};

/** The room the rails take to the right of a column of cards: more for more links, at most 80. */
const railRoomFor = (links: number) => Math.min(80, 12 + 5 * links);

/**
 * How wide a card's text is: as wide as its words need (`chars` a line), as far as the room
 * allows, in steps of `TEXT_STEP_PX`.
 */
function textWidthFor(
  panelWidth: number,
  orientation: Orientation,
  chars: number,
  links: number,
): number {
  const need = Math.max(MIN_CHARS, chars) * CHAR_PX;
  const room =
    orientation === 'vertical'
      ? panelWidth - MARGIN.vertical.left - railRoomFor(links) - cardWidth(0)
      : MAX_TEXT_PX;
  const width = Math.max(MIN_CHARS * CHAR_PX, Math.min(need, room));
  // Up a step where the room allows it, else down: never past the room.
  const stepped = Math.ceil(width / TEXT_STEP_PX) * TEXT_STEP_PX;
  return stepped <= room
    ? stepped
    : Math.max(MIN_CHARS * CHAR_PX, Math.floor(room / TEXT_STEP_PX) * TEXT_STEP_PX);
}

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
  // With two relations to the analysed track or fewer the map is a compact row, not a canvas.
  const sparse = isSparse(relationCount(links, currentId));
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
  // A track's name as its card says it, whole: title, artist and year, or "undated".
  const cardNameOf = useMemo(() => {
    const nodes = new Map(graphNodes(data).map((node) => [node.id, node]));
    return (id: string) => {
      const node = nodes.get(id);
      return node ? cardName(node, yearOfNode(id)) : id;
    };
  }, [data, yearOfNode]);
  const nodeAriaLabel = useMemo(
    () => (d: GenealogyNode) => {
      const name = cardNameOf(d.id);
      if (d.group === 1) return `${name}, the analyzed track`;
      const link = relations.get(d.id)?.link;
      // No link to the analysed track: its best link to another track (a second hop).
      const other = link ? null : relationToTrack(links, d.id, null).link;
      const said = link
        ? `${relationSentence(link, nameOf)}. ${provenanceText(link)}.`
        : other
          ? `No direct link to the analyzed track. ${relationSentence(other, nameOf)}. ${provenanceText(other)}.`
          : 'No direct link to the analyzed track.';
      return `${name}: ${said} Press Enter to analyze it.`;
    },
    [cardNameOf, nameOf, relations, links],
  );

  // The characters a card's line needs for every title, artist and year in two lines, no word
  // broken. Where the room is less (a narrow panel, or past MAX_TEXT_PX), a title takes up to four
  // lines and an artist and year three, a word too long for a line broken with a hyphen.
  const needChars = useMemo(
    () =>
      Math.max(
        MIN_CHARS,
        ...graphNodes(data).map((node) => {
          const { title, meta } = cardWords(node, yearOfNode(node.id));
          return Math.max(charsToWrap(title, 2), charsToWrap(meta, 2), 'This track'.length);
        }),
      ),
    [data, yearOfNode],
  );

  // The graph's size on screen (ResizeObserver) and the window's width. The layout depends on
  // the axis's direction and the cards' width, which the size sets: while they hold, a resize
  // keeps the drawing and its zoom and shifts the view so the map stays where it was in the
  // panel (`resizeRef`, set by the drawing). A hidden panel (the phone tabs) measures 0 by 0:
  // the graph keeps its last size.
  // The band the panel's heading covers at the top: the view keeps the map below it. A heading
  // that grows or shrinks (it wraps or unwraps) moves the view by as much; nothing is drawn
  // again.
  const insetRef = useRef(topInset);
  const insetShiftRef = useRef<((by: number) => void) | null>(null);
  useEffect(() => {
    const by = topInset - insetRef.current;
    insetRef.current = topInset;
    if (by !== 0) insetShiftRef.current?.(by);
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
  const textWidth =
    panel && orientation ? textWidthFor(panel.width, orientation, needChars, links.length) : null;
  // The cards a year's row holds side by side (vertical): a layout input, so a resize that
  // changes it lays the map out again (keeping the view), and one that does not keeps the
  // drawing.
  const perRow =
    panel && orientation === 'vertical' && textWidth !== null
      ? Math.max(
          1,
          Math.floor(
            (panel.width - MARGIN.vertical.left - railRoomFor(links.length) + 10) /
              (cardWidth(textWidth) + 10),
          ),
        )
      : 0;

  // Under reduced motion nothing glides or fades.
  const reducedMotion = useReducedMotion();

  // The view the map was last left at, kept when the map is laid out again for the same tracks
  // and axis (a resize that changes the cards a row holds): the reader's pan and zoom stay.
  const viewRef = useRef<{
    data: unknown;
    orientation: Orientation;
    transform: ZoomTransform;
  } | null>(null);
  // The detail box's height while it is shown: chips are not placed under it, and a focused item
  // is brought into view above it. `afterDetailRef` places them again once React has drawn it.
  const detailRef = useRef<HTMLDivElement>(null);
  const detailInsetRef = useRef(0);
  const afterDetailRef = useRef<(() => void) | null>(null);

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
    const railRoom =
      orientation === 'vertical' ? railRoomFor(links.length) : SLOT_GAP.horizontal - 12;
    const margin =
      orientation === 'vertical' ? { ...MARGIN.vertical, right: railRoom + 4 } : MARGIN.horizontal;
    const chars = Math.max(MIN_CHARS, Math.floor(textWidth / CHAR_PX));
    const nodes = graphNodes(data).map((node, i) => {
      const year = yearOfNode(node.id);
      const { title, meta } = cardWords(node, year);
      const tag = node.id === currentId ? 'This track' : isOrigin(node.id) ? 'Origin' : null;
      const titleWrap = wrapText(title, chars, TITLE_LINES);
      const metaWrap = meta
        ? wrapText(meta, chars, META_LINES)
        : { lines: [], hyphenated: [], truncated: false };
      const lines = titleWrap.lines.length + metaWrap.lines.length + (tag ? 1 : 0);
      return {
        node,
        i,
        id: node.id,
        year,
        title,
        meta,
        tag,
        titleWrap,
        metaWrap,
        width: cardWidth(textWidth),
        height: PAD * 2 + Math.max(THUMB, lines * LINE_PX),
        lane: laneOf(node.id === currentId, relations.get(node.id)?.link?.type ?? null),
      };
    });
    type Card = (typeof nodes)[number];
    const layout = layoutLineage(nodes, {
      orientation,
      gap: 10,
      slotGap: SLOT_GAP[orientation],
      axisSize: orientation === 'horizontal' ? 22 : 20,
      crossSpace: perRow * (cardWidth(textWidth) + 10) - 10,
      margin,
    });
    const boxOf = (id: string) => layout.cards.get(id) ?? { x: 0, y: 0, width: 0, height: 0 };
    const cardBoxes = nodes.map((d) => boxOf(d.id));
    // The links' routes, inside the drawing: the drawing is as wide as the widest rail needs.
    const { routes, right: routesRight } = routeLinks(links, layout.cards, { railRoom });
    const mapWidth = Math.max(layout.width, routesRight + 4);
    const mapHeight = layout.height;

    // 4. Zoom: the map is drawn at its size (its text at 12 px), panned to see what does not
    // fit, and zoomed in, never out past its size. Chips are placed again when a zoom or a pan
    // ends, not at each of its steps.
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
        viewRef.current = { data, orientation, transform };
        pinAxis();
      })
      .on('end', () => drawChips());
    svg.call(zoomBehavior);

    // 5. The year axis: a label for each year a card carries, and "Undated" for the rest.
    // Across the page the labels stay at the top of the view when the map is panned down past
    // them, on a band of the page's colour, over the cards that pass beneath (`pinAxis`).
    const axis = g.append('g').attr('class', 'lineage-axis').attr('aria-hidden', 'true');
    const axisBackdrop = axis
      .append('rect')
      .attr('x', 0)
      .attr('y', margin.top - 6)
      .attr('width', Math.max(layout.width, 1))
      .attr('height', orientation === 'horizontal' ? layout.axisSize + 6 : 0)
      .attr('fill', colors.void)
      .attr('fill-opacity', 0);
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
    /** The year slot a card sits in. */
    const slotOf = (id: string) => {
      const year = nodes.find((d) => d.id === id)?.year ?? null;
      return layout.slots.find((slot) => slot.year === year) ?? null;
    };

    /** The band the pinned labels take at the top of the view (screen px; none down a column). */
    const pinnedBand = () =>
      orientation === 'horizontal' ? (layout.axisSize + 6) * (transform.k || 1) : 0;
    /** Pins the row's labels to the top of the view once the map is panned down past them. */
    function pinAxis() {
      if (orientation !== 'horizontal') return;
      const k = transform.k || 1;
      const below = Math.max(0, (insetRef.current - transform.y) / k - (margin.top - 6));
      axis.attr('transform', below > 0 ? `translate(0,${below})` : null);
      axisBackdrop.attr('fill-opacity', below > 0 ? 0.95 : 0);
    }

    // 6. Links: the colour is the relation a link is shown as, the line its kind (solid when
    // sourced, dashed when not), and an arrowhead its direction (from the earlier record to the
    // one that uses it; none when the direction is unknown, or for a shared producer).
    const drawnLinks = links.map((shown, n) => ({ shown, n, route: routes[n] }));
    type DrawnLink = (typeof drawnLinks)[number];
    const restingOpacity = (d: DrawnLink) => LINK_OPACITY[d.shown.kind];
    const link = g
      .append('g')
      .attr('class', 'links')
      .attr('aria-hidden', 'true')
      .selectAll('path')
      .data(drawnLinks)
      .join('path')
      .attr('d', (d) => d.route.d)
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
      .data(drawnLinks)
      .join('path')
      .attr('d', (d) => d.route.d)
      .attr('fill', 'none')
      .attr('data-link-index', (d) => d.n)
      .attr('stroke', colors.cyber)
      .attr('stroke-opacity', 0)
      .attr('stroke-width', 12)
      .attr('vector-effect', 'non-scaling-stroke')
      .style('pointer-events', 'stroke')
      .style('outline', 'none')
      .attr('tabindex', -1)
      .attr('data-mid', (d) => `${d.route.mid.x},${d.route.mid.y}`)
      .attr('aria-label', (d) => describeLink(d.shown, nameOf));

    // The chips' leaders, under the cards: a leader never runs over a card's words.
    const leaders = g
      .append('g')
      .attr('class', 'chip-leaders')
      .attr('aria-hidden', 'true')
      .style('pointer-events', 'none');

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

    // The words: the title, then the artist and year, then the tag, each line at 12 px. A line
    // that ends inside a word (a word longer than the line) ends in a hyphen, and says so.
    const textX = PAD + THUMB + TEXT_GAP;
    const words = node.append('g').attr('class', 'node-label').style('pointer-events', 'none');
    const lineText = (
      className: string,
      wrapped: (d: Card) => { lines: string[]; hyphenated: boolean[] },
      first: (d: Card) => number,
      fill: string,
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
          const { lines, hyphenated } = wrapped(d);
          lines.forEach((line, index) => {
            text
              .append('tspan')
              .attr('x', textX)
              .attr('y', PAD + 11 + (first(d) + index) * LINE_PX)
              .attr('data-hyphen', hyphenated[index] ? '' : null)
              .text(line);
          });
        });
    };
    lineText(
      'card-title',
      (d) => d.titleWrap,
      () => 0,
      colors.white,
    );
    lineText(
      'card-meta',
      (d) => d.metaWrap,
      (d) => d.titleWrap.lines.length,
      colors.gray[400],
    );
    words
      .filter((d) => d.tag !== null)
      .append('text')
      .attr('class', 'sub-label')
      .attr('x', textX)
      .attr('y', (d) => PAD + 11 + (d.titleWrap.lines.length + d.metaWrap.lines.length) * LINE_PX)
      .attr('fill', (d) => (d.id === currentId ? genealogyColors.current : genealogyColors.origin))
      .attr('font-family', 'IBM Plex Mono')
      .attr('font-size', `${SUB_LABEL_PX}px`)
      .text((d) => d.tag ?? '');

    // A card's own drawing is decorative for screen readers: its name says it all.
    node.selectChildren().attr('aria-hidden', 'true');

    // 8. Chips: a link's relation, shown while the pointer or the focus is on the link or on a
    // card it joins, placed clear of every card and year label, in view (below the heading,
    // above the detail box) and near the link's middle; a chip with no free place near it is
    // left out (the detail box says the same). An origin's card also says a click analyses it.
    // The axis above the cards (its labels may be pinned over them), below the chips.
    axis.raise();
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
      // A hint's fade stops with the hint.
      chips.selectAll('*').interrupt().remove();
      leaders.selectAll('*').remove();
      const active = pointerOn ?? focusOn;
      if (!active) return;
      const k = transform.k || 1;
      // What is in view, in the map's units, below the heading and above the detail box.
      const top = insetRef.current + pinnedBand();
      const bottom = height - detailInsetRef.current;
      const view = {
        x: -transform.x / k,
        y: (top - transform.y) / k,
        width: width / k,
        height: Math.max(0, bottom - top) / k,
      };
      const shown =
        active.kind === 'link'
          ? drawnLinks.filter((d) => d.n === active.index)
          : drawnLinks
              .filter((d) => d.shown.source === active.id || d.shown.target === active.id)
              .sort((a, b) => rank(b.shown) - rank(a.shown));
      const wanted: Array<ChipInput & { text: string; link: DrawnLink | null }> = shown.map(
        (d, order) => ({
          near: d.route.mid,
          width: chipWidth(relationLabel(d.shown)),
          height: chipHeight,
          priority: -order,
          text: relationLabel(d.shown),
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
      const at = placeChips(wanted, obstacles, view, { reach: CHIP_REACH });
      wanted.forEach((chip, index) => {
        const box = at[index];
        if (!box) return;
        const group = chips
          .append('g')
          .attr('class', chip.link ? 'chip' : 'chip hint')
          .attr('transform', `translate(${box.x},${box.y})`);
        if (chip.link) {
          group
            .attr('data-link-index', chip.link.n)
            .attr('data-near', `${chip.near.x},${chip.near.y}`);
          const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
          if (Math.hypot(centre.x - chip.near.x, centre.y - chip.near.y) >= LEADER_FROM) {
            leaders
              .append('line')
              .attr('x1', centre.x)
              .attr('y1', centre.y)
              .attr('x2', chip.near.x)
              .attr('y2', chip.near.y)
              .attr('stroke', LINK_COLOR[chip.link.shown.type])
              .attr('stroke-opacity', 0.7)
              .attr('stroke-width', 1)
              .attr('stroke-dasharray', '2 2')
              .attr('vector-effect', 'non-scaling-stroke');
          }
        }
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
     * Pans the view, at once and no further than it takes, so a focused card (with its year's
     * label on the axis, where the room allows) or the middle of a focused link is in view:
     * below the panel's heading and above the detail box.
     */
    const bringIntoView = (item: Item) => {
      let box: CardBox;
      if (item.kind === 'node') {
        const card = boxOf(item.id);
        const slot = slotOf(item.id);
        // The card and the label of its year: along the axis (vertical, the slot's heading is
        // above the card) and across it (the labels' band).
        // Down a column, the card with its year's heading above it, where the room allows;
        // across the page, the card (the year labels are pinned to the top of the view).
        box = card;
        if (orientation === 'vertical' && slot) {
          const withHeading = {
            x: card.x,
            y: slot.start,
            width: card.width,
            height: card.y + card.height - slot.start,
          };
          const k = transform.k || 1;
          const room = height - insetRef.current - detailInsetRef.current - 2 * VIEW_PAD;
          if (withHeading.height * k <= room) box = withHeading;
        }
      } else {
        const { mid } = drawnLinks[item.index].route;
        box = { x: mid.x - 1, y: mid.y - 1, width: 2, height: 2 };
      }
      const k = transform.k || 1;
      const [left, top] = [transform.x + box.x * k, transform.y + box.y * k];
      const [right, bottom] = [left + box.width * k, top + box.height * k];
      // The least move that brings a side into view (the near side first, if both are out).
      const shift = (low: number, high: number, from: number, to: number) =>
        low < from + VIEW_PAD
          ? from + VIEW_PAD - low
          : high > to - VIEW_PAD
            ? to - VIEW_PAD - high
            : 0;
      const [dx, dy] = [
        shift(left, right, 0, width),
        shift(top, bottom, insetRef.current + pinnedBand(), height - detailInsetRef.current),
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
        item: { kind: 'link', index: drawnLinks[i].n } as Item,
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
    // Once React has drawn the detail box (or taken it away): the focused item clear of it, and
    // the chips placed again above it.
    afterDetailRef.current = () => {
      if (focusOn) bringIntoView(focusOn);
      drawChips();
    };
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
        // The view is brought to it by the map's own pan (`bringIntoView`), not by scrolling.
        items[next].element.focus({ preventScroll: true });
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

    // The first view, unless the map is laid out again for the same tracks and axis (then the
    // reader's view is kept). The map at its size, below the panel's heading:
    // - along the year axis, this track's card in the middle of the room, as far as the map
    //   allows (no empty band past its edge); vertical, the view then starts at a year's label
    //   (the slot the top of the view falls in), so the year the first cards belong to is said;
    // - across it, the axis's labels in view (the top of the row, the left of the column) when
    //   this track's card is then in view too.
    const kept = viewRef.current;
    /**
     * Holds the view to the map after a resize or a new layout: across each direction, a map
     * that fits the room sits where the first view puts it (centred along the axis, at the top of
     * the row, at the left of the column), and a larger one leaves no empty band past its edges.
     */
    const holdView = () => {
      const k = transform.k || 1;
      const inset = insetRef.current;
      const hold = (at: number, map: number, panel: number, from: number, centre: boolean) =>
        map <= panel - from
          ? centre
            ? from + (panel - from - map) / 2
            : from
          : Math.min(from, Math.max(panel - map, at));
      const x = hold(transform.x, mapWidth * k, width, 0, orientation === 'horizontal');
      const y = hold(transform.y, mapHeight * k, height, inset, orientation === 'vertical');
      if (x !== transform.x || y !== transform.y) {
        svg.call(zoomBehavior.transform, zoomIdentity.translate(x, y).scale(k));
      }
    };
    if (kept && kept.data === data && kept.orientation === orientation) {
      svg.call(zoomBehavior.transform, kept.transform);
      holdView();
    } else {
      const inset = insetRef.current;
      const anchor = boxOf(currentId ?? nodes[0]?.id ?? '');
      const along = (map: number, panel: number, middle: number, from = 0) =>
        map <= panel - from
          ? from + (panel - from - map) / 2
          : Math.min(from, Math.max(panel - map, (from + panel) / 2 - middle));
      const across = (map: number, panel: number, near: number, far: number, from = 0) =>
        map <= panel - from || far + VIEW_PAD <= panel
          ? from
          : along(map, panel, (near + far) / 2, from);
      let tx: number;
      let ty: number;
      if (orientation === 'horizontal') {
        tx = along(mapWidth, width, anchor.x + anchor.width / 2);
        ty = across(mapHeight, height, anchor.y, anchor.y + anchor.height + inset, inset);
      } else {
        tx = across(mapWidth, width, anchor.x, anchor.x + anchor.width);
        ty = along(mapHeight, height, anchor.y + anchor.height / 2, inset);
        // Start the view at the label of the year its top falls in, while this track's card
        // stays in view.
        const viewTop = inset - ty;
        const slot = [...layout.slots].reverse().find((s) => s.start <= viewTop + 1);
        if (slot && slot.start < viewTop - 1) {
          const moved = inset - slot.start;
          if (anchor.y + anchor.height + moved <= height - VIEW_PAD) ty = moved;
        }
      }
      svg.call(zoomBehavior.transform, zoomIdentity.translate(tx, ty));
    }

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
      holdView();
      drawChips();
    };

    // Everything the drawing started stops with it: transitions (the hint's fade, a double
    // click's zoom) and their timers, and every listener on the svg and its elements.
    return () => {
      resizeRef.current = null;
      insetShiftRef.current = null;
      afterDetailRef.current = null;
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
    perRow,
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
  // A track with no link to this one: its best link to another track (a second hop).
  const activeOther =
    activeNode && !activeRelation?.link ? relationToTrack(links, activeNode.id, null).link : null;
  // The detail box's height, once React has drawn it (or 0 once it has gone): the drawing keeps
  // chips and the focused item clear of it.
  useLayoutEffect(() => {
    const inset = detailRef.current ? detailRef.current.offsetHeight + 8 : 0;
    if (inset === detailInsetRef.current) return;
    detailInsetRef.current = inset;
    afterDetailRef.current?.();
  });
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
          // Each track named whole, as its card says it: title, artist, year or "undated".
          const name = cardNameOf(node.id);
          if (node.group === 1) return ` ${name}: the analyzed track.`;
          // Which track uses which, as a sentence naming both, and how it is known.
          const relation = relationToTrack(links, node.id, currentId);
          return relation.link
            ? ` ${name}: ${relationSentence(relation.link, nameOf)} (${kindLabel(relation.link)}).`
            : ` ${name}: ${relation.text.toLowerCase()}.`;
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
            nameOf={nameOf}
            onAnalyse={(node) => analyseRef.current(node)}
          />
          {summary}
          {previewState}
        </div>
      ) : (
        <div
          ref={wrapperRef}
          className="relative flex-1 min-h-0 overflow-hidden cursor-move bg-radial-[circle_at_center] from-surface from-0% to-transparent to-70%"
          // The browser scrolls a box that hides its overflow to show what takes the focus: the
          // map pans to it instead (the drawing's `bringIntoView`), so the box never scrolls.
          onScroll={(event) => {
            event.currentTarget.scrollTop = 0;
            event.currentTarget.scrollLeft = 0;
          }}
        >
          <svg
            ref={svgRef}
            // Nothing in the drawing takes a CSS transition (the reduced-motion stylesheet gives
            // every change one, a hundredth of a millisecond long): a pan or a zoom is drawn at
            // once, and reads back at once.
            className="w-full h-full overflow-visible [&_*]:transition-none"
            // One finger scrolls the page (vertically) and two pinch the graph, where the page
            // scrolls past it
            style={wheelZoom === 'modifier' ? { touchAction: 'pan-y pinch-zoom' } : undefined}
            aria-label="Connections graph"
          ></svg>

          {summary}

          {/* What the pointer or keyboard focus is on: a link's relation and where it comes
              from, or a track's relation to this one */}
          {(activeLink || activeNode) && (
            // As tall as its words: none is cut (the drawing keeps chips and the focused item
            // above it).
            <div
              ref={detailRef}
              aria-hidden="true"
              data-testid="link-detail"
              className="absolute left-2 right-2 bottom-2 z-20 pointer-events-none rounded-sm border border-white/15 bg-black/90 px-2 py-1.5 text-chrome font-mono text-text-chip wrap-anywhere"
            >
              {activeLink && (
                <>
                  <p className="text-text-secondary">{relationSentence(activeLink, nameOf)}</p>
                  <p>{provenanceText(activeLink)}</p>
                </>
              )}
              {activeNode && (
                <>
                  <p className="text-text-secondary">{cardNameOf(activeNode.id)}</p>
                  {activeNode.group === 1 ? (
                    <p>The analyzed track</p>
                  ) : activeRelation?.link ? (
                    <>
                      <p>{relationSentence(activeRelation.link, nameOf)}</p>
                      <p>{provenanceText(activeRelation.link)}</p>
                    </>
                  ) : activeOther ? (
                    <>
                      <p>No direct link to this track</p>
                      <p>{relationSentence(activeOther, nameOf)}</p>
                      <p>{provenanceText(activeOther)}</p>
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
        // Opaque and above the graph: nodes the graph draws past its edge do not cover it.
        <div className="relative z-10 shrink-0 flex flex-col gap-2 border-t border-white/5 px-4 pt-3 pb-4 bg-void">
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
