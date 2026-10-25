import type React from 'react';
import { Badge } from '../ui/Badge';

// A value that is not shown: never a 0 or a placeholder in its place. It says so ("not
// measured" for a measurement, "not available" for an audio-model estimate, "not shown" for a
// value that says nothing), and why when the result says.

export interface MissingValueProps {
  label: string;
  /** Why it is missing, in a few words; null when the result does not say. */
  reason?: string | null;
  status?: string;
  size?: 'sm' | 'md';
}

export const MissingValue: React.FC<MissingValueProps> = ({
  label,
  reason = null,
  status = 'not measured',
  size = 'sm',
}) => (
  <span
    data-value-kind="missing"
    title={`${label} ${status}${reason ? `: ${reason}` : ''}`}
    className="inline-flex flex-col items-start gap-1 max-w-full"
  >
    <Badge variant="gray" size={size} className="border-dashed">
      {label} {status}
    </Badge>
    {reason && (
      <span className="max-w-60 text-chrome font-mono text-text-chip text-left">— {reason}</span>
    )}
  </span>
);

export default MissingValue;
