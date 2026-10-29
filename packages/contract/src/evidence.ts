/**
 * The evidence model: what the app may show as measured, sourced or
 * inferred.
 *
 * - `Evidence` is a record taken from a source's raw payload (an API response or fetched page
 *   text), never model-written text.
 * - `Claim` is one statement shown to the user, with its kind, the evidence it cites, the
 *   verifier's verdict and, separately, the deterministic numeric check.
 * - `Measured` is one value measured from the audio, ready to display with its method and basis.
 */

import { z } from "zod";
import { SourceId, Timestamp, UnitInterval } from "./common.js";
import { tolerantList } from "./tolerant.js";

// =============================================================================
// Evidence
// =============================================================================

/**
 * How authoritative a piece of evidence is. `primary-record` is a structured record from a
 * music database (MusicBrainz, Discogs, SecondHandSongs, the Genius API, ListenBrainz,
 * Last.fm); `editorial` is a published article or review; `web` is any other page.
 */
export const SourceTier = z.enum(["primary-record", "editorial", "web"]);
export type SourceTier = z.infer<typeof SourceTier>;

/** Longest excerpt an Evidence item may carry (checked by `evidenceIssues`). */
export const EVIDENCE_EXCERPT_MAX = 500;

/**
 * Producers check each item with `evidenceIssues()`: a url or a recordRef, and an excerpt of at
 * most EVIDENCE_EXCERPT_MAX characters, and no web search result as a primary record. A
 * cross-reference violation or an unknown value never rejects a result: readers accept items
 * that break those rules, and drop items with a value they do not know.
 */
export const Evidence = z.object({
  id: z.string().min(1),
  source: SourceId,
  sourceTier: SourceTier,
  url: z.string().nullable(),
  title: z.string(),
  retrievedAt: Timestamp,
  excerpt: z.string(),
  /**
   * For a primary record, its first path segment is its scope: what the item states a fact
   * about. `track/` the matched recording (e.g. `track/recording/<mbid>`), `release/` a whole
   * release the track is on (e.g. a release-wide Discogs credit), `work/` the song, not this
   * recording (e.g. another artist's cover of it). A claim about the recording must not rest
   * on a `work/` or `release/` item alone: `scopeSupports()` says which items may support a
   * claim of a given scope (`ClaimScope`). The verifier is to apply it; until then it is a rule
   * of the composer's prompt, not checked by code. Web results have none (null). A relations
   * map record (`mapRecordKind`) has no scope: it supports no claim, only a code-built link
   * between two other recordings or another recording's year.
   */
  recordRef: z
    .string()
    .nullable()
    .describe(
      "Id of the record at the source, e.g. a MusicBrainz MBID or a Discogs release id. A " +
        "primary record's starts with its scope: track/ (this recording), release/ (a whole " +
        "release the track is on) or work/ (the song, not this recording). A MusicBrainz " +
        "relations map record has none: recording/<a>/samples|sampled-by/recording/<b> (a " +
        "relationship between two other recordings) or recording/<mbid> (another recording " +
        "and its first release date); it supports no claim",
    ),
});

const MBID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/**
 * The recordRef of a relations map record of a relationship between two recordings other than
 * the analysed one: `recording/<a>/samples|sampled-by/recording/<b>`, read from <a>'s side.
 */
export const MAP_RELATION_REF = new RegExp(
  `^recording/(${MBID})/(samples|sampled-by)/recording/(${MBID})$`,
);

/** The recordRef of a relations map record of another recording's first release date. */
export const MAP_DATE_REF = new RegExp(`^recording/(${MBID})$`);

/**
 * What a MusicBrainz relations map record is about, by its recordRef: "relation" (two other
 * recordings), "date" (another recording's first release date), or null for any other record.
 */
export function mapRecordKind(recordRef: string | null | undefined): "relation" | "date" | null {
  if (typeof recordRef !== "string") return null;
  if (MAP_RELATION_REF.test(recordRef)) return "relation";
  return MAP_DATE_REF.test(recordRef) ? "date" : null;
}
export type Evidence = z.infer<typeof Evidence>;

/** A source that could not be read during a run; the UI shows it as "source unavailable". */
export const SourceError = z.object({
  source: SourceId,
  code: z.enum(["not_configured", "unavailable", "timeout", "rate_limited", "invalid_response"]),
  message: z.string().optional(),
});
export type SourceError = z.infer<typeof SourceError>;

// =============================================================================
// Claims
// =============================================================================

/**
 * measured: computed from the audio by our code; sourced: cites evidence the verifier found
 * `supported` or `partial`; inferred: anything else the model wrote.
 */
export const ClaimKind = z.enum(["measured", "sourced", "inferred"]);
export type ClaimKind = z.infer<typeof ClaimKind>;

/** What a claim is about. */
export const ClaimAbout = z.enum([
  "track",
  "credit",
  "sample",
  "cover",
  "history",
  "sound",
  "production",
  "connection",
  "trivia",
]);
export type ClaimAbout = z.infer<typeof ClaimAbout>;

/** The judge's verdict on a claim against its cited excerpts ("supported by", not "true"). */
export const Verdict = z.enum(["supported", "partial", "unsupported", "contradicted"]);
export type Verdict = z.infer<typeof Verdict>;

/**
 * The deterministic check of a claim's numbers against the measured audio, kept apart
 * from the judge's verdict and never overwriting it. `conflict` is a mismatch that a known
 * estimator error explains (tempo x0.5, x2, x2/3, x1.5 or within 4 %; relative, parallel or
 * fifth-related key), or one where the measurement's confidence is below the gating threshold;
 * the UI shows both values. `n/a`: the claim has no number to check.
 */
export const NumericCheck = z.enum(["consistent", "conflict", "contradicted", "n/a"]);
export type NumericCheck = z.infer<typeof NumericCheck>;

/** Who wrote a claim: code from a source record (supported by construction) or the model. */
export const ClaimOrigin = z.enum(["code", "model"]);
export type ClaimOrigin = z.infer<typeof ClaimOrigin>;

/**
 * What a claim states a fact about, matching the scope of the primary records that may support
 * it (`Evidence.recordRef`): `recording` this recording (`track/` records), `work` the song
 * whatever the recording, such as its writers or another artist's cover (`work/` records),
 * `release` a whole release the track is on, such as an album credit or the album it appears
 * on (`release/` records). See `scopeSupports()`.
 */
export const ClaimScope = z.enum(["recording", "work", "release"]);
export type ClaimScope = z.infer<typeof ClaimScope>;

/** The fields a claim can point at for the numeric and key checks. */
export const ClaimField = z.enum(["tempo", "key"]);
export type ClaimField = z.infer<typeof ClaimField>;

export const FactoidType = z.enum([
  "production",
  "trivia",
  "credits",
  "sample",
  "curiosity",
  "connection",
]);
export type FactoidType = z.infer<typeof FactoidType>;

export const FactoidEntityType = z.enum([
  "synth",
  "producer",
  "sample",
  "technique",
  "artist",
  "album",
  "year",
]);
export type FactoidEntityType = z.infer<typeof FactoidEntityType>;

/** How a claim is shown when it is a factoid card. */
export const FactoidPresentation = z.object({
  title: z.string(),
  type: FactoidType,
  entities: tolerantList(z.object({ text: z.string(), type: FactoidEntityType })),
});

/** The two values the numeric check compared, for the "conflict" display. */
export const NumericComparison = z.object({
  claimed: z.union([z.number(), z.string()]).describe("The value the claim states"),
  measured: z.union([z.number(), z.string()]).describe("The measured value"),
  method: z.string().describe("How it was measured, e.g. 'essentia.RhythmExtractor2013'"),
});

/**
 * One statement shown to the user. A cross-reference violation or an unknown value never
 * rejects a result: readers accept every claim they can read and decide how to show it with
 * `claimDisplayKind()`: a sourced claim citing evidence that is not in the pack, or a model
 * claim the judge did not support, reads as model inference. A code-built claim is supported
 * by construction: a verdict of `unsupported` or `partial` does not change its kind, and the
 * verdict is kept for the record. A contradicted claim (a `contradicted` verdict or numeric
 * check, `claimIsRejected()`) is shown only in the rejected panel, whatever its kind and
 * whoever wrote it; it stays in the result so readers can say why it was rejected. Producers
 * check claims with `claimIssues()`.
 */
export const Claim = z.object({
  id: z.string().min(1),
  text: z.string(),
  about: ClaimAbout,
  kind: ClaimKind,
  origin: ClaimOrigin,
  evidenceIds: z.array(z.string()),
  verdict: Verdict.nullable().describe("null: not judged (e.g. beyond the 20-claim judge batch)"),
  verdictReason: z.string().nullable().describe("Why the judge gave its verdict"),
  numericCheck: NumericCheck,
  numericReason: z
    .string()
    .nullable()
    .optional()
    .describe("Why the numeric check gave its result; separate from the judge's reason"),
  numericComparison: NumericComparison.nullable().optional(),
  field: ClaimField.optional(),
  // Tolerant: a scope this reader does not know reads as none (a claim about this recording,
  // the narrowest), so a newer producer's value never makes the claim unreadable.
  scope: ClaimScope.optional()
    .catch(undefined)
    .describe(
      "What the claim states a fact about: this recording, the song (work) or a whole release; " +
        "absent on older claims",
    ),
  factoid: FactoidPresentation.optional(),
  // Tolerant: a mark this reader cannot read reads as none (the relation is then named as the
  // claim's own verdict allows), so a newer producer's value never makes the claim unreadable.
  documentedBy: z
    .array(z.string())
    .optional()
    .catch(undefined)
    .describe(
      "On a model claim about a sample or a cover: the code-built claims, each on a record it " +
        "cites, whose relation it states, in the record's direction. Readers name its relation " +
        "as theirs; its own kind and verdict are unchanged. Absent: no record documents it",
    ),
});
export type Claim = z.infer<typeof Claim>;

// =============================================================================
// Measured values
// =============================================================================

/** signal: DSP (tempo, key, loudness); model: a classifier or regression score. */
export const MeasuredBasis = z.enum(["signal", "model"]);
export type MeasuredBasis = z.infer<typeof MeasuredBasis>;

/** One measured value as the UI shows it: value, unit, confidence, method and basis. */
export const Measured = z.object({
  field: z.string().min(1).describe("e.g. 'tempo', 'key', 'loudness', 'style:Synth-pop'"),
  value: z.union([z.number(), z.string()]),
  unit: z.string().nullable().describe("e.g. 'bpm'; null for unitless values such as a key"),
  confidence: UnitInterval.nullable(),
  method: z.object({
    algorithm: z.string().min(1).describe("Estimator, or the model id when basis is 'model'"),
    analyzerVersion: z.string().min(1),
  }),
  window: z.literal("preview-30s"),
  basis: MeasuredBasis,
});
export type Measured = z.infer<typeof Measured>;
