import type React from 'react';
import { AlertTriangle, Disc, Heart, Sparkles, Zap } from 'lucide-react';
import { Badge } from './ui/Badge';
import type { TrackData } from '../types';
import {
  AUDIO_MODEL_FIELDS,
  MEASURED_AUDIO_FIELDS,
  audioUnavailableText,
  formatScore,
  measuredNumber,
  measuredText,
  missingAudioValues,
  missingModelOutput,
  moodLabel,
} from '../constants';

// Provenance display for the result screens: measured values, audio-model scores, model
// inference, and what is missing. A missing value is always shown as missing, never as 0.

/** Chip marking content written by the model (or a template) rather than measured. */
export const InferenceLabel: React.FC<{ children?: React.ReactNode; className?: string }> = ({
  children = 'Model inference',
  className = '',
}) => (
  <Badge
    variant="analog"
    icon={<Sparkles size={10} />}
    className={className}
    title="Not measured from the audio"
  >
    {children}
  </Badge>
);

/** Badge for a value that was not measured. */
export const NotMeasured: React.FC<{ label: string; size?: 'sm' | 'md' }> = ({
  label,
  size = 'sm',
}) => (
  <Badge variant="gray" size={size} className="border-dashed" title={`${label} was not measured`}>
    {label} not measured
  </Badge>
);

interface AudioStatsProps {
  track: TrackData;
  size?: 'sm' | 'md';
  /** Classes for each row of badges (alignment). */
  rowClassName?: string;
  className?: string;
}

/**
 * Measured audio values (BPM, key, energy) and, separately, the audio-model scores. Each
 * measured value is either shown or marked "not measured"; model scores are shown only when
 * present and are labelled as estimates.
 */
export const AudioStats: React.FC<AudioStatsProps> = ({
  track,
  size = 'sm',
  rowClassName = 'justify-center',
  className = '',
}) => {
  const bpm = measuredNumber(track.bpm);
  const key = measuredText(track.key);
  const energy = measuredNumber(track.energy);
  const valence = measuredNumber(track.valence);
  const danceability = measuredNumber(track.danceability);
  const acousticness = measuredNumber(track.acousticness);
  const hasModelScores = valence !== null || danceability !== null || acousticness !== null;
  const measuredTitle = 'Measured from the audio preview';
  const iconSize = size === 'md' ? 12 : 10;

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <ul aria-label="Audio values" className={`flex flex-wrap items-center gap-2 ${rowClassName}`}>
        <li>
          {bpm !== null ? (
            <Badge variant="cyber" size={size} title={measuredTitle}>
              <span className="opacity-60">BPM</span> {bpm}
            </Badge>
          ) : (
            <NotMeasured label="BPM" size={size} />
          )}
        </li>
        <li>
          {key !== null ? (
            <Badge variant="cyber" size={size} title={measuredTitle}>
              <span className="opacity-60">KEY</span> {key}
            </Badge>
          ) : (
            <NotMeasured label="Key" size={size} />
          )}
        </li>
        <li>
          {energy !== null ? (
            <Badge
              variant="gray"
              size={size}
              icon={<Zap size={iconSize} className="text-cyber" />}
              title={measuredTitle}
            >
              <span className="text-text-tertiary">ENERGY</span>{' '}
              <span className="text-cyber">{Math.round(energy * 100)}%</span>
            </Badge>
          ) : (
            <NotMeasured label="Energy" size={size} />
          )}
        </li>
      </ul>

      {hasModelScores && (
        <ul
          aria-label="Audio-model estimates"
          className={`flex flex-wrap items-center gap-2 ${rowClassName}`}
        >
          <li className="text-[10px] font-mono text-text-tertiary uppercase tracking-widest">
            Audio-model estimates (scores 0–1, not probabilities)
          </li>
          {valence !== null && (
            <li>
              <Badge
                variant="gray"
                size={size}
                icon={
                  <Heart
                    size={iconSize}
                    className={valence > 0.5 ? 'text-accent-pink' : 'text-accent-blue'}
                  />
                }
                title="Mood score from an audio model: 0 = melancholic, 1 = euphoric"
              >
                <span className="text-text-tertiary">MOOD</span>{' '}
                <span className={valence > 0.5 ? 'text-accent-pink' : 'text-accent-blue'}>
                  {moodLabel(valence)}
                </span>{' '}
                <span className="text-text-tertiary">{formatScore(valence)}</span>
              </Badge>
            </li>
          )}
          {danceability !== null && (
            <li>
              <Badge
                variant="gray"
                size={size}
                icon={<Disc size={iconSize} className="text-analog" />}
                title="Danceability score from an audio model"
              >
                <span className="text-text-tertiary">DANCE</span>{' '}
                <span className="text-analog">{formatScore(danceability)}</span>
              </Badge>
            </li>
          )}
          {acousticness !== null && (
            <li>
              <Badge variant="gray" size={size} title="Acousticness score from an audio model">
                <span className="text-text-tertiary">ACOUSTIC</span>{' '}
                <span className="text-analog">{formatScore(acousticness)}</span>
              </Badge>
            </li>
          )}
        </ul>
      )}
    </div>
  );
};

/** The audio notice for a track, or null when every audio value was measured. */
function audioNotice(track: TrackData) {
  const missing = missingAudioValues(track);
  if (track.audioSource !== 'unavailable' && missing.length === 0) return null;
  const allFields = MEASURED_AUDIO_FIELDS.length + AUDIO_MODEL_FIELDS.length;
  return {
    title: missing.length === allFields ? 'Audio not analysed' : 'Audio partly measured',
    reason:
      track.audioSource === 'unavailable' || track.audioUnavailableReason
        ? audioUnavailableText(track.audioUnavailableReason)
        : null,
    missing,
  };
}

const Notice: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="flex gap-3 items-start px-4 py-3 border border-analog/30 bg-analog/5 rounded-md">
    <AlertTriangle size={16} className="text-analog flex-shrink-0 mt-0.5" aria-hidden="true" />
    <div className="text-xs font-mono text-text-secondary space-y-1">
      <p className="text-analog uppercase tracking-widest">{title}</p>
      {children}
    </div>
  </div>
);

/**
 * Notices naming what a result is missing: the model's output when the model was unavailable,
 * and the audio values that were not measured (with the reason). Renders nothing otherwise.
 */
export const ResultNotices: React.FC<{ track: TrackData; className?: string }> = ({
  track,
  className = '',
}) => {
  const audio = audioNotice(track);
  const modelMissing = track.modelUnavailable ? missingModelOutput(track) : [];
  if (!track.modelUnavailable && !audio) return null;

  return (
    <section aria-label="Missing data" className={`flex flex-col gap-2 ${className}`}>
      {track.modelUnavailable && (
        <Notice title="Model unavailable">
          <p>
            This result was built from source data only
            {track.modelUnavailableReason ? ` (${track.modelUnavailableReason})` : ''}.
          </p>
          {modelMissing.length > 0 && <p>Missing: {modelMissing.join(', ')}.</p>}
        </Notice>
      )}
      {audio && (
        <Notice title={audio.title}>
          {audio.reason && <p>{audio.reason}</p>}
          {track.audioUnavailableDetail && (
            <p className="text-text-tertiary">{track.audioUnavailableDetail}</p>
          )}
          {audio.missing.length > 0 && <p>Not measured: {audio.missing.join(', ')}.</p>}
        </Notice>
      )}
    </section>
  );
};
