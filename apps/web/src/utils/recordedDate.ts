// How the result screens and the paused-analysis banner show when a run was recorded.

/** A recording date as shown: the day, in UTC (e.g. "24 Oct 2026"); null when there is none. */
export function recordedDate(recordedAt: string | null): string | null {
  if (!recordedAt) return null;
  const date = new Date(recordedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}
