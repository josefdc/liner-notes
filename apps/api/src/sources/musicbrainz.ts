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

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import dotenv from "dotenv";
import { describeError, fetchJson, isSourceError, type Shape, SourceError } from "./http.js";

dotenv.config();

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
  attributes?: string[];
  "target-credit"?: string;
}

interface MBSearchResponse {
  recordings: MBRecording[];
  count: number;
}

interface MBArtist {
  id: string;
  name: string;
  type?: string;
  country?: string;
  "life-span"?: { begin?: string };
}

interface GenealogyRelation {
  type: "sample" | "cover" | "remix" | "influence";
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
  artists: [{ id: true, name: true, score: true, type: true, country: true }],
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

class MusicBrainzRateLimiter {
  private static instance: MusicBrainzRateLimiter;
  private lastRequestTime: number = 0;
  private minInterval: number = 1100; // 1.1 seconds for safety margin
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
   * Execute a request with rate limiting. `fn` must settle on its own (every MusicBrainz request
   * has a timeout), so one request can never stall the queue.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await fn());
        } catch (error) {
          reject(error);
        }
      });

      if (!this.processing) {
        void this.processQueue();
      }
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;

    while (this.queue.length > 0) {
      const elapsed = Date.now() - this.lastRequestTime;

      if (elapsed < this.minInterval) {
        await this.delay(this.minInterval - elapsed);
      }

      const task = this.queue.shift();
      if (task) {
        this.lastRequestTime = Date.now();
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
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A title without a featured-artist suffix: "Song (feat. X)", "Song - feat. X", "Song ft. X". */
export function withoutFeatured(title: string): string {
  return title
    .replace(/\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, "")
    .replace(/\s+(?:-\s+)?(?:feat\.?|ft\.?|featuring)\s.*$/i, "")
    .trim();
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The longest wait honoured from a Retry-After before the one retry. */
const MAX_RETRY_WAIT_MS = 2000;

/**
 * A rate-limited GET to the MusicBrainz API (JSON), with a timeout. When MusicBrainz sheds the
 * request (503, or 429) it is retried once, after its Retry-After (at most 2 s), through the
 * queue again.
 */
async function mbFetch<T>(path: string, params: Record<string, string>, scrub: Shape): Promise<T> {
  const url = new URL(`${MB_API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("fmt", "json");
  const attempt = () =>
    rateLimiter.execute(() => {
      console.log(`🧠 [MusicBrainz] Request: /${path}`);
      return fetchJson<T>({
        source: "musicbrainz",
        url,
        headers: { Accept: "application/json" },
        rateLimitStatuses: [429, 503],
        scrub,
      });
    });
  try {
    return await attempt();
  } catch (error) {
    if (!isSourceError(error, "rate_limited")) throw error;
    await delay(Math.min(error.retryAfterMs ?? MAX_RETRY_WAIT_MS, MAX_RETRY_WAIT_MS));
    return attempt();
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

/** Release-group types that mark a release as not the original one. */
const NOT_ORIGINAL = new Set(["compilation", "dj-mix", "live", "remix", "mixtape/street"]);

/** True when the recording is on at least one official release that is not a compilation, live, DJ-mix or remix release. */
function onOriginalRelease(recording: MBRecording): boolean {
  return (recording.releases ?? []).some((release) => {
    const status = release?.status?.toLowerCase();
    if (status && status !== "official") return false;
    const secondary = release?.["release-group"]?.["secondary-types"] ?? [];
    return !secondary.some((type) => NOT_ORIGINAL.has(String(type).toLowerCase()));
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
  | { recording: null; reason: "not_found" | "ambiguous"; detail: string };

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
 * A candidate's title (without a featured-artist suffix) and credited artists must match
 * exactly; a near title or a partial credit never matches. Popular songs have many exact
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
): Promise<RecordingSearch> {
  const bareTitle = withoutFeatured(title);
  const wantedTitle = normalizeName(bareTitle);
  const parts = (artistNames?.length ? artistNames : artist.split(","))
    .map((p) => p.trim())
    .filter((p) => normalizeName(p));
  if (!wantedTitle || !normalizeName(artist) || parts.length === 0) {
    return { recording: null, reason: "not_found", detail: "nothing to search for" };
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
  );

  const exact = (Array.isArray(data?.recordings) ? data.recordings : []).filter(
    (r) =>
      isMbid(r?.id) &&
      typeof r.title === "string" &&
      normalizeName(withoutFeatured(r.title)) === wantedTitle &&
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
async function getRecordingWithRelations(mbid: string): Promise<MBRecording> {
  if (!isMbid(mbid)) throw new SourceError("musicbrainz", "invalid_input", "not an MBID");
  return mbFetch<MBRecording>(
    `recording/${mbid}`,
    // Spaces are sent as "+", the separator MusicBrainz expects.
    { inc: "recording-rels work-rels artist-rels" },
    RECORDING_SHAPE,
  );
}

/** The artist named exactly `name` (after normalising) among MusicBrainz's matches, or null. */
async function searchArtistExact(name: string): Promise<MBArtist | null> {
  const wanted = normalizeName(name);
  if (!wanted) return null;
  const data = await mbFetch<{ artists?: MBArtist[] }>(
    "artist",
    { query: `artist:"${escapeLucene(name.trim())}"`, limit: "10" },
    ARTIST_SEARCH_SHAPE,
  );
  return (
    (Array.isArray(data?.artists) ? data.artists : []).find(
      (a) => isMbid(a?.id) && typeof a.name === "string" && normalizeName(a.name) === wanted,
    ) ?? null
  );
}

/**
 * The MusicBrainz artist for a name, or null; never a different artist.
 *
 * `name` is searched whole and only an exact (normalised) name match is accepted, so
 * "Earth, Wind & Fire" and "Tyler, The Creator" resolve to themselves. When several artists share
 * that exact name, the first one in MusicBrainz's ranking is taken. A Spotify artist string
 * joins several artists with ", ", which cannot be told apart from a comma in one name; when the
 * caller passes the separate `artistNames`, the first one is tried if the whole name has no
 * match. Goes through the rate-limited queue; ListenBrainz resolves artists here too.
 */
export async function findArtist(name: string, artistNames?: string[]): Promise<MBArtist | null> {
  const whole = await searchArtistExact(name);
  if (whole) return whole;
  const first = artistNames?.find((n) => normalizeName(n));
  if (first && normalizeName(first) !== normalizeName(name)) return searchArtistExact(first);
  return null;
}

/**
 * Parse relations into genealogy format
 */
function parseRelations(relations: MBRelation[]): GenealogyRelation[] {
  const genealogy: GenealogyRelation[] = [];

  for (const rel of relations) {
    // Only process genealogy-relevant relationship types
    const relType = rel.type.toLowerCase();
    if (!GENEALOGY_RELATION_TYPES.some((t) => relType.includes(t))) {
      continue;
    }

    let type: GenealogyRelation["type"] = "influence";
    if (relType.includes("sample")) type = "sample";
    else if (relType.includes("cover")) type = "cover";
    else if (relType.includes("remix") || relType.includes("dj-mix")) type = "remix";

    const direction: "source" | "derived" = rel.direction === "backward" ? "source" : "derived";

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

// =============================================================================
// LangGraph Tools
// =============================================================================

/**
 * Get structured sample and genealogy data from MusicBrainz
 */
export const getMusicBrainzRelations = tool(
  async ({ title, artist, artistNames, album }): Promise<string> => {
    try {
      console.log(`🧠 [MusicBrainz] Searching: "${title}" by ${artist}`);

      // Step 1: Search for recording
      const search = await searchRecording(title, artist, artistNames, album);

      if (!search.recording) {
        return JSON.stringify({
          found: false,
          reason: search.reason,
          message: `No recording identified on MusicBrainz for "${title}" by ${artist}: ${search.detail}`,
          relations: [],
        });
      }
      const recording = search.recording;

      console.log(`🧠 [MusicBrainz] Found MBID: ${recording.id}`);

      // Step 2: Get full recording with relationships
      const fullRecording = await getRecordingWithRelations(recording.id);

      // Step 3: Parse relationships
      const relations = Array.isArray(fullRecording?.relations) ? fullRecording.relations : [];
      const genealogy = parseRelations(relations);

      // Categorize relationships
      const samples = genealogy.filter((r) => r.type === "sample");
      const covers = genealogy.filter((r) => r.type === "cover");
      const remixes = genealogy.filter((r) => r.type === "remix");
      const influences = genealogy.filter((r) => r.type === "influence");

      console.log(
        `✅ [MusicBrainz] Found ${genealogy.length} genealogy relations: ` +
          `${samples.length} samples, ${covers.length} covers, ${remixes.length} remixes`,
      );

      return JSON.stringify({
        found: true,
        mbid: recording.id,
        title: fullRecording.title ?? recording.title,
        artist: fullRecording["artist-credit"]?.[0]?.name,
        totalRelations: relations.length,
        genealogy: {
          samples,
          covers,
          remixes,
          influences,
        },
        // Raw relation types for debugging
        relationTypes: [...new Set(relations.map((r) => r.type))],
      });
    } catch (error) {
      const message = describeError(error);
      console.error("❌ [MusicBrainz] Error:", message);
      return JSON.stringify({
        found: false,
        error: `MusicBrainz lookup failed: ${message}`,
        relations: [],
      });
    }
  },
  {
    name: "musicbrainz_relations",
    description:
      "Get VERIFIED sample/cover relationships from MusicBrainz. Returns: structured JSON " +
      "with samples, covers, remixes. HIGHEST PRIORITY for genealogy accuracy.",
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
export const getMusicBrainzArtist = tool(
  async ({ artistName, artistNames }): Promise<string> => {
    try {
      console.log(`🧠 [MusicBrainz] Searching artist: "${artistName}"`);

      const artist = await findArtist(artistName, artistNames);
      if (!artist) {
        return JSON.stringify({
          found: false,
          message: `Artist "${artistName}" not found`,
        });
      }

      // Get artist relationships
      const artistData = await mbFetch<{
        id: string;
        name: string;
        type?: string;
        country?: string;
        relations?: MBRelation[];
      }>(`artist/${artist.id}`, { inc: "artist-rels recording-rels" }, ARTIST_SHAPE);

      // Extract collaborators and influences
      const relations = Array.isArray(artistData.relations) ? artistData.relations : [];
      const collaborators = relations
        .filter((r) => r.artist && r.type !== "member of band")
        .map((r) => ({
          name: r.artist?.name,
          relationship: r.type,
        }))
        .slice(0, 10);

      return JSON.stringify({
        found: true,
        mbid: artist.id,
        name: artistData.name,
        type: artistData.type,
        country: artistData.country,
        collaborators,
        totalRelations: relations.length,
      });
    } catch (error) {
      const message = describeError(error);
      console.error("❌ [MusicBrainz] Artist error:", message);
      return JSON.stringify({ found: false, error: message });
    }
  },
  {
    name: "musicbrainz_artist",
    description:
      "Get artist collaborators from MusicBrainz. Returns: related artists, band members. " +
      "Use for artist-based genealogy connections.",
    schema: z.object({
      artistName: z.string().describe("The artist or band name"),
      artistNames: z
        .array(z.string())
        .optional()
        .describe("When artistName joins several artists: the artists one by one"),
    }),
  },
);

// =============================================================================
// Exports
// =============================================================================

export const musicBrainzTools = [getMusicBrainzRelations, getMusicBrainzArtist];
export { MusicBrainzRateLimiter };
