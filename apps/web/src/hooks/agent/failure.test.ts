import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_RETRY_WAIT_MS, RunTokenError } from './apiClient';
import {
  CLIENT_ERROR_CODES,
  type FailureState,
  failureReducer,
  INITIAL_FAILURE,
  tokenFailure,
  waitKeeper,
} from './failure';
import type { AgentAction } from './state';

const failed = (code: string | null, retryAt: number | null = null): AgentAction => ({
  type: 'failed',
  message: `failed: ${code}`,
  code,
  retryAt,
});

describe('failureReducer', () => {
  it.each<[string, FailureState, AgentAction, FailureState]>([
    [
      'an error keeps its words and code',
      INITIAL_FAILURE,
      failed('timeout'),
      { error: 'failed: timeout', errorCode: 'timeout', retryAt: null },
    ],
    [
      'a refused stream',
      INITIAL_FAILURE,
      failed(CLIENT_ERROR_CODES.streamRefused),
      { error: 'failed: stream_refused', errorCode: 'stream_refused', retryAt: null },
    ],
    [
      'auth_expired',
      INITIAL_FAILURE,
      failed('auth_expired'),
      { error: 'failed: auth_expired', errorCode: 'auth_expired', retryAt: null },
    ],
    [
      'the rate-limit wait keeps until when',
      INITIAL_FAILURE,
      failed('rate_limited', 1234),
      { error: 'failed: rate_limited', errorCode: 'rate_limited', retryAt: 1234 },
    ],
    [
      'an error without a code',
      INITIAL_FAILURE,
      failed(null),
      { error: 'failed: null', errorCode: null, retryAt: null },
    ],
    [
      'a second error replaces the first',
      { error: 'a', errorCode: 'b', retryAt: 9 },
      failed('c'),
      { error: 'failed: c', errorCode: 'c', retryAt: null },
    ],
    [
      'start lets the error go',
      { error: 'a', errorCode: 'b', retryAt: 9 },
      { type: 'started' },
      INITIAL_FAILURE,
    ],
    [
      'cancel lets the error go',
      { error: 'a', errorCode: 'b', retryAt: 9 },
      { type: 'reset' },
      INITIAL_FAILURE,
    ],
  ])('%s', (_name, before, action, expected) => {
    expect(failureReducer(before, action)).toEqual(expected);
  });

  it.each<[string, AgentAction]>([
    ['a step', { type: 'stepReported', step: { status: 'analyzing' } }],
    ['a resume', { type: 'resumed' }],
    ['a result', { type: 'completed', trackData: {} as never, replay: false }],
  ])('changes nothing for %s', (_name, action) => {
    const before: FailureState = { error: 'a', errorCode: 'b', retryAt: null };
    expect(failureReducer(before, action)).toBe(before);
  });
});

describe('tokenFailure', () => {
  it("keeps the API's refusal, with its wait", () => {
    expect(tokenFailure(new RunTokenError('Slow down', 'rate_limited', 5000), 'x')).toEqual({
      message: 'Slow down',
      code: 'rate_limited',
      retryAfterMs: 5000,
    });
  });

  it('gives an answer it cannot read the code asked for', () => {
    expect(tokenFailure(new RunTokenError('Unreadable', null), 'stream_open_failed')).toEqual({
      message: 'Unreadable',
      code: 'stream_open_failed',
    });
  });

  it('reads anything else as a lost connection', () => {
    expect(tokenFailure(new TypeError('Failed to fetch'), 'x')).toEqual({
      message: 'Failed to fetch',
      code: CLIENT_ERROR_CODES.connectionLost,
    });
    expect(tokenFailure('nope', 'x').message).toBe('Connection failed');
  });
});

describe('waitKeeper', () => {
  afterEach(() => vi.useRealTimers());

  it('holds requests back until the wait is over', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const waits = waitKeeper();
    expect(waits.waiting()).toBeNull();
    expect(waits.holdOff(5000, 'Slow down', 'rate_limited')).toBe(1_005_000);
    expect(waits.waiting()).toEqual({
      until: 1_005_000,
      message: 'Slow down',
      code: 'rate_limited',
    });
    vi.advanceTimersByTime(5000);
    expect(waits.waiting()).toBeNull();
  });

  it('keeps the later of two waits', () => {
    vi.useFakeTimers({ now: 0 });
    const waits = waitKeeper();
    waits.holdOff(10_000, 'long', 'a');
    expect(waits.holdOff(1000, 'short', 'b')).toBe(10_000);
    expect(waits.waiting()?.message).toBe('long');
    expect(waits.holdOff(20_000, 'longer', null)).toBe(20_000);
    expect(waits.waiting()).toEqual({ until: 20_000, message: 'longer', code: null });
  });

  it('waits at most MAX_RETRY_WAIT_MS', () => {
    vi.useFakeTimers({ now: 0 });
    expect(waitKeeper().holdOff(MAX_RETRY_WAIT_MS * 10, 'm', null)).toBe(MAX_RETRY_WAIT_MS);
  });
});
