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
  linkDisplayKind,
  linkIssues,
  measuredCopyIssues,
  type ResultContext,
  resultContext,
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

const pack: ResultContext = { evidenceIds: new Set(["ev-1", "ev-2"]), audio: sampleAudio() };
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

  it("never presents a web search result as a primary record", () => {
    const web = { ...sampleEvidence(), source: "tavily" as const };
    expect(evidenceIssues({ ...web, sourceTier: "primary-record" })).toEqual([
      ".sourceTier: a web search result is not a primary record",
    ]);
    expect(evidenceIssues({ ...web, sourceTier: "web" })).toEqual([]);
    expect(evidenceIssues({ ...web, sourceTier: "editorial" })).toEqual([]);
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

  it("keeps model scores within their range and numbers finite", () => {
    const audio = sampleAudio();
    const moods = audio.fingerprint?.moods;
    const withHead = (head: object) => ({
      ...audio,
      fingerprint: { ...audio.fingerprint, moods: { ...moods, danceability: head } },
    });
    const head = moods?.danceability;
    expect(audioFeaturesIssues(withHead({ ...head, value: 1 }) as AudioFeatures)).toEqual([]);
    expect(audioFeaturesIssues(withHead({ ...head, value: 7 }) as AudioFeatures)).toEqual([
      "audio.fingerprint.moods.danceability.value: 7 outside its range [0, 1]",
    ]);
    expect(audioFeaturesIssues(withHead({ ...head, value: -0.1 }) as AudioFeatures)).toEqual([
      "audio.fingerprint.moods.danceability.value: -0.1 outside its range [0, 1]",
    ]);
    expect(audioFeaturesIssues(withHead({ ...head, range: [1, 0] }) as AudioFeatures)).toEqual([
      "audio.fingerprint.moods.danceability.range: minimum above maximum",
    ]);
    expect(audioFeaturesIssues(withHead({ ...head, value: Number.NaN }) as AudioFeatures)).toEqual([
      "audio.fingerprint.moods.danceability: not a finite number",
    ]);
    const tempo = audio.tempo && { ...audio.tempo, bpm: Number.POSITIVE_INFINITY };
    expect(audioFeaturesIssues({ ...audio, tempo })).toEqual([
      "audio.tempo.bpm: not a finite number",
    ]);
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
    expect(claimIssues(claim({}), { evidenceIds: new Set(), audio: null })).toEqual([
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
    const measured = claim({
      kind: "measured",
      origin: "model",
      evidenceIds: [],
      verdict: null,
      field: "tempo",
    });
    expect(claimIssues(measured, pack)).toEqual([".origin: measured claims come from code"]);
    expect(claimIssues({ ...measured, origin: "code" }, pack)).toEqual([]);
  });

  it("reports a measured claim without a field, or whose field was not measured", () => {
    const measured = claim({ kind: "measured", origin: "code", evidenceIds: [], verdict: null });
    expect(claimIssues(measured, pack)).toEqual([
      ".field: a measured claim names the field it reports",
    ]);
    const tempo = { ...measured, field: "tempo" as const };
    expect(claimIssues(tempo, { ...pack, audio: gatedAudio() })).toEqual([
      ".field: tempo was not measured",
    ]);
    expect(claimIssues(tempo, { ...pack, audio: null })).toEqual([
      ".field: tempo was not measured",
    ]);
    const noKey = { ...sampleAudio(), key: null };
    expect(claimIssues({ ...measured, field: "key" }, { ...pack, audio: noKey })).toEqual([
      ".field: key was not measured",
    ]);
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
    const measured = (origin: "code" | "model") =>
      claim({ kind: "measured", origin, field: "tempo" });
    expect(claimDisplayKind(measured("model"), pack)).toBe("inferred");
    expect(claimDisplayKind(measured("code"), pack)).toBe("measured");
    expect(claimDisplayKind(claim({ kind: "inferred", origin: "model" }), pack)).toBe("inferred");
  });

  it("shows a measured claim as inference when the measurement is missing", () => {
    const measured = claim({ kind: "measured", origin: "code", field: "tempo" });
    expect(claimDisplayKind(measured, { ...pack, audio: gatedAudio() })).toBe("inferred");
    expect(claimDisplayKind(measured, { ...pack, audio: null })).toBe("inferred");
    expect(claimDisplayKind({ ...measured, field: undefined }, pack)).toBe("inferred");
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
      "bpm: set although nothing was measured",
      "key: set although nothing was measured",
      "energy: set although nothing was measured",
      "valence: set although nothing was measured",
      "danceability: set although nothing was measured",
      "acousticness: set although nothing was measured",
      "keyMoments: set although nothing was measured",
      'audioSource: "analyzed" although nothing was measured',
      'audioConfidence: "high" although nothing was measured',
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

describe("measuredCopyIssues", () => {
  const passed = () => analysis();
  const unmeasured = (audio: unknown) =>
    analysis({
      audio,
      bpm: null,
      key: null,
      energy: null,
      valence: null,
      danceability: null,
      acousticness: null,
      keyMoments: [],
      audioSource: "unavailable",
      audioConfidence: "low",
    });

  it("accepts copies that agree with the measurement, and none without one", () => {
    expect(measuredCopyIssues(passed())).toEqual([]);
    expect(measuredCopyIssues(unmeasured(null))).toEqual([]);
    expect(measuredCopyIssues(unmeasured(undefined))).toEqual([]);
    expect(measuredCopyIssues(unmeasured(gatedAudio()))).toEqual([]);
  });

  it.each(["bpm", "key", "energy", "valence", "danceability", "acousticness"])(
    "reports %s set without a measurement or with a gated one",
    (copy) => {
      const value = copy === "key" ? "C Major" : 0.5;
      for (const audio of [null, gatedAudio()]) {
        expect(measuredCopyIssues({ ...unmeasured(audio), [copy]: value })).toEqual([
          `${copy}: set although nothing was measured`,
        ]);
      }
    },
  );

  it("reports key moments, analyzed, high confidence and measured segments without a measurement", () => {
    const base = unmeasured(gatedAudio());
    expect(measuredCopyIssues({ ...base, keyMoments: sampleAudio().keyMoments })).toEqual([
      "keyMoments: set although nothing was measured",
    ]);
    expect(measuredCopyIssues({ ...base, audioSource: "analyzed" })).toEqual([
      'audioSource: "analyzed" although nothing was measured',
    ]);
    expect(measuredCopyIssues({ ...base, audioConfidence: "high" })).toEqual([
      'audioConfidence: "high" although nothing was measured',
    ]);
    expect(measuredCopyIssues({ ...base, segmentsSource: "measured" })).toEqual([
      'segmentsSource: "measured" although nothing was measured',
    ]);
  });

  it("takes bpm as measured or rounded to the nearest integer, and nothing else", () => {
    expect(measuredCopyIssues({ ...passed(), bpm: 105.2 })).toEqual([]);
    expect(measuredCopyIssues({ ...passed(), bpm: 105 })).toEqual([]);
    expect(measuredCopyIssues({ ...passed(), bpm: 106 })).toEqual([
      "bpm: 106 differs from the measured 105.2",
    ]);
    expect(measuredCopyIssues({ ...passed(), bpm: null })).toEqual([
      "bpm: missing although the tempo was measured",
    ]);
    const noTempo = { ...passed(), audio: { ...sampleAudio(), tempo: null } };
    expect(measuredCopyIssues(noTempo)).toContain("bpm: set although its value was not measured");
  });

  it("takes the key from the measured tonic and mode", () => {
    expect(measuredCopyIssues({ ...passed(), key: "a major" })).toEqual([]);
    expect(measuredCopyIssues({ ...passed(), key: "F# Minor" })).toEqual([
      'key: "F# Minor" differs from the measured "A Major"',
    ]);
    expect(measuredCopyIssues({ ...passed(), key: null })).toEqual([
      "key: missing although the key was measured",
    ]);
    const noKey = {
      ...passed(),
      audio: { ...sampleAudio(), key: null },
      audioSource: "unavailable",
    };
    expect(measuredCopyIssues(noKey as TrackAnalysis)).toEqual([
      "key: set although its value was not measured",
      'audioConfidence: "high" needs audioSource "analyzed"',
    ]);
  });

  it.each([
    ["danceability", "danceability"],
    ["valence", "valence"],
    ["acousticness", "acoustic"],
  ] as const)("sets %s only when its mood head was measured", (copy, head) => {
    const moods = { ...sampleAudio().fingerprint?.moods, [head]: null };
    const audio = { ...sampleAudio(), fingerprint: { ...sampleAudio().fingerprint, moods } };
    expect(measuredCopyIssues({ ...passed(), audio } as TrackAnalysis)).toEqual([
      `${copy}: set although its value was not measured`,
    ]);
  });

  it("sets energy only when loudness was measured", () => {
    const audio = { ...sampleAudio(), loudness: null };
    expect(measuredCopyIssues({ ...passed(), audio })).toEqual([
      "energy: set although its value was not measured",
    ]);
  });

  it("copies the key moments exactly", () => {
    const moments = sampleAudio().keyMoments.slice(1);
    expect(measuredCopyIssues({ ...passed(), keyMoments: moments })).toEqual([
      "keyMoments: differ from the measured key moments",
    ]);
  });

  it("needs a tempo and a key for analyzed, and sections for measured segments", () => {
    const noKey = { ...passed(), key: null, audio: { ...sampleAudio(), key: null } };
    expect(measuredCopyIssues(noKey)).toContain(
      'audioSource: "analyzed" needs a measured tempo and key',
    );
    const noSections = { ...passed(), segmentsSource: "measured" as const };
    expect(
      measuredCopyIssues({ ...noSections, audio: { ...sampleAudio(), sections: null } }),
    ).toEqual(['segmentsSource: "measured" needs measured sections']);
    expect(measuredCopyIssues(noSections)).toEqual([]);
  });

  it("flags the four cases the review found", () => {
    const gated = analysis({
      audio: gatedAudio(),
      bpm: 128,
      key: "C major",
      audioSource: "analyzed",
      segmentsSource: "measured",
    });
    expect(analysisIssues(gated)).toEqual(
      expect.arrayContaining([
        "bpm: set although nothing was measured",
        "key: set although nothing was measured",
        'audioSource: "analyzed" although nothing was measured',
        'segmentsSource: "measured" although nothing was measured',
      ]),
    );
    const none = analysis({ audio: null, bpm: 128, key: "C major", audioSource: "analyzed" });
    expect(analysisIssues(none)).toContain("bpm: set although nothing was measured");
    const mismatch = analysis({ bpm: 999, key: "F# minor" });
    expect(analysisIssues(mismatch)).toEqual([
      "bpm: 999 differs from the measured 105.2",
      'key: "F# minor" differs from the measured "A Major"',
    ]);
    const claim = { ...sampleClaim(), id: "m1", kind: "measured", evidenceIds: [], field: "tempo" };
    const gatedClaim = analysis({ ...unmeasured(gatedAudio()), claims: [claim] });
    expect(analysisIssues(gatedClaim)).toEqual(["claims[0].field: tempo was not measured"]);
    const [read] = gatedClaim.claims ?? [];
    expect(read && claimDisplayKind(read, resultContext(gatedClaim))).toBe("inferred");
  });
});

describe("links", () => {
  const link = (change: object = {}) => ({
    source: "current",
    target: "derived1",
    value: 3,
    type: "sample" as const,
    kind: "sourced" as const,
    origin: "model" as const,
    evidenceIds: ["ev-1"],
    ...change,
  });

  it("a sourced link cites at least one item, all in the pack", () => {
    expect(linkIssues(link(), pack)).toEqual([]);
    expect(linkIssues(link({ evidenceIds: [] }), pack)).toEqual([
      ".evidenceIds: a sourced link cites nothing",
    ]);
    expect(linkIssues(link({ evidenceIds: undefined }), pack)).toEqual([
      ".evidenceIds: a sourced link cites nothing",
    ]);
    expect(linkIssues(link({ evidenceIds: ["ev-1", "ev-9"] }), pack)).toEqual([
      '.evidenceIds: cites "ev-9", not in the pack',
    ]);
    expect(linkIssues(link({ kind: "inferred", evidenceIds: [] }), pack)).toEqual([]);
  });

  it("shows a link as sourced only with evidence that is all in the pack", () => {
    expect(linkDisplayKind(link(), pack)).toBe("sourced");
    expect(linkDisplayKind(link({ evidenceIds: [] }), pack)).toBe("inferred");
    expect(linkDisplayKind(link({ evidenceIds: ["ev-1", "ev-9"] }), pack)).toBe("inferred");
    expect(linkDisplayKind(link({ kind: undefined }), pack)).toBe("inferred");
    expect(linkDisplayKind(link({ kind: "inferred" }), pack)).toBe("inferred");
  });

  it("a link never reads as measured: readers drop one that says so", () => {
    const base = sampleAnalysis();
    const genealogy = { nodes: [], links: [link(), link({ kind: "measured" })] };
    expect(TrackAnalysis.parse({ ...base, genealogy }).genealogy.links).toEqual([link()]);
  });

  it("analysisIssues reports a sourced link without evidence", () => {
    const genealogy = { nodes: [], links: [link({ evidenceIds: [] })] };
    expect(analysisIssues(analysis({ genealogy }))).toEqual([
      "genealogy.links[0].evidenceIds: a sourced link cites nothing",
    ]);
  });
});

describe("a result a producer should have caught", () => {
  it("still reaches the client: the stream decoder delivers its complete event", () => {
    const data = analysis({ claims: [{ ...sampleClaim(), evidenceIds: ["ev-gone"] }] });
    const body = encodeSseEvent({ type: "complete", runId: "r", seq: 3, data });
    const [event] = decodeSseStream(body, AnalyzeStreamEvent);
    expect(event?.type).toBe("complete");
    if (event?.type !== "complete") return;
    const [read] = event.data.claims ?? [];
    expect(read && claimDisplayKind(read, resultContext(event.data))).toBe("inferred");
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

  // Validates with the Python library the audio service's tests use: the system python3 when
  // it has jsonschema, otherwise uv with a pinned jsonschema. Skipped locally when neither is
  // available; in CI (process.env.CI) a missing validator fails the test instead.
  const JSONSCHEMA = "jsonschema==4.23.0";
  const python = (() => {
    const candidates: Array<[string, string[]]> = [
      ["python3", ["-I"]],
      ["uv", ["run", "--no-project", "--quiet", "--with", JSONSCHEMA, "python", "-I"]],
    ];
    for (const [command, args] of candidates) {
      try {
        execFileSync(command, [...args, "-c", "import jsonschema"], {
          stdio: "ignore",
          timeout: 120_000,
        });
        return { command, args };
      } catch {
        // Try the next one.
      }
    }
    return null;
  })();
  const inCi = Boolean(process.env.CI);

  it("has a Python validator in CI", () => {
    if (inCi) expect(python, "no python3 with jsonschema and no uv").not.toBeNull();
  });

  it.skipIf(!python && !inCi)("is enforced by Python jsonschema", () => {
    if (!python) throw new Error("no python3 with jsonschema and no uv");
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
    const out = execFileSync(python.command, [...python.args, "-c", script], {
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
