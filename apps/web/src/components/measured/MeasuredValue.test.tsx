import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { audioReadings } from '../../constants';
import { AudioStats, ReadingValue, ResultNotices } from '../EstimatedWarning';
import SmartTimeline from '../SmartTimeline';
import SonicFingerprint from '../SonicFingerprint';
import { MeasuredValue, summaryText } from './MeasuredValue';
import { MissingValue } from './MissingValue';
import fullResultRaw from '../../../../../tests/mock-sse/fixtures/full-result.json?raw';
import type { TrackData } from '../../types';
import { audioBlock, measuredTrack } from './testing';

afterEach(cleanup);

const item = (list: HTMLElement, label: string) => {
  const found = within(list)
    .getAllByRole('listitem')
    .find((li) => li.textContent?.startsWith(label));
  if (!found) throw new Error(`No item ${label}`);
  return found.textContent ?? '';
};

/** Opens every closed provenance disclosure on the page, by its button. */
const openAll = () => {
  for (const button of screen.queryAllByRole('button', { expanded: false })) {
    fireEvent.click(button);
  }
};

/** The element a disclosure button shows and hides. */
const panelOf = (button: HTMLElement) => {
  const panel = document.getElementById(button.getAttribute('aria-controls') ?? '');
  if (!panel) throw new Error(`No panel for ${button.textContent}`);
  return panel;
};

// What the Player's hero must not show until it is asked for: the estimator's raw confidence
// and its scale, the methods and the analyzer.
const DETAIL =
  /confidence|calibrated|probability|strength|essentia|analyzer|discogs|musicnn|\d\.\d\d of/i;

describe('MeasuredValue', () => {
  it('shows a measured value with its confidence and basis', () => {
    render(
      <MeasuredValue
        label="BPM"
        value="123"
        kind="measured"
        confidence="confidence 0.62"
        basis="signal, 29.8 s preview"
        title="Measured from the audio preview"
      />,
    );
    expect(document.body.textContent).toBe(
      'BPM 123Measured · confidence 0.62 · signal, 29.8 s preview',
    );
  });

  it('labels a model score as a model estimate, never as measured', () => {
    render(
      <MeasuredValue
        label="Dance"
        value="0.81"
        kind="estimate"
        confidence="score, not a probability"
        basis="model discogs-effnet-bs64-1, 29.8 s preview"
        title="Score"
      />,
    );
    expect(document.body.textContent).toContain('Model estimate · score, not a probability');
    expect(document.body.textContent).not.toMatch(/measured/i);
  });

  it('says the confidence and basis are unknown when the result does not send them', () => {
    render(<MeasuredValue label="BPM" value="123" kind="measured" title="Measured" />);
    expect(document.body.textContent).toContain('Measured · confidence and basis unknown');
  });
});

describe('MeasuredValue, compact', () => {
  const measured = (
    <MeasuredValue
      label="BPM"
      value="123"
      kind="measured"
      confidence="confidence 0.62"
      basis="signal, 29.8 s preview"
      detail="essentia.RhythmExtractor2013"
      title="Measured from the audio preview"
      layout="compact"
    />
  );

  it('shows the value and a chip of its kind, with no provenance line until it is asked for', () => {
    const { container } = render(measured);
    expect(container.textContent).toBe('BPM 123Measured');
    const chip = screen.getByRole('button', { name: 'Measured: how BPM was obtained' });
    expect(chip.getAttribute('aria-expanded')).toBe('false');
    const lines = document.getElementById(chip.getAttribute('aria-controls') ?? '');
    expect(lines?.hidden).toBe(true);
    expect(container.querySelector('[data-provenance="measured"]')).not.toBeNull();
  });

  it('opens the provenance lines from the chip, and closes them again', () => {
    const { container } = render(measured);
    const chip = screen.getByRole('button', { name: /^Measured/ });
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-expanded')).toBe('true');
    const lines = document.getElementById(chip.getAttribute('aria-controls') ?? '');
    expect(lines?.hidden).toBe(false);
    expect(lines?.textContent).toBe(
      'Measured · confidence 0.62 · signal, 29.8 s previewessentia.RhythmExtractor2013',
    );
    fireEvent.click(chip);
    expect(container.textContent).toBe('BPM 123Measured');
  });

  it('calls a model score a model estimate, in the inferred colour, never measured', () => {
    const { container } = render(
      <MeasuredValue
        label="Dance"
        value="0.81"
        kind="estimate"
        confidence="score, not a probability"
        basis="model discogs-effnet-bs64-1"
        title="Score"
        layout="compact"
      />,
    );
    expect(container.textContent).toBe('Dance 0.81Model estimate');
    expect(container.textContent).not.toMatch(/measured/i);
    const chip = container.querySelector('[data-provenance]') as HTMLElement;
    expect(chip.dataset.provenance).toBe('inferred');
    expect(chip.className).toContain('text-prov-inferred');
    // Off the sourced amber: an estimate never reads as sourced.
    expect(container.innerHTML).not.toMatch(/analog|amber/);
  });

  it('says a value no measurement confirms is not confirmed, in neutral', () => {
    const { container } = render(
      <MeasuredValue label="BPM" value="105" kind="unverified" title="Copy" layout="compact" />,
    );
    expect(container.textContent).toBe('BPM 105Not confirmed, basis unknown');
    const chip = container.querySelector('[data-provenance]') as HTMLElement;
    expect(chip.dataset.provenance).toBe('unconfirmed');
    expect(chip.dataset.variant).toBe('neutral');
  });

  it('draws the measured label in a text colour, not a faded cyan', () => {
    const { container } = render(measured);
    const label = Array.from(container.querySelectorAll('span')).find(
      (span) => span.textContent === 'BPM',
    );
    expect(label?.className).toBe('text-text-secondary');
  });
});

describe("the Dashboard's compact audio values", () => {
  it('show each value with its kind, and a missing one with why', () => {
    const track = measuredTrack(
      audioBlock({ analyzerVersion: '2.1.0+essentia', key: null, fingerprint: null }),
      { key: null, audioSource: 'unavailable', audioUnavailableReason: 'not_detected' },
    );
    render(<AudioStats track={track} compact />);
    const values = screen.getByRole('list', { name: 'Audio values' });
    expect(item(values, 'BPM')).toBe('BPM 123.1Measured');
    // A withheld value still says why, without opening anything.
    expect(item(values, 'Key')).toBe('Key not measured— not detected in the preview');
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual([
      'Measured',
      'Measured',
    ]);
  });
});

describe('MeasuredValue, compact, without a confidence or basis', () => {
  it('says the basis is unknown on the chip itself, for a measured value and an estimate', () => {
    const { container } = render(
      <>
        <MeasuredValue label="BPM" value="105" kind="measured" title="Measured" layout="compact" />
        <MeasuredValue label="Mood" value="0.3" kind="estimate" title="Score" layout="compact" />
      </>,
    );
    expect(container.textContent).toBe(
      'BPM 105Measured, basis unknownMood 0.3Model estimate, basis unknown',
    );
    expect(
      screen.getByRole('button', { name: 'Measured, basis unknown: how BPM was obtained' }),
    ).toBeTruthy();
  });

  it('keeps the value and its chip together, as one unit', () => {
    const { container } = render(
      <MeasuredValue
        label="Loudness"
        value="-13.6 dBFS RMS"
        kind="measured"
        confidence="direct measure"
        basis="signal"
        title="Measured"
        layout="compact"
      />,
    );
    const pair = container.querySelector('[data-value-pair]') as HTMLElement;
    // One line from lg up; below it the chip right under the value, for every value.
    expect(pair.className).toContain('lg:flex-nowrap');
    expect(pair.className).toContain('flex-col');
    expect(pair.className).toContain('gap-1');
    expect(pair.children).toHaveLength(2);
    expect((pair.lastElementChild as HTMLElement).className).toContain('shrink-0');
  });
});

describe('the compact view of a result from an older API', () => {
  // The full-result fixture: no `audio` block, so its values' basis is unknown, and its model
  // scores carry a confidence (the description of the score) but no basis.
  const legacy = () => {
    const fixture = JSON.parse(fullResultRaw) as {
      streams: Record<string, Array<{ type: string; data?: unknown }>>;
    };
    return fixture.streams['/api/analyze/stream'].find((event) => event.type === 'complete')
      ?.data as TrackData;
  };

  it('says "basis unknown" on each chip exactly where the provenance line says it', () => {
    const track = legacy();
    const chips = (() => {
      const { container } = render(<AudioStats track={track} compact />);
      const found = [...container.querySelectorAll('[data-value-pair]')].map((pair) => ({
        label: pair.firstElementChild?.textContent ?? '',
        chip: pair.lastElementChild?.textContent ?? '',
      }));
      cleanup();
      return found;
    })();
    const { container } = render(<AudioStats track={track} />);
    openAll();
    const lines = new Map(
      [...container.querySelectorAll('[data-value-kind]')].map((value) => [
        value.firstElementChild?.textContent ?? '',
        value.textContent ?? '',
      ]),
    );
    expect(chips.map(({ label }) => label)).toEqual([
      'BPM 105',
      'Key A Minor',
      'Energy 0.71',
      'Mood Mellow 0.34',
      'Dance 0.62',
      'Acoustic 0.12',
    ]);
    for (const { label, chip } of chips) {
      const line = lines.get(label) ?? '';
      expect(chip.includes('basis unknown'), `${label}: ${chip} / ${line}`).toBe(
        line.includes('basis unknown'),
      );
    }
    expect(chips.find(({ label }) => label.startsWith('Mood'))?.chip).toBe(
      'Model estimate, basis unknown',
    );
  });
});

describe('MissingValue', () => {
  it('says the value is not measured, and why when the result says', () => {
    render(<MissingValue label="Key" reason="not detected in the preview" />);
    expect(document.body.textContent).toBe('Key not measured— not detected in the preview');
  });

  it('says only "not measured" when there is no reason', () => {
    render(<MissingValue label="Key" />);
    expect(document.body.textContent).toBe('Key not measured');
  });
});

describe("the Player hero's labels", () => {
  const kinds = ['measured', 'estimate', 'unverified', 'score'] as const;
  const summaryOf = (kind: (typeof kinds)[number]) => {
    const { container } = render(
      <MeasuredValue
        label="BPM"
        value="123"
        kind={kind}
        confidence="estimator confidence 3.30 of 5.32, not calibrated"
        basis={kind === 'measured' || kind === 'estimate' ? 'signal, 29.8 s preview' : null}
        previewSeconds={kind === 'measured' || kind === 'estimate' ? 29.75 : null}
        title="Provenance"
        layout="summary"
      />,
    );
    const button = screen.getByRole('button');
    const text = { line: container.textContent ?? '', button: button.textContent ?? '' };
    cleanup();
    return text;
  };

  it('keep measured, estimated, unconfirmed, scored and missing values apart', () => {
    const shown = kinds.map(summaryOf);
    expect(shown.map(({ line }) => line)).toEqual([
      'BPM 123Measured from a 29.8 s previewHow this was measured (BPM)',
      'BPM 123Estimated by an audio model from a 29.8 s previewHow this was estimated (BPM)',
      'BPM 123Not confirmed as measuredWhy this is not confirmed (BPM)',
      'BPM 123v1 energy score (0–1, saturates on loud masters)About this score (BPM)',
    ]);
    // An estimate is never called measured, in its line or its button.
    expect(shown[1].line).not.toMatch(/measured/i);
    render(<MissingValue label="BPM" reason="the preview is silent" />);
    const missing = document.body.textContent ?? '';
    expect(missing).toBe('BPM not measured— the preview is silent');
    expect(new Set([...shown.map(({ line }) => line), missing]).size).toBe(5);
  });

  it('say when the basis is unknown, as the chips do, and the preview length as measured', () => {
    expect(summaryText('measured', null, null, 'c')).toBe('Measured, basis unknown');
    expect(summaryText('estimate', null, null, 'c')).toBe('Estimated, basis unknown');
    expect(summaryText('measured', 'signal', null)).toBe('Measured');
    expect(summaryText('measured', 'signal, 22.4 s preview', 22.4)).toBe(
      'Measured from a 22.4 s preview',
    );
    expect(summaryText('measured', 'signal, 8 s preview', 8)).toBe('Measured from an 8 s preview');
    expect(summaryText('estimate', 'model x, 11 s preview', 11)).toBe(
      'Estimated by an audio model from an 11 s preview',
    );
    expect(summaryText('measured', 'signal, 30 s preview', 30)).toBe(
      'Measured from a 30 s preview',
    );
  });
});

describe("the Player hero's disclosures", () => {
  const recorded = {
    mode: 'replay',
    id: 'r1',
    recordedAt: '2026-10-22T14:03:00.000Z',
    commit: 'abc1234',
  };
  const buttonOf = (name: string) => screen.getByRole('button', { name });
  const opened = (name: string) => {
    const button = buttonOf(name);
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    return panelOf(button).textContent ?? '';
  };

  it('carry no tooltip: the ids and the confidence are only in the panel', () => {
    const { container } = render(<AudioStats track={measuredTrack()} />);
    expect(container.querySelectorAll('[title]')).toHaveLength(0);
    for (const button of screen.getAllByRole('button')) {
      expect(button.closest('[title]')).toBeNull();
    }
  });

  it('say in the panel that a replayed value was measured when the run was recorded', () => {
    render(
      <AudioStats track={measuredTrack(audioBlock(), { run: recorded } as Partial<TrackData>)} />,
    );
    expect(opened('How this was measured (BPM)')).toContain('measured when this run was recorded');
    cleanup();
    render(<AudioStats track={measuredTrack()} />);
    expect(opened('How this was measured (BPM)')).not.toContain('recorded');
  });

  it('give the reason a value is not confirmed', () => {
    render(
      <AudioStats
        track={measuredTrack(audioBlock(), { audio: null, valence: 0.4 } as Partial<TrackData>)}
      />,
    );
    expect(opened('Why this is not confirmed (BPM)')).toContain(
      "the result's measurement is missing or could not be read",
    );
  });

  it('say that a model score is an estimate, not a measurement', () => {
    render(<AudioStats track={measuredTrack()} />);
    expect(opened('How this was estimated (Dance)')).toContain('an estimate, not a measurement');
  });

  it("say what the first analyzer's energy score is", () => {
    render(
      <AudioStats
        track={measuredTrack(audioBlock(), { audio: undefined, energy: 0.5 } as Partial<TrackData>)}
      />,
    );
    const panel = opened('About this score (Energy)');
    expect(panel).toContain('scaled RMS');
    expect(panel).toContain('how is not known');
  });

  it('keep a focus outline in forced-colors mode (outline-hidden, not outline-none)', () => {
    render(<AudioStats track={measuredTrack()} />);
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toContain('focus-visible:outline-hidden');
      expect(button.className).not.toContain('outline-none');
    }
  });

  it('show no disclosure when its panel would say nothing beyond the label', () => {
    const { container } = render(
      <MeasuredValue label="BPM" value="123" kind="measured" title="Measured" layout="summary" />,
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(container.textContent).toBe('BPM 123Measured, confidence and basis unknown');
  });

  it('do not name the estimator of an estimate whose basis is unknown', () => {
    expect(summaryText('estimate', null, null, 'score, not a probability')).toBe(
      'Estimated, basis unknown',
    );
    expect(summaryText('estimate', null, null, null)).toBe(
      'Estimated, confidence and basis unknown',
    );
  });

  it('give no length for a preview shorter than 0.05 s', () => {
    expect(summaryText('measured', 'signal, 0 s preview', 0, 'c')).toBe('Measured');
    expect(summaryText('measured', 'signal, 0 s preview', 0.04, 'c')).toBe('Measured');
    expect(summaryText('measured', 'signal, 0.1 s preview', 0.05, 'c')).toBe(
      'Measured from a 0.1 s preview',
    );
  });

  it('keep neighbouring values apart, each in a column of the same width', () => {
    render(<AudioStats track={measuredTrack()} />);
    const values = screen.getByRole('list', { name: 'Audio values' });
    expect(values.className).toContain('gap-x-6');
    for (const li of within(values).getAllByRole('listitem')) {
      expect(li.className).toContain('w-60 max-w-full text-left');
    }
  });
});

describe('audio values from a measurement', () => {
  it('show each value with a short label saying how it is known, and no estimator details', () => {
    render(<AudioStats track={measuredTrack()} />);
    const values = screen.getByRole('list', { name: 'Audio values' });
    // The value, one plain line with the preview's real length, and the disclosure's button.
    expect(item(values, 'BPM')).toBe(
      'BPM 123.1Measured from a 29.8 s previewHow this was measured (BPM)',
    );
    expect(item(values, 'Key')).toBe(
      'Key F# MinorMeasured from a 29.8 s previewHow this was measured (Key)',
    );
    expect(item(values, 'Loudness')).toBe(
      'Loudness -13.6 dBFS RMSMeasured from a 29.8 s previewHow this was measured (Loudness)',
    );
    const scores = screen.getByRole('list', { name: 'Audio-model estimates' });
    expect(item(scores, 'Dance')).toBe(
      'Dance 0.81Estimated by an audio model from a 29.8 s previewHow this was estimated (Dance)',
    );
    expect(scores.textContent).not.toMatch(/measured/i);
    for (const list of [values, scores]) {
      for (const li of within(list).getAllByRole('listitem')) {
        expect(li.textContent, li.textContent ?? '').not.toMatch(DETAIL);
      }
    }
    // Every disclosure is closed, and its panel empty, until it is asked for.
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(8);
    for (const button of buttons) {
      expect(button.getAttribute('aria-expanded')).toBe('false');
      expect(panelOf(button).hidden).toBe(true);
      expect(panelOf(button).textContent).toBe('');
    }
  });

  it('hold every detail shown before behind "How this was measured", and close again', () => {
    render(<AudioStats track={measuredTrack()} />);
    const values = screen.getByRole('list', { name: 'Audio values' });
    const bpm = within(values).getByRole('button', { name: 'How this was measured (BPM)' });
    fireEvent.click(bpm);
    expect(bpm.getAttribute('aria-expanded')).toBe('true');
    const panel = panelOf(bpm);
    expect(panel.hidden).toBe(false);
    // Each detail: the kind, the confidence and its scale, "not calibrated", the basis (signal,
    // preview), the method, the analyzer, and the note on half or double tempo.
    for (const detail of [
      'Measured',
      'estimator confidence 3.30 of 5.32',
      'not calibrated',
      'signal, 29.8 s preview',
      'essentia.RhythmExtractor2013',
      'analyzer 2.1.0+essentia.models-5c5c0c7f',
      'the confidence does not flag half or double tempo',
    ]) {
      expect(panel.textContent).toContain(detail);
    }
    // Only this value's panel opened.
    expect(screen.getAllByRole('button', { expanded: true })).toEqual([bpm]);
    fireEvent.click(bpm);
    expect(bpm.getAttribute('aria-expanded')).toBe('false');
    expect(panel.hidden).toBe(true);
    expect(item(values, 'BPM')).not.toMatch(DETAIL);
  });

  it('show, once opened, exactly the lines the detail views show', () => {
    const track = measuredTrack();
    const { signal, model } = audioReadings(track);
    const full = (reading: (typeof signal)[number]) => {
      const { container } = render(<ReadingValue reading={reading} />);
      const text = container.textContent ?? '';
      cleanup();
      return text;
    };
    // The full view's lines, then what only its tooltip says.
    const expected = [...signal, ...model].map(
      (reading) => full(reading) + (reading.state === 'shown' ? (reading.note ?? '') : ''),
    );
    render(<AudioStats track={track} />);
    openAll();
    const shown = [
      ...within(screen.getByRole('list', { name: 'Audio values' })).getAllByRole('listitem'),
      ...within(screen.getByRole('list', { name: 'Audio-model estimates' })).getAllByRole(
        'listitem',
      ),
    ].map((li) => {
      const button = within(li).getByRole('button');
      const badge = li.querySelector('[data-variant]')?.textContent ?? '';
      return badge + panelOf(button).textContent;
    });
    expect(shown).toEqual(expected);
  });

  it('show each value with its confidence and basis once opened, loudness in dBFS RMS', () => {
    render(<AudioStats track={measuredTrack()} />);
    openAll();
    const values = screen.getByRole('list', { name: 'Audio values' });
    const opened = (list: HTMLElement, label: string) => {
      const found = within(list)
        .getAllByRole('listitem')
        .find((li) => li.textContent?.startsWith(label));
      if (!found) throw new Error(`No item ${label}`);
      return (
        (found.querySelector('[data-variant]')?.textContent ?? '') +
        panelOf(within(found).getByRole('button')).textContent
      );
    };
    expect(opened(values, 'BPM')).toBe(
      'BPM 123.1Measured · estimator confidence 3.30 of 5.32, not calibrated · signal, 29.8 s preview' +
        'essentia.RhythmExtractor2013 · analyzer 2.1.0+essentia.models-5c5c0c7f · the confidence does not flag half or double tempo',
    );
    expect(opened(values, 'Key')).toBe(
      'Key F# MinorMeasured · key strength 0.71 of 1, not a probability · signal, 29.8 s preview' +
        'essentia.KeyExtractor, edma profile · analyzer 2.1.0+essentia.models-5c5c0c7f',
    );
    expect(opened(values, 'Loudness')).toBe(
      'Loudness -13.6 dBFS RMSMeasured · direct measure · signal, 29.8 s preview' +
        'essentia.RMS, mean RMS 0.210 · analyzer 2.1.0+essentia.models-5c5c0c7f',
    );
    const scores = screen.getByRole('list', { name: 'Audio-model estimates' });
    expect(opened(scores, 'Dance')).toBe(
      'Dance 0.81Model estimate · score, not a probability · model discogs-effnet-bs64-1, 29.8 s preview' +
        'analyzer 2.1.0+essentia.models-5c5c0c7f' +
        'an estimate, not a measurement',
    );
    // DEAM valence is on 1-9: shown on its own scale, with no mood word read off it.
    expect(item(scores, 'Mood')).toContain('Mood 5.60 on 1–9');
    expect(scores.textContent).not.toMatch(/Measured/);
    expect(screen.queryByRole('region', { name: 'Missing data' })).toBeNull();
  });

  it('show a partly measured result: what was measured, and what was not with why', () => {
    const track = measuredTrack(
      audioBlock({ analyzerVersion: '2.1.0+essentia', key: null, fingerprint: null }),
      {
        key: null,
        audioSource: 'unavailable',
        audioConfidence: 'low',
        audioUnavailableReason: 'not_detected',
      },
    );
    render(
      <>
        <ResultNotices track={track} />
        <AudioStats track={track} />
      </>,
    );
    const values = screen.getByRole('list', { name: 'Audio values' });
    // "unavailable" does not hide the tempo the measurement has.
    expect(item(values, 'BPM')).toContain('BPM 123.1Measured from a 29.8 s preview');
    openAll();
    expect(item(values, 'BPM')).toContain('Measured · estimator confidence 3.30 of 5.32');
    expect(item(values, 'Key')).toBe('Key not measured— not detected in the preview');
    const scores = screen.getByRole('list', { name: 'Audio-model estimates' });
    expect(scores.textContent).toBe('Model scores not available— the audio models are not loaded');
    const notice = screen.getByRole('region', { name: 'Missing data' }).textContent;
    expect(notice).toBe(
      'Audio partly measured' +
        'The analysis ran but did not detect the key.' +
        'Not measured: key.' +
        'Audio-model estimates not available: mood, arousal, danceability, acousticness, instrumental, style scores, tag scores (the audio models are not loaded).',
    );
  });

  it('show nothing as measured behind a gate that did not pass, and say why', () => {
    const track = measuredTrack(
      audioBlock({
        gate: { passed: false, reason: 'silence' },
        tempo: null,
        key: null,
        loudness: null,
        keyMoments: [],
        fingerprint: null,
      }),
      { bpm: null, key: null, danceability: null, acousticness: null, audioSource: 'unavailable' },
    );
    render(
      <>
        <ResultNotices track={track} />
        <AudioStats track={track} />
      </>,
    );
    const values = screen.getByRole('list', { name: 'Audio values' });
    expect(item(values, 'BPM')).toBe('BPM not measured— the preview is silent');
    expect(values.textContent).not.toContain('Measured');
    const notice = screen.getByRole('region', { name: 'Missing data' }).textContent;
    expect(notice).toBe(
      'Audio not measuredNothing was measured on the preview: the preview is silent.',
    );
  });
});

describe('mood scores missing while style and tag scores are shown', () => {
  it('say "mood scores", not "model scores"', () => {
    const block = audioBlock();
    const track = measuredTrack(audioBlock({ fingerprint: { ...block.fingerprint, moods: null } }));
    render(<AudioStats track={track} />);
    expect(screen.getByRole('list', { name: 'Audio-model estimates' }).textContent).toBe(
      'Mood scores not available',
    );
  });
});

describe('the fingerprint from a measurement', () => {
  it('lists the style and tag scores as model estimates', () => {
    const { fingerprint } = audioReadings(measuredTrack());
    render(<SonicFingerprint fingerprint={fingerprint} />);
    const styles = screen.getByRole('region', { name: 'Styles (model estimate)' });
    expect(styles.textContent).toContain(
      'Model estimate · scores, not probabilities · model discogs-effnet-bs64-1, 29.8 s preview',
    );
    expect(
      within(styles)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Electronic / House 0.41', 'Electronic / Disco 0.22']);
    expect(screen.getByRole('region', { name: 'Tags (model estimate)' }).textContent).toContain(
      'electronic 0.63',
    );
    expect(document.body.textContent).not.toContain('No genre profile');
    expect(document.body.textContent).not.toMatch(/%/);
  });

  it('says why the scores are missing when the audio models are not loaded', () => {
    const { fingerprint } = audioReadings(
      measuredTrack(audioBlock({ analyzerVersion: '2.1.0+essentia', fingerprint: null })),
    );
    render(<SonicFingerprint fingerprint={fingerprint} />);
    expect(document.body.textContent).toBe(
      'Styles not available— the audio models are not loadedTags not available— the audio models are not loaded',
    );
  });
});

describe('the preview lane of a measurement', () => {
  it('spans the measured preview window and is labelled with it', () => {
    render(
      <SmartTimeline
        durationSeconds={240}
        previewSeconds={22.4}
        keyMoments={[
          { time: 4.2, type: 'onset', intensity: 0.8, description: 'Beat transition' },
          { time: 25, type: 'energy_peak', intensity: 1, description: 'Past the window' },
        ]}
        audioAnalyzed
      />,
    );
    const lane = screen.getByRole('group', { name: 'Preview window (22.4 s, measured)' });
    expect(lane.textContent).toContain('position in the song unknown');
    expect(lane.textContent).toContain('22.4 s');
    const moments = within(lane).getByRole('list', { name: 'Key moments' });
    expect(within(moments).getAllByRole('button')).toHaveLength(1);
    // No measured layer drawn besides it.
    expect(within(lane).queryAllByRole('img')).toHaveLength(0);
    // 4.2 s of a 22.4 s window, not of an assumed 30 s.
    expect(within(moments).getByRole('listitem').style.left).toBe(`${(4.2 / 22.4) * 100}%`);
    expect(screen.getByText('1 key moment outside the preview, not drawn')).toBeTruthy();
  });
});
