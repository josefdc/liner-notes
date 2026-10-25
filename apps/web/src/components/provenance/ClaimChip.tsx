import type { Claim, ClaimKind } from '@liner-notes/contract';
import { BookOpenCheck, Gauge } from 'lucide-react';
import type React from 'react';
import { formatSeconds, type Reading } from '../../constants';
import { InferenceLabel, ReadingValue } from '../EstimatedWarning';
import { Badge } from '../ui/Badge';
import type { ShownClaim } from './claims';
import { SourceLink } from './SourceLink';

// Where one claim comes from, as text: its kind (measured, sourced or model inference), the
// sources it cites with their tier, what the verifier said ("not checked" when it has not
// judged it), and, when the claim's number disagrees with the measurement, both values.
//
// A claim shown as measured is shown with the measured value itself (MeasuredValue, with its
// confidence and basis); a claim about a value that was not measured is shown with that value
// as missing, and why. A model claim's citations are listed as citations, never with a tier:
// only a claim shown as sourced carries its sources' tiers.

export const KIND_TEXT: Record<ClaimKind, string> = {
  measured: 'Measured',
  sourced: 'Sourced',
  inferred: 'Model inference',
};

/** What the verifier's judge said of a claim, in words; "not checked" when it did not judge. */
export const VERDICT_TEXT: Record<NonNullable<Claim['verdict']> | 'none', string> = {
  supported: 'supported by its sources',
  partial: 'partly supported by its sources',
  unsupported: 'not supported by its sources',
  contradicted: 'contradicted by its sources',
  none: 'not checked',
};

/** The provenance lines carry the meaning of the claim: text-chip keeps them at WCAG AA. */
export const LINE = 'text-chrome font-mono text-text-chip';

/** The measured value a claim's field names (tempo → BPM, key → key). */
export function readingFor(claim: Claim, readings: readonly Reading[]): Reading | null {
  if (claim.field === undefined) return null;
  const field = claim.field === 'tempo' ? 'bpm' : 'key';
  return readings.find((reading) => reading.field === field) ?? null;
}

const show = (value: number | string) => (typeof value === 'number' ? String(value) : value);

/**
 * The two values of a numeric check, as the result gives them; null without a comparison (the
 * values are never made up).
 */
export function comparisonText(claim: Claim, windowSeconds?: number): string | null {
  const comparison = claim.numericComparison;
  if (!comparison) return null;
  const window =
    windowSeconds !== undefined ? `${formatSeconds(windowSeconds)} s preview` : '30 s preview';
  return `the claim says ${show(comparison.claimed)} · measured ${show(comparison.measured)} (${comparison.method}, ${window})`;
}

/** The conflict line: both values, or that the result does not give them. */
export function conflictText(claim: Claim, windowSeconds?: number): string {
  const both = comparisonText(claim, windowSeconds);
  if (both) return `Conflict with the measurement: ${both}`;
  const reason = claim.numericReason ? ` (${claim.numericReason})` : '';
  return `Conflict with the measurement${reason}; the result does not give the two values`;
}

/** The verifier's status of a shown claim, in words. */
export function statusText(shown: ShownClaim): string {
  const { claim, kind } = shown;
  const verdict = VERDICT_TEXT[claim.verdict ?? 'none'];
  return kind === 'sourced' && claim.origin === 'code'
    ? `taken from the source record · ${verdict}`
    : verdict;
}

const KindBadge: React.FC<{ kind: ClaimKind }> = ({ kind }) => {
  if (kind === 'inferred') return <InferenceLabel />;
  if (kind === 'sourced') {
    return (
      <Badge variant="green" icon={<BookOpenCheck size={10} />}>
        {KIND_TEXT.sourced}
      </Badge>
    );
  }
  return (
    <Badge variant="cyber" icon={<Gauge size={10} />}>
      {KIND_TEXT.measured}
    </Badge>
  );
};

interface ClaimChipProps {
  shown: ShownClaim;
  /** The result's signal readings (tempo, key), for a claim about a measured value. */
  readings?: readonly Reading[];
  /** Length of the measured preview window, for the conflict line. */
  windowSeconds?: number;
  className?: string;
}

export const ClaimChip: React.FC<ClaimChipProps> = ({
  shown,
  readings = [],
  windowSeconds,
  className = '',
}) => {
  const { claim, kind, cited, missingCitations } = shown;
  const reading = claim.kind === 'measured' ? readingFor(claim, readings) : null;
  // A measured claim's own value, as measured; any other claim about a measured value says
  // nothing more about it than its text.
  const measuredValue = kind === 'measured' && reading?.state === 'shown' ? reading : null;
  const missingValue = reading?.state === 'missing' ? reading : null;
  const partial = kind === 'sourced' && claim.verdict === 'partial';
  const conflict = claim.numericCheck === 'conflict';
  return (
    <div
      data-claim-kind={kind}
      data-claim-id={claim.id}
      className={`flex flex-col items-start gap-1 ${className}`}
    >
      {measuredValue ? (
        <ReadingValue reading={measuredValue} />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <KindBadge kind={kind} />
          {partial && <Badge variant="gray">Partly supported</Badge>}
          {conflict && <Badge variant="amber">Conflict</Badge>}
          {kind !== 'measured' && !partial && <span className={LINE}>{statusText(shown)}</span>}
        </div>
      )}
      {missingValue && <ReadingValue reading={missingValue} />}
      {cited.length > 0 && (
        <p className={`${LINE} flex flex-wrap items-center gap-x-2 gap-y-1`}>
          <span>{kind === 'sourced' ? 'Sources:' : 'Cited by the model:'}</span>
          {cited.map((evidence) => (
            <SourceLink key={evidence.id} evidence={evidence} showTier={kind === 'sourced'} />
          ))}
        </p>
      )}
      {missingCitations > 0 && (
        <p className={LINE}>
          {missingCitations === 1
            ? '1 cited source is not in this result'
            : `${missingCitations} cited sources are not in this result`}
        </p>
      )}
      {conflict && <p className={LINE}>{conflictText(claim, windowSeconds)}</p>}
    </div>
  );
};

export default ClaimChip;
