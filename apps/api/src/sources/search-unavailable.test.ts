/**
 * Web search without TAVILY_API_KEY: every research search reports the source as not
 * configured (a typed failure the researcher records as a source error, never research), makes
 * no request, and the missing key is logged once.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { stubFetch } from "./testing/fetchStub.js";

vi.hoisted(() => {
  // Empty before the module loads, so a local .env does not supply a key.
  process.env.TAVILY_API_KEY = "";
});

import { searchMusicInfo, searchProductionHistory, searchSamples } from "./search.js";
import { readToolResult } from "./toolResult.js";

describe("web search without an API key", () => {
  let net: ReturnType<typeof stubFetch>;
  // A plain list, not mock.calls: mock history may be cleared between tests.
  const warnings: string[] = [];

  beforeAll(() => {
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    net = stubFetch(() => undefined);
  });
  afterEach(() => {
    expect(net.calls, "network calls").toHaveLength(0);
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    [
      "samples",
      () => searchSamples.invoke({ songTitle: "Ice Ice Baby", artistName: "Vanilla Ice" }),
    ],
    [
      "production",
      () =>
        searchProductionHistory.invoke({ songTitle: "Ice Ice Baby", artistName: "Vanilla Ice" }),
    ],
    ["general", () => searchMusicInfo.invoke({ query: "Ice Ice Baby" })],
  ])("%s reports the source as not configured", async (_name, run) => {
    const result = await run();

    expect(JSON.parse(result)).toEqual({
      found: false,
      code: "not_configured",
      error: "tavily: TAVILY_API_KEY is not set",
      unavailable: true,
    });
    expect(readToolResult("tavily", result)).toMatchObject({
      kind: "failed",
      error: { source: "tavily", code: "not_configured" },
    });
  });

  it("under replay, a missing key does not block: the cassette answers", async () => {
    process.env.SOURCE_CASSETTE = "replay";
    process.env.SOURCE_CASSETTE_DIR = join(tmpdir(), "no-such-cassette-dir");
    try {
      const result = await searchSamples.invoke({ songTitle: "Ice", artistName: "Vanilla Ice" });
      expect(JSON.parse(result)).toMatchObject({
        found: false,
        code: "unavailable",
        error: expect.stringMatching(/^tavily: no cassette entry/),
      });
    } finally {
      delete process.env.SOURCE_CASSETTE;
      delete process.env.SOURCE_CASSETTE_DIR;
    }
  });

  it("logs the missing key once", async () => {
    // Runs searches itself, so it holds in any test order.
    await searchSamples.invoke({ songTitle: "Ice Ice Baby", artistName: "Vanilla Ice" });
    await searchMusicInfo.invoke({ query: "Ice Ice Baby" });
    expect(warnings.filter((line) => line.includes("TAVILY_API_KEY"))).toHaveLength(1);
  });
});
