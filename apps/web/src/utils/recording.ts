// How the screens tell a replayed run from a live one, and show when a run was recorded. Kept
// out of constants.ts so the stream hook and the paused-analysis banner stay small.

import type { ResultRun } from '../types';

const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/**
 * True when a result is a whole recorded run played again. A run that says it replayed only the
 * model's answers ("model_answers") is a live run whose model answers came from stored test
 * answers (development and evaluation only), not a recording; so is, from servers that do not
 * say what was replayed, a "replay" that says neither when nor from which commit it was
 * recorded.
 */
export function isWholeRecording(run: ResultRun | null | undefined): boolean {
  if (run?.mode !== 'replay' || run.replayed === 'model_answers') return false;
  return run.replayed === 'run' || text(run.recordedAt) || text(run.commit);
}

/**
 * The side "more facts" stay on for a result: 'replay' for a whole recording (its recorded
 * facts only), 'live' for any other result that says how it was produced (never recorded facts),
 * undefined for a result from a server that does not say.
 */
export function resultModeOf(run: ResultRun | null | undefined): 'live' | 'replay' | undefined {
  if (isWholeRecording(run)) return 'replay';
  return run?.mode === 'live' || run?.mode === 'replay' ? 'live' : undefined;
}

/** A recording date as shown: the day, in UTC (e.g. "24 Oct 2026"); null when there is none. */
export function recordedDate(recordedAt: string | null): string | null {
  if (!recordedAt) return null;
  const date = new Date(recordedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
