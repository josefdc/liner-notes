import type React from 'react';
import { useMemo } from 'react';
import type { SongSegment, KeyMoment, TrackData } from '../types';
import { keyMomentColors, colors } from '../styles/theme';
import { InferenceLabel } from './EstimatedWarning';

interface SmartTimelineProps {
  segments: SongSegment[];
  /** Where the segments come from; neither source is a measurement of the audio. */
  segmentsSource?: TrackData['segmentsSource'];
  /** Song duration in seconds; undefined when it is not known. */
  durationSeconds?: number;
  samples?: { time: number; description: string }[];
  keyMoments?: KeyMoment[];
  /** False when the audio was not analysed (which is why there are no key moments). */
  audioAnalyzed?: boolean;
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

const SEGMENT_SOURCE_LABEL: Record<NonNullable<TrackData['segmentsSource']>, string> = {
  template: 'Template — not analysed',
  inferred: 'Model inference',
};

const EMPTY_SAMPLES: { time: number; description: string }[] = [];
const EMPTY_KEY_MOMENTS: KeyMoment[] = [];

const SmartTimeline: React.FC<SmartTimelineProps> = ({
  segments,
  segmentsSource,
  durationSeconds,
  samples = EMPTY_SAMPLES,
  keyMoments = EMPTY_KEY_MOMENTS,
  audioAnalyzed,
}) => {
  const duration =
    typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : null;

  const markers = useMemo(
    () =>
      [
        ...samples.map((s) => ({
          time: s.time,
          description: `Sample: ${s.description} (position from the model)`,
          color: colors.analog,
          intensity: 1,
        })),
        ...keyMoments.map((k) => ({
          time: k.time,
          description: `${k.description} (detected in the audio preview at ${formatTime(k.time)})`,
          color: getMarkerColor(k.type),
          intensity: k.intensity,
        })),
      ]
        .filter((m) => Number.isFinite(m.time) && m.time >= 0)
        .sort((a, b) => a.time - b.time),
    [samples, keyMoments],
  );

  let markerNote: string | null = null;
  if (markers.length === 0) {
    markerNote =
      audioAnalyzed === false
        ? 'No key moments — the audio was not analysed'
        : 'No key moments detected';
  } else if (duration === null) {
    markerNote = `Duration unknown: ${markers.length} marker${markers.length === 1 ? '' : 's'} cannot be placed`;
  }

  return (
    <div className="w-full mt-8" role="group" aria-label="Song structure">
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[10px] font-mono text-text-tertiary uppercase tracking-widest">
          Structure
        </span>
        {segments.length > 0 && (
          <InferenceLabel>
            {segmentsSource ? SEGMENT_SOURCE_LABEL[segmentsSource] : 'Not measured'}
          </InferenceLabel>
        )}
      </div>

      {/* Time labels: the end label only when the duration is known */}
      <div className="flex justify-between mb-2 text-xs font-mono text-text-tertiary uppercase tracking-widest">
        <span>0:00</span>
        <span>{duration !== null ? formatTime(duration) : 'Duration unknown'}</span>
      </div>

      {/* Structure Bar */}
      {segments.length > 0 ? (
        <div className="h-3 w-full flex rounded-[--radius-xs] overflow-hidden relative" role="list">
          {segments.map((seg) => (
            <div
              // Labels repeat (two choruses); a segment's span is unique.
              key={`${seg.start}-${seg.end}-${seg.label}`}
              role="listitem"
              aria-label={`${seg.label}, ${Math.round(seg.end - seg.start)}% of track`}
              tabIndex={0}
              className="h-full relative group transition-all duration-[--duration-normal] hover:brightness-125 focus-visible:brightness-125 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50"
              style={{
                width: `${Math.max(seg.end - seg.start, 0)}%`,
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

      {/* Sample and key-moment markers, placed only when the duration is known */}
      {duration !== null && markers.length > 0 && (
        <div className="relative h-6 w-full mt-1">
          {markers.map((marker, index) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: markers can share a time and type
              key={index}
              className="absolute top-0 -translate-x-1/2 cursor-pointer group"
              style={{
                left: `${Math.min(Math.max((marker.time / duration) * 100, 2), 98)}%`,
              }}
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
          ))}
        </div>
      )}
      {markerNote && (
        <p className="mt-2 text-[10px] font-mono text-text-tertiary uppercase tracking-widest">
          {markerNote}
        </p>
      )}
    </div>
  );
};

export default SmartTimeline;
