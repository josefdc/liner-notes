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

import { z } from "zod/v4";
import { SourceId, Timestamp, UnitInterval } from "./common.js";

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

/** Longest excerpt an Evidence item may carry. */
export const EVIDENCE_EXCERPT_MAX = 500;

export const Evidence = z
  .object({
    id: z.string().min(1),
    source: SourceId,
    sourceTier: SourceTier,
    url: z.string().nullable(),
    title: z.string(),
    retrievedAt: Timestamp,
    excerpt: z.string().max(EVIDENCE_EXCERPT_MAX),
    recordRef: z
      .string()
      .nullable()
      .describe("Id of the record at the source, e.g. a MusicBrainz MBID or a Discogs release id"),
  })
  .refine((evidence) => evidence.url !== null || evidence.recordRef !== null, {
    message: "evidence needs a url or a recordRef",
    path: ["url"],
  });
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
  entities: z.array(z.object({ text: z.string(), type: FactoidEntityType })),
});

export const Claim = z
  .object({
    id: z.string().min(1),
    text: z.string(),
    about: ClaimAbout,
    kind: ClaimKind,
    origin: ClaimOrigin,
    evidenceIds: z.array(z.string()),
    verdict: Verdict.nullable().describe("null: not judged (e.g. beyond the 20-claim judge batch)"),
    verdictReason: z.string().nullable().describe("The judge's or the deterministic step's reason"),
    numericCheck: NumericCheck,
    field: ClaimField.optional(),
    factoid: FactoidPresentation.optional(),
  })
  .superRefine((claim, ctx) => {
    // Measured comes only from code; sourced needs a citation that the
    // verifier found supported (or partly supported). Code-built claims from a source record
    // are supported by construction and carry the verdict "supported".
    if (claim.kind === "measured" && claim.origin !== "code") {
      ctx.addIssue({ code: "custom", path: ["origin"], message: "measured claims come from code" });
    }
    if (claim.kind === "sourced") {
      if (claim.evidenceIds.length === 0) {
        ctx.addIssue({ code: "custom", path: ["evidenceIds"], message: "sourced claims cite" });
      }
      if (claim.verdict !== "supported" && claim.verdict !== "partial") {
        ctx.addIssue({
          code: "custom",
          path: ["verdict"],
          message: "sourced claims need a supported or partial verdict",
        });
      }
    }
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
