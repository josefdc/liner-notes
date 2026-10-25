/**
 * A Spotify search with no match (stubbed): the client returns `[]`, and the suggest route
 * answers 200 with no suggestions.
 */

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, stubFetch } from "./testing/fetchStub.js";

vi.hoisted(() => {
  process.env.SPOTIFY_CLIENT_ID = "test-client";
  process.env.SPOTIFY_CLIENT_SECRET = "test-secret";
});

import searchRouter from "../http/routes/search.js";
import { createTestApp } from "../http/testApp.js";
import { SpotifyAuthManager, searchTracks } from "./spotify.js";

function emptySpotify() {
  return stubFetch((call) => {
    if (call.url === "https://accounts.spotify.com/api/token") {
      return json({ access_token: "test-token", token_type: "Bearer", expires_in: 3600 });
    }
    if (call.url.startsWith("https://api.spotify.com/v1/search?")) {
      return json({ tracks: { items: [], total: 0 } });
    }
    return undefined;
  });
}

describe("a Spotify search with no match", () => {
  beforeEach(() => {
    SpotifyAuthManager.getInstance().clearToken();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns []", async () => {
    emptySpotify();

    expect(await searchTracks("zzzz no such song", 5)).toEqual([]);
  });

  it("the suggest route answers 200 with no suggestions", async () => {
    emptySpotify();

    const res = await request(createTestApp(searchRouter))
      .get("/api/search/suggest")
      .query({ query: "zzzz no such song" });

    expect(res.status).toBe(200);
    expect(res.body.suggestions).toEqual([]);
  });
});
