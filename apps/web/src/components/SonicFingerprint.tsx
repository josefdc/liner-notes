import type React from 'react';
import { useMemo } from 'react';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, ResponsiveContainer } from 'recharts';
import { RADAR_DATA } from '../constants';
import type { GenreProfileItem } from '../types';
import { colors } from '../styles/theme';

interface SonicFingerprintProps {
  genreProfile?: GenreProfileItem[];
}

function transformToRadarData(profile: GenreProfileItem[] | undefined) {
  if (!profile || profile.length === 0) {
    return RADAR_DATA;
  }
  return profile.map((item) => ({
    subject: item.genre,
    A: item.value,
    fullMark: 100,
  }));
}

const SonicFingerprint: React.FC<SonicFingerprintProps> = ({ genreProfile }) => {
  const radarData = useMemo(() => transformToRadarData(genreProfile), [genreProfile]);

  return (
    <div className="w-full h-full relative">
      <div className="absolute inset-0 bg-cyber-dim blur-3xl rounded-full opacity-20 pointer-events-none"></div>
      <ResponsiveContainer width="100%" height="100%">
        <RadarChart cx="50%" cy="50%" outerRadius="70%" data={radarData}>
          <PolarGrid stroke={colors.gray[700]} />
          <PolarAngleAxis
            dataKey="subject"
            tick={{ fill: colors.gray[400], fontSize: 12, fontFamily: 'IBM Plex Mono' }}
          />
          <Radar
            name="Genre Profile"
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
