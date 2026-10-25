import type { Claim } from '@liner-notes/contract';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { audioReadings } from '../../constants';
import type { TrackData } from '../../types';
import { audioBlock, measuredTrack } from '../measured/testing';
import { resultClaims, type ShownClaim } from './claims';
import { ClaimChip } from './ClaimChip';
import { claim, evidence } from './testing';

afterEach(cleanup);

const track = (claims: unknown[], items: unknown[] = [evidence()], audio = audioBlock()) =>
  measuredTrack(audio, { claims, evidence: items } as Partial<TrackData>);

/** The one claim of a result, as shown, and the result's signal readings. */
function shownOf(result: TrackData): {
  shown: ShownClaim;
  readings: ReturnType<typeof audioReadings>['signal'];
} {
  const [shown] = resultClaims(result).all;
  if (!shown) throw new Error('no claim');
  return { shown, readings: audioReadings(result).signal };
}

function renderChip(result: TrackData) {
  const { shown, readings } = shownOf(result);
  const { container } = render(
    <ClaimChip shown={shown} readings={readings} windowSeconds={29.75} />,
  );
  return container.firstElementChild as HTMLElement;
}

describe('ClaimChip', () => {
  it('shows a sourced claim with its kind, its source as a link and the tier, as text', () => {
    const chip = renderChip(
      track([claim({ kind: 'sourced', origin: 'code', evidenceIds: ['ev1'] })]),
    );
    expect(chip.dataset.claimKind).toBe('sourced');
    expect(chip.textContent).toContain('Sourced');
    expect(chip.textContent).toContain('MusicBrainz · primary record');
    expect(chip.textContent).toContain('taken from the source record · not checked');
    const link = screen.getByRole('link', {
      name: 'MusicBrainz · primary record — Some Recording, opens in a new tab',
    });
    expect(link.getAttribute('href')).toBe('https://musicbrainz.org/recording/1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('never links a source whose address is not http or https', () => {
    const chip = renderChip(
      track(
        [claim({ kind: 'sourced', origin: 'code', evidenceIds: ['ev1'] })],
        [evidence({ url: 'javascript:alert(1)', source: 'genius' })],
      ),
    );
    expect(screen.queryByRole('link')).toBeNull();
    expect(chip.querySelector('[href]')).toBeNull();
    expect(chip.textContent).toContain('Genius · primary record (record track/recording/1)');
  });

  it('marks a partly supported model claim', () => {
    const chip = renderChip(
      track([claim({ kind: 'sourced', evidenceIds: ['ev1'], verdict: 'partial' })]),
    );
    expect(chip.dataset.claimKind).toBe('sourced');
    expect(chip.textContent).toContain('Partly supported');
  });

  it('says "not checked" for a model claim without a verdict, and never calls it sourced', () => {
    const chip = renderChip(track([claim({ evidenceIds: ['ev1'] })]));
    expect(chip.dataset.claimKind).toBe('inferred');
    expect(chip.textContent).toContain('Model inference');
    expect(chip.textContent).toContain('not checked');
    expect(chip.textContent).not.toContain('Sourced');
    // A model's citation is listed, without a tier.
    expect(chip.textContent).toContain('Cited by the model:');
    expect(chip.textContent).not.toContain('primary record');
    expect(screen.getByRole('link', { name: /^MusicBrainz — Some Recording/ })).toBeTruthy();
  });

  it.each([
    [
      'cites evidence that is not in the pack',
      { kind: 'sourced', origin: 'code', evidenceIds: ['gone'] },
    ],
    [
      'is a model claim the judge did not support',
      { kind: 'sourced', evidenceIds: ['ev1'], verdict: 'unsupported' },
    ],
    ['cites nothing', { kind: 'sourced', origin: 'code', evidenceIds: [] }],
  ] satisfies Array<[string, Partial<Claim>]>)(
    'shows a sourced claim that %s as model inference',
    (_case, change) => {
      const chip = renderChip(track([claim(change)]));
      expect(chip.dataset.claimKind).toBe('inferred');
      expect(chip.textContent).toContain('Model inference');
      expect(chip.textContent).not.toMatch(/Sourced|primary record/);
    },
  );

  it('counts the cited sources that are not in the result', () => {
    const chip = renderChip(track([claim({ evidenceIds: ['ev1', 'gone', 'lost'] })]));
    expect(chip.textContent).toContain('2 cited sources are not in this result');
  });

  it('shows a measured claim with the measured value, its confidence and basis', () => {
    const chip = renderChip(track([claim({ kind: 'measured', origin: 'code', field: 'tempo' })]));
    expect(chip.dataset.claimKind).toBe('measured');
    const value = chip.querySelector('[data-value-kind="measured"]');
    expect(value?.textContent).toContain('BPM 123.1');
    expect(value?.textContent).toContain('Measured · estimator confidence');
    expect(chip.textContent).not.toContain('not checked');
  });

  it('shows a claim about a value that was not measured with that value missing, and why', () => {
    const result = track(
      [claim({ kind: 'measured', origin: 'code', field: 'key' })],
      [],
      audioBlock({ key: null }),
    );
    const chip = renderChip({ ...result, audioUnavailableReason: 'not_detected' });
    expect(chip.dataset.claimKind).toBe('inferred');
    expect(chip.textContent).toContain('Model inference');
    const missing = chip.querySelector('[data-value-kind="missing"]');
    expect(missing?.textContent).toMatch(/^Key not measured— /);
  });

  it('shows both values of a conflict with the measurement, with the method and window', () => {
    const chip = renderChip(
      track([
        claim({
          numericCheck: 'conflict',
          field: 'tempo',
          numericComparison: {
            claimed: 246,
            measured: 123.05,
            method: 'essentia.RhythmExtractor2013',
          },
        }),
      ]),
    );
    expect(chip.textContent).toContain('Conflict');
    expect(chip.textContent).toContain(
      'Conflict with the measurement: the claim says 246 · measured 123.05 (essentia.RhythmExtractor2013, 29.8 s preview)',
    );
  });

  it('says there is a conflict without making up values when the result gives none', () => {
    const chip = renderChip(track([claim({ numericCheck: 'conflict', field: 'tempo' })]));
    expect(chip.textContent).toContain(
      'Conflict with the measurement; the result does not give the two values',
    );
    expect(chip.textContent).not.toMatch(/measured \d/);
  });

  it('shows no conflict when the numbers agree', () => {
    const chip = renderChip(track([claim({ numericCheck: 'consistent', field: 'tempo' })]));
    expect(chip.textContent).not.toContain('Conflict');
  });
});
