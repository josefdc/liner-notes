/**
 * The track picker's shared rules, used by the API (the scout's candidates and its question) and
 * by the web (the search box's suggestions, the picker's question). Plain code with no schema,
 * so the web loads it from `@liner-notes/contract/picker` without zod.
 */

/**
 * The line that asks the user to choose among `count` tracks: "One possible track from Spotify;
 * confirm it or search again", "5 possible tracks from Spotify; choose one".
 */
export function choiceMessage(count: number): string {
  return count === 1
    ? "One possible track from Spotify; confirm it or search again"
    : `${count} possible tracks from Spotify; choose one`;
}

/** How far a row's length may be from its recording's kept row (a remaster, a reissue). */
export const SAME_RECORDING_MS = 2000;

/** The fields `oneRowPerRecording` reads (a SearchCandidate has them all). */
export interface RecordingRow {
  id: string;
  isrc?: string | null;
  explicit?: boolean | null;
  durationMs?: number;
  releaseDate?: string | null;
  releaseYear?: string;
}

const RELEASE_DATE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

/**
 * The row's release date as an ordering key, or null when it is not known. The date is
 * `releaseDate` when the row has one (Spotify's, as sent), else `releaseYear` (a recorded
 * track); "0000" is Spotify's unknown date, and the year is not read in its place. A year alone
 * sorts after every day in it, and a month after every day in it: the more precise date wins.
 */
function dateKey(row: RecordingRow): string | null {
  const date = typeof row.releaseDate === "string" ? row.releaseDate : row.releaseYear;
  if (typeof date !== "string" || !RELEASE_DATE.test(date) || date.startsWith("0000")) {
    return null;
  }
  return date.length === 4 ? `${date}-99-99` : date.length === 7 ? `${date}-99` : date;
}

/** The recording a row may share with others, or null when it shares none (see below). */
function groupOf(row: RecordingRow): string | null {
  const isrc = typeof row.isrc === "string" ? row.isrc.trim().toUpperCase() : "";
  const known = typeof row.durationMs === "number" && row.durationMs > 0;
  return isrc && known ? `${isrc}\u0000${row.explicit ?? null}` : null;
}

/** Earlier known release first, unknown dates last; then by track id, so no order decides. */
function preferred(a: RecordingRow, b: RecordingRow): number {
  const [ka, kb] = [dateKey(a), dateKey(b)];
  if (ka !== kb) {
    if (ka === null) return 1;
    if (kb === null) return -1;
    return ka < kb ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The rows with each recording listed once. Spotify often lists one recording several times
 * (the album track and its single, a reissue, a compilation). Rows may be one recording only
 * when they share an ISRC and an `explicit` value (or neither is known) and both lengths are
 * known: labels sometimes reuse an ISRC for a clean version or an edit, and a row without an
 * ISRC or a length is never merged, even with the same title and artist (two takes may be two
 * recordings).
 *
 * Within such a group the earliest known release is kept, and it takes every row of the group
 * whose length is within SAME_RECORDING_MS of its own; the earliest release among the rows
 * left is kept next, and so on. A row is merged only into a kept row near its length, never
 * through a chain of rows; kept rows of one group are more than SAME_RECORDING_MS apart, so the
 * result merges nothing further. Which rows are kept does not depend on the rows' order (a
 * tie is settled by track id); each kept row takes the place of the first listed row it
 * stands for. A track id listed again is dropped.
 */
export function oneRowPerRecording<T extends RecordingRow>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  const unique = rows.filter((row) => !seen.has(row.id) && seen.add(row.id));
  const groups = new Map<string, T[]>();
  for (const row of unique) {
    const group = groupOf(row);
    if (group !== null) groups.set(group, [...(groups.get(group) ?? []), row]);
  }
  // Each row's kept row: itself, or the kept row of its recording.
  const keptFor = new Map<T, T>();
  for (const members of groups.values()) {
    for (const kept of [...members].sort(preferred)) {
      if (keptFor.has(kept)) continue;
      for (const row of members) {
        const near = Math.abs((row.durationMs ?? 0) - (kept.durationMs ?? 0)) <= SAME_RECORDING_MS;
        if (!keptFor.has(row) && near) keptFor.set(row, kept);
      }
    }
  }
  const result: T[] = [];
  const placed = new Set<T>();
  for (const row of unique) {
    const kept = keptFor.get(row) ?? row;
    if (!placed.has(kept)) {
      placed.add(kept);
      result.push(kept);
    }
  }
  return result;
}
