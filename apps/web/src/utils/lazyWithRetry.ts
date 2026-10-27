import {
  type ComponentType,
  createContext,
  createElement,
  type LazyExoticComponent,
  lazy,
  useContext,
} from 'react';

/**
 * Lazy components whose code could not be loaded (a dropped connection, a deploy that replaced
 * the hashed files) and the way to load it again without a reload.
 *
 * `React.lazy` keeps a failed import's error for good: every later render throws it again, so a
 * screen whose chunk failed once stays failed until the page is reloaded. A component made by
 * `lazyWithRetry` keeps the error only for the load attempt it failed in: the error boundary
 * above it starts a new attempt when it resets (its "Try again", or another screen), and the
 * next render imports the code again. Within one attempt the error sticks, so the boundary's
 * fallback shows and React's own retry of the failed render does not fetch it again.
 *
 * Chromium fetches a module again when an import of it failed (a plain new `import()` loads it
 * once the network is back), so no cache-busting query is added to the chunk's address; a chunk
 * that is gone from the server can only come back with a reload, which the fallback offers.
 */

/**
 * The load attempt of the components below: a new value (compared by identity) on each reset of
 * the error boundary that provides it. Outside any such boundary, one attempt for the page.
 */
export const LoadAttempt = createContext<object>({});

interface Load<P extends object> {
  Component: LazyExoticComponent<ComponentType<P>>;
  /** The attempt it was started in. */
  attempt: object;
  failed: boolean;
}

/**
 * A lazy component like `React.lazy(factory)`, whose failed import is tried again in the next
 * load attempt (see `LoadAttempt`). A successful import is kept: the factory is not called again.
 */
export function lazyWithRetry<P extends object>(
  factory: () => Promise<{ default: ComponentType<P> }>,
): ComponentType<P> {
  let load: Load<P> | null = null;
  const start = (attempt: object): Load<P> => {
    const started: Load<P> = {
      attempt,
      failed: false,
      Component: lazy(() =>
        factory().catch((error: unknown) => {
          started.failed = true;
          throw error;
        }),
      ),
    };
    return started;
  };
  function Retrying(props: P) {
    const attempt = useContext(LoadAttempt);
    if (!load || (load.failed && load.attempt !== attempt)) load = start(attempt);
    return createElement(load.Component, props);
  }
  return Retrying;
}

/**
 * Whether an error is a failed load of a code chunk, as the browsers and Vite report it:
 * Chromium's and Firefox's TypeError for a dynamic import, Safari's, and Vite's own error when a
 * chunk's stylesheet could not be preloaded.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ChunkLoadError') return true;
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(
    error.message,
  );
}
