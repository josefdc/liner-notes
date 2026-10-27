import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Onboarding from './Onboarding';

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

  it('keeps "Try again" disabled, saying how long is left, until the wait is over', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-10-27T12:00:00.000Z');
    vi.setSystemTime(now);
    const retry = vi.fn();
    failedWith('rate_limited', 'Too many requests. Please try again later.', {
      retryAt: now + 42_000,
      retry,
    });
    expect(screen.getByText('Too many requests. Please try again later.')).toBeTruthy();
    const button = () => screen.getByRole('button', { name: /^Try again/ }) as HTMLButtonElement;
    expect(button().textContent).toBe('Try again in 42 s');
    expect(button().disabled).toBe(true);
    fireEvent.click(button());
    expect(retry).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(41_000);
    });
    expect(button().textContent).toBe('Try again in 1 s');
    expect(button().disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(button().disabled).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(button().textContent).toBe('Try again');
    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('reads the clock, not its own timers: right at once when the tab is shown again', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-10-27T12:00:00.000Z');
    vi.setSystemTime(now);
    failedWith('rate_limited', 'Too many requests.', { retryAt: now + 125_000 });
    const button = () => screen.getByRole('button', { name: /^Try again/ }) as HTMLButtonElement;
    expect(button().textContent).toBe('Try again in 2 min 5 s');

    // A tab in the background: the clock moves on while its timers are held back.
    vi.setSystemTime(now + 120_000);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(button().textContent).toBe('Try again in 5 s');
    vi.setSystemTime(now + 200_000);
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(button().disabled).toBe(false);
  });

  it('offers the retry at once when the refusal named no wait, or the wait is over', () => {
    failedWith('rate_limited', 'Too many requests.', { retryAt: Date.now() - 1 });
    expect((screen.getByRole('button', { name: 'Try again' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('offers a retry when the analysis could not be started', () => {
    failedWith('stream_open_failed');
    expect(
      screen.getByText('The analysis could not be started. Try again in a moment.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
