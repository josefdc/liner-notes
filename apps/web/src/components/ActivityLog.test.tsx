import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentLog } from '../types';
import ActivityLog from './ActivityLog';

afterEach(cleanup);

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
});
