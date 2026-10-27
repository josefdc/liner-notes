import { LINK_CLAIM_ABOUT, type LinkType } from '@liner-notes/contract';
import { describe, expect, it } from 'vitest';
import type { Factoid, TrackData } from '../../types';
import { factoidCategory } from '../InteractiveFactoid';
import { resultClaims } from '../provenance/claims';
import {
  LINK_TYPES,
  linkContext,
  readGenealogy,
  relationLabel,
  relationSentence,
  relationToTrack,
} from './links';
import { relationName } from './relationWords';
import { claim, link, node, PACK } from './testing';

// One set of words for a relation wherever it is shown: the graph's line and list, a connected
// track's card on the Dashboard, and a fact's type badge in the Player. For each relation and
// each way it may be known, a link that states a claim and a fact card stating that same claim
// are read from one result, and their words compared.

/** How the link's claim was judged: none of these but `supported` makes the relation known. */
const STATES = [
  { name: 'supported', verdict: 'supported', known: true },
  { name: 'partly supported', verdict: 'partial', known: false },
  { name: 'unsupported', verdict: 'unsupported', known: false },
  { name: 'not checked', verdict: null, known: false },
] as const;

/** The relations a fact's card names as such (the others name their subject). */
const CARD_RELATIONS: ReadonlySet<string> = new Set(['sample', 'cover']);

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
  const [shownLink] = readGenealogy(track.genealogy, linkContext(PACK, shown)).links;
  const fact = { id: 'f', title: 'A fact', content: 'Old Record', type: 'trivia' } as Factoid;
  return {
    link: shownLink,
    card: factoidCategory(fact, shown.byId.get('cl-1')).label,
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

  describe.each(LINK_TYPES)('a link stating a %s relation', (type) => {
    it.each(STATES)(
      'whose claim is $name reads the same on the graph, the card and the fact',
      ({ verdict, known }) => {
        const { link: shown, card } = readOne(type, verdict);
        const words = relationName(type, known);
        expect(shown.kind).toBe(known ? 'sourced' : 'inferred');
        // The Dashboard card's badge, and the graph's line label and its focus detail.
        expect(relationLabel(shown)).toBe(words);
        expect(relationToTrack([shown], 'old', 'current').text).toBe(words);
        // The graph's list and the card's sentence: a hedged documented relation says so.
        const sentence = relationSentence(shown, (id) => id);
        if (!known && type !== 'producer') expect(sentence).toMatch(new RegExp(`^${words}`));
        if (known) expect(sentence).not.toMatch(/^Possible|may/);
        // A fact stating the same claim: the same words where its badge names the relation, and
        // a hedge exactly when the link has one.
        const about = LINK_CLAIM_ABOUT[type][0];
        if (CARD_RELATIONS.has(type)) expect(card).toBe(words.toUpperCase());
        else if (CARD_RELATIONS.has(about)) {
          expect(card).toBe(relationName(about as LinkType, known).toUpperCase());
        } else expect(card).not.toMatch(/POSSIBLE/);
      },
    );
  });
});
