import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TrackData } from '../../types';
import { audioBlock, measuredTrack } from '../measured/testing';
import { resultClaims } from './claims';
import { RejectedClaims } from './RejectedClaims';
import { claim, evidence } from './testing';

afterEach(cleanup);

const claimsOf = (claims: unknown[]) =>
  resultClaims(
    measuredTrack(audioBlock(), { claims, evidence: [evidence()] } as Partial<TrackData>),
  );

describe('RejectedClaims', () => {
  const claims = claimsOf([
    claim({
      id: 'judged',
      text: 'First released in 1998.',
      evidenceIds: ['ev1'],
      verdict: 'contradicted',
      verdictReason: 'The record dates it to 2011.',
    }),
    claim({
      id: 'number',
      text: 'It runs at 90 BPM.',
      numericCheck: 'contradicted',
      field: 'tempo',
      evidenceIds: ['ev1'],
      numericComparison: { claimed: 90, measured: 99, method: 'stated by the producer' },
    }),
    claim({
      id: 'record',
      text: 'Mixed by Eve Example.',
      kind: 'sourced',
      origin: 'code',
      evidenceIds: ['ev1'],
      verdict: 'contradicted',
    }),
    claim({ id: 'fine', text: 'A fine claim.' }),
    { ...claim({ id: 'future', verdict: 'contradicted' }), about: 'lyrics' },
  ]);

  it('is collapsed, behind a button that names how many claims it holds', () => {
    render(<RejectedClaims rejected={claims.rejected} unreadable={claims.unreadableRejected} />);
    const button = screen.getByRole('button', { name: 'Rejected by the verifier (4)' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const panel = document.getElementById(button.getAttribute('aria-controls') ?? '');
    expect(panel?.hidden).toBe(true);
  });

  it('opens and closes, listing each claim with why it was rejected', () => {
    render(
      <RejectedClaims
        rejected={claims.rejected}
        unreadable={claims.unreadableRejected}
        audio={claims.audio}
      />,
    );
    const button = screen.getByRole('button', { name: /Rejected by the verifier/ });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const panel = document.getElementById(button.getAttribute('aria-controls') ?? '');
    expect(panel?.hidden).toBe(false);
    const items = [...(panel?.querySelectorAll('li') ?? [])].map((item) => item.textContent);
    expect(items).toHaveLength(3);
    expect(items[0]).toContain('First released in 1998.');
    expect(items[0]).toContain('Contradicted by its sources: The record dates it to 2011.');
    // A model claim's sources carry no tier.
    expect(items[0]).toContain('Checked against:MusicBrainz — Some Recording');
    // The measured side is the result's measurement.
    expect(items[1]).toContain(
      'Contradicted by the measurement: the claim says 90 · measured 123.1 BPM (essentia.RhythmExtractor2013, 29.8 s preview)',
    );
    expect(items[1]).not.toContain('99');
    // The judge did not check it: its sources are what it cites, not what it was checked against.
    expect(items[1]).toContain('Cites:MusicBrainz');
    expect(items[1]).not.toContain('Checked against');
    expect(items[2]).toContain('Contradicted by its sources: the verifier gave no reason');
    expect(items[2]).toContain('Checked against:MusicBrainz · primary record');
    expect(panel?.textContent).toContain('1 more rejected claim could not be read by this page.');
    expect(panel?.textContent).not.toContain('A fine claim.');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('is not shown when no claim was rejected', () => {
    const { container } = render(<RejectedClaims rejected={[]} />);
    expect(container.textContent).toBe('');
  });
});
