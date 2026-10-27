import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentLog } from '../types';
import SystemConsole from './SystemConsole';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const log = (code: AgentLog['code'], node?: string): AgentLog => ({
  id: `${code}-${node}`,
  message: 'Composing the liner notes...',
  timestamp: '2026-01-01T00:00:00.000Z',
  code,
  node,
});

/** The step label of the first log line. */
const label = (container: HTMLElement) =>
  container.querySelector('[data-log-label]') as HTMLElement;

describe('SystemConsole', () => {
  it.each(['LLM-CONNECT', 'LLM-RESPONSE', 'GEMINI-CONNECT'] as const)(
    'colours the model code %s as a model step',
    (code) => {
      const { container } = render(<SystemConsole logs={[log(code)]} isComplete />);
      expect(label(container).textContent).toBe('Model');
      expect(label(container).className).toContain('text-prov-inferred');
    },
  );

  it.each([
    ['NET-200', 'Network'],
    ['AUDIO-INIT', 'Audio'],
    ['RESEARCH-START', 'Sources'],
    ['GRAPH-ENRICH', 'Graph'],
    ['SPOTIFY-SEARCH', 'Spotify'],
    ['SYS-INIT', 'System'],
  ] as const)('labels %s in plain words, in the neutral grey, with an icon', (code, word) => {
    const { container } = render(<SystemConsole logs={[log(code)]} isComplete={false} />);
    expect(label(container).textContent).toBe(word);
    expect(label(container).className).toContain('text-text-tertiary');
    expect(label(container).querySelector('svg')).not.toBeNull();
  });

  it.each([
    ['SYS-WARN', 'System warning', 'text-status-warning'],
    ['AUDIO-ERROR', 'Audio warning', 'text-status-warning'],
    ['LLM-ERROR', 'Model error', 'text-status-error'],
  ] as const)('labels %s as "%s" in its status colour', (code, word, tone) => {
    const { container } = render(<SystemConsole logs={[log(code)]} isComplete />);
    expect(label(container).textContent).toBe(word);
    expect(label(container).className).toContain(tone);
  });

  it('shows no raw [CODE] prefix', () => {
    render(<SystemConsole logs={[log('SPOTIFY-SEARCH')]} isComplete />);
    expect(screen.getByRole('log').textContent).not.toMatch(/\[[A-Z]+-[A-Z0-9]+\]/);
  });

  it.each([false, true])(
    'uses neither the measured cyan nor the sourced amber (complete: %s)',
    (isComplete) => {
      const { container } = render(
        <SystemConsole
          logs={[log('NET-200'), log('AUDIO-INIT'), log('RESEARCH-START'), log('GRAPH-BUILD')]}
          isComplete={isComplete}
        />,
      );
      expect(container.innerHTML).not.toMatch(/cyber|analog|amber/);
    },
  );

  it('has no mock window controls and no CRT scanlines', () => {
    const { container } = render(<SystemConsole logs={[log('SYS-INIT')]} isComplete={false} />);
    expect(container.querySelector('[title]')).toBeNull();
    expect(container.querySelector('.crt-scanlines')).toBeNull();
  });

  it('says plainly whether the run is going or finished', () => {
    const { rerender } = render(<SystemConsole logs={[log('SYS-INIT')]} isComplete={false} />);
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('Run in progress')).toBeTruthy();
    rerender(<SystemConsole logs={[log('SYS-INIT')]} isComplete />);
    expect(screen.getByText('Finished')).toBeTruthy();
    expect(screen.getByText('Run finished')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/sonic-agent|UPLINK|PROCESSING_DATA|ONLINE|BUSY/);
  });

  it("labels the verifier's line as a check", () => {
    const { container } = render(
      <SystemConsole logs={[log('LLM-RESPONSE', 'verifier')]} isComplete={false} />,
    );
    expect(label(container).textContent).toBe('Model check');
  });
  it('says it waits for a pick while the run is paused at the picker', () => {
    render(<SystemConsole logs={[log('SYS-INIT')]} isComplete={false} isWaiting />);
    expect(screen.getAllByText('Waiting for your pick').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/Running|Run in progress/);
  });

  it('says it replays the recorded run during a replay', () => {
    render(<SystemConsole logs={[log('SYS-INIT')]} isComplete={false} isReplay />);
    expect(screen.getAllByText('Replaying the recorded run').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/Running|Run in progress/);
  });

  it('says what the elapsed time counts', () => {
    render(<SystemConsole logs={[log('SYS-INIT')]} isComplete={false} />);
    expect(screen.getByText(/s since you started$/)).toBeTruthy();
  });

  it('labels a line without a code by the node that sent it', () => {
    const { container } = render(
      <SystemConsole logs={[log(undefined, 'research_tool')]} isComplete={false} />,
    );
    expect(label(container).textContent).toBe('Sources');
  });

  it('says how many earlier lines the log no longer shows, and counts them as events', () => {
    const kept = Array.from({ length: 3 }, (_, n) => ({
      ...log('SYS-INIT'),
      id: `kept-${n}`,
      message: `Line ${n + 12}`,
      index: n + 12,
    }));
    const { container } = render(<SystemConsole logs={kept} isComplete={false} />);
    expect(container.querySelector('[data-log-dropped]')?.textContent).toBe(
      '12 earlier lines not shown',
    );
    expect(screen.getByText('15 events')).toBeTruthy();
  });

  it('says nothing was left out of a whole log', () => {
    const { container } = render(<SystemConsole logs={[log('SYS-INIT')]} isComplete={false} />);
    expect(container.querySelector('[data-log-dropped]')).toBeNull();
  });

  /** A log box `height` px tall whose lines take `content` px, scrolled to `top`. */
  function sized(box: HTMLElement, content: () => number, height = 288) {
    Object.defineProperty(box, 'scrollHeight', { configurable: true, get: content });
    Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => height });
  }
  const lines = (count: number) =>
    Array.from({ length: count }, (_, n) => ({
      ...log('SYS-INIT'),
      id: `line-${n}`,
      message: `Line ${n}`,
    }));

  it('keeps its own scroll at the newest line, without scrolling the page into view', () => {
    const intoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {});
    let content = 600;
    const { rerender } = render(<SystemConsole logs={lines(20)} isComplete={false} />);
    const box = screen.getByRole('log');
    sized(box, () => content);
    content = 700;
    rerender(<SystemConsole logs={lines(22)} isComplete={false} />);
    expect(box.scrollTop).toBe(700);
    expect(intoView).not.toHaveBeenCalled();
  });

  it('leaves a reader who scrolled up to an earlier line where they are', () => {
    let content = 600;
    const { rerender } = render(<SystemConsole logs={lines(20)} isComplete={false} />);
    const box = screen.getByRole('log');
    sized(box, () => content);
    box.scrollTop = 40;
    fireEvent.scroll(box);
    content = 700;
    rerender(<SystemConsole logs={lines(22)} isComplete={false} />);
    expect(box.scrollTop).toBe(40);
    // Back at the end, the newest lines are followed again.
    box.scrollTop = 700 - 288;
    fireEvent.scroll(box);
    content = 800;
    rerender(<SystemConsole logs={lines(24)} isComplete={false} />);
    expect(box.scrollTop).toBe(800);
  });

  describe('times', () => {
    const at = '2026-01-01T09:41:07.000Z';
    const clock = new Date(at).toLocaleTimeString('en-US', { hour12: false });
    const lines: AgentLog[] = [
      { id: 'a', message: 'Searching for "Bright Lines"', timestamp: at },
      { id: 'b', message: 'Found it', timestamp: at, code: 'SPOTIFY-FOUND', elapsedMs: 316 },
      { id: 'c', message: 'Measured', timestamp: at, code: 'AUDIO-COMPLETE', elapsedMs: 75_900 },
    ];
    const timeOf = (container: HTMLElement, id: string) =>
      container.querySelector(`[data-log-id="${id}"] [data-log-time]`)?.textContent;

    it("shows a replayed line's recorded time since the run started, and its arrival time when it has none", () => {
      const { container } = render(<SystemConsole logs={lines} isComplete={false} isReplay />);
      expect(timeOf(container, 'b')).toBe('+0.3 s');
      expect(timeOf(container, 'c')).toBe('+1 min 15 s');
      // No recorded time: when the line came, on this viewer's clock, which is true.
      expect(timeOf(container, 'a')).toBe(clock);
    });

    it('shows the arrival time on every line of a live run', () => {
      const { container } = render(<SystemConsole logs={lines} isComplete={false} />);
      for (const id of ['a', 'b', 'c']) expect(timeOf(container, id), id).toBe(clock);
    });
  });
});
