import { AudioFeatures } from '@liner-notes/contract';
import { describe, expect, it } from 'vitest';
import { isAudioFeatures, readAudio } from './audio';

// The page reads an `audio` block exactly as the contract does: the whole block or nothing.
// Generated valid blocks, and every single-field fault of each, are read by both and must get
// the same answer; a block both accept must give the same values.

/** A small deterministic generator (mulberry32). */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Json = unknown;

function validBlock(seed: number): Record<string, Json> {
  const r = random(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(r() * items.length)] as T;
  const maybe = <T>(value: () => T, p = 0.8): T | null => (r() < p ? value() : null);
  const unit = () => pick([0, 1, Math.round(r() * 100) / 100]);
  const model = () => ({
    id: pick(['discogs-effnet-bs64-1', 'msd-musicnn-1']),
    licence: 'CC BY-NC-SA 4.0',
  });
  const scores = () =>
    Array.from({ length: Math.floor(r() * 4) }, (_, i) => ({ label: `label ${i}`, score: r() }));
  const modelScore = () => {
    const range = pick([
      [0, 1],
      [1, 9],
    ]) as [number, number];
    return { value: range[0] + r() * (range[1] - range[0]), range, model: model(), basis: 'model' };
  };
  const passed = r() < 0.8;
  const block: Record<string, Json> = {
    version: 2,
    analyzerVersion: '2.1.0+essentia.models-5c5c0c7f',
    window: { kind: 'preview-30s', durationSeconds: pick([0, 22.4, 29.75, 30]) },
    gate: { passed, reason: passed ? null : pick(['silence', 'noise', 'too_short']) },
    tempo: maybe(() => ({
      bpm: 60 + r() * 120,
      confidence: maybe(unit, 0.7),
      ...(r() < 0.5
        ? { rawConfidence: maybe(() => ({ value: r() * 5.32, range: [0, 5.32] })) }
        : {}),
      method: 'essentia.RhythmExtractor2013',
      basis: 'signal',
    })),
    key: maybe(() => ({
      tonic: pick(['C', 'F#', 'A#', 'B']),
      mode: pick(['major', 'minor']),
      strength: maybe(unit, 0.7),
      profile: 'edma',
      method: 'essentia.KeyExtractor',
      basis: 'signal',
    })),
    loudness: maybe(() => ({ rmsMean: pick([0, r()]), method: 'essentia.RMS', basis: 'signal' })),
    beats: maybe(() => ({
      times: [0.3, 0.9],
      method: 'essentia.RhythmExtractor2013',
      basis: 'signal',
    })),
    energyContour: maybe(() => ({
      hopSeconds: 0.5,
      values: [0.1, 0],
      method: 'rms',
      basis: 'signal',
    })),
    sections: maybe(() => ({
      segments: [{ label: 'A', start: 0, end: 14.2 }],
      method: 'novelty',
      basis: 'signal',
    })),
    keyMoments: Array.from({ length: Math.floor(r() * 3) }, () => ({
      time: r() * 30,
      type: pick(['onset', 'energy_peak', 'silence']),
      intensity: unit(),
      description: pick(['', 'Peak']),
    })),
    fingerprint: maybe(() => ({
      styles: maybe(() => ({ model: model(), top: scores(), basis: 'model' })),
      tags: maybe(() => ({ model: model(), scores: scores(), basis: 'model' })),
      moods: maybe(() => ({
        danceability: maybe(modelScore),
        acoustic: maybe(modelScore),
        instrumental: maybe(modelScore),
        valence: maybe(modelScore),
        arousal: maybe(modelScore),
      })),
    })),
  };
  if (r() < 0.2) block.extra = 'ignored';
  return block;
}

const FAULTS: Json[] = [
  undefined,
  null,
  'x',
  '',
  -1,
  0,
  1.5,
  2,
  Number.NaN,
  Infinity,
  true,
  [],
  {},
];

/** Every block with one field changed: each value replaced by each fault, or its key removed. */
function* singleFaults(block: Json): Generator<Json> {
  function* walk(node: Json, path: (string | number)[]): Generator<(string | number)[]> {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        yield [...path, i];
        yield* walk(node[i], [...path, i]);
      }
    } else if (typeof node === 'object' && node !== null) {
      for (const key of Object.keys(node)) {
        yield [...path, key];
        yield* walk((node as Record<string, Json>)[key], [...path, key]);
      }
    }
  }
  const at = (root: Json, path: (string | number)[]) =>
    path.slice(0, -1).reduce<Json>((node, key) => (node as Record<string, Json>)[key], root);
  for (const path of walk(block, [])) {
    const last = path[path.length - 1] as string | number;
    for (const fault of [...FAULTS, 'remove']) {
      const copy = structuredClone(block);
      const parent = at(copy, path) as Record<string | number, Json>;
      if (fault === 'remove') {
        if (Array.isArray(parent)) continue;
        delete parent[last];
      } else parent[last] = fault;
      yield copy;
    }
    // A list with an entry that cannot be read.
    const copy = structuredClone(block);
    const node = (at(copy, path) as Record<string | number, Json>)[last];
    if (Array.isArray(node)) {
      node.push({ bad: true });
      yield copy;
    }
  }
}

const SEEDS = Array.from({ length: 60 }, (_, i) => i + 1);

describe('readAudio against the contract', () => {
  it('accepts exactly the blocks the contract accepts (valid and single-fault blocks)', () => {
    const disagreements: string[] = [];
    let checked = 0;
    for (const seed of SEEDS) {
      const block = validBlock(seed);
      for (const candidate of [block, ...singleFaults(block)]) {
        checked++;
        const contract = AudioFeatures.safeParse(candidate).success;
        if (
          isAudioFeatures(candidate) !== contract ||
          (readAudio(candidate) !== null) !== contract
        ) {
          disagreements.push(`seed ${seed}: contract ${contract}: ${JSON.stringify(candidate)}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
    expect(disagreements.slice(0, 5)).toEqual([]);
    expect(disagreements).toHaveLength(0);
  });

  it('reads the same values as the contract from every valid block', () => {
    for (const seed of SEEDS) {
      const block = validBlock(seed);
      const parsed = AudioFeatures.parse(block);
      const read = readAudio(block);
      expect(read?.analyzerVersion).toBe(parsed.analyzerVersion);
      expect(read?.windowSeconds).toBe(parsed.window.durationSeconds);
      expect(read?.gate).toEqual(parsed.gate);
      if (!parsed.gate.passed) continue;
      expect(read?.tempo).toEqual(parsed.tempo);
      expect(read?.key).toEqual(parsed.key);
      expect(read?.loudness).toEqual(parsed.loudness);
      expect(read?.keyMoments).toEqual(parsed.keyMoments);
      expect(read?.fingerprint?.moods ?? null).toEqual(parsed.fingerprint?.moods ?? null);
      const sorted = (items: { label: string; score: number }[] | undefined) =>
        items && [...items].sort((a, b) => b.score - a.score);
      expect(read?.fingerprint?.styles?.top).toEqual(sorted(parsed.fingerprint?.styles?.top));
      expect(read?.fingerprint?.tags?.scores).toEqual(sorted(parsed.fingerprint?.tags?.scores));
    }
  });
});
