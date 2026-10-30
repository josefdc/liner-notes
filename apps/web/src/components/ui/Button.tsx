import type React from 'react';
import { forwardRef } from 'react';

type ButtonVariant = 'cyber' | 'analog' | 'ghost' | 'neutral' | 'spotify';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  isLoading?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
}

const variantStyles: Record<ButtonVariant, string> = {
  cyber:
    'border-cyber/50 text-cyber hover:bg-cyber/10 hover:border-cyber/70 hover:shadow-glow-cyber-subtle hover:-translate-y-px active:translate-y-0 focus-visible:ring-cyber/70',
  analog:
    'border-analog/50 text-analog hover:bg-analog/10 hover:border-analog/70 hover:shadow-glow-analog-subtle hover:-translate-y-px active:translate-y-0 focus-visible:ring-analog/70',
  ghost:
    'border-white/10 text-text-tertiary hover:text-white hover:bg-white/5 hover:border-white/20 focus-visible:ring-white/60',
  // A plain action that says nothing about how data is known: white, not cyan or amber.
  neutral:
    'border-white/40 text-text-primary hover:bg-white/10 hover:border-white/60 hover:-translate-y-px active:translate-y-0 focus-visible:ring-white/60',
  spotify:
    'border-spotify/50 text-spotify hover:bg-spotify/10 hover:border-spotify/70 hover:shadow-glow-spotify-subtle focus-visible:ring-spotify/70',
};

const sizeStyles: Record<ButtonSize, string> = {
  sm: 'px-3 py-1.5 text-xs gap-1.5',
  md: 'px-6 py-2.5 text-sm gap-2',
  lg: 'px-8 py-3.5 text-base gap-2.5 min-h-[48px]',
};

const baseStyles = [
  'inline-flex items-center justify-center',
  'bg-transparent border font-mono tracking-widest uppercase rounded-sm',
  // One transition list: colours, the glow and focus ring (box-shadow), the hover lift
  // (translate) and the press (scale). Durations pair with the properties in order; the focus
  // ring answers faster than the rest.
  'transition-[color,background-color,border-color,box-shadow,translate,scale] ease-out-expo',
  'duration-[var(--duration-fast),var(--duration-fast),var(--duration-fast),var(--duration-focus),var(--duration-fast),var(--duration-fast)]',
  'active:scale-[0.97]',
  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-void',
  'disabled:opacity-50 disabled:cursor-not-allowed disabled:pointer-events-none',
].join(' ');

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = 'cyber',
      size = 'md',
      isLoading = false,
      leftIcon,
      rightIcon,
      children,
      className = '',
      disabled,
      ...props
    },
    ref,
  ) => {
    const isDisabled = disabled || isLoading;

    return (
      <button
        ref={ref}
        className={`${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
        disabled={isDisabled}
        aria-busy={isLoading}
        aria-disabled={isDisabled}
        {...props}
      >
        {isLoading ? (
          <span
            className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"
            aria-hidden="true"
          />
        ) : (
          leftIcon
        )}
        {children}
        {!isLoading && rightIcon}
      </button>
    );
  },
);

Button.displayName = 'Button';

export default Button;
