import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplayTrack } from '../hooks/agent/apiClient';
import BudgetBanner from './BudgetBanner';
import { isLiveUnavailable } from '../liveUnavailable';

afterEach(cleanup);

const TRACK: ReplayTrack = {
  id: '0DiWol3AO6WpXZgp0goxAV',
  title: 'One More Time',
  artist: 'Daft Punk',
  album: 'Discovery',
  recordedAt: '2026-10-22T14:03:00.000Z',
};

describe('BudgetBanner', () => {
  it('says live analysis is paused and offers the recorded tracks, with their recording date', async () => {
    const onPick = vi.fn();
    render(
      <BudgetBanner
        code="budget_exhausted"
        onPick={onPick}
        loadReplays={() => Promise.resolve([TRACK])}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Live analysis paused' })).toBeTruthy();
    expect(screen.getByText(/budget for live analysis is spent/)).toBeTruthy();
    expect(screen.getByText(/labelled as a recording, not a live analysis/)).toBeTruthy();

    const pick = await screen.findByRole('button', { name: /One More Time/ });
    expect(pick.textContent).toContain('Daft Punk • recorded 22 Oct 2026');
    fireEvent.click(pick);
    expect(onPick).toHaveBeenCalledWith(TRACK);
  });

  it('explains live_disabled: this server only replays recorded runs', async () => {
    render(
      <BudgetBanner
        code="live_disabled"
        onPick={() => {}}
        loadReplays={() => Promise.resolve([TRACK])}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Live analysis is off here' })).toBeTruthy();
    expect(
      screen.getByText(/does not analyze songs live right now: it only replays recorded runs/),
    ).toBeTruthy();
    expect(await screen.findByRole('list', { name: 'Recorded tracks' })).toBeTruthy();
  });

  it('says so when there are no recorded tracks, or they cannot be loaded; never shows a result', async () => {
    const { unmount } = render(
      <BudgetBanner
        code="budget_exhausted"
        onPick={() => {}}
        loadReplays={() => Promise.resolve([])}
      />,
    );
    expect(await screen.findByText(/No recorded tracks are available/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    unmount();

    render(
      <BudgetBanner
        code="budget_exhausted"
        onPick={() => {}}
        loadReplays={() => Promise.reject(new Error('HTTP 503'))}
      />,
    );
    expect(await screen.findByText(/recorded tracks could not be loaded/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('BudgetBanner announcement', () => {
  it('is an alert and takes the focus, which the re-mounted search form lost', () => {
    render(
      <BudgetBanner
        code="budget_exhausted"
        onPick={() => {}}
        loadReplays={() => new Promise(() => {})}
      />,
    );
    const heading = screen.getByRole('heading', { name: 'Live analysis paused' });
    expect(screen.getByRole('alert').contains(heading)).toBe(true);
    expect(document.activeElement).toBe(heading);
  });
});

describe('isLiveUnavailable', () => {
  it('is true for the two codes that mean no live analysis here, and only those', () => {
    expect(isLiveUnavailable('budget_exhausted')).toBe(true);
    expect(isLiveUnavailable('live_disabled')).toBe(true);
    expect(isLiveUnavailable('timeout')).toBe(false);
    expect(isLiveUnavailable(null)).toBe(false);
  });
});
