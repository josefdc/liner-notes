import { describe, expect, it } from 'vitest';
import type { Factoid, TrackData } from '../../types';
import {
  isNewFact,
  type MoreFactsAction,
  type MoreFactsAnswer,
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
/** An answer to a whole round that wrote angle 0 and named nothing else. */
const answer: MoreFactsAnswer = {
  connected: true,
  facts: 1,
  refused: false,
  runId: 'run-1',
  asked: [0, 1, 2],
  written: [0],
  unplaced: 0,
  failedAt: [],
  refusedAt: [],
  wholeError: null,
};
const busy = (...indexes: number[]) =>
  indexes.map((index) => ({ index, code: 'rate_limited' as const }));

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
      'a round refused as a whole: it is asked again whole',
      kept(),
      {
        type: 'answerEnded',
        result,
        answer: {
          ...answer,
          facts: 0,
          written: [],
          refused: true,
          wholeError: 'failed',
          nextRound: 1,
        },
      },
      kept({ runId: 'run-1' }),
    ],
    [
      'a round partly refused: only the facts that failed are asked again',
      kept({ factoids: [fact('a')], failed: busy(2, 1) }),
      {
        type: 'answerEnded',
        result,
        answer: { ...answer, failedAt: [2, 1], refusedAt: [2, 1], refused: true, nextRound: 1 },
      },
      kept({ factoids: [fact('a')], failed: busy(2, 1), failedIndexes: [1, 2], runId: 'run-1' }),
    ],
    [
      'a round whose every fact failed: it is asked again whole',
      kept({ failed: [0, 1, 2].map((index) => ({ index, code: 'failed' })) }),
      {
        type: 'answerEnded',
        result,
        answer: { ...answer, facts: 0, written: [], failedAt: [0, 1, 2], nextRound: 1 },
      },
      kept({ failed: [0, 1, 2].map((index) => ({ index, code: 'failed' })), runId: 'run-1' }),
    ],
    [
      'a round asked again that was refused before any fact: the same facts are left to ask',
      kept({ failedIndexes: [1, 2] }),
      {
        type: 'answerEnded',
        result,
        answer: {
          ...answer,
          asked: [1, 2],
          facts: 0,
          written: [],
          refused: true,
          wholeError: 'failed',
          nextRound: 1,
        },
      },
      kept({ failedIndexes: [1, 2], runId: 'run-1' }),
    ],
    [
      'a round asked again that was written: the next round is asked whole',
      kept({ failedIndexes: [2] }),
      {
        type: 'answerEnded',
        result,
        answer: { ...answer, asked: [2], written: [2], nextRound: 1, roundsLeft: true },
      },
      kept({ nextRound: 1, runId: 'run-1' }),
    ],
    [
      'failures, then an error for the whole answer: every angle not written is left',
      kept({ failed: busy(1) }),
      {
        type: 'answerEnded',
        result,
        answer: {
          ...answer,
          failedAt: [1],
          refusedAt: [1],
          refused: true,
          wholeError: 'failed',
          nextRound: 1,
        },
      },
      kept({ failed: busy(1), failedIndexes: [1, 2], runId: 'run-1' }),
    ],
    [
      'an older API that asked every angle again: only the angles asked that failed are left',
      kept({ failedIndexes: [1, 2], failed: busy(1) }),
      {
        type: 'answerEnded',
        result,
        answer: {
          ...answer,
          asked: [1, 2],
          facts: 2,
          written: [],
          unplaced: 2,
          failedAt: [1],
          refusedAt: [1],
          refused: true,
          nextRound: 1,
        },
      },
      kept({ failedIndexes: [1], failed: busy(1), runId: 'run-1' }),
    ],
    [
      'an older API whose only failure is an angle not asked: the round moves on',
      kept({ failedIndexes: [1, 2], failed: busy(0) }),
      {
        type: 'answerEnded',
        result,
        answer: {
          ...answer,
          asked: [1, 2],
          facts: 2,
          written: [],
          unplaced: 2,
          failedAt: [0],
          refusedAt: [0],
          refused: true,
          nextRound: 1,
          roundsLeft: true,
        },
      },
      kept({ failed: busy(0), nextRound: 1, runId: 'run-1' }),
    ],
    [
      'a recorded answer after a partly failed one: no angle is named',
      kept({ failedIndexes: [1, 2] }),
      { type: 'answerEnded', result, answer: { ...answer, written: [], unplaced: 1 } },
      kept({ runId: 'run-1' }),
    ],
    [
      'a stream that broke after a fact: the angles not written are left',
      kept({ factoids: [fact('a')] }),
      { type: 'answerStopped', result, answer: { ...answer, nextRound: 1 } },
      kept({ factoids: [fact('a')], failedIndexes: [1, 2] }),
    ],
    [
      'a round asked again and left after one of its facts: the other is left',
      kept({ failedIndexes: [1, 2] }),
      { type: 'answerStopped', result, answer: { ...answer, asked: [1, 2], written: [1] } },
      kept({ failedIndexes: [2] }),
    ],
    [
      'a stream that broke after every angle asked was written: the round moves on',
      kept({ failedIndexes: [1, 2] }),
      {
        type: 'answerStopped',
        result,
        answer: { ...answer, asked: [1, 2], written: [1, 2], nextRound: 1, roundsLeft: true },
      },
      kept({ nextRound: 1, runId: 'run-1' }),
    ],
    [
      'a round asked again that broke before any fact: the same angles are left',
      kept({ failedIndexes: [1, 2] }),
      {
        type: 'answerStopped',
        result,
        answer: { ...answer, asked: [1, 2], facts: 0, written: [], nextRound: 1 },
      },
      kept({ failedIndexes: [1, 2] }),
    ],
    [
      'a stream that broke after facts with no index: the angles asked are left',
      kept({ failedIndexes: [1, 2] }),
      {
        type: 'answerStopped',
        result,
        answer: { ...answer, asked: [1, 2], written: [], unplaced: 1, nextRound: 1 },
      },
      kept({ failedIndexes: [1, 2] }),
    ],
    [
      'a round asked again and refused before connected: the same angles are left',
      kept({ failedIndexes: [1, 2] }),
      {
        type: 'answerEnded',
        result,
        answer: {
          ...answer,
          connected: false,
          asked: [1, 2],
          facts: 0,
          written: [],
          refused: true,
          wholeError: 'budget_exhausted',
        },
      },
      kept({ failedIndexes: [1, 2], runId: 'run-1' }),
    ],
    [
      'a round asked again and refused as invalid input: the round is asked whole',
      kept({ failedIndexes: [1, 2] }),
      {
        type: 'answerEnded',
        result,
        answer: {
          ...answer,
          connected: false,
          asked: [1, 2],
          facts: 0,
          written: [],
          refused: true,
          wholeError: 'invalid_input',
        },
      },
      kept({ runId: 'run-1' }),
    ],
    [
      'a round asked again whose every angle failed with `failed`: the round moves on',
      kept({ failedIndexes: [1, 2] }),
      {
        type: 'answerEnded',
        result,
        answer: {
          ...answer,
          asked: [1, 2],
          facts: 0,
          written: [],
          failedAt: [1, 2],
          nextRound: 1,
          roundsLeft: true,
        },
      },
      kept({ nextRound: 1, runId: 'run-1' }),
    ],
    [
      'a round asked again with one refusal and one `failed`: only the refusal is left',
      kept({ failedIndexes: [1, 2] }),
      {
        type: 'answerEnded',
        result,
        answer: {
          ...answer,
          asked: [1, 2],
          facts: 0,
          written: [],
          failedAt: [1, 2],
          refusedAt: [1],
          refused: true,
          nextRound: 1,
        },
      },
      kept({ failedIndexes: [1], runId: 'run-1' }),
    ],
    [
      'a stream that stopped after every angle asked was written: the answer is not failed',
      kept({ failedIndexes: [1, 2], answerFailed: true }),
      {
        type: 'answerStopped',
        result,
        answer: { ...answer, asked: [1, 2], written: [1, 2], nextRound: 1, roundsLeft: true },
      },
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
