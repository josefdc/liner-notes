/**
 * Route tests for /api/search/suggest: validation limits, generic errors and the fields each
 * suggestion carries. The Spotify client's search is a stub; Spotify is never called.
 */

import { SearchSuggestResponse } from "@liner-notes/contract";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceError } from "../../sources/http.js";
import { createTestApp } from "../testApp.js";
import searchRouter from "./search.js";

const spotify = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("../../sources/spotify.js", () => ({ searchTracks: spotify.invoke }));

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
    spotify.invoke.mockResolvedValue([{ id: "t1" }]);
    const query = "\u{1F3B5}".repeat(200);

    const res = await request(app()).get(
      `/api/search/suggest?query=${encodeURIComponent(query)}&limit=3`,
    );

    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([{ id: "t1" }]);
    expect(spotify.invoke).toHaveBeenCalledWith(query, 3);
  });

  it("sends no preview link with the suggestions", async () => {
    spotify.invoke.mockResolvedValue([
      { id: "t1", isrc: "USAT29900609", previewUrl: "https://p.scdn.co/mp3-preview/abc" },
    ]);

    const res = await request(app()).get("/api/search/suggest?query=ice%20ice%20baby");

    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([{ id: "t1", isrc: "USAT29900609" }]);
  });

  it("sends each suggestion's release date as Spotify gave it, and none for a track without one", async () => {
    const midnightCity = {
      id: "6GyFP1nfCDB8lbD2bG0Hq9",
      title: "Midnight City",
      artist: "M83",
      album: "Hurry Up, We're Dreaming",
      coverUrl: "",
      isrc: "FR6V81141061",
      previewUrl: null,
    };
    spotify.invoke.mockResolvedValue([
      { ...midnightCity, releaseDate: "2011-10-18" },
      { ...midnightCity, id: "0000000000000000000002", releaseDate: "2011" },
      { ...midnightCity, id: "0000000000000000000003", isrc: null },
    ]);

    const res = await request(app()).get("/api/search/suggest?query=midnight%20city");

    expect(res.status).toBe(200);
    // The web casts the answer to the contract type without parsing it; parsing it here checks
    // that the route sends the date and that the contract's schema does not strip it.
    const { suggestions } = SearchSuggestResponse.parse(res.body);
    expect(suggestions.map((suggestion) => suggestion.releaseDate ?? null)).toEqual([
      "2011-10-18",
      "2011",
      null,
    ]);
  });

  it("answers a Spotify failure with a generic message, not the upstream one", async () => {
    spotify.invoke.mockRejectedValue(
      new SourceError("spotify", "http", "Spotify API error: 401 token xyz", { status: 401 }),
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
