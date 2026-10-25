import type React from 'react';
import { useId } from 'react';
import type { Reading } from '../../constants';
import type { ProductionCredits } from '../../types';
import { InferenceLabel } from '../EstimatedWarning';
import type { ShownClaim } from './claims';
import { ClaimChip, LINE } from './ClaimChip';

// The credits of a result: each credit claim (about "credit") with where it comes from, its
// sources and their tiers when it is sourced. A credit is never taken from the claim's wording:
// claims carry no structured role yet, so each is listed as written. Credits from an older
// result's `credits` lists (producers, writers, engineers) were written by the model without a
// source: they are listed apart, as model inference with no source cited, never as sourced.
// With neither, the list says that no credits were found.

const names = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((name): name is string => typeof name === 'string' && name.trim() !== '')
    : [];

/** The roles of an older result's `credits`, each with its names; empty roles left out. */
export function uncitedCreditRows(credits: ProductionCredits | undefined) {
  const roles: Array<[string, string[]]> = [
    ['Producers', names(credits?.producers)],
    ['Writers', names(credits?.writers)],
    ['Engineers', names(credits?.engineers)],
  ];
  return roles
    .filter(([, listed]) => listed.length > 0)
    .map(([role, listed]) => ({ role, names: listed }));
}

interface CreditsListProps {
  /** The result's credit claims that are not rejected. */
  credits: readonly ShownClaim[];
  /** An older result's `credits` lists, written without a source. */
  uncited?: ProductionCredits;
  readings?: readonly Reading[];
  windowSeconds?: number;
  className?: string;
}

export const CreditsList: React.FC<CreditsListProps> = ({
  credits,
  uncited,
  readings,
  windowSeconds,
  className = '',
}) => {
  const rows = uncitedCreditRows(uncited);
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={`space-y-3 ${className}`}>
      <h4 id={headingId} className="text-xs font-mono text-text-tertiary uppercase tracking-widest">
        Credits
      </h4>
      {credits.length === 0 && rows.length === 0 && (
        <p className={LINE}>No credits found in this result.</p>
      )}
      {credits.length > 0 && (
        <ul aria-label="Credit claims" className="space-y-3">
          {credits.map((shown) => (
            <li key={shown.claim.id} className="space-y-1.5">
              <p className="text-sm text-text-secondary">{shown.claim.text}</p>
              <ClaimChip shown={shown} readings={readings} windowSeconds={windowSeconds} />
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && (
        <div className="space-y-1.5" data-claim-kind="inferred">
          <div className="flex flex-wrap items-center gap-1.5">
            <InferenceLabel />
            <span className={LINE}>no source cited</span>
          </div>
          <dl aria-label="Credits without a source" className="space-y-1">
            {rows.map(({ role, names: listed }) => (
              <div key={role} className="flex flex-wrap gap-x-2 text-sm">
                <dt className="text-text-chip font-mono text-xs uppercase tracking-widest">
                  {role}
                </dt>
                <dd className="text-text-secondary">{listed.join(', ')}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
};

export default CreditsList;
