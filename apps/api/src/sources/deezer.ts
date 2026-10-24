/**
 * Deezer previews for a chosen recording.
 *
 * The recording is looked up by its ISRC first (`/track/isrc:<ISRC>`). That entry can be another
 * Deezer entry of the recording that is not readable or has no preview: then the entry Deezer
 * names as its readable alternative is read by id (`/track/<id>`), and last a search is made.
 * An entry found by id or by search is used only when it is strictly the same recording: the
 * same artist, the same title once normalised (titles in any script), no other version (live,
 * remix, karaoke, cover, re-recording and the like) unless the requested track is that version,
 * and a duration within 3 s. Nothing else is ever used: when no entry fits, there is no preview,
 * and the reasons each entry was turned down are reported.
 *
 * Deezer reports errors inside an HTTP 200 answer: code 800 ("no data") means nothing was
 * found, code 4 is its quota. Durations are in seconds. Preview URLs are signed and expire
 * within minutes: they are never logged, and never recorded in a cassette (no shape below keeps
 * them, so a replayed run finds no preview). Deezer's own `bpm` field is not read: it is not a
 * measurement.
 *
 * API docs: https://developers.deezer.com/api/track
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { recordingTitleDifference, sameArtistName } from "../agent/trackMatch.js";
import { fetchJson, type Shape, SourceError } from "./http.js";

// =============================================================================
// Deezer payloads
// =============================================================================

interface DeezerError {
  type?: string;
  message?: string;
  code?: number;
}

interface DeezerTrack {
  id: number;
  title: string;
  /** 30-second MP3 URL (dzcdn.net), signed; "" when there is none. */
  preview?: string;
  /** false when the entry cannot be played in the requester's country. */
  readable?: boolean;
  isrc?: string;
  /** Seconds. */
  duration?: number;
  artist?: { id?: number; name?: string };
  album?: { id?: number; title?: string };
  /** A readable entry Deezer offers in place of one that is not readable. */
  alternative?: { id?: number };
  error?: DeezerError;
}

interface DeezerSearchResponse {
  data?: DeezerTrack[];
  total?: number;
  error?: DeezerError;
}

const DEEZER_API_BASE = "https://api.deezer.com";

/** Deezer's "no data" error: the entry does not exist. */
const NO_DATA = 800;
/** Deezer's quota error. */
const QUOTA = 4;

/** How far a matched entry's duration may be from the requested one. */
const DURATION_TOLERANCE_S = 3;

// Fields kept when a response is recorded. Preview and cover URLs are left out (they are signed
// and expire), so a replayed lookup finds no preview.
const ENTRY_SHAPE = {
  id: true,
  title: true,
  readable: true,
  isrc: true,
  duration: true,
  artist: { id: true, name: true },
  album: { id: true, title: true },
  alternative: { id: true },
} as const;
const TRACK_SHAPE: Shape = { ...ENTRY_SHAPE, error: true };
const SEARCH_SHAPE: Shape = { total: true, error: true, data: [ENTRY_SHAPE] };

// =============================================================================
// Results
// =============================================================================

/** The recording a preview is wanted for, as the scout chose it. */
export interface PreviewRequest {
  title: string;
  /** The credited artists joined (as Spotify's summary has them). */
  artist: string;
  /** The credited artists one by one, when known. */
  artistNames?: string[];
  album?: string;
  isrc?: string | null;
  /** The requested track's duration in milliseconds; 0 or missing when unknown. */
  durationMs?: number | null;
}

/**
 * How a Deezer entry was matched to the requested recording:
 * - `isrc`: the entry Deezer gives for the ISRC;
 * - `id`: the readable alternative Deezer names for that entry, read by its id;
 * - `search`: a search result.
 * `score` is null for an entry with the requested ISRC. Any other entry has to match strictly by
 * artist, title and version to be used at all; its score is how close its duration is: 1 when
 * equal, 0.5 at the 3 s limit.
 */
export interface DeezerMatch {
  provider: "deezer";
  method: "isrc" | "id" | "search";
  deezerId: number;
  score: number | null;
}

/** Why an entry was not used. */
export type DeezerRejection =
  | "not_readable"
  | "no_preview"
  | "isrc_differs"
  | "artist_differs"
  | "title_differs"
  | "other_version"
  | "duration_differs"
  | "duration_unknown";

export type DeezerPreviewResult =
  | {
      found: true;
      /** Signed and short-lived: for this run only, never stored or logged. */
      previewUrl: string;
      match: DeezerMatch;
      title: string;
      artist: string;
    }
  | {
      found: false;
      previewUrl: null;
      /** Every entry that was looked at and why it was not used. */
      rejected: Array<{ deezerId: number; method: DeezerMatch["method"]; reason: DeezerRejection }>;
      message: string;
      /** Set when Deezer could not be read (quota, network): nothing is known then. */
      error?: string;
    };

type Rejected = Extract<DeezerPreviewResult, { found: false }>["rejected"];

// =============================================================================
// Matching
// =============================================================================

/**
 * One Deezer request. Returns null for Deezer's "no data" answer; throws a SourceError for its
 * quota (rate_limited) and for any other error it reports in a 200 answer.
 */
async function deezerGet<T extends { error?: DeezerError }>(
  url: URL,
  scrub: Shape,
  signal: AbortSignal | undefined,
): Promise<T | null> {
  const data = await fetchJson<T>({
    source: "deezer",
    url,
    headers: { Accept: "application/json" },
    scrub,
    signal,
  });
  const error = data?.error;
  if (!error) return data;
  if (error.code === NO_DATA) return null;
  const message = `Deezer API: ${error.message ?? "error"} (code ${error.code ?? "?"})`;
  throw new SourceError("deezer", error.code === QUOTA ? "rate_limited" : "http", message, {
    body: error,
  });
}

const hasPreview = (entry: DeezerTrack) =>
  typeof entry.preview === "string" && entry.preview.length > 0;

const sameIsrc = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();

function requestedArtists(request: PreviewRequest): string[] {
  return request.artistNames?.length ? request.artistNames : [request.artist];
}

/**
 * Why an entry that was not found by the requested ISRC is not the requested recording, or null
 * when it strictly is (see the file comment).
 */
function strictMismatch(request: PreviewRequest, entry: DeezerTrack): DeezerRejection | null {
  const artist = entry.artist?.name ?? "";
  if (!requestedArtists(request).some((name) => sameArtistName(name, artist))) {
    return "artist_differs";
  }
  const difference = recordingTitleDifference(
    { title: request.title, album: request.album },
    { title: entry.title ?? "", album: entry.album?.title },
  );
  if (difference === "title") return "title_differs";
  if (difference === "version") return "other_version";
  const wanted = (request.durationMs ?? 0) / 1000;
  const got = entry.duration ?? 0;
  if (!(wanted > 0) || !(got > 0)) return "duration_unknown";
  if (Math.abs(wanted - got) > DURATION_TOLERANCE_S) return "duration_differs";
  return null;
}

/** Why an entry's preview cannot be used at all, or null. */
function unplayable(entry: DeezerTrack): DeezerRejection | null {
  if (entry.readable === false) return "not_readable";
  if (!hasPreview(entry)) return "no_preview";
  return null;
}

/** See DeezerMatch.score. */
function durationScore(request: PreviewRequest, entry: DeezerTrack): number {
  const gap = Math.abs((request.durationMs ?? 0) / 1000 - (entry.duration ?? 0));
  return Math.round((1 - gap / (2 * DURATION_TOLERANCE_S)) * 100) / 100;
}

function found(entry: DeezerTrack, match: DeezerMatch): DeezerPreviewResult {
  console.log(
    `✅ [Deezer] Matched by ${match.method}: "${entry.title}" by ${entry.artist?.name} (id ${entry.id})`,
  );
  return {
    found: true,
    previewUrl: entry.preview as string,
    match,
    title: entry.title,
    artist: entry.artist?.name ?? "",
  };
}

function notFound(rejected: Rejected, message: string, error?: string): DeezerPreviewResult {
  console.log(`⚠️ [Deezer] ${message}`);
  return { found: false, previewUrl: null, rejected, message, ...(error ? { error } : {}) };
}

/**
 * The preview of the entry Deezer gives for the request's ISRC, or of the readable alternative
 * it names for that entry. Not found when there is no ISRC, Deezer has no entry for it, or
 * neither entry can be used.
 */
export async function deezerPreviewByIsrc(
  request: PreviewRequest,
  signal?: AbortSignal,
): Promise<DeezerPreviewResult> {
  const rejected: Rejected = [];
  const isrc = request.isrc?.trim();
  if (!isrc) return notFound(rejected, "No ISRC to look up");

  const entry = await deezerGet<DeezerTrack>(
    new URL(`${DEEZER_API_BASE}/track/isrc:${encodeURIComponent(isrc)}`),
    TRACK_SHAPE,
    signal,
  );
  if (!entry || typeof entry.id !== "number")
    return notFound(rejected, `No entry for ISRC ${isrc}`);

  // An entry that carries another ISRC is not the requested recording.
  const reason = entry.isrc && !sameIsrc(entry.isrc, isrc) ? "isrc_differs" : unplayable(entry);
  if (!reason) {
    return found(entry, { provider: "deezer", method: "isrc", deezerId: entry.id, score: null });
  }
  rejected.push({ deezerId: entry.id, method: "isrc", reason });

  const alternativeId = entry.alternative?.id;
  if (
    reason !== "isrc_differs" &&
    typeof alternativeId === "number" &&
    alternativeId !== entry.id
  ) {
    const alternative = await deezerGet<DeezerTrack>(
      new URL(`${DEEZER_API_BASE}/track/${alternativeId}`),
      TRACK_SHAPE,
      signal,
    );
    if (alternative && typeof alternative.id === "number") {
      // The same ISRC is the same recording; any other entry must match strictly.
      const sameRecording = sameIsrc(alternative.isrc, isrc);
      const why =
        unplayable(alternative) ?? (sameRecording ? null : strictMismatch(request, alternative));
      if (!why) {
        return found(alternative, {
          provider: "deezer",
          method: "id",
          deezerId: alternative.id,
          score: sameRecording ? null : durationScore(request, alternative),
        });
      }
      rejected.push({ deezerId: alternative.id, method: "id", reason: why });
    }
  }
  return notFound(rejected, `The entry for ISRC ${isrc} has no usable preview`);
}

/**
 * The preview of a search result that is strictly the requested recording (see the file
 * comment); of several, the one whose duration is closest. Never "any result with a preview".
 */
export async function deezerPreviewBySearch(
  request: PreviewRequest,
  signal?: AbortSignal,
): Promise<DeezerPreviewResult> {
  const rejected: Rejected = [];
  const artist = requestedArtists(request)[0] ?? "";
  const url = new URL(`${DEEZER_API_BASE}/search/track`);
  url.searchParams.set("q", `${artist} ${request.title}`.trim());
  url.searchParams.set("limit", "10");
  console.log(`🔍 [Deezer] Searching: "${request.title}" by ${artist}`);

  const data = await deezerGet<DeezerSearchResponse>(url, SEARCH_SHAPE, signal);
  const entries = Array.isArray(data?.data) ? data.data : [];

  let best: DeezerTrack | null = null;
  for (const entry of entries) {
    if (typeof entry?.id !== "number") continue;
    const reason = unplayable(entry) ?? strictMismatch(request, entry);
    if (reason) {
      rejected.push({ deezerId: entry.id, method: "search", reason });
      continue;
    }
    if (!best || durationScore(request, entry) > durationScore(request, best)) best = entry;
  }

  if (best) {
    return found(best, {
      provider: "deezer",
      method: "search",
      deezerId: best.id,
      score: durationScore(request, best),
    });
  }
  return notFound(
    rejected,
    entries.length === 0
      ? `No Deezer results for "${request.title}" by ${artist}`
      : `None of ${entries.length} Deezer results is the requested recording`,
  );
}

/**
 * A Deezer failure as a result without a preview that carries the error; for a cancelled run
 * the error is thrown again.
 */
export function deezerFailure(
  error: unknown,
  signal: AbortSignal | undefined,
): DeezerPreviewResult {
  if (signal?.aborted) throw error;
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error("❌ [Deezer] Error:", message);
  return notFound([], "Deezer could not be read", message);
}

/**
 * The full Deezer lookup: by ISRC (and its alternative), then by a strict search. A Deezer
 * error (its quota, the network) ends the lookup and is reported as an error, never as "no
 * preview found".
 */
export async function findDeezerPreview(
  request: PreviewRequest,
  signal?: AbortSignal,
): Promise<DeezerPreviewResult> {
  try {
    const byIsrc = await deezerPreviewByIsrc(request, signal);
    if (byIsrc.found) return byIsrc;
    const bySearch = await deezerPreviewBySearch(request, signal);
    if (bySearch.found) return bySearch;
    return { ...bySearch, rejected: [...byIsrc.rejected, ...bySearch.rejected] };
  } catch (error) {
    return deezerFailure(error, signal);
  }
}

// =============================================================================
// LangGraph Tools
// =============================================================================

/** Finds the Deezer preview of one recording (see findDeezerPreview). */
export const searchDeezerPreview = tool(
  async (request, config): Promise<string> =>
    JSON.stringify(await findDeezerPreview(request, config?.signal)),
  {
    name: "deezer_search_preview",
    description:
      "Find the 30-second Deezer preview of one recording: by its ISRC first, then by a strict " +
      "search (same artist, title and version, duration within 3 s). Returns no preview rather " +
      "than another recording's. No authentication required.",
    schema: z.object({
      title: z.string().describe("The song title"),
      artist: z.string().describe("The artist name"),
      artistNames: z.array(z.string()).optional().describe("The credited artists one by one"),
      album: z.string().optional().describe("The album the track is on"),
      isrc: z.string().nullable().optional().describe("The recording's ISRC"),
      durationMs: z.number().nullable().optional().describe("The track's duration in ms"),
    }),
  },
);

export const deezerTools = [searchDeezerPreview];
