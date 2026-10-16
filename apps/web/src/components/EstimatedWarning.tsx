import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Badge } from './ui/Badge';

interface EstimatedWarningProps {
  show: boolean;
  className?: string;
}

/**
 * [ESTIMATED] warning tag for low-confidence audio features
 * Displays when audio analysis falls back to genre-based estimation
 * Uses the analog color (#FFB000) from Cyber-Noir design system
 */
const EstimatedWarning: React.FC<EstimatedWarningProps> = ({ show, className = '' }) => {
  if (!show) return null;

  return (
    <Badge variant="analog" icon={<AlertTriangle size={10} />} className={className}>
      ESTIMATED
    </Badge>
  );
};

export default EstimatedWarning;
