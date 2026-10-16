/**
 * Fallback track data (used when the model call fails): no invented values, missing
 * fields omitted, and no song text from research cached before the Genius source was removed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./geminiClient.js", () => ({
  generateStructuredOutput: async () => ({
    data: null,
    model: "test-model",
    groundingUsed: false,
    error: "Client not initialized",
  }),
}));

import { createFallbackTrackData } from "./fallback.js";
import type { AudioFeatures, ResearchData, SonicAgentStateType, SpotifyData } from "./state.js";

const spotify: SpotifyData = {
  id: "x",
  title: "Ice Ice Baby",
  artist: "Vanilla Ice",
  artistIds: [],
  album: "To the Extreme",
  releaseDate: "1990-09-10",
  coverUrl: "https://i.scdn.co/image/x",
  popularity: 70,
  duration: "4:30",
  durationMs: 270000,
  explicit: false,
  spotifyUrl: "https://open.spotify.com/track/x",
  previewUrl: null,
};

const emptyResearch: ResearchData = {
  samples: [],
  productionTrivia: [],
  songMeaning: [],
  relatedArtists: [],
};

function build(
  audioFeatures: AudioFeatures | null,
  researchData: ResearchData = emptyResearch,
  spotifyData: Partial<SpotifyData> = {},
) {
  return createFallbackTrackData({
    spotifyData: { ...spotify, ...spotifyData },
    audioFeatures,
    researchData,
  } as unknown as SonicAgentStateType);
}

const allText = (factoids: Array<{ title: string; content: string }>) =>
  factoids.map((f) => `${f.title} ${f.content}`).join("\n");

describe("createFallbackTrackData", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not invent audio values when nothing was measured", async () => {
    const td = await build(null);

    expect(td).toMatchObject({
      bpm: null,
      key: null,
      energy: null,
      valence: null,
      danceability: null,
      acousticness: null,
      audioSource: "unavailable",
      audioUnavailableReason: "not_run",
      segmentsSource: "template",
    });
    const text = allText(td.factoids);
    expect(text).not.toMatch(/BPM|C Major|energy|mood|Danceability/i);
  });

  it("describes only the audio values that were measured", async () => {
    const td = await build({
      bpm: 116,
      key: "D Minor",
      energy: 0.72,
      valence: null,
      danceability: null,
      acousticness: null,
      instrumentalness: null,
      confidence: "low",
    });

    expect(td).toMatchObject({ bpm: 116, key: "D Minor", audioSource: "analyzed" });
    const profile = td.factoids.find((f) => f.title === "Sonic Profile");
    expect(profile?.content).toContain("116 BPM in D Minor");
    expect(profile?.content).not.toMatch(/mood|Danceability/i);
  });

  it("omits missing metadata instead of printing undefined or Unknown", async () => {
    const td = await build(null, emptyResearch, {
      releaseDate: "",
      popularity: undefined as unknown as number,
    });

    const text = allText(td.factoids);
    expect(text).not.toMatch(/undefined|Unknown|null|NaN/);
    expect(text).toContain('Released on "To the Extreme".');
  });

  it("parses MusicBrainz tags and leaves out structured data and legacy song text", async () => {
    const td = await build(null, {
      samples: ['[MusicBrainz Samples] [{"title":"Under Pressure","artist":"Queen"}]'],
      productionTrivia: [
        '[MusicBrainz Covers] [{"title":"Ice Ice Baby","artist":"Cover Band X","year":"[2001]"}]',
      ],
      songMeaning: [
        "[Genius Lyrics]\nLINE_ONE_OF_SONG_TEXT line two line three line four line five",
        '[Genius Annotations] [{"fragment":"LINE_TWO_OF_SONG_TEXT","annotation":"x"}]',
      ],
      relatedArtists: [],
    });

    const text = allText(td.factoids);
    expect(text).toContain('This track samples: "Under Pressure" by Queen.');
    expect(text).not.toContain("SONG_TEXT");
    expect(text).not.toContain("Cover Band X");
    expect(text).not.toMatch(/[[{]"/);
  });
});
