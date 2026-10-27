/**
 * The state useAgent shows, as pieces that change apart: the progress line (progress.ts), what
 * the run has to show (result.ts), why it failed (failure.ts), its log (runLog.ts) and the facts
 * "more facts" added (moreFacts.ts). Every change is a named action; each piece's reducer takes
 * the actions it cares about and returns the same object for the others. Plain functions, no
 * React.
 */

import type { TrackData } from '../../types';
import { type FailureState, failureReducer, INITIAL_FAILURE } from './failure';
import { INITIAL_PROGRESS, type ProgressState, progressReducer, type Step } from './progress';
import { INITIAL_RESULT, type ResultState, resultReducer } from './result';
import { logsReducer, NO_LOGS, type NewLog } from './runLog';
import type { AgentState, MoreFacts, SearchCandidate } from './types';

export type AgentAction =
  /** Back to the start: no run, nothing shown. */
  | { type: 'reset' }
  /** A new run: what the last one showed is let go, and the run connects. */
  | { type: 'started' }
  /** A line for the run's log. */
  | { type: 'logged'; log: NewLog }
  /** The Turnstile check runs, before the analysis is asked for. */
  | { type: 'checkStarted' }
  /** The check is over: the run has its token. */
  | { type: 'checkEnded' }
  /** The analysis stream opened. */
  | { type: 'opened' }
  /** The API's notice that the run replays a recording. */
  | { type: 'replayNoticed' }
  /** The server reported a step (reportStep). */
  | { type: 'stepReported'; step: Step }
  /** The track picker opened, with the line it asks. */
  | { type: 'pickerOpened'; candidates: SearchCandidate[]; question: string }
  /** A row was picked: the run resumes with it. */
  | { type: 'resumed' }
  /** The result came. */
  | { type: 'completed'; trackData: TrackData; replay: boolean }
  /** The run failed; `retryAt` when its refusal said how long to wait. */
  | { type: 'failed'; message: string; code: string | null; retryAt: number | null }
  /** The facts "more facts" added changed (moreFactsReducer). */
  | { type: 'moreFactsChanged'; moreFacts: MoreFacts };

export interface AgentPieces {
  progress: ProgressState;
  result: ResultState;
  failure: FailureState;
  logs: AgentState['logs'];
  moreFacts: MoreFacts | null;
}

export const INITIAL_PIECES: AgentPieces = {
  progress: INITIAL_PROGRESS,
  result: INITIAL_RESULT,
  failure: INITIAL_FAILURE,
  logs: NO_LOGS,
  moreFacts: null,
};

/** The facts "more facts" added, after `action`: none for a new run or after a reset. */
export function keptMoreFactsReducer(
  moreFacts: MoreFacts | null,
  action: AgentAction,
): MoreFacts | null {
  switch (action.type) {
    case 'reset':
    case 'started':
      return null;
    case 'moreFactsChanged':
      return action.moreFacts;
    default:
      return moreFacts;
  }
}

/** Every piece after `action`; the same object when no piece changed. */
export function agentReducer(state: AgentPieces, action: AgentAction): AgentPieces {
  const next: AgentPieces = {
    progress: progressReducer(state.progress, action),
    result: resultReducer(state.result, action),
    failure: failureReducer(state.failure, action),
    logs: logsReducer(state.logs, action),
    moreFacts: keptMoreFactsReducer(state.moreFacts, action),
  };
  const same = (Object.keys(next) as Array<keyof AgentPieces>).every(
    (piece) => next[piece] === state[piece],
  );
  return same ? state : next;
}

/** The state as the hook returns it: every piece's fields side by side. */
export function agentStateOf({
  progress,
  result,
  failure,
  logs,
  moreFacts,
}: AgentPieces): AgentState {
  return { ...progress, ...result, ...failure, logs, moreFacts };
}
