import type React from 'react';
import { Crosshair } from 'lucide-react';

interface TargetScanOverlayProps {
  isHovered: boolean;
}

const TargetScanOverlay: React.FC<TargetScanOverlayProps> = ({ isHovered }) => {
  if (!isHovered) return null;

  return (
    // Inside the card's button: spans only (phrasing content), every one positioned, so laid out
    // as blocks. Decorative, its label too: hidden from screen readers, it does not join the
    // button's name while the pointer is on the card.
    <span aria-hidden="true" className="absolute inset-0 z-10 pointer-events-none overflow-hidden">
      {/* Scanning line - vertical */}
      <span className="absolute w-full h-[2px] bg-gradient-to-r from-transparent via-cyber to-transparent opacity-70 animate-scan-vertical" />

      {/* Scanning line - horizontal */}
      <span className="absolute h-full w-[2px] bg-gradient-to-b from-transparent via-cyber/50 to-transparent opacity-50 animate-scan-horizontal" />

      {/* Corner brackets - top left */}
      <span className="absolute top-2 left-2 w-4 h-4 border-l-2 border-t-2 border-cyber" />

      {/* Corner brackets - top right */}
      <span className="absolute top-2 right-2 w-4 h-4 border-r-2 border-t-2 border-cyber" />

      {/* Corner brackets - bottom left */}
      <span className="absolute bottom-2 left-2 w-4 h-4 border-l-2 border-b-2 border-cyber" />

      {/* Corner brackets - bottom right */}
      <span className="absolute bottom-2 right-2 w-4 h-4 border-r-2 border-b-2 border-cyber" />

      {/* Center crosshair */}
      <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        <Crosshair className="text-cyber w-8 h-8 animate-pulse" />
      </span>

      {/* Target label */}
      <span className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1 bg-black/80 border border-white/20 rounded-sm font-mono text-chrome text-text-secondary uppercase tracking-widest whitespace-nowrap">
        Analyze this track
      </span>

      {/* Glow overlay */}
      <span className="absolute inset-0 bg-cyber/5" />
    </span>
  );
};

export default TargetScanOverlay;
