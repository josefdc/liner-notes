import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentLog } from '../types';
import ActivityLog, { FRESH_TICK_MS, formatRelativeTime, SETTLED_TICK_MS } from './ActivityLog';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const log = (code: AgentLog['code'], id = String(code)): AgentLog => ({
  id,
  message: `Message for ${code}`,
  timestamp: '2026-01-01T00:00:00.000Z',
  code,
});

const LOGS = [
  log('SPOTIFY-SEARCH'),
  log('AUDIO-INIT'),
  log('RESEARCH-START'),
  log('GRAPH-ENRICH'),
  log('SYS-WARN'),
  log('LLM-CONNECT'),
];

/** The label of the entry with this code. */
const labelOf = (container: HTMLElement, code: string) =>
  container.querySelector(`[data-log-code="${code}"] [data-log-label]`) as HTMLElement;

describe('ActivityLog', () => {
  it.each([false, true])(
    'uses neither the measured cyan nor the sourced amber (complete: %s)',
    (isComplete) => {
      const { container } = render(<ActivityLog logs={LOGS} isComplete={isComplete} />);
      fireEvent.click(screen.getByRole('button', { name: /activity log/ }));
      expect(container.innerHTML).not.toMatch(/cyber|analog|amber/);
    },
  );

  it('labels every entry in words with an icon, coloured only for a warning, an error or a model step', () => {
    const { container } = render(
      <ActivityLog logs={[...LOGS.slice(1), log('AUDIO-ERROR')]} isComplete />,
    );
    const expected = {
      'AUDIO-INIT': ['Audio', 'text-text-tertiary'],
      'RESEARCH-START': ['Sources', 'text-text-tertiary'],
      'GRAPH-ENRICH': ['Graph', 'text-text-tertiary'],
      'SYS-WARN': ['System warning', 'text-status-warning'],
      'LLM-CONNECT': ['Model', 'text-prov-inferred'],
      'AUDIO-ERROR': ['Audio warning', 'text-status-warning'],
    };
    for (const [code, [word, tone]] of Object.entries(expected)) {
      const label = labelOf(container, code);
      expect(label.textContent, code).toBe(word);
      expect(label.className, code).toContain(tone);
      expect(label.querySelector('svg'), code).not.toBeNull();
    }
  });

  it('says how many events it shows, in plain words', () => {
    const many = Array.from({ length: 8 }, (_, i) => log('SYS-INIT', `e${i}`));
    render(<ActivityLog logs={many} isComplete />);
    expect(screen.getByText('The latest 6 of 8 events')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/EVENTS RECORDED|IDLE|ACTIVE|AWAITING DATA/);
  });

  it('says whether the run is going or done', () => {
    const { rerender } = render(<ActivityLog logs={LOGS} isComplete={false} />);
    expect(screen.getByText('Running')).toBeTruthy();
    rerender(<ActivityLog logs={LOGS} isComplete />);
    expect(screen.getByText('Done')).toBeTruthy();
  });
  it("names the run's state and the last event's label in the toggle's accessible name", () => {
    const { rerender } = render(<ActivityLog logs={[log('AUDIO-ERROR')]} isComplete={false} />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
      'Expand activity log, running, last event: Audio warning: Message for AUDIO-ERROR',
    );
    rerender(<ActivityLog logs={[log('AUDIO-ERROR')]} isComplete />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(
      /^Expand activity log, done, last event: Audio warning: /,
    );
  });

  it('counts the lines the run log no longer keeps among its events', () => {
    const kept = Array.from({ length: 8 }, (_, i) => ({
      ...log('SYS-INIT', `k${i}`),
      index: i + 40,
    }));
    render(<ActivityLog logs={kept} isComplete />);
    expect(screen.getByText('The latest 6 of 48 events')).toBeTruthy();
  });

  it('says how long ago an entry was logged, no finer than its clock', () => {
    const at = Date.parse('2026-01-01T00:00:00.000Z');
    const when = '2026-01-01T00:00:00.000Z';
    expect(formatRelativeTime(when, at + 9_000)).toBe('Just now');
    expect(formatRelativeTime(when, at + 10_000)).toBe('10 s ago');
    expect(formatRelativeTime(when, at + 38_000)).toBe('30 s ago');
    expect(formatRelativeTime(when, at + 59_000)).toBe('50 s ago');
    expect(formatRelativeTime(when, at + 60_000)).toBe('1 min ago');
    expect(formatRelativeTime(when, at + 59 * 60_000)).toBe('59 min ago');
    expect(formatRelativeTime(when, at + 2 * 3_600_000)).toBe('2 h ago');
    expect(formatRelativeTime('not a time', at)).toBe('Just now');
    expect([FRESH_TICK_MS, SETTLED_TICK_MS]).toEqual([10_000, 30_000]);
  });

  it('keeps the time between the entries of a run visible: steps of 10 s under a minute', () => {
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    vi.useFakeTimers({ now: start + 25_000 });
    // A run's entries, logged 25, 12 and 0 seconds before the log is opened.
    const entries = [25_000, 12_000, 0].map((ago, i) => ({
      ...log('SYS-INIT', `r${i}`),
      timestamp: new Date(start + 25_000 - ago).toISOString(),
    }));
    render(<ActivityLog logs={entries} isComplete />);
    fireEvent.click(screen.getByRole('button', { name: /activity log/ }));
    expect(screen.getByText('20 s ago')).toBeTruthy();
    expect(screen.getByText('10 s ago')).toBeTruthy();
    expect(screen.getByText('Just now')).toBeTruthy();
  });

  it('brings the times up to date on one clock: every 10 s under a minute, every 30 s after', () => {
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    vi.useFakeTimers({ now: start });
    const every = vi.spyOn(globalThis, 'setInterval');
    const entries = Array.from({ length: 6 }, (_, i) => ({
      ...log('SYS-INIT', `t${i}`),
      timestamp: new Date(start).toISOString(),
    }));
    render(<ActivityLog logs={entries} isComplete />);
    // Closed, it keeps no clock.
    expect(vi.getTimerCount()).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: /activity log/ }));
    // One clock for all six entries, ticking every 10 s while they are under a minute old.
    expect(vi.getTimerCount()).toBe(1);
    expect(every.mock.calls.at(-1)?.[1]).toBe(FRESH_TICK_MS);
    expect(screen.getAllByText('Just now')).toHaveLength(6);

    act(() => vi.advanceTimersByTime(FRESH_TICK_MS - 1));
    expect(screen.getAllByText('Just now')).toHaveLength(6);
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getAllByText('10 s ago')).toHaveLength(6);
    act(() => vi.advanceTimersByTime(4 * FRESH_TICK_MS));
    expect(screen.getAllByText('50 s ago')).toHaveLength(6);
    act(() => vi.advanceTimersByTime(FRESH_TICK_MS));
    expect(screen.getAllByText('1 min ago')).toHaveLength(6);

    // A minute old: still one clock, now every 30 s.
    expect(vi.getTimerCount()).toBe(1);
    expect(every.mock.calls.at(-1)?.[1]).toBe(SETTLED_TICK_MS);
    act(() => vi.advanceTimersByTime(SETTLED_TICK_MS * 2));
    expect(screen.getAllByText('2 min ago')).toHaveLength(6);

    fireEvent.click(screen.getByRole('button', { name: /activity log/ }));
    expect(vi.getTimerCount()).toBe(0);
  });
});
