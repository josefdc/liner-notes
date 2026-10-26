import { describe, expect, it } from 'vitest';
import type { AgentStatus } from '../../hooks/agent/types';
import { ANALYZING_STATUSES, nextProgress, preloadsResults, progressFor } from './progress';

describe('progress', () => {
  it.each([
    'searching',
    'disambiguation',
    'analyzing',
    'measuring',
    'researching',
    'composing',
    'checking',
  ] as const)('keeps the progress screen up while the run is %s', (status) => {
    expect(ANALYZING_STATUSES.has(status)).toBe(true);
  });

  it.each(['idle', 'complete', 'error'] as const)('is not analysing when %s', (status) => {
    expect(ANALYZING_STATUSES.has(status)).toBe(false);
  });

  it('places each step in order, the check between composing and done', () => {
    const order: AgentStatus[] = [
      'idle',
      'connecting',
      'searching',
      'analyzing',
      'researching',
      'composing',
      'checking',
      'complete',
    ];
    const values = order.map(progressFor);
    expect(values).toEqual([0, 10, 25, 50, 70, 90, 95, 100]);
    expect(progressFor('measuring')).toBe(progressFor('analyzing'));
    expect(progressFor('disambiguation')).toBe(progressFor('searching'));
  });

  it('never moves the bar back within a run', () => {
    let shown = 0;
    for (const status of ['connecting', 'searching', 'researching', 'analyzing'] as const) {
      shown = nextProgress(shown, status);
    }
    expect(shown).toBe(70);
    shown = nextProgress(shown, 'composing');
    expect(shown).toBe(90);
  });

  it('starts again from the bottom for a new run', () => {
    expect(nextProgress(100, 'connecting')).toBe(10);
    expect(nextProgress(70, 'idle')).toBe(0);
    expect(nextProgress(70, 'error')).toBe(0);
  });

  it('preloads the result views while the notes are written and checked', () => {
    expect(preloadsResults('composing')).toBe(true);
    expect(preloadsResults('checking')).toBe(true);
    expect(preloadsResults('researching')).toBe(false);
  });
});
