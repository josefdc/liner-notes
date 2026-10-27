// How the run logs (ActivityLog, SystemConsole) show a recorded line's time since its run
// started, kept apart from both so each can show it without loading the other.

/**
 * A time since the run started, as a line of a recorded run shows it: "+12.4 s" under a
 * minute, then "+1 min 15 s", then "+1 h 2 min". Cut, never rounded up: a line never reads
 * later than it was sent.
 */
export function formatElapsed(ms: number): string {
  const tenths = Math.floor(ms / 100);
  if (tenths < 600) return `+${Math.floor(tenths / 10)}.${tenths % 10} s`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 3600) return `+${Math.floor(seconds / 60)} min ${seconds % 60} s`;
  return `+${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
}
