import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A graph that cannot be drawn: whatever it is given, it throws.
vi.mock('./GenealogyGraph', () => ({
  default: () => {
    throw new Error('the graph failed');
  },
}));

import type { TrackData } from '../types';
import Player from './Player';
import { provenanceTrack } from './provenance/testing';

function withGraph(): TrackData {
  const track = provenanceTrack();
  return {
    ...track,
    genealogy: {
      nodes: [
        { id: 'current', group: 1, label: 'Paper Lanterns - Test Artist (2011)', size: 40 },
        { id: 'older', group: 2, label: 'Old Record - Someone (1984)', size: 22 },
      ],
      links: [{ source: 'older', target: 'current', value: 1, type: 'influence' }],
    },
  } as TrackData;
}

beforeEach(() => {
  // React reports the caught error too; the test reads only the boundary's own line.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the genealogy graph error boundary', () => {
  it('says the graph could not be drawn and keeps the rest of the Player', () => {
    const track = withGraph();
    render(<Player trackData={track} onBack={() => {}} />);

    const panel = document.querySelector('#panel-genealogy');
    expect(panel?.querySelector('[role="alert"]')?.textContent).toContain(
      'The connections graph could not be drawn',
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(track.title);
    expect(screen.getAllByRole('button', { name: /BACK TO BASE/ }).length).toBeGreaterThan(0);

    // Logged without the result's data.
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls.map(([first]) => first));
    expect(logged).toContain('The connections graph could not be drawn');
    expect(logged).not.toContain(track.title);
  });
});
