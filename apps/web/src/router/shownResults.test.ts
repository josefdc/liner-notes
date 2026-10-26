import { describe, expect, it } from 'vitest';
import type { TrackData } from '../types';
import { SHOWN_RESULTS_LIMIT, ShownResults } from './shownResults';

const track = (id: string) => ({ id, title: id }) as unknown as TrackData;

describe('ShownResults', () => {
  it('keeps the results shown last, up to its limit, dropping the oldest first', () => {
    expect(SHOWN_RESULTS_LIMIT).toBe(20);
    const results = new ShownResults(3);
    for (const id of ['a', 'b', 'c']) results.remember(track(id));
    // Shown again: no longer the oldest.
    results.remember(track('a'));
    results.remember(track('d'));
    expect(results.get('b')).toBeUndefined();
    expect(['a', 'c', 'd'].map((id) => results.get(id)?.id)).toEqual(['a', 'c', 'd']);
  });

  it('holds one result per track, the newest', () => {
    const results = new ShownResults();
    const first = track('a');
    const second = track('a');
    results.remember(first);
    results.remember(second);
    expect(results.get('a')).toBe(second);
  });

  it('never grows past the limit', () => {
    const results = new ShownResults();
    for (let index = 0; index < 50; index++) results.remember(track(`t${index}`));
    expect(results.size).toBe(SHOWN_RESULTS_LIMIT);
    expect(results.get('t29')).toBeUndefined();
    expect(results.get('t30')?.id).toBe('t30');
  });
});
