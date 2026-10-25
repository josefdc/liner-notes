import {
  Evidence,
  Genealogy,
  type LinkType,
  linkDisplayKind as contractDisplayKind,
  resultContext,
  type TrackAnalysis,
} from '@liner-notes/contract';
import { describe, expect, it } from 'vitest';
import { colors } from '../../styles/theme';
import {
  evidencePack,
  LINK_TYPE_LABEL,
  LINK_TYPES,
  provenanceText,
  readLink,
  relationToTrack,
  shownLinks,
  type ShownLink,
} from './links';
import { LINK_COLOR, LINK_DASH } from './linkStyle';
import { evidenceItem, link, node, PACK } from './testing';

const pack = evidencePack(PACK);
const read = (value: unknown) => {
  const shown = readLink(value, pack);
  if (!shown) throw new Error('the link was not read');
  return shown;
};

const DOCUMENTED: LinkType[] = ['sample', 'interpolation', 'cover', 'remix'];

describe('evidencePack', () => {
  it('keeps the items the contract reads, by id, and leaves the others out', () => {
    const unreadable = { ...evidenceItem('ev-new'), source: 'a-new-source' };
    const result = evidencePack([...PACK, unreadable, null, 'ev-text']);
    expect([...result.keys()]).toEqual(['ev-mb-1', 'ev-shs-1']);
    expect(evidencePack(undefined).size).toBe(0);
    expect(evidencePack({ id: 'ev-mb-1' }).size).toBe(0);
  });
});

describe('readLink', () => {
  it('reads nothing the contract link schema rejects', () => {
    expect(readLink(link('a', 'b', { type: 'vibe' as LinkType }), pack)).toBeNull();
    expect(readLink({ source: 'a', target: 'b' }, pack)).toBeNull();
    expect(readLink({ source: 'a', target: 'b', value: 1, kind: 'measured' }, pack)).toBeNull();
    expect(readLink('a -> b', pack)).toBeNull();
  });

  it('shows a sourced link of every relation as that relation when its evidence is in the pack', () => {
    for (const type of LINK_TYPES) {
      const shown = read(link('a', 'b', { type, kind: 'sourced', evidenceIds: ['ev-mb-1'] }));
      expect(shown).toMatchObject({ kind: 'sourced', type, statedType: type });
      expect(provenanceText(shown)).toBe('Sourced · cites ev-mb-1 (musicbrainz)');
    }
  });

  it('shows an inferred sample, interpolation, cover or remix as an influence', () => {
    for (const type of DOCUMENTED) {
      const shown = read(link('a', 'b', { type, kind: 'inferred', evidenceIds: [] }));
      expect(shown).toMatchObject({ kind: 'inferred', type: 'influence', statedType: type });
      expect(provenanceText(shown)).toMatch(
        /^Model inference · stated as an? [a-z]+, shown as an influence; no evidence cited$/,
      );
    }
  });

  it('keeps an inferred shared producer and influence as they are, said to be inferred', () => {
    for (const type of ['producer', 'influence'] as const) {
      const shown = read(link('a', 'b', { type, kind: 'inferred' }));
      expect(shown).toMatchObject({ kind: 'inferred', type });
      expect(provenanceText(shown)).toBe('Model inference · no evidence cited');
    }
  });

  it('does not take "sourced" on trust: no citation or a citation missing from the pack', () => {
    const none = read(link('a', 'b', { type: 'sample', kind: 'sourced', evidenceIds: [] }));
    expect(none).toMatchObject({ kind: 'inferred', type: 'influence' });
    expect(provenanceText(none)).toBe(
      'Model inference · stated as a sample, shown as an influence; says sourced but cites no evidence',
    );

    const ghost = read(
      link('a', 'b', { type: 'cover', kind: 'sourced', evidenceIds: ['ev-mb-1', 'ev-ghost'] }),
    );
    expect(ghost).toMatchObject({ kind: 'inferred', type: 'influence' });
    expect(ghost.citations).toEqual([
      { id: 'ev-mb-1', evidence: pack.get('ev-mb-1') },
      { id: 'ev-ghost', evidence: null },
    ]);
    expect(provenanceText(ghost)).toBe(
      'Model inference · stated as a cover, shown as an influence; cites ev-ghost, not in the ' +
        'evidence pack; cites ev-mb-1 (musicbrainz), not checked by a verifier',
    );
  });

  it('names the evidence a model link cites without calling it checked', () => {
    const shown = read(
      link('a', 'b', { type: 'influence', kind: 'inferred', evidenceIds: ['ev-shs-1'] }),
    );
    expect(provenanceText(shown)).toBe(
      'Model inference · cites ev-shs-1 (secondhandsongs), not checked by a verifier',
    );
  });

  it('reads an older link with no kind or type as an inferred influence', () => {
    expect(read(link('a', 'b'))).toMatchObject({
      kind: 'inferred',
      statedKind: null,
      type: 'influence',
      statedType: null,
    });
    expect(read(link('a', 'b', { type: 'sample' }))).toMatchObject({
      kind: 'inferred',
      type: 'influence',
    });
  });

  it('agrees with the contract reading the whole result', () => {
    const links = [
      link('a', 'current', { type: 'sample', kind: 'sourced', evidenceIds: ['ev-mb-1'] }),
      link('a', 'current', { type: 'sample', kind: 'sourced', evidenceIds: ['ev-ghost'] }),
      link('a', 'current', { type: 'sample', kind: 'sourced', evidenceIds: [] }),
      link('a', 'current', { type: 'remix', kind: 'inferred', evidenceIds: ['ev-mb-1'] }),
      link('a', 'current', { type: 'producer' }),
      link('a', 'current'),
    ];
    const genealogy = Genealogy.parse({ nodes: [node('current', 1), node('a', 4)], links });
    const context = resultContext({
      evidence: PACK.map((item) => Evidence.parse(item)),
      audio: null,
    } as unknown as TrackAnalysis);
    expect(genealogy.links).toHaveLength(links.length);
    expect(links.map((value) => read(value).kind)).toEqual(
      genealogy.links.map((value) => contractDisplayKind(value, context)),
    );
  });
});

describe('shownLinks', () => {
  it('leaves out links to or from a node id that is not in the graph, and unreadable ones', () => {
    const genealogy = {
      nodes: [node('current', 1), node('origin1', 2)],
      links: [
        link('origin1', 'current', { value: 3 }),
        link('ghost', 'current'),
        link('current', 'missing'),
        { source: 'origin1', target: 'current', value: 1, type: 'vibe' },
      ],
    };
    expect(
      shownLinks({ ...genealogy, evidence: PACK }).map((l) => [l.source, l.target, l.value]),
    ).toEqual([['origin1', 'current', 3]]);
    expect(shownLinks({ nodes: 'x', links: null, evidence: null })).toEqual([]);
    expect(shownLinks(undefined)).toEqual([]);
  });

  it('shows every link as inferred when the result has no evidence pack', () => {
    const genealogy = {
      nodes: [node('current', 1), node('origin1', 2)],
      links: [
        link('origin1', 'current', { type: 'sample', kind: 'sourced', evidenceIds: ['ev-mb-1'] }),
      ],
    };
    expect(shownLinks({ ...genealogy, evidence: PACK })[0]).toMatchObject({
      kind: 'sourced',
      type: 'sample',
    });
    expect(shownLinks(genealogy)[0]).toMatchObject({
      kind: 'inferred',
      type: 'influence',
    });
  });
});

describe('relationToTrack', () => {
  const sourced = (source: string, target: string, type: LinkType, value = 2): ShownLink =>
    read(link(source, target, { type, kind: 'sourced', evidenceIds: ['ev-mb-1'], value }));

  it('names a sourced relation from the analysed track, by the link direction', () => {
    expect(relationToTrack([sourced('old', 'current', 'sample')], 'old', 'current').text).toBe(
      'Sampled in this track',
    );
    expect(relationToTrack([sourced('current', 'new', 'sample')], 'new', 'current').text).toBe(
      'Samples this track',
    );
    expect(relationToTrack([sourced('old', 'current', 'cover')], 'old', 'current').text).toBe(
      'Covered by this track',
    );
    expect(relationToTrack([sourced('old', 'current', 'producer')], 'old', 'current').text).toBe(
      'Shares a producer',
    );
  });

  it('never names a documented relation for an inferred link', () => {
    const inferred = read(link('old', 'current', { type: 'sample', kind: 'inferred' }));
    expect(relationToTrack([inferred], 'old', 'current')).toEqual({
      link: inferred,
      text: 'Possible influence',
    });
    const producer = read(link('old', 'current', { type: 'producer' }));
    expect(relationToTrack([producer], 'old', 'current').text).toBe('Possible shared producer');
  });

  it('prefers a sourced link, then the strongest, and says when no link joins the two', () => {
    const inferred = read(link('old', 'current', { type: 'influence', value: 3 }));
    const weakSourced = sourced('old', 'current', 'influence', 1);
    expect(relationToTrack([inferred, weakSourced], 'old', 'current').link).toBe(weakSourced);
    expect(relationToTrack([sourced('old', 'other', 'sample')], 'old', 'current')).toEqual({
      link: null,
      text: 'No direct link to this track',
    });
    expect(relationToTrack([inferred], 'old', null).link).toBeNull();
  });
});

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

describe('link styles', () => {
  it('give every relation a label and its own colour, from the theme', () => {
    expect(Object.keys(LINK_TYPE_LABEL).sort()).toEqual([...LINK_TYPES].sort());
    expect(Object.keys(LINK_COLOR).sort()).toEqual([...LINK_TYPES].sort());
    expect(new Set(Object.values(LINK_COLOR)).size).toBe(LINK_TYPES.length);
    const theme = new Set<string>(
      Object.values(colors).flatMap((value) =>
        typeof value === 'string' ? [value] : Object.values(value),
      ),
    );
    for (const color of Object.values(LINK_COLOR)) expect(theme.has(color)).toBe(true);
  });

  it('draw every relation at 3:1 or more against the page (non-text contrast)', () => {
    for (const [type, color] of Object.entries(LINK_COLOR)) {
      expect(contrast(color, colors.void), type).toBeGreaterThanOrEqual(3);
    }
  });

  it('draw sourced links solid and inferred ones dashed', () => {
    expect(LINK_DASH).toEqual({ sourced: 'none', inferred: '6 4' });
  });
});
