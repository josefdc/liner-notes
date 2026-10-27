import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Onboarding from './Onboarding';
import { waitText } from '../hooks/useTimeLeft';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** What a screen reader reads of `element`: its text without the parts hidden from it. */
function spokenText(element: Element | null): string | null {
  if (!element) return null;
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent;
}

/** The heading's description, as a screen reader reads it. */
function description(heading: Element): string {
  return (heading.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => spokenText(document.getElementById(id)))
    .join(' ');
}

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
    const described = description(heading);
    const line = document.getElementById('error-wait');
    return {
      // What the page shows of the wait line (the spoken words are kept for screen readers).
      line: line?.querySelector('[aria-hidden="true"]')?.textContent ?? null,
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
      described: 'Too many requests. Please try again later. You can try again in 42 seconds.',
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

  it('keeps the wait line out of every live region: it is read with the heading only', () => {
    failedWith('rate_limited', 'Too many requests.', { retryAt: Date.now() + 42_000 });
    const line = document.getElementById('error-wait') as HTMLElement;
    expect(line.getAttribute('role')).toBeNull();
    expect(line.getAttribute('aria-live')).toBeNull();
    expect(line.closest('[role="status"], [role="alert"], [role="log"], [aria-live]')).toBeNull();
    expect(spokenText(line)).toMatch(/^You can try again in 4[12] seconds\.$/);
  });

  it('describes the heading with the wait as it is when the heading takes the focus', () => {
    vi.useFakeTimers();
    const start = Date.parse('2026-10-27T12:00:00.000Z');
    vi.setSystemTime(start);
    const props = {
      trackData: null,
      isLoading: false,
      candidates: null,
      analyze: vi.fn(async () => {}),
      selectCandidate: vi.fn(async () => {}),
      retry: vi.fn(),
      searchSuggest: vi.fn(async () => []),
      onComplete: vi.fn(),
    };
    // The page is up with no wait, and two minutes pass before a refusal names one of 30 s.
    const view = render(
      <Onboarding
        {...props}
        status="idle"
        logs={[]}
        error={null}
        errorCode={null}
        retryAt={null}
      />,
    );
    vi.setSystemTime(start + 120_000);
    const read: string[] = [];
    const onFocus = (event: FocusEvent) => read.push(description(event.target as Element));
    document.addEventListener('focusin', onFocus);
    try {
      view.rerender(
        <Onboarding
          {...props}
          status="error"
          logs={[{ id: 'failure-1', message: 'Error', timestamp: '', code: 'SYS-ERROR' }]}
          error="Too many requests. Please try again later."
          errorCode="rate_limited"
          retryAt={start + 150_000}
        />,
      );
    } finally {
      document.removeEventListener('focusin', onFocus);
    }
    expect(read).toEqual([
      'Too many requests. Please try again later. You can try again in 30 seconds.',
    ]);
  });

  it('offers to reload the page once the check could not be loaded twice in a row', () => {
    const props = {
      trackData: null,
      error: 'The check that protects the analysis could not be loaded.',
      isLoading: false,
      candidates: null,
      analyze: vi.fn(async () => {}),
      selectCandidate: vi.fn(async () => {}),
      retry: vi.fn(),
      searchSuggest: vi.fn(async () => []),
      onComplete: vi.fn(),
    };
    const failure = (id: string, errorCode: string) => (
      <Onboarding
        {...props}
        status="error"
        errorCode={errorCode}
        logs={[{ id, message: 'Error', timestamp: '', code: 'SYS-ERROR' }]}
      />
    );
    const running = (status: 'connecting' | 'searching') => (
      <Onboarding {...props} status={status} isLoading errorCode={null} logs={[]} />
    );
    const reload = () => screen.queryByRole('button', { name: 'Reload the page' });

    const view = render(failure('f1', 'verification_unavailable'));
    expect(reload()).toBeNull();
    view.rerender(running('connecting'));
    view.rerender(failure('f2', 'verification_unavailable'));
    expect(reload()).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();

    // A run that got past the check starts the count again, as does another failure.
    view.rerender(running('searching'));
    view.rerender(failure('f3', 'verification_unavailable'));
    expect(reload()).toBeNull();
    view.rerender(failure('f4', 'connection_lost'));
    view.rerender(failure('f5', 'verification_unavailable'));
    expect(reload()).toBeNull();
    view.rerender(failure('f6', 'verification_unavailable'));
    expect(reload()).not.toBeNull();
  });

  it('offers a retry when the analysis could not be started', () => {
    failedWith('stream_open_failed');
    expect(
      screen.getByText('The analysis could not be started. Try again in a moment.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
