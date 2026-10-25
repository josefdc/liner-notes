import type React from 'react';
import type { LinkKind, LinkType } from '@liner-notes/contract';
import { colors } from '../../styles/theme';
import { LINK_KIND_LABEL, LINK_TYPE_LABEL, LINK_TYPES } from './links';
import { LINK_COLOR, LINK_DASH } from './linkStyle';

const KIND_NOTE: Record<LinkKind, string> = {
  sourced: 'cites evidence in this result',
  inferred: 'not backed by evidence',
};

/** A short line drawn as a link of this colour and kind is. */
const Swatch: React.FC<{ color: string; kind: LinkKind }> = ({ color, kind }) => (
  <svg width="22" height="8" viewBox="0 0 22 8" aria-hidden="true" className="shrink-0">
    <line
      x1="1"
      y1="4"
      x2="21"
      y2="4"
      stroke={color}
      strokeWidth="2"
      strokeDasharray={LINK_DASH[kind] === 'none' ? undefined : LINK_DASH[kind]}
    />
  </svg>
);

/**
 * What the lines of the genealogy graph mean, in words: solid or dashed for how a link is
 * known, and a colour for each relation the graph shows (only those it shows).
 */
export const LinkLegend: React.FC<{ types: readonly LinkType[] }> = ({ types }) => {
  const shown = LINK_TYPES.filter((type) => types.includes(type));
  if (shown.length === 0) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a legend is not a form, so not a fieldset
    <div
      className="flex flex-col gap-1 text-chrome font-mono text-text-chip"
      role="group"
      aria-label="Link legend"
    >
      <ul className="flex flex-col gap-0.5" aria-label="How a link is known">
        {(['sourced', 'inferred'] as const).map((kind) => (
          <li key={kind} className="flex items-center gap-2" data-link-kind={kind}>
            <Swatch color={colors.gray[300]} kind={kind} />
            <span>
              <span className="text-text-secondary">
                {kind === 'sourced' ? 'Solid' : 'Dashed'}: {LINK_KIND_LABEL[kind]}
              </span>{' '}
              — {KIND_NOTE[kind]}
            </span>
          </li>
        ))}
      </ul>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5" aria-label="Relations">
        {shown.map((type) => (
          <li key={type} className="flex items-center gap-1.5" data-link-type={type}>
            <Swatch color={LINK_COLOR[type]} kind="sourced" />
            <span>{LINK_TYPE_LABEL[type]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};
