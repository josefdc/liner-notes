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

// What the audio service measured on the preview (AudioFeatures v2 `beats`, `energyContour`,
// `sections`), timed in seconds from the start of the preview window.
const grid = {
  times: [0.5, 5, 10, 25],
  method: 'essentia.RhythmExtractor2013',
  basis: 'signal' as const,
};
const contour = {
  hopSeconds: 1,
  values: Array.from({ length: 22 }, (_, i) => (i % 4) / 4),
  method: 'frame RMS',
  basis: 'signal' as const,
};
const neutralSections = {
  segments: [
    { label: 'A', start: 0, end: 8 },
    { label: 'B', start: 8, end: 20 },
    { label: 'A', start: 20, end: 24 },
  ],
  method: 'novelty-on-beat-chroma',
  basis: 'signal' as const,
};
const layer = (root: HTMLElement, name: string) =>
  root.querySelector(`[data-measured-layer="${name}"]`) as HTMLElement | null;

describe('the measured layers of the preview', () => {
  it.each([
    [0.09288, 'every 93 ms'],
    [0.0015, 'every 1.5 ms'],
    [0.5, 'every 500 ms'],
    [1, 'every 1 s'],
    [2.25, 'every 2.25 s'],
  ])('announces an energy hop of %s s as "%s"', (hopSeconds, words) => {
    render(
      <SmartTimeline
        segments={template}
        previewSeconds={20}
        energyContour={{ ...contour, hopSeconds, values: [0.1, 0.2] }}
      />,
    );
    const energy = screen.getByRole('img', { name: /^Energy \(RMS\)/ });
    expect(energy.getAttribute('aria-label')).toContain(`(RMS) ${words},`);
    expect(energy.getAttribute('aria-label')).not.toMatch(/every 0 s|every 0 ms/);
  });

  it('draws the measured beats, energy and sections on the preview lane, in the measured colour', () => {
    render(
      <SmartTimeline
        segments={template}
        segmentsSource="inferred"
        durationSeconds={240}
        previewSeconds={20}
        beats={grid}
        energyContour={contour}
        measuredSections={neutralSections}
        audioAnalyzed
      />,
    );
    const lane = screen.getByRole('group', { name: 'Preview window (20 s, measured)' });

    // Beat ticks at the preview's own times; the beat past the window is not drawn.
    const beats = within(lane).getByRole('img', { name: /^Beat grid/ });
    expect(beats.getAttribute('aria-label')).toBe(
      'Beat grid: 3 beats measured in the preview (essentia.RhythmExtractor2013)',
    );
    expect(beats.getAttribute('viewBox')).toBe('0 0 20 1');
    const ticks = [...beats.querySelectorAll('line')];
    expect(ticks.map((tick) => tick.getAttribute('x1'))).toEqual(['0.5', '5', '10']);
    expect(beats.getAttribute('stroke')).toBe('#00f0ff');

    // The energy line: one point per hop, at the middle of its frame, up to the window's end.
    const energy = within(lane).getByRole('img', { name: /^Energy/ });
    expect(energy.getAttribute('viewBox')).toBe('0 0 20 1');
    const points = (energy.querySelector('polyline')?.getAttribute('points') ?? '').split(' ');
    expect(points).toHaveLength(20);
    expect(points[0]).toBe('0.5,1');
    expect(points[2]).toBe('2.5,0.3333');
    expect(energy.querySelector('polyline')?.getAttribute('stroke')).toBe('#00f0ff');

    // Neutral sections, cut at the window's end, in tints of the measured colour.
    const sections = within(lane).getByRole('list', { name: 'Sections measured in the preview' });
    const items = within(sections).getAllByRole('listitem');
    expect(items.map((item) => item.getAttribute('aria-label'))).toEqual([
      'Section A, 0:00 to 0:08 (measured)',
      'Section B, 0:08 to 0:20 (measured)',
    ]);
    expect(items.map((item) => [item.style.left, item.style.width])).toEqual([
      ['0%', '40%'],
      ['40%', '60%'],
    ]);
    for (const item of items) {
      expect(item.className).toContain('prov-measured');
      expect(item.className).not.toContain('prov-inferred');
    }

    // Labelled measured, in words and with the measured chip.
    const legend = layer(lane, 'legend') as HTMLElement;
    expect(legend.querySelector('[data-provenance]')?.getAttribute('data-provenance')).toBe(
      'measured',
    );
    expect(legend.textContent).toContain('not verse or chorus');
    expect(legend.textContent).toContain('sections A, B (by harmony, not verse or chorus)');
    // What falls past the window is left out, and each layer says so.
    const timelineText = screen.getByRole('group', { name: 'Song structure' }).textContent;
    expect(timelineText).toContain('1 beat outside the preview, not drawn');
    expect(timelineText).toContain('1 section outside the preview, not drawn');
    expect(timelineText).toContain('2 energy frames outside the preview, not drawn');
  });

  it("keeps the model's sections inferred beside the measured ones", () => {
    render(
      <SmartTimeline
        segments={[
          { label: 'Verse', start: 0, end: 40, color: '#00F0FF' },
          { label: 'Chorus', start: 40, end: 100, color: '#00F0FF' },
        ]}
        segmentsSource="inferred"
        previewSeconds={20}
        measuredSections={neutralSections}
      />,
    );
    const timeline = screen.getByRole('group', { name: 'Song structure' });
    const [structure] = within(timeline).getAllByRole('list');
    const model = within(structure).getAllByRole('listitem');
    expect(model.map((item) => item.getAttribute('aria-label'))).toEqual([
      'Verse, 40% of track',
      'Chorus, 60% of track',
    ]);
    for (const item of model) {
      expect(item.dataset.segmentTint).toBe('inferred');
      expect(item.className).toContain('bg-prov-inferred/');
      expect(item.className).not.toContain('prov-measured');
      expect(item.closest('[data-measured-layer]')).toBeNull();
    }
    expect((timeline.querySelector('[data-provenance]') as HTMLElement).dataset.provenance).toBe(
      'inferred',
    );
    // The measured sections are the only ones in the preview lane.
    const lane = screen.getByRole('group', { name: 'Preview window (20 s, measured)' });
    expect(within(lane).getAllByRole('listitem')).toHaveLength(2);
    expect(lane.textContent).not.toMatch(/Verse|Chorus/);
  });

  it.each([
    ['beats', { energyContour: contour, measuredSections: neutralSections }],
    ['energy', { beats: grid, measuredSections: neutralSections }],
    ['sections', { beats: grid, energyContour: contour }],
  ] as const)('draws nothing for a missing %s layer', (missing, present) => {
    render(
      <SmartTimeline
        segments={template}
        previewSeconds={20}
        beats={null}
        energyContour={null}
        measuredSections={null}
        {...present}
      />,
    );
    const lane = screen.getByRole('group', { name: 'Preview window (20 s, measured)' });
    expect(layer(lane, missing)).toBeNull();
    expect(lane.querySelectorAll('[data-measured-layer]').length).toBeGreaterThan(1);
    const legend = layer(lane, 'legend') as HTMLElement;
    expect(legend.textContent?.toLowerCase()).not.toContain(
      { beats: 'beat', energy: 'energy', sections: 'section' }[missing],
    );
  });

  it('draws no lane, grid or placeholder when no layer was measured', () => {
    // The same timeline with its layers draws them (so their absence below is the layers').
    render(
      <SmartTimeline
        segments={template}
        segmentsSource="template"
        previewSeconds={20}
        beats={grid}
        energyContour={contour}
        measuredSections={neutralSections}
        audioAnalyzed
      />,
    );
    expect(document.querySelectorAll('[data-measured-layer]').length).toBeGreaterThan(0);
    cleanup();
    render(
      <SmartTimeline
        segments={template}
        segmentsSource="template"
        previewSeconds={20}
        beats={null}
        energyContour={null}
        measuredSections={null}
        audioAnalyzed
      />,
    );
    const timeline = screen.getByRole('group', { name: 'Song structure' });
    expect(timeline.querySelector('[data-measured-layer]')).toBeNull();
    expect(timeline.querySelector('svg line, svg polyline')).toBeNull();
    expect(screen.queryByRole('group', { name: /Preview window/ })).toBeNull();
    expect(timeline.textContent).not.toMatch(/beat|energy|measured/i);
    cleanup();
    // Empty layers, and layers without the preview's measured length, are not drawn either.
    render(
      <SmartTimeline
        segments={template}
        beats={grid}
        energyContour={contour}
        measuredSections={neutralSections}
      />,
    );
    expect(document.querySelector('[data-measured-layer]')).toBeNull();
    cleanup();
    render(
      <SmartTimeline
        segments={template}
        previewSeconds={20}
        beats={{ ...grid, times: [] }}
        energyContour={{ ...contour, values: [] }}
        measuredSections={{ ...neutralSections, segments: [] }}
      />,
    );
    expect(document.querySelector('[data-measured-layer]')).toBeNull();
  });
});
