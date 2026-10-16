import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import SonicFingerprint from './SonicFingerprint';

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
