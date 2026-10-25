import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TrackData } from '../../types';
import { audioBlock, measuredTrack } from '../measured/testing';
import { resultClaims } from './claims';
import { RejectedClaims } from './RejectedClaims';
import { claim, evidence } from './testing';

afterEach(cleanup);

const rejectedOf = (claims: unknown[]) =>
  resultClaims(
    measuredTrack(audioBlock(), { claims, evidence: [evidence()] } as Partial<TrackData>),
  ).rejected;

describe('RejectedClaims', () => {
  const rejected = rejectedOf([
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
      numericComparison: { claimed: 90, measured: 123.05, method: 'essentia.RhythmExtractor2013' },
    }),
    claim({ id: 'fine', text: 'A fine claim.' }),
  ]);

  it('is collapsed, behind a button that names how many claims it holds', () => {
    render(<RejectedClaims rejected={rejected} />);
    const button = screen.getByRole('button', { name: 'Rejected by the verifier (2)' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    const panel = document.getElementById(button.getAttribute('aria-controls') ?? '');
    expect(panel?.hidden).toBe(true);
  });

  it('opens and closes, listing each claim with why it was rejected', () => {
    render(<RejectedClaims rejected={rejected} windowSeconds={29.75} />);
    const button = screen.getByRole('button', { name: /Rejected by the verifier/ });
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const panel = document.getElementById(button.getAttribute('aria-controls') ?? '');
    expect(panel?.hidden).toBe(false);
    const items = [...(panel?.querySelectorAll('li') ?? [])].map((item) => item.textContent);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('First released in 1998.');
    expect(items[0]).toContain('Contradicted by its sources: The record dates it to 2011.');
    expect(items[0]).toContain('Checked against:MusicBrainz · primary record');
    expect(items[1]).toContain(
      'Contradicted by the measurement: the claim says 90 · measured 123.05 (essentia.RhythmExtractor2013, 29.8 s preview)',
    );
    expect(panel?.textContent).not.toContain('A fine claim.');
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('is not shown when no claim was rejected', () => {
    const { container } = render(<RejectedClaims rejected={[]} />);
    expect(container.textContent).toBe('');
  });
});
