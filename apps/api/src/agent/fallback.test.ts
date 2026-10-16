/**
 * Fallback track data (used when the model call fails): no invented values, missing
 * fields omitted, no model-generated facts, and no song-meaning text, even from old research.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A working model: any call made while building the fallback would add its facts.
const model = vi.hoisted(() => ({
  generateStructuredOutput: vi.fn(async () => ({
    data: {
      factoids: [
        { title: "MODEL_FACT", content: "MODEL_FACT invented by a model", type: "trivia" },
      ],
    },
    model: "fast-model",
    groundingUsed: false,
  })),
}));
vi.mock("./geminiClient.js", () => ({
  generateStructuredOutput: model.generateStructuredOutput,
}));

import { createFallbackTrackData } from "./fallback.js";
import { TrackDataSchema } from "./schema.js";
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

  it("prints the same BPM as the payload", async () => {
    const td = await build({
      bpm: 98.5,
      key: "A Minor",
      energy: null,
      valence: null,
      danceability: null,
      acousticness: null,
      instrumentalness: null,
      confidence: "low",
    });
    expect(td.bpm).toBe(98.5);
    expect(allText(td.factoids)).toContain("98.5 BPM in A Minor");
  });

  it("returns a schema-valid payload with no factoids when nothing is known", async () => {
    const td = await build(null, emptyResearch, {
      releaseDate: "",
      album: "",
      popularity: undefined as unknown as number,
    });
    expect(td.factoids).toEqual([]);
    const parsed = TrackDataSchema.safeParse(td);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
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

  it("makes no model call and contains no model-generated facts", async () => {
    model.generateStructuredOutput.mockClear();
    const td = await build(null);
    expect(model.generateStructuredOutput).not.toHaveBeenCalled();
    expect(allText(td.factoids)).not.toContain("MODEL_FACT");
  });

  it("labels audio model scores as estimates and tempo, key and energy as measured", async () => {
    const td = await build({
      bpm: 116,
      key: "D Minor",
      energy: 0.72,
      valence: 0.2,
      danceability: 0.64,
      acousticness: 0.1,
      instrumentalness: 0.01,
      confidence: "high",
    });
    const profile = td.factoids.find((f) => f.title === "Sonic Profile")?.content ?? "";
    expect(profile).toContain("116 BPM in D Minor.");
    expect(profile).toContain("High measured energy.");
    expect(profile).toContain("Mood (audio model estimate): dark.");
    expect(profile).toContain("Danceability score (audio model estimate): 0.64.");
    expect(profile).not.toMatch(/%|Measured mood/);
  });

  it("never turns search tool status or error text into a factoid", async () => {
    const td = await build(null, {
      samples: ["Web search is not available. Please set TAVILY_API_KEY."],
      productionTrivia: [
        "Web search is not available. Please set TAVILY_API_KEY.",
        "Error searching for production history: upstream request timed out after 30s",
        'No production history found for "Ice Ice Baby" by Vanilla Ice.',
      ],
      relatedArtists: [],
    });
    const text = allText(td.factoids);
    expect(text).not.toMatch(/TAVILY|Web search|Error searching|No production history/);
  });

  it("parses MusicBrainz tags and leaves out structured data and song-meaning text", async () => {
    const td = await build(null, {
      samples: ['[MusicBrainz Samples] [{"title":"Under Pressure","artist":"Queen"}]'],
      productionTrivia: [
        '[MusicBrainz Covers] [{"title":"Ice Ice Baby","artist":"Cover Band X","year":"[2001]"}]',
      ],
      songMeaning: [
        "[Genius Lyrics]\nLINE_ONE_OF_SONG_TEXT line two line three line four line five",
        '[Genius Annotations] [{"fragment":"LINE_TWO_OF_SONG_TEXT","annotation":"x"}]',
        "The song is about LINE_THREE_OF_SONG_TEXT and more words to pass any length filter",
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
