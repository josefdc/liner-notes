import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScoreListReading } from '../constants';
import SonicFingerprint from './SonicFingerprint';

// The note under the styles takes its numbers from the eval constant (measured/styleEval.ts),
// never from numbers written in the component: with other counts in the constant, the note
// says those.
vi.mock('./measured/styleEval', async (original) => {
  const actual = await original<typeof import('./measured/styleEval')>();
  return {
    ...actual,
    STYLE_EVAL: {
      ...actual.STYLE_EVAL,
      n: 40,
      hitAt1: 11,
      hitAt5: 23,
      baselineAt1: 2,
      baselineAt5: 9,
      date: '2027-01-02',
    },
  };
});

afterEach(cleanup);

const shown = (label: string, model: string): ScoreListReading => ({
  label,
  state: 'shown',
  items: [{ label: 'Electronic---House', score: 0.41 }],
  model,
  basis: `model ${model}, 29.8 s preview`,
  detail: 'analyzer 2.1.0',
  title: 'Activations',
});
const tags = shown('Tags', 'msd-musicnn-1');
const note = () => screen.queryByText(/Discogs styles, on/);

describe("the fingerprint's style accuracy note", () => {
  it('states the counts the eval constant holds', () => {
    render(
      <SonicFingerprint fingerprint={{ styles: shown('Styles', 'discogs-effnet-bs64-1'), tags }} />,
    );
    // One style shown: the note speaks of the model's strongest styles, not of the shown list.
    expect(note()?.textContent).toBe(
      "Against each release's Discogs styles, on 40 previews (audio eval report of 2027-01-02): " +
        "the model's strongest style matched for 11 of 40, one of its 5 strongest for 23 of 40 " +
        '(a fixed list of common styles: 2 and 9). ' +
        'The model was trained on Discogs data, which may include these releases.',
    );
    // Under the styles it describes, in a text colour, not the measured one.
    expect(note()?.closest('section')?.getAttribute('aria-label')).toBe('Styles (model estimate)');
    expect(note()?.className).not.toMatch(/prov-measured|cyber/);
  });

  it('is left out when no styles are shown, or they come from another model', () => {
    render(
      <SonicFingerprint
        fingerprint={{ styles: { label: 'Styles', state: 'missing', reason: null }, tags }}
      />,
    );
    expect(note()).toBeNull();
    cleanup();
    render(<SonicFingerprint fingerprint={{ styles: shown('Styles', 'other-model-2'), tags }} />);
    expect(note()).toBeNull();
  });
});
