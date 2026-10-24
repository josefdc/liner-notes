/**
 * Reading the API's event streams: each message is parsed with the contract's schema
 * (`AnalyzeStreamEvent`, `FactoidStreamEvent` from @liner-notes/contract) via `safeParse`.
 * A message of a type this app does not know, or a progress event that does not fit the
 * contract, is skipped (and logged once per type); it never reaches the app and never breaks
 * the stream.
 *
 * The run's outcome (`complete`, `interrupt`) is read more leniently: the contract lets a newer
 * API add enum values, widen types and loosen bounds, so an outcome that does not fit this
 * page's copy of the contract is still used when its envelope (`type`, `runId`, `seq`) and its
 * payload can be read; the app's own readers take it from there. One that cannot be read at
 * all reaches the app as `unreadable`, so the user is told to reload the page.
 *
 * Every event carries its run's id (`runId`) and its position in the stream (`seq`, from 0;
 * heartbeats have none). A stream's guard drops repeats and events that arrive out of order,
 * events of another run than the stream's, and every `complete` of a run after the first.
 *
 * The schemas (and zod) stay out of the page's first download: `loadEventSchemas` fetches them,
 * and the hook awaits it before it opens a stream.
 */

import type { AnalyzeStreamEvent, FactoidStreamEvent } from '@liner-notes/contract';
import type { TrackData } from '../../types';
import type { SearchCandidate } from './types';

type Schemas = typeof import('./eventSchemas');
type Kind = 'analysis' | 'factoids';

let schemas: Schemas | null = null;
let loading: Promise<void> | null = null;

/** True once the schemas are loaded: a stream can then be opened without waiting. */
export function eventSchemasLoaded(): boolean {
  return schemas !== null;
}

/** Loads the event schemas (once); rejects when the chunk cannot be fetched. */
export function loadEventSchemas(): Promise<void> {
  loading ??= import('./eventSchemas').then(
    (module) => {
      schemas = module;
    },
    (error: unknown) => {
      // A later call tries again.
      loading = null;
      throw error;
    },
  );
  return loading;
}

function schemaOf(kind: Kind) {
  if (!schemas) throw new Error('The event schemas are not loaded yet (loadEventSchemas)');
  return kind === 'analysis' ? schemas.AnalyzeStreamEvent : schemas.FactoidStreamEvent;
}

type Envelope = { runId: string; seq: number };

/**
 * An analysis event as sent. The result (`complete`) is handed to the app as the server wrote
 * it: the app's own readers keep values the contract's reader drops (such as an older result's
 * estimated audio, which is shown as estimated, never as measured). `unreadable` stands for an
 * outcome this page cannot use.
 */
export type AnalysisEvent =
  | Exclude<AnalyzeStreamEvent, { type: 'complete' | 'interrupt' }>
  | ({ type: 'complete'; data: TrackData } & Envelope)
  | ({
      type: 'interrupt';
      reason: string;
      threadId: string;
      candidates: SearchCandidate[];
      message: string;
    } & Envelope)
  | UnreadableOutcome;
export type FactoidEvent = FactoidStreamEvent;

/** A `complete` or `interrupt` this page cannot use; the run ends with a reload hint. */
export interface UnreadableOutcome {
  type: 'unreadable';
  event: 'complete' | 'interrupt';
  runId: string | null;
  seq?: number;
}

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

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown) => (typeof value === 'string' ? value : '');

function envelopeOf(value: Record<string, unknown>): Envelope | null {
  const { runId, seq } = value;
  if (typeof runId !== 'string' || runId === '') return null;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0) return null;
  return { runId, seq };
}

/** A picker row the app can show and resume with: an id, a title and an artist. */
function readCandidate(value: unknown): SearchCandidate | null {
  if (!isObject(value)) return null;
  const { id, title, artist, releaseYear, popularity } = value;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof title !== 'string' || typeof artist !== 'string') return null;
  return {
    id,
    title,
    artist,
    album: text(value.album),
    coverUrl: text(value.coverUrl),
    ...(typeof releaseYear === 'string' ? { releaseYear } : {}),
    ...(typeof popularity === 'number' && Number.isFinite(popularity) ? { popularity } : {}),
  };
}

/**
 * An outcome that does not fit the contract, read by its envelope and payload only; null when
 * even that cannot be read.
 */
function readOutcome(
  type: 'complete' | 'interrupt',
  value: Record<string, unknown>,
): AnalysisEvent | null {
  const envelope = envelopeOf(value);
  if (!envelope) return null;
  if (type === 'complete') {
    // The app's reader (normalizeTrack) copes with missing and unfamiliar fields.
    return isObject(value.data)
      ? { type, ...envelope, data: value.data as unknown as TrackData }
      : null;
  }
  if (!Array.isArray(value.candidates)) return null;
  const candidates = value.candidates.map(readCandidate).filter((candidate) => candidate !== null);
  // Candidates were offered but none can be shown: not the same as "no match".
  if (candidates.length === 0 && value.candidates.length > 0) return null;
  return {
    type,
    ...envelope,
    reason: text(value.reason),
    threadId: text(value.threadId) || envelope.runId,
    candidates,
    message: text(value.message),
  };
}

function parse(kind: Kind, data: string): unknown {
  const schema = schemaOf(kind);
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    reportOnce(kind, '?', 'not JSON');
    return null;
  }
  const type = isObject(value) && 'type' in value ? String(value.type) : '?';
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    // Checked: the message as written (see AnalysisEvent).
    return value;
  }
  const known = schema.options.some((option) => option.shape.type.value === type);
  if (!known) {
    reportOnce(kind, type, 'unknown type');
    return null;
  }
  if (kind === 'analysis' && isObject(value) && (type === 'complete' || type === 'interrupt')) {
    const outcome = readOutcome(type, value);
    if (outcome) {
      reportOnce(kind, type, 'does not fit the contract; read leniently', parsed.error.issues);
      return outcome;
    }
    reportOnce(kind, type, 'cannot be read', parsed.error.issues);
    const { runId, seq } = value;
    const unreadable: UnreadableOutcome = {
      type: 'unreadable',
      event: type,
      runId: typeof runId === 'string' && runId !== '' ? runId : null,
      ...(typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? { seq } : {}),
    };
    return unreadable;
  }
  reportOnce(kind, type, 'does not fit the contract', parsed.error.issues);
  return null;
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
 *
 * A refusal (an `error` at seq 0, then `done` at seq 1) is taken whatever its run id: the API
 * refuses a request it cannot tie to a run (a resume with an invalid thread id) under an id of
 * its own, and the user must still see why.
 */
export function streamGuard(run: RunEvents) {
  let lastSeq = -1;
  let refusalRunId: string | null = null;
  return (event: { type: string; runId: string | null; seq?: number }): boolean => {
    if (event.runId !== null) {
      if (run.runId === null) run.runId = event.runId;
      else if (event.runId !== run.runId) {
        const opensRefusal = event.type === 'error' && event.seq === 0 && lastSeq === -1;
        const endsRefusal =
          event.type === 'done' && event.seq === 1 && event.runId === refusalRunId;
        if (!opensRefusal && !endsRefusal) return false;
        if (opensRefusal) refusalRunId = event.runId;
      }
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
