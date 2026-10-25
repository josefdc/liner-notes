/**
 * The MusicBrainz queue is shared by every run (and by ListenBrainz) and drained by whichever
 * caller found it idle; a request it runs still logs under its own caller's run id.
 */

import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { type CapturedLogs, captureLogsForTests, withRun } from "../logger.js";
import { lookupIsrc, MusicBrainzRateLimiter, withMusicBrainzPriority } from "./musicbrainz.js";
import { queueOnFakeClock, settleOnFakeClock } from "./testing/fakeClock.js";
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

it("serves the primary-source chain's requests ahead of others, and still under their run", async () => {
  // On a fake clock the next request still waits its turn however long the machine takes to
  // queue the others: only the queue's own timer moves the clock.
  queueOnFakeClock(30);
  const net = stubFetch(() => json({ recordings: [] }));
  // A request just made: the next one waits its turn.
  await settleOnFakeClock(lookupIsrc("GBAYE0000351"));
  net.calls.length = 0;
  // Another run's research queues three requests first; a chain then asks for two.
  const research = withRun("run-research", () =>
    Promise.all(["GBUM71106916", "USUM72401994", "USSM19000034"].map((isrc) => lookupIsrc(isrc))),
  );
  const chain = withRun("run-chain", () =>
    withMusicBrainzPriority(() =>
      Promise.all(["USCA29001716", "USAT29900609"].map((isrc) => lookupIsrc(isrc))),
    ),
  );
  await settleOnFakeClock(Promise.all([research, chain]));

  const order = net.calls.map((c) => new URL(c.url).pathname.replace("/ws/2/isrc/", ""));
  // The chain's go first, then the research's in their order.
  expect(order).toEqual([
    "USCA29001716",
    "USAT29900609",
    "GBUM71106916",
    "USUM72401994",
    "USSM19000034",
  ]);
  const runs = logs
    .entries()
    .filter((entry) => entry.component === "MusicBrainz")
    .map((entry) => [entry.runId, entry.msg]);
  expect(runs).toContainEqual(["run-chain", "Request: /isrc/USCA29001716"]);
  expect(runs).toContainEqual(["run-research", "Request: /isrc/USSM19000034"]);
});
