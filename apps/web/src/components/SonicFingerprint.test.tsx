import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import SonicFingerprint, { radarRadius } from './SonicFingerprint';

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

describe('radarRadius', () => {
  it("is Recharts' 70% until the chart is measured, and where the labels fit beside it", () => {
    expect(radarRadius(null, 10)).toBe('70%');
    // 70% of half of (400 - 10): the labels (10 characters, 72 px) fit beside it.
    expect(radarRadius({ width: 600, height: 400 }, 10)).toBeCloseTo(136.5);
  });

  it('shrinks so that the longest label ends inside a narrow chart', () => {
    const width = 245;
    const radius = radarRadius({ width, height: 600 }, 10) as number;
    // The ring, the 12 px from it to a label, and 10 characters of 7.2 px, from the centre.
    expect(radius + 12 + 10 * 7.2).toBeLessThanOrEqual(width / 2);
    expect(radius).toBeGreaterThan(0);
  });
});
