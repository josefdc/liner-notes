import React, { useEffect, useRef, useState } from 'react';
import { select, selectAll } from 'd3-selection';
import { zoom, zoomIdentity } from 'd3-zoom';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from 'd3-force';
import type { Simulation } from 'd3-force';
import { drag } from 'd3-drag';
import 'd3-transition'; // Side-effect import: augments Selection with .transition()
import { Volume2, VolumeX, MousePointerClick } from 'lucide-react';
import { colors, genealogyColors, linkColors } from '../styles/theme';
import type { GenealogyGraphProps, CustomNode, CustomLink } from './genealogy/types';
import { useAudioPreview } from './genealogy/useAudioPreview';
import { isValidImageUrl } from '../utils/image';
import type { TrackData } from '../types';

/**
 * The part of a genealogy that can be drawn: links whose source and target are both in the
 * node list. d3-force throws on a link to an unknown node id, which would take the whole page
 * down, so such links are left out.
 */
export function drawableLinks(
  data: Partial<TrackData['genealogy']> | null | undefined,
): TrackData['genealogy']['links'] {
  const ids = new Set(graphNodes(data).map((node) => node.id));
  const links = Array.isArray(data?.links) ? data.links : [];
  return links.filter((link) => ids.has(link.source) && ids.has(link.target));
}

/** The genealogy's nodes, or none when the list is missing. */
function graphNodes(
  data: Partial<TrackData['genealogy']> | null | undefined,
): TrackData['genealogy']['nodes'] {
  return Array.isArray(data?.nodes) ? data.nodes : [];
}

/**
 * Generate SVG placeholder pattern for nodes without images
 */
function generateSvgPlaceholder(label: string, group: number, size: number): string {
  // Generate deterministic hash from label
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    const char = label.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }

  const hue = Math.abs(hash) % 360;

  // Different color schemes based on group
  const groupHueOffset: Record<number, number> = {
    1: 180, // Current: cyan
    2: 30, // Sampled: amber
    3: 270, // Sampler: purple
    4: 120, // Influence: green
  };

  const offset = groupHueOffset[group] || 0;
  const finalHue = (hue + offset) % 360;

  const color1 = `hsl(${finalHue}, 60%, 40%)`;
  const color2 = `hsl(${(finalHue + 30) % 360}, 50%, 30%)`;

  // Create SVG data URL with gradient and music icon
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size * 2}" height="${size * 2}" viewBox="0 0 100 100">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:${color1}"/>
          <stop offset="100%" style="stop-color:${color2}"/>
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="50" fill="url(#grad)"/>
      <path d="M40 30v30c-2.5-2-6-3-10-3-5.5 0-10 3.5-10 8s4.5 8 10 8 10-3.5 10-8V38l20-5v22c-2.5-2-6-3-10-3-5.5 0-10 3.5-10 8s4.5 8 10 8 10-3.5 10-8V25L40 30z"
            fill="rgba(255,255,255,0.3)"/>
    </svg>
  `.trim();

  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const GenealogyGraph: React.FC<GenealogyGraphProps> = ({ data, onNodeClick }) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Audio preview (extracted hook)
  const { isPlaying, playingNodeId, hasPreviewSupport, playPreview, stopPreview } =
    useAudioPreview();

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

  useEffect(() => {
    if (!svgRef.current || !wrapperRef.current || dimensions.width === 0 || dimensions.height === 0)
      return;

    // 1. Setup & Cleanup
    const svg = select(svgRef.current);
    svg.selectAll('*').remove();

    // Use dimensions from ResizeObserver state
    const { width, height } = dimensions;

    // Responsive scaling: detect if mobile (narrow viewport)
    const isMobile = width < 500;
    const nodeScale = isMobile ? 0.6 : 1;
    const linkDistance = isMobile ? 80 : 120;
    const chargeStrength = isMobile ? -300 : -400;

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

    // 3. Zoom Behavior
    const g = svg.append('g');
    const zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
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
    const links: CustomLink[] = JSON.parse(JSON.stringify(drawableLinks(data)));

    // Create simulation centered at viewport center
    const simulation = forceSimulation(nodes)
      .force(
        'link',
        forceLink(links)
          .id((d: any) => d.id)
          .distance(linkDistance),
      )
      .force('charge', forceManyBody().strength(chargeStrength))
      .force('center', forceCenter(width / 2, height / 2)) // Center the whole graph
      .force(
        'collide',
        forceCollide().radius((d: any) => d.size + (isMobile ? 8 : 15)),
      );

    // Auto-fit after simulation stabilizes
    simulation.on('end', () => {
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
      const scale = Math.min(scaleX, scaleY, 1.5); // Cap max zoom

      // Apply transform to center and fit
      const translateX = width / 2 - graphCenterX * scale;
      const translateY = height / 2 - graphCenterY * scale;

      svg
        .transition()
        .duration(500)
        .call(zoomBehavior.transform, zoomIdentity.translate(translateX, translateY).scale(scale));
    });

    // 5. Render Links with semantic styling
    const link = g
      .append('g')
      .attr('class', 'links')
      .selectAll('line')
      .data(links)
      .join('line')
      .attr('stroke', (d) => {
        // Visual semantics based on relationship type using theme colors
        return linkColors[d.type as keyof typeof linkColors] || linkColors.default;
      })
      .attr('stroke-opacity', (d) => (d.type === 'sample' ? 0.6 : 0.3))
      .attr('stroke-width', (d) => Math.sqrt(d.value) * (d.type === 'sample' ? 1.5 : 1))
      // Dashed line for influences
      .attr('stroke-dasharray', (d) => (d.type === 'influence' ? '5,5' : 'none'));

    // 6. Render Nodes
    const node = g
      .append('g')
      .attr('class', 'nodes')
      .selectAll('g')
      .data(nodes)
      .join('g')
      .attr('cursor', 'pointer')
      .call(dragBehavior(simulation) as any);

    // Node - Outer Glow Ring (The Halo)
    node
      .append('circle')
      .attr('r', (d) => d.size + 4)
      .attr('fill', 'transparent')
      .attr('stroke', (d) => {
        if (d.group === 1) return genealogyColors.current;
        if (d.group === 2) return genealogyColors.origin;
        return '#ffffff';
      })
      .attr('stroke-width', 2)
      .attr('stroke-opacity', (d) => (d.group === 1 || d.group === 2 ? 0.8 : 0.2))
      .style('filter', (d) => {
        if (d.group === 1) return 'url(#glow-cyan)';
        if (d.group === 2) return 'url(#glow-amber)';
        return 'none';
      });

    // Node - Image Container
    // We use a pattern definition or clipPath. ClipPath is easier for dynamic images per node.
    node.each(function (d) {
      const group = select(this);
      const uniqueId = `clip-${d.id}`;

      group.append('clipPath').attr('id', uniqueId).append('circle').attr('r', d.size);

      // Use provided image if valid, otherwise generate SVG placeholder
      const imageUrl = isValidImageUrl(d.img)
        ? d.img!
        : generateSvgPlaceholder(d.label, d.group, d.size);

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
    const labelFontSize = isMobile ? '7px' : '10px';
    const subLabelFontSize = isMobile ? '5px' : '8px';

    // Only show labels on non-mobile or for important nodes
    const labels = node
      .append('g')
      .attr('transform', (d) => `translate(0, ${d.size + (isMobile ? 8 : 15)})`)
      .style('pointer-events', 'none')
      .style('opacity', (d) => (isMobile && d.group > 2 ? 0.7 : 1)); // Dim non-essential labels on mobile

    labels
      .append('text')
      .text((d) => {
        // More aggressive truncation on mobile
        const maxLen = isMobile ? 12 : 30;
        return d.label.length > maxLen ? `${d.label.slice(0, maxLen)}…` : d.label;
      })
      .attr('text-anchor', 'middle')
      .attr('fill', '#fff')
      .attr('font-family', 'IBM Plex Mono')
      .attr('font-size', labelFontSize)
      .attr('letter-spacing', '0px')
      .style('text-shadow', '0 1px 3px rgba(0,0,0,0.9), 0 0 8px rgba(0,0,0,0.8)');

    // Hide sub-labels on mobile for cleaner look
    if (!isMobile) {
      labels
        .append('text')
        .text((d) => (d.group === 1 ? '[CURRENT]' : d.group === 2 ? '[ORIGIN]' : '[LINK]'))
        .attr('dy', '1.2em')
        .attr('text-anchor', 'middle')
        .attr('fill', (d) =>
          d.group === 1
            ? genealogyColors.current
            : d.group === 2
              ? genealogyColors.origin
              : colors.gray[500],
        )
        .attr('font-family', 'IBM Plex Mono')
        .attr('font-size', subLabelFontSize);
    }

    // 7. Interactions (Highlighting & Neighbor detection)

    // Helper to find connected nodes
    const linkedByIndex: Record<string, boolean> = {};
    links.forEach((d) => {
      // D3 replaces string IDs with Node objects after simulation starts
      const sourceId = (d.source as CustomNode).id || d.source;
      const targetId = (d.target as CustomNode).id || d.target;
      linkedByIndex[`${sourceId},${targetId}`] = true;
      linkedByIndex[`${targetId},${sourceId}`] = true;
    });

    function isConnected(a: CustomNode, b: CustomNode) {
      return linkedByIndex[`${a.id},${b.id}`] || a.id === b.id;
    }

    node
      .on('mouseenter', function (_event, d) {
        // Dim everything
        node.style('opacity', 0.1);
        link.style('stroke-opacity', 0.05);

        // Highlight connected
        const connectedNodes = node.filter((n) => isConnected(d, n));
        connectedNodes.style('opacity', 1);

        // Highlight links
        link
          .filter(
            (l) => (l.source as CustomNode).id === d.id || (l.target as CustomNode).id === d.id,
          )
          .style('stroke-opacity', 0.8)
          .style('stroke', '#fff');

        // Audio Preview: Play if node has previewUrl (and not the current song)
        if (d.previewUrl && d.group !== 1) {
          playPreview(d.previewUrl, d.id);

          // Add audio indicator
          select(this)
            .append('text')
            .attr('class', 'preview-indicator')
            .attr('y', -d.size - 10)
            .attr('text-anchor', 'middle')
            .attr('font-family', 'IBM Plex Mono')
            .attr('font-size', '9px')
            .attr('fill', colors.cyber)
            .text('♪ SAMPLING...')
            .style('opacity', 0)
            .transition()
            .duration(300)
            .style('opacity', 1);
        } else if (d.group === 2) {
          // Fallback visual for origin nodes without preview
          select(this)
            .append('text')
            .attr('class', 'preview-indicator')
            .attr('y', -d.size - 10)
            .attr('text-anchor', 'middle')
            .attr('font-family', 'IBM Plex Mono')
            .attr('font-size', '9px')
            .attr('fill', colors.analog)
            .text(d.previewUrl ? '♪ SAMPLING...' : '⚡ CLICK TO EXPLORE')
            .style('opacity', 0)
            .transition()
            .duration(300)
            .style('opacity', 1);
        }
      })
      .on('mouseleave', () => {
        node.style('opacity', 1);
        link
          .style('stroke', (d: any) => {
            return linkColors[d.type as keyof typeof linkColors] || linkColors.default;
          })
          .style('stroke-opacity', (d: any) => (d.type === 'sample' ? 0.6 : 0.3));
        selectAll('.preview-indicator').remove();

        // Stop audio preview
        stopPreview();
      })
      // Click to navigate (infinite exploration)
      .on('click', (event, d) => {
        event.stopPropagation();

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
      });

    // 8. Tick Function
    simulation.on('tick', () => {
      link
        .attr('x1', (d: any) => d.source.x)
        .attr('y1', (d: any) => d.source.y)
        .attr('x2', (d: any) => d.target.x)
        .attr('y2', (d: any) => d.target.y);

      node.attr('transform', (d) => `translate(${d.x},${d.y})`);
    });

    // 9. Drag Logic
    function dragBehavior(simulation: Simulation<CustomNode, undefined>) {
      function dragstarted(event: any) {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        event.subject.fx = event.subject.x;
        event.subject.fy = event.subject.y;
      }

      function dragged(event: any) {
        event.subject.fx = event.x;
        event.subject.fy = event.y;
      }

      function dragended(event: any) {
        if (!event.active) simulation.alphaTarget(0);
        event.subject.fx = null;
        event.subject.fy = null;
      }

      return drag().on('start', dragstarted).on('drag', dragged).on('end', dragended);
    }

    return () => {
      simulation.stop();
    };
  }, [data, onNodeClick, dimensions, playPreview, stopPreview]); // Add dimensions to dependency array for responsive redraw

  return (
    <div
      ref={wrapperRef}
      className="w-full h-full relative cursor-move bg-[radial-gradient(circle_at_center,_rgba(20,20,30,0.5)_0%,_transparent_70%)]"
    >
      <svg
        ref={svgRef}
        className="w-full h-full overflow-visible"
        role="img"
        aria-label="Song genealogy network graph"
      ></svg>

      {/* P2:22 — Accessible summary for screen readers */}
      <div className="sr-only">
        Genealogy network
        {graphNodes(data).length > 0 ? ` with ${graphNodes(data).length} related tracks` : ''}.
        {graphNodes(data)
          .map((node) => {
            const relationship =
              node.group === 1
                ? 'Current song'
                : node.group === 2
                  ? 'Sampled by this track'
                  : node.group === 3
                    ? 'Samples this track'
                    : 'Related influence';
            return ` ${node.label} (${relationship}).`;
          })
          .join('')}
      </div>

      {/* Audio Preview Indicator */}
      {isPlaying && playingNodeId && (
        <div className="absolute top-4 right-4 pointer-events-none">
          <div className="flex items-center gap-2 text-cyber text-xs font-mono bg-black/80 px-3 py-1.5 rounded border border-cyber/30 animate-pulse">
            <Volume2 size={12} className="animate-bounce" />
            <span>PREVIEWING SAMPLE...</span>
          </div>
        </div>
      )}

      {/* No Preview Support Warning (browsers may block autoplay) */}
      {!hasPreviewSupport && (
        <div className="absolute top-4 right-4 pointer-events-none">
          <div className="flex items-center gap-2 text-gray-500 text-xs font-mono bg-black/80 px-3 py-1.5 rounded border border-white/10">
            <VolumeX size={12} />
            <span>AUDIO BLOCKED</span>
          </div>
        </div>
      )}

      {/* Enhanced Instructions Overlay - Hidden on mobile for cleaner UX */}
      <div className="absolute bottom-4 left-4 pointer-events-none opacity-50 hidden md:block">
        <div className="flex flex-col gap-1 text-[9px] font-mono text-gray-500">
          <span>SCROLL TO ZOOM</span>
          <span>DRAG TO PAN</span>
          <span className="text-cyber flex items-center gap-1">
            <MousePointerClick size={8} />
            CLICK NODE TO EXPLORE
          </span>
        </div>
      </div>

      {/* Mobile: Minimal top-right hint that doesn't obstruct graph */}
      <div className="absolute top-2 right-2 pointer-events-none md:hidden">
        <div className="text-[8px] font-mono text-white/40">PINCH • DRAG • TAP</div>
      </div>
    </div>
  );
};

export default React.memo(GenealogyGraph);
