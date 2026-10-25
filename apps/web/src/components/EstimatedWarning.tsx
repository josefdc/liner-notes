import type React from 'react';
import { TriangleAlert, Disc, Heart, History, Sparkles, Zap } from 'lucide-react';
import { Badge } from './ui/Badge';
import type { TrackData } from '../types';
import {
  type AudioField,
  audioReadings,
  audioUnavailableText,
  audioValueCount,
  ESTIMATED_AUDIO_TEXT,
  hasEstimatedAudio,
  hasMeasuredAudioSource,
  measuredAudioOf,
  missingAudioValues,
  missingModelOutput,
  modelUnavailableText,
  QUERY_MATCH_TITLE,
  type Reading,
  type ShownReading,
  queryMatchText,
  recordingOf,
} from '../constants';
import { isWholeRecording, recordedDate } from '../utils/recording';
import { MeasuredValue } from './measured/MeasuredValue';
import { MissingValue } from './measured/MissingValue';

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

interface AudioStatsProps {
  track: TrackData;
  size?: 'sm' | 'md';
  /** Classes for each row of values (alignment). */
  rowClassName?: string;
  className?: string;
}

const ICONS: Partial<Record<AudioField, (size: number, reading: ShownReading) => React.ReactNode>> =
  {
    loudness: (size) => <Zap size={size} className="text-cyber" />,
    energy: (size) => <Zap size={size} className="text-cyber" />,
    valence: (size, reading) => (
      <Heart
        size={size}
        className={
          /^(Euphoric|Upbeat)/.test(reading.value) ? 'text-accent-pink' : 'text-accent-blue'
        }
      />
    ),
    danceability: (size) => <Disc size={size} className="text-analog" />,
  };

/** One audio value with its provenance, or marked missing with why. */
export const ReadingValue: React.FC<{ reading: Reading; size?: 'sm' | 'md' }> = ({
  reading,
  size = 'sm',
}) =>
  reading.state === 'missing' ? (
    <MissingValue
      label={reading.label}
      status={reading.status}
      reason={reading.reason}
      size={size}
    />
  ) : (
    <MeasuredValue
      label={reading.label}
      value={reading.value}
      kind={reading.kind}
      confidence={reading.confidence}
      basis={reading.basis}
      title={reading.title}
      size={size}
      icon={ICONS[reading.field]?.(size === 'md' ? 12 : 10, reading)}
    />
  );

/**
 * Measured audio values (BPM, key, loudness or the older energy) and, separately, the
 * audio-model scores. Each value is shown with its confidence and basis (measured, or a model
 * estimate), or marked missing with why. A result without an `audio` block shows only the model
 * scores it has.
 */
export const AudioStats: React.FC<AudioStatsProps> = ({
  track,
  size = 'sm',
  rowClassName = 'justify-center',
  className = '',
}) => {
  const { signal, model, showMissingModel, fingerprint } = audioReadings(track);
  const modelShown = model.filter((reading) => reading.state === 'shown');
  // With an `audio` block but no audio models, one line says so instead of one per score.
  const modelsMissing = fingerprint !== null && modelShown.length === 0;
  const modelRows = showMissingModel ? model : modelShown;

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <ul aria-label="Audio values" className={`flex flex-wrap items-start gap-2 ${rowClassName}`}>
        {signal.map((reading) => (
          <li key={reading.field}>
            <ReadingValue reading={reading} size={size} />
          </li>
        ))}
      </ul>

      {modelRows.length > 0 && (
        <div className={`flex flex-wrap items-center gap-2 ${rowClassName}`}>
          <p className="text-[10px] font-mono text-text-tertiary uppercase tracking-widest">
            Audio-model estimates (scores, not probabilities)
          </p>
          <ul
            aria-label="Audio-model estimates"
            className={`flex flex-wrap items-start gap-2 ${rowClassName}`}
          >
            {modelsMissing ? (
              <li>
                <MissingValue
                  label="Model scores"
                  reason={model[0]?.state === 'missing' ? model[0].reason : null}
                  size={size}
                />
              </li>
            ) : (
              modelRows.map((reading) => (
                <li key={reading.field}>
                  <ReadingValue reading={reading} size={size} />
                </li>
              ))
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
  if (missing.length === 0 && hasMeasuredAudioSource(track)) return null;
  const audio = measuredAudioOf(track);
  const { signal } = audioReadings(track);
  const reasons = signal.filter((r) => r.state === 'missing' && r.reason !== null);
  let reason: string;
  if (audio && !audio.gate.passed) {
    reason = `The audio was analysed but nothing was measured: ${signal[0]?.state === 'missing' ? signal[0].reason : 'the preview did not pass the analysis gate'}.`;
  } else if (track.audioUnavailableReason) {
    reason = audioUnavailableText(track.audioUnavailableReason);
  } else if (reasons.length > 0 || audio) {
    reason = 'Each missing value says why, or that it was not measured.';
  } else {
    reason = audioUnavailableText(undefined);
  }
  return {
    title:
      missing.length === audioValueCount(track) ? 'Audio not analysed' : 'Audio partly measured',
    reason,
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
 * A run whose model answers alone were replayed from stored answers (development and
 * evaluation; `run.replayed` is "model_answers", or, from servers that do not say, a "replay"
 * that names neither when nor where it was recorded) is labelled as that, with when and from
 * which commit the answers were recorded where it says: the rest of it ran live.
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
      aria-label={modelOnly ? 'Replayed model answers' : 'Recorded run'}
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
