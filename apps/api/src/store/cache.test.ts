import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { AudioFeatures } from "@liner-notes/contract";
import { MIGRATION_3_FROZEN, MIGRATIONS, runMigrations } from "./migrations.js";
import {
  audioLookupKeys,
  audioTrackKeys,
  type CachedAudio,
  canonicalIsrc,
  isrcRowServes,
  LOW_CONFIDENCE_AUDIO_TTL_MS,
} from "./measuredAudio.js";
import { SonicCache } from "./cache.js";
import type { AudioMeasurement } from "../agent/state.js";
import {
  ANALYZER_VERSION,
  audioV2,
  gatedV2,
  ISRC_MATCH,
  measurementOf,
  SEARCH_MATCH,
  signalOnlyV2,
} from "../agent/testing/measuredAudio.js";

const DAY_SEC = 24 * 60 * 60;
const ISRC = "USSB29000129";
/** The analyzer version after a change of the analysis (another tempo, key or energy rule). */
const NEXT_VERSION = "2.2.0+essentia.models-5c5c0c7f";

/** A complete measurement filed under the track's ISRC (its clip was the ISRC's Deezer entry). */
const complete = (block: Partial<AudioFeatures> = {}) => measurementOf(audioV2(block), ISRC_MATCH);
/** A partial one: tempo and key without the models (low confidence). */
const partial = (block: Partial<AudioFeatures> = {}) =>
  measurementOf(signalOnlyV2({ analyzerVersion: ANALYZER_VERSION, ...block }), ISRC_MATCH);
const bpmOf = (hit: AudioMeasurement | null) => hit?.audio?.tempo?.bpm;

describe("SonicCache audio", () => {
  let db: Database.Database;
  let cache: SonicCache;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    cache = new SonicCache(db);
  });
  afterEach(() => db.close());

  const insertRaw = (trackKey: string, version: string, fullData: string, confidence = "high") =>
    db
      .prepare(
        "INSERT INTO audio_cache (track_key, analyzer_version, spotify_id, confidence, full_data, expires_at) VALUES (?, ?, 'x', ?, ?, unixepoch() + 86400)",
      )
      .run(trackKey, version, confidence, fullData);

  const expiresIn = (trackKey: string) =>
    db
      .prepare("SELECT expires_at - unixepoch() FROM audio_cache WHERE track_key = ?")
      .pluck()
      .get(trackKey) as number;

  it("is keyed by (track key, analyzer version)", () => {
    const columns = db.pragma("table_info(audio_cache)") as Array<{ name: string; pk: number }>;
    const key = columns
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    expect(key).toEqual(["track_key", "analyzer_version"]);
    expect(MIGRATIONS.find((m) => m.name === "audio_cache_by_analyzer")?.version).toBe(14);
  });

  it("files a measurement under the track's own key, and under the entry's ISRC key when taken by ISRC", () => {
    const own = "spotify:sp1";
    const byIsrc = `isrc:${ISRC}:3366332`;
    expect(audioTrackKeys(ISRC_MATCH, "sp1", ISRC)).toEqual([byIsrc, own]);
    // A Deezer entry read by id that carries the ISRC is an ISRC match (no score).
    expect(
      audioTrackKeys({ provider: "deezer", method: "id", deezerId: 2, score: null }, "sp1", ISRC),
    ).toEqual([`isrc:${ISRC}:2`, own]);
    expect(audioTrackKeys(SEARCH_MATCH, "sp1", ISRC)).toEqual([own]);
    expect(
      audioTrackKeys({ provider: "deezer", method: "id", deezerId: 2, score: 0.9 }, "sp1", ISRC),
    ).toEqual([own]);
    expect(audioTrackKeys({ provider: "spotify", method: "id", score: null }, "sp1", ISRC)).toEqual(
      [own],
    );
    // No ISRC, or a malformed one: the track's own key only.
    expect(audioTrackKeys(ISRC_MATCH, "sp1", null)).toEqual([own]);
    expect(audioTrackKeys(ISRC_MATCH, "sp1", "not-an-isrc")).toEqual([own]);
    expect(canonicalIsrc("us-sb2-90-00129")).toBe(ISRC);
    // Looked up under the entry this run's resolution took by ISRC, and nothing else.
    expect(audioLookupKeys("sp1", ISRC, ISRC_MATCH)).toEqual([byIsrc, own]);
    const entry7 = {
      provider: "deezer" as const,
      method: "isrc" as const,
      deezerId: 7,
      score: null,
    };
    expect(audioLookupKeys("sp1", ISRC, entry7)).toEqual([`isrc:${ISRC}:7`, own]);
    expect(audioLookupKeys("sp1", ISRC, SEARCH_MATCH)).toEqual([own]);
    expect(audioLookupKeys("sp1", ISRC, null)).toEqual([own]);
    expect(audioLookupKeys("sp1", null, ISRC_MATCH)).toEqual([own]);
  });

  it("serves a measurement for the analyzer version that measured it, and misses for another", () => {
    cache.putAudio(`isrc:${ISRC}`, "sp1", complete());

    expect(cache.getAudio(`isrc:${ISRC}`, ANALYZER_VERSION)).toEqual(complete());
    // A newer analyzer (or an older one): a miss, the track is measured again.
    expect(cache.getAudio(`isrc:${ISRC}`, NEXT_VERSION)).toBeNull();
    expect(cache.getAudio(`isrc:${ISRC}`, "2.0.0+essentia")).toBeNull();
  });

  it("keeps the measurements of two analyzer versions apart", () => {
    cache.putAudio(`isrc:${ISRC}`, "sp1", complete());
    cache.putAudio(
      `isrc:${ISRC}`,
      "sp1",
      complete({
        analyzerVersion: NEXT_VERSION,
        tempo: { ...audioV2().tempo!, bpm: 231.6 },
      }),
    );
    expect(bpmOf(cache.getAudio(`isrc:${ISRC}`, ANALYZER_VERSION))).toBe(115.8);
    expect(bpmOf(cache.getAudio(`isrc:${ISRC}`, NEXT_VERSION))).toBe(231.6);
    expect(db.prepare("SELECT COUNT(*) FROM audio_cache").pluck().get()).toBe(2);
  });

  it("serves an ISRC row only to a track whose own resolution took the same Deezer entry by ISRC", () => {
    const row = complete() as CachedAudio;
    const sameEntry = { ...ISRC_MATCH };
    // The track's own resolution took that entry: the same clip, the same measurement.
    expect(isrcRowServes(`isrc:${ISRC}`, row, sameEntry)).toBe(true);
    // Its alternative read by id that carries the ISRC is an ISRC match too, when it is that entry.
    expect(isrcRowServes(`isrc:${ISRC}`, row, { ...ISRC_MATCH, method: "id", score: null })).toBe(
      true,
    );
    // Another entry for the ISRC, a search match, Spotify's own clip, or no clip at all (the
    // entry turned down by this track's checks, or Deezer not read): not served.
    for (const fresh of [
      { ...ISRC_MATCH, deezerId: 1 },
      SEARCH_MATCH,
      { provider: "spotify" as const, method: "id" as const, score: null },
      null,
    ]) {
      expect(isrcRowServes(`isrc:${ISRC}`, row, fresh)).toBe(false);
    }
    // A row without the entry's id is never served under the ISRC.
    const { deezerId: _id, ...noId } = ISRC_MATCH as { deezerId: number };
    const unidentified = { ...row, previewMatch: noId as never };
    expect(isrcRowServes(`isrc:${ISRC}`, unidentified, sameEntry)).toBe(false);
    // The track's own row is its own measurement, whatever this run's resolution.
    const own = measurementOf(audioV2(), SEARCH_MATCH) as never;
    expect(isrcRowServes("spotify:sp1", own, null)).toBe(true);
  });

  it("files a clip under an ISRC key only with its Deezer entry's id", () => {
    const { deezerId: _id, ...noId } = ISRC_MATCH as { deezerId: number };
    expect(audioTrackKeys(noId as never, "sp1", ISRC)).toEqual(["spotify:sp1"]);
  });

  it("gives the newest measurement under a key, of any analyzer version, with when it was stored", () => {
    cache.putAudio("spotify:n", "n", complete());
    db.prepare("UPDATE audio_cache SET created_at = created_at - 86400").run();
    const newer = complete({ analyzerVersion: NEXT_VERSION });
    cache.putAudio("spotify:n", "n", newer);

    const newest = cache.getNewestAudio("spotify:n");
    expect(newest?.measurement).toEqual(newer);
    expect(Math.abs((newest?.measuredAt.getTime() ?? 0) - Date.now())).toBeLessThan(5_000);
    expect(cache.getNewestAudio("spotify:none")).toBeNull();

    // An expired row is not served, nor a row whose block names another version than its key.
    cache.putAudio("spotify:gone", "gone", complete(), 0);
    expect(cache.getNewestAudio("spotify:gone")).toBeNull();
    db.prepare(
      "INSERT INTO audio_cache (track_key, analyzer_version, spotify_id, confidence, full_data, expires_at) VALUES ('spotify:mis', '9.9.9', 'mis', 'high', ?, unixepoch() + 86400)",
    ).run(JSON.stringify(complete()));
    expect(cache.getNewestAudio("spotify:mis")).toBeNull();
  });

  it("files a search-matched measurement under its own track only", () => {
    const measured = measurementOf(audioV2(), SEARCH_MATCH);
    for (const key of audioTrackKeys(SEARCH_MATCH, "sp1", ISRC))
      cache.putAudio(key, "sp1", measured);

    expect(cache.getAudio("spotify:sp1", ANALYZER_VERSION)).toEqual(measured);
    expect(db.prepare("SELECT track_key FROM audio_cache").pluck().all()).toEqual(["spotify:sp1"]);
    expect(cache.getAudio("spotify:sp2", ANALYZER_VERSION)).toBeNull();
  });

  it("does not serve a row that is not a v2 measurement, nor one filed under another version", () => {
    const flatV1 = {
      bpm: 104,
      key: "A Minor",
      energy: 0.7,
      confidence: "high",
      measured: true,
      analyzer: "audio-service",
      previewMatch: ISRC_MATCH,
    };
    insertRaw("spotify:flat", ANALYZER_VERSION, JSON.stringify(flatV1));
    insertRaw("spotify:broken", ANALYZER_VERSION, "{not json");
    insertRaw("spotify:gated", ANALYZER_VERSION, JSON.stringify(measurementOf(gatedV2())));
    insertRaw(
      "spotify:unmatched",
      ANALYZER_VERSION,
      JSON.stringify({ audio: audioV2() }), // no previewMatch
    );
    insertRaw(
      "spotify:v1-block",
      ANALYZER_VERSION,
      JSON.stringify(complete({ version: 1 } as never)),
    );
    // Filed under this version, but its block says another.
    insertRaw(
      "spotify:mislabelled",
      ANALYZER_VERSION,
      JSON.stringify(complete({ analyzerVersion: NEXT_VERSION })),
    );
    for (const key of ["flat", "broken", "gated", "unmatched", "v1-block", "mislabelled"]) {
      expect(cache.getAudio(`spotify:${key}`, ANALYZER_VERSION), key).toBeNull();
    }
  });

  it("refuses to cache anything but a measurement with a tempo and a key", () => {
    const refused: unknown[] = [
      { audio: null, unavailableReason: "service_unavailable" },
      measurementOf(gatedV2()),
      measurementOf(audioV2({ key: null })),
      measurementOf(audioV2({ tempo: null })),
      { audio: audioV2() }, // how its clip was matched is not said
      { bpm: 116, key: "D Minor", measured: true, previewMatch: ISRC_MATCH },
    ];
    for (const measurement of refused) {
      expect(() => cache.putAudio("spotify:x", "x", measurement)).toThrow(/Only measurements/);
    }
    expect(db.prepare("SELECT COUNT(*) FROM audio_cache").pluck().get()).toBe(0);
  });

  it("serves a partial measurement with its confidence", () => {
    cache.putAudio("spotify:p", "p", partial());
    const row = db.prepare("SELECT confidence FROM audio_cache").pluck().get();
    expect(row).toBe("low");
    expect(cache.getAudio("spotify:p", ANALYZER_VERSION)).toEqual(partial());
  });

  it("caches a loud master whose energy copy is null, with its loudness", () => {
    const loud = complete({ loudness: { rmsMean: 0.538, method: "rms", basis: "signal" } });
    cache.putAudio("spotify:loud", "loud", loud);
    expect(cache.getAudio("spotify:loud", ANALYZER_VERSION)?.audio.loudness?.rmsMean).toBe(0.538);
    expect(db.prepare("SELECT confidence FROM audio_cache").pluck().get()).toBe("high");
  });

  it("keeps a partial measurement for a day and a complete one for 30 days", () => {
    cache.putAudio("spotify:low", "low", partial());
    cache.putAudio("spotify:high", "high", complete());
    expect(Math.abs(expiresIn("spotify:low") - DAY_SEC)).toBeLessThanOrEqual(2);
    expect(Math.abs(expiresIn("spotify:high") - 30 * DAY_SEC)).toBeLessThanOrEqual(2);
    expect(LOW_CONFIDENCE_AUDIO_TTL_MS).toBe(DAY_SEC * 1000);
  });

  it("lets a partial measurement replace an expired complete one, but not a live one", () => {
    const slower = (bpm: number) => ({ ...audioV2().tempo!, bpm });
    cache.putAudio("spotify:live", "live", complete({ tempo: slower(100) }));
    cache.putAudio("spotify:live", "live", partial({ tempo: slower(90) }));
    expect(bpmOf(cache.getAudio("spotify:live", ANALYZER_VERSION))).toBe(100);

    cache.putAudio("spotify:expired", "expired", complete({ tempo: slower(100) }), 0);
    cache.putAudio("spotify:expired", "expired", partial({ tempo: slower(90) }));
    expect(bpmOf(cache.getAudio("spotify:expired", ANALYZER_VERSION))).toBe(90);
  });

  it("lets a measurement replace a stored row that is not one", () => {
    insertRaw("spotify:broken", ANALYZER_VERSION, "{not json", "high");
    cache.putAudio("spotify:broken", "broken", partial());
    expect(cache.getAudio("spotify:broken", ANALYZER_VERSION)).toEqual(partial());
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
    expect(() => cache.putAudio("spotify:a", "a", complete())).toThrow("write failed");
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
        spotifyId: null,
        trackTitle: null,
        trackArtist: null,
      }),
    ).toThrow("write failed");
  });
});

describe("SonicCache artwork", () => {
  let db: Database.Database;
  let cache: SonicCache;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    cache = new SonicCache(db);
  });
  afterEach(() => db.close());

  const storedPreview = (key: string) =>
    db.prepare("SELECT preview_url FROM artwork_cache WHERE search_key = ?").pluck().get(key);

  const artwork = {
    coverUrl: "https://i.scdn.co/image/c",
    spotifyUrl: "https://open.spotify.com/track/u",
    spotifyId: "u",
    trackTitle: "Under Pressure",
    trackArtist: "Queen",
  };

  it("stores no preview URL, even when the caller passes one", () => {
    cache.putArtwork("k", { ...artwork, previewUrl: "https://p.scdn.co/mp3-preview/u" } as never);

    expect(storedPreview("k")).toBeNull();
    expect(cache.getArtwork("k")).toEqual(artwork);
  });

  it("keeps every credited artist of the track, and none for a row without them", () => {
    cache.putArtwork("k", { ...artwork, trackArtists: ["Queen", "David Bowie"] });
    expect(cache.getArtwork("k")).toEqual({ ...artwork, trackArtists: ["Queen", "David Bowie"] });

    db.prepare(
      "INSERT INTO artwork_cache (search_key, track_artist, track_artists, expires_at) VALUES ('old', 'Queen', 'not json', unixepoch() + 60)",
    ).run();
    expect(cache.getArtwork("old")).not.toHaveProperty("trackArtists");
  });

  const details = {
    isrc: "GBUM71029601",
    durationMs: 248000,
    album: "Hot Space",
    releaseDate: "1982-05-21",
  };
  const storedDetails = (key: string) =>
    db.prepare("SELECT track_details FROM artwork_cache WHERE search_key = ?").pluck().get(key);

  it("keeps the track's ISRC, duration, album and release date, and nothing else of it", () => {
    cache.putArtwork("k", {
      ...artwork,
      trackDetails: { ...details, previewUrl: "https://p.scdn.co/mp3-preview/u" } as never,
    });

    expect(cache.getArtwork("k")).toEqual({ ...artwork, trackDetails: details });
    expect(JSON.parse(String(storedDetails("k")))).toEqual(details);
    expect(String(storedDetails("k"))).not.toMatch(/https?:|preview/i);
    expect(storedPreview("k")).toBeNull();
  });

  it("keeps details with unknown parts, and none for a row kept without them", () => {
    const partial = { isrc: null, durationMs: null, album: null, releaseDate: "1982" };
    cache.putArtwork("k", { ...artwork, trackDetails: partial });
    expect(cache.getArtwork("k")?.trackDetails).toEqual(partial);

    cache.putArtwork("k", { ...artwork, trackDetails: null });
    expect(storedDetails("k")).toBeNull();
    expect(cache.getArtwork("k")).toEqual(artwork);
  });

  it.each([
    ["an album name that holds a link", { album: "Hits https://example.com/album" }, "album"],
    ["a malformed ISRC", { isrc: "not an isrc" }, "isrc"],
    ["a release date that is not a date", { releaseDate: "https://example.com" }, "releaseDate"],
    ["a duration that is not one", { durationMs: -1 }, "durationMs"],
  ])("drops only %s, and keeps the other details", (_label, bad, field) => {
    cache.putArtwork("k", { ...artwork, trackDetails: { ...details, ...bad } });

    const kept = { ...details, [field]: null };
    expect(JSON.parse(String(storedDetails("k")))).toEqual(kept);
    expect(cache.getArtwork("k")).toEqual({ ...artwork, trackDetails: kept });
  });

  it("keeps an album name that only looks like an address (no link)", () => {
    cache.putArtwork("k", { ...artwork, trackDetails: { ...details, album: "www.thug.com" } });

    expect(cache.getArtwork("k")?.trackDetails).toEqual({ ...details, album: "www.thug.com" });
  });

  it("reads stored details field by field, and none that are not an object", () => {
    const insert = db.prepare(
      "INSERT INTO artwork_cache (search_key, spotify_id, track_title, track_artist, track_details, expires_at) VALUES (?, 'u', 'Under Pressure', 'Queen', ?, unixepoch() + 60)",
    );
    insert.run("broken", "not json");
    insert.run("list", "[]");
    insert.run("link", JSON.stringify({ ...details, album: "http://example.com" }));
    insert.run("extra", JSON.stringify({ ...details, previewUrl: "https://p.scdn.co/x" }));

    for (const key of ["broken", "list"]) {
      expect(cache.getArtwork(key)).toMatchObject({ spotifyId: "u" });
      expect(cache.getArtwork(key)).not.toHaveProperty("trackDetails");
    }
    expect(cache.getArtwork("link")?.trackDetails).toEqual({ ...details, album: null });
    expect(cache.getArtwork("extra")?.trackDetails).toEqual(details);
    expect(JSON.stringify(cache.getArtwork("extra"))).not.toMatch(/https?:\/\/p\.scdn|previewUrl/);
  });

  it("clears a preview URL stored for the key by older code when it writes the row again", () => {
    db.prepare(
      "INSERT INTO artwork_cache (search_key, preview_url, expires_at) VALUES ('k', 'https://p.scdn.co/mp3-preview/old', unixepoch() + 60)",
    ).run();

    cache.putArtwork("k", artwork);

    expect(storedPreview("k")).toBeNull();
    expect(cache.getArtwork("k")).not.toHaveProperty("previewUrl");
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
  // Migration 3 keeps its own copy so that later edits cannot change a shipped migration. Since
  // migration 14 the live cache holds v2 blocks: the copy stays as it shipped.
  it("still keeps what migration 3 kept", () => {
    const flat = {
      bpm: 120,
      key: "C Major",
      energy: 0.5,
      valence: 0.5,
      danceability: 0.5,
      acousticness: 0.5,
      instrumentalness: 0.5,
      confidence: "high",
      keyMoments: [],
      measured: true,
      analyzer: "audio-service",
    };
    const schema = MIGRATION_3_FROZEN.measuredAudioSchema;
    expect(schema.safeParse(flat).success).toBe(true);
    expect(schema.safeParse({ ...flat, measured: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...flat, unavailableReason: "no_preview" }).success).toBe(false);
    expect(MIGRATION_3_FROZEN.lowConfidenceTtlMs).toBe(DAY_SEC * 1000);
  });
});
