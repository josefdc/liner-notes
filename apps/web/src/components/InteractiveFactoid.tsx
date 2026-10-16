import React, { useMemo } from 'react';
import { Info, ChevronRight, Mic2, Music, Users, Sparkles, Link2 } from 'lucide-react';
import type { Factoid, FactoidEntity } from '../types';

interface InteractiveFactoidProps {
  factoid: Factoid;
  onEntityClick?: (entity: FactoidEntity) => void;
}

// Color mapping for entity types
const ENTITY_COLORS: Record<FactoidEntity['type'], string> = {
  synth: 'text-cyber hover:bg-cyber/20 border-cyber/30',
  producer: 'text-analog hover:bg-analog/20 border-analog/30',
  sample: 'text-accent-purple hover:bg-accent-purple/20 border-accent-purple/30',
  technique: 'text-accent-pink hover:bg-accent-pink/20 border-accent-pink/30',
  artist: 'text-accent-green hover:bg-accent-green/20 border-accent-green/30',
  album: 'text-accent-blue hover:bg-accent-blue/20 border-accent-blue/30',
  year: 'text-text-tertiary hover:bg-white/10 border-white/20',
};

// Get border color based on factoid type
function getBorderColor(type: Factoid['type']): string {
  switch (type) {
    case 'production':
      return 'border-l-cyber';
    case 'credits':
      return 'border-l-analog';
    case 'sample':
      return 'border-l-accent-purple';
    case 'curiosity':
      return 'border-l-accent-amber';
    case 'connection':
      return 'border-l-accent-green';
    default:
      return 'border-l-analog';
  }
}

// Get hover border color matching factoid type
function getHoverBorderColor(type: Factoid['type']): string {
  switch (type) {
    case 'production':
      return 'hover:border-cyber/25';
    case 'credits':
      return 'hover:border-analog/25';
    case 'sample':
      return 'hover:border-accent-purple/25';
    case 'curiosity':
      return 'hover:border-accent-amber/25';
    case 'connection':
      return 'hover:border-accent-green/25';
    default:
      return 'hover:border-analog/25';
  }
}

// Get icon and color based on factoid type
function getFactoidStyle(type: Factoid['type']): {
  icon: React.ReactNode;
  color: string;
  label: string;
} {
  switch (type) {
    case 'production':
      return { icon: <Mic2 size={14} />, color: 'text-cyber', label: 'PRODUCTION' };
    case 'credits':
      return { icon: <Users size={14} />, color: 'text-analog', label: 'CREDITS' };
    case 'sample':
      return { icon: <Music size={14} />, color: 'text-accent-purple', label: 'SAMPLE' };
    case 'curiosity':
      return { icon: <Sparkles size={14} />, color: 'text-accent-amber', label: 'CURIOSITY' };
    case 'connection':
      return { icon: <Link2 size={14} />, color: 'text-accent-green', label: 'CONNECTION' };
    default:
      return { icon: <Info size={14} />, color: 'text-analog', label: 'TRIVIA' };
  }
}

const InteractiveFactoid: React.FC<InteractiveFactoidProps> = ({ factoid, onEntityClick }) => {
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
            inline-flex items-center px-1.5 py-0.5 mx-0.5 rounded-[--radius-sm]
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
      className={`relative bg-surface/80 backdrop-blur-sm border border-border border-l-2 ${getBorderColor(factoid.type)} p-[--space-md] md:p-[--space-lg] rounded-[--radius-md] group ${getHoverBorderColor(factoid.type)} hover:bg-surface transition-all duration-[--duration-normal] ease-[--ease-out-expo] animate-fade-in-up overflow-hidden`}
    >
      {/* Subtle gradient glow on hover */}
      <div
        className={`absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-[--duration-slow] pointer-events-none bg-gradient-to-br from-transparent via-transparent ${
          factoid.type === 'production'
            ? 'to-cyber/[0.03]'
            : factoid.type === 'credits'
              ? 'to-analog/[0.03]'
              : factoid.type === 'sample'
                ? 'to-accent-purple/[0.03]'
                : factoid.type === 'curiosity'
                  ? 'to-accent-amber/[0.03]'
                  : factoid.type === 'connection'
                    ? 'to-accent-green/[0.03]'
                    : 'to-analog/[0.03]'
        }`}
      />

      {/* Header */}
      <div className="relative flex items-center gap-2 mb-3">
        <span
          className={`${style.color} flex items-center justify-center w-6 h-6 rounded-full bg-white/5`}
        >
          {style.icon}
        </span>
        <span className="text-xs font-semibold text-text-secondary uppercase font-mono tracking-[--tracking-wider] truncate">
          {factoid.title}
        </span>
        <span
          className={`ml-auto text-[9px] font-mono px-2 py-0.5 rounded-full ${style.color} bg-white/5`}
        >
          {style.label}
        </span>
      </div>

      {/* Content */}
      <p className="relative text-sm text-text-secondary leading-relaxed font-sans group-hover:text-text-primary transition-colors duration-[--duration-fast]">
        {renderedContent}
      </p>

      {/* Entities count indicator */}
      {factoid.entities && factoid.entities.length > 0 && (
        <div className="relative mt-3 pt-2 border-t border-white/5 text-[10px] font-mono text-cyber/60 flex items-center gap-1.5">
          <span className="inline-block w-1 h-1 rounded-full bg-cyber/40" />
          {factoid.entities.length} CLICKABLE{' '}
          {factoid.entities.length === 1 ? 'ENTITY' : 'ENTITIES'}
        </div>
      )}
    </div>
  );
};

export default React.memo(InteractiveFactoid);
