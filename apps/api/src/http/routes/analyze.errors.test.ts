/**
 * An unexpected error inside an analyze handler reaches the app's error handler (the handlers
 * are wrapped in asyncRoute) instead of leaving the request unanswered. The graph is a stub
 * whose result cannot be serialised, so `res.json` throws inside the handler.
 */

import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RATE_LIMIT, DEFAULT_SEARCH_RATE_LIMIT } from "../../config/settings.js";
import { createApp } from "../app.js";
import analyzeRouter from "./analyze.js";

vi.mock("../../agent/graph.js", () => ({
  createSonicAgentGraph: () => ({
    async *stream() {
      // A result that fits the contract, with a field JSON cannot serialise.
      const trackData = {
        id: "t1",
        title: "T",
        artist: "A",
        album: "B",
        coverUrl: "",
        bpm: null,
        genealogy: { nodes: [], links: [] },
        plays: 10n,
      };
      yield ["updates", { composer: { trackData } }];
    },
    getState: async () => ({ tasks: [], config: {}, values: {} }),
  }),
}));

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("POST /api/analyze", () => {
  it("answers an error thrown inside the handler with a generic JSON 500", async () => {
    const app = createApp({
      http: {
        corsOrigins: [],
        trustProxy: 0,
        rateLimit: DEFAULT_RATE_LIMIT,
        globalRateLimit: DEFAULT_RATE_LIMIT,
        searchRateLimit: DEFAULT_SEARCH_RATE_LIMIT,
      },
      routers: [analyzeRouter],
    });

    const res = await request(app)
      .post("/api/analyze")
      .send({ query: "Midnight City M83" })
      .timeout(3000);

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, code: "internal_error" });
    expect(res.text).not.toContain("BigInt");
  });
});
