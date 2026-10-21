/**
 * Reading the API's event streams: each message is parsed with the contract's schema
 * (`AnalyzeStreamEvent`, `FactoidStreamEvent` from @liner-notes/contract) via `safeParse`.
 * A message of a type this app does not know, or one that does not fit the contract, is
 * skipped (and logged once per type); it never reaches the app and never breaks the stream.
 *
 * Every event carries its run's id (`runId`) and its position in the stream (`seq`, from 0;
 * heartbeats have none). A stream's guard drops repeats and events that arrive out of order,
 * events of another run than the stream's, and every `complete` of a run after the first.
 */

import { AnalyzeStreamEvent, FactoidStreamEvent } from '@liner-notes/contract';
import type { TrackData } from '../../types';

/** Which stream a message came from: its schema and the name used in log lines. */
const SCHEMAS = {
  analysis: AnalyzeStreamEvent,
  factoids: FactoidStreamEvent,
} as const;

type Kind = keyof typeof SCHEMAS;

/**
 * An analysis event as sent. The result (`complete`) is handed to the app as the server wrote
 * it: the app's own readers keep values the contract's reader drops (such as an older result's
 * estimated audio, which is shown as estimated, never as measured).
 */
export type AnalysisEvent =
  | Exclude<AnalyzeStreamEvent, { type: 'complete' }>
  | (Omit<Extract<AnalyzeStreamEvent, { type: 'complete' }>, 'data'> & { data: TrackData });
export type FactoidEvent = FactoidStreamEvent;

const reported = new Set<string>();

/** Logs a skipped message once per stream kind, type and reason. */
function reportOnce(kind: Kind, type: string, reason: string, detail?: unknown) {
  const key = `${kind}:${type}:${reason}`;
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(`[useAgent] Skipped ${kind} stream message (${type}): ${reason}`, detail ?? '');
}

/** For tests: logs every skipped message again. */
export function resetSkippedReports() {
  reported.clear();
}

function parse(kind: Kind, data: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    reportOnce(kind, '?', 'not JSON');
    return null;
  }
  const type =
    typeof value === 'object' && value !== null && 'type' in value
      ? String((value as { type: unknown }).type)
      : '?';
  const parsed = SCHEMAS[kind].safeParse(value);
  if (!parsed.success) {
    const known = SCHEMAS[kind].options.some((option) => option.shape.type.value === type);
    if (known) reportOnce(kind, type, 'does not fit the contract', parsed.error.issues);
    else reportOnce(kind, type, 'unknown type');
    return null;
  }
  // Checked: the message as written (see AnalysisEvent).
  return value;
}

/** One analysis stream message (its `data`), or null when it is skipped. */
export function parseAnalysisEvent(data: string): AnalysisEvent | null {
  return parse('analysis', data) as AnalysisEvent | null;
}

/** One factoid stream message (its `data`), or null when it is skipped. */
export function parseFactoidEvent(data: string): FactoidEvent | null {
  return parse('factoids', data) as FactoidEvent | null;
}

/** What a run has seen across its streams (the analysis stream, then the resume stream). */
export interface RunEvents {
  /** The run's id: from its first event, or null before that. */
  runId: string | null;
  /** Set once the run's `complete` has been taken. */
  completed: boolean;
}

export function newRunEvents(): RunEvents {
  return { runId: null, completed: false };
}

/**
 * The filter of one stream: true for an event the app should handle. `seq` restarts at 0 on
 * each stream, so a guard is made per stream; `run` is shared by the streams of one run.
 * A null run id (a factoid stream that does not know its analysis run) matches any run.
 */
export function streamGuard(run: RunEvents) {
  let lastSeq = -1;
  return (event: { type: string; runId: string | null; seq?: number }): boolean => {
    if (event.runId !== null) {
      if (run.runId === null) run.runId = event.runId;
      else if (event.runId !== run.runId) return false;
    }
    if (event.type === 'heartbeat' || event.seq === undefined) return true;
    if (event.seq <= lastSeq) return false;
    lastSeq = event.seq;
    if (event.type === 'complete') {
      if (run.completed) return false;
      run.completed = true;
    }
    return true;
  };
}
