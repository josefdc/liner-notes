/**
 * A result stored before the verifier kept one claim per fact is served with each fact once: from
 * the long-term store (servedResult) and as a run's own stored result (GET /api/runs, resultOf).
 * The One More Time recording's result as made before one claim per fact (the pinned copy,
 * replay/testing/recordings.ts) stands in for such a result.
 */

import type { TrackAnalysis } from "@liner-notes/contract";
import { describe, expect, it, onTestFinished } from "vitest";
import { resultOf } from "../http/routes/runs.js";
import { captureLogsForTests } from "../logger.js";
import { pinnedRecord } from "../replay/testing/recordings.js";
import type { RunRecord } from "../store/runs.js";
import type { TrackData } from "./schema.js";
import { servedResult } from "./storedResults.js";

const { analysis } = pinnedRecord();
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

describe("a run's stored result the step cannot read", () => {
  it("is served as it is, for the contract check, and the step's failure is logged", () => {
    const logs = captureLogsForTests();
    onTestFinished(() => logs.restore());
    const odd = { ...analysis, claims: [null] };
    const record = { runId: "run-odd", status: "completed", analysis: odd } as unknown as RunRecord;
    expect(resultOf(record)).toBe(odd);
    expect(logs.messages("warn").join("\n")).toMatch(/run-odd.*could not be read/);
  });

  it("logs how many claims it left out", () => {
    const logs = captureLogsForTests();
    onTestFinished(() => logs.restore());
    const record = { runId: "run-old", status: "completed", analysis } as unknown as RunRecord;
    resultOf(record);
    expect(logs.messages("info").join("\n")).toMatch(/run-old.*left out 7 claim/);
  });
});
