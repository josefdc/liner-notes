import { Badge } from '../ui/Badge';

/** A track's length as m:ss, or null when it is not known (never "0:00"). */
export function lengthOf(durationMs: number | undefined): string | null {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  const seconds = Math.floor(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

interface TrackVersionProps {
  durationMs?: number;
  explicit?: boolean | null;
}

/**
 * Which version of a song a row stands for: its length ("• 3:38") and an "E" marker, read as
 * "Explicit", when Spotify marks it explicit. Each is shown only when known. Rows of one song
 * that the search box and the picker keep apart (a clean and an explicit version under one
 * ISRC, two edits) can share a title, an artist and an album; these tell them apart, on screen
 * and in the rows' accessible names. Placed after the row's truncated text, in a flex line:
 * neither part shrinks, and the marker is no taller than the line.
 */
export function TrackVersion({ durationMs, explicit }: TrackVersionProps) {
  const length = lengthOf(durationMs);
  return (
    <>
      {length && <span className="flex-shrink-0 font-mono">• {length}</span>}
      {explicit === true && (
        <Badge variant="neutral" size="xs" className="flex-shrink-0">
          <span aria-hidden="true">E</span>
          {/* Its own case: the badge's capitals would make it "EXPLICIT" in some readers */}
          <span className="sr-only normal-case">Explicit</span>
        </Badge>
      )}
    </>
  );
}
