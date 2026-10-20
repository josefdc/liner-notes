/**
 * Deezer preview search with a stubbed API: Deezer reports errors (its quota included) inside
 * an HTTP 200 answer, which must be read as an error, not as "no track".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchDeezerPreview } from "./deezer.js";
import { json, stubFetch } from "./testing/fetchStub.js";

describe("Deezer preview search", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("an error in a 200 answer is reported as an error", async () => {
    stubFetch((call) =>
      call.url.startsWith("https://api.deezer.com/search/track?")
        ? json({ error: { type: "Exception", message: "Quota limit exceeded", code: 4 } })
        : undefined,
    );

    const data = JSON.parse(
      await searchDeezerPreview.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
    );

    expect(data).toMatchObject({ found: false, previewUrl: null });
    expect(data.error).toContain("Quota limit exceeded");
  });
});
