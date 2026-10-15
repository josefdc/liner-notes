import React, { forwardRef, useId } from 'react';

interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  error?: string;
  label?: string;
}

export const inputVisualStyles = [
  'w-full py-4 bg-black/40 border border-border rounded-[--radius-sm]',
  'text-white placeholder-text-muted font-mono text-sm tracking-wide',
  'focus:outline-none focus:border-cyber/50 focus:bg-black/60 focus:shadow-[var(--shadow-input-focus)]',
  'transition-[color,background-color,border-color,box-shadow] duration-[--duration-normal] ease-[--ease-out-expo]',
].join(' ');

const baseInputStyles = inputVisualStyles;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ leftIcon, rightIcon, error, label, className = '', id: propId, ...props }, ref) => {
    const generatedId = useId();
    const id = propId || generatedId;
    const errorId = `${id}-error`;

    return (
      <div className="relative w-full">
        {label && (
          <label
            htmlFor={id}
            className="block mb-2 text-xs font-mono text-text-tertiary uppercase tracking-wider"
          >
            {label}
          </label>
        )}
        <div className="relative">
          {leftIcon && (
            <div
              className="absolute left-4 top-1/2 -translate-y-1/2 text-text-tertiary z-10 pointer-events-none"
              aria-hidden="true"
            >
              {leftIcon}
            </div>
          )}
          <input
            ref={ref}
            id={id}
            className={`
              ${baseInputStyles}
              ${leftIcon ? 'pl-12' : 'pl-4'}
              ${rightIcon ? 'pr-12' : 'pr-4'}
              ${error ? 'border-status-error/50 focus:border-status-error/70' : ''}
              ${className}
            `}
            aria-invalid={!!error}
            aria-describedby={error ? errorId : undefined}
            {...props}
          />
          {rightIcon && (
            <div className="absolute right-4 top-1/2 -translate-y-1/2 z-10">
              {rightIcon}
            </div>
          )}
        </div>
        {error && (
          <p id={errorId} className="mt-1.5 text-xs text-status-error font-mono" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';

export default Input;
