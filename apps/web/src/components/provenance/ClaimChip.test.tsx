import type { Claim } from '@liner-notes/contract';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { audioReadings } from '../../constants';
import type { TrackData } from '../../types';
import { audioBlock, measuredTrack } from '../measured/testing';
import { resultClaims } from './claims';
import { ClaimChip } from './ClaimChip';
import { claim, evidence } from './testing';

afterEach(cleanup);

const track = (claims: unknown[], items: unknown[] = [evidence()], audio = audioBlock()) =>
  measuredTrack(audio, { claims, evidence: items } as Partial<TrackData>);

/** The one claim of a result, as shown, with the result's signal readings and measurement. */
function renderChip(result: TrackData) {
  const claims = resultClaims(result);
  const [shown] = claims.all;
  if (!shown) throw new Error('no claim');
  const { container } = render(
    <ClaimChip shown={shown} readings={audioReadings(result).signal} audio={claims.audio} />,
  );
  return container.firstElementChild as HTMLElement;
}

const TEMPO = 'essentia.RhythmExtractor2013';
const conflicting = (overrides: Partial<Claim> = {}) =>
  claim({
    numericCheck: 'conflict',
    field: 'tempo',
    // The measured side is never read from here.
    numericComparison: { claimed: 246, measured: 99, method: 'stated by the producer' },
    ...overrides,
  });

describe('ClaimChip', () => {
  it('shows a sourced claim with its kind, its source as a link and the tier, as text', () => {
    const chip = renderChip(
      track([claim({ kind: 'sourced', origin: 'code', evidenceIds: ['ev1'] })]),
    );
    expect(chip.dataset.claimKind).toBe('sourced');
    expect(chip.textContent).toContain('Sourced');
    expect(chip.textContent).toContain('Sources:MusicBrainz · primary record');
    expect(chip.textContent).toContain(
      'taken from the source record · not checked by the verifier',
    );
    const link = screen.getByRole('link', {
      name: 'MusicBrainz · primary record — Some Recording, opens in a new tab',
    });
    expect(link.getAttribute('href')).toBe('https://musicbrainz.org/recording/1');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    // The title is announced once, in the name.
    expect(link.hasAttribute('title')).toBe(false);
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

  it('never shows a web search result as a primary record', () => {
    const chip = renderChip(
      track(
        [claim({ kind: 'sourced', origin: 'code', evidenceIds: ['ev1'] })],
        [evidence({ source: 'tavily', sourceTier: 'primary-record', recordRef: null })],
      ),
    );
    expect(chip.textContent).toContain('Web search · web page');
    expect(chip.textContent).not.toContain('primary record');
  });

  it.each([
    ['work/9', 'about the song, not this recording'],
    ['release/3/credit/1', 'about a whole release'],
  ])('says a %s record is not about this recording, with or without a link', (recordRef, text) => {
    const linked = renderChip(
      track(
        [claim({ kind: 'sourced', origin: 'code', evidenceIds: ['ev1'] })],
        [evidence({ recordRef })],
      ),
    );
    expect(
      screen.getByRole('link', {
        name: new RegExp(`^MusicBrainz · primary record · ${text} — `),
      }),
    ).toBeTruthy();
    cleanup();
    const unlinked = renderChip(
      track([claim({ evidenceIds: ['ev1'] })], [evidence({ recordRef, url: null })]),
    );
    expect(unlinked.textContent).toContain(`MusicBrainz · ${text} (record ${recordRef})`);
    expect(linked).toBeTruthy();
  });

  it('names the part of a partly supported claim the verifier did not find, from its reason', () => {
    const chip = renderChip(
      track([
        claim({
          kind: 'sourced',
          evidenceIds: ['ev1'],
          verdict: 'partial',
          verdictReason: 'No engineer is listed.',
        }),
      ]),
    );
    expect(chip.dataset.claimKind).toBe('sourced');
    expect(chip.textContent).toContain('Partly supported');
    expect(chip.textContent).toContain('Partly supported: No engineer is listed.');
    cleanup();
    const noReason = renderChip(
      track([claim({ kind: 'sourced', evidenceIds: ['ev1'], verdict: 'partial' })]),
    );
    expect(noReason.textContent).toContain(
      'Partly supported: the verifier did not say which part is unsupported',
    );
  });

  it('never shows a code claim the verifier did not support as plainly sourced', () => {
    const chip = renderChip(
      track([
        claim({
          kind: 'sourced',
          origin: 'code',
          evidenceIds: ['ev1'],
          verdict: 'unsupported',
          verdictReason: 'The record lists no mastering engineer.',
        }),
      ]),
    );
    expect(chip.dataset.claimKind).toBe('sourced');
    expect(chip.textContent).toContain('Not supported');
    expect(chip.textContent).toContain(
      'Not supported by its sources: The record lists no mastering engineer.',
    );
  });

  it('gives the reason of a model claim the verifier did not support', () => {
    const chip = renderChip(
      track([
        claim({
          kind: 'sourced',
          evidenceIds: ['ev1'],
          verdict: 'unsupported',
          verdictReason: 'No studio is named.',
        }),
      ]),
    );
    expect(chip.dataset.claimKind).toBe('inferred');
    expect(chip.textContent).toContain('Not supported by its sources: No studio is named.');
  });

  it('says "not checked" for a model claim without a verdict, and never calls it sourced', () => {
    const chip = renderChip(track([claim({ evidenceIds: ['ev1'] })]));
    expect(chip.dataset.claimKind).toBe('inferred');
    expect(chip.textContent).toContain('Model inference');
    expect(chip.textContent).toContain('not checked by the verifier');
    expect(chip.textContent).not.toContain('Sourced');
    // A model's citation is listed, without a tier.
    expect(chip.textContent).toContain('Cited by the model:');
    expect(chip.textContent).not.toContain('primary record');
    expect(screen.getByRole('link', { name: /^MusicBrainz — Some Recording/ })).toBeTruthy();
  });

  it.each([
    [
      'cites evidence that is not in the pack',
      { kind: 'sourced', origin: 'code', evidenceIds: ['gone', 'ev1'] },
      'Not sourced',
    ],
    [
      'is a model claim the judge did not support',
      { kind: 'sourced', evidenceIds: ['ev1'], verdict: 'unsupported' },
      'Model inference',
    ],
    ['cites nothing', { kind: 'sourced', origin: 'code', evidenceIds: [] }, 'Not sourced'],
  ] satisfies Array<[string, Partial<Claim>, string]>)(
    'shows a sourced claim that %s as inferred, by whoever wrote it',
    (_case, change, label) => {
      const chip = renderChip(track([claim(change)]));
      expect(chip.dataset.claimKind).toBe('inferred');
      expect(chip.querySelector('span.border')?.textContent).toBe(label);
      expect(chip.textContent).not.toMatch(/Sourced|primary record/);
      const kindChip = chip.querySelector('[data-provenance]') as HTMLElement;
      if ('origin' in change && change.origin === 'code') {
        expect(chip.textContent).not.toContain('Model inference');
        expect(chip.textContent).not.toContain('Cited by the model');
        // No model wrote it: neither the model's violet nor its sparkles.
        expect(kindChip.dataset.provenance).toBe('unconfirmed');
        expect(kindChip.querySelector('svg.lucide-sparkles')).toBeNull();
      } else {
        expect(kindChip.dataset.provenance).toBe('inferred');
      }
    },
  );

  it('lists what a code claim cites without saying the model cited it', () => {
    const chip = renderChip(
      track([claim({ kind: 'measured', origin: 'code', field: 'tempo', evidenceIds: ['ev1'] })]),
    );
    expect(chip.textContent).toContain('Cites:MusicBrainz');
    expect(chip.textContent).not.toContain('Cited by the model');
  });

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
    // A measurement claim whose value was not measured: not confirmed, not "not sourced".
    const kindChip = chip.querySelector('[data-provenance]') as HTMLElement;
    expect(kindChip.dataset.provenance).toBe('unconfirmed');
    expect(kindChip.textContent).toBe('Not confirmed');
    expect(chip.textContent).not.toContain('Not sourced');
    const missing = chip.querySelector('[data-value-kind="missing"]');
    expect(missing?.textContent).toMatch(/^Key not measured— /);
  });

  it("takes a conflict's measured side from the result's measurement, never from the claim", () => {
    const chip = renderChip(track([conflicting()]));
    expect(chip.textContent).toContain('Conflict');
    expect(chip.textContent).toContain(
      `Conflict with the measurement: the claim says 246 · measured 123.1 BPM (${TEMPO}, 29.8 s preview)`,
    );
    expect(chip.textContent).not.toContain('99');
    // What was compared is said; its text has no verdict, its number was checked.
    expect(chip.textContent).toContain('no verifier verdict on its text');
    expect(chip.textContent).not.toContain('not checked');
  });

  it.each([
    ['no measurement', null],
    [
      'a gate that did not pass',
      audioBlock({
        gate: { passed: false, reason: 'silence' },
        tempo: null,
        key: null,
        loudness: null,
        keyMoments: [],
      }),
    ],
    ['no tempo', audioBlock({ tempo: null })],
  ])('says the measured side is not available with %s, inventing no window', (_case, audio) => {
    const chip = renderChip(track([conflicting()], [], audio as ReturnType<typeof audioBlock>));
    expect(chip.textContent).toContain(
      'Conflict with the measurement: the claim says 246 · the measured value is not available in this result',
    );
    expect(chip.textContent).not.toMatch(/s preview|measured \d/);
  });

  it("says when the result does not give the claim's value", () => {
    const chip = renderChip(track([conflicting({ numericComparison: undefined })]));
    expect(chip.textContent).toContain(
      `Conflict with the measurement: the result does not give the claim's value · measured 123.1 BPM (${TEMPO}, 29.8 s preview)`,
    );
  });

  it('shows no conflict when the numbers agree', () => {
    const chip = renderChip(track([claim({ numericCheck: 'consistent', field: 'tempo' })]));
    expect(chip.textContent).not.toContain('Conflict');
  });

  it('shows the measured value beside a claim that states a number no check compared', () => {
    const chip = renderChip(
      track([claim({ text: 'The preview measured 128 BPM.', field: 'tempo', evidenceIds: [] })]),
    );
    expect(chip.textContent).toContain(
      `not compared with the measurement · measured 123.1 BPM (${TEMPO}, 29.8 s preview)`,
    );
    expect(chip.textContent).not.toContain('128');
  });

  it("never takes that value from the claim's comparison, and adds nothing without one", () => {
    const compared = renderChip(
      track([
        claim({
          field: 'tempo',
          numericCheck: 'consistent',
          numericComparison: { claimed: 123, measured: 99, method: 'stated by the producer' },
        }),
      ]),
    );
    expect(compared.textContent).toContain(
      `agrees with the measurement · measured 123.1 BPM (${TEMPO}, 29.8 s preview)`,
    );
    expect(compared.textContent).not.toContain('99');
    cleanup();
    const unmeasured = renderChip(
      track([claim({ field: 'tempo' })], [], audioBlock({ tempo: null })),
    );
    expect(unmeasured.textContent).not.toMatch(/measured \d|compared with the measurement/);
    cleanup();
    const noField = renderChip(track([claim({})]));
    expect(noField.textContent).not.toContain('compared with the measurement');
  });

  it('says a consistent number was checked: only its text has no verdict', () => {
    const chip = renderChip(track([claim({ field: 'tempo', numericCheck: 'consistent' })]));
    expect(chip.textContent).toContain('no verifier verdict on its text');
    expect(chip.textContent).not.toContain('not checked');
  });

  it('never reads plainly supported when the support rests on sources not in this result', () => {
    const chip = renderChip(
      track([claim({ evidenceIds: ['ev1', 'gone'], kind: 'sourced', verdict: 'supported' })]),
    );
    expect(chip.dataset.claimKind).toBe('inferred');
    expect(chip.textContent).toContain(
      'found supported by sources that are not all in this result',
    );
    expect(chip.textContent).not.toContain('supported by its sources');
  });
});
