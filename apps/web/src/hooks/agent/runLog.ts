import type { AgentLog } from '../../types';

// A run's log as the page keeps it: the latest lines only, and a line that repeats the one
// before it once.

/**
 * The most lines a run's log keeps. The recorded demo run (fixtures/replays) writes 23 lines,
 * its 20 status lines and the page's own three; a live run sends a few more at most (a picker,
 * a second follow-up step, the check's lines). A run that goes far past this is repeating
 * itself, and its oldest lines are dropped.
 */
export const LOG_LIMIT = 100;

/** A line as the hook writes it: its place in the run is given by `appendLog`. */
export type NewLog = Omit<AgentLog, 'index'>;

/** The same line again: the same words, from the same step, with the same code. */
function repeats(last: AgentLog | undefined, log: NewLog): boolean {
  return !!last && last.message === log.message && last.code === log.code && last.node === log.node;
}

/** The place of a line in its run, from 0, for a log whose lines may not carry one. */
function placeOf(logs: readonly AgentLog[], position: number): number {
  return logs[position]?.index ?? position;
}

/**
 * The log with `log` added at the end, the oldest line dropped once it holds LOG_LIMIT. A line
 * that repeats the last one is not added: the same array comes back, so the caller can keep its
 * state as it is.
 */
export function appendLog(logs: AgentLog[], log: NewLog, limit = LOG_LIMIT): AgentLog[] {
  const last = logs.at(-1);
  if (repeats(last, log)) return logs;
  const index = logs.length === 0 ? 0 : placeOf(logs, logs.length - 1) + 1;
  const kept = logs.length >= limit ? logs.slice(logs.length - limit + 1) : logs;
  return [...kept, { ...log, index }];
}

/** How many lines of the run were dropped from the start of `logs`. */
export function droppedLines(logs: readonly AgentLog[]): number {
  return logs.length === 0 ? 0 : placeOf(logs, 0);
}

/** How many lines the run has written, those dropped included. */
export function writtenLines(logs: readonly AgentLog[]): number {
  return droppedLines(logs) + logs.length;
}
