import { describe, expect, it } from 'vitest';
import { isWholeRecording, resultModeOf } from './recording';

describe('recording', () => {
  const recorded = { mode: 'replay', recordedAt: '2026-10-22T14:03:00Z', commit: 'abc1234' };

  it('takes a replay that says when or where it was recorded for a whole recording', () => {
    expect(isWholeRecording(recorded)).toBe(true);
    expect(isWholeRecording({ ...recorded, recordedAt: null })).toBe(true);
    // Model answers from stored test answers: a live run otherwise.
    expect(isWholeRecording({ mode: 'replay', recordedAt: null, commit: null })).toBe(false);
    expect(isWholeRecording({ mode: 'live', recordedAt: null, commit: null })).toBe(false);
    expect(isWholeRecording(undefined)).toBe(false);
  });

  it('keeps more facts of a run whose model answers were stored on the live side', () => {
    expect(resultModeOf(recorded)).toBe('replay');
    expect(resultModeOf({ mode: 'replay', recordedAt: null, commit: null })).toBe('live');
    expect(resultModeOf({ mode: 'live' })).toBe('live');
    expect(resultModeOf(undefined)).toBeUndefined();
  });
});
