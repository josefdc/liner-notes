/**
 * Genealogy Enricher for The Sonic Agent
 *
 * This module enriches genealogy data with real album artwork from Spotify.
 *
 * Problem: The LLM generates genealogy nodes with song names but can't provide
 *          real album artwork URLs because it doesn't have access to Spotify.
 *
 * Solution: After the Composer generates the genealogy, we search Spotify
 *           for each referenced song and fetch the actual album artwork.
 *
 * The search goes through the Spotify source (sources/spotify.ts): every request has a timeout
 * and fails with a typed error, and a failed search leaves the node without artwork. A node gets
 * the cover of the track found; its Spotify id and its preview only when that track is strictly
 * the one the model named (see `strictlyMatches`), so a click on a node whose search found a
 * cover, a remix or another song searches the node's text instead. The search's answer is cached
 * for a week by the node's label; a preview is never cached.
 *
 * Features:
 * - Parallel batch search for performance
 * - Caching to avoid repeated API calls
 * - Graceful fallback when songs aren't found
 */

import { describeError } from "../sources/http.js";
import { searchTracks, type SpotifyTrackSummary } from "../sources/spotify.js";
import { getCache, type SpotifySearchResult } from "../store/cache.js";
import { isAbortError } from "./errors.js";
import type { Genealogy, GenealogyNode } from "./schema.js";
import { recordingTitleDifference, sameArtistName } from "./trackMatch.js";

// =============================================================================
// Persistent Artwork Cache (backed by SQLite)
// =============================================================================

function getCacheKey(label: string): string {
  return label.toLowerCase().trim();
}

function getCachedArtwork(label: string): SpotifySearchResult | undefined {
  try {
    return getCache().getArtwork(getCacheKey(label)) ?? undefined;
  } catch {
    return undefined;
  }
}

function setCachedArtwork(label: string, result: SpotifySearchResult): void {
  try {
    getCache().putArtwork(getCacheKey(label), {
      coverUrl: result.coverUrl,
      spotifyUrl: result.spotifyUrl,
      spotifyId: result.spotifyId,
      trackTitle: result.trackTitle,
      trackArtist: result.trackArtist,
      trackArtists: result.trackArtists ?? null,
    });
  } catch {
    // Non-critical
  }
}

// =============================================================================
// Spotify search
// =============================================================================

const NO_ARTWORK: SpotifySearchResult = {
  coverUrl: null,
  spotifyUrl: null,
  spotifyId: null,
  trackTitle: null,
  trackArtist: null,
};

/**
 * What a node gets from Spotify: the artwork of the track found, and only when that track is
 * strictly the one the model named its Spotify id (a click analyses that id) and its preview.
 */
interface NodeLookup {
  artwork: SpotifySearchResult;
  previewUrl: string | null;
}

/** The artists a credit names: "Queen & David Bowie", "Daft Punk feat. Pharrell Williams". */
function creditParts(credit: string): string[] {
  return credit
    .split(/\s*(?:,|&|\/|\s(?:and|x|with|feat\.?|ft\.?|featuring)\s)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Whether the node's artist credit is the found track's: the same name as its lead artist or as
 * its whole credit, or a credit of several artists ("Queen & David Bowie") whose first is the
 * lead and every one of which is credited on the track. A name that contains a separator
 * ("Earth, Wind & Fire") matches by its whole name.
 */
function sameCredit(nodeArtist: string, lead: string, credited: readonly string[]): boolean {
  if (sameArtistName(nodeArtist, lead)) return true;
  if (credited.length > 1 && sameArtistName(nodeArtist, credited.join(", "))) return true;
  const parts = creditParts(nodeArtist);
  if (parts.length < 2 || !sameArtistName(parts[0], lead)) return false;
  return parts.every((part) => credited.some((name) => sameArtistName(part, name)));
}

/**
 * Whether the track found is strictly the one the model named: the node names both a title and
 * an artist, the node's credit is the track's (sameCredit), and nothing in the titles tells
 * them apart as recordings (no other title, version or take; a featured-artist note is not a
 * difference; see trackMatch.ts). A label alone is never enough: a search for it can find a
 * cover, a remix or another song.
 */
export function strictlyMatches(
  node: Pick<GenealogyNode, "trackTitle" | "trackArtist">,
  found: Pick<SpotifyTrackSummary, "title" | "artist" | "artistNames">,
): boolean {
  const title = node.trackTitle?.trim();
  const artist = node.trackArtist?.trim();
  if (!title || !artist) return false;
  const credited = found.artistNames.length > 0 ? found.artistNames : [found.artist];
  const lead = credited[0] ?? found.artist;
  return (
    sameCredit(artist, lead, credited) &&
    recordingTitleDifference({ title }, { title: found.title }) === null
  );
}

/**
 * The cached track's identity, for strictlyMatches: every credited artist when the row keeps
 * them, else (rows written before the cache kept them) the lead artist only.
 */
function cachedTrack(cached: SpotifySearchResult) {
  const names = cached.trackArtists?.length
    ? cached.trackArtists
    : cached.trackArtist
      ? [cached.trackArtist]
      : [];
  return { title: cached.trackTitle ?? "", artist: names.join(", "), artistNames: names };
}

/** The cover alone, without the track's identity: for a track that is not strictly the node's. */
const withoutId = (artwork: SpotifySearchResult): SpotifySearchResult => ({
  ...artwork,
  spotifyId: null,
  trackTitle: null,
  trackArtist: null,
  trackArtists: null,
});

/**
 * Artwork for a node, from the cache or a Spotify search, with the Spotify id and the preview
 * of the track found only when that track strictly matches the node: a loose match still gives
 * the cover, but a click on the node then searches its text, and nothing plays. A cached entry
 * gives no preview (none is stored). A failed search gives nothing and caches nothing, so a
 * later run tries again; a cancelled run rejects.
 */
async function lookUpNode(node: GenealogyNode, signal?: AbortSignal): Promise<NodeLookup> {
  const cached = getCachedArtwork(node.label);
  if (cached) {
    const strict = strictlyMatches(node, cachedTrack(cached));
    return { artwork: strict ? cached : withoutId(cached), previewUrl: null };
  }

  let found: SpotifyTrackSummary | undefined;
  try {
    [found] = await searchTracks(node.label, 1, signal);
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    console.warn(`⚠️ [Enricher] Spotify search for "${node.label}" failed: ${describeError(error)}`);
    return { artwork: NO_ARTWORK, previewUrl: null };
  }

  const artwork: SpotifySearchResult = found
    ? {
        coverUrl: found.coverUrl || null,
        spotifyUrl: found.spotifyUrl || null,
        spotifyId: found.id || null,
        trackTitle: found.title || null,
        trackArtist: found.artistNames[0] || found.artist || null,
        trackArtists: found.artistNames.length > 0 ? found.artistNames : null,
      }
    : NO_ARTWORK;
  signal?.throwIfAborted();
  setCachedArtwork(node.label, artwork);
  if (!found) return { artwork: NO_ARTWORK, previewUrl: null };
  if (!strictlyMatches(node, found)) return { artwork: withoutId(artwork), previewUrl: null };
  return { artwork, previewUrl: found.previewUrl || null };
}

// =============================================================================
// Main Enrichment Function
// =============================================================================

/**
 * Enrich genealogy nodes with real Spotify album artwork.
 *
 * @param genealogy - The genealogy object from the Composer (may have optional fields)
 * @param currentTrackCoverUrl - The cover URL of the main track (already known)
 * @param signal - The run's abort signal: a cancelled run stops the Spotify requests and
 *   rejects
 * @returns Enriched genealogy with real artwork URLs
 */
export async function enrichGenealogyWithArtwork(
  genealogy: Partial<Genealogy> | undefined,
  currentTrackCoverUrl: string,
  signal?: AbortSignal,
): Promise<Genealogy> {
  // Handle undefined or malformed genealogy
  if (!genealogy?.nodes || !Array.isArray(genealogy.nodes) || genealogy.nodes.length === 0) {
    return {
      nodes: [
        {
          id: "current",
          group: 1,
          label: "Current Track",
          img: currentTrackCoverUrl,
          size: 40,
        },
      ],
      links: [],
    };
  }

  console.log(`🎨 [Enricher] Enriching ${genealogy.nodes.length} genealogy nodes with artwork...`);

  try {
    // Process nodes in parallel (with concurrency limit to avoid rate limits)
    const BATCH_SIZE = 5;
    const enrichedNodes: GenealogyNode[] = [];

    for (let i = 0; i < genealogy.nodes.length; i += BATCH_SIZE) {
      const batch = genealogy.nodes.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.all(
        batch.map(async (node) => {
          // Ensure node has required fields
          const safeNode: GenealogyNode = {
            id: node.id || `node-${i}`,
            group: node.group || 4,
            label: node.label || "Unknown",
            img: node.img,
            size: node.size || 25,
          };

          // Skip if it's the current song (group 1) - we already have its cover
          if (safeNode.group === 1) {
            return {
              ...safeNode,
              img: currentTrackCoverUrl,
            };
          }

          // Skip if already has a valid image URL
          if (safeNode.img && isValidImageUrl(safeNode.img)) {
            return safeNode;
          }

          // Search Spotify for this song; the model's title and artist decide the preview
          const { artwork, previewUrl } = await lookUpNode(
            { ...safeNode, trackTitle: node.trackTitle, trackArtist: node.trackArtist },
            signal,
          );

          return {
            ...safeNode,
            img: artwork.coverUrl || undefined,
            previewUrl: previewUrl || undefined,
            spotifyId: artwork.spotifyId || undefined,
            trackTitle: artwork.trackTitle || undefined,
            trackArtist: artwork.trackArtist || undefined,
          };
        }),
      );

      enrichedNodes.push(...batchResults);

      // Small delay between batches to be nice to Spotify API
      if (i + BATCH_SIZE < genealogy.nodes.length) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    const nodesWithImages = enrichedNodes.filter((n) => n.img).length;
    console.log(`✅ [Enricher] Found artwork for ${nodesWithImages}/${enrichedNodes.length} nodes`);

    // Ensure links have required fields
    const safeLinks = (genealogy.links || [])
      .map((link) => ({
        source: link.source || "",
        target: link.target || "",
        value: link.value || 1,
      }))
      .filter((link) => link.source && link.target);

    return {
      nodes: enrichedNodes,
      links: safeLinks,
    };
  } catch (error) {
    // A cancelled run stops here: it reports nothing.
    if (signal?.aborted || isAbortError(error)) throw error;
    console.error("❌ [Enricher] Error enriching genealogy:", error);
    // Return safe fallback if enrichment fails
    return {
      nodes: [
        {
          id: "current",
          group: 1,
          label: "Current Track",
          img: currentTrackCoverUrl,
          size: 40,
        },
      ],
      links: [],
    };
  }
}

/**
 * Check if a URL looks like a valid image URL
 */
function isValidImageUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;

  try {
    const parsed = new URL(url);
    // Accept common image hosting domains
    const validDomains = [
      "i.scdn.co", // Spotify
      "mosaic.scdn.co", // Spotify mosaic
      "picsum.photos", // Placeholder service
      "placehold.co", // Placeholder
      "images.unsplash.com", // Unsplash
    ];
    return validDomains.some((domain) => parsed.hostname.includes(domain));
  } catch {
    return false;
  }
}

/**
 * Generate a consistent placeholder color based on the label
 * This creates a deterministic gradient for nodes without images
 */
export function generatePlaceholderGradient(label: string, group: number): string {
  // Generate a hash from the label
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    const char = label.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }

  // Generate HSL colors based on hash and group
  const hue = Math.abs(hash) % 360;

  // Different saturation/lightness based on group for visual hierarchy
  const groupStyles: Record<number, { s: number; l: number }> = {
    1: { s: 80, l: 50 }, // Current: vibrant
    2: { s: 70, l: 45 }, // Sampled: warm
    3: { s: 60, l: 40 }, // Sampler: cooler
    4: { s: 50, l: 35 }, // Influence: subtle
  };

  const style = groupStyles[group] || { s: 60, l: 40 };

  return `hsl(${hue}, ${style.s}%, ${style.l}%)`;
}

// =============================================================================
// Export utilities
// =============================================================================

export { isValidImageUrl, getCachedArtwork };
