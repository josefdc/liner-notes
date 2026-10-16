/**
 * Historian node: song-meaning page text (which can carry lyrics) from research cached
 * before that step was removed never reaches the graph state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({ getResearch: vi.fn(), putResearch: vi.fn() }));
vi.mock("../../store/cache.js", () => ({ getCache: () => cache }));

import { historianNode } from "./historianNode.js";
import type { SonicAgentStateType } from "../state.js";

describe("historianNode", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops song-meaning text from cached research", async () => {
    cache.getResearch.mockReturnValue({
      samples: ["Sample A"],
      productionTrivia: ["Trivia"],
      songMeaning: [
        "[Genius Lyrics]\nLINE_ONE_OF_SONG_TEXT",
        "Song meaning page: LINE_TWO_OF_SONG_TEXT",
      ],
      relatedArtists: [],
    });

    const out = await historianNode(
      { spotifyData: { id: "x", title: "T", artist: "A" } } as unknown as SonicAgentStateType,
      { writer: () => {} } as never,
    );

    expect(out.researchData).toEqual({
      samples: ["Sample A"],
      productionTrivia: ["Trivia"],
      relatedArtists: [],
    });
    expect(JSON.stringify(out)).not.toContain("SONG_TEXT");
  });
});
