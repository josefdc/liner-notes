import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

// The boundary's two fallbacks: a part whose code could not be loaded (a chunk-load error) can
// be loaded again or the page reloaded; a part that threw while it rendered keeps the boundary's
// own message and way back.

let failure: Error | null = null;
function Part() {
  if (failure) throw failure;
  return <h2>The part</h2>;
}

const chunkError = () =>
  new TypeError(
    'Failed to fetch dynamically imported module: http://127.0.0.1/assets/Dashboard-1a2b.js',
  );

beforeEach(() => {
  // React reports the caught error too.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  failure = null;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('the error boundary and a chunk that could not be loaded', () => {
  it('says the part could not be loaded and offers "Try again", "Reload the page" and the way elsewhere', () => {
    failure = chunkError();
    const onWayBack = vi.fn();
    render(
      <ErrorBoundary
        message="This screen could not be shown"
        action={{ label: 'New search', onClick: onWayBack }}
        loadFailedMessage="This screen could not be loaded"
      >
        <Part />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('This screen could not be loaded.');
    expect(alert.textContent).toContain('The connection may have dropped');
    expect(alert.textContent).not.toContain('This screen could not be shown');
    const buttons = [...alert.querySelectorAll('button')].map((button) => button.textContent);
    expect(buttons).toEqual(['Try again', 'Reload the page', 'New search']);
    // The focus moves as for any failure: to the fallback's first way back.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Try again' }));

    // "Try again" shows the part again, without the boundary's own way back.
    failure = null;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByRole('heading', { name: 'The part' })).toBeTruthy();
    expect(onWayBack).not.toHaveBeenCalled();
  });

  it("still offers the boundary's way elsewhere", () => {
    failure = chunkError();
    const onWayBack = vi.fn();
    render(
      <ErrorBoundary
        message="This screen could not be shown"
        action={{ label: 'New search', onClick: onWayBack }}
      >
        <Part />
      </ErrorBoundary>,
    );
    failure = null;
    fireEvent.click(screen.getByRole('button', { name: 'New search' }));
    expect(onWayBack).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'The part' })).toBeTruthy();
  });

  it('calls onRetried once the part is back', () => {
    failure = chunkError();
    const onRetried = vi.fn(() => screen.queryByRole('heading', { name: 'The part' }));
    render(
      <ErrorBoundary
        message="The part could not be shown"
        action={{ label: 'Start over' }}
        onRetried={onRetried}
      >
        <Part />
      </ErrorBoundary>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('This part of the page could not be loaded.');
    // An action that only tries again is not offered twice.
    const buttons = [...alert.querySelectorAll('button')].map((button) => button.textContent);
    expect(buttons).toEqual(['Try again', 'Reload the page']);
    failure = null;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetried).toHaveBeenCalledTimes(1);
    // Called after the part is in the page.
    expect(onRetried.mock.results[0].value).toBeTruthy();
  });

  it('keeps the focus where it is when asked to', () => {
    failure = chunkError();
    render(
      <>
        <button type="button">Elsewhere</button>
        <ErrorBoundary
          message="The chart could not be drawn"
          action={{ label: 'Try again' }}
          focusOnFail={false}
        >
          <Part />
        </ErrorBoundary>
      </>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });

  it('logs the line it shows, with the error name only in the production build', () => {
    vi.stubEnv('DEV', false);
    failure = chunkError();
    render(
      <ErrorBoundary
        message="This screen could not be shown"
        action={{ label: 'New search' }}
        loadFailedMessage="This screen could not be loaded"
      >
        <Part />
      </ErrorBoundary>,
    );
    const logged = vi.mocked(console.error).mock.calls.map(([first]) => first);
    expect(logged).toContain('This screen could not be loaded (TypeError)');
  });
});

describe('the error boundary and any other error', () => {
  it("keeps the boundary's own message and way back", () => {
    failure = new TypeError("Cannot read properties of undefined (reading 'title')");
    const onWayBack = vi.fn();
    render(
      <ErrorBoundary
        message="This screen could not be shown"
        action={{ label: 'New search', onClick: onWayBack }}
        loadFailedMessage="This screen could not be loaded"
      >
        <Part />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('This screen could not be shown.');
    expect(alert.textContent).not.toContain('could not be loaded');
    const buttons = [...alert.querySelectorAll('button')].map((button) => button.textContent);
    expect(buttons).toEqual(['New search']);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'New search' }));

    failure = null;
    fireEvent.click(screen.getByRole('button', { name: 'New search' }));
    expect(onWayBack).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'The part' })).toBeTruthy();
  });
});
