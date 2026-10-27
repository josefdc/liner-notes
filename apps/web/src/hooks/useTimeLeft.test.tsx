import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spokenWait, useTimeLeft, waitText } from './useTimeLeft';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useTimeLeft', () => {
  it('re-renders about once a second while a wait runs, not more', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-10-27T12:00:00.000Z');
    vi.setSystemTime(now);
    let renders = 0;
    const shown: number[] = [];
    function Countdown({ until }: { until: number }) {
      renders++;
      const left = useTimeLeft(until);
      shown.push(left);
      return null;
    }
    render(<Countdown until={now + 10_500} />);
    const before = renders;
    // In steps of 100 ms, each flushed on its own (one act would batch every update into one
    // render).
    const advance = (ms: number) => {
      for (let step = 0; step < ms / 100; step++) {
        act(() => {
          vi.advanceTimersByTime(100);
        });
      }
    };
    advance(10_000);
    // One update per whole second left (10.5 s: at 0.5 s, then every second), give or take one.
    expect(renders - before).toBeGreaterThanOrEqual(10);
    expect(renders - before).toBeLessThanOrEqual(12);
    advance(5_000);
    // Over: no more updates.
    expect(shown[shown.length - 1]).toBe(0);
    expect(renders - before).toBeLessThanOrEqual(13);
  });

  it('reads the clock on the first render for a new wait', () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-27T12:00:00.000Z');
    vi.setSystemTime(start);
    const firstRender: Array<number | null> = [];
    function Countdown({ until }: { until: number | null }) {
      const left = useTimeLeft(until);
      if (firstRender.length === 0 || until !== null) firstRender.push(left);
      return null;
    }
    const view = render(<Countdown until={null} />);
    // Two minutes later (no wait was running, so no update came meanwhile), a 30 s wait.
    vi.setSystemTime(start + 120_000);
    view.rerender(<Countdown until={start + 150_000} />);
    expect(firstRender[1]).toBe(30_000);
  });
});

describe('waits as said', () => {
  it('shows short units and says them in words', () => {
    const cases: Array<[number, string, string]> = [
      [1, '1 s', '1 second'],
      [42_000, '42 s', '42 seconds'],
      [60_000, '1 min', '1 minute'],
      [125_000, '2 min 5 s', '2 minutes 5 seconds'],
      [61_000, '1 min 1 s', '1 minute 1 second'],
      [60 * 60_000, '1 h', '1 hour'],
      [65 * 60_000, '1 h 5 min', '1 hour 5 minutes'],
      [2 * 60 * 60_000 + 60_000, '2 h 1 min', '2 hours 1 minute'],
      [86_400_000, '24 h', '24 hours'],
    ];
    for (const [ms, shown, spoken] of cases) {
      expect([waitText(ms), spokenWait(ms)]).toEqual([shown, spoken]);
    }
    expect(spokenWait(Number.POSITIVE_INFINITY)).toBe('a while');
  });
});
