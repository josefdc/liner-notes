import type React from 'react';
import { Crosshair } from 'lucide-react';

interface TargetScanOverlayProps {
  isHovered: boolean;
  index?: number;
}

const TargetScanOverlay: React.FC<TargetScanOverlayProps> = ({ isHovered }) => {
  if (!isHovered) return null;

  return (
    <div className="absolute inset-0 z-10 pointer-events-none overflow-hidden">
      {/* Scanning line - vertical */}
      <div
        className="absolute w-full h-[2px] bg-gradient-to-r from-transparent via-cyber to-transparent opacity-70"
        style={{
          animation: 'scan-vertical 1.5s ease-in-out infinite',
        }}
      />

      {/* Scanning line - horizontal */}
      <div
        className="absolute h-full w-[2px] bg-gradient-to-b from-transparent via-cyber/50 to-transparent opacity-50"
        style={{
          animation: 'scan-horizontal 2s ease-in-out infinite',
        }}
      />

      {/* Corner brackets - top left */}
      <div className="absolute top-2 left-2 w-4 h-4 border-l-2 border-t-2 border-cyber" />

      {/* Corner brackets - top right */}
      <div className="absolute top-2 right-2 w-4 h-4 border-r-2 border-t-2 border-cyber" />

      {/* Corner brackets - bottom left */}
      <div className="absolute bottom-2 left-2 w-4 h-4 border-l-2 border-b-2 border-cyber" />

      {/* Corner brackets - bottom right */}
      <div className="absolute bottom-2 right-2 w-4 h-4 border-r-2 border-b-2 border-cyber" />

      {/* Center crosshair */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
        <Crosshair className="text-cyber w-8 h-8 animate-pulse" />
      </div>

      {/* Target label */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1 bg-black/80 border border-cyber/30 rounded-[--radius-sm] font-mono text-[10px] text-cyber/80 uppercase tracking-widest">
        CLICK TO ANALYZE
      </div>

      {/* Glow overlay */}
      <div className="absolute inset-0 bg-cyber/5" />
    </div>
  );
};

export default TargetScanOverlay;
