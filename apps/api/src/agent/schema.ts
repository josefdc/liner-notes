/**
 * Zod Schema Contract for The Sonic Agent
 *
 * This file defines the structured output schema that the LLM must produce.
 * It maps directly to the frontend TrackData interface and uses z.describe()
 * to guide the LLM's generation.
 *
 * Used by:
 * - Composer node for structured output
 * - API response validation
 * - Frontend type alignment
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AudioFeatures } from "./state.js";

// =============================================================================
// Segment Schema
// =============================================================================

export const SongSegmentSchema = z.object({
  label: z
    .string()
    .describe(
      "Section name: Intro, Verse, Chorus, Bridge, Outro, Instrumental, Breakdown, Pre-Chorus",
    ),
  start: z.number().min(0).max(100).describe("Start % (0-100). First segment MUST start at 0."),
  end: z
    .number()
    .min(0)
    .max(100)
    .describe(
      "End % (0-100). Last segment MUST end at 100. Next segment starts where previous ends.",
    ),
  color: z
    .string()
    .describe(
      "Hex color: '#00F0FF' chorus, '#1F2937' verse, '#374151' intro/outro, '#6B21A8' bridge",
    ),
});

export type SongSegment = z.infer<typeof SongSegmentSchema>;

// =============================================================================
// Sample Schema
// =============================================================================

export const SampleSchema = z.object({
  time: z.number().describe("Timestamp in seconds where the sample appears in the song"),
  description: z
    .string()
    .describe(
      "Description of what was sampled, e.g. 'Drum break from James Brown - Funky Drummer (1970)'",
    ),
});

export type Sample = z.infer<typeof SampleSchema>;

// =============================================================================
// Key Moment Schema (for Timeline Markers)
// =============================================================================

export const KeyMomentSchema = z.object({
  time: z.number().describe("Timestamp in seconds where the key moment occurs"),
  type: z
    .enum(["energy_peak", "energy_drop", "onset", "harmonic_change", "silence"])
    .describe(
      "Type of audio event: energy_peak=high intensity, energy_drop=breakdown, onset=beat transition, harmonic_change=key/chord shift, silence=break",
    ),
  intensity: z.number().min(0).max(1).describe("Intensity of the moment 0-1"),
  description: z.string().describe("Human-readable description of the moment"),
});

export type KeyMoment = z.infer<typeof KeyMomentSchema>;

// =============================================================================
// Log Code Schema (for System Console)
// =============================================================================

export const LogCodeSchema = z.enum([
  // Network operations
  "NET-100",
  "NET-200",
  "NET-400",
  "NET-500",
  // Audio analysis
  "AUDIO-INIT",
  "AUDIO-PARSING",
  "AUDIO-COMPLETE",
  "AUDIO-ERROR",
  // Gemini/LLM operations
  "GEMINI-CONNECT",
  "GEMINI-THOUGHT",
  "GEMINI-RESPONSE",
  "GEMINI-ERROR",
  // Spotify API
  "SPOTIFY-SEARCH",
  "SPOTIFY-FOUND",
  "SPOTIFY-NONE",
  // Research phase
  "RESEARCH-START",
  "RESEARCH-FOUND",
  "RESEARCH-DEEP",
  // Genealogy graph
  "GRAPH-BUILD",
  "GRAPH-ENRICH",
  "GRAPH-COMPLETE",
  // System status
  "SYS-INIT",
  "SYS-READY",
  "SYS-WARN",
  "SYS-ERROR",
]);

export type LogCode = z.infer<typeof LogCodeSchema>;

// =============================================================================
// Factoid Entity Schema (for Interactive Intel Cards)
// =============================================================================

export const FactoidEntitySchema = z.object({
  id: z.string().describe("Unique identifier for the entity"),
  text: z.string().describe("The text to display, e.g. 'Roland Juno-106'"),
  type: z
    .enum(["synth", "producer", "sample", "technique", "artist", "album", "year"])
    .describe("Entity category for styling and search context"),
  searchQuery: z.string().optional().describe("Custom search query when clicked, defaults to text"),
});

export type FactoidEntity = z.infer<typeof FactoidEntitySchema>;

// =============================================================================
// Factoid Schema (Full version with nested entities)
// =============================================================================

export const FactoidSchema = z.object({
  id: z.string().describe("Unique identifier, e.g. 'f1', 'f2'"),
  title: z.string().describe("Catchy title summarizing the factoid, max 50 chars, no colon at end"),
  content: z
    .string()
    .describe("Detailed explanation 1-3 sentences. MUST cite research data when available."),
  type: z
    .enum(["production", "trivia", "credits", "sample", "curiosity", "connection"])
    .describe(
      "Category: production=studio/recording, trivia=history/culture/meaning, credits=producer/writer info, sample=sampling history, curiosity=surprising facts, connection=artist relationships",
    ),
  entities: z
    .array(FactoidEntitySchema)
    .optional()
    .describe("Clickable entities within the content (synths, producers, techniques, etc.)"),
});

export type Factoid = z.infer<typeof FactoidSchema>;

// =============================================================================
// Flat Factoid Schema (for LLM - avoids nested entities)
// =============================================================================

export const FlatFactoidSchema = z.object({
  id: z.string().describe("Unique identifier, e.g. 'f1', 'f2'"),
  title: z.string().describe("Catchy title summarizing the factoid, max 50 chars, no colon at end"),
  content: z
    .string()
    .describe("Detailed explanation 1-3 sentences. MUST cite research data when available."),
  type: z
    .enum(["production", "trivia", "credits", "sample", "curiosity", "connection"])
    .describe("Category"),
  entityNames: z
    .string()
    .optional()
    .describe("Comma-separated entity names to highlight (e.g. 'Roland Juno-106, Dr. Dre, 1995')"),
  entityTypes: z
    .string()
    .optional()
    .describe("Comma-separated entity types matching entityNames (e.g. 'synth, producer, year')"),
});

export type FlatFactoid = z.infer<typeof FlatFactoidSchema>;

// =============================================================================
// Production Credits Schema
// =============================================================================

export const ProductionCreditsSchema = z.object({
  producers: z.array(z.string()).describe("List of producers who worked on the track"),
  writers: z.array(z.string()).describe("List of songwriters/composers"),
  engineers: z.array(z.string()).optional().describe("Recording/mixing engineers if known"),
  label: z.string().optional().describe("Record label that released the track"),
});

export type ProductionCredits = z.infer<typeof ProductionCreditsSchema>;

// =============================================================================
// Genealogy Schema (Sample History / Influences)
// =============================================================================

export const GenealogyNodeSchema = z.object({
  id: z.string().describe("Unique node ID, e.g. 'current', 'origin1', 'derived1'"),
  group: z
    .number()
    .describe(
      "Group: 1=current song (center), 2=songs this samples, 3=songs that sample this, 4=influences",
    ),
  label: z.string().describe("Display label: 'Song Title - Artist (Year)'. MUST be a REAL song."),
  img: z
    .string()
    .url()
    .optional()
    .describe("Album cover URL — leave empty if unknown, will be enriched later"),
  size: z
    .number()
    .describe("Node size: 40 for current song, 28-30 for direct samples, 20-25 for influences"),
  // Audio preview for hover-to-play (enriched from Spotify)
  previewUrl: z
    .string()
    .url()
    .optional()
    .describe("Spotify 30s preview URL — enriched automatically"),
  spotifyId: z.string().optional().describe("Spotify track ID for navigation"),
  // Parsed metadata for click-to-analyze
  trackTitle: z.string().optional().describe("Song title extracted from label"),
  trackArtist: z.string().optional().describe("Artist name extracted from label"),
});

export const GenealogyLinkSchema = z.object({
  source: z.string().describe("Source node ID"),
  target: z.string().describe("Target node ID"),
  value: z
    .number()
    .describe("Connection strength (1-3): 1=weak influence, 2=moderate, 3=direct sample"),
  // Semantic relationship type for visual differentiation
  type: z
    .enum(["sample", "cover", "remix", "producer", "influence"])
    .optional()
    .describe(
      "Nature of connection: sample=direct sample, cover=cover version, remix=remix, producer=same producer, influence=stylistic influence",
    ),
});

export const GenealogySchema = z.object({
  nodes: z
    .array(GenealogyNodeSchema)
    .describe(
      "All songs in genealogy. ALWAYS include 'current' node (group=1). Only add REAL songs from research.",
    ),
  links: z
    .array(GenealogyLinkSchema)
    .describe(
      "Sample/influence connections. source→target shows direction. Use value 3 for direct samples.",
    ),
});

export type GenealogyNode = z.infer<typeof GenealogyNodeSchema>;
export type GenealogyLink = z.infer<typeof GenealogyLinkSchema>;
export type Genealogy = z.infer<typeof GenealogySchema>;

// =============================================================================
// Measured audio fields (Sonic Fingerprint)
// =============================================================================

export const AudioUnavailableReasonSchema = z.enum([
  "no_preview",
  "preview_rejected",
  "service_unavailable",
  "analysis_failed",
  "not_run",
]);

// =============================================================================
// Main TrackData Schema (Final Output)
// =============================================================================

export const TrackDataSchema = z.object({
  id: z.string().describe("Spotify track ID — COPY EXACTLY from input metadata"),
  title: z.string().describe("Song title — COPY EXACTLY from input metadata"),
  artist: z.string().describe("Primary artist name — COPY EXACTLY from input metadata"),
  album: z.string().describe("Album name — COPY EXACTLY from input metadata"),
  coverUrl: z.string().url().describe("Album cover URL — COPY EXACTLY from input metadata"),

  // Enhanced metadata (NEW)
  spotifyUrl: z
    .string()
    .url()
    .optional()
    .describe("Direct Spotify URL — for 'Open in Spotify' button"),
  previewUrl: z
    .string()
    .url()
    .optional()
    .describe("Spotify 30s audio preview URL — for in-app playback"),
  releaseYear: z
    .string()
    .optional()
    .describe("Year of release (e.g. '2022') — extracted from releaseDate"),
  explicit: z.boolean().optional().describe("Whether track has explicit content"),

  // Measured audio analysis: copied from the audio measurement, null when not measured
  bpm: z.number().nullable().describe("Measured tempo BPM, or null when not measured"),
  key: z.string().nullable().optional().describe("Measured key e.g. 'C Major', or null"),
  energy: z.number().nullable().optional().describe("Measured energy 0-1, or null"),
  valence: z.number().nullable().optional().describe("Measured positiveness 0-1, or null"),
  danceability: z.number().nullable().optional().describe("Measured danceability 0-1, or null"),
  acousticness: z.number().nullable().optional().describe("Measured acousticness 0-1, or null"),
  durationSeconds: z
    .number()
    .optional()
    .describe("Song duration in seconds — for timeline display"),

  // Genre Profile for Sonic Fingerprint Radar Chart
  genreProfile: z
    .array(
      z.object({
        genre: z.string(),
        value: z.number().min(0).max(100),
      }),
    )
    .optional()
    .describe("Genre profile for radar chart visualization"),

  // Song structure
  segments: z
    .array(SongSegmentSchema)
    .min(3)
    .describe(
      "Song structure segments. MUST cover 0-100% contiguously with NO GAPS. Adjacent segments must connect.",
    ),
  segmentsSource: z
    .enum(["template", "inferred"])
    .optional()
    .describe(
      "Where the segments come from: 'template' = a generic default structure, 'inferred' = generated from genre conventions. Neither is measured from the audio.",
    ),

  // Sample history
  samples: z
    .array(SampleSchema)
    .describe("Samples used in song — use MusicBrainz data if available, else research data"),

  // Key moments from audio analysis
  keyMoments: z
    .array(KeyMomentSchema)
    .optional()
    .describe(
      "Key audio moments (drops, peaks, transitions) detected by librosa — DO NOT generate, copy from audio features if available",
    ),

  // Production credits (NEW)
  credits: ProductionCreditsSchema.optional().describe(
    "Production credits: producers, writers, engineers. Extract from MusicBrainz data.",
  ),

  // Context & trivia (ENHANCED: more factoids allowed)
  factoids: z
    .array(FactoidSchema)
    .min(3)
    .max(8)
    .describe(
      "Interesting facts. PRIORITY: research data > knowledge. Include at least one of each type when data available: production, sample, credits, curiosity.",
    ),

  // Genealogy graph
  genealogy: GenealogySchema.describe(
    "Musical DNA graph. Current song = group 1. ALL referenced songs MUST be REAL and exist on Spotify.",
  ),

  // Audio provenance
  audioSource: z
    .enum(["analyzed", "unavailable"])
    .optional()
    .describe(
      "'analyzed' when tempo and key were measured from the preview; 'unavailable' when they were not",
    ),
  audioConfidence: z
    .enum(["high", "low"])
    .optional()
    .describe(
      "'high' when tempo, key and all perceptual features were measured; 'low' when some are missing (null)",
    ),
  audioUnavailableReason: AudioUnavailableReasonSchema.optional().describe(
    "Why measured audio values are missing; absent when the analysis succeeded",
  ),

  // Model provenance
  modelUnavailable: z
    .boolean()
    .optional()
    .describe("True when the language model call failed and the result was built from source data"),
  modelUnavailableReason: z
    .string()
    .optional()
    .describe("The model error when modelUnavailable is true"),
});

export type TrackData = z.infer<typeof TrackDataSchema>;

// =============================================================================
// LLM-Optimized Flat Schema (avoids Gemini nesting depth limits)
// =============================================================================

/**
 * Flattened TrackData schema for LLM generation.
 *
 * Gemini has a maximum nesting depth limit for JSON schemas (~5-6 levels).
 * This schema flattens deeply nested structures like:
 * - factoids.entities -> entityNames + entityTypes as comma-separated strings
 * - genealogy.nodes/links -> separate flat arrays
 *
 * After LLM generation, use `transformFlatToTrackData()` to reconstruct.
 */
export const FlatTrackDataSchema = z.object({
  // Core metadata - COPY EXACTLY from input
  id: z.string().describe("Spotify track ID — COPY EXACTLY from input metadata"),
  title: z.string().describe("Song title — COPY EXACTLY from input metadata"),
  artist: z.string().describe("Primary artist name — COPY EXACTLY from input metadata"),
  album: z.string().describe("Album name — COPY EXACTLY from input metadata"),
  coverUrl: z.string().url().describe("Album cover URL — COPY EXACTLY from input metadata"),
  spotifyUrl: z.string().url().optional().describe("Direct Spotify URL"),
  releaseYear: z.string().optional().describe("Year of release (e.g. '2022')"),
  explicit: z.boolean().optional().describe("Whether track has explicit content"),

  // Measured audio values (bpm, key, energy, valence, danceability, acousticness) are not part
  // of this schema: they are copied from the audio measurement by transformFlatToTrackData.
  durationSeconds: z.number().optional().describe("Song duration in seconds"),

  // Genre Profile for Sonic Fingerprint Radar Chart
  genreProfile: z
    .array(
      z.object({
        genre: z
          .string()
          .describe(
            "Genre name: Electronic, Rock, Hip Hop, Jazz, Pop, R&B, Classical, Ambient, Synthwave, etc.",
          ),
        value: z.number().min(0).max(100).describe("Affinity percentage 0-100"),
      }),
    )
    .min(5)
    .max(8)
    .describe(
      "Genre profile for radar chart. 5-8 genres with affinity percentages representing the song's musical DNA.",
    ),

  // Song structure - flat array still works
  segments: z.array(SongSegmentSchema).min(3).describe("Song structure segments covering 0-100%"),

  // Samples - flat array still works
  samples: z.array(SampleSchema).describe("Samples used in song"),

  // Credits - flat object still works
  producers: z.array(z.string()).optional().describe("List of producers"),
  writers: z.array(z.string()).optional().describe("List of songwriters"),
  engineers: z.array(z.string()).optional().describe("Recording/mixing engineers"),
  label: z.string().optional().describe("Record label"),

  // Factoids - FLATTENED (no nested entities array)
  factoids: z.array(FlatFactoidSchema).min(3).max(8).describe("Interesting facts about the song"),

  // Genealogy - FLATTENED into separate arrays
  genealogyNodes: z
    .array(
      z.object({
        id: z.string().describe("Node ID: 'current' for main song, 'origin1', 'derived1', etc."),
        group: z.number().describe("1=current, 2=samples from, 3=sampled by, 4=influences"),
        label: z.string().describe("'Song Title - Artist (Year)'. REAL songs only."),
        size: z.number().describe("40 for current, 28-30 for direct, 20-25 for influences"),
      }),
    )
    .describe("Genealogy nodes. Always include 'current' node with group=1."),

  genealogyLinks: z
    .array(
      z.object({
        source: z.string().describe("Source node ID"),
        target: z.string().describe("Target node ID"),
        value: z.number().describe("Strength 1-3: 1=weak, 2=moderate, 3=direct sample"),
      }),
    )
    .describe("Genealogy connections. source→target direction."),
});

export type FlatTrackData = z.infer<typeof FlatTrackDataSchema>;

// =============================================================================
// Transform Functions
// =============================================================================

/**
 * Generate a unique ID for entities
 */
function generateEntityId(): string {
  return `e${randomUUID()}`;
}

type MeasuredAudioFields = Pick<
  TrackData,
  | "bpm"
  | "key"
  | "energy"
  | "valence"
  | "danceability"
  | "acousticness"
  | "keyMoments"
  | "audioSource"
  | "audioConfidence"
  | "audioUnavailableReason"
>;

/**
 * The TrackData audio fields, taken only from the audio measurement. Values that were not
 * measured are null, and the reason is carried in audioUnavailableReason.
 */
export function measuredAudioFields(audio: AudioFeatures | null | undefined): MeasuredAudioFields {
  if (!audio) {
    return {
      bpm: null,
      key: null,
      energy: null,
      valence: null,
      danceability: null,
      acousticness: null,
      keyMoments: [],
      audioSource: "unavailable",
      audioConfidence: "low",
      audioUnavailableReason: "not_run",
    };
  }
  const measured = audio.bpm != null && audio.key != null;
  return {
    bpm: audio.bpm ?? null,
    key: audio.key ?? null,
    energy: audio.energy ?? null,
    valence: audio.valence ?? null,
    danceability: audio.danceability ?? null,
    acousticness: audio.acousticness ?? null,
    keyMoments: audio.keyMoments ?? [],
    audioSource: measured ? "analyzed" : "unavailable",
    audioConfidence: measured ? audio.confidence : "low",
    audioUnavailableReason: measured ? undefined : (audio.unavailableReason ?? "not_run"),
  };
}

/**
 * Transform flat LLM output to full TrackData structure. Measured audio fields come from
 * `audio` only; the model output cannot set them.
 */
export function transformFlatToTrackData(
  flat: FlatTrackData,
  audio: AudioFeatures | null | undefined,
): TrackData {
  // Reconstruct factoids with nested entities
  const factoids: Factoid[] = flat.factoids.map((f) => {
    let entities: FactoidEntity[] | undefined;

    if (f.entityNames && f.entityTypes) {
      const names = f.entityNames
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const types = f.entityTypes
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const validTypes = [
        "synth",
        "producer",
        "sample",
        "technique",
        "artist",
        "album",
        "year",
      ] as const;

      entities = names.map((name, i) => ({
        id: generateEntityId(),
        text: name,
        type: (validTypes.includes(types[i] as (typeof validTypes)[number])
          ? types[i]
          : "sample") as FactoidEntity["type"],
        searchQuery: name,
      }));
    }

    return {
      id: f.id,
      title: f.title,
      content: f.content,
      type: f.type,
      entities: entities?.length ? entities : undefined,
    };
  });

  // Reconstruct genealogy
  const genealogy: Genealogy = {
    nodes: flat.genealogyNodes.map((n) => ({
      id: n.id,
      group: n.group,
      label: n.label,
      size: n.size,
      img: undefined, // Will be enriched later
    })),
    links: flat.genealogyLinks,
  };

  // Reconstruct credits
  const credits: ProductionCredits | undefined =
    flat.producers?.length || flat.writers?.length || flat.engineers?.length || flat.label
      ? {
          producers: flat.producers || [],
          writers: flat.writers || [],
          engineers: flat.engineers,
          label: flat.label,
        }
      : undefined;

  return {
    id: flat.id,
    title: flat.title,
    artist: flat.artist,
    album: flat.album,
    coverUrl: flat.coverUrl,
    spotifyUrl: flat.spotifyUrl,
    releaseYear: flat.releaseYear,
    explicit: flat.explicit,
    durationSeconds: flat.durationSeconds,
    genreProfile: flat.genreProfile,
    segments: flat.segments,
    segmentsSource: "inferred",
    samples: flat.samples,
    credits,
    factoids,
    genealogy,
    ...measuredAudioFields(audio),
  };
}

// =============================================================================
// Search Candidates Schema (for Human-in-the-loop)
// =============================================================================

export const SearchCandidateSchema = z.object({
  id: z.string().describe("Spotify track ID"),
  title: z.string().describe("Song title"),
  artist: z.string().describe("Artist name"),
  album: z.string().describe("Album name"),
  coverUrl: z.string().url().describe("Album cover URL"),
  releaseYear: z.string().optional().describe("Year of release"),
  popularity: z.number().min(0).max(100).describe("Spotify popularity score 0-100"),
});

export type SearchCandidate = z.infer<typeof SearchCandidateSchema>;

// =============================================================================
// Research Plan Schema (for Deep Dive Researcher ReAct pattern)
// =============================================================================

export const ResearchPlanSchema = z.object({
  nextAction: z
    .enum([
      "search_samples",
      "search_production",
      "search_meaning",
      "search_general",
      "search_musicbrainz",
      "search_artist_collaborators",
      "search_artist_top_tracks",
      "search_lastfm_tags",
      "search_lastfm_similar_tracks",
      "search_lastfm_similar_artists",
      "search_lastfm_artist_info",
      "search_listenbrainz_similar",
      "done",
    ])
    .describe(
      "Next action. START with 'search_musicbrainz' for verified samples. Use 'search_lastfm_tags' for genre profile. Use 'search_lastfm_similar_tracks' for discovery. Use 'search_listenbrainz_similar' for open-source similarity. 'done' only when coverage is sufficient.",
    ),
  query: z
    .string()
    .optional()
    .describe(
      "Search query — REQUIRED for all actions except 'done', 'search_musicbrainz', 'search_artist_collaborators', 'search_artist_top_tracks', 'search_lastfm_tags', 'search_lastfm_similar_tracks', 'search_lastfm_similar_artists', 'search_lastfm_artist_info', 'search_listenbrainz_similar'. Be specific.",
    ),
  reasoning: z
    .string()
    .describe("1-2 sentence explanation. Reference what's missing OR what lead you're following."),
});

export type ResearchPlanType = z.infer<typeof ResearchPlanSchema>;

// =============================================================================
// HITL Configuration Schema (for API validation)
// =============================================================================

export const HITLConfigSchema = z.object({
  disambiguationThreshold: z
    .number()
    .min(0)
    .max(100)
    .default(85)
    .describe("Popularity threshold for auto-selection (0-100)"),
  popularityGap: z
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .describe("Minimum popularity gap ratio to skip disambiguation"),
  maxCandidates: z.number().min(1).max(10).default(5).describe("Maximum candidates to show user"),
});

export type HITLConfigType = z.infer<typeof HITLConfigSchema>;

// =============================================================================
// API Response Schemas
// =============================================================================

export const AnalyzeResponseSchema = z.object({
  success: z.boolean(),
  data: TrackDataSchema.optional(),
  error: z.string().optional(),
  meta: z
    .object({
      query: z.string(),
      durationMs: z.number(),
      timestamp: z.string(),
    })
    .optional(),
});

export const StreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("status"),
    message: z.string(),
    code: LogCodeSchema.optional(),
    node: z.string().optional(),
    timestamp: z.string(),
  }),
  z.object({
    type: z.literal("candidates"),
    candidates: z.array(SearchCandidateSchema),
    message: z.string(),
  }),
  z.object({
    type: z.literal("partial"),
    data: z.record(z.unknown()),
    node: z.string(),
  }),
  z.object({
    type: z.literal("complete"),
    data: TrackDataSchema,
  }),
  z.object({
    type: z.literal("error"),
    error: z.string(),
    code: z.string().optional(),
  }),
]);

export type StreamEvent = z.infer<typeof StreamEventSchema>;

// =============================================================================
// Helper: Create empty TrackData
// =============================================================================

export function createEmptyTrackData(id: string, title: string, artist: string): TrackData {
  return {
    id,
    title,
    artist,
    album: "",
    coverUrl: "",
    spotifyUrl: `https://open.spotify.com/track/${id}`,
    releaseYear: undefined,
    explicit: undefined,
    ...measuredAudioFields(null),
    segments: [
      { label: "Intro", start: 0, end: 10, color: "#374151" },
      { label: "Main", start: 10, end: 90, color: "#1F2937" },
      { label: "Outro", start: 90, end: 100, color: "#374151" },
    ],
    segmentsSource: "template",
    samples: [],
    factoids: [],
    credits: undefined,
    genealogy: {
      nodes: [{ id: "current", group: 1, label: title, size: 40 }],
      links: [],
    },
  };
}
