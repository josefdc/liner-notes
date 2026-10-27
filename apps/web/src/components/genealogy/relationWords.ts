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

/** The subjects a claim names as a relation between two records when no link states it. */
const RELATION_SUBJECTS = new Set<string>(['sample', 'cover']);

/** True for a claim subject that is a relation between two records (a sample, a cover). */
export const isRelationSubject = (about: string): about is 'sample' | 'cover' =>
  RELATION_SUBJECTS.has(about);

/**
 * Whether the relation a claim states is known: shown as sourced (or measured) and supported
 * whole. A relation is stated whole, as the verifier reads every claim about one: a source that
 * supports only part of it does not confirm it.
 */
export function claimRelationKnown(kind: string, verdict: string | null | undefined): boolean {
  return (kind === 'sourced' || kind === 'measured') && verdict !== 'partial';
}

/**
 * The words of the relation a claim states, as a fact's badge and the claims list name it: the
 * words of the shown link that states it (`linked`, from `relationLabelsByClaim`), so a remix
 * reads as the remix its line names; else its subject's when that is a sample or a cover; null
 * when it names no relation.
 */
export function claimRelationWords(
  about: string,
  known: boolean,
  linked?: string | null,
): string | null {
  if (linked) return linked;
  return isRelationSubject(about) ? relationName(about, known) : null;
}
