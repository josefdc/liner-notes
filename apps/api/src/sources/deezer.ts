/**
 * Deezer previews for a chosen recording. Missing is always better than another recording's
 * clip: nothing below ever falls back to "any track with a preview".
 *
 * The recording is looked up by its ISRC first (`/track/isrc:<ISRC>`). Even that entry is used
 * only when it carries the requested ISRC and agrees with the track, since ISRCs are reused and
 * misassigned (karaoke and compilation labels, a neighbouring track): the same lead artist; the
 * same title when the two titles can be compared word for word (a common script, or a title of
 * digits only); a shared part title when both carry one ("(Part One)", "- II. Allegretto"); no
 * other version marked in its title or album name (live, remix, karaoke, re-recording, take and
 * the like); and a duration within 3 s. Its album is not checked. An entry without an `isrc`
 * field is not an ISRC
 * match: it must pass the strict check below. When the ISRC entry is not readable or has no
 * preview, the entry Deezer names as its readable alternative is read by id (`/track/<id>`), and
 * last a search is made, which never takes an entry the ISRC step turned down. A search result
 * that carries the requested ISRC is checked like the ISRC entry; any other must pass the strict
 * check (a remaster or another release of the recording carries its own ISRC).
 *
 * Any entry not confirmed by the requested ISRC is used only when it is strictly the same
 * recording: the same lead artist, the same title once normalised (titles in any script), no
 * other version unless the requested track is that version, the same album (edition labels
 * aside: another album may be a live or re-recorded one whose name does not say so) and a
 * duration within 3 s. When no entry fits there is no preview, and the reasons each entry was
 * turned down are reported.
 *
 * Deezer reports errors inside an HTTP 200 answer: code 800 ("no data") means nothing was
 * found, code 4 is its quota. Every Deezer request of the process is paced to stay under that
 * quota (see DEEZER_PACE), and genealogy node previews may use only part of it. Durations are in
 * seconds. Preview URLs are signed and expire within minutes: they are never logged, and never
 * recorded in a cassette (no shape below keeps them, so a replayed run finds no preview).
 * Deezer's own `bpm` field is not read: it is not a measurement.
 *
 * API docs: https://developers.deezer.com/api/track
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  markedAsOtherVersion,
  recordingTitleDifference,
  comparableTitles,
  partTitlesDiffer,
  sameAlbumName,
  sameArtistName,
  words,
} from "../agent/trackMatch.js";
import { abortError, cassetteMode, fetchJson, type Shape, SourceError } from "./http.js";
import { LanePacer, type LanePace, PaceRefused } from "./pacing.js";
import { type SourceErrorCode, sourceErrorCode } from "./toolResult.js";
import { logger } from "../logger.js";

const log = logger("Deezer");

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
  /** The version part of the title ("(Live)"), which Deezer usually also puts in `title`. */
  title_version?: string;
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

/** The window of Deezer's quota: 50 requests per 5 s per address, as its API documents. */
export const DEEZER_WINDOW_MS = 5_000;
/** The requests this process starts in any window: under the quota, with a margin. */
export const DEEZER_MAX_PER_WINDOW = 40;
/**
 * Of those, the requests genealogy node previews may start in any window: at least 10 stay free
 * for the analysed tracks' previews (their measured tempo and key come from them).
 */
export const DEEZER_NODE_MAX_PER_WINDOW = 30;

/**
 * Every Deezer request of the process, in two lanes (sources/pacing.ts LanePacer): the analysed
 * tracks' requests (priority: they never wait behind node requests) and the genealogy node
 * previews' (background: at most DEEZER_NODE_MAX_PER_WINDOW of the window). A request waits at
 * most a window for its slot; a later one is refused (PaceRefused) and not sent.
 */
export const DEEZER_PACE: LanePace = {
  windowMs: DEEZER_WINDOW_MS,
  max: DEEZER_MAX_PER_WINDOW,
  backgroundMax: DEEZER_NODE_MAX_PER_WINDOW,
  maxWaitMs: DEEZER_WINDOW_MS,
};
const pacer = new LanePacer("Deezer", () => DEEZER_PACE);

/** How a lookup's requests are paced. */
export interface DeezerPacing {
  /** "nodes": a genealogy node's preview, in the background lane. Else the priority lane. */
  lane?: "nodes";
  /**
   * On `pacingClock`, read for each request: the latest it may start; a later slot is refused
   * (PaceRefused) and the request is not sent.
   */
  notAfter?: () => number;
  /** Told when a request got its slot: it is sent then. */
  onSlot?: () => void;
}

/** How far a matched entry's duration may be from the requested one. */
const DURATION_TOLERANCE_S = 3;

// Fields kept when a response is recorded. Preview and cover URLs are left out (they are signed
// and expire), so a replayed lookup finds no preview.
const ENTRY_SHAPE = {
  id: true,
  title: true,
  title_version: true,
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
 * - `isrc`: an entry that carries the requested ISRC and agrees with the track: the entry
 *   Deezer gives for the ISRC, or a search result;
 * - `id`: an entry read by id: the readable alternative Deezer names for the ISRC entry, or the
 *   ISRC entry itself when it does not carry the ISRC;
 * - `search`: a search result.
 * `score` is null for an entry that carries the requested ISRC (and passed the checks of an ISRC
 * entry). Any other entry has to match strictly to be used at all; its score is how close its
 * duration is: 1 when equal, 0.5 at the 3 s limit.
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
  | "album_differs"
  | "album_unknown"
  | "duration_differs"
  | "duration_unknown"
  | "turned_down_by_isrc";

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
      /**
       * Set when a request was not sent: Deezer's pace (DEEZER_PACE) had no slot in time. Not
       * an error: Deezer was not asked, and nothing is known.
       */
      notAsked?: true;
      /** The kind of that failure, for the run's source errors. */
      errorCode?: SourceErrorCode;
    };

type Rejected = Extract<DeezerPreviewResult, { found: false }>["rejected"];

// =============================================================================
// Matching
// =============================================================================

/**
 * One Deezer request, once the pacer gives it a slot (none for a replayed answer: nothing
 * reaches Deezer). Returns null for Deezer's "no data" answer; throws a SourceError for its
 * quota (rate_limited) and for any other error it reports in a 200 answer, and PaceRefused for a
 * request the pacer does not let start in time (not sent).
 */
async function deezerGet<T extends { error?: DeezerError }>(
  url: URL,
  scrub: Shape,
  signal: AbortSignal | undefined,
  pacing: DeezerPacing = {},
): Promise<T | null> {
  if (cassetteMode() !== "replay") {
    try {
      await pacer.slot({
        signal,
        notAfter: pacing.notAfter?.(),
        lane: pacing.lane === "nodes" ? "background" : "priority",
      });
    } catch (error) {
      // Stopped while it waited: as a request stopped while it is under way.
      if (signal?.aborted && !(error instanceof PaceRefused)) {
        throw abortError("deezer", signal, error);
      }
      throw error;
    }
  }
  pacing.onSlot?.();
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

/** The requested track's lead artist (Spotify lists it first). */
function leadArtist(request: PreviewRequest): string {
  return request.artistNames?.[0] ?? request.artist;
}

/** Whether `part` occurs in `text` as whole words, in order ("Live" is not in "Alive"). */
function containsWords(text: string[], part: string[]): boolean {
  if (part.length === 0) return true;
  for (let at = 0; at + part.length <= text.length; at++) {
    if (part.every((word, i) => text[at + i] === word)) return true;
  }
  return false;
}

/** The entry's title with its version part, when Deezer gives that apart. */
function fullTitle(entry: DeezerTrack): string {
  const title = entry.title ?? "";
  const version = entry.title_version?.trim();
  if (!version || containsWords(words(title), words(version))) return title;
  return `${title} ${version}`;
}

function durationMismatch(request: PreviewRequest, entry: DeezerTrack): DeezerRejection | null {
  const wanted = (request.durationMs ?? 0) / 1000;
  const got = entry.duration ?? 0;
  if (!(wanted > 0) || !(got > 0)) return "duration_unknown";
  if (Math.abs(wanted - got) > DURATION_TOLERANCE_S) return "duration_differs";
  return null;
}

/**
 * Why an entry that carries the requested ISRC is still not the requested recording, or null
 * (see the file comment for the checks). A title in another script ("Yoru ni Kakeru" for
 * "夜に駆ける") cannot be compared word for word and is left to the ISRC. Its album may differ:
 * the ISRC names the recording on any release.
 */
function isrcMismatch(request: PreviewRequest, entry: DeezerTrack): DeezerRejection | null {
  if (!sameArtistName(leadArtist(request), entry.artist?.name ?? "")) return "artist_differs";
  const requested = { title: request.title, album: request.album };
  const offered = { title: fullTitle(entry), album: entry.album?.title };
  if (
    comparableTitles(requested.title, offered.title) &&
    recordingTitleDifference(requested, offered) === "title"
  ) {
    return "title_differs";
  }
  if (partTitlesDiffer(requested, offered)) return "title_differs";
  if (markedAsOtherVersion(requested, offered)) return "other_version";
  return durationMismatch(request, entry);
}

/**
 * Why an entry not confirmed by the requested ISRC is not the requested recording, or null when
 * it strictly is (see the file comment).
 */
function strictMismatch(request: PreviewRequest, entry: DeezerTrack): DeezerRejection | null {
  if (!sameArtistName(leadArtist(request), entry.artist?.name ?? "")) return "artist_differs";
  const difference = recordingTitleDifference(
    { title: request.title, album: request.album },
    { title: fullTitle(entry), album: entry.album?.title },
  );
  if (difference === "title") return "title_differs";
  if (difference === "version") return "other_version";
  if (!request.album?.trim()) return "album_unknown";
  if (!sameAlbumName(request.album, entry.album?.title)) return "album_differs";
  return durationMismatch(request, entry);
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
  log.info(
    `Matched by ${match.method}: "${entry.title}" by ${entry.artist?.name} (id ${entry.id})`,
  );
  return {
    found: true,
    previewUrl: entry.preview as string,
    match,
    title: entry.title,
    artist: entry.artist?.name ?? "",
  };
}

function notFound(
  rejected: Rejected,
  message: string,
  failure?: { error: string; errorCode: SourceErrorCode },
): DeezerPreviewResult {
  // Deezer failing is a warning; no matching entry is an ordinary outcome.
  if (failure) log.warn(message, { errorCode: failure.errorCode });
  else log.info(message);
  return { found: false, previewUrl: null, rejected, message, ...failure };
}

/**
 * Checks an entry read by its own id or by ISRC: one that carries the requested ISRC passes the
 * checks of an ISRC entry and is reported with `isrcMethod`; any other passes the strict check
 * and is reported as matched by id, with its score.
 */
function judgeEntry(
  request: PreviewRequest,
  entry: DeezerTrack,
  isrcMethod: DeezerMatch["method"],
): { match: DeezerMatch; reason: null } | { match: null; reason: DeezerRejection } {
  const carriesIsrc = sameIsrc(entry.isrc, request.isrc);
  // Whether it is the recording comes first: only the recording's own entry that cannot be
  // played is replaced by its alternative.
  const reason =
    (carriesIsrc ? isrcMismatch(request, entry) : strictMismatch(request, entry)) ??
    unplayable(entry);
  if (reason) return { match: null, reason };
  return {
    reason: null,
    match: carriesIsrc
      ? { provider: "deezer", method: isrcMethod, deezerId: entry.id, score: null }
      : {
          provider: "deezer",
          method: "id",
          deezerId: entry.id,
          score: durationScore(request, entry),
        },
  };
}

/**
 * The preview of the entry Deezer gives for the request's ISRC, or of the readable alternative
 * it names for that entry, each checked as the file comment says. Not found when there is no
 * ISRC, Deezer has no entry for it, or neither entry can be used; the entries turned down are
 * listed, and a search never takes them. `pacing` paces its requests (see DeezerPacing).
 */
export async function deezerPreviewByIsrc(
  request: PreviewRequest,
  signal?: AbortSignal,
  pacing: DeezerPacing = {},
): Promise<DeezerPreviewResult> {
  const rejected: Rejected = [];
  const isrc = request.isrc?.trim();
  if (!isrc) return notFound(rejected, "No ISRC to look up");

  const entry = await deezerGet<DeezerTrack>(
    new URL(`${DEEZER_API_BASE}/track/isrc:${encodeURIComponent(isrc)}`),
    TRACK_SHAPE,
    signal,
    pacing,
  );
  if (!entry || typeof entry.id !== "number") {
    return notFound(rejected, `No entry for ISRC ${isrc}`);
  }

  // An entry that carries another ISRC is not the requested recording, nor is its alternative.
  if (entry.isrc && !sameIsrc(entry.isrc, isrc)) {
    rejected.push({ deezerId: entry.id, method: "isrc", reason: "isrc_differs" });
    return notFound(rejected, `The entry for ISRC ${isrc} carries another ISRC`);
  }
  const judged = judgeEntry(request, entry, "isrc");
  if (judged.match) return found(entry, judged.match);
  rejected.push({ deezerId: entry.id, method: "isrc", reason: judged.reason });

  // Only an entry that is the recording but cannot be played is replaced by its alternative.
  const alternativeId = entry.alternative?.id;
  const replaceable = judged.reason === "not_readable" || judged.reason === "no_preview";
  if (replaceable && typeof alternativeId === "number" && alternativeId !== entry.id) {
    const alternative = await deezerGet<DeezerTrack>(
      new URL(`${DEEZER_API_BASE}/track/${alternativeId}`),
      TRACK_SHAPE,
      signal,
      pacing,
    );
    if (alternative && typeof alternative.id === "number") {
      const checked = judgeEntry(request, alternative, "id");
      if (checked.match) return found(alternative, checked.match);
      rejected.push({ deezerId: alternative.id, method: "id", reason: checked.reason });
    }
  }
  return notFound(rejected, `The entry for ISRC ${isrc} has no usable preview`);
}

/**
 * The preview of a search result that is the requested recording (see the file comment): one
 * that carries the requested ISRC and passes the checks of an ISRC entry, else one that matches
 * strictly (same lead artist, title, version and album, duration within 3 s, whatever ISRC it
 * carries: a remaster or another release of the recording has its own); of several, the one
 * whose duration is closest. Never "any result with a preview", never an entry in `turnedDown`
 * (the ISRC step's rejections).
 */
export async function deezerPreviewBySearch(
  request: PreviewRequest,
  signal?: AbortSignal,
  turnedDown: Rejected = [],
): Promise<DeezerPreviewResult> {
  const rejected: Rejected = [];
  const excluded = new Set(turnedDown.map((entry) => entry.deezerId));
  const artist = leadArtist(request);
  const url = new URL(`${DEEZER_API_BASE}/search/track`);
  url.searchParams.set("q", `${artist} ${request.title}`.trim());
  url.searchParams.set("limit", "10");
  log.info(`Searching: "${request.title}" by ${artist}`);

  const data = await deezerGet<DeezerSearchResponse>(url, SEARCH_SHAPE, signal);
  const entries = Array.isArray(data?.data) ? data.data : [];

  // An entry that carries the requested ISRC is preferred to one that only matches strictly.
  const closer = (a: DeezerTrack, b: DeezerTrack | null) =>
    !b || durationScore(request, a) > durationScore(request, b);
  let byIsrc: DeezerTrack | null = null;
  let best: DeezerTrack | null = null;
  for (const entry of entries) {
    if (typeof entry?.id !== "number") continue;
    const carriesIsrc = sameIsrc(entry.isrc, request.isrc);
    const reason = excluded.has(entry.id)
      ? "turned_down_by_isrc"
      : (unplayable(entry) ??
        (carriesIsrc ? isrcMismatch(request, entry) : strictMismatch(request, entry)));
    if (reason) {
      rejected.push({ deezerId: entry.id, method: "search", reason });
      continue;
    }
    if (carriesIsrc) {
      if (closer(entry, byIsrc)) byIsrc = entry;
    } else if (closer(entry, best)) {
      best = entry;
    }
  }

  if (byIsrc) {
    return found(byIsrc, { provider: "deezer", method: "isrc", deezerId: byIsrc.id, score: null });
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
 * the error is thrown again. A request the pacer refused (PaceRefused) is no failure: the result
 * says Deezer was not asked (`notAsked`), with no error.
 */
export function deezerFailure(
  error: unknown,
  signal: AbortSignal | undefined,
): DeezerPreviewResult {
  if (signal?.aborted) throw error;
  if (error instanceof PaceRefused) {
    log.info(`Not asked: ${error.message}`);
    return {
      found: false,
      previewUrl: null,
      rejected: [],
      message: "Deezer was not asked",
      notAsked: true,
    };
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  log.error(`Error: ${message}`);
  return notFound([], "Deezer could not be read", {
    error: message,
    errorCode: sourceErrorCode(error),
  });
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
    const bySearch = await deezerPreviewBySearch(request, signal, byIsrc.rejected);
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
      "search (same lead artist, title, version and album, duration within 3 s). Returns no " +
      "preview rather than another recording's. No authentication required.",
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
