import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppPhase, type TrackData } from './types';

// Back and Forward between two results shown on this page: the Player of one fails, the other's
// does not. The screen's error boundary starts afresh for each result.

const GOOD = '4uLU6hMCjMI75M1A2tKUQC';
const BROKEN = '28cnXtME493VX9NOw9cIUh';
const SECOND = '1aBcDeFgHiJkLmNoPqRsTu';

const resultFor = (id: string) =>
  ({
    id,
    title: `Track ${id}`,
    artist: 'Someone',
    genealogy: { nodes: [], links: [] },
  }) as unknown as TrackData;

vi.mock('./hooks/agent/storedRun', () => ({
  fetchStoredRun: async (id: string) => ({ kind: 'found', track: resultFor(id) }),
}));

// The Player of BROKEN throws; any other shows its title.
vi.mock('./components/Player', () => ({
  default: ({ trackData }: { trackData: TrackData | null }) => {
    if (trackData?.id === BROKEN) throw new Error('the Player failed');
    return <h1 tabIndex={-1}>Player of {trackData?.title}</h1>;
  },
}));

import App from './App';

/** Moves through the history as Back or Forward does: to an entry the app wrote. */
async function moveTo(trackId: string, index: number) {
  await act(async () => {
    window.history.replaceState(
      { phase: AppPhase.PLAYER, index, url: `/t/${trackId}` },
      '',
      `/t/${trackId}`,
    );
    window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
  });
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  window.history.replaceState({ phase: AppPhase.PLAYER, index: 0 }, '', `/t/${GOOD}`);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('the screen error boundary across results', () => {
  it('shows the other result after Back from a result whose Player failed', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: `Player of Track ${GOOD}` });

    // Forward to a result not shown yet: its stored result loads, and its Player fails.
    await moveTo(BROKEN, 1);
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('This screen could not be shown'),
    );

    // Back to the first result, shown on this page already: no new screen in between.
    await moveTo(GOOD, 0);
    await screen.findByRole('heading', { name: `Player of Track ${GOOD}` });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps the screen mounted between two results, so its heading keeps the focus', async () => {
    render(<App />);
    await screen.findByRole('heading', { name: `Player of Track ${GOOD}` });
    await moveTo(SECOND, 1);
    const heading = await screen.findByRole('heading', { name: `Player of Track ${SECOND}` });
    heading.focus();

    // Back to the first result, shown on this page already: the same screen shows it.
    await moveTo(GOOD, 0);
    await screen.findByRole('heading', { name: `Player of Track ${GOOD}` });
    expect(screen.getByRole('heading', { level: 1 })).toBe(heading);
    expect(document.activeElement).toBe(heading);
  });
});
