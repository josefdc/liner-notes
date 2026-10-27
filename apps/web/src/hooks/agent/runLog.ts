import type { AgentLog, LogCode } from '../../types';
import type { AgentAction } from './state';

// A run's log as the page keeps it: the latest lines only, and a line that repeats the one
// before it once.

/**
 * The most lines a run's log keeps: several times what a whole run writes. The recorded demo
 * run (fixtures/replays/one-more-time-daft-punk.json: its status events, plus the page's own
 * lines) fits in it with room to spare, and a live run adds only a few more (a picker, a second
 * follow-up step, the check's lines). A run that goes far past this is repeating itself, and its
 * oldest lines are dropped. Pinned in runLog.test.ts, which counts the recording's lines.
 */
export const LOG_LIMIT = 100;

/** A line as the hook writes it: its place in the run is given by `appendLog`. */
export type NewLog = Omit<AgentLog, 'index'>;

/**
 * A new line with an optional code and node, and the time since the run started that the server
 * sent it with.
 */
export function newLog(message: string, code?: LogCode, node?: string, elapsedMs?: number): NewLog {
  return {
    id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
    message,
    timestamp: new Date().toISOString(),
    code,
    node,
    ...(elapsedMs !== undefined && { elapsedMs }),
  };
}

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

/** A run's log before its first line. */
export const NO_LOGS: AgentLog[] = [];

/** The run's log after `action`; the same array when the action does not change it. */
export function logsReducer(logs: AgentLog[], action: AgentAction): AgentLog[] {
  switch (action.type) {
    case 'reset':
    case 'started':
      return NO_LOGS;
    // Bounded, and a repeat of the last line changes nothing (appendLog).
    case 'logged':
      return appendLog(logs, action.log);
    default:
      return logs;
  }
}
