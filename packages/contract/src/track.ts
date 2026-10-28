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
 * Readers are tolerant: a cross-reference violation or an unknown value never rejects a
 * result. Items of a list that this reader cannot read (an evidence item from a new source, a
 * claim with a new subject, a key moment or link of a new type) are dropped and not shown;
 * optional values it cannot read become absent, and a measurement it cannot read reads as not
 * measured (see tolerant.ts). Rules that relate parts of a result to each other (cited evidence is in the pack,
 * a gated measurement reports nothing, at most FACTOID_LIMITS.max factoids, replay metadata)
 * are checked by producers with `analysisIssues()` before a result is sent or stored.
 */

import { z } from "zod";
import { AudioFeatures, KeyMoment } from "./audio.js";
import { tolerantList } from "./tolerant.js";
import { Timestamp, UnitInterval } from "./common.js";
import {
  Claim,
  ClaimOrigin,
  Evidence,
  FactoidEntityType,
  FactoidType,
  SourceError,
} from "./evidence.js";

/** The `version` of TrackAnalysis this module describes. */
export const TRACK_ANALYSIS_VERSION = 1;

/**
 * Most factoids a result carries; there is no minimum (fewer is the honest result). Checked
 * by `analysisIssues()` and `composerOutputIssues()`.
 */
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
 * which is always the case for a sample found in a source record. No lower bound: older
 * payloads carry model-written times that may be negative.
 */
export const Sample = z.object({
  time: z.number().nullable(),
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
  entities: tolerantList(FactoidEntity).optional(),
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
  /**
   * The year the recording was first released, from MusicBrainz (its first release date), set
   * by code only; absent when MusicBrainz has no date for it. Never a model's year.
   */
  year: z.number().int().optional(),
  /** The MusicBrainz id of the recording (or work) the node was built from, set by code only. */
  mbid: z.string().optional(),
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

/** How a link is known: from evidence in the pack, or proposed by the model. Never measured. */
export const LinkKind = z.enum(["sourced", "inferred"]);
export type LinkKind = z.infer<typeof LinkKind>;

/**
 * A relation between two genealogy nodes, pointing from the earlier work to the later one:
 * `source` is the earlier record (the one sampled, interpolated, covered, remixed or that
 * influenced), `target` the record that uses it. A `producer` link has no direction. A link may
 * name a node that is not in the graph (older results do): readers drop such links instead of
 * failing.
 */
export const GenealogyLink = z.object({
  source: z
    .string()
    .describe(
      "Node id of the earlier work: the record that is sampled, interpolated, covered, remixed " +
        "or that influenced the target",
    ),
  target: z
    .string()
    .describe("Node id of the later work: the record that uses or follows the source"),
  value: z.number().describe("Strength 1-3: 1 = weak influence, 3 = direct sample"),
  type: LinkType.optional(),
  kind: LinkKind.optional().describe(
    "sourced only when every id it cites is in the pack and, for a model link or one that " +
      "states a claim, that claim is supported and states this relation; a sample link that is " +
      "not sourced is an inferred influence",
  ),
  origin: ClaimOrigin.optional().describe("code: from a source record; model: proposed by it"),
  claimId: z
    .string()
    .optional()
    .describe(
      "The claim that states this relation: it cites every id the link cites and is about the " +
        "link's type",
    ),
  evidenceIds: z.array(z.string()).optional(),
});
export type GenealogyLink = z.infer<typeof GenealogyLink>;

export const Genealogy = z.object({
  nodes: tolerantList(GenealogyNode).default([]),
  links: tolerantList(GenealogyLink).default([]),
});

/** One axis of the genre radar. Written by the model in v1 payloads: a model inference. */
export const GenreProfileItem = z.object({
  genre: z.string(),
  value: z.number().min(0).max(100),
});

/**
 * Why measured audio values are missing. `low_confidence`: measured, but below the confidence
 * the UI requires to show a value. `preview_lookup_incomplete`: the preview clip lookup could not
 * be finished (a request was not sent in time, or the source could not be read), so whether a
 * clip exists is unknown; `no_preview` says only that every request was answered without one.
 */
export const AudioUnavailableReason = z.enum([
  "no_preview",
  "preview_rejected",
  "service_unavailable",
  "analysis_failed",
  "not_detected",
  "not_run",
  "low_confidence",
  "preview_lookup_incomplete",
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

/**
 * Where the analysed preview came from and how the track was matched to it:
 * - `isrc`: the provider's entry for the track's ISRC;
 * - `id`: an entry read by its id: the provider's own clip of the chosen track (Spotify), or an
 *   entry the provider offers in place of the ISRC entry (Deezer), checked like a search match;
 * - `search`: a search result that strictly matches the track.
 */
export const PreviewMatch = z.object({
  provider: z.enum(["deezer", "spotify"]),
  method: z.enum(["isrc", "id", "search"]),
  score: UnitInterval.nullable().describe(
    "Match score of an id or search match; null for ISRC and for a provider's own clip",
  ),
});

/**
 * How the search text matched the analysed track, judged on its title and artists:
 * - `exact`: the text is the track's title, with or without its credited artists;
 * - `partial`: the title and the text share their words only in part;
 * - `artist`: only a credited artist is named; the title does not match;
 * - `none`: neither the title nor an artist matches: the track may not be the song searched for.
 */
export const QueryMatch = z.enum(["exact", "partial", "artist", "none"]);
export type QueryMatch = z.infer<typeof QueryMatch>;

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

/**
 * What the verifier did in a run: claims judged, and claims left without a verdict. `failed`
 * says the check itself did not complete: the judge call failed, ran out of time, or left some
 * of the claims it was sent without a verdict. Those claims read as not checked, not as checked
 * and found wanting. `restated` counts the claims left out because they state a fact another
 * claim of the result states.
 */
export const VerifierSummary = z.object({
  judged: z.int().min(0),
  unjudged: z
    .int()
    .min(0)
    .describe(
      "Claims that cite evidence and got no verdict (beyond the judge batch, too long, or the " +
        "check did not complete); shown as inferred",
    ),
  failed: z
    .boolean()
    .optional()
    .describe(
      "True when the judge call failed, ran out of time or left claims it was sent without a " +
        "verdict; absent on results from before it was sent",
    ),
  restated: z
    .int()
    .min(0)
    .optional()
    .describe(
      "Claims left out of the result because they restate another: a model claim stating what " +
        "a code-built claim states on the same record, or a second copy of one statement; absent " +
        "when none were left out, and on results from before they were counted",
    ),
});

/**
 * The run that produced a result. A replayed run always says when it was recorded, from which
 * commit and with which analyzer, so it is never presented as live; a live run carries no
 * recording metadata. Producers check this with `runIssues()`.
 */
export const RunInfo = z.object({
  id: z.string().min(1),
  mode: RunMode,
  recordedAt: Timestamp.nullable().describe("When the run was recorded; null for live runs"),
  commit: z
    .string()
    .nullable()
    .describe(
      "Commit of the code that recorded the run. A replay of model answers recorded at " +
        'several commits lists each one, in recording order, separated by ", "',
    ),
  analyzerVersion: z.string().nullable().describe("AudioFeatures analyzerVersion; null if none"),
  replayed: z
    .enum(["run", "model_answers"])
    .optional()
    .describe(
      "What a replay replayed: the whole recorded run, or only the model's answers (stored " +
        "answers, used in development and evaluation; the rest of the run was live). Absent on " +
        "live runs and on results from before it was sent",
    ),
  startedAt: Timestamp.optional(),
  durationMs: z.int().min(0).nullable().optional(),
  fallback: z
    .boolean()
    .optional()
    .describe("True when the composer failed and the result was built from source data only"),
  usage: RunUsage.nullable().optional().catch(null),
  verifier: VerifierSummary.nullable().optional().catch(null),
  sourceErrors: tolerantList(SourceError).optional(),
});
export type RunInfo = z.infer<typeof RunInfo>;

// =============================================================================
// TrackAnalysis
// =============================================================================

export const TrackAnalysis = z.object({
  contractVersion: z
    .int()
    .min(1)
    .optional()
    .describe(`TrackAnalysis version the producer wrote (${TRACK_ANALYSIS_VERSION})`),

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
  keyMoments: tolerantList(KeyMoment).optional(),
  audioSource: z.enum(["analyzed", "unavailable"]).optional().catch(undefined),
  audioConfidence: z.enum(["high", "low"]).optional().catch(undefined),
  audioUnavailableReason: AudioUnavailableReason.optional().catch(undefined),

  // Structure, samples, credits and context. Lists missing from older payloads read as empty.
  segments: tolerantList(SongSegment).default([]),
  segmentsSource: z
    .enum(["template", "inferred", "measured"])
    .optional()
    .catch(undefined)
    .describe("template: a generic default; inferred: written by the model; measured: sections"),
  samples: tolerantList(Sample).default([]),
  credits: ProductionCredits.optional(),
  factoids: tolerantList(Factoid).default([]),
  genealogy: Genealogy,
  genreProfile: tolerantList(GenreProfileItem).optional(),

  // Model provenance
  modelUnavailable: z.boolean().optional(),
  modelUnavailableReason: ModelUnavailableReason.optional().catch(undefined),

  // Added in v1: the measurement, the evidence pack, the claims and the run
  audio: AudioFeatures.nullable()
    .optional()
    .catch(null)
    .describe("null when not measured, or when this reader cannot read the measurement"),
  preview: PreviewMatch.nullable().optional().catch(null),
  queryMatch: QueryMatch.nullable()
    .optional()
    .catch(null)
    .describe(
      "How this run's search text matched the track; null or absent when unknown, or when the user chose the track with a click",
    ),
  evidence: tolerantList(Evidence).optional(),
  claims: tolerantList(Claim).optional(),
  run: RunInfo.optional(),
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
 *
 * `releaseDate` and `releaseYear` come from the same Spotify date. A live search suggestion
 * carries `releaseDate` as Spotify sent it (null when it is not a year, a month or a day); the
 * picker's candidates carry it too, with the `releaseYear` of a known date (none for "0000");
 * the suggestions of a recorded track carry `releaseYear` only. The search box orders
 * duplicates by a row's `releaseDate` when it has one, else by its `releaseYear`. A
 * `releaseDate` of "0000" counts as unknown, and the row's `releaseYear` is not read in its
 * place.
 *
 * The picker's candidates also carry the recording's `isrc` (null when Spotify gave none),
 * whether Spotify marks the track `explicit`, and its length (`durationMs`). The API sends one
 * row per recording, by `oneRowPerRecording` (picker.ts), which the search box applies to its
 * suggestions too: rows that share an ISRC and an `explicit` value, with lengths within 2 s of
 * the kept row's, are one row, the earliest known release (a tie is settled by track id). Rows
 * without an ISRC or a length are never merged, nor are an explicit and a clean version, or two
 * edits.
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
  releaseDate: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Spotify\'s album release date as sent: a year ("2011"), a month ("2011-10") or a day ("2011-10-18"); "0000" means unknown. Null or absent when not known',
    ),
  explicit: z
    .boolean()
    .nullable()
    .optional()
    .describe("Whether Spotify marks the track explicit. Null or absent when not known"),
  durationMs: z
    .int()
    .min(0)
    .optional()
    .describe("The track's length in milliseconds as Spotify gave it. Absent when not known"),
});
export type SearchCandidate = z.infer<typeof SearchCandidate>;
