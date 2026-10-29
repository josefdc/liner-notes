import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { select } from 'd3-selection';
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
  recordYear,
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
  MD_PX,
  type Orientation,
  orientationFor,
  placeChips,
  routeLinks,
  type ViewBreaks,
  VIEW_START_PAD,
  wrapText,
} from './genealogy/lineageLayout';
import { fitCardText, SHORTENED_TEXT } from './genealogy/cardText';
import {
  bottomCues,
  CUE_TEXT,
  cardsAbove,
  cueName,
  cueWidth,
  type EdgeCounts,
  edgeCounts,
  effectiveBreaks,
  planFirstView,
  sameBreaks,
  sameCounts,
  upAside,
} from './genealogy/firstView';
import { cardName, cardWords } from './genealogy/cardWords';
import { cuePan } from './genealogy/cuePan';
import { LINK_COLOR, LINK_DASH, LINK_OPACITY, linkWidth } from './genealogy/linkStyle';
import { GRAPH_TEXT_PX, LINE_LABEL_PX, NODE_LABEL_PX, SUB_LABEL_PX } from './genealogy/textSize';
import { LineageRow } from './genealogy/LineageRow';
import { LinkLegend } from './genealogy/LinkLegend';
import { LinkList } from './genealogy/LinkList';
import { PreviewList } from './genealogy/PreviewList';
import { GRAPH_LISTS } from './genealogy/exclusiveLists';
import { DetailPanel } from './genealogy/DetailPanel';
import { clearOfPanel } from './genealogy/clearOfPanel';
import { LinkFilters } from './genealogy/LinkFilters';
import {
  filterCounts,
  filterGenealogy,
  hiddenText,
  isFiltering,
  type LinkFilter,
  NO_FILTER,
} from './genealogy/filters';
import { listeningPlan, useABListening } from './genealogy/useABListening';
import { Button } from './ui/Button';
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

/** What a link joins, and how: the same link in another list of links (null: no link). */
const linkKey = (link: ShownLink | undefined) =>
  link ? JSON.stringify([link.source, link.target, link.type]) : null;

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
// Across the page a card whose title (or artist and year) needs more lines than these at the
// width every card takes grows wider, up to MAX_LONG_TEXT_PX (about 190 characters of title).
// Words longer still, or too long for a column's room, are cut, with an ellipsis, and the card
// says so in words ("Title shortened"); the whole title is in its accessible name, its detail
// box and its details panel.
const TITLE_LINES = 4;
const META_LINES = 3;
/** The widest a card's text grows to show its words whole, across the page (px). */
const MAX_LONG_TEXT_PX = 352;
/** A character's width in the graph's monospace text. */
const CHAR_PX = labelWidth('x', NODE_LABEL_PX);
/**
 * A card's text is never narrower than this many characters, nor (horizontal) wider than this,
 * but for a card whose words need more (up to MAX_LONG_TEXT_PX).
 */
const MIN_CHARS = 12;
const MAX_TEXT_PX = 208;
/** A map shorter than this (px) leaves no room above an overlaid panel: the panel follows it. */
const SHORT_MAP_PX = 200;
/** A card's text width moves in steps of this many px: a resize of a pixel draws nothing again. */
const TEXT_STEP_PX = 16;
const cardWidth = (textWidth: number) => PAD + THUMB + TEXT_GAP + textWidth + PAD;
const chipHeight = LINE_LABEL_PX + 6;
const chipWidth = (text: string) => labelWidth(text, LINE_LABEL_PX) + 10;
/** Room kept round a card or a link the keyboard brings into view (screen px). */
const VIEW_PAD = 12;
/**
 * An edge cue's height ("4 more →"), and the strip kept for the cues where a cue's button would
 * lie over a card: at rest no card lies under a cue (px).
 */
const CUE_PX = 24;
/** The line over the axis that says the years are in order, not to scale (across the page, px). */
const AXIS_NOTE_PX = 18;
/** A map shorter than this (px) gives the line no room: it goes under the map, with the legend. */
const AXIS_NOTE_MIN_PX = 280;
/** The line's words, and the room they take (12 px, IBM Plex Mono). */
const AXIS_NOTE = 'Years in order, not to scale.';
const AXIS_NOTE_WIDTH = labelWidth(AXIS_NOTE, 12);
/** The heading's last row over the map: as tall as its chip, above its bottom padding (px). */
const HEADING_ROW_PX = 28;
/**
 * True when the right of the last row of the heading laid over the map's top (`topInset` px
 * tall, its padding the page's 16 px at the sides and 8 px at the bottom) holds nothing: the
 * line "Years in order, not to scale." goes there. Read from what is drawn: any text, link,
 * button or icon there, outside the map, takes the room.
 */
function headingRowFree(wrapper: HTMLElement, topInset: number): boolean {
  const box = wrapper.getBoundingClientRect();
  const room = {
    left: box.right - 16 - AXIS_NOTE_WIDTH - 16,
    right: box.right,
    top: box.top + topInset - 8 - HEADING_ROW_PX,
    bottom: box.top + topInset - 8,
  };
  const meets = (rect: DOMRect) =>
    rect.width > 0 &&
    rect.height > 0 &&
    rect.left < room.right &&
    rect.right > room.left &&
    rect.top < room.bottom &&
    rect.bottom > room.top;
  let child: Element = wrapper;
  for (let parent = wrapper.parentElement, depth = 0; parent && depth < 4; depth += 1) {
    for (const sibling of parent.children) {
      if (sibling === child) continue;
      // Its words, and what is drawn rather than written (an icon, a button, a link).
      const walker = document.createTreeWalker(sibling, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(text);
        if (meets(range.getBoundingClientRect())) return false;
      }
      for (const element of sibling.querySelectorAll('svg, img, button, a, input, select')) {
        if (meets(element.getBoundingClientRect())) return false;
      }
    }
    child = parent;
    parent = parent.parentElement;
  }
  return true;
}
/** No card past any edge of the view. */
const NO_CUES: EdgeCounts = { left: 0, right: 0, up: 0, down: 0 };
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

/**
 * The least move along an axis that brings [low, high] into [from, to] with VIEW_PAD to spare
 * (the near side first, if both are out).
 */
const nearShift = (low: number, high: number, from: number, to: number) =>
  low < from + VIEW_PAD ? from + VIEW_PAD - low : high > to - VIEW_PAD ? to - VIEW_PAD - high : 0;

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
  trackPreviewUrl = null,
  replay = false,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // The links that can be drawn (one to an unknown node id is left out), each read with the
  // contract's link schema and shown by its rule and this app's stricter ones; links whose claim
  // the verifier contradicted are left out.
  const reading = useMemo(
    () => readGenealogy(data, linkContext(evidence, claims, { releaseYear })),
    [data, evidence, claims, releaseYear],
  );
  const allLinks = reading.links;
  const hidden = reading.hidden + hiddenLinks;
  const named = useMemo(() => nodesById(data?.nodes, yearFrom(releaseYear)), [data, releaseYear]);
  const nameOf = useMemo(() => (id: string) => nodeName(named.get(id), id), [named]);
  // A track's year as a record dates it (MusicBrainz, or the result's release year for the
  // analysed track), never one a label carries: the map places and dates cards by it alone, and a
  // track with none is undated.
  const yearOfNode = useMemo(() => (id: string) => recordYear(named.get(id)), [named]);
  const currentId = useMemo(
    () => graphNodes(data).find((node) => node.group === 1)?.id ?? null,
    [data],
  );
  // The filters (not stored): the tracks and links they keep are what the canvas, the compact
  // row, the list and the summary show. The analysed track is always kept.
  const [filter, setFilter] = useState<LinkFilter>(NO_FILTER);
  const filtered = useMemo(
    () => filterGenealogy(graphNodes(data), allLinks, currentId, filter),
    [data, allLinks, currentId, filter],
  );
  const links = filtered.links;
  const shownNodes = filtered.nodes;
  const counts = useMemo(() => filterCounts(allLinks, currentId), [allLinks, currentId]);
  const shownCounts = useMemo(
    () => new Map(filterCounts(links, currentId).map(({ kind, count }) => [kind, count])),
    [links, currentId],
  );
  // With two links or fewer in all the map is a compact row, not a canvas (whatever the filters
  // leave: filtering never turns the canvas into the row).
  const sparse = isSparse(allLinks.length);

  // The selected track: a click, a tap or Enter on its card selects it (never analyses it) and
  // opens its details; Escape, the close button or another click on it clears it. The drawing
  // reads it through `selectedRef` and draws it with `drawSelectedRef`.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const drawSelectedRef = useRef<(() => void) | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  /** Selects a track (another click on the selected one clears it); never the analysed one. */
  const selectRef = useRef<(id: string) => void>(() => {});
  selectRef.current = (id: string) => {
    if (id === currentId) return;
    setSelectedId((was) => (was === id ? null : id));
  };
  const ab = useABListening();
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

  /** Analyses a track (never the current one): the detail panel's "Analyze this track". */
  const analyseRef = useRef<(d: GenealogyNode) => void>(() => {});
  const stopListening = ab.stop;
  useEffect(() => {
    analyseRef.current = (d) => {
      if (d.group === 1) return;
      stopPreview();
      stopListening();
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
  }, [stopPreview, stopListening]);

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
      return `${name}: ${said}`;
    },
    [cardNameOf, nameOf, relations, links],
  );
  /** A card's name with what Enter does on it: open its details, or close them (selected). */
  const cardLabel = (d: GenealogyNode, selected: boolean) =>
    d.group === 1
      ? nodeAriaLabel(d)
      : `${nodeAriaLabel(d)} Press Enter ${selected ? 'to close its details' : 'for its details'}.`;
  const cardLabelRef = useRef(cardLabel);
  cardLabelRef.current = cardLabel;

  // The characters a card's line needs for every title, artist and year in two lines, no word
  // broken. Where the room is less (a narrow panel, or past MAX_TEXT_PX), a title takes up to four
  // lines and an artist and year three, a word too long for a line broken with a hyphen; across
  // the page a card whose words need more grows wider on its own (`fitCardText`).
  const needChars = useMemo(
    () =>
      Math.max(
        MIN_CHARS,
        ...graphNodes(data).map((node) => {
          const { title, meta, year } = cardWords(node, yearOfNode(node.id));
          return Math.max(
            charsToWrap(title, 2),
            charsToWrap(meta, 2, { separator: year !== null }),
            'This track'.length,
          );
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
  // Across the page the line "Years in order, not to scale." sits over the axis, under the
  // heading, where the map has the room: the map starts below both.
  // In the heading's last row, at its right, where that room is free (it takes none of the
  // map's): measured once the heading is laid out.
  const [noteInHeading, setNoteInHeading] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the panel's width moves the heading's free room
  useLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    const fits =
      orientation === 'horizontal' &&
      wrapper !== null &&
      topInset >= HEADING_ROW_PX + 8 &&
      headingRowFree(wrapper, topInset);
    setNoteInHeading(fits);
  }, [orientation, topInset, panel?.width]);
  const noteOverAxis =
    !noteInHeading &&
    orientation === 'horizontal' &&
    panel !== null &&
    panel.height >= AXIS_NOTE_MIN_PX;
  const mapInset = topInset + (noteOverAxis ? AXIS_NOTE_PX : 0);
  useEffect(() => {
    const by = mapInset - insetRef.current;
    insetRef.current = mapInset;
    if (by !== 0) insetShiftRef.current?.(by);
  }, [mapInset]);
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
    /** The tracks laid out (the filtered list: a filter lays the map out afresh). */
    data: unknown;
    orientation: Orientation;
    transform: ZoomTransform;
    /** True while the view is the first view: the reader has not moved it. */
    rest: boolean;
    /** True while the view left rest only for a hover (see `held` in the drawing). */
    held: boolean;
    /** Where the first view ended when the map was laid out (see `planFirstView`). */
    breaks: ViewBreaks | undefined;
  } | null>(null);
  // A resize or a new heading height while the view is at rest, where the first view now ends
  // elsewhere across the map's cards: the map is laid out again for it (a count, read by the
  // drawing's effect).
  const [restLayout, setRestLayout] = useState(0);
  // The map item that had the keyboard focus when the drawing went: the next drawing gives it
  // the focus back (a new layout keeps the reader's place). A link is found by what it joins
  // (`linkKey`): its index may name another link once the links have changed.
  const refocusRef = useRef<{ item: Item; link: string | null } | null>(null);
  // How many cards lie past each edge of the view (the edge cues), and the pan a cue asks for.
  const [cues, setCues] = useState<EdgeCounts>(NO_CUES);
  // Down a column, "↑ N more" in the gutter right of the cards (no band of its own).
  const [upBeside, setUpBeside] = useState(false);
  const cuePanRef = useRef<((side: keyof EdgeCounts) => void) | null>(null);
  // The focus on the map's own stop (its roving item), the view kept where it is.
  const focusMapRef = useRef<(() => void) | null>(null);
  const cuesRef = useRef<HTMLDivElement>(null);
  // The detail box's height while it is shown: chips are not placed under it, and a focused item
  // is brought into view above it. `afterDetailRef` places them again once React has drawn it.
  const detailRef = useRef<HTMLDivElement>(null);
  const detailInsetRef = useRef(0);
  // How far up the box reaches when it is at the bottom, wherever it is now: what is "low" does
  // not change with where the box goes (it would go back and forth).
  const lowInsetRef = useRef(0);
  // Where the box or the panel lies across the map (px from the map's left): a card beside it,
  // not under it, is clear of it.
  const detailAcrossRef = useRef<readonly [number, number]>([0, 0]);
  const afterDetailRef = useRef<(() => void) | null>(null);
  // The detail box goes to the top of the map while the item the pointer is on sits in the
  // bottom band, where the box would cover it (`detailTopRef` mirrors it for the drawing).
  const [detailTop, setDetailTop] = useState(false);
  const detailTopRef = useRef(false);
  const detailShownRef = useRef('');

  // biome-ignore lint/correctness/useExhaustiveDependencies: `restLayout` lays the map out again at rest
  useEffect(() => {
    const size = sizeRef.current;
    if (sparse || !svgRef.current || !size || orientation === null || textWidth === null) {
      // No drawing: the focus the last one had is not given back later, to whatever then has it.
      refocusRef.current = null;
      return;
    }

    // 1. Setup & Cleanup
    const svg = select(svgRef.current);
    svg.selectAll('*').remove();
    // Listeners added here outside d3 (focus and blur), removed when the drawing goes.
    const listening: Array<{
      element: SVGElement;
      type: string;
      listener: (event: Event) => void;
      capture: boolean;
    }> = [];
    // Listeners on the window, removed the same way.
    const unlisten: Array<() => void> = [];

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
    // The tracks that feed this one, at any remove (a link from them into it, or into a track
    // that feeds it): an undated one goes before the first year, never after what it feeds.
    const feeds = new Set<string>();
    for (let added = currentId !== null; added; ) {
      added = false;
      for (const l of links) {
        if ((l.target === currentId || feeds.has(l.target)) && !feeds.has(l.source)) {
          if (l.source === currentId) continue;
          feeds.add(l.source);
          added = true;
        }
      }
    }
    const nodes = shownNodes.map((node, i) => {
      const year = yearOfNode(node.id);
      const { title, meta } = cardWords(node, year);
      const tag = node.id === currentId ? 'This track' : isOrigin(node.id) ? 'Origin' : null;
      // Across the page a card grows wider for words that need it; down a column every card
      // takes the column's room.
      const text = fitCardText(title, meta, {
        width: textWidth,
        widest: orientation === 'horizontal' ? MAX_LONG_TEXT_PX : textWidth,
        step: TEXT_STEP_PX,
        charPx: CHAR_PX,
        minChars: MIN_CHARS,
        titleLines: TITLE_LINES,
        metaLines: META_LINES,
        metaYear: year !== null,
      });
      const chars = Math.max(MIN_CHARS, Math.floor(text.width / CHAR_PX));
      // Words cut on the card: the card says so, in words, under them.
      const shortenedWrap = text.shortened
        ? wrapText(SHORTENED_TEXT[text.shortened], chars, 3)
        : { lines: [], hyphenated: [], truncated: false };
      const lines =
        text.title.lines.length +
        text.meta.lines.length +
        (tag ? 1 : 0) +
        shortenedWrap.lines.length;
      return {
        node,
        i,
        id: node.id,
        year,
        title,
        meta,
        tag,
        titleWrap: text.title,
        metaWrap: text.meta,
        shortened: text.shortened,
        shortenedWrap,
        width: cardWidth(text.width),
        height: PAD * 2 + Math.max(THUMB, lines * LINE_PX),
        lane: laneOf(node.id === currentId, relations.get(node.id)?.link?.type ?? null),
        early: year === null && feeds.has(node.id),
      };
    });
    type Card = (typeof nodes)[number];
    const layoutOptions = {
      orientation,
      gap: 10,
      slotGap: SLOT_GAP[orientation],
      axisSize: orientation === 'horizontal' ? 22 : 20,
      crossSpace: perRow * (cardWidth(textWidth) + 10) - 10,
      margin,
    };
    /** The map's size for a layout: the drawing is as wide as the widest rail needs. */
    const sizeOf = (laid: ReturnType<typeof layoutLineage>) => ({
      width: Math.max(laid.width, routeLinks(links, laid.cards, { railRoom }).right + 4),
      height: laid.height,
    });
    // The map as laid out for no view, and its size: what the first view fits, or not.
    const free = layoutLineage(nodes, layoutOptions);
    const freeSize = sizeOf(free);
    const freeCards = [...free.cards.values()];
    const anchorId = currentId ?? nodes[0]?.id ?? '';
    /** The cards' places in the map laid out with these breaks, as a key. */
    const placesOf = (breaks: ViewBreaks | undefined) => {
      const laid = breaks ? layoutLineage(nodes, { ...layoutOptions, breakAt: breaks }) : free;
      return nodes
        .map((d) => {
          const box = laid.cards.get(d.id);
          return `${box?.x},${box?.y}`;
        })
        .join(' ');
    };
    /** The first view for a room (see `planFirstView`), judged on the map laid out for it. */
    const planFor = (size: { width: number; height: number }) =>
      planFirstView({
        orientation,
        map: freeSize,
        slots: free.slots,
        cards: freeCards,
        anchor: free.cards.get(anchorId) ?? null,
        room: { ...size, inset: insetRef.current },
        pad: VIEW_START_PAD,
        cue: CUE_PX,
        // The pinned year labels' band (`pinnedBand`, at zoom 1).
        band: layoutOptions.axisSize + 6,
        layout: (breaks) => {
          const laid = breaks ? layoutLineage(nodes, { ...layoutOptions, breakAt: breaks }) : free;
          return { cards: [...laid.cards.values()], anchor: laid.cards.get(anchorId) ?? null };
        },
        cueWidth,
      });
    /**
     * Where the first view's room for cards ends, for the room the map has now: only the breaks
     * that change the layout (so the map is laid out again only when a card moves).
     */
    const breaksFor = (size: { width: number; height: number }) =>
      effectiveBreaks(planFor(size).breaks, placesOf);
    // The view the map was left at: kept (with the layout it was drawn for) once the reader has
    // moved it; at rest (no pan, zoom or move to a focused card yet) it is the first view again,
    // laid out for the room the map has now.
    const last = viewRef.current;
    const kept = last && last.data === shownNodes && last.orientation === orientation ? last : null;
    let rest = kept === null || kept.rest;
    /**
     * True while the view left rest only for a pointer passing over the map, or a finger on it
     * (no press of a mouse, focus, selection, pan or zoom since): it is held only while that
     * lasts, and then the view is at rest again (`backToRest`). A drawing anew under the
     * pointer keeps it, so the pointer leaving still brings the first view back.
     */
    let held = kept !== null && !kept.rest && kept.held;
    /** True once the drawing has gone (a timer of its own may still fire). */
    let gone = false;
    const leaveRest = (hold = false) => {
      if (rest) held = hold;
      else if (!hold) held = false;
      rest = false;
      if (viewRef.current?.data === shownNodes)
        viewRef.current = { ...viewRef.current, rest, held };
      svg.attr('data-view', 'reader');
    };
    /** The pointer gone (or the finger lifted) with nothing done: the first view again. */
    const backToRest = () => {
      if (!held || rest || gone) return;
      held = false;
      rest = true;
      if (viewRef.current?.data === shownNodes)
        viewRef.current = { ...viewRef.current, rest, held };
      svg.attr('data-view', 'first');
      refit();
    };
    // Whose the view is, for tests and tools: the first view, or the reader's.
    svg.attr('data-view', rest ? 'first' : 'reader');
    const breaks = kept === null || kept.rest ? breaksFor({ width, height }) : kept.breaks;
    const layout = breaks ? layoutLineage(nodes, { ...layoutOptions, breakAt: breaks }) : free;
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
        // The reader's own pan or zoom (a wheel, a drag, a pinch, a double click): the view is
        // theirs from now on.
        if (event.sourceEvent) leaveRest();
        g.attr('transform', event.transform.toString());
        viewRef.current = { data: shownNodes, orientation, transform, rest, held, breaks };
        pinAxis();
        showTicks();
      })
      .on('end', () => {
        drawChips();
        countCues();
      });
    svg.call(zoomBehavior);

    // 5. The year axis: a label for each year a record gives a card, and "Undated" for the rest,
    // before the first year (the undated sources) or after the last. The axis's line runs along
    // the dated years only; a dashed divider stands between it and an "Undated" slot.
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
    const dated = layout.slots.filter((slot) => slot.year !== null);
    const datedFrom = dated[0]?.start ?? 0;
    const datedTo =
      dated.length > 0 ? dated[dated.length - 1].start + dated[dated.length - 1].size : 0;
    /** Where the divider between an "Undated" slot and the dated years goes, along the axis. */
    const dividers = layout.slots
      .filter((slot) => slot.year === null && dated.length > 0)
      .map((slot) =>
        slot.side === 'before'
          ? (slot.start + slot.size + datedFrom) / 2
          : (datedTo + slot.start) / 2,
      );
    if (orientation === 'horizontal') {
      const y = margin.top + 14;
      if (dated.length > 0) {
        axis
          .append('line')
          .attr('class', 'axis-line')
          .attr('x1', datedFrom)
          .attr('x2', datedTo)
          .attr('y1', y + 5)
          .attr('y2', y + 5)
          .attr('stroke', lineColor);
      }
      for (const at of dividers) {
        axis
          .append('line')
          .attr('class', 'axis-divider')
          .attr('x1', at)
          .attr('x2', at)
          .attr('y1', y - 12)
          .attr('y2', y + 9)
          .attr('stroke', lineColor)
          .attr('stroke-dasharray', '3 3');
      }
      for (const [index, slot] of layout.slots.entries()) {
        const x = slot.start + slot.size / 2;
        axis
          .append('text')
          .attr('class', 'year-tick')
          .attr('data-slot', index)
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
      if (dated.length > 0) {
        axis
          .append('line')
          .attr('class', 'axis-line')
          .attr('x1', x)
          .attr('x2', x)
          .attr('y1', datedFrom)
          .attr('y2', datedTo)
          .attr('stroke', lineColor);
      }
      for (const at of dividers) {
        axis
          .append('line')
          .attr('class', 'axis-divider')
          .attr('x1', x - 6)
          .attr('x2', x + 30)
          .attr('y1', at)
          .attr('y2', at)
          .attr('stroke', lineColor)
          .attr('stroke-dasharray', '3 3');
      }
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
      const card = nodes.find((d) => d.id === id);
      const year = card?.year ?? null;
      const side = year === null ? (card?.early ? 'before' : 'after') : null;
      return layout.slots.find((slot) => slot.year === year && slot.side === side) ?? null;
    };
    /** Each year slot's cards (their boxes), in the slots' order. */
    const slotCards = layout.slots.map((slot) =>
      nodes.filter((d) => slotOf(d.id) === slot).map((d) => boxOf(d.id)),
    );
    /**
     * The part of the map in view (map px): below the band over its top, and across the page
     * below the year labels' band where it is pinned there (opaque: a card under it is hidden).
     */
    const inView = () => {
      const k = transform.k || 1;
      const top = (insetRef.current - transform.y) / k;
      return {
        left: -transform.x / k,
        right: (width - transform.x) / k,
        top: top + headOf(top),
        bottom: (height - transform.y) / k,
      };
    };
    /**
     * The band over the top of a view whose top is at `top` (map px), opaque, that hides the
     * cards under it: the pinned year labels across the page; down a column, the band "↑ N more"
     * takes while a card starts above the view.
     */
    const headOf = (top: number) =>
      pinnedAt(top)
        ? layout.axisSize + 6
        : orientation === 'vertical' &&
            !upIsAside(top) &&
            cardBoxes.some((box) => box.y < top - 0.5)
          ? CUE_PX / (transform.k || 1)
          : 0;
    /**
     * Down a column, true when "↑ N more" sits in the gutter right of the cards (as the view is
     * now placed and zoomed, its top at `top`, map px): no band of its own over the view's top
     * then.
     */
    const upIsAside = (top: number) =>
      orientation === 'vertical' &&
      upAside(
        Math.max(0, ...cardBoxes.map((box) => box.x + box.width)) * (transform.k || 1) +
          transform.x,
        width,
        cardsAbove(cardBoxes, top),
      );
    /** True when the year labels are pinned over a view whose top is at `top` (map px). */
    const pinnedAt = (top: number) => orientation === 'horizontal' && top - (margin.top - 6) > 0;
    /**
     * Across the page, a year's label is shown only while one of its cards is in view, at least
     * in part: a label over an empty column would say that nothing is known for that year.
     */
    function showTicks() {
      if (orientation !== 'horizontal') return;
      const view = inView();
      axis.selectAll<SVGTextElement, unknown>('text.year-tick').attr('visibility', function () {
        const boxes = slotCards[Number(this.getAttribute('data-slot'))] ?? [];
        const shown = boxes.some((box) => box.y < view.bottom && box.y + box.height > view.top);
        return shown ? null : 'hidden';
      });
    }
    /** The cards past each edge of the view, for the edge cues. */
    function countCues() {
      const counts = edgeCounts(cardBoxes, inView());
      setCues((was) => (sameCounts(was, counts) ? was : counts));
      setUpBeside(upIsAside((insetRef.current - transform.y) / (transform.k || 1)));
    }

    /** The band the pinned labels take at the top of the view (screen px; none down a column). */
    const pinnedBand = () =>
      orientation === 'horizontal' ? (layout.axisSize + 6) * (transform.k || 1) : 0;
    /** Pins the row's labels to the top of the view once the map is panned down past them. */
    function pinAxis() {
      if (orientation !== 'horizontal') return;
      const k = transform.k || 1;
      const below = Math.max(0, (insetRef.current - transform.y) / k - (margin.top - 6));
      axis.attr('transform', below > 0 ? `translate(0,${below})` : null);
      axisBackdrop.attr('fill-opacity', below > 0 ? 1 : 0);
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
      .attr('data-year', (d) => d.year)
      .attr('data-shortened', (d) => d.shortened)
      .attr('transform', (d) => {
        const box = boxOf(d.id);
        return `translate(${box.x},${box.y})`;
      })
      .attr('tabindex', -1)
      .attr('role', (d) => (d.node.group === 1 ? 'img' : 'button'))
      .attr('aria-label', (d) => cardLabelRef.current(d.node, false))
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

    // The selection ring, solid, shown while the card is selected (its details are open).
    // (While a card is selected its panel replaces the hover box; a focused item's name still
    // says what the box would. Accepted.)
    node
      .append('rect')
      .attr('class', 'select-ring')
      .attr('x', -2)
      .attr('y', -2)
      .attr('width', (d) => d.width + 4)
      .attr('height', (d) => d.height + 4)
      .attr('rx', 5)
      .attr('fill', 'none')
      // White, at full strength: apart from the analysed track's cyan, an origin's amber and the
      // other cards' faint white frames.
      .attr('stroke', colors.white)
      .attr('stroke-width', 2)
      .attr('opacity', 0)
      .attr('vector-effect', 'non-scaling-stroke')
      .style('pointer-events', 'none');

    // The focus ring, shown while keyboard focus is on the card.
    node
      .append('rect')
      .attr('class', 'focus-ring')
      .attr('x', -5)
      .attr('y', -5)
      .attr('width', (d) => d.width + 10)
      .attr('height', (d) => d.height + 10)
      .attr('rx', 7)
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
    // Words cut on the card, said in words: "Title shortened" (the ellipsis alone is easy to
    // miss), set apart from the record's words. The whole title is in the card's name, its detail box and its details.
    lineText(
      'card-shortened',
      (d) => d.shortenedWrap,
      (d) => d.titleWrap.lines.length + d.metaWrap.lines.length + (d.tag ? 1 : 0),
      colors.gray[400],
    );
    // In italics: the map's own words, not the record's.
    words.selectAll('text.card-shortened').attr('font-style', 'italic');

    // A card's own drawing is decorative for screen readers: its name says it all.
    node.selectChildren().attr('aria-hidden', 'true');

    // 8. Chips: a link's relation, shown while the pointer or the focus is on the link or on a
    // card it joins (or, with neither, while a card it joins is selected: a tap shows them),
    // placed clear of every card and year label, in view (below the heading, above the detail
    // box or panel) and near the link's middle; a chip with no free place near it is left out
    // (the detail box and the panel say the same).
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
    // True after a touch on the map, until a mouse moves on it again.
    let touching = false;
    /** The selected card, as an item (null when none is). */
    const selectedItem = (): Item | null =>
      selectedRef.current === null ? null : { kind: 'node', id: selectedRef.current };

    function drawChips() {
      chips.selectAll('*').remove();
      leaders.selectAll('*').remove();
      const active = pointerOn ?? focusOn ?? selectedItem();
      if (!active) return;
      const k = transform.k || 1;
      // What is in view, in the map's units, below the heading and above the detail box.
      const top =
        insetRef.current + pinnedBand() + (detailTopRef.current ? detailInsetRef.current : 0);
      const bottom = height - (detailTopRef.current ? 0 : detailInsetRef.current);
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
      const wanted: Array<ChipInput & { text: string; link: DrawnLink }> = shown.map(
        (d, order) => ({
          near: d.route.mid,
          width: chipWidth(relationLabel(d.shown)),
          height: chipHeight,
          priority: -order,
          text: relationLabel(d.shown),
          link: d,
        }),
      );
      const at = placeChips(wanted, obstacles, view, { reach: CHIP_REACH });
      wanted.forEach((chip, index) => {
        const box = at[index];
        if (!box) return;
        const group = chips
          .append('g')
          .attr('class', 'chip')
          .attr('transform', `translate(${box.x},${box.y})`)
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
        group
          .append('rect')
          .attr('width', box.width)
          .attr('height', box.height)
          .attr('rx', 3)
          .attr('fill', colors.void)
          .attr('stroke', LINK_COLOR[chip.link.shown.type])
          .attr('stroke-dasharray', LINK_DASH[chip.link.shown.kind])
          .attr('vector-effect', 'non-scaling-stroke');
        group
          .append('text')
          .attr('x', 5)
          .attr('y', box.height - 6)
          .attr('fill', colors.white)
          .attr('font-family', 'IBM Plex Mono')
          .attr('font-size', `${LINE_LABEL_PX}px`)
          .text(chip.text);
      });
    }

    // 9. Interactions: what the pointer and keyboard focus are on (the detail box is React's;
    // this draws the rest).
    const drawActive = () => {
      const active = pointerOn ?? focusOn ?? selectedItem();
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
      // The cards the pointed track is not joined to fade back (never the selected one).
      const joined = new Set(
        activeNode === null
          ? []
          : [
              activeNode,
              ...(selectedRef.current === null ? [] : [selectedRef.current]),
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
    // The selected card: its ring, and its state for screen readers (a toggle button's).
    const drawSelected = () => {
      const selected = selectedRef.current;
      node
        .attr('aria-pressed', (d) => (d.id === currentId ? null : String(d.id === selected)))
        .attr('aria-label', (d) => cardLabelRef.current(d.node, d.id === selected))
        .select('.select-ring')
        .attr('opacity', (d) => (d.id === selected ? 1 : 0));
      drawActive();
    };
    const pointAt = (item: Item | null) => {
      // The pointer on a card or a link: the layout is held while it is on the map.
      if (item !== null) leaveRest(true);
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
      const [dx, dy] = [
        nearShift(left, right, 0, width),
        nearShift(
          top,
          bottom,
          insetRef.current + pinnedBand() + (detailTopRef.current ? detailInsetRef.current : 0),
          height - (detailTopRef.current ? 0 : detailInsetRef.current),
        ),
      ];
      // (The focus on the item ended the first view already: `leaveRest`.)
      if (dx !== 0 || dy !== 0) svg.call(zoomBehavior.translateBy, dx / k, dy / k);
    };

    /**
     * Where the selected card's panel goes: on the side of the map away from the analysed
     * track's card (at the top when that card lies below the selected one, else at the bottom),
     * so the view can hold the selected card beside the panel and leave the analysed one clear.
     */
    const panelAtTop = () => {
      const id = selectedRef.current;
      if (id === null || currentId === null || id === currentId) return false;
      const [selected, current] = [boxOf(id), boxOf(currentId)];
      return current.y + current.height / 2 > selected.y + selected.height / 2;
    };

    /**
     * Pans the view so the selected card is in view, clear of its panel, and the analysed track's
     * card is not under the panel either (on the far side of the selected card, or past the
     * view's edge) where a move allows both (`clearOfPanel`).
     */
    const bringSelectedClear = () => {
      const id = selectedRef.current;
      if (id === null) return;
      const k = transform.k || 1;
      const onScreen = (b: CardBox) => ({
        x: [transform.x + b.x * k, transform.x + (b.x + b.width) * k] as const,
        y: [transform.y + b.y * k, transform.y + (b.y + b.height) * k] as const,
      });
      const selected = onScreen(boxOf(id));
      const current = currentId !== null && currentId !== id ? onScreen(boxOf(currentId)) : null;
      const dx = nearShift(selected.x[0], selected.x[1], 0, width);
      const [from, to] = detailAcrossRef.current;
      // The analysed card matters where it is under the panel across the map.
      const under =
        current !== null && current.x[1] + dx > from && current.x[0] + dx < to ? current.y : null;
      const heading = insetRef.current + pinnedBand();
      // A selected card beside the panel (a desktop's corner panel) has the whole height.
      const beside = selected.x[1] + dx <= from || selected.x[0] + dx >= to;
      let dy: number;
      if (detailTopRef.current) {
        // The panel under the heading: the room is below it.
        const end = heading + detailInsetRef.current;
        const room = [beside ? heading + VIEW_PAD : end + VIEW_PAD, height - VIEW_PAD] as const;
        dy = clearOfPanel(selected.y, room, under, [0, end]);
      } else {
        const edge = height - detailInsetRef.current;
        const room = [heading + VIEW_PAD, beside ? height - VIEW_PAD : edge - VIEW_PAD] as const;
        dy = clearOfPanel(selected.y, room, under, [edge, height]);
      }
      // (The selection ended the first view already: `drawSelected`.)
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
    const listen = (
      element: SVGElement,
      type: string,
      listener: (event: Event) => void,
      capture = false,
    ) => {
      element.addEventListener(type, listener, capture);
      listening.push({ element, type, listener, capture });
    };
    // A press of the pointer or a finger on a card focuses it: the view does not move then (a
    // card that moved between the press and the release would not get the click, or the tap,
    // that selects it). The selected card is brought clear of its panel once it opens.
    let pressing = false;
    // True while a cue gives the focus to a card it brought into view: the view stays put
    // (`placed`, that card, until the focus moves on).
    let placing = false;
    let placed: Item | null = null;
    const svgElement = svg.node() as SVGSVGElement;
    listen(svgElement, 'pointerdown', (event) => {
      touching = (event as PointerEvent).pointerType === 'touch';
      // A press on the map (a card, a link, a drag): the reader is at work in it. A finger is
      // held only while it is on the map: a page scroll that starts on it leaves the view at
      // rest, a tap that focuses or selects a card does not.
      leaveRest(touching);
      pressing = true;
    });
    // The pointer off the map, having only passed over it: the view is at rest again.
    listen(svgElement, 'pointerleave', (event) => {
      if ((event as PointerEvent).pointerType !== 'touch') backToRest();
    });
    listen(svgElement, 'pointermove', (event) => {
      if ((event as PointerEvent).pointerType !== 'touch') touching = false;
    });
    // Before the card's own click handler (which stops the click there).
    // A press that ends without a click (a drag that panned, a touch d3 takes for a gesture) ends
    // it too. A mouse's press focused the card already (on its mousedown): it ends on release. A
    // finger's focuses it after the release (the mouse events a tap sends then): it ends on the
    // click, or a moment later when no click comes.
    const released = (event: Event) => {
      if ((event as PointerEvent).pointerType === 'mouse') {
        pressing = false;
        return;
      }
      setTimeout(() => {
        pressing = false;
        // A finger lifted with nothing done (a page scroll, a touch d3 left alone).
        if ((event as PointerEvent).pointerType === 'touch') backToRest();
      }, 500);
    };
    for (const type of ['pointerup', 'pointercancel']) {
      window.addEventListener(type, released, true);
    }
    unlisten.push(() => {
      for (const type of ['pointerup', 'pointercancel']) {
        window.removeEventListener(type, released, true);
      }
    });
    for (const type of ['click', 'keydown']) {
      listen(
        svgElement,
        type,
        () => {
          pressing = false;
        },
        true,
      );
    }
    items.forEach(({ item, element }, i) => {
      listen(element, 'focus', () => {
        // The focus on a card or a link: the reader is at work in the map, and a resize keeps
        // the drawing (and so the focus) as it is.
        leaveRest();
        setRoving(i);
        focusOn = item;
        placed = placing ? item : null;
        if (!pressing && !placing) bringIntoView(item);
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
    /** True when the item the pointer is on sits in the bottom band the detail box takes. */
    const pointedLow = () => pointerOn !== null && lowIn(pointerOn);
    /** True when an item sits in the bottom band the detail box takes. */
    const lowIn = (item: Item) => {
      const box =
        item.kind === 'node'
          ? boxOf(item.id)
          : (() => {
              const { mid } = drawnLinks[item.index].route;
              return { x: mid.x, y: mid.y, width: 0, height: 0 };
            })();
      const k = transform.k || 1;
      const bottom = transform.y + (box.y + box.height) * k;
      return bottom > height - (lowInsetRef.current || 64);
    };
    // Once React has drawn the detail box (or taken it away): the box at the top while the
    // pointed item is low, the focused item clear of it, and the chips placed again.
    afterDetailRef.current = () => {
      // The selected card's panel goes on the side away from the analysed track's card; the
      // hover box goes to the top while the item pointed at is low.
      // So does the box of a card an edge cue gave the focus to, low in the view: the view stays
      // where the cue left it.
      const top =
        selectedRef.current !== null
          ? panelAtTop()
          : pointerOn !== null
            ? pointedLow()
            : placed !== null && sameItem(focusOn, placed) && lowIn(placed);
      if (top !== detailTopRef.current) {
        detailTopRef.current = top;
        setDetailTop(top);
      }
      if (selectedRef.current !== null) bringSelectedClear();
      // (A card a cue gave the focus to is in view already, the box on its far side.)
      else if (focusOn && !pointerOn && !(placed !== null && sameItem(focusOn, placed))) {
        bringIntoView(focusOn);
      }
      drawChips();
    };
    // A track selected: the reader is at work in the map (the view and the layout are kept).
    drawSelectedRef.current = () => {
      if (selectedRef.current !== null) leaveRest();
      drawSelected();
    };
    drawSelected();
    svg.on('keydown', (event: KeyboardEvent) => {
      // Escape the map's root handled already (a selection or a pair playing).
      if (items.length === 0 || event.defaultPrevented) return;
      const at = items.findIndex(({ element }) => element === event.target);
      if (at === -1) return;
      // Escape stops A/B listening, then clears the selection, then closes the focused item's
      // detail box; with none of them it is the Player's.
      if (event.key === 'Escape') {
        if (escapeRef.current()) event.preventDefault();
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
        selectRef.current(item.id);
      }
    });

    linkTarget
      .on('mouseenter', (_event, d) => {
        if (!touching) pointAt({ kind: 'link', index: d.n });
      })
      .on('mouseleave', () => pointAt(null));

    node
      // Pointing at a track plays nothing: previews play from their own buttons (PreviewList)
      // and from the detail panel's A/B listening. A finger points at nothing: the browser's
      // mouse events after a tap would leave a card "pointed at" until the next tap.
      .on('mouseenter', (_event, d) => {
        if (!touching) pointAt({ kind: 'node', id: d.id });
      })
      .on('mouseleave', () => pointAt(null))
      // A click or a tap selects the track (its details open); it never analyses it.
      .on('click', (event, d) => {
        event.stopPropagation();
        // The second click of a double click (a zoom) does not toggle the selection back.
        if ((event as MouseEvent).detail > 1) return;
        selectRef.current(d.id);
      });

    // The first view, unless the reader has been at work in the map and it is laid out again for
    // the same tracks and axis (then the reader's view is kept). The map at its size, below the
    // panel's heading: whole and centred along the axis where it fits, else with the analysed
    // track's card whole in view (`planFirstView`); the layout ends no card across the view's
    // far edges (`breaks`), so at rest each card is wholly in view or wholly out of it, and the
    // edge cues say how many lie past each edge.
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
    /** Puts the view at the first view, for the room the map has now. */
    const showFirstView = () => {
      const at = planFor({ width, height });
      svg.call(zoomBehavior.transform, zoomIdentity.translate(at.x, at.y));
    };
    if (rest) {
      showFirstView();
    } else {
      if (kept) svg.call(zoomBehavior.transform, kept.transform);
      holdView();
    }
    // Laid out again with a track selected (a filter, a resize): the selected card back in view
    // and clear of its panel. A filter lays the map out afresh, so the pan and zoom start over
    // (accepted: the cards have new places).
    if (selectedRef.current !== null) {
      leaveRest();
      afterDetailRef.current?.();
    }
    // The item that had the focus in the last drawing has it again, wherever it now is.
    const refocus = refocusRef.current;
    refocusRef.current = null;
    if (refocus) {
      const byLink =
        refocus.link === null
          ? undefined
          : items.find(
              ({ item }) => item.kind === 'link' && linkKey(links[item.index]) === refocus.link,
            );
      (byLink ?? items.find(({ item }) => sameItem(item, refocus.item)))?.element.focus({
        preventScroll: true,
      });
    }

    // An edge cue pans the view that way, no further than it takes to bring the next cards
    // past that edge wholly into view, to a stop where no card is cut (a card's or a year's
    // edge), the analysed track's card kept in view where a stop allows it. When no card is
    // left past that edge, the focus goes to the first card that came into view (the cue goes).
    cuePanRef.current = (side) => {
      leaveRest();
      const k = transform.k || 1;
      const sign = side === 'right' || side === 'down' ? 1 : -1;
      const lo = (box: CardBox) => (side === 'left' || side === 'right' ? box.x : box.y);
      const view = {
        left: -transform.x / k,
        right: (width - transform.x) / k,
        top: (insetRef.current - transform.y) / k,
        bottom: (height - transform.y) / k,
      };
      const now = inView();
      const pastNow = edgeCounts(cardBoxes, now);
      const move = cuePan({
        side,
        cards: cardBoxes,
        anchor: anchorId ? boxOf(anchorId) : null,
        view,
        headOf,
        map: { width: mapWidth, height: mapHeight },
        buttonsOf: (counts, room) =>
          bottomCues(counts, width, cueWidth).map(
            ({ left, right }): CardBox => ({
              x: room.left + left / k,
              y: room.bottom - CUE_PX / k,
              width: (right - left) / k,
              height: CUE_PX / k,
            }),
          ),
        pad: VIEW_START_PAD,
      });
      if (move === null) return;
      if (move.dx !== 0 || move.dy !== 0) svg.call(zoomBehavior.translateBy, -move.dx, -move.dy);
      countCues();
      drawChips();
      // Nothing left past that edge: the focus on the first card that came into view.
      const after = inView();
      const whole = (area: typeof after, box: CardBox) =>
        box.x >= area.left - 0.5 &&
        box.x + box.width <= area.right + 0.5 &&
        box.y >= area.top - 0.5 &&
        box.y + box.height <= area.bottom + 0.5;
      if (edgeCounts(cardBoxes, after)[side] === 0 && pastNow[side] > 0) {
        const arrived = nodes
          .map((d, i) => ({ d, box: cardBoxes[i] }))
          .filter(({ box }) => whole(after, box) && !whole(now, box))
          .sort((a, b) => sign * (lo(a.box) - lo(b.box)) || a.box.y - b.box.y || a.box.x - b.box.x);
        // (None came wholly in, the cards there only nearer: the one in view nearest that edge.)
        const nearest = nodes
          .map((d, i) => ({ d, box: cardBoxes[i] }))
          .filter(({ box }) => whole(after, box))
          .sort((a, b) => sign * (lo(b.box) - lo(a.box)) || a.box.y - b.box.y || a.box.x - b.box.x);
        const first = arrived[0] ?? nearest[0];
        if (first) {
          const element = items.find(
            ({ item }) => item.kind === 'node' && item.id === first.d.id,
          )?.element;
          placing = true;
          element?.focus({ preventScroll: true });
          placing = false;
        }
      }
    };
    focusMapRef.current = () => {
      const element = items.find((one) => one.element.getAttribute('tabindex') === '0')?.element;
      if (!element) return;
      // (As a card a cue gives the focus to: the view stays where the cue left it.)
      placing = true;
      element.focus({ preventScroll: true });
      placing = false;
    };

    /**
     * At rest, the first view again for the room the map has now: laid out again where the view
     * now ends elsewhere across the map's cards, else the same drawing, placed anew. True when
     * it did either (the view was at rest).
     */
    const refit = () => {
      if (!rest) return false;
      if (!sameBreaks(breaksFor({ width, height }), breaks)) {
        setRestLayout((count) => count + 1);
        return true;
      }
      showFirstView();
      if (selectedRef.current !== null) afterDetailRef.current?.();
      drawChips();
      return true;
    };

    // A heading that grows or shrinks moves the view by as much (at rest, the first view anew).
    insetShiftRef.current = (by) => {
      if (refit()) return;
      svg.call(zoomBehavior.translateBy, 0, by / (transform.k || 1));
    };

    // A resize that keeps the axis and the cards' width keeps the drawing and its zoom: the svg
    // takes the new size, and the view moves by half the change, so what was at the middle of
    // the panel is at its middle again. At rest the view is the first view for the new size.
    resizeRef.current = (next) => {
      const [dx, dy] = [(next.width - width) / 2, (next.height - height) / 2];
      ({ width, height } = next);
      svg.attr('width', width).attr('height', height);
      if (refit()) return;
      const k = transform.k || 1;
      svg.call(zoomBehavior.translateBy, dx / k, dy / k);
      holdView();
      countCues();
      // A selected card stays clear of its panel in the new size (the legend's filters opening
      // below the map shorten it, for one).
      if (selectedRef.current !== null) afterDetailRef.current?.();
      drawChips();
    };

    // Everything the drawing started stops with it: transitions (the hint's fade, a double
    // click's zoom) and their timers, and every listener on the svg and its elements.
    return () => {
      gone = true;
      // The item with the focus gets it back in the next drawing (`refocus`).
      const active = document.activeElement;
      refocusRef.current =
        focusOn !== null && active !== null && svgElement.contains(active)
          ? {
              item: focusOn,
              link: focusOn.kind === 'link' ? linkKey(links[focusOn.index]) : null,
            }
          : null;
      resizeRef.current = null;
      cuePanRef.current = null;
      focusMapRef.current = null;
      insetShiftRef.current = null;
      afterDetailRef.current = null;
      drawSelectedRef.current = null;
      svg.interrupt();
      svg.selectAll('*').interrupt();
      svg.on('.zoom', null).on('keydown', null);
      node.on('mouseenter', null).on('mouseleave', null).on('click', null);
      linkTarget.on('mouseenter', null).on('mouseleave', null);
      for (const remove of unlisten) remove();
      for (const { element, type, listener, capture } of listening) {
        element.removeEventListener(type, listener, capture);
      }
      setHovered(null);
      setFocused(null);
    };
  }, [
    sparse,
    shownNodes,
    links,
    nameOf,
    yearOfNode,
    currentId,
    relations,
    isOrigin,
    orientation,
    textWidth,
    perRow,
    clipPrefix,
    reducedMotion,
    restLayout,
  ]);

  // A resize the drawing keeps (see `resizeRef`).
  useEffect(() => {
    if (panel) resizeRef.current?.(panel);
  }, [panel]);

  // The tracks the filters keep: the summary and the compact row name these.
  const nodeList = shownNodes;
  const hiddenTracks = filtered.hiddenTracks;
  const related = nodeList.filter((node) => node.group !== 1);
  // The gestures, in words, as the graph takes them here (see the zoom's filter).
  const touch = useNoHover();
  const hints =
    wheelZoom === 'modifier'
      ? touch
        ? [
            'Pinch with two fingers to zoom',
            'Drag with two fingers to pan',
            'Tap a track for its details',
          ]
        : ['Ctrl or ⌘ + scroll to zoom', 'Drag to pan', 'Click a track for its details']
      : touch
        ? ['Pinch to zoom', 'Drag to pan', 'Tap a track for its details']
        : ['Scroll to zoom', 'Drag to pan', 'Click a track for its details'];

  // The selected track, while the filters show it (a filter that hides it clears it).
  const selectedNode =
    selectedId === null ? null : (shownNodes.find((node) => node.id === selectedId) ?? null);
  // A filter that hides the selected track closes its details, and the filters' status says so.
  // A track gone for another reason (a new map without it) just leaves no selection.
  const [filterNote, setFilterNote] = useState<string | null>(null);
  const changeFilter = (next: LinkFilter) => {
    setFilterNote(null);
    setFilter(next);
  };
  const filtering = isFiltering(filter);
  useEffect(() => {
    if (selectedId !== null && selectedNode === null) {
      setSelectedId(null);
      setFilterNote(
        filtering
          ? `The details of ${nameOf(selectedId)} closed: the filters hide that track`
          : null,
      );
    }
  }, [selectedId, selectedNode, nameOf, filtering]);
  // Read by the drawing (its chips, the view it keeps the card in) as it is drawn now.
  selectedRef.current = selectedNode?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: draws the selection when it changes
  useLayoutEffect(() => {
    drawSelectedRef.current?.();
  }, [selectedNode]);
  // A new selection (or none) stops A/B listening, and an opened panel takes the focus.
  const stopAb = ab.stop;
  useEffect(() => {
    stopAb();
    if (selectedNode) panelRef.current?.focus();
  }, [selectedNode, stopAb]);

  /** Puts the focus back on a track's card (the canvas's, or the compact row's). */
  const focusCard = (id: string) => {
    const root = rootRef.current;
    if (!root) return;
    const card = [
      ...root.querySelectorAll<HTMLElement | SVGElement>('g.nodes > g, button[data-card-id]'),
    ].find(
      (element) =>
        (element.getAttribute('data-node-id') ?? element.getAttribute('data-card-id')) === id,
    );
    card?.focus({ preventScroll: true });
  };
  /** Closes the panel; the focus, when it was in the panel, goes back to the card. */
  const closeSelection = () => {
    const id = selectedNode?.id;
    const active = document.activeElement;
    const inPanel = active !== null && (panelRef.current?.contains(active) ?? false);
    setSelectedId(null);
    if (id && (inPanel || active === document.body)) focusCard(id);
  };
  // Escape closes a list open over the panel first (the links, the previews), then stops A/B
  // listening, then closes the panel, then the hover box. With neither a selection nor a pair
  // playing an open list is the Player's to close, as before.
  const escapeRef = useRef<() => boolean>(() => false);
  escapeRef.current = () => {
    const list =
      ab.playing || selectedNode
        ? rootRef.current?.querySelector<HTMLDetailsElement>(`details[name="${GRAPH_LISTS}"][open]`)
        : null;
    if (list) {
      const active = document.activeElement;
      list.open = false;
      if (active && list.contains(active)) list.querySelector('summary')?.focus();
      return true;
    }
    if (ab.playing) {
      ab.stop();
      return true;
    }
    if (selectedNode) {
      closeSelection();
      return true;
    }
    return dismissRef.current();
  };
  /**
   * Escape anywhere in the map (the panel, a card, the canvas, the filters), while a track is
   * selected or a pair plays: it stops the pair, then closes the panel, before anything else
   * (and before the Player's Escape, which would leave the map). Caught on the way down, so the
   * canvas's own key handler sees it handled.
   */
  const onRootKeyDownCapture = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || event.isDefaultPrevented()) return;
    if (!ab.playing && !selectedNode) return;
    if (escapeRef.current()) event.preventDefault();
  };
  // The same with the focus on no element (the page's body), while the map is on screen: the
  // Player would take that Escape as its own and leave the map.
  const escapeOwned = Boolean(ab.playing || selectedNode);
  useEffect(() => {
    if (!escapeOwned) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const target = event.target;
      if (target !== document.body && target !== document.documentElement && target !== document) {
        return;
      }
      const root = rootRef.current;
      if (!root || (typeof root.checkVisibility === 'function' && !root.checkVisibility())) return;
      if (escapeRef.current()) event.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [escapeOwned]);

  // A/B listening: the selected track and this one, the earlier record first.
  const currentNode = currentId === null ? null : (named.get(currentId) ?? null);
  const clipOf = (url: unknown) => (typeof url === 'string' && url ? url : null);
  const selectedLink = selectedNode
    ? relationToTrack(links, selectedNode.id, currentId).link
    : null;
  const plan =
    selectedNode && currentId !== null && currentNode
      ? listeningPlan({
          selected: {
            id: selectedNode.id,
            name: nameOf(selectedNode.id),
            url: clipOf(selectedNode.previewUrl),
          },
          current: {
            id: currentId,
            name: nameOf(currentId),
            url:
              clipOf(trackPreviewUrl) ??
              clipOf(graphNodes(data).find((node) => node.id === currentId)?.previewUrl),
          },
          link: selectedLink,
          replay,
        })
      : null;
  // The panel lies over the bottom of the map, unless the map is a compact row or too short to
  // leave its card room above it (a landscape phone): then it follows the map, in the flow.
  const inlinePanel = sparse || (panel !== null && panel.height < SHORT_MAP_PX);
  // A box at the map's top goes below "↑ N more" while that cue shows, never over it.
  const belowCue = mapInset - topInset + 2 + CUE_PX;
  const detailBelowCue = detailTop && cues.up > 0 ? belowCue : 0;
  // And one at its bottom goes above the bottom cues ("← N more", "N more ↓/→") while they show.
  // From md up the selected track's panel lies at the map's right, clear of "← N more".
  const bottomRoom = cues.left + cues.right + cues.down > 0 ? CUE_PX + 4 : 8;
  const panelRoom =
    panel !== null && panel.viewport >= MD_PX
      ? cues.right + cues.down > 0
        ? CUE_PX + 4
        : 8
      : bottomRoom;
  const detailBottom = detailTop ? 8 : bottomRoom;
  const detailPanel = selectedNode && (
    <DetailPanel
      panelRef={panelRef}
      layout={inlinePanel ? 'inline' : detailTop ? 'top' : 'overlay'}
      topOffset={topInset + 4 + detailBelowCue}
      bottomOffset={detailTop ? 8 : panelRoom}
      // As much shorter as the room it can be moved by for the cues: its far edge stays put.
      shorterBy={detailTop ? belowCue : CUE_PX + 4 - 8}
      node={selectedNode}
      year={yearOfNode(selectedNode.id)}
      links={links
        .filter((link) => link.source === selectedNode.id || link.target === selectedNode.id)
        .sort((a, b) => rank(b) - rank(a))}
      nameOf={nameOf}
      claims={claims}
      plan={plan}
      listening={ab.playing}
      listeningMessage={ab.message}
      onListen={() => {
        if (plan?.kind !== 'ready') return;
        stopPreview();
        ab.start(plan.steps);
      }}
      onStopListening={ab.stop}
      onAnalyse={() => analyseRef.current(selectedNode)}
      onClose={closeSelection}
    />
  );
  // Every link hidden by the filters: what is hidden, and a way back.
  const filteredOut = isFiltering(filter) && links.length === 0 && allLinks.length > 0 && (
    <div
      data-testid="filters-empty"
      className="flex flex-col items-start gap-2 rounded-sm border border-white/15 bg-void p-3 font-mono text-chrome text-text-chip"
    >
      <p>No links match the filters: {hiddenText(filter)} are hidden.</p>
      <Button type="button" variant="neutral" size="sm" onClick={() => changeFilter(NO_FILTER)}>
        Clear filters
      </Button>
    </div>
  );

  const pointed = hovered ?? focused;
  // The hover box is the unselected map's: with a track selected, its panel says it.
  const active = selectedNode || sameItem(pointed, dismissed) ? null : pointed;
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
    // The panel's height (on the canvas), else the hover box's.
    const box = (inlinePanel ? null : panelRef.current) ?? detailRef.current;
    // The room it takes, the cues' strip beside it always counted, as if they showed: a pan that
    // shows or hides a cue moves the box, never this room, so the selected card or the focused
    // item is not placed again for it (and that pan again: it could go back and forth for good).
    const inset = box ? box.offsetHeight + (detailTop ? 8 + belowCue : CUE_PX + 4) : 0;
    detailAcrossRef.current = box ? [box.offsetLeft, box.offsetLeft + box.offsetWidth] : [0, 0];
    // What the box shows, and how tall it is: either changing places things again.
    const shown = `${
      selectedNode ? `selected:${selectedNode.id}` : active === null ? '' : JSON.stringify(active)
    }|${detailTop ? 'top' : 'bottom'}`;
    lowInsetRef.current = box ? box.offsetHeight + CUE_PX + 4 : 0;
    if (inset === detailInsetRef.current && shown === detailShownRef.current) return;
    detailInsetRef.current = inset;
    detailShownRef.current = shown;
    afterDetailRef.current?.();
  });
  const keyboardOnNode = focused?.kind === 'node' && sameItem(active, focused);
  // Every drawn related track with a clip, whether or not a shown link names it: each has its
  // preview button (PreviewList).
  // (The filters' tracks only: the list shows what the map shows.)
  const shownIds = new Set(shownNodes.map((node) => node.id));
  const previewTracks = previewTracksOf(data).filter((track) => shownIds.has(track.id));

  // P2:22 — Accessible summary for screen readers: each track's relation comes from the link
  // that joins it to this one, never from its group.
  const summary = (
    <div className="sr-only">
      Connections
      {related.length > 0
        ? `: ${related.length} related ${related.length === 1 ? 'track' : 'tracks'}`
        : ''}
      .
      {hiddenTracks > 0 &&
        ` The filters hide ${hiddenTracks} ${hiddenTracks === 1 ? 'track' : 'tracks'} and ${allLinks.length - links.length} ${allLinks.length - links.length === 1 ? 'link' : 'links'}.`}
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
        ' In the graph, the arrow keys move between the tracks and the links; Enter selects the focused track and opens its details.'}
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
    <div
      ref={rootRef}
      onKeyDownCapture={onRootKeyDownCapture}
      // With the panel in the flow under a short map, the map, the panel and the legend scroll
      // in the map's panel (the map keeps its height): "Analyze this track" stays in reach.
      className={`relative w-full flex flex-col ${sparse ? '' : 'flex-1 min-h-0'} ${!sparse && inlinePanel && selectedNode ? 'overflow-y-auto' : ''}`}
    >
      {sparse ? (
        // Two relations or fewer: a compact row of cards, as tall as it needs, the selected
        // track's details under it.
        <div className="relative">
          <LineageRow
            topInset={topInset}
            nodes={nodeList}
            links={links}
            currentId={currentId}
            yearOf={yearOfNode}
            isOrigin={isOrigin}
            describe={(node) => cardLabel(node, node.id === selectedNode?.id)}
            nameOf={nameOf}
            selectedId={selectedNode?.id ?? null}
            onSelect={(node) => selectRef.current(node.id)}
          />
          {filteredOut && <div className="px-4 pb-3">{filteredOut}</div>}
          {detailPanel}
          {summary}
          {previewState}
        </div>
      ) : (
        <div
          ref={wrapperRef}
          className="relative flex-1 min-h-0 overflow-hidden cursor-move bg-radial-[circle_at_center] from-surface from-0% to-transparent to-70%"
          // With the panel after it, the map keeps the height it had (its box scrolls instead).
          style={inlinePanel && selectedNode && panel ? { minHeight: panel.height } : undefined}
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

          {/* Across the page, over the axis: the years keep their order, not their distance */}
          {(noteOverAxis || noteInHeading) && (
            <p
              className={`absolute z-10 pointer-events-none text-right text-chrome font-mono text-text-chip ${noteInHeading ? 'right-4' : 'inset-x-0 bg-void px-3'}`}
              style={{
                top: noteInHeading ? topInset - 8 - (HEADING_ROW_PX + AXIS_NOTE_PX) / 2 : topInset,
                height: AXIS_NOTE_PX,
                lineHeight: `${AXIS_NOTE_PX}px`,
              }}
              data-testid="axis-note"
              data-at={noteInHeading ? 'heading' : 'axis'}
            >
              {AXIS_NOTE}
            </p>
          )}

          {/* The edge cues: how many cards lie past each edge of the view, each a button that
              pans the view that way: "↑" at the top (across the page at the left, on the
              pinned year labels' band; down a column at the right, in the gutter beside the
              cards where it fits, else on a band of its own), the others at the bottom; at
              rest none lies over a card */}
          {orientation !== null && cues.left + cues.right + cues.up + cues.down > 0 && (
            <div ref={cuesRef} data-testid="map-cues" className="contents">
              {(
                [
                  // Across the page on the pinned labels' band; down a column on a band of
                  // its own, opaque (the view's room for cards starts under it).
                  // Down a column, in the gutter right of the cards where it fits there.
                  orientation === 'horizontal'
                    ? [['up'], 'left-2', { top: mapInset + 2 }]
                    : upBeside
                      ? [['up'], 'right-2', { top: mapInset + 2 }]
                      : [['up'], 'inset-x-0 bg-void px-2', { top: mapInset }],
                  [['left'], 'left-2 bottom-0', { bottom: 0 }],
                  [['down', 'right'], 'right-2 bottom-0', { bottom: 0 }],
                ] satisfies Array<[Array<keyof EdgeCounts>, string, React.CSSProperties]>
              ).map(([group, place, style]) => {
                const sides = group.filter((side) => cues[side] > 0);
                if (sides.length === 0) return null;
                return (
                  <div
                    key={group[0]}
                    data-cue-band={
                      group[0] === 'up' && orientation === 'vertical' && !upBeside ? '' : undefined
                    }
                    className={`absolute ${place} z-10 flex items-center gap-2 pointer-events-none`}
                    style={{ height: CUE_PX, ...style }}
                  >
                    {sides.map((side) => (
                      <button
                        key={side}
                        type="button"
                        data-cue={side}
                        aria-label={cueName(side, cues[side], orientation)}
                        onClick={(event) => {
                          const button = event.currentTarget;
                          cuePanRef.current?.(side);
                          // A cue with nothing left past its edge goes, the focus on the first
                          // card it brought into view; failing one, on the map. The cue itself
                          // says so: where a click does not focus a button (Safari, Firefox on
                          // macOS), the focus is on no element while the cue stays.
                          requestAnimationFrame(() => {
                            if (button.isConnected) return;
                            if (document.activeElement && document.activeElement !== document.body)
                              return;
                            focusMapRef.current?.();
                          });
                        }}
                        className="pointer-events-auto inline-flex min-h-6 items-center gap-1 rounded-sm border border-white/15 bg-black/80 px-1.5 text-chrome font-mono text-text-secondary hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyber/70"
                      >
                        {CUE_TEXT[side](cues[side])}
                      </button>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

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
              data-at={detailTop ? 'top' : 'bottom'}
              className="absolute left-2 right-2 z-20 pointer-events-none rounded-sm border border-white/15 bg-black/90 px-2 py-1.5 text-chrome font-mono text-text-chip wrap-anywhere"
              style={detailTop ? { top: topInset + 4 + detailBelowCue } : { bottom: detailBottom }}
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
                  {keyboardOnNode && activeNode.group !== 1 && <p>Enter: show its details</p>}
                </>
              )}
            </div>
          )}

          {/* The selected track's details, over the bottom of the map (the view keeps its card
              and the analysed track's above them) */}
          {!inlinePanel && detailPanel}

          {filteredOut && (
            <div className="absolute inset-x-2 bottom-2 z-20 flex justify-center">
              {filteredOut}
            </div>
          )}

          {previewState}
        </div>
      )}
      {/* A map too short for the panel over it: the panel after it, in the flow */}
      {!sparse && inlinePanel && detailPanel && <div className="shrink-0 pt-2">{detailPanel}</div>}

      {/* What the lines mean, in words, the filters, and the links as a list (which opens over
          the graph) */}
      {(allLinks.length > 0 || hidden > 0 || previewTracks.length > 0) && (
        // Opaque and above the graph: nodes the graph draws past its edge do not cover it. Above
        // the selected track's panel too (z-30): a list opened here (the links, the previews)
        // lies over the map and the panel, as what was opened last, and Escape closes it first.
        <div className="relative z-40 shrink-0 flex flex-col gap-2 border-t border-white/5 px-4 pt-3 pb-4 bg-void">
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
          {/* The axis keeps the years' order, not their distance: a gap of forty years is not
              forty times one of a year. Not on a short screen, where every pixel goes to the
              map. */}
          {!sparse && !noteOverAxis && !noteInHeading && (
            <p
              className="text-chrome font-mono text-text-chip [@media(max-height:36rem)]:hidden"
              data-testid="axis-note"
            >
              Years in order, not to scale.
            </p>
          )}
          {hidden > 0 && (
            <p className="text-chrome font-mono text-text-chip" data-testid="links-hidden">
              {hidden === 1
                ? '1 link not shown: the claim behind it was rejected or cannot be read.'
                : `${hidden} links not shown: the claims behind them were rejected or cannot be read.`}
            </p>
          )}
          {/* The list of links (the map's text alternative, the next stop after it), the
              filters and the previews, on one line where they fit: the map keeps its room */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <LinkList links={links} nameOf={nameOf} />
            {allLinks.length > 0 && (
              <LinkFilters
                counts={counts}
                filter={filter}
                onChange={changeFilter}
                note={filterNote}
                shownOf={(kind) => shownCounts.get(kind) ?? 0}
                shown={links.length}
                total={allLinks.length}
              />
            )}
            <PreviewList
              tracks={previewTracks}
              nameOf={nameOf}
              playingId={isPlaying ? playingNodeId : null}
              onToggle={(id, url) => playPreview(url, id)}
            />
          </div>
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
        </div>
      )}
    </div>
  );
};

export default React.memo(GenealogyGraph);
