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
import { claimIsRejected } from '../provenance/claims';
import { sourceLabel } from '../provenance/SourceLink';
import {
  evidencePack,
  linkContext,
  LINK_TYPE_LABEL,
  LINK_TYPES,
  type NamedNode,
  nodeName,
  nodesById,
  provenanceText,
  readGenealogy,
  readLink,
  relationLabel,
  relationSentence,
  relationToTrack,
  type ShownLink,
  shownLinks,
  yearFrom,
} from './links';
import { LINK_COLOR, LINK_DASH, LINK_OPACITY } from './linkStyle';
import { claim, contextOf as context, evidenceItem, link, node, PACK } from './testing';
const read = (
  value: unknown,
  ctx = context(),
  nodes: ReadonlyMap<string, NamedNode> = new Map(),
): ShownLink => {
  const result = readLink(value, ctx, nodes);
  if (!result || !('link' in result)) throw new Error('the link was not read');
  return result.link;
};
const sourced = (fields: Record<string, unknown> = {}) =>
  link('a', 'b', { type: 'sample', kind: 'sourced', evidenceIds: ['ev-mb-1'], ...fields });

const DOCUMENTED: LinkType[] = ['sample', 'interpolation', 'cover', 'remix'];
// As a claim's chip names the item: its tier only for a sourced link.
const MB = 'ev-mb-1 (MusicBrainz)';
const MB_SOURCED = 'ev-mb-1 (MusicBrainz · primary record)';

describe('evidencePack', () => {
  it('keeps the items the contract reads, by id, and leaves the others out', () => {
    const unreadable = { ...evidenceItem('ev-new'), source: 'a-new-source' };
    expect([...evidencePack([...PACK, unreadable, null, 'ev-text']).keys()]).toEqual([
      'ev-mb-1',
      'ev-shs-1',
    ]);
    expect(evidencePack(undefined).size).toBe(0);
  });
});

describe('readLink', () => {
  it('reads nothing the contract link schema rejects', () => {
    expect(readLink(link('a', 'b', { type: 'vibe' as LinkType }), context())).toBeNull();
    expect(readLink({ source: 'a', target: 'b' }, context())).toBeNull();
    expect(
      readLink({ source: 'a', target: 'b', value: 1, kind: 'measured' }, context()),
    ).toBeNull();
    expect(readLink('a -> b', context())).toBeNull();
  });

  it('shows a code-built sourced link of every relation as that relation, with tier and scope', () => {
    for (const type of LINK_TYPES) {
      const shown = read(sourced({ type, origin: 'code' }));
      expect(shown).toMatchObject({ kind: 'sourced', type, statedType: type, reasons: [] });
      expect(provenanceText(shown)).toBe(`Sourced · cites ${MB_SOURCED}`);
    }
    const shs = read(sourced({ evidenceIds: ['ev-shs-1'] }));
    expect(provenanceText(shs)).toBe('Sourced · cites ev-shs-1 (SecondHandSongs · primary record)');
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

  it('does not take "sourced" on trust: no citation, or one missing from the pack', () => {
    const none = read(sourced({ evidenceIds: [], origin: 'code' }));
    expect(none).toMatchObject({ kind: 'inferred', type: 'influence' });
    expect(provenanceText(none)).toBe(
      'Not sourced · stated as a sample, shown as an influence; says sourced but cites no evidence',
    );
    const ghost = read(sourced({ type: 'cover', evidenceIds: ['ev-mb-1', 'ev-ghost'] }));
    expect(ghost).toMatchObject({ kind: 'inferred', type: 'influence' });
    expect(ghost.citations).toEqual([
      { id: 'ev-mb-1', evidence: evidencePack(PACK).get('ev-mb-1') },
      { id: 'ev-ghost', evidence: null },
    ]);
    expect(provenanceText(ghost)).toBe(
      'Not sourced · stated as a cover, shown as an influence; cites ev-ghost, not in the ' +
        `evidence pack; cites ${MB}, not checked by a verifier`,
    );
  });

  it('says so when the result has no evidence pack at all', () => {
    const shown = read(sourced({ origin: 'code' }), context([], null));
    expect(shown.kind).toBe('inferred');
    expect(provenanceText(shown)).toContain('cites ev-mb-1; this result has no evidence pack');
  });

  it('names the evidence a model link cites without calling it checked', () => {
    const shown = read(
      link('a', 'b', { type: 'influence', kind: 'inferred', evidenceIds: ['ev-shs-1'] }),
    );
    expect(provenanceText(shown)).toBe(
      'Model inference · cites ev-shs-1 (SecondHandSongs), not ' + 'checked by a verifier',
    );
  });

  it('shows a model link as sourced only when its claim has a supporting verdict', () => {
    // Citing is not support: a model link that says sourced, with no claim, is an inference.
    const unjudged = read(sourced({ origin: 'model' }));
    expect(unjudged).toMatchObject({ kind: 'inferred', type: 'influence' });
    expect(provenanceText(unjudged)).toBe(
      'Model inference · stated as a sample, shown as an influence; proposed by the model; no ' +
        `verifier verdict supports it; cites ${MB}, not checked by a verifier`,
    );
    for (const verdict of ['supported', 'partial'] as const) {
      const shown = read(
        sourced({ origin: 'model', claimId: 'cl-1' }),
        context([claim('cl-1', { verdict, kind: 'sourced', evidenceIds: ['ev-mb-1'] })]),
      );
      expect(shown).toMatchObject({ kind: 'sourced', type: 'sample' });
    }
    const unsupported = read(
      sourced({ origin: 'model', claimId: 'cl-1' }),
      context([claim('cl-1', { verdict: 'unsupported' })]),
    );
    expect(unsupported.kind).toBe('inferred');
    expect(provenanceText(unsupported)).toBe(
      'Model inference · stated as a sample, shown as an influence; the verifier found its ' +
        `claim unsupported; cites ${MB}`,
    );
    const dangling = read(sourced({ origin: 'model', claimId: 'cl-gone' }));
    expect(dangling.kind).toBe('inferred');
    expect(provenanceText(dangling)).toContain('its claim is not in this result');
  });

  it('follows its claim: a link of any origin is sourced only when its claim reads sourced', () => {
    // No origin on the link; its claim, a model one, the verifier found unsupported.
    const unsupported = claim('cl-u', {
      kind: 'sourced',
      origin: 'model',
      evidenceIds: ['ev-mb-1'],
      verdict: 'unsupported',
    });
    const shown = read(sourced({ claimId: 'cl-u' }), context([unsupported]));
    expect(shown.kind).toBe('inferred');
    expect(provenanceText(shown)).toContain('the verifier found its claim unsupported');
    // A claim with no verdict that is not sourced: said so.
    const unjudged = read(sourced({ claimId: 'cl-n', origin: 'code' }), context([claim('cl-n')]));
    expect(unjudged.kind).toBe('inferred');
    expect(provenanceText(unjudged)).toContain('its claim is not sourced');
    // A code-built claim keeps its kind whatever the judge said, as its chip does.
    const code = claim('cl-c', {
      kind: 'sourced',
      origin: 'code',
      evidenceIds: ['ev-mb-1'],
      verdict: 'unsupported',
    });
    expect(read(sourced({ claimId: 'cl-c', origin: 'code' }), context([code])).kind).toBe(
      'sourced',
    );
  });

  it('leaves out a link whose claim the main view hides, by the shared rule', () => {
    for (const fields of [{ verdict: 'contradicted' }, { numericCheck: 'contradicted' }]) {
      expect(claimIsRejected(claim('cl-bad', fields))).toBe(true);
      const result = readLink(
        sourced({ origin: 'code', claimId: 'cl-bad' }),
        context([claim('cl-bad', fields)]),
      );
      expect(result).toEqual({ hidden: true });
    }
    // A claim this page cannot read is hidden too; a numeric conflict is not a rejection.
    expect(
      readLink(
        sourced({ origin: 'code', claimId: 'cl-x' }),
        context([{ id: 'cl-x', kind: 'new' }]),
      ),
    ).toEqual({ hidden: true });
    expect(
      readLink(
        sourced({ origin: 'code', claimId: 'c' }),
        context([
          claim('c', {
            numericCheck: 'conflict',
            kind: 'sourced',
            origin: 'code',
            evidenceIds: ['ev-mb-1'],
          }),
        ]),
      ),
    ).toMatchObject({ link: { kind: 'sourced' } });
  });

  it('gives no direction to a link the release years contradict', () => {
    const nodes = nodesById([
      node('new', 4, 'Newer - X (2020)'),
      node('old', 1, 'Older - Y (1990)'),
    ]);
    const backwards = read(
      sourced({ source: 'new', target: 'old', origin: 'code' }),
      context(),
      nodes,
    );
    expect(backwards).toMatchObject({ kind: 'inferred', directionKnown: false, type: 'influence' });
    expect(provenanceText(backwards)).toBe(
      'Not sourced · stated as a sample; the years (2020 and 1990) do not fit this direction; ' +
        `cites ${MB}, not checked by a verifier`,
    );
    expect(relationLabel(backwards)).toBe('Related, direction unknown');
    const name = (id: string) => nodeName(nodes.get(id), id);
    expect(relationSentence(backwards, name)).toBe(
      'Newer - X (2020) and Older - Y (1990) are related (direction unknown)',
    );
    // A shared producer has no direction to contradict.
    const producer = read(
      sourced({ source: 'new', target: 'old', type: 'producer', origin: 'code' }),
      context(),
      nodes,
    );
    expect(producer).toMatchObject({ kind: 'sourced', directionKnown: true });
  });

  it('names a cited item as its claim chip does, never above the tier the contract allows', () => {
    const pack = [
      // A web search result stated as a primary record; a primary record with no known scope;
      // one whose scope is a property every object has.
      { ...evidenceItem('ev-t', 'tavily'), sourceTier: 'primary-record', recordRef: null },
      { ...evidenceItem('ev-u'), recordRef: 'recording/abc' },
      { ...evidenceItem('ev-c'), recordRef: 'constructor/abc' },
      { ...evidenceItem('ev-w', 'secondhandsongs'), recordRef: 'work/performance/1' },
    ];
    const ctx = context([], pack);
    const cites = (id: string) =>
      provenanceText(read(sourced({ origin: 'code', evidenceIds: [id] }), ctx));
    for (const item of pack) {
      const parsed = evidencePack(pack).get(item.id);
      if (!parsed) throw new Error(`${item.id} was not read`);
      expect(cites(item.id)).toBe(`Sourced · cites ${item.id} (${sourceLabel(parsed)})`);
    }
    expect(cites('ev-t')).toBe('Sourced · cites ev-t (Web search · web page)');
    expect(cites('ev-u')).toBe('Sourced · cites ev-u (MusicBrainz · web page)');
    expect(cites('ev-c')).toBe('Sourced · cites ev-c (MusicBrainz · web page)');
    expect(cites('ev-w')).toBe(
      'Sourced · cites ev-w (SecondHandSongs · primary record · about the song, not this recording)',
    );
    expect(pack.map((item) => cites(item.id)).join(' ')).not.toMatch(/native code|function/);
  });

  it('takes the analysed track’s year from the result when its node’s label names none', () => {
    // The API labels the analysed track with its title alone.
    const genealogy = {
      nodes: [
        { id: 'current', group: 1, label: 'Bright Lines', trackTitle: 'Bright Lines', size: 40 },
        node('newer', 4, 'Newer Record - Someone (2020)'),
      ],
      links: [sourced({ source: 'newer', target: 'current', origin: 'code' })],
    };
    const withYear = linkContext(PACK, null, { releaseYear: '2011-05-02' });
    const [backwards] = shownLinks(genealogy, withYear);
    expect(backwards).toMatchObject({ kind: 'inferred', directionKnown: false });
    expect(provenanceText(backwards)).toContain(
      'the years (2020 and 2011) do not fit this direction',
    );
    const named = nodesById(genealogy.nodes, yearFrom('2011-05-02'));
    expect(nodeName(named.get('current'), 'current')).toBe('Bright Lines (2011)');
    // Without the result's year the check cannot tell, and says nothing.
    expect(shownLinks(genealogy, linkContext(PACK, null))[0]).toMatchObject({
      kind: 'sourced',
      directionKnown: true,
    });
    expect([yearFrom(2011), yearFrom('n/a'), yearFrom(null)]).toEqual([2011, null, null]);
  });

  it('reads an older link with no kind or type as an inferred influence', () => {
    expect(read(link('a', 'b'))).toMatchObject({
      kind: 'inferred',
      statedKind: null,
      type: 'influence',
      statedType: null,
    });
  });

  it('is never more generous than the contract', () => {
    const links = [
      sourced({ origin: 'code' }),
      sourced({ evidenceIds: ['ev-ghost'] }),
      sourced({ evidenceIds: [] }),
      sourced({ origin: 'model' }),
      link('a', 'b', { type: 'remix', kind: 'inferred', evidenceIds: ['ev-mb-1'] }),
      link('a', 'b', { type: 'producer' }),
      link('a', 'b'),
    ];
    const genealogy = Genealogy.parse({ nodes: [node('a', 1), node('b', 4)], links });
    const ctx = resultContext({
      evidence: PACK.map((item) => Evidence.parse(item)),
      audio: null,
    } as unknown as TrackAnalysis);
    expect(genealogy.links).toHaveLength(links.length);
    const contract = genealogy.links.map((value) => contractDisplayKind(value, ctx));
    const ours = links.map((value) => read(value).kind);
    // Sourced only where the contract says sourced; stricter for the model's link.
    expect(contract[3]).toBe('sourced');
    expect(ours).toEqual([
      'sourced',
      'inferred',
      'inferred',
      'inferred',
      'inferred',
      'inferred',
      'inferred',
    ]);
    ours.forEach((kind, i) => {
      if (kind === 'sourced') expect(contract[i]).toBe('sourced');
    });
  });
});

describe('readGenealogy', () => {
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
    expect(shownLinks(genealogy, context()).map((l) => [l.source, l.target, l.value])).toEqual([
      ['origin1', 'current', 3],
    ]);
    expect(shownLinks({ nodes: 'x', links: null }, context())).toEqual([]);
    expect(shownLinks(undefined)).toEqual([]);
  });

  it('counts the links it leaves out', () => {
    const reading = readGenealogy(
      {
        nodes: [node('current', 1), node('a', 2), node('b', 2)],
        links: [
          link('a', 'current', {
            type: 'sample',
            kind: 'sourced',
            evidenceIds: ['ev-mb-1'],
            claimId: 'cl-bad',
          }),
          link('b', 'current', { type: 'influence' }),
        ],
      },
      context([claim('cl-bad', { verdict: 'contradicted' })]),
    );
    expect(reading.hidden).toBe(1);
    expect(reading.links.map((l) => l.source)).toEqual(['b']);
  });

  it('shows every link as inferred when the result has no evidence pack', () => {
    const genealogy = {
      nodes: [node('current', 1), node('origin1', 2)],
      links: [
        link('origin1', 'current', { type: 'sample', kind: 'sourced', evidenceIds: ['ev-mb-1'] }),
      ],
    };
    expect(shownLinks(genealogy, context())[0]).toMatchObject({ kind: 'sourced' });
    expect(shownLinks(genealogy)[0]).toMatchObject({ kind: 'inferred', type: 'influence' });
    expect(shownLinks(genealogy, context([], null))[0]).toMatchObject({ kind: 'inferred' });
  });
});

describe('relations in words', () => {
  const nodes = nodesById([
    { ...node('current', 1, 'Bright Lines - Test Artist (2011)'), trackTitle: 'Bright Lines' },
    node('old', 2, 'Older Record - Someone (1984)'),
    node('new', 3, 'Newer Record - Someone (2015)'),
  ]);
  const nameOf = (id: string) => nodeName(nodes.get(id), id);
  const shown = (source: string, target: string, type: LinkType, value = 2): ShownLink =>
    read(
      link(source, target, {
        type,
        kind: 'sourced',
        evidenceIds: ['ev-mb-1'],
        value,
        origin: 'code',
      }),
      context(),
      nodes,
    );

  it('names a track by its title and year, or by its label', () => {
    expect(nameOf('current')).toBe('Bright Lines (2011)');
    expect(nameOf('old')).toBe('Older Record - Someone (1984)');
    expect(nameOf('ghost')).toBe('ghost');
  });

  it('states each sourced relation as a sentence naming both tracks', () => {
    const sentences = LINK_TYPES.map((type) =>
      relationSentence(shown('old', 'current', type), nameOf),
    );
    expect(sentences).toEqual([
      'Bright Lines (2011) samples Older Record - Someone (1984)',
      'Bright Lines (2011) interpolates Older Record - Someone (1984)',
      'Bright Lines (2011) covers Older Record - Someone (1984)',
      'Bright Lines (2011) remixes Older Record - Someone (1984)',
      'Older Record - Someone (1984) and Bright Lines (2011) share a producer',
      'Older Record - Someone (1984) influenced Bright Lines (2011)',
    ]);
    expect(relationSentence(shown('current', 'new', 'sample'), nameOf)).toBe(
      'Newer Record - Someone (2015) samples Bright Lines (2011)',
    );
  });

  it('hedges an inferred relation and gives it no direction', () => {
    const inferred = read(
      link('old', 'current', { type: 'sample', kind: 'inferred' }),
      context(),
      nodes,
    );
    expect(relationSentence(inferred, nameOf)).toBe(
      'Possible influence between Older Record - Someone (1984) and Bright Lines (2011)',
    );
    const producer = read(link('old', 'current', { type: 'producer' }), context(), nodes);
    expect(relationLabel(producer)).toBe('Possible shared producer');
    expect(relationSentence(producer, nameOf)).toBe(
      'Older Record - Someone (1984) and Bright Lines (2011) may share a producer',
    );
  });

  it('relates a track to the analysed one by the best known link', () => {
    const inferred = read(
      link('old', 'current', { type: 'influence', value: 3 }),
      context(),
      nodes,
    );
    const sample = shown('old', 'current', 'sample', 1);
    const influence = shown('old', 'current', 'influence', 3);
    // Sourced before inferred; a sourced sample before a stronger sourced influence.
    expect(relationToTrack([inferred, influence, sample], 'old', 'current')).toEqual({
      link: sample,
      text: 'Sample',
    });
    expect(relationToTrack([inferred], 'old', 'current').text).toBe('Possible influence');
    expect(relationToTrack([shown('old', 'new', 'sample')], 'old', 'current')).toEqual({
      link: null,
      text: 'No direct link to this track',
    });
  });

  it('relates a track by its best link to any track when the analysed one is not in the graph', () => {
    const toNew = shown('old', 'new', 'sample');
    expect(relationToTrack([toNew], 'old', null)).toEqual({ link: toNew, text: 'Sample' });
    expect(relationSentence(toNew, nameOf)).toBe(
      'Newer Record - Someone (2015) samples Older Record - Someone (1984)',
    );
    expect(relationToTrack([toNew], 'lonely', null)).toEqual({
      link: null,
      text: 'No link to another track',
    });
  });
});

/** WCAG relative luminance of an rgb colour (0-255 channels). */
function luminance(channels: number[]): number {
  const [r, g, b] = channels.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
/** A colour at `alpha` over another, as the page draws it. */
const over = (top: number[], alpha: number, bottom: number[]) =>
  top.map((v, i) => v * alpha + bottom[i] * (1 - alpha));
const contrast = (a: number[], b: number[]) => {
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

  it('draw every relation, of either kind, at 3:1 or more against the page as drawn', () => {
    const page = rgb(colors.void);
    for (const [type, color] of Object.entries(LINK_COLOR)) {
      for (const [kind, opacity] of Object.entries(LINK_OPACITY)) {
        const drawn = over(rgb(color), opacity, page);
        expect(contrast(drawn, page), `${kind} ${type}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('name every relation in text at 4.5:1 or more on the page-coloured halo it is drawn on', () => {
    // GenealogyGraph draws each line's label in the link's colour over a stroke of colors.void.
    const page = rgb(colors.void);
    for (const [type, color] of Object.entries(LINK_COLOR)) {
      expect(contrast(rgb(color), page), type).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('draw sourced links solid and the others dashed', () => {
    expect(LINK_DASH).toEqual({ sourced: 'none', inferred: '6 4' });
  });
});
