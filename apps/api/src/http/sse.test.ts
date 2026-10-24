/**
 * Unit tests for the `onSent` observer of the stream adapter: what it is given, and that it
 * cannot break a stream.
 */

import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAnalysisStream, type SentEvent } from "./sse.js";

/** An app whose one route sends `connected`, an invalid progress event, a status and `done`. */
function appObservedBy(onSent: (event: SentEvent) => void) {
  const app = express();
  app.get("/stream", (_req, res) => {
    const stream = openAnalysisStream(res, "run-1", { heartbeatMs: 0, onSent });
    const timestamp = new Date().toISOString();
    stream.send({ type: "connected", threadId: "run-1", timestamp, extra: "not in the contract" });
    stream.send({ type: "claim", nonsense: true });
    stream.send({ type: "status", message: "working", timestamp });
    stream.done();
  });
  return app;
}

const types = (body: string) =>
  body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)).type);

afterEach(() => vi.restoreAllMocks());

describe("onSent", () => {
  it("is given each written event as the contract reads it, and not dropped ones", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: SentEvent[] = [];
    const res = await request(appObservedBy((event) => seen.push(event))).get("/stream");
    expect(types(res.text)).toEqual(["connected", "status", "done"]);
    expect(seen.map(({ type, seq, runId }) => ({ type, seq, runId }))).toEqual([
      { type: "connected", seq: 0, runId: "run-1" },
      { type: "status", seq: 1, runId: "run-1" },
      { type: "done", seq: 2, runId: "run-1" },
    ]);
    expect(seen[0]).not.toHaveProperty("extra");
  });

  it("cannot break the stream by throwing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(
      appObservedBy(() => {
        throw new Error("observer failed");
      }),
    ).get("/stream");
    expect(types(res.text)).toEqual(["connected", "status", "done"]);
    expect(errors.mock.calls.some(([line]) => String(line).includes("not observed"))).toBe(true);
  });
});
