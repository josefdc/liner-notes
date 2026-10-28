import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type ComponentType, type ReactNode, Suspense } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { isChunkLoadError, lazyWithRetry } from './lazyWithRetry';

// A piece of the page whose code is loaded on demand: the first load fails as Chromium reports a
// chunk that did not arrive, the next one succeeds.

const chunkError = () =>
  new TypeError(
    'Failed to fetch dynamically imported module: http://127.0.0.1/assets/Piece-1a2b.js',
  );

function Piece({ label }: { label: string }) {
  return <p>{label}</p>;
}

/** A factory that fails `failures` times, then loads the piece. */
function flakyFactory(failures = 1) {
  const factory = vi.fn(async () => ({ default: Piece }));
  for (let i = 0; i < failures; i++) factory.mockRejectedValueOnce(chunkError());
  return factory;
}

function Shown({ Lazy, resetKey }: { Lazy: ComponentType<{ label: string }>; resetKey?: string }) {
  return (
    <ErrorBoundary
      message="The piece could not be shown"
      action={{ label: 'Start over' }}
      resetKey={resetKey}
    >
      <Suspense fallback={<p>Loading the piece</p>}>
        <Lazy label="the piece" />
      </Suspense>
    </ErrorBoundary>
  );
}

beforeEach(() => {
  // React reports the caught error too.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('lazyWithRetry', () => {
  it('imports again after "Try again" when the import failed, and keeps the loaded code', async () => {
    const factory = flakyFactory();
    const Lazy = lazyWithRetry(factory);
    render(<Shown Lazy={Lazy} />);

    await screen.findByText('This part of the page could not be loaded.');
    // Within the failed attempt the error sticks: React's own retry of the failed render does
    // not import again, so the fallback shows.
    expect(factory).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('the piece');
    expect(factory).toHaveBeenCalledTimes(2);

    // Loaded once: a later render of it, anywhere, does not import it again.
    cleanup();
    render(<Shown Lazy={Lazy} />);
    await screen.findByText('the piece');
    render(<Lazy label="another use" />);
    await screen.findByText('another use');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('imports again when the boundary resets for another screen', async () => {
    const factory = flakyFactory();
    const Lazy = lazyWithRetry(factory);
    const { rerender } = render(<Shown Lazy={Lazy} resetKey="first" />);
    await screen.findByText('This part of the page could not be loaded.');

    rerender(<Shown Lazy={Lazy} resetKey="second" />);
    await screen.findByText('the piece');
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('shows the fallback again when the next import fails too, and loads on the one after', async () => {
    const factory = flakyFactory(2);
    const Lazy = lazyWithRetry(factory);
    render(<Shown Lazy={Lazy} />);
    await screen.findByText('This part of the page could not be loaded.');

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('This part of the page could not be loaded.');
    expect(factory).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText('the piece');
    expect(factory).toHaveBeenCalledTimes(3);
  });

  it('imports once while the view around its boundary is still loading', async () => {
    // A view that mounts a boundary for a piece, beside a part still loading: React renders the
    // boundary afresh until the view is in. The failed import is not repeated meanwhile.
    const factory = vi.fn(async () => {
      throw chunkError();
    });
    const Failing = lazyWithRetry<{ label: string }>(factory);
    let arrive = () => {};
    const Slow = lazyWithRetry(
      () =>
        new Promise<{ default: () => ReactNode }>((resolve) => {
          arrive = () => resolve({ default: () => <p>The slow part</p> });
        }),
    );
    function View() {
      return (
        <>
          <Slow />
          <ErrorBoundary message="The piece could not be shown" action={{ label: 'Try again' }}>
            <Suspense fallback={<p>Loading the piece</p>}>
              <Failing label="the piece" />
            </Suspense>
          </ErrorBoundary>
        </>
      );
    }
    function Page({ show }: { show: boolean }) {
      return (
        <ErrorBoundary message="The screen could not be shown" action={{ label: 'Start over' }}>
          <Suspense fallback={<p>Loading the view</p>}>{show && <View />}</Suspense>
        </ErrorBoundary>
      );
    }
    const { rerender } = render(<Page show={false} />);
    rerender(<Page show />);
    await screen.findByText('Loading the view');
    await new Promise((resolve) => setTimeout(resolve, 100));
    arrive();
    await screen.findByText('The slow part');
    await screen.findByText('This part of the page could not be loaded.');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(factory).toHaveBeenCalledTimes(1);
  });
});

describe('isChunkLoadError', () => {
  it('knows a chunk that did not arrive, as each browser and Vite report it', () => {
    expect(isChunkLoadError(chunkError())).toBe(true);
    // Firefox.
    expect(
      isChunkLoadError(
        new TypeError('error loading dynamically imported module: http://x/assets/a.js'),
      ),
    ).toBe(true);
    // Safari.
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    // Vite, when a chunk's stylesheet could not be preloaded.
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/a.css'))).toBe(true);
    const named = new Error('Loading chunk 3 failed.');
    named.name = 'ChunkLoadError';
    expect(isChunkLoadError(named)).toBe(true);
  });

  it('leaves any other error alone', () => {
    expect(
      isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'x')")),
    ).toBe(false);
    expect(isChunkLoadError(new Error('Failed to fetch'))).toBe(false);
    // Errors that name a module or a preload, but are no failed load of a chunk.
    expect(isChunkLoadError(new Error("Cannot find module './x'"))).toBe(false);
    expect(isChunkLoadError(new TypeError('module.default is not a function'))).toBe(false);
    expect(isChunkLoadError(new Error('The cover could not be preloaded'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});
