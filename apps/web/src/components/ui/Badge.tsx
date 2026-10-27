import type React from 'react';
import { forwardRef } from 'react';

/**
 * What a badge says about its content, which sets its colour: how a value is known (measured,
 * sourced, inferred), a warning (a claim its evidence contradicts), an error, or nothing in
 * particular (neutral). The colour is never the only cue: a badge's words say the same.
 */
export type BadgeVariant = 'measured' | 'sourced' | 'inferred' | 'warning' | 'error' | 'neutral';
type BadgeSize = 'xs' | 'sm' | 'md';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  /** A faint glow in the badge's colour (measured and sourced only). */
  glow?: boolean;
  icon?: React.ReactNode;
}

const variantStyles: Record<BadgeVariant, string> = {
  measured: 'bg-prov-measured/10 border-prov-measured/30 text-prov-measured',
  sourced: 'bg-prov-sourced/10 border-prov-sourced/30 text-prov-sourced',
  inferred: 'bg-prov-inferred/10 border-prov-inferred/30 text-prov-inferred',
  // A claim its evidence contradicts: orange, apart from the amber of sources
  warning: 'bg-status-warning/10 border-status-warning/30 text-status-warning',
  error: 'bg-status-error/10 border-status-error/30 text-status-error',
  neutral: 'bg-white/5 border-white/15 text-text-chip',
};

const glowStyles: Record<BadgeVariant, string> = {
  measured: 'shadow-glow-cyber-subtle',
  sourced: 'shadow-glow-analog-subtle',
  inferred: '',
  warning: '',
  error: '',
  neutral: '',
};

const sizeStyles: Record<BadgeSize, string> = {
  // A marker inside a line of text: no taller than the text's own line (leading-none).
  xs: 'px-1 text-chrome leading-none gap-0.5',
  sm: 'px-2.5 py-1 text-chrome gap-1',
  md: 'px-3 py-1.5 text-xs gap-1.5',
};

// max-w-full: in a column narrower than the badge, its text wraps instead of running past the edge.
const baseStyles =
  'inline-flex max-w-full items-center rounded-sm border font-mono uppercase tracking-widest wrap-break-word transition-all duration-(--duration-fast)';

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  (
    { children, variant = 'neutral', size = 'sm', glow = false, icon, className = '', ...props },
    ref,
  ) => {
    return (
      <span
        ref={ref}
        data-variant={variant}
        className={`${baseStyles} ${sizeStyles[size]} ${variantStyles[variant]} ${glow ? glowStyles[variant] : ''} ${className}`}
        {...props}
      >
        {icon && (
          <span className="flex-shrink-0" aria-hidden="true">
            {icon}
          </span>
        )}
        {children}
      </span>
    );
  },
);

Badge.displayName = 'Badge';

export default Badge;
