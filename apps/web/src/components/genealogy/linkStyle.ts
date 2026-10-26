import type { LinkKind, LinkType } from '@liner-notes/contract';
import { colors } from '../../styles/theme';

/**
 * How a link is drawn. The relation it is shown as sets the colour (tokens.css, named by
 * relation), its kind the line: solid when sourced, dashed when not sourced. Neither is the only cue: the graph names each
 * relation next to its line, and the legend and the list say both in words.
 */
export const LINK_COLOR: Record<LinkType, string> = {
  sample: colors.relation.sample,
  interpolation: colors.relation.interpolation,
  cover: colors.relation.cover,
  remix: colors.relation.remix,
  producer: colors.relation.producer,
  influence: colors.relation.influence,
};

/** The dash pattern of a link's line (an SVG stroke-dasharray), by its kind. */
export const LINK_DASH: Record<LinkKind, string> = {
  sourced: 'none',
  inferred: '6 4',
};

/** How opaque a link's line is at rest, by its kind. */
export const LINK_OPACITY: Record<LinkKind, number> = {
  sourced: 0.9,
  inferred: 0.8,
};

/** A link's line width from its strength (1-3). */
export function linkWidth(value: number, kind: LinkKind): number {
  const strength = Number.isFinite(value) ? Math.min(Math.max(value, 1), 3) : 1;
  return Math.sqrt(strength) * (kind === 'sourced' ? 2 : 1.5);
}
