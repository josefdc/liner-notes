import type { ClaimAbout } from '@liner-notes/contract';
import type React from 'react';
import { useId } from 'react';
import type { Reading } from '../../constants';
import type { ShownClaim } from './claims';
import { ClaimChip } from './ClaimChip';

// Claims of a result that no factoid card or credit shows, each with what it is about and where
// it comes from, so that no statement of the result is left out of view.

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
  readings?: readonly Reading[];
  windowSeconds?: number;
  className?: string;
}

export const ClaimList: React.FC<ClaimListProps> = ({
  title,
  claims,
  readings,
  windowSeconds,
  className = '',
}) => {
  const headingId = useId();
  if (claims.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className={`space-y-3 ${className}`}>
      <h4 id={headingId} className="text-xs font-mono text-text-tertiary uppercase tracking-widest">
        {title}
      </h4>
      <ul className="space-y-4">
        {claims.map((shown) => (
          <li key={shown.claim.id} className="space-y-1.5">
            <p className="text-sm text-text-secondary">
              <span className="text-chrome font-mono text-text-chip uppercase tracking-widest mr-2">
                {ABOUT_TEXT[shown.claim.about]}
              </span>
              {shown.claim.text}
            </p>
            <ClaimChip shown={shown} readings={readings} windowSeconds={windowSeconds} />
          </li>
        ))}
      </ul>
    </section>
  );
};

export default ClaimList;
