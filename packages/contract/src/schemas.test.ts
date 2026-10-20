/**
 * The rules the evidence model, the audio features and the run information enforce, and the
 * post-parse checks of model output.
 */

import { describe, expect, it } from "vitest";
import { ReplayRecord, RunResponse } from "./api.js";
import { AudioFeatures } from "./audio.js";
import { Claim, Evidence, EVIDENCE_EXCERPT_MAX, Measured } from "./evidence.js";
import { type ComposerOutput, composerOutputIssues, judgeOutputIssues } from "./llm.js";
import {
  gatedAudio,
  sampleAnalysis,
  sampleAudio,
  sampleClaim,
  sampleEvidence,
  sampleRun,
} from "./testing/samples.js";
import { RunInfo, TrackAnalysis } from "./track.js";

const ok = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) =>
  schema.safeParse(value).success;

describe("AudioFeatures", () => {
  it("accepts a full measurement and a gated one", () => {
    expect(AudioFeatures.parse(sampleAudio())).toEqual(sampleAudio());
    expect(AudioFeatures.parse(gatedAudio())).toEqual(gatedAudio());
  });

  it("accepts a measurement without models (fingerprint null)", () => {
    expect(ok(AudioFeatures, { ...sampleAudio(), fingerprint: null })).toBe(true);
  });

  it("rejects a gated measurement that still reports a value (no 'C major' for silence)", () => {
    const silentKey = { ...gatedAudio(), key: sampleAudio().key };
    expect(ok(AudioFeatures, silentKey)).toBe(false);
    expect(ok(AudioFeatures, { ...gatedAudio(), fingerprint: sampleAudio().fingerprint })).toBe(
      false,
    );
  });

  it("rejects a gate without a reason, or a reason on a passed gate", () => {
    expect(ok(AudioFeatures, { ...gatedAudio(), gate: { passed: false, reason: null } })).toBe(
      false,
    );
    expect(ok(AudioFeatures, { ...sampleAudio(), gate: { passed: true, reason: "noise" } })).toBe(
      false,
    );
  });

  it("rejects the first service version's response", () => {
    const v1 = { bpm: 123, key: "G", mode: "Major", energy: 0.67, duration: 29.99 };
    expect(ok(AudioFeatures, v1)).toBe(false);
  });

  it("rejects a confidence outside 0-1 and a model score without its model", () => {
    const audio = sampleAudio();
    const tempo = audio.tempo && { ...audio.tempo, confidence: 1.2 };
    expect(ok(AudioFeatures, { ...audio, tempo })).toBe(false);
    const styles = audio.fingerprint?.styles && { ...audio.fingerprint.styles, model: undefined };
    expect(ok(AudioFeatures, { ...audio, fingerprint: { ...audio.fingerprint, styles } })).toBe(
      false,
    );
  });
});

describe("Evidence", () => {
  it("needs a url or a record reference", () => {
    expect(ok(Evidence, { ...sampleEvidence(), url: null })).toBe(true);
    expect(ok(Evidence, { ...sampleEvidence(), recordRef: null })).toBe(true);
    expect(ok(Evidence, { ...sampleEvidence(), url: null, recordRef: null })).toBe(false);
  });

  it("names a source, never a model", () => {
    for (const source of ["llm", "model", "research-summary", "gemini"]) {
      expect(ok(Evidence, { ...sampleEvidence(), source })).toBe(false);
    }
  });

  it(`keeps excerpts to ${EVIDENCE_EXCERPT_MAX} characters`, () => {
    const excerpt = "x".repeat(EVIDENCE_EXCERPT_MAX);
    expect(ok(Evidence, { ...sampleEvidence(), excerpt })).toBe(true);
    expect(ok(Evidence, { ...sampleEvidence(), excerpt: `${excerpt}x` })).toBe(false);
  });
});

describe("Claim", () => {
  it("sourced needs at least one citation", () => {
    expect(ok(Claim, sampleClaim())).toBe(true);
    expect(ok(Claim, { ...sampleClaim(), evidenceIds: [] })).toBe(false);
  });

  it("sourced needs a supported or partial verdict", () => {
    expect(ok(Claim, { ...sampleClaim(), verdict: "partial" })).toBe(true);
    for (const verdict of ["unsupported", "contradicted", null]) {
      expect(ok(Claim, { ...sampleClaim(), verdict })).toBe(false);
    }
  });

  it("measured comes from code only", () => {
    const measured = { ...sampleClaim(), kind: "measured", evidenceIds: [], verdict: null };
    expect(ok(Claim, measured)).toBe(true);
    expect(ok(Claim, { ...measured, origin: "model" })).toBe(false);
  });

  it("keeps the numeric check apart from the verdict", () => {
    // A supported claim whose number disagrees with an octave-error tempo is in conflict, not
    // rejected: both values are shown.
    expect(ok(Claim, { ...sampleClaim(), numericCheck: "conflict", field: "tempo" })).toBe(true);
    const inferred = { ...sampleClaim(), kind: "inferred", origin: "model" };
    expect(ok(Claim, { ...inferred, verdict: "contradicted", numericCheck: "consistent" })).toBe(
      true,
    );
    expect(ok(Claim, { ...sampleClaim(), numericCheck: "unknown" })).toBe(false);
  });

  it("can be a factoid card", () => {
    const factoid = {
      title: "A Bedroom Demo",
      type: "production",
      entities: [{ text: "Roland Juno-106", type: "synth" }],
    };
    expect(ok(Claim, { ...sampleClaim(), factoid })).toBe(true);
    expect(ok(Claim, { ...sampleClaim(), factoid: { ...factoid, type: "lyrics" } })).toBe(false);
  });
});

describe("Measured", () => {
  const tempo = {
    field: "tempo",
    value: 105.2,
    unit: "bpm",
    confidence: 0.82,
    method: { algorithm: "essentia.RhythmExtractor2013", analyzerVersion: "2.0.0" },
    window: "preview-30s",
    basis: "signal",
  };

  it("carries value, unit, confidence, method, window and basis", () => {
    expect(ok(Measured, tempo)).toBe(true);
    expect(ok(Measured, { ...tempo, field: "key", value: "A major", unit: null })).toBe(true);
    expect(ok(Measured, { ...tempo, basis: "llm" })).toBe(false);
    expect(ok(Measured, { ...tempo, window: "full-track" })).toBe(false);
  });
});

describe("TrackAnalysis v1 additions", () => {
  it("accept a full result", () => {
    expect(ok(TrackAnalysis, sampleAnalysis())).toBe(true);
  });

  it("reject a sourced claim citing evidence that is not in the pack", () => {
    const analysis = sampleAnalysis();
    const claims = [{ ...sampleClaim(), evidenceIds: ["ev-unknown"] }];
    const result = TrackAnalysis.safeParse({ ...analysis, claims });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["claims", 0, "evidenceIds"]);
    // The same citation on an inferred claim is allowed: that is what makes it inferred.
    const inferred = [{ ...claims[0], kind: "inferred", origin: "model", verdict: null }];
    expect(ok(TrackAnalysis, { ...analysis, claims: inferred })).toBe(true);
  });

  it("allow at most 8 factoids and no minimum", () => {
    const factoid = { id: "f", title: "T", content: "C", type: "trivia" };
    const analysis = sampleAnalysis();
    expect(ok(TrackAnalysis, { ...analysis, factoids: [] })).toBe(true);
    expect(ok(TrackAnalysis, { ...analysis, factoids: Array(8).fill(factoid) })).toBe(true);
    expect(ok(TrackAnalysis, { ...analysis, factoids: Array(9).fill(factoid) })).toBe(false);
  });

  it("keep the link type and reject an unknown one", () => {
    const analysis = sampleAnalysis();
    const link = { source: "current", target: "derived1", value: 3, type: "interpolation" };
    const genealogy = { ...analysis.genealogy, links: [link] };
    expect(TrackAnalysis.parse({ ...analysis, genealogy }).genealogy.links[0].type).toBe(
      "interpolation",
    );
    const unknown = { ...genealogy, links: [{ ...link, type: "vibe" }] };
    expect(ok(TrackAnalysis, { ...analysis, genealogy: unknown })).toBe(false);
  });
});

describe("RunInfo", () => {
  it("a replayed run says when, from which commit and with which analyzer", () => {
    const replay = {
      ...sampleRun(),
      mode: "replay",
      recordedAt: "2026-10-20T12:00:00.000Z",
      commit: "58f9b0a",
    };
    expect(ok(RunInfo, replay)).toBe(true);
    expect(ok(RunInfo, { ...replay, recordedAt: null })).toBe(false);
    expect(ok(RunInfo, { ...replay, commit: null })).toBe(false);
    expect(ok(RunInfo, { ...replay, analyzerVersion: undefined })).toBe(false);
  });
});

describe("ReplayRecord", () => {
  const analysis = sampleAnalysis();
  const record = {
    version: 1,
    slug: "midnight-city",
    request: { query: "midnight city m83", selectedTrackId: null },
    recordedAt: "2026-10-20T12:00:00.000Z",
    commit: "58f9b0a",
    analyzerVersion: null,
    events: [{ atMs: 0, event: { type: "heartbeat", runId: "run-1", seq: 0 } }],
    analysis: {
      ...analysis,
      run: { ...sampleRun(), mode: "replay", recordedAt: "2026-10-20T12:00:00.000Z", commit: "x" },
    },
    usage: null,
  };

  it("holds a replayed analysis only", () => {
    expect(ok(ReplayRecord, record)).toBe(true);
    const live = { ...record, analysis: { ...record.analysis, run: sampleRun() } };
    expect(ok(ReplayRecord, live)).toBe(false);
  });
});

describe("RunResponse", () => {
  it("never carries the query text", () => {
    const run = {
      id: "run-1",
      status: "completed",
      mode: "live",
      spotifyId: "6GyFP1nfCDB8lbD2bG0Hq9",
      createdAt: "2026-10-20T12:00:00.000Z",
      finishedAt: "2026-10-20T12:01:00.000Z",
      query: "what the user typed",
    };
    const parsed = RunResponse.parse({ success: true, run, analysis: null });
    expect(parsed.run).not.toHaveProperty("query");
  });
});

describe("composerOutputIssues", () => {
  const node = (id: string, role: "current" | "source") => ({
    id,
    role,
    label: id,
    trackTitle: null,
    trackArtist: null,
    year: null,
  });
  const valid: ComposerOutput = {
    claims: [],
    factoids: [],
    genealogyNodes: [node("current", "current"), node("o1", "source")],
    genealogyLinks: [{ source: "o1", target: "current", type: "sample", evidenceIds: [] }],
  };

  it("accepts a consistent output", () => {
    expect(composerOutputIssues(valid)).toEqual([]);
  });

  it("reports too many factoids, dangling links, duplicate ids and no current node", () => {
    const factoid = {
      title: "T",
      text: "C",
      type: "trivia" as const,
      entities: [],
      evidenceIds: [],
    };
    expect(
      composerOutputIssues({
        ...valid,
        factoids: Array(9).fill(factoid),
        genealogyNodes: [node("o1", "source"), node("o1", "source")],
      }),
    ).toEqual([
      "factoids: 9 > 8",
      'genealogyNodes: duplicate id "o1"',
      'genealogyNodes: 0 nodes with role "current", expected 1',
      'genealogyLinks[0]: unknown node "current"',
    ]);
  });
});

describe("judgeOutputIssues", () => {
  it("reports verdicts for claims not sent, repeats and oversized batches", () => {
    const verdict = (claimId: string) => ({ claimId, verdict: "supported" as const, reason: "r" });
    expect(judgeOutputIssues({ verdicts: [verdict("a")] }, ["a", "b"])).toEqual([]);
    expect(
      judgeOutputIssues({ verdicts: [verdict("a"), verdict("a"), verdict("z")] }, ["a"]),
    ).toEqual(['verdicts: claim "a" judged twice', 'verdicts: claim "z" was not sent']);
    const many = Array.from({ length: 21 }, (_, i) => verdict(`c${i}`));
    expect(
      judgeOutputIssues(
        { verdicts: many },
        many.map((v) => v.claimId),
      ),
    ).toEqual(["verdicts: 21 > 20"]);
  });
});
