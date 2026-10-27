import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Onboarding from './Onboarding';
import { waitText } from '../hooks/useTimeLeft';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** The error block of a run that failed with `errorCode`; `retryAt` as useAgent gives it. */
function failedWith(
  errorCode: string,
  error = 'The run failed.',
  { retryAt = null, retry = vi.fn() }: { retryAt?: number | null; retry?: () => void } = {},
) {
  return render(
    <Onboarding
      status="error"
      logs={[]}
      trackData={null}
      error={error}
      errorCode={errorCode}
      isLoading={false}
      candidates={null}
      analyze={vi.fn(async () => {})}
      selectCandidate={vi.fn(async () => {})}
      retry={retry}
      retryAt={retryAt}
      searchSuggest={vi.fn(async () => [])}
      onComplete={vi.fn()}
    />,
  );
}

describe('Onboarding errors', () => {
  it('offers a new check when the Turnstile check gave no token', () => {
    for (const [code, text] of [
      ['verification_unavailable', /could not be loaded\. A content blocker or the network/],
      ['verification_failed', /did not pass\. Try again to run it again\./],
      ['verification_timeout', /did not finish in time\. Try again to run it again\./],
    ] as const) {
      const view = failedWith(code, 'The check failed (300030).');
      expect(screen.getByText(text)).toBeTruthy();
      // The widget's own words (an error code) are not shown.
      expect(screen.queryByText(/300030/)).toBeNull();
      expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
      view.unmount();
    }
  });

  /** The wait line, the live region, the heading's description and the retry button. */
  const waitView = () => {
    const heading = screen.getByRole('heading', { name: 'The analysis did not finish' });
    const described = (heading.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' ');
    return {
      line: document.getElementById('error-wait')?.textContent ?? null,
      described,
      status: document.getElementById('error-retry-ready')?.textContent,
      button: screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement,
    };
  };

  it('keeps "Try again" disabled, saying how long is left, until the wait is over', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-10-27T12:00:00.000Z');
    vi.setSystemTime(now);
    const retry = vi.fn();
    failedWith('rate_limited', 'Too many requests. Please try again later.', {
      retryAt: now + 42_000,
      retry,
    });
    // The heading takes the focus, described by the refusal and the time left.
    expect(document.activeElement?.textContent).toBe('The analysis did not finish');
    expect(waitView()).toMatchObject({
      line: 'You can try again in 42 s.',
      described: 'Too many requests. Please try again later. You can try again in 42 s.',
      status: '',
    });
    expect(waitView().button.disabled).toBe(true);
    fireEvent.click(waitView().button);
    expect(retry).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(41_000);
    });
    // Counted down where it is seen, never announced while it runs.
    expect(waitView()).toMatchObject({ line: 'You can try again in 1 s.', status: '' });
    expect(waitView().button.disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(waitView().button.disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    // Over: said once, through the polite live region.
    expect(waitView()).toMatchObject({
      line: null,
      described: 'Too many requests. Please try again later.',
      status: 'You can try again now.',
    });
    const live = document.getElementById('error-retry-ready');
    expect(live?.getAttribute('role')).toBe('status');
    expect(live?.getAttribute('class')).toContain('sr-only');
    expect(waitView().button.disabled).toBe(false);
    fireEvent.click(waitView().button);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('reads the clock, not its own timers: right at once when the tab is shown again', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-10-27T12:00:00.000Z');
    vi.setSystemTime(now);
    failedWith('rate_limited', 'Too many requests.', { retryAt: now + 125_000 });
    expect(waitView().line).toBe('You can try again in 2 min 5 s.');

    // A tab in the background: the clock moves on while its timers are held back.
    vi.setSystemTime(now + 120_000);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(waitView().line).toBe('You can try again in 5 s.');
    vi.setSystemTime(now + 200_000);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(waitView().button.disabled).toBe(false);
    expect(waitView().status).toBe('You can try again now.');
  });

  it('says a wait of an hour or more in hours and minutes', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-10-27T12:00:00.000Z');
    vi.setSystemTime(now);
    failedWith('rate_limited', 'Too many requests.', { retryAt: now + 65 * 60_000 });
    expect(waitView().line).toBe('You can try again in 1 h 5 min.');
    expect(waitText(60 * 60_000)).toBe('1 h');
    expect(waitText(60 * 60_000 + 1)).toBe('1 h 1 min');
    expect(waitText(86_400_000)).toBe('24 h');
    expect(waitText(59 * 60_000 + 59_500)).toBe('1 h');
    expect(waitText(Number.POSITIVE_INFINITY)).toBe('a while');
    expect(waitText(1e23)).not.toMatch(/e\+|Infinity|NaN/);
  });

  it('offers the retry at once when the refusal named no wait, or the wait is over', () => {
    failedWith('rate_limited', 'Too many requests.', { retryAt: Date.now() - 1 });
    expect((screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(document.getElementById('error-wait')).toBeNull();
  });

  it('offers a retry when the analysis could not be started', () => {
    failedWith('stream_open_failed');
    expect(
      screen.getByText('The analysis could not be started. Try again in a moment.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
