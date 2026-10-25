import type React from 'react';
import { Badge } from '../ui/Badge';

// A value that is not shown: never a 0 or a placeholder in its place. It says so ("not
// measured", or "not shown" for a value that was measured but says nothing), and why when the
// result says.

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
      <span className="max-w-60 text-[10px] font-mono text-text-tertiary leading-tight text-left">
        — {reason}
      </span>
    )}
  </span>
);

export default MissingValue;
