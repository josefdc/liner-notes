/**
 * How the analyze route reads the scout's error: only the scout's exact outcomes count. The
 * scout reports "No tracks found" when Spotify answered `[]`, text starting "Error: " when the
 * Spotify client could not answer, and "Scout error: …" when something threw.
 */

import { describe, expect, it } from "vitest";
import { classifyNodeError } from "./analyze.js";

describe("classifyNodeError", () => {
  it.each([
    ["No tracks found", "no_match"],
    ["Error: searching for tracks failed: spotify: HTTP 503", "upstream_unavailable"],
    ["Error: Rate limited by Spotify (429) while searching for tracks", "upstream_unavailable"],
    ["Scout error: fetch failed", "upstream_unavailable"],
    // Text the old patterns accepted but the scout never sends now.
    ['No tracks found for "x".', "failed"],
    ["No track data available", "failed"],
    ["Error searching for tracks: 503", "failed"],
    // The prefix is anchored at the start.
    ["Unexpected Error: something", "failed"],
    [" Error: something", "failed"],
    ["secret-odd-detail", "failed"],
  ])("scout error %j is %s", (error, code) => {
    expect(classifyNodeError("scout", error)).toBe(code);
  });

  it("an error from another node is a plain failure", () => {
    expect(classifyNodeError("historian", "No tracks found")).toBe("failed");
    expect(classifyNodeError("composer", "Error: model unavailable")).toBe("failed");
  });
});
