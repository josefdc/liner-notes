/**
 * The MusicBrainz queue is shared by every run (and by ListenBrainz) and drained by whichever
 * caller found it idle; a request it runs still logs under its own caller's run id.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { type CapturedLogs, captureLogsForTests, withRun } from "../logger.js";
import { lookupIsrc, MusicBrainzRateLimiter } from "./musicbrainz.js";
import { json, stubFetch } from "./testing/fetchStub.js";

let restoreInterval: () => void;
let logs: CapturedLogs;
beforeAll(() => {
  // A real interval, so the second run's request waits in the queue behind the first.
  restoreInterval = MusicBrainzRateLimiter.getInstance().setIntervalForTests(30);
});
afterAll(() => restoreInterval());
beforeEach(() => {
  delete process.env.SOURCE_CASSETTE;
  logs = captureLogsForTests();
});
afterEach(() => {
  logs.restore();
  vi.unstubAllGlobals();
});

it("logs each queued request under the run that asked for it", async () => {
  stubFetch((call) =>
    call.url.startsWith("https://musicbrainz.org/ws/2/isrc/")
      ? json({ recordings: [] })
      : undefined,
  );

  await Promise.all([
    withRun("run-A", () => lookupIsrc("USCA29001716")),
    withRun("run-B", () => lookupIsrc("GBUM71106916")),
    withRun("run-C", () => lookupIsrc("USUM72401994")),
  ]);

  const requests = logs
    .entries()
    .filter((entry) => entry.component === "MusicBrainz")
    .map((entry) => [entry.runId, entry.msg]);
  expect(requests).toEqual([
    ["run-A", "Request: /isrc/USCA29001716"],
    ["run-B", "Request: /isrc/GBUM71106916"],
    ["run-C", "Request: /isrc/USUM72401994"],
  ]);
});
