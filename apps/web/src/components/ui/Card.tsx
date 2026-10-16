import React, { forwardRef } from 'react';

type CardVariant = 'default' | 'interactive' | 'elevated';
type GlowColor = 'cyber' | 'analog' | 'purple' | 'none';

interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: CardVariant;
  glowColor?: GlowColor;
  as?: 'div' | 'article' | 'section';
}

const variantStyles: Record<CardVariant, string> = {
  default: 'p-6',
  interactive: 'p-4 cursor-pointer hover:border-cyber/50 hover:bg-surface-hover hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.995] focus-visible:ring-2 focus-visible:ring-cyber/30 focus-visible:ring-offset-2 focus-visible:ring-offset-void transition-shadow duration-[--duration-focus]',
  elevated: 'p-6 shadow-elevated',
};

const glowStyles: Record<GlowColor, string> = {
  cyber: 'hover:shadow-glow-cyber',
  analog: 'hover:shadow-glow-analog',
  purple: 'hover:shadow-glow-purple',
  none: '',
};

const baseStyles = 'bg-surface border border-border rounded-[--radius-md] relative overflow-hidden transition-all duration-[--duration-normal] ease-[--ease-out-expo]';

export const Card = forwardRef<HTMLDivElement, CardProps>(
  (
    {
      children,
      variant = 'default',
      glowColor = 'none',
      className = '',
      as: Component = 'div',
      onClick,
      ...props
    },
    ref
  ) => {
    const isInteractive = variant === 'interactive' || !!onClick;

    return (
      <Component
        ref={ref}
        className={`${baseStyles} ${variantStyles[variant]} ${glowStyles[glowColor]} ${className}`}
        onClick={onClick}
        role={isInteractive ? 'button' : undefined}
        tabIndex={isInteractive ? 0 : undefined}
        onKeyDown={
          isInteractive
            ? (e: React.KeyboardEvent) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onClick?.(e as unknown as React.MouseEvent<HTMLDivElement>);
                }
              }
            : undefined
        }
        {...props}
      >
        {children}
      </Component>
    );
  }
);

Card.displayName = 'Card';

interface CardHeaderProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const CardHeader = forwardRef<HTMLDivElement, CardHeaderProps>(
  ({ children, className = '', ...props }, ref) => (
    <div
      ref={ref}
      className={`flex justify-between items-center mb-4 ${className}`}
      {...props}
    >
      {children}
    </div>
  )
);

CardHeader.displayName = 'CardHeader';

interface CardTitleProps extends React.HTMLAttributes<HTMLHeadingElement> {
  children: React.ReactNode;
  as?: 'h2' | 'h3' | 'h4';
}

export const CardTitle = forwardRef<HTMLHeadingElement, CardTitleProps>(
  ({ children, className = '', as: Component = 'h3', ...props }, ref) => (
    <Component
      ref={ref}
      className={`text-sm font-mono text-text-secondary uppercase tracking-wider ${className}`}
      {...props}
    >
      {children}
    </Component>
  )
);

CardTitle.displayName = 'CardTitle';

interface CardContentProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const CardContent = forwardRef<HTMLDivElement, CardContentProps>(
  ({ children, className = '', ...props }, ref) => (
    <div ref={ref} className={className} {...props}>
      {children}
    </div>
  )
);

CardContent.displayName = 'CardContent';

export default Card;
