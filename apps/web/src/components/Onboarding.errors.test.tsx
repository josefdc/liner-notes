import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Onboarding from './Onboarding';

afterEach(cleanup);

/** The error block of a run that failed with `errorCode`. */
function failedWith(errorCode: string, error = 'The run failed.') {
  render(
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
      retry={vi.fn()}
      searchSuggest={vi.fn(async () => [])}
      onComplete={vi.fn()}
    />,
  );
}

describe('Onboarding errors', () => {
  it('says a build that cannot verify requests cannot start, and offers no retry', () => {
    failedWith('verification_unavailable', 'This version of the page cannot verify requests yet.');
    expect(screen.getByText(/This version of the page cannot verify requests/)).toBeTruthy();
    expect(screen.queryByText(/Try again/)).toBeNull();
    for (const name of [
      'Try again',
      'Search again',
      'Reload the page',
      'or try a different song',
    ]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it('offers a retry when the analysis could not be started', () => {
    failedWith('stream_open_failed');
    expect(
      screen.getByText('The analysis could not be started. Try again in a moment.'),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
