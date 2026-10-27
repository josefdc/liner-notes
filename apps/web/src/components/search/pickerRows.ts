import type { SearchCandidate } from '@liner-notes/contract';
import { mergeDuplicates } from './useSuggestions';

/**
 * The rows the track picker shows for the server's candidates: each track id once, and the rows
 * that share an ISRC (one recording listed on its album and its single, say) as one, the
 * earliest release (`mergeDuplicates`). The API already sends one row per ISRC; this is a guard
 * for older servers and recordings. Rows without an ISRC are never merged, even with the same
 * title and artist: two takes (a studio and a live one) may be two recordings, and the picker is
 * the last place to choose between them.
 */
export function pickerRows(candidates: SearchCandidate[]): SearchCandidate[] {
  return mergeDuplicates(candidates, 'apart');
}

/**
 * The picker's question for `count` rows, in the server's words (the scout's `choiceMessage`).
 * Used only when the picker shows fewer rows than the server counted, so that the question
 * counts the rows shown.
 */
export function pickerQuestion(count: number): string {
  return count === 1
    ? 'One possible track from Spotify; confirm it or search again'
    : `${count} possible tracks from Spotify; choose one`;
}
