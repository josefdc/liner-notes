import { ChevronDown } from 'lucide-react';
import type React from 'react';
import { useId, useState } from 'react';
import type { ShownClaim } from './claims';
import { comparisonText, LINE } from './ClaimChip';
import { SourceLink } from './SourceLink';

// The claims the verifier rejected, kept out of the main view: a claim its judge found
// contradicted by its sources, or whose number the measurement contradicts, whatever its kind.
// Collapsed by default behind a real disclosure button that names how many there are; each
// claim is listed with why it was rejected and the sources it was checked against.

/** Why a claim was rejected, in words: what contradicted it, and the reason when given. */
export function rejectionReasons(shown: ShownClaim, windowSeconds?: number): string[] {
  const { claim } = shown;
  const reasons: string[] = [];
  if (claim.verdict === 'contradicted') {
    reasons.push(
      `Contradicted by its sources: ${claim.verdictReason?.trim() || 'the verifier gave no reason'}`,
    );
  }
  if (claim.numericCheck === 'contradicted') {
    const both = comparisonText(claim, windowSeconds);
    const reason = claim.numericReason?.trim();
    reasons.push(
      `Contradicted by the measurement: ${[both, reason].filter(Boolean).join('; ') || 'no values given'}`,
    );
  }
  return reasons;
}

interface RejectedClaimsProps {
  rejected: readonly ShownClaim[];
  windowSeconds?: number;
  className?: string;
}

export const RejectedClaims: React.FC<RejectedClaimsProps> = ({
  rejected,
  windowSeconds,
  className = '',
}) => {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  if (rejected.length === 0) return null;
  return (
    <section aria-label="Rejected claims" className={`border-t border-white/10 pt-4 ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
        className="w-full flex items-center justify-between gap-2 py-2 text-xs font-mono uppercase tracking-widest text-text-secondary hover:text-white focus-visible:ring-2 focus-visible:ring-cyber/30 focus-visible:outline-none rounded-sm"
      >
        <span>{`Rejected by the verifier (${rejected.length})`}</span>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      <div id={panelId} hidden={!open} className="space-y-3 pt-2">
        <p className={LINE}>
          The verifier found these claims contradicted. They are not shown with the analysis.
        </p>
        <ul className="space-y-3">
          {rejected.map((shown) => (
            <li
              key={shown.claim.id}
              data-claim-id={shown.claim.id}
              className="border-l-2 border-white/15 pl-3 space-y-1"
            >
              <p className="text-sm text-text-secondary">{shown.claim.text}</p>
              {rejectionReasons(shown, windowSeconds).map((reason) => (
                <p key={reason} className={LINE}>
                  {reason}
                </p>
              ))}
              {shown.cited.length > 0 && (
                <p className={`${LINE} flex flex-wrap items-center gap-x-2 gap-y-1`}>
                  <span>Checked against:</span>
                  {shown.cited.map((evidence) => (
                    <SourceLink key={evidence.id} evidence={evidence} />
                  ))}
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
};

export default RejectedClaims;
