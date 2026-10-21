/**
 * Discogs release credits, against a stubbed API. fixtures/discogs-release-249504.json is the
 * release the Discogs API documentation uses as its example, cut to the fields read; the other
 * releases here are built inline in the same shape.
 */

import { Evidence as EvidenceSchema, evidenceIssues } from "@liner-notes/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import rickRoll from "./fixtures/discogs-release-249504.json" with { type: "json" };
import {
  creditCovers,
  type DiscogsRelease,
  discogsReleaseId,
  discogsTrackCredits,
  findTrack,
  splitRoles,
  trackCredits,
} from "./discogs.js";
import type { TrackRef } from "./records.js";
import { json, stubFetch } from "./testing/fetchStub.js";
import { recordThenReplay } from "./testing/roundTrip.js";

const TOKEN = "discogs-test-token-0123456789";
const now = () => new Date("2026-10-20T12:00:00.000Z");

const TRACK: TrackRef = {
  isrc: "GBARL9300135",
  title: "Never Gonna Give You Up",
  artists: ["Rick Astley"],
  durationMs: 213_573,
};

beforeEach(() => {
  delete process.env.SOURCE_CASSETTE;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.DISCOGS_TOKEN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("without DISCOGS_TOKEN", () => {
  it("is missing, requests nothing and does not throw", async () => {
    delete process.env.DISCOGS_TOKEN;
    const net = stubFetch(() => json(rickRoll));
    const result = await discogsTrackCredits(TRACK, [249504]);
    expect(result).toMatchObject({
      status: "missing",
      reason: "DISCOGS_TOKEN is not set",
      error: { source: "discogs", code: "not_configured" },
      identity: { matched: 0, rejected: 0, missing: 1 },
    });
    expect(net.calls).toHaveLength(0);
  });
});

describe("with DISCOGS_TOKEN", () => {
  beforeEach(() => {
    process.env.DISCOGS_TOKEN = TOKEN;
  });

  it("sends the token in the Authorization header, never in the URL", async () => {
    const net = stubFetch(() => json(rickRoll));
    await discogsTrackCredits(TRACK, [249504], { now });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].url).toBe("https://api.discogs.com/releases/249504");
    expect(net.calls[0].headers.authorization).toBe(`Discogs token=${TOKEN}`);
    expect(net.calls[0].headers["user-agent"]).toMatch(/^LinerNotes\//);
  });

  it("finds the track on the release and yields its credits as primary-record Evidence", async () => {
    stubFetch(() => json(rickRoll));
    const result = await discogsTrackCredits(TRACK, [249504], { now });
    if (result.status !== "found") throw new Error(result.reason);
    expect(result.records).toEqual([
      expect.objectContaining({ name: "Me Company", roles: ["Design"], scope: "release" }),
      expect.objectContaining({
        name: "Stock / Aitken / Waterman",
        artistId: 20942,
        roles: ["Producer", "Written-By"],
        scope: "release",
        position: "A",
      }),
    ]);
    expect(result.identity).toEqual({ matched: 1, rejected: 0, missing: 0 });
    for (const item of result.evidence) {
      expect(evidenceIssues(EvidenceSchema.parse(item))).toEqual([]);
      expect(item).toMatchObject({
        source: "discogs",
        sourceTier: "primary-record",
        url: "https://www.discogs.com/release/249504",
        retrievedAt: "2026-10-20T12:00:00.000Z",
      });
    }
    expect(result.evidence[1].excerpt).toBe(
      'Discogs release 249504 ("Never Gonna Give You Up", 1987) credits Stock / Aitken / ' +
        'Waterman as Producer, Written-By on the whole release (which includes "Never Gonna Give You Up").',
    );
  });

  it("omits a release whose track is more than 5 s off the printed duration", async () => {
    stubFetch(() => json(rickRoll));
    const result = await discogsTrackCredits({ ...TRACK, durationMs: 219_000 }, [249504]);
    expect(result).toMatchObject({ status: "missing", identity: { rejected: 1 } });
    expect(result.omitted[0].reason).toMatch(/^duration 212\.0 s is more than 5\.0 s/);
    expect("evidence" in result).toBe(false);
  });

  it("omits a release credited to other artists", async () => {
    stubFetch(() => json(rickRoll));
    const result = await discogsTrackCredits(
      { ...TRACK, artists: ["Rick Astley", "Kylie Minogue"] },
      [249504],
    );
    expect(result).toMatchObject({ status: "missing", identity: { rejected: 1 } });
    expect(result.omitted[0].reason).toContain('credited to "Rick Astley"');
  });

  it("checks each linked release on its own and uses the first that holds the track", async () => {
    const other = { ...rickRoll, id: 1, tracklist: [{ position: "A", title: "Together Forever" }] };
    const net = stubFetch((call) => json(call.url.endsWith("/1") ? other : rickRoll));
    const result = await discogsTrackCredits(TRACK, [1, 249504, 7], { now });
    expect(result.status).toBe("found");
    expect(result.omitted).toEqual([
      { ref: "release/1", reason: 'no track titled "Never Gonna Give You Up" among 1 tracks' },
    ]);
    expect(net.calls.map((c) => c.url)).toEqual([
      "https://api.discogs.com/releases/1",
      "https://api.discogs.com/releases/249504",
    ]);
  });

  it("is missing when no release is linked", async () => {
    const net = stubFetch(() => undefined);
    const result = await discogsTrackCredits(TRACK, []);
    expect(result).toMatchObject({ status: "missing", identity: { missing: 1 } });
    expect(net.calls).toHaveLength(0);
  });

  it("is missing, with a typed error and no token in it, when Discogs fails", async () => {
    stubFetch(() => json({ message: "You are making requests too quickly." }, { status: 429 }));
    const limited = await discogsTrackCredits(TRACK, [249504]);
    expect(limited).toMatchObject({ status: "missing", error: { code: "rate_limited" } });

    stubFetch(() => {
      throw new TypeError(`Headers.append: "Discogs token=${TOKEN}" is an invalid header value.`);
    });
    const broken = await discogsTrackCredits(TRACK, [249504]);
    expect(broken.status).toBe("missing");
    expect(JSON.stringify(broken)).not.toContain(TOKEN);
  });

  it("replays the recorded run with no network; the cassette keeps only the fields read", async () => {
    const live = { ...rickRoll, notes: "Durations do not appear on the release.", images: [] };
    const run = await recordThenReplay(
      () => json(live),
      () => discogsTrackCredits(TRACK, [249504], { now }),
    );
    expect(run.replayCalls).toBe(0);
    expect(run.replayed).toEqual(run.live);
    expect(run.live.status).toBe("found");
    expect(run.cassettes.discogs).not.toContain("Durations do not appear");
    expect(run.cassettes.discogs).not.toContain(TOKEN);
  });
});

describe("credits filtered to the track", () => {
  const release: DiscogsRelease = {
    id: 10,
    title: "Example",
    artists: [{ name: "Rick Astley" }],
    extraartists: [
      { name: "Whole Release", role: "Mastered By", tracks: "" },
      { name: "Side A Only", role: "Mixed By", tracks: "A" },
      { name: "Side B Only", role: "Mixed By", tracks: "B" },
      { name: "A Range", role: "Engineer", tracks: "A to B" },
      { name: "No Role", role: "", tracks: "" },
    ],
    tracklist: [
      {
        position: "A",
        title: "Never Gonna Give You Up",
        duration: "3:32",
        extraartists: [{ name: "On The Track", role: "Keyboards [Synth], Programmed By" }],
      },
      { position: "B", title: "Never Gonna Give You Up (Instrumental)", duration: "3:30" },
    ],
  };

  it("keeps the track's credits and the release credits that cover its position", () => {
    const match = findTrack(release, TRACK);
    if (!match.ok) throw new Error(match.reason);
    expect(match.track.position).toBe("A");
    const credits = trackCredits(release, match.track);
    expect(credits.map((c) => [c.name, c.scope])).toEqual([
      ["On The Track", "track"],
      ["Whole Release", "release"],
      ["Side A Only", "track"],
      ["A Range", "track"],
    ]);
    expect(credits[0].roles).toEqual(["Keyboards [Synth]", "Programmed By"]);
  });

  it("reads positions and ranges in the tracklist's order", () => {
    const order = ["A1", "A2", "B1", "B2"];
    expect(creditCovers("A1 to B1", "A2", order)).toBe(true);
    expect(creditCovers("A1 to B1", "B2", order)).toBe(false);
    expect(creditCovers("A1, B2", "b2", order)).toBe(true);
    expect(creditCovers("A1, B2", "A2", order)).toBe(false);
    expect(creditCovers(" ", "A2", order)).toBe("all");
  });

  it("takes the one track with a matching printed duration when titles repeat", () => {
    const twice: DiscogsRelease = {
      ...release,
      tracklist: [
        { position: "1", title: "Never Gonna Give You Up", duration: "" },
        { position: "2", title: "Never Gonna Give You Up", duration: "3:33" },
      ],
    };
    const match = findTrack(twice, TRACK);
    expect(match.ok && match.track.position).toBe("2");
    const untimed = { ...twice, tracklist: twice.tracklist?.map((t) => ({ ...t, duration: "" })) };
    expect(findTrack(untimed, TRACK)).toEqual({
      ok: false,
      reason: "2 tracks on the release match the track",
    });
  });

  it("reads Discogs' artist name forms", () => {
    const named = (name: string, anv = "") => ({
      ...release,
      artists: [{ name, anv }],
    });
    expect(findTrack(named("Rick Astley (2)"), TRACK).ok).toBe(true);
    expect(findTrack(named("Astley, Rick"), TRACK).ok).toBe(false);
    expect(findTrack(named("Rick Astley Band", "Rick Astley"), TRACK).ok).toBe(true);
    expect(findTrack(named("Persuader, The"), { ...TRACK, artists: ["The Persuader"] }).ok).toBe(
      true,
    );
  });

  it("splits roles at commas outside brackets", () => {
    expect(splitRoles("Producer, Written-By")).toEqual(["Producer", "Written-By"]);
    expect(splitRoles("Music By [All Tracks By, Uncredited]")).toEqual([
      "Music By [All Tracks By, Uncredited]",
    ]);
  });

  it("reads the release id from a Discogs release URL only", () => {
    expect(discogsReleaseId("https://www.discogs.com/release/599648")).toBe(599648);
    expect(
      discogsReleaseId("https://www.discogs.com/release/599648-Vanilla-Ice-To-The-Extreme"),
    ).toBe(599648);
    expect(discogsReleaseId("https://www.discogs.com/master/5427")).toBeNull();
    expect(discogsReleaseId("https://example.com/release/599648")).toBeNull();
  });
});
