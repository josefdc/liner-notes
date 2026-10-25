import type { Claim, ClaimKind } from '@liner-notes/contract';
import { BookOpenCheck, Gauge } from 'lucide-react';
import type React from 'react';
import { formatBpm, formatSeconds, type Reading } from '../../constants';
import { InferenceLabel, ReadingValue } from '../EstimatedWarning';
import { keyLabel, type MeasuredAudio } from '../measured/audio';
import { Badge } from '../ui/Badge';
import type { ShownClaim } from './claims';
import { SourceLink } from './SourceLink';

// Where one claim comes from, as text: its kind (measured, sourced or inferred), the sources it
// cites with their tier, what the verifier said ("not checked by the verifier" when it has not
// judged it, and its reason when it found the claim only partly supported or not supported),
// and, when the claim's number disagrees with the measurement, both values.
//
// A claim shown as measured is shown with the measured value itself (MeasuredValue, with its
// confidence and basis); a claim about a value that was not measured is shown with that value
// as missing, and why. The measured side of a conflict is always the result's own measurement,
// never a number the claim carries. A claim not shown as sourced lists what it cites without a
// tier: only a claim shown as sourced carries its sources' tiers.

export const KIND_TEXT: Record<ClaimKind, string> = {
  measured: 'Measured',
  sourced: 'Sourced',
  inferred: 'Model inference',
};

/** The provenance lines carry the meaning of the claim: text-chip keeps them at WCAG AA. */
export const LINE = 'text-chrome font-mono text-text-chip';

/** The measured value a claim's field names (tempo → BPM, key → key). */
export function readingFor(claim: Claim, readings: readonly Reading[]): Reading | null {
  if (claim.field === undefined) return null;
  const field = claim.field === 'tempo' ? 'bpm' : 'key';
  return readings.find((reading) => reading.field === field) ?? null;
}

/**
 * The measured value a claim's field names, from the result's measurement: the value, its
 * method and the preview window; null when the measurement does not hold it (no block, a gate
 * that did not pass, a field that was not measured, or a claim that names no field).
 */
export function measuredSide(
  claim: Claim,
  audio: MeasuredAudio | null | undefined,
): { value: string; method: string; window: string } | null {
  if (!audio?.gate.passed || claim.field === undefined) return null;
  const window = `${formatSeconds(audio.windowSeconds)} s preview`;
  if (claim.field === 'tempo') {
    return audio.tempo
      ? { value: `${formatBpm(audio.tempo.bpm)} BPM`, method: audio.tempo.method, window }
      : null;
  }
  return audio.key ? { value: keyLabel(audio.key), method: audio.key.method, window } : null;
}

const show = (value: number | string) => (typeof value === 'number' ? String(value) : value);

/**
 * The two sides of a numeric check: the claim's value as the result gives it, and the value the
 * result's measurement holds. A side the result does not hold is said to be missing, never
 * filled in.
 */
export function comparisonText(claim: Claim, audio: MeasuredAudio | null | undefined): string {
  const comparison = claim.numericComparison;
  const claimed = comparison
    ? `the claim says ${show(comparison.claimed)}`
    : "the result does not give the claim's value";
  const measured = measuredSide(claim, audio);
  const measuredPart = measured
    ? `measured ${measured.value} (${measured.method}, ${measured.window})`
    : 'the measured value is not available in this result';
  return `${claimed} · ${measuredPart}`;
}

/** The conflict line: what was compared, both sides as the result holds them. */
export const conflictText = (claim: Claim, audio: MeasuredAudio | null | undefined): string =>
  `Conflict with the measurement: ${comparisonText(claim, audio)}`;

/**
 * The verifier's status of a shown claim, in words; null for a measured claim (the verifier does
 * not judge measurements). A partly supported or unsupported claim says so with its reason
 * instead (verdictReasonText).
 */
export function statusText(shown: ShownClaim): string | null {
  const { claim, kind } = shown;
  if (kind === 'measured') return null;
  const parts: string[] = [];
  if (kind === 'sourced' && claim.origin === 'code') parts.push('taken from the source record');
  if (claim.verdict === null) {
    // When the numeric check ran (conflict, consistent), only the text has no verdict.
    parts.push(
      claim.numericCheck === 'conflict' || claim.numericCheck === 'consistent'
        ? 'no verifier verdict on its text'
        : 'not checked by the verifier',
    );
  } else if (claim.verdict === 'supported') {
    // Support that rests in part on sources this result does not hold is not shown as plain.
    parts.push(
      shown.missingCitations > 0
        ? 'found supported by sources that are not all in this result'
        : 'supported by its sources',
    );
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** What the verifier objected to: its reason for a partial or unsupported verdict. */
export function verdictReasonText(claim: Claim): string | null {
  const reason = claim.verdictReason?.trim();
  if (claim.verdict === 'partial') {
    return `Partly supported: ${reason || 'the verifier did not say which part is unsupported'}`;
  }
  if (claim.verdict === 'unsupported') {
    return `Not supported by its sources: ${reason || 'the verifier gave no reason'}`;
  }
  return null;
}

/**
 * The measured value a claim names, beside a claim not shown as measured whose number was not
 * found in conflict: "not compared with the measurement" when no numeric check ran, "agrees with
 * the measurement" when it did and agreed. The value is the result's own measurement; null when
 * the measurement does not hold it.
 */
export function measurementBesideText(
  shown: ShownClaim,
  audio: MeasuredAudio | null | undefined,
): string | null {
  const { claim, kind } = shown;
  if (kind === 'measured') return null;
  if (claim.numericCheck === 'conflict' || claim.numericCheck === 'contradicted') return null;
  const measured = measuredSide(claim, audio);
  if (!measured) return null;
  const check =
    claim.numericCheck === 'consistent'
      ? 'agrees with the measurement'
      : 'not compared with the measurement';
  return `${check} · measured ${measured.value} (${measured.method}, ${measured.window})`;
}

/** How a claim's citations are introduced: by who cited them, or as the claim's sources. */
export function citationsText(shown: ShownClaim): string {
  if (shown.kind === 'sourced') return 'Sources:';
  return shown.claim.origin === 'code' ? 'Cites:' : 'Cited by the model:';
}

const KindBadge: React.FC<{ kind: ClaimKind; origin: Claim['origin'] }> = ({ kind, origin }) => {
  // A code-built claim that cannot be shown as measured or sourced is inferred, not the model's.
  if (kind === 'inferred')
    return <InferenceLabel>{origin === 'code' ? 'Inferred' : undefined}</InferenceLabel>;
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
  /** The result's measurement, for the measured side of a conflict. */
  audio?: MeasuredAudio | null;
  className?: string;
}

export const ClaimChip: React.FC<ClaimChipProps> = ({
  shown,
  readings = [],
  audio = null,
  className = '',
}) => {
  const { claim, kind, cited, missingCitations } = shown;
  const reading = claim.kind === 'measured' ? readingFor(claim, readings) : null;
  // A measured claim's own value, as measured; any other claim about a measured value says
  // nothing more about it than its text.
  const measuredValue = kind === 'measured' && reading?.state === 'shown' ? reading : null;
  const missingValue = reading?.state === 'missing' ? reading : null;
  const partial = kind === 'sourced' && claim.verdict === 'partial';
  const unsupported = kind === 'sourced' && claim.verdict === 'unsupported';
  const conflict = claim.numericCheck === 'conflict';
  const status = statusText(shown);
  const reason = verdictReasonText(claim);
  const besides = measurementBesideText(shown, audio);
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
          <KindBadge kind={kind} origin={claim.origin} />
          {partial && <Badge variant="gray">Partly supported</Badge>}
          {unsupported && <Badge variant="amber">Not supported</Badge>}
          {conflict && <Badge variant="amber">Conflict</Badge>}
          {status && <span className={LINE}>{status}</span>}
        </div>
      )}
      {missingValue && <ReadingValue reading={missingValue} />}
      {reason && <p className={LINE}>{reason}</p>}
      {cited.length > 0 && (
        <p className={`${LINE} flex flex-wrap items-center gap-x-2 gap-y-1`}>
          <span>{citationsText(shown)}</span>
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
      {conflict && <p className={LINE}>{conflictText(claim, audio)}</p>}
      {besides && <p className={LINE}>{besides}</p>}
    </div>
  );
};

export default ClaimChip;
