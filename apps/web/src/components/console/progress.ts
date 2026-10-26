import type { AgentStatus } from '../../hooks/agent/types';

// How far along the progress screen's bar is for each step of a run.

/** The statuses of a run under way: the progress screen stays up for them. */
export const ANALYZING_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  'searching',
  'analyzing',
  'measuring',
  'researching',
  'composing',
  'checking',
  'disambiguation',
]);

const PROGRESS: Record<AgentStatus, number> = {
  idle: 0,
  connecting: 10,
  searching: 25,
  // Held at the search's place while the picker is open
  disambiguation: 25,
  analyzing: 50,
  measuring: 50,
  researching: 70,
  composing: 90,
  checking: 95,
  complete: 100,
  error: 0,
};

/** The bar's place for a status. */
export function progressFor(status: AgentStatus): number {
  return PROGRESS[status] ?? 0;
}

// A new run (or none) starts the bar again from its own place.
const RESTARTS: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['idle', 'connecting', 'error']);

/**
 * The bar's place after `status`, given where it is: it never moves back within a run, so a
 * step reported late (the engineer runs beside the historian) does not undo progress.
 */
export function nextProgress(shown: number, status: AgentStatus): number {
  const place = progressFor(status);
  return RESTARTS.has(status) ? place : Math.max(shown, place);
}

/** The result views are loaded ahead while the notes are written and checked. */
export function preloadsResults(status: AgentStatus): boolean {
  return status === 'composing' || status === 'checking';
}
