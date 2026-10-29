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
 * Whether the relation a claim states is known: shown as sourced (or measured) and, for a model
 * claim, supported whole. A relation is stated whole, as the verifier reads every claim about
 * one: a source that supports only part of it does not confirm it. A code-built claim is sourced
 * by construction, whatever a verdict says (the contract's `claimDisplayKind`).
 */
export function claimRelationKnown(
  kind: string,
  claim: { origin?: string; verdict?: string | null },
): boolean {
  if (kind !== 'sourced' && kind !== 'measured') return false;
  return !(claim.origin === 'model' && claim.verdict === 'partial');
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

/** What `withDocumentedRelations` reads of a claim as the page shows it (`ShownClaim`). */
interface ClaimShown {
  claim: {
    id: string;
    about: string;
    origin?: string;
    verdict?: string | null;
    documentedBy?: readonly string[];
  };
  kind: string;
  rejected: boolean;
}

/**
 * The words of the relations records document, by the id of each model claim that states one,
 * added to `linked` (the words of the shown links that state claims, which stay as they are). The
 * API marks such a claim (`documentedBy`: the code-built claims whose relation it states, in
 * its record's direction, in one plain sentence beside others that only add detail;
 * restatements.ts). It is named as those claims are (their link's words, else "Sample", "Cover"), never "Possible
 * sample", when each is shown sourced and about the same relation and the judge found the claim
 * supported or partly supported. Only the relation's name: the claim's own kind and verdict are
 * shown as they are. A claim without the mark, not judged, found unsupported, or whose records are
 * named in different words keeps its own words.
 */
export function withDocumentedRelations(
  linked: ReadonlyMap<string, string>,
  claims: readonly ClaimShown[],
): ReadonlyMap<string, string> {
  const sourced = new Map(
    claims
      .filter(
        (shown) =>
          shown.claim.origin === 'code' &&
          shown.kind === 'sourced' &&
          !shown.rejected &&
          isRelationSubject(shown.claim.about),
      )
      .map((shown) => [shown.claim.id, shown.claim] as const),
  );
  const words = new Map(linked);
  for (const { claim, rejected } of claims) {
    if (claim.origin !== 'model' || rejected || words.has(claim.id)) continue;
    if (claim.verdict !== 'supported' && claim.verdict !== 'partial') continue;
    const by = claim.documentedBy ?? [];
    if (!isRelationSubject(claim.about) || by.length === 0) continue;
    const named = new Set<string>();
    for (const id of by) {
      const built = sourced.get(id);
      named.add(
        built?.about === claim.about ? (linked.get(id) ?? relationName(claim.about, true)) : '',
      );
    }
    const [only] = named;
    if (named.size === 1 && only !== '' && !only.startsWith('Possible')) words.set(claim.id, only);
  }
  return words;
}
