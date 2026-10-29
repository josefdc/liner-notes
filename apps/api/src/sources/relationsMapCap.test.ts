/**
 * The relations map with more recordings to date than one search asks for: here the most is
 * lowered to 2, so that "Ice Ice Baby" (three related recordings, the captured fixtures) has
 * one past it. That one is not asked, and is reported as not read.
 */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { captureLogsForTests } from "../logger.js";
import { collectPrimarySources, MAP_INCOMPLETE } from "./identity.js";
import { MusicBrainzRateLimiter } from "./musicbrainz.js";
import { stubFetch } from "./testing/fetchStub.js";
import { ICE_TRACK, primaryRoute } from "./testing/iceIceBaby.js";

vi.mock("./musicbrainz.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./musicbrainz.js")>()),
  RECORDING_DATES_MAX: 2,
}));

const isDateSearch = (url: string) =>
  url.startsWith("https://musicbrainz.org/ws/2/recording?query=");

beforeEach(() => {
  for (const name of ["DISCOGS_TOKEN", "GENIUS_ACCESS_TOKEN", "SHS_API_KEY", "SOURCE_CASSETTE"]) {
    delete process.env[name];
  }
  for (const method of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
  MusicBrainzRateLimiter.getInstance().resetForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  MusicBrainzRateLimiter.getInstance().resetForTests();
});

it("reports the recordings past the most one search asks for as not read", async () => {
  onTestFinished(MusicBrainzRateLimiter.getInstance().setIntervalForTests(0));
  const logs = captureLogsForTests({ level: "warn" });
  onTestFinished(() => logs.restore());
  const net = stubFetch(primaryRoute);
  const sources = await collectPrimarySources(ICE_TRACK, { relationsMap: {} });

  const searches = net.calls.filter((c) => isDateSearch(c.url));
  expect(searches).toHaveLength(1);
  const asked = new URL(searches[0].url).searchParams.get("query")?.split(" OR ") ?? [];
  expect(asked).toHaveLength(2);
  expect(logs.messages("warn").filter((line) => /Relations map/.test(line))).toEqual([
    expect.stringMatching(
      /: not read the dates of 1 recordings \(more than one search asks for\)$/,
    ),
  ]);
  expect(sources.musicbrainz.status === "found" && sources.musicbrainz.incomplete).toContain(
    MAP_INCOMPLETE,
  );
});
