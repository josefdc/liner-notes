/**
 * A search with no Spotify match, through the real analyze routes, graph and scout: only the
 * Spotify API is stubbed (its search answers no tracks). The run must end as no_match (422),
 * not as an upstream failure.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { json, stubFetch } from "../../sources/testing/fetchStub.js";

vi.hoisted(() => {
  process.env.SPOTIFY_CLIENT_ID = "test-client";
  process.env.SPOTIFY_CLIENT_SECRET = "test-secret";
});

import { SpotifyAuthManager } from "../../sources/spotify.js";
import { closeDatabase, initializeDatabase } from "../../store/database.js";
import { createTestApp, withRunToken } from "../testApp.js";
import analyzeRouter from "./analyze.js";

const app = createTestApp(analyzeRouter);

type Event = { type: string; [key: string]: unknown };

function parseEvents(body: string): Event[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Event);
}

describe("analyze with no Spotify match", () => {
  let dir: string;
  let net: ReturnType<typeof stubFetch>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "analyze-no-match-"));
    initializeDatabase(join(dir, "test.db"));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    SpotifyAuthManager.getInstance().clearToken();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    net = stubFetch((call) => {
      if (call.url === "https://accounts.spotify.com/api/token") {
        return json({ access_token: "test-token", token_type: "Bearer", expires_in: 3600 });
      }
      if (call.url.startsWith("https://api.spotify.com/v1/search?")) {
        return json({ tracks: { items: [], total: 0 } });
      }
      return undefined;
    });
  });

  it("POST /api/analyze answers 422 no_match", async () => {
    const res = await request(app)
      .post(withRunToken("/api/analyze"))
      .send({ query: "zzzz no such song one" });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ success: false, code: "no_match" });
    expect(net.calls.some((c) => c.url.startsWith("https://api.spotify.com/v1/search?"))).toBe(
      true,
    );
  });

  it("the stream reports an error with code no_match", async () => {
    const res = await request(app)
      .get(withRunToken("/api/analyze/stream"))
      .query({ query: "zzzz no such song two" })
      .buffer(true)
      .parse((response, callback) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => callback(null, body));
      });

    const errors = parseEvents(res.body as string).filter((e) => e.type === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: "no_match" });
  });
});
