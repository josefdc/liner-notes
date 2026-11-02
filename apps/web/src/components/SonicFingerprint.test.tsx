import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import SonicFingerprint, { RADAR_FLOOR, radarLayout, wrapLabel } from './SonicFingerprint';

afterEach(cleanup);

describe('SonicFingerprint', () => {
  it('says there is no genre profile instead of drawing a placeholder shape', () => {
    const { container } = render(<SonicFingerprint modelUnavailable />);
    expect(screen.getByText('No genre profile')).toBeTruthy();
    expect(screen.getByText(/model was unavailable/)).toBeTruthy();
    expect(container.querySelector('.recharts-responsive-container')).toBeNull();
    // No default genres stand in for the missing profile.
    expect(container.textContent).not.toMatch(/Hip Hop|Jazz|R&B/);
  });

  it('draws the genre profile when there is one', () => {
    const { container } = render(
      <SonicFingerprint
        genreProfile={[
          { genre: 'Synthpop', value: 80 },
          { genre: 'Electronic', value: 70 },
          { genre: 'Rock', value: 20 },
        ]}
      />,
    );
    expect(container.querySelector('.recharts-responsive-container')).not.toBeNull();
    expect(screen.queryByText('No genre profile')).toBeNull();
  });
});

const USUAL = ['Synthpop', 'Electronic', 'Rock', 'Pop', 'Ambient'];

describe('radarLayout', () => {
  it("is Recharts' 70% until the chart is measured, and where the labels fit beside it", () => {
    expect(radarLayout(null, USUAL)).toEqual({ radius: '70%', maxChars: null });
    // 70% of half of (400 - 10): the labels (10 characters, 72 px) fit beside it.
    const wide = radarLayout({ width: 600, height: 400 }, USUAL);
    expect(wide.radius).toBeCloseTo(136.5);
    expect(wide.maxChars).toBeNull();
  });

  it('shrinks so that the longest label ends inside a narrow chart, unwrapped', () => {
    const width = 245;
    const { radius, maxChars } = radarLayout({ width, height: 600 }, USUAL);
    // The ring, the 12 px from it to a label, and 10 characters of 7.2 px, from the centre.
    expect((radius as number) + 12 + 10 * 7.2).toBeLessThanOrEqual(width / 2);
    expect(radius).toBeGreaterThanOrEqual(RADAR_FLOOR);
    expect(maxChars).toBeNull();
  });

  it('keeps the floor with a 22-character label in a 245 px chart, and wraps the labels to fit', () => {
    const width = 245;
    const labels = ['Electronic Dance Music', 'Funk', 'Soul', 'Hip Hop', 'Contemporary R&B'];
    const { radius, maxChars } = radarLayout({ width, height: 500 }, labels);
    expect(radius).toBeGreaterThanOrEqual(RADAR_FLOOR);
    expect(maxChars).not.toBeNull();
    for (const label of labels) {
      for (const line of wrapLabel(label, maxChars as number)) {
        expect((radius as number) + 12 + line.length * 7.2).toBeLessThanOrEqual(width / 2);
      }
    }
  });

  it('never draws the radar below the floor, however long a label is', () => {
    for (const width of [245, 308, 329, 382]) {
      const { radius } = radarLayout({ width, height: 500 }, ['A'.repeat(40), 'Pop']);
      expect(radius).toBeGreaterThanOrEqual(RADAR_FLOOR);
    }
  });
});

describe('wrapLabel', () => {
  it('breaks at spaces, and cuts a word longer than a line with an ellipsis', () => {
    expect(wrapLabel('Alternative Rock', 10)).toEqual(['Alternati…', 'Rock']);
    expect(wrapLabel('Electronic Dance Music', 12)).toEqual(['Electronic', 'Dance Music']);
    expect(wrapLabel('Singer-Songwriter', 10)).toEqual(['Singer-So…']);
    expect(wrapLabel('Pop', 10)).toEqual(['Pop']);
  });

  it('keeps at most three lines, the last ending in an ellipsis', () => {
    expect(wrapLabel('one two three four five', 5)).toEqual(['one', 'two', 'thre…']);
    expect(wrapLabel('aa bb cc dd', 2)).toEqual(['aa', 'bb', 'c…']);
  });
});
