/**
 * Audio measurements for tests: AudioFeatures v2 blocks as the audio service sends them, its
 * /analyze answers, and the engineer's measurement of one. Values are made up for tests only.
 */

import type { AudioFeatures } from "@liner-notes/contract";
import type { PreviewSourceMatch } from "../../sources/audio.js";
import type { AudioMeasurement } from "../state.js";

/** The analyzer version of the blocks below, as the service names it. */
export const ANALYZER_VERSION = "2.1.0+essentia.models-5c5c0c7f";

const effnet = { id: "discogs-effnet-bs64-1", licence: "CC BY-NC-SA 4.0" };
const musicnn = { id: "msd-musicnn-1", licence: "CC BY-NC-SA 4.0" };

/**
 * A complete measurement: tempo 115.8, D minor, mean RMS 0.18 (-14.9 dBFS, energy copy 0.64), the
 * Essentia mood heads (DEAM valence 2.68 on 1..9).
 */
export function audioV2(overrides: Partial<AudioFeatures> = {}): AudioFeatures {
  return {
    version: 2,
    analyzerVersion: ANALYZER_VERSION,
    window: { kind: "preview-30s", durationSeconds: 29.98 },
    gate: { passed: true, reason: null },
    tempo: {
      bpm: 115.8,
      confidence: 0.71,
      rawConfidence: { value: 3.78, range: [0, 5.32] },
      method: "essentia.RhythmExtractor2013",
      basis: "signal",
    },
    key: {
      tonic: "D",
      mode: "minor",
      strength: 0.68,
      profile: "edma",
      method: "essentia.KeyExtractor",
      basis: "signal",
    },
    loudness: { rmsMean: 0.18, method: "mean frame RMS", basis: "signal" },
    beats: { times: [0.4, 0.92, 1.44], method: "essentia.RhythmExtractor2013", basis: "signal" },
    energyContour: { hopSeconds: 0.5, values: [0.12, 0.2, 0.19], method: "rms", basis: "signal" },
    sections: {
      segments: [
        { label: "A", start: 0, end: 14.6 },
        { label: "B", start: 14.6, end: 29.98 },
      ],
      method: "novelty-on-beat-chroma",
      basis: "signal",
    },
    keyMoments: [
      { time: 3.2, type: "onset", intensity: 0.8, description: "Beat transition" },
      { time: 16.4, type: "energy_peak", intensity: 1, description: "Energy peak" },
    ],
    fingerprint: {
      styles: {
        model: effnet,
        top: [{ label: "Hip Hop---Pop Rap", score: 0.57 }],
        basis: "model",
      },
      tags: { model: musicnn, scores: [{ label: "hip-hop", score: 0.62 }], basis: "model" },
      moods: {
        danceability: { value: 0.64, range: [0, 1], model: musicnn, basis: "model" },
        acoustic: { value: 0.05, range: [0, 1], model: effnet, basis: "model" },
        instrumental: { value: 0.01, range: [0, 1], model: musicnn, basis: "model" },
        valence: { value: 2.68, range: [1, 9], model: musicnn, basis: "model" },
        arousal: { value: 6.1, range: [1, 9], model: musicnn, basis: "model" },
      },
    },
    ...overrides,
  };
}

/** Tempo and key only: the models are not loaded (no fingerprint), the version says so. */
export function signalOnlyV2(overrides: Partial<AudioFeatures> = {}): AudioFeatures {
  return audioV2({ analyzerVersion: "2.1.0+essentia", fingerprint: null, ...overrides });
}

/** What the service sends for silence: its gate did not pass, nothing is measured. */
export function gatedV2(reason: "silence" | "noise" | "too_short" = "silence"): AudioFeatures {
  return audioV2({
    gate: { passed: false, reason },
    tempo: null,
    key: null,
    loudness: null,
    beats: null,
    energyContour: null,
    sections: null,
    keyMoments: [],
    fingerprint: null,
  });
}

/**
 * A block of analyzer 2.3.0 whose key was withheld, with the reason: one pitched source (the
 * service's words), the rest measured.
 */
export function keyWithheldV2(overrides: Partial<AudioFeatures> = {}): AudioFeatures {
  return audioV2({
    analyzerVersion: "2.3.0+essentia.models-5c5c0c7f",
    key: null,
    withheld: {
      key: {
        code: "one_pitched_source",
        reason: "one pitched source (its partials hold still and rise and fall together)",
      },
    },
    ...overrides,
  });
}

/** An /analyze answer of the current service: the block as `v2`, and anything in `extra`. */
export function serviceAnswer(block: AudioFeatures | null, extra: Record<string, unknown> = {}) {
  return { ...extra, ...(block ? { v2: block } : {}) };
}

/**
 * An /analyze answer of a service before analyzer 2.3.0: the v1 fields it derived from the
 * block (never read), and the block as `v2`.
 */
export function v1Answer(block: AudioFeatures | null, v1: Record<string, unknown> = {}) {
  return {
    bpm: block?.tempo ? Math.round(block.tempo.bpm) : null,
    key: block?.key?.tonic ?? null,
    mode: block?.key ? (block.key.mode === "major" ? "Major" : "Minor") : null,
    energy: block?.loudness ? 0.64 : null,
    duration: block?.window.durationSeconds ?? 30,
    source: "analyzed",
    analyzer_version: block?.analyzerVersion ?? ANALYZER_VERSION,
    keyMoments: block?.keyMoments ?? [],
    valence: null,
    danceability: null,
    acousticness: null,
    instrumentalness: null,
    ...v1,
    ...(block ? { v2: block } : {}),
  };
}

/** The Deezer entry for the track's ISRC, as resolvePreview reports it. */
export const ISRC_MATCH: PreviewSourceMatch = {
  provider: "deezer",
  method: "isrc",
  deezerId: 3366332,
  score: null,
};

/** A strict Deezer search match. */
export const SEARCH_MATCH: PreviewSourceMatch = {
  provider: "deezer",
  method: "search",
  deezerId: 1,
  score: 1,
};

/** The engineer's measurement of a clip: the block and how the clip was matched. */
export function measurementOf(
  block: AudioFeatures = audioV2(),
  previewMatch: PreviewSourceMatch = ISRC_MATCH,
): AudioMeasurement {
  return { audio: block, previewMatch };
}
