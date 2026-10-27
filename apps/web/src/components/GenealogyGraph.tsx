import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { type Selection, select } from 'd3-selection';
import { type D3ZoomEvent, zoom, zoomIdentity, type ZoomTransform } from 'd3-zoom';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  forceX,
  forceY,
} from 'd3-force';
import type { Simulation } from 'd3-force';
import { type D3DragEvent, drag } from 'd3-drag';
import 'd3-transition'; // Side-effect import: augments Selection with .transition()
import type { Transition } from 'd3-transition';
import { Volume2, VolumeX, MousePointerClick } from 'lucide-react';
import { colors, genealogyColors } from '../styles/theme';
import { placeholderImage } from '../styles/placeholder';
import type { GenealogyGraphProps, CustomNode, CustomLink } from './genealogy/types';
import { useAudioPreview } from './genealogy/useAudioPreview';
import {
  describeLink,
  isDocumentedSource,
  kindLabel,
  nodeName,
  nodesById,
  provenanceText,
  rank,
  linkContext,
  readGenealogy,
  yearFrom,
  relationLabel,
  relationSentence,
  relationToTrack,
  type ShownLink,
} from './genealogy/links';
import { labelHeight, labelWidth, placeLabels } from './genealogy/labels';
import { LINK_COLOR, LINK_DASH, LINK_OPACITY, linkWidth } from './genealogy/linkStyle';
import { GRAPH_TEXT_PX, LINE_LABEL_PX, NODE_LABEL_PX, SUB_LABEL_PX } from './genealogy/textSize';
import { LinkLegend } from './genealogy/LinkLegend';
import { LinkList } from './genealogy/LinkList';
import { PreviewList } from './genealogy/PreviewList';
import { isValidImageUrl } from '../utils/image';
import { useReducedMotion } from '../utils/motion';
import type { TrackData } from '../types';

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

/** The words on a link's line: its relation as the cards name it, hedged when it is not sourced. */
function lineLabel(link: ShownLink): string {
  return link.directionKnown ? relationLabel(link).toLowerCase() : 'related';
}

/** Where along its line a line's label may go, the middle first. */
/**
 * Where a line's label may go, the first that fits: along the line (0 at its source, 1 at its
 * target, the middle first), above it or just below it.
 */
const LINE_LABEL_PLACES = [0.5, 0.58, 0.42, 0.66, 0.34, 0.74, 0.26, 0.82, 0.18, 0.9, 0.1].flatMap(
  (at) => [
    { at, below: false },
    { at, below: true },
  ],
);
/** A line label's baseline from its line: 0.4 em above, or 1.1 em below. */
const lineLabelDy = (below: boolean) => (below ? '1.1em' : '-0.4em');

/** A link's end once d3-force has resolved it to its track (an id before that: at 0). */
const endOf = (end: CustomNode | string): { x: number; y: number } =>
  typeof end === 'string' ? { x: 0, y: 0 } : { x: end.x ?? 0, y: end.y ?? 0 };

/** The size of the graph's box on screen, in px. */
type Size = { width: number; height: number };

/** The genealogy's nodes, or none when the list is missing. */
function graphNodes(
  data: Partial<TrackData['genealogy']> | null | undefined,
): TrackData['genealogy']['nodes'] {
  return Array.isArray(data?.nodes) ? data.nodes : [];
}

const GenealogyGraph: React.FC<GenealogyGraphProps> = ({
  data,
  evidence,
  claims,
  releaseYear,
  hiddenLinks = 0,
  onNodeClick,
  wheelZoom = 'plain',
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // The links that can be drawn (d3-force throws on a link to an unknown node id, which would
  // take the whole page down), each read with the contract's link schema and shown by its rule
  // and this app's stricter ones; links whose claim the verifier contradicted are left out.
  const reading = useMemo(
    () => readGenealogy(data, linkContext(evidence, claims, { releaseYear })),
    [data, evidence, claims, releaseYear],
  );
  const links = reading.links;
  const hidden = reading.hidden + hiddenLinks;
  const nameOf = useMemo(() => {
    const nodes = nodesById(data?.nodes, yearFrom(releaseYear));
    return (id: string) => nodeName(nodes.get(id), id);
  }, [data, releaseYear]);
  const currentId = useMemo(
    () => graphNodes(data).find((node) => node.group === 1)?.id ?? null,
    [data],
  );
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

  // Clip ids for the tracks' pictures: this graph's own prefix (an id may hold only letters,
  // digits, - and _) and the track's index, never the track's id, which may hold any character.
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

  // The graph's size on screen (ResizeObserver). The first one draws the graph and fixes its
  // node scale; a later one keeps the drawing, its layout and the zoom's scale, and shifts the
  // view so the graph stays centred (`resizeRef`, set by the drawing). A hidden panel (the phone
  // tabs) measures 0 by 0: the graph keeps its last size.
  const sizeRef = useRef<Size | null>(null);
  const firstSizeRef = useRef<Size | null>(null);
  const resizeRef = useRef<((size: Size) => void) | null>(null);
  const [sized, setSized] = useState(false);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const resizeObserver = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || box.width === 0 || box.height === 0) return;
      const { width, height } = box;
      const last = sizeRef.current;
      if (last && last.width === width && last.height === height) return;
      sizeRef.current = { width, height };
      firstSizeRef.current ??= { width, height };
      if (resizeRef.current) resizeRef.current({ width, height });
      else setSized(true);
    });

    resizeObserver.observe(wrapper);
    return () => resizeObserver.disconnect();
  }, []);

  // Under reduced motion the layout is worked out before it is drawn, and nothing glides.
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const size = sizeRef.current;
    const firstSize = firstSizeRef.current;
    if (!svgRef.current || !wrapperRef.current || !sized || !size || !firstSize) return;

    // 1. Setup & Cleanup
    const svg = select(svgRef.current);
    svg.selectAll('*').remove();
    // Listeners added here outside d3 (focus and blur), removed when the drawing goes.
    const listening: Array<{ element: SVGElement; type: string; listener: () => void }> = [];

    // A hint shown on hover fades in, or appears at once under reduced motion.
    const fadeIn = (hint: Selection<SVGTextElement, unknown, null, undefined>) => {
      if (reducedMotion) hint.style('opacity', 1);
      else hint.style('opacity', 0).transition().duration(300).style('opacity', 1);
    };

    // The size now: a resize changes it (see the end of this effect), and the first fit uses it.
    let { width, height } = size;
    svg.attr('width', width).attr('height', height);

    // Responsive scaling: detect if mobile (narrow viewport), from the first size only, so a
    // resize does not change the tracks' size
    const isMobile = firstSize.width < 500;
    const nodeScale = isMobile ? 0.6 : 1;
    const linkDistance = isMobile ? 80 : 120;
    const chargeStrength = isMobile ? -300 : -400;
    // The fit never shrinks the graph below this: lines, dashes and labels stay readable, and
    // what does not fit can be panned to.
    const minFitScale = isMobile ? 0.5 : 0.35;

    // 2. Define Glow Filters (Cinematic Neon Look)
    const defs = svg.append('defs');

    // Cyan Glow (Cyber)
    const cyanFilter = defs.append('filter').attr('id', 'glow-cyan');
    cyanFilter.append('feGaussianBlur').attr('stdDeviation', '3.5').attr('result', 'coloredBlur');
    const cyanMerge = cyanFilter.append('feMerge');
    cyanMerge.append('feMergeNode').attr('in', 'coloredBlur');
    cyanMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // Amber Glow (Analog/Origin)
    const amberFilter = defs.append('filter').attr('id', 'glow-amber');
    amberFilter.append('feGaussianBlur').attr('stdDeviation', '3.5').attr('result', 'coloredBlur');
    const amberMerge = amberFilter.append('feMerge');
    amberMerge.append('feMergeNode').attr('in', 'coloredBlur');
    amberMerge.append('feMergeNode').attr('in', 'SourceGraphic');

    // 3. Zoom Behavior. Text keeps its size on screen whatever the zoom, and line labels that
    // would overlap are hidden, the best known relations kept.
    const g = svg.append('g');
    let transform: ZoomTransform = zoomIdentity;
    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      // The wheel zooms only when nothing around the graph scrolls, or with Ctrl or ⌘ held:
      // otherwise it is left to the page, which scrolls past the graph. A drag pans and a touch
      // pinch zooms as before (d3's own rule: no Ctrl-drag, primary button only).
      .filter((event: Event) => {
        if (event.type === 'wheel') {
          const wheel = event as WheelEvent;
          return wheelZoomRef.current === 'plain' || wheel.ctrlKey || wheel.metaKey;
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
        fitText();
      });

    svg.call(zoomBehavior);

    // 4. Force Simulation Setup
    // d3-force writes each node's place and speed (x, y, vx, vy, fx, fy, index) on the objects
    // it is given: each node is copied, so the props are never written to.
    const nodes: CustomNode[] = graphNodes(data).map((n) => ({
      ...n,
      size: n.size * nodeScale, // Scale node sizes for mobile
    }));
    // Copies: d3-force replaces each link's source and target with the node objects.
    const simulationLinks: CustomLink[] = links.map((shown, n) => ({
      source: shown.source,
      target: shown.target,
      value: shown.value,
      n,
      shown,
    }));
    // Tracks at an end of a drawn link (the shown ones; a rejected link is not drawn).
    const linked = new Set(links.flatMap((shown) => [shown.source, shown.target]));
    // Each track's relation to the analysed one, from the link that joins them.
    const relations = new Map(nodes.map((n) => [n.id, relationToTrack(links, n.id, currentId)]));
    // Tracks a sourced sample, interpolation, cover or remix says the analysed track uses.
    const isOrigin = (d: CustomNode) => {
      const relation = relations.get(d.id);
      return (
        currentId !== null &&
        d.group !== 1 &&
        relation !== undefined &&
        isDocumentedSource(relation, d.id)
      );
    };

    // Create simulation centered at viewport center
    const simulation = forceSimulation<CustomNode, CustomLink>(nodes)
      .force(
        'link',
        forceLink<CustomNode, CustomLink>(simulationLinks)
          .id((d) => d.id)
          .distance(linkDistance),
      )
      .force('charge', forceManyBody<CustomNode>().strength(chargeStrength))
      .force('center', forceCenter<CustomNode>(width / 2, height / 2)) // Center the whole graph
      .force(
        'collide',
        forceCollide<CustomNode>().radius((d) => d.size + (isMobile ? 8 : 15)),
      )
      // A light pull to the middle: a track with no link shown (its only link rejected, or
      // none sent) is not pushed off into the distance, taking the fit with it.
      .force('x', forceX<CustomNode>(width / 2).strength(0.04))
      .force('y', forceY<CustomNode>(height / 2).strength(0.04));
    /** The ticks a layout takes to settle from `alpha`, played at once under reduced motion. */
    const ticksToSettle = (alpha: number) =>
      Math.ceil(Math.log(simulation.alphaMin() / alpha) / Math.log(1 - simulation.alphaDecay()));
    // Under reduced motion the layout is not played out frame by frame: it is computed at once
    // once the graph is built (see the end of this effect), and drawn settled.
    if (reducedMotion) simulation.stop();

    // Auto-fit once the layout first settles; a later drag keeps the user's view.
    let fitted = false;
    // The fit's glide while it runs (cleared when it ends or something interrupts it): a resize
    // meanwhile fits again to the new size, where shifting the view would stop the glide halfway.
    let glide: Transition<SVGSVGElement, unknown, null, undefined> | null = null;
    const settle = () => {
      if (fitted) {
        fitText();
        return;
      }
      fitted = true;
      fitView();
    };
    /** Fits the graph to the panel's size now, gliding there unless motion is reduced. */
    function fitView() {
      // Calculate bounding box of all nodes
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
      nodes.forEach((n) => {
        const padding = n.size + 40; // Account for labels
        if (n.x !== undefined && n.y !== undefined) {
          minX = Math.min(minX, n.x - padding);
          maxX = Math.max(maxX, n.x + padding);
          minY = Math.min(minY, n.y - padding);
          maxY = Math.max(maxY, n.y + padding);
        }
      });

      const graphWidth = maxX - minX;
      const graphHeight = maxY - minY;
      const graphCenterX = (minX + maxX) / 2;
      const graphCenterY = (minY + maxY) / 2;

      // Calculate scale to fit with padding
      const padding = isMobile ? 40 : 60;
      const scaleX = (width - padding * 2) / graphWidth;
      const scaleY = (height - padding * 2) / graphHeight;
      const scale = Math.max(Math.min(scaleX, scaleY, 1.5), minFitScale); // Cap max zoom

      // Apply transform to center and fit
      const translateX = width / 2 - graphCenterX * scale;
      const translateY = height / 2 - graphCenterY * scale;

      const fit = zoomIdentity.translate(translateX, translateY).scale(scale);
      if (reducedMotion) {
        svg.call(zoomBehavior.transform, fit);
        return;
      }
      const gliding = svg.transition().duration(500);
      glide = gliding;
      gliding
        .on('end.glide interrupt.glide', () => {
          if (glide === gliding) glide = null;
        })
        .call(zoomBehavior.transform, fit);
    }
    simulation.on('end', settle);

    // 5. Render links: the colour is the relation a link is shown as, the line its kind (solid
    // when sourced, dashed when not), and a label names the relation. Widths and dashes are
    // kept on screen whatever the zoom (non-scaling stroke).
    const restingOpacity = (d: CustomLink) => LINK_OPACITY[d.shown.kind];
    const link = g
      .append('g')
      .attr('class', 'links')
      .attr('aria-hidden', 'true')
      .selectAll('line')
      .data(simulationLinks)
      .join('line')
      .attr('data-link-index', (d) => d.n)
      .attr('data-link-kind', (d) => d.shown.kind)
      .attr('data-link-type', (d) => d.shown.type)
      .attr('stroke', (d) => LINK_COLOR[d.shown.type])
      .attr('stroke-opacity', restingOpacity)
      .attr('stroke-width', (d) => linkWidth(d.shown.value, d.shown.kind))
      .attr('stroke-dasharray', (d) => LINK_DASH[d.shown.kind])
      .attr('vector-effect', 'non-scaling-stroke');

    // Decorative for screen readers: the summary and the focused item say the same in words.
    const linkLabel = g
      .append('g')
      .attr('class', 'link-labels')
      .attr('aria-hidden', 'true')
      .style('pointer-events', 'none')
      .selectAll('text')
      .data(simulationLinks)
      .join('text')
      .text((d) => lineLabel(d.shown))
      .attr('text-anchor', 'middle')
      .attr('dy', lineLabelDy(false))
      .attr('fill', (d) => LINK_COLOR[d.shown.type])
      .attr('font-family', 'IBM Plex Mono')
      .attr('font-size', `${LINE_LABEL_PX}px`)
      .style('paint-order', 'stroke')
      .style('stroke', colors.void)
      .style('stroke-width', '3px');

    // A wider, invisible line over each link: pointing at it or focusing it shows the link's
    // relation and where it comes from; focused, it shows a band of its own as a focus ring.
    const linkTarget = g
      .append('g')
      .attr('class', 'link-targets')
      .selectAll('line')
      .data(simulationLinks)
      .join('line')
      .attr('data-link-index', (d) => d.n)
      .attr('stroke', colors.cyber)
      .attr('stroke-opacity', 0)
      .attr('stroke-width', 12)
      .attr('vector-effect', 'non-scaling-stroke')
      .style('pointer-events', 'stroke')
      .style('outline', 'none')
      .attr('tabindex', -1)
      .attr('aria-label', (d) => describeLink(d.shown, nameOf));

    // 6. Render Nodes
    const node = g
      .append('g')
      .attr('class', 'nodes')
      .selectAll<SVGGElement, CustomNode>('g')
      .data(nodes)
      .join('g')
      .attr('cursor', 'pointer')
      .attr('data-node-id', (d) => d.id)
      .attr('tabindex', -1)
      .attr('role', (d) => (d.group === 1 ? 'img' : 'button'))
      .attr('aria-label', (d) => nodeAriaLabel(d))
      .style('outline', 'none')
      .call(dragBehavior(simulation));

    function nodeAriaLabel(d: CustomNode): string {
      const name = nameOf(d.id);
      if (d.group === 1) return `${name}, the analyzed track`;
      const relation = relations.get(d.id);
      const link = relation?.link;
      const said = link
        ? `${relationSentence(link, nameOf)}. ${provenanceText(link)}.`
        : 'No direct link to the analyzed track.';
      return `${name}: ${said} Press Enter to analyze it.`;
    }

    // Node - Outer Glow Ring (The Halo)
    node
      .append('circle')
      .attr('r', (d) => d.size + 4)
      .attr('fill', 'transparent')
      .attr('stroke', (d) => {
        if (d.group === 1) return genealogyColors.current;
        if (isOrigin(d)) return genealogyColors.origin;
        return colors.white;
      })
      .attr('stroke-width', 2)
      // 2 px on screen whatever the zoom: zoomed out, a thinner ring fades into the page
      .attr('vector-effect', 'non-scaling-stroke')
      // A related track's ring is its outline (3:1 or more on the graph): its picture may be the
      // dark placeholder
      .attr('stroke-opacity', (d) => (d.group === 1 || isOrigin(d) ? 0.8 : 0.5))
      .style('filter', (d) => {
        if (d.group === 1) return 'url(#glow-cyan)';
        if (isOrigin(d)) return 'url(#glow-amber)';
        return 'none';
      });

    // Node - focus ring, shown while keyboard focus is on the track
    node
      .append('circle')
      .attr('class', 'focus-ring')
      .attr('r', (d) => d.size + 9)
      .attr('fill', 'none')
      .attr('stroke', colors.cyber)
      .attr('stroke-width', 2)
      .attr('stroke-dasharray', '4 3')
      .attr('opacity', 0)
      .style('pointer-events', 'none');

    // Node - Image Container
    // We use a pattern definition or clipPath. ClipPath is easier for dynamic images per node.
    node.each(function (d, i) {
      const group = select(this);
      const uniqueId = `${clipPrefix}-clip-${i}`;

      group.append('clipPath').attr('id', uniqueId).append('circle').attr('r', d.size);

      // Use provided image if valid, otherwise generate SVG placeholder
      const imageUrl = isValidImageUrl(d.img) ? d.img! : placeholderImage(d.size);

      group
        .append('image')
        .attr('href', imageUrl)
        .attr('x', -d.size)
        .attr('y', -d.size)
        .attr('width', d.size * 2)
        .attr('height', d.size * 2)
        .attr('clip-path', `url(#${uniqueId})`)
        .attr('opacity', 0.9);
    });

    // Node - Labels (responsive sizing)
    const labelFontSize = NODE_LABEL_PX;
    /** How far below its track's centre a name's first line sits (graph units). */
    const nameOffset = (d: CustomNode) => d.size + (isMobile ? 8 : 15);
    const nameText = (d: CustomNode) => {
      // More aggressive truncation on mobile
      const maxLen = isMobile ? 12 : 30;
      return d.label.length > maxLen ? `${d.label.slice(0, maxLen)}…` : d.label;
    };
    // "Origin" only for a track a sourced link says this one uses, never from the group;
    // "Connected" only for a track a drawn link joins to another, and no tag for one with none.
    const tagText = (d: CustomNode) =>
      d.group === 1 ? 'This track' : isOrigin(d) ? 'Origin' : linked.has(d.id) ? 'Connected' : '';

    // Only show labels on non-mobile or for important nodes
    const labels = node
      .append('g')
      .attr('class', 'node-label')
      .attr('transform', (d) => `translate(0, ${nameOffset(d)})`)
      .style('pointer-events', 'none')
      .style('opacity', (d) => (isMobile && d.group !== 1 && !isOrigin(d) ? 0.7 : 1)); // Dim non-essential labels on mobile

    labels
      .append('text')
      .text(nameText)
      .attr('text-anchor', 'middle')
      .attr('fill', colors.white)
      .attr('font-family', 'IBM Plex Mono')
      .attr('font-size', `${labelFontSize}px`)
      .attr('letter-spacing', '0px')
      .attr('class', 'text-shadow-dark');

    // Hide sub-labels on mobile for cleaner look
    if (!isMobile) {
      labels
        .append('text')
        .attr('class', 'sub-label')
        .text(tagText)
        .attr('dy', '1.2em')
        .attr('text-anchor', 'middle')
        .attr('fill', (d) =>
          d.group === 1
            ? genealogyColors.current
            : isOrigin(d)
              ? genealogyColors.origin
              : colors.gray[400],
        )
        .attr('font-family', 'IBM Plex Mono')
        .attr('font-size', `${SUB_LABEL_PX}px`);
    }

    // A track's own drawing is decorative for screen readers: its name says it all.
    node.selectChildren().attr('aria-hidden', 'true');

    // Line labels are drawn above the tracks: one may sit over a name or a disc (see fitText),
    // and its band of the page's colour keeps it readable there.
    g.select('g.link-labels').raise();

    /**
     * Which name is shown whatever it overlaps: the track the pointer or the keyboard is on.
     * Every name stays in the track's aria-label, the detail box and the list of links.
     */
    let pinnedName: string | null = null;
    /**
     * Which label goes first when two would overlap: the pointed or focused track's name, this
     * track's name, the names of tracks a sourced link relates to it, the labels of sourced lines
     * (the relation in words), the other names, the other lines; within each, the stronger link
     * first (`rank`).
     */
    const namePriority = (d: CustomNode) => {
      if (d.id === pinnedName) return Number.POSITIVE_INFINITY;
      if (d.group === 1) return 4000;
      const link = relations.get(d.id)?.link ?? null;
      if (link === null) return 1000;
      return (link.kind === 'sourced' ? 3000 : 1000) + rank(link);
    };
    const linePriority = (link: ShownLink) => (link.kind === 'sourced' ? 2000 : 0) + rank(link);
    /** Where a line's label is drawn: at its place along the line (graph units). */
    const labelX = (d: CustomLink) => {
      const [from, to] = [endOf(d.source), endOf(d.target)];
      return from.x + (to.x - from.x) * (d.labelPlace?.at ?? 0.5);
    };
    const labelY = (d: CustomLink) => {
      const [from, to] = [endOf(d.source), endOf(d.target)];
      return from.y + (to.y - from.y) * (d.labelPlace?.at ?? 0.5);
    };

    /**
     * Keeps text the same size on screen at any zoom, and places the labels in the order
     * namePriority and linePriority give: no name over another name, no line label over another
     * line label or over this track's (or the pointed track's) name. A line label moves along its
     * line to find room, and sits over a disc or another name only when no clear place is left.
     */
    function fitText() {
      const k = transform.k || 1;
      linkLabel.attr('font-size', `${LINE_LABEL_PX / k}px`);
      labels.selectAll<SVGTextElement, unknown>('text').attr('font-size', function () {
        const base = this.classList.contains('sub-label') ? SUB_LABEL_PX : labelFontSize;
        return `${base / k}px`;
      });
      g.selectAll('.preview-indicator').attr('font-size', `${GRAPH_TEXT_PX / k}px`);
      // Boxes on screen. A line's first baseline is at its y, the box from 0.95 em above it to
      // 0.35 em below (labelHeight); a name's tag is a second line, 1.2 em lower.
      const names = nodes.map((d) => {
        const tag = isMobile ? null : tagText(d);
        const height = labelHeight(NODE_LABEL_PX) + (tag ? 1.2 * SUB_LABEL_PX : 0);
        const top = ((d.y ?? 0) + nameOffset(d)) * k - 0.95 * NODE_LABEL_PX;
        const box = {
          x: (d.x ?? 0) * k,
          y: top + height / 2,
          width: Math.max(
            labelWidth(nameText(d), NODE_LABEL_PX),
            tag ? labelWidth(tag, SUB_LABEL_PX) : 0,
          ),
          height,
        };
        return {
          candidates: [box],
          priority: namePriority(d),
          kind: 'name',
          // Nothing sits over this track's name or the pointed one
          coverable: d.group !== 1 && d.id !== pinnedName,
        };
      });
      // A line's label may sit along its line, above or below it (LINE_LABEL_PLACES), clear of
      // the other labels and the tracks' discs where it can be.
      const lines = simulationLinks.map((d) => {
        const [from, to] = [endOf(d.source), endOf(d.target)];
        return {
          candidates: LINE_LABEL_PLACES.map(({ at, below }) => ({
            x: (from.x + (to.x - from.x) * at) * k,
            // The box's centre: 0.7 em above the line for a baseline 0.4 em above it, 0.775 em
            // below for a baseline 1.1 em below
            y: (from.y + (to.y - from.y) * at) * k + (below ? 0.775 : -0.7) * LINE_LABEL_PX,
            width: labelWidth(lineLabel(d.shown), LINE_LABEL_PX),
            height: labelHeight(LINE_LABEL_PX),
          })),
          priority: linePriority(d.shown),
          kind: 'line',
          // Drawn above the names, on a band of the page's colour: still readable over one
          mayCover: ['name'],
        };
      });
      const discs = nodes.map((d) => {
        const side = 2 * (d.size + 4) * k;
        return { x: (d.x ?? 0) * k, y: (d.y ?? 0) * k, width: side, height: side };
      });
      const placed = placeLabels([...names, ...lines], discs).at;
      const shownNames = new Set(nodes.filter((_, i) => placed[i] !== -1).map((d) => d.id));
      labels.attr('visibility', (d) => (shownNames.has(d.id) ? null : 'hidden'));
      for (const d of simulationLinks) {
        const at = placed[nodes.length + d.n];
        d.labelPlace = at === -1 ? undefined : LINE_LABEL_PLACES[at];
      }
      linkLabel
        .attr('visibility', (d) => (d.labelPlace ? null : 'hidden'))
        .attr('x', labelX)
        .attr('y', labelY)
        .attr('dy', (d) => lineLabelDy(d.labelPlace?.below ?? false));
    }
    fitText();

    // 7. Interactions (Highlighting & Neighbor detection)

    // What the pointer and keyboard focus are on (the detail box is React's; this draws it).
    let pointerOn: Item | null = null;
    let focusOn: Item | null = null;
    const drawActive = () => {
      const active = pointerOn ?? focusOn;
      const name = active?.kind === 'node' ? active.id : null;
      if (name !== pinnedName) {
        pinnedName = name;
        fitText();
      }
      const activeLink = active?.kind === 'link' ? active.index : null;
      link
        .attr('stroke-opacity', (d) =>
          activeLink === null ? restingOpacity(d) : d.n === activeLink ? 1 : 0.15,
        )
        .attr(
          'stroke-width',
          (d) => linkWidth(d.shown.value, d.shown.kind) * (d.n === activeLink ? 1.8 : 1),
        );
      // The focus ring: a band along a focused link, a dashed ring round a focused track.
      linkTarget.attr('stroke-opacity', (d) =>
        focusOn?.kind === 'link' && focusOn.index === d.n ? 0.3 : 0,
      );
      node
        .select('.focus-ring')
        .attr('opacity', (d) => (focusOn?.kind === 'node' && focusOn.id === d.id ? 1 : 0));
    };
    const pointAt = (item: Item | null) => {
      pointerOn = item;
      drawActive();
      setHovered(item);
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
        if (d) analyse(d);
      }
    });

    linkTarget
      .on('mouseenter', (_event, d) => pointAt({ kind: 'link', index: d.n }))
      .on('mouseleave', () => pointAt(null));

    // Helper to find connected nodes
    const linkedByIndex: Record<string, boolean> = {};
    simulationLinks.forEach((d) => {
      // D3 replaces string IDs with Node objects after simulation starts
      const sourceId = (d.source as CustomNode).id || d.source;
      const targetId = (d.target as CustomNode).id || d.target;
      linkedByIndex[`${sourceId},${targetId}`] = true;
      linkedByIndex[`${targetId},${sourceId}`] = true;
    });

    function isConnected(a: CustomNode, b: CustomNode) {
      return linkedByIndex[`${a.id},${b.id}`] || a.id === b.id;
    }

    /** Analyses a track (never the current one). */
    function analyse(d: CustomNode) {
      // Don't re-analyze the current song (group 1)
      if (d.group === 1) return;

      // Stop any playing preview
      stopPreview();

      // Trigger navigation callback
      const onNodeClick = onNodeClickRef.current;
      if (onNodeClick) {
        onNodeClick({
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
      }
    }

    node
      .on('mouseenter', function (_event, d) {
        pointAt({ kind: 'node', id: d.id });
        // Dim everything
        node.style('opacity', 0.1);
        link.style('stroke-opacity', 0.05);
        linkLabel.style('opacity', 0.1);

        // Highlight connected
        const connectedNodes = node.filter((n) => isConnected(d, n));
        connectedNodes.style('opacity', 1);

        // Highlight links
        link
          .filter(
            (l) => (l.source as CustomNode).id === d.id || (l.target as CustomNode).id === d.id,
          )
          .style('stroke-opacity', 0.8)
          .style('stroke', colors.white);
        linkLabel
          .filter(
            (l) => (l.source as CustomNode).id === d.id || (l.target as CustomNode).id === d.id,
          )
          .style('opacity', 1);

        // An origin says a click analyses the track, whether or not it has a
        // clip. No hint names a preview: previews play from their own buttons (PreviewList).
        if (isOrigin(d)) {
          select(this)
            .append('text')
            .attr('class', 'preview-indicator')
            .attr('aria-hidden', 'true')
            .attr('y', -d.size - 10)
            .attr('text-anchor', 'middle')
            .attr('font-family', 'IBM Plex Mono')
            .attr('font-size', `${GRAPH_TEXT_PX / (transform.k || 1)}px`)
            .attr('fill', colors.gray[400])
            .text('Analyze this track')
            .call(fadeIn);
        }
      })
      .on('mouseleave', () => {
        pointAt(null);
        node.style('opacity', 1);
        // Back to each link's own colour and opacity (its attributes).
        link.style('stroke', null).style('stroke-opacity', null);
        linkLabel.style('opacity', null);
        svg.selectAll('.preview-indicator').interrupt().remove();
      })
      // Click to navigate (infinite exploration)
      .on('click', (event, d) => {
        event.stopPropagation();
        analyse(d);
      });

    // 8. Tick Function
    function draw() {
      for (const line of [link, linkTarget]) {
        line
          .attr('x1', (d) => endOf(d.source).x)
          .attr('y1', (d) => endOf(d.source).y)
          .attr('x2', (d) => endOf(d.target).x)
          .attr('y2', (d) => endOf(d.target).y);
      }
      linkLabel.attr('x', labelX).attr('y', labelY);

      node.attr('transform', (d) => `translate(${d.x},${d.y})`);
    }
    simulation.on('tick', draw);

    // 9. Drag Logic
    type DragEvent = D3DragEvent<SVGGElement, CustomNode, CustomNode>;
    function dragBehavior(simulation: Simulation<CustomNode, CustomLink>) {
      // Under reduced motion a drag moves the dragged track alone, under the pointer: the
      // others stay where they are instead of drifting into a new layout.
      function dragstarted(event: DragEvent) {
        if (reducedMotion) return;
        if (!event.active) simulation.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      }

      function dragged(event: DragEvent) {
        if (reducedMotion) {
          event.subject.x = event.x;
          event.subject.y = event.y;
          draw();
          return;
        }
        event.subject.fx = event.x;
        event.subject.fy = event.y;
      }

      function dragended(event: DragEvent) {
        // The labels are placed again for where the track was left, as the layout's end does.
        if (reducedMotion) {
          fitText();
          return;
        }
        if (!event.active) simulation.alphaTarget(0);
        event.subject.fx = null;
        event.subject.fy = null;
      }

      return drag<SVGGElement, CustomNode, CustomNode>()
        .on('start', dragstarted)
        .on('drag', dragged)
        .on('end', dragended);
    }

    // The settled layout, computed in one go: the ticks the simulation would have played.
    if (reducedMotion) {
      simulation.tick(ticksToSettle(1));
      draw();
      settle();
    }

    // A resize keeps the drawing, its tracks' size and their places, and the zoom's scale: the
    // svg takes the new size, and the view moves by half the change, so what was at the middle
    // of the panel is at its middle again. Nothing moves in the layout, and nothing glides. While
    // the first fit is still gliding in, the graph is fitted to the new size instead.
    resizeRef.current = (next) => {
      const [dx, dy] = [(next.width - width) / 2, (next.height - height) / 2];
      ({ width, height } = next);
      svg.attr('width', width).attr('height', height);
      if (glide) {
        fitView();
        return;
      }
      // translateBy moves by graph units: the screen's dx is dx / k of them.
      const k = transform.k || 1;
      svg.call(zoomBehavior.translateBy, dx / k, dy / k);
    };

    // Everything the drawing started stops with it: the layout, transitions (the fit's glide,
    // the hints' fade) and their timers, and every listener on the svg and its elements.
    return () => {
      resizeRef.current = null;
      simulation.on('tick', null).on('end', null).stop();
      svg.interrupt();
      svg.selectAll('*').interrupt();
      svg.on('.zoom', null).on('keydown', null);
      node.on('.drag', null).on('mouseenter', null).on('mouseleave', null).on('click', null);
      linkTarget.on('mouseenter', null).on('mouseleave', null);
      for (const { element, type, listener } of listening) {
        element.removeEventListener(type, listener);
      }
      setHovered(null);
      setFocused(null);
    };
  }, [data, links, nameOf, currentId, sized, clipPrefix, stopPreview, reducedMotion]);

  const nodeList = graphNodes(data);
  const related = nodeList.filter((node) => node.group !== 1);
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
  const previewTracks = nodeList.flatMap((node) =>
    node.group !== 1 && typeof node.previewUrl === 'string' && node.previewUrl
      ? [{ id: node.id, url: node.previewUrl }]
      : [],
  );

  return (
    <div className="relative w-full h-full flex flex-col">
      <div
        ref={wrapperRef}
        className="relative flex-1 min-h-0 overflow-hidden cursor-move bg-radial-[circle_at_center] from-surface from-0% to-transparent to-70%"
      >
        <svg
          ref={svgRef}
          className="w-full h-full overflow-visible"
          aria-label="Connections graph"
        ></svg>

        {/* P2:22 — Accessible summary for screen readers: each track's relation comes from the
            link that joins it to this one, never from its group. */}
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
          {links.length > 0 &&
            ' In the graph, the arrow keys move between the tracks and the links; Enter analyzes the focused track.'}
        </div>

        {/* What the pointer or keyboard focus is on: a link's relation and where it comes from,
            or a track's relation to this one */}
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

        {/* Audio Preview Indicator */}
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

        {/* Enhanced Instructions Overlay - Hidden on mobile for cleaner UX */}
        {!active && (
          <div className="absolute bottom-4 left-4 pointer-events-none hidden md:block">
            <div className="flex flex-col gap-1 text-chrome font-mono text-text-tertiary">
              <span>
                {wheelZoom === 'modifier' ? 'Ctrl or ⌘ + scroll to zoom' : 'Scroll to zoom'}
              </span>
              <span>Drag to pan</span>
              <span className="flex items-center gap-1">
                <MousePointerClick size={12} />
                Click a track to analyze it
              </span>
            </div>
          </div>
        )}

        {/* Phones: a short hint in the bottom-right corner, clear of the panel's heading and
            label along the top (a track's detail box covers it while shown) */}
        <div className="absolute bottom-2 right-2 pointer-events-none md:hidden">
          <div className="text-chrome font-mono text-text-tertiary">Pinch, drag or tap</div>
        </div>
      </div>

      {/* What the lines mean, in words, and the links as a list (which opens over the graph) */}
      {(links.length > 0 || hidden > 0 || previewTracks.length > 0) && (
        // Opaque and above the graph: nodes the graph draws past its edge do not cover it.
        <div className="relative z-10 shrink-0 flex flex-col gap-2 border-t border-white/5 px-4 pt-3 pb-4 md:pb-14 bg-void">
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
