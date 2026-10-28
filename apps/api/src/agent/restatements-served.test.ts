/**
 * A result stored before the verifier kept one claim per fact is served with each fact once: from
 * the long-term store (servedResult) and as a run's own stored result (GET /api/runs, resultOf).
 * The One More Time recording's result stands in for such a result.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ReplayRecord, type TrackAnalysis } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { resultOf } from "../http/routes/runs.js";
import { DEFAULT_REPLAY_DIR } from "../replay/records.js";
import type { RunRecord } from "../store/runs.js";
import type { TrackData } from "./schema.js";
import { servedResult } from "./storedResults.js";

const { analysis } = ReplayRecord.parse(
  JSON.parse(readFileSync(join(DEFAULT_REPLAY_DIR, "one-more-time-daft-punk.json"), "utf8")),
);
const recorded = analysis.claims ?? [];

describe("a result stored before one claim per fact", () => {
  it("is served from the store with the model's restatements left out", () => {
    // What the store keeps: no run information.
    const { run: _run, queryMatch: _match, ...stored } = analysis;
    const served = servedResult(stored as TrackData, null);
    expect(served.claims).toHaveLength(recorded.length - 7);
    expect(served.factoids).toHaveLength(analysis.factoids.length - 3);
    // Served again, nothing more goes.
    expect(servedResult(served, null).claims).toEqual(served.claims);
  });

  it("is served as a run's own result with the restatements left out, and counted", () => {
    const record = {
      runId: "run-stored",
      status: "completed",
      spotifyId: analysis.id,
      analysis,
    } as unknown as RunRecord;
    const served = resultOf(record) as TrackAnalysis;
    expect(served.claims).toHaveLength(recorded.length - 7);
    expect(served.run?.verifier).toEqual({ judged: 9, unjudged: 0, restated: 7 });
  });

  it("is served as it is when its run already left them out", () => {
    const run = analysis.run!;
    const done = { ...analysis, run: { ...run, verifier: { ...run.verifier!, restated: 0 } } };
    const record = {
      runId: "run-new",
      status: "completed",
      analysis: done,
    } as unknown as RunRecord;
    expect(resultOf(record)).toEqual(done);
  });
});
