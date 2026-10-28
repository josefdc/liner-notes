import type React from 'react';
import { TriangleAlert, Disc, Heart, History, Zap } from 'lucide-react';
import type { TrackData } from '../types';
import {
  type AudioField,
  audioNoticeOf,
  audioReadings,
  missingModelOutput,
  modelUnavailableText,
  QUERY_MATCH_TITLE,
  type Reading,
  queryMatchText,
  recordingOf,
} from '../constants';
import { isWholeRecording, recordedDate } from '../utils/recording';
import { MeasuredValue } from './measured/MeasuredValue';
import { MissingValue } from './measured/MissingValue';
import { ProvenanceChip } from './provenance/ProvenanceChip';

// Provenance display for the result screens: measured values, audio-model scores, model
// inference, and what is missing. A missing value is always shown as missing, never as 0.

/**
 * Chip marking content a model wrote. It takes no words of its own: content that no model wrote
 * (source data, a template) has a chip of its own kind (ProvenanceChip).
 */
export const InferenceLabel: React.FC<{ className?: string }> = ({ className = '' }) => (
  <ProvenanceChip kind="inferred" className={className} title="Written by a model, not measured">
    Model inference
  </ProvenanceChip>
);

/**
 * Where content without a claim of its own comes from: written by the model, or taken from
 * source data by code when the model was unavailable (records with no citation to show).
 */
export const ResultOriginLabel: React.FC<{ fromSourceData: boolean; className?: string }> = ({
  fromSourceData,
  className = '',
}) =>
  fromSourceData ? (
    <ProvenanceChip
      kind="record"
      className={className}
      title="Taken from source records by code, without the model; no citation to show"
    />
  ) : (
    <InferenceLabel className={className} />
  );

interface AudioStatsProps {
  track: TrackData;
  size?: 'sm' | 'md';
  /** Classes for each row of values (alignment). */
  rowClassName?: string;
  /**
   * Each value with a chip of its kind, its provenance behind the chip (the Dashboard). Otherwise
   * each value with one plain line saying how it is known, its provenance behind a "How this was
   * measured" button (the Player's hero).
   */
  compact?: boolean;
  className?: string;
}

// The icons take the colour of their value's badge, which says how the value is known.
const ICONS: Partial<Record<AudioField, (size: number) => React.ReactNode>> = {
  loudness: (size) => <Zap size={size} />,
  energy: (size) => <Zap size={size} />,
  valence: (size) => <Heart size={size} />,
  danceability: (size) => <Disc size={size} />,
};

/**
 * One audio value with its provenance, or marked missing with why. Compact: the provenance
 * opens from the value's kind chip; summary: from a button under a plain line saying how the
 * value is known. A missing value always says why.
 */
export const ReadingValue: React.FC<{
  reading: Reading;
  size?: 'sm' | 'md';
  layout?: 'full' | 'compact' | 'summary';
}> = ({ reading, size = 'sm', layout = 'full' }) =>
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
      previewSeconds={reading.previewSeconds}
      detail={reading.detail}
      note={reading.note}
      title={reading.title}
      size={size}
      layout={layout}
      icon={ICONS[reading.field]?.(size === 'md' ? 12 : 10)}
    />
  );

/**
 * Measured audio values (BPM, key, loudness or the older energy) and, separately, the
 * audio-model scores. Each value is shown with how it is known (measured, or a model estimate)
 * and its confidence and basis on demand, or marked missing with why. A result without an
 * `audio` block shows only the model scores it has.
 */
export const AudioStats: React.FC<AudioStatsProps> = ({
  track,
  size = 'sm',
  rowClassName = 'justify-center',
  compact = false,
  className = '',
}) => {
  const { signal, model, showMissingModel, fingerprint } = audioReadings(track);
  const modelShown = model.filter((reading) => reading.state === 'shown');
  // With an `audio` block but no mood scores, one line says so instead of one per score: "model
  // scores" when no model score is shown anywhere, "mood scores" when style or tag scores are.
  const modelsMissing = fingerprint !== null && modelShown.length === 0;
  const listsShown = fingerprint?.styles.state === 'shown' || fingerprint?.tags.state === 'shown';
  const modelRows = showMissingModel ? model : modelShown;
  const firstModel = model[0];
  // Compact: values further apart than a value from its chip; below md, one value per line,
  // each line starting at the same edge.
  const layout = compact ? 'compact' : 'summary';
  // Summary: values further apart across than down, each in a column of one width and set at
  // its left (the Player's hero is centred text), so a value's label never runs into the next
  // one's and a stack of values shares its left edge.
  const list = compact ? 'gap-x-4 gap-y-3' : 'gap-x-6 gap-y-2';
  const item = compact ? 'max-md:w-full' : 'w-60 max-w-full text-left';

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <ul
        aria-label="Audio values"
        className={`flex flex-wrap items-start ${list} ${rowClassName}`}
      >
        {signal.map((reading) => (
          <li key={reading.field} className={item}>
            <ReadingValue reading={reading} size={size} layout={layout} />
          </li>
        ))}
      </ul>

      {modelRows.length > 0 && (
        <div className="flex flex-col gap-2">
          {/* Its own line in every state, above the estimates it labels. */}
          <p
            className={`flex ${rowClassName} text-chrome font-mono text-text-chip uppercase tracking-widest`}
          >
            Audio-model estimates (scores, not probabilities)
          </p>
          <ul
            aria-label="Audio-model estimates"
            className={`flex flex-wrap items-start ${list} ${rowClassName}`}
          >
            {modelsMissing ? (
              <li className={item}>
                <MissingValue
                  label={listsShown ? 'Mood scores' : 'Model scores'}
                  status="not available"
                  reason={firstModel?.state === 'missing' ? firstModel.reason : null}
                  size={size}
                />
              </li>
            ) : (
              modelRows.map((reading) => (
                <li key={reading.field} className={item}>
                  <ReadingValue reading={reading} size={size} layout={layout} />
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  );
};

const Notice: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="flex gap-3 items-start px-4 py-3 border border-status-warning/30 bg-status-warning/5 rounded-md">
    <TriangleAlert
      size={16}
      className="text-status-warning flex-shrink-0 mt-0.5"
      aria-hidden="true"
    />
    <div className="text-xs font-mono text-text-secondary space-y-1">
      <p className="text-status-warning uppercase tracking-widest">{title}</p>
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
  const audio = audioNoticeOf(track);
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
              {audio.lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
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
      'then. Nothing was analyzed live for it.';
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
