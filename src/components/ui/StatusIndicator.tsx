import React, { forwardRef } from 'react';

type Status = 'active' | 'idle' | 'error' | 'success' | 'warning';
type Size = 'sm' | 'md';

interface StatusIndicatorProps extends React.HTMLAttributes<HTMLSpanElement> {
  status: Status;
  label?: string;
  pulse?: boolean;
  size?: Size;
}

const statusStyles: Record<Status, { dot: string; text: string; shadow: string }> = {
  active: {
    dot: 'bg-cyber',
    text: 'text-cyber',
    shadow: 'shadow-[0_0_6px_var(--color-cyber)]',
  },
  idle: {
    dot: 'bg-text-tertiary',
    text: 'text-text-tertiary',
    shadow: '',
  },
  error: {
    dot: 'bg-status-error',
    text: 'text-status-error',
    shadow: 'shadow-[0_0_6px_var(--color-status-error)]',
  },
  success: {
    dot: 'bg-status-success',
    text: 'text-status-success',
    shadow: 'shadow-[0_0_6px_var(--color-status-success)]',
  },
  warning: {
    dot: 'bg-analog',
    text: 'text-analog',
    shadow: 'shadow-[0_0_6px_var(--color-analog)]',
  },
};

const sizeStyles: Record<Size, { dot: string; text: string }> = {
  sm: { dot: 'w-1.5 h-1.5', text: 'text-[10px]' },
  md: { dot: 'w-2 h-2', text: 'text-xs' },
};

export const StatusIndicator = forwardRef<HTMLSpanElement, StatusIndicatorProps>(
  ({ status, label, pulse = false, size = 'sm', className = '', ...props }, ref) => {
    const styles = statusStyles[status];
    const sizes = sizeStyles[size];

    return (
      <span
        ref={ref}
        className={`inline-flex items-center gap-1.5 ${className}`}
        role="status"
        aria-label={label || status}
        {...props}
      >
        <span
          className={`${sizes.dot} rounded-full ${styles.dot} ${pulse ? `animate-pulse ${styles.shadow}` : ''}`}
          aria-hidden="true"
        />
        {label && (
          <span className={`${sizes.text} ${styles.text} font-mono tracking-wider uppercase`}>
            {label}
          </span>
        )}
      </span>
    );
  }
);

StatusIndicator.displayName = 'StatusIndicator';

export default StatusIndicator;
