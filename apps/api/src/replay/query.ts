/**
 * How the replay code compares texts: the loader (records.ts) matches a query to a record's
 * track by it, and the recorder (recorder.ts) looks for the typed query in a record by it. Kept
 * apart from both, so the loader can run the recorder's checks without the two importing each
 * other.
 */

/** Lower case, without accents, with every run of punctuation and spaces as one space. */
export function normalizeQuery(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
