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
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the genealogy graph error boundary', () => {
  it('says the graph could not be drawn and keeps the rest of the Player', () => {
    // The production build: the log names the error only (Vitest runs as development).
    vi.stubEnv('DEV', false);
    const track = withGraph();
    render(<Player trackData={track} onBack={() => {}} />);

    const panel = document.querySelector('#panel-genealogy');
    expect(panel?.querySelector('[role="alert"]')?.textContent).toContain(
      'The connections graph could not be drawn',
    );
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain(track.title);
    expect(screen.getAllByRole('button', { name: /BACK TO BASE/ }).length).toBeGreaterThan(0);

    // Logged with the error's name only: neither the result's data nor the error's message,
    // which can carry it.
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls.map(([first]) => first));
    expect(logged).toContain('The connections graph could not be drawn (Error)');
    expect(logged).not.toContain(track.title);
    expect(logged).not.toContain('the graph failed');
  });

  it('logs the whole error and where it was thrown in development', () => {
    vi.stubEnv('DEV', true);
    render(<Player trackData={withGraph()} onBack={() => {}} />);
    const line = vi
      .mocked(console.error)
      .mock.calls.find(([first]) => first === 'The connections graph could not be drawn');
    if (!line) throw new Error('the boundary logged nothing');
    expect(line[1]).toBeInstanceOf(Error);
    expect((line[1] as Error).message).toBe('the graph failed');
    expect(line[2]).toEqual(expect.stringContaining('\n'));
  });

  it('puts the focus on the way back when the graph fails', () => {
    render(<Player trackData={withGraph()} onBack={() => {}} />);
    const panel = document.querySelector('#panel-genealogy');
    const retry = panel?.querySelector('[role="alert"] button');
    expect(retry?.textContent).toBe('Try again');
    expect(document.activeElement).toBe(retry);
  });
});
