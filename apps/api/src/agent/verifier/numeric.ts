/**
 * The numeric check: the tempo and the key a claim's text states, compared with the measured
 * audio. Pure: no model call, no I/O. Its result goes to the claim's `numericCheck` (with
 * `numericReason` and `numericComparison`) and never touches the judge's verdict.
 *
 * What is read. Every tempo written with its unit ("120 BPM", "120 bpm", "96.5 beats per
 * minute") and every key written with its mode ("F# minor", "B-flat major", "Bb major",
 * "E♭ minor") or after "key of" ("in the key of Bb", mode optional). The claim's `field` is a
 * hint, not a gate: a factoid card's claim has none and is read all the same. A key with a mode
 * is taken only where it cannot be ordinary English: the claim points at the key (`field`), its
 * text says "key", the tonic has an accidental, or "in" comes right before it ("written in
 * A minor"); "A minor hit" is not a key.
 *
 * What it is compared with. Only a measurement whose gate passed (`measuredAudio`), and only the
 * block the mention is about: `audio.tempo` (bpm, confidence, method) or `audio.key` (tonic,
 * mode, strength, method). Nothing else of the measurement is read. A mention of a block that
 * was not measured is not compared.
 *
 * The estimator is never ground truth. For a tempo, measured m and stated c:
 * - consistent when |c - m| <= max(2 BPM, 2 % of m);
 * - conflict when c / m is within 4 % of x0.5, x2, x2/3 or x1.5 (the metrical errors tempo
 *   estimators make), or when |c - m| <= 4 % of m (preview length and hop quantisation);
 * - otherwise contradicted only when the measurement's confidence reaches the floor below which
 *   the audio service withholds a tempo (Essentia 1.5 of 5.32, librosa 0.3; an unknown method
 *   takes the higher one; no confidence is low), and conflict when it does not.
 * For a key, the stated tonic and mode against the measured ones, enharmonics folded (Bb = A#):
 * - consistent for the same tonic and mode (or the same tonic when no mode is stated);
 * - conflict for the parallel key (same tonic, other mode), the relative key (A minor and
 *   C major) or a key a fifth away, the errors key estimators make;
 * - otherwise contradicted only when the key strength reaches the service's floor (0.4; no
 *   strength is low), and conflict when it does not.
 * These floors are the service's own (services/audio/estimators.py). They do not rank octave
 * errors (a confident estimate can still be double the tempo), which are conflicts by relation
 * whatever the confidence.
 *
 * A claim with several mentions takes the worst result (contradicted, then conflict, then
 * consistent), and its comparison is that mention's. A claim that mentions nothing comparable
 * is `n/a`.
 */

import {
  type AudioFeatures,
  type Claim,
  type ClaimField,
  type KeyMode,
  measuredAudio,
  type NumericCheck,
  PitchClass,
} from "@liner-notes/contract";

/** A stated tempo agrees within max(TEMPO_BAND_BPM, TEMPO_BAND_SHARE of the measured tempo). */
export const TEMPO_BAND_BPM = 2;
export const TEMPO_BAND_SHARE = 0.02;
/** How close a ratio, or a difference relative to the measurement, counts as an estimator error. */
export const ESTIMATOR_TOLERANCE = 0.04;
/** The tempo ratios (stated / measured) a tempo estimator gets wrong, in words. */
export const TEMPO_RATIOS: ReadonlyArray<readonly [ratio: number, words: string]> = [
  [0.5, "half the measured tempo"],
  [2, "twice the measured tempo"],
  [2 / 3, "two thirds of the measured tempo"],
  [1.5, "one and a half times the measured tempo"],
];
/** The audio service's tempo confidence floors (normalised 0..1), by estimator. */
export const ESSENTIA_MIN_TEMPO_CONFIDENCE = 1.5 / 5.32;
export const LIBROSA_MIN_TEMPO_CONFIDENCE = 0.3;
/** The audio service's key strength floor, both estimators. */
export const MIN_KEY_STRENGTH = 0.4;

/** Stated tempos outside this range are not tempos (a year, a count). */
const TEMPO_MIN = 20;
const TEMPO_MAX = 400;

export interface TempoMention {
  field: "tempo";
  bpm: number;
}

export interface KeyMention {
  field: "key";
  tonic: PitchClass;
  /** null when the text names the tonic only ("in the key of Bb"). */
  mode: KeyMode | null;
}

export type Mention = TempoMention | KeyMention;

/** What the numeric check writes on a claim. */
export interface NumericOutcome {
  numericCheck: NumericCheck;
  numericReason: string | null;
  numericComparison: {
    claimed: number | string;
    measured: number | string;
    method: string;
  } | null;
  /** The field the deciding mention is about; null when no mention was compared. */
  field: ClaimField | null;
}

// =============================================================================
// Reading the text
// =============================================================================

const TEMPO =
  /(?<![\p{L}\p{N}.,])(\d{2,3}(?:[.,]\d{1,2})?)\s*-?\s*(?:bpm\b|b\.p\.m\.|beats\s+(?:per|a|each)\s+minute\b)/giu;

/** Every tempo the text states with its unit, in order. */
export function tempoMentions(text: string): TempoMention[] {
  const mentions: TempoMention[] = [];
  for (const match of text.matchAll(TEMPO)) {
    const bpm = Number(match[1].replace(",", "."));
    if (Number.isFinite(bpm) && bpm >= TEMPO_MIN && bpm <= TEMPO_MAX) {
      mentions.push({ field: "tempo", bpm });
    }
  }
  return mentions;
}

// A tonic, an accidental (a sign, or the word flat or sharp), then the mode.
const ACCIDENTAL = String.raw`(?:(#|♯|b|♭)|[ -](flat|sharp)\b)?`;
const KEY_WITH_MODE = new RegExp(
  String.raw`(?<![\p{L}\p{N}#♯♭])([A-G])${ACCIDENTAL}[ -]?([Mm]ajor|[Mm]inor|MAJOR|MINOR)\b`,
  "gu",
);
const KEY_OF = new RegExp(
  String.raw`\bkey of ([A-G])${ACCIDENTAL}(?:[ -]?([Mm]ajor|[Mm]inor|MAJOR|MINOR)\b)?(?![\p{L}\p{N}#♯])`,
  "gu",
);
const NATURAL: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function pitchOf(letter: string, sign: string | undefined, word: string | undefined): PitchClass {
  const shift =
    sign === "#" || sign === "♯" || word === "sharp"
      ? 1
      : sign === "b" || sign === "♭" || word === "flat"
        ? -1
        : 0;
  return PitchClass.options[(NATURAL[letter] + shift + 12) % 12];
}

const modeOf = (word: string | undefined): KeyMode | null =>
  word ? (word.toLowerCase() === "major" ? "major" : "minor") : null;

/**
 * Every key the text states, in order. A key with a mode outside "key of" counts only where it
 * cannot be ordinary English (see the module comment); `pointsAtKey` is the claim's own `field`.
 */
export function keyMentions(text: string, pointsAtKey = false): KeyMention[] {
  const found: Array<{ at: number; end: number; mention: KeyMention }> = [];
  for (const match of text.matchAll(KEY_OF)) {
    const at = match.index ?? 0;
    found.push({
      at,
      end: at + match[0].length,
      mention: {
        field: "key",
        tonic: pitchOf(match[1], match[2], match[3]),
        mode: modeOf(match[4]),
      },
    });
  }
  const saysKey = pointsAtKey || /\bkeys?\b/i.test(text);
  for (const match of text.matchAll(KEY_WITH_MODE)) {
    const at = match.index ?? 0;
    if (found.some((other) => at >= other.at && at < other.end)) continue;
    const accidental = match[2] !== undefined || match[3] !== undefined;
    const afterIn = /\bin\s+$/i.test(text.slice(Math.max(0, at - 4), at));
    if (!saysKey && !accidental && !afterIn) continue;
    found.push({
      at,
      end: at + match[0].length,
      mention: {
        field: "key",
        tonic: pitchOf(match[1], match[2], match[3]),
        mode: modeOf(match[4]),
      },
    });
  }
  return found.sort((a, b) => a.at - b.at).map((item) => item.mention);
}

// =============================================================================
// Comparing
// =============================================================================

const RANK: Readonly<Record<NumericCheck, number>> = {
  "n/a": 0,
  consistent: 1,
  conflict: 2,
  contradicted: 3,
};

const round1 = (value: number) => Math.round(value * 10) / 10;
const bpmText = (bpm: number) => `${round1(bpm)} BPM`;
const keyText = (tonic: PitchClass, mode: KeyMode | null) => (mode ? `${tonic} ${mode}` : tonic);

/** The confidence floor of a tempo estimator, by its method name. */
export function tempoConfidenceFloor(method: string): number {
  const name = method.toLowerCase();
  if (name.startsWith("librosa")) return LIBROSA_MIN_TEMPO_CONFIDENCE;
  if (name.startsWith("essentia")) return ESSENTIA_MIN_TEMPO_CONFIDENCE;
  return Math.max(ESSENTIA_MIN_TEMPO_CONFIDENCE, LIBROSA_MIN_TEMPO_CONFIDENCE);
}

function compareTempo(mention: TempoMention, tempo: NonNullable<AudioFeatures["tempo"]>) {
  const claimed = mention.bpm;
  const measured = tempo.bpm;
  const lead = `States ${bpmText(claimed)}; the preview measured ${bpmText(measured)} (${tempo.method})`;
  const comparison = { claimed, measured: round1(measured), method: tempo.method };
  const difference = Math.abs(claimed - measured);
  const outcome = (numericCheck: NumericCheck, why: string) => ({
    numericCheck,
    numericReason: `${lead}${why}`,
    numericComparison: comparison,
    field: "tempo" as const,
  });
  if (difference <= Math.max(TEMPO_BAND_BPM, TEMPO_BAND_SHARE * measured)) {
    return outcome("consistent", ": they agree.");
  }
  for (const [ratio, words] of TEMPO_RATIOS) {
    if (Math.abs(claimed / (measured * ratio) - 1) <= ESTIMATOR_TOLERANCE) {
      return outcome(
        "conflict",
        `. The stated tempo is ${words}, an error tempo estimators make, so both are shown.`,
      );
    }
  }
  if (difference <= ESTIMATOR_TOLERANCE * measured) {
    return outcome(
      "conflict",
      ". They differ by less than 4 %, which a 30-second preview can explain, so both are shown.",
    );
  }
  const floor = tempoConfidenceFloor(tempo.method);
  if (tempo.confidence !== null && tempo.confidence >= floor) {
    return outcome(
      "contradicted",
      ". The measurement is confident and the difference is not a known estimator error.",
    );
  }
  return outcome(
    "conflict",
    ". The measurement's confidence is too low to rule the statement out, so both are shown.",
  );
}

function compareKey(mention: KeyMention, key: NonNullable<AudioFeatures["key"]>) {
  const stated = PitchClass.options.indexOf(mention.tonic);
  const measuredPitch = PitchClass.options.indexOf(key.tonic);
  const lead = `States ${keyText(mention.tonic, mention.mode)}; the preview measured ${keyText(key.tonic, key.mode)} (${key.method})`;
  const comparison = {
    claimed: keyText(mention.tonic, mention.mode),
    measured: keyText(key.tonic, key.mode),
    method: key.method,
  };
  const outcome = (numericCheck: NumericCheck, why: string) => ({
    numericCheck,
    numericReason: `${lead}${why}`,
    numericComparison: comparison,
    field: "key" as const,
  });
  const interval = (stated - measuredPitch + 12) % 12;
  if (interval === 0 && (mention.mode === null || mention.mode === key.mode)) {
    return outcome("consistent", ": they agree.");
  }
  const estimatorError = (words: string) =>
    outcome(
      "conflict",
      `. The stated key is ${words}, an error key estimators make, so both are shown.`,
    );
  if (interval === 0) return estimatorError("its parallel key");
  // The relative key: the minor key three semitones below a major one, the major key three
  // above a minor one (with no stated mode, the tonic alone).
  const relative = key.mode === "major" ? 9 : 3;
  if (interval === relative && mention.mode !== key.mode) {
    return estimatorError("its relative key");
  }
  if (interval === 5 || interval === 7) return estimatorError("a fifth away from it");
  if (key.strength !== null && key.strength >= MIN_KEY_STRENGTH) {
    return outcome(
      "contradicted",
      ". The measurement is confident and the difference is not a known estimator error.",
    );
  }
  return outcome(
    "conflict",
    ". The measurement's key strength is too low to rule the statement out, so both are shown.",
  );
}

const NOT_COMPARED: NumericOutcome = {
  numericCheck: "n/a",
  numericReason: null,
  numericComparison: null,
  field: null,
};

/**
 * The numeric check of one claim against the measurement (see the module comment). `n/a` when
 * the text states no tempo or key, or nothing it states was measured; then the reason says what
 * was not compared, or is null when nothing was stated.
 */
export function checkNumbers(
  claim: Pick<Claim, "text"> & { field?: ClaimField | null },
  audio: AudioFeatures | null | undefined,
): NumericOutcome {
  const mentions: Mention[] = [
    ...tempoMentions(claim.text),
    ...keyMentions(claim.text, claim.field === "key"),
  ];
  if (mentions.length === 0) return NOT_COMPARED;
  const measured = measuredAudio(audio) ? audio : null;
  let worst: NumericOutcome = NOT_COMPARED;
  for (const mention of mentions) {
    const result =
      mention.field === "tempo"
        ? measured?.tempo
          ? compareTempo(mention, measured.tempo)
          : null
        : measured?.key
          ? compareKey(mention, measured.key)
          : null;
    if (result && RANK[result.numericCheck] > RANK[worst.numericCheck]) worst = result;
  }
  if (worst.numericCheck !== "n/a") return worst;
  const fields = [...new Set(mentions.map((mention) => mention.field))].join(" and ");
  return {
    ...NOT_COMPARED,
    numericReason: `Not compared: the preview's ${fields} was not measured.`,
  };
}
