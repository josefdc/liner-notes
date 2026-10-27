/**
 * The numeric check: the tempo and the key a claim's text states, compared with the measured
 * audio. Pure: no model call, no I/O. Its result goes to the claim's `numericCheck` (with
 * `numericReason` and `numericComparison`) and never touches the judge's verdict.
 *
 * What is read. Every tempo written with its unit ("120 BPM", "96.5 beats per minute", "120
 * beats-per-minute") or after it ("BPM: 120", "BPM of 120"), a range ("100-110 BPM", "between
 * 110 and 125 BPM"), and, when the claim points at the tempo (`field`), a number after "tempo"
 * ("a tempo of 120"). Every key written with its mode ("F# minor", "B-flat major", "Bb maj",
 * "E minor vamp"), in shorthand for minor ("Am", "F#m") or after "key of" ("in the key of Bb",
 * "the key of a minor"). A key on the tonic A without an accidental is taken only where it
 * cannot be ordinary English: the claim points at the key (`field`), its text says "key", or "in"
 * comes right before it ("written in A minor"); "A minor hit" and "I Am" are not keys.
 *
 * Whose tempo or key. Within its sentence (or its part after a ";"), a mention belongs to the
 * nearest record named before it:
 * - another record: a title or artist credit of another record in the result (`others`: the
 *   genealogy's other nodes, a factoid's sample and album entities), or a word that points at
 *   one ("the original", "originally", "the break", "the sample", "samples", "interpolates", "a
 *   cover of"). Such a mention is not compared (`n/a`): "The 1972 break ran at 90 BPM", "Unlike
 *   the original in F# major", "the TAPS track DAFT runs at 140 BPM". A name that overlaps this
 *   track's own title or artist credit word for word, either way ("DAFT" and "Daft Punk", "One
 *   More Time (TeeVex remix)" and "One More Time"), names another record only where it is
 *   quoted ("DAFT") or given with its artist ("DAFT by TAPS"): bare, it may be this track's;
 * - this track: "this track", "the song", "the record", "the single", "the recording", "It" at
 *   the start of the clause or after a comma, or the track's title at the start of a clause
 *   (Spotify's suffixes such as "- Remastered 2011" taken off). It is compared;
 * - nothing named before it: it is compared too ("Vanilla Ice raps over a groove in F# major").
 *
 * When a mention may be contradicted. A comparison can always say `consistent` or `conflict`
 * (both values shown, nothing hidden). It says `contradicted` (the claim leaves the main view)
 * only for a mention of the block the claim itself points at (`field`, set by the model when the
 * claim gives the track's own value), or, for a claim that restates a measured value and cites
 * nothing (`restatement`, decided by the caller), a mention this track is named before. And never
 * when another value the claim gives for this track agrees with the measurement. A sample-history
 * card that misreads whose number it is can therefore at worst show both values.
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
 * A claim with several compared mentions takes the worst result (contradicted, then conflict,
 * then consistent), within the limits above, and its comparison is that mention's. A claim
 * with no compared mention is `n/a`.
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
  /** The top of a stated range ("100-110 BPM"); `bpm` is its bottom. */
  high?: number;
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
// The dash carries the whitespace after it, so a long run of whitespace is read once (the same
// matches as `\s*-?\s*`); likewise in UNIT, TEMPO_UNIT_BEFORE and TEMPO_WORD.
const TEMPO_UNIT_AFTER = new RegExp(
  String.raw`${NOT_IN_NUMBER}${NUMBER}\s*(?:-\s*)?(?:bpm\b|b\.p\.m\.|beats[\s-]+(?:per|a|each)[\s-]+minute\b)`,
  "giu",
);
// The unit then its number: "BPM: 246", "BPM of 246", "bpm 120".
const TEMPO_UNIT_BEFORE = new RegExp(
  String.raw`\b(?:bpm|b\.p\.m\.)\s*(?:(?::|=|of|is|was|at)\s*)?${NUMBER}(?![\p{N}%])`,
  "giu",
);
const UNIT = String.raw`\s*(?:-\s*)?(?:bpm\b|b\.p\.m\.|beats[\s-]+(?:per|a|each)[\s-]+minute\b)`;
// A range then its unit: "100-110 BPM", "100–110 BPM", "100 to 110 BPM", "between 110 and 125 BPM".
const TEMPO_RANGE = new RegExp(
  String.raw`(?:\bbetween\s+)?${NOT_IN_NUMBER}${NUMBER}\s*(?:-|–|—|to|and)\s*${NUMBER}${UNIT}`,
  "giu",
);
// "a tempo of 246", "tempo: 246": read only when the claim points at the tempo.
const TEMPO_WORD = new RegExp(
  String.raw`\btempo\s*(?:(?::|=|of|is|was|at|around|about)\s*)?(?:(?:about|around|roughly|approximately|~)\s*)?${NUMBER}(?![\p{N}%])`,
  "giu",
);

/**
 * New copies of the tempo expressions, for tests. They are global, so a `.test()` or `.exec()`
 * leaves `lastIndex` set, and `matchAll` would start there: the module's own are never shared.
 */
export function tempoExpressions(): Record<"unitAfter" | "unitBefore" | "range" | "word", RegExp> {
  return {
    unitAfter: new RegExp(TEMPO_UNIT_AFTER),
    unitBefore: new RegExp(TEMPO_UNIT_BEFORE),
    range: new RegExp(TEMPO_RANGE),
    word: new RegExp(TEMPO_WORD),
  };
}

/** A mention and where it stands in the text. */
interface Placed<M> {
  at: number;
  end: number;
  mention: M;
}

function tempoPlaced(text: string, pointsAtTempo: boolean): Array<Placed<TempoMention>> {
  const found: Array<Placed<TempoMention>> = [];
  const inRange = (bpm: number) => Number.isFinite(bpm) && bpm >= TEMPO_MIN && bpm <= TEMPO_MAX;
  for (const match of text.matchAll(TEMPO_RANGE)) {
    const [low, high] = [match[1], match[2]].map((value) => Number(value.replace(",", ".")));
    // "and" joins a range only after "between".
    if (/\band\b/i.test(match[0]) && !/^between/i.test(match[0])) continue;
    if (!inRange(low) || !inRange(high) || high <= low) continue;
    const at = match.index ?? 0;
    found.push({ at, end: at + match[0].length, mention: { field: "tempo", bpm: low, high } });
  }
  const patterns = pointsAtTempo
    ? [TEMPO_UNIT_AFTER, TEMPO_UNIT_BEFORE, TEMPO_WORD]
    : [TEMPO_UNIT_AFTER, TEMPO_UNIT_BEFORE];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const at = match.index ?? 0;
      const end = at + match[0].length;
      if (found.some((other) => at < other.end && end > other.at)) continue;
      const bpm = Number(match[1].replace(",", "."));
      if (inRange(bpm)) found.push({ at, end, mention: { field: "tempo", bpm } });
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

// Where a mention's record is looked for: its sentence, or its part after a ";".
const PART_BREAK = /[.!?;](?=\s|$)/gu;
// Words that name this track as the subject.
const THIS_TRACK = /\b(?:this|the)\s+(?:track|song|recording|record|single|tune)\b/giu;
const IT = /(?:^|[,.;!?])\s*(?:it|its|it['’]s)\b/giu;
// Words that point at another record.
const OTHER_RECORD =
  /\b(?:the\s+original|originally|original\s+version|(?:the|its|that)\s+(?:break|breakbeat|sample|loop it samples)|break|sampl(?:e|es|ed|ing)|interpolat(?:es|ed|ing)|a\s+cover\s+of|covered)\b/giu;
// Spotify's suffixes on a title: "- Remastered 2011", "- Radio Edit", " (Remastered)".
const TITLE_SUFFIX =
  /\s+(?:-\s+[^-]*(?:remaster|edit|version|mix|live|mono|stereo|feat\.?|single|demo|acoustic|bonus|instrumental|\d{4})[^-]*|\((?:[^)]*)(?:remaster|edit|version|mix|live|mono|stereo|feat\.?|demo|acoustic|bonus|instrumental|\d{4})[^)]*\))\s*$/iu;

/** A title without the suffixes Spotify adds to it ("Under Pressure - Remastered 2011"). */
export function bareTitle(title: string): string {
  let bare = title.trim();
  for (let i = 0; i < 3 && TITLE_SUFFIX.test(bare); i++)
    bare = bare.replace(TITLE_SUFFIX, "").trim();
  return bare;
}

const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const phrase = (name: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escaped(name)}(?![\\p{L}\\p{N}])`, "giu");

/** Who a mention is about: this track, another record, or nobody named before it. */
export type Attribution = "track" | "other" | "unsaid";

/** What the check knows about the claim's records. */
export interface NumericContext {
  /** The analysed track's title (Spotify's; its suffixes are taken off). */
  title?: string;
  /** The analysed track's artist credit (Spotify's). */
  artist?: string;
  /**
   * Other records the result names (genealogy nodes, a card's sample entities): a title, or a
   * title with its artist credit.
   */
  others?: readonly (string | OtherRecord)[];
  /**
   * The claim restates a measured value as its own statement and cites nothing: a mention this
   * track is named before may then be contradicted, as with a `field` the model set.
   */
  restatement?: boolean;
}

/** Another record the result names, with its artist credit when known. */
export interface OtherRecord {
  title: string;
  artist?: string | null;
}

/** A name's words, case and width folded: "DAFT" and "Daft Punk" give ["daft"], ["daft", "punk"]. */
const wordsOf = (name: string) =>
  name
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** True when every word of one name is a word of the other (either way). */
function overlaps(a: string, b: string): boolean {
  const [left, right] = [wordsOf(a), wordsOf(b)];
  if (left.length === 0 || right.length === 0) return false;
  return left.every((w) => right.includes(w)) || right.every((w) => left.includes(w));
}

/** The name in quotes: "DAFT", “DAFT”, 'DAFT'. */
const quotedPhrase = (name: string) => new RegExp(`["“”'‘’]${escaped(name)}["“”'‘’]`, "giu");

/** Where each record is named in `text`, and as what. */
function markers(text: string, context: NumericContext): Array<{ at: number; who: Attribution }> {
  const found: Array<{ at: number; who: Attribution }> = [];
  for (const match of text.matchAll(THIS_TRACK)) found.push({ at: match.index ?? 0, who: "track" });
  for (const match of text.matchAll(IT)) found.push({ at: match.index ?? 0, who: "track" });
  for (const match of text.matchAll(OTHER_RECORD))
    found.push({ at: match.index ?? 0, who: "other" });
  const title = context.title ? bareTitle(context.title) : "";
  if (title.length >= 2) {
    for (const match of text.matchAll(phrase(title))) {
      const at = match.index ?? 0;
      // The title is the subject only at the start of a sentence or part, never as an object.
      if (/(?:^|[.!?;])\s*$/u.test(text.slice(0, at))) found.push({ at, who: "track" });
    }
  }
  const own = [title, context.artist ?? ""].filter((name) => name.length > 0);
  const ownName = (name: string) => own.some((mine) => overlaps(name, mine));
  const other = (pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) found.push({ at: match.index ?? 0, who: "other" });
  };
  for (const record of context.others ?? []) {
    const { title: otherTitle, artist = null } =
      typeof record === "string" ? { title: record } : record;
    const name = bareTitle(otherTitle);
    const credit = artist?.trim() ?? "";
    if (name.length >= 3 && name.toLowerCase() !== title.toLowerCase()) {
      // A bare name this track's own title or credit could be read as is not taken.
      if (!ownName(name)) other(phrase(name));
      other(quotedPhrase(name));
      if (credit) other(phrase(`${name} by ${credit}`));
    }
    if (credit.length >= 3 && !ownName(credit)) other(phrase(credit));
  }
  return found.sort((a, b) => a.at - b.at);
}

/**
 * Every mention of `text` with whom it is about (see the module comment): the record named
 * nearest before it within its sentence or part.
 */
export function attributedMentions(
  text: string,
  field: ClaimField | null | undefined,
  context: NumericContext = {},
): Array<{ mention: Mention; who: Attribution }> {
  const placed: Array<Placed<Mention>> = [
    ...tempoPlaced(text, field === "tempo"),
    ...keyPlaced(text, field === "key"),
  ].sort((a, b) => a.at - b.at);
  const named = markers(text, context);
  const partStart = (at: number) => {
    let start = 0;
    for (const match of text.matchAll(PART_BREAK)) {
      const end = (match.index ?? 0) + 1;
      if (end <= at) start = end;
    }
    return start;
  };
  return placed.map((item) => {
    const start = partStart(item.at);
    const before = named.filter((marker) => marker.at >= start && marker.at < item.at);
    return { mention: item.mention, who: before.at(-1)?.who ?? "unsaid" };
  });
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

/** A difference the claim is not marked as stating about this track: both values are shown. */
const UNMARKED =
  ". They differ; the statement is not marked as giving this track's own value, so both are shown.";

/** The tolerance band around a measured tempo. */
const tempoBand = (measured: number) => Math.max(TEMPO_BAND_BPM, TEMPO_BAND_SHARE * measured);

function compareTempo(
  mention: TempoMention,
  tempo: NonNullable<AudioFeatures["tempo"]>,
  canContradict: boolean,
) {
  const measured = tempo.bpm;
  const band = tempoBand(measured);
  const ranged = mention.high !== undefined;
  const stated = ranged
    ? `${round1(mention.bpm)}-${round1(mention.high!)} BPM`
    : bpmText(mention.bpm);
  // A range agrees when the measurement falls inside it; otherwise its nearer end is compared.
  const claimed = ranged && measured > mention.high! ? mention.high! : mention.bpm;
  const lead = `States ${stated}; the preview measured ${bpmText(measured)} (${tempo.method})`;
  const comparison = {
    claimed: ranged ? `${round1(mention.bpm)}-${round1(mention.high!)}` : mention.bpm,
    measured: round1(measured),
    method: tempo.method,
  };
  const difference =
    ranged && measured >= mention.bpm - band && measured <= mention.high! + band
      ? 0
      : Math.abs(claimed - measured);
  const outcome = (numericCheck: NumericCheck, why: string) => ({
    numericCheck,
    numericReason: `${lead}${why}`,
    numericComparison: comparison,
    field: "tempo" as const,
  });
  if (difference <= band) {
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
  if (!canContradict) return outcome("conflict", UNMARKED);
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

function compareKey(
  mention: KeyMention,
  key: NonNullable<AudioFeatures["key"]>,
  canContradict: boolean,
) {
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
  if (!canContradict) return outcome("conflict", UNMARKED);
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
 * The numeric check of one claim against the measurement (see the module comment). `claim.field`
 * is the field the claim itself points at (the model's, never one this check filled in).
 * `n/a` when the text states no tempo or key that is compared, or nothing compared was
 * measured; then the reason says what was not compared, or is null when nothing was stated.
 */
export function checkNumbers(
  claim: Pick<Claim, "text"> & { field?: ClaimField | null },
  audio: AudioFeatures | null | undefined,
  context: NumericContext = {},
): NumericOutcome {
  const mentions = attributedMentions(claim.text, claim.field, context);
  const compared = mentions.filter((item) => item.who !== "other");
  if (compared.length === 0) {
    if (mentions.length === 0) return NOT_COMPARED;
    return {
      ...NOT_COMPARED,
      numericReason:
        "Not compared: the tempo or key it states is another record's, not this track's.",
    };
  }
  const measured = measuredAudio(audio) ? audio : null;
  const results: NumericOutcome[] = [];
  for (const { mention, who } of compared) {
    const canContradict =
      claim.field === mention.field || (context.restatement === true && who === "track");
    const result =
      mention.field === "tempo"
        ? measured?.tempo
          ? compareTempo(mention, measured.tempo, canContradict)
          : null
        : measured?.key
          ? compareKey(mention, measured.key, canContradict)
          : null;
    if (result) results.push(result);
  }
  let worst: NumericOutcome = NOT_COMPARED;
  for (const result of results) {
    if (RANK[result.numericCheck] > RANK[worst.numericCheck]) worst = result;
  }
  // A claim that also gives a value agreeing with the measurement is never rejected for another.
  if (
    worst.numericCheck === "contradicted" &&
    results.some((r) => r.numericCheck === "consistent")
  ) {
    worst = {
      ...worst,
      numericCheck: "conflict",
      numericReason: `${worst.numericReason?.replace(/\. The measurement is confident.*$/, "") ?? ""}. Another value it gives agrees with the measurement, so both are shown.`,
    };
  }
  if (worst.numericCheck !== "n/a") return worst;
  const fields = [...new Set(compared.map((item) => item.mention.field))].join(" and ");
  return {
    ...NOT_COMPARED,
    numericReason: `Not compared: the preview's ${fields} was not measured.`,
  };
}
