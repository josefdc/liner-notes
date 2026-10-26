/**
 * Schemas a language model fills (strict structured output).
 *
 * Each one passes `assertAzureStrict()`: every field is required (absent values are `null`),
 * every object is closed, nesting and property counts stay within the provider's limits, and
 * there are no length, range, pattern or format keywords. Bounds the wire schema cannot carry
 * are checked in code after parsing (`composerOutputIssues`, `judgeOutputIssues`).
 *
 * None of these schemas has a field for a measured value. Tempo, key, loudness, mood and
 * style scores, sections and key moments exist only in `AudioFeatures`, written by the audio
 * service; `MEASURED_FIELDS` lists the names no model-facing schema may use.
 */

import { z } from "zod";
import { AudioFeatures } from "./audio.js";
import {
  ClaimAbout,
  ClaimField,
  ClaimScope,
  FactoidEntityType,
  FactoidType,
  Verdict,
} from "./evidence.js";
import { FACTOID_LIMITS, LinkType } from "./track.js";

/**
 * Field names that hold measured values or their provenance, in TrackAnalysis and in
 * AudioFeatures (including the names inside its blocks). No model-facing schema may have a
 * property with one of these names, at any depth.
 */
export const MEASURED_FIELDS: readonly string[] = [
  ...new Set([
    // TrackAnalysis copies of the measurement and their provenance
    "bpm",
    "key",
    "energy",
    "valence",
    "danceability",
    "acousticness",
    "instrumentalness",
    "keyMoments",
    "audioSource",
    "audioConfidence",
    "audioUnavailableReason",
    "audio",
    "genreProfile",
    // AudioFeatures and its blocks
    ...Object.keys(AudioFeatures.shape),
    "confidence",
    "tonic",
    "mode",
    "strength",
    "profile",
    "rmsMean",
    "hopSeconds",
    "styles",
    "tags",
    "moods",
    "acoustic",
    "instrumental",
    "arousal",
  ]),
];

const evidenceIds = () =>
  z
    .array(z.string())
    .describe("Ids of evidence items from the evidence pack that support this; [] when none");

const scope = () =>
  ClaimScope.describe(
    "What the statement is about: 'recording' this recording of the track, 'work' the song " +
      "whatever the recording (its writers, other artists' versions), 'release' a whole " +
      "release the track is on (an album credit, the album it appears on)",
  );

// =============================================================================
// Composer
// =============================================================================

export const ComposerClaim = z.strictObject({
  text: z.string().describe("One factual statement about the track"),
  about: ClaimAbout,
  evidenceIds: evidenceIds(),
  field: ClaimField.nullable().describe(
    "'tempo' or 'key' when the statement gives the track's tempo or key; otherwise null",
  ),
  scope: scope(),
});
export type ComposerClaim = z.infer<typeof ComposerClaim>;

export const ComposerFactoid = z.strictObject({
  title: z.string().describe("Short title, no colon at the end"),
  text: z.string().describe("One to three sentences"),
  type: FactoidType,
  entities: z
    .array(z.strictObject({ text: z.string(), type: FactoidEntityType }))
    .describe("Names in the text worth exploring (people, instruments, records, years)"),
  evidenceIds: evidenceIds(),
  scope: scope(),
});
export type ComposerFactoid = z.infer<typeof ComposerFactoid>;

/** current: the analysed track; source: a track it uses; derived: a track that uses it. */
export const GenealogyRole = z.enum(["current", "source", "derived", "influence"]);
export type GenealogyRole = z.infer<typeof GenealogyRole>;

export const ComposerNode = z.strictObject({
  id: z.string().describe("Short unique id; 'current' for the analysed track"),
  role: GenealogyRole,
  label: z.string().describe("'Title - Artist (Year)'"),
  trackTitle: z.string().nullable(),
  trackArtist: z.string().nullable(),
  year: z.string().nullable(),
});
export type ComposerNode = z.infer<typeof ComposerNode>;

/**
 * A relation between two nodes, from the earlier work (`source`) to the later one (`target`),
 * as `GenealogyLink` states it; a `producer` link has no direction. Code writes one claim per
 * link from it (its type, ends, evidence and scope), which the verifier judges.
 */
export const ComposerLink = z.strictObject({
  source: z
    .string()
    .describe(
      "Node id of the earlier work: the record that is sampled, interpolated, covered, remixed " +
        "or that influenced the target",
    ),
  target: z
    .string()
    .describe("Node id of the later work: the record that uses or follows the source"),
  type: LinkType,
  evidenceIds: evidenceIds(),
  scope: scope(),
});
export type ComposerLink = z.infer<typeof ComposerLink>;

/**
 * What the composer writes. Track metadata, measured values, segment colours and ids are set
 * by code, so they are not here.
 */
export const ComposerOutput = z.strictObject({
  claims: z.array(ComposerClaim),
  factoids: z.array(ComposerFactoid).describe(`At most ${FACTOID_LIMITS.max}`),
  genealogyNodes: z.array(ComposerNode),
  genealogyLinks: z.array(ComposerLink),
});
export type ComposerOutput = z.infer<typeof ComposerOutput>;

/**
 * The checks the wire schema cannot express. Returns one message per problem; empty when the
 * output can be used.
 */
export function composerOutputIssues(output: ComposerOutput): string[] {
  const issues: string[] = [];
  if (output.factoids.length > FACTOID_LIMITS.max) {
    issues.push(`factoids: ${output.factoids.length} > ${FACTOID_LIMITS.max}`);
  }
  const ids = new Set<string>();
  for (const node of output.genealogyNodes) {
    if (ids.has(node.id)) issues.push(`genealogyNodes: duplicate id "${node.id}"`);
    ids.add(node.id);
  }
  const current = output.genealogyNodes.filter((node) => node.role === "current");
  if (output.genealogyNodes.length > 0 && current.length !== 1) {
    issues.push(`genealogyNodes: ${current.length} nodes with role "current", expected 1`);
  }
  output.genealogyLinks.forEach((link, index) => {
    for (const end of [link.source, link.target]) {
      if (!ids.has(end)) issues.push(`genealogyLinks[${index}]: unknown node "${end}"`);
    }
  });
  return issues;
}

// =============================================================================
// Factoids ("more facts")
// =============================================================================

export const FactoidsOutput = z.strictObject({
  factoids: z.array(ComposerFactoid),
});
export type FactoidsOutput = z.infer<typeof FactoidsOutput>;

// =============================================================================
// Research planner
// =============================================================================

/**
 * The research steps the planner can choose, `done` included. Spotify's artist top tracks are
 * not offered: the endpoint is gone and the step can find nothing.
 */
export const ResearchAction = z.enum([
  "search_samples",
  "search_production",
  "search_general",
  "search_musicbrainz",
  "search_artist_collaborators",
  "search_lastfm_tags",
  "search_lastfm_similar_tracks",
  "search_lastfm_similar_artists",
  "search_lastfm_artist_info",
  "search_listenbrainz_similar",
  "done",
]);
export type ResearchAction = z.infer<typeof ResearchAction>;

/** The research planner's next step. */
export const ResearchPlanOutput = z.strictObject({
  nextAction: ResearchAction,
  query: z
    .string()
    .nullable()
    .describe(
      "A specific web search query for search_samples, search_production and search_general; null for the other steps",
    ),
  reasoning: z
    .string()
    .describe("One or two sentences: what is missing, or which lead this follows"),
});
export type ResearchPlanOutput = z.infer<typeof ResearchPlanOutput>;

// =============================================================================
// Verifier judge
// =============================================================================

/** Most claims sent to the judge in one call; the rest get no verdict. */
export const JUDGE_BATCH_MAX = 20;

export const JudgeOutput = z.strictObject({
  verdicts: z.array(
    z.strictObject({
      claimId: z.string(),
      verdict: Verdict.describe(
        "Whether the cited excerpts support the claim, not whether it is true",
      ),
      reason: z.string().describe("One sentence naming the excerpt that decides it"),
    }),
  ),
});
export type JudgeOutput = z.infer<typeof JudgeOutput>;

/** One message per problem: verdicts for claims that were not sent, repeats, or too many. */
export function judgeOutputIssues(output: JudgeOutput, sentClaimIds: readonly string[]): string[] {
  const issues: string[] = [];
  if (output.verdicts.length > JUDGE_BATCH_MAX) {
    issues.push(`verdicts: ${output.verdicts.length} > ${JUDGE_BATCH_MAX}`);
  }
  const sent = new Set(sentClaimIds);
  const seen = new Set<string>();
  for (const { claimId } of output.verdicts) {
    if (!sent.has(claimId)) issues.push(`verdicts: claim "${claimId}" was not sent`);
    if (seen.has(claimId)) issues.push(`verdicts: claim "${claimId}" judged twice`);
    seen.add(claimId);
  }
  return issues;
}

/** Every model-facing schema, by name; each must pass assertAzureStrict(). */
export const LLM_SCHEMAS = {
  ComposerOutput,
  FactoidsOutput,
  JudgeOutput,
  ResearchPlanOutput,
} as const;
