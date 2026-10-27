import type React from 'react';
import { useMemo } from 'react';
import type { SongSegment, KeyMoment, TrackData } from '../types';
import { colors } from '../styles/theme';
import { InferenceLabel } from './EstimatedWarning';
import { ProvenanceChip } from './provenance/ProvenanceChip';
import { formatSeconds } from '../constants';
import type { MeasuredAudio } from './measured/audio';

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
  /**
   * What the audio service measured on the preview (`audio.beats`, `audio.energyContour`,
   * `audio.sections`), timed from the start of the preview window; null or undefined when it
   * was not measured. Drawn on the preview lane only when its measured length is known.
   */
  beats?: MeasuredAudio['beats'];
  energyContour?: MeasuredAudio['energyContour'];
  measuredSections?: MeasuredAudio['sections'];
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

type Shape = 'diamond' | 'up' | 'down' | 'circle' | 'square';

/**
 * Key moments are measured, so every one is drawn in the measured colour; their types differ by
 * shape (and say what they are in words). An unknown type is a diamond.
 */
const MOMENT_SHAPE: Record<KeyMoment['type'], Shape> = {
  energy_peak: 'up',
  energy_drop: 'down',
  onset: 'diamond',
  harmonic_change: 'circle',
  silence: 'square',
};

/** A marker's shape, 10 px, in its colour (currentColor). */
const SHAPE_PATH: Record<Shape, React.ReactNode> = {
  diamond: <path d="M5 0.5 9.5 5 5 9.5 0.5 5Z" />,
  up: <path d="M5 0.5 9.5 9.5H0.5Z" />,
  down: <path d="M0.5 0.5H9.5L5 9.5Z" />,
  circle: <circle cx="5" cy="5" r="4.5" />,
  square: (
    <rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="2" />
  ),
};

// The song's structure is never measured: the model's sections are drawn in the inferred colour,
// a template's (or one of unknown origin) in neutral greys. The colour a result sends with each
// section (chosen by the model) is not used: it would put the measured or sourced colours on an
// inference. Neighbouring sections alternate two tints and are drawn apart. Each section is
// focusable, so its boundary reaches 3:1 against the page (WCAG 1.4.11): a 1 px border in the
// solid inferred violet, or a light grey for a template, around the tint.
const SEGMENT_TINTS: Record<'inferred' | 'other', [string, string]> = {
  inferred: [
    'bg-prov-inferred/60 border border-prov-inferred',
    'bg-prov-inferred/35 border border-prov-inferred',
  ],
  other: ['bg-white/25 border border-white/55', 'bg-white/10 border border-white/55'],
};

/** The chip that says where the structure comes from: a model, a template, or nobody knows. */
const SegmentsChip: React.FC<{ source: TrackData['segmentsSource'] }> = ({ source }) =>
  source === 'inferred' ? (
    <InferenceLabel />
  ) : source === 'template' ? (
    <ProvenanceChip kind="missing">Template — not analyzed</ProvenanceChip>
  ) : (
    <ProvenanceChip kind="unconfirmed">Not measured</ProvenanceChip>
  );

const EMPTY_SEGMENTS: SongSegment[] = [];
const EMPTY_SAMPLES: { time: number; description: string }[] = [];
const EMPTY_KEY_MOMENTS: KeyMoment[] = [];

const positiveSeconds = (value: number | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

interface Marker {
  time: number;
  description: string;
  color: string;
  shape: Shape;
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
        {/* The marker's shape (its type), in its colour (how it is known) */}
        <svg
          viewBox="0 0 10 10"
          width={10}
          height={10}
          aria-hidden="true"
          data-shape={marker.shape}
          fill="currentColor"
          className="group-hover:scale-125 group-focus-visible:scale-125 transition-transform"
          style={{ color: marker.color, opacity: marker.intensity ?? 1 }}
        >
          {SHAPE_PATH[marker.shape]}
        </svg>
        {/* Tooltip, in a text colour */}
        <div className="absolute top-4 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 w-32 text-center text-chrome font-mono text-text-secondary transition-opacity z-20 pointer-events-none">
          {marker.description}
        </div>
      </div>
    ))}
  </div>
);

// The measured layers of the preview: the beat grid, the energy contour and the neutral
// sections, all timed in seconds from the start of the decoded preview (the service decodes the
// clip from its first sample, so a time here is a time in the clip). They are drawn in the
// measured colour on the preview lane's own axis, each only when it was measured: a missing
// layer draws nothing. The model's song sections stay on the song timeline above, inferred.

/** Times of 4 decimals at most, so the SVG holds the measured times without float noise. */
const svgNumber = (value: number) => String(Math.round(value * 10_000) / 10_000);

/** The measured beats inside the window, as ticks over its length. */
const BeatTicks: React.FC<{ times: number[]; length: number; method: string }> = ({
  times,
  length,
  method,
}) => (
  <svg
    data-measured-layer="beats"
    role="img"
    aria-label={`Beat grid: ${plural(times.length, 'beat')} measured in the preview (${method})`}
    viewBox={`0 0 ${svgNumber(length)} 1`}
    preserveAspectRatio="none"
    className="block h-3 w-full"
    stroke={colors.prov.measured}
    strokeWidth={1}
  >
    {times.map((time) => (
      <line
        key={time}
        x1={svgNumber(time)}
        x2={svgNumber(time)}
        y1="0"
        y2="1"
        vectorEffect="non-scaling-stroke"
      />
    ))}
  </svg>
);

/**
 * The energy contour inside the window: one point per hop at the middle of its frame (the
 * frames do not overlap and start at 0), scaled to the loudest point drawn.
 */
const EnergyLine: React.FC<{ points: [number, number][]; length: number; hop: number }> = ({
  points,
  length,
  hop,
}) => {
  const line = points.map(([x, y]) => `${svgNumber(x)},${svgNumber(y)}`).join(' ');
  return (
    <svg
      data-measured-layer="energy"
      role="img"
      aria-label={`Energy (RMS) every ${formatSeconds(hop)} s, measured in the preview, relative to its loudest frame`}
      viewBox={`0 0 ${svgNumber(length)} 1`}
      preserveAspectRatio="none"
      className="block h-8 w-full overflow-visible"
    >
      <polygon
        points={`${svgNumber(points[0][0])},1 ${line} ${svgNumber(points[points.length - 1][0])},1`}
        fill={colors.prov.measured}
        fillOpacity={0.15}
        stroke="none"
      />
      <polyline
        points={line}
        fill="none"
        stroke={colors.prov.measured}
        strokeWidth={1.5}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};

type MeasuredSection = { label: string; start: number; end: number };

/**
 * The neutral sections inside the window, as bands of the measured colour, labelled, each placed
 * at its own start (a gap between sections stays a gap).
 */
const SectionBands: React.FC<{ sections: MeasuredSection[]; length: number }> = ({
  sections,
  length,
}) => (
  <div
    data-measured-layer="sections"
    role="list"
    aria-label="Sections measured in the preview"
    className="relative h-4 w-full"
  >
    {sections.map((section, index) => (
      <div
        // A section's span is unique; labels repeat (A, B, A).
        key={`${section.start}-${section.end}`}
        role="listitem"
        aria-label={`Section ${section.label}, ${formatTime(section.start)} to ${formatTime(section.end)} (measured)`}
        className={`absolute inset-y-0 overflow-hidden rounded-xs border border-prov-measured flex items-center px-1 text-chrome leading-none font-mono text-text-secondary ${index % 2 === 0 ? 'bg-prov-measured/25' : 'bg-prov-measured/10'}`}
        style={{
          left: `${svgNumber((section.start / length) * 100)}%`,
          width: `${svgNumber(((section.end - section.start) / length) * 100)}%`,
        }}
      >
        <span aria-hidden="true">{section.label}</span>
      </div>
    ))}
  </div>
);

/** The measured layers that can be drawn over a window of `length` seconds; empty ones drop. */
function measuredLayers(
  beats: MeasuredAudio['beats'] | undefined,
  energyContour: MeasuredAudio['energyContour'] | undefined,
  sections: MeasuredAudio['sections'] | undefined,
  length: number | null,
) {
  if (length === null) return { beats: null, energy: null, sections: null, beatsOutside: 0 };
  const inWindow = (time: number) => Number.isFinite(time) && time >= 0 && time <= length;
  const beatTimes = beats ? [...new Set(beats.times.filter(inWindow))].sort((a, b) => a - b) : [];
  const hop = energyContour?.hopSeconds ?? 0;
  const frames = (energyContour?.values ?? [])
    .map((value, i) => [(i + 0.5) * hop, value] as [number, number])
    .filter(([time, value]) => inWindow(time) && Number.isFinite(value) && value >= 0);
  const loudest = frames.reduce((max, [, value]) => Math.max(max, value), 0);
  const bands = (sections?.segments ?? [])
    .map((s) => ({ label: s.label, start: s.start, end: Math.min(s.end, length) }))
    .filter((s) => Number.isFinite(s.start) && s.start >= 0 && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  return {
    beats: beats && beatTimes.length > 0 ? { times: beatTimes, method: beats.method } : null,
    energy:
      energyContour && frames.length > 0
        ? {
            hop,
            points: frames.map(
              ([time, value]) => [time, loudest > 0 ? 1 - value / loudest : 1] as [number, number],
            ),
          }
        : null,
    sections: bands.length > 0 ? bands : null,
    beatsOutside: beats ? beats.times.length - beats.times.filter(inWindow).length : 0,
  };
}

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
  beats,
  energyContour,
  measuredSections,
}) => {
  const duration = positiveSeconds(durationSeconds);
  const measuredPreview = positiveSeconds(previewSeconds);
  // Drawn only over the window they were measured in, so only when its length is known.
  const layers = useMemo(
    () => measuredLayers(beats, energyContour, measuredSections, measuredPreview),
    [beats, energyContour, measuredSections, measuredPreview],
  );
  const hasLayers = layers.beats !== null || layers.energy !== null || layers.sections !== null;
  const layerNames = [
    layers.sections &&
      `sections ${[...new Set(layers.sections.map((section) => section.label))].join(', ')} (by harmony, not verse or chorus)`,
    layers.energy && 'energy (RMS)',
    layers.beats && plural(layers.beats.times.length, 'beat'),
  ].filter(Boolean) as string[];

  // Sample times are written by the model: drawn on the song timeline, labelled as inferred,
  // and only when they fall inside the song.
  const sampleMarkers = useMemo(
    () =>
      placeable(
        (samples ?? []).map((s) => ({
          time: s.time,
          description: `Sample: ${s.description} (time inferred by the model)`,
          color: colors.prov.inferred,
          shape: 'diamond' as const,
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
        color: colors.prov.measured,
        shape: MOMENT_SHAPE[k.type] ?? 'diamond',
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
        <span className="text-chrome font-mono text-text-tertiary uppercase tracking-widest">
          Structure
        </span>
        {segments.length > 0 && <SegmentsChip source={segmentsSource} />}
      </div>

      {/* Time labels: the end label only when the duration is known */}
      <div className="flex justify-between mb-2 text-xs font-mono text-text-tertiary uppercase tracking-widest">
        <span>0:00</span>
        <span>{duration !== null ? formatTime(duration) : 'Duration unknown'}</span>
      </div>

      {/* Structure Bar */}
      {segments.length > 0 ? (
        <div className="h-3 w-full flex gap-px rounded-xs overflow-hidden relative" role="list">
          {segments.map((seg, index) => (
            <div
              // Labels repeat (two choruses); a segment's span is unique.
              key={`${seg.start}-${seg.end}-${seg.label}`}
              role="listitem"
              aria-label={`${seg.label}, ${Math.round(seg.end - seg.start)}% of track`}
              tabIndex={0}
              data-segment-tint={segmentsSource === 'inferred' ? 'inferred' : 'neutral'}
              className={`h-full relative group transition-all duration-(--duration-normal) hover:brightness-125 focus-visible:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white ${SEGMENT_TINTS[segmentsSource === 'inferred' ? 'inferred' : 'other'][index % 2]}`}
              style={{ width: `${Math.max(seg.end - seg.start, 0)}%` }}
            >
              {/* Tooltip */}
              <div className="absolute -top-8 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 bg-void border border-white/20 px-2 py-1 text-chrome font-mono whitespace-nowrap z-10 transition-opacity">
                {seg.label}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="h-3 w-full rounded-xs bg-white/5 flex items-center justify-center">
          <span className="text-chrome leading-none font-mono text-text-tertiary uppercase tracking-widest">
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

      {/* The preview lane: what was measured on the preview, scaled to it. Its times say
          nothing about where the preview falls in the song. */}
      {momentMarkers.inside.length > 0 || hasLayers ? (
        <div className="mt-6" role="group" aria-label={previewLabel}>
          <div className="flex justify-between gap-3 text-chrome font-mono text-text-chip uppercase tracking-widest">
            <span>
              {previewLabel}
              {momentMarkers.inside.length > 0 && ' — key moments measured'}
              {measuredPreview !== null && ', position in the song unknown'}
            </span>
            <span className="shrink-0 whitespace-nowrap">
              {measuredPreview !== null
                ? `${formatSeconds(measuredPreview)} s`
                : formatTime(previewLength)}
            </span>
          </div>
          {hasLayers ? (
            <div className="mt-2 flex flex-col gap-1">
              {layers.sections && (
                <SectionBands sections={layers.sections} length={previewLength} />
              )}
              {layers.energy && (
                <EnergyLine
                  points={layers.energy.points}
                  length={previewLength}
                  hop={layers.energy.hop}
                />
              )}
              {layers.beats && (
                <BeatTicks
                  times={layers.beats.times}
                  length={previewLength}
                  method={layers.beats.method}
                />
              )}
            </div>
          ) : (
            <div className="h-1 w-full mt-2 rounded-full bg-white/10" />
          )}
          {momentMarkers.inside.length > 0 && (
            <MarkerLane markers={momentMarkers.inside} length={previewLength} />
          )}
          {hasLayers && (
            <div
              data-measured-layer="legend"
              className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-chrome font-mono text-text-chip"
            >
              <ProvenanceChip kind="measured" />
              <span>{layerNames.join(' · ')}</span>
            </div>
          )}
        </div>
      ) : null}
      {momentMarkers.inside.length === 0 && (
        <Note>
          {audioAnalyzed === false
            ? `No key moments — ${noMomentsReason ?? 'the audio was not analyzed'}`
            : audioAnalyzed
              ? 'No key moments detected'
              : 'No key moments'}
        </Note>
      )}
      {layers.beatsOutside > 0 && (
        <Note>{`${plural(layers.beatsOutside, 'beat')} outside the preview, not drawn`}</Note>
      )}
      {momentMarkers.outside > 0 && (
        <Note>{`${plural(momentMarkers.outside, 'key moment')} outside the preview, not drawn`}</Note>
      )}
    </div>
  );
};

export default SmartTimeline;
