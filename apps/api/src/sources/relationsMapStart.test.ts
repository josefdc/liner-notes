/**
 * The relations map's first read, made while the chain waits: an error in it costs the map
 * those dates, never the recording. Here reading the recording's relations throws once (the
 * map's read, the first to ask for them) on "Ice Ice Baby" (the captured fixtures).
 */

import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { captureLogsForTests } from "../logger.js";
import { collectPrimarySources, MAP_INCOMPLETE } from "./identity.js";
import { MusicBrainzRateLimiter, recordingRelationships } from "./musicbrainz.js";
import { stubFetch } from "./testing/fetchStub.js";
import { ICE_TRACK, primaryRoute } from "./testing/iceIceBaby.js";

vi.mock("./musicbrainz.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./musicbrainz.js")>();
  return { ...actual, recordingRelationships: vi.fn(actual.recordingRelationships) };
});

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

it("keeps the recording when the map's first read throws, and reports the dates not read", async () => {
  onTestFinished(MusicBrainzRateLimiter.getInstance().setIntervalForTests(0));
  const logs = captureLogsForTests({ level: "warn" });
  onTestFinished(() => logs.restore());
  vi.mocked(recordingRelationships).mockImplementationOnce(() => {
    throw new Error("malformed relations");
  });
  const net = stubFetch(primaryRoute);
  const sources = await collectPrimarySources(ICE_TRACK, { relationsMap: {} });

  // The chain goes on: the recording, its work's dates and its release are all read.
  expect(sources.identity?.recording.mbid).toBeTruthy();
  expect(sources.identity?.coverRelease).toBeTruthy();
  const mb = sources.musicbrainz;
  if (mb.status !== "found") throw new Error(mb.reason);
  expect(mb.error).toBeUndefined();
  // The relations are dated after the chain instead, and the map says what it did not read.
  expect(net.calls.filter((c) => isDateSearch(c.url)).length).toBeGreaterThan(0);
  expect(logs.messages("warn").filter((line) => /Relations map/.test(line))).toEqual([
    expect.stringMatching(
      /: not read the dates of the recording's relations \(malformed relations\)$/,
    ),
  ]);
  expect(mb.incomplete).toContain(MAP_INCOMPLETE);
});
