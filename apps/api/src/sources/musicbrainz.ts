/**
 * MusicBrainz Relations Tool for LangGraph Agent
 *
 * Provides structured genealogy data:
 * - Sample relationships ("sampled by", "samples")
 * - Cover relationships ("cover of", "covered by")
 * - Remix relationships
 * - Artist collaborations
 *
 * Every request goes through one queue that keeps to MusicBrainz's limit of one request per
 * second, and each request has a timeout, so a stuck request cannot hold the queue. A search
 * whose results do not match the title and artist reports "not found" rather than the first hit.
 *
 * @see https://musicbrainz.org/doc/MusicBrainz_API
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  abortError,
  describeError,
  fetchJson,
  isSourceError,
  type Shape,
  SourceError,
} from "./http.js";
import { pacingClock } from "./pacing.js";
import { type NotAskedReason, notAnswered, toolFailure } from "./toolResult.js";
import { logger } from "../logger.js";

const log = logger("MusicBrainz");

// =============================================================================
// TypeScript Interfaces
// =============================================================================

interface MBRelease {
  title?: string;
  date?: string;
  status?: string;
  "release-group"?: { "primary-type"?: string; "secondary-types"?: string[] };
}

interface MBRecording {
  id: string;
  title: string;
  disambiguation?: string;
  "first-release-date"?: string;
  releases?: MBRelease[];
  "artist-credit"?: MBArtistCredit[];
  relations?: MBRelation[];
}

interface MBArtistCredit {
  name: string;
  joinphrase?: string;
  artist: { id: string; name: string };
}

interface MBRelation {
  type: string;
  "type-id": string;
  direction?: "forward" | "backward";
  recording?: { id: string; title: string };
  work?: { id: string; title: string };
  artist?: { id: string; name: string };
  url?: { resource?: string };
  attributes?: string[];
  "target-credit"?: string;
}

interface MBSearchResponse {
  recordings: MBRecording[];
  count: number;
}

export interface MBArtist {
  id: string;
  name: string;
  type?: string;
  country?: string;
  "life-span"?: { begin?: string };
}

interface GenealogyRelation {
  /** "dj-mix": a DJ mix that includes the recording (or that it includes); not a remix. */
  type: "sample" | "cover" | "remix" | "dj-mix" | "influence";
  /**
   * Where the related recording or work stands: "source" when this recording uses it (samples,
   * remixes or covers it), "derived" when it uses this recording (samples it, remixes it, mixes
   * it into a DJ mix).
   */
  direction: "source" | "derived";
  title: string;
  artist?: string;
  mbid: string;
  relationshipType: string;
}

// Fields the pipeline reads, kept when a response is recorded to a cassette.
const ARTIST_CREDIT_SHAPE: Shape = [
  { name: true, joinphrase: true, artist: { id: true, name: true } },
];
const RECORDING_SEARCH_SHAPE: Shape = {
  count: true,
  recordings: [
    {
      id: true,
      title: true,
      score: true,
      disambiguation: true,
      "first-release-date": true,
      "artist-credit": ARTIST_CREDIT_SHAPE,
      releases: [
        {
          title: true,
          date: true,
          status: true,
          "release-group": { "primary-type": true, "secondary-types": true },
        },
      ],
    },
  ],
};
const RECORDING_SHAPE: Shape = {
  id: true,
  title: true,
  "artist-credit": ARTIST_CREDIT_SHAPE,
  relations: [
    {
      type: true,
      "type-id": true,
      direction: true,
      recording: { id: true, title: true },
      work: { id: true, title: true },
      artist: { id: true, name: true },
      attributes: true,
      "target-credit": true,
    },
  ],
};
const ARTIST_SEARCH_SHAPE: Shape = {
  count: true,
  artists: [{ id: true, name: true, score: true, type: true, country: true, disambiguation: true }],
};
const URL_SHAPE: Shape = {
  id: true,
  resource: true,
  relations: [{ type: true, artist: { id: true, name: true }, url: { resource: true } }],
};
const ARTIST_SHAPE: Shape = {
  id: true,
  name: true,
  type: true,
  country: true,
  relations: [{ type: true, artist: { id: true, name: true } }],
};

// =============================================================================
// Rate Limiter (Singleton with Queue)
// MusicBrainz requires max 1 request per second
// =============================================================================

/** Set while the primary-source chain runs: its requests go ahead in the shared queue. */
const chainPriority = new AsyncLocalStorage<true>();

/**
 * Runs `fn` as the primary-source chain: every MusicBrainz request made from it (sync or async)
 * waits its turn ahead of any other request (the researcher's), so another run's research never
 * pushes a chain past its deadline. The order within each lane stays first come, first served.
 */
export function withMusicBrainzPriority<T>(fn: () => T): T {
  return chainPriority.run(true, fn);
}

class MusicBrainzRateLimiter {
  private static instance: MusicBrainzRateLimiter;
  /** When the last request was released, on `pacingClock`. */
  private lastRequestTime = Number.NEGATIVE_INFINITY;
  private minInterval: number = 1100; // 1.1 seconds for safety margin
  /** The primary-source chain's requests: served first. */
  private urgent: Array<() => Promise<void>> = [];
  private queue: Array<() => Promise<void>> = [];
  private processing: boolean = false;

  private constructor() {}

  static getInstance(): MusicBrainzRateLimiter {
    if (!MusicBrainzRateLimiter.instance) {
      MusicBrainzRateLimiter.instance = new MusicBrainzRateLimiter();
    }
    return MusicBrainzRateLimiter.instance;
  }

  /** Tests only: shortens the spacing between requests; returns a restore function. */
  setIntervalForTests(ms: number): () => void {
    const previous = this.minInterval;
    this.minInterval = ms;
    return () => {
      this.minInterval = previous;
    };
  }

  /**
   * Tests only: an idle, empty queue that has sent nothing, for after a test whose timers were
   * dropped while the queue waited (its waiting requests never settle).
   */
  resetForTests(): void {
    this.urgent.length = 0;
    this.queue.length = 0;
    this.processing = false;
    this.lastRequestTime = Number.NEGATIVE_INFINITY;
  }

  /**
   * Execute a request with rate limiting. `fn` must settle on its own (every MusicBrainz request
   * has a timeout), so one request can never stall the queue. When `signal` aborts while the
   * request waits its turn, it leaves the queue at once, rejecting with the signal's reason,
   * and takes no slot. A request made inside `withMusicBrainzPriority` waits in the first lane.
   */
  async execute<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lane = chainPriority.getStore() ? this.urgent : this.queue;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const onAbort = () => {
        const index = lane.indexOf(task);
        if (index >= 0) lane.splice(index, 1);
        reject(signal?.reason);
      };
      // The queue is drained by whichever caller found it idle; bound here, the request runs in
      // its own caller's context, so what it logs carries that caller's run id.
      const task = AsyncLocalStorage.bind(async () => {
        signal?.removeEventListener("abort", onAbort);
        try {
          resolve(await fn());
        } catch (error) {
          reject(error);
        }
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      lane.push(task);

      if (!this.processing) {
        void this.processQueue();
      }
    });
  }

  /** Requests waiting their turn (tests). */
  get pending(): number {
    return this.urgent.length + this.queue.length;
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.pending === 0) return;

    this.processing = true;

    while (this.pending > 0) {
      // On the monotonic clock: a step of the wall clock neither stalls the queue nor lets a
      // request out early. The clock is read again after each wait, so a timer that fires a
      // little early still leaves the full spacing.
      for (;;) {
        const now = pacingClock();
        // A clock that reads earlier than the last request (never performance.now within one
        // process) counts the full spacing from now: it fails closed, never open.
        if (now < this.lastRequestTime) this.lastRequestTime = now;
        const wait = this.minInterval - (now - this.lastRequestTime);
        if (wait <= 0) break;
        await this.delay(Math.ceil(wait));
      }

      // Chosen after the wait: a chain request that came in meanwhile goes first.
      const task = this.urgent.shift() ?? this.queue.shift();
      if (task) {
        this.lastRequestTime = pacingClock();
        await task();
      }
    }

    this.processing = false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// =============================================================================
// Configuration
// =============================================================================

const MB_API_BASE = "https://musicbrainz.org/ws/2";

// Relationship types we care about for genealogy
const GENEALOGY_RELATION_TYPES = [
  "samples",
  "samples material",
  "DJ-mix",
  "remixes",
  "remix",
  "cover",
  "based on",
  "medley",
  "quotation",
];

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isMbid(value: unknown): value is string {
  return typeof value === "string" && MBID.test(value);
}

// =============================================================================
// Helper Functions
// =============================================================================

const rateLimiter = MusicBrainzRateLimiter.getInstance();

/** Escapes Lucene query syntax so a title or name is searched as plain text. */
export function escapeLucene(text: string): string {
  return text.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, "\\$&");
}

/**
 * Lowercase, without accents, punctuation or extra spaces, and "&" read as "and", for comparing
 * names: "Me & Bobby McGee" and "Me and Bobby McGee" are the same title.
 */
export function normalizeName(text: string): string {
  return (
    text
      .normalize("NFKD")
      // Accents are dropped from Latin letters only: in other scripts a combining mark changes
      // the letter (the dakuten of バ is not decoration on ハ).
      .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
      .normalize("NFC")
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
      .trim()
  );
}

/**
 * A title without a featured-artist note: "Song (feat. X)", "Song [ft. X]", "Song - feat. X"
 * always; "Song (with X)" and "Song feat. X" only when X is among `artists`, so "Stay (With
 * Me)" and "Welcome to Ft. Lauderdale" keep their titles.
 */
export function withoutFeatured(title: string, artists: readonly string[] = []): string {
  const credited = new Set(artists.map(normalizeName).filter(Boolean));
  const namesCredited = (text: string) => {
    const parts = text
      .split(/\s*(?:,|&|\band\b|\/)\s*/i)
      .map(normalizeName)
      .filter(Boolean);
    return parts.length > 0 && parts.every((p) => credited.has(p));
  };
  return title
    .replace(/\s*[([]\s*(?:feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]/gi, "")
    .replace(/\s*[([]\s*with\s([^)\]]*)[)\]]/gi, (all, who: string) =>
      namesCredited(who) ? "" : all,
    )
    .replace(/\s+-\s+(?:feat\.?|ft\.?|featuring)\s.*$/i, "")
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s(.*)$/i, (all, who: string) =>
      namesCredited(who) ? "" : all,
    )
    .trim();
}

/**
 * Labels Spotify adds to a track title for a release of the same recording, which MusicBrainz
 * does not put in the title: "Remastered 2011", "2009 Remaster", "Radio Edit", "Single Version",
 * "Album Version", "Mono", "Stereo". A version that is another recording ("Live", "Remix",
 * "Acoustic", "Extended Mix", "Demo") is not one of them and stays in the title.
 */
const RELEASE_LABEL = String.raw`(?:(?:\d{4}\s+)?(?:digital(?:ly)?\s+)?remaster(?:ed)?(?:\s+(?:version|edition))?(?:\s+\d{4})?|radio\s+edit|single\s+(?:version|edit)|album\s+version|(?:mono|stereo)(?:\s+version)?)`;
const RELEASE_LABEL_DASHED = new RegExp(String.raw`\s+-\s+${RELEASE_LABEL}\s*$`, "i");
const RELEASE_LABEL_BRACKETED = new RegExp(String.raw`\s*[([]\s*${RELEASE_LABEL}\s*[)\]]`, "gi");

/**
 * A Spotify track title as MusicBrainz files the recording: without a featured-artist note (see
 * withoutFeatured) and without a release label of the same recording ("Song - Radio Edit",
 * "Song - Remastered 2011", "Song (2009 Remaster)"). A title that would be left empty is kept
 * as it was. Only for the Spotify side: MusicBrainz's own titles keep their labels.
 */
export function recordingTitle(title: string, artists: readonly string[] = []): string {
  const bare = withoutFeatured(title, artists)
    .replace(RELEASE_LABEL_DASHED, "")
    .replace(RELEASE_LABEL_BRACKETED, "")
    .trim();
  return bare || withoutFeatured(title, artists);
}

/** Waits `ms`, or rejects as soon as `signal` aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** The longest wait honoured from a Retry-After before the one retry. */
const MAX_RETRY_WAIT_MS = 2000;

/**
 * A rate-limited GET to the MusicBrainz API (JSON), with a timeout. When MusicBrainz sheds the
 * request (503, or 429) it is retried once, after its Retry-After (at most 2 s), through the
 * queue again.
 */
async function mbFetch<T>(
  path: string,
  params: Record<string, string>,
  scrub: Shape,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(`${MB_API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("fmt", "json");
  const attempt = () =>
    rateLimiter.execute(() => {
      log.info(`Request: /${path}`);
      return fetchJson<T>({
        source: "musicbrainz",
        url,
        headers: { Accept: "application/json" },
        rateLimitStatuses: [429, 503],
        scrub,
        signal,
      });
    }, signal);
  try {
    try {
      return await attempt();
    } catch (error) {
      // Stopped by its signal: never retried.
      if (signal?.aborted || !isSourceError(error, "rate_limited")) throw error;
      await delay(Math.min(error.retryAfterMs ?? MAX_RETRY_WAIT_MS, MAX_RETRY_WAIT_MS), signal);
      return await attempt();
    }
  } catch (error) {
    if (signal?.aborted && !isSourceError(error)) throw abortError("musicbrainz", signal, error);
    throw error;
  }
}

/**
 * True when the recording is credited to exactly the requested artist: the whole credit
 * ("Queen & David Bowie") equals the artist string, or the credited artists are exactly the
 * requested ones, each matched by its credited or canonical name. The requested artists are
 * `artistNames` when given, else the comma-separated parts of `artist` (a Spotify artist
 * string); a part alone never matches, so "Earth, Wind & Fire" is not "Earth".
 */
function creditedTo(recording: MBRecording, artist: string, artistNames?: string[]): boolean {
  const credits = (recording["artist-credit"] ?? []).filter((c) => typeof c?.name === "string");
  if (credits.length === 0) return false;
  const full = normalizeName(credits.map((c) => `${c.name}${c.joinphrase ?? ""}`).join(""));
  if (full === normalizeName(artist)) return true;

  const wanted = [
    ...new Set((artistNames?.length ? artistNames : artist.split(",")).map(normalizeName)),
  ].filter(Boolean);
  if (wanted.length !== credits.length) return false;
  const namesOf = (c: MBArtistCredit) =>
    [c.name, c.artist?.name].filter((n): n is string => typeof n === "string").map(normalizeName);
  return (
    credits.every((c) => namesOf(c).some((n) => wanted.includes(n))) &&
    wanted.every((w) => credits.some((c) => namesOf(c).includes(w)))
  );
}

/**
 * Release-group secondary types that mark a release as not the original one. A soundtrack is
 * not among them: a song can first come out on one.
 */
export const NOT_ORIGINAL_RELEASE_TYPES: ReadonlySet<string> = new Set([
  "compilation",
  "dj-mix",
  "live",
  "remix",
  "mixtape/street",
]);

/** True when the recording is on at least one official release that is not a compilation, live, DJ-mix or remix release. */
function onOriginalRelease(recording: MBRecording): boolean {
  return (recording.releases ?? []).some((release) => {
    const status = release?.status?.toLowerCase();
    if (status && status !== "official") return false;
    const secondary = release?.["release-group"]?.["secondary-types"] ?? [];
    return !secondary.some((type) => NOT_ORIGINAL_RELEASE_TYPES.has(String(type).toLowerCase()));
  });
}

/** An album title without an edition suffix: "X (Remastered 2009)", "X - Deluxe Edition". */
function withoutEdition(album: string): string {
  return album
    .replace(
      /\s*[([][^)\]]*(?:remaster|deluxe|edition|expanded|anniversary|version)[^)\]]*[)\]]/gi,
      "",
    )
    .replace(/\s+-\s+[^-]*(?:remaster|deluxe|edition|expanded|anniversary|version).*$/i, "")
    .trim();
}

type RecordingSearch =
  | { recording: MBRecording }
  | { recording: null; reason: "no_input" | "not_found" | "ambiguous"; detail: string };

/** Orders candidates: no disambiguation first, then most releases, then the earliest release. */
function compareCandidates(a: MBRecording, b: MBRecording): number {
  const disambiguated = (r: MBRecording) => (r.disambiguation?.trim() ? 1 : 0);
  const releases = (r: MBRecording) => r.releases?.length ?? 0;
  const first = (r: MBRecording) => r["first-release-date"] || "9999";
  return (
    disambiguated(a) - disambiguated(b) ||
    releases(b) - releases(a) ||
    first(a).localeCompare(first(b))
  );
}

/**
 * The original recording of a song, or why there is none.
 *
 * The track's title is searched without a featured-artist note or a Spotify release label (see
 * recordingTitle). A candidate's title (without a featured-artist note only: MusicBrainz files
 * "(radio edit)" or "(single version)" recordings apart, and those are not the original) and
 * credited artists must match it exactly; a near title or a partial credit never matches. Popular songs have many exact
 * matches (compilations, live and DJ-mix recordings), so the pick is the candidate with no
 * disambiguation comment that is on an original release (not a compilation, live, DJ-mix or
 * remix release), with the most releases and then the earliest release date. With `album` the
 * search is narrowed to that release. When no candidate is an original, or the best two cannot
 * be told apart, the answer is "ambiguous" rather than a guess. A title or artist with nothing
 * to compare sends no request.
 */
async function searchRecording(
  title: string,
  artist: string,
  artistNames?: string[],
  album?: string,
  signal?: AbortSignal,
): Promise<RecordingSearch> {
  const parts = (artistNames?.length ? artistNames : artist.split(","))
    .map((p) => p.trim())
    .filter((p) => normalizeName(p));
  const bareTitle = recordingTitle(title, parts);
  const wantedTitle = normalizeName(bareTitle);
  if (!wantedTitle || !normalizeName(artist) || parts.length === 0) {
    return { recording: null, reason: "no_input", detail: "nothing to search for" };
  }

  // Every part as its own phrase, so the search finds "Earth, Wind & Fire" and "A feat. B".
  const artistQuery = parts.map((p) => `artist:"${escapeLucene(p)}"`).join(" AND ");
  const release = album ? withoutEdition(album) : "";
  const releaseQuery = normalizeName(release) ? ` AND release:"${escapeLucene(release)}"` : "";
  const query = `recording:"${escapeLucene(bareTitle)}" AND ${artistQuery}${releaseQuery}`;
  const data = await mbFetch<MBSearchResponse>(
    "recording",
    { query, limit: "25" },
    RECORDING_SEARCH_SHAPE,
    signal,
  );

  const exact = (Array.isArray(data?.recordings) ? data.recordings : []).filter(
    (r) =>
      isMbid(r?.id) &&
      typeof r.title === "string" &&
      normalizeName(withoutFeatured(r.title, parts)) === wantedTitle &&
      creditedTo(r, artist, artistNames),
  );
  if (exact.length === 0) {
    return {
      recording: null,
      reason: "not_found",
      detail: "no recording with this title and artist",
    };
  }

  const candidates = exact.filter(onOriginalRelease).sort(compareCandidates);
  const [best, next] = candidates;
  if (!best || best.disambiguation?.trim()) {
    return {
      recording: null,
      reason: "ambiguous",
      detail: `${exact.length} matching recordings, none on an original release`,
    };
  }
  if (next && compareCandidates(best, next) === 0) {
    return {
      recording: null,
      reason: "ambiguous",
      detail: `${candidates.length} matching recordings that cannot be told apart`,
    };
  }
  return { recording: best };
}

/**
 * Get full recording details with relationships
 */
async function getRecordingWithRelations(mbid: string, signal?: AbortSignal): Promise<MBRecording> {
  if (!isMbid(mbid)) throw new SourceError("musicbrainz", "invalid_input", "not an MBID");
  return mbFetch<MBRecording>(
    `recording/${mbid}`,
    // Spaces are sent as "+", the separator MusicBrainz expects.
    { inc: "recording-rels work-rels artist-rels" },
    RECORDING_SHAPE,
    signal,
  );
}

/** The artists named exactly `name` (after normalising) among MusicBrainz's matches. */
async function searchArtistsExact(name: string, signal?: AbortSignal): Promise<MBArtist[]> {
  const wanted = normalizeName(name);
  if (!wanted) return [];
  const data = await mbFetch<{ artists?: MBArtist[] }>(
    "artist",
    { query: `artist:"${escapeLucene(name.trim())}"`, limit: "10" },
    ARTIST_SEARCH_SHAPE,
    signal,
  );
  const exact = (Array.isArray(data?.artists) ? data.artists : []).filter(
    (a) => isMbid(a?.id) && typeof a.name === "string" && normalizeName(a.name) === wanted,
  );
  return exact.filter((a, i) => exact.findIndex((b) => b.id === a.id) === i);
}

/**
 * True when MusicBrainz has exactly one artist with this exact name and it is `mbid`: the name
 * then stands for that artist alone (the check behind asking another source by name).
 */
export async function onlyArtistNamed(
  name: string,
  mbid: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const matches = await searchArtistsExact(name, signal);
  return matches.length === 1 && matches[0].id === mbid;
}

const SPOTIFY_ARTIST_ID = /^[A-Za-z0-9]{22}$/;
const SPOTIFY_ARTIST_URL = /^https?:\/\/open\.spotify\.com\/artist\/([A-Za-z0-9]{22})(?:[/?#]|$)/;

/** The Spotify artist id of a Spotify artist page URL, or null. */
export function spotifyArtistIdOf(url: unknown): string | null {
  return typeof url === "string" ? (url.match(SPOTIFY_ARTIST_URL)?.[1] ?? null) : null;
}

/**
 * The MusicBrainz artists whose relationships link the Spotify artist page with this id; []
 * when MusicBrainz has no such link (it answers 404 for an unknown URL) or the id is malformed.
 * Any other failure (a rate limit, a timeout) is thrown as MusicBrainz's.
 */
async function artistsLinkedToSpotify(
  spotifyArtistId: string,
  fallbackName: string,
  signal?: AbortSignal,
): Promise<MBArtist[]> {
  if (!SPOTIFY_ARTIST_ID.test(spotifyArtistId)) return [];
  try {
    const data = await mbFetch<{
      relations?: Array<{ artist?: { id?: unknown; name?: unknown } }>;
    }>(
      "url",
      { resource: `https://open.spotify.com/artist/${spotifyArtistId}`, inc: "artist-rels" },
      URL_SHAPE,
      signal,
    );
    const linked = (Array.isArray(data?.relations) ? data.relations : []).flatMap((r) =>
      isMbid(r?.artist?.id)
        ? [
            {
              id: r.artist.id,
              name: typeof r.artist.name === "string" ? r.artist.name : fallbackName,
            },
          ]
        : [],
    );
    return linked.filter((a, i) => linked.findIndex((b) => b.id === a.id) === i);
  } catch (error) {
    if (!signal?.aborted && isSourceError(error, "http") && error.status === 404) return [];
    throw error;
  }
}

/**
 * How an artist name resolved on MusicBrainz. `via: "spotify"` is verified (MusicBrainz links it
 * to the track's Spotify artist); `via: "name"` is a single exact-name match, unverified.
 */
export type ArtistMatch =
  | { artist: MBArtist; via: "name" | "spotify" }
  | { artist: null; reason: "no_input" | "not_found" | "ambiguous"; detail: string };

export interface FindArtistOptions {
  /** The track's artists one by one (`name` may join them); the first one is looked up. */
  artistNames?: string[];
  /** The Spotify id of the artist looked up: MusicBrainz's link to it identifies the artist. */
  spotifyArtistId?: string;
  signal?: AbortSignal;
}

/**
 * The MusicBrainz artist for a name; never a different artist and never a guess.
 *
 * When the artist's Spotify id is known, MusicBrainz's link to that Spotify artist page decides
 * (`via: "spotify"`, verified). Only when MusicBrainz has no such link (404) is the name searched.
 * The name looked up is the first of `artistNames` when given (a Spotify artist string joins
 * several artists with ", ", which cannot be told apart from a comma in one name, so the joined
 * string is never searched as one artist), else `name`. Only an exact (normalised) name match is
 * accepted, so "Earth, Wind & Fire" and "Tyler, The Creator" resolve to themselves. A single
 * exact match is returned as `via: "name"`: it is unverified, and its consumers say so (the
 * collaborators lookup rejects it when its own Spotify link names another artist). Several exact
 * matches (Nirvana, Bush, Low…) without a Spotify link are "ambiguous", never the first match.
 * Goes through the rate-limited queue; ListenBrainz resolves artists here too.
 */
export async function findArtist(
  name: string,
  options: FindArtistOptions = {},
): Promise<ArtistMatch> {
  const { signal, spotifyArtistId } = options;
  const names = (options.artistNames ?? []).filter((n) => normalizeName(n));
  const wanted = names.length > 0 ? names[0] : name;
  if (!normalizeName(wanted)) {
    return { artist: null, reason: "no_input", detail: "no artist name to look up" };
  }

  // MusicBrainz's own link to the Spotify artist decides; the name is searched only without one.
  const linked = spotifyArtistId
    ? await artistsLinkedToSpotify(spotifyArtistId, wanted, signal)
    : [];
  if (linked.length === 1) return { artist: linked[0], via: "spotify" };
  if (linked.length > 1) {
    const named = linked.filter((a) => normalizeName(a.name) === normalizeName(wanted));
    if (named.length === 1) return { artist: named[0], via: "spotify" };
    return {
      artist: null,
      reason: "ambiguous",
      detail: `MusicBrainz links ${linked.length} artists to this Spotify artist`,
    };
  }

  const matches = await searchArtistsExact(wanted, signal);
  if (matches.length === 0) {
    return { artist: null, reason: "not_found", detail: `no MusicBrainz artist named "${wanted}"` };
  }
  if (matches.length === 1) return { artist: matches[0], via: "name" };
  return {
    artist: null,
    reason: "ambiguous",
    detail:
      `${matches.length} MusicBrainz artists are named "${wanted}" and none is linked to ` +
      (spotifyArtistId ? "this Spotify artist" : "a known Spotify artist"),
  };
}

/**
 * Parse relations into genealogy format
 */
function parseRelations(relations: MBRelation[]): GenealogyRelation[] {
  const genealogy: GenealogyRelation[] = [];

  for (const rel of relations) {
    // Only process genealogy-relevant relationship types. MusicBrainz has no recording-to-
    // recording cover relationship: a cover is a performance of a work with the "cover" attribute.
    const relType = rel.type.toLowerCase();
    const coverOf =
      relType === "performance" && Boolean(rel.work) && (rel.attributes ?? []).includes("cover");
    if (!coverOf && !GENEALOGY_RELATION_TYPES.some((t) => relType.includes(t.toLowerCase()))) {
      continue;
    }

    let type: GenealogyRelation["type"] = "influence";
    if (relType.includes("sample")) type = "sample";
    else if (coverOf || relType.includes("cover")) type = "cover";
    else if (relType.includes("dj-mix")) type = "dj-mix";
    else if (relType.includes("remix")) type = "remix";

    // A relationship reads from its first entity: "forward" here means this recording samples,
    // remixes or performs the target, so the target is a source; "backward" means the target
    // samples, remixes or DJ-mixes this recording, so it is derived from it.
    const direction: GenealogyRelation["direction"] =
      rel.direction === "backward" ? "derived" : "source";

    const target = rel.recording || rel.work;
    if (target) {
      genealogy.push({
        type,
        direction,
        title: target.title,
        artist: rel["target-credit"] || rel.artist?.name,
        mbid: target.id,
        relationshipType: rel.type,
      });
    }
  }

  return genealogy;
}

/** The credited artists of a recording: the artist's name, the name credited and its MBID. */
function artistCreditOf(
  credits: MBArtistCredit[] | undefined,
): Array<{ name: string; credited: string; mbid: string }> {
  return (Array.isArray(credits) ? credits : []).flatMap((c) =>
    isMbid(c?.artist?.id) && typeof c.artist.name === "string"
      ? [
          {
            name: c.artist.name,
            credited: typeof c.name === "string" ? c.name : c.artist.name,
            mbid: c.artist.id,
          },
        ]
      : [],
  );
}

// =============================================================================
// LangGraph Tools
// =============================================================================

/**
 * Get structured sample and genealogy data from MusicBrainz
 */
export const getMusicBrainzRelations = tool(
  async ({ title, artist, artistNames, album }, config): Promise<string> => {
    const signal = config?.signal;
    try {
      log.info(`Searching: "${title}" by ${artist}`);

      // Step 1: Search for recording
      const search = await searchRecording(title, artist, artistNames, album, signal);

      if (!search.recording) {
        return JSON.stringify(
          notAnswered(
            search.reason,
            `No recording identified on MusicBrainz for "${title}" by ${artist}: ${search.detail}`,
          ),
        );
      }
      const recording = search.recording;

      log.info(`Found MBID: ${recording.id}`);

      // Step 2: Get full recording with relationships
      const fullRecording = await getRecordingWithRelations(recording.id, signal);

      // Step 3: Parse relationships
      const relations = Array.isArray(fullRecording?.relations) ? fullRecording.relations : [];
      const genealogy = parseRelations(relations);

      // Categorize relationships
      const samples = genealogy.filter((r) => r.type === "sample");
      const covers = genealogy.filter((r) => r.type === "cover");
      const remixes = genealogy.filter((r) => r.type === "remix");
      const djMixes = genealogy.filter((r) => r.type === "dj-mix");
      const influences = genealogy.filter((r) => r.type === "influence");

      log.info(
        `Found ${genealogy.length} genealogy relations: ` +
          `${samples.length} samples, ${covers.length} covers, ${remixes.length} remixes ` +
          `(${djMixes.length} DJ-mix inclusions kept apart, not genealogy)`,
      );

      return JSON.stringify({
        found: true,
        mbid: recording.id,
        title: fullRecording.title ?? recording.title,
        artist: fullRecording["artist-credit"]?.[0]?.name,
        // The credited artists with their own MBIDs (the recording's MBID is not an artist's).
        artistCredit: artistCreditOf(fullRecording["artist-credit"] ?? recording["artist-credit"]),
        totalRelations: relations.length,
        genealogy: {
          samples,
          covers,
          remixes,
          djMixes,
          influences,
        },
        // Raw relation types for debugging
        relationTypes: [...new Set(relations.map((r) => r.type))],
      });
    } catch (error) {
      // A cancelled run rejects: nothing is reported for it.
      if (signal?.aborted) throw error;
      log.error(`Error: ${describeError(error)}`);
      return JSON.stringify(toolFailure(error));
    }
  },
  {
    name: "musicbrainz_relations",
    description:
      "Get VERIFIED sample/cover relationships from MusicBrainz. Returns: structured JSON " +
      "with samples, covers, remixes. HIGHEST PRIORITY for genealogy accuracy. DJ mixes that " +
      "include the track (or that it includes) are listed apart as djMixes: they are not " +
      "samples, remixes or influences, and are not genealogy.",
    schema: z.object({
      title: z.string().describe("The exact song title"),
      artist: z.string().describe("The artist name, or Spotify's artist string (joined by ', ')"),
      artistNames: z
        .array(z.string())
        .optional()
        .describe("The track's artists one by one, when known (e.g. Spotify's artist list)"),
      album: z
        .string()
        .optional()
        .describe("The album the track is on, when known; narrows the search to that release"),
    }),
  },
);

/**
 * Get artist discography and related artists
 */
/**
 * MusicBrainz artist-artist relationships that are a collaboration on music: working together,
 * or one playing or singing for the other. Band membership, family, teaching, tributes and
 * "is person" are not collaborations, and are left out of the collaborators.
 */
export const COLLABORATION_TYPES: ReadonlySet<string> = new Set([
  "collaboration",
  "supporting musician",
  "vocal supporting musician",
  "instrumental supporting musician",
]);

export const getMusicBrainzArtist = tool(
  async ({ artistName, artistNames, artistMbid, spotifyArtistId }, config): Promise<string> => {
    const signal = config?.signal;
    try {
      // The artist's own MBID when an earlier step identified it; else its name.
      let id = isMbid(artistMbid) ? artistMbid : null;
      let verified = false;
      if (!id) {
        log.info(`Searching artist: "${artistName}"`);
        const match = await findArtist(artistName, { artistNames, spotifyArtistId, signal });
        if (!match.artist) {
          return JSON.stringify(notAnswered(ARTIST_REASON[match.reason], match.detail));
        }
        id = match.artist.id;
        verified = match.via === "spotify";
      }

      // The artist's relationships, its URL relationships included (the same request).
      const artistData = await mbFetch<{
        id: string;
        name: string;
        type?: string;
        country?: string;
        relations?: MBRelation[];
      }>(`artist/${id}`, { inc: "artist-rels recording-rels url-rels" }, ARTIST_SHAPE, signal);
      const relations = Array.isArray(artistData.relations) ? artistData.relations : [];

      // An artist whose own Spotify links name other Spotify artists is not the track's.
      const spotifyLinks = relations
        .map((r) => spotifyArtistIdOf(r.url?.resource))
        .filter((link): link is string => link !== null);
      if (spotifyArtistId && spotifyLinks.length > 0) {
        if (!spotifyLinks.includes(spotifyArtistId)) {
          return JSON.stringify(
            notAnswered(
              "other_spotify_artist",
              `MusicBrainz artist ${id} links to another Spotify artist`,
            ),
          );
        }
        verified = true;
      }

      const collaborators = relations
        .filter((r) => r.artist && COLLABORATION_TYPES.has(r.type))
        .map((r) => ({
          name: r.artist?.name,
          relationship: r.type,
        }))
        .slice(0, 10);

      return JSON.stringify({
        found: true,
        mbid: id,
        name: artistData.name,
        // Linked to the track's Spotify artist; false: matched by name only.
        verified,
        type: artistData.type,
        country: artistData.country,
        collaborators,
        totalRelations: relations.length,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      log.error(`Artist error: ${describeError(error)}`);
      return JSON.stringify(toolFailure(error));
    }
  },
  {
    name: "musicbrainz_artist",
    description:
      "Get artist collaborators from MusicBrainz. Returns: artists the artist collaborated " +
      "with or played for. Use for artist-based genealogy connections.",
    schema: z.object({
      artistName: z.string().describe("The artist or band name"),
      artistNames: z
        .array(z.string())
        .optional()
        .describe("When artistName joins several artists: the artists one by one"),
      artistMbid: z
        .string()
        .optional()
        .describe("The artist's own MusicBrainz MBID, when known (skips the name search)"),
      spotifyArtistId: z
        .string()
        .optional()
        .describe("The artist's Spotify id: MusicBrainz's link to it identifies the artist"),
    }),
  },
);

/** The tool `reason` of an artist name that did not resolve. */
export const ARTIST_REASON = {
  no_input: "no_input",
  not_found: "artist_not_identified",
  ambiguous: "ambiguous_artist",
} as const satisfies Record<string, NotAskedReason>;

// =============================================================================
// ISRC lookup and recording relationships
// =============================================================================

const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/**
 * A release date as MusicBrainz and Spotify write it: a year ("2011"), a year and month
 * ("2011-10") or a day ("2011-10-18"). Spotify writes "0000" for a date it does not know.
 */
export const RELEASE_DATE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

/**
 * A release date that says when the release came out: one of RELEASE_DATE's shapes whose year
 * is not "0000" (Spotify's unknown date). Anything else, missing or malformed, is null.
 */
export function knownReleaseDate(date: unknown): string | null {
  return typeof date === "string" && RELEASE_DATE.test(date) && !date.startsWith("0000")
    ? date
    : null;
}

/** The year of a known release date ("2011" for "2011-10-18"); undefined when it is unknown. */
export function releaseYearOf(date: unknown): string | undefined {
  return knownReleaseDate(date)?.slice(0, 4);
}

/** An ISRC in its canonical form (upper case, no hyphens, dashes or spaces), or null. */
export function normalizeIsrc(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const isrc = value.replace(/[\s\u2010-\u2015-]/g, "").toUpperCase();
  return ISRC.test(isrc) ? isrc : null;
}

export interface MbCredit {
  name: string;
  joinphrase?: string;
  artist?: { id: string; name: string };
}

export interface MbRecordingSummary {
  id: string;
  title: string;
  "first-release-date"?: string;
  /** Milliseconds; null when MusicBrainz does not know it. */
  length?: number | null;
  disambiguation?: string;
  "artist-credit"?: MbCredit[];
}

export interface MbDetailRelation {
  type: string;
  /** "forward": this entity acts on the other ("samples"); "backward": the other acts on it. */
  direction?: string;
  "target-type"?: string;
  attributes?: string[];
  recording?: MbRecordingSummary;
  work?: { id: string; title: string; relations?: MbDetailRelation[] };
  url?: { resource: string };
}

export interface MbRecordingDetails extends MbRecordingSummary {
  relations?: MbDetailRelation[];
}

export interface MbReleaseSummary {
  id: string;
  title: string;
  date?: string;
  status?: string | null;
  "release-group"?: { "primary-type"?: string | null; "secondary-types"?: string[] };
  /** Whether the Cover Art Archive holds a front image of the release. */
  "cover-art-archive"?: { front?: boolean };
  relations?: MbDetailRelation[];
}

export interface MbWork {
  id: string;
  title: string;
  relations?: MbDetailRelation[];
}

const CREDIT_SHAPE: Shape = [{ name: true, joinphrase: true, artist: { id: true, name: true } }];
const RECORDING_SUMMARY_SHAPE: Shape = {
  id: true,
  title: true,
  "first-release-date": true,
  length: true,
  disambiguation: true,
  "artist-credit": CREDIT_SHAPE,
};
const URL_RELATION_SHAPE: Shape = [
  { type: true, direction: true, "target-type": true, url: { resource: true } },
];
const ISRC_SHAPE: Shape = { isrc: true, recordings: [RECORDING_SUMMARY_SHAPE] };
const RECORDING_DETAILS_SHAPE: Shape = {
  ...RECORDING_SUMMARY_SHAPE,
  relations: [
    {
      type: true,
      direction: true,
      "target-type": true,
      attributes: true,
      recording: RECORDING_SUMMARY_SHAPE,
      work: { id: true, title: true, relations: URL_RELATION_SHAPE },
      url: { resource: true },
    },
  ],
};
const RELEASE_BROWSE_SHAPE: Shape = {
  "release-count": true,
  "release-offset": true,
  releases: [
    {
      id: true,
      title: true,
      date: true,
      status: true,
      "release-group": { "primary-type": true, "secondary-types": true },
      "cover-art-archive": { front: true },
      relations: URL_RELATION_SHAPE,
    },
  ],
};
const WORK_SHAPE: Shape = {
  id: true,
  title: true,
  relations: [
    {
      type: true,
      direction: true,
      "target-type": true,
      attributes: true,
      recording: RECORDING_SUMMARY_SHAPE,
    },
  ],
};

/**
 * The recordings MusicBrainz files under an ISRC; empty when it knows none (it answers 404).
 * Several recordings can share one ISRC (an edit filed with the album version's code), so the
 * caller still checks title, artist and duration.
 */
export async function lookupIsrc(
  isrc: string,
  signal?: AbortSignal,
): Promise<MbRecordingSummary[]> {
  const code = normalizeIsrc(isrc);
  if (!code) throw new SourceError("musicbrainz", "invalid_input", "not an ISRC");
  try {
    const data = await mbFetch<{ recordings?: MbRecordingSummary[] }>(
      `isrc/${code}`,
      { inc: "artist-credits" },
      ISRC_SHAPE,
      signal,
    );
    return (Array.isArray(data?.recordings) ? data.recordings : []).filter(
      (r) => isMbid(r?.id) && typeof r.title === "string",
    );
  } catch (error) {
    if (isSourceError(error, "http") && error.status === 404) return [];
    throw error;
  }
}

/** A recording with its recording and work relationships, and the URLs linked to its works. */
export async function getRecordingDetails(
  mbid: string,
  signal?: AbortSignal,
): Promise<MbRecordingDetails> {
  if (!isMbid(mbid)) throw new SourceError("musicbrainz", "invalid_input", "not an MBID");
  return mbFetch<MbRecordingDetails>(
    `recording/${mbid}`,
    { inc: "artist-credits recording-rels work-rels work-level-rels url-rels" },
    RECORDING_DETAILS_SHAPE,
    signal,
  );
}

const RELEASE_PAGE = 100;

/**
 * The official album, single and EP releases a recording is on, with their URL relationships
 * (Discogs links), release-group types and whether the Cover Art Archive holds a front image of
 * each. Reads at most `maxPages` pages of 100.
 */
export async function browseRecordingReleases(
  mbid: string,
  maxPages = 2,
  signal?: AbortSignal,
): Promise<{ releases: MbReleaseSummary[]; total: number }> {
  if (!isMbid(mbid)) throw new SourceError("musicbrainz", "invalid_input", "not an MBID");
  const releases: MbReleaseSummary[] = [];
  let total = 0;
  for (let page = 0; page < maxPages; page++) {
    const data = await mbFetch<{ "release-count"?: number; releases?: MbReleaseSummary[] }>(
      "release",
      {
        recording: mbid,
        status: "official",
        type: "album|single|ep",
        inc: "url-rels release-groups",
        limit: String(RELEASE_PAGE),
        offset: String(page * RELEASE_PAGE),
      },
      RELEASE_BROWSE_SHAPE,
      signal,
    );
    const batch = (Array.isArray(data?.releases) ? data.releases : []).filter((r) => isMbid(r?.id));
    releases.push(...batch);
    total = typeof data?.["release-count"] === "number" ? data["release-count"] : releases.length;
    if (batch.length < RELEASE_PAGE || releases.length >= total) break;
  }
  return { releases, total };
}

/** A work with the recordings that perform it (each with its credit and attributes). */
export async function getWorkRecordings(workMbid: string, signal?: AbortSignal): Promise<MbWork> {
  if (!isMbid(workMbid)) throw new SourceError("musicbrainz", "invalid_input", "not an MBID");
  return mbFetch<MbWork>(
    `work/${workMbid}`,
    { inc: "recording-rels artist-credits" },
    WORK_SHAPE,
    signal,
  );
}

const WORK_RECORDINGS_SHAPE: Shape = {
  "recording-count": true,
  recordings: [RECORDING_SUMMARY_SHAPE],
};

/**
 * The recordings of a work with their first release dates (the work lookup has no dates). Reads
 * at most `maxPages` pages of 100; `total` says how many there are.
 */
export async function browseWorkRecordings(
  workMbid: string,
  maxPages = 2,
  signal?: AbortSignal,
): Promise<{ recordings: MbRecordingSummary[]; total: number }> {
  if (!isMbid(workMbid)) throw new SourceError("musicbrainz", "invalid_input", "not an MBID");
  const recordings: MbRecordingSummary[] = [];
  let total = 0;
  for (let page = 0; page < maxPages; page++) {
    const data = await mbFetch<{ "recording-count"?: number; recordings?: MbRecordingSummary[] }>(
      "recording",
      {
        work: workMbid,
        inc: "artist-credits",
        limit: String(RELEASE_PAGE),
        offset: String(page * RELEASE_PAGE),
      },
      WORK_RECORDINGS_SHAPE,
      signal,
    );
    const batch = (Array.isArray(data?.recordings) ? data.recordings : []).filter((r) =>
      isMbid(r?.id),
    );
    recordings.push(...batch);
    total =
      typeof data?.["recording-count"] === "number" ? data["recording-count"] : recordings.length;
    if (batch.length < RELEASE_PAGE || recordings.length >= total) break;
  }
  return { recordings, total };
}

/** The credit as MusicBrainz prints it: "Queen & David Bowie". */
export function creditString(credits: MbCredit[] | undefined): string {
  return (Array.isArray(credits) ? credits : [])
    .filter((c) => typeof c?.name === "string")
    .map((c) => `${c.name}${c.joinphrase ?? ""}`)
    .join("")
    .trim();
}

export type MbRelationshipKind =
  | "samples"
  | "sampled-by"
  | "remix-of"
  | "remixed-by"
  | "cover-of"
  | "covered-by";

export interface MbRelationship {
  kind: MbRelationshipKind;
  /**
   * "track": a fact about the matched recording. "work": a fact about the song it performs (a
   * cover of the work), not claimed for this recording.
   */
  about: "track" | "work";
  /** The Evidence item that states this relationship; its recordRef carries the scope. */
  evidenceId: string;
  /** The related recording; null when the relationship is to a work. */
  recording: { mbid: string; title: string; artist: string; lengthMs: number | null } | null;
  work: { mbid: string; title: string } | null;
  attributes: string[];
}

/**
 * Relationships kept once per kind and other end: MusicBrainz can file one relationship twice
 * (two performance relationships to one work, with different dates).
 */
class UniqueRelationships {
  readonly list: MbRelationship[] = [];
  private readonly seen = new Set<string>();

  add(relationship: MbRelationship): void {
    const other = relationship.recording?.mbid ?? `work:${relationship.work?.mbid}`;
    const key = `${relationship.kind} ${other}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.list.push(relationship);
  }
}

const relatedRecording = (r: MbRecordingSummary): MbRelationship["recording"] => ({
  mbid: r.id,
  title: r.title,
  artist: creditString(r["artist-credit"]),
  lengthMs: typeof r.length === "number" ? r.length : null,
});

/**
 * Samples, remixes and covers from a recording's own relationships. A relationship's direction
 * says which end acts: "samples material" forward means this recording samples the other one,
 * backward that the other one samples this. A performance of a work with the "cover" attribute
 * makes this recording a cover of that work.
 */
export function recordingRelationships(details: MbRecordingDetails): MbRelationship[] {
  const out = new UniqueRelationships();
  for (const rel of Array.isArray(details?.relations) ? details.relations : []) {
    const attributes = Array.isArray(rel.attributes) ? rel.attributes.map(String) : [];
    const forward = rel.direction !== "backward";
    if (rel.recording && isMbid(rel.recording.id) && typeof rel.recording.title === "string") {
      let kind: MbRelationshipKind | null = null;
      if (rel.type === "samples material") kind = forward ? "samples" : "sampled-by";
      else if (rel.type === "remix") kind = forward ? "remix-of" : "remixed-by";
      if (kind) {
        out.add({
          kind,
          about: "track",
          evidenceId: "",
          recording: relatedRecording(rel.recording),
          work: null,
          attributes,
        });
      }
    } else if (
      rel.type === "performance" &&
      rel.work &&
      isMbid(rel.work.id) &&
      attributes.includes("cover")
    ) {
      out.add({
        kind: "cover-of",
        about: "track",
        evidenceId: "",
        recording: null,
        work: { mbid: rel.work.id, title: rel.work.title },
        attributes,
      });
    }
  }
  return out.list;
}

/**
 * The recordings filed as covers of a work, other than `ownRecording`. These are covers of the
 * work (the song), not of any one recording of it.
 */
export function workCovers(work: MbWork, ownRecording: string): MbRelationship[] {
  const out = new UniqueRelationships();
  for (const rel of Array.isArray(work?.relations) ? work.relations : []) {
    const attributes = Array.isArray(rel.attributes) ? rel.attributes.map(String) : [];
    const recording = rel.recording;
    if (
      rel.type !== "performance" ||
      !attributes.includes("cover") ||
      !recording ||
      !isMbid(recording.id) ||
      recording.id === ownRecording ||
      typeof recording.title !== "string"
    ) {
      continue;
    }
    out.add({
      kind: "covered-by",
      about: "work",
      evidenceId: "",
      recording: relatedRecording(recording),
      work: { mbid: work.id, title: work.title },
      attributes,
    });
  }
  return out.list;
}

// =============================================================================
// Exports
// =============================================================================

export const musicBrainzTools = [getMusicBrainzRelations, getMusicBrainzArtist];
export { MusicBrainzRateLimiter };
