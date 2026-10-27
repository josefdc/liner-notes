/**
 * What a run has to show: the track picker's candidates while it is open, then the result, and
 * whether the run is a recorded run played again. Plain functions, no React.
 */

import type { AgentAction } from './state';
import type { AgentState } from './types';

export type ResultState = Pick<AgentState, 'candidates' | 'trackData' | 'isComplete' | 'isReplay'>;

export const INITIAL_RESULT: ResultState = {
  candidates: null,
  trackData: null,
  isComplete: false,
  isReplay: false,
};

/** What the run has to show after `action`; the same object when the action does not change it. */
export function resultReducer(state: ResultState, action: AgentAction): ResultState {
  switch (action.type) {
    case 'reset':
    case 'started':
      return INITIAL_RESULT;
    case 'replayNoticed':
      return { ...state, isReplay: true };
    case 'pickerOpened':
      return { ...state, candidates: action.candidates };
    // The picker closes once a row is picked, and when the run fails.
    case 'resumed':
    case 'failed':
      return { ...state, candidates: null };
    case 'completed':
      return {
        candidates: null,
        trackData: action.trackData,
        isComplete: true,
        isReplay: action.replay,
      };
    default:
      return state;
  }
}
