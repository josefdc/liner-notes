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

  it('draws key moments on a preview lane, never on the song timeline', () => {
    render(
      <SmartTimeline
        segments={template}
        durationSeconds={240}
        keyMoments={[
          { time: 12, type: 'energy_peak', intensity: 0, description: 'Quiet peak' },
          { time: 45, type: 'onset', intensity: 0.5, description: 'Past the preview' },
        ]}
      />,
    );
    const preview = screen.getByRole('group', { name: 'Audio preview (30 s)' });
    const markers = within(preview).getAllByRole('img');
    expect(markers).toHaveLength(1);
    // 12 s of a 30 s preview, not 12 s of a 240 s song.
    expect(markers[0].getAttribute('style')).toContain('left: 40%');
    expect(markers[0].getAttribute('aria-label')).toContain('in the preview');
    // An intensity of 0 is drawn as 0, not as full opacity.
    expect((markers[0].firstElementChild as HTMLElement).style.opacity).toBe('0');
    const timeline = screen.getByRole('group', { name: 'Song structure' });
    expect(timeline.textContent).toContain('1 key moment outside the preview, not drawn');
  });

  it('scales the preview lane to the preview length when it is sent', () => {
    render(
      <SmartTimeline
        segments={template}
        previewDurationSeconds={60}
        keyMoments={[{ time: 45, type: 'onset', intensity: 0.5, description: 'Onset' }]}
      />,
    );
    const preview = screen.getByRole('group', { name: 'Audio preview (60 s)' });
    expect(within(preview).getAllByRole('img')).toHaveLength(1);
  });

  it('labels sample times as inferred and leaves out samples past the end of the song', () => {
    render(
      <SmartTimeline
        segments={template}
        durationSeconds={120}
        samples={[
          { time: 60, description: 'Inside' },
          { time: 200, description: 'Past the end' },
        ]}
      />,
    );
    const timeline = screen.getByRole('group', { name: 'Song structure' });
    const markers = within(timeline).getAllByRole('img');
    expect(markers).toHaveLength(1);
    expect(markers[0].getAttribute('aria-label')).toContain('time inferred by the model');
    expect(timeline.textContent).toContain('Sample times: model inference');
    expect(timeline.textContent).toContain('1 sample time outside the song, not drawn');
  });
});
