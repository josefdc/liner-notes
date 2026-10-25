import type { GenealogyLink, GenealogyNode } from '../../types';

/** Builders for genealogy tests: an evidence pack and links of every relation and kind. */

/** An evidence item the contract reads, with the given id and source. */
export function evidenceItem(id: string, source = 'musicbrainz') {
  return {
    id,
    source,
    sourceTier: source === 'tavily' ? 'web' : 'primary-record',
    url: `https://example.org/record/${id}`,
    title: `Record ${id}`,
    retrievedAt: '2026-10-01T12:00:00.000Z',
    excerpt: 'A short excerpt of the record.',
    recordRef: source === 'tavily' ? null : `track/recording/${id}`,
  };
}

export const PACK = [evidenceItem('ev-mb-1'), evidenceItem('ev-shs-1', 'secondhandsongs')];

export const node = (id: string, group: number, label = id): GenealogyNode => ({
  id,
  group,
  label,
  size: group === 1 ? 40 : 22,
});

export const link = (
  source: string,
  target: string,
  fields: Partial<GenealogyLink> = {},
): GenealogyLink => ({ source, target, value: 2, ...fields });

/** A claim the contract reads, as the verifier left it. */
export function claim(id: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    text: `Claim ${id}`,
    about: 'sample',
    kind: 'inferred',
    origin: 'model',
    evidenceIds: [],
    verdict: null,
    verdictReason: null,
    numericCheck: 'n/a',
    ...fields,
  };
}
