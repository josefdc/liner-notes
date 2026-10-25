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
import iceWorkRecordings1 from "./fixtures/musicbrainz-work-recordings-ice-ice-baby-1.json" with {
  type: "json",
};
import iceWorkRecordings2 from "./fixtures/musicbrainz-work-recordings-ice-ice-baby-2.json" with {
  type: "json",
};
import geniusSearch from "./fixtures/genius-search-ice-ice-baby.json" with { type: "json" };
import geniusSong from "./fixtures/genius-song-ice-ice-baby.json" with { type: "json" };
import shsWork from "./fixtures/shs-work-ice-ice-baby.json" with { type: "json" };
import hallelujahDetails from "./fixtures/musicbrainz-recording-details-hallelujah-live.json" with {
  type: "json",
};
import hallelujahIsrc from "./fixtures/musicbrainz-isrc-hallelujah-live.json" with { type: "json" };
import loveStoryTvDetails from "./fixtures/musicbrainz-recording-details-love-story-taylors-version.json" with {
  type: "json",
};
import loveStoryTvIsrc from "./fixtures/musicbrainz-isrc-love-story-taylors-version.json" with {
  type: "json",
};
import loveStoryWork from "./fixtures/musicbrainz-work-love-story.json" with { type: "json" };
import loveStoryWorkRecordings from "./fixtures/musicbrainz-work-recordings-love-story.json" with {
  type: "json",
};
import { type FetchCall, type FetchRoute, json, stubFetch } from "./testing/fetchStub.js";
import { recordThenReplay } from "./testing/roundTrip.js";
import {
  collectPrimarySources,
  discogsCandidates,
  musicBrainzRelationships,
  originalPerformance,
  pickRecording,
  primarySourcesTool,
  resolveIdentity,
} from "./identity.js";
import {
  lookupIsrc,
  type MbRecordingDetails,
  type MbRecordingSummary,
  MusicBrainzRateLimiter,
} from "./musicbrainz.js";
import { never } from "./testing/fetchStub.js";
import { evidenceScope, type TrackRef } from "./records.js";

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
  if (call.url.startsWith(`${MB}/recording?work=${ICE_WORK}&`)) {
    const offset = new URL(call.url).searchParams.get("offset");
    return json(offset === "0" ? iceWorkRecordings1 : iceWorkRecordings2);
  }
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

  it("without a duration to compare, takes the only one with no disambiguation comment", () => {
    const twin = (id: string, disambiguation: string) => ({
      id,
      title: "Ice Ice Baby",
      length: null,
      disambiguation,
      "artist-credit": [{ name: "Vanilla Ice", artist: { id: "x", name: "Vanilla Ice" } }],
    });
    const edit = twin("00000000-0000-4000-8000-000000000004", "radio edit");
    const plain = twin("00000000-0000-4000-8000-000000000005", "");
    const pick = pickRecording({ ...ICE_TRACK, durationMs: null }, [edit, plain]);
    expect(pick.recording?.id).toBe(plain.id);
    expect(pick.omitted).toEqual([
      { ref: `recording/${edit.id}`, reason: `recording/${plain.id} is the closer match` },
    ]);
  });
});

describe("discogsCandidates on the recording's releases", () => {
  it("lists original releases only, earliest dated release first", () => {
    const ids = discogsCandidates(iceReleases.releases);
    // 1990-09-04, then 1990-12-03, then the releases dated only "1990".
    expect(ids.slice(0, 2)).toEqual([599648, 687927]);
    // The compilation is not an original release; a soundtrack can be, and sorts by its date
    // (2004, after the 1990 albums).
    expect(ids).not.toContain(759973);
    expect(ids).toContain(711787);
    expect(ids.indexOf(739983)).toBeGreaterThan(ids.indexOf(711787));
  });
});

describe("resolveIdentity", () => {
  it("reaches the recording and the Genius, SecondHandSongs and Discogs links", async () => {
    process.env.DISCOGS_TOKEN = "discogs-test-token";
    const net = stubFetch(musicBrainz);
    const told: unknown[] = [];
    // The requests made when the recording is told: only the ISRC lookup and the recording's.
    let madeWhenTold: string[] = [];
    const { identity, result } = await resolveIdentity(ICE_TRACK, {
      onRecording: (recording) => {
        told.push(recording);
        madeWhenTold = net.calls.map((c) => new URL(c.url).pathname);
      },
    });
    expect(madeWhenTold).toEqual(["/ws/2/isrc/USCA29001716", `/ws/2/recording/${ICE}`]);
    // The recording is told once, as soon as its lookup passed the checks.
    expect(told).toEqual([
      {
        mbid: ICE,
        title: "Ice Ice Baby",
        artist: "Vanilla Ice",
        lengthMs: 271_000,
        firstReleaseDate: "1990-09-04",
        artists: [
          {
            mbid: "2d5583be-aafd-41ec-addd-df85913855ef",
            name: "Vanilla Ice",
            credited: "Vanilla Ice",
          },
        ],
      },
    ]);
    expect(identity).toMatchObject({
      isrc: "USCA29001716",
      recording: { mbid: ICE, title: "Ice Ice Baby", artist: "Vanilla Ice", lengthMs: 271_000 },
      works: [{ mbid: ICE_WORK, title: "Ice Ice Baby", cover: false }],
      geniusUrl: "https://genius.com/Vanilla-ice-ice-ice-baby-lyrics",
      shsLinks: [{ kind: "work", id: 4196 }],
      releasesError: null,
      // 1990-09-04 is the earliest date MusicBrainz has, but 9 recordings of the work under its
      // title are undated (and 10 are dated only "1990"): it cannot be shown to be the original
      // recording. Undated remix and edit titles do not count.
      original: {
        original: false,
        reason:
          '9 recordings of "Ice Ice Baby" have no release date: this one cannot be shown to be the earliest',
      },
    });
    expect(identity?.discogsReleaseIds[0]).toBe(599648);
    expect(result.identity).toEqual({ matched: 1, rejected: 4, missing: 0, unavailable: 0 });
    expect(net.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/ws/2/isrc/USCA29001716",
      `/ws/2/recording/${ICE}`,
      "/ws/2/release",
      `/ws/2/work/${ICE_WORK}`,
      // The work's 117 recordings, in two pages, to date them.
      "/ws/2/recording",
      "/ws/2/recording",
    ]);
  });

  it("reads no release without a Discogs token: only Discogs reads their links", async () => {
    const net = stubFetch(musicBrainz);
    const { identity } = await resolveIdentity(ICE_TRACK);
    expect(identity).toMatchObject({ discogsReleaseIds: [], releasesError: null });
    expect(net.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/ws/2/isrc/USCA29001716",
      `/ws/2/recording/${ICE}`,
      `/ws/2/work/${ICE_WORK}`,
      "/ws/2/recording",
      "/ws/2/recording",
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
      about: "track",
      evidenceId: `musicbrainz:track/recording/${ICE}/samples/recording/${UNDER_PRESSURE}`,
      recording: {
        mbid: UNDER_PRESSURE,
        title: "Under Pressure",
        artist: "Queen & David Bowie",
        lengthMs: 243_000,
      },
      work: null,
      attributes: [],
    });
    const covers = result.records.filter((r) => r.kind === "covered-by");
    expect(covers).toHaveLength(6);
    // Not shown to be the original recording: the covers are the work's, not claimed for it.
    expect(covers.every((c) => c.about === "work")).toBe(true);
    expect(result.incomplete).toBe(
      'covers are of the work "Ice Ice Baby", not this recording: 9 recordings of "Ice Ice Baby" have no release date: this one cannot be shown to be the earliest',
    );
    // Each record names its Evidence item, whose recordRef carries the record's scope.
    for (const record of result.records) {
      const item = result.evidence.find((e) => e.id === record.evidenceId);
      expect(item && evidenceScope(item)).toBe(record.about);
    }
    expectValidEvidence(result.evidence);
    expect(result.evidence).toContainEqual(
      expect.objectContaining({
        url: `https://musicbrainz.org/work/${ICE_WORK}`,
        excerpt:
          'MusicBrainz: the work "Ice Ice Baby" is covered by "Ice Ice Baby" by Faith No More.',
      }),
    );
    expect(result.evidence[0]).toMatchObject({
      id: `musicbrainz:track/recording/${ICE}`,
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
      musicbrainz: { matched: 1, rejected: 4, missing: 0, unavailable: 0 },
      // Not configured: not asked, so not part of identity accuracy.
      discogs: { matched: 0, rejected: 0, missing: 0, unavailable: 1 },
      genius: { matched: 0, rejected: 0, missing: 0, unavailable: 1 },
      secondhandsongs: { matched: 1, rejected: 0, missing: 0, unavailable: 0 },
    });
  });

  it("tells the identified recording once, and null when MusicBrainz identifies none", async () => {
    stubFetch(withShs);
    const told: Array<{ mbid: string } | null> = [];
    await collectPrimarySources(ICE_TRACK, { now, onRecording: (r) => told.push(r) });
    expect(told.map((r) => r?.mbid)).toEqual([ICE]);

    stubFetch(() => new Response("bad gateway", { status: 502 }));
    const none: unknown[] = [];
    await collectPrimarySources(ICE_TRACK, { now, onRecording: (r) => none.push(r) });
    expect(none).toEqual([null]);
  });

  it("is served ahead of MusicBrainz requests made outside it, queued first", async () => {
    const restore = MusicBrainzRateLimiter.getInstance().setIntervalForTests(30);
    try {
      const OTHER = ["GBUM71106916", "USUM72401994"];
      const net = stubFetch((call) =>
        OTHER.some((isrc) => call.url.includes(`/isrc/${isrc}`))
          ? json({ recordings: [] })
          : withShs(call),
      );
      // A request just made: the next ones wait their turn.
      await lookupIsrc(OTHER[0]);
      net.calls.length = 0;
      // A researcher's two requests are queued first; then the chain starts.
      const research = Promise.all(OTHER.map((isrc) => lookupIsrc(isrc)));
      const chain = collectPrimarySources(ICE_TRACK, { now });
      await Promise.all([research, chain]);

      const mb = net.calls.filter((c) => c.url.startsWith(MB)).map((c) => c.url);
      const firstOther = mb.findIndex((url) => OTHER.some((isrc) => url.includes(isrc)));
      // Every MusicBrainz request of the chain (lookup, recording, work, dating) came first.
      expect(firstOther).toBe(mb.length - 2);
      expect(mb.slice(0, firstOther).every((url) => !OTHER.some((i) => url.includes(i)))).toBe(
        true,
      );
      expect(firstOther).toBeGreaterThanOrEqual(4);
    } finally {
      restore();
    }
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
    // MusicBrainz failed: the others could not be asked, which is not an identity miss.
    expect(sources.secondhandsongs).toMatchObject({
      status: "missing",
      reason: "MusicBrainz could not be read, so the track has no identity",
      error: { source: "secondhandsongs", code: "unavailable" },
      identity: { missing: 0, unavailable: 1 },
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

describe("work-level relationships are claimed only for the work's original recording", () => {
  const LOVE_STORY_WORK = "c8975007-ba64-3e81-9a3c-69a3ba2fab95";
  const LOVE_STORY_TV = "93484aa2-0ce6-4356-9ff4-9db61e07acd5";
  /** "Love Story (Taylor's Version)" (2021), from captures of USUG12100342. */
  const LOVE_STORY_TRACK: TrackRef = {
    isrc: "USUG12100342",
    title: "Love Story (Taylor’s Version)",
    artists: ["Taylor Swift"],
    durationMs: 235_766,
  };
  const loveStory: FetchRoute = (call) => {
    if (call.url.startsWith(`${MB}/isrc/USUG12100342?`)) return json(loveStoryTvIsrc);
    if (call.url.startsWith(`${MB}/recording/${LOVE_STORY_TV}?`)) return json(loveStoryTvDetails);
    if (call.url.startsWith(`${MB}/release?`)) return json({ "release-count": 0, releases: [] });
    if (call.url.startsWith(`${MB}/work/${LOVE_STORY_WORK}?`)) return json(loveStoryWork);
    return undefined;
  };

  it("states the covers of the 2008 song as covers of the work, not of the 2021 re-recording", async () => {
    const net = stubFetch(loveStory);
    const resolution = await resolveIdentity(LOVE_STORY_TRACK);
    expect(resolution.identity?.original).toEqual({
      original: false,
      reason: 'titled "Love Story (Taylor’s version)", a version of "Love Story"',
    });
    // Ruled out by its title: the work's recordings are not dated.
    expect(net.calls.some((c) => c.url.includes("/recording?work="))).toBe(false);

    const result = await musicBrainzRelationships(resolution, { now });
    if (result.status !== "found") throw new Error(result.reason);
    const covers = result.records.filter((r) => r.kind === "covered-by");
    expect(covers.map((c) => c.recording?.artist)).toEqual(
      expect.arrayContaining(["Kidz Bop", "Forever the Sickest Kids"]),
    );
    expect(covers.every((c) => c.about === "work")).toBe(true);
    expect(result.incomplete).toContain('covers are of the work "Love Story", not this recording');
    // One remix and 31 covers: 25 listed, the rest counted.
    expect(result.records).toHaveLength(25);
    expect(result.incomplete).toMatch(/; 7 more not listed$/);
    const coverEvidence = result.evidence.filter((e) => e.excerpt.includes("covered by"));
    expect(coverEvidence.length).toBeGreaterThan(0);
    for (const e of coverEvidence) {
      expect(e.url).toBe(`https://musicbrainz.org/work/${LOVE_STORY_WORK}`);
      expect(e.excerpt).toMatch(/^MusicBrainz: the work "Love Story" is covered by /);
    }
    expectValidEvidence(result.evidence);
  });

  /** All 96 recordings of the work, with their first release dates. */
  const dated = {
    recordings: loveStoryWorkRecordings.recordings as MbRecordingSummary[],
    total: loveStoryWorkRecordings["recording-count"],
  };

  const studio = (overrides: Partial<MbRecordingDetails>, attributes: string[] = []) => ({
    details: {
      id: "6fef4fc3-4680-418c-9767-fae7173304ec",
      title: "Love Story",
      "first-release-date": "2009",
      disambiguation: "",
      "artist-credit": [{ name: "Taylor Swift", artist: { id: "x", name: "Taylor Swift" } }],
      ...overrides,
    },
    works: [{ mbid: LOVE_STORY_WORK, title: "Love Story", cover: false, attributes }],
  });

  it("does not take a live recording with the song's title and artist for the original", () => {
    // 810fed01: "Love Story" by Taylor Swift, filed live in the work's recordings.
    const live = studio(
      {
        id: "810fed01-8633-4046-8805-b6ca27b33705",
        disambiguation: "live, 2008-06-28: Clear Channel Stripped, USA",
      },
      ["live"],
    );
    expect(originalPerformance(live.details, live.works, dated)).toEqual({
      original: false,
      reason: 'a live performance of "Love Story"',
    });
    const unattributed = studio({ disambiguation: "live, 2008-06-28" });
    expect(originalPerformance(unattributed.details, unattributed.works, dated)).toEqual({
      original: false,
      reason: 'filed as "live, 2008-06-28"',
    });
  });

  it("does not take a later recording of the same title and artist for the original", () => {
    const later = studio({});
    const check = originalPerformance(later.details, later.works, dated);
    expect(check.original).toBe(false);
    expect(check.reason).toMatch(
      /by Taylor Swift was released in 2008(-\d\d-\d\d)?, before this recording \(2009\)$/,
    );
  });

  it("says yes only when every other recording of the work is certainly later", () => {
    // Synthetic: the recording (2008-11-11) among the work's recordings, two later ones and a
    // later cover.
    const own = studio({ "first-release-date": "2008-11-11" });
    const recording = (id: string, date: string, title = "Love Story") => ({
      id: `00000000-0000-4000-8000-00000000000${id}`,
      title,
      "first-release-date": date,
      "artist-credit": [{ name: "Taylor Swift", artist: { id: "x", name: "Taylor Swift" } }],
    });
    const self = { ...recording("0", "2008-11-11"), id: own.details.id };
    const laterCover = recording("8", "2012");
    const earlierCover = recording("9", "2001");
    const undatedCover = recording("a", "");
    const covers = new Set([laterCover.id, earlierCover.id, undatedCover.id]);
    const others = [self, recording("1", "2008-12"), recording("2", "2010-05-01"), laterCover];
    const verdict = (recordings: MbRecordingSummary[], total = recordings.length) =>
      originalPerformance(own.details, own.works, { recordings, total }, covers);

    expect(verdict(others)).toEqual({
      original: true,
      reason: 'the earliest release of "Love Story" (2008-11-11)',
    });
    // Not candidates: an undated cover, and an undated version titled otherwise.
    expect(
      verdict([...others, undatedCover, recording("b", "", "Love Story (Remix)")]),
    ).toMatchObject({ original: true });
    // A cover certainly released earlier: the song existed before this recording.
    expect(verdict([...others, earlierCover])).toEqual({
      original: false,
      reason:
        'a cover of "Love Story" ("Love Story" by Taylor Swift) was released in 2001, before this recording (2008-11-11)',
    });
    // Unknown answers no: an undated recording under the work's title, one dated only by the
    // same year or month, one earlier in the same year, and a work not fully read.
    expect(verdict([...others, recording("3", "")]).reason).toBe(
      '1 recordings of "Love Story" have no release date: this one cannot be shown to be the earliest',
    );
    expect(verdict([...others, recording("4", "2008")]).reason).toBe(
      '1 recordings of "Love Story" are dated like this one (2008-11-11) as far as the dates go: the earliest cannot be told',
    );
    expect(verdict([...others, recording("5", "2008-11")]).original).toBe(false);
    expect(verdict([...others, recording("6", "2008-11-11")]).original).toBe(false);
    expect(verdict([...others, recording("7", "2008-11-01")]).reason).toBe(
      '"Love Story" by Taylor Swift was released in 2008-11-01, before this recording (2008-11-11)',
    );
    expect(verdict(others, 96)).toEqual({
      original: false,
      reason: 'only 4 of the 96 recordings of "Love Story" could be compared',
    });
    // An answer that does not list the recording itself (empty or inconsistent) answers no.
    expect(verdict([])).toEqual({
      original: false,
      reason: 'the recordings read for "Love Story" do not include this one',
    });
    expect(verdict(others.slice(1)).original).toBe(false);
    // Without the cover set, the 2012 cover is just a later recording: still yes.
    expect(
      originalPerformance(own.details, own.works, { recordings: others, total: 4 }).original,
    ).toBe(true);
    expect(originalPerformance(own.details, own.works, null).original).toBe(false);
    expect(
      originalPerformance({ ...own.details, "first-release-date": "" }, own.works, {
        recordings: others,
        total: 4,
      }).original,
    ).toBe(false);
  });

  it("does not claim the song's covers or samples for a live version of the original", async () => {
    process.env.GENIUS_ACCESS_TOKEN = "genius-test-token-0123456789";
    const live = {
      ...iceDetails,
      disambiguation: "live, 1991",
      relations: iceDetails.relations.map((r) =>
        r.type === "performance" ? { ...r, attributes: ["live"] } : r,
      ),
    };
    stubFetch((call) => {
      if (call.url.startsWith(`${MB}/recording/${ICE}?`)) return json(live);
      if (call.url.startsWith("https://api.genius.com/search?")) return json(geniusSearch);
      if (call.url === "https://api.genius.com/songs/9000001") return json(geniusSong);
      return withShs(call);
    });
    const sources = await collectPrimarySources(ICE_TRACK, { now });
    expect(sources.identity?.original).toEqual({
      original: false,
      reason: 'a live performance of "Ice Ice Baby"',
    });
    const songLevel = [
      ...(sources.musicbrainz.status === "found"
        ? sources.musicbrainz.records.filter((r) => r.kind === "covered-by")
        : []),
      ...(sources.genius.status === "found" ? sources.genius.records : []),
      ...(sources.secondhandsongs.status === "found" ? sources.secondhandsongs.records : []),
    ];
    expect(songLevel.length).toBeGreaterThan(0);
    expect(songLevel.every((r) => r.about === "work")).toBe(true);
    // The recording's own relationships still belong to it.
    expect(
      sources.musicbrainz.status === "found" &&
        sources.musicbrainz.records.find((r) => r.kind === "samples")?.about,
    ).toBe("track");
  });
});

describe("one relationship filed twice is read once", () => {
  it("dedupes the two performances of Hallelujah in Jeff Buckley's live recording", async () => {
    // USSM10902080: one work, related twice (1995-01-31 and 1995-01).
    const net = stubFetch((call) => {
      if (call.url.startsWith(`${MB}/isrc/USSM10902080?`)) return json(hallelujahIsrc);
      if (call.url.startsWith(`${MB}/recording/f3abe296-2541-4d42-a3ad-cb8615cbc886?`)) {
        return json(hallelujahDetails);
      }
      if (call.url.startsWith(`${MB}/release?`)) return json({ "release-count": 0, releases: [] });
      return undefined;
    });
    const sources = await collectPrimarySources(
      { isrc: "USSM10902080", title: "Hallelujah", artists: ["Jeff Buckley"], durationMs: 455_506 },
      { now },
    );
    expect(sources.identity?.works).toEqual([
      {
        mbid: "9d0296b2-e2d6-3aaa-8e38-7f15d38ed906",
        title: "Hallelujah",
        cover: true,
        attributes: ["cover", "live"],
      },
    ]);
    if (sources.musicbrainz.status !== "found") throw new Error(sources.musicbrainz.reason);
    expect(sources.musicbrainz.records.filter((r) => r.kind === "cover-of")).toHaveLength(1);
    const ids = sources.evidence.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    // A cover's work is not read for covers of its own.
    expect(net.calls.some((c) => c.url.includes("/ws/2/work/"))).toBe(false);
  });
});

describe("robustness", () => {
  it("keeps the other sources when one answer is malformed", async () => {
    // A relation list with a hole and a credit that is not a list.
    const malformed = {
      ...iceDetails,
      relations: [
        ...iceDetails.relations.map((r) =>
          r.type === "samples material" && r.recording
            ? { ...r, recording: { ...r.recording, "artist-credit": { name: "Queen" } } }
            : r,
        ),
        null,
      ],
    };
    stubFetch((call) =>
      call.url.startsWith(`${MB}/recording/${ICE}?`) ? json(malformed) : withShs(call),
    );
    const sources = await collectPrimarySources(ICE_TRACK, { now });
    // The reader fails on it past its shape checks: an internal error, reported as such.
    expect(sources.musicbrainz).toMatchObject({
      status: "missing",
      error: { source: "musicbrainz", code: "unavailable" },
    });
    expect(sources.musicbrainz.error?.message).toMatch(/^internal error: /);
    expect(sources.secondhandsongs.status).toBe("found");
  });

  it("stops at the deadline: whatever has not answered is missing (timeout)", async () => {
    stubFetch(never);
    const started = Date.now();
    const sources = await collectPrimarySources(ICE_TRACK, { now, deadlineMs: 100 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(sources.musicbrainz).toMatchObject({
      status: "missing",
      error: { code: "timeout" },
    });
    const controller = new AbortController();
    const pending = collectPrimarySources(ICE_TRACK, { now, signal: controller.signal });
    controller.abort();
    // Cancelled by the caller: unavailable, not a timeout.
    expect((await pending).musicbrainz).toMatchObject({ error: { code: "unavailable" } });
  });

  it("reports the Discogs source missing when the recording's releases cannot be read", async () => {
    process.env.DISCOGS_TOKEN = "discogs-test-token-0123456789";
    const net = stubFetch((call) =>
      call.url.startsWith(`${MB}/release?`)
        ? json({ error: "boom" }, { status: 500 })
        : withShs(call),
    );
    const sources = await collectPrimarySources(ICE_TRACK, { now });
    expect(sources.discogs).toMatchObject({ status: "missing" });
    expect(sources.discogs.status === "missing" && sources.discogs.reason).toMatch(
      /^MusicBrainz releases could not be read: musicbrainz: HTTP 500/,
    );
    expect(net.calls.some((c) => c.url.startsWith("https://api.discogs.com/"))).toBe(false);
  });

  it("says when not every release of the recording was read", async () => {
    process.env.DISCOGS_TOKEN = "discogs-test-token-0123456789";
    const release = {
      id: 599648,
      title: "To the Extreme",
      artists: [{ id: 1, name: "Vanilla Ice" }],
      extraartists: [{ id: 2, name: "Test Engineer", role: "Engineer", tracks: "" }],
      tracklist: [{ position: "1", type_: "track", title: "Ice Ice Baby", duration: "4:31" }],
    };
    stubFetch((call) => {
      if (call.url.startsWith(`${MB}/release?`)) {
        return json({ ...iceReleases, "release-count": 250 });
      }
      if (call.url.startsWith("https://api.discogs.com/")) return json(release);
      return withShs(call);
    });
    const sources = await collectPrimarySources(ICE_TRACK, { now });
    expect(sources.discogs.status === "found" && sources.discogs.incomplete).toBe(
      "only 13 of the recording's 250 releases were read for Discogs links",
    );
  });
});

describe("deadlines, cancellation and inputs", () => {
  it("returns at the deadline even behind a full MusicBrainz queue", async () => {
    const limiter = MusicBrainzRateLimiter.getInstance();
    const restore = limiter.setIntervalForTests(300);
    try {
      stubFetch((call) =>
        call.url.includes("USUM72401994") ? json({ recordings: [] }) : musicBrainz(call),
      );
      // Another run already has eight requests queued: about 2.4 s of waiting.
      const others = Array.from({ length: 8 }, () => lookupIsrc("USUM72401994").catch(() => null));
      const started = Date.now();
      const sources = await collectPrimarySources(ICE_TRACK, { now, deadlineMs: 100 });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(sources.musicbrainz).toMatchObject({ status: "missing", error: { code: "timeout" } });
      await Promise.all(others);
    } finally {
      restore();
    }
  });

  it("records a deadline reached while reading releases as the Discogs source's timeout", async () => {
    process.env.DISCOGS_TOKEN = "discogs-test-token-0123456789";
    stubFetch((call) => (call.url.startsWith(`${MB}/release?`) ? never(call) : musicBrainz(call)));
    const sources = await collectPrimarySources(ICE_TRACK, { now, deadlineMs: 200 });
    expect(sources.discogs).toMatchObject({
      status: "missing",
      error: { source: "discogs", code: "timeout" },
    });
  });

  it("stops its requests when the agent's call is cancelled", async () => {
    const net = stubFetch(never);
    const controller = new AbortController();
    const call = primarySourcesTool.invoke(
      { isrc: ICE_TRACK.isrc, title: ICE_TRACK.title, artists: ICE_TRACK.artists },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(net.calls).toHaveLength(1));
    controller.abort();
    await expect(call).rejects.toThrow();
    // The cancellation reached the request itself, not only the tool call.
    await vi.waitFor(() => expect(net.calls[0].signal?.aborted).toBe(true));
  });

  it("refuses a duration that is not positive, and survives bad inputs", async () => {
    await expect(
      primarySourcesTool.invoke({
        isrc: "USCA29001716",
        title: "x",
        artists: ["y"],
        durationMs: 0,
      }),
    ).rejects.toThrow();
    const net = stubFetch(() => undefined);
    const noIsrc = await collectPrimarySources({ ...ICE_TRACK, isrc: undefined as never }, { now });
    expect(noIsrc.musicbrainz).toMatchObject({ reason: "the track has no valid ISRC" });
    for (const deadlineMs of [Number.NaN, -1, 0, 1e12]) {
      await expect(
        collectPrimarySources({ ...ICE_TRACK, isrc: "bad" }, { now, deadlineMs }),
      ).resolves.toMatchObject({ identity: null });
    }
    expect(net.calls).toHaveLength(0);
  });

  it("does not use a duration of 0 to break a tie", () => {
    const pick = pickRecording({ ...ICE_TRACK, durationMs: 0 }, iceIsrc.recordings as never);
    // The album version (no disambiguation), not the radio edit 226.7 s nearer to 0.
    expect(pick.recording?.id).toBe(ICE);
  });
});

describe("evidence scope", () => {
  it("never scopes a fact about the song to a recording that is not its original", async () => {
    process.env.GENIUS_ACCESS_TOKEN = "genius-test-token-0123456789";
    stubFetch((call) => {
      if (call.url.startsWith("https://api.genius.com/search?")) return json(geniusSearch);
      if (call.url === "https://api.genius.com/songs/9000001") return json(geniusSong);
      return withShs(call);
    });
    const sources = await collectPrimarySources(ICE_TRACK, { now });
    expect(sources.identity?.original.original).toBe(false);
    const records = [
      ...(sources.musicbrainz.status === "found" ? sources.musicbrainz.records : []),
      ...(sources.genius.status === "found" ? sources.genius.records : []),
      ...(sources.secondhandsongs.status === "found" ? sources.secondhandsongs.records : []),
    ];
    const byId = new Map(sources.evidence.map((e) => [e.id, e]));
    const songLevel = records.filter((r) => r.about === "work");
    expect(songLevel.length).toBeGreaterThan(0);
    for (const record of records) {
      const item = byId.get(record.evidenceId);
      expect(item, record.evidenceId).toBeDefined();
      expect(item && evidenceScope(item)).toBe(record.about);
    }
    // The only track-scoped items are the recording itself and its own relationships.
    const trackScoped = sources.evidence.filter((e) => evidenceScope(e) === "track");
    expect(trackScoped.map((e) => e.excerpt).join("\n")).not.toMatch(/the song|the work/);
  });
});

describe("links MusicBrainz files more than once", () => {
  it("merges two performances of one work, so a live one rules the recording out", async () => {
    const performance = iceDetails.relations.find((r) => r.type === "performance");
    const twice = {
      ...iceDetails,
      relations: [...iceDetails.relations, { ...performance, attributes: ["live"] }],
    };
    stubFetch((call) =>
      call.url.startsWith(`${MB}/recording/${ICE}?`) ? json(twice) : musicBrainz(call),
    );
    const { identity } = await resolveIdentity(ICE_TRACK);
    expect(identity?.works).toHaveLength(1);
    expect(identity?.works[0].attributes).toEqual(["live"]);
    expect(identity?.original).toEqual({
      original: false,
      reason: 'a live performance of "Ice Ice Baby"',
    });
  });

  it("takes no Genius page when the works link several", async () => {
    process.env.GENIUS_ACCESS_TOKEN = "genius-test-token-0123456789";
    const relations = iceDetails.relations.map((r) =>
      r.type === "performance" && r.work
        ? {
            ...r,
            work: {
              ...r.work,
              relations: [
                ...r.work.relations,
                {
                  type: "lyrics",
                  direction: "backward",
                  "target-type": "url",
                  url: { resource: "https://genius.com/Vanilla-ice-ice-ice-baby-remix-lyrics" },
                },
              ],
            },
          }
        : r,
    );
    const net = stubFetch((call) =>
      call.url.startsWith(`${MB}/recording/${ICE}?`)
        ? json({ ...iceDetails, relations })
        : withShs(call),
    );
    const sources = await collectPrimarySources(ICE_TRACK, { now });
    expect(sources.identity?.geniusUrl).toBeNull();
    expect(sources.genius).toMatchObject({
      status: "missing",
      reason: "MusicBrainz links 2 Genius pages to the recording's works; none is taken",
    });
    expect(net.calls.some((c) => c.url.includes("genius.com"))).toBe(false);
  });
});

describe("what the tool output carries", () => {
  it("keeps a failed release browse as a short error record, never the raw answer", async () => {
    process.env.DISCOGS_TOKEN = "discogs-test-token-0123456789";
    const page = `<html><body>${"502 Bad Gateway upstream nginx ".repeat(300)}</body></html>`;
    stubFetch((call) =>
      call.url.startsWith(`${MB}/release?`)
        ? new Response(page, { status: 502, headers: { "content-type": "text/html" } })
        : musicBrainz(call),
    );
    const out = await primarySourcesTool.invoke({
      isrc: ICE_TRACK.isrc,
      title: ICE_TRACK.title,
      artists: ICE_TRACK.artists,
      durationMs: ICE_TRACK.durationMs,
    });
    const parsed = JSON.parse(out);
    expect(Object.keys(parsed.identity.releasesFailure).sort()).toEqual([
      "code",
      "message",
      "source",
    ]);
    expect(parsed.identity.releasesFailure.message.length).toBeLessThan(300);
    // The 9 KB page is not carried: only the short error detail is.
    expect(out).not.toContain('"body"');
    expect(out.split("Bad Gateway").length - 1).toBeLessThan(40);
    expect(parsed.discogs).toMatchObject({ error: { source: "discogs", code: "unavailable" } });
  });

  it("says where each SecondHandSongs link came from", async () => {
    const withRecordingLink = {
      ...iceDetails,
      relations: [
        ...iceDetails.relations,
        {
          type: "secondhandsongs",
          direction: "forward",
          "target-type": "url",
          url: { resource: "https://secondhandsongs.com/performance/9200001" },
        },
      ],
    };
    stubFetch((call) =>
      call.url.startsWith(`${MB}/recording/${ICE}?`) ? json(withRecordingLink) : musicBrainz(call),
    );
    const { identity } = await resolveIdentity(ICE_TRACK);
    expect(identity?.shsLinks).toHaveLength(2);
    expect(identity?.shsLinks).toEqual(
      expect.arrayContaining([
        { kind: "performance", id: 9200001, from: "recording" },
        { kind: "work", id: 4196, from: "work" },
      ]),
    );
  });
});
