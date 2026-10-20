/**
 * Request and response bodies of the HTTP API, and the replay record format. Stream events
 * are in events.ts.
 */

import { z } from "zod/v4";
import { Timestamp } from "./common.js";
import { AnalyzeStreamEvent, ErrorCode } from "./events.js";
import { Factoid, RunMode, RunStatus, RunUsage, SearchCandidate, TrackAnalysis } from "./track.js";

/** Longest accepted analysis query, in characters. */
export const MAX_QUERY_LENGTH = 200;

/** Thread and track ids accepted by the resume routes. */
export const RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const ResourceId = z.string().regex(RESOURCE_ID_PATTERN);

/** Spotify track ids (base62, 22 characters). */
export const SPOTIFY_ID_PATTERN = /^[0-9A-Za-z]{22}$/;

// =============================================================================
// Errors
// =============================================================================

/**
 * Every JSON error body: a code, a short message, and sometimes details about invalid input
 * (`detail`, `issues`, `example`). Other fields may be added.
 */
export const ApiError = z.looseObject({
  success: z.literal(false),
  code: ErrorCode,
  error: z.string(),
});
export type ApiError = z.infer<typeof ApiError>;

// =============================================================================
// Analysis
// =============================================================================

/** POST /api/analyze; GET /api/analyze/stream takes the same `query` as a query parameter. */
export const AnalyzeRequest = z.object({
  query: z.string().min(1).max(MAX_QUERY_LENGTH),
});

/** POST /api/analyze/resume; the stream route takes the same fields as query parameters. */
export const ResumeRequest = z.object({
  threadId: ResourceId,
  selectedTrackId: ResourceId,
});

export const Interrupt = z.object({
  reason: z.literal("disambiguation"),
  candidates: z.array(SearchCandidate),
  message: z.string(),
});

/** 200 answer of POST /api/analyze and POST /api/analyze/resume. */
export const AnalyzeResponse = z.discriminatedUnion("status", [
  z.object({
    success: z.literal(true),
    status: z.literal("complete"),
    threadId: z.string(),
    data: TrackAnalysis,
    meta: z.looseObject({ timestamp: Timestamp }).optional(),
  }),
  z.object({
    success: z.literal(true),
    status: z.literal("interrupted"),
    threadId: z.string(),
    interrupt: Interrupt,
  }),
]);
export type AnalyzeResponse = z.infer<typeof AnalyzeResponse>;

// =============================================================================
// Search and factoids
// =============================================================================

/** GET /api/search/suggest?query=&limit= */
export const SearchSuggestResponse = z.object({
  success: z.literal(true),
  suggestions: z.array(SearchCandidate),
  meta: z
    .object({ query: z.string(), resultCount: z.int().min(0), timestamp: Timestamp })
    .optional(),
});

/** POST /api/factoids/decrypt */
export const FactoidsRequest = z.object({
  trackId: z.string().min(1),
  trackTitle: z.string().min(1),
  trackArtist: z.string().optional(),
  existingFactoidIds: z.array(z.string()).optional(),
  runId: z.string().optional().describe("The analysis the factoids are for, so they do not repeat"),
});

export const FactoidsResponse = z.object({
  factoids: z.array(Factoid),
});

// =============================================================================
// Runs
// =============================================================================

/**
 * A stored run, as GET /api/runs/:id and GET /api/runs/by-track/:spotifyId return it. It never
 * carries the query the user typed.
 */
export const StoredRun = z.object({
  id: z.string().min(1),
  status: RunStatus,
  mode: RunMode,
  spotifyId: z.string().nullable(),
  createdAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type StoredRun = z.infer<typeof StoredRun>;

/**
 * 200 answer of GET /api/runs/:id and GET /api/runs/by-track/:spotifyId (the latest stored
 * run of that track). `analysis` is null until the run has completed. A run or track without a
 * stored run answers 404 `not_found`.
 */
export const RunResponse = z.object({
  success: z.literal(true),
  run: StoredRun,
  analysis: TrackAnalysis.nullable(),
});
export type RunResponse = z.infer<typeof RunResponse>;

/** POST /api/runs: a Turnstile-verified request for a run token. */
export const RunTokenRequest = z.object({
  turnstileToken: z.string().min(1),
});

/** The token goes in the `runToken` query parameter of the stream, resume and factoid routes. */
export const RunTokenResponse = z.object({
  success: z.literal(true),
  runToken: z.string().min(1),
  expiresAt: Timestamp,
});

// =============================================================================
// Health
// =============================================================================

/** GET /api/health: liveness. */
export const HealthResponse = z.looseObject({
  status: z.literal("ok"),
  service: z.string(),
  version: z.string(),
  timestamp: Timestamp,
});

/** GET /api/ready: 200 when every check is ok, 503 otherwise. */
export const ReadyResponse = z.looseObject({
  status: z.enum(["ready", "unavailable"]),
  checks: z.record(z.string(), z.string()),
  timestamp: Timestamp,
});

// =============================================================================
// Replay records (fixtures/replays/<slug>.json)
// =============================================================================

/**
 * A recorded run, replayed with the same events at accelerated timing. `run` in `analysis`
 * says `mode: "replay"` with the recording date, commit and analyzer version. Recordings are
 * scrubbed before they are written: no preview or image URLs, capped text.
 */
export const ReplayRecord = z
  .object({
    version: z.literal(1),
    slug: z.string().regex(/^[a-z0-9-]+$/),
    request: z.object({
      query: z.string(),
      selectedTrackId: z.string().nullable(),
    }),
    recordedAt: Timestamp,
    commit: z.string().min(1),
    analyzerVersion: z.string().nullable(),
    events: z.array(
      z.object({
        atMs: z.int().min(0).describe("Milliseconds since the stream opened"),
        event: AnalyzeStreamEvent,
      }),
    ),
    analysis: TrackAnalysis,
    usage: RunUsage.nullable(),
  })
  .refine((record) => record.analysis.run?.mode === "replay", {
    message: "a recorded analysis must say it is a replay (run.mode)",
    path: ["analysis", "run", "mode"],
  });
export type ReplayRecord = z.infer<typeof ReplayRecord>;
