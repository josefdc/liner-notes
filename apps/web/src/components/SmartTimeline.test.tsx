import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SmartTimeline from './SmartTimeline';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const template = [
  { label: 'Intro', start: 0, end: 10, color: '#374151' },
  { label: 'Main', start: 10, end: 90, color: '#1F2937' },
  { label: 'Outro', start: 90, end: 100, color: '#374151' },
];

describe('SmartTimeline', () => {
  it('labels template segments and draws no marker when nothing was detected', () => {
    render(<SmartTimeline segments={template} segmentsSource="template" audioAnalyzed={false} />);
    const timeline = screen.getByRole('group', { name: 'Song structure' });
    expect(timeline.textContent).toContain('Template — not analysed');
    expect(timeline.textContent).toContain('No key moments');
    expect(within(timeline).queryAllByRole('img')).toHaveLength(0);
  });

  it('says the duration is unknown instead of showing a default length', () => {
    render(<SmartTimeline segments={template} segmentsSource="template" />);
    const timeline = screen.getByRole('group', { name: 'Song structure' });
    expect(timeline.textContent).toContain('Duration unknown');
    expect(timeline.textContent).not.toContain('3:45');
  });

  it('labels model-written segments and keeps markers that share a time', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <SmartTimeline
        segments={[
          { label: 'Chorus', start: 0, end: 50, color: '#00F0FF' },
          { label: 'Chorus', start: 50, end: 100, color: '#00F0FF' },
        ]}
        segmentsSource="inferred"
        durationSeconds={240}
        keyMoments={[
          { time: 12, type: 'energy_peak', intensity: 0.9, description: 'Peak' },
          { time: 12, type: 'energy_peak', intensity: 0.8, description: 'Second peak' },
        ]}
      />,
    );
    const timeline = screen.getByRole('group', { name: 'Song structure' });
    expect(timeline.textContent).toContain('Model inference');
    expect(timeline.textContent).toContain('4:00');
    expect(within(timeline).getAllByRole('img')).toHaveLength(2);
    expect(error.mock.calls.flat().join(' ')).not.toMatch(/same key/);
  });
});
