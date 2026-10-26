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
    expect(timeline.textContent).toContain('Template — not analyzed');
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

  it('says where the structure comes from with a chip of its kind: violet only for the model', () => {
    const chipOf = (source?: 'template' | 'inferred') => {
      render(<SmartTimeline segments={template} segmentsSource={source} />);
      const chip = screen
        .getByRole('group', { name: 'Song structure' })
        .querySelector('[data-provenance]') as HTMLElement;
      const found = { kind: chip.dataset.provenance, text: chip.textContent };
      cleanup();
      return found;
    };
    expect(chipOf('template')).toEqual({ kind: 'missing', text: 'Template — not analyzed' });
    expect(chipOf(undefined)).toEqual({ kind: 'unconfirmed', text: 'Not measured' });
    expect(chipOf('inferred')).toEqual({ kind: 'inferred', text: 'Model inference' });
  });

  it("draws the model's sections in the inferred colour, never in the colour the result sends", () => {
    render(
      <SmartTimeline
        segments={[
          { label: 'Verse', start: 0, end: 40, color: '#FFB000' },
          { label: 'Chorus', start: 40, end: 100, color: '#00F0FF' },
        ]}
        segmentsSource="inferred"
      />,
    );
    const sections = screen.getAllByRole('listitem');
    expect(sections.map((section) => section.getAttribute('aria-label'))).toEqual([
      'Verse, 40% of track',
      'Chorus, 60% of track',
    ]);
    for (const section of sections) {
      expect(section.style.backgroundColor).toBe('');
      expect(section.className).toContain('bg-prov-inferred/');
    }
    cleanup();
    render(<SmartTimeline segments={template} segmentsSource="template" />);
    for (const section of screen.getAllByRole('listitem')) {
      expect(section.style.backgroundColor).toBe('');
      expect(section.className).not.toContain('prov-inferred');
    }
  });

  it('draws sample times in the inferred colour and measured moments in the measured colour, apart by shape', () => {
    render(
      <SmartTimeline
        segments={template}
        durationSeconds={240}
        samples={[{ time: 60, description: 'Old record' }]}
        keyMoments={[
          { time: 4, type: 'onset', intensity: 1, description: 'Beat transition' },
          { time: 8, type: 'harmonic_change', intensity: 1, description: 'Key change' },
          { time: 12, type: 'energy_peak', intensity: 1, description: 'Peak' },
        ]}
      />,
    );
    const markers = screen.getAllByRole('img');
    const drawn = markers.map((marker) => {
      const shape = marker.querySelector('svg') as SVGElement;
      return [marker.getAttribute('aria-label'), shape.style.color, shape.dataset.shape];
    });
    expect(drawn).toEqual([
      ['Sample: Old record (time inferred by the model)', '#c4a4fc', 'diamond'],
      ['Beat transition (measured at 0:04 in the preview)', '#00f0ff', 'diamond'],
      ['Key change (measured at 0:08 in the preview)', '#00f0ff', 'circle'],
      ['Peak (measured at 0:12 in the preview)', '#00f0ff', 'up'],
    ]);
    // Their words are in a text colour, not the marker's.
    for (const marker of markers) {
      expect((marker.lastElementChild as HTMLElement).className).toContain('text-text-secondary');
    }
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
    const preview = screen.getByRole('group', { name: 'Audio preview (about 30 s)' });
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

  it('keeps key moments from the decoded 30-35 s window inside the preview lane', () => {
    render(
      <SmartTimeline
        segments={template}
        keyMoments={[
          { time: 33, type: 'onset', intensity: 0.5, description: 'Late onset' },
          { time: 36, type: 'onset', intensity: 0.5, description: 'Past the decoded clip' },
        ]}
      />,
    );
    const preview = screen.getByRole('group', { name: 'Audio preview (about 30 s)' });
    const markers = within(preview).getAllByRole('img');
    expect(markers).toHaveLength(1);
    expect(markers[0].getAttribute('aria-label')).toContain('Late onset');
    // The lane stretches to the latest moment instead of pinning it past the end.
    expect(preview.textContent).toContain('0:33');
    const timeline = screen.getByRole('group', { name: 'Song structure' });
    expect(timeline.textContent).toContain('1 key moment outside the preview, not drawn');
  });

  it.each([
    [true, 'No key moments detected'],
    [false, 'No key moments — the audio was not analyzed'],
    [undefined, 'No key moments'],
  ])('says why there are no key moments when audioAnalyzed is %s', (analysed, text) => {
    render(<SmartTimeline segments={template} audioAnalyzed={analysed} />);
    const timeline = screen.getByRole('group', { name: 'Song structure' });
    expect(timeline.textContent).toContain(text);
    if (analysed !== false) expect(timeline.textContent).not.toContain('not analyzed');
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
