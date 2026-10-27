/**
 * The progress line of a run: its step (`status`), the server's own words for it (`statusNote`)
 * and whether the run is waiting on the server (`isLoading`). Plain functions, no React.
 *
 * The engineer and the historian run side by side; what each has said so far (Branches) decides
 * which step their status lines move the run to (reportStep), and a step reported after a later
 * one does not move the run back (toStep).
 */

import type { AgentAction } from './state';
import type { AgentState, AgentStatus } from './types';

export type ProgressState = Pick<AgentState, 'status' | 'statusNote' | 'isLoading'>;

export const INITIAL_PROGRESS: ProgressState = {
  status: 'idle',
  statusNote: null,
  isLoading: false,
};

// What the progress line says right after a pick, while the server reads the chosen track.
export const RESUME_NOTE = 'Reading the track you selected...';

// What the progress line says while the Turnstile check runs, before the analysis is asked for.
export const CHECK_NOTE = 'Checking that you are a person...';

// The picker line when the server sends no words of its own.
export const PICK_FALLBACK = 'Pick the track to analyze';

// The order of a run's steps. A step reported after a later one does not move the run back.
// The engineer measures beside the historian's research (the historian reports first), so
// `measuring` ranks with `researching`; the engineer's other lines are the `analyzing` step.
const STEP_ORDER: Partial<Record<AgentStatus, number>> = {
  connecting: 0,
  searching: 1,
  disambiguation: 1,
  analyzing: 2,
  measuring: 3,
  researching: 3,
  composing: 4,
  checking: 5,
};

export interface Step {
  status: AgentStatus;
  /**
   * The server's own words for the step, when they say more than the status; null clears them,
   * and undefined keeps those already shown for the same step (the composer's fallback stays
   * through its later lines).
   */
  note?: string | null;
  /** The measurement ended: the run leaves `measuring` even for a lower step. */
  ended?: boolean;
}

/** The progress after the server reports a step; the same object when nothing changes. */
export function toStep(prev: ProgressState, { status, note, ended }: Step): ProgressState {
  const from = STEP_ORDER[prev.status];
  const to = STEP_ORDER[status];
  const leaving = ended && prev.status === 'measuring';
  if (!leaving && from !== undefined && to !== undefined && to < from) return prev;
  const statusNote =
    note === undefined && prev.status === status ? prev.statusNote : (note ?? null);
  if (prev.status === status && prev.statusNote === statusNote) return prev;
  return { ...prev, status, statusNote };
}

/** What the engineer and the historian, which run side by side, have said so far in a run. */
export interface Branches {
  researched: boolean;
  /** The historian's words for its research ("Using the research stored by an earlier run"). */
  researchNote: string | null;
  measuring: boolean;
}

export const newBranches = (): Branches => ({
  researched: false,
  researchNote: null,
  measuring: false,
});

/**
 * What a status line of `node` says: the step it moves the run to, if any, and what the two
 * branches have said once it is counted (the same object when it changes nothing).
 */
export function reportStep(
  branches: Branches,
  node: string | undefined,
  code: string | undefined,
  message: string,
): { branches: Branches; step: Step | null } {
  const next = (change: Partial<Branches>): Branches => {
    const changed = { ...branches, ...change };
    const same =
      changed.researched === branches.researched &&
      changed.researchNote === branches.researchNote &&
      changed.measuring === branches.measuring;
    return same ? branches : changed;
  };
  switch (node) {
    case 'scout':
      return { branches, step: { status: 'searching', note: null } };
    case 'historian': {
      const after = next({
        researched: true,
        ...(code === 'RESEARCH-FOUND' && message ? { researchNote: message } : {}),
      });
      // A measurement under way stays on screen until it ends.
      if (after.measuring) return { branches: after, step: null };
      return { branches: after, step: { status: 'researching', note: after.researchNote } };
    }
    case 'engineer': {
      // Measuring only while a measurement runs: a cache hit or a result line is not one.
      if (code === 'AUDIO-INIT') {
        return { branches: next({ measuring: true }), step: { status: 'measuring', note: null } };
      }
      const ended = branches.measuring;
      const after = next({ measuring: false });
      // The measurement is over: what is left is the research beside it, which has started
      // with the measurement even when it has not reported yet. Never back to reading the audio.
      const step: Step =
        after.researched || ended
          ? { status: 'researching', note: after.researchNote, ended }
          : { status: 'analyzing', note: null, ended };
      return { branches: after, step };
    }
    case 'composer':
      // The composer's fallback says in its own words that no notes are written.
      return {
        branches: next({ measuring: false }),
        step: {
          status: 'composing',
          note: code?.endsWith('-ERROR') && message ? message : undefined,
        },
      };
    case 'verifier':
      // Its model lines are the check; its other lines (a cover-art lookup) are not.
      return {
        branches,
        step:
          code?.startsWith('LLM-') || code?.startsWith('VERIFY-')
            ? { status: 'checking', note: null }
            : null,
      };
    default:
      return { branches, step: null };
  }
}

/** The progress line after `action`; the same object when the action does not change it. */
export function progressReducer(state: ProgressState, action: AgentAction): ProgressState {
  switch (action.type) {
    case 'reset':
      return INITIAL_PROGRESS;
    case 'started':
      return { status: 'connecting', statusNote: null, isLoading: true };
    case 'checkStarted':
      return { ...state, statusNote: CHECK_NOTE };
    case 'checkEnded':
      return state.statusNote === CHECK_NOTE ? { ...state, statusNote: null } : state;
    case 'opened':
      return state.status === 'connecting' ? { ...state, status: 'searching' } : state;
    case 'stepReported':
      return toStep(state, action.step);
    case 'pickerOpened':
      return { status: 'disambiguation', statusNote: action.question, isLoading: false };
    case 'resumed':
      return { status: 'analyzing', statusNote: RESUME_NOTE, isLoading: true };
    case 'completed':
      return { status: 'complete', statusNote: null, isLoading: false };
    case 'failed':
      return { status: 'error', statusNote: null, isLoading: false };
    default:
      return state;
  }
}
