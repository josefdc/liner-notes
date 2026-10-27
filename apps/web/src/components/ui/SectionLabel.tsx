import type React from 'react';

interface SectionLabelProps {
  children: React.ReactNode;
  subtitle?: string;
  indicator?: 'cyber' | 'analog' | 'success' | 'none';
  className?: string;
}

const indicatorStyles: Record<
  Exclude<SectionLabelProps['indicator'], undefined | 'none'>,
  string
> = {
  cyber: 'bg-cyber',
  analog: 'bg-analog',
  success: 'bg-status-success',
};

export const SectionLabel: React.FC<SectionLabelProps> = ({
  children,
  subtitle,
  indicator = 'none',
  className = '',
}) => (
  <div className={`flex items-center gap-2 ${className}`}>
    <div className="flex-1 min-w-0">
      <h2 className="text-xs font-mono text-text-tertiary uppercase tracking-widest">{children}</h2>
      {subtitle && <p className="text-chrome text-text-tertiary font-mono mt-0.5">{subtitle}</p>}
    </div>
    {indicator !== 'none' && (
      <span
        className={`w-2 h-2 rounded-full ${indicatorStyles[indicator]} animate-pulse flex-shrink-0`}
        aria-hidden="true"
      />
    )}
  </div>
);

export default SectionLabel;
