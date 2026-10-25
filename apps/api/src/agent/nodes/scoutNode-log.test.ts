/**
 * The real scout node's log never holds the text the visitor typed above debug level: not in a
 * message, not in a field, whichever way the search goes (one match, a choice, no match by
 * title or artist, no result, Spotify failing). Spotify is a stub; the store is in memory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spotify = vi.hoisted(() => ({
  answer: (async () => []) as () => Promise<unknown[]>,
}));
vi.mock("../../sources/spotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sources/spotify.js")>()),
  searchTracks: async () => spotify.answer(),
}));

import { END, InMemoryStore, START, StateGraph } from "@langchain/langgraph";
import { type CapturedLogs, captureLogsForTests } from "../../logger.js";
import { SourceError } from "../../sources/http.js";
import { SonicAgentState } from "../state.js";
import { scoutNode } from "./scoutNode.js";

const MARKER = "zqxmarker";
const QUERY = `Midnight City M83 ${MARKER}`;

const track = (id: string, title: string, artist: string) => ({
  id,
  title,
  artist,
  album: "",
  releaseDate: "",
  coverUrl: "",
  duration: "",
  durationMs: 1,
  explicit: false,
  spotifyUrl: "",
  previewUrl: null,
  artistIds: [],
});

const graph = () =>
  new StateGraph(SonicAgentState)
    .addNode("scout", scoutNode)
    .addEdge(START, "scout")
    .addEdge("scout", END)
    .compile({ store: new InMemoryStore() });

let logs: CapturedLogs;
beforeEach(() => {
  logs = captureLogsForTests({ level: "debug" });
});
afterEach(() => logs.restore());

describe("the scout's log", () => {
  it.each([
    ["one match", async () => [track("t1", "Midnight City", "M83")]],
    [
      "a choice",
      async () => [
        track("t1", "Midnight City", "M83"),
        track("t2", "Midnight City", "M83"),
        track("t3", "Midnight City (Remix)", "M83"),
      ],
    ],
    ["no match by title or artist", async () => [track("t9", "Other Song", "Someone")]],
    ["no result", async () => []],
    [
      "Spotify failing",
      async () => {
        throw new SourceError("spotify", "unavailable", "HTTP 503");
      },
    ],
  ])("holds the typed text at debug only: %s", async (_label, answer) => {
    spotify.answer = answer;
    await graph().invoke({ songQuery: QUERY });

    const entries = logs.entries();
    const above = entries.filter((entry) => entry.level !== "debug" && entry.level !== "trace");
    expect(above.length, "lines above debug").toBeGreaterThan(0);
    for (const entry of above) {
      expect(JSON.stringify(entry).toLowerCase(), JSON.stringify(entry)).not.toContain(MARKER);
    }
    // The text is in the log, at debug.
    expect(
      entries.some((entry) => entry.level === "debug" && JSON.stringify(entry).includes(MARKER)),
    ).toBe(true);
  });
});
