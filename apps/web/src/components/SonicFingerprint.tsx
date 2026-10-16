import type React from 'react';
import { useMemo } from 'react';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, ResponsiveContainer } from 'recharts';
import type { GenreProfileItem } from '../types';
import { colors } from '../styles/theme';

interface SonicFingerprintProps {
  genreProfile?: GenreProfileItem[];
  /** True when the model was unavailable, which is why there is no genre profile. */
  modelUnavailable?: boolean;
}

// The genre profile is written by the model. Without one there is nothing to draw: no
// placeholder shape is shown in its place.
function toRadarData(profile: GenreProfileItem[] | undefined) {
  return (Array.isArray(profile) ? profile : [])
    .filter((item) => item.genre && Number.isFinite(item.value))
    .map((item) => ({ subject: item.genre, A: item.value, fullMark: 100 }));
}

const SonicFingerprint: React.FC<SonicFingerprintProps> = ({ genreProfile, modelUnavailable }) => {
  const radarData = useMemo(() => toRadarData(genreProfile), [genreProfile]);

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
      </div>
    );
  }

  return (
    <div className="w-full h-full relative">
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
  );
};

export default SonicFingerprint;
