import { describe, expect, it } from 'vitest';
import type { TrackData } from '../../types';
import { INITIAL_RESULT, type ResultState, resultReducer } from './result';
import type { AgentAction } from './state';
import type { SearchCandidate } from './types';

const candidates: SearchCandidate[] = [
  { id: 'c1', title: 'Hurt', artist: 'Johnny Cash', album: 'A', coverUrl: '' },
];
const track = { id: 'c1', title: 'Hurt' } as TrackData;
const shown = (change: Partial<ResultState>): ResultState => ({ ...INITIAL_RESULT, ...change });
const failed: AgentAction = { type: 'failed', message: 'm', code: null, retryAt: null };

describe('resultReducer', () => {
  it.each<[string, ResultState, AgentAction, ResultState]>([
    [
      'start lets the last result go',
      shown({ trackData: track, isComplete: true }),
      { type: 'started' },
      INITIAL_RESULT,
    ],
    [
      'a replay notice marks the run a replay',
      INITIAL_RESULT,
      { type: 'replayNoticed' },
      shown({ isReplay: true }),
    ],
    [
      'the picker shows its candidates',
      INITIAL_RESULT,
      { type: 'pickerOpened', candidates, question: 'q' },
      shown({ candidates }),
    ],
    ['a resume closes the picker', shown({ candidates }), { type: 'resumed' }, INITIAL_RESULT],
    [
      'done: the result is shown, the picker closed',
      shown({ candidates }),
      { type: 'completed', trackData: track, replay: false },
      shown({ trackData: track, isComplete: true }),
    ],
    [
      'a replayed result says so',
      INITIAL_RESULT,
      { type: 'completed', trackData: track, replay: true },
      shown({ trackData: track, isComplete: true, isReplay: true }),
    ],
    [
      'a live result clears an earlier replay notice',
      shown({ isReplay: true }),
      { type: 'completed', trackData: track, replay: false },
      shown({ trackData: track, isComplete: true }),
    ],
    [
      'an error closes the picker',
      shown({ candidates, isReplay: true }),
      failed,
      shown({ isReplay: true }),
    ],
    [
      'cancel lets everything go',
      shown({ trackData: track, isComplete: true }),
      { type: 'reset' },
      INITIAL_RESULT,
    ],
  ])('%s', (_name, before, action, expected) => {
    expect(resultReducer(before, action)).toEqual(expected);
  });

  it.each<[string, AgentAction]>([
    ['a step', { type: 'stepReported', step: { status: 'analyzing' } }],
    ['a log line', { type: 'logged', log: { id: 'l', message: 'm', timestamp: 't' } }],
    ['the stream opening', { type: 'opened' }],
    ['the check', { type: 'checkStarted' }],
  ])('changes nothing for %s', (_name, action) => {
    const before = shown({ candidates });
    expect(resultReducer(before, action)).toBe(before);
  });

  it('keeps the start state for a new run', () => {
    expect(resultReducer(INITIAL_RESULT, { type: 'started' })).toBe(INITIAL_RESULT);
  });
});
