import type React from 'react';
import type { LinkKind, LinkType } from '@liner-notes/contract';
import { colors } from '../../styles/theme';
import { LINK_TYPE_LABEL, LINK_TYPES } from './links';
import { LINK_COLOR, LINK_DASH } from './linkStyle';

const KIND_NOTE: Record<LinkKind, string> = {
  sourced: 'cites evidence in this result',
  // True of every dashed line, whatever relation it states and however it was judged (a model
  // inference, evidence missing or not checked, a claim found unsupported or only partly
  // supported, years against its direction): each line's details and the list give its reason.
  inferred: "each line's details say why",
};
const KIND_NAME: Record<LinkKind, string> = { sourced: 'Sourced', inferred: 'Not sourced' };

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
 * What the grey of the influence stands for: a sample, interpolation, cover or remix that is not
 * sourced is drawn grey too (as an influence), its line naming the relation it states.
 */
export interface GreyLines {
  /** A link that states an influence (or no relation) is shown. */
  influence: boolean;
  /** A link that states another relation is drawn grey because it is not sourced. */
  notSourced: boolean;
}

/** The words beside the grey swatch. */
function greyLabel(grey: GreyLines | undefined): string {
  if (!grey?.notSourced) return LINK_TYPE_LABEL.influence;
  return grey.influence ? 'Influence, or not sourced (any relation)' : 'Not sourced (any relation)';
}

/**
 * What the lines of the genealogy graph mean, in words: solid or dashed for how a link is
 * known, and a colour for each relation the graph shows (only those it shows). The grey is named
 * for what it is drawn for (`grey`): an influence, a relation that is not sourced, or both.
 */
export const LinkLegend: React.FC<{ types: readonly LinkType[]; grey?: GreyLines }> = ({
  types,
  grey,
}) => {
  const shown = LINK_TYPES.filter((type) => types.includes(type));
  // Only relations that are not sourced are drawn grey: their swatch is dashed.
  const greyKind: LinkKind = grey?.notSourced && !grey.influence ? 'inferred' : 'sourced';
  if (shown.length === 0) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a legend is not a form, so not a fieldset
    <div
      className="flex flex-col gap-1 text-chrome font-mono text-text-chip"
      role="group"
      aria-label="Link legend"
    >
      {/* The two kinds on one line in a short window from md up (a phone held sideways), where
          every line taken from the map shows */}
      <ul
        className="flex flex-col gap-0.5 landscape-short:flex-row landscape-short:flex-wrap landscape-short:gap-x-4"
        aria-label="How a link is known"
      >
        {(['sourced', 'inferred'] as const).map((kind) => (
          <li key={kind} className="flex items-center gap-2" data-link-kind={kind}>
            <Swatch color={colors.gray[300]} kind={kind} />
            <span>
              <span className="text-text-secondary">
                {kind === 'sourced' ? 'Solid' : 'Dashed'}: {KIND_NAME[kind]}
              </span>{' '}
              — {KIND_NOTE[kind]}
            </span>
          </li>
        ))}
      </ul>
      <ul className="flex flex-wrap gap-x-3 gap-y-0.5" aria-label="Relations">
        {shown.map((type) => (
          <li key={type} className="flex items-center gap-1.5" data-link-type={type}>
            <Swatch color={LINK_COLOR[type]} kind={type === 'influence' ? greyKind : 'sourced'} />
            <span>{type === 'influence' ? greyLabel(grey) : LINK_TYPE_LABEL[type]}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};
