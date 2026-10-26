import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentLog } from '../types';
import SystemConsole from './SystemConsole';

afterEach(cleanup);

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
});
