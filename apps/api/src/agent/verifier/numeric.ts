/**
 * The numeric check: the tempo and the key a claim's text states, compared with the measured
 * audio. Pure: no model call, no I/O. Its result goes to the claim's `numericCheck` (with
 * `numericReason` and `numericComparison`) and never touches the judge's verdict.
 *
 * What is read. Every tempo written with its unit ("120 BPM", "96.5 beats per minute", "120
 * beats-per-minute") or after it ("BPM: 120", "BPM of 120"), and, when the claim points at the
 * tempo (`field`), after "tempo" ("a tempo of 120"). Every key written with its mode ("F# minor",
 * "B-flat major", "Bb maj", "E minor vamp"), in shorthand for minor ("Am", "F#m") or after
 * "key of" ("in the key of Bb", "the key of a minor"). A key on the tonic A without an
 * accidental is taken only where it cannot be ordinary English: the claim points at the key
 * (`field`), its text says "key", or "in" comes right before it ("written in A minor"); "A minor
 * hit" and "I Am" are not keys.
 *
 * Whose tempo or key. Only a statement about this track is compared: the text is cut into
 * clauses (sentences, and at ";", "while", "whereas", "but", "that", "which"), and a mention
 * counts when its clause names this track as its subject (the track's title, "the track", "this
 * song", "this recording", or a clause that starts with "It"). When no clause does, the claim's
 * `field` (set by the model or by code) says the claim is about the track's tempo or key, and
 * the mentions of that field count. Any other mention is about another record ("the 1972 break
 * ran at 90 BPM", "Under Pressure is in D major") and is not compared. Cutting too much only
 * leaves a mention uncompared (`n/a`), never wrongly compared.
 *
 * What it is compared with. Only a measurement whose gate passed (`measuredAudio`), and only the
 * block the mention is about: `audio.tempo` (bpm, confidence, method) or `audio.key` (tonic,
 * mode, strength, method). Nothing else of the measurement is read. A mention of a block that
 * was not measured is not compared.
 *
 * The estimator is never ground truth. For a tempo, measured m and stated c:
 * - consistent when |c - m| <= max(2 BPM, 2 % of m);
 * - conflict when c / m is within 4 % of x0.5, x2, x2/3 or x1.5 (the metrical errors tempo
 *   estimators make; also x4 and x1/4, two octaves), or when |c - m| <= 4 % of m (preview
 *   length and hop quantisation);
 * - otherwise contradicted only when the measurement's confidence reaches the floor below which
 *   the audio service withholds a tempo (Essentia 1.5 of 5.32, librosa 0.3; an unknown method
 *   takes the higher one; no confidence is low), and conflict when it does not.
 * For a key, the stated tonic and mode against the measured ones, enharmonics folded (Bb = A#):
 * - consistent for the same tonic and mode (or the same tonic when no mode is stated);
 * - conflict for the parallel key (same tonic, other mode), the relative key (A minor and
 *   C major) or a key a fifth away in either mode (wider than a same-mode fifth: it only ever
 *   turns a contradiction into a conflict), the errors key estimators make;
 * - otherwise contradicted only when the key strength reaches the service's floor (0.4; no
 *   strength is low), and conflict when it does not.
 * These floors are the service's own (services/audio/estimators.py). They do not rank octave
 * errors (a confident estimate can still be double the tempo), which are conflicts by relation
 * whatever the confidence.
 *
 * A claim with several mentions about this track takes the worst result (contradicted, then
 * conflict, then consistent), and its comparison is that mention's. A claim that mentions
 * nothing comparable about this track is `n/a`.
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
  [4, "four times the measured tempo"],
  [0.25, "a quarter of the measured tempo"],
];
/** The audio service's tempo confidence floors (normalised 0..1), by estimator. */
export const ESSENTIA_MIN_TEMPO_CONFIDENCE = 1.5 / 5.32;
export const LIBROSA_MIN_TEMPO_CONFIDENCE = 0.3;
/** The audio service's key strength floor, both estimators. */
export const MIN_KEY_STRENGTH = 0.4;

/** Stated tempos outside this range are not tempos (a year, a count). */
const TEMPO_MIN = 20;
const TEMPO_MAX = 999;

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

const NUMBER = String.raw`(\d{2,3}(?:[.,]\d{1,2})?)`;
const NOT_IN_NUMBER = String.raw`(?<![\p{L}\p{N}.,])`;
// A number then its unit: "120 BPM", "120-BPM", "96.5 beats per minute", "120 beats-per-minute".
const TEMPO_UNIT_AFTER = new RegExp(
  String.raw`${NOT_IN_NUMBER}${NUMBER}\s*-?\s*(?:bpm\b|b\.p\.m\.|beats[\s-]+(?:per|a|each)[\s-]+minute\b)`,
  "giu",
);
// The unit then its number: "BPM: 246", "BPM of 246", "bpm 120".
const TEMPO_UNIT_BEFORE = new RegExp(
  String.raw`\b(?:bpm|b\.p\.m\.)\s*(?::|=|of|is|was|at)?\s*${NUMBER}(?![\p{N}%])`,
  "giu",
);
// "a tempo of 246", "tempo: 246": read only when the claim points at the tempo.
const TEMPO_WORD = new RegExp(
  String.raw`\btempo\s*(?::|=|of|is|was|at|around|about)?\s*(?:about|around|roughly|approximately|~)?\s*${NUMBER}(?![\p{N}%])`,
  "giu",
);

/** A mention and where it stands in the text. */
interface Placed<M> {
  at: number;
  end: number;
  mention: M;
}

function tempoPlaced(text: string, pointsAtTempo: boolean): Array<Placed<TempoMention>> {
  const found: Array<Placed<TempoMention>> = [];
  const patterns = pointsAtTempo
    ? [TEMPO_UNIT_AFTER, TEMPO_UNIT_BEFORE, TEMPO_WORD]
    : [TEMPO_UNIT_AFTER, TEMPO_UNIT_BEFORE];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const at = match.index ?? 0;
      const end = at + match[0].length;
      if (found.some((other) => at < other.end && end > other.at)) continue;
      const bpm = Number(match[1].replace(",", "."));
      if (Number.isFinite(bpm) && bpm >= TEMPO_MIN && bpm <= TEMPO_MAX) {
        found.push({ at, end, mention: { field: "tempo", bpm } });
      }
    }
  }
  return found.sort((a, b) => a.at - b.at);
}

/** Every tempo the text states, in order; `pointsAtTempo` is the claim's own `field`. */
export function tempoMentions(text: string, pointsAtTempo = false): TempoMention[] {
  return tempoPlaced(text, pointsAtTempo).map((item) => item.mention);
}

// A tonic, an accidental (a sign, or the word flat or sharp), then the mode, its abbreviation,
// or "m" for minor.
const ACCIDENTAL = String.raw`(?:(#|♯|b|♭)|[ -](flat|sharp)\b)?`;
const MODE = String.raw`(major|minor|Major|Minor|MAJOR|MINOR|maj|min|Maj|Min)\b`;
const KEY_WITH_MODE = new RegExp(
  String.raw`(?<![\p{L}\p{N}#♯♭])([A-G])${ACCIDENTAL}[ -]?${MODE}`,
  "gu",
);
const KEY_SHORT_MINOR = /(?<![\p{L}\p{N}#♯♭])([A-G])(#|♯|b|♭)?m(?![\p{L}\p{N}])/gu;
const KEY_OF = new RegExp(
  String.raw`\b[Kk]ey of ([A-Ga-g])${ACCIDENTAL}(?:[ -]?${MODE})?(?![\p{L}\p{N}#♯])`,
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
  return PitchClass.options[(NATURAL[letter.toUpperCase()] + shift + 12) % 12];
}

const modeOf = (word: string | undefined): KeyMode | null =>
  word ? (word.toLowerCase().startsWith("maj") ? "major" : "minor") : null;

function keyPlaced(text: string, pointsAtKey: boolean): Array<Placed<KeyMention>> {
  const found: Array<Placed<KeyMention>> = [];
  const add = (at: number, end: number, mention: KeyMention) => {
    if (found.some((other) => at < other.end && end > other.at)) return;
    found.push({ at, end, mention });
  };
  for (const match of text.matchAll(KEY_OF)) {
    // A lower-case tonic is a key only with its mode or an accidental ("key of a song" is not).
    const lower = match[1] !== match[1].toUpperCase();
    if (lower && match[4] === undefined) continue;
    const at = match.index ?? 0;
    add(at, at + match[0].length, {
      field: "key",
      tonic: pitchOf(match[1], match[2], match[3]),
      mode: modeOf(match[4]),
    });
  }
  // Only a plain A can be ordinary English ("A minor hit", "A major label", "I Am").
  const saysKey = pointsAtKey || /\bkeys?\b/i.test(text);
  const english = (at: number, letter: string, accidental: boolean) =>
    letter === "A" &&
    !accidental &&
    !saysKey &&
    !/\bin\s+$/i.test(text.slice(Math.max(0, at - 4), at));
  for (const match of text.matchAll(KEY_WITH_MODE)) {
    const at = match.index ?? 0;
    if (english(at, match[1], match[2] !== undefined || match[3] !== undefined)) continue;
    add(at, at + match[0].length, {
      field: "key",
      tonic: pitchOf(match[1], match[2], match[3]),
      mode: modeOf(match[4]),
    });
  }
  for (const match of text.matchAll(KEY_SHORT_MINOR)) {
    const at = match.index ?? 0;
    if (english(at, match[1], match[2] !== undefined)) continue;
    add(at, at + match[0].length, {
      field: "key",
      tonic: pitchOf(match[1], match[2], undefined),
      mode: "minor",
    });
  }
  return found.sort((a, b) => a.at - b.at);
}

/**
 * Every key the text states, in order. A plain A with a mode counts only where it cannot be
 * ordinary English (see the module comment); `pointsAtKey` is the claim's own `field`.
 */
export function keyMentions(text: string, pointsAtKey = false): KeyMention[] {
  return keyPlaced(text, pointsAtKey).map((item) => item.mention);
}

// =============================================================================
// Whose tempo or key
// =============================================================================

// Where a clause ends: a sentence end or ";", or a word that starts another clause.
const CLAUSE_BREAK =
  /[.!?;](?=\s|$)|,?\s+(?:while|whereas|but|that|which|who|although|though)\s+/giu;
const THIS_TRACK = /\b(?:this|the)\s+(?:track|song|recording|tune)\b/i;
const STARTS_WITH_IT = /^\s*(?:it|its|it['’]s)\b/i;

/** The [start, end) of each clause of `text`. */
function clauses(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  let start = 0;
  for (const match of text.matchAll(CLAUSE_BREAK)) {
    const at = match.index ?? 0;
    spans.push([start, at]);
    start = at + match[0].length;
  }
  spans.push([start, text.length]);
  return spans;
}

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a clause names this track as its subject: its title, "the track", or "It …". */
function aboutThisTrack(clause: string, title: string | undefined): boolean {
  if (THIS_TRACK.test(clause) || STARTS_WITH_IT.test(clause)) return true;
  const name = title?.trim();
  if (!name || name.length < 2) return false;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped(name)}(?![\\p{L}\\p{N}])`, "iu").test(clause);
}

/**
 * The mentions of `text` about this track (see the module comment): those in a clause whose
 * subject is the track, else, with none, the mentions of the field the claim points at.
 */
export function mentionsAboutTrack(
  text: string,
  field: ClaimField | null | undefined,
  title?: string,
): { about: Mention[]; others: Mention[] } {
  const placed: Array<Placed<Mention>> = [
    ...tempoPlaced(text, field === "tempo"),
    ...keyPlaced(text, field === "key"),
  ].sort((a, b) => a.at - b.at);
  const subjects = clauses(text).filter(([start, end]) =>
    aboutThisTrack(text.slice(start, end), title),
  );
  const inSubject = (item: Placed<Mention>) =>
    subjects.some(([start, end]) => item.at >= start && item.at < end);
  const counted = subjects.length > 0 ? placed.filter(inSubject) : [];
  const about =
    counted.length > 0
      ? counted
      : field
        ? placed.filter((item) => item.mention.field === field)
        : [];
  return {
    about: about.map((item) => item.mention),
    others: placed.filter((item) => !about.includes(item)).map((item) => item.mention),
  };
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
 * The numeric check of one claim against the measurement (see the module comment), for the
 * track titled `title`. `n/a` when the text states no tempo or key about this track, or nothing
 * it states about it was measured; then the reason says what was not compared, or is null when
 * nothing was stated.
 */
export function checkNumbers(
  claim: Pick<Claim, "text"> & { field?: ClaimField | null },
  audio: AudioFeatures | null | undefined,
  title?: string,
): NumericOutcome {
  const { about, others } = mentionsAboutTrack(claim.text, claim.field, title);
  if (about.length === 0) {
    if (others.length === 0) return NOT_COMPARED;
    return {
      ...NOT_COMPARED,
      numericReason:
        "Not compared: the tempo or key it states is another record's, not this track's.",
    };
  }
  const measured = measuredAudio(audio) ? audio : null;
  let worst: NumericOutcome = NOT_COMPARED;
  for (const mention of about) {
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
  const fields = [...new Set(about.map((mention) => mention.field))].join(" and ");
  return {
    ...NOT_COMPARED,
    numericReason: `Not compared: the preview's ${fields} was not measured.`,
  };
}
