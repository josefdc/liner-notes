/**
 * Fallback Track Data Generator
 *
 * Single responsibility: graceful degradation when the LLM composer fails.
 * Builds TrackData from raw state (Spotify metadata + research data + audio features)
 * without requiring a successful LLM call. Values that are not known are left out or null;
 * nothing is filled in with defaults.
 */

import { measuredAudioFields, type TrackData } from "./schema.js";
import {
  createDefaultSegments,
  generateId as newRandomId,
  type AudioFeatures,
  type SonicAgentStateType,
  type Factoid,
  type ResearchData,
  type SpotifyData,
} from "./state.js";

/** Splits a research entry such as `[MusicBrainz Samples] [...]` into its tag and body. */
function splitTag(entry: string): { tag: string | null; body: string } {
  const match = entry.match(/^\[([^\]]+)\]\s*(.*)$/s);
  return match ? { tag: match[1], body: match[2] } : { tag: null, body: entry };
}

// Status text the search tools return instead of results (no API key, no results, errors).
// It is not research and never becomes a factoid.
const TOOL_STATUS_PREFIXES = [
  "Web search is not available",
  "Error searching",
  "No sample information found",
  "No production history found",
  "No song meaning analysis found",
  "No results found",
];

function isToolStatusText(entry: string): boolean {
  const text = splitTag(entry).body.trim();
  return TOOL_STATUS_PREFIXES.some((prefix) => text.startsWith(prefix));
}

/** True for entries that hold structured data (JSON) rather than prose. */
function isStructured(entry: string): boolean {
  const { tag, body } = splitTag(entry);
  return (tag?.startsWith("MusicBrainz") ?? false) || /^[[{]/.test(body.trim());
}

/** Parses the sample list from a MusicBrainz samples entry; [] if it is not one. */
function parseMusicBrainzSamples(entry: string): Array<{ title: string; artist: string }> {
  const { tag, body } = splitTag(entry);
  if (!tag?.startsWith("MusicBrainz")) return [];
  const json = body.slice(body.indexOf("["));
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is { title: string; artist: string } =>
        typeof s?.title === "string" && s.title !== "" && typeof s?.artist === "string",
    );
  } catch {
    return [];
  }
}

function truncate(text: string, max = 300): string {
  return text.length > max ? `${text.substring(0, max - 3)}...` : text;
}

/** A sentence describing the measured audio values, or null when nothing was measured. */
function describeMeasuredAudio(audio: AudioFeatures | null): string | null {
  if (!audio || audio.bpm == null || audio.key == null) return null;
  // The same values as the payload, unrounded, so the text and the numbers agree.
  const parts = [`${audio.bpm} BPM in ${audio.key}.`];
  if (audio.energy != null) {
    const level = audio.energy > 0.7 ? "High" : audio.energy > 0.4 ? "Moderate" : "Low";
    parts.push(`${level} measured energy.`);
  }
  // Mood and danceability come from audio models run over the clip: they are estimates by
  // those models, not signal measurements, and are labelled that way.
  if (audio.valence != null) {
    const mood =
      audio.valence > 0.7
        ? "euphoric"
        : audio.valence > 0.5
          ? "positive"
          : audio.valence > 0.3
            ? "melancholic"
            : "dark";
    parts.push(`Mood (audio model estimate): ${mood}.`);
  }
  if (audio.danceability != null) {
    parts.push(`Danceability score (audio model estimate): ${audio.danceability}.`);
  }
  return parts.join(" ");
}

/** A release sentence built only from the Spotify fields that are present. */
function describeRelease(spotify: SpotifyData): string | null {
  const year = spotify.releaseDate?.split("-")[0];
  const parts: string[] = [];
  if (year && spotify.album) parts.push(`Released in ${year} on "${spotify.album}".`);
  else if (year) parts.push(`Released in ${year}.`);
  else if (spotify.album) parts.push(`Released on "${spotify.album}".`);
  if (typeof spotify.popularity === "number") {
    parts.push(`Spotify popularity score: ${spotify.popularity}/100.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

export interface FallbackOptions {
  /** Ids for factoids and entities (default: random UUIDs). */
  newId?: () => string;
}

/**
 * Build TrackData from state when the main composer LLM call fails.
 * Extracts factoids from research data; adds metadata factoids only for known values.
 */
export async function createFallbackTrackData(
  state: SonicAgentStateType,
  options: FallbackOptions = {},
): Promise<TrackData> {
  const generateId = options.newId ?? newRandomId;
  const spotify = state.spotifyData!;
  const audio = state.audioFeatures ?? null;

  // Extract release year from releaseDate
  const releaseYear = spotify.releaseDate?.split("-")[0] || undefined;

  const factoids: Factoid[] = [];
  const research: ResearchData = state.researchData || {
    samples: [],
    productionTrivia: [],
    relatedArtists: [],
  };

  console.log("📊 [Fallback] Building factoids from research data:", {
    samples: research.samples?.length || 0,
    productionTrivia: research.productionTrivia?.length || 0,
    artistTopTracks: research.artistTopTracks?.length || 0,
    collaborators: research.collaborators?.length || 0,
  });

  // 1. Production trivia from research (prose only; structured MusicBrainz data is skipped)
  (research.productionTrivia || [])
    .filter((t) => !isStructured(t) && !isToolStatusText(t))
    .map((t) => splitTag(t).body.trim())
    .filter((t) => t.length > 20)
    .slice(0, 2)
    .forEach((trivia, idx) => {
      factoids.push({
        id: generateId(),
        title: idx === 0 ? "Studio Intel" : "Behind the Boards",
        content: truncate(trivia),
        type: "production",
      });
    });

  // 2. Samples: structured MusicBrainz relations first, else a prose description
  if (research.samples && research.samples.length > 0) {
    const parsedSamples = research.samples.flatMap(parseMusicBrainzSamples);

    if (parsedSamples.length > 0) {
      const shown = parsedSamples.slice(0, 3);
      const samplesList = shown
        .map((s) => (s.artist ? `"${s.title}" by ${s.artist}` : `"${s.title}"`))
        .join(", ");
      const more =
        parsedSamples.length > 3 ? ` Plus ${parsedSamples.length - 3} more in MusicBrainz.` : "";
      factoids.push({
        id: generateId(),
        title: "Sample DNA",
        content: `This track samples: ${samplesList}.${more}`,
        type: "sample",
        entities: shown.map((s) => ({
          id: generateId(),
          text: s.artist ? `${s.title} - ${s.artist}` : s.title,
          type: "sample" as const,
          searchQuery: `${s.title} ${s.artist}`.trim(),
        })),
      });
    } else {
      const prose = research.samples
        .filter((s) => !isStructured(s) && !isToolStatusText(s))
        .map((s) => splitTag(s).body.trim())
        .find((s) => s.length > 20);
      if (prose) {
        factoids.push({
          id: generateId(),
          title: "Sample Detective",
          content: truncate(prose),
          type: "sample",
        });
      }
    }
  }

  // 3. Song-meaning research is not used (its page text can quote the song).

  // 4. Artist collaborators network
  if (research.collaborators && research.collaborators.length > 0) {
    const collabNames = research.collaborators.slice(0, 4).join(", ");
    factoids.push({
      id: generateId(),
      title: "Collaboration Network",
      content: `${spotify.artist} has worked with: ${collabNames}.`,
      type: "connection",
      entities: research.collaborators.slice(0, 4).map((name) => ({
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
      .filter((t) => t.title.toLowerCase() !== spotify.title.toLowerCase())
      .slice(0, 3);
    if (otherHits.length > 0) {
      const hitsList = otherHits.map((t) => `"${t.title}"`).join(", ");
      factoids.push({
        id: generateId(),
        title: "Discography Context",
        content: `From the same artist: ${hitsList}.`,
        type: "connection",
        entities: otherHits.map((t) => ({
          id: generateId(),
          text: t.title,
          type: "sample" as const, // Using 'sample' as the closest type for songs
          searchQuery: `${t.title} ${spotify.artist}`,
        })),
      });
    }
  }

  // 6. No second model call: this result is built from source and measured data only, so
  //    it never contains facts generated by a model.

  // 7. Metadata factoids, only from values that are known (measured audio, Spotify metadata).
  //    Fewer than three factoids is better than padding with invented ones.
  const sonicProfile = describeMeasuredAudio(audio);
  if (factoids.length < 4 && sonicProfile) {
    factoids.push({
      id: generateId(),
      title: "Sonic Profile",
      content: sonicProfile,
      type: "production",
    });
  }
  const releaseInfo = describeRelease(spotify);
  if (factoids.length < 3 && releaseInfo) {
    factoids.push({
      id: generateId(),
      title: "Release Info",
      content: releaseInfo,
      type: "trivia",
    });
  }

  console.log(
    `✅ [Fallback] Generated ${factoids.length} factoids (${factoids.filter((f) => f.entities?.length).length} with entities)`,
  );

  return {
    id: spotify.id,
    title: spotify.title,
    artist: spotify.artist,
    album: spotify.album,
    coverUrl: spotify.coverUrl,
    spotifyUrl: spotify.spotifyUrl,
    releaseYear,
    // Unknown (null) is left out rather than shown as "not explicit"
    ...(typeof spotify.explicit === "boolean" ? { explicit: spotify.explicit } : {}),
    // Measured audio values or null, with the reason when missing
    ...measuredAudioFields(audio),
    // From Spotify only; missing when Spotify gave none
    ...(spotify.durationMs > 0 ? { durationSeconds: Math.round(spotify.durationMs / 1000) } : {}),
    // A generic structure, not an analysis of this track
    segments: createDefaultSegments(spotify.durationMs),
    segmentsSource: "template",
    samples: [], // Samples are integrated into factoids, not raw array here
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
  };
}
