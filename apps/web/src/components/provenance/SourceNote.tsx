import type { Evidence } from '@liner-notes/contract';
import type React from 'react';
import { SourceLink } from './SourceLink';

// One cited source as a note beside a claim: its name (a link when it has a plain web address),
// its tier when the claim is shown as sourced, what its record is about, and the day it was
// retrieved. A retrieval time this page cannot read is left out, never guessed.

/** The day a source was retrieved (e.g. "20 Oct 2026", in UTC); null when it cannot be read. */
export function retrievedText(retrievedAt: string): string | null {
  const date = new Date(retrievedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

interface SourceNoteProps {
  evidence: Evidence;
  /** Show the tier ("primary record", "editorial", "web page") after the name. */
  showTier?: boolean;
}

export const SourceNote: React.FC<SourceNoteProps> = ({ evidence, showTier = true }) => {
  const day = retrievedText(evidence.retrievedAt);
  return (
    <span data-source-note className="inline-flex flex-wrap items-center gap-x-1.5 min-w-0">
      <SourceLink evidence={evidence} showTier={showTier} />
      {/* Two unbreakable parts, so a narrow column breaks the note only between them: never
          inside the date, and never with a separator left alone at a line's start */}
      {day && (
        <span>
          <span className="whitespace-nowrap">retrieved</span>{' '}
          <time dateTime={evidence.retrievedAt} className="whitespace-nowrap">
            {day}
          </time>
        </span>
      )}
    </span>
  );
};

export default SourceNote;
