/**
 * TrackAnalysis v1 accepts every payload the API produces today, and the stream events of the
 * web app's mock fixtures fit the event union once they carry a run id and a sequence number.
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
type MockFixture = {
  suggestions: unknown[];
  streams: Record<string, StreamEvent[] | { opens: StreamEvent[][] }>;
};

const apiPayloads = jsonFiles(join(packageDir, "fixtures", "api-payloads"));
const mockFixtures = jsonFiles(join(repoDir, "tests", "mock-sse", "fixtures")) as Array<
  [string, MockFixture]
>;

const eventsOf = (fixture: MockFixture) =>
  Object.entries(fixture.streams).flatMap(([path, entry]) =>
    (Array.isArray(entry) ? entry : entry.opens.flat())
      // Directives of the mock server, not events
      .filter((event) => typeof event.type === "string")
      .map((event) => ({ path, event })),
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

  it.each(mockFixtures)(
    "%s: events fit the union once they carry runId and seq",
    (name, fixture) => {
      const misfits: string[] = [];
      eventsOf(fixture).forEach(({ path, event }, seq) => {
        const factoidStream = path.startsWith("/api/factoids/");
        const schema = factoidStream ? FactoidStreamEvent : AnalyzeStreamEvent;
        const withEnvelope = { ...event, runId: factoidStream ? null : "run-1", seq };
        if (!schema.safeParse(withEnvelope).success) misfits.push(event.type);
      });
      // `candidates` is the protocol before the single `interrupt` event (#8); a factoid event
      // with the removed lyrics type is one item of the stream, and is skipped as a whole.
      const expected: Record<string, string[]> = {
        hitl: ["candidates"],
        "decrypt-after-model-unavailable": ["factoid"],
      };
      expect(misfits).toEqual(expected[name] ?? []);
    },
  );
});
