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
import { describeError, fetchJson, type Shape, SourceError } from "./http.js";

dotenv.config();

// =============================================================================
// TypeScript Interfaces
// =============================================================================

interface MBRecording {
  id: string;
  title: string;
  "artist-credit"?: Array<{
    name: string;
    artist: { id: string; name: string };
  }>;
  relations?: MBRelation[];
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
const ARTIST_CREDIT_SHAPE: Shape = [{ name: true, artist: { id: true, name: true } }];
const RECORDING_SEARCH_SHAPE: Shape = {
  count: true,
  recordings: [{ id: true, title: true, score: true, "artist-credit": ARTIST_CREDIT_SHAPE }],
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

/** Lowercase, without accents, punctuation or extra spaces, for comparing names. */
function normalizeName(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A rate-limited GET to the MusicBrainz API (JSON), with a timeout. */
async function mbFetch<T>(path: string, params: Record<string, string>, scrub: Shape): Promise<T> {
  const url = new URL(`${MB_API_BASE}/${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set("fmt", "json");
  return rateLimiter.execute(() => {
    console.log(`🧠 [MusicBrainz] Request: /${path}`);
    return fetchJson<T>({
      source: "musicbrainz",
      url,
      headers: { Accept: "application/json" },
      rateLimitStatuses: [429, 503],
      scrub,
    });
  });
}

/**
 * The recording matching the title and the (first credited) artist, or null when no result
 * matches: an unrelated first hit is never used.
 */
async function searchRecording(title: string, artist: string): Promise<MBRecording | null> {
  const firstArtist = artist.split(",")[0].trim();
  const query = `recording:"${escapeLucene(title)}" AND artist:"${escapeLucene(firstArtist)}"`;
  const data = await mbFetch<MBSearchResponse>(
    "recording",
    { query, limit: "5" },
    RECORDING_SEARCH_SHAPE,
  );

  const normalizedTitle = normalizeName(title);
  const normalizedArtist = normalizeName(firstArtist);
  if (!normalizedTitle || !normalizedArtist) return null;

  return (
    (data.recordings ?? []).find((r) => {
      if (!isMbid(r?.id) || typeof r.title !== "string") return false;
      const rTitle = normalizeName(r.title);
      const rArtist = normalizeName(r["artist-credit"]?.[0]?.name ?? "");
      return rTitle.includes(normalizedTitle) && rArtist.includes(normalizedArtist);
    }) ?? null
  );
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

/**
 * The artist whose name matches `name` (ignoring case, accents and punctuation), or null.
 * Goes through the rate-limited queue; other sources (ListenBrainz) resolve artists here.
 */
export async function findArtist(name: string): Promise<MBArtist | null> {
  const firstArtist = name.split(",")[0].trim();
  const wanted = normalizeName(firstArtist);
  if (!wanted) return null;
  const data = await mbFetch<{ artists?: MBArtist[] }>(
    "artist",
    { query: `artist:"${escapeLucene(firstArtist)}"`, limit: "5" },
    ARTIST_SEARCH_SHAPE,
  );
  return (
    (data.artists ?? []).find(
      (a) => isMbid(a?.id) && typeof a.name === "string" && normalizeName(a.name) === wanted,
    ) ?? null
  );
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
  async ({ title, artist }): Promise<string> => {
    try {
      console.log(`🧠 [MusicBrainz] Searching: "${title}" by ${artist}`);

      // Step 1: Search for recording
      const recording = await searchRecording(title, artist);

      if (!recording) {
        return JSON.stringify({
          found: false,
          message: `No recording found on MusicBrainz for "${title}" by ${artist}`,
          relations: [],
        });
      }

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
      artist: z.string().describe("The artist name"),
    }),
  },
);

/**
 * Get artist discography and related artists
 */
export const getMusicBrainzArtist = tool(
  async ({ artistName }): Promise<string> => {
    try {
      console.log(`🧠 [MusicBrainz] Searching artist: "${artistName}"`);

      const artist = await findArtist(artistName);
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
    }),
  },
);

// =============================================================================
// Exports
// =============================================================================

export const musicBrainzTools = [getMusicBrainzRelations, getMusicBrainzArtist];
export { MusicBrainzRateLimiter };
