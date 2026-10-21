import type React from 'react';
import { forwardRef } from 'react';

type BadgeVariant = 'cyber' | 'analog' | 'purple' | 'green' | 'pink' | 'gray' | 'indigo' | 'amber';
type BadgeSize = 'sm' | 'md';

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant;
  size?: BadgeSize;
  glow?: boolean;
  icon?: React.ReactNode;
}

const variantStyles: Record<BadgeVariant, string> = {
  cyber: 'bg-cyber/10 border-cyber/30 text-cyber',
  analog: 'bg-analog/10 border-analog/30 text-analog',
  purple: 'bg-accent-purple/10 border-accent-purple/30 text-accent-purple',
  green: 'bg-accent-green/10 border-accent-green/30 text-accent-green',
  pink: 'bg-accent-pink/10 border-accent-pink/30 text-accent-pink',
  gray: 'bg-white/5 border-white/15 text-text-tertiary',
  indigo: 'bg-accent-indigo/10 border-accent-indigo/30 text-accent-indigo',
  amber: 'bg-accent-amber/10 border-accent-amber/30 text-accent-amber',
};

const glowStyles: Record<BadgeVariant, string> = {
  cyber: 'shadow-glow-cyber-subtle',
  analog: 'shadow-glow-analog-subtle',
  purple: 'shadow-glow-purple-subtle',
  green: 'shadow-glow-green-subtle',
  pink: 'shadow-glow-pink-subtle',
  gray: '',
  indigo: 'shadow-glow-indigo-subtle',
  amber: 'shadow-glow-amber-subtle',
};

const sizeStyles: Record<BadgeSize, string> = {
  sm: 'px-2.5 py-1 text-chrome gap-1',
  md: 'px-3 py-1.5 text-xs gap-1.5',
};

const baseStyles =
  'inline-flex items-center rounded-sm border font-mono uppercase tracking-widest transition-all duration-(--duration-fast)';

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(
  (
    { children, variant = 'cyber', size = 'sm', glow = false, icon, className = '', ...props },
    ref,
  ) => {
    return (
      <span
        ref={ref}
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
