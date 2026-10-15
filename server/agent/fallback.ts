/**
 * Fallback Track Data Generator
 *
 * Single responsibility: graceful degradation when the LLM composer fails.
 * Builds TrackData from raw state (Spotify metadata + research data + audio features)
 * without requiring a successful LLM call.
 */

import { z } from "zod";
import { generateStructuredOutput } from "./geminiClient.js";
import type { TrackData } from "./schema.js";
import {
  createDefaultSegments,
  generateId,
  type SonicAgentStateType,
  type Factoid,
  type FactoidEntity,
  type ResearchData,
} from "./state.js";

/**
 * Build TrackData from state when the main composer LLM call fails.
 * Extracts factoids from research data and falls back to template factoids.
 */
export async function createFallbackTrackData(state: SonicAgentStateType): Promise<TrackData> {
  const spotify = state.spotifyData!;
  const audio = state.audioFeatures || {
    bpm: 120,
    key: "C Major",
    energy: 0.7,
    valence: 0.6,
    danceability: 0.7,
    acousticness: 0.2,
    instrumentalness: 0.1,
    confidence: "low" as const,
    keyMoments: [],
  };

  // Extract release year from releaseDate
  const releaseYear = spotify.releaseDate?.split("-")[0];

  // Generate valence description
  const valenceLabel = audio.valence > 0.7 ? "euphoric"
    : audio.valence > 0.5 ? "positive"
    : audio.valence > 0.3 ? "melancholic"
    : "dark";

  // ==========================================================================
  // Generate RICH factoids from research data instead of boring templates
  // ==========================================================================
  const factoids: Factoid[] = [];
  const research: ResearchData = state.researchData || {
    samples: [],
    productionTrivia: [],
    songMeaning: [],
    relatedArtists: [],
  };

  console.log("📊 [Fallback] Building factoids from research data:", {
    samples: research.samples?.length || 0,
    productionTrivia: research.productionTrivia?.length || 0,
    songMeaning: research.songMeaning?.length || 0,
    artistTopTracks: research.artistTopTracks?.length || 0,
    collaborators: research.collaborators?.length || 0,
  });

  // 1. Production trivia from research (filter out MusicBrainz raw data)
  if (research.productionTrivia && research.productionTrivia.length > 0) {
    research.productionTrivia
      .filter(t => !t.startsWith("[MusicBrainz]") && t.length > 20)
      .slice(0, 2)
      .forEach((trivia, idx) => {
        // Clean up trivia text - extract the most interesting sentence
        const cleanTrivia = trivia.replace(/\[.*?\]/g, "").trim();
        if (cleanTrivia.length > 20) {
          factoids.push({
            id: generateId(),
            title: idx === 0 ? "Studio Intel" : "Behind the Boards",
            content: cleanTrivia.length > 300 ? cleanTrivia.substring(0, 297) + "..." : cleanTrivia,
            type: "production",
          });
        }
      });
  }

  // 2. Samples discovered - parse from research data strings
  if (research.samples && research.samples.length > 0) {
    // Try to extract structured samples from MusicBrainz data
    let parsedSamples: Array<{title: string; artist: string}> = [];

    for (const sampleStr of research.samples) {
      if (sampleStr.includes("[MusicBrainz]")) {
        try {
          const jsonMatch = sampleStr.match(/\[.*?\].*?(\[.*\])/s);
          if (jsonMatch) {
            const samples = JSON.parse(jsonMatch[1]);
            parsedSamples.push(...samples.slice(0, 3));
          }
        } catch { /* ignore parse errors */ }
      } else {
        // Text description of samples - create a factoid from it
        const cleanText = sampleStr.replace(/\[.*?\]/g, "").trim();
        if (cleanText.length > 20 && parsedSamples.length === 0) {
          factoids.push({
            id: generateId(),
            title: "Sample Detective",
            content: cleanText.length > 300 ? cleanText.substring(0, 297) + "..." : cleanText,
            type: "sample",
          });
        }
      }
    }

    // If we found structured samples, create a rich factoid
    if (parsedSamples.length > 0) {
      const samplesList = parsedSamples.slice(0, 3).map(s => `"${s.title}" by ${s.artist}`).join(", ");
      factoids.push({
        id: generateId(),
        title: "Sample DNA",
        content: `This track samples: ${samplesList}. ${parsedSamples.length > 3 ? `Plus ${parsedSamples.length - 3} more hidden gems.` : ""}`,
        type: "sample",
        entities: parsedSamples.slice(0, 3).map(s => ({
          id: generateId(),
          text: `${s.title} - ${s.artist}`,
          type: "sample" as const,
          searchQuery: `${s.title} ${s.artist}`,
        })),
      });
    }
  }

  // 3. Song meaning / lyrics analysis (clean up raw lyrics data)
  if (research.songMeaning && research.songMeaning.length > 0) {
    const meaningText = research.songMeaning
      .filter(s => !s.includes("[Genius Lyrics] Raw lyrics"))
      .join(" ")
      .replace(/\[.*?\]/g, "")
      .trim();

    if (meaningText.length > 30) {
      factoids.push({
        id: generateId(),
        title: "Lyrical Decode",
        content: meaningText.length > 300 ? meaningText.substring(0, 297) + "..." : meaningText,
        type: "trivia",
      });
    }
  }

  // 4. Artist collaborators network
  if (research.collaborators && research.collaborators.length > 0) {
    const collabNames = research.collaborators.slice(0, 4).join(", ");
    factoids.push({
      id: generateId(),
      title: "Collaboration Network",
      content: `${spotify.artist} has worked with: ${collabNames}. These connections shaped their sonic DNA.`,
      type: "connection",
      entities: research.collaborators.slice(0, 4).map(name => ({
        id: generateId(),
        text: name,
        type: "artist" as const,
        searchQuery: name,
      })),
    });
  }

  // 5. Artist discography context
  if (research.artistTopTracks && research.artistTopTracks.length > 0) {
    const otherHits = research.artistTopTracks
      .filter(t => t.title.toLowerCase() !== spotify.title.toLowerCase())
      .slice(0, 3);
    if (otherHits.length > 0) {
      const hitsList = otherHits.map(t => `"${t.title}"`).join(", ");
      factoids.push({
        id: generateId(),
        title: "Discography Context",
        content: `From the same artist: ${hitsList}. See how their sound evolved across releases.`,
        type: "connection",
        entities: otherHits.map(t => ({
          id: generateId(),
          text: t.title,
          type: "sample" as const, // Using 'sample' as the closest type for songs
          searchQuery: `${t.title} ${spotify.artist}`,
        })),
      });
    }
  }

  // 6. If we still don't have enough factoids, try a quick LLM call for factoids only
  if (factoids.length < 3) {
    console.log("🔄 [Fallback] Not enough research data, attempting secondary LLM call for factoids...");
    try {
      const quickFactoids = await generateQuickFactoids(spotify.title, spotify.artist);
      if (quickFactoids && quickFactoids.length > 0) {
        factoids.push(...quickFactoids);
        console.log(`✅ [Fallback] Secondary LLM generated ${quickFactoids.length} factoids`);
      }
    } catch (e) {
      console.log("⚠️ [Fallback] Secondary LLM call failed:", e);
    }
  }

  // 7. Always add basic audio profile if we still need more
  if (factoids.length < 4) {
    factoids.push({
      id: generateId(),
      title: "Sonic Profile",
      content: `${audio.bpm} BPM in ${audio.key}. ${audio.energy > 0.7 ? "High energy" : "Moderate energy"} with a ${valenceLabel} mood. Danceability: ${Math.round(audio.danceability * 100)}%.`,
      type: "production",
    });
  }

  // Ensure we have at least 3 factoids with fallback templates
  while (factoids.length < 3) {
    const templates = [
      {
        title: "Release Info",
        content: `Released in ${releaseYear || "Unknown"} on "${spotify.album}". Popularity score: ${spotify.popularity}/100 on Spotify.`,
        type: "trivia" as const,
      },
      {
        title: "Track Signature",
        content: `A ${valenceLabel} track at ${audio.bpm} BPM in ${audio.key}. ${audio.acousticness > 0.5 ? "Features organic, acoustic elements." : "Driven by electronic production."}`,
        type: "production" as const,
      },
    ];
    const template = templates[factoids.length % templates.length];
    factoids.push({ id: generateId(), ...template });
  }

  console.log(`✅ [Fallback] Generated ${factoids.length} factoids (${factoids.filter(f => f.entities?.length).length} with entities)`);

  return {
    id: spotify.id,
    title: spotify.title,
    artist: spotify.artist,
    album: spotify.album,
    coverUrl: spotify.coverUrl,
    // New enhanced metadata
    spotifyUrl: spotify.spotifyUrl,
    releaseYear: releaseYear,
    explicit: spotify.explicit,
    // Audio features
    bpm: audio.bpm,
    key: audio.key,
    energy: audio.energy,
    valence: audio.valence,
    danceability: audio.danceability,
    acousticness: audio.acousticness,
    durationSeconds: Math.round(spotify.durationMs / 1000),
    segments: createDefaultSegments(spotify.durationMs),
    samples: [], // Samples are integrated into factoids, not raw array here
    keyMoments: audio.keyMoments || [],
    factoids,
    genealogy: {
      nodes: [
        {
          id: "current",
          group: 1,
          label: spotify.title,
          img: spotify.coverUrl,
          size: 40,
        },
      ],
      links: [],
    },
    audioSource: audio.confidence === "high" ? "analyzed" : "estimated",
    audioConfidence: audio.confidence,
  };
}

// =============================================================================
// Secondary LLM call for quick factoids (used when main composer fails)
// =============================================================================

const QuickFactoidSchema = z.object({
  factoids: z.array(z.object({
    title: z.string().describe("Short catchy title for the factoid"),
    content: z.string().describe("The interesting fact, 1-2 sentences max"),
    type: z.enum(["trivia", "production", "sample", "credits", "curiosity", "connection"]),
    entities: z.array(z.object({
      text: z.string().describe("Display text for the entity"),
      type: z.enum(["artist", "sample", "album", "producer", "synth", "technique", "year"]),
    })).optional(),
  })).max(4),
});

async function generateQuickFactoids(title: string, artist: string): Promise<Factoid[]> {
  const prompt = `You are a music expert. Generate 3-4 fascinating, OBSCURE factoids about "${title}" by ${artist}.

REQUIREMENTS:
- Each factoid must be a surprising, little-known fact
- Include specific names, dates, or connections where possible
- Add "entities" array with clickable items when relevant (artists, synths, producers, etc.)
- Focus on: production secrets, samples used, collaborators, chart records, cultural impact
- Be specific and authoritative, not generic

Example good factoid:
{
  "title": "Hidden Sample",
  "content": "This track interpolates a 1972 recording by The Isley Brothers, pitched down 3 semitones.",
  "type": "sample",
  "entities": [{"text": "The Isley Brothers", "type": "artist"}]
}

Generate factoids now:`;

  try {
    const result = await generateStructuredOutput({
      prompt,
      schema: QuickFactoidSchema,
      useGoogleSearch: true,
      tier: "fast",
    });

    if (result.data?.factoids) {
      return result.data.factoids
        .filter(f => f.title && f.content && f.type)
        .map(f => ({
          id: generateId(),
          title: f.title!,
          content: f.content!,
          type: f.type! as Factoid["type"],
          entities: f.entities?.filter(e => e.text && e.type).map(e => ({
            id: generateId(),
            text: e.text!,
            type: e.type! as FactoidEntity["type"],
            searchQuery: e.text,
          })),
        }));
    }
  } catch (e) {
    console.error("Quick factoids generation failed:", e);
  }

  return [];
}
