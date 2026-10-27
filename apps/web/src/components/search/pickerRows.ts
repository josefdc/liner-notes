import type { SearchCandidate } from '../../hooks/agent/types';

/** How far apart two lengths may be for two rows to be one recording (a remaster, a reissue). */
const SAME_LENGTH_MS = 2000;

/** A release date that says when: a year, a month or a day, not Spotify's "0000" (unknown). */
const KNOWN_DATE = /^(?!0000)\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

const isrcOf = (row: SearchCandidate) =>
  typeof row.isrc === 'string' && row.isrc.trim() ? row.isrc.trim().toUpperCase() : null;

const knownDate = (row: SearchCandidate) =>
  typeof row.releaseDate === 'string' && KNOWN_DATE.test(row.releaseDate) ? row.releaseDate : null;

/**
 * Whether two rows are one recording listed twice, by the API's rule (scoutNode.ts
 * `sameRecording`): they share an ISRC, are both explicit or both not (or neither is known),
 * and their lengths are known and within SAME_LENGTH_MS. Labels sometimes reuse an ISRC for a
 * clean version or an edit; those stay apart. A row without an ISRC or a length is never merged,
 * even with the same title and artist: two takes (a studio and a live one) may be two
 * recordings, and the picker is the last place to choose between them.
 */
function sameRecording(a: SearchCandidate, b: SearchCandidate): boolean {
  const isrc = isrcOf(a);
  return (
    !!isrc &&
    isrc === isrcOf(b) &&
    (a.explicit ?? null) === (b.explicit ?? null) &&
    typeof a.durationMs === 'number' &&
    typeof b.durationMs === 'number' &&
    Math.abs(a.durationMs - b.durationMs) <= SAME_LENGTH_MS
  );
}

/**
 * Whether `row` is the release to keep rather than `kept`, both of one recording: a known date
 * before an unknown one, and of two known dates the earlier, compared as far as both go (a
 * year alone is as early as any day in it). Otherwise the one listed first is kept.
 */
function keptInstead(row: SearchCandidate, kept: SearchCandidate): boolean {
  const date = knownDate(row);
  const than = knownDate(kept);
  if (!date) return false;
  if (!than) return true;
  const length = Math.min(date.length, than.length);
  return date.slice(0, length) < than.slice(0, length);
}

/**
 * The rows the track picker shows for the server's candidates: each track id once, and the rows
 * of one recording (`sameRecording`) as one, the earliest known release, in the place of the
 * first listed. The API already sends one row per recording; this is a guard for a server that
 * does not, and it applies the API's rule, so it never merges rows the API kept apart.
 */
export function pickerRows(candidates: SearchCandidate[]): SearchCandidate[] {
  const kept: SearchCandidate[] = [];
  const ids = new Set<string>();
  for (const row of candidates) {
    if (ids.has(row.id)) continue;
    ids.add(row.id);
    const place = kept.findIndex((other) => sameRecording(other, row));
    if (place === -1) kept.push(row);
    else if (keptInstead(row, kept[place])) kept[place] = row;
  }
  return kept;
}

/**
 * The picker's question for `count` rows, in the server's words (the scout's `choiceMessage`,
 * apps/api/src/agent/trackMatch.ts; pickerRows.test.ts keeps the two the same). Used only when
 * the picker shows fewer rows than the server counted, so that the question counts the rows
 * shown.
 */
export function pickerQuestion(count: number): string {
  return count === 1
    ? 'One possible track from Spotify; confirm it or search again'
    : `${count} possible tracks from Spotify; choose one`;
}
