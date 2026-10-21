/**
 * The identity chain on real MusicBrainz answers (fixtures/musicbrainz-*, captured from the
 * live API and cut to the fields read): a record whose title, artists or duration differ from
 * the track is omitted with the reason, never replaced by the next candidate; a matching one
 * yields primary-record Evidence that passes the contract's checks.
 */

import { Evidence as EvidenceSchema, evidenceIssues } from "@liner-notes/contract";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import iceDetails from "./fixtures/musicbrainz-recording-details-ice-ice-baby.json" with {
  type: "json",
};
import iceIsrc from "./fixtures/musicbrainz-isrc-ice-ice-baby.json" with { type: "json" };
import iceReleases from "./fixtures/musicbrainz-releases-ice-ice-baby.json" with { type: "json" };
import iceWork from "./fixtures/musicbrainz-work-ice-ice-baby.json" with { type: "json" };
import geniusSearch from "./fixtures/genius-search-ice-ice-baby.json" with { type: "json" };
import geniusSong from "./fixtures/genius-song-ice-ice-baby.json" with { type: "json" };
import shsWork from "./fixtures/shs-work-ice-ice-baby.json" with { type: "json" };
import { type FetchCall, type FetchRoute, json, stubFetch } from "./testing/fetchStub.js";
import { recordThenReplay } from "./testing/roundTrip.js";
import {
  collectPrimarySources,
  discogsCandidates,
  musicBrainzRelationships,
  pickRecording,
  primarySourcesTool,
  resolveIdentity,
} from "./identity.js";
import { MusicBrainzRateLimiter, type MbRecordingSummary } from "./musicbrainz.js";
import type { TrackRef } from "./records.js";

const MB = "https://musicbrainz.org/ws/2";
const ICE = "875c24bc-fe9e-4ac6-80d3-beaacb70ee43";
const ICE_WORK = "e0ebb61d-7f69-3667-a2b1-dcd447d80f3d";
const UNDER_PRESSURE = "32c7e292-14f1-4080-bddf-ef852e0a4c59";
const now = () => new Date("2026-10-20T12:00:00.000Z");

/** "Ice Ice Baby" as Spotify lists it on "To the Extreme". */
const ICE_TRACK: TrackRef = {
  isrc: "USCA29001716",
  title: "Ice Ice Baby",
  artists: ["Vanilla Ice"],
  durationMs: 271_733,
};

const musicBrainz: FetchRoute = (call: FetchCall) => {
  if (call.url.startsWith(`${MB}/isrc/USCA29001716?`)) return json(iceIsrc);
  if (call.url.startsWith(`${MB}/recording/${ICE}?`)) return json(iceDetails);
  if (call.url.startsWith(`${MB}/release?`)) return json(iceReleases);
  if (call.url.startsWith(`${MB}/work/${ICE_WORK}?`)) return json(iceWork);
  return undefined;
};

const withShs: FetchRoute = (call) =>
  call.url === "https://secondhandsongs.com/work/4196" ? json(shsWork) : musicBrainz(call);

function expectValidEvidence(items: unknown[]) {
  expect(items.length).toBeGreaterThan(0);
  for (const item of items) {
    const parsed = EvidenceSchema.parse(item);
    expect(evidenceIssues(parsed)).toEqual([]);
    expect(parsed.sourceTier).toBe("primary-record");
    expect(parsed.retrievedAt).toBe("2026-10-20T12:00:00.000Z");
  }
}

let restoreInterval: () => void;
beforeAll(() => {
  restoreInterval = MusicBrainzRateLimiter.getInstance().setIntervalForTests(0);
});
afterAll(() => restoreInterval());

beforeEach(() => {
  for (const name of ["DISCOGS_TOKEN", "GENIUS_ACCESS_TOKEN", "SHS_API_KEY", "SOURCE_CASSETTE"]) {
    delete process.env[name];
  }
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("pickRecording on the five recordings MusicBrainz files under USCA29001716", () => {
  const candidates = iceIsrc.recordings as MbRecordingSummary[];

  it("matches the album version and omits the edits, each with its reason", () => {
    const pick = pickRecording(ICE_TRACK, candidates);
    expect(pick.recording?.id).toBe(ICE);
    const reasons = Object.fromEntries(pick.omitted.map((o) => [o.ref, o.reason]));
    expect(Object.keys(reasons)).toHaveLength(4);
    expect(reasons["recording/b45f216e-1582-4c8d-9db2-4f48564ee699"]).toMatch(/^title /);
    expect(reasons["recording/1acfe446-cad3-4b7e-91d5-69424e270087"]).toMatch(/^title /);
    // Same title, but 45 s shorter: the radio edit filed without "(radio edit)" in its title.
    expect(reasons["recording/1cd7d430-7daf-4758-bad1-1c34f71d42ca"]).toMatch(/^duration 226\.7 s/);
  });

  it("omits every candidate when the title differs", () => {
    const pick = pickRecording(
      { ...ICE_TRACK, title: "Ice Ice Baby (Miami Drop Mix)" },
      candidates,
    );
    expect(pick.recording).toBeNull();
    expect(pick.omitted).toHaveLength(5);
    expect(pick.omitted.every((o) => o.reason.startsWith("title "))).toBe(true);
  });

  it("omits every candidate when the credited artists differ", () => {
    for (const artists of [["Vanilla Ice", "Kep1er"], ["MC Hammer"]]) {
      const pick = pickRecording({ ...ICE_TRACK, artists }, candidates);
      expect(pick.recording).toBeNull();
      expect(pick.omitted.filter((o) => o.reason.startsWith("credited to"))).toHaveLength(2);
    }
  });

  it("omits every candidate when the duration is more than 3 s off", () => {
    const pick = pickRecording({ ...ICE_TRACK, durationMs: 275_500 }, candidates);
    expect(pick.recording).toBeNull();
    expect(pick.omitted.find((o) => o.ref === `recording/${ICE}`)?.reason).toMatch(
      /^duration 271\.0 s is more than 3\.0 s from 275\.5 s/,
    );
  });

  it("takes the strictly closest of several passing recordings, never the first", () => {
    const twin = (id: string, length: number, disambiguation = "") => ({
      id,
      title: "Ice Ice Baby",
      length,
      disambiguation,
      "artist-credit": [{ name: "Vanilla Ice", artist: { id: "x", name: "Vanilla Ice" } }],
    });
    const far = twin("00000000-0000-4000-8000-000000000001", 269_500);
    const near = twin("00000000-0000-4000-8000-000000000002", 271_500);
    expect(pickRecording(ICE_TRACK, [far, near]).recording?.id).toBe(near.id);
    // Equally close and both undisambiguated: none is taken.
    const tie = twin("00000000-0000-4000-8000-000000000003", 271_966);
    const pick = pickRecording(ICE_TRACK, [near, tie]);
    expect(pick.recording).toBeNull();
    expect(pick.reason).toContain("cannot be told apart");
  });
});

describe("discogsCandidates on the recording's releases", () => {
  it("lists original releases only, earliest dated release first", () => {
    const ids = discogsCandidates(iceReleases.releases);
    // 1990-09-04, then 1990-12-03, then the releases dated only "1990".
    expect(ids.slice(0, 2)).toEqual([599648, 687927]);
    // The soundtrack and the compilation are not original releases.
    expect(ids).not.toContain(739983);
    expect(ids).not.toContain(759973);
    expect(ids).toContain(711787);
  });
});

describe("resolveIdentity", () => {
  it("reaches the recording and the Genius, SecondHandSongs and Discogs links", async () => {
    const net = stubFetch(musicBrainz);
    const { identity, result } = await resolveIdentity(ICE_TRACK);
    expect(identity).toMatchObject({
      isrc: "USCA29001716",
      recording: { mbid: ICE, title: "Ice Ice Baby", artist: "Vanilla Ice", lengthMs: 271_000 },
      works: [{ mbid: ICE_WORK, title: "Ice Ice Baby", cover: false }],
      geniusUrl: "https://genius.com/Vanilla-ice-ice-ice-baby-lyrics",
      shsLinks: [{ kind: "work", id: 4196 }],
      releasesError: null,
    });
    expect(identity?.discogsReleaseIds[0]).toBe(599648);
    expect(result.identity).toEqual({ matched: 1, rejected: 4, missing: 0 });
    expect(net.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/ws/2/isrc/USCA29001716",
      `/ws/2/recording/${ICE}`,
      "/ws/2/release",
    ]);
  });

  it("is missing, with every rejected recording, when none is the track", async () => {
    stubFetch(musicBrainz);
    const { identity, result } = await resolveIdentity({ ...ICE_TRACK, durationMs: 200_000 });
    expect(identity).toBeNull();
    expect(result).toMatchObject({ status: "missing", identity: { matched: 0, rejected: 5 } });
  });

  it("is missing when MusicBrainz knows no recording with the ISRC (404)", async () => {
    stubFetch(() => json({ error: "Not Found" }, { status: 404 }));
    const { result } = await resolveIdentity({ ...ICE_TRACK, isrc: "USSM19000034" });
    expect(result).toMatchObject({
      status: "missing",
      reason: "MusicBrainz has no recording with ISRC USSM19000034",
      identity: { matched: 0, rejected: 0, missing: 1 },
    });
  });

  it("checks the recording it looks up again: a merged recording that is not the track is omitted", async () => {
    stubFetch((call) =>
      call.url.startsWith(`${MB}/recording/${ICE}?`)
        ? json({ ...iceDetails, title: "Ice Ice Baby (live)" })
        : musicBrainz(call),
    );
    const { identity, result } = await resolveIdentity(ICE_TRACK);
    expect(identity).toBeNull();
    expect(result.status).toBe("missing");
    expect(result.omitted.at(-1)).toEqual({
      ref: `recording/${ICE}`,
      reason: 'title "Ice Ice Baby (live)" is not "Ice Ice Baby"',
    });
  });

  it("sends nothing for a malformed ISRC", async () => {
    const net = stubFetch(() => undefined);
    const { result } = await resolveIdentity({ ...ICE_TRACK, isrc: "not-an-isrc" });
    expect(result.status).toBe("missing");
    expect(net.calls).toHaveLength(0);
  });
});

describe("musicBrainzRelationships", () => {
  it("yields the recording's samples and covers as primary-record Evidence", async () => {
    stubFetch(musicBrainz);
    const result = await musicBrainzRelationships(await resolveIdentity(ICE_TRACK), { now });
    if (result.status !== "found") throw new Error(result.reason);
    expect(result.records).toContainEqual({
      kind: "samples",
      recording: {
        mbid: UNDER_PRESSURE,
        title: "Under Pressure",
        artist: "Queen & David Bowie",
        lengthMs: 243_000,
      },
      work: null,
      attributes: [],
    });
    expect(result.records.filter((r) => r.kind === "covered-by")).toHaveLength(6);
    expectValidEvidence(result.evidence);
    expect(result.evidence[0]).toMatchObject({
      id: `musicbrainz:recording/${ICE}`,
      url: `https://musicbrainz.org/recording/${ICE}`,
      excerpt: 'MusicBrainz recording "Ice Ice Baby" by Vanilla Ice (4:31), ISRC USCA29001716.',
    });
    expect(result.evidence.map((e) => e.excerpt)).toContain(
      'MusicBrainz: "Ice Ice Baby" by Vanilla Ice samples "Under Pressure" by Queen & David Bowie.',
    );
    // Every item names a different record, so a pack deduplicating by recordRef keeps them all.
    expect(new Set(result.evidence.map((e) => e.recordRef)).size).toBe(result.evidence.length);
  });

  it("produces no Evidence when the recording is not the track", async () => {
    stubFetch(musicBrainz);
    const result = await musicBrainzRelationships(
      await resolveIdentity({
        ...ICE_TRACK,
        title: "Ice Ice Baby (radio edit)",
        durationMs: 271_000,
      }),
    );
    expect(result.status).toBe("missing");
    expect("evidence" in result).toBe(false);
  });
});

describe("collectPrimarySources", () => {
  it("reads every source from the chain; one without a credential is missing", async () => {
    stubFetch(withShs);
    const sources = await collectPrimarySources(ICE_TRACK, { now });

    expect(sources.musicbrainz.status).toBe("found");
    expect(sources.discogs).toMatchObject({
      status: "missing",
      reason: "DISCOGS_TOKEN is not set",
      error: { source: "discogs", code: "not_configured" },
    });
    expect(sources.genius).toMatchObject({
      status: "missing",
      reason: "GENIUS_ACCESS_TOKEN is not set",
    });
    expect(sources.secondhandsongs).toMatchObject({ status: "found" });
    expectValidEvidence(sources.evidence);
    expect(new Set(sources.evidence.map((e) => e.source))).toEqual(
      new Set(["musicbrainz", "secondhandsongs"]),
    );
    expect(sources.accuracy).toEqual({
      musicbrainz: { matched: 1, rejected: 4, missing: 0 },
      discogs: { matched: 0, rejected: 0, missing: 1 },
      genius: { matched: 0, rejected: 0, missing: 1 },
      secondhandsongs: { matched: 1, rejected: 0, missing: 0 },
    });
  });

  it("checks the Discogs release the chain reaches and omits one without the track", async () => {
    process.env.DISCOGS_TOKEN = "discogs-test-token";
    // A release shaped like the Discogs API's, whose only track is a different song.
    const otherSong = {
      id: 599648,
      title: "To the Extreme",
      artists: [{ id: 1, name: "Vanilla Ice" }],
      tracklist: [
        { position: "1", type_: "track", title: "Play That Funky Music", duration: "4:45" },
      ],
    };
    const net = stubFetch((call) =>
      call.url.startsWith("https://api.discogs.com/releases/") ? json(otherSong) : withShs(call),
    );
    const sources = await collectPrimarySources(ICE_TRACK, { now });
    expect(sources.discogs).toMatchObject({
      status: "missing",
      identity: { matched: 0, rejected: 3, missing: 0 },
    });
    expect(sources.discogs.omitted[0]).toEqual({
      ref: "release/599648",
      reason: 'no track titled "Ice Ice Baby" among 1 tracks',
    });
    const discogs = net.calls.filter((c) => c.url.startsWith("https://api.discogs.com/"));
    expect(discogs.map((c) => c.url)).toEqual([
      "https://api.discogs.com/releases/599648",
      "https://api.discogs.com/releases/687927",
      "https://api.discogs.com/releases/4828233",
    ]);
  });

  it("is callable as an agent tool that answers JSON", async () => {
    stubFetch(withShs);
    const answer = JSON.parse(
      await primarySourcesTool.invoke({
        isrc: ICE_TRACK.isrc,
        title: ICE_TRACK.title,
        artists: ICE_TRACK.artists,
        durationMs: ICE_TRACK.durationMs,
      }),
    );
    expect(answer.identity.recording.mbid).toBe(ICE);
    expect(answer.discogs).toMatchObject({ status: "missing", reason: "DISCOGS_TOKEN is not set" });
    expectValidEvidence(
      answer.evidence.map((e: { retrievedAt: string }) => ({
        ...e,
        retrievedAt: now().toISOString(),
      })),
    );
  });

  it("never throws: an unreachable MusicBrainz leaves every source missing", async () => {
    stubFetch(() => json({ error: "slow down" }, { status: 503 }));
    const sources = await collectPrimarySources(ICE_TRACK, { now });
    expect(sources.identity).toBeNull();
    expect(sources.musicbrainz).toMatchObject({
      status: "missing",
      error: { source: "musicbrainz", code: "rate_limited" },
    });
    expect(sources.discogs).toMatchObject({
      status: "missing",
      reason: "DISCOGS_TOKEN is not set",
    });
    expect(sources.secondhandsongs).toMatchObject({
      status: "missing",
      reason: "no MusicBrainz recording identified for the track",
    });
    expect(sources.evidence).toEqual([]);
  });

  it("replays the recorded run of every source with no network, from scrubbed cassettes", async () => {
    process.env.DISCOGS_TOKEN = "discogs-test-token-0123456789";
    process.env.GENIUS_ACCESS_TOKEN = "genius-test-token-0123456789";
    // A release shaped like the Discogs API's, with placeholder credits, holding the track.
    const release = {
      id: 599648,
      title: "To the Extreme",
      year: 1990,
      artists: [{ id: 1, name: "Vanilla Ice", anv: "", join: "" }],
      extraartists: [{ id: 2, name: "Test Engineer", anv: "", role: "Engineer", tracks: "1" }],
      tracklist: [{ position: "1", type_: "track", title: "Ice Ice Baby", duration: "4:31" }],
    };
    // The live answers carry fields the pipeline does not read; the cassettes must not.
    const extra = {
      ...iceReleases,
      releases: iceReleases.releases.map((r) => ({
        ...r,
        "cover-art-archive": { front: true },
        barcode: "077779532520",
      })),
    };
    const route: FetchRoute = (call) => {
      if (call.url.startsWith(`${MB}/release?`)) return json(extra);
      if (call.url === "https://api.discogs.com/releases/599648") {
        return json({
          ...release,
          notes: "Sleeve notes.",
          images: [{ uri: "https://i.discogs.com/a.jpg" }],
        });
      }
      if (call.url.startsWith("https://api.genius.com/search?")) return json(geniusSearch);
      if (call.url === "https://api.genius.com/songs/9000001") {
        const song = { ...geniusSong.response.song, description: { plain: "About the song." } };
        return json({ ...geniusSong, response: { song } });
      }
      return withShs(call);
    };
    const run = await recordThenReplay(route, () => collectPrimarySources(ICE_TRACK, { now }));

    expect(run.replayCalls).toBe(0);
    expect(run.replayed).toEqual(run.live);
    for (const source of ["musicbrainz", "discogs", "genius", "secondhandsongs"] as const) {
      expect(run.live[source].status, source).toBe("found");
    }
    expectValidEvidence(run.live.evidence);
    expect(Object.keys(run.cassettes).sort()).toEqual([
      "discogs",
      "genius",
      "musicbrainz",
      "secondhandsongs",
    ]);
    const all = Object.values(run.cassettes).join("\n");
    for (const unread of [
      "cover-art-archive",
      "077779532520",
      "Sleeve notes",
      "a.jpg",
      "About the song",
    ]) {
      expect(all).not.toContain(unread);
    }
    expect(all).not.toContain("test-token");
    expect(run.cassettes.musicbrainz).toContain(ICE);
  });
});
