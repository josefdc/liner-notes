/**
 * finalize.ts: the result's audio block, its copies and run.analyzerVersion come from the
 * measurement by code, whatever the draft (a model answer included) holds; the result passes the
 * contract's producer checks.
 */

import { analysisIssues, type RunInfo, TrackAnalysis } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import {
  emittableAudio,
  energyFromLoudness,
  finalizeResult,
  loudnessDbfs,
  measuredAudioFields,
  moodScore,
} from "./finalize.js";
import type { TrackData } from "./schema.js";
import type { AudioMeasurement } from "./state.js";
import {
  ANALYZER_VERSION,
  audioV2,
  gatedV2,
  keyWithheldV2,
  measurementOf,
  signalOnlyV2,
} from "./testing/measuredAudio.js";

const run: RunInfo = {
  id: "run-1",
  mode: "live",
  recordedAt: null,
  commit: null,
  analyzerVersion: null,
  fallback: false,
  usage: null,
  sourceErrors: [],
};

/**
 * A composed draft as a model answer would leave it if it could reach the measured fields: every
 * copy set to something else, and an `audio` block of its own.
 */
function draftWithModelValues(): TrackData {
  return {
    id: "x",
    title: "Ice Ice Baby",
    artist: "Vanilla Ice",
    album: "To the Extreme",
    coverUrl: "https://i.scdn.co/image/x",
    segments: [
      { label: "Intro", start: 0, end: 10, color: "#374151" },
      { label: "Main", start: 10, end: 90, color: "#1F2937" },
      { label: "Outro", start: 90, end: 100, color: "#374151" },
    ],
    segmentsSource: "template",
    samples: [],
    factoids: [],
    genealogy: { nodes: [{ id: "current", group: 1, label: "Ice Ice Baby", size: 40 }], links: [] },
    claims: [],
    evidence: [],
    run: { ...run, analyzerVersion: "9.9.9-made-up" },
    ...({
      bpm: 999,
      key: "C Major",
      energy: 0.99,
      valence: 0.9,
      danceability: 0.9,
      acousticness: 0.9,
      keyMoments: [{ time: 1, type: "onset", intensity: 1, description: "invented" }],
      audioSource: "analyzed",
      audioConfidence: "high",
      audio: { ...audioV2(), tempo: { ...audioV2().tempo, bpm: 999 } },
    } as unknown as Partial<TrackData>),
  } as TrackData;
}

/** The result as a reader parses it, and the contract's producer issues of it. */
function checked(result: TrackData) {
  const parsed = TrackAnalysis.safeParse(result);
  expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  return { analysis: parsed.data!, issues: analysisIssues(parsed.data!) };
}

describe("finalizeResult", () => {
  it("writes the measured block, copies taken from it and the run's analyzer version", () => {
    const block = audioV2();
    const result = finalizeResult(draftWithModelValues(), measurementOf(block));

    expect(result.audio).toEqual(block);
    expect(result).toMatchObject({
      bpm: 116,
      key: "D Minor",
      energy: 0.64,
      valence: 0.21,
      danceability: 0.64,
      acousticness: 0.05,
      keyMoments: block.keyMoments,
      audioSource: "analyzed",
      audioConfidence: "high",
    });
    expect(result).not.toHaveProperty("audioUnavailableReason");
    expect(result.run?.analyzerVersion).toBe(ANALYZER_VERSION);
    expect(result.run?.analyzerVersion).toBe(result.audio?.analyzerVersion);
    const { analysis, issues } = checked(result);
    expect(issues).toEqual([]);
    expect(analysis.audio).toEqual(block);
  });

  it("leaves no model value in a measured field, also without a measurement", () => {
    const result = finalizeResult(draftWithModelValues(), null);

    expect(result).not.toHaveProperty("audio");
    expect(result).toMatchObject({
      bpm: null,
      key: null,
      energy: null,
      valence: null,
      danceability: null,
      acousticness: null,
      keyMoments: [],
      audioSource: "unavailable",
      audioConfidence: "low",
      audioUnavailableReason: "not_run",
    });
    expect(result.run?.analyzerVersion).toBeNull();
    expect(checked(result).issues).toEqual([]);
  });

  it("keeps the engineer's reason when nothing was measured", () => {
    const result = finalizeResult(draftWithModelValues(), {
      audio: null,
      unavailableReason: "no_preview",
      unavailableDetail: "No preview of this recording",
    });
    expect(result).not.toHaveProperty("audio");
    expect(result).toMatchObject({ bpm: null, audioUnavailableReason: "no_preview" });
    expect(checked(result).issues).toEqual([]);
  });

  it("carries a block whose gate measured nothing, with no copies", () => {
    const block = gatedV2("silence");
    const result = finalizeResult(draftWithModelValues(), measurementOf(block));

    expect(result.audio).toEqual(block);
    expect(result).toMatchObject({
      bpm: null,
      key: null,
      energy: null,
      keyMoments: [],
      audioSource: "unavailable",
      audioUnavailableReason: "not_detected",
    });
    expect(result.run?.analyzerVersion).toBe(ANALYZER_VERSION);
    expect(checked(result).issues).toEqual([]);
  });

  it("keeps a measured tempo without a key, and says the key was not detected", () => {
    const block = signalOnlyV2({ key: null });
    const result = finalizeResult(draftWithModelValues(), measurementOf(block));

    expect(result).toMatchObject({
      bpm: 116,
      key: null,
      valence: null,
      audioSource: "unavailable",
      audioConfidence: "low",
      audioUnavailableReason: "not_detected",
    });
    expect(result.run?.analyzerVersion).toBe("2.1.0+essentia");
    expect(checked(result).issues).toEqual([]);
  });

  it("carries why the key was withheld in the block only, with no flat field for it", () => {
    const block = keyWithheldV2();
    const result = finalizeResult(draftWithModelValues(), measurementOf(block));

    expect(result.audio?.withheld).toEqual(block.withheld);
    expect(result).toMatchObject({ key: null, audioUnavailableReason: "not_detected" });
    expect(result).not.toHaveProperty("withheld");
    expect(checked(result).issues).toEqual([]);
    // The contract's reader keeps the reason too.
    expect(TrackAnalysis.parse(result).audio?.withheld).toEqual(block.withheld);
  });

  it("never builds a block from a measurement that is not a v2 block", () => {
    // State written by older code: flat values, no block.
    const v1 = {
      bpm: 116,
      key: "D Minor",
      energy: 0.72,
      confidence: "high",
      measured: true,
    } as unknown as AudioMeasurement;
    const old = finalizeResult(draftWithModelValues(), v1);
    expect(old).not.toHaveProperty("audio");
    expect(old).toMatchObject({ bpm: null, key: null, energy: null, audioSource: "unavailable" });
    expect(old.run?.analyzerVersion).toBeNull();
    expect(checked(old).issues).toEqual([]);

    // A block of another version, and one that breaks the contract's rules.
    for (const audio of [
      { ...audioV2(), version: 1 },
      { ...audioV2(), gate: { passed: false, reason: "silence" } },
    ]) {
      const result = finalizeResult(draftWithModelValues(), {
        audio,
        previewMatch: measurementOf().previewMatch,
      } as unknown as AudioMeasurement);
      expect(result).not.toHaveProperty("audio");
      expect(result).toMatchObject({ bpm: null, audioUnavailableReason: "analysis_failed" });
      expect(checked(result).issues).toEqual([]);
    }
  });

  it("leaves a draft without run information without one, and does not change the draft", () => {
    const { run: _run, ...draft } = draftWithModelValues();
    const before = JSON.stringify(draft);
    const result = finalizeResult(draft, measurementOf());
    expect(result).not.toHaveProperty("run");
    expect(JSON.stringify(draft)).toBe(before);
  });
});

describe("energy", () => {
  it("is the first service version's scale where it says something, else null", () => {
    expect(energyFromLoudness(0.145)).toBe(0.5);
    expect(energyFromLoudness(0.18)).toBe(0.64);
    // Loud masters: the scale reads 1 at or above a mean RMS of 0.27 (about -11.4 dBFS).
    expect(energyFromLoudness(0.27)).toBeNull();
    expect(energyFromLoudness(0.538)).toBeNull();
    // Quiet input: the scale reads 0 at or below 0.02 (about -34 dBFS), as for silence.
    expect(energyFromLoudness(0.02)).toBeNull();
    expect(energyFromLoudness(0.005)).toBeNull();
    expect(energyFromLoudness(Number.NaN)).toBeNull();
  });

  it("is null on a loud master while the measured loudness stays in the block", () => {
    const loud = audioV2({
      loudness: { rmsMean: 0.538, method: "mean frame RMS", basis: "signal" },
    });
    const fields = measuredAudioFields(measurementOf(loud));
    expect(fields.energy).toBeNull();
    expect(fields.audio?.loudness?.rmsMean).toBe(0.538);
    expect(loudnessDbfs(0.538)).toBeCloseTo(-5.38, 2);
    // Still a complete measurement: the loudness was measured.
    expect(fields.audioConfidence).toBe("high");
  });
});

describe("mood copies", () => {
  it("map a head's own range onto 0..1 and drop an output outside it", () => {
    const model = { id: "m", licence: "x" };
    expect(moodScore({ value: 5, range: [1, 9], model, basis: "model" })).toBe(0.5);
    expect(moodScore({ value: 0.31, range: [0, 1], model, basis: "model" })).toBe(0.31);
    expect(moodScore({ value: 9.5, range: [1, 9], model, basis: "model" })).toBeNull();
    expect(moodScore(null)).toBeNull();
  });

  it("are null without the models, and the result is then of low confidence", () => {
    const fields = measuredAudioFields(measurementOf(signalOnlyV2()));
    expect(fields).toMatchObject({
      valence: null,
      danceability: null,
      acousticness: null,
      audioSource: "analyzed",
      audioConfidence: "low",
    });
  });
});

describe("emittableAudio", () => {
  it("is the block as the contract reads it, or null", () => {
    expect(emittableAudio(measurementOf())).toEqual(audioV2());
    expect(emittableAudio(null)).toBeNull();
    expect(emittableAudio({ audio: null, unavailableReason: "no_preview" })).toBeNull();
  });
});
