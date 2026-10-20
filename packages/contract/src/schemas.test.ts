/**
 * Reader schemas: lenient where a whole result must not fail for one bad part, strict on types,
 * and forward compatible. Replay records are checked strictly when loaded. Post-parse checks of
 * model output sit at their boundaries.
 */

import { describe, expect, it } from "vitest";
import { ReplayRecord, RunResponse } from "./api.js";
import { AudioFeatures } from "./audio.js";
import { AnalyzeStreamEvent } from "./events.js";
import { Claim, Evidence, Measured } from "./evidence.js";
import {
  type ComposerOutput,
  composerOutputIssues,
  JUDGE_BATCH_MAX,
  judgeOutputIssues,
} from "./llm.js";
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

describe("AudioFeatures (reader)", () => {
  it("accepts a full measurement, a gated one and one without models", () => {
    expect(AudioFeatures.parse(sampleAudio())).toEqual(sampleAudio());
    expect(AudioFeatures.parse(gatedAudio())).toEqual(gatedAudio());
    expect(ok(AudioFeatures, { ...sampleAudio(), fingerprint: null })).toBe(true);
  });

  it("accepts a gated measurement that still reports a block (producers check the gate)", () => {
    expect(ok(AudioFeatures, { ...gatedAudio(), key: sampleAudio().key })).toBe(true);
  });

  it("rejects the first service version's response", () => {
    const v1 = { bpm: 123, key: "G", mode: "Major", energy: 0.67, duration: 29.99 };
    expect(ok(AudioFeatures, v1)).toBe(false);
  });

  it("takes keys with sharps only (the service maps flats)", () => {
    const audio = sampleAudio();
    const key = (tonic: string) => ({ ...audio, key: audio.key && { ...audio.key, tonic } });
    expect(ok(AudioFeatures, key("A#"))).toBe(true);
    expect(ok(AudioFeatures, key("Bb"))).toBe(false);
  });

  it("takes a normalised 0..1 confidence, with the estimator's raw value kept apart", () => {
    const audio = sampleAudio();
    const tempo = (change: object) => ({
      ...audio,
      tempo: audio.tempo && { ...audio.tempo, ...change },
    });
    expect(ok(AudioFeatures, tempo({ confidence: 3.77 }))).toBe(false);
    expect(ok(AudioFeatures, tempo({ rawConfidence: undefined }))).toBe(true);
    expect(ok(AudioFeatures, tempo({ rawConfidence: { value: 3.77, range: [0, 5.32, 9] } }))).toBe(
      false,
    );
  });

  it("rejects a model score without its model", () => {
    const audio = sampleAudio();
    const styles = audio.fingerprint?.styles && { ...audio.fingerprint.styles, model: undefined };
    expect(ok(AudioFeatures, { ...audio, fingerprint: { ...audio.fingerprint, styles } })).toBe(
      false,
    );
  });
});

describe("Evidence and Claim (reader)", () => {
  it("accept an evidence item without url or record, or with a long excerpt", () => {
    expect(ok(Evidence, { ...sampleEvidence(), url: null, recordRef: null })).toBe(true);
    expect(ok(Evidence, { ...sampleEvidence(), excerpt: "x".repeat(600) })).toBe(true);
  });

  it("name a source, never a model", () => {
    for (const source of ["llm", "model", "research-summary", "gemini"]) {
      expect(ok(Evidence, { ...sampleEvidence(), source })).toBe(false);
    }
  });

  it("accept any claim of a valid shape: readers decide how to show it", () => {
    expect(ok(Claim, { ...sampleClaim(), evidenceIds: [] })).toBe(true);
    expect(ok(Claim, { ...sampleClaim(), verdict: "contradicted" })).toBe(true);
    expect(ok(Claim, { ...sampleClaim(), kind: "measured", origin: "model" })).toBe(true);
  });

  it("keep the judge's reason and the numeric check's apart", () => {
    const claim = {
      ...sampleClaim(),
      numericCheck: "conflict",
      field: "tempo",
      verdictReason: "The excerpt names the producer.",
      numericReason: "Sourced 210 BPM is twice the measured 105 BPM (an octave error).",
      numericComparison: { claimed: 210, measured: 105.2, method: "essentia.RhythmExtractor2013" },
    };
    expect(Claim.parse(claim)).toEqual(claim);
    expect(ok(Claim, { ...sampleClaim(), numericCheck: "unknown" })).toBe(false);
  });

  it("can be a factoid card, never with the removed lyrics type", () => {
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

describe("TrackAnalysis (reader)", () => {
  it("accepts a full v1 result", () => {
    expect(ok(TrackAnalysis, sampleAnalysis())).toBe(true);
  });

  it("is forward compatible: fields it does not know are dropped, not refused", () => {
    const analysis = sampleAnalysis();
    const newer = {
      ...analysis,
      lyricsLicence: "none",
      audio: { ...sampleAudio(), tempoCurve: [1, 2] },
      evidence: [{ ...sampleEvidence(), language: "en" }],
      claims: [{ ...sampleClaim(), judgeModel: "x" }],
      run: { ...sampleRun(), region: "eu" },
      genealogy: { ...analysis.genealogy, layout: "radial" },
    };
    const parsed = TrackAnalysis.parse(newer);
    expect(parsed).not.toHaveProperty("lyricsLicence");
    expect(parsed.audio).not.toHaveProperty("tempoCurve");
    expect(parsed.claims?.[0]).not.toHaveProperty("judgeModel");
  });

  it("accepts what producers must not send: one bad part never rejects the result", () => {
    const analysis = sampleAnalysis();
    const factoid = { id: "f", title: "T", content: "C", type: "trivia" };
    const bad = {
      ...analysis,
      claims: [{ ...sampleClaim(), evidenceIds: ["ev-gone"], verdict: "unsupported" }],
      audio: { ...gatedAudio(), loudness: sampleAudio().loudness },
      factoids: Array(9).fill(factoid),
      run: { ...sampleRun(), mode: "replay" },
    };
    expect(ok(TrackAnalysis, bad)).toBe(true);
    expect(ok(TrackAnalysis, { ...analysis, evidence: undefined })).toBe(true);
  });

  it("keeps the link type, origin and claim, and rejects an unknown type", () => {
    const analysis = sampleAnalysis();
    const link = {
      source: "current",
      target: "derived1",
      value: 3,
      type: "interpolation",
      origin: "code",
      claimId: "cl-1",
    };
    const genealogy = { ...analysis.genealogy, links: [link] };
    expect(TrackAnalysis.parse({ ...analysis, genealogy }).genealogy.links[0]).toMatchObject(link);
    const unknown = { ...genealogy, links: [{ ...link, type: "vibe" }] };
    expect(ok(TrackAnalysis, { ...analysis, genealogy: unknown })).toBe(false);
  });

  it("accepts a negative sample time and a contract version", () => {
    const analysis = sampleAnalysis();
    const samples = [{ time: -1, description: "Older payloads guessed times" }];
    expect(ok(TrackAnalysis, { ...analysis, samples, contractVersion: 1 })).toBe(true);
  });
});

describe("RunInfo (reader)", () => {
  it("accepts a replay with missing metadata (producers check it)", () => {
    expect(ok(RunInfo, { ...sampleRun(), mode: "replay" })).toBe(true);
    expect(ok(RunInfo, { ...sampleRun(), analyzerVersion: undefined })).toBe(false);
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

describe("ReplayRecord", () => {
  const recordedAt = "2026-10-20T12:00:00.000Z";
  const replayRun = { ...sampleRun(), mode: "replay", recordedAt, commit: "58f9b0a" };
  const analysis = { ...sampleAnalysis(), run: replayRun };
  const event = (seq: number, extra: object) => ({ runId: "run-1", seq, ...extra });
  const record = () => ({
    version: 1,
    slug: "midnight-city",
    request: { query: "midnight city m83", selectedTrackId: null },
    recordedAt,
    commit: "58f9b0a",
    analyzerVersion: replayRun.analyzerVersion,
    events: [
      { atMs: 0, event: event(0, { type: "connected", threadId: "t" }) },
      { atMs: 10, event: event(1, { type: "status", message: "Searching" }) },
      { atMs: 900, event: event(2, { type: "complete", data: analysis }) },
      { atMs: 901, event: event(3, { type: "done" }) },
    ],
    analysis,
    usage: null,
  });
  const issues = (value: unknown) => {
    const result = ReplayRecord.safeParse(value);
    return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
  };

  it("accepts a consistent recording", () => {
    expect(issues(record())).toEqual([]);
  });

  it("rejects a recording whose analysis has no run or a live run", () => {
    expect(issues({ ...record(), analysis: { ...analysis, run: undefined } })).toEqual([
      "analysis.run",
    ]);
    const live = { ...analysis, run: sampleRun() };
    expect(issues({ ...record(), analysis: live })).toContain("analysis.run.mode");
  });

  it("rejects metadata that differs from the analysis run", () => {
    expect(issues({ ...record(), recordedAt: "2020-01-01T00:00:00.000Z" })).toEqual([
      "analysis.run.recordedAt",
    ]);
    expect(issues({ ...record(), commit: "zzz" })).toEqual(["analysis.run.commit"]);
    expect(issues({ ...record(), analyzerVersion: null })).toEqual([
      "analysis.run.analyzerVersion",
    ]);
  });

  it("rejects a streamed result that does not say it is a replay", () => {
    const value = record();
    value.events[2].event = event(2, { type: "complete", data: { ...analysis, run: sampleRun() } });
    expect(issues(value)).toEqual(["events.2.event.data.run.mode"]);
  });

  it("rejects heartbeats, gaps in seq and times that go back", () => {
    const value = record();
    value.events.splice(1, 0, { atMs: 5, event: { type: "heartbeat", runId: "run-1" } as never });
    expect(issues(value)).toContain("events.1");
    const gap = record();
    gap.events[3].event = event(7, { type: "done" });
    expect(issues(gap)).toEqual(["events.3.event.seq"]);
    const back = record();
    back.events[3].atMs = 100;
    expect(issues(back)).toEqual(["events.3.atMs"]);
  });

  it("holds events that the stream union accepts", () => {
    for (const { event: streamed } of record().events) {
      expect(ok(AnalyzeStreamEvent, streamed)).toBe(true);
    }
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
  const factoid = {
    title: "T",
    text: "C",
    type: "trivia" as const,
    entities: [],
    evidenceIds: [],
  };
  const valid: ComposerOutput = {
    claims: [],
    factoids: [],
    genealogyNodes: [node("current", "current"), node("o1", "source")],
    genealogyLinks: [{ source: "o1", target: "current", type: "sample", evidenceIds: [] }],
  };

  it("accepts a consistent output, with exactly 8 factoids", () => {
    expect(composerOutputIssues(valid)).toEqual([]);
    expect(composerOutputIssues({ ...valid, factoids: Array(8).fill(factoid) })).toEqual([]);
  });

  it("reports 9 factoids, duplicate ids and no current node", () => {
    expect(
      composerOutputIssues({
        ...valid,
        factoids: Array(9).fill(factoid),
        genealogyNodes: [node("o1", "source"), node("o1", "source")],
        genealogyLinks: [],
      }),
    ).toEqual([
      "factoids: 9 > 8",
      'genealogyNodes: duplicate id "o1"',
      'genealogyNodes: 0 nodes with role "current", expected 1',
    ]);
  });

  it("reports two current nodes", () => {
    const nodes = [node("current", "current"), node("o1", "current")];
    expect(composerOutputIssues({ ...valid, genealogyNodes: nodes })).toEqual([
      'genealogyNodes: 2 nodes with role "current", expected 1',
    ]);
  });

  it("reports a link from or to an unknown node", () => {
    const links = [
      { source: "x", target: "current", type: "sample" as const, evidenceIds: [] },
      { source: "o1", target: "y", type: "cover" as const, evidenceIds: [] },
    ];
    expect(composerOutputIssues({ ...valid, genealogyLinks: links })).toEqual([
      'genealogyLinks[0]: unknown node "x"',
      'genealogyLinks[1]: unknown node "y"',
    ]);
  });
});

describe("judgeOutputIssues", () => {
  const verdict = (claimId: string) => ({ claimId, verdict: "supported" as const, reason: "r" });
  const batch = (n: number) => Array.from({ length: n }, (_, i) => verdict(`c${i}`));

  it("accepts a full batch of 20", () => {
    const verdicts = batch(JUDGE_BATCH_MAX);
    expect(
      judgeOutputIssues(
        { verdicts },
        verdicts.map((v) => v.claimId),
      ),
    ).toEqual([]);
  });

  it("reports 21 verdicts, claims not sent and repeats", () => {
    const many = batch(JUDGE_BATCH_MAX + 1);
    expect(
      judgeOutputIssues(
        { verdicts: many },
        many.map((v) => v.claimId),
      ),
    ).toEqual(["verdicts: 21 > 20"]);
    expect(
      judgeOutputIssues({ verdicts: [verdict("a"), verdict("a"), verdict("z")] }, ["a"]),
    ).toEqual(['verdicts: claim "a" judged twice', 'verdicts: claim "z" was not sent']);
  });
});
