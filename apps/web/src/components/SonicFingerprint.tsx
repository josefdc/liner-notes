import type React from 'react';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, ResponsiveContainer } from 'recharts';
import type { GenreProfileItem } from '../types';
import type { AudioReadings, ScoreListReading } from '../constants';
import { colors } from '../styles/theme';
import { MeasuredValue } from './measured/MeasuredValue';
import { MissingValue } from './measured/MissingValue';
import { STYLE_EVAL, styleEvalText } from './measured/styleEval';

interface SonicFingerprintProps {
  genreProfile?: GenreProfileItem[];
  /** True when the model was unavailable, which is why there is no genre profile. */
  modelUnavailable?: boolean;
  /**
   * The style and tag scores of the audio models (`audio.fingerprint`), or why they are
   * missing; null or undefined for a result without an `audio` block.
   */
  fingerprint?: AudioReadings['fingerprint'];
}

// How many scores of each list are shown, highest first.
const TOP_SCORES = 5;

/** A Discogs style is "Genre---Style"; shown as "Genre / Style". */
const scoreLabel = (label: string) => label.replaceAll('---', ' / ');

/**
 * One ranked list of audio-model activations: scores, not probabilities, so they are listed
 * with their value and never drawn as shares of a whole. Labelled as a model estimate.
 */
const ScoreList: React.FC<{ reading: ScoreListReading; note?: string }> = ({ reading, note }) => {
  if (reading.state === 'missing') {
    return <MissingValue label={reading.label} status="not available" reason={reading.reason} />;
  }
  // Labels may repeat: each item is keyed by its label and how many times it came before.
  const seen = new Map<string, number>();
  const items = reading.items.slice(0, TOP_SCORES).map((item) => {
    const n = seen.get(item.label) ?? 0;
    seen.set(item.label, n + 1);
    return { ...item, key: `${item.label}#${n}` };
  });
  return (
    <section aria-label={`${reading.label} (model estimate)`} className="flex flex-col gap-1.5">
      <p className="text-chrome font-mono text-text-chip uppercase tracking-widest">
        {reading.label} · top {items.length}
      </p>
      <p className="text-chrome font-mono text-text-chip">
        Model estimate · scores, not probabilities · {reading.basis}
      </p>
      <p className="text-chrome font-mono text-text-chip">{reading.detail}</p>
      <ul className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <li key={item.key}>
            <MeasuredValue
              layout="bare"
              kind="estimate"
              label={scoreLabel(item.label)}
              value={item.score.toFixed(2)}
              confidence="score, not a probability"
              basis={reading.basis}
              title={reading.title}
            />
          </li>
        ))}
      </ul>
      {note && <p className="text-chrome font-mono text-text-chip">{note}</p>}
    </section>
  );
};

/** How often the style model agrees with Discogs, when the styles shown are that model's. */
const styleNote = (styles: ScoreListReading) =>
  styles.state === 'shown' && styles.model === STYLE_EVAL.model
    ? styleEvalText(STYLE_EVAL)
    : undefined;

/** The audio models' style and tag scores, or why each is missing. */
const AudioScores: React.FC<{ fingerprint: NonNullable<AudioReadings['fingerprint']> }> = ({
  fingerprint,
}) => (
  <div className="flex flex-col gap-4">
    <ScoreList reading={fingerprint.styles} note={styleNote(fingerprint.styles)} />
    <ScoreList reading={fingerprint.tags} />
  </div>
);

/** The radar's axis labels: their size (px), and the width of one IBM Plex Mono character. */
const LABEL_SIZE = 12;
const LABEL_CHAR = LABEL_SIZE * 0.6;
const LABEL_FONT = 'IBM Plex Mono';
/** From the outer ring to a label: Recharts' tick size (8 px), and a little room. */
const LABEL_GAP = 12;
/**
 * The smallest radius the radar is drawn at (px), unless the chart is smaller still: its rings
 * stay 9 px apart. In the narrowest card (243 px wide, at 1024 px) that leaves 73 px beside it,
 * ten characters: the longest single word of the usual genres ("Electronic") still fits.
 */
export const RADAR_FLOOR = 36;
/** At most this many lines per label; a longer one ends in "…". */
const LABEL_LINES = 3;

type Size = { width: number; height: number };

/**
 * A label in lines of at most `maxChars` characters, broken at spaces: a word longer than a
 * line is cut and ends in "…", and so does a label longer than LABEL_LINES lines.
 */
export function wrapLabel(label: string, maxChars: number): string[] {
  const width = Math.max(2, maxChars);
  const cut = (text: string) => (text.length > width ? `${text.slice(0, width - 1)}…` : text);
  const lines: string[] = [];
  for (const word of label.split(/\s+/).filter(Boolean).map(cut)) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last].length + 1 + word.length <= width) lines[last] += ` ${word}`;
    else lines.push(word);
  }
  if (lines.length <= LABEL_LINES) return lines;
  const kept = lines.slice(0, LABEL_LINES);
  const end = kept[LABEL_LINES - 1];
  kept[LABEL_LINES - 1] = `${end.length < width ? end : end.slice(0, width - 1)}…`;
  return kept;
}

/**
 * How the radar fits a chart of `size` with these axis labels. Its radius is Recharts' own (70%
 * of half the shorter side, less its 5 px margins) where the longest label fits on one line
 * beside the outer ring, else as large as lets it fit, down to RADAR_FLOOR. Below that the
 * radius stays at the floor and the labels are wrapped (or cut, ending in "…") to the
 * characters that fit beside it (`maxChars`; null when every label fits whole on one line).
 * Before the chart is measured, Recharts' 70%.
 */
export function radarLayout(
  size: Size | null,
  labels: readonly string[],
): { radius: number | string; maxChars: number | null } {
  if (!size) return { radius: '70%', maxChars: null };
  const half = size.width / 2;
  const usual = Math.max(0, 0.35 * Math.min(size.width - 10, size.height - 10));
  const fitFor = (chars: number) => half - LABEL_GAP - chars * LABEL_CHAR;
  const charsBeside = (radius: number) => Math.floor((half - LABEL_GAP - radius) / LABEL_CHAR);
  const floor = Math.min(usual, RADAR_FLOOR);
  const longest = Math.max(0, ...labels.map((label) => label.length));
  if (fitFor(longest) >= floor) return { radius: Math.min(usual, fitFor(longest)), maxChars: null };
  // Wrapped to what fits beside the floor, the longest line may leave room for a larger radar.
  const lines = labels.flatMap((label) => wrapLabel(label, charsBeside(floor)));
  const radius = Math.max(floor, Math.min(usual, fitFor(Math.max(...lines.map((l) => l.length)))));
  return { radius, maxChars: charsBeside(radius) };
}

/** What Recharts passes a custom axis tick (the parts used here). */
type TickProps = {
  x: number | string;
  y: number | string;
  textAnchor?: string;
  verticalAnchor?: string;
  payload: { value?: unknown };
};

/**
 * An axis label wrapped to `maxChars` characters a line, its lines set as Recharts sets one
 * (the first line's top, the middle, or the last line's baseline at the tick, by its vertical
 * anchor). Screen readers and the tooltip get the whole genre name, whatever the lines show.
 */
const WrappedLabel: React.FC<TickProps & { maxChars: number }> = ({
  x,
  y,
  textAnchor,
  verticalAnchor,
  payload,
  maxChars,
}) => {
  const full = String(payload.value ?? '');
  // Each line keyed by where it starts in the label.
  const lines = wrapLabel(full, maxChars).reduce<Array<{ text: string; at: number }>>(
    (all, text) => {
      const previous = all[all.length - 1];
      all.push({ text, at: previous ? previous.at + previous.text.length + 1 : 0 });
      return all;
    },
    [],
  );
  const first =
    verticalAnchor === 'start'
      ? 0.71
      : verticalAnchor === 'middle'
        ? -(lines.length - 1) / 2 + 0.355
        : -(lines.length - 1);
  return (
    <g>
      <title>{full}</title>
      {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: an SVG group takes no focus; the label's whole name is the title above, so its cut lines are not read as well */}
      <g aria-hidden="true">
        <text
          x={x}
          y={y}
          textAnchor={textAnchor === 'start' || textAnchor === 'end' ? textAnchor : 'middle'}
          fill={colors.gray[400]}
          fontSize={LABEL_SIZE}
          fontFamily={LABEL_FONT}
          className="recharts-text recharts-polar-angle-axis-tick-value"
        >
          {lines.map((line, index) => (
            <tspan key={line.at} x={x} dy={`${index === 0 ? first : 1}em`}>
              {line.text}
            </tspan>
          ))}
        </text>
      </g>
    </g>
  );
};

// The genre profile is written by the model. Without one there is nothing to draw: no
// placeholder shape is shown in its place.
function toRadarData(profile: GenreProfileItem[] | undefined) {
  return (Array.isArray(profile) ? profile : [])
    .filter((item) => item.genre && Number.isFinite(item.value))
    .map((item) => ({ subject: item.genre, A: item.value, fullMark: 100 }));
}

const SonicFingerprint: React.FC<SonicFingerprintProps> = ({
  genreProfile,
  modelUnavailable,
  fingerprint,
}) => {
  const radarData = useMemo(() => toRadarData(genreProfile), [genreProfile]);
  const [size, setSize] = useState<Size | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const hasRadar = radarData.length > 0;
  // The chart's size before its first paint: Recharts reports it only from its resize observer,
  // a frame or two later, and until then the radar would take its 70% and could cut its labels.
  useLayoutEffect(() => {
    if (!hasRadar || !chartRef.current) return;
    const box = chartRef.current.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) setSize({ width: box.width, height: box.height });
  }, [hasRadar]);
  const layout = radarLayout(
    size,
    radarData.map((item) => item.subject),
  );

  // A result with a measurement shows its audio-model scores; the model-written genre profile
  // (results of older APIs) only when it has one.
  if (fingerprint && radarData.length === 0) return <AudioScores fingerprint={fingerprint} />;

  if (radarData.length === 0) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-2 border border-dashed border-white/10 rounded-md p-6 text-center">
        <p className="text-xs font-mono text-text-tertiary uppercase tracking-widest">
          No genre profile
        </p>
        <p className="text-chrome font-mono text-text-tertiary">
          {modelUnavailable
            ? 'The model was unavailable, so no genre profile was written for this track.'
            : 'No genre profile was produced for this track.'}
        </p>
        {/* A result without a measurement has no style or tag scores either. */}
        <MissingValue label="Style and tag scores" status="not available" />
      </div>
    );
  }

  return (
    <div className="w-full h-full relative flex flex-col gap-4">
      {fingerprint && <AudioScores fingerprint={fingerprint} />}
      <div ref={chartRef} className="flex-1 min-h-[250px] relative">
        <div className="absolute inset-0 bg-prov-inferred/10 blur-3xl rounded-full opacity-20 pointer-events-none"></div>
        {/* initialDimension avoids the width(-1)/height(-1) warning before the first measure */}
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 1, height: 1 }}
          onResize={(width, height) => setSize({ width, height })}
        >
          <RadarChart cx="50%" cy="50%" outerRadius={layout.radius} data={radarData}>
            <PolarGrid stroke={colors.gray[700]} />
            <PolarAngleAxis
              dataKey="subject"
              tick={
                layout.maxChars === null
                  ? { fill: colors.gray[400], fontSize: LABEL_SIZE, fontFamily: LABEL_FONT }
                  : (props: TickProps) => (
                      <WrappedLabel {...props} maxChars={layout.maxChars as number} />
                    )
              }
            />
            <Radar
              name="Genre affinity (model inference)"
              dataKey="A"
              // Written by the model: the inferred violet, never the measured cyan
              stroke={colors.prov.inferred}
              strokeWidth={2}
              fill={colors.prov.inferred}
              fillOpacity={0.3}
              animationDuration={800}
              animationEasing="ease-out"
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default SonicFingerprint;
