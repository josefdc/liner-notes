/**
 * Fallback Track Data Generator
 *
 * Single responsibility: graceful degradation when the LLM composer fails.
 * Builds TrackData from measured values and primary records only (Spotify metadata, MusicBrainz
 * relations and collaborators, the audio measurement), without a model call. Web search hits
 * are not shown. Values that are not known are left out or null; nothing is filled in.
 */

import { measuredAudioFields, type TrackData } from "./schema.js";
import {
  createDefaultSegments,
  generateId as newRandomId,
  type AudioFeatures,
  type SonicAgentStateType,
  emptyResearch,
  type Factoid,
  type ResearchData,
  type SpotifyData,
} from "./state.js";

/** Splits a research entry such as `[MusicBrainz Samples] [...]` into its tag and body. */
function splitTag(entry: string): { tag: string | null; body: string } {
  const match = entry.match(/^\[([^\]]+)\]\s*(.*)$/s);
  return match ? { tag: match[1], body: match[2] } : { tag: null, body: entry };
}

interface SampleRelation {
  title: string;
  artist: string;
  /** "source": this track samples it; "derived": it samples this track. */
  direction: "source" | "derived";
}

/**
 * Parses the sample relations from a MusicBrainz samples entry; [] if it is not one. A relation
 * without a direction (research cached before it was recorded) cannot be told apart and is left
 * out.
 */
function parseMusicBrainzSamples(entry: string): SampleRelation[] {
  const { tag, body } = splitTag(entry);
  if (!tag?.startsWith("MusicBrainz")) return [];
  const json = body.slice(body.indexOf("["));
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is SampleRelation =>
        typeof s?.title === "string" &&
        s.title !== "" &&
        typeof s?.artist === "string" &&
        (s.direction === "source" || s.direction === "derived"),
    );
  } catch {
    return [];
  }
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
  const research: ResearchData = state.researchData || emptyResearch();

  console.log("📊 [Fallback] Building factoids from research data:", {
    samples: research.samples?.length || 0,
    productionTrivia: research.productionTrivia?.length || 0,
    collaborators: research.collaborators?.length || 0,
  });

  // 1. Web search hits (production, samples, leads the planner followed) are never shown: a
  //    hit is whatever page ranked first, possibly about another song, so presenting its
  //    snippet as a fact "from source data" would be dishonest. Only primary records follow.

  // 2. Samples: MusicBrainz sample relations only
  // A relation reads from this track: it samples the "source" recordings, and the "derived"
  // ones sample it. Each direction gets its own card.
  const relations = (research.samples ?? []).flatMap(parseMusicBrainzSamples);
  const sampleCard = (direction: SampleRelation["direction"], title: string, lead: string) => {
    const list = relations.filter((r) => r.direction === direction);
    if (list.length === 0) return;
    const shown = list.slice(0, 3);
    const names = shown
      .map((s) => (s.artist ? `"${s.title}" by ${s.artist}` : `"${s.title}"`))
      .join(", ");
    const more = list.length > 3 ? ` Plus ${list.length - 3} more in MusicBrainz.` : "";
    factoids.push({
      id: generateId(),
      title,
      content: `${lead}: ${names}.${more}`,
      type: "sample",
      entities: shown.map((s) => ({
        id: generateId(),
        text: s.artist ? `${s.title} - ${s.artist}` : s.title,
        type: "sample" as const,
        searchQuery: `${s.title} ${s.artist}`.trim(),
      })),
    });
  };
  sampleCard("source", "Sample DNA", "This track samples");
  sampleCard("derived", "Sampled By", "Sampled by");

  // 3. Song-meaning research is not used (its page text can quote the song).

  // 4. Artist collaborators network: they are one artist's (MusicBrainz names which), never
  //    the joined artists of a multi-artist track.
  if (research.collaborators && research.collaborators.length > 0 && research.collaboratorsOf) {
    const collabNames = research.collaborators.slice(0, 4).join(", ");
    factoids.push({
      id: generateId(),
      title: "Collaboration Network",
      content: `${research.collaboratorsOf} has worked with: ${collabNames}.`,
      type: "connection",
      entities: research.collaborators.slice(0, 4).map((name) => ({
        id: generateId(),
        text: name,
        type: "artist" as const,
        searchQuery: name,
      })),
    });
  }

  // 5. No discography card: the Spotify top-tracks step was removed with Spotify's endpoint.

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
