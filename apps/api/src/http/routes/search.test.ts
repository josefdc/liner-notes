/**
 * Route tests for /api/search/suggest: validation limits and generic errors. The Spotify search
 * tool is a stub; Spotify is never called.
 */

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestApp } from "../testApp.js";
import searchRouter from "./search.js";

const spotify = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("../../sources/spotify.js", () => ({
  searchMultipleTracks: { invoke: spotify.invoke },
}));

const app = () => createTestApp(searchRouter);

beforeEach(() => {
  spotify.invoke.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("GET /api/search/suggest", () => {
  it.each([
    ["a missing query", ""],
    ["a one-character query", "query=a"],
    ["a query of 201 characters", `query=${"a".repeat(201)}`],
    ["a repeated query", "query=midnight&query=city"],
    ["a query with a control character", "query=mid%00night"],
    ["a query of only format characters", "query=%E2%80%8B%E2%80%AE%E2%80%8B"],
    ["a limit above 10", "query=midnight&limit=11"],
    ["a limit of 0", "query=midnight&limit=0"],
    ["a non-numeric limit", "query=midnight&limit=five"],
  ])("answers 400 to %s without calling Spotify", async (_label, query) => {
    const res = await request(app()).get(`/api/search/suggest?${query}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: "invalid_input" });
    expect(spotify.invoke).not.toHaveBeenCalled();
  });

  it("reads bracketed query parameters as plain names, never as objects", async () => {
    const res = await request(app()).get("/api/search/suggest?query[a]=midnight&limit[b]=3");

    expect(res.status).toBe(400);
    expect(res.body.issues).toEqual(["query: Invalid input: expected string, received undefined"]);
    expect(spotify.invoke).not.toHaveBeenCalled();
  });

  it("passes a query of 200 code points and the limit to Spotify", async () => {
    spotify.invoke.mockResolvedValue(JSON.stringify([{ id: "t1" }]));
    const query = "\u{1F3B5}".repeat(200);

    const res = await request(app()).get(
      `/api/search/suggest?query=${encodeURIComponent(query)}&limit=3`,
    );

    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([{ id: "t1" }]);
    expect(spotify.invoke).toHaveBeenCalledWith({ query, limit: 3 });
  });

  it("sends no preview link with the suggestions", async () => {
    spotify.invoke.mockResolvedValue(
      JSON.stringify([
        { id: "t1", isrc: "USAT29900609", previewUrl: "https://p.scdn.co/mp3-preview/abc" },
      ]),
    );

    const res = await request(app()).get("/api/search/suggest?query=ice%20ice%20baby");

    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([{ id: "t1", isrc: "USAT29900609" }]);
  });

  it("answers a Spotify failure with a generic message, not the upstream one", async () => {
    spotify.invoke.mockResolvedValue(
      "Error searching for tracks: Spotify API error: 401 token xyz",
    );

    const res = await request(app()).get("/api/search/suggest?query=midnight");

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      success: false,
      code: "upstream_unavailable",
      suggestions: [],
    });
    expect(JSON.stringify(res.body)).not.toMatch(/Spotify API error|token xyz/);
  });

  it("answers a thrown error with a generic message", async () => {
    spotify.invoke.mockRejectedValue(new Error("connect ECONNREFUSED /home/user/app"));

    const res = await request(app()).get("/api/search/suggest?query=midnight");

    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toMatch(/ECONNREFUSED|\/home/);
  });
});
