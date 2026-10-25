import {
  AudioFeatures,
  Claim,
  ClaimAbout,
  ClaimField,
  ClaimKind,
  ClaimOrigin,
  claimDisplayKind as contractDisplayKind,
  Evidence,
  FactoidEntityType,
  FactoidType,
  NumericCheck,
  SourceId,
  SourceTier,
  Verdict,
} from '@liner-notes/contract';
import { describe, expect, it } from 'vitest';
import { readAudio } from '../measured/audio';
import { audioBlock } from '../measured/testing';
import {
  CLAIM_ABOUTS,
  CLAIM_FIELDS,
  CLAIM_KINDS,
  CLAIM_ORIGINS,
  claimDisplayKind,
  FACTOID_ENTITY_TYPES,
  FACTOID_TYPES,
  isClaim,
  isEvidence,
  NUMERIC_CHECKS,
  readClaims,
  readEvidence,
  SOURCE_IDS,
  SOURCE_TIERS,
  VERDICTS,
} from './claims';

// The page reads claims and evidence as the contract does, without loading its schemas: every
// generated item, and every single-field fault of each, must get the same answer from the
// page's checks and from the schemas, and the page must show each claim as the contract's
// claimDisplayKind does.

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
const SEEDS = Array.from({ length: 80 }, (_, i) => i + 1);
const PACK = ['ev-a', 'ev-b', 'ev-c'];

function generators(seed: number) {
  const r = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(r() * items.length)] as T;
  // Every value of each enum comes up across the seeds, whatever the generator draws.
  const cycle = <T>(items: readonly T[], offset = 0): T =>
    items[(seed + offset) % items.length] as T;
  return { r, pick, cycle };
}

const TIMESTAMPS = [
  '2026-10-20T12:00:00.000Z',
  '2026-10-20T12:00Z',
  '2024-02-29T23:59:59Z',
  '2026-01-01T00:00:00.123456Z',
];

function validEvidence(seed: number): Record<string, Json> {
  const { r, pick, cycle } = generators(seed);
  return {
    id: pick(PACK),
    source: cycle(SourceId.options),
    sourceTier: cycle(SourceTier.options, 1),
    url: pick([null, 'https://musicbrainz.org/recording/1', 'javascript:alert(1)', '']),
    title: pick(['A title', '']),
    retrievedAt: pick(TIMESTAMPS),
    excerpt: pick(['An excerpt.', '']),
    recordRef: pick([null, 'track/recording/1']),
    ...(r() < 0.2 ? { extra: 'ignored' } : {}),
  };
}

function validClaim(seed: number): Record<string, Json> {
  const { r, pick, cycle } = generators(seed);
  const claim: Record<string, Json> = {
    id: `c${seed}`,
    text: pick(['A statement.', '']),
    about: cycle(ClaimAbout.options),
    kind: cycle(ClaimKind.options, 1),
    origin: cycle(ClaimOrigin.options, 2),
    evidenceIds: Array.from({ length: Math.floor(r() * 3) }, () => pick([...PACK, 'ev-gone'])),
    verdict: pick([null, ...Verdict.options]),
    verdictReason: pick([null, 'Because.']),
    numericCheck: cycle(NumericCheck.options, 3),
  };
  if (r() < 0.6) claim.numericReason = pick([null, 'Twice the tempo.']);
  if (r() < 0.6) {
    claim.numericComparison = pick([
      null,
      { claimed: 246, measured: 123.04, method: 'essentia.RhythmExtractor2013' },
      { claimed: 'A minor', measured: 'C major', method: 'essentia.KeyExtractor' },
    ]);
  }
  if (r() < 0.7) claim.field = cycle(ClaimField.options, 4);
  if (r() < 0.4) {
    claim.factoid = {
      title: 'A card',
      type: cycle(FactoidType.options, 5),
      entities: [{ text: 'Someone', type: cycle(FactoidEntityType.options, 6) }],
    };
  }
  if (r() < 0.2) claim.extra = 'ignored';
  return claim;
}

const FAULTS: Json[] = [
  undefined,
  null,
  'x',
  '',
  -1,
  0,
  1.5,
  Number.NaN,
  Infinity,
  true,
  [],
  {},
  '2026-10-20T12:00:00+01:00',
  '2026-02-30T12:00:00Z',
];

/** Every item with one field changed: each value replaced by each fault, or its key removed. */
function* singleFaults(item: Json): Generator<Json> {
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
  for (const path of walk(item, [])) {
    const last = path[path.length - 1] as string | number;
    for (const fault of [...FAULTS, 'remove']) {
      const copy = structuredClone(item);
      const parent = at(copy, path) as Record<string | number, Json>;
      if (fault === 'remove') {
        if (Array.isArray(parent)) continue;
        delete parent[last];
      } else parent[last] = fault;
      yield copy;
    }
  }
}

describe("the page's copy of the contract's enums", () => {
  it('equals the contract', () => {
    const same = (mine: ReadonlySet<string>, theirs: readonly string[]) =>
      expect([...mine].sort()).toEqual([...theirs].sort());
    same(SOURCE_IDS, SourceId.options);
    same(SOURCE_TIERS, SourceTier.options);
    same(CLAIM_KINDS, ClaimKind.options);
    same(CLAIM_ABOUTS, ClaimAbout.options);
    same(VERDICTS, Verdict.options);
    same(NUMERIC_CHECKS, NumericCheck.options);
    same(CLAIM_ORIGINS, ClaimOrigin.options);
    same(CLAIM_FIELDS, ClaimField.options);
    same(FACTOID_TYPES, FactoidType.options);
    same(FACTOID_ENTITY_TYPES, FactoidEntityType.options);
  });
});

describe('isEvidence and isClaim against the contract', () => {
  it('accept exactly the evidence items the contract accepts', () => {
    let checked = 0;
    for (const seed of SEEDS) {
      const item = validEvidence(seed);
      expect(Evidence.safeParse(item).success).toBe(true);
      for (const candidate of [item, ...singleFaults(item)]) {
        const expected = Evidence.safeParse(candidate).success;
        expect(isEvidence(candidate), JSON.stringify(candidate)).toBe(expected);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(5000);
  });

  it('accept exactly the claims the contract accepts', () => {
    let rejected = 0;
    for (const seed of SEEDS) {
      const item = validClaim(seed);
      expect(Claim.safeParse(item).success).toBe(true);
      for (const candidate of [item, ...singleFaults(item)]) {
        const expected = Claim.safeParse(candidate).success;
        expect(isClaim(candidate), JSON.stringify(candidate)).toBe(expected);
        if (!expected) rejected += 1;
      }
    }
    expect(rejected).toBeGreaterThan(1000);
  });

  it('read the lists as the contract does, dropping what it cannot read', () => {
    const claims: Json[] = SEEDS.flatMap((seed) => [
      validClaim(seed),
      ...singleFaults(validClaim(seed)),
    ]);
    const parsed = claims.flatMap((candidate) => {
      const result = Claim.safeParse(candidate);
      return result.success ? [result.data] : [];
    });
    // The schema strips keys it does not know; the page keeps them, unread.
    const known = (claim: Record<string, Json>) =>
      Object.fromEntries(Object.entries(claim).filter(([key]) => key in Claim.shape));
    expect(readClaims(claims).map(known)).toEqual(parsed.map(known));
    const items: Json[] = SEEDS.flatMap((seed) => [
      validEvidence(seed),
      ...singleFaults(validEvidence(seed)),
    ]);
    expect(readEvidence(items).map((item) => item.id)).toEqual(
      items.flatMap((candidate) => {
        const result = Evidence.safeParse(candidate);
        return result.success ? [result.data.id] : [];
      }),
    );
  });
});

describe('claimDisplayKind against the contract', () => {
  const measurements: Array<[string, Record<string, unknown> | null]> = [
    ['none', null],
    ['all measured', audioBlock()],
    ['no key', audioBlock({ key: null })],
    ['no tempo', audioBlock({ tempo: null })],
    [
      'gated',
      audioBlock({
        gate: { passed: false, reason: 'silence' },
        tempo: null,
        key: null,
        loudness: null,
        keyMoments: [],
      }),
    ],
  ];
  const packs = [[], ['ev-a'], PACK];

  it('shows every claim as the contract does, for every measurement and pack', () => {
    let checked = 0;
    for (const [name, block] of measurements) {
      const audio = block === null ? null : AudioFeatures.parse(block);
      for (const pack of packs) {
        const contract = { evidenceIds: new Set(pack), audio };
        const page = { evidenceIds: new Set(pack), audio: readAudio(block) };
        for (const seed of SEEDS) {
          const claim = Claim.parse(validClaim(seed));
          expect(claimDisplayKind(claim, page), `${name} ${pack} ${seed}`).toBe(
            contractDisplayKind(claim, contract),
          );
          checked += 1;
        }
      }
    }
    expect(checked).toBe(measurements.length * packs.length * SEEDS.length);
  });
});
