import { LINK_CLAIM_ABOUT, type LinkType } from '@liner-notes/contract';
import { describe, expect, it } from 'vitest';
import type { Factoid, TrackData } from '../../types';
import { factoidCategory } from '../InteractiveFactoid';
import { resultClaims } from '../provenance/claims';
import { claimLabel } from '../provenance/ClaimList';
import {
  LINK_TYPES,
  linkContext,
  readGenealogy,
  relationLabel,
  relationLabelsByClaim,
  relationSentence,
  relationToTrack,
} from './links';
import { LINK_COLOR } from './linkStyle';
import { relationName, withDocumentedRelations } from './relationWords';
import { claim, evidenceItem, link, node, PACK } from './testing';

// One set of words for a relation wherever it is shown. For each relation and each way its
// claim was judged, one result holds a link that states the claim; the four places the relation
// is named are read from it and compared:
// - the graph's line (and its list and focus detail),
// - a connected track's card on the Dashboard,
// - a fact's type badge in the Player, for a fact stating the claim,
// - the Player's claims list ("More claims"), where a link's claim is listed.
// A link that is not sourced is drawn grey as an influence, whatever relation it states: the
// amber of a sample is the sourced colour.

/** How the link's claim was judged: none of these but `supported` makes the relation known. */
const STATES = [
  { name: 'supported', verdict: 'supported', known: true },
  { name: 'partly supported', verdict: 'partial', known: false },
  { name: 'unsupported', verdict: 'unsupported', known: false },
  { name: 'not checked', verdict: null, known: false },
] as const;

const DOCUMENTED: ReadonlySet<LinkType> = new Set(['sample', 'interpolation', 'cover', 'remix']);

function readOne(type: LinkType, verdict: (typeof STATES)[number]['verdict']) {
  const about = LINK_CLAIM_ABOUT[type][0];
  const claims = [claim('cl-1', { about, kind: 'sourced', evidenceIds: ['ev-mb-1'], verdict })];
  const track = {
    evidence: PACK,
    claims,
    factoids: [],
    genealogy: {
      nodes: [node('current', 1, 'Bright Lines (2011)'), node('old', 2, 'Old Record (1984)')],
      links: [
        link('old', 'current', {
          type,
          kind: 'sourced',
          origin: 'model',
          evidenceIds: ['ev-mb-1'],
          claimId: 'cl-1',
        }),
      ],
    },
  } as unknown as TrackData;
  const shown = resultClaims(track);
  const links = readGenealogy(track.genealogy, linkContext(PACK, shown)).links;
  const relations = relationLabelsByClaim(links);
  const stated = shown.byId.get('cl-1');
  if (!stated) throw new Error('the claim was not read');
  const fact = { id: 'f', title: 'A fact', content: 'Old Record', type: 'trivia' } as Factoid;
  return {
    link: links[0],
    claimKind: stated.kind,
    fact: factoidCategory(fact, stated, false, relations.get('cl-1')).label,
    listed: claimLabel(stated, relations),
  };
}

describe('relation words', () => {
  it('hedge a relation that is not known: "Possible sample", "Possible cover"…', () => {
    expect(LINK_TYPES.map((type) => relationName(type, false))).toEqual([
      'Possible sample',
      'Possible interpolation',
      'Possible cover',
      'Possible remix',
      'Possible shared producer',
      'Possible influence',
    ]);
    expect(LINK_TYPES.map((type) => relationName(type, true))).toEqual([
      'Sample',
      'Interpolation',
      'Cover',
      'Remix',
      'Shared producer',
      'Influence',
    ]);
  });

  describe.each(LINK_TYPES)('a link stating the %s relation', (type) => {
    it.each(STATES)(
      'whose claim is $name reads the same on the line, the Dashboard card, the fact and the claims list',
      ({ verdict, known }) => {
        const { link: shown, claimKind, fact, listed } = readOne(type, verdict);
        const words = relationName(type, known);
        expect(shown.kind).toBe(known ? 'sourced' : 'inferred');
        // The graph's line label (in lower case there) and the Dashboard card's badge.
        expect(relationLabel(shown)).toBe(words);
        expect(relationToTrack([shown], 'old', 'current').text).toBe(words);
        // The fact's badge and the claims list name the claim as its link is named.
        expect(fact).toBe(words.toUpperCase());
        expect(listed).toBe(words);
        // The claim itself reads as sourced exactly when its relation is known: a partly
        // supported relation is not sourced in the list either.
        expect(claimKind === 'sourced').toBe(known);
        // The graph's list and the card's sentence: a hedged documented relation says so.
        const sentence = relationSentence(shown, (id) => id);
        if (!known && DOCUMENTED.has(type)) expect(sentence).toMatch(new RegExp(`^${words}: `));
        if (known) expect(sentence).not.toMatch(/^Possible|may/);
        // Drawn in its relation's colour only when sourced: a documented relation that is not
        // sourced is grey, as an influence, never the sourced amber.
        const drawn = !known && DOCUMENTED.has(type) ? 'influence' : type;
        expect(shown.type).toBe(drawn);
        expect(LINK_COLOR[shown.type]).toBe(LINK_COLOR[drawn]);
        if (!known) expect(LINK_COLOR[shown.type]).not.toBe(LINK_COLOR.sample);
      },
    );
  });

  it.each(STATES)(
    'names a sample or cover no link states the same on its fact and in the list ($name)',
    ({ verdict, known }) => {
      for (const about of ['sample', 'cover'] as const) {
        const track = {
          evidence: PACK,
          claims: [claim('cl-1', { about, kind: 'sourced', evidenceIds: ['ev-mb-1'], verdict })],
          factoids: [],
          genealogy: { nodes: [], links: [] },
        } as unknown as TrackData;
        const stated = resultClaims(track).byId.get('cl-1');
        if (!stated) throw new Error('the claim was not read');
        const fact = { id: 'f', title: 'A fact', content: 'x', type: 'trivia' } as Factoid;
        const words = relationName(about, known);
        expect(factoidCategory(fact, stated).label).toBe(words.toUpperCase());
        expect(claimLabel(stated)).toBe(words);
        // A partly supported relation is not sourced, with or without a link.
        expect(stated.kind === 'sourced').toBe(known);
      }
    },
  );
});

/** The claims and links of one result, and how each claim is named on a fact and in the list. */
function readResult(claims: unknown[], links: unknown[], evidence: unknown[] = PACK) {
  const track = {
    evidence,
    claims,
    factoids: [],
    genealogy: {
      nodes: [
        node('current', 1, 'Bright Lines (2011)'),
        node('old', 2, 'Old Record (1984)'),
        node('old2', 2, 'Other Record (1985)'),
      ],
      links,
    },
  } as unknown as TrackData;
  const shown = resultClaims(track);
  const read = readGenealogy(track.genealogy, linkContext(evidence, shown)).links;
  const relations = relationLabelsByClaim(read);
  const fact = { id: 'f', title: 'A fact', content: 'Old Record', type: 'trivia' } as Factoid;
  return {
    links: read.map(relationLabel),
    of: (id: string) => {
      const stated = shown.byId.get(id);
      if (!stated) throw new Error(`no claim ${id}`);
      return {
        kind: stated.kind,
        fact: factoidCategory(fact, stated, false, relations.get(id)).label,
        listed: claimLabel(stated, relations),
      };
    },
  };
}

const modelLink = (type: LinkType, from = 'old', claimId = 'cl-1') =>
  link(from, 'current', {
    type,
    kind: 'sourced',
    origin: 'model',
    evidenceIds: ['ev-mb-1'],
    claimId,
  });
const supported = (about: string) =>
  claim('cl-1', { about, kind: 'sourced', evidenceIds: ['ev-mb-1'], verdict: 'supported' });

describe('a claim a link cites but does not state', () => {
  it('keeps its own subject: a trivia claim on an influence link is trivia', () => {
    const { links, of } = readResult(
      [claim('cl-1', { about: 'trivia', text: 'The song was a club favourite in 2011.' })],
      [
        link('old', 'current', {
          type: 'influence',
          kind: 'inferred',
          origin: 'model',
          claimId: 'cl-1',
        }),
      ],
    );
    expect(links).toEqual(['Possible influence']);
    expect(of('cl-1')).toEqual({ kind: 'inferred', fact: 'TRIVIA', listed: 'Trivia' });
  });

  it('keeps its own relation: a supported sample claim on a cover link is a sample', () => {
    const { links, of } = readResult([supported('sample')], [modelLink('cover')]);
    // The link is not sourced through a claim about another relation.
    expect(links).toEqual(['Possible cover']);
    expect(of('cl-1')).toEqual({ kind: 'sourced', fact: 'SAMPLE', listed: 'Sample' });
  });

  it('keeps its own subject: a supported history claim on a sample link is history', () => {
    const { links, of } = readResult([supported('history')], [modelLink('sample')]);
    expect(links).toEqual(['Possible sample']);
    expect(of('cl-1')).toEqual({ kind: 'sourced', fact: 'HISTORY', listed: 'History' });
  });
});

describe('a claim two links state', () => {
  it('is named by its subject, hedged, when the links name it differently', () => {
    // One supported claim behind a remix and a sample link: it backs neither (one claim, one
    // link), and neither link's words are taken for it, whichever comes first.
    const { links, of } = readResult(
      [supported('sample')],
      [modelLink('remix', 'old'), modelLink('sample', 'old2')],
    );
    expect(links).toEqual(['Possible remix', 'Possible sample']);
    expect(of('cl-1')).toMatchObject({ fact: 'POSSIBLE SAMPLE', listed: 'Possible sample' });
  });

  it('takes their words when both name it the same way', () => {
    const { links, of } = readResult(
      [supported('sample')],
      [modelLink('sample', 'old'), modelLink('sample', 'old2')],
    );
    expect(links).toEqual(['Possible sample', 'Possible sample']);
    expect(of('cl-1')).toMatchObject({ fact: 'POSSIBLE SAMPLE', listed: 'Possible sample' });
  });
});

describe('a partly supported claim that cites a relation record', () => {
  // A primary record of a sample (its recordRef names the relationship), as the API's verifier
  // tells one (isRelationRecord, #191).
  const sampledBy = {
    ...evidenceItem('ev-rel'),
    recordRef: 'track/recording/a/sampled-by/recording/b',
  };

  it('reads as a model inference, whatever the model labelled it', () => {
    const { of } = readResult(
      [
        claim('cl-t', {
          about: 'trivia',
          kind: 'sourced',
          evidenceIds: ['ev-rel'],
          verdict: 'partial',
        }),
      ],
      [],
      [...PACK, sampledBy],
    );
    expect(of('cl-t').kind).toBe('inferred');
  });

  it('stays sourced when it cites no relation record, or when the verifier supported it', () => {
    const { of } = readResult(
      [
        claim('cl-p', {
          about: 'trivia',
          kind: 'sourced',
          evidenceIds: ['ev-mb-1'],
          verdict: 'partial',
        }),
        claim('cl-s', {
          about: 'trivia',
          kind: 'sourced',
          evidenceIds: ['ev-rel'],
          verdict: 'supported',
        }),
      ],
      [],
      [...PACK, sampledBy],
    );
    expect(of('cl-p').kind).toBe('sourced');
    expect(of('cl-s').kind).toBe('sourced');
  });

  it('keeps a code-built claim sourced, and its link, as the contract does', () => {
    const { links, of } = readResult(
      [
        claim('cl-1', {
          about: 'sample',
          kind: 'sourced',
          origin: 'code',
          evidenceIds: ['ev-mb-1'],
          verdict: 'partial',
        }),
      ],
      [
        link('old', 'current', {
          type: 'sample',
          kind: 'sourced',
          origin: 'code',
          evidenceIds: ['ev-mb-1'],
          claimId: 'cl-1',
        }),
      ],
    );
    expect(links).toEqual(['Sample']);
    expect(of('cl-1')).toEqual({ kind: 'sourced', fact: 'SAMPLE', listed: 'Sample' });
  });
});

// A model claim the API marks as stating a relation a record documents (`documentedBy`: the
// code-built claims on its records) is named as the record's relation, never "Possible …", when
// the judge found it supported or partly supported; its own kind stays. The page never works the
// relation out from the claim's records itself.
describe('a model claim on a relation a record documents', () => {
  /** The result: a code-built claim on `ev-mb-1`, and the model's claim, as the API served it. */
  function named(model: Record<string, unknown>, code: Record<string, unknown> = {}) {
    const track = {
      evidence: PACK,
      claims: [
        claim('code-1', {
          about: 'sample',
          kind: 'sourced',
          origin: 'code',
          evidenceIds: ['ev-mb-1'],
          ...code,
        }),
        claim('m-1', { evidenceIds: ['ev-mb-1'], documentedBy: ['code-1'], ...model }),
      ],
      factoids: [],
      genealogy: { nodes: [], links: [] },
    } as unknown as TrackData;
    const shown = resultClaims(track);
    const relations = withDocumentedRelations(new Map(), shown.all);
    const stated = shown.byId.get('m-1');
    if (!stated) throw new Error('the claim was not read');
    const fact = { id: 'f', title: 'A fact', content: 'x', type: 'sample' } as Factoid;
    return {
      kind: stated.kind,
      fact: factoidCategory(fact, stated, false, relations.get('m-1')).label,
      listed: claimLabel(stated, relations),
    };
  }

  it.each(STATES.filter(({ verdict }) => verdict === 'supported' || verdict === 'partial'))(
    'is named as the record names it, its own kind kept ($name)',
    ({ verdict }) => {
      const read = named({ about: 'sample', kind: 'inferred', verdict });
      expect(read.fact).toBe('SAMPLE');
      expect(read.listed).toBe('Sample');
      expect(read.kind).toBe('inferred');
    },
  );

  it('a cover of the song, named as its record names it', () => {
    const read = named(
      { about: 'cover', scope: 'work', verdict: 'partial' },
      { about: 'cover', scope: 'work' },
    );
    expect(read.fact).toBe('COVER');
  });

  it('keeps "Possible" when the judge found it unsupported or did not judge it', () => {
    for (const verdict of ['unsupported', null]) {
      const read = named({ about: 'sample', kind: 'inferred', verdict });
      expect(read.listed, String(verdict)).toBe(relationName('sample', false));
      expect(read.fact, String(verdict)).not.toBe('SAMPLE');
    }
  });

  it('keeps "Possible" when the API did not mark it, whatever its records', () => {
    // On the code claim's record, at its scope, about its relation: unmarked, it keeps its words
    // (it may name another record, or read the relation the other way).
    const read = named({ about: 'sample', verdict: 'partial', documentedBy: undefined });
    expect(read.listed).toBe(relationName('sample', false));
    expect(named({ about: 'sample', verdict: 'partial', documentedBy: [] }).listed).toBe(
      relationName('sample', false),
    );
  });

  it('keeps "Possible" when the claims it is marked with are not shown sourced on its relation', () => {
    // Marked with a claim of another subject, an inferred one, the model's, a rejected one, one
    // not in the result, or a mark the page cannot read; or rejected itself (a value found wrong).
    for (const [model, code] of [
      [{ about: 'cover' }, {}],
      [{ about: 'sample' }, { kind: 'inferred' }],
      [{ about: 'sample' }, { origin: 'model', verdict: 'supported' }],
      [{ about: 'sample' }, { verdict: 'contradicted' }],
      [{ about: 'sample', numericCheck: 'contradicted' }, {}],
      [{ about: 'sample', documentedBy: ['code-9'] }, {}],
      [{ about: 'sample', documentedBy: ['code-1', 'code-9'] }, {}],
      [{ about: 'sample', documentedBy: 'code-1' }, {}],
    ] as const) {
      const words = relationName(model.about, false);
      expect(named({ verdict: 'partial', ...model }, code).listed, JSON.stringify(model)).toBe(
        words,
      );
    }
  });

  it('keeps "Possible" when its records are named so (their links disagree)', () => {
    const shown = resultClaims({
      evidence: PACK,
      claims: [
        claim('code-1', { kind: 'sourced', origin: 'code', evidenceIds: ['ev-mb-1'] }),
        claim('m-1', { evidenceIds: ['ev-mb-1'], documentedBy: ['code-1'], verdict: 'partial' }),
      ],
    } as unknown as TrackData);
    const linked = new Map([['code-1', 'Possible sample']]);
    expect(withDocumentedRelations(linked, shown.all).has('m-1')).toBe(false);
  });

  it('keeps the words of a link that states it', () => {
    const linked = new Map([['m-1', 'Possible remix']]);
    const shown = resultClaims({
      evidence: PACK,
      claims: [
        claim('code-1', { kind: 'sourced', origin: 'code', evidenceIds: ['ev-mb-1'] }),
        claim('m-1', { evidenceIds: ['ev-mb-1'], documentedBy: ['code-1'], verdict: 'partial' }),
      ],
    } as unknown as TrackData);
    expect(withDocumentedRelations(linked, shown.all).get('m-1')).toBe('Possible remix');
  });
});
