/**
 * The numeric check: tempos and keys read from claim text, compared with the measured audio
 * without treating the estimator as ground truth (#29's bands, ratios, key relations and the
 * audio service's confidence floors).
 */

import type { AudioFeatures, Claim } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { audioV2, gatedV2 } from "../testing/measuredAudio.js";
import {
  checkNumbers,
  ESSENTIA_MIN_TEMPO_CONFIDENCE,
  keyMentions,
  LIBROSA_MIN_TEMPO_CONFIDENCE,
  tempoConfidenceFloor,
  tempoMentions,
} from "./numeric.js";

/** A measurement whose tempo is `bpm` at `confidence`, by Essentia unless `method` says. */
const tempoAt = (
  bpm: number,
  confidence: number | null = 0.71,
  method = "essentia.RhythmExtractor2013",
): AudioFeatures => {
  const base = audioV2();
  return audioV2({ tempo: { ...base.tempo!, bpm, confidence, method } });
};

/** A measurement whose key is `tonic` `mode` at `strength`. */
const keyAt = (
  tonic: NonNullable<AudioFeatures["key"]>["tonic"],
  mode: "major" | "minor",
  strength: number | null = 0.68,
): AudioFeatures => {
  const base = audioV2();
  return audioV2({ key: { ...base.key!, tonic, mode, strength } });
};

const check = (text: string, audio: AudioFeatures | null, field?: Claim["field"]) =>
  checkNumbers({ text, field }, audio);

describe("reading tempos", () => {
  it("reads a number written with its unit", () => {
    expect(tempoMentions("It runs at 120 BPM.")).toEqual([{ field: "tempo", bpm: 120 }]);
    expect(tempoMentions("a 96.5 bpm groove")).toEqual([{ field: "tempo", bpm: 96.5 }]);
    expect(tempoMentions("at 123-BPM")).toEqual([{ field: "tempo", bpm: 123 }]);
    expect(tempoMentions("88 beats per minute, later 176 beats a minute")).toEqual([
      { field: "tempo", bpm: 88 },
      { field: "tempo", bpm: 176 },
    ]);
  });

  it("reads no tempo without a unit, and none out of range", () => {
    expect(tempoMentions("Released in 1990, it sold 120 copies")).toEqual([]);
    expect(tempoMentions("a 1990 BPM record")).toEqual([]);
    expect(tempoMentions("a 5 BPM drone")).toEqual([]);
  });
});

describe("reading keys", () => {
  it("reads a key with its mode, sharps and flats folded to the contract's sharps", () => {
    expect(keyMentions("It is in F# minor.")).toEqual([
      { field: "key", tonic: "F#", mode: "minor" },
    ]);
    expect(keyMentions("Written in B-flat major.")).toEqual([
      { field: "key", tonic: "A#", mode: "major" },
    ]);
    expect(keyMentions("The key is Bb Major")).toEqual([
      { field: "key", tonic: "A#", mode: "major" },
    ]);
    expect(keyMentions("E♭ minor throughout")).toEqual([
      { field: "key", tonic: "D#", mode: "minor" },
    ]);
    expect(keyMentions("C♯ minor and Db major")).toEqual([
      { field: "key", tonic: "C#", mode: "minor" },
      { field: "key", tonic: "C#", mode: "major" },
    ]);
  });

  it('reads "key of" with or without a mode', () => {
    expect(keyMentions("in the key of Bb")).toEqual([{ field: "key", tonic: "A#", mode: null }]);
    expect(keyMentions("in the key of G minor")).toEqual([
      { field: "key", tonic: "G", mode: "minor" },
    ]);
  });

  it("does not read ordinary English as a key", () => {
    expect(keyMentions("A minor hit in the UK, it was a major success.")).toEqual([]);
    expect(keyMentions("A major label signed them.")).toEqual([]);
    // The same words read as a key where the claim is about the key.
    expect(keyMentions("A minor", true)).toEqual([{ field: "key", tonic: "A", mode: "minor" }]);
    expect(keyMentions("A minor, its key")).toEqual([{ field: "key", tonic: "A", mode: "minor" }]);
  });
});

describe("the tempo check", () => {
  it("120 against a measured 119.6 is consistent", () => {
    const result = check("It runs at 120 BPM.", tempoAt(119.6));
    expect(result).toMatchObject({
      numericCheck: "consistent",
      numericComparison: { claimed: 120, measured: 119.6, method: "essentia.RhythmExtractor2013" },
      field: "tempo",
    });
    expect(result.numericReason).toMatch(/they agree/);
  });

  it("agrees within max(2 BPM, 2 %) of the measurement, and no further", () => {
    expect(check("62 BPM", tempoAt(60)).numericCheck).toBe("consistent");
    expect(check("62.1 BPM", tempoAt(60)).numericCheck).not.toBe("consistent");
    expect(check("204 BPM", tempoAt(200)).numericCheck).toBe("consistent");
    expect(check("204.1 BPM", tempoAt(200)).numericCheck).not.toBe("consistent");
  });

  it("120 against a measured 117 is a conflict: outside the band, within 4 %", () => {
    const result = check("120 BPM", tempoAt(117));
    expect(result.numericCheck).toBe("conflict");
    expect(result.numericReason).toMatch(/less than 4 %/);
  });

  it.each([
    [120, 60, "twice the measured tempo"],
    [60, 120, "half the measured tempo"],
    [80, 120, "two thirds of the measured tempo"],
    [180, 120, "one and a half times the measured tempo"],
    [246, 123, "twice the measured tempo"],
  ])(
    "%d against a measured %d is a conflict, however confident (%s)",
    (claimed, measured, words) => {
      const result = check(`${claimed} BPM`, tempoAt(measured, 1));
      expect(result.numericCheck).toBe("conflict");
      expect(result.numericReason).toContain(words);
    },
  );

  it("95 against a confident 120 is contradicted", () => {
    const result = check("95 BPM", tempoAt(120, 0.71));
    expect(result.numericCheck).toBe("contradicted");
    expect(result.numericComparison).toEqual({
      claimed: 95,
      measured: 120,
      method: "essentia.RhythmExtractor2013",
    });
  });

  it("never contradicts with a low-confidence or confidence-less measurement", () => {
    for (const confidence of [null, 0, ESSENTIA_MIN_TEMPO_CONFIDENCE - 0.01]) {
      const result = check("95 BPM", tempoAt(120, confidence));
      expect(result.numericCheck, String(confidence)).toBe("conflict");
      expect(result.numericReason).toMatch(/confidence is too low/);
    }
    expect(check("95 BPM", tempoAt(120, ESSENTIA_MIN_TEMPO_CONFIDENCE)).numericCheck).toBe(
      "contradicted",
    );
  });

  it("uses each estimator's own floor, and the higher one for an unknown method", () => {
    const librosa = "librosa.beat.beat_track+beat-regression";
    expect(tempoConfidenceFloor(librosa)).toBe(LIBROSA_MIN_TEMPO_CONFIDENCE);
    expect(tempoConfidenceFloor("essentia.RhythmExtractor2013")).toBe(
      ESSENTIA_MIN_TEMPO_CONFIDENCE,
    );
    expect(tempoConfidenceFloor("other")).toBe(LIBROSA_MIN_TEMPO_CONFIDENCE);
    // 0.29 is above Essentia's floor (0.282) and below librosa's (0.3).
    expect(check("95 BPM", tempoAt(120, 0.29)).numericCheck).toBe("contradicted");
    expect(check("95 BPM", tempoAt(120, 0.29, librosa)).numericCheck).toBe("conflict");
    expect(check("95 BPM", tempoAt(120, 0.29, "other")).numericCheck).toBe("conflict");
  });
});

describe("the key check", () => {
  it("the same key is consistent; so is the same tonic when no mode is stated", () => {
    expect(check("It is in D minor.", keyAt("D", "minor")).numericCheck).toBe("consistent");
    expect(check("in the key of D", keyAt("D", "minor")).numericCheck).toBe("consistent");
    // Enharmonics: B-flat is the measured A#.
    expect(check("in B-flat minor", keyAt("A#", "minor")).numericCheck).toBe("consistent");
  });

  it.each([
    ["D major", "D", "minor", "its parallel key"],
    ["F major", "D", "minor", "its relative key"],
    ["A minor", "C", "major", "its relative key"],
    ["in the key of F", "D", "minor", "its relative key"],
    ["A minor", "D", "minor", "a fifth away from it"],
    ["G major", "D", "minor", "a fifth away from it"],
  ] as const)("%s against a measured %s %s is a conflict (%s)", (text, tonic, mode, words) => {
    const result = check(`It is in ${text}.`, keyAt(tonic, mode, 1));
    expect(result.numericCheck).toBe("conflict");
    expect(result.numericReason).toContain(words);
    expect(result.numericComparison).toMatchObject({
      measured: `${tonic} ${mode}`,
      method: "essentia.KeyExtractor",
    });
  });

  it("an unrelated key is contradicted only by a confident measurement", () => {
    expect(check("It is in F# major.", keyAt("D", "minor", 0.68)).numericCheck).toBe(
      "contradicted",
    );
    expect(check("It is in F# major.", keyAt("D", "minor", 0.39)).numericCheck).toBe("conflict");
    expect(check("It is in F# major.", keyAt("D", "minor", null)).numericCheck).toBe("conflict");
  });
});

describe("the check of a claim", () => {
  it("reads a factoid card's text, which has no field", () => {
    const text = "Producers built the loop at 246 BPM, a breakneck pace for the time.";
    expect(check(text, tempoAt(123)).numericCheck).toBe("conflict");
  });

  it("takes the worst result of several mentions", () => {
    const text = "At 116 BPM, in F# major.";
    const result = check(text, audioV2());
    expect(result.numericCheck).toBe("contradicted");
    expect(result.field).toBe("key");
  });

  it("is n/a without a mention, and says what was not compared when nothing was measured", () => {
    expect(check("A song about summer.", audioV2())).toEqual({
      numericCheck: "n/a",
      numericReason: null,
      numericComparison: null,
      field: null,
    });
    for (const audio of [null, gatedV2(), audioV2({ tempo: null })]) {
      const result = check("It runs at 95 BPM.", audio);
      expect(result.numericCheck).toBe("n/a");
      expect(result.numericReason).toMatch(/tempo was not measured/);
    }
  });

  it("reads only the tempo and key blocks of the measurement", () => {
    const audio = audioV2();
    const bare = audioV2({
      loudness: null,
      beats: null,
      energyContour: null,
      sections: null,
      keyMoments: [],
      fingerprint: null,
    });
    for (const text of ["It runs at 116 BPM.", "It is in D minor.", "95 BPM in F# major"]) {
      expect(check(text, bare)).toEqual(check(text, audio));
    }
  });
});
