import type React from 'react';
import { Badge } from '../ui/Badge';

// One audio value as shown on the result screens, with where it comes from: measured from the
// signal, or an audio model's score (an estimate, never called measured), with its confidence
// and basis. A result that does not say how a value was measured shows that as unknown.

export interface MeasuredValueProps {
  label: string;
  value: React.ReactNode;
  /** measured: from the signal; estimate: an audio model's score. */
  kind: 'measured' | 'estimate';
  /** The estimator's confidence in words; null when the result does not say. */
  confidence?: string | null;
  /** What the value rests on (signal or model, and the preview window); null when unknown. */
  basis?: string | null;
  /** The full provenance (method, model, analyzer). */
  title: string;
  icon?: React.ReactNode;
  size?: 'sm' | 'md';
  /** One line: the provenance only in the tooltip, for lists whose heading states it. */
  compact?: boolean;
}

export const KIND_TEXT: Record<MeasuredValueProps['kind'], string> = {
  measured: 'Measured',
  estimate: 'Model estimate',
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

export const MeasuredValue: React.FC<MeasuredValueProps> = ({
  label,
  value,
  kind,
  confidence = null,
  basis = null,
  title,
  icon,
  size = 'sm',
  compact = false,
}) => (
  <span
    data-value-kind={kind}
    title={compact ? `${title} · ${provenanceText(kind, confidence, basis)}` : title}
    className="inline-flex flex-col items-start gap-1 max-w-full"
  >
    <Badge variant={kind === 'measured' ? 'cyber' : 'gray'} size={size} icon={icon}>
      <span className={kind === 'measured' ? 'opacity-60' : 'text-text-chip'}>{label}</span>{' '}
      <span className={kind === 'measured' ? '' : 'text-analog'}>{value}</span>
    </Badge>
    {!compact && (
      <span className="max-w-60 text-[10px] font-mono text-text-tertiary leading-tight text-left">
        {provenanceText(kind, confidence, basis)}
      </span>
    )}
  </span>
);

export default MeasuredValue;
