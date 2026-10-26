import type React from 'react';
import { Badge } from '../ui/Badge';

// One audio value as shown on the result screens, with where it comes from: measured from the
// signal, an audio model's score (an estimate, never called measured), a copy no measurement
// confirms, or a score on the first analyzer's own scale. Its confidence and basis are on one line, its method and analyzer on the next, as
// text (not only a tooltip). A result that does not say how a value was measured shows that as
// unknown.

export interface MeasuredValueProps {
  label: string;
  value: React.ReactNode;
  /**
   * measured: from the signal; estimate: an audio model's score; unverified: a copy whose
   * measurement could not be read; score: the first analyzer's 0-1 energy, on its own scale.
   */
  kind: 'measured' | 'estimate' | 'unverified' | 'score';
  /** The estimator's confidence, with its nature; null when the result does not say. */
  confidence?: string | null;
  /** What the value rests on (signal or model, and the preview window); null when unknown. */
  basis?: string | null;
  /** Method, model and analyzer; null when the result does not say. */
  detail?: string | null;
  /** The full provenance, for the tooltip. */
  title: string;
  icon?: React.ReactNode;
  size?: 'sm' | 'md';
  /** One line: the provenance only in the tooltip, for lists whose heading states it. */
  compact?: boolean;
}

export const KIND_TEXT: Record<MeasuredValueProps['kind'], string> = {
  measured: 'Measured',
  estimate: 'Model estimate',
  unverified: 'Not confirmed as measured',
  score: 'v1 energy score (0–1, saturates on loud masters)',
};

/** The provenance line: kind, confidence and basis, each said to be unknown when it is. */
export function provenanceText(
  kind: MeasuredValueProps['kind'],
  confidence: string | null | undefined,
  basis: string | null | undefined,
): string {
  const parts = [KIND_TEXT[kind]];
  if (!confidence && !basis) parts.push('confidence and basis unknown');
  else parts.push(confidence || 'confidence unknown', basis || 'basis unknown');
  return parts.join(' · ');
}

// The provenance lines carry the meaning of the value: text-chip keeps them at WCAG AA. They wrap
// anywhere, so an analyser name wider than a narrow column breaks instead of being cut off.
const LINE = 'max-w-60 wrap-anywhere text-chrome font-mono text-text-chip text-left';

export const MeasuredValue: React.FC<MeasuredValueProps> = ({
  label,
  value,
  kind,
  confidence = null,
  basis = null,
  detail = null,
  title,
  icon,
  size = 'sm',
  compact = false,
}) => {
  const provenance = provenanceText(kind, confidence, basis);
  return (
    <span
      data-value-kind={kind}
      title={compact ? `${title} · ${provenance}` : title}
      className="inline-flex flex-col items-start gap-1 max-w-full"
    >
      <Badge variant={kind === 'measured' ? 'cyber' : 'gray'} size={size} icon={icon}>
        <span className={kind === 'measured' ? 'text-cyber/75' : 'text-text-chip'}>{label}</span>{' '}
        <span className={kind === 'estimate' ? 'text-analog' : ''}>{value}</span>
      </Badge>
      {!compact && <span className={LINE}>{provenance}</span>}
      {!compact && detail && <span className={LINE}>{detail}</span>}
    </span>
  );
};

export default MeasuredValue;
