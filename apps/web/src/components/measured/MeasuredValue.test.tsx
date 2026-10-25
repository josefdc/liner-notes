import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { audioReadings } from '../../constants';
import { AudioStats, ResultNotices } from '../EstimatedWarning';
import SmartTimeline from '../SmartTimeline';
import SonicFingerprint from '../SonicFingerprint';
import { MeasuredValue } from './MeasuredValue';
import { MissingValue } from './MissingValue';
import { audioBlock, measuredTrack } from './testing';

afterEach(cleanup);

const item = (list: HTMLElement, label: string) => {
  const found = within(list)
    .getAllByRole('listitem')
    .find((li) => li.textContent?.startsWith(label));
  if (!found) throw new Error(`No item ${label}`);
  return found.textContent ?? '';
};

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

describe('audio values from a measurement', () => {
  it('show each value with its confidence and basis, loudness in dBFS RMS', () => {
    render(<AudioStats track={measuredTrack()} />);
    const values = screen.getByRole('list', { name: 'Audio values' });
    expect(item(values, 'BPM')).toBe(
      'BPM 123.1Measured · estimator confidence 3.30 of 5.32, not calibrated · signal, 29.8 s preview' +
        'essentia.RhythmExtractor2013 · analyzer 2.1.0+essentia.models-5c5c0c7f · the confidence does not flag half or double tempo',
    );
    expect(item(values, 'Key')).toBe(
      'Key F# MinorMeasured · key strength 0.71 of 1, not a probability · signal, 29.8 s preview' +
        'essentia.KeyExtractor, edma profile · analyzer 2.1.0+essentia.models-5c5c0c7f',
    );
    expect(item(values, 'Loudness')).toBe(
      'Loudness -13.6 dBFS RMSMeasured · direct measure · signal, 29.8 s preview' +
        'essentia.RMS, mean RMS 0.210 · analyzer 2.1.0+essentia.models-5c5c0c7f',
    );
    const scores = screen.getByRole('list', { name: 'Audio-model estimates' });
    expect(item(scores, 'Dance')).toBe(
      'Dance 0.81Model estimate · score, not a probability · model discogs-effnet-bs64-1, 29.8 s preview' +
        'analyzer 2.1.0+essentia.models-5c5c0c7f',
    );
    // DEAM valence is on 1-9: shown on its own scale, with no mood word read off it.
    expect(item(scores, 'Mood')).toContain('Mood 5.60 on 1–9');
    expect(scores.textContent).not.toMatch(/Measured/);
    expect(screen.queryByRole('region', { name: 'Missing data' })).toBeNull();
  });

  it('show a partly measured result: what was measured, and what was not with why', () => {
    const track = measuredTrack(audioBlock({ key: null, fingerprint: null }), {
      key: null,
      audioSource: 'unavailable',
      audioConfidence: 'low',
      audioUnavailableReason: 'not_detected',
    });
    render(
      <>
        <ResultNotices track={track} />
        <AudioStats track={track} />
      </>,
    );
    const values = screen.getByRole('list', { name: 'Audio values' });
    // "unavailable" does not hide the tempo the measurement has.
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
    const { fingerprint } = audioReadings(measuredTrack(audioBlock({ fingerprint: null })));
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
    expect(within(lane).getAllByRole('img')).toHaveLength(1);
    // 4.2 s of a 22.4 s window, not of an assumed 30 s.
    expect((within(lane).getByRole('img') as HTMLElement).style.left).toBe(
      `${(4.2 / 22.4) * 100}%`,
    );
    expect(screen.getByText('1 key moment outside the preview, not drawn')).toBeTruthy();
  });
});
