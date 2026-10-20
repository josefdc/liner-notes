/**
 * Producer-side checks (what a result must satisfy before it is sent or stored) and how a
 * reader shows a claim it received.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { AUDIO_MEASURED_BLOCKS, type AudioFeatures } from "./audio.js";
import { audioFeaturesJsonSchema } from "./audioSchema.js";
import {
  analysisIssues,
  audioFeaturesIssues,
  claimDisplayKind,
  claimIssues,
  evidenceIssues,
  runIssues,
} from "./checks.js";
import { AnalyzeStreamEvent, decodeSseStream, encodeSseEvent } from "./events.js";
import type { Claim } from "./evidence.js";
import {
  gatedAudio,
  sampleAnalysis,
  sampleAudio,
  sampleClaim,
  sampleEvidence,
  sampleRun,
} from "./testing/samples.js";
import { TrackAnalysis } from "./track.js";

const pack = new Set(["ev-1", "ev-2"]);
const claim = (change: Partial<Claim>): Claim => ({
  ...sampleClaim(),
  evidenceIds: ["ev-1"],
  ...change,
});
const analysis = (change: object = {}) => TrackAnalysis.parse({ ...sampleAnalysis(), ...change });

describe("evidenceIssues", () => {
  it("needs a url or a record reference, and a short excerpt", () => {
    expect(evidenceIssues(sampleEvidence())).toEqual([]);
    expect(evidenceIssues({ ...sampleEvidence(), url: null })).toEqual([]);
    expect(evidenceIssues({ ...sampleEvidence(), recordRef: null })).toEqual([]);
    expect(evidenceIssues({ ...sampleEvidence(), url: null, recordRef: null })).toEqual([
      "needs a url or a recordRef",
    ]);
    expect(evidenceIssues({ ...sampleEvidence(), excerpt: "x".repeat(500) })).toEqual([]);
    expect(evidenceIssues({ ...sampleEvidence(), excerpt: "x".repeat(501) })).toEqual([
      ".excerpt: longer than 500 characters",
    ]);
  });
});

describe("audioFeaturesIssues", () => {
  it("accepts a full measurement and a properly gated one", () => {
    expect(audioFeaturesIssues(sampleAudio())).toEqual([]);
    expect(audioFeaturesIssues(gatedAudio())).toEqual([]);
  });

  it.each(AUDIO_MEASURED_BLOCKS)("reports %s set on a gated measurement", (block) => {
    const audio = { ...gatedAudio(), [block]: sampleAudio()[block] } as AudioFeatures;
    expect(audioFeaturesIssues(audio)).toEqual([`audio.${block}: must be null when gated`]);
  });

  it("reports key moments on a gated measurement", () => {
    const audio = { ...gatedAudio(), keyMoments: sampleAudio().keyMoments };
    expect(audioFeaturesIssues(audio)).toEqual(["audio.keyMoments: must be empty when gated"]);
  });

  it("reports a gate without a reason, and a reason on a passed gate", () => {
    expect(audioFeaturesIssues({ ...gatedAudio(), gate: { passed: false, reason: null } })).toEqual(
      ["audio.gate.reason: missing"],
    );
    expect(
      audioFeaturesIssues({ ...sampleAudio(), gate: { passed: true, reason: "noise" } }),
    ).toEqual(["audio.gate.reason: set on a passed gate"]);
  });
});

describe("claimIssues", () => {
  it("accepts a cited, supported claim and inferred ones", () => {
    expect(claimIssues(claim({}), pack)).toEqual([]);
    expect(
      claimIssues(claim({ kind: "inferred", origin: "model", evidenceIds: [] }), pack),
    ).toEqual([]);
  });

  it("checks every cited id, not only the first", () => {
    expect(claimIssues(claim({ evidenceIds: ["ev-1", "ev-2", "ev-9"] }), pack)).toEqual([
      '.evidenceIds: cites "ev-9", which is not in the evidence pack',
    ]);
  });

  it("checks citations against an empty pack (a result without evidence)", () => {
    expect(claimIssues(claim({}), new Set())).toEqual([
      '.evidenceIds: cites "ev-1", which is not in the evidence pack',
    ]);
  });

  it("reports a sourced claim that cites nothing", () => {
    expect(claimIssues(claim({ evidenceIds: [] }), pack)).toEqual([".evidenceIds: cites nothing"]);
  });

  it("needs a supported or partial verdict on a model claim, not on a code-built one", () => {
    for (const verdict of ["unsupported", "contradicted", null] as const) {
      expect(claimIssues(claim({ origin: "model", verdict }), pack)).toEqual([
        ".verdict: a model claim is sourced only when supported or partial",
      ]);
      expect(claimIssues(claim({ origin: "code", verdict }), pack)).toEqual([]);
    }
    expect(claimIssues(claim({ origin: "model", verdict: "partial" }), pack)).toEqual([]);
  });

  it("reports a measured claim written by the model", () => {
    const measured = claim({ kind: "measured", origin: "model", evidenceIds: [], verdict: null });
    expect(claimIssues(measured, pack)).toEqual([".origin: measured claims come from code"]);
    expect(claimIssues({ ...measured, origin: "code" }, pack)).toEqual([]);
  });
});

describe("claimDisplayKind", () => {
  it("shows a claim citing unknown evidence, or nothing, as model inference", () => {
    expect(claimDisplayKind(claim({}), pack)).toBe("sourced");
    expect(claimDisplayKind(claim({ evidenceIds: ["ev-1", "ev-9"] }), pack)).toBe("inferred");
    expect(claimDisplayKind(claim({ evidenceIds: [] }), pack)).toBe("inferred");
  });

  it("shows a model claim the judge did not support as inference; a code-built one stays", () => {
    expect(claimDisplayKind(claim({ origin: "model", verdict: "unsupported" }), pack)).toBe(
      "inferred",
    );
    expect(claimDisplayKind(claim({ origin: "model", verdict: "partial" }), pack)).toBe("sourced");
    expect(claimDisplayKind(claim({ origin: "code", verdict: "contradicted" }), pack)).toBe(
      "sourced",
    );
  });

  it("shows a model-written measured claim as inference", () => {
    expect(claimDisplayKind(claim({ kind: "measured", origin: "model" }), pack)).toBe("inferred");
    expect(claimDisplayKind(claim({ kind: "measured", origin: "code" }), pack)).toBe("measured");
    expect(claimDisplayKind(claim({ kind: "inferred", origin: "model" }), pack)).toBe("inferred");
  });
});

describe("runIssues", () => {
  const replay = {
    ...sampleRun(),
    mode: "replay" as const,
    recordedAt: "2026-10-20T12:00:00.000Z",
    commit: "abc",
  };

  it("accepts a live run and a complete replay", () => {
    expect(runIssues(sampleRun(), sampleAudio())).toEqual([]);
    expect(runIssues(replay, sampleAudio())).toEqual([]);
  });

  it("needs a replay's date and commit, and keeps them off live runs", () => {
    expect(runIssues({ ...replay, recordedAt: null, commit: null }, sampleAudio())).toEqual([
      "run.recordedAt: a replay says when",
      "run.commit: a replay names its commit",
    ]);
    expect(runIssues({ ...replay, mode: "live" }, sampleAudio())).toEqual([
      "run.recordedAt: set on a live run",
      "run.commit: set on a live run",
    ]);
  });

  it("allows a null analyzer version on a replay only when nothing was measured", () => {
    const run = { ...replay, analyzerVersion: null };
    expect(runIssues(run, null)).toEqual([]);
    expect(runIssues(run, gatedAudio())).toEqual([]);
    expect(runIssues(run, sampleAudio())).toEqual([
      "run.analyzerVersion: null although audio was measured",
    ]);
    expect(runIssues({ ...replay, analyzerVersion: "9.9.9" }, sampleAudio())).toEqual([
      "run.analyzerVersion: differs from the measurement's",
    ]);
  });
});

describe("analysisIssues", () => {
  it("accepts a consistent result", () => {
    expect(analysisIssues(analysis())).toEqual([]);
  });

  it("reports every problem with its path", () => {
    const factoid = { id: "f", title: "T", content: "C", type: "trivia", claimId: "cl-9" };
    const bad = analysis({
      evidence: [{ ...sampleEvidence(), url: null, recordRef: null }],
      claims: [sampleClaim(), { ...sampleClaim(), id: "cl-2", evidenceIds: ["ev-gone"] }],
      audio: { ...gatedAudio(), tempo: sampleAudio().tempo },
      run: { ...sampleRun(), recordedAt: "2026-10-20T12:00:00.000Z" },
      factoids: Array(9).fill(factoid),
      genealogy: {
        nodes: [],
        links: [{ source: "a", target: "b", value: 1, evidenceIds: ["ev-x"], claimId: "cl-y" }],
      },
    });
    expect(analysisIssues(bad)).toEqual([
      "evidence[0]: needs a url or a recordRef",
      'claims[1].evidenceIds: cites "ev-gone", which is not in the evidence pack',
      "audio.tempo: must be null when gated",
      "run.recordedAt: set on a live run",
      "factoids: 9 > 8",
      ...Array(9)
        .fill('factoids[i].claimId: unknown claim "cl-9"')
        .map((line, i) => line.replace("[i]", `[${i}]`)),
      'genealogy.links[0].evidenceIds: cites "ev-x", not in the pack',
      'genealogy.links[0].claimId: unknown claim "cl-y"',
    ]);
  });

  it("checks citations when the result has no evidence pack at all", () => {
    expect(analysisIssues(analysis({ evidence: undefined }))).toEqual([
      'claims[0].evidenceIds: cites "ev-mb-1", which is not in the evidence pack',
    ]);
  });

  it("allows exactly 8 factoids", () => {
    const factoid = { id: "f", title: "T", content: "C", type: "trivia" };
    expect(analysisIssues(analysis({ factoids: Array(8).fill(factoid) }))).toEqual([]);
  });
});

describe("a result a producer should have caught", () => {
  it("still reaches the client: the stream decoder delivers its complete event", () => {
    const data = analysis({ claims: [{ ...sampleClaim(), evidenceIds: ["ev-gone"] }] });
    const body = encodeSseEvent({ type: "complete", runId: "r", seq: 3, data });
    const [event] = decodeSseStream(body, AnalyzeStreamEvent);
    expect(event?.type).toBe("complete");
    if (event?.type !== "complete") return;
    const known = new Set((event.data.evidence ?? []).map((item) => item.id));
    const [read] = event.data.claims ?? [];
    expect(read && claimDisplayKind(read, known)).toBe("inferred");
  });
});

describe("audioFeaturesJsonSchema", () => {
  it("states the gate for every measured block and the key moments", () => {
    const schema = audioFeaturesJsonSchema() as {
      allOf: Array<{ then: { properties: Record<string, unknown> } }>;
    };
    const gated = schema.allOf[0].then.properties;
    for (const block of AUDIO_MEASURED_BLOCKS) expect(gated[block]).toEqual({ type: "null" });
    expect(gated.keyMoments).toEqual({ maxItems: 0 });
    expect(gated.gate).toEqual({ properties: { reason: { type: "string" } } });
    expect(schema.allOf[1].then.properties.gate).toEqual({
      properties: { reason: { type: "null" } },
    });
  });

  // Validates with the Python library the audio service's tests use, when it is installed.
  const hasPython = (() => {
    try {
      execFileSync("python3", ["-I", "-c", "import jsonschema"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasPython)("is enforced by Python jsonschema", () => {
    const cases = {
      measured: sampleAudio(),
      gated: gatedAudio(),
      gatedWithTempoAndKey: { ...gatedAudio(), tempo: sampleAudio().tempo, key: sampleAudio().key },
      gatedWithMoments: { ...gatedAudio(), keyMoments: sampleAudio().keyMoments },
      gatedWithoutReason: { ...gatedAudio(), gate: { passed: false, reason: null } },
      passedWithReason: { ...sampleAudio(), gate: { passed: true, reason: "silence" } },
      flatTonic: { ...sampleAudio(), key: { ...sampleAudio().key, tonic: "Bb" } },
      rawConfidence: { ...sampleAudio(), tempo: { ...sampleAudio().tempo, confidence: 3.77 } },
      longRange: {
        ...sampleAudio(),
        tempo: { ...sampleAudio().tempo, rawConfidence: { value: 1, range: [0, 5.32, 9] } },
      },
      extraField: { ...sampleAudio(), debug: 1 },
    };
    const script = `
import json, sys, jsonschema
schema, cases = json.loads(sys.stdin.read())
v = jsonschema.Draft202012Validator(schema)
print(json.dumps({k: v.is_valid(x) for k, x in cases.items()}))`;
    const out = execFileSync("python3", ["-I", "-c", script], {
      input: JSON.stringify([audioFeaturesJsonSchema(), cases]),
      encoding: "utf8",
    });
    expect(JSON.parse(out)).toEqual({
      measured: true,
      gated: true,
      gatedWithTempoAndKey: false,
      gatedWithMoments: false,
      gatedWithoutReason: false,
      passedWithReason: false,
      flatTonic: false,
      rawConfidence: false,
      longRange: false,
      extraField: false,
    });
  });
});
