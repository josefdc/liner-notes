import React, { useEffect, useMemo, useRef, useState } from 'react';
import { type Selection, select, selectAll } from 'd3-selection';
import { zoom, zoomIdentity, type ZoomTransform } from 'd3-zoom';
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
import { drag } from 'd3-drag';
import 'd3-transition'; // Side-effect import: augments Selection with .transition()
import { Volume2, VolumeX, MousePointerClick } from 'lucide-react';
import { colors, genealogyColors } from '../styles/theme';
import { placeholderImage } from '../styles/placeholder';
import type { GenealogyGraphProps, CustomNode, CustomLink } from './genealogy/types';
import { useAudioPreview } from './genealogy/useAudioPreview';
import {
  describeLink,
  isDocumentedSource,
  kindLabel,
  LINK_TYPE_LABEL,
  nodeName,
  nodesById,
  provenanceText,
  rank,
  linkContext,
  readGenealogy,
  yearFrom,
  relationSentence,
  relationToTrack,
  type ShownLink,
} from './genealogy/links';
import { labelHeight, labelWidth, placeLabels } from './genealogy/labels';
import { LINK_COLOR, LINK_DASH, LINK_OPACITY, linkWidth } from './genealogy/linkStyle';
import { GRAPH_TEXT_PX, LINE_LABEL_PX, NODE_LABEL_PX, SUB_LABEL_PX } from './genealogy/textSize';
import { LinkLegend } from './genealogy/LinkLegend';
import { LinkList } from './genealogy/LinkList';
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

/** The words on a link's line: its relation, hedged when it is not sourced. */
function lineLabel(link: ShownLink): string {
  if (!link.directionKnown) return 'related';
  const label = LINK_TYPE_LABEL[link.type].toLowerCase();
  return link.kind === 'sourced' ? label : `possible ${label}`;
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

  // Audio preview (extracted hook)
  const {
    isPlaying,
    playingNodeId,
    hasPreviewSupport,
    unavailableNodeId,
    playPreview,
    stopPreview,
  } = useAudioPreview();

  // A clip that could not be loaded takes its hover label with it.
  useEffect(() => {
    if (!unavailableNodeId || !svgRef.current) return;
    select(svgRef.current)
      .selectAll<SVGTextElement, unknown>('.preview-indicator')
      .filter(function () {
        return this.getAttribute('data-node-id') === unavailableNodeId;
      })
      .remove();
  }, [unavailableNodeId]);

  // State for responsive dimensions (ResizeObserver)
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  // ResizeObserver hook: observe wrapper size changes for responsive D3
  useEffect(() => {
    if (!wrapperRef.current) return;

    const resizeObserver = new ResizeObserver((entries) => {
      if (!entries || entries.length === 0) return;
      const { width, height } = entries[0].contentRect;
      // Only update if dimensions actually changed to avoid unnecessary re-renders
      setDimensions((prev) => {
        if (prev.width !== width || prev.height !== height) {
          return { width, height };
        }
        return prev;
      });
    });

    resizeObserver.observe(wrapperRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  // Under reduced motion the layout is worked out before it is drawn, and nothing glides.
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!svgRef.current || !wrapperRef.current || dimensions.width === 0 || dimensions.height === 0)
      return;

    // 1. Setup & Cleanup
    const svg = select(svgRef.current);
    svg.selectAll('*').remove();

    // A hint shown on hover fades in, or appears at once under reduced motion.
    const fadeIn = (hint: Selection<SVGTextElement, unknown, null, undefined>) => {
      if (reducedMotion) hint.style('opacity', 1);
      else hint.style('opacity', 0).transition().duration(300).style('opacity', 1);
    };

    // Use dimensions from ResizeObserver state
    const { width, height } = dimensions;

    // Responsive scaling: detect if mobile (narrow viewport)
    const isMobile = width < 500;
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
      // A double click zooms in a glide, or at once under reduced motion.
      .duration(reducedMotion ? 0 : 250)
      .on('zoom', (event) => {
        transform = event.transform;
        g.attr('transform', event.transform);
        fitText();
      });

    svg.call(zoomBehavior);

    // 4. Force Simulation Setup
    // Use a deep copy to prevent D3 from mutating the original props reference directly if strict
    const nodes: CustomNode[] = JSON.parse(JSON.stringify(graphNodes(data))).map(
      (n: CustomNode) => ({
        ...n,
        size: n.size * nodeScale, // Scale node sizes for mobile
      }),
    );
    // Copies: d3-force replaces each link's source and target with the node objects.
    const simulationLinks: CustomLink[] = links.map((shown, n) => ({
      source: shown.source,
      target: shown.target,
      value: shown.value,
      n,
      shown,
    }));
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
    const simulation = forceSimulation(nodes)
      .force(
        'link',
        forceLink(simulationLinks)
          .id((d: any) => d.id)
          .distance(linkDistance),
      )
      .force('charge', forceManyBody().strength(chargeStrength))
      .force('center', forceCenter(width / 2, height / 2)) // Center the whole graph
      .force(
        'collide',
        forceCollide().radius((d: any) => d.size + (isMobile ? 8 : 15)),
      )
      // A light pull to the middle: a track with no link shown (its only link rejected, or
      // none sent) is not pushed off into the distance, taking the fit with it.
      .force('x', forceX(width / 2).strength(0.04))
      .force('y', forceY(height / 2).strength(0.04));
    // Under reduced motion the layout is not played out frame by frame: it is computed at once
    // once the graph is built (see the end of this effect), and drawn settled.
    if (reducedMotion) simulation.stop();

    // Auto-fit once the layout first settles; a later drag keeps the user's view.
    let fitted = false;
    const settle = () => {
      if (fitted) {
        fitText();
        return;
      }
      fitted = true;
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
      if (reducedMotion) svg.call(zoomBehavior.transform, fit);
      else svg.transition().duration(500).call(zoomBehavior.transform, fit);
    };
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
      .selectAll('g')
      .data(nodes)
      .join('g')
      .attr('cursor', 'pointer')
      .attr('data-node-id', (d) => d.id)
      .attr('tabindex', -1)
      .attr('role', (d) => (d.group === 1 ? 'img' : 'button'))
      .attr('aria-label', (d) => nodeAriaLabel(d))
      .style('outline', 'none')
      .call(dragBehavior(simulation) as any);

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
    node.each(function (d) {
      const group = select(this);
      const uniqueId = `clip-${d.id}`;

      group.append('clipPath').attr('id', uniqueId).append('circle').attr('r', d.size);

      // Use provided image if valid, otherwise generate SVG placeholder
      const imageUrl = isValidImageUrl(d.img) ? d.img! : placeholderImage(d.size);

      group
        .append('image')
        .attr('xlink:href', imageUrl)
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
    // [ORIGIN] only for a track a sourced link says this one uses, never from the group.
    const tagText = (d: CustomNode) =>
      d.group === 1 ? '[CURRENT]' : isOrigin(d) ? '[ORIGIN]' : '[LINK]';

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
    const labelX = (d: any) => d.source.x + (d.target.x - d.source.x) * (d.labelPlace?.at ?? 0.5);
    const labelY = (d: any) => d.source.y + (d.target.y - d.source.y) * (d.labelPlace?.at ?? 0.5);

    /**
     * Keeps text the same size on screen at any zoom, and places the labels in the order
     * namePriority and linePriority give: no name over another name, no line label over another
     * line label or over this track's (or the pointed track's) name. A line label moves along its
     * line to find room, and sits over a disc or another name only when no clear place is left.
     */
    function fitText() {
      const k = transform.k || 1;
      linkLabel.attr('font-size', `${LINE_LABEL_PX / k}px`);
      labels.selectAll('text').attr('font-size', function () {
        const base = (this as Element).classList.contains('sub-label')
          ? SUB_LABEL_PX
          : labelFontSize;
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
      const lines = simulationLinks.map((d: any) => ({
        candidates: LINE_LABEL_PLACES.map(({ at, below }) => ({
          x: ((d.source.x ?? 0) + ((d.target.x ?? 0) - (d.source.x ?? 0)) * at) * k,
          // The box's centre: 0.7 em above the line for a baseline 0.4 em above it, 0.775 em
          // below for a baseline 1.1 em below
          y:
            ((d.source.y ?? 0) + ((d.target.y ?? 0) - (d.source.y ?? 0)) * at) * k +
            (below ? 0.775 : -0.7) * LINE_LABEL_PX,
          width: labelWidth(lineLabel(d.shown), LINE_LABEL_PX),
          height: labelHeight(LINE_LABEL_PX),
        })),
        priority: linePriority(d.shown),
        kind: 'line',
        // Drawn above the names, on a band of the page's colour: still readable over one
        mayCover: ['name'],
      }));
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
    items.forEach(({ item, element }, i) => {
      element.addEventListener('focus', () => {
        setRoving(i);
        focusOn = item;
        drawActive();
        setFocused(item);
      });
      element.addEventListener('blur', () => {
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

        // Audio Preview: Play if node has previewUrl (and not the current song)
        if (d.previewUrl && d.group !== 1) {
          playPreview(d.previewUrl, d.id);

          // Add audio indicator (removed again if the clip cannot be loaded, see below)
          select(this)
            .append('text')
            .attr('class', 'preview-indicator')
            .attr('aria-hidden', 'true')
            .attr('data-node-id', d.id)
            .attr('y', -d.size - 10)
            .attr('text-anchor', 'middle')
            .attr('font-family', 'IBM Plex Mono')
            .attr('font-size', `${GRAPH_TEXT_PX / (transform.k || 1)}px`)
            .attr('fill', colors.cyber)
            // A preview of the node's track, whatever its relation to this one
            .text('♪ PREVIEW')
            .call(fadeIn);
        } else if (isOrigin(d)) {
          // Fallback visual for origin nodes without preview
          select(this)
            .append('text')
            .attr('class', 'preview-indicator')
            .attr('aria-hidden', 'true')
            .attr('y', -d.size - 10)
            .attr('text-anchor', 'middle')
            .attr('font-family', 'IBM Plex Mono')
            .attr('font-size', `${GRAPH_TEXT_PX / (transform.k || 1)}px`)
            .attr('fill', colors.analog)
            .text('⚡ CLICK TO EXPLORE')
            .call(fadeIn);
        }
      })
      .on('mouseleave', () => {
        pointAt(null);
        node.style('opacity', 1);
        // Back to each link's own colour and opacity (its attributes).
        link.style('stroke', null).style('stroke-opacity', null);
        linkLabel.style('opacity', null);
        selectAll('.preview-indicator').remove();

        // Stop audio preview
        stopPreview();
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
          .attr('x1', (d: any) => d.source.x)
          .attr('y1', (d: any) => d.source.y)
          .attr('x2', (d: any) => d.target.x)
          .attr('y2', (d: any) => d.target.y);
      }
      linkLabel.attr('x', labelX).attr('y', labelY);

      node.attr('transform', (d) => `translate(${d.x},${d.y})`);
    }
    simulation.on('tick', draw);

    // 9. Drag Logic
    function dragBehavior(simulation: Simulation<CustomNode, undefined>) {
      // Under reduced motion a drag moves the dragged track alone, under the pointer: the
      // others stay where they are instead of drifting into a new layout.
      function dragstarted(event: any) {
        if (reducedMotion) return;
        if (!event.active) simulation.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      }

      function dragged(event: any) {
        if (reducedMotion) {
          event.subject.x = event.x;
          event.subject.y = event.y;
          draw();
          return;
        }
        event.subject.fx = event.x;
        event.subject.fy = event.y;
      }

      function dragended(event: any) {
        // The labels are placed again for where the track was left, as the layout's end does.
        if (reducedMotion) {
          fitText();
          return;
        }
        if (!event.active) simulation.alphaTarget(0);
        event.subject.fx = null;
        event.subject.fy = null;
      }

      return drag().on('start', dragstarted).on('drag', dragged).on('end', dragended);
    }

    // The settled layout, computed in one go: the ticks the simulation would have played.
    if (reducedMotion) {
      const ticks = Math.ceil(
        Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay()),
      );
      simulation.tick(ticks);
      draw();
      settle();
    }

    return () => {
      simulation.stop();
      setHovered(null);
      setFocused(null);
    };
  }, [
    data,
    links,
    nameOf,
    currentId,
    onNodeClick,
    dimensions,
    playPreview,
    stopPreview,
    reducedMotion,
  ]); // Add dimensions to dependency array for responsive redraw

  const nodeList = graphNodes(data);
  const related = nodeList.filter((node) => node.group !== 1);
  const active = hovered ?? focused;
  const activeLink = active?.kind === 'link' ? (links[active.index] ?? null) : null;
  const activeNode =
    active?.kind === 'node' ? (nodeList.find((node) => node.id === active.id) ?? null) : null;
  const activeRelation = activeNode ? relationToTrack(links, activeNode.id, currentId) : null;
  const keyboardOnNode = focused?.kind === 'node' && sameItem(active, focused);

  return (
    <div className="relative w-full h-full flex flex-col">
      <div
        ref={wrapperRef}
        className="relative flex-1 min-h-0 overflow-hidden cursor-move bg-radial-[circle_at_center] from-surface from-0% to-transparent to-70%"
      >
        <svg
          ref={svgRef}
          className="w-full h-full overflow-visible"
          aria-label="Song genealogy network graph"
        ></svg>

        {/* P2:22 — Accessible summary for screen readers: each track's relation comes from the
            link that joins it to this one, never from its group. */}
        <div className="sr-only">
          Genealogy network
          {related.length > 0
            ? ` with ${related.length} related ${related.length === 1 ? 'track' : 'tracks'}`
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
            <div className="flex items-center gap-2 text-cyber text-xs font-mono bg-black/80 px-3 py-1.5 rounded border border-cyber/30 animate-pulse">
              <Volume2 size={12} className="animate-bounce" />
              <span>PREVIEWING TRACK...</span>
            </div>
          </div>
        )}

        {/* No Preview Support Warning (browsers may block autoplay) */}
        {!hasPreviewSupport && (
          <div className="absolute top-4 right-4 pointer-events-none" role="status">
            <div className="flex items-center gap-2 text-text-secondary text-xs font-mono bg-black/80 px-3 py-1.5 rounded border border-white/10">
              <VolumeX size={12} />
              <span>AUDIO BLOCKED</span>
            </div>
          </div>
        )}

        {/* A node's clip that could not be loaded (preview links expire); hover again to retry */}
        {hasPreviewSupport && unavailableNodeId && (
          <div className="absolute top-4 right-4 pointer-events-none" role="status">
            <div className="flex items-center gap-2 text-text-secondary text-xs font-mono bg-black/80 px-3 py-1.5 rounded border border-white/10">
              <VolumeX size={12} />
              <span>PREVIEW UNAVAILABLE</span>
            </div>
          </div>
        )}

        {/* Enhanced Instructions Overlay - Hidden on mobile for cleaner UX */}
        {!active && (
          <div className="absolute bottom-4 left-4 pointer-events-none hidden md:block">
            <div className="flex flex-col gap-1 text-chrome font-mono text-text-tertiary">
              <span>SCROLL TO ZOOM</span>
              <span>DRAG TO PAN</span>
              <span className="text-cyber flex items-center gap-1">
                <MousePointerClick size={12} />
                CLICK NODE TO EXPLORE
              </span>
            </div>
          </div>
        )}

        {/* Mobile: Minimal top-right hint that doesn't obstruct graph */}
        <div className="absolute top-2 right-2 pointer-events-none md:hidden">
          <div className="text-chrome font-mono text-text-tertiary">PINCH • DRAG • TAP</div>
        </div>
      </div>

      {/* What the lines mean, in words, and the links as a list (which opens over the graph) */}
      {(links.length > 0 || hidden > 0) && (
        // Opaque and above the graph: nodes the graph draws past its edge do not cover it.
        <div className="relative z-10 shrink-0 flex flex-col gap-2 border-t border-white/5 px-4 pt-3 pb-4 md:pb-14 bg-void">
          <LinkLegend types={links.map((link) => link.type)} />
          {hidden > 0 && (
            <p className="text-chrome font-mono text-text-chip" data-testid="links-hidden">
              {hidden === 1
                ? '1 link not shown: the claim behind it was rejected or cannot be read.'
                : `${hidden} links not shown: the claims behind them were rejected or cannot be read.`}
            </p>
          )}
          <LinkList links={links} nameOf={nameOf} />
        </div>
      )}
    </div>
  );
};

export default React.memo(GenealogyGraph);
