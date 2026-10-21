/**
 * TrackAnalysis v1 accepts every payload the API produces today, and the web app's mock fixtures
 * replay the API's own event sequences: every event fits the event union as it is written, with
 * its run id and sequence number, except those marked `$unchecked` (sent on purpose).
 *
 * fixtures/api-payloads/ holds results built with the API's own functions at commit 58f9b0a:
 * createEmptyTrackData (empty), transformFlatToTrackData followed by the composer node's
 * Spotify overrides (composed-*: measured, partly measured, unmeasured and missing audio) and
 * createFallbackTrackData with modelUnavailable set as the composer does (fallback-*).
 * tests/mock-sse/fixtures/ are the web app's end-to-end fixtures, read in place.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnalyzeStreamEvent, FactoidStreamEvent } from "./events.js";
import { jsonFiles, packageDir, repoDir } from "./testing/samples.js";
import { Factoid, SearchCandidate, TrackAnalysis } from "./track.js";

type StreamEvent = { type: string; [field: string]: unknown };
type Directive = { $unchecked?: StreamEvent; [field: string]: unknown };
type MockFixture = {
  suggestions: unknown[];
  streams: Record<string, Array<StreamEvent | Directive> | { opens: StreamEvent[][] }>;
};

const apiPayloads = jsonFiles(join(packageDir, "fixtures", "api-payloads"));
const mockFixtures = jsonFiles(join(repoDir, "tests", "mock-sse", "fixtures")) as Array<
  [string, MockFixture]
>;

type MarkedEvent = { event: StreamEvent; unchecked: boolean };

/** Each opening of each stream path: its events, `$unchecked` ones unwrapped and marked. */
const streamsOf = (fixture: MockFixture) =>
  Object.entries(fixture.streams).flatMap(([path, entry]) =>
    (Array.isArray(entry) ? [entry] : entry.opens).map((events) => ({
      path,
      events: (events as Array<StreamEvent | Directive>).flatMap((item): MarkedEvent[] => {
        if (typeof item.type === "string")
          return [{ event: item as StreamEvent, unchecked: false }];
        // Other directives of the mock server are not events.
        const { $unchecked } = item as Directive;
        return $unchecked ? [{ event: $unchecked, unchecked: true }] : [];
      }),
    })),
  );

const eventsOf = (fixture: MockFixture) =>
  streamsOf(fixture).flatMap(({ path, events }) =>
    events.map(({ event, unchecked }) => ({ path, event, unchecked })),
  );

const issuePaths = (result: {
  success: boolean;
  error?: { issues: Array<{ path: unknown[] }> };
}) => (result.success ? [] : (result.error?.issues ?? []).map((issue) => issue.path.join(".")));

describe("API payloads", () => {
  it("are all present", () => {
    expect(apiPayloads.map(([name]) => name)).toEqual([
      "composed-measured",
      "composed-no-audio",
      "composed-partial-audio",
      "composed-unmeasured",
      "empty",
      "fallback-measured",
      "fallback-no-audio",
    ]);
  });

  it.each(apiPayloads)("%s parses unchanged", (_name, payload) => {
    const parsed = TrackAnalysis.safeParse(payload);
    expect(issuePaths(parsed)).toEqual([]);
    // Nothing stripped and nothing filled in: v1 already describes every field.
    expect(parsed.data).toEqual(payload);
  });
});

describe("web mock fixtures", () => {
  const results = mockFixtures.flatMap(([name, fixture]) =>
    eventsOf(fixture)
      .filter(({ event }) => event.type === "complete")
      .map(({ event }) => [name, event.data] as const),
  );

  it("include results", () => {
    expect(results.length).toBeGreaterThanOrEqual(mockFixtures.length);
  });

  it.each(results)("%s: the result parses", (_name, data) => {
    expect(issuePaths(TrackAnalysis.safeParse(data))).toEqual([]);
  });

  it("a pre-honest result reads without what this reader cannot show", () => {
    // From before the API stopped estimating audio and dropped lyrics (#9); the current API
    // cannot produce it (its result cache was purged, #7). The lyrics factoid is dropped, and
    // the "estimated" audio source becomes absent, which readers treat as not measured.
    const [, legacy] = results.find(([name]) => name === "legacy-estimated") ?? [];
    const parsed = TrackAnalysis.parse(legacy);
    expect(parsed.audioSource).toBeUndefined();
    expect(parsed.factoids.map((factoid) => factoid.id)).toEqual(["f1", "g1", "g2"]);
  });

  it("an older result without lists reads them as empty", () => {
    const [, sparse] = results.find(([name]) => name === "sparse-result") ?? [];
    const parsed = TrackAnalysis.parse(sparse);
    expect(parsed).toMatchObject({
      segments: [],
      samples: [],
      factoids: [],
      genealogy: { links: [] },
    });
  });

  it.each(mockFixtures)("%s: suggestions and candidates parse", (_name, fixture) => {
    const candidates = eventsOf(fixture).flatMap(({ event }) =>
      Array.isArray(event.candidates) ? event.candidates : [],
    );
    for (const candidate of [...fixture.suggestions, ...candidates]) {
      expect(SearchCandidate.safeParse(candidate).success).toBe(true);
    }
  });

  it("factoid events parse, except one with the removed lyrics type", () => {
    const factoids = mockFixtures.flatMap(([, fixture]) =>
      eventsOf(fixture)
        .filter(({ event }) => event.type === "factoid")
        .map(({ event }) => event.data as { id: string }),
    );
    expect(factoids.length).toBeGreaterThan(0);
    const rejected = factoids.filter((data) => !Factoid.safeParse(data).success);
    expect(rejected.map((data) => data.id)).toEqual(["m2"]);
  });

  it.each(mockFixtures)("%s: events fit the union as they are written", (name, fixture) => {
    const misfits: string[] = [];
    const unchecked: string[] = [];
    for (const { path, event, unchecked: marked } of eventsOf(fixture)) {
      const schema = path.startsWith("/api/factoids/") ? FactoidStreamEvent : AnalyzeStreamEvent;
      const fits = schema.safeParse(event).success;
      if (marked) unchecked.push(`${event.type}${fits ? " (fits)" : ""}`);
      else if (!fits) misfits.push(event.type);
    }
    expect(misfits).toEqual([]);
    // A factoid event with the removed lyrics type is one item of an older stream, skipped as a
    // whole by the client.
    const expected: Record<string, string[]> = {
      "decrypt-after-model-unavailable": ["factoid"],
    };
    expect(unchecked).toEqual(expected[name] ?? []);
  });

  it.each(mockFixtures)("%s: streams follow the API's sequence", (_name, fixture) => {
    for (const { path, events } of streamsOf(fixture)) {
      const all = events.map(({ event }) => event);
      // One run per stream; seq 0, 1, 2… on every event but heartbeats, which carry none.
      expect(new Set(all.map((event) => event.runId)).size, path).toBe(1);
      const numbered = all.filter((event) => event.type !== "heartbeat");
      expect(
        numbered.map((event) => event.seq),
        path,
      ).toEqual(numbered.map((_, index) => index));
      expect(all.filter((event) => event.type === "heartbeat" && "seq" in event)).toEqual([]);
      // The picker is announced by `interrupt` alone (#8); one result at most; `done` last.
      expect(
        all.filter((event) => event.type === "candidates"),
        path,
      ).toEqual([]);
      expect(all.filter((event) => event.type === "complete").length).toBeLessThanOrEqual(1);
      expect(all.filter((event) => event.type === "done").length, path).toBe(1);
      expect(all.at(-1)?.type, path).toBe("done");
    }
  });
});
