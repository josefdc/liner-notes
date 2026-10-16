import React, { useMemo } from 'react';
import { SongSegment, KeyMoment } from '../types';
import { keyMomentColors, colors } from '../styles/theme';

interface SmartTimelineProps {
  segments: SongSegment[];
  duration: number; // total duration in seconds (or 100 for percentage mode)
  samples?: { time: number; description: string }[];
  keyMoments?: KeyMoment[];
}

/**
 * Format seconds to MM:SS
 */
const formatTime = (seconds: number): string => {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

/**
 * Get marker color based on key moment type
 * Uses centralized Cyber-Noir design system colors
 */
const getMarkerColor = (type: KeyMoment['type']): string => {
  return keyMomentColors[type] || colors.analog;
};

const EMPTY_SAMPLES: { time: number; description: string }[] = [];
const EMPTY_KEY_MOMENTS: KeyMoment[] = [];

const SmartTimeline: React.FC<SmartTimelineProps> = ({
  segments,
  duration = 225, // Default 3:45 in seconds
  samples = EMPTY_SAMPLES,
  keyMoments = EMPTY_KEY_MOMENTS,
}) => {
  const { allMarkers, isPercentageMode, actualDuration } = useMemo(() => {
    const isPct = duration === 100;
    const actDur = isPct ? 225 : duration;
    const timeToPercent = (t: number) => (isPct ? t : (t / actDur) * 100);

    const markers = [
      ...samples.map((s) => ({
        position: timeToPercent(s.time),
        description: `Sample: ${s.description}`,
        color: colors.analog,
        type: 'sample' as const,
        intensity: 1,
      })),
      ...keyMoments.map((k) => ({
        position: timeToPercent(k.time),
        description: k.description,
        color: getMarkerColor(k.type),
        type: k.type,
        intensity: k.intensity,
      })),
    ].sort((a, b) => a.position - b.position);

    return { allMarkers: markers, isPercentageMode: isPct, actualDuration: actDur };
  }, [samples, keyMoments, duration]);

  return (
    <div className="w-full mt-8" aria-roledescription="timeline" aria-label="Song structure">
      {/* Dynamic time labels */}
      <div className="flex justify-between mb-2 text-xs font-mono text-text-tertiary uppercase tracking-widest">
        <span>0:00</span>
        <span>{formatTime(actualDuration)}</span>
      </div>

      {/* Structure Bar */}
      {segments.length > 0 ? (
        <div className="h-3 w-full flex rounded-[--radius-xs] overflow-hidden relative" role="list">
          {segments.map((seg) => (
            <div
              key={seg.label}
              role="listitem"
              aria-label={`${seg.label}, ${Math.round(seg.end - seg.start)}% of track`}
              tabIndex={0}
              className="h-full relative group transition-all duration-[--duration-normal] hover:brightness-125 focus-visible:brightness-125 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50"
              style={{
                width: `${seg.end - seg.start}%`,
                backgroundColor: seg.color,
              }}
            >
              {/* Tooltip */}
              <div className="absolute -top-8 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 bg-void border border-white/20 px-2 py-1 text-[10px] font-mono whitespace-nowrap z-10 transition-opacity">
                {seg.label}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="h-3 w-full rounded-[--radius-xs] bg-white/5 flex items-center justify-center">
          <span className="text-[8px] font-mono text-text-tertiary uppercase tracking-widest">
            STRUCTURE DATA UNAVAILABLE
          </span>
        </div>
      )}

      {/* Dynamic Sample/KeyMoment Markers */}
      <div className="relative h-6 w-full mt-1">
        {allMarkers.length > 0 ? (
          allMarkers.map((marker) => (
            <div
              key={`${marker.type}-${marker.position}`}
              className="absolute top-0 -translate-x-1/2 cursor-pointer group"
              style={{ left: `${Math.min(Math.max(marker.position, 2), 98)}%` }}
              tabIndex={0}
              role="img"
              aria-label={marker.description}
            >
              {/* Marker diamond with dynamic color */}
              <div
                className="w-2 h-2 rotate-45 border border-black group-hover:scale-125 group-focus-visible:scale-125 transition-transform"
                style={{
                  backgroundColor: marker.color,
                  opacity: marker.intensity || 1,
                }}
              />
              {/* Tooltip */}
              <div
                className="absolute top-4 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 w-32 text-center text-[10px] font-mono transition-opacity z-20 pointer-events-none"
                style={{ color: marker.color }}
              >
                {marker.description}
              </div>
            </div>
          ))
        ) : (
          /* Fallback placeholder marker when no moments detected */
          <div className="absolute top-0 -translate-x-1/2" style={{ left: '75%' }}>
            <div className="w-2 h-2 rotate-45 bg-analog border border-black opacity-30"></div>
          </div>
        )}
      </div>
    </div>
  );
};

export default SmartTimeline;
