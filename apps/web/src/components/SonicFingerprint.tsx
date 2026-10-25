import type React from 'react';
import { useMemo } from 'react';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, ResponsiveContainer } from 'recharts';
import type { GenreProfileItem } from '../types';
import type { AudioReadings, ScoreListReading } from '../constants';
import { colors } from '../styles/theme';
import { MeasuredValue } from './measured/MeasuredValue';
import { MissingValue } from './measured/MissingValue';

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
const ScoreList: React.FC<{ reading: ScoreListReading }> = ({ reading }) => {
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
              compact
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
    </section>
  );
};

/** The audio models' style and tag scores, or why each is missing. */
const AudioScores: React.FC<{ fingerprint: NonNullable<AudioReadings['fingerprint']> }> = ({
  fingerprint,
}) => (
  <div className="flex flex-col gap-4">
    <ScoreList reading={fingerprint.styles} />
    <ScoreList reading={fingerprint.tags} />
  </div>
);

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

  // A result with a measurement shows its audio-model scores; the model-written genre profile
  // (results of older APIs) only when it has one.
  if (fingerprint && radarData.length === 0) return <AudioScores fingerprint={fingerprint} />;

  if (radarData.length === 0) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-2 border border-dashed border-white/10 rounded-md p-6 text-center">
        <p className="text-xs font-mono text-text-tertiary uppercase tracking-widest">
          No genre profile
        </p>
        <p className="text-[10px] font-mono text-text-tertiary">
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
      <div className="flex-1 min-h-[250px] relative">
        <div className="absolute inset-0 bg-cyber-dim blur-3xl rounded-full opacity-20 pointer-events-none"></div>
        {/* initialDimension avoids the width(-1)/height(-1) warning before the first measure */}
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 1, height: 1 }}>
          <RadarChart cx="50%" cy="50%" outerRadius="70%" data={radarData}>
            <PolarGrid stroke={colors.gray[700]} />
            <PolarAngleAxis
              dataKey="subject"
              tick={{ fill: colors.gray[400], fontSize: 12, fontFamily: 'IBM Plex Mono' }}
            />
            <Radar
              name="Genre affinity (model inference)"
              dataKey="A"
              stroke={colors.cyber}
              strokeWidth={2}
              fill={colors.cyber}
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
