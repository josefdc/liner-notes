import { describe, expect, it } from "vitest";
import { replayedRecording } from "./callRecords.js";
import type { LlmCallRecord } from "./state.js";

const call = (
  mode: LlmCallRecord["mode"],
  recording?: LlmCallRecord["recording"],
): LlmCallRecord => ({
  callSite: "composer",
  tier: "main",
  status: "ok",
  deployment: "gpt-6-luna",
  attempts: 1,
  mode,
  inputTokens: 1,
  outputTokens: 1,
  reasoningTokens: 0,
  usdEst: 0,
  ...(recording && { recording }),
});

describe("replayedRecording", () => {
  it("is the earliest recording time and the commit of the replayed answers", () => {
    expect(
      replayedRecording([
        call("replay", { recordedAt: "2026-03-02T10:00:00.000Z", commit: "abc" }),
        call("replay", { recordedAt: "2026-03-01T10:00:00.000Z", commit: "abc" }),
        // A live call in the same run counts for nothing here.
        call("live"),
      ]),
    ).toEqual({ recordedAt: "2026-03-01T10:00:00.000Z", commit: "abc" });
  });

  it("names every commit, in recording order, when the answers were recorded at several", () => {
    expect(
      replayedRecording([
        call("replay", { recordedAt: "2026-03-03T10:00:00.000Z", commit: "ccc" }),
        call("replay", { recordedAt: "2026-03-01T10:00:00.000Z", commit: "aaa" }),
        call("replay", { recordedAt: "2026-03-02T10:00:00.000Z", commit: "aaa" }),
      ]).commit,
    ).toBe("aaa, ccc");
  });

  it("lists the commits in call order when some answer does not say when it was recorded", () => {
    const calls = [
      call("replay", { recordedAt: "2026-03-03T10:00:00.000Z", commit: "ccc" }),
      call("replay", { recordedAt: null, commit: "bbb" }),
      call("replay", { recordedAt: "2026-03-01T10:00:00.000Z", commit: "aaa" }),
    ];
    expect(replayedRecording(calls)).toEqual({ recordedAt: null, commit: "ccc, bbb, aaa" });
    expect(replayedRecording([...calls].reverse()).commit).toBe("aaa, bbb, ccc");
  });

  it("says nothing it does not know: one answer without a time or a commit leaves it null", () => {
    expect(
      replayedRecording([
        call("replay", { recordedAt: "2026-03-01T10:00:00.000Z", commit: "abc" }),
        call("replay"),
      ]),
    ).toEqual({ recordedAt: null, commit: null });
    expect(
      replayedRecording([call("replay", { recordedAt: "2026-03-01T10:00:00.000Z", commit: null })]),
    ).toEqual({ recordedAt: "2026-03-01T10:00:00.000Z", commit: null });
    expect(replayedRecording([call("live")])).toEqual({ recordedAt: null, commit: null });
  });
});
