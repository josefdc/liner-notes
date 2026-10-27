import type { RootOptions } from 'react-dom/client';

/**
 * What the console gets when a part of the page throws while it renders: the error's name, never
 * its message, which can carry the data the part was given (a track's details, a signed preview
 * link). React's own defaults log the whole error, in production too.
 */

/** An error's name (`TypeError`), or "unknown error" for a thrown value that is not an Error. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

/** The page root's error handlers (main.tsx). */
export const rootErrorOptions: RootOptions = {
  // A boundary caught it and logs its own line (components/ErrorBoundary.tsx).
  onCaughtError: (error) =>
    console.error(`A part of the page could not be shown (${errorName(error)})`),
  onUncaughtError: (error) => console.error(`The page could not be shown (${errorName(error)})`),
  onRecoverableError: (error) =>
    console.error(`The page recovered from an error (${errorName(error)})`),
};
