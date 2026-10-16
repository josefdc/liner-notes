/**
 * MusicBrainz Relations Tool for LangGraph Agent
 *
 * Provides structured genealogy data:
 * - Sample relationships ("sampled by", "samples")
 * - Cover relationships ("cover of", "covered by")
 * - Remix relationships
 * - Artist collaborations
 *
 * Uses MusicBrainz API v2 with rate limiting (1 req/sec)
 *
 * @see https://musicbrainz.org/doc/MusicBrainz_API
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import dotenv from "dotenv";

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

interface GenealogyRelation {
  type: "sample" | "cover" | "remix" | "influence";
  direction: "source" | "derived";
  title: string;
  artist?: string;
  mbid: string;
  relationshipType: string;
}

// =============================================================================
// Rate Limiter (Singleton with Queue)
// MusicBrainz requires max 1 request per second
// =============================================================================

class MusicBrainzRateLimiter {
  private static instance: MusicBrainzRateLimiter;
  private lastRequestTime: number = 0;
  private readonly minInterval: number = 1100; // 1.1 seconds for safety margin
  private queue: Array<() => Promise<void>> = [];
  private processing: boolean = false;

  private constructor() {}

  static getInstance(): MusicBrainzRateLimiter {
    if (!MusicBrainzRateLimiter.instance) {
      MusicBrainzRateLimiter.instance = new MusicBrainzRateLimiter();
    }
    return MusicBrainzRateLimiter.instance;
  }

  /**
   * Execute a request with rate limiting
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });

      if (!this.processing) {
        this.processQueue();
      }
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;

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
const USER_AGENT = process.env.MUSICBRAINZ_USER_AGENT || "SonicAgent/1.0 (contact@example.com)";

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

// =============================================================================
// Helper Functions
// =============================================================================

const rateLimiter = MusicBrainzRateLimiter.getInstance();

/**
 * Make a rate-limited request to MusicBrainz API
 */
async function mbFetch<T>(url: string): Promise<T> {
  return rateLimiter.execute(async () => {
    console.log(`🧠 [MusicBrainz] Request: ${url.replace(MB_API_BASE, "")}`);

    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });

    if (response.status === 503) {
      throw new Error("MusicBrainz rate limited - please retry later");
    }

    if (!response.ok) {
      throw new Error(`MusicBrainz API error: ${response.status}`);
    }

    return response.json() as Promise<T>;
  });
}

/**
 * Search for a recording by title and artist
 */
async function searchRecording(
  title: string,
  artist: string
): Promise<MBRecording | null> {
  const query = encodeURIComponent(`recording:"${title}" AND artist:"${artist}"`);
  const url = `${MB_API_BASE}/recording?query=${query}&limit=5&fmt=json`;

  const data = await mbFetch<MBSearchResponse>(url);

  if (!data.recordings || data.recordings.length === 0) {
    return null;
  }

  // Find best match
  const normalizedTitle = title.toLowerCase().trim();
  const normalizedArtist = artist.toLowerCase().split(",")[0].trim();

  const match = data.recordings.find((r) => {
    const rTitle = r.title.toLowerCase();
    const rArtist = r["artist-credit"]?.[0]?.name?.toLowerCase() || "";
    return (
      (rTitle === normalizedTitle || rTitle.includes(normalizedTitle)) &&
      (rArtist === normalizedArtist || rArtist.includes(normalizedArtist))
    );
  }) || data.recordings[0];

  return match;
}

/**
 * Get full recording details with relationships
 */
async function getRecordingWithRelations(
  mbid: string
): Promise<MBRecording | null> {
  const url = `${MB_API_BASE}/recording/${mbid}?inc=recording-rels+work-rels+artist-rels&fmt=json`;
  return mbFetch<MBRecording>(url);
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

    const direction: "source" | "derived" =
      rel.direction === "backward" ? "source" : "derived";

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

      if (!fullRecording) {
        return JSON.stringify({
          found: true,
          mbid: recording.id,
          title: recording.title,
          relations: [],
          message: "Recording found but no relationships available",
        });
      }

      // Step 3: Parse relationships
      const relations = fullRecording.relations || [];
      const genealogy = parseRelations(relations);

      // Categorize relationships
      const samples = genealogy.filter((r) => r.type === "sample");
      const covers = genealogy.filter((r) => r.type === "cover");
      const remixes = genealogy.filter((r) => r.type === "remix");
      const influences = genealogy.filter((r) => r.type === "influence");

      console.log(
        `✅ [MusicBrainz] Found ${genealogy.length} genealogy relations: ` +
          `${samples.length} samples, ${covers.length} covers, ${remixes.length} remixes`
      );

      return JSON.stringify({
        found: true,
        mbid: recording.id,
        title: fullRecording.title,
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
      const message = error instanceof Error ? error.message : "Unknown error";
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
  }
);

/**
 * Get artist discography and related artists
 */
export const getMusicBrainzArtist = tool(
  async ({ artistName }): Promise<string> => {
    try {
      console.log(`🧠 [MusicBrainz] Searching artist: "${artistName}"`);

      // Search for artist
      const query = encodeURIComponent(`artist:"${artistName}"`);
      const searchUrl = `${MB_API_BASE}/artist?query=${query}&limit=1&fmt=json`;

      const searchData = await mbFetch<{ artists: Array<{ id: string; name: string; type?: string; country?: string; "life-span"?: { begin?: string } }> }>(
        searchUrl
      );

      if (!searchData.artists || searchData.artists.length === 0) {
        return JSON.stringify({
          found: false,
          message: `Artist "${artistName}" not found`,
        });
      }

      const artist = searchData.artists[0];

      // Get artist relationships
      const artistUrl = `${MB_API_BASE}/artist/${artist.id}?inc=artist-rels+recording-rels&fmt=json`;
      const artistData = await mbFetch<{
        id: string;
        name: string;
        type?: string;
        country?: string;
        relations?: MBRelation[];
      }>(artistUrl);

      // Extract collaborators and influences
      const relations = artistData.relations || [];
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
      const message = error instanceof Error ? error.message : "Unknown error";
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
  }
);

// =============================================================================
// Exports
// =============================================================================

export const musicBrainzTools = [getMusicBrainzRelations, getMusicBrainzArtist];
export { MusicBrainzRateLimiter };
