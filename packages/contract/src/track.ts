/**
 * TrackAnalysis v1: the result of one analysis, as the API sends it and the web app reads it.
 *
 * It keeps every field the web app reads today (the API's former `TrackData`) and adds
 * `audio`, `evidence`, `claims` and `run`. The added fields are optional: payloads written
 * before the evidence pipeline do not carry them, and a reader treats them as missing.
 *
 * Honest data: `bpm`, `key`, `energy`, `valence`, `danceability`, `acousticness` and
 * `keyMoments` are copies of the audio measurement made by code (null when not measured);
 * `audio` holds the measurement itself. No model output can set them (see llm.ts).
 *
 * Unknown fields are stripped on parse, so a reader keeps working when fields are added.
 */

import { z } from "zod/v4";
import { AudioFeatures, KeyMoment } from "./audio.js";
import { Timestamp, UnitInterval } from "./common.js";
import {
  Claim,
  ClaimKind,
  Evidence,
  FactoidEntityType,
  FactoidType,
  SourceError,
} from "./evidence.js";

/** The `version` of TrackAnalysis this module describes. */
export const TRACK_ANALYSIS_VERSION = 1;

/** Most factoids a result carries; there is no minimum (fewer is the honest result). */
export const FACTOID_LIMITS = { min: 0, max: 8 } as const;

// =============================================================================
// Parts of the v1 payload
// =============================================================================

/**
 * A section of the song, in percent of its duration. The colour is a presentation hint only:
 * the web colours sections from its design tokens and no model-facing schema has a colour
 * field, so the prompt and the schema can no longer disagree on it (the bridge was #6B21A8 in
 * one and #FFB000 in the other).
 */
export const SongSegment = z.object({
  label: z.string(),
  start: z.number().min(0).max(100),
  end: z.number().min(0).max(100),
  color: z.string().optional(),
});
export type SongSegment = z.infer<typeof SongSegment>;

/**
 * A sample used in the track. `time` is where it appears, in seconds; it is null when unknown,
 * which is always the case for a sample found in a source record.
 */
export const Sample = z.object({
  time: z.number().min(0).nullable(),
  description: z.string(),
  claimId: z.string().optional(),
});
export type Sample = z.infer<typeof Sample>;

export const FactoidEntity = z.object({
  id: z.string(),
  text: z.string(),
  type: FactoidEntityType,
  searchQuery: z.string().optional(),
});
export type FactoidEntity = z.infer<typeof FactoidEntity>;

/** A factoid card. In the evidence pipeline each one is also a Claim, linked by `claimId`. */
export const Factoid = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
  type: FactoidType,
  entities: z.array(FactoidEntity).optional(),
  claimId: z.string().optional(),
});
export type Factoid = z.infer<typeof Factoid>;

export const ProductionCredits = z.object({
  producers: z.array(z.string()),
  writers: z.array(z.string()),
  engineers: z.array(z.string()).optional(),
  label: z.string().optional(),
});
export type ProductionCredits = z.infer<typeof ProductionCredits>;

export const GenealogyNode = z.object({
  id: z.string(),
  group: z.number().describe("1 = this track, 2 = it samples, 3 = sampled by, 4 = influence"),
  label: z.string(),
  img: z.string().optional(),
  size: z.number(),
  previewUrl: z.string().optional(),
  spotifyId: z.string().optional(),
  trackTitle: z.string().optional(),
  trackArtist: z.string().optional(),
});
export type GenealogyNode = z.infer<typeof GenealogyNode>;

/** How two tracks are related; the composer must always name it (see ComposerOutput). */
export const LinkType = z.enum([
  "sample",
  "interpolation",
  "cover",
  "remix",
  "producer",
  "influence",
]);
export type LinkType = z.infer<typeof LinkType>;

/**
 * A relation between two genealogy nodes. A link may name a node that is not in the graph
 * (older results do): readers drop such links instead of failing.
 */
export const GenealogyLink = z.object({
  source: z.string(),
  target: z.string(),
  value: z.number().describe("Strength 1-3: 1 = weak influence, 3 = direct sample"),
  type: LinkType.optional(),
  kind: ClaimKind.optional().describe("A sample link without evidence is an inferred influence"),
  evidenceIds: z.array(z.string()).optional(),
});
export type GenealogyLink = z.infer<typeof GenealogyLink>;

export const Genealogy = z.object({
  nodes: z.array(GenealogyNode).default([]),
  links: z.array(GenealogyLink).default([]),
});

/** One axis of the genre radar. Written by the model in v1 payloads: a model inference. */
export const GenreProfileItem = z.object({
  genre: z.string(),
  value: z.number().min(0).max(100),
});

/**
 * Why measured audio values are missing. `low_confidence`: measured, but below the confidence
 * the UI requires to show a value.
 */
export const AudioUnavailableReason = z.enum([
  "no_preview",
  "preview_rejected",
  "service_unavailable",
  "analysis_failed",
  "not_detected",
  "not_run",
  "low_confidence",
]);
export type AudioUnavailableReason = z.infer<typeof AudioUnavailableReason>;

/** Why the language model was unavailable, as a category (never the provider's text). */
export const ModelUnavailableReason = z.enum([
  "no_output",
  "rate_limited",
  "timeout",
  "auth",
  "error",
  "budget_exhausted",
]);
export type ModelUnavailableReason = z.infer<typeof ModelUnavailableReason>;

/** Where the analysed preview came from and how the track was matched to it. */
export const PreviewMatch = z.object({
  provider: z.enum(["deezer", "spotify"]),
  method: z.enum(["isrc", "search"]),
  score: UnitInterval.nullable().describe("Match score of a search match; null for ISRC"),
});

// =============================================================================
// Run information
// =============================================================================

/** The states of a run record (the API's `runs` table). */
export const RunStatus = z.enum(["running", "interrupted", "completed", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof RunStatus>;

/** live: computed for this request; replay: a recorded run served again. */
export const RunMode = z.enum(["live", "replay"]);
export type RunMode = z.infer<typeof RunMode>;

/** Language model use of a run, from the API's usage records. */
export const RunUsage = z.object({
  llmCalls: z.int().min(0),
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  reasoningTokens: z.int().min(0),
  usd: z.number().min(0).describe("Cost at the configured price table"),
});
export type RunUsage = z.infer<typeof RunUsage>;

/** What the verifier did in a run: claims judged, and claims left without a verdict. */
export const VerifierSummary = z.object({
  judged: z.int().min(0),
  unjudged: z.int().min(0).describe("Claims beyond the judge batch; shown as inferred"),
});

/**
 * The run that produced a result. A replayed run always says when it was recorded, from which
 * commit and with which analyzer, so it is never presented as live.
 */
export const RunInfo = z
  .object({
    id: z.string().min(1),
    mode: RunMode,
    recordedAt: Timestamp.nullable().describe("When the run was recorded; null for live runs"),
    commit: z.string().nullable().describe("Commit of the code that recorded the run"),
    analyzerVersion: z.string().nullable().describe("AudioFeatures analyzerVersion; null if none"),
    startedAt: Timestamp.optional(),
    durationMs: z.int().min(0).nullable().optional(),
    fallback: z
      .boolean()
      .optional()
      .describe("True when the composer failed and the result was built from source data only"),
    usage: RunUsage.nullable().optional(),
    verifier: VerifierSummary.nullable().optional(),
    sourceErrors: z.array(SourceError).optional(),
  })
  .superRefine((run, ctx) => {
    if (run.mode !== "replay") return;
    for (const field of ["recordedAt", "commit"] as const) {
      if (run[field] === null) {
        ctx.addIssue({ code: "custom", path: [field], message: "a replayed run must say this" });
      }
    }
  });
export type RunInfo = z.infer<typeof RunInfo>;

// =============================================================================
// TrackAnalysis
// =============================================================================

export const TrackAnalysis = z
  .object({
    // Track metadata (from Spotify)
    id: z.string().describe("Spotify track id"),
    title: z.string(),
    artist: z.string(),
    album: z.string(),
    coverUrl: z.string().describe("Album cover URL; empty when unknown"),
    spotifyUrl: z.string().optional(),
    previewUrl: z.string().optional(),
    releaseYear: z.string().optional(),
    explicit: z.boolean().optional(),
    durationSeconds: z.number().min(0).optional(),
    isrc: z.string().nullable().optional(),

    // Copies of the audio measurement, null when not measured (never filled in)
    bpm: z.number().nullable(),
    key: z.string().nullable().optional(),
    energy: z.number().nullable().optional(),
    valence: z.number().nullable().optional(),
    danceability: z.number().nullable().optional(),
    acousticness: z.number().nullable().optional(),
    keyMoments: z.array(KeyMoment).optional(),
    audioSource: z.enum(["analyzed", "unavailable"]).optional(),
    audioConfidence: z.enum(["high", "low"]).optional(),
    audioUnavailableReason: AudioUnavailableReason.optional(),

    // Structure, samples, credits and context. Lists missing from older payloads read as empty.
    segments: z.array(SongSegment).default([]),
    segmentsSource: z
      .enum(["template", "inferred", "measured"])
      .optional()
      .describe("template: a generic default; inferred: written by the model; measured: sections"),
    samples: z.array(Sample).default([]),
    credits: ProductionCredits.optional(),
    factoids: z.array(Factoid).max(FACTOID_LIMITS.max).default([]),
    genealogy: Genealogy,
    genreProfile: z.array(GenreProfileItem).optional(),

    // Model provenance
    modelUnavailable: z.boolean().optional(),
    modelUnavailableReason: ModelUnavailableReason.optional(),

    // Added in v1: the measurement, the evidence pack, the claims and the run
    audio: AudioFeatures.nullable().optional(),
    preview: PreviewMatch.nullable().optional(),
    evidence: z.array(Evidence).optional(),
    claims: z.array(Claim).optional(),
    run: RunInfo.optional(),
  })
  .superRefine((analysis, ctx) => {
    // A sourced claim cites evidence of this result's pack; a claim citing an
    // unknown id is inferred, never sourced.
    const known = new Set((analysis.evidence ?? []).map((evidence) => evidence.id));
    analysis.claims?.forEach((claim, index) => {
      if (claim.kind !== "sourced") return;
      for (const id of claim.evidenceIds) {
        if (!known.has(id)) {
          ctx.addIssue({
            code: "custom",
            path: ["claims", index, "evidenceIds"],
            message: `cites evidence "${id}", which is not in the evidence pack`,
          });
        }
      }
    });
  });
export type TrackAnalysis = z.infer<typeof TrackAnalysis>;
/** A TrackAnalysis as written, before parsing fills in missing lists. */
export type TrackAnalysisInput = z.input<typeof TrackAnalysis>;

// =============================================================================
// Search candidates
// =============================================================================

/**
 * A track offered in search suggestions and in the track picker. `popularity` is optional:
 * the API is moving off Spotify fields that not every app can read, so it may stop sending it.
 */
export const SearchCandidate = z.object({
  id: z.string(),
  title: z.string(),
  artist: z.string(),
  album: z.string(),
  coverUrl: z.string(),
  releaseYear: z.string().optional(),
  popularity: z.number().min(0).max(100).optional(),
  isrc: z.string().nullable().optional(),
});
export type SearchCandidate = z.infer<typeof SearchCandidate>;
