import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackData } from '../types';

// A Sonic Fingerprint chart that throws `failure` while `broken` (a draw error by default), and
// draws after.
let broken = true;
let failure = () => new Error('the chart failed');
vi.mock('./SonicFingerprint', () => ({
  default: () => {
    if (broken) throw failure();
    return <p>The chart</p>;
  },
}));

import Dashboard from './Dashboard';

const track = {
  id: 't1',
  title: 'Quiet Signal',
  artist: 'Test Artist',
  album: 'Test Album',
  coverUrl: '',
  segments: [],
  samples: [],
  factoids: [],
  genealogy: { nodes: [{ id: 'current', group: 1, label: 'Quiet Signal', size: 40 }], links: [] },
} as unknown as TrackData;

beforeEach(() => {
  broken = true;
  failure = () => new Error('the chart failed');
  // React reports the caught error too.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the Sonic Fingerprint panel when its chart cannot be drawn', () => {
  it('keeps the rest of the Dashboard, and takes the focus after "Try again"', async () => {
    render(<Dashboard trackData={track} onNavigate={() => {}} isRestoredSession />);
    const panel = screen.getByRole('region', { name: 'Sonic Fingerprint' });
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain('The Sonic Fingerprint could not be drawn');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('Quiet Signal');

    const retry = within(alert).getByRole('button', { name: 'Try again' });
    retry.focus();
    broken = false;
    fireEvent.click(retry);
    await waitFor(() => expect(within(panel).getByText('The chart')).toBeTruthy());
    // The button that had the focus is gone: the panel has it, not the page.
    expect(document.activeElement).toBe(panel);
  });

  // The chart's code could not be loaded (as Chromium reports it).
  const chunkFailure = () =>
    new TypeError(
      'Failed to fetch dynamically imported module: http://x/assets/SonicFingerprint-1a2b.js',
    );

  it('offers "Reload the page" for a result kept at its address', async () => {
    failure = chunkFailure;
    render(
      <Dashboard
        trackData={{ ...track, id: '4cOdK2wGLETKBW3PvgPWqT' }}
        onNavigate={() => {}}
        isRestoredSession
      />,
    );
    const panel = screen.getByRole('region', { name: 'Sonic Fingerprint' });
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain('The Sonic Fingerprint could not be loaded');
    expect([...alert.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'Try again',
      'Reload the page',
    ]);
  });

  it('does not offer "Reload the page" for a result a reload would lose', async () => {
    // A result under a placeholder id has no address of its own (App.tsx, addressOf).
    failure = chunkFailure;
    render(<Dashboard trackData={track} onNavigate={() => {}} isRestoredSession />);
    const panel = screen.getByRole('region', { name: 'Sonic Fingerprint' });
    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain('The Sonic Fingerprint could not be loaded');
    expect([...alert.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'Try again',
    ]);
  });
});
