import React, { useMemo } from 'react';
import { Info, ChevronRight, MicVocal, Music, Users, Lightbulb, Link2 } from 'lucide-react';
import type { Reading } from '../constants';
import type { Factoid, FactoidEntity } from '../types';
import type { ShownClaim } from './provenance/claims';
import { ProvenanceChip } from './provenance/ProvenanceChip';
import type { MeasuredAudio } from './measured/audio';
import { ClaimChip } from './provenance/ClaimChip';

interface InteractiveFactoidProps {
  factoid: Factoid;
  onEntityClick?: (entity: FactoidEntity) => void;
  /**
   * The claim this card states (its `claimId`), shown with its kind, sources and verifier
   * status. A card without one is labelled by its section instead.
   */
  claim?: ShownClaim;
  /**
   * Where a card without a claim comes from (written by the model, or taken from source data),
   * when the cards beside it carry claims of their own.
   */
  origin?: 'inferred' | 'record';
  /** The result's signal readings, for a claim about a measured value. */
  readings?: readonly Reading[];
  /** The result's measurement, for the measured side of a conflict. */
  audio?: MeasuredAudio | null;
}

// Color mapping for entity types (search chips, not provenance). Violet means model inference
// only (ProvenanceChip), so no entity is violet.
const ENTITY_COLORS: Record<FactoidEntity['type'], string> = {
  synth: 'text-cyber hover:bg-cyber/20 border-cyber/30',
  producer: 'text-analog hover:bg-analog/20 border-analog/30',
  sample: 'text-analog hover:bg-analog/20 border-analog/30',
  technique: 'text-accent-pink hover:bg-accent-pink/20 border-accent-pink/30',
  artist: 'text-accent-green hover:bg-accent-green/20 border-accent-green/30',
  // Neutral: a light blue reads as the inferred violet with red-green colour deficiencies
  album: 'text-text-secondary hover:bg-white/10 border-white/30',
  year: 'text-text-tertiary hover:bg-white/10 border-white/20',
};

// A card's category (production, credits, sample...) is drawn in neutral greys: the colours
// that say how a statement is known (cyan measured, amber sourced, violet inferred) belong to its
// provenance chip alone, and a category says nothing about that.
const CATEGORY_CHROME = 'text-text-secondary';

// Get the icon and label of a factoid type
function getFactoidStyle(type: Factoid['type']): {
  icon: React.ReactNode;
  color: string;
  label: string;
} {
  const color = CATEGORY_CHROME;
  switch (type) {
    case 'production':
      return { icon: <MicVocal size={14} />, color, label: 'PRODUCTION' };
    case 'credits':
      return { icon: <Users size={14} />, color, label: 'CREDITS' };
    case 'sample':
      return { icon: <Music size={14} />, color, label: 'SAMPLE' };
    case 'curiosity':
      return { icon: <Lightbulb size={14} />, color, label: 'CURIOSITY' };
    case 'connection':
      return { icon: <Link2 size={14} />, color, label: 'CONNECTION' };
    default:
      return { icon: <Info size={14} />, color, label: 'TRIVIA' };
  }
}

const InteractiveFactoid: React.FC<InteractiveFactoidProps> = ({
  factoid,
  onEntityClick,
  claim,
  origin,
  readings,
  audio,
}) => {
  // Memoized content with clickable entities highlighted
  const renderedContent = useMemo(() => {
    if (!factoid.entities?.length) {
      return <span>{factoid.content}</span>;
    }

    const content = factoid.content;
    const elements: React.ReactNode[] = [];
    let lastIndex = 0;

    // Sort entities by their position in content to process in order
    const sortedEntities = [...factoid.entities].sort((a, b) => {
      const posA = content.indexOf(a.text);
      const posB = content.indexOf(b.text);
      return posA - posB;
    });

    sortedEntities.forEach((entity) => {
      const entityIndex = content.indexOf(entity.text, lastIndex);
      if (entityIndex === -1) return;

      // Add text before entity
      if (entityIndex > lastIndex) {
        elements.push(
          <span key={`text-before-${entity.id}`}>{content.slice(lastIndex, entityIndex)}</span>,
        );
      }

      // Add clickable entity
      elements.push(
        <button
          type="button"
          key={entity.id}
          onClick={() => onEntityClick?.(entity)}
          className={`
            inline-flex items-center px-1.5 py-0.5 mx-0.5 rounded-sm
            border transition-all cursor-pointer
            ${ENTITY_COLORS[entity.type]}
          `}
          title={`Search: ${entity.searchQuery || entity.text}`}
        >
          {entity.text}
          <ChevronRight size={12} className="ml-0.5 opacity-60" />
        </button>,
      );

      lastIndex = entityIndex + entity.text.length;
    });

    // Add remaining text
    if (lastIndex < content.length) {
      elements.push(<span key="text-end">{content.slice(lastIndex)}</span>);
    }

    return <>{elements}</>;
  }, [factoid.content, factoid.entities, onEntityClick]);

  const style = getFactoidStyle(factoid.type);

  return (
    <div
      data-factoid-category={factoid.type}
      className="relative bg-surface/80 backdrop-blur-sm border border-border border-l-2 border-l-white/25 p-(--space-md) md:p-(--space-lg) rounded-md group hover:border-white/20 hover:bg-surface transition-all duration-(--duration-normal) ease-out-expo animate-fade-in-up overflow-hidden"
    >
      {/* Subtle glow on hover, neutral like the rest of the category chrome */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-(--duration-slow) pointer-events-none bg-gradient-to-br from-transparent via-transparent to-white/[0.03]" />

      {/* Header: in a narrow column the type chip moves below the title, and a title still
          wider than the column wraps, so neither is cut */}
      <div
        data-factoid-header
        className="relative flex flex-wrap items-center gap-x-2 gap-y-1 mb-3"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`${style.color} flex shrink-0 items-center justify-center w-6 h-6 rounded-full bg-white/5`}
          >
            {style.icon}
          </span>
          <span
            data-factoid-title
            className="min-w-0 break-words text-xs font-semibold text-text-secondary uppercase font-mono tracking-wider"
          >
            {factoid.title}
          </span>
        </div>
        <span
          data-factoid-type
          className={`ml-auto max-w-full truncate text-chrome font-mono px-2 py-0.5 rounded-full ${style.color} bg-white/5`}
        >
          {style.label}
        </span>
      </div>

      {/* Content */}
      <p className="relative text-sm text-text-secondary leading-relaxed font-sans group-hover:text-text-primary transition-colors duration-(--duration-fast)">
        {renderedContent}
      </p>

      {/* Where the statement comes from: its claim's kind, sources and verifier status */}
      {claim ? (
        <ClaimChip shown={claim} readings={readings} audio={audio} className="relative mt-3" />
      ) : (
        origin && <ProvenanceChip kind={origin} className="relative mt-3" />
      )}

      {/* Entities count indicator */}
      {factoid.entities && factoid.entities.length > 0 && (
        <div className="relative mt-3 pt-2 border-t border-white/5 text-chrome font-mono text-cyber/80 flex items-center gap-1.5">
          <span className="inline-block w-1 h-1 rounded-full bg-cyber/40" />
          {factoid.entities.length} CLICKABLE{' '}
          {factoid.entities.length === 1 ? 'ENTITY' : 'ENTITIES'}
        </div>
      )}
    </div>
  );
};

export default React.memo(InteractiveFactoid);
