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
 * Features:
 * - Parallel batch search for performance
 * - Caching to avoid repeated API calls
 * - Graceful fallback when songs aren't found
 * - Rate limit handling
 */

import dotenv from "dotenv";
import type { Genealogy, GenealogyNode } from "./schema.js";
import { getCache, type SpotifySearchResult } from "../store/cache.js";

dotenv.config();

// =============================================================================
// Types
// =============================================================================

interface SpotifySearchResultWithArtist extends SpotifySearchResult {
  artist: string | null;
}

// =============================================================================
// Persistent Artwork Cache (backed by SQLite)
// =============================================================================

function getCacheKey(label: string): string {
  return label.toLowerCase().trim();
}

function getCachedArtwork(label: string): SpotifySearchResultWithArtist | undefined {
  try {
    const result = getCache().getArtwork(getCacheKey(label));
    if (!result) return undefined;
    return { ...result, artist: result.trackArtist };
  } catch {
    return undefined;
  }
}

function setCachedArtwork(label: string, result: SpotifySearchResultWithArtist): void {
  try {
    getCache().putArtwork(getCacheKey(label), {
      coverUrl: result.coverUrl,
      spotifyUrl: result.spotifyUrl,
      previewUrl: result.previewUrl,
      spotifyId: result.spotifyId,
      trackTitle: result.trackTitle,
      trackArtist: result.trackArtist ?? result.artist,
    });
  } catch {
    // Non-critical
  }
}

// =============================================================================
// Spotify API Integration
// =============================================================================

/**
 * Get Spotify access token using Client Credentials flow
 */
async function getSpotifyToken(): Promise<string> {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Missing Spotify credentials");
  }

  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");

  const response = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
    },
    body: params,
  });

  if (!response.ok) {
    throw new Error(`Spotify auth failed: ${response.status}`);
  }

  const data = (await response.json()) as { access_token: string };
  return data.access_token;
}

/**
 * Search Spotify for a song and get its album artwork
 */
async function searchSpotifyForArtwork(
  query: string,
  token: string
): Promise<SpotifySearchResultWithArtist> {
  // Check cache first
  const cached = getCachedArtwork(query);
  if (cached) {
    return cached;
  }

  try {
    const searchUrl = new URL("https://api.spotify.com/v1/search");
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("type", "track");
    searchUrl.searchParams.set("limit", "1");

    const response = await fetch(searchUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      if (response.status === 429) {
        console.warn("⚠️ [Enricher] Spotify rate limit hit");
        return { coverUrl: null, spotifyUrl: null, artist: null, previewUrl: null, spotifyId: null, trackTitle: null, trackArtist: null };
      }
      throw new Error(`Spotify search failed: ${response.status}`);
    }

    const data = (await response.json()) as { 
      tracks?: { items?: Array<{
        id?: string;
        name?: string;
        preview_url?: string | null;
        album?: { images?: Array<{ url: string }> };
        external_urls?: { spotify: string };
        artists?: Array<{ name: string }>;
      }> } 
    };
    const track = data.tracks?.items?.[0];

    if (!track) {
      const result: SpotifySearchResultWithArtist = { coverUrl: null, spotifyUrl: null, artist: null, previewUrl: null, spotifyId: null, trackTitle: null, trackArtist: null };
      setCachedArtwork(query, result);
      return result;
    }

    const result: SpotifySearchResultWithArtist = {
      coverUrl: track.album?.images?.[0]?.url || null,
      spotifyUrl: track.external_urls?.spotify || null,
      artist: track.artists?.map((a: any) => a.name).join(", ") || null,
      previewUrl: track.preview_url || null,
      spotifyId: track.id || null,
      trackTitle: track.name || null,
      trackArtist: track.artists?.[0]?.name || null,
    };

    setCachedArtwork(query, result);
    return result;
  } catch (error) {
    console.error(`❌ [Enricher] Error searching for "${query}":`, error);
    return { coverUrl: null, spotifyUrl: null, artist: null, previewUrl: null, spotifyId: null, trackTitle: null, trackArtist: null };
  }
}

// =============================================================================
// Main Enrichment Function
// =============================================================================

/**
 * Enrich genealogy nodes with real Spotify album artwork.
 * 
 * @param genealogy - The genealogy object from the Composer (may have optional fields)
 * @param currentTrackCoverUrl - The cover URL of the main track (already known)
 * @returns Enriched genealogy with real artwork URLs
 */
export async function enrichGenealogyWithArtwork(
  genealogy: Partial<Genealogy> | undefined,
  currentTrackCoverUrl: string
): Promise<Genealogy> {
  // Handle undefined or malformed genealogy
  if (!genealogy?.nodes || !Array.isArray(genealogy.nodes) || genealogy.nodes.length === 0) {
    return {
      nodes: [{
        id: "current",
        group: 1,
        label: "Current Track",
        img: currentTrackCoverUrl,
        size: 40,
      }],
      links: [],
    };
  }

  console.log(`🎨 [Enricher] Enriching ${genealogy.nodes.length} genealogy nodes with artwork...`);

  try {
    const token = await getSpotifyToken();
    
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

          // Search Spotify for this song
          const result = await searchSpotifyForArtwork(safeNode.label, token);
          
          return {
            ...safeNode,
            img: result.coverUrl || undefined,
            // NEW: Inject audio preview and navigation metadata
            previewUrl: result.previewUrl || undefined,
            spotifyId: result.spotifyId || undefined,
            trackTitle: result.trackTitle || undefined,
            trackArtist: result.trackArtist || undefined,
          };
        })
      );

      enrichedNodes.push(...batchResults);
      
      // Small delay between batches to be nice to Spotify API
      if (i + BATCH_SIZE < genealogy.nodes.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    const nodesWithImages = enrichedNodes.filter(n => n.img).length;
    console.log(`✅ [Enricher] Found artwork for ${nodesWithImages}/${enrichedNodes.length} nodes`);

    // Ensure links have required fields
    const safeLinks = (genealogy.links || []).map(link => ({
      source: link.source || "",
      target: link.target || "",
      value: link.value || 1,
    })).filter(link => link.source && link.target);

    return {
      nodes: enrichedNodes,
      links: safeLinks,
    };
  } catch (error) {
    console.error("❌ [Enricher] Error enriching genealogy:", error);
    // Return safe fallback if enrichment fails
    return {
      nodes: [{
        id: "current",
        group: 1,
        label: "Current Track",
        img: currentTrackCoverUrl,
        size: 40,
      }],
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
      "i.scdn.co",           // Spotify
      "mosaic.scdn.co",      // Spotify mosaic
      "picsum.photos",       // Placeholder service
      "placehold.co",        // Placeholder
      "images.unsplash.com", // Unsplash
    ];
    return validDomains.some(domain => parsed.hostname.includes(domain));
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
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  
  // Generate HSL colors based on hash and group
  const hue = Math.abs(hash) % 360;
  
  // Different saturation/lightness based on group for visual hierarchy
  const groupStyles: Record<number, { s: number; l: number }> = {
    1: { s: 80, l: 50 },  // Current: vibrant
    2: { s: 70, l: 45 },  // Sampled: warm
    3: { s: 60, l: 40 },  // Sampler: cooler
    4: { s: 50, l: 35 },  // Influence: subtle
  };
  
  const style = groupStyles[group] || { s: 60, l: 40 };
  
  return `hsl(${hue}, ${style.s}%, ${style.l}%)`;
}

// =============================================================================
// Export utilities
// =============================================================================

export { isValidImageUrl, getCachedArtwork };
