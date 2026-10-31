import { describe, expect, it } from 'vitest';
import type { Factoid, TrackData } from '../../types';
import {
  isNewFact,
  type MoreFactsAction,
  moreFactsReducer,
  moreFactsUrl,
  newMoreFacts,
} from './moreFacts';
import type { MoreFacts } from './types';

const result = {
  id: 't1',
  title: 'Hurt',
  artist: 'NIN',
  factoids: [],
  run: { id: 'run-1' },
} as unknown as TrackData;
const other = { ...result, id: 't2' } as TrackData;
const fact = (id: string) => ({ id, title: id, content: 'c', type: 'trivia' }) as Factoid;
const kept = (change: Partial<MoreFacts> = {}): MoreFacts => ({
  ...newMoreFacts(result),
  ...change,
});
const answer = { facts: 1, failed: 0, refused: false, runId: 'run-1' };

describe('moreFactsReducer', () => {
  it.each<[string, MoreFacts | null, MoreFactsAction, MoreFacts]>([
    ['a round started: before the first answer', null, { type: 'answerStarted', result }, kept()],
    [
      "a round started: the last answer's failures are cleared",
      kept({ failed: [{ index: 0, code: 'failed' }], answerFailed: true }),
      { type: 'answerStarted', result },
      kept(),
    ],
    [
      'a fact is kept',
      kept(),
      { type: 'factReceived', result, factoid: fact('a') },
      kept({ factoids: [fact('a')] }),
    ],
    [
      'a fact with its claim',
      kept(),
      { type: 'factReceived', result, factoid: fact('a'), claim: { id: 'k1' } as never },
      kept({ factoids: [fact('a')], claims: { k1: { id: 'k1' } as never } }),
    ],
    [
      'a fact that could not be written',
      kept(),
      { type: 'factFailed', result, failure: { index: 2, code: 'failed' } },
      kept({ failed: [{ index: 2, code: 'failed' }] }),
    ],
    [
      'a round finished: the next one is asked next',
      kept(),
      { type: 'answerEnded', result, answer: { ...answer, nextRound: 1, roundsLeft: true } },
      kept({ nextRound: 1, runId: 'run-1' }),
    ],
    [
      'the last round finished: no more requests',
      kept(),
      { type: 'answerEnded', result, answer: { ...answer, nextRound: 2, roundsLeft: false } },
      kept({ nextRound: 2, finished: true, runId: 'run-1' }),
    ],
    [
      'a round refused: it is asked again',
      kept(),
      { type: 'answerEnded', result, answer: { ...answer, refused: true, nextRound: 1 } },
      kept({ runId: 'run-1' }),
    ],
    [
      'a round partly refused: only the facts that failed are asked again',
      kept({
        factoids: [fact('a')],
        failed: [
          { index: 2, code: 'rate_limited' },
          { index: 1, code: 'rate_limited' },
        ],
      }),
      { type: 'answerEnded', result, answer: { ...answer, refused: true, nextRound: 1 } },
      kept({
        factoids: [fact('a')],
        failed: [
          { index: 2, code: 'rate_limited' },
          { index: 1, code: 'rate_limited' },
        ],
        failedIndexes: [1, 2],
        runId: 'run-1',
      }),
    ],
    [
      'a round whose every fact failed: they are all asked again',
      kept({ failed: [0, 1, 2].map((index) => ({ index, code: 'failed' })) }),
      { type: 'answerEnded', result, answer: { ...answer, facts: 0, failed: 3, nextRound: 1 } },
      kept({
        failed: [0, 1, 2].map((index) => ({ index, code: 'failed' })),
        failedIndexes: [0, 1, 2],
        runId: 'run-1',
      }),
    ],
    [
      'a round asked again that was refused before any fact: the same facts are left to ask',
      kept({ failedIndexes: [1, 2] }),
      { type: 'answerEnded', result, answer: { ...answer, facts: 0, refused: true, nextRound: 1 } },
      kept({ failedIndexes: [1, 2], runId: 'run-1' }),
    ],
    [
      'a round asked again that was written: the next round is asked whole',
      kept({ failedIndexes: [2] }),
      { type: 'answerEnded', result, answer: { ...answer, nextRound: 1, roundsLeft: true } },
      kept({ nextRound: 1, runId: 'run-1' }),
    ],
    [
      'an answer that failed as a whole',
      kept(),
      { type: 'answerFailed', result },
      kept({ answerFailed: true }),
    ],
    [
      'no token for the round',
      kept({ failed: [{ index: 0, code: 'failed' }] }),
      { type: 'tokenRefused', result },
      kept({ answerFailed: true }),
    ],
    [
      "another result's facts are let go",
      { ...newMoreFacts(other), factoids: [fact('z')] },
      { type: 'factReceived', result, factoid: fact('a') },
      kept({ factoids: [fact('a')] }),
    ],
  ])('%s', (_name, before, action, expected) => {
    expect(moreFactsReducer(before, action)).toEqual(expected);
  });

  it('keeps a fact it has once, and the same object', () => {
    const before = kept({ factoids: [fact('a')] });
    expect(moreFactsReducer(before, { type: 'factReceived', result, factoid: fact('a') })).toBe(
      before,
    );
  });
});

describe('moreFactsUrl', () => {
  const token = { runToken: 'tok', expiresAt: Number.MAX_SAFE_INTEGER };
  const params = (moreFacts: MoreFacts) =>
    new URL(moreFactsUrl(result, moreFacts, token), 'http://x').searchParams;

  it('names the facts to ask again only when there are some', () => {
    expect(params(kept({ failedIndexes: [1, 2] })).get('failedIndexes')).toBe('1,2');
    expect(params(kept()).has('failedIndexes')).toBe(false);
  });
});

describe('isNewFact', () => {
  it('is true only for a fact this result does not have yet', () => {
    const facts = kept({ factoids: [fact('a')] });
    expect(isNewFact(facts, result, fact('a'))).toBe(false);
    expect(isNewFact(facts, result, fact('b'))).toBe(true);
    expect(isNewFact(facts, other, fact('a'))).toBe(true);
    expect(isNewFact(null, result, fact('a'))).toBe(true);
  });
});
