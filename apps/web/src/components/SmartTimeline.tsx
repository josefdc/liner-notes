import type React from 'react';
import { useMemo } from 'react';
import type { SongSegment, KeyMoment, TrackData } from '../types';
import { keyMomentColors, colors } from '../styles/theme';
import { InferenceLabel } from './EstimatedWarning';
import { formatSeconds } from '../constants';

interface SmartTimelineProps {
  segments?: SongSegment[];
  /** Where the segments come from; neither source is a measurement of the audio. */
  segmentsSource?: TrackData['segmentsSource'];
  /** Song duration in seconds; undefined when it is not known. */
  durationSeconds?: number;
  samples?: { time: number; description: string }[];
  keyMoments?: KeyMoment[];
  /**
   * True when the audio was analysed (so no key moments means none were detected), false when
   * it was not analysed, undefined when the result does not say.
   */
  audioAnalyzed?: boolean;
  /**
   * Why there are no key moments when the audio was not measured (the gate's reason, "no audio
   * preview", ...); shown instead of a bare "not analysed".
   */
  noMomentsReason?: string | null;
  /**
   * Length of the analysed preview window in seconds, as measured (the result's
   * `audio.window.durationSeconds`); undefined when the result does not send it.
   */
  previewSeconds?: number;
}

// The preview lane. When the result carries its measurement, the lane spans the measured
// preview window (`audio.window.durationSeconds`), and moments past it are not drawn. Results
// without one do not say how long the clip was: Spotify and Deezer previews are about 30
// seconds long, and the audio service decodes at most the first 35 seconds of a clip, so the
// lane spans 30 s, stretched to the latest key moment when one falls between 30 and 35 s;
// moments past 35 s cannot come from the decoded clip and are not drawn. The label then says
// "about" because the length is not known. Where the window falls in the song is never known.
const PREVIEW_SECONDS = 30;
const DECODED_SECONDS = 35;
const PREVIEW_LABEL = 'Audio preview (about 30 s)';

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

const EMPTY_SEGMENTS: SongSegment[] = [];
const EMPTY_SAMPLES: { time: number; description: string }[] = [];
const EMPTY_KEY_MOMENTS: KeyMoment[] = [];

const positiveSeconds = (value: number | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

interface Marker {
  time: number;
  description: string;
  color: string;
  intensity: number;
}

/** Markers whose time falls inside [0, length]; the rest cannot be placed on this lane. */
function placeable(markers: Marker[], length: number | null) {
  const valid = markers.filter((m) => Number.isFinite(m.time) && m.time >= 0);
  const inside = length === null ? [] : valid.filter((m) => m.time <= length);
  return { inside: inside.sort((a, b) => a.time - b.time), outside: valid.length - inside.length };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** A lane of markers positioned by time over a known length. */
const MarkerLane: React.FC<{ markers: Marker[]; length: number }> = ({ markers, length }) => (
  <div className="relative h-6 w-full mt-1">
    {markers.map((marker, index) => (
      <div
        // biome-ignore lint/suspicious/noArrayIndexKey: markers can share a time and type
        key={index}
        className="absolute top-0 -translate-x-1/2 cursor-pointer group"
        style={{ left: `${Math.min(Math.max((marker.time / length) * 100, 2), 98)}%` }}
        tabIndex={0}
        role="img"
        aria-label={marker.description}
      >
        {/* Marker diamond with dynamic color */}
        <div
          className="w-2 h-2 rotate-45 border border-black group-hover:scale-125 group-focus-visible:scale-125 transition-transform"
          style={{ backgroundColor: marker.color, opacity: marker.intensity ?? 1 }}
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
);

const Note: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="mt-2 text-chrome font-mono text-text-chip uppercase tracking-widest">{children}</p>
);

const SmartTimeline: React.FC<SmartTimelineProps> = ({
  segments = EMPTY_SEGMENTS,
  segmentsSource,
  durationSeconds,
  samples = EMPTY_SAMPLES,
  keyMoments = EMPTY_KEY_MOMENTS,
  audioAnalyzed,
  noMomentsReason,
  previewSeconds,
}) => {
  const duration = positiveSeconds(durationSeconds);
  const measuredPreview = positiveSeconds(previewSeconds);

  // Sample times are written by the model: drawn on the song timeline, labelled as inferred,
  // and only when they fall inside the song.
  const sampleMarkers = useMemo(
    () =>
      placeable(
        (samples ?? []).map((s) => ({
          time: s.time,
          description: `Sample: ${s.description} (time inferred by the model)`,
          color: colors.analog,
          intensity: 1,
        })),
        duration,
      ),
    [samples, duration],
  );

  // Key moments are measured inside the audio preview, so they get their own lane scaled to
  // the preview: their times say nothing about where they fall in the full song.
  const { momentMarkers, previewLength } = useMemo(() => {
    const markers = placeable(
      (keyMoments ?? []).map((k) => ({
        time: k.time,
        description: `${k.description} (measured at ${formatTime(k.time)} in the preview)`,
        color: getMarkerColor(k.type),
        intensity: k.intensity,
      })),
      measuredPreview ?? DECODED_SECONDS,
    );
    if (measuredPreview !== null) {
      return { momentMarkers: markers, previewLength: measuredPreview };
    }
    const latest = markers.inside.reduce((max, m) => Math.max(max, m.time), 0);
    return { momentMarkers: markers, previewLength: Math.max(PREVIEW_SECONDS, latest) };
  }, [keyMoments, measuredPreview]);
  const previewLabel =
    measuredPreview !== null
      ? `Preview window (${formatSeconds(measuredPreview)} s, measured)`
      : PREVIEW_LABEL;

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
        <div className="h-3 w-full flex rounded-xs overflow-hidden relative" role="list">
          {segments.map((seg) => (
            <div
              // Labels repeat (two choruses); a segment's span is unique.
              key={`${seg.start}-${seg.end}-${seg.label}`}
              role="listitem"
              aria-label={`${seg.label}, ${Math.round(seg.end - seg.start)}% of track`}
              tabIndex={0}
              className="h-full relative group transition-all duration-(--duration-normal) hover:brightness-125 focus-visible:brightness-125 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/50"
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
        <div className="h-3 w-full rounded-xs bg-white/5 flex items-center justify-center">
          <span className="text-[8px] font-mono text-text-tertiary uppercase tracking-widest">
            STRUCTURE DATA UNAVAILABLE
          </span>
        </div>
      )}

      {/* Samples on the song timeline (times inferred by the model) */}
      {duration !== null && sampleMarkers.inside.length > 0 && (
        <MarkerLane markers={sampleMarkers.inside} length={duration} />
      )}
      {sampleMarkers.inside.length > 0 && <Note>Sample times: model inference</Note>}
      {sampleMarkers.outside > 0 && (
        <Note>
          {duration === null
            ? `Duration unknown: ${plural(sampleMarkers.outside, 'sample')} not placed`
            : `${plural(sampleMarkers.outside, 'sample time')} outside the song, not drawn`}
        </Note>
      )}

      {/* Key moments on their own lane, scaled to the preview they were measured in */}
      {momentMarkers.inside.length > 0 ? (
        <div className="mt-6" role="group" aria-label={previewLabel}>
          <div className="flex justify-between gap-3 text-chrome font-mono text-text-chip uppercase tracking-widest">
            <span>
              {previewLabel} — key moments measured
              {measuredPreview !== null && ', position in the song unknown'}
            </span>
            <span className="shrink-0 whitespace-nowrap">
              {measuredPreview !== null
                ? `${formatSeconds(measuredPreview)} s`
                : formatTime(previewLength)}
            </span>
          </div>
          <div className="h-1 w-full mt-2 rounded-full bg-white/10" />
          <MarkerLane markers={momentMarkers.inside} length={previewLength} />
        </div>
      ) : (
        <Note>
          {audioAnalyzed === false
            ? `No key moments — ${noMomentsReason ?? 'the audio was not analysed'}`
            : audioAnalyzed
              ? 'No key moments detected'
              : 'No key moments'}
        </Note>
      )}
      {momentMarkers.outside > 0 && (
        <Note>{`${plural(momentMarkers.outside, 'key moment')} outside the preview, not drawn`}</Note>
      )}
    </div>
  );
};

export default SmartTimeline;
