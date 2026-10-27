import type { ClaimAbout } from '@liner-notes/contract';
import type React from 'react';
import { useId } from 'react';
import type { Reading } from '../../constants';
import { claimRelationKnown, claimRelationWords } from '../genealogy/relationWords';
import type { MeasuredAudio } from '../measured/audio';
import type { ShownClaim } from './claims';
import { ClaimChip, LINE } from './ClaimChip';

// Claims of a result that no factoid card or credit shows, each with what it is about and where
// it comes from, so that no statement of the result is left out of view. A claim that states a
// relation is named in the words the genealogy and the fact cards use (`claimRelationWords`):
// "Possible sample" unless it is known, and a link's claim as its link is named.

export const ABOUT_TEXT: Record<ClaimAbout, string> = {
  track: 'Track',
  credit: 'Credit',
  sample: 'Sample',
  cover: 'Cover',
  history: 'History',
  sound: 'Sound',
  production: 'Production',
  connection: 'Connection',
  trivia: 'Trivia',
};

interface ClaimListProps {
  title: string;
  claims: readonly ShownClaim[];
  /**
   * What the section says when it lists no claim (it is left out without one): a plain sentence
   * such as "No history was found in this result.", never content of its own.
   */
  emptyText?: string;
  /** How many claims of the section are shown on the fact cards instead (not listed again). */
  onCards?: number;
  readings?: readonly Reading[];
  audio?: MeasuredAudio | null;
  /** The words of the shown genealogy link that states a claim, by claim id. */
  relations?: ReadonlyMap<string, string>;
  className?: string;
}

/** What a listed claim is about, in words: the relation it states, or its subject. */
export function claimLabel(shown: ShownClaim, relations?: ReadonlyMap<string, string>): string {
  const { claim } = shown;
  return (
    claimRelationWords(
      claim.about,
      claimRelationKnown(shown.kind, claim),
      relations?.get(claim.id),
    ) ?? ABOUT_TEXT[claim.about]
  );
}

export const ClaimList: React.FC<ClaimListProps> = ({
  title,
  claims,
  emptyText,
  onCards = 0,
  readings,
  audio,
  relations,
  className = '',
}) => {
  const headingId = useId();
  if (claims.length === 0 && onCards === 0 && emptyText === undefined) return null;
  return (
    <section aria-labelledby={headingId} className={`space-y-3 ${className}`}>
      <h2 id={headingId} className="text-xs font-mono text-text-chip uppercase tracking-widest">
        {title}
      </h2>
      {onCards > 0 && (
        <p className={LINE}>
          {onCards === 1
            ? '1 claim of this section is shown with the facts above.'
            : `${onCards} claims of this section are shown with the facts above.`}
        </p>
      )}
      {claims.length === 0 && onCards === 0 && emptyText !== undefined && (
        <p className={LINE}>{emptyText}</p>
      )}
      {claims.length > 0 && (
        <ul className="space-y-4">
          {claims.map((shown) => (
            <li key={shown.key} className="space-y-1.5">
              <p className="text-sm text-text-secondary">
                <span
                  data-claim-about
                  className="text-chrome font-mono text-text-chip uppercase tracking-widest mr-2"
                >
                  {claimLabel(shown, relations)}
                </span>
                {shown.claim.text}
              </p>
              <ClaimChip shown={shown} readings={readings} audio={audio} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

export default ClaimList;
