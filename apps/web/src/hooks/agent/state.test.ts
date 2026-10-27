import { describe, expect, it } from 'vitest';
import type { TrackData } from '../../types';
import { newMoreFacts } from './moreFacts';
import { CHECK_NOTE, RESUME_NOTE } from './progress';
import {
  type AgentAction,
  agentReducer,
  agentStateOf,
  INITIAL_PIECES,
  keptMoreFactsReducer,
} from './state';
import type { AgentState } from './types';

const track = { id: 't1', title: 'Hurt', factoids: [] } as unknown as TrackData;
const candidates = [{ id: 'c1', title: 'Hurt', artist: 'A', album: 'B', coverUrl: '' }];
const log = (message: string) => ({ id: message, message, timestamp: 't' });
const moreFacts = newMoreFacts(track);

/** The state after each action in turn. */
const play = (actions: AgentAction[]) => agentStateOf(actions.reduce(agentReducer, INITIAL_PIECES));

const INITIAL: AgentState = {
  status: 'idle',
  statusNote: null,
  isLoading: false,
  candidates: null,
  trackData: null,
  isComplete: false,
  isReplay: false,
  error: null,
  errorCode: null,
  retryAt: null,
  logs: [],
  moreFacts: null,
};

describe('agentReducer', () => {
  it('starts with nothing shown', () => {
    expect(agentStateOf(INITIAL_PIECES)).toEqual(INITIAL);
  });

  it.each<[string, AgentAction[], Partial<AgentState>]>([
    ['start', [{ type: 'started' }], { status: 'connecting', isLoading: true }],
    [
      'the check',
      [{ type: 'started' }, { type: 'checkStarted' }],
      { status: 'connecting', statusNote: CHECK_NOTE, isLoading: true },
    ],
    [
      'the stream opened',
      [{ type: 'started' }, { type: 'checkStarted' }, { type: 'checkEnded' }, { type: 'opened' }],
      { status: 'searching', isLoading: true },
    ],
    [
      'connected (a log line)',
      [{ type: 'started' }, { type: 'logged', log: log('Connected') }],
      { status: 'connecting', isLoading: true, logs: [{ ...log('Connected'), index: 0 }] },
    ],
    [
      'the picker',
      [{ type: 'started' }, { type: 'pickerOpened', candidates, question: 'Pick' }],
      { status: 'disambiguation', statusNote: 'Pick', candidates },
    ],
    [
      'resume',
      [
        { type: 'started' },
        { type: 'pickerOpened', candidates, question: 'Pick' },
        { type: 'resumed' },
      ],
      { status: 'analyzing', statusNote: RESUME_NOTE, isLoading: true },
    ],
    [
      'done',
      [
        { type: 'started' },
        { type: 'replayNoticed' },
        { type: 'completed', trackData: track, replay: true },
      ],
      { status: 'complete', trackData: track, isComplete: true, isReplay: true },
    ],
    [
      'the rate-limit wait',
      [
        { type: 'started' },
        { type: 'pickerOpened', candidates, question: 'Pick' },
        { type: 'failed', message: 'Slow down', code: 'rate_limited', retryAt: 99 },
      ],
      { status: 'error', error: 'Slow down', errorCode: 'rate_limited', retryAt: 99 },
    ],
    [
      'a more-facts round',
      [
        { type: 'started' },
        { type: 'completed', trackData: track, replay: false },
        { type: 'moreFactsChanged', moreFacts },
      ],
      { status: 'complete', trackData: track, isComplete: true, moreFacts },
    ],
    [
      'a new run lets the last one go, more facts too',
      [
        { type: 'completed', trackData: track, replay: false },
        { type: 'moreFactsChanged', moreFacts },
        { type: 'logged', log: log('a') },
        { type: 'started' },
      ],
      { status: 'connecting', isLoading: true },
    ],
    [
      'cancel (and restore previous) goes back to the start',
      [
        { type: 'started' },
        { type: 'failed', message: 'm', code: 'c', retryAt: 5 },
        { type: 'moreFactsChanged', moreFacts },
        { type: 'reset' },
      ],
      {},
    ],
  ])('%s', (_name, actions, expected) => {
    expect(play(actions)).toEqual({ ...INITIAL, ...expected });
  });

  it('returns the same state when no piece changed', () => {
    const state = agentReducer(INITIAL_PIECES, { type: 'started' });
    expect(agentReducer(state, { type: 'opened' })).not.toBe(state);
    const searching = agentReducer(state, { type: 'opened' });
    expect(agentReducer(searching, { type: 'opened' })).toBe(searching);
    expect(agentReducer(INITIAL_PIECES, { type: 'reset' })).toBe(INITIAL_PIECES);
  });

  it('a log line changes the log and nothing else the page shows', () => {
    const state = agentReducer(INITIAL_PIECES, { type: 'started' });
    const { logs: logsBefore, ...before } = agentStateOf(state);
    const { logs, ...after } = agentStateOf(agentReducer(state, { type: 'logged', log: log('a') }));
    expect(after).toEqual(before);
    expect([logsBefore.length, logs.map((line) => line.message)]).toEqual([0, ['a']]);
  });
});

describe('keptMoreFactsReducer', () => {
  it.each<[string, AgentAction, unknown]>([
    ['keeps what the facts changed to', { type: 'moreFactsChanged', moreFacts }, moreFacts],
    ['lets them go for a new run', { type: 'started' }, null],
    ['lets them go on reset', { type: 'reset' }, null],
    ['keeps them on any other action', { type: 'opened' }, 'kept'],
  ])('%s', (_name, action, expected) => {
    const before = { ...moreFacts, nextRound: 3 };
    const after = keptMoreFactsReducer(before, action);
    expect(after).toBe(expected === 'kept' ? before : expected);
  });
});
