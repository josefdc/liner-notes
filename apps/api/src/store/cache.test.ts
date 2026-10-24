import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { z } from "zod";
import { MIGRATION_3_FROZEN, runMigrations } from "./migrations.js";
import { LOW_CONFIDENCE_AUDIO_TTL_MS, MeasuredAudioSchema } from "./measuredAudio.js";
import { SonicCache, isMeasuredAudio } from "./cache.js";
import type { AudioFeatures } from "../agent/state.js";

const DAY_SEC = 24 * 60 * 60;

/** Perceptual scores of a partial measurement: not measured, so null (as toAudioFeatures does). */
const PARTIAL = {
  valence: null,
  danceability: null,
  acousticness: null,
  instrumentalness: null,
  confidence: "low",
} as const;

/** A measurement as the engineer caches it. */
function measured(overrides: Partial<AudioFeatures> = {}): AudioFeatures {
  return {
    bpm: 104,
    key: "A Minor",
    energy: 0.7,
    valence: 0.4,
    danceability: 0.6,
    acousticness: 0.2,
    instrumentalness: 0.1,
    confidence: "high",
    keyMoments: [],
    measured: true,
    analyzer: "audio-service",
    previewMatch: { provider: "deezer", method: "isrc", deezerId: 3366332, score: null },
    ...overrides,
  };
}

describe("SonicCache audio", () => {
  let db: Database.Database;
  let cache: SonicCache;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    cache = new SonicCache(db);
  });
  afterEach(() => db.close());

  const insertRaw = (id: string, fullData: string, confidence = "high") =>
    db
      .prepare(
        "INSERT INTO audio_cache (spotify_id, bpm, key_signature, energy, confidence, full_data, expires_at) VALUES (?, 120, 'C Major', 0.5, ?, ?, unixepoch() + 86400)",
      )
      .run(id, confidence, fullData);

  const expiresIn = (id: string) =>
    db
      .prepare("SELECT expires_at - unixepoch() FROM audio_cache WHERE spotify_id = ?")
      .pluck()
      .get(id) as number;

  it("does not serve a row without the measured marker", () => {
    const { measured: _m, analyzer: _a, ...unmarked } = measured();
    insertRaw("old", JSON.stringify(unmarked));
    expect(cache.getAudio("old")).toBeNull();
  });

  it("does not serve a marked row that is not a valid measurement", () => {
    insertRaw("zero-bpm", JSON.stringify(measured({ bpm: 0 })));
    insertRaw("out-of-range", JSON.stringify(measured({ energy: 3 })));
    insertRaw("broken-json", "{not json");
    insertRaw("other-analyzer", JSON.stringify({ ...measured(), analyzer: "estimator" }));
    for (const id of ["zero-bpm", "out-of-range", "broken-json", "other-analyzer"]) {
      expect(cache.getAudio(id), id).toBeNull();
    }
  });

  it("serves a measured low-confidence row with its confidence", () => {
    cache.putAudio("partial", measured({ confidence: "low", valence: null, danceability: null }));
    const hit = cache.getAudio("partial");
    expect(hit).toMatchObject({ bpm: 104, key: "A Minor", confidence: "low", valence: null });
  });

  it("caches a measurement without energy", () => {
    cache.putAudio("no-energy", measured({ energy: null, confidence: "low" }));
    expect(cache.getAudio("no-energy")).toMatchObject({ bpm: 104, energy: null });
    const row = db.prepare("SELECT energy FROM audio_cache WHERE spotify_id = 'no-energy'").get();
    expect(row).toEqual({ energy: null });
  });

  it("refuses to cache features that are not marked as measured", () => {
    const { measured: _m, ...unmarked } = measured();
    expect(() => cache.putAudio("x", unmarked as AudioFeatures)).toThrow(/Only measured/);
    expect(() =>
      cache.putAudio("y", {
        ...measured(),
        bpm: null,
        key: null,
        unavailableReason: "service_unavailable",
      }),
    ).toThrow(/Only measured/);
    expect(db.prepare("SELECT COUNT(*) FROM audio_cache").pluck().get()).toBe(0);
    expect(isMeasuredAudio(measured())).toBe(true);
  });

  it("keeps a partial measurement for a day and a complete one for 30 days", () => {
    cache.putAudio("low", measured({ confidence: "low", valence: null }));
    cache.putAudio("high", measured());
    expect(Math.abs(expiresIn("low") - DAY_SEC)).toBeLessThanOrEqual(2);
    expect(Math.abs(expiresIn("high") - 30 * DAY_SEC)).toBeLessThanOrEqual(2);
  });

  it("lets a partial measurement replace an expired complete one, but not a live one", () => {
    cache.putAudio("live", measured({ bpm: 100 }));
    cache.putAudio("live", measured({ bpm: 90, ...PARTIAL }));
    expect(cache.getAudio("live")?.bpm).toBe(100);

    cache.putAudio("expired", measured({ bpm: 100 }), 0);
    cache.putAudio("expired", measured({ bpm: 90, ...PARTIAL }));
    expect(cache.getAudio("expired")).toMatchObject({ bpm: 90, confidence: "low" });
  });

  it("lets a matched partial measurement replace a complete row that does not say how its clip was matched", () => {
    const { previewMatch: _matched, ...unmatched } = measured({ bpm: 120 });
    cache.putAudio("old", unmatched as AudioFeatures);
    cache.putAudio("old", measured({ bpm: 95, ...PARTIAL }));
    expect(cache.getAudio("old")).toMatchObject({
      bpm: 95,
      confidence: "low",
      previewMatch: { provider: "deezer", method: "isrc" },
    });
  });

  it("lets a real measurement replace a stored row that is not a valid measurement", () => {
    // Marked as measured and high confidence, but bpm 0 is not a measurement.
    insertRaw("broken", JSON.stringify(measured({ bpm: 0 })), "high");
    cache.putAudio("broken", measured({ bpm: 97, ...PARTIAL }));
    expect(cache.getAudio("broken")).toMatchObject({ bpm: 97, confidence: "low" });
  });
});

describe("SonicCache write errors", () => {
  let db: Database.Database;
  let cache: SonicCache;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    cache = new SonicCache(db);
  });
  afterEach(() => db.close());

  /** Makes every insert into `table` fail, as a full disk or a locked file would. */
  const failInserts = (table: string) =>
    db.exec(
      `CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'write failed'); END`,
    );

  it("putAudio rethrows", () => {
    failInserts("audio_cache");
    expect(() => cache.putAudio("a", measured())).toThrow("write failed");
  });

  it("putResearch rethrows", () => {
    failInserts("research_cache");
    expect(() => cache.putResearch("r", { samples: [], productionTrivia: [] })).toThrow(
      "write failed",
    );
  });

  it("putArtwork rethrows", () => {
    failInserts("artwork_cache");
    expect(() =>
      cache.putArtwork("k", {
        coverUrl: null,
        spotifyUrl: null,
        previewUrl: null,
        spotifyId: null,
        trackTitle: null,
        trackArtist: null,
      }),
    ).toThrow("write failed");
  });
});

describe("SonicCache research", () => {
  it("treats a row with an unexpected shape as a miss", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const cache = new SonicCache(db);
    db.prepare(
      "INSERT INTO research_cache (spotify_id, samples_count, trivia_count, full_data, expires_at) VALUES ('bad', 0, 0, ?, unixepoch() + 60)",
    ).run(JSON.stringify({ samples: "not a list", productionTrivia: [] }));
    expect(cache.getResearch("bad")).toBeNull();
    cache.putResearch("good", { samples: ["a"], productionTrivia: [] });
    expect(cache.getResearch("good")?.samples).toEqual(["a"]);
    db.close();
  });

  it("drops fields older code stored (song-meaning text, the old related-artists list)", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const cache = new SonicCache(db);
    db.prepare(
      "INSERT INTO research_cache (spotify_id, samples_count, trivia_count, full_data, expires_at) VALUES ('old', 0, 0, ?, unixepoch() + 60)",
    ).run(
      JSON.stringify({
        samples: [],
        productionTrivia: [],
        songMeaning: ["Song meaning page: LINE_OF_SONG_TEXT"],
        relatedArtists: ["[ListenBrainz Similar Artists] x"],
      }),
    );
    expect(cache.getResearch("old")).toEqual({ samples: [], productionTrivia: [] });
    db.close();
  });
});

describe("migration 3's frozen copy of the audio cache rules", () => {
  // Migration 3 keeps its own copy so that later edits cannot change a shipped migration. If the
  // live rules change on purpose, update this test (not the copy) and say why in the change.
  it("still matches the live rules", () => {
    // JSON Schema has no `undefined`: a `z.undefined()` field is written as `not: {}` (no value
    // allowed), so loosening it to any other type changes the schema.
    const jsonSchema = (schema: z.ZodType) =>
      z.toJSONSchema(schema, {
        unrepresentable: "any",
        override: (ctx) => {
          if (ctx.zodSchema._zod.def.type === "undefined") ctx.jsonSchema.not = {};
        },
      });
    expect(jsonSchema(MIGRATION_3_FROZEN.measuredAudioSchema)).toEqual(
      jsonSchema(MeasuredAudioSchema),
    );
    for (const schema of [MIGRATION_3_FROZEN.measuredAudioSchema, MeasuredAudioSchema]) {
      expect(schema.safeParse(measured({ unavailableReason: "no_preview" })).success).toBe(false);
      expect(jsonSchema(schema).properties).toMatchObject({ unavailableReason: { not: {} } });
    }
    expect(MIGRATION_3_FROZEN.lowConfidenceTtlMs).toBe(LOW_CONFIDENCE_AUDIO_TTL_MS);
  });
});
