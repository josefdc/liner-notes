/**
 * Valid sample values for the contract's tests, built field by field so a test can break one
 * thing at a time. JSON payloads produced by the API live in `fixtures/`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AudioFeatures } from "../audio.js";
import type { Claim, Evidence } from "../evidence.js";
import type { RunInfo, TrackAnalysisInput } from "../track.js";

const here = dirname(fileURLToPath(import.meta.url));
export const packageDir = join(here, "..", "..");
export const repoDir = join(packageDir, "..", "..");

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** The `<name>.json` files of a directory, as [name, parsed JSON] pairs, sorted by name. */
export function jsonFiles(dir: string): Array<[string, unknown]> {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => [file.replace(/\.json$/, ""), readJson(join(dir, file))]);
}

const effnet = { id: "discogs-effnet-bs64-1", licence: "CC BY-NC-SA 4.0" };
const musicnn = { id: "msd-musicnn-1", licence: "CC BY-NC-SA 4.0" };

export const sampleAudio = (): AudioFeatures => ({
  version: 2,
  analyzerVersion: "2.0.0+effnet-discogs-1+musicnn-msd-1",
  window: { kind: "preview-30s", durationSeconds: 30 },
  gate: { passed: true, reason: null },
  tempo: {
    bpm: 105.2,
    confidence: 0.82,
    rawConfidence: { value: 4.36, range: [0, 5.32] },
    method: "essentia.RhythmExtractor2013",
    basis: "signal",
  },
  key: {
    tonic: "A",
    mode: "major",
    strength: 0.71,
    profile: "edma",
    method: "essentia.KeyExtractor",
    basis: "signal",
  },
  loudness: { rmsMean: 0.21, method: "librosa.feature.rms", basis: "signal" },
  beats: { times: [0.31, 0.88, 1.45], method: "essentia.RhythmExtractor2013", basis: "signal" },
  energyContour: { hopSeconds: 0.5, values: [0.1, 0.2, 0.25], method: "rms", basis: "signal" },
  sections: {
    segments: [
      { label: "A", start: 0, end: 14.2 },
      { label: "B", start: 14.2, end: 30 },
    ],
    method: "novelty-on-beat-chroma",
    basis: "signal",
  },
  // The same moments as the API payload in fixtures/api-payloads/composed-measured.json
  keyMoments: [
    { time: 4.2, type: "onset", intensity: 0.8, description: "Beat transition" },
    { time: 17.9, type: "energy_peak", intensity: 1, description: "Energy peak / Drop" },
  ],
  fingerprint: {
    styles: {
      model: effnet,
      top: [
        { label: "Electronic---Synth-pop", score: 0.61 },
        { label: "Electronic---Dream Pop", score: 0.22 },
      ],
      basis: "model",
    },
    tags: { model: musicnn, scores: [{ label: "electronic", score: 0.7 }], basis: "model" },
    moods: {
      danceability: { value: 0.58, range: [0, 1], model: musicnn, basis: "model" },
      acoustic: { value: 0.08, range: [0, 1], model: effnet, basis: "model" },
      instrumental: { value: 0.31, range: [0, 1], model: musicnn, basis: "model" },
      valence: { value: 5.2, range: [1, 9], model: musicnn, basis: "model" },
      arousal: { value: 6.1, range: [1, 9], model: musicnn, basis: "model" },
    },
  },
});

/** What the service returns for silence: every measurement null, with the reason. */
export const gatedAudio = (): AudioFeatures => ({
  ...sampleAudio(),
  gate: { passed: false, reason: "silence" },
  tempo: null,
  key: null,
  loudness: null,
  beats: null,
  energyContour: null,
  sections: null,
  keyMoments: [],
  fingerprint: null,
});

export const sampleEvidence = (): Evidence => ({
  id: "ev-mb-1",
  source: "musicbrainz",
  sourceTier: "primary-record",
  url: "https://musicbrainz.org/recording/0b3f0a2c-0000-4000-8000-000000000001",
  title: "Midnight City — MusicBrainz recording",
  retrievedAt: "2026-10-20T12:00:00.000Z",
  excerpt: "producer: Justin Meldal-Johnsen",
  recordRef: "0b3f0a2c-0000-4000-8000-000000000001",
});

export const sampleClaim = (): Claim => ({
  id: "cl-1",
  text: "Justin Meldal-Johnsen produced the track.",
  about: "credit",
  kind: "sourced",
  origin: "code",
  evidenceIds: ["ev-mb-1"],
  verdict: "supported",
  verdictReason: null,
  numericCheck: "n/a",
});

export const sampleRun = (): RunInfo => ({
  id: "run-1",
  mode: "live",
  recordedAt: null,
  commit: null,
  analyzerVersion: "2.0.0+effnet-discogs-1+musicnn-msd-1",
  fallback: false,
  usage: { llmCalls: 3, inputTokens: 21000, outputTokens: 4000, reasoningTokens: 1500, usd: 0.37 },
  verifier: { judged: 12, unjudged: 0 },
  sourceErrors: [{ source: "discogs", code: "not_configured" }],
});

/** A full v1 result: the API's composed payload plus the fields v1 adds. */
export const sampleAnalysis = (): TrackAnalysisInput =>
  ({
    ...(readJson(join(packageDir, "fixtures", "api-payloads", "composed-measured.json")) as object),
    isrc: "FR6V81141064",
    audio: sampleAudio(),
    preview: { provider: "deezer", method: "isrc", score: null },
    evidence: [sampleEvidence()],
    claims: [
      sampleClaim(),
      {
        id: "cl-2",
        text: "The track runs at about 105 BPM.",
        about: "sound",
        kind: "inferred",
        origin: "model",
        evidenceIds: [],
        verdict: null,
        verdictReason: null,
        numericCheck: "consistent",
        field: "tempo",
      },
    ],
    run: sampleRun(),
  }) as TrackAnalysisInput;
