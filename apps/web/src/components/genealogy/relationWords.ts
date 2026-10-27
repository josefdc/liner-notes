import type { LinkType } from '@liner-notes/contract';

/**
 * How every view names a relation between two records: the graph's lines, its legend and its
 * list, a connected track's card on the Dashboard, and a fact's type badge in the Player. One
 * function, so the words cannot drift apart: a sample that is not known reads "Possible sample"
 * wherever it is shown.
 */

export const LINK_TYPE_LABEL: Record<LinkType, string> = {
  sample: 'Sample',
  interpolation: 'Interpolation',
  cover: 'Cover',
  remix: 'Remix',
  producer: 'Shared producer',
  influence: 'Influence',
};

/**
 * A relation's name: as it is stated when it is known (a sourced link, or a fact whose claim a
 * source supports whole), hedged as possible when it is not ("Possible sample").
 */
export function relationName(type: LinkType, known: boolean): string {
  const label = LINK_TYPE_LABEL[type];
  return known ? label : `Possible ${label.toLowerCase()}`;
}
