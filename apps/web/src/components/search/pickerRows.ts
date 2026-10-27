import { choiceMessage } from '@liner-notes/contract/picker';
import type { SearchCandidate } from '../../hooks/agent/types';

/**
 * The rows the track picker shows for the server's candidates: each track id once. The server
 * already sends one row per recording (the contract's `oneRowPerRecording`), so rows are not
 * merged here: an explicit and a clean version, or two edits, are both offered, and the rows
 * show which is which.
 */
export function pickerRows(candidates: SearchCandidate[]): SearchCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => !seen.has(candidate.id) && seen.add(candidate.id));
}

/**
 * The picker's question for `count` rows, in the server's words (the contract's
 * `choiceMessage`). Used when the picker shows another number of rows than the server counted.
 */
export const pickerQuestion = choiceMessage;
