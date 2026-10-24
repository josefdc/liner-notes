import type React from 'react';
import { TriangleAlert, Disc, Heart, History, Sparkles, Zap } from 'lucide-react';
import { Badge } from './ui/Badge';
import type { TrackData } from '../types';
import {
  AUDIO_FIELD_COUNT,
  ESTIMATED_AUDIO_TEXT,
  audioUnavailableText,
  audioValues,
  formatScore,
  hasEstimatedAudio,
  missingAudioValues,
  missingModelOutput,
  modelUnavailableText,
  moodLabel,
  QUERY_MATCH_TITLE,
  queryMatchText,
  recordingOf,
} from '../constants';
import { isWholeRecording, recordedDate } from '../utils/recording';

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
  // Estimated (not measured) values come back null here: shown as not measured.
  const { bpm, key, energy, valence, danceability, acousticness } = audioValues(track);
  const hasModelScores = valence !== null || danceability !== null || acousticness !== null;
  // A replayed result's values were measured when its run was recorded, not now.
  const measuredTitle = recordingOf(track)
    ? 'Measured from the audio preview when this run was recorded'
    : 'Measured from the audio preview';
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
              <span className="text-text-chip">ENERGY</span>{' '}
              <span className="text-cyber">{Math.round(energy * 100)}%</span>
            </Badge>
          ) : (
            <NotMeasured label="Energy" size={size} />
          )}
        </li>
      </ul>

      {hasModelScores && (
        <div className={`flex flex-wrap items-center gap-2 ${rowClassName}`}>
          <p className="text-[10px] font-mono text-text-tertiary uppercase tracking-widest">
            Audio-model estimates (scores 0–1, not probabilities)
          </p>
          <ul
            aria-label="Audio-model estimates"
            className={`flex flex-wrap items-center gap-2 ${rowClassName}`}
          >
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
                  <span className="text-text-chip">MOOD</span>{' '}
                  <span className={valence > 0.5 ? 'text-accent-pink' : 'text-accent-blue'}>
                    {moodLabel(valence)}
                  </span>{' '}
                  <span className="text-text-chip">{formatScore(valence)}</span>
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
                  <span className="text-text-chip">DANCE</span>{' '}
                  <span className="text-analog">{formatScore(danceability)}</span>
                </Badge>
              </li>
            )}
            {acousticness !== null && (
              <li>
                <Badge variant="gray" size={size} title="Acousticness score from an audio model">
                  <span className="text-text-chip">ACOUSTIC</span>{' '}
                  <span className="text-analog">{formatScore(acousticness)}</span>
                </Badge>
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
};

/** The audio notice for a track, or null when every audio value was measured. */
function audioNotice(track: TrackData) {
  const missing = missingAudioValues(track);
  if (hasEstimatedAudio(track)) {
    return { title: 'Audio values not measured', reason: ESTIMATED_AUDIO_TEXT, missing };
  }
  if (track.audioSource === 'analyzed' && missing.length === 0) return null;
  return {
    title: missing.length === AUDIO_FIELD_COUNT ? 'Audio not analysed' : 'Audio partly measured',
    reason: audioUnavailableText(track.audioUnavailableReason),
    missing,
  };
}

const Notice: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="flex gap-3 items-start px-4 py-3 border border-analog/30 bg-analog/5 rounded-md">
    <TriangleAlert size={16} className="text-analog flex-shrink-0 mt-0.5" aria-hidden="true" />
    <div className="text-xs font-mono text-text-secondary space-y-1">
      <p className="text-analog uppercase tracking-widest">{title}</p>
      {children}
    </div>
  </div>
);

/**
 * Notices about a result: that the track may not be the song searched for (the search text did
 * not match it exactly), the model's output when the model was unavailable, and the audio
 * values that were not measured (with the reason). Renders nothing otherwise.
 *
 * A whole recorded run played again never shows the search-match note: how a text matched the
 * track belonged to the recorded run (the API sends none with a replay).
 */
export const ResultNotices: React.FC<{ track: TrackData; className?: string }> = ({
  track,
  className = '',
}) => {
  const match = isWholeRecording(track.run) ? null : queryMatchText(track.queryMatch);
  const audio = audioNotice(track);
  const modelMissing = track.modelUnavailable ? missingModelOutput(track) : [];
  const missing = Boolean(track.modelUnavailable || audio);
  if (!match && !missing) return null;

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      {match && (
        <section aria-label="Search match">
          <Notice title={QUERY_MATCH_TITLE}>
            <p>
              {match} The analysis below is of “{track.title}” by {track.artist}.
            </p>
          </Notice>
        </section>
      )}
      {missing && (
        <section aria-label="Missing data" className="flex flex-col gap-2">
          {track.modelUnavailable && (
            <Notice title="Model unavailable">
              <p>
                This result was built from source data only
                {` (${modelUnavailableText(track.modelUnavailableReason)})`}.
              </p>
              {modelMissing.length > 0 && <p>Missing: {modelMissing.join(', ')}.</p>}
            </Notice>
          )}
          {audio && (
            <Notice title={audio.title}>
              <p>{audio.reason}</p>
              {audio.missing.length > 0 && <p>Not measured: {audio.missing.join(', ')}.</p>}
            </Notice>
          )}
        </section>
      )}
    </div>
  );
};

/**
 * Says that a result is a recorded run served again, with when (and from which commit) it was
 * recorded, so a replay never reads as a live analysis. Renders nothing for a live result.
 *
 * A result whose run says "replay" but neither when nor where it was recorded is a live run
 * whose model answers were replayed from stored answers (a development setting): it is labelled
 * as that, not as a whole recording.
 */
export const RecordedRunNotice: React.FC<{
  track: TrackData;
  /** One line, for narrow screens; the full text is its tooltip. */
  compact?: boolean;
  className?: string;
}> = ({ track, compact = false, className = '' }) => {
  const recording = recordingOf(track);
  if (!recording) return null;
  const date = recordedDate(recording.recordedAt);
  const modelOnly = !isWholeRecording(track.run);
  const known = date ? `on ${date}` : null;
  const commit = recording.commit ? ` (commit ${recording.commit})` : '';
  const title = modelOnly
    ? `Model answers replayed · ${date ? `recorded ${date}` : 'recording date not stored'}`
    : `Recorded run · ${date ?? 'date not recorded'} · replayed`;
  const text = modelOnly
    ? `The model's answers in this result were replayed from answers recorded ${known ?? 'at a time that was not stored'}${commit}. ` +
      'The rest of it may have run live; it is not a live model call.'
    : `This result was recorded ${known ?? 'earlier'}${commit} and is shown again as it was ` +
      'then. Nothing was analysed live for it.';
  return (
    <section
      aria-label="Recorded run"
      title={compact ? text : undefined}
      className={`flex gap-3 items-start border border-cyber/30 bg-cyber/5 rounded-md ${compact ? 'px-3 py-1.5' : 'px-4 py-3'} ${className}`}
    >
      <History
        size={compact ? 12 : 16}
        className="text-cyber flex-shrink-0 mt-0.5"
        aria-hidden="true"
      />
      <div className="text-xs font-mono text-text-secondary space-y-1">
        <p className="text-cyber uppercase tracking-widest">{title}</p>
        {compact ? <p className="sr-only">{text}</p> : <p>{text}</p>}
      </div>
    </section>
  );
};
