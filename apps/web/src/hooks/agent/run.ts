/**
 * A run's lifecycle. Every analysis is a run: its first stream, the track picker and the resume
 * stream all belong to it. What the run asked for is fixed when it starts (newRun); how far it
 * got (RunLife) changes only through runReducer, a pure function the hook applies (advance) as
 * the run's events come in. The hook tells its runs apart by identity: a stale run's streams
 * never touch a newer one.
 */

import { isSpotifyTrackId } from '../../utils/spotify';
import type { RunToken } from './apiClient';
import { newRunEvents, type RunEvents } from './events';
import { type Branches, newBranches } from './progress';
import type { AnalyzeOptions, PickedBy, SearchCandidate } from './types';

/** How far a run got; a result or an error is final and later events are ignored. */
export type RunPhase = 'running' | 'awaiting-selection' | 'complete' | 'failed';

export interface RunLife {
  phase: RunPhase;
  threadId: string | null;
  candidates: SearchCandidate[] | null;
  /** The candidate picked in the track picker, once the run resumes with it. */
  picked: SearchCandidate | null;
  /** The API said this run is a replay of a recorded run. */
  replay: boolean;
  /** The run token the run started with; its resume sends it again. */
  token: RunToken | null;
  /** What the engineer and the historian have said so far. */
  branches: Branches;
}

export interface Run {
  readonly query: string;
  /** A result for any other track is not shown (a recording asked for by the track's id). */
  readonly expectedTrackId: string | null;
  /** The Spotify track the run asked for by id (a clicked suggestion), for a retry. */
  readonly trackId: string | null;
  /** How the picker row the run asked for by id was picked, for a retry. */
  readonly pickedBy: PickedBy | null;
  /** Aborted when the run is replaced, on reset and on unmount; closes its streams. */
  readonly controller: AbortController;
  /** The run's id and whether its result was taken, across its streams. */
  readonly events: RunEvents;
  life: RunLife;
}

export function newRunLife(): RunLife {
  return {
    phase: 'running',
    threadId: null,
    candidates: null,
    picked: null,
    replay: false,
    token: null,
    branches: newBranches(),
  };
}

/**
 * A new run for `query`. A track id that is not a Spotify track id (a placeholder) is not kept,
 * nor how its row was picked.
 */
export function newRun(
  query: string,
  options: AnalyzeOptions & { expectedTrackId?: string } = {},
): Run {
  const trackId = isSpotifyTrackId(options.trackId) ? options.trackId : null;
  return {
    query,
    expectedTrackId: options.expectedTrackId ?? null,
    trackId,
    pickedBy: trackId ? (options.pickedBy ?? null) : null,
    controller: new AbortController(),
    events: newRunEvents(),
    life: newRunLife(),
  };
}

export type RunAction =
  /** The run token the run starts with. */
  | { type: 'tokenIssued'; token: RunToken }
  /** The stream's `connected`, with the run's thread. */
  | { type: 'connected'; threadId: string | null | undefined }
  /** The API's notice that the run replays a recording. */
  | { type: 'replayNoticed' }
  /** A status line changed what the engineer and the historian have said (reportStep). */
  | { type: 'branchesChanged'; branches: Branches }
  /** The run paused on the track picker. */
  | { type: 'pickerOpened'; threadId: string | null | undefined; candidates: SearchCandidate[] }
  /** A row of the picker was picked: the run goes on, and resumes with it when it has a thread. */
  | { type: 'picked'; candidate: SearchCandidate }
  /** The result was taken; `wholeRecording` when it says it is a recorded run played again. */
  | { type: 'completed'; wholeRecording: boolean }
  | { type: 'failed' };

function sameCandidates(a: SearchCandidate[] | null, b: SearchCandidate[]): boolean {
  return !!a && a.length === b.length && a.every((candidate, i) => candidate.id === b[i].id);
}

/** The run's life after `action`. */
export function runReducer(life: RunLife, action: RunAction): RunLife {
  switch (action.type) {
    case 'tokenIssued':
      return { ...life, token: action.token };
    case 'connected':
      return { ...life, threadId: action.threadId || null };
    case 'replayNoticed':
      return { ...life, replay: true };
    case 'branchesChanged':
      return life.branches === action.branches ? life : { ...life, branches: action.branches };
    case 'pickerOpened':
      return {
        ...life,
        phase: 'awaiting-selection',
        threadId: action.threadId || life.threadId,
        // The same list object when nothing changed, so the picker is not reset.
        candidates: sameCandidates(life.candidates, action.candidates)
          ? life.candidates
          : action.candidates,
      };
    case 'picked':
      return {
        ...life,
        phase: 'running',
        picked: life.threadId ? action.candidate : life.picked,
      };
    case 'completed':
      return {
        ...life,
        phase: 'complete',
        // A whole recording, not a live run whose model answers came from stored answers.
        replay: life.replay || action.wholeRecording,
      };
    case 'failed':
      return { ...life, phase: 'failed' };
  }
}

/** Moves `run` on by `action`. */
export function advance(run: Run, action: RunAction): void {
  run.life = runReducer(run.life, action);
}
